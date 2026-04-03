// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * search.facets MCPツール ユニットテスト
 * search.facets MCP Tool Unit Tests
 *
 * TDD: Red phase — テスト先行で作成
 *
 * @module tests/tools/search-facets.tool.test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// =====================================================
// Mock dependencies
// =====================================================

vi.mock("../../src/tools/search-unified.tool", () => ({
  searchUnifiedHandler: vi.fn(),
  searchUnifiedInputSchema: {
    parse: vi.fn(),
  },
}));

vi.mock("../../src/services/facet.service", () => ({
  computeFacetsFromResults: vi.fn(),
  SUPPORTED_FACET_FIELDS: ["sectionType", "industry", "audience", "tags"],
}));

vi.mock("../../src/services/search-log.service", () => ({
  logSearch: vi.fn().mockResolvedValue(undefined),
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
    expandedQuery: query,
    queryType: "visual" as const,
    extractedFilters: {},
  })),
  classifyQueryType: vi.fn(() => "visual"),
}));

// =====================================================
// Import after mocks
// =====================================================

import {
  searchFacetsHandler,
  searchFacetsToolDefinition,
  searchFacetsInputSchema,
  SEARCH_FACETS_ERROR_CODES,
} from "../../src/tools/search/facets.tool";
import { searchUnifiedHandler } from "../../src/tools/search-unified.tool";
import { computeFacetsFromResults } from "../../src/services/facet.service";

// =====================================================
// Test Helpers
// =====================================================

function mockUnifiedSearchSuccess(
  results: Array<{
    type: string;
    id: string;
    similarity: number;
    metadata: Record<string, unknown>;
  }>
): void {
  (searchUnifiedHandler as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
    data: {
      results,
      total: results.length,
      query: "test query",
      searchTimeMs: 100,
      breakdown: { layout: 0, part: 0, motion: 0, background: 0, narrative: 0 },
    },
  });
}

// =====================================================
// Test Suites
// =====================================================

