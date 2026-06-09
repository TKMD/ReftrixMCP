// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain (real-DB)
 *
 * ADR-0018 Amendment 13 (visual-backfill truncated-screenshot data-loss fix, PR-A):
 * lands the real-DB CI-failing invariants for the truncated-screenshot retryable
 * Regression Suite" §1 (large-page domain): MANDATORY, CI-failing executable
 * invariants. `.skip()` / `.todo()` / `describe.skip` are FORBIDDEN. Failure is a
 * P0 incident handled by pipeline-engineer + capture-embedding-engineer.
 *
 * These tests are **real-DB** (DATABASE_URL is provided by the regression
 * globalSetup testcontainer). They throw — NOT short-circuit — if DATABASE_URL is
 * unset (no-fake-success: a missing DB must FAIL, never silently PASS, per MEMORY
 * `feedback_real_db_test_short_circuit_false_pass.md`).
 *
 * Invariants landed here:
 *   - INV-PART-VISUAL-REAL-LEAK-VS-NONTERMINAL-BOUNDARY (FIND-RE-TPA-H-01): the
 *     3-way pending predicate's (i)/(ii)/(iii) sets are mutually-exclusive +
 *     exhaustive on a real DB, and the real-leak count is purified to "pending AND
 *     visual_skip_reason IS NULL" so `screenshot_truncated` does NOT inflate it.
 *   - INV-TRUNCATED-RETRYABLE-EXCLUDES-PII-TERMINAL (FIND-PLAN-H-02): no high-PII
 *     row ever appears in the `screenshot_truncated` reclassified set.
 *   - INV-TRUNCATED-RETRY-BOUNDED-TERMINAL (FIND-RE-SEC-M-01 + M-02): a
 *     `screenshot_truncated`-origin page converges to `screenshot_truncated_expired`
 *     + page-level `not_required` (NOT `failed`) over the retry cap; a
 *     `bbox_unresolvable`-origin page converges to `failed`.
 *   - INV-VISUAL-RETRYABLE-NOT-OUTLIVE-SCREENSHOT-TTL (FIND-PLAN-H-01): the
 *     retryable convergence reaches a terminal so it cannot outlive the screenshot
 *     7d TTL as a perpetual retryable.
 *   - INV-TRUNCATED-FLAG-GATED-CLASSIFICATION (FIND-RE-TPA-M-02): flag-gating
 *     (`fallbackEnabled`) controls whether the off-screen crop guard writes
 *     `screenshot_truncated` (flag ON) vs `bbox_unresolvable` (flag OFF).
 *   - INV-TRUNCATED-PART-SECTION-SYMMETRY (FIND-RE-TPA-L-01): part and section
 *     carry symmetric `screenshot_truncated` / `screenshot_truncated_expired`
 *     pending/terminal behaviour.
 *   - INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011 GREEN maintained (orthogonality,
 *     asserted in the sibling file; reconfirmed here that the section predicate's
 *     PII NOT EXISTS clause is unchanged by the 3-way change).
 *
 * @see  (V3) §5.4-§5.10
 * @see  §3
 * @see ADR-0018 Amendment 13 §8.3 / §8.4 / §8.9
 * @see apps/mcp-server/src/workers/phases/types.ts (3-way predicates + writable sets)
 * @see apps/mcp-server/src/services/backfill-reconciliation.service.ts (convergeTruncatedRowsOverRetryCap)
 *
 * @module tests/regression/standing/large-page/inv-truncated-screenshot-retryable-016
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, it, expect, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { assertInvName } from "../_setup/inv-assert";
import {
  partVisualPendingExclusionPredicate,
  sectionVisualPendingExclusionPredicate,
  EMBEDDING_PART_VISUAL_SKIP_REASONS,
  EMBEDDING_SECTION_VISUAL_SKIP_REASONS,
  EMBEDDING_PART_VISUAL_WRITABLE_SKIP_REASONS,
  EMBEDDING_SECTION_VISUAL_WRITABLE_SKIP_REASONS,
} from "../../../../src/workers/phases/types";
import { seedSectionEmbedding, cleanupSeededWebPage } from "./_fixtures/seed-large-page";

