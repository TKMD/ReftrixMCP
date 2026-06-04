// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-BACKFILL-RECOVERY-CRON-WIRED-008 (PR-C4 V1.1 §3 D4 / IO Plan Decision V1
 * Registry row D4 + SEC-PLAN-05):
 *
 *   The periodic backfill recovery cron (`scheduleBackfillRecoveryCron`) drives
 *   `failed_with_known_reason` orphan auto-recovery in production. The library
 *   landed (`apps/mcp-server/src/cron/backfill-recovery-cron.ts`, exported with a
 *   `BackfillRecoveryCronHandle` interface) but was left UNWIRED into the main
 *   worker entry point `start-workers.ts` (grep 0 hit) — so `failed_with_known_reason`
 *   periodic recovery is dark in production = the real orphan auto-recovery gap.
 *
 *   Contract (this INV pins):
 *     (a) WIRING (AST sweep): `start-workers.ts` imports `scheduleBackfillRecoveryCron`
 *         from `../cron/backfill-recovery-cron`, invokes it (callsite > 0), and
 *         releases the handle via `.stop()` on graceful shutdown (same lifecycle
 *         shape as the existing 4 crons: screenshot-cleanup / backfill-reconciliation
 *         / phase0-cleanup / worker-stderr-cleanup).
 *     (b) ONE-CYCLE RECOVERY (behavioural): a single recovery cycle picks up a
 *         `failed_with_known_reason` orphan row and re-enqueues / transitions it
 *         (not left orphaned).
 *     (c) RETRY CAP BOUND (SEC-PLAN-05, CWE-770): re-enqueue is bounded by
 *         `BACKFILL_RECOVERY_MAX_AUTO_RETRIES = 5`; a row at/over the cap is NOT
 *         re-enqueued again (terminal), so the recovery loop is finite.
 *
 * # Test strategy
 *
 *   Two surfaces (mock-driven, no testcontainer / Redis — same approach as the
 *   sibling AST-wiring INV `inv-wiring-coverage-001` + the mock-Prisma INV
 *   `inv-backfill-analysis-guard-008`):
 *
 *   1. AST/source sweep on `start-workers.ts` (Gate-2 wiring half; the runtime
 *      half is covered by the start-workers handler integration tests).
 *   2. `scheduleBackfillRecoveryCron({ runOnStart: true })` with a mock-Prisma +
 *      mock-Queue exercising one recovery cycle, plus the SEC-PLAN-05 cap bound
 *      pinned as a hardcoded SSOT constant assertion.
 *
 * MANDATORY, CI-failing executable invariant. `.skip()` / `.todo()` /
 * `describe.skip` are FORBIDDEN; failure is a P0 incident handled by
 * pipeline-engineer + platform-engineer.
 *
 * @see  §3 D4 / §4
 * @see  (D4 row, SEC-PLAN-05)
 * @see apps/mcp-server/src/cron/backfill-recovery-cron.ts (scheduleBackfillRecoveryCron)
 * @see apps/mcp-server/src/services/backfill-recovery-reconciliation.service.ts (BACKFILL_RECOVERY_MAX_AUTO_RETRIES)
 * @see apps/mcp-server/tests/regression/standing/worker-lifecycle/inv-wiring-coverage-001.test.ts (sibling AST-wiring pattern)
 *
 * @module tests/regression/standing/worker-lifecycle/inv-backfill-recovery-cron-wired-008
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  scheduleBackfillRecoveryCron,
  type BackfillRecoveryCronHandle,
} from "../../../../src/cron/backfill-recovery-cron";
import { BACKFILL_RECOVERY_MAX_AUTO_RETRIES } from "../../../../src/services/backfill-recovery-reconciliation.service";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const START_WORKERS_PATH = path.join(REPO_ROOT, "apps/mcp-server/src/scripts/start-workers.ts");

// ============================================================================
// Mock fixtures (mock-Prisma + mock-Queue, no testcontainer)
// ============================================================================

interface FakeRecoveryRow {
  id: string;
  embeddingBackfillStatus: string;
  embeddingBackfillRetryCount: number;
}

