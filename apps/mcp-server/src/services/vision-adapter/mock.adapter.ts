// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MockVisionAdapter - テスト用モックビジョン解析アダプタ
 *
 * IVisionAnalyzerインターフェースを完全実装したテスト用モックアダプタです。
 * テスト用のモックデータ生成、設定可能な遅延、エラー率シミュレーション、
 * シード値による再現可能な結果をサポートします。
 *
 * @module vision-adapter/mock.adapter
 * @see docs/plans/webdesign/00-overview.md (ビジョン解析アダプタ セクション)
 */

import type {
  IVisionAnalyzer,
  VisionAnalysisOptions,
  VisionAnalysisResult,
  VisionFeature,
  VisionFeatureType,
  VisionFeatureData,
  LayoutStructureData,
  ColorPaletteData,
  TypographyData,
  VisualHierarchyData,
  WhitespaceData,
  DensityData,
  RhythmData,
  SectionBoundariesData,
  // Reftrix専用タイプ
  MotionCandidatesData,
  BrandToneData,
  AiClichesData,
} from './interface';

// =============================================================================
// 型定義
// =============================================================================

/**
 * MockVisionAdapterの設定オプション
 */
export interface MockVisionAdapterConfig {
  /** アダプタ名 (デフォルト: 'MockVisionAdapter') */
  name?: string;
  /** モデル名 (デフォルト: 'mock-vision-1.0') */
  modelName?: string;

  /** 遅延時間（ミリ秒） (デフォルト: 100) */
  latencyMs?: number;
  /** 遅延のばらつき（±ミリ秒） (デフォルト: 0) */
  latencyVariance?: number;
  /** エラー発生率 (0-1) (デフォルト: 0) */
  errorRate?: number;

  /** 乱数シード値（再現可能な結果用） */
  seed?: number;
  /** デフォルトで抽出する特徴タイプ */
  defaultFeatures?: VisionFeatureType[];
  /** デフォルトの信頼度 (0-1) (デフォルト: 0.85) */
  defaultConfidence?: number;

  /** カスタムレスポンス（画像ハッシュ -> 結果） */
  customResponses?: Map<string, VisionAnalysisResult>;

  /** 可用性 (デフォルト: true) */
  isAvailable?: boolean;
}

// =============================================================================
// 内部ヘルパー
// =============================================================================

/**
 * 簡易シード付き乱数生成器（Mulberry32アルゴリズム）
 */
class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  /**
   * 0-1の間の乱数を生成
   */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * 指定範囲の整数を生成
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * 配列からランダムに選択
   */
  pick<T>(array: readonly T[]): T {
    const index = this.nextInt(0, array.length - 1);
    return array[index] as T;
  }

  /**
   * 配列をシャッフル（Fisher-Yates）
   */
  shuffle<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      const temp = result[i] as T;
      result[i] = result[j] as T;
      result[j] = temp;
    }
    return result;
  }
}

/**
 * 画像バッファのハッシュを生成（簡易版）
 */
function createImageHash(imageBuffer: Buffer): string {
  return Buffer.from(imageBuffer).toString('base64').slice(0, 32);
}

// =============================================================================
// モックデータ定義
// =============================================================================

const GRID_TYPES: LayoutStructureData['gridType'][] = [
  'single-column',
  'two-column',
  'three-column',
  'grid',
  'masonry',
  'asymmetric',
];

const MAIN_AREAS = [
  'header',
  'hero',
  'navigation',
  'sidebar',
  'main',
  'content',
  'features',
  'testimonials',
  'pricing',
  'cta',
  'footer',
];

