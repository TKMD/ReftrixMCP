// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LlamaVisionAdapter - Ollama経由でLlama Vision モデルを使用するアダプタ
 *
 * Webデザインスクリーンショットの解析機能を提供します。
 * IVisionAnalyzerインターフェースを実装し、プラガブルなアーキテクチャを実現します。
 *
 * @module vision-adapter/llama-vision.adapter
 * @see docs/plans/webdesign/00-overview.md
 */

import type {
  IVisionAnalyzer,
  VisionAnalysisOptions,
  VisionAnalysisResult,
  VisionFeature,
  VisionFeatureType,
  VisionFeatureData,
  LayoutStructureData,
  WhitespaceData,
} from './interface';

import {
  isLayoutStructureData,
  isColorPaletteData,
  isTypographyData,
  isVisualHierarchyData,
  isWhitespaceData,
  isDensityData,
  isRhythmData,
  isSectionBoundariesData,
  // Reftrix専用型ガード
  isMotionCandidatesData,
  isBrandToneData,
  isAiClichesData,
} from './interface';

import type {
  MotionCandidatesData,
  BrandToneData,
  AiClichesData,
  SectionBoundariesData,
  // Phase 2: Enhanced Mood & Brand Tone
  MoodType,
  BrandToneType,
  ColorContextInput,
  EnhancedVisionAnalysisOptions,
  MoodAnalysisResult,
  EnhancedBrandToneResult,
  EnhancedAnalysisResult,
  // v0.1.0: Validation and warnings
  VisionAnalysisWarning,
} from './interface';

import {
  LOW_CONFIDENCE_THRESHOLD,
  DEFAULT_MOOD_FALLBACK,
  DEFAULT_BRAND_TONE_FALLBACK,
} from './interface';

import { logger } from '../../utils/logger';

// =============================================================================
// 設定インターフェース
// =============================================================================

/**
 * LlamaVisionAdapter設定
 */
export interface LlamaVisionAdapterConfig {
  /** Ollama接続先URL (default: http://localhost:11434) */
  baseUrl?: string;
  /** 使用するモデル名 (default: llama3.2-vision) */
  modelName?: string;

  /** リクエストタイムアウト (default: 60000ms) */
  requestTimeout?: number;
  /** 接続タイムアウト (default: 10000ms) */
  connectionTimeout?: number;

  /** 最大リトライ回数 (default: 3) */
  maxRetries?: number;
  /** リトライ間隔 (default: 1000ms) */
  retryDelay?: number;

  /** デフォルトで解析する特徴タイプ */
  defaultFeatures?: VisionFeatureType[];
  /** 最大画像サイズ (bytes, default: 20MB) */
  maxImageSize?: number;

  /** システムプロンプト */
  systemPrompt?: string;
  /** 解析プロンプト */
  analysisPrompt?: string;
}

// =============================================================================
// Ollama API型定義
// =============================================================================

/**
 * Ollama /api/generate リクエスト
 */
interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  images?: string[];
  stream?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

/**
 * Ollama /api/generate レスポンス
 */
interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

/**
 * Ollama /api/tags レスポンス
 */
interface OllamaTagsResponse {
  models: Array<{
    name: string;
    size: number;
    modified_at: string;
  }>;
}

// =============================================================================
// 定数
// =============================================================================

const DEFAULT_CONFIG: Required<LlamaVisionAdapterConfig> = {
  baseUrl: 'http://localhost:11434',
  modelName: 'llama3.2-vision',
  requestTimeout: 60000,
  connectionTimeout: 10000,
  maxRetries: 3,
  retryDelay: 1000,
  defaultFeatures: [
    'layout_structure',
    'color_palette',
  ],
  maxImageSize: 20 * 1024 * 1024, // 20MB
  systemPrompt: '',
  analysisPrompt: '',
};

/**
 * シンプルなJSON出力プロンプト（llama3.2-vision最適化）
 *
 * llama3.2-visionは複雑なプロンプトでは不完全なJSONを生成する傾向があるため、
 * シンプルな構造で確実にJSON出力を得る戦略を採用。
 */
const DEFAULT_ANALYSIS_PROMPT = `You are a JSON generator. Your ONLY output must be valid JSON. No explanations, no markdown, no text before or after.

Look at this web page screenshot and analyze: {features_to_analyze}

Output this exact JSON structure:
{"layout":"grid-type","colors":["#hex1","#hex2","#hex3"],"mood":"dark-or-light","sections":["section1","section2"]}

JSON:`;

/**
 * セクション単位分析用プロンプト（llama3.2-vision最適化）
 *
 * 単一セクションのスクリーンショットに特化した分析プロンプト。
 * セクションタイプのヒントを活用してより正確な分析を行う。
 */
const SECTION_ANALYSIS_PROMPT = `You are analyzing a single section extracted from a web page screenshot. Focus specifically on the visual characteristics of THIS section only.

Section type hint: {section_type}

Analyze the following aspects:
1. Layout structure (grid, columns, alignment)
2. Color scheme (dominant colors, contrast)
3. Whitespace usage (minimal/moderate/generous)
4. Visual hierarchy (typography scale, emphasis)
5. Key visual elements (icons, images, buttons)

Output a concise JSON:
{"layout":"description", "colors":["#hex1","#hex2"], "whitespace":"level", "hierarchy":"description", "elements":["item1","item2"]}

JSON:`;

// =============================================================================
// Reftrix専用プロンプト
// =============================================================================

/**
 * セクション境界検出プロンプト
 *
 * スクリーンショットからセクション境界を視覚的に検出。
 * HTML解析では検出できないビジュアルセパレーターを認識。
 *
 * @version 0.1.0 - 18種類のセクションタイプをサポート
 */
const SECTION_BOUNDARY_DETECTION_PROMPT = `You are a web design section detector. Your ONLY output must be valid JSON. No explanations.

Look at this web page screenshot and identify ALL distinct visual sections.

Look for visual separators:
- Background color changes
- Large whitespace gaps
- Horizontal dividers/lines
- Full-width images/videos
- Different content patterns (grid vs text)

For each section found, output:
1. type: One of the following 18 section types:
   - hero: Hero/banner section at top
   - feature: Features/benefits grid
   - cta: Call-to-action with prominent button
   - testimonial: Customer reviews/quotes
   - pricing: Pricing plans/tables
   - footer: Page footer
   - navigation: Navigation bar/menu
   - gallery: Image gallery/showcase
   - about: About us/company info
   - contact: Contact form/info
   - partners: Partner/client logos
   - portfolio: Portfolio/work samples
   - team: Team members/staff
   - stories: Case studies/success stories
   - research: Research/insights/reports
   - subscribe: Newsletter signup
   - stats: Statistics/numbers/metrics
   - faq: FAQ accordion/questions
   - content: Generic content section
   - unknown: Cannot determine type
2. cues: visual indicators that define this section
3. position: top/upper/middle/lower/bottom

Output JSON array only:
{"sections":[{"type":"hero","cues":["dark background","large heading","centered content"],"position":"top"},{"type":"feature","cues":["3-column grid","icons","white background"],"position":"middle"}]}

JSON:`;

/**
 * モーション/インタラクション検出プロンプト
 *
 * スクリーンショットからアニメーション対象要素を推定。
 * CSS/JS静的解析の補完として使用。
 */
const MOTION_DETECTION_PROMPT = `You are a web animation detector. Your ONLY output must be valid JSON. No explanations.

Analyze this web page screenshot for potential animation and interaction elements.

Look for:
- Buttons and CTAs (hover effects expected)
- Cards with shadows (hover lift effects)
- Navigation menus (dropdown animations)
- Hero sections (entrance animations likely)
- Scroll indicators (scroll animations)
- Floating elements (parallax candidates)
- Image galleries (transition effects)
- Form inputs (focus animations)

Output JSON:
{"likely_animations":[{"element":"hero heading","type":"fade-in","confidence":0.8},{"element":"feature cards","type":"hover-scale","confidence":0.9}],"interactive_elements":["primary cta button","navigation menu","search input"],"scroll_triggers":["feature section","testimonial carousel"]}

JSON:`;

/**
 * AIクリシェ検出プロンプト
 *
 * AI生成デザインの典型的パターンを検出。
 * quality.evaluateのOriginality評価に活用。
 */
const AI_CLICHE_DETECTION_PROMPT = `You are an AI design cliche detector. Your ONLY output must be valid JSON. No explanations.

Detect AI-generated design clichés in this web page screenshot.

Common AI design clichés to look for:
- Abstract gradient spheres/orbs
- Generic 3D isometric illustrations
- Meaningless geometric patterns
- Over-saturated purple/blue gradients
- Stock-looking AI-generated people
- Floating UI elements without context
- Generic "hero with laptop" imagery
- Overly symmetrical layouts

Output JSON:
{"cliches_detected":[{"type":"gradient_orbs","location":"hero background","severity":"high"},{"type":"generic_isometric","location":"feature section","severity":"medium"}],"originality_score":65,"assessment":"moderate-ai-influence","suggestions":["Replace gradient orbs with brand-specific visuals","Use authentic photography instead of AI illustrations"]}

Types: gradient_orbs, generic_isometric, meaningless_patterns, oversaturated_gradients, ai_generated_people, floating_ui, generic_hero, symmetrical_layout, other
Severity: low, medium, high
Assessment: highly-original, mostly-original, moderate-ai-influence, heavy-ai-influence

JSON:`;

