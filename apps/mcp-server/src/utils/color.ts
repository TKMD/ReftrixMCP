// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 共通カラーユーティリティ
 * RGB/HEX/HSL変換、色調整、類似度計算を提供
 *
 * 対応する色形式:
 * - HEX: #RGB, #RRGGBB
 * - RGB: { r: 0-255, g: 0-255, b: 0-255 }
 * - HSL: { h: 0-360, s: 0-100, l: 0-100 }
 *
 * @module utils/color
 */

// =============================================================================
// 型定義
// =============================================================================

/**
 * RGB色表現
 */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/**
 * HSL色表現
 */
export interface HslColor {
  h: number;
  s: number;
  l: number;
}

// =============================================================================
// HEX <-> RGB 変換
// =============================================================================

/**
 * HEXカラーをRGBに変換
 *
 * @param hex - HEXカラー文字列 (#RGB, #RRGGBB, RGB, RRGGBB)
 * @returns RGBオブジェクト、または無効な入力の場合null
 *
 * @example
 * hexToRgb('#3B82F6') // { r: 59, g: 130, b: 246 }
 * hexToRgb('#FFF')    // { r: 255, g: 255, b: 255 }
 * hexToRgb('invalid') // null
 */
export function hexToRgb(hex: string): RgbColor | null {
  // 入力バリデーション
  if (hex === null || hex === undefined || typeof hex !== 'string') {
    return null;
  }

  // 空文字列チェック
  if (hex === '') {
    return null;
  }

  // 先頭/末尾にスペースがある場合は無効
  if (hex !== hex.trim()) {
    return null;
  }

  // スペースを含む場合は無効
  if (hex.includes(' ')) {
    return null;
  }

  // #を除去
  let cleanHex = hex.startsWith('#') ? hex.slice(1) : hex;

  // 3桁HEXを6桁に展開
  if (cleanHex.length === 3) {
    const [r, g, b] = cleanHex.split('');
    if (r === undefined || g === undefined || b === undefined) {
      return null;
    }
    cleanHex = `${r}${r}${g}${g}${b}${b}`;
  }

  // 6桁以外は無効
  if (cleanHex.length !== 6) {
    return null;
  }

  // 有効な16進数文字のみ許可
  if (!/^[0-9a-fA-F]{6}$/.test(cleanHex)) {
    return null;
  }

  const r = parseInt(cleanHex.slice(0, 2), 16);
  const g = parseInt(cleanHex.slice(2, 4), 16);
  const b = parseInt(cleanHex.slice(4, 6), 16);

  return { r, g, b };
}

/**
 * RGBをHEXカラーに変換
 *
 * @param r - 赤成分 (0-255)
 * @param g - 緑成分 (0-255)
 * @param b - 青成分 (0-255)
 * @returns 大文字6桁HEXカラー (#RRGGBB)
 *
 * @example
 * rgbToHex(59, 130, 246) // '#3B82F6'
 * rgbToHex(255, 0, 0)    // '#FF0000'
 */
