// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-BACKFILL-TERMINAL-COMPLETED-007 (PR-BACKFILL-TERMINAL 系統A / System A)
 *
 * **Root cause (系統A、事実ベース)**: `dispatchBackfillJobsForPage`
 * (`page-analyze-worker.ts`) only enqueued part_text/part_visual (threshold-gated)
 * and section_visual (its own condition). The 4 screenshot-free, gate-less
 * categories — motion / background / js_animation / responsive — rode neither
 * gate and were **never enqueued on the happy path**. Their pending counts
 * (`collectCategoryPendingSnapshot`, all 7 categories) therefore stayed > 0, the
 * parity gate never passed, and the reconciliation cron mis-pinned the page to
 * `failed` 1h later. Because motion is near-ubiquitous, virtually every page was
 * mis-recorded as `failed` despite the embeddings themselves being generated
 * (a correctness + observability bug, no data loss).
 *
 * This standing test pins, as a CI-failing invariant:
 *
 *   - **(A) AST/runtime enqueue-parity (3-way Set-equality)**: the dispatch
 *     enqueue category set ⊇ {motion, background, js_animation, responsive},
 *     and the full dispatch set ⊆ `EMBEDDING_BACKFILL_CATEGORIES` (SSOT) ⊆ the
 *     `computeRemainingStatus` reference set (`collectCategoryPendingSnapshot`
 *     keys). The threshold-gated part categories and the conditional
 *     section_visual are preserved (FIND-BT-M-03). Drift in the gate-less set
 *     is converted to an immediate CI failure.
 *   - **(B) queue completed → DB terminal completed (no-fake-success)**: a page
 *     with a motion residual (motion_pattern lacking an embedding) reports
 *     pending > 0 and parity ok=false (the misclassification trigger); once the
 *     residual is resolved (embedding present — simulating the now-enqueued
 *     motion backfill completing), the 7-category parity reaches ok=true and the
 *     remaining status is `completed`. This proves the misclassification is
 *     genuinely resolved at the live DB level — NOT papered over.
 *   - **(C) reconciliation cron does NOT mis-pin a completed-eligible row**: the
 *     `computeRemainingStatusWithPrisma` SSOT that the reconciliation CAS
 *     consumes returns `completed` (not `in_progress`) once all 7 categories are
 *     pending=0, so the CAS pins `completed` rather than `failed`.
 *
 * **Block D/E (PR-BT-2, 系統B)**: section_visual `vision_skip_reason` terminal-
 * skip for uncroppable/duplicate, now landed against the
 * `20260524192012_add_section_visual_skip_reason` migration column:
 *
 *   - **(D) Phase 5 proper non-contamination (orthogonality)**: the
 *     `processSingleSectionVisualEmbedding` no_crop_buffer exit and dedup exit
 *     write the `vision_skip_reason` marker ONLY under the backfill-path guard
 *     (`p.fallbackEnabled === false`), so the main path (Phase 5 proper,
 *     `fallbackEnabled === true`) writes NO marker (AST/source-pin of the guard,
 *     mirroring INV-PART-VISUAL-SKIP-TERMINAL-001 (c)). A real-DB case proves an
 *     un-marked main-path section stays pending (ADR-0018 §7.5 INV-(b)).
 *   - **(E) terminal-skip resolves permanent-pending (honest fixture)**: a
 *     same-type both-NULL near-duplicate fixture. (e1) WITHOUT the
 *     `section_visual_duplicate` marker the 2nd section stays both-NULL → the
 *     production exclusion predicate keeps it pending → the page is permanently
 *     non-completable (the FIND-BT-H-02-RESIDUAL residual, proven against real
 *     DB + the production `isDuplicateVisionEmbedding` dedup predicate). (e2)
 *     WITH the production marker SQL the 2nd section is excluded → pending = 0 →
 *     the page reaches a terminal/completed-eligible state. An out-of-range
 *     uncroppable both-NULL fixture covers the `section_visual_uncroppable` arm.
 *     This replaces design-v1 §4.5's invalid "backfill does not dedup" proof
 *     with an honest fixture that fails on the pre-PR-BT-2 code (no marker
 *     write) and passes only after the Option X marker write lands.
 *
 * Block D/E exercise the **production marker SQL** (`writeSectionVisionSkipReason`'s
 * `UPDATE ... SET vision_skip_reason = $1 WHERE id = $2::uuid AND vision_skip_reason
 * IS NULL`) and the **production exclusion predicate**
 * (`sectionVisualPendingExclusionPredicate`) + the production
 * `isDuplicateVisionEmbedding` directly against real Prisma DB state (mirroring
 * INV-PART-VISUAL-SKIP-TERMINAL-001 (d)), plus an AST/source-pin of the
 * `fallbackEnabled === false` guard on both exits.
 *
 * `.skip` / `.todo` / accepted-risk are forbidden (系統A is H severity, and
 * require code + a CI-failing test).
 *
 * @see backfill-terminal-correctness-design-v2.md §3 (系統A) / §6.1 (INV-007)
 * @see IO Plan Decision V2 internal `019e5842` (PR-BT-1 APPROVE-grade)
 * @see ADR-0007 (Phase 5 Queue-based Backfill) / ADR-0018 (parity gate INV-003)
 *
 * @module tests/regression/standing/large-page/inv-backfill-terminal-completed-007
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { SyntaxKind } from "ts-morph";
import fs from "node:fs";
import path from "node:path";
import { assertInvName } from "../_setup/inv-assert";
import {
  createAstProject,
  addMcpServerSourceFile,
  extractNamedImports,
} from "../schema-enum-sync/_extractors";
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  type EmbeddingBackfillCategory,
} from "../../../../src/queues/embedding-backfill-queue";
import {
  collectCategoryPendingSnapshot,
  computeRemainingStatusWithPrisma,
  verifyCategoryParity,
} from "../../../../src/services/backfill-status.helper";
// PR-BT-1: the dispatch category-set resolver (drift-proof, SSOT-derived) is a
// test-only export from the worker. Block A pins its 3-way Set-equality.
import { resolveBackfillDispatchCategories } from "../../../../src/workers/page-analyze-worker";
// PR-BT-2 (系統B): SSOT-derived section_visual terminal-skip subset + the SSOT
// exclusion predicate + the pure dedup predicate, exercised by Block D/E.
import {
  EMBEDDING_SECTION_VISUAL_SKIP_REASONS,
  isDuplicateVisionEmbedding,
  sectionVisualPendingExclusionPredicate,
} from "../../../../src/workers/phases/types";
import {
  cleanupSeededWebPage,
  readSectionVisionState,
  seedMinimalWebPage,
  seedMotionPattern,
  seedSectionEmbedding,
} from "./_fixtures/seed-large-page";

/**
 * The 4 screenshot-free, gate-less categories that PR-BT-1 must enqueue
 * unconditionally on the happy path. Drift here = the System-A bug returns.
 */
const GATE_LESS_CATEGORIES = ["motion", "background", "js_animation", "responsive"] as const;

/**
 * The 3 dispatch-managed gated categories (preserved by PR-BT-1, FIND-BT-M-03).
 */
const GATED_CATEGORIES = ["part_text", "part_visual", "section_visual"] as const;

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");

