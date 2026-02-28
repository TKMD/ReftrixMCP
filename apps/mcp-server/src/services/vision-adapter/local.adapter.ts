// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LocalVisionAdapter - OSSベースのローカルビジョン解析アダプタ
 *
 * 外部LLM API依存なしで動作する完全OSSの画像解析実装です。
 * Sharp を使用して画像から色抽出、寸法取得、密度分析を行います。
 *
 * ## 利点
 * - 有料API依存なし（完全OSS）
 * - オフライン動作可能
 * - 高速（LLM API呼び出し不要）
 * - プライバシー保護（データ外部送信なし）
 *
 * @module vision-adapter/local.adapter
 * @see docs/plans/webdesign/00-overview.md
 */

import sharp from 'sharp';
import { Logger } from '../../utils/logger';

const logger = new Logger('LocalVisionAdapter');

import type {
  IVisionAnalyzer,
  VisionAnalysisOptions,
  VisionAnalysisResult,
  VisionFeature,
  VisionFeatureType,
  LayoutStructureData,
  ColorPaletteData,
  DensityData,
  WhitespaceData,
  SectionBoundariesData,
} from './interface';

// =============================================================================
// 型定義
// =============================================================================

/**
 * 色抽出オプション
 */
export interface ColorExtractionOptions {
  /** 抽出する最大色数 (デフォルト: 8) */
  maxColors?: number;
  /** 最小カバレッジ率 (デフォルト: 0.01 = 1%) */
  minCoverage?: number;
  /** 量子化方式 (デフォルト: 'histogram') */
  quantizationMethod?: 'histogram' | 'median-cut' | 'octree';
}

/**
 * 密度分析オプション
 */
export interface DensityAnalysisOptions {
  /** グリッドサイズ (デフォルト: 8) */
  gridSize?: number;
  /** エッジ検出閾値 (デフォルト: 30) */
  edgeThreshold?: number;
}

/**
 * LocalVisionAdapterの設定オプション
 */
export interface LocalVisionAdapterConfig {
  /** アダプタ名 (デフォルト: 'LocalVisionAdapter') */
  name?: string;
  /** モデル名 (デフォルト: 'local-sharp-1.0') */
  modelName?: string;
  /** 可用性 (デフォルト: true) */
  isAvailable?: boolean;
  /** 色抽出オプション */
  colorExtraction?: ColorExtractionOptions;
  /** 密度分析オプション */
  densityAnalysis?: DensityAnalysisOptions;
  /** デフォルトで抽出する特徴タイプ */
  defaultFeatures?: VisionFeatureType[];
}

/**
 * 画像メタデータ
 */
interface ImageMetadata {
  width: number;
  height: number;
  aspectRatio: number;
  format: string;
}

/**
 * 色情報
 */
interface ColorInfo {
  hex: string;
  r: number;
  g: number;
  b: number;
  coverage: number;
}

/**
 * 密度情報
 */
interface DensityInfo {
  overall: number; // 0-1
  distribution: number[]; // グリッドごとの密度
  edgeCount: number;
}

// =============================================================================
// 定数
// =============================================================================

const DEFAULT_FEATURES: VisionFeatureType[] = ['color_palette', 'density', 'layout_structure'];

const SUPPORTED_FEATURES: VisionFeatureType[] = [
  'color_palette',
  'density',
  'whitespace',
  'layout_structure',
  'section_boundaries',
];

// 未サポートの特徴タイプ（将来の拡張用）
// const UNSUPPORTED_FEATURES: VisionFeatureType[] = [
//   'typography',
//   'visual_hierarchy',
//   'rhythm',
// ];

// =============================================================================
// LocalVisionAdapter クラス
// =============================================================================

/**
 * OSSベースのローカルビジョン解析アダプタ
 *
 * @example
 * ```typescript
 * const adapter = new LocalVisionAdapter();
 *
 * if (await adapter.isAvailable()) {
 *   const result = await adapter.analyze({
 *     imageBuffer: screenshotBuffer,
 *     mimeType: 'image/png',
 *     features: ['color_palette', 'density'],
 *   });
 *
 *   if (result.success) {
 *     const textRep = adapter.generateTextRepresentation(result);
 *     // textRepをEmbeddingに使用
 *   }
 * }
 * ```
 */
