// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SEC-NODE-RUNTIME-FLOOR-001 (H)
 *
 * Node.js の実行時下限 (`^22.23.4 || ^24.22.1 || ^26.12.1`、組み込み undici / Brotli の脆弱性対策) を
 * fail-closed な起動 guard で強制する契約の機械 gate。SSOT = `@reftrixmcp/core/node-runtime-floor`、
 * guard = `@reftrixmcp/core/assert-node-runtime` (副作用 import)。
 * Machine gate for the fail-closed Node.js runtime floor: the SSOT table, the side-effect guard,
 * and every process entrypoint that must evaluate the guard first.
 *
 * | leg   | 契約 / contract                                                                        |
 * | ----- | -------------------------------------------------------------------------------------- |
 * | (i)   | 表駆動の境界 + guard は `node:` のみ import / `process.env` 不参照 (src + dist の AST)  |
 * | (ii)  | root engines・ci.yml / publish.yml の Node pin・Dockerfile 0 件・exports 2 subpath      |
 * | (iii) | entrypoint (bin/main/start/worker) は最初の文が guard、肯定側 smoke exit 0   |
 * | (iv)  | spawn 系は process.execPath か 6 コマンド固定。namespace / require / 動的 import も走査  |
 * | (v)   | guard の入力 allowlist / export 固定 / 握りつぶし無し / 偽装 harness の起動テスト   |
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { createRequire } from "node:module";
import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";
import type { CallExpression, SourceFile, VariableDeclaration, ts } from "ts-morph";
import { describe, it, expect, beforeEach } from "vitest";
import {
  NODE_ENGINES_RANGE,
  NODE_RUNTIME_FLOOR_TABLE,
  evaluateBrotliFixMarker,
  evaluateNodeRuntime,
  evaluateNodeVersion,
  evaluateUndiciVersion,
} from "@reftrixmcp/core/node-runtime-floor";
import { assertInvName } from "../_setup/inv-assert";
import {
  GUARD_SPEC,
  ROOT,
  SPOOF_ESM,
  deriveEntrypoints,
  distFirstModuleIsGuard,
  firstStatementIsGuard,
  project,
  readJson,
  runSpoofed,
  walk,
} from "../_setup/node-floor-helpers";

const INV = "INV-SEC-NODE-RUNTIME-FLOOR-001";
const FLOOR_SRC = path.join(ROOT, "packages/core/src/runtime/node-runtime-floor.ts");
const GUARD_SRC = path.join(ROOT, "packages/core/src/runtime/assert-node-runtime.ts");
const SPOOF = path.join(__dirname, "spoof-node-runtime.cjs");
const FLOOR_DIST = path.join(ROOT, "packages/core/dist/runtime/node-runtime-floor.js");
const GUARD_DIST = path.join(ROOT, "packages/core/dist/runtime/assert-node-runtime.js");

// ---------------------------------------------------------------------------
// leg (i) helpers
// ---------------------------------------------------------------------------

const input = (node: unknown, undici: unknown, over: Record<string, unknown> = {}) => ({
  node,
  undici,
  brotliBlockSwitchMarker: 1,
  releaseName: "node",
  ...over,
});

const ALLOW: Array<[string, ReturnType<typeof input>]> = [
  ["22 floor exact", input("22.23.4", "6.29.1")],
  ["22 numeric patch compare (10 > 4)", input("22.23.10", "6.29.1")],
  ["22 next minor", input("22.24.0", "6.29.1")],
  ["22 + undici 7.0.0 (floor is semver >=, not major-pinned)", input("22.23.4", "7.0.0")],
  ["24 floor exact", input("24.22.1", "7.30.1")],
  ["24 next minor", input("24.23.0", "7.30.1")],
  ["26 floor exact", input("26.12.1", "8.12.2")],
  ["26 next minor", input("26.13.0", "8.12.2")],
  ["26 newer undici", input("26.12.1", "8.13.0")],
];

const DENY: Array<[string, ReturnType<typeof input>]> = [
  ["20.19.0", input("20.19.0", "6.29.1")],
  ["20.18.3", input("20.18.3", "6.29.1")],
  ["22.23.3 (below floor)", input("22.23.3", "6.29.1")],
  ["22.16.0", input("22.16.0", "6.21.2")],
  ["22.23.4 + undici 6.29.0", input("22.23.4", "6.29.0")],
  ["22.23.4 + undici 6.9.0 (numeric, not lexical)", input("22.23.4", "6.9.0")],
  ["23.0.0", input("23.0.0", "6.29.1")],
  ["24.22.0", input("24.22.0", "7.30.1")],
  ["24.22.1 + undici 7.30.0", input("24.22.1", "7.30.0")],
  ["25.0.0", input("25.0.0", "7.30.1")],
  ["26.12.0", input("26.12.0", "8.12.2")],
  ["26.12.1 + undici 8.12.1", input("26.12.1", "8.12.1")],
  ["27.0.0 (series not in table)", input("27.0.0", "9.0.0")],
  ["prerelease", input("22.23.4-rc.1", "6.29.1")],
  ["build metadata", input("22.23.4+build", "6.29.1")],
  ["leading v", input("v22.23.4", "6.29.1")],
  ["leading zero (major)", input("022.23.4", "6.29.1")],
  ["leading zero (minor)", input("22.023.4", "6.29.1")],
  ["unsafe integer", input("22.23.99999999999999999999", "6.29.1")],
  ["empty", input("", "6.29.1")],
  ["garbage", input("abc", "6.29.1")],
  ["two components", input("22.23", "6.29.1")],
  ["undefined node", input(undefined, "6.29.1")],
  ["non-string node", input(22, "6.29.1")],
  ["undici undefined", input("22.23.4", undefined)],
  ["undici prerelease", input("22.23.4", "6.29.1-rc.1")],
  ["undici two components", input("22.23.4", "6.29")],
  ["undici leading zero", input("22.23.4", "06.29.1")],
  [
    "Brotli fix marker undefined",
    input("22.23.4", "6.29.1", { brotliBlockSwitchMarker: undefined }),
  ],
  ["Brotli fix marker non-number", input("22.23.4", "6.29.1", { brotliBlockSwitchMarker: "x" })],
  ["release name iojs", input("22.23.4", "6.29.1", { releaseName: "iojs" })],
  ["release name undefined", input("22.23.4", "6.29.1", { releaseName: undefined })],
];

