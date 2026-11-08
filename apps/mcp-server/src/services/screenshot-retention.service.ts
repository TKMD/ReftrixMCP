// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Screenshot Retention — 終端ページの screenshot を保持期限で失効させる service
 *
 * 終端 (backfill が終わった) ページの `<root>/phase5/<id>.png` を、最後の更新
 * (`web_pages.updated_at`、Prisma `@updatedAt` なので「終端になってから少なくとも N 日」) から
 * N 日 (既定 7 日・範囲 1..30) 後に削除し、DB の path を NULL にする。非終端ページ
 * (backfill がこれから path を読む行) は保持期限の対象にしないが、状態に関係なく最後の更新から
 * `SCREENSHOT_STALE_CAP_DAYS` (30) 日たったページは削除する (止まったページの保持の上限)。path が
 * `<phase5>/<id>.png` でない行は削除せず、run ごとに件数だけ報告する。
 * 失効 cycle (`runRetentionCycle`) は worker 内の定期実行 (`cron/screenshot-retention-cron.ts`)
 * と operator CLI (`scripts/expire-screenshots-past-retention.ts`) から呼ばれる。
 *
 * Expires the screenshot of terminal pages N days (default 7, range 1..30) after their last
 * update (`updated_at`, Prisma `@updatedAt`, i.e. at least N days after the terminal state).
 * `EmbeddingBackfillStatus` is classified exhaustively (a new status fails to compile until
 * classified) and the SQL eligibility predicate is generated from that classification.
 * Non-terminal rows (the backfill still reads their path) are outside the retention period, but
 * any row not updated for `SCREENSHOT_STALE_CAP_DAYS` (30) days is removed whatever its status
 * (the cap on stuck pages); rows whose stored path is not `<phase5>/<id>.png` are reported as one count per run and
 * never deleted. The cycle is driven by the in-worker scheduled run and the operator CLI.
 *
 * @module services/screenshot-retention.service
 */

import fs from "node:fs/promises";
import path from "node:path";
import { EmbeddingBackfillStatus, Prisma } from "@prisma/client";
import {
  AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED,
  AUDIT_ACTOR_SCREENSHOT_RETENTION_CRON,
} from "../audit/audit-actions";
import { logger } from "../utils/logger";
import { truncateId } from "../utils/truncate-id";
import { getAuditLogService, type AuditLogEntry } from "./audit-log.service";
import {
  UUID_REGEX,
  buildSafePathWithinRoot,
  resolvePhase5Dir,
} from "./screenshot-persistence.service";

// =====================================================
// Constants / 定数
// =====================================================

/** 保持日数の env 名 / Retention days env var name */
export const SCREENSHOT_RETENTION_DAYS_ENV = "REFTRIX_SCREENSHOT_RETENTION_DAYS";
/** 既定の保持日数 / Default retention days */
export const SCREENSHOT_RETENTION_DEFAULT_DAYS = 7;
/** 保持日数の下限 / Lower bound (days) */
export const SCREENSHOT_RETENTION_MIN_DAYS = 1;
/** 保持日数の上限 (無効化・長期化は不可) / Upper bound (days) */
export const SCREENSHOT_RETENTION_MAX_DAYS = 30;

/**
 * 上限日数: 状態に関係なく、最後の更新 (`updated_at`) からこの日数たったページの screenshot を消す。
 * 非終端のまま止まったページ (recovery が path を読まなくなったもの、解析が pending のまま等) は
 * 終端にならず保持期限が働かないため、その保持に上限を付ける (ADR-0041 Amendment 5、LCC M-1)。
 * 回復中のページは状態が変わるたびに `updated_at` が進むので対象にならない。env では変えない。
 * 値は終端ページの保持期限の上限 (30 日) と同じ: 運用者が修復できる猶予として、終端ページに
 * 認めている最長の期間をそのまま使う (LCC M-1)。
 *
 * Stale cap: a page whose last update (`updated_at`) is this many days old loses its screenshot,
 * whatever its status. Pages stuck in a non-terminal state never reach the retention period, so
 * this bounds their retention (ADR-0041 Amendment 5, LCC M-1). A page under recovery moves its
 * `updated_at` on every state change and is not affected. Not configurable. The value equals the
 * longest retention allowed for terminal pages (30 days), the same repair grace period (LCC M-1).
 */
export const SCREENSHOT_STALE_CAP_DAYS = SCREENSHOT_RETENTION_MAX_DAYS;

