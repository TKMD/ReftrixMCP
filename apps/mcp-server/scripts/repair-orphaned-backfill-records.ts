// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * v0.4.0 PR7d-1: Orphaned backfill records repair script.
 *
 * PR7b-c 期間の retention-over-deletion バグ（ADR-0010）により、
 * `web_pages.screenshotStoragePath` は設定されているが実ファイルは削除済み、
 * `embeddingBackfillStatus` が `queued` / `in_progress` のまま残っているページを
 * 検出し、`failed` + `skipped_screenshot_missing` へ遷移させる。
 *
 * Detects pages whose persisted screenshot file is missing on disk while
 * `embeddingBackfillStatus` is still `queued` / `in_progress` — a symptom of
 * the retention-over-deletion bug in PR7b-c (see ADR-0010) — and transitions
 * them to `failed` + `skipped_screenshot_missing`.
 *
 * Usage:
 *   pnpm tsx apps/mcp-server/scripts/repair-orphaned-backfill-records.ts            # dry-run (default)
 *   pnpm tsx apps/mcp-server/scripts/repair-orphaned-backfill-records.ts --confirm  # actually update
 *
 * Safety:
 *   - `--dry-run` is the default (no DB writes). `--confirm` required for
 *     any mutation, preventing accidental production runs (mirrors
 *     `reconcile-backfill.ts` convention, SEC LOW-2).
 *   - Uses `fs.promises.stat` on the absolute stored path. No path
 *     construction from user input — the path is read directly from
 *     `web_pages.screenshot_storage_path`, which itself has been validated
 *     by `ScreenshotPersistenceService.saveScreenshot()` on write.
 *   - Logs `webPageId` via `truncateId()` (first 8 chars + `...`) for PII
 *     safety (GDPR Art. 5(1)(c) data minimisation in logs).
 *
 * @module scripts/repair-orphaned-backfill-records
 */

import * as fs from "node:fs";
import { PrismaClient } from "@reftrixmcp/database";
// v0.4.0 PR7d-3 (SEC L-1): sanitize error messages before logging.
// v0.4.0 PR7d-3 (SEC L-1): 生 error.message は出力せず必ず sanitize する。
import { sanitizeErrorMessage } from "../src/utils/sanitize-error";
// v0.4.0 PR7d-3 (LCC MEDIUM-2): audit_logs に修復実行を記録する (GDPR Art.30)。
// v0.4.0 PR7d-3 (LCC MEDIUM-2): record repair executions into audit_logs (GDPR Art.30).
import { getAuditLogService } from "../src/services/audit-log.service";

// -------- CLI args (reuse convention from reconcile-backfill CLI) -------
interface CliArgs {
  dryRun: boolean;
  confirm: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2); // skip node + script
  const confirm = args.includes("--confirm");
  const dryRun = args.includes("--dry-run") || !confirm; // default dry-run
  return { dryRun, confirm };
}

