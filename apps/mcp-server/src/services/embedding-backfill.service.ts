// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
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

import { prisma } from "@reftrixmcp/database";
import os from "node:os";
import { LayoutEmbeddingService, saveSectionEmbedding } from "./layout-embedding.service";
import { saveMotionEmbedding } from "./motion/frame-embedding.service";
import {
  generateBackgroundDesignTextRepresentation,
  type BackgroundDesignForText,
} from "./background/background-design-embedding.service";
import {
  generateSectionTextRepresentation,
  generateMotionTextRepresentation,
  type SectionPatternInput,
} from "../tools/page/handlers/embedding-handler";
import type { MotionPatternForEmbedding } from "../tools/page/handlers/types";
import {
  generateResponsiveAnalysisTextRepresentation,
  type ResponsiveAnalysisForText,
} from "./responsive/responsive-analysis-embedding.service";
import {
  buildPartTextRepresentation,
  type ComponentPartForEmbedding,
} from "./part/part-embedding.service";
import {
  savePartEmbeddings,
  type PartEmbeddingPrismaClient,
} from "./part/part-embedding-db.service";
// v0.4.0 PR-D-5 (SEC-S-01 + FIND-SEC-01): CWE-209 defense —
// sanitize Prisma error messages before surfacing to errors[] (reaches
// BullMQ UI / page.analyze summary / MCP client responses).
import { sanitizeErrorMessage } from "../utils/sanitize-error";
// ADR-0018 Amendment 7 §7.1 (Plan v2 PR-B, UB-3): single SSOT exclusion
// predicate for the part_visual pending query (NF-TPA-01).
import {
  partVisualPendingExclusionPredicate,
  sectionVisualPendingExclusionPredicate,
} from "../workers/phases/types";

// =====================================================
// Constants
// =====================================================

/** Default chunk size for backfill */
const DEFAULT_BACKFILL_CHUNK_SIZE = 30;

/** Model name for embedding generation */
const MODEL_NAME = "multilingual-e5-base";

/** Default memory ratio: 70% of total system memory */
const DEFAULT_MEMORY_RATIO = 0.7;

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
  partBackfilled: number;
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
  onMemoryPressure?: (
    type: string,
    rssGB: number,
    thresholdGB: number,
    action: "dispose" | "skip"
  ) => void;
  /**
   * Upper bound on parts processed per invocation (v0.4.0 PR7e-β4 PR2b-β).
   *
   * undefined = process all missing rows (existing behavior preserved for the
   * 8 wrappers that pass `undefined`).
   * N = truncate the fetch to the first N rows (currently honored by
   * `backfillJsAnimationsForPage` only — other categories ignore this field
   * until fork wiring lands in PR3a+).
   *
   * Optional for backward compatibility with all existing in-process callers;
   * no wrapper signatures change.
   *
   * fork 呼び出し 1 回あたりで処理する parts 件数の上限 (v0.4.0 PR7e-β4 PR2b-β)。
   * undefined = 全 missing 行処理 (既存挙動、8 wrapper は undefined を渡す)。
   * N 指定時は先頭 N 件に切り詰める (PR2b-β 時点では
   * `backfillJsAnimationsForPage` のみ尊重し、他カテゴリは PR3a+ で fork 化する
   * 際に順次対応)。既存 in-process caller の後方互換のため optional。
   */
  partsLimit?: number;
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

interface MissingPartRow {
  id: string;
  part_type: string;
  part_subtype: string | null;
  computed_styles: unknown;
  css_classes: string[];
  attributes: unknown;
  interaction_info: unknown;
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
  return Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10;
}

function tryGarbageCollect(): void {
  if (typeof global.gc === "function") {
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
  onMemoryPressure?: BackfillOptions["onMemoryPressure"]
): Promise<"ok" | "recovered" | "exceeded"> {
  if (threshold <= 0) return "ok";

  const rss = getRssBytes();
  if (rss <= threshold) return "ok";

  // Memory pressure detected — try to recover
  const thresholdGB = toGB(threshold);
  onMemoryPressure?.(type, toGB(rss), thresholdGB, "dispose");

  await embeddingService.disposeEmbeddingPipeline();
  tryGarbageCollect();

  for (let attempt = 0; attempt < MAX_MEMORY_RECOVERY_ATTEMPTS; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, MEMORY_RECOVERY_WAIT_MS));
    tryGarbageCollect();

    const currentRss = getRssBytes();
    if (currentRss <= threshold) {
      return "recovered";
    }
  }

  // Still above threshold after recovery attempts
  onMemoryPressure?.(type, toGB(getRssBytes()), thresholdGB, "skip");
  return "exceeded";
}

// =====================================================
// DB → Text Conversion Functions
// =====================================================

