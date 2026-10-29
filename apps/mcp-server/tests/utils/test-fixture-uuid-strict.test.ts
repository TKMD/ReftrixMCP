// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test fixture UUID strictness guard
 *
 * zod 4 の `z.string().uuid()` は RFC 9562 厳格 (version nibble 1-8, variant 8/9/a/b)。
 * fixture に不適合な UUID リテラル (例: all-zero, `1111...`, `aaaa...`) が残ると
 * zod 4 で parse が失敗する。`z.guid()` に緩めず fixture 側を直す契約を固定する。
 *
 * zod 4's `z.string().uuid()` is RFC-strict (version nibble 1-8, variant 8/9/a/b).
 * This guard fails when a non-conforming UUID literal reappears in fixtures of the
 * covered test directories. Fix the fixture; never loosen the schema to `z.guid()`.
 *
 * 走査範囲は apps/<name>/tests と packages/<name>/tests の全体で、.js / .mjs / .cjs も含む。件数の下限・
 * 文字列の positive control・allowlist の実在で、空振りと古い許可を検出する (SEC-C2-02 / TDA L-2 / L-3)。
 * Scope: every apps/<name>/tests and packages/<name>/tests dir, .js / .mjs / .cjs included. A lower bound on
 * the match count, a string positive control and an allowlist-existence check catch a vacuous scan
 * and stale allowances.
 *
 * @module tests/utils/test-fixture-uuid-strict
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCAN_ROOTS = ["apps", "packages"].flatMap((top) =>
  readdirSync(join(REPO_ROOT, top))
    .map((name) => join(REPO_ROOT, top, name, "tests"))
    .filter((dir) => existsSync(dir))
);
const SELF = resolve(__filename);
const EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/;
/**
 * UUID-shaped literals in the scanned dirs (self excluded); a drop means the walk lost files.
 * 898 when the scope was widened (899 after #172 added one); 851 after #174 (measured on its merge):
 * -47 matches from the deleted tests/api/internal files and -1 from an edit of a standing test.
 */
const MIN_MATCHES = 851;
const UUID_SHAPE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

/**
 * 意図的に不適合な UUID を使う negative test のみを許可する (file -> literal 集合)。
 * Only negative tests that intentionally feed a non-conforming UUID may be listed.
 */
const INTENTIONAL_INVALID: Readonly<Record<string, readonly string[]>> = {
  "apps/mcp-server/tests/services/screenshot-persistence.service.test.ts": [
    "01234567-89ab-cdef-8123-456789abcdef", // version nibble c: must be rejected
    "01234567-89ab-7def-c123-456789abcdef", // variant nibble c: must be rejected
  ],
  "apps/mcp-server/tests/security/js-animation-search-security.test.ts": [
    "01936abc-def0-7123-c456-789abcdef012", // variant nibble c: must be rejected
  ],
  "apps/mcp-server/tests/security/rls-context.test.ts": [
    "12345678-1234-1234-1234-123456789abc", // version 1 / variant 1: legacy form that must be rejected
  ],
  "apps/mcp-server/tests/security/rls-context-integration.test.ts": [
    "12345678-1234-1234-1234-123456789abc", // version 1 / variant 1: legacy form that must be rejected
  ],
};

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.test(entry.name) && resolve(full) !== SELF) out.push(full);
  }
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, files);
  return files;
}

/** Non-conforming UUID literals in `text` that the allowlist does not name for `rel`. */
function violationsIn(rel: string, text: string): { matches: number; violations: string[] } {
  const strictUuid = z.string().uuid();
  const allowed = new Set(INTENTIONAL_INVALID[rel] ?? []);
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

function scanAll(): { matches: number; violations: string[] } {
  const total = { matches: 0, violations: [] as string[] };
  for (const file of scannedFiles()) {
    const found = violationsIn(relative(REPO_ROOT, file), readFileSync(file, "utf8"));
    total.matches += found.matches;
    total.violations.push(...found.violations);
  }
  return total;
}

/**
 * UUIDs assembled at run time: a variable head followed by a literal tail, `${i}-0000-4000-8000-...`
 * or ``${i}`.padStart(8, "0") + "-0000-..."`. The head is only digits and hex, so it is replaced by
 * eight zeros and the assembled UUID is judged like a literal one (TPA-C2 L-01).
 */
const RUNTIME_TAIL =
  /(?:(?<![-\w])\$\{[^}]+\}|padStart\(\s*8\s*,\s*["']0["']\s*\)\s*\+\s*["'])-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})/gi;

