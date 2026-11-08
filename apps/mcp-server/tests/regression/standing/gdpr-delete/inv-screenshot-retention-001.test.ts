// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — gdpr-delete / INV-SCREENSHOT-RETENTION-001
 * (Screenshot retention = terminal page + N days, `data.delete` removes at once)
 *
 * INV-SCREENSHOT-RETENTION-001 (ADR-0041 Amendment 3): the full-page screenshot of a page
 *   is kept for `REFTRIX_SCREENSHOT_RETENTION_DAYS` days (default 7, range 1..30, cannot be
 *   disabled) after the page's embedding backfill reached a TERMINAL state, measured from
 *   `web_pages.updated_at`, then removed (file deleted, `screenshot_storage_path` cleared).
 *   Terminal = completed / failed / not_required / skipped_screenshot_missing. Every other
 *   status (queued / in_progress / skipped_fork_error / skipped_memory_pressure /
 *   failed_with_known_reason) is non-terminal: the backfill or the recovery cron still
 *   reads the path, so the retention period does not apply; any page not updated for
 *   `SCREENSHOT_STALE_CAP_DAYS` (30) days is removed whatever its status (Amendment 5). `data.delete` (GDPR Art.17)
 *   still removes the screenshot immediately and does not depend on the DI factory wiring
 *   (H-1 inline fallback). The old TTL cron structure stays removed (PR-SS-B / ADR-0041).
 *
 * INV-SCREENSHOT-RETENTION-001 (ADR-0041 Amendment 3): screenshot は、そのページの embedding
 *   backfill が終端状態になってから `REFTRIX_SCREENSHOT_RETENTION_DAYS` 日 (既定 7、範囲
 *   1..30、`updated_at` 起算 (終端になってから少なくとも N 日)) 保持し、その後に削除する (ファイル削除 + path を
 *   NULL)。終端 = completed / failed / not_required / skipped_screenshot_missing。それ以外の
 *   status は非終端で、backfill / recovery cron が path を読むため、保持期限では消さ
 *   ない (ただし状態に関係なく最後の更新から 30 日で削除、Amendment 5)。`data.delete` は従来どおり即時削除で、DI factory 配線に依存しない (H-1 inline
 *   fallback)。旧 TTL cron の構造は撤去されたままである。
 *
 * Assertions:
 *   #1  factory 未配線で deletePage → SS ファイル FS 消滅 + web_pages 行削除 + audit_logs (real-DB + real-FS)
 *   #2  bulk 削除経路 (all_user_data) でも同様 (real-DB + real-FS)
 *   #3  旧 TTL 構造の不在: (a) scheduleScreenshotCleanupCron が production src 全域 0、
 *       (b) cleanupExpired が screenshot-persistence module-path 限定で 0 (crash-dump の同名は対象外)
 *   #4  screenshot_storage_migrated は SSOT 定数 import 経由で emit
 *   #5  (002-B 単一所掌) screenshot_ttl_cleanup の non-emit は inv-data-delete-002-b-ttl-cron.test.ts
 *   #6  status x 経過日数の行列 (real-DB + real-FS): 終端 4 status は 7 日超で削除、7 日以内は保持、
 *       非終端 5 status は上限の手前 (29 日) まで保持、解析未完了 (pending/processing) も保持。
 *       status の一覧は enum 全値と一致 (新 status は分類を強制される)
 *   #7  保持日数 env: 1..30、30 超は 30 に丸める、不正値 (0・非整数) は止める (既定値へ黙って戻さない)
 *   #8  失効 run は run 単位 1 行の audit (PII なし)。data.delete は期限前でも即時削除 (#1 / #2)
 *   #9  上限 (ADR-0041 Amendment 5): 状態に関係なく `updated_at` から 30 日更新の無いページは
 *       screenshot を削除 (非終端 5 status と解析未完了)、29 日は保持
 *   #10 上限を過ぎても path が `<phase5>/<id>.png` でない行は削除せず、`invalidPathCount` に数える
 *   #11 audit details は保持期限による削除 (`retentionClearedCount`) と上限だけによる削除
 *       (`staleCapClearedCount`) を分けて数える (Art.30)
 *   #12 上限は「状態を変える writer は Prisma 経由で `updated_at` を進める」前提に立つ。production src の
 *       raw `UPDATE web_pages` は `screenshot_storage_path` 以外の列を変えない (source sweep)
 *
 * Related: INV-SCREENSHOT-RETENTION-002 (cycle mechanics: CAS, SKIP LOCKED, failed delete,
 *   audit gating, wiring) in inv-screenshot-retention-002-cycle.test.ts.
 *
 * Sandbox 制約 (ADR-0041 D-1a / Registry FIND-SSB-PLAN-L-08): FS 操作は
 *   `os.tmpdir()` 配下 sandbox root を REFTRIX_SCREENSHOT_ROOT 注入で使用し、
 *   production default root ($HOME/.local/share/reftrix/screenshots) への
 *   mkdir/rmSync を一切行わない。afterAll で「production default root
 *   非作成・非削除」を test-encoded assert として固定化する。
 *
 * @see  §Invariants (2) + Amendment 3
 * @see apps/mcp-server/src/services/gdpr-deletion.service.ts (H-1 inline fallback)
 * @see apps/mcp-server/tests/regression/standing/gdpr-delete/inv-data-delete-002-b-ttl-cron.test.ts (assertion #5)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import { PrismaClient } from "@prisma/client";

import { assertInvName } from "../_setup/inv-assert";
import {
  createTestPrismaClient,
  ensureSchemaAppliedOnce,
  seedGdprFixture,
  truncateGdprDomainTables,
  type GdprFixtureIds,
} from "../_setup/gdpr-test-fixtures";
import {
  dataDeleteHandler,
  setDataDeleteServiceFactory,
  resetDataDeleteServiceFactory,
} from "../../../../src/tools/data/data.tool";
import {
  GdprDeletionService,
  setGdprPrismaClientFactory,
  resetGdprPrismaClientFactory,
  resetGdprScreenshotPersistenceFactory,
  resetGdprDeletionService,
  type GdprPrismaClient,
} from "../../../../src/services/gdpr-deletion.service";
import {
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
  resetAuditLogService,
  type AuditLogPrismaClient,
} from "../../../../src/services/audit-log.service";
import { clearResolvedRootCache } from "../../../../src/services/screenshot-persistence.service";
import { EmbeddingBackfillStatus } from "@prisma/client";
import {
  AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED,
  AUDIT_ACTOR_SCREENSHOT_RETENTION_CRON,
} from "../../../../src/audit/audit-actions";
import {
  SCREENSHOT_RETENTION_DAYS_ENV,
  SCREENSHOT_RETENTION_DEFAULT_DAYS,
  SCREENSHOT_RETENTION_MAX_DAYS,
  SCREENSHOT_RETENTION_MIN_DAYS,
  SCREENSHOT_STALE_CAP_DAYS,
  ScreenshotRetentionConfigError,
  createScreenshotRetentionService,
  getScreenshotRetentionDays,
  type RetentionPrismaClient,
} from "../../../../src/services/screenshot-retention.service";
import {
  NON_TERMINAL_STATUSES,
  TERMINAL_STATUSES,
  readRetentionAuditRows,
  readStoragePath,
  seedRetentionPage,
} from "../_setup/screenshot-retention-fixtures";
import { grepTsFiles, listTsFiles } from "../_setup/source-sweep";

// ============================================================================
// Production default root — must never be created or deleted by this test
// (Registry FIND-SSB-PLAN-L-08 / ADR-0041 D-1a sandbox constraint).
// ============================================================================

/**
 * `${XDG_DATA_HOME:-$HOME/.local/share}/reftrix/screenshots` の解決値。
 * 本テストはこのディレクトリへ mkdir / rmSync を一切行わない。
 */
function resolveProductionDefaultRoot(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "share");
  return path.join(base, "reftrix", "screenshots");
}

