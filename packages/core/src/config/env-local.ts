// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * .env.local loader (PR7e-β1)
 *
 * CLI スクリプトやワーカー起動スクリプトから呼び出される共通ヘルパー。
 * カレントディレクトリから親方向へ `.env.local` を探索し、最初に見つかった
 * ファイルをパースして `process.env` に反映する（既存 env は上書きしない）。
 *
 * PR7e-α までは `apps/mcp-server/src/scripts/start-workers.ts` / `check-embedding-coverage.ts`
 * / `backfill-embeddings.ts` / `apps/mcp-server/scripts/repair-*.ts` にほぼ同一の実装が
 * 散らばっており、(a) SEC-β-01 の maxDepth が揃っていない、(b) verbose ログが
 * 散発的に出る、(c) "既存 env を尊重する" ポリシーが不統一、という問題があった。
 *
 * Shared helper invoked from CLI / worker start-up scripts. Walks up from the
 * current working directory looking for `.env.local`; on first hit, parses the
 * file and populates `process.env` (without clobbering existing values).
 *
 * Before PR7e-β1, near-identical implementations were scattered across
 * `start-workers.ts`, `check-embedding-coverage.ts`, `backfill-embeddings.ts`,
 * and the two `repair-*.ts` scripts. This caused (a) inconsistent SEC-β-01
 * maxDepth, (b) sporadic verbose logs, and (c) divergent "preserve existing
 * env" policies.
 *
 * 安全性 / Safety:
 * - 既定で `maxDepth = 5` (SEC-β-01): 無限遡上を防ぐ
 * - 既存 `process.env[key]` は絶対に上書きしない (principle of least surprise)
 * - `.env.local` が存在しなくても graceful degradation (throw しない)
 * - SEC-β-07: parse したペアはログに流さない (DATABASE_URL password の漏洩防止)
 *
 * Safety guarantees:
 * - Default `maxDepth = 5` (SEC-β-01): prevents unbounded directory walk
 * - Existing `process.env[key]` values are never overwritten
 * - Graceful degradation when `.env.local` does not exist (no throw)
 * - SEC-β-07: parsed pairs are never logged (prevents DATABASE_URL password leak)
 *
 * @module config/env-local
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Options for `loadEnvLocal()`.
 */
export interface LoadEnvLocalOptions {
  /**
   * Directory from which to start searching. Defaults to `process.cwd()`.
   * 検索開始ディレクトリ。既定値は `process.cwd()`。
   */
  cwd?: string;
  /**
   * Maximum number of directory levels to walk up (inclusive of the starting
   * directory). Defaults to 5 (SEC-β-01). Must be >= 1.
   *
   * 親方向への遡上最大段数（開始ディレクトリ含む）。既定値 5 (SEC-β-01)。
   * 1 以上である必要がある。
   */
  maxDepth?: number;
  /**
   * When true, emit a single `console.log` line with the resolved path after
   * a successful load. Defaults to false (SEC-β-07).
   *
   * true のとき、ロード成功時に解決済みのパスを 1 行だけ console.log に出す。
   * 既定値 false (SEC-β-07)。
   */
  verbose?: boolean;
}

/**
 * Result of `loadEnvLocal()`.
 *
 * - `loaded=false`, `keysLoaded=0`: no `.env.local` found within maxDepth.
 * - `loaded=true`, `keysLoaded=N`: `.env.local` found at `path`, N new keys
 *   were written to `process.env` (existing keys untouched).
 */
export interface LoadEnvLocalResult {
  loaded: boolean;
  path?: string;
  keysLoaded: number;
}

const DEFAULT_MAX_DEPTH = 5;

/**
 * Parse a single `.env.local` line into a `[key, value]` pair.
 * Returns `null` if the line is blank / a comment / malformed.
 *
 * Handles:
 * - `KEY=value`
 * - `export KEY=value` (leading `export ` stripped)
 * - `KEY="quoted value"` / `KEY='quoted value'`
 * - Whitespace around key and value
 *
 * Does NOT currently handle:
 * - Multi-line values
 * - Escape sequences inside quotes
 * These are acceptable limitations because `.env.local` is typically a small
 * set of single-line key=value pairs.
 */
function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const normalized = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
  const eqIndex = normalized.indexOf("=");
  if (eqIndex === -1) return null;
  const key = normalized.slice(0, eqIndex).trim();
  if (!key) return null;
  let value = normalized.slice(eqIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

/**
 * Load the nearest `.env.local` (walking up from `cwd`) into `process.env`.
 *
 * 既存の `process.env[key]` は絶対に上書きしない。
 * Never overwrites an existing `process.env[key]`.
 *
 * @param options optional configuration
 * @returns result describing whether a file was loaded and how many new keys
 *          were written
 */
export function loadEnvLocal(options: LoadEnvLocalOptions = {}): LoadEnvLocalResult {
  const cwd = options.cwd ?? process.cwd();
  const rawMaxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  // Guard against NaN / Infinity / negative / non-integer via explicit clamp.
  const maxDepth =
    Number.isFinite(rawMaxDepth) && rawMaxDepth >= 1 ? Math.floor(rawMaxDepth) : DEFAULT_MAX_DEPTH;
  const verbose = options.verbose ?? false;

  let dir = cwd;
  for (let depth = 0; depth < maxDepth; depth++) {
    const candidate = path.join(dir, ".env.local");
    if (fs.existsSync(candidate)) {
      let raw: string;
      try {
        raw = fs.readFileSync(candidate, "utf8");
      } catch {
        // Read failure — treat as not-found to keep the function side-effect free.
        return { loaded: false, keysLoaded: 0 };
      }
      let keysLoaded = 0;
      for (const line of raw.split(/\r?\n/)) {
        const parsed = parseLine(line);
        if (!parsed) continue;
        const [key, value] = parsed;
        // SEC-β-07: preserve existing env; never overwrite.
        if (!(key in process.env) || process.env[key] === undefined) {
          process.env[key] = value;
          keysLoaded++;
        }
      }
      if (verbose) {
        // eslint-disable-next-line no-console
        console.log(`[loadEnvLocal] Loaded .env.local from ${candidate} (${keysLoaded} keys)`);
      }
      return { loaded: true, path: candidate, keysLoaded };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return { loaded: false, keysLoaded: 0 };
}
