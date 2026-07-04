// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PartSearchService.searchPartsFulltext 抽出テスト
 * (ADR-0043 Decision 3 / plan v4 §4.3.1, UB-V1-1 (a)、PR-2a)
 *
 * `searchPartsHybrid` 内 private `fulltextSearchFn` を public method
 * `searchPartsFulltext(query, options)` として抽出した検証:
 * - public method として存在し PartSearchResult を返す
 * - embedding 不要 (fulltext-only) で結果を返す
 * - PrismaClient 未配線時は空結果 (graceful)
 *
 * @module tests/services/part/part-search-fulltext
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PartSearchService,
  setPartSearchPrismaClientFactory,
  resetPartSearchPrismaClientFactory,
  resetPartSearchEmbeddingServiceFactory,
  type PartSearchPrismaClient,
  type PartSearchOptions,
} from "../../../src/services/part/part-search.service";

const baseOptions = (overrides: Partial<PartSearchOptions> = {}): PartSearchOptions => ({
  limit: 10,
  offset: 0,
  minSimilarity: 0.3,
  searchMode: "text",
  ...overrides,
});

const createMockRow = (id: string, similarity = 0.7): Record<string, unknown> => ({
  id,
  part_type: "button",
  part_subtype: null,
  bounding_box: { x: 0, y: 0, width: 100, height: 40 },
  computed_styles: { color: "#fff" },
  html_snippet: "<button>Go</button>",
  section_type: "hero",
  web_page_url: "https://example.com",
  similarity,
});

describe("PartSearchService.searchPartsFulltext (plan v4 §4.3.1)", () => {
  beforeEach(() => {
    resetPartSearchPrismaClientFactory();
    resetPartSearchEmbeddingServiceFactory();
  });
  afterEach(() => {
    resetPartSearchPrismaClientFactory();
    resetPartSearchEmbeddingServiceFactory();
    vi.restoreAllMocks();
  });

  it("public method として存在し fulltext-only で結果を返す (embedding 不要)", async () => {
    const prisma: PartSearchPrismaClient = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([createMockRow("p1"), createMockRow("p2", 0.6)]),
    };
    setPartSearchPrismaClientFactory(() => prisma);

    const service = new PartSearchService();
    const result = await service.searchPartsFulltext("button", baseOptions());

    expect(result.results.length).toBe(2);
    expect(result.results[0]?.id).toBe("p1");
    expect(result.query.text).toBe("button");
    // embedding service は一切呼ばれない (fulltext-only)
  });

  it("PrismaClient 未配線時は空結果 (graceful)", async () => {
    const service = new PartSearchService();
    const result = await service.searchPartsFulltext("button", baseOptions());
    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("DB error 時は空結果 (graceful、embedding 不要ゆえ fail-loud にしない)", async () => {
    const prisma: PartSearchPrismaClient = {
      $queryRawUnsafe: vi.fn().mockRejectedValue(new Error("DB error")),
    };
    setPartSearchPrismaClientFactory(() => prisma);

    const service = new PartSearchService();
    const result = await service.searchPartsFulltext("button", baseOptions());
    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("minSimilarity でフィルタする", async () => {
    const prisma: PartSearchPrismaClient = {
      $queryRawUnsafe: vi
        .fn()
        .mockResolvedValue([createMockRow("hi", 0.9), createMockRow("lo", 0.1)]),
    };
    setPartSearchPrismaClientFactory(() => prisma);

    const service = new PartSearchService();
    const result = await service.searchPartsFulltext("button", baseOptions({ minSimilarity: 0.5 }));
    expect(result.results.map((r) => r.id)).toEqual(["hi"]);
  });
});
