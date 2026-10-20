// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * sprintf-js reachability guard (GHSA-hp3w-g68c-fv3c)
 *
 * sprintf-js は lockfile 上で依存の推移閉包にのみ現れる。本 test が静的に固定するのは、走査範囲の
 * 自前 code が下記 3 package を直接 import しないことと、走査範囲の code・設定が `ROARR_LOG` を
 * 設定しないことだけである。lockfile 上の経路、依存 package 内部からの読み込み、repo 外
 * (利用者の環境・CI runner 等) で設定される環境変数は扱わない。
 * sprintf-js appears only transitively in the lockfile. This test statically pins only that our own
 * code in the scanned scope does not import the three packages below directly, and that the scanned
 * code and configuration do not set `ROARR_LOG`. It does not cover lockfile paths, loading from inside
 * dependency packages, or environment variables set outside the repository (user or CI environments).
 *
 * | 命題 / proposition | 契約 / contract                                                                        |
 * | ------------------ | -------------------------------------------------------------------------------------- |
 * | 1                  | `apps/*\/src` と `packages/*\/src` の code に `global-agent` / `roarr` / `sprintf-js`  |
 * |                    | (subpath 含む) を 1 行に収まる文字列リテラルで指す static import・`export … from`・     |
 * |                    | `require(…)`・dynamic `import(…)`・副作用 import が 0 件。template literal、文字列の     |
 * |                    | 組み立て、`createRequire` 等の別名、複数行に分かれた呼び出しは検出対象外                |
 * |                    | / no import, `export … from`, `require(…)`, dynamic `import(…)` or side-effect import  |
 * |                    | of the three packages whose specifier is a string literal on a single line. Template   |
 * |                    | literals, built-up strings, `createRequire` aliases and calls split across lines are   |
 * |                    | not detected                                                                           |
 * | 2                  | code と設定で `ROARR_LOG` を設定しない (Markdown と本 file は対象外)                   |
 * |                    | / no `ROARR_LOG` in code or configuration (Markdown and this file excluded)            |
 *
 * 非空虚性 / Non-vacuity: (a) 命題 1 の走査 file 数が `apps/mcp-server/src` と `packages/ml/src` で
 * それぞれ ≥ 1。(b) in-memory の positive / negative control で検出式が一致 / 不一致することを示す。
 * OSS tree に無い file (apps/cli, apps/webui, scripts の多く等) は存在すれば走査するだけで、無いことは
 * RED の条件にしない。network・install・DB は使わない。
 * Files absent from the OSS tree are scanned only when present; absence is never a failure.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/mcp-server/tests/security → repo root */
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const SELF = fileURLToPath(import.meta.url);

const CODE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const SCRIPT_EXTENSIONS: readonly string[] = [".sh", ".mjs", ".js", ".ts"];
/** repo 全体の walk で降りない directory / directories skipped during walks */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".oss-sync",
  "test-results",
  "playwright-report",
  "backups",
]);
/**
 * repo root 相対で降りない directory (入れ子の worktree、gitignore 済の local 作業領域)
 * root-relative directories skipped during walks (nested worktrees, gitignored local area)
 */
const SKIP_ROOT_RELATIVE_DIRS: ReadonlySet<string> = new Set([".claude/worktrees", "oss"]);

/** 命題 1 第 1 式: from / dynamic import / require / Proposition 1, first expression */
const IMPORT_FROM_RE =
  /(from|import\(|require\()\s*['"](global-agent|roarr|sprintf-js)(\/[^'"]*)?['"]/;
/** 命題 1 第 2 式: 副作用 import / Proposition 1, second expression (side-effect import) */
const SIDE_EFFECT_IMPORT_RE = /import\s*['"](global-agent|roarr|sprintf-js)(\/[^'"]*)?['"]/;
/** 命題 2 の検索文字列 / Proposition 2 search string */
const ROARR_LOG = "ROARR_LOG";

// ---------------------------------------------------------------------------
// 純関数 / pure helpers
// ---------------------------------------------------------------------------

/** git grep と同じく行単位で照合する / line-based, like git grep */
function matchesImport(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => IMPORT_FROM_RE.test(line) || SIDE_EFFECT_IMPORT_RE.test(line));
}

function matchesRoarrLog(text: string): boolean {
  return text.includes(ROARR_LOG);
}

function hasExt(file: string, exts: readonly string[]): boolean {
  return exts.some((ext) => file.endsWith(ext));
}

/** symlink を辿らない再帰 walk / recursive walk without following symlinks */
function walk(dir: string, accept: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !SKIP_ROOT_RELATIVE_DIRS.has(rel(full))) {
        out.push(...walk(full, accept));
      }
    } else if (entry.isFile() && accept(full)) {
      out.push(full);
    }
  }
  return out;
}

