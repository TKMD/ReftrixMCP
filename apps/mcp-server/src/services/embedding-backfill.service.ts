// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill Service
 *
 * page.analyze の Embedding フェーズ（Phase 5）で OOM 等により欠損した
 * embedding を自動的に補完するサービス。
 *
 * 3つのエントリポイント:
 * 1. backfillWebPageEmbeddings() — 特定 WebPage の欠損 embedding を補完
 * 2. checkWebPageEmbeddingCoverage() — 欠損チェックのみ（バックフィルなし）
 * 3. findWebPagesWithMissingEmbeddings() — 全 WebPage から欠損のあるものを検索
 *
 * メモリ管理 (v0.1.0):
 * - 動的RSS閾値: システム全メモリ × ratio（デフォルト70%）
 * - チャンク間は「メモリ圧力時のみ」dispose（通常はパイプライン保持）
 * - 圧力検出時: dispose → GC → 待機 → 回復確認してから再開
 * - CLI使用時は閾値0で無制限も可能
 *
 * @module services/embedding-backfill
 */

import { prisma } from '@reftrix/database';
import os from 'node:os';
import { LayoutEmbeddingService, saveSectionEmbedding } from './layout-embedding.service';
import { saveMotionEmbedding } from './motion/frame-embedding.service';
import {
  generateBackgroundDesignTextRepresentation,
  type BackgroundDesignForText,
} from './background/background-design-embedding.service';
import {
  generateSectionTextRepresentation,
  generateMotionTextRepresentation,
  type SectionPatternInput,
} from '../tools/page/handlers/embedding-handler';
import type { MotionPatternForEmbedding } from '../tools/page/handlers/types';
import {
  generateResponsiveAnalysisTextRepresentation,
  type ResponsiveAnalysisForText,
} from './responsive/responsive-analysis-embedding.service';

// =====================================================
// Constants
// =====================================================

/** Default chunk size for backfill */
const DEFAULT_BACKFILL_CHUNK_SIZE = 30;

/** Model name for embedding generation */
const MODEL_NAME = 'multilingual-e5-base';

/** Default memory ratio: 70% of total system memory */
const DEFAULT_MEMORY_RATIO = 0.70;

/** Memory recovery wait time (ms) */
const MEMORY_RECOVERY_WAIT_MS = 3000;

/** Max memory recovery attempts before giving up for current chunk */
const MAX_MEMORY_RECOVERY_ATTEMPTS = 3;

// =====================================================
// Types
// =====================================================

export interface BackfillResult {
  sectionBackfilled: number;
  motionBackfilled: number;
  backgroundBackfilled: number;
  jsAnimationBackfilled: number;
  responsiveBackfilled: number;
  totalBackfilled: number;
  errors: string[];
  memorySkips: number;
}

export interface EmbeddingCoverage {
  type: string;
  total: number;
  embedded: number;
  missing: number;
}

export interface WebPageWithMissingEmbeddings {
  webPageId: string;
  url: string;
  missingCount: number;
}

export interface BackfillOptions {
  chunkSize?: number;
  /**
   * RSS threshold in bytes. Special values:
   * - 0: Disable memory check entirely
   * - undefined: Auto-detect (system total × DEFAULT_MEMORY_RATIO)
   * - positive number: Use as-is
   */
  rssThreshold?: number;
  /** Memory ratio (0.0-1.0) for auto-detect threshold. Default: 0.70 */
  memoryRatio?: number;
  onProgress?: (type: string, done: number, total: number) => void;
  onMemoryPressure?: (type: string, rssGB: number, thresholdGB: number, action: 'dispose' | 'skip') => void;
}

// =====================================================
// DB Row Types (raw query results)
// =====================================================

interface MissingSectionRow {
  id: string;
  section_type: string;
  position_index: number;
  components: unknown;
  visual_features: unknown;
}

interface MissingMotionRow {
  id: string;
  type: string | null;
  name: string;
  category: string;
  trigger_type: string;
  animation: unknown;
  properties: unknown;
}

