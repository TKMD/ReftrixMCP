// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the operator CLI `expire-screenshots-past-retention`.
 * operator CLI のユニットテスト (引数は dry-run が既定、未知引数は拒否、報告に id/path を出さない)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CLI_MAX_BATCHES,
  EXIT_ABORTED,
  EXIT_FAILED_ROWS,
  EXIT_OK,
  formatReport,
  parseArgs,
  runCli,
} from "../../scripts/expire-screenshots-past-retention";
import { AUDIT_ACTOR_SCREENSHOT_RETENTION_OPERATOR } from "../../src/audit/audit-actions";
import type { AuditLogEntry } from "../../src/services/audit-log.service";
import { clearResolvedRootCache } from "../../src/services/screenshot-persistence.service";
import {
  SCREENSHOT_RETENTION_DAYS_ENV,
  SCREENSHOT_RETENTION_DEFAULT_DAYS,
  createScreenshotRetentionService,
  type IScreenshotRetentionService,
  type RetentionCycleOptions,
  type RetentionCycleResult,
} from "../../src/services/screenshot-retention.service";
import { logger } from "../../src/utils/logger";
import { FakeDb, pageId } from "../helpers/retention-fake-db";

const argv = (...a: string[]): string[] => ["node", "script", ...a];

function result(over: Partial<RetentionCycleResult> = {}): RetentionCycleResult {
  return {
    dryRun: true,
    retentionDays: 7,
    aborted: null,
    scannedCount: 12,
    deletedCount: 0,
    absentCount: 2,
    failedCount: 0,
    skippedCount: 0,
    invalidPathCount: 1,
    staleCapClearedCount: 3,
    reclaimableFileCount: 9,
    batches: 1,
    capped: false,
    reclaimableBytes: 5 * 1024 * 1024,
    durationMs: 3,
    ...over,
  };
}

describe("parseArgs", () => {
  it("is a dry-run unless --confirm is given", () => {
    expect(parseArgs(argv())).toEqual({ confirm: false, dryRun: true });
    expect(parseArgs(argv("--dry-run"))).toEqual({ confirm: false, dryRun: true });
    expect(parseArgs(argv("--confirm"))).toEqual({ confirm: true, dryRun: false });
  });

  it("rejects unknown arguments (a typo must not turn into a real run) and the contradictory pair", () => {
    expect(() => parseArgs(argv("--confrim"))).toThrow(/Unknown argument/);
    expect(() => parseArgs(argv("--retention-days=0"))).toThrow(/Unknown argument/);
    expect(() => parseArgs(argv("--confirm", "--dry-run"))).toThrow(/mutually exclusive/);
  });
});

describe("formatReport", () => {
  it("dry-run: shows the eligible count and reclaimable bytes, says nothing was deleted, points at --confirm", () => {
    const text = formatReport(result());
    expect(text).toContain("dry-run (nothing is deleted)");
    expect(text).toContain("eligible rows: 12");
    expect(text).toContain("files that would be deleted: 9");
    expect(text).toContain("reclaimable: 5.0 MiB");
    expect(text).toContain(
      "of the cleared rows (files to delete + already gone), cleared only by the 30-day cap: 3"
    );
    expect(text).toContain("Re-run with --confirm");
  });

  it("confirmed run: shows outcomes and a capped hint; aborts are shown", () => {
    const text = formatReport(
      result({ dryRun: false, deletedCount: 7, failedCount: 1, capped: true, aborted: null })
    );
    expect(text).toContain("CONFIRMED");
    expect(text).toContain("deleted: 7");
    expect(text).toContain("failed (path kept, retry on next run): 1");
    expect(text).toContain("MORE REMAIN");
    expect(text).not.toContain("Re-run with --confirm");
    expect(formatReport(result({ aborted: "phase5_dir_missing" }))).toContain(
      "ABORTED: phase5_dir_missing"
    );
  });
});