const COLOR_PALETTES = [
  ['#3B82F6', '#1D4ED8', '#DBEAFE', '#FFFFFF', '#000000'],
  ['#10B981', '#059669', '#D1FAE5', '#FFFFFF', '#1F2937'],
  ['#F59E0B', '#D97706', '#FEF3C7', '#FFFFFF', '#111827'],
  ['#EF4444', '#DC2626', '#FEE2E2', '#FFFFFF', '#1F2937'],
  ['#8B5CF6', '#7C3AED', '#EDE9FE', '#FFFFFF', '#111827'],
  ['#EC4899', '#DB2777', '#FCE7F3', '#FFFFFF', '#1F2937'],
  ['#14B8A6', '#0D9488', '#CCFBF1', '#FFFFFF', '#134E4A'],
  ['#6366F1', '#4F46E5', '#E0E7FF', '#FFFFFF', '#1E1B4B'],
];

const MOODS = [
  'professional and trustworthy',
  'playful and energetic',
  'elegant and sophisticated',
  'modern and minimalist',
  'warm and inviting',
  'bold and confident',
  'calm and serene',
  'dynamic and exciting',
];

const HEADING_STYLES = [
  'bold sans-serif, large size',
  'elegant serif, medium weight',
  'modern geometric sans',
  'classic serif with high contrast',
  'rounded friendly sans-serif',
  'condensed impactful display',
];

const BODY_STYLES = [
  'regular sans-serif, comfortable reading size',
  'light serif, elegant and readable',
  'medium weight humanist sans',
  'system font stack, optimized for screens',
  'geometric sans with generous spacing',
];

const TYPOGRAPHY_HIERARCHY = [
  ['h1 - 48px', 'h2 - 36px', 'h3 - 24px', 'body - 16px', 'small - 14px'],
  ['h1 - 64px', 'h2 - 48px', 'h3 - 32px', 'body - 18px', 'small - 14px'],
  ['h1 - 40px', 'h2 - 32px', 'h3 - 24px', 'body - 16px', 'caption - 12px'],
  ['display - 72px', 'h1 - 48px', 'h2 - 32px', 'body - 16px', 'fine - 12px'],
];

const FOCAL_POINTS = [
  'hero image',
  'headline',
  'CTA button',
  'logo',
  'product image',
  'testimonial',
  'pricing card',
  'feature icon',
  'navigation menu',
];

const EMPHASIS_TECHNIQUES = [
  'size contrast',
  'color contrast',
  'whitespace',
  'position',
  'typography weight',
  'visual weight',
  'isolation',
  'direction',
];

const SECTION_TYPES = ['hero', 'header', 'features', 'about', 'testimonials', 'pricing', 'cta', 'footer', 'content', 'gallery'];

const DENSITY_DESCRIPTIONS: Record<DensityData['level'], string[]> = {
  sparse: [
    'Very open layout with generous breathing room',
    'Minimal content with maximum whitespace',
    'Clean and uncluttered design',
  ],
  balanced: [
    'Well-balanced information density',
    'Good readability with appropriate spacing',
    'Comfortable visual rhythm',
  ],
  dense: [
    'Information-rich layout with efficient use of space',
    'Compact design with adequate separation',
    'Content-heavy but organized structure',
  ],
  cluttered: [
    'Very dense layout with minimal spacing',
    'Crowded design with competing elements',
    'High information density requiring careful navigation',
  ],
};

const RHYTHM_DESCRIPTIONS: Record<RhythmData['pattern'], string[]> = {
  regular: [
    'Consistent spacing and element sizes throughout',
    'Uniform visual rhythm creating predictable flow',
    'Regular intervals between content blocks',
  ],
  irregular: [
    'Varied spacing creating visual interest',
    'Intentional irregularity for emphasis',
    'Dynamic rhythm with intentional breaks',
  ],
  progressive: [
    'Gradually increasing or decreasing spacing',
    'Building momentum through progressive sizing',
    'Crescendo effect in visual hierarchy',
  ],
  alternating: [
    'Alternating patterns of spacing and size',
    'A-B-A-B rhythm in content arrangement',
    'Contrasting sections creating visual variety',
  ],
};

// =============================================================================
// MockVisionAdapter クラス
// =============================================================================