/** 解析が終わった `analysis_status` の値 / Finished `analysis_status` values */
export const RETENTION_TERMINAL_ANALYSIS_STATUSES = ["completed", "failed"] as const;

// =====================================================
// Terminal classification / 終端の網羅表
// =====================================================

export type BackfillStatusClass = "terminal" | "non_terminal";

function assertNeverStatus(status: never): never {
  throw new Error(`Unclassified EmbeddingBackfillStatus: ${JSON.stringify(status)}`);
}

/**
 * `EmbeddingBackfillStatus` の全値を terminal / non_terminal に分類する。
 * 新しい status を enum に足すと、ここが compile error になり分類を強制される。
 *
 * Exhaustive classification of every `EmbeddingBackfillStatus` value; adding a value
 * to the enum is a compile error here until it is classified.
 */
export function classifyBackfillStatusForRetention(
  status: EmbeddingBackfillStatus
): BackfillStatusClass {
  switch (status) {
    case "not_required":
    case "completed":
    case "failed":
    case "skipped_screenshot_missing":
      return "terminal";
    case "queued":
    case "in_progress":
    case "skipped_fork_error":
    case "skipped_memory_pressure":
    case "failed_with_known_reason":
      return "non_terminal";
    default:
      return assertNeverStatus(status);
  }
}

/** 終端の status 一覧 (分類から生成) / Terminal statuses, generated from the classifier */
export const RETENTION_TERMINAL_BACKFILL_STATUSES: readonly EmbeddingBackfillStatus[] =
  Object.values(EmbeddingBackfillStatus).filter(
    (status) => classifyBackfillStatusForRetention(status) === "terminal"
  );

// =====================================================
// Env / 保持日数
// =====================================================

export type RetentionDaysStatus = "ok" | "default" | "clamped" | "invalid";

export interface RetentionDaysResolution {
  /** 解決した日数。`invalid` のときは null (既定値へ黙って戻さない) / null when invalid: no silent fallback */
  days: number | null;
  status: RetentionDaysStatus;
}

/** 保持日数の env が不正 (非整数・0 以下) / The retention days env is invalid */
export class ScreenshotRetentionConfigError extends Error {
  constructor() {
    super(
      `${SCREENSHOT_RETENTION_DAYS_ENV} must be an integer from ${SCREENSHOT_RETENTION_MIN_DAYS} to ${SCREENSHOT_RETENTION_MAX_DAYS}`
    );
    this.name = "ScreenshotRetentionConfigError";
  }
}

/**
 * env 値を保持日数に解決する純関数。未設定・空は既定 7。10 進数字だけを受理し、
 * 30 を超える値は 30 に丸める (指定より短くなりすぎないよう、既定値へは戻さない)。
 * 0 や非整数 (`7days`、`-1`、`1e1`) は `invalid` で、呼出し側が止める。
 *
 * Pure resolver. Unset/empty -> 7. Only decimal digits are accepted; a value above 30 is
 * clamped to 30 (never replaced by the shorter default). 0 and non-integers (`7days`, `-1`,
 * `1e1`) are `invalid` and the caller stops.
 */
export function resolveScreenshotRetentionDays(raw: string | undefined): RetentionDaysResolution {
  if (raw === undefined || raw === "") {
    return { days: SCREENSHOT_RETENTION_DEFAULT_DAYS, status: "default" };
  }
  if (!/^[0-9]+$/.test(raw)) return { days: null, status: "invalid" };
  const n = Number(raw);
  if (n < SCREENSHOT_RETENTION_MIN_DAYS) return { days: null, status: "invalid" };
  if (!Number.isFinite(n) || n > SCREENSHOT_RETENTION_MAX_DAYS) {
    return { days: SCREENSHOT_RETENTION_MAX_DAYS, status: "clamped" };
  }
  return { days: n, status: "ok" };
}

/**
 * env から保持日数を読む。30 超は 30 に丸めて warn (全環境)。不正値は
 * `ScreenshotRetentionConfigError` を投げる (cron は schedule せず error log、CLI は中止)。
 *
 * Read from env; a value above 30 is clamped with a warning (all envs); an invalid value throws
 * `ScreenshotRetentionConfigError` (the cron is not scheduled and logs an error; the CLI aborts).
 */
