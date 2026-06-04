// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-WORKER-OBSERVABILITY-001
 *
 * **Plan v4.5 PR1 Track P0 / ADR-0036 §D4**
 *
 * IO Plan Decision V3 anchor: `019e3843-70e8-73de`
 *
 * ## Contract / 不変条件
 *
 * Worker observability zero-day closure: stderr secondary file capture must
 * be wired in `worker-supervisor-lifecycle.service.ts` (AST sweep verifies
 * `openStderrFileWithPreflight` / `sanitizeStderrChunk` callsite count > 0)
 * AND the existing `logger.warn` pipe route must be preserved (V0 prevailed
 * observability runtime contract per SEC-V45-H-01 factual finding).
 *
 * @see Plan v4.5 V3 §P0.1 (Option (b) adopted: structured stderr file as
 *      secondary capture)
 * @see ADR-0036 §D4 (Worker observability zero-day closure)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const SUPERVISOR_LIFECYCLE_PATH = path.join(
  REPO_ROOT,
  "apps/mcp-server/src/services/worker-supervisor-lifecycle.service.ts"
);

describe("INV-WORKER-OBSERVABILITY-001: Worker stderr secondary capture wired", () => {
  it("worker-supervisor-lifecycle.service.ts imports stderr-write-guard SSOT", () => {
    const source = fs.readFileSync(SUPERVISOR_LIFECYCLE_PATH, "utf-8");
    expect(source).toContain("openStderrFileWithPreflight");
    expect(source).toContain("sanitizeStderrChunk");
    expect(source).toContain('from "../utils/stderr-write-guard"');
  });

  it("preserves existing pipe + logger.warn stderr route (V0 prevailed contract)", () => {
    const source = fs.readFileSync(SUPERVISOR_LIFECYCLE_PATH, "utf-8");
    // The existing logger.warn pipe route MUST be preserved per SEC-V45-H-01
    // V1 correction. Secondary capture is additive, not replacing.
    expect(source).toContain('child.stderr.on("data"');
    expect(source).toContain("logger.warn(`[WorkerSupervisor:${workerType}:stderr]");
  });

  it("calls openStderrFileWithPreflight with required Δ10 whitelist params", () => {
    const source = fs.readFileSync(SUPERVISOR_LIFECYCLE_PATH, "utf-8");
    expect(source).toContain("openStderrFileWithPreflight({");
    // The function must receive dir + workerType + pid for Δ10 3-stage
    // whitelist validation to be applied.
    expect(source).toMatch(/openStderrFileWithPreflight\(\{[\s\S]*workerType,[\s\S]*pid:/);
  });

  it("closes secondary file fd on child exit (CWE-400 resource cleanup)", () => {
    const source = fs.readFileSync(SUPERVISOR_LIFECYCLE_PATH, "utf-8");
    // Look for fs.closeSync within an exit handler to assert kernel
    // resource release. INV-AUDIT-EMIT-SSOT-IMPORT-001 retro wiring scope.
    expect(source).toMatch(/child\.once\("exit"[\s\S]*fs\.closeSync/);
  });

  it("loads worker-stderr-config SSOT (REFTRIX_WORKER_STDERR_* env vars)", () => {
    const source = fs.readFileSync(SUPERVISOR_LIFECYCLE_PATH, "utf-8");
    expect(source).toContain("loadWorkerStderrConfigOrDefault");
  });
});
