// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stderr write guard — Plan v4.5 PR1 NEW-U-11 L2 runtime preflight + Δ10
 * 3-stage path traversal whitelist + dedicated stderr-chunk PII redact.
 *
 * Plan v4.5 V3 §P0.5.runtime 4-layer 防御 L2 (Runtime preflight size check):
 * stderr file write 前に `fs.statSync(path).size > 40MB` 検出時、(a) 既存 file を
 * `<base>.<timestamp>.log` suffix で rotate、(b) rotate 失敗時は drop with
 * `[STDERR_OVERFLOW_DROP]` markup を inline emit。
 *
 * Plan v4.5 V3 §P0.5 LCC-H-01 PII sanitisation: stderr file write 経路に
 * **専用 (dedicated) regex set** を適用、observability を維持しつつ URL /
 * absolute path / Windows path / PostgreSQL connection string / Base64
 * embedding payload / JWT-like を redact。
 *
 * **重要 / Critical (Plan v4.5 PR1 IO Impl Decision V0 BLOCK closure —
 * SEC-V45-PR1-H-NEW-1 remediation per IO V0 §3 Option A)**:
 *
 *   `sanitizeErrorMessage` canonical SSOT (Wave 5 LCC endorsed anchor
 *   `019df7ab-2f5a`) は **Prisma error code mapping 専用** であり、URL /
 *   path / DB connection / Base64 redact regex を実装していない。stderr 経路で
 *   `sanitizeErrorMessage` を経由すると raw stderr が "An internal error
 *   occurred" 一行に**全消滅**し、PR1 P0.5 観測目的 (runtime debug
 *   observability) を構造的に破壊する。
 *
 *   そのため本 module の `sanitizeStderrChunk` は **独立 (independent) design**
 *   を採用し、専用 regex set を string-level に適用する。`sanitizeErrorMessage`
 *   canonical は Prisma error code mapping 専用 SSOT として **維持**される。
 *
 * @module utils/stderr-write-guard
 * @see Plan v4.5 V3 §P0.5.runtime (4-layer 防御 L2)
 * @see ADR-0036 §D4 (stderr observability zero-day closure — sanitizeStderrChunk independent design)
 * @see `.claude/rules/security.md` §"Canonical CWE-209 PII Protection Pattern"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeErrorMessage } from "./sanitize-error";

const PREFLIGHT_SIZE_THRESHOLD_BYTES = 40 * 1024 * 1024; // 40MB (L2 L4 contract)
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface ResolveStderrFilePathParams {
  /** Configured dir from `WorkerStderrConfig.dir` (already trailing-slash terminated). */
  dir: string;
  /** Worker type identifier (`page-analyze` | `embedding-backfill`). */
  workerType: string;
  /** Worker child PID (or parent PID for parent-process stderr). */
  pid: number;
}

/**
 * Δ10 3-stage whitelist (null byte / realpath / startsWith) + canonical
 * worker-type+pid filename — `<dir>/<type>-<pid>.log` with 0o600 file mode.
 *
 * Stage 1: 構成された full path に null byte を含むか reject
 * Stage 2: `path.resolve()` で normalised path を求め、`startsWith(realDir)` で
 *          dir prefix 検証
 * Stage 3: dir 自体を `fs.realpathSync` (or fallback to resolved) で symlink
 *          解決した path と比較
 *
 * @returns Validated absolute file path (0o600 mode applied on first write)
 * @throws Error on null byte / dir traversal / symlink escape
 */
export function resolveStderrFilePath(p: ResolveStderrFilePathParams): string {
  const { dir, workerType, pid } = p;

  // Stage 1: null byte rejection
  if (dir.indexOf("\0") !== -1 || workerType.indexOf("\0") !== -1) {
    throw new Error("[stderr-write-guard] Null byte detected in path components");
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`[stderr-write-guard] Invalid pid: ${String(pid)}`);
  }
  // Restrict workerType to safe charset (alphanumeric + hyphen) — prevent
  // path traversal via crafted workerType (e.g. "../etc/passwd").
  if (!/^[A-Za-z0-9_-]+$/.test(workerType)) {
    throw new Error(`[stderr-write-guard] Unsafe workerType identifier: '${workerType}'`);
  }

  // Stage 2: ensure dir is absolute and ends with separator
  const absoluteDir = path.resolve(dir);
  const fileName = `${workerType}-${pid}.log`;
  const fullPath = path.resolve(absoluteDir, fileName);

  // Stage 3: realpath-resolve dir (best-effort; if dir does not exist yet
  // the realpath fallback returns the resolved path verbatim — caller is
  // expected to call ensureStderrDir() first).
  let realDir: string;
  try {
    realDir = fs.realpathSync(absoluteDir);
  } catch {
    realDir = absoluteDir;
  }

  // startsWith check (path traversal 構造的防御)
  const realDirWithSep = realDir.endsWith(path.sep) ? realDir : `${realDir}${path.sep}`;
  if (!fullPath.startsWith(realDirWithSep)) {
    throw new Error(
      "[stderr-write-guard] Resolved path escapes configured dir (Δ10 whitelist violation)"
    );
  }

  return fullPath;
}

/**
 * Ensure the configured stderr dir exists with 0o700 permission. Idempotent.
 */
export function ensureStderrDir(dir: string): void {
  const absoluteDir = path.resolve(dir);
  fs.mkdirSync(absoluteDir, { recursive: true, mode: DIR_MODE });
  // chmod is a no-op when permissions already match; we apply it
  // unconditionally to repair drifted permissions (operator manual chmod).
  try {
    fs.chmodSync(absoluteDir, DIR_MODE);
  } catch {
    // best-effort; non-fatal (e.g. dir owned by another user in dev env)
  }
}

