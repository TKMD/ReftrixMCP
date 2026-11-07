// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Operator CLI: expire full-page screenshots past the retention period.
 * 保持期限を過ぎた終端ページの screenshot を失効させる operator CLI
 *
 * 終端 (completed / failed / not_required / skipped_screenshot_missing) になって
 * `REFTRIX_SCREENSHOT_RETENTION_DAYS` 日 (既定 7、1..30) を過ぎたページの
 * `<REFTRIX_SCREENSHOT_ROOT>/phase5/<id>.png` を削除し、`web_pages.screenshot_storage_path`
 * を NULL にする。worker 内の定期実行 (`cron/screenshot-retention-cron.ts`) と同じ
 * service を使う手動実行用。非終端 (`queued` / `in_progress` / `skipped_*` /
 * `failed_with_known_reason`) は対象外。
 *
 * Expires the persisted screenshot of terminal pages older than the retention period;
 * the same service as the in-worker scheduled run, for manual use.
 *
 * Usage:
 *   pnpm --filter @reftrixmcp/mcp-server exec tsx scripts/expire-screenshots-past-retention.ts            # dry-run (default)
 *   pnpm --filter @reftrixmcp/mcp-server exec tsx scripts/expire-screenshots-past-retention.ts --confirm  # actually delete
 *
 * Safety:
 *   - dry-run が既定。件数と bytes を表示するだけで、ファイルも DB も変えず、audit も書かない。
 *     `--confirm` を付けたときだけ削除する。
 *   - 削除は 1 行ずつ行ロック + 適格条件の再確認 + path の CAS の下で行い、path が
 *     `<phase5>/<id>.png` でない行には触れない。
 *   - `--confirm` で 1 行でも消すと、audit_logs に run 単位で 1 行 (actor は cron と別) 残す。
 *
 * @module scripts/expire-screenshots-past-retention
 */

import "@reftrixmcp/core/assert-node-runtime";
import { PrismaClient } from "@reftrixmcp/database";
import { loadEnvLocal } from "@reftrixmcp/core";
import { AUDIT_ACTOR_SCREENSHOT_RETENTION_OPERATOR } from "../src/audit/audit-actions";
import { bootstrapAuditLogServiceForScript } from "../src/services/audit-log.service";
import {
  ScreenshotRetentionConfigError,
  createScreenshotRetentionService,
  getScreenshotRetentionDays,
  type IScreenshotRetentionService,
  type RetentionCycleResult,
  type RetentionPrismaClient,
} from "../src/services/screenshot-retention.service";
import { sanitizeErrorMessage } from "../src/utils/sanitize-error";

/** CLI が 1 run で見る batch 数 (200 行 x 500 = 10 万行)。全件を数えるため cron より大きい */
export const CLI_MAX_BATCHES = 500;

export interface CliArgs {
  confirm: boolean;
  dryRun: boolean;
}

/** 未知の引数は拒否する (typo で意図せず実削除しないため) / unknown arguments are rejected */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const allowed = new Set(["--confirm", "--dry-run"]);
  for (const a of args) {
    if (!allowed.has(a)) throw new Error(`Unknown argument: ${a.slice(0, 32)}`);
  }
  const confirm = args.includes("--confirm");
  if (confirm && args.includes("--dry-run")) {
    throw new Error("--confirm and --dry-run are mutually exclusive");
  }
  return { confirm, dryRun: !confirm };
}

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** 結果を人が読む形にする (id・path・url は出さない) / human-readable report (no ids, paths or URLs) */
export function formatReport(result: RetentionCycleResult): string {
  const lines: string[] = [];
  lines.push(
    `mode=${result.dryRun ? "dry-run (nothing is deleted)" : "CONFIRMED"} retentionDays=${result.retentionDays}`
  );
  if (result.aborted !== null)
    lines.push(`ABORTED: ${result.aborted} (nothing further was touched)`);
  lines.push(`eligible rows: ${result.scannedCount}`);
  if (result.dryRun) {
    lines.push(`  files that would be deleted: ${result.reclaimableFileCount}`);
    lines.push(`  reclaimable: ${mib(result.reclaimableBytes)} MiB`);
    lines.push(`  path set but file already gone (would clear the path): ${result.absentCount}`);
  } else {
    lines.push(`  deleted: ${result.deletedCount}`);
    lines.push(`  path cleared, file already gone: ${result.absentCount}`);
    lines.push(`  failed (path kept, retry on next run): ${result.failedCount}`);
    lines.push(`  skipped (changed or locked meanwhile): ${result.skippedCount}`);
  }
  lines.push(`  untouched, path is not <phase5>/<id>.png: ${result.invalidPathCount}`);
  if (result.capped) lines.push("MORE REMAIN beyond this run's batch limit; run again.");
  if (result.dryRun) lines.push("Re-run with --confirm to delete.");
  return lines.join("\n");
}

/** CLI の終了コード: 0 = 成功、1 = 失敗した行あり、2 = 中止 (設定ミス・phase5 異常など) */
export const EXIT_OK = 0;
export const EXIT_FAILED_ROWS = 1;
export const EXIT_ABORTED = 2;

export interface RunCliDeps {
  /** 既定は共有 service を `prisma` で組み立てる / defaults to the shared service built on `prisma` */
  service?: IScreenshotRetentionService;
  /** 保持日数 (既定は env) / retention days (defaults to the env) */
  retentionDays?: number;
}

export async function runCli(
  prisma: RetentionPrismaClient,
  args: CliArgs,
  out: (line: string) => void,
  deps: RunCliDeps = {}
): Promise<number> {
  let retentionDays: number;
  try {
    retentionDays = deps.retentionDays ?? getScreenshotRetentionDays();
  } catch (error) {
    if (!(error instanceof ScreenshotRetentionConfigError)) throw error;
    out(`ABORTED: ${error.message}`);
    return EXIT_ABORTED;
  }
  const service = deps.service ?? createScreenshotRetentionService({ prisma });
  const result = await service.runRetentionCycle({
    retentionDays,
    dryRun: args.dryRun,
    actor: AUDIT_ACTOR_SCREENSHOT_RETENTION_OPERATOR,
    maxBatches: CLI_MAX_BATCHES,
  });
  out(formatReport(result));
  if (result.aborted !== null) return EXIT_ABORTED;
  return result.failedCount > 0 ? EXIT_FAILED_ROWS : EXIT_OK;
}

async function main(): Promise<void> {
  loadEnvLocal({ verbose: false });
  const args = parseArgs(process.argv);
  const prisma = new PrismaClient();
  bootstrapAuditLogServiceForScript(prisma);
  try {
    // eslint-disable-next-line no-console
    process.exitCode = await runCli(prisma, args, (line) => console.log(line));
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun =
  typeof require !== "undefined" && require.main === module
    ? true
    : process.argv[1] !== undefined && /expire-screenshots-past-retention/.test(process.argv[1]);

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error("[expire-screenshots-past-retention] fatal:", sanitizeErrorMessage(err));
    process.exit(1);
  });
}