interface MissingBackgroundRow {
  id: string;
  name: string;
  design_type: string;
  selector: string | null;
  color_info: unknown;
  gradient_info: unknown;
  visual_properties: unknown;
  animation_info: unknown;
}

interface MissingJsAnimationRow {
  id: string;
  name: string;
  library_type: string;
  animation_type: string;
  description: string | null;
  duration_ms: number | null;
  easing: string | null;
  trigger_type: string | null;
  properties: unknown;
  cdp_source_type: string | null;
  cdp_play_state: string | null;
}

interface MissingResponsiveRow {
  id: string;
  web_page_id: string;
  url: string | null;
  viewports_analyzed: unknown;
  differences: unknown;
  breakpoints: unknown;
  screenshot_diffs: unknown;
}

interface MissingWebPageRow {
  id: string;
  url: string;
  missing_count: string; // BigInt from COUNT comes as string
}

// =====================================================
// Memory Management
// =====================================================

/**
 * Calculate RSS threshold based on system memory and ratio.
 * Returns 0 if explicitly disabled.
 */
function resolveRssThreshold(options?: BackfillOptions): number {
  if (options?.rssThreshold === 0) return 0; // explicitly disabled
  if (options?.rssThreshold !== undefined && options.rssThreshold > 0) return options.rssThreshold;
  const ratio = options?.memoryRatio ?? DEFAULT_MEMORY_RATIO;
  return Math.floor(os.totalmem() * ratio);
}

function getRssBytes(): number {
  return process.memoryUsage().rss;
}

function toGB(bytes: number): number {
  return Math.round(bytes / 1024 / 1024 / 1024 * 10) / 10;
}

function tryGarbageCollect(): void {
  if (typeof global.gc === 'function') {
    global.gc();
  }
}

/**
 * Adaptive memory check with recovery.
 *
 * Returns 'ok' if memory is fine, 'recovered' if memory was released by dispose+GC,
 * or 'exceeded' if memory couldn't be recovered after retries.
 */
async function checkMemoryPressure(
  threshold: number,
  embeddingService: LayoutEmbeddingService,
  type: string,
  onMemoryPressure?: BackfillOptions['onMemoryPressure']
): Promise<'ok' | 'recovered' | 'exceeded'> {
  if (threshold <= 0) return 'ok';

  const rss = getRssBytes();
  if (rss <= threshold) return 'ok';

  // Memory pressure detected — try to recover
  const thresholdGB = toGB(threshold);
  onMemoryPressure?.(type, toGB(rss), thresholdGB, 'dispose');

  await embeddingService.disposeEmbeddingPipeline();
  tryGarbageCollect();

  for (let attempt = 0; attempt < MAX_MEMORY_RECOVERY_ATTEMPTS; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, MEMORY_RECOVERY_WAIT_MS));
    tryGarbageCollect();

    const currentRss = getRssBytes();
    if (currentRss <= threshold) {
      return 'recovered';
    }
  }

  // Still above threshold after recovery attempts
  onMemoryPressure?.(type, toGB(getRssBytes()), thresholdGB, 'skip');
  return 'exceeded';
}

// =====================================================
// DB → Text Conversion Functions
// =====================================================

function extractHeadingFromComponents(components: unknown): string | undefined {
  if (!Array.isArray(components)) return undefined;
  for (const comp of components) {
    if (
      typeof comp === 'object' &&
      comp !== null &&
      'type' in comp &&
      (comp as { type: string }).type === 'heading' &&
      'text' in comp
    ) {
      return String((comp as { text: unknown }).text);
    }
  }
  return undefined;
}