export function getScreenshotRetentionDays(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[SCREENSHOT_RETENTION_DAYS_ENV];
  const resolved = resolveScreenshotRetentionDays(raw);
  if (resolved.days === null) throw new ScreenshotRetentionConfigError();
  if (resolved.status === "clamped") {
    logger.warn("[ScreenshotRetention] Retention days above the maximum; clamped", {
      envVar: SCREENSHOT_RETENTION_DAYS_ENV,
      maxDays: SCREENSHOT_RETENTION_MAX_DAYS,
    });
  }
  return resolved.days;
}

// =====================================================
// Predicate / 適格条件 (SSOT)
// =====================================================

/**
 * 終端条件: 終端 status かつ解析完了かつ path あり、かつ `updated_at` が cutoff より前。
 * IN 句は分類から生成する (手書きしない)。
 *
 * Terminal part of the eligibility: terminal status, finished analysis, a path, and
 * `updated_at` before the cutoff. The IN lists are generated from the classifier.
 */
export function buildRetentionTerminalPredicate(cutoff: Date): Prisma.Sql {
  return Prisma.sql`embedding_backfill_status::text IN (${Prisma.join([
    ...RETENTION_TERMINAL_BACKFILL_STATUSES,
  ])})
    AND analysis_status IN (${Prisma.join([...RETENTION_TERMINAL_ANALYSIS_STATUSES])})
    AND screenshot_storage_path IS NOT NULL
    AND updated_at < ${cutoff}`;
}

/**
 * 上限の条件: path があり、`updated_at` が上限の cutoff より前 (状態は問わない)。
 * Stale-cap part: a path and `updated_at` before the cap cutoff, whatever the status.
 */
export function buildRetentionStaleCapPredicate(capCutoff: Date): Prisma.Sql {
  return Prisma.sql`screenshot_storage_path IS NOT NULL
    AND updated_at < ${capCutoff}`;
}

/**
 * 期限の条件 = 終端条件 OR 上限の条件。
 * Age part of the eligibility = terminal part OR stale-cap part.
 */
export function buildRetentionAgePredicate(cutoff: Date, capCutoff: Date): Prisma.Sql {
  return Prisma.sql`((${buildRetentionTerminalPredicate(cutoff)})
    OR (${buildRetentionStaleCapPredicate(capCutoff)}))`;
}

/**
 * 保存 path が `<phase5>/<id>.png` に一致する条件。非一致の行を SQL の段階で除くので、
 * 削除できない行が選択窓を埋めて新しい行を止めることがない。
 *
 * The stored path equals `<phase5>/<id>.png`. Rows that do not match are excluded in SQL, so
 * rows that can never be deleted cannot fill the selection window and starve newer rows.
 */
export function buildCanonicalPathPredicate(phase5DirPrefix: string): Prisma.Sql {
  return Prisma.sql`screenshot_storage_path = ${phase5DirPrefix} || id::text || '.png'`;
}

/**
 * 失効の適格条件 = 期限の条件 (終端 OR 上限) + 正規 path。batch 選択と行ロックの再確認の両方が
 * この 1 つを使う。
 *
 * Eligibility = age part (terminal OR stale cap) + canonical path; shared by batch selection and
 * the row-lock re-check.
 */
export function buildRetentionEligibilityPredicate(
  cutoff: Date,
  phase5DirPrefix: string,
  capCutoff: Date
): Prisma.Sql {
  return Prisma.sql`${buildRetentionAgePredicate(cutoff, capCutoff)}
    AND ${buildCanonicalPathPredicate(phase5DirPrefix)}`;
}

/** 期限を過ぎたが path が正規でない行 (報告のみ、削除しない) / Rows past their period with a non-canonical path (reported, never deleted) */
export function buildNonCanonicalPathPredicate(
  cutoff: Date,
  phase5DirPrefix: string,
  capCutoff: Date
): Prisma.Sql {
  return Prisma.sql`${buildRetentionAgePredicate(cutoff, capCutoff)}
    AND NOT (${buildCanonicalPathPredicate(phase5DirPrefix)})`;
}

// =====================================================
// Cycle limits / run の上限
// =====================================================

