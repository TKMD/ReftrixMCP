// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Crash Dump Cleanup Cron — unit tests (Wave 3 PR3b)
 *
 * Plan v3 T2 V1 §7.1 #5 + Δ6 orphan detection coverage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupExpired } from "../../src/cron/crash-dump-cleanup-cron";
import {
  CRASH_DUMP_DIR_PREFIX,
  resolveCrashDumpSubdir,
} from "../../src/services/crash-dump-persistence.service";

const auditLogs: Array<{
  action: string;
  actor: string;
  targetId?: string;
  details: Record<string, unknown> | undefined;
  result: string;
}> = [];

vi.mock("../../src/services/audit-log.service", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../../src/services/audit-log.service");
  return {
    ...actual,
    getAuditLogService: () => ({
      log: vi.fn(
        async (entry: {
          action: string;
          actor: string;
          targetType: string;
          targetId?: string;
          details?: Record<string, unknown>;
          result: string;
        }) => {
          auditLogs.push({
            action: entry.action,
            actor: entry.actor,
            targetId: entry.targetId,
            details: entry.details,
            result: entry.result,
          });
        }
      ),
      query: vi.fn(async () => []),
      getRetentionPolicy: vi.fn(() => ({ retentionDays: 365, description: "" })),
    }),
  };
});

