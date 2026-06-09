// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-CACHE-ORPHAN-SWEEP-002 (Plan v2 §3.2)
 *
 * 起動時 orphan sweep の契約 (H-01 降格の Phase 2 必須 landing):
 *   (a) 死んだ pid の古い orphan を削除
 *   (b) 自プロセス in-flight temp を非削除
 *   (c) 生存他 pid の fresh temp を非削除 (SEC mandate / SEC-H-01 降格条件)
 *   (d) 判定不能を非削除 fail-safe
 *   (e) per-worker dbPath が `<workerType>-<pid>` suffix を含む配線 assert (U-9)
 *   (f) EPERM を返す pid の temp 非削除 (EPERM→alive fail-safe, U-13(b))
 *   (g) dbPath 配下外の path を unlink しない (3-stage whitelist, U-13(c))
 *
 * 決定論化 (Plan §3.6): DI seam (`clock` / `isProcessAlive` / `graceMs`) で固定
 * inject。`vi.spyOn(fs,...)` namespace spy は使わず実 FS + DI 関数で制御する。
 *
 * executable invariant. `.skip()` / `.todo()` forbidden; failure = P0 incident.
 *
 * @see  §3.2 / §2.5.1 / §2.5.3 / §2.5.4
 * @module tests/regression/standing/large-page/inv-cache-orphan-sweep-002
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import { assertInvName } from "../_setup/inv-assert";
import {
  sweepOrphanTempFiles,
  type SweepClock,
  type IsProcessAliveFn,
} from "../../../../src/services/cache-orphan-sweep";
import { resolvePerWorkerCacheConfig } from "../../../../src/services/layout-embedding.service";
import { CACHE_TEMP_PREFIX } from "../../../../src/services/cache-temp-const";

const INV = "INV-CACHE-ORPHAN-SWEEP-002";

const SELF_PID = process.pid;
const DEAD_PID = 999_999_001; // ESRCH を返す DI mapping
const LIVE_OTHER_PID = 999_999_002; // 生存他 pid (DI mapping)
const EPERM_PID = 999_999_003; // EPERM → alive 扱い (DI mapping)
const GRACE_MS = 60 * 60 * 1000; // 1h
const FIXED_NOW = 1_700_000_000_000;

const fixedClock: SweepClock = { now: () => FIXED_NOW };

const fakeIsAlive: IsProcessAliveFn = (pid: number): boolean => {
  if (pid === DEAD_PID) return false; // ESRCH → 削除候補
  if (pid === LIVE_OTHER_PID) return true; // 生存 → 非削除
  if (pid === EPERM_PID) return true; // (f) EPERM → alive 扱い → 非削除
  if (pid === SELF_PID) return true;
  return true; // 判定不能 → fail-safe alive
};

/** temp ファイルを mtime 指定で作成する。 */
function writeTempWithMtime(dir: string, pid: number, ts: number, mtimeMs: number): string {
  const name = `${CACHE_TEMP_PREFIX}${pid}.${ts}`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, "{}", "utf8");
  const atime = new Date(mtimeMs);
  fs.utimesSync(full, atime, atime);
  return full;
}

