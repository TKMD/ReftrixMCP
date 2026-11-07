// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-PUBLISHED-RUNTIME-DEPS-001 (src mode) — scripts/ci/check-published-runtime-deps.mjs
 * Runtime imports of the published packages must be declared in each package's own manifest
 * (rule a static, rule b dynamic/resolve, rule c no borrowing, rule d one exact playwright version);
 * anything unscannable fails. Tarball mode is not part of this test.
 *
 * @module tests/scripts/inv-published-runtime-deps-001.test
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(REPO_ROOT, "scripts/ci/check-published-runtime-deps.mjs");

interface Run {
  rc: number;
  out: string;
}
const run = (root: string, ...extra: string[]): Run => {
  const r = spawnSync("node", [SCRIPT, "--src", "--root", root, ...extra], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
  });
  return { rc: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const roots: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "inv-rtdeps-"));
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const put = (root: string, rel: string, body: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const ssot = (pkgs: string[]): string =>
  `PUBLISH_PACKAGES=(${pkgs.map((p) => `"${p}"`).join(" ")})\n`;

interface FixturePkg {
  dir: string;
  manifest: Record<string, unknown>;
  files: Record<string, string>;
}
/** A tmp root with its own scripts/publish-targets.sh (the SSOT is always read from <root>). */
const fixture = (
  pkgs: FixturePkg[],
  opts: { rootManifest?: Record<string, unknown>; withSsot?: boolean } = {}
): string => {
  const root = tmp();
  if (opts.withSsot !== false) {
    put(root, "scripts/publish-targets.sh", ssot(pkgs.map((p) => p.dir)));
  }
  put(root, "package.json", JSON.stringify(opts.rootManifest ?? { name: "root" }));
  for (const p of pkgs) {
    put(
      root,
      `${p.dir}/package.json`,
      JSON.stringify({ name: `@x/${p.dir.split("/")[1]}`, ...p.manifest })
    );
    for (const [rel, body] of Object.entries(p.files)) put(root, `${p.dir}/${rel}`, body);
  }
  return root;
};
const one = (body: string, manifest: Record<string, unknown> = {}, file = "src/a.ts"): Run =>
  run(fixture([{ dir: "packages/a", manifest, files: { [file]: body } }]));

const deps = (...names: string[]): Record<string, unknown> => ({
  dependencies: Object.fromEntries(names.map((n) => [n, "1.0.0"])),
});

describe("INV-PUBLISHED-RUNTIME-DEPS-001 src mode: real tree", () => {
  it("the real 5 packages pass, every package scanned at least one file", () => {
    const r = run(REPO_ROOT);
    expect(r.out).toContain("RESULT PASS");
    expect(r.rc).toBe(0);
    const scanned = [...r.out.matchAll(/^SCANNED pkg=(\S+) files=(\d+)/gm)];
    // bash で source した件数と一致する（読み落としで検査対象が減らない）/ equals bash's count
    // 固定のコマンド文字列を repo root で実行し、パスを引数にしない（CodeQL #92）/ fixed command run in the repo root; no path argument (CodeQL #92)
    const bash = spawnSync(
      "bash",
      ["-c", 'source ./scripts/publish-targets.sh; echo "${#PUBLISH_PACKAGES[@]}"'],
      { cwd: REPO_ROOT, encoding: "utf-8" }
    );
    expect(bash.status, bash.stderr).toBe(0);
    expect(scanned.length).toBe(Number(bash.stdout.trim()));
    for (const m of scanned) expect(Number(m[2])).toBeGreaterThan(0);
  });
});

describe("INV-PUBLISHED-RUNTIME-DEPS-001 src mode: mutation of a copy of the real manifests", () => {
  let copy: string;
  const mcp = (): string => join(copy, "apps/mcp-server/package.json");
  const original = (): Record<string, any> =>
    JSON.parse(readFileSync(join(REPO_ROOT, "apps/mcp-server/package.json"), "utf-8"));
  const write = (m: Record<string, unknown>): void => writeFileSync(mcp(), JSON.stringify(m));

  beforeAll(() => {
    copy = tmp();
    cpSync(join(REPO_ROOT, "scripts/publish-targets.sh"), join(copy, "scripts/publish-targets.sh"));
    cpSync(join(REPO_ROOT, "package.json"), join(copy, "package.json"));
    const dirs = readFileSync(join(REPO_ROOT, "scripts/publish-targets.sh"), "utf-8")
      .match(/"(?:packages|apps)\/[a-z0-9-]+"/g)!
      .map((s) => s.slice(1, -1));
    for (const d of new Set(dirs)) {
      cpSync(join(REPO_ROOT, d, "package.json"), join(copy, d, "package.json"));
      cpSync(join(REPO_ROOT, d, "src"), join(copy, d, "src"), {
        recursive: true,
        filter: (s) =>
          !s.includes("node_modules") &&
          (statSync(s).isDirectory() || /\.(ts|tsx|mts|cts)$/.test(s)),
      });
    }
  });
  it("unmodified copy passes", () => {
    write(original());
    expect(run(copy).rc).toBe(0);
  });

  for (const name of ["playwright", "cheerio", "uuid", "@axe-core/playwright"]) {
    it(`removing ${name} from mcp-server dependencies fails and names the specifier and a real file`, () => {
      const m = original();
      delete m.dependencies[name];
      delete m.devDependencies?.[name];
      write(m);
      const r = run(copy);
      expect(r.rc).not.toBe(0);
      expect(r.out).toMatch(
        new RegExp(
          `VIOLATION rule=[ab] pkg=apps/mcp-server specifier=${name.replace("/", "\\/")} file=src/\\S+\\.ts:\\d+`
        )
      );
    });
  }

  it("removing the optional onnxruntime-node declaration fails rule b", () => {
    const m = original();
    delete m.optionalDependencies["onnxruntime-node"];
    write(m);
    const r = run(copy);
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/VIOLATION rule=b pkg=apps\/mcp-server specifier=onnxruntime-node/);
  });
});

