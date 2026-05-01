#!/usr/bin/env node
// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reconcile Stale Embedding Backfill Jobs — CLI Entrypoint
 *
 * v0.4.0 PR5: `web_pages.embeddingBackfillStatus = 'in_progress'` のページで
 * Queue に該当ジョブが存在しない「ぶら下がり」状態を検出し、DB 完全性に基づいて
 * `completed` / `failed` に補正する。
 *
 * v0.4.0 PR5: Detects "stuck" pages where
 * `web_pages.embeddingBackfillStatus = 'in_progress'` but no corresponding job
 * exists on the queue, and reconciles status to `completed` / `failed` based
 * on DB completeness.
 *
 * v0.4.0 PR6 更新点 / PR6 updates:
 *   - TPA #3: 直接実行判定を `typeof require/module` ガードで CJS/ESM 両対応に書き換え
 *     （mcp-server は現状 CJS、将来 ESM 化時は `import.meta.url` 比較に置換）
 *   - TPA #3: Direct-run check rewritten with `typeof require/module` guards for
 *     CJS/ESM safety (mcp-server is CJS today; swap to `import.meta.url` on ESM migration)
 *   - SEC LOW-2: `--confirm` / `--dry-run` を production で必須化
 *   - SEC LOW-2: `--confirm` / `--dry-run` required in production
 *   - cron 統合: `apps/mcp-server/src/cron/backfill-reconciliation-cron.ts`
 *   - cron integration: `apps/mcp-server/src/cron/backfill-reconciliation-cron.ts`
 *
 * 使い方 / Usage:
 *   pnpm tsx apps/mcp-server/src/scripts/reconcile-backfill.ts --dry-run
 *   pnpm tsx apps/mcp-server/src/scripts/reconcile-backfill.ts --confirm
 *   pnpm tsx apps/mcp-server/src/scripts/reconcile-backfill.ts --confirm --threshold-ms 1800000
 *   pnpm tsx apps/mcp-server/src/scripts/reconcile-backfill.ts --dry-run --batch 100
 *
 * v0.4.0 PR7e-β4 PR1 — added options:
 *   --force-stuck         manual trigger of the stale `in_progress` reconciliation
 *                         path (passed through to `reconcileStaleBackfillJobs`,
 *                         observability log only — the service treats every run
 *                         as eligible for stale detection regardless of this flag,
 *                         but emitting it lets operators record an explicit
 *                         intent in stdout / audit trails).
 *   --older-than-ms <ms>  alias for --threshold-ms; both supported (former takes
 *                         precedence when both are provided). Default 3600000.
 *
 * @module scripts/reconcile-backfill
 */

/* eslint-disable no-console */

import { prisma } from "@reftrixmcp/database";
import { createEmbeddingBackfillQueue } from "../queues/embedding-backfill-queue";
import { reconcileStaleBackfillJobs } from "../services/backfill-reconciliation.service";
import { sanitizeErrorMessage } from "../utils/sanitize-error";

interface CliArgs {
  thresholdMs?: number;
  batchLimit?: number;
  confirm: boolean;
  dryRun: boolean;
  forceStuck: boolean;
}

