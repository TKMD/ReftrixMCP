// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-CACHE-WRITE-FAILURE-CLEANUP-003 (Plan v2 §3.3 / §2.10)
 *
 * `saveToDisk` の writeFile↔rename 間 try/finally が、rename 失敗/例外時に temp を
 * unlink し orphan を残さないことを assert する (U-10)。`fs.rename` を DI seam で
 * reject inject し (namespace spy 回避、TPA-08)、writeFile 成功 → rename 失敗 →
 * temp cleanup の経路を決定論的に検証する。
 *
 * Verifies the `saveToDisk` writeFile↔rename try/finally unlinks the temp on a
 * failed rename (no orphan left). The rename is fault-injected via DI seam
 * (`renameImpl`) to avoid namespace spies.
 *
 * executable invariant. `.skip()` / `.todo()` forbidden; failure = P0 incident.
 *
 * @see  §3.3 / §2.10
 * @module tests/regression/standing/large-page/inv-cache-write-failure-cleanup-003
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { assertInvName } from "../_setup/inv-assert";
import { PersistentCache } from "../../../../src/services/persistent-cache";
import { CACHE_TEMP_REGEX } from "../../../../src/services/cache-temp-const";

const INV = "INV-CACHE-WRITE-FAILURE-CLEANUP-003";

async function countOrphanTemps(dir: string): Promise<number> {
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  return files.filter((f) => CACHE_TEMP_REGEX.test(f)).length;
}

describe(`${INV}: failed rename unlinks temp via try/finally (no orphan)`, () => {
  let tmpDir: string;
  let cache: PersistentCache<string> | null = null;

  beforeEach(() => assertInvName(expect.getState().currentTestName ?? "", INV));

  afterEach(async () => {
    if (cache) {
      await cache.close().catch(() => {});
      cache = null;
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it(`${INV}: rename always rejects -> set() throws but leaves 0 orphan temp`, async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-cache-wfc-"));

    // DI seam: rename を常に reject (writeFile 後 rename 失敗を注入)。
    const alwaysFailRename = (): Promise<void> => Promise.reject(new Error("injected rename EIO"));

    cache = new PersistentCache<string>({
      dbPath: tmpDir,
      maxSize: 10,
      defaultTtlMs: 60_000,
      enableLogging: false,
      sweepOnInit: false,
      writeRetries: 2, // 各 attempt で finally unlink が走ることを確認
      renameImpl: alwaysFailRename,
    });

    // set() は writeRetries 全失敗で throw する。
    await expect(cache.set("k", "v")).rejects.toThrow();

    // U-10: 各 attempt の temp は finally で unlink され orphan を残さない。
    expect(await countOrphanTemps(tmpDir)).toBe(0);

    // skipFlushOnClose 未指定 (=false, server扱い) のため close でも flush を試みるが、
    // renameImpl が reject するため close 経路の temp も finally で回収される。
    await cache.close().catch(() => {});
    cache = null;
    expect(await countOrphanTemps(tmpDir)).toBe(0);
  });

  it(`${INV}: rename succeeds -> temp consumed, cache.json persisted, 0 orphan`, async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-cache-wfc-ok-"));

    // DI seam 未指定 = production fs.rename (success path 対照)。
    cache = new PersistentCache<string>({
      dbPath: tmpDir,
      maxSize: 10,
      defaultTtlMs: 60_000,
      enableLogging: false,
      sweepOnInit: false,
    });

    await cache.set("k", "v");

    expect(await countOrphanTemps(tmpDir)).toBe(0);
    const body = path.join(tmpDir, "cache.json");
    const stat = await fs.stat(body);
    expect(stat.isFile()).toBe(true);
  });
});