/**
 * テスト用モックビジョン解析アダプタ
 *
 * @example
 * ```typescript
 * const adapter = new MockVisionAdapter({
 *   latencyMs: 100,
 *   seed: 12345,
 * });
 *
 * const result = await adapter.analyze({
 *   imageBuffer: screenshotBuffer,
 *   mimeType: 'image/png',
 *   features: ['layout_structure', 'color_palette'],
 * });
 * ```
 */
export class MockVisionAdapter implements IVisionAnalyzer {
  // ---------------------------------------------------------------------------
  // プロパティ
  // ---------------------------------------------------------------------------

  readonly name: string;
  readonly modelName: string;

  private _isAvailable: boolean;
  private _latencyMs: number;
  private _latencyVariance: number;
  private _errorRate: number;
  private _seed: number;
  private _defaultFeatures: VisionFeatureType[];
  private _defaultConfidence: number;
  private _customResponses: Map<string, VisionAnalysisResult>;
  private _callCount: number;
  private _lastCall: VisionAnalysisOptions | null;
  private _random: SeededRandom;

  // ---------------------------------------------------------------------------
  // コンストラクタ
  // ---------------------------------------------------------------------------

  constructor(config?: MockVisionAdapterConfig) {
    // エラー率のバリデーション
    if (config?.errorRate !== undefined) {
      if (config.errorRate < 0 || config.errorRate > 1) {
        throw new Error('errorRate must be between 0 and 1');
      }
    }

    this.name = config?.name ?? 'MockVisionAdapter';
    this.modelName = config?.modelName ?? 'mock-vision-1.0';
    this._isAvailable = config?.isAvailable ?? true;
    this._latencyMs = config?.latencyMs ?? 100;
    this._latencyVariance = config?.latencyVariance ?? 0;
    this._errorRate = config?.errorRate ?? 0;
    this._seed = config?.seed ?? Date.now();
    this._defaultFeatures = config?.defaultFeatures ?? ['layout_structure', 'color_palette'];
    this._defaultConfidence = config?.defaultConfidence ?? 0.85;
    this._customResponses = config?.customResponses ?? new Map();
    this._callCount = 0;
    this._lastCall = null;
    this._random = new SeededRandom(this._seed);
  }

  // ---------------------------------------------------------------------------
  // IVisionAnalyzer 実装
  // ---------------------------------------------------------------------------

  /**
   * アダプタが利用可能かチェック
   */
  async isAvailable(): Promise<boolean> {
    return this._isAvailable;
  }

  /**
   * 画像を解析して特徴を抽出
   */
  async analyze(options: VisionAnalysisOptions): Promise<VisionAnalysisResult> {
    this._callCount++;
    this._lastCall = options;

    const startTime = Date.now();

    // 不可用状態チェック
    if (!this._isAvailable) {
      return {
        success: false,
        features: [],
        error: 'MockVisionAdapter is not available',
        processingTimeMs: 0,
        modelName: this.modelName,
      };
    }

    // 遅延計算
    const variance = this._latencyVariance > 0
      ? this._random.nextInt(-this._latencyVariance, this._latencyVariance)
      : 0;
    const actualLatency = Math.max(0, this._latencyMs + variance);

    // タイムアウトチェック
    if (options.timeout !== undefined && actualLatency > options.timeout) {
      await this.delay(options.timeout);
      return {
        success: false,
        features: [],
        error: `Analysis timeout: exceeded ${options.timeout}ms`,
        processingTimeMs: options.timeout,
        modelName: this.modelName,
      };
    }

    // 遅延シミュレーション
    await this.delay(actualLatency);

    // エラー率チェック
    if (this._errorRate > 0 && this._random.next() < this._errorRate) {
      return {
        success: false,
        features: [],
        error: 'Simulated error from MockVisionAdapter',
        processingTimeMs: Date.now() - startTime,
        modelName: this.modelName,
      };
    }

    // カスタムレスポンスチェック
    const imageHash = createImageHash(options.imageBuffer);
    const customResponse = this._customResponses.get(imageHash);
    if (customResponse) {
      return {
        ...customResponse,
        processingTimeMs: Date.now() - startTime,
      };
    }

    // 特徴タイプの決定
    const featureTypes = options.features && options.features.length > 0
      ? options.features
      : this._defaultFeatures;

    // 特徴の生成
    const features = featureTypes.map((type) => this.generateFeature(type));

    return {
      success: true,
      features,
      processingTimeMs: Date.now() - startTime,
      modelName: this.modelName,
    };
  }

