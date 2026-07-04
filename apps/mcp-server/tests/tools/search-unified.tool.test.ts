// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  searchUnifiedInputSchema,
  searchUnifiedHandler,
  searchUnifiedToolDefinition,
  UNIFIED_SEARCH_ERROR_CODES,
  type SearchUnifiedOutput,
} from "../../src/tools/search-unified.tool";
import { invalidateCache } from "../../src/services/search-cache.service";
import { computeFacetsFromResults } from "../../src/services/facet.service";

// =====================================================
// Mock individual search handlers
// =====================================================

vi.mock("../../src/tools/layout/search.tool", () => ({
  layoutSearchHandler: vi.fn(),
}));

vi.mock("../../src/tools/part/search.tool", () => ({
  partSearchHandler: vi.fn(),
}));

vi.mock("../../src/tools/motion/search.tool", () => ({
  motionSearchHandler: vi.fn(),
}));

vi.mock("../../src/tools/background/search.tool", () => ({
  backgroundSearchHandler: vi.fn(),
}));

vi.mock("../../src/tools/narrative/search.tool", () => ({
  narrativeSearchHandler: vi.fn(),
}));

vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

vi.mock("../../src/utils/sanitize-error", () => ({
  sanitizeErrorMessage: vi.fn((err: Error) => err.message),
}));

vi.mock("../../src/services/search/query-understanding.service", () => ({
  understandQuery: vi.fn((query: string) => ({
    originalQuery: query,
    expandedQuery: query, // テストではクエリ拡張しない / No expansion in tests
    queryType: "visual" as const,
    extractedFilters: {},
  })),
}));

vi.mock("../../src/services/search/cross-encoder-rerank.service", () => ({
  applyCrossEncoderReranking: vi.fn((results: Array<{ id: string; similarity: number }>) =>
    Promise.resolve({ items: results, reranked: false, method: "none" })
  ),
}));

vi.mock("../../src/services/facet.service", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    computeFacetsFromResults: vi.fn(
      actual.computeFacetsFromResults as (...args: unknown[]) => unknown
    ),
  };
});

import { layoutSearchHandler } from "../../src/tools/layout/search.tool";
import { partSearchHandler } from "../../src/tools/part/search.tool";
import { motionSearchHandler } from "../../src/tools/motion/search.tool";
import { backgroundSearchHandler } from "../../src/tools/background/search.tool";
import { narrativeSearchHandler } from "../../src/tools/narrative/search.tool";

// =====================================================
// Test helpers
// =====================================================

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

function mockLayoutSuccess(
  results: Array<{ id: string; similarity: number; sectionType?: string; webPageUrl?: string }>
): void {
  vi.mocked(layoutSearchHandler).mockResolvedValue({
    success: true,
    data: {
      results: results.map((r) => ({
        id: r.id,
        similarity: r.similarity,
        sectionType: r.sectionType ?? "hero",
        webPageUrl: r.webPageUrl ?? "https://example.com",
        sectionName: null,
        webPage: { id: "wp-1", url: "https://example.com", title: null, sourceType: "manual" },
        htmlSnippet: "<div></div>",
      })),
      total: results.length,
      query: "test",
      searchTimeMs: 50,
      breakdown: { vector: results.length, fulltext: 0 },
    },
  } as unknown as Awaited<ReturnType<typeof layoutSearchHandler>>);
}

function mockPartSuccess(
  results: Array<{ id: string; similarity: number; partType?: string; webPageUrl?: string }>
): void {
  vi.mocked(partSearchHandler).mockResolvedValue({
    success: true,
    data: {
      results: results.map((r) => ({
        id: r.id,
        similarity: r.similarity,
        partType: r.partType ?? "button",
        webPageUrl: r.webPageUrl ?? "https://example.com",
      })),
      total: results.length,
      query: "test",
      searchTimeMs: 30,
    },
  } as unknown as Awaited<ReturnType<typeof partSearchHandler>>);
}

function mockMotionSuccess(
  results: Array<{
    similarity: number;
    patternName?: string;
    patternType?: string;
    pageId?: string;
    url?: string;
  }>
): void {
  vi.mocked(motionSearchHandler).mockResolvedValue({
    success: true,
    data: {
      results: results.map((r) => ({
        pattern: { name: r.patternName ?? "fade-in", type: r.patternType ?? "css" },
        similarity: r.similarity,
        source: { pageId: r.pageId ?? "page-1", url: r.url ?? "https://example.com" },
      })),
      total: results.length,
      query: "test",
      searchTimeMs: 40,
    },
  } as unknown as Awaited<ReturnType<typeof motionSearchHandler>>);
}

function mockBackgroundSuccess(
  results: Array<{
    id: string;
    similarity: number;
    designType?: string;
    webPageId?: string;
    name?: string;
  }>
): void {
  vi.mocked(backgroundSearchHandler).mockResolvedValue({
    success: true,
    data: {
      results: results.map((r) => ({
        id: r.id,
        designType: r.designType ?? "linear_gradient",
        cssValue: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        similarity: r.similarity,
        source: { webPageId: r.webPageId ?? "wp-1" },
        name: r.name ?? "gradient-bg",
        selector: null,
        colorInfo: {},
        textRepresentation: "gradient background",
      })),
      total: results.length,
      query: "test",
      searchTimeMs: 35,
    },
  } as unknown as Awaited<ReturnType<typeof backgroundSearchHandler>>);
}

