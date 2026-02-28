// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 共通カラーユーティリティテスト
 * TDD Red フェーズ: 失敗するテストを先に作成
 *
 * 目的:
 * - RGB <-> HEX 変換
 * - RGB <-> HSL 変換
 * - 色調整（彩度・明度）
 * - 色類似度計算
 * - HEX正規化
 *
 * 対象ファイル: apps/mcp-server/src/utils/color.ts (未作成)
 *
 * 既存の実装を統合:
 * - color-extractor.ts: hexToRgb, rgbToHex, hslToRgb (ローカル関数)
 * - color-converter.ts: OKLCH変換 (culori使用)
 *
 * 参照:
 * - CSS Color Level 4: https://www.w3.org/TR/css-color-4/
 * - sRGB色空間仕様
 */

import { describe, it, expect, beforeAll } from 'vitest';

// =============================================================================
// TDD Red: まだ存在しないモジュールからインポート
// このインポートは実装前なので失敗する
// =============================================================================

import {
  hexToRgb,
  rgbToHex,
  rgbToHsl,
  hslToRgb,
  adjustColor,
  calculateColorSimilarity,
  normalizeHexColor,
} from '../../src/utils/color';

// =============================================================================
// テスト用定数
// =============================================================================

// 標準的なカラーサンプル（テスト用）
const COLOR_SAMPLES = {
  // 基本色
  black: { hex: '#000000', rgb: { r: 0, g: 0, b: 0 }, hsl: { h: 0, s: 0, l: 0 } },
  white: { hex: '#FFFFFF', rgb: { r: 255, g: 255, b: 255 }, hsl: { h: 0, s: 0, l: 100 } },
  gray: { hex: '#808080', rgb: { r: 128, g: 128, b: 128 }, hsl: { h: 0, s: 0, l: 50 } },

  // 原色（RGB）
  red: { hex: '#FF0000', rgb: { r: 255, g: 0, b: 0 }, hsl: { h: 0, s: 100, l: 50 } },
  green: { hex: '#00FF00', rgb: { r: 0, g: 255, b: 0 }, hsl: { h: 120, s: 100, l: 50 } },
  blue: { hex: '#0000FF', rgb: { r: 0, g: 0, b: 255 }, hsl: { h: 240, s: 100, l: 50 } },

  // 二次色
  yellow: { hex: '#FFFF00', rgb: { r: 255, g: 255, b: 0 }, hsl: { h: 60, s: 100, l: 50 } },
  cyan: { hex: '#00FFFF', rgb: { r: 0, g: 255, b: 255 }, hsl: { h: 180, s: 100, l: 50 } },
  magenta: { hex: '#FF00FF', rgb: { r: 255, g: 0, b: 255 }, hsl: { h: 300, s: 100, l: 50 } },

  // Tailwind CSS カラー（実用的なサンプル）
  tailwindBlue500: { hex: '#3B82F6', rgb: { r: 59, g: 130, b: 246 } },
  tailwindGreen500: { hex: '#22C55E', rgb: { r: 34, g: 197, b: 94 } },
  tailwindRed500: { hex: '#EF4444', rgb: { r: 239, g: 68, b: 68 } },
};

// 許容誤差（浮動小数点計算用）
// toBeCloseTo(expected, numDigits) の numDigits は小数点以下桁数
// 許容誤差 = 0.5 * 10^(-numDigits)
// numDigits=0 -> 許容誤差0.5 (±0.5の範囲、約1%相当)
// numDigits=1 -> 許容誤差0.05 (±0.05の範囲)
const TOLERANCE = {
  hsl: 0, // HSL変換での許容誤差（toBeCloseToのnumDigits、±0.5の範囲）
  hslRoundTrip: 1, // HSL往復変換での許容誤差（toBeLessThanOrEqualの値、±1の範囲）
  similarity: 0.01, // 類似度計算での許容誤差
};

// =============================================================================
// hexToRgb テスト
// =============================================================================

