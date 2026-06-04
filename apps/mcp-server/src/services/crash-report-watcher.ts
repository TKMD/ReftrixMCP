// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Crash Report Watcher — Δ4 TOCTOU atomic-rename pipeline (Wave 3 PR3b)
 *
 * Plan v3 T2 V1 §4.4 Δ4 contract: watch the per-process staging root for
 * newly-written `process.report` files, sanitise them via
 * `crash-report-sanitizer`, then atomically rename to the public root for
 * external consumption.
 *
 * **Atomic rename pipeline** (Δ4 TOCTOU mitigation):
 *
 *   Stage 1 — `process.report.directory` writes to a session-unique 0o700
 *             staging dir under `os.tmpdir()` (`reftrix-crash-staging-*`).
 *             Other processes cannot read this dir (POSIX mode + per-process
 *             tmpdir entry name).
 *   Stage 2 — Watcher detects the new file → reads → sanitises → writes
 *             sanitised JSON to a temporary peer file in the SAME public
 *             subdir (`<public>/<workerType>/<role>/.<truncatedReportId>.tmp`)
 *             → atomic `rename()` to final filename. The rename is a single
 *             syscall that swaps the inode reference atomically, ensuring
 *             no consumer ever observes a partially-written file.
 *
 * **Audit emit** (Δ12 SSOT pattern): post-rename, emit
 * `worker_crash_report_emitted` via the SSOT
 * `getAuditLogService().log()` path (which internally uses
 * `truncateAuditTargetId` per ADR-0032 Wave 5 LCC).
 *
 * **fs.watch contract**: Node's built-in `fs.watch` is used (no chokidar
 * dependency). Per-platform semantics:
 *   - Linux inotify: `rename` event fires once on new entry creation.
 *   - macOS FSEvents: `rename` event fires; recursive=false applies.
 *   - Some events may be missed under heavy load → R6 mitigation:
 *     cleanup-cron orphan detection re-emits `worker_crash_report_orphaned`.
 *
 * @module services/crash-report-watcher
 * @see Plan v3 T2 V1 §4.4 Δ4 + §4.5 Δ12
 * @see ADR-0021 §"TOCTOU section"
 * @see INV-WORKER-CRASH-DUMP-001 toctoumitigation standing regression
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getAuditLogService } from "./audit-log.service";
import {
  CRASH_DUMP_FILE_MODE,
  CRASH_DUMP_FILE_SIZE_CAP_BYTES,
  resolveCrashDumpSubdir,
  validateCrashDumpPath,
} from "./crash-dump-persistence.service";
import {
  buildAuditTargetIdForReport,
  generateTruncatedReportId,
  sanitizeReport,
  type CrashReportSanitizationResult,
} from "./crash-report-sanitizer";
import { AUDIT_ACTION_WORKER_CRASH_REPORT_EMITTED } from "../audit/audit-actions";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";

// ============================================================================
// Watcher handle + options
// ============================================================================

export interface CrashReportWatcherOptions {
  /** Staging root (private 0o700 dir) created via `createStagingRoot()`. */
  stagingRoot: string;
  /** Public crash dump root (resolved via `resolveCrashDumpRoot()`). */
  publicRoot: string;
  /** WorkerType for this process (`page` | `embedding-backfill` | parent label). */
  workerType: string;
  /** Process role within the tier model. */
  role: "parent" | "child";
  /** Process exit signal capture (best-effort metadata for audit emit). */
  captureExitMetadata?: () => { exitSignal: string | null; exitCode: number | null };
}

export interface CrashReportWatcherHandle {
  /** Stop watching and release fs.watch handle. */
  stop: () => Promise<void>;
  /**
   * Force a manual scan of the staging root (used by tests and by the
   * cleanup-cron self-heal path). Returns the list of processed report
   * basenames.
   */
  scanAndProcess: () => Promise<string[]>;
}

// ============================================================================
// Main watcher
// ============================================================================

/**
 * Start a crash report watcher. Returns a handle with `stop()` for graceful
 * shutdown and `scanAndProcess()` for manual one-shot processing.
 *
 * The watcher is idempotent: if the staging dir contains pre-existing files
 * at startup (e.g., from a previous abrupt shutdown), they will be processed
 * on the next `scanAndProcess()` call OR on the first event triggered by
 * any subsequent write.
 */