function dbMotionToEmbeddingInput(row: MissingMotionRow): MotionPatternForEmbedding {
  const animation = row.animation as Record<string, unknown> | null;
  const properties = row.properties as Array<{ property: string }> | string[] | null;

  let duration: number | undefined;
  if (animation && typeof animation.duration === 'number') {
    duration = animation.duration;
  }

  let easing = 'ease';
  if (animation) {
    if (typeof animation.easing === 'string') {
      easing = animation.easing;
    } else if (typeof animation.easing === 'object' && animation.easing !== null) {
      const easingObj = animation.easing as Record<string, unknown>;
      if (typeof easingObj.type === 'string') {
        easing = easingObj.type;
      }
    }
  }

  let propertyNames: string[] = [];
  if (Array.isArray(properties)) {
    propertyNames = properties.map((p) =>
      typeof p === 'string' ? p : (typeof p === 'object' && p !== null && 'property' in p ? String(p.property) : '')
    ).filter(Boolean);
  }

  return {
    id: row.id,
    name: row.name,
    type: (row.type as MotionPatternForEmbedding['type']) ?? 'css_animation',
    category: row.category,
    trigger: row.trigger_type,
    duration,
    easing,
    properties: propertyNames,
    propertiesDetailed: undefined,
    performance: {
      level: 'good',
      usesTransform: false,
      usesOpacity: false,
    },
    accessibility: {
      respectsReducedMotion: false,
    },
  };
}

function dbBackgroundToTextInput(row: MissingBackgroundRow): BackgroundDesignForText {
  return {
    name: row.name,
    designType: row.design_type,
    selector: row.selector ?? undefined,
    colorInfo: row.color_info as BackgroundDesignForText['colorInfo'],
    gradientInfo: row.gradient_info as BackgroundDesignForText['gradientInfo'],
    visualProperties: row.visual_properties as BackgroundDesignForText['visualProperties'],
    animationInfo: row.animation_info as BackgroundDesignForText['animationInfo'],
  };
}

function generateJsAnimationTextFromDb(row: MissingJsAnimationRow): string {
  const parts: string[] = [];

  const typeName = row.cdp_source_type ?? row.animation_type;
  parts.push(`JavaScript animation: ${row.name || typeName}`);
  parts.push(`Type: ${typeName}`);

  if (row.duration_ms !== null && row.duration_ms > 0) {
    parts.push(`Duration: ${row.duration_ms}ms`);
  }
  if (row.easing) {
    parts.push(`Easing: ${row.easing}`);
  }
  if (row.cdp_play_state) {
    parts.push(`Play state: ${row.cdp_play_state}`);
  }

  const props = row.properties;
  if (Array.isArray(props) && props.length > 0) {
    const propNames = props
      .map((p: unknown) => {
        if (typeof p === 'string') return p;
        if (typeof p === 'object' && p !== null && 'property' in p) {
          return String((p as { property: unknown }).property);
        }
        return '';
      })
      .filter(Boolean);
    if (propNames.length > 0) {
      parts.push(`Properties: ${propNames.join(', ')}`);
    }
  }

  if (row.library_type && row.library_type !== 'unknown') {
    const libraryLabels: Record<string, string> = {
      gsap: 'GSAP',
      framer_motion: 'Framer Motion',
      anime_js: 'anime.js',
      three_js: 'Three.js',
      lottie: 'Lottie',
      web_animations_api: 'Web Animations API',
    };
    const label = libraryLabels[row.library_type] ?? row.library_type;
    parts.push(`Library: ${label}`);
  }

  if (row.trigger_type) {
    parts.push(`Trigger: ${row.trigger_type}`);
  }

  return `passage: ${parts.join('. ')}.`;
}

// =====================================================
// Missing Embedding Queries
// =====================================================

async function getMissingSectionEmbeddings(webPageId: string): Promise<MissingSectionRow[]> {
  return prisma.$queryRawUnsafe<MissingSectionRow[]>(
    `SELECT sp.id, sp.section_type, sp.position_index, sp.components, sp.visual_features
     FROM section_patterns sp
     LEFT JOIN section_embeddings se ON sp.id = se.section_pattern_id
     WHERE sp.web_page_id = $1::uuid AND se.id IS NULL`,
    webPageId
  );
}