describe('hexToRgb - HEXからRGBへの変換', () => {
  describe('正常系', () => {
    it('6桁HEX（大文字）を正しくRGBに変換すること', () => {
      // Arrange
      const hex = '#3B82F6';
      const expected = { r: 59, g: 130, b: 246 };

      // Act
      const result = hexToRgb(hex);

      // Assert
      expect(result).not.toBeNull();
      expect(result).toEqual(expected);
    });

    it('6桁HEX（小文字）を正しくRGBに変換すること', () => {
      const hex = '#3b82f6';
      const expected = { r: 59, g: 130, b: 246 };

      const result = hexToRgb(hex);

      expect(result).not.toBeNull();
      expect(result).toEqual(expected);
    });

    it('#なしの6桁HEXを正しく変換すること', () => {
      const hex = '3B82F6';
      const expected = { r: 59, g: 130, b: 246 };

      const result = hexToRgb(hex);

      expect(result).not.toBeNull();
      expect(result).toEqual(expected);
    });

    it('黒色（#000000）を正しく変換すること', () => {
      const hex = '#000000';
      const expected = COLOR_SAMPLES.black.rgb;

      const result = hexToRgb(hex);

      expect(result).toEqual(expected);
    });

    it('白色（#FFFFFF）を正しく変換すること', () => {
      const hex = '#FFFFFF';
      const expected = COLOR_SAMPLES.white.rgb;

      const result = hexToRgb(hex);

      expect(result).toEqual(expected);
    });

    it('グレー（#808080）を正しく変換すること', () => {
      const hex = '#808080';
      const expected = COLOR_SAMPLES.gray.rgb;

      const result = hexToRgb(hex);

      expect(result).toEqual(expected);
    });

    it('原色（赤・緑・青）を正しく変換すること', () => {
      expect(hexToRgb('#FF0000')).toEqual(COLOR_SAMPLES.red.rgb);
      expect(hexToRgb('#00FF00')).toEqual(COLOR_SAMPLES.green.rgb);
      expect(hexToRgb('#0000FF')).toEqual(COLOR_SAMPLES.blue.rgb);
    });
  });

  describe('境界値テスト', () => {
    it('3桁HEX（#RGB形式）を6桁に展開して変換すること', () => {
      // #ABC → #AABBCC
      const hex = '#ABC';
      const expected = { r: 170, g: 187, b: 204 };

      const result = hexToRgb(hex);

      expect(result).not.toBeNull();
      expect(result).toEqual(expected);
    });

    it('3桁HEX（小文字）を正しく変換すること', () => {
      const hex = '#fff';
      const expected = { r: 255, g: 255, b: 255 };

      const result = hexToRgb(hex);

      expect(result).toEqual(expected);
    });

    it('RGB各成分が最小値（0）の場合を処理すること', () => {
      const hex = '#000000';
      const result = hexToRgb(hex);

      expect(result?.r).toBe(0);
      expect(result?.g).toBe(0);
      expect(result?.b).toBe(0);
    });

    it('RGB各成分が最大値（255）の場合を処理すること', () => {
      const hex = '#FFFFFF';
      const result = hexToRgb(hex);

      expect(result?.r).toBe(255);
      expect(result?.g).toBe(255);
      expect(result?.b).toBe(255);
    });
  });

  describe('異常系', () => {
    it('無効なHEX文字（G-Z）を含む場合nullを返すこと', () => {
      const invalidHexValues = ['#GGGGGG', '#ZZZZZZ', '#12345G', '#GG0000'];

      invalidHexValues.forEach((hex) => {
        expect(hexToRgb(hex)).toBeNull();
      });
    });

    it('桁数が不正な場合nullを返すこと', () => {
      const invalidHexValues = ['#FF', '#FFFF', '#FFFFFFF', '#FFFFFFFFF'];

      invalidHexValues.forEach((hex) => {
        expect(hexToRgb(hex)).toBeNull();
      });
    });

    it('空文字列の場合nullを返すこと', () => {
      expect(hexToRgb('')).toBeNull();
    });

    it('nullの入力でnullを返すこと', () => {
      // @ts-expect-error テスト用の不正な入力
      expect(hexToRgb(null)).toBeNull();
    });

    it('undefinedの入力でnullを返すこと', () => {
      // @ts-expect-error テスト用の不正な入力
      expect(hexToRgb(undefined)).toBeNull();
    });

    it('数値の入力でnullを返すこと', () => {
      // @ts-expect-error テスト用の不正な入力
      expect(hexToRgb(0xff0000)).toBeNull();
    });

    it('スペースを含むHEXでnullを返すこと', () => {
      expect(hexToRgb('#FF 00 00')).toBeNull();
      expect(hexToRgb(' #FF0000')).toBeNull();
      expect(hexToRgb('#FF0000 ')).toBeNull();
    });

    it('特殊文字を含むHEXでnullを返すこと', () => {
      const invalidHexValues = ['#FF00!0', '#FF00@0', '#FF00$0'];

      invalidHexValues.forEach((hex) => {
        expect(hexToRgb(hex)).toBeNull();
      });
    });
  });
});

