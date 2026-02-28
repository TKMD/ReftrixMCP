// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Color Change Analyzer Tests
 *
 * TDD Red Phase: 失敗するテストを先に書く
 *
 * テスト対象:
 * 1. extractDominantColors - ドミナントカラー抽出
 * 2. analyzeColorChange - 色変化解析
 * 3. detectFade - フェード効果検出
 * 4. calculateColorDistance - 色距離計算
 *
 * 仕様: docs/specs/frame-image-analysis-spec.md FR-4
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'path';
import {
  ColorChangeAnalyzer,
  // 型定義
  type DominantColor,
  type ColorChangeResult,
  type ColorChange,
  type FadeEffect,
  type ColorChangeEvent,
  type BoundingBox,
  // ヘルパー関数
  calculateColorDistance,
  rgbToHsl,
  hslToRgb,
  hexToRgb,
  rgbToHex,
} from '../../../../src/services/motion/analyzers/color-change.analyzer';

// ============================================================================
// テストヘルパー
// ============================================================================

/**
 * テスト用のDominantColorを作成
 */
function createMockDominantColor(overrides: Partial<DominantColor> = {}): DominantColor {
  return {
    r: 255,
    g: 0,
    b: 0,
    a: 255,
    hex: '#ff0000',
    percentage: 0.5,
    ...overrides,
  };
}

/**
 * テスト用のBoundingBoxを作成
 */
function createMockBoundingBox(overrides: Partial<BoundingBox> = {}): BoundingBox {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...overrides,
  };
}

// ============================================================================
// 色距離計算テスト
// ============================================================================

describe('ColorChangeAnalyzer - calculateColorDistance', () => {
  describe('基本的な色距離計算', () => {
    it('同一色の距離は0である', () => {
      const color = { r: 128, g: 128, b: 128 };
      const distance = calculateColorDistance(color, color);
      expect(distance).toBe(0);
    });

    it('黒と白の距離は1である', () => {
      const black = { r: 0, g: 0, b: 0 };
      const white = { r: 255, g: 255, b: 255 };
      const distance = calculateColorDistance(black, white);
      expect(distance).toBe(1);
    });

    it('純粋な赤と純粋な青の距離を計算できる', () => {
      const red = { r: 255, g: 0, b: 0 };
      const blue = { r: 0, g: 0, b: 255 };
      const distance = calculateColorDistance(red, blue);
      // ユークリッド距離: sqrt((255-0)^2 + (0-0)^2 + (0-255)^2) / sqrt(255^2 * 3)
      expect(distance).toBeGreaterThan(0);
      expect(distance).toBeLessThanOrEqual(1);
    });

    it('距離は対称的である', () => {
      const color1 = { r: 100, g: 150, b: 200 };
      const color2 = { r: 50, g: 100, b: 150 };
      const distance1 = calculateColorDistance(color1, color2);
      const distance2 = calculateColorDistance(color2, color1);
      expect(distance1).toBeCloseTo(distance2, 10);
    });

    it('距離は0から1の範囲内である', () => {
      const testColors = [
        { r: 0, g: 0, b: 0 },
        { r: 255, g: 255, b: 255 },
        { r: 128, g: 64, b: 192 },
        { r: 50, g: 100, b: 150 },
      ];

      for (const c1 of testColors) {
        for (const c2 of testColors) {
          const distance = calculateColorDistance(c1, c2);
          expect(distance).toBeGreaterThanOrEqual(0);
          expect(distance).toBeLessThanOrEqual(1);
        }
      }
    });
  });
});

// ============================================================================
// 色変換ユーティリティテスト
// ============================================================================

