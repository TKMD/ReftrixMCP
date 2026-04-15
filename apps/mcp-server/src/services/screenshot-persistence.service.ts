// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Screenshot Persistence Service
 *
 * Phase 0 (Ingest) で取得した fullPage screenshot を、page.analyze 完了後も
 * 永続化パスに保持する。Phase 5 Queue-based Backfill (v0.4.0) が非同期に
 * backfill ジョブを実行する際、元の screenshot にアクセスできるようにする。
 *
 * Persists fullPage screenshots captured during Phase 0 (Ingest) beyond
 * page.analyze completion. Enables Phase 5 Queue-based Backfill (v0.4.0)
 * to access the original screenshot for asynchronous backfill jobs.
 *
 * セキュリティ要件 / Security requirements:
 * - Path Traversal 対策: path.resolve + startsWith allowlist 検証 + symlink 正規化
 *   Path traversal defense via path.resolve + startsWith allowlist + symlink realpath
 * - ファイルパーミッション 0o600（オーナーのみ読み書き） / 0o600 (owner rw only)
 * - ディレクトリパーミッション 0o700（オーナーのみ） / 0o700 (owner only)
 * - ファイル名は webPageId（UUID v4/v7）のみを許可 / Filename must be UUID v4/v7
 * - saveScreenshot サイズ上限（デフォルト 50MB） / saveScreenshot size cap (default 50MB)
 * - cleanupExpired バッチサイズ上限（デフォルト 1000件/実行） / Batch cap (default 1000)
 * - ログ出力時は webPageId を truncate して PII 漏洩を防止 / PII truncation in logs
 *
 * DI: Prisma client は注入可能（テスト容易性） / Prisma client is injectable
 *
 * @module services/screenshot-persistence.service
 */

import fs from "node:fs/promises";
import path from "node:path";
import { logger, isDevelopment } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { truncateId } from "../utils/truncate-id";
import type { IPhase5ScreenshotPersistence } from "./screenshot-persistence.types";
// v0.4.0 PR7d-3 (LCC MEDIUM-2): record TTL cron deletions in audit_logs so the
// TTL-driven erasure path is captured as a processing activity record (GDPR
// Art.30). Import is deferred (lazy access via getAuditLogService()) to keep
// the module load graph lightweight for scripts that never trigger cleanup.
//
// v0.4.0 PR7d-3 (LCC MEDIUM-2): TTL cron での削除を audit_logs に記録する。
// getAuditLogService() の呼び出しは lazy (cleanupExpired 内)。
import { getAuditLogService } from "./audit-log.service";

// Re-export for backward compatibility (既存の import パスを維持)
// Re-export for backward compatibility (preserves existing import paths)
export type { IPhase5ScreenshotPersistence } from "./screenshot-persistence.types";

// =====================================================
// Constants / 定数
// =====================================================

/** Screenshot 永続化ルートディレクトリのデフォルト値 */
/** Default root directory for screenshot persistence */
const DEFAULT_SCREENSHOT_ROOT = "/tmp/reftrix-screenshots";

/** Phase 5 Backfill 用サブディレクトリ名 */
/** Sub-directory name for Phase 5 Backfill */
const PHASE5_SUBDIR = "phase5";

/**
 * UUID v4/v7 のストリクト正規表現（webPageId の形式検証用）
 * Strict regex for UUID v4/v7 (validates webPageId format)
 *
 * RFC 4122 準拠: version nibble は 4 (v4) または 7 (v7)、variant nibble は 8/9/a/b。
 * RFC 4122 compliant: version nibble must be 4 (v4) or 7 (v7), variant nibble 8/9/a/b.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** ファイルパーミッション（オーナー読み書きのみ） */
/** File permission (owner read-write only) */
const FILE_MODE = 0o600;

/** ディレクトリパーミッション（オーナーのみ rwx） */
/** Directory permission (owner rwx only) */
const DIR_MODE = 0o700;

/** Screenshot サイズのデフォルト上限（バイト）: 50MB */
/** Default max screenshot size (bytes): 50MB */
const DEFAULT_MAX_SCREENSHOT_BYTES = 50 * 1024 * 1024;

/** Screenshot サイズの絶対上限（バイト）: 500MB（DoS対策） */
/** Absolute max screenshot size (bytes): 500MB (DoS defense) */
const ABSOLUTE_MAX_SCREENSHOT_BYTES = 500 * 1024 * 1024;

