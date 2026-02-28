// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect CSSモード処理モジュール
 *
 * CSSモード（デフォルトモード）の処理ロジックを集約。
 * - 外部CSS取得
 * - CSS解析
 * - レスポンス最適化
 * - DB保存
 *
 * @module tools/motion/css-mode-handler
 */

import { logger, isDevelopment } from '../../utils/logger';
import {
  getCSSAnalysisCacheService,
  type MotionAnalysisResult,
} from '../../services/css-analysis-cache.service';
import type {
  MotionPattern,
  MotionWarning,
  MotionMetadata,
  MotionSummary,
  ExternalCssStats,
  MotionSaveResult,
  MotionDetectInput,
  MotionDetectOutput,
} from './schemas';
import {
  MOTION_MCP_ERROR_CODES,
  MOTION_WARNING_CODES,
  calculateComplexityScore,
  calculateAverageDuration,
  countByType,
  countByTrigger,
  countByCategory,
} from './schemas';
import {
  extractCssUrls,
  fetchAllCss,
  isSafeUrl,
} from '../../services/external-css-fetcher';
import {
  getMotionDetectServiceFactory,
  getPersistenceService,
  getPersistenceServiceFactoryExists,
  type DetectOptions,
  type DetectionResult,
} from './di-factories';
import { defaultDetect } from './detection-modes';

// =====================================================
// 外部CSS取得
// =====================================================

export interface ExternalCssFetchResult {
  externalCssContent: string;
  externalCssFetched: boolean;
  externalCssUrls: string[];
  externalCssStats?: ExternalCssStats;
  blockedUrls: string[];
  warnings: MotionWarning[];
}

/**
 * 外部CSSを取得
 */
export async function fetchExternalCss(
  html: string,
  baseUrl: string,
  options: {
    timeout?: number;
    maxConcurrent?: number;
  }
): Promise<ExternalCssFetchResult> {
  const fetchStartTime = Date.now();
  const externalCssUrls: string[] = [];
  const blockedUrls: string[] = [];
  const warnings: MotionWarning[] = [];
  let externalCssContent = '';

  try {
    // HTMLから<link>タグのURLを抽出
    const cssUrlResults = extractCssUrls(html, baseUrl);
    const allUrls = cssUrlResults.map((r) => r.url);

    // 安全なURLのみフィルタリング
    const safeUrls: string[] = [];
    for (const url of allUrls) {
      if (isSafeUrl(url)) {
        safeUrls.push(url);
        externalCssUrls.push(url);
      } else {
        blockedUrls.push(url);
        if (isDevelopment()) {
          logger.warn('[motion.detect] External CSS URL blocked by SSRF protection', { url });
        }
      }
    }

    // SSRFブロック警告
    if (blockedUrls.length > 0) {
      warnings.push({
        code: MOTION_WARNING_CODES.EXTERNAL_CSS_SSRF_BLOCKED,
        severity: 'warning',
        message: `${blockedUrls.length}個の外部CSSがセキュリティ上の理由でブロックされました`,
      });
    }

    let externalCssStats: ExternalCssStats | undefined;

    // 外部CSSを取得
    if (safeUrls.length > 0) {
      const fetchResults = await fetchAllCss(safeUrls, {
        timeout: options.timeout ?? 5000,
        maxConcurrent: options.maxConcurrent ?? 5,
      });

      let fetchedCount = 0;
      let errorCount = 0;
      let totalSize = 0;
      const errorMessages: string[] = [];

      for (const result of fetchResults) {
        if (result.content) {
          externalCssContent += result.content + '\n';
          fetchedCount++;
          totalSize += result.content.length;
        } else {
          errorCount++;
          if (result.error) {
            errorMessages.push(`${result.url}: ${result.error}`);
          }
          if (isDevelopment()) {
            logger.warn('[motion.detect] External CSS fetch failed', {
              url: result.url,
              error: result.error,
            });
          }
        }
      }

      // 取得失敗の警告
      if (errorCount > 0) {
        warnings.push({
          code: MOTION_WARNING_CODES.EXTERNAL_CSS_FETCH_FAILED,
          severity: 'warning',
          message: `${errorCount}個の外部CSSの取得に失敗しました: ${errorMessages.join(', ')}`,
        });
      }

      externalCssStats = {
        urlsFound: allUrls.length,
        urlsFetched: fetchedCount,
        fetchErrors: errorCount,
        fetchTimeMs: Date.now() - fetchStartTime,
        totalSize,
      };
    } else {
      externalCssStats = {
        urlsFound: allUrls.length,
        urlsFetched: 0,
        fetchErrors: 0,
        fetchTimeMs: Date.now() - fetchStartTime,
        totalSize: 0,
      };
    }

    return {
      externalCssContent,
      externalCssFetched: true,
      externalCssUrls,
      externalCssStats,
      blockedUrls,
      warnings,
    };
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[motion.detect] External CSS processing error', { error });
    }
    warnings.push({
      code: MOTION_WARNING_CODES.EXTERNAL_CSS_FETCH_FAILED,
      severity: 'warning',
      message: error instanceof Error ? error.message : 'External CSS processing failed',
    });

    return {
      externalCssContent: '',
      externalCssFetched: true,
      externalCssUrls: [],
      blockedUrls: [],
      warnings,
    };
  }
}

