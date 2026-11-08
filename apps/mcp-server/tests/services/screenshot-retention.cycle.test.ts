// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the screenshot retention cycle (select -> row-lock CAS -> delete file -> clear path -> audit).
 * スクリーンショット保持期限 cycle のユニットテスト
 *
 * SQL の意味 (適格条件・FOR UPDATE SKIP LOCKED・CAS) は実 DB の standing test
 * (INV-SCREENSHOT-RETENTION-001 / -002) が固定する。ここでは DB を最小の fake に置き、
 * ファイル削除と DB 更新の順序・失敗時の path 保持・audit の出し分け・上限を固定する。
 * The SQL semantics are pinned by the real-DB standing tests; here a minimal fake DB pins
 * the file/DB ordering, path kept on failure, audit gating and limits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED,
  AUDIT_ACTOR_SCREENSHOT_RETENTION_CRON,
} from "../../src/audit/audit-actions";
import {
  RETENTION_ABSOLUTE_MAX_BATCHES,
  RETENTION_MAX_BATCHES,
  createScreenshotRetentionService,
  type RetentionAuditSink,
  RETENTION_MAX_SCAN_BATCHES,
  RETENTION_ROW_TX_MAX_WAIT_MS,
  RETENTION_ROW_TX_TIMEOUT_MS,
  RETENTION_SCAN_BATCH_MULTIPLIER,
  RETENTION_MS_PER_DAY,
  RETENTION_DB_ERROR_STREAK_LIMIT,
  SCREENSHOT_STALE_CAP_DAYS,
} from "../../src/services/screenshot-retention.service";
import { FakeDb, pageId } from "../helpers/retention-fake-db";
import { clearResolvedRootCache } from "../../src/services/screenshot-persistence.service";
import type { AuditLogEntry } from "../../src/services/audit-log.service";
import { logger } from "../../src/utils/logger";

const NOW = new Date("2026-11-06T00:00:00.000Z");

