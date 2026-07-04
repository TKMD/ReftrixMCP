// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Internal read HTTP API Zod input-boundary tests (WebUI v1 W1, UB-3 / FIND-IO-PLAN-M-03).
 *
 * 全 read API endpoint の入力境界を Zod で検証する。
 * - webPageId = 既存 UUID_REGEX SSOT 再利用 (UUID v4/v7 のみ)
 * - pageSize ≤ 100 (CWE-770 unbounded DoS 防止)
 * - page = 非負整数
 *
 * These tests pin the W1 Zod boundary contract (正例 / 反例 both required, no vacuous green).
 */

import { describe, it, expect } from "vitest";
import { UUID_REGEX } from "../../../src/services/screenshot-persistence.service";
import {
  webPageIdParamSchema,
  pagesQuerySchema,
  partsQuerySchema,
  similarQuerySchema,
  featuredComparisonQuerySchema,
  textSearchQuerySchema,
  imageSearchBodySchema,
  similarSiteQuerySchema,
  MAX_TEXT_QUERY_LENGTH,
  MAX_URL_LENGTH,
  MAX_BASE64_CHARS,
} from "../../../src/api/internal/schemas";
import { MAX_BASE64_BYTES } from "../../../src/tools/design/search-by-image.tool";

const VALID_UUID_V7 = "0190b6f0-1234-7abc-89ab-0123456789ab";
const VALID_UUID_V4 = "11111111-2222-4333-8444-555555555555";

describe("webPageIdParamSchema (UB-3, reuses UUID_REGEX SSOT)", () => {
  it("re-uses the canonical UUID_REGEX SSOT (no second definition)", () => {
    // The schema must derive from the exported SSOT, not a hand-written regex.
    expect(UUID_REGEX.test(VALID_UUID_V7)).toBe(true);
    expect(UUID_REGEX.test(VALID_UUID_V4)).toBe(true);
  });

  it("accepts UUID v4 and v7", () => {
    expect(webPageIdParamSchema.parse({ webPageId: VALID_UUID_V7 }).webPageId).toBe(VALID_UUID_V7);
    expect(webPageIdParamSchema.parse({ webPageId: VALID_UUID_V4 }).webPageId).toBe(VALID_UUID_V4);
  });

  it("rejects non-UUID / SQL-probe-shaped ids (reject path)", () => {
    expect(() => webPageIdParamSchema.parse({ webPageId: "not-a-uuid" })).toThrow();
    expect(() => webPageIdParamSchema.parse({ webPageId: "1; DROP TABLE web_pages" })).toThrow();
    // UUID v1 (version nibble 1) must be rejected — SSOT allows only [47]
    expect(() =>
      webPageIdParamSchema.parse({ webPageId: "11111111-2222-1333-8444-555555555555" })
    ).toThrow();
  });
});

describe("pagesQuerySchema (UB-3, CWE-770 pageSize cap)", () => {
  it("coerces and accepts in-range page/pageSize", () => {
    const parsed = pagesQuerySchema.parse({ page: "2", pageSize: "50" });
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(50);
  });

  it("applies defaults when omitted", () => {
    const parsed = pagesQuerySchema.parse({});
    expect(parsed.page).toBe(0);
    expect(parsed.pageSize).toBeGreaterThan(0);
    expect(parsed.pageSize).toBeLessThanOrEqual(100);
  });

  it("rejects pageSize > 100 (CWE-770 unbounded DoS, reject path)", () => {
    expect(() => pagesQuerySchema.parse({ pageSize: "101" })).toThrow();
    expect(() => pagesQuerySchema.parse({ pageSize: "999999" })).toThrow();
  });

  it("rejects negative page (reject path)", () => {
    expect(() => pagesQuerySchema.parse({ page: "-1" })).toThrow();
  });

  it("rejects non-numeric page/pageSize (reject path)", () => {
    expect(() => pagesQuerySchema.parse({ pageSize: "abc" })).toThrow();
  });
});