/**
 * Parse minimal argv. Safe against missing/invalid values (falls through to
 * defaults). No external CLI framework to keep the script lightweight.
 * 最小限の argv パーサ。不正値はデフォルトにフォールバック。
 *
 * v0.4.0 PR7e-β4 PR1: added `--force-stuck` (boolean flag) and `--older-than-ms`
 * (alias of `--threshold-ms`). When both `--threshold-ms` and `--older-than-ms`
 * are present, `--threshold-ms` wins (legacy precedence).
 *
 * v0.4.0 PR7e-β4 PR1: `--force-stuck` (boolean) と `--older-than-ms`
 * (`--threshold-ms` のエイリアス) を追加。両方指定時は `--threshold-ms` 優先 (後方互換)。
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    confirm: argv.includes("--confirm"),
    dryRun: argv.includes("--dry-run"),
    forceStuck: argv.includes("--force-stuck"),
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--threshold-ms" && value !== undefined) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) {
        args.thresholdMs = n;
      }
      i++;
    } else if (key === "--older-than-ms" && value !== undefined) {
      // Alias for --threshold-ms; --threshold-ms takes precedence when both set.
      // --threshold-ms のエイリアス。両方指定時は --threshold-ms 優先。
      if (args.thresholdMs === undefined) {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) {
          args.thresholdMs = n;
        }
      }
      i++;
    } else if (key === "--batch" && value !== undefined) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) {
        args.batchLimit = n;
      }
      i++;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // PR6 SEC LOW-2: Production では明示的な --confirm または --dry-run が必須
  // PR6 SEC LOW-2: Production requires explicit --confirm or --dry-run
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && !args.confirm && !args.dryRun) {
    console.error(
      "[ReconcileBackfill] Production mode requires --confirm flag or --dry-run mode. " +
        "Aborting to prevent accidental runs."
    );
    process.exitCode = 1;
    return;
  }

  // SEC: verbose 出力を拡張する場合、webPageId は truncateId() で先頭8文字に切り詰めること
  // .claude/rules/security.md の PII truncation 規約に準拠
  // SEC: If extending verbose output with webPageId, always apply truncateId()
  // to keep only the first 8 chars (security.md PII truncation policy).
  console.log("[ReconcileBackfill] Starting stale backfill reconciliation");
  console.log("[ReconcileBackfill] Args:", {
    thresholdMs: args.thresholdMs ?? "default(3600000 = 60min)",
    batchLimit: args.batchLimit ?? "default(500)",
    confirm: args.confirm,
    dryRun: args.dryRun,
    // v0.4.0 PR7e-β4 PR1: forceStuck observability
    // v0.4.0 PR7e-β4 PR1: forceStuck の観測性
    forceStuck: args.forceStuck,
    nodeEnv: process.env.NODE_ENV ?? "unset",
  });

  const queue = createEmbeddingBackfillQueue();

  try {
    const options: Parameters<typeof reconcileStaleBackfillJobs>[0] = {
      // PrismaClient プロパティは generated type と互換
      // PrismaClient satisfies the generated type expected by the service
      prisma: prisma as unknown as Parameters<typeof reconcileStaleBackfillJobs>[0]["prisma"],
      queue,
      dryRun: args.dryRun,
    };
    if (args.thresholdMs !== undefined) {
      options.staleThresholdMs = args.thresholdMs;
    }
    if (args.batchLimit !== undefined) {
      options.batchLimit = args.batchLimit;
    }
    const result = await reconcileStaleBackfillJobs(options);

    console.log("[ReconcileBackfill] Result:", result);

    if (result.errors > 0) {
      console.warn(
        `[ReconcileBackfill] Completed with ${result.errors} errors (non-fatal, see logs)`
      );
    }
  } catch (error) {
    // SEC PR6 defense-in-depth: sanitizeErrorMessage で Prisma/SQL 内部構造・
    // DB接続文字列など内部情報の stdout/stderr 漏洩を防止する。
    // SEC PR6 defense-in-depth: sanitizeErrorMessage prevents leakage of
    // Prisma/SQL internals or DB connection strings to stdout/stderr.
    console.error("[ReconcileBackfill] Fatal error:", sanitizeErrorMessage(error));
    process.exitCode = 1;
  } finally {
    await queue.close();
    await prisma.$disconnect();
  }
}

/**
 * 直接実行判定（PR6 TPA #3 — CJS/ESM 両対応）
 *
 * CLI として実行された場合のみ main() を呼ぶ。mcp-server は CommonJS
 * モジュール解決を使用しているため、`require.main === module` を用いる
 * 伝統的な判定をベースにしつつ、将来 ESM 化された際の互換性のため
 * `typeof require/module` ガードで安全に分岐する。
 *
 * Direct-run detection (PR6 TPA #3 — CJS/ESM compatible).
 *
 * Only invokes main() when run as a CLI. mcp-server uses CommonJS module
 * resolution so the canonical `require.main === module` check is used, with
 * `typeof require/module` guards for forward-compatibility.
 *
 * 注 / Note: ESM 化した際はこの条件を `import.meta.url === pathToFileURL(process.argv[1]).href`
 * に置き換えること（ADR-0007 Completed in PR6 §3 参照）。
 * Note: If this module is later converted to ESM, replace this with
 * `import.meta.url === pathToFileURL(process.argv[1]).href` (see ADR-0007 §3).
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
    // v0.4.0 PR-D-5 (FIND-TPA-PLAN-02 M): CWE-209 defense —
    // outer catch raw error.message を sanitize。
    console.error("[ReconcileBackfill] Uncaught error:", sanitizeErrorMessage(error));
    process.exit(1);
  });
}

export { main as runReconcileBackfillCli, parseArgs as __parseArgsForTest };
