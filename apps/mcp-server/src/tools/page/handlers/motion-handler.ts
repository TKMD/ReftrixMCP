// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze モーション検出ハンドラー
 * MotionDetectorService + Video Mode (フレームキャプチャ/分析) + Vision Motion候補検出 の統合
 *
 * Phase 3: モーション検出改善 (2026-01-10)
 * - Vision motion候補との統合
 * - CSS検出結果0件時の警告追加
 * - JS検出失敗時の明示的警告
 *
 * @module tools/page/handlers/motion-handler
 */

import type { Browser } from 'playwright';
import { logger, isDevelopment } from '../../../utils/logger';
import {
  getMotionDetectorService,
  type MotionDetectionResult,
} from '../../../services/page/motion-detector.service';
import {
  extractCssUrls,
  fetchAllCss,
  type FetchAllCssOptions,
} from '../../../services/external-css-fetcher';
import {
  PAGE_ANALYZE_ERROR_CODES,
  type PageAnalyzeInput,
  type MotionDetectionMode,
} from '../schemas';
import {
  type MotionServiceResult,
  type MotionDetectionContext,
  type MotionDetectionExtendedContext,
  type MotionPatternData,
  type WebGLAnimationSummaryResult,
  type WebGLAnimationFullResult,
} from './types';
import { executeVideoMode } from './video-handler';
import { executeJSAnimationMode, checkPlaywrightAvailability, type JSAnimationContext } from './js-animation-handler';
import type { MotionCandidatesData } from '../../../services/vision-adapter/interface';
import { executeWebGLAnimationDetection, type WebGLAnimationContext } from './webgl-animation-handler';
// detection_mode: video/runtime/hybrid用のインポート
import {
  executeVideoDetection,
  executeRuntimeDetection,
} from '../../motion/detection-modes';

// MotionDetectionContext/ExtendedContextを再エクスポート（他のモジュールからの参照用）
export type { MotionDetectionContext, MotionDetectionExtendedContext } from './types';

/**
 * Vision motion候補をwarnings形式に変換
 */
function convertVisionCandidatesToWarnings(
  visionCandidates: MotionCandidatesData
): Array<{ code: string; severity: 'info' | 'warning' | 'error'; message: string }> {
  const warnings: Array<{ code: string; severity: 'info' | 'warning' | 'error'; message: string }> = [];

  // アニメーション候補を情報として追加
  if (visionCandidates.likelyAnimations && visionCandidates.likelyAnimations.length > 0) {
    for (const anim of visionCandidates.likelyAnimations) {
      warnings.push({
        code: 'VISION_MOTION_CANDIDATE',
        severity: 'info',
        message: `Vision detected potential ${anim.animationType} animation on: ${anim.element} (confidence: ${(anim.confidence * 100).toFixed(0)}%)`,
      });
    }
  }

  // インタラクティブ要素を情報として追加
  if (visionCandidates.interactiveElements && visionCandidates.interactiveElements.length > 0) {
    warnings.push({
      code: 'VISION_INTERACTIVE_ELEMENTS',
      severity: 'info',
      message: `Vision detected ${visionCandidates.interactiveElements.length} interactive elements: ${visionCandidates.interactiveElements.slice(0, 5).join(', ')}${visionCandidates.interactiveElements.length > 5 ? '...' : ''}`,
    });
  }

  // スクロールトリガーを情報として追加
  if (visionCandidates.scrollTriggers && visionCandidates.scrollTriggers.length > 0) {
    warnings.push({
      code: 'VISION_SCROLL_TRIGGERS',
      severity: 'info',
      message: `Vision detected ${visionCandidates.scrollTriggers.length} scroll-triggered sections: ${visionCandidates.scrollTriggers.slice(0, 3).join(', ')}${visionCandidates.scrollTriggers.length > 3 ? '...' : ''}`,
    });
  }

  return warnings;
}

/**
 * デフォルトのモーション検出
 * MotionDetectorServiceを使用してCSS animation/transitionを検出
 * video mode (enable_frame_capture) 有効時はフレームキャプチャと分析も実行
 * Vision motion候補検出（スクリーンショートがある場合）
 *
 * @param html - 分析対象のHTML
 * @param url - video mode用のURL（enable_frame_capture時に必須）
 * @param options - モーション検出オプション
 * @param dbContext - DB保存コンテキスト（prisma, webPageId）- JSアニメーションパターンのDB保存に使用
 * @param extendedContext - 拡張コンテキスト（Vision解析用スクリーンショート等）
 * @param preExtractedCssUrls - サニタイズ前のHTMLから抽出済みの外部CSS URL（オプション）
 *                              DOMPurifyで<link>タグが除去される問題の回避策として使用
 */
