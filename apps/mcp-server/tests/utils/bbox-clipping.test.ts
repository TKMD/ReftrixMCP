// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * bbox-clipping ユーティリティ テスト
 *
 * Sharp.extract() 向けの境界クランプロジック検証:
 * - 負の x/y → 0 クランプ
 * - 画像範囲を超える width/height → (imgWidth - left - 1) / (imgHeight - top - 1) に制限
 * - 0 サイズ / 下限割れ → null
 * - ぴったり端 (exact-fit) → 1px 余白確保
 * - 小数 → Math.round
 * - NaN / Infinity → null
 *
 * Tests for bbox clipping against image bounds for Sharp.extract().
 *
 * @module tests/utils/bbox-clipping
 */

import { describe, it, expect } from "vitest";
import { clampBboxToImage } from "../../src/utils/bbox-clipping";

describe("clampBboxToImage", () => {
  describe("正常系 / Normal cases", () => {
    it("負の x/y → 0 にクランプ / negative x/y clamp to 0", () => {
      const result = clampBboxToImage({ x: -10, y: -5, width: 100, height: 50 }, 200, 200);
      expect(result).toEqual({ left: 0, top: 0, width: 100, height: 50 });
    });

    it("width/height が画像範囲を超える → imgW-left-1 / imgH-top-1 に制限 / overflow width/height clipped", () => {
      // imgWidth=100, left=50 → availableWidth = 100 - 50 - 1 = 49
      // imgHeight=100, top=50 → availableHeight = 100 - 50 - 1 = 49
      const result = clampBboxToImage({ x: 50, y: 50, width: 200, height: 200 }, 100, 100);
      expect(result).toEqual({ left: 50, top: 50, width: 49, height: 49 });
    });

    it("exact-fit (bbox が画像ちょうど) → 右下 1px 余白確保 / 1px bottom-right margin preserved", () => {
      // bbox = whole image, but margin required
      const result = clampBboxToImage({ x: 0, y: 0, width: 100, height: 100 }, 100, 100);
      expect(result).toEqual({ left: 0, top: 0, width: 99, height: 99 });
    });

    it("pixel-rounding (小数 → Math.round) / floats round to nearest int", () => {
      const result = clampBboxToImage({ x: 10.4, y: 20.6, width: 30.5, height: 40.4 }, 200, 200);
      expect(result).toEqual({ left: 10, top: 21, width: 31, height: 40 });
    });
  });

  describe("下限 / Lower-bound rejection", () => {
    it("width が clipping 後 < 1 → null / width < 1 after clipping → null", () => {
      // left = imgWidth - 1 → availableWidth = 0
      const result = clampBboxToImage({ x: 99, y: 0, width: 10, height: 10 }, 100, 100);
      expect(result).toBeNull();
    });

    it("height が clipping 後 < 1 → null / height < 1 after clipping → null", () => {
      // top = imgHeight - 1 → availableHeight = 0
      const result = clampBboxToImage({ x: 0, y: 99, width: 10, height: 10 }, 100, 100);
      expect(result).toBeNull();
    });

    it("zero size (width=0, height=0) → null / zero-size bbox → null", () => {
      const result = clampBboxToImage({ x: 10, y: 10, width: 0, height: 0 }, 200, 200);
      expect(result).toBeNull();
    });
  });

  describe("異常系 / Error cases", () => {
    it("NaN 入力 → null / NaN input → null", () => {
      expect(clampBboxToImage({ x: NaN, y: 0, width: 10, height: 10 }, 100, 100)).toBeNull();
      expect(clampBboxToImage({ x: 0, y: NaN, width: 10, height: 10 }, 100, 100)).toBeNull();
      expect(clampBboxToImage({ x: 0, y: 0, width: NaN, height: 10 }, 100, 100)).toBeNull();
      expect(clampBboxToImage({ x: 0, y: 0, width: 10, height: NaN }, 100, 100)).toBeNull();
      expect(clampBboxToImage({ x: 0, y: 0, width: 10, height: 10 }, NaN, 100)).toBeNull();
      expect(clampBboxToImage({ x: 0, y: 0, width: 10, height: 10 }, 100, NaN)).toBeNull();
    });

    it("Infinity 入力 → null / Infinity input → null", () => {
      expect(clampBboxToImage({ x: Infinity, y: 0, width: 10, height: 10 }, 100, 100)).toBeNull();
      expect(clampBboxToImage({ x: 0, y: 0, width: Infinity, height: 10 }, 100, 100)).toBeNull();
      expect(clampBboxToImage({ x: 0, y: 0, width: 10, height: 10 }, 100, Infinity)).toBeNull();
    });

    it("画像サイズが 2px 未満 → null (1px 余白が取れない) / imgWidth/Height < 2 → null", () => {
      expect(clampBboxToImage({ x: 0, y: 0, width: 1, height: 1 }, 1, 100)).toBeNull();
      expect(clampBboxToImage({ x: 0, y: 0, width: 1, height: 1 }, 100, 1)).toBeNull();
    });
  });
});