export function rgbToHex(r: number, g: number, b: number): string {
  /**
   * 数値を0-255の範囲にクランプして2桁の16進数文字列に変換
   */
  const toHex = (n: number): string => {
    // NaNチェック
    if (Number.isNaN(n)) {
      n = 0;
    }
    // 小数を四捨五入
    const rounded = Math.round(n);
    // 0-255にクランプ
    const clamped = Math.max(0, Math.min(255, rounded));
    return clamped.toString(16).padStart(2, '0').toUpperCase();
  };

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// =============================================================================
// RGB <-> HSL 変換
// =============================================================================

/**
 * RGBをHSLに変換
 *
 * @param r - 赤成分 (0-255)
 * @param g - 緑成分 (0-255)
 * @param b - 青成分 (0-255)
 * @returns HSLオブジェクト { h: 0-360, s: 0-100, l: 0-100 }
 *
 * @example
 * rgbToHsl(255, 0, 0)   // { h: 0, s: 100, l: 50 }
 * rgbToHsl(0, 255, 0)   // { h: 120, s: 100, l: 50 }
 * rgbToHsl(128, 128, 128) // { h: 0, s: 0, l: 約50 }
 */
export function rgbToHsl(r: number, g: number, b: number): HslColor {
  // 0-1の範囲に正規化
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
        h = ((gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0)) / 6;
        break;
      case gNorm:
        h = ((bNorm - rNorm) / d + 2) / 6;
        break;
      case bNorm:
        h = ((rNorm - gNorm) / d + 4) / 6;
        break;
    }
  }

  // 高精度HSL値を返す
  // 往復変換での誤差を最小化するため、浮動小数点を保持
  // ただしテストとの互換性のため、表示用途では整数に丸めることを推奨
  return {
    h: h * 360,
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
 * @returns RGBオブジェクト { r: 0-255, g: 0-255, b: 0-255 }
 *
 * @example
 * hslToRgb(0, 100, 50)   // { r: 255, g: 0, b: 0 }
 * hslToRgb(120, 100, 50) // { r: 0, g: 255, b: 0 }
 */
export function hslToRgb(h: number, s: number, l: number): RgbColor {
  // 360度以上の色相を正規化
  const hNorm = ((h % 360) + 360) % 360 / 360;
  const sNorm = s / 100;
  const lNorm = l / 100;

  let r: number;
  let g: number;
  let b: number;

  if (sNorm === 0) {
    // 彩度が0の場合（グレースケール）
    r = g = b = lNorm;
  } else {
    /**
     * HSL色相をRGB成分に変換するヘルパー関数
     */
    const hue2rgb = (p: number, q: number, t: number): number => {
      let tNorm = t;
      if (tNorm < 0) tNorm += 1;
      if (tNorm > 1) tNorm -= 1;
      if (tNorm < 1 / 6) return p + (q - p) * 6 * tNorm;
      if (tNorm < 1 / 2) return q;
      if (tNorm < 2 / 3) return p + (q - p) * (2 / 3 - tNorm) * 6;
      return p;
    };

    const q = lNorm < 0.5 ? lNorm * (1 + sNorm) : lNorm + sNorm - lNorm * sNorm;
    const p = 2 * lNorm - q;
    r = hue2rgb(p, q, hNorm + 1 / 3);
    g = hue2rgb(p, q, hNorm);
    b = hue2rgb(p, q, hNorm - 1 / 3);
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

// =============================================================================
// 色調整関数
// =============================================================================

/**
 * HEXカラーの彩度と明度を調整
 *
 * @param hex - HEXカラー文字列
 * @param saturationDelta - 彩度の変化量 (-100 to 100)
 * @param lightnessDelta - 明度の変化量 (-100 to 100)
 * @returns 調整後のHEXカラー、無効な入力の場合null
 *
 * @example
 * adjustColor('#808080', 50, 0)  // 彩度を上げる
 * adjustColor('#FF0000', -50, 0) // 彩度を下げる
 * adjustColor('#808080', 0, 25)  // 明度を上げる
 */
export function adjustColor(
  hex: string,
  saturationDelta: number,
  lightnessDelta: number
): string | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;

  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

  // 彩度と明度を調整（0-100の範囲にクランプ）
  hsl.s = Math.max(0, Math.min(100, hsl.s + saturationDelta));
  hsl.l = Math.max(0, Math.min(100, hsl.l + lightnessDelta));

  const newRgb = hslToRgb(hsl.h, hsl.s, hsl.l);
  return rgbToHex(newRgb.r, newRgb.g, newRgb.b);
}

// =============================================================================
// 色類似度計算
// =============================================================================

/**
 * 2つのHEXカラー間の類似度を計算
 *
 * RGB空間でのユークリッド距離を基に0-1の類似度を返す
 * 1が完全一致、0が最大の差異
 *
 * @param hex1 - 比較する色1 (HEX形式)
 * @param hex2 - 比較する色2 (HEX形式)
 * @returns 類似度 (0-1)、無効な入力の場合0
 *
 * @example
 * calculateColorSimilarity('#3B82F6', '#3B82F6') // 1 (完全一致)
 * calculateColorSimilarity('#000000', '#FFFFFF') // 約0.13 (最大差)
 * calculateColorSimilarity('#3B82F6', '#4B92FF') // > 0.8 (類似)
 */
export function calculateColorSimilarity(hex1: string, hex2: string): number {
  // 入力バリデーション
  if (hex1 === null || hex1 === undefined || hex2 === null || hex2 === undefined) {
    return 0;
  }

  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);

  if (!rgb1 || !rgb2) return 0;

  // ユークリッド距離を計算
  const distance = Math.sqrt(
    Math.pow(rgb1.r - rgb2.r, 2) +
    Math.pow(rgb1.g - rgb2.g, 2) +
    Math.pow(rgb1.b - rgb2.b, 2)
  );

  // 最大距離は sqrt(255^2 * 3) = sqrt(195075) ≒ 441.67
  const maxDistance = Math.sqrt(255 * 255 * 3);

  return 1 - distance / maxDistance;
}

// =============================================================================
// CIE LAB色空間変換とΔE色距離計算
// =============================================================================

/**
 * CIE LAB色表現
 */
export interface LabColor {
  l: number; // Lightness (0-100)
  a: number; // Green-Red (-128 to 127)
  b: number; // Blue-Yellow (-128 to 127)
}

/**
 * RGB (sRGB) をCIE XYZ色空間に変換
 * D65光源（標準昼光）を基準
 *
 * @param rgb - RGBオブジェクト
 * @returns XYZ値オブジェクト
 */
function rgbToXyz(rgb: RgbColor): { x: number; y: number; z: number } {
  // sRGB値を0-1に正規化してガンマ補正を適用
  const normalize = (c: number): number => {
    const val = c / 255;
    // sRGBのガンマ補正（逆変換）
    return val > 0.04045
      ? Math.pow((val + 0.055) / 1.055, 2.4)
      : val / 12.92;
  };

  const r = normalize(rgb.r);
  const g = normalize(rgb.g);
  const b = normalize(rgb.b);

  // sRGB to XYZ行列変換（D65光源）
  // Observer: 2°, Illuminant: D65
  return {
    x: r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    y: r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
    z: r * 0.0193339 + g * 0.1191920 + b * 0.9503041,
  };
}

/**
 * XYZ色空間をCIE LAB色空間に変換
 * D65光源（標準昼光）を基準
 *
 * @param xyz - XYZオブジェクト
 * @returns LABオブジェクト
 */
function xyzToLab(xyz: { x: number; y: number; z: number }): LabColor {
  // D65光源の参照白色点
  const refX = 0.95047;
  const refY = 1.0;
  const refZ = 1.08883;

  // XYZ値を参照白色点で正規化
  const x = xyz.x / refX;
  const y = xyz.y / refY;
  const z = xyz.z / refZ;

  // CIE LAB変換関数
  const f = (t: number): number => {
    const delta = 6 / 29;
    return t > Math.pow(delta, 3)
      ? Math.pow(t, 1 / 3)
      : t / (3 * Math.pow(delta, 2)) + 4 / 29;
  };

  const fy = f(y);

  return {
    l: 116 * fy - 16,
    a: 500 * (f(x) - fy),
    b: 200 * (fy - f(z)),
  };
}

/**
 * RGB色をCIE LAB色空間に変換
 *
 * @param rgb - RGBオブジェクト
 * @returns LABオブジェクト
 *
 * @example
 * rgbToLab({ r: 255, g: 0, b: 0 })
 * // { l: 53.233, a: 80.109, b: 67.220 } (赤)
 */
export function rgbToLab(rgb: RgbColor): LabColor {
  const xyz = rgbToXyz(rgb);
  return xyzToLab(xyz);
}

/**
 * HEXカラーをCIE LAB色空間に変換
 *
 * @param hex - HEXカラー文字列
 * @returns LABオブジェクト、無効な入力の場合null
 *
 * @example
 * hexToLab('#FF0000')
 * // { l: 53.233, a: 80.109, b: 67.220 } (赤)
 */
export function hexToLab(hex: string): LabColor | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return rgbToLab(rgb);
}

