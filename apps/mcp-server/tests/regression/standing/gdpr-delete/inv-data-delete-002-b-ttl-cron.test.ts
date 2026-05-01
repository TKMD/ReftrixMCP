// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — gdpr-delete / INV-DATA-DELETE-002-B
 * (Screenshot 7d TTL cron audit_logs negative test)
 *
 * INV-DATA-DELETE-002-B: ScreenshotPersistenceService.cleanupExpired() は、
 *   **削除件数 > 0 の run のみ** audit_logs に
 *   `action = 'screenshot_ttl_cleanup'` row を書込む。0 件削除の run では
 *   audit_logs に 1 row も書込まれない (CWE-778 audit-log flood 防御)。
 *
 * INV-DATA-DELETE-002-B: ScreenshotPersistenceService.cleanupExpired() writes
 *   an `action = 'screenshot_ttl_cleanup'` audit_logs row **only** for runs
 *   where deletedCount > 0. Zero-delete runs must write nothing (CWE-778
 *   audit-log-flood defense).
 *
 * 背景 / Background: v0.4.0 PR7d-3 (LCC MEDIUM-2) で TTL cron に audit_logs
 *   記録を追加した際、0 件削除の batch run が日次で実行されるため、audit_logs
 *   が無意味な row で汚染される問題があった。screenshot-persistence.service.ts
 *   の cleanupExpired は `if (deletedPaths.length > 0)` ガード内で log するため、
 *   **negative test が契約の健全性を証明する必須アサーション**。
 *
 * Background: v0.4.0 PR7d-3 (LCC MEDIUM-2) added audit_logs recording to the
 *   TTL cron. Because zero-delete batch runs execute daily, audit_logs was at
 *   risk of pollution with no-op records. `cleanupExpired` gates the log emit
 *   behind `if (deletedPaths.length > 0)`. The negative test is the
 *   **required assertion for contract soundness**.
 *
 * @see ADR-0016 § Invariants — INV-DATA-DELETE-002-B
 * @see apps/mcp-server/src/services/screenshot-persistence.service.ts:640-659
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import { PrismaClient } from "@prisma/client";

import { assertInvName } from "../_setup/inv-assert";
import { createTestPrismaClient, ensureSchemaAppliedOnce } from "../_setup/gdpr-test-fixtures";
import {
  createScreenshotPersistenceService,
  resolvePhase5Dir,
  clearResolvedRootCache,
  type IScreenshotPersistencePrismaClient,
} from "../../../../src/services/screenshot-persistence.service";
import {
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
  resetAuditLogService,
  type AuditLogPrismaClient,
} from "../../../../src/services/audit-log.service";

/**
 * Screenshot TTL default per v0.4.0 PR7d-3 = 7 days.
 * Used as `olderThanMs` argument for `cleanupExpired`.
 */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Eight days ago (for mtime backdating into the stale range).
 * old file fixture の mtime (8 日前) — 7d TTL より stale。
 */
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

let prisma: PrismaClient;

