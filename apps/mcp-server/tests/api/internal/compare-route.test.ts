// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebUI v1 W4 — internal compare ROUTE behaviour (POST /internal/compare).
 *
 * Pins the route-level contracts (the adapter is mocked so the route is tested in isolation):
 *  - Zod boundary: a malformed body → 400 fixed string `{ error: "Invalid request body" }`
 *    (CWE-209: NO Zod issue leak; INV-WEBUI-COMPARE-INPUT-CAP-002 route half).
 *  - success:true → 200 with the structured DesignCompareOutput body.
 *  - fail-loud honesty: a success:false PAGES_NOT_FOUND → 404 but the FULL structured body is
 *    returned (the webui renders the honest error reason — never a fake empty matrix).
 *  - status-by-classification mirrors the W3 similar-site idiom (PAGES_NOT_FOUND → 404 /
 *    INVALID_INPUT → 400 / otherwise → 503), always with the structured body.
 *
 * The rate limiter is mocked to always-allow here so the route logic (not the limiter) is under
 * test; the limiter wiring is pinned separately in `compare-ratelimit.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

vi.mock("../../../src/api/internal/compare.service", () => ({
  getCompare: vi.fn(),
}));
vi.mock("../../../src/middleware/rate-limiter", () => ({
  getRateLimiter: () => ({
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 119, limit: 120 }),
  }),
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
): Promise<{ status: number; body: unknown }> {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/internal/compare`, {
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /internal/compare — Zod boundary (CWE-209 / CWE-770)", () => {
  it("rejects a malformed body with 400 fixed string (NO Zod issue leak)", async () => {
    const server = await listen(createInternalApiApp());
    try {
      // only 1 page_id → below the 2..5 bound → 400 at the seam (handler never consulted).
      const { status, body } = await postCompare(server, { page_ids: [ID_A] });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toBe("Invalid request body");
      // CWE-209: the Zod issue (which would name the field / bound) must not leak.
      expect(JSON.stringify(body)).not.toContain("page_ids");
      expect(mockedCompare).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("rejects a non-UUID page_id with 400 (handler never consulted)", async () => {
    const server = await listen(createInternalApiApp());
    try {
      const { status } = await postCompare(server, { page_ids: [ID_A, "not-a-uuid"] });
      expect(status).toBe(400);
      expect(mockedCompare).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

describe("POST /internal/compare — success + fail-loud status mapping (honest body)", () => {
  it("success:true → 200 with the structured body", async () => {
    mockedCompare.mockResolvedValue({
      success: true,
      pages: [],
      comparisons: [{ pair: [ID_A, ID_B], scores: { layout: 0.9 }, overall: 0.9 }],
      common_patterns: [],
      key_differences: [],
    });
    const server = await listen(createInternalApiApp());
    try {
      const { status, body } = await postCompare(server, { page_ids: [ID_A, ID_B] });
      expect(status).toBe(200);
      expect((body as { success: boolean }).success).toBe(true);
      expect((body as { comparisons: unknown[] }).comparisons).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it("success:false PAGES_NOT_FOUND → 404 but returns the FULL structured body (no fake matrix)", async () => {
    mockedCompare.mockResolvedValue({
      success: false,
      pages: [],
      comparisons: [],
      common_patterns: [],
      key_differences: [],
      error: "PAGES_NOT_FOUND: 1 page(s) not found",
    });
    const server = await listen(createInternalApiApp());
    try {
      const { status, body } = await postCompare(server, { page_ids: [ID_A, ID_B] });
      expect(status).toBe(404);
      // honest: the structured body carries the failure reason for the webui to render.
      expect((body as { success: boolean }).success).toBe(false);
      expect((body as { error: string }).error).toContain("PAGES_NOT_FOUND");
      // fail-loud: no fabricated comparisons.
      expect((body as { comparisons: unknown[] }).comparisons).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("success:false INVALID_INPUT → 400 with the structured body", async () => {
    mockedCompare.mockResolvedValue({
      success: false,
      pages: [],
      comparisons: [],
      common_patterns: [],
      key_differences: [],
      error: "INVALID_INPUT: Duplicate page_ids detected",
    });
    const server = await listen(createInternalApiApp());
    try {
      const { status, body } = await postCompare(server, { page_ids: [ID_A, ID_B] });
      expect(status).toBe(400);
      expect((body as { success: boolean }).success).toBe(false);
    } finally {
      server.close();
    }
  });

  it("success:false COMPARE_FAILED → 503 (fail-loud infra) with the structured body", async () => {
    mockedCompare.mockResolvedValue({
      success: false,
      pages: [],
      comparisons: [],
      common_patterns: [],
      key_differences: [],
      error: "COMPARE_FAILED: An internal error occurred",
    });
    const server = await listen(createInternalApiApp());
    try {
      const { status, body } = await postCompare(server, { page_ids: [ID_A, ID_B] });
      expect(status).toBe(503);
      expect((body as { success: boolean }).success).toBe(false);
      // CWE-209: only the sanitized generic message, no DB internals.
      expect(JSON.stringify(body)).not.toContain("relation");
    } finally {
      server.close();
    }
  });
});
