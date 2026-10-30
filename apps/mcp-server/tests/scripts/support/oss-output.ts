// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The file set of the OSS output, shared by the synced INV-REGSYNC-OSSSYNC-008 test and the
 * private-only INV-INFRA-OSSREFS-001 / uuid-strict sibling.
 *
 * In the private repository the OSS output is computed with the same rsync filters
 * scripts/prepare-oss.sh uses (.ossfilter, then its --include list), as a dry run. In the
 * OSS repository itself (no prepare-oss.sh) the checkout is the output.
 *
 * @module tests/scripts/support/oss-output
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { expect } from "vitest";

export const REPO_ROOT = resolve(__dirname, "../../../../..");
export const PREPARE = join(REPO_ROOT, "scripts/prepare-oss.sh");

/** Every file (repo-relative, `/` separated) in the OSS output; null in the OSS tree, where the checkout is the output. */
export function ossOutputFiles(): Set<string> | null {
  if (!existsSync(PREPARE)) return null;
  const src = readFileSync(PREPARE, "utf-8");
  const block = src.slice(src.indexOf("phase2_rsync() {"), src.indexOf('./ "$OSS_DIR/"'));
  const includes = [...block.matchAll(/--include='([^']+)'/g)].map((m) => `--include=${m[1]}`);
  expect(includes.length).toBeGreaterThan(30);
  expect(block.match(/--exclude=/g)).toHaveLength(1);
  expect(block).toContain("--exclude='*'");
  const r = spawnSync(
    "rsync",
    [
      "-anm",
      "--safe-links",
      "--out-format=%n",
      "--filter=merge .ossfilter",
      ...includes,
      "--exclude=*",
      "./",
      "/nonexistent-oss/",
    ],
    { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }
  );
  expect(r.status, r.stderr).toBe(0);
  return new Set(r.stdout.split("\n").filter((l) => l && !l.endsWith("/")));
}

export function ossOutput(): (path: string) => boolean {
  const files = ossOutputFiles();
  if (files === null) return (p) => existsSync(join(REPO_ROOT, p));
  return (p) => files.has(p);
}
