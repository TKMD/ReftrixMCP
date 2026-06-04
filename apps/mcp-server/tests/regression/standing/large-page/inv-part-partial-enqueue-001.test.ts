// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-PART-PARTIAL-ENQUEUE-001 (PR-PART30CAP / ADR-0007 Amendment 2)
 *
 * **Root cause (事実ベース, run3 CPU 検証)**: on a parts≤100 page, the inline
 * Phase 5 chunked text loop hits a C1 per-chunk RSS budget break and stops after
 * chunk 0 (= `EMBEDDING_CHUNK_SIZE` = 30 parts), leaving residual un-embedded
 * parts in the DB. The old enqueue trigger gated part_text/part_visual on
 * `partsSavedCount > PART_SYNC_THRESHOLD` (= 100), so a parts≤100 page NEVER
 * enqueued its residual parts. Meanwhile the parity gate
 * (`verifyCategoryParity`) requires part_text pending (= all un-embedded parts)
 * to reach 0, so the page could never become `completed` → permanent
 * `in_progress` stuck (run3: wikipedia 30/81, gnu 30/61, httpbin 30/56,
 * rfc-editor 30/56, w3.org 30/94).
 *
 * **Fix (ADR-0007 Amendment 2 dual-trigger)**: `resolveBackfillDispatchCategories`
 * enqueues part_text/part_visual when EITHER the inline-cap threshold is exceeded
 * OR the inline partial-completion left residual un-embedded parts
 * (`hasPendingParts=true`). `hasPendingParts` is derived at the call site
 * (`dispatchBackfillJobsForPage`) from a single `collectCategoryPendingSnapshot`
 * call; NO DB/Prisma argument is injected into the resolver, preserving its
 * pure-function unit-pin (INV-007 Block A).
 *
 * This standing test pins, as a CI-failing invariant:
 *
 *   - **(A) RSS-independent resolver dual-trigger (deterministic, no real RSS)**:
 *     for parts>30 / 31-100 / parts>100 boundary cases, a residual
 *     (`hasPendingParts=true`) enqueues part_text/part_visual even below the
 *     threshold; a fully-inline page (`hasPendingParts=false`) does not. Pure
 *     function — no DB, no RSS dependency (TDA-M-01: no flaky `rssMb()` trigger).
 *   - **(B) parts≤100 end-to-end completeness (real DB)**: an 81-part page with
 *     30 inline-embedded + 51 residual reports `hasPendingParts=true` from the
 *     1-call snapshot → the residual is drained → `componentPart.count({embedding:
 *     null})=0` and `computeRemainingStatusWithPrisma` reaches `completed`. The
 *     parity gate becomes satisfiable (INV-EMBEDDING-INTEGRITY-003 integ(= integral)).
 *   - **(C) recovery-failure orthogonality (SEC-L-01, memorySkips>0)**: when the
 *     residual is NOT drained (simulating a CPU memory break leaving
 *     memorySkips>0), the page MUST stay non-terminal (`in_progress`) — it MUST
 *     NOT be prematurely `completed`. Completeness invariant holds even under
 *     recovery failure (the page remains in the retry bucket, not silently done).
 *
 * **RSS-independent determinism (TDA-M-01)**: partial-completion is reproduced by
 * DB-state injection (`seedPartialCompletionPage`: only 30 of 81 parts get an
 * embedding row), NOT by triggering a real `rssMb()` budget break. No
 * physical-memory dependency → no flaky behaviour (testing-requirements.md §5).
 *
 * `.skip` / `.todo` / accepted-risk are forbidden (the underlying bug is H
 *
 * @see Plan v1 §3 (Option A dual-trigger) / §4 (INV design)
 * @see ADR-0007 Amendment 2 (clause-level supersede of the 100-item threshold)
 * @see ADR-0018 (parity gate INV-EMBEDDING-INTEGRITY-003)
 * @see IO Plan Decision V1 internal `019e7201-471c`
 *
 * @module tests/regression/standing/large-page/inv-part-partial-enqueue-001
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { assertInvName } from "../_setup/inv-assert";
import {
  collectCategoryPendingSnapshot,
  computeRemainingStatusWithPrisma,
  verifyCategoryParity,
} from "../../../../src/services/backfill-status.helper";
// PR-PART30CAP: the dispatch resolver is a test-only export from the worker.
// Block A pins its dual-trigger (hasPendingParts) branches as a pure function.
import { resolveBackfillDispatchCategories } from "../../../../src/workers/page-analyze-worker";
import {
  cleanupSeededWebPage,
  resolvePartTextResidual,
  seedPartialCompletionPage,
} from "./_fixtures/seed-large-page";

/**
 * `EMBEDDING_CHUNK_SIZE` (= 30) reproduced as the inline-embedded head count.
 * On a parts≤100 page, the C1 RSS budget break stops inline embedding after
 * chunk 0 (= 30 parts), the exact run3 stuck head count.
 */
const INLINE_EMBEDDED_HEAD = 30 as const;

describe("INV-PART-PARTIAL-ENQUEUE-001: parts≤100 partial-completion residual enqueue (PR-PART30CAP)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PART-PARTIAL-ENQUEUE-001");
  });

  // ==========================================================================
  // Block A — RSS-independent resolver dual-trigger (pure function, no DB/RSS).
  // ==========================================================================

  describe("INV-PART-PARTIAL-ENQUEUE-001: Block A (RSS-independent resolver dual-trigger, deterministic)", () => {
    // The boundary cases the dual-trigger must cover (Plan v1 §4.3): parts>30,
    // parts 31-100 (the masked gap), and parts>100. For each, a residual
    // (hasPendingParts=true) MUST enqueue parts; no residual MUST NOT (below
    // threshold) yet the threshold arm MUST still fire independently above 100.
    const BOUNDARY_PART_COUNTS = [31, 56, 81, 94, 100, 101, 250] as const;

    it("INV-PART-PARTIAL-ENQUEUE-001: Block A — residual (hasPendingParts=true) enqueues part_text/part_visual at every boundary part count (RSS-independent, pure)", () => {
      for (const partsSavedCount of BOUNDARY_PART_COUNTS) {
        const dispatched = resolveBackfillDispatchCategories({
          partsSavedCount,
          sectionsSavedCount: 0,
          hasScreenshot: true,
          hasPendingParts: true,
        });
        expect(
          dispatched.includes("part_text"),
          `partsSavedCount=${partsSavedCount} with residual MUST enqueue part_text (dual-trigger residual arm closes the parts≤100 gap)`
        ).toBe(true);
        expect(
          dispatched.includes("part_visual"),
          `partsSavedCount=${partsSavedCount} with residual + screenshot MUST enqueue part_visual`
        ).toBe(true);
      }
    });

    it("INV-PART-PARTIAL-ENQUEUE-001: Block A — no residual (hasPendingParts=false) enqueues parts ONLY above the threshold (threshold-only arm preserved)", () => {
      for (const partsSavedCount of BOUNDARY_PART_COUNTS) {
        const dispatched = resolveBackfillDispatchCategories({
          partsSavedCount,
          sectionsSavedCount: 0,
          hasScreenshot: true,
          hasPendingParts: false,
        });
        // parts>100 → threshold arm fires; parts≤100 → no part enqueue.
        const expectEnqueue = partsSavedCount > 100;
        expect(
          dispatched.includes("part_text"),
          `partsSavedCount=${partsSavedCount} without residual: part_text enqueue MUST be ${String(expectEnqueue)} (threshold-only arm)`
        ).toBe(expectEnqueue);
      }
    });

    it("INV-PART-PARTIAL-ENQUEUE-001: Block A — part_visual still requires a screenshot under the residual arm (gate preserved, no screenshot → no part_visual)", () => {
      const dispatched = resolveBackfillDispatchCategories({
        partsSavedCount: 81,
        sectionsSavedCount: 0,
        hasScreenshot: false,
        hasPendingParts: true,
      });
      expect(
        dispatched.includes("part_text"),
        "part_text is screenshot-free and MUST enqueue under the residual arm"
      ).toBe(true);
      expect(
        dispatched.includes("part_visual"),
        "part_visual MUST NOT enqueue without a screenshot even under the residual arm (screenshot requirement preserved)"
      ).toBe(false);
    });
  });

  // ==========================================================================
  // Block B/C — live DB end-to-end completeness + recovery-failure orthogonality.
  // ==========================================================================

  describe("INV-PART-PARTIAL-ENQUEUE-001: Block B/C (real DB — parts≤100 residual drains to completed; recovery-failure stays non-terminal)", () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error(
          "[INV-PART-PARTIAL-ENQUEUE-001] DATABASE_URL not set by globalSetup (testcontainer boot failure?)"
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

    it("INV-PART-PARTIAL-ENQUEUE-001: Block B — 81-part page (30 inline + 51 residual) reports hasPendingParts=true via the 1-call snapshot, then drains to completed (parity satisfiable)", async () => {
      const seed = await seedPartialCompletionPage(prisma, {
        partCount: 81,
        inlineEmbeddedCount: INLINE_EMBEDDED_HEAD,
      });
      try {
        // 1. The 1-call pending snapshot (the exact helper dispatch reuses)
        //    reports part_text pending = 51 → hasPendingParts=true. This is the
        //    bool the resolver receives to fire the dual-trigger residual arm.
        const beforeSnapshot = await collectCategoryPendingSnapshot(seed.webPageId, prisma);
        expect(
          beforeSnapshot.part_text,
          "81-part page with 30 inline-embedded MUST report 51 residual part_text pending (the run3 stuck state)"
        ).toBe(seed.pendingCount);
        const hasPendingParts = beforeSnapshot.part_text > 0 || beforeSnapshot.part_visual > 0;
        expect(
          hasPendingParts,
          "the derived hasPendingParts bool MUST be true so dispatch enqueues part_text (parts=81 ≤ 100)"
        ).toBe(true);

        // 2. The resolver fires the residual arm with this bool (parts≤100, no
        //    threshold) — proving the enqueue path is taken.
        const dispatched = resolveBackfillDispatchCategories({
          partsSavedCount: seed.partCount,
          sectionsSavedCount: 0,
          hasScreenshot: false,
          hasPendingParts,
        });
        expect(dispatched).toContain("part_text");

        // 3. Pre: parity NOT satisfiable (part_text pending > 0) → page cannot be
        //    completed. This is the permanent in_progress stuck condition.
        expect(verifyCategoryParity(beforeSnapshot).ok).toBe(false);
        const before = await computeRemainingStatusWithPrisma(seed.webPageId, prisma);
        expect(
          before.finalStatus,
          "with residual part_text pending, the page MUST NOT yet be 'completed' (the run3 stuck state)"
        ).not.toBe("completed");

        // 4. Drain the residual (the now-enqueued part_text backfill completing).
        //    no-fake-success: the actual fix path (embedding rows inserted), not a
        //    status overwrite.
        const drained = await resolvePartTextResidual(prisma, seed.webPageId);
        expect(drained, "exactly the residual parts (51) must be embedded by the drain").toBe(
          seed.pendingCount
        );

        // 5. Post: componentPart.count({embedding:null})=0 (end-to-end
        //    completeness) AND parity satisfiable → completed.
        const remainingNull = await prisma.componentPart.count({
          where: {
            webPageId: seed.webPageId,
            piiRiskLevel: { not: "high" },
            embedding: { is: null },
          },
        });
        expect(
          remainingNull,
          "after draining the residual, no part may remain un-embedded (completeness contract)"
        ).toBe(0);

        const afterSnapshot = await collectCategoryPendingSnapshot(seed.webPageId, prisma);
        expect(afterSnapshot.part_text).toBe(0);
        expect(verifyCategoryParity(afterSnapshot).ok).toBe(true);

        const { finalStatus } = await computeRemainingStatusWithPrisma(seed.webPageId, prisma);
        expect(
          finalStatus,
          "once the residual is drained (all 7 categories pending=0) the page MUST reach 'completed' (parity gate satisfiable, INV-EMBEDDING-INTEGRITY-003)"
        ).toBe("completed");
      } finally {
        await cleanupSeededWebPage(prisma, seed.webPageId);
      }
    });

    it("INV-PART-PARTIAL-ENQUEUE-001: Block C — recovery-failure (residual NOT drained, memorySkips>0 analog) keeps the page non-terminal — NOT prematurely completed (SEC-L-01)", async () => {
      // SEC-L-01 (CWE-20 defensive completeness): if the backfill memory-breaks on
      // the CPU path (memorySkips>0) and does NOT drain the residual, the page MUST
      // remain in the retry bucket (non-terminal in_progress) — it MUST NOT be
      // silently 'completed' with un-embedded parts. This proves the completeness
      // invariant holds even under recovery failure.
      const seed = await seedPartialCompletionPage(prisma, {
        partCount: 56,
        inlineEmbeddedCount: INLINE_EMBEDDED_HEAD,
      });
      try {
        // Residual present, NOT drained (simulating the memory-break recovery
        // failure where memorySkips>0 leaves part_text pending).
        const snapshot = await collectCategoryPendingSnapshot(seed.webPageId, prisma);
        expect(snapshot.part_text).toBe(seed.pendingCount);
        expect(verifyCategoryParity(snapshot).ok).toBe(false);

        const { finalStatus } = await computeRemainingStatusWithPrisma(seed.webPageId, prisma);
        expect(
          finalStatus,
          "a page with an un-drained part_text residual (recovery failure) MUST remain non-terminal (in_progress) — not silently completed"
        ).toBe("in_progress");

        // Orthogonality: the DB row still has un-embedded parts (the real leak is
        // preserved, not papered over).
        const remainingNull = await prisma.componentPart.count({
          where: {
            webPageId: seed.webPageId,
            piiRiskLevel: { not: "high" },
            embedding: { is: null },
          },
        });
        expect(remainingNull).toBe(seed.pendingCount);
      } finally {
        await cleanupSeededWebPage(prisma, seed.webPageId);
      }
    });
  });
});
