// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.inspect MCPツール - ハンドラーとツール定義
 *
 * HTMLを解析し、セクション構成・グリッド・タイポグラフィ情報を抽出します。
 *
 * 責務:
 * - 入力バリデーション（Zodスキーマ）
 * - サービス呼び出し（ID入力時）またはHTML直接処理
 * - ユーティリティ関数を使ったHTML解析
 * - MCP形式レスポンス生成
 * - エラーハンドリング（SERVICE_UNAVAILABLEフォールバック含む）
 *
 * @module tools/layout/inspect/inspect.tool
 */

import {
  layoutInspectInputSchema,
  type LayoutInspectInput,
  type LayoutInspectOutput,
  type LayoutInspectData,
} from './inspect.schemas';
import {
  detectSections,
  extractColors,
  analyzeTypography,
  detectGrid,
  detectVideos,
  detectVisualDecorations,
  generateTextRepresentation,
  getDefaultColorPalette,
  getDefaultTypography,
  getDefaultGrid,
  SECTION_DEFAULT_HEIGHTS,
  DEFAULT_SECTION_HEIGHT,
  inferColorRole,
} from './inspect.utils';
import { createLogger, isDevelopment } from '../../../utils/logger';
import { getToolErrorMessage } from '../../../utils/error-messages';
import { sanitizeHtml } from '../../../utils/html-sanitizer';
import type {
  VisionAnalysisResult,
  IVisionAnalyzer,
} from '../../../services/vision-adapter/interface';
import {
  getCSSAnalysisCacheService,
  type CSSAnalysisResult,
} from '../../../services/css-analysis-cache.service';
// Vision CPU完走保証 Phase 3: HardwareDetector, TimeoutCalculator, ImageOptimizer 統合
import {
  HardwareDetector,
  HardwareType,
} from '../../../services/vision/hardware-detector';
import { TimeoutCalculator } from '../../../services/vision/timeout-calculator';
import { ImageOptimizer } from '../../../services/vision/image-optimizer';

// =====================================================
// Logger
// =====================================================

const logger = createLogger('layout.inspect');

// =====================================================
// サービスインターフェース（DI用）
// =====================================================

/**
 * スクリーンショット入力型
 */
export interface ScreenshotInput {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  width?: number;
  height?: number;
}

/**
 * layout.inspect サービスインターフェース
 *
 * DI（依存性注入）パターンを使用して、外部サービスとの連携を行います。
 */
export interface ILayoutInspectService {
  /** WebページをIDで取得 */
  getWebPageById?: (id: string) => Promise<{ id: string; htmlContent: string } | null>;
  /** セクションパターンを保存 */
  saveSectionPattern?: (pattern: unknown) => Promise<boolean>;
  /** Vision APIで解析（HTMLから） */
  analyzeWithVision?: (html: string) => Promise<VisionAnalysisResult>;
  /** Vision APIでスクリーンショット解析（Ollama LlamaVision使用） */
  analyzeScreenshot?: (screenshot: ScreenshotInput) => Promise<VisionAnalysisResult>;
  /** Vision Analyzerインスタンスを取得 */
  getVisionAnalyzer?: () => IVisionAnalyzer | null;
}

/** サービスファクトリ関数 */
let serviceFactory: (() => ILayoutInspectService) | null = null;

/**
 * サービスファクトリを設定
 *
 * @param factory - サービスインスタンスを生成するファクトリ関数
 */
export function setLayoutInspectServiceFactory(
  factory: () => ILayoutInspectService
): void {
  serviceFactory = factory;
}

/**
 * サービスファクトリをリセット（テスト用）
 */
export function resetLayoutInspectServiceFactory(): void {
  serviceFactory = null;
}

// =====================================================
// ハンドラー
// =====================================================

/**
 * layout.inspect ツールハンドラー
 *
 * HTMLを解析し、以下の情報を抽出します:
 * - セクション構成（hero, features, cta等）
 * - 色情報（パレット、ドミナント、背景、テキスト色）
 * - タイポグラフィ（フォント、サイズスケール、行間）
 * - グリッド構成（flex, grid, float）
 * - Embedding用テキスト表現
 *
 * @param input - ツール入力（id または html）
 * @returns 解析結果
 */