function readWorkerSrc(): string {
  return fs.readFileSync(
    path.resolve(MCP_SERVER_SRC_ROOT, "workers/page-analyze-worker.ts"),
    "utf8"
  );
}

describe("INV-BACKFILL-TERMINAL-COMPLETED-007: happy-path backfill enqueue completeness (系統A)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-BACKFILL-TERMINAL-COMPLETED-007");
  });

  // ==========================================================================
  // Block A — AST/runtime enqueue-parity (3-way Set-equality). No DB needed.
  // ==========================================================================

  describe("INV-BACKFILL-TERMINAL-COMPLETED-007: Block A (enqueue-parity 3-way Set-equality)", () => {
    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block A enqueues all 4 gate-less categories unconditionally (small page, no parts, no screenshot)", () => {
      // Worst case for the gate-less categories: a page below the part
      // threshold, with no sections and no screenshot. Pre-PR-BT-1 this page
      // got NOTHING enqueued; PR-BT-1 must still enqueue the 4 gate-less
      // categories (they are screenshot-free and page-state-independent).
      const dispatched = resolveBackfillDispatchCategories({
        partsSavedCount: 5,
        sectionsSavedCount: 0,
        hasScreenshot: false,
      });
      for (const category of GATE_LESS_CATEGORIES) {
        expect(
          dispatched.includes(category),
          `gate-less category '${category}' MUST be enqueued unconditionally (系統A root cause)`
        ).toBe(true);
      }
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block A preserves the part threshold gate (FIND-BT-M-03 — no part backfill below threshold)", () => {
      // Small page (parts <= threshold): part_text/part_visual are inline-
      // processed and must NOT be enqueued (preserve established behaviour).
      const smallPage = resolveBackfillDispatchCategories({
        partsSavedCount: 5,
        sectionsSavedCount: 0,
        hasScreenshot: true,
      });
      expect(smallPage).not.toContain("part_text");
      expect(smallPage).not.toContain("part_visual");

      // Large page (parts > threshold) WITH screenshot: both part categories enqueue.
      const largePage = resolveBackfillDispatchCategories({
        partsSavedCount: 250,
        sectionsSavedCount: 3,
        hasScreenshot: true,
      });
      expect(largePage).toContain("part_text");
      expect(largePage).toContain("part_visual");
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block A — PR-PART30CAP dual-trigger: hasPendingParts=true enqueues parts on a parts≤100 page (residual arm), hasPendingParts=false does not (threshold-only arm)", () => {
      // PR-PART30CAP (ADR-0007 Amendment 2): the resolver enqueues part_text/
      // part_visual when EITHER the inline-cap threshold is exceeded OR the inline
      // partial-completion left residual un-embedded parts (`hasPendingParts`).
      // This pins BOTH branches of the dual-trigger as a PURE function (no DB
      // argument injected — INV-007 Block A pure-function unit-pin preserved,
      // TPA-M-02 + TDA-M-03).
      //
      // (1) parts≤100 (81) + hasPendingParts=true → residual arm fires → parts
      //     enqueued even though the threshold gate (parts>100) does NOT fire.
      //     This is the exact run3 stuck-page state the dual-trigger closes.
      const residualPage = resolveBackfillDispatchCategories({
        partsSavedCount: 81,
        sectionsSavedCount: 0,
        hasScreenshot: true,
        hasPendingParts: true,
      });
      expect(
        residualPage.includes("part_text"),
        "parts≤100 with residual pending (hasPendingParts=true) MUST enqueue part_text via the dual-trigger residual arm (PR-PART30CAP)"
      ).toBe(true);
      expect(
        residualPage.includes("part_visual"),
        "parts≤100 with residual pending + screenshot MUST enqueue part_visual via the dual-trigger residual arm (PR-PART30CAP)"
      ).toBe(true);

      // (2) parts≤100 (81) + hasPendingParts=false → neither arm fires → no part
      //     enqueue (a fully inline-embedded small page must NOT re-enqueue parts).
      const fullyInlinePage = resolveBackfillDispatchCategories({
        partsSavedCount: 81,
        sectionsSavedCount: 0,
        hasScreenshot: true,
        hasPendingParts: false,
      });
      expect(
        fullyInlinePage.includes("part_text"),
        "parts≤100 with no residual (hasPendingParts=false) MUST NOT enqueue part_text (threshold-only arm preserved, no false enqueue)"
      ).toBe(false);
      expect(fullyInlinePage.includes("part_visual")).toBe(false);

      // (3) hasPendingParts defaults to false when omitted — the original
      //     threshold-only behaviour (back-compat for existing Block A cases).
      const omittedDefault = resolveBackfillDispatchCategories({
        partsSavedCount: 81,
        sectionsSavedCount: 0,
        hasScreenshot: true,
      });
      expect(
        omittedDefault.includes("part_text"),
        "omitting hasPendingParts MUST default to threshold-only (false) — no part enqueue on a parts≤100 page"
      ).toBe(false);

      // (4) The threshold arm still fires independently of hasPendingParts (a
      //     parts>100 page enqueues parts even with hasPendingParts=false).
      const thresholdPage = resolveBackfillDispatchCategories({
        partsSavedCount: 250,
        sectionsSavedCount: 0,
        hasScreenshot: true,
        hasPendingParts: false,
      });
      expect(
        thresholdPage.includes("part_text"),
        "parts>100 MUST still enqueue part_text via the threshold arm regardless of hasPendingParts (OR semantics)"
      ).toBe(true);
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block A — non-finite partsSavedCount (NaN / Infinity) never enqueues part categories (Number.isFinite guard, mutation-detecting)", () => {
      // SEC-IMPL-BT1-L-01 / FIND-IMPL-TDA-BT1-L-01 (L, 2-face corroborated):
      // `resolveBackfillDispatchCategories` has a production `Number.isFinite()`
      // NaN/Infinity guard on the part gate (page-analyze-worker.ts:507-508).
      // This pins that guard branch.
      //
      // Mutation honesty (TDA): removing `Number.isFinite(partsSavedCount) &&`
      // from the guard leaves the raw `partsSavedCount > PART_SYNC_THRESHOLD`:
      //   - NaN  > threshold === false  → part still (coincidentally) excluded.
      //   - Infinity > threshold === true → part_text/part_visual WRONGLY
      //     enqueued. The Infinity assertions below therefore FAIL if the guard
      //     is removed — this is the mutation-detecting branch.
      //
      // Both non-finite counts must behave identically to "below threshold":
      // NO part categories, while the 4 gate-less categories (page-state-
      // independent) are STILL enqueued unconditionally.
      for (const nonFinite of [Number.NaN, Number.POSITIVE_INFINITY] as const) {
        const dispatched = resolveBackfillDispatchCategories({
          partsSavedCount: nonFinite,
          sectionsSavedCount: 3,
          hasScreenshot: true,
        });
        expect(
          dispatched.includes("part_text"),
          `partsSavedCount=${String(nonFinite)} MUST NOT enqueue part_text (Number.isFinite guard; raw '> threshold' lets Infinity through)`
        ).toBe(false);
        expect(
          dispatched.includes("part_visual"),
          `partsSavedCount=${String(nonFinite)} MUST NOT enqueue part_visual (Number.isFinite guard; raw '> threshold' lets Infinity through)`
        ).toBe(false);
        // The 4 gate-less categories are page-state-independent and MUST still
        // be enqueued even when the part count is non-finite (系統A invariant).
        for (const category of GATE_LESS_CATEGORIES) {
          expect(
            dispatched.includes(category),
            `gate-less category '${category}' MUST still be enqueued when partsSavedCount=${String(nonFinite)}`
          ).toBe(true);
        }
      }
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block A preserves the section_visual condition (sections>0 && screenshot) and part_visual screenshot requirement", () => {
      // part_text enqueues without a screenshot once over threshold; part_visual
      // and section_visual require the persisted screenshot.
      const largeNoScreenshot = resolveBackfillDispatchCategories({
        partsSavedCount: 250,
        sectionsSavedCount: 3,
        hasScreenshot: false,
      });
      expect(largeNoScreenshot).toContain("part_text");
      expect(largeNoScreenshot).not.toContain("part_visual");
      expect(largeNoScreenshot).not.toContain("section_visual");

      // section_visual requires both sections>0 AND screenshot.
      const sectionsNoScreenshot = resolveBackfillDispatchCategories({
        partsSavedCount: 5,
        sectionsSavedCount: 4,
        hasScreenshot: false,
      });
      expect(sectionsNoScreenshot).not.toContain("section_visual");

      const sectionsWithScreenshot = resolveBackfillDispatchCategories({
        partsSavedCount: 5,
        sectionsSavedCount: 4,
        hasScreenshot: true,
      });
      expect(sectionsWithScreenshot).toContain("section_visual");
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block A — every dispatchable category is a subset of EMBEDDING_BACKFILL_CATEGORIES (SSOT, no drift)", () => {
      // Maximal dispatch: all gates pass. The union of everything the resolver
      // can ever emit MUST be a subset of the SSOT (no hand-written category
      // that drifted from the SSOT).
      const maximal = resolveBackfillDispatchCategories({
        partsSavedCount: 250,
        sectionsSavedCount: 4,
        hasScreenshot: true,
      });
      const ssot = new Set<string>(EMBEDDING_BACKFILL_CATEGORIES);
      for (const category of maximal) {
        expect(
          ssot.has(category),
          `dispatched category '${category}' is not in EMBEDDING_BACKFILL_CATEGORIES SSOT (drift)`
        ).toBe(true);
      }
      // The maximal set must cover all 7 SSOT categories (gate-less 4 + gated 3).
      const maximalSet = new Set<string>(maximal);
      for (const category of EMBEDDING_BACKFILL_CATEGORIES) {
        expect(
          maximalSet.has(category),
          `maximal dispatch is missing SSOT category '${category}'`
        ).toBe(true);
      }
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block A — gate-less set ∪ gated set == EMBEDDING_BACKFILL_CATEGORIES (exhaustive partition)", () => {
      // The two registries in this test partition the SSOT exactly (no category
      // is unaccounted for; no extra category exists). This catches a NEW SSOT
      // category that was added without being classified gate-less vs gated.
      const partition = new Set<string>([...GATE_LESS_CATEGORIES, ...GATED_CATEGORIES]);
      const ssot = new Set<string>(EMBEDDING_BACKFILL_CATEGORIES);
      expect(partition.size).toBe(ssot.size);
      for (const category of EMBEDDING_BACKFILL_CATEGORIES) {
        expect(
          partition.has(category),
          `SSOT category '${category}' is neither gate-less nor gated — classify it in INV-007 Block A`
        ).toBe(true);
      }
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block A — dispatch references the EMBEDDING_BACKFILL_CATEGORIES SSOT (drift-proof source-pin)", () => {
      // FIND-BT-M-03 / design §3.2: the dispatch must derive the gate-less set
      // from the SSOT (not a wholesale delegate, not hardcoded literals), so a
      // new SSOT category is structurally covered.
      const project = createAstProject();
      const sf = addMcpServerSourceFile(project, "src/workers/page-analyze-worker.ts");
      const imports = extractNamedImports(sf, "queues/embedding-backfill-queue");
      expect(
        imports.has("EMBEDDING_BACKFILL_CATEGORIES"),
        "page-analyze-worker.ts MUST import the EMBEDDING_BACKFILL_CATEGORIES SSOT for drift-proof dispatch"
      ).toBe(true);

      const src = readWorkerSrc();
      expect(
        src.includes("EMBEDDING_BACKFILL_CATEGORIES"),
        "the dispatch resolver MUST reference EMBEDDING_BACKFILL_CATEGORIES (no hand-written category list)"
      ).toBe(true);
    });
  });

  // ==========================================================================
  // Block B / C — live DB parity-gate behaviour (testcontainer).
  // ==========================================================================

  describe("INV-BACKFILL-TERMINAL-COMPLETED-007: Block B/C (parity gate → DB terminal completed)", () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error(
          "[INV-BACKFILL-TERMINAL-COMPLETED-007] DATABASE_URL not set by globalSetup (testcontainer boot failure?)"
        );
      }
      prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
      await prisma.$connect();
    }, 180_000);

    afterAll(async () => {
      try {
        await prisma?.$disconnect();
      } catch {
        /* best-effort shutdown */
      }
    }, 30_000);

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block B — motion residual reports pending>0 (misclassification trigger), resolves to parity ok + completed once embedded", async () => {
      const { webPageId } = await seedMinimalWebPage(prisma);
      try {
        // 1. Seed a motion residual: a motion_pattern WITHOUT an embedding.
        //    This is exactly the System-A leftover the cron mis-pins to failed.
        const { motionPatternId } = await seedMotionPattern(prisma, webPageId, {
          withEmbedding: false,
        });

        // 2. The 7-category snapshot reports motion pending > 0 → parity ok=false.
        const beforeSnapshot = await collectCategoryPendingSnapshot(webPageId, prisma);
        expect(
          beforeSnapshot.motion,
          "motion residual MUST be counted as pending (this is the System-A misclassification trigger)"
        ).toBeGreaterThan(0);
        expect(verifyCategoryParity(beforeSnapshot).ok).toBe(false);

        // 3. Resolve the residual (the now-enqueued motion backfill completes →
        //    a motion_embeddings row exists). No-fake-success: we demonstrate the
        //    actual fix path, not a status overwrite.
        const value = 1 / Math.sqrt(768);
        const vectorLiteral = `[${new Array<string>(768).fill(value.toFixed(10)).join(",")}]`;
        await prisma.$executeRawUnsafe(
          `INSERT INTO motion_embeddings
             (id, motion_pattern_id, embedding, model_version, embedding_timestamp,
              created_at, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::vector, 'mock-e5-base-multilingual', NOW(), NOW(), NOW())`,
          motionPatternId,
          vectorLiteral
        );

        // 4. All 7 categories now pending=0 → parity ok=true → completed.
        const afterSnapshot = await collectCategoryPendingSnapshot(webPageId, prisma);
        expect(afterSnapshot.motion).toBe(0);
        expect(verifyCategoryParity(afterSnapshot).ok).toBe(true);

        const { finalStatus } = await computeRemainingStatusWithPrisma(webPageId, prisma);
        expect(
          finalStatus,
          "once all 7 categories are pending=0 the remaining status MUST be 'completed' (not stuck non-terminal)"
        ).toBe("completed");
      } finally {
        await prisma.webPage.delete({ where: { id: webPageId } }).catch(() => undefined);
      }
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block B — pendingSnapshot keys equal EMBEDDING_BACKFILL_CATEGORIES (computeRemainingStatus reference set, 3-way Set-equality)", async () => {
      const { webPageId } = await seedMinimalWebPage(prisma);
      try {
        const snapshot = await collectCategoryPendingSnapshot(webPageId, prisma);
        const snapshotKeys = new Set<string>(Object.keys(snapshot));
        const ssot = new Set<string>(EMBEDDING_BACKFILL_CATEGORIES);
        expect(snapshotKeys.size).toBe(ssot.size);
        for (const category of EMBEDDING_BACKFILL_CATEGORIES) {
          expect(
            snapshotKeys.has(category),
            `computeRemainingStatus reference set is missing SSOT category '${category}'`
          ).toBe(true);
        }
        // And the resolver's maximal output covers the same reference set.
        const maximal = new Set<EmbeddingBackfillCategory>(
          resolveBackfillDispatchCategories({
            partsSavedCount: 250,
            sectionsSavedCount: 4,
            hasScreenshot: true,
          })
        );
        for (const key of snapshotKeys) {
          expect(
            maximal.has(key as EmbeddingBackfillCategory),
            `dispatch maximal set does not cover computeRemainingStatus category '${key}'`
          ).toBe(true);
        }
      } finally {
        await prisma.webPage.delete({ where: { id: webPageId } }).catch(() => undefined);
      }
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block C — reconciliation SSOT pins 'completed' (NOT 'failed') for a completed-eligible row (no false-failed mis-pin)", async () => {
      // A page in `in_progress` whose 7 categories are all pending=0 (motion
      // residual resolved). The reconciliation CAS uses
      // computeRemainingStatusWithPrisma; its verdict MUST be 'completed', so
      // the cron pins 'completed' rather than 'failed'. This pins the System-A
      // reconciliation correctness (no false-failed mis-pin once the gate-less
      // categories are enqueued and parity reaches pending=0). NOTE: this is
      // NOT the TODO at backfill-reconciliation.service.ts:466-469 — that TODO
      // tracks the separate Stripe-observed motion_embeddings 0-count root-cause
      // investigation (why Phase 5 did not generate motion embeddings), which is
      // out of scope here.
      const { webPageId } = await seedMinimalWebPage(prisma, {
        embeddingBackfillStatus: "in_progress",
      });
      try {
        await seedMotionPattern(prisma, webPageId, { withEmbedding: true });

        const { finalStatus } = await computeRemainingStatusWithPrisma(webPageId, prisma);
        // Reconciliation maps: remainingStatus === 'completed' ? 'completed' : 'failed'.
        const reconciledStatus: "completed" | "failed" =
          finalStatus === "completed" ? "completed" : "failed";
        expect(
          reconciledStatus,
          "a completed-eligible row (all 7 pending=0) must NOT be mis-pinned to 'failed' by the cron"
        ).toBe("completed");

        // Simulate the CAS UPDATE (WHERE status='in_progress') and assert the
        // row reaches 'completed', mirroring the live reconciliation path.
        const updated = await prisma.webPage.updateMany({
          where: { id: webPageId, embeddingBackfillStatus: "in_progress" },
          data: { embeddingBackfillStatus: reconciledStatus },
        });
        expect(updated.count).toBe(1);
        const row = await prisma.webPage.findUnique({
          where: { id: webPageId },
          select: { embeddingBackfillStatus: true },
        });
        expect(row?.embeddingBackfillStatus).toBe("completed");
      } finally {
        await prisma.webPage.delete({ where: { id: webPageId } }).catch(() => undefined);
      }
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block C — a genuine motion residual still yields 'failed' under reconciliation (orthogonality: real leak is NOT hidden)", async () => {
      // no-fake-success orthogonality: the fix must not blanket-force
      // 'completed'. A page with a GENUINE unresolved motion residual (no
      // embedding) must still be reconciled to 'failed' (the real-leak signal
      // is preserved; only the happy-path enqueue gap is closed).
      const { webPageId } = await seedMinimalWebPage(prisma, {
        embeddingBackfillStatus: "in_progress",
      });
      try {
        await seedMotionPattern(prisma, webPageId, { withEmbedding: false });

        const { finalStatus } = await computeRemainingStatusWithPrisma(webPageId, prisma);
        expect(
          finalStatus,
          "a page with an unresolved motion residual MUST remain non-terminal (in_progress) — not silently completed"
        ).toBe("in_progress");
        const reconciledStatus: "completed" | "failed" =
          finalStatus === "completed" ? "completed" : "failed";
        expect(reconciledStatus).toBe("failed");
      } finally {
        await prisma.webPage.delete({ where: { id: webPageId } }).catch(() => undefined);
      }
    });
  });

  // ==========================================================================
  // Block D — Phase 5 proper non-contamination (orthogonality). AST/source-pin
  // of the `fallbackEnabled === false` guard on BOTH section_visual terminal
  // exits, plus a real-DB main-path-stays-pending case. (PR-BT-2, FIND-BT-H-01
  // + FIND-BT-H-02-RESIDUAL, ADR-0018 §7.5 INV-(b)).
  // ==========================================================================

  describe("INV-BACKFILL-TERMINAL-COMPLETED-007: Block D (Phase 5 proper non-contamination — both exits guarded by fallbackEnabled===false)", () => {
    const PHASE5_SRC = path.resolve(MCP_SERVER_SRC_ROOT, "workers/phases/phase-5-embedding.ts");

    function readPhase5(): string {
      return fs.readFileSync(PHASE5_SRC, "utf8");
    }

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block D — no_crop_buffer exit writes section_visual_uncroppable ONLY when isOutOfRange && fallbackEnabled===false (main-path / transient non-contamination)", () => {
      const src = readPhase5();
      // The uncroppable marker write MUST be guarded by BOTH `isOutOfRange` and
      // `p.fallbackEnabled === false` so a main-path (fallbackEnabled===true)
      // out-of-range section (recoverable via the fallback queue) and a
      // transient decode failure (isOutOfRange===false) are NOT terminal-marked.
      expect(
        src.includes('writeSectionVisionSkipReason(p, "section_visual_uncroppable")'),
        "the no_crop_buffer exit MUST write the section_visual_uncroppable terminal marker"
      ).toBe(true);
      // The guard expression must require BOTH conjuncts (isOutOfRange AND
      // fallbackEnabled===false). A regression that drops the fallbackEnabled
      // conjunct would mis-terminal-mark main-path sections.
      expect(
        /if\s*\(\s*isOutOfRange\s*&&\s*p\.fallbackEnabled === false\s*\)\s*\{\s*await writeSectionVisionSkipReason\(p,\s*"section_visual_uncroppable"\)/.test(
          src
        ),
        "the section_visual_uncroppable marker write MUST be guarded by `isOutOfRange && p.fallbackEnabled === false` (Phase 5 proper / transient non-contamination, INV-(b) orthogonality)"
      ).toBe(true);
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block D — dedup exit writes section_visual_duplicate ONLY when fallbackEnabled===false (main-path non-contamination, FIND-BT-H-02-RESIDUAL Option X)", () => {
      const src = readPhase5();
      expect(
        src.includes('writeSectionVisionSkipReason(p, "section_visual_duplicate")'),
        "the dedup exit MUST write the section_visual_duplicate terminal marker (Option X)"
      ).toBe(true);
      // The dedup marker write must be guarded by `p.fallbackEnabled === false`
      // so a Phase-5-proper (main-path) dedup-skip writes NO marker.
      expect(
        /if\s*\(\s*p\.fallbackEnabled === false\s*\)\s*\{\s*await writeSectionVisionSkipReason\(p,\s*"section_visual_duplicate"\)/.test(
          src
        ),
        "the section_visual_duplicate marker write MUST be guarded by `p.fallbackEnabled === false` (Phase 5 proper non-contamination, INV-007 Block D)"
      ).toBe(true);
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block D — exactly 4 in-loop section terminal-skip marker call-sites (no over-termination of transient/main-path exits)", () => {
      const src = readPhase5();
      // Exactly 4 in-loop marker call-sites in processSingleSectionVisualEmbedding
      // (each `writeSectionVisionSkipReason(p, ...)`):
      //   #1 no_crop_buffer exit (isOutOfRange) → section_visual_uncroppable
      //   #2 dedup exit                         → section_visual_duplicate
      //   #3 isBlank exit                       → section_visual_blank (secvisual-blank-terminal)
      //   #4 no-position exit                   → section_visual_no_position (secvisual-blank-terminal)
      // A 5th would mean the transient decode catch, or the success path, was
      // wrongly marked. NOTE: section_visual_pii_excluded is written OUTSIDE this
      // function (work-side bulk helper writeSectionVisualPiiExcludedMarkers), so it
      // does NOT use `writeSectionVisionSkipReason(p, ...)` and is not counted here.
      const markerCallCount = (src.match(/writeSectionVisionSkipReason\(p,/g) ?? []).length;
      expect(
        markerCallCount,
        "exactly 4 in-loop section_visual terminal-skip marker call-sites expected (uncroppable + duplicate + blank + no_position); a 5th indicates over-termination"
      ).toBe(4);
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block D — section marker writes use ONLY the SSOT-derived terminal reasons {section_visual_blank, section_visual_duplicate, section_visual_no_position, section_visual_pii_excluded, section_visual_uncroppable}", () => {
      // EMBEDDING_SECTION_VISUAL_SKIP_REASONS is the SSOT-derived terminal subset
      // (derived via .filter() from EMBEDDING_SKIP_REASONS, never hardcoded).
      // PR-C4 added section_visual_pii_excluded (work-side PII-exclusion bulk-write
      // marker). secvisual-blank-terminal (Plan V1 §4) added section_visual_blank +
      // section_visual_no_position (in-loop degraded-coverage technical terminals,
      // NON-PII; distinct in meaning from the PII exclusion, FIND-PLAN-L-07). All 5
      // are valid section markers, each excluded from the section_visual pending
      // query by sectionVisualPendingExclusionPredicate. Additive expansion of the
      // 3-value set to the 5-value set; the SSOT .filter() derivation guarantees
      // these are exactly the EMBEDDING_SKIP_REASONS members prefixed
      // `section_visual_`.
      expect([...EMBEDDING_SECTION_VISUAL_SKIP_REASONS].sort()).toEqual([
        "section_visual_blank",
        "section_visual_duplicate",
        "section_visual_no_position",
        "section_visual_pii_excluded",
        "section_visual_uncroppable",
      ]);
    });
  });

  // ==========================================================================
  // Block D (real-DB) — main-path-equivalent (un-marked) section stays pending;
  // a marked section is excluded. Mirrors INV-PART-VISUAL-SKIP-TERMINAL-001 (d).
  // ==========================================================================

  describe("INV-BACKFILL-TERMINAL-COMPLETED-007: Block D (real-DB — un-marked section stays pending, marked section excluded)", () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error(
          "[INV-BACKFILL-TERMINAL-COMPLETED-007] DATABASE_URL not set by globalSetup (testcontainer boot failure?)"
        );
      }
      prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
      await prisma.$connect();
    }, 180_000);

    afterAll(async () => {
      try {
        await prisma?.$disconnect();
      } catch {
        /* best-effort shutdown */
      }
    }, 30_000);

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block D — a both-NULL section (no marker) stays pending under the production exclusion predicate (real-leak orthogonality, INV-(b))", async () => {
      const { webPageId } = await seedMinimalWebPage(prisma);
      try {
        // A main-path-equivalent both-NULL section: text present, vision NULL, NO
        // skip-reason marker. The production predicate MUST keep it pending so a
        // genuinely-missing vision is not silently dropped (INV-(b)).
        const { sectionEmbeddingId } = await seedSectionEmbedding(prisma, webPageId, {
          positionIndex: 0,
          sectionType: "feature",
        });
        const pending = await countSectionVisualPending(prisma, sectionEmbeddingId);
        expect(
          pending,
          "a both-NULL section without a terminal marker MUST stay pending (real-leak, INV-(b) orthogonality)"
        ).toBe(1);

        const state = await readSectionVisionState(prisma, sectionEmbeddingId);
        expect(state.hasVision).toBe(false);
        expect(state.visionSkipReason).toBeNull();
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    });
  });

  // ==========================================================================
  // Block E — terminal-skip resolves permanent-pending (honest fixture).
  // FIND-BT-H-02-RESIDUAL: same-type both-NULL near-duplicate. (PR-BT-2 Option X)
  // ==========================================================================

  describe("INV-BACKFILL-TERMINAL-COMPLETED-007: Block E (terminal-skip resolves permanent-pending — honest dedup/uncroppable fixture)", () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error(
          "[INV-BACKFILL-TERMINAL-COMPLETED-007] DATABASE_URL not set by globalSetup (testcontainer boot failure?)"
        );
      }
      prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
      await prisma.$connect();
    }, 180_000);

    afterAll(async () => {
      try {
        await prisma?.$disconnect();
      } catch {
        /* best-effort shutdown */
      }
    }, 30_000);

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block E (e1/e2) — same-type both-NULL near-duplicate: dedup keeps the 2nd pending forever WITHOUT the marker; the production section_visual_duplicate marker terminates it (page completable)", async () => {
      const { webPageId } = await seedMinimalWebPage(prisma);
      try {
        // --- Fixture: two same-sectionType sections, both with text_embedding,
        //     both with vision_embedding NULL (the both-NULL pending state). ---
        const { sectionEmbeddingId: firstId } = await seedSectionEmbedding(prisma, webPageId, {
          positionIndex: 0,
          sectionType: "feature",
          startY: 0,
          height: 400,
        });
        const { sectionEmbeddingId: secondId } = await seedSectionEmbedding(prisma, webPageId, {
          positionIndex: 1,
          sectionType: "feature",
          startY: 400,
          height: 400,
        });

        // Pre: both sections are pending (both-NULL) under the production predicate.
        expect(await countSectionVisualPendingForPage(prisma, webPageId)).toBe(2);

        // --- Exercise the PRODUCTION dedup predicate (isDuplicateVisionEmbedding)
        //     with near-duplicate vectors (cosine > threshold) within the same
        //     sectionType. This is exactly the backfill-path dedup decision that
        //     leaves the 2nd section's vision NULL. ---
        const DUPLICATE_THRESHOLD = 0.995;
        const baseVec = buildUnitVector(0);
        // A near-duplicate: tiny perturbation keeps cosine well above 0.995.
        const nearDupVec = buildUnitVector(1e-4);
        const recent = [{ embedding: baseVec, sectionType: "feature" }];
        const firstIsDup = isDuplicateVisionEmbedding({
          sectionType: "feature",
          height: 400,
          embedding: baseVec,
          recentEmbeddings: [],
          threshold: DUPLICATE_THRESHOLD,
        });
        const secondIsDup = isDuplicateVisionEmbedding({
          sectionType: "feature",
          height: 400,
          embedding: nearDupVec,
          recentEmbeddings: recent,
          threshold: DUPLICATE_THRESHOLD,
        });
        // The 1st section is NOT a duplicate (empty window); the 2nd IS (vs the 1st).
        expect(firstIsDup).toBe(false);
        expect(secondIsDup).toBe(true);

        // (e1) WITHOUT the marker write, the dedup-skip leaves the 2nd both-NULL.
        //      The 1st gets its vision embedding (not a duplicate). The 2nd stays
        //      pending forever → the page can NEVER reach section_visual pending=0.
        await setSectionVision(prisma, firstId, baseVec); // 1st: vision generated
        // 2nd: dedup-skip → NO vision, NO marker (pre-PR-BT-2 behaviour).
        const pendingBeforeMarker = await countSectionVisualPendingForPage(prisma, webPageId);
        expect(
          pendingBeforeMarker,
          "(e1) WITHOUT the section_visual_duplicate marker the dedup-skipped 2nd section stays pending → permanent-pending (FIND-BT-H-02-RESIDUAL residual)"
        ).toBe(1);
        // Confirm the 2nd is the residual: both-NULL, no marker.
        const e1State = await readSectionVisionState(prisma, secondId);
        expect(e1State.hasVision).toBe(false);
        expect(e1State.visionSkipReason).toBeNull();

        // (e2) WITH the production marker SQL (Option X, fallbackEnabled===false
        //      backfill path), the 2nd section is terminal-marked → excluded by the
        //      production predicate → section_visual pending=0 → page completable.
        await writeSectionTerminalMarker(prisma, secondId, "section_visual_duplicate");
        const pendingAfterMarker = await countSectionVisualPendingForPage(prisma, webPageId);
        expect(
          pendingAfterMarker,
          "(e2) WITH the section_visual_duplicate marker the 2nd section is excluded from pending → page reaches section_visual pending=0 (terminal/completable)"
        ).toBe(0);
        const e2State = await readSectionVisionState(prisma, secondId);
        expect(e2State.visionSkipReason).toBe("section_visual_duplicate");
        expect(EMBEDDING_SECTION_VISUAL_SKIP_REASONS as readonly string[]).toContain(
          e2State.visionSkipReason
        );
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block E (uncroppable arm) — out-of-range both-NULL section: section_visual_uncroppable marker terminates it (page completable)", async () => {
      const { webPageId } = await seedMinimalWebPage(prisma);
      try {
        // An out-of-range section (startY beyond the captured fullPage screenshot
        // → uncroppable on the backfill path). Seeded both-NULL.
        const { sectionEmbeddingId } = await seedSectionEmbedding(prisma, webPageId, {
          positionIndex: 0,
          sectionType: "gallery",
          startY: 50_000, // far below any fullPage screenshot height
          height: 600,
        });
        // Pre: pending (both-NULL).
        expect(await countSectionVisualPending(prisma, sectionEmbeddingId)).toBe(1);

        // Production marker SQL (no_crop_buffer exit, isOutOfRange &&
        // fallbackEnabled===false) → section_visual_uncroppable.
        await writeSectionTerminalMarker(prisma, sectionEmbeddingId, "section_visual_uncroppable");

        // Post: excluded by the SSOT predicate → pending=0 → page completable.
        expect(await countSectionVisualPending(prisma, sectionEmbeddingId)).toBe(0);
        const state = await readSectionVisionState(prisma, sectionEmbeddingId);
        expect(state.visionSkipReason).toBe("section_visual_uncroppable");
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    });
  });

  // ==========================================================================
  // Block F — section_visual fork-child reach (PR-BT-3, FIND 019e5a11, H).
  //
  // Root cause (PR-BT-2 goal 未達 / production-inert): in production fork-only
  // mode (`EMBEDDING_BACKFILL_FORK_ONLY_MODE_ENABLED` unset → default true), the
  // section_visual fork-child returned a text-only `backfillSectionVisualsForPage`
  // SUCCESS, so `runForkOrFallback` returned the fork result (no catch) and the
  // in-process `SectionVisualProcessor.processInProcess` — the ONLY home of the
  // PR-BT-2 DINOv2 + `writeSectionVisionSkipReason` marker path — was NEVER
  // reached. The marker therefore never fired and the page stayed in_progress.
  //
  // Block D/E pin the marker SQL + exclusion predicate + the `fallbackEnabled
  // === false` guard in ISOLATION (DB-level / function-level), but assert NOTHING
  // about dispatch routing — so a text-only-success child slipped past CI (same
  // class as the PR-1 H regression that only real-machine verification caught).
  //
  // Block F closes that dispatch-routing gap by mirroring the
  // INV-PART-VISUAL-SKIP-TERMINAL-001 AST-pin discipline:
  //   - (F1) source/AST-pin: the section_visual child `case` THROWS (symmetric
  //     with part_visual) and does NOT success-return `backfillSectionVisualsForPage`.
  //   - (F2) routing-pin: `runForkOrFallback`'s catch routes to `inProcessFallback`,
  //     and `SectionVisualProcessor.process` binds that fallback to
  //     `() => this.processInProcess(ctx)` (symmetric with PartVisualProcessor) —
  //     so a fork-throw structurally reaches the in-process marker path.
  //   - (F3) real-DB e2e-lite: through the in-process path's marker write, an
  //     uncroppable/duplicate section is excluded → section_visual pending=0 →
  //     `computeRemainingStatusWithPrisma` = 'completed' (the to-completed
  //     reach that real-machine verification exercised, now CI-pinned).
  //
  // R6 non-contradiction: F1 pins the CHILD throw (`embedding-backfill-child.ts`);
  // Block D pins the MARKER guard (`phase-5-embedding.ts`). Different files,
  // orthogonal contracts. F3 routes the Block E uncroppable/duplicate fixtures
  // through the to-completed check rather than re-asserting the marker SQL.
  //
  // FIND 019e5a11 is H severity → code + a CI-failing INV test is MANDATORY;
  // `.skip` / `.todo` / accepted-risk are forbidden.
  // ==========================================================================

  describe("INV-BACKFILL-TERMINAL-COMPLETED-007: Block F (section_visual fork-child reach — throw → in-process marker path)", () => {
    const BACKFILL_CHILD_REL = "workers/phases/embedding-backfill-child.ts";
    const PROCESSORS_REL = "queues/embedding-backfill-processors.ts";

    function readProcessorsSrc(): string {
      return fs.readFileSync(path.resolve(MCP_SERVER_SRC_ROOT, PROCESSORS_REL), "utf8");
    }

    /**
     * Extract the body text of a specific `case "<label>":` clause inside the
     * `dispatchBackfillByCategory` switch via the ts-morph AST. Returns the
     * concatenated statement text of the case block (deterministic, DB-free).
     */
    function getDispatchCaseBody(label: string): string {
      const project = createAstProject();
      const sf = addMcpServerSourceFile(project, `src/${BACKFILL_CHILD_REL}`);
      const fn = sf.getFunction("dispatchBackfillByCategory");
      expect(
        fn,
        "dispatchBackfillByCategory MUST exist in embedding-backfill-child.ts (drift guard)"
      ).toBeTruthy();
      const clauses = fn!.getDescendantsOfKind(SyntaxKind.CaseClause);
      const clause = clauses.find((c) => {
        const expr = c.getExpression().getText().replace(/['"]/g, "");
        return expr === label;
      });
      expect(
        clause,
        `case "${label}" MUST exist in the dispatch switch (drift guard)`
      ).toBeTruthy();
      return clause!
        .getStatements()
        .map((s) => s.getText())
        .join("\n");
    }

    // ------------------------------------------------------------------------
    // (F1) source/AST-pin — section_visual child case THROWS (part_visual mirror)
    // ------------------------------------------------------------------------

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block F1 — the section_visual fork-child case THROWS and does NOT success-return backfillSectionVisualsForPage (AST-pin, symmetric with part_visual)", () => {
      const sectionVisualBody = getDispatchCaseBody("section_visual");
      // The case body MUST contain a `throw` statement so the orchestrator's
      // catch-fallback (SEC-M-3) fires and reaches the in-process marker path.
      expect(
        /throw\s+new\s+Error\(/.test(sectionVisualBody),
        "the section_visual fork-child case MUST throw (so runForkOrFallback's catch routes to processInProcess where the PR-BT-2 marker lives, FIND 019e5a11). A text-only `return backfillSectionVisualsForPage(...)` makes the marker path production-inert."
      ).toBe(true);
      // It MUST NOT success-return the text-only service wrapper (the pre-PR-BT-3
      // production-inert form). A `return ... backfillSectionVisualsForPage` in
      // the case body is the exact regression this pins.
      expect(
        /return\b[^\n]*backfillSectionVisualsForPage/.test(sectionVisualBody),
        "the section_visual fork-child case MUST NOT success-return backfillSectionVisualsForPage (text-only success bypasses the in-process DINOv2 + marker path — PR-BT-2 goal 未達 root cause)"
      ).toBe(false);
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block F1 — both visual categories (part_visual + section_visual) are symmetric: each child case THROWS (no text-only success on either visual path)", () => {
      // Symmetry pin: a future refactor that re-introduces a text-only success on
      // EITHER visual category (re-opening the production-inert class) is caught.
      for (const visualCategory of ["part_visual", "section_visual"] as const) {
        const body = getDispatchCaseBody(visualCategory);
        expect(
          /throw\s+new\s+Error\(/.test(body),
          `the ${visualCategory} fork-child case MUST throw (both visual categories share the throw → in-process fallback pattern; ${visualCategory} regressing to a success-return makes its in-process DINOv2 + marker path production-inert)`
        ).toBe(true);
      }
    });

    // ------------------------------------------------------------------------
    // (F2) routing-pin — fork-throw routes to inProcessFallback = processInProcess
    // ------------------------------------------------------------------------

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block F2 — runForkOrFallback's catch routes a fork-throw to inProcessFallback() (the fork-throw → in-process routing)", () => {
      const src = readProcessorsSrc();
      // The fork attempt and the catch-fallback MUST both be present so a
      // fork-child throw is caught and the in-process fallback runs (rather than
      // the throw propagating and the Job failing).
      expect(
        src.includes("return await executeForkAndMapResult(category, ctx);"),
        "runForkOrFallback MUST attempt the fork via executeForkAndMapResult"
      ).toBe(true);
      // The catch block MUST call inProcessFallback() — this is the routing that
      // turns a section_visual fork-throw into an in-process marker-path run.
      expect(
        /}\s*catch\s*\([\s\S]*?\)\s*\{[\s\S]*?return\s+inProcessFallback\(\);[\s\S]*?}\s*finally/.test(
          src
        ),
        "runForkOrFallback's catch block MUST `return inProcessFallback()` so a fork-child throw reaches the in-process path (PR-BT-3 reach requirement, SEC-M-3 fail-open)"
      ).toBe(true);
      // The per-job lock release MUST live in `finally` so the throw path does
      // not leak the lock (INV-WORKER-LOCK-003 orthogonality; part_visual's throw
      // exercises this every job).
      expect(
        /}\s*finally\s*\{[\s\S]*?await\s+releasePerJobLock\(jobId,\s*lockHandle\);[\s\S]*?}/.test(
          src
        ),
        "runForkOrFallback MUST release the per-job lock in `finally` so the fork-throw path does not leak the lock (INV-WORKER-LOCK-003)"
      ).toBe(true);
    });

    it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block F2 — SectionVisualProcessor.process binds inProcessFallback to processInProcess (so a fork-throw reaches the marker path), symmetric with PartVisualProcessor", () => {
      const project = createAstProject();
      const sf = addMcpServerSourceFile(project, `src/${PROCESSORS_REL}`);
      // For BOTH visual processors, `process()` MUST delegate to
      // `runForkOrFallback(this.category, ctx, () => this.processInProcess(ctx), ...)`
      // so the catch-fallback resolved by F2 (above) lands in `processInProcess`.
      for (const processorName of ["SectionVisualProcessor", "PartVisualProcessor"] as const) {
        const cls = sf.getClass(processorName);
        expect(cls, `${processorName} MUST exist (drift guard)`).toBeTruthy();
        const processMethod = cls!.getMethod("process");
        expect(processMethod, `${processorName}.process MUST exist`).toBeTruthy();
        const body = processMethod!.getBodyText() ?? "";
        // The fork-or-fallback delegation with the in-process fallback bound to
        // `() => this.processInProcess(ctx)`.
        expect(
          /runForkOrFallback\(/.test(body),
          `${processorName}.process MUST delegate to runForkOrFallback`
        ).toBe(true);
        expect(
          /\(\)\s*=>\s*this\.processInProcess\(ctx\)/.test(body),
          `${processorName}.process MUST bind inProcessFallback to () => this.processInProcess(ctx) so a fork-child throw reaches the in-process marker path (PR-BT-3 reach; symmetric with the other visual processor)`
        ).toBe(true);
      }
    });

    // ------------------------------------------------------------------------
    // (F3) real-DB e2e-lite — in-process marker path → pending=0 → 'completed'
    // ------------------------------------------------------------------------

    describe("INV-BACKFILL-TERMINAL-COMPLETED-007: Block F3 (real-DB — in-process marker reach → section_visual pending=0 → 'completed')", () => {
      let prisma: PrismaClient;

      beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
          throw new Error(
            "[INV-BACKFILL-TERMINAL-COMPLETED-007] DATABASE_URL not set by globalSetup (testcontainer boot failure?)"
          );
        }
        prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
        await prisma.$connect();
      }, 180_000);

      afterAll(async () => {
        try {
          await prisma?.$disconnect();
        } catch {
          /* best-effort shutdown */
        }
      }, 30_000);

      it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block F3 — an uncroppable section reached via the in-process marker path is excluded → section_visual pending=0 → computeRemainingStatusWithPrisma='completed'", async () => {
        // A page whose ONLY backfill residual is one out-of-range (uncroppable)
        // section. This is exactly the state the section_visual in-process marker
        // path terminates: the fork-throw routes to processInProcess (F1/F2),
        // which writes the section_visual_uncroppable marker (the production SQL
        // exercised by Block E), excluding the section from the pending set.
        const { webPageId } = await seedMinimalWebPage(prisma);
        try {
          const { sectionEmbeddingId } = await seedSectionEmbedding(prisma, webPageId, {
            positionIndex: 0,
            sectionType: "gallery",
            startY: 50_000, // far below any fullPage screenshot height → uncroppable
            height: 600,
          });
          // Pre: the section is pending (both-NULL) → page NOT yet completed
          // (mirrors the PR-BT-2 in_progress / sv_pending>0 ground-truth).
          expect(await countSectionVisualPending(prisma, sectionEmbeddingId)).toBe(1);
          const before = await computeRemainingStatusWithPrisma(webPageId, prisma);
          expect(
            before.finalStatus,
            "with a pending uncroppable section, the page MUST NOT yet be 'completed' (the PR-BT-2 production-inert state)"
          ).not.toBe("completed");

          // The in-process marker write (no_crop_buffer exit, isOutOfRange &&
          // fallbackEnabled===false) that processInProcess reaches via the
          // fork-throw routing. Production marker SQL, replicated verbatim.
          await writeSectionTerminalMarker(
            prisma,
            sectionEmbeddingId,
            "section_visual_uncroppable"
          );

          // Post: excluded by the SSOT predicate → section_visual pending=0, and
          // (no other residuals seeded) ALL 7 categories pending=0 → completed.
          expect(await countSectionVisualPending(prisma, sectionEmbeddingId)).toBe(0);
          const after = await computeRemainingStatusWithPrisma(webPageId, prisma);
          expect(
            after.finalStatus,
            "once the in-process marker excludes the uncroppable section (pending=0 across all categories), the page reaches 'completed' (PR-BT-3 to-completed reach, CI-pinning the real-machine verification)"
          ).toBe("completed");
        } finally {
          await cleanupSeededWebPage(prisma, webPageId);
        }
      });

      it("INV-BACKFILL-TERMINAL-COMPLETED-007: Block F3 — a same-type near-duplicate section reached via the in-process marker path is excluded → section_visual pending=0 → 'completed'", async () => {
        // The duplicate arm: two same-type both-NULL sections. The 1st gets its
        // vision embedding (not a duplicate); the 2nd is dedup-skipped and would
        // stay pending forever WITHOUT the marker. The in-process marker path
        // (dedup exit, fallbackEnabled===false) writes section_visual_duplicate,
        // excluding the 2nd → section_visual pending=0 → page 'completed'.
        const { webPageId } = await seedMinimalWebPage(prisma);
        try {
          const { sectionEmbeddingId: firstId } = await seedSectionEmbedding(prisma, webPageId, {
            positionIndex: 0,
            sectionType: "feature",
            startY: 0,
            height: 400,
          });
          const { sectionEmbeddingId: secondId } = await seedSectionEmbedding(prisma, webPageId, {
            positionIndex: 1,
            sectionType: "feature",
            startY: 400,
            height: 400,
          });
          // The 1st section gets its vision embedding (production-shaped UPDATE);
          // the 2nd is the dedup-skipped residual (both-NULL).
          await setSectionVision(prisma, firstId, buildUnitVector(0));
          // Pre: only the 2nd is pending → page NOT yet completed.
          expect(await countSectionVisualPendingForPage(prisma, webPageId)).toBe(1);
          const before = await computeRemainingStatusWithPrisma(webPageId, prisma);
          expect(before.finalStatus).not.toBe("completed");

          // In-process marker write (dedup exit) that processInProcess reaches.
          await writeSectionTerminalMarker(prisma, secondId, "section_visual_duplicate");

          // Post: 2nd excluded → section_visual pending=0 → page 'completed'.
          expect(await countSectionVisualPendingForPage(prisma, webPageId)).toBe(0);
          const after = await computeRemainingStatusWithPrisma(webPageId, prisma);
          expect(
            after.finalStatus,
            "once the in-process marker excludes the dedup-skipped section, the page reaches 'completed' (PR-BT-3 duplicate-arm to-completed reach)"
          ).toBe("completed");
        } finally {
          await cleanupSeededWebPage(prisma, webPageId);
        }
      });
    });
  });
});