/** cleanupExpired の1実行あたりのデフォルト削除件数上限 */
/** Default batch size cap for cleanupExpired per invocation */
const DEFAULT_CLEANUP_BATCH_SIZE = 1000;

/** cleanupExpired batch size の絶対上限（DoS対策） */
/** Absolute cap for cleanupExpired batch size (DoS defense) */
const ABSOLUTE_CLEANUP_BATCH_SIZE = 100_000;

// =====================================================
// Helpers / ヘルパー
// =====================================================

/**
 * saveScreenshot のサイズ上限を環境変数または定数から解決する
 * Resolve screenshot size cap from env var or constant
 */
function resolveMaxScreenshotBytes(): number {
  const raw = process.env.SCREENSHOT_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_SCREENSHOT_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_SCREENSHOT_BYTES;
  }
  // 絶対上限で clamp
  // Clamp to absolute cap
  return Math.min(parsed, ABSOLUTE_MAX_SCREENSHOT_BYTES);
}

// =====================================================
// Interfaces / インターフェース
// =====================================================

/**
 * Screenshot 永続化サービスの公開 API
 * Public API of the Screenshot Persistence Service
 */
export interface IScreenshotPersistenceService extends IPhase5ScreenshotPersistence {
  /**
   * Screenshot を永続化パスに保存し、web_pages.screenshot_storage_path を更新する
   * Save screenshot to persistence path and update web_pages.screenshot_storage_path
   */
  saveScreenshot(webPageId: string, sourceBuffer: Buffer): Promise<string>;

  /**
   * webPageId に紐づく screenshot の絶対パスを返す（存在しない場合は null）
   * Return absolute path for the screenshot associated with webPageId (null if missing)
   */
  getScreenshotPath(webPageId: string): Promise<string | null>;

  /**
   * Screenshot ファイルを削除し、DB のパスカラムも NULL 化する
   * Delete screenshot file and NULL out the DB path column
   */
  deleteScreenshot(webPageId: string): Promise<void>;

  /**
   * 指定時刻より古い screenshot を一括削除し、対応する DB 行も NULL 化する
   * Cleanup screenshots older than olderThanMs and NULL out corresponding DB rows
   *
   * @param olderThanMs - これより古いファイルを削除（ミリ秒） / Delete files older than this (ms)
   * @param options - オプション（バッチサイズ等） / Options (batch size etc.)
   * @returns 削除したファイル数 / Number of deleted files
   */
  cleanupExpired(olderThanMs: number, options?: CleanupExpiredOptions): Promise<number>;
}

/**
 * cleanupExpired のオプション
 * Options for cleanupExpired
 */
export interface CleanupExpiredOptions {
  /**
   * 1実行で削除する最大件数（DoS対策）
   * Max number of files deleted per invocation (DoS defense)
   *
   * デフォルト: 1000件、絶対上限: 100,000件
   * Default: 1000, absolute cap: 100,000
   */
  maxBatchSize?: number;
}

/**
 * 永続化サービスが使用する Prisma client の最小インターフェース
 * Minimal Prisma client interface used by the persistence service
 *
 * DI のため、Prisma の全 API ではなく使用するメソッドのみを型定義する。
 * Typed only for the methods we actually use, for DI friendliness.
 */
export interface IScreenshotPersistencePrismaClient {
  webPage: {
    update: (args: {
      where: { id: string };
      data: { screenshotStoragePath: string | null };
    }) => Promise<{ id: string }>;
    updateMany: (args: {
      where: { screenshotStoragePath: { in: string[] } };
      data: { screenshotStoragePath: null };
    }) => Promise<{ count: number }>;
    findUnique: (args: {
      where: { id: string };
      select: { screenshotStoragePath: true };
    }) => Promise<{ screenshotStoragePath: string | null } | null>;
  };
}

// =====================================================
// Path Utilities / パスユーティリティ
// =====================================================

/**
 * 解決済み screenshot root のキャッシュ
 *
 * symlink 解決（fs.realpath）を初回呼出時のみ行い、後続呼出はキャッシュ参照する。
 * キーは「入力 raw path」であり、環境変数変更やテスト時の差し替えにも対応する。
 *
 * Cache of resolved screenshot roots. realpath is performed only on first call
 * per raw input path; subsequent calls hit the cache. Keyed by raw input so
 * env var changes / test overrides are respected.
 */
const resolvedRootCache = new Map<string, string>();

