// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-INFRA-LICENSE-GATE-CLOSURE-001 — scripts/ci/check-published-license-closure.sh
 *
 * For each of the 5 published packages of scripts/publish-targets.sh (the union of the 5 closures
 * covers the published closure), `pnpm --filter <name> licenses list --prod` must give:
 *   (a) an inspected count > 0 (an empty closure alone exits non-zero)
 *   (b) every `dependencies` entry of the manifest that is not `workspace:` is in the closure
 *       (generalises the earlier "playwright is in mcp-server's closure": it holds now for every
 *       declared dependency, and covers playwright once it is declared in `dependencies`)
 *   (c) every license expression true under the allowlist (byte-identical to the previous
 *       --onlyAllow, no LGPL, no MIT-0) or matching REVIEWED (name AND exact license)
 *   (d) a listing that cannot be read or parsed, or an --only outside the SSOT, exits non-zero
 * plus ci.yml runs the script and no longer runs the root-only `npx license-checker`.
 *
 * @module tests/scripts/inv-infra-license-gate-closure-001.test
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(REPO_ROOT, "scripts/ci/check-published-license-closure.sh");
const PKG_DIRS = [
  "packages/core",
  "packages/database",
  "packages/ml",
  "packages/webdesign-core",
  "apps/mcp-server",
] as const;

/** The --onlyAllow value the gate carried before this change. It must not move. */
const ALLOWLIST_BEFORE =
  "MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;CC0-1.0;CC-BY-4.0;Unlicense;0BSD;AGPL-3.0-only;PostgreSQL;MPL-2.0;Python-2.0;BlueOak-1.0.0";

interface PkgJson {
  name: string;
  dependencies?: Record<string, string>;
}
function readPkg(dir: string): PkgJson {
  return JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")) as PkgJson;
}
function declared(dir: string): string[] {
  const deps = readPkg(dir).dependencies ?? {};
  return Object.entries(deps)
    .filter(([, v]) => !v.startsWith("workspace:"))
    .map(([n]) => n);
}

/** Entry shape of `pnpm licenses list --prod --json`: { "<license>": [{ name, versions, license }] }. */
type Listing = Record<string, Array<{ name: string; versions: string[]; license: string }>>;
function listing(rows: Array<[name: string, license: string]>): Listing {
  const out: Listing = {};
  for (const [name, license] of rows) {
    (out[license] ??= []).push({ name, versions: ["1.0.0"], license });
  }
  return out;
}
/**
 * A passing listing for a package: every declared dependency, MIT, plus one filler entry so the
 * fixture is non-empty even for a manifest that declares nothing (the OSS tree before the
 * runtime-dependency fix has \`dependencies: {}\` in the database package).
 */