describe("INV-PUBLISHED-RUNTIME-DEPS-001 src mode: what is counted (rules a and b)", () => {
  const counted: Array<[string, string, "a" | "b"]> = [
    ["static default import", `import y from "y";\nexport default y;`, "a"],
    ["named value import", `import { a } from "y";\nexport const b = a;`, "a"],
    ["side-effect import", `import "y";`, "a"],
    [
      "import used only in a type position (src is a superset of dist)",
      `import { A } from "y";\nexport type T = A;`,
      "a",
    ],
    ["export from", `export { a } from "y";`, "a"],
    ["export star", `export * from "y";`, "a"],
    ["require", `const y = require("y");\nexport { y };`, "a"],
    ["module.require", `export const y = module.require("y");`, "a"],
    ["import-equals", `import y = require("y");\nexport { y };`, "a"],
    ["dynamic import", `export const f = async () => import("y");`, "b"],
    ["require.resolve", `export const p = require.resolve("y");`, "b"],
    [
      "createRequire from a static import, bound const",
      `import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\nexport const p = r.resolve("y");\nexport const v = r("y");`,
      "b",
    ],
    [
      "createRequire from a destructured dynamic import (real packages/ml shape)",
      `export async function f() {\n  const { createRequire } = await import("node:module");\n  const require_ = createRequire(import.meta.url);\n  return require_.resolve("y");\n}`,
      "b",
    ],
    [
      "createRequire from require('node:module'), immediate call",
      `export const v = require("node:module").createRequire(import.meta.url)("y");`,
      "a",
    ],
    [
      "createRequire from module.createRequire via a default import, immediate resolve",
      `import Module from "node:module";\nexport const p = Module.createRequire(import.meta.url).resolve("y");`,
      "b",
    ],
    [
      "createRequire renamed in a static import (binding judged by the imported name)",
      `import { createRequire as cr } from "node:module";\nconst r = cr(import.meta.url);\nexport const v = r("y");`,
      "a",
    ],
    [
      "createRequire aliased through a const",
      `import { createRequire } from "node:module";\nconst f = createRequire;\nexport const v = f(import.meta.url)("y");`,
      "a",
    ],
    [
      "createRequire renamed in a destructured dynamic import",
      `export async function f() {\n  const { createRequire: cr } = await import("node:module");\n  return cr(import.meta.url)("y");\n}`,
      "a",
    ],
  ];
  for (const [name, body, rule] of counted) {
    it(`${name}: undeclared fails (rule ${rule}), declared passes`, () => {
      const bad = one(body);
      expect(bad.rc).not.toBe(0);
      expect(bad.out).toMatch(
        new RegExp(`VIOLATION rule=${rule} pkg=packages/a specifier=y file=src/a\\.ts:\\d+`)
      );
      expect(one(body, deps("y")).rc).toBe(0);
    });
  }

  it("rule a is strict: a static import declared only as optional or peer fails", () => {
    expect(
      one(`import y from "y";\nexport default y;`, { optionalDependencies: { y: "1" } }).rc
    ).not.toBe(0);
    expect(
      one(`import y from "y";\nexport default y;`, { peerDependencies: { y: "1" } }).rc
    ).not.toBe(0);
    expect(
      one(`import y from "y";\nexport default y;`, { devDependencies: { y: "1" } }).rc
    ).not.toBe(0);
    // rule b accepts a peer declaration
    expect(
      one(`export const f = async () => import("y");`, { peerDependencies: { y: "1" } }).rc
    ).toBe(0);
  });

  it("rule c: a package does not borrow the dependency of another package", () => {
    const root = fixture([
      { dir: "packages/a", manifest: deps("y"), files: { "src/a.ts": `export const x = 1;` } },
      {
        dir: "packages/b",
        manifest: {},
        files: { "src/b.ts": `import y from "y";\nexport default y;` },
      },
    ]);
    const r = run(root);
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/VIOLATION rule=a pkg=packages\/b specifier=y/);
  });
});

