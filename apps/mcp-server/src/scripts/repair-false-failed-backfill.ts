#!/usr/bin/env node
// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repair False-Failed Backfill Records — CLI Entrypoint
 *
 * v0.4.0 PR7e-β2 carryover (SSOT unification follow-up):
 * 旧 `countRemainingGaps` の誤判定により `embeddingBackfillStatus = 'failed'` に
 * pin されてしまった行を、SSOT helper `computeRemainingStatusWithPrisma` で
 * 再判定し、真に完了している行を `completed` に CAS で書き換える。
 *
 * v0.4.0 PR7e-β2 carryover (SSOT unification follow-up): Re-evaluates rows that
 * were pinned to `embeddingBackfillStatus = 'failed'` by the deprecated
 * `countRemainingGaps` mis-judgment, and CAS-updates the truly completed rows
 * to `completed` using the SSOT helper `computeRemainingStatusWithPrisma`.
 *
 * 仕様 / Behavior:
 *   1. `embedding_backfill_status = 'failed'` かつ `embedding_backfill_retry_count < 5`
 *      の行を列挙（retry cap 超過行はアプリケーションの判断で failed 固定なので対象外）。
 *   2. 各行について `computeRemainingStatusWithPrisma` を呼び、`completed` が返れば
 *      `updateMany` CAS で `completed` に書き換える (`embeddingBackfillStatus = 'failed'`
 *      ガード付き、Worker 競合を回避)。
 *   3. 補正成功時は `audit_logs` に `action=backfill_status_corrected_after_ssot_fix`
 *      で記録する (GDPR Art.30、LCC MEDIUM-2)。
 *   4. `--dry-run` (デフォルト) で書き込みを抑止。`--confirm` 明示時のみ実書き込み。
 *
 * Behavior:
 *   1. Enumerate rows with `embedding_backfill_status = 'failed'` and
 *      `embedding_backfill_retry_count < 5` (cap-exceeded rows are intentionally
 *      failed and out of scope).
 *   2. Call `computeRemainingStatusWithPrisma` per row; if it returns `completed`,
 *      CAS-update via `updateMany` with `embeddingBackfillStatus = 'failed'`
 *      guard (avoids races with the worker).
 *   3. On successful correction, emit an `audit_logs` entry with
 *      `action=backfill_status_corrected_after_ssot_fix` (GDPR Art.30, LCC MEDIUM-2).
 *   4. `--dry-run` (default) suppresses writes; real writes only occur with
 *      explicit `--confirm`.
 *
 * 使い方 / Usage:
 *   pnpm tsx apps/mcp-server/src/scripts/repair-false-failed-backfill.ts --dry-run
 *   pnpm tsx apps/mcp-server/src/scripts/repair-false-failed-backfill.ts --confirm
 *   pnpm tsx apps/mcp-server/src/scripts/repair-false-failed-backfill.ts --confirm --batch 100
 *
 * NOTE: production 実行は別途運用判断で行うこと。本スクリプトは安全な 2-mode
 *       (dry-run / confirm) を提供するのみで、自動起動は行わない。
 *
 * NOTE: Production execution is decided separately by ops. This script only
 *       provides the safe 2-mode (dry-run / confirm) interface and is NOT
 *       auto-scheduled.
 *
 * @module scripts/repair-false-failed-backfill
 */

/* eslint-disable no-console */

import { prisma } from "@reftrixmcp/database";
import { computeRemainingStatusWithPrisma } from "../services/backfill-status.helper";
import { getAuditLogService } from "../services/audit-log.service";
import { SKIP_RECOVERY_RETRY_CAP } from "../queues/embedding-backfill-queue";
import { sanitizeErrorMessage } from "../utils/sanitize-error";

interface CliArgs {
  batchLimit: number;
  confirm: boolean;
  dryRun: boolean;
}

