// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-BACKFILL-RECONCILE-METADATA-010 (defect B — backfill terminal failure
 * metadata + recovery-window correctness)
 *
 * **Root cause (defect B、10-site CPU 完走検証で発見、事実ベース)**: terminal
 * failure へ遷移する複数経路が、`web_pages.embeddingBackfillStatus = 'failed'`
 * (plain) のみを書き込み、`embedding_backfill_failure_reason` /
 * `embedding_backfill_failed_at` を NULL のまま残していた。観測された 2 経路:
 *
 *   - 経路1 (reconciliation Section A, `reconcileInProgressRows`): stale
 *     `in_progress` 行で残余ありの場合 plain `failed` に pin していた。
 *   - 経路2 (worker `finalizeBackfillJob` failure path): job 例外時 plain
 *     `failed` に遷移していた。
 *
 * これにより 2 つの correctness/observability 不整合が発生:
 *
 *   (1) **failure metadata NULL 不整合**: `failed` 状態なのに `failure_reason` /
 *       `failed_at` が NULL → 「失敗したが理由不明」(GDPR Art.30 audit trail 欠落)。
 *   (2) **recovery 自動復帰 bypass**: `BackfillRecoveryReconciliationService`
 *       (`runRecoveryCycle` → `fetchFailedWithKnownReasonRows`) は
 *       `failed_with_known_reason` 状態のみ scan する。plain `failed` 行は scan
 *       window 外なので、後から別カテゴリ (e.g. motion の DI 修正後) の backfill
 *       が完走して DB が完全になっても **永久に terminal `failed` に貼り付き、
 *       自動復帰しない**。
 *
 * **Fix**: 両経路を `failed_with_known_reason` + `failure_reason` (SSOT enum) +
 * `failed_at` に統一する。reconciliation は `supervisor_restart_orphan`
 * (auto_recoverable: stale in_progress = orphan)、worker job 例外は
 * `stall_timeout` (auto_recoverable: transient 処理失敗) を採用。これにより行は
 * recovery service の scan window に乗り、DB 完全時に re_enqueue → 全 7 カテゴリ
 * 再投入 → terminal `completed` 到達、という既存 Plan v3 T3-Backfill recovery
 * 経路に正しく乗る。PR-BT (terminal 分類) の延長で、`failed_with_known_reason` +
 * recovery の既存仕組みを再利用する (新しい terminal state を作らない)。
 *
 * This standing test pins, as CI-failing invariants:
 *
 *   - **(A) reconciliation: stale in_progress (残余あり) → failed_with_known_reason
 *     + non-NULL reason + non-NULL failed_at** (NOT plain `failed`). The exact
 *     defect B observable (`failure_reason=null` / `failed_at=null` on a `failed`
 *     row) is converted to a CI failure. Exercised against real Prisma DB.
 *   - **(B) reconciliation: completed-eligible page (全 7 category pending=0) is
 *     NOT mis-pinned to failed** — it transitions to `completed` with failure
 *     metadata cleared (no stale reason/failed_at left behind). Preserves the
 *     INV-BACKFILL-TERMINAL-COMPLETED-007 Block C contract.
 *   - **(C) recovery-window membership**: a `failed_with_known_reason` row is
 *     scanned by `fetchFailedWithKnownReasonRows` (the recovery service entry),
 *     whereas a plain `failed` row is NOT — proving the fix routes the row into
 *     the auto-recovery path. Exercised against real Prisma DB.
 *   - **(D) AST/source-pin (no-fake-success regression guard)**: neither
 *     `reconcileInProgressRows` nor the worker `finalizeBackfillJob` failure path
 *     writes a bare `embeddingBackfillStatus: "failed"` terminal transition for
 *     the remaining/exception case. The plain-`failed` literal on those two
 *     transitions is the defect; its reintroduction is a CI failure.
 *
 * `.skip` / `.todo` / accepted-risk are forbidden (defect B is a correctness +
 * CI-failing test).
 *
 * @see INV-BACKFILL-TERMINAL-COMPLETED-007 (PR-BT 系統A — the terminal-completed
 *      side this invariant extends)
 * @see backfill-reconciliation.service.ts (`reconcileInProgressRows`)
 * @see embedding-backfill-worker.ts (`markBackfillFailedWithKnownReason`,
 *      `finalizeBackfillJob`)
 * @see backfill-recovery-reconciliation.service.ts (`runRecoveryCycle`,
 *      `fetchFailedWithKnownReasonRows`) — the recovery scan window
 * @see ADR-0007 (Phase 5 Queue-based Backfill) / Plan v3 T3-Backfill
 *      (failed_with_known_reason + recovery)
 *
 * @module tests/regression/standing/large-page/inv-backfill-reconcile-metadata-010
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import fs from "node:fs";
import path from "node:path";
import { SyntaxKind } from "ts-morph";
import { assertInvName } from "../_setup/inv-assert";
import { createAstProject, addMcpServerSourceFile } from "../schema-enum-sync/_extractors";
import { reconcileStaleBackfillJobs } from "../../../../src/services/backfill-reconciliation.service";
import { runRecoveryCycle } from "../../../../src/services/backfill-recovery-reconciliation.service";
import {
  EMBEDDING_BACKFILL_FAILURE_REASONS,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
} from "../../../../src/queues/embedding-backfill-queue";
import { seedMinimalWebPage, cleanupSeededWebPage } from "./_fixtures/seed-large-page";