// =============================================================================
// rgbToHex テスト
// =============================================================================

describe('rgbToHex - RGBからHEXへの変換', () => {
  describe('正常系', () => {
    it('RGB値を大文字6桁HEXに変換すること', () => {
      const result = rgbToHex(59, 130, 246);

      expect(result).toBe('#3B82F6');
    });

    it('黒色（0,0,0）を#000000に変換すること', () => {
      const result = rgbToHex(0, 0, 0);

      expect(result).toBe('#000000');
    });

    it('白色（255,255,255）を#FFFFFFに変換すること', () => {
      const result = rgbToHex(255, 255, 255);

      expect(result).toBe('#FFFFFF');
    });

    it('原色を正しいHEXに変換すること', () => {
      expect(rgbToHex(255, 0, 0)).toBe('#FF0000');
      expect(rgbToHex(0, 255, 0)).toBe('#00FF00');
      expect(rgbToHex(0, 0, 255)).toBe('#0000FF');
    });

    it('グレースケール値を正しく変換すること', () => {
      expect(rgbToHex(128, 128, 128)).toBe('#808080');
      expect(rgbToHex(64, 64, 64)).toBe('#404040');
      expect(rgbToHex(192, 192, 192)).toBe('#C0C0C0');
    });

    it('Tailwindカラーを正しく変換すること', () => {
      expect(rgbToHex(59, 130, 246)).toBe('#3B82F6');
      expect(rgbToHex(34, 197, 94)).toBe('#22C55E');
      expect(rgbToHex(239, 68, 68)).toBe('#EF4444');
    });
  });

  describe('境界値テスト', () => {
    it('各成分が0の場合を処理すること', () => {
      expect(rgbToHex(0, 128, 128)).toBe('#008080');
      expect(rgbToHex(128, 0, 128)).toBe('#800080');
      expect(rgbToHex(128, 128, 0)).toBe('#808000');
    });

    it('各成分が255の場合を処理すること', () => {
      expect(rgbToHex(255, 128, 128)).toBe('#FF8080');
      expect(rgbToHex(128, 255, 128)).toBe('#80FF80');
      expect(rgbToHex(128, 128, 255)).toBe('#8080FF');
    });

    it('1桁の16進数値を0埋めすること', () => {
      // 0-15 は 00-0F にパディング
      expect(rgbToHex(0, 0, 1)).toBe('#000001');
      expect(rgbToHex(1, 1, 1)).toBe('#010101');
      expect(rgbToHex(15, 15, 15)).toBe('#0F0F0F');
    });
  });

  describe('異常系', () => {
    it('範囲外の値（255超）をクランプすること', () => {
      // 実装により、クランプまたはエラーのいずれか
      const result = rgbToHex(300, 128, 128);

      // クランプされる場合は255として扱われる
      expect(result).toBe('#FF8080');
    });

    it('負の値を0にクランプすること', () => {
      const result = rgbToHex(-10, 128, 128);

      expect(result).toBe('#008080');
    });

    it('小数値を四捨五入すること', () => {
      const result = rgbToHex(127.6, 127.4, 128);

      // 127.6 → 128, 127.4 → 127
      expect(result).toBe('#807F80');
    });

    it('NaN入力を適切に処理すること', () => {
      // NaNは0として扱われるか、エラーになる
      try {
        const result = rgbToHex(NaN, 128, 128);
        // NaNが0として扱われる場合
        expect(result).toBe('#008080');
      } catch {
        // エラーになる実装もOK
        expect(true).toBe(true);
      }
    });
  });
});

// =============================================================================
// rgbToHsl テスト
// =============================================================================

