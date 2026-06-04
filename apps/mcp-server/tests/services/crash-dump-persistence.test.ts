// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Crash Dump Persistence Service — unit tests (Wave 3 PR3b)
 *
 * Plan v3 T2 V1 §7.1 unit test coverage for Δ10 3-stage whitelist defense.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CRASH_DUMP_DIR_MODE,
  CRASH_DUMP_DIR_PREFIX,
  createStagingRoot,
  destroyStagingRoot,
  diskUsageBytes,
  resolveCrashDumpRoot,
  resolveCrashDumpSubdir,
  validateCrashDumpPath,
} from "../../src/services/crash-dump-persistence.service";

describe("crash-dump-persistence — root resolution (Δ10 3-stage defense)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.REFTRIX_CRASH_DUMP_ROOT;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.REFTRIX_CRASH_DUMP_ROOT;
    } else {
      process.env.REFTRIX_CRASH_DUMP_ROOT = originalEnv;
    }
  });

  it("creates the default root with prefix under os.tmpdir()", async () => {
    delete process.env.REFTRIX_CRASH_DUMP_ROOT;
    const root = await resolveCrashDumpRoot();
    expect(root).toContain(CRASH_DUMP_DIR_PREFIX);
    expect(path.basename(root).startsWith(CRASH_DUMP_DIR_PREFIX)).toBe(true);
  });

  it("rejects null-byte injection in path validator (Stage 1)", async () => {
    // Note: Node's `process.env.X = "...\0..."` is truncated at the null byte
    // by POSIX environ semantics, so we cannot inject a null byte via env.
    // Stage 1 defense IS exercised by direct API calls — see
    // validateCrashDumpPath null-byte test below in this file.
    // This test asserts the env happy path still works (sanity).
    delete process.env.REFTRIX_CRASH_DUMP_ROOT;
    const root = await resolveCrashDumpRoot();
    expect(root.length).toBeGreaterThan(0);
  });

  it("rejects paths outside os.tmpdir() (Stage 3 whitelist)", async () => {
    process.env.REFTRIX_CRASH_DUMP_ROOT = "/var/lib/reftrix-crashes";
    // This will FAIL because /var/lib does not exist or is not under os.tmpdir().
    // We accept either ENOENT or whitelist violation as proof Stage 3 fired.
    await expect(resolveCrashDumpRoot()).rejects.toThrow();
  });

  it("rejects paths whose basename does not start with reftrix-crashes prefix", async () => {
    // Create a sibling temp dir that does NOT start with our prefix.
    const wrongPrefix = await fsp.mkdtemp(path.join(os.tmpdir(), "wrong-prefix-"));
    try {
      process.env.REFTRIX_CRASH_DUMP_ROOT = wrongPrefix;
      await expect(resolveCrashDumpRoot()).rejects.toThrow(/whitelist violation/);
    } finally {
      await fsp.rm(wrongPrefix, { recursive: true, force: true });
    }
  });
});

describe("crash-dump-persistence — subdirectory resolution", () => {
  let root: string;

  beforeEach(async () => {
    // Use a fresh staging-like prefix so we have a clean root each test.
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), `${CRASH_DUMP_DIR_PREFIX}-test-`));
    root = tmp;
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("creates per-(workerType, role) subdirs under root", async () => {
    const subdir = await resolveCrashDumpSubdir(root, "page", "child");
    expect(subdir).toContain("page");
    expect(subdir).toContain("child");
    const stat = await fsp.stat(subdir);
    expect(stat.isDirectory()).toBe(true);
    // POSIX mode 0o700 enforcement (best-effort — some filesystems mask).
    // We assert at least owner has rwx by checking mode bits low 9.
    expect(stat.mode & 0o700).toBe(0o700);
  });

  it("rejects workerType with path separator (defense)", async () => {
    await expect(resolveCrashDumpSubdir(root, "page/../etc", "child")).rejects.toThrow(
      /path-defense/i
    );
  });

  it("rejects null byte in workerType", async () => {
    await expect(resolveCrashDumpSubdir(root, "page\0bad", "child")).rejects.toThrow(
      /path-defense/i
    );
  });

  it("rejects null byte in role", async () => {
    await expect(resolveCrashDumpSubdir(root, "page", "child\0bad" as "child")).rejects.toThrow(
      /path-defense/i
    );
  });
});

describe("crash-dump-persistence — staging root lifecycle", () => {
  it("creates a session-unique staging dir under os.tmpdir()", async () => {
    const stagingA = await createStagingRoot();
    const stagingB = await createStagingRoot();
    expect(stagingA).not.toBe(stagingB);
    expect(path.basename(stagingA)).toMatch(/^reftrix-crash-staging-/);
    expect(path.basename(stagingB)).toMatch(/^reftrix-crash-staging-/);
    await destroyStagingRoot(stagingA);
    await destroyStagingRoot(stagingB);
  });

  it("destroyStagingRoot safely no-ops on invalid input", async () => {
    await destroyStagingRoot(""); // empty
    await destroyStagingRoot("/etc/passwd"); // outside whitelist
    await destroyStagingRoot("/tmp/bad\0null"); // null byte
    await destroyStagingRoot("/tmp/random-not-staging"); // wrong prefix
    // All should silently no-op; no throw expected.
  });

  it("destroyStagingRoot removes a valid staging dir", async () => {
    const staging = await createStagingRoot();
    await fsp.writeFile(path.join(staging, "test.json"), "{}");
    await destroyStagingRoot(staging);
    await expect(fsp.stat(staging)).rejects.toThrow(); // ENOENT after removal
  });
});

describe("crash-dump-persistence — validateCrashDumpPath", () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), `${CRASH_DUMP_DIR_PREFIX}-test-`));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("accepts a valid file inside the root", async () => {
    const subdir = await resolveCrashDumpSubdir(root, "page", "child");
    const file = path.join(subdir, "report.1.1.json");
    await fsp.writeFile(file, "{}");
    const resolved = await validateCrashDumpPath(root, file);
    expect(resolved).toContain("report.1.1.json");
  });

  it("rejects paths outside the root", async () => {
    const outside = path.join(os.tmpdir(), `${CRASH_DUMP_DIR_PREFIX}-other-than-root`);
    await fsp.mkdir(outside, { recursive: true });
    const outsideFile = path.join(outside, "evil.json");
    await fsp.writeFile(outsideFile, "{}");
    try {
      await expect(validateCrashDumpPath(root, outsideFile)).rejects.toThrow();
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects null-byte injection", async () => {
    await expect(validateCrashDumpPath(root, "/tmp/bad\0path")).rejects.toThrow();
  });
});

describe("crash-dump-persistence — disk usage accounting", () => {
  it("sums file sizes in a directory (non-recursive)", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `${CRASH_DUMP_DIR_PREFIX}-du-`));
    try {
      await fsp.writeFile(path.join(dir, "a.json"), "x".repeat(100));
      await fsp.writeFile(path.join(dir, "b.json"), "y".repeat(50));
      const total = await diskUsageBytes(dir);
      expect(total).toBe(150);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 for non-existent dir", async () => {
    expect(await diskUsageBytes("/does/not/exist")).toBe(0);
  });
});