/**
 * ΔE (CIE76) 色距離を計算
 * CIE LAB空間でのユークリッド距離
 *
 * JND (Just Noticeable Difference):
 * - ΔE < 1: 人間の目では区別不可能
 * - 1 ≤ ΔE < 2: ほぼ同じ色として認識
 * - 2 ≤ ΔE < 3.5: 注意深く見ると違いがわかる
 * - 3.5 ≤ ΔE < 5: 容易に違いがわかる
 * - ΔE ≥ 5: 明らかに異なる色
 *
 * @param lab1 - 比較する色1 (LAB形式)
 * @param lab2 - 比較する色2 (LAB形式)
 * @returns ΔE値 (0以上、通常0-100程度)
 *
 * @example
 * const lab1 = hexToLab('#FF0000');
 * const lab2 = hexToLab('#FF1100');
 * calculateDeltaE76(lab1, lab2) // 約4.7
 */
export function calculateDeltaE76(lab1: LabColor, lab2: LabColor): number {
  return Math.sqrt(
    Math.pow(lab1.l - lab2.l, 2) +
    Math.pow(lab1.a - lab2.a, 2) +
    Math.pow(lab1.b - lab2.b, 2)
  );
}

/**
 * 2つのHEXカラー間のΔE (CIE76) 色距離を計算
 *
 * デフォルトの許容値は15で、これは「色調が似ている」と認識される範囲
 *
 * @param hex1 - 比較する色1 (HEX形式)
 * @param hex2 - 比較する色2 (HEX形式)
 * @returns ΔE値、無効な入力の場合Infinity
 *
 * @example
 * calculateDeltaEFromHex('#3B82F6', '#3B82F6') // 0 (完全一致)
 * calculateDeltaEFromHex('#3B82F6', '#4B92FF') // 約5.3 (類似)
 * calculateDeltaEFromHex('#FF0000', '#00FF00') // 約86 (非常に異なる)
 */
