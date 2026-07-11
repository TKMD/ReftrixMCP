// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cross-page section gallery read-only shared service (WebUI v1 W7c-api — ADR-0042 Amendment 13).
 *
 * UB-4 DRY 契約: 内部 read HTTP API はこの共有 service を **直接呼ぶ** (MCP tool 層を経由
 * しない)。この service は完全 read-only — create / update / delete を一切行わない
 * (`INV-WEBUI-READONLY-NEGATIVE-001`)。dashboard / page-detail service の肥大化を避けるため、
 * cross-page gallery 系を専用ファイルに分離する。
 *
 * UB-4 DRY contract: the internal read HTTP API calls this shared service DIRECTLY (it does NOT
 * route through the MCP tool layer). This service is fully read-only and never performs any
 * create / update / delete (`INV-WEBUI-READONLY-NEGATIVE-001`). It lives in its own file to
 * avoid bloating dashboard.service / page-detail.service.
 *
 * Gallery semantics (北極星: "良いデザインのセクションを眺める"):
 *   - 母集団 = crop-bearing sections ONLY (`section_embeddings.crop_storage_path IS NOT NULL`).
 *     A section with no persisted crop is never listed (there is no `hasCrop` param — the
 *     population IS the crop-bearing set). The crop BYTES are served by the existing crop serve
 *     route (`/internal/pages/:webPageId/crops/section/:entityId`, Amendment 12) — this service
 *     is a LISTING only and introduces NO new image sink.
 *
 * PII redaction (condition 4 / CONV-1, TPA-P05 = SEC-P03 = TDA-P05 = LCC-P03) — 3 layers,
 * count/items symmetric, SSOT-derived (the PII marker value comes from the HIGH_PII SSOT and is
 * never inlined as a string literal):
 *   (i)   structural (WRITE-sink 継承): the `crop_storage_path IS NOT NULL` population filter
 *         structurally excludes high-PII sections (Phase 5 / backfill never persists a high-PII
 *         crop — fail-closed, DB-verified 0 high-PII crop-bearing sections).
 *   (ii)  belt-and-braces READ-sink: a Prisma relation filter `componentParts: { none: {
 *         piiRiskLevel: HIGH_PII } }` (the `HIGH_PII` SSOT imported from `page-detail.service`)
 *         additionally excludes any section that CONTAINS a high-PII part — symmetric with
 *         `getHighPiiSectionIds`. **The same `where` is shared by BOTH the count and the findMany
 *         query** (no asymmetry: a section counted must be a section listed, and vice versa).
 *   (iii) bytes: served by the existing crop serve route's 3-layer serve-time redaction
 *         (`INV-CROP-SERVE-PII-REDACTION-001`) — UNCHANGED by this PR (listing-only).
 *
 * @module api/internal/gallery.service
 */

import { prisma, type Prisma } from "@reftrixmcp/database";
import { HIGH_PII } from "./page-detail.service";
import { getLatestQualityByPageIds } from "./dashboard.service";

/**
 * Chrome section types (SSOT, W7c-api-2 — plan §3.3 condition 5 = TPA-P01 M). These are the
 * page-frame section types that the content-first gallery (`scope="content"`) excludes BY DEFAULT
 * (they remain reachable via an explicit `type` filter chip). This is the single source for the
 * chrome-type裁定 — the literal set is NEVER inlined at a call site (a future chrome-type change
 * touches only this constant, and the exclusion + the filter-chip UI stay coupled to it).
 */
export const CHROME_SECTION_TYPES = ["navigation", "footer", "unknown"] as const;

/**
 * Gallery scope selector (W7c-api-2). The value-set SSOT is the Zod `scope` enum in
 * `galleryQuerySchema` (`schemas.ts`); this union is TS-bridged at the route handler call site.
 * `"all"` = every crop-bearing type (the omit-time / audited W7c-api semantics, unchanged);
 * `"content"` = chrome types excluded when no explicit `type` is given.
 */
