// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding cache 起動時 orphan sweep (leaf helper module).
 *
 * Startup orphan-sweep leaf helpers for the embedding cache.
 *
 * Plan v2 §2.5.3 / §2.5.4 / §2.5.5 を実装する。`maxJobsBeforeRestart=1` の高頻度
 * worker churn 下で per-worker dbPath (`<root>/<workerType>-<pid>/`) に残る死 pid
 * の orphan (temp + 本体 cache.json + 空 dir) を起動時に回収し、temp leak →
 * disk full (MEMORY.md `project_embedding_cache_temp_leak_disk_full`) を根治する。
 *
 * Implements Plan v2 §2.5.3 (EPERM≠ESRCH distinction), §2.5.4 (Phase 5-isomorphic
 * 3-stage whitelist), and §2.5.5 (dead-pid dbPath dir whole-directory recovery).
 *
 * **leaf module 理由 (TDA-RE2-01 / C-RE-2)**: sweep / isProcessAlive を
 * `persistent-cache.ts` 本体に inline すると CC>10 が base `complexity:"off"` で
 * 素通りする。leaf module に隔離し `packages/config/eslint/index.js` の scoped
 * `complexity:["error",10]` override 対象にすることで machine-enforce する。
 * また DI seam (`clock` / `isProcessAlive` / `graceMs`) で決定論化し、INV test の
 * namespace spy 依存を排除する (§3.6)。
 *
 * @module services/cache-orphan-sweep
 */

import * as fs from "fs";
import * as path from "path";
import { Logger } from "../utils/logger";
import { CACHE_TEMP_PREFIX, CACHE_TEMP_REGEX } from "./cache-temp-const";

const logger = new Logger("CacheOrphanSweep");

/** sweep の grace window (デフォルト 1h)。mtime がこの window 内の temp は非削除。 */
export const DEFAULT_SWEEP_GRACE_MS = 60 * 60 * 1000;

/** per-worker dbPath dir basename パターン (`<workerType>-<pid>`)。 */
const PER_WORKER_DIR_REGEX = /^(page|embedding-backfill)-(\d+)$/;

/**
 * DI seam: 注入可能な clock。
 */
export interface SweepClock {
  now(): number;
}

/** デフォルト clock (実時刻)。 */
export const realClock: SweepClock = { now: () => Date.now() };

/**
 * プロセス生存判定 (signal 0)。
 *
 * **EPERM≠ESRCH 区別 (Plan §2.5.3 / SEC mandate)**: mirror 元
 * `browser-process-manager.ts:284-293` の bare `catch { return false; }` を
 * **コピーしない**。EPERM (他ユーザー所有の生存プロセス) を ESRCH/ENOENT
 * (不在) と区別し、EPERM → alive (true) → 非削除 fail-safe とする。bare catch
 * をコピーすると他ユーザー生存プロセスの temp を「不在」と誤判定し誤削除
 * しうる (CWE-367 残余)。
 *
 * Distinguishes EPERM (a live process owned by another user) from ESRCH/ENOENT
 * (absent): EPERM → alive (true) → not-deleted fail-safe. The mirror source's
 * bare `catch { return false; }` is deliberately NOT copied.
 *
 * @param pid - 判定対象 pid
 * @returns 生存していれば true。EPERM / 判定不能も true (fail-safe)
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    // 不正 pid は判定不能 → fail-safe で alive 扱い (非削除)
    return true;
  }
  try {
    process.kill(pid, 0); // signal 0 = 存在確認
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "ENOENT") {
      return false; // 不在 = 削除候補
    }
    // EPERM (他ユーザー生存プロセス) その他 = 判定不能 → alive 扱い (非削除 fail-safe)
    return true;
  }
}

/** isProcessAlive の DI seam 型 (INV test で生死を固定 mapping)。 */
export type IsProcessAliveFn = (pid: number) => boolean;

/**
 * 3-stage whitelist (Plan §2.5.4、Phase 5 `cleanupPhase5TempDir` 同型)。
 *
 * 削除対象 path が安全であることを realpath ベースで検証する:
 *   Stage 1: null byte / 空 / 非 string reject
 *   Stage 2: realpath 解決 (symlink 攻撃防御、ENOENT は false)
 *   Stage 3: realpath が `allowedRoot` 配下 AND basename が許可パターン
 *
 * @param targetPath - 削除候補の絶対 path
 * @param allowedRoot - 許可する root (= 自 dbPath)
 * @param basenamePredicate - basename が許可形式かを判定する関数
 * @returns 削除して安全なら realpath を返す。それ以外 (whitelist 外) は null
 */
