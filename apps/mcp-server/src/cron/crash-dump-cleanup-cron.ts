// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Crash Dump TTL Cleanup Cron — Periodic removal of expired crash dumps (Wave 3 PR3b)
 *
 * Plan v3 T2 V1 §4.4 + §4.5 Δ6. Drives the public crash dump retention:
 *
 *   1. **TTL enforcement** (7d): files older than `olderThanMs` (default 7d)
 *      are deleted. Audit `worker_crash_dump_cleanup` emitted on
 *      `deletedCount > 0` (zero-noise emit suppressed).
 *   2. **Per-worker-type disk cap** (500MB): if a workerType subdir exceeds
 *      the budget, oldest files are deleted until under cap.
 *   3. **Δ6 Orphan detection**: scan all dump files; for each, query
 *      `audit_logs` for a matching `worker_crash_report_emitted` entry within
 *      the past 24h. If none exists, the watcher missed the event (R6).
 *      Emit `worker_crash_report_orphaned` for self-healing GDPR Art.30
 *      completeness.
 *
 * **Cron driver**: `setInterval` (consistent with `screenshot-cleanup-cron`).
 * No BullMQ queue needed — cleanup is filesystem + audit_logs DB only.
 *
 * @module cron/crash-dump-cleanup-cron
 * @see Plan v3 T2 V1 §4.4 + §4.5 Δ6
 * @see ADR-0021 §"Storage Strategy" + §"Self-Healing Audit Trail"
 * @see DATA_RETENTION.md §11.11 (7d TTL rationale)
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getAuditLogService, truncateAuditTargetId } from "../services/audit-log.service";
import {
  CRASH_DUMP_PER_TYPE_DISK_CAP_BYTES,
  diskUsageBytes,
  validateCrashDumpPath,
} from "../services/crash-dump-persistence.service";
import {
  AUDIT_ACTION_WORKER_CRASH_DUMP_CLEANUP,
  AUDIT_ACTION_WORKER_CRASH_REPORT_ORPHANED,
} from "../audit/audit-actions";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000; // 7d (DATA_RETENTION.md §11.11)
const DEFAULT_MAX_BATCH_SIZE = 1000;
const DEFAULT_ORPHAN_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h

// ============================================================================
// Public API
// ============================================================================

export interface CrashDumpCleanupOptions {
  /** Public crash dump root (from `resolveCrashDumpRoot()`). */
  publicRoot: string;
  /** Interval between cron ticks (default 24h). */
  intervalMs?: number;
  /** TTL — files older than this are deleted (default 7d). */
  olderThanMs?: number;
  /** Max files deleted per tick (default 1000). */
  maxBatchSize?: number;
  /** Orphan-detection lookback window (default 24h). */
  orphanLookbackMs?: number;
  /** Whether to fire once immediately on start (default false). */
  runOnStart?: boolean;
  /** Per-worker-type disk cap (default 500MB). */
  perTypeDiskCapBytes?: number;
}

export interface CrashDumpCleanupHandle {
  stop: () => void;
  /** Manual one-shot invocation (used by tests). */
  runOnce: () => Promise<CrashDumpCleanupResult>;
}

export interface CrashDumpCleanupResult {
  deletedCount: number;
  orphanCount: number;
  disksOverCapWorkerTypes: string[];
}

// ============================================================================
// Scheduler
// ============================================================================

export function scheduleCrashDumpCleanupCron(
  options: CrashDumpCleanupOptions
): CrashDumpCleanupHandle {
  const intervalMs = validatePositive(
    options.intervalMs ?? DEFAULT_INTERVAL_MS,
    DEFAULT_INTERVAL_MS
  );
  const olderThanMs = validatePositive(
    options.olderThanMs ?? DEFAULT_OLDER_THAN_MS,
    DEFAULT_OLDER_THAN_MS
  );
  const maxBatchSize = validatePositive(
    options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
    DEFAULT_MAX_BATCH_SIZE
  );
  const orphanLookbackMs = validatePositive(
    options.orphanLookbackMs ?? DEFAULT_ORPHAN_LOOKBACK_MS,
    DEFAULT_ORPHAN_LOOKBACK_MS
  );
  const perTypeDiskCapBytes = validatePositive(
    options.perTypeDiskCapBytes ?? CRASH_DUMP_PER_TYPE_DISK_CAP_BYTES,
    CRASH_DUMP_PER_TYPE_DISK_CAP_BYTES
  );

  let stopped = false;
  let inFlight = false;
  const publicRoot = options.publicRoot;

  const runOnce = async (): Promise<CrashDumpCleanupResult> => {
    if (inFlight) {
      return { deletedCount: 0, orphanCount: 0, disksOverCapWorkerTypes: [] };
    }
    inFlight = true;
    try {
      return await cleanupExpired({
        publicRoot,
        olderThanMs,
        maxBatchSize,
        orphanLookbackMs,
        perTypeDiskCapBytes,
      });
    } finally {
      inFlight = false;
    }
  };

  const tick = (): void => {
    if (stopped) return;
    void runOnce().catch((err: unknown) => {
      logger.warn("[CrashDumpCleanupCron] tick failed (non-fatal)", {
        error: sanitizeErrorMessage(err),
      });
    });
  };

  if (options.runOnStart === true) {
    tick();
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stop: (): void => {
      stopped = true;
      clearInterval(timer);
    },
    runOnce,
  };
}

