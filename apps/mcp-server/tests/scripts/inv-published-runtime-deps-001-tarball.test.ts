// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-PUBLISHED-RUNTIME-DEPS-001 — tarball mode and the forms that must never pass silently
 * (scripts/ci/check-published-runtime-deps.mjs --tarballs DIR --expect-count N)
 *
 * The packed tarballs are what the registry serves, so the same rules are applied to
 * `dist/**\/*.{js,cjs,mjs}` and the package.json inside each tarball. An empty or partial input
 * (no tarball, no JS, no playwright in mcp-server, a wrong count) fails; an unsafe archive entry is
 * refused before anything is extracted. R-85: the forms below are UNSCANNABLE or counted, in both modes.
 *
 * @module tests/scripts/inv-published-runtime-deps-001-tarball.test
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(REPO_ROOT, "scripts/ci/check-published-runtime-deps.mjs");
const TSC = join(REPO_ROOT, "node_modules/.bin/tsc");

interface Run {
  rc: number;
  out: string;
}
const node = (...args: string[]): Run => {
  const r = spawnSync("node", [SCRIPT, ...args], { encoding: "utf-8", cwd: REPO_ROOT });
  return { rc: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "inv-rtdeps-tgz-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const put = (root: string, rel: string, body: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const deps = (...n: string[]): Record<string, unknown> => ({
  dependencies: Object.fromEntries(n.map((x) => [x, "1.0.0"])),
});

/** Pack a package dir (given as files under package/) into <out>/<name>.tgz like `npm pack`. */
function pack(
  out: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>
): string {
  const w = tmp();
  put(w, "package/package.json", JSON.stringify({ name, version: "1.0.0", ...manifest }));
  for (const [rel, body] of Object.entries(files)) put(w, `package/${rel}`, body);
  const f = join(out, `${name.replace(/[@/]/g, "_")}.tgz`);
  mkdirSync(out, { recursive: true });
  expect(spawnSync("tar", ["-czf", f, "-C", w, "package"]).status).toBe(0);
  return f;
}
const tgz = (body: string, manifest: Record<string, unknown> = {}, file = "dist/a.cjs"): Run => {
  const out = tmp();
  pack(out, "@x/a", manifest, { [file]: body });
  return node("--tarballs", out, "--expect-count", "1");
};
/** The same body through src mode (a .ts file) to prove both modes treat it alike. */
const src = (body: string, manifest: Record<string, unknown> = {}): Run => {
  const root = tmp();
  put(root, "scripts/publish-targets.sh", 'PUBLISH_PACKAGES=("packages/a")\n');
  put(root, "package.json", "{}");
  put(root, "packages/a/package.json", JSON.stringify({ name: "@x/a", ...manifest }));
  put(root, "packages/a/src/a.ts", body);
  return node("--src", "--root", root);
};

describe("tarball mode: what is counted", () => {
  const counted: Array<[string, string, string, string]> = [
    ["require in .cjs", "dist/a.cjs", `const y = require("y");\nmodule.exports = y;`, "a"],
    ["ESM import in .mjs", "dist/a.mjs", `import y from "y";\nexport default y;`, "a"],
    ["ESM export star in .mjs", "dist/a.mjs", `export * from "y";`, "a"],
    ["dynamic import()", "dist/a.js", `exports.f = () => import("y");`, "b"],
    ["require.resolve", "dist/a.js", `exports.p = require.resolve("y");`, "b"],
    ["side-effect require", "dist/a.js", `require("y");`, "a"],
  ];
  for (const [name, file, body, rule] of counted) {
    it(`${name}: undeclared fails (rule ${rule}), declared passes`, () => {
      const bad = tgz(body, {}, file);
      expect(bad.rc).not.toBe(0);
      expect(bad.out).toMatch(
        new RegExp(`VIOLATION rule=${rule} pkg=@x/a specifier=y file=${file}:\\d+`)
      );
      expect(tgz(body, deps("y"), file).rc).toBe(0);
    });
  }
  it("a # subpath import is internal only when the nearest package.json defines it", () => {
    const out = tmp();
    pack(
      out,
      "@x/a",
      {},
      {
        "dist/gen/package.json": JSON.stringify({ imports: { "#main": "./m.js" } }),
        "dist/gen/index.js": `require("#main");`,
        "dist/m.js": "module.exports = 1;",
      }
    );
    expect(node("--tarballs", out, "--expect-count", "1").rc).toBe(0);
    const out2 = tmp();
    pack(out2, "@x/a", {}, { "dist/index.js": `require("#missing");` });
    expect(node("--tarballs", out2, "--expect-count", "1").rc).not.toBe(0);
  });
  it("relative, node: and self-reference imports are not counted; *.d.ts is not scanned", () => {
    const body = `require("./x");\nrequire("node:fs");\nrequire("@x/a/sub");`;
    expect(tgz(body).rc).toBe(0);
  });
});