/** 1 batch の行数 / Rows per batch */
export const RETENTION_BATCH_SIZE = 200;
/** 1 run で「消す」行の batch 数 (消せなかった・skip した行は数えない) / Batches of rows cleared per run (failed / skipped rows do not count) */
export const RETENTION_MAX_BATCHES = 10;
/** 走査する batch 数は消す batch 数の何倍まで (CWE-770) / Scan budget as a multiple of the cleared budget */
export const RETENTION_SCAN_BATCH_MULTIPLIER = 10;
/** 1 run で走査する最大 batch 数 (上の 2 定数から derive) / Max batches scanned per run (derived) */
export const RETENTION_MAX_SCAN_BATCHES = RETENTION_MAX_BATCHES * RETENTION_SCAN_BATCH_MULTIPLIER;
/** operator CLI が指定できる batch 数の絶対上限 (CWE-770) / hard cap on a CLI-requested batch count */
export const RETENTION_ABSOLUTE_MAX_BATCHES = 1000;
/** 1 run で消す最大行数 (CWE-770、上の 2 定数から derive) / Max rows cleared per run (derived) */
export const RETENTION_MAX_ROWS_PER_RUN = RETENTION_BATCH_SIZE * RETENTION_MAX_BATCHES;

/** 1 行 tx がロック取得を待つ上限 (ms) / Max wait to open the per-row tx (ms) */
export const RETENTION_ROW_TX_MAX_WAIT_MS = 5_000;
/** 1 行 tx 全体の上限 (ms、待ち時間の 3 倍: SELECT + unlink + UPDATE) / Whole per-row tx limit (ms) */
export const RETENTION_ROW_TX_TIMEOUT_MS = RETENTION_ROW_TX_MAX_WAIT_MS * 3;
/** 1 日の ms (cutoff の計算用) / Milliseconds per day (cutoff calculation) */
export const RETENTION_MS_PER_DAY = 24 * 60 * 60 * 1000;

// =====================================================
// Types / 型
// =====================================================

/** ファイル削除の結果 / Result of removing one file */
export type RetentionFileOutcome = "deleted" | "absent" | "failed";
/** 1 行の結果 (skipped = 既に適格でない / ロック中) / Result for one row */
export type RetentionRowOutcome = RetentionFileOutcome | "skipped";
export type RetentionAbortReason =
  | "phase5_dir_missing"
  | "phase5_dir_unsafe"
  /** worker shutdown (`shouldStop`) / ワーカー停止による中断 */
  | "stopped"
  /** consecutive per-row tx errors (DB down) / DB 障害で連続失敗 */
  | "db_error_streak";

export interface RetentionCycleResult {
  dryRun: boolean;
  retentionDays: number;
  aborted: RetentionAbortReason | null;
  scannedCount: number;
  deletedCount: number;
  absentCount: number;
  failedCount: number;
  skippedCount: number;
  /** path が `<phase5>/<id>.png` でない行 (ファイルにも DB にも触れない) / rows left untouched: stored path is not the canonical one */
  invalidPathCount: number;
  /** dry-run のとき、実ファイルがあり削除対象になる行数。実削除では 0 */
  reclaimableFileCount: number;
  batches: number;
  /** 上限 (batch 数) に達して、まだ対象が残っているかもしれないとき true */
  capped: boolean;
  /** dry-run のとき、削除対象ファイルの合計 bytes。実削除では 0 */
  reclaimableBytes: number;
  durationMs: number;
}

/** tx 内で使う Prisma の最小面 / Minimal Prisma surface inside a transaction */
export interface RetentionTx {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
}

export interface RetentionPrismaClient extends RetentionTx {
  $transaction<R>(
    fn: (tx: RetentionTx) => Promise<R>,
    options?: { maxWait?: number; timeout?: number }
  ): Promise<R>;
}

export interface RetentionAuditSink {
  log(entry: AuditLogEntry): Promise<void>;
}

export interface ScreenshotRetentionDeps {
  prisma: RetentionPrismaClient;
  /** 既定は `getAuditLogService()` / defaults to the shared audit log service */
  auditLog?: RetentionAuditSink;
  /** テスト用の時計 / clock for tests */
  now?: () => Date;
  /** テスト用の batch 行数 (既定 200) / batch size override for tests */
  batchSize?: number;
}

export interface RetentionCycleOptions {
  retentionDays: number;
  dryRun: boolean;
  /** audit の actor (既定は cron)。CLI は別 actor を渡して Art.30 で区別する / audit actor; the CLI passes its own */
  actor?: string;
  /** 1 run の batch 数 (既定 10、上限 1000)。operator CLI が全件を数えるために使う / batches per run (default 10, hard cap 1000); the CLI uses it to count everything */
  maxBatches?: number;
  /** true を返すと行の間で中断する (worker shutdown) / returns true to stop between rows */
  shouldStop?: () => boolean;
}