describe("crash-dump-cleanup-cron — TTL enforcement", () => {
  let root: string;

  beforeEach(async () => {
    auditLogs.length = 0;
    root = await fsp.mkdtemp(path.join(os.tmpdir(), `${CRASH_DUMP_DIR_PREFIX}-cron-test-`));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("deletes files older than olderThanMs", async () => {
    const subdir = await resolveCrashDumpSubdir(root, "page", "child");
    const oldFile = path.join(subdir, "old.json");
    const newFile = path.join(subdir, "new.json");
    await fsp.writeFile(oldFile, "{}");
    await fsp.writeFile(newFile, "{}");
    // Backdate the old file 10 days ago.
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await fsp.utimes(oldFile, tenDaysAgo / 1000, tenDaysAgo / 1000);

    const result = await cleanupExpired({
      publicRoot: root,
      olderThanMs: 7 * 24 * 60 * 60 * 1000, // 7d
      maxBatchSize: 100,
      orphanLookbackMs: 24 * 60 * 60 * 1000,
      perTypeDiskCapBytes: 500 * 1024 * 1024,
    });

    expect(result.deletedCount).toBe(1);
    await expect(fsp.stat(oldFile)).rejects.toThrow(); // deleted
    await expect(fsp.stat(newFile)).resolves.toBeTruthy(); // kept
  });

  it("emits worker_crash_dump_cleanup audit only when deletedCount > 0", async () => {
    const subdir = await resolveCrashDumpSubdir(root, "page", "child");
    const file = path.join(subdir, "expired.json");
    await fsp.writeFile(file, "{}");
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await fsp.utimes(file, tenDaysAgo / 1000, tenDaysAgo / 1000);

    await cleanupExpired({
      publicRoot: root,
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
      maxBatchSize: 100,
      orphanLookbackMs: 24 * 60 * 60 * 1000,
      perTypeDiskCapBytes: 500 * 1024 * 1024,
    });

    const cleanupEmits = auditLogs.filter((l) => l.action === "worker_crash_dump_cleanup");
    expect(cleanupEmits.length).toBe(1);
    expect(cleanupEmits[0]!.actor).toBe("system:crash-dump-cleanup-cron");
    expect(cleanupEmits[0]!.details?.deletedCount).toBe(1);
  });

  it("suppresses audit emit when nothing was deleted (zero-noise)", async () => {
    await resolveCrashDumpSubdir(root, "page", "child");
    const result = await cleanupExpired({
      publicRoot: root,
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
      maxBatchSize: 100,
      orphanLookbackMs: 24 * 60 * 60 * 1000,
      perTypeDiskCapBytes: 500 * 1024 * 1024,
    });
    expect(result.deletedCount).toBe(0);
    const cleanupEmits = auditLogs.filter((l) => l.action === "worker_crash_dump_cleanup");
    expect(cleanupEmits.length).toBe(0);
  });

  it("respects maxBatchSize cap", async () => {
    const subdir = await resolveCrashDumpSubdir(root, "page", "child");
    const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
    // Create 5 expired files.
    for (let i = 0; i < 5; i++) {
      const f = path.join(subdir, `f${i}.json`);
      await fsp.writeFile(f, "{}");
      await fsp.utimes(f, tenDaysAgo, tenDaysAgo);
    }
    const result = await cleanupExpired({
      publicRoot: root,
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
      maxBatchSize: 3,
      orphanLookbackMs: 24 * 60 * 60 * 1000,
      perTypeDiskCapBytes: 500 * 1024 * 1024,
    });
    expect(result.deletedCount).toBe(3);
  });
});

describe("crash-dump-cleanup-cron — disk cap enforcement", () => {
  let root: string;

  beforeEach(async () => {
    auditLogs.length = 0;
    root = await fsp.mkdtemp(path.join(os.tmpdir(), `${CRASH_DUMP_DIR_PREFIX}-cron-cap-`));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("trims oldest files when per-worker-type cap exceeded", async () => {
    const subdir = await resolveCrashDumpSubdir(root, "page", "child");
    // Use a tiny cap (200 bytes); each file is 100 bytes → 5 files = 500 bytes > 200.
    for (let i = 0; i < 5; i++) {
      const f = path.join(subdir, `f${i}.json`);
      await fsp.writeFile(f, "x".repeat(100));
      // Stagger mtimes so we have a deterministic "oldest" order.
      const mtimeSec = Math.floor(Date.now() / 1000) - (5 - i) * 60;
      await fsp.utimes(f, mtimeSec, mtimeSec);
    }
    const result = await cleanupExpired({
      publicRoot: root,
      olderThanMs: 365 * 24 * 60 * 60 * 1000, // huge TTL so only cap triggers
      maxBatchSize: 100,
      orphanLookbackMs: 24 * 60 * 60 * 1000,
      perTypeDiskCapBytes: 200,
    });
    expect(result.disksOverCapWorkerTypes).toContain("page");
    // At least some files should have been deleted to bring under cap.
    expect(result.deletedCount).toBeGreaterThan(0);
  });
});

describe("crash-dump-cleanup-cron — Δ6 orphan detection", () => {
  let root: string;

  beforeEach(async () => {
    auditLogs.length = 0;
    root = await fsp.mkdtemp(path.join(os.tmpdir(), `${CRASH_DUMP_DIR_PREFIX}-orphan-`));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("emits worker_crash_report_orphaned for files with no matching audit entry", async () => {
    const subdir = await resolveCrashDumpSubdir(root, "page", "child");
    const orphan = path.join(subdir, "report.1715472000.1.json");
    await fsp.writeFile(orphan, "{}");
    // Mock audit query returns no matching entries → file is orphan.
    const result = await cleanupExpired({
      publicRoot: root,
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
      maxBatchSize: 100,
      orphanLookbackMs: 24 * 60 * 60 * 1000,
      perTypeDiskCapBytes: 500 * 1024 * 1024,
    });
    expect(result.orphanCount).toBe(1);
    const orphanEmits = auditLogs.filter((l) => l.action === "worker_crash_report_orphaned");
    expect(orphanEmits.length).toBe(1);
    expect(orphanEmits[0]!.details?.workerType).toBe("page");
    expect(orphanEmits[0]!.details?.role).toBe("child");
    expect(orphanEmits[0]!.details?.truncatedReportId).toBe("report.1715472000.1");
  });

  it("does not emit orphan for files outside lookback window", async () => {
    const subdir = await resolveCrashDumpSubdir(root, "page", "child");
    const oldFile = path.join(subdir, "report.0.1.json");
    await fsp.writeFile(oldFile, "{}");
    // Backdate older than orphanLookbackMs.
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    await fsp.utimes(oldFile, twoDaysAgo, twoDaysAgo);
    const result = await cleanupExpired({
      publicRoot: root,
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
      maxBatchSize: 100,
      orphanLookbackMs: 24 * 60 * 60 * 1000, // 24h
      perTypeDiskCapBytes: 500 * 1024 * 1024,
    });
    expect(result.orphanCount).toBe(0);
  });
});
