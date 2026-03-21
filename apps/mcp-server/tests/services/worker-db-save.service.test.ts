// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker DB Save Service - saveSectionPatterns Tests
 *
 * Tests for saveSectionPatterns function:
 * - Normal save (clean slate: deleteMany → createMany)
 * - htmlSnippet sanitization via sanitizeHtml
 * - extractComponentsFromSection (UI component extraction from HTML)
 * - CSS fields persistence (cssSnippet, externalCssContent, cssFramework)
 * - Empty sections → count: 0, idMapping: empty Map
 * - UUIDv7 ID generation and idMapping (section.id → DB UUID)
 * - Prisma error graceful degradation
 * - Correct field mapping (LayoutSection → section_patterns DB)
 *
 * @module tests/services/worker-db-save.service
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  saveSectionPatterns,
  type SectionPatternPrismaClient,
  type LayoutSection,
} from "../../src/services/worker-db-save.service";

// =============================================================================
// Mocks
// =============================================================================

// Mock sanitizeHtml — pass-through with a marker to verify it was called
vi.mock("../../src/utils/html-sanitizer", () => ({
  sanitizeHtml: vi.fn((html: string) => `sanitized:${html}`),
}));

// Mock logger to suppress output during tests
vi.mock("../../src/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  isDevelopment: vi.fn(() => false),
}));

// Mock uuid to return predictable IDs
let uuidCounter = 0;
vi.mock("uuid", () => ({
  v7: vi.fn(() => {
    uuidCounter++;
    return `mock-uuid-${uuidCounter}`;
  }),
}));

// =============================================================================
// Test Helpers
// =============================================================================

function createMockPrisma(
  overrides?: Partial<SectionPatternPrismaClient["sectionPattern"]>
): SectionPatternPrismaClient {
  return {
    sectionPattern: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      ...overrides,
    },
  };
}

