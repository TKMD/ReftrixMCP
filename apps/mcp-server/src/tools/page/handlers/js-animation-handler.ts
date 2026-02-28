// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * JS Animation Handler for page.analyze
 * JSアニメーション検出（CDP + Web Animations API + ライブラリ検出）ロジックを分離
 *
 * - Chrome DevTools Protocol (CDP) Animation domain
 * - Web Animations API (document.getAnimations())
 * - ライブラリ検出 (GSAP, Framer Motion, anime.js, Three.js, Lottie)
 *
 * @module tools/page/handlers/js-animation-handler
 */

import type { Browser } from 'playwright';
import { logger, isDevelopment } from '../../../utils/logger';
import { getJSAnimationDetectorService } from '../../motion/di-factories';
import {
  createJSAnimationEmbeddingService,
  type JSAnimationPatternForEmbedding,
  type IEmbeddingService,
} from '../../../services/motion/js-animation-embedding.service';
import type {
  JSAnimationFullResult,
  JSAnimationSummaryResult,
  CDPAnimationData,
  WebAnimationData,
  LibraryDetectionData,
  JSAnimationPatternCreateData,
  JSAnimationLibraryType,
  JSAnimationTypeEnum,
  IPageAnalyzePrismaClient,
  ThreeJSDetailsData,
  ThreeJSLibrarySpecificData,
  ThreeJSSceneData,
} from './types';

// =====================================================
// JSON サイズ制限定数
// =====================================================

/** library_specific_data の最大サイズ（1MB） */
export const JSON_SIZE_LIMIT_BYTES = 1024 * 1024;

/** Three.js トランケート時の最大オブジェクト数（per scene） */
const THREEJS_MAX_OBJECTS_PER_SCENE = 20;

/** Three.js トランケート時の最大テクスチャ数 */
const THREEJS_MAX_TEXTURES = 10;

/** Three.js トランケート時の最大シーン数 */
const THREEJS_MAX_SCENES = 5;

/** Prisma createMany batch size to stay under PostgreSQL 65,535 bind-parameter limit */
export const PRISMA_CREATE_MANY_BATCH_SIZE = 1000;

// =====================================================
// JSON サイズバリデーション関数
// =====================================================

/**
 * JSON サイズバリデーション結果
 */
export interface JsonSizeValidationResult {
  /** バリデーション成功（1MB以下） */
  isValid: boolean;
  /** JSONサイズ（バイト） */
  sizeBytes: number;
  /** サイズ制限超過フラグ */
  exceedsLimit: boolean;
}

/**
 * library_specific_data のJSONサイズをバリデート
 *
 * @param data - バリデート対象のデータ
 * @returns バリデーション結果
 */
export function validateLibrarySpecificDataSize(data: unknown): JsonSizeValidationResult {
  const jsonStr = JSON.stringify(data);
  const sizeBytes = Buffer.byteLength(jsonStr, 'utf-8');
  const exceedsLimit = sizeBytes > JSON_SIZE_LIMIT_BYTES;

  return {
    isValid: !exceedsLimit,
    sizeBytes,
    exceedsLimit,
  };
}

/**
 * Three.js データトランケート結果
 */
export interface ThreeJSTruncateResult {
  /** トランケート後のデータ */
  data: ThreeJSDetailsData;
  /** トランケートが発生したか */
  truncated: boolean;
  /** トランケート理由 */
  truncationReason?: string;
}

/**
 * Three.js 詳細データをトランケート（1MB以下に収める）
 *
 * トランケート戦略:
 * 1. シーン内オブジェクト数を制限（最大20個/scene）
 * 2. テクスチャ配列を制限（最大10個）
 * 3. シーン数を制限（最大5個）
 *
 * @param details - トランケート対象のThree.js詳細データ
 * @returns トランケート結果
 */
export function truncateThreeJSData(details: ThreeJSDetailsData): ThreeJSTruncateResult {
  // 元データのサイズをチェック
  const originalSize = Buffer.byteLength(JSON.stringify(details), 'utf-8');

  // 1MB以下なら何もしない
  if (originalSize <= JSON_SIZE_LIMIT_BYTES) {
    return { data: details, truncated: false };
  }

  // トランケート実行
  const truncatedScenes: ThreeJSSceneData[] = details.scenes.slice(0, THREEJS_MAX_SCENES).map((scene) => ({
    ...scene,
    objects: scene.objects.slice(0, THREEJS_MAX_OBJECTS_PER_SCENE),
  }));

  const truncatedTextures = details.textures?.slice(0, THREEJS_MAX_TEXTURES);

  const truncatedDetails: ThreeJSDetailsData = {
    scenes: truncatedScenes,
    cameras: details.cameras.slice(0, THREEJS_MAX_SCENES),
    renderer: details.renderer,
    performance: details.performance,
    ...(details.version !== undefined && { version: details.version }),
    ...(truncatedTextures && { textures: truncatedTextures }),
  };

  // トランケート後のサイズ計算
  const truncatedSize = Buffer.byteLength(JSON.stringify(truncatedDetails), 'utf-8');

  const originalObjectCount = details.scenes.reduce((sum, s) => sum + s.objects.length, 0);
  const truncatedObjectCount = truncatedScenes.reduce((sum, s) => sum + s.objects.length, 0);

  const truncationReason = `Size reduced from ${Math.round(originalSize / 1024)}KB to ${Math.round(truncatedSize / 1024)}KB. ` +
    `Objects: ${originalObjectCount} -> ${truncatedObjectCount}. ` +
    `Scenes: ${details.scenes.length} -> ${truncatedScenes.length}.`;

  if (isDevelopment()) {
    logger.debug('[js-animation-handler] Three.js data truncated', {
      originalSize,
      truncatedSize,
      originalObjectCount,
      truncatedObjectCount,
    });
  }

  return {
    data: truncatedDetails,
    truncated: true,
    truncationReason,
  };
}