const FIX_MARKER = "BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH";
/** guard が読んでよい member (deny-by-default)。src は `process.x`、dist は `node_process_1.default.x` を正規化 */
const MEMBER_ALLOW = new Set([
  "process.versions.node",
  "process.versions.undici",
  "process.release.name",
  "process.exit",
  "fs.writeSync",
  `zlib.constants.${FIX_MARKER}`,
]);
const BINDINGS: Record<string, string> = {
  process: "process",
  zlib: "zlib",
  fs: "fs",
  node_process_1: "process",
  node_zlib_1: "zlib",
  node_fs_1: "fs",
};
const FORBIDDEN_IDENTIFIERS = new Set([
  "globalThis",
  "global",
  "Reflect",
  "console",
  "eval",
  "Function",
  "constructor",
  "__proto__",
  "prototype",
]);
/** CJS の wrapper 経由の取得 (`module.require` / `require.main.require` / `arguments[n]`) を塞ぐ (SEC-PRF1B-I-03) */
const CJS_WRAPPER_IDENTIFIERS = new Set(["require", "module", "arguments", "exports"]);
/** tsc の定型だけ許す: `require("<literal>")` の直接呼び出し / `exports.x` / `Object.defineProperty(exports, "__esModule", …)` */
function isTscBoilerplate(id: Node): boolean {
  const p = id.getParent();
  const name = id.getText();
  if (Node.isPropertyAccessExpression(p) && p.getNameNode() === id) return true;
  if (name === "require")
    return (
      Node.isCallExpression(p) &&
      p.getExpression() === id &&
      Node.isStringLiteral(p.getArguments()[0] as Node)
    );
  if (name !== "exports") return false;
  return (
    (Node.isPropertyAccessExpression(p) && p.getExpression() === id) ||
    (Node.isCallExpression(p) &&
      p.getExpression().getText() === "Object.defineProperty" &&
      p.getArguments()[0] === id &&
      p.getArguments()[1]?.getText() === '"__esModule"')
  );
}
const GUARD_IMPORTS = new Set(["node:process", "node:zlib", "node:fs"]);

/** binding から続く最大の property chain を正規化した文字列 */
function chainText(id: Node): string {
  let n: Node = id;
  for (
    let p = n.getParent();
    Node.isPropertyAccessExpression(p) && p.getExpression() === n;
    p = n.getParent()
  )
    n = p;
  return n
    .getText()
    .replace(/^(\w+)\.default\b/, "$1")
    .replace(/^\w+/, (b) => BINDINGS[b] ?? b);
}

/**
 * deny-by-default: process / zlib / fs の binding は import 宣言の名前か、allowlist の chain の先頭としてだけ現れる。
 * 別名・分割代入・計算 property・eval / Function・allowlist 外の member はすべて違反。
 */