function passing(dir: string): Listing {
  return listing([...declared(dir), "fixture-filler"].map((n) => [n, "MIT"]));
}

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "license-gate-"));
  mkdirSync(join(work, "bin"));
  mkdirSync(join(work, "fx"));
  // A pnpm stand-in: `pnpm --filter <name> licenses list --prod --json` prints fx/<name with / → _>.json.
  const shim = [
    "#!/usr/bin/env bash",
    'name=""; while [ $# -gt 0 ]; do if [ "$1" = "--filter" ]; then name="$2"; shift; fi; shift; done',
    'f="$FX_DIR/${name//\\//_}.json"',
    '[ -f "$f" ] || { echo "no fixture for $name" >&2; exit 9; }',
    'cat "$f"',
  ].join("\n");
  writeFileSync(join(work, "bin/pnpm"), shim);
  chmodSync(join(work, "bin/pnpm"), 0o755);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function fixture(dir: string, body: unknown): void {
  writeFileSync(
    join(work, "fx", `${readPkg(dir).name.replace(/\//g, "_")}.json`),
    JSON.stringify(body)
  );
}
function fixtureAllPassing(): void {
  for (const d of PKG_DIRS) fixture(d, passing(d));
}
function run(args: string[] = [], useShim = true): { status: number | null; out: string } {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: useShim ? `${join(work, "bin")}:${process.env.PATH ?? ""}` : (process.env.PATH ?? ""),
      FX_DIR: join(work, "fx"),
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("INV-INFRA-LICENSE-GATE-CLOSURE-001", () => {
  it("passes on the real repository and reports a non-zero inspected count for all 5 packages", () => {
    const r = run([], false);
    expect(r.status, r.out).toBe(0);
    for (const d of PKG_DIRS) {
      const m = new RegExp(`${readPkg(d).name.replace(/[/@]/g, "\\$&")}: inspected=(\\d+)`).exec(
        r.out
      );
      expect(m, `${d} missing from output:\n${r.out}`).not.toBeNull();
      expect(Number(m?.[1])).toBeGreaterThan(0);
    }
  });

  it("passes when every package lists its declared dependencies under allowed licenses", () => {
    fixtureAllPassing();
    const r = run();
    expect(r.status, r.out).toBe(0);
  });

  it("fails on an empty closure (the fail-open the old root-only gate had)", () => {
    fixtureAllPassing();
    fixture("packages/ml", {});
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(readPkg("packages/ml").name);
    expect(r.out).toMatch(/inspected=0|empty/);
  });

  it("fails when a declared dependency is absent from the closure (positive control)", () => {
    fixtureAllPassing();
    const missing = declared("apps/mcp-server")[0] as string;
    fixture(
      "apps/mcp-server",
      listing(
        declared("apps/mcp-server")
          .filter((n) => n !== missing)
          .map((n) => [n, "MIT"])
      )
    );
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(missing);
  });

  it("fails on a license outside the allowlist and names the package and license", () => {
    fixtureAllPassing();
    fixture(
      "packages/core",
      listing(
        [...declared("packages/core"), "evil-pkg"].map((n) => [
          n,
          n === "evil-pkg" ? "GPL-3.0-only" : "MIT",
        ])
      )
    );
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("evil-pkg");
    expect(r.out).toContain("GPL-3.0-only");
  });

  it("fails on an unreviewed LGPL package but accepts the individually reviewed libvips binaries", () => {
    fixtureAllPassing();
    const base = declared("packages/ml").map((n): [string, string] => [n, "MIT"]);
    fixture("packages/ml", listing([...base, ["some-lgpl-lib", "LGPL-3.0-or-later"]]));
    const bad = run();
    expect(bad.status).not.toBe(0);
    expect(bad.out).toContain("some-lgpl-lib");

    fixture(
      "packages/ml",
      listing([...base, ["@img/sharp-libvips-linux-x64", "LGPL-3.0-or-later"]])
    );
    const ok = run();
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toContain("reviewed=1");
  });

  it("does not accept a reviewed name under a different license", () => {
    fixtureAllPassing();
    const base = declared("packages/ml").map((n): [string, string] => [n, "MIT"]);
    fixture("packages/ml", listing([...base, ["@img/sharp-libvips-linux-x64", "GPL-3.0-only"]]));
    const r = run();
    expect(r.status).not.toBe(0);
  });

  it("evaluates SPDX expressions: OR passes on one allowed side, AND needs both, unknown fails", () => {
    const base = (d: string): Array<[string, string]> => declared(d).map((n) => [n, "MIT"]);
    fixtureAllPassing();
    fixture(
      "packages/core",
      listing([...base("packages/core"), ["dual", "(MIT OR GPL-3.0-only)"]])
    );
    expect(run().status).toBe(0);
    fixture(
      "packages/core",
      listing([...base("packages/core"), ["both", "(MIT AND GPL-3.0-only)"]])
    );
    expect(run().status).not.toBe(0);
    fixture("packages/core", listing([...base("packages/core"), ["nolic", "Unknown"]]));
    expect(run().status).not.toBe(0);
    fixture("packages/core", listing([...base("packages/core"), ["mit0", "MIT-0"]]));
    expect(run().status).not.toBe(0);
  });

  it("fails on an unparsable listing and on a package the listing command cannot read", () => {
    fixtureAllPassing();
    writeFileSync(
      join(work, "fx", `${readPkg("packages/core").name.replace(/\//g, "_")}.json`),
      "not json"
    );
    expect(run().status).not.toBe(0);
    rmSync(join(work, "fx", `${readPkg("packages/core").name.replace(/\//g, "_")}.json`));
    expect(run().status).not.toBe(0);
  });

  it("rejects an --only value that is not in scripts/publish-targets.sh", () => {
    fixtureAllPassing();
    expect(run(["--only", "packages/nope"]).status).not.toBe(0);
    expect(run(["--only", "packages/core"]).status).toBe(0);
  });

  it("keeps the allowlist byte-identical to the previous gate and never adds LGPL to it", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const m = /^LICENSE_ALLOWLIST="([^"]*)"$/m.exec(src);
    expect(m?.[1]).toBe(ALLOWLIST_BEFORE);
    expect(m?.[1]).not.toMatch(/LGPL/);
    expect(m?.[1]).not.toMatch(/MIT-0/);
  });

  it("runs the script from ci.yml and no longer runs the root-only license-checker", () => {
    const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("scripts/ci/check-published-license-closure.sh");
    expect(ci).not.toMatch(/npx\s+license-checker/);
    expect(ci).not.toContain("--excludePackages");
  });
});

