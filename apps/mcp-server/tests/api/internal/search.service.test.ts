// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebUI v1 W3 — internal search adapter (search.service.ts) unit tests.
 *
 * Pins the fail-loud + CWE-209 + read-only contracts at the adapter level (案b handler 直呼び):
 * - INV-WEBUI-SEARCH-FAILLOUD-001: a degraded embedding layer maps to `{ ok:false, degradedReason }`
 *   — the adapter NEVER fakes a `{ ok:true, total:0 }` empty. A legitimate empty stays
 *   `{ ok:true, total:0 }` (honest). Non-vacuous: a fake-fail injection makes all 3 modalities
 *   return `ok:false` (RED if the adapter swallowed it into a fake empty).
 * - INV-WEBUI-SEARCH-CWE209-005: `degradedReason` is the `DegradedReason` ENUM only; the raw
 *   handler error string / query body is never surfaced.
 * - INV-WEBUI-SEARCH-READONLY-007: the adapter passes through to read-only handlers only.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/tools/search-unified.tool", () => ({
  searchUnifiedHandler: vi.fn(),
}));
vi.mock("../../../src/tools/design/search-by-image.tool", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/tools/design/search-by-image.tool")>();
  return { ...actual, designSearchByImageHandler: vi.fn() };
});
vi.mock("../../../src/tools/design/similar-site.tool", () => ({
  designSimilarSiteHandler: vi.fn(),
}));

import { searchUnifiedHandler } from "../../../src/tools/search-unified.tool";
import { designSearchByImageHandler } from "../../../src/tools/design/search-by-image.tool";
import { designSimilarSiteHandler } from "../../../src/tools/design/similar-site.tool";
import {
  getTextSearch,
  getImageSearch,
  getSimilarSiteSearch,
} from "../../../src/api/internal/search.service";

const mockedUnified = searchUnifiedHandler as ReturnType<typeof vi.fn>;
const mockedImage = designSearchByImageHandler as ReturnType<typeof vi.fn>;
const mockedSimilar = designSimilarSiteHandler as ReturnType<typeof vi.fn>;

const baseTextQuery = { q: "hero", view: "section" as const, page: 0, pageSize: 20 };
const baseImageBody = { image_base64: "abc", page: 0, pageSize: 20 };
const baseSimilarQuery = { url: "https://example.com", page: 0, pageSize: 20 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getTextSearch — fail-loud (INV-WEBUI-SEARCH-FAILLOUD-001 / CWE209-005)", () => {
  it("maps a legitimate empty to ok:true total:0 (honest, NOT a degraded)", async () => {
    mockedUnified.mockResolvedValue({
      success: true,
      data: { results: [], total: 0, query: "hero", searchTimeMs: 1, breakdown: {} },
    });
    const result = await getTextSearch(baseTextQuery);
    expect(result.ok).toBe(true);
    expect((result as { total: number }).total).toBe(0);
    expect((result as { degradedServices?: unknown }).degradedServices).toBeUndefined();
  });

  it("maps an all-degraded aggregator to ok:false + degradedReason (no fake empty)", async () => {
    mockedUnified.mockResolvedValue({
      success: false,
      error: { code: "SEARCH_FAILED", message: "All embedding-required search services degraded" },
    });
    const result = await getTextSearch(baseTextQuery);
    expect(result.ok).toBe(false);
    // CWE-209: the reason is an ENUM, not the raw aggregator message.
    expect((result as { degradedReason: string }).degradedReason).toBe("embedding_failed");
    expect(JSON.stringify(result)).not.toContain("services degraded");
    // fail-loud: no fake total:0 success-shape.
    expect((result as { total?: number }).total).toBeUndefined();
  });

  it("surfaces degradedServices on partial degradation (additive, honest)", async () => {
    mockedUnified.mockResolvedValue({
      success: true,
      data: {
        results: [{ type: "layout", id: "x", similarity: 0.5, metadata: {} }],
        total: 1,
        query: "hero",
        searchTimeMs: 1,
        breakdown: {},
        degradedServices: [{ service: "motion", reason: "embedding_failed" }],
      },
    });
    const result = await getTextSearch(baseTextQuery);
    expect(result.ok).toBe(true);
    expect((result as { degradedServices: unknown[] }).degradedServices).toHaveLength(1);
  });

  it("passes view=page → types includes part (page tab broadens target)", async () => {
    mockedUnified.mockResolvedValue({
      success: true,
      data: { results: [], total: 0, query: "x", searchTimeMs: 1, breakdown: {} },
    });
    await getTextSearch({ ...baseTextQuery, view: "page" });
    expect(mockedUnified).toHaveBeenCalledWith(
      expect.objectContaining({ types: ["layout", "part"] })
    );
  });
});

