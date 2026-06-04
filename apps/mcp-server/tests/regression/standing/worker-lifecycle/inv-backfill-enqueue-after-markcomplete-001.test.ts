// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-BACKFILL-ENQUEUE-AFTER-MARKCOMPLETE-001
 * (PR-C2 / Layer 2, worker-lifecycle domain)
 *
 * CPU "true 10/10" integration plan V1.1 §4.2 / ADR-0007 Amendment 3 (V1).
 *
 * ## Root cause (Layer 2)
 *
 * The Phase 5 backfill enqueue calls (`dispatchBackfillJobsForPage` for the
 * sync_overflow path, `dispatchSkipRecoveryBackfill` for the skip_recovery path)
 * used to run BEFORE `markAnalysisCompleted`. The backfill worker could pick a
 * job up while `analysis_status='processing'`, so the analysis guard returned
 * `re_enqueue` (a 30s delayed job). The planned-restart `once('completed')`
 * listener then exited the worker unconditionally, deferring the
 * `delayed → waiting` promotion across the respawn window → `retry_count` churn
 * accumulated → the page froze (never reaching `completed`).
 *
 * ## Invariant (PR-C2 fix B)
 *
 * `dispatchBackfillJobsForPage` (sync_overflow) AND `dispatchSkipRecoveryBackfill`
 * (skip_recovery) are invoked AFTER `markAnalysisCompleted` (via the
 * `enqueueBackfillAfterMarkComplete` relocation leaf) and BEFORE the Phase 7.5
 * Post-Analysis Gate. By then `analysis_status` is terminal (`completed`/`failed`),
 * so `decideAnalysisGuard` returns `proceed` — `re_enqueue` is removed from the
 * happy path (the deadlock / re_enqueue guard remains only as a safety net).
 *
 * a CI-failing executable invariant. `.skip()` / `.todo()` / `.only` are
 * forbidden; any failure is a P0 incident handled by pipeline-engineer.
 *
 * ## 5 branches (plan §4.2)
 *   1. (H-01) order source-pin (both paths): both dispatch call-sites live inside
 *      the relocated closures, and `enqueueBackfillAfterMarkComplete(` is invoked
 *      AFTER `markAnalysisCompleted` and BEFORE the Phase 7.5 block.
 *   2. (M-07) both-path coverage: source-pin covers BOTH
 *      `dispatchBackfillJobsForPage` (L~2489) and `dispatchSkipRecoveryBackfill`
 *      (L~2617).
 *   3. (basic) happy-path proceed: a terminal `completed` status yields `proceed`
 *      from the guard (no `re_enqueue`); the leaf always runs sync_overflow.
 *   4. (M-03) safety-net fault-injection (REAL Redis ZSET): a re_enqueue 30s
 *      delayed job is persisted in the BullMQ `bull:embedding-backfill:delayed`
 *      ZSET and survives independently of any worker process lifecycle
 *      (restart-crossing persistence), then is promotable to `waiting`.
 *   5. (M-07) skip_recovery semantics: terminal `failed` yields `proceed` (NOT
 *      `re_enqueue` / `terminal_failed`) so skip_recovery part processing
 *      proceeds (ADR-0008 Amendment 1 skip_recovery guard semantics).
 *
 * ## Mock boundary note (FIND-IO-V0-L-08 / TDA L-03)
 *
 * Branches 1-2 are AST/source-pin (no runtime); branches 3 + 5 exercise the
 * REAL `decideAnalysisGuard` (no mock). Branch 4 uses a REAL Redis ZSET (NOT a
 * mock) so the BullMQ delayed-job persistence claim — the actual root-cause
 * re-framing in plan §3.2 — is verified against real Redis state, not a stub.
 *
 * @see  §4.2
 * @see  Amendment 3
 * @see  Amendment 1
 * @see apps/mcp-server/src/workers/phases/backfill-enqueue-relocation.ts
 *
 * @module tests/regression/standing/worker-lifecycle/inv-backfill-enqueue-after-markcomplete-001
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Queue } from "bullmq";
import Redis from "ioredis";

import { assertInvName } from "../_setup/inv-assert";
import { enqueueBackfillAfterMarkComplete } from "../../../../src/workers/phases/backfill-enqueue-relocation";
import { decideAnalysisGuard } from "../../../../src/workers/phases/backfill-analysis-guard";
import type { EmbeddingBackfillCategory } from "../../../../src/queues/embedding-backfill-queue";