// -------- Helpers --------
function truncateId(id: string, length: number = 8): string {
  if (!id) return "(undefined)";
  return id.length > length ? `${id.slice(0, length)}...` : id;
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(absPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

// -------- Core logic --------
export interface RepairCandidate {
  webPageId: string;
  screenshotStoragePath: string;
  embeddingBackfillStatus: string;
}

export interface RepairResult {
  detected: number;
  updated: number; // 0 under --dry-run
  dryRun: boolean;
  candidates: Array<{ webPageIdTruncated: string; status: string }>;
}

/**
 * Find pages matching: screenshotStoragePath IS NOT NULL AND
 * embeddingBackfillStatus IN ('queued','in_progress') AND file missing on disk.
 */
export async function findOrphanedCandidates(prisma: PrismaClient): Promise<RepairCandidate[]> {
  const rows = await prisma.webPage.findMany({
    where: {
      screenshotStoragePath: { not: null },
      embeddingBackfillStatus: { in: ["queued", "in_progress"] },
    },
    select: {
      id: true,
      screenshotStoragePath: true,
      embeddingBackfillStatus: true,
    },
  });

  const orphaned: RepairCandidate[] = [];
  for (const row of rows) {
    const p = row.screenshotStoragePath;
    if (!p) continue;
    const exists = await fileExists(p);
    if (!exists) {
      orphaned.push({
        webPageId: row.id,
        screenshotStoragePath: p,
        embeddingBackfillStatus: row.embeddingBackfillStatus,
      });
    }
  }
  return orphaned;
}

/**
 * Apply the repair transition for a single page.
 * Uses `updateMany` + WHERE-clause guard to avoid clobbering concurrent
 * worker updates (CAS semantics).
 */
export async function applyRepair(prisma: PrismaClient, webPageId: string): Promise<boolean> {
  const res = await prisma.webPage.updateMany({
    where: {
      id: webPageId,
      embeddingBackfillStatus: { in: ["queued", "in_progress"] },
    },
    data: {
      embeddingBackfillStatus: "skipped_screenshot_missing",
    },
  });
  return res.count > 0;
}

export async function runRepair(prisma: PrismaClient, args: CliArgs): Promise<RepairResult> {
  const candidates = await findOrphanedCandidates(prisma);

  const result: RepairResult = {
    detected: candidates.length,
    updated: 0,
    dryRun: args.dryRun,
    candidates: candidates.map((c) => ({
      webPageIdTruncated: truncateId(c.webPageId),
      status: c.embeddingBackfillStatus,
    })),
  };

  if (!args.dryRun) {
    for (const c of candidates) {
      const ok = await applyRepair(prisma, c.webPageId);
      if (ok) result.updated += 1;
    }
  }

  // v0.4.0 PR7d-3 (LCC MEDIUM-2): record the repair run in audit_logs so it
  // is preserved as a processing activity record (GDPR Art.30). Runs in both
  // dry-run and confirm modes — the dry-run record is valuable as an
  // operational trail.
  //
  // 監査ログに dry-run / confirm 両モードの実行記録を残す。dry-run でも運用証跡
  // として重要なため記録する (GDPR Art.30 処理活動記録)。
  try {
    await getAuditLogService().log({
      action: "backfill_orphaned_repaired",
      actor: "system:repair-orphaned-backfill-records",
      targetType: "web_page",
      details: {
        executionMode: args.dryRun ? "dry-run" : "confirm",
        detectedCount: result.detected,
        repairedCount: result.updated,
        // Keep only truncated IDs in the audit entry (PII hygiene: the full
        // webPageId never enters the audit_logs table).
        // audit_logs には truncate 済み ID のみ格納 (PII 最小化)。
        webPageIdsTruncated: result.candidates.map((c) => c.webPageIdTruncated),
      },
      result: "success",
    });
  } catch {
    // Audit log failure must not prevent the repair from returning its result.
    // 監査ログ失敗は主処理をブロックしない。
  }

  return result;
}

// -------- Main --------
async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const prisma = new PrismaClient();

  // eslint-disable-next-line no-console
  console.log(`[repair-orphaned-backfill-records] mode=${args.dryRun ? "dry-run" : "CONFIRMED"}`);

  try {
    const result = await runRepair(prisma, args);

    // eslint-disable-next-line no-console
    console.log(`[repair] detected=${result.detected} updated=${result.updated}`);
    for (const c of result.candidates) {
      // eslint-disable-next-line no-console
      console.log(`  - ${c.webPageIdTruncated} (was=${c.status})`);
    }
    if (args.dryRun && result.detected > 0) {
      // eslint-disable-next-line no-console
      console.log("[repair] dry-run complete. Re-run with --confirm to apply transitions.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Allow import for tests; only run when invoked directly.
// tsx sets process.argv[1] to the script path; guard via require.main when available.
const isDirectRun =
  typeof require !== "undefined" && require.main === module
    ? true
    : // tsx / ESM fallback: compare script path to argv[1]
      process.argv[1] !== undefined && /repair-orphaned-backfill-records/.test(process.argv[1]);

if (isDirectRun) {
  main().catch((err: unknown) => {
    // v0.4.0 PR7d-3 (SEC L-1 / PR7d-1 L-2): sanitize before logging so DB
    // column names or stack traces are not emitted to operator logs.
    // eslint-disable-next-line no-console
    console.error("[repair-orphaned-backfill-records] fatal:", sanitizeErrorMessage(err));
    process.exit(1);
  });
}