function createSampleSection(overrides?: Partial<LayoutSection>): LayoutSection {
  return {
    id: "section-original-1",
    type: "hero",
    positionIndex: 0,
    confidence: 0.95,
    heading: "Welcome",
    htmlSnippet: "<div><h1>Welcome</h1><button>Click</button></div>",
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("saveSectionPatterns", () => {
  const webPageId = "test-web-page-id-001";

  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;
  });

  // ---------------------------------------------------------------------------
  // 正常系
  // ---------------------------------------------------------------------------

  describe("正常保存", () => {
    it("should save section patterns and return SaveResult with success", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      });
      const sections = [
        createSampleSection({ id: "sec-1" }),
        createSampleSection({ id: "sec-2", type: "feature", positionIndex: 1 }),
      ];

      const result = await saveSectionPatterns(mockPrisma, webPageId, sections);

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.ids).toHaveLength(2);
      expect(result.error).toBeUndefined();
    });

    it("should delete existing records before creating (clean slate)", async () => {
      const mockPrisma = createMockPrisma({
        deleteMany: vi.fn().mockResolvedValue({ count: 5 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const sections = [createSampleSection()];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      expect(mockPrisma.sectionPattern.deleteMany).toHaveBeenCalledWith({
        where: { webPageId },
      });
      // deleteMany is called before createMany
      const deleteManyOrder = vi.mocked(mockPrisma.sectionPattern.deleteMany).mock
        .invocationCallOrder[0];
      const createManyOrder = vi.mocked(mockPrisma.sectionPattern.createMany).mock
        .invocationCallOrder[0];
      expect(deleteManyOrder).toBeLessThan(createManyOrder!);
    });

    it("should generate UUIDv7 for each section and return correct idMapping", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      });
      const sections = [
        createSampleSection({ id: "original-id-A" }),
        createSampleSection({ id: "original-id-B", positionIndex: 1 }),
      ];

      const result = await saveSectionPatterns(mockPrisma, webPageId, sections);

      expect(result.idMapping.size).toBe(2);
      expect(result.idMapping.get("original-id-A")).toBe("mock-uuid-1");
      expect(result.idMapping.get("original-id-B")).toBe("mock-uuid-2");
      expect(result.ids).toEqual(["mock-uuid-1", "mock-uuid-2"]);
    });
  });

  // ---------------------------------------------------------------------------
  // フィールドマッピング
  // ---------------------------------------------------------------------------

  describe("フィールドマッピング", () => {
    it("should map sectionType from section.type", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const sections = [createSampleSection({ type: "testimonial" })];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.sectionType).toBe("testimonial");
    });

    it("should map sectionName from section.heading, defaulting to null", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      });
      const sections = [
        createSampleSection({ heading: "My Heading" }),
        createSampleSection({ id: "sec-2", heading: undefined, positionIndex: 1 }),
      ];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.sectionName).toBe("My Heading");
      expect(data?.[1]?.sectionName).toBeNull();
    });

    it("should use section.positionIndex or fallback to array index", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      });
      const sections = [
        createSampleSection({ positionIndex: 5 }),
        createSampleSection({ id: "sec-2", positionIndex: undefined as unknown as number }),
      ];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.positionIndex).toBe(5);
      // When positionIndex is undefined, fallback to array index (1)
      expect(data?.[1]?.positionIndex).toBe(1);
    });

    it("should include position in layoutInfo when present", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const position = { startY: 0, endY: 500, height: 500 };
      const sections = [createSampleSection({ position })];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      const layoutInfo = data?.[0]?.layoutInfo as Record<string, unknown>;
      expect(layoutInfo.type).toBe("hero");
      expect(layoutInfo.confidence).toBe(0.95);
      expect(layoutInfo.position).toEqual(position);
    });

    it("should omit position from layoutInfo when not present", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const sections = [createSampleSection({ position: undefined })];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      const layoutInfo = data?.[0]?.layoutInfo as Record<string, unknown>;
      expect(layoutInfo.position).toBeUndefined();
    });

    it("should set default values for tags, metadata, and visualFeatures", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const sections = [createSampleSection()];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.tags).toEqual([]);
      expect(data?.[0]?.metadata).toEqual({});
      expect(data?.[0]?.visualFeatures).toEqual({});
    });

    it("should preserve visualFeatures when provided", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const visualFeatures = { dominantColor: "#ff0000", hasGradient: true };
      const sections = [createSampleSection({ visualFeatures })];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.visualFeatures).toEqual(visualFeatures);
    });
  });

  // ---------------------------------------------------------------------------
  // CSS フィールド
  // ---------------------------------------------------------------------------

  describe("CSS fields persistence", () => {
    it("should persist cssSnippet when provided", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const sections = [createSampleSection({ cssSnippet: ".hero { color: red; }" })];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.cssSnippet).toBe(".hero { color: red; }");
    });

    it("should default cssSnippet to null when not provided", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const sections = [createSampleSection({ cssSnippet: undefined })];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.cssSnippet).toBeNull();
    });

    it("should persist externalCssContent and externalCssMeta", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const externalCssMeta = {
        fetchedCount: 2,
        failedCount: 0,
        totalSize: 5000,
        urls: [{ url: "https://cdn.example.com/style.css", size: 5000, success: true }],
        fetchedAt: "2026-03-01T00:00:00Z",
      };
      const sections = [
        createSampleSection({
          externalCssContent: "body { margin: 0; }",
          externalCssMeta,
        }),
      ];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.externalCssContent).toBe("body { margin: 0; }");
      expect(data?.[0]?.externalCssMeta).toEqual(externalCssMeta);
    });

    it("should persist cssFramework and cssFrameworkMeta", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const sections = [
        createSampleSection({
          cssFramework: "tailwind",
          cssFrameworkMeta: { confidence: 0.99, evidence: ["@apply", "space-y-4"] },
        }),
      ];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.cssFramework).toBe("tailwind");
      expect(data?.[0]?.cssFrameworkMeta).toEqual({
        confidence: 0.99,
        evidence: ["@apply", "space-y-4"],
      });
    });

    it("should default cssFrameworkMeta to empty object when not provided", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const sections = [createSampleSection()];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.cssFrameworkMeta).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // htmlSnippet サニタイズ
  // ---------------------------------------------------------------------------

  describe("htmlSnippet sanitization", () => {
    it("should call sanitizeHtml on htmlSnippet", async () => {
      const { sanitizeHtml } = await import("../../src/utils/html-sanitizer");
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const sections = [
        createSampleSection({
          htmlSnippet: '<div><script>alert("xss")</script></div>',
        }),
      ];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      expect(sanitizeHtml).toHaveBeenCalledWith('<div><script>alert("xss")</script></div>');
      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.htmlSnippet).toBe('sanitized:<div><script>alert("xss")</script></div>');
    });

    it("should set htmlSnippet to null when not provided", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const sections = [createSampleSection({ htmlSnippet: undefined })];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.htmlSnippet).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // extractComponentsFromSection (via saveSectionPatterns)
  // ---------------------------------------------------------------------------

  describe("extractComponentsFromSection (component extraction)", () => {
    it("should extract button, link, image, heading components from htmlSnippet", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const html =
        '<div><h1>Title</h1><h2>Sub</h2><a href="#">Link1</a><a href="#">Link2</a><button>Go</button><img src="x.png"><img src="y.png"><img src="z.png"></div>';
      const sections = [createSampleSection({ htmlSnippet: html })];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      const components = data?.[0]?.components as Array<{ type: string; count: number }>;

      expect(components).toEqual(
        expect.arrayContaining([
          { type: "button", count: 1 },
          { type: "link", count: 2 },
          { type: "image", count: 3 },
          { type: "heading", count: 2 },
        ])
      );
    });

    it("should extract form, input, video, svg, canvas, iframe, table, list components", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const html =
        '<form><input type="text"><input type="email"></form><video src="v.mp4"></video><svg></svg><canvas></canvas><iframe src="x"></iframe><table></table><ul></ul>';
      const sections = [createSampleSection({ htmlSnippet: html })];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      const components = data?.[0]?.components as Array<{ type: string; count: number }>;

      expect(components).toEqual(
        expect.arrayContaining([
          { type: "form", count: 1 },
          { type: "input", count: 2 },
          { type: "video", count: 1 },
          { type: "svg", count: 1 },
          { type: "canvas", count: 1 },
          { type: "iframe", count: 1 },
          { type: "table", count: 1 },
          { type: "list", count: 1 },
        ])
      );
    });

    it("should return empty components array when htmlSnippet has no recognizable tags", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const sections = [createSampleSection({ htmlSnippet: "<div><p>Just text</p></div>" })];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      const components = data?.[0]?.components as Array<{ type: string; count: number }>;
      expect(components).toEqual([]);
    });

    it("should return empty components array when htmlSnippet is undefined", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const sections = [createSampleSection({ htmlSnippet: undefined })];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      const components = data?.[0]?.components as Array<{ type: string; count: number }>;
      expect(components).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 空配列
  // ---------------------------------------------------------------------------

  describe("空配列ハンドリング", () => {
    it("should return count: 0 with empty idMapping when sections is empty", async () => {
      const mockPrisma = createMockPrisma();

      const result = await saveSectionPatterns(mockPrisma, webPageId, []);

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
      expect(result.ids).toEqual([]);
      expect(result.idMapping.size).toBe(0);
    });

    it("should not call deleteMany or createMany when sections is empty", async () => {
      const mockPrisma = createMockPrisma();

      await saveSectionPatterns(mockPrisma, webPageId, []);

      expect(mockPrisma.sectionPattern.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.sectionPattern.createMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // エラーハンドリング (Graceful Degradation)
  // ---------------------------------------------------------------------------

  describe("Graceful Degradation (エラーハンドリング)", () => {
    it("should return success: false with error message when deleteMany fails", async () => {
      const mockPrisma = createMockPrisma({
        deleteMany: vi.fn().mockRejectedValue(new Error("Connection refused")),
      });
      const sections = [createSampleSection()];

      const result = await saveSectionPatterns(mockPrisma, webPageId, sections);

      expect(result.success).toBe(false);
      expect(result.count).toBe(0);
      expect(result.ids).toEqual([]);
      expect(result.idMapping.size).toBe(0);
      expect(result.error).toBe("Connection refused");
    });

    it("should return success: false with error message when createMany fails", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockRejectedValue(new Error("Unique constraint violation")),
      });
      const sections = [createSampleSection()];

      const result = await saveSectionPatterns(mockPrisma, webPageId, sections);

      expect(result.success).toBe(false);
      expect(result.count).toBe(0);
      expect(result.error).toBe("Unique constraint violation");
    });

    it("should return generic error message for non-Error throws", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockRejectedValue("string error"),
      });
      const sections = [createSampleSection()];

      const result = await saveSectionPatterns(mockPrisma, webPageId, sections);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to save section patterns");
    });

    it("should log warning when save fails", async () => {
      const { logger } = await import("../../src/utils/logger");
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockRejectedValue(new Error("DB timeout")),
      });
      const sections = [createSampleSection()];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      expect(logger.warn).toHaveBeenCalledWith(
        "[WorkerDBSave] Section pattern save failed",
        expect.objectContaining({
          webPageId,
          error: "DB timeout",
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // webPageId の伝播
  // ---------------------------------------------------------------------------

  describe("webPageId propagation", () => {
    it("should pass webPageId to deleteMany and each record in createMany", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      });
      const sections = [createSampleSection()];

      await saveSectionPatterns(mockPrisma, webPageId, sections);

      expect(mockPrisma.sectionPattern.deleteMany).toHaveBeenCalledWith({
        where: { webPageId },
      });

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data?.[0]?.webPageId).toBe(webPageId);
    });
  });

  // ---------------------------------------------------------------------------
  // 複数セクション
  // ---------------------------------------------------------------------------

  describe("複数セクション処理", () => {
    it("should process multiple sections with distinct IDs and correct positionIndex", async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 3 }),
      });
      const sections = [
        createSampleSection({ id: "sec-hero", type: "hero", positionIndex: 0 }),
        createSampleSection({ id: "sec-feature", type: "feature", positionIndex: 1 }),
        createSampleSection({ id: "sec-cta", type: "cta", positionIndex: 2 }),
      ];

      const result = await saveSectionPatterns(mockPrisma, webPageId, sections);

      expect(result.success).toBe(true);
      expect(result.count).toBe(3);
      expect(result.ids).toHaveLength(3);
      expect(result.idMapping.size).toBe(3);

      const call = vi.mocked(mockPrisma.sectionPattern.createMany).mock.calls[0];
      const data = (call?.[0] as { data: Record<string, unknown>[] })?.data;
      expect(data).toHaveLength(3);
      expect(data?.map((d) => d.sectionType)).toEqual(["hero", "feature", "cta"]);
      expect(data?.map((d) => d.positionIndex)).toEqual([0, 1, 2]);
    });
  });
});