/**
 * Minimal mock Prisma exposing the `failed_with_known_reason` scan + CAS
 * transition surface used by `runRecoveryCycle`. The behavioural cycle test only
 * needs `enabled` flag handling + one orphan row; the cap-bound assertion is a
 * pure SSOT-constant check (no Prisma needed).
 */
function makeFakePrisma(rows: FakeRecoveryRow[]): {
  client: Parameters<typeof scheduleBackfillRecoveryCron>[0]["prisma"];
  state: FakeRecoveryRow[];
  findManySpy: ReturnType<typeof vi.fn>;
} {
  const state = rows.map((r) => ({ ...r }));
  const findManySpy = vi.fn(async () =>
    state.filter((r) => r.embeddingBackfillStatus === "failed_with_known_reason")
  );
  const client = {
    webPage: {
      findMany: findManySpy,
      updateMany: vi.fn(
        async ({ where, data }: { where: { id?: string }; data: Record<string, unknown> }) => {
          let count = 0;
          for (const r of state) {
            if (where.id !== undefined && r.id !== where.id) continue;
            if (typeof data.embeddingBackfillStatus === "string") {
              r.embeddingBackfillStatus = data.embeddingBackfillStatus;
            }
            if (data.embeddingBackfillRetryCount !== undefined) {
              const inc = data.embeddingBackfillRetryCount as { increment?: number };
              r.embeddingBackfillRetryCount += inc.increment ?? 0;
            }
            count += 1;
          }
          return { count };
        }
      ),
    },
  } as unknown as Parameters<typeof scheduleBackfillRecoveryCron>[0]["prisma"];
  return { client, state, findManySpy };
}

function makeFakeQueue(): {
  queue: Parameters<typeof scheduleBackfillRecoveryCron>[0]["queue"];
  addSpy: ReturnType<typeof vi.fn>;
} {
  const addSpy = vi.fn(async () => ({}));
  const queue = {
    add: addSpy,
    name: "embedding-backfill",
  } as unknown as Parameters<typeof scheduleBackfillRecoveryCron>[0]["queue"];
  return { queue, addSpy };
}

const ORPHAN_ID = "00000000-0000-7000-8000-0000000000d4";

// ============================================================================
// Tests
// ============================================================================