function extractHeadingFromComponents(components: unknown): string | undefined {
  if (!Array.isArray(components)) return undefined;
  for (const comp of components) {
    if (
      typeof comp === "object" &&
      comp !== null &&
      "type" in comp &&
      (comp as { type: string }).type === "heading" &&
      "text" in comp
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
  if (animation && typeof animation.duration === "number") {
    duration = animation.duration;
  }

  let easing = "ease";
  if (animation) {
    if (typeof animation.easing === "string") {
      easing = animation.easing;
    } else if (typeof animation.easing === "object" && animation.easing !== null) {
      const easingObj = animation.easing as Record<string, unknown>;
      if (typeof easingObj.type === "string") {
        easing = easingObj.type;
      }
    }
  }

  let propertyNames: string[] = [];
  if (Array.isArray(properties)) {
    propertyNames = properties
      .map((p) =>
        typeof p === "string"
          ? p
          : typeof p === "object" && p !== null && "property" in p
            ? String(p.property)
            : ""
      )
      .filter(Boolean);
  }

  return {
    id: row.id,
    name: row.name,
    type: (row.type as MotionPatternForEmbedding["type"]) ?? "css_animation",
    category: row.category,
    trigger: row.trigger_type,
    duration,
    easing,
    properties: propertyNames,
    propertiesDetailed: undefined,
    performance: {
      level: "good",
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
    colorInfo: row.color_info as BackgroundDesignForText["colorInfo"],
    gradientInfo: row.gradient_info as BackgroundDesignForText["gradientInfo"],
    visualProperties: row.visual_properties as BackgroundDesignForText["visualProperties"],
    animationInfo: row.animation_info as BackgroundDesignForText["animationInfo"],
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
        if (typeof p === "string") return p;
        if (typeof p === "object" && p !== null && "property" in p) {
          return String((p as { property: unknown }).property);
        }
        return "";
      })
      .filter(Boolean);
    if (propNames.length > 0) {
      parts.push(`Properties: ${propNames.join(", ")}`);
    }
  }

  if (row.library_type && row.library_type !== "unknown") {
    const libraryLabels: Record<string, string> = {
      gsap: "GSAP",
      framer_motion: "Framer Motion",
      anime_js: "anime.js",
      three_js: "Three.js",
      lottie: "Lottie",
      web_animations_api: "Web Animations API",
    };
    const label = libraryLabels[row.library_type] ?? row.library_type;
    parts.push(`Library: ${label}`);
  }

  if (row.trigger_type) {
    parts.push(`Trigger: ${row.trigger_type}`);
  }

  return `passage: ${parts.join(". ")}.`;
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

async function getMissingJsAnimationEmbeddings(
  webPageId: string
): Promise<MissingJsAnimationRow[]> {
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

/**
 * v0.4.0 PR7e-β4 PR2b-β (TPA-M-1): limit 付きの js_animation missing 取得。
 *
 * 既存 `getMissingJsAnimationEmbeddings` の signature を変更しない category 専用
 * wrapper。`backfillJsAnimationsForPage` で `options.partsLimit` が指定された場合
 * のみ呼び出される。`ORDER BY jap.id ASC` + `LIMIT $2` で deterministic に先頭 N
 * 件を取得する (fork orchestrator の head-100 契約と整合)。
 *
 * Category-specific wrapper with `LIMIT` — keeps the existing 8 wrapper
 * signatures unchanged (TPA-M-1). Called by `backfillJsAnimationsForPage` only
 * when `options.partsLimit` is provided. `ORDER BY jap.id ASC` + `LIMIT $2`
 * yields a deterministic head-N fetch aligned with the fork orchestrator's
 * head-100 contract.
 *
 * @internal Exported for unit-test observability; production callers must go
 *   through `backfillJsAnimationsForPage({ partsLimit })`.
 */
export async function getMissingJsAnimationEmbeddingsWithLimit(
  webPageId: string,
  limit: number
): Promise<MissingJsAnimationRow[]> {
  return prisma.$queryRawUnsafe<MissingJsAnimationRow[]>(
    `SELECT jap.id, jap.name, jap.library_type, jap.animation_type,
            jap.description, jap.duration_ms, jap.easing, jap.trigger_type,
            jap.properties, jap.cdp_source_type, jap.cdp_play_state
     FROM js_animation_patterns jap
     LEFT JOIN js_animation_embeddings jae ON jap.id = jae.js_animation_pattern_id
     WHERE jap.web_page_id = $1::uuid AND jae.id IS NULL
     ORDER BY jap.id ASC
     LIMIT $2::int`,
    webPageId,
    limit
  );
}

async function getMissingPartEmbeddings(webPageId: string): Promise<MissingPartRow[]> {
  return prisma.$queryRawUnsafe<MissingPartRow[]>(
    `SELECT cp.id, cp.part_type, cp.part_subtype, cp.computed_styles,
            cp.css_classes, cp.attributes, cp.interaction_info
     FROM component_parts cp
     LEFT JOIN component_part_embeddings cpe ON cp.id = cpe.component_part_id
     WHERE cp.web_page_id = $1::uuid AND cpe.id IS NULL
       AND cp.pii_risk_level != 'high'`,
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
    type: "section",
    total: sectionTotal,
    embedded: sectionEmbedded,
    missing: sectionTotal - sectionEmbedded,
  });

  const motionTotal = await prisma.motionPattern.count({ where: { webPageId } });
  const motionEmbedded = await prisma.motionEmbedding.count({
    where: { motionPattern: { webPageId } },
  });
  results.push({
    type: "motion",
    total: motionTotal,
    embedded: motionEmbedded,
    missing: motionTotal - motionEmbedded,
  });

  const bgTotal = await prisma.backgroundDesign.count({ where: { webPageId } });
  const bgEmbedded = await prisma.backgroundDesignEmbedding.count({
    where: { backgroundDesign: { webPageId } },
  });
  results.push({
    type: "background",
    total: bgTotal,
    embedded: bgEmbedded,
    missing: bgTotal - bgEmbedded,
  });

  const jsTotal = await prisma.jSAnimationPattern.count({ where: { webPageId } });
  const jsEmbedded = await prisma.jSAnimationEmbedding.count({
    where: { jsAnimationPattern: { webPageId } },
  });
  results.push({
    type: "jsAnimation",
    total: jsTotal,
    embedded: jsEmbedded,
    missing: jsTotal - jsEmbedded,
  });

  const responsiveTotal = await prisma.responsiveAnalysis.count({ where: { webPageId } });
  const responsiveEmbedded = await prisma.responsiveAnalysisEmbedding.count({
    where: { responsiveAnalysis: { webPageId } },
  });
  results.push({
    type: "responsive",
    total: responsiveTotal,
    embedded: responsiveEmbedded,
    missing: responsiveTotal - responsiveEmbedded,
  });

  const partTotal = await prisma.componentPart.count({ where: { webPageId } });
  const partEmbedded = await prisma.componentPartEmbedding.count({
    where: { componentPart: { webPageId } },
  });
  results.push({
    type: "part",
    total: partTotal,
    embedded: partEmbedded,
    missing: partTotal - partEmbedded,
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
      UNION ALL
      SELECT cp.web_page_id
      FROM component_parts cp
      LEFT JOIN component_part_embeddings cpe ON cp.id = cpe.component_part_id
      WHERE cpe.id IS NULL AND cp.pii_risk_level != 'high'
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
    partBackfilled: 0,
    totalBackfilled: 0,
    errors: [],
    memorySkips: 0,
  };

  const embeddingService = new LayoutEmbeddingService({ cacheEnabled: false });

  try {
    const missingSections = await getMissingSectionEmbeddings(webPageId);
    if (missingSections.length > 0) {
      const r = await backfillSections(
        missingSections,
        embeddingService,
        chunkSize,
        rssThreshold,
        result.errors,
        onProgress,
        onMemoryPressure
      );
      result.sectionBackfilled = r.backfilled;
      result.memorySkips += r.memorySkips;
    }

    const missingMotions = await getMissingMotionEmbeddings(webPageId);
    if (missingMotions.length > 0) {
      const r = await backfillMotions(
        missingMotions,
        embeddingService,
        chunkSize,
        rssThreshold,
        result.errors,
        onProgress,
        onMemoryPressure
      );
      result.motionBackfilled = r.backfilled;
      result.memorySkips += r.memorySkips;
    }

    const missingBackgrounds = await getMissingBackgroundEmbeddings(webPageId);
    if (missingBackgrounds.length > 0) {
      const r = await backfillBackgrounds(
        missingBackgrounds,
        embeddingService,
        chunkSize,
        rssThreshold,
        result.errors,
        onProgress,
        onMemoryPressure
      );
      result.backgroundBackfilled = r.backfilled;
      result.memorySkips += r.memorySkips;
    }

    const missingJsAnimations = await getMissingJsAnimationEmbeddings(webPageId);
    if (missingJsAnimations.length > 0) {
      const r = await backfillJsAnimations(
        missingJsAnimations,
        embeddingService,
        chunkSize,
        rssThreshold,
        result.errors,
        onProgress,
        onMemoryPressure
      );
      result.jsAnimationBackfilled = r.backfilled;
      result.memorySkips += r.memorySkips;
    }

    const missingResponsive = await getMissingResponsiveEmbeddings(webPageId);
    if (missingResponsive.length > 0) {
      const r = await backfillResponsive(
        missingResponsive,
        embeddingService,
        chunkSize,
        rssThreshold,
        result.errors,
        onProgress,
        onMemoryPressure
      );
      result.responsiveBackfilled = r.backfilled;
      result.memorySkips += r.memorySkips;
    }

    const missingParts = await getMissingPartEmbeddings(webPageId);
    if (missingParts.length > 0) {
      const r = await backfillParts(
        missingParts,
        embeddingService,
        chunkSize,
        rssThreshold,
        result.errors,
        onProgress,
        onMemoryPressure
      );
      result.partBackfilled = r.backfilled;
      result.memorySkips += r.memorySkips;
    }

    result.totalBackfilled =
      result.sectionBackfilled +
      result.motionBackfilled +
      result.backgroundBackfilled +
      result.jsAnimationBackfilled +
      result.responsiveBackfilled +
      result.partBackfilled;
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
  onProgress?: BackfillOptions["onProgress"],
  onMemoryPressure?: BackfillOptions["onMemoryPressure"]
): Promise<ChunkResult> {
  let backfilled = 0;
  let memorySkips = 0;

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const memStatus = await checkMemoryPressure(
      rssThreshold,
      embeddingService,
      "section",
      onMemoryPressure
    );
    if (memStatus === "exceeded") {
      memorySkips++;
      break;
    }

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
        // v0.4.0 PR-D-5 (SEC-S-01 + FIND-SEC-01): row.id 8-char truncation
        // (project PII 規約) + sanitizeErrorMessage (CWE-209 defense).
        errors.push(`section[${row.id.slice(0, 8) + "..."}]: ${sanitizeErrorMessage(error)}`);
      }
    }

    onProgress?.("section", Math.min(offset + chunkSize, rows.length), rows.length);
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
  onProgress?: BackfillOptions["onProgress"],
  onMemoryPressure?: BackfillOptions["onMemoryPressure"]
): Promise<ChunkResult> {
  let backfilled = 0;
  let memorySkips = 0;

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const memStatus = await checkMemoryPressure(
      rssThreshold,
      embeddingService,
      "motion",
      onMemoryPressure
    );
    if (memStatus === "exceeded") {
      memorySkips++;
      break;
    }

    const chunk = rows.slice(offset, offset + chunkSize);

    for (const row of chunk) {
      try {
        const pattern = dbMotionToEmbeddingInput(row);
        const text = generateMotionTextRepresentation(pattern);
        const { embedding } = await embeddingService.generateFromText(text);
        await saveMotionEmbedding(row.id, embedding, MODEL_NAME);
        backfilled++;
      } catch (error) {
        // v0.4.0 PR-D-5 (SEC-S-01 + FIND-SEC-01)
        errors.push(`motion[${row.id.slice(0, 8) + "..."}]: ${sanitizeErrorMessage(error)}`);
      }
    }

    onProgress?.("motion", Math.min(offset + chunkSize, rows.length), rows.length);
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
  onProgress?: BackfillOptions["onProgress"],
  onMemoryPressure?: BackfillOptions["onMemoryPressure"]
): Promise<ChunkResult> {
  let backfilled = 0;
  let memorySkips = 0;

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const memStatus = await checkMemoryPressure(
      rssThreshold,
      embeddingService,
      "background",
      onMemoryPressure
    );
    if (memStatus === "exceeded") {
      memorySkips++;
      break;
    }

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

        const vectorString = `[${embeddingResult.embedding.join(",")}]`;
        await prisma.$executeRawUnsafe(
          `UPDATE background_design_embeddings SET embedding = $1::vector WHERE id = $2::uuid`,
          vectorString,
          createdRecord.id
        );

        backfilled++;
      } catch (error) {
        // v0.4.0 PR-D-5 (SEC-S-01 + FIND-SEC-01)
        errors.push(`background[${row.id.slice(0, 8) + "..."}]: ${sanitizeErrorMessage(error)}`);
      }
    }

    onProgress?.("background", Math.min(offset + chunkSize, rows.length), rows.length);
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
  onProgress?: BackfillOptions["onProgress"],
  onMemoryPressure?: BackfillOptions["onMemoryPressure"]
): Promise<ChunkResult> {
  let backfilled = 0;
  let memorySkips = 0;

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const memStatus = await checkMemoryPressure(
      rssThreshold,
      embeddingService,
      "jsAnimation",
      onMemoryPressure
    );
    if (memStatus === "exceeded") {
      memorySkips++;
      break;
    }

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
        // v0.4.0 PR-D-5 (SEC-S-01 + FIND-SEC-01)
        errors.push(`jsAnimation[${row.id.slice(0, 8) + "..."}]: ${sanitizeErrorMessage(error)}`);
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
            .join(", ");

          const params: unknown[] = [];
          for (const item of vectorUpdates) {
            params.push(`[${item.embedding.join(",")}]`);
            params.push(item.dbId);
          }

          await prisma.$executeRawUnsafe(
            `UPDATE js_animation_embeddings AS e SET embedding = v.vec FROM (VALUES ${valuesClause}) AS v(vec, pattern_id) WHERE e.js_animation_pattern_id = v.pattern_id`,
            ...params
          );
        }

        backfilled += embeddingItems.length;
      } catch (error) {
        // v0.4.0 PR-D-5 (SEC-S-01): batch op — no row.id.
        errors.push(`jsAnimation-batch: ${sanitizeErrorMessage(error)}`);
      }
    }

    onProgress?.("jsAnimation", Math.min(offset + chunkSize, rows.length), rows.length);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { backfilled, memorySkips };
}