export interface IScreenshotRetentionService {
  runRetentionCycle(options: RetentionCycleOptions): Promise<RetentionCycleResult>;
}

// =====================================================
// One row / 1 行の失効
// =====================================================

/**
 * ファイルを 1 つ消す。ENOENT は absent、それ以外の失敗は failed (path を残すため)。
 * Removes one file: ENOENT is `absent`, any other failure is `failed` (the path stays).
 */
export async function removeScreenshotFile(
  filePath: string,
  webPageId: string
): Promise<RetentionFileOutcome> {
  try {
    await fs.unlink(filePath);
    return "deleted";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    logger.warn("[ScreenshotRetention] Failed to delete screenshot file; path kept", {
      webPageId: truncateId(webPageId),
      error: rawMessage(error, filePath),
    });
    return "failed";
  }
}

// =====================================================
// Cycle / run
// =====================================================

/**
 * phase5 ディレクトリが実ディレクトリであることを確かめる (fail-closed)。不在・symlink・
 * ディレクトリ以外のときは中止の理由を返し、呼出し側は何も触らない。root の食い違いで
 * DB の path だけを NULL にしないための確認でもある。
 *
 * Checks that the phase5 directory is a real directory (fail-closed). Returns the abort
 * reason when it is missing, a symlink or not a directory; the caller then touches nothing
 * (this also stops a root mismatch from NULLing DB paths while the files live elsewhere).
 */
export async function checkPhase5Dir(phase5Dir: string): Promise<RetentionAbortReason | null> {
  try {
    const stats = await fs.lstat(phase5Dir);
    return stats.isSymbolicLink() || !stats.isDirectory() ? "phase5_dir_unsafe" : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "phase5_dir_missing"
      : "phase5_dir_unsafe";
  }
}

// =====================================================
// Cycle / 失効 cycle
// =====================================================

/** この回数だけ連続で行 tx が例外になったら run を中断する / consecutive row-tx errors that abort a run */
export const RETENTION_DB_ERROR_STREAK_LIMIT = 3;

/** audit の対象種別 / audit target type */
const AUDIT_TARGET_TYPE = "screenshot";
/** run 単位の記録なので特定ページの id は持たない / run-level record: no single page id */
const AUDIT_TARGET_ID_RUN = "all";

interface CandidateRow {
  id: string;
  path: string;
}

/** run の間変わらない値 / Values fixed for the whole run */
interface RunContext {
  phase5Dir: string;
  /** `<phase5>/` (SQL の正規 path 比較に使う) / used by the SQL canonical-path match */
  dirPrefix: string;
  cutoff: Date;
  /** 上限の cutoff (`now - SCREENSHOT_STALE_CAP_DAYS`) / stale-cap cutoff */
  capCutoff: Date;
}

interface RunLimits {
  /** 消す行数の上限 / cap on rows cleared */
  clearedCap: number;
  /** 走査する batch 数の上限 / cap on batches scanned */
  scanBatchCap: number;
}

/** run をまたいで進む位置 / Position carried through one run */
interface RunCursor {
  lastId: string | null;
  errorStreak: number;
}

/** 行の結果 (error = tx が例外) / Row outcome (error = the tx threw) */
type RowResult = RetentionRowOutcome | "error";

/**
 * server-side の log 用の生のメッセージ。fs の error は path (= webPageId を含む) を含むので、
 * 渡された path だけを伏せる (rules/security.md: server log は raw message、PII は truncate)。
 * Raw message for server-side logs; the file path (which carries the webPageId) is masked.
 */
function rawMessage(error: unknown, maskPath?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return maskPath === undefined ? message : message.split(maskPath).join("<screenshot-path>");
}

/**
 * 行の path が `<phase5>/<id>.png` に一致するときだけ、その path を返す (SQL の正規 path 条件の
 * 二重化)。id は UUID 検証し、path は既存の `buildSafePathWithinRoot` で組み立てる。
 * Returns the canonical path only when the stored path equals `<phase5>/<id>.png` (a second
 * layer behind the SQL match; id UUID-validated, path built by `buildSafePathWithinRoot`).
 */
function canonicalScreenshotPath(phase5Dir: string, row: CandidateRow): string | null {
  if (!UUID_REGEX.test(row.id)) return null;
  try {
    const canonical = buildSafePathWithinRoot(phase5Dir, `${row.id}.png`);
    return canonical === row.path ? canonical : null;
  } catch {
    return null;
  }
}