export function calculateDeltaEFromHex(hex1: string, hex2: string): number {
  const lab1 = hexToLab(hex1);
  const lab2 = hexToLab(hex2);

  if (!lab1 || !lab2) {
    return Infinity;
  }

  return calculateDeltaE76(lab1, lab2);
}

/**
 * 指定された許容度内で色が一致するかをチェック
 *
 * @param targetHex - ターゲット色 (HEX形式)
 * @param candidateHex - 候補色 (HEX形式)
 * @param tolerance - ΔE許容度（デフォルト15）
 * @returns 許容度内であればtrue
 *
 * @example
 * isColorWithinTolerance('#3B82F6', '#3B82F6', 15) // true
 * isColorWithinTolerance('#FF0000', '#00FF00', 15) // false
 */
export function isColorWithinTolerance(
  targetHex: string,
  candidateHex: string,
  tolerance: number = 15
): boolean {
  const deltaE = calculateDeltaEFromHex(targetHex, candidateHex);
  return deltaE <= tolerance;
}

// =============================================================================
// HEX正規化
// =============================================================================

/**
 * HEXカラーを正規化（大文字6桁形式に統一）
 *
 * @param hex - HEXカラー文字列
 * @returns 正規化されたHEXカラー (#RRGGBB)、無効な入力の場合null
 *
 * @example
 * normalizeHexColor('#3b82f6')  // '#3B82F6'
 * normalizeHexColor('3B82F6')   // '#3B82F6'
 * normalizeHexColor('#ABC')     // '#AABBCC'
 * normalizeHexColor('  #fff  ') // '#FFFFFF'
 * normalizeHexColor('invalid')  // null
 */
export function normalizeHexColor(hex: string): string | null {
  // 入力バリデーション
  if (hex === null || hex === undefined || typeof hex !== 'string') {
    return null;
  }

  // 前後の空白を除去
  const trimmed = hex.trim();
  if (trimmed === '') {
    return null;
  }

  // hexToRgbで変換を試みる
  const rgb = hexToRgb(trimmed);
  if (!rgb) {
    return null;
  }

  // RGBからHEXに変換（正規化された形式で返す）
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}