describe("getImageSearch — fail-loud (INV-WEBUI-SEARCH-FAILLOUD-001 / CWE209-005)", () => {
  it("maps a success to ok:true with searchMode", async () => {
    mockedImage.mockResolvedValue({
      success: true,
      results: [],
      total: 0,
      searchMode: "vision_only",
    });
    const result = await getImageSearch(baseImageBody);
    expect(result.ok).toBe(true);
    expect((result as { searchMode: string }).searchMode).toBe("vision_only");
  });

  it("maps SERVICE_UNAVAILABLE to ok:false embedding_unavailable (no fake empty)", async () => {
    mockedImage.mockResolvedValue({
      success: false,
      results: [],
      total: 0,
      searchMode: "vision_only",
      error: "SERVICE_UNAVAILABLE: DINOv2 service not available",
    });
    const result = await getImageSearch(baseImageBody);
    expect(result.ok).toBe(false);
    expect((result as { degradedReason: string }).degradedReason).toBe("embedding_unavailable");
    // CWE-209: no raw message leak.
    expect(JSON.stringify(result)).not.toContain("DINOv2 service not available");
  });

  it("maps EMBEDDING_FAILED to ok:false embedding_failed (active failure, fail-loud)", async () => {
    mockedImage.mockResolvedValue({
      success: false,
      results: [],
      total: 0,
      searchMode: "vision_only",
      error: "EMBEDDING_FAILED: Generated embedding contains NaN",
    });
    const result = await getImageSearch(baseImageBody);
    expect(result.ok).toBe(false);
    expect((result as { degradedReason: string }).degradedReason).toBe("embedding_failed");
  });

  it("passes the single image field (base64) to the handler (xor already resolved)", async () => {
    mockedImage.mockResolvedValue({
      success: true,
      results: [],
      total: 0,
      searchMode: "vision_only",
    });
    await getImageSearch(baseImageBody);
    expect(mockedImage).toHaveBeenCalledWith(expect.objectContaining({ image: "abc" }));
  });

  it("passes image_url through as the single image field", async () => {
    mockedImage.mockResolvedValue({
      success: true,
      results: [],
      total: 0,
      searchMode: "vision_only",
    });
    await getImageSearch({ image_url: "https://e.com/a.png", page: 0, pageSize: 20 });
    expect(mockedImage).toHaveBeenCalledWith(
      expect.objectContaining({ image: "https://e.com/a.png" })
    );
  });
});

describe("getSimilarSiteSearch — input-validation classification (LCC-W3-W1)", () => {
  it("maps a success to ok:true with results", async () => {
    mockedSimilar.mockResolvedValue({
      success: true,
      query_url: "https://example.com",
      similar_sites: [],
      total: 0,
    });
    const result = await getSimilarSiteSearch(baseSimilarQuery);
    expect(result.ok).toBe(true);
    expect((result as { total: number }).total).toBe(0);
  });

  it("maps an INVALID_INPUT (URL rejected) to ok:false reason invalid_input", async () => {
    mockedSimilar.mockResolvedValue({
      success: false,
      query_url: "http://10.0.0.1",
      similar_sites: [],
      total: 0,
      error: "INVALID_INPUT: URL is blocked: private IP range 10.0.0.1 is not allowed",
    });
    const result = await getSimilarSiteSearch({ ...baseSimilarQuery, url: "http://10.0.0.1" });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("invalid_input");
    // CWE-209: no raw message leak.
    expect(JSON.stringify(result)).not.toContain("private IP range");
  });

  it("maps a SEARCH_FAILED to ok:false reason search_failed (fail-loud)", async () => {
    mockedSimilar.mockResolvedValue({
      success: false,
      query_url: "https://example.com",
      similar_sites: [],
      total: 0,
      error: "SEARCH_FAILED: database connection lost",
    });
    const result = await getSimilarSiteSearch(baseSimilarQuery);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("search_failed");
  });
});
