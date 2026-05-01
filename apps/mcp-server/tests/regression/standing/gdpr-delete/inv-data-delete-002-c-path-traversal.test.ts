// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — gdpr-delete / INV-DATA-DELETE-002-C
 * (Path Traversal 10 matrix defense — ADR-0016 § INV-DATA-DELETE-002-C)
 *
 * INV-DATA-DELETE-002-C: `data.delete(target=page, id=<malicious input>)` に対して、
 *   以下 10 vectors すべてが (1) Zod schema で early-throw、または (2) 内部 path
 *   defense で reject され、(a) DB 書込ゼロ / (b) filesystem 書込ゼロ /
 *   (c) audit_logs 書込ゼロ を保証する matrix。
 *
 * INV-DATA-DELETE-002-C: All 10 Path Traversal vectors against
 *   `data.delete(target=page, id=<malicious input>)` must either (1) be rejected
 *   by the Zod schema (early-throw) or (2) be neutralised by internal path
 *   defenses, with zero DB writes / zero filesystem writes / zero audit_logs
 *   writes as the assertion matrix.
 *
 * ## 10 vectors (ADR-0016 § INV-DATA-DELETE-002-C Path Traversal 10 Matrix)
 *
 *   1. null byte 混入 (`\0`)
 *   2. POSIX parent traversal (`../`)
 *   3. Windows parent traversal (`..\\`)
 *   4. Absolute path (`/etc/passwd`)
 *   5. CR-LF injection (`\r\n`)
 *   6. URL encoded path (`%2F..%2F`)
 *   7. Empty string (`""`)
 *   8. Oversized string (> 10000 chars, ReDoS probe)
 *   9. UNC path (`\\\\server\\share`) — Windows network share
 *  10. Trailing slash on otherwise-valid UUID (`<uuid>/`)
 *
 * ## Symlink attack (separate dedicated test)
 *
 * UUID 自体は valid でも、phase5 dir 内に `/etc 外部 path` への symlink が
 * 事前に存在するケース。`fs.unlink` は symlink のみ削除し、外部 path には副作用
 * なし — defense in depth の契約を negative assertion で確認。
 *
 * When the UUID is valid but the phase5 directory already contains a symlink
 * pointing at an out-of-root path, `fs.unlink` must remove only the symlink
 * — not its target. A negative assertion verifies no external side-effects.
 *
 * @see ADR-0016 § INV-DATA-DELETE-002-C Path Traversal 10 Matrix
 * @see apps/mcp-server/src/services/screenshot-persistence.service.ts
 *      (buildSafeScreenshotPath / validateScreenshotPath — 3-tier whitelist)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import { PrismaClient } from "@prisma/client";

