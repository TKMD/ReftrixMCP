// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebUI v1 W3 — internal search SSRF invariants (SEC-W3-H1 / SEC-W3-H2).
 *
 * INV-WEBUI-SEARCH-SSRF-003 (SEC-W3-H1, CONFLICT-W3-1):
 *   The similar-site / image-url search paths must keep routing their URL input through the
 *   tool-layer gate `validateExternalUrl` (案b = handler 直呼び). similar-site is DB-only
 *   (input-validation, LCC-W3-W1); image_url is a real fetch SSRF surface.
 *   - end-to-end: the internal API adapter never reaches the DB/embedding path for a
 *     private-IP / metadata URL.
 *   - AST source-pin: the internal search.service.ts MUST NOT call the DB-only similar-site
 *     SERVICE (`searchSimilarSites`) directly (that would bypass the handler's URL-input gate);
 *     it MUST go through the handler. This pins the absence of a service-direct bypass.
 *
 * INV-WEBUI-SEARCH-SSRF-REDIRECT-009 (SEC-W3-H2, CWE-918):
 *   `fetchImageFromUrl` must use `redirect:"manual"` and re-validate every 3xx Location header
 *   via `validateExternalUrl`, so a 302 → metadata-endpoint is rejected (no auto-follow). The
 *   end-to-end redirect-injection negative fixture (DI factories wired so the real fetch path is
 *   exercised) lives in `tests/tools/design/search-by-image.tool.test.ts`; here we AST source-pin
 *   the `redirect:"manual"` + Location re-validation contract.
 *
 * Non-vacuous (mutation-proof): each assertion fails RED if the gate is removed —
 *   - delete the similar-site adapter's handler call (or call the service directly) → the AST
 *     source-pin RED + the e2e private-IP test reaches the DB (would call the service mock).
 *   - change `redirect:"manual"` to `"follow"` (or drop the Location re-validation) → both the
 *     AST source-pin (here) and the redirect-injection negative fixture (handler test) go RED.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// -------------------------------------------------------------------------------------------
// Mock the shared handlers so the adapter is tested in isolation. The similar-site / image
// handlers each carry the real URL gate; the mocks let us observe whether the adapter routes
// THROUGH the handler (案b) vs. somehow reaching the DB-only service directly.
// -------------------------------------------------------------------------------------------
vi.mock("../../../src/tools/design/similar-site.tool", () => ({
  designSimilarSiteHandler: vi.fn(),
}));
vi.mock("../../../src/tools/design/search-by-image.tool", async (importOriginal) => {
  // Keep the real MAX_BASE64_BYTES export (the schema imports it) but stub the handler.
  const actual =
    await importOriginal<typeof import("../../../src/tools/design/search-by-image.tool")>();
  return { ...actual, designSearchByImageHandler: vi.fn() };
});
vi.mock("../../../src/tools/search-unified.tool", () => ({
  searchUnifiedHandler: vi.fn(),
}));

import { designSimilarSiteHandler } from "../../../src/tools/design/similar-site.tool";
import { getSimilarSiteSearch, getImageSearch } from "../../../src/api/internal/search.service";

const mockedSimilarHandler = designSimilarSiteHandler as ReturnType<typeof vi.fn>;

const SEARCH_SERVICE_SRC = resolve(__dirname, "../../../src/api/internal/search.service.ts");
const SEARCH_BY_IMAGE_SRC = resolve(__dirname, "../../../src/tools/design/search-by-image.tool.ts");

describe("INV-WEBUI-SEARCH-SSRF-003 — similar-site routes URL input through the handler gate (案b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("end-to-end: adapter calls the handler (which gates URL input), never the DB-only service directly", async () => {
    // The handler is the gate keeper (validateExternalUrl @ similar-site.tool.ts:129). The
    // adapter must delegate to it. A private-IP URL would be rejected INSIDE the handler.
    mockedSimilarHandler.mockResolvedValue({
      success: false,
      query_url: "http://169.254.169.254/latest/meta-data",
      similar_sites: [],
      total: 0,
      error: "INVALID_INPUT: URL is blocked: 169.254.169.254 is not allowed",
    });
    const result = await getSimilarSiteSearch({
      url: "http://169.254.169.254/latest/meta-data",
      page: 0,
      pageSize: 20,
    });
    // The adapter MUST have gone through the handler (案b), surfacing its input-validation reject.
    expect(mockedSimilarHandler).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("invalid_input");
  });

  it("AST source-pin: search.service.ts imports the HANDLER, not the DB-only similar-site SERVICE", () => {
    // Mutation-proof: if a future edit calls `searchSimilarSites` (the DB-only service) directly,
    // it bypasses the handler's URL-input gate → this assertion goes RED.
    const src = readFileSync(SEARCH_SERVICE_SRC, "utf8");
    expect(src).toContain("designSimilarSiteHandler");
    // The internal search adapter must NOT import/call the gate-less DB-only service.
    expect(src).not.toContain("searchSimilarSites");
    expect(src).not.toContain("similar-site.service");
  });

  it("AST source-pin: the image adapter goes through designSearchByImageHandler (gate preserved)", () => {
    const src = readFileSync(SEARCH_SERVICE_SRC, "utf8");
    expect(src).toContain("designSearchByImageHandler");
    // It must NOT reach into the gate-less internal fetch helper directly.
    expect(src).not.toContain("fetchImageFromUrl");
  });
});

describe("INV-WEBUI-SEARCH-SSRF-REDIRECT-009 — image_url fetch uses redirect:manual + re-validation (CWE-918)", () => {
  it('AST source-pin: fetchImageFromUrl uses redirect:"manual" (NOT auto-follow)', () => {
    // Mutation-proof: changing to redirect:"follow" (or dropping it) → RED.
    const src = readFileSync(SEARCH_BY_IMAGE_SRC, "utf8");
    expect(src).toContain('redirect: "manual"');
    // and re-validates each redirect target via the SSRF gate.
    expect(src).toContain("resolveRedirectTarget");
    expect(src).toMatch(/validateExternalUrl\(absolute\)/);
    // and it must NOT use auto-follow anywhere in the image fetch path.
    expect(src).not.toContain('redirect: "follow"');
  });
});
