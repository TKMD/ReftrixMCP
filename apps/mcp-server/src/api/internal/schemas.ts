// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Internal read HTTP API — Zod input-boundary schemas (WebUI v1 W1).
 *
 * UB-3 / FIND-IO-PLAN-M-03 (ADR-0042 Decision 8): every read API endpoint validates
 * its input bounds with Zod.
 * - webPageId = reuse the canonical UUID_REGEX SSOT (UUID v4/v7 only).
 * - pageSize ≤ 100 (CWE-770 unbounded DoS prevention).
 * - page = non-negative integer.
 *
 * Only the W1 endpoints (dashboard / pages) are bounded here. Search / compare schemas
 * are W3 / W4 scope and intentionally NOT pre-defined (no scope pull-forward).
 *
 * @module api/internal/schemas
 */

import { z } from "zod";
import { UUID_REGEX } from "../../services/screenshot-persistence.service";
// SEC-W3-M2 (FIND IO open Q#2): the image base64 byte cap is the design-search SSOT,
// re-used here so the internal-API image route shares ONE cap value with the MCP tool
// path (no second magic number). The Zod char cap derives from it (§ imageSearchBodySchema).
import { MAX_BASE64_BYTES } from "../../tools/design/search-by-image.tool";

/** Maximum page size — CWE-770 unbounded-result DoS prevention. */
export const MAX_PAGE_SIZE = 100;

/** Default page size when omitted. */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Path-param schema for any endpoint that receives a `webPageId`.
 * Reuses the canonical `UUID_REGEX` SSOT (no second regex definition).
 */
export const webPageIdParamSchema = z.object({
  webPageId: z.string().regex(UUID_REGEX, "webPageId must be a UUID v4/v7"),
});

/** Inferred type for the validated `webPageId` path param. */
export type WebPageIdParam = z.infer<typeof webPageIdParamSchema>;

/**
 * Path-param schema for the crop serve route `GET /internal/pages/:webPageId/crops/:kind/:entityId`
 * (W6 Issue A PR-4a). All 3 params bounded: webPageId + entityId reuse the canonical
 * `UUID_REGEX` SSOT (no 2nd regex), `kind` is a fixed enum (section | part) so it is NOT
 * a free-string and cannot drive an arbitrary kind-routed query. A malformed param → 400
 * status-only (binary route, no JSON leak).
 */
export const cropParamsSchema = z.object({
  webPageId: z.string().regex(UUID_REGEX, "webPageId must be a UUID v4/v7"),
  kind: z.enum(["section", "part"]),
  entityId: z.string().regex(UUID_REGEX, "entityId must be a UUID v4/v7"),
});

/** Inferred type for the validated crop path params. */
export type CropParams = z.infer<typeof cropParamsSchema>;

/**
 * Query schema for paginated page listings.
 * `page` and `pageSize` arrive as query strings, so they are coerced to numbers.
 */