interface RepairResult {
  /** Rows examined (includes rows the helper returned in_progress for) */
  totalChecked: number;
  /** Rows confirmed legitimately failed by the SSOT helper (in_progress) */
  stillFailed: number;
  /** Rows the SSOT helper classified as completed */
  wouldCorrect: number;
  /** Rows actually transitioned failed → completed (0 in dry-run) */
  corrected: number;
  /** CAS conflicts (worker/reconciliation moved the row first) */
  concurrentUpdatesSkipped: number;
  /** Per-row exceptions (non-fatal) */
  errors: number;
  /** dry-run mode flag */
  dryRun: boolean;
}

/**
 * Parse minimal argv. Safe against missing/invalid values (falls through to
 * defaults). No external CLI framework to keep the script lightweight.
 * 最小限の argv パーサ。不正値はデフォルトにフォールバック。
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    batchLimit: 500,
    confirm: argv.includes("--confirm"),
    dryRun: !argv.includes("--confirm"), // dry-run by default
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--batch" && value !== undefined) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0 && n <= 10_000) {
        args.batchLimit = n;
      }
      i++;
    } else if (key === "--dry-run") {
      args.dryRun = true;
      args.confirm = false;
    }
  }
  return args;
}

/**
 * Fetch candidate rows: `failed` status with retry count below the cap.
 * `embeddingBackfillRetryCount` 5 以上は意図的な failed 固定なので除外する。
 *
 * Fetches candidate rows: `failed` status with retry count below the cap.
 * Rows with `embeddingBackfillRetryCount >= 5` are intentionally failed and
 * are excluded.
 */
async function fetchFalseFailedCandidates(
  limit: number
): Promise<Array<{ id: string; retryCount: number }>> {
  const rows = await prisma.webPage.findMany({
    where: {
      embeddingBackfillStatus: "failed",
      embeddingBackfillRetryCount: { lt: SKIP_RECOVERY_RETRY_CAP },
    },
    select: { id: true, embeddingBackfillRetryCount: true },
    take: limit,
    orderBy: { updatedAt: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    retryCount: row.embeddingBackfillRetryCount ?? 0,
  }));
}

/**
 * Repair one row. Returns the updated aggregate counters.
 *
 * 1 行分の repair を実行する。副作用は `result` への in-place 加算のみ。
 */