export type GalleryScope = "all" | "content";

/**
 * A single cross-page gallery section item (read-only). Unlike the page-scoped `SectionSummary`,
 * this MUST carry `webPageId` + `pageUrl` because the gallery is cross-page (the viewer builds the
 * crop URL / `reftrix:page/<webPageId>/section/<id>` handle from these). `htmlSnippet` /
 * `attributes` / `cssClasses` are intentionally NOT returned — the gallery shows the crop IMAGE
 * only, so the sanitized-markup sink is 0 (data minimization, GDPR Art.5(1)(c)).
 *
 * hand-mirror parity (Carryover TDA-P03): the webui-side mirror type is created in W7c-ui; the
 * webui/mcp-server type-shape parity check is tracked (deadline 2026-07-05), not this PR.
 */
export interface GallerySectionItem {
  /** `section_pattern_id`. */
  id: string;
  /** Owning page id — required cross-page (crop URL / handle construction). */
  webPageId: string;
  sectionType: string;
  sectionName: string | null;
  /** Owning page URL (third-party site URL — same class as recent-pages, non-PII per LCC-P07). */
  pageUrl: string;
  pageTitle: string | null;
  /**
   * Owning page's latest quality letter grade (A/B/C/D/F), or `null` when the page has no quality
   * evaluation (honest N/A — never a fabricated grade). Batched via `getLatestQualityByPageIds`
   * (condition 10 / TDA-P07: NO per-item query / N+1).
   */
  pageQualityGrade: string | null;
}

/**
 * A single section-type facet count (W7c-api-2). `count` is the number of crop-bearing sections of
 * this `sectionType` in the SAME PII-belt population as the listing (the belt EXCLUDES high-PII, so
 * a high-PII section is never counted here). The `type` / `scope` filters are NOT applied to facets,
 * so a filter chip always shows the full, stable set of real crop-bearing types.
 */
export interface GalleryFacet {
  sectionType: string;
  count: number;
}

/** A paginated cross-page gallery listing envelope. */
export interface GalleryResponse {
  page: number;
  pageSize: number;
  total: number;
  items: GallerySectionItem[];
  /**
   * Section-type facet counts (W7c-api-2) over the SAME crop-bearing + PII-belt population, with
   * NO `type` / `scope` filter applied (the chips reflect the full, stable real-type set). Count
   * descending. Returned on every page (the type cardinality is bounded to at most a dozen or so).
   * `sum(facets[].count)` equals the `total` of a `scope="all"`, no-`type` request (same `where`).
   */
  facets: GalleryFacet[];
}

/**
 * Build the SHARED `where` for the gallery count + findMany (condition 4 symmetry contract).
 * Both the population filter (crop-bearing) and the PII belt live here so `count` and `findMany`
 * can NEVER diverge (a section that is counted is a section that is listed). `HIGH_PII` is the
 * `page-detail.service` SSOT constant, never an inlined PII marker literal (CONV-1 / condition 4).
 */
function buildGalleryWhere(type?: string): Prisma.SectionPatternWhereInput {
  return {
    // (i) structural (crop-bearing 母集団): only sections whose embedding carries a persisted crop.
    embedding: { cropStoragePath: { not: null } },
    // (ii) belt-and-braces READ-sink: exclude any section that contains a high-PII part
    //      (SSOT-derived, symmetric with getHighPiiSectionIds). Applied to BOTH count + findMany.
    componentParts: { none: { piiRiskLevel: HIGH_PII } },
    // optional sectionType filter (allowlist-validated upstream by galleryQuerySchema).
    ...(type ? { sectionType: type } : {}),
  };
}

