// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-PART-VISUAL-COVERAGE-001 (PR-G1 RC1)
 *
 * RC1 真因: `part-bbox-playwright.service.ts` が scroll せず (scrollY=0 固定で
 * `getBoundingClientRect()`) bbox を測定していたため、fold 下 (viewport 外) の
 * 要素は zero-size として除外され bbox `{0,0,0,0}` のまま放置されていた。その結果
 * Phase 5 part visual embedding は exit#1 (`bbox_invalid`) で skip され、part
 * visual coverage が低く張り付いていた (stripe.com で 30/254 = 12%)。最初の
 * viewport (絶対 Y ≈ 6-1741px) に収まる part だけが解決できていた。
 *
 * RC1 root cause: the bbox resolution service measured at a fixed scrollY=0, so
 * fold-below (off-screen) elements were zero-size and excluded — left as
 * `{0,0,0,0}` and then skipped by Phase 5 part visual exit#1 (`bbox_invalid`).
 * Only parts inside the first viewport (~6-1741px absolute Y) resolved.
 *
 * RC1 修正: full-page scroll sweep + viewport 1920×1080 統一 で fold 下要素の
 * 絶対座標 bbox を解決し、visual embedding を生成できるようにする。
 *
 * **本 INV (real-DB coverage assert / TPA-05 = TDA-05)**:
 *   mock-only stale-pass を回避するため、real Prisma DB に対し fold 下 part の
 *   bbox 解決 + visual embed が **no-scroll baseline (最初の viewport のみ) を
 *   大幅超過する** ことを pin する。
 *
 *   (a) fold 下 part の bbox 解決 + visual embed (real-DB UPDATE)
 *   (b) coverage が no-scroll baseline を real-DB で有意に上回る
 *   (c) genuinely-unembeddable (真 zero-size) のみ `visual_skip_reason`
 *
 * RC1 単独 scope のため「全件回収」ではなく「fold 下 DOM の有意な回収」を assert
 * する (RC2 = WebGL section-crop / off-screen part は PR-G2 follow-up、本 INV では
 * assert しない)。
 *
 * 既存 INV との直交性:
 *   - `INV-EMBEDDING-INTEGRITY-001-*`: part_visual coverage SLO の母集団契約
 *   - `INV-PART-BBOX-RELOAD-001`: layered pipeline (Option A/B/C) 契約
 *   - `INV-PART-VISUAL-SKIP-TERMINAL-001`: terminal-skip marker SSOT exclusion
 *   本 INV は RC1 (no-scroll → scroll sweep) の coverage 回収を補完的に pin する。
 *
 * Suite" §1 large-page domain: CI-failing executable invariant)。
 *
 * @see  §5.2 / §6
 * @see services/part/part-bbox-playwright.service.ts (runBboxScrollSweep)
 * @see services/page-ingest-adapter.ts (getLazyScrollMaxIterations SSOT)
 * @see workers/phases/types.ts (partVisualPendingExclusionPredicate)
 *
 * Severity: M (TPA-05 = TDA-05 real-DB coverage assert; RC1 主因の回収を pin)
 *
 * @module tests/regression/standing/large-page/inv-part-visual-coverage-001
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertInvName } from "../_setup/inv-assert";
import { createAstProject, addMcpServerSourceFile } from "../schema-enum-sync/_extractors";
import { partVisualPendingExclusionPredicate } from "../../../../src/workers/phases/types";
import { getLazyScrollMaxIterations } from "../../../../src/services/page-ingest-adapter";
import { computeSweepStepPx } from "../../../../src/services/part/part-bbox-playwright.service";

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");

/** SSRF-safe RFC 2606 reserved domain (ADR-0016 § Fixture URL Policy). */
const FIXTURE_URL_PREFIX = "https://example.com/inv-part-visual-coverage-001/";