describe("INV-PUBLISHED-RUNTIME-DEPS-001 src mode: what is not counted", () => {
  const ignored: Array<[string, string]> = [
    ["import type", `import type { A } from "y";\nexport type T = A;`],
    ["import with only type specifiers", `import { type A } from "y";\nexport type T = A;`],
    ["export type from", `export type { A } from "y";`],
    ["export with only type specifiers", `export { type A } from "y";`],
    ["type-position import()", `export type T = import("y").Z;`],
    ["typeof import()", `export type T = typeof import("y");`],
    ["import statement inside a string", `export const s = "import React from 'y'";`],
    ["relative and absolute paths", `import "./x";\nimport "../y";\nexport * from "/abs/z";`],
    [
      "node: builtin and bare builtin",
      `import fs from "node:fs";\nimport path from "path";\nexport { fs, path };`,
    ],
    ["self reference", `import "@x/a/sub";`],
  ];
  for (const [name, body] of ignored) {
    it(`${name} is not counted`, () => {
      const r = one(body);
      expect(r.out).toContain("RESULT PASS");
      expect(r.rc).toBe(0);
    });
  }

  it("*.d.ts files are not scanned", () => {
    const r = one(`import y from "y";\nexport default y;`, {}, "src/types.d.ts");
    expect(r.rc).not.toBe(0); // the only file is excluded, so the package has no scanned file
    expect(r.out).toMatch(/files=0|no scanned file/i);
  });

  it("src/generated/** is not scanned and its presence does not change the result", () => {
    const base = { "src/a.ts": `export const x = 1;` };
    const withGen = {
      ...base,
      "src/generated/prisma/index.js": `require("@prisma/client");`,
      "src/generated/prisma/index.d.ts": `import "gen";`,
      "src/generated/prisma/package.json": `{"imports":{"#x":"./x.js"}}`,
    };
    const a = run(fixture([{ dir: "packages/a", manifest: {}, files: base }]));
    const b = run(fixture([{ dir: "packages/a", manifest: {}, files: withGen }]));
    expect(a.rc).toBe(0);
    expect(b.rc).toBe(0);
    expect(b.out.replace(/inv-rtdeps-\w+/g, "")).toBe(a.out.replace(/inv-rtdeps-\w+/g, ""));
  });

  it("# subpath imports: defined in the manifest imports is internal, undefined fails", () => {
    expect(one(`import "#internal";`, { imports: { "#internal": "./x.js" } }).rc).toBe(0);
    expect(one(`import "#missing";`).rc).not.toBe(0);
  });
});

describe("INV-PUBLISHED-RUNTIME-DEPS-001 src mode: fail-closed (nothing unscannable passes)", () => {
  const unscannable: Array<[string, string]> = [
    ["a parse error", `import { from "y";\nexport const = ;`],
    ["a non-literal require", `declare const x: string;\nexport const y = require(x);`],
    ["a non-literal import()", `declare const x: string;\nexport const y = () => import(x);`],
    [
      "a template literal with substitution",
      "declare const x: string;\nexport const y = () => import(`y/${x}`);",
    ],
    ["a require without argument", `export const y = require();`],
    [
      "a createRequire result passed as an argument",
      `import { createRequire } from "node:module";\ndeclare function use(r: unknown): void;\nconst r = createRequire(import.meta.url);\nuse(r);`,
    ],
    [
      "a createRequire result stored in an object",
      `import { createRequire } from "node:module";\nexport const o = { r: createRequire(import.meta.url) };`,
    ],
    [
      "a createRequire result bound with let",
      `import { createRequire } from "node:module";\nlet r = createRequire(import.meta.url);\nexport const v = r("y");`,
    ],
    [
      "the return value of createRequire destructured",
      `import { createRequire } from "node:module";\nconst { resolve } = createRequire(import.meta.url);\nexport const p = resolve("y");`,
    ],
    [
      "createRequire stored in an object",
      `import { createRequire } from "node:module";\nexport const o = { c: createRequire };`,
    ],
    ["module.require read without a call", `export const f = module.require;`],
  ];
  for (const [name, body] of unscannable) {
    it(`${name} fails even when everything named is declared`, () => {
      const r = one(body, deps("y"));
      expect(r.rc).not.toBe(0);
      expect(r.out).toMatch(/UNSCANNABLE pkg=packages\/a reason=\S+ file=src\/a\.ts:\d+/);
    });
  }

  it("a package with no scanned file fails", () => {
    const root = fixture([{ dir: "packages/a", manifest: {}, files: { "README.md": "x" } }]);
    expect(run(root).rc).not.toBe(0);
  });

  it("an empty SSOT, an unreadable manifest and an unknown option fail", () => {
    const empty = tmp();
    put(empty, "scripts/publish-targets.sh", "PUBLISH_PACKAGES=()\n");
    put(empty, "package.json", "{}");
    expect(run(empty).rc).not.toBe(0);
    const bad = fixture([{ dir: "packages/a", manifest: {}, files: { "src/a.ts": "export {};" } }]);
    writeFileSync(join(bad, "packages/a/package.json"), "{ not json");
    expect(run(bad).rc).not.toBe(0);
    expect(run(REPO_ROOT, "--bogus").rc).not.toBe(0);
  });

  it("--only with a value not in the SSOT fails", () => {
    const root = fixture([
      { dir: "packages/a", manifest: {}, files: { "src/a.ts": "export {};" } },
    ]);
    expect(run(root, "--only", "packages/zzz").rc).not.toBe(0);
  });
});