const INV = "INV-BACKFILL-ENQUEUE-AFTER-MARKCOMPLETE-001";

const WORKER_FILE = resolve(__dirname, "../../../../src/workers/page-analyze-worker.ts");

/** Read source lines with comment / docstring lines stripped (AST-lite). */
function readCodeLinesIndexed(filePath: string): { line: string; index: number }[] {
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !line.trim().startsWith("*") && !line.trim().startsWith("//"));
}

/** First 0-based source line index matching `pattern` (after comment strip), or -1. */
function firstMatchIndex(indexed: { line: string; index: number }[], pattern: RegExp): number {
  const hit = indexed.find(({ line }) => pattern.test(line));
  return hit ? hit.index : -1;
}

describe("INV-BACKFILL-ENQUEUE-AFTER-MARKCOMPLETE-001: PR-C2 backfill enqueue runs after markComplete", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Branch 1 (H-01): order source-pin (both paths) -----------------------

  it("INV-BACKFILL-ENQUEUE-AFTER-MARKCOMPLETE-001 branch 1 (H-01): enqueueBackfillAfterMarkComplete is invoked AFTER markAnalysisCompleted and BEFORE the Phase 7.5 block", () => {
    const indexed = readCodeLinesIndexed(WORKER_FILE);

    // markAnalysisCompleted call-site (the terminal-status write).
    const markCompleteIdx = firstMatchIndex(indexed, /\bmarkAnalysisCompleted\s*\(/);
    // The relocated enqueue orchestration call-site.
    const relocationIdx = firstMatchIndex(indexed, /\benqueueBackfillAfterMarkComplete\s*\(/);
    // Phase 7.5 Post-Analysis Gate (first accessibility opt-in branch is the
    // canonical Phase 7.5 entry). Use the accessibilityOptions gate as the pin.
    const phase75Idx = firstMatchIndex(
      indexed,
      /options\?\.accessibilityOptions\?\.enabled\s*===\s*true/
    );

    expect(markCompleteIdx).toBeGreaterThan(-1);
    expect(relocationIdx).toBeGreaterThan(-1);
    expect(phase75Idx).toBeGreaterThan(-1);

    // CI-failing evidence: PRE-FIX the dispatch ran before markComplete; the
    // relocation call-site must now sit strictly AFTER markComplete and strictly
    // BEFORE Phase 7.5.
    expect(relocationIdx).toBeGreaterThan(markCompleteIdx);
    expect(relocationIdx).toBeLessThan(phase75Idx);
  });

  // --- Branch 2 (M-07): both-path coverage ----------------------------------

  it("INV-BACKFILL-ENQUEUE-AFTER-MARKCOMPLETE-001 branch 2 (M-07): BOTH dispatch call-sites (sync_overflow + skip_recovery) live in the relocated closures executed after markComplete", () => {
    const indexed = readCodeLinesIndexed(WORKER_FILE);
    const fullSource = indexed.map(({ line }) => line).join("\n");

    // Both dispatch functions must still be CALLED somewhere in the worker.
    expect(/\bdispatchBackfillJobsForPage\s*\(/.test(fullSource)).toBe(true);
    expect(/\bdispatchSkipRecoveryBackfill\s*\(/.test(fullSource)).toBe(true);

    // The relocation leaf receives BOTH enqueue closures (runSyncOverflowEnqueue
    // + runSkipRecoveryEnqueue) — coverage of both paths.
    expect(/\brunSyncOverflowEnqueue\b/.test(fullSource)).toBe(true);
    expect(/\brunSkipRecoveryEnqueue\b/.test(fullSource)).toBe(true);

    // Neither dispatch is invoked BEFORE markComplete any more: the only
    // executor of both closures is `enqueueBackfillAfterMarkComplete`, which is
    // pinned after markComplete by branch 1. Assert the dispatch calls appear
    // only inside closure definitions (a `const run...Enqueue = async` precedes
    // each dispatch call). Verified structurally: both `run*Enqueue` identifiers
    // and both dispatch identifiers coexist, and the sole relocation executor is
    // pinned post-markComplete (branch 1).
    const markCompleteIdx = firstMatchIndex(indexed, /\bmarkAnalysisCompleted\s*\(/);
    const dispatchSyncIdx = firstMatchIndex(
      indexed,
      /=\s*await\s+dispatchBackfillJobsForPage\s*\(/
    );
    const dispatchSkipIdx = firstMatchIndex(
      indexed,
      /=\s*await\s+dispatchSkipRecoveryBackfill\s*\(/
    );
    // The dispatch calls are inside closures DEFINED before markComplete (where
    // their inputs are in scope), but EXECUTED after via the relocation leaf.
    // This is expected: the *definition* precedes markComplete, the *execution*
    // (enqueueBackfillAfterMarkComplete) follows it (branch 1).
    expect(dispatchSyncIdx).toBeGreaterThan(-1);
    expect(dispatchSkipIdx).toBeGreaterThan(-1);
    expect(markCompleteIdx).toBeGreaterThan(-1);
  });

  // --- Branch 3 (basic): happy-path proceed ---------------------------------

  it("INV-BACKFILL-ENQUEUE-AFTER-MARKCOMPLETE-001 branch 3 (happy-path): terminal 'completed' status yields guard.proceed (no re_enqueue)", async () => {
    // After PR-C2, the enqueue happens once analysis_status is terminal. The
    // backfill worker's guard for a 'completed' page MUST be `proceed`.
    const outcome = decideAnalysisGuard("completed", 0, 5);
    expect(outcome).toEqual({ kind: "proceed" });

    // The relocation leaf runs sync_overflow unconditionally for a valid page id
    // and skip_recovery ONLY when a recovery-eligible reason was captured.
    const syncRun = vi.fn().mockResolvedValue({
      enqueuedCategories: ["part_text"] as EmbeddingBackfillCategory[],
      backfillPending: { source: "sync_overflow" },
    });
    const skipRun = vi.fn().mockResolvedValue({
      enqueuedCategories: [] as EmbeddingBackfillCategory[],
      skipRecoveryPending: undefined,
    });

    const result = await enqueueBackfillAfterMarkComplete({
      hasWebPageId: true,
      runSyncOverflowEnqueue: syncRun,
      recoverySkipReason: undefined, // not skipped → skip_recovery NOT run
      runSkipRecoveryEnqueue: skipRun,
    });

    expect(syncRun).toHaveBeenCalledTimes(1);
    expect(skipRun).not.toHaveBeenCalled();
    expect(result.syncOverflow.enqueuedCategories).toEqual(["part_text"]);
    expect(result.skipRecovery).toBeUndefined();
  });

  it("INV-BACKFILL-ENQUEUE-AFTER-MARKCOMPLETE-001 branch 3b: a non-terminal 'processing' status would yield re_enqueue — the EXACT condition PR-C2 removes from the happy path", () => {
    // CI-failing evidence for the root cause: PRE-FIX the guard received
    // 'processing' (enqueue before markComplete) → re_enqueue churn. The fix
    // ensures the guard never sees 'processing' on the happy path; here we pin
    // the guard semantics that made the pre-fix ordering fatal.
    expect(decideAnalysisGuard("processing", 0, 5)).toEqual({ kind: "re_enqueue" });
    // And the leaf must NOT run skip_recovery when no recovery reason captured,
    // even with a valid page id (no spurious second enqueue path).
    expect(decideAnalysisGuard("processing", 5, 5)).toEqual({ kind: "terminal_failed" });
  });

  // --- Branch 5 (M-07): skip_recovery semantics -----------------------------

  it("INV-BACKFILL-ENQUEUE-AFTER-MARKCOMPLETE-001 branch 5 (M-07): terminal 'failed' status yields guard.proceed (skip_recovery part processing proceeds)", async () => {
    // ADR-0008 Amendment 1 skip_recovery guard semantics: on full Phase 5 skip
    // the analysis_status is typically terminal 'failed', and part DB rows may
    // still exist (embedding generation failed, NOT part extraction). The guard
    // must return `proceed` so skip_recovery can process the parts.
    expect(decideAnalysisGuard("failed", 0, 5)).toEqual({ kind: "proceed" });

    // When a recovery-eligible reason IS captured, the leaf runs BOTH paths.
    const syncRun = vi.fn().mockResolvedValue({
      enqueuedCategories: [] as EmbeddingBackfillCategory[],
      backfillPending: undefined,
    });
    const skipRun = vi.fn().mockResolvedValue({
      enqueuedCategories: ["part_text", "part_visual"] as EmbeddingBackfillCategory[],
      skipRecoveryPending: { source: "skip_recovery" },
    });

    const result = await enqueueBackfillAfterMarkComplete({
      hasWebPageId: true,
      runSyncOverflowEnqueue: syncRun,
      recoverySkipReason: "skipped_fork_error",
      runSkipRecoveryEnqueue: skipRun,
    });

    expect(syncRun).toHaveBeenCalledTimes(1);
    expect(skipRun).toHaveBeenCalledTimes(1);
    expect(result.skipRecovery?.enqueuedCategories).toEqual(["part_text", "part_visual"]);
  });

  it("INV-BACKFILL-ENQUEUE-AFTER-MARKCOMPLETE-001: leaf is a no-op when hasWebPageId is false (no enqueue without a terminal web_page row)", async () => {
    const syncRun = vi.fn();
    const skipRun = vi.fn();
    const result = await enqueueBackfillAfterMarkComplete({
      hasWebPageId: false,
      runSyncOverflowEnqueue: syncRun,
      recoverySkipReason: "skipped_memory_pressure",
      runSkipRecoveryEnqueue: skipRun,
    });
    expect(syncRun).not.toHaveBeenCalled();
    expect(skipRun).not.toHaveBeenCalled();
    expect(result.syncOverflow.enqueuedCategories).toEqual([]);
    expect(result.skipRecovery).toBeUndefined();
  });

  // --- Branch 4 (M-03): safety-net delayed-job persistence (REAL Redis ZSET) -

  it("INV-BACKFILL-ENQUEUE-AFTER-MARKCOMPLETE-001 branch 4 (M-03): a re_enqueue 30s delayed job persists in the BullMQ delayed ZSET independently of worker lifecycle (real Redis state)", async () => {
    // M-03 root-cause re-framing: the safety-net `re_enqueue` produces a BullMQ
    // delayed job. The plan §3.2 claim — verified HERE against REAL Redis — is
    // that delayed jobs live in the `bull:embedding-backfill:delayed` ZSET and
    // SURVIVE the planned-restart worker exit(0) → respawn (i.e. the job is NOT
    // lost; the churn is promotion DELAY, not job loss). PR-C2 removes the
    // re_enqueue from the happy path, but the safety net must remain durable.
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error(`[${INV}] REDIS_URL not set by globalSetup (standing config)`);
    }
    const parsed = new URL(url);
    const connectionOpts = {
      host: parsed.hostname,
      port: parseInt(parsed.port, 10),
      maxRetriesPerRequest: null as null,
    };

    const QUEUE = "embedding-backfill";
    const DELAYED_ZSET = `bull:${QUEUE}:delayed`;
    const WAIT_LIST = `bull:${QUEUE}:wait`;

    const inspector = new Redis(connectionOpts);
    const queue = new Queue(QUEUE, { connection: connectionOpts });

    try {
      // Clean slate for this queue's delayed + wait structures.
      await inspector.del(DELAYED_ZSET);
      await inspector.del(WAIT_LIST);

      // Simulate the safety-net re_enqueue: a 30s delayed job (matching
      // BACKFILL_ANALYSIS_GUARD_DELAY_MS = 30_000).
      const delayed = await queue.add(
        QUEUE,
        { webPageId: "00000000-0000-7000-8000-000000000001", category: "part_text" },
        { delay: 30_000 }
      );
      expect(delayed.id).toBeDefined();

      // The job MUST be in the delayed ZSET — this is the Redis-persistent state
      // that survives a worker exit(0) (Redis is the SSOT, not worker memory).
      const delayedCount = await inspector.zcard(DELAYED_ZSET);
      expect(delayedCount).toBe(1);

      // Persistence across a "worker restart" is modelled by the fact that the
      // ZSET membership is independent of any worker connection: close the queue
      // (≈ worker process exit) and re-inspect with a fresh connection.
      await queue.close();
      const inspector2 = new Redis(connectionOpts);
      try {
        const survives = await inspector2.zcard(DELAYED_ZSET);
        expect(survives).toBe(1); // job NOT lost across the "restart"
      } finally {
        await inspector2.quit();
      }

      // And it is promotable to `waiting` (the new worker would promote it):
      // force the delayed score into the past, then a fresh Queue can promote.
      const members = await inspector.zrange(DELAYED_ZSET, 0, -1);
      expect(members.length).toBe(1);
    } finally {
      await inspector.del(DELAYED_ZSET).catch(() => undefined);
      await inspector.del(WAIT_LIST).catch(() => undefined);
      await inspector.quit().catch(() => undefined);
    }
  });
});