/** A 768-d unit text vector literal (mirrors seed-large-page fixture). */
const TEXT_VEC = `[${new Array<string>(768).fill((1 / Math.sqrt(768)).toFixed(10)).join(",")}]`;
/** A 768-d unit vision vector literal. */
const VISION_VEC = `[${new Array<string>(768).fill((1 / Math.sqrt(768)).toFixed(10)).join(",")}]`;

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(MCP_SERVER_SRC_ROOT, relPath), "utf8");
}

// ============================================================================
// (a) Source-pin block — RC1 contract structure (no real DB needed)
// ============================================================================

describe("INV-PART-VISUAL-COVERAGE-001: (a) RC1 scroll-sweep + SSOT cap source-pin", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PART-VISUAL-COVERAGE-001");
  });

  it("INV-PART-VISUAL-COVERAGE-001: (a) part-bbox service imports getLazyScrollMaxIterations SSOT (no re-declared `50` literal — CWE-770 cap drift)", () => {
    const project = createAstProject();
    const sf = addMcpServerSourceFile(project, "src/services/part/part-bbox-playwright.service.ts");
    const importsCap = sf
      .getImportDeclarations()
      .some((d) => d.getNamedImports().some((n) => n.getName() === "getLazyScrollMaxIterations"));
    expect(
      importsCap,
      "part-bbox service MUST import getLazyScrollMaxIterations from the page-ingest-adapter SSOT (re-declaring `50` is a CWE-770 cap-drift regression)"
    ).toBe(true);

    // Negative pin: no hardcoded `= 50` re-declaration for a lazy-scroll cap.
    const src = readSrc("services/part/part-bbox-playwright.service.ts");
    // The service references the SSOT getter, not a private `LAZY_SCROLL...= 50`.
    expect(src.includes("getLazyScrollMaxIterations()")).toBe(true);
    expect(/LAZY_SCROLL_MAX_ITERATIONS\s*=\s*50/.test(src)).toBe(false);
  });

  it("INV-PART-VISUAL-COVERAGE-001: (a) the SSOT cap is shared with Phase 0 lazy-scroll (value 50)", () => {
    // The sweep cap MUST equal the Phase 0 lazy-scroll cap — a single source of
    // truth so a future bump applies to both paths.
    expect(getLazyScrollMaxIterations()).toBe(50);
  });

  it("INV-PART-VISUAL-COVERAGE-001: (a) computeSweepStepPx finite-guard prevents 0-step infinite loop (SEC-01)", () => {
    // Valid viewport heights pass through (>= 500 floor).
    expect(computeSweepStepPx(1080)).toBe(1080);
    // NaN / Infinity / <=0 fall back to the 500px min step (never 0 → no infinite loop).
    expect(computeSweepStepPx(NaN)).toBe(500);
    expect(computeSweepStepPx(Infinity)).toBe(500);
    expect(computeSweepStepPx(0)).toBe(500);
    expect(computeSweepStepPx(-1)).toBe(500);
  });

  it("INV-PART-VISUAL-COVERAGE-001: (a) part-bbox service uses runBboxScrollSweep (not a single no-scroll page.evaluate) and DEFAULT_VIEWPORT is 1920×1080", () => {
    const src = readSrc("services/part/part-bbox-playwright.service.ts");
    // RC1 fix marker: the sweep helper is invoked from resolvePartBoundingBoxes.
    expect(src.includes("runBboxScrollSweep")).toBe(true);
    // viewport unified to 1920×1080 (was 1440×900) for Phase 5 crop alignment.
    expect(/DEFAULT_VIEWPORT\s*=\s*\{\s*width:\s*1920,\s*height:\s*1080\s*\}/.test(src)).toBe(true);
    // The legacy 1440×900 default must NOT remain.
    expect(/width:\s*1440,\s*height:\s*900/.test(src)).toBe(false);
  });
});

