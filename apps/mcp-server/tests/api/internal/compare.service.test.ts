// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebUI v1 W4 — internal compare adapter (compare.service.ts) unit tests.
 *
 * Pins the 案b (handler 直呼び) adapter contracts:
 *  - DRY pass-through: `getCompare` returns the `designCompareHandler` `DesignCompareOutput` verbatim
 *    (the pairwise matrix / dimensions / common_patterns / key_differences are NOT re-built here).
 *  - INV-WEBUI-COMPARE-CWE209-003: an unexpected adapter-level throw is mapped to a sanitized
 *    `COMPARE_FAILED` shape — the raw `error.message` (e.g. a Prisma/DB string) is NEVER surfaced.
 *  - fail-loud honesty (ADR-0043 principle): a handler `success:false` (PAGES_NOT_FOUND) is passed
 *    through as-is — the adapter NEVER fakes a `success:true` empty matrix.
 *  - input mapping: dimensions / include_details are forwarded only when present (handler defaults
 *    apply when omitted).
 *
 * Non-vacuous (mutation-proof): the CWE-209 test injects a raw DB-shaped throw and asserts it is
 * absent from the serialized result — leaking `error.message` would go RED.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CompareToolModule from "../../../src/tools/design/compare.tool";

vi.mock("../../../src/tools/design/compare.tool", async (importOriginal) => {
  const actual = await importOriginal<typeof CompareToolModule>();
  return { ...actual, designCompareHandler: vi.fn() };
});

import { designCompareHandler } from "../../../src/tools/design/compare.tool";
import { getCompare } from "../../../src/api/internal/compare.service";
import type { CompareBody } from "../../../src/api/internal/schemas";

const mockedHandler = designCompareHandler as ReturnType<typeof vi.fn>;

const ID_A = "0190b6f0-1234-7abc-89ab-0123456789ab";
const ID_B = "0190b6f0-1234-7abc-89ab-0123456789ac";

const SUCCESS_OUTPUT = {
  success: true,
  pages: [
    { id: ID_A, url: "https://a.example", title: "A" },
    { id: ID_B, url: "https://b.example", title: undefined },
  ],
  comparisons: [{ pair: [ID_A, ID_B] as [string, string], scores: { layout: 0.9 }, overall: 0.9 }],
  common_patterns: [{ dimension: "layout" as const, description: "shared hero" }],
  key_differences: [],
};

const baseBody: CompareBody = { page_ids: [ID_A, ID_B] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCompare — DRY pass-through (案b handler 直呼び)", () => {
  it("returns the designCompareHandler output verbatim (no matrix re-build)", async () => {
    mockedHandler.mockResolvedValue(SUCCESS_OUTPUT);
    const result = await getCompare(baseBody);
    expect(result).toEqual(SUCCESS_OUTPUT);
    expect(mockedHandler).toHaveBeenCalledTimes(1);
  });

  it("forwards dimensions / include_details when present", async () => {
    mockedHandler.mockResolvedValue(SUCCESS_OUTPUT);
    await getCompare({ page_ids: [ID_A, ID_B], dimensions: ["layout"], include_details: true });
    expect(mockedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        page_ids: [ID_A, ID_B],
        dimensions: ["layout"],
        include_details: true,
      })
    );
  });

  it("omits dimensions / include_details when absent (handler applies its own defaults)", async () => {
    mockedHandler.mockResolvedValue(SUCCESS_OUTPUT);
    await getCompare(baseBody);
    const arg = mockedHandler.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("dimensions");
    expect(arg).not.toHaveProperty("include_details");
  });
});

describe("getCompare — fail-loud honesty (ADR-0043 principle, GDPR Art.5(1)(d))", () => {
  it("passes a PAGES_NOT_FOUND failure through as success:false (NOT a fake empty matrix)", async () => {
    mockedHandler.mockResolvedValue({
      success: false,
      pages: [],
      comparisons: [],
      common_patterns: [],
      key_differences: [],
      error: "PAGES_NOT_FOUND: 1 page(s) not found",
    });
    const result = await getCompare(baseBody);
    expect(result.success).toBe(false);
    // honest: no fabricated comparisons / no faked success-shape.
    expect(result.comparisons).toEqual([]);
    expect(result.error).toContain("PAGES_NOT_FOUND");
  });
});

describe("getCompare — CWE-209 (INV-WEBUI-COMPARE-CWE209-003)", () => {
  it("maps an unexpected raw DB-shaped throw to a sanitized COMPARE_FAILED (no raw message leak)", async () => {
    mockedHandler.mockRejectedValue(
      new Error('relation "web_pages" does not exist at line 42 — internal SQL detail')
    );
    const result = await getCompare(baseBody);
    expect(result.success).toBe(false);
    expect(result.error).toContain("COMPARE_FAILED");
    // The raw DB/SQL internals must NEVER reach the result (CWE-209).
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('relation "web_pages"');
    expect(serialized).not.toContain("internal SQL detail");
    expect(serialized).not.toContain("line 42");
  });
});