// =====================================================
// レスポンス最適化
// =====================================================

export interface OptimizationResult {
  patterns: MotionPattern[];
  summaryMode?: boolean | undefined;
  truncated?: boolean | undefined;
  originalSize?: number | undefined;
  patternsTruncatedCount?: number | undefined;
  sizeOptimization?: {
    original_size_bytes: number;
    optimized_size_bytes: number;
    reduction_percent: number;
    applied_optimizations: ('summary' | 'truncate')[];
  } | undefined;
}

/**
 * レスポンスサイズ最適化を適用
 */
export function applyResponseOptimization(
  patterns: MotionPattern[],
  validated: MotionDetectInput
): OptimizationResult {
  let optimizedPatterns = [...patterns];
  let summaryMode: boolean | undefined;
  let truncated: boolean | undefined;
  let originalSize: number | undefined;
  let patternsTruncatedCount: number | undefined;
  let sizeOptimization: OptimizationResult['sizeOptimization'];

  // auto_optimize: レスポンスサイズに応じて自動最適化
  if (validated.auto_optimize && !validated.summary) {
    const tempResponse = JSON.stringify({ patterns: optimizedPatterns, metadata: {} });
    const currentSize = tempResponse.length;

    const appliedOptimizations: ('summary' | 'truncate')[] = [];

    // 100KB超で summary モードを適用
    if (currentSize > 100 * 1024) {
      optimizedPatterns = optimizedPatterns.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        trigger: p.trigger,
        type: p.type,
      })) as MotionPattern[];
      summaryMode = true;
      appliedOptimizations.push('summary');

      if (isDevelopment()) {
        logger.info('[motion.detect] auto_optimize applied summary mode', {
          originalSize: currentSize,
        });
      }
    }

    // 500KB超で truncate を適用
    const afterSummarySize = JSON.stringify({ patterns: optimizedPatterns, metadata: {} }).length;
    if (afterSummarySize > 500 * 1024) {
      const originalCount = optimizedPatterns.length;
      while (optimizedPatterns.length > 0) {
        const testSize = JSON.stringify({ patterns: optimizedPatterns, metadata: {} }).length;
        if (testSize <= 500 * 1024) break;
        optimizedPatterns = optimizedPatterns.slice(0, Math.floor(optimizedPatterns.length * 0.8));
      }
      truncated = true;
      patternsTruncatedCount = originalCount - optimizedPatterns.length;
      appliedOptimizations.push('truncate');

      if (isDevelopment()) {
        logger.info('[motion.detect] auto_optimize applied truncate', {
          originalCount,
          finalCount: optimizedPatterns.length,
        });
      }
    }

    if (appliedOptimizations.length > 0) {
      const optimizedSize = JSON.stringify({ patterns: optimizedPatterns, metadata: {} }).length;
      sizeOptimization = {
        original_size_bytes: currentSize,
        optimized_size_bytes: optimizedSize,
        reduction_percent: Math.round(((currentSize - optimizedSize) / currentSize) * 100),
        applied_optimizations: appliedOptimizations,
      };
    }
  }

  // summary: true の場合はパターンを軽量化
  if (validated.summary) {
    optimizedPatterns = optimizedPatterns.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      trigger: p.trigger,
      type: p.type,
    })) as MotionPattern[];
    summaryMode = true;

    if (isDevelopment()) {
      logger.info('[motion.detect] summary mode applied', {
        patternsCount: optimizedPatterns.length,
      });
    }
  }

  // truncate_max_chars: レスポンスサイズを制限
  if (validated.truncate_max_chars !== undefined) {
    const tempResponse = JSON.stringify({ patterns: optimizedPatterns, metadata: {} });
    const currentSize = tempResponse.length;

    if (currentSize > validated.truncate_max_chars) {
      originalSize = currentSize;
      const originalCount = optimizedPatterns.length;

      while (optimizedPatterns.length > 0) {
        const testResponse = JSON.stringify({ patterns: optimizedPatterns, metadata: {} });
        if (testResponse.length <= validated.truncate_max_chars) break;
        const reduceCount = Math.max(1, Math.floor(optimizedPatterns.length * 0.2));
        optimizedPatterns = optimizedPatterns.slice(0, optimizedPatterns.length - reduceCount);
      }

      truncated = true;
      patternsTruncatedCount = originalCount - optimizedPatterns.length;

      if (isDevelopment()) {
        logger.info('[motion.detect] truncate applied', {
          originalSize: currentSize,
          targetSize: validated.truncate_max_chars,
          originalCount,
          finalCount: optimizedPatterns.length,
        });
      }
    }
  }

  return {
    patterns: optimizedPatterns,
    summaryMode,
    truncated,
    originalSize,
    patternsTruncatedCount,
    sizeOptimization,
  };
}

