// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — gdpr-delete / INV-SCREENSHOT-RETENTION-002
 * (Screenshot retention cycle mechanics: compare-and-set under a row lock, failed delete
 *  keeps the path, audit only when something was cleared, wiring, path validation)
 *
 * INV-SCREENSHOT-RETENTION-002 (ADR-0041 Amendment 3): the expiry cycle
 *   - clears a path only under a row lock that re-checks eligibility and the stored path
 *     (a page that left the terminal state, or whose row is locked by another run, is skipped
 *     and its file is untouched);
 *   - keeps the path when the file cannot be deleted, so the next run retries;
 *   - deletes the file before clearing the path (no state leaves a file without a DB pointer);
 *   - never touches a file whose stored path is not `<phase5>/<id>.png`;
 *   - writes no audit row for a dry-run or a run that cleared nothing;
 *   - is scheduled by the backfill worker (`scheduleScreenshotRetentionCron` in start-workers).
 *
 * INV-SCREENSHOT-RETENTION-002 (ADR-0041 Amendment 3): 失効 cycle は、適格条件と保存 path を
 *   再確認する行ロックの下でだけ path を NULL にする (終端でなくなった行・他の run がロック中の
 *   行は skip し、ファイルに触れない)。ファイルを消せなければ path を残して次の run で再試行する。
 *   ファイルを先に消し、path を後で NULL にする。path が `<phase5>/<id>.png` でない行には触れ
 *   ない。dry-run や何も消さなかった run は audit を書かない。backfill worker が定期実行する。
 *
 * @see  Amendment 3
 * @see apps/mcp-server/src/services/screenshot-retention.service.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";

import { assertInvName } from "../_setup/inv-assert";
import {
  createTestPrismaClient,
  ensureSchemaAppliedOnce,
  truncateGdprDomainTables,
} from "../_setup/gdpr-test-fixtures";
import {
  readRetentionAuditRows,
  readStoragePath,
  seedRetentionPage,
} from "../_setup/screenshot-retention-fixtures";
import {
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
  resetAuditLogService,
  type AuditLogPrismaClient,
} from "../../../../src/services/audit-log.service";
import { logger } from "../../../../src/utils/logger";
import { clearResolvedRootCache } from "../../../../src/services/screenshot-persistence.service";
import {
  AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED,
  AUDIT_ACTOR_SCREENSHOT_RETENTION_CRON,
  AUDIT_ACTOR_SCREENSHOT_RETENTION_OPERATOR,
} from "../../../../src/audit/audit-actions";
import {
  RETENTION_MAX_ROWS_PER_RUN,
  RETENTION_TERMINAL_ANALYSIS_STATUSES,
  RETENTION_TERMINAL_BACKFILL_STATUSES,
  buildRetentionEligibilityPredicate,
  createScreenshotRetentionService,
  type RetentionPrismaClient,
  type RetentionTx,
} from "../../../../src/services/screenshot-retention.service";

const INV = "INV-SCREENSHOT-RETENTION-002";
const SRC = path.resolve(__dirname, "../../../../src");

let prisma: PrismaClient;

function service(client: RetentionPrismaClient = prisma as unknown as RetentionPrismaClient) {
  return createScreenshotRetentionService({ prisma: client });
}

