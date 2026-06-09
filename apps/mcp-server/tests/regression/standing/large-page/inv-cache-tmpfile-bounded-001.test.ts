// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-CACHE-TMPFILE-BOUNDED-001 (Plan v2 §3.1)
 *
 * Embedding cache temp-leak 根治 (MEMORY.md `project_embedding_cache_temp_leak_disk_full`)。
 * N 回 set() + get() HIT 後の `cache.json.tmp.*` orphan が settle 後 `toBe(0)` で
 * あることを assert する。`get()` HIT の debounce save により read-heavy ワークロード
 * (bulk page.analyze は cache lookup が主) でも temp が累積しないことを確認する (U-2)。
 *
 * After N set() + get() HIT operations the `cache.json.tmp.*` orphan count must
 * settle to 0 — including the get()-HIT debounce save path (read-heavy workload).
 *
 * executable invariant. `.skip()` / `.todo()` forbidden; failure = P0 incident.
 *
 * @see  §3.1
 * @module tests/regression/standing/large-page/inv-cache-tmpfile-bounded-001
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { assertInvName } from "../_setup/inv-assert";
import { PersistentCache } from "../../../../src/services/persistent-cache";
import { CACHE_TEMP_REGEX } from "../../../../src/services/cache-temp-const";

const INV = "INV-CACHE-TMPFILE-BOUNDED-001";

async function countOrphanTemps(dir: string): Promise<number> {
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  return files.filter((f) => CACHE_TEMP_REGEX.test(f)).length;
}

describe(`${INV}: embedding cache temp file orphan is bounded to 0 after settle`, () => {
  let tmpDir: string;
  let cache: PersistentCache<string> | null = null;

  beforeEach(() => assertInvName(expect.getState().currentTestName ?? "", INV));

  afterEach(async () => {
    if (cache) {
      await cache.close();
      cache = null;
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it(`${INV}: set()-heavy loop leaves 0 orphan temp after settle`, async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-cache-bounded-set-"));
    cache = new PersistentCache<string>({
      dbPath: tmpDir,
      maxSize: 100,
      defaultTtlMs: 60_000,
      enableLogging: false,
      sweepOnInit: false,
    });

    // set() は同期 saveToDisk (await) のため rename 成功で temp は即消費される。
    for (let i = 0; i < 30; i++) {
      await cache.set(`key-${i}`, `value-${i}`);
    }

    expect(await countOrphanTemps(tmpDir)).toBe(0);
  });

  it(`${INV}: get()-HIT loop (debounce save) settles to 0 orphan temp`, async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-cache-bounded-get-"));
    cache = new PersistentCache<string>({
      dbPath: tmpDir,
      maxSize: 100,
      defaultTtlMs: 60_000,
      enableLogging: false,
      sweepOnInit: false,
    });

    await cache.set("hot-key", "hot-value");

    // U-2: read-heavy。get() HIT は saveToDiskDebounced (100ms timer) を発火する。
    for (let i = 0; i < 50; i++) {
      const v = await cache.get("hot-key");
      expect(v).toBe("hot-value");
    }

    // debounce settle を待つ (timer 100ms + rename margin)。
    await new Promise((r) => setTimeout(r, 400));

    expect(await countOrphanTemps(tmpDir)).toBe(0);
  });
});