export async function defaultDetectMotion(
  html: string,
  url: string,
  options?: PageAnalyzeInput['motionOptions'],
  dbContext?: MotionDetectionContext,
  extendedContext?: MotionDetectionExtendedContext,
  preExtractedCssUrls?: string[],
  sharedBrowser?: Browser
): Promise<MotionServiceResult> {
  const startTime = Date.now();
  const detectionMode: MotionDetectionMode = options?.detection_mode ?? 'css';

  try {
    if (isDevelopment()) {
      logger.info('[page.analyze] Starting motion detection', {
        htmlLength: html.length,
        url,
        detection_mode: detectionMode,
        enable_frame_capture: options?.enable_frame_capture,
        analyze_frames: options?.analyze_frames,
        options,
      });
    }

    // =====================================================
    // detection_mode別の処理分岐 (v0.1.0)
    // =====================================================

    // Video Mode: motion.detectと同等の動画録画+フレーム解析
    if (detectionMode === 'video') {
      return await executeVideoModeDetection(url, options, startTime, extendedContext);
    }

    // Runtime Mode: Playwrightでランタイムアニメーション検出
    if (detectionMode === 'runtime') {
      return await executeRuntimeModeDetection(url, options, startTime, extendedContext);
    }

    // Hybrid Mode: CSS静的解析 + ランタイム検出
    if (detectionMode === 'hybrid') {
      return await executeHybridModeDetection(html, url, options, dbContext, extendedContext, preExtractedCssUrls, startTime, sharedBrowser);
    }

    // CSS Mode (default): CSS静的解析
    // fetchExternalCssがtrue（またはデフォルトで有効化）の場合、外部CSSを取得
    // デフォルト値をtrueに変更（多くのサイトで外部CSSにアニメーションが定義されているため）
    const shouldFetchExternalCss = options?.fetchExternalCss ?? true;

    // 外部CSSの取得（オプション有効時）
    // v0.1.0: 全体の外部CSS取得に30秒のハードタイムアウトを設定
    // 個別ファイルは5秒タイムアウトだが、多数のファイル（Tildaサイト等で43ファイル）の場合、
    // バッチ処理で合計時間が膨れるため、全体を30秒で打ち切る
    const EXTERNAL_CSS_OVERALL_TIMEOUT_MS = 30000; // 30秒
    let externalCss: string | undefined;
    if (shouldFetchExternalCss && url) {
      try {
        // preExtractedCssUrlsが渡されていればそれを使用（サニタイズ前に抽出済み）
        // それ以外の場合は現在のHTMLから抽出（サニタイズ後は<link>タグが除去されている可能性あり）
        let cssUrlsToFetch: string[];
        if (preExtractedCssUrls && preExtractedCssUrls.length > 0) {
          cssUrlsToFetch = preExtractedCssUrls;
          if (isDevelopment()) {
            logger.info('[page.analyze] Using pre-extracted CSS URLs (before sanitization)', {
              urlCount: cssUrlsToFetch.length,
            });
          }
        } else {
          const extractedUrls = extractCssUrls(html, url);
          cssUrlsToFetch = extractedUrls.map((u) => u.url);
          if (isDevelopment() && cssUrlsToFetch.length === 0) {
            logger.warn('[page.analyze] No CSS URLs extracted from HTML - this may be due to HTML sanitization removing <link> tags');
          }
        }

        if (cssUrlsToFetch.length > 0) {
          if (isDevelopment()) {
            logger.info('[page.analyze] Fetching external CSS', {
              urlCount: cssUrlsToFetch.length,
              urls: cssUrlsToFetch,
            });
          }

          const fetchOptions: FetchAllCssOptions = {
            timeout: 5000,
            maxConcurrent: 5,
            continueOnError: true,
          };

          // 全体を30秒タイムアウトで保護（Graceful Degradation）
          const cssResults = await Promise.race([
            fetchAllCss(cssUrlsToFetch, fetchOptions),
            new Promise<never>((_, reject) => {
              setTimeout(() => {
                reject(new Error(`External CSS fetch overall timeout after ${EXTERNAL_CSS_OVERALL_TIMEOUT_MS}ms`));
              }, EXTERNAL_CSS_OVERALL_TIMEOUT_MS);
            }),
          ]);

          // 成功したCSSを結合
          const fetchedContents = cssResults
            .filter((r) => r.content !== null)
            .map((r) => r.content as string);

          if (fetchedContents.length > 0) {
            externalCss = fetchedContents.join('\n');
            if (isDevelopment()) {
              logger.info('[page.analyze] External CSS fetched', {
                successCount: fetchedContents.length,
                totalCount: cssUrlsToFetch.length,
                externalCssLength: externalCss.length,
              });
            }
          }
        }
      } catch (fetchError) {
        // 外部CSS取得失敗（タイムアウト含む）は警告のみ、インラインCSSのみで分析を継続
        if (isDevelopment()) {
          logger.warn('[page.analyze] Failed to fetch external CSS (graceful degradation: using inline CSS only)', {
            error: fetchError instanceof Error ? fetchError.message : String(fetchError),
          });
        }
      }
    }

    // MotionDetectorServiceを使用してCSS静的解析
    const detector = getMotionDetectorService();
    const detectionResult: MotionDetectionResult = detector.detect(
      html,
      {
        includeInlineStyles: true,
        includeStyleSheets: true,
        minDuration: options?.minDuration ?? 0,
        maxPatterns: options?.maxPatterns ?? 100,
        verbose: false,
      },
      externalCss // 外部CSSを第3引数として渡す
    );

    // カテゴリ別の集計
    const categoryBreakdown: Record<string, number> = {};
    for (const pattern of detectionResult.patterns) {
      const category = pattern.category;
      categoryBreakdown[category] = (categoryBreakdown[category] ?? 0) + 1;
    }

    // 警告カウント集計
    let a11yWarningCount = 0;
    let perfWarningCount = 0;
    for (const warning of detectionResult.warnings) {
      if (warning.code.startsWith('A11Y_')) {
        a11yWarningCount++;
      } else if (warning.code.startsWith('PERF_')) {
        perfWarningCount++;
      }
    }

    // パターンをMotionServiceResult形式に変換
    const patterns: MotionServiceResult['patterns'] = detectionResult.patterns.map(
      (p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        category: p.category,
        trigger: p.trigger,
        duration: p.duration,
        easing: p.easing,
        properties: p.properties,
        propertiesDetailed: p.propertiesDetailed?.map(prop => ({
          property: prop.property,
          from: prop.from ?? '',
          to: prop.to ?? '',
        })) ?? [],
        performance: {
          level: p.performance.level,
          usesTransform: p.performance.usesTransform,
          usesOpacity: p.performance.usesOpacity,
        },
        accessibility: {
          respectsReducedMotion: p.accessibility.respectsReducedMotion,
        },
      })
    );

    // 警告をMotionServiceResult形式に変換
    const warnings: MotionServiceResult['warnings'] = detectionResult.warnings.map(
      (w) => ({
        code: w.code,
        severity: w.severity,
        message: w.message,
      })
    );

    const result: MotionServiceResult = {
      success: true,
      patternCount: patterns.length,
      categoryBreakdown,
      warningCount: warnings.length,
      a11yWarningCount,
      perfWarningCount,
      processingTimeMs: detectionResult.processingTimeMs,
    };

    // オプションに応じて詳細を追加
    if (options?.includeWarnings !== false) {
      result.warnings = warnings;
    }

    result.patterns = patterns;

    // =====================================================
    // Video Mode: Frame Capture + Frame Analysis
    // =====================================================
    // video-handler.tsに分離された処理を呼び出し
    const videoModeResult = await executeVideoMode(url, {
      enable_frame_capture: options?.enable_frame_capture,
      analyze_frames: options?.analyze_frames,
      frame_capture_options: options?.frame_capture_options,
      frame_analysis_options: options?.frame_analysis_options,
    });

    // Video Mode結果をMotionServiceResultにマージ
    if (videoModeResult.frame_capture) {
      result.frame_capture = videoModeResult.frame_capture;
    }
    if (videoModeResult.frame_analysis) {
      result.frame_analysis = videoModeResult.frame_analysis;
    }
    if (videoModeResult.frame_capture_error) {
      result.frame_capture_error = videoModeResult.frame_capture_error;
    }
    if (videoModeResult.frame_analysis_error) {
      result.frame_analysis_error = videoModeResult.frame_analysis_error;
    }

    // =====================================================
    // JS Animation Mode: CDP + Web Animations API + ライブラリ検出
    // =====================================================
    // js-animation-handler.tsに分離された処理を呼び出し
    // dbContextが提供されている場合、JSアニメーションパターンをDBに保存
    // exactOptionalPropertyTypes対応: undefinedの場合はプロパティを含めない

    // Playwright利用可否の事前チェック
    // JS検出はデフォルト有効 (v0.1.0: データ蓄積のため再有効化)
    const jsDetectionRequested = options?.detect_js_animations ?? true;
    let jsAnimationResult: Awaited<ReturnType<typeof executeJSAnimationMode>> = {};

    if (jsDetectionRequested) {
      const isPlaywrightAvailable = await checkPlaywrightAvailability();

      if (!isPlaywrightAvailable) {
        // Playwright未インストール時は明示的な警告を出力
        if (isDevelopment()) {
          logger.warn('[motion-handler] Playwright not available, skipping JS animation detection', {
            url,
            hint: 'Run "pnpm exec playwright install chromium" to enable JS animation detection',
          });
        }

        jsAnimationResult = {
          js_animation_error: {
            code: 'PLAYWRIGHT_NOT_AVAILABLE',
            message: 'Playwright is not installed or chromium browser is not available. JS animation detection requires Playwright. Run "pnpm exec playwright install chromium" to install.',
          },
        };
      } else {
        // Playwright利用可能な場合は検出を実行
        const jsAnimationDbContext: JSAnimationContext | undefined = dbContext?.prisma
          ? {
              prisma: dbContext.prisma,
              sourceUrl: dbContext.sourceUrl ?? url,
              ...(dbContext.webPageId !== undefined && { webPageId: dbContext.webPageId }),
            }
          : undefined;

        jsAnimationResult = await executeJSAnimationMode(
          url,
          options?.detect_js_animations,
          options?.js_animation_options,
          jsAnimationDbContext,
          sharedBrowser
        );
      }
    } else {
      // JS検出が無効化されている場合
      if (isDevelopment()) {
        logger.info('[motion-handler] JS animation detection disabled by options', { url });
      }
    }

    // JS Animation結果をMotionServiceResultにマージ
    if (jsAnimationResult.js_animation_summary) {
      result.js_animation_summary = jsAnimationResult.js_animation_summary;
    }
    if (jsAnimationResult.js_animations) {
      result.js_animations = jsAnimationResult.js_animations;
    }
    if (jsAnimationResult.js_animation_error) {
      result.js_animation_error = jsAnimationResult.js_animation_error;
    }
    if (jsAnimationResult.savedPatternCount !== undefined) {
      result.jsSavedPatternCount = jsAnimationResult.savedPatternCount;
    }

    // =====================================================
    // WebGL Animation Mode: Canvas/WebGLベースのアニメーション検出 (v0.1.0)
    // =====================================================
    // webgl-animation-handler.tsに分離された処理を呼び出し
    // dbContextが提供されている場合、WebGLアニメーションパターンをDBに保存
    const webglDetectionRequested = options?.detect_webgl_animations ?? true; // v0.1.0: デフォルトtrue（データ蓄積のため再有効化）
    let webglAnimationResult: {
      webgl_animation_summary?: WebGLAnimationSummaryResult;
      webgl_animations?: WebGLAnimationFullResult;
      webgl_animation_error?: { code: string; message: string };
    } = {};

    if (webglDetectionRequested && url) {
      // Playwright利用可否の事前チェック（JSアニメーション検出と共通）
      const isPlaywrightAvailable = await checkPlaywrightAvailability();

      if (!isPlaywrightAvailable) {
        if (isDevelopment()) {
          logger.warn('[motion-handler] Playwright not available, skipping WebGL animation detection', {
            url,
            hint: 'Run "pnpm exec playwright install chromium" to enable WebGL animation detection',
          });
        }

        webglAnimationResult = {
          webgl_animation_error: {
            code: 'PLAYWRIGHT_NOT_AVAILABLE',
            message: 'Playwright is not installed or chromium browser is not available. WebGL animation detection requires Playwright.',
          },
        };
      } else {
        // Playwright利用可能な場合は検出を実行
        const webglAnimationDbContext: WebGLAnimationContext | undefined = dbContext?.prisma
          ? {
              prisma: dbContext.prisma,
              sourceUrl: dbContext.sourceUrl ?? url,
              saveToDb: options?.saveToDb ?? true,
              ...(dbContext.webPageId !== undefined && { webPageId: dbContext.webPageId }),
            }
          : undefined;

        webglAnimationResult = await executeWebGLAnimationDetection(
          url,
          options?.detect_webgl_animations,
          options?.webgl_animation_options,
          webglAnimationDbContext,
          sharedBrowser
        );
      }
    } else if (webglDetectionRequested && !url) {
      // URLがない場合はWebGL検出をスキップ
      if (isDevelopment()) {
        logger.info('[motion-handler] WebGL animation detection skipped: URL not provided', {});
      }
    } else {
      // WebGL検出が無効化されている場合
      if (isDevelopment()) {
        logger.info('[motion-handler] WebGL animation detection disabled by options', { url });
      }
    }

    // WebGL Animation結果をMotionServiceResultにマージ
    if (webglAnimationResult.webgl_animation_summary) {
      result.webgl_animation_summary = webglAnimationResult.webgl_animation_summary;
    }
    if (webglAnimationResult.webgl_animations) {
      result.webgl_animations = webglAnimationResult.webgl_animations;
    }
    if (webglAnimationResult.webgl_animation_error) {
      result.webgl_animation_error = webglAnimationResult.webgl_animation_error;
    }

    // =====================================================
    // Phase 3: 警告追加とVision motion候補検出
    // =====================================================

    // layout_firstモードが有効な場合の警告追加
    if (extendedContext?.layoutFirstModeEnabled) {
      warnings.push({
        code: 'LAYOUT_FIRST_MODE_ENABLED',
        severity: 'info',
        message: 'layout_first mode is enabled for this WebGL/3D site. Motion detection is limited to library detection only. Set layout_first: "never" for full motion detection.',
      });
    }

    // CSS検出結果が0件の場合の警告追加
    if (patterns.length === 0) {
      warnings.push({
        code: 'CSS_NO_ANIMATIONS_DETECTED',
        severity: 'warning',
        message: 'No CSS animations or transitions detected. This may indicate: (1) JavaScript-only animations (GSAP, Framer Motion, etc.), (2) Inline styles not captured, or (3) The site uses minimal animations.',
      });
    }

    // JS検出失敗時の警告追加（エラーがある場合）
    if (jsAnimationResult.js_animation_error) {
      warnings.push({
        code: 'JS_ANIMATION_DETECTION_FAILED',
        severity: 'warning',
        message: `JS animation detection failed: ${jsAnimationResult.js_animation_error.message}. CSS static analysis results are still available.`,
      });
    }

    // JS検出有効だが結果が0件の場合の警告（エラーなし）
    if (
      jsDetectionRequested &&
      !jsAnimationResult.js_animation_error &&
      (jsAnimationResult.js_animation_summary?.totalDetected ?? 0) === 0
    ) {
      warnings.push({
        code: 'JS_NO_ANIMATIONS_DETECTED',
        severity: 'info',
        message: 'No JS animations detected (CDP/Web Animations API/Libraries). The site may use CSS-only animations or static content.',
      });
    }

    // Motion検出結果が0件の場合（CSS + JS両方）の警告追加
    const jsPatternCount = jsAnimationResult.js_animation_summary?.totalDetected ?? 0;
    const totalPatternCount = patterns.length + jsPatternCount;
    if (totalPatternCount === 0 && !extendedContext?.layoutFirstModeEnabled) {
      warnings.push({
        code: 'MOTION_DETECTION_LIMITED',
        severity: 'info',
        message: 'Motion detection found 0 patterns. For better results, set detect_js_animations: true and detection_mode: "hybrid" or "video". WebGL/3D sites may have layout_first mode enabled which limits motion detection.',
      });
    }

    // =====================================================
    // Vision Motion候補検出（スクリーンショートがある場合）
    // =====================================================
    let visionMotionCandidates: MotionCandidatesData | undefined;

    if (extendedContext?.screenshot) {
      try {
        // LlamaVisionAdapterを動的インポート（layout-handler.tsと同じパターン）
        const { LlamaVisionAdapter } = await import(
          '../../../services/vision-adapter/index.js'
        );
        const visionAdapter = new LlamaVisionAdapter();

        // Ollama利用可能性チェック
        const isVisionAvailable = await visionAdapter.isAvailable();
        if (!isVisionAvailable) {
          if (isDevelopment()) {
            logger.info('[page.analyze] Vision motion detection skipped (Ollama not available)', {
              url,
            });
          }
          warnings.push({
            code: 'VISION_NOT_AVAILABLE',
            severity: 'info',
            message: 'Vision motion detection skipped: Ollama is not running or llama3.2-vision model not available',
          });
        } else {
          if (isDevelopment()) {
            logger.info('[page.analyze] Starting Vision motion candidates detection', {
              url,
              hasCssPatterns: patterns.length,
              hasJsAnimations: jsAnimationResult.js_animation_summary?.totalDetected ?? 0,
            });
          }

          // Vision motion候補検出
          const imageBuffer = Buffer.from(extendedContext.screenshot.base64, 'base64');
          const visionResult = await visionAdapter.detectMotionCandidates({
            imageBuffer,
            mimeType: extendedContext.screenshot.mimeType,
          });

          if (visionResult.success && visionResult.data) {
            visionMotionCandidates = visionResult.data;

            // Vision候補をwarningsに変換して追加
            const visionWarnings = convertVisionCandidatesToWarnings(visionMotionCandidates);
            warnings.push(...visionWarnings);

            if (isDevelopment()) {
              logger.info('[page.analyze] Vision motion candidates detected', {
                likelyAnimations: visionMotionCandidates.likelyAnimations?.length ?? 0,
                interactiveElements: visionMotionCandidates.interactiveElements?.length ?? 0,
                scrollTriggers: visionMotionCandidates.scrollTriggers?.length ?? 0,
                processingTimeMs: visionResult.processingTimeMs,
              });
            }
          } else if (visionResult.error) {
            // Vision検出失敗は警告のみ（非クリティカル）
            if (isDevelopment()) {
              logger.warn('[page.analyze] Vision motion candidates detection failed', {
                error: visionResult.error,
              });
            }
            warnings.push({
              code: 'VISION_MOTION_DETECTION_FAILED',
              severity: 'info',
              message: `Vision motion detection skipped: ${visionResult.error}`,
            });
          }
        }
      } catch (visionError) {
        // Vision検出エラーは警告のみ、処理は継続
        if (isDevelopment()) {
          logger.warn('[page.analyze] Vision motion candidates detection error', {
            error: visionError instanceof Error ? visionError.message : 'Unknown error',
          });
        }
        warnings.push({
          code: 'VISION_MOTION_DETECTION_ERROR',
          severity: 'info',
          message: 'Vision motion detection unavailable (Ollama may not be running)',
        });
      }
    }

    // 警告カウントを更新（Phase 3追加分を反映）
    result.warningCount = warnings.length;
    if (options?.includeWarnings !== false) {
      result.warnings = warnings;
    }

    // 処理時間を更新（video mode + JS animation + Vision含む）
    result.processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[page.analyze] Motion detection completed', {
        patternCount: patterns.length,
        warningCount: warnings.length,
        processingTimeMs: result.processingTimeMs,
        hasFrameCapture: !!result.frame_capture,
        hasFrameAnalysis: !!result.frame_analysis,
        hasJSAnimations: !!result.js_animations,
        jsAnimationTotal: result.js_animation_summary?.totalDetected ?? 0,
        jsLibrariesDetected: result.js_animation_summary?.detectedLibraries ?? [],
        hasVisionMotionCandidates: !!visionMotionCandidates,
        visionAnimationCandidates: visionMotionCandidates?.likelyAnimations?.length ?? 0,
      });
    }

    return result;
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[page.analyze] Motion detection failed', { error });
    }

    return {
      success: false,
      patternCount: 0,
      categoryBreakdown: {},
      warningCount: 0,
      a11yWarningCount: 0,
      perfWarningCount: 0,
      processingTimeMs: Date.now() - startTime,
      error: {
        code: PAGE_ANALYZE_ERROR_CODES.MOTION_DETECTION_FAILED,
        message: error instanceof Error ? error.message : 'Motion detection failed',
      },
    };
  }
}