// =====================================================
// Responsive Analysis Backfill
// =====================================================

async function getMissingResponsiveEmbeddings(webPageId: string): Promise<MissingResponsiveRow[]> {
  // PR-D-9 Wave 3 (C-07 / FIND-PLAN-LCC-02): GDPR Art.17 TOCTOU resurrection
  // defense. Inherits `apps/mcp-server/DATA_RETENTION.md` "v0.4.0 PR7e-β4 PR2d
  // LCC-M-2 contract": when `data.delete(web_page_id)` runs concurrently with
  // active backfill, this query MUST NOT resurrect already-deleted rows.
  //
  // The `JOIN web_pages wp ON ra.web_page_id = wp.id` already provides
  // existence filtering (any deletion of `web_pages` cascades the rows here),
  // but we add the explicit `EXISTS` predicate as defense-in-depth + an
  // intent-clarifying SQL contract reviewers can grep for.
  //
  // PR-D-9 Wave 3 (C-07 / FIND-PLAN-LCC-02): GDPR Art.17 TOCTOU defensive
  // WHERE clause. See DATA_RETENTION.md PR2d LCC-M-2 contract.
  return prisma.$queryRawUnsafe<MissingResponsiveRow[]>(
    `
    SELECT ra.id, ra.web_page_id, wp.url,
           ra.viewports_analyzed, ra.differences, ra.breakpoints, ra.screenshot_diffs
    FROM responsive_analyses ra
    LEFT JOIN responsive_analysis_embeddings rae ON ra.id = rae.responsive_analysis_id
    JOIN web_pages wp ON ra.web_page_id = wp.id
    WHERE rae.id IS NULL
      AND ra.web_page_id = $1::uuid
      AND EXISTS (SELECT 1 FROM web_pages WHERE id = $1::uuid)
  `,
    webPageId
  );
}