export function startCrashReportWatcher(
  options: CrashReportWatcherOptions
): CrashReportWatcherHandle {
  const { stagingRoot, publicRoot, workerType, role, captureExitMetadata } = options;
  let stopped = false;
  const inFlight = new Set<string>();

  const processFile = async (basename: string): Promise<void> => {
    if (stopped) return;
    if (inFlight.has(basename)) return; // de-dup re-fire events
    inFlight.add(basename);
    try {
      await processReportFile({
        stagingRoot,
        publicRoot,
        workerType,
        role,
        basename,
        captureExitMetadata,
      });
    } catch (err) {
      logger.warn("[CrashReportWatcher] processReportFile failed (non-fatal)", {
        basename,
        error: sanitizeErrorMessage(err),
      });
    } finally {
      inFlight.delete(basename);
    }
  };

  let fsWatcher: fs.FSWatcher | null = null;
  try {
    fsWatcher = fs.watch(stagingRoot, { persistent: false }, (eventType, filename) => {
      if (stopped) return;
      if (typeof filename !== "string" || filename.length === 0) return;
      // Only act on rename events (new file creation). On Linux inotify,
      // 'rename' fires on file creation in the watched dir; 'change' fires
      // on subsequent writes. We process on either to be robust across
      // platforms; the de-dup via inFlight + post-rename source-removal
      // prevents double processing.
      if (eventType === "rename" || eventType === "change") {
        // Only process JSON report files; ignore stagings of our own tmp
        // peers (we never write them to the staging dir, but defense-in-
        // depth against future watcher reuse).
        if (filename.endsWith(".json")) {
          void processFile(filename);
        }
      }
    });
    fsWatcher.on("error", (err) => {
      logger.warn("[CrashReportWatcher] fs.watch error (non-fatal)", {
        error: sanitizeErrorMessage(err),
      });
    });
  } catch (err) {
    // Some platforms / FS types may reject fs.watch (e.g. certain network
    // mounts). Watcher degrades to manual scanAndProcess() only.
    logger.warn("[CrashReportWatcher] fs.watch unavailable; falling back to manual scan only", {
      error: sanitizeErrorMessage(err),
    });
    fsWatcher = null;
  }

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (fsWatcher !== null) {
        try {
          fsWatcher.close();
        } catch {
          // best-effort
        }
      }
    },
    async scanAndProcess(): Promise<string[]> {
      const processed: string[] = [];
      try {
        const entries = await fsp.readdir(stagingRoot);
        for (const entry of entries) {
          if (entry.endsWith(".json")) {
            await processFile(entry);
            processed.push(entry);
          }
        }
      } catch (err) {
        logger.warn("[CrashReportWatcher] scanAndProcess failed", {
          error: sanitizeErrorMessage(err),
        });
      }
      return processed;
    },
  };
}

// ============================================================================
// Per-file processing pipeline (sanitise → tmp peer → atomic rename)
// ============================================================================

interface ProcessReportFileParams {
  stagingRoot: string;
  publicRoot: string;
  workerType: string;
  role: "parent" | "child";
  basename: string;
  captureExitMetadata?: (() => { exitSignal: string | null; exitCode: number | null }) | undefined;
}

/**
 * Process a single staging report: read → size cap check → sanitise → write
 * sanitised JSON to a tmp peer in the public subdir → atomic rename →
 * audit emit → delete original staging file.
 *
 * Wave 4 Part C TDA M-1b SRP refactor (V6 §2.4.2): `processReportFile` was
 * CC≈16 prior to extraction. Decomposed into 3 single-responsibility helpers:
 * `readAndParseReport` (Stage 1 source read + size cap) /
 * `writeAndRenameAtomically` (Stage 2 atomic rename pipeline) /
 * `emitAuditEntry` (`worker_crash_report_emitted` audit emit).
 * All helpers CC ≤ 5. Behaviour-preserving: 8/8 watcher tests +
 * standing regression all pass post-refactor.
 *
 * Wave 4 Part C TDA M-1b SRP refactor: `processReportFile` を CC ≤ 5 の単一責任
 * helper 3 件に分解。挙動互換 (テスト全 PASS で検証)。
 */