  /**
   * テキスト表現を生成（Embedding用）
   */
  generateTextRepresentation(result: VisionAnalysisResult): string {
    if (!result.success || result.features.length === 0) {
      return '';
    }

    const parts: string[] = [];

    for (const feature of result.features) {
      const text = this.featureToText(feature);
      if (text) {
        parts.push(text);
      }
    }

    return parts.join(' ');
  }

  // ---------------------------------------------------------------------------
  // Mock固有メソッド
  // ---------------------------------------------------------------------------

  /**
   * カスタムレスポンスを設定
   */
  setResponse(imageHash: string, response: VisionAnalysisResult): void {
    this._customResponses.set(imageHash, response);
  }

  /**
   * 可用性を設定
   */
  setAvailability(available: boolean): void {
    this._isAvailable = available;
  }

  /**
   * 遅延を設定
   */
  setLatency(ms: number, variance?: number): void {
    this._latencyMs = ms;
    if (variance !== undefined) {
      this._latencyVariance = variance;
    }
  }

  /**
   * エラー率を設定
   */
  setErrorRate(rate: number): void {
    if (rate < 0 || rate > 1) {
      throw new Error('errorRate must be between 0 and 1');
    }
    this._errorRate = rate;
  }

  /**
   * 状態をリセット
   */
  reset(): void {
    this._isAvailable = true;
    this._latencyMs = 100;
    this._latencyVariance = 0;
    this._errorRate = 0;
    this._customResponses.clear();
    this._callCount = 0;
    this._lastCall = null;
    this._random = new SeededRandom(this._seed);
  }

  /**
   * 呼び出し回数を取得
   */
  getCallCount(): number {
    return this._callCount;
  }

  /**
   * 最後の呼び出しオプションを取得
   */
  getLastCall(): VisionAnalysisOptions | null {
    return this._lastCall;
  }

  // ---------------------------------------------------------------------------
  // プライベートメソッド
  // ---------------------------------------------------------------------------

  /**
   * 遅延を実行
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 信頼度を生成（デフォルト値の周辺でばらつき）
   */
  private generateConfidence(): number {
    const variance = 0.1;
    const base = this._defaultConfidence;
    const offset = (this._random.next() - 0.5) * 2 * variance;
    return Math.max(0, Math.min(1, base + offset));
  }

  /**
   * 特徴を生成
   */
  private generateFeature(type: VisionFeatureType): VisionFeature {
    const confidence = this.generateConfidence();
    const data = this.generateFeatureData(type);

    return {
      type,
      confidence,
      data,
    };
  }

  /**
   * 特徴データを生成
   */
  private generateFeatureData(type: VisionFeatureType): VisionFeatureData {
    switch (type) {
      case 'layout_structure':
        return this.generateLayoutStructure();
      case 'color_palette':
        return this.generateColorPalette();
      case 'typography':
        return this.generateTypography();
      case 'visual_hierarchy':
        return this.generateVisualHierarchy();
      case 'whitespace':
        return this.generateWhitespace();
      case 'density':
        return this.generateDensity();
      case 'rhythm':
        return this.generateRhythm();
      case 'section_boundaries':
        return this.generateSectionBoundaries();
      case 'motion_candidates':
        return this.generateMotionCandidates();
      case 'brand_tone':
        return this.generateBrandTone();
      case 'ai_cliches':
        return this.generateAiCliches();
    }
  }