let prisma: PrismaClient;
let productionRootExistedBefore: boolean;

describe("INV-SCREENSHOT-RETENTION-001: screenshot retention = terminal page + N days; data.delete removes at once (H-1 fallback)", () => {
  beforeAll(async () => {
    await ensureSchemaAppliedOnce(process.env.DATABASE_URL!);
    prisma = createTestPrismaClient();
    await prisma.$connect();

    // DI wire-up: 実 Prisma Client を GdprDeletionService / AuditLogService に注入。
    // **重要**: screenshot persistence factory は意図的に配線しない (H-1 fallback を exercise)。
    // NOTE: the screenshot persistence factory is deliberately NOT wired so the
    //       H-1 inline fallback path is exercised.
    setGdprPrismaClientFactory(() => prisma as unknown as GdprPrismaClient);
    setAuditLogPrismaClientFactory(() => prisma as unknown as AuditLogPrismaClient);
    resetGdprScreenshotPersistenceFactory(); // explicit: factory unwired

    const gdprSvc = new GdprDeletionService();
    setDataDeleteServiceFactory(() => gdprSvc);

    // sandbox root resolve cache を sibling test と共有しないよう clear。
    clearResolvedRootCache();

    // L-08: production default root の事前存在状態を記録 (afterAll で不変検証)。
    productionRootExistedBefore = fs.existsSync(resolveProductionDefaultRoot());
  });

  afterAll(async () => {
    resetDataDeleteServiceFactory();
    resetGdprPrismaClientFactory();
    resetGdprScreenshotPersistenceFactory();
    resetAuditLogPrismaClientFactory();
    resetGdprDeletionService();
    resetAuditLogService();
    await prisma?.$disconnect();

    // L-08 test-encoded assert: production default root が本テストにより
    // 作成も削除もされていないこと (coupling-drift 検知)。
    const prodRoot = resolveProductionDefaultRoot();
    const productionRootExistsAfter = fs.existsSync(prodRoot);
    expect(
      productionRootExistsAfter,
      `[INV-SCREENSHOT-RETENTION-001] sandbox violation: production default root ` +
        `existence changed (${productionRootExistedBefore} -> ${productionRootExistsAfter}). ` +
        `Tests MUST only touch the os.tmpdir() sandbox root.`
    ).toBe(productionRootExistedBefore);
  });

  beforeEach(async () => {
    await truncateGdprDomainTables(prisma);
  });

  // ==========================================================================
  // Assertion #1: factory 未配線 deletePage → SS ファイル消滅 + 行削除 + audit
  // ==========================================================================
  it("INV-SCREENSHOT-RETENTION-001: factory-unwired data.delete(page) still erases screenshot via H-1 inline fallback", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");

    const ids: GdprFixtureIds = await seedGdprFixture(prisma);
    expect(fs.existsSync(ids.screenshotPath)).toBe(true);

    const result = await dataDeleteHandler({
      target: "page",
      id: ids.webPageId,
      reason: "INV-SCREENSHOT-RETENTION-001 — H-1 inline fallback (page)",
      confirm: true,
    });
    expect(result.success).toBe(true);

    // H-1 fallback: screenshot ファイルが FS から消滅していること。
    expect(fs.existsSync(ids.screenshotPath)).toBe(false);

    // web_pages 行も削除済。
    const wpCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM web_pages WHERE id = $1::uuid`,
      ids.webPageId
    );
    expect(Number(wpCount[0]!.count)).toBe(0);

    // audit_logs に data.delete 成功記録。
    const truncatedPrefix = ids.webPageId.slice(0, 8);
    const auditRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM audit_logs
         WHERE action = 'data.delete'
           AND target_type = 'web_page'
           AND result = 'success'
           AND target_id LIKE $1`,
      `${truncatedPrefix}%`
    );
    expect(Number(auditRows[0]!.count)).toBe(1);
  }, 60_000);

  // ==========================================================================
  // Assertion #2: bulk 削除経路 (all_user_data) でも H-1 fallback が成立
  // ==========================================================================
  it("INV-SCREENSHOT-RETENTION-001: factory-unwired data.delete(all_user_data) still erases screenshot via H-1 inline fallback", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");

    const ids: GdprFixtureIds = await seedGdprFixture(prisma);
    expect(fs.existsSync(ids.screenshotPath)).toBe(true);

    // all_user_data: `id` は profileId (本テストでは存在しない UUID = profile 削除は no-op)、
    // `page_ids` に削除対象ページを明示渡す (deleteAllUserData は auto-discover しない)。
    const result = await dataDeleteHandler({
      target: "all_user_data",
      id: crypto.randomUUID(),
      page_ids: [ids.webPageId],
      reason: "INV-SCREENSHOT-RETENTION-001 — H-1 inline fallback (bulk)",
      confirm: true,
    });
    expect(result.success).toBe(true);

    // bulk 経路でも screenshot ファイルが消滅していること。
    expect(fs.existsSync(ids.screenshotPath)).toBe(false);

    const wpCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM web_pages`
    );
    expect(Number(wpCount[0]!.count)).toBe(0);
  }, 60_000);

  // ==========================================================================
  // Assertion #3: scope 限定 sweep
  //   (a) scheduleScreenshotCleanupCron — production src 全域 0 occurrences
  //   (b) cleanupExpired — screenshot-persistence module-path 限定 0
  //       (crash-dump の同名 export は対象外)
  // ==========================================================================
  it("INV-SCREENSHOT-RETENTION-001: TTL structure is fully removed (scope-limited source sweep)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");

    const srcRoot = path.resolve(__dirname, "../../../../src");

    // (a) scheduleScreenshotCleanupCron: production src 全域でテキスト 0 occurrences。
    //     UB-3 / FB-6 のコメント更新完了後、固有名は src から完全消滅する。
    const cronHits = grepTsFiles(srcRoot, "scheduleScreenshotCleanupCron");
    expect(
      cronHits,
      `scheduleScreenshotCleanupCron must have 0 occurrences in production src (found in: ${cronHits.join(", ")})`
    ).toHaveLength(0);

    // cron モジュール自体が削除されていること。
    expect(
      fs.existsSync(path.join(srcRoot, "cron", "screenshot-cleanup-cron.ts")),
      "src/cron/screenshot-cleanup-cron.ts must be deleted"
    ).toBe(false);

    // (b) cleanupExpired: screenshot-persistence* module-path 限定で 0 occurrences。
    //     crash-dump-cleanup-cron.ts の同名 export は SWEEP 対象外で存続。
    const ssPersistenceFiles = listTsFiles(srcRoot).filter((f) => {
      const rel = path.relative(srcRoot, f);
      return (
        rel.startsWith("services/screenshot-persistence") || rel.startsWith("cron/screenshot-")
      );
    });
    const cleanupHits: string[] = [];
    for (const file of ssPersistenceFiles) {
      const content = fs.readFileSync(file, "utf8");
      if (content.includes("cleanupExpired")) {
        cleanupHits.push(path.relative(srcRoot, file));
      }
    }
    expect(
      cleanupHits,
      `cleanupExpired must have 0 occurrences in screenshot-persistence module-path (found in: ${cleanupHits.join(", ")})`
    ).toHaveLength(0);

    // Anti-self-poisoning sanity: crash-dump の同名 cleanupExpired は存続している
    // (sweep が無差別削除でないことの証明)。
    const crashDumpCron = path.join(srcRoot, "cron", "crash-dump-cleanup-cron.ts");
    if (fs.existsSync(crashDumpCron)) {
      const crashContent = fs.readFileSync(crashDumpCron, "utf8");
      expect(
        crashContent.includes("cleanupExpired"),
        "crash-dump cleanupExpired (separate domain, T+90d SLA) must survive — sweep must be scope-limited"
      ).toBe(true);
    }
  });

  // ==========================================================================
  // Assertion #4: screenshot_storage_migrated は SSOT 定数 import 経由で emit
  // ==========================================================================
  it("INV-SCREENSHOT-RETENTION-001: screenshot_storage_migrated is emitted via SSOT constant import (not a bare literal)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");

    const srcRoot = path.resolve(__dirname, "../../../../src");
    const migrationCli = path.resolve(
      __dirname,
      "../../../../scripts/migrate-screenshots-to-persistent-root.ts"
    );

    // SSOT 定数の存在を確認。
    const auditActions = fs.readFileSync(path.join(srcRoot, "audit", "audit-actions.ts"), "utf8");
    expect(
      auditActions.includes(
        'AUDIT_ACTION_SCREENSHOT_STORAGE_MIGRATED = "screenshot_storage_migrated"'
      ),
      "SSOT constant AUDIT_ACTION_SCREENSHOT_STORAGE_MIGRATED must be defined in audit-actions.ts"
    ).toBe(true);

    // migration CLI は SSOT 定数を import し、action 引数に bare literal を使わない。
    const cli = fs.readFileSync(migrationCli, "utf8");
    expect(
      cli.includes("AUDIT_ACTION_SCREENSHOT_STORAGE_MIGRATED"),
      "migration CLI must import the SSOT constant AUDIT_ACTION_SCREENSHOT_STORAGE_MIGRATED"
    ).toBe(true);
    expect(
      cli.includes('action: "screenshot_storage_migrated"'),
      "migration CLI must NOT use a bare 'screenshot_storage_migrated' literal as the emit action"
    ).toBe(false);
  });

  // ==========================================================================
  // Assertion #6: status x age matrix (real DB + real FS)
  // ==========================================================================
  it("INV-SCREENSHOT-RETENTION-001: the status list covers every EmbeddingBackfillStatus exactly once (a new status must be classified here)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");
    const all = Object.values(EmbeddingBackfillStatus).sort();
    const listed = [...TERMINAL_STATUSES, ...NON_TERMINAL_STATUSES].sort();
    expect(listed).toEqual(all);
    expect(TERMINAL_STATUSES).toHaveLength(4);
    expect(NON_TERMINAL_STATUSES).toHaveLength(5);
  });

  it("INV-SCREENSHOT-RETENTION-001: terminal + older than 7 days -> file deleted and path cleared; non-terminal -> kept up to the stale cap (29 days)", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");
    clearResolvedRootCache();

    const terminal = [];
    for (const status of TERMINAL_STATUSES) {
      terminal.push({ status, ...(await seedRetentionPage(prisma, { status, ageDays: 8 })) });
    }
    const nonTerminal = [];
    for (const status of NON_TERMINAL_STATUSES) {
      nonTerminal.push({
        status,
        ...(await seedRetentionPage(prisma, { status, ageDays: SCREENSHOT_STALE_CAP_DAYS - 1 })),
      });
    }

    const result = await createScreenshotRetentionService({
      prisma: prisma as unknown as RetentionPrismaClient,
    }).runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(result.aborted).toBeNull();
    expect(result.deletedCount).toBe(4);

    for (const p of terminal) {
      expect(fs.existsSync(p.filePath), `${p.status}: file must be deleted`).toBe(false);
      expect(await readStoragePath(prisma, p.id), `${p.status}: path must be cleared`).toBeNull();
    }
    for (const p of nonTerminal) {
      expect(fs.existsSync(p.filePath), `${p.status}: file must be kept`).toBe(true);
      expect(await readStoragePath(prisma, p.id), `${p.status}: path must be kept`).toBe(
        p.filePath
      );
    }
  }, 60_000);

  it("INV-SCREENSHOT-RETENTION-001: a terminal page inside the retention window is kept; the window follows the configured days", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");
    clearResolvedRootCache();
    const service = createScreenshotRetentionService({
      prisma: prisma as unknown as RetentionPrismaClient,
    });
    const fresh = await seedRetentionPage(prisma, { status: "completed", ageDays: 6 });
    const old = await seedRetentionPage(prisma, { status: "completed", ageDays: 8 });

    await service.runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(fs.existsSync(fresh.filePath)).toBe(true);
    expect(await readStoragePath(prisma, fresh.id)).toBe(fresh.filePath);
    expect(fs.existsSync(old.filePath)).toBe(false);

    // the same 6-day-old page is removed once the window is 5 days
    await service.runRetentionCycle({ retentionDays: 5, dryRun: false });
    expect(fs.existsSync(fresh.filePath)).toBe(false);
    expect(await readStoragePath(prisma, fresh.id)).toBeNull();
  }, 60_000);

  it("INV-SCREENSHOT-RETENTION-001: a terminal backfill status on a page whose analysis is not finished is kept", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");
    clearResolvedRootCache();
    const pending = await seedRetentionPage(prisma, {
      status: "not_required",
      analysis: "pending",
      ageDays: SCREENSHOT_STALE_CAP_DAYS - 1,
    });
    const processing = await seedRetentionPage(prisma, {
      status: "completed",
      analysis: "processing",
      ageDays: SCREENSHOT_STALE_CAP_DAYS - 1,
    });
    const result = await createScreenshotRetentionService({
      prisma: prisma as unknown as RetentionPrismaClient,
    }).runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(result.scannedCount).toBe(0);
    expect(fs.existsSync(pending.filePath)).toBe(true);
    expect(fs.existsSync(processing.filePath)).toBe(true);
  }, 60_000);

  // ==========================================================================
  // Assertion #9: stale cap — any page untouched for SCREENSHOT_STALE_CAP_DAYS loses its
  // screenshot, terminal or not (ADR-0041 Amendment 5, LCC M-1)
  // ==========================================================================
  it("INV-SCREENSHOT-RETENTION-001: a page not updated for the stale cap (30 days) loses its screenshot whatever its status; one day inside the cap is kept", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");
    clearResolvedRootCache();
    expect(SCREENSHOT_STALE_CAP_DAYS).toBe(30);
    expect(SCREENSHOT_STALE_CAP_DAYS).toBe(SCREENSHOT_RETENTION_MAX_DAYS);

    const stale = [];
    for (const status of NON_TERMINAL_STATUSES) {
      stale.push({
        label: status,
        ...(await seedRetentionPage(prisma, { status, ageDays: SCREENSHOT_STALE_CAP_DAYS + 1 })),
      });
    }
    stale.push({
      label: "analysis pending",
      ...(await seedRetentionPage(prisma, {
        status: "not_required",
        analysis: "pending",
        ageDays: SCREENSHOT_STALE_CAP_DAYS + 1,
      })),
    });
    stale.push({
      label: "analysis processing",
      ...(await seedRetentionPage(prisma, {
        status: "queued",
        analysis: "processing",
        ageDays: SCREENSHOT_STALE_CAP_DAYS + 1,
      })),
    });
    const inside = [];
    for (const status of NON_TERMINAL_STATUSES) {
      inside.push({
        label: status,
        ...(await seedRetentionPage(prisma, { status, ageDays: SCREENSHOT_STALE_CAP_DAYS - 1 })),
      });
    }

    // boundary pinned to one hour on each side (TDA L-1)
    const HOUR_IN_DAYS = 1 / 24;
    stale.push({
      label: "queued, cap + 1h",
      ...(await seedRetentionPage(prisma, {
        status: "queued",
        ageDays: SCREENSHOT_STALE_CAP_DAYS + HOUR_IN_DAYS,
      })),
    });
    inside.push({
      label: "queued, cap - 1h",
      ...(await seedRetentionPage(prisma, {
        status: "queued",
        ageDays: SCREENSHOT_STALE_CAP_DAYS - HOUR_IN_DAYS,
      })),
    });

    const result = await createScreenshotRetentionService({
      prisma: prisma as unknown as RetentionPrismaClient,
    }).runRetentionCycle({ retentionDays: SCREENSHOT_RETENTION_MAX_DAYS, dryRun: false });
    expect(result.aborted).toBeNull();
    expect(result.deletedCount).toBe(stale.length);

    for (const p of stale) {
      expect(fs.existsSync(p.filePath), `${p.label}: file must be deleted`).toBe(false);
      expect(await readStoragePath(prisma, p.id), `${p.label}: path must be cleared`).toBeNull();
    }
    for (const p of inside) {
      expect(fs.existsSync(p.filePath), `${p.label}: file must be kept`).toBe(true);
      expect(await readStoragePath(prisma, p.id), `${p.label}: path must be kept`).toBe(p.filePath);
    }
  }, 60_000);

  // ==========================================================================
  // Assertion #10: past the stale cap, a non-canonical path is reported, never deleted
  // ==========================================================================
  it("INV-SCREENSHOT-RETENTION-001: a row past the stale cap whose path is not <phase5>/<id>.png is not deleted and is counted in invalidPathCount", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");
    clearResolvedRootCache();
    const odd = await seedRetentionPage(prisma, {
      status: "queued",
      ageDays: SCREENSHOT_STALE_CAP_DAYS + 1,
    });
    const nonCanonical = `${odd.filePath}.moved`;
    fs.copyFileSync(odd.filePath, nonCanonical);
    await prisma.$executeRawUnsafe(
      `UPDATE web_pages SET screenshot_storage_path = $1 WHERE id = $2::uuid`,
      nonCanonical,
      odd.id
    );
    const normal = await seedRetentionPage(prisma, {
      status: "queued",
      ageDays: SCREENSHOT_STALE_CAP_DAYS + 1,
    });

    const result = await createScreenshotRetentionService({
      prisma: prisma as unknown as RetentionPrismaClient,
    }).runRetentionCycle({ retentionDays: SCREENSHOT_RETENTION_MAX_DAYS, dryRun: false });

    expect(result.aborted).toBeNull();
    expect(result.invalidPathCount).toBe(1);
    expect(result.deletedCount).toBe(1);
    expect(fs.existsSync(nonCanonical), "non-canonical file must be kept").toBe(true);
    expect(fs.existsSync(odd.filePath), "canonical-named file of that row must be kept").toBe(true);
    expect(await readStoragePath(prisma, odd.id)).toBe(nonCanonical);
    expect(fs.existsSync(normal.filePath)).toBe(false);
    expect(await readStoragePath(prisma, normal.id)).toBeNull();
    fs.rmSync(nonCanonical, { force: true });
  }, 60_000);

  // ==========================================================================
  // Assertion #11: audit splits retention-period and stale-cap clears (Art.30)
  // ==========================================================================
  it("INV-SCREENSHOT-RETENTION-001: the audit row counts retention-period clears and stale-cap-only clears separately", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");
    clearResolvedRootCache();
    // two terminal rows past the 7-day period (one of them also past the cap: the period applies)
    await seedRetentionPage(prisma, { status: "completed", ageDays: 9 });
    await seedRetentionPage(prisma, { status: "failed", ageDays: SCREENSHOT_STALE_CAP_DAYS + 2 });
    // three non-terminal rows cleared only by the cap (one already without its file)
    await seedRetentionPage(prisma, { status: "queued", ageDays: SCREENSHOT_STALE_CAP_DAYS + 1 });
    await seedRetentionPage(prisma, {
      status: "in_progress",
      ageDays: SCREENSHOT_STALE_CAP_DAYS + 1,
    });
    await seedRetentionPage(prisma, {
      status: "queued",
      ageDays: SCREENSHOT_STALE_CAP_DAYS + 1,
      withFile: false,
    });

    const service = createScreenshotRetentionService({
      prisma: prisma as unknown as RetentionPrismaClient,
    });
    const preview = await service.runRetentionCycle({ retentionDays: 7, dryRun: true });
    expect(preview.staleCapClearedCount).toBe(3);

    const result = await service.runRetentionCycle({ retentionDays: 7, dryRun: false });
    expect(result.deletedCount + result.absentCount).toBe(5);
    expect(result.staleCapClearedCount).toBe(3);

    const rows = await readRetentionAuditRows(prisma, AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({
      retentionClearedCount: 2,
      staleCapClearedCount: 3,
      staleCapDays: SCREENSHOT_STALE_CAP_DAYS,
    });
  }, 60_000);

  // ==========================================================================
  // Assertion #12: raw UPDATE web_pages in production src only touches the screenshot path
  // ==========================================================================
  it("INV-SCREENSHOT-RETENTION-001: raw UPDATE web_pages statements in production src change nothing but screenshot_storage_path (the stale cap relies on Prisma writers moving updated_at)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");
    const roots = [
      path.resolve(__dirname, "../../../../src"),
      path.resolve(__dirname, "../../../../scripts"),
      path.resolve(__dirname, "../../../../../cli/src"),
      path.resolve(__dirname, "../../../../../../packages/core/src"),
      path.resolve(__dirname, "../../../../../../packages/database/src"),
      path.resolve(__dirname, "../../../../../../packages/ml/src"),
      path.resolve(__dirname, "../../../../../../packages/webdesign-core/src"),
    ].filter((r) => fs.existsSync(r));
    expect(roots.length).toBeGreaterThan(0);
    // UPDATE [ONLY] [public.]web_pages [[AS] alias] SET ... (up to WHERE / ; / end of template)
    const statement =
      /UPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?web_pages"?(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\s+([\s\S]*?)(?=\s+WHERE\b|;|`|$)/gi;
    // a table name built at runtime cannot be checked, so none is allowed
    const dynamicTable = /UPDATE\s+(?:ONLY\s+)?\$\{/g;
    // an upsert that updates web_pages on conflict changes state too
    const upsert =
      /INSERT\s+INTO\s+(?:"?public"?\.)?"?web_pages"?[\s\S]*?ON\s+CONFLICT[\s\S]*?DO\s+UPDATE\b/gi;
    const offenders: string[] = [];
    let seen = 0;
    for (const root of roots) {
      for (const file of listTsFiles(root)) {
        const rel = path.relative(root, file);
        const text = fs.readFileSync(file, "utf8");
        for (const m of text.matchAll(statement)) {
          seen += 1;
          const assigned = m[1]!
            .split(",")
            .map((part) => part.split("=")[0]!.trim().replace(/"/g, ""));
          if (assigned.some((col) => col !== "screenshot_storage_path")) {
            offenders.push(`${rel}: SET ${m[1]!.trim()}`);
          }
        }
        for (const m of text.matchAll(dynamicTable))
          offenders.push(`${rel}: ${m[0]} (dynamic table)`);
        for (const _m of text.matchAll(upsert))
          offenders.push(`${rel}: INSERT INTO web_pages ... ON CONFLICT DO UPDATE`);
      }
    }
    // the sweep must find the two known writers (data.delete fallback, retention expiry)
    expect(seen).toBeGreaterThanOrEqual(2);
    // the matcher itself: alias, schema and ONLY forms are seen; SET of another column is flagged
    const probe = (sql: string): string[] => [...sql.matchAll(statement)].map((m) => m[1]!.trim());
    expect(probe("UPDATE public.web_pages wp SET analysis_status = 'x' WHERE id = 1")).toEqual([
      "analysis_status = 'x'",
    ]);
    expect(probe('UPDATE ONLY "web_pages" AS w SET screenshot_storage_path = NULL;')).toEqual([
      "screenshot_storage_path = NULL",
    ]);
    expect(
      offenders,
      "raw UPDATE web_pages may only set screenshot_storage_path; change state through Prisma so updated_at moves"
    ).toEqual([]);
  });

  // ==========================================================================
  // Assertion #7: retention days env — 1..30; above 30 clamps; invalid stops
  // ==========================================================================
  it("INV-SCREENSHOT-RETENTION-001: REFTRIX_SCREENSHOT_RETENTION_DAYS is 1..30; above 30 clamps to 30; an invalid value stops (never a silent shorter fallback)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");
    const read = (v: string | undefined): number =>
      getScreenshotRetentionDays({ [SCREENSHOT_RETENTION_DAYS_ENV]: v });
    expect(SCREENSHOT_RETENTION_DEFAULT_DAYS).toBe(7);
    expect(read(undefined)).toBe(SCREENSHOT_RETENTION_DEFAULT_DAYS);
    expect(read("")).toBe(SCREENSHOT_RETENTION_DEFAULT_DAYS);
    expect(read("1")).toBe(SCREENSHOT_RETENTION_MIN_DAYS);
    expect(read("30")).toBe(SCREENSHOT_RETENTION_MAX_DAYS);
    for (const big of ["31", "365", "99999999999999999999"]) {
      expect(read(big), `value ${big} clamps to the maximum`).toBe(SCREENSHOT_RETENTION_MAX_DAYS);
    }
    for (const bad of ["0", "-1", "off", "false", "never", "7days", "1e1", "Infinity", "+7"]) {
      expect(() => read(bad), `value ${JSON.stringify(bad)} must be rejected`).toThrow(
        ScreenshotRetentionConfigError
      );
    }
  });

  // ==========================================================================
  // Assertion #8: one PII-free audit row per run that removed something
  // ==========================================================================
  it("INV-SCREENSHOT-RETENTION-001: a run that removed screenshots writes ONE audit row (actor/action from SSOT, targetId 'all', numbers only)", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCREENSHOT-RETENTION-001");
    clearResolvedRootCache();
    const a = await seedRetentionPage(prisma, { status: "completed", ageDays: 9 });
    await seedRetentionPage(prisma, { status: "failed", ageDays: 9 });
    await createScreenshotRetentionService({
      prisma: prisma as unknown as RetentionPrismaClient,
    }).runRetentionCycle({ retentionDays: 7, dryRun: false });

    const rows = await readRetentionAuditRows(prisma, AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(AUDIT_ACTOR_SCREENSHOT_RETENTION_CRON);
    expect(rows[0]!.target_id).toBe("all");
    expect(rows[0]!.result).toBe("success");
    expect(rows[0]!.details).toMatchObject({ deletedCount: 2, retentionDays: 7 });
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(a.id);
    expect(serialized).not.toContain("/tmp/");
  }, 60_000);

  // Assertion #5 — cross-ref only (single-owned by inv-data-delete-002-b-ttl-cron.test.ts
  // per Registry FIND-SSB-PLAN-L-06 IO ruling). The screenshot_ttl_cleanup non-emit
  // negative assert lives there; do not duplicate it here.
});