describe("partsQuerySchema (W2, UB-1(b) partType allowlist)", () => {
  it("inherits page/pageSize bounds from pagesQuerySchema", () => {
    const parsed = partsQuerySchema.parse({ page: "1", pageSize: "30" });
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(30);
    expect(parsed.partType).toBeUndefined();
  });

  it("accepts a lowercase snake_case partType", () => {
    expect(partsQuerySchema.parse({ partType: "button" }).partType).toBe("button");
    expect(partsQuerySchema.parse({ partType: "nav_link" }).partType).toBe("nav_link");
  });

  it("rejects non-allowlisted partType (uppercase / injection-shaped, reject path)", () => {
    expect(() => partsQuerySchema.parse({ partType: "Button" })).toThrow();
    expect(() => partsQuerySchema.parse({ partType: "btn; DROP TABLE component_parts" })).toThrow();
    expect(() => partsQuerySchema.parse({ partType: "a".repeat(51) })).toThrow();
    expect(() => partsQuerySchema.parse({ partType: "" })).toThrow();
  });

  it("still enforces the CWE-770 pageSize cap", () => {
    expect(() => partsQuerySchema.parse({ pageSize: "999999" })).toThrow();
  });
});

describe("similarQuerySchema (W2 human-value, UB-1 limit bound, CWE-770)", () => {
  it("coerces a numeric-string limit", () => {
    expect(similarQuerySchema.parse({ limit: "8" }).limit).toBe(8);
  });

  it("applies the default limit (6) when omitted", () => {
    expect(similarQuerySchema.parse({}).limit).toBe(6);
  });

  it("accepts the boundary values 1 and 12", () => {
    expect(similarQuerySchema.parse({ limit: "1" }).limit).toBe(1);
    expect(similarQuerySchema.parse({ limit: "12" }).limit).toBe(12);
  });

  it("rejects limit < 1 and limit > 12 (CWE-770 bound, reject path)", () => {
    expect(() => similarQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => similarQuerySchema.parse({ limit: "13" })).toThrow();
    expect(() => similarQuerySchema.parse({ limit: "999999" })).toThrow();
  });

  it("rejects non-integer / non-numeric limit (reject path)", () => {
    expect(() => similarQuerySchema.parse({ limit: "2.5" })).toThrow();
    expect(() => similarQuerySchema.parse({ limit: "abc" })).toThrow();
  });
});

describe("featuredComparisonQuerySchema (W4 dashboard, optional seed + limit bound)", () => {
  it("applies the default limit (6) and an undefined seed when both omitted", () => {
    const parsed = featuredComparisonQuerySchema.parse({});
    expect(parsed.limit).toBe(6);
    expect(parsed.seed).toBeUndefined();
  });

  it("accepts a valid UUID seed and coerces the limit", () => {
    const parsed = featuredComparisonQuerySchema.parse({ seed: VALID_UUID_V7, limit: "10" });
    expect(parsed.seed).toBe(VALID_UUID_V7);
    expect(parsed.limit).toBe(10);
  });

  it("rejects a malformed seed (reuses UUID_REGEX SSOT, reject path)", () => {
    expect(() => featuredComparisonQuerySchema.parse({ seed: "not-a-uuid" })).toThrow();
  });

  it("rejects limit out of the 1..12 CWE-770 bound (reject path)", () => {
    expect(() => featuredComparisonQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => featuredComparisonQuerySchema.parse({ limit: "13" })).toThrow();
  });
});

// =====================================================================================
// W3 search schemas (INV-WEBUI-SEARCH-INPUT-CAP-004, SEC-W3-M2). 正例 / 反例 both required.
// =====================================================================================