const INV_NAME = "INV-BACKFILL-RECONCILE-METADATA-010";

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");

type MockedQueue = Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;

/**
 * Empty queue mock: `hasActiveQueueJob` calls `queue.getJob(jobId)` for each of
 * the 7 categories and treats `null` as "no active job" (stale eligible). The
 * reconciliation back-pressure / skip-recovery enqueue path is not exercised by
 * the in_progress Section A (no skipped_* rows seeded), so a minimal getJob → null
 * mock is sufficient. `getWaitingCount` is provided defensively for the
 * skipped_* Section B back-pressure check (never reached here).
 */
function buildEmptyQueueMock(): MockedQueue {
  return {
    getJob: vi.fn(async () => null),
    getWaitingCount: vi.fn(async () => 0),
  } as unknown as MockedQueue;
}

/**
 * Force a seeded page into the stale `in_progress` state with a startedAt far
 * enough in the past to satisfy the reconciliation `staleThresholdMs` gate.
 */
async function markStaleInProgress(
  prisma: PrismaClient,
  webPageId: string,
  startedAtAgoMs: number
): Promise<void> {
  await prisma.webPage.update({
    where: { id: webPageId },
    data: {
      embeddingBackfillStatus: "in_progress",
      embeddingBackfillStartedAt: new Date(Date.now() - startedAtAgoMs),
    },
  });
}

async function readBackfillState(
  prisma: PrismaClient,
  webPageId: string
): Promise<{
  status: string;
  failureReason: string | null;
  failedAt: Date | null;
}> {
  const row = await prisma.webPage.findUniqueOrThrow({
    where: { id: webPageId },
    select: {
      embeddingBackfillStatus: true,
      embeddingBackfillFailureReason: true,
      embeddingBackfillFailedAt: true,
    },
  });
  return {
    status: row.embeddingBackfillStatus,
    failureReason: row.embeddingBackfillFailureReason,
    failedAt: row.embeddingBackfillFailedAt,
  };
}

// staleThresholdMs default is 1h; seed startedAt 2h in the past to be eligible.
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