// =====================================================
// サマリー生成
// =====================================================

/**
 * サマリー情報を生成
 */
export function generateSummary(
  patterns: MotionPattern[],
  serviceSummary?: Partial<MotionSummary>
): MotionSummary {
  const baseSummary: MotionSummary = {
    totalPatterns: patterns.length,
    byType: countByType(patterns),
    byTrigger: countByTrigger(patterns),
    byCategory: countByCategory(patterns),
    averageDuration: calculateAverageDuration(patterns),
    hasInfiniteAnimations: patterns.some((p) => p.animation?.iterations === 'infinite'),
    complexityScore: calculateComplexityScore(patterns),
  };

  return {
    ...baseSummary,
    ...serviceSummary,
  };
}

// =====================================================
// レスポンスサイズ警告
// =====================================================

/**
 * レスポンスサイズに基づく警告を生成
 */
export function generateSizeWarning(
  responseSize: number
): MotionWarning | null {
  const SIZE_WARNING_THRESHOLD = 10 * 1024; // 10KB
  const SIZE_CRITICAL_THRESHOLD = 100 * 1024; // 100KB

  if (responseSize > SIZE_CRITICAL_THRESHOLD) {
    return {
      code: 'RESPONSE_SIZE_CRITICAL',
      severity: 'error',
      message: `Response size (${(responseSize / 1024).toFixed(1)}KB) exceeds critical threshold (100KB)`,
      suggestion: 'Use summary: true, truncate_max_chars, or auto_optimize: true to reduce response size',
    };
  } else if (responseSize > SIZE_WARNING_THRESHOLD) {
    return {
      code: 'RESPONSE_SIZE_WARNING',
      severity: 'warning',
      message: `Response size (${(responseSize / 1024).toFixed(1)}KB) exceeds warning threshold (10KB)`,
      suggestion: 'Consider using summary: true or truncate_max_chars to reduce response size',
    };
  }

  return null;
}

// =====================================================
// WebGL/Canvas検出警告
// =====================================================

/**
 * WebGL/Canvas検出警告を生成
 *
 * パターンが0件かつdetect_js_animationsが無効の場合に警告を生成
 * Three.js, GSAP, Lottie等のJSアニメーションが検出されない可能性を通知
 *
 * @param patternCount - 検出されたパターン数
 * @param detectJsAnimations - detect_js_animations設定値
 * @returns 警告オブジェクト、または条件を満たさない場合はnull
 */