export async function layoutInspectHandler(
  input: unknown
): Promise<LayoutInspectOutput> {
  if (isDevelopment()) {
    logger.info('layout.inspect called', {
      hasInput: input !== null && input !== undefined,
    });
  }

  // 入力バリデーション
  let validated: LayoutInspectInput;
  try {
    validated = layoutInspectInputSchema.parse(input);
  } catch (error) {
    if (isDevelopment()) {
      logger.error('Validation error', { error });
    }
    return {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: error instanceof Error ? error.message : 'Invalid input',
      },
    };
  }

  // オプションのデフォルト値適用
  const options = {
    detectSections: validated.options?.detectSections ?? true,
    extractColors: validated.options?.extractColors ?? true,
    analyzeTypography: validated.options?.analyzeTypography ?? true,
    detectGrid: validated.options?.detectGrid ?? true,
    useVision: validated.options?.useVision ?? false,
  };

  // Vision CPU完走保証オプション（Phase 3）
  // デフォルト値を適用してから使用
  const visionOptions = {
    visionForceCpu: validated.options?.visionOptions?.visionForceCpu ?? false,
    visionEnableProgress: validated.options?.visionOptions?.visionEnableProgress ?? false,
    visionFallbackToHtmlOnly: validated.options?.visionOptions?.visionFallbackToHtmlOnly ?? true,
    visionTimeoutMs: validated.options?.visionOptions?.visionTimeoutMs,
    visionImageMaxSize: validated.options?.visionOptions?.visionImageMaxSize,
  };

  let html = validated.html;
  let webPageId: string | undefined;

  // IDが指定されている場合はDBから取得
  if (validated.id && !html) {
    try {
      const service = serviceFactory?.();
      if (service?.getWebPageById) {
        const webPage = await service.getWebPageById(validated.id);
        if (!webPage) {
          return {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `WebPage not found: ${validated.id}`,
            },
          };
        }
        html = webPage.htmlContent;
        webPageId = webPage.id;
      } else {
        // サービスが利用できない場合、改善されたエラーメッセージを返す
        const message =
          getToolErrorMessage('layout.inspect', 'SERVICE_UNAVAILABLE') ??
          'WebPage service is not available. Please use the "html" parameter to provide HTML content directly instead of using "id".';
        if (isDevelopment()) {
          logger.warn('WebPage service not available, returning SERVICE_UNAVAILABLE', {
            id: validated.id,
          });
        }
        return {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message,
          },
        };
      }
    } catch (error) {
      if (isDevelopment()) {
        logger.error('DB error', { error });
      }
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Database error',
        },
      };
    }
  }

  // =====================================================
  // スクリーンショットモード処理
  // Vision CPU完走保証 Phase 3: HardwareDetector, TimeoutCalculator, ImageOptimizer 統合
  // =====================================================
  if (validated.screenshot) {
    if (isDevelopment()) {
      logger.info('Screenshot mode: analyzing with Vision API', {
        mimeType: validated.screenshot.mimeType,
        base64Length: validated.screenshot.base64.length,
        visionOptions,
      });
    }

    try {
      const service = serviceFactory?.();
      if (!service?.analyzeScreenshot) {
        const message =
          getToolErrorMessage('layout.inspect', 'SERVICE_UNAVAILABLE') ??
          'Vision API service is not available. Ollama with llama3.2-vision model is required for screenshot analysis.';
        return {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message,
          },
        };
      }

      // =====================================================
      // Vision CPU完走保証: ハードウェア検出とタイムアウト計算
      // =====================================================
      const hardwareDetector = new HardwareDetector();
      const timeoutCalculator = new TimeoutCalculator();
      const imageOptimizer = new ImageOptimizer();

      // ハードウェア検出（visionForceCpuの場合はスキップ）
      let hardwareType = HardwareType.CPU;
      if (!visionOptions.visionForceCpu) {
        try {
          const hardwareInfo = await hardwareDetector.detect();
          hardwareType = hardwareInfo.type;
          if (isDevelopment()) {
            logger.debug('Hardware detected', {
              type: hardwareType,
              isGpuAvailable: hardwareInfo.isGpuAvailable,
              vramBytes: hardwareInfo.vramBytes,
            });
          }
        } catch (hwError) {
          // ハードウェア検出失敗時はCPUフォールバック
          if (isDevelopment()) {
            logger.warn('Hardware detection failed, falling back to CPU', { error: hwError });
          }
        }
      } else {
        if (isDevelopment()) {
          logger.info('visionForceCpu enabled, using CPU mode');
        }
      }

      // 画像サイズ取得（Base64からバイトサイズを推定）
      const base64Data = validated.screenshot.base64;
      const imageSizeBytes = Math.ceil((base64Data.length * 3) / 4);

      // 画像最適化（CPU推論時）
      let optimizedBase64 = base64Data;
      let optimizedSizeBytes = imageSizeBytes;
      if (hardwareType === HardwareType.CPU) {
        try {
          // visionImageMaxSizeが指定されている場合、その値を使用
          const maxSize = visionOptions.visionImageMaxSize ?? 500_000;
          if (imageSizeBytes > maxSize) {
            const imageBuffer = Buffer.from(base64Data, 'base64');
            const optimizeResult = await imageOptimizer.optimizeForCPU(imageBuffer, {
              hardwareType,
            });
            optimizedBase64 = optimizeResult.buffer.toString('base64');
            optimizedSizeBytes = optimizeResult.optimizedSizeBytes;
            if (isDevelopment()) {
              logger.debug('Image optimized for CPU inference', {
                originalSize: imageSizeBytes,
                optimizedSize: optimizedSizeBytes,
                skipped: optimizeResult.skipped,
                compressionRatio: optimizeResult.compressionRatio,
                reductionPercent: Math.round((1 - optimizeResult.compressionRatio) * 100),
              });
            }
          }
        } catch (optError) {
          // 画像最適化失敗時は元の画像を使用
          if (isDevelopment()) {
            logger.warn('Image optimization failed, using original', { error: optError });
          }
        }
      }

      // タイムアウト計算
      const calculatedTimeout = timeoutCalculator.calculate(hardwareType, optimizedSizeBytes);
      const effectiveTimeout = visionOptions.visionTimeoutMs ?? calculatedTimeout;
      if (isDevelopment()) {
        logger.debug('Timeout calculated', {
          hardwareType,
          imageSizeBytes: optimizedSizeBytes,
          calculatedTimeout,
          effectiveTimeout,
          formatted: timeoutCalculator.formatTimeout(effectiveTimeout),
        });
      }

      // スクリーンショット入力を構築
      // exactOptionalPropertyTypes対応: undefinedではなくオプショナルプロパティとして構築
      const screenshotInput: ScreenshotInput = {
        base64: optimizedBase64,
        mimeType: validated.screenshot.mimeType,
      };
      if (validated.screenshot.width !== undefined) {
        screenshotInput.width = validated.screenshot.width;
      }
      if (validated.screenshot.height !== undefined) {
        screenshotInput.height = validated.screenshot.height;
      }

      // Vision API呼び出し（タイムアウト付き）
      let visionResult: VisionAnalysisResult;
      try {
        visionResult = await Promise.race([
          service.analyzeScreenshot(screenshotInput),
          new Promise<VisionAnalysisResult>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Vision API timeout after ${timeoutCalculator.formatTimeout(effectiveTimeout)}`)),
              effectiveTimeout
            )
          ),
        ]);
      } catch (timeoutError) {
        // タイムアウト時のフォールバック処理
        if (visionOptions.visionFallbackToHtmlOnly !== false) {
          if (isDevelopment()) {
            logger.warn('Vision API timeout, using fallback', {
              timeout: effectiveTimeout,
              error: timeoutError instanceof Error ? timeoutError.message : String(timeoutError),
            });
          }
          // フォールバック: 空のVision結果を返す
          visionResult = {
            success: false,
            features: [],
            error: timeoutError instanceof Error ? timeoutError.message : 'Vision API timeout',
            processingTimeMs: effectiveTimeout,
            modelName: 'timeout-fallback',
          };
        } else {
          // フォールバック無効の場合はエラーを返す
          throw timeoutError;
        }
      }

      if (!visionResult.success) {
        // visionFallbackToHtmlOnlyが有効な場合はデフォルト結果を返す
        if (visionOptions.visionFallbackToHtmlOnly !== false) {
          if (isDevelopment()) {
            logger.warn('Vision API failed, using fallback result', {
              error: visionResult.error,
            });
          }
          const data: LayoutInspectData = {
            sections: [],
            colors: getDefaultColorPalette(),
            typography: getDefaultTypography(),
            grid: getDefaultGrid(),
            textRepresentation: '',
            visionFeatures: visionResult,
          };
          return {
            success: true,
            data,
          };
        }
        return {
          success: false,
          error: {
            code: 'VISION_API_ERROR',
            message: visionResult.error ?? 'Vision API analysis failed',
          },
        };
      }

      // Vision結果からLayoutInspectDataを構築
      const data: LayoutInspectData = {
        sections: [],
        colors: getDefaultColorPalette(),
        typography: getDefaultTypography(),
        grid: getDefaultGrid(),
        textRepresentation: '',
        visionFeatures: visionResult,
      };

      // Vision Analyzerからテキスト表現を取得
      const visionAnalyzer = service.getVisionAnalyzer?.();
      if (visionAnalyzer) {
        data.textRepresentation = visionAnalyzer.generateTextRepresentation(visionResult);
      }

      if (isDevelopment()) {
        logger.info('Screenshot analysis completed', {
          featureCount: visionResult.features.length,
          processingTimeMs: visionResult.processingTimeMs,
          hardwareType,
          effectiveTimeout,
        });
      }

      return {
        success: true,
        data,
      };
    } catch (error) {
      if (isDevelopment()) {
        logger.error('Screenshot analysis error', { error });
      }
      return {
        success: false,
        error: {
          code: 'VISION_API_ERROR',
          message: error instanceof Error ? error.message : 'Screenshot analysis failed',
        },
      };
    }
  }

  // =====================================================
  // HTMLモード処理
  // =====================================================

  // HTMLが取得できなかった場合
  if (!html) {
    return {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'No HTML content provided',
      },
    };
  }

  // HTMLサニタイズ（XSS対策）
  const originalLength = html.length;
  html = sanitizeHtml(html);
  if (isDevelopment()) {
    logger.debug('HTML sanitized', {
      originalLength,
      sanitizedLength: html.length,
    });
  }

  // =====================================================
  // CSS Analysis Cache 統合
  // =====================================================
  const cacheService = getCSSAnalysisCacheService();

  // サニタイズ後のHTMLが空の場合、キャッシュをスキップ（無効なHTMLでも解析を試行）
  const canUseCache = html.trim().length > 0;
  const cacheKey = canUseCache ? cacheService.generateCacheKey({ html }) : null;

  // キャッシュチェック（全オプションがtrueの場合のみ、キャッシュ結果を使用）
  const useCache =
    canUseCache &&
    options.detectSections &&
    options.extractColors &&
    options.analyzeTypography &&
    options.detectGrid &&
    !options.useVision; // Vision使用時はキャッシュ不可（非決定的）

  if (useCache && cacheKey) {
    try {
      const cachedResult = await cacheService.getLayoutInspectResult(cacheKey);
      if (cachedResult) {
        if (isDevelopment()) {
          logger.info('layout.inspect cache hit', { cacheKey });
        }

        // キャッシュから復元してLayoutInspectDataを構築
        // Note: mediaElements/visualDecorationsはキャッシュに含まれないため、常に再検出
        const mediaElements = detectVideos(html);
        const visualDecorations = detectVisualDecorations(html);

        // キャッシュからposition情報を復元するために、セクションタイプに基づいてデフォルトの高さを計算
        let currentY = 0;
        const sectionsWithPosition = cachedResult.sections.map((s, i) => {
          const sectionType = s.type as keyof typeof SECTION_DEFAULT_HEIGHTS;
          const sectionHeight = SECTION_DEFAULT_HEIGHTS[sectionType] ?? DEFAULT_SECTION_HEIGHT;
          const position = {
            startY: currentY,
            endY: currentY + sectionHeight,
            height: sectionHeight,
          };
          currentY += sectionHeight;
          return {
            id: `section-${i}`,
            type: s.type as LayoutInspectData['sections'][number]['type'],
            confidence: s.confidence,
            position,
            content: s.content
              ? {
                  headings: s.content.headings.map((h) => ({ level: h.level, text: h.text })),
                  paragraphs: [...s.content.paragraphs],
                  links: s.content.links.map((l) => ({ href: l.href, text: l.text })),
                  // alt: undefined を除外するためにスプレッド演算子を使用
                  images: s.content.images.map((ii) => ({
                    src: ii.src,
                    ...(ii.alt !== undefined && { alt: ii.alt }),
                  })),
                  buttons: s.content.buttons.map((b) => ({ text: b.text, type: b.type })),
                }
              : { headings: [], paragraphs: [], links: [], images: [], buttons: [] },
            style: {},
          };
        });

        // v0.1.0: キャッシュからrole情報を復元（color role detection fix）
        // キャッシュはhex文字列のみを保存するため、復元時にroleを再計算
        const sortedCachedColors = cachedResult.colors.palette.map((hex) => ({
          hex: hex.startsWith('#') ? hex.toUpperCase() : `#${hex}`.toUpperCase(),
          count: 1,
        }));
        const paletteWithRoles = sortedCachedColors.map((color, index) => ({
          ...color,
          role: inferColorRole(color.hex, index, sortedCachedColors),
        }));

        const data: LayoutInspectData = {
          // v0.1.0: キャッシュからcontent情報を復元（空配列ハードコードバグ修正）
          // v0.1.0: キャッシュからposition情報を復元（position.height=0バグ修正）
          sections: sectionsWithPosition,
          colors: {
            palette: paletteWithRoles,
            dominant: cachedResult.colors.dominant ?? cachedResult.colors.palette[0] ?? '#000000',
            background: cachedResult.colors.background ?? '#ffffff',
            text: cachedResult.colors.text ?? '#000000',
          },
          typography: {
            fonts: cachedResult.typography.fonts.map((f) => ({ family: f, weights: [400] })),
            headingScale: cachedResult.typography.scale ?? [32, 24, 20, 18, 16, 14],
            bodySize: parseInt(cachedResult.typography.baseSize ?? '16', 10) || 16,
            lineHeight: 1.5,
          },
          grid: {
            // キャッシュでは 'none' として保存されている場合、'unknown' に戻す
            type: (cachedResult.grid.type === 'none' ? 'unknown' : cachedResult.grid.type) as LayoutInspectData['grid']['type'],
            columns: cachedResult.grid.columns,
            gutterWidth: cachedResult.grid.gap ? parseInt(cachedResult.grid.gap, 10) : undefined,
            maxWidth: cachedResult.grid.maxWidth,
          },
          mediaElements,
          visualDecorations,
          textRepresentation: '',
        };

        if (webPageId) {
          data.id = webPageId;
        }

        // テキスト表現を再生成
        data.textRepresentation = generateTextRepresentation(data);

        return {
          success: true,
          data,
        };
      }
    } catch (cacheError) {
      // キャッシュエラーは無視して解析を続行
      if (isDevelopment()) {
        logger.warn('layout.inspect cache error, proceeding with analysis', { error: cacheError });
      }
    }
  }

  try {
    // 解析実行
    const sections = options.detectSections ? detectSections(html) : [];
    const colors = options.extractColors ? extractColors(html) : getDefaultColorPalette();
    const typography = options.analyzeTypography ? analyzeTypography(html) : getDefaultTypography();
    const grid = options.detectGrid ? detectGrid(html) : getDefaultGrid();
    const mediaElements = detectVideos(html);
    const visualDecorations = detectVisualDecorations(html);

    // Vision API連携
    let visionFeatures: VisionAnalysisResult | undefined;
    if (options.useVision) {
      try {
        const service = serviceFactory?.();
        if (service?.analyzeWithVision) {
          visionFeatures = await service.analyzeWithVision(html);
        }
      } catch (error) {
        if (isDevelopment()) {
          logger.error('Vision API error', { error });
        }
        visionFeatures = {
          success: false,
          features: [],
          error: error instanceof Error ? error.message : 'Vision API error',
          processingTimeMs: 0,
          modelName: 'unknown',
        };
      }
    }

    // データオブジェクト構築
    const data: LayoutInspectData = {
      sections,
      colors,
      typography,
      grid,
      mediaElements,
      visualDecorations,
      textRepresentation: '',
    };

    if (webPageId) {
      data.id = webPageId;
    }

    if (visionFeatures) {
      data.visionFeatures = visionFeatures;
    }

    // テキスト表現生成
    data.textRepresentation = generateTextRepresentation(data);

    // キャッシュに保存（全オプションがtrueの場合のみ）
    // cacheKeyがnullの場合（サニタイズ後のHTMLが空）はスキップ
    if (useCache && cacheKey) {
      try {
        const cacheResult: CSSAnalysisResult = {
          colors: {
            palette: colors.palette.map((c) => c.hex),
            dominant: colors.dominant,
            background: colors.background,
            text: colors.text,
          },
          typography: {
            fonts: typography.fonts.map((f) => f.family),
            baseSize: `${typography.bodySize}px`,
            scale: typography.headingScale,
          },
          grid: {
            type: grid.type === 'unknown' ? 'none' : grid.type,
            ...(grid.columns !== undefined && { columns: grid.columns }),
            ...(grid.gutterWidth !== undefined && { gap: `${grid.gutterWidth}px` }),
            ...(grid.maxWidth !== undefined && { maxWidth: grid.maxWidth }),
          },
          sections: sections.map((s) => ({
            type: s.type,
            confidence: s.confidence,
            // v0.1.0: キャッシュにcontent情報を保存（復元時の空配列バグ修正）
            content: {
              headings: s.content.headings.map((h) => ({ level: h.level, text: h.text })),
              paragraphs: [...s.content.paragraphs],
              links: s.content.links.map((l) => ({ href: l.href, text: l.text })),
              // alt: undefined を除外するためにスプレッド演算子を使用
              images: s.content.images.map((i) => ({
                src: i.src,
                ...(i.alt !== undefined && { alt: i.alt }),
              })),
              buttons: s.content.buttons.map((b) => ({ text: b.text, type: b.type })),
            },
          })),
          analyzedAt: Date.now(),
          cacheKey,
        };
        await cacheService.setLayoutInspectResult(cacheKey, cacheResult);
        if (isDevelopment()) {
          logger.debug('layout.inspect result cached', { cacheKey });
        }
      } catch (cacheError) {
        // キャッシュ保存エラーは無視
        if (isDevelopment()) {
          logger.warn('layout.inspect cache save error', { error: cacheError });
        }
      }
    }

    if (isDevelopment()) {
      logger.info('layout.inspect completed', {
        sectionCount: sections.length,
        colorCount: colors.palette.length,
        fontCount: typography.fonts.length,
        gridType: grid.type,
        visualDecorationsCount: visualDecorations.decorations.length,
        cached: useCache,
      });
    }

    return {
      success: true,
      data,
    };
  } catch (error) {
    if (isDevelopment()) {
      logger.error('Analysis error', { error });
    }
    return {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Analysis failed',
      },
    };
  }
}