function validBatches(requested: number | undefined): number {
  return requested !== undefined && Number.isInteger(requested) && requested >= 1
    ? Math.min(requested, RETENTION_ABSOLUTE_MAX_BATCHES)
    : RETENTION_MAX_BATCHES;
}

/** 数えた「消した (または消す予定の)」行数 / Rows cleared (or, in a dry-run, that would be) */
function clearedRows(result: RetentionCycleResult): number {
  return result.dryRun
    ? result.reclaimableFileCount + result.absentCount
    : result.deletedCount + result.absentCount;
}

class ScreenshotRetentionService implements IScreenshotRetentionService {
  private readonly prisma: RetentionPrismaClient;
  private readonly auditLog: RetentionAuditSink | undefined;
  private readonly now: () => Date;
  private readonly batchSize: number;

  constructor(deps: ScreenshotRetentionDeps) {
    this.prisma = deps.prisma;
    this.auditLog = deps.auditLog;
    this.now = deps.now ?? ((): Date => new Date());
    this.batchSize = deps.batchSize ?? RETENTION_BATCH_SIZE;
  }

  async runRetentionCycle(options: RetentionCycleOptions): Promise<RetentionCycleResult> {
    const startedAt = Date.now();
    const result: RetentionCycleResult = {
      dryRun: options.dryRun,
      retentionDays: options.retentionDays,
      aborted: null,
      scannedCount: 0,
      deletedCount: 0,
      absentCount: 0,
      failedCount: 0,
      skippedCount: 0,
      invalidPathCount: 0,
      reclaimableFileCount: 0,
      batches: 0,
      capped: false,
      reclaimableBytes: 0,
      durationMs: 0,
    };

    const phase5Dir = await resolvePhase5Dir();
    result.aborted = await checkPhase5Dir(phase5Dir);
    if (result.aborted !== null) {
      logger.warn("[ScreenshotRetention] Aborted; nothing was touched", {
        reason: result.aborted,
      });
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    const ctx: RunContext = {
      phase5Dir,
      dirPrefix: phase5Dir + path.sep,
      cutoff: new Date(this.now().getTime() - options.retentionDays * RETENTION_MS_PER_DAY),
      capCutoff: new Date(this.now().getTime() - SCREENSHOT_STALE_CAP_DAYS * RETENTION_MS_PER_DAY),
    };

    try {
      await this.reportNonCanonical(ctx, result);
      await this.runBatches(options, ctx, result);
    } finally {
      // 途中で例外になっても、既に消した分は Art.30 に残す / record what was cleared even if a later step threw
      result.durationMs = Date.now() - startedAt;
      if (!options.dryRun) await this.emitAudit(options, result);
    }
    return result;
  }

  /**
   * path が正規でない終端行を数え、run あたり 1 回だけ warn する (削除はしない)。
   * Counts terminal rows with a non-canonical path and warns once per run (never deleted).
   */
  private async reportNonCanonical(ctx: RunContext, result: RetentionCycleResult): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number | bigint }>>(
      Prisma.sql`SELECT count(*)::int AS count FROM web_pages
        WHERE ${buildNonCanonicalPathPredicate(ctx.cutoff, ctx.dirPrefix, ctx.capCutoff)}`
    );
    const count = Number(rows[0]?.count ?? 0);
    result.invalidPathCount = Number.isFinite(count) ? count : 0;
    if (result.invalidPathCount > 0) {
      logger.warn(
        "[ScreenshotRetention] Rows with a non-canonical stored path are reported, not deleted",
        {
          count: result.invalidPathCount,
        }
      );
    }
  }

  private async runBatches(
    options: RetentionCycleOptions,
    ctx: RunContext,
    result: RetentionCycleResult
  ): Promise<void> {
    const batches = validBatches(options.maxBatches);
    const limits: RunLimits = {
      clearedCap: batches * this.batchSize,
      scanBatchCap: batches * RETENTION_SCAN_BATCH_MULTIPLIER,
    };
    const cursor: RunCursor = { lastId: null, errorStreak: 0 };
    while (result.batches < limits.scanBatchCap) {
      const rows = await this.selectBatch(ctx, cursor.lastId);
      if (rows.length === 0) return;
      result.batches += 1;
      if (await this.processBatch(rows, options, ctx, result, cursor, limits)) return;
      if (rows.length < this.batchSize) return;
    }
    // 走査の上限に達した: まだ残っているかもしれない / scan budget reached: more may remain
    result.capped = true;
  }

  /** @returns true なら run を止める / true when the run must stop */
  private async processBatch(
    rows: CandidateRow[],
    options: RetentionCycleOptions,
    ctx: RunContext,
    result: RetentionCycleResult,
    cursor: RunCursor,
    limits: RunLimits
  ): Promise<boolean> {
    for (const row of rows) {
      cursor.lastId = row.id;
      if (options.shouldStop?.() === true) {
        result.aborted = "stopped";
        return true;
      }
      result.scannedCount += 1;
      const stop = await this.processRow(row, options, ctx, result, cursor);
      if (stop) return true;
      // 消せなかった・skip した行は数えない: 窓を埋めて新しい行を止めない / failed and skipped rows do not count
      if (clearedRows(result) >= limits.clearedCap) {
        result.capped = true;
        return true;
      }
    }
    return false;
  }

  /** @returns true なら run を止める (DB 障害の連続) / true on a DB error streak */
  private async processRow(
    row: CandidateRow,
    options: RetentionCycleOptions,
    ctx: RunContext,
    result: RetentionCycleResult,
    cursor: RunCursor
  ): Promise<boolean> {
    const canonical = canonicalScreenshotPath(ctx.phase5Dir, row);
    if (canonical === null) {
      // SQL が除いているはずの行。通ってきたら触らず skip (二重の防御) / defense in depth
      result.skippedCount += 1;
      return false;
    }
    if (options.dryRun) {
      await this.previewRow(canonical, result);
      return false;
    }
    const outcome = await this.expireRow(row, canonical, ctx);
    cursor.errorStreak = outcome === "error" ? cursor.errorStreak + 1 : 0;
    this.tally(result, outcome);
    if (cursor.errorStreak < RETENTION_DB_ERROR_STREAK_LIMIT) return false;
    result.aborted = "db_error_streak";
    logger.warn("[ScreenshotRetention] Consecutive DB errors; run aborted", {
      streak: cursor.errorStreak,
    });
    return true;
  }

  /** 適格な行を id 順の keyset で 1 batch 取る / one batch of eligible rows, keyset by id */
  private async selectBatch(ctx: RunContext, lastId: string | null): Promise<CandidateRow[]> {
    const after = lastId === null ? Prisma.empty : Prisma.sql`AND id > ${lastId}::uuid`;
    return this.prisma.$queryRaw<CandidateRow[]>(
      Prisma.sql`SELECT id::text AS id, screenshot_storage_path AS path
        FROM web_pages
        WHERE ${buildRetentionEligibilityPredicate(ctx.cutoff, ctx.dirPrefix, ctx.capCutoff)}
        ${after}
        ORDER BY id
        LIMIT ${this.batchSize}`
    );
  }

  /** dry-run: 実ファイルの有無と大きさだけ数える (何も変えない) / count only, change nothing */
  private async previewRow(filePath: string, result: RetentionCycleResult): Promise<void> {
    try {
      const stats = await fs.lstat(filePath);
      result.reclaimableFileCount += 1;
      result.reclaimableBytes += stats.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") result.absentCount += 1;
      else result.failedCount += 1;
    }
  }

  private tally(result: RetentionCycleResult, outcome: RowResult): void {
    switch (outcome) {
      case "deleted":
        result.deletedCount += 1;
        return;
      case "absent":
        result.absentCount += 1;
        return;
      case "skipped":
        result.skippedCount += 1;
        return;
      case "failed":
      case "error":
        result.failedCount += 1;
        return;
    }
  }

  /**
   * 1 行を失効させる (1 tx)。順序は「行ロック + 再確認 -> ファイル削除 -> path を NULL」。
   *
   * ファイルを先に消す理由: DB を先に更新すると、その後の unlink が失敗したとき
   * ファイルだけが残り、DB にも path が無いので二度と見つからない (PII の残存)。
   * ファイル先なら、unlink 失敗は path を残したまま次の run で再試行でき、unlink 成功後に
   * UPDATE / commit が失敗しても path が残るだけで、次の run が ENOENT (absent) として
   * path を NULL にする。どの失敗でも「DB に path が無いのにファイルが残る」状態にならない。
   * 行ロック (FOR UPDATE SKIP LOCKED) は適格条件の再確認と path の一致 (CAS) を伴うので、
   * 並走する run や status 遷移とは、先に取った側だけが進み、もう一方は skipped になる。
   *
   * 再解析との関係: page.analyze は screenshot を保存する前に (Phase 0 の upsert / W0 で)
   * `analysis_status` を `pending` に戻すので、再解析中のページは終端条件から外れ、
   * 新しいファイルを古い選択のまま消すことはない。選択後に再解析が始まっても、
   * 行ロックの再確認が `analysis_status` を見て skipped にする。上限の条件 (状態を問わない) に
   * 対しては、Phase 0 の upsert が新しい screenshot を保存する前に `updated_at` を進めることで守る
   * (raw SQL で状態を変える writer を足すと `updated_at` が進まず、この前提が崩れる)。
   *
   * Order: row lock + re-check -> delete file -> NULL the path, in one tx. The file goes
   * first because the reverse order can strand a file with no DB pointer (never found again,
   * PII retained); file-first only ever leaves a pointer without a file, which the next run
   * clears as `absent`. The lock re-checks eligibility and that the path still equals the
   * selected value (compare-and-set); a concurrent run skips. Re-analysis: page.analyze resets
   * `analysis_status` to `pending` before it saves a new screenshot, so a page being re-analyzed
   * is outside the terminal predicate, and the lock re-check skips a row that started
   * re-analysis after it was selected. Against the stale cap (any status), the protection is that
   * the Phase 0 upsert moves `updated_at` before the new screenshot is saved; a writer that changes
   * state with raw SQL would not move `updated_at` and would break this.
   */
  private async expireRow(
    row: CandidateRow,
    filePath: string,
    ctx: RunContext
  ): Promise<RowResult> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`SELECT id::text AS id FROM web_pages
              WHERE id = ${row.id}::uuid
                AND screenshot_storage_path = ${row.path}
                AND ${buildRetentionEligibilityPredicate(ctx.cutoff, ctx.dirPrefix, ctx.capCutoff)}
              FOR UPDATE SKIP LOCKED`
          );
          if (locked.length === 0) return "skipped";
          const fileOutcome = await removeScreenshotFile(filePath, row.id);
          if (fileOutcome === "failed") return "failed";
          await tx.$executeRaw(
            Prisma.sql`UPDATE web_pages SET screenshot_storage_path = NULL
              WHERE id = ${row.id}::uuid AND screenshot_storage_path = ${row.path}`
          );
          return fileOutcome;
        },
        { maxWait: RETENTION_ROW_TX_MAX_WAIT_MS, timeout: RETENTION_ROW_TX_TIMEOUT_MS }
      );
    } catch (error) {
      logger.warn("[ScreenshotRetention] Row expiry failed; path kept for the next run", {
        webPageId: truncateId(row.id),
        error: rawMessage(error, filePath),
      });
      return "error";
    }
  }

  /**
   * path を 1 行でも NULL にした実削除 run だけ、run 単位で 1 行 audit を書く (Art.30)。
   * details は PII を含まない数値のみ。audit の失敗は致命的でない (warn)。
   */
  private async emitAudit(
    options: RetentionCycleOptions,
    result: RetentionCycleResult
  ): Promise<void> {
    if (result.deletedCount + result.absentCount <= 0) return;
    try {
      const sink = this.auditLog ?? getAuditLogService();
      await sink.log({
        action: AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED,
        actor: options.actor ?? AUDIT_ACTOR_SCREENSHOT_RETENTION_CRON,
        targetType: AUDIT_TARGET_TYPE,
        targetId: AUDIT_TARGET_ID_RUN,
        details: {
          retentionDays: result.retentionDays,
          staleCapDays: SCREENSHOT_STALE_CAP_DAYS,
          deletedCount: result.deletedCount,
          absentCount: result.absentCount,
          failedCount: result.failedCount,
          skippedCount: result.skippedCount,
          invalidPathCount: result.invalidPathCount,
          batches: result.batches,
          capped: result.capped,
          durationMs: result.durationMs,
        },
        result: "success",
      });
    } catch (error) {
      logger.warn("[ScreenshotRetention] Audit emit failed (non-fatal)", {
        error: rawMessage(error),
      });
    }
  }
}

/** DI factory / ファクトリ */
export function createScreenshotRetentionService(
  deps: ScreenshotRetentionDeps
): IScreenshotRetentionService {
  return new ScreenshotRetentionService(deps);
}
