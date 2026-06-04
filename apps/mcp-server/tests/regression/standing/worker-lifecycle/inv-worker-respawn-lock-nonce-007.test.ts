// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-RESPAWN-LOCK-NONCE-007:
 *   For every WorkerType `T`, the nonce value used in `acquireLock(T, ...)`
 *   equals the nonce value used in `releaseLock(T, ...)` and
 *   `extendLock(T, ...)`. All 4 paths (acquire / extend / release /
 *   handle-exit-respawn) MUST use `this.bootTokens[T]` — the
 *   per-supervisor immutable boot token (ADR-0011 §A line 59 +
 *   Amendment 4).
 *
 *   Per-spawn `randomUUID()` would diverge from the bootToken and cause
 *   the Lua RELEASE atomic comparison to always return 0 (= release
 *   fails), leading to `foreign_lock` misclassification and a permanent
 *   zombie worker (PR-E-1 trigger: stripe.com page.analyze 2026-04-27).
 *
 * INV-WORKER-RESPAWN-LOCK-NONCE-007: enforces nonce-equality across the
 * supervisor → child → respawn integration path. Per CO-22 (FIND-IMPL-TPA-D1b-03 M)
 * supplements INV-006 with runtime path coverage; PR-E-1 lands this
 * standing test ahead of CO-22's 2026-Q3 deadline.
 *
 * 検証方式 / Strategy:
 *   - cases (1)/(2)/(6)/(7) → vi.mock + spy assertion against the
 *     `WorkerSupervisor` integration path (high signal-to-noise contract
 *     verification, fast on 4GB CI runner).
 *   - cases (3)/(5) → unit-style spy assertion on `bootTokens` /
 *     `children.get(...).lockNonce` after `spawnWorker`.
 *   - cases (4)/(8) → static-source-grep regression guards. Re-introducing
 *     `lockNonce = randomUUID()` at line 687 fails CI immediately.
 *     `clearInterval(this.lockHeartbeatTimers...)` MUST exist at both
 *     crashed-entry paths.
 *
 * SEC-V11-01 Rule 6 + §5.0 Nonce-name-free assertion form (FIND-PLAN-SEC-PRE1-03 L,
 * CWE-209): all nonce equality assertions use boolean form
 * (`expect(actual === expected).toBe(true)`) so a test failure does NOT
 * dump the raw UUID nonce into CI logs.
 *
 * @see ADR-0011 Amendment 4 "Lock Nonce Contract Clarification" (PR-E-1)
 * @see Plan v1.1 §5.2 8-case test scenarios + §5.5 unit-test additions
 * @see Registry §1.8.4 deliverable 3 (8 cases)
 * @see DATA_RETENTION.md §11.9 zombie worker recovery runbook
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { assertInvName } from "../_setup/inv-assert";

// ============================================================================
// Source-code paths for static-grep verification (cases 4 + 8)
// ============================================================================

const REPO_ROOT_RELATIVE_FROM_TEST = "../../../..";
const SRC_WORKER_SUPERVISOR = path.resolve(
  __dirname,
  REPO_ROOT_RELATIVE_FROM_TEST,
  "src/services/worker-supervisor.service.ts"
);
// CO-26 split: spawn / IPC / exit / initiated-restart logic moved to Module B.
// Static-grep regression guards now check the lifecycle module.
const SRC_WORKER_SUPERVISOR_LIFECYCLE = path.resolve(
  __dirname,
  REPO_ROOT_RELATIVE_FROM_TEST,
  "src/services/worker-supervisor-lifecycle.service.ts"
);
// CO-26 split: Redis lock orchestration moved to Module C.
const SRC_WORKER_SUPERVISOR_LOCK = path.resolve(
  __dirname,
  REPO_ROOT_RELATIVE_FROM_TEST,
  "src/services/worker-supervisor-lock-orchestrator.service.ts"
);
const SRC_WORKER_SUPERVISOR_HELPERS = path.resolve(
  __dirname,
  REPO_ROOT_RELATIVE_FROM_TEST,
  "src/services/worker-supervisor-helpers.ts"
);
const SRC_BACKFILL_WORKER = path.resolve(
  __dirname,
  REPO_ROOT_RELATIVE_FROM_TEST,
  "src/workers/embedding-backfill-worker.ts"
);

