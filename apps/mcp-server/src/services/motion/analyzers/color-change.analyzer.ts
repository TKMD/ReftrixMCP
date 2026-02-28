// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Color Change Analyzer
 *
 * フレーム画像間の色変化を検出・分析するサービス
 *
 * @module @reftrix/mcp-server/services/motion/analyzers/color-change
 *
 * 主要機能:
 * 1. extractDominantColors - ドミナントカラー抽出
 * 2. analyzeColorChange - 色変化解析
 * 3. detectFade - フェード効果検出
 * 4. calculateColorDistance - 色距離計算
 *
 * 仕様: docs/specs/frame-image-analysis-spec.md FR-4
 */

// ============================================================================
// 型定義
// ============================================================================

/**
 * RGB色（0-255）
 */
export interface RGB {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/**
 * HSL色（H: 0-360, S: 0-100, L: 0-100）
 */
export interface HSL {
  h: number;
  s: number;
  l: number;
}

/**
 * ドミナントカラー情報
 */
export interface DominantColor {
  /** 赤成分 (0-255) */
  r: number;
  /** 緑成分 (0-255) */
  g: number;
  /** 青成分 (0-255) */
  b: number;
  /** アルファ成分 (0-255) */
  a: number;
  /** HEX表記 (#rrggbb) */
  hex: string;
  /** 占有率 (0-1) */
  percentage: number;
}

/**
 * バウンディングボックス
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * ドミナントカラー抽出結果
 */
export interface DominantColorsResult {
  colors: DominantColor[];
}

/**
 * ドミナントカラー抽出オプション
 */
export interface ExtractDominantColorsOptions {
  /** 抽出する色数 (デフォルト: 5) */
  k?: number;
}

/**
 * 色変化解析結果
 */
export interface ColorChangeAnalysis {
  /** 色変化量 (0-1) */
  colorShift: number;
  /** 色相変化 (度) */
  hueChange: number;
  /** 彩度変化 (-100 to 100) */
  saturationChange: number;
  /** 明度変化 (-100 to 100) */
  lightnessChange: number;
}

/**
 * フレーム間の色変化
 */
export interface ColorChange {
  /** 開始フレームインデックス */
  fromFrame: number;
  /** 終了フレームインデックス */
  toFrame: number;
  /** 色変化量 (0-1) */
  colorShift: number;
  /** 色相変化 (度) */
  hueChange: number;
  /** 彩度変化 */
  saturationChange: number;
  /** 明度変化 */
  lightnessChange: number;
}

/**
 * 色変化イベント（仕様書準拠）
 */
export interface ColorChangeEvent {
  /** 開始フレームインデックス */
  start_frame: number;
  /** 終了フレームインデックス */
  end_frame: number;
  /** 変化タイプ */
  change_type: 'fade_in' | 'fade_out' | 'color_transition' | 'brightness_change';
  /** 影響領域 */
  affected_region: BoundingBox;
  /** 変化前の主要色 (HEX) */
  from_color: string;
  /** 変化後の主要色 (HEX) */
  to_color: string;
  /** 推定duration (ms) */
  estimated_duration_ms: number;
}

/**
 * フェード効果（ColorChangeEventの別名）
 */
export type FadeEffect = ColorChangeEvent;

/**
 * フェード検出オプション
 */
export interface DetectFadeOptions {
  /** 変化検出閾値 (0-1, デフォルト: 0.1) */
  threshold?: number;
  /** フレームレート (デフォルト: 30) */
  fps?: number;
}

/**
 * フェード検出結果
 */
export interface DetectFadeResult {
  fadeEffects: FadeEffect[];
}

/**
 * フレームのドミナントカラー情報
 */
export interface FrameDominantColors {
  dominantColors: DominantColor[];
}

/**
 * フレームバッファ情報
 */
export interface FrameBuffer {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * 色変化解析の完全結果
 */
export interface ColorChangeResult {
  /** 各フレームのドミナントカラー */
  dominantColors: {
    frameIndex: number;
    colors: DominantColor[];
  }[];
  /** フレーム間の色変化 */
  changes: ColorChange[];
  /** 検出されたフェード効果 */
  fadeEffects: FadeEffect[];
  /** 平均色変化量 (0-1) */
  averageColorShift: number;
}

/**
 * 分析オプション
 */
export interface AnalyzeOptions {
  /** 抽出する色数 */
  k?: number;
  /** フレームレート */
  fps?: number;
  /** 変化検出閾値 */
  threshold?: number;
}

// ============================================================================
// 定数
// ============================================================================

/** RGB最大値 */
const MAX_RGB = 255;

/** 最大ユークリッド距離（黒から白） */
const MAX_EUCLIDEAN_DISTANCE = Math.sqrt(3 * MAX_RGB * MAX_RGB);

/** デフォルトの色数 */
const DEFAULT_K = 5;

/** デフォルトのFPS */
const DEFAULT_FPS = 30;

/** デフォルトの閾値 */
const DEFAULT_THRESHOLD = 0.1;

/** フェードイン判定の明度変化閾値 */
const FADE_IN_LIGHTNESS_THRESHOLD = 20;

/** フェードアウト判定の明度変化閾値 */
const FADE_OUT_LIGHTNESS_THRESHOLD = -20;

/** 色遷移判定の色相変化閾値（度） */
const COLOR_TRANSITION_HUE_THRESHOLD = 30;

/** 明度変化判定の閾値 */
const BRIGHTNESS_CHANGE_THRESHOLD = 15;

// ============================================================================
// ヘルパー関数（エクスポート）
// ============================================================================

/**
 * 2つの色間のユークリッド距離を計算（0-1に正規化）
 *
 * @param color1 - 比較元の色
 * @param color2 - 比較先の色
 * @returns 正規化された距離 (0: 同一色, 1: 黒と白)
 */
export function calculateColorDistance(
  color1: { r: number; g: number; b: number },
  color2: { r: number; g: number; b: number }
): number {
  const dr = color2.r - color1.r;
  const dg = color2.g - color1.g;
  const db = color2.b - color1.b;
  const distance = Math.sqrt(dr * dr + dg * dg + db * db);
  return distance / MAX_EUCLIDEAN_DISTANCE;
}

/**
 * RGBをHSLに変換
 *
 * @param r - 赤成分 (0-255)
 * @param g - 緑成分 (0-255)
 * @param b - 青成分 (0-255)
 * @returns HSL値 (H: 0-360, S: 0-100, L: 0-100)
 */
export function rgbToHsl(r: number, g: number, b: number): HSL {
  // 0-1に正規化
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;

  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const delta = max - min;

  // 明度
  const l = (max + min) / 2;

  // 無彩色の場合
  if (delta === 0) {
    return { h: 0, s: 0, l: l * 100 };
  }

  // 彩度
  const s = delta / (1 - Math.abs(2 * l - 1));

  // 色相
  let h: number;
  if (max === rNorm) {
    h = ((gNorm - bNorm) / delta) % 6;
  } else if (max === gNorm) {
    h = (bNorm - rNorm) / delta + 2;
  } else {
    h = (rNorm - gNorm) / delta + 4;
  }
  h = Math.round(h * 60);
  if (h < 0) h += 360;

  return {
    h,
    s: s * 100,
    l: l * 100,
  };
}

/**
 * HSLをRGBに変換
 *
 * @param h - 色相 (0-360)
 * @param s - 彩度 (0-100)
 * @param l - 明度 (0-100)
 * @returns RGB値 (0-255)
 */
export function hslToRgb(h: number, s: number, l: number): RGB {
  // 0-1に正規化
  const sNorm = s / 100;
  const lNorm = l / 100;

  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;

  let r1 = 0,
    g1 = 0,
    b1 = 0;

  if (h >= 0 && h < 60) {
    r1 = c;
    g1 = x;
    b1 = 0;
  } else if (h >= 60 && h < 120) {
    r1 = x;
    g1 = c;
    b1 = 0;
  } else if (h >= 120 && h < 180) {
    r1 = 0;
    g1 = c;
    b1 = x;
  } else if (h >= 180 && h < 240) {
    r1 = 0;
    g1 = x;
    b1 = c;
  } else if (h >= 240 && h < 300) {
    r1 = x;
    g1 = 0;
    b1 = c;
  } else {
    r1 = c;
    g1 = 0;
    b1 = x;
  }

  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

/**
 * HEX形式をRGBに変換
 *
 * @param hex - HEX形式の色 (#rrggbb, #rgb, rrggbb)
 * @returns RGB値
 */
export function hexToRgb(hex: string): RGB {
  // #を除去
  let cleanHex = hex.replace(/^#/, '');

  // 3桁の場合は6桁に展開
  if (cleanHex.length === 3) {
    cleanHex = cleanHex
      .split('')
      .map((c) => c + c)
      .join('');
  }

  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);

  // 8桁の場合はアルファ値も解析
  if (cleanHex.length === 8) {
    const a = parseInt(cleanHex.substring(6, 8), 16);
    return { r, g, b, a };
  }

  return { r, g, b };
}

/**
 * RGBをHEX形式に変換
 *
 * @param r - 赤成分 (0-255)
 * @param g - 緑成分 (0-255)
 * @param b - 青成分 (0-255)
 * @param a - アルファ成分 (オプション, 0-255)
 * @returns HEX形式の色
 */
export function rgbToHex(r: number, g: number, b: number, a?: number): string {
  const toHex = (value: number): string => {
    const hex = Math.round(value).toString(16).padStart(2, '0');
    return hex;
  };

  let hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  if (a !== undefined) {
    hex += toHex(a);
  }
  return hex;
}

// ============================================================================
// K-means++ クラスタリング
// ============================================================================

/**
 * K-means++でドミナントカラーを抽出
 *
 * @param pixels - ピクセルデータ (RGBA配列)
 * @param k - クラスタ数
 * @param maxIterations - 最大反復回数
 * @returns クラスタ中心と各クラスタのサイズ
 */
function kMeansPlusPlus(
  pixels: RGB[],
  k: number,
  maxIterations: number = 20
): { centers: RGB[]; sizes: number[] } {
  if (pixels.length === 0) {
    throw new Error('No pixels to cluster');
  }

  if (k <= 0) {
    throw new Error('k must be positive');
  }

  // サンプリング（大量ピクセルの場合）
  const maxSamples = 10000;
  let sampledPixels = pixels;
  if (pixels.length > maxSamples) {
    sampledPixels = [];
    const step = Math.floor(pixels.length / maxSamples);
    for (let i = 0; i < pixels.length; i += step) {
      const pixel = pixels[i];
      if (pixel) {
        sampledPixels.push(pixel);
      }
    }
  }

  // K-means++ 初期化
  const centers: RGB[] = [];

  // 最初の中心をランダムに選択
  const firstIndex = Math.floor(Math.random() * sampledPixels.length);
  const firstPixel = sampledPixels[firstIndex];
  if (!firstPixel) {
    throw new Error('Failed to select first center');
  }
  centers.push({ r: firstPixel.r, g: firstPixel.g, b: firstPixel.b });

  // 残りの中心を距離に基づいて選択
  for (let i = 1; i < k; i++) {
    const distances: number[] = [];
    let totalDistance = 0;

    for (const pixel of sampledPixels) {
      let minDist = Infinity;
      for (const center of centers) {
        const dist = calculateColorDistance(pixel, center);
        if (dist < minDist) {
          minDist = dist;
        }
      }
      distances.push(minDist * minDist);
      totalDistance += minDist * minDist;
    }

    // 確率的に次の中心を選択
    let random = Math.random() * totalDistance;
    for (let j = 0; j < sampledPixels.length; j++) {
      const dist = distances[j];
      if (dist === undefined) continue;
      random -= dist;
      if (random <= 0) {
        const pixel = sampledPixels[j];
        if (pixel) {
          centers.push({ r: pixel.r, g: pixel.g, b: pixel.b });
        }
        break;
      }
    }

    // フォールバック
    if (centers.length === i) {
      const fallbackPixel = sampledPixels[Math.floor(Math.random() * sampledPixels.length)];
      if (fallbackPixel) {
        centers.push({ r: fallbackPixel.r, g: fallbackPixel.g, b: fallbackPixel.b });
      }
    }
  }

  // K-means イテレーション
  const assignments = new Array(sampledPixels.length).fill(0);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;

    // 割り当てフェーズ
    for (let i = 0; i < sampledPixels.length; i++) {
      const pixel = sampledPixels[i];
      if (!pixel) continue;

      let minDist = Infinity;
      let minIndex = 0;
      for (let j = 0; j < centers.length; j++) {
        const center = centers[j];
        if (!center) continue;
        const dist = calculateColorDistance(pixel, center);
        if (dist < minDist) {
          minDist = dist;
          minIndex = j;
        }
      }
      if (assignments[i] !== minIndex) {
        assignments[i] = minIndex;
        changed = true;
      }
    }

    // 収束チェック
    if (!changed) break;

    // 更新フェーズ
    const sums: { r: number; g: number; b: number; count: number }[] = centers.map(() => ({
      r: 0,
      g: 0,
      b: 0,
      count: 0,
    }));

    for (let i = 0; i < sampledPixels.length; i++) {
      const pixel = sampledPixels[i];
      const cluster = assignments[i];
      const sum = sums[cluster];
      if (!pixel || sum === undefined) continue;
      sum.r += pixel.r;
      sum.g += pixel.g;
      sum.b += pixel.b;
      sum.count++;
    }

    for (let i = 0; i < centers.length; i++) {
      const sum = sums[i];
      if (sum && sum.count > 0) {
        centers[i] = {
          r: Math.round(sum.r / sum.count),
          g: Math.round(sum.g / sum.count),
          b: Math.round(sum.b / sum.count),
        };
      }
    }
  }

  // 各クラスタのサイズを計算
  const sizes = new Array(k).fill(0);
  for (const assignment of assignments) {
    sizes[assignment]++;
  }

  return { centers, sizes };
}

// ============================================================================
// ColorChangeAnalyzer クラス
// ============================================================================

/**
 * ColorChangeAnalyzer
 *
 * フレーム画像間の色変化を検出・分析するサービス
 */
export class ColorChangeAnalyzer {
  /**
   * RGBAバッファからドミナントカラーを抽出
   *
   * @param buffer - RGBAバッファ
   * @param width - 画像幅
   * @param height - 画像高さ
   * @param options - 抽出オプション
   * @returns ドミナントカラー配列
   */
  async extractDominantColors(
    buffer: Buffer,
    width: number,
    height: number,
    options: ExtractDominantColorsOptions = {}
  ): Promise<DominantColorsResult> {
    const k = options.k ?? DEFAULT_K;

    // バリデーション
    if (buffer.length === 0) {
      throw new Error('Buffer is empty');
    }
    if (width <= 0 || height <= 0) {
      throw new Error('Invalid dimensions');
    }

    const expectedSize = width * height * 4;
    if (buffer.length < expectedSize) {
      throw new Error(`Buffer size mismatch: expected ${expectedSize}, got ${buffer.length}`);
    }

    // ピクセルデータを抽出
    const pixels: RGB[] = [];
    for (let i = 0; i < width * height; i++) {
      const offset = i * 4;
      const r = buffer[offset];
      const g = buffer[offset + 1];
      const b = buffer[offset + 2];
      const a = buffer[offset + 3];
      // 完全透明なピクセルはスキップ、またはデータが不正な場合はスキップ
      if (a === 0 || a === undefined || r === undefined || g === undefined || b === undefined) continue;

      pixels.push({ r, g, b });
    }

    if (pixels.length === 0) {
      throw new Error('No non-transparent pixels found');
    }

    // K-means++でクラスタリング
    const { centers, sizes } = kMeansPlusPlus(pixels, Math.min(k, pixels.length));

    // 結果を構築
    const totalPixels = sizes.reduce((sum, s) => sum + s, 0);
    const colors: DominantColor[] = centers
      .map((center, i) => {
        const size = sizes[i] ?? 0;
        return {
          r: center.r,
          g: center.g,
          b: center.b,
          a: 255,
          hex: rgbToHex(center.r, center.g, center.b),
          percentage: size / totalPixels,
        };
      })
      .sort((a, b) => b.percentage - a.percentage);

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[ColorChangeAnalyzer] Extracted dominant colors:', colors.length);
    }

