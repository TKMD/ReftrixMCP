// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Crash Dump Persistence Service — root resolver + path defense (Wave 3 PR3b)
 *
 * Plan v3 T2 V1 §4.4 + Δ10 path traversal 3-stage whitelist defense. Manages
 * the public crash dump root directory under which sanitised diagnostic
 * reports are persisted post-atomic-rename. Reuses the
 * `phase-5-raw-decode.ts` lines 115-220 3-stage whitelist defense pattern
 * verbatim (Δ10 line-cited evidence requirement):
 *
 *   Stage 1 — null byte injection rejection
 *   Stage 2 — realpath canonicalisation (symlink TOCTOU defeat)
 *   Stage 3 — prefix whitelist + os.tmpdir() startsWith + lstat symlink check
 *
 * **Storage layout** (V0 §2.4 unchanged):
 *   <root>/<workerType>/<role>/<truncatedTs>.<seqOnly>.json
 *   File mode: 0o600 (owner rw only)
 *   Dir mode:  0o700 (owner rwx only)
 *
 * **Root**:
 *   `REFTRIX_CRASH_DUMP_ROOT` env var (default `<os.tmpdir()>/reftrix-crashes`)
 *
 * @module services/crash-dump-persistence.service
 * @see Plan v3 T2 V1 §4.4 / Δ10 / §13.11
 * @see ADR-0021 §"Path Defense"
 * @see phase-5-raw-decode.ts lines 115-220 (canonical 3-stage whitelist pattern)
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";

// ============================================================================
// Constants
// ============================================================================

/** Default public root for crash dumps. Override via env. */
export const DEFAULT_CRASH_DUMP_ROOT_PREFIX = "reftrix-crashes";

/** Hard prefix all dump dirs must share (for whitelist invariants). */
export const CRASH_DUMP_DIR_PREFIX = "reftrix-crashes";

/** File permission (POSIX): owner read+write only. */
export const CRASH_DUMP_FILE_MODE = 0o600;

/** Directory permission (POSIX): owner read+write+execute only. */
export const CRASH_DUMP_DIR_MODE = 0o700;

/** Hard cap on a single dump file (DoS defense + retention budget). */
export const CRASH_DUMP_FILE_SIZE_CAP_BYTES = 50 * 1024 * 1024; // 50 MB

/** Hard cap on per-worker-type total disk usage (DoS defense). */
export const CRASH_DUMP_PER_TYPE_DISK_CAP_BYTES = 500 * 1024 * 1024; // 500 MB

// ============================================================================
// Root resolution
// ============================================================================

/**
 * Resolve the public crash dump root. Creates the directory with 0o700 if it
 * does not exist. Returns the canonical realpath.
 *
 * **Path defense Stages 1-3** (Δ10): null byte rejection → realpath → prefix
 * whitelist + `os.tmpdir()` startsWith. Symbolic link rejection via lstat.
 */
export async function resolveCrashDumpRoot(): Promise<string> {
  const envRoot = process.env.REFTRIX_CRASH_DUMP_ROOT;
  const candidate =
    envRoot && envRoot.length > 0
      ? envRoot
      : path.join(os.tmpdir(), DEFAULT_CRASH_DUMP_ROOT_PREFIX);

  // Stage 1: null byte defense.
  if (candidate.includes("\0")) {
    throw new Error("Crash dump root contains null byte (path traversal defense)");
  }

  // Ensure parent dir exists. mkdir is idempotent with recursive: true.
  await fsp.mkdir(candidate, { mode: CRASH_DUMP_DIR_MODE, recursive: true });
  await fsp.chmod(candidate, CRASH_DUMP_DIR_MODE).catch(() => {
    // Best-effort chmod (already mkdir-ed with mode; non-fatal if chmod fails
    // on platforms with restrictive ACLs).
  });

  // Stage 2: realpath canonicalisation.
  const realRoot = await fsp.realpath(candidate);

  // Stage 3: must reside under os.tmpdir() AND have the expected prefix.
  const realTmpDir = await fsp.realpath(os.tmpdir());
  const underTmp = realRoot.startsWith(realTmpDir + path.sep) || realRoot === realTmpDir;
  if (!underTmp) {
    throw new Error("Crash dump root not under os.tmpdir() (whitelist violation)");
  }
  const basename = path.basename(realRoot);
  if (!basename.startsWith(CRASH_DUMP_DIR_PREFIX)) {
    throw new Error(
      `Crash dump root basename does not start with '${CRASH_DUMP_DIR_PREFIX}' (whitelist violation)`
    );
  }

  // Reject symbolic links to the root (defense-in-depth against TOCTOU).
  const lstat = await fsp.lstat(realRoot);
  if (lstat.isSymbolicLink()) {
    throw new Error("Crash dump root is a symbolic link (whitelist violation)");
  }

  return realRoot;
}

// ============================================================================
// Per-worker-type / per-role subdirectory resolver
// ============================================================================