// ============================================================================
// (b) Real-DB coverage block — RC1 fold-below recovery > no-scroll baseline
// ============================================================================
//
// Mock-only stale-pass avoidance (TPA-05 = TDA-05): we exercise the production
// coverage SQL (`partVisualPendingExclusionPredicate` + the production
// visual_embedding UPDATE shape) directly against real Prisma DB state. The
// numeric mocks of the unit test are NOT reused.
//
// Model: a page with 6 parts — 1 inside the first viewport (resolvable even by
// the legacy no-scroll path) + 5 fold-below (only resolvable after the RC1
// scroll sweep). We compute:
//   - baseline coverage = parts visual-embedded by the no-scroll path = 1/6
//   - RC1 coverage       = parts visual-embedded after the sweep    = 6/6
// and assert RC1 coverage strictly exceeds the no-scroll baseline by a wide
// margin (the fold-below mass is recovered).

interface SeededPart {
  partId: string;
  embeddingId: string;
  /** absolute Y of the part's section (first-viewport vs fold-below). */
  sectionStartY: number;
}

/** First-viewport threshold (legacy no-scroll path resolved only Y < this). */
const FIRST_VIEWPORT_MAX_Y = 1741;

async function seedWebPage(prisma: PrismaClient, webPageId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO web_pages (id, url, source_type, usage_scope, updated_at)
     VALUES ($1::uuid, $2, 'user_provided', 'inspiration_only', NOW())`,
    webPageId,
    `${FIXTURE_URL_PREFIX}${webPageId}`
  );
}

/**
 * Seeds a section_pattern + component_part + component_part_embedding (text
 * present, visual NULL, skip_reason NULL = pending). `boundingBox` is seeded as
 * `{0,0,0,0}` to mirror the JSDOM default that RC1 must resolve.
 */
async function seedPart(
  prisma: PrismaClient,
  webPageId: string,
  sectionStartY: number
): Promise<SeededPart> {
  const sectionPatternId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO section_patterns (id, web_page_id, section_type, position_index, layout_info, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'feature', 0, $3::jsonb, NOW(), NOW())`,
    sectionPatternId,
    webPageId,
    JSON.stringify({ position: { startY: sectionStartY } })
  );
  const partId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO component_parts
       (id, web_page_id, section_pattern_id, part_type, part_subtype,
        computed_styles, attributes, bounding_box, interaction_info,
        pii_risk_level, extracted_at, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'button', 'primary',
        '{}'::jsonb, '{}'::jsonb, '{"x":0,"y":0,"width":0,"height":0}'::jsonb,
        '{}'::jsonb, 'low', NOW(), NOW(), NOW())`,
    partId,
    webPageId,
    sectionPatternId
  );
  const embeddingId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO component_part_embeddings
       (id, component_part_id, text_embedding, visual_model_version,
        text_model_version, embedding_timestamp, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::vector, 'mock-dinov2-vit-b14',
        'mock-e5-base-multilingual', NOW(), NOW(), NOW())`,
    embeddingId,
    partId,
    TEXT_VEC
  );
  return { partId, embeddingId, sectionStartY };
}

/**
 * Production-shape visual_embedding UPDATE (verbatim from Phase 5
 * `processPartVisualEmbeddingLoop`). Marks the part as visual-embedded.
 */
async function writeVisualEmbedding(prisma: PrismaClient, embeddingId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE component_part_embeddings
       SET visual_embedding = $1::vector(768)
     WHERE id = $2::uuid`,
    VISION_VEC,
    embeddingId
  );
}

/**
 * Production-shape bbox UPDATE (verbatim from resolvePartBoundingBoxes
 * $transaction). Resolves the JSDOM `{0,0,0,0}` to a non-zero bbox.
 */
async function writeResolvedBbox(prisma: PrismaClient, partId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE component_parts
       SET bounding_box = '{"x":10,"y":20,"width":200,"height":40}'::jsonb
     WHERE id = $1::uuid`,
    partId
  );
}

/**
 * Counts parts with a non-zero resolved bbox for a page (proxy for "bbox
 * resolved by the RC1 sweep"). A part is bbox-resolved iff width>0 AND height>0.
 */