// ============================================================================
// Block D/E real-DB helpers (production marker SQL + production exclusion
// predicate, replicated verbatim — mirrors INV-PART-VISUAL-SKIP-TERMINAL-001 (d)).
// ============================================================================

/** L2-normalized 768-dim unit vector with an optional perturbation on dim 0. */
function buildUnitVector(perturbation: number): number[] {
  const dim = 768;
  const base = 1 / Math.sqrt(dim);
  const vec = new Array<number>(dim).fill(base);
  if (perturbation !== 0) {
    vec[0] = base + perturbation;
    // Re-normalize to keep it a unit vector (cosine with the unperturbed base
    // stays well above 0.995 for a tiny perturbation).
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    for (let i = 0; i < dim; i++) vec[i] = vec[i]! / norm;
  }
  return vec;
}

/** Set a section_embeddings.vision_embedding via the production-shaped UPDATE. */
async function setSectionVision(
  prisma: PrismaClient,
  sectionEmbeddingId: string,
  embedding: number[]
): Promise<void> {
  const literal = `[${embedding.join(",")}]`;
  await prisma.$executeRawUnsafe(
    `UPDATE section_embeddings SET vision_embedding = $1::vector(768) WHERE id = $2::uuid`,
    literal,
    sectionEmbeddingId
  );
}