/**
 * PR-D-9 Wave 3 (FIND-PLAN-LCC-02 / C-13 diagnostic): lightweight `COUNT(*)`
 * probe used by `ResponsiveProcessor.processInProcess` to detect silent stalls
 * (expectedCount > 0 yet generatedCount === 0 — the PR-D-7 §32.2 signature).
 *
 * Intentionally separate from `getMissingResponsiveEmbeddings` so the probe
 * does not pull large JSONB columns (`differences` / `screenshot_diffs`) into
 * memory. Same TOCTOU defensive WHERE clause as the row query.
 *
 * @param webPageId UUID of the target page (PII; never log unsanitized)
 * @returns count of `responsive_analyses` rows missing `responsive_analysis_embeddings`
 */
export async function countMissingResponsiveEmbeddings(webPageId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ missing: bigint | number }>>(
    `
    SELECT COUNT(*)::bigint AS missing
    FROM responsive_analyses ra
    LEFT JOIN responsive_analysis_embeddings rae ON ra.id = rae.responsive_analysis_id
    WHERE rae.id IS NULL
      AND ra.web_page_id = $1::uuid
      AND EXISTS (SELECT 1 FROM web_pages WHERE id = $1::uuid)
  `,
    webPageId
  );
  const raw = rows[0]?.missing ?? 0;
  return typeof raw === "bigint" ? Number(raw) : raw;
}

