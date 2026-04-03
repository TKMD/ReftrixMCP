// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Contrast Check Service Unit Tests
 *
 * OKLCH色空間でのコントラスト比計算サービスのテスト
 * Tests for OKLCH color space contrast ratio calculation service
 *
 * @module tests/services/contrast-check.service.test
 */

import { describe, it, expect } from "vitest";
import {
  ContrastCheckService,
  createContrastCheckService,
  type ContrastIssue,
  type ContrastCheckResult,
} from "../../src/services/quality/contrast-check.service";

describe("ContrastCheckService", () => {
  let service: ContrastCheckService;

  beforeEach(() => {
    service = new ContrastCheckService();
  });

  describe("constructor", () => {
    it("デフォルトで初期化できる", () => {
      const svc = new ContrastCheckService();
      expect(svc).toBeDefined();
    });
  });

  describe("calculateContrastRatio", () => {
    it("白と黒のコントラスト比は21:1", () => {
      const ratio = service.calculateContrastRatio("#ffffff", "#000000");
      expect(ratio).toBeCloseTo(21, 0);
    });

    it("同一色のコントラスト比は1:1", () => {
      const ratio = service.calculateContrastRatio("#ffffff", "#ffffff");
      expect(ratio).toBeCloseTo(1, 0);
    });

    it("明るいグレーと白のコントラスト比は低い", () => {
      const ratio = service.calculateContrastRatio("#cccccc", "#ffffff");
      expect(ratio).toBeLessThan(2);
    });

    it("短縮hex (#fff) を処理できる", () => {
      const ratio = service.calculateContrastRatio("#fff", "#000");
      expect(ratio).toBeCloseTo(21, 0);
    });

    it("rgb() 形式を処理できる", () => {
      const ratio = service.calculateContrastRatio("rgb(255, 255, 255)", "rgb(0, 0, 0)");
      expect(ratio).toBeCloseTo(21, 0);
    });

    it("rgba() 形式を処理できる（アルファは無視）", () => {
      const ratio = service.calculateContrastRatio("rgba(255, 255, 255, 0.5)", "rgba(0, 0, 0, 1)");
      expect(ratio).toBeCloseTo(21, 0);
    });

    it("無効な色形式でNaNを返さない", () => {
      const ratio = service.calculateContrastRatio("invalid", "#000000");
      expect(Number.isFinite(ratio)).toBe(true);
    });
  });

  describe("meetsWcagAA", () => {
    it("通常テキスト: コントラスト比>=4.5でAA合格", () => {
      expect(service.meetsWcagAA(4.5, false)).toBe(true);
      expect(service.meetsWcagAA(4.4, false)).toBe(false);
    });

    it("大テキスト: コントラスト比>=3.0でAA合格", () => {
      expect(service.meetsWcagAA(3.0, true)).toBe(true);
      expect(service.meetsWcagAA(2.9, true)).toBe(false);
    });
  });

  describe("meetsWcagAAA", () => {
    it("通常テキスト: コントラスト比>=7.0でAAA合格", () => {
      expect(service.meetsWcagAAA(7.0, false)).toBe(true);
      expect(service.meetsWcagAAA(6.9, false)).toBe(false);
    });

    it("大テキスト: コントラスト比>=4.5でAAA合格", () => {
      expect(service.meetsWcagAAA(4.5, true)).toBe(true);
      expect(service.meetsWcagAAA(4.4, true)).toBe(false);
    });
  });

  describe("suggestAlternativeColor", () => {
    it("AA基準を満たす代替色を提案する（通常テキスト）", () => {
      // 灰色テキストに対して白背景でAA達成する暗い色を提案
      const suggestion = service.suggestAlternativeColor("#999999", "#ffffff", false);
      expect(suggestion).toBeDefined();
      expect(typeof suggestion).toBe("string");

      // 提案された色がAA基準を満たすことを確認
      const ratio = service.calculateContrastRatio(suggestion, "#ffffff");
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it("AA基準を満たす代替色を提案する（大テキスト）", () => {
      const suggestion = service.suggestAlternativeColor("#aaaaaa", "#ffffff", true);
      expect(suggestion).toBeDefined();

      const ratio = service.calculateContrastRatio(suggestion, "#ffffff");
      expect(ratio).toBeGreaterThanOrEqual(3.0);
    });

    it("既にAA基準を満たしている場合はそのまま返す", () => {
      const suggestion = service.suggestAlternativeColor("#000000", "#ffffff", false);
      // 黒と白は21:1なのでそのまま
      expect(suggestion).toBe("#000000");
    });
  });

  describe("checkHtmlContrast", () => {
    it("コントラスト問題のあるHTMLを検出する", async () => {
      const html = `<!DOCTYPE html>
<html lang="ja">
<head><title>Test</title></head>
<body>
  <p style="color: #cccccc; background-color: #ffffff;">見えにくいテキスト</p>
</body>
</html>`;
      const result = await service.checkHtmlContrast(html);

      expect(result).toBeDefined();
      expect(result.issues).toBeInstanceOf(Array);
      expect(result.totalElements).toBeGreaterThanOrEqual(0);
    });

    it("空のHTMLに対して空の結果を返す", async () => {
      const result = await service.checkHtmlContrast("");
      expect(result.issues).toHaveLength(0);
      expect(result.totalElements).toBe(0);
    });

    it("issues の各要素にfgColor, bgColor, ratio, meetsAA, suggestion を含む", async () => {
      const html = `<!DOCTYPE html>
<html lang="ja">
<head><title>Test</title></head>
<body style="background-color: #ffffff;">
  <p style="color: #cccccc;">テスト</p>
</body>
</html>`;
      const result = await service.checkHtmlContrast(html);

      for (const issue of result.issues) {
        expect(issue.element).toBeDefined();
        expect(issue.fgColor).toBeDefined();
        expect(issue.bgColor).toBeDefined();
        expect(typeof issue.ratio).toBe("number");
        expect(Number.isFinite(issue.ratio)).toBe(true);
        expect(typeof issue.meetsAA).toBe("boolean");
        expect(typeof issue.isLargeText).toBe("boolean");
        if (!issue.meetsAA) {
          expect(issue.suggestedColor).toBeDefined();
          expect(typeof issue.suggestedColor).toBe("string");
        }
      }
    });
  });

  describe("sRGB相対輝度計算", () => {
    it("白の相対輝度は1.0", () => {
      const luminance = service.getRelativeLuminance(255, 255, 255);
      expect(luminance).toBeCloseTo(1.0, 5);
    });

    it("黒の相対輝度は0.0", () => {
      const luminance = service.getRelativeLuminance(0, 0, 0);
      expect(luminance).toBeCloseTo(0.0, 5);
    });

    it("中間グレーの相対輝度は0~1の間", () => {
      const luminance = service.getRelativeLuminance(128, 128, 128);
      expect(luminance).toBeGreaterThan(0);
      expect(luminance).toBeLessThan(1);
    });
  });

  describe("色パース", () => {
    it("hex6桁をパースできる", () => {
      const rgb = service.parseColor("#ff0000");
      expect(rgb).toEqual({ r: 255, g: 0, b: 0 });
    });

    it("hex3桁をパースできる", () => {
      const rgb = service.parseColor("#f00");
      expect(rgb).toEqual({ r: 255, g: 0, b: 0 });
    });

    it("rgb()をパースできる", () => {
      const rgb = service.parseColor("rgb(255, 128, 0)");
      expect(rgb).toEqual({ r: 255, g: 128, b: 0 });
    });

    it("rgba()をパースできる", () => {
      const rgb = service.parseColor("rgba(100, 200, 50, 0.5)");
      expect(rgb).toEqual({ r: 100, g: 200, b: 50 });
    });

    it("無効な形式でデフォルト黒を返す", () => {
      const rgb = service.parseColor("invalid-color");
      expect(rgb).toEqual({ r: 0, g: 0, b: 0 });
    });

    it("named colors (black, white) をサポート", () => {
      const black = service.parseColor("black");
      expect(black).toEqual({ r: 0, g: 0, b: 0 });

      const white = service.parseColor("white");
      expect(white).toEqual({ r: 255, g: 255, b: 255 });
    });
  });

  describe("ファクトリ関数", () => {
    it("createContrastCheckService でインスタンスを作成できる", () => {
      const svc = createContrastCheckService();
      expect(svc).toBeInstanceOf(ContrastCheckService);
    });
  });

  describe("NaN/Infinity防御", () => {
    it("コントラスト比計算でNaNが生じない", () => {
      const ratio = service.calculateContrastRatio("", "");
      expect(Number.isFinite(ratio)).toBe(true);
    });

    it("輝度計算でNaN/Infinityが生じない", () => {
      const lum = service.getRelativeLuminance(NaN, NaN, NaN);
      expect(Number.isFinite(lum)).toBe(true);
    });
  });
});