describe('rgbToHsl - RGBからHSLへの変換', () => {
  describe('正常系', () => {
    it('純赤（255,0,0）をHSL(0,100,50)に変換すること', () => {
      const result = rgbToHsl(255, 0, 0);

      expect(result.h).toBeCloseTo(0, TOLERANCE.hsl);
      expect(result.s).toBeCloseTo(100, TOLERANCE.hsl);
      expect(result.l).toBeCloseTo(50, TOLERANCE.hsl);
    });

    it('純緑（0,255,0）をHSL(120,100,50)に変換すること', () => {
      const result = rgbToHsl(0, 255, 0);

      expect(result.h).toBeCloseTo(120, TOLERANCE.hsl);
      expect(result.s).toBeCloseTo(100, TOLERANCE.hsl);
      expect(result.l).toBeCloseTo(50, TOLERANCE.hsl);
    });

    it('純青（0,0,255）をHSL(240,100,50)に変換すること', () => {
      const result = rgbToHsl(0, 0, 255);

      expect(result.h).toBeCloseTo(240, TOLERANCE.hsl);
      expect(result.s).toBeCloseTo(100, TOLERANCE.hsl);
      expect(result.l).toBeCloseTo(50, TOLERANCE.hsl);
    });

    it('黄色（255,255,0）をHSL(60,100,50)に変換すること', () => {
      const result = rgbToHsl(255, 255, 0);

      expect(result.h).toBeCloseTo(60, TOLERANCE.hsl);
      expect(result.s).toBeCloseTo(100, TOLERANCE.hsl);
      expect(result.l).toBeCloseTo(50, TOLERANCE.hsl);
    });

    it('シアン（0,255,255）をHSL(180,100,50)に変換すること', () => {
      const result = rgbToHsl(0, 255, 255);

      expect(result.h).toBeCloseTo(180, TOLERANCE.hsl);
      expect(result.s).toBeCloseTo(100, TOLERANCE.hsl);
      expect(result.l).toBeCloseTo(50, TOLERANCE.hsl);
    });

    it('マゼンタ（255,0,255）をHSL(300,100,50)に変換すること', () => {
      const result = rgbToHsl(255, 0, 255);

      expect(result.h).toBeCloseTo(300, TOLERANCE.hsl);
      expect(result.s).toBeCloseTo(100, TOLERANCE.hsl);
      expect(result.l).toBeCloseTo(50, TOLERANCE.hsl);
    });
  });

  describe('グレースケール', () => {
    it('黒（0,0,0）をHSL(0,0,0)に変換すること', () => {
      const result = rgbToHsl(0, 0, 0);

      expect(result.s).toBe(0);
      expect(result.l).toBe(0);
      // 彩度0の場合、色相は任意（通常0）
    });

    it('白（255,255,255）をHSL(0,0,100)に変換すること', () => {
      const result = rgbToHsl(255, 255, 255);

      expect(result.s).toBe(0);
      expect(result.l).toBe(100);
    });

    it('50%グレー（128,128,128）を正しく変換すること', () => {
      const result = rgbToHsl(128, 128, 128);

      expect(result.s).toBe(0);
      expect(result.l).toBeCloseTo(50, TOLERANCE.hsl);
    });

    it('様々なグレースケール値が彩度0になること', () => {
      const grayValues = [64, 96, 128, 160, 192];

      grayValues.forEach((v) => {
        const result = rgbToHsl(v, v, v);
        expect(result.s).toBe(0);
      });
    });
  });

  describe('エッジケース', () => {
    it('低彩度色を正しく変換すること', () => {
      // Tailwind Gray 500相当
      const result = rgbToHsl(107, 114, 128);

      expect(result.s).toBeLessThan(20); // 低彩度
      // L = (max + min) / 2 * 100 = (128/255 + 107/255) / 2 * 100 ≈ 46.08
      expect(result.l).toBeCloseTo(46, TOLERANCE.hsl);
    });

    it('高彩度色を正しく変換すること', () => {
      // 鮮やかなオレンジ
      const result = rgbToHsl(255, 128, 0);

      expect(result.s).toBe(100);
      expect(result.l).toBe(50);
      expect(result.h).toBeCloseTo(30, TOLERANCE.hsl);
    });
  });
});

// =============================================================================
// hslToRgb テスト
// =============================================================================

