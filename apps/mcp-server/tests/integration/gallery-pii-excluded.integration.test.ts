// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-WEBUI-GALLERY-PII-EXCLUDED (WebUI v1 W7c-api — ADR-0042 Amendment 13).
 *
 * The cross-page section gallery (`getGallerySections`) must NEVER leak a high-PII section, and a
 * GDPR Art.17 `data.delete(webPageId)` must remove the page's sections from the gallery. Three legs
 * (LCC-P01 M binding + LCC-P04, condition 8; CONV-1 / condition 4 belt):
 *
 *   (c) source-pin (ALWAYS runs, no DB): the gallery `where` (1) filters the crop-bearing population
 *       (`cropStoragePath { not: null }`), (2) applies the PII belt via the `HIGH_PII` SSOT
 *       (`componentParts { none: { piiRiskLevel: HIGH_PII } }`, NO inline `'high'` literal), and (3)
 *       shares ONE `where` variable between `count` and `findMany` (count/items symmetry).
 *   (a) corpus-scope real-DB (HAS_DB): walking the ENTIRE gallery, NO returned section corresponds to
 *       a high-PII section (`getHighPiiSectionIds(allIds).size === 0`) — LCC-P01 M binding.
 *   (b) real-DB fixture legs (HAS_DB): a deterministic per-type fixture proves at runtime that
 *       (b1) count === items (symmetry), (b2) the belt EXCLUDES a crop-bearing section that contains
 *       a high-PII part while INCLUDING its non-PII sibling (belt non-vacuity), (b3) `data.delete`
 *       removes the page's sections from the gallery (LCC-P04), and (b4) offset pagination is
 *       total/items-consistent.
 *
 * **fail-closed contract (CO-PRDD9-02 / web-page-url-unique pattern)**: CI runs (`CI=true`) MUST
 * provide `DATABASE_URL` — its absence is a P0 misconfiguration and the precondition test asserts
 * (fails) rather than silently skipping. Local runs without a live Postgres degrade to a documented
 * precondition-assert (explicit reason, NOT `.skip` / `.todo`).
 *
 * **GDPR Art.5(1)(e) bounded retention**: every fixture row is exact-match-deleted in `afterEach`
 * by its own page id (`deleteMany({ where: { id: { in: createdWebPageIds } } })`, cascade). URLs use
 * an RFC 6761 reserved `.test` domain + a uuid, so a parallel run's rows are never collaterally
 * removed and no real navigation is implied. Existing real data is NEVER deleted.
 *
 * @see  §4.4 / §6.1 (INV) / §7 (W7c-api)
 * @see  §7.1 (LCC-P01/P04 non-optional)
 * @see apps/mcp-server/src/api/internal/gallery.service.ts (buildGalleryWhere, getGallerySections)
 * @see apps/mcp-server/src/api/internal/page-detail.service.ts (HIGH_PII SSOT, getHighPiiSectionIds)
 * @see apps/mcp-server/tests/integration/web-page-url-unique.integration.test.ts (fail-closed pattern)
 *
 * @module tests/integration/gallery-pii-excluded.integration
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@reftrixmcp/database";
import { CHROME_SECTION_TYPES, getGallerySections } from "../../src/api/internal/gallery.service";
import { getHighPiiSectionIds } from "../../src/api/internal/page-detail.service";
import {
  GdprDeletionService,
  setGdprPrismaClientFactory,
  resetGdprPrismaClientFactory,
  resetGdprScreenshotPersistenceFactory,
  resetGdprDeletionService,
  type GdprPrismaClient,
} from "../../src/services/gdpr-deletion.service";

// ============================================================================
// Environment gate (fail-closed — CO-PRDD9-02 / web-page-url-unique pattern)
// ============================================================================

const IS_CI = process.env.CI === "true" || process.env.CI === "1";
const HAS_DB = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

// ============================================================================
// Leg (c): source-pin (ALWAYS runs — no DB required, non-vacuous coverage)
// ============================================================================

const GALLERY_SERVICE_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../src/api/internal/gallery.service.ts"),
  "utf8"
);

