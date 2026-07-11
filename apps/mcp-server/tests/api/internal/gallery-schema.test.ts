// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-WEBUI-GALLERY-QUERY-BOUND + rate-limit 3-site (WebUI v1 W7c-api — ADR-0042 Amendment 13).
 *
 * `galleryQuerySchema` の入力境界を Zod で検証する (partsQuerySchema と同 rigor):
 * - pageSize ≤ 100 (CWE-770 unbounded-result DoS prevention)
 * - `type` = section-type allowlist regex (自由文字列 reject = injection 面 0)
 *
 * また condition 9 / CONV-2 (TPA-P08 = SEC-P01) の rate-limit tier wiring を code 2-site で pin:
 * - `TOOL_TIER_MAP.internal_sections === "search"` (rate-limiter.ts)
 * - server.ts の gallery route に `internalRateLimit("internal_sections")` 配線
 * (3rd site = docs tier table は `pnpm docs:verify` Section 4 が enforce する。)
 *
 * 正例 / 反例 both required (no vacuous green).
 *
 * @module tests/api/internal/gallery-schema
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { galleryQuerySchema, GALLERY_SECTION_TYPE_RE } from "../../../src/api/internal/schemas";
import { TOOL_TIER_MAP } from "../../../src/middleware/rate-limiter";

describe("INV-WEBUI-GALLERY-QUERY-BOUND: galleryQuerySchema (W7c-api, CWE-770 + type allowlist)", () => {
  it("inherits page/pageSize bounds from pagesQuerySchema (coerce + accept in-range)", () => {
    const parsed = galleryQuerySchema.parse({ page: "2", pageSize: "24" });
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(24);
    expect(parsed.type).toBeUndefined();
  });

  it("applies page/pageSize defaults + undefined type when omitted", () => {
    const parsed = galleryQuerySchema.parse({});
    expect(parsed.page).toBe(0);
    expect(parsed.pageSize).toBeGreaterThan(0);
    expect(parsed.pageSize).toBeLessThanOrEqual(100);
    expect(parsed.type).toBeUndefined();
  });

  it("rejects pageSize > 100 (CWE-770 unbounded DoS, reject path)", () => {
    expect(() => galleryQuerySchema.parse({ pageSize: "101" })).toThrow();
    expect(() => galleryQuerySchema.parse({ pageSize: "999999" })).toThrow();
  });

  it("rejects negative / non-numeric page (reject path)", () => {
    expect(() => galleryQuerySchema.parse({ page: "-1" })).toThrow();
    expect(() => galleryQuerySchema.parse({ pageSize: "abc" })).toThrow();
  });

  it("accepts real section_type allowlist tokens incl. hyphens/digits (call-to-action etc.)", () => {
    // Real crop-bearing section_type data carries hyphens (`call-to-action`), digits and a
    // lowercase-letter head — the allowlist admits these but NOTHING else.
    for (const t of ["hero", "feature", "call-to-action", "cta", "faq", "a".repeat(50)]) {
      expect(galleryQuerySchema.parse({ type: t }).type).toBe(t);
    }
    // The regex is the SSOT for the token shape (space/hyphen/digit body, lowercase head).
    expect(GALLERY_SECTION_TYPE_RE.test("call-to-action")).toBe(true);
    expect(GALLERY_SECTION_TYPE_RE.test("hero section 2")).toBe(true);
  });

  it("rejects non-allowlist type: uppercase / traversal / injection / over-length / empty / digit-head (reject path)", () => {
    expect(() => galleryQuerySchema.parse({ type: "Hero" })).toThrow(); // uppercase head
    expect(() => galleryQuerySchema.parse({ type: "../hero" })).toThrow(); // path traversal
    expect(() => galleryQuerySchema.parse({ type: "hero; DROP TABLE section_patterns" })).toThrow(); // injection (;)
    expect(() => galleryQuerySchema.parse({ type: "hero'" })).toThrow(); // quote
    expect(() => galleryQuerySchema.parse({ type: "a".repeat(51) })).toThrow(); // > 50 chars (CWE-770)
    expect(() => galleryQuerySchema.parse({ type: "" })).toThrow(); // empty
    expect(() => galleryQuerySchema.parse({ type: "1hero" })).toThrow(); // digit head (must start [a-z])
  });
});

describe("rate-limit 3-site (W7c-api, condition 9 / CONV-2 = TPA-P08 = SEC-P01): internal_sections search tier", () => {
  it("code site 1 — TOOL_TIER_MAP.internal_sections === 'search' (rate-limiter.ts)", () => {
    // An unmapped key silently falls to `default` (60 RPM); this explicit wiring pins `search`.
    expect(TOOL_TIER_MAP.internal_sections).toBe("search");
  });

  it("code site 2 — server.ts wires internalRateLimit('internal_sections') on the /internal/sections route", () => {
    const serverSrc = fs.readFileSync(
      path.resolve(__dirname, "../../../src/api/internal/server.ts"),
      "utf8"
    );
    expect(/internalRateLimit\(["']internal_sections["']\)/.test(serverSrc)).toBe(true);
    expect(serverSrc.includes('"/internal/sections"')).toBe(true);
  });
});

describe("INV-WEBUI-GALLERY-QUERY-BOUND: galleryQuerySchema.scope (W7c-api-2, content-first enum)", () => {
  it("defaults scope to 'all' when omitted — omit-time semantics unchanged (accept path)", () => {
    // Non-regression of the audited W7c-api contract: an omitted scope resolves to "all" (all types).
    expect(galleryQuerySchema.parse({}).scope).toBe("all");
    // …and it stays "all" even when other params are present (scope is independent of type/page).
    expect(galleryQuerySchema.parse({ type: "hero", page: "1", pageSize: "24" }).scope).toBe("all");
  });

  it("accepts the two enum members all | content (accept path)", () => {
    expect(galleryQuerySchema.parse({ scope: "all" }).scope).toBe("all");
    expect(galleryQuerySchema.parse({ scope: "content" }).scope).toBe("content");
    // scope is orthogonal to type — an explicit type coexists with scope (precedence is a service
    // concern; the schema only bounds the shape).
    expect(galleryQuerySchema.parse({ scope: "content", type: "navigation" }).scope).toBe(
      "content"
    );
  });

  it("rejects non-enum scope: unknown token / case / empty / injection (reject path)", () => {
    expect(() => galleryQuerySchema.parse({ scope: "chrome" })).toThrow(); // not an enum member
    expect(() => galleryQuerySchema.parse({ scope: "Content" })).toThrow(); // case-sensitive
    expect(() => galleryQuerySchema.parse({ scope: "ALL" })).toThrow(); // case-sensitive
    expect(() => galleryQuerySchema.parse({ scope: "" })).toThrow(); // empty
    expect(() => galleryQuerySchema.parse({ scope: "content; DROP TABLE x" })).toThrow(); // injection
    expect(() => galleryQuerySchema.parse({ scope: 1 })).toThrow(); // wrong type
  });
});