function convertResponsiveRowToTextInput(row: MissingResponsiveRow): ResponsiveAnalysisForText {
  const viewportsAnalyzed = Array.isArray(row.viewports_analyzed)
    ? (row.viewports_analyzed as Array<{ name: string; width: number; height: number }>)
    : [];
  const differences = Array.isArray(row.differences)
    ? (row.differences as Array<{
        category: string;
        selector?: string;
        description: string;
        viewports?: string[];
      }>)
    : [];
  const breakpoints = Array.isArray(row.breakpoints)
    ? (row.breakpoints as Array<{ width: number; type?: string }>)
    : undefined;
  const screenshotDiffs = Array.isArray(row.screenshot_diffs)
    ? (row.screenshot_diffs as Array<{
        viewport1: string;
        viewport2: string;
        diffPercentage: number;
      }>)
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
  onProgress?: BackfillOptions["onProgress"],
  onMemoryPressure?: BackfillOptions["onMemoryPressure"]
): Promise<ChunkResult> {
  let backfilled = 0;
  let memorySkips = 0;

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const memStatus = await checkMemoryPressure(
      rssThreshold,
      embeddingService,
      "responsive",
      onMemoryPressure
    );
    if (memStatus === "exceeded") {
      memorySkips++;
      break;
    }

    const chunk = rows.slice(offset, offset + chunkSize);
    const embeddingItems: Array<{ dbId: string; textRepresentation: string; embedding: number[] }> =
      [];

    for (const row of chunk) {
      try {
        const textInput = convertResponsiveRowToTextInput(row);
        const textRepresentation = generateResponsiveAnalysisTextRepresentation(textInput);
        const { embedding } = await embeddingService.generateFromText(textRepresentation);
        embeddingItems.push({ dbId: row.id, textRepresentation, embedding });
      } catch (error) {
        // v0.4.0 PR-D-5 (SEC-S-01 + FIND-SEC-01)
        errors.push(`responsive-${row.id.slice(0, 8) + "..."}: ${sanitizeErrorMessage(error)}`);
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
            .join(", ");

          const params: unknown[] = [];
          for (const item of vectorUpdates) {
            params.push(`[${item.embedding.join(",")}]`);
            params.push(item.dbId);
          }

          await prisma.$executeRawUnsafe(
            `UPDATE responsive_analysis_embeddings AS e SET embedding = v.vec FROM (VALUES ${valuesClause}) AS v(vec, analysis_id) WHERE e.responsive_analysis_id = v.analysis_id`,
            ...params
          );
        }

        backfilled += embeddingItems.length;
      } catch (error) {
        // v0.4.0 PR-D-5 (SEC-S-01): batch op — no row.id.
        errors.push(`responsive-batch: ${sanitizeErrorMessage(error)}`);
      }
    }

    onProgress?.("responsive", Math.min(offset + chunkSize, rows.length), rows.length);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { backfilled, memorySkips };
}

// =====================================================
// Part Backfill
// =====================================================

function dbPartToEmbeddingInput(row: MissingPartRow): ComponentPartForEmbedding {
  return {
    id: row.id,
    partType: row.part_type,
    partSubtype: row.part_subtype,
    computedStyles: (row.computed_styles as Record<string, string>) ?? {},
    cssClasses: Array.isArray(row.css_classes) ? row.css_classes : [],
    attributes: (row.attributes as Record<string, string>) ?? {},
    interactionInfo: (row.interaction_info as Record<string, boolean>) ?? {},
  };
}

// =====================================================
// v0.4.0 PR4: Queue-based Backfill Entry Points
// =====================================================

/**
 * Per-category backfill result shape (shared by all 6 Queue-based wrappers).
 * 6 つの Queue-based wrapper が共通で返す per-category バックフィル結果型。
 */
export interface PerCategoryBackfillResult {
  generated: number;
  failed: number;
  memorySkips: number;
  errors: string[];
}

/**
 * v0.4.0 PR7a-3: Generic per-category backfill core shared by all 6 Queue-based wrappers.
 *
 * 6 つの Queue-based per-category wrapper（part_text / section_visual / motion /
 * background / js_animation / responsive）が共通で持つ 99% 同一の骨組み
 * （EmbeddingService 生成 → missing 行取得 → 0 件早期 return → chunk loop →
 * finally で dispose + GC）をジェネリックに集約する。TDA High-1 で指摘された
 * 重複率 6.0% を解消するため、PR7a 収束修正で導入。
 *
 * `part_visual` は DINOv2 管理（Playwright browser + DINOv2 pipeline）が必要な
 * ため本ジェネリックの対象外。Worker 内で `runVisualEmbeddingSubPhases` を直接
 * 呼ぶ設計（`countPartVisualBackfillTargets` のみを service に残す）。
 *
 * Generic core shared by all 6 Queue-based per-category wrappers (part_text /
 * section_visual / motion / background / js_animation / responsive). Extracted
 * to resolve the 6.0% duplication flagged by TDA High-1 in the PR7a audit.
 *
 * `part_visual` is out of scope because DINOv2 management (Playwright browser
 * + DINOv2 pipeline) lives in the Worker via `runVisualEmbeddingSubPhases`;
 * the service only exposes `countPartVisualBackfillTargets` for it.
 *
 * @param params.webPageId - 対象ページの UUID / Target page UUID
 * @param params.options - BackfillOptions（chunkSize / rssThreshold / callbacks） /
 *   BackfillOptions (chunkSize / rssThreshold / callbacks)
 * @param params.getMissingRows - `embedding IS NULL` 行を取得する関数 /
 *   Function returning rows with `embedding IS NULL`
 * @param params.runChunkLoop - category 固有の chunk runner（embedding 生成 + 保存） /
 *   Category-specific chunk runner (embedding generation + persistence)
 */