/**
 * Resolve the public sub-directory for a (workerType, role) pair under the
 * public root. Creates with 0o700 if absent. Returns the canonical realpath.
 *
 * @example
 *   resolveCrashDumpSubdir(root, "page", "child")
 *   → /tmp/reftrix-crashes/page/child
 */
export async function resolveCrashDumpSubdir(
  publicRoot: string,
  workerType: string,
  role: "parent" | "child"
): Promise<string> {
  // Validate workerType + role against null bytes + path separators.
  if (
    workerType.includes("\0") ||
    workerType.includes("/") ||
    workerType.includes("\\") ||
    role.includes("\0") ||
    role.includes("/") ||
    role.includes("\\")
  ) {
    throw new Error("workerType or role contains path-defense-rejected characters");
  }
  const subdir = path.join(publicRoot, workerType, role);
  await fsp.mkdir(subdir, { mode: CRASH_DUMP_DIR_MODE, recursive: true });
  const real = await fsp.realpath(subdir);
  if (!real.startsWith(publicRoot + path.sep)) {
    throw new Error("Crash dump subdir escapes public root (whitelist violation)");
  }
  return real;
}

// ============================================================================
// Staging root (Stage 1 atomic-rename source)
// ============================================================================

/**
 * Create a session-unique staging directory under `os.tmpdir()` with mode
 * 0o700. The directory is created via `mkdtemp` so name collisions are
 * impossible across processes. Used as the Stage 1 destination of
 * `process.report.directory` per Δ4 TOCTOU mitigation contract.
 */
export async function createStagingRoot(): Promise<string> {
  const stagingRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "reftrix-crash-staging-"));
  await fsp.chmod(stagingRoot, CRASH_DUMP_DIR_MODE).catch(() => {
    // Best-effort chmod (mkdtemp uses process umask; we tighten to 0o700).
  });
  return stagingRoot;
}

/**
 * Remove a staging directory and all its contents. Best-effort; never throws.
 * Apply the same 3-stage whitelist defense as `phase-5-raw-decode.cleanupPhase5TempDir`.
 */
export async function destroyStagingRoot(stagingRoot: string): Promise<void> {
  // Stage 1.
  if (typeof stagingRoot !== "string" || stagingRoot.length === 0 || stagingRoot.includes("\0")) {
    logger.warn("[CrashDumpPersistence] destroyStagingRoot rejected invalid input");
    return;
  }
  // Stage 2.
  let real: string;
  let realTmp: string;
  try {
    real = await fsp.realpath(stagingRoot);
  } catch {
    return; // ENOENT — already cleaned.
  }
  try {
    realTmp = await fsp.realpath(os.tmpdir());
  } catch {
    return; // fail closed.
  }
  // Stage 3.
  const underTmp = real.startsWith(realTmp + path.sep);
  const hasPrefix = path.basename(real).startsWith("reftrix-crash-staging-");
  if (!underTmp || !hasPrefix) {
    logger.warn("[CrashDumpPersistence] destroyStagingRoot rejected path outside whitelist", {
      pathPrefix: real.slice(0, 80),
    });
    return;
  }
  try {
    await fsp.rm(real, { recursive: true, force: true });
  } catch (err) {
    logger.warn("[CrashDumpPersistence] destroyStagingRoot failed (non-fatal)", {
      error: sanitizeErrorMessage(err),
    });
  }
}

// ============================================================================
// Validation helper for public file path (used by watcher + cleanup-cron)
// ============================================================================

/**
 * Validate that a candidate file path is inside the crash dump public root.
 * Returns the canonical realpath on success; throws on any whitelist violation.
 */
export async function validateCrashDumpPath(
  publicRoot: string,
  candidate: string
): Promise<string> {
  // Stage 1.
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) {
    throw new Error("Crash dump path invalid (null byte / empty)");
  }
  // Stage 2.
  const real = await fsp.realpath(candidate);
  const realRoot = await fsp.realpath(publicRoot);
  // Stage 3.
  if (!real.startsWith(realRoot + path.sep)) {
    throw new Error("Crash dump path outside public root (whitelist violation)");
  }
  const lstat = await fsp.lstat(real);
  if (lstat.isSymbolicLink()) {
    throw new Error("Crash dump path is a symbolic link (whitelist violation)");
  }
  return real;
}

// ============================================================================
// Disk usage budget enforcement
// ============================================================================

/**
 * Sum disk usage of files in a directory (non-recursive — crash dump dirs are
 * flat). Returns total bytes.
 */
export async function diskUsageBytes(dir: string): Promise<number> {
  try {
    const entries = await fsp.readdir(dir);
    let total = 0;
    for (const entry of entries) {
      const full = path.join(dir, entry);
      try {
        const stat = await fsp.stat(full);
        if (stat.isFile()) total += stat.size;
      } catch {
        // skip
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Test whether a file exists synchronously (used by atomic-rename pre-flight).
 * Wraps `fs.existsSync` for clarity at the call site.
 */
export function fileExistsSync(p: string): boolean {
  return fs.existsSync(p);
}