describe("INV-DATA-DELETE-002-B: Screenshot 7d TTL cron audit_logs negative test", () => {
  beforeAll(async () => {
    await ensureSchemaAppliedOnce(process.env.DATABASE_URL!);
    prisma = createTestPrismaClient();
    await prisma.$connect();
    setAuditLogPrismaClientFactory(() => prisma as unknown as AuditLogPrismaClient);
    // 前テスト (core) の REFTRIX_SCREENSHOT_ROOT resolve cache を clear
    // Clear previous REFTRIX_SCREENSHOT_ROOT resolve cache from sibling tests.
    clearResolvedRootCache();
  });

  afterAll(async () => {
    resetAuditLogPrismaClientFactory();
    resetAuditLogService();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    // audit_logs + web_pages を truncate (TTL cron は audit_logs と web_pages 両方触る)
    // Truncate audit_logs + web_pages (TTL cron touches both).
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE audit_logs, web_pages RESTART IDENTITY CASCADE`);

    // Phase 5 dir を clean state に (test ごと fresh)
    // Reset Phase 5 dir to a clean state per test.
    const phase5Dir = await resolvePhase5Dir();
    if (fs.existsSync(phase5Dir)) {
      for (const name of fs.readdirSync(phase5Dir)) {
        fs.unlinkSync(path.join(phase5Dir, name));
      }
    } else {
      fs.mkdirSync(phase5Dir, { recursive: true, mode: 0o700 });
    }
  });

  it("INV-DATA-DELETE-002-B: cleanupExpired writes audit_logs only when deletedCount > 0", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-DATA-DELETE-002-B");

    const svc = createScreenshotPersistenceService({
      prisma: prisma as unknown as IScreenshotPersistencePrismaClient,
    });
    const phase5Dir = await resolvePhase5Dir();

    // =====================================================================
    // Scenario A: 0-delete run — audit_logs MUST remain empty
    // =====================================================================
    const deletedZero = await svc.cleanupExpired(SEVEN_DAYS_MS);
    expect(deletedZero).toBe(0);

    const auditZeroRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM audit_logs WHERE action = 'screenshot_ttl_cleanup'`
    );
    expect(Number(auditZeroRows[0]!.count)).toBe(0);

    // =====================================================================
    // Scenario B: 1+ delete run — audit_logs MUST receive exactly 1 row
    // =====================================================================
    // Seed: 1 old screenshot file (mtime = now - 8d)
    // fixture 用 webPageId は UUID v4 format で生成するが、filename 検証は
    // cleanupExpired 側の `endsWith('.png')` のみ (UUID regex 非依存)。
    // UUID regex check is not applied by cleanupExpired (only `.endsWith('.png')`).
    const oldFilePath = path.join(phase5Dir, `${crypto.randomUUID()}.png`);
    fs.writeFileSync(oldFilePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]), { mode: 0o600 });
    const eightDaysAgo = new Date(Date.now() - EIGHT_DAYS_MS);
    fs.utimesSync(oldFilePath, eightDaysAgo, eightDaysAgo);

    const deletedOne = await svc.cleanupExpired(SEVEN_DAYS_MS);
    expect(deletedOne).toBe(1);
    expect(fs.existsSync(oldFilePath)).toBe(false);

    const auditOneRows = await prisma.$queryRawUnsafe<
      Array<{ action: string; target_type: string; details: unknown; result: string }>
    >(
      `SELECT action, target_type, details, result FROM audit_logs
         WHERE action = 'screenshot_ttl_cleanup'
         ORDER BY timestamp DESC`
    );
    expect(auditOneRows.length).toBe(1);

    const row = auditOneRows[0]!;
    expect(row.action).toBe("screenshot_ttl_cleanup");
    expect(row.target_type).toBe("web_page_screenshot");
    expect(row.result).toBe("success");

    // details.deletedCount === 1 が GDPR Art.30 "processing activity scope" として要求される
    // details.deletedCount must reflect the actual deleted count for Art.30.
    const details = row.details as { deletedCount?: number; batchSize?: number };
    expect(details.deletedCount).toBe(1);
    expect(typeof details.batchSize).toBe("number");

    // =====================================================================
    // Scenario C: 2nd invocation after clean — MUST remain at 1 row total
    //   (i.e., no new row appended when deletedCount === 0)
    // =====================================================================
    const deletedZeroAgain = await svc.cleanupExpired(SEVEN_DAYS_MS);
    expect(deletedZeroAgain).toBe(0);

    const auditAfterSecond = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM audit_logs WHERE action = 'screenshot_ttl_cleanup'`
    );
    // 2 回目の run で 0 件削除 → audit_logs は 1 row のまま変化しない
    // Second run deletes 0 → audit_logs total MUST still be 1.
    expect(Number(auditAfterSecond[0]!.count)).toBe(1);
  }, 60_000);
});