async function getMissingMotionEmbeddings(webPageId: string): Promise<MissingMotionRow[]> {
  return prisma.$queryRawUnsafe<MissingMotionRow[]>(
    `SELECT mp.id, mp.type, mp.name, mp.category, mp.trigger_type, mp.animation, mp.properties
     FROM motion_patterns mp
     LEFT JOIN motion_embeddings me ON mp.id = me.motion_pattern_id
     WHERE mp.web_page_id = $1::uuid AND me.id IS NULL`,
    webPageId
  );
}

async function getMissingBackgroundEmbeddings(webPageId: string): Promise<MissingBackgroundRow[]> {
  return prisma.$queryRawUnsafe<MissingBackgroundRow[]>(
    `SELECT bd.id, bd.name, bd.design_type, bd.selector, bd.color_info, bd.gradient_info,
            bd.visual_properties, bd.animation_info
     FROM background_designs bd
     LEFT JOIN background_design_embeddings bde ON bd.id = bde.background_design_id
     WHERE bd.web_page_id = $1::uuid AND bde.id IS NULL`,
    webPageId
  );
}

async function getMissingJsAnimationEmbeddings(webPageId: string): Promise<MissingJsAnimationRow[]> {
  return prisma.$queryRawUnsafe<MissingJsAnimationRow[]>(
    `SELECT jap.id, jap.name, jap.library_type, jap.animation_type,
            jap.description, jap.duration_ms, jap.easing, jap.trigger_type,
            jap.properties, jap.cdp_source_type, jap.cdp_play_state
     FROM js_animation_patterns jap
     LEFT JOIN js_animation_embeddings jae ON jap.id = jae.js_animation_pattern_id
     WHERE jap.web_page_id = $1::uuid AND jae.id IS NULL`,
    webPageId
  );
}

// =====================================================
// Public API
// =====================================================

/**
 * Check embedding coverage for a specific WebPage (no backfill)
 */
export async function checkWebPageEmbeddingCoverage(
  webPageId: string
): Promise<EmbeddingCoverage[]> {
  const results: EmbeddingCoverage[] = [];

  const sectionTotal = await prisma.sectionPattern.count({ where: { webPageId } });
  const sectionEmbedded = await prisma.sectionEmbedding.count({
    where: { sectionPattern: { webPageId } },
  });
  results.push({
    type: 'section',
    total: sectionTotal,
    embedded: sectionEmbedded,
    missing: sectionTotal - sectionEmbedded,
  });

  const motionTotal = await prisma.motionPattern.count({ where: { webPageId } });
  const motionEmbedded = await prisma.motionEmbedding.count({
    where: { motionPattern: { webPageId } },
  });
  results.push({
    type: 'motion',
    total: motionTotal,
    embedded: motionEmbedded,
    missing: motionTotal - motionEmbedded,
  });

  const bgTotal = await prisma.backgroundDesign.count({ where: { webPageId } });
  const bgEmbedded = await prisma.backgroundDesignEmbedding.count({
    where: { backgroundDesign: { webPageId } },
  });
  results.push({
    type: 'background',
    total: bgTotal,
    embedded: bgEmbedded,
    missing: bgTotal - bgEmbedded,
  });

  const jsTotal = await prisma.jSAnimationPattern.count({ where: { webPageId } });
  const jsEmbedded = await prisma.jSAnimationEmbedding.count({
    where: { jsAnimationPattern: { webPageId } },
  });
  results.push({
    type: 'jsAnimation',
    total: jsTotal,
    embedded: jsEmbedded,
    missing: jsTotal - jsEmbedded,
  });

  const responsiveTotal = await prisma.responsiveAnalysis.count({ where: { webPageId } });
  const responsiveEmbedded = await prisma.responsiveAnalysisEmbedding.count({
    where: { responsiveAnalysis: { webPageId } },
  });
  results.push({
    type: 'responsive',
    total: responsiveTotal,
    embedded: responsiveEmbedded,
    missing: responsiveTotal - responsiveEmbedded,
  });

  return results;
}

/**
 * Find all WebPages that have patterns with missing embeddings
 */
