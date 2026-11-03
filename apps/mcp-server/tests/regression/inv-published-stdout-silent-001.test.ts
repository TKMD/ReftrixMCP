// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-PUBLISHED-STDOUT-SILENT-001 (supersedes the ml-only INV-ML-STDOUT-SILENT-001, which is kept)
 *
 * The MCP server speaks JSON-RPC over stdout (stdio transport). Any console.log / info / debug /
 * dir / table, or process.stdout.write, in the runtime source of a published package can corrupt
 * the protocol. This scans src/ of all 5 published packages (scripts/publish-targets.sh) and fails
 * on a stdout write outside the documented allowlist.
 *
 * MCP stdio サーバーは stdout を JSON-RPC に使うため、公開 5 パッケージの src に stdout 書き込みを
 * 置いてはならない。許可リスト外の追加で fail する。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

const PUBLISHED_PACKAGES = [
  "apps/mcp-server",
  "packages/core",
  "packages/database",
  "packages/ml",
  "packages/webdesign-core",
] as const;

/**
 * Allowlist (repo-relative path prefixes) / 許可リスト。
 * - apps/mcp-server/src/scripts/: CLI / worker entrypoints (backfill, coverage check, start-workers)
 *   run as their own process and print reports to stdout on purpose. start-workers runs as a CHILD of
 *   the server (worker-supervisor fork) with stdio[1] = "pipe" drained to stderr; that setting is
 *   asserted in tests/services/worker-supervisor.test.ts.
 * - packages/database/src/seed: database seed CLIs, run by hand, report to stdout on purpose.
 * - packages/database/src/generated/: Prisma generator output (third-party runtime), recreated by
 *   `prisma generate`. Its stdout paths (info/query log levels) stay off because every runtime
 *   PrismaClient uses the event-only log config (src/utils/prisma-stderr-log.ts).
 */
const ALLOWLIST = [
  "apps/mcp-server/src/scripts/",
  "packages/database/src/seed",
  "packages/database/src/generated/",
] as const;

// trace / assert write to stderr in Node and are intentionally not listed.
const STDOUT_METHODS =
  "log|info|debug|dir|dirxml|table|count|countReset|time|timeEnd|timeLog|group|groupCollapsed";

// Every spelling that reaches stdout: console.<m>, console["<m>"], `{ <m> } = console`,
// process.stdout / process["stdout"], and fs.writeSync(1, ...).
const STDOUT_WRITE_FORMS: readonly RegExp[] = [
  new RegExp(`\\bconsole\\s*\\.\\s*(${STDOUT_METHODS})\\b`),
  new RegExp(`\\bconsole\\s*\\[\\s*["'\`](${STDOUT_METHODS})["'\`]\\s*\\]`),
  new RegExp(`\\{[^}]*\\b(${STDOUT_METHODS})\\b[^}]*\\}\\s*=\\s*console\\b`),
  /\bprocess\s*(\.\s*stdout\b|\[\s*["'`]stdout["'`]\s*\])/,
  /\bwriteSync\(\s*1\s*,/,
];

export function writesToStdout(line: string): boolean {
  return STDOUT_WRITE_FORMS.some((re) => re.test(line));
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs|cjs)$/.test(p) ? [p] : [];
  });
}

/** Drop JSDoc / line-comment lines (usage examples) so only executable lines are matched. */
function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trim();
    return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
  });
}

describe("INV-PUBLISHED-STDOUT-SILENT-001", () => {
  it("scans all 5 published packages", () => {
    for (const pkg of PUBLISHED_PACKAGES) {
      const root = join(REPO_ROOT, pkg, "src");
      expect(statSync(root).isDirectory()).toBe(true);
      const scanned = walk(root).filter(
        (f) => !ALLOWLIST.some((a) => relative(REPO_ROOT, f).split("\\").join("/").startsWith(a))
      );
      expect(scanned.length).toBeGreaterThan(0);
    }
  });

  it("detector flags every stdout spelling and ignores stderr", () => {
    const flagged = [
      'console.log("x")',
      "console.info('x')",
      "console.debug(x)",
      "console.dir(x)",
      "console.table(rows)",
      "console.count()",
      "console.timeEnd('t')",
      "console.timeLog('t')",
      "console.group('g')",
      "console.groupCollapsed('g')",
      "console.dirxml(x)",
      'console["log"]("x")',
      "const { log } = console;",
      "const { error, table: t } = console;",
      "process.stdout.write('x')",
      'process["stdout"].write(x)',
      "fs.writeSync(1, 'x')",
    ];
    const clean = [
      'console.error("x")',
      "console.warn(x)",
      "const { error } = console;",
      "process.stderr.write(x)",
    ];
    expect(flagged.filter((l) => !writesToStdout(l))).toEqual([]);
    expect(clean.filter(writesToStdout)).toEqual([]);
  });

  it("published src has no stdout write outside the allowlist", () => {
    const offenders: string[] = [];
    for (const pkg of PUBLISHED_PACKAGES) {
      for (const file of walk(join(REPO_ROOT, pkg, "src"))) {
        const rel = relative(REPO_ROOT, file).split("\\").join("/");
        if (ALLOWLIST.some((a) => rel.startsWith(a))) continue;
        if (codeLines(readFileSync(file, "utf-8")).some(writesToStdout)) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
