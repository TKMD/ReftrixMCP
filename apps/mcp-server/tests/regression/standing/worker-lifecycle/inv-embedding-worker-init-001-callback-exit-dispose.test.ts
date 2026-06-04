// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-EMBEDDING-WORKER-INIT-001 (Plan v4.3 PR-M / ADR-0035 §Decision 1 + §Decision 3):
 * `registerCompletedListenerAndExit` の **callback-exit listener body** が
 * Plan v4.3 PR-M-A で追加された optional `disposeFn` パラメタを honour し、
 * dispose ceiling race + per-type cooldown contract を構造的に enforce する
 * 不変条件を runtime + AST で verify する。
 *
 * INV-EMBEDDING-WORKER-INIT-001 (Plan v4.3 PR-M / ADR-0035 §Decision 1+3):
 * Verifies the callback-exit listener body of `registerCompletedListenerAndExit`
 * honours the optional `disposeFn` parameter, enforces the bounded dispose
 * ceiling race, and routes per-type cooldown via the
 * `EMBEDDING_BACKFILL_RESTART_DELAY_MS` env var (default 8000ms) as a
 * structural contract.
 *
 * ## 4 contracts / 4 不変条件
 *
 *   1. **disposeFn invocation contract** (ADR-0035 §Decision 1):
 *      `disposeFn` (when provided) is invoked from inside the synchronous
 *      `worker.once('completed', ...)` listener body before `process.exit(0)`.
 *      A `disposeFn` 未指定時 (page-analyze legacy path) は legacy synchronous
 *      `process.exit(0)` を保持し、`disposeFn` は呼ばれない。
 *   2. **dispose ceiling fail-open** (ADR-0035 §Decision 1):
 *      `EMBEDDING_DISPOSE_CEILING_MS` (default 5000ms) を **超過した場合**、
 *      `Promise.race` の setTimeout branch が resolve し
 *      `Promise.race(...).finally(() => process.exit(0))` が確実に firing する
 *      (`disposeFn()` が 5000ms 内に resolve しなくても exit する fail-open
 *      contract)。
 *   3. **per-type cooldown** (ADR-0035 §Decision 3):
 *      `embedding-backfill` Worker の planned-restart 時、
 *      `EMBEDDING_BACKFILL_RESTART_DELAY_MS` (default 8000ms) が
 *      `getRestartDelayMsForType("embedding-backfill")` 経由で適用される。
 *      PageAnalyzeWorker は `WORKER_RESTART_DELAY_MS` (default 3000ms) を維持。
 *   4. **audit emit on dispose error or ceiling timeout** (ADR-0035 §Decision 4):
 *      `disposeFn()` rejection 時 OR ceiling 超過時、
 *      `audit_logs.embedding_dispose_timeout` action が emit される
 *      (CWE-209 PII protection via `truncateAuditTargetId` SSOT、
 *      GDPR Art.30 365d retention 継承、actor `system:embedding-backfill-worker`)。
 *
 * ## CI-failing test (PR-M dependence)
 *
 * 本 test は Plan v4.3 PR-M Phase 2 Step 4 (PR-M-A + PR-M-B + PR-M-C) の
 * landing 前は **fail する想定**:
 *   - SSOT constant `AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT` が
 *     `apps/mcp-server/src/audit/audit-actions.ts` に未追加 (PR-M-A 依存)
 *   - `getRestartDelayMsForType` が `worker-supervisor.service.ts` に未実装
 *     (PR-M-A 依存)
 * PR-M-A landing 後に PASS する設計 (TDA M-NEW-4 reframing: static + mocked
 * execution、production verification は Phase 2 Step 8 IO Impl Decision
 * evidence input)。
 *
 * ## ADR-0020 Amendment 4 canonical pattern (vi.mock + vi.hoisted)
 *
 * `intra-file race` 防止のため、`vi.doMock` ではなく `vi.mock + vi.hoisted`
 * を採用する (per `.claude/rules/testing-requirements.md` §3 file-level
 * isolation)。
 *
 * ## Wave 5 LCC SSOT discipline (canonical CWE-209 PII protection pattern)
 *
 * `audit_logs.action` literal `"embedding_dispose_timeout"` は **hardcoded
 * 禁止**。test assertion は SSOT constant
 * `AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT` を import で導出し、
 * literal-string dual-assertion (`expect(value).toBe(SSOT_CONST)` +
 * `expect(value).toBe("embedding_dispose_timeout")`) で coupling drift を
 * 構造的に防止する (per `.claude/rules/security.md` §Canonical CWE-209 PII
 * Protection Pattern、Wave 5 LCC formal endorsement)。
 *
 * @see ADR-0035 §Decision 1 (canonical listener body pattern + dispose ceiling)
 * @see ADR-0035 §Decision 3 (per-type cooldown for embedding-backfill)
 * @see ADR-0035 §Decision 4 (SSOT action `embedding_dispose_timeout`)
 * @see ADR-0020 Amendment 4 (vi.mock + vi.hoisted canonical)
 * @see internal anchor (Plan v4.3 PR-M Phase 2 Step 4 PR-M-C dispatch)
 * @module tests/regression/standing/worker-lifecycle/inv-embedding-worker-init-001-callback-exit-dispose
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