function mockNarrativeSuccess(
  results: Array<{
    id: string;
    similarity: number;
    webPageId?: string;
    sourceUrl?: string;
    moodCategory?: string;
    moodDescription?: string;
  }>
): void {
  vi.mocked(narrativeSearchHandler).mockResolvedValue({
    success: true,
    data: {
      results: results.map((r) => ({
        id: r.id,
        webPageId: r.webPageId ?? "wp-1",
        sourceUrl: r.sourceUrl ?? "https://example.com",
        similarity: r.similarity,
        worldView: {
          moodCategory: r.moodCategory ?? "professional",
          moodDescription: r.moodDescription ?? "Professional and clean design",
          overallTone: "professional",
        },
        layoutStructure: { gridType: "css-grid", columns: 12 },
        confidence: 0.85,
      })),
      searchInfo: {
        query: "test",
        searchMode: "hybrid",
        totalResults: results.length,
        searchTimeMs: 45,
      },
    },
  } as unknown as Awaited<ReturnType<typeof narrativeSearchHandler>>);
}

function mockAllEmpty(): void {
  mockLayoutSuccess([]);
  mockPartSuccess([]);
  mockMotionSuccess([]);
  mockBackgroundSuccess([]);
  mockNarrativeSuccess([]);
}

// =====================================================
// Test suite
// =====================================================

