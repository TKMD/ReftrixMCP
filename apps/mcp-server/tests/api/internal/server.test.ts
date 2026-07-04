// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Internal read HTTP API server/router tests (WebUI v1 W1).
 *
 * Verifies:
 * - O-1 Option A: express app exposes /internal/* read-only endpoints (ADR-0042 Decision 1).
 * - ADR-0042 Decision 2: server binds 127.0.0.1 ONLY (0.0.0.0 forbidden), single auth
 *   middleware seam present on every /internal route.
 * - UB-3: Zod boundary rejects malformed input with 400.
 * - L-05 / CWE-209: error responses route through sanitizeErrorMessage (no raw error.message).
 *
 * The dashboard service is mocked so the router is tested in isolation (no real DB).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

vi.mock("../../../src/api/internal/dashboard.service", () => ({
  getDashboardStats: vi.fn(),
  getRecentPages: vi.fn(),
  getFeaturedComparison: vi.fn(),
}));

vi.mock("../../../src/api/internal/page-detail.service", () => ({
  getPageDetail: vi.fn(),
  getPageQuality: vi.fn(),
  getPageSections: vi.fn(),
  getPageParts: vi.fn(),
  getPageNarrative: vi.fn(),
  getSimilarDesigns: vi.fn(),
}));

vi.mock("../../../src/api/internal/search.service", () => ({
  getTextSearch: vi.fn(),
  getImageSearch: vi.fn(),
  getSimilarSiteSearch: vi.fn(),
}));

vi.mock("../../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  isDevelopment: () => false,
}));

import {
  getDashboardStats,
  getRecentPages,
  getFeaturedComparison,
} from "../../../src/api/internal/dashboard.service";
import {
  getPageDetail,
  getPageQuality,
  getPageSections,
  getPageParts,
  getPageNarrative,
  getSimilarDesigns,
} from "../../../src/api/internal/page-detail.service";
import {
  getTextSearch,
  getImageSearch,
  getSimilarSiteSearch,
} from "../../../src/api/internal/search.service";
import {
  createInternalApiApp,
  startInternalApi,
  INTERNAL_API_PORT,
  internalAuthSeam,
} from "../../../src/api/internal/server";

const mockedStats = getDashboardStats as ReturnType<typeof vi.fn>;
const mockedRecent = getRecentPages as ReturnType<typeof vi.fn>;
const mockedFeatured = getFeaturedComparison as ReturnType<typeof vi.fn>;
const mockedPageDetail = getPageDetail as ReturnType<typeof vi.fn>;
const mockedPageQuality = getPageQuality as ReturnType<typeof vi.fn>;
const mockedPageSections = getPageSections as ReturnType<typeof vi.fn>;
const mockedPageParts = getPageParts as ReturnType<typeof vi.fn>;
const mockedPageNarrative = getPageNarrative as ReturnType<typeof vi.fn>;
const mockedSimilarDesigns = getSimilarDesigns as ReturnType<typeof vi.fn>;
const mockedTextSearch = getTextSearch as ReturnType<typeof vi.fn>;
const mockedImageSearch = getImageSearch as ReturnType<typeof vi.fn>;
const mockedSimilarSite = getSimilarSiteSearch as ReturnType<typeof vi.fn>;

const VALID_ID = "0190b6f0-1234-7abc-89ab-0123456789ab";

function listenOnEphemeral(app: ReturnType<typeof createInternalApiApp>): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function fetchJson(server: Server, path: string): Promise<{ status: number; body: unknown }> {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function postJson(
  server: Server,
  path: string,
  payload: unknown
): Promise<{ status: number; body: unknown }> {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

describe("internal API auth seam (ADR-0042 Decision 2)", () => {
  it("exposes a single auth middleware seam (insertion point present)", () => {
    expect(typeof internalAuthSeam).toBe("function");
  });
});

describe("createInternalApiApp routes (read-only, O-1 Option A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /internal/dashboard/stats returns aggregated stats", async () => {
    mockedStats.mockResolvedValue({
      totalPages: 396,
      qualityEvaluatedPages: 391,
      embeddingStatus: { completed: 379, not_required: 13, failed: 4 },
      recentAnalysisCount: 382,
    });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, "/internal/dashboard/stats");
      expect(status).toBe(200);
      expect((body as { totalPages: number }).totalPages).toBe(396);
    } finally {
      server.close();
    }
  });

  it("GET /internal/dashboard/featured-comparison returns the seed + similar payload", async () => {
    mockedFeatured.mockResolvedValue({
      seed: { id: VALID_ID, url: "https://seed.example", title: "Seed", hasScreenshot: true },
      similar: [
        {
          id: "0190b6f0-5555-7abc-89ab-0123456789ab",
          url: "https://n.example",
          title: "N",
          similarity: 0.83,
          hasScreenshot: false,
        },
      ],
    });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, "/internal/dashboard/featured-comparison");
      expect(status).toBe(200);
      const payload = body as { seed: { id: string } | null; similar: unknown[] };
      expect(payload.seed?.id).toBe(VALID_ID);
      expect(payload.similar).toHaveLength(1);
      // default limit (6) passed through; auto-pick seed = undefined
      expect(mockedFeatured).toHaveBeenCalledWith(undefined, 6);
    } finally {
      server.close();
    }
  });

  it("GET /internal/dashboard/featured-comparison serves honest empty (seed null)", async () => {
    mockedFeatured.mockResolvedValue({ seed: null, similar: [] });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, "/internal/dashboard/featured-comparison");
      expect(status).toBe(200);
      expect((body as { seed: unknown }).seed).toBeNull();
      expect((body as { similar: unknown[] }).similar).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("GET /internal/dashboard/featured-comparison rejects a malformed seed with 400", async () => {
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status } = await fetchJson(
        server,
        "/internal/dashboard/featured-comparison?seed=not-a-uuid"
      );
      expect(status).toBe(400);
      expect(mockedFeatured).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("GET /internal/pages applies Zod bounds and rejects pageSize>100 with 400", async () => {
    mockedRecent.mockResolvedValue([]);
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status } = await fetchJson(server, "/internal/pages?pageSize=99999");
      expect(status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("returns sanitized error (no raw error.message) when service throws (CWE-209)", async () => {
    mockedStats.mockRejectedValue(
      new Error('relation "web_pages" does not exist — internal table leak')
    );
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, "/internal/dashboard/stats");
      expect(status).toBe(500);
      const errStr = JSON.stringify(body);
      // sanitizeErrorMessage must not leak the raw DB/internal structure
      expect(errStr).not.toContain("web_pages");
      expect(errStr).not.toContain("internal table leak");
      expect((body as { error?: string }).error).toBeTruthy();
    } finally {
      server.close();
    }
  });
});

describe("W2 page-detail routes (read-only, ADR-0042 Amendment 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /internal/pages/:id returns 200 detail when found", async () => {
    mockedPageDetail.mockResolvedValue({ id: VALID_ID, hasScreenshot: true });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, `/internal/pages/${VALID_ID}`);
      expect(status).toBe(200);
      expect((body as { id: string }).id).toBe(VALID_ID);
    } finally {
      server.close();
    }
  });

  it("GET /internal/pages/:id returns 404 (fixed string) when service returns null", async () => {
    mockedPageDetail.mockResolvedValue(null);
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, `/internal/pages/${VALID_ID}`);
      expect(status).toBe(404);
      expect((body as { error: string }).error).toBe("Not found");
    } finally {
      server.close();
    }
  });

  it("GET /internal/pages/:id returns 400 for a malformed (non-UUID) id", async () => {
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status } = await fetchJson(server, "/internal/pages/not-a-uuid");
      expect(status).toBe(400);
      expect(mockedPageDetail).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("GET /internal/pages/:id/quality returns the quality payload (null = graceful)", async () => {
    mockedPageQuality.mockResolvedValue(null);
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, `/internal/pages/${VALID_ID}/quality`);
      expect(status).toBe(200);
      expect(body).toBeNull();
    } finally {
      server.close();
    }
  });

  it("GET /internal/pages/:id/sections enforces the Zod pageSize cap (400 on >100)", async () => {
    mockedPageSections.mockResolvedValue({ page: 0, pageSize: 20, total: 0, items: [] });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status } = await fetchJson(
        server,
        `/internal/pages/${VALID_ID}/sections?pageSize=99999`
      );
      expect(status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("GET /internal/pages/:id/parts accepts an allowlisted partType, returns 200", async () => {
    mockedPageParts.mockResolvedValue({ page: 0, pageSize: 20, total: 0, items: [] });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status } = await fetchJson(
        server,
        `/internal/pages/${VALID_ID}/parts?partType=button`
      );
      expect(status).toBe(200);
      expect(mockedPageParts).toHaveBeenCalledWith(VALID_ID, 0, 20, "button");
    } finally {
      server.close();
    }
  });

  it("GET /internal/pages/:id/parts rejects an injection-shaped partType with 400", async () => {
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status } = await fetchJson(
        server,
        `/internal/pages/${VALID_ID}/parts?partType=${encodeURIComponent("a; DROP TABLE x")}`
      );
      expect(status).toBe(400);
      expect(mockedPageParts).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("returns sanitized error (no DB internals) when a page-detail service throws (CWE-209)", async () => {
    mockedPageDetail.mockRejectedValue(
      new Error('relation "component_parts" does not exist — internal leak')
    );
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, `/internal/pages/${VALID_ID}`);
      expect(status).toBe(500);
      const errStr = JSON.stringify(body);
      expect(errStr).not.toContain("component_parts");
      expect(errStr).not.toContain("internal leak");
    } finally {
      server.close();
    }
  });
});

describe("W2 human-value routes (narrative / similar / quality-recs)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /internal/pages/:id/narrative returns the narrative payload (200)", async () => {
    mockedPageNarrative.mockResolvedValue({ moodCategory: "professional", tags: [] });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, `/internal/pages/${VALID_ID}/narrative`);
      expect(status).toBe(200);
      expect((body as { moodCategory: string }).moodCategory).toBe("professional");
    } finally {
      server.close();
    }
  });

  it("GET /internal/pages/:id/narrative returns null body (graceful 未分析, 200 not 404)", async () => {
    mockedPageNarrative.mockResolvedValue(null);
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, `/internal/pages/${VALID_ID}/narrative`);
      expect(status).toBe(200);
      expect(body).toBeNull();
    } finally {
      server.close();
    }
  });

  it("GET /internal/pages/:id/narrative returns 400 for a malformed id", async () => {
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status } = await fetchJson(server, "/internal/pages/not-a-uuid/narrative");
      expect(status).toBe(400);
      expect(mockedPageNarrative).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("GET /internal/pages/:id/similar returns {items} (200)", async () => {
    mockedSimilarDesigns.mockResolvedValue([
      { id: VALID_ID, url: "https://a.example", title: "A", similarity: 0.9, hasScreenshot: true },
    ]);
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, `/internal/pages/${VALID_ID}/similar`);
      expect(status).toBe(200);
      expect((body as { items: unknown[] }).items).toHaveLength(1);
      expect(mockedSimilarDesigns).toHaveBeenCalledWith(VALID_ID, 6); // default limit 6
    } finally {
      server.close();
    }
  });

  it("GET /internal/pages/:id/similar honors a bounded limit param", async () => {
    mockedSimilarDesigns.mockResolvedValue([]);
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(
        server,
        `/internal/pages/${VALID_ID}/similar?limit=10`
      );
      expect(status).toBe(200);
      expect((body as { items: unknown[] }).items).toEqual([]);
      expect(mockedSimilarDesigns).toHaveBeenCalledWith(VALID_ID, 10);
    } finally {
      server.close();
    }
  });

  it("GET /internal/pages/:id/similar rejects limit > 12 with 400 (CWE-770)", async () => {
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status } = await fetchJson(server, `/internal/pages/${VALID_ID}/similar?limit=99999`);
      expect(status).toBe(400);
      expect(mockedSimilarDesigns).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("GET /internal/pages/:id/quality includes recommendations in the payload", async () => {
    mockedPageQuality.mockResolvedValue({
      overallScore: 78,
      grade: "B",
      axisScores: {},
      axisGrades: {},
      axisDetails: null,
      recommendations: ["[warning] improve contrast"],
    });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, `/internal/pages/${VALID_ID}/quality`);
      expect(status).toBe(200);
      expect((body as { recommendations: string[] }).recommendations).toEqual([
        "[warning] improve contrast",
      ]);
    } finally {
      server.close();
    }
  });
});

describe("W3 search routes (ADR-0042 Amendment 2 / ADR-0043 fail-loud)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- text search ----
  it("GET /internal/search/text returns 200 results on success", async () => {
    mockedTextSearch.mockResolvedValue({
      ok: true,
      results: [{ type: "layout", id: VALID_ID, similarity: 0.9, metadata: {} }],
      total: 1,
    });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, "/internal/search/text?q=hero");
      expect(status).toBe(200);
      expect((body as { ok: boolean; total: number }).ok).toBe(true);
      expect((body as { total: number }).total).toBe(1);
      expect(mockedTextSearch).toHaveBeenCalledWith(
        expect.objectContaining({ q: "hero", view: "section" })
      );
    } finally {
      server.close();
    }
  });

  it("GET /internal/search/text rejects q > 512 with 400 (CWE-770)", async () => {
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status } = await fetchJson(server, `/internal/search/text?q=${"a".repeat(513)}`);
      expect(status).toBe(400);
      expect(mockedTextSearch).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("GET /internal/search/text rejects a missing q with 400", async () => {
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status } = await fetchJson(server, "/internal/search/text");
      expect(status).toBe(400);
      expect(mockedTextSearch).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  // INV-WEBUI-SEARCH-FAILLOUD-001: a degraded embedding layer is 503 + degradedReason, NOT a
  // 200 with a fake { total: 0 }. The body must carry an ENUM reason (CWE-209), no raw message.
  it("GET /internal/search/text returns 503 + degradedReason (NOT fake 0) when degraded", async () => {
    mockedTextSearch.mockResolvedValue({ ok: false, degradedReason: "embedding_failed" });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, "/internal/search/text?q=hero");
      expect(status).toBe(503);
      expect((body as { ok: boolean }).ok).toBe(false);
      expect((body as { degradedReason: string }).degradedReason).toBe("embedding_failed");
      // fail-loud: no fake "total: 0" success-shape leaks through.
      expect((body as { total?: number }).total).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it("GET /internal/search/text surfaces degradedServices on partial degradation (200, honest)", async () => {
    mockedTextSearch.mockResolvedValue({
      ok: true,
      results: [],
      total: 0,
      degradedServices: [{ service: "motion", reason: "embedding_failed" }],
    });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(server, "/internal/search/text?q=hero");
      expect(status).toBe(200);
      const b = body as { ok: boolean; total: number; degradedServices: unknown[] };
      expect(b.ok).toBe(true);
      expect(b.total).toBe(0); // honest empty, with a partial-degradation marker present
      expect(b.degradedServices).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  // ---- image search (POST) ----
  it("POST /internal/search/image returns 200 results on success", async () => {
    mockedImageSearch.mockResolvedValue({
      ok: true,
      results: [],
      total: 0,
      searchMode: "vision_only",
    });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await postJson(server, "/internal/search/image", {
        image_base64: "abc123",
      });
      expect(status).toBe(200);
      expect((body as { ok: boolean }).ok).toBe(true);
      expect(mockedImageSearch).toHaveBeenCalledWith(
        expect.objectContaining({ image_base64: "abc123" })
      );
    } finally {
      server.close();
    }
  });

  it("POST /internal/search/image rejects providing BOTH base64 and url with 400 (xor)", async () => {
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status } = await postJson(server, "/internal/search/image", {
        image_base64: "abc",
        image_url: "https://e.com/a.png",
      });
      expect(status).toBe(400);
      expect(mockedImageSearch).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("POST /internal/search/image returns 503 fail-loud when embedding degraded", async () => {
    mockedImageSearch.mockResolvedValue({
      ok: false,
      code: "service_unavailable",
      degradedReason: "embedding_unavailable",
    });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await postJson(server, "/internal/search/image", {
        image_base64: "abc",
      });
      expect(status).toBe(503);
      expect((body as { degradedReason: string }).degradedReason).toBe("embedding_unavailable");
    } finally {
      server.close();
    }
  });

  // ---- similar-site ----
  it("GET /internal/search/similar-site returns 200 with results", async () => {
    mockedSimilarSite.mockResolvedValue({
      ok: true,
      query_url: "https://example.com",
      similar_sites: [],
      total: 0,
    });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(
        server,
        "/internal/search/similar-site?url=https%3A%2F%2Fexample.com"
      );
      expect(status).toBe(200);
      expect((body as { ok: boolean }).ok).toBe(true);
      expect(mockedSimilarSite).toHaveBeenCalledWith(
        expect.objectContaining({ url: "https://example.com" })
      );
    } finally {
      server.close();
    }
  });

  it("GET /internal/search/similar-site returns 400 on invalid_input (URL rejected)", async () => {
    mockedSimilarSite.mockResolvedValue({ ok: false, reason: "invalid_input" });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status, body } = await fetchJson(
        server,
        "/internal/search/similar-site?url=https%3A%2F%2Fexample.com"
      );
      expect(status).toBe(400);
      expect((body as { reason: string }).reason).toBe("invalid_input");
    } finally {
      server.close();
    }
  });

  it("GET /internal/search/similar-site rejects a missing url with 400", async () => {
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const { status } = await fetchJson(server, "/internal/search/similar-site");
      expect(status).toBe(400);
      expect(mockedSimilarSite).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

describe("startInternalApi (127.0.0.1 bind only, ADR-0042 Decision 2)", () => {
  it("binds to 127.0.0.1 (loopback) and not 0.0.0.0", async () => {
    mockedStats.mockResolvedValue({
      totalPages: 0,
      qualityEvaluatedPages: 0,
      embeddingStatus: {},
      recentAnalysisCount: 0,
    });
    const server = await startInternalApi({ port: 0 });
    expect(server).not.toBeNull();
    try {
      const addr = server!.address() as AddressInfo;
      // node normalizes 127.0.0.1 loopback bind; must NOT be 0.0.0.0 / ::
      expect(addr.address).toBe("127.0.0.1");
      expect(INTERNAL_API_PORT).toBe(24006);
    } finally {
      server!.close();
    }
  });
});