/** The evaluator called directly, so a leg can be broken without the other legs masking it. */
const EVAL = join(REPO_ROOT, "scripts/ci/license-closure-eval.mjs");
const ALLOW = ALLOWLIST_BEFORE;
function evalRun(
  stdin: string,
  deps: Record<string, string> = {},
  args: string[] = []
): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "license-eval-"));
  try {
    const manifest = join(dir, "package.json");
    writeFileSync(manifest, JSON.stringify({ name: "fx-pkg", dependencies: deps }));
    const r = spawnSync(
      "node",
      [EVAL, "--name", "fx-pkg", "--manifest", manifest, "--allow", ALLOW, ...args],
      { input: stdin, encoding: "utf8" }
    );
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const one = (name: string, license: string): string => JSON.stringify(listing([[name, license]]));

describe("INV-INFRA-LICENSE-GATE-CLOSURE-001 (a): the evaluator alone", () => {
  it("fails on an empty closure when the manifest declares nothing (no other leg can hide it)", () => {
    const r = evalRun("{}", {});
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL fx-pkg: the closure is empty");
  });

  it("passes a non-empty closure of a manifest that declares nothing", () => {
    const r = evalRun(one("left-pad", "MIT"), {});
    expect(r.status).toBe(0);
    expect(r.out).toContain("fx-pkg: inspected=1 reviewed=0 declared=0");
  });

  it("names the missing declared dependency on a FAIL line", () => {
    const r = evalRun(one("a", "MIT"), { a: "1.0.0", b: "1.0.0" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL fx-pkg: declared dependency b is missing from the closure");
  });

  it("accepts the two reviewed MIT-0 packages and counts them as reviewed", () => {
    const r = evalRun(
      JSON.stringify(
        listing([
          ["@csstools/color-helpers", "MIT-0"],
          ["@csstools/css-syntax-patches-for-csstree", "MIT-0"],
        ])
      )
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("inspected=2 reviewed=2");
  });

  it("does not accept MIT-0 on any other name", () => {
    const r = evalRun(one("@csstools/other", "MIT-0"));
    expect(r.status).toBe(1);
    expect(r.out).toContain(
      'FAIL fx-pkg: @csstools/other: license "MIT-0" is outside the allowlist'
    );
  });

  it.each([
    ["a trailing operator", "MIT OR"],
    ["a leading operator", "OR MIT"],
    ["an extra token", "MIT GPL-3.0-only"],
    ["an unclosed parenthesis", "(MIT"],
    ["an empty string", ""],
  ])("fails closed on %s in a license expression", (_label, expr) => {
    const r = evalRun(one("x", expr));
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL fx-pkg: x: license");
  });

  it("fails (exit 1) on a listing whose license group is not an array", () => {
    const r = evalRun(JSON.stringify({ MIT: "not-an-array" }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("unexpected shape");
  });

  it("fails (exit 1) on a listing that is not an object, and exits 2 on bad arguments", () => {
    expect(evalRun("[]").status).toBe(1);
    const noArgs = spawnSync("node", [EVAL], { input: "{}", encoding: "utf8" });
    expect(noArgs.status).toBe(2);
  });
});

describe("INV-INFRA-LICENSE-GATE-CLOSURE-001: script exit codes and the real repository", () => {
  it("exits 2 (bad input), not 1, for a package dir outside the published set", () => {
    fixtureAllPassing();
    expect(run(["--only", "packages/config"]).status).toBe(2);
  });

  it("exits 1 with a FAIL <name>: line when a package fails", () => {
    fixtureAllPassing();
    fixture("packages/core", {});
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain(`FAIL ${readPkg("packages/core").name}: the closure is empty`);
  });

  it("inspects more entries than mcp-server declares (the closure is transitive, not the manifest)", () => {
    const r = run([], false);
    const m = /mcp-server: inspected=(\d+) reviewed=\d+ declared=(\d+)/.exec(r.out);
    expect(m, r.out).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(Number(m?.[2]));
  });

  it("mcp-server declares playwright and @axe-core/playwright in dependencies, so the closure covers them", () => {
    const deps = readPkg("apps/mcp-server").dependencies ?? {};
    expect(deps).toHaveProperty("playwright");
    expect(deps).toHaveProperty(["@axe-core/playwright"]);
  });
});