function whitelistResolve(
  targetPath: string,
  allowedRoot: string,
  basenamePredicate: (basename: string) => boolean
): string | null {
  // Stage 1: null byte defense
  if (typeof targetPath !== "string" || targetPath.length === 0 || targetPath.includes("\0")) {
    logger.warn("[CacheOrphanSweep] whitelist rejected invalid input (non-fatal)");
    return null;
  }

  // Stage 2: realpath resolution (symlink defense; ENOENT → skip)
  let realTarget: string;
  let realRoot: string;
  try {
    realTarget = fs.realpathSync(targetPath);
  } catch {
    // ENOENT / EACCES / ELOOP — treat as no-op (nothing to unlink).
    return null;
  }
  try {
    realRoot = fs.realpathSync(allowedRoot);
  } catch {
    // allowedRoot 解決不能 → whitelist 強制不能 → fail closed
    return null;
  }

  // Stage 3: whitelist — must be under allowedRoot AND basename predicate.
  const underRoot = realTarget.startsWith(realRoot + path.sep);
  const basenameOk = basenamePredicate(path.basename(realTarget));
  if (!underRoot || !basenameOk) {
    const truncated = realTarget.slice(0, 80);
    logger.warn("[CacheOrphanSweep] whitelist rejected path (non-fatal)", {
      pathPrefix: truncated,
      underRoot,
      basenameOk,
    });
    return null;
  }
  return realTarget;
}

/**
 * 自 dbPath 内の orphan temp ファイルを sweep する (Plan §3.2 INV-ORPHAN-SWEEP-002)。
 *
 * sweep 条件 (全 AND):
 *   - basename が `CACHE_TEMP_REGEX` (= `cache.json.tmp.`) にマッチ
 *   - 自プロセス pid の temp は非削除 (in-flight 保護)
 *   - pid 不在 (ESRCH/ENOENT) AND mtime が grace window 超過 → 削除
 *   - EPERM / 生存他 pid / 判定不能 → 非削除 (fail-safe)
 *   - 3-stage whitelist (dbPath 配下 + prefix) を通過した path のみ unlink
 *
 * @param dbPath - sweep 対象 dir (= 自 dbPath)
 * @param selfPid - 自プロセス pid (この pid の temp は保護)
 * @param clock - DI seam clock (mtime grace 判定)
 * @param isAlive - DI seam pid 生存判定
 * @param graceMs - mtime grace window
 * @returns 削除した temp ファイル数
 */
export function sweepOrphanTempFiles(
  dbPath: string,
  selfPid: number,
  clock: SweepClock = realClock,
  isAlive: IsProcessAliveFn = isProcessAlive,
  graceMs: number = DEFAULT_SWEEP_GRACE_MS
): number {
  const entries = safeReaddir(dbPath);
  const now = clock.now();
  let removed = 0;

  for (const entry of entries) {
    const realTarget = resolveDeletableTemp(dbPath, entry, selfPid, isAlive, now, graceMs);
    if (realTarget === null) continue;
    if (safeUnlinkFile(realTarget)) removed++;
  }

  return removed;
}