/**
 * Three.js 詳細情報から ThreeJSLibrarySpecificData を構築
 *
 * @param details - Three.js詳細データ（undefinedの場合はシンプル構造を返す）
 * @param sceneCount - WebGLシーン数
 * @returns library_specific_data用の構造
 */
export function buildThreeJSLibrarySpecificData(
  details: ThreeJSDetailsData | undefined,
  sceneCount: number
): { scenes?: number; three_js?: ThreeJSLibrarySpecificData['three_js'] } {
  // 詳細情報がない場合はシンプルな構造を返す
  if (!details) {
    return { scenes: sceneCount };
  }

  // トランケートが必要か判定して実行
  const { data: finalDetails, truncated, truncationReason } = truncateThreeJSData(details);

  const extractionLevel: 'basic' | 'detailed' = truncated ? 'basic' : 'detailed';

  // ThreeJSLibrarySpecificData構造を構築
  const result: ThreeJSLibrarySpecificData = {
    scenes: sceneCount,
    three_js: {
      scenes: finalDetails.scenes,
      cameras: finalDetails.cameras,
      renderer: finalDetails.renderer,
      extractedAt: new Date().toISOString(),
      extractionLevel,
      ...(finalDetails.version !== undefined && { version: finalDetails.version }),
      ...(finalDetails.performance !== undefined && { performance: finalDetails.performance }),
      ...(truncated && { truncated: true, truncationReason }),
    },
  };

  // 最終サイズチェック
  const finalValidation = validateLibrarySpecificDataSize(result);
  if (isDevelopment()) {
    logger.debug('[js-animation-handler] Three.js library_specific_data built', {
      sizeBytes: finalValidation.sizeBytes,
      extractionLevel,
      truncated,
    });
  }

  return result;
}

// =====================================================
// 型定義
// =====================================================

/**
 * JSアニメーションオプション（page.analyze用）
 */
export interface JSAnimationOptions {
  enableCDP?: boolean | undefined;
  enableWebAnimations?: boolean | undefined;
  enableLibraryDetection?: boolean | undefined;
  waitTime?: number | undefined;
  /** DB保存を有効にするか（デフォルト: true） */
  saveToDb?: boolean | undefined;
  /** Embedding生成を有効にするか（デフォルト: true、saveToDb=trueの場合のみ有効） */
  generateEmbedding?: boolean | undefined;
  /** 外部から注入するEmbeddingService（テスト用） */
  embeddingService?: IEmbeddingService | undefined;
}

/**
 * JSアニメーション実行結果
 */
export interface JSAnimationModeResult {
  js_animation_summary?: JSAnimationSummaryResult;
  js_animations?: JSAnimationFullResult;
  js_animation_error?: {
    code: string;
    message: string;
  };
  /** DB保存されたパターン数 */
  savedPatternCount?: number;
  /** Embedding生成されたパターン数 */
  embeddingCount?: number;
  /** Embedding生成エラー（発生した場合） */
  embedding_error?: {
    code: string;
    message: string;
  };
}

// =====================================================
// デフォルト値
// =====================================================

/** JSアニメーション検出デフォルト設定 */
const JS_ANIMATION_DEFAULTS = {
  ENABLE_CDP: true,
  ENABLE_WEB_ANIMATIONS: true,
  ENABLE_LIBRARY_DETECTION: true,
  WAIT_TIME: 1000, // 1秒待機（アニメーション発火を待つ）
  VIEWPORT_WIDTH: 1280,
  VIEWPORT_HEIGHT: 720,
  TIMEOUT: 30000, // 30秒タイムアウト
  SAVE_TO_DB: true, // デフォルトでDB保存を有効
  GENERATE_EMBEDDING: true, // デフォルトでEmbedding生成を有効
} as const;

// =====================================================
// マッピング関数（検出結果 -> JSAnimationPatternCreateData）
// =====================================================

/**
 * CDPアニメーションタイプをJSAnimationTypeにマッピング
 */