describe("runCli", () => {
  let sandbox: string;
  let phase5: string;
  let db: FakeDb;
  let audit: AuditLogEntry[];
  let prevRoot: string | undefined;
  let lines: string[];
  const out = (line: string): void => {
    lines.push(line);
  };
  const realService = (): IScreenshotRetentionService =>
    createScreenshotRetentionService({
      prisma: db,
      auditLog: {
        log: async (entry) => {
          audit.push(entry);
        },
      },
    });

  async function seedFile(n: number): Promise<string> {
    const id = pageId(n);
    const file = path.join(phase5, `${id}.png`);
    await fs.writeFile(file, "png");
    db.rows.push({ id, path: file, stillEligible: true, cleared: false });
    return file;
  }

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-test-retention-cli-"));
    phase5 = path.join(sandbox, "phase5");
    await fs.mkdir(phase5);
    prevRoot = process.env.REFTRIX_SCREENSHOT_ROOT;
    process.env.REFTRIX_SCREENSHOT_ROOT = sandbox;
    clearResolvedRootCache();
    db = new FakeDb();
    audit = [];
    lines = [];
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (prevRoot === undefined) delete process.env.REFTRIX_SCREENSHOT_ROOT;
    else process.env.REFTRIX_SCREENSHOT_ROOT = prevRoot;
    clearResolvedRootCache();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("the default invocation (no --confirm) does zero transactions, zero unlink and zero audit, and exits 0", async () => {
    const file = await seedFile(1);
    const code = await runCli(db, parseArgs(argv()), out, { service: realService() });
    expect(code).toBe(EXIT_OK);
    expect(db.txOptions).toHaveLength(0);
    expect(db.events).toHaveLength(0);
    expect(audit).toHaveLength(0);
    await expect(fs.lstat(file)).resolves.toBeDefined();
    expect(lines.join("\n")).toContain("dry-run (nothing is deleted)");
  });

  it("passes dry-run, the operator actor, the CLI batch budget and the default days to the service", async () => {
    const seen: RetentionCycleOptions[] = [];
    const service: IScreenshotRetentionService = {
      runRetentionCycle: async (o) => {
        seen.push(o);
        return result();
      },
    };
    await runCli(db, parseArgs(argv()), out, { service });
    expect(seen[0]).toMatchObject({
      dryRun: true,
      actor: AUDIT_ACTOR_SCREENSHOT_RETENTION_OPERATOR,
      maxBatches: CLI_MAX_BATCHES,
      retentionDays: SCREENSHOT_RETENTION_DEFAULT_DAYS,
    });
    await runCli(db, parseArgs(argv("--confirm")), out, { service });
    expect(seen[1]!.dryRun).toBe(false);
  });

  it("--confirm deletes, writes one audit row under the operator actor, and exits 0", async () => {
    const file = await seedFile(1);
    const code = await runCli(db, parseArgs(argv("--confirm")), out, { service: realService() });
    expect(code).toBe(EXIT_OK);
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(AUDIT_ACTOR_SCREENSHOT_RETENTION_OPERATOR);
  });

  it("exits 2 when the run aborts (missing phase5 directory) and touches nothing", async () => {
    await fs.rmdir(phase5);
    const code = await runCli(db, parseArgs(argv("--confirm")), out, { service: realService() });
    expect(code).toBe(EXIT_ABORTED);
    expect(lines.join("\n")).toContain("ABORTED: phase5_dir_missing");
    expect(db.candidateQueries).toBe(0);
  });

  it("exits 1 when a row failed (its path is kept)", async () => {
    const id = pageId(1);
    const file = path.join(phase5, `${id}.png`);
    await fs.mkdir(file);
    await fs.writeFile(path.join(file, "inner"), "x");
    db.rows.push({ id, path: file, stillEligible: true, cleared: false });
    const code = await runCli(db, parseArgs(argv("--confirm")), out, { service: realService() });
    expect(code).toBe(EXIT_FAILED_ROWS);
    expect(db.rows[0]!.cleared).toBe(false);
  });

  it("aborts with exit 2 and runs nothing when the retention days env is invalid", async () => {
    vi.stubEnv(SCREENSHOT_RETENTION_DAYS_ENV, "7days");
    const service: IScreenshotRetentionService = {
      runRetentionCycle: vi.fn(async () => result()),
    };
    const code = await runCli(db, parseArgs(argv("--confirm")), out, { service });
    expect(code).toBe(EXIT_ABORTED);
    expect(service.runRetentionCycle).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain(SCREENSHOT_RETENTION_DAYS_ENV);
    expect(lines.join("\n")).not.toContain("7days");
  });
});