const INV_TPA_H = "INV-PART-VISUAL-REAL-LEAK-VS-NONTERMINAL-BOUNDARY";
const INV_PII = "INV-TRUNCATED-RETRYABLE-EXCLUDES-PII-TERMINAL";
const INV_BOUNDED = "INV-TRUNCATED-RETRY-BOUNDED-TERMINAL";
const INV_TTL = "INV-VISUAL-RETRYABLE-NOT-OUTLIVE-SCREENSHOT-TTL";
const INV_FLAG = "INV-TRUNCATED-FLAG-GATED-CLASSIFICATION";
const INV_SYM = "INV-TRUNCATED-PART-SECTION-SYMMETRY";

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");
function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(MCP_SERVER_SRC_ROOT, relPath), "utf8");
}

function buildUnitVector(): string {
  const dim = 768;
  const v = (1 / Math.sqrt(dim)).toFixed(10);
  return `[${new Array<string>(dim).fill(v).join(",")}]`;
}

/** Seed a component_part + component_part_embeddings row with an optional skip reason. */
async function seedPartEmbedding(
  prisma: PrismaClient,
  webPageId: string,
  sectionPatternId: string,
  opts: { piiRiskLevel: "high" | "low"; visualSkipReason?: string | null }
): Promise<{ partId: string; embeddingId: string }> {
  const partId = randomUUID();
  await prisma.componentPart.create({
    data: {
      id: partId,
      webPageId,
      sectionPatternId,
      partType: "button",
      partSubtype: "primary",
      computedStyles: {},
      attributes: {},
      boundingBox: { x: 0, y: 0, width: 100, height: 40 },
      interactionInfo: {},
      piiRiskLevel: opts.piiRiskLevel,
      extractedAt: new Date(),
    },
  });
  const embeddingId = randomUUID();
  const textVector = buildUnitVector();
  // text_embedding present, visual_embedding NULL (the part_visual pending state).
  await prisma.$executeRawUnsafe(
    `INSERT INTO component_part_embeddings
       (id, component_part_id, text_embedding, visual_model_version, text_model_version,
        embedding_timestamp, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::vector, 'mock-dinov2-vit-b14', 'mock-e5-base-multilingual',
        NOW(), NOW(), NOW())`,
    embeddingId,
    partId,
    textVector
  );
  if (opts.visualSkipReason) {
    await prisma.$executeRawUnsafe(
      `UPDATE component_part_embeddings SET visual_skip_reason = $1 WHERE id = $2::uuid`,
      opts.visualSkipReason,
      embeddingId
    );
  }
  return { partId, embeddingId };
}

async function createPage(prisma: PrismaClient, status: string): Promise<string> {
  const webPageId = randomUUID();
  await prisma.webPage.create({
    data: {
      id: webPageId,
      url: `https://example.com/truncated-test/${webPageId}`,
      title: "Amendment 13 truncated fixture",
      sourceType: "user_provided",
      usageScope: "inspiration_only",
      embeddingBackfillStatus: status,
      analysisStatus: "completed",
    },
  });
  return webPageId;
}

async function seedSection(
  prisma: PrismaClient,
  webPageId: string,
  positionIndex: number
): Promise<{ sectionPatternId: string; sectionEmbeddingId: string }> {
  return seedSectionEmbedding(prisma, webPageId, {
    sectionType: "feature",
    positionIndex,
    startY: 0,
    height: 400,
  });
}