export function generateWebglDetectionWarning(
  patternCount: number,
  detectJsAnimations: boolean
): MotionWarning | null {
  // パターンが0件かつdetect_js_animationsが無効の場合のみ警告
  if (patternCount === 0 && detectJsAnimations === false) {
    return {
      code: MOTION_WARNING_CODES.WEBGL_DETECTION_DISABLED,
      severity: 'info',
      message: 'WebGL/Canvas animations may not be detected with current settings. Enable detect_js_animations: true for Three.js, GSAP, Lottie detection.',
      suggestion: 'Set detect_js_animations: true to enable JavaScript animation detection via CDP + Web Animations API.',
      context: {
        currentSetting: 'detect_js_animations: false',
        recommendedSetting: 'detect_js_animations: true',
        affectedLibraries: ['Three.js', 'GSAP', 'Framer Motion', 'anime.js', 'Lottie'],
      },
    };
  }

  return null;
}

// =====================================================
// DB保存処理
// =====================================================

export interface SaveResultWithDebug {
  saveResult?: MotionSaveResult | undefined;
  debugInfo?: {
    persistenceServiceAvailable: boolean;
    isAvailable?: boolean | undefined;
    error?: string | undefined;
    factoryExists?: boolean | undefined;
  } | undefined;
}

/**
 * パターンをDBに保存
 */
export async function savePatternsToDb(
  patterns: MotionPattern[],
  pageId: string | undefined,
  baseUrl: string | undefined
): Promise<SaveResultWithDebug> {
  const debugInfo: NonNullable<SaveResultWithDebug['debugInfo']> = {
    persistenceServiceAvailable: false,
    factoryExists: getPersistenceServiceFactoryExists(),
    isAvailable: undefined,
    error: undefined,
  };

  const persistenceService = getPersistenceService();
  debugInfo.persistenceServiceAvailable = persistenceService !== null;

  if (persistenceService) {
    debugInfo.isAvailable = persistenceService.isAvailable?.() ?? false;

    try {
      const saveOptions: { webPageId?: string; sourceUrl?: string; continueOnError: boolean } = {
        continueOnError: true,
      };
      if (pageId !== undefined) {
        saveOptions.webPageId = pageId;
      }
      if (baseUrl !== undefined) {
        saveOptions.sourceUrl = baseUrl;
      }

      let saveResult = await persistenceService.savePatterns(patterns, saveOptions);

      if (!saveResult.saved && !saveResult.reason) {
        saveResult = {
          ...saveResult,
          reason: `All ${patterns.length} pattern(s) failed to save (check DB connection)`,
        };
      }

      if (isDevelopment()) {
        logger.info('[motion.detect] DB save completed', {
          savedCount: saveResult.savedCount,
          patternIds: saveResult.patternIds.length,
          embeddingIds: saveResult.embeddingIds.length,
        });
      }

      return { saveResult, debugInfo };
    } catch (saveError) {
      const errorMessage = saveError instanceof Error ? saveError.message : 'Unknown error';
      if (isDevelopment()) {
        logger.error('[motion.detect] DB save error', { error: errorMessage });
      }
      debugInfo.error = errorMessage;

      return {
        saveResult: {
          saved: false,
          savedCount: 0,
          patternIds: [],
          embeddingIds: [],
          reason: `DB save error: ${errorMessage}`,
        },
        debugInfo,
      };
    }
  } else {
    if (isDevelopment()) {
      logger.warn('[motion.detect] persistence service not available');
    }

    const reason = debugInfo.factoryExists
      ? `Persistence service exists but isAvailable() returned false`
      : `Persistence service factory not registered`;

    return {
      saveResult: {
        saved: false,
        savedCount: 0,
        patternIds: [],
        embeddingIds: [],
        reason,
      },
      debugInfo,
    };
  }
}

// =====================================================
// CSSモードハンドラー
// =====================================================

/**
 * CSSモード処理のメイン関数
 */
