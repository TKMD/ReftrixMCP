// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-WIRING-COVERAGE-001
 *
 * **Plan v4.5 PR1 Track P0 (Gate 2) / ADR-0036 §D4 / Plan v3 Wave 3 retro wiring**
 *
 * IO Plan Decision V3 anchor: `019e3843-70e8-73de`
 *
 * ## Contract / 不変条件
 *
 * `startCrashReportWatcher` MUST be invoked from `apps/mcp-server/src/scripts/
 * start-workers.ts` (the main worker entry point) so the Wave 3 crash report
 * watcher library actually runs in production. Plan v3 Wave 3 Task #41 landed
 * the library but left it unwired — this Gate prevents recurrence.
 *
 * ## Why Gate 2 verify-of-verify mandates this AST sweep
 *
 * Plan v4.5 V3 §5.2 (Gate 2 Wiring Verification): "AST sweep で callsite >0"
 * を最小条件とし、runtime integration test との **double verification** で
 * mock bypass を回避する。本 standing test は AST half を担当 (runtime half
 * は `start-workers-handlers.test.ts` 系の integration test に委譲)。
 *
 * @see Plan v4.5 V3 §5.2 (Gate 2 Wiring Verification)
 * @see ADR-0036 §D4 (Worker observability zero-day closure)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const START_WORKERS_PATH = path.join(REPO_ROOT, "apps/mcp-server/src/scripts/start-workers.ts");

describe("INV-WIRING-COVERAGE-001: Wave 3 crash-report-watcher retro wiring", () => {
  it("start-workers.ts imports startCrashReportWatcher from crash-report-watcher service", () => {
    const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
    expect(source).toContain("startCrashReportWatcher");
    expect(source).toContain('from "../services/crash-report-watcher"');
  });

  it("start-workers.ts imports createStagingRoot + resolveCrashDumpRoot SSOT helpers", () => {
    const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
    expect(source).toContain("createStagingRoot");
    expect(source).toContain("resolveCrashDumpRoot");
    expect(source).toContain('from "../services/crash-dump-persistence.service"');
  });

  it("start-workers.ts invokes startCrashReportWatcher (callsite count > 0)", () => {
    const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
    // Direct callsite check (not just import). Look for invocation pattern.
    expect(source).toMatch(/crashReportWatcher\s*=\s*startCrashReportWatcher\(/);
  });

  it("start-workers.ts sets up process.report.directory + reportOnFatalError", () => {
    const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
    expect(source).toContain("process.report.directory");
    expect(source).toContain("process.report.reportOnFatalError");
  });

  it("start-workers.ts gracefully stops crashReportWatcher in shutdownWorkers()", () => {
    const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
    // The watcher handle must be released on graceful shutdown to free fs.watch
    // kernel resources.
    expect(source).toMatch(/crashReportWatcher\?\.stop|crashReportWatcher\.stop/);
  });

  it("start-workers.ts schedules worker stderr cleanup cron (NEW-U-11 retro wiring)", () => {
    const source = fs.readFileSync(START_WORKERS_PATH, "utf-8");
    // NEW-U-11 L1+L3 wiring — same Gate 2 contract category.
    expect(source).toContain("scheduleWorkerStderrCleanupCron");
    expect(source).toMatch(/workerStderrCleanupCron\s*=\s*scheduleWorkerStderrCleanupCron\(/);
  });
});