/**
 * ブランドトーン分析プロンプト
 *
 * デザインの視覚的トーンとブランドパーソナリティを分析。
 * 品質評価のContextuality軸に活用。
 */
const BRAND_TONE_ANALYSIS_PROMPT = `You are a brand tone analyzer. Your ONLY output must be valid JSON. No explanations.

Analyze the visual tone and brand personality of this web design.

Evaluate on these dimensions:
1. professionalism: minimal/moderate/bold
2. warmth: cold/neutral/warm
3. modernity: classic/contemporary/futuristic
4. energy: calm/balanced/dynamic
5. target_audience: enterprise/startup/creative/consumer

Look for indicators:
- Color temperature (cool vs warm)
- Shape language (sharp vs rounded)
- Imagery style (photography vs illustration)
- Layout density (spacious vs compact)

Output JSON:
{"professionalism":"moderate","warmth":"warm","modernity":"contemporary","energy":"balanced","target_audience":"startup","indicators":["rounded corners","warm accent colors","generous whitespace","lifestyle photography"]}

JSON:`;

// =============================================================================
// Phase 2: Enhanced Mood & Brand Tone Prompts
// =============================================================================

/**
 * Enhanced mood and brand tone analysis prompt
 *
 * Combines mood detection and brand tone analysis in a single request.
 * Optionally includes Phase 1 deterministic color context for improved accuracy.
 */
const ENHANCED_MOOD_BRAND_TONE_PROMPT = `You are a web design mood and brand tone analyzer. Your ONLY output must be valid JSON. No explanations.

Analyze this web design screenshot for mood and brand personality.

MOOD TYPES (choose primary and optionally secondary):
- professional: Clean, business-like, corporate feel
- playful: Fun, whimsical, casual
- minimal: Simple, clean, lots of whitespace
- bold: Strong visual impact, dramatic
- elegant: Sophisticated, refined, upscale
- modern: Contemporary, cutting-edge
- classic: Timeless, traditional
- energetic: Dynamic, vibrant, active
- calm: Peaceful, serene, relaxed
- luxurious: Premium, high-end, exclusive

BRAND TONE TYPES (choose primary and optionally secondary):
- corporate: Professional, formal, business-focused
- friendly: Approachable, warm, inviting
- luxury: Premium, exclusive, high-end
- tech-forward: Innovative, digital-first
- creative: Artistic, imaginative
- trustworthy: Reliable, dependable
- innovative: Forward-thinking, pioneering
- traditional: Established, conventional

{color_context_section}

Analyze and output JSON:
{"mood":{"primary":"minimal","secondary":"modern","confidence":0.85,"indicators":["generous whitespace","clean typography","neutral colors"]},"brand_tone":{"primary":"tech-forward","secondary":"trustworthy","confidence":0.8,"professionalism":"moderate","warmth":"neutral","modernity":"contemporary","energy":"balanced","target_audience":"startup","indicators":["modern sans-serif fonts","tech imagery","blue accent colors"]}}

JSON:`;

/**
 * Color context section template for enhanced prompt
 */
const COLOR_CONTEXT_SECTION_TEMPLATE = `
DETERMINISTIC COLOR ANALYSIS (use this as reference):
- Dominant colors: {dominant_colors}
- Theme: {theme} (confidence: {theme_confidence})
- Background: {background_color}
- Content density: {density} (0=sparse, 1=dense)
- Whitespace ratio: {whitespace_ratio}

Use this color data to inform your mood and brand tone analysis.`;

// =============================================================================
// LlamaVisionAdapter 実装
// =============================================================================

/**
 * LlamaVisionAdapter - Ollama Llama Vision モデルを使用したビジョン解析アダプタ
 *
 * @example
 * ```typescript
 * const adapter = new LlamaVisionAdapter({
 *   baseUrl: 'http://localhost:11434',
 *   modelName: 'llama3.2-vision',
 * });
 *
 * if (await adapter.isAvailable()) {
 *   const result = await adapter.analyze({
 *     imageBuffer: screenshotBuffer,
 *     mimeType: 'image/png',
 *     features: ['layout_structure', 'color_palette'],
 *   });
 *
 *   const textRep = adapter.generateTextRepresentation(result);
 * }
 * ```
 */
export class LlamaVisionAdapter implements IVisionAnalyzer {
  /** アダプタ名 */
  public readonly name = 'LlamaVisionAdapter';

  /** 使用するモデル名 */
  public readonly modelName: string;

  /** 設定 */
  private readonly config: Required<LlamaVisionAdapterConfig>;

  /**
   * コンストラクタ
   * @param config - アダプタ設定
   */
  constructor(config?: LlamaVisionAdapterConfig) {
    // 環境変数を優先
    const envBaseUrl = process.env.OLLAMA_BASE_URL;

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      baseUrl: envBaseUrl || config?.baseUrl || DEFAULT_CONFIG.baseUrl,
    };

    this.modelName = this.config.modelName;