async function backfillCategoryForPage<TRow>(params: {
  webPageId: string;
  options: BackfillOptions | undefined;
  getMissingRows: (webPageId: string) => Promise<TRow[]>;
  runChunkLoop: (
    rows: TRow[],
    embeddingService: LayoutEmbeddingService,
    chunkSize: number,
    rssThreshold: number,
    errors: string[],
    onProgress?: BackfillOptions["onProgress"],
    onMemoryPressure?: BackfillOptions["onMemoryPressure"]
  ) => Promise<ChunkResult>;
}): Promise<PerCategoryBackfillResult> {
  const { webPageId, options, getMissingRows, runChunkLoop } = params;
  const chunkSize = Math.max(1, Math.min(options?.chunkSize ?? DEFAULT_BACKFILL_CHUNK_SIZE, 100));
  const rssThreshold = resolveRssThreshold(options);
  const errors: string[] = [];
  const embeddingService = new LayoutEmbeddingService({ cacheEnabled: false });

  try {
    const missing = await getMissingRows(webPageId);
    if (missing.length === 0) {
      return { generated: 0, failed: 0, memorySkips: 0, errors: [] };
    }
    const result = await runChunkLoop(
      missing,
      embeddingService,
      chunkSize,
      rssThreshold,
      errors,
      options?.onProgress,
      options?.onMemoryPressure
    );
    return {
      generated: result.backfilled,
      failed: missing.length - result.backfilled,
      memorySkips: result.memorySkips,
      errors,
    };
  } finally {
    try {
      await embeddingService.disposeEmbeddingPipeline();
    } catch {
      /* non-fatal during cleanup */
    }
    tryGarbageCollect();
  }
}

/**
 * Part text embedding を 1 ページ分バックフィルする（Queue Worker 用）
 * Backfill Part text embeddings for a single page (for the Queue Worker).
 *
 * v0.4.0 PR4: embedding-backfill Queue の Worker から呼び出される。
 * DB self-discovery で `embedding IS NULL` のパーツを一括取得し、
 * e5-base で text embedding を生成して保存する。
 * Phase 5 同期フェーズで使われる `processPartTextEmbeddingChunks` と
 * 同じ表現生成ロジックを使う（`buildPartTextRepresentation`）。
 *
 * v0.4.0 PR7a-3: TDA High-1 の重複解消のため共通ジェネリック
 * `backfillCategoryForPage` への薄いラッパーに変更。public signature は維持。
 *
 * v0.4.0 PR4: Invoked by the embedding-backfill Queue Worker.
 * Uses DB self-discovery (`embedding IS NULL`) to fetch target Parts,
 * generates text embeddings via e5-base, and saves them.
 *
 * v0.4.0 PR7a-3: Refactored into a thin wrapper over the generic
 * `backfillCategoryForPage` core to resolve TDA High-1 duplication.
 * Public signature preserved.
 */
export async function backfillPartTextForPage(
  webPageId: string,
  options?: BackfillOptions
): Promise<PerCategoryBackfillResult> {
  return backfillCategoryForPage({
    webPageId,
    options,
    getMissingRows: getMissingPartEmbeddings,
    runChunkLoop: backfillParts,
  });
}

/**
 * Part visual embedding (DINOv2) を 1 ページ分バックフィルする（Queue Worker 用）
 * Backfill Part visual embeddings (DINOv2) for a single page (for the Queue Worker).
 *
 * v0.4.0 PR4: 永続化された screenshot (PR1) を使って DINOv2 ViT-B/14 で visual
 * embedding を生成する。screenshot が無い / bbox 未解決の場合は 0 件を返す
 * （Graceful Degradation）。
 *
 * 注: DINOv2 / bbox 再解決 / Playwright ブラウザ起動は複雑かつ重い処理であり、
 * 本 PR では Worker 実装側で DB から `visual_embedding IS NULL` のパーツを
 * 抽出・処理する。本関数はその入口を提供する薄いラッパー（DB カウントのみ
 * を行い、実際の DINOv2 処理は呼び出し側の Worker で実行する）。
 *
 * v0.4.0 PR4: Uses the persisted screenshot (PR1) to generate DINOv2 ViT-B/14
 * visual embeddings. Returns 0 when no screenshot is available or bbox has
 * not been resolved (Graceful Degradation).
 *
 * Note: DINOv2 / bbox re-resolution / Playwright browser startup are heavy
 * and the actual DINOv2 loop runs in the Worker process. This function is a
 * thin entry point that only counts pending targets; the Worker executes
 * the DINOv2 pipeline directly via `runVisualEmbeddingSubPhases`.
 *
 * @param webPageId - 対象ページの UUID / Target page UUID
 * @returns `pendingCount` が 0 でない場合のみ実際のバックフィルが必要
 */
export async function countPartVisualBackfillTargets(
  webPageId: string
): Promise<{ pendingCount: number }> {
  // ADR-0018 Amendment 7 §7.1 (UB-3, NF-TPA-01): SSOT exclusion predicate so
  // terminal-skip parts (visual_skip_reason non-NULL) are NOT counted as pending.
  const rows = await prisma.$queryRawUnsafe<Array<{ count: string }>>(
    `SELECT COUNT(*) as count FROM component_parts cp
     JOIN component_part_embeddings cpe ON cp.id = cpe.component_part_id
     WHERE cp.web_page_id = $1::uuid
       AND cp.pii_risk_level != 'high'
       AND ${partVisualPendingExclusionPredicate("cpe")}`,
    webPageId
  );
  const countStr = rows[0]?.count ?? "0";
  const pendingCount = Number.parseInt(countStr, 10);
  return { pendingCount: Number.isFinite(pendingCount) && pendingCount > 0 ? pendingCount : 0 };
}