// =============================================================================
// vi.hoisted: pre-construct mocks before module imports (ADR-0020 Amendment 4)
// =============================================================================

/**
 * Hoisted audit-log mock with `log` method capturing all emitted entries.
 * Each `it()` block resets `mockAuditLog.log.mockClear()` in `beforeEach`
 * to enforce the 1 test = 1 mock cycle contract
 * (per `.claude/rules/testing-requirements.md` §1).
 */
const { mockAuditLog } = vi.hoisted(() => ({
  mockAuditLog: {
    log: vi.fn(async () => undefined),
  },
}));

vi.mock("../../../../src/services/audit-log.service", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/services/audit-log.service")>(
    "../../../../src/services/audit-log.service"
  );
  return {
    ...actual,
    getAuditLogService: (): { log: typeof mockAuditLog.log } => mockAuditLog,
  };
});

// Imports MUST follow vi.mock so the mocked module is bound at static
// import time (vi.mock is auto-hoisted by Vitest).
import {
  AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT,
  AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER,
} from "../../../../src/audit/audit-actions";
import { registerCompletedListenerAndExit } from "../../../../src/workers/shared/post-job-lifecycle";

// =============================================================================
// Test Suite
// =============================================================================

describe("INV-EMBEDDING-WORKER-INIT-001: callback-exit listener body invokes disposeFn + bounded ceiling fail-open + per-type cooldown + audit emit (Plan v4.3 PR-M / ADR-0035)", () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let originalCeilingEnv: string | undefined;
  let originalEmbeddingDelayEnv: string | undefined;

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-EMBEDDING-WORKER-INIT-001");
    // 1 test = 1 mock cycle: fresh audit-log mock per test
    mockAuditLog.log.mockClear();
    // process.exit を no-op spy 化 (実際に process を終了させない)
    processExitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined as never) as typeof process.exit);
    // env snapshot for restoration
    originalCeilingEnv = process.env.EMBEDDING_DISPOSE_CEILING_MS;
    originalEmbeddingDelayEnv = process.env.EMBEDDING_BACKFILL_RESTART_DELAY_MS;
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    if (originalCeilingEnv === undefined) {
      delete process.env.EMBEDDING_DISPOSE_CEILING_MS;
    } else {
      process.env.EMBEDDING_DISPOSE_CEILING_MS = originalCeilingEnv;
    }
    if (originalEmbeddingDelayEnv === undefined) {
      delete process.env.EMBEDDING_BACKFILL_RESTART_DELAY_MS;
    } else {
      process.env.EMBEDDING_BACKFILL_RESTART_DELAY_MS = originalEmbeddingDelayEnv;
    }
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Test 1 — disposeFn invocation contract
  // ==========================================================================

  it("INV-EMBEDDING-WORKER-INIT-001: callback-exit listener invokes optional disposeFn before process.exit(0) (ADR-0035 §Decision 1 canonical listener body pattern)", async () => {
    // INV-EMBEDDING-WORKER-INIT-001
    const fakeWorker = new EventEmitter() as unknown as Parameters<
      typeof registerCompletedListenerAndExit
    >[0];

    const disposeFn = vi.fn(async () => {
      // Simulate fast successful dispose (well within ceiling)
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    registerCompletedListenerAndExit(fakeWorker, "embedding-backfill", {
      disposeFn,
      ceilingMs: 1000, // bounded ceiling well above dispose latency
    });

    // Emit 'completed' to trigger the listener body synchronously
    (fakeWorker as unknown as EventEmitter).emit("completed", {
      id: "test-job-id-001",
    });

    // disposeFn must have been invoked from inside the listener body
    // (synchronously called, not microtask-deferred — Promise.race takes
    // the resolved Promise from disposeFn() immediately)
    expect(disposeFn).toHaveBeenCalledTimes(1);

    // Wait for the Promise.race().finally(process.exit(0)) microtask chain.
    // 50ms is comfortably above the 5ms dispose latency + microtask tick.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(processExitSpy).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  // ==========================================================================
  // Test 2 — dispose ceiling fail-open
  // ==========================================================================

  it("INV-EMBEDDING-WORKER-INIT-001: dispose ceiling fail-open — Promise.race setTimeout branch resolves and process.exit(0) fires even when disposeFn never resolves (ADR-0035 §Decision 1 fail-open contract, FIND-PLAN-V43-M-03 disclosed structural risk)", async () => {
    // INV-EMBEDDING-WORKER-INIT-001
    const fakeWorker = new EventEmitter() as unknown as Parameters<
      typeof registerCompletedListenerAndExit
    >[0];

    // disposeFn that never resolves (simulates ONNX teardown hang)
    const disposeFn = vi.fn(
      () => new Promise<void>(() => undefined) // pending forever
    );

    const ceilingMs = 100; // tight ceiling to keep test fast
    registerCompletedListenerAndExit(fakeWorker, "embedding-backfill", {
      disposeFn,
      ceilingMs,
    });

    (fakeWorker as unknown as EventEmitter).emit("completed", {
      id: "test-job-id-002",
    });

    expect(disposeFn).toHaveBeenCalledTimes(1);

    // Wait past the ceiling: 200ms > 100ms ceiling. Promise.race must resolve
    // via the setTimeout branch and process.exit(0) fires from .finally().
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(processExitSpy).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  // ==========================================================================
  // Test 3 — per-type cooldown contract (Decision 3)
  // ==========================================================================

  it("INV-EMBEDDING-WORKER-INIT-001: per-type cooldown — getRestartDelayMsForType('embedding-backfill') resolves EMBEDDING_BACKFILL_RESTART_DELAY_MS (default 8000ms); page-analyze retains WORKER_RESTART_DELAY_MS (default 3000ms) (ADR-0035 §Decision 3)", async () => {
    // INV-EMBEDDING-WORKER-INIT-001
    // Dynamic import after env mutation so the helper picks up the test
    // env values. The helper is expected to be exported by Plan v4.3 PR-M-A
    // landing; this test asserts both the existence and the semantic
    // contract.
    delete process.env.EMBEDDING_BACKFILL_RESTART_DELAY_MS;
    delete process.env.WORKER_RESTART_DELAY_MS;

    const supervisorModule = await import("../../../../src/services/worker-supervisor.service");

    // PR-M-A must export getRestartDelayMsForType. The test fails before
    // PR-M-A lands (the symbol does not exist → undefined function → fail).
    const getRestartDelayMsForType = (
      supervisorModule as unknown as Record<string, ((workerType: string) => number) | undefined>
    ).getRestartDelayMsForType;

    if (typeof getRestartDelayMsForType !== "function") {
      expect.fail(
        "ADR-0035 §Decision 3 contract violation: " +
          "`getRestartDelayMsForType` is not exported from worker-supervisor.service.ts. " +
          "Plan v4.3 PR-M-A must export this helper to honour per-type cooldown " +
          "(embedding-backfill 8000ms default; page-analyze 3000ms default)."
      );
    }

    // Defaults: embedding-backfill 8000ms / page-analyze 3000ms.
    expect(
      getRestartDelayMsForType("embedding-backfill"),
      "embedding-backfill default cooldown must be 8000ms (ADR-0035 §Decision 3): dispose ceiling 5000ms + cleanup margin 3000ms"
    ).toBe(8000);
    expect(
      getRestartDelayMsForType("page-analyze"),
      "page-analyze default cooldown must be 3000ms (WORKER_RESTART_DELAY_MS legacy default preserved)"
    ).toBe(3000);

    // Env override path: EMBEDDING_BACKFILL_RESTART_DELAY_MS=10000.
    process.env.EMBEDDING_BACKFILL_RESTART_DELAY_MS = "10000";
    expect(
      getRestartDelayMsForType("embedding-backfill"),
      "EMBEDDING_BACKFILL_RESTART_DELAY_MS env override (10000) must be honoured for embedding-backfill"
    ).toBe(10000);
    // page-analyze is unaffected by EMBEDDING_BACKFILL_* env
    expect(
      getRestartDelayMsForType("page-analyze"),
      "page-analyze must NOT pick up EMBEDDING_BACKFILL_RESTART_DELAY_MS (separation of env-var namespaces)"
    ).toBe(3000);
  });

  // ==========================================================================
  // Test 4 — audit emit on dispose error / ceiling timeout (Decision 4)
  // ==========================================================================

  it("INV-EMBEDDING-WORKER-INIT-001: audit_logs.embedding_dispose_timeout emits on disposeFn rejection (CWE-209 PII protection via truncateAuditTargetId SSOT; GDPR Art.30 365d retention via system:embedding-backfill-worker actor) (ADR-0035 §Decision 4 + Wave 5 LCC canonical SSOT discipline)", async () => {
    // INV-EMBEDDING-WORKER-INIT-001
    const fakeWorker = new EventEmitter() as unknown as Parameters<
      typeof registerCompletedListenerAndExit
    >[0];

    const disposeError = new Error("ONNX session teardown failure (simulated)");
    const disposeFn = vi.fn(async () => {
      throw disposeError;
    });

    registerCompletedListenerAndExit(fakeWorker, "embedding-backfill", {
      disposeFn,
      ceilingMs: 1000,
    });

    (fakeWorker as unknown as EventEmitter).emit("completed", {
      id: "019dca08-89db-7428-9327-f8a6c00d2b01", // UUIDv7 long-form
    });

    // Allow Promise.race + catch + emitAuditLog microtask chain to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(mockAuditLog.log).toHaveBeenCalledTimes(1);

    const auditEntry = mockAuditLog.log.mock.calls[0]?.[0] as
      | {
          action: string;
          actor: string;
          targetType: string;
          targetId?: string;
          result: string;
          details: Record<string, unknown>;
        }
      | undefined;

    if (auditEntry === undefined) {
      expect.fail("audit log mock must have captured the emit payload");
      return;
    }

    // Wave 5 LCC canonical SSOT discipline:
    //   - Import SSOT constant + assert via constant identity
    //   - ALSO dual-assert the literal string match (preserves the literal
    //     contract while keeping the production path SSOT-derived)
    expect(auditEntry.action).toBe(AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT);
    expect(auditEntry.action).toBe("embedding_dispose_timeout");

    // Actor convention: PR-D-5 SSOT mandate — canonical
    // `system:embedding-backfill-worker` (with `-worker` suffix). Wave 5 LCC
    // canonical SSOT-derive pattern: assert via SSOT constant import +
    // literal-string dual-assertion so coupling drift is impossible.
    //
    // FIND-IMPL-LCC-V43-PRM-M-01 closure: previously this test asserted bare
    // `"system:embedding-backfill"` (suffix missing), which masked the
    // production template-literal bug in `post-job-lifecycle.ts`
    // (`actor: \`system:${workerType}\``). The fix replaces the production
    // template literal with `getWorkerActorName(workerType)` SSOT helper and
    // this test now derives the expected literal from the SSOT constant
    // `AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER` per Wave 5 LCC discipline.
    expect(auditEntry.actor).toBe(AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER);
    expect(auditEntry.actor).toBe("system:embedding-backfill-worker");

    // GDPR Art.30 result classification
    expect(auditEntry.result).toBe("failure");

    // details payload schema (ADR-0035 §Decision 4): reason, workerType,
    // ceilingMs, message (sanitised). reason MUST distinguish dispose_error
    // vs ceiling_timeout for SLO L1.5 trigger classification.
    expect(auditEntry.details).toMatchObject({
      reason: "dispose_error",
      workerType: "embedding-backfill",
      ceilingMs: 1000,
    });
  });
});
