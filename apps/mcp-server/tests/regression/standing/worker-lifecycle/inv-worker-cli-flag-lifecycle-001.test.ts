// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-WORKER-CLI-FLAG-LIFECYCLE-001
 *
 * **Plan v4.5 PR1 Track 1 / ADR-0036 §D3.1 / TPA-M-06**
 *
 * IO Plan Decision V3 anchor: `019e3843-70e8-73de`
 *
 * ## Contract / 不変条件
 *
 * The `--force-cpu-provider` CLI flag MUST exist in `start-workers.ts`
 * (Track 1 H1 isolation test runtime override for `ONNX_EXECUTION_PROVIDER=cpu`).
 * **Removal deadline T+10d 2026-05-28** — a hard CI gate (currently documented
 * as mandate; actual flag deletion enforcement landing at Plan v4.5 closure).
 *
 * ## Why this is a standing test
 *
 * Track 1 introduces an explicit-but-temporary CLI flag for production H1
 * verification. Without lifecycle tracking, the flag risks becoming a
 * persistent diagnostic backdoor (Gate 5 verify-of-verify overhead). This
 * test asserts (a) the flag exists today (Plan v4.5 PR1 landing), and
 * (b) the removal deadline is documented inline so post-Plan-v4.5 cleanup
 * (Plan v4.6 candidate) has a structural pointer.
 *
 * @see Plan v4.5 V3 §2.Track 1 + §10 closure
 * @see ADR-0036 §D3.1 (H1 refuted decision tree + Track 1 lifecycle)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { AUDIT_ACTION_WORKER_CPU_PROVIDER_OVERRIDE } from "../../../../src/audit/audit-actions";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const START_WORKERS_PATH = path.join(REPO_ROOT, "apps/mcp-server/src/scripts/start-workers.ts");
const AUDIT_ACTIONS_PATH = path.join(REPO_ROOT, "apps/mcp-server/src/audit/audit-actions.ts");

describe("INV-WORKER-CLI-FLAG-LIFECYCLE-001: --force-cpu-provider flag lifecycle", () => {
  it("--force-cpu-provider CLI flag exists in start-workers.ts (PR1 landing)", () => {
    const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
    expect(source).toContain("--force-cpu-provider");
  });

  it("flag activation sets ONNX_EXECUTION_PROVIDER=cpu runtime env override", () => {
    const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
    expect(source).toMatch(
      /args\.includes\("--force-cpu-provider"\)[\s\S]*ONNX_EXECUTION_PROVIDER\s*=\s*"cpu"/
    );
  });

  it("flag carries inline removal deadline (T+10d 2026-05-28)", () => {
    const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
    // Removal deadline must be documented inline so post-Track-1 cleanup has
    // a structural pointer (Gate 5 verify-of-verify overhead control).
    expect(source).toContain("2026-05-28");
    expect(source).toContain("INV-WORKER-CLI-FLAG-LIFECYCLE-001");
  });

  it("flag invocation emits operational warning (not silent runtime override)", () => {
    const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
    // Per User permanent directive ⑤ A-9 (推定を確定として報告 禁止),
    // production-impacting flags MUST emit a warning so operators know the
    // runtime contract has been overridden.
    expect(source).toMatch(
      /--force-cpu-provider[\s\S]*console\.warn|console\.warn[\s\S]*--force-cpu-provider/
    );
  });

  it("flag references Plan v4.5 Track 1 H1 isolation context", () => {
    const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
    expect(source).toMatch(/Track 1|H1 isolation/);
  });

  // U-V45-PR1-08 closure (M severity): semantic upgrade from console.warn-only
  // verify to audit emit + SSOT constant import verify. Ensures the privilege
  // escalation is tracked via the GDPR Art.30 365d-retention audit channel
  // (CWE-778 sufficient logging) and that the SSOT-bound action literal is
  // not template-constructed nor hardcoded.
  describe("U-V45-PR1-08: worker_cpu_provider_override audit emit + SSOT", () => {
    it("AUDIT_ACTION_WORKER_CPU_PROVIDER_OVERRIDE SSOT constant exists", () => {
      expect(AUDIT_ACTION_WORKER_CPU_PROVIDER_OVERRIDE).toBe("worker_cpu_provider_override");
    });

    it("start-workers.ts imports AUDIT_ACTION_WORKER_CPU_PROVIDER_OVERRIDE (SSOT-bound)", () => {
      const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
      expect(source).toContain("AUDIT_ACTION_WORKER_CPU_PROVIDER_OVERRIDE");
    });

    it("--force-cpu-provider activation emits audit_logs via getAuditLogService", () => {
      const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
      // The audit emit must be co-located with the flag activation branch.
      // Wave 5 LCC canonical pattern: SSOT import + .log() call within the
      // flag activation block.
      expect(source).toMatch(
        /--force-cpu-provider[\s\S]*AUDIT_ACTION_WORKER_CPU_PROVIDER_OVERRIDE/
      );
      expect(source).toMatch(/getAuditLogService\(\)\.log\(/);
    });

    it("audit emit uses truncateAuditTargetId SSOT for targetId (CWE-209)", () => {
      const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
      // PII minimisation via truncateAuditTargetId SSOT (Wave 5 LCC canonical
      // anchor `019df7ab-2f5a`). The audit emit must NOT hardcode a slice
      // length; the SSOT helper must be used.
      expect(source).toMatch(
        /AUDIT_ACTION_WORKER_CPU_PROVIDER_OVERRIDE[\s\S]*truncateAuditTargetId\(/
      );
    });

    it("AST sweep: production code has 0 hardcoded literal occurrences", () => {
      // SSOT pattern: bare `"worker_cpu_provider_override"` literal must
      // appear only in audit-actions.ts (the SSOT definition file).
      const literal = `"worker_cpu_provider_override"`;
      const auditActionsSrc = fs.readFileSync(AUDIT_ACTIONS_PATH, "utf-8");
      expect(auditActionsSrc).toContain(literal);
      const startWorkersSrc = fs.readFileSync(START_WORKERS_PATH, "utf-8");
      expect(startWorkersSrc).not.toContain(literal);
    });
  });
});
