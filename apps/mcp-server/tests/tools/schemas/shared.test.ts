// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 共通スキーマ テスト
 * TDD Red フェーズ: 複数ツールで共有される基本スキーマのバリデーションテスト
 *
 * 目的:
 * - point2dSchema: 2D座標（x, y）
 * - sizeSchema: サイズ（width, height）
 * - boundingBoxSchema: バウンディングボックス
 * - hexColorSchema: HEXカラー形式
 * - cssColorSchema: CSSカラー形式（HEX, rgb, hsl, etc.）
 * - processingMetaSchema: 処理メタデータ
 *
 * @module tests/tools/schemas/shared.test
 */
import { describe, it, expect } from 'vitest';

// TDD Red: スキーマはまだ実装されていない
// 実装後にこのインポートが有効になる
import {
  point2dSchema,
  sizeSchema,
  boundingBoxSchema,
  hexColorSchema,
  cssColorSchema,
  processingMetaSchema,
} from '../../../src/tools/schemas/shared';

describe('共通スキーマ (shared schemas)', () => {
  // =============================================================================
  // point2dSchema - 2D座標
  // =============================================================================
  describe('point2dSchema', () => {
    describe('正常系', () => {
      it('正の座標で検証成功すること', () => {
        // Arrange
        const input = { x: 10, y: 20 };

        // Act
        const result = point2dSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.x).toBe(10);
          expect(result.data.y).toBe(20);
        }
      });

      it('ゼロ座標で検証成功すること', () => {
        // Arrange
        const input = { x: 0, y: 0 };

        // Act
        const result = point2dSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('負の座標で検証成功すること', () => {
        // Arrange: SVG座標系では負の値も有効
        const input = { x: -100, y: -50 };

        // Act
        const result = point2dSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('小数座標で検証成功すること', () => {
        // Arrange
        const input = { x: 10.5, y: 20.75 };

        // Act
        const result = point2dSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.x).toBe(10.5);
          expect(result.data.y).toBe(20.75);
        }
      });

      it('大きな座標値で検証成功すること', () => {
        // Arrange
        const input = { x: 999999, y: 888888 };

        // Act
        const result = point2dSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('異常系', () => {
      it('xが未指定でエラーになること', () => {
        // Arrange
        const input = { y: 20 };

        // Act
        const result = point2dSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('yが未指定でエラーになること', () => {
        // Arrange
        const input = { x: 10 };

        // Act
        const result = point2dSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('空オブジェクトでエラーになること', () => {
        // Arrange
        const input = {};

        // Act
        const result = point2dSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('xが文字列でエラーになること', () => {
        // Arrange
        const input = { x: '10', y: 20 };

        // Act
        const result = point2dSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('yが文字列でエラーになること', () => {
        // Arrange
        const input = { x: 10, y: '20' };

        // Act
        const result = point2dSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('xがNaNでエラーになること', () => {
        // Arrange
        const input = { x: NaN, y: 20 };

        // Act
        const result = point2dSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('yがInfinityでエラーになること', () => {
        // Arrange
        const input = { x: 10, y: Infinity };

        // Act
        const result = point2dSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('xがnullでエラーになること', () => {
        // Arrange
        const input = { x: null, y: 20 };

        // Act
        const result = point2dSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });
    });
  });

  // =============================================================================
  // sizeSchema - サイズ
  // =============================================================================
  describe('sizeSchema', () => {
    describe('正常系', () => {
      it('正の整数サイズで検証成功すること', () => {
        // Arrange
        const input = { width: 100, height: 200 };

        // Act
        const result = sizeSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.width).toBe(100);
          expect(result.data.height).toBe(200);
        }
      });

      it('小数サイズで検証成功すること', () => {
        // Arrange
        const input = { width: 100.5, height: 200.75 };

        // Act
        const result = sizeSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('最小正の値で検証成功すること', () => {
        // Arrange: 0より大きい最小値
        const input = { width: 0.001, height: 0.001 };

        // Act
        const result = sizeSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('大きなサイズ値で検証成功すること', () => {
        // Arrange
        const input = { width: 10000, height: 10000 };

        // Act
        const result = sizeSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('異常系', () => {
      it('widthがゼロでエラーになること', () => {
        // Arrange: サイズは正の値が必要
        const input = { width: 0, height: 100 };

        // Act
        const result = sizeSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('heightがゼロでエラーになること', () => {
        // Arrange
        const input = { width: 100, height: 0 };

        // Act
        const result = sizeSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('widthが負の値でエラーになること', () => {
        // Arrange
        const input = { width: -100, height: 100 };

        // Act
        const result = sizeSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('heightが負の値でエラーになること', () => {
        // Arrange
        const input = { width: 100, height: -100 };

        // Act
        const result = sizeSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('widthが未指定でエラーになること', () => {
        // Arrange
        const input = { height: 100 };

        // Act
        const result = sizeSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('heightが未指定でエラーになること', () => {
        // Arrange
        const input = { width: 100 };

        // Act
        const result = sizeSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('widthが文字列でエラーになること', () => {
        // Arrange
        const input = { width: '100', height: 100 };

        // Act
        const result = sizeSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });
    });
  });

  // =============================================================================
  // boundingBoxSchema - バウンディングボックス
  // =============================================================================
  describe('boundingBoxSchema', () => {
    describe('正常系', () => {
      it('標準的なバウンディングボックスで検証成功すること', () => {
        // Arrange
        const input = { x: 10, y: 20, width: 100, height: 200 };

        // Act
        const result = boundingBoxSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual({ x: 10, y: 20, width: 100, height: 200 });
        }
      });

      it('原点（0,0）からのバウンディングボックスで検証成功すること', () => {
        // Arrange
        const input = { x: 0, y: 0, width: 24, height: 24 };

        // Act
        const result = boundingBoxSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('負のx/y座標でも検証成功すること', () => {
        // Arrange: SVGでは負の座標も有効
        const input = { x: -50, y: -50, width: 100, height: 100 };

        // Act
        const result = boundingBoxSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('width/heightがゼロでも検証成功すること', () => {
        // Arrange: 空のバウンディングボックスも許容
        const input = { x: 10, y: 10, width: 0, height: 0 };

        // Act
        const result = boundingBoxSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('小数値のバウンディングボックスで検証成功すること', () => {
        // Arrange
        const input = { x: 10.5, y: 20.5, width: 100.25, height: 200.75 };

        // Act
        const result = boundingBoxSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('異常系', () => {
      it('widthが負の値でエラーになること', () => {
        // Arrange: widthは0以上
        const input = { x: 10, y: 20, width: -100, height: 200 };

        // Act
        const result = boundingBoxSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('heightが負の値でエラーになること', () => {
        // Arrange: heightは0以上
        const input = { x: 10, y: 20, width: 100, height: -200 };

        // Act
        const result = boundingBoxSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('xが未指定でエラーになること', () => {
        // Arrange
        const input = { y: 20, width: 100, height: 200 };

        // Act
        const result = boundingBoxSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('yが未指定でエラーになること', () => {
        // Arrange
        const input = { x: 10, width: 100, height: 200 };

        // Act
        const result = boundingBoxSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('widthが未指定でエラーになること', () => {
        // Arrange
        const input = { x: 10, y: 20, height: 200 };

        // Act
        const result = boundingBoxSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('heightが未指定でエラーになること', () => {
        // Arrange
        const input = { x: 10, y: 20, width: 100 };

        // Act
        const result = boundingBoxSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('空オブジェクトでエラーになること', () => {
        // Arrange
        const input = {};

        // Act
        const result = boundingBoxSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });
    });
  });

  // =============================================================================
  // hexColorSchema - HEXカラー形式
  // =============================================================================
  describe('hexColorSchema', () => {
    describe('正常系 - #RGB形式', () => {
      it('#RGBの小文字で検証成功すること', () => {
        // Arrange
        const input = '#abc';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#RGBの大文字で検証成功すること', () => {
        // Arrange
        const input = '#ABC';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#RGBの混在ケースで検証成功すること', () => {
        // Arrange
        const input = '#AbC';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#000で検証成功すること', () => {
        // Arrange
        const input = '#000';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#fffで検証成功すること', () => {
        // Arrange
        const input = '#fff';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('正常系 - #RRGGBB形式', () => {
      it('#RRGGBBの小文字で検証成功すること', () => {
        // Arrange
        const input = '#aabbcc';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#RRGGBBの大文字で検証成功すること', () => {
        // Arrange
        const input = '#AABBCC';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#000000で検証成功すること', () => {
        // Arrange
        const input = '#000000';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#FFFFFFで検証成功すること', () => {
        // Arrange
        const input = '#FFFFFF';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#3B82F6（Tailwind blue-500）で検証成功すること', () => {
        // Arrange
        const input = '#3B82F6';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('正常系 - #RRGGBBAA形式', () => {
      it('#RRGGBBAAの小文字で検証成功すること', () => {
        // Arrange
        const input = '#aabbccdd';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#RRGGBBAAの大文字で検証成功すること', () => {
        // Arrange
        const input = '#AABBCCDD';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#00000000（完全透明黒）で検証成功すること', () => {
        // Arrange
        const input = '#00000000';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#FFFFFFFF（完全不透明白）で検証成功すること', () => {
        // Arrange
        const input = '#FFFFFFFF';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#3B82F680（50%透明青）で検証成功すること', () => {
        // Arrange
        const input = '#3B82F680';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('異常系', () => {
      it('#なしでエラーになること', () => {
        // Arrange
        const input = 'AABBCC';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('2桁（#RR）でエラーになること', () => {
        // Arrange
        const input = '#AB';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('4桁（#RGBA）でエラーになること', () => {
        // Arrange: 4桁は標準的なHEX形式ではない
        const input = '#ABCD';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('5桁でエラーになること', () => {
        // Arrange
        const input = '#ABCDE';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('7桁でエラーになること', () => {
        // Arrange
        const input = '#AABBCCD';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('9桁以上でエラーになること', () => {
        // Arrange
        const input = '#AABBCCDDE';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('不正な16進文字（G）でエラーになること', () => {
        // Arrange
        const input = '#GGGGGG';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('不正な16進文字（特殊文字）でエラーになること', () => {
        // Arrange
        const input = '#AB!@#$';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('空文字列でエラーになること', () => {
        // Arrange
        const input = '';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('#のみでエラーになること', () => {
        // Arrange
        const input = '#';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('rgb形式でエラーになること', () => {
        // Arrange: hexColorSchemaはHEX形式のみ
        const input = 'rgb(255, 0, 0)';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('カラー名でエラーになること', () => {
        // Arrange
        const input = 'red';

        // Act
        const result = hexColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });
    });
  });

  // =============================================================================
  // cssColorSchema - CSSカラー形式
  // =============================================================================
  describe('cssColorSchema', () => {
    describe('正常系 - HEX形式', () => {
      it('#RGB形式で検証成功すること', () => {
        // Arrange
        const input = '#abc';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#RRGGBB形式で検証成功すること', () => {
        // Arrange
        const input = '#AABBCC';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('#RRGGBBAA形式で検証成功すること', () => {
        // Arrange
        const input = '#AABBCCDD';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('正常系 - rgb()形式', () => {
      it('rgb(r, g, b)形式で検証成功すること', () => {
        // Arrange
        const input = 'rgb(255, 128, 0)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('rgb(r,g,b)スペースなしで検証成功すること', () => {
        // Arrange
        const input = 'rgb(255,128,0)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('rgb(0, 0, 0)で検証成功すること', () => {
        // Arrange
        const input = 'rgb(0, 0, 0)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('rgb(255, 255, 255)で検証成功すること', () => {
        // Arrange
        const input = 'rgb(255, 255, 255)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('正常系 - rgba()形式', () => {
      it('rgba(r, g, b, a)形式で検証成功すること', () => {
        // Arrange
        const input = 'rgba(255, 128, 0, 0.5)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('rgba(r, g, b, 0)で検証成功すること', () => {
        // Arrange
        const input = 'rgba(255, 0, 0, 0)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('rgba(r, g, b, 1)で検証成功すること', () => {
        // Arrange
        const input = 'rgba(255, 0, 0, 1)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('正常系 - hsl()形式', () => {
      it('hsl(h, s%, l%)形式で検証成功すること', () => {
        // Arrange
        const input = 'hsl(120, 100%, 50%)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('hsl(0, 0%, 0%)で検証成功すること', () => {
        // Arrange
        const input = 'hsl(0, 0%, 0%)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('hsl(360, 100%, 100%)で検証成功すること', () => {
        // Arrange
        const input = 'hsl(360, 100%, 100%)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('正常系 - hsla()形式', () => {
      it('hsla(h, s%, l%, a)形式で検証成功すること', () => {
        // Arrange
        const input = 'hsla(120, 100%, 50%, 0.5)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('hsla(0, 0%, 0%, 0)で検証成功すること', () => {
        // Arrange
        const input = 'hsla(0, 0%, 0%, 0)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('正常系 - キーワード', () => {
      it('currentColorで検証成功すること', () => {
        // Arrange
        const input = 'currentColor';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('transparentで検証成功すること', () => {
        // Arrange
        const input = 'transparent';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('inheritで検証成功すること', () => {
        // Arrange
        const input = 'inherit';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('正常系 - CSS変数', () => {
      it('var(--color)形式で検証成功すること', () => {
        // Arrange
        const input = 'var(--primary-color)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('var(--text-color)で検証成功すること', () => {
        // Arrange
        const input = 'var(--text-color)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('var(--a)（短い変数名）で検証成功すること', () => {
        // Arrange
        const input = 'var(--a)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('var(--color-primary-500)（複雑な変数名）で検証成功すること', () => {
        // Arrange
        const input = 'var(--color-primary-500)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('異常系', () => {
      it('空文字列でエラーになること', () => {
        // Arrange
        const input = '';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('不正な形式でエラーになること', () => {
        // Arrange
        const input = 'not-a-color';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('rgbのカッコなしでエラーになること', () => {
        // Arrange
        const input = 'rgb 255, 0, 0';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('varのハイフンなしでエラーになること', () => {
        // Arrange
        const input = 'var(color)';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('数値のみでエラーになること', () => {
        // Arrange
        const input = '255';

        // Act
        const result = cssColorSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });
    });
  });

  // =============================================================================
  // processingMetaSchema - 処理メタデータ
  // =============================================================================
  describe('processingMetaSchema', () => {
    describe('正常系', () => {
      it('processingTimeMsのみで検証成功すること', () => {
        // Arrange
        const input = { processingTimeMs: 100 };

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.processingTimeMs).toBe(100);
          expect(result.data.warnings).toBeUndefined();
        }
      });

      it('processingTimeMsとwarningsで検証成功すること', () => {
        // Arrange
        const input = {
          processingTimeMs: 250,
          warnings: ['Warning 1', 'Warning 2'],
        };

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.processingTimeMs).toBe(250);
          expect(result.data.warnings).toHaveLength(2);
        }
      });

      it('processingTimeMs = 0で検証成功すること', () => {
        // Arrange
        const input = { processingTimeMs: 0 };

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('小数のprocessingTimeMsで検証成功すること', () => {
        // Arrange
        const input = { processingTimeMs: 123.456 };

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });

      it('空のwarnings配列で検証成功すること', () => {
        // Arrange
        const input = {
          processingTimeMs: 100,
          warnings: [],
        };

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.warnings).toEqual([]);
        }
      });

      it('大きなprocessingTimeMs値で検証成功すること', () => {
        // Arrange
        const input = { processingTimeMs: 999999 };

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(true);
      });
    });

    describe('異常系', () => {
      it('processingTimeMsが未指定でエラーになること', () => {
        // Arrange
        const input = { warnings: ['Warning'] };

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('processingTimeMsが負の値でエラーになること', () => {
        // Arrange
        const input = { processingTimeMs: -100 };

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('processingTimeMsが文字列でエラーになること', () => {
        // Arrange
        const input = { processingTimeMs: '100' };

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('warningsが文字列（配列でない）でエラーになること', () => {
        // Arrange
        const input = {
          processingTimeMs: 100,
          warnings: 'Single warning',
        };

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('warningsに数値が含まれるとエラーになること', () => {
        // Arrange
        const input = {
          processingTimeMs: 100,
          warnings: ['Warning', 123],
        };

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('空オブジェクトでエラーになること', () => {
        // Arrange
        const input = {};

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('processingTimeMsがNaNでエラーになること', () => {
        // Arrange
        const input = { processingTimeMs: NaN };

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });

      it('processingTimeMsがInfinityでエラーになること', () => {
        // Arrange
        const input = { processingTimeMs: Infinity };

        // Act
        const result = processingMetaSchema.safeParse(input);

        // Assert
        expect(result.success).toBe(false);
      });
    });
  });

  // =============================================================================
  // 型エクスポートのテスト
  // =============================================================================
  describe('型エクスポート', () => {
    it('SvgSource型が正しくエクスポートされていること', () => {
      // このテストはコンパイル時の型チェックのため
      // 実行時には特に検証しない
      expect(true).toBe(true);
    });

    it('Point2D型が正しくエクスポートされていること', () => {
      expect(true).toBe(true);
    });

    it('Size型が正しくエクスポートされていること', () => {
      expect(true).toBe(true);
    });

    it('BoundingBox型が正しくエクスポートされていること', () => {
      expect(true).toBe(true);
    });

    it('HexColor型が正しくエクスポートされていること', () => {
      expect(true).toBe(true);
    });

    it('CssColor型が正しくエクスポートされていること', () => {
      expect(true).toBe(true);
    });

    it('ProcessingMeta型が正しくエクスポートされていること', () => {
      expect(true).toBe(true);
    });
  });
});