function mapCDPTypeToAnimationType(cdpType: string): JSAnimationTypeEnum {
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
 * CDPアニメーションをJSAnimationPatternCreateDataにマッピング
 */
export function mapCDPAnimationToPattern(
  cdpAnim: CDPAnimationData,
  webPageId?: string,
  sourceUrl?: string
): JSAnimationPatternCreateData {
  const libraryType: JSAnimationLibraryType =
    cdpAnim.type === 'WebAnimation' ? 'web_animations_api' : 'unknown';

  return {
    webPageId: webPageId ?? null,
    libraryType,
    name: cdpAnim.name || `cdp-animation-${cdpAnim.id}`,
    animationType: mapCDPTypeToAnimationType(cdpAnim.type),
    durationMs: cdpAnim.source.duration > 0 ? Math.round(cdpAnim.source.duration) : null,
    delayMs: cdpAnim.source.delay > 0 ? Math.round(cdpAnim.source.delay) : null,
    easing: cdpAnim.source.easing || null,
    iterations: cdpAnim.source.iterations === Infinity ? -1 : cdpAnim.source.iterations,
    direction: cdpAnim.source.direction || null,
    keyframes: cdpAnim.source.keyframesRule?.keyframes ?? [],
    properties: [],
    cdpAnimationId: cdpAnim.id,
    cdpSourceType: cdpAnim.type,
    cdpPlayState: cdpAnim.playState,
    cdpCurrentTime: cdpAnim.currentTime,
    cdpStartTime: cdpAnim.startTime,
    cdpRawData: {
      pausedState: cdpAnim.pausedState,
      playbackRate: cdpAnim.playbackRate,
      source: cdpAnim.source,
    },
    sourceUrl: sourceUrl ?? null,
    usageScope: 'inspiration_only',
    confidence: 0.9,
  };
}

/**
 * Web AnimationをJSAnimationPatternCreateDataにマッピング
 */
export function mapWebAnimationToPattern(
  webAnim: WebAnimationData,
  webPageId?: string,
  sourceUrl?: string
): JSAnimationPatternCreateData {
  // キーフレームからプロパティを抽出
  const properties = webAnim.keyframes
    .flatMap((kf) =>
      Object.keys(kf).filter(
        (k) => !['offset', 'easing', 'composite'].includes(k)
      )
    )
    .filter((v, i, a) => a.indexOf(v) === i);

  return {
    webPageId: webPageId ?? null,
    libraryType: 'web_animations_api',
    name: webAnim.id || `web-animation-${Date.now()}`,
    animationType: 'keyframe',
    targetSelector: webAnim.target || null,
    durationMs: webAnim.timing.duration > 0 ? Math.round(webAnim.timing.duration) : null,
    delayMs: webAnim.timing.delay > 0 ? Math.round(webAnim.timing.delay) : null,
    easing: webAnim.timing.easing || null,
    iterations: webAnim.timing.iterations === -1 ? -1 : webAnim.timing.iterations,
    direction: webAnim.timing.direction || null,
    fillMode: webAnim.timing.fill || null,
    keyframes: webAnim.keyframes,
    properties,
    cdpPlayState: webAnim.playState,
    sourceUrl: sourceUrl ?? null,
    usageScope: 'inspiration_only',
    confidence: 0.95,
  };
}

/**
 * ライブラリ検出結果をJSAnimationPatternCreateDataの配列にマッピング
 */
export function mapLibraryDetectionToPatterns(
  libraries: LibraryDetectionData,
  webPageId?: string,
  sourceUrl?: string
): JSAnimationPatternCreateData[] {
  const patterns: JSAnimationPatternCreateData[] = [];

  // GSAP
  if (libraries.gsap.detected) {
    patterns.push({
      webPageId: webPageId ?? null,
      libraryType: 'gsap',
      libraryVersion: libraries.gsap.version ?? null,
      name: 'GSAP Library Detection',
      animationType: 'timeline',
      description: `GSAP detected with ${libraries.gsap.tweens ?? 0} active tweens`,
      properties: [],
      librarySpecificData: {
        tweens: libraries.gsap.tweens,
        version: libraries.gsap.version,
      },
      sourceUrl: sourceUrl ?? null,
      usageScope: 'inspiration_only',
      confidence: 0.85,
    });
  }

  // Framer Motion
  if (libraries.framerMotion.detected) {
    patterns.push({
      webPageId: webPageId ?? null,
      libraryType: 'framer_motion',
      name: 'Framer Motion Library Detection',
      animationType: 'spring',
      description: `Framer Motion detected with ${libraries.framerMotion.elements ?? 0} animated elements`,
      properties: [],
      librarySpecificData: {
        elements: libraries.framerMotion.elements,
      },
      sourceUrl: sourceUrl ?? null,
      usageScope: 'inspiration_only',
      confidence: 0.8,
    });
  }

  // anime.js
  if (libraries.anime.detected) {
    patterns.push({
      webPageId: webPageId ?? null,
      libraryType: 'anime_js',
      name: 'anime.js Library Detection',
      animationType: 'tween',
      description: `anime.js detected with ${libraries.anime.instances ?? 0} active instances`,
      properties: [],
      librarySpecificData: {
        instances: libraries.anime.instances,
      },
      sourceUrl: sourceUrl ?? null,
      usageScope: 'inspiration_only',
      confidence: 0.85,
    });
  }

  // Three.js
  if (libraries.three.detected) {
    // Three.js詳細情報がある場合はより詳細な説明を生成
    const details = libraries.three.details;
    const hasDetails = details !== undefined;
    const sceneCount = libraries.three.scenes ?? 0;
    const description = hasDetails && details.version
      ? `Three.js ${details.version} detected with ${sceneCount} WebGL scenes`
      : `Three.js detected with ${sceneCount} WebGL scenes`;

    // 詳細情報をlibrary_specific_dataに含める（1MB制限対応、自動トランケート）
    const librarySpecificData = buildThreeJSLibrarySpecificData(details, sceneCount);

    patterns.push({
      webPageId: webPageId ?? null,
      libraryType: 'three_js',
      name: 'Three.js Library Detection',
      animationType: 'physics',
      description,
      properties: [],
      librarySpecificData,
      sourceUrl: sourceUrl ?? null,
      usageScope: 'inspiration_only',
      // 詳細情報がある場合は信頼度を上げる
      confidence: hasDetails ? 0.85 : 0.75,
    });
  }

  // Lottie
  if (libraries.lottie.detected) {
    patterns.push({
      webPageId: webPageId ?? null,
      libraryType: 'lottie',
      name: 'Lottie Library Detection',
      animationType: 'morphing',
      description: `Lottie detected with ${libraries.lottie.animations ?? 0} animations`,
      properties: [],
      librarySpecificData: {
        animations: libraries.lottie.animations,
      },
      sourceUrl: sourceUrl ?? null,
      usageScope: 'inspiration_only',
      confidence: 0.9,
    });
  }

  return patterns;
}

/**
 * JSAnimationFullResultをJSAnimationPatternCreateDataの配列にマッピング
 */
export function mapJSAnimationResultToPatterns(
  result: JSAnimationFullResult,
  webPageId?: string,
  sourceUrl?: string
): JSAnimationPatternCreateData[] {
  const patterns: JSAnimationPatternCreateData[] = [];

  // CDPアニメーションをマッピング
  for (const cdpAnim of result.cdpAnimations) {
    patterns.push(mapCDPAnimationToPattern(cdpAnim, webPageId, sourceUrl));
  }

  // Web Animationsをマッピング
  for (const webAnim of result.webAnimations) {
    patterns.push(mapWebAnimationToPattern(webAnim, webPageId, sourceUrl));
  }

  // ライブラリ検出をマッピング
  const libraryPatterns = mapLibraryDetectionToPatterns(result.libraries, webPageId, sourceUrl);
  patterns.push(...libraryPatterns);

  return patterns;
}

/**
 * VARCHAR制限に合わせて文字列フィールドをトランケート
 *
 * @param pattern - トランケート対象のパターンデータ
 * @returns トランケート済みのパターンデータ
 */
export function truncatePatternVarcharFields(
  pattern: JSAnimationPatternCreateData
): JSAnimationPatternCreateData {
  return {
    ...pattern,
    name: pattern.name?.slice(0, 200) ?? pattern.name,
    libraryVersion: pattern.libraryVersion?.slice(0, 50) ?? pattern.libraryVersion,
    targetSelector: pattern.targetSelector?.slice(0, 500) ?? pattern.targetSelector,
    easing: pattern.easing?.slice(0, 100) ?? pattern.easing,
    direction: pattern.direction?.slice(0, 20) ?? pattern.direction,
    fillMode: pattern.fillMode?.slice(0, 20) ?? pattern.fillMode,
    triggerType: pattern.triggerType?.slice(0, 50) ?? pattern.triggerType,
    cdpAnimationId: pattern.cdpAnimationId?.slice(0, 100) ?? pattern.cdpAnimationId,
    cdpSourceType: pattern.cdpSourceType?.slice(0, 50) ?? pattern.cdpSourceType,
    cdpPlayState: pattern.cdpPlayState?.slice(0, 20) ?? pattern.cdpPlayState,
  };
}

/**
 * JSアニメーションパターンをDBに保存
 *
 * @param prisma - Prismaクライアント
 * @param patterns - 保存するパターン配列
 * @param webPageId - WebPage ID（オプション）
 * @returns 保存されたパターン数
 */
export async function saveJSAnimationPatterns(
  prisma: IPageAnalyzePrismaClient,
  patterns: JSAnimationPatternCreateData[],
  webPageId?: string
): Promise<number> {
  if (patterns.length === 0) {
    if (isDevelopment()) {
      logger.debug('[js-animation-handler] No patterns to save, skipping DB save');
    }
    return 0;
  }

  // Truncate VARCHAR fields to match DB column limits
  const truncatedPatterns = patterns.map(truncatePatternVarcharFields);

  try {
    const totalCount = await prisma.$transaction(async (tx) => {
      // Delete existing patterns for this webPageId (atomic with create)
      if (webPageId) {
        await tx.jSAnimationPattern.deleteMany({
          where: { webPageId },
        });
      }

      // Batch createMany to stay under PostgreSQL 65,535 parameter limit
      let count = 0;
      for (let i = 0; i < truncatedPatterns.length; i += PRISMA_CREATE_MANY_BATCH_SIZE) {
        const batch = truncatedPatterns.slice(i, i + PRISMA_CREATE_MANY_BATCH_SIZE);
        const batchResult = await tx.jSAnimationPattern.createMany({
          data: batch,
          skipDuplicates: true,
        });
        count += batchResult.count;
      }
      return count;
    });

    if (isDevelopment()) {
      logger.info('[js-animation-handler] Saved JS animation patterns to DB', {
        savedCount: totalCount,
        totalPatterns: patterns.length,
        batches: Math.ceil(patterns.length / PRISMA_CREATE_MANY_BATCH_SIZE),
        webPageId,
      });
    }

    return totalCount;
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[js-animation-handler] Failed to save JS animation patterns', { error });
    }
    throw error;
  }
}