describe("INV-PUBLISHED-RUNTIME-DEPS-001 src mode: --only, rule d and the mcp-server positive control", () => {
  const mcpPkg = (playwright: string | undefined, body: string): FixturePkg => ({
    dir: "apps/mcp-server",
    manifest: playwright ? { dependencies: { playwright } } : {},
    files: { "src/a.ts": body },
  });
  const rootWith = (v?: string): Record<string, unknown> => ({
    devDependencies: v ? { playwright: v } : {},
  });

  it("rule d: root and mcp-server one exact version passes", () => {
    const r = run(
      fixture([mcpPkg("1.57.0", `import "playwright";`)], { rootManifest: rootWith("1.57.0") })
    );
    expect(r.rc).toBe(0);
  });

  it("rule d: a range operator on either side, a different version or a missing side fails", () => {
    for (const [root, mcpv] of [
      ["^1.57.0", "1.57.0"],
      ["1.57.0", "^1.57.0"],
      ["^1.57.0", "^1.57.0"],
      ["1.57.0", "1.57.1"],
      [undefined, "1.57.0"],
    ] as const) {
      const r = run(
        fixture([mcpPkg(mcpv, `import "playwright";`)], { rootManifest: rootWith(root) })
      );
      expect(r.rc, `${root} vs ${mcpv}`).not.toBe(0);
      expect(r.out).toMatch(/VIOLATION rule=d/);
    }
  });

  it("mcp-server positive control: no playwright occurrence in its src fails", () => {
    const r = run(
      fixture([mcpPkg("1.57.0", `export const x = 1;`)], { rootManifest: rootWith("1.57.0") })
    );
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/UNSCANNABLE pkg=apps\/mcp-server reason=positive-control/);
  });

  it("--only mcp-server still evaluates rule d, --only another package does not", () => {
    const root = fixture(
      [
        mcpPkg("1.57.0", `import "playwright";`),
        { dir: "packages/a", manifest: {}, files: { "src/a.ts": "export {};" } },
      ],
      { rootManifest: rootWith("^9.9.9") }
    );
    expect(run(root, "--only", "apps/mcp-server").rc).not.toBe(0);
    expect(run(root, "--only", "packages/a").rc).toBe(0);
  });

  it("--only reads the SSOT from <root>: with the copy it passes, without it fails", () => {
    const pkgs: FixturePkg[] = [
      { dir: "packages/database", manifest: {}, files: { "src/a.ts": "export {};" } },
    ];
    expect(run(fixture(pkgs), "--only", "packages/database").rc).toBe(0);
    expect(run(fixture(pkgs, { withSsot: false }), "--only", "packages/database").rc).not.toBe(0);
  });
});

describe("INV-PUBLISHED-RUNTIME-DEPS-001 src mode: rules that must stay strict (restored)", () => {
  const dyn = `export const f = async () => import("y");`;
  it("rule b does not accept a devDependencies declaration", () => {
    expect(one(dyn, { devDependencies: { y: "1" } }).rc).not.toBe(0);
  });
  it("generated/ is skipped only directly under src, not at any depth", () => {
    const files = { "src/ok.ts": "export {};", "src/x/generated/a.ts": `import "y";` };
    expect(run(fixture([{ dir: "packages/a", manifest: {}, files }])).out).toMatch(/specifier=y/);
  });
  it("the bare module specifier is the node:module object too", () => {
    const body = `import { createRequire } from "module";\nexport const v = createRequire(import.meta.url)("y");`;
    expect(one(body).rc).not.toBe(0);
    expect(one(body, deps("y")).rc).toBe(0);
  });
  it("import type = require is not a runtime import", () => {
    expect(one(`import type y = require("y");\nexport type T = typeof y;`).rc).toBe(0);
  });
});