function runtimeBuiltViolations(rel: string, text: string): string[] {
  const strictUuid = z.string().uuid();
  const out: string[] = [];
  for (const m of text.matchAll(RUNTIME_TAIL)) {
    const assembled = `00000000-${m[1]}-${m[2]}-${m[3]}-${m[4]}`;
    if (!strictUuid.safeParse(assembled).success) out.push(`${rel}: ...${assembled.slice(8)}`);
  }
  return out;
}

describe("test fixture UUID strictness (RFC 9562, zod 4 uuid())", () => {
  it("scans every apps/<name>/tests and packages/<name>/tests dir, .js included, so the guard cannot pass vacuously", () => {
    const rels = SCAN_ROOTS.map((root) => relative(REPO_ROOT, root));
    expect(rels).toEqual(
      expect.arrayContaining(["apps/mcp-server/tests", "packages/database/tests"])
    );
    expect(rels.length).toBeGreaterThanOrEqual(6);
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => /\.(js|mjs|cjs)$/.test(f))).toBe(true);
    expect(scanAll().matches).toBeGreaterThanOrEqual(MIN_MATCHES);
  });

  it("recognises a non-conforming UUID as a violation (positive control)", () => {
    const strictUuid = z.string().uuid();
    expect(strictUuid.safeParse("00000000-0000-0000-0000-000000000001").success).toBe(false);
    expect(strictUuid.safeParse("0194a000-0000-4000-8000-000000000001").success).toBe(true);
  });

  it("reports a non-conforming literal in scanned text, and only the allowlisted file may keep it", () => {
    const text =
      'const id = "11111111-1111-1111-1111-111111111111"; const ok = "0194a000-0000-4000-8000-000000000001";';
    expect(violationsIn("apps/x/tests/a.test.ts", text)).toEqual({
      matches: 2,
      violations: ["apps/x/tests/a.test.ts: 11111111-1111-1111-1111-111111111111"],
    });
    const listed = "apps/mcp-server/tests/security/rls-context.test.ts";
    expect(violationsIn(listed, '"12345678-1234-1234-1234-123456789abc"').violations).toEqual([]);
    expect(
      violationsIn("apps/x/tests/b.test.ts", '"12345678-1234-1234-1234-123456789abc"').violations
    ).toHaveLength(1);
  });

  it("every allowlisted file exists, still holds its literal, and the literal is non-conforming", () => {
    const strictUuid = z.string().uuid();
    const stale = Object.entries(INTENTIONAL_INVALID).flatMap(([rel, literals]) => {
      const file = join(REPO_ROOT, rel);
      if (!existsSync(file)) return [`${rel}: file missing`];
      const text = readFileSync(file, "utf8");
      return literals.flatMap((literal) => [
        ...(text.includes(literal) ? [] : [`${rel}: ${literal} not found`]),
        ...(strictUuid.safeParse(literal).success ? [`${rel}: ${literal} is valid`] : []),
      ]);
    });
    expect(stale).toEqual([]);
  });

  it("has no non-conforming UUID literal in any apps/<name>/tests or packages/<name>/tests", () => {
    expect(scanAll().violations).toEqual([]);
  });

  it("(TPA-C2 L-01) the guard judges with the installed zod, whose regex accepts the max UUID", () => {
    const strictUuid = z.string().uuid();
    expect(strictUuid.safeParse("ffffffff-ffff-ffff-ffff-ffffffffffff").success).toBe(true);
    expect(strictUuid.safeParse("00000000-0000-0000-0000-000000000000").success).toBe(true);
    expect(strictUuid.safeParse("00000000-0000-0000-0000-000000000001").success).toBe(false);
  });

  it("(TPA-C2 L-01) positive control: a run-time built UUID with a non-conforming tail is reported", () => {
    const bad = 'const id = `${i}`.padStart(8, "0") + "-0000-0000-0000-000000000001";';
    const bad2 = "const id = `${n}-1111-1111-1111-111111111111`;";
    const good = "const id = `${n}-0000-4000-8000-000000000000`;";
    expect(runtimeBuiltViolations("x", bad)).toHaveLength(1);
    expect(runtimeBuiltViolations("x", bad2)).toHaveLength(1);
    expect(runtimeBuiltViolations("x", good)).toEqual([]);
  });

  it("(TPA-C2 L-01) no run-time built UUID in the scanned dirs has a non-conforming tail", () => {
    const found = scannedFiles().flatMap((f) =>
      runtimeBuiltViolations(relative(REPO_ROOT, f), readFileSync(f, "utf8"))
    );
    expect(found).toEqual([]);
  });
});