describe(`${INV_NAME}: backfill terminal failure metadata + recovery-window correctness (defect B)`, () => {
  // ==========================================================================
  // Blocks A/B/C — real Prisma DB against the live testcontainer.
  // ==========================================================================
  describe(`${INV_NAME}: reconciliation + recovery-window (real DB)`, () => {
    let prisma: PrismaClient;

    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", INV_NAME);
    });

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error(
          `[${INV_NAME}] DATABASE_URL not set by globalSetup (testcontainer boot failure?)`
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

    it(`${INV_NAME}: (A) stale in_progress with remaining work → failed_with_known_reason + non-NULL reason + non-NULL failed_at (NOT plain failed)`, async () => {
      // A minimal page with NO embeddings of any category but with a residual:
      // seedMinimalWebPage has zero parts/sections/motion → all 7 categories
      // pending=0, so we need a residual to force "remaining". Insert one motion
      // pattern WITHOUT an embedding so `collectCategoryPendingSnapshot` returns
      // motion pending=1 → remainingStatus = "in_progress" → reconciliation must
      // pin failed_with_known_reason (NOT completed, NOT plain failed).
      const { webPageId } = await seedMinimalWebPage(prisma);
      try {
        await prisma.motionPattern.create({
          data: {
            id: crypto.randomUUID(),
            webPageId,
            name: "fixture-motion-residual",
            type: "css_animation",
            category: "entrance",
            triggerType: "scroll",
            triggerConfig: {},
            animation: { duration: 600, delay: 0 },
            properties: [],
            implementation: { css: "" },
            accessibility: {},
          },
        });
        await markStaleInProgress(prisma, webPageId, TWO_HOURS_MS);

        const result = await reconcileStaleBackfillJobs({
          prisma,
          queue: buildEmptyQueueMock(),
        });
        expect(result.remediated).toBeGreaterThanOrEqual(1);

        const state = await readBackfillState(prisma, webPageId);
        // defect B core: the row MUST NOT be plain `failed` with NULL metadata.
        expect(
          state.status,
          "stale in_progress with remaining work MUST transition to failed_with_known_reason (NOT plain failed)"
        ).toBe("failed_with_known_reason");
        expect(
          state.failureReason,
          "defect B: failure_reason MUST be non-NULL on a terminal failure transition (observability + recovery-window membership)"
        ).not.toBeNull();
        expect(
          (EMBEDDING_BACKFILL_FAILURE_REASONS as readonly string[]).includes(
            state.failureReason ?? ""
          ),
          "failure_reason MUST be a member of the EMBEDDING_BACKFILL_FAILURE_REASONS SSOT enum"
        ).toBe(true);
        expect(
          state.failedAt,
          "defect B: failed_at MUST be non-NULL on a terminal failure transition"
        ).not.toBeNull();
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    }, 60_000);

    it(`${INV_NAME}: (B) completed-eligible stale in_progress (all categories pending=0) → completed with failure metadata cleared (NOT mis-pinned failed)`, async () => {
      // No parts, no sections, no motion → all 7 categories pending=0 →
      // remainingStatus = "completed". The reconciliation MUST pin `completed`
      // (preserving INV-007 Block C) and clear any failure metadata.
      const { webPageId } = await seedMinimalWebPage(prisma);
      try {
        await markStaleInProgress(prisma, webPageId, TWO_HOURS_MS);
        // Pre-set stale failure metadata to prove it is cleared on the completed path.
        await prisma.webPage.update({
          where: { id: webPageId },
          data: {
            embeddingBackfillFailureReason: "stall_timeout",
            embeddingBackfillFailedAt: new Date(),
          },
        });

        const result = await reconcileStaleBackfillJobs({
          prisma,
          queue: buildEmptyQueueMock(),
        });
        expect(result.remediated).toBeGreaterThanOrEqual(1);

        const state = await readBackfillState(prisma, webPageId);
        expect(
          state.status,
          "completed-eligible stale in_progress MUST NOT be mis-pinned to failed (INV-007 Block C)"
        ).toBe("completed");
        expect(
          state.failureReason,
          "on the completed path, stale failure_reason MUST be cleared to NULL"
        ).toBeNull();
        expect(
          state.failedAt,
          "on the completed path, stale failed_at MUST be cleared to NULL"
        ).toBeNull();
      } finally {
        await cleanupSeededWebPage(prisma, webPageId);
      }
    }, 60_000);

    it(`${INV_NAME}: (C) recovery-window membership — failed_with_known_reason is scanned by the recovery service; plain failed is NOT`, async () => {
      // Seed two pages: one failed_with_known_reason (in window), one plain failed
      // (out of window). runRecoveryCycle scans only failed_with_known_reason.
      const inWindow = await seedMinimalWebPage(prisma);
      const outOfWindow = await seedMinimalWebPage(prisma);
      try {
        await prisma.webPage.update({
          where: { id: inWindow.webPageId },
          data: {
            embeddingBackfillStatus: "failed_with_known_reason",
            embeddingBackfillFailureReason: "supervisor_restart_orphan",
            embeddingBackfillFailedAt: new Date(),
            // Retry count below cap so it is recovery-attempted (not terminal-pinned).
            embeddingBackfillRetryCount: 0,
          },
        });
        await prisma.webPage.update({
          where: { id: outOfWindow.webPageId },
          data: {
            embeddingBackfillStatus: "failed",
            embeddingBackfillFailureReason: null,
            embeddingBackfillFailedAt: null,
          },
        });

        const result = await runRecoveryCycle({
          prisma,
          queue: buildEmptyQueueMock(),
          // Inject a verifyVisionUnloadFn so vision_residual is deterministic; here
          // the seeded reason is supervisor_restart_orphan (lifecycle-origin) which
          // re-enqueues directly without a vision probe.
          verifyVisionUnloadFn: async () => ({ status: "vision_unloaded", sizeVramBytes: 0 }),
        });

        // The failed_with_known_reason row is scanned (totalChecked counts it).
        expect(
          result.totalChecked,
          "a failed_with_known_reason row MUST be scanned by the recovery service (recovery-window membership)"
        ).toBeGreaterThanOrEqual(1);

        // The in-window row transitioned out of failed_with_known_reason (re_enqueued
        // → queued) — proving auto-recovery routing. The plain failed row is
        // untouched (out of window).
        const inState = await readBackfillState(prisma, inWindow.webPageId);
        expect(
          inState.status,
          "the in-window row MUST leave failed_with_known_reason via auto-recovery (re_enqueued → queued)"
        ).not.toBe("failed_with_known_reason");

        const outState = await readBackfillState(prisma, outOfWindow.webPageId);
        expect(
          outState.status,
          "a plain failed row MUST remain untouched by the recovery service (NOT in the scan window) — this is the bug the fix routes around"
        ).toBe("failed");
      } finally {
        await cleanupSeededWebPage(prisma, inWindow.webPageId);
        await cleanupSeededWebPage(prisma, outOfWindow.webPageId);
      }
    }, 60_000);
  });

  // ==========================================================================
  // Block D — AST/source-pin (no-fake-success regression guard). No DB needed.
  // ==========================================================================
  describe(`${INV_NAME}: AST source-pin (no plain-failed terminal transition reintroduced)`, () => {
    beforeEach(() => {
      assertInvName(expect.getState().currentTestName ?? "", INV_NAME);
    });

    it(`${INV_NAME}: (D1) reconcileInProgressRows transitions remaining → failed_with_known_reason (NOT bare embeddingBackfillStatus: "failed")`, () => {
      const src = fs.readFileSync(
        path.resolve(MCP_SERVER_SRC_ROOT, "services/backfill-reconciliation.service.ts"),
        "utf8"
      );
      // The fix introduces this literal; its absence means the plain-failed
      // regression returned for the in_progress remaining path.
      expect(
        src.includes('"failed_with_known_reason"'),
        "reconcileInProgressRows MUST transition remaining stale in_progress rows to failed_with_known_reason (defect B fix)"
      ).toBe(true);
      expect(
        src.includes('embeddingBackfillFailureReason: "supervisor_restart_orphan"'),
        "reconcileInProgressRows MUST set failure_reason = supervisor_restart_orphan on the remaining path"
      ).toBe(true);
      // The remaining-path transition MUST NOT be the bare plain-failed status.
      // (newStatus union no longer contains the "failed" literal for the
      // in_progress remaining branch.)
      expect(
        src.includes('"completed" | "failed_with_known_reason"'),
        "the in_progress newStatus union MUST be completed | failed_with_known_reason (no plain failed)"
      ).toBe(true);
    });

    it(`${INV_NAME}: (D2) worker finalizeBackfillJob failure path uses markBackfillFailedWithKnownReason (NOT a real updateEmbeddingBackfillStatus("failed") call)`, () => {
      // AST-based (NOT substring) so the defect's root-cause description in a
      // JSDoc comment is not falsely flagged — only real CallExpressions count.
      const project = createAstProject();
      const sf = addMcpServerSourceFile(project, "src/workers/embedding-backfill-worker.ts");

      const finalize = sf
        .getDescendantsOfKind(SyntaxKind.FunctionDeclaration)
        .find((fn) => fn.getName() === "finalizeBackfillJob");
      expect(finalize, "finalizeBackfillJob function declaration MUST exist").toBeTruthy();

      const calls = finalize!.getDescendantsOfKind(SyntaxKind.CallExpression);
      const callText = calls.map((c) => c.getExpression().getText());

      // The fix routes the failure path through the metadata-setting helper.
      expect(
        callText.some((t) => t === "markBackfillFailedWithKnownReason"),
        "finalizeBackfillJob failure path MUST call markBackfillFailedWithKnownReason (defect B fix)"
      ).toBe(true);

      // The pre-fix plain-failed transition MUST NOT be a real call inside
      // finalizeBackfillJob: assert no `updateEmbeddingBackfillStatus(..., "failed")`
      // CallExpression survives (a comment mentioning it is fine — AST ignores it).
      const plainFailedCall = calls.find((c) => {
        if (c.getExpression().getText() !== "updateEmbeddingBackfillStatus") return false;
        const args = c.getArguments();
        return args.some(
          (a) => a.getKind() === SyntaxKind.StringLiteral && a.getText() === '"failed"'
        );
      });
      expect(
        plainFailedCall,
        'finalizeBackfillJob MUST NOT call updateEmbeddingBackfillStatus(webPageId, "failed") (defect B plain-failed transition)'
      ).toBeUndefined();

      // The helper itself MUST be defined (metadata-setting contract).
      const helper = sf
        .getDescendantsOfKind(SyntaxKind.FunctionDeclaration)
        .find((fn) => fn.getName() === "markBackfillFailedWithKnownReason");
      expect(
        helper,
        "the worker MUST define markBackfillFailedWithKnownReason to fill failure metadata"
      ).toBeTruthy();
    });
  });
});