/**
 * Section vision embedding（DINOv2）のバックフィル候補件数を返す（Queue Worker 用）
 * Count Section vision embedding (DINOv2) backfill candidates (for the Queue Worker).
 *
 * v0.4.0 PR7b: `section_embeddings.text_embedding IS NOT NULL AND vision_embedding IS NULL`
 * の section を対象とする。Phase 5 の section visual embedding ループと同じ条件
 * （`runVisualEmbeddingSubPhases` 内 `sectionsNeedingVisual` クエリ）に揃える。
 * PR-C4: PII フィルタ（piiRiskLevel='high' を含む section の除外）は
 * `sectionVisualPendingExclusionPredicate` の PII NOT EXISTS で **この pending 判定
 * 自体に**適用される（work 側 DINOv2 ループの除外と対称化、part_visual と同 rigor）。
 * 以前は work 側ループのみが PII 除外し pending 側は非対称だったため high-PII
 * section が永久 pending = page completed 未到達の真因だった。
 *
 * v0.4.0 PR7b: Targets sections where
 * `section_embeddings.text_embedding IS NOT NULL AND vision_embedding IS NULL`,
 * matching the same condition used by the Phase 5 visual embedding loop
 * (`sectionsNeedingVisual` inside `runVisualEmbeddingSubPhases`). PR-C4: PII
 * filtering (excluding sections containing piiRiskLevel='high' parts) is now
 * applied to **this pending count itself** via the
 * `sectionVisualPendingExclusionPredicate` PII NOT EXISTS (symmetric with the
 * work-side DINOv2 loop exclusion, same rigor as part_visual). Previously only
 * the work-side loop excluded high-PII sections while the pending side did not —
 * the asymmetry that left high-PII sections permanently pending (page never
 * reaching `completed`).
 *
 * @param webPageId - 対象ページの UUID / Target page UUID
 * @returns `pendingCount` が 0 でない場合のみ実際のバックフィルが必要
 */
export async function countSectionVisualBackfillTargets(
  webPageId: string
): Promise<{ pendingCount: number }> {
  // terminal-skip 行 (vision_skip_reason 非NULL) は SSOT exclusion predicate で
  // pending から除外する (PR-BT-2、part_visual と対称、inline WHERE 禁止)。
  // Terminal-skip rows (vision_skip_reason non-NULL) are excluded via the SSOT
  // exclusion predicate (PR-BT-2, symmetry with part_visual).
  const rows = await prisma.$queryRawUnsafe<Array<{ count: string }>>(
    `SELECT COUNT(*) as count FROM section_embeddings se
     JOIN section_patterns sp ON se.section_pattern_id = sp.id
     WHERE sp.web_page_id = $1::uuid
       AND ${sectionVisualPendingExclusionPredicate("se")}`,
    webPageId
  );
  const countStr = rows[0]?.count ?? "0";
  const pendingCount = Number.parseInt(countStr, 10);
  return { pendingCount: Number.isFinite(pendingCount) && pendingCount > 0 ? pendingCount : 0 };
}

async function backfillParts(
  rows: MissingPartRow[],
  embeddingService: LayoutEmbeddingService,
  chunkSize: number,
  rssThreshold: number,
  errors: string[],
  onProgress?: BackfillOptions["onProgress"],
  onMemoryPressure?: BackfillOptions["onMemoryPressure"]
): Promise<ChunkResult> {
  let backfilled = 0;
  let memorySkips = 0;

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const memStatus = await checkMemoryPressure(
      rssThreshold,
      embeddingService,
      "part",
      onMemoryPressure
    );
    if (memStatus === "exceeded") {
      memorySkips++;
      break;
    }

    const chunk = rows.slice(offset, offset + chunkSize);
    const embeddingItems: Array<{
      componentPartId: string;
      textRepresentation: string;
      textEmbedding: number[];
      visualEmbedding: null;
    }> = [];

    for (const row of chunk) {
      try {
        const partInput = dbPartToEmbeddingInput(row);
        const textRepresentation = buildPartTextRepresentation(partInput);
        const { embedding } = await embeddingService.generateFromText(textRepresentation);
        embeddingItems.push({
          componentPartId: row.id,
          textRepresentation,
          textEmbedding: embedding,
          visualEmbedding: null,
        });
      } catch (error) {
        // v0.4.0 PR-D-5 (SEC-S-01 + FIND-SEC-01)
        errors.push(`part[${row.id.slice(0, 8) + "..."}]: ${sanitizeErrorMessage(error)}`);
      }
    }

    if (embeddingItems.length > 0) {
      try {
        // PR-D-2: savedCount → generatedCount rename。backfill path は
        // visualEmbedding=null hard-coded のため text のみ書込 (PartVisualProcessor
        // が別 flow で担当)。saveResult.errors は sanitize 済み (transaction
        // rollback 発生時のみ出現)。FIND-PLAN-06: backfill path visual 非対応
        // は ADR-0018 Amendment で明記予定。
        //
        // PR-D-2: renamed savedCount → generatedCount. The backfill path
        // hard-codes visualEmbedding=null, writing text only (visual embedding
        // owned by a separate flow: PartVisualProcessor). saveResult.errors
        // are sanitized (appearing only on transaction rollback). FIND-PLAN-06:
        // backfill path visual incompatibility will be documented in the
        // ADR-0018 Amendment.
        const saveResult = await savePartEmbeddings(
          prisma as unknown as PartEmbeddingPrismaClient,
          embeddingItems
        );
        backfilled += saveResult.generatedCount;
        if (saveResult.filteredNonFinite > 0) {
          // PII-free numeric warning; sanitized by sanitizeErrorMessage in errors[].
          errors.push(
            `part-batch: pre-filtered ${saveResult.filteredNonFinite} non-finite embeddings (NaN/Infinity)`
          );
        }
        if (saveResult.errors.length > 0) {
          errors.push(...saveResult.errors);
        }
      } catch (error) {
        // v0.4.0 PR-D-5 (SEC-S-01): batch op — no row.id.
        errors.push(`part-batch: ${sanitizeErrorMessage(error)}`);
      }
    }

    onProgress?.("part", Math.min(offset + chunkSize, rows.length), rows.length);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { backfilled, memorySkips };
}

