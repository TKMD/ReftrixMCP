// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker DB Save Service
 *
 * page-analyze-worker用のDB保存ロジック。
 * SectionPattern/MotionPatternをDBに保存する。
 *
 * Background:
 * - 同期版analyze.tool.tsはdb-handler.ts経由でDB保存
 * - async worker版はWebPageのみ保存していた（SectionPattern/MotionPatternは未保存だった）
 * - このサービスでworkerからもSectionPattern/MotionPatternを保存可能にする
 *
 * パターン:
 * - クリーンスレート（deleteMany → createMany）
 * - UUIDv7 によるID生成
 * - Graceful Degradation（保存失敗時もジョブは継続）
 *
 * @module services/worker-db-save.service
 */

import { v7 as uuidv7 } from 'uuid';
import { logger, isDevelopment } from '../utils/logger';
import { type QualityServiceResult, type JSAnimationFullResult, type CDPAnimationData, type WebAnimationData, type LibraryDetectionData } from '../tools/page/handlers/types';

// =============================================================================
// Constants
// =============================================================================

/**
 * PostgreSQL bind parameter limit is 65,535.
 * With 37 columns in js_animation_patterns, max ~1,771 records per query.
 * With 21 columns in motion_patterns, max ~3,120 records per query.
 * Use 1,000 for safety margin across all batched createMany calls.
 */
const PRISMA_CREATE_MANY_BATCH_SIZE = 1000;

// =============================================================================
// Types
// =============================================================================

/**
 * レイアウト分析結果からのセクション（defaultAnalyzeLayout戻り値）
 */
export interface LayoutSection {
  id: string;
  type: string;
  positionIndex: number;
  heading?: string;
  confidence: number;
  htmlSnippet?: string;
  position?: { startY: number; endY: number; height: number };
  visionFeatures?: unknown;
  visualFeatures?: unknown;
}

/**
 * モーション分析結果からのパターン（defaultDetectMotion戻り値）
 * exactOptionalPropertyTypes対応: undefinedを明示
 */
export interface MotionPatternInput {
  id?: string | undefined;
  name: string;
  type: string;
  category: string;
  trigger: string;
  duration?: number | undefined;
  easing?: string | undefined;
  properties?: string[] | undefined;
  propertiesDetailed?: Array<{ property: string; from?: string; to?: string }> | undefined;
  rawCss?: string | undefined;
  performance?: {
    level?: string | undefined;
    usesTransform?: boolean | undefined;
    usesOpacity?: boolean | undefined;
  } | undefined;
  accessibility?: {
    respectsReducedMotion?: boolean | undefined;
  } | undefined;
}

/**
 * 品質評価結果の入力型。
 * QualityServiceResult を直接使用して型の二重定義を回避。
 */
export type QualityEvaluationInput = QualityServiceResult;

/**
 * 品質評価保存オプション
 * exactOptionalPropertyTypes対応: undefinedを明示
 */
export interface QualityEvaluationSaveOptions {
  strict?: boolean | undefined;
  targetIndustry?: string | undefined;
  targetAudience?: string | undefined;
}

/**
 * Prismaクライアントインターフェース（QualityEvaluation保存用）
 */
