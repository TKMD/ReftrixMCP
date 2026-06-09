// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-EMBEDDING-CACHE-DISABLED-004 (Plan v2 §3.4)
 *
 * `EMBEDDING_CACHE_ENABLED=false` (operator opt-out) のとき、`initializeEmbeddingCache`
 * が PersistentCache を作らず dbPath にファイルを一切生成しないことを assert する
 * (U-3 additive flag, default true)。cache off で leak surface が完全に消滅する。
 *
 * When `EMBEDDING_CACHE_ENABLED=false`, no PersistentCache is created and no file
 * is written under dbPath (additive opt-out flag; default remains cache on).
 *
 * executable invariant. `.skip()` / `.todo()` forbidden; failure = P0 incident.
 *
 * @see  §3.4 / §2.4
 * @module tests/regression/standing/large-page/inv-embedding-cache-disabled-004
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { assertInvName } from "../_setup/inv-assert";
import {
  initializeEmbeddingCache,
  closeEmbeddingCache,
  getEmbeddingCacheStats,
} from "../../../../src/services/layout-embedding.service";

const INV = "INV-EMBEDDING-CACHE-DISABLED-004";

describe(`${INV}: EMBEDDING_CACHE_ENABLED=false creates no cache files`, () => {
  let cacheRoot: string;
  let prevEnabled: string | undefined;
  let prevRoot: string | undefined;
  let prevChildType: string | undefined;

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
    prevEnabled = process.env.EMBEDDING_CACHE_ENABLED;
    prevRoot = process.env.REFTRIX_EMBEDDING_CACHE_ROOT;
    prevChildType = process.env.REFTRIX_WORKER_CHILD_TYPE;
  });

  afterEach(async () => {
    await closeEmbeddingCache().catch(() => {});
    if (prevEnabled === undefined) delete process.env.EMBEDDING_CACHE_ENABLED;
    else process.env.EMBEDDING_CACHE_ENABLED = prevEnabled;
    if (prevRoot === undefined) delete process.env.REFTRIX_EMBEDDING_CACHE_ROOT;
    else process.env.REFTRIX_EMBEDDING_CACHE_ROOT = prevRoot;
    if (prevChildType === undefined) delete process.env.REFTRIX_WORKER_CHILD_TYPE;
    else process.env.REFTRIX_WORKER_CHILD_TYPE = prevChildType;
    if (cacheRoot) {
      await fs.rm(cacheRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it(`${INV}: disabled flag -> no PersistentCache, no files under dbPath`, async () => {
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-cache-disabled-"));
    process.env.EMBEDDING_CACHE_ENABLED = "false";
    process.env.REFTRIX_EMBEDDING_CACHE_ROOT = cacheRoot;
    delete process.env.REFTRIX_WORKER_CHILD_TYPE; // mcp-server

    initializeEmbeddingCache({ dbPath: path.join(cacheRoot, "mcp-server") });

    // cache off → getStats は null (PersistentCache 非生成)
    const stats = await getEmbeddingCacheStats();
    expect(stats).toBeNull();

    // dbPath subdir にファイルが一切生成されていない
    const dbPath = path.join(cacheRoot, "mcp-server");
    const exists = await fs
      .readdir(dbPath)
      .then((f) => f.length)
      .catch(() => 0);
    expect(exists).toBe(0);
  });

  it(`${INV}: default (flag unset) -> cache enabled (additive flag, default on)`, async () => {
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-cache-default-on-"));
    delete process.env.EMBEDDING_CACHE_ENABLED; // default
    process.env.REFTRIX_EMBEDDING_CACHE_ROOT = cacheRoot;
    delete process.env.REFTRIX_WORKER_CHILD_TYPE;

    initializeEmbeddingCache({ dbPath: path.join(cacheRoot, "mcp-server") });

    // default = cache on → getStats は非 null
    const stats = await getEmbeddingCacheStats();
    expect(stats).not.toBeNull();
  });
});
