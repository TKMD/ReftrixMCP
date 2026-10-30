// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared helpers for INV-SEC-NODE-RUNTIME-FLOOR-001 (public body + private sibling).
 * INV-SEC-NODE-RUNTIME-FLOOR-001 の公開本体と private 兄弟で共有する helper。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Node, Project, SyntaxKind } from "ts-morph";
import { expect } from "vitest";

export const ROOT = path.resolve(__dirname, "../../../../../..");
export const GUARD_SPEC = "@reftrixmcp/core/assert-node-runtime";

export const project = new Project({
  skipAddingFilesFromTsConfig: true,
  skipFileDependencyResolution: true,
  skipLoadingLibFiles: true,
  compilerOptions: { allowJs: true },
});

export const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf-8")) as Record<string, unknown>;

const SKIP_NAMES = new Set(["node_modules", ".git", "dist", ".next", ".turbo", "coverage"]);
/** git 管理外の生成物だけを root からの相対パスで飛ばす (`.claude` の git 管理部分は歩く) / git-unmanaged only */
const SKIP_RELATIVE = new Set([".claude/worktrees", ".oss-sync", "oss", "backups"]);

export function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (!e.isDirectory()) {
      if (accept(p)) out.push(p);
    } else if (!SKIP_NAMES.has(e.name) && !SKIP_RELATIVE.has(path.relative(ROOT, p))) {
      walk(p, accept, out);
    }
  }
  return out;
}

/** package.json の bin / main / start* / worker:* から entrypoint の src を規則で導出 */
export function deriveEntrypoints(pkgDir: string): string[] {
  const pkg = readJson(`${pkgDir}/package.json`) as {
    bin?: Record<string, string>;
    main?: string;
    scripts?: Record<string, string>;
  };
  const toSrc = (p: string): string => {
    const rel = p.replace(/^\.\//, "");
    return rel.startsWith("dist/") ? rel.replace(/^dist\//, "src/").replace(/\.js$/, ".ts") : rel;
  };
  const out = new Set<string>();
  for (const p of [...Object.values(pkg.bin ?? {}), ...(pkg.main ? [pkg.main] : [])])
    out.add(`${pkgDir}/${toSrc(p)}`);
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    if (!/^(start|worker)/.test(name)) continue;
    const stripped = cmd.replace(/^(\s*[A-Z_][A-Z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)*/, "");
    const m = /^(?:node|tsx(?: watch)?)\s+(\S+)/.exec(stripped);
    expect(m, `cannot derive an entrypoint from scripts.${name}: ${cmd}`).not.toBeNull();
    out.add(`${pkgDir}/${toSrc(m?.[1] ?? "")}`);
  }
  return [...out].sort();
}

/** 最初の文が副作用のみの guard import であること */
export function firstStatementIsGuard(file: string): boolean {
  const first = project.addSourceFileAtPath(path.join(ROOT, file)).getStatements()[0];
  return (
    first !== undefined &&
    Node.isImportDeclaration(first) &&
    first.getModuleSpecifierValue() === GUARD_SPEC &&
    first.getImportClause() === undefined
  );
}

const SPOOF_CJS = path.resolve(__dirname, "../worker-lifecycle/spoof-node-runtime.cjs");
export const SPOOF_ESM = path.resolve(__dirname, "spoof-node-runtime.mjs");

/**
 * built entry の最初に評価される module が guard であること (SEC-PRF1B-R-02)。
 * CJS は最初の `require(` 呼び出し (`module.require` も数える)、ESM は最初の import 宣言 / `export … from` を、
 * ソース順で比べる。bare = top-level の式文 `require(…)` / 副作用のみの import 宣言。
 * The first evaluated module (`require(` call incl. `module.require`, import declaration, `export … from`) is the guard, and bare.
 */
export function distFirstModuleIsGuard(rel: string, code?: string): boolean {
  const sf =
    code === undefined
      ? project.addSourceFileAtPath(path.join(ROOT, rel))
      : project.createSourceFile(rel, code, { overwrite: true });
  const loads: Array<{ pos: number; spec: string | undefined; bare: boolean }> = [
    ...sf.getImportDeclarations().map((d) => ({
      pos: d.getStart(),
      spec: d.getModuleSpecifierValue(),
      bare: d.getImportClause() === undefined,
    })),
    ...sf
      .getExportDeclarations()
      .filter((d) => d.hasModuleSpecifier())
      .map((d) => ({ pos: d.getStart(), spec: d.getModuleSpecifierValue(), bare: false })),
    ...sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((c) => /(^|\.)require$/.test(c.getExpression().getText()))
      .map((c) => {
        const arg = c.getArguments()[0];
        const stmt = c.getParent();
        return {
          pos: c.getStart(),
          spec:
            c.getExpression().getText() === "require" &&
            arg !== undefined &&
            Node.isStringLiteral(arg)
              ? arg.getLiteralText()
              : undefined,
          bare: Node.isExpressionStatement(stmt) && Node.isSourceFile(stmt.getParent()),
        };
      }),
  ].sort((a, b) => a.pos - b.pos);
  const first = loads[0];
  return first !== undefined && first.spec === GUARD_SPEC && first.bare;
}

/**
 * 偽装 harness の子プロセス: env は PATH / HOME のみ、stdin 閉じ、timeout 付き、cwd は空の `.env.local` を置いた
 * 0700 の使い捨て dir (S-8, TDA-PRF1B-R2-03, SEC-PRF1C-I-02)。guard が壊れた回帰でも `loadEnvLocal()` は何も読まない。
 * mode: `require` = CJS `node -r`、`import` = ESM `node --import`。
 */
export function runSpoofed(
  entry: string,
  spoofArgs: string[],
  mode: "require" | "import" = "require"
): { status: number | null; stdout: string; stderr: string } {
  const preload = mode === "import" ? ["--import", SPOOF_ESM] : ["-r", SPOOF_CJS];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reftrix-spoof-"));
  try {
    fs.writeFileSync(path.join(cwd, ".env.local"), "");
    const r = spawnSync(process.execPath, [...preload, entry, ...spoofArgs], {
      encoding: "utf-8",
      cwd,
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
      input: "",
      timeout: 20_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
