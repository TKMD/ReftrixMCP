// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — gdpr-delete / INV-SCREENSHOT-RETENTION-001
 * (Screenshot retention = "until data.delete" — structural TTL removal +
 *  H-1 inline fallback contract)
 *
 * INV-SCREENSHOT-RETENTION-001 (ADR-0041 §Invariants (2)): screenshot 保持の
 *   trigger-event は `data.delete` のみであり、TTL 構造 (cleanupExpired
 *   orchestrator + cron module) は完全撤去されている。さらに GDPR Art.17
 *   削除経路は DI factory 配線に依存せず削除を成立させる (H-1 inline fallback)。
 *
 * INV-SCREENSHOT-RETENTION-001 (ADR-0041 §Invariants (2)): the screenshot
 *   retention trigger event is `data.delete` only, the TTL structure
 *   (cleanupExpired orchestrator + cron module) is fully removed, and the
 *   GDPR Art.17 deletion path completes erasure without depending on the DI
 *   factory wiring (H-1 inline fallback).
 *
 * Assertions (ADR-0041 §Invariants (2)):
 *   #1  factory 未配線 (resetGdprScreenshotPersistenceFactory) で deletePage →
 *       SS ファイル FS 消滅 + web_pages 行削除 + audit_logs 記録 (real-DB + real-FS)
 *   #2  bulk 削除経路 (all_user_data) でも同様 (real-DB + real-FS)
 *   #3  scope 限定 sweep: (a) scheduleScreenshotCleanupCron が production src 全域
 *       0 occurrences (text sweep)、(b) cleanupExpired が screenshot-persistence
 *       module-path 限定で 0 occurrences (crash-dump の同名 export は対象外)
 *   #4  screenshot_storage_migrated が bare literal でなく SSOT 定数
 *       (AUDIT_ACTION_SCREENSHOT_STORAGE_MIGRATED) の import 経由で emit される
 *   #5  (002-B 置換側に単一所掌、ここは cross-ref のみ)
 *       screenshot_ttl_cleanup の non-emit negative assert は
 *       inv-data-delete-002-b-ttl-cron.test.ts に pin (L-06 IO 裁定)。
 *
 * Sandbox 制約 (ADR-0041 D-1a / Registry FIND-SSB-PLAN-L-08): FS 操作は
 *   `os.tmpdir()` 配下 sandbox root を REFTRIX_SCREENSHOT_ROOT 注入で使用し、
 *   production default root ($HOME/.local/share/reftrix/screenshots) への
 *   mkdir/rmSync を一切行わない。afterAll で「production default root
 *   非作成・非削除」を test-encoded assert として固定化する。
 *
 * @see  §Invariants (2)
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

describe("INV-SCREENSHOT-RETENTION-001: screenshot retention = until data.delete (TTL removal + H-1 fallback)", () => {
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
    const cronHits = grepSrc(srcRoot, "scheduleScreenshotCleanupCron");
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
    const ssPersistenceFiles = listSrcFiles(srcRoot).filter((f) => {
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

  // Assertion #5 — cross-ref only (single-owned by inv-data-delete-002-b-ttl-cron.test.ts
  // per Registry FIND-SSB-PLAN-L-06 IO ruling). The screenshot_ttl_cleanup non-emit
  // negative assert lives there; do not duplicate it here.
});

// ============================================================================
// Source-sweep helpers (scope-limited, no node_modules / dist)
// ============================================================================

/** Recursively list `*.ts` files under `dir`, skipping `*.d.ts`. */
function listSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSrcFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Return the list of src files (relative to `srcRoot`) containing `needle`. */
function grepSrc(srcRoot: string, needle: string): string[] {
  const hits: string[] = [];
  for (const file of listSrcFiles(srcRoot)) {
    if (fs.readFileSync(file, "utf8").includes(needle)) {
      hits.push(path.relative(srcRoot, file));
    }
  }
  return hits;
}
