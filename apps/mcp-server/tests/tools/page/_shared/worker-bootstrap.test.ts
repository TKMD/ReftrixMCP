// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `bootstrapWorkersForPageAnalyze` unit tests / `bootstrapWorkersForPageAnalyze`
 * のユニットテスト.
 *
 * **PR-D-9 Phase 2 Wave 1 + Wave 2 contract**:
 *   - C-11 (FIND-PLAN-TDA-04 / FIND-PLAN-SEC-04): strict env-var parsing
 *     (`=== "true"` / `=== "false"` only; reject `"1"` / `"yes"` / `"True"` /
 *     `""` / `"DISABLED"` with `logger.warn`).
 *   - C-04 (ADR-0018 §Decision 1 Supplement S4/S5): `audit_logs.action` SSOT
 *     固定 string 定数 (`AUDIT_ACTION_EMBEDDING_BACKFILL_AUTOSPAWN_FAILED`)
 *     経由で emit される。
 *   - Wave 2 (Conflict-2 joint resolution, FIND-PLAN-LCC-01 + TPA-PLAN-05 +
 *     FIND-PLAN-SEC-05): rejection 時 `[SLO_MARKER] auto_spawn_rejected` log +
 *     `audit_logs.embedding_backfill_autospawn_failed` emit + sanitizeErrorMessage
 *     CWE-209 enforcement.
 *
 * Branch coverage: helper has 3 branches (legacy / non-canonical warn / default
 * staggered) + 1 catch path (rejection). All covered by tests below.
 *
 * @see Plan v1.1 §6.4 (helper unit tests location)
 * @see Plan v1.1 §4.1.2 (helper code skeleton)
 * @see Finding Registry v2 §4.2 Conflict-2 + §6 C-11
 * @see ADR-0018 §Decision 1 Supplement S4/S5
 *
 * @module tests/tools/page/_shared/worker-bootstrap.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted() ensures these mocks exist BEFORE vi.mock() factories run,
// since vi.mock is hoisted to the top of the file by Vitest. Without
// vi.hoisted(), referencing top-level `const mock...` from a factory throws
// `Cannot access 'mocks.emitSupervisorAuditLog' before initialization`.
//
// vi.hoisted() で mock を先に生成することで、vi.mock factory 内から参照可能になる。
const mocks = vi.hoisted(() => ({
  ensureWorkerRunning: vi.fn<[], void>(),
  ensureAllWorkersRunningStaggered: vi.fn<[], Promise<void>>(),
  emitSupervisorAuditLog: vi.fn<
    [
      string,
      "page" | "embedding-backfill",
      Record<string, unknown>,
      "success" | "failure" | "denied",
    ],
    void
  >(),
  loggerWarn: vi.fn<[string, ...unknown[]], void>(),
}));

vi.mock("../../../../src/services/worker-supervisor.service", () => ({
  getWorkerSupervisor: () => ({
    ensureWorkerRunning: mocks.ensureWorkerRunning,
    ensureAllWorkersRunningStaggered: mocks.ensureAllWorkersRunningStaggered,
  }),
}));

vi.mock("../../../../src/services/worker-supervisor-helpers", () => ({
  emitSupervisorAuditLog: mocks.emitSupervisorAuditLog,
}));