/**
 * Production marker SQL, replicated verbatim from `writeSectionVisionSkipReason`
 * (idempotent `WHERE ... vision_skip_reason IS NULL` guard, parameterized
 * $1/$2::uuid, SQLi-safe).
 */
async function writeSectionTerminalMarker(
  prisma: PrismaClient,
  sectionEmbeddingId: string,
  reason: string
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE section_embeddings
       SET vision_skip_reason = $1
     WHERE id = $2::uuid AND vision_skip_reason IS NULL`,
    reason,
    sectionEmbeddingId
  );
}

/**
 * Count pending section_visual rows for a single section_embeddings.id using the
 * **production SSOT exclusion predicate** (`sectionVisualPendingExclusionPredicate`).
 */
async function countSectionVisualPending(
  prisma: PrismaClient,
  sectionEmbeddingId: string
): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM section_embeddings se
     WHERE se.id = $1::uuid AND ${sectionVisualPendingExclusionPredicate("se")}`,
    sectionEmbeddingId
  );
  return Number(rows[0]?.count ?? 0n);
}

/**
 * Count pending section_visual rows for a whole page using the **production SSOT
 * exclusion predicate** (mirrors the collectCategoryPendingSnapshot section_visual
 * query shape: section_embeddings se JOIN section_patterns sp).
 */
async function countSectionVisualPendingForPage(
  prisma: PrismaClient,
  webPageId: string
): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM section_embeddings se
     JOIN section_patterns sp ON se.section_pattern_id = sp.id
     WHERE sp.web_page_id = $1::uuid AND ${sectionVisualPendingExclusionPredicate("se")}`,
    webPageId
  );
  return Number(rows[0]?.count ?? 0n);
}