    return { colors };
  }

  /**
   * 2つのドミナントカラー配列間の色変化を解析
   *
   * @param colors1 - 比較元の色配列
   * @param colors2 - 比較先の色配列
   * @returns 色変化解析結果
   */
  analyzeColorChange(colors1: DominantColor[], colors2: DominantColor[]): ColorChangeAnalysis {
    if (colors1.length === 0 || colors2.length === 0) {
      return { colorShift: 0, hueChange: 0, saturationChange: 0, lightnessChange: 0 };
    }

    // 重み付き平均で色変化を計算
    let totalWeight = 0;
    let weightedColorShift = 0;
    let weightedHueChange = 0;
    let weightedSatChange = 0;
    let weightedLightChange = 0;

    for (let i = 0; i < Math.min(colors1.length, colors2.length); i++) {
      const c1 = colors1[i];
      const c2 = colors2[i];
      if (!c1 || !c2) continue;

      const weight = (c1.percentage + c2.percentage) / 2;

      // 色距離
      const colorDist = calculateColorDistance(c1, c2);
      weightedColorShift += colorDist * weight;

      // HSL変換して差分計算
      const hsl1 = rgbToHsl(c1.r, c1.g, c1.b);
      const hsl2 = rgbToHsl(c2.r, c2.g, c2.b);

      // 色相変化（360度の円環を考慮）
      let hueDiff = Math.abs(hsl2.h - hsl1.h);
      if (hueDiff > 180) hueDiff = 360 - hueDiff;
      weightedHueChange += hueDiff * weight;

      // 彩度変化
      weightedSatChange += (hsl2.s - hsl1.s) * weight;

      // 明度変化
      weightedLightChange += (hsl2.l - hsl1.l) * weight;

      totalWeight += weight;
    }

    if (totalWeight === 0) {
      return { colorShift: 0, hueChange: 0, saturationChange: 0, lightnessChange: 0 };
    }

    return {
      colorShift: weightedColorShift / totalWeight,
      hueChange: weightedHueChange / totalWeight,
      saturationChange: weightedSatChange / totalWeight,
      lightnessChange: weightedLightChange / totalWeight,
    };
  }