export async function findWebPagesWithMissingEmbeddings(): Promise<WebPageWithMissingEmbeddings[]> {
  const rows = await prisma.$queryRawUnsafe<MissingWebPageRow[]>(`
    SELECT wp.id, wp.url, COUNT(*) as missing_count FROM (
      SELECT sp.web_page_id
      FROM section_patterns sp
      LEFT JOIN section_embeddings se ON sp.id = se.section_pattern_id
      WHERE se.id IS NULL
      UNION ALL
      SELECT mp.web_page_id
      FROM motion_patterns mp
      LEFT JOIN motion_embeddings me ON mp.id = me.motion_pattern_id
      WHERE me.id IS NULL AND mp.web_page_id IS NOT NULL
      UNION ALL
      SELECT bd.web_page_id
      FROM background_designs bd
      LEFT JOIN background_design_embeddings bde ON bd.id = bde.background_design_id
      WHERE bde.id IS NULL AND bd.web_page_id IS NOT NULL
      UNION ALL
      SELECT jap.web_page_id
      FROM js_animation_patterns jap
      LEFT JOIN js_animation_embeddings jae ON jap.id = jae.js_animation_pattern_id
      WHERE jae.id IS NULL AND jap.web_page_id IS NOT NULL
      UNION ALL
      SELECT ra.web_page_id
      FROM responsive_analyses ra
      LEFT JOIN responsive_analysis_embeddings rae ON ra.id = rae.responsive_analysis_id
      WHERE rae.id IS NULL
    ) AS missing
    JOIN web_pages wp ON wp.id = missing.web_page_id
    GROUP BY wp.id, wp.url
    ORDER BY missing_count DESC
  `);

  return rows.map((row) => ({
    webPageId: row.id,
    url: row.url,
    missingCount: Number(row.missing_count),
  }));
}

/**
 * Backfill missing embeddings for a specific WebPage.
 *
 * Dynamic memory management:
 * - Pipeline stays alive between chunks (fast GPU inference)
 * - When RSS exceeds threshold: dispose → GC → wait → retry
 * - If recovery fails: skip remaining items (next invocation will retry)
 */
export async function backfillWebPageEmbeddings(
  webPageId: string,
  options?: BackfillOptions
): Promise<BackfillResult> {
  const chunkSize = Math.max(1, Math.min(options?.chunkSize ?? DEFAULT_BACKFILL_CHUNK_SIZE, 100));
  const rssThreshold = resolveRssThreshold(options);
  const onProgress = options?.onProgress;
  const onMemoryPressure = options?.onMemoryPressure;

  const result: BackfillResult = {
    sectionBackfilled: 0,
    motionBackfilled: 0,
    backgroundBackfilled: 0,
    jsAnimationBackfilled: 0,
    responsiveBackfilled: 0,
    totalBackfilled: 0,
    errors: [],
    memorySkips: 0,
  };

  const embeddingService = new LayoutEmbeddingService({ cacheEnabled: false });

  try {
    const missingSections = await getMissingSectionEmbeddings(webPageId);
    if (missingSections.length > 0) {
      const r = await backfillSections(missingSections, embeddingService, chunkSize, rssThreshold, result.errors, onProgress, onMemoryPressure);
      result.sectionBackfilled = r.backfilled;
      result.memorySkips += r.memorySkips;
    }

    const missingMotions = await getMissingMotionEmbeddings(webPageId);
    if (missingMotions.length > 0) {
      const r = await backfillMotions(missingMotions, embeddingService, chunkSize, rssThreshold, result.errors, onProgress, onMemoryPressure);
      result.motionBackfilled = r.backfilled;
      result.memorySkips += r.memorySkips;
    }

    const missingBackgrounds = await getMissingBackgroundEmbeddings(webPageId);
    if (missingBackgrounds.length > 0) {
      const r = await backfillBackgrounds(missingBackgrounds, embeddingService, chunkSize, rssThreshold, result.errors, onProgress, onMemoryPressure);
      result.backgroundBackfilled = r.backfilled;
      result.memorySkips += r.memorySkips;
    }

    const missingJsAnimations = await getMissingJsAnimationEmbeddings(webPageId);
    if (missingJsAnimations.length > 0) {
      const r = await backfillJsAnimations(missingJsAnimations, embeddingService, chunkSize, rssThreshold, result.errors, onProgress, onMemoryPressure);
      result.jsAnimationBackfilled = r.backfilled;
      result.memorySkips += r.memorySkips;
    }

    const missingResponsive = await getMissingResponsiveEmbeddings(webPageId);
    if (missingResponsive.length > 0) {
      const r = await backfillResponsive(missingResponsive, embeddingService, chunkSize, rssThreshold, result.errors, onProgress, onMemoryPressure);
      result.responsiveBackfilled = r.backfilled;
      result.memorySkips += r.memorySkips;
    }

    result.totalBackfilled =
      result.sectionBackfilled +
      result.motionBackfilled +
      result.backgroundBackfilled +
      result.jsAnimationBackfilled +
      result.responsiveBackfilled;
  } finally {
    await embeddingService.disposeEmbeddingPipeline();
    tryGarbageCollect();
  }

  return result;
}