/**
 * JSAnimationPatternCreateDataをJSAnimationPatternForEmbeddingに変換
 * Embedding生成に必要なフィールドのみを抽出
 */
function convertToEmbeddingFormat(
  pattern: JSAnimationPatternCreateData,
  patternId: string
): JSAnimationPatternForEmbedding {
  return {
    id: patternId,
    libraryType: pattern.libraryType,
    libraryVersion: pattern.libraryVersion ?? null,
    name: pattern.name,
    animationType: pattern.animationType,
    description: pattern.description ?? null,
    targetSelector: pattern.targetSelector ?? null,
    targetCount: pattern.targetCount ?? null,
    targetTagNames: pattern.targetTagNames ?? [],
    durationMs: pattern.durationMs ?? null,
    delayMs: pattern.delayMs ?? null,
    easing: pattern.easing ?? null,
    iterations: pattern.iterations ?? null,
    direction: pattern.direction ?? null,
    fillMode: pattern.fillMode ?? null,
    keyframes: pattern.keyframes,
    properties: pattern.properties,
    triggerType: pattern.triggerType ?? null,
    triggerConfig: pattern.triggerConfig,
    confidence: pattern.confidence ?? null,
  };
}

/**
 * JSアニメーションパターンのEmbeddingを生成してDBに保存
 *
 * @param prisma - Prismaクライアント
 * @param patterns - パターン配列（ID付き）
 * @param embeddingService - Embedding生成サービス（オプション）
 * @returns 生成されたEmbedding数
 */