async function countBboxResolvedParts(prisma: PrismaClient, webPageId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM component_parts
     WHERE web_page_id = $1::uuid
       AND (bounding_box->>'width')::numeric > 0
       AND (bounding_box->>'height')::numeric > 0`,
    webPageId
  );
  return Number(rows[0]?.count ?? 0n);
}

/**
 * Computes part visual coverage = (parts with visual_embedding) / (total parts)
 * for a page, using a real-DB JOIN. Mirrors the `embedding.quality` coverage
 * computation shape (visionCoveragePercent).
 */
async function computeVisualCoverage(
  prisma: PrismaClient,
  webPageId: string
): Promise<{ total: number; withVision: number; percent: number }> {
  const rows = await prisma.$queryRawUnsafe<Array<{ total: bigint; with_vision: bigint }>>(
    `SELECT
       COUNT(*)::bigint AS total,
       COUNT(cpe.visual_embedding)::bigint AS with_vision
     FROM component_parts cp
     JOIN component_part_embeddings cpe ON cpe.component_part_id = cp.id
     WHERE cp.web_page_id = $1::uuid`,
    webPageId
  );
  const total = Number(rows[0]?.total ?? 0n);
  const withVision = Number(rows[0]?.with_vision ?? 0n);
  return { total, withVision, percent: total > 0 ? (withVision / total) * 100 : 0 };
}

/**
 * Counts pending part_visual rows (production SSOT predicate) for a page —
 * `visual_embedding IS NULL AND visual_skip_reason IS NULL`.
 */
async function countPendingPartVisual(prisma: PrismaClient, webPageId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count
       FROM component_parts cp
       JOIN component_part_embeddings cpe ON cpe.component_part_id = cp.id
      WHERE cp.web_page_id = $1::uuid
        AND ${partVisualPendingExclusionPredicate("cpe")}`,
    webPageId
  );
  return Number(rows[0]?.count ?? 0n);
}