  /**
   * レイアウト構造を生成
   */
  private generateLayoutStructure(): LayoutStructureData {
    const gridType = this._random.pick(GRID_TYPES);
    const areaCount = this._random.nextInt(2, 5);
    const mainAreas = this._random.shuffle([...MAIN_AREAS]).slice(0, areaCount);

    const descriptions: Record<LayoutStructureData['gridType'], string> = {
      'single-column': 'Single column layout with stacked sections',
      'two-column': 'Two column layout with sidebar',
      'three-column': 'Three column layout for dashboard or content',
      grid: 'Grid-based layout with flexible items',
      masonry: 'Masonry layout with variable height items',
      asymmetric: 'Asymmetric layout with intentional imbalance',
    };

    return {
      type: 'layout_structure',
      gridType,
      mainAreas,
      description: descriptions[gridType],
    };
  }

  /**
   * カラーパレットを生成
   */
  private generateColorPalette(): ColorPaletteData {
    const basePalette = this._random.pick(COLOR_PALETTES);
    const additionalCount = this._random.nextInt(0, 5);

    // 追加カラーを生成
    const additionalColors: string[] = [];
    for (let i = 0; i < additionalCount; i++) {
      const r = this._random.nextInt(0, 255);
      const g = this._random.nextInt(0, 255);
      const b = this._random.nextInt(0, 255);
      additionalColors.push(
        `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase()
      );
    }

    const dominantColors = [...basePalette, ...additionalColors];
    const mood = this._random.pick(MOODS);
    const contrast = this._random.pick(['high', 'medium', 'low'] as const);

    return {
      type: 'color_palette',
      dominantColors,
      mood,
      contrast,
    };
  }

  /**
   * タイポグラフィを生成
   */
  private generateTypography(): TypographyData {
    return {
      type: 'typography',
      headingStyle: this._random.pick(HEADING_STYLES),
      bodyStyle: this._random.pick(BODY_STYLES),
      hierarchy: this._random.pick(TYPOGRAPHY_HIERARCHY),
    };
  }

  /**
   * 視覚的階層を生成
   */
  private generateVisualHierarchy(): VisualHierarchyData {
    const focalPointCount = this._random.nextInt(2, 4);
    const focalPoints = this._random.shuffle([...FOCAL_POINTS]).slice(0, focalPointCount);

    const emphasisCount = this._random.nextInt(2, 4);
    const emphasisTechniques = this._random.shuffle([...EMPHASIS_TECHNIQUES]).slice(0, emphasisCount);

    return {
      type: 'visual_hierarchy',
      focalPoints,
      flowDirection: this._random.pick([
        'top-to-bottom',
        'left-to-right',
        'z-pattern',
        'f-pattern',
      ] as const),
      emphasisTechniques,
    };
  }

  /**
   * 余白を生成
   */
  private generateWhitespace(): WhitespaceData {
    return {
      type: 'whitespace',
      amount: this._random.pick(['minimal', 'moderate', 'generous', 'extreme'] as const),
      distribution: this._random.pick(['even', 'top-heavy', 'bottom-heavy', 'centered'] as const),
    };
  }

  /**
   * 密度を生成
   */
  private generateDensity(): DensityData {
    const level = this._random.pick(['sparse', 'balanced', 'dense', 'cluttered'] as const);
    const descriptions = DENSITY_DESCRIPTIONS[level];
    const description = this._random.pick(descriptions);

    return {
      type: 'density',
      level,
      description,
    };
  }

  /**
   * リズムを生成
   */
  private generateRhythm(): RhythmData {
    const pattern = this._random.pick(['regular', 'irregular', 'progressive', 'alternating'] as const);
    const descriptions = RHYTHM_DESCRIPTIONS[pattern];
    const description = this._random.pick(descriptions);

    return {
      type: 'rhythm',
      pattern,
      description,
    };
  }

  /**
   * セクション境界を生成
   */
  private generateSectionBoundaries(): SectionBoundariesData {
    const sectionCount = this._random.nextInt(3, 6);
    const types = this._random.shuffle([...SECTION_TYPES]).slice(0, sectionCount);

    let currentY = 0;
    const pageHeight = this._random.nextInt(1500, 3000);

    const sections: SectionBoundariesData['sections'] = types.map((type) => {
      const startY = currentY;
      const sectionHeight = Math.floor((pageHeight / sectionCount) * (0.8 + this._random.next() * 0.4));
      currentY = startY + sectionHeight;

      return {
        type,
        startY,
        endY: currentY,
        confidence: 0.7 + this._random.next() * 0.25,
      };
    });

    return {
      type: 'section_boundaries',
      sections,
    };
  }

  /**
   * モーション候補を生成（Reftrix専用）
   */
  private generateMotionCandidates(): MotionCandidatesData {
    const animationTypes: MotionCandidatesData['likelyAnimations'][number]['animationType'][] = [
      'fade-in', 'slide', 'scale', 'rotate', 'hover-scale', 'hover-lift', 'parallax', 'other',
    ];
    const elements = ['hero heading', 'feature cards', 'cta button', 'navigation menu', 'footer links'];
    const interactiveElements = ['primary button', 'search input', 'dropdown menu', 'carousel'];
    const scrollTriggers = ['feature section', 'testimonial carousel', 'pricing table'];

    const animationCount = this._random.nextInt(2, 5);
    const likelyAnimations = this._random.shuffle([...elements])
      .slice(0, animationCount)
      .map((element) => ({
        element,
        animationType: this._random.pick(animationTypes),
        confidence: 0.6 + this._random.next() * 0.35,
      }));

    return {
      type: 'motion_candidates',
      likelyAnimations,
      interactiveElements: this._random.shuffle([...interactiveElements]).slice(0, this._random.nextInt(2, 4)),
      scrollTriggers: this._random.shuffle([...scrollTriggers]).slice(0, this._random.nextInt(1, 3)),
    };
  }

  /**
   * ブランドトーンを生成（Reftrix専用）
   */
  private generateBrandTone(): BrandToneData {
    const professionalismLevels: BrandToneData['professionalism'][] = ['minimal', 'moderate', 'bold'];
    const warmthLevels: BrandToneData['warmth'][] = ['cold', 'neutral', 'warm'];
    const modernityLevels: BrandToneData['modernity'][] = ['classic', 'contemporary', 'futuristic'];
    const energyLevels: BrandToneData['energy'][] = ['calm', 'balanced', 'dynamic'];
    const audiences: BrandToneData['targetAudience'][] = [
      'enterprise', 'startup', 'creative', 'consumer',
    ];
    const indicators = [
      'rounded corners', 'warm accent colors', 'generous whitespace',
      'lifestyle photography', 'bold typography', 'clean lines',
      'subtle shadows', 'gradient backgrounds', 'icon-based UI',
    ];

    return {
      type: 'brand_tone',
      professionalism: this._random.pick(professionalismLevels),
      warmth: this._random.pick(warmthLevels),
      modernity: this._random.pick(modernityLevels),
      energy: this._random.pick(energyLevels),
      targetAudience: this._random.pick(audiences),
      indicators: this._random.shuffle([...indicators]).slice(0, this._random.nextInt(3, 6)),
    };
  }

  /**
   * AIクリシェを生成（Reftrix専用）
   */
  private generateAiCliches(): AiClichesData {
    const clicheTypes: AiClichesData['clichesDetected'][number]['clicheType'][] = [
      'gradient_orbs', 'generic_isometric', 'meaningless_patterns',
      'oversaturated_gradients', 'ai_generated_people', 'floating_ui',
      'generic_hero', 'symmetrical_layout', 'other',
    ];
    const severities: AiClichesData['clichesDetected'][number]['severity'][] = ['low', 'medium', 'high'];
    const locations = ['hero background', 'feature section', 'about section', 'testimonials', 'footer'];
    const suggestions = [
      'Replace gradient orbs with brand-specific visuals',
      'Use authentic photography instead of AI illustrations',
      'Add unique design elements that reflect brand identity',
      'Consider custom illustrations or icons',
      'Avoid overly symmetrical layouts',
    ];

    const clicheCount = this._random.nextInt(0, 4);
    const clichesDetected = clicheCount > 0
      ? this._random.shuffle([...clicheTypes]).slice(0, clicheCount).map((clicheType) => ({
          clicheType,
          location: this._random.pick(locations),
          severity: this._random.pick(severities),
        }))
      : [];

    // Calculate originality based on cliche count and severity
    let originalityScore = 85 - clicheCount * 10;
    clichesDetected.forEach((c) => {
      if (c.severity === 'high') originalityScore -= 8;
      else if (c.severity === 'medium') originalityScore -= 5;
      else originalityScore -= 2;
    });
    originalityScore = Math.max(10, Math.min(100, originalityScore + this._random.nextInt(-5, 5)));

    const assessment: AiClichesData['assessment'] =
      originalityScore >= 80 ? 'highly-original' :
      originalityScore >= 60 ? 'mostly-original' :
      originalityScore >= 40 ? 'moderate-ai-influence' : 'heavy-ai-influence';

    return {
      type: 'ai_cliches',
      clichesDetected,
      originalityScore,
      assessment,
      suggestions: clicheCount > 0
        ? this._random.shuffle([...suggestions]).slice(0, Math.min(clicheCount + 1, 3))
        : [],
    };
  }

  /**
   * 特徴をテキストに変換
   */
  private featureToText(feature: VisionFeature): string {
    const data = feature.data;

    switch (data.type) {
      case 'layout_structure':
        return `Layout: ${data.gridType} with ${data.mainAreas.join(', ')}. ${data.description}`;

      case 'color_palette':
        return `Colors: ${data.dominantColors.slice(0, 5).join(', ')}. Mood: ${data.mood}. Contrast: ${data.contrast}.`;

      case 'typography':
        return `Typography: Headings use ${data.headingStyle}. Body uses ${data.bodyStyle}. Hierarchy: ${data.hierarchy.join(', ')}.`;

      case 'visual_hierarchy':
        return `Visual Hierarchy: Focal points are ${data.focalPoints.join(', ')}. Flow: ${data.flowDirection}. Emphasis: ${data.emphasisTechniques.join(', ')}.`;

      case 'whitespace':
        return `Whitespace: ${data.amount} amount with ${data.distribution} distribution.`;

      case 'density':
        return `Density: ${data.level}. ${data.description}`;

      case 'rhythm':
        return `Rhythm: ${data.pattern} pattern. ${data.description}`;

      case 'section_boundaries': {
        const sectionList = data.sections.map((s) => `${s.type} (${s.startY}-${s.endY}px)`).join(', ');
        return `Sections: ${sectionList}`;
      }
      case 'motion_candidates': {
        const animations = data.likelyAnimations.map((a) => `${a.element}: ${a.animationType}`).join(', ');
        return `Motion: ${animations || 'none'}. Interactive: ${data.interactiveElements.join(', ') || 'none'}.`;
      }
      case 'brand_tone':
        return `Brand: ${data.professionalism} professionalism, ${data.warmth} warmth, ${data.modernity} modernity.`;
      case 'ai_cliches': {
        const clicheList = data.clichesDetected.map((c) => `${c.clicheType} (${c.severity})`).join(', ');
        return `AI cliches: ${clicheList || 'none'}. Originality: ${data.originalityScore}/100.`;
      }
    }
  }
}