export async function saveJSAnimationEmbeddings(
  prisma: IPageAnalyzePrismaClient,
  patterns: Array<{ pattern: JSAnimationPatternCreateData; id: string }>,
  embeddingService?: IEmbeddingService
): Promise<number> {
  if (patterns.length === 0) {
    if (isDevelopment()) {
      logger.debug('[js-animation-handler] No patterns for embedding generation');
    }
    return 0;
  }

  const startTime = Date.now();

  try {
    // EmbeddingService を作成
    const serviceOptions = embeddingService
      ? { embeddingService }
      : undefined;

    const service = createJSAnimationEmbeddingService(serviceOptions);

    // Embedding用にパターンを変換
    const embeddingPatterns: JSAnimationPatternForEmbedding[] = patterns.map(
      ({ pattern, id }) => convertToEmbeddingFormat(pattern, id)
    );

    // バッチでEmbedding生成
    const embeddingResults = await service.generateBatchEmbeddings(embeddingPatterns);

    // DBに保存（upsert）
    let savedCount = 0;
    for (let i = 0; i < embeddingResults.length; i++) {
      const embeddingResult = embeddingResults[i];
      const patternId = patterns[i]?.id;

      if (!patternId || !embeddingResult) {
        continue;
      }

      try {
        // Embedding を pgvector 形式で保存
        const embeddingVector = `[${embeddingResult.embedding.join(',')}]`;

        await prisma.$executeRawUnsafe(
          `INSERT INTO js_animation_embeddings (id, js_animation_pattern_id, embedding, text_representation, model_version, embedding_timestamp, updated_at)
           VALUES (gen_random_uuid(), $1, $2::vector, $3, $4, NOW(), NOW())
           ON CONFLICT (js_animation_pattern_id)
           DO UPDATE SET embedding = $2::vector, text_representation = $3, model_version = $4, embedding_timestamp = NOW(), updated_at = NOW()`,
          patternId,
          embeddingVector,
          embeddingResult.textRepresentation,
          embeddingResult.modelVersion
        );
        savedCount++;
      } catch (upsertError) {
        if (isDevelopment()) {
          logger.warn('[js-animation-handler] Failed to save embedding for pattern', {
            patternId,
            error: upsertError instanceof Error ? upsertError.message : 'Unknown error',
          });
        }
        // 個別のエラーは無視して続行
      }
    }

    if (isDevelopment()) {
      logger.info('[js-animation-handler] Saved JS animation embeddings to DB', {
        savedCount,
        totalPatterns: patterns.length,
        processingTimeMs: Date.now() - startTime,
      });
    }

    return savedCount;
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[js-animation-handler] Failed to generate/save embeddings', { error });
    }
    throw error;
  }
}

/**
 * JSアニメーションパターンをDBに保存し、Embeddingも生成・保存
 *
 * @param prisma - Prismaクライアント
 * @param patterns - 保存するパターン配列
 * @param webPageId - WebPage ID（オプション）
 * @param options - オプション（Embedding生成設定）
 * @returns 保存結果
 */
export async function saveJSAnimationPatternsWithEmbeddings(
  prisma: IPageAnalyzePrismaClient,
  patterns: JSAnimationPatternCreateData[],
  webPageId?: string,
  options?: { generateEmbedding?: boolean; embeddingService?: IEmbeddingService }
): Promise<{ savedPatternCount: number; embeddingCount: number }> {
  if (patterns.length === 0) {
    return { savedPatternCount: 0, embeddingCount: 0 };
  }

  // 1. まずパターンを保存
  const savedPatternCount = await saveJSAnimationPatterns(prisma, patterns, webPageId);

  // 2. Embedding生成が有効な場合
  const shouldGenerateEmbedding = options?.generateEmbedding ?? JS_ANIMATION_DEFAULTS.GENERATE_EMBEDDING;
  if (!shouldGenerateEmbedding || savedPatternCount === 0) {
    return { savedPatternCount, embeddingCount: 0 };
  }

  // 3. 保存されたパターンのIDを取得
  if (!webPageId) {
    if (isDevelopment()) {
      logger.debug('[js-animation-handler] No webPageId, skipping embedding generation');
    }
    return { savedPatternCount, embeddingCount: 0 };
  }

  try {
    // 保存されたパターンのIDを取得
    if (isDevelopment()) {
      logger.debug('[js-animation-handler] Finding saved patterns', {
        webPageId,
        inputPatternsCount: patterns.length,
      });
    }

    const savedPatterns = await prisma.jSAnimationPattern.findMany({
      where: { webPageId },
    });

    if (isDevelopment()) {
      logger.debug('[js-animation-handler] Found patterns', {
        savedPatternsCount: savedPatterns.length,
      });
    }

    // パターンとIDをマッピング（保存順と同じ順序と仮定）
    const patternsWithIds = patterns.slice(0, savedPatterns.length).map((pattern, index) => ({
      pattern,
      id: savedPatterns[index]?.id ?? '',
    })).filter(({ id }) => id !== '');

    // 4. Embedding生成と保存
    const embeddingCount = await saveJSAnimationEmbeddings(
      prisma,
      patternsWithIds,
      options?.embeddingService
    );

    if (isDevelopment()) {
      logger.debug('[js-animation-handler] Embedding save completed', {
        embeddingCount,
      });
    }

    return { savedPatternCount, embeddingCount };
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[js-animation-handler] Embedding generation error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    // パターン保存は成功しているのでエラーは投げない
    return { savedPatternCount, embeddingCount: 0 };
  }
}

