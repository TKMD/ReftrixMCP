// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker stderr cleanup cron — Plan v4.5 PR1 NEW-U-11 L1 frequent cleanup +
 * L3 disk space monitoring.
 *
 * Plan v4.5 V3 §P0.5.runtime 4-layer 防御:
 *   - L1: `REFTRIX_WORKER_STDERR_CRON_INTERVAL_MS` (default 6h、range 1h-24h)
 *         で stderr file の TTL (default 7d) 削除を周期実行
 *   - L3: 30s 周期で `fs.statfs(<dir>)` 監視、available < 1GB 検出時
 *         `audit_logs.worker_stderr_disk_pressure_detected` emit +
 *         `REFTRIX_WORKER_STDERR_REDIRECT_ENABLED=false` runtime auto-failover
 *
 * Pattern follows the (retired) `screenshot-cleanup-cron.ts` (BullMQ Repeatable
 * Job ではなく setInterval、Worker と同プロセスで filesystem + audit_logs のみ
 * touch)。screenshot TTL cron 自体は PR-SS-B / ADR-0041 で撤去済。
 *
 * @module cron/worker-stderr-cleanup-cron
 * @see Plan v4.5 V3 §P0.5.runtime (4-layer 防御 L1 + L3)
 * @see ADR-0036 §D4.1 (stderr file disk full racing 4-layer 防御)
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { getAuditLogService, truncateAuditTargetId } from "../services/audit-log.service";
import {
  AUDIT_ACTION_WORKER_STDERR_DISK_PRESSURE_DETECTED,
  AUDIT_ACTOR_WORKER_SUPERVISOR,
} from "../audit/audit-actions";
import { closeStderrFilesForAllChildren } from "../services/worker-supervisor-lifecycle.service";

const DISK_MONITOR_INTERVAL_MS = 30_000; // L3 30s polling
const DISK_PRESSURE_THRESHOLD_BYTES = 1 * 1024 * 1024 * 1024; // 1GB

export interface ScheduleWorkerStderrCleanupCronOptions {
  /** Stderr file directory (from `WorkerStderrConfig.dir`). */
  dir: string;
  /** L1 cleanup cron interval (default 6h、from `WorkerStderrConfig.cronIntervalMs`). */
  intervalMs: number;
  /** TTL horizon in ms (default 7d、derived from `retentionDays * 24h`). */
  retentionMs: number;
  /** Whether to run cleanup immediately on schedule (recovery after restart). */
  runOnStart?: boolean;
}

export interface WorkerStderrCleanupCronHandle {
  /** Stop both L1 cleanup interval and L3 disk monitor. */
  stop: () => void;
  /** Manually trigger cleanup (used by L3 disk pressure auto-cleanup). */
  triggerCleanup: () => Promise<{ deletedCount: number }>;
}

/**
 * Schedule both L1 cleanup cron and L3 disk space monitor for stderr files.
 *
 * L1 fires on `intervalMs` cadence, deletes files older than `retentionMs`.
 * L3 fires on 30s cadence, on `available < 1GB` triggers (a) audit emit,
 * (b) runtime auto-failover via `REFTRIX_WORKER_STDERR_REDIRECT_ENABLED=false`,
 * (c) immediate cleanup.
 */