export async function processReportFile(params: ProcessReportFileParams): Promise<{
  finalPath: string;
  truncatedReportId: string;
  sanitization: CrashReportSanitizationResult;
} | null> {
  const { stagingRoot, publicRoot, workerType, role, basename, captureExitMetadata } = params;
  const sourcePath = path.join(stagingRoot, basename);

  const parsed = await readAndParseReport({ sourcePath, basename });
  if (parsed === null) return null;
  const { realSource, rawReport } = parsed;

  // Sanitise.
  const sanitization = sanitizeReport(rawReport);

  const renamed = await writeAndRenameAtomically({
    publicRoot,
    workerType,
    role,
    basename,
    sanitisedReport: sanitization.report,
  });
  if (renamed === null) return null;
  const { finalPath, truncatedReportId } = renamed;

  // Remove the staging source (Stage 1 → Stage 2 completion).
  await fsp.unlink(realSource).catch(() => undefined);

  // Audit emit.
  const exitMeta = captureExitMetadata?.() ?? { exitSignal: null, exitCode: null };
  await emitAuditEntry({
    finalPath,
    workerType,
    role,
    truncatedReportId,
    sanitization,
    exitMeta,
  });

  return { finalPath, truncatedReportId, sanitization };
}

// ============================================================================
// Wave 4 Part C TDA M-1b — extracted helpers (each CC ≤ 5)
// ============================================================================

interface ReadAndParseReportParams {
  sourcePath: string;
  basename: string;
}

/**
 * Stage 1: resolve staging file via `realpath`, enforce the hard size cap,
 * read + JSON-parse. Returns `null` when the file disappeared (race) or
 * exceeded the size cap. Truncated / non-JSON files surface as
 * `rawReport = { error: "truncated_or_unreadable" }` so the audit emit
 * later records `sanitizationApplied=false` (Δ5 Metric A contract).
 *
 * Stage 1: staging file の `realpath` 解決 / size cap / read+parse。
 * race で消滅 or size cap 超過 → null。truncated/非 JSON は
 * `{ error: "truncated_or_unreadable" }` で audit emit に渡す。
 */
async function readAndParseReport(
  p: ReadAndParseReportParams
): Promise<{ realSource: string; rawReport: unknown } | null> {
  // Resolve & validate the staging file path.
  let realSource: string;
  try {
    realSource = await fsp.realpath(p.sourcePath);
  } catch {
    return null; // already cleaned by another iteration
  }

  // Hard size cap (DoS defense + Node `process.report` typically <5MB).
  const sourceStat = await fsp.stat(realSource).catch(() => null);
  if (sourceStat === null) return null;
  if (sourceStat.size > CRASH_DUMP_FILE_SIZE_CAP_BYTES) {
    logger.warn("[CrashReportWatcher] Source file exceeds size cap, dropping", {
      basename: p.basename,
      sizeBytes: sourceStat.size,
    });
    // Delete the oversize source to avoid a re-fire loop.
    await fsp.unlink(realSource).catch(() => undefined);
    return null;
  }

  // Read + parse the raw report.
  let rawReport: unknown;
  try {
    const buf = await fsp.readFile(realSource, { encoding: "utf-8" });
    rawReport = JSON.parse(buf);
  } catch (err) {
    // Truncated / non-JSON file — likely a SIGKILL during write. Mark as
    // truncated, emit audit with sanitizationApplied=false (Δ5 Metric A
    // contributes if rate ≥ 1/60min).
    logger.warn("[CrashReportWatcher] Failed to read/parse source report", {
      basename: p.basename,
      error: sanitizeErrorMessage(err),
    });
    rawReport = { error: "truncated_or_unreadable" };
  }

  return { realSource, rawReport };
}

interface WriteAndRenameAtomicallyParams {
  publicRoot: string;
  workerType: string;
  role: "parent" | "child";
  basename: string;
  sanitisedReport: unknown;
}

/**
 * Stage 2 atomic rename pipeline (Δ4 TOCTOU mitigation): write sanitised
 * JSON to a hidden `.tmp` peer in the same public subdir → single-syscall
 * `fsp.rename()` swap → post-rename whitelist validation. Returns `null`
 * on any failure (with appropriate cleanup of tmp peer or final path).
 *
 * Stage 2 atomic rename pipeline (Δ4 TOCTOU 防御): tmp peer に write →
 * single syscall rename → post-rename whitelist validation。
 * 失敗時 null (tmp/final どちらも clean up)。
 */