describe("runRetentionCycle", () => {
  let sandbox: string;
  let phase5: string;
  let db: FakeDb;
  let audit: AuditLogEntry[];
  let auditSink: RetentionAuditSink;
  let prevRoot: string | undefined;

  const svc = (over: { batchSize?: number } = {}) =>
    createScreenshotRetentionService({
      prisma: db,
      auditLog: auditSink,
      now: () => NOW,
      ...over,
    });

  async function seed(
    n: number,
    opts: { file?: boolean; eligible?: boolean } = {}
  ): Promise<string> {
    const id = pageId(n);
    const file = path.join(phase5, `${id}.png`);
    if (opts.file !== false) await fs.writeFile(file, Buffer.alloc(10 * n));
    db.rows.push({ id, path: file, stillEligible: opts.eligible !== false, cleared: false });
    return file;
  }

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-test-retention-cycle-"));
    phase5 = path.join(sandbox, "phase5");
    await fs.mkdir(phase5);
    prevRoot = process.env.REFTRIX_SCREENSHOT_ROOT;
    process.env.REFTRIX_SCREENSHOT_ROOT = sandbox;
    clearResolvedRootCache();
    db = new FakeDb();
    audit = [];
    auditSink = {
      log: async (entry) => {
        audit.push(entry);
      },
    };
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (prevRoot === undefined) delete process.env.REFTRIX_SCREENSHOT_ROOT;
    else process.env.REFTRIX_SCREENSHOT_ROOT = prevRoot;
    clearResolvedRootCache();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("aborts without touching anything when the phase5 directory is missing", async () => {
    await fs.rmdir(phase5);
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.aborted).toBe("phase5_dir_missing");
    expect(db.candidateQueries).toBe(0);
    expect(audit).toHaveLength(0);
  });

  it("aborts without touching anything when the phase5 directory is a symlink", async () => {
    const real = path.join(sandbox, "elsewhere");
    await fs.mkdir(real);
    await fs.rmdir(phase5);
    await fs.symlink(real, phase5);
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.aborted).toBe("phase5_dir_unsafe");
    expect(db.candidateQueries).toBe(0);
  });

  it("dry-run: counts rows and bytes, deletes nothing, opens no tx, writes no audit", async () => {
    const f1 = await seed(1);
    const f2 = await seed(2);
    await seed(3, { file: false });
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.scannedCount).toBe(3);
    expect(r.reclaimableFileCount).toBe(2);
    expect(r.reclaimableBytes).toBe(10 + 20);
    expect(r.absentCount).toBe(1);
    expect(r.deletedCount).toBe(0);
    await expect(fs.lstat(f1)).resolves.toBeDefined();
    await expect(fs.lstat(f2)).resolves.toBeDefined();
    expect(db.txOptions).toHaveLength(0);
    expect(db.events).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it("deletes the file, clears the path under the row lock, and writes ONE PII-free audit row", async () => {
    const f1 = await seed(1);
    const f2 = await seed(2);
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.deletedCount).toBe(2);
    expect(r.failedCount).toBe(0);
    await expect(fs.lstat(f1)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(f2)).rejects.toMatchObject({ code: "ENOENT" });
    expect(db.rows.every((x) => x.cleared)).toBe(true);
    // each row: lock, then update, inside the bounded tx
    expect(db.events).toEqual([
      `lock:${pageId(1)}:ok`,
      `update:${pageId(1)}`,
      `lock:${pageId(2)}:ok`,
      `update:${pageId(2)}`,
    ]);
    expect(db.txOptions[0]).toEqual({
      maxWait: RETENTION_ROW_TX_MAX_WAIT_MS,
      timeout: RETENTION_ROW_TX_TIMEOUT_MS,
    });

    expect(audit).toHaveLength(1);
    const entry = audit[0]!;
    expect(entry.action).toBe(AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED);
    expect(entry.actor).toBe(AUDIT_ACTOR_SCREENSHOT_RETENTION_CRON);
    expect(entry.targetId).toBe("all");
    expect(entry.result).toBe("success");
    expect(entry.details).toMatchObject({
      deletedCount: 2,
      absentCount: 0,
      retentionDays: 7,
      staleCapDays: SCREENSHOT_STALE_CAP_DAYS,
    });
    // details carry numbers/enums only: no id, no path, no url
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(pageId(1));
    expect(serialized).not.toContain(sandbox);
    for (const v of Object.values(entry.details ?? {})) {
      expect(["number", "string", "boolean"]).toContain(typeof v);
    }
  });

  it("a manual operator run uses its own actor so Art.30 can tell it from the cron", async () => {
    await seed(1);
    const actor = "system:operator-test-actor";
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false, actor });
    expect(r.deletedCount).toBe(1);
    expect(audit[0]!.actor).toBe(actor);
  });

  it("absent file: clears the path (reconciliation) and still counts as a cleared row for audit", async () => {
    await seed(1, { file: false });
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.absentCount).toBe(1);
    expect(r.deletedCount).toBe(0);
    expect(db.rows[0]!.cleared).toBe(true);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ deletedCount: 0, absentCount: 1 });
  });

  it("failed delete keeps the path (no UPDATE) so the next run retries, and writes no audit when nothing was cleared", async () => {
    const id = pageId(1);
    const file = path.join(phase5, `${id}.png`);
    await fs.mkdir(file); // a directory cannot be unlinked -> "failed"
    await fs.writeFile(path.join(file, "inner"), "x");
    db.rows.push({ id, path: file, stillEligible: true, cleared: false });
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.failedCount).toBe(1);
    expect(r.deletedCount).toBe(0);
    expect(db.rows[0]!.cleared).toBe(false);
    expect(db.events).toEqual([`lock:${id}:ok`]); // no update:
    expect(audit).toHaveLength(0);
  });

  it("deletes the file BEFORE clearing the path: if the UPDATE throws, the path stays and the next run reconciles it as absent", async () => {
    const id = pageId(1);
    const file = await seed(1);
    db.failUpdateFor.add(id);
    const first = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(first.failedCount).toBe(1);
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" }); // file already gone
    expect(db.rows[0]!.cleared).toBe(false); // path kept
    expect(audit).toHaveLength(0);

    db.failUpdateFor.clear();
    const second = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(second.absentCount).toBe(1);
    expect(db.rows[0]!.cleared).toBe(true);
  });

  it("skips a row that is no longer eligible (or locked) when the lock re-checks it: file untouched", async () => {
    const file = await seed(1, { eligible: false });
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.skippedCount).toBe(1);
    expect(r.deletedCount).toBe(0);
    await expect(fs.lstat(file)).resolves.toBeDefined();
    expect(db.events).toEqual([`lock:${pageId(1)}:none`]);
    expect(audit).toHaveLength(0);
  });

  it("reports non-canonical rows as ONE aggregated count (one warning per run, never per row) and deletes nothing for them", async () => {
    db.nonCanonicalCount = 5000;
    const outside = path.join(sandbox, "outside.png");
    await fs.writeFile(outside, "keep");
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.invalidPathCount).toBe(5000);
    expect(r.deletedCount).toBe(0);
    await expect(fs.lstat(outside)).resolves.toBeDefined();
    const countWarnings = vi
      .mocked(logger.warn)
      .mock.calls.filter(([message]) => String(message).includes("non-canonical"));
    expect(countWarnings).toHaveLength(1);
    expect(countWarnings[0]![1]).toEqual({ count: 5000 });
  });

  it("no non-canonical rows -> no such warning", async () => {
    await seed(1);
    await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    const countWarnings = vi
      .mocked(logger.warn)
      .mock.calls.filter(([message]) => String(message).includes("non-canonical"));
    expect(countWarnings).toHaveLength(0);
  });

  it("defense in depth: a row that slips past the SQL with a non-canonical path is skipped untouched", async () => {
    const outside = path.join(sandbox, "outside.png");
    await fs.writeFile(outside, "keep");
    db.rows.push({ id: pageId(1), path: outside, stillEligible: true, cleared: false });
    db.rows.push({
      id: pageId(2),
      path: path.join(phase5, "..", "outside.png"),
      stillEligible: true,
      cleared: false,
    });
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.skippedCount).toBe(2);
    expect(r.deletedCount).toBe(0);
    await expect(fs.lstat(outside)).resolves.toBeDefined();
    expect(db.txOptions).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it("a row whose stored path changed after it was selected is skipped: the lock re-check compares the path (CAS)", async () => {
    const file = await seed(1);
    db.beforeLock = (id) => {
      const row = db.rows.find((r) => r.id === id);
      if (row) row.path = path.join(phase5, "someone-else.png");
    };
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.skippedCount).toBe(1);
    expect(r.deletedCount).toBe(0);
    await expect(fs.lstat(file)).resolves.toBeDefined();
    expect(db.events).toEqual([`lock:${pageId(1)}:none`]);
  });

  it("zero rows -> no audit row (zero-noise)", async () => {
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.scannedCount).toBe(0);
    expect(audit).toHaveLength(0);
  });

  it("an audit failure is non-fatal: the deletion result is still returned and a warning is logged", async () => {
    await seed(1);
    auditSink = {
      log: async () => {
        throw new Error("audit down");
      },
    };
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.deletedCount).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("pages through batches by id (keyset), without reprocessing rows", async () => {
    for (let i = 1; i <= 5; i++) await seed(i);
    const r = await svc({ batchSize: 2 }).runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.deletedCount).toBe(5);
    expect(r.batches).toBe(3);
    expect(r.capped).toBe(false);
  });

  async function seedStickyFailure(n: number): Promise<void> {
    const id = pageId(n);
    const file = path.join(phase5, `${id}.png`);
    await fs.mkdir(file); // a non-empty directory cannot be unlinked -> "failed"
    await fs.writeFile(path.join(file, "inner"), "x");
    db.rows.push({ id, path: file, stillEligible: true, cleared: false });
  }

  it("a persistently failing row is tried once per run, not once per batch", async () => {
    await seedStickyFailure(1);
    await seed(2);
    await seed(3);
    const r = await svc({ batchSize: 1 }).runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.failedCount).toBe(1);
    expect(r.deletedCount).toBe(2);
    expect(db.events.filter((e) => e === `lock:${pageId(1)}:ok`)).toHaveLength(1);
  });

  it("sticky failing rows beyond the clear budget do not starve newer eligible rows (failed rows do not use the window)", async () => {
    const sticky = RETENTION_MAX_BATCHES + 5; // more than the whole clear budget at batchSize 1
    for (let i = 1; i <= sticky; i++) await seedStickyFailure(i);
    const fresh: string[] = [];
    for (let i = 1; i <= 3; i++) fresh.push(await seed(sticky + i));
    const r = await svc({ batchSize: 1 }).runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.failedCount).toBe(sticky);
    expect(r.deletedCount).toBe(3);
    for (const f of fresh) await expect(fs.lstat(f)).rejects.toMatchObject({ code: "ENOENT" });
    expect(r.capped).toBe(false);
  });

  it("skipped (locked / changed) rows do not use the window either", async () => {
    const stuck = RETENTION_MAX_BATCHES + 3;
    for (let i = 1; i <= stuck; i++) await seed(i, { eligible: false });
    const good = await seed(stuck + 1);
    const r = await svc({ batchSize: 1 }).runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.skippedCount).toBe(stuck);
    expect(r.deletedCount).toBe(1);
    await expect(fs.lstat(good)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it(`the scan itself is bounded (${RETENTION_SCAN_BATCH_MULTIPLIER}x the clear budget): beyond it the run stops and reports capped`, async () => {
    const stuck = RETENTION_MAX_SCAN_BATCHES + 2;
    for (let i = 1; i <= stuck; i++) await seed(i, { eligible: false, file: false });
    const r = await svc({ batchSize: 1 }).runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.batches).toBe(RETENTION_MAX_SCAN_BATCHES);
    expect(r.capped).toBe(true);
  });

  it(`stops at ${RETENTION_MAX_BATCHES} batches and reports capped when more remain`, async () => {
    for (let i = 1; i <= RETENTION_MAX_BATCHES + 1; i++) await seed(i);
    const r = await svc({ batchSize: 1 }).runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.batches).toBe(RETENTION_MAX_BATCHES);
    expect(r.deletedCount).toBe(RETENTION_MAX_BATCHES);
    expect(r.capped).toBe(true);
  });

  it("maxBatches lets the operator CLI count past the cron limit, capped at 1000 and ignoring bad values", async () => {
    for (let i = 1; i <= RETENTION_MAX_BATCHES + 3; i++) await seed(i);
    const wide = await svc({ batchSize: 1 }).runRetentionCycle({
      retentionDays: 7,
      dryRun: true,
      maxBatches: 50,
    });
    expect(wide.scannedCount).toBe(RETENTION_MAX_BATCHES + 3);
    expect(wide.capped).toBe(false);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const r = await svc({ batchSize: 1 }).runRetentionCycle({
        retentionDays: 7,
        dryRun: true,
        maxBatches: bad,
      });
      expect(r.batches).toBe(RETENTION_MAX_BATCHES);
    }
    expect(RETENTION_ABSOLUTE_MAX_BATCHES).toBe(1000);
  });

  it("stops between rows when shouldStop turns true (worker shutdown)", async () => {
    for (let i = 1; i <= 3; i++) await seed(i);
    let calls = 0;
    const r = await svc().runRetentionCycle({
      retentionDays: 7,
      dryRun: false,
      shouldStop: () => ++calls > 1,
    });
    expect(r.deletedCount).toBe(1);
    expect(r.aborted).toBe("stopped");
    expect(audit).toHaveLength(1); // what was cleared is still recorded
  });

  it("aborts after consecutive DB errors instead of grinding through the whole backlog", async () => {
    for (let i = 1; i <= RETENTION_DB_ERROR_STREAK_LIMIT + 3; i++) await seed(i);
    db.failEveryTransaction = true;
    const r = await svc().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(r.aborted).toBe("db_error_streak");
    expect(r.failedCount).toBe(RETENTION_DB_ERROR_STREAK_LIMIT);
  });

  it("the audit row is still written when a later step throws after rows were cleared (finally path)", async () => {
    await seed(1);
    await seed(2);
    db.failCandidateQueryNumber = 2; // the second batch select throws
    await expect(
      svc({ batchSize: 2 }).runRetentionCycle({ retentionDays: 7, dryRun: false })
    ).rejects.toThrow("select failed");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ deletedCount: 2 });
  });

  it("derives the cutoff from the injected clock and the retention days", async () => {
    const seen: Date[] = [];
    const spy = vi.spyOn(db, "$queryRaw").mockImplementation(async (q: Prisma.Sql) => {
      for (const v of q.values as unknown[]) if (v instanceof Date) seen.push(v);
      return [] as never;
    });
    await svc().runRetentionCycle({ retentionDays: 3, dryRun: true });
    expect(spy).toHaveBeenCalled();
    expect(seen[0]!.toISOString()).toBe(
      new Date(NOW.getTime() - 3 * RETENTION_MS_PER_DAY).toISOString()
    );
    // the stale-cap cutoff comes from the same clock
    expect(seen.map((d) => d.toISOString())).toContain(
      new Date(NOW.getTime() - SCREENSHOT_STALE_CAP_DAYS * RETENTION_MS_PER_DAY).toISOString()
    );
  });
});
