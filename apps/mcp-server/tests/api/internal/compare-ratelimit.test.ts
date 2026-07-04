// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebUI v1 W4 — internal compare rate-limit invariant
 * (INV-WEBUI-COMPARE-RATELIMIT-009, Registry F-PLAN-W4-B MUST, CWE-770).
 *
 * Pins that POST /internal/compare is rate-limited via the SHARED Token Bucket core
 * (`RateLimiter.checkRateLimit`) at the `search` tier — symmetric with the W3 `internal_search.*`
 * routes. The bucket math / Redis Lua / in-memory fallback is already covered by
 * `tests/middleware/rate-limiter.test.ts` (DRY: this file does NOT re-test the core).
 *
 * Non-vacuous (mutation-proof):
 *  - DENIED → 429 (the decisive CWE-770 assertion): if `internalRateLimit("internal_compare")` is
 *    removed from the route chain, the limiter mock is never consulted → the handler runs → not 429.
 *  - ORDER: an OVER-CAP body + a DENIED limiter still returns 429 (NOT a 413 body-too-large) — this
 *    proves the limiter runs BEFORE the route-scoped `express.json` (over-limit rejected pre-parse).
 *  - tier-pin: `TOOL_TIER_MAP.internal_compare === "search"` (auto-inherit would silently fall to
 *    the `default` 60 RPM tier — this pins the explicit search-tier wiring).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type * as RateLimiterModule from "../../../src/middleware/rate-limiter";
import { TOOL_TIER_MAP } from "../../../src/middleware/rate-limiter";

const mockCheckRateLimit = vi.fn();

vi.mock("../../../src/middleware/rate-limiter", async (importOriginal) => {
  const actual = await importOriginal<typeof RateLimiterModule>();
  return { ...actual, getRateLimiter: () => ({ checkRateLimit: mockCheckRateLimit }) };
});

vi.mock("../../../src/api/internal/compare.service", () => ({
  getCompare: vi.fn(),
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
vi.mock("../../../src/api/internal/search.service", () => ({
  getTextSearch: vi.fn(),
  getImageSearch: vi.fn(),
  getSimilarSiteSearch: vi.fn(),
}));
vi.mock("../../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  isDevelopment: () => false,
}));

import { getCompare } from "../../../src/api/internal/compare.service";
import { createInternalApiApp } from "../../../src/api/internal/server";

const mockedCompare = getCompare as ReturnType<typeof vi.fn>;

const ID_A = "0190b6f0-1234-7abc-89ab-0123456789ab";
const ID_B = "0190b6f0-1234-7abc-89ab-0123456789ac";

function listen(app: ReturnType<typeof createInternalApiApp>): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function postCompare(
  server: Server,
  payload: unknown
): Promise<{ status: number; retryAfter: string | null }> {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/internal/compare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, retryAfter: res.headers.get("retry-after") };
}

const ALLOWED = { allowed: true, remaining: 119, limit: 120 };
const DENIED = { allowed: false, remaining: 0, limit: 120, retryAfterMs: 1500 };

beforeEach(() => {
  vi.clearAllMocks();
  mockedCompare.mockResolvedValue({
    success: true,
    pages: [],
    comparisons: [],
    common_patterns: [],
    key_differences: [],
  });
});

describe("INV-WEBUI-COMPARE-RATELIMIT-009 — compare route rate-limited (F-PLAN-W4-B, CWE-770)", () => {
  it("tier-pin: TOOL_TIER_MAP.internal_compare === 'search' (not auto-inherited default)", () => {
    expect(TOOL_TIER_MAP["internal_compare"]).toBe("search");
  });

  it("DENIED → 429 + Retry-After, before the handler runs (the decisive CWE-770 assertion)", async () => {
    mockCheckRateLimit.mockResolvedValue(DENIED);
    const server = await listen(createInternalApiApp());
    try {
      const { status, retryAfter } = await postCompare(server, { page_ids: [ID_A, ID_B] });
      expect(status).toBe(429);
      expect(retryAfter).toBe("2"); // ceil(1500ms / 1000)
      expect(mockedCompare).not.toHaveBeenCalled();
      expect(mockCheckRateLimit).toHaveBeenCalledWith("internal_compare");
    } finally {
      server.close();
    }
  });

  it("ALLOWED → 200, the handler is reached (not a blanket reject)", async () => {
    mockCheckRateLimit.mockResolvedValue(ALLOWED);
    const server = await listen(createInternalApiApp());
    try {
      const { status } = await postCompare(server, { page_ids: [ID_A, ID_B] });
      expect(status).toBe(200);
      expect(mockedCompare).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });

  it("ORDER: an over-cap body + DENIED limiter → 429 (limiter runs BEFORE express.json, not 413)", async () => {
    mockCheckRateLimit.mockResolvedValue(DENIED);
    const server = await listen(createInternalApiApp());
    try {
      // A body far larger than MAX_COMPARE_BODY_BYTES. If express.json ran first, this would be a
      // 413 (payload too large); because the limiter runs BEFORE the body parser, it is a 429.
      const oversized = { page_ids: [ID_A, ID_B], _pad: "a".repeat(50_000) };
      const { status } = await postCompare(server, oversized);
      expect(status).toBe(429);
      expect(mockedCompare).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("fails OPEN (reaches the handler) when the limiter itself throws (availability)", async () => {
    mockCheckRateLimit.mockRejectedValue(new Error("redis exploded — internal detail"));
    const server = await listen(createInternalApiApp());
    try {
      const { status } = await postCompare(server, { page_ids: [ID_A, ID_B] });
      expect(status).toBe(200);
      expect(mockedCompare).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });
});