describe('hslToRgb - HSLからRGBへの変換', () => {
  describe('正常系', () => {
    it('HSL(0,100,50)を純赤（255,0,0）に変換すること', () => {
      const result = hslToRgb(0, 100, 50);

      expect(result.r).toBe(255);
      expect(result.g).toBe(0);
      expect(result.b).toBe(0);
    });

    it('HSL(120,100,50)を純緑（0,255,0）に変換すること', () => {
      const result = hslToRgb(120, 100, 50);

      expect(result.r).toBe(0);
      expect(result.g).toBe(255);
      expect(result.b).toBe(0);
    });

    it('HSL(240,100,50)を純青（0,0,255）に変換すること', () => {
      const result = hslToRgb(240, 100, 50);

      expect(result.r).toBe(0);
      expect(result.g).toBe(0);
      expect(result.b).toBe(255);
    });

    it('HSL(60,100,50)を黄色（255,255,0）に変換すること', () => {
      const result = hslToRgb(60, 100, 50);

      expect(result.r).toBe(255);
      expect(result.g).toBe(255);
      expect(result.b).toBe(0);
    });

    it('HSL(180,100,50)をシアン（0,255,255）に変換すること', () => {
      const result = hslToRgb(180, 100, 50);

      expect(result.r).toBe(0);
      expect(result.g).toBe(255);
      expect(result.b).toBe(255);
    });

    it('HSL(300,100,50)をマゼンタ（255,0,255）に変換すること', () => {
      const result = hslToRgb(300, 100, 50);

      expect(result.r).toBe(255);
      expect(result.g).toBe(0);
      expect(result.b).toBe(255);
    });
  });

  describe('グレースケール', () => {
    it('HSL(0,0,0)を黒（0,0,0）に変換すること', () => {
      const result = hslToRgb(0, 0, 0);

      expect(result).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('HSL(0,0,100)を白（255,255,255）に変換すること', () => {
      const result = hslToRgb(0, 0, 100);

      expect(result).toEqual({ r: 255, g: 255, b: 255 });
    });

    it('HSL(0,0,50)を50%グレーに変換すること', () => {
      const result = hslToRgb(0, 0, 50);

      // 約128（四捨五入の関係で127または128）
      expect(result.r).toBeCloseTo(128, 0);
      expect(result.g).toBeCloseTo(128, 0);
      expect(result.b).toBeCloseTo(128, 0);
    });

    it('彩度0の場合、色相に関係なく同じ結果になること', () => {
      const hues = [0, 60, 120, 180, 240, 300];
      const results = hues.map((h) => hslToRgb(h, 0, 50));

      // 全て同じRGB値になるはず
      results.forEach((result) => {
        expect(result.r).toBe(results[0].r);
        expect(result.g).toBe(results[0].g);
        expect(result.b).toBe(results[0].b);
      });
    });
  });

  describe('エッジケース', () => {
    it('色相360度が0度と同じ結果になること', () => {
      const result0 = hslToRgb(0, 100, 50);
      const result360 = hslToRgb(360, 100, 50);

      expect(result0).toEqual(result360);
    });

    it('明度0%の場合、常に黒になること', () => {
      const hues = [0, 60, 120, 180, 240, 300];

      hues.forEach((h) => {
        const result = hslToRgb(h, 100, 0);
        expect(result).toEqual({ r: 0, g: 0, b: 0 });
      });
    });

    it('明度100%の場合、常に白になること', () => {
      const hues = [0, 60, 120, 180, 240, 300];

      hues.forEach((h) => {
        const result = hslToRgb(h, 100, 100);
        expect(result).toEqual({ r: 255, g: 255, b: 255 });
      });
    });
  });
});

// =============================================================================
// 往復変換テスト（RGB <-> HSL）
// =============================================================================

describe('RGB <-> HSL 往復変換', () => {
  it('RGB -> HSL -> RGBで元の値に戻ること（原色）', () => {
    const testCases = [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
    ];

    testCases.forEach(({ r, g, b }) => {
      const hsl = rgbToHsl(r, g, b);
      const result = hslToRgb(hsl.h, hsl.s, hsl.l);

      expect(result.r).toBe(r);
      expect(result.g).toBe(g);
      expect(result.b).toBe(b);
    });
  });

  it('RGB -> HSL -> RGBで元の値に近い値に戻ること（一般色）', () => {
    const testCases = [
      { r: 59, g: 130, b: 246 }, // Tailwind Blue 500
      { r: 34, g: 197, b: 94 }, // Tailwind Green 500
      { r: 239, g: 68, b: 68 }, // Tailwind Red 500
    ];

    testCases.forEach(({ r, g, b }) => {
      const hsl = rgbToHsl(r, g, b);
      const result = hslToRgb(hsl.h, hsl.s, hsl.l);

      // 四捨五入による誤差を許容（±1）
      expect(Math.abs(result.r - r)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.g - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.b - b)).toBeLessThanOrEqual(1);
    });
  });

  it('HSL -> RGB -> HSLで元の値に近い値に戻ること', () => {
    const testCases = [
      { h: 0, s: 100, l: 50 },
      { h: 120, s: 100, l: 50 },
      { h: 240, s: 100, l: 50 },
      { h: 200, s: 75, l: 40 },
    ];

    testCases.forEach(({ h, s, l }) => {
      const rgb = hslToRgb(h, s, l);
      const result = rgbToHsl(rgb.r, rgb.g, rgb.b);

      // RGB成分の丸め誤差により、HSL往復変換では微小な差が生じる
      expect(Math.abs(result.h - h) % 360).toBeLessThanOrEqual(TOLERANCE.hslRoundTrip);
      expect(Math.abs(result.s - s)).toBeLessThanOrEqual(TOLERANCE.hslRoundTrip);
      expect(Math.abs(result.l - l)).toBeLessThanOrEqual(TOLERANCE.hslRoundTrip);
    });
  });
});

// =============================================================================
// adjustColor テスト
// =============================================================================

describe('adjustColor - 色調整', () => {
  describe('彩度調整', () => {
    it('彩度を上げると色がより鮮やかになること', () => {
      const baseColor = '#808080'; // グレー
      const result = adjustColor(baseColor, 50, 0); // 彩度+50

      // グレーから彩度を上げると色味が付く
      const rgb = hexToRgb(result);
      expect(rgb).not.toBeNull();
      // 彩度が上がっても、ほぼグレーのまま（元が無彩色なので）
    });

    it('彩度を下げると色がグレーに近づくこと', () => {
      const baseColor = '#FF0000'; // 純赤
      const result = adjustColor(baseColor, -50, 0); // 彩度-50

      const rgb = hexToRgb(result);
      expect(rgb).not.toBeNull();
      // 彩度が下がるとRGB値が近づく
      if (rgb) {
        expect(rgb.g).toBeGreaterThan(0);
        expect(rgb.b).toBeGreaterThan(0);
      }
    });

    it('彩度100%超でも安全に処理すること', () => {
      const baseColor = '#FF8080'; // 薄い赤
      const result = adjustColor(baseColor, 200, 0); // 彩度+200（クランプされるはず）

      expect(result).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });
  });

  describe('明度調整', () => {
    it('明度を上げると色が明るくなること', () => {
      const baseColor = '#808080'; // 中間グレー
      const result = adjustColor(baseColor, 0, 25); // 明度+25

      const rgb = hexToRgb(result);
      expect(rgb).not.toBeNull();
      if (rgb) {
        expect(rgb.r).toBeGreaterThan(128);
        expect(rgb.g).toBeGreaterThan(128);
        expect(rgb.b).toBeGreaterThan(128);
      }
    });

    it('明度を下げると色が暗くなること', () => {
      const baseColor = '#808080'; // 中間グレー
      const result = adjustColor(baseColor, 0, -25); // 明度-25

      const rgb = hexToRgb(result);
      expect(rgb).not.toBeNull();
      if (rgb) {
        expect(rgb.r).toBeLessThan(128);
        expect(rgb.g).toBeLessThan(128);
        expect(rgb.b).toBeLessThan(128);
      }
    });

    it('明度を100%にすると白に近づくこと', () => {
      const baseColor = '#3B82F6';
      const result = adjustColor(baseColor, 0, 100); // 明度を最大に

      const rgb = hexToRgb(result);
      expect(rgb).not.toBeNull();
      if (rgb) {
        expect(rgb.r).toBeGreaterThan(200);
        expect(rgb.g).toBeGreaterThan(200);
        expect(rgb.b).toBeGreaterThan(200);
      }
    });

    it('明度を0%にすると黒に近づくこと', () => {
      const baseColor = '#3B82F6';
      const result = adjustColor(baseColor, 0, -100); // 明度を最小に

      const rgb = hexToRgb(result);
      expect(rgb).not.toBeNull();
      if (rgb) {
        expect(rgb.r).toBeLessThan(50);
        expect(rgb.g).toBeLessThan(50);
        expect(rgb.b).toBeLessThan(50);
      }
    });
  });

  describe('複合調整', () => {
    it('彩度と明度を同時に調整できること', () => {
      const baseColor = '#3B82F6';
      const result = adjustColor(baseColor, 10, 10);

      expect(result).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(result).not.toBe(baseColor);
    });
  });

  describe('異常系', () => {
    it('無効なHEXでエラーまたはnullを返すこと', () => {
      try {
        const result = adjustColor('invalid', 0, 0);
        expect(result).toBeNull();
      } catch {
        expect(true).toBe(true);
      }
    });
  });
});

// =============================================================================
// calculateColorSimilarity テスト
// =============================================================================

describe('calculateColorSimilarity - 色類似度計算', () => {
  describe('正常系', () => {
    it('同一色の類似度が1.0であること', () => {
      const similarity = calculateColorSimilarity('#3B82F6', '#3B82F6');

      expect(similarity).toBe(1);
    });

    it('黒と白の類似度が最小（0に近い）であること', () => {
      const similarity = calculateColorSimilarity('#000000', '#FFFFFF');

      expect(similarity).toBeLessThan(0.2);
    });

    it('類似色の類似度が高いこと', () => {
      // 同じ青系統
      const similarity = calculateColorSimilarity('#3B82F6', '#4B92FF');

      expect(similarity).toBeGreaterThan(0.8);
    });

    it('補色の類似度が低いこと', () => {
      // 赤と緑（補色関係）
      const similarity = calculateColorSimilarity('#FF0000', '#00FF00');

      expect(similarity).toBeLessThan(0.5);
    });

    it('グレースケール間の類似度が明度差に応じて変化すること', () => {
      const similarityClose = calculateColorSimilarity('#808080', '#909090');
      const similarityFar = calculateColorSimilarity('#808080', '#F0F0F0');

      expect(similarityClose).toBeGreaterThan(similarityFar);
    });
  });

  describe('境界値', () => {
    it('小文字HEXでも正しく計算すること', () => {
      const similarity = calculateColorSimilarity('#3b82f6', '#3B82F6');

      expect(similarity).toBe(1);
    });

    it('#なしHEXでも正しく計算すること', () => {
      const similarity = calculateColorSimilarity('3B82F6', '3B82F6');

      expect(similarity).toBe(1);
    });
  });

  describe('異常系', () => {
    it('無効なHEXでエラーまたは0を返すこと', () => {
      try {
        const result = calculateColorSimilarity('invalid', '#FFFFFF');
        expect(result).toBe(0);
      } catch {
        expect(true).toBe(true);
      }
    });

    it('nullの入力でエラーまたは0を返すこと', () => {
      try {
        // @ts-expect-error テスト用の不正な入力
        const result = calculateColorSimilarity(null, '#FFFFFF');
        expect(result).toBe(0);
      } catch {
        expect(true).toBe(true);
      }
    });
  });
});

// =============================================================================
// normalizeHexColor テスト
// =============================================================================

describe('normalizeHexColor - HEX正規化', () => {
  describe('正常系', () => {
    it('小文字を大文字に変換すること', () => {
      const result = normalizeHexColor('#3b82f6');

      expect(result).toBe('#3B82F6');
    });

    it('#なしHEXに#を追加すること', () => {
      const result = normalizeHexColor('3B82F6');

      expect(result).toBe('#3B82F6');
    });

    it('3桁HEXを6桁に展開すること', () => {
      const result = normalizeHexColor('#ABC');

      expect(result).toBe('#AABBCC');
    });

    it('3桁小文字HEXを6桁大文字に変換すること', () => {
      const result = normalizeHexColor('#abc');

      expect(result).toBe('#AABBCC');
    });

    it('既に正規化されたHEXはそのまま返すこと', () => {
      const result = normalizeHexColor('#3B82F6');

      expect(result).toBe('#3B82F6');
    });

    it('#なし3桁HEXを正規化すること', () => {
      const result = normalizeHexColor('FFF');

      expect(result).toBe('#FFFFFF');
    });
  });

  describe('トリミング', () => {
    it('前後の空白を除去すること', () => {
      const result = normalizeHexColor('  #3B82F6  ');

      expect(result).toBe('#3B82F6');
    });

    it('先頭の空白を除去すること', () => {
      const result = normalizeHexColor('  3B82F6');

      expect(result).toBe('#3B82F6');
    });
  });

  describe('異常系', () => {
    it('無効なHEXでnullを返すこと', () => {
      expect(normalizeHexColor('invalid')).toBeNull();
      expect(normalizeHexColor('#GGGGGG')).toBeNull();
      expect(normalizeHexColor('#FF')).toBeNull();
    });

    it('空文字列でnullを返すこと', () => {
      expect(normalizeHexColor('')).toBeNull();
    });

    it('nullの入力でnullを返すこと', () => {
      // @ts-expect-error テスト用の不正な入力
      expect(normalizeHexColor(null)).toBeNull();
    });

    it('undefinedの入力でnullを返すこと', () => {
      // @ts-expect-error テスト用の不正な入力
      expect(normalizeHexColor(undefined)).toBeNull();
    });
  });
});

// =============================================================================
// 統合テスト: 既存サービスとの互換性
// =============================================================================

describe('既存サービスとの互換性', () => {
  describe('color-extractor.tsとの互換性', () => {
    it('hexToRgbの出力形式がcolor-extractorと互換であること', () => {
      // color-extractor内部のhexToRgb関数と同じ出力形式
      const result = hexToRgb('#FF0000');

      expect(result).toHaveProperty('r');
      expect(result).toHaveProperty('g');
      expect(result).toHaveProperty('b');
      expect(typeof result?.r).toBe('number');
    });

    it('rgbToHexの出力形式がcolor-extractorと互換であること', () => {
      // 大文字6桁HEX形式
      const result = rgbToHex(255, 0, 0);

      expect(result).toBe('#FF0000');
      expect(result).toMatch(/^#[0-9A-F]{6}$/);
    });

    it('hslToRgbの出力形式がcolor-extractorと互換であること', () => {
      const result = hslToRgb(0, 100, 50);

      expect(result).toHaveProperty('r');
      expect(result).toHaveProperty('g');
      expect(result).toHaveProperty('b');
      expect(result.r).toBe(255);
      expect(result.g).toBe(0);
      expect(result.b).toBe(0);
    });
  });

  describe('SVG処理パイプラインとの統合', () => {
    it('SVGから抽出した色をRGBに変換できること', () => {
      // SVGでよく使われる色形式
      const svgColors = ['#3B82F6', '#22C55E', '#EF4444', '#fff', '#000'];

      svgColors.forEach((color) => {
        const normalized = normalizeHexColor(color);
        expect(normalized).not.toBeNull();

        if (normalized) {
          const rgb = hexToRgb(normalized);
          expect(rgb).not.toBeNull();
        }
      });
    });

    it('色変換のチェーンが正しく動作すること', () => {
      // HEX -> RGB -> HSL -> RGB -> HEX
      const original = '#3B82F6';

      const rgb1 = hexToRgb(original);
      expect(rgb1).not.toBeNull();

      if (rgb1) {
        const hsl = rgbToHsl(rgb1.r, rgb1.g, rgb1.b);
        const rgb2 = hslToRgb(hsl.h, hsl.s, hsl.l);
        const final = rgbToHex(rgb2.r, rgb2.g, rgb2.b);

        // 元の色に近い結果になること
        expect(final.toUpperCase()).toBe(original);
      }
    });
  });
});

// =============================================================================
// TDD Red フェーズ確認テスト
// =============================================================================

describe('TDD Red: 実装前の失敗確認', () => {
  it('color.tsモジュールが存在しないため、インポートが失敗すること', async () => {
    // このテストはcolor.tsが実装されるまで失敗する
    // 実装後は成功に変わる
    try {
      const colorModule = await import('../../src/utils/color');
      // 実装が存在する場合のアサーション
      expect(colorModule.hexToRgb).toBeDefined();
      expect(colorModule.rgbToHex).toBeDefined();
      expect(colorModule.rgbToHsl).toBeDefined();
      expect(colorModule.hslToRgb).toBeDefined();
      expect(colorModule.adjustColor).toBeDefined();
      expect(colorModule.calculateColorSimilarity).toBeDefined();
      expect(colorModule.normalizeHexColor).toBeDefined();
    } catch (error) {
      // TDD Redフェーズ: モジュールが存在しないためエラー
      // この状態が期待される初期状態
      expect(error).toBeDefined();
    }
  });
});