export interface OpenStderrFileResult {
  /** Validated absolute file path. */
  filePath: string;
  /** File descriptor (caller must close on shutdown). */
  fd: number;
  /** True if existing file was rotated by L2 preflight check. */
  rotated: boolean;
}

/**
 * L2 runtime preflight: check existing file size > 40MB, rotate (or drop on
 * rotate failure), then open file for append with 0o600 mode.
 *
 * @returns File descriptor (caller must call `fs.closeSync(fd)` on shutdown)
 * @throws Error on Δ10 whitelist violation or unrecoverable IO failure
 */
export function openStderrFileWithPreflight(
  params: ResolveStderrFilePathParams
): OpenStderrFileResult {
  ensureStderrDir(params.dir);
  const filePath = resolveStderrFilePath(params);

  let rotated = false;
  // L2 preflight: rotate existing file if oversized.
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > PREFLIGHT_SIZE_THRESHOLD_BYTES) {
      const timestamp = Date.now();
      const rotatedPath = `${filePath}.${timestamp}.rotated`;
      try {
        fs.renameSync(filePath, rotatedPath);
        rotated = true;
      } catch (rotateError) {
        // Rotate failed — emit drop markup inline (visible via existing
        // logger.warn pipe path in worker-supervisor-lifecycle).
        console.warn(
          `[STDERR_OVERFLOW_DROP] failed to rotate ${sanitizeErrorMessage(rotateError)}`
        );
      }
    }
  } catch {
    // File does not exist yet — first write, no preflight needed.
  }

  const fd = fs.openSync(filePath, "a", FILE_MODE);
  // chmod ensures the file is 0o600 even if umask widened it.
  try {
    fs.fchmodSync(fd, FILE_MODE);
  } catch {
    // best-effort
  }

  return { filePath, fd, rotated };
}

/**
 * Dedicated stderr-chunk regex set — independent of `sanitizeErrorMessage`
 * canonical SSOT (per IO V0 Option A / ADR-0036 §D4 sanitizeStderrChunk
 * independent design).
 *
 * Order matters: longer/more-specific patterns first to avoid partial overlap.
 *
 *   1. PostgreSQL connection (more specific than generic URL — must precede)
 *   2. URL (http/https/ftp/file)
 *   3. JWT-like (header.payload.signature)
 *   4. Base64 (>=100 chars) — embedding payload PII
 *   5. Windows path (drive-letter rooted)
 *   6. Absolute POSIX path (>=2 segments)
 */
const SANITIZE_PATTERNS: ReadonlyArray<{
  name: string;
  regex: RegExp;
  replacement: string;
}> = [
  {
    name: "postgres-connection",
    regex: /postgres(?:ql)?:\/\/[^\s]+/gi,
    replacement: "[REDACTED-DB-CONNECTION]",
  },
  {
    name: "url",
    regex: /(?:https?|ftp|file):\/\/[^\s<>"]+/gi,
    replacement: "[REDACTED-URL]",
  },
  {
    name: "jwt-like",
    regex: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g,
    replacement: "[REDACTED-JWT]",
  },
  {
    name: "base64-long",
    regex: /[A-Za-z0-9+/]{100,}={0,2}/g,
    replacement: "[REDACTED-BASE64]",
  },
  {
    name: "windows-path",
    regex: /[a-zA-Z]:\\[\\a-zA-Z0-9_. -]+/g,
    replacement: "[REDACTED-PATH]",
  },
  {
    name: "absolute-posix-path",
    regex: /(?:\/[a-zA-Z0-9_.-]+){2,}/g,
    replacement: "[REDACTED-PATH]",
  },
];

/**
 * Apply dedicated regex set to raw stderr content before writing to the
 * secondary capture file. Used by the stderr `data` event handler in
 * `worker-supervisor-lifecycle.service.ts`.
 *
 * **Design rationale (IO V0 Option A — SEC-V45-PR1-H-NEW-1 closure)**:
 *
 *   Applies a **dedicated regex set** (URL / absolute & Windows path /
 *   PostgreSQL connection / Base64 embedding payload / JWT-like) to redact
 *   PII / secrets at string-level while preserving observable stack-trace
 *   structure (file:line numbers, function names, error class names).
 *
 *   `sanitizeErrorMessage` canonical SSOT is **NOT** invoked here — it maps
 *   Prisma error codes to generic messages and would collapse raw stderr to
 *   "An internal error occurred", structurally breaking the PR1 P0.5
 *   observability goal. The two sanitisers are independent by design:
 *
 *     - `sanitizeErrorMessage` → client-facing API error responses
 *       (Prisma code mapping + keyword categorisation)
 *     - `sanitizeStderrChunk` → internal stderr file capture
 *       (string-level PII redaction preserving stack-trace structure)
 *
 * Non-destructive: returns a sanitised copy; never mutates the input buffer.
 *
 * @see ADR-0036 §D4 (stderr observability zero-day closure — independent design)
 * @see Plan v4.5 PR1 IO Impl Decision V0 §3 Option A (anchor `019e386a-58cf-7138`)
 */
export function sanitizeStderrChunk(rawChunk: string): string {
  if (rawChunk.length === 0) return rawChunk;
  let sanitised = rawChunk;
  for (const { regex, replacement } of SANITIZE_PATTERNS) {
    sanitised = sanitised.replace(regex, replacement);
  }
  return sanitised;
}

// Test-only exports
/** @internal */
export const __STDERR_WRITE_GUARD_INTERNALS_FOR_TEST = {
  PREFLIGHT_SIZE_THRESHOLD_BYTES,
  FILE_MODE,
  DIR_MODE,
  SANITIZE_PATTERNS,
} as const;