/** `<root>/<group>/*\/src` の一覧 / list `<group>/*\/src` dirs */
function srcDirs(group: "apps" | "packages"): string[] {
  const base = join(REPO_ROOT, group);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(base, e.name, "src"))
    .filter((d) => existsSync(d) && statSync(d).isDirectory());
}

function codeFilesUnder(dir: string): string[] {
  return walk(dir, (f) => hasExt(f, CODE_EXTENSIONS));
}

function rel(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join("/");
}

/** 各 workspace 直下の package.json / per-workspace package.json files */
function workspacePackageJsons(): string[] {
  return ["apps", "packages"].flatMap((group) => {
    const base = join(REPO_ROOT, group);
    if (!existsSync(base)) return [];
    return readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(base, e.name, "package.json"));
  });
}

/** `.github/workflows` の YAML / workflow YAML files */
function workflowFiles(): string[] {
  const workflows = join(REPO_ROOT, ".github", "workflows");
  if (!existsSync(workflows)) return [];
  return readdirSync(workflows)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => join(workflows, name));
}

/** repo 全体の `Dockerfile*` と `*.env.example` / root-wide Dockerfile* and *.env.example */
function rootNamedFiles(): string[] {
  return walk(REPO_ROOT, (x) => {
    const name = basename(x);
    return name.startsWith("Dockerfile") || name.endsWith(".env.example");
  });
}

/** 命題 2 の走査対象 / Proposition 2 scan set */
function roarrLogScanSet(): string[] {
  const candidates = [
    ...[...srcDirs("apps"), ...srcDirs("packages")].flatMap(codeFilesUnder),
    join(REPO_ROOT, "package.json"),
    ...workspacePackageJsons(),
    ...workflowFiles(),
    ...walk(join(REPO_ROOT, "docker"), () => true),
    ...walk(join(REPO_ROOT, "scripts"), (x) => hasExt(x, SCRIPT_EXTENSIONS)),
    ...rootNamedFiles(),
    // OSS に同期されない。在れば走査、無くても RED にしない / scanned only when present
    join(REPO_ROOT, ".claude", "settings.json"),
  ];
  const files = new Set(candidates.filter((f) => existsSync(f) && statSync(f).isFile()));
  return [...files].filter((f) => !f.endsWith(".md") && f !== SELF);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("sprintf-js reachability guard (GHSA-hp3w-g68c-fv3c)", () => {
  describe("検出式の非空虚性 / detector non-vacuity (in-memory controls)", () => {
    it.each([
      `import x from "roarr"`,
      `require('global-agent')`,
      `await import("sprintf-js/dist/sprintf.min.js")`,
      `export * from 'roarr'`,
      `import "global-agent/bootstrap"`,
    ])("命題 1 の検出式が一致する / proposition 1 matches: %s", (line) => {
      expect(matchesImport(line)).toEqual([line]);
    });

    it.each([`"roarr-like"`, `import x from "sprintf-js-extra"`, `import "roarr-like"`])(
      "命題 1 の検出式が一致しない / proposition 1 does not match: %s",
      (line) => {
        expect(matchesImport(line)).toEqual([]);
      }
    );

    it("命題 2 の検索が設定行に一致する / proposition 2 matches an assignment", () => {
      expect(matchesRoarrLog(`process.env.ROARR_LOG = "1"`)).toBe(true);
      expect(matchesRoarrLog(`process.env.LOG_LEVEL = "1"`)).toBe(false);
    });
  });

  it("命題 1: src が global-agent / roarr / sprintf-js を import しない / proposition 1", () => {
    const dirs = [...srcDirs("apps"), ...srcDirs("packages")];
    const scanned = dirs.flatMap(codeFilesUnder);

    // 非空虚 guard: 両 tree に存在する公開 package の src を必ず走査する
    // non-vacuity: the published packages' src must be scanned (present in both trees)
    for (const required of ["apps/mcp-server/src/", "packages/ml/src/"]) {
      expect(scanned.filter((f) => rel(f).startsWith(required)).length).toBeGreaterThanOrEqual(1);
    }

    const hits = scanned.flatMap((f) =>
      matchesImport(readFileSync(f, "utf8")).map((line) => `${rel(f)}: ${line.trim()}`)
    );
    expect(hits).toEqual([]);
  });

  it("命題 2: code と設定が ROARR_LOG を設定しない / proposition 2", () => {
    const scanned = roarrLogScanSet();
    expect(scanned).toContain(join(REPO_ROOT, "package.json"));
    expect(scanned.some((f) => rel(f).startsWith("apps/mcp-server/src/"))).toBe(true);

    const hits = scanned.filter((f) => matchesRoarrLog(readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual([]);
  });
});