// =====================================================
// Playwright環境チェック
// =====================================================

/** Playwright利用可否のキャッシュ */
let playwrightAvailabilityCache: boolean | null = null;

/**
 * Playwright環境の利用可否を確認
 *
 * @returns Playwrightが利用可能な場合true
 */
export async function checkPlaywrightAvailability(): Promise<boolean> {
  // キャッシュがある場合はそれを返す
  if (playwrightAvailabilityCache !== null) {
    return playwrightAvailabilityCache;
  }

  try {
    // Playwrightモジュールの存在確認
    const playwright = await import('playwright');

    // chromiumが存在するか確認
    if (!playwright.chromium) {
      if (isDevelopment()) {
        logger.warn('[js-animation-handler] Playwright chromium not found');
      }
      playwrightAvailabilityCache = false;
      return false;
    }

    playwrightAvailabilityCache = true;
    return true;
  } catch (error) {
    if (isDevelopment()) {
      logger.warn('[js-animation-handler] Playwright not available', {
        error: error instanceof Error ? error.message : 'Unknown error',
        hint: 'Run "pnpm exec playwright install chromium" to install Playwright',
      });
    }
    playwrightAvailabilityCache = false;
    return false;
  }
}

/**
 * Playwright利用可否キャッシュをリセット（テスト用）
 */
export function resetPlaywrightAvailabilityCache(): void {
  playwrightAvailabilityCache = null;
}

// =====================================================
// メイン処理関数
// =====================================================

/**
 * JSアニメーション検出コンテキスト
 * DB保存に必要なPrismaクライアントとWebPage IDを保持
 */
export interface JSAnimationContext {
  /** Prismaクライアント（DB保存時に必要） */
  prisma?: IPageAnalyzePrismaClient;
  /** WebPage ID（DB保存時に使用） */
  webPageId?: string;
  /** ソースURL（パターン保存時に使用） */
  sourceUrl?: string;
}

/**
 * JSアニメーション検出を実行
 *
 * @param url - 対象URL
 * @param enabled - JS検出を有効にするか（デフォルト: true）
 * @param options - JSアニメーションオプション
 * @param dbContext - DB保存コンテキスト（prisma, webPageId）
 * @returns JSアニメーション検出結果
 */