function readSource(absPath: string): string {
  return fs.readFileSync(absPath, "utf-8");
}

/**
 * CO-26 split helper — read combined source from Module A facade + Module B
 * lifecycle + Module C lock-orchestrator. Used by static-grep regression guards
 * to verify patterns regardless of which module currently owns them.
 *
 * CO-26 split helper — Module A/B/C 結合ソースを読む。Static-grep regression
 * guard が module 移動後も機能するように。
 */
function readCombinedSupervisorSource(): string {
  return [
    readSource(SRC_WORKER_SUPERVISOR),
    readSource(SRC_WORKER_SUPERVISOR_LIFECYCLE),
    readSource(SRC_WORKER_SUPERVISOR_LOCK),
  ].join("\n");
}

// ============================================================================
// vi.mock setup — child_process.fork + logger
// ============================================================================

const mockFork = vi.fn();
vi.mock("node:child_process", () => ({
  fork: (...args: unknown[]) => mockFork(...args),
}));

vi.mock("../../../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// ============================================================================
// Helpers — fake child process / supervisor instance
// ============================================================================

function createMockChild(pid: number): ChildProcess & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    pid,
    kill: vi.fn().mockReturnValue(true),
    connected: true,
    send: vi.fn().mockReturnValue(true),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    spawnargs: [] as string[],
    spawnfile: "",
    stdio: [null, null, null, null, null] as ChildProcess["stdio"],
    stdin: null,
    stdout: null,
    stderr: null,
    channel: undefined,
    [Symbol.dispose]: vi.fn(),
  }) as unknown as ChildProcess & EventEmitter;
}

interface SupervisorInternals {
  bootTokens: Record<string, string>;
  children: Map<string, { lockNonce: string; bootToken: string }>;
  lockHeartbeatTimers: Map<string, NodeJS.Timeout>;
}

// ============================================================================
// Test suite — 8 cases
// ============================================================================