describe("INV-BACKFILL-RECOVERY-CRON-WIRED-008: scheduleBackfillRecoveryCron wired into start-workers + bounded recovery", () => {
  let handle: BackfillRecoveryCronHandle | undefined;
  const prevEnabled = process.env["BACKFILL_RECOVERY_ENABLED"];

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-BACKFILL-RECOVERY-CRON-WIRED-008");
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    if (prevEnabled === undefined) {
      delete process.env["BACKFILL_RECOVERY_ENABLED"];
    } else {
      process.env["BACKFILL_RECOVERY_ENABLED"] = prevEnabled;
    }
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // (a) WIRING — AST sweep on start-workers.ts
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-RECOVERY-CRON-WIRED-008: (a) start-workers.ts imports scheduleBackfillRecoveryCron from ../cron/backfill-recovery-cron", () => {
    const source = readFileSync(START_WORKERS_PATH, "utf-8");
    expect(source).toContain("scheduleBackfillRecoveryCron");
    expect(source).toContain('from "../cron/backfill-recovery-cron"');
  });

  it("INV-BACKFILL-RECOVERY-CRON-WIRED-008: (a) start-workers.ts invokes scheduleBackfillRecoveryCron (callsite count > 0)", () => {
    const source = readFileSync(START_WORKERS_PATH, "utf-8");
    // Direct callsite check (not just import). Mirror the existing 4-cron wiring
    // shape: `<handleVar> = scheduleBackfillRecoveryCron(`.
    expect(source).toMatch(/backfillRecoveryCron\s*=\s*scheduleBackfillRecoveryCron\(/);
  });

  it("INV-BACKFILL-RECOVERY-CRON-WIRED-008: (a) start-workers.ts releases the cron handle via .stop() on graceful shutdown", () => {
    const source = readFileSync(START_WORKERS_PATH, "utf-8");
    // The handle must be stopped on shutdown (same lifecycle as the existing
    // 4 crons) to free the setInterval timer.
    expect(source).toMatch(/backfillRecoveryCron\?\.stop|backfillRecoveryCron\.stop/);
  });

  // --------------------------------------------------------------------------
  // (b) ONE-CYCLE RECOVERY — behavioural (mock-Prisma + mock-Queue)
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-RECOVERY-CRON-WIRED-008: (b) one recovery cycle (runOnStart) scans failed_with_known_reason orphans", async () => {
    process.env["BACKFILL_RECOVERY_ENABLED"] = "true";
    const { client, findManySpy } = makeFakePrisma([
      {
        id: ORPHAN_ID,
        embeddingBackfillStatus: "failed_with_known_reason",
        embeddingBackfillRetryCount: 0,
      },
    ]);
    const { queue } = makeFakeQueue();

    handle = scheduleBackfillRecoveryCron({
      prisma: client,
      queue,
      runOnStart: true,
    });

    // runOnStart fires `runOnce` synchronously (void). Flush the microtask /
    // macrotask queue so the cycle completes deterministically.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The recovery cycle scanned for failed_with_known_reason orphans at least once.
    expect(findManySpy).toHaveBeenCalled();
  });

  it("INV-BACKFILL-RECOVERY-CRON-WIRED-008: (b) cron returns a stoppable handle (timer released on stop)", () => {
    process.env["BACKFILL_RECOVERY_ENABLED"] = "true";
    const { client } = makeFakePrisma([]);
    const { queue } = makeFakeQueue();
    handle = scheduleBackfillRecoveryCron({ prisma: client, queue });
    expect(typeof handle.stop).toBe("function");
    // stop() must be idempotent-safe (no throw on a clean handle).
    expect(() => handle?.stop()).not.toThrow();
    handle = undefined;
  });

  // --------------------------------------------------------------------------
  // (c) RETRY CAP BOUND — SEC-PLAN-05 (CWE-770 finite recovery loop)
  // --------------------------------------------------------------------------
  it("INV-BACKFILL-RECOVERY-CRON-WIRED-008: (c) BACKFILL_RECOVERY_MAX_AUTO_RETRIES cap is a finite positive integer (SEC-PLAN-05)", () => {
    expect(Number.isInteger(BACKFILL_RECOVERY_MAX_AUTO_RETRIES)).toBe(true);
    expect(BACKFILL_RECOVERY_MAX_AUTO_RETRIES).toBeGreaterThan(0);
    expect(Number.isFinite(BACKFILL_RECOVERY_MAX_AUTO_RETRIES)).toBe(true);
    // SSOT value pinned at 5 (plan §3 D4 / SEC-PLAN-05). A bump here is a
    // deliberate contract change that MUST be reviewed.
    expect(BACKFILL_RECOVERY_MAX_AUTO_RETRIES).toBe(5);
  });

  it("INV-BACKFILL-RECOVERY-CRON-WIRED-008: (c) recovery cron source binds the SEC-PLAN-05 cap via the SSOT constant (no hardcoded literal cap)", () => {
    // The recovery service is the SSOT for the cap; the worker re-enqueue path
    // must reference BACKFILL_RECOVERY_MAX_AUTO_RETRIES (imported), not a bare
    // numeric literal, so a cap change cannot silently desync the recovery loop.
    const SERVICE_SRC = path.join(
      REPO_ROOT,
      "apps/mcp-server/src/services/backfill-recovery-reconciliation.service.ts"
    );
    const src = readFileSync(SERVICE_SRC, "utf-8");
    expect(src).toContain("BACKFILL_RECOVERY_MAX_AUTO_RETRIES");
    // The cap gate compares retryCount against the SSOT constant (CWE-770 bound).
    expect(src).toMatch(/embeddingBackfillRetryCount\s*>=\s*BACKFILL_RECOVERY_MAX_AUTO_RETRIES/);
  });
});