describe("tarball mode: the one reasoned allowance for vendored Prisma glue", () => {
  const glue = `function ot() { return g(function () { return module.require; }, arguments); }`;
  it("a module.require value read passes only in the listed generated file", () => {
    expect(tgz(glue, {}, "dist/generated/prisma/query_engine_bg.js").out).toMatch(
      /ALLOWED .*reason=module-require-untraceable/
    );
    expect(tgz(glue, {}, "dist/generated/prisma/query_engine_bg.js").rc).toBe(0);
    expect(tgz(glue, {}, "dist/other.js").rc).not.toBe(0);
    expect(tgz(glue, {}, "dist/generated/prisma/index.js").rc).not.toBe(0);
  });
  it("the allowance covers that reason only: an undeclared require in the same file still fails", () => {
    const r = tgz(`${glue}\nrequire("y");`, {}, "dist/generated/prisma/query_engine_bg.js");
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/VIOLATION rule=a pkg=@x\/a specifier=y/);
  });
  it("src mode has no allowance", () => {
    expect(src(`export const f = module.require;`).rc).not.toBe(0);
  });
});

describe("tarball mode: non-empty and bounded input", () => {
  it("no tarball fails", () => {
    expect(node("--tarballs", tmp(), "--expect-count", "1").rc).not.toBe(0);
  });
  it("a tarball without any JS file fails", () => {
    const out = tmp();
    pack(out, "@x/a", {}, { "README.md": "x" });
    expect(node("--tarballs", out, "--expect-count", "1").rc).not.toBe(0);
  });
  it("mcp-server without a playwright occurrence fails", () => {
    const out = tmp();
    pack(out, "@x/mcp-server", deps("playwright"), { "dist/a.js": "exports.x = 1;" });
    const r = node("--tarballs", out, "--expect-count", "1");
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/reason=positive-control/);
    const ok = tmp();
    pack(ok, "@x/mcp-server", deps("playwright"), { "dist/a.js": `require("playwright");` });
    expect(node("--tarballs", ok, "--expect-count", "1").rc).toBe(0);
  });
  it("a tarball count different from --expect-count fails, and --expect-count is required", () => {
    const out = tmp();
    pack(out, "@x/a", {}, { "dist/a.js": "exports.x = 1;" });
    expect(node("--tarballs", out, "--expect-count", "2").rc).not.toBe(0);
    expect(node("--tarballs", out).rc).not.toBe(0);
    expect(node("--tarballs", out, "--expect-count", "1").rc).toBe(0);
  });
  it("an unparsable package.json or JS fails", () => {
    expect(tgz("const = ;").rc).not.toBe(0);
    const out = tmp();
    const w = tmp();
    put(w, "package/package.json", "{ not json");
    put(w, "package/dist/a.js", "exports.x = 1;");
    spawnSync("tar", ["-czf", join(out, "x.tgz"), "-C", w, "package"]);
    expect(node("--tarballs", out, "--expect-count", "1").rc).not.toBe(0);
  });
});

describe("tarball mode: unsafe archive entries are refused before extraction (R-45)", () => {
  const refuse = (make: (w: string, out: string) => void): void => {
    const w = tmp();
    const out = tmp();
    put(w, "package/package.json", '{"name":"@x/a"}');
    put(w, "package/dist/a.js", "exports.x = 1;");
    make(w, out);
    const r = node("--tarballs", out, "--expect-count", "1");
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/reason=unsafe-archive-entry/);
  };
  it("a .. path", () =>
    refuse((w, out) => {
      spawnSync("tar", [
        "-czf",
        join(out, "x.tgz"),
        "-C",
        w,
        "--transform",
        "s,^package/dist,../evil,",
        "package",
      ]);
    }));
  it("an absolute path", () =>
    refuse((w, out) => {
      spawnSync("tar", [
        "-czPf",
        join(out, "x.tgz"),
        "--transform",
        `s,^${w}/package,/abs,`,
        join(w, "package"),
      ]);
    }));
  it("a symlink entry", () =>
    refuse((w, out) => {
      symlinkSync("/etc/passwd", join(w, "package/dist/link.js"));
      spawnSync("tar", ["-czf", join(out, "x.tgz"), "-C", w, "package"]);
    }));
});

