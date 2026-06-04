// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain (Plan v3 Track T4 +
 * Plan v1.1 candidate B file rename).
 *
 * INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004 (file renamed to
 * `inv-worker-restart-memory-gate-only-004.test.ts` per Plan v1.1 §6,
 * 2026-05-28): Worker restart memory-gate-only contract verification.
 *
 * ## Plan v1.1 candidate B reframe (2026-05-28)
 *
 * Plan v1.1 candidate B / ADR-0034 Amendment 5 で Stage 2
 * `worker.pause(true)` を **success path からも formal removal** した結果、
 * Worker restart は両 path で `applyPostJobMemoryGate` (memory-only gate)
 * のみに統一された。"Pre-Return Pause" 概念は廃止され、本 INV はその名前
 * (legacy identifier として body assertion 内で維持) を「Worker restart
 * memory-gate-only contract」として reframe される。
 *
 * INV name は backward compat のため `INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004`
 * を assertion body 内で維持 (legacy `assertInvName` enforces this). 新 file
 * 名 `inv-worker-restart-memory-gate-only-004` は Amendment 5 stage 8→7 縮退
 * 同期 (Plan v1.1 §6 H-02 closure)。
 *
 * Plan v1.1 candidate B / ADR-0034 Amendment 5 formally removes Stage 2
 * `worker.pause(true)` from **both success and failure paths**. Worker
 * restart is now driven exclusively by `applyPostJobMemoryGate`
 * (memory-only gate). The "Pre-Return Pause" concept is retired; this INV
 * is reframed as the "Worker restart memory-gate-only contract". The INV
 * identifier `INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004` is preserved in
 * assertion bodies for backward compat (legacy `assertInvName` enforces
 * the prefix); the file rename
 * (`inv-worker-restart-memory-gate-only-004.test.ts`) reflects Amendment 5
 * stage 8→7 reduction per Plan v1.1 §6.
 *
 * ## Sub-cases (post-Plan-v1.1)
 *
 *   - **Sub-1 (catch-block-incomplete)**: child catch tail commits both
 *     `web_pages` failure row AND audit_logs entry atomically (Contract 1
 *     atomicity). SEC M-01 raw-SQL ban verified via AST grep.
 *   - **Sub-2 (no worker.pause on either path)**: Plan v1.1 candidate B
 *     reframe — the outer `processPageAnalyzeJob` catch block does NOT
 *     invoke `worker.pause(...)`. INV-WORKER-NO-PAUSE-001 (AST gate
 *     `verify-no-worker-pause.mjs`) is the canonical production-code
 *     enforcement; this sub preserves the body-level structural assertion.
 *   - **Sub-3 (true orphan backfill)**: supervisor backfill closes
 *     `web_pages.failed_with_known_reason` via
 *     `WorkerSupervisorFailurePathService` Contract 2.
 *
 * **Wave 2 (UNBLOCK-T4-03 runtime-binding extension)**: Z-a equivalent
 * re-entry adds runtime fault injection sub-blocks alongside AST-grep
 * heuristic structural assertions.
 *
 * @see Plan v1.1 §3 candidate B (`backfill-pause-completed-race-v1.md`)
 * @see ADR-0034 Amendment 5 §Decision 2-4 (Stage 2 formal removal)
 * @see IO Plan Decision V1 anchor `019e6f1a-b580`
 * @see INV-WORKER-NO-PAUSE-001 (AST gate `verify-no-worker-pause.mjs`)
 * @see PR-V3-T4 design.md §8 (test landing strategy)
 * @see ADR-0009 Amendment 2 §A2.4 (Bug 1 portion further retracted)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertInvName } from "../_setup/inv-assert";
import {
  backfillOrphanWebPageRow,
  failedKnownReasonForPhaseN,
  handleChildExitOrBackfill,
  markFailedAndAuditAtomic,
  probeExistingLockBeforeBackfill,
  type FailurePathPrismaClient,
  type PhaseN,
} from "../../../../src/services/worker-supervisor-failure-path.service";
import type { WorkerActiveLockService } from "../../../../src/services/worker-active-lock.service";
import {
  resetAuditLogPrismaClientFactory,
  resetAuditLogService,
  setAuditLogPrismaClientFactory,
  type AuditLogPrismaClient,
} from "../../../../src/services/audit-log.service";