// ============================================================================
// Core cleanup implementation
// ============================================================================

interface CleanupExpiredParams {
  publicRoot: string;
  olderThanMs: number;
  maxBatchSize: number;
  orphanLookbackMs: number;
  perTypeDiskCapBytes: number;
}

/**
 * Wave 4 Part C TDA M-1a SRP refactor (V6 §2.4.2):
 * `cleanupExpired` was CC≈23 prior to extraction. Decomposed into 5 single-
 * responsibility helpers: `listWorkerTypeSubdirs` / `walkWorkerTypeRoles` /
 * `deleteExpiredFilesInRole` / `enforcePerTypeDiskCap` / `emitCleanupAudit`.
 * All helpers CC ≤ 5 (Wave 1 T3-Vision `pollVramResidual` 8-helper precedent).
 * Behaviour-preserving: 7/7 cleanup-cron tests + 8/8 watcher tests + standing
 * regression all pass post-refactor.
 *
 * Wave 4 Part C TDA M-1a SRP refactor: `cleanupExpired` を CC ≤ 5 の単一責任
 * helper 5 件に分解。挙動互換 (テスト全 PASS で検証)。
 */
export async function cleanupExpired(
  params: CleanupExpiredParams
): Promise<CrashDumpCleanupResult> {
  const { publicRoot, olderThanMs, perTypeDiskCapBytes } = params;

  const workerTypes = await listWorkerTypeSubdirs(publicRoot);
  if (workerTypes === null) {
    return { deletedCount: 0, orphanCount: 0, disksOverCapWorkerTypes: [] };
  }

  const accumulator: CleanupAccumulator = {
    deletedCount: 0,
    orphanCount: 0,
    disksOverCapWorkerTypes: [],
  };
  const now = Date.now();

  for (const workerType of workerTypes) {
    await walkWorkerTypeRoles({ publicRoot, workerType, now, params, accumulator });
  }

  await emitCleanupAudit({
    deletedCount: accumulator.deletedCount,
    olderThanMs,
    perTypeDiskCapBytes,
    disksOverCapWorkerTypes: accumulator.disksOverCapWorkerTypes,
  });

  return {
    deletedCount: accumulator.deletedCount,
    orphanCount: accumulator.orphanCount,
    disksOverCapWorkerTypes: accumulator.disksOverCapWorkerTypes,
  };
}

// ============================================================================
// Wave 4 Part C TDA M-1a — extracted helpers (each CC ≤ 5)
// ============================================================================

/**
 * Mutable accumulator threaded through the per-role helpers. Keeps the
 * helper signatures small (CC ≤ 5) while preserving the original
 * `cleanupExpired` early-break on `maxBatchSize` exhaustion.
 *
 * Wave 4 Part C: 各 helper を CC ≤ 5 に保つための mutable accumulator。
 * `maxBatchSize` exhaustion の early-break 挙動を保つ。
 */
interface CleanupAccumulator {
  deletedCount: number;
  orphanCount: number;
  disksOverCapWorkerTypes: string[];
}

/**
 * List workerType subdir names under `publicRoot`. Returns `null` on
 * readdir failure so the caller can short-circuit with the zero-result.
 *
 * `publicRoot` 直下の workerType subdir 名一覧。失敗時 null。
 */
async function listWorkerTypeSubdirs(publicRoot: string): Promise<string[] | null> {
  try {
    return await fsp.readdir(publicRoot);
  } catch (err) {
    logger.warn("[CrashDumpCleanupCron] readdir(publicRoot) failed (non-fatal)", {
      error: sanitizeErrorMessage(err),
    });
    return null;
  }
}

interface WalkWorkerTypeRolesParams {
  publicRoot: string;
  workerType: string;
  now: number;
  params: CleanupExpiredParams;
  accumulator: CleanupAccumulator;
}

/**
 * For a single workerType subdir, iterate its role subdirs and dispatch
 * per-role cleanup + cap enforcement + orphan detection. Skips entries
 * that fail `stat()` or are not directories.
 *
 * 単一 workerType subdir 配下の role subdir 群を traversal し、
 * per-role cleanup / cap enforcement / orphan detection を dispatch。
 */