describe("search.unified", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache();
  });

  // =================================================
  // 1. Zod schema validation
  // =================================================

  describe("Zod schema validation", () => {
    it("should accept valid input with query only", () => {
      const result = searchUnifiedInputSchema.parse({ query: "hero section" });
      expect(result.query).toBe("hero section");
      expect(result.limit).toBe(10);
      expect(result.types).toBeUndefined();
      expect(result.webPageId).toBeUndefined();
      expect(result.profile_id).toBeUndefined();
    });

    it("should accept valid input with all fields", () => {
      const result = searchUnifiedInputSchema.parse({
        query: "gradient background",
        types: ["layout", "part"],
        limit: 25,
        webPageId: VALID_UUID,
        profile_id: VALID_UUID,
      });
      expect(result.query).toBe("gradient background");
      expect(result.types).toEqual(["layout", "part"]);
      expect(result.limit).toBe(25);
      expect(result.webPageId).toBe(VALID_UUID);
      expect(result.profile_id).toBe(VALID_UUID);
    });

    it("should apply default value for limit", () => {
      const result = searchUnifiedInputSchema.parse({ query: "test" });
      expect(result.limit).toBe(10);
    });

    it("should reject empty query", () => {
      expect(() => searchUnifiedInputSchema.parse({ query: "" })).toThrow();
    });

    it("should reject query exceeding 500 characters", () => {
      expect(() => searchUnifiedInputSchema.parse({ query: "a".repeat(501) })).toThrow();
    });

    it("should accept query of exactly 500 characters", () => {
      const result = searchUnifiedInputSchema.parse({ query: "a".repeat(500) });
      expect(result.query).toHaveLength(500);
    });

    it("should reject limit of 0", () => {
      expect(() => searchUnifiedInputSchema.parse({ query: "test", limit: 0 })).toThrow();
    });

    it("should reject limit exceeding 50", () => {
      expect(() => searchUnifiedInputSchema.parse({ query: "test", limit: 51 })).toThrow();
    });

    it("should accept boundary values for limit (1 and 50)", () => {
      const r1 = searchUnifiedInputSchema.parse({ query: "test", limit: 1 });
      expect(r1.limit).toBe(1);

      const r50 = searchUnifiedInputSchema.parse({ query: "test", limit: 50 });
      expect(r50.limit).toBe(50);
    });

    it("should reject invalid types value", () => {
      expect(() => searchUnifiedInputSchema.parse({ query: "test", types: ["invalid"] })).toThrow();
    });

    it("should accept all valid type values individually", () => {
      for (const t of ["layout", "part", "motion", "background", "narrative"]) {
        const result = searchUnifiedInputSchema.parse({
          query: "test",
          types: [t],
        });
        expect(result.types).toEqual([t]);
      }
    });

    it("should reject empty types array", () => {
      expect(() => searchUnifiedInputSchema.parse({ query: "test", types: [] })).toThrow();
    });

    it("should reject invalid UUID for webPageId", () => {
      expect(() =>
        searchUnifiedInputSchema.parse({ query: "test", webPageId: "not-a-uuid" })
      ).toThrow();
    });

    it("should reject invalid UUID for profile_id", () => {
      expect(() =>
        searchUnifiedInputSchema.parse({ query: "test", profile_id: "not-a-uuid" })
      ).toThrow();
    });

    it("should reject missing query field", () => {
      expect(() => searchUnifiedInputSchema.parse({})).toThrow();
    });

    it("should reject non-integer limit", () => {
      expect(() => searchUnifiedInputSchema.parse({ query: "test", limit: 5.5 })).toThrow();
    });
  });

  // =================================================
  // 2. Handler parallel execution
  // =================================================

  describe("handler parallel execution", () => {
    it("should call all five search handlers when no types specified", async () => {
      mockAllEmpty();

      await searchUnifiedHandler({ query: "test query" });

      expect(layoutSearchHandler).toHaveBeenCalledTimes(1);
      expect(partSearchHandler).toHaveBeenCalledTimes(1);
      expect(motionSearchHandler).toHaveBeenCalledTimes(1);
      expect(backgroundSearchHandler).toHaveBeenCalledTimes(1);
      expect(narrativeSearchHandler).toHaveBeenCalledTimes(1);
    });

    it("should pass correct params to layoutSearchHandler", async () => {
      mockAllEmpty();

      await searchUnifiedHandler({
        query: "hero section",
        limit: 20,
        webPageId: VALID_UUID,
        profile_id: VALID_UUID,
      });

      expect(layoutSearchHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: "hero section",
          limit: 20,
          offset: 0,
          filters: { webPageId: VALID_UUID },
          profile_id: VALID_UUID,
        })
      );
    });

    it("should pass correct params to partSearchHandler", async () => {
      mockAllEmpty();

      await searchUnifiedHandler({
        query: "button component",
        limit: 15,
        webPageId: VALID_UUID,
      });

      expect(partSearchHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: "button component",
          limit: 15,
          offset: 0,
          web_page_id: VALID_UUID,
        })
      );
    });

    it("should pass correct params to motionSearchHandler", async () => {
      mockAllEmpty();

      await searchUnifiedHandler({
        query: "fade animation",
        limit: 10,
        webPageId: VALID_UUID,
        profile_id: VALID_UUID,
      });

      expect(motionSearchHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "search",
          query: "fade animation",
          limit: 10,
          minSimilarity: 0.3,
          filters: { webPageId: VALID_UUID },
          profile_id: VALID_UUID,
        })
      );
    });

    it("should not pass filters when webPageId is undefined", async () => {
      mockAllEmpty();

      await searchUnifiedHandler({ query: "test" });

      expect(layoutSearchHandler).toHaveBeenCalledWith(
        expect.objectContaining({ filters: undefined })
      );
      expect(motionSearchHandler).toHaveBeenCalledWith(
        expect.objectContaining({ filters: undefined })
      );
    });

    it("should only call layout handler when types is ['layout']", async () => {
      mockLayoutSuccess([]);

      await searchUnifiedHandler({ query: "test", types: ["layout"] });

      expect(layoutSearchHandler).toHaveBeenCalledTimes(1);
      expect(partSearchHandler).not.toHaveBeenCalled();
      expect(motionSearchHandler).not.toHaveBeenCalled();
      expect(backgroundSearchHandler).not.toHaveBeenCalled();
      expect(narrativeSearchHandler).not.toHaveBeenCalled();
    });

    it("should only call part handler when types is ['part']", async () => {
      mockPartSuccess([]);

      await searchUnifiedHandler({ query: "test", types: ["part"] });

      expect(layoutSearchHandler).not.toHaveBeenCalled();
      expect(partSearchHandler).toHaveBeenCalledTimes(1);
      expect(motionSearchHandler).not.toHaveBeenCalled();
      expect(backgroundSearchHandler).not.toHaveBeenCalled();
      expect(narrativeSearchHandler).not.toHaveBeenCalled();
    });

    it("should only call motion handler when types is ['motion']", async () => {
      mockMotionSuccess([]);

      await searchUnifiedHandler({ query: "test", types: ["motion"] });

      expect(layoutSearchHandler).not.toHaveBeenCalled();
      expect(partSearchHandler).not.toHaveBeenCalled();
      expect(motionSearchHandler).toHaveBeenCalledTimes(1);
      expect(backgroundSearchHandler).not.toHaveBeenCalled();
      expect(narrativeSearchHandler).not.toHaveBeenCalled();
    });

    it("should only call background handler when types is ['background']", async () => {
      mockBackgroundSuccess([]);

      await searchUnifiedHandler({ query: "test", types: ["background"] });

      expect(layoutSearchHandler).not.toHaveBeenCalled();
      expect(partSearchHandler).not.toHaveBeenCalled();
      expect(motionSearchHandler).not.toHaveBeenCalled();
      expect(backgroundSearchHandler).toHaveBeenCalledTimes(1);
      expect(narrativeSearchHandler).not.toHaveBeenCalled();
    });

    it("should only call narrative handler when types is ['narrative']", async () => {
      mockNarrativeSuccess([]);

      await searchUnifiedHandler({ query: "test", types: ["narrative"] });

      expect(layoutSearchHandler).not.toHaveBeenCalled();
      expect(partSearchHandler).not.toHaveBeenCalled();
      expect(motionSearchHandler).not.toHaveBeenCalled();
      expect(backgroundSearchHandler).not.toHaveBeenCalled();
      expect(narrativeSearchHandler).toHaveBeenCalledTimes(1);
    });

    it("should call layout and part handlers when types is ['layout', 'part']", async () => {
      mockLayoutSuccess([]);
      mockPartSuccess([]);

      await searchUnifiedHandler({ query: "test", types: ["layout", "part"] });

      expect(layoutSearchHandler).toHaveBeenCalledTimes(1);
      expect(partSearchHandler).toHaveBeenCalledTimes(1);
      expect(motionSearchHandler).not.toHaveBeenCalled();
      expect(backgroundSearchHandler).not.toHaveBeenCalled();
      expect(narrativeSearchHandler).not.toHaveBeenCalled();
    });

    it("should execute searches in parallel (not sequentially)", async () => {
      const callOrder: string[] = [];

      vi.mocked(layoutSearchHandler).mockImplementation(async () => {
        callOrder.push("layout-start");
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push("layout-end");
        return {
          success: true,
          data: {
            results: [],
            total: 0,
            query: "test",
            searchTimeMs: 10,
            breakdown: { vector: 0, fulltext: 0 },
          },
        } as unknown as Awaited<ReturnType<typeof layoutSearchHandler>>;
      });

      vi.mocked(partSearchHandler).mockImplementation(async () => {
        callOrder.push("part-start");
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push("part-end");
        return {
          success: true,
          data: { results: [], total: 0, query: "test", searchTimeMs: 10 },
        } as unknown as Awaited<ReturnType<typeof partSearchHandler>>;
      });

      vi.mocked(motionSearchHandler).mockImplementation(async () => {
        callOrder.push("motion-start");
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push("motion-end");
        return {
          success: true,
          data: { results: [], total: 0, query: "test", searchTimeMs: 10 },
        } as unknown as Awaited<ReturnType<typeof motionSearchHandler>>;
      });

      vi.mocked(backgroundSearchHandler).mockImplementation(async () => {
        callOrder.push("background-start");
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push("background-end");
        return {
          success: true,
          data: { results: [], total: 0, query: "test", searchTimeMs: 10 },
        } as unknown as Awaited<ReturnType<typeof backgroundSearchHandler>>;
      });

      vi.mocked(narrativeSearchHandler).mockImplementation(async () => {
        callOrder.push("narrative-start");
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push("narrative-end");
        return {
          success: true,
          data: {
            results: [],
            searchInfo: { query: "test", searchMode: "hybrid", totalResults: 0, searchTimeMs: 10 },
          },
        } as unknown as Awaited<ReturnType<typeof narrativeSearchHandler>>;
      });

      await searchUnifiedHandler({ query: "test" });

      // All starts should occur before any ends (parallel)
      const startIndices = callOrder
        .map((c, i) => (c.endsWith("-start") ? i : -1))
        .filter((i) => i >= 0);
      const endIndices = callOrder
        .map((c, i) => (c.endsWith("-end") ? i : -1))
        .filter((i) => i >= 0);

      const maxStartIndex = Math.max(...startIndices);
      const minEndIndex = Math.min(...endIndices);

      // In parallel execution, all starts happen before first end
      expect(maxStartIndex).toBeLessThan(minEndIndex);
    });
  });

  // =================================================
  // 3. Result merging by similarity score desc
  // =================================================

  describe("result merging and sorting", () => {
    it("should merge results from all sources sorted by similarity desc", async () => {
      mockLayoutSuccess([{ id: "layout-1", similarity: 0.8 }]);
      mockPartSuccess([{ id: "part-1", similarity: 0.95 }]);
      mockMotionSuccess([{ similarity: 0.6, pageId: "motion-1" }]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.results).toHaveLength(3);
      expect(result.data.results[0].type).toBe("part");
      expect(result.data.results[0].similarity).toBe(0.95);
      expect(result.data.results[1].type).toBe("layout");
      expect(result.data.results[1].similarity).toBe(0.8);
      expect(result.data.results[2].type).toBe("motion");
      expect(result.data.results[2].similarity).toBe(0.6);
    });

    it("should apply limit to merged results", async () => {
      mockLayoutSuccess([
        { id: "l-1", similarity: 0.9 },
        { id: "l-2", similarity: 0.85 },
      ]);
      mockPartSuccess([
        { id: "p-1", similarity: 0.95 },
        { id: "p-2", similarity: 0.7 },
      ]);
      mockMotionSuccess([{ similarity: 0.88, pageId: "m-1" }]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
        limit: 3,
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.results).toHaveLength(3);
      // Top 3 by similarity: part(0.95), layout(0.9), motion(0.88)
      expect(result.data.results[0].similarity).toBe(0.95);
      expect(result.data.results[1].similarity).toBe(0.9);
      expect(result.data.results[2].similarity).toBe(0.88);
    });

    it("should include correct breakdown counts", async () => {
      mockLayoutSuccess([
        { id: "l-1", similarity: 0.9 },
        { id: "l-2", similarity: 0.7 },
      ]);
      mockPartSuccess([{ id: "p-1", similarity: 0.8 }]);
      mockMotionSuccess([
        { similarity: 0.85, pageId: "m-1" },
        { similarity: 0.6, pageId: "m-2" },
      ]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.breakdown.layout).toBe(2);
      expect(result.data.breakdown.part).toBe(1);
      expect(result.data.breakdown.motion).toBe(2);
    });

    it("should return total matching the truncated result count", async () => {
      mockLayoutSuccess([
        { id: "l-1", similarity: 0.9 },
        { id: "l-2", similarity: 0.8 },
        { id: "l-3", similarity: 0.7 },
      ]);
      mockPartSuccess([
        { id: "p-1", similarity: 0.85 },
        { id: "p-2", similarity: 0.75 },
      ]);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
        limit: 3,
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.total).toBe(3);
      expect(result.data.results).toHaveLength(3);
    });

    it("should return empty results when all searches return empty", async () => {
      mockAllEmpty();

      const result = (await searchUnifiedHandler({
        query: "nonexistent",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.results).toHaveLength(0);
      expect(result.data.total).toBe(0);
      expect(result.data.breakdown).toEqual({
        layout: 0,
        part: 0,
        motion: 0,
        background: 0,
        narrative: 0,
      });
    });

    it("should include query in the response", async () => {
      mockAllEmpty();

      const result = (await searchUnifiedHandler({
        query: "specific query text",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.query).toBe("specific query text");
    });

    it("should include searchTimeMs in the response", async () => {
      mockAllEmpty();

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.searchTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should correctly map layout result metadata", async () => {
      mockLayoutSuccess([
        {
          id: "l-1",
          similarity: 0.9,
          sectionType: "pricing",
          webPageUrl: "https://example.com/pricing",
        },
      ]);
      mockPartSuccess([]);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      const item = result.data.results[0];
      expect(item.type).toBe("layout");
      expect(item.id).toBe("l-1");
      expect(item.metadata.sectionType).toBe("pricing");
      expect(item.metadata.webPageUrl).toBe("https://example.com/pricing");
    });

    it("should correctly map part result metadata", async () => {
      mockLayoutSuccess([]);
      mockPartSuccess([
        { id: "p-1", similarity: 0.8, partType: "navigation", webPageUrl: "https://example.com" },
      ]);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      const item = result.data.results[0];
      expect(item.type).toBe("part");
      expect(item.id).toBe("p-1");
      expect(item.metadata.partType).toBe("navigation");
    });

    it("should correctly map motion result metadata", async () => {
      mockLayoutSuccess([]);
      mockPartSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);
      mockMotionSuccess([
        {
          similarity: 0.75,
          patternName: "slide-up",
          patternType: "css",
          pageId: "page-42",
          url: "https://example.com/animated",
        },
      ]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      const item = result.data.results[0];
      expect(item.type).toBe("motion");
      expect(item.id).toBe("page-42");
      expect(item.metadata.patternName).toBe("slide-up");
      expect(item.metadata.patternType).toBe("css");
      expect(item.metadata.sourceUrl).toBe("https://example.com/animated");
    });

    it("should use fallback id for motion results without pageId", async () => {
      mockLayoutSuccess([]);
      mockPartSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);
      vi.mocked(motionSearchHandler).mockResolvedValue({
        success: true,
        data: {
          results: [
            {
              pattern: { name: "fade", type: "css" },
              similarity: 0.7,
              source: { url: "https://example.com" },
            },
          ],
          total: 1,
          query: "test",
          searchTimeMs: 10,
        },
      } as unknown as Awaited<ReturnType<typeof motionSearchHandler>>);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.results[0].id).toBe("motion-0");
    });
  });

  // =================================================
  // 4. Graceful degradation on individual search failure
  // =================================================

  describe("graceful degradation", () => {
    it("should return partial results AND surface degradedServices when layout search rejects", async () => {
      vi.mocked(layoutSearchHandler).mockRejectedValue(new Error("Layout DB timeout"));
      mockPartSuccess([{ id: "p-1", similarity: 0.9 }]);
      mockMotionSuccess([{ similarity: 0.7, pageId: "m-1" }]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.results).toHaveLength(2);
      expect(result.data.breakdown.layout).toBe(0);
      expect(result.data.breakdown.part).toBe(1);
      expect(result.data.breakdown.motion).toBe(1);
      // ADR-0043 Decision 2: rejecting leaf は silent drop されず degraded marker で surface。
      expect(result.data.degradedServices).toEqual([
        { service: "layout", reason: "embedding_failed" },
      ]);
    });

    it("should return partial results when part search fails", async () => {
      mockLayoutSuccess([{ id: "l-1", similarity: 0.85 }]);
      vi.mocked(partSearchHandler).mockRejectedValue(new Error("Part search error"));
      mockMotionSuccess([{ similarity: 0.65, pageId: "m-1" }]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.results).toHaveLength(2);
      expect(result.data.breakdown.layout).toBe(1);
      expect(result.data.breakdown.part).toBe(0);
      expect(result.data.breakdown.motion).toBe(1);
    });

    it("should return partial results when motion search fails", async () => {
      mockLayoutSuccess([{ id: "l-1", similarity: 0.8 }]);
      mockPartSuccess([{ id: "p-1", similarity: 0.75 }]);
      vi.mocked(motionSearchHandler).mockRejectedValue(new Error("Motion error"));
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.results).toHaveLength(2);
      expect(result.data.breakdown.layout).toBe(1);
      expect(result.data.breakdown.part).toBe(1);
      expect(result.data.breakdown.motion).toBe(0);
    });

    // ADR-0043 Decision 2 / plan v4 §4.4: 全 service が degraded (embedding_failed) で
    // 全滅した場合は **success:false** (旧: success:true total:0 の fake-empty を撤去)。
    // silent degradation 排除 (feedback_no_fake_success)。
    it("should return success:false when all embedding-required services are degraded", async () => {
      vi.mocked(layoutSearchHandler).mockRejectedValue(new Error("Layout fail"));
      vi.mocked(partSearchHandler).mockRejectedValue(new Error("Part fail"));
      vi.mocked(motionSearchHandler).mockRejectedValue(new Error("Motion fail"));
      vi.mocked(backgroundSearchHandler).mockRejectedValue(new Error("Background fail"));
      vi.mocked(narrativeSearchHandler).mockRejectedValue(new Error("Narrative fail"));

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      // 全滅 → success:false (空 success:true で誤魔化さない)
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe(UNIFIED_SEARCH_ERROR_CODES.SEARCH_FAILED);
    });

    it("should surface layout success:false (with degradedReason) as a degraded marker", async () => {
      // layout は error.degradedReason を carry する → aggregator はそれを使う。
      vi.mocked(layoutSearchHandler).mockResolvedValue({
        success: false,
        error: {
          code: "EMBEDDING_FAILED",
          message: "Query embedding generation failed",
          degradedReason: "embedding_failed",
        },
      } as unknown as Awaited<ReturnType<typeof layoutSearchHandler>>);
      mockPartSuccess([{ id: "p-1", similarity: 0.8 }]);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.breakdown.layout).toBe(0);
      expect(result.data.breakdown.part).toBe(1);
      expect(result.data.degradedServices).toEqual([
        { service: "layout", reason: "embedding_failed" },
      ]);
    });

    it("should surface layout success:false (unavailable) as embedding_unavailable degraded marker", async () => {
      vi.mocked(layoutSearchHandler).mockResolvedValue({
        success: false,
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Query embedding service is unavailable",
          degradedReason: "embedding_unavailable",
        },
      } as unknown as Awaited<ReturnType<typeof layoutSearchHandler>>);
      mockPartSuccess([{ id: "p-1", similarity: 0.8 }]);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.degradedServices).toEqual([
        { service: "layout", reason: "embedding_unavailable" },
      ]);
    });

    it("should surface part success:false as a degraded marker", async () => {
      mockLayoutSuccess([{ id: "l-1", similarity: 0.7 }]);
      vi.mocked(partSearchHandler).mockResolvedValue({
        success: false,
        error: {
          code: "EMBEDDING_FAILED",
          message: "Query embedding generation failed",
          degradedReason: "embedding_failed",
        },
      } as unknown as Awaited<ReturnType<typeof partSearchHandler>>);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.breakdown.layout).toBe(1);
      expect(result.data.breakdown.part).toBe(0);
      expect(result.data.degradedServices).toEqual([
        { service: "part", reason: "embedding_failed" },
      ]);
    });

    // TPA-IMPL-02 forward-coupling: motion tool は degradedReason を carry しない。
    // aggregator は error.code から推論する (EMBEDDING_ERROR → embedding_failed)。
    it("should infer motion degradedReason from error.code (EMBEDDING_ERROR, no degradedReason carried)", async () => {
      mockLayoutSuccess([]);
      mockPartSuccess([{ id: "p-1", similarity: 0.9 }]);
      vi.mocked(motionSearchHandler).mockResolvedValue({
        success: false,
        // motion error は degradedReason を持たない (TPA-IMPL-02)
        error: { code: "EMBEDDING_ERROR", message: "Query embedding generation failed" },
      } as unknown as Awaited<ReturnType<typeof motionSearchHandler>>);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.breakdown.motion).toBe(0);
      expect(result.data.breakdown.part).toBe(1);
      // code から embedding_failed を推論 (motion tool/service 非 touch で granularity 取得)
      expect(result.data.degradedServices).toEqual([
        { service: "motion", reason: "embedding_failed" },
      ]);
    });

    it("should infer motion embedding_unavailable from SERVICE_UNAVAILABLE code", async () => {
      mockLayoutSuccess([{ id: "l-1", similarity: 0.7 }]);
      mockPartSuccess([]);
      vi.mocked(motionSearchHandler).mockResolvedValue({
        success: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "Motion search service is not available" },
      } as unknown as Awaited<ReturnType<typeof motionSearchHandler>>);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.degradedServices).toEqual([
        { service: "motion", reason: "embedding_unavailable" },
      ]);
    });

    // legitimate empty 非退行: embedding 成功・0 件は degraded でない (degradedServices に出ない)。
    it("should NOT mark legitimate empty (success:true total:0) as degraded", async () => {
      mockLayoutSuccess([{ id: "l-1", similarity: 0.8 }]);
      mockPartSuccess([]); // 正当な空 (embedding ok + 0 件)
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;
      // 正当な空は degraded でない → degradedServices は省略 (undefined)
      expect(result.data.degradedServices).toBeUndefined();
    });
  });

  // =================================================
  // 5. Input validation error handling
  // =================================================

  describe("input validation error handling", () => {
    it("should return VALIDATION_ERROR for invalid input", async () => {
      const result = (await searchUnifiedHandler({})) as SearchUnifiedOutput;

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error.code).toBe(UNIFIED_SEARCH_ERROR_CODES.VALIDATION_ERROR);
      expect(result.error.message).toBe("Validation error");
    });

    it("should return VALIDATION_ERROR for null input", async () => {
      const result = (await searchUnifiedHandler(null)) as SearchUnifiedOutput;

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error.code).toBe(UNIFIED_SEARCH_ERROR_CODES.VALIDATION_ERROR);
    });

    it("should return VALIDATION_ERROR for non-object input", async () => {
      const result = (await searchUnifiedHandler("not an object")) as SearchUnifiedOutput;

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error.code).toBe(UNIFIED_SEARCH_ERROR_CODES.VALIDATION_ERROR);
    });
  });

  // =================================================
  // 6. Tool definition
  // =================================================

  describe("tool definition", () => {
    it("should have correct tool name", () => {
      expect(searchUnifiedToolDefinition.name).toBe("search.unified");
    });

    it("should have query as required field", () => {
      expect(searchUnifiedToolDefinition.inputSchema.required).toContain("query");
    });

    it("should have readOnlyHint annotation set to true", () => {
      expect(searchUnifiedToolDefinition.annotations.readOnlyHint).toBe(true);
    });

    it("should have idempotentHint annotation set to true", () => {
      expect(searchUnifiedToolDefinition.annotations.idempotentHint).toBe(true);
    });
  });

  // =================================================
  // 7. Error codes
  // =================================================

  describe("error codes", () => {
    it("should define VALIDATION_ERROR code", () => {
      expect(UNIFIED_SEARCH_ERROR_CODES.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
    });

    it("should define SEARCH_FAILED code", () => {
      expect(UNIFIED_SEARCH_ERROR_CODES.SEARCH_FAILED).toBe("SEARCH_FAILED");
    });

    it("should define INTERNAL_ERROR code", () => {
      expect(UNIFIED_SEARCH_ERROR_CODES.INTERNAL_ERROR).toBe("INTERNAL_ERROR");
    });
  });

  // =================================================
  // 8. Background search integration
  // =================================================

  describe("background search integration", () => {
    it("should pass correct params to backgroundSearchHandler", async () => {
      mockAllEmpty();

      await searchUnifiedHandler({
        query: "gradient background",
        limit: 15,
        webPageId: VALID_UUID,
        profile_id: VALID_UUID,
      });

      expect(backgroundSearchHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: "gradient background",
          limit: 15,
          offset: 0,
          filters: { webPageId: VALID_UUID },
          profile_id: VALID_UUID,
        })
      );
    });

    it("should correctly map background result metadata", async () => {
      mockLayoutSuccess([]);
      mockPartSuccess([]);
      mockMotionSuccess([]);
      mockNarrativeSuccess([]);
      mockBackgroundSuccess([
        {
          id: "bg-1",
          similarity: 0.82,
          designType: "glassmorphism",
          webPageId: "wp-42",
          name: "frosted-glass-bg",
        },
      ]);

      const result = (await searchUnifiedHandler({
        query: "glassmorphism",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      const item = result.data.results[0];
      expect(item.type).toBe("background");
      expect(item.id).toBe("bg-1");
      expect(item.similarity).toBe(0.82);
      expect(item.metadata.designType).toBe("glassmorphism");
      expect(item.metadata.name).toBe("frosted-glass-bg");
    });

    it("should include background count in breakdown", async () => {
      mockLayoutSuccess([]);
      mockPartSuccess([]);
      mockMotionSuccess([]);
      mockNarrativeSuccess([]);
      mockBackgroundSuccess([
        { id: "bg-1", similarity: 0.9 },
        { id: "bg-2", similarity: 0.7 },
      ]);

      const result = (await searchUnifiedHandler({
        query: "gradient",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.breakdown.background).toBe(2);
    });

    it("should return partial results when background search fails", async () => {
      mockLayoutSuccess([{ id: "l-1", similarity: 0.8 }]);
      mockPartSuccess([]);
      mockMotionSuccess([]);
      mockNarrativeSuccess([]);
      vi.mocked(backgroundSearchHandler).mockRejectedValue(new Error("Background DB error"));

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.breakdown.background).toBe(0);
      expect(result.data.breakdown.layout).toBe(1);
    });

    it("should handle background returning success: false gracefully", async () => {
      mockLayoutSuccess([]);
      mockPartSuccess([{ id: "p-1", similarity: 0.8 }]);
      mockMotionSuccess([]);
      mockNarrativeSuccess([]);
      vi.mocked(backgroundSearchHandler).mockResolvedValue({
        success: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "Background search unavailable" },
      } as unknown as Awaited<ReturnType<typeof backgroundSearchHandler>>);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.breakdown.background).toBe(0);
      expect(result.data.breakdown.part).toBe(1);
    });
  });

  // =================================================
  // 9. Narrative search integration
  // =================================================

  describe("narrative search integration", () => {
    it("should pass correct params to narrativeSearchHandler", async () => {
      mockAllEmpty();

      await searchUnifiedHandler({
        query: "dark cyber design",
        limit: 20,
        profile_id: VALID_UUID,
      });

      expect(narrativeSearchHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: "dark cyber design",
          options: { limit: 20 },
          profile_id: VALID_UUID,
        })
      );
    });

    it("should correctly map narrative result metadata", async () => {
      mockLayoutSuccess([]);
      mockPartSuccess([]);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([
        {
          id: "nar-1",
          similarity: 0.88,
          webPageId: "wp-99",
          sourceUrl: "https://example.com/cyber",
          moodCategory: "tech",
          moodDescription: "Futuristic dark cyber aesthetic",
        },
      ]);

      const result = (await searchUnifiedHandler({
        query: "cyber design",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      const item = result.data.results[0];
      expect(item.type).toBe("narrative");
      expect(item.id).toBe("nar-1");
      expect(item.similarity).toBe(0.88);
      expect(item.metadata.webPageId).toBe("wp-99");
      expect(item.metadata.sourceUrl).toBe("https://example.com/cyber");
      expect(item.metadata.moodCategory).toBe("tech");
      expect(item.metadata.moodDescription).toBe("Futuristic dark cyber aesthetic");
    });

    it("should include narrative count in breakdown", async () => {
      mockLayoutSuccess([]);
      mockPartSuccess([]);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([
        { id: "nar-1", similarity: 0.9 },
        { id: "nar-2", similarity: 0.85 },
        { id: "nar-3", similarity: 0.7 },
      ]);

      const result = (await searchUnifiedHandler({
        query: "professional",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.breakdown.narrative).toBe(3);
    });

    it("should return partial results when narrative search fails", async () => {
      mockLayoutSuccess([]);
      mockPartSuccess([{ id: "p-1", similarity: 0.75 }]);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      vi.mocked(narrativeSearchHandler).mockRejectedValue(new Error("Narrative service error"));

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.breakdown.narrative).toBe(0);
      expect(result.data.breakdown.part).toBe(1);
    });

    it("should handle narrative returning success: false gracefully", async () => {
      mockLayoutSuccess([]);
      mockPartSuccess([]);
      mockMotionSuccess([{ similarity: 0.7, pageId: "m-1" }]);
      mockBackgroundSuccess([]);
      vi.mocked(narrativeSearchHandler).mockResolvedValue({
        success: false,
        error: { code: "SEARCH_FAILED", message: "Narrative search failed" },
      } as unknown as Awaited<ReturnType<typeof narrativeSearchHandler>>);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.breakdown.narrative).toBe(0);
      expect(result.data.breakdown.motion).toBe(1);
    });

    it("should merge results from all 5 sources sorted by similarity desc", async () => {
      mockLayoutSuccess([{ id: "l-1", similarity: 0.7 }]);
      mockPartSuccess([{ id: "p-1", similarity: 0.95 }]);
      mockMotionSuccess([{ similarity: 0.6, pageId: "m-1" }]);
      mockBackgroundSuccess([{ id: "bg-1", similarity: 0.85 }]);
      mockNarrativeSuccess([{ id: "nar-1", similarity: 0.78 }]);

      const result = (await searchUnifiedHandler({
        query: "test",
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.results).toHaveLength(5);
      // Expected order: part(0.95), background(0.85), narrative(0.78), layout(0.7), motion(0.6)
      expect(result.data.results[0].type).toBe("part");
      expect(result.data.results[0].similarity).toBe(0.95);
      expect(result.data.results[1].type).toBe("background");
      expect(result.data.results[1].similarity).toBe(0.85);
      expect(result.data.results[2].type).toBe("narrative");
      expect(result.data.results[2].similarity).toBe(0.78);
      expect(result.data.results[3].type).toBe("layout");
      expect(result.data.results[3].similarity).toBe(0.7);
      expect(result.data.results[4].type).toBe("motion");
      expect(result.data.results[4].similarity).toBe(0.6);

      expect(result.data.breakdown).toEqual({
        layout: 1,
        part: 1,
        motion: 1,
        background: 1,
        narrative: 1,
      });
    });
  });

  // =================================================
  // 10. facet_fields parameter support
  // =================================================

  describe("facet_fields parameter support", () => {
    it("should return only specified facet fields when facet_fields is provided with include_facets: true", async () => {
      mockLayoutSuccess([
        { id: "l-1", similarity: 0.9, sectionType: "hero" },
        { id: "l-2", similarity: 0.8, sectionType: "footer" },
      ]);
      mockPartSuccess([]);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
        include_facets: true,
        facet_fields: ["sectionType"],
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.facets).toBeDefined();
      // computeFacetsFromResults should be called with only ["sectionType"]
      expect(computeFacetsFromResults).toHaveBeenCalledWith(expect.any(Array), ["sectionType"]);
    });

    it("should return all 4 facet fields when include_facets: true and facet_fields is not specified", async () => {
      mockLayoutSuccess([{ id: "l-1", similarity: 0.9, sectionType: "hero" }]);
      mockPartSuccess([]);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
        include_facets: true,
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.facets).toBeDefined();
      // Should use all supported fields
      expect(computeFacetsFromResults).toHaveBeenCalledWith(expect.any(Array), [
        "sectionType",
        "industry",
        "audience",
        "tags",
      ]);
    });

    it("should implicitly enable include_facets when facet_fields is specified", async () => {
      mockLayoutSuccess([{ id: "l-1", similarity: 0.9, sectionType: "hero" }]);
      mockPartSuccess([]);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      // facet_fields specified but include_facets not explicitly set
      const result = (await searchUnifiedHandler({
        query: "test",
        facet_fields: ["sectionType", "industry"],
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      // facets should be computed even though include_facets was not explicitly set to true
      expect(result.data.facets).toBeDefined();
      expect(computeFacetsFromResults).toHaveBeenCalledWith(expect.any(Array), [
        "sectionType",
        "industry",
      ]);
    });

    it("should reject invalid facet_fields values via Zod", () => {
      expect(() =>
        searchUnifiedInputSchema.parse({
          query: "test",
          facet_fields: ["invalidField"],
        })
      ).toThrow();
    });

    it("should reject empty facet_fields array via Zod (min(1))", () => {
      expect(() =>
        searchUnifiedInputSchema.parse({
          query: "test",
          facet_fields: [],
        })
      ).toThrow();
    });

    it("should compute facets from all results before limit is applied", async () => {
      // Setup: 5 results but limit=2
      mockLayoutSuccess([
        { id: "l-1", similarity: 0.95, sectionType: "hero" },
        { id: "l-2", similarity: 0.9, sectionType: "footer" },
        { id: "l-3", similarity: 0.85, sectionType: "pricing" },
      ]);
      mockPartSuccess([
        { id: "p-1", similarity: 0.88, partType: "button" },
        { id: "p-2", similarity: 0.7, partType: "navigation" },
      ]);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
        limit: 2,
        include_facets: true,
        facet_fields: ["sectionType"],
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Only 2 results returned after limit
      expect(result.data.results).toHaveLength(2);

      // But facets should be computed from ALL 5 results (before limit)
      // computeFacetsFromResults should be called with array of length 5
      expect(computeFacetsFromResults).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: "l-1" }),
          expect.objectContaining({ id: "l-2" }),
          expect.objectContaining({ id: "l-3" }),
          expect.objectContaining({ id: "p-1" }),
          expect.objectContaining({ id: "p-2" }),
        ]),
        ["sectionType"]
      );
    });

    it("should accept valid facet_fields values via Zod", () => {
      const result = searchUnifiedInputSchema.parse({
        query: "test",
        facet_fields: ["sectionType", "industry", "audience", "tags"],
      });
      expect(result.facet_fields).toEqual(["sectionType", "industry", "audience", "tags"]);
    });

    it("should not compute facets when include_facets is false and facet_fields is not provided", async () => {
      mockLayoutSuccess([{ id: "l-1", similarity: 0.9 }]);
      mockPartSuccess([]);
      mockMotionSuccess([]);
      mockBackgroundSuccess([]);
      mockNarrativeSuccess([]);

      const result = (await searchUnifiedHandler({
        query: "test",
        include_facets: false,
      })) as SearchUnifiedOutput;

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.facets).toBeUndefined();
      expect(computeFacetsFromResults).not.toHaveBeenCalled();
    });
  });
});