import { assertInvName } from "../_setup/inv-assert";
import { createTestPrismaClient, ensureSchemaAppliedOnce } from "../_setup/gdpr-test-fixtures";
import {
  dataDeleteHandler,
  setDataDeleteServiceFactory,
  resetDataDeleteServiceFactory,
} from "../../../../src/tools/data/data.tool";
import {
  GdprDeletionService,
  setGdprPrismaClientFactory,
  resetGdprPrismaClientFactory,
  setGdprScreenshotPersistenceFactory,
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
import {
  createScreenshotPersistenceService,
  resolvePhase5Dir,
  clearResolvedRootCache,
  type IScreenshotPersistencePrismaClient,
} from "../../../../src/services/screenshot-persistence.service";

// ============================================================================
// 10 attack vectors
// ============================================================================

/**
 * 全 10 vectors は Zod schema `z.string().uuid()` で early reject される想定。
 * UUID 形式ではない、または UUID 形式に汚染を含むため、schema level で reject。
 *
 * All 10 vectors are expected to be early-rejected by the Zod schema
 * `z.string().uuid()` because they are either non-UUID or contain sentinels
 * that break the UUID regex.
 */
interface PathTraversalVector {
  readonly name: string;
  readonly input: string;
}

const VALID_UUID_PREFIX = "01933333-3333-7333-8333-333333333333" as const;

const PATH_TRAVERSAL_VECTORS: readonly PathTraversalVector[] = [
  { name: "01-null-byte", input: `${VALID_UUID_PREFIX}\u0000/etc/passwd` },
  { name: "02-posix-parent-traversal", input: "../../../etc/passwd" },
  { name: "03-windows-parent-traversal", input: "..\\..\\..\\etc\\passwd" },
  { name: "04-absolute-path", input: "/etc/passwd" },
  { name: "05-crlf-injection", input: `${VALID_UUID_PREFIX}\r\n/etc/passwd` },
  { name: "06-url-encoded", input: "..%2F..%2Fetc%2Fpasswd" },
  { name: "07-empty-string", input: "" },
  { name: "08-oversized-string", input: "a".repeat(10_001) },
  { name: "09-unc-path", input: "\\\\server\\share\\payload" },
  { name: "10-trailing-slash-uuid", input: `${VALID_UUID_PREFIX}/` },
] as const;

// ============================================================================
// State helpers (snapshots)
// ============================================================================

async function snapshotDbRowCounts(prisma: PrismaClient): Promise<{
  web_pages: number;
  audit_logs: number;
  preference_profiles: number;
}> {
  const one = async (table: string): Promise<number> => {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM ${table}`
    );
    return Number(rows[0]!.count ?? 0n);
  };
  return {
    web_pages: await one("web_pages"),
    audit_logs: await one("audit_logs"),
    preference_profiles: await one("preference_profiles"),
  };
}

function snapshotPhase5Files(phase5Dir: string): string[] {
  if (!fs.existsSync(phase5Dir)) return [];
  return fs.readdirSync(phase5Dir).sort();
}

// ============================================================================
// DB + DI state (shared across tests)
// ============================================================================

let prisma: PrismaClient;

describe("INV-DATA-DELETE-002-C: Path Traversal 10 matrix defense", () => {
  beforeAll(async () => {
    await ensureSchemaAppliedOnce(process.env.DATABASE_URL!);

    prisma = createTestPrismaClient();
    await prisma.$connect();

    setGdprPrismaClientFactory(() => prisma as unknown as GdprPrismaClient);
    setAuditLogPrismaClientFactory(() => prisma as unknown as AuditLogPrismaClient);
    const screenshotSvc = createScreenshotPersistenceService({
      prisma: prisma as unknown as IScreenshotPersistencePrismaClient,
    });
    setGdprScreenshotPersistenceFactory(() => screenshotSvc);
    setDataDeleteServiceFactory(() => new GdprDeletionService());
    clearResolvedRootCache();
  });

  afterAll(async () => {
    resetDataDeleteServiceFactory();
    resetGdprPrismaClientFactory();
    resetGdprScreenshotPersistenceFactory();
    resetAuditLogPrismaClientFactory();
    resetGdprDeletionService();
    resetAuditLogService();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    // Fresh DB state per vector
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE audit_logs, preference_signals, preference_profiles, web_pages RESTART IDENTITY CASCADE`
    );
    // Fresh phase5 dir
    const phase5Dir = await resolvePhase5Dir();
    if (fs.existsSync(phase5Dir)) {
      for (const name of fs.readdirSync(phase5Dir)) {
        const full = path.join(phase5Dir, name);
        // lstat で symlink か確認してから unlink (symlink でも正常に unlink 可能)
        // Use lstat to detect symlinks; unlink removes both plain files and symlinks.
        fs.unlinkSync(full);
      }
    } else {
      fs.mkdirSync(phase5Dir, { recursive: true, mode: 0o700 });
    }
  });

  // ==========================================================================
  // 10 vector matrix (Zod-level rejection contract)
  // ==========================================================================

  it.each(PATH_TRAVERSAL_VECTORS)(
    "INV-DATA-DELETE-002-C: vector=$name rejected with zero side effects",
    async ({ input }) => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-DATA-DELETE-002-C");

      const phase5Dir = await resolvePhase5Dir();

      // --- Snapshot pre-state ---
      const beforeDb = await snapshotDbRowCounts(prisma);
      const beforeFiles = snapshotPhase5Files(phase5Dir);

      // --- Execute malicious data.delete ---
      const result = await dataDeleteHandler({
        target: "page",
        id: input,
        reason: "INV-DATA-DELETE-002-C path traversal matrix",
        confirm: true,
      });

      // --- Assert rejection ---
      expect(result.success).toBe(false);
      if (result.success === false) {
        // Zod validation error → VALIDATION_ERROR code
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }

      // --- (a) DB rows unchanged ---
      const afterDb = await snapshotDbRowCounts(prisma);
      expect(afterDb).toEqual(beforeDb);

      // --- (b) filesystem (phase5 dir) unchanged ---
      const afterFiles = snapshotPhase5Files(phase5Dir);
      expect(afterFiles).toEqual(beforeFiles);

      // --- (c) audit_logs write count = 0 ---
      //   Zod validation error は handler の validation 分岐で即 return され、
      //   `auditLogService.log()` は呼ばれない (data.tool.ts:346-374)。
      //
      //   Zod validation errors return early from the handler's validation branch;
      //   `auditLogService.log()` is never invoked (data.tool.ts:346-374).
      const auditRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM audit_logs`
      );
      expect(Number(auditRows[0]!.count)).toBe(0);
    }
  );

  // ==========================================================================
  // Symlink attack (brief INV-DATA-DELETE-002-C vector #4)
  //
  // UUID は valid だが phase5 dir 内に外部 path を指す symlink が置かれた
  // シナリオ。`fs.unlink` は symlink のみ削除し、ターゲットには副作用なし。
  //
  // UUID is valid but a symlink pointing to an out-of-root path pre-exists in
  // the phase5 directory. `fs.unlink` must only remove the symlink.
  // ==========================================================================

  it("INV-DATA-DELETE-002-C: symlink attack — fs.unlink removes symlink only, target unchanged (defense in depth)", async () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-DATA-DELETE-002-C");

    const phase5Dir = await resolvePhase5Dir();
    const webPageId = crypto.randomUUID();

    // 安全な external target を作成 (/etc/passwd 等の host sensitive path は使わない)
    // Create a safe external sentinel (NEVER use host sensitive paths like /etc/passwd).
    const externalTarget = path.join("/tmp", `reftrix-symlink-sentinel-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(externalTarget, "EXTERNAL_SENTINEL_MUST_NOT_BE_DELETED\n", { mode: 0o600 });

    try {
      // Seed: web_pages row + symlink in phase5 dir pointing to external sentinel
      // Raw SQL bypasses Prisma `@updatedAt`; must set updated_at explicitly.
      await prisma.$executeRawUnsafe(
        `INSERT INTO web_pages (id, url, source_type, usage_scope, screenshot_storage_path, updated_at)
           VALUES ($1::uuid, $2, 'user_provided', 'inspiration_only', $3, NOW())`,
        webPageId,
        `https://example.com/test/symlink-${webPageId}`,
        path.join(phase5Dir, `${webPageId}.png`)
      );
      const symlinkPath = path.join(phase5Dir, `${webPageId}.png`);
      fs.symlinkSync(externalTarget, symlinkPath);

      // Sanity: symlink works (fs.existsSync follows symlinks)
      expect(fs.existsSync(symlinkPath)).toBe(true);
      expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);

      // --- Execute data.delete on valid UUID ---
      const result = await dataDeleteHandler({
        target: "page",
        id: webPageId,
        reason: "INV-DATA-DELETE-002-C symlink defense in depth",
        confirm: true,
      });
      expect(result.success).toBe(true);

      // --- Assert: symlink removed, external target untouched ---
      //   lstat で symlink 自体の存在を確認 (existsSync だと symlink 切れで false になるが
      //   lstat でも ENOENT で throw するので try-catch で判定)。
      //   Use lstat to probe the symlink file itself (existsSync returns false for
      //   broken links; catch ENOENT to confirm deletion).
      let symlinkStillExists = false;
      try {
        fs.lstatSync(symlinkPath);
        symlinkStillExists = true;
      } catch {
        symlinkStillExists = false;
      }
      expect(symlinkStillExists).toBe(false);

      // 外部 sentinel が残存していること (symlink 削除が外部 path に副作用を与えなかった)
      // External sentinel must remain (fs.unlink did NOT follow the symlink).
      expect(fs.existsSync(externalTarget)).toBe(true);
      expect(fs.readFileSync(externalTarget, "utf8")).toBe(
        "EXTERNAL_SENTINEL_MUST_NOT_BE_DELETED\n"
      );
    } finally {
      // Cleanup external sentinel
      try {
        fs.unlinkSync(externalTarget);
      } catch {
        /* already removed */
      }
    }
  });
});