async function walkWorkerTypeRoles(p: WalkWorkerTypeRolesParams): Promise<void> {
  const workerTypeDir = path.join(p.publicRoot, p.workerType);
  let workerTypeStat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    workerTypeStat = await fsp.stat(workerTypeDir);
  } catch {
    return;
  }
  if (!workerTypeStat.isDirectory()) return;

  let roles: string[];
  try {
    roles = await fsp.readdir(workerTypeDir);
  } catch {
    return;
  }

  for (const role of roles) {
    const roleDir = path.join(workerTypeDir, role);
    let roleStat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      roleStat = await fsp.stat(roleDir);
    } catch {
      continue;
    }
    if (!roleStat.isDirectory()) continue;

    await deleteExpiredFilesInRole({
      publicRoot: p.publicRoot,
      roleDir,
      now: p.now,
      olderThanMs: p.params.olderThanMs,
      maxBatchSize: p.params.maxBatchSize,
      accumulator: p.accumulator,
    });

    await enforcePerTypeDiskCap({
      publicRoot: p.publicRoot,
      roleDir,
      workerType: p.workerType,
      maxBatchSize: p.params.maxBatchSize,
      perTypeDiskCapBytes: p.params.perTypeDiskCapBytes,
      accumulator: p.accumulator,
    });

    p.accumulator.orphanCount += await detectAndEmitOrphans({
      publicRoot: p.publicRoot,
      workerType: p.workerType,
      role,
      roleDir,
      orphanLookbackMs: p.params.orphanLookbackMs,
      now: p.now,
    });
  }
}

interface DeleteExpiredFilesParams {
  publicRoot: string;
  roleDir: string;
  now: number;
  olderThanMs: number;
  maxBatchSize: number;
  accumulator: CleanupAccumulator;
}

/**
 * Delete files in a single role subdir older than `olderThanMs`. Respects
 * the global `maxBatchSize` cap via the shared `accumulator.deletedCount`.
 *
 * 単一 role subdir 内で `olderThanMs` より古い file を削除する。
 * `maxBatchSize` cap は accumulator.deletedCount で global 共有。
 */
async function deleteExpiredFilesInRole(p: DeleteExpiredFilesParams): Promise<void> {
  const files = await listFilesByMtime(p.roleDir);
  for (const file of files) {
    if (p.accumulator.deletedCount >= p.maxBatchSize) break;
    const ageMs = p.now - file.mtime;
    if (ageMs <= p.olderThanMs) continue;
    try {
      const real = await validateCrashDumpPath(p.publicRoot, file.fullPath);
      await fsp.unlink(real);
      p.accumulator.deletedCount++;
    } catch (err) {
      logger.warn("[CrashDumpCleanupCron] unlink failed (non-fatal)", {
        error: sanitizeErrorMessage(err),
      });
    }
  }
}

interface EnforcePerTypeDiskCapParams {
  publicRoot: string;
  roleDir: string;
  workerType: string;
  maxBatchSize: number;
  perTypeDiskCapBytes: number;
  accumulator: CleanupAccumulator;
}

/**
 * If a role subdir exceeds the per-type disk cap, delete oldest files
 * until under cap. Records the offending workerType in
 * `accumulator.disksOverCapWorkerTypes`.
 *
 * Per-type disk cap 超過時に oldest-first で削除して cap 以下に戻す。
 * 違反 workerType は accumulator.disksOverCapWorkerTypes に記録。
 */
async function enforcePerTypeDiskCap(p: EnforcePerTypeDiskCapParams): Promise<void> {
  const usage = await diskUsageBytes(p.roleDir);
  if (usage <= p.perTypeDiskCapBytes) return;
  p.accumulator.disksOverCapWorkerTypes.push(p.workerType);
  let remaining = usage - p.perTypeDiskCapBytes;
  const remainingFiles = await listFilesByMtime(p.roleDir); // sorted oldest first
  for (const file of remainingFiles) {
    if (remaining <= 0) break;
    if (p.accumulator.deletedCount >= p.maxBatchSize) break;
    try {
      const real = await validateCrashDumpPath(p.publicRoot, file.fullPath);
      const stat = await fsp.stat(real);
      await fsp.unlink(real);
      remaining -= stat.size;
      p.accumulator.deletedCount++;
    } catch {
      // skip
    }
  }
}

interface EmitCleanupAuditParams {
  deletedCount: number;
  olderThanMs: number;
  perTypeDiskCapBytes: number;
  disksOverCapWorkerTypes: string[];
}

/**
 * Emit the cleanup `audit_logs` entry on `deletedCount > 0` only
 * (zero-noise contract). Failures are non-fatal (logger.warn).
 *
 * deletedCount > 0 のときのみ `worker_crash_dump_cleanup` audit_logs を emit。
 * 失敗は致命的でない (logger.warn)。
 */