describe(`${INV}: screenshot retention cycle mechanics`, () => {
  beforeAll(async () => {
    await ensureSchemaAppliedOnce(process.env.DATABASE_URL!);
    prisma = createTestPrismaClient();
    await prisma.$connect();
    setAuditLogPrismaClientFactory(() => prisma as unknown as AuditLogPrismaClient);
    clearResolvedRootCache();
  });

  afterAll(async () => {
    resetAuditLogPrismaClientFactory();
    resetAuditLogService();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await truncateGdprDomainTables(prisma);
    clearResolvedRootCache();
  });

  it(`${INV}: CAS — a page that leaves the terminal state between selection and the row lock is skipped, file and path untouched`, async () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const page = await seedRetentionPage(prisma, { status: "completed", ageDays: 9 });

    // After the batch was selected and before the per-row tx opens, the backfill re-queues the page.
    const racing: RetentionPrismaClient = {
      $queryRaw: (q) => prisma.$queryRaw(q),
      $executeRaw: (q) => prisma.$executeRaw(q),
      $transaction: async (fn, options) => {
        await prisma.$executeRawUnsafe(
          `UPDATE web_pages SET embedding_backfill_status = 'queued' WHERE id = $1::uuid`,
          page.id
        );
        return prisma.$transaction((tx) => fn(tx as unknown as RetentionTx), options);
      },
    };
    const result = await service(racing).runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(result.skippedCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    expect(fs.existsSync(page.filePath)).toBe(true);
    expect(await readStoragePath(prisma, page.id)).toBe(page.filePath);
    expect(
      await readRetentionAuditRows(prisma, AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED)
    ).toHaveLength(0);
  }, 60_000);

  it(`${INV}: a row locked by another transaction is skipped (SKIP LOCKED), file untouched; the next run takes it`, async () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const page = await seedRetentionPage(prisma, { status: "completed", ageDays: 9 });

    let during: Awaited<ReturnType<ReturnType<typeof service>["runRetentionCycle"]>> | undefined;
    await prisma.$transaction(
      async (holder) => {
        await holder.$queryRaw(
          Prisma.sql`SELECT id FROM web_pages WHERE id = ${page.id}::uuid FOR UPDATE`
        );
        during = await service().runRetentionCycle({ retentionDays: 7, dryRun: false });
      },
      { timeout: 30_000 }
    );
    expect(during!.skippedCount).toBe(1);
    expect(during!.deletedCount).toBe(0);
    expect(fs.existsSync(page.filePath)).toBe(true);

    const after = await service().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(after.deletedCount).toBe(1);
    expect(fs.existsSync(page.filePath)).toBe(false);
  }, 60_000);

  it(`${INV}: a file that cannot be deleted keeps its path (retry next run) and writes no audit`, async () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const page = await seedRetentionPage(prisma, { status: "completed", ageDays: 9 });
    // Replace the PNG by a non-empty directory of the same name: unlink fails (EISDIR/EPERM).
    fs.rmSync(page.filePath);
    fs.mkdirSync(page.filePath);
    fs.writeFileSync(path.join(page.filePath, "inner"), "x");

    const result = await service().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(result.failedCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    expect(await readStoragePath(prisma, page.id)).toBe(page.filePath);
    expect(
      await readRetentionAuditRows(prisma, AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED)
    ).toHaveLength(0);

    fs.rmSync(page.filePath, { recursive: true, force: true });
  }, 60_000);

  it(`${INV}: a path whose file is already gone is cleared (reconciliation) and counted in the audit row`, async () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const page = await seedRetentionPage(prisma, {
      status: "skipped_screenshot_missing",
      ageDays: 9,
      withFile: false,
    });
    const result = await service().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(result.absentCount).toBe(1);
    expect(await readStoragePath(prisma, page.id)).toBeNull();
    const rows = await readRetentionAuditRows(prisma, AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ deletedCount: 0, absentCount: 1 });
  }, 60_000);

  it(`${INV}: dry-run changes nothing (files, DB, audit) and an empty run writes no audit row`, async () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const page = await seedRetentionPage(prisma, { status: "completed", ageDays: 9 });

    const dry = await service().runRetentionCycle({ retentionDays: 7, dryRun: true });
    expect(dry.scannedCount).toBe(1);
    expect(dry.reclaimableFileCount).toBe(1);
    expect(dry.reclaimableBytes).toBeGreaterThan(0);
    expect(dry.deletedCount).toBe(0);
    expect(fs.existsSync(page.filePath)).toBe(true);
    expect(await readStoragePath(prisma, page.id)).toBe(page.filePath);

    const empty = await service().runRetentionCycle({ retentionDays: 30, dryRun: false });
    expect(empty.scannedCount).toBe(0);
    expect(
      await readRetentionAuditRows(prisma, AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED)
    ).toHaveLength(0);
  }, 60_000);

  it(`${INV}: a row whose stored path is not <phase5>/<id>.png is never touched`, async () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const page = await seedRetentionPage(prisma, { status: "completed", ageDays: 9 });
    const outside = path.join(path.dirname(path.dirname(page.filePath)), "outside.png");
    fs.writeFileSync(outside, "keep");
    await prisma.$executeRawUnsafe(
      `UPDATE web_pages SET screenshot_storage_path = $2 WHERE id = $1::uuid`,
      page.id,
      outside
    );
    const result = await service().runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(result.invalidPathCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(page.filePath)).toBe(true);
    expect(await readStoragePath(prisma, page.id)).toBe(outside);
    fs.rmSync(outside, { force: true });
  }, 60_000);

  it(`${INV}: a manual operator run is recorded under its own actor`, async () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    await seedRetentionPage(prisma, { status: "completed", ageDays: 9 });
    await service().runRetentionCycle({
      retentionDays: 7,
      dryRun: false,
      actor: AUDIT_ACTOR_SCREENSHOT_RETENTION_OPERATOR,
    });
    const rows = await readRetentionAuditRows(prisma, AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(AUDIT_ACTOR_SCREENSHOT_RETENTION_OPERATOR);
    expect(AUDIT_ACTOR_SCREENSHOT_RETENTION_OPERATOR).not.toBe(
      AUDIT_ACTOR_SCREENSHOT_RETENTION_CRON
    );
  }, 60_000);

  // ==========================================================================
  // Structural pins (source)
  // ==========================================================================
  it(`${INV}: the eligibility SQL is generated from the classifier and never hand-lists a status`, () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const prefix = "/data/phase5/";
    const sql = buildRetentionEligibilityPredicate(new Date(0), prefix, new Date(0));
    const strings = sql.values.filter((v) => typeof v === "string");
    expect(strings.filter((v) => v !== prefix).sort()).toEqual(
      [...RETENTION_TERMINAL_BACKFILL_STATUSES, ...RETENTION_TERMINAL_ANALYSIS_STATUSES].sort()
    );
    expect(strings).toContain(prefix);
    const source = fs.readFileSync(
      path.join(SRC, "services", "screenshot-retention.service.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/IN \(\s*'(completed|failed|queued)/);
    expect(source).not.toMatch(/failed_with_known_reason'/);
  });

  it(`${INV}: more sticky non-canonical rows than the whole cap do not starve a newer eligible row (reported once, never deleted)`, async () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const sticky = RETENTION_MAX_ROWS_PER_RUN + 1;
    await prisma.$executeRawUnsafe(
      `INSERT INTO web_pages
         (id, url, source_type, usage_scope, screenshot_storage_path,
          embedding_backfill_status, analysis_status, updated_at)
       SELECT gen_random_uuid(), 'https://example.com/sticky/' || g, 'user_provided',
              'inspiration_only', '/elsewhere/' || g || '.png',
              'completed'::"EmbeddingBackfillStatus", 'completed', now() - interval '30 days'
         FROM generate_series(1, $1::int) g`,
      sticky
    );
    const fresh = await seedRetentionPage(prisma, { status: "completed", ageDays: 8 });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const result = await service().runRetentionCycle({ retentionDays: 7, dryRun: false });
    const reported = warn.mock.calls.filter(([m]) => String(m).includes("non-canonical"));
    warn.mockRestore();

    expect(result.invalidPathCount).toBe(sticky);
    expect(reported).toHaveLength(1);
    expect(result.deletedCount).toBe(1);
    expect(fs.existsSync(fresh.filePath)).toBe(false);
    expect(await readStoragePath(prisma, fresh.id)).toBeNull();
    // the sticky rows keep their paths
    const left = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM web_pages WHERE screenshot_storage_path LIKE '/elsewhere/%'`
    );
    expect(left[0]!.n).toBe(sticky);
  }, 120_000);

  it(`${INV}: failing deletes do not use the clear budget: the good row is still expired`, async () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const stuckPages = [];
    for (let i = 0; i < 4; i++) {
      const page = await seedRetentionPage(prisma, { status: "failed", ageDays: 9 });
      fs.rmSync(page.filePath);
      fs.mkdirSync(page.filePath);
      fs.writeFileSync(path.join(page.filePath, "inner"), "x");
      stuckPages.push(page);
    }
    const good = await seedRetentionPage(prisma, { status: "completed", ageDays: 8 });
    const small = createScreenshotRetentionService({
      prisma: prisma as unknown as RetentionPrismaClient,
      batchSize: 1,
    });
    // clear budget = 1 row (maxBatches 1 x batchSize 1), scan budget = 10 batches
    const result = await small.runRetentionCycle({
      retentionDays: 7,
      dryRun: false,
      maxBatches: 1,
    });
    expect(result.deletedCount).toBe(1);
    expect(fs.existsSync(good.filePath)).toBe(false);
    expect(await readStoragePath(prisma, good.id)).toBeNull();
    for (const page of stuckPages) {
      expect(await readStoragePath(prisma, page.id)).toBe(page.filePath);
      fs.rmSync(page.filePath, { recursive: true, force: true });
    }
  }, 60_000);

  it(`${INV}: the file is deleted BEFORE the path is cleared, inside the row-locked transaction`, () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const source = fs.readFileSync(
      path.join(SRC, "services", "screenshot-retention.service.ts"),
      "utf8"
    );
    const lock = source.indexOf("FOR UPDATE SKIP LOCKED");
    const unlink = source.indexOf("await removeScreenshotFile(filePath, row.id)");
    const clear = source.indexOf("SET screenshot_storage_path = NULL");
    expect(lock).toBeGreaterThan(0);
    expect(unlink).toBeGreaterThan(lock);
    expect(clear).toBeGreaterThan(unlink);
  });

  it(`${INV}: the worker schedules the retention cron and stops it on shutdown; the old TTL names stay absent`, () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const startWorkers = fs.readFileSync(path.join(SRC, "scripts", "start-workers.ts"), "utf8");
    expect(startWorkers).toMatch(/scheduleScreenshotRetentionCron\(\{/);
    expect(startWorkers).toContain("screenshotRetentionCron.stop()");
    for (const f of [
      "services/screenshot-retention.service.ts",
      "cron/screenshot-retention-cron.ts",
    ]) {
      const text = fs.readFileSync(path.join(SRC, f), "utf8");
      expect(text, f).not.toContain("screenshot_ttl_cleanup");
      expect(text, f).not.toContain("scheduleScreenshotCleanupCron");
      expect(text, f).not.toContain("cleanupExpired");
    }
  });

  it(`${INV}: the operator CLI exists, is dry-run by default and uses the shared service`, () => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    const cli = fs.readFileSync(
      path.resolve(__dirname, "../../../../scripts/expire-screenshots-past-retention.ts"),
      "utf8"
    );
    expect(cli).toContain("createScreenshotRetentionService");
    expect(cli).toContain("dryRun: !confirm");
    expect(cli).toContain("AUDIT_ACTOR_SCREENSHOT_RETENTION_OPERATOR");
  });
});