/** R-85: forms outside the listed ones that used to pass silently. */
describe("both modes: createRequire and require forms that must fail or be counted", () => {
  const unscannable: Array<[string, string]> = [
    [
      "createRequire through (await import).default",
      `async function f(u) { return (await import("node:module")).default.createRequire(u)("y"); }`,
    ],
    [
      "createRequire inside a .then callback",
      `import("node:module").then((m) => m.createRequire(1)("y"));`,
    ],
    [
      "createRequire from process.getBuiltinModule",
      `process.getBuiltinModule("module").createRequire(1)("y");`,
    ],
    [
      "createRequire by element access",
      `const m = require("node:module");\nm["createRequire"](1)("y");`,
    ],
    ["require by element access", `require["resolve"]("y");`],
    ["import.meta.resolve with a non-literal", `export const f = (n) => import.meta.resolve(n);`],
    ["require read as a value", `const rq = require;\nrq("y");`],
    ["require passed as an argument", `declare const use: (r: unknown) => void;\nuse(require);`],
  ];
  for (const [name, body] of unscannable) {
    it(`${name} is UNSCANNABLE`, () => {
      const a = src(body, deps("y"));
      expect(a.rc, a.out).not.toBe(0);
      expect(a.out).toMatch(/UNSCANNABLE/);
      const b = tgz(
        body.replace("declare const use: (r: unknown) => void;\n", "const use = () => {};\n"),
        deps("y")
      );
      expect(b.rc, b.out).not.toBe(0);
    });
  }
  it("import.meta.resolve(literal) is counted under rule b", () => {
    const body = `export const p = import.meta.resolve("y");`;
    expect(src(body).out).toMatch(/VIOLATION rule=b pkg=packages\/a specifier=y/);
    expect(src(body, deps("y")).rc).toBe(0);
    expect(tgz(body, {}, "dist/a.mjs").out).toMatch(/VIOLATION rule=b/);
  });
  it("typeof require is not a use of require", () => {
    expect(tgz(`module.exports = typeof require;`).rc).toBe(0);
  });
  it("src mode refuses .js / .mjs / .cjs / .jsx files and symlinks under src instead of skipping them", () => {
    for (const f of ["a.js", "a.mjs", "a.cjs", "a.jsx"]) {
      const root = tmp();
      put(root, "scripts/publish-targets.sh", 'PUBLISH_PACKAGES=("packages/a")\n');
      put(root, "package.json", "{}");
      put(root, "packages/a/package.json", '{"name":"@x/a"}');
      put(root, "packages/a/src/ok.ts", "export {};");
      put(root, `packages/a/src/${f}`, `require("y");`);
      const r = node("--src", "--root", root);
      expect(r.rc, f).not.toBe(0);
      expect(r.out).toMatch(/UNSCANNABLE pkg=packages\/a reason=unscanned-file-kind/);
    }
    const root = tmp();
    put(root, "scripts/publish-targets.sh", 'PUBLISH_PACKAGES=("packages/a")\n');
    put(root, "package.json", "{}");
    put(root, "packages/a/package.json", '{"name":"@x/a"}');
    put(root, "packages/a/src/ok.ts", "export {};");
    symlinkSync(join(root, "packages/a/src/ok.ts"), join(root, "packages/a/src/link.ts"));
    expect(node("--src", "--root", root).rc).not.toBe(0);
  });
  it("reads publish-targets.sh without a shell: array references expand, other syntax fails closed", () => {
    const setup = (targets: string): string => {
      const root = tmp();
      put(root, "scripts/publish-targets.sh", targets);
      put(root, "package.json", "{}");
      put(root, "packages/a/package.json", '{"name":"@x/a"}');
      put(root, "packages/a/src/ok.ts", "export {};");
      return root;
    };
    // 別の配列の参照を展開する / references to another array expand
    const ok = node("--src", "--root", setup('T1=("packages/a")\nPUBLISH_PACKAGES=("${T1[@]}")\n'));
    expect(ok.rc, ok.out).toBe(0);
    // 解釈できない要素・未定義の参照・コマンド置換は読まずに失敗する / unknown syntax fails closed
    const base = 'PUBLISH_PACKAGES=("packages/a")\n';
    for (const bad of [
      "PUBLISH_PACKAGES=(packages/a)\n",
      'PUBLISH_PACKAGES=("${MISSING[@]}")\n',
      'PUBLISH_PACKAGES=("$(echo packages/a)")\n',
      // bash なら一覧が増える・変わる書き方 / forms bash would read differently
      base + 'PUBLISH_PACKAGES+=("packages/b")\n',
      base + 'PUBLISH_PACKAGES[1]="packages/b"\n',
      base + 'if true; then PUBLISH_PACKAGES=("packages/b"); fi\n',
      'declare -a PUBLISH_PACKAGES=("packages/a")\n',
      'PUBLISH_PACKAGES=("packages/a"\n  "packages/b")\n',
      base + ': <<X\nPUBLISH_PACKAGES=("packages/b")\nX\n',
      base + "source extra.sh\n",
      base + 'f() { PUBLISH_PACKAGES=("packages/b"); }\n',
      'OTHER=("packages/a")\n',
    ]) {
      const r = node("--src", "--root", setup(bad));
      expect(r.rc, bad).not.toBe(0);
      expect(r.out, bad).toMatch(/UNSCANNABLE reason=publish-targets-empty-or-unreadable/);
    }
  });
});

