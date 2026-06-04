// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain (Plan v3 Track T4).
 *
 * INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001: SEC H-03 fail-closed
 * contract (CWE-362 race-lost defense) for the supervisor backfill path.
 *
 * Sub-cases (per design §9.2):
 *   - **Sub-A (probeExistingLock=existing → skip)**: when probe returns
 *     `{exists: true}` (live foreign lock owned by fresh Worker), supervisor
 *     backfill skips fail-closed AND emits secondary
 *     `audit_logs.action='worker_orphan_backfill_skipped_due_to_live_lock'`.
 *   - **Sub-B (probeExistingLock=not_held → backfill proceed)**: when probe
 *     returns `{exists: false}`, supervisor backfill proceeds + emits
 *     primary `audit_logs.action='worker_restart_during_inflight_phase'`.
 *   - **Sub-C (probeExistingLock=redis_unreachable → fail-open)**: ADR-0011
 *     §A4 fail-open contract for transient Redis disconnects; distinguishes
 *     from CWE-362 race-lost which is fail-closed.
 *
 * INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001 — Plan v3 T4 SEC H-03
 * fail-closed contract (CWE-362 race-lost defense).
 *
 * @see PR-V3-T4 design.md §9 (standalone INV)
 * @see ADR-0011 §A4 (fail-open vs. fail-closed semantic)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

const FAILURE_PATH_SERVICE_FILE = resolve(
  __dirname,
  "../../../../src/services/worker-supervisor-failure-path.service.ts"
);

const HELPERS_FILE = resolve(__dirname, "../../../../src/services/worker-supervisor-helpers.ts");

const SCHEMA_FILE = resolve(
  __dirname,
  "../../../../src/services/audit-log/worker-restart-inflight.schema.ts"
);

describe("INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001", () => {
  describe("Sub-A (probeExistingLock=existing → skip)", () => {
    it("INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001: probeExistingLockBeforeBackfill returns kind='skip_live_lock' on probe.exists=true / SEC H-03 fail-closed skip", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001"
      );
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      // Locate probeExistingLockBeforeBackfill body.
      const fnStart = content.indexOf("export async function probeExistingLockBeforeBackfill");
      expect(fnStart).toBeGreaterThan(0);
      const fnBody = content.slice(fnStart, fnStart + 1500);
      // probe.exists branch returns skip_live_lock.
      expect(fnBody).toMatch(/probe\.exists/);
      expect(fnBody).toMatch(/kind:\s*"skip_live_lock"/);
      // Audit log message context (SEC H-03 wording).
      expect(fnBody).toMatch(/SEC H-03 fail-closed/);
    });

    it("INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001: emitOrphanBackfillSkippedAudit emits secondary audit_logs.action='worker_orphan_backfill_skipped_due_to_live_lock' / secondary action emit", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001"
      );
      const content = readFileSync(HELPERS_FILE, "utf-8");
      expect(content).toMatch(/export function emitOrphanBackfillSkippedAudit/);
      expect(content).toMatch(/worker_orphan_backfill_skipped_due_to_live_lock/);
      // Result contract: `denied` (audit log result mirrors fail-closed
      // semantic).
      const fnStart = content.indexOf("export function emitOrphanBackfillSkippedAudit");
      const fnBody = content.slice(fnStart, fnStart + 1000);
      expect(fnBody).toMatch(/"denied"/);
    });
  });

  describe("Sub-B (probeExistingLock=not_held → backfill proceed)", () => {
    it("INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001: handleChildExitOrBackfill proceeds to findOrphanWebPageIds + backfillOrphanWebPageRow when probe returns proceed / probe.proceed → backfill", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001"
      );
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      const fnStart = content.indexOf("export async function handleChildExitOrBackfill");
      expect(fnStart).toBeGreaterThan(0);
      const fnBody = content.slice(fnStart, fnStart + 2500);
      // proceed branch must call findOrphanWebPageIds and backfillOrphanWebPageRow.
      expect(fnBody).toMatch(/findOrphanWebPageIds/);
      expect(fnBody).toMatch(/backfillOrphanWebPageRow/);
    });
  });

  describe("Sub-C (probeExistingLock=redis_unavailable → fail-open per ADR-0011 §A4)", () => {
    it("INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001: redis_unavailable does not block backfill (fail-open per ADR-0011 §A4) / fail-open distinguished from race-lost", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001"
      );
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      const fnStart = content.indexOf("export async function handleChildExitOrBackfill");
      const fnBody = content.slice(fnStart, fnStart + 2500);
      // fail-open semantic per ADR-0011 §A4 — proceed even with degraded marker.
      expect(fnBody).toMatch(/redis_unavailable/);
      expect(fnBody).toMatch(/worker_orphan_backfill_redis_degraded|fail-open/);
    });

    it("INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001: probeExistingLockBeforeBackfill returns redis_unavailable on probe.unavailable=true / probe Redis degraded outcome", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001"
      );
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      const fnStart = content.indexOf("export async function probeExistingLockBeforeBackfill");
      const fnBody = content.slice(fnStart, fnStart + 1500);
      expect(fnBody).toMatch(/probe\.unavailable/);
      expect(fnBody).toMatch(/kind:\s*"redis_unavailable"/);
    });
  });

  describe("SEC M-03 — audit_logs.metadata Zod schema validation contract", () => {
    it("INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001: WorkerOrphanBackfillSkippedAuditMetadataSchema validates probe_outcome='existing_live_lock' / Zod schema for skip_live_lock metadata", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001"
      );
      const content = readFileSync(SCHEMA_FILE, "utf-8");
      expect(content).toMatch(/WorkerOrphanBackfillSkippedAuditMetadataSchema/);
      expect(content).toMatch(/probe_outcome:\s*z\.enum\(\["existing_live_lock"\]\)/);
      expect(content).toMatch(/reason:\s*z\.literal\("backfill_skipped_due_to_live_lock"\)/);
    });

    it("INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001: child_pid Zod regex enforces pid_<sha256_8chars> form (SEC H-02) / PID truncation form contract", () => {
      assertInvName(
        expect.getState().currentTestName ?? "",
        "INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001"
      );
      const content = readFileSync(SCHEMA_FILE, "utf-8");
      expect(content).toMatch(/child_pid:.*regex.*pid_\[0-9a-f\]\{8\}/);
    });
  });
});