const FAILURE_PATH_SERVICE_FILE = resolve(
  __dirname,
  "../../../../src/services/worker-supervisor-failure-path.service.ts"
);

const PAGE_ANALYZE_WORKER_FILE = resolve(
  __dirname,
  "../../../../src/workers/page-analyze-worker.ts"
);

describe("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004", () => {
  describe("Sub-1 (catch-block-incomplete) — Contract 1 atomicity + SEC M-01 raw-SQL ban", () => {
    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: failure-path service uses Prisma typed methods only (no $executeRawUnsafe / $queryRawUnsafe in scope) / Prisma typed methods only", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      // SEC M-01 ban: raw SQL forbidden in failure-path scope. AST-level
      // grep on the source file (heuristic; full AST scan in lint plugin).
      expect(content).not.toMatch(/\$executeRawUnsafe/);
      expect(content).not.toMatch(/\$queryRawUnsafe/);
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: markFailedAndAuditAtomic returns FailureCommittedResult discriminated union (committed: true | committed: false) / discriminated union return", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      // Contract 1: discriminated union for catch-block tail consumption.
      expect(content).toMatch(/committed:\s*true/);
      expect(content).toMatch(/committed:\s*false/);
      expect(content).toMatch(/web_page_id_unknown|transaction_aborted/);
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: markFailedAndAuditAtomic emits audit_logs.action='worker_restart_during_inflight_phase' inside the same Prisma $transaction / atomic audit-emit-with-row-update", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      // Single $transaction containing both the webPage write + auditLog.create.
      // PR-INGEST-FAIL-ROW / ADR-0016 Amendment 6 §Decision 2: Contract 1 now
      // uses the url-key `webPage.upsert` (larger create/update payload), so the
      // scan window is widened to 1400 chars; the regex accepts upsert OR update
      // (Contract 2 backfill still uses update).
      const transactionBlocks = content.match(/\$transaction[\s\S]{0,1400}/g) ?? [];
      expect(transactionBlocks.length).toBeGreaterThanOrEqual(1);
      // At least one transaction block must contain BOTH the webPage write
      // (upsert | update) and auditLog.create — proving atomicity invariant.
      // The action identifier is sourced via SSOT constant per Z-b TPA M-01
      // audit_logs.action SSOT migration; the regex accepts either the literal
      // OR the SSOT constant name.
      const atomicBlock = transactionBlocks.find(
        (b) =>
          /webPage\.(upsert|update)/.test(b) &&
          /auditLog\.create/.test(b) &&
          /(worker_restart_during_inflight_phase|AUDIT_ACTION_WORKER_RESTART_DURING_INFLIGHT_PHASE)/.test(
            b
          )
      );
      expect(atomicBlock).toBeDefined();
    });
  });

  describe("Sub-2 (no worker.pause on either path) — Plan v1.1 candidate B reframe + INV-WORKER-NO-PAUSE-001 cross-cut", () => {
    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: outer processPageAnalyzeJob catch block does NOT call worker.pause / failure-path no-pause structural verification", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const content = readFileSync(PAGE_ANALYZE_WORKER_FILE, "utf-8");
      // Locate the OUTER processPageAnalyzeJob catch block. Anchor on the
      // sentinel comment "Job failed with exception" emitted by the outer
      // catch block (unique within the file; not present in inner catches).
      const sentinel = "[PageAnalyzeWorker] Job failed with exception";
      const sentinelIdx = content.indexOf(sentinel);
      expect(sentinelIdx).toBeGreaterThan(0);
      const catchStart = content.lastIndexOf("} catch (error) {", sentinelIdx);
      const finallyStart = content.indexOf("} finally {", catchStart);
      expect(catchStart).toBeGreaterThan(0);
      expect(finallyStart).toBeGreaterThan(catchStart);
      const catchBody = content.slice(catchStart, finallyStart);
      // Plan v1.1 candidate B (ADR-0034 Amendment 5): failure path NEVER
      // calls worker.pause. This is the body-level structural assertion;
      // the canonical production-code enforcement is the AST gate
      // `scripts/verify-no-worker-pause.mjs` (INV-WORKER-NO-PAUSE-001).
      expect(catchBody).not.toMatch(/worker\.pause\s*\(/);
      expect(catchBody).not.toMatch(/_workerInstanceRef\.pause/);
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: success path between try and outer catch ALSO does NOT call worker.pause (Plan v1.1 candidate B, Stage 2 formal removal) / success-path no-pause structural verification", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const content = readFileSync(PAGE_ANALYZE_WORKER_FILE, "utf-8");
      // Plan v1.1 candidate B reframe: scan the success path region of the
      // outer processPageAnalyzeJob for any forbidden `worker.pause(`
      // callsite. Stage 2 `worker.pause(true)` is formally removed
      // (ADR-0034 Amendment 5 §Decision 2-4).
      //
      // We locate the OUTER catch sentinel ("Job failed with exception")
      // first, then grab the success-path region (between the most recent
      // `try {` token and the outer catch). To avoid matching prose inside
      // comments / docstrings, strip line-comment and JSDoc-line tokens
      // before applying the regex.
      const outerCatchSentinel = "[PageAnalyzeWorker] Job failed with exception";
      const outerCatchIdx = content.indexOf(outerCatchSentinel);
      expect(outerCatchIdx).toBeGreaterThan(0);
      const tryStart = content.lastIndexOf("try {", outerCatchIdx);
      const catchStart = content.lastIndexOf("} catch (error) {", outerCatchIdx);
      expect(tryStart).toBeGreaterThan(0);
      expect(catchStart).toBeGreaterThan(tryStart);
      const successPathRegion = content.slice(tryStart, catchStart);
      // Strip comments: lines whose trimmed prefix is `//` or `*` (JSDoc
      // continuation). Backtick-wrapped tokens inside multi-line code
      // strings are extremely rare; the prose-vs-code separation via
      // line-prefix filter is sufficient for this structural assertion.
      const codeOnly = successPathRegion
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          return !trimmed.startsWith("//") && !trimmed.startsWith("*");
        })
        .join("\n");
      // Plan v1.1 candidate B: no `worker.pause(` callsite, no
      // `_workerInstanceRef.pause` callsite, and no
      // `applyPostJobLifecycleGate(_workerInstanceRef, ...)` callsite.
      expect(codeOnly).not.toMatch(/worker\.pause\s*\(/);
      expect(codeOnly).not.toMatch(/_workerInstanceRef\.pause/);
      expect(codeOnly).not.toMatch(/applyPostJobLifecycleGate\s*\(\s*_workerInstanceRef/);
      // Must invoke `applyPostJobMemoryGate` (canonical memory-only gate).
      expect(codeOnly).toMatch(/applyPostJobMemoryGate\s*\(/);
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: outer catch block calls markFailedAndAuditAtomic (Plan v3 T4 Contract 1) / markFailedAndAuditAtomic invocation present", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const content = readFileSync(PAGE_ANALYZE_WORKER_FILE, "utf-8");
      const sentinel = "[PageAnalyzeWorker] Job failed with exception";
      const sentinelIdx = content.indexOf(sentinel);
      const catchStart = content.lastIndexOf("} catch (error) {", sentinelIdx);
      const finallyStart = content.indexOf("} finally {", catchStart);
      const catchBody = content.slice(catchStart, finallyStart);
      expect(catchBody).toMatch(/markFailedAndAuditAtomic/);
    });
  });

  describe("Sub-3 (true orphan backfill) — supervisor Contract 2 closure", () => {
    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: failure-path service exports backfillOrphanWebPageRow + handleChildExitOrBackfill / supervisor backfill surface present", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      expect(content).toMatch(/export async function backfillOrphanWebPageRow/);
      expect(content).toMatch(/export async function handleChildExitOrBackfill/);
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: backfill writes audit_logs.action='worker_restart_during_inflight_phase' BEFORE row deletion path (LCC H-02 atomicity) / LCC H-02 audit-emit-before-delete", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      // Both action emits must appear within $transaction blocks for atomicity.
      // Per Z-b TPA M-01 SSOT migration the action identifier is sourced via
      // `AUDIT_ACTION_WORKER_RESTART_DURING_INFLIGHT_PHASE` constant; the
      // regex accepts either the literal OR the SSOT constant name.
      // Z-b TPA M-01 SSOT-aware regex (constant OR literal accepted).
      // PR-INGEST-FAIL-ROW: Contract 1's $transaction grew (url-key upsert
      // create/update payload), so the scan window is widened to 1400 chars to
      // reach the audit metadata `reason` field.
      const txBlocks = content.match(/\$transaction[\s\S]{0,1400}/g) ?? [];
      const hasAuditEmitInTx = txBlocks.some(
        (b) =>
          /(worker_restart_during_inflight_phase|AUDIT_ACTION_WORKER_RESTART_DURING_INFLIGHT_PHASE)/.test(
            b
          ) && /backfilled_from_orphan|self_emit/.test(b)
      );
      expect(hasAuditEmitInTx).toBe(true);
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: SEC H-02 child_pid truncated via truncateChildPid (no raw PID in audit_logs.metadata) / SEC H-02 PID truncation", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      // SEC H-02: raw PID forbidden in audit_logs.metadata; must use the
      // truncateChildPid helper (sha256_8chars hash form).
      expect(content).toMatch(/truncateChildPid/);
      // Defensive negation: ensure raw `child_pid: params.childPid` (number)
      // is NOT used directly in metadata payload assignments.
      expect(content).not.toMatch(/child_pid:\s*params\.childPid\s*[,}]/);
    });
  });

  describe("Sub-3d (SEC H-03 fail-closed)", () => {
    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: probeExistingLockBeforeBackfill returns three-way discriminated outcome / SEC H-03 fail-closed contract", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      // BackfillProbeOutcome: 'proceed' | 'skip_live_lock' | 'redis_unavailable'
      expect(content).toMatch(/kind:\s*"proceed"/);
      expect(content).toMatch(/kind:\s*"skip_live_lock"/);
      expect(content).toMatch(/kind:\s*"redis_unavailable"/);
    });
  });

  // ==========================================================================
  // Wave 2 (UNBLOCK-T4-03) — Runtime-binding fault injection sub-blocks
  // ==========================================================================
  //
  // Co-existence rationale (per `feedback_meta_lessons_pre1.md` 5+1 構造的盲点
  // lesson "mocked では bypass される runtime 境界"): the AST-grep blocks above
  // verify the implementation surface exists (compile-time invariant) but cannot
  // observe transaction ordering, audit-emit-with-row-update atomicity, or the
  // probe → emit causal chain. The runtime blocks below drive the helpers
  // directly with in-memory stubs to verify behavioural contract.
  //
  // Wave 2 では AST-grep 構造 test に加えて、stub Prisma + stub LockService で
  // helper を直接駆動する runtime fault injection sub-block を併設する。
  // ==========================================================================

  describe("Sub-3 (Contract 1 atomicity) — runtime: markFailedAndAuditAtomic atomic transaction binding", () => {
    interface RecordedTxOp {
      readonly op: "webPage.update" | "webPage.upsert" | "auditLog.create";
      readonly args: Record<string, unknown>;
    }

    let recordedAuditCreates: Array<{
      action: string;
      actor: string;
      targetType: string;
      targetId: string | null;
      details: Record<string, unknown> | null;
      ipAddress: string | null;
      result: string;
    }>;
    let recordedTxOps: RecordedTxOp[];

    beforeEach(() => {
      recordedAuditCreates = [];
      recordedTxOps = [];
      // Reset DI so getAuditLogService() will pick up the per-test stub the
      // first time emitSupervisorAuditLog touches it.
      resetAuditLogPrismaClientFactory();
      resetAuditLogService();
    });

    afterEach(() => {
      resetAuditLogPrismaClientFactory();
      resetAuditLogService();
      vi.restoreAllMocks();
    });

    function makeFailurePathPrismaStub(): FailurePathPrismaClient {
      const txClient: FailurePathPrismaClient = {
        $transaction: async <T>(fn: (tx: FailurePathPrismaClient) => Promise<T>): Promise<T> => {
          // The discriminator: invocations from inside fn(tx) must record op
          // order so we can assert atomicity (both ops in single tx).
          return fn(txClient);
        },
        webPage: {
          // Contract 1 (markFailedAndAuditAtomic) now uses url-key upsert
          // (PR-INGEST-FAIL-ROW / ADR-0016 Amendment 6 §Decision 2), not the
          // id-key update; `update` is retained on the stub for type
          // compatibility (Contract 2 backfill path uses it).
          update: async (args) => {
            recordedTxOps.push({
              op: "webPage.update",
              args: args as unknown as Record<string, unknown>,
            });
            return { id: (args.where as { id: string }).id };
          },
          upsert: async (args) => {
            recordedTxOps.push({
              op: "webPage.upsert",
              args: args as unknown as Record<string, unknown>,
            });
            return { id: args.create.id };
          },
        },
        workerJobLifecycle: {
          findMany: async () => [],
        },
        auditLog: {
          create: async (args) => {
            recordedTxOps.push({
              op: "auditLog.create",
              args: args as unknown as Record<string, unknown>,
            });
            recordedAuditCreates.push({
              action: args.data.action,
              actor: args.data.actor,
              targetType: args.data.targetType,
              targetId: args.data.targetId,
              details: args.data.details,
              ipAddress: args.data.ipAddress,
              result: args.data.result,
            });
            return { id: "stub-audit-id" };
          },
        },
      };
      return txClient;
    }

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: markFailedAndAuditAtomic runtime — single $transaction wraps both webPage.update AND auditLog.create (atomic ordering)", async () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const prismaStub = makeFailurePathPrismaStub();
      const txSpy = vi.spyOn(prismaStub, "$transaction");

      const result = await markFailedAndAuditAtomic(prismaStub, {
        webPageId: "00000000-0000-0000-0000-000000000001",
        normalizedUrl: "https://example.com/memory-gate-atomic",
        errorMessage: "phase 5 fork OOM",
        phaseN: "5",
        childPid: 12345,
      });

      // Discriminated union: committed=true with reconstructed enum value.
      expect(result.committed).toBe(true);
      if (result.committed) {
        expect(result.failedReason).toBe(failedKnownReasonForPhaseN("5"));
        expect(result.webPageId).toBe("00000000-0000-0000-0000-000000000001");
      }

      // Atomicity contract: exactly ONE $transaction invocation containing
      // BOTH webPage.upsert (url-key, Amendment 6) AND auditLog.create.
      expect(txSpy).toHaveBeenCalledTimes(1);
      expect(recordedTxOps.map((o) => o.op)).toEqual(["webPage.upsert", "auditLog.create"]);
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: markFailedAndAuditAtomic runtime — webPage.failedWithKnownReason matches phase enum (Plan v3 T4 Conflict 3)", async () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const prismaStub = makeFailurePathPrismaStub();
      // Cycle through every PhaseN to assert enum mapping.
      const phases: readonly PhaseN[] = ["0", "1", "2_5", "4", "5", "7_5"];
      for (const phaseN of phases) {
        recordedTxOps = [];
        const result = await markFailedAndAuditAtomic(prismaStub, {
          webPageId: "00000000-0000-0000-0000-000000000002",
          normalizedUrl: `https://example.com/memory-gate-phase-${phaseN}`,
          errorMessage: "x",
          phaseN,
          childPid: 99,
        });
        expect(result.committed).toBe(true);
        // url-key upsert (Amendment 6): assert the upsert `update` branch carries
        // the terminal failure columns + canonical enum.
        const upsertOp = recordedTxOps.find((o) => o.op === "webPage.upsert");
        expect(upsertOp).toBeDefined();
        const upsertArgs = upsertOp!.args as {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        };
        expect(upsertArgs.update.failedWithKnownReason).toBe(
          `worker_restart_during_inflight_phase_${phaseN}`
        );
        expect(upsertArgs.update.analysisStatus).toBe("failed");
        expect(upsertArgs.update.analysisPhaseStatus).toBe("failed");
        // The create branch (NOROW path) carries the same terminal columns.
        expect(upsertArgs.create.failedWithKnownReason).toBe(
          `worker_restart_during_inflight_phase_${phaseN}`
        );
        expect(upsertArgs.create.analysisStatus).toBe("failed");
      }
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: markFailedAndAuditAtomic runtime — undefined webPageId returns committed=false (web_page_id_unknown discriminant)", async () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const prismaStub = makeFailurePathPrismaStub();
      const txSpy = vi.spyOn(prismaStub, "$transaction");

      const result = await markFailedAndAuditAtomic(prismaStub, {
        webPageId: undefined,
        normalizedUrl: "https://example.com/memory-gate-no-id",
        errorMessage: "x",
        phaseN: "0",
        childPid: 1,
      });

      expect(result.committed).toBe(false);
      if (!result.committed) {
        expect(result.reason).toBe("web_page_id_unknown");
      }
      // No transaction MUST fire when webPageId is unknown (early return).
      expect(txSpy).not.toHaveBeenCalled();
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: markFailedAndAuditAtomic runtime — Prisma transaction throw returns committed=false (transaction_aborted discriminant)", async () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const prismaStub: FailurePathPrismaClient = {
        $transaction: async () => {
          throw new Error("simulated tx abort");
        },
        webPage: {
          update: async () => ({ id: "" }),
          upsert: async () => ({ id: "" }),
        },
        workerJobLifecycle: { findMany: async () => [] },
        auditLog: { create: async () => ({ id: "" }) },
      };

      const result = await markFailedAndAuditAtomic(prismaStub, {
        webPageId: "00000000-0000-0000-0000-000000000003",
        normalizedUrl: "https://example.com/memory-gate-abort",
        errorMessage: "x",
        phaseN: "5",
        childPid: 1,
      });

      expect(result.committed).toBe(false);
      if (!result.committed) {
        expect(result.reason).toBe("transaction_aborted");
      }
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: markFailedAndAuditAtomic runtime — audit_logs metadata satisfies SEC M-03 Zod schema (reason='self_emit', child_pid=pid_<sha256_8chars>)", async () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const prismaStub = makeFailurePathPrismaStub();
      await markFailedAndAuditAtomic(prismaStub, {
        webPageId: "00000000-0000-0000-0000-000000000004",
        normalizedUrl: "https://example.com/memory-gate-metadata",
        errorMessage: "x",
        phaseN: "1",
        childPid: 4242,
      });
      expect(recordedAuditCreates).toHaveLength(1);
      const audit = recordedAuditCreates[0]!;
      expect(audit.action).toBe("worker_restart_during_inflight_phase");
      expect(audit.actor).toBe("system:page-analyze-worker");
      expect(audit.targetType).toBe("web_page");
      expect(audit.result).toBe("failure");
      const meta = audit.details as Record<string, unknown>;
      expect(meta.failed_known_reason).toBe("worker_restart_during_inflight_phase_1");
      expect(meta.phase_n).toBe("1");
      expect(meta.phase_reconstruction).toBe("exact");
      expect(meta.reason).toBe("self_emit");
      // SEC H-02 PID truncation: child_pid must be `pid_<sha256_8chars>` form.
      expect(meta.child_pid).toMatch(/^pid_[0-9a-f]{8}$/);
    });
  });

  describe("Sub-3 (Contract 2 backfill) — runtime: backfillOrphanWebPageRow + handleChildExitOrBackfill", () => {
    interface RecordedTxOp {
      readonly op: "webPage.update" | "auditLog.create";
      readonly args: Record<string, unknown>;
    }
    let recordedTxOps: RecordedTxOp[];

    beforeEach(() => {
      recordedTxOps = [];
      resetAuditLogPrismaClientFactory();
      resetAuditLogService();
    });

    afterEach(() => {
      resetAuditLogPrismaClientFactory();
      resetAuditLogService();
      vi.restoreAllMocks();
    });

    function makeFailurePathPrismaStub(
      orphans: ReadonlyArray<{
        id: string;
        webPageId: string;
        workerPid: number;
        workerSpawnTime: Date;
        eventType: string;
        eventAt: Date;
      }> = []
    ): FailurePathPrismaClient {
      const txClient: FailurePathPrismaClient = {
        $transaction: async <T>(fn: (tx: FailurePathPrismaClient) => Promise<T>): Promise<T> =>
          fn(txClient),
        webPage: {
          // Contract 2 (backfillOrphanWebPageRow) uses the id-key update.
          // `upsert` is present only to satisfy the widened
          // FailurePathPrismaClient interface (PR-INGEST-FAIL-ROW).
          update: async (args) => {
            recordedTxOps.push({
              op: "webPage.update",
              args: args as unknown as Record<string, unknown>,
            });
            return { id: (args.where as { id: string }).id };
          },
          upsert: async (args) => ({ id: args.create.id }),
        },
        workerJobLifecycle: {
          findMany: async () => [...orphans],
        },
        auditLog: {
          create: async (args) => {
            recordedTxOps.push({
              op: "auditLog.create",
              args: args as unknown as Record<string, unknown>,
            });
            return { id: "stub-audit-id" };
          },
        },
      };
      return txClient;
    }

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: backfillOrphanWebPageRow runtime — atomic webPage.update + auditLog.create within single $transaction (LCC H-02 audit-emit-before-delete ordering)", async () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const prismaStub = makeFailurePathPrismaStub();
      const txSpy = vi.spyOn(prismaStub, "$transaction");

      await backfillOrphanWebPageRow(prismaStub, {
        webPageId: "00000000-0000-0000-0000-000000000005",
        phaseN: "2_5",
        reconstruction: "best_effort",
        childPid: 9999,
        exitSignal: "SIGKILL",
      });

      expect(txSpy).toHaveBeenCalledTimes(1);
      // LCC H-02: webPage.update precedes the audit_logs entry inside the
      // single transaction; both operations land atomically before the
      // cleanup-cron may delete the row.
      expect(recordedTxOps.map((o) => o.op)).toEqual(["webPage.update", "auditLog.create"]);
      const auditCreate = recordedTxOps.find((o) => o.op === "auditLog.create");
      const auditData = (auditCreate!.args as { data: Record<string, unknown> }).data;
      const meta = auditData.details as Record<string, unknown>;
      expect(meta.reason).toBe("backfilled_from_orphan");
      expect(meta.phase_reconstruction).toBe("best_effort");
      expect(meta.exit_signal).toBe("SIGKILL");
      expect(meta.failed_known_reason).toBe("worker_restart_during_inflight_phase_2_5");
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: handleChildExitOrBackfill runtime — proceed branch backfills every orphan webPageId returned by findOrphanWebPageIds", async () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      // Two orphan rows for the same exited child (same workerPid +
      // workerSpawnTime) — both have spawn but no release event → orphans.
      const exitedChildPid = 13579;
      const exitedChildSpawnTime = new Date("2026-05-05T19:30:00.000Z");
      const orphans = [
        {
          id: "lc-1",
          webPageId: "00000000-0000-0000-0000-0000000000A1",
          workerPid: exitedChildPid,
          workerSpawnTime: exitedChildSpawnTime,
          eventType: "spawn",
          eventAt: new Date("2026-05-05T19:30:00.001Z"),
        },
        {
          id: "lc-2",
          webPageId: "00000000-0000-0000-0000-0000000000A2",
          workerPid: exitedChildPid,
          workerSpawnTime: exitedChildSpawnTime,
          eventType: "spawn",
          eventAt: new Date("2026-05-05T19:30:00.002Z"),
        },
      ];
      const prismaStub = makeFailurePathPrismaStub(orphans);

      const lockStub = {
        probeExistingLock: vi.fn().mockResolvedValue({
          unavailable: false,
          exists: false,
        }),
      } as unknown as WorkerActiveLockService;

      const emitSkipped = vi.fn();
      await handleChildExitOrBackfill(
        prismaStub,
        lockStub,
        {
          workerType: "page",
          exitedChildPid,
          exitedChildSpawnTime,
          lastAnalyzedPhases: new Map<string, string | null>([
            ["00000000-0000-0000-0000-0000000000A1", "ingest"],
            ["00000000-0000-0000-0000-0000000000A2", "layout"],
          ]),
          exitSignal: "SIGKILL",
        },
        emitSkipped
      );

      expect(emitSkipped).not.toHaveBeenCalled();
      // Both orphan rows must be backfilled — one webPage.update +
      // one auditLog.create per orphan = 4 ops total.
      const updateOps = recordedTxOps.filter((o) => o.op === "webPage.update");
      const auditOps = recordedTxOps.filter((o) => o.op === "auditLog.create");
      expect(updateOps).toHaveLength(2);
      expect(auditOps).toHaveLength(2);
      // Both orphan webPageIds appear as targets.
      const updatedIds = updateOps.map((o) => (o.args as { where: { id: string } }).where.id);
      expect(updatedIds.sort()).toEqual([
        "00000000-0000-0000-0000-0000000000A1",
        "00000000-0000-0000-0000-0000000000A2",
      ]);
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: handleChildExitOrBackfill runtime — skip_live_lock branch invokes emitSkipped + does NOT touch Prisma", async () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const prismaStub = makeFailurePathPrismaStub();
      const txSpy = vi.spyOn(prismaStub, "$transaction");
      const findManySpy = vi.spyOn(prismaStub.workerJobLifecycle, "findMany");

      const lockStub = {
        // Probe returns LIVE lock owned by a fresh Worker — fail-closed skip.
        probeExistingLock: vi.fn().mockResolvedValue({
          unavailable: false,
          exists: true,
          nonce: "fresh-worker-nonce",
        }),
      } as unknown as WorkerActiveLockService;

      const emitSkipped = vi.fn();
      await handleChildExitOrBackfill(
        prismaStub,
        lockStub,
        {
          workerType: "page",
          exitedChildPid: 7777,
          exitedChildSpawnTime: new Date("2026-05-05T19:30:00.000Z"),
          lastAnalyzedPhases: new Map<string, string | null>(),
        },
        emitSkipped
      );

      expect(emitSkipped).toHaveBeenCalledTimes(1);
      // Truncated PID form per SEC H-02.
      const [, truncatedPid] = emitSkipped.mock.calls[0] ?? [];
      expect(truncatedPid).toMatch(/^pid_[0-9a-f]{8}$/);
      // No Prisma writes — fail-closed contract.
      expect(txSpy).not.toHaveBeenCalled();
      expect(findManySpy).not.toHaveBeenCalled();
    });
  });

  describe("Sub-3d (SEC H-03 fail-closed) — runtime: probeExistingLockBeforeBackfill discriminated outcomes", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: probeExistingLockBeforeBackfill runtime — exists=true → kind='skip_live_lock' (CWE-362 race-lost defense)", async () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const lockStub = {
        probeExistingLock: vi.fn().mockResolvedValue({
          unavailable: false,
          exists: true,
          nonce: "n",
        }),
      } as unknown as WorkerActiveLockService;
      const outcome = await probeExistingLockBeforeBackfill(lockStub, "page", 4242);
      expect(outcome.kind).toBe("skip_live_lock");
      if (outcome.kind === "skip_live_lock") {
        expect(outcome.truncatedChildPid).toMatch(/^pid_[0-9a-f]{8}$/);
      }
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: probeExistingLockBeforeBackfill runtime — exists=false → kind='proceed' (no lock contention)", async () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const lockStub = {
        probeExistingLock: vi.fn().mockResolvedValue({
          unavailable: false,
          exists: false,
        }),
      } as unknown as WorkerActiveLockService;
      const outcome = await probeExistingLockBeforeBackfill(lockStub, "page", 4242);
      expect(outcome.kind).toBe("proceed");
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: probeExistingLockBeforeBackfill runtime — unavailable=true → kind='redis_unavailable' (ADR-0011 §A4 fail-open)", async () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const lockStub = {
        probeExistingLock: vi.fn().mockResolvedValue({
          unavailable: true,
          error: "redis disconnected",
        }),
      } as unknown as WorkerActiveLockService;
      const outcome = await probeExistingLockBeforeBackfill(lockStub, "page", 4242);
      expect(outcome.kind).toBe("redis_unavailable");
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: probeExistingLockBeforeBackfill runtime — probe throws → defensive kind='redis_unavailable' (fail-open per ADR-0011 §A4)", async () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const lockStub = {
        probeExistingLock: vi.fn().mockRejectedValue(new Error("unexpected")),
      } as unknown as WorkerActiveLockService;
      const outcome = await probeExistingLockBeforeBackfill(lockStub, "page", 4242);
      expect(outcome.kind).toBe("redis_unavailable");
    });
  });

  // ==========================================================================
  // Plumbing test — DI surface integrity (audit_logs DI factory wiring)
  // ==========================================================================

  describe("DI plumbing — AuditLogPrismaClient factory wiring is reset-safe", () => {
    afterEach(() => {
      resetAuditLogPrismaClientFactory();
      resetAuditLogService();
    });

    it("INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004: AuditLogPrismaClient DI surface accepts factory injection without throw / DI factory resilience", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-PRERETURN-PAUSE-FAILURE-PATH-004"
      );
      const auditClient: AuditLogPrismaClient = {
        auditLog: {
          create: async () => ({ id: "ok" }),
          findMany: async () => [],
          deleteMany: async () => ({ count: 0 }),
          count: async () => 0,
        },
      };
      // Should not throw — DI surface is the only legitimate audit-emit path
      // for the worker_orphan_backfill_skipped_due_to_live_lock secondary
      // action emitted by emitOrphanBackfillSkippedAudit (helpers).
      expect(() => setAuditLogPrismaClientFactory(() => auditClient)).not.toThrow();
    });
  });
});