describe("parity: src mode on a TypeScript fixture equals tarball mode on its tsc output", () => {
  const SRC = [
    `import a from "p-static";`,
    `import "p-side";`,
    `export * from "p-star";`,
    `export { x } from "p-named";`,
    `export const d = () => import("p-dynamic");`,
    `export const r = () => require.resolve("p-resolve");`,
    `import type { T } from "p-type-only";`,
    `export type U = T;`,
    `export default a;`,
  ].join("\n");
  const pairs = (out: string): string[] =>
    [...out.matchAll(/VIOLATION rule=(\w) pkg=\S+ specifier=(\S+)/g)]
      .map((m) => `${m[1]}:${m[2]}`)
      .sort();
  for (const mode of ["cjs", "esm"] as const) {
    it(`NodeNext ${mode.toUpperCase()}: same (rule, specifier) set from src and from dist`, () => {
      const w = tmp();
      put(w, "src/a.ts", `declare const require: { resolve(s: string): string };\n${SRC}`);
      put(
        w,
        "package.json",
        JSON.stringify({ name: "@x/a", ...(mode === "esm" ? { type: "module" } : {}) })
      );
      put(
        w,
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ES2022",
            outDir: "dist",
            skipLibCheck: true,
            noResolve: true,
            noEmitOnError: false,
            strict: false,
            types: [],
          },
          include: ["src"],
        })
      );
      spawnSync(TSC, ["-p", w], { encoding: "utf-8" });
      expect(readdirSync(join(w, "dist")).length).toBeGreaterThan(0);
      const root = tmp();
      put(root, "scripts/publish-targets.sh", 'PUBLISH_PACKAGES=("packages/a")\n');
      put(root, "package.json", "{}");
      put(root, "packages/a/package.json", JSON.stringify({ name: "@x/a" }));
      put(root, "packages/a/src/a.ts", SRC);
      const fromSrc = pairs(node("--src", "--root", root).out);
      const out = tmp();
      const pk = tmp();
      put(
        pk,
        "package/package.json",
        JSON.stringify({ name: "@x/a", ...(mode === "esm" ? { type: "module" } : {}) })
      );
      for (const f of readdirSync(join(w, "dist")))
        put(pk, `package/dist/${f}`, require("node:fs").readFileSync(join(w, "dist", f), "utf-8"));
      spawnSync("tar", ["-czf", join(out, "a.tgz"), "-C", pk, "package"]);
      const fromDist = pairs(node("--tarballs", out, "--expect-count", "1").out);
      expect(fromSrc.length).toBe(6);
      expect(fromDist).toEqual(fromSrc);
    });
  }
});