// =====================================================
// Video Mode Detection (v0.1.0)
// motion.detectと同等の動画録画+フレーム解析
// =====================================================
async function executeVideoModeDetection(
  url: string,
  options: PageAnalyzeInput['motionOptions'] | undefined,
  startTime: number,
  extendedContext?: MotionDetectionExtendedContext
): Promise<MotionServiceResult> {
  if (!url) {
    return {
      success: false,
      patternCount: 0,
      categoryBreakdown: {},
      warningCount: 1,
      a11yWarningCount: 0,
      perfWarningCount: 0,
      processingTimeMs: Date.now() - startTime,
      error: {
        code: 'MOTION_VIDEO_MODE_URL_REQUIRED',
        message: 'detection_mode="video" requires a URL. Please provide a valid URL.',
      },
    };
  }

  try {
    if (isDevelopment()) {
      logger.info('[page.analyze] Executing Video Mode detection (motion.detect equivalent)', {
        url,
        video_options: options?.video_options,
      });
    }

    // motion.detectのexecuteVideoDetectionを呼び出し
    const videoResult = await executeVideoDetection(url, options?.video_options);

    // 結果をMotionServiceResult形式に変換
    // MotionPattern構造: name?, animation.duration, animation.easing?.type
    // Note: .map()は常に配列を返すため、MotionPatternData[]で型定義（undefined不要）
    // properties: MotionPattern.propertiesはオブジェクト配列なので、property名のみ抽出してstring[]に変換
    const patterns: MotionPatternData[] = videoResult.patterns.map((p) => ({
      id: p.id,
      name: p.name ?? 'unnamed',
      type: p.type,
      category: p.category ?? 'uncategorized',
      trigger: p.trigger ?? 'load',
      duration: p.animation?.duration,
      easing: p.animation?.easing?.type ?? 'linear',
      properties: p.properties?.map((prop) => prop.property) ?? [],
      propertiesDetailed: p.properties?.map(prop => ({
        property: prop.property,
        from: String(prop.from ?? ''),
        to: String(prop.to ?? ''),
      })) ?? [],
      performance: {
        level: 'high' as const,
        usesTransform: false,
        usesOpacity: false,
      },
      accessibility: {
        respectsReducedMotion: false,
      },
    }));

    const warnings: MotionServiceResult['warnings'] = videoResult.warnings.map((w) => ({
      code: w.code,
      severity: w.severity,
      message: w.message,
    }));

    // layout_firstモードの警告追加
    if (extendedContext?.layoutFirstModeEnabled) {
      warnings.push({
        code: 'LAYOUT_FIRST_MODE_ENABLED',
        severity: 'info',
        message: 'layout_first mode is enabled. Using video detection mode instead of limited motion detection.',
      });
    }

    // カテゴリ別の集計
    const categoryBreakdown: Record<string, number> = {};
    for (const pattern of patterns) {
      const category = pattern.category;
      categoryBreakdown[category] = (categoryBreakdown[category] ?? 0) + 1;
    }

    const result: MotionServiceResult = {
      success: true,
      patternCount: patterns.length,
      categoryBreakdown,
      warningCount: warnings.length,
      a11yWarningCount: 0,
      perfWarningCount: 0,
      processingTimeMs: Date.now() - startTime,
      patterns,
      // v0.1.0: exactOptionalPropertyTypes対応 - undefinedではなく空配列を返す
      warnings: options?.includeWarnings !== false ? warnings : [],
      video_info: videoResult.videoInfo,
    };

    if (isDevelopment()) {
      logger.info('[page.analyze] Video Mode detection completed', {
        patternCount: patterns.length,
        warningCount: warnings.length,
        processingTimeMs: result.processingTimeMs,
        videoInfo: videoResult.videoInfo,
      });
    }

    return result;
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[page.analyze] Video Mode detection failed', { error, url });
    }

    return {
      success: false,
      patternCount: 0,
      categoryBreakdown: {},
      warningCount: 1,
      a11yWarningCount: 0,
      perfWarningCount: 0,
      processingTimeMs: Date.now() - startTime,
      error: {
        code: 'MOTION_VIDEO_MODE_FAILED',
        message: error instanceof Error ? error.message : 'Video mode detection failed',
      },
    };
  }
}