export const pagesQuerySchema = z.object({
  page: z.coerce.number().int().nonnegative().default(0),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

/** Inferred type for the validated pages query. */
export type PagesQuery = z.infer<typeof pagesQuerySchema>;

/**
 * Query schema for the paginated parts listing (W2, ADR-0042 Amendment 1 §A1.1 / UB-1(b)).
 * Inherits the `pagesQuerySchema` bounds (`pageSize ≤ 100`, CWE-770) and adds an optional
 * `partType` filter. `part_type` is a VARCHAR(50) enum-like value, so it is bounded to a
 * lowercase-snake allowlist regex (`/^[a-z_]{1,50}$/`) — user input is NOT free-string,
 * preventing injection-shaped filter values from reaching the Prisma where clause.
 */
export const partsQuerySchema = pagesQuerySchema.extend({
  partType: z
    .string()
    .regex(/^[a-z_]{1,50}$/, "partType must be a lowercase snake_case token (≤50 chars)")
    .optional(),
});

/** Inferred type for the validated parts query. */
export type PartsQuery = z.infer<typeof partsQuerySchema>;

/**
 * Section-type token allowlist for the cross-page gallery `type` filter (W7c-api, ADR-0042
 * Amendment 13). Unlike `partType` (`/^[a-z_]{1,50}$/`), the real `section_type` data carries
 * digits, spaces and hyphens (e.g. `call-to-action`), so this allowlist permits `[a-z0-9 _-]`
 * after a mandatory lowercase-letter head, capped at 50 chars total. It is still an ALLOWLIST
 * (NOT a free string): no quotes / semicolons / uppercase / control chars can pass, so an
 * injection-shaped filter value never reaches the Prisma where clause (SQL-injection surface 0).
 * Enum normalization of the noisy `section_type` values (`cte`, `testimonials`) is tracked
 * separately as Carryover TDA-P04 (not this PR).
 */
export const GALLERY_SECTION_TYPE_RE = /^[a-z][a-z0-9 _-]{0,49}$/;

/**
 * Query schema for `GET /internal/sections` (cross-page section gallery, W7c-api, ADR-0042
 * Amendment 13). Inherits the `pagesQuerySchema` bounds (`pageSize ≤ 100`, CWE-770; caller
 * defaults `pageSize` to 24) and adds an optional `type` sectionType filter bounded to the
 * `GALLERY_SECTION_TYPE_RE` allowlist. Same rigor as `partsQuerySchema`.
 *
 * W7c-api-2 (additive follow-up, plan §3.3 condition 5 = TPA-P01 M) — closes the §4 API
 * under-specification: the `scope` content-first param. `"all"` is the DEFAULT, so the omit-time
 * semantics are EXACTLY the audited W7c-api contract (all crop-bearing types are listed).
 * `scope="content"` excludes the chrome section types (`CHROME_SECTION_TYPES` SSOT in
 * `gallery.service`) ONLY when no explicit `type` is given; an explicit `type` ALWAYS wins over
 * scope (a filter chip's `?type=navigation` reaches that chrome type regardless of scope). `scope`
 * is an ENUM (NOT a free string): an out-of-set value is rejected at the seam (injection surface 0).
 */
export const galleryQuerySchema = pagesQuerySchema.extend({
  type: z
    .string()
    .regex(GALLERY_SECTION_TYPE_RE, "type must be a section-type token (≤50 chars, allowlist)")
    .optional(),
  scope: z.enum(["all", "content"]).default("all"),
});

/** Inferred type for the validated gallery query. */
export type GalleryQuery = z.infer<typeof galleryQuerySchema>;

/** Maximum similar-design result count — CWE-770 unbounded-result DoS prevention. */
export const MAX_SIMILAR_LIMIT = 12;

/** Default similar-design result count when omitted. */
export const DEFAULT_SIMILAR_LIMIT = 6;

/**
 * Query schema for the similar-design nearest-neighbor listing (W2 human-value rework, UB-1).
 * `limit` arrives as a query string, so it is coerced; it is bounded to 1..12 (CWE-770) with a
 * default of 6. The source `webPageId` is the path param (`webPageIdParamSchema`), not here.
 */
export const similarQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_SIMILAR_LIMIT).default(DEFAULT_SIMILAR_LIMIT),
});

/** Inferred type for the validated similar query. */
export type SimilarQuery = z.infer<typeof similarQuerySchema>;

// =====================================================================================
// W4 dashboard redesign — featured-comparison route (additive read-only). Picks a deterministic
// embedding-bearing seed page + its top-N pgvector neighbors (zero ML; reuses getSimilarDesigns).
// An optional `seed` query param overrides the auto-picked seed (UUID_REGEX SSOT); `limit` reuses
// the similar 1..12 bound (CWE-770). A seed page with no embedding → honest empty (not faked).
// =====================================================================================

/**
 * Query schema for `GET /internal/dashboard/featured-comparison`. Both params optional: `seed`
 * (the comparison source webPageId — UUID_REGEX SSOT; omitted → deterministic auto-pick) and
 * `limit` (neighbor count, reusing the similar 1..12 CWE-770 bound with default 6).
 */