  /**
   * フレームシーケンスからフェード効果を検出
   *
   * @param frames - フレームのドミナントカラー情報配列
   * @param options - 検出オプション
   * @returns フェード効果検出結果
   */
  async detectFade(
    frames: FrameDominantColors[],
    options: DetectFadeOptions = {}
  ): Promise<DetectFadeResult> {
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    const fps = options.fps ?? DEFAULT_FPS;

    if (frames.length < 2) {
      return { fadeEffects: [] };
    }

    const fadeEffects: FadeEffect[] = [];

    // シーケンス全体の変化を解析
    let startFrame = 0;
    let inTransition = false;
    let transitionType: FadeEffect['change_type'] | null = null;
    let cumulativeHueChange = 0;
    let cumulativeLightnessChange = 0;

    for (let i = 1; i < frames.length; i++) {
      const prevFrame = frames[i - 1];
      const currFrame = frames[i];
      if (!prevFrame || !currFrame) continue;

      const prevColors = prevFrame.dominantColors;
      const currColors = currFrame.dominantColors;
      const analysis = this.analyzeColorChange(prevColors, currColors);

      const hasChange = analysis.colorShift >= threshold;

      if (hasChange && !inTransition) {
        // トランジション開始
        inTransition = true;
        startFrame = i - 1;
        cumulativeHueChange = analysis.hueChange;
        cumulativeLightnessChange = analysis.lightnessChange;

        // 変化タイプを判定
        if (analysis.lightnessChange >= FADE_IN_LIGHTNESS_THRESHOLD) {
          transitionType = 'fade_in';
        } else if (analysis.lightnessChange <= FADE_OUT_LIGHTNESS_THRESHOLD) {
          transitionType = 'fade_out';
        } else if (Math.abs(analysis.hueChange) >= COLOR_TRANSITION_HUE_THRESHOLD) {
          transitionType = 'color_transition';
        } else if (Math.abs(analysis.lightnessChange) >= BRIGHTNESS_CHANGE_THRESHOLD) {
          transitionType = 'brightness_change';
        }
      } else if (hasChange && inTransition) {
        // トランジション継続
        cumulativeHueChange += analysis.hueChange;
        cumulativeLightnessChange += analysis.lightnessChange;

        // タイプの再判定（累積変化に基づく）
        if (cumulativeLightnessChange >= FADE_IN_LIGHTNESS_THRESHOLD) {
          transitionType = 'fade_in';
        } else if (cumulativeLightnessChange <= FADE_OUT_LIGHTNESS_THRESHOLD) {
          transitionType = 'fade_out';
        } else if (Math.abs(cumulativeHueChange) >= COLOR_TRANSITION_HUE_THRESHOLD) {
          transitionType = 'color_transition';
        } else if (Math.abs(cumulativeLightnessChange) >= BRIGHTNESS_CHANGE_THRESHOLD) {
          transitionType = 'brightness_change';
        }
      } else if (!hasChange && inTransition) {
        // トランジション終了
        const endFrameIndex = i - 1;
        const duration = ((endFrameIndex - startFrame + 1) / fps) * 1000;

        const startFrameData = frames[startFrame];
        const endFrameData = frames[endFrameIndex];
        const startColors = startFrameData?.dominantColors ?? [];
        const endColors = endFrameData?.dominantColors ?? [];

        fadeEffects.push({
          start_frame: startFrame,
          end_frame: endFrameIndex,
          change_type: transitionType || 'brightness_change',
          affected_region: { x: 0, y: 0, width: 0, height: 0 }, // フル画像解析のためダミー
          from_color: startColors[0]?.hex ?? '#000000',
          to_color: endColors[0]?.hex ?? '#000000',
          estimated_duration_ms: Math.round(duration),
        });

        inTransition = false;
        transitionType = null;
        cumulativeHueChange = 0;
        cumulativeLightnessChange = 0;
      }
    }

    // 最後のフレームまでトランジションが続いている場合
    if (inTransition) {
      const endFrameIndex = frames.length - 1;
      const duration = ((endFrameIndex - startFrame + 1) / fps) * 1000;

      const startFrameData = frames[startFrame];
      const endFrameData = frames[endFrameIndex];
      const startColors = startFrameData?.dominantColors ?? [];
      const endColors = endFrameData?.dominantColors ?? [];

      fadeEffects.push({
        start_frame: startFrame,
        end_frame: endFrameIndex,
        change_type: transitionType || 'brightness_change',
        affected_region: { x: 0, y: 0, width: 0, height: 0 },
        from_color: startColors[0]?.hex ?? '#000000',
        to_color: endColors[0]?.hex ?? '#000000',
        estimated_duration_ms: Math.round(duration),
      });
    }

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[ColorChangeAnalyzer] Detected fade effects:', fadeEffects.length);
    }

