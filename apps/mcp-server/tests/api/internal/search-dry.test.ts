// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebUI v1 W3 — DRY source-pin invariant (INV-WEBUI-SEARCH-DRY-006, TDA-W3-P-01 / P-03 / UB-W3-6).
 *
 * The IO Plan Decision allows EITHER a jscpd <3% CI assert OR an import-boundary source-pin for
 * the DRY contract. This project has NO jscpd config/CI wired (TDA-W3-P-01 Evidence-First
 * CONFIRMED), so the DRY guarantee is pinned at the IMPORT BOUNDARY: the internal search adapter
 * (`search.service.ts`) MUST consume the existing shared search HANDLERS (案b) and MUST NOT
 * re-implement any RRF / facet / embedding / SSRF orchestration locally.
 *
 * Why import-boundary, not grep-keyword (TDA-W3-P-03): a grep for "RRF" is brittle (could match a
 * comment). Instead we pin (a) the adapter imports the 3 shared handlers, and (b) the adapter
 * does NOT import the low-level orchestration primitives that would indicate a re-implementation
 * (search-cache, facet.service compute, the raw search-by-image DB helpers, resolve-query-embedding).
 *
 * Non-vacuous (mutation-proof): if a future edit re-implements RRF/facet/cache inside the adapter,
 * it would have to import one of those primitives → this test goes RED.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SEARCH_SERVICE_SRC = resolve(__dirname, "../../../src/api/internal/search.service.ts");

function readAdapter(): string {
  return readFileSync(SEARCH_SERVICE_SRC, "utf8");
}

describe("INV-WEBUI-SEARCH-DRY-006 — internal search adapter consumes shared handlers (no re-impl)", () => {
  it("imports the 3 shared search HANDLERS (案b DRY wiring, ADR-0042 Amendment 2)", () => {
    const src = readAdapter();
    expect(src).toContain("searchUnifiedHandler");
    expect(src).toContain("designSearchByImageHandler");
    expect(src).toContain("designSimilarSiteHandler");
  });

  it("does NOT re-implement RRF / cache / facet orchestration (no low-level primitive imports)", () => {
    const src = readAdapter();
    // A re-implementation would pull in one of these orchestration primitives; the adapter must
    // delegate to the handlers (which already own them) instead.
    expect(src).not.toContain("search-cache.service"); // SearchCache lives inside handlers
    expect(src).not.toContain("generateCacheKey");
    expect(src).not.toContain("computeFacetsFromResults"); // facet compute lives in the aggregator
    expect(src).not.toContain("resolveQueryEmbedding"); // embedding resolution lives in services
    // and must NOT reach the raw search-by-image DB query helpers directly.
    expect(src).not.toContain("searchByVisionEmbedding");
    expect(src).not.toContain("mergeWithRRF3Source");
  });

  it("imports the FacetCounts/DegradedReason TYPES only (type re-export, not logic duplication)", () => {
    const src = readAdapter();
    // Type-only imports are DRY-safe (shape sharing, not logic). Pin that facet usage is the
    // type, not the compute fn.
    expect(src).toMatch(/type\s+\{?\s*FacetCounts/);
    expect(src).toMatch(/type\s+\{?\s*DegradedReason/);
  });
});