export const featuredComparisonQuerySchema = z.object({
  seed: z.string().regex(UUID_REGEX, "seed must be a UUID v4/v7").optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SIMILAR_LIMIT).default(DEFAULT_SIMILAR_LIMIT),
});

/** Inferred type for the validated featured-comparison query. */
export type FeaturedComparisonQuery = z.infer<typeof featuredComparisonQuerySchema>;

// =====================================================================================
// W3 — search routes (ADR-0042 Amendment 2 / ADR-0043 fail-loud). 案b = handler 直呼び。
// W3 search routes. The internal API binds an explicit input boundary BEFORE the adapter
// reaches the shared handlers (defense-in-depth: a malformed search input is rejected with
// 400 at the seam, never reaching the embedding/DB path). SEC-W3-* landings:
//   - q max 512 / url max 2048 / image_base64 byte cap (CWE-770, SEC-W3-M2/INPUT-CAP-004).
//   - image_url stays a real SSRF surface, validated in-handler (validateExternalUrl +
//     redirect:"manual"); the schema only bounds its length (SEC-W3-H2 lands in code).
// =====================================================================================

/** Maximum text-search query length — CWE-770 over-large embedding/search load prevention. */
export const MAX_TEXT_QUERY_LENGTH = 512;

/** Maximum URL length (image_url / similar-site url) — CWE-770 unbounded-input prevention. */
export const MAX_URL_LENGTH = 2048;

/**
 * Maximum base64 *character* length for the image route, derived from the design-search
 * decoded-byte SSOT (`MAX_BASE64_BYTES`). Base64 inflates bytes by 4/3, so the char cap is
 * `ceil(bytes * 4 / 3)` — a Zod-level reject for an over-large string BEFORE it is decoded
 * (CWE-770 / SEC-W3-M2). The authoritative decoded-byte check still happens inside the
 * design-search handler (`decodeBase64Image`); this is the cheap upstream guard.
 */
export const MAX_BASE64_CHARS = Math.ceil((MAX_BASE64_BYTES * 4) / 3);

/**
 * Query schema for `GET /internal/search/text?q=...` (text semantic search).
 * `view` selects the section/page tab; `facets` opts into facet counts (ADR-0043 aggregator
 * `include_facets`). `page`/`pageSize` reuse the CWE-770-bounded `pagesQuerySchema` shape.
 */
export const textSearchQuerySchema = pagesQuerySchema.extend({
  /** Search query (1..512 chars, CWE-770). */
  q: z.string().min(1).max(MAX_TEXT_QUERY_LENGTH),
  /** Section/page tab. Defaults to section view (the layout-section search target). */
  view: z.enum(["section", "page"]).default("section"),
  /** Opt into facet counts (sectionType/industry/audience/tags). */
  facets: z.coerce.boolean().optional(),
});

/** Inferred type for the validated text-search query. */
export type TextSearchQuery = z.infer<typeof textSearchQuerySchema>;

/**
 * Body schema for `POST /internal/search/image` (image-to-design search).
 * Accepts EITHER a base64 image XOR an image URL (xor enforced via `.refine`). The base64
 * char cap derives from the decoded-byte SSOT (CWE-770 / SEC-W3-M2). `image_url` keeps its
 * length bound here; its SSRF gate (validateExternalUrl + redirect:"manual") is in-handler
 * (SEC-W3-H2). This is a read-only search transport — POST carries the base64 body that
 * cannot ride a GET query; it performs NO DB write (INV-WEBUI-SEARCH-READONLY-007).
 */
export const imageSearchBodySchema = pagesQuerySchema
  .extend({
    /** Base64 image data (data: URI prefix allowed). Byte cap re-checked at decode time. */
    image_base64: z.string().min(1).max(MAX_BASE64_CHARS).optional(),
    /** Image URL (HTTPS). Real SSRF surface — validated in-handler, not just length-bounded. */
    image_url: z.string().url().max(MAX_URL_LENGTH).optional(),
    /** Optional hybrid text query (1..512 chars, RRF 3-source). */
    query: z.string().min(1).max(MAX_TEXT_QUERY_LENGTH).optional(),
  })
  .refine(
    (data) => Boolean(data.image_base64) !== Boolean(data.image_url),
    "exactly one of image_base64 or image_url is required"
  );

