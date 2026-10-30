// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Scan logic shared by test-fixture-uuid-strict.test.ts (synced) and its private-only sibling
 * test-fixture-uuid-strict-private.test.ts. Holds no UUID-shaped literal itself.
 *
 * @module tests/utils/support/uuid-fixture-scan
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";

export const REPO_ROOT = resolve(__dirname, "../../../../..");
export const SCAN_ROOTS = ["apps", "packages"].flatMap((top) =>
  readdirSync(join(REPO_ROOT, top))
    .map((name) => join(REPO_ROOT, top, name, "tests"))
    .filter((dir) => existsSync(dir))
);
/** The two files that scan themselves out: the synced body and its private-only sibling (full paths, no pattern). */
export const SELF: ReadonlySet<string> = new Set([
  resolve(REPO_ROOT, "apps/mcp-server/tests/utils/test-fixture-uuid-strict.test.ts"),
  resolve(REPO_ROOT, "apps/mcp-server/tests/utils/test-fixture-uuid-strict-private.test.ts"),
]);
export const EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/;
export const UUID_SHAPE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

/**
 * Lower bound of UUID-shaped literals in the scanned dirs of the OSS tree (the synced body asserts it).
 * Defined once here; the body re-exports it and the private sibling imports it (a test file is never
 * imported, which would register its tests twice).
 *
 * Value (OSSCI-Plan-05) = floor(0.92 * N), N = the number of UUID-shaped literals `scanAll({})` counts in
 * the scanned dirs of a prepare-oss.sh-transformed tree.
 * Re-measure: apply the change to a tree, run `scripts/prepare-oss.sh` there, `pnpm install
 * --frozen-lockfile` in its oss/ output, then from oss/apps/mcp-server run
 * `pnpm exec tsx -e 'import { scanAll } from "./tests/utils/support/uuid-fixture-scan"; console.log("N=" + scanAll({}).matches)'`
 * and record the base commit and tree kind here. The private sibling asserts that the OSS-output count
 * stays within [MIN_OSS_MATCHES, ceil(1.15 * MIN_OSS_MATCHES)], so a stale value is caught.
 * Measured on: base 0e6f1b14 with this change applied, transformed by prepare-oss.sh (oss/), N = 821
 * (floor(0.92 * 821) = 755); the private sibling's ossOutputFiles() count on the same tree is N_oss = 821 (equal).
 */
export const MIN_OSS_MATCHES = 755;

export function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.test(entry.name) && !SELF.has(resolve(full))) out.push(full);
  }
}

export function scannedFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, files);
  return files;
}

/** Non-conforming UUID literals in `text` that `allowlist` does not name for `rel`. */
export function violationsIn(
  rel: string,
  text: string,
  allowlist: Readonly<Record<string, readonly string[]>>
): { matches: number; violations: string[] } {
  const strictUuid = z.string().uuid();
  const allowed = new Set(allowlist[rel] ?? []);
  let matches = 0;
  const violations: string[] = [];
  for (const match of text.matchAll(UUID_SHAPE)) {
    matches += 1;
    if (!strictUuid.safeParse(match[0]).success && !allowed.has(match[0])) {
      violations.push(`${rel}: ${match[0]}`);
    }
  }
  return { matches, violations };
}

/** Scan `files` (default: every scanned file); `perFile` is called with the repo-relative path and its match count. */
export function scanAll(
  allowlist: Readonly<Record<string, readonly string[]>>,
  files: string[] = scannedFiles()
): { matches: number; violations: string[]; rootsWithFiles: string[] } {
  const total = { matches: 0, violations: [] as string[], rootsWithFiles: [] as string[] };
  const roots = new Set<string>();
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    const found = violationsIn(rel, readFileSync(file, "utf8"), allowlist);
    total.matches += found.matches;
    total.violations.push(...found.violations);
    const root = SCAN_ROOTS.find((r) => file.startsWith(r + "/"));
    if (root) roots.add(relative(REPO_ROOT, root));
  }
  total.rootsWithFiles = [...roots].sort();
  return total;
}