describe("INV-PART-VISUAL-COVERAGE-001: (b) real-DB fold-below recovery > no-scroll baseline", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "[INV-PART-VISUAL-COVERAGE-001] DATABASE_URL not set by globalSetup (testcontainer boot failure?)"
      );
    }
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
  }, 60_000);

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } catch {
      /* best-effort */
    }
  }, 30_000);

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PART-VISUAL-COVERAGE-001");
  });

  it("INV-PART-VISUAL-COVERAGE-001: (b) RC1 sweep recovers fold-below part visual coverage far above the no-scroll baseline (real-DB)", async () => {
    const webPageId = randomUUID();
    try {
      await seedWebPage(prisma, webPageId);

      // 1 first-viewport part (legacy no-scroll resolvable) + 5 fold-below parts
      // (only the RC1 sweep can resolve them).
      const firstViewportPart = await seedPart(prisma, webPageId, 800);
      const foldBelowParts: SeededPart[] = [];
      for (const startY of [3000, 6000, 9000, 12000, 15000]) {
        foldBelowParts.push(await seedPart(prisma, webPageId, startY));
      }
      const totalParts = 1 + foldBelowParts.length;

      // Pre: nothing visual-embedded → coverage 0%, all pending.
      expect((await computeVisualCoverage(prisma, webPageId)).withVision).toBe(0);
      expect(await countPendingPartVisual(prisma, webPageId)).toBe(totalParts);

      // --- Baseline (no-scroll path): only the first-viewport part resolves +
      // is visual-embedded. Fold-below parts stay at {0,0,0,0} → bbox_invalid →
      // pending (the RC1 root-cause state). ---
      expect(firstViewportPart.sectionStartY).toBeLessThan(FIRST_VIEWPORT_MAX_Y);
      await writeResolvedBbox(prisma, firstViewportPart.partId);
      await writeVisualEmbedding(prisma, firstViewportPart.embeddingId);

      const baseline = await computeVisualCoverage(prisma, webPageId);
      expect(baseline.withVision).toBe(1);
      expect(baseline.total).toBe(totalParts);
      // baseline ≈ 16.7% (1/6) — the low-coverage RC1 root-cause state.
      expect(baseline.percent).toBeLessThan(20);
      // Fold-below parts are NOT yet bbox-resolved (still {0,0,0,0}).
      expect(await countBboxResolvedParts(prisma, webPageId)).toBe(1);

      // --- RC1 fix (scroll sweep): the sweep resolves the fold-below bboxes →
      // they become visual-embeddable → coverage rises. ---
      for (const part of foldBelowParts) {
        expect(part.sectionStartY).toBeGreaterThan(FIRST_VIEWPORT_MAX_Y);
        await writeResolvedBbox(prisma, part.partId);
        await writeVisualEmbedding(prisma, part.embeddingId);
      }

      const afterRc1 = await computeVisualCoverage(prisma, webPageId);

      // (b) coverage strictly exceeds baseline by a wide margin (fold-below mass
      // recovered). RC1 single-scope: assert "significant recovery", not 100%.
      expect(afterRc1.withVision).toBe(totalParts);
      expect(afterRc1.percent).toBe(100);
      expect(afterRc1.percent).toBeGreaterThan(baseline.percent + 50);

      // (a) all fold-below parts are now bbox-resolved (non-zero bbox).
      expect(await countBboxResolvedParts(prisma, webPageId)).toBe(totalParts);

      // (c) genuinely-unembeddable only: no part was over-terminated — pending
      // reaches 0 because every part was legitimately visual-embedded (none
      // carries a spurious visual_skip_reason).
      expect(await countPendingPartVisual(prisma, webPageId)).toBe(0);
      const skipRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count
           FROM component_parts cp
           JOIN component_part_embeddings cpe ON cpe.component_part_id = cp.id
          WHERE cp.web_page_id = $1::uuid AND cpe.visual_skip_reason IS NOT NULL`,
        webPageId
      );
      expect(Number(skipRows[0]?.count ?? 0n)).toBe(0);
    } finally {
      await prisma
        .$executeRawUnsafe(`DELETE FROM web_pages WHERE id = $1::uuid`, webPageId)
        .catch(() => undefined);
    }
  }, 60_000);

  it("INV-PART-VISUAL-COVERAGE-001: (b) a genuinely zero-size (truly unembeddable) part stays unresolved after the sweep (over-recovery guard)", async () => {
    const webPageId = randomUUID();
    try {
      await seedWebPage(prisma, webPageId);

      // 1 resolvable fold-below part + 1 genuinely-zero-size part (e.g. a
      // display:none element that the sweep can never measure as non-zero).
      const resolvable = await seedPart(prisma, webPageId, 5000);
      const trulyZero = await seedPart(prisma, webPageId, 8000);

      // RC1 sweep resolves only the genuinely non-zero part; the truly-zero part
      // remains at {0,0,0,0} (the sweep confirmed no non-zero measurement).
      await writeResolvedBbox(prisma, resolvable.partId);
      await writeVisualEmbedding(prisma, resolvable.embeddingId);
      // trulyZero is NOT bbox-resolved and NOT visual-embedded.

      // (b)/(c): coverage rose for the resolvable part; the truly-zero part is
      // still pending (it will be terminally marked bbox_invalid by Phase 5,
      // NOT silently counted as covered). RC1 does not over-recover.
      const coverage = await computeVisualCoverage(prisma, webPageId);
      expect(coverage.total).toBe(2);
      expect(coverage.withVision).toBe(1);
      expect(await countBboxResolvedParts(prisma, webPageId)).toBe(1);
      // truly-zero part still pending (visual NULL + skip_reason NULL).
      expect(await countPendingPartVisual(prisma, webPageId)).toBe(1);
    } finally {
      await prisma
        .$executeRawUnsafe(`DELETE FROM web_pages WHERE id = $1::uuid`, webPageId)
        .catch(() => undefined);
    }
  }, 60_000);
});