// =====================================================
// Per-type Backfill Functions
// =====================================================

interface ChunkResult {
  backfilled: number;
  memorySkips: number;
}

async function backfillSections(
  rows: MissingSectionRow[],
  embeddingService: LayoutEmbeddingService,
  chunkSize: number,
  rssThreshold: number,
  errors: string[],
  onProgress?: BackfillOptions['onProgress'],
  onMemoryPressure?: BackfillOptions['onMemoryPressure']
): Promise<ChunkResult> {
  let backfilled = 0;
  let memorySkips = 0;

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const memStatus = await checkMemoryPressure(rssThreshold, embeddingService, 'section', onMemoryPressure);
    if (memStatus === 'exceeded') { memorySkips++; break; }

    const chunk = rows.slice(offset, offset + chunkSize);

    for (const row of chunk) {
      try {
        const heading = extractHeadingFromComponents(row.components);
        const sectionInput: SectionPatternInput = {
          id: row.id,
          type: row.section_type,
          positionIndex: row.position_index,
          confidence: 1.0,
        };
        if (heading !== undefined) {
          sectionInput.heading = heading;
        }
        const text = generateSectionTextRepresentation(sectionInput);
        const { embedding } = await embeddingService.generateFromText(text);
        await saveSectionEmbedding(row.id, embedding, MODEL_NAME, text);
        backfilled++;
      } catch (error) {
        errors.push(`section[${row.id}]: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    onProgress?.('section', Math.min(offset + chunkSize, rows.length), rows.length);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { backfilled, memorySkips };
}

async function backfillMotions(
  rows: MissingMotionRow[],
  embeddingService: LayoutEmbeddingService,
  chunkSize: number,
  rssThreshold: number,
  errors: string[],
  onProgress?: BackfillOptions['onProgress'],
  onMemoryPressure?: BackfillOptions['onMemoryPressure']
): Promise<ChunkResult> {
  let backfilled = 0;
  let memorySkips = 0;

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const memStatus = await checkMemoryPressure(rssThreshold, embeddingService, 'motion', onMemoryPressure);
    if (memStatus === 'exceeded') { memorySkips++; break; }

    const chunk = rows.slice(offset, offset + chunkSize);

    for (const row of chunk) {
      try {
        const pattern = dbMotionToEmbeddingInput(row);
        const text = generateMotionTextRepresentation(pattern);
        const { embedding } = await embeddingService.generateFromText(text);
        await saveMotionEmbedding(row.id, embedding, MODEL_NAME);
        backfilled++;
      } catch (error) {
        errors.push(`motion[${row.id}]: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    onProgress?.('motion', Math.min(offset + chunkSize, rows.length), rows.length);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { backfilled, memorySkips };
}

async function backfillBackgrounds(
  rows: MissingBackgroundRow[],
  embeddingService: LayoutEmbeddingService,
  chunkSize: number,
  rssThreshold: number,
  errors: string[],
  onProgress?: BackfillOptions['onProgress'],
  onMemoryPressure?: BackfillOptions['onMemoryPressure']
): Promise<ChunkResult> {
  let backfilled = 0;
  let memorySkips = 0;

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const memStatus = await checkMemoryPressure(rssThreshold, embeddingService, 'background', onMemoryPressure);
    if (memStatus === 'exceeded') { memorySkips++; break; }

    const chunk = rows.slice(offset, offset + chunkSize);

    for (const row of chunk) {
      try {
        const bgForText = dbBackgroundToTextInput(row);
        const text = generateBackgroundDesignTextRepresentation(bgForText);
        const embeddingResult = await embeddingService.generateFromText(text);

        const createdRecord = await prisma.backgroundDesignEmbedding.create({
          data: {
            backgroundDesignId: row.id,
            textRepresentation: text,
            modelVersion: MODEL_NAME,
          },
        });

        const vectorString = `[${embeddingResult.embedding.join(',')}]`;
        await prisma.$executeRawUnsafe(
          `UPDATE background_design_embeddings SET embedding = $1::vector WHERE id = $2::uuid`,
          vectorString,
          createdRecord.id
        );

        backfilled++;
      } catch (error) {
        errors.push(`background[${row.id}]: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    onProgress?.('background', Math.min(offset + chunkSize, rows.length), rows.length);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { backfilled, memorySkips };
}

async function backfillJsAnimations(
  rows: MissingJsAnimationRow[],
  embeddingService: LayoutEmbeddingService,
  chunkSize: number,
  rssThreshold: number,
  errors: string[],
  onProgress?: BackfillOptions['onProgress'],
  onMemoryPressure?: BackfillOptions['onMemoryPressure']
): Promise<ChunkResult> {
  let backfilled = 0;
  let memorySkips = 0;

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const memStatus = await checkMemoryPressure(rssThreshold, embeddingService, 'jsAnimation', onMemoryPressure);
    if (memStatus === 'exceeded') { memorySkips++; break; }

    const chunk = rows.slice(offset, offset + chunkSize);

    const embeddingItems: Array<{
      dbId: string;
      textRepresentation: string;
      embedding: number[];
    }> = [];

    for (const row of chunk) {
      try {
        const text = generateJsAnimationTextFromDb(row);
        const embeddingResult = await embeddingService.generateFromText(text);
        embeddingItems.push({
          dbId: row.id,
          textRepresentation: text,
          embedding: embeddingResult.embedding,
        });
      } catch (error) {
        errors.push(`jsAnimation[${row.id}]: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (embeddingItems.length > 0) {
      try {
        await prisma.jSAnimationEmbedding.createMany({
          data: embeddingItems.map((item) => ({
            jsAnimationPatternId: item.dbId,
            textRepresentation: item.textRepresentation,
            modelVersion: MODEL_NAME,
          })),
        });

        const vectorUpdates = embeddingItems.filter((item) => item.embedding.length > 0);
        if (vectorUpdates.length > 0) {
          const valuesClause = vectorUpdates
            .map((_, idx) => `($${idx * 2 + 1}::vector, $${idx * 2 + 2}::uuid)`)
            .join(', ');

          const params: unknown[] = [];
          for (const item of vectorUpdates) {
            params.push(`[${item.embedding.join(',')}]`);
            params.push(item.dbId);
          }

          await prisma.$executeRawUnsafe(
            `UPDATE js_animation_embeddings AS e SET embedding = v.vec FROM (VALUES ${valuesClause}) AS v(vec, pattern_id) WHERE e.js_animation_pattern_id = v.pattern_id`,
            ...params
          );
        }

        backfilled += embeddingItems.length;
      } catch (error) {
        errors.push(`jsAnimation-batch: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    onProgress?.('jsAnimation', Math.min(offset + chunkSize, rows.length), rows.length);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { backfilled, memorySkips };
}

// =====================================================
// Responsive Analysis Backfill
// =====================================================

async function getMissingResponsiveEmbeddings(webPageId: string): Promise<MissingResponsiveRow[]> {
  return prisma.$queryRawUnsafe<MissingResponsiveRow[]>(`
    SELECT ra.id, ra.web_page_id, wp.url,
           ra.viewports_analyzed, ra.differences, ra.breakpoints, ra.screenshot_diffs
    FROM responsive_analyses ra
    LEFT JOIN responsive_analysis_embeddings rae ON ra.id = rae.responsive_analysis_id
    JOIN web_pages wp ON ra.web_page_id = wp.id
    WHERE rae.id IS NULL AND ra.web_page_id = $1::uuid
  `, webPageId);
}

function convertResponsiveRowToTextInput(row: MissingResponsiveRow): ResponsiveAnalysisForText {
  const viewportsAnalyzed = Array.isArray(row.viewports_analyzed)
    ? (row.viewports_analyzed as Array<{ name: string; width: number; height: number }>)
    : [];
  const differences = Array.isArray(row.differences)
    ? (row.differences as Array<{ category: string; selector?: string; description: string; viewports?: string[] }>)
    : [];
  const breakpoints = Array.isArray(row.breakpoints)
    ? (row.breakpoints as Array<{ width: number; type?: string }>)
    : undefined;
  const screenshotDiffs = Array.isArray(row.screenshot_diffs)
    ? (row.screenshot_diffs as Array<{ viewport1: string; viewport2: string; diffPercentage: number }>)
    : undefined;

  return {
    id: row.id,
    url: row.url ?? undefined,
    viewportsAnalyzed,
    differences,
    breakpoints,
    screenshotDiffs,
  };
}

async function backfillResponsive(
  rows: MissingResponsiveRow[],
  embeddingService: LayoutEmbeddingService,
  chunkSize: number,
  rssThreshold: number,
  errors: string[],
  onProgress?: BackfillOptions['onProgress'],
  onMemoryPressure?: BackfillOptions['onMemoryPressure']
): Promise<ChunkResult> {
  let backfilled = 0;
  let memorySkips = 0;

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const memStatus = await checkMemoryPressure(rssThreshold, embeddingService, 'responsive', onMemoryPressure);
    if (memStatus === 'exceeded') { memorySkips++; break; }

    const chunk = rows.slice(offset, offset + chunkSize);
    const embeddingItems: Array<{ dbId: string; textRepresentation: string; embedding: number[] }> = [];

    for (const row of chunk) {
      try {
        const textInput = convertResponsiveRowToTextInput(row);
        const textRepresentation = generateResponsiveAnalysisTextRepresentation(textInput);
        const { embedding } = await embeddingService.generateFromText(textRepresentation);
        embeddingItems.push({ dbId: row.id, textRepresentation, embedding });
      } catch (error) {
        errors.push(`responsive-${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (embeddingItems.length > 0) {
      try {
        await prisma.responsiveAnalysisEmbedding.createMany({
          data: embeddingItems.map((item) => ({
            responsiveAnalysisId: item.dbId,
            textRepresentation: item.textRepresentation,
            modelVersion: MODEL_NAME,
          })),
        });

        const vectorUpdates = embeddingItems.filter((item) => item.embedding.length > 0);
        if (vectorUpdates.length > 0) {
          const valuesClause = vectorUpdates
            .map((_, idx) => `($${idx * 2 + 1}::vector, $${idx * 2 + 2}::uuid)`)
            .join(', ');

          const params: unknown[] = [];
          for (const item of vectorUpdates) {
            params.push(`[${item.embedding.join(',')}]`);
            params.push(item.dbId);
          }

          await prisma.$executeRawUnsafe(
            `UPDATE responsive_analysis_embeddings AS e SET embedding = v.vec FROM (VALUES ${valuesClause}) AS v(vec, analysis_id) WHERE e.responsive_analysis_id = v.analysis_id`,
            ...params
          );
        }

        backfilled += embeddingItems.length;
      } catch (error) {
        errors.push(`responsive-batch: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    onProgress?.('responsive', Math.min(offset + chunkSize, rows.length), rows.length);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { backfilled, memorySkips };
}