export interface QualityEvaluationPrismaClient {
  qualityEvaluation: {
    deleteMany: (args: { where: { targetType: string; targetId: string } }) => Promise<{ count: number }>;
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
}

/**
 * 品質ベンチマーク入力型
 * quality_benchmarksテーブルへの保存用データ
 * exactOptionalPropertyTypes対応: undefinedを明示
 */
export interface QualityBenchmarkInput {
  /** セクションタイプ (hero, feature, cta, full_page 等) */
  sectionType: string;
  /** 総合スコア (0-100) */
  overallScore: number;
  /** グレード (A, B, C, D, F) */
  grade: string;
  /** 3軸スコア (JSON) */
  axisScores: {
    originality: number;
    craftsmanship: number;
    contextuality: number;
  };
  /** ソースURL */
  sourceUrl: string;
  /** ソースタイプ (page_analyze, award_gallery, user_provided, curated) */
  sourceType: string;
  /** セクションパターンID（セクション単位の場合） */
  sectionPatternId?: string | undefined;
  /** 特徴量リスト */
  characteristics?: string[] | undefined;
  /** HTMLスニペット */
  htmlSnippet?: string | undefined;
  /** プレビュー画像URL */
  previewUrl?: string | undefined;
  /** 業界 */
  industry?: string | undefined;
  /** ターゲットオーディエンス */
  audience?: string | undefined;
}

/**
 * Prismaクライアントインターフェース（QualityBenchmark保存用）
 */
export interface QualityBenchmarkPrismaClient {
  qualityBenchmark: {
    deleteMany: (args: { where: { webPageId: string } }) => Promise<{ count: number }>;
    createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
  };
}

/**
 * 保存結果
 */
export interface SaveResult {
  success: boolean;
  count: number;
  ids: string[];
  /** originalId → DB UUIDv7 のマッピング（Embedding生成で使用） */
  idMapping: Map<string, string>;
  error?: string | undefined;
}

/**
 * Prismaクライアントインターフェース（SectionPattern保存用）
 */
export interface SectionPatternPrismaClient {
  sectionPattern: {
    deleteMany: (args: { where: { webPageId: string } }) => Promise<{ count: number }>;
    createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
  };
}

/**
 * Prismaクライアントインターフェース（MotionPattern保存用）
 */
export interface MotionPatternPrismaClient {
  motionPattern: {
    deleteMany: (args: { where: { webPageId: string; type?: { not: string } } }) => Promise<{ count: number }>;
    createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
  };
  $transaction: <T>(fn: (tx: Pick<MotionPatternPrismaClient, 'motionPattern'>) => Promise<T>) => Promise<T>;
}

/**
 * Prismaクライアントインターフェース（JSAnimationPattern保存用）
 */
export interface JsAnimationPatternPrismaClient {
  jSAnimationPattern: {
    deleteMany: (args: { where: { webPageId: string } }) => Promise<{ count: number }>;
    createMany: (args: { data: unknown[] }) => Promise<{ count: number }>;
  };
  $transaction: <T>(fn: (tx: Pick<JsAnimationPatternPrismaClient, 'jSAnimationPattern'>) => Promise<T>) => Promise<T>;
}

// =============================================================================
// SectionPattern Save
// =============================================================================

/**
 * htmlSnippetからUIコンポーネントを簡易抽出
 */
function extractComponentsFromSection(htmlSnippet?: string): Array<{ type: string; count: number }> {
  if (!htmlSnippet) return [];

  const components: Array<{ type: string; count: number }> = [];
  const tagPatterns: Array<{ type: string; pattern: RegExp }> = [
    { type: 'button', pattern: /<button[\s>]/gi },
    { type: 'link', pattern: /<a[\s][^>]*href/gi },
    { type: 'image', pattern: /<img[\s>]/gi },
    { type: 'video', pattern: /<video[\s>]/gi },
    { type: 'form', pattern: /<form[\s>]/gi },
    { type: 'input', pattern: /<input[\s>]/gi },
    { type: 'heading', pattern: /<h[1-6][\s>]/gi },
    { type: 'list', pattern: /<[ou]l[\s>]/gi },
    { type: 'table', pattern: /<table[\s>]/gi },
    { type: 'svg', pattern: /<svg[\s>]/gi },
    { type: 'canvas', pattern: /<canvas[\s>]/gi },
    { type: 'iframe', pattern: /<iframe[\s>]/gi },
  ];

  for (const { type, pattern } of tagPatterns) {
    const matches = htmlSnippet.match(pattern);
    if (matches && matches.length > 0) {
      components.push({ type, count: matches.length });
    }
  }

  return components;
}

/**
 * SectionPatternをDBに保存
 *
 * @param prisma - Prismaクライアント
 * @param webPageId - WebPage ID
 * @param sections - レイアウト分析結果のセクション配列
 * @param sourceUrl - 元URL
 * @returns 保存結果
 */
export async function saveSectionPatterns(
  prisma: SectionPatternPrismaClient,
  webPageId: string,
  sections: LayoutSection[]
): Promise<SaveResult> {
  if (sections.length === 0) {
    return { success: true, count: 0, ids: [], idMapping: new Map() };
  }

  try {
    // 1. 既存レコードを削除（クリーンスレート）
    await prisma.sectionPattern.deleteMany({
      where: { webPageId },
    });

    if (isDevelopment()) {
      logger.debug('[WorkerDBSave] Existing section patterns deleted', { webPageId });
    }

    // 2. データ変換
    const ids: string[] = [];
    const idMapping = new Map<string, string>();
    const data = sections.map((section, index) => {
      const id = uuidv7();
      ids.push(id);
      idMapping.set(section.id, id);

      // layoutInfo JSON構造
      const layoutInfo: Record<string, unknown> = {
        type: section.type,
        confidence: section.confidence,
      };
      if (section.position) {
        layoutInfo.position = section.position;
      }

      // components JSON（htmlSnippetから簡易抽出）
      const components = extractComponentsFromSection(section.htmlSnippet);

      // visualFeatures JSON
      const visualFeatures = section.visualFeatures ?? {};

      return {
        id,
        webPageId,
        sectionType: section.type,
        sectionName: section.heading ?? null,
        positionIndex: section.positionIndex ?? index,
        htmlSnippet: section.htmlSnippet ?? null,
        layoutInfo,
        components,
        visualFeatures,
        tags: [],
        metadata: {},
      };
    });

    // 3. バッチインサート
    const result = await prisma.sectionPattern.createMany({ data });

    if (isDevelopment()) {
      logger.info('[WorkerDBSave] Saved section patterns', {
        webPageId,
        count: result.count,
      });
    }

    return {
      success: true,
      count: result.count,
      ids,
      idMapping,
    };
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : 'Failed to save section patterns';

    if (isDevelopment()) {
      logger.error('[WorkerDBSave] Section pattern save failed', {
        webPageId,
        error: errorMessage,
      });
    }

    return {
      success: false,
      count: 0,
      ids: [],
      idMapping: new Map(),
      error: errorMessage,
    };
  }
}

// =============================================================================
// MotionPattern Save
// =============================================================================

/**
 * MotionPatternをDBに保存
 *
 * @param prisma - Prismaクライアント
 * @param webPageId - WebPage ID
 * @param patterns - モーション分析結果のパターン配列
 * @param sourceUrl - 元URL
 * @returns 保存結果
 */
export async function saveMotionPatterns(
  prisma: MotionPatternPrismaClient,
  webPageId: string,
  patterns: MotionPatternInput[],
  sourceUrl: string
): Promise<SaveResult> {
  if (patterns.length === 0) {
    return { success: true, count: 0, ids: [], idMapping: new Map() };
  }

  try {
    // 1. データ変換（トランザクション外で実施）
    const ids: string[] = [];
    const idMapping = new Map<string, string>();
    const data = patterns.map((pattern) => {
      const id = uuidv7();
      ids.push(id);
      if (pattern.id) {
        idMapping.set(pattern.id, id);
      }

      // animation JSON
      const animation: Record<string, unknown> = {
        duration: pattern.duration ?? 0,
        delay: 0,
        easing: { type: pattern.easing ?? 'ease' },
        iterations: 1,
        direction: 'normal',
        fill_mode: 'forwards',
      };

      // properties JSON: propertiesDetailed（from/to値付き）を優先、なければstring[]からフォールバック
      const properties = pattern.propertiesDetailed
        ? pattern.propertiesDetailed.map((p) => ({
            property: p.property,
            from: p.from ?? '',
            to: p.to ?? '',
          }))
        : (pattern.properties ?? []).map((prop) => ({
            property: prop,
            from: '',
            to: '',
          }));

      // implementation JSON（rawCssを含む）
      const implementation: Record<string, unknown> = {};
      if (pattern.rawCss) {
        implementation.css = pattern.rawCss;
      }

      // accessibility JSON
      const accessibility: Record<string, unknown> = {
        respects_reduced_motion: pattern.accessibility?.respectsReducedMotion ?? false,
      };

      // performance JSON
      const performance: Record<string, unknown> = {
        level: pattern.performance?.level ?? 'acceptable',
        uses_transform: pattern.performance?.usesTransform ?? false,
        uses_opacity: pattern.performance?.usesOpacity ?? false,
      };

      return {
        id,
        webPageId,
        name: pattern.name,
        type: pattern.type,
        category: pattern.category,
        triggerType: pattern.trigger,
        triggerConfig: {},
        animation,
        properties,
        implementation,
        accessibility,
        performance,
        sourceUrl,
        usageScope: 'inspiration_only',
        tags: [],
        metadata: {},
      };
    });

    // 2. Atomic transaction: deleteMany + batched createMany
    // motion_patterns has 21 columns → max 3,120 records per query.
    // maxPatterns=4000 can exceed this, so batching is required.
    const totalCount = await prisma.$transaction(async (tx) => {
      // Delete existing records (clean slate)
      // vision_detected は scroll-vision-persistence.service が管理するため除外
      await tx.motionPattern.deleteMany({
        where: { webPageId, type: { not: 'vision_detected' } },
      });

      if (isDevelopment()) {
        logger.debug('[WorkerDBSave] Existing motion patterns deleted', { webPageId });
      }

      // Batched createMany to stay under PostgreSQL 65,535 bind parameter limit
      let count = 0;
      for (let i = 0; i < data.length; i += PRISMA_CREATE_MANY_BATCH_SIZE) {
        const batch = data.slice(i, i + PRISMA_CREATE_MANY_BATCH_SIZE);
        const batchResult = await tx.motionPattern.createMany({ data: batch });
        count += batchResult.count;
      }
      return count;
    });

    if (isDevelopment()) {
      logger.info('[WorkerDBSave] Saved motion patterns', {
        webPageId,
        count: totalCount,
      });
    }

    return {
      success: true,
      count: totalCount,
      ids,
      idMapping,
    };
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : 'Failed to save motion patterns';

    if (isDevelopment()) {
      logger.error('[WorkerDBSave] Motion pattern save failed', {
        webPageId,
        error: errorMessage,
      });
    }

    return {
      success: false,
      count: 0,
      ids: [],
      idMapping: new Map(),
      error: errorMessage,
    };
  }
}

// =============================================================================
// QualityEvaluation Save
// =============================================================================

/** Current evaluator version identifier */
const EVALUATOR_VERSION = 'quality-evaluator-v0.1.0';

/**
 * QualityEvaluationをDBに保存
 *
 * @param prisma - Prismaクライアント
 * @param webPageId - WebPage ID (targetId)
 * @param qualityResult - 品質評価結果
 * @param options - 評価時のオプション（strict, targetIndustry, targetAudience）
 * @returns 保存結果
 */
export async function saveQualityEvaluation(
  prisma: QualityEvaluationPrismaClient,
  webPageId: string,
  qualityResult: QualityEvaluationInput,
  options?: QualityEvaluationSaveOptions
): Promise<SaveResult> {
  try {
    // 1. 既存レコードを削除（クリーンスレート）
    await prisma.qualityEvaluation.deleteMany({
      where: { targetType: 'web_page', targetId: webPageId },
    });

    if (isDevelopment()) {
      logger.debug('[WorkerDBSave] Existing quality evaluations deleted', { webPageId });
    }

    // 2. UUIDv7生成
    const id = uuidv7();

    // 3. antiAiCliche JSON構築
    const antiAiCliche: Record<string, unknown> = {
      axisScores: qualityResult.axisScores,
      clicheCount: qualityResult.clicheCount,
    };
    if (qualityResult.cliches) {
      antiAiCliche.cliches = qualityResult.cliches;
    }

    // 4. designQuality JSON構築
    const designQuality: Record<string, unknown> = {
      axisScores: qualityResult.axisScores,
    };
    if (qualityResult.axisGrades) {
      designQuality.axisGrades = qualityResult.axisGrades;
    }
    if (qualityResult.axisDetails) {
      designQuality.axisDetails = qualityResult.axisDetails;
    }

    // 5. recommendations 変換（オブジェクト配列 → 文字列配列）
    const recommendations = (qualityResult.recommendations ?? []).map(
      (rec) => `[${rec.priority}] ${rec.title}: ${rec.description}`
    );

    // 6. evaluationContext JSON構築
    const evaluationContext: Record<string, unknown> = {};
    if (options?.targetIndustry) {
      evaluationContext.target_industry = options.targetIndustry;
    }
    if (options?.targetAudience) {
      evaluationContext.target_audience = options.targetAudience;
    }

    // 7. DB保存
    await prisma.qualityEvaluation.create({
      data: {
        id,
        targetType: 'web_page',
        targetId: webPageId,
        overallScore: qualityResult.overallScore,
        grade: qualityResult.grade,
        antiAiCliche,
        designQuality,
        recommendations,
        evaluatorVersion: EVALUATOR_VERSION,
        evaluationMode: options?.strict ? 'strict' : 'standard',
        evaluationContext: Object.keys(evaluationContext).length > 0
          ? evaluationContext
          : undefined,
      },
    });

    if (isDevelopment()) {
      logger.info('[WorkerDBSave] Saved quality evaluation', {
        webPageId,
        overallScore: qualityResult.overallScore,
        grade: qualityResult.grade,
      });
    }

    return {
      success: true,
      count: 1,
      ids: [id],
      idMapping: new Map(), // QualityEvaluation は単一レコード保存のため常に空
    };
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : 'Failed to save quality evaluation';

    if (isDevelopment()) {
      logger.error('[WorkerDBSave] Quality evaluation save failed', {
        webPageId,
        error: errorMessage,
      });
    }

    return {
      success: false,
      count: 0,
      ids: [],
      idMapping: new Map(),
      error: errorMessage,
    };
  }
}

// =============================================================================
// QualityBenchmark Builder
// =============================================================================

/**
 * buildQualityBenchmarkInputs のオプション
 * exactOptionalPropertyTypes対応: undefinedを明示
 */
export interface BuildQualityBenchmarkOptions {
  targetIndustry?: string | undefined;
  targetAudience?: string | undefined;
}

/**
 * QualityServiceResult から QualityBenchmarkInput[] を生成
 *
 * ページ全体の品質評価結果をquality_benchmarksテーブル保存用の形式に変換する。
 * success=false または overallScore=0 の場合は空配列を返す（保存スキップ）。
 *
 * @param qualityResult - 品質評価サービスの結果
 * @param sourceUrl - 分析対象のURL
 * @param options - 業界/オーディエンス等の追加オプション
 * @returns QualityBenchmarkInput配列（通常1要素: full_page）
 */
export function buildQualityBenchmarkInputs(
  qualityResult: QualityServiceResult,
  sourceUrl: string,
  options?: BuildQualityBenchmarkOptions
): QualityBenchmarkInput[] {
  // 失敗結果やスコア0の場合はベンチマーク保存をスキップ
  if (!qualityResult.success || qualityResult.overallScore === 0) {
    return [];
  }

  // DB CHECK制約 (overall_score >= 85) に合致しないスコアはスキップ
  // quality_benchmarksは高品質サイトのみ保存する設計
  if (qualityResult.overallScore < 85) {
    return [];
  }

  // axisDetailsからcharacteristicsを生成（全軸の値をフラット化）
  const characteristics: string[] = [];
  if (qualityResult.axisDetails) {
    for (const values of Object.values(qualityResult.axisDetails)) {
      characteristics.push(...values);
    }
  }

  const benchmark: QualityBenchmarkInput = {
    sectionType: 'full_page',
    overallScore: qualityResult.overallScore,
    grade: qualityResult.grade,
    axisScores: {
      originality: qualityResult.axisScores.originality,
      craftsmanship: qualityResult.axisScores.craftsmanship,
      contextuality: qualityResult.axisScores.contextuality,
    },
    sourceUrl,
    sourceType: 'page_analyze',
    characteristics,
    industry: options?.targetIndustry,
    audience: options?.targetAudience,
  };

  return [benchmark];
}

// =============================================================================
// QualityBenchmark Save
// =============================================================================

/**
 * QualityBenchmarkをDBに保存
 *
 * ページ全体（web_page_id設定）とセクション単位（section_pattern_id設定）の
 * 両方の品質評価結果をquality_benchmarksテーブルに保存する。
 *
 * パターン: クリーンスレート（deleteMany → createMany）
 *
 * @param prisma - Prismaクライアント
 * @param webPageId - WebPage ID
 * @param benchmarks - 品質ベンチマーク入力データ配列
 * @returns 保存結果
 */
export async function saveQualityBenchmarks(
  prisma: QualityBenchmarkPrismaClient,
  webPageId: string,
  benchmarks: QualityBenchmarkInput[]
): Promise<SaveResult> {
  if (benchmarks.length === 0) {
    return { success: true, count: 0, ids: [], idMapping: new Map() };
  }

  try {
    // 1. 既存レコードを削除（クリーンスレート）
    await prisma.qualityBenchmark.deleteMany({
      where: { webPageId },
    });

    if (isDevelopment()) {
      logger.debug('[WorkerDBSave] Existing quality benchmarks deleted', { webPageId });
    }

    // 2. データ変換
    const ids: string[] = [];
    const data = benchmarks.map((benchmark) => {
      const id = uuidv7();
      ids.push(id);

      const record: Record<string, unknown> = {
        id,
        webPageId,
        sectionType: benchmark.sectionType,
        overallScore: benchmark.overallScore,
        grade: benchmark.grade,
        axisScores: benchmark.axisScores,
        characteristics: benchmark.characteristics ?? [],
        sourceUrl: benchmark.sourceUrl,
        sourceType: benchmark.sourceType,
        htmlSnippet: benchmark.htmlSnippet ?? null,
        previewUrl: benchmark.previewUrl ?? null,
        industry: benchmark.industry ?? null,
        audience: benchmark.audience ?? null,
      };

      // sectionPatternIdがある場合のみ設定（セクション単位のベンチマーク）
      if (benchmark.sectionPatternId !== undefined) {
        record.sectionPatternId = benchmark.sectionPatternId;
      }

      return record;
    });

    // 3. バッチインサート
    const result = await prisma.qualityBenchmark.createMany({ data });

    if (isDevelopment()) {
      logger.info('[WorkerDBSave] Saved quality benchmarks', {
        webPageId,
        count: result.count,
      });
    }

    return {
      success: true,
      count: result.count,
      ids,
      idMapping: new Map(), // QualityBenchmark はoriginal IDマッピング不要
    };
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : 'Failed to save quality benchmarks';

    if (isDevelopment()) {
      logger.error('[WorkerDBSave] Quality benchmark save failed', {
        webPageId,
        error: errorMessage,
      });
    }

    return {
      success: false,
      count: 0,
      ids: [],
      idMapping: new Map(),
      error: errorMessage,
    };
  }
}

// =============================================================================
// JSAnimationPattern Save
// =============================================================================

/**
 * CDPアニメーションタイプからJSAnimationLibrary enumにマッピング
 */
function mapCdpTypeToLibrary(cdpType: string): string {
  switch (cdpType) {
    case 'CSSAnimation':
    case 'CSSTransition':
      return 'web_animations_api';
    case 'WebAnimation':
      return 'web_animations_api';
    default:
      return 'unknown';
  }
}

/**
 * CDPアニメーションタイプからJSAnimationType enumにマッピング
 */
function mapCdpTypeToAnimationType(cdpType: string): string {
  switch (cdpType) {
    case 'CSSAnimation':
      return 'keyframe';
    case 'CSSTransition':
      return 'tween';
    case 'WebAnimation':
      return 'keyframe';
    default:
      return 'tween';
  }
}

/**
 * ライブラリ検出結果からメイン使用ライブラリを判定
 */
function detectMainLibrary(libraries: LibraryDetectionData): string {
  if (libraries.gsap.detected) return 'gsap';
  if (libraries.framerMotion.detected) return 'framer_motion';
  if (libraries.anime.detected) return 'anime_js';
  if (libraries.three.detected) return 'three_js';
  if (libraries.lottie.detected) return 'lottie';
  return 'unknown';
}

/**
 * CDPAnimationDataからDB保存用レコードを生成
 */
function cdpAnimationToRecord(
  anim: CDPAnimationData,
  webPageId: string,
  mainLibrary: string,
  sourceUrl: string
): { id: string; record: Record<string, unknown> } {
  const id = uuidv7();

  // libraryType: CDP検出タイプベースだが、ライブラリ検出結果で上書き可能
  const libraryType = mainLibrary !== 'unknown' ? mainLibrary : mapCdpTypeToLibrary(anim.type);

  const record: Record<string, unknown> = {
    id,
    webPageId,
    libraryType,
    libraryVersion: null,
    name: (anim.name || `CDP ${anim.type}`).slice(0, 200),
    animationType: mapCdpTypeToAnimationType(anim.type),
    description: null,
    targetSelector: null,
    targetCount: null,
    targetTagNames: [],
    durationMs: anim.source.duration > 0 ? Math.round(anim.source.duration) : null,
    delayMs: anim.source.delay > 0 ? Math.round(anim.source.delay) : null,
    easing: anim.source.easing?.slice(0, 100) || null,
    iterations: anim.source.iterations > 0 ? anim.source.iterations : null,
    direction: anim.source.direction?.slice(0, 20) || null,
    fillMode: null,
    keyframes: anim.source.keyframesRule?.keyframes ?? [],
    properties: [],
    triggerType: 'load',
    triggerConfig: {},
    cdpAnimationId: anim.id?.slice(0, 100) || null,
    cdpSourceType: anim.type?.slice(0, 50) || null,
    cdpPlayState: anim.playState?.slice(0, 20) || null,
    cdpCurrentTime: anim.currentTime,
    cdpStartTime: anim.startTime,
    cdpRawData: {},
    librarySpecificData: {},
    performance: {},
    accessibility: {},
    sourceUrl,
    usageScope: 'inspiration_only',
    tags: [],
    metadata: {},
    confidence: null,
  };

  return { id, record };
}

/**
 * WebAnimationDataからDB保存用レコードを生成
 */
function webAnimationToRecord(
  anim: WebAnimationData,
  webPageId: string,
  mainLibrary: string,
  sourceUrl: string
): { id: string; record: Record<string, unknown> } {
  const id = uuidv7();
  const libraryType = mainLibrary !== 'unknown' ? mainLibrary : 'web_animations_api';

  // キーフレームからプロパティ変化情報を抽出
  const properties: Array<{ property: string; from?: string; to?: string }> = [];
  if (anim.keyframes.length >= 2) {
    const first = anim.keyframes[0];
    const last = anim.keyframes[anim.keyframes.length - 1];
    if (first && last) {
      for (const key of Object.keys(first)) {
        if (['offset', 'easing', 'composite'].includes(key)) continue;
        const fromVal = first[key];
        const toVal = last[key];
        if (fromVal !== undefined && toVal !== undefined) {
          properties.push({
            property: key,
            from: String(fromVal),
            to: String(toVal),
          });
        }
      }
    }
  }

  const record: Record<string, unknown> = {
    id,
    webPageId,
    libraryType,
    libraryVersion: null,
    name: `WebAnimation on ${anim.target.slice(0, 100)}`,
    animationType: 'keyframe',
    description: null,
    targetSelector: anim.target.slice(0, 500),
    targetCount: 1,
    targetTagNames: [],
    durationMs: anim.timing.duration > 0 ? Math.round(anim.timing.duration) : null,
    delayMs: anim.timing.delay > 0 ? Math.round(anim.timing.delay) : null,
    easing: anim.timing.easing?.slice(0, 100) || null,
    iterations: anim.timing.iterations > 0 ? anim.timing.iterations : null,
    direction: anim.timing.direction?.slice(0, 20) || null,
    fillMode: anim.timing.fill?.slice(0, 20) || null,
    keyframes: anim.keyframes,
    properties,
    triggerType: 'load',
    triggerConfig: {},
    cdpAnimationId: null,
    cdpSourceType: null,
    cdpPlayState: anim.playState?.slice(0, 20) || null,
    cdpCurrentTime: null,
    cdpStartTime: null,
    cdpRawData: null,
    librarySpecificData: {},
    performance: {},
    accessibility: {},
    sourceUrl,
    usageScope: 'inspiration_only',
    tags: [],
    metadata: {},
    confidence: null,
  };

  return { id, record };
}

/**
 * JSAnimationPatternをDBに保存
 *
 * motion.detect結果のjs_animations（CDPアニメーション + Web Animations API）を
 * js_animation_patternsテーブルに保存する。
 *
 * パターン: クリーンスレート（deleteMany → createMany）
 *
 * @param prisma - Prismaクライアント
 * @param webPageId - WebPage ID
 * @param jsAnimations - JSアニメーション検出結果（JSAnimationFullResult）
 * @param sourceUrl - 元URL
 * @returns 保存結果
 */
export async function saveJsAnimationPatterns(
  prisma: JsAnimationPatternPrismaClient,
  webPageId: string,
  jsAnimations: JSAnimationFullResult,
  sourceUrl: string
): Promise<SaveResult> {
  const totalItems = jsAnimations.cdpAnimations.length + jsAnimations.webAnimations.length;

  if (totalItems === 0) {
    return { success: true, count: 0, ids: [], idMapping: new Map() };
  }

  try {
    // 1. メインライブラリを判定（ライブラリ検出結果から）
    const mainLibrary = detectMainLibrary(jsAnimations.libraries);

    // 2. データ変換（トランザクション外で実施）
    const ids: string[] = [];
    const idMapping = new Map<string, string>();
    const data: Record<string, unknown>[] = [];

    // CDP Animations
    for (const anim of jsAnimations.cdpAnimations) {
      const { id, record } = cdpAnimationToRecord(anim, webPageId, mainLibrary, sourceUrl);
      ids.push(id);
      idMapping.set(anim.id, id);
      data.push(record);
    }

    // Web Animations
    for (const anim of jsAnimations.webAnimations) {
      const { id, record } = webAnimationToRecord(anim, webPageId, mainLibrary, sourceUrl);
      ids.push(id);
      idMapping.set(anim.id, id);
      data.push(record);
    }

    // 3. Atomic transaction: deleteMany + batched createMany
    // js_animation_patterns has 37 columns → max 1,771 records per query.
    // Framer.com detected 1,866 JS animations → 69,042 params → exceeds 65,535 limit.
    const totalCount = await prisma.$transaction(async (tx) => {
      // Delete existing records (clean slate)
      await tx.jSAnimationPattern.deleteMany({
        where: { webPageId },
      });

      if (isDevelopment()) {
        logger.debug('[WorkerDBSave] Existing JS animation patterns deleted', { webPageId });
      }

      // Batched createMany to stay under PostgreSQL 65,535 bind parameter limit
      let count = 0;
      for (let i = 0; i < data.length; i += PRISMA_CREATE_MANY_BATCH_SIZE) {
        const batch = data.slice(i, i + PRISMA_CREATE_MANY_BATCH_SIZE);
        const batchResult = await tx.jSAnimationPattern.createMany({ data: batch });
        count += batchResult.count;
      }
      return count;
    });

    if (isDevelopment()) {
      logger.info('[WorkerDBSave] Saved JS animation patterns', {
        webPageId,
        count: totalCount,
        cdpCount: jsAnimations.cdpAnimations.length,
        webAnimCount: jsAnimations.webAnimations.length,
        mainLibrary,
      });
    }

    return {
      success: true,
      count: totalCount,
      ids,
      idMapping,
    };
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : 'Failed to save JS animation patterns';

    if (isDevelopment()) {
      logger.error('[WorkerDBSave] JS animation pattern save failed', {
        webPageId,
        error: errorMessage,
      });
    }

    return {
      success: false,
      count: 0,
      ids: [],
      idMapping: new Map(),
      error: errorMessage,
    };
  }
}