async function writeAndRenameAtomically(
  p: WriteAndRenameAtomicallyParams
): Promise<{ finalPath: string; truncatedReportId: string } | null> {
  // Resolve final destination subdir + filename.
  const subdir = await resolveCrashDumpSubdir(p.publicRoot, p.workerType, p.role);
  const truncatedReportId = generateTruncatedReportId();
  const finalName = `${truncatedReportId}.json`;
  const finalPath = path.join(subdir, finalName);
  // Write to a hidden tmp peer in the same dir so the rename is atomic
  // (same-filesystem rename is a single syscall).
  const tmpPeer = path.join(subdir, `.${finalName}.tmp`);

  const serialised = safeStringify(p.sanitisedReport);
  try {
    await fsp.writeFile(tmpPeer, serialised, {
      encoding: "utf-8",
      mode: CRASH_DUMP_FILE_MODE,
    });
    // Atomic rename to public name.
    await fsp.rename(tmpPeer, finalPath);
  } catch (err) {
    logger.warn("[CrashReportWatcher] Failed to write/rename sanitised report", {
      basename: p.basename,
      error: sanitizeErrorMessage(err),
    });
    // Cleanup tmp peer if it lingered.
    await fsp.unlink(tmpPeer).catch(() => undefined);
    return null;
  }

  // Validate the public path against whitelist (post-rename defense-in-depth).
  try {
    await validateCrashDumpPath(p.publicRoot, finalPath);
  } catch (err) {
    logger.warn("[CrashReportWatcher] Post-rename whitelist check failed", {
      error: sanitizeErrorMessage(err),
    });
    await fsp.unlink(finalPath).catch(() => undefined);
    return null;
  }

  return { finalPath, truncatedReportId };
}

interface EmitAuditEntryParams {
  finalPath: string;
  workerType: string;
  role: "parent" | "child";
  truncatedReportId: string;
  sanitization: CrashReportSanitizationResult;
  exitMeta: { exitSignal: string | null; exitCode: number | null };
}

/**
 * Emit `worker_crash_report_emitted` audit_logs entry post-rename.
 * `targetId` is routed through `buildAuditTargetIdForReport` (SSOT
 * truncate path, ADR-0032 canonical) with a fallback to the raw
 * `truncatedReportId` for the length-≤-8 case. Failures are non-fatal.
 *
 * Atomic rename 完了後の `worker_crash_report_emitted` audit_logs emit。
 * `targetId` は SSOT `buildAuditTargetIdForReport` 経由 (ADR-0032)。
 * 失敗は致命的でない (logger.warn)。
 */
async function emitAuditEntry(p: EmitAuditEntryParams): Promise<void> {
  const finalStat = await fsp.stat(p.finalPath).catch(() => null);
  try {
    await getAuditLogService().log({
      action: AUDIT_ACTION_WORKER_CRASH_REPORT_EMITTED,
      actor: "system:worker-crash-handler",
      targetType: "worker",
      targetId: buildAuditTargetIdForReport(p.truncatedReportId) ?? p.truncatedReportId,
      details: {
        workerType: p.workerType,
        role: p.role,
        truncatedReportId: p.truncatedReportId,
        fileSizeBytes: finalStat?.size ?? 0,
        sanitizationApplied: p.sanitization.sanitizationApplied,
        sanitizationDurationMs: p.sanitization.sanitizationDurationMs,
        exitSignal: p.exitMeta.exitSignal,
        exitCode: p.exitMeta.exitCode,
        jsStackTopFrame: p.sanitization.jsStackTopFrame,
        nativeStackTopSymbol: p.sanitization.nativeStackTopSymbol,
      },
      result: p.sanitization.sanitizationApplied ? "success" : "denied",
    });
  } catch (err) {
    logger.warn("[CrashReportWatcher] Audit emit failed (non-fatal)", {
      error: sanitizeErrorMessage(err),
    });
  }
}

// ============================================================================
// Safe JSON stringify (handles BigInt + circular refs)
// ============================================================================

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    },
    2
  );
}
