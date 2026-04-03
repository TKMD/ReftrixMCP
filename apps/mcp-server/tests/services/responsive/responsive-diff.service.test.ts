// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Diff Service Tests
 * レスポンシブ差分分析サービスのテスト
 *
 * @module tests/services/responsive/responsive-diff.service.test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger
vi.mock("../../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: () => true,
}));

import {
  ResponsiveDiffService,
  type DeviceCaptureData,
  type ResponsiveDiffResult,
} from "../../../src/services/responsive/responsive-diff.service";

// ============================================================================
// Test Helpers
// ============================================================================

function createCaptureData(
  viewportName: string,
  sections: DeviceCaptureData["sections"]
): DeviceCaptureData {
  return {
    viewport: {
      name: viewportName,
      width: viewportName === "desktop" ? 1920 : viewportName === "tablet" ? 768 : 375,
      height: viewportName === "desktop" ? 1080 : viewportName === "tablet" ? 1024 : 812,
    },
    sections,
    documentHeight: 2000,
    viewportWidth: viewportName === "desktop" ? 1920 : viewportName === "tablet" ? 768 : 375,
    viewportHeight: viewportName === "desktop" ? 1080 : viewportName === "tablet" ? 1024 : 812,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("ResponsiveDiffService", () => {
  let service: ResponsiveDiffService;

  beforeEach(() => {
    service = new ResponsiveDiffService();
  });

  // ============================================================================
  // computeDiff の検証
  // ============================================================================
  describe("computeDiff", () => {
    it("3つのキャプチャからスコアと変化を計算する", () => {
      const captures: DeviceCaptureData[] = [
        createCaptureData("desktop", [
          {
            selector: "header",
            tagName: "header",
            display: "flex",
            visibility: "visible",
            boundingRect: { x: 0, y: 0, width: 1920, height: 80 },
          },
          {
            selector: "main",
            tagName: "main",
            display: "grid",
            visibility: "visible",
            boundingRect: { x: 0, y: 80, width: 1920, height: 800 },
            gridColumns: 3,
          },
        ]),
        createCaptureData("tablet", [
          {
            selector: "header",
            tagName: "header",
            display: "flex",
            visibility: "visible",
            boundingRect: { x: 0, y: 0, width: 768, height: 60 },
          },
          {
            selector: "main",
            tagName: "main",
            display: "grid",
            visibility: "visible",
            boundingRect: { x: 0, y: 60, width: 768, height: 600 },
            gridColumns: 2,
          },
        ]),
        createCaptureData("mobile", [
          {
            selector: "header",
            tagName: "header",
            display: "flex",
            visibility: "visible",
            boundingRect: { x: 0, y: 0, width: 375, height: 56 },
          },
          {
            selector: "main",
            tagName: "main",
            display: "flex",
            visibility: "visible",
            boundingRect: { x: 0, y: 56, width: 375, height: 500 },
            flexDirection: "column",
          },
        ]),
      ];

      const result = service.computeDiff(captures);

      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.changes).toBeDefined();
      expect(Array.isArray(result.changes)).toBe(true);
    });

    it("同一レイアウトの場合はスコアが高い（差分が少ない）", () => {
      const sections = [
        {
          selector: "header",
          tagName: "header",
          display: "block",
          visibility: "visible",
          boundingRect: { x: 0, y: 0, width: 1920, height: 80 },
        },
      ];

      const captures: DeviceCaptureData[] = [
        createCaptureData("desktop", sections),
        createCaptureData("tablet", sections),
        createCaptureData("mobile", sections),
      ];

      const result = service.computeDiff(captures);

      // 同一レイアウトなのでスコアが高い
      expect(result.score).toBeGreaterThan(80);
    });

    it("表示/非表示の差分を検出する", () => {
      const captures: DeviceCaptureData[] = [
        createCaptureData("desktop", [
          {
            selector: "aside",
            tagName: "aside",
            display: "block",
            visibility: "visible",
            boundingRect: { x: 1200, y: 80, width: 300, height: 600 },
          },
        ]),
        createCaptureData("tablet", [
          {
            selector: "aside",
            tagName: "aside",
            display: "block",
            visibility: "visible",
            boundingRect: { x: 0, y: 800, width: 768, height: 300 },
          },
        ]),
        createCaptureData("mobile", [
          {
            selector: "aside",
            tagName: "aside",
            display: "none",
            visibility: "hidden",
            boundingRect: { x: 0, y: 0, width: 0, height: 0 },
          },
        ]),
      ];

      const result = service.computeDiff(captures);

      const visibilityChanges = result.changes.filter((c) => c.type === "visibility");
      expect(visibilityChanges.length).toBeGreaterThan(0);
    });

    it("フォントサイズ変化を検出する", () => {
      const captures: DeviceCaptureData[] = [
        createCaptureData("desktop", [
          {
            selector: "h1",
            tagName: "h1",
            display: "block",
            visibility: "visible",
            boundingRect: { x: 0, y: 100, width: 1920, height: 60 },
            fontSize: 48,
          },
        ]),
        createCaptureData("tablet", [
          {
            selector: "h1",
            tagName: "h1",
            display: "block",
            visibility: "visible",
            boundingRect: { x: 0, y: 80, width: 768, height: 48 },
            fontSize: 36,
          },
        ]),
        createCaptureData("mobile", [
          {
            selector: "h1",
            tagName: "h1",
            display: "block",
            visibility: "visible",
            boundingRect: { x: 0, y: 56, width: 375, height: 36 },
            fontSize: 24,
          },
        ]),
      ];

      const result = service.computeDiff(captures);

      const fontChanges = result.changes.filter((c) => c.type === "typography");
      expect(fontChanges.length).toBeGreaterThan(0);
    });

    it("グリッドカラム数の変化を検出する", () => {
      const captures: DeviceCaptureData[] = [
        createCaptureData("desktop", [
          {
            selector: ".grid-container",
            tagName: "div",
            display: "grid",
            visibility: "visible",
            boundingRect: { x: 0, y: 100, width: 1920, height: 400 },
            gridColumns: 4,
          },
        ]),
        createCaptureData("tablet", [
          {
            selector: ".grid-container",
            tagName: "div",
            display: "grid",
            visibility: "visible",
            boundingRect: { x: 0, y: 80, width: 768, height: 600 },
            gridColumns: 2,
          },
        ]),
        createCaptureData("mobile", [
          {
            selector: ".grid-container",
            tagName: "div",
            display: "grid",
            visibility: "visible",
            boundingRect: { x: 0, y: 56, width: 375, height: 800 },
            gridColumns: 1,
          },
        ]),
      ];

      const result = service.computeDiff(captures);

      const layoutChanges = result.changes.filter((c) => c.type === "layout");
      expect(layoutChanges.length).toBeGreaterThan(0);
    });

    it("スペーシング変化を検出する", () => {
      const captures: DeviceCaptureData[] = [
        createCaptureData("desktop", [
          {
            selector: "section",
            tagName: "section",
            display: "block",
            visibility: "visible",
            boundingRect: { x: 100, y: 0, width: 1720, height: 400 },
          },
        ]),
        createCaptureData("tablet", [
          {
            selector: "section",
            tagName: "section",
            display: "block",
            visibility: "visible",
            boundingRect: { x: 40, y: 0, width: 688, height: 400 },
          },
        ]),
        createCaptureData("mobile", [
          {
            selector: "section",
            tagName: "section",
            display: "block",
            visibility: "visible",
            boundingRect: { x: 16, y: 0, width: 343, height: 400 },
          },
        ]),
      ];

      const result = service.computeDiff(captures);

      const spacingChanges = result.changes.filter((c) => c.type === "spacing");
      expect(spacingChanges.length).toBeGreaterThan(0);
    });

    it("キャプチャが1つの場合は空の差分を返す", () => {
      const captures: DeviceCaptureData[] = [
        createCaptureData("desktop", [
          {
            selector: "header",
            tagName: "header",
            display: "block",
            visibility: "visible",
            boundingRect: { x: 0, y: 0, width: 1920, height: 80 },
          },
        ]),
      ];

      const result = service.computeDiff(captures);

      expect(result.score).toBe(100);
      expect(result.changes).toEqual([]);
    });

    it("空のキャプチャ配列ではスコア100を返す", () => {
      const result = service.computeDiff([]);

      expect(result.score).toBe(100);
      expect(result.changes).toEqual([]);
    });

    it("NaN/Infinityが結果に含まれない", () => {
      const captures: DeviceCaptureData[] = [
        createCaptureData("desktop", [
          {
            selector: "div",
            tagName: "div",
            display: "block",
            visibility: "visible",
            boundingRect: { x: 0, y: 0, width: 0, height: 0 },
          },
        ]),
        createCaptureData("mobile", [
          {
            selector: "div",
            tagName: "div",
            display: "none",
            visibility: "hidden",
            boundingRect: { x: 0, y: 0, width: 0, height: 0 },
          },
        ]),
      ];

      const result = service.computeDiff(captures);

      expect(Number.isFinite(result.score)).toBe(true);
      for (const change of result.changes) {
        if (change.score !== undefined) {
          expect(Number.isFinite(change.score)).toBe(true);
        }
      }
    });
  });
});
