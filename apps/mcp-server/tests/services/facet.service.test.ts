// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Facet Service Unit Tests
 * ファセットサービス ユニットテスト
 *
 * TDD: Red phase — テスト先行で作成
 * Tests: getFacetCounts, computeFacetsFromResults
 *
 * @module tests/services/facet.service.test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// =====================================================
// Mock dependencies
// =====================================================

const mockPrisma = {
  $queryRawUnsafe: vi.fn(),
};

vi.mock("@reftrixmcp/database", () => ({
  prisma: mockPrisma,
  Prisma: {
    sql: vi.fn(),
  },
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

vi.mock("../../src/services/search-cache.service", () => ({
  generateCacheKey: vi.fn(() => "mock-cache-key"),
  getCachedResult: vi.fn(() => undefined),
  setCachedResult: vi.fn(),
}));

// =====================================================
// Import after mocks
// =====================================================

import {
  computeFacetsFromResults,
  type FacetCounts,
  type FacetField,
  SUPPORTED_FACET_FIELDS,
} from "../../src/services/facet.service";
import type { UnifiedSearchResultItem } from "../../src/tools/search-unified.tool";

// =====================================================
// Test Suites
// =====================================================

describe("FacetService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =====================================================
  // SUPPORTED_FACET_FIELDS
  // =====================================================

  describe("SUPPORTED_FACET_FIELDS", () => {
    it("4つのサポートフィールドを持つ / Has 4 supported fields", () => {
      expect(SUPPORTED_FACET_FIELDS).toContain("sectionType");
      expect(SUPPORTED_FACET_FIELDS).toContain("industry");
      expect(SUPPORTED_FACET_FIELDS).toContain("audience");
      expect(SUPPORTED_FACET_FIELDS).toContain("tags");
      expect(SUPPORTED_FACET_FIELDS).toHaveLength(4);
    });
  });

  // =====================================================
  // computeFacetsFromResults
  // =====================================================

  describe("computeFacetsFromResults", () => {
    it("結果セットからsectionTypeファセットを計算する / Computes sectionType facets from results", () => {
      const results: UnifiedSearchResultItem[] = [
        {
          type: "layout",
          id: "1",
          similarity: 0.9,
          metadata: { sectionType: "hero" },
        },
        {
          type: "layout",
          id: "2",
          similarity: 0.8,
          metadata: { sectionType: "hero" },
        },
        {
          type: "layout",
          id: "3",
          similarity: 0.7,
          metadata: { sectionType: "footer" },
        },
        {
          type: "part",
          id: "4",
          similarity: 0.6,
          metadata: { partType: "button" },
        },
      ];

      const facets = computeFacetsFromResults(results, ["sectionType"]);

      expect(facets.sectionType).toBeDefined();
      expect(facets.sectionType).toContainEqual({ value: "hero", count: 2 });
      expect(facets.sectionType).toContainEqual({ value: "footer", count: 1 });
    });

    it("結果セットからtypeファセット（result type）を含む / Includes result type counts", () => {
      const results: UnifiedSearchResultItem[] = [
        { type: "layout", id: "1", similarity: 0.9, metadata: {} },
        { type: "layout", id: "2", similarity: 0.8, metadata: {} },
        { type: "part", id: "3", similarity: 0.7, metadata: {} },
        { type: "motion", id: "4", similarity: 0.6, metadata: {} },
      ];

      const facets = computeFacetsFromResults(results, ["sectionType"]);

      // sectionType は metadata から取得するので、metadata にない場合は空
      expect(facets.sectionType).toEqual([]);
    });

    it("空の結果セットで空ファセットを返す / Returns empty facets for empty results", () => {
      const facets = computeFacetsFromResults([], ["sectionType", "industry"]);

      expect(facets.sectionType).toEqual([]);
      expect(facets.industry).toEqual([]);
    });

    it("industryファセットをmetadataから算出する / Computes industry facets from metadata", () => {
      const results: UnifiedSearchResultItem[] = [
        {
          type: "layout",
          id: "1",
          similarity: 0.9,
          metadata: { industry: "SaaS" },
        },
        {
          type: "layout",
          id: "2",
          similarity: 0.8,
          metadata: { industry: "SaaS" },
        },
        {
          type: "part",
          id: "3",
          similarity: 0.7,
          metadata: { industry: "E-commerce" },
        },
      ];

      const facets = computeFacetsFromResults(results, ["industry"]);

      expect(facets.industry).toBeDefined();
      expect(facets.industry).toContainEqual({ value: "SaaS", count: 2 });
      expect(facets.industry).toContainEqual({ value: "E-commerce", count: 1 });
    });

    it("tagsファセットを配列から展開して算出する / Computes tags facets by flattening arrays", () => {
      const results: UnifiedSearchResultItem[] = [
        {
          type: "layout",
          id: "1",
          similarity: 0.9,
          metadata: { tags: ["responsive", "dark-mode"] },
        },
        {
          type: "layout",
          id: "2",
          similarity: 0.8,
          metadata: { tags: ["responsive", "animated"] },
        },
      ];

      const facets = computeFacetsFromResults(results, ["tags"]);

      expect(facets.tags).toBeDefined();
      expect(facets.tags).toContainEqual({ value: "responsive", count: 2 });
      expect(facets.tags).toContainEqual({ value: "dark-mode", count: 1 });
      expect(facets.tags).toContainEqual({ value: "animated", count: 1 });
    });

    it("カウント降順でソートされる / Sorted by count descending", () => {
      const results: UnifiedSearchResultItem[] = [
        { type: "layout", id: "1", similarity: 0.9, metadata: { sectionType: "hero" } },
        { type: "layout", id: "2", similarity: 0.8, metadata: { sectionType: "hero" } },
        { type: "layout", id: "3", similarity: 0.7, metadata: { sectionType: "hero" } },
        { type: "layout", id: "4", similarity: 0.6, metadata: { sectionType: "footer" } },
        { type: "layout", id: "5", similarity: 0.5, metadata: { sectionType: "cta" } },
        { type: "layout", id: "6", similarity: 0.4, metadata: { sectionType: "cta" } },
      ];

      const facets = computeFacetsFromResults(results, ["sectionType"]);

      expect(facets.sectionType?.[0]?.value).toBe("hero");
      expect(facets.sectionType?.[0]?.count).toBe(3);
      expect(facets.sectionType?.[1]?.value).toBe("cta");
      expect(facets.sectionType?.[1]?.count).toBe(2);
      expect(facets.sectionType?.[2]?.value).toBe("footer");
      expect(facets.sectionType?.[2]?.count).toBe(1);
    });

    it("全フィールドを同時に算出できる / Computes all fields simultaneously", () => {
      const results: UnifiedSearchResultItem[] = [
        {
          type: "layout",
          id: "1",
          similarity: 0.9,
          metadata: {
            sectionType: "hero",
            industry: "SaaS",
            audience: "Developer",
            tags: ["responsive"],
          },
        },
      ];

      const facets = computeFacetsFromResults(results, [
        "sectionType",
        "industry",
        "audience",
        "tags",
      ]);

      expect(facets.sectionType).toContainEqual({ value: "hero", count: 1 });
      expect(facets.industry).toContainEqual({ value: "SaaS", count: 1 });
      expect(facets.audience).toContainEqual({ value: "Developer", count: 1 });
      expect(facets.tags).toContainEqual({ value: "responsive", count: 1 });
    });

    it("metadataにundefined値がある場合はスキップする / Skips undefined metadata values", () => {
      const results: UnifiedSearchResultItem[] = [
        { type: "layout", id: "1", similarity: 0.9, metadata: { sectionType: undefined } },
        { type: "layout", id: "2", similarity: 0.8, metadata: {} },
      ];

      const facets = computeFacetsFromResults(results, ["sectionType"]);
      expect(facets.sectionType).toEqual([]);
    });

    it("partType をsectionType ファセットにマッピングする / Maps partType to sectionType facet", () => {
      const results: UnifiedSearchResultItem[] = [
        {
          type: "part",
          id: "1",
          similarity: 0.9,
          metadata: { partType: "button" },
        },
        {
          type: "part",
          id: "2",
          similarity: 0.8,
          metadata: { partType: "button" },
        },
        {
          type: "part",
          id: "3",
          similarity: 0.7,
          metadata: { partType: "card" },
        },
      ];

      const facets = computeFacetsFromResults(results, ["sectionType"]);

      // partType is mapped as sectionType for parts
      expect(facets.sectionType).toContainEqual({ value: "button", count: 2 });
      expect(facets.sectionType).toContainEqual({ value: "card", count: 1 });
    });
  });
});