// =====================================================
// Runtime Mode Detection (v0.1.0)
// Playwrightでランタイムアニメーション検出
// =====================================================
async function executeRuntimeModeDetection(
  url: string,
  options: PageAnalyzeInput['motionOptions'] | undefined,
  startTime: number,
  extendedContext?: MotionDetectionExtendedContext
): Promise<MotionServiceResult> {
  if (!url) {
    return {
      success: false,
      patternCount: 0,
      categoryBreakdown: {},
      warningCount: 1,
      a11yWarningCount: 0,
      perfWarningCount: 0,
      processingTimeMs: Date.now() - startTime,
      error: {
        code: 'MOTION_RUNTIME_MODE_URL_REQUIRED',
        message: 'detection_mode="runtime" requires a URL. Please provide a valid URL.',
      },
    };
  }

  try {
    if (isDevelopment()) {
      logger.info('[page.analyze] Executing Runtime Mode detection', {
        url,
        runtime_options: options?.runtime_options,
      });
    }

    // motion.detectのexecuteRuntimeDetectionを呼び出し
    const runtimeResult = await executeRuntimeDetection(url, options?.runtime_options);

    // 結果をMotionServiceResult形式に変換
    // MotionPattern構造: name?, animation.duration, animation.easing?.type
    // Note: .map()は常に配列を返すため、MotionPatternData[]で型定義（undefined不要）
    // properties: MotionPattern.propertiesはオブジェクト配列なので、property名のみ抽出してstring[]に変換
    const patterns: MotionPatternData[] = runtimeResult.patterns.map((p) => ({
      id: p.id,
      name: p.name ?? 'unnamed',
      type: p.type,
      category: p.category ?? 'runtime',
      trigger: p.trigger ?? 'load',
      duration: p.animation?.duration,
      easing: p.animation?.easing?.type ?? 'linear',
      properties: p.properties?.map((prop) => prop.property) ?? [],
      propertiesDetailed: p.properties?.map(prop => ({
        property: prop.property,
        from: String(prop.from ?? ''),
        to: String(prop.to ?? ''),
      })) ?? [],
      performance: {
        level: 'high' as const,
        usesTransform: false,
        usesOpacity: false,
      },
      accessibility: {
        respectsReducedMotion: false,
      },
    }));

    const warnings: MotionServiceResult['warnings'] = runtimeResult.warnings.map((w) => ({
      code: w.code,
      severity: w.severity,
      message: w.message,
    }));

    // layout_firstモードの警告追加
    if (extendedContext?.layoutFirstModeEnabled) {
      warnings.push({
        code: 'LAYOUT_FIRST_MODE_ENABLED',
        severity: 'info',
        message: 'layout_first mode is enabled. Using runtime detection mode.',
      });
    }

    // カテゴリ別の集計
    const categoryBreakdown: Record<string, number> = {};
    for (const pattern of patterns) {
      const category = pattern.category;
      categoryBreakdown[category] = (categoryBreakdown[category] ?? 0) + 1;
    }

    const result: MotionServiceResult = {
      success: true,
      patternCount: patterns.length,
      categoryBreakdown,
      warningCount: warnings.length,
      a11yWarningCount: 0,
      perfWarningCount: 0,
      processingTimeMs: Date.now() - startTime,
      patterns,
      // v0.1.0: exactOptionalPropertyTypes対応 - undefinedではなく空配列を返す
      warnings: options?.includeWarnings !== false ? warnings : [],
      runtime_info: runtimeResult.runtime_info,
    };

    if (isDevelopment()) {
      logger.info('[page.analyze] Runtime Mode detection completed', {
        patternCount: patterns.length,
        warningCount: warnings.length,
        processingTimeMs: result.processingTimeMs,
        runtimeInfo: runtimeResult.runtime_info,
      });
    }

    return result;
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[page.analyze] Runtime Mode detection failed', { error, url });
    }

    return {
      success: false,
      patternCount: 0,
      categoryBreakdown: {},
      warningCount: 1,
      a11yWarningCount: 0,
      perfWarningCount: 0,
      processingTimeMs: Date.now() - startTime,
      error: {
        code: 'MOTION_RUNTIME_MODE_FAILED',
        message: error instanceof Error ? error.message : 'Runtime mode detection failed',
      },
    };
  }
}