export async function handleCssMode(
  validated: MotionDetectInput,
  html: string,
  css: string | undefined,
  pageId: string | undefined,
  startTime: number
): Promise<MotionDetectOutput> {
  try {
    // =====================================================
    // CSS Analysis Cache チェック
    // =====================================================
    const cacheService = getCSSAnalysisCacheService();
    // キャッシュキーはHTMLに基づく（外部CSS取得なし、追加CSS なしの場合のみキャッシュ有効）
    const useCache =
      !validated.fetchExternalCss &&
      !css &&
      !validated.save_to_db &&
      validated.includeInlineStyles &&
      validated.includeStyleSheets;

    let cacheKey: string | undefined;

    if (useCache) {
      try {
        cacheKey = cacheService.generateCacheKey({ html });
        const cachedResult = await cacheService.getMotionDetectResult(cacheKey);

        if (cachedResult) {
          if (isDevelopment()) {
            logger.info('[motion.detect] cache hit', { cacheKey });
          }

          // キャッシュから結果を復元
          // 型変換: キャッシュ型からMotionPattern型へ
          const patterns: MotionPattern[] = cachedResult.patterns.map((p, i) => ({
            id: `pattern-${i}`,
            type: (p.type === 'keyframe' ? 'keyframes' : p.type === 'transition' ? 'css_transition' : p.type) as MotionPattern['type'],
            name: p.name,
            category: 'micro_interaction' as const, // キャッシュにはカテゴリ情報がないためデフォルト値
            trigger: 'load' as const, // キャッシュにはトリガー情報がないためデフォルト値
            animation: {
              ...(p.duration !== undefined && { duration: p.duration }),
              // easingを文字列から構造化オブジェクトに変換
              ...(p.easing !== undefined && {
                easing: {
                  type: (p.easing === 'ease' || p.easing === 'linear' || p.easing === 'ease-in' || p.easing === 'ease-out' || p.easing === 'ease-in-out'
                    ? p.easing
                    : 'unknown') as 'unknown' | 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'cubic-bezier' | 'spring' | 'steps',
                },
              }),
            },
            properties: [], // キャッシュにはプロパティ情報がないため空配列
          }));

          const byTypeMap = countByType(patterns);
          const byTriggerMap = countByTrigger(patterns);
          const byCategoryMap = countByCategory(patterns);

          const summary: MotionSummary = {
            totalPatterns: cachedResult.summary.totalPatterns,
            byType: byTypeMap,
            byTrigger: byTriggerMap,
            byCategory: byCategoryMap,
            averageDuration: calculateAverageDuration(patterns),
            hasInfiniteAnimations: false, // キャッシュにはこの情報がないためデフォルト値
            complexityScore: calculateComplexityScore(patterns),
          };

          const metadata: MotionMetadata = {
            processingTimeMs: Date.now() - startTime,
            htmlSize: html.length,
            detection_mode: 'css',
          };

          return {
            success: true,
            data: {
              patterns,
              summary: validated.includeSummary ? summary : undefined,
              metadata,
            },
          };
        }
      } catch (cacheError) {
        // キャッシュエラーは無視して検出を続行
        if (isDevelopment()) {
          logger.warn('[motion.detect] cache error, proceeding with detection', { error: cacheError });
        }
      }
    }

    // 外部CSS取得用の変数
    let externalCssContent = '';
    let externalCssFetched: boolean | undefined;
    let externalCssUrls: string[] | undefined;
    let externalCssStats: ExternalCssStats | undefined;
    let blockedUrls: string[] | undefined;
    const externalCssWarnings: MotionWarning[] = [];

    // 外部CSS取得
    if (validated.fetchExternalCss && validated.baseUrl) {
      const externalCssOpts: { timeout?: number; maxConcurrent?: number } = {};
      if (validated.externalCssOptions?.timeout !== undefined) {
        externalCssOpts.timeout = validated.externalCssOptions.timeout;
      }
      if (validated.externalCssOptions?.maxConcurrent !== undefined) {
        externalCssOpts.maxConcurrent = validated.externalCssOptions.maxConcurrent;
      }
      const fetchResult = await fetchExternalCss(html, validated.baseUrl, externalCssOpts);

      externalCssContent = fetchResult.externalCssContent;
      externalCssFetched = fetchResult.externalCssFetched;
      externalCssUrls = fetchResult.externalCssUrls;
      externalCssStats = fetchResult.externalCssStats;
      blockedUrls = fetchResult.blockedUrls;
      externalCssWarnings.push(...fetchResult.warnings);
    }

    // css パラメータに外部CSSを追加
    const combinedCss = [css, externalCssContent].filter(Boolean).join('\n');

    const options: DetectOptions = {
      includeInlineStyles: validated.includeInlineStyles,
      includeStyleSheets: validated.includeStyleSheets,
      minDuration: validated.minDuration,
      maxPatterns: validated.maxPatterns,
      verbose: validated.verbose,
    };

    // 検出実行
    let result: DetectionResult;
    const serviceFactory = getMotionDetectServiceFactory();
    const service = serviceFactory?.();

    if (service?.detect) {
      try {
        result = await service.detect(html, combinedCss || undefined, options);
      } catch (error) {
        if (isDevelopment()) {
          logger.error('[motion.detect] service error', { error });
        }
        return {
          success: false,
          error: {
            code: MOTION_MCP_ERROR_CODES.DETECTION_ERROR,
            message: error instanceof Error ? error.message : 'Detection failed',
          },
        };
      }
    } else {
      result = defaultDetect(html, combinedCss || undefined, options);
    }

    // minDuration でフィルタリング
    let patterns = result.patterns;
    if (validated.minDuration > 0) {
      patterns = patterns.filter((p) => {
        const duration = p.animation?.duration;
        return duration === undefined || duration >= validated.minDuration;
      });
    }

    // maxPatterns で制限
    if (patterns.length > validated.maxPatterns) {
      patterns = patterns.slice(0, validated.maxPatterns);
    }

    // verbose=false の場合は rawCss を削除
    if (!validated.verbose) {
      patterns = patterns.map((p) => {
        const { rawCss: _rawCss, ...rest } = p;
        return rest;
      });
    }

    // 完全なパターンデータを保存
    const fullPatterns = [...patterns];

    // レスポンス最適化
    const optimizationResult = applyResponseOptimization(patterns, validated);
    patterns = optimizationResult.patterns;

    // サマリー生成
    let summary: MotionSummary | undefined;
    if (validated.includeSummary) {
      summary = generateSummary(fullPatterns, result.summary);
    }

    // 警告フィルタリング
    let warnings: MotionWarning[] | undefined;
    if (validated.includeWarnings) {
      const allWarnings = [...(result.warnings ?? []), ...externalCssWarnings];

      const severityOrder: Record<string, number> = {
        info: 0,
        warning: 1,
        error: 2,
      };
      const minSeverityLevel = severityOrder[validated.min_severity] ?? 0;

      warnings = allWarnings.filter((w) => {
        const warningLevel = severityOrder[w.severity] ?? 0;
        return warningLevel >= minSeverityLevel;
      });
    }

    // レスポンスサイズ警告
    const estimatedResponseSize = JSON.stringify({ patterns, metadata: {} }).length;
    const sizeWarning = generateSizeWarning(estimatedResponseSize);
    if (sizeWarning) {
      if (!warnings) {
        warnings = [];
      }
      warnings.push(sizeWarning);

      if (isDevelopment()) {
        logger.info('[motion.detect] size warning added', {
          estimatedResponseSize,
          threshold: sizeWarning.severity === 'error' ? 'critical' : 'warning',
        });
      }
    }

    // WebGL/Canvas検出警告（patterns=0件 かつ detect_js_animations=false の場合）
    const webglWarning = generateWebglDetectionWarning(
      patterns.length,
      validated.detect_js_animations ?? false
    );
    if (webglWarning) {
      if (!warnings) {
        warnings = [];
      }
      warnings.push(webglWarning);

      if (isDevelopment()) {
        logger.info('[motion.detect] WebGL detection warning added', {
          patternCount: patterns.length,
          detectJsAnimations: validated.detect_js_animations ?? false,
        });
      }
    }

    // DB保存処理
    let saveResult: MotionSaveResult | undefined;
    let debugInfo: SaveResultWithDebug['debugInfo'];

    if (validated.save_to_db && fullPatterns.length > 0) {
      if (isDevelopment()) {
        logger.info('[motion.detect] saving to DB', {
          patternsCount: fullPatterns.length,
          pageId,
        });
      }

      const dbResult = await savePatternsToDb(fullPatterns, pageId, validated.baseUrl);
      saveResult = dbResult.saveResult;
      debugInfo = dbResult.debugInfo;
    }

    // メタデータ
    const metadata: MotionMetadata = {
      processingTimeMs: Date.now() - startTime,
      htmlSize: html.length,
      cssSize: combinedCss?.length || css?.length,
      externalCssFetched,
      externalCssUrls: externalCssUrls && externalCssUrls.length > 0 ? externalCssUrls : undefined,
      externalCssStats,
      blockedUrls: blockedUrls && blockedUrls.length > 0 ? blockedUrls : undefined,
    };

    if (isDevelopment()) {
      logger.info('[motion.detect] completed', {
        patternsCount: patterns.length,
        warningsCount: warnings?.length ?? 0,
        processingTimeMs: metadata.processingTimeMs,
        externalCssFetched,
        externalCssUrlsCount: externalCssUrls?.length ?? 0,
        savedToDb: saveResult?.saved ?? false,
      });
    }

    // 最終レスポンスサイズを計算
    const finalResponseSize = JSON.stringify({ patterns, metadata }).length;

    // =====================================================
    // CSS Analysis Cache 保存
    // =====================================================
    if (useCache && cacheKey && fullPatterns.length > 0) {
      try {
        const cacheResult: MotionAnalysisResult = {
          patterns: fullPatterns.map((p) => ({
            type: p.type,
            name: p.name ?? `pattern-${p.id}`, // nameがundefinedの場合はデフォルト値を使用
            // durationはundefinedの場合はキャッシュに含めない
            ...(p.animation?.duration !== undefined && { duration: p.animation.duration }),
            // easingは構造化オブジェクトなので、typeを文字列として保存
            ...(p.animation?.easing?.type !== undefined && { easing: p.animation.easing.type }),
          })),
          summary: {
            totalPatterns: fullPatterns.length,
            hasAnimations: fullPatterns.some((p) => p.type === 'keyframes' || p.type === 'css_animation'),
            hasTransitions: fullPatterns.some((p) => p.type === 'css_transition'),
          },
          analyzedAt: Date.now(),
          cacheKey,
        };
        await cacheService.setMotionDetectResult(cacheKey, cacheResult);
        if (isDevelopment()) {
          logger.debug('[motion.detect] result cached', { cacheKey, patternCount: fullPatterns.length });
        }
      } catch (cacheError) {
        // キャッシュ保存エラーは無視
        if (isDevelopment()) {
          logger.warn('[motion.detect] cache save error', { error: cacheError });
        }
      }
    }

    return {
      success: true,
      data: {
        pageId,
        patterns,
        summary,
        warnings,
        metadata: {
          ...metadata,
          response_size_bytes: finalResponseSize,
        },
        saveResult,
        runtime_info: result.runtime_info,
        ...(optimizationResult.summaryMode !== undefined ? { _summary_mode: optimizationResult.summaryMode } : {}),
        ...(optimizationResult.truncated !== undefined ? { _truncated: optimizationResult.truncated } : {}),
        ...(optimizationResult.originalSize !== undefined ? { _original_size: optimizationResult.originalSize } : {}),
        ...(optimizationResult.patternsTruncatedCount !== undefined ? { _patterns_truncated_count: optimizationResult.patternsTruncatedCount } : {}),
        ...(optimizationResult.sizeOptimization !== undefined ? { _size_optimization: optimizationResult.sizeOptimization } : {}),
        ...(isDevelopment() && debugInfo ? { _debugInfo: debugInfo } : {}),
      },
    };
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[motion.detect] error', { error });
    }
    return {
      success: false,
      error: {
        code: MOTION_MCP_ERROR_CODES.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Detection failed',
      },
    };
  }
}