// =====================================================
// ツール定義
// =====================================================

/**
 * layout.inspect MCPツール定義
 *
 * MCP (Model Context Protocol) 形式のツール定義オブジェクト
 */
export const layoutInspectToolDefinition = {
  name: 'layout.inspect',
  description:
    'Parse HTML and extract section structure, grid, typography info',
  annotations: {
    title: 'Layout Inspect',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: 'WebPage ID (from DB)',
      },
      html: {
        type: 'string',
        minLength: 1,
        description: 'Direct HTML input',
      },
      options: {
        type: 'object',
        description: 'Parse options',
        properties: {
          detectSections: {
            type: 'boolean',
            default: true,
            description: 'Detect sections (default: true)',
          },
          extractColors: {
            type: 'boolean',
            default: true,
            description: 'Extract colors (default: true)',
          },
          analyzeTypography: {
            type: 'boolean',
            default: true,
            description: 'Analyze typography (default: true)',
          },
          detectGrid: {
            type: 'boolean',
            default: true,
            description: 'Detect grid (default: true)',
          },
          useVision: {
            type: 'boolean',
            default: false,
            description: 'Use Vision API (default: false)',
          },
          visionOptions: {
            type: 'object',
            description:
              'Vision CPU completion guarantee options (effective when useVision=true)',
            properties: {
              visionTimeoutMs: {
                type: 'number',
                description:
                  'Vision API timeout in milliseconds (1000-1200000, default: auto-calculated based on hardware)',
                minimum: 1000,
                maximum: 1200000,
              },
              visionImageMaxSize: {
                type: 'number',
                description:
                  'Maximum image size in bytes for optimization (1024-10000000, default: no limit)',
                minimum: 1024,
                maximum: 10000000,
              },
              visionForceCpu: {
                type: 'boolean',
                default: false,
                description:
                  'Force CPU mode (skip GPU detection, default: false)',
              },
              visionEnableProgress: {
                type: 'boolean',
                default: false,
                description:
                  'Enable progress reporting for long operations (default: false)',
              },
              visionFallbackToHtmlOnly: {
                type: 'boolean',
                default: true,
                description:
                  'Fallback to HTML-only analysis on Vision failure (default: true)',
              },
            },
          },
        },
      },
    },
  },
};