// =====================================================
// Hybrid Mode Detection (v0.1.0)
// CSS静的解析 + ランタイム検出の組み合わせ
// =====================================================
async function executeHybridModeDetection(
  html: string,
  url: string,
  options: PageAnalyzeInput['motionOptions'] | undefined,
  dbContext: MotionDetectionContext | undefined,
  extendedContext: MotionDetectionExtendedContext | undefined,
  preExtractedCssUrls: string[] | undefined,
  startTime: number,
  sharedBrowser?: Browser
): Promise<MotionServiceResult> {
  if (!url) {
    return {
      success: false,
      patternCount: 0,
      categoryBreakdown: {},
      warningCount: 1,
      a11yWarningCount: 0,
      perfWarningCount: 0,
      processingTimeMs: Date.now() - startTime,
      error: {
        code: 'MOTION_HYBRID_MODE_URL_REQUIRED',
        message: 'detection_mode="hybrid" requires a URL. Please provide a valid URL.',
      },
    };
  }

  try {
    if (isDevelopment()) {
      logger.info('[page.analyze] Executing Hybrid Mode detection (CSS + Runtime)', {
        url,
        htmlLength: html.length,
      });
    }

    // 並列でCSS静的解析とランタイム検出を実行
    // Note: optionsはすでにZod解析済みでデフォルト値が適用されているため、型アサーションは安全
    const cssOptionsForHybrid = { ...options, detection_mode: 'css' as const } as typeof options;
    const [cssResult, runtimeResult] = await Promise.all([
      // CSS静的解析（既存の処理を呼び出し）
      defaultDetectMotion(html, url, cssOptionsForHybrid, dbContext, extendedContext, preExtractedCssUrls, sharedBrowser),
      // ランタイム検出
      executeRuntimeDetection(url, options?.runtime_options).catch((err) => {
        if (isDevelopment()) {
          logger.warn('[page.analyze] Runtime detection failed in hybrid mode, using CSS results only', { error: err });
        }
        return null;
      }),
    ]);

    // 結果をマージ
    const mergedPatterns = [...(cssResult.patterns ?? [])];
    const mergedWarnings = [...(cssResult.warnings ?? [])];

    // ランタイム検出の結果を追加（成功した場合）
    // MotionPattern構造: name?, animation.duration, animation.easing?.type
    if (runtimeResult) {
      const runtimePatterns: MotionPatternData[] = runtimeResult.patterns.map((p) => ({
        id: p.id,
        name: p.name ?? 'unnamed',
        type: p.type,
        category: p.category ?? 'runtime',
        trigger: p.trigger ?? 'load',
        duration: p.animation?.duration,
        easing: p.animation?.easing?.type ?? 'linear',
        properties: p.properties?.map((prop) => prop.property) ?? [],
        propertiesDetailed: p.properties?.map(prop => ({
          property: prop.property,
          from: String(prop.from ?? ''),
          to: String(prop.to ?? ''),
        })) ?? [],
        performance: {
          level: 'high' as const,
          usesTransform: false,
          usesOpacity: false,
        },
        accessibility: {
          respectsReducedMotion: false,
        },
      }));
      mergedPatterns.push(...runtimePatterns);

      const runtimeWarnings = runtimeResult.warnings.map((w) => ({
        code: w.code,
        severity: w.severity,
        message: w.message,
      }));
      mergedWarnings.push(...runtimeWarnings);
    } else {
      mergedWarnings.push({
        code: 'HYBRID_RUNTIME_DETECTION_SKIPPED',
        severity: 'warning',
        message: 'Runtime detection failed in hybrid mode. Only CSS static analysis results are included.',
      });
    }

    // layout_firstモードの警告追加
    if (extendedContext?.layoutFirstModeEnabled) {
      mergedWarnings.push({
        code: 'LAYOUT_FIRST_MODE_ENABLED',
        severity: 'info',
        message: 'layout_first mode is enabled. Hybrid detection may be limited.',
      });
    }

    // カテゴリ別の集計を再計算
    const categoryBreakdown: Record<string, number> = {};
    for (const pattern of mergedPatterns) {
      const category = pattern.category;
      categoryBreakdown[category] = (categoryBreakdown[category] ?? 0) + 1;
    }

    // v0.1.0: exactOptionalPropertyTypes対応 - undefinedプロパティは条件付きスプレッドで設定
    // v0.1.0: WebGL検出結果のマージ追加（hybrid mode fix）
    const result: MotionServiceResult = {
      success: true,
      patternCount: mergedPatterns.length,
      categoryBreakdown,
      warningCount: mergedWarnings.length,
      a11yWarningCount: cssResult.a11yWarningCount,
      perfWarningCount: cssResult.perfWarningCount,
      processingTimeMs: Date.now() - startTime,
      patterns: mergedPatterns,
      warnings: options?.includeWarnings !== false ? mergedWarnings : [],
      // CSS結果からの追加情報（undefinedの場合は設定しない）
      ...(cssResult.frame_capture && { frame_capture: cssResult.frame_capture }),
      ...(cssResult.frame_analysis && { frame_analysis: cssResult.frame_analysis }),
      ...(cssResult.js_animation_summary && { js_animation_summary: cssResult.js_animation_summary }),
      ...(cssResult.js_animations && { js_animations: cssResult.js_animations }),
      // WebGL検出結果（CSS modeで実行され、結果がここでマージされる）
      ...(cssResult.webgl_animation_summary && { webgl_animation_summary: cssResult.webgl_animation_summary }),
      ...(cssResult.webgl_animations && { webgl_animations: cssResult.webgl_animations }),
      ...(cssResult.webgl_animation_error && { webgl_animation_error: cssResult.webgl_animation_error }),
      // ランタイム情報（undefinedの場合は設定しない）
      ...(runtimeResult?.runtime_info && { runtime_info: runtimeResult.runtime_info }),
    };

    if (isDevelopment()) {
      logger.info('[page.analyze] Hybrid Mode detection completed', {
        cssPatternCount: cssResult.patternCount,
        runtimePatternCount: runtimeResult?.patterns.length ?? 0,
        webglPatternCount: cssResult.webgl_animation_summary?.totalPatterns ?? 0,
        totalPatternCount: mergedPatterns.length,
        processingTimeMs: result.processingTimeMs,
      });
    }

    return result;
  } catch (error) {
    if (isDevelopment()) {
      logger.error('[page.analyze] Hybrid Mode detection failed', { error, url });
    }

    return {
      success: false,
      patternCount: 0,
      categoryBreakdown: {},
      warningCount: 1,
      a11yWarningCount: 0,
      perfWarningCount: 0,
      processingTimeMs: Date.now() - startTime,
      error: {
        code: 'MOTION_HYBRID_MODE_FAILED',
        message: error instanceof Error ? error.message : 'Hybrid mode detection failed',
      },
    };
  }
}