async function repairOneRow(
  row: { id: string; retryCount: number },
  args: CliArgs,
  result: RepairResult
): Promise<void> {
  // v0.4.0 PR-D-4: `computeRemainingStatusWithPrisma` は `{finalStatus, pendingSnapshot}`
  // を返す single-query refactor 後の API。repair スクリプトは finalStatus のみ参照。
  // v0.4.0 PR-D-4: `computeRemainingStatusWithPrisma` now returns
  // `{finalStatus, pendingSnapshot}` after the single-query refactor.
  // The repair script only consumes `finalStatus`.
  const { finalStatus: status } = await computeRemainingStatusWithPrisma(row.id, prisma);
  if (status === "in_progress") {
    result.stillFailed += 1;
    return;
  }

  result.wouldCorrect += 1;

  if (args.dryRun) {
    console.log("[RepairFalseFailedBackfill] [dry-run] Would correct failed → completed", {
      webPageId: row.id.slice(0, 8) + "...",
      retryCount: row.retryCount,
    });
    return;
  }

  // CAS guard: only transition if the row is still `failed` to avoid racing the
  // worker / reconciliation cron.
  // CAS ガード: 依然 `failed` のときのみ遷移し、worker / reconciliation cron との
  // 競合を回避する。
  const updated = await prisma.webPage.updateMany({
    where: { id: row.id, embeddingBackfillStatus: "failed" },
    data: { embeddingBackfillStatus: "completed" },
  });

  if (updated.count === 0) {
    result.concurrentUpdatesSkipped += 1;
    console.log("[RepairFalseFailedBackfill] Status changed concurrently — skipping", {
      webPageId: row.id.slice(0, 8) + "...",
    });
    return;
  }

  result.corrected += 1;

  // Audit log: GDPR Art.30 processing activity record (LCC MEDIUM-2).
  // audit_logs への記録は失敗しても致命的でない。
  try {
    await getAuditLogService().log({
      action: "backfill_status_corrected_after_ssot_fix",
      actor: "repair-false-failed-backfill-script",
      targetType: "web_page",
      targetId: row.id,
      details: {
        previousStatus: "failed",
        newStatus: "completed",
        retryCountAtRepair: row.retryCount,
        reason: "SSOT helper (computeRemainingStatusWithPrisma) classified row as completed",
      },
      result: "success",
    });
  } catch {
    /* audit log 失敗は致命的でない / non-fatal */
  }

  console.log("[RepairFalseFailedBackfill] Corrected failed → completed", {
    webPageId: row.id.slice(0, 8) + "...",
    retryCount: row.retryCount,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Production では明示的な --confirm または --dry-run が必須
  // Production requires an explicit --confirm or --dry-run flag
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && !args.confirm && !args.dryRun) {
    console.error(
      "[RepairFalseFailedBackfill] Production mode requires --confirm flag or --dry-run mode. " +
        "Aborting to prevent accidental runs."
    );
    process.exitCode = 1;
    return;
  }

  console.log("[RepairFalseFailedBackfill] Starting false-failed backfill repair (SSOT re-check)");
  console.log("[RepairFalseFailedBackfill] Args:", {
    batchLimit: args.batchLimit,
    confirm: args.confirm,
    dryRun: args.dryRun,
    nodeEnv: process.env.NODE_ENV ?? "unset",
  });

  const result: RepairResult = {
    totalChecked: 0,
    stillFailed: 0,
    wouldCorrect: 0,
    corrected: 0,
    concurrentUpdatesSkipped: 0,
    errors: 0,
    dryRun: args.dryRun,
  };

  try {
    const candidates = await fetchFalseFailedCandidates(args.batchLimit);
    result.totalChecked = candidates.length;

    for (const row of candidates) {
      try {
        await repairOneRow(row, args, result);
      } catch (error) {
        result.errors += 1;
        console.warn("[RepairFalseFailedBackfill] Failed to repair row (non-fatal)", {
          webPageId: row.id.slice(0, 8) + "...",
          error: sanitizeErrorMessage(error),
        });
      }
    }

    console.log("[RepairFalseFailedBackfill] Result:", result);

    if (result.errors > 0) {
      console.warn(
        `[RepairFalseFailedBackfill] Completed with ${result.errors} errors (non-fatal, see logs)`
      );
    }
  } catch (error) {
    // SEC defense-in-depth: sanitizeErrorMessage で Prisma/SQL 内部構造・
    // DB接続文字列など内部情報の stdout/stderr 漏洩を防止する。
    // SEC defense-in-depth: sanitizeErrorMessage prevents leakage of
    // Prisma/SQL internals or DB connection strings to stdout/stderr.
    console.error("[RepairFalseFailedBackfill] Fatal error:", sanitizeErrorMessage(error));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 直接実行判定（CJS/ESM 両対応、`reconcile-backfill.ts` と同パターン）
 *
 * Direct-run detection (CJS/ESM compatible, same pattern as `reconcile-backfill.ts`).
 */
function isRunDirectly(): boolean {
  try {
    if (typeof require === "undefined" || typeof module === "undefined") {
      return false;
    }
    return require.main === module;
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  main().catch((error) => {
    // v0.4.0 PR-D-5 (FIND-IMPL-IO-15 L): CWE-209 defense —
    // outer catch raw error.message を sanitize。
    console.error("[RepairFalseFailedBackfill] Uncaught error:", sanitizeErrorMessage(error));
    process.exit(1);
  });
}

export {
  main as runRepairFalseFailedBackfillCli,
  parseArgs as __parseArgsForTest,
  repairOneRow as __repairOneRowForTest,
  fetchFalseFailedCandidates as __fetchFalseFailedCandidatesForTest,
};