/**
 * Screenshot 永続化ルートディレクトリを環境変数から解決する（symlink 正規化付き）
 * Resolve screenshot persistence root from env var (with symlink normalization)
 *
 * `REFTRIX_SCREENSHOT_ROOT` 環境変数を visual-regression.service.ts と共有する。
 * 初回呼出時に `fs.realpath()` で symlink を解決しキャッシュする。ディレクトリが
 * まだ存在しない場合は `path.resolve()` の結果をそのまま返す（path traversal
 * チェックは startsWith 検証に依拠）。
 *
 * Shares the `REFTRIX_SCREENSHOT_ROOT` env var with visual-regression.service.ts.
 * On first call, resolves symlinks via `fs.realpath()` and caches the result.
 * If the directory does not yet exist, returns `path.resolve()` as-is (traversal
 * defense relies on startsWith check).
 */
export async function resolveScreenshotRoot(): Promise<string> {
  const raw = process.env.REFTRIX_SCREENSHOT_ROOT ?? DEFAULT_SCREENSHOT_ROOT;
  const cached = resolvedRootCache.get(raw);
  if (cached !== undefined) return cached;

  const absolute = path.resolve(raw);
  let resolved = absolute;
  try {
    resolved = await fs.realpath(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT: ディレクトリ未作成（初回起動など） — resolve のみで許可
    // ENOENT: directory not yet created (first boot) — fall back to resolve()
    if (code !== "ENOENT") {
      logger.warn("[ScreenshotPersistence] realpath failed; using path.resolve fallback", {
        raw,
        error: sanitizeErrorMessage(err),
      });
    }
  }
  resolvedRootCache.set(raw, resolved);
  return resolved;
}

/**
 * 解決済みルートキャッシュをクリアする（テスト用）
 * Clear resolved root cache (for tests)
 */
export function clearResolvedRootCache(): void {
  resolvedRootCache.clear();
}

/**
 * Phase 5 用 screenshot ディレクトリ（`<root>/phase5/`）を解決する
 * Resolve the Phase 5 screenshot directory (`<root>/phase5/`)
 */
export async function resolvePhase5Dir(): Promise<string> {
  const root = await resolveScreenshotRoot();
  return path.join(root, PHASE5_SUBDIR);
}

/**
 * webPageId (UUID v4/v7) が安全な形式であることを検証する
 * Validate that webPageId matches the strict UUID v4/v7 format
 *
 * パストラバーサル（`../foo`, `/etc/passwd` など）、ヌル文字混入、
 * RFC 4122 非準拠の variant/version を拒否する。
 * Rejects path traversal, null byte injection, and non-RFC 4122 variants.
 */
function assertValidWebPageId(webPageId: string): void {
  if (typeof webPageId !== "string" || webPageId.length === 0) {
    throw new Error("[ScreenshotPersistence] webPageId must be a non-empty string");
  }
  if (!UUID_REGEX.test(webPageId)) {
    throw new Error(
      "[ScreenshotPersistence] webPageId must be a valid UUID v4/v7 (invalid format rejected)"
    );
  }
}

/**
 * webPageId から安全な絶対パスを構築する（Path Traversal 対策）
 * Build a safe absolute path from webPageId (path traversal defense)
 *
 * path.resolve + startsWith で candidate が phase5Dir 配下であることを検証する。
 * Uses path.resolve + startsWith check to ensure candidate is within phase5Dir.
 *
 * @throws Error if the resolved path escapes the Phase 5 directory
 */
async function buildSafeScreenshotPath(webPageId: string): Promise<string> {
  assertValidWebPageId(webPageId);
  const phase5Dir = await resolvePhase5Dir();
  const candidate = path.resolve(phase5Dir, `${webPageId}.png`);

  if (!candidate.startsWith(phase5Dir + path.sep) && candidate !== phase5Dir) {
    throw new Error(
      "[ScreenshotPersistence] Path traversal detected — rejected unsafe screenshot path"
    );
  }
  return candidate;
}

/**
 * 外部入力 (BullMQ Redis / DB 由来) の screenshot パスを allowlist 検証し、
 * realpath で symlink を解消した絶対パスを返す。Phase 5 ディレクトリ配下かつ
 * 実ファイルであることを保証する。
 *
 * Validates a screenshot path received from external input (BullMQ Redis / DB)
 * against the allowlist and resolves symlinks via realpath. Guarantees the
 * path is inside the Phase 5 directory and refers to a real file.
 *
 * SEC H-1 / L-1 (v0.4.0 PR4 audit): `fs.existsSync` + `path.resolve` のみでは
 * TOCTOU と allowlist 欠落により任意パスの読み取りが可能だったため、本関数を
 * 使用して defense in depth を実現する。失敗時は null を返し、呼び出し側は
 * サニタイズしたエラーメッセージでジョブを failed 扱いにすることが想定される。
 *
 * SEC H-1 / L-1 (v0.4.0 PR4 audit): Using only `fs.existsSync` + `path.resolve`
 * allowed arbitrary path reads due to TOCTOU and missing allowlist checks.
 * This helper enforces defense in depth. On failure returns null; callers
 * are expected to mark the job as failed via a sanitized error message.
 *
 * @param candidatePath 検証対象の絶対パス候補 / Candidate absolute path
 * @returns Phase 5 配下であれば realpath 結果、そうでなければ null
 */
export async function validateScreenshotPath(candidatePath: string): Promise<string | null> {
  if (typeof candidatePath !== "string" || candidatePath.length === 0) {
    return null;
  }
  // ヌルバイト混入防御 / Null byte injection defense
  if (candidatePath.includes("\0")) {
    return null;
  }

  const phase5Dir = await resolvePhase5Dir();
  const resolved = path.resolve(candidatePath);

  // 1. allowlist: phase5Dir 配下であることを確認
  //    allowlist: must be inside phase5Dir
  if (!resolved.startsWith(phase5Dir + path.sep) && resolved !== phase5Dir) {
    return null;
  }

  // 2. realpath で symlink を解消（実体パスが逸脱していないか確認）
  //    Resolve symlinks via realpath (ensure the real path does not escape)
  let realPath: string;
  try {
    realPath = await fs.realpath(resolved);
  } catch {
    // ENOENT 等は null 扱い（TOCTOU 防御）
    // Treat ENOENT etc. as null (TOCTOU defense)
    return null;
  }

  // 3. realpath 結果も phase5Dir 配下であることを再検証
  //    Re-check that the realpath result is inside phase5Dir
  if (!realPath.startsWith(phase5Dir + path.sep) && realPath !== phase5Dir) {
    return null;
  }

  // 4. 実ファイルであることを確認（ディレクトリや特殊ファイルを拒否）
  //    Verify it is a regular file (reject directories / special files)
  try {
    const stats = await fs.stat(realPath);
    if (!stats.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  return realPath;
}

// =====================================================
// Service Implementation / サービス実装
// =====================================================

/**
 * ScreenshotPersistenceService の具象実装
 * Concrete implementation of ScreenshotPersistenceService
 *
 * @example
 * ```typescript
 * const service = createScreenshotPersistenceService({ prisma });
 * const absPath = await service.saveScreenshot(webPageId, pngBuffer);
 * ```
 */
class ScreenshotPersistenceService implements IScreenshotPersistenceService {
  constructor(private readonly prisma: IScreenshotPersistencePrismaClient) {}

  async saveScreenshot(webPageId: string, sourceBuffer: Buffer): Promise<string> {
    if (!Buffer.isBuffer(sourceBuffer) || sourceBuffer.length === 0) {
      throw new Error("[ScreenshotPersistence] sourceBuffer must be a non-empty Buffer");
    }

    // サイズ上限チェック（DoS対策） / Size cap check (DoS defense)
    const maxBytes = resolveMaxScreenshotBytes();
    if (sourceBuffer.length > maxBytes) {
      throw new Error(
        `[ScreenshotPersistence] sourceBuffer exceeds max size (${sourceBuffer.length} > ${maxBytes} bytes)`
      );
    }

    const destPath = await buildSafeScreenshotPath(webPageId);
    const destDir = path.dirname(destPath);

    // ディレクトリを 0o700 で作成（recursive は冪等）
    // Create directory with 0o700 (recursive is idempotent)
    await fs.mkdir(destDir, { recursive: true, mode: DIR_MODE });

    // 既存ディレクトリのパーミッションが緩い場合に修正（mkdir は既存では mode を再適用しない）
    // Harden existing directory permissions (mkdir does not re-apply mode on existing dirs)
    try {
      await fs.chmod(destDir, DIR_MODE);
    } catch (chmodError) {
      logger.warn("[ScreenshotPersistence] Failed to chmod destination directory (non-fatal)", {
        destDir,
        error: sanitizeErrorMessage(chmodError),
      });
    }

    // Atomic rename パターン: `<file>.tmp-<pid>-<rand>` に書き込み → rename で差し替え
    // Atomic rename pattern: write to tmp file then rename, avoiding torn writes
    const tmpSuffix = `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const tmpPath = destPath + tmpSuffix;
    try {
      await fs.writeFile(tmpPath, sourceBuffer, { mode: FILE_MODE });
      await fs.rename(tmpPath, destPath);
    } catch (writeError) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        /* tmp may not exist */
      }
      logger.warn("[ScreenshotPersistence] Failed to write screenshot file", {
        webPageId: truncateId(webPageId),
        error: sanitizeErrorMessage(writeError),
      });
      throw new Error("[ScreenshotPersistence] Screenshot write failed");
    }

    // DB の screenshotStoragePath カラムを更新
    // Update the screenshotStoragePath column in DB
    try {
      await this.prisma.webPage.update({
        where: { id: webPageId },
        data: { screenshotStoragePath: destPath },
      });
    } catch (dbError) {
      try {
        await fs.unlink(destPath);
      } catch {
        /* file may have been removed already */
      }
      logger.warn("[ScreenshotPersistence] DB update failed; rolled back screenshot file", {
        webPageId: truncateId(webPageId),
        error: sanitizeErrorMessage(dbError),
      });
      throw new Error("[ScreenshotPersistence] DB update failed");
    }

    if (isDevelopment()) {
      logger.debug("[ScreenshotPersistence] Screenshot persisted", {
        webPageId: truncateId(webPageId),
        destPath,
        bytes: sourceBuffer.length,
      });
    }

    return destPath;
  }

  async getScreenshotPath(webPageId: string): Promise<string | null> {
    assertValidWebPageId(webPageId);

    // DB を先に参照することで、手動で削除されたファイルとの整合性を保つ
    // Consult DB first to stay consistent with manual file deletions
    const row = await this.prisma.webPage.findUnique({
      where: { id: webPageId },
      select: { screenshotStoragePath: true },
    });
    const dbPath = row?.screenshotStoragePath ?? null;
    if (!dbPath) return null;

    // Path Traversal 防御: DB 値も必ず Phase 5 ディレクトリ配下でなければならない
    // Path traversal defense: DB value must also be within phase5 directory
    const phase5Dir = await resolvePhase5Dir();
    const resolved = path.resolve(dbPath);
    if (!resolved.startsWith(phase5Dir + path.sep) && resolved !== phase5Dir) {
      logger.warn("[ScreenshotPersistence] DB path is outside screenshot root — ignoring", {
        webPageId: truncateId(webPageId),
      });
      return null;
    }

    try {
      await fs.access(resolved);
      return resolved;
    } catch {
      // ファイル消失（外部クリーンアップ等） — DB の stale 値を NULL 化
      // File missing (external cleanup) — null out stale DB value
      await this.prisma.webPage
        .update({ where: { id: webPageId }, data: { screenshotStoragePath: null } })
        .catch((updateErr: unknown) => {
          logger.warn("[ScreenshotPersistence] Failed to null stale DB path (non-fatal)", {
            webPageId: truncateId(webPageId),
            error: sanitizeErrorMessage(updateErr),
          });
        });
      return null;
    }
  }

  async deleteScreenshot(webPageId: string): Promise<void> {
    const destPath = await buildSafeScreenshotPath(webPageId);

    // ファイル削除は冪等（ENOENT は無視）
    // File deletion is idempotent (ignore ENOENT)
    try {
      await fs.unlink(destPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn("[ScreenshotPersistence] Failed to delete screenshot file", {
          webPageId: truncateId(webPageId),
          error: sanitizeErrorMessage(err),
        });
      }
    }

    // DB カラムを NULL 化（行が存在しない場合は P2025 → サニタイズして warn）
    // Null out DB column; swallow P2025 (row missing) as warn
    try {
      await this.prisma.webPage.update({
        where: { id: webPageId },
        data: { screenshotStoragePath: null },
      });
    } catch (dbError) {
      logger.warn("[ScreenshotPersistence] Failed to null DB path (non-fatal)", {
        webPageId: truncateId(webPageId),
        error: sanitizeErrorMessage(dbError),
      });
    }
  }

  async cleanupExpired(olderThanMs: number, options?: CleanupExpiredOptions): Promise<number> {
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new Error("[ScreenshotPersistence] olderThanMs must be a non-negative finite number");
    }

    // v0.4.0 PR7d-3 (LCC MEDIUM-2): capture wall-clock start so we can emit
    // `durationMs` in the audit log.
    // v0.4.0 PR7d-3 (LCC MEDIUM-2): 処理時間を audit_logs に記録するため開始時刻を記録。
    const startedAtMs = Date.now();

    // バッチサイズ上限の解決（NaN/負数/過大値を防御）
    // Resolve batch size cap (defend against NaN/negative/oversized values)
    const rawBatch = options?.maxBatchSize;
    let maxBatchSize = DEFAULT_CLEANUP_BATCH_SIZE;
    if (typeof rawBatch === "number" && Number.isFinite(rawBatch) && rawBatch > 0) {
      maxBatchSize = Math.min(Math.floor(rawBatch), ABSOLUTE_CLEANUP_BATCH_SIZE);
    }

    const phase5Dir = await resolvePhase5Dir();
    let entries: string[];
    try {
      entries = await fs.readdir(phase5Dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return 0;
      }
      logger.warn("[ScreenshotPersistence] Failed to read phase5 directory", {
        phase5Dir,
        error: sanitizeErrorMessage(err),
      });
      return 0;
    }

    const cutoffMs = Date.now() - olderThanMs;
    const deletedPaths: string[] = [];

    for (const name of entries) {
      if (deletedPaths.length >= maxBatchSize) break;

      // `.png` 以外（`.tmp-*` 等）はスキップ
      // Skip non-.png files (e.g., dangling .tmp-*)
      if (!name.endsWith(".png")) continue;

      const absPath = path.resolve(phase5Dir, name);
      if (!absPath.startsWith(phase5Dir + path.sep) && absPath !== phase5Dir) {
        continue;
      }

      try {
        const stats = await fs.stat(absPath);
        if (!stats.isFile()) continue;
        if (stats.mtimeMs > cutoffMs) continue;
        await fs.unlink(absPath);
        deletedPaths.push(absPath);
      } catch (err) {
        logger.warn("[ScreenshotPersistence] Failed to process entry (non-fatal)", {
          entry: name,
          error: sanitizeErrorMessage(err),
        });
      }
    }

    // 削除したファイルに対応する DB 行を NULL 化（まとめて updateMany）
    // Null out DB rows that referenced the deleted files (bulk updateMany)
    if (deletedPaths.length > 0) {
      try {
        await this.prisma.webPage.updateMany({
          where: { screenshotStoragePath: { in: deletedPaths } },
          data: { screenshotStoragePath: null },
        });
      } catch (dbError) {
        logger.warn(
          "[ScreenshotPersistence] Failed to null DB paths for cleaned files (non-fatal)",
          { deletedCount: deletedPaths.length, error: sanitizeErrorMessage(dbError) }
        );
      }
    }

    if (isDevelopment() && deletedPaths.length > 0) {
      logger.debug("[ScreenshotPersistence] Cleanup completed", {
        deletedCount: deletedPaths.length,
        olderThanMs,
        maxBatchSize,
      });
    }

    // v0.4.0 PR7d-3 (LCC MEDIUM-2): record the TTL cron deletion as an audit
    // log entry so the automated erasure path is captured as a GDPR Art.30
    // "Records of processing activities" entry. We skip recording zero-delete
    // runs to avoid flooding the audit_logs table with no-op batch cron hits.
    //
    // v0.4.0 PR7d-3 (LCC MEDIUM-2): TTL cron による削除を監査ログに記録する。
    // 0件削除はノイズになるため記録しない。
    if (deletedPaths.length > 0) {
      try {
        await getAuditLogService().log({
          action: "screenshot_ttl_cleanup",
          actor: "system:screenshot-cleanup-cron",
          // batch operation — no single target record; omit targetId.
          // バッチ処理のため単一レコード対象ではない。
          targetType: "web_page_screenshot",
          details: {
            deletedCount: deletedPaths.length,
            batchSize: maxBatchSize,
            olderThanMs,
            durationMs: Date.now() - startedAtMs,
          },
          result: "success",
        });
      } catch {
        // Audit log failure must never block the cleanup result.
        // 監査ログ失敗は cleanup 結果返却を妨げない。
      }
    }

    return deletedPaths.length;
  }
}

// =====================================================
// Factory / ファクトリ
// =====================================================

/**
 * ScreenshotPersistenceService のファクトリ関数
 * Factory function for ScreenshotPersistenceService
 *
 * DI: prisma を外部から注入可能にし、テスト時はモック prisma を差し込める。
 * DI: prisma is injectable so tests can pass a mock client.
 */
export function createScreenshotPersistenceService(deps: {
  prisma: IScreenshotPersistencePrismaClient;
}): IScreenshotPersistenceService {
  return new ScreenshotPersistenceService(deps.prisma);
}