async function emitCleanupAudit(p: EmitCleanupAuditParams): Promise<void> {
  if (p.deletedCount <= 0) return;
  try {
    await getAuditLogService().log({
      action: AUDIT_ACTION_WORKER_CRASH_DUMP_CLEANUP,
      actor: "system:crash-dump-cleanup-cron",
      targetType: "worker",
      targetId: "all",
      details: {
        deletedCount: p.deletedCount,
        olderThanMs: p.olderThanMs,
        perTypeDiskCapBytes: p.perTypeDiskCapBytes,
        disksOverCapWorkerTypes: p.disksOverCapWorkerTypes,
      },
      result: "success",
    });
  } catch (err) {
    logger.warn("[CrashDumpCleanupCron] audit emit failed (non-fatal)", {
      error: sanitizeErrorMessage(err),
    });
  }
}

// ============================================================================
// Δ6 Orphan detection helper
// ============================================================================

interface DetectOrphansParams {
  publicRoot: string;
  workerType: string;
  role: string;
  roleDir: string;
  orphanLookbackMs: number;
  now: number;
}

/**
 * Scan the role subdir for files written within `orphanLookbackMs`. For each,
 * query audit_logs for a matching `worker_crash_report_emitted` entry whose
 * `targetId` matches the truncated reportId. If no match exists, the watcher
 * missed the event — emit `worker_crash_report_orphaned`.
 */
async function detectAndEmitOrphans(params: DetectOrphansParams): Promise<number> {
  const { publicRoot, workerType, role, roleDir, orphanLookbackMs, now } = params;
  let orphanCount = 0;
  let files: { fullPath: string; basename: string; mtime: number; size: number }[];
  try {
    files = await listFilesByMtime(roleDir);
  } catch {
    return 0;
  }

  // Filter to files in the orphan lookback window.
  const recent = files.filter((f) => now - f.mtime <= orphanLookbackMs);
  if (recent.length === 0) return 0;

  // Fetch audit_logs entries for the lookback window.
  let recentEmits: Set<string>;
  try {
    const records = await getAuditLogService().query({
      action: "worker_crash_report_emitted",
      startDate: new Date(now - orphanLookbackMs),
      endDate: new Date(now),
      limit: 1000,
    });
    recentEmits = new Set(records.map((r) => r.targetId ?? ""));
  } catch (err) {
    logger.warn("[CrashDumpCleanupCron] audit_logs query failed for orphan detection (non-fatal)", {
      error: sanitizeErrorMessage(err),
    });
    return 0;
  }

  // For each recent file, derive the targetId (truncated) and check membership.
  for (const file of recent) {
    // Filename is `<truncatedReportId>.json`. Extract reportId.
    const truncatedReportId = file.basename.replace(/\.json$/, "");
    // Compute the SSOT truncated form via `truncateAuditTargetId`. This is
    // the same canonical path used by the watcher at write time
    // (`buildAuditTargetIdForReport`), so the equality holds by construction
    // (Wave 5 LCC CWE-209 SSOT pattern, ADR-0032).
    const expectedTargetId = truncateAuditTargetId(truncatedReportId);
    // Audit emit stores either the full truncatedReportId (length ≤ 8 case)
    // or the truncated SSOT variant. We check both forms.
    if (
      (expectedTargetId === null || !recentEmits.has(expectedTargetId)) &&
      !recentEmits.has(truncatedReportId)
    ) {
      // Orphan — emit self-healing audit entry.
      orphanCount++;
      try {
        await getAuditLogService().log({
          action: AUDIT_ACTION_WORKER_CRASH_REPORT_ORPHANED,
          actor: "system:crash-dump-cleanup-cron",
          targetType: "worker",
          targetId: truncatedReportId,
          details: {
            workerType,
            role,
            truncatedReportId,
            fileAgeMs: now - file.mtime,
            fileSizeBytes: file.size,
            publicRoot,
          },
          result: "success",
        });
      } catch (err) {
        logger.warn("[CrashDumpCleanupCron] orphan audit emit failed (non-fatal)", {
          error: sanitizeErrorMessage(err),
        });
      }
    }
  }
  return orphanCount;
}

// ============================================================================
// Helpers
// ============================================================================

interface FileEntry {
  fullPath: string;
  basename: string;
  mtime: number;
  size: number;
}

async function listFilesByMtime(dir: string): Promise<FileEntry[]> {
  const entries = await fsp.readdir(dir);
  const list: FileEntry[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    try {
      const stat = await fsp.stat(fullPath);
      if (stat.isFile()) {
        list.push({
          fullPath,
          basename: entry,
          mtime: stat.mtime.getTime(),
          size: stat.size,
        });
      }
    } catch {
      // skip
    }
  }
  // Oldest first.
  list.sort((a, b) => a.mtime - b.mtime);
  return list;
}

function validatePositive(value: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