// =====================================================
// v0.4.0 PR7a-2: Per-category Backfill Entry Points
// =====================================================
//
// Strategy Pattern (`embedding-backfill-processors.ts`) から呼び出される per-category
// wrapper。各 wrapper は `backfillPartTextForPage` と同じ形で EmbeddingService の
// ライフサイクル（init → dispose）を完結させる。Skip recovery enqueue パス
// （PR7b）からこれらを直接 invoke する。
//
// Per-category wrappers invoked by the Strategy Pattern in
// `embedding-backfill-processors.ts`. Each wrapper mirrors `backfillPartTextForPage`:
// it owns the EmbeddingService lifecycle (init → dispose). PR7b's skip-recovery
// enqueue path will invoke these directly.

/**
 * Section text embedding を 1 ページ分バックフィルする
 * Backfill section text embeddings for a single page
 *
 * 注: `backfillSections()` は内部で section の text embedding を生成する。
 * Vision embedding は現状 Phase 5 同期フェーズの DINOv2 ループが持つため、
 * 本 wrapper は text embedding の復旧のみを担当する。
 *
 * Note: `backfillSections()` generates section text embeddings. Vision embeddings
 * are owned by the Phase 5 synchronous DINOv2 loop; this wrapper covers text
 * embedding recovery only.
 *
 * v0.4.0 PR7a-3: ジェネリック `backfillCategoryForPage` への薄いラッパーに統一。
 * v0.4.0 PR7a-3: Unified as a thin wrapper over the generic `backfillCategoryForPage`.
 */
export async function backfillSectionVisualsForPage(
  webPageId: string,
  options?: BackfillOptions
): Promise<PerCategoryBackfillResult> {
  return backfillCategoryForPage({
    webPageId,
    options,
    getMissingRows: getMissingSectionEmbeddings,
    runChunkLoop: backfillSections,
  });
}

/**
 * Motion embedding を 1 ページ分バックフィルする
 * Backfill motion embeddings for a single page
 *
 * v0.4.0 PR7a-3: ジェネリック `backfillCategoryForPage` への薄いラッパーに統一。
 * v0.4.0 PR7a-3: Unified as a thin wrapper over the generic `backfillCategoryForPage`.
 */
export async function backfillMotionsForPage(
  webPageId: string,
  options?: BackfillOptions
): Promise<PerCategoryBackfillResult> {
  return backfillCategoryForPage({
    webPageId,
    options,
    getMissingRows: getMissingMotionEmbeddings,
    runChunkLoop: backfillMotions,
  });
}

/**
 * Background embedding を 1 ページ分バックフィルする
 * Backfill background embeddings for a single page
 *
 * v0.4.0 PR7a-3: ジェネリック `backfillCategoryForPage` への薄いラッパーに統一。
 * v0.4.0 PR7a-3: Unified as a thin wrapper over the generic `backfillCategoryForPage`.
 */
export async function backfillBackgroundsForPage(
  webPageId: string,
  options?: BackfillOptions
): Promise<PerCategoryBackfillResult> {
  return backfillCategoryForPage({
    webPageId,
    options,
    getMissingRows: getMissingBackgroundEmbeddings,
    runChunkLoop: backfillBackgrounds,
  });
}

/**
 * JS Animation embedding を 1 ページ分バックフィルする
 * Backfill JS animation embeddings for a single page
 *
 * v0.4.0 PR7a-3: ジェネリック `backfillCategoryForPage` への薄いラッパーに統一。
 * v0.4.0 PR7a-3: Unified as a thin wrapper over the generic `backfillCategoryForPage`.
 *
 * v0.4.0 PR7e-β4 PR2b-β (TPA-M-1): `options.partsLimit` が指定された場合は
 * `getMissingJsAnimationEmbeddingsWithLimit(webPageId, partsLimit)` に routing し、
 * DB 取得時点で head-N 件に切り詰める。既存 in-process caller は `partsLimit`
 * undefined で呼び出すため挙動不変。
 *
 * v0.4.0 PR7e-β4 PR2b-β (TPA-M-1): When `options.partsLimit` is set, routes to
 * `getMissingJsAnimationEmbeddingsWithLimit(webPageId, partsLimit)` to truncate
 * at the DB fetch. Existing in-process callers pass `undefined` → behavior is
 * unchanged.
 */
export async function backfillJsAnimationsForPage(
  webPageId: string,
  options?: BackfillOptions
): Promise<PerCategoryBackfillResult> {
  const partsLimit = options?.partsLimit;
  const getMissingRows =
    partsLimit !== undefined && Number.isFinite(partsLimit) && partsLimit > 0
      ? (id: string): Promise<MissingJsAnimationRow[]> =>
          getMissingJsAnimationEmbeddingsWithLimit(id, partsLimit)
      : getMissingJsAnimationEmbeddings;
  return backfillCategoryForPage({
    webPageId,
    options,
    getMissingRows,
    runChunkLoop: backfillJsAnimations,
  });
}

/**
 * Responsive analysis embedding を 1 ページ分バックフィルする
 * Backfill responsive analysis embeddings for a single page
 *
 * v0.4.0 PR7a-3: ジェネリック `backfillCategoryForPage` への薄いラッパーに統一。
 * v0.4.0 PR7a-3: Unified as a thin wrapper over the generic `backfillCategoryForPage`.
 */
export async function backfillResponsiveForPage(
  webPageId: string,
  options?: BackfillOptions
): Promise<PerCategoryBackfillResult> {
  return backfillCategoryForPage({
    webPageId,
    options,
    getMissingRows: getMissingResponsiveEmbeddings,
    runChunkLoop: backfillResponsive,
  });
}