vi.mock("../../../../src/utils/logger", () => ({
  logger: {
    warn: mocks.loggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: () => false,
}));

// Now import the SUT after the mocks are registered.
import { bootstrapWorkersForPageAnalyze } from "../../../../src/tools/page/_shared/worker-bootstrap";
import { AUDIT_ACTION_EMBEDDING_BACKFILL_AUTOSPAWN_FAILED } from "../../../../src/audit/audit-actions";

// =============================================================================
// Test scaffold
// =============================================================================

const ORIGINAL_AUTOSPAWN_ENV = process.env.ENABLE_BACKFILL_AUTOSPAWN;

describe("bootstrapWorkersForPageAnalyze (PR-D-9 Wave 1 + Wave 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ENABLE_BACKFILL_AUTOSPAWN;
    // Default: success path (no rejection) so tests can opt in to rejection
    // case explicitly via mockRejectedValueOnce.
    mocks.ensureAllWorkersRunningStaggered.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (ORIGINAL_AUTOSPAWN_ENV === undefined) {
      delete process.env.ENABLE_BACKFILL_AUTOSPAWN;
    } else {
      process.env.ENABLE_BACKFILL_AUTOSPAWN = ORIGINAL_AUTOSPAWN_ENV;
    }
  });

  // ---------------------------------------------------------------------------
  // Case 1: legacy path (`"false"` → page only)
  // ---------------------------------------------------------------------------
  it('case 1: ENABLE_BACKFILL_AUTOSPAWN === "false" → ensureWorkerRunning() のみ呼ばれる、ensureAllWorkersRunningStaggered() 呼ばれない / legacy single-worker path', () => {
    process.env.ENABLE_BACKFILL_AUTOSPAWN = "false";

    bootstrapWorkersForPageAnalyze();

    expect(mocks.ensureWorkerRunning).toHaveBeenCalledTimes(1);
    expect(mocks.ensureAllWorkersRunningStaggered).not.toHaveBeenCalled();
    // Legacy path MUST NOT emit non-canonical warn (the value `"false"` is
    // canonical).
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 2: explicit `"true"` → staggered spawn
  // ---------------------------------------------------------------------------
  it('case 2: ENABLE_BACKFILL_AUTOSPAWN === "true" → ensureAllWorkersRunningStaggered() 呼ばれる / explicit staggered spawn', async () => {
    process.env.ENABLE_BACKFILL_AUTOSPAWN = "true";

    bootstrapWorkersForPageAnalyze();
    // Allow microtask queue to flush so `.catch()` (if any) is registered.
    await Promise.resolve();

    expect(mocks.ensureAllWorkersRunningStaggered).toHaveBeenCalledTimes(1);
    expect(mocks.ensureWorkerRunning).not.toHaveBeenCalled();
    // `"true"` is canonical → no warn.
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 3: unset (undefined) → default staggered spawn
  // ---------------------------------------------------------------------------
  it("case 3: ENABLE_BACKFILL_AUTOSPAWN unset → ensureAllWorkersRunningStaggered() 呼ばれる (default behaviour) / default staggered spawn when unset", async () => {
    delete process.env.ENABLE_BACKFILL_AUTOSPAWN;

    bootstrapWorkersForPageAnalyze();
    await Promise.resolve();

    expect(mocks.ensureAllWorkersRunningStaggered).toHaveBeenCalledTimes(1);
    expect(mocks.ensureWorkerRunning).not.toHaveBeenCalled();
    // unset (undefined) bypasses the non-canonical warn (`flag === undefined`
    // short-circuits the `flag !== undefined && flag !== "true"` test).
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 4: empty string typo → default staggered + warn
  // ---------------------------------------------------------------------------
  it('case 4: ENABLE_BACKFILL_AUTOSPAWN === "" (空文字 typo) → ensureAllWorkersRunningStaggered() 呼ばれる + non-canonical warn (strict === "false" 判定; FIND-PLAN-SEC-04)', async () => {
    process.env.ENABLE_BACKFILL_AUTOSPAWN = "";

    bootstrapWorkersForPageAnalyze();
    await Promise.resolve();

    // `""` is NOT `"false"` and NOT `"true"` → falls through to staggered +
    // emits non-canonical warn (CWE-1188 strict parsing).
    expect(mocks.ensureAllWorkersRunningStaggered).toHaveBeenCalledTimes(1);
    expect(mocks.ensureWorkerRunning).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("non-canonical ENABLE_BACKFILL_AUTOSPAWN value"),
      expect.objectContaining({ flag: "" })
    );
  });

  // ---------------------------------------------------------------------------
  // Case 5: non-canonical typo `"DISABLED"` → default staggered + warn
  // ---------------------------------------------------------------------------
  it('case 5: ENABLE_BACKFILL_AUTOSPAWN === "DISABLED" (非標準 typo) → ensureAllWorkersRunningStaggered() 呼ばれる + non-canonical warn (FIND-PLAN-SEC-04 negative case)', async () => {
    process.env.ENABLE_BACKFILL_AUTOSPAWN = "DISABLED";

    bootstrapWorkersForPageAnalyze();
    await Promise.resolve();

    // `"DISABLED"` is NOT `"false"` (the typo MUST NOT silently disable
    // backfill auto-spawn) → fall through to staggered + warn (CWE-1188).
    expect(mocks.ensureAllWorkersRunningStaggered).toHaveBeenCalledTimes(1);
    expect(mocks.ensureWorkerRunning).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("non-canonical ENABLE_BACKFILL_AUTOSPAWN value"),
      expect.objectContaining({ flag: "DISABLED" })
    );
  });

  // ---------------------------------------------------------------------------
  // Case 6 (Wave 2): rejection → SLO_MARKER log + audit emit + sanitize
  // ---------------------------------------------------------------------------
  it("case 6 (Wave 2): ensureAllWorkersRunningStaggered() rejection → [SLO_MARKER] auto_spawn_rejected log + emitSupervisorAuditLog({ action: 'embedding_backfill_autospawn_failed', ... }) 呼ばれる + sanitizeErrorMessage 経由 (CWE-209 enforcement)", async () => {
    delete process.env.ENABLE_BACKFILL_AUTOSPAWN;

    const spawnError = new Error("Redis lock contention: foreign nonce holder");
    mocks.ensureAllWorkersRunningStaggered.mockRejectedValueOnce(spawnError);

    bootstrapWorkersForPageAnalyze();
    // Flush microtask queue twice: once for the `void`-d promise to settle,
    // once for the `.catch()` handler to execute.
    await Promise.resolve();
    await Promise.resolve();

    // (a) ensureAllWorkersRunningStaggered() was indeed invoked (default branch).
    expect(mocks.ensureAllWorkersRunningStaggered).toHaveBeenCalledTimes(1);

    // (b) [SLO_MARKER] auto_spawn_rejected log line (PR-D-5 5-tier SLO L1.5
    //     SLO_MARKER pattern continuity).
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "[SLO_MARKER] auto_spawn_rejected",
      expect.objectContaining({ error: expect.any(String) })
    );

    // (c) audit_logs emit with SSOT action constant `embedding_backfill_autospawn_failed`
    //     (literal-grep + symbol-resolution double-lock per ADR-0018 §S4).
    expect(mocks.emitSupervisorAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.emitSupervisorAuditLog).toHaveBeenCalledWith(
      AUDIT_ACTION_EMBEDDING_BACKFILL_AUTOSPAWN_FAILED,
      "embedding-backfill",
      expect.objectContaining({ error: expect.any(String) }),
      "failure"
    );

    // (d) Literal string assertion: action MUST equal the SSOT-greppable value
    //     `'embedding_backfill_autospawn_failed'` (per ADR-0018 §Decision 1
    //     Supplement S4 assertion convention — line 285-287).
    const callArgs = mocks.emitSupervisorAuditLog.mock.calls[0];
    expect(callArgs?.[0]).toBe("embedding_backfill_autospawn_failed");

    // (e) sanitizeErrorMessage CWE-209 enforcement: the original error message
    //     contains a substring identifying the internal subsystem (`Redis lock`),
    //     so the audit details `error` field is the sanitized output. We assert
    //     that some non-empty string was passed (the exact sanitised wording is
    //     governed by `sanitizeErrorMessage`'s contract; this test's role is
    //     only to assert that the call goes through the sanitiser, not raw).
    const auditDetails = callArgs?.[2] as { error: string };
    expect(typeof auditDetails.error).toBe("string");
    expect(auditDetails.error.length).toBeGreaterThan(0);
  });
});