    if (process.env.NODE_ENV === 'development') {
      logger.info('[LlamaVisionAdapter] Initialized with config:', {
        baseUrl: this.config.baseUrl,
        modelName: this.config.modelName,
        requestTimeout: this.config.requestTimeout,
        maxRetries: this.config.maxRetries,
      });
    }
  }

  // ===========================================================================
  // IVisionAnalyzer 実装
  // ===========================================================================

  /**
   * アダプタが利用可能かチェック
   * Ollamaサーバーへの接続と、指定モデルの存在を確認します。
   * 1回の/api/tags呼び出しで両方を確認します。
   */
  async isAvailable(): Promise<boolean> {
    try {
      return await this.checkModelAvailability();
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[LlamaVisionAdapter] isAvailable error:', error);
      }
      return false;
    }
  }

  /**
   * 画像を解析して特徴を抽出
   */
  async analyze(options: VisionAnalysisOptions): Promise<VisionAnalysisResult> {
    const startTime = Date.now();

    try {
      // 入力検証
      const validationError = this.validateInput(options);
      if (validationError) {
        return this.createErrorResult(validationError, startTime);
      }

      // 画像をbase64に変換
      const base64Image = await this.prepareImage(options.imageBuffer);

      // プロンプト生成
      const features = options.features || this.config.defaultFeatures;
      const prompt = this.buildPrompt(features, options.prompt);

      // リトライ付きでリクエスト実行
      const response = await this.executeWithRetry(
        () => this.sendGenerateRequest(base64Image, prompt, options.timeout)
      );

      // レスポンスパース
      const parseResult = this.parseResponse(response);

      const processingTimeMs = Date.now() - startTime;

      if (process.env.NODE_ENV === 'development') {
        logger.info('[LlamaVisionAdapter] Analysis completed:', {
          success: parseResult.success,
          featureCount: parseResult.features.length,
          processingTimeMs,
        });
      }

      return {
        ...parseResult,
        processingTimeMs,
        modelName: this.modelName,
        rawResponse: response,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      if (process.env.NODE_ENV === 'development') {
        console.error('[LlamaVisionAdapter] Analysis error:', error);
      }

      return this.createErrorResult(errorMessage, startTime);
    }
  }

  /**
   * テキスト表現を生成（Embedding用）
   */
  generateTextRepresentation(result: VisionAnalysisResult): string {
    if (!result.success && result.error) {
      return `Error: ${result.error}`;
    }

    if (result.features.length === 0) {
      return 'No features detected in the image.';
    }

    const parts: string[] = [];

    for (const feature of result.features) {
      const text = this.featureToText(feature);
      if (text) {
        parts.push(text);
      }
    }

    return parts.join('\n');
  }

  // ===========================================================================
  // セクション単位分析メソッド
  // ===========================================================================

  /**
   * セクション単位での画像解析
   *
   * 単一セクションのスクリーンショットに特化した分析を行います。
   * セクションタイプのヒントを活用してより正確な分析結果を得られます。
   *
   * @param options - 解析オプション（sectionTypeHint, sectionId を追加）
   * @returns 解析結果
   *
   * @example
   * ```typescript
   * const result = await adapter.analyzeSection({
   *   imageBuffer: sectionScreenshotBuffer,
   *   mimeType: 'image/png',
   *   sectionTypeHint: 'hero',
   *   sectionId: 'section-001',
   * });
   * ```
   */
  async analyzeSection(
    options: VisionAnalysisOptions & {
      sectionTypeHint?: string;
      sectionId?: string;
    }
  ): Promise<VisionAnalysisResult> {
    const startTime = Date.now();
    const { sectionTypeHint, sectionId, ...baseOptions } = options;

    if (process.env.NODE_ENV === 'development') {
      logger.info('[LlamaVision] analyzeSection:', {
        sectionTypeHint: sectionTypeHint || 'unknown',
        sectionId: sectionId || 'none',
        imageSize: options.imageBuffer.length,
      });
    }

    try {
      // 入力検証
      const validationError = this.validateInput(baseOptions);
      if (validationError) {
        return this.createErrorResult(validationError, startTime);
      }

      // 画像をbase64に変換
      const base64Image = await this.prepareImage(options.imageBuffer);

      // セクション用プロンプト生成
      const prompt = this.buildSectionPrompt(sectionTypeHint, options.prompt);

      // リトライ付きでリクエスト実行
      const response = await this.executeWithRetry(() =>
        this.sendGenerateRequest(base64Image, prompt, options.timeout)
      );

      // レスポンスパース（セクション用パーサー使用）
      const parseResult = this.parseSectionResponse(response, sectionTypeHint);

      const processingTimeMs = Date.now() - startTime;

      if (process.env.NODE_ENV === 'development') {
        logger.info('[LlamaVision] analyzeSection completed:', {
          sectionId: sectionId || 'none',
          success: parseResult.success,
          featureCount: parseResult.features.length,
          processingTimeMs,
        });
      }

      return {
        ...parseResult,
        processingTimeMs,
        modelName: this.modelName,
        rawResponse: response,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      if (process.env.NODE_ENV === 'development') {
        console.error('[LlamaVision] analyzeSection error:', {
          sectionId: sectionId || 'none',
          error: errorMessage,
        });
      }

      return this.createErrorResult(errorMessage, startTime);
    }
  }

  /**
   * セクション固有のテキスト表現を生成（Embedding用）
   *
   * セクションタイプを含めた、より詳細なテキスト表現を生成します。
   *
   * @param result - 解析結果
   * @param sectionType - セクションタイプ（hero, feature, cta等）
   * @returns テキスト表現
   *
   * @example
   * ```typescript
   * const textRep = adapter.generateSectionTextRepresentation(result, 'hero');
   * // "Section: hero\nLayout: single-column layout...\nColors: #000000, #ffffff..."
   * ```
   */
  generateSectionTextRepresentation(
    result: VisionAnalysisResult,
    sectionType?: string
  ): string {
    if (!result.success && result.error) {
      return `Section Error: ${result.error}`;
    }

    if (result.features.length === 0) {
      const typeInfo = sectionType ? ` (${sectionType})` : '';
      return `No features detected in section${typeInfo}.`;
    }

    const parts: string[] = [];

    // セクションタイプを先頭に追加
    if (sectionType) {
      parts.push(`Section: ${sectionType}`);
    }

    // 各特徴をテキスト化
    for (const feature of result.features) {
      const text = this.featureToText(feature);
      if (text) {
        parts.push(text);
      }
    }

    return parts.join('\n');
  }

  // ===========================================================================
  // Reftrix専用分析メソッド
  // ===========================================================================

  /**
   * セクション境界を視覚的に検出
   *
   * スクリーンショットからセクション境界を検出し、
   * HTML解析では検出できないビジュアルセパレーターも認識します。
   *
   * @param options - 解析オプション（imageBuffer, mimeType必須）
   * @returns セクション境界データを含む解析結果
   *
   * @example
   * ```typescript
   * const result = await adapter.detectSectionBoundaries({
   *   imageBuffer: screenshotBuffer,
   *   mimeType: 'image/png',
   * });
   * if (result.success) {
   *   const sections = result.data.sections;
   * }
   * ```
   */
  async detectSectionBoundaries(
    options: VisionAnalysisOptions
  ): Promise<{ success: boolean; data?: SectionBoundariesData; error?: string; processingTimeMs: number }> {
    const startTime = Date.now();

    if (process.env.NODE_ENV === 'development') {
      logger.info('[LlamaVision] detectSectionBoundaries: Starting analysis');
    }

    try {
      const validationError = this.validateInput(options);
      if (validationError) {
        return { success: false, error: validationError, processingTimeMs: Date.now() - startTime };
      }

      const base64Image = await this.prepareImage(options.imageBuffer);
      const response = await this.executeWithRetry(
        () => this.sendGenerateRequest(base64Image, SECTION_BOUNDARY_DETECTION_PROMPT, options.timeout)
      );

      const parsed = this.parseSectionBoundariesResponse(response);
      const processingTimeMs = Date.now() - startTime;

      // features配列からdataを抽出
      const sectionBoundariesFeature = parsed.features.find(f => f.type === 'section_boundaries');
      const data = sectionBoundariesFeature?.data as SectionBoundariesData | undefined;

      if (process.env.NODE_ENV === 'development') {
        logger.info('[LlamaVision] detectSectionBoundaries: Complete', {
          success: parsed.success,
          sectionCount: data?.sections?.length || 0,
          processingTimeMs,
        });
      }

      return {
        success: parsed.success,
        ...(data !== undefined && { data }),
        ...(parsed.error !== undefined && { error: parsed.error }),
        processingTimeMs,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage, processingTimeMs: Date.now() - startTime };
    }
  }

  /**
   * モーション候補を視覚的に検出
   *
   * スクリーンショットからアニメーション対象要素を推定します。
   * CSS/JS静的解析の補完として使用します。
   *
   * @param options - 解析オプション
   * @returns モーション候補データを含む解析結果
   */
  async detectMotionCandidates(
    options: VisionAnalysisOptions
  ): Promise<{ success: boolean; data?: MotionCandidatesData; error?: string; processingTimeMs: number }> {
    const startTime = Date.now();

    if (process.env.NODE_ENV === 'development') {
      logger.info('[LlamaVision] detectMotionCandidates: Starting analysis');
    }

    try {
      const validationError = this.validateInput(options);
      if (validationError) {
        return { success: false, error: validationError, processingTimeMs: Date.now() - startTime };
      }

      const base64Image = await this.prepareImage(options.imageBuffer);
      const response = await this.executeWithRetry(
        () => this.sendGenerateRequest(base64Image, MOTION_DETECTION_PROMPT, options.timeout)
      );

      const parsed = this.parseMotionCandidatesResponse(response);
      const processingTimeMs = Date.now() - startTime;

      // features配列からdataを抽出
      const motionCandidatesFeature = parsed.features.find(f => f.type === 'motion_candidates');
      const data = motionCandidatesFeature?.data as MotionCandidatesData | undefined;

      if (process.env.NODE_ENV === 'development') {
        logger.info('[LlamaVision] detectMotionCandidates: Complete', {
          success: parsed.success,
          animationCount: data?.likelyAnimations?.length || 0,
          processingTimeMs,
        });
      }

      return {
        success: parsed.success,
        ...(data !== undefined && { data }),
        ...(parsed.error !== undefined && { error: parsed.error }),
        processingTimeMs,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage, processingTimeMs: Date.now() - startTime };
    }
  }

  /**
   * AIクリシェを検出
   *
   * スクリーンショットからAI生成デザインの典型的パターンを検出します。
   * quality.evaluateのOriginality評価に活用します。
   *
   * @param options - 解析オプション
   * @returns AIクリシェデータを含む解析結果
   */
  async detectAiCliches(
    options: VisionAnalysisOptions
  ): Promise<{ success: boolean; data?: AiClichesData; error?: string; processingTimeMs: number }> {
    const startTime = Date.now();

    if (process.env.NODE_ENV === 'development') {
      logger.info('[LlamaVision] detectAiCliches: Starting analysis');
    }

    try {
      const validationError = this.validateInput(options);
      if (validationError) {
        return { success: false, error: validationError, processingTimeMs: Date.now() - startTime };
      }

      const base64Image = await this.prepareImage(options.imageBuffer);
      const response = await this.executeWithRetry(
        () => this.sendGenerateRequest(base64Image, AI_CLICHE_DETECTION_PROMPT, options.timeout)
      );

      const parsed = this.parseAiClichesResponse(response);
      const processingTimeMs = Date.now() - startTime;

      // features配列からdataを抽出
      const aiClichesFeature = parsed.features.find(f => f.type === 'ai_cliches');
      const data = aiClichesFeature?.data as AiClichesData | undefined;

      if (process.env.NODE_ENV === 'development') {
        logger.info('[LlamaVision] detectAiCliches: Complete', {
          success: parsed.success,
          clicheCount: data?.clichesDetected?.length || 0,
          originalityScore: data?.originalityScore,
          processingTimeMs,
        });
      }

      return {
        success: parsed.success,
        ...(data !== undefined && { data }),
        ...(parsed.error !== undefined && { error: parsed.error }),
        processingTimeMs,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage, processingTimeMs: Date.now() - startTime };
    }
  }

  /**
   * ブランドトーンを分析
   *
   * デザインの視覚的トーンとブランドパーソナリティを分析します。
   * 品質評価のContextuality軸に活用します。
   *
   * @param options - 解析オプション
   * @returns ブランドトーンデータを含む解析結果
   */
  async detectBrandTone(
    options: VisionAnalysisOptions
  ): Promise<{ success: boolean; data?: BrandToneData; error?: string; processingTimeMs: number }> {
    const startTime = Date.now();

    if (process.env.NODE_ENV === 'development') {
      logger.info('[LlamaVision] detectBrandTone: Starting analysis');
    }

    try {
      const validationError = this.validateInput(options);
      if (validationError) {
        return { success: false, error: validationError, processingTimeMs: Date.now() - startTime };
      }

      const base64Image = await this.prepareImage(options.imageBuffer);
      const response = await this.executeWithRetry(
        () => this.sendGenerateRequest(base64Image, BRAND_TONE_ANALYSIS_PROMPT, options.timeout)
      );

      const parsed = this.parseBrandToneResponse(response);
      const processingTimeMs = Date.now() - startTime;

      // features配列からdataを抽出
      const brandToneFeature = parsed.features.find(f => f.type === 'brand_tone');
      const data = brandToneFeature?.data as BrandToneData | undefined;

      if (process.env.NODE_ENV === 'development') {
        logger.info('[LlamaVision] detectBrandTone: Complete', {
          success: parsed.success,
          targetAudience: data?.targetAudience,
          processingTimeMs,
        });
      }

      return {
        success: parsed.success,
        ...(data !== undefined && { data }),
        ...(parsed.error !== undefined && { error: parsed.error }),
        processingTimeMs,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage, processingTimeMs: Date.now() - startTime };
    }
  }

  // ===========================================================================
  // Phase 2: Enhanced Mood & Brand Tone Analysis
  // ===========================================================================

  /**
   * Enhanced analysis with Phase 1 color context integration
   *
   * Combines Vision AI analysis with deterministic Phase 1 extraction results
   * for improved mood and brand tone detection accuracy.
   *
   * @param options - Enhanced analysis options with optional color context
   * @returns Enhanced analysis result with mood and brand tone
   *
   * @example
   * ```typescript
   * const result = await adapter.analyzeWithColorContext({
   *   imageBuffer: screenshotBuffer,
   *   mimeType: 'image/png',
   *   includeColorContext: true,
   *   colorContext: {
   *     dominantColors: ['#3B82F6', '#FFFFFF', '#1F2937'],
   *     theme: 'light',
   *     themeConfidence: 0.92,
   *     backgroundColor: '#FFFFFF',
   *     contentDensity: 0.35,
   *     whitespaceRatio: 0.65,
   *   },
   * });
   * ```
   */
  async analyzeWithColorContext(
    options: EnhancedVisionAnalysisOptions
  ): Promise<EnhancedAnalysisResult> {
    const startTime = Date.now();

    if (process.env.NODE_ENV === 'development') {
      logger.info('[LlamaVision] analyzeWithColorContext: Starting enhanced analysis', {
        includeColorContext: options.includeColorContext ?? false,
        hasColorContext: !!options.colorContext,
      });
    }

    try {
      // Input validation
      const validationError = this.validateInput(options);
      if (validationError) {
        return this.createEnhancedErrorResult(validationError, startTime);
      }

      // Prepare image
      const base64Image = await this.prepareImage(options.imageBuffer);

      // Build enhanced prompt with optional color context
      const prompt = this.buildEnhancedMoodBrandTonePrompt(options);

      // Execute request with retry
      const response = await this.executeWithRetry(
        () => this.sendGenerateRequest(base64Image, prompt, options.timeout)
      );

      // Parse enhanced response
      const result = this.parseEnhancedMoodBrandToneResponse(
        response,
        options.includeColorContext ?? false,
        options.colorContext
      );

      const processingTimeMs = Date.now() - startTime;

      if (process.env.NODE_ENV === 'development') {
        logger.info('[LlamaVision] analyzeWithColorContext: Complete', {
          success: result.success,
          primaryMood: result.mood?.primaryMood,
          primaryTone: result.brandTone?.primaryTone,
          colorContextUsed: result.mood?.colorContextUsed ?? false,
          processingTimeMs,
        });
      }

      return {
        ...result,
        processingTimeMs,
        modelName: this.modelName,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (process.env.NODE_ENV === 'development') {
        console.error('[LlamaVision] analyzeWithColorContext: Error', error);
      }

      return this.createEnhancedErrorResult(errorMessage, startTime);
    }
  }

  /**
   * Build enhanced mood/brand tone prompt with optional color context
   */
  private buildEnhancedMoodBrandTonePrompt(options: EnhancedVisionAnalysisOptions): string {
    let colorContextSection = '';

    if (options.includeColorContext && options.colorContext) {
      const ctx = options.colorContext;
      colorContextSection = COLOR_CONTEXT_SECTION_TEMPLATE
        .replace('{dominant_colors}', ctx.dominantColors?.join(', ') || 'unknown')
        .replace('{theme}', ctx.theme || 'unknown')
        .replace('{theme_confidence}', ctx.themeConfidence?.toFixed(2) || 'unknown')
        .replace('{background_color}', ctx.backgroundColor || 'unknown')
        .replace('{density}', ctx.contentDensity?.toFixed(2) || 'unknown')
        .replace('{whitespace_ratio}', ctx.whitespaceRatio?.toFixed(2) || 'unknown');
    }

    return ENHANCED_MOOD_BRAND_TONE_PROMPT.replace('{color_context_section}', colorContextSection);
  }

  /**
   * Parse enhanced mood/brand tone response
   * v0.1.0: Added validation, fallback values, and warnings
   */
  private parseEnhancedMoodBrandToneResponse(
    response: string,
    colorContextUsed: boolean,
    colorContext?: ColorContextInput
  ): Omit<EnhancedAnalysisResult, 'processingTimeMs' | 'modelName'> {
    const warnings: VisionAnalysisWarning[] = [];
    let fallbackUsed = false;

    try {
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        // v0.1.0: Use fallback values instead of failing
        warnings.push({
          code: 'PARSE_WARNING',
          message: 'No valid JSON found in response, using fallback values',
        });
        fallbackUsed = true;

        return {
          success: true,
          mood: { ...DEFAULT_MOOD_FALLBACK, colorContextUsed },
          brandTone: { ...DEFAULT_BRAND_TONE_FALLBACK, colorContextUsed },
          warnings,
          fallbackUsed,
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate and extract mood data
      // Support both brandTone (camelCase from tests) and brand_tone (snake_case from prompt)
      let mood = this.extractMoodResult(parsed.mood, colorContextUsed);
      let brandTone = this.extractEnhancedBrandToneResult(
        parsed.brandTone ?? parsed.brand_tone,
        colorContextUsed
      );

      // v0.1.0: Apply fallback values if extraction failed
      if (!mood) {
        mood = { ...DEFAULT_MOOD_FALLBACK, colorContextUsed };
        fallbackUsed = true;
        warnings.push({
          code: 'MOOD_FALLBACK_USED',
          message: 'Failed to extract mood from response, using fallback value',
          field: 'mood',
        });
      }

      if (!brandTone) {
        brandTone = { ...DEFAULT_BRAND_TONE_FALLBACK, colorContextUsed };
        fallbackUsed = true;
        warnings.push({
          code: 'BRAND_TONE_FALLBACK_USED',
          message: 'Failed to extract brand tone from response, using fallback value',
          field: 'brandTone',
        });
      }

      // v0.1.0: Check for low confidence and add warnings
      if (mood.confidence < LOW_CONFIDENCE_THRESHOLD) {
        warnings.push({
          code: 'LOW_CONFIDENCE_MOOD',
          message: `Mood confidence (${mood.confidence.toFixed(2)}) is below threshold (${LOW_CONFIDENCE_THRESHOLD})`,
          field: 'mood.confidence',
          value: mood.confidence,
          threshold: LOW_CONFIDENCE_THRESHOLD,
        });
      }

      if (brandTone.confidence < LOW_CONFIDENCE_THRESHOLD) {
        warnings.push({
          code: 'LOW_CONFIDENCE_BRAND_TONE',
          message: `Brand tone confidence (${brandTone.confidence.toFixed(2)}) is below threshold (${LOW_CONFIDENCE_THRESHOLD})`,
          field: 'brandTone.confidence',
          value: brandTone.confidence,
          threshold: LOW_CONFIDENCE_THRESHOLD,
        });
      }

      // v0.1.0: Check for missing indicators
      if (mood.indicators.length === 0 || (mood.indicators.length === 1 && mood.indicators[0] === 'fallback_value')) {
        warnings.push({
          code: 'MISSING_INDICATORS',
          message: 'Mood analysis lacks supporting indicators',
          field: 'mood.indicators',
        });
      }

      if (brandTone.indicators.length === 0 || (brandTone.indicators.length === 1 && brandTone.indicators[0] === 'fallback_value')) {
        warnings.push({
          code: 'MISSING_INDICATORS',
          message: 'Brand tone analysis lacks supporting indicators',
          field: 'brandTone.indicators',
        });
      }

      // Build color context summary if used
      const colorContextSummary = colorContextUsed && colorContext
        ? {
            dominantColors: colorContext.dominantColors || [],
            theme: colorContext.theme || 'mixed',
            density: colorContext.contentDensity || 0.5,
          }
        : undefined;

      // Build result object conditionally to satisfy exactOptionalPropertyTypes
      const result: Omit<EnhancedAnalysisResult, 'processingTimeMs' | 'modelName'> = {
        success: true,
        mood,
        brandTone,
      };

      if (colorContextSummary) {
        result.colorContext = colorContextSummary;
      }

      // v0.1.0: Add warnings and fallback flag if present
      if (warnings.length > 0) {
        result.warnings = warnings;
      }
      if (fallbackUsed) {
        result.fallbackUsed = fallbackUsed;
      }

      return result;
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[LlamaVision] Failed to parse enhanced response:', error);
        console.error('[LlamaVision] Raw response:', response);
      }

      // v0.1.0: Return fallback values with error warning instead of failing
      warnings.push({
        code: 'PARSE_WARNING',
        message: error instanceof Error ? error.message : 'Failed to parse response',
      });

      return {
        success: true,
        mood: { ...DEFAULT_MOOD_FALLBACK, colorContextUsed },
        brandTone: { ...DEFAULT_BRAND_TONE_FALLBACK, colorContextUsed },
        warnings,
        fallbackUsed: true,
      };
    }
  }

  /**
   * Extract mood result from parsed JSON
   * Supports both formats: { primary, secondary } and { primaryMood, secondaryMood }
   */
  private extractMoodResult(
    moodData: unknown,
    colorContextUsed: boolean
  ): MoodAnalysisResult | undefined {
    if (!moodData || typeof moodData !== 'object') {
      return undefined;
    }

    const data = moodData as Record<string, unknown>;

    const validMoods: MoodType[] = [
      'professional', 'playful', 'minimal', 'bold', 'elegant',
      'modern', 'classic', 'energetic', 'calm', 'luxurious',
    ];

    // Support both formats: { primary } and { primaryMood }
    const primaryMood = this.validateMoodType(data.primaryMood ?? data.primary, validMoods);
    if (!primaryMood) {
      return undefined;
    }

    const secondaryMood = this.validateMoodType(data.secondaryMood ?? data.secondary, validMoods);
    const confidence = typeof data.confidence === 'number'
      ? Math.min(1, Math.max(0, data.confidence))
      : 0.7;
    const indicators = Array.isArray(data.indicators)
      ? data.indicators.filter((i): i is string => typeof i === 'string')
      : [];

    return {
      primaryMood,
      ...(secondaryMood && { secondaryMood }),
      confidence,
      indicators,
      colorContextUsed,
    };
  }

  /**
   * Extract enhanced brand tone result from parsed JSON
   * Supports both formats: { primary, secondary } and { primaryTone, secondaryTone }
   */
  private extractEnhancedBrandToneResult(
    brandToneData: unknown,
    colorContextUsed: boolean
  ): EnhancedBrandToneResult | undefined {
    if (!brandToneData || typeof brandToneData !== 'object') {
      return undefined;
    }

    const data = brandToneData as Record<string, unknown>;

    const validTones: BrandToneType[] = [
      'corporate', 'friendly', 'luxury', 'tech-forward',
      'creative', 'trustworthy', 'innovative', 'traditional',
    ];

    // Support both formats: { primary } and { primaryTone }
    const primaryTone = this.validateBrandToneType(data.primaryTone ?? data.primary, validTones);
    if (!primaryTone) {
      return undefined;
    }

    const secondaryTone = this.validateBrandToneType(data.secondaryTone ?? data.secondary, validTones);
    const confidence = typeof data.confidence === 'number'
      ? Math.min(1, Math.max(0, data.confidence))
      : 0.7;

    // Extract dimension values with defaults
    // Support both snake_case (from prompt) and camelCase (from tests)
    const professionalism = this.validateEnum<'minimal' | 'moderate' | 'bold'>(
      data.professionalism,
      ['minimal', 'moderate', 'bold'],
      'moderate'
    );
    const warmth = this.validateEnum<'cold' | 'neutral' | 'warm'>(
      data.warmth,
      ['cold', 'neutral', 'warm'],
      'neutral'
    );
    const modernity = this.validateEnum<'classic' | 'contemporary' | 'futuristic'>(
      data.modernity,
      ['classic', 'contemporary', 'futuristic'],
      'contemporary'
    );
    const energy = this.validateEnum<'calm' | 'balanced' | 'dynamic'>(
      data.energy,
      ['calm', 'balanced', 'dynamic'],
      'balanced'
    );
    const targetAudience = this.validateEnum<'enterprise' | 'startup' | 'creative' | 'consumer'>(
      data.targetAudience ?? data.target_audience,
      ['enterprise', 'startup', 'creative', 'consumer'],
      'consumer'
    );

    const indicators = Array.isArray(data.indicators)
      ? data.indicators.filter((i): i is string => typeof i === 'string')
      : [];

    return {
      primaryTone,
      ...(secondaryTone && { secondaryTone }),
      confidence,
      professionalism,
      warmth,
      modernity,
      energy,
      targetAudience,
      indicators,
      colorContextUsed,
    };
  }

  /**
   * Validate mood type
   */
  private validateMoodType(value: unknown, validMoods: MoodType[]): MoodType | undefined {
    if (typeof value === 'string' && validMoods.includes(value as MoodType)) {
      return value as MoodType;
    }
    return undefined;
  }

  /**
   * Validate brand tone type
   */
  private validateBrandToneType(value: unknown, validTones: BrandToneType[]): BrandToneType | undefined {
    if (typeof value === 'string' && validTones.includes(value as BrandToneType)) {
      return value as BrandToneType;
    }
    return undefined;
  }

  /**
   * Validate enum value with default
   */
  private validateEnum<T extends string>(
    value: unknown,
    validValues: T[],
    defaultValue: T
  ): T {
    if (typeof value === 'string' && validValues.includes(value as T)) {
      return value as T;
    }
    return defaultValue;
  }

  /**
   * Create enhanced error result
   */
  private createEnhancedErrorResult(error: string, startTime: number): EnhancedAnalysisResult {
    return {
      success: false,
      error,
      processingTimeMs: Date.now() - startTime,
      modelName: this.modelName,
    };
  }

  // ===========================================================================
  // 内部メソッド - サーバー確認
  // ===========================================================================

  /**
   * Ollamaサーバーへの接続を確認
   */
  protected async checkOllamaServer(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.connectionTimeout
      );

      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      return response.ok;
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[LlamaVisionAdapter] Server check failed:', error);
      }
      return false;
    }
  }

  /**
   * 指定モデルの利用可能性を確認
   */
  protected async checkModelAvailability(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.connectionTimeout
      );

      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as OllamaTagsResponse;

      if (!data.models || data.models.length === 0) {
        return false;
      }

      // モデル名の完全一致または前方一致で確認
      return data.models.some(
        (model) =>
          model.name === this.modelName ||
          model.name.startsWith(`${this.modelName}:`)
      );
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[LlamaVisionAdapter] Model check failed:', error);
      }
      return false;
    }
  }

  // ===========================================================================
  // 内部メソッド - 画像処理
  // ===========================================================================

  /**
   * 画像をbase64に変換
   */
  protected async prepareImage(image: Buffer): Promise<string> {
    return image.toString('base64');
  }

  // ===========================================================================
  // 内部メソッド - プロンプト生成
  // ===========================================================================

  /**
   * 解析プロンプトを生成
   */
  protected buildPrompt(
    features: VisionFeatureType[],
    customPrompt?: string
  ): string {
    const featureList = features.map((f) => `- ${f}`).join('\n');

    let basePrompt = this.config.analysisPrompt || DEFAULT_ANALYSIS_PROMPT;
    basePrompt = basePrompt.replace('{features_to_analyze}', featureList);

    // システムプロンプトを追加
    let fullPrompt = this.config.systemPrompt
      ? `${this.config.systemPrompt}\n\n${basePrompt}`
      : basePrompt;

    // カスタムプロンプトがあれば追加
    if (customPrompt) {
      fullPrompt = `${fullPrompt}\n\nAdditional instructions: ${customPrompt}`;
    }

    return fullPrompt;
  }

  /**
   * セクション用解析プロンプトを生成
   */
  protected buildSectionPrompt(
    sectionTypeHint?: string,
    customPrompt?: string
  ): string {
    // セクションタイプをプロンプトに埋め込む
    let basePrompt = SECTION_ANALYSIS_PROMPT.replace(
      '{section_type}',
      sectionTypeHint || 'unknown'
    );

    // システムプロンプトを追加
    let fullPrompt = this.config.systemPrompt
      ? `${this.config.systemPrompt}\n\n${basePrompt}`
      : basePrompt;

    // カスタムプロンプトがあれば追加
    if (customPrompt) {
      fullPrompt = `${fullPrompt}\n\nAdditional instructions: ${customPrompt}`;
    }

    return fullPrompt;
  }

  // ===========================================================================
  // 内部メソッド - API通信
  // ===========================================================================

  /**
   * Ollama /api/generate にリクエストを送信
   */
  private async sendGenerateRequest(
    base64Image: string,
    prompt: string,
    timeout?: number
  ): Promise<string> {
    const requestTimeout = timeout || this.config.requestTimeout;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), requestTimeout);

    try {
      const requestBody: OllamaGenerateRequest = {
        model: this.modelName,
        prompt,
        images: [base64Image],
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 4096,
        },
      };

      const response = await fetch(`${this.config.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const statusCode = response.status;
        const statusText = response.statusText;

        // 4xxエラーはリトライ不可としてマーク
        if (statusCode >= 400 && statusCode < 500) {
          const error = new Error(
            `HTTP ${statusCode}: ${statusText}`
          ) as Error & { noRetry?: boolean };
          error.noRetry = true;
          throw error;
        }

        throw new Error(`HTTP ${statusCode}: ${statusText}`);
      }

      const data = (await response.json()) as OllamaGenerateResponse;

      if (!data.response) {
        throw new Error('Empty response from Ollama');
      }

      return data.response;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Request timeout');
      }

      throw error;
    }
  }

  /**
   * リトライ付きでリクエストを実行
   */
  private async executeWithRetry(
    operation: () => Promise<string>
  ): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // 4xxエラーはリトライしない
        if ((lastError as Error & { noRetry?: boolean }).noRetry) {
          throw lastError;
        }

        if (attempt < this.config.maxRetries) {
          if (process.env.NODE_ENV === 'development') {
            logger.info(
              `[LlamaVisionAdapter] Retry attempt ${attempt + 1}/${this.config.maxRetries}`
            );
          }
          await this.delay(this.config.retryDelay);
        }
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  /**
   * 指定時間待機
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ===========================================================================
  // 内部メソッド - レスポンスパース
  // ===========================================================================

  /**
   * Ollamaレスポンスをパース
   *
   * 2つのフォーマットをサポート:
   * 1. 詳細形式: {"features": [...], "summary": "..."}
   * 2. シンプル形式: {"layout": "...", "colors": [...], "mood": "...", "sections": [...]}
   */
  protected parseResponse(response: string): {
    success: boolean;
    features: VisionFeature[];
    error?: string;
  } {
    try {
      // JSONブロックを抽出（マークダウンコードブロック対応）
      const jsonString = this.extractJson(response);

      if (!jsonString) {
        return {
          success: false,
          features: [],
          error: 'No valid JSON found in response',
        };
      }

      const parsed = JSON.parse(jsonString);

      // フォーマット1: 詳細形式 {"features": [...]}
      if (parsed.features && Array.isArray(parsed.features)) {
        const validFeatures = parsed.features
          .map((f: unknown) => this.validateFeature(f))
          .filter((f: VisionFeature | null): f is VisionFeature => f !== null);

        return {
          success: true,
          features: validFeatures,
        };
      }

      // フォーマット2: シンプル形式 {"layout": "...", "colors": [...], ...}
      if (parsed.layout || parsed.colors || parsed.sections) {
        const features: VisionFeature[] = [];

        // layout -> layout_structure
        if (typeof parsed.layout === 'string') {
          features.push({
            type: 'layout_structure',
            confidence: 0.8,
            data: {
              type: 'layout_structure',
              gridType: parsed.layout as 'single-column' | 'two-column' | 'three-column' | 'grid' | 'masonry' | 'asymmetric',
              mainAreas: parsed.sections || [],
              description: `${parsed.layout} layout`,
            },
          });
        }

        // colors -> color_palette
        if (Array.isArray(parsed.colors)) {
          features.push({
            type: 'color_palette',
            confidence: 0.8,
            data: {
              type: 'color_palette',
              dominantColors: parsed.colors.filter((c: unknown) => typeof c === 'string'),
              mood: typeof parsed.mood === 'string' ? parsed.mood : 'neutral',
              contrast: 'medium' as const,
            },
          });
        }

        // sections -> section_boundaries
        if (Array.isArray(parsed.sections) && parsed.sections.length > 0) {
          features.push({
            type: 'section_boundaries',
            confidence: 0.7,
            data: {
              type: 'section_boundaries',
              sections: parsed.sections.map((name: string, index: number) => ({
                type: name,
                startY: index * 300,
                endY: (index + 1) * 300,
                confidence: 0.7,
              })),
            },
          });
        }

        if (features.length > 0) {
          return {
            success: true,
            features,
          };
        }
      }

      return {
        success: false,
        features: [],
        error: 'Invalid response structure: no recognizable format',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Parse error';
      return {
        success: false,
        features: [],
        error: `Failed to parse response: ${errorMessage}`,
      };
    }
  }

  /**
   * セクション分析用レスポンスをパース
   *
   * セクション分析プロンプトからのレスポンスをパースします。
   * 期待するフォーマット:
   * {"layout":"description", "colors":["#hex1","#hex2"], "whitespace":"level", "hierarchy":"description", "elements":["item1","item2"]}
   */
  protected parseSectionResponse(
    response: string,
    sectionTypeHint?: string
  ): {
    success: boolean;
    features: VisionFeature[];
    error?: string;
  } {
    try {
      // JSONブロックを抽出（マークダウンコードブロック対応）
      const jsonString = this.extractJson(response);

      if (!jsonString) {
        return {
          success: false,
          features: [],
          error: 'No valid JSON found in section response',
        };
      }

      const parsed = JSON.parse(jsonString);
      const features: VisionFeature[] = [];

      // layout -> layout_structure
      if (typeof parsed.layout === 'string') {
        // gridTypeへのマッピング
        const gridTypeMapping: Record<string, LayoutStructureData['gridType']> = {
          'single-column': 'single-column',
          'single column': 'single-column',
          'one column': 'single-column',
          'two-column': 'two-column',
          'two column': 'two-column',
          '2 column': 'two-column',
          'three-column': 'three-column',
          'three column': 'three-column',
          '3 column': 'three-column',
          'grid': 'grid',
          'masonry': 'masonry',
          'asymmetric': 'asymmetric',
        };

        const layoutLower = parsed.layout.toLowerCase();
        let gridType: LayoutStructureData['gridType'] = 'single-column';

        for (const [key, value] of Object.entries(gridTypeMapping)) {
          if (layoutLower.includes(key)) {
            gridType = value;
            break;
          }
        }

        features.push({
          type: 'layout_structure',
          confidence: 0.8,
          data: {
            type: 'layout_structure',
            gridType,
            mainAreas: Array.isArray(parsed.elements) ? parsed.elements : [],
            description: parsed.layout,
          },
        });
      }

      // colors -> color_palette
      if (Array.isArray(parsed.colors) && parsed.colors.length > 0) {
        features.push({
          type: 'color_palette',
          confidence: 0.8,
          data: {
            type: 'color_palette',
            dominantColors: parsed.colors.filter((c: unknown) => typeof c === 'string'),
            mood: typeof parsed.mood === 'string' ? parsed.mood : 'neutral',
            contrast: 'medium' as const,
          },
        });
      }

      // whitespace -> whitespace
      if (typeof parsed.whitespace === 'string') {
        const amountMapping: Record<string, WhitespaceData['amount']> = {
          'minimal': 'minimal',
          'moderate': 'moderate',
          'generous': 'generous',
          'extreme': 'extreme',
        };

        const whitespaceValue = parsed.whitespace.toLowerCase();
        const amount = amountMapping[whitespaceValue] || 'moderate';

        features.push({
          type: 'whitespace',
          confidence: 0.7,
          data: {
            type: 'whitespace',
            amount,
            distribution: 'even' as const,
          },
        });
      }

      // hierarchy -> visual_hierarchy
      if (typeof parsed.hierarchy === 'string') {
        features.push({
          type: 'visual_hierarchy',
          confidence: 0.7,
          data: {
            type: 'visual_hierarchy',
            focalPoints: Array.isArray(parsed.elements) ? parsed.elements.slice(0, 3) : [],
            flowDirection: 'top-to-bottom' as const,
            emphasisTechniques: [parsed.hierarchy],
          },
        });
      }

      if (features.length > 0) {
        if (process.env.NODE_ENV === 'development') {
          logger.info('[LlamaVision] parseSectionResponse:', {
            sectionTypeHint: sectionTypeHint || 'unknown',
            featureCount: features.length,
            featureTypes: features.map((f) => f.type),
          });
        }

        return {
          success: true,
          features,
        };
      }

      // フォールバック: 既存のparseResponseを使用
      return this.parseResponse(response);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Parse error';

      if (process.env.NODE_ENV === 'development') {
        console.error('[LlamaVision] parseSectionResponse error:', errorMessage);
      }

      return {
        success: false,
        features: [],
        error: `Failed to parse section response: ${errorMessage}`,
      };
    }
  }

  // ===========================================================================
  // Reftrix専用パースメソッド
  // ===========================================================================

  /**
   * セクション境界検出レスポンスをパース
   *
   * 期待するフォーマット:
   * {"sections":[{"type":"hero","cues":["dark background","large heading"],"position":"top"}]}
   */
  protected parseSectionBoundariesResponse(response: string): {
    success: boolean;
    features: VisionFeature[];
    error?: string;
  } {
    try {
      const jsonString = this.extractJson(response);

      if (!jsonString) {
        return {
          success: false,
          features: [],
          error: 'No valid JSON found in section boundaries response',
        };
      }

      const parsed = JSON.parse(jsonString);
      const features: VisionFeature[] = [];

      if (Array.isArray(parsed.sections) && parsed.sections.length > 0) {
        // セクション境界データを構築
        const sectionBoundaries: SectionBoundariesData = {
          type: 'section_boundaries',
          sections: parsed.sections.map(
            (
              s: { type?: string; cues?: string[]; position?: string },
              index: number
            ) => ({
              type: typeof s.type === 'string' ? s.type : 'unknown',
              cues: Array.isArray(s.cues) ? s.cues : [],
              position: typeof s.position === 'string' ? s.position : 'middle',
              startY: index * 300, // 推定値
              endY: (index + 1) * 300,
              confidence: 0.7,
            })
          ),
        };

        features.push({
          type: 'section_boundaries',
          confidence: 0.75,
          data: sectionBoundaries,
        });

        if (process.env.NODE_ENV === 'development') {
          logger.info('[LlamaVision] parseSectionBoundariesResponse:', {
            sectionCount: parsed.sections.length,
            types: parsed.sections.map((s: { type?: string }) => s.type),
          });
        }
      }

      return {
        success: features.length > 0,
        features,
        ...(features.length === 0 && { error: 'No sections found in response' }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Parse error';
      return {
        success: false,
        features: [],
        error: `Failed to parse section boundaries response: ${errorMessage}`,
      };
    }
  }

  /**
   * モーション候補検出レスポンスをパース
   *
   * 期待するフォーマット:
   * {"likely_animations":[{"element":"hero heading","type":"fade-in","confidence":0.8}],
   *  "interactive_elements":["button","menu"],"scroll_triggers":["section"]}
   */
  protected parseMotionCandidatesResponse(response: string): {
    success: boolean;
    features: VisionFeature[];
    error?: string;
  } {
    try {
      const jsonString = this.extractJson(response);

      if (!jsonString) {
        return {
          success: false,
          features: [],
          error: 'No valid JSON found in motion candidates response',
        };
      }

      const parsed = JSON.parse(jsonString);
      const features: VisionFeature[] = [];

      // motion_candidates feature を構築
      // アニメーションタイプのマッピング
      const validAnimationTypes: MotionCandidatesData['likelyAnimations'][number]['animationType'][] = [
        'fade-in', 'slide', 'scale', 'rotate', 'hover-scale', 'hover-lift', 'parallax', 'other'
      ];
      const mapAnimationType = (t: string): MotionCandidatesData['likelyAnimations'][number]['animationType'] => {
        const normalized = t.toLowerCase().replace(/[_\s]/g, '-');
        return validAnimationTypes.includes(normalized as typeof validAnimationTypes[number])
          ? (normalized as typeof validAnimationTypes[number])
          : 'other';
      };

      const motionData: MotionCandidatesData = {
        type: 'motion_candidates',
        likelyAnimations: Array.isArray(parsed.likely_animations)
          ? parsed.likely_animations.map(
              (a: { element?: string; type?: string; confidence?: number }) => ({
                element: typeof a.element === 'string' ? a.element : 'unknown',
                animationType: typeof a.type === 'string' ? mapAnimationType(a.type) : 'other',
                confidence: typeof a.confidence === 'number' ? a.confidence : 0.5,
              })
            )
          : [],
        interactiveElements: Array.isArray(parsed.interactive_elements)
          ? parsed.interactive_elements.filter((e: unknown) => typeof e === 'string')
          : [],
        scrollTriggers: Array.isArray(parsed.scroll_triggers)
          ? parsed.scroll_triggers.filter((t: unknown) => typeof t === 'string')
          : [],
      };

      features.push({
        type: 'motion_candidates',
        confidence: 0.7,
        data: motionData,
      });

      if (process.env.NODE_ENV === 'development') {
        logger.info('[LlamaVision] parseMotionCandidatesResponse:', {
          animationCount: motionData.likelyAnimations.length,
          interactiveCount: motionData.interactiveElements.length,
          scrollTriggerCount: motionData.scrollTriggers.length,
        });
      }

      return {
        success: true,
        features,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Parse error';
      return {
        success: false,
        features: [],
        error: `Failed to parse motion candidates response: ${errorMessage}`,
      };
    }
  }

  /**
   * AIクリシェ検出レスポンスをパース
   *
   * 期待するフォーマット:
   * {"cliches_detected":[{"type":"gradient_orbs","location":"hero","severity":"high"}],
   *  "originality_score":65,"assessment":"moderate-ai-influence","suggestions":["..."]}
   */
  protected parseAiClichesResponse(response: string): {
    success: boolean;
    features: VisionFeature[];
    error?: string;
  } {
    try {
      const jsonString = this.extractJson(response);

      if (!jsonString) {
        return {
          success: false,
          features: [],
          error: 'No valid JSON found in AI cliches response',
        };
      }

      const parsed = JSON.parse(jsonString);
      const features: VisionFeature[] = [];

      // ai_cliches feature を構築
      // 有効なclicheTypeへのマッピング
      const validClicheTypes = [
        'gradient_orbs', 'generic_isometric', 'meaningless_patterns',
        'oversaturated_gradients', 'ai_generated_people', 'floating_ui',
        'generic_hero', 'symmetrical_layout', 'other',
      ] as const;
      const mapClicheType = (t: string): AiClichesData['clichesDetected'][number]['clicheType'] => {
        const normalized = t.toLowerCase().replace(/[_\s]/g, '_');
        return validClicheTypes.includes(normalized as typeof validClicheTypes[number])
          ? (normalized as typeof validClicheTypes[number])
          : 'other';
      };

      const clichesData: AiClichesData = {
        type: 'ai_cliches',
        clichesDetected: Array.isArray(parsed.cliches_detected)
          ? parsed.cliches_detected.map(
              (c: { type?: string; location?: string; severity?: string }) => ({
                clicheType: typeof c.type === 'string' ? mapClicheType(c.type) : 'other',
                location: typeof c.location === 'string' ? c.location : 'unknown',
                severity: (typeof c.severity === 'string' &&
                  ['low', 'medium', 'high'].includes(c.severity))
                  ? (c.severity as 'low' | 'medium' | 'high')
                  : 'medium',
              })
            )
          : [],
        originalityScore:
          typeof parsed.originality_score === 'number' ? parsed.originality_score : 50,
        assessment: (typeof parsed.assessment === 'string' &&
          ['highly-original', 'mostly-original', 'moderate-ai-influence', 'heavy-ai-influence'].includes(parsed.assessment))
          ? (parsed.assessment as AiClichesData['assessment'])
          : 'moderate-ai-influence',
        suggestions: Array.isArray(parsed.suggestions)
          ? parsed.suggestions.filter((s: unknown) => typeof s === 'string')
          : [],
      };

      features.push({
        type: 'ai_cliches',
        confidence: 0.75,
        data: clichesData,
      });

      if (process.env.NODE_ENV === 'development') {
        logger.info('[LlamaVision] parseAiClichesResponse:', {
          clicheCount: clichesData.clichesDetected.length,
          originalityScore: clichesData.originalityScore,
          assessment: clichesData.assessment,
        });
      }

      return {
        success: true,
        features,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Parse error';
      return {
        success: false,
        features: [],
        error: `Failed to parse AI cliches response: ${errorMessage}`,
      };
    }
  }

  /**
   * ブランドトーン分析レスポンスをパース
   *
   * 期待するフォーマット:
   * {"professionalism":"moderate","warmth":"warm","modernity":"contemporary",
   *  "energy":"balanced","target_audience":"startup","indicators":["..."]}
   */
  protected parseBrandToneResponse(response: string): {
    success: boolean;
    features: VisionFeature[];
    error?: string;
  } {
    try {
      const jsonString = this.extractJson(response);

      if (!jsonString) {
        return {
          success: false,
          features: [],
          error: 'No valid JSON found in brand tone response',
        };
      }

      const parsed = JSON.parse(jsonString);
      const features: VisionFeature[] = [];

      // brand_tone feature を構築
      const brandToneData: BrandToneData = {
        type: 'brand_tone',
        professionalism: (typeof parsed.professionalism === 'string' &&
          ['minimal', 'moderate', 'bold'].includes(parsed.professionalism))
          ? (parsed.professionalism as 'minimal' | 'moderate' | 'bold')
          : 'moderate',
        warmth: (typeof parsed.warmth === 'string' &&
          ['cold', 'neutral', 'warm'].includes(parsed.warmth))
          ? (parsed.warmth as 'cold' | 'neutral' | 'warm')
          : 'neutral',
        modernity: (typeof parsed.modernity === 'string' &&
          ['classic', 'contemporary', 'futuristic'].includes(parsed.modernity))
          ? (parsed.modernity as 'classic' | 'contemporary' | 'futuristic')
          : 'contemporary',
        energy: (typeof parsed.energy === 'string' &&
          ['calm', 'balanced', 'dynamic'].includes(parsed.energy))
          ? (parsed.energy as 'calm' | 'balanced' | 'dynamic')
          : 'balanced',
        targetAudience: (typeof parsed.target_audience === 'string' &&
          ['enterprise', 'startup', 'creative', 'consumer'].includes(parsed.target_audience))
          ? (parsed.target_audience as 'enterprise' | 'startup' | 'creative' | 'consumer')
          : 'consumer',
        indicators: Array.isArray(parsed.indicators)
          ? parsed.indicators.filter((i: unknown) => typeof i === 'string')
          : [],
      };

      features.push({
        type: 'brand_tone',
        confidence: 0.7,
        data: brandToneData,
      });

      if (process.env.NODE_ENV === 'development') {
        logger.info('[LlamaVision] parseBrandToneResponse:', {
          professionalism: brandToneData.professionalism,
          warmth: brandToneData.warmth,
          modernity: brandToneData.modernity,
          targetAudience: brandToneData.targetAudience,
        });
      }

      return {
        success: true,
        features,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Parse error';
      return {
        success: false,
        features: [],
        error: `Failed to parse brand tone response: ${errorMessage}`,
      };
    }
  }

  /**
   * レスポンスからJSONを抽出
   */
  private extractJson(response: string): string | null {
    // マークダウンコードブロックからJSONを抽出
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
      return this.sanitizeJsonString(codeBlockMatch[1].trim());
    }

    // 直接JSONとしてパースを試みる
    const trimmed = response.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return this.sanitizeJsonString(trimmed);
    }

    // JSONオブジェクトを探す
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return this.sanitizeJsonString(jsonMatch[0]);
    }

    return null;
  }

  /**
   * LLM生成JSONの一般的な問題を修正
   *
   * - プロパティ名の先頭/末尾のスペースを除去
   * - 末尾のカンマを除去
   * - 一般的なtypoを修正（section_boudaries -> section_boundaries）
   */
  private sanitizeJsonString(json: string): string {
    let sanitized = json;

    // プロパティ名の先頭スペースを除去（" distribution" -> "distribution"）
    sanitized = sanitized.replace(/"(\s+)(\w+)"(\s*:)/g, '"$2"$3');

    // 末尾のカンマを除去（JSONではエラー）
    sanitized = sanitized.replace(/,(\s*[}\]])/g, '$1');

    // 一般的なtypoを修正
    const typoFixes: [RegExp, string][] = [
      [/"section_boudaries"/g, '"section_boundaries"'],
      [/"visual_hierachy"/g, '"visual_hierarchy"'],
      [/"typograhy"/g, '"typography"'],
      [/"color_pallete"/g, '"color_palette"'],
    ];

    for (const [pattern, replacement] of typoFixes) {
      sanitized = sanitized.replace(pattern, replacement);
    }

    return sanitized;
  }

  /**
   * 特徴データを検証
   *
   * Ollamaからのレスポンスは2つの形式をサポート:
   * 1. ネスト形式: { type, confidence, data: {...} }
   * 2. フラット形式: { type, ...data } (confidenceはオプション)
   */
  private validateFeature(feature: unknown): VisionFeature | null {
    if (!feature || typeof feature !== 'object') {
      return null;
    }

    const f = feature as Record<string, unknown>;

    // typeは必須
    if (typeof f.type !== 'string') {
      return null;
    }

    // typeの検証
    const validTypes: VisionFeatureType[] = [
      'layout_structure',
      'color_palette',
      'typography',
      'visual_hierarchy',
      'whitespace',
      'density',
      'rhythm',
      'section_boundaries',
      // Reftrix専用タイプ
      'motion_candidates',
      'brand_tone',
      'ai_cliches',
    ];

    if (!validTypes.includes(f.type as VisionFeatureType)) {
      // typo対応: visual_hierachy -> visual_hierarchy
      if (f.type === 'visual_hierachy') {
        f.type = 'visual_hierarchy';
      } else {
        return null;
      }
    }

    // confidence取得（オプション、デフォルト0.8）
    let confidence = 0.8;
    if (typeof f.confidence === 'number' && f.confidence >= 0 && f.confidence <= 1) {
      confidence = f.confidence;
    }

    // データ構造を決定（ネスト形式 vs フラット形式）
    let data: Record<string, unknown>;

    if (f.data && typeof f.data === 'object') {
      // ネスト形式: { type, confidence, data: {...} }
      data = f.data as Record<string, unknown>;
    } else {
      // フラット形式: { type, ...data }
      // type と confidence 以外のすべてのプロパティをdataとして扱う
      const { type: _type, confidence: _conf, ...rest } = f;
      data = rest as Record<string, unknown>;
    }

    // データにtypeを追加
    data.type = f.type;

    // 特徴タイプ別の検証
    if (!this.validateFeatureData(f.type as VisionFeatureType, data)) {
      if (process.env.NODE_ENV === 'development') {
        logger.debug('[LlamaVisionAdapter] Feature validation failed:', {
          type: f.type,
          dataKeys: Object.keys(data),
        });
      }
      return null;
    }

    return {
      type: f.type as VisionFeatureType,
      confidence,
      data: data as unknown as VisionFeatureData,
    };
  }

  /**
   * 特徴データの詳細検証
   */
  private validateFeatureData(
    type: VisionFeatureType,
    data: Record<string, unknown>
  ): boolean {
    switch (type) {
      case 'layout_structure':
        return (
          typeof data.gridType === 'string' &&
          Array.isArray(data.mainAreas) &&
          typeof data.description === 'string'
        );

      case 'color_palette':
        return (
          Array.isArray(data.dominantColors) &&
          typeof data.mood === 'string' &&
          typeof data.contrast === 'string'
        );

      case 'typography':
        return (
          typeof data.headingStyle === 'string' &&
          typeof data.bodyStyle === 'string' &&
          Array.isArray(data.hierarchy)
        );

      case 'visual_hierarchy':
        return (
          Array.isArray(data.focalPoints) &&
          typeof data.flowDirection === 'string' &&
          Array.isArray(data.emphasisTechniques)
        );

      case 'whitespace':
        return (
          typeof data.amount === 'string' &&
          typeof data.distribution === 'string'
        );

      case 'density':
        return (
          typeof data.level === 'string' && typeof data.description === 'string'
        );

      case 'rhythm':
        return (
          typeof data.pattern === 'string' &&
          typeof data.description === 'string'
        );

      case 'section_boundaries':
        return Array.isArray(data.sections);

      // Reftrix専用タイプ
      case 'motion_candidates':
        return (
          Array.isArray(data.likelyAnimations) &&
          Array.isArray(data.interactiveElements) &&
          Array.isArray(data.scrollTriggers)
        );

      case 'brand_tone':
        return (
          typeof data.professionalism === 'string' &&
          typeof data.warmth === 'string' &&
          typeof data.modernity === 'string' &&
          typeof data.energy === 'string' &&
          typeof data.targetAudience === 'string'
        );

      case 'ai_cliches':
        return (
          Array.isArray(data.clichesDetected) &&
          typeof data.originalityScore === 'number' &&
          typeof data.assessment === 'string'
        );

      default:
        return false;
    }
  }

  // ===========================================================================
  // 内部メソッド - ヘルパー
  // ===========================================================================

  /**
   * 入力を検証
   */
  private validateInput(options: VisionAnalysisOptions): string | null {
    if (!options.imageBuffer || options.imageBuffer.length === 0) {
      return 'Image buffer is empty';
    }

    if (options.imageBuffer.length > this.config.maxImageSize) {
      return `Image size exceeds maximum allowed (${this.config.maxImageSize} bytes)`;
    }

    return null;
  }

  /**
   * エラー結果を生成
   */
  private createErrorResult(
    error: string,
    startTime: number
  ): VisionAnalysisResult {
    return {
      success: false,
      features: [],
      error,
      processingTimeMs: Date.now() - startTime,
      modelName: this.modelName,
    };
  }

  /**
   * 特徴をテキストに変換
   */
  private featureToText(feature: VisionFeature): string {
    const { data } = feature;

    if (isLayoutStructureData(data)) {
      return `Layout: ${data.gridType} layout with areas: ${data.mainAreas.join(', ')}. ${data.description}`;
    }

    if (isColorPaletteData(data)) {
      return `Colors: ${data.dominantColors.join(', ')}. Mood: ${data.mood}. Contrast: ${data.contrast}.`;
    }

    if (isTypographyData(data)) {
      return `Typography: Headings use ${data.headingStyle}, body uses ${data.bodyStyle}. Hierarchy: ${data.hierarchy.join(' > ')}.`;
    }

    if (isVisualHierarchyData(data)) {
      return `Visual hierarchy: ${data.flowDirection} flow with focal points: ${data.focalPoints.join(', ')}. Techniques: ${data.emphasisTechniques.join(', ')}.`;
    }

    if (isWhitespaceData(data)) {
      return `Whitespace: ${data.amount} amount with ${data.distribution} distribution.`;
    }

    if (isDensityData(data)) {
      return `Density: ${data.level}. ${data.description}`;
    }

    if (isRhythmData(data)) {
      return `Rhythm: ${data.pattern} pattern. ${data.description}`;
    }

    if (isSectionBoundariesData(data)) {
      const sectionList = data.sections
        .map((s) => `${s.type} (${s.startY}-${s.endY}px)`)
        .join(', ');
      return `Sections: ${sectionList || 'none detected'}.`;
    }

    // Reftrix専用タイプ
    if (isMotionCandidatesData(data)) {
      const animations = data.likelyAnimations
        .map((a) => `${a.element}: ${a.animationType}`)
        .join(', ');
      return `Motion candidates: ${animations || 'none'}. Interactive: ${data.interactiveElements.join(', ') || 'none'}. Scroll triggers: ${data.scrollTriggers.join(', ') || 'none'}.`;
    }

    if (isBrandToneData(data)) {
      return `Brand tone: ${data.professionalism} professionalism, ${data.warmth} warmth, ${data.modernity} modernity, ${data.energy} energy. Target: ${data.targetAudience}. Indicators: ${data.indicators.join(', ')}.`;
    }

    if (isAiClichesData(data)) {
      const clicheList = data.clichesDetected
        .map((c) => `${c.clicheType} (${c.severity})`)
        .join(', ');
      return `AI cliches: ${clicheList || 'none'}. Originality: ${data.originalityScore}/100. Assessment: ${data.assessment}. Suggestions: ${data.suggestions.join('; ')}.`;
    }

    return '';
  }
}