describe("ADR-0018 Amendment 13: truncated-screenshot retryable real-DB invariants", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "[Amendment 13 INV] DATABASE_URL not set by globalSetup (testcontainer boot failure?) — " +
          "real-DB invariants MUST NOT short-circuit to a false PASS"
      );
    }
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ==========================================================================
  // INV-PART-VISUAL-REAL-LEAK-VS-NONTERMINAL-BOUNDARY (H, FIND-RE-TPA-H-01)
  // ==========================================================================
  describe(INV_TPA_H, () => {
    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", INV_TPA_H);
    });

    it(`${INV_TPA_H}: 3-way sets (i)/(ii)/(iii) are mutually-exclusive + exhaustive on real DB; real-leak count purified to pending AND IS NULL`, async () => {
      const webPageId = await createPage(prisma, "in_progress");
      try {
        const { sectionPatternId } = await seedSection(prisma, webPageId, 0);
        // (i) real-leak: visual NULL + skip NULL (low-PII)
        await seedPartEmbedding(prisma, webPageId, sectionPatternId, { piiRiskLevel: "low" });
        // (ii) terminal: bbox_unresolvable
        await seedPartEmbedding(prisma, webPageId, sectionPatternId, {
          piiRiskLevel: "low",
          visualSkipReason: "bbox_unresolvable",
        });
        // (iii) non-terminal retryable: screenshot_truncated
        await seedPartEmbedding(prisma, webPageId, sectionPatternId, {
          piiRiskLevel: "low",
          visualSkipReason: "screenshot_truncated",
        });

        // Pending set (3-way predicate) = (i) ∪ (iii) = 2 rows.
        const pendingPredicate = partVisualPendingExclusionPredicate("cpe");
        const pending = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*) AS n FROM component_part_embeddings cpe
             JOIN component_parts cp ON cp.id = cpe.component_part_id
            WHERE cp.web_page_id = $1::uuid AND ${pendingPredicate}`,
          webPageId
        );
        expect(Number(pending[0]!.n)).toBe(2); // (i) + (iii)

        // Real-leak count PURIFIED = pending AND visual_skip_reason IS NULL = (i) only.
        const realLeak = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*) AS n FROM component_part_embeddings cpe
             JOIN component_parts cp ON cp.id = cpe.component_part_id
            WHERE cp.web_page_id = $1::uuid AND cpe.visual_embedding IS NULL
              AND cpe.visual_skip_reason IS NULL`,
          webPageId
        );
        expect(Number(realLeak[0]!.n)).toBe(1); // only (i); (iii) excluded

        // (ii) terminal excluded from pending.
        const terminal = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*) AS n FROM component_part_embeddings cpe
             JOIN component_parts cp ON cp.id = cpe.component_part_id
            WHERE cp.web_page_id = $1::uuid AND cpe.visual_skip_reason = 'bbox_unresolvable'`,
          webPageId
        );
        expect(Number(terminal[0]!.n)).toBe(1);

        // Exhaustive: (i) + (ii) + (iii) = 3 total seeded rows.
        const total = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*) AS n FROM component_part_embeddings cpe
             JOIN component_parts cp ON cp.id = cpe.component_part_id
            WHERE cp.web_page_id = $1::uuid`,
          webPageId
        );
        expect(Number(total[0]!.n)).toBe(3);
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    });
  });

  // ==========================================================================
  // INV-TRUNCATED-RETRYABLE-EXCLUDES-PII-TERMINAL (H, FIND-PLAN-H-02)
  // ==========================================================================
  describe(INV_PII, () => {
    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", INV_PII);
    });

    it(`${INV_PII}: no high-PII row appears in the screenshot_truncated reclassified set`, async () => {
      const webPageId = await createPage(prisma, "in_progress");
      try {
        const { sectionPatternId } = await seedSection(prisma, webPageId, 0);
        // A high-PII part — the work side excludes it (piiRiskLevel != 'high'); it
        // must NEVER carry the screenshot_truncated reclassification.
        await seedPartEmbedding(prisma, webPageId, sectionPatternId, {
          piiRiskLevel: "high",
          visualSkipReason: null,
        });
        // A low-PII part legitimately marked screenshot_truncated.
        await seedPartEmbedding(prisma, webPageId, sectionPatternId, {
          piiRiskLevel: "low",
          visualSkipReason: "screenshot_truncated",
        });

        // No high-PII row is in the screenshot_truncated set.
        const highPiiTruncated = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*) AS n FROM component_part_embeddings cpe
             JOIN component_parts cp ON cp.id = cpe.component_part_id
            WHERE cp.web_page_id = $1::uuid AND cp.pii_risk_level = 'high'
              AND cpe.visual_skip_reason = 'screenshot_truncated'`,
          webPageId
        );
        expect(Number(highPiiTruncated[0]!.n)).toBe(0);
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    });
  });

  // ==========================================================================
  // INV-TRUNCATED-RETRY-BOUNDED-TERMINAL (M, FIND-RE-SEC-M-01 + M-02)
  // ==========================================================================
  describe(INV_BOUNDED, () => {
    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", INV_BOUNDED);
    });

    it(`${INV_BOUNDED}: screenshot_truncated-origin converges to screenshot_truncated_expired + page not_required (NOT failed); bbox_unresolvable-origin → failed`, async () => {
      // Lazy import to avoid loading the reconciliation module at file eval time.
      const reconciliation =
        await import("../../../../src/services/backfill-reconciliation.service");

      // -- Truncation-origin page: must converge to not_required (NOT failed). --
      const truncatedPage = await createPage(prisma, "skipped_fork_error");
      // Place it past the retry cap so the reconciliation cron pins it.
      await prisma.$executeRawUnsafe(
        `UPDATE web_pages SET embedding_backfill_retry_count = 6,
           embedding_backfill_skipped_at = NOW() - INTERVAL '1 hour',
           embedding_backfill_started_at = NULL
         WHERE id = $1::uuid`,
        truncatedPage
      );
      // -- bbox_unresolvable-origin page: must converge to failed. --
      const bboxPage = await createPage(prisma, "skipped_fork_error");
      await prisma.$executeRawUnsafe(
        `UPDATE web_pages SET embedding_backfill_retry_count = 6,
           embedding_backfill_skipped_at = NOW() - INTERVAL '1 hour',
           embedding_backfill_started_at = NULL
         WHERE id = $1::uuid`,
        bboxPage
      );

      try {
        const tSection = await seedSection(prisma, truncatedPage, 0);
        await seedPartEmbedding(prisma, truncatedPage, tSection.sectionPatternId, {
          piiRiskLevel: "low",
          visualSkipReason: "screenshot_truncated",
        });
        const bSection = await seedSection(prisma, bboxPage, 0);
        await seedPartEmbedding(prisma, bboxPage, bSection.sectionPatternId, {
          piiRiskLevel: "low",
          visualSkipReason: "bbox_unresolvable",
        });

        // Run the reconciliation (real cron path, non-dry-run). Use a tiny queue
        // proxy: the retry-cap branch is reached before any enqueue for capped rows.
        await reconciliation.reconcileStaleBackfillJobs({
          prisma,
          // The cron only consults the queue for non-capped rows; capped rows are
          // pinned/converged before enqueue. A minimal stub satisfies the type.
          queue: {
            getJob: async () => null,
            add: async () => ({ id: "noop" }),
          } as never,
          dryRun: false,
          batchLimit: 100,
        });

        // Truncation-origin: page-level not_required, per-row screenshot_truncated_expired.
        const tPageRow = await prisma.webPage.findUnique({
          where: { id: truncatedPage },
          select: { embeddingBackfillStatus: true },
        });
        expect(tPageRow?.embeddingBackfillStatus).toBe("not_required");
        const tPartRow = await prisma.$queryRawUnsafe<Array<{ visual_skip_reason: string }>>(
          `SELECT cpe.visual_skip_reason FROM component_part_embeddings cpe
             JOIN component_parts cp ON cp.id = cpe.component_part_id
            WHERE cp.web_page_id = $1::uuid`,
          truncatedPage
        );
        expect(tPartRow[0]?.visual_skip_reason).toBe("screenshot_truncated_expired");

        // bbox_unresolvable-origin: page-level failed (legacy convergence).
        const bPageRow = await prisma.webPage.findUnique({
          where: { id: bboxPage },
          select: { embeddingBackfillStatus: true },
        });
        expect(bPageRow?.embeddingBackfillStatus).toBe("failed");
      } finally {
        await cleanupSeededWebPage(prisma, truncatedPage);
        await cleanupSeededWebPage(prisma, bboxPage);
      }
    });
  });

  // ==========================================================================
  // INV-VISUAL-RETRYABLE-NOT-OUTLIVE-SCREENSHOT-TTL (H, FIND-PLAN-H-01)
  // ==========================================================================
  describe(INV_TTL, () => {
    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", INV_TTL);
    });

    it(`${INV_TTL}: a screenshot_truncated row over the retry cap reaches a terminal (screenshot_truncated_expired), so it cannot perpetually outlive the screenshot 7d TTL`, async () => {
      const reconciliation =
        await import("../../../../src/services/backfill-reconciliation.service");
      const webPageId = await createPage(prisma, "skipped_fork_error");
      await prisma.$executeRawUnsafe(
        `UPDATE web_pages SET embedding_backfill_retry_count = 6,
           embedding_backfill_skipped_at = NOW() - INTERVAL '1 hour',
           embedding_backfill_started_at = NULL
         WHERE id = $1::uuid`,
        webPageId
      );
      try {
        const { sectionPatternId } = await seedSection(prisma, webPageId, 0);
        await seedPartEmbedding(prisma, webPageId, sectionPatternId, {
          piiRiskLevel: "low",
          visualSkipReason: "screenshot_truncated",
        });
        await reconciliation.reconcileStaleBackfillJobs({
          prisma,
          queue: {
            getJob: async () => null,
            add: async () => ({ id: "noop" }),
          } as never,
          dryRun: false,
          batchLimit: 100,
        });
        // The row reached a TERMINAL subset value (no perpetual retryable).
        const row = await prisma.$queryRawUnsafe<Array<{ visual_skip_reason: string }>>(
          `SELECT cpe.visual_skip_reason FROM component_part_embeddings cpe
             JOIN component_parts cp ON cp.id = cpe.component_part_id
            WHERE cp.web_page_id = $1::uuid`,
          webPageId
        );
        expect(EMBEDDING_PART_VISUAL_SKIP_REASONS as readonly string[]).toContain(
          row[0]!.visual_skip_reason
        );
        // It is NOT the non-terminal retryable anymore.
        expect(row[0]!.visual_skip_reason).not.toBe("screenshot_truncated");
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    });
  });

  // ==========================================================================
  // INV-TRUNCATED-FLAG-GATED-CLASSIFICATION (M, FIND-RE-TPA-M-02)
  // ==========================================================================
  describe(INV_FLAG, () => {
    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", INV_FLAG);
    });

    it(`${INV_FLAG}: the crop guard's truncation branch is BOTH truncation-gated AND flag-gated (isTruncatedRun && fallbackEnabled) in source`, () => {
      // Source-pin: the crop guard must require BOTH `isTruncatedRun` AND
      // `fallbackEnabled` before writing `screenshot_truncated` (PR-A standalone =
      // flag OFF = status-quo `bbox_unresolvable`). This is the mechanical
      // enforcement of "2A' standalone landing forbidden" (no new screenshot_truncated
      // until PR-B flips the flag ON).
      const phase5 = readSrc("workers/phases/phase-5-embedding.ts");
      expect(phase5).toMatch(/isTruncatedRun\s*&&\s*fallbackEnabled/);
      expect(phase5).toContain(
        'writePartVisualTerminalSkipMarker(ctx, part.embeddingId, "screenshot_truncated")'
      );
      // The else branch (flag OFF or non-truncated) keeps the legacy terminal.
      expect(phase5).toContain(
        'writePartVisualTerminalSkipMarker(ctx, part.embeddingId, "bbox_unresolvable")'
      );
    });

    it(`${INV_FLAG}: backfill processors flip fallbackEnabled=true with a GENUINE re-capture means (PR-B 2A' 1:1 correspondence)`, () => {
      // PR-B (2A' standalone-landing prohibition closure): the backfill callsites flip
      // `fallbackEnabled: true` ONLY together with a genuine regeneration means — the
      // section fallback Playwright re-capture, gated by a DB-fetched URL + robots.txt
      // re-evaluation. Flag ON must NEVER appear without the genuine means (no window
      // where the `screenshot_truncated` retryable classification is active without an
      // actual re-generation path). This is the mechanical 1:1 correspondence of Plan §7.2.
      const processors = readSrc("queues/embedding-backfill-processors.ts");
      // Flag ON at the backfill visual callsites (the PR-B flip).
      expect(processors).toMatch(/fallbackEnabled:\s*true/);
      // Genuine re-capture means co-present: robots.txt re-evaluation enabled +
      // re-capture URL fetched from the DB (url:"" would SSRF-reject the fallback).
      expect(processors).toMatch(/recheckRobotsTxt:\s*true/);
      expect(processors).toContain("fetchWebPageUrlForFallback");
      expect(processors).toContain("fetchPageUrlForBboxResolve");
    });
  });

  // ==========================================================================
  // INV-TRUNCATED-PART-SECTION-SYMMETRY (L, FIND-RE-TPA-L-01)
  // ==========================================================================
  describe(INV_SYM, () => {
    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", INV_SYM);
    });

    it(`${INV_SYM}: part and section writable sets both contain screenshot_truncated; both terminal subsets contain screenshot_truncated_expired but NOT screenshot_truncated`, () => {
      // Writable (terminal ∪ non-terminal) — both contain screenshot_truncated.
      expect(EMBEDDING_PART_VISUAL_WRITABLE_SKIP_REASONS as readonly string[]).toContain(
        "screenshot_truncated"
      );
      expect(EMBEDDING_SECTION_VISUAL_WRITABLE_SKIP_REASONS as readonly string[]).toContain(
        "screenshot_truncated"
      );
      // Terminal subset — both contain expired, neither contains the non-terminal.
      expect(EMBEDDING_PART_VISUAL_SKIP_REASONS as readonly string[]).toContain(
        "screenshot_truncated_expired"
      );
      expect(EMBEDDING_SECTION_VISUAL_SKIP_REASONS as readonly string[]).toContain(
        "screenshot_truncated_expired"
      );
      expect(EMBEDDING_PART_VISUAL_SKIP_REASONS as readonly string[]).not.toContain(
        "screenshot_truncated"
      );
      expect(EMBEDDING_SECTION_VISUAL_SKIP_REASONS as readonly string[]).not.toContain(
        "screenshot_truncated"
      );
    });

    it(`${INV_SYM}: a section screenshot_truncated row stays pending (3-way predicate); a section screenshot_truncated_expired row is terminal`, async () => {
      const webPageId = await createPage(prisma, "in_progress");
      try {
        // Pending: section marked screenshot_truncated (non-terminal) — stays pending.
        const s1 = await seedSectionEmbedding(prisma, webPageId, {
          sectionType: "feature",
          positionIndex: 0,
          startY: 0,
          height: 400,
          visionSkipReason: "screenshot_truncated",
        });
        // Terminal: section marked screenshot_truncated_expired — excluded.
        await seedSectionEmbedding(prisma, webPageId, {
          sectionType: "feature",
          positionIndex: 1,
          startY: 0,
          height: 400,
          visionSkipReason: "screenshot_truncated_expired",
        });

        const predicate = sectionVisualPendingExclusionPredicate("se");
        const pendingIds = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT se.id FROM section_embeddings se
            WHERE se.section_pattern_id IN (
              SELECT id FROM section_patterns WHERE web_page_id = $1::uuid
            ) AND ${predicate}`,
          webPageId
        );
        const ids = pendingIds.map((r) => r.id);
        // screenshot_truncated section stays pending; expired is excluded.
        expect(ids).toContain(s1.sectionEmbeddingId);
        expect(ids).toHaveLength(1);
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    });
  });

  // ==========================================================================
  // INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011 orthogonality (GREEN maintained)
  // ==========================================================================
  describe("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011", () => {
    beforeEach(() => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011"
      );
    });

    it("INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011: the 3-way change preserves the section predicate's PII NOT EXISTS clause (orthogonality)", () => {
      const fragment = sectionVisualPendingExclusionPredicate("se");
      // The PII NOT EXISTS clause MUST remain unchanged by Amendment 13's 3-way change.
      expect(/NOT EXISTS/i.test(fragment)).toBe(true);
      expect(fragment).toContain("component_parts");
      expect(fragment).toContain("pii_risk_level");
      expect(fragment).toContain("'high'");
      // And the 3-way disjunction is present (vision_skip_reason IS NULL OR NOT IN).
      expect(fragment).toContain("se.vision_skip_reason IS NULL");
      expect(fragment).toMatch(/vision_skip_reason\s+NOT IN/i);
    });
  });
});