export function scheduleWorkerStderrCleanupCron(
  options: ScheduleWorkerStderrCleanupCronOptions
): WorkerStderrCleanupCronHandle {
  const { dir, intervalMs, retentionMs, runOnStart = false } = options;
  const absoluteDir = path.resolve(dir);

  let stopped = false;
  let l3Emitted = false; // de-dup audit emit within one degraded window

  const performCleanup = async (): Promise<{ deletedCount: number }> => {
    if (stopped) return { deletedCount: 0 };
    let deletedCount = 0;
    try {
      const entries = await fsp.readdir(absoluteDir);
      const now = Date.now();
      for (const entry of entries) {
        const entryPath = path.join(absoluteDir, entry);
        try {
          const stat = await fsp.stat(entryPath);
          if (!stat.isFile()) continue;
          if (now - stat.mtimeMs > retentionMs) {
            await fsp.unlink(entryPath);
            deletedCount++;
          }
        } catch (err) {
          // file disappeared between readdir and stat — race-tolerant
          logger.warn("[worker-stderr-cleanup-cron] per-file cleanup failed (non-fatal)", {
            entry,
            error: sanitizeErrorMessage(err),
          });
        }
      }
    } catch (err) {
      logger.warn("[worker-stderr-cleanup-cron] readdir failed (non-fatal)", {
        dir: absoluteDir,
        error: sanitizeErrorMessage(err),
      });
    }
    return { deletedCount };
  };

  const checkDiskPressure = async (): Promise<void> => {
    if (stopped) return;
    try {
      // fs.statfs is Node.js 18.15+ / 20+; we depend on Node 20 LTS.
      const stats = await fsp.statfs(absoluteDir);
      const availableBytes = stats.bavail * stats.bsize;
      if (availableBytes < DISK_PRESSURE_THRESHOLD_BYTES) {
        if (!l3Emitted) {
          await emitDiskPressureAudit(absoluteDir, availableBytes);
          l3Emitted = true;
        }
        // Runtime auto-failover (L3 action b).
        // NOTE (Plan v4.5 V3 §P0.5.runtime intentional): the following
        // `process.env` mutation is a **deliberate side effect** of L3 disk
        // pressure response; the config loader is otherwise side-effect-free
        // per ADR-0036 §D4.1. U-V45-PR1-10 partial closure (TDA-FIND-IMPL-TDA-V45-PR1-L-02
        // / FIND-IMPL-V45-PR1-L-02): explicit annotation for static analysis +
        // future refactor candidates.
        process.env.REFTRIX_WORKER_STDERR_REDIRECT_ENABLED = "false";
        // U-V45-PR1-07 closure (M severity): immediately close live secondary
        // file descriptors of currently-running children. Without this step,
        // `process.env` mutation alone only affects subsequent spawns, leaving
        // already-running children to continue appending to stderr files
        // during the disk-pressure window. Both effects (env mutation + fd
        // close) are required for runtime auto-failover efficacy.
        const closed = closeStderrFilesForAllChildren();
        if (closed.closedCount > 0) {
          logger.info("[worker-stderr-cleanup-cron] L3 auto-failover closed live stderr fds", {
            closedCount: closed.closedCount,
          });
        }
        // Immediate cleanup (L3 action c)
        void performCleanup();
      } else if (l3Emitted) {
        // Disk pressure resolved — re-arm audit emit for future events
        l3Emitted = false;
      }
    } catch (err) {
      logger.warn("[worker-stderr-cleanup-cron] disk pressure check failed (non-fatal)", {
        error: sanitizeErrorMessage(err),
      });
    }
  };

  // L1: cleanup cron (6h default)
  const cleanupTimer = setInterval(() => {
    void performCleanup().then((result) => {
      if (result.deletedCount > 0) {
        logger.info("[worker-stderr-cleanup-cron] L1 cleanup completed", {
          deletedCount: result.deletedCount,
        });
      }
    });
  }, intervalMs);
  cleanupTimer.unref?.();

  // L3: 30s disk space monitor
  const diskTimer = setInterval(() => {
    void checkDiskPressure();
  }, DISK_MONITOR_INTERVAL_MS);
  diskTimer.unref?.();

  if (runOnStart) {
    void performCleanup();
    void checkDiskPressure();
  }

  return {
    stop: (): void => {
      stopped = true;
      clearInterval(cleanupTimer);
      clearInterval(diskTimer);
    },
    triggerCleanup: performCleanup,
  };
}

async function emitDiskPressureAudit(dir: string, availableBytes: number): Promise<void> {
  try {
    // U-V45-PR1-05 closure (Wave 5 LCC canonical anchor `019df7ab-2f5a` +
    // SEC-H-NEW-2 + LCC-H-01 + TDA-M-02): targetId and details.dir both routed
    // through `truncateAuditTargetId` SSOT (CWE-209 information exposure
    // defense-in-depth; prevents operator-override hostname/username leak).
    await getAuditLogService().log({
      action: AUDIT_ACTION_WORKER_STDERR_DISK_PRESSURE_DETECTED,
      actor: AUDIT_ACTOR_WORKER_SUPERVISOR,
      targetType: "worker",
      targetId: truncateAuditTargetId(dir),
      details: {
        dir: truncateAuditTargetId(dir),
        availableBytes,
        thresholdBytes: DISK_PRESSURE_THRESHOLD_BYTES,
        failoverAction: "REFTRIX_WORKER_STDERR_REDIRECT_ENABLED=false",
      },
      result: "denied",
    });
  } catch (err) {
    // L1.5 SLO_MARKER fail-open: primary emit failure compensation log
    // (Plan v4.5 V3 §5 Gate verify-of-verify pattern).
    logger.error("[SLO_MARKER] audit_log_emit_failed worker_stderr_disk_pressure_detected", {
      error: sanitizeErrorMessage(err),
    });
  }
}

// Test-only exports
/** @internal */
export const __WORKER_STDERR_CLEANUP_CRON_INTERNALS_FOR_TEST = {
  DISK_MONITOR_INTERVAL_MS,
  DISK_PRESSURE_THRESHOLD_BYTES,
  // expose for fs.statfs mock injection in integration tests
  emitDiskPressureAuditForTest: emitDiskPressureAudit,
} as const;

// Avoid unused import warning when fs is only referenced via fsp
void fs;