describe("textSearchQuerySchema (W3, INV-WEBUI-SEARCH-INPUT-CAP-004 — q max 512)", () => {
  it("accepts a non-empty q and applies section view + page bounds defaults", () => {
    const parsed = textSearchQuerySchema.parse({ q: "modern hero" });
    expect(parsed.q).toBe("modern hero");
    expect(parsed.view).toBe("section");
    expect(parsed.page).toBe(0);
    expect(parsed.pageSize).toBeLessThanOrEqual(100);
  });

  it("accepts the q boundary length (512) and the page view", () => {
    const q = "a".repeat(MAX_TEXT_QUERY_LENGTH);
    expect(textSearchQuerySchema.parse({ q, view: "page" }).q).toHaveLength(512);
    expect(textSearchQuerySchema.parse({ q: "x", view: "page" }).view).toBe("page");
  });

  it("rejects q > 512 (CWE-770, reject path)", () => {
    expect(() => textSearchQuerySchema.parse({ q: "a".repeat(513) })).toThrow();
  });

  it("rejects an empty q (reject path)", () => {
    expect(() => textSearchQuerySchema.parse({ q: "" })).toThrow();
  });

  it("rejects an unknown view enum value (reject path)", () => {
    expect(() => textSearchQuerySchema.parse({ q: "x", view: "everything" })).toThrow();
  });

  it("coerces facets and still enforces the pageSize cap", () => {
    expect(textSearchQuerySchema.parse({ q: "x", facets: "true" }).facets).toBe(true);
    expect(() => textSearchQuerySchema.parse({ q: "x", pageSize: "999999" })).toThrow();
  });
});

describe("imageSearchBodySchema (W3, SEC-W3-M2 base64 cap + image xor)", () => {
  it("derives MAX_BASE64_CHARS from the design-search decoded-byte SSOT (no magic number)", () => {
    // The char cap must be ceil(bytes * 4 / 3) of the SHARED SSOT, not a hand-written number.
    expect(MAX_BASE64_CHARS).toBe(Math.ceil((MAX_BASE64_BYTES * 4) / 3));
  });

  it("accepts a base64-only body", () => {
    const parsed = imageSearchBodySchema.parse({ image_base64: "abc123" });
    expect((parsed as { image_base64?: string }).image_base64).toBe("abc123");
  });

  it("accepts an image_url-only body (length-bounded; SSRF gate is in-handler)", () => {
    const parsed = imageSearchBodySchema.parse({ image_url: "https://example.com/a.png" });
    expect((parsed as { image_url?: string }).image_url).toBe("https://example.com/a.png");
  });

  it("rejects providing BOTH image_base64 and image_url (xor refine, reject path)", () => {
    expect(() =>
      imageSearchBodySchema.parse({ image_base64: "abc", image_url: "https://e.com/a.png" })
    ).toThrow();
  });

  it("rejects providing NEITHER (xor refine, reject path)", () => {
    expect(() => imageSearchBodySchema.parse({})).toThrow();
  });

  it("rejects a base64 string exceeding the char cap (CWE-770, reject path)", () => {
    const tooBig = "a".repeat(MAX_BASE64_CHARS + 1);
    expect(() => imageSearchBodySchema.parse({ image_base64: tooBig })).toThrow();
  });

  it("rejects an image_url longer than 2048 chars (CWE-770, reject path)", () => {
    const longUrl = "https://e.com/" + "a".repeat(MAX_URL_LENGTH);
    expect(() => imageSearchBodySchema.parse({ image_url: longUrl })).toThrow();
  });

  it("rejects a non-URL image_url (reject path)", () => {
    expect(() => imageSearchBodySchema.parse({ image_url: "not a url" })).toThrow();
  });
});

describe("similarSiteQuerySchema (W3, url max 2048 input cap)", () => {
  it("accepts a bounded url and inherits page bounds", () => {
    const parsed = similarSiteQuerySchema.parse({ url: "https://example.com" });
    expect(parsed.url).toBe("https://example.com");
    expect(parsed.pageSize).toBeLessThanOrEqual(100);
  });

  it("rejects an empty url (reject path)", () => {
    expect(() => similarSiteQuerySchema.parse({ url: "" })).toThrow();
  });

  it("rejects a url longer than 2048 chars (CWE-770, reject path)", () => {
    expect(() =>
      similarSiteQuerySchema.parse({ url: "https://e.com/" + "a".repeat(2049) })
    ).toThrow();
  });
});