export class LocalVisionAdapter implements IVisionAnalyzer {
  // ---------------------------------------------------------------------------
  // プロパティ
  // ---------------------------------------------------------------------------

  readonly name: string;
  readonly modelName: string;

  private _isAvailable: boolean;
  private _colorExtractionOptions: Required<ColorExtractionOptions>;
  private _densityAnalysisOptions: Required<DensityAnalysisOptions>;
  private _defaultFeatures: VisionFeatureType[];

  // ---------------------------------------------------------------------------
  // コンストラクタ
  // ---------------------------------------------------------------------------

  constructor(config?: LocalVisionAdapterConfig) {
    this.name = config?.name ?? 'LocalVisionAdapter';
    this.modelName = config?.modelName ?? 'local-sharp-1.0';
    this._isAvailable = config?.isAvailable ?? true;
    this._defaultFeatures = config?.defaultFeatures ?? DEFAULT_FEATURES;

    this._colorExtractionOptions = {
      maxColors: config?.colorExtraction?.maxColors ?? 8,
      minCoverage: config?.colorExtraction?.minCoverage ?? 0.01,
      quantizationMethod: config?.colorExtraction?.quantizationMethod ?? 'histogram',
    };

    this._densityAnalysisOptions = {
      gridSize: config?.densityAnalysis?.gridSize ?? 8,
      edgeThreshold: config?.densityAnalysis?.edgeThreshold ?? 30,
    };

    if (process.env.NODE_ENV === 'development') {
      logger.debug('Initialized with config', {
        name: this.name,
        modelName: this.modelName,
        colorExtraction: this._colorExtractionOptions,
        densityAnalysis: this._densityAnalysisOptions,
      });
    }
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
    const startTime = Date.now();

    // 不可用状態チェック
    if (!this._isAvailable) {
      return {
        success: false,
        features: [],
        error: 'LocalVisionAdapter is not available',
        processingTimeMs: 0,
        modelName: this.modelName,
      };
    }

    try {
      // 画像バッファの検証
      if (!options.imageBuffer || options.imageBuffer.length === 0) {
        return {
          success: false,
          features: [],
          error: 'Empty image buffer provided',
          processingTimeMs: Date.now() - startTime,
          modelName: this.modelName,
        };
      }

      // タイムアウトラッパー
      const timeoutMs = options.timeout ?? 30000;
      const analysisPromise = this.performAnalysis(options, startTime);

      const result = await Promise.race([
        analysisPromise,
        this.createTimeoutPromise(timeoutMs, startTime),
      ]);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (process.env.NODE_ENV === 'development') {
        console.error('[LocalVisionAdapter] Analysis error:', errorMessage);
      }

      return {
        success: false,
        features: [],
        error: `Analysis failed: ${errorMessage}`,
        processingTimeMs: Date.now() - startTime,
        modelName: this.modelName,
      };
    }
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
  // プライベートメソッド - メイン解析
  // ---------------------------------------------------------------------------

  /**
   * 実際の解析処理
   */
  private async performAnalysis(
    options: VisionAnalysisOptions,
    startTime: number
  ): Promise<VisionAnalysisResult> {
    // 画像のメタデータを取得
    const metadata = await this.getImageMetadata(options.imageBuffer);

    // 解析する特徴タイプを決定
    const featureTypes = options.features && options.features.length > 0
      ? options.features.filter((f) => SUPPORTED_FEATURES.includes(f))
      : this._defaultFeatures;

    // 各特徴を抽出
    const features: VisionFeature[] = [];

    for (const featureType of featureTypes) {
      try {
        const feature = await this.extractFeature(options.imageBuffer, metadata, featureType);
        if (feature) {
          features.push(feature);
        }
      } catch (error) {
        if (process.env.NODE_ENV === 'development') {
          console.warn(`[LocalVisionAdapter] Failed to extract feature ${featureType}:`, error);
        }
      }
    }

    return {
      success: true,
      features,
      processingTimeMs: Date.now() - startTime,
      modelName: this.modelName,
    };
  }

  /**
   * タイムアウトPromiseを作成
   */
  private createTimeoutPromise(timeoutMs: number, startTime: number): Promise<VisionAnalysisResult> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          success: false,
          features: [],
          error: `Analysis timeout: exceeded ${timeoutMs}ms`,
          processingTimeMs: Date.now() - startTime,
          modelName: this.modelName,
        });
      }, timeoutMs);
    });
  }

  // ---------------------------------------------------------------------------
  // プライベートメソッド - 特徴抽出
  // ---------------------------------------------------------------------------

  /**
   * 画像メタデータを取得
   */
  private async getImageMetadata(imageBuffer: Buffer): Promise<ImageMetadata> {
    const metadata = await sharp(imageBuffer).metadata();

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    return {
      width,
      height,
      aspectRatio: height > 0 ? width / height : 1,
      format: metadata.format ?? 'unknown',
    };
  }

  /**
   * 特徴を抽出
   */
  private async extractFeature(
    imageBuffer: Buffer,
    metadata: ImageMetadata,
    featureType: VisionFeatureType
  ): Promise<VisionFeature | null> {
    switch (featureType) {
      case 'color_palette':
        return this.extractColorPalette(imageBuffer);

      case 'density':
        return this.extractDensity(imageBuffer, metadata);

      case 'whitespace':
        return this.extractWhitespace(imageBuffer, metadata);

      case 'layout_structure':
        return this.extractLayoutStructure(metadata);

      case 'section_boundaries':
        return this.extractSectionBoundaries(imageBuffer, metadata);

      default:
        // 未サポートの特徴タイプ
        return this.createUnsupportedFeature(featureType);
    }
  }

  /**
   * カラーパレットを抽出
   */
  private async extractColorPalette(imageBuffer: Buffer): Promise<VisionFeature> {
    const colors = await this.extractColors(imageBuffer);

    // コントラストを計算
    const contrast = this.calculateContrast(colors);

    // ムードを推定
    const mood = this.estimateMood(colors);

    const data: ColorPaletteData = {
      type: 'color_palette',
      dominantColors: colors.slice(0, this._colorExtractionOptions.maxColors).map((c) => c.hex),
      mood,
      contrast,
    };

    return {
      type: 'color_palette',
      confidence: 0.9, // Sharpによる色抽出は信頼性が高い
      data,
    };
  }

  /**
   * 密度を抽出
   */
  private async extractDensity(imageBuffer: Buffer, metadata: ImageMetadata): Promise<VisionFeature> {
    const densityInfo = await this.analyzeDensity(imageBuffer, metadata);

    // 密度レベルを判定
    const level = this.classifyDensityLevel(densityInfo.overall);

    // 説明を生成
    const description = this.generateDensityDescription(level, densityInfo);

    const data: DensityData = {
      type: 'density',
      level,
      description,
    };

    return {
      type: 'density',
      confidence: 0.85,
      data,
    };
  }

  /**
   * 余白を抽出
   */
  private async extractWhitespace(imageBuffer: Buffer, metadata: ImageMetadata): Promise<VisionFeature> {
    const densityInfo = await this.analyzeDensity(imageBuffer, metadata);

    // 余白量を判定（密度の逆）
    const amount = this.classifyWhitespaceAmount(densityInfo.overall);

    // 分布を判定
    const distribution = this.classifyWhitespaceDistribution(densityInfo.distribution, metadata);

    const data: WhitespaceData = {
      type: 'whitespace',
      amount,
      distribution,
    };

    return {
      type: 'whitespace',
      confidence: 0.8,
      data,
    };
  }

  /**
   * レイアウト構造を抽出
   */
  private extractLayoutStructure(metadata: ImageMetadata): VisionFeature {
    // アスペクト比に基づいてレイアウトタイプを推定
    const gridType = this.estimateGridType(metadata);

    // メインエリアを推定
    const mainAreas = this.estimateMainAreas(metadata, gridType);

    // 説明を生成
    const description = this.generateLayoutDescription(gridType, mainAreas);

    const data: LayoutStructureData = {
      type: 'layout_structure',
      gridType,
      mainAreas,
      description,
    };

    return {
      type: 'layout_structure',
      confidence: 0.7, // ヒューリスティックベースなので信頼度は中程度
      data,
    };
  }

  /**
   * セクション境界を抽出
   */
  private async extractSectionBoundaries(
    imageBuffer: Buffer,
    metadata: ImageMetadata
  ): Promise<VisionFeature> {
    // 水平方向のエッジを検出してセクション境界を推定
    const sections = await this.detectSectionBoundaries(imageBuffer, metadata);

    const data: SectionBoundariesData = {
      type: 'section_boundaries',
      sections,
    };

    return {
      type: 'section_boundaries',
      confidence: 0.6, // エッジ検出ベースなので信頼度は低め
      data,
    };
  }

  /**
   * 未サポートの特徴用のプレースホルダー
   */
  private createUnsupportedFeature(featureType: VisionFeatureType): VisionFeature | null {
    // 未サポートの特徴タイプはnullを返す
    if (process.env.NODE_ENV === 'development') {
      logger.debug(`Feature type not supported: ${featureType}`);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // プライベートメソッド - 色抽出
  // ---------------------------------------------------------------------------

  /**
   * 画像から主要色を抽出
   */
  private async extractColors(imageBuffer: Buffer): Promise<ColorInfo[]> {
    // 画像を小さくリサイズして処理を高速化
    const resized = await sharp(imageBuffer)
      .resize(100, 100, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = resized;
    const pixels = info.width * info.height;
    const channels = info.channels;

    // 色のヒストグラムを作成
    const colorCounts = new Map<string, { count: number; r: number; g: number; b: number }>();

    for (let i = 0; i < data.length; i += channels) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;

      // 色を量子化（16段階）
      const qr = Math.round(r / 16) * 16;
      const qg = Math.round(g / 16) * 16;
      const qb = Math.round(b / 16) * 16;

      const key = `${qr},${qg},${qb}`;
      const existing = colorCounts.get(key);

      if (existing) {
        existing.count++;
      } else {
        colorCounts.set(key, { count: 1, r: qr, g: qg, b: qb });
      }
    }

    // カウント順にソート
    const sortedColors = Array.from(colorCounts.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, this._colorExtractionOptions.maxColors);

    // ColorInfo形式に変換
    return sortedColors.map(([, value]) => ({
      hex: this.rgbToHex(value.r, value.g, value.b),
      r: value.r,
      g: value.g,
      b: value.b,
      coverage: value.count / pixels,
    }));
  }

  /**
   * RGB値をHEX文字列に変換
   */
  private rgbToHex(r: number, g: number, b: number): string {
    const toHex = (n: number): string => Math.min(255, Math.max(0, n)).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
  }

  /**
   * コントラストを計算
   */
  private calculateContrast(colors: ColorInfo[]): 'high' | 'medium' | 'low' {
    if (colors.length < 2) {
      return 'low';
    }

    // 最も明るい色と最も暗い色の輝度差を計算
    const luminances = colors.map((c) => this.calculateLuminance(c.r, c.g, c.b));
    const maxLuminance = Math.max(...luminances);
    const minLuminance = Math.min(...luminances);

    // コントラスト比を計算（WCAG方式）
    const contrastRatio = (maxLuminance + 0.05) / (minLuminance + 0.05);

    if (contrastRatio >= 7) {
      return 'high';
    } else if (contrastRatio >= 3) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  /**
   * 相対輝度を計算
   */
  private calculateLuminance(r: number, g: number, b: number): number {
    const sRGB = [r, g, b].map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });

    return 0.2126 * (sRGB[0] ?? 0) + 0.7152 * (sRGB[1] ?? 0) + 0.0722 * (sRGB[2] ?? 0);
  }

  /**
   * ムードを推定
   */
  private estimateMood(colors: ColorInfo[]): string {
    if (colors.length === 0) {
      return 'neutral';
    }

    // 主要色の平均HSLを計算
    const avgColor = colors[0];
    if (!avgColor) {
      return 'neutral';
    }

    const { h, s, l } = this.rgbToHsl(avgColor.r, avgColor.g, avgColor.b);

    // 彩度と輝度に基づいてムードを推定
    if (l < 0.2) {
      return 'dark and mysterious';
    } else if (l > 0.8) {
      return 'light and airy';
    } else if (s < 0.2) {
      return 'neutral and balanced';
    } else if (h < 30 || h > 330) {
      return 'warm and energetic';
    } else if (h >= 180 && h <= 270) {
      return 'cool and calm';
    } else if (h >= 90 && h < 180) {
      return 'fresh and natural';
    } else {
      return 'vibrant and creative';
    }
  }

  /**
   * RGB to HSL 変換
   */
  private rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
    const rNorm = r / 255;
    const gNorm = g / 255;
    const bNorm = b / 255;

    const max = Math.max(rNorm, gNorm, bNorm);
    const min = Math.min(rNorm, gNorm, bNorm);
    const l = (max + min) / 2;

    let h = 0;
    let s = 0;

    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

      switch (max) {
        case rNorm:
          h = ((gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0)) * 60;
          break;
        case gNorm:
          h = ((bNorm - rNorm) / d + 2) * 60;
          break;
        case bNorm:
          h = ((rNorm - gNorm) / d + 4) * 60;
          break;
      }
    }

    return { h, s, l };
  }

  // ---------------------------------------------------------------------------
  // プライベートメソッド - 密度分析
  // ---------------------------------------------------------------------------

  /**
   * 画像の密度を分析
   */
  private async analyzeDensity(imageBuffer: Buffer, _metadata: ImageMetadata): Promise<DensityInfo> {
    const gridSize = this._densityAnalysisOptions.gridSize;

    // グレースケール変換してエッジ検出
    const edgeBuffer = await sharp(imageBuffer)
      .resize(gridSize * 10, gridSize * 10, { fit: 'fill' })
      .grayscale()
      .convolve({
        width: 3,
        height: 3,
        kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1], // Laplacian filter
      })
      .raw()
      .toBuffer();

    const cellSize = 10;
    const distribution: number[] = [];
    let totalEdgeStrength = 0;
    let edgeCount = 0;

    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        let cellEdgeStrength = 0;

        for (let y = 0; y < cellSize; y++) {
          for (let x = 0; x < cellSize; x++) {
            const px = gx * cellSize + x;
            const py = gy * cellSize + y;
            const idx = py * (gridSize * cellSize) + px;
            const value = edgeBuffer[idx] ?? 0;

            if (value > this._densityAnalysisOptions.edgeThreshold) {
              cellEdgeStrength++;
              edgeCount++;
            }
          }
        }

        const cellDensity = cellEdgeStrength / (cellSize * cellSize);
        distribution.push(cellDensity);
        totalEdgeStrength += cellEdgeStrength;
      }
    }

    const totalPixels = gridSize * gridSize * cellSize * cellSize;
    const overall = totalEdgeStrength / totalPixels;

    return {
      overall,
      distribution,
      edgeCount,
    };
  }

  /**
   * 密度レベルを分類
   */
  private classifyDensityLevel(overall: number): DensityData['level'] {
    if (overall < 0.05) {
      return 'sparse';
    } else if (overall < 0.15) {
      return 'balanced';
    } else if (overall < 0.3) {
      return 'dense';
    } else {
      return 'cluttered';
    }
  }

  /**
   * 密度の説明を生成
   */
  private generateDensityDescription(level: DensityData['level'], _densityInfo: DensityInfo): string {
    const descriptions: Record<DensityData['level'], string[]> = {
      sparse: [
        'Very clean layout with minimal visual elements',
        'Open design with generous negative space',
      ],
      balanced: [
        'Well-balanced information density',
        'Good visual rhythm with appropriate spacing',
      ],
      dense: [
        'Information-rich layout with efficient use of space',
        'Content-heavy but organized structure',
      ],
      cluttered: [
        'Very dense layout with many visual elements',
        'High information density requiring careful navigation',
      ],
    };

    const levelDescriptions = descriptions[level];
    return levelDescriptions[Math.floor(Math.random() * levelDescriptions.length)] ?? '';
  }

  // ---------------------------------------------------------------------------
  // プライベートメソッド - 余白分析
  // ---------------------------------------------------------------------------

  /**
   * 余白量を分類
   */
  private classifyWhitespaceAmount(density: number): WhitespaceData['amount'] {
    // 密度の逆
    if (density > 0.3) {
      return 'minimal';
    } else if (density > 0.15) {
      return 'moderate';
    } else if (density > 0.05) {
      return 'generous';
    } else {
      return 'extreme';
    }
  }

  /**
   * 余白の分布を分類
   */
  private classifyWhitespaceDistribution(
    distribution: number[],
    _metadata: ImageMetadata
  ): WhitespaceData['distribution'] {
    if (distribution.length === 0) {
      return 'even';
    }

    const gridSize = Math.sqrt(distribution.length);
    if (gridSize !== Math.floor(gridSize)) {
      return 'even';
    }

    // 上半分と下半分の平均密度を計算
    const halfRows = Math.floor(gridSize / 2);
    let topDensity = 0;
    let bottomDensity = 0;

    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const idx = y * gridSize + x;
        const value = distribution[idx] ?? 0;

        if (y < halfRows) {
          topDensity += value;
        } else {
          bottomDensity += value;
        }
      }
    }

    const topAvg = topDensity / (halfRows * gridSize);
    const bottomAvg = bottomDensity / ((gridSize - halfRows) * gridSize);

    // 中央部分の密度を計算
    const centerStart = Math.floor(gridSize / 4);
    const centerEnd = Math.floor((3 * gridSize) / 4);
    let centerDensity = 0;
    let centerCount = 0;

    for (let y = centerStart; y < centerEnd; y++) {
      for (let x = centerStart; x < centerEnd; x++) {
        const idx = y * gridSize + x;
        centerDensity += distribution[idx] ?? 0;
        centerCount++;
      }
    }

    const centerAvg = centerCount > 0 ? centerDensity / centerCount : 0;
    const overallAvg = distribution.reduce((a, b) => a + b, 0) / distribution.length;

    // 分布パターンを判定
    if (centerAvg > overallAvg * 1.2) {
      return 'centered';
    } else if (topAvg > bottomAvg * 1.5) {
      return 'top-heavy';
    } else if (bottomAvg > topAvg * 1.5) {
      return 'bottom-heavy';
    } else {
      return 'even';
    }
  }

  // ---------------------------------------------------------------------------
  // プライベートメソッド - レイアウト分析
  // ---------------------------------------------------------------------------

  /**
   * グリッドタイプを推定
   */
  private estimateGridType(metadata: ImageMetadata): LayoutStructureData['gridType'] {
    const { aspectRatio } = metadata;

    // アスペクト比に基づいて推定
    if (aspectRatio < 0.6) {
      // 縦長
      return 'single-column';
    } else if (aspectRatio > 1.8) {
      // 横長
      return 'grid';
    } else if (aspectRatio > 1.2) {
      // やや横長
      return 'two-column';
    } else if (aspectRatio > 0.9) {
      // ほぼ正方形
      return 'grid';
    } else {
      // やや縦長
      return 'single-column';
    }
  }

  /**
   * メインエリアを推定
   */
  private estimateMainAreas(
    metadata: ImageMetadata,
    gridType: LayoutStructureData['gridType']
  ): string[] {
    const areas = ['header', 'main', 'footer'];

    if (gridType === 'two-column') {
      areas.push('sidebar');
    } else if (gridType === 'three-column') {
      areas.push('left-sidebar', 'right-sidebar');
    }

    if (metadata.height > 1000) {
      areas.push('hero', 'content');
    }

    return areas;
  }

  /**
   * レイアウトの説明を生成
   */
  private generateLayoutDescription(
    gridType: LayoutStructureData['gridType'],
    mainAreas: string[]
  ): string {
    const descriptions: Record<LayoutStructureData['gridType'], string> = {
      'single-column': 'Single column layout with stacked sections',
      'two-column': 'Two column layout with main content and sidebar',
      'three-column': 'Three column layout for dashboard or complex content',
      grid: 'Grid-based layout with flexible items',
      masonry: 'Masonry layout with variable height items',
      asymmetric: 'Asymmetric layout with intentional imbalance',
    };

    return `${descriptions[gridType]}. Main areas: ${mainAreas.join(', ')}.`;
  }

  // ---------------------------------------------------------------------------
  // プライベートメソッド - セクション境界検出
  // ---------------------------------------------------------------------------

  /**
   * セクション境界を検出
   */
  private async detectSectionBoundaries(
    imageBuffer: Buffer,
    metadata: ImageMetadata
  ): Promise<SectionBoundariesData['sections']> {
    // 画像を縦方向に集約してエッジを検出
    const height = Math.min(metadata.height, 500);

    const edgeBuffer = await sharp(imageBuffer)
      .resize(1, height, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();

    // 輝度の変化が大きい行を境界として検出
    const boundaries: number[] = [0];
    const threshold = 30;

    for (let y = 1; y < height; y++) {
      const prev = edgeBuffer[y - 1] ?? 0;
      const curr = edgeBuffer[y] ?? 0;
      const diff = Math.abs(curr - prev);

      if (diff > threshold) {
        // 前の境界から十分離れている場合のみ追加
        const lastBoundary = boundaries[boundaries.length - 1] ?? 0;
        if (y - lastBoundary > height / 10) {
          boundaries.push(y);
        }
      }
    }

    boundaries.push(height);

    // セクションを生成
    const sectionTypes = ['hero', 'content', 'features', 'testimonials', 'cta', 'footer'];
    const sections: SectionBoundariesData['sections'] = [];

    for (let i = 0; i < boundaries.length - 1 && i < sectionTypes.length; i++) {
      const startY = boundaries[i] ?? 0;
      const endY = boundaries[i + 1] ?? height;
      const sectionType = sectionTypes[i] ?? 'content';

      // 実際の画像の高さにスケール
      const scaleFactor = metadata.height / height;

      sections.push({
        type: sectionType,
        startY: Math.round(startY * scaleFactor),
        endY: Math.round(endY * scaleFactor),
        confidence: 0.6 + Math.random() * 0.2,
      });
    }

    return sections;
  }

  // ---------------------------------------------------------------------------
  // プライベートメソッド - テキスト生成
  // ---------------------------------------------------------------------------

  /**
   * 特徴をテキストに変換
   */
  private featureToText(feature: VisionFeature): string {
    const data = feature.data;

    switch (data.type) {
      case 'color_palette':
        return `Colors: ${data.dominantColors.slice(0, 5).join(', ')}. Mood: ${data.mood}. Contrast: ${data.contrast}.`;

      case 'density':
        return `Density: ${data.level}. ${data.description}`;

      case 'whitespace':
        return `Whitespace: ${data.amount} amount with ${data.distribution} distribution.`;

      case 'layout_structure':
        return `Layout: ${data.gridType}. ${data.description}`;

      case 'section_boundaries': {
        const sectionList = data.sections
          .map((s) => `${s.type} (${s.startY}-${s.endY}px)`)
          .join(', ');
        return `Sections: ${sectionList}`;
      }

      default:
        return '';
    }
  }
}