describe("search.facets Tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =====================================================
  // Tool Definition
  // =====================================================

  describe("Tool Definition", () => {
    it("ツール名が search.facets である / Tool name is search.facets", () => {
      expect(searchFacetsToolDefinition.name).toBe("search.facets");
    });

    it("descriptionが設定されている / Has description", () => {
      expect(searchFacetsToolDefinition.description).toBeDefined();
      expect(searchFacetsToolDefinition.description.length).toBeGreaterThan(0);
    });

    it("inputSchemaがobject型である / Input schema is object type", () => {
      expect(searchFacetsToolDefinition.inputSchema.type).toBe("object");
    });

    it("queryが必須フィールドである / query is required field", () => {
      expect(searchFacetsToolDefinition.inputSchema.required).toContain("query");
    });

    it("annotations が設定されている / Has annotations", () => {
      expect(searchFacetsToolDefinition.annotations).toBeDefined();
      expect(searchFacetsToolDefinition.annotations?.readOnlyHint).toBe(true);
    });
  });

  // =====================================================
  // Input Validation
  // =====================================================

  describe("Input Validation", () => {
    it("空のクエリを拒否する / Rejects empty query", async () => {
      const result = await searchFacetsHandler({ query: "" });

      expect(result).toMatchObject({
        success: false,
        error: { code: SEARCH_FACETS_ERROR_CODES.VALIDATION_ERROR },
      });
    });

    it("500文字超のクエリを拒否する / Rejects query over 500 chars", async () => {
      const result = await searchFacetsHandler({ query: "a".repeat(501) });

      expect(result).toMatchObject({
        success: false,
        error: { code: SEARCH_FACETS_ERROR_CODES.VALIDATION_ERROR },
      });
    });

    it("有効なクエリを受け入れる / Accepts valid query", async () => {
      mockUnifiedSearchSuccess([]);
      (computeFacetsFromResults as ReturnType<typeof vi.fn>).mockReturnValue({});

      const result = await searchFacetsHandler({ query: "hero section" });

      expect(result).toMatchObject({ success: true });
    });

    it("facet_fieldsパラメータを受け入れる / Accepts facet_fields parameter", async () => {
      mockUnifiedSearchSuccess([]);
      (computeFacetsFromResults as ReturnType<typeof vi.fn>).mockReturnValue({
        sectionType: [],
      });

      const result = await searchFacetsHandler({
        query: "hero section",
        facet_fields: ["sectionType"],
      });

      expect(result).toMatchObject({ success: true });
    });

    it("不正なfacet_fieldsを拒否する / Rejects invalid facet_fields", async () => {
      const result = await searchFacetsHandler({
        query: "hero",
        facet_fields: ["invalid_field"],
      });

      expect(result).toMatchObject({
        success: false,
        error: { code: SEARCH_FACETS_ERROR_CODES.VALIDATION_ERROR },
      });
    });
  });

  // =====================================================
  // Facet Computation
  // =====================================================

  describe("Facet Computation", () => {
    it("search.unifiedの結果からファセットを計算する / Computes facets from unified search results", async () => {
      const mockResults = [
        { type: "layout", id: "1", similarity: 0.9, metadata: { sectionType: "hero" } },
        { type: "layout", id: "2", similarity: 0.8, metadata: { sectionType: "footer" } },
      ];

      mockUnifiedSearchSuccess(mockResults);
      (computeFacetsFromResults as ReturnType<typeof vi.fn>).mockReturnValue({
        sectionType: [
          { value: "hero", count: 1 },
          { value: "footer", count: 1 },
        ],
      });

      const result = await searchFacetsHandler({ query: "hero section" });

      expect(result).toMatchObject({
        success: true,
        data: {
          facets: {
            sectionType: [
              { value: "hero", count: 1 },
              { value: "footer", count: 1 },
            ],
          },
        },
      });
    });

    it("query_typeをレスポンスに含む / Includes query_type in response", async () => {
      mockUnifiedSearchSuccess([]);
      (computeFacetsFromResults as ReturnType<typeof vi.fn>).mockReturnValue({});

      const result = await searchFacetsHandler({ query: "dark gradient theme" });

      expect(result).toMatchObject({
        success: true,
        data: expect.objectContaining({
          query_type: expect.any(String),
        }),
      });
    });

    it("limitパラメータを尊重する / Respects limit parameter", async () => {
      mockUnifiedSearchSuccess([]);
      (computeFacetsFromResults as ReturnType<typeof vi.fn>).mockReturnValue({});

      await searchFacetsHandler({
        query: "hero section",
        limit: 5,
      });

      expect(searchUnifiedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 5,
        })
      );
    });

    it("デフォルトlimitは50 / Default limit is 50", async () => {
      mockUnifiedSearchSuccess([]);
      (computeFacetsFromResults as ReturnType<typeof vi.fn>).mockReturnValue({});

      await searchFacetsHandler({ query: "hero section" });

      expect(searchUnifiedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 50,
        })
      );
    });
  });

  // =====================================================
  // Error Handling
  // =====================================================

  describe("Error Handling", () => {
    it("search.unified失敗時にエラーを返す / Returns error on unified search failure", async () => {
      (searchUnifiedHandler as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: { code: "SEARCH_FAILED", message: "Search failed" },
      });

      const result = await searchFacetsHandler({ query: "hero section" });

      expect(result).toMatchObject({
        success: false,
        error: { code: SEARCH_FACETS_ERROR_CODES.SEARCH_FAILED },
      });
    });

    it("予期せぬ例外時にINTERNAL_ERRORを返す / Returns INTERNAL_ERROR on unexpected exception", async () => {
      (searchUnifiedHandler as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Unexpected error")
      );

      const result = await searchFacetsHandler({ query: "hero section" });

      expect(result).toMatchObject({
        success: false,
        error: { code: SEARCH_FACETS_ERROR_CODES.INTERNAL_ERROR },
      });
    });
  });

  // =====================================================
  // Zod Schema
  // =====================================================

  describe("Zod Schema", () => {
    it("最小有効入力をパースする / Parses minimal valid input", () => {
      const result = searchFacetsInputSchema.safeParse({ query: "hero" });
      expect(result.success).toBe(true);
    });

    it("全パラメータ指定の入力をパースする / Parses full input", () => {
      const result = searchFacetsInputSchema.safeParse({
        query: "hero section",
        facet_fields: ["sectionType", "industry"],
        limit: 20,
      });
      expect(result.success).toBe(true);
    });

    it("空クエリを拒否する / Rejects empty query", () => {
      const result = searchFacetsInputSchema.safeParse({ query: "" });
      expect(result.success).toBe(false);
    });

    it("不正なfacet_fieldを拒否する / Rejects invalid facet field", () => {
      const result = searchFacetsInputSchema.safeParse({
        query: "test",
        facet_fields: ["invalid"],
      });
      expect(result.success).toBe(false);
    });
  });

  // =====================================================
  // Deprecation Warning (Step 2)
  // =====================================================

  describe("Deprecation Warning", () => {
    it("レスポンスに _deprecation フィールドが含まれる / Response includes _deprecation field", async () => {
      mockUnifiedSearchSuccess([]);
      (computeFacetsFromResults as ReturnType<typeof vi.fn>).mockReturnValue({});

      const result = await searchFacetsHandler({ query: "hero section" });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect((result.data as Record<string, unknown>)._deprecation).toBeDefined();
    });

    it("_deprecation.message に search.unified への移行指示が含まれる / _deprecation.message contains migration instruction to search.unified", async () => {
      mockUnifiedSearchSuccess([]);
      (computeFacetsFromResults as ReturnType<typeof vi.fn>).mockReturnValue({});

      const result = await searchFacetsHandler({ query: "hero section" });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const deprecation = (result.data as Record<string, unknown>)._deprecation as Record<
        string,
        unknown
      >;
      expect(deprecation.message).toBeDefined();
      expect(typeof deprecation.message).toBe("string");
      expect((deprecation.message as string).toLowerCase()).toContain("search.unified");
    });

    it("_deprecation.removal_version が v0.4.0 である / _deprecation.removal_version is v0.4.0", async () => {
      mockUnifiedSearchSuccess([]);
      (computeFacetsFromResults as ReturnType<typeof vi.fn>).mockReturnValue({});

      const result = await searchFacetsHandler({ query: "hero section" });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const deprecation = (result.data as Record<string, unknown>)._deprecation as Record<
        string,
        unknown
      >;
      expect(deprecation.removal_version).toBe("v0.4.0");
    });
  });

  // =====================================================
  // Tool Definition - Deprecation Markers (Step 2)
  // =====================================================

  describe("Tool Definition - Deprecation Markers", () => {
    it("description 冒頭に DEPRECATED マーカーが含まれる / description starts with DEPRECATED marker", () => {
      expect(searchFacetsToolDefinition.description).toMatch(/^\[DEPRECATED/);
    });

    it("annotations に deprecated: true が設定されている / annotations include deprecated: true", () => {
      expect(searchFacetsToolDefinition.annotations?.deprecated).toBe(true);
    });
  });
});