describe('ColorChangeAnalyzer - 色変換ユーティリティ', () => {
  describe('rgbToHsl', () => {
    it('赤をHSLに変換できる', () => {
      const hsl = rgbToHsl(255, 0, 0);
      expect(hsl.h).toBeCloseTo(0, 1);
      expect(hsl.s).toBeCloseTo(100, 1);
      expect(hsl.l).toBeCloseTo(50, 1);
    });

    it('緑をHSLに変換できる', () => {
      const hsl = rgbToHsl(0, 255, 0);
      expect(hsl.h).toBeCloseTo(120, 1);
      expect(hsl.s).toBeCloseTo(100, 1);
      expect(hsl.l).toBeCloseTo(50, 1);
    });

    it('青をHSLに変換できる', () => {
      const hsl = rgbToHsl(0, 0, 255);
      expect(hsl.h).toBeCloseTo(240, 1);
      expect(hsl.s).toBeCloseTo(100, 1);
      expect(hsl.l).toBeCloseTo(50, 1);
    });

    it('白をHSLに変換できる', () => {
      const hsl = rgbToHsl(255, 255, 255);
      expect(hsl.s).toBeCloseTo(0, 1);
      expect(hsl.l).toBeCloseTo(100, 1);
    });

    it('黒をHSLに変換できる', () => {
      const hsl = rgbToHsl(0, 0, 0);
      expect(hsl.s).toBeCloseTo(0, 1);
      expect(hsl.l).toBeCloseTo(0, 1);
    });

    it('グレーをHSLに変換できる', () => {
      const hsl = rgbToHsl(128, 128, 128);
      expect(hsl.s).toBeCloseTo(0, 1);
      // 128/255 = 0.5019... → L = 50.19...
      expect(hsl.l).toBeCloseTo(50.2, 0);
    });
  });

  describe('hslToRgb', () => {
    it('赤のHSLをRGBに変換できる', () => {
      const rgb = hslToRgb(0, 100, 50);
      expect(rgb.r).toBeCloseTo(255, 0);
      expect(rgb.g).toBeCloseTo(0, 0);
      expect(rgb.b).toBeCloseTo(0, 0);
    });

    it('緑のHSLをRGBに変換できる', () => {
      const rgb = hslToRgb(120, 100, 50);
      expect(rgb.r).toBeCloseTo(0, 0);
      expect(rgb.g).toBeCloseTo(255, 0);
      expect(rgb.b).toBeCloseTo(0, 0);
    });

    it('青のHSLをRGBに変換できる', () => {
      const rgb = hslToRgb(240, 100, 50);
      expect(rgb.r).toBeCloseTo(0, 0);
      expect(rgb.g).toBeCloseTo(0, 0);
      expect(rgb.b).toBeCloseTo(255, 0);
    });

    it('RGBからHSLへ変換し、再びRGBへ変換すると元の値に戻る', () => {
      const original = { r: 100, g: 150, b: 200 };
      const hsl = rgbToHsl(original.r, original.g, original.b);
      const rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
      expect(rgb.r).toBeCloseTo(original.r, 0);
      expect(rgb.g).toBeCloseTo(original.g, 0);
      expect(rgb.b).toBeCloseTo(original.b, 0);
    });
  });

  describe('hexToRgb', () => {
    it('#rrggbb形式を変換できる', () => {
      const rgb = hexToRgb('#ff0000');
      expect(rgb).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('#rrggbbaa形式を変換できる', () => {
      const rgb = hexToRgb('#ff0000ff');
      expect(rgb).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    });

    it('#rgb形式を変換できる', () => {
      const rgb = hexToRgb('#f00');
      expect(rgb).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('#なしの形式を変換できる', () => {
      const rgb = hexToRgb('00ff00');
      expect(rgb).toEqual({ r: 0, g: 255, b: 0 });
    });
  });

  describe('rgbToHex', () => {
    it('RGBをHEXに変換できる', () => {
      const hex = rgbToHex(255, 0, 0);
      expect(hex).toBe('#ff0000');
    });

    it('小数を含むRGBを変換できる', () => {
      const hex = rgbToHex(128.5, 64.3, 192.9);
      // Math.round(128.5) = 129, Math.round(64.3) = 64, Math.round(192.9) = 193
      expect(hex).toBe('#8140c1');
    });

    it('アルファ値を含むRGBを変換できる', () => {
      const hex = rgbToHex(255, 0, 0, 128);
      expect(hex).toBe('#ff000080');
    });
  });
});

// ============================================================================
// ドミナントカラー抽出テスト
// ============================================================================

describe('ColorChangeAnalyzer - extractDominantColors', () => {
  let analyzer: ColorChangeAnalyzer;

  beforeEach(() => {
    analyzer = new ColorChangeAnalyzer();
  });

  describe('基本機能', () => {
    it('Bufferからドミナントカラーを抽出できる', async () => {
      // 赤一色の10x10画像を作成（Sharp形式: raw RGBA buffer）
      const width = 10;
      const height = 10;
      const buffer = Buffer.alloc(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        buffer[i * 4] = 255;     // R
        buffer[i * 4 + 1] = 0;   // G
        buffer[i * 4 + 2] = 0;   // B
        buffer[i * 4 + 3] = 255; // A
      }

      const result = await analyzer.extractDominantColors(buffer, width, height);

      expect(result.colors).toBeDefined();
      expect(result.colors.length).toBeGreaterThan(0);
      // 赤が主要色であること
      const dominantColor = result.colors[0];
      expect(dominantColor.r).toBeCloseTo(255, 10);
      expect(dominantColor.g).toBeCloseTo(0, 10);
      expect(dominantColor.b).toBeCloseTo(0, 10);
    });

    it('抽出する色数を指定できる', async () => {
      const width = 10;
      const height = 10;
      const buffer = Buffer.alloc(width * height * 4);
      // 上半分は赤、下半分は青
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (y < height / 2) {
            buffer[i] = 255; buffer[i + 1] = 0; buffer[i + 2] = 0;
          } else {
            buffer[i] = 0; buffer[i + 1] = 0; buffer[i + 2] = 255;
          }
          buffer[i + 3] = 255;
        }
      }

      const result = await analyzer.extractDominantColors(buffer, width, height, { k: 2 });

      expect(result.colors.length).toBe(2);
    });

    it('各色の占有率を返す', async () => {
      const width = 10;
      const height = 10;
      const buffer = Buffer.alloc(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        buffer[i * 4] = 0; buffer[i * 4 + 1] = 255; buffer[i * 4 + 2] = 0; buffer[i * 4 + 3] = 255;
      }

      const result = await analyzer.extractDominantColors(buffer, width, height);

      expect(result.colors[0].percentage).toBeGreaterThan(0);
      expect(result.colors[0].percentage).toBeLessThanOrEqual(1);
    });

    it('HEX形式の色を返す', async () => {
      const width = 10;
      const height = 10;
      const buffer = Buffer.alloc(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        buffer[i * 4] = 0; buffer[i * 4 + 1] = 0; buffer[i * 4 + 2] = 255; buffer[i * 4 + 3] = 255;
      }

      const result = await analyzer.extractDominantColors(buffer, width, height);

      expect(result.colors[0].hex).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  describe('エラーハンドリング', () => {
    it('空のBufferでエラーをスローする', async () => {
      const emptyBuffer = Buffer.alloc(0);
      await expect(analyzer.extractDominantColors(emptyBuffer, 0, 0)).rejects.toThrow();
    });

    it('不正なサイズでエラーをスローする', async () => {
      const buffer = Buffer.alloc(100);
      await expect(analyzer.extractDominantColors(buffer, -1, 10)).rejects.toThrow();
    });
  });
});

// ============================================================================
// 色変化解析テスト
// ============================================================================

describe('ColorChangeAnalyzer - analyzeColorChange', () => {
  let analyzer: ColorChangeAnalyzer;

  beforeEach(() => {
    analyzer = new ColorChangeAnalyzer();
  });

  describe('基本機能', () => {
    it('2つの色配列間の変化を解析できる', () => {
      const colors1 = [createMockDominantColor({ r: 255, g: 0, b: 0, hex: '#ff0000', percentage: 0.8 })];
      const colors2 = [createMockDominantColor({ r: 0, g: 0, b: 255, hex: '#0000ff', percentage: 0.8 })];

      const result = analyzer.analyzeColorChange(colors1, colors2);

      expect(result.colorShift).toBeGreaterThan(0);
      expect(result.colorShift).toBeLessThanOrEqual(1);
    });

    it('同一色間の変化量は0に近い', () => {
      const colors = [createMockDominantColor({ r: 128, g: 128, b: 128 })];

      const result = analyzer.analyzeColorChange(colors, colors);

      expect(result.colorShift).toBeCloseTo(0, 5);
    });

    it('色相の変化量を度数で返す', () => {
      const colors1 = [createMockDominantColor({ r: 255, g: 0, b: 0 })]; // 赤: H=0
      const colors2 = [createMockDominantColor({ r: 0, g: 255, b: 0 })]; // 緑: H=120

      const result = analyzer.analyzeColorChange(colors1, colors2);

      expect(result.hueChange).toBeCloseTo(120, 5);
    });

    it('彩度の変化量を返す', () => {
      const colors1 = [createMockDominantColor({ r: 255, g: 0, b: 0 })];    // 高彩度
      const colors2 = [createMockDominantColor({ r: 128, g: 128, b: 128 })]; // 無彩色

      const result = analyzer.analyzeColorChange(colors1, colors2);

      expect(result.saturationChange).not.toBe(0);
    });

    it('明度の変化量を返す', () => {
      const colors1 = [createMockDominantColor({ r: 255, g: 255, b: 255 })]; // 白
      const colors2 = [createMockDominantColor({ r: 0, g: 0, b: 0 })];       // 黒

      const result = analyzer.analyzeColorChange(colors1, colors2);

      expect(result.lightnessChange).toBeCloseTo(-100, 5);
    });
  });

  describe('重み付き解析', () => {
    it('占有率の高い色ほど変化量に大きく寄与する', () => {
      const colors1 = [
        createMockDominantColor({ r: 255, g: 0, b: 0, percentage: 0.9 }),
        createMockDominantColor({ r: 0, g: 255, b: 0, percentage: 0.1 }),
      ];
      const colors2 = [
        createMockDominantColor({ r: 255, g: 0, b: 0, percentage: 0.9 }),
        createMockDominantColor({ r: 0, g: 0, b: 255, percentage: 0.1 }),
      ];

      const result = analyzer.analyzeColorChange(colors1, colors2);

      // 90%を占める赤が変化していないので、全体の変化は小さい
      expect(result.colorShift).toBeLessThan(0.5);
    });
  });
});

// ============================================================================
// フェード効果検出テスト
// ============================================================================

describe('ColorChangeAnalyzer - detectFade', () => {
  let analyzer: ColorChangeAnalyzer;

  beforeEach(() => {
    analyzer = new ColorChangeAnalyzer();
  });

  describe('フェードイン検出', () => {
    it('黒から明るい色へのフェードインを検出できる', async () => {
      // 5フレームで黒から白へ遷移
      const frames = Array.from({ length: 5 }, (_, i) => {
        const brightness = Math.round((i / 4) * 255);
        return {
          dominantColors: [
            createMockDominantColor({ r: brightness, g: brightness, b: brightness, percentage: 1.0 }),
          ],
        };
      });

      const result = await analyzer.detectFade(frames);

      expect(result.fadeEffects.length).toBeGreaterThan(0);
      const fadeIn = result.fadeEffects.find((f) => f.change_type === 'fade_in');
      expect(fadeIn).toBeDefined();
      expect(fadeIn?.start_frame).toBe(0);
      expect(fadeIn?.end_frame).toBe(4);
    });
  });

  describe('フェードアウト検出', () => {
    it('明るい色から黒へのフェードアウトを検出できる', async () => {
      // 5フレームで白から黒へ遷移
      const frames = Array.from({ length: 5 }, (_, i) => {
        const brightness = Math.round((1 - i / 4) * 255);
        return {
          dominantColors: [
            createMockDominantColor({ r: brightness, g: brightness, b: brightness, percentage: 1.0 }),
          ],
        };
      });

      const result = await analyzer.detectFade(frames);

      expect(result.fadeEffects.length).toBeGreaterThan(0);
      const fadeOut = result.fadeEffects.find((f) => f.change_type === 'fade_out');
      expect(fadeOut).toBeDefined();
    });
  });

  describe('色遷移検出', () => {
    it('色相変化による色遷移を検出できる', async () => {
      // 5フレームで赤から青へ遷移
      const frames = Array.from({ length: 5 }, (_, i) => {
        const red = Math.round((1 - i / 4) * 255);
        const blue = Math.round((i / 4) * 255);
        return {
          dominantColors: [
            createMockDominantColor({ r: red, g: 0, b: blue, percentage: 1.0 }),
          ],
        };
      });

      const result = await analyzer.detectFade(frames);

      expect(result.fadeEffects.length).toBeGreaterThan(0);
      const colorTransition = result.fadeEffects.find((f) => f.change_type === 'color_transition');
      expect(colorTransition).toBeDefined();
    });
  });

  describe('明度変化検出', () => {
    it('同一色相での明度変化を検出できる', async () => {
      // 5フレームで暗い赤から明るい赤へ遷移
      const frames = Array.from({ length: 5 }, (_, i) => {
        const value = 50 + Math.round((i / 4) * 205); // 50-255
        return {
          dominantColors: [
            createMockDominantColor({ r: value, g: 0, b: 0, percentage: 1.0 }),
          ],
        };
      });

      const result = await analyzer.detectFade(frames);

      expect(result.fadeEffects.length).toBeGreaterThan(0);
      // 明度増加はfade_inまたはbrightness_changeとして検出される
      const effect = result.fadeEffects.find(
        (f) => f.change_type === 'brightness_change' || f.change_type === 'fade_in'
      );
      expect(effect).toBeDefined();
    });
  });

  describe('出力形式', () => {
    it('開始・終了フレームインデックスを含む', async () => {
      const frames = Array.from({ length: 5 }, (_, i) => {
        const brightness = Math.round((i / 4) * 255);
        return {
          dominantColors: [createMockDominantColor({ r: brightness, g: brightness, b: brightness })],
        };
      });

      const result = await analyzer.detectFade(frames);

      expect(result.fadeEffects[0].start_frame).toBeDefined();
      expect(result.fadeEffects[0].end_frame).toBeDefined();
      expect(result.fadeEffects[0].end_frame).toBeGreaterThan(result.fadeEffects[0].start_frame);
    });

    it('変化前後の主要色をHEXで返す', async () => {
      const frames = [
        { dominantColors: [createMockDominantColor({ r: 0, g: 0, b: 0, hex: '#000000' })] },
        { dominantColors: [createMockDominantColor({ r: 255, g: 255, b: 255, hex: '#ffffff' })] },
      ];

      const result = await analyzer.detectFade(frames);

      if (result.fadeEffects.length > 0) {
        expect(result.fadeEffects[0].from_color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(result.fadeEffects[0].to_color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });

    it('推定duration(ms)を返す', async () => {
      const frames = Array.from({ length: 5 }, (_, i) => {
        const brightness = Math.round((i / 4) * 255);
        return {
          dominantColors: [createMockDominantColor({ r: brightness, g: brightness, b: brightness })],
        };
      });

      const result = await analyzer.detectFade(frames, { fps: 30 });

      if (result.fadeEffects.length > 0) {
        expect(result.fadeEffects[0].estimated_duration_ms).toBeDefined();
        expect(result.fadeEffects[0].estimated_duration_ms).toBeGreaterThan(0);
      }
    });
  });

  describe('設定オプション', () => {
    it('閾値を設定できる', async () => {
      const frames = Array.from({ length: 5 }, (_, i) => {
        const brightness = 128 + Math.round((i / 4) * 10); // 微小な変化
        return {
          dominantColors: [createMockDominantColor({ r: brightness, g: brightness, b: brightness })],
        };
      });

      // 高い閾値では検出されない
      const result1 = await analyzer.detectFade(frames, { threshold: 0.5 });
      expect(result1.fadeEffects.length).toBe(0);

      // 低い閾値では検出される
      const result2 = await analyzer.detectFade(frames, { threshold: 0.01 });
      expect(result2.fadeEffects.length).toBeGreaterThan(0);
    });

    it('fpsを設定できる', async () => {
      const frames = Array.from({ length: 5 }, (_, i) => {
        const brightness = Math.round((i / 4) * 255);
        return {
          dominantColors: [createMockDominantColor({ r: brightness, g: brightness, b: brightness })],
        };
      });

      const result30fps = await analyzer.detectFade(frames, { fps: 30 });
      const result60fps = await analyzer.detectFade(frames, { fps: 60 });

      // 60fpsの方がdurationが短い（同じフレーム数で半分の時間）
      if (result30fps.fadeEffects.length > 0 && result60fps.fadeEffects.length > 0) {
        expect(result60fps.fadeEffects[0].estimated_duration_ms).toBeLessThan(
          result30fps.fadeEffects[0].estimated_duration_ms
        );
      }
    });
  });
});

// ============================================================================
// 統合分析テスト
// ============================================================================

describe('ColorChangeAnalyzer - analyze (統合)', () => {
  let analyzer: ColorChangeAnalyzer;

  beforeEach(() => {
    analyzer = new ColorChangeAnalyzer();
  });

  describe('フレームシーケンス全体の解析', () => {
    it('複数フレームのドミナントカラーと変化を返す', async () => {
      // 3フレームで黒→グレー→白
      const frameBuffers = Array.from({ length: 3 }, (_, i) => {
        const width = 10;
        const height = 10;
        const buffer = Buffer.alloc(width * height * 4);
        const brightness = Math.round((i / 2) * 255);
        for (let j = 0; j < width * height; j++) {
          buffer[j * 4] = brightness;
          buffer[j * 4 + 1] = brightness;
          buffer[j * 4 + 2] = brightness;
          buffer[j * 4 + 3] = 255;
        }
        return { buffer, width, height };
      });

      const result = await analyzer.analyze(frameBuffers);

      expect(result.dominantColors.length).toBe(3);
      expect(result.changes.length).toBe(2); // frame0→1, frame1→2
      expect(result.averageColorShift).toBeGreaterThan(0);
    });

    it('フェード効果を検出して返す', async () => {
      // 5フレームでフェードイン
      const frameBuffers = Array.from({ length: 5 }, (_, i) => {
        const width = 10;
        const height = 10;
        const buffer = Buffer.alloc(width * height * 4);
        const brightness = Math.round((i / 4) * 255);
        for (let j = 0; j < width * height; j++) {
          buffer[j * 4] = brightness;
          buffer[j * 4 + 1] = brightness;
          buffer[j * 4 + 2] = brightness;
          buffer[j * 4 + 3] = 255;
        }
        return { buffer, width, height };
      });

      const result = await analyzer.analyze(frameBuffers, { fps: 30 });

      expect(result.fadeEffects.length).toBeGreaterThan(0);
    });

    it('平均色変化量を計算する', async () => {
      const frameBuffers = Array.from({ length: 3 }, (_, i) => {
        const width = 10;
        const height = 10;
        const buffer = Buffer.alloc(width * height * 4);
        const brightness = Math.round((i / 2) * 255);
        for (let j = 0; j < width * height; j++) {
          buffer[j * 4] = brightness;
          buffer[j * 4 + 1] = brightness;
          buffer[j * 4 + 2] = brightness;
          buffer[j * 4 + 3] = 255;
        }
        return { buffer, width, height };
      });

      const result = await analyzer.analyze(frameBuffers);

      expect(result.averageColorShift).toBeGreaterThanOrEqual(0);
      expect(result.averageColorShift).toBeLessThanOrEqual(1);
    });
  });

  describe('出力形式の検証', () => {
    it('ColorChangeResult形式を返す', async () => {
      const frameBuffers = [
        { buffer: createTestBuffer(10, 10, { r: 0, g: 0, b: 0 }), width: 10, height: 10 },
        { buffer: createTestBuffer(10, 10, { r: 255, g: 255, b: 255 }), width: 10, height: 10 },
      ];

      const result = await analyzer.analyze(frameBuffers);

      // dominantColors
      expect(Array.isArray(result.dominantColors)).toBe(true);
      expect(result.dominantColors[0].frameIndex).toBeDefined();
      expect(result.dominantColors[0].colors).toBeDefined();

      // changes
      expect(Array.isArray(result.changes)).toBe(true);
      if (result.changes.length > 0) {
        expect(result.changes[0].fromFrame).toBeDefined();
        expect(result.changes[0].toFrame).toBeDefined();
        expect(result.changes[0].colorShift).toBeDefined();
        expect(result.changes[0].hueChange).toBeDefined();
        expect(result.changes[0].saturationChange).toBeDefined();
        expect(result.changes[0].lightnessChange).toBeDefined();
      }

      // fadeEffects
      expect(Array.isArray(result.fadeEffects)).toBe(true);

      // averageColorShift
      expect(typeof result.averageColorShift).toBe('number');
    });
  });

  describe('パフォーマンス要件', () => {
    it('10フレームを3秒以内に処理できる', async () => {
      const frameBuffers = Array.from({ length: 10 }, () => {
        return {
          buffer: createTestBuffer(100, 100, { r: Math.random() * 255, g: Math.random() * 255, b: Math.random() * 255 }),
          width: 100,
          height: 100,
        };
      });

      const startTime = Date.now();
      await analyzer.analyze(frameBuffers);
      const elapsedTime = Date.now() - startTime;

      expect(elapsedTime).toBeLessThan(3000);
    });
  });

  describe('エラーハンドリング', () => {
    it('空のフレーム配列でエラーをスローする', async () => {
      await expect(analyzer.analyze([])).rejects.toThrow();
    });

    it('1フレームのみの場合はchangesが空', async () => {
      const frameBuffers = [
        { buffer: createTestBuffer(10, 10, { r: 128, g: 128, b: 128 }), width: 10, height: 10 },
      ];

      const result = await analyzer.analyze(frameBuffers);

      expect(result.changes.length).toBe(0);
      expect(result.fadeEffects.length).toBe(0);
      expect(result.averageColorShift).toBe(0);
    });
  });
});

// ============================================================================
// テストユーティリティ
// ============================================================================

/**
 * テスト用のRGBAバッファを作成
 */
function createTestBuffer(
  width: number,
  height: number,
  color: { r: number; g: number; b: number; a?: number }
): Buffer {
  const buffer = Buffer.alloc(width * height * 4);
  const a = color.a ?? 255;
  for (let i = 0; i < width * height; i++) {
    buffer[i * 4] = Math.round(color.r);
    buffer[i * 4 + 1] = Math.round(color.g);
    buffer[i * 4 + 2] = Math.round(color.b);
    buffer[i * 4 + 3] = a;
  }
  return buffer;
}