/** `fs.readdirSync` の no-throw ラッパ (dbPath 不在は空配列)。 */
function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** stat の mtimeMs を no-throw 取得 (取得不能は null)。 */
function statMtimeMs(target: string): number | null {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 1 entry が削除可能 orphan temp かを判定し、削除して安全な realTarget を返す。
 *
 * 非削除条件 (いずれかで null):
 *   - basename が temp prefix 不一致 / 自 pid in-flight / 生存(EPERM含む)他 pid /
 *     whitelist 外 / stat 不能 / mtime grace 内 (fresh)
 *
 * @returns 削除して安全な realTarget。それ以外は null
 */
function resolveDeletableTemp(
  dbPath: string,
  entry: string,
  selfPid: number,
  isAlive: IsProcessAliveFn,
  now: number,
  graceMs: number
): string | null {
  if (!CACHE_TEMP_REGEX.test(entry)) return null;

  const owningPid = parseTempPid(entry);
  if (owningPid === selfPid) return null; // 自 in-flight 保護
  if (owningPid !== null && isAlive(owningPid)) return null; // 生存/EPERM/判定不能 → 非削除

  const realTarget = whitelistResolve(path.join(dbPath, entry), dbPath, (b) =>
    CACHE_TEMP_REGEX.test(b)
  );
  if (realTarget === null) return null; // whitelist 外 / 解決不能

  const mtimeMs = statMtimeMs(realTarget);
  if (mtimeMs === null) return null; // stat 不能 = fail-safe 非削除
  if (now - mtimeMs < graceMs) return null; // fresh = 非削除

  return realTarget;
}

/** ファイル unlink の no-throw ラッパ。成功 true / 失敗 (warn) false。 */
function safeUnlinkFile(target: string): boolean {
  try {
    fs.unlinkSync(target);
    return true;
  } catch (e) {
    logger.warn("[CacheOrphanSweep] temp unlink failed (non-fatal)", {
      error: (e as Error).message,
    });
    return false;
  }
}

/**
 * temp 名 `cache.json.tmp.<pid>.<ts>` から owning pid を抽出する。
 *
 * **SSOT derive (TDA-IMPL-01)**: prefix を inline regex literal で再表現せず、
 * `CACHE_TEMP_PREFIX` (`cache-temp-const.ts` SSOT) から derive する。これにより
 * 将来 prefix を変更しても本関数が silent に pid 抽出 fail (= 削除候補漏れ →
 * leak 再発 latent path) しなくなる (coupling-drift 4th site 解消)。挙動は不変
 * (既存の `/^cache\.json\.tmp\.(\d+)\./` と等価: prefix 一致を確認し、後続の
 * 最初の `.` 区切りセグメント `<pid>` を `parsePidStrict` で厳格整数化)。
 *
 * SSOT-derived from `CACHE_TEMP_PREFIX` (no inline prefix literal). Behavior is
 * identical to the previous `/^cache\.json\.tmp\.(\d+)\./`.
 *
 * @returns pid (整数)。抽出不能なら null
 */
function parseTempPid(basename: string): number | null {
  // basename = <CACHE_TEMP_PREFIX><pid>.<ts>
  if (!basename.startsWith(CACHE_TEMP_PREFIX)) return null;
  // prefix の後ろから最初の "." までを pid セグメントとして取り出す。
  // 元 regex `/^<prefix>(\d+)\./` と等価にするため、pid セグメントの後ろに
  // `.<ts>` 区切りが存在すること (= dotIndex > 0) を必須とする。
  const tail = basename.slice(CACHE_TEMP_PREFIX.length);
  const dotIndex = tail.indexOf(".");
  if (dotIndex <= 0) return null;
  return parsePidStrict(tail.slice(0, dotIndex));
}

/**
 * pid 文字列を厳格に整数化する (正の整数のみ受理、それ以外 null)。
 *
 * @param pidStr - 抽出された pid 文字列 (undefined 可)
 * @returns 正の整数 pid。抽出/検証不能なら null
 */
function parsePidStrict(pidStr: string | undefined): number | null {
  if (pidStr === undefined) return null;
  const pid = Number.parseInt(pidStr, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * 死 pid の per-worker dbPath dir 全体を回収する (Plan §2.5.5 / U-14(a))。
 *
 * per-worker 化後は死 pid の本体 cache.json (70MB 級) も per-pid dir に残留し、
 * worker churn で per-pid dir が累積する (~26G surface = TDA-RE-02 指摘)。本関数は
 * `<root>` 直下の `<workerType>-<pid>` dir を走査し、pid が死 (ESRCH) AND mtime
 * grace 超過 AND whitelist 通過した dir のみ `fs.rmSync(recursive)` で全体回収する。
 *
 * Recovers the whole per-worker dbPath directory of a dead pid (Plan §2.5.5):
 * scans `<root>/<workerType>-<pid>` dirs and removes (recursively) only those
 * whose pid is dead (ESRCH), whose mtime exceeds grace, and which pass the
 * 3-stage whitelist.
 *
 * @param root - per-worker dbPath の root (`REFTRIX_EMBEDDING_CACHE_ROOT`)
 * @param selfPid - 自プロセス pid (この pid の dir は保護)
 * @param clock - DI seam clock
 * @param isAlive - DI seam pid 生存判定
 * @param graceMs - mtime grace window
 * @returns 回収した dir 数
 */
export function sweepDeadWorkerDirs(
  root: string,
  selfPid: number,
  clock: SweepClock = realClock,
  isAlive: IsProcessAliveFn = isProcessAlive,
  graceMs: number = DEFAULT_SWEEP_GRACE_MS
): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }

  const now = clock.now();
  let removed = 0;

  for (const dirent of entries) {
    const realTarget = resolveDeletableWorkerDir(root, dirent, selfPid, isAlive, now, graceMs);
    if (realTarget === null) continue;
    if (safeRmDir(realTarget)) removed++;
  }

  return removed;
}

/**
 * 1 dirent が削除可能 dead-worker dir かを判定し、realTarget を返す。
 *
 * @returns 削除して安全な realTarget。それ以外は null
 */
function resolveDeletableWorkerDir(
  root: string,
  dirent: fs.Dirent,
  selfPid: number,
  isAlive: IsProcessAliveFn,
  now: number,
  graceMs: number
): string | null {
  if (!dirent.isDirectory()) return null;
  const owningPid = parsePidStrict(dirent.name.match(PER_WORKER_DIR_REGEX)?.[2]);
  if (owningPid === null) return null;
  if (owningPid === selfPid) return null; // 自 dir 保護
  if (isAlive(owningPid)) return null; // 生存 / EPERM / 判定不能 → 非削除

  const realTarget = whitelistResolve(path.join(root, dirent.name), root, (b) =>
    PER_WORKER_DIR_REGEX.test(b)
  );
  if (realTarget === null) return null;

  const mtimeMs = statMtimeMs(realTarget);
  if (mtimeMs === null) return null;
  if (now - mtimeMs < graceMs) return null;

  return realTarget;
}

/** dir 再帰削除の no-throw ラッパ。成功 true / 失敗 (warn) false。 */
function safeRmDir(target: string): boolean {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (e) {
    logger.warn("[CacheOrphanSweep] dead worker dir recovery failed (non-fatal)", {
      error: (e as Error).message,
    });
    return false;
  }
}