/**
 * Cross-page gallery of crop-bearing sections (read-only, offset-paginated). Zero ML.
 *
 * @param page     0-origin page index (Zod-bounded upstream).
 * @param pageSize page size (Zod-bounded ≤ 100 upstream, CWE-770; caller default 24).
 * @param type     optional sectionType filter (allowlist-validated upstream).
 * @param scope    content-first scope (W7c-api-2). `"all"` (default) = every crop-bearing type
 *                 (unchanged omit-time semantics); `"content"` excludes `CHROME_SECTION_TYPES`
 *                 ONLY when no explicit `type` is given — an explicit `type` ALWAYS wins.
 */
export async function getGallerySections(
  page: number,
  pageSize: number,
  type?: string,
  scope: GalleryScope = "all"
): Promise<GalleryResponse> {
  // condition 4 対称性契約: count と findMany が **同一の where** を共有する (単一の変数)。
  const where = buildGalleryWhere(type);
  // W7c-api-2 content-first (plan §3.3 condition 5): scope="content" は CHROME_SECTION_TYPES を
  // 既定除外する。明示 type は scope に優先 — type 明示時は buildGalleryWhere が既に sectionType を
  // pin 済 (`type === undefined` gate) なので、chrome 除外は「type 未指定 かつ scope=content」時のみ
  // 適用。count と findMany が同じ `where` object を共有する対称性は不変 (両者が使う前に合成する)。
  if (scope === "content" && type === undefined) {
    where.sectionType = { notIn: [...CHROME_SECTION_TYPES] };
  }

  const [total, rows, facetGroups] = await Promise.all([
    prisma.sectionPattern.count({ where }),
    prisma.sectionPattern.findMany({
      where,
      // Deterministic, stable cross-page order (recent-pages 慣例に整合): newest owning page
      // first, then a fully-deterministic tie-break (webPageId → positionIndex → unique id).
      orderBy: [
        { webPage: { crawledAt: "desc" } },
        { webPageId: "asc" },
        { positionIndex: "asc" },
        { id: "asc" },
      ],
      skip: page * pageSize,
      take: pageSize,
      select: {
        id: true,
        webPageId: true,
        sectionType: true,
        sectionName: true,
        // pageUrl / pageTitle — owning page (non-PII, third-party site URL class).
        webPage: { select: { url: true, title: true } },
      },
    }),
    // Facets (W7c-api-2): sectionType counts over the SAME crop-bearing + PII-belt population,
    // with NEITHER the `type` NOR the `scope` filter applied — the chips always reflect the full,
    // stable set of real crop-bearing types. `buildGalleryWhere(undefined)` reuses the exact belt
    // (structural crop-bearing + high-PII exclusion) so a high-PII section never enters a count,
    // and `sum(facets[].count) === total` for a scope="all"/no-type request (identical `where`).
    prisma.sectionPattern.groupBy({
      by: ["sectionType"],
      where: buildGalleryWhere(undefined),
      _count: { _all: true },
    }),
  ]);

  // condition 10 / TDA-P07: ONE batched page→grade join for ALL owning pages (no per-item / N+1).
  const pageIds = [...new Set(rows.map((row) => row.webPageId))];
  const qualityByPageId = await getLatestQualityByPageIds(pageIds);

  const items: GallerySectionItem[] = rows.map((row) => ({
    id: row.id,
    webPageId: row.webPageId,
    sectionType: row.sectionType,
    sectionName: row.sectionName,
    pageUrl: row.webPage.url,
    pageTitle: row.webPage.title,
    // Honest N/A: a page with no quality evaluation → null (never a fabricated grade).
    pageQualityGrade: qualityByPageId.get(row.webPageId)?.grade ?? null,
  }));

  // Count descending (dashboard.service mood-distribution 慣例に整合); honest empty [] when the
  // crop-bearing corpus is empty (never fabricated).
  const facets: GalleryFacet[] = facetGroups
    .map((group) => ({ sectionType: group.sectionType, count: group._count._all }))
    .sort((a, b) => b.count - a.count);

  return { page, pageSize, total, items, facets };
}