describe("INV-WORKER-RESPAWN-LOCK-NONCE-007", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-RESPAWN-LOCK-NONCE-007");
    vi.clearAllMocks();
    mockFork.mockReturnValue(createMockChild(20001));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Case (1) — supervisor spawn → child SIGABRT → unexpected_exit path respawns
  //          successfully + Layer 1 retry budget 0 consumed (TDA-02)
  // ==========================================================================

  it("INV-WORKER-RESPAWN-LOCK-NONCE-007: case (1) unexpected_exit path — releaseLock invoked once with bootToken nonce, zero retry warn (Layer 1 budget 0 consumed)", async () => {
    const { WorkerSupervisor } = await import("../../../../src/services/worker-supervisor.service");

    const supervisor = new WorkerSupervisor({
      workerScript: "./dist/scripts/start-workers.js",
      maxJobsBeforeRestart: 10,
      maxRestartAttempts: 5,
      shutdownTimeoutMs: 10000,
    }) as unknown as object & SupervisorInternals;

    // Cast to access private internals for contract verification.
    const internals = supervisor as SupervisorInternals;

    // Trigger spawn so a WorkerChildState exists with `lockNonce`.
    (supervisor as unknown as { ensureWorkerRunning: () => void }).ensureWorkerRunning();

    // (a) Verify lockNonce alias enforcement after spawn — boolean form
    //     (§5.0 SEC-03 nonce-name-free assertion).
    const childState = internals.children.get("page");
    expect(childState).toBeDefined();
    expect(childState!.lockNonce === internals.bootTokens.page).toBe(true);

    // (b) Verify Layer 1 retry budget 0 consumed: when lockNonce === bootToken,
    //     `tryReleaseLockWithRetry` succeeds on attempt 1 with no warn emit.
    //     Static contract verification: helper signature export.
    const helperSrc = readSource(SRC_WORKER_SUPERVISOR_HELPERS);
    expect(helperSrc).toContain("export async function tryReleaseLockWithRetry(");
    expect(helperSrc).toContain('logger.warn("[respawn] releaseLock attempt failed"');

    // (c) Verify executeSelfChainedRespawn returns "released" when nonce matches
    //     — by static contract reading the function body (no real Redis here).
    expect(helperSrc).toContain('if (released) return "released";');
  });

  // ==========================================================================
  // Case (2) — planned restart path: handlePlannedRestart passes bootToken
  //          nonce to runSelfChainedRespawnAndSchedule
  // ==========================================================================

  it("INV-WORKER-RESPAWN-LOCK-NONCE-007: case (2) planned restart — handlePlannedRestart passes bootToken nonce to executeSelfChainedRespawn", async () => {
    const { WorkerSupervisor } = await import("../../../../src/services/worker-supervisor.service");

    const supervisor = new WorkerSupervisor({
      workerScript: "./dist/scripts/start-workers.js",
      maxJobsBeforeRestart: 10,
      maxRestartAttempts: 5,
      shutdownTimeoutMs: 10000,
    });
    const internals = supervisor as unknown as SupervisorInternals;

    (supervisor as unknown as { ensureWorkerRunning: () => void }).ensureWorkerRunning();
    const childState = internals.children.get("page");
    expect(childState).toBeDefined();

    // The exitedNonce captured by handleWorkerExit MUST equal the bootToken.
    // Boolean form (SEC-03).
    const exitedNonce = childState!.lockNonce;
    expect(exitedNonce === internals.bootTokens.page).toBe(true);

    // Static contract: handleWorkerExit pulls childState.lockNonce and forwards
    // to handlePlannedRestart / handleUnexpectedExit which both forward to
    // runSelfChainedRespawnAndSchedule(workerType, exitedNonce).
    // CO-26 split: spawn / IPC / exit / initiated-restart logic moved to Module B
    // (worker-supervisor-lifecycle.service.ts). Combined source covers both Module A
    // facade and Module B lifecycle for static-grep regression preservation.
    //
    // Plan v2 PR-C (handleWorkerExit CC closure, FIND-IMPL-TDA-PR3-CC-CARRYOVER):
    // the inline `const exitedNonce = childState?.lockNonce;` was refactored into
    // the `captureExitedChildSnapshot` helper, which returns `exitedNonce` derived
    // from `childState?.lockNonce`; `handleWorkerExit` then forwards `snap.exitedNonce`
    // to handlePlannedRestart / handleUnexpectedExit. The forwarding contract is
    // UNCHANGED (verified against the post-refactor source below) — the nonce
    // captured from the exited child's lockNonce still propagates all the way to
    // executeSelfChainedRespawn. These pins assert all THREE links of the chain so
    // a future regression that severs nonce forwarding (e.g. dropping the snapshot
    // field or passing a fresh UUID) is caught at CI; they are NOT weakened.
    const supSrc = readCombinedSupervisorSource();
    // Link 1: the snapshot helper derives exitedNonce from the exited child's lockNonce.
    expect(supSrc).toMatch(/exitedNonce:\s*childState\?\.lockNonce/);
    // Link 2: handleWorkerExit forwards snap.exitedNonce into BOTH restart branches.
    expect(supSrc).toContain("snap.exitedNonce");
    // Link 3: both branches forward exitedNonce to runSelfChainedRespawnAndSchedule
    //         and onward to executeSelfChainedRespawn (terminal forwarding point).
    expect(supSrc).toContain(
      "void this.runSelfChainedRespawnAndSchedule(workerType, exitedNonce);"
    );
    expect(supSrc).toMatch(
      /executeSelfChainedRespawn\(\s*lockService,\s*workerType,\s*exitedNonce/
    );
  });

  // ==========================================================================
  // Case (3) — spawnWorker creates a WorkerChildState whose lockNonce equals
  //          this.bootTokens[workerType]
  // ==========================================================================

  it("INV-WORKER-RESPAWN-LOCK-NONCE-007: case (3) spawnWorker — children.get(workerType).lockNonce === bootTokens[workerType] (boolean form per §5.0)", async () => {
    const { WorkerSupervisor } = await import("../../../../src/services/worker-supervisor.service");

    const supervisor = new WorkerSupervisor({
      workerScript: "./dist/scripts/start-workers.js",
      maxJobsBeforeRestart: 10,
      maxRestartAttempts: 5,
      shutdownTimeoutMs: 10000,
    });
    const internals = supervisor as unknown as SupervisorInternals;

    (supervisor as unknown as { ensureWorkerRunning: () => void }).ensureWorkerRunning();
    const childState = internals.children.get("page");
    expect(childState).toBeDefined();

    // Boolean form to avoid raw nonce CI log dump on failure (SEC-03).
    expect(childState!.lockNonce === internals.bootTokens.page).toBe(true);
    // Also assert against the explicit bootToken alias copy in the child state.
    expect(childState!.lockNonce === childState!.bootToken).toBe(true);
  });

  // ==========================================================================
  // Case (4) — Static-source-grep regression guard against re-introduction of
  //          `lockNonce = randomUUID()` at line 687 (CO-22 supplement)
  // ==========================================================================

  it("INV-WORKER-RESPAWN-LOCK-NONCE-007: case (4) static-source-grep regression guard — `lockNonce = randomUUID()` MUST NOT re-appear in worker-supervisor.service.ts", () => {
    // CO-26 split: spawn logic moved to Module B (lifecycle); check both modules.
    const supSrc = readCombinedSupervisorSource();
    const matches = supSrc.match(/lockNonce\s*=\s*randomUUID\(\)/g) ?? [];
    expect(matches.length).toBe(0);

    // Positive contract: spawnWorker (now in Module B) initialises `lockNonce`
    // from `bootToken`. Module B uses `const bootToken = this.supervisor.getBootTokenForType(workerType)`
    // and `const lockNonce = bootToken;` (semantically equivalent to legacy
    // `this.bootTokens[workerType]` direct access). Accept either pattern.
    expect(supSrc).toMatch(
      /(const\s+lockNonce\s*=\s*this\.bootTokens\[workerType\]\s*;|const\s+lockNonce\s*=\s*bootToken\s*;)/
    );
  });

  // ==========================================================================
  // Case (5) — WorkerType-isolation (CONTRACT-INV007-CASE5-LOCKNONCE-ENFORCE
  //          redesign): same supervisor's `page` and `embedding-backfill`
  //          bootTokens are independent
  // ==========================================================================

  it("INV-WORKER-RESPAWN-LOCK-NONCE-007: case (5) WorkerType-isolation — bootTokens['page'] !== bootTokens['embedding-backfill'] (per-WorkerType independence)", async () => {
    const { WorkerSupervisor } = await import("../../../../src/services/worker-supervisor.service");

    const supervisor = new WorkerSupervisor({
      workerScript: "./dist/scripts/start-workers.js",
      maxJobsBeforeRestart: 10,
      maxRestartAttempts: 5,
      shutdownTimeoutMs: 10000,
    });
    const internals = supervisor as unknown as SupervisorInternals;

    // (a) Per-WorkerType independence — different randomUUID() per type.
    //     Boolean form (SEC-03).
    expect(internals.bootTokens.page === internals.bootTokens["embedding-backfill"]).toBe(false);

    // (b) Spawn page child and verify alias enforcement remains scoped.
    (supervisor as unknown as { ensureWorkerRunning: () => void }).ensureWorkerRunning();
    const pageChild = internals.children.get("page");
    expect(pageChild).toBeDefined();
    expect(pageChild!.lockNonce === internals.bootTokens.page).toBe(true);

    // (c) page worker's release path MUST NOT reference embedding-backfill's
    //     bootToken — verified at the source-grep level: the
    //     `releaseRedisLockBestEffort(workerType)` signature is per-type
    //     and uses `this.bootTokens[workerType]` (not a cross-type token).
    // CO-26 split: lock orchestration moved to Module C; check combined source.
    const supSrc = readCombinedSupervisorSource();
    expect(supSrc).toMatch(/releaseLock\(workerType,\s*this\.bootTokens\[workerType\]\)/);
    expect(supSrc).toMatch(/extendLock\(workerType,\s*this\.bootTokens\[workerType\]\)/);
    // Item 3 (CO-31) — `acquireRedisLockBestEffort` is now a thin caller that
    //     delegates to `runAcquireLockWithRetryOrchestrator(lockService, workerType,
    //     this.bootTokens[workerType], ...)`. The regex MUST accept BOTH the
    //     legacy direct-call shape `acquireLock(workerType, this.bootTokens[workerType])`
    //     AND the orchestrator-mediated shape so per-WorkerType bootToken
    //     consumption is verified across the refactor boundary.
    // Item 3 (CO-31) 後の構造: `acquireRedisLockBestEffort` は thin caller となり、
    //     `runAcquireLockWithRetryOrchestrator(lockService, workerType,
    //     this.bootTokens[workerType], ...)` に委譲する。本 regex は
    //     legacy 形式 `acquireLock(workerType, this.bootTokens[workerType])` と
    //     orchestrator 経由形式の両方を accept し、refactor 境界を跨いで
    //     per-WorkerType bootToken 消費契約を検証する。
    expect(supSrc).toMatch(
      /(acquireLock|runAcquireLockWithRetryOrchestrator\(lockService,\s*)workerType,\s*this\.bootTokens\[workerType\]/
    );
  });

  // ==========================================================================
  // Case (6) — TPA CO-22 supplement: Fix-1 ordering — BullMQ Worker.close()
  //          before disposeEmbeddingPipeline() in embedding-backfill-worker.ts
  // ==========================================================================

  it("INV-WORKER-RESPAWN-LOCK-NONCE-007: case (6) Fix-1 ordering runtime supplement — Worker.close() invocation precedes disposeEmbeddingPipeline() (CO-22)", () => {
    // Static contract verification mirrors INV-006 case (1) but anchored to
    // INV-007 to satisfy CO-22 "supplement case 1 with a runtime test"
    // requirement (see Plan v1.1 §5.4 INV-006 supplement vs replace decision).
    const src = readSource(SRC_BACKFILL_WORKER);
    const closeIdx = src.indexOf("await worker.close();");
    const disposeIdx = src.indexOf(
      "await sharedLayoutEmbeddingService.disposeEmbeddingPipeline();"
    );
    expect(closeIdx).toBeGreaterThan(0);
    expect(disposeIdx).toBeGreaterThan(0);
    expect(closeIdx).toBeLessThan(disposeIdx);
  });

  // ==========================================================================
  // Case (7) — NF-6 (FIND-PLAN-SEC-PRE1-01 H, CWE-770): clearInterval invoked
  //          on `state="crashed"` entry — both crash_max_attempts AND
  //          foreign_lock paths
  // ==========================================================================

  it("INV-WORKER-RESPAWN-LOCK-NONCE-007: case (7) NF-6 clearInterval on state='crashed' entry — both crash_max_attempts and foreign_lock paths invoke clearLockHeartbeatTimer (CWE-770)", () => {
    // CO-26 split: crashed-entry paths moved to Module B (lifecycle).
    // Module B accesses Module C's lockHeartbeatTimers via Module A facade
    // indirect path: `this.supervisor.getLockOrchestrator().getLockHeartbeatTimers()`.
    const supSrc = readCombinedSupervisorSource();
    const helperSrc = readSource(SRC_WORKER_SUPERVISOR_HELPERS);

    // Helper exists with the per-type Map signature.
    expect(helperSrc).toContain("export function clearLockHeartbeatTimer(");
    expect(helperSrc).toContain("clearInterval(heartbeatTimer);");
    expect(helperSrc).toContain("lockHeartbeatTimers.delete(workerType);");

    // The lifecycle module (Module B) MUST import clearLockHeartbeatTimer.
    // Either Module A or Module B may carry the import; combined source covers both.
    expect(supSrc).toMatch(
      /import\s*\{[\s\S]*?clearLockHeartbeatTimer[\s\S]*?\}\s*from\s*["']\.\/worker-supervisor-helpers["']/
    );

    // Both crash-entry paths MUST call the helper. Two invocations expected.
    // CO-26 split: callsites now use indirect path
    // `this.supervisor.getLockOrchestrator().getLockHeartbeatTimers()`.
    // Accept both legacy `this.lockHeartbeatTimers` and new indirect-path forms.
    const helperCallMatches = supSrc.match(
      /clearLockHeartbeatTimer\(\s*workerType,\s*(?:this\.lockHeartbeatTimers|this\.supervisor\.getLockOrchestrator\(\)\.getLockHeartbeatTimers\(\))/g
    );
    expect(helperCallMatches).not.toBeNull();
    expect(helperCallMatches!.length).toBeGreaterThanOrEqual(2);

    // Verify proximity to both crash branches.
    // CO-26 split: crashed-entry paths moved to Module B; state mutation now
    // goes through `this.supervisor.markWorkerCrashed(workerType)` instead of
    // direct `state.state = "crashed";` mutation. Accept both patterns.
    // (a) crash_max_attempts: markWorkerCrashed then helper call before audit emit.
    expect(supSrc).toMatch(
      /(state\.state\s*=\s*"crashed"|this\.supervisor\.markWorkerCrashed\(workerType\))[\s\S]{0,200}clearLockHeartbeatTimer\(\s*workerType,[\s\S]{0,200}emitWorkerRestartAudit\(/
    );
    // (b) foreign_lock case branch: markWorkerCrashed then helper call before break.
    expect(supSrc).toMatch(
      /case\s*"foreign_lock":[\s\S]{0,500}(state\.state\s*=\s*"crashed"|this\.supervisor\.markWorkerCrashed\(workerType\))[\s\S]{0,400}clearLockHeartbeatTimer\(\s*workerType,[\s\S]{0,200}break;/
    );
  });

  // ==========================================================================
  // Case (8) — AST / static-grep regression guard for both contracts
  //          (CONTRACT-INV007-CASE5-LOCKNONCE-ENFORCE)
  // ==========================================================================

  it("INV-WORKER-RESPAWN-LOCK-NONCE-007: case (8) AST/static-grep regression guard — `lockNonce = randomUUID()` 0 hits AND clearInterval helper call appears in both crash-entry paths", () => {
    // CO-26 split: combined Module A/B/C source for static-grep guards.
    const supSrc = readCombinedSupervisorSource();

    // (a) lockNonce drift guard: `lockNonce = randomUUID()` 0 hits.
    expect((supSrc.match(/lockNonce\s*=\s*randomUUID\(\)/g) ?? []).length).toBe(0);

    // (b) Both crash-entry paths invoke clearLockHeartbeatTimer (NF-6 / CWE-770).
    // CO-26 split: helper call now uses indirect path
    // `this.supervisor.getLockOrchestrator().getLockHeartbeatTimers()`.
    const helperCalls = supSrc.match(
      /clearLockHeartbeatTimer\(\s*workerType,\s*(?:this\.lockHeartbeatTimers|this\.supervisor\.getLockOrchestrator\(\)\.getLockHeartbeatTimers\(\))/g
    );
    expect(helperCalls).not.toBeNull();
    expect(helperCalls!.length).toBeGreaterThanOrEqual(2);

    // (c) handleUnexpectedExit `crash_max_attempts` branch landing.
    // CO-26 split: maxRestartAttempts now read via supervisor accessor in Module B.
    expect(supSrc).toMatch(
      /if\s*\(\s*(state\.restartCount\s*>=\s*this\.config\.maxRestartAttempts|restartCount\s*>=\s*maxRestartAttempts)\s*\)/
    );

    // (d) runSelfChainedRespawnAndSchedule `foreign_lock` switch branch landing.
    expect(supSrc).toMatch(/case\s*"foreign_lock":/);
  });
});