describe(`${INV}: startup orphan sweep deletes dead-pid orphans only (a)-(g)`, () => {
  let dbDir: string;

  beforeEach(() => assertInvName(expect.getState().currentTestName ?? "", INV));

  afterEach(async () => {
    if (dbDir) {
      await fsp.rm(dbDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it(`${INV}: (a) deletes dead-pid stale orphan, (b) keeps self in-flight, (c) keeps live-other fresh, (d) fail-safe`, async () => {
    dbDir = await fsp.mkdtemp(path.join(os.tmpdir(), "reftrix-cache-sweep-abcd-"));

    // (a) dead pid + stale (grace 超過) → 削除
    const deadStale = writeTempWithMtime(dbDir, DEAD_PID, 1, FIXED_NOW - GRACE_MS - 1);
    // (b) self pid in-flight → 非削除 (pid 一致で保護)
    const selfInflight = writeTempWithMtime(dbDir, SELF_PID, 2, FIXED_NOW - GRACE_MS - 1);
    // (c) live-other pid fresh → 非削除 (alive 判定)
    const liveFresh = writeTempWithMtime(dbDir, LIVE_OTHER_PID, 3, FIXED_NOW - 1);
    // (d) dead pid だが fresh (grace 内) → 非削除 (mtime grace fail-safe)
    const deadFresh = writeTempWithMtime(dbDir, DEAD_PID, 4, FIXED_NOW - 1);

    const removed = sweepOrphanTempFiles(dbDir, SELF_PID, fixedClock, fakeIsAlive, GRACE_MS);

    expect(removed).toBe(1);
    expect(fs.existsSync(deadStale)).toBe(false); // (a) 削除
    expect(fs.existsSync(selfInflight)).toBe(true); // (b) 保護
    expect(fs.existsSync(liveFresh)).toBe(true); // (c) 保護
    expect(fs.existsSync(deadFresh)).toBe(true); // (d) 保護
  });

  it(`${INV}: (e) per-worker dbPath carries <workerType>-<pid> suffix (H-01 wiring assert)`, () => {
    // U-9: worker child は REFTRIX_WORKER_CHILD_TYPE 経由で per-pid dbPath を得る。
    const prev = process.env.REFTRIX_WORKER_CHILD_TYPE;
    try {
      process.env.REFTRIX_WORKER_CHILD_TYPE = "page";
      const cfg = resolvePerWorkerCacheConfig();
      expect(cfg.dbPath).toBeDefined();
      // dbPath basename = `page-<pid>` (per-worker 配線 assert)
      expect(cfg.dbPath as string).toMatch(/\/(page|embedding-backfill)-\d+$/);
      expect(path.basename(cfg.dbPath as string)).toBe(`page-${SELF_PID}`);
    } finally {
      if (prev === undefined) delete process.env.REFTRIX_WORKER_CHILD_TYPE;
      else process.env.REFTRIX_WORKER_CHILD_TYPE = prev;
    }
  });

  it(`${INV}: (e) MCP server (non-worker) uses fixed mcp-server dbPath`, () => {
    const prev = process.env.REFTRIX_WORKER_CHILD_TYPE;
    try {
      delete process.env.REFTRIX_WORKER_CHILD_TYPE;
      const cfg = resolvePerWorkerCacheConfig();
      expect(path.basename(cfg.dbPath as string)).toBe("mcp-server");
    } finally {
      if (prev !== undefined) process.env.REFTRIX_WORKER_CHILD_TYPE = prev;
    }
  });

  it(`${INV}: (f) EPERM pid temp is NOT deleted (EPERM->alive fail-safe)`, async () => {
    dbDir = await fsp.mkdtemp(path.join(os.tmpdir(), "reftrix-cache-sweep-eperm-"));

    // EPERM pid + stale (grace 超過) でも EPERM→alive 扱いで非削除
    const epermStale = writeTempWithMtime(dbDir, EPERM_PID, 1, FIXED_NOW - GRACE_MS - 1);

    const removed = sweepOrphanTempFiles(dbDir, SELF_PID, fixedClock, fakeIsAlive, GRACE_MS);

    expect(removed).toBe(0);
    expect(fs.existsSync(epermStale)).toBe(true); // (f) EPERM = 非削除
  });

  it(`${INV}: (g) non-temp files and files outside whitelist are NOT unlinked`, async () => {
    dbDir = await fsp.mkdtemp(path.join(os.tmpdir(), "reftrix-cache-sweep-whitelist-"));

    // cache.json 本体 (temp ではない) は CACHE_TEMP_REGEX 不一致 → sweep 対象外
    const body = path.join(dbDir, "cache.json");
    fs.writeFileSync(body, "{}", "utf8");
    // 無関係ファイル (prefix 不一致)
    const unrelated = path.join(dbDir, "unrelated.json");
    fs.writeFileSync(unrelated, "{}", "utf8");
    // dead-pid stale temp (削除されるべき正常ケース、対照)
    const deadStale = writeTempWithMtime(dbDir, DEAD_PID, 1, FIXED_NOW - GRACE_MS - 1);

    const removed = sweepOrphanTempFiles(dbDir, SELF_PID, fixedClock, fakeIsAlive, GRACE_MS);

    expect(removed).toBe(1);
    expect(fs.existsSync(body)).toBe(true); // (g) cache.json 本体 非削除
    expect(fs.existsSync(unrelated)).toBe(true); // (g) 無関係ファイル 非削除
    expect(fs.existsSync(deadStale)).toBe(false); // 対照: temp は削除
  });
});