    return { fadeEffects };
  }

  /**
   * フレームバッファ配列を解析して色変化を検出
   *
   * @param frameBuffers - フレームバッファ配列
   * @param options - 解析オプション
   * @returns 色変化解析結果
   */
  async analyze(
    frameBuffers: FrameBuffer[],
    options: AnalyzeOptions = {}
  ): Promise<ColorChangeResult> {
    if (frameBuffers.length === 0) {
      throw new Error('No frames to analyze');
    }

    const k = options.k ?? DEFAULT_K;
    const fps = options.fps ?? DEFAULT_FPS;
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;

    // 各フレームのドミナントカラーを抽出
    const dominantColors: { frameIndex: number; colors: DominantColor[] }[] = [];

    for (let i = 0; i < frameBuffers.length; i++) {
      const frame = frameBuffers[i];
      if (!frame) continue;
      const result = await this.extractDominantColors(frame.buffer, frame.width, frame.height, { k });
      dominantColors.push({
        frameIndex: i,
        colors: result.colors,
      });
    }

    // フレーム間の色変化を計算
    const changes: ColorChange[] = [];
    for (let i = 1; i < dominantColors.length; i++) {
      const prevDominant = dominantColors[i - 1];
      const currDominant = dominantColors[i];
      if (!prevDominant || !currDominant) continue;

      const prevColors = prevDominant.colors;
      const currColors = currDominant.colors;
      const analysis = this.analyzeColorChange(prevColors, currColors);

      changes.push({
        fromFrame: i - 1,
        toFrame: i,
        colorShift: analysis.colorShift,
        hueChange: analysis.hueChange,
        saturationChange: analysis.saturationChange,
        lightnessChange: analysis.lightnessChange,
      });
    }

    // フェード効果を検出
    const frameDominantColors: FrameDominantColors[] = dominantColors.map((d) => ({
      dominantColors: d.colors,
    }));
    const fadeResult = await this.detectFade(frameDominantColors, { threshold, fps });

    // 平均色変化量を計算
    const averageColorShift =
      changes.length > 0
        ? changes.reduce((sum, c) => sum + c.colorShift, 0) / changes.length
        : 0;

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[ColorChangeAnalyzer] Analysis complete:', {
        frames: frameBuffers.length,
        changes: changes.length,
        fadeEffects: fadeResult.fadeEffects.length,
        avgColorShift: averageColorShift.toFixed(4),
      });
    }

    return {
      dominantColors,
      changes,
      fadeEffects: fadeResult.fadeEffects,
      averageColorShift,
    };
  }
}

// ============================================================================
// デフォルトエクスポート
// ============================================================================

export default ColorChangeAnalyzer;