export async function executeJSAnimationMode(
  url: string,
  enabled?: boolean,
  options?: JSAnimationOptions,
  dbContext?: JSAnimationContext,
  sharedBrowser?: Browser
): Promise<JSAnimationModeResult> {
  const result: JSAnimationModeResult = {};

  // detect_js_animations がundefinedの場合はtrueとして扱う（v0.1.0: デフォルト有効）
  // Playwrightが必要で処理に30秒以上かかるが、asyncモードで長時間検出可能
  const enableJSAnimation = enabled ?? true;

  if (!enableJSAnimation) {
    if (isDevelopment()) {
      logger.info('[js-animation-handler] JS animation detection disabled, skipping');
    }
    return result;
  }

  if (!url) {
    if (isDevelopment()) {
      logger.warn('[js-animation-handler] URL is required for JS animation detection');
    }
    return {
      js_animation_error: {
        code: 'JS_ANIMATION_URL_REQUIRED',
        message: 'URL is required for JS animation detection',
      },
    };
  }

  if (isDevelopment()) {
    logger.info('[js-animation-handler] Starting JS animation detection', {
      url,
      enableCDP: options?.enableCDP ?? JS_ANIMATION_DEFAULTS.ENABLE_CDP,
      enableWebAnimations: options?.enableWebAnimations ?? JS_ANIMATION_DEFAULTS.ENABLE_WEB_ANIMATIONS,
      enableLibraryDetection: options?.enableLibraryDetection ?? JS_ANIMATION_DEFAULTS.ENABLE_LIBRARY_DETECTION,
      waitTime: options?.waitTime ?? JS_ANIMATION_DEFAULTS.WAIT_TIME,
    });
  }

  const startTime = Date.now();
  let browser: Browser | null = null;
  const usingSharedBrowser = !!sharedBrowser;

  try {
    // 共有ブラウザが提供されている場合はそれを使用、なければ新規起動
    if (sharedBrowser) {
      browser = sharedBrowser;
      if (isDevelopment()) {
        logger.info('[js-animation-handler] Using shared browser instance', { url });
      }
    } else {
      // Playwright動的インポート
      const { chromium } = await import('playwright');

      // ブラウザ起動
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
        ],
      });
    }

    // コンテキストとページ作成
    const context = await browser.newContext({
      viewport: {
        width: JS_ANIMATION_DEFAULTS.VIEWPORT_WIDTH,
        height: JS_ANIMATION_DEFAULTS.VIEWPORT_HEIGHT,
      },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // ページ遷移（WebGL/3Dサイト対応: domcontentloadedで待機）
    // 'load'イベントはWebGL/3Dサイトで非常に時間がかかるため'domcontentloaded'を使用
    // JSアニメーション検出はDOM構築後に実行可能なため、load待機は不要
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: JS_ANIMATION_DEFAULTS.TIMEOUT,
    });

    // ページ読み込み完了後の待機（アニメーション発火を待つ）
    await page.waitForTimeout(500);

    // JSAnimationDetectorServiceを取得して検出実行
    const detector = getJSAnimationDetectorService();
    const detectionResult = await detector.detect(page, {
      enableCDP: options?.enableCDP ?? JS_ANIMATION_DEFAULTS.ENABLE_CDP,
      enableWebAnimations: options?.enableWebAnimations ?? JS_ANIMATION_DEFAULTS.ENABLE_WEB_ANIMATIONS,
      enableLibraryDetection: options?.enableLibraryDetection ?? JS_ANIMATION_DEFAULTS.ENABLE_LIBRARY_DETECTION,
      waitTime: options?.waitTime ?? JS_ANIMATION_DEFAULTS.WAIT_TIME,
    });

    // 検出サービスのクリーンアップ（ブラウザクリーンアップはfinallyで行う）
    await detector.cleanup();

    // 検出されたライブラリのリスト作成
    const detectedLibraries: string[] = [];
    if (detectionResult.libraries.gsap.detected) detectedLibraries.push('gsap');
    if (detectionResult.libraries.framerMotion.detected) detectedLibraries.push('framer-motion');
    if (detectionResult.libraries.anime.detected) detectedLibraries.push('anime.js');
    if (detectionResult.libraries.three.detected) detectedLibraries.push('three.js');
    if (detectionResult.libraries.lottie.detected) detectedLibraries.push('lottie');

    // サマリー結果
    const summary: JSAnimationSummaryResult = {
      cdpAnimationCount: detectionResult.cdpAnimations.length,
      webAnimationCount: detectionResult.webAnimations.length,
      detectedLibraries,
      totalDetected: detectionResult.totalDetected,
      detectionTimeMs: detectionResult.detectionTimeMs,
    };
    result.js_animation_summary = summary;

    // フル結果（変換）
    const fullResult: JSAnimationFullResult = {
      cdpAnimations: detectionResult.cdpAnimations.map((anim) => ({
        id: anim.id,
        name: anim.name,
        pausedState: anim.pausedState,
        playState: anim.playState,
        playbackRate: anim.playbackRate,
        startTime: anim.startTime,
        currentTime: anim.currentTime,
        type: anim.type,
        source: {
          duration: anim.source.duration,
          delay: anim.source.delay,
          iterations: anim.source.iterations,
          direction: anim.source.direction,
          easing: anim.source.easing,
          ...(anim.source.keyframesRule !== undefined && {
            keyframesRule: anim.source.keyframesRule,
          }),
        },
      })),
      webAnimations: detectionResult.webAnimations.map((anim) => ({
        id: anim.id,
        playState: anim.playState,
        target: anim.target,
        timing: {
          duration: anim.timing.duration,
          delay: anim.timing.delay,
          iterations: anim.timing.iterations,
          direction: anim.timing.direction,
          easing: anim.timing.easing,
          fill: anim.timing.fill,
        },
        keyframes: anim.keyframes,
      })),
      libraries: {
        gsap: {
          detected: detectionResult.libraries.gsap.detected,
          ...(detectionResult.libraries.gsap.version !== undefined && {
            version: detectionResult.libraries.gsap.version,
          }),
          ...(detectionResult.libraries.gsap.tweens !== undefined && {
            tweens: detectionResult.libraries.gsap.tweens,
          }),
        },
        framerMotion: {
          detected: detectionResult.libraries.framerMotion.detected,
          ...(detectionResult.libraries.framerMotion.elements !== undefined && {
            elements: detectionResult.libraries.framerMotion.elements,
          }),
        },
        anime: {
          detected: detectionResult.libraries.anime.detected,
          ...(detectionResult.libraries.anime.instances !== undefined && {
            instances: detectionResult.libraries.anime.instances,
          }),
        },
        three: {
          detected: detectionResult.libraries.three.detected,
          ...(detectionResult.libraries.three.scenes !== undefined && {
            scenes: detectionResult.libraries.three.scenes,
          }),
        },
        lottie: {
          detected: detectionResult.libraries.lottie.detected,
          ...(detectionResult.libraries.lottie.animations !== undefined && {
            animations: detectionResult.libraries.lottie.animations,
          }),
        },
      },
      detectionTimeMs: detectionResult.detectionTimeMs,
      totalDetected: detectionResult.totalDetected,
    };
    result.js_animations = fullResult;

    // DB保存処理（Embedding生成含む）
    const shouldSaveToDb = options?.saveToDb ?? JS_ANIMATION_DEFAULTS.SAVE_TO_DB;
    const shouldGenerateEmbedding = options?.generateEmbedding ?? JS_ANIMATION_DEFAULTS.GENERATE_EMBEDDING;

    if (shouldSaveToDb && dbContext?.prisma) {
      try {
        const patterns = mapJSAnimationResultToPatterns(
          fullResult,
          dbContext.webPageId,
          dbContext.sourceUrl ?? url
        );

        // パターン保存 + Embedding生成
        const embeddingOptions: { generateEmbedding?: boolean; embeddingService?: IEmbeddingService } = {
          generateEmbedding: shouldGenerateEmbedding,
        };
        if (options?.embeddingService) {
          embeddingOptions.embeddingService = options.embeddingService;
        }
        const saveResult = await saveJSAnimationPatternsWithEmbeddings(
          dbContext.prisma,
          patterns,
          dbContext.webPageId,
          embeddingOptions
        );

        result.savedPatternCount = saveResult.savedPatternCount;
        result.embeddingCount = saveResult.embeddingCount;

        if (isDevelopment()) {
          logger.info('[js-animation-handler] JS animation patterns and embeddings saved to DB', {
            savedPatternCount: saveResult.savedPatternCount,
            embeddingCount: saveResult.embeddingCount,
            patternCount: patterns.length,
            webPageId: dbContext.webPageId,
          });
        }
      } catch (dbError) {
        // DB保存エラーは検出結果には影響させない（警告のみ）
        if (isDevelopment()) {
          logger.warn('[js-animation-handler] Failed to save patterns to DB, continuing', {
            error: dbError instanceof Error ? dbError.message : 'Unknown error',
          });
        }
        result.embedding_error = {
          code: 'DB_SAVE_ERROR',
          message: dbError instanceof Error ? dbError.message : 'Failed to save to DB',
        };
      }
    } else if (shouldSaveToDb && !dbContext?.prisma) {
      // saveToDb=trueだがprismaがない場合は警告
      if (isDevelopment()) {
        logger.debug('[js-animation-handler] saveToDb enabled but no prisma context, skipping DB save');
      }
    }

    if (isDevelopment()) {
      logger.info('[js-animation-handler] JS animation detection completed', {
        cdpAnimationCount: summary.cdpAnimationCount,
        webAnimationCount: summary.webAnimationCount,
        detectedLibraries,
        totalDetected: summary.totalDetected,
        savedPatternCount: result.savedPatternCount,
        embeddingCount: result.embeddingCount,
        processingTimeMs: Date.now() - startTime,
      });
    }

    return result;
  } catch (error) {
    // エラー処理（ブラウザクリーンアップはfinallyで行う）
    const errorMessage = error instanceof Error ? error.message : 'JS animation detection failed';
    const processingTimeMs = Date.now() - startTime;

    // エラーの種類に応じたエラーコードを決定
    let errorCode = 'JS_ANIMATION_DETECTION_ERROR';
    let hint: string | undefined;

    if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
      errorCode = 'JS_ANIMATION_TIMEOUT';
      hint = 'Consider using motionOptions.js_animation_options.waitTime with a lower value, or set detect_js_animations: false for WebGL/3D sites';
    } else if (errorMessage.includes('net::ERR_') || errorMessage.includes('Navigation')) {
      errorCode = 'JS_ANIMATION_NETWORK_ERROR';
    } else if (errorMessage.includes('CDP') || errorMessage.includes('Protocol')) {
      errorCode = 'JS_ANIMATION_CDP_ERROR';
      hint = 'CDP connection failed. The page may have heavy JavaScript or WebGL content';
    } else if (errorMessage.includes('chromium') || errorMessage.includes('browser') || errorMessage.includes('Browser')) {
      errorCode = 'JS_ANIMATION_BROWSER_ERROR';
      hint = 'For WebGL/3D sites, consider using layoutOptions.disableWebGL: true or motionOptions.detect_js_animations: false';
    }

    // 開発環境では詳細なエラーログを出力
    if (isDevelopment()) {
      logger.error('[js-animation-handler] JS animation detection failed', {
        error,
        errorCode,
        url,
        processingTimeMs,
        options: {
          enableCDP: options?.enableCDP ?? JS_ANIMATION_DEFAULTS.ENABLE_CDP,
          enableWebAnimations: options?.enableWebAnimations ?? JS_ANIMATION_DEFAULTS.ENABLE_WEB_ANIMATIONS,
          enableLibraryDetection: options?.enableLibraryDetection ?? JS_ANIMATION_DEFAULTS.ENABLE_LIBRARY_DETECTION,
          waitTime: options?.waitTime ?? JS_ANIMATION_DEFAULTS.WAIT_TIME,
        },
        hint,
      });
    }

    // 本番環境でも重要なエラー情報を記録（console.errorを使用）
    // これにより運用時のトラブルシューティングが容易になる
    console.error(`[js-animation-handler] ${errorCode}: ${errorMessage}${hint ? ` (Hint: ${hint})` : ''}`);

    return {
      js_animation_error: {
        code: errorCode,
        message: hint ? `${errorMessage}. ${hint}` : errorMessage,
      },
    };
  } finally {
    // 共有ブラウザの場合はブラウザを閉じない（呼び出し元が管理）
    if (browser && !usingSharedBrowser) {
      await browser.close().catch(() => {});
    }
  }
}
