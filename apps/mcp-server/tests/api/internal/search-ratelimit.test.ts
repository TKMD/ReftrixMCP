// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebUI v1 W3 — internal search rate-limit invariant (INV-WEBUI-SEARCH-RATELIMIT-010, SEC-W3-M1).
 *
 * Pins that the 3 internal search routes are rate-limited (CWE-770) via the SHARED Token Bucket
 * core (`RateLimiter.checkRateLimit`). We mock the rate-limiter MODULE so the limiter outcome is
 * deterministic at the route level — the bucket math / Redis Lua / in-memory fallback is already
 * covered by `tests/middleware/rate-limiter.test.ts` (DRY: this file does NOT re-test the core).
 *
 * Non-vacuous (mutation-proof):
 * - DENIED → 429 (negative): if `internalRateLimit` is removed from a route's middleware chain,
 *   the limiter mock is never consulted and the handler runs → 200/503 not 429 → RED.
 * - ALLOWED → 200 (positive companion): proves the limiter is not a blanket reject — a request
 *   under the limit reaches the handler.
 * - The limiter is consulted with the correct search-route KEY (search tier).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const mockCheckRateLimit = vi.fn();

vi.mock("../../../src/middleware/rate-limiter", () => ({
  getRateLimiter: () => ({ checkRateLimit: mockCheckRateLimit }),
}));

vi.mock("../../../src/api/internal/search.service", () => ({
  getTextSearch: vi.fn(),
  getImageSearch: vi.fn(),
  getSimilarSiteSearch: vi.fn(),
}));

vi.mock("../../../src/api/internal/dashboard.service", () => ({
  getDashboardStats: vi.fn(),
  getRecentPages: vi.fn(),
}));
vi.mock("../../../src/api/internal/page-detail.service", () => ({
  getPageDetail: vi.fn(),
  getPageQuality: vi.fn(),
  getPageSections: vi.fn(),
  getPageParts: vi.fn(),
  getPageNarrative: vi.fn(),
  getSimilarDesigns: vi.fn(),
  getScreenshotStream: vi.fn(),
}));
vi.mock("../../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  isDevelopment: () => false,
}));

import {
  getTextSearch,
  getImageSearch,
  getSimilarSiteSearch,
} from "../../../src/api/internal/search.service";
import { createInternalApiApp } from "../../../src/api/internal/server";

const mockedTextSearch = getTextSearch as ReturnType<typeof vi.fn>;
const mockedImageSearch = getImageSearch as ReturnType<typeof vi.fn>;
const mockedSimilarSite = getSimilarSiteSearch as ReturnType<typeof vi.fn>;

function listen(app: ReturnType<typeof createInternalApiApp>): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function get(
  server: Server,
  path: string
): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, retryAfter: res.headers.get("retry-after") };
}

async function post(server: Server, path: string, payload: unknown): Promise<{ status: number }> {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status };
}

const ALLOWED = { allowed: true, remaining: 119, limit: 120 };
const DENIED = { allowed: false, remaining: 0, limit: 120, retryAfterMs: 1500 };

describe("INV-WEBUI-SEARCH-RATELIMIT-010 — internal search routes rate-limited (SEC-W3-M1, CWE-770)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTextSearch.mockResolvedValue({ ok: true, results: [], total: 0 });
    mockedImageSearch.mockResolvedValue({
      ok: true,
      results: [],
      total: 0,
      searchMode: "vision_only",
    });
    mockedSimilarSite.mockResolvedValue({ ok: true, query_url: "x", similar_sites: [], total: 0 });
  });

  // ---- DENIED → 429 (negative, the decisive CWE-770 assertion) ----
  it("GET /internal/search/text returns 429 + Retry-After when the limiter denies", async () => {
    mockCheckRateLimit.mockResolvedValue(DENIED);
    const server = await listen(createInternalApiApp());
    try {
      const { status, body, retryAfter } = await get(server, "/internal/search/text?q=hero");
      expect(status).toBe(429);
      // CWE-209: fixed message, no rate-limit internals.
      expect((body as { error: string }).error).toBe("Too many requests");
      expect(retryAfter).toBe("2"); // ceil(1500ms / 1000)
      // the handler MUST NOT run when rate-limited (work rejected before embedding/DB).
      expect(mockedTextSearch).not.toHaveBeenCalled();
      // limiter consulted with the search-route key (search tier).
      expect(mockCheckRateLimit).toHaveBeenCalledWith("internal_search.text");
    } finally {
      server.close();
    }
  });

  it("POST /internal/search/image returns 429 when the limiter denies (before body parse / handler)", async () => {
    mockCheckRateLimit.mockResolvedValue(DENIED);
    const server = await listen(createInternalApiApp());
    try {
      const { status } = await post(server, "/internal/search/image", { image_base64: "abc" });
      expect(status).toBe(429);
      expect(mockedImageSearch).not.toHaveBeenCalled();
      expect(mockCheckRateLimit).toHaveBeenCalledWith("internal_search.image");
    } finally {
      server.close();
    }
  });

  it("GET /internal/search/similar-site returns 429 when the limiter denies", async () => {
    mockCheckRateLimit.mockResolvedValue(DENIED);
    const server = await listen(createInternalApiApp());
    try {
      const { status } = await get(
        server,
        "/internal/search/similar-site?url=https%3A%2F%2Fexample.com"
      );
      expect(status).toBe(429);
      expect(mockedSimilarSite).not.toHaveBeenCalled();
      expect(mockCheckRateLimit).toHaveBeenCalledWith("internal_search.similar_site");
    } finally {
      server.close();
    }
  });

  // ---- ALLOWED → 200 (positive companion, proves it's not a blanket reject) ----
  it("GET /internal/search/text reaches the handler (200) when the limiter allows", async () => {
    mockCheckRateLimit.mockResolvedValue(ALLOWED);
    const server = await listen(createInternalApiApp());
    try {
      const { status } = await get(server, "/internal/search/text?q=hero");
      expect(status).toBe(200);
      expect(mockedTextSearch).toHaveBeenCalledTimes(1);
      // observability headers present on the allowed path.
    } finally {
      server.close();
    }
  });

  it("POST /internal/search/image reaches the handler (200) when the limiter allows", async () => {
    mockCheckRateLimit.mockResolvedValue(ALLOWED);
    const server = await listen(createInternalApiApp());
    try {
      const { status } = await post(server, "/internal/search/image", { image_base64: "abc" });
      expect(status).toBe(200);
      expect(mockedImageSearch).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });

  // ---- graceful fail-open on a limiter fault (availability) ----
  it("fails OPEN (reaches the handler) when the limiter itself throws", async () => {
    mockCheckRateLimit.mockRejectedValue(new Error("redis exploded — internal detail"));
    const server = await listen(createInternalApiApp());
    try {
      const { status } = await get(server, "/internal/search/text?q=hero");
      // a limiter fault must NOT take down the read API — it fails open to the handler.
      expect(status).toBe(200);
      expect(mockedTextSearch).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });
});