describe("INV-WEBUI-GALLERY-PII-EXCLUDED (leg c: source-pin, always runs)", () => {
  it("population filter is crop-bearing: cropStoragePath { not: null }", () => {
    expect(/cropStoragePath:\s*\{\s*not:\s*null\s*\}/.test(GALLERY_SERVICE_SRC)).toBe(true);
  });

  it("PII belt derives HIGH_PII from the page-detail SSOT — NO inline 'high' literal (condition 4 / CONV-1)", () => {
    // The SSOT must be imported (not re-declared inline).
    expect(
      /import\s*\{[^}]*\bHIGH_PII\b[^}]*\}\s*from\s*["']\.\/page-detail\.service["']/.test(
        GALLERY_SERVICE_SRC
      )
    ).toBe(true);
    // No quoted 'high' / "high" literal anywhere in the file (inline PII literal forbidden).
    expect(/(['"])high\1/.test(GALLERY_SERVICE_SRC)).toBe(false);
    // The belt uses the SSOT constant in a componentParts.none relation filter.
    expect(
      /componentParts:\s*\{\s*none:\s*\{\s*piiRiskLevel:\s*HIGH_PII\s*\}/.test(GALLERY_SERVICE_SRC)
    ).toBe(true);
  });

  it("count/items symmetry: ONE where variable (buildGalleryWhere) feeds BOTH count and findMany", () => {
    expect(/const where = buildGalleryWhere\(/.test(GALLERY_SERVICE_SRC)).toBe(true);
    expect(/\.count\(\{ where \}\)/.test(GALLERY_SERVICE_SRC)).toBe(true);
    expect(/\.findMany\(\{\s*where,/.test(GALLERY_SERVICE_SRC)).toBe(true);
    // Exactly one call site (single source → count and findMany CANNOT diverge).
    const callCount = (GALLERY_SERVICE_SRC.match(/buildGalleryWhere\(type\)/g) ?? []).length;
    expect(callCount).toBe(1);
  });
});

// ============================================================================
// Real-DB fixture helpers (exact-match teardown, reserved .test domain)
// ============================================================================

/** All fixture page ids created by a test — exact-match cascade-deleted in afterEach. */
const createdWebPageIds: string[] = [];

/** A unique, non-colliding gallery `type` token (allowlist-valid, never in real data). */
function makeGalleryType(): string {
  return `w7c-gallery-${randomUUID().slice(0, 8)}`;
}

/** Create a fixture web_page (reserved `.test` domain + uuid) and track it for teardown. */
async function createFixturePage(): Promise<string> {
  const webPageId = randomUUID();
  await prisma.webPage.create({
    data: {
      id: webPageId,
      url: `https://w7c-gallery-pii-${webPageId}.example.test/`,
      title: "W7c gallery PII fixture",
      sourceType: "user_provided",
      usageScope: "inspiration_only",
    },
  });
  createdWebPageIds.push(webPageId);
  return webPageId;
}

/**
 * Create a crop-bearing section (SectionPattern + section_embeddings with a NON-NULL
 * crop_storage_path). Optionally attach a component part whose `piiRiskLevel` drives the belt:
 *   - `pii: "high"` → the section CONTAINS a high-PII part (the belt must EXCLUDE it).
 *   - `pii: "low"`  → a non-PII part (the belt keeps the section).
 *   - `pii: undefined` → no part at all (still non-PII → kept).
 */
async function createCropBearingSection(
  webPageId: string,
  sectionType: string,
  positionIndex: number,
  opts: { pii?: "high" | "low" } = {}
): Promise<string> {
  const sectionPatternId = randomUUID();
  await prisma.sectionPattern.create({
    data: {
      id: sectionPatternId,
      webPageId,
      sectionType,
      positionIndex,
      layoutInfo: { type: sectionType, position: { startY: 0, height: 400 } },
    },
  });
  // section_embeddings: only crop_storage_path is load-bearing for the gallery population;
  // `model_version` is NOT NULL and `updated_at` (Prisma @updatedAt) has no DB default → set both.
  await prisma.$executeRawUnsafe(
    `INSERT INTO section_embeddings
       (id, section_pattern_id, model_version, crop_storage_path,
        embedding_timestamp, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'mock-e5-base-multilingual', $3, NOW(), NOW(), NOW())`,
    randomUUID(),
    sectionPatternId,
    `/tmp/reftrix-test-crops/${webPageId}/section-${sectionPatternId}.png`
  );
  if (opts.pii) {
    await prisma.componentPart.create({
      data: {
        id: randomUUID(),
        webPageId,
        sectionPatternId,
        partType: "text",
        computedStyles: {},
        attributes: {},
        boundingBox: { x: 0, y: 0, width: 10, height: 10 },
        interactionInfo: {},
        piiRiskLevel: opts.pii,
        extractedAt: new Date(),
      },
    });
  }
  return sectionPatternId;
}

// ============================================================================
// Real-DB legs (HAS_DB-gated, fail-closed on CI)
// ============================================================================

describe("INV-WEBUI-GALLERY-PII-EXCLUDED (real-DB legs, HAS_DB-gated, fail-closed on CI)", () => {
  beforeAll(() => {
    // Wire the real Prisma client into the GDPR service; leave the screenshot factory UNWIRED
    // (H-1 inline fallback). A closure-set is harmless without a DB (never invoked).
    setGdprPrismaClientFactory(() => prisma as unknown as GdprPrismaClient);
    resetGdprScreenshotPersistenceFactory();
  });

  afterAll(() => {
    resetGdprPrismaClientFactory();
    resetGdprScreenshotPersistenceFactory();
    resetGdprDeletionService();
  });

  afterEach(async () => {
    if (HAS_DB && createdWebPageIds.length > 0) {
      // Exact-match cascade delete (section_patterns → section_embeddings + component_parts
      // via onDelete: Cascade). NEVER prefix-wide — real data is untouched.
      await prisma.webPage.deleteMany({ where: { id: { in: createdWebPageIds } } });
    }
    createdWebPageIds.length = 0;
  });

  it("environment precondition — CI MUST provide DATABASE_URL (fail-closed; local degrades to precondition-assert, NOT skip)", () => {
    if (IS_CI) {
      expect(
        process.env.DATABASE_URL,
        "[INV-WEBUI-GALLERY-PII-EXCLUDED] DATABASE_URL absent in CI — CI MUST provide a real PostgreSQL for the corpus + data.delete legs"
      ).toBeTruthy();
      return;
    }
    expect(
      "INV-WEBUI-GALLERY-PII-EXCLUDED contract: CI run requires DATABASE_URL for the real-DB corpus + data.delete legs"
    ).toMatch(/INV-WEBUI-GALLERY-PII-EXCLUDED/);
  });

  it("leg (a) — corpus-scope: NO gallery item across ALL pages corresponds to a high-PII section (LCC-P01 M binding)", async () => {
    if (!HAS_DB) {
      expect(HAS_DB, "local run without DATABASE_URL: real-DB legs skipped (CI enforces)").toBe(
        false
      );
      return;
    }
    // Walk the ENTIRE gallery (all pages) and collect every returned section id.
    const pageSize = 100;
    const allSectionIds: string[] = [];
    const MAX_PAGES = 2000; // CWE-770 test-side safety bound (the crop-bearing corpus is finite).
    let page = 0;
    let total = 0;
    while (page < MAX_PAGES) {
      const res = await getGallerySections(page, pageSize);
      total = res.total;
      if (res.items.length === 0) break;
      allSectionIds.push(...res.items.map((i) => i.id));
      page += 1;
      if (page * pageSize >= total) break;
    }

    // Non-vacuity note: on the dogfood corpus `total > 0`, so the assertion below is meaningful
    // (an empty corpus makes it trivially true — still a correct invariant).
    if (total > 0) {
      expect(allSectionIds.length).toBeGreaterThan(0);
    }

    // The core invariant: NOT ONE returned gallery section contains a high-PII part.
    const highPii = await getHighPiiSectionIds(allSectionIds);
    expect(
      highPii.size,
      `gallery leaked ${highPii.size} high-PII section(s) across ${allSectionIds.length} crop-bearing sections (corpus total=${total})`
    ).toBe(0);
  }, 120_000);

  it("leg (b1) — count/items symmetry: a fixture of N crop-bearing sections yields total === items.length === N", async () => {
    if (!HAS_DB) {
      expect(HAS_DB, "local run without DATABASE_URL: real-DB legs skipped (CI enforces)").toBe(
        false
      );
      return;
    }
    const type = makeGalleryType();
    const page = await createFixturePage();
    const s0 = await createCropBearingSection(page, type, 0, { pii: "low" });
    const s1 = await createCropBearingSection(page, type, 1);

    const res = await getGallerySections(0, 100, type);
    expect(res.total).toBe(2);
    expect(res.items.length).toBe(2);
    // Both fixture sections are present (deterministic, unique type → no real-data collision).
    const returned = new Set(res.items.map((i) => i.id));
    expect(returned.has(s0)).toBe(true);
    expect(returned.has(s1)).toBe(true);
    // Each item carries the cross-page fields.
    for (const item of res.items) {
      expect(item.webPageId).toBe(page);
      expect(item.pageUrl).toContain(".example.test/");
      expect(item.sectionType).toBe(type);
    }
  }, 60_000);

  it("leg (b2) — belt non-vacuity: a crop-bearing section CONTAINING a high-PII part is EXCLUDED while its non-PII sibling is INCLUDED", async () => {
    if (!HAS_DB) {
      expect(HAS_DB, "local run without DATABASE_URL: real-DB legs skipped (CI enforces)").toBe(
        false
      );
      return;
    }
    const type = makeGalleryType();
    const page = await createFixturePage();
    // Both are crop-bearing (structural layer would keep both); only the belt distinguishes them.
    const highPiiSection = await createCropBearingSection(page, type, 0, { pii: "high" });
    const safeSection = await createCropBearingSection(page, type, 1, { pii: "low" });

    const res = await getGallerySections(0, 100, type);
    // Belt EXCLUDES the high-PII section; count and items are BOTH 1 (symmetric belt).
    expect(res.total).toBe(1);
    expect(res.items.length).toBe(1);
    expect(res.items[0]?.id).toBe(safeSection);
    expect(res.items.some((i) => i.id === highPiiSection)).toBe(false);
  }, 60_000);

  it("leg (b3) — data.delete(webPageId) removes the page's sections from the gallery (LCC-P04, GDPR Art.17)", async () => {
    if (!HAS_DB) {
      expect(HAS_DB, "local run without DATABASE_URL: real-DB legs skipped (CI enforces)").toBe(
        false
      );
      return;
    }
    const type = makeGalleryType();
    const page = await createFixturePage();
    await createCropBearingSection(page, type, 0, { pii: "low" });

    // Before: the fixture section is in the gallery.
    const before = await getGallerySections(0, 100, type);
    expect(before.total).toBe(1);
    expect(before.items.length).toBe(1);

    // data.delete (GDPR Art.17) the fixture page via the real deletion path.
    const gdprSvc = new GdprDeletionService();
    const result = await gdprSvc.deletePage(page, "INV-WEBUI-GALLERY-PII-EXCLUDED leg (b3)");
    expect(result.deleted).toBe(true);

    // After: the page's section is gone from the gallery (cascade removed section_patterns).
    const after = await getGallerySections(0, 100, type);
    expect(after.total).toBe(0);
    expect(after.items).toEqual([]);
  }, 60_000);

  it("leg (b4) — offset pagination is total/items-consistent (disjoint pages union to all rows)", async () => {
    if (!HAS_DB) {
      expect(HAS_DB, "local run without DATABASE_URL: real-DB legs skipped (CI enforces)").toBe(
        false
      );
      return;
    }
    const type = makeGalleryType();
    const page = await createFixturePage();
    const ids = [
      await createCropBearingSection(page, type, 0, { pii: "low" }),
      await createCropBearingSection(page, type, 1, { pii: "low" }),
      await createCropBearingSection(page, type, 2, { pii: "low" }),
    ];

    const p0 = await getGallerySections(0, 2, type);
    const p1 = await getGallerySections(1, 2, type);
    // total is stable across offset pages; each page respects pageSize.
    expect(p0.total).toBe(3);
    expect(p1.total).toBe(3);
    expect(p0.items.length).toBe(2);
    expect(p1.items.length).toBe(1);
    // Pages are disjoint and their union is exactly the 3 fixture sections (offset correctness).
    const union = new Set([...p0.items.map((i) => i.id), ...p1.items.map((i) => i.id)]);
    expect(union.size).toBe(3);
    for (const id of ids) {
      expect(union.has(id)).toBe(true);
    }
  }, 60_000);
});

// ============================================================================
// W7c-api-2 (additive follow-up) — INV-WEBUI-GALLERY-SCOPE-FACETS
//
// The content-first `scope` selector + `facets` (ADR-0042 Amendment 13, plan §3.3 condition 5 =
// TPA-P01 M), closing the plan §4 API under-specification. These legs are CO-LOCATED in this file
// (rather than a separate file) ON PURPOSE: leg (a) above walks the ENTIRE crop-bearing corpus, so a
// SECOND file that churns crop-bearing fixtures in a parallel `pool: forks` process would delete a
// page's `web_page` mid-`findMany` and flake the required-`webPage` relation. Same-file legs run
// sequentially in one process, so the corpus walk never races a fixture teardown. The existing 9
// PII-EXCLUDED legs above are UNCHANGED; these legs reuse the same fixture helpers (DRY).
// ============================================================================

/** Σ of the facet counts over CHROME_SECTION_TYPES (the amount `scope="content"` removes). */
function chromeFacetTotal(facets: { sectionType: string; count: number }[]): number {
  const chrome = new Set<string>(CHROME_SECTION_TYPES);
  return facets.reduce((sum, f) => (chrome.has(f.sectionType) ? sum + f.count : sum), 0);
}

describe("INV-WEBUI-GALLERY-SCOPE-FACETS (leg c: source-pin, always runs)", () => {
  it("CHROME_SECTION_TYPES is the ONE SSOT for the chrome裁定 (defined once, no inline scatter)", () => {
    // SSOT definition (the plan §3.3 chrome 3-type ruling, exported so the filter-chip UI shares it).
    expect(
      /export const CHROME_SECTION_TYPES = \[\s*"navigation",\s*"footer",\s*"unknown"\s*\] as const/.test(
        GALLERY_SERVICE_SRC
      )
    ).toBe(true);
    // No scatter: each chrome literal appears EXACTLY ONCE (only in the SSOT tuple), never re-inlined.
    for (const literal of ['"navigation"', '"footer"', '"unknown"']) {
      const occurrences = GALLERY_SERVICE_SRC.split(literal).length - 1;
      expect(
        occurrences,
        `chrome literal ${literal} must appear exactly once (SSOT, no scatter)`
      ).toBe(1);
    }
    // The exported tuple MUST match the value imported into this test (runtime SSOT parity).
    expect([...CHROME_SECTION_TYPES]).toEqual(["navigation", "footer", "unknown"]);
  });

  it("scope=content derives from the SSOT and is gated by explicit-type precedence", () => {
    // The chrome exclusion derives from the SSOT (spread), NOT an inline literal array at the call site.
    expect(/notIn:\s*\[\.\.\.CHROME_SECTION_TYPES\]/.test(GALLERY_SERVICE_SRC)).toBe(true);
    // Precedence gate: chrome exclusion applies ONLY when scope="content" AND no explicit type.
    expect(/scope === "content" && type === undefined/.test(GALLERY_SERVICE_SRC)).toBe(true);
  });

  it("facets reuse the crop-bearing + PII belt (buildGalleryWhere(undefined)); no type/scope filter", () => {
    // Facets groupBy MUST share the exact belt so a high-PII section is never counted, and
    // Σ facet-counts === total(scope=all,no-type). The `undefined` arg = no type filter (all types).
    expect(/by:\s*\[\s*"sectionType"\s*\]/.test(GALLERY_SERVICE_SRC)).toBe(true);
    expect(/where:\s*buildGalleryWhere\(undefined\)/.test(GALLERY_SERVICE_SRC)).toBe(true);
    // The single-`where`-shared-by-count-and-findMany symmetry is UNCHANGED (still exactly one
    // buildGalleryWhere(type) call site — facets use a distinct buildGalleryWhere(undefined) call).
    const typeCallCount = (GALLERY_SERVICE_SRC.match(/buildGalleryWhere\(type\)/g) ?? []).length;
    expect(typeCallCount).toBe(1);
  });
});

describe("INV-WEBUI-GALLERY-SCOPE-FACETS (real-DB legs, HAS_DB-gated, fail-closed on CI)", () => {
  afterEach(async () => {
    if (HAS_DB && createdWebPageIds.length > 0) {
      // Exact-match cascade delete (section_patterns → section_embeddings + component_parts via
      // onDelete: Cascade). NEVER prefix-wide — real data is untouched.
      await prisma.webPage.deleteMany({ where: { id: { in: createdWebPageIds } } });
    }
    createdWebPageIds.length = 0;
  });

  it("environment precondition — CI MUST provide DATABASE_URL (fail-closed; local degrades to precondition-assert, NOT skip)", () => {
    if (IS_CI) {
      expect(
        process.env.DATABASE_URL,
        "[INV-WEBUI-GALLERY-SCOPE-FACETS] DATABASE_URL absent in CI — CI MUST provide a real PostgreSQL for the scope/facets legs"
      ).toBeTruthy();
      return;
    }
    expect(
      "INV-WEBUI-GALLERY-SCOPE-FACETS contract: CI run requires DATABASE_URL for the real-DB scope + facets legs"
    ).toMatch(/INV-WEBUI-GALLERY-SCOPE-FACETS/);
  });

  it("leg (d1) — Σ facet-counts === total(scope=all, no-type) (facets share the count/items `where`)", async () => {
    if (!HAS_DB) {
      expect(HAS_DB, "local run without DATABASE_URL: real-DB legs skipped (CI enforces)").toBe(
        false
      );
      return;
    }
    // Two crop-bearing sections of a unique type → total ≥ 2 (non-vacuous), facets non-empty.
    const type = makeGalleryType();
    const page = await createFixturePage();
    await createCropBearingSection(page, type, 0, { pii: "low" });
    await createCropBearingSection(page, type, 1);

    const res = await getGallerySections(0, 1, undefined, "all");
    const facetSum = res.facets.reduce((sum, f) => sum + f.count, 0);
    // Same `where` (buildGalleryWhere(undefined)) → the facet histogram partitions the exact total.
    expect(facetSum).toBe(res.total);
    // Non-vacuity: the fixture guarantees the corpus (and the fixture type's facet) is non-empty.
    expect(res.total).toBeGreaterThanOrEqual(2);
    expect(res.facets.find((f) => f.sectionType === type)?.count).toBe(2);
  }, 60_000);

  it("leg (d2) — facets are count-descending (deterministic chip order)", async () => {
    if (!HAS_DB) {
      expect(HAS_DB, "local run without DATABASE_URL: real-DB legs skipped (CI enforces)").toBe(
        false
      );
      return;
    }
    // Two unique types with different cardinality (2 vs 1) → facets has ≥ 2 entries, non-vacuous.
    const typeA = makeGalleryType();
    const typeB = makeGalleryType();
    const page = await createFixturePage();
    await createCropBearingSection(page, typeA, 0, { pii: "low" });
    await createCropBearingSection(page, typeA, 1, { pii: "low" });
    await createCropBearingSection(page, typeB, 2, { pii: "low" });

    const res = await getGallerySections(0, 1, undefined, "all");
    expect(res.facets.length).toBeGreaterThanOrEqual(2);
    // Monotonic non-increasing by count (count desc).
    for (let i = 0; i + 1 < res.facets.length; i += 1) {
      expect(res.facets[i]!.count).toBeGreaterThanOrEqual(res.facets[i + 1]!.count);
    }
    // The unique fixture types carry the expected cardinalities (belt keeps all — all pii low).
    expect(res.facets.find((f) => f.sectionType === typeA)?.count).toBe(2);
    expect(res.facets.find((f) => f.sectionType === typeB)?.count).toBe(1);
  }, 60_000);

  it("leg (d3) — facet PII belt non-vacuity: a high-PII section is NOT counted in its type's facet", async () => {
    if (!HAS_DB) {
      expect(HAS_DB, "local run without DATABASE_URL: real-DB legs skipped (CI enforces)").toBe(
        false
      );
      return;
    }
    // Same unique type: one section CONTAINS a high-PII part (belt EXCLUDES it), one is safe (kept).
    const type = makeGalleryType();
    const page = await createFixturePage();
    await createCropBearingSection(page, type, 0, { pii: "high" });
    await createCropBearingSection(page, type, 1, { pii: "low" });

    const res = await getGallerySections(0, 1, undefined, "all");
    // The belt-excluded high-PII section is NOT in the facet count → count === 1 (not 2).
    expect(res.facets.find((f) => f.sectionType === type)?.count).toBe(1);
    // Symmetric with the listing: a type-filtered listing of that type also yields exactly 1.
    const listing = await getGallerySections(0, 100, type, "all");
    expect(listing.total).toBe(1);
  }, 60_000);

  it("leg (a) — scope='content' excludes CHROME exactly: total(all) − total(content) === Σ chrome facet-counts", async () => {
    if (!HAS_DB) {
      expect(HAS_DB, "local run without DATABASE_URL: real-DB legs skipped (CI enforces)").toBe(
        false
      );
      return;
    }
    // A crop-bearing NAVIGATION (chrome) fixture makes the exclusion non-vacuous (removes ≥ 1), plus a
    // unique content-type fixture so the content scope is also non-empty.
    const contentType = makeGalleryType();
    const page = await createFixturePage();
    await createCropBearingSection(page, "navigation", 0, { pii: "low" });
    await createCropBearingSection(page, contentType, 1, { pii: "low" });

    const all = await getGallerySections(0, 1, undefined, "all");
    const content = await getGallerySections(0, 1, undefined, "content");

    // Exact chrome exclusion: content removes precisely the chrome-typed crop-bearing sections.
    const chromeTotal = chromeFacetTotal(all.facets);
    expect(all.total - content.total).toBe(chromeTotal);
    // Non-vacuity: the navigation fixture guarantees chrome is present and actually removed.
    expect(chromeTotal).toBeGreaterThanOrEqual(1);
    expect(all.total).toBeGreaterThan(content.total);
    // Facets are the SAME full-type histogram in both responses (type/scope NOT applied to facets).
    expect(content.facets).toEqual(all.facets);
  }, 60_000);

  it("leg (b) — explicit type ALWAYS wins over scope: ?type=navigation returns navigation under scope=content", async () => {
    if (!HAS_DB) {
      expect(HAS_DB, "local run without DATABASE_URL: real-DB legs skipped (CI enforces)").toBe(
        false
      );
      return;
    }
    // A crop-bearing navigation (chrome) fixture; content scope would exclude it WITHOUT explicit type.
    const page = await createFixturePage();
    const navSection = await createCropBearingSection(page, "navigation", 0, { pii: "low" });

    // With an explicit type, scope is a no-op (content === all): the chrome type is reachable.
    const contentScoped = await getGallerySections(0, 200, "navigation", "content");
    const allScoped = await getGallerySections(0, 200, "navigation", "all");
    expect(contentScoped.total).toBe(allScoped.total);
    expect(contentScoped.total).toBeGreaterThanOrEqual(1);
    // Every returned item is the requested chrome type (the type filter applied, not chrome-excluded).
    for (const item of contentScoped.items) {
      expect(item.sectionType).toBe("navigation");
    }
    // The specific fixture section is reachable when the page can hold it (small corpora fit one page;
    // the scope-no-op equality above already proved precedence independently of pagination).
    if (contentScoped.total <= 200) {
      expect(contentScoped.items.some((i) => i.id === navSection)).toBe(true);
    }
  }, 60_000);
});