/** Inferred type for the validated image-search body. */
export type ImageSearchBody = z.infer<typeof imageSearchBodySchema>;

/**
 * Query schema for `GET /internal/search/similar-site?url=...` (similar-site search).
 * `url` is DB-only (input-validation, NOT a fetch SSRF surface — LCC-W3-W1): the handler
 * routes it through `validateExternalUrl` (URL-input validation preserved by 案b) before the
 * DB-only `searchSimilarSites`. Length bound is CWE-770.
 */
export const similarSiteQuerySchema = pagesQuerySchema.extend({
  /** Target URL (must exist in web_pages DB; unanalyzed → empty/404 honest, not fake). */
  url: z.string().min(1).max(MAX_URL_LENGTH),
});

/** Inferred type for the validated similar-site query. */
export type SimilarSiteQuery = z.infer<typeof similarSiteQuerySchema>;

// =====================================================================================
// W4 — compare route (ADR-0042 Amendment 7 / Registry F-PLAN-W4-A/B). Defense-in-depth boundary:
// a malformed compare body is rejected with 400 at the seam, never reaching the design-compare DB
// path. This is a SEPARATE definition (NOT importing the tool's `designCompareInputSchema`) because
// the internal API MUST use the canonical `UUID_REGEX` SSOT — the tool schema uses a local
// `UUID_PATTERN` (a non-SSOT regex). The field names + bounds are kept identical to
// `designCompareInputSchema`; the no-drift contract is pinned EXECUTABLY by `compare-schema.test.ts`
// (the dimension enum === the service `ALL_DIMENSIONS` SSOT; the 2..5 / 1..4 bounds === the tool
// schema) rather than via import coupling that would drag in the wrong (non-SSOT) regex. (OQ#4.)
// =====================================================================================

/** Minimum pages per compare request (固定 2-5 page batch; matches `designCompareInputSchema`). */
export const COMPARE_MIN_PAGES = 2;

/** Maximum pages per compare request — CWE-770 batch cap (matches `designCompareInputSchema`). */
export const COMPARE_MAX_PAGES = 5;

/**
 * Comparison dimensions — SSOT-equivalent to `ALL_DIMENSIONS` in `design-compare.service.ts`. Kept
 * as a literal tuple here (Zod `z.enum` needs a literal); a drift test pins this tuple ===
 * `ALL_DIMENSIONS` so a future enum change in either place cannot silently diverge.
 */
export const COMPARE_DIMENSIONS = ["layout", "visual", "quality", "color"] as const;

/**
 * Maximum JSON body bytes for the compare route — CWE-770. 5 UUIDs (36 chars each) + the dimensions
 * enum + a small JSON envelope fit well under 1 KiB; capped generously at 4 KiB so the route-scoped
 * `express.json({ limit })` rejects an over-large body cheaply (after the rate limiter).
 */
export const MAX_COMPARE_BODY_BYTES = 4096;

/**
 * Body schema for `POST /internal/compare` (design.compare). `page_ids` 2..5 (UUID_REGEX SSOT);
 * `dimensions` optional 1..4 enum (the handler defaults to all 4 when omitted); `include_details`
 * optional (the handler defaults false). Duplicate `page_ids` are rejected by the handler's `Set`
 * check (DRY) — the boundary only enforces the array bounds. Read-only transport: POST carries the
 * `page_ids` array that cannot ride a GET query; it performs NO DB write.
 */
export const compareBodySchema = z.object({
  page_ids: z
    .array(z.string().regex(UUID_REGEX, "page_id must be a UUID v4/v7"))
    .min(COMPARE_MIN_PAGES)
    .max(COMPARE_MAX_PAGES),
  dimensions: z.array(z.enum(COMPARE_DIMENSIONS)).min(1).max(COMPARE_DIMENSIONS.length).optional(),
  include_details: z.boolean().optional(),
});

/** Inferred type for the validated compare body. */
export type CompareBody = z.infer<typeof compareBodySchema>;