function guardViolations(sf: SourceFile, allowedRelative: string[]): string[] {
  const specs: string[] = sf.getImportDeclarations().map((d) => d.getModuleSpecifierValue());
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();
    const arg = call.getArguments()[0];
    if ((callee === "require" || callee === "import") && arg !== undefined)
      specs.push(arg.getText().replace(/^["'`]|["'`]$/g, ""));
  }
  const bad: string[] = specs
    .filter((s) => !(GUARD_IMPORTS.has(s) || allowedRelative.includes(s)))
    .map((s) => `import:${s}`);
  for (const imp of sf.getImportDeclarations()) {
    const named = imp.getNamedImports().length > 0 || imp.getNamespaceImport() !== undefined;
    if (named && imp.getModuleSpecifierValue().startsWith("node:"))
      bad.push(`non-default-import:${imp.getModuleSpecifierValue()}`);
  }
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const name = id.getText();
    if (FORBIDDEN_IDENTIFIERS.has(name)) bad.push(`identifier:${name}`);
    if (CJS_WRAPPER_IDENTIFIERS.has(name) && !isTscBoilerplate(id)) bad.push(`identifier:${name}`);
    if (!Object.hasOwn(BINDINGS, name)) continue;
    const parent = id.getParent();
    if (
      Node.isImportClause(parent) ||
      (Node.isVariableDeclaration(parent) && parent.getNameNode() === id)
    )
      continue;
    const text = chainText(id);
    if (!MEMBER_ALLOW.has(text)) bad.push(`member:${text}`);
  }
  if (sf.getDescendantsOfKind(SyntaxKind.TryStatement).length > 0) bad.push("try-statement");
  if (/Symbol\.for|execArgv|execPath/.test(sf.getText().replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")))
    bad.push("forbidden-token");
  return bad;
}

/** brotliBlockSwitchMarker に渡す式は zlib の印の直接参照で、既定値で埋めない (S-6b) */
function markerIsDirectReference(sf: SourceFile): boolean {
  const prop = sf
    .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
    .find((p) => p.getName() === "brotliBlockSwitchMarker");
  const init = prop?.getInitializer();
  return (
    init !== undefined &&
    !Node.isBinaryExpression(init) &&
    !Node.isConditionalExpression(init) &&
    chainText(init) === `zlib.constants.${FIX_MARKER}`
  );
}

// ---------------------------------------------------------------------------

describe(`${INV}: Node.js runtime floor`, () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
  });

  // ===== leg (i) =====
  describe("leg (i) boundary table", () => {
    it.each(ALLOW)(`${INV}: allows %s`, (_label, i) => {
      expect(evaluateNodeRuntime(i)).toEqual({ ok: true });
    });

    it.each(DENY)(`${INV}: rejects %s`, (_label, i) => {
      expect(evaluateNodeRuntime(i).ok).toBe(false);
    });

    it(`${INV}: split API agrees with the composition`, () => {
      expect(evaluateNodeVersion("22.23.4")).toEqual({ ok: true });
      expect(evaluateNodeVersion("20.19.0").ok).toBe(false);
      expect(evaluateUndiciVersion(22, "6.29.1")).toEqual({ ok: true });
      expect(evaluateUndiciVersion(22, "6.29.0").ok).toBe(false);
      expect(evaluateUndiciVersion(21, "6.29.1").ok).toBe(false);
      expect(evaluateBrotliFixMarker(0)).toEqual({ ok: true });
      expect(evaluateBrotliFixMarker(undefined).ok).toBe(false);
    });

    it(`${INV}: the engines range is derived from the table`, () => {
      expect(NODE_ENGINES_RANGE).toBe("^22.23.4 || ^24.22.1 || ^26.12.1");
      expect(NODE_ENGINES_RANGE).toBe(
        Object.values(NODE_RUNTIME_FLOOR_TABLE)
          .map((r) => `^${r.node}`)
          .join(" || ")
      );
    });

    it(`${INV}: guard imports only node: builtins (plus the SSOT sibling) and never reads process.env, src and dist`, () => {
      const files: Array<[string, string[]]> = [
        [FLOOR_SRC, []],
        [GUARD_SRC, ["./node-runtime-floor.js"]],
        [FLOOR_DIST, []],
        [GUARD_DIST, ["./node-runtime-floor.js"]],
      ];
      for (const [file, allowed] of files) {
        expect(fs.existsSync(file), `missing (run pnpm build): ${file}`).toBe(true);
        const sf = project.addSourceFileAtPath(file);
        expect({
          file: path.relative(ROOT, file),
          violations: guardViolations(sf, allowed),
        }).toEqual({
          file: path.relative(ROOT, file),
          violations: [],
        });
      }
    });

    it(`${INV}: marker passed to the evaluator is a direct zlib reference, src and dist (S-6)`, () => {
      for (const f of [GUARD_SRC, GUARD_DIST])
        expect(markerIsDirectReference(project.addSourceFileAtPath(f)), f).toBe(true);
      const bad = project.createSourceFile(
        "__control_marker.ts",
        `f({ brotliBlockSwitchMarker: zlib.constants.${FIX_MARKER} ?? 1 });`,
        { overwrite: true }
      );
      expect(markerIsDirectReference(bad)).toBe(false);
    });

    const MUTANTS = [
      "const { env } = process;",
      "const p = process; p.argv;",
      "const q = process; q.config;",
      "const { features } = process;",
      "const z = zlib; z.gunzipSync;",
      "new Function('return proc' + 'ess')();",
      "eval('proc' + 'ess.e' + 'nv');",
      "const o = process; o.stdout.write('x');",
      "process.env.X;",
      "process['env'];",
      "import x from 'lodash';",
      "try { process.exit(1); } catch {}",
      'module.require("node:os");',
      'require.main.require("node:os");',
      'arguments[1]("node:os");',
      "const r = require; r(`node:${'os'}`);",
      "const e = exports;",
      'exports.constructor.constructor("return 1")();',
      "(() => 0).constructor;",
    ];

    it.each(MUTANTS)(`${INV}: control — the deny-by-default checker flags mutant %s`, (line) => {
      const base = fs.readFileSync(GUARD_SRC, "utf-8");
      expect(
        guardViolations(project.createSourceFile("__m.ts", base, { overwrite: true }), [
          "./node-runtime-floor.js",
        ])
      ).toEqual([]);
      const sf = project.createSourceFile("__m.ts", `${base}\n${line}`, { overwrite: true });
      expect(guardViolations(sf, ["./node-runtime-floor.js"]).length).toBeGreaterThan(0);
    });
  });

  // ===== leg (ii) =====
  describe("leg (ii) SSOT consistency (public files)", () => {
    it(`${INV}: root engines.node equals the SSOT range`, () => {
      expect((readJson("package.json").engines as Record<string, string>).node).toBe(
        NODE_ENGINES_RANGE
      );
    });

    it(`${INV}: @reftrixmcp/core exports both subpaths directly from dist/runtime (not via the index)`, () => {
      const exp = readJson("packages/core/package.json").exports as Record<
        string,
        Record<string, string>
      >;
      for (const sub of ["node-runtime-floor", "assert-node-runtime"]) {
        expect(exp[`./${sub}`]).toEqual({
          types: `./dist/runtime/${sub}.d.ts`,
          default: `./dist/runtime/${sub}.js`,
        });
      }
    });

    it(`${INV}: @reftrixmcp/core sideEffects never lets a bundler drop the guard import`, () => {
      const se = readJson("packages/core/package.json")["sideEffects"];
      expect(
        se === false ||
          (Array.isArray(se) && !se.some((p) => /assert-node-runtime/.test(String(p))))
      ).toBe(false);
    });

    it(`${INV}: workflow Node pins evaluate to allowed full versions (job env -> workflow env)`, () => {
      type Doc = {
        env?: Record<string, unknown>;
        jobs?: Record<
          string,
          { env?: Record<string, unknown>; steps?: Array<Record<string, unknown>> }
        >;
      };
      for (const wf of ["ci.yml", "publish.yml"]) {
        const doc = yaml.load(
          fs.readFileSync(path.join(ROOT, ".github/workflows", wf), "utf-8")
        ) as Doc;
        const resolved: string[] = [];
        for (const job of Object.values(doc.jobs ?? {})) {
          for (const step of job.steps ?? []) {
            if (!String(step["uses"] ?? "").startsWith("actions/setup-node")) continue;
            const w = (step["with"] ?? {}) as Record<string, unknown>;
            expect(
              w["node-version-file"],
              `${wf}: node-version-file is not allowed`
            ).toBeUndefined();
            const raw = String(w["node-version"]);
            const m = /^\$\{\{\s*env\.([A-Z_]+)\s*\}\}$/.exec(raw);
            const value =
              m === null ? raw : String(job.env?.[m[1] as string] ?? doc.env?.[m[1] as string]);
            expect(
              /^\d+\.\d+\.\d+$/.test(value),
              `${wf}: unresolvable or non-exact pin ${raw}`
            ).toBe(true);
            expect(evaluateNodeVersion(value), `${wf}: ${raw} -> ${value}`).toEqual({ ok: true });
            resolved.push(value);
          }
        }
        expect(resolved.length, `${wf}: at least one setup-node step`).toBeGreaterThan(0);
      }
    });

    it(`${INV}: fs-glob Dockerfiles (excluding git-unmanaged dirs) / compose node images are fixed at 0`, () => {
      const dockerfiles = walk(ROOT, (f) => /(^|\/)Dockerfile[^/]*$/.test(f));
      const composeNode = walk(path.join(ROOT, "docker"), (f) => /\.ya?ml$/.test(f)).filter((f) =>
        /image:\s*["']?node[:@]/.test(fs.readFileSync(f, "utf-8"))
      );
      expect(dockerfiles.map((f) => path.relative(ROOT, f))).toEqual([]);
      expect(composeNode).toEqual([]);
    });
  });

  // ===== leg (iii) =====
  describe("leg (iii) entrypoints evaluate the guard first", () => {
    const ENTRYPOINTS = [
      "apps/mcp-server/src/index.ts",
      "apps/mcp-server/src/scripts/start-workers.ts",
    ];

    it(`${INV}: derived mcp-server entrypoints are exactly the two process entrypoints`, () => {
      expect(deriveEntrypoints("apps/mcp-server")).toEqual(ENTRYPOINTS);
    });

    it(`${INV}: each entrypoint's first statement is the guard side-effect import`, () => {
      for (const f of ENTRYPOINTS) expect(firstStatementIsGuard(f), f).toBe(true);
    });

    it(`${INV}: scripts are deny-by-default — every script starts with the guard, allowlist is empty`, () => {
      const ALLOWLIST: string[] = [];
      expect(ALLOWLIST.length).toBe(0);
      const scripts = walk(path.join(ROOT, "apps"), (f) =>
        /\/apps\/[^/]+\/(src\/)?scripts\/.*\.ts$/.test(f)
      ).map((f) => path.relative(ROOT, f));
      expect(scripts.length, "scripts glob must not be vacuous").toBeGreaterThan(0);
      expect(scripts.filter((f) => !ALLOWLIST.includes(f) && !firstStatementIsGuard(f))).toEqual(
        []
      );
    });

    it(`${INV}: no scanned source hardcodes an nvm node version path`, () => {
      const files = walk(path.join(ROOT, "apps"), (f) =>
        /\/apps\/[^/]+\/(src|scripts)\/.*\.ts$/.test(f)
      );
      expect(
        files.filter((f) => /\.nvm\/versions\/node\/v\d/.test(fs.readFileSync(f, "utf-8")))
      ).toEqual([]);
    });

    it.each(["apps/mcp-server/dist/index.js", "apps/mcp-server/dist/scripts/start-workers.js"])(
      `${INV}: built entry %s evaluates the guard before any other module (SEC-PRF1B-R-02)`,
      (rel) => {
        expect(fs.existsSync(path.join(ROOT, rel)), `missing (run pnpm build): ${rel}`).toBe(true);
        expect(distFirstModuleIsGuard(rel), rel).toBe(true);
      }
    );

    it(`${INV}: control — the first-module check rejects a reordered CJS / ESM entry and accepts the guard first`, () => {
      const g = `"${GUARD_SPEC}"`;
      const check = (code: string): boolean => distFirstModuleIsGuard("__control_first.js", code);
      expect(check(`"use strict";\nrequire(${g});\nconst a = require("./a");`)).toBe(true);
      expect(check(`"use strict";\nconst a = require("./a");\nrequire(${g});`)).toBe(false);
      expect(check(`import ${g};\nimport { a } from "./a.js";`)).toBe(true);
      expect(check(`import { a } from "./a.js";\nimport ${g};`)).toBe(false);
      expect(check(`import { a } from ${g};`)).toBe(false);
      expect(check(`const x = 1;`)).toBe(false);
      expect(check(`export * from "./a.js";\nimport ${g};`)).toBe(false);
      expect(
        check(`"use strict";\nfunction f() { require(${g}); }\nconst a = require("./a");`)
      ).toBe(false);
      expect(check(`"use strict";\nmodule.require("./a");\nrequire(${g});`)).toBe(false);
    });

    it(`${INV}: positive smoke — the guard module loads under the current Node (CJS require and ESM import) with exit 0`, () => {
      const cjs = spawnSync(process.execPath, ["-e", `require("${GUARD_SPEC}")`], {
        cwd: path.join(ROOT, "apps/mcp-server"),
        encoding: "utf-8",
      });
      const esm = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `import "${GUARD_SPEC}"`],
        { cwd: path.join(ROOT, "apps/mcp-server"), encoding: "utf-8" }
      );
      expect({ status: cjs.status, stdout: cjs.stdout, stderr: cjs.stderr }).toEqual({
        status: 0,
        stdout: "",
        stderr: "",
      });
      expect({ status: esm.status, stdout: esm.stdout, stderr: esm.stderr }).toEqual({
        status: 0,
        stdout: "",
        stderr: "",
      });
    });
  });

  // ===== leg (iv) no node-binary spawns =====
  describe("leg (iv) spawn family never names a node-like binary", () => {
    const SPAWNERS = new Set([
      "fork",
      "spawn",
      "spawnSync",
      "execFile",
      "execFileSync",
      "exec",
      "execSync",
    ]);
    const COMMANDS = new Set(["pg_dump", "psql", "ffmpeg", "ffprobe", "nvidia-smi", "pkill"]);
    /** 静的に決まらない第 1 引数 / 辿れない options の allowlist (file → 理由) / dynamic-site allowlist with reason */
    const DYNAMIC_ALLOW: Record<string, string> = {};
    /** `label:line what` を行番号 → 文字列で並べる (違反リストの順序を一意にする) */
    const byLine = (a: string, b: string): number => {
      const n = (x: string): number => Number(/:(\d+) /.exec(x)?.[1]);
      return n(a) - n(b) || (a < b ? -1 : a > b ? 1 : 0);
    };
    const isChildProcess = (t: string): boolean => /["'`](node:)?child_process["'`]/.test(t);

    /** Identifier を symbol で束縛先に解決する (名前検索ではなくスコープを見る) / resolve by symbol, not by name */
    const sym = (n: Node): ts.Symbol | undefined => n.getSymbol()?.compilerSymbol;
    const unwrap = (n: Node): Node =>
      Node.isParenthesizedExpression(n) ||
      Node.isAwaitExpression(n) ||
      Node.isAsExpression(n) ||
      Node.isNonNullExpression(n) ||
      Node.isSatisfiesExpression(n) ||
      Node.isTypeAssertion(n)
        ? unwrap(n.getExpression())
        : n;
    const singleDecl = (n: Node): VariableDeclaration | undefined => {
      const decls = Node.isIdentifier(n) ? (n.getSymbol()?.getDeclarations() ?? []) : [];
      const d = decls[0];
      return decls.length === 1 && Node.isVariableDeclaration(d) ? d : undefined;
    };
    const constInit = (n: Node): Node | undefined => {
      const d = singleDecl(n);
      return d?.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const
        ? d.getInitializer()
        : undefined;
    };
    /** `promisify(execFile)` / `util.promisify(spawn)` は spawner の別名として追う */
    const isPromisify = (n: Node): n is CallExpression =>
      Node.isCallExpression(n) && /(^|\.)promisify$/.test(n.getExpression().getText());
    /** promisify 呼び出しが `const x = promisify(spawner)` の初期化子 (名前は Identifier) であること。それ以外は追跡されない */
    const isTrackedPromisify = (call: Node): boolean => {
      let n: Node = call;
      while (Node.isParenthesizedExpression(n.getParent()) || Node.isAwaitExpression(n.getParent()))
        n = n.getParent() as Node;
      const vd = n.getParent();
      return (
        Node.isVariableDeclaration(vd) &&
        vd.getInitializer() === n &&
        Node.isIdentifier(vd.getNameNode())
      );
    };
    /** export / shorthand 越しの参照も local symbol に解決する (`export { p }` / `{ p }`) */
    const refSym = (id: Node): ts.Symbol | undefined => {
      const p = id.getParent();
      if (Node.isShorthandPropertyAssignment(p)) return p.getValueSymbol()?.compilerSymbol;
      if (Node.isExportSpecifier(p))
        return p.getNameNode() === id ? p.getLocalTargetSymbol()?.compilerSymbol : undefined;
      return sym(id);
    };
    const NODEISH = /^(node|nodejs|tsx|npx|npm|pnpm|yarn|corepack|bun|deno)$/;

    function spawnViolations(sf: SourceFile, label: string): string[] {
      const hits: Array<{ line: number; what: string }> = [];
      const direct = new Map<ts.Symbol, string>();
      const modules = new Set<ts.Symbol>();
      const flag = (line: number, what: string): void => {
        if (DYNAMIC_ALLOW[label] === undefined || !what.startsWith("dynamic"))
          hits.push({ line, what });
      };
      // a script-scope file (any extension) shares globals with every other script, so symbols are not file-local
      const ci = sf.compilerNode as unknown as {
        externalModuleIndicator?: unknown;
        commonJsModuleIndicator?: unknown;
      };
      if (ci.externalModuleIndicator === undefined && ci.commonJsModuleIndicator === undefined)
        flag(1, "dynamic (script scope)");
      const isModule = (raw: Node): boolean => {
        const n = unwrap(raw);
        if (Node.isIdentifier(n)) return modules.has(sym(n) as ts.Symbol);
        return (
          Node.isCallExpression(n) &&
          /^(require|import|process\.getBuiltinModule)$/.test(n.getExpression().getText()) &&
          isChildProcess(n.getText())
        );
      };
      const spawnerName = (n: Node): string | undefined =>
        Node.isIdentifier(n)
          ? direct.get(sym(n) as ts.Symbol)
          : Node.isPropertyAccessExpression(n) &&
              isModule(n.getExpression()) &&
              SPAWNERS.has(n.getName())
            ? n.getName()
            : undefined;
      const track = (id: Node, orig: string | undefined): boolean => {
        const s = sym(id);
        if (orig === undefined || s === undefined || direct.has(s)) return false;
        direct.set(s, orig);
        return true;
      };
      for (const imp of sf.getImportDeclarations()) {
        if (!isChildProcess(imp.getModuleSpecifier().getText())) continue;
        for (const n of imp.getNamedImports()) {
          const local = n.getAliasNode() ?? n.getNameNode();
          if (SPAWNERS.has(n.getName())) track(local, n.getName());
          else if (n.getName() === "default" && sym(local) !== undefined)
            modules.add(sym(local) as ts.Symbol); // `import { default as c }` is the module object
        }
        const whole = imp.getDefaultImport() ?? imp.getNamespaceImport();
        const s = whole === undefined ? undefined : sym(whole);
        if (s !== undefined) modules.add(s);
      }
      // module binding の別名・分割代入・spawner の別名を不動点まで追う (TDA-PRF1B-I-01 (c))
      const decls = sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
      for (let changed = true; changed; ) {
        changed = false;
        for (const vd of decls) {
          const init = vd.getInitializer();
          const nameNode = vd.getNameNode();
          if (init === undefined) continue;
          if (isModule(init)) {
            if (Node.isIdentifier(nameNode)) {
              const s = sym(nameNode);
              if (s !== undefined && !modules.has(s)) changed = !!modules.add(s);
            } else if (Node.isObjectBindingPattern(nameNode))
              for (const el of nameNode.getElements()) {
                const orig = (el.getPropertyNameNode() ?? el.getNameNode()).getText();
                changed = (SPAWNERS.has(orig) && track(el.getNameNode(), orig)) || changed;
              }
          } else if (Node.isIdentifier(nameNode)) {
            const src = unwrap(init);
            const wrapped = isPromisify(src) ? src.getArguments()[0] : src;
            changed = track(nameNode, wrapped && spawnerName(unwrap(wrapped))) || changed;
          }
        }
      }
      for (const vd of decls) {
        const nameNode = vd.getNameNode();
        const init = vd.getInitializer();
        if (init === undefined || !isModule(init) || !Node.isObjectBindingPattern(nameNode))
          continue;
        for (const el of nameNode.getElements())
          if (
            el.getDotDotDotToken() !== undefined ||
            Node.isComputedPropertyName(el.getPropertyNameNode()) ||
            !SPAWNERS.has((el.getPropertyNameNode() ?? el.getNameNode()).getText())
          )
            flag(el.getStartLineNumber(), "dynamic destructuring");
      }
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        const orig = spawnerName(callee);
        const line = call.getStartLineNumber();
        if (orig === undefined) {
          // `.call` / `.apply` と要素アクセス (`cp["spawn"]`) は辿れないので dynamic として flag (SEC-PRF1B-R-03)
          if (
            Node.isPropertyAccessExpression(callee) &&
            /^(call|apply)$/.test(callee.getName()) &&
            spawnerName(callee.getExpression()) !== undefined
          )
            flag(line, "dynamic command");
          continue;
        }
        const [first, ...rest] = call.getArguments();
        const shell = orig.startsWith("exec") && !orig.startsWith("execFile");
        const literal =
          first !== undefined &&
          (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first))
            ? first.getLiteralText()
            : shell &&
                first !== undefined &&
                Node.isTemplateExpression(first) &&
                /^\s*\S+\s/.test(first.getHead().getLiteralText())
              ? first.getHead().getLiteralText()
              : undefined;
        if (orig !== "fork") {
          if (literal !== undefined) {
            // shell 形は区切り (| || & && ; ( `) の後ろの node 系コマンドも見る (TPA-PRF1B-L-02)
            const segs = shell ? literal.split(/\|\|?|&&?|;|\(|`|\n/) : [literal];
            const cmd = (shell ? segs[0]?.trim().split(/\s+/)[0] : literal) ?? "";
            if (!COMMANDS.has(cmd)) flag(line, `command ${cmd}`);
            const tok0 = literal.trim().split(/\s+/)[0] ?? "";
            if (shell && tok0 !== cmd && !COMMANDS.has(tok0)) flag(line, `command ${tok0}`);
            for (const seg of segs.slice(1)) {
              const tok = path.basename(seg.trim().split(/\s+/)[0] ?? "");
              if (NODEISH.test(tok)) flag(line, `command ${tok}`);
            }
          } else if (first?.getText() !== "process.execPath") flag(line, "dynamic command");
        }
        // options の位置は spawner の引数数で決める (exec* は第 2、他は args 配列があれば第 3 引数)
        const asArray = (n: Node | undefined): boolean =>
          n !== undefined &&
          (Node.isArrayLiteralExpression(n) ||
            (Node.isIdentifier(n) &&
              Node.isArrayLiteralExpression(singleDecl(n)?.getInitializer() ?? n)));
        const isFn = (n: Node | undefined): boolean =>
          n !== undefined && (Node.isArrowFunction(n) || Node.isFunctionExpression(n));
        const candidate =
          !shell && (asArray(rest[0]) || (rest.length >= 2 && !isFn(rest[1]))) ? rest[1] : rest[0];
        if (candidate === undefined || isFn(candidate)) continue;
        let lit = Node.isObjectLiteralExpression(candidate) ? candidate : undefined;
        const init = constInit(candidate);
        if (init !== undefined && Node.isObjectLiteralExpression(init)) {
          lit = init;
          // 宣言以外の参照が spawner 呼び出しの引数だけでなければ、組み立て・代入・escape とみなす (SEC-PRF1B-R-01)
          const s = sym(candidate);
          const exported = singleDecl(candidate)?.getVariableStatement()?.isExported() === true;
          const escapes =
            exported ||
            sf.getDescendantsOfKind(SyntaxKind.Identifier).some((i) => {
              const p = i.getParent();
              return (
                refSym(i) === s &&
                i !== singleDecl(candidate)?.getNameNode() &&
                !(Node.isCallExpression(p) && spawnerName(p.getExpression()) !== undefined)
              );
            });
          if (escapes) flag(line, `dynamic options ${candidate.getText()} escapes`);
        }
        if (lit === undefined) flag(line, `dynamic options ${candidate.getText()}`);
        else if (lit.getProperties().some((p) => Node.isSpreadAssignment(p)))
          flag(line, "dynamic options spread");
        else if (
          lit
            .getProperties()
            .some((p) => p.getChildrenOfKind(SyntaxKind.ComputedPropertyName).length > 0)
        )
          flag(line, "dynamic options computed key");
      }
      // spawner の call 以外の参照 (引数渡し・配列など) は辿れない。promisify の免除は追跡される初期化子だけ
      const refCheck = (n: Node): void => {
        const par = n.getParent();
        if (
          (Node.isCallExpression(par) &&
            (par.getExpression() === n || (isPromisify(par) && isTrackedPromisify(par)))) ||
          (Node.isVariableDeclaration(par) && par.getInitializer() === n) ||
          (Node.isPropertyAccessExpression(par) &&
            par.getExpression() === n &&
            /^(call|apply)$/.test(par.getName()))
        )
          return;
        flag(n.getStartLineNumber(), "dynamic reference");
      };
      for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression))
        if (isModule(pa.getExpression()) && SPAWNERS.has(pa.getName())) refCheck(pa);
      for (const ea of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression))
        if (isModule(ea.getExpression())) flag(ea.getStartLineNumber(), "dynamic reference");
      const ids = sf.getDescendantsOfKind(SyntaxKind.Identifier);
      for (const id of ids) {
        const par = id.getParent();
        const s = refSym(id);
        const declName =
          Node.isImportSpecifier(par) ||
          Node.isBindingElement(par) ||
          (Node.isVariableDeclaration(par) && par.getNameNode() === id);
        if (s !== undefined && direct.has(s) && !declName && !id.getAncestors().some(Node.isJSDoc))
          refCheck(id);
        // module binding は宣言・`module.SPAWNER` / `module[...]` の receiver・別名の初期化子・型位置以外を辿れない
        if (s !== undefined && modules.has(s) && !(declName && !Node.isBindingElement(par))) {
          const ok =
            Node.isImportClause(par) ||
            Node.isNamespaceImport(par) ||
            Node.isTypeQuery(par) ||
            Node.isQualifiedName(par) ||
            (Node.isVariableDeclaration(par) && par.getInitializer() === id) ||
            (Node.isElementAccessExpression(par) && par.getExpression() === id) ||
            (Node.isPropertyAccessExpression(par) &&
              par.getExpression() === id &&
              par.getName() !== "default");
          if (!ok) flag(id.getStartLineNumber(), "dynamic module reference");
        }
        // module の取得は `require("…")` / `import("…")` / `process.getBuiltinModule("…")` の直接呼び出しだけ追える
        if (id.getText() === "require") {
          const asName = Node.isPropertyAccessExpression(par) && par.getNameNode() === id;
          const direct0 = Node.isCallExpression(par) && par.getExpression() === id;
          const recv = Node.isPropertyAccessExpression(par) && par.getExpression() === id;
          if (asName || !(direct0 || recv)) flag(id.getStartLineNumber(), "dynamic require");
        }
      }
      for (const vd of decls) {
        const nm = vd.getNameNode();
        const names = Node.isIdentifier(nm) ? [nm] : nm.getDescendantsOfKind(SyntaxKind.Identifier);
        if (
          vd.getVariableStatement()?.isExported() &&
          names.some(
            (x: Node) => direct.has(sym(x) as ts.Symbol) || modules.has(sym(x) as ts.Symbol)
          )
        )
          flag(vd.getStartLineNumber(), "dynamic reference");
      }
      for (const ed of sf.getExportDeclarations())
        if (isChildProcess(ed.getModuleSpecifier()?.getText() ?? ""))
          flag(ed.getStartLineNumber(), "dynamic re-export of child_process");
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (/(^|\.)createRequire$/.test(callee.getText()))
          flag(call.getStartLineNumber(), "dynamic require");
        if (
          !(
            callee.getKind() === SyntaxKind.ImportKeyword ||
            /^(require|process\.getBuiltinModule)$/.test(callee.getText())
          ) ||
          !isChildProcess(call.getText())
        )
          continue;
        let n: Node = call;
        while (unwrap(n.getParent()) !== n.getParent() || Node.isAwaitExpression(n.getParent()))
          n = n.getParent() as Node;
        const par = n.getParent();
        if (
          !(
            Node.isVariableDeclaration(par) &&
            par.getInitializer() === n &&
            !par.getVariableStatement()?.isExported()
          ) &&
          !(
            Node.isPropertyAccessExpression(par) &&
            par.getExpression() === n &&
            SPAWNERS.has(par.getName())
          )
        )
          flag(call.getStartLineNumber(), "dynamic import of child_process");
      }
      // `execPath` は process.execPath 以外の字句をすべて違反にする (文字列キー・代入・Object.assign・エスケープした文字列も)
      const seen = new Set<number>();
      for (const n of [
        ...ids.filter((i) => {
          const p = i.getParent();
          return !(
            Node.isPropertyAccessExpression(p) &&
            p.getNameNode() === i &&
            p.getExpression().getText() === "process"
          );
        }),
        ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
        ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
      ].filter((n) => (Node.isIdentifier(n) ? n.getText() : n.getLiteralText()) === "execPath"))
        if (!seen.has(n.getStartLineNumber())) {
          seen.add(n.getStartLineNumber());
          flag(n.getStartLineNumber(), "options.execPath");
        }
      return hits.map((h) => `${label}:${h.line} ${h.what}`).sort(byLine);
    }

    it(`${INV}: apps src/scripts and packages src never spawn a node-like binary or set options.execPath`, () => {
      const files = [
        ...walk(path.join(ROOT, "apps"), (f) =>
          /\/apps\/[^/]+\/(src|scripts)\/.*\.(ts|mjs|cjs|js)$/.test(f)
        ),
        ...walk(path.join(ROOT, "packages"), (f) => /\/packages\/[^/]+\/src\/.*\.ts$/.test(f)),
      ].filter(
        (f) =>
          !/\.d\.ts$|\.test\.ts$/.test(f) && fs.readFileSync(f, "utf-8").includes("child_process")
      );
      expect(files.length, "scan must not be vacuous").toBeGreaterThan(0);
      const violations = files.flatMap((f) =>
        spawnViolations(project.addSourceFileAtPath(f), path.relative(ROOT, f))
      );
      expect(violations).toEqual([]);
    });

    it(`${INV}: control — the exact violation list covers every spawn form and options shape`, () => {
      const CASES: Array<[string, string | string[] | null]> = [
        ['import { fork, spawn as sp, execSync } from "node:child_process";', null],
        ['import * as cp from "child_process";', null],
        ['import cp2 from "node:child_process";', null],
        ['const { execFile } = require("child_process");', null],
        ['const cpr = require("node:child_process");', null],
        ['const cpd = await import("node:child_process");', null],
        ['fork("a.js", [], { execPath: "/x/node" });', "options.execPath"],
        ['sp("tsx", ["a.ts"]);', "command tsx"],
        ['execSync("node a.js");', "command node"],
        ['cp.spawn("npx", ["x"]);', "command npx"],
        ["cp2.spawnSync(someVar);", "dynamic command"],
        ['execFile("sh", ["-c", "x"]);', "command sh"],
        ['cpr.exec("pnpm i");', "command pnpm"],
        ['require("child_process").spawn("corepack", []);', "command corepack"],
        ['fork("b.js", [], o);', "dynamic options o"],
        ['sp(process.execPath, ["ok.js"]);', null],
        ['sp("pg_dump", []);', null],
        ['fork("c.js", { execPath: "/x/node" });', "options.execPath"],
        ['fork("d.js", { ...o });', "dynamic options spread"],
        ['fork("e.js", [], getOpts());', "dynamic options getOpts()"],
        ['fork("f.js", [], cfg.opts);', "dynamic options cfg.opts"],
        ['(await import("child_process")).spawn("bun", []);', "command bun"],
        ['execSync("psql", cfg.opts);', "dynamic options cfg.opts"],
        ['execSync("psql", { execPath: "/x" });', "options.execPath"],
        ['fork("h.js", cfg.args, { execPath: "/x" });', "options.execPath"],
        // SEC-PRF1B-R-01: options must be a same-scope const resolved by symbol, never mutated or escaped
        [
          'let m2 = {}; m2 = { execPath: "/x" }; fork("b2.js", [], m2);',
          ["options.execPath", "dynamic options m2"],
        ],
        [
          'const m1 = { env: {} }; m1.execPath = "/x"; fork("a2.js", [], m1);',
          ["options.execPath", "dynamic options m1 escapes"],
        ],
        [
          'const m3 = {}; Object.assign(m3, { execPath: "/x" }); fork("c2.js", [], m3);',
          ["options.execPath", "dynamic options m3 escapes"],
        ],
        [
          'function g3() { const o3 = {}; } function h3(o3: object) { fork("x.js", [], o3); }',
          "dynamic options o3",
        ],
        [
          'function g5() { const a5 = [1]; } function h5(a5: object) { fork("x2.js", a5); }',
          "dynamic options a5",
        ],
        [
          'const m7 = {}; m7["exec" + "Path"] = "/x"; fork("w.js", [], m7);',
          "dynamic options m7 escapes",
        ],
        ['var m8 = {}; fork("w2.js", [], m8);', "dynamic options m8"],
        ['const m9 = { cwd: "/" }; fork("ok.js", [], m9); fork("ok2.js", [], m9);', null],
        ['fork("s.js", [], { "execPath": "/x" });', "options.execPath"],
        [
          'fork("s2.js", [], { ["execPath"]: "/x" });',
          ["options.execPath", "dynamic options computed key"],
        ],
        ['fork("s3.js", [], { ["exec" + "Path"]: "/x" });', "dynamic options computed key"],
        ['const execPath = "/x"; fork("s5.js", [], { execPath });', "options.execPath"],
        ['fork("s4.js", [], { cwd: process.execPath });', null],
        // TDA-PRF1B-I-01 (c) / SEC-PRF1B-R-03: destructuring, aliases, element access, .call / .apply
        ['const { spawn } = cp; spawn("node", []);', "command node"],
        ['const { spawn: sp2 } = cp; sp2("tsx", []);', "command tsx"],
        ['const s3 = cp.spawn; s3("deno", []);', "command deno"],
        ['const { execSync: es2 } = cp2; es2("tsx x.ts");', "command tsx"],
        ['const cpAlias = cp; cpAlias.spawn("bun", []);', "command bun"],
        ['cp["spawn"]("node", []);', "dynamic reference"],
        ["cp.spawn.call(null, 'node', []);", "dynamic command"],
        ['cp.fork.apply(null, ["a.js"]);', "dynamic command"],
        ["run(cp.spawn);", "dynamic reference"],
        ['const { ["spawn"]: sp9 } = cp;', "dynamic destructuring"],
        ['cpd.spawn("deno", []);', "command deno"],
        ['const pfy = promisify(cp.execFile); pfy("node x.js", []);', "command node x.js"],
        // TPA-PRF1B-L-02: node-like commands after a shell separator
        ['execSync("pg_dump db | node dump.js");', "command node"],
        ['execSync("psql -c x && tsx x.ts");', "command tsx"],
        ['execSync("psql $(node -p 1)");', "command node"],
        ['execSync("psql; npx foo");', ["command npx", "command psql;"]],
        ['execSync("psql; (node x.js)");', ["command node", "command psql;"]],
        // SEC-PRF1C-R-08: a separator glued to the first command is not a first-command match
        ['execSync("psql; env node y");', "command psql;"],
        ["execSync(\"psql -c 'select 1' | pg_dump x\");", null],
        // SEC-PRF1C-I-01 (a): a promisify call is exempt only as the initializer of a tracked name
        ['promisify(cp.execFile)("node", ["x.js"]);', "dynamic reference"],
        ["export const run1 = promisify(execFile);", "dynamic reference"],
        ["module.exports = promisify(execFile);", "dynamic reference"],
        ["const o1 = { run: promisify(execFile) };", "dynamic reference"],
        ['const eaa = promisify(execFile); eaa("pg_dump", ["-V"]);', null],
        // (b): tracked bindings leaving the file (export / export specifier / shorthand / exported options)
        ["export const sp1 = cp.spawn;", "dynamic reference"],
        ["export { sp as spx };", "dynamic reference"],
        ["const p3 = promisify(execFile); export { p3 };", "dynamic reference"],
        ['const o3 = { sp }; o3.sp("node", []);', "dynamic reference"],
        ['export const o5 = { cwd: "/" }; fork("x.js", [], o5);', "dynamic options o5 escapes"],
        // (c): the module object escaping (assignment / argument / array / export default / .default)
        ['let c3; c3 = cp; c3.spawn("node", []);', "dynamic module reference"],
        ['function r1(c: typeof cp) { c.spawn("node", []); } r1(cp);', "dynamic module reference"],
        ['const arr = [cp]; arr[0].spawn("node", []);', "dynamic module reference"],
        ["export default cp2;", "dynamic module reference"],
        ['cp.default.spawn("node", []);', "dynamic module reference"],
        // (d): element access in any position
        ['const s4 = cp["spawn"]; s4("node", []);', "dynamic reference"],
        ['run(cp["spawn"]);', "dynamic reference"],
        // (e): module acquisition other than a direct require / import() / getBuiltinModule call
        ['const req2 = require; req2("child_process").spawn("node", []);', "dynamic require"],
        [
          'createRequire(import.meta.url)("node:child_process").spawn("node", []);',
          "dynamic require",
        ],
        ['process.getBuiltinModule("node:child_process").spawn("tsx", []);', "command tsx"],
        ['process.mainModule!.require("child_process").spawn("node", []);', "dynamic require"],
        [
          'import("node:child_process").then((m) => m.spawn("node", []));',
          "dynamic import of child_process",
        ],
        // (f): a cooked (escaped) string key is still execPath
        ['fork("a.js", [], { "exec\\x50ath": "/x/node" });', "options.execPath"],
        // TDA-PRF1C-05: the alias fixpoint must run past one pass (spawner alias declared before its module alias)
        ['function f9() { const s9 = a9.spawn; s9("node", []); } const a9 = cp;', "command node"],
        // SEC-PRF1C-I-01 (M1 / M2): `default` of the module (named import / destructuring) reaches the same object
        [
          'import { default as c9 } from "node:child_process"; c9.spawn("node", []);',
          "command node",
        ],
        ["const { default: d9 } = cp;", "dynamic destructuring"],
        ['const { default: d8 } = await import("node:child_process");', "dynamic destructuring"],
        // TRK-02: re-export declarations hand the module to another file
        ['export { spawn as s9 } from "node:child_process";', "dynamic re-export of child_process"],
        ['export * as cp9 from "node:child_process";', "dynamic re-export of child_process"],
        // SEC-PRF1C-R-05: a type-annotated acquisition (`as` / `!` / `satisfies` / `<T>`) is still the module
        [
          'const { spawn: sq } = require("child_process") as typeof cp; sq("node", []);',
          "command node",
        ],
        ['const cy = require("child_process") as any; cy.spawn("node", []);', "command node"],
        ['(require("child_process") as any).spawn("node", []);', "command node"],
        [
          'const cw = <any>require("child_process")! satisfies unknown; cw.spawn("node", []);',
          "command node",
        ],
        // SEC-PRF1C-R-07: an acquisition call anywhere but an initializer / receiver is untracked
        ['const q1 = k ? require("child_process") : 0;', "dynamic import of child_process"],
        ['const q8 = id(require("child_process"));', "dynamic import of child_process"],
        ['const q9 = __importStar(require("child_process"));', "dynamic import of child_process"],
        [
          'const q2 = (k ? require("child_process") : 0) as any;',
          "dynamic import of child_process",
        ],
        [
          'const q3 = k ? process.getBuiltinModule("child_process") : 0;',
          "dynamic import of child_process",
        ],
        // SEC-PRF1C-R-09: an exported declaration that carries the module or a spawner out of the file
        ["export const { spawn: spE5 } = cp;", "dynamic reference"],
        ["export const cpE6 = cp;", "dynamic reference"],
      ];
      const sf = project.createSourceFile(
        "__control_spawn.ts",
        CASES.map(([code]) => code).join("\n"),
        { overwrite: true }
      );
      const expected = CASES.flatMap(([, what], i) =>
        [what ?? []].flat().map((w) => `control:${i + 1} ${w}`)
      ).sort(byLine);
      expect(spawnViolations(sf, "control")).toEqual(expected);
    });

    for (const ext of ["ts", "mjs"])
      it(`${INV}: control — a script-scope .${ext} (no import / export) is flagged, not resolved against other scripts' globals (SEC-PRF1C-R-02 / R-06)`, () => {
        const src =
          'const cpz = process.getBuiltinModule("child_process");\ncpz.spawn("psql", []);';
        const [a, b] = ["a", "b"].map((k) =>
          project.createSourceFile(`__script_${k}.${ext}`, src, { overwrite: true })
        );
        expect([a, b].map((sf, i) => spawnViolations(sf as SourceFile, `s${i}`))).toEqual([
          ["s0:1 dynamic (script scope)"],
          ["s1:1 dynamic (script scope)"],
        ]);
      });
  });

  // ===== leg (v) injection surface + launch =====
  describe("leg (v) guard has no injection surface; rejection really stops the process", () => {
    const requireFromHere = createRequire(__filename);

    it(`${INV}: exported names are fixed (no setters / test hooks) (S-2)`, () => {
      expect(Object.keys(requireFromHere(FLOOR_DIST)).sort()).toEqual([
        "NODE_ENGINES_RANGE",
        "NODE_RUNTIME_FLOOR_TABLE",
        "evaluateBrotliFixMarker",
        "evaluateNodeRuntime",
        "evaluateNodeVersion",
        "evaluateUndiciVersion",
        "parseSemver",
      ]);
      expect(Object.keys(requireFromHere(GUARD_DIST))).toEqual([]);
      expect(Object.isFrozen(NODE_RUNTIME_FLOOR_TABLE)).toBe(true);
      expect(Object.values(NODE_RUNTIME_FLOOR_TABLE).every((row) => Object.isFrozen(row))).toBe(
        true
      );
    });

    it(`${INV}: no product source rewrites process (S-4/S-5)`, () => {
      const srcs = [
        ...walk(path.join(ROOT, "apps"), (f) => /\/apps\/[^/]+\/src\/.*\.ts$/.test(f)),
        ...walk(path.join(ROOT, "packages"), (f) => /\/src\/.*\.ts$/.test(f)),
      ];
      expect(
        srcs.filter((f) => /defineProperty\(\s*process\b/.test(fs.readFileSync(f, "utf-8")))
      ).toEqual([]);
      expect(SPOOF.includes(`${path.sep}tests${path.sep}`)).toBe(true);
    });

    const MESSAGE = `[reftrix] Unsupported Node.js runtime. Supported: ${NODE_ENGINES_RANGE}. See CHANGELOG.md (BREAKING: Node.js runtime floor).\n`;

    it(`${INV}: spoofed floor-exact runtime exits 0 silently (the spoof is effective, S-7 pair)`, () => {
      expect(runSpoofed(GUARD_DIST, ["22.23.4", "6.29.1", "node"])).toEqual({
        status: 0,
        stdout: "",
        stderr: "",
      });
    });

    it(`${INV}: spoofed below-floor runtime exits 1 with the fixed message and empty stdout`, () => {
      expect(runSpoofed(GUARD_DIST, ["22.16.0", "6.21.2", "node"])).toEqual({
        status: 1,
        stdout: "",
        stderr: MESSAGE,
      });
    });

    it(`${INV}: spoofed non-node release name exits 1`, () => {
      expect(runSpoofed(GUARD_DIST, ["22.23.4", "6.29.1", "io.js"])).toEqual({
        status: 1,
        stdout: "",
        stderr: MESSAGE,
      });
    });

    it(`${INV}: ESM --import spoof harness is effective too (pair: floor-exact exits 0, below-floor exits 1)`, () => {
      expect(fs.existsSync(SPOOF_ESM), `missing ESM harness: ${SPOOF_ESM}`).toBe(true);
      expect(runSpoofed(GUARD_DIST, ["22.23.4", "6.29.1", "node"], "import")).toEqual({
        status: 0,
        stdout: "",
        stderr: "",
      });
      expect(runSpoofed(GUARD_DIST, ["22.16.0", "6.21.2", "node"], "import")).toEqual({
        status: 1,
        stdout: "",
        stderr: MESSAGE,
      });
    });

    it.each(["require", "import"] as const)(
      `${INV}: spoofed children run in a private 0700 dir holding an empty .env.local so a regressed guard reads nothing (%s, SEC-PRF1C-I-02)`,
      (mode) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prf1c-cwd-"));
        try {
          const probe = path.join(dir, "probe.cjs");
          fs.writeFileSync(
            probe,
            'const fs = require("node:fs");\n' +
              "process.stdout.write(JSON.stringify({ cwd: process.cwd(), mode: fs.statSync(process.cwd()).mode & 0o777, env: fs.readFileSync('.env.local', 'utf-8') }));\n"
          );
          const r = runSpoofed(probe, ["22.23.4", "6.29.1", "node"], mode);
          const out = JSON.parse(r.stdout) as { cwd: string; mode: number; env: string };
          expect({ status: r.status, mode: out.mode, env: out.env }).toEqual({
            status: 0,
            mode: 0o700,
            env: "",
          });
          expect(path.basename(out.cwd)).toMatch(/^reftrix-spoof-/);
          expect(fs.existsSync(out.cwd), "private dir is removed afterwards").toBe(false);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    );

    it.each(["apps/mcp-server/dist/index.js", "apps/mcp-server/dist/scripts/start-workers.js"])(
      `${INV}: built entry %s exits 1 with the fixed message under a spoofed runtime (S-8)`,
      (rel) => {
        const entry = path.join(ROOT, rel);
        expect(fs.existsSync(entry), `missing (run pnpm build): ${entry}`).toBe(true);
        expect(runSpoofed(entry, ["22.16.0", "6.21.2", "node"])).toEqual({
          status: 1,
          stdout: "",
          stderr: MESSAGE,
        });
      }
    );
  });
});
