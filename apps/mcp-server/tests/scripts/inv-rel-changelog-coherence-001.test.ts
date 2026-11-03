// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-REL-CHANGELOG-COHERENCE-001 — scripts/ci/check-changelog-coherence.mjs
 *
 * The published sections of both CHANGELOG files stay frozen: (a) the topmost version heading is
 * the root version, (b) every line of a published section (heading and blank lines included)
 * was written by the heading commit or one of its ancestors, (c) no Known remainders anywhere
 * and no dated commitments from C_FLOOR on, (env) a broken environment is exit 2, never 0.
 * Every fixture is a temp git repo built with an isolated git; nothing reads the real history.
 *
 * @module tests/scripts/inv-rel-changelog-coherence-001.test
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
// the mutation runs point this at a patched copy of the script
const SCRIPT =
  process.env["CLG_SCRIPT"] ?? join(REPO_ROOT, "scripts/ci/check-changelog-coherence.mjs");
const ROOT_MD = "CHANGELOG.md";
const MCP_MD = "apps/mcp-server/CHANGELOG.md";
const BIG = 64 * 1024 * 1024;

const ENV: Record<string, string> = {
  PATH: process.env["PATH"] ?? "",
  HOME: "/nonexistent",
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  ...Object.fromEntries(
    ["AUTHOR", "COMMITTER"].flatMap((w) => [
      [`GIT_${w}_NAME`, "t"],
      [`GIT_${w}_EMAIL`, "t@example.invalid"],
      [`GIT_${w}_DATE`, "2026-01-01T00:00:00Z"],
    ])
  ),
};
const GIT_C = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
const git = (dir: string, ...a: string[]): string =>
  execFileSync("git", [...GIT_C, "-C", dir, ...a], {
    env: ENV,
    encoding: "utf8",
    maxBuffer: BIG,
  }).trim();

interface Mod {
  TARGET_FILES: readonly string[];
  C_FLOOR: string;
  LEGACY_ALLOWLIST: readonly {
    file: string;
    version: string;
    blameCommit: string;
    lineCount: number;
  }[];
  LEGACY_INTRO_ALLOWLIST: readonly Record<string, unknown>[];
  LEGACY_REMOVAL_ALLOWLIST: readonly Record<string, unknown>[];
  missingLines(before: string[], after: string[]): string[];
  compareSemver(a: string, b: string): number;
  parseHeading(line: string): Record<string, unknown>;
  isKnownRemainders(line: string): boolean;
  isDatedCommitment(line: string): boolean;
  parseBlamePorcelain(text: string, lineCount: number): string[];
  createGit(
    repo: string,
    o?: { maxBuffer?: number; timeout?: number }
  ): (a: string[], ok?: number[]) => { rc: number; stdout: string };
  runCoherence(o: Record<string, unknown>): { exit: number; lines: string[] };
}
let mod: Mod;
beforeAll(async () => {
  mod = (await import(pathToFileURL(SCRIPT).href)) as Mod;
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------- document builders
const hd = (v: string, date = "2026-01-01", t = ""): string =>
  `## [${v}] — ${date}${t} / [${v}] — ${date}${t}`;
const sec = (v: string, body: string[], date?: string, t?: string): string =>
  `${hd(v, date, t)}\n\n${body.map((l) => `${l}\n`).join("")}\n`;
const doc = (...s: string[]): string =>
  `# Changelog\n\n## [Unreleased] / [Unreleased]\n\n${s.join("")}`;
const pkg = (v: string): string => `${JSON.stringify({ name: "fx", version: v })}\n`;
const OLD = ["- old a", "- old b"];
const NEW = ["- new a", "- new b"];

class Fx {
  dir = mkdtempSync(join(tmpdir(), "clg-"));
  constructor() {
    dirs.push(this.dir);
    git(this.dir, "init", "-q", "-b", "main");
  }
  p = (rel: string): string => join(this.dir, rel);
  write(rel: string, text: string): void {
    mkdirSync(dirname(this.p(rel)), { recursive: true });
    writeFileSync(this.p(rel), text);
  }
  read = (rel: string): string => readFileSync(this.p(rel), "utf8");
  commit(msg: string): string {
    git(this.dir, "add", "-A");
    git(this.dir, "commit", "-q", "-m", msg);
    return git(this.dir, "rev-parse", "HEAD");
  }
  /** put `line` as the last body line of the [v] section (a "" line adds a blank line) */
  addLine(file: string, v: string, line: string): void {
    const ls = this.read(file).split("\n");
    const s = ls.findIndex((l) => l.startsWith(`## [${v}]`));
    let e = ls.findIndex((l, i) => i > s && l.startsWith("## "));
    if (e < 0) e = ls.length;
    let at = e;
    while (at > s + 1 && ls[at - 1] === "") at--;
    ls.splice(at, 0, line);
    this.write(file, ls.join("\n"));
  }
  lineOf = (file: string, needle: string): number =>
    this.read(file)
      .split("\n")
      .findIndex((l) => l.includes(needle)) + 1;
  run(args: string[] = [], env: Record<string, string> = {}): { code: number; out: string } {
    return sh(["--repo", this.dir, ...args], env);
  }
}
const sh = (args: string[], env: Record<string, string> = {}): { code: number; out: string } => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    maxBuffer: BIG,
    env: { PATH: ENV["PATH"] ?? "", HOME: "/nonexistent", ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

/** c1 = [0.9.0] only (root 0.9.0), c2 = release of [1.0.0] (root 1.0.0); both target files */
function mk(): { fx: Fx; c1: string; c2: string } {
  const fx = new Fx();
  fx.write("package.json", pkg("0.9.0"));
  for (const f of [ROOT_MD, MCP_MD]) fx.write(f, doc(sec("0.9.0", OLD, "2025-12-01")));
  const c1 = fx.commit("old");
  fx.write("package.json", pkg("1.0.0"));
  for (const f of [ROOT_MD, MCP_MD])
    fx.write(f, doc(sec("1.0.0", NEW), sec("0.9.0", OLD, "2025-12-01")));
  return { fx, c1, c2: fx.commit("release 1.0.0") };
}
const late = (fx: Fx, file: string, v: string, line: string): string => {
  fx.addLine(file, v, line);
  return fx.commit(`late ${line}`);
};
const rev = (s: string): string => s.slice(0, 8);
/** put a new topmost [v] section (one line) above [1.0.0] */
const withTop = (t: string, v: string): string =>
  t.replace(hd("1.0.0"), `${hd(v, "2026-02-01")}\n\n- first\n\n${hd("1.0.0")}`);

describe("INV-REL-CHANGELOG-COHERENCE-001 (a)(b): contract fixtures, default target files", () => {
  it("F1: clean history → exit 0 with a summary per file", () => {
    const { fx } = mk();
    const r = fx.run();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(ROOT_MD);
    expect(r.out).toContain(MCP_MD);
  });

  it("F2: a later commit appends to a published section → exit 1 b-late-line with file:line and both SHAs", () => {
    const { fx, c2 } = mk();
    const c3 = late(fx, MCP_MD, "1.0.0", "- late one");
    const c4 = late(fx, MCP_MD, "1.0.0", "- late two");
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${MCP_MD}:${fx.lineOf(MCP_MD, "- late one")} b-late-line`);
    expect(r.out).toContain(`${MCP_MD}:${fx.lineOf(MCP_MD, "- late two")} b-late-line`);
    for (const s of [c2, c3, c4]) expect(r.out).toContain(rev(s));
  });

  it("F2b: the same append in the root CHANGELOG.md is caught too", () => {
    const { fx } = mk();
    late(fx, ROOT_MD, "0.9.0", "- late root");
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${ROOT_MD}:${fx.lineOf(ROOT_MD, "- late root")} b-late-line`);
  });

  it("F2c: a late blank line alone is a violation", () => {
    const { fx } = mk();
    late(fx, MCP_MD, "1.0.0", "");
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("b-late-line");
  });

  it("F3a: root version has no heading → exit 1 a-version-mismatch naming both versions", () => {
    const { fx } = mk();
    fx.write("package.json", pkg("1.1.0"));
    fx.commit("bump without heading");
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("a-version-mismatch");
    expect(r.out).toContain("1.1.0");
    expect(r.out).toContain("1.0.0");
  });

  it("F3b: no version heading at all → exit 1 a-missing-heading", () => {
    const { fx } = mk();
    for (const f of [ROOT_MD, MCP_MD]) fx.write(f, doc());
    fx.commit("drop every heading");
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("a-missing-heading");
  });

  it("F4: heading date edit + append in ONE commit → exit 1 with and without --base, both lines named", () => {
    const { fx, c2 } = mk();
    fx.write(MCP_MD, fx.read(MCP_MD).replaceAll("— 2026-01-01", "— 2026-01-02"));
    fx.addLine(MCP_MD, "1.0.0", "- sneaked");
    fx.commit("edit heading date and append");
    for (const args of [[], ["--base", c2]]) {
      const r = fx.run(args);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(`${MCP_MD}:${fx.lineOf(MCP_MD, "## [1.0.0]")} b-heading-edited`);
      expect(r.out).toContain(`${MCP_MD}:${fx.lineOf(MCP_MD, "- sneaked")} b-late-line`);
    }
  });

  it("F5: append first, then fix the heading date in another commit → exit 1", () => {
    const { fx } = mk();
    late(fx, MCP_MD, "1.0.0", "- late");
    fx.write(MCP_MD, fx.read(MCP_MD).replaceAll("— 2026-01-01", "— 2026-01-03"));
    fx.commit("fix date after the append");
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("b-heading-edited");
    expect(r.out).toContain("b-late-line");
  });

  it("F6: delete the heading, then add it back → exit 1 (the heading commit is the oldest one)", () => {
    const { fx } = mk();
    const text = fx.read(MCP_MD);
    const h = hd("1.0.0");
    fx.write(MCP_MD, text.replace(`${h}\n`, ""));
    fx.commit("drop heading");
    fx.write(MCP_MD, text);
    fx.commit("restore heading");
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("b-heading-edited");
  });

  it("F7: --base with a new, non-topmost version heading and later lines → exit 1 b-late-line", () => {
    const { fx, c2 } = mk();
    const t = fx.read(MCP_MD);
    fx.write(
      MCP_MD,
      t.replace(
        `${hd("0.9.0", "2025-12-01")}\n`,
        `${hd("0.9.5")}\n\n${hd("0.9.0", "2025-12-01")}\n`
      )
    );
    fx.commit("insert 0.9.5 heading");
    fx.addLine(MCP_MD, "0.9.5", "- retro line");
    fx.commit("fill 0.9.5");
    const r = fx.run(["--base", c2]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`${MCP_MD}:${fx.lineOf(MCP_MD, "- retro line")} b-late-line`);
  });

  it("F7b: a new section equal to the root version but not topmost is not exempt", () => {
    const { fx, c1 } = mk();
    git(fx.dir, "checkout", "-q", "-b", "rel"); // main must not already hold the heading (exemption iv)
    fx.write(MCP_MD, withTop(fx.read(MCP_MD), "1.1.0"));
    fx.commit("1.1.0 above 1.0.0");
    late(fx, MCP_MD, "1.0.0", "- late in 1.0.0");
    const r = fx.run(["--base", c1]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${MCP_MD}:${fx.lineOf(MCP_MD, "- late in 1.0.0")} b-late-line`);
  });

  it("F10: a heading introduced without changing the git log -S count is never guessed (exit 1)", () => {
    const fx = new Fx();
    fx.write("package.json", pkg("0.9.0"));
    fx.write(ROOT_MD, doc(sec("0.9.0", OLD, "2025-12-01")));
    fx.write(MCP_MD, doc(sec("0.9.0", [...OLD, "- see ## [1.0.0] later"], "2025-12-01")));
    fx.commit("quote the future heading");
    fx.write("package.json", pkg("1.0.0"));
    fx.write(ROOT_MD, doc(sec("1.0.0", NEW), sec("0.9.0", OLD, "2025-12-01")));
    fx.write(MCP_MD, doc(sec("1.0.0", NEW), sec("0.9.0", OLD, "2025-12-01")));
    fx.commit("the real heading replaces the quote (same -S count in the mcp file)");
    fx.addLine(MCP_MD, "1.0.0", "- again ## [1.0.0]");
    fx.commit("another occurrence");
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      `${MCP_MD}:${fx.lineOf(MCP_MD, "## [1.0.0] —")} b-heading-commit-missing`
    );
    expect(r.out).not.toMatch(/^CHANGELOG\.md:\d+ /m);
  });

  it("F8: new topmost version, heading and lines in separate commits: --base → 0, strict → 1", () => {
    const { fx, c2 } = mk();
    git(fx.dir, "checkout", "-q", "-b", "rel");
    fx.write("package.json", pkg("1.1.0"));
    for (const f of [ROOT_MD, MCP_MD]) {
      fx.write(f, withTop(fx.read(f), "1.1.0"));
    }
    fx.commit("release 1.1.0 heading");
    for (const f of [ROOT_MD, MCP_MD]) fx.addLine(f, "1.1.0", "- moved in later");
    fx.commit("move lines into 1.1.0");
    const exempt = fx.run(["--base", c2]);
    expect(exempt.code, exempt.out).toBe(0);
    expect(exempt.out).toContain("exempt");
    const strict = fx.run();
    expect(strict.code).toBe(1);
    expect(strict.out).toContain("b-late-line");
  });

  it("F8b: the exemption needs V == root version (a bump-less new heading is not exempt)", () => {
    const { fx, c2 } = mk();
    git(fx.dir, "checkout", "-q", "-b", "rel"); // main must not already hold the heading (exemption iv)
    fx.write(
      MCP_MD,
      fx
        .read(MCP_MD)
        .replace(hd("1.0.0"), `${hd("1.1.0", "2026-02-01")}\n\n- first\n\n${hd("1.0.0")}`)
    );
    fx.commit("1.1.0 heading, no bump");
    fx.addLine(MCP_MD, "1.1.0", "- later");
    fx.commit("later");
    const r = fx.run(["--base", c2]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("a-version-mismatch");
    expect(r.out).toContain("b-late-line");
  });

  it("F9: uncommitted heading whose version is in --base → exit 1 b-heading-commit-missing; not in base → exempt", () => {
    const { fx, c2 } = mk();
    git(fx.dir, "branch", "rel");
    git(fx.dir, "checkout", "-q", "rel");
    fx.write("package.json", pkg("1.1.0"));
    fx.write(
      MCP_MD,
      fx
        .read(MCP_MD)
        .replace(hd("1.0.0"), `${hd("1.1.0", "2026-02-01")}\n\n- first\n\n${hd("1.0.0")}`)
    );
    fx.commit("rel: 1.1.0");
    git(fx.dir, "checkout", "-q", "main");
    fx.write("package.json", pkg("1.1.0"));
    for (const f of [ROOT_MD, MCP_MD]) fx.write(f, withTop(fx.read(f), "1.1.0"));
    const r = fx.run(["--base", "rel"]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("b-heading-commit-missing");
    expect(fx.run(["--base", c2]).code).toBe(0);
  });

  it("an uncommitted edit inside a published section → exit 1 (uncommitted), not exit 2", () => {
    const { fx } = mk();
    fx.addLine(MCP_MD, "1.0.0", "- not committed");
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("uncommitted");
  });

  it("a release commit that moves lines out of [Unreleased] → exit 0", () => {
    const { fx } = mk();
    for (const f of [ROOT_MD, MCP_MD]) {
      fx.write(f, fx.read(f).replace("[Unreleased]\n", "[Unreleased]\n\n- pending\n"));
    }
    fx.commit("pending line");
    fx.write("package.json", pkg("1.1.0"));
    for (const f of [ROOT_MD, MCP_MD]) {
      const t = fx.read(f).replace("- pending\n\n", "");
      fx.write(f, withTop(t, "1.1.0").replace("- first", "- pending"));
    }
    fx.commit("release 1.1.0");
    // 1.1.0 was written in its own heading commit; nothing published was touched
    const r = fx.run();
    expect(r.code, r.out).toBe(0);
  });

  it("the summary does not stop at the first violation: every violation is listed", () => {
    const { fx } = mk();
    late(fx, MCP_MD, "1.0.0", "- v1");
    late(fx, MCP_MD, "0.9.0", "- v2");
    late(fx, ROOT_MD, "1.0.0", "- v3");
    const r = fx.run();
    expect(r.code).toBe(1);
    expect((r.out.match(/ b-late-line /g) ?? []).length).toBe(3);
  });
});

describe("INV-REL-CHANGELOG-COHERENCE-001 (b-intro)(b-removed)(b-exempt iv)(env): fix loop 1", () => {
  const bothHalves = (t: string, from: string, to: string): string =>
    t.replaceAll(`[${from}]`, `[${to}]`);

  it.each([[ROOT_MD], [MCP_MD]])(
    "F11: rename a published version heading and append in ONE commit (%s) → b-heading-introduced-below-top, strict and --base",
    (f) => {
      const { fx, c2 } = mk();
      fx.write(f, bothHalves(fx.read(f), "0.9.0", "0.9.5"));
      fx.addLine(f, "0.9.5", "- injected after publication");
      fx.commit("rename and append");
      for (const args of [[], ["--base", c2]]) {
        const r = fx.run(args);
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain(
          `${f}:${fx.lineOf(f, "## [0.9.5]")} b-heading-introduced-below-top`
        );
      }
    }
  );

  it("F11b: a new topmost heading whose commit does not bump the root version → b-heading-introduced-without-bump", () => {
    const { fx } = mk();
    for (const f of [ROOT_MD, MCP_MD]) fx.write(f, withTop(fx.read(f), "1.1.0"));
    fx.commit("heading without a bump");
    fx.write("package.json", pkg("1.1.0"));
    fx.commit("bump later");
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("b-heading-introduced-without-bump");
  });

  it("F12: a lower version section (heading + body) inserted in ONE commit, --base → exit 1 below-top", () => {
    const { fx, c2 } = mk();
    const old = hd("0.9.0", "2025-12-01");
    fx.write(MCP_MD, fx.read(MCP_MD).replace(old, `${hd("0.9.5")}\n\n- retro line\n\n${old}`));
    fx.commit("insert a lower version in one commit");
    for (const args of [["--base", c2], []]) {
      const r = fx.run(args);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("b-heading-introduced-below-top");
    }
  });

  const removals: [string, (fx: Fx) => void, string][] = [
    [
      "P1 one line removed",
      (fx) => fx.write(MCP_MD, fx.read(MCP_MD).replace("- new b\n", "")),
      "b-published-line-removed",
    ],
    [
      "P2 heading line only removed",
      (fx) => fx.write(MCP_MD, fx.read(MCP_MD).replace(`${hd("0.9.0", "2025-12-01")}\n`, "")),
      "b-published-section-removed",
    ],
    [
      "P3 section removed",
      (fx) => fx.write(MCP_MD, fx.read(MCP_MD).replace(sec("0.9.0", OLD, "2025-12-01"), "")),
      "b-published-section-removed",
    ],
    [
      "P4 bump + rename the topmost published section + rewrite",
      (fx) => {
        fx.write("package.json", pkg("1.0.1"));
        for (const f of [ROOT_MD, MCP_MD]) {
          fx.write(
            f,
            doc(sec("1.0.1", ["- new a", "- REWRITTEN"]), sec("0.9.0", OLD, "2025-12-01"))
          );
        }
      },
      "b-published-section-removed",
    ],
  ];
  it.each(
    removals.flatMap(([n, m, rule]) => [
      [n, rule, "strict", m] as const,
      [n, rule, "--base", m] as const,
    ])
  )("%s → exit 1 %s (%s)", (_n, rule, mode, mutate) => {
    const { fx, c2 } = mk();
    mutate(fx);
    fx.commit("remove published content");
    const r = fx.run(mode === "strict" ? [] : ["--base", c2]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(rule);
  });

  it("the frozen intro and removal lists are exactly the measured legacy set", () => {
    const heads = [
      ["0.4.0", "46a58ce7f6887975ea9ad361e8fe44dbd70f11ae", ["without-bump"]],
      ["0.1.6", "ca5b83a95fff9683eff4682f3b0ecbd7c25fd754", ["without-bump"]],
      ["0.1.4", "9925a9f7fff89240a1d6e8363faac0912967bcb1", ["below-top", "without-bump"]],
    ] as const;
    expect(mod.LEGACY_INTRO_ALLOWLIST).toEqual(
      heads.map(([version, headingCommit, violations]) => ({
        file: ROOT_MD,
        version,
        headingCommit,
        violations,
      }))
    );
    const gone = [
      ["0.2.1", 1, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["0.1.7", 44, "891a8146bb21dcb35d7a7deb2f5b6aeabe04d2c0aa1eba1ad0753a95786ecdb9"],
      ["0.1.6", 5, "4d817edc8caf3b924f873519c6479e15701624aaa868a063e01944fff6d5fb0e"],
      ["0.1.5", 1, "70c5274638df9b5578d195001b4d3de2668928bccb7ffc92d6e66a0321bdd3b6"],
      ["0.1.3", 2, "70d5f9e2b0dfaffc3d88f3b4657fb13d04444e8ee99923ab112fc3b8c37a60a7"],
      ["0.1.2", 2, "d773a81eb12c8323fc8dfc123f669f01dac2cd574d1a0cf0efd8787c4f026286"],
      ["0.1.0", 15, "f7b74d15b50c97f938daf6fa8dabd101e894b1cc36d04a966682e43bfb48da1d"],
    ] as const;
    expect(mod.LEGACY_REMOVAL_ALLOWLIST).toEqual(
      gone.map(([version, missingLineCount, missingLinesSha256]) => ({
        file: ROOT_MD,
        version,
        missingLineCount,
        missingLinesSha256,
      }))
    );
  });

  it("the intro list excuses only the exact (file, version, heading commit, kind)", () => {
    const { fx, c2 } = mk();
    const old = hd("0.9.0", "2025-12-01");
    fx.write(MCP_MD, fx.read(MCP_MD).replace(old, `${hd("0.9.5")}\n\n- retro line\n\n${old}`));
    const c3 = fx.commit("insert a lower version in one commit");
    const entry = {
      file: MCP_MD,
      version: "0.9.5",
      headingCommit: c3,
      violations: ["below-top", "without-bump"],
    };
    const run = (e: unknown[]): number =>
      mod.runCoherence({ repo: fx.dir, base: c2, introAllowlist: e }).exit;
    expect(run([entry])).toBe(0);
    expect(run([])).toBe(1);
    expect(run([{ ...entry, violations: ["below-top"] }])).toBe(1);
    expect(run([{ ...entry, headingCommit: c2 }])).toBe(1);
    expect(run([{ ...entry, version: "0.9.6" }])).toBe(1);
    expect(run([{ ...entry, file: ROOT_MD }])).toBe(1);
  });

  it("the removal list excuses only the exact removed lines", () => {
    const { fx, c2 } = mk();
    fx.write(MCP_MD, fx.read(MCP_MD).replace("- new b\n", ""));
    fx.commit("remove a published line");
    const sha = createHash("sha256").update("- new b").digest("hex");
    const entry = { file: MCP_MD, version: "1.0.0", missingLineCount: 1, missingLinesSha256: sha };
    const run = (e: unknown[]): number =>
      mod.runCoherence({ repo: fx.dir, base: c2, removalAllowlist: e }).exit;
    expect(run([entry])).toBe(0);
    expect(run([])).toBe(1);
    expect(run([{ ...entry, missingLinesSha256: "0".repeat(64) }])).toBe(1);
    expect(run([{ ...entry, missingLineCount: 2 }])).toBe(1);
    expect(run([{ ...entry, file: ROOT_MD }])).toBe(1);
    expect(run([{ ...entry, version: "0.9.0" }])).toBe(1);
  });

  it("missingLines reports deleted and reordered lines, not added ones", () => {
    expect(mod.missingLines(["a", "b", "c"], ["a", "x", "b", "c", "d"])).toEqual([]);
    expect(mod.missingLines(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
    expect(mod.missingLines(["a", "b"], ["b", "a"])).toEqual(["b"]);
  });

  it("P8: git replace --graft cannot hide a late line", () => {
    const { fx } = mk();
    const c3 = late(fx, MCP_MD, "1.0.0", "- late");
    git(fx.dir, "replace", "--graft", c3);
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("b-late-line"); // the real history is read, not a rewritten one
    expect(r.out).not.toContain("b-heading-commit-missing");
  });

  it("P7: .git/info/grafts cannot hide a late line", () => {
    const { fx } = mk();
    const c3 = late(fx, MCP_MD, "1.0.0", "- late");
    writeFileSync(join(fx.dir, ".git/info/grafts"), `${c3}\n`);
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("b-late-line"); // the real history is read, not a rewritten one
    expect(r.out).not.toContain("b-heading-commit-missing");
  });

  it("iv-A: release branch with origin/main still before the release, default base → exempt, exit 0", () => {
    const fx = new Fx();
    fx.write("package.json", pkg("0.9.0"));
    for (const f of [ROOT_MD, MCP_MD]) fx.write(f, doc(sec("0.9.0", OLD, "2025-12-01")));
    const c1 = fx.commit("old");
    git(fx.dir, "update-ref", "refs/remotes/origin/main", c1);
    git(fx.dir, "checkout", "-q", "-b", "rel");
    fx.write("package.json", pkg("1.0.0"));
    for (const f of [ROOT_MD, MCP_MD])
      fx.write(f, doc(sec("1.0.0", ["- first"]), sec("0.9.0", OLD, "2025-12-01")));
    fx.commit("release heading");
    for (const f of [ROOT_MD, MCP_MD]) fx.addLine(f, "1.0.0", "- moved in later");
    fx.commit("move lines");
    const r = fx.run();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("1 exempt");
  });

  it("iv-B: origin/main behind but main already has the release; a late append, default base → exit 1", () => {
    const { fx, c1 } = mk();
    git(fx.dir, "update-ref", "refs/remotes/origin/main", c1);
    late(fx, MCP_MD, "1.0.0", "- late");
    const r = fx.run();
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("b-late-line");
  });

  /** B = the release branch (new top [1.0.0] + bump); S = its squash on main and origin/main; feat starts at B */
  function squashed(): { fx: Fx; B: string; S: string; c1: string } {
    const fx = new Fx();
    fx.write("package.json", pkg("0.9.0"));
    for (const f of [ROOT_MD, MCP_MD]) fx.write(f, doc(sec("0.9.0", OLD, "2025-12-01")));
    const c1 = fx.commit("old");
    git(fx.dir, "checkout", "-q", "-b", "rel");
    fx.write("package.json", pkg("1.0.0"));
    for (const f of [ROOT_MD, MCP_MD]) {
      fx.write(f, doc(sec("1.0.0", NEW), sec("0.9.0", OLD, "2025-12-01")));
    }
    const B = fx.commit("release 1.0.0");
    const S = git(fx.dir, "commit-tree", `${B}^{tree}`, "-p", c1, "-m", "squash of rel");
    git(fx.dir, "update-ref", "refs/heads/main", S);
    git(fx.dir, "update-ref", "refs/remotes/origin/main", S);
    return { fx, B, S, c1 };
  }

  it("iv'-A: a branch cut from the pre-squash release commit cannot append to the published section (default, strict, --base S → exit 1)", () => {
    const { fx, S } = squashed();
    git(fx.dir, "checkout", "-q", "-b", "feat");
    late(fx, MCP_MD, "1.0.0", "- appended after the squash");
    for (const args of [[], ["--base", "HEAD"], ["--base", S]]) {
      const r = fx.run(args);
      expect(r.code, `${args.join(" ")}: ${r.out}`).toBe(1);
      expect(r.out).toContain("b-late-line");
    }
  });

  it("iv'-B: the unchanged release branch still passes against a squashed main (default base → exit 0)", () => {
    const { fx } = squashed();
    const r = fx.run();
    expect(r.code, r.out).toBe(0);
  });

  it("L-01: a published section deleted in one commit, a release in the next: strict → exit 1 b-published-section-removed", () => {
    const { fx } = mk();
    fx.write(MCP_MD, fx.read(MCP_MD).replace(sec("0.9.0", OLD, "2025-12-01"), ""));
    fx.commit("delete an old published section");
    fx.write("package.json", pkg("1.1.0"));
    for (const f of [ROOT_MD, MCP_MD]) fx.write(f, withTop(fx.read(f), "1.1.0"));
    fx.commit("release 1.1.0");
    const r = fx.run([]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("b-published-section-removed");
  });

  it("L-02: the topmost published section deleted, then a release: --base catches it, strict does not (pinned residual)", () => {
    const { fx, c2 } = mk();
    fx.write(MCP_MD, fx.read(MCP_MD).replace(sec("1.0.0", NEW), ""));
    fx.commit("delete the topmost published section");
    fx.write("package.json", pkg("1.1.0"));
    fx.write(ROOT_MD, withTop(fx.read(ROOT_MD), "1.1.0"));
    fx.write(MCP_MD, doc(sec("1.1.0", ["- first"], "2026-02-01"), sec("0.9.0", OLD, "2025-12-01")));
    fx.commit("release 1.1.0");
    const r = fx.run(["--base", c2]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("b-published-section-removed");
    expect(fx.run([]).code).toBe(0);
  });

  it("one commit that writes both [Unreleased] and an older section: the ancestor memo is per heading commit", () => {
    const fx = new Fx();
    fx.write("package.json", pkg("0.9.0"));
    for (const f of [ROOT_MD, MCP_MD]) fx.write(f, doc(sec("0.9.0", OLD, "2025-12-01")));
    fx.commit("old");
    for (const f of [ROOT_MD, MCP_MD]) {
      fx.write(f, fx.read(f).replace("[Unreleased]\n\n", "[Unreleased]\n\n- pending\n\n"));
      fx.addLine(f, "0.9.0", "- late in 0.9.0");
    }
    fx.commit("writes Unreleased and 0.9.0");
    fx.write("package.json", pkg("1.0.0"));
    for (const f of [ROOT_MD, MCP_MD]) {
      fx.write(f, fx.read(f).replace("- pending\n", `${hd("1.0.0")}\n\n- pending\n`));
    }
    fx.commit("release 1.0.0 above the pending line");
    const r = fx.run();
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`${MCP_MD}:${fx.lineOf(MCP_MD, "- late in 0.9.0")} b-late-line`);
  });
});

describe("INV-REL-CHANGELOG-COHERENCE-001 (b-legacy): the frozen allowlist", () => {
  it("is exactly the measured legacy set of the root CHANGELOG.md (0.1.x), nothing else", () => {
    expect(mod.LEGACY_ALLOWLIST).toEqual([
      {
        file: ROOT_MD,
        version: "0.1.7",
        blameCommit: "78d808150ad7ce18331e284799431cfc5eb3c9d8",
        lineCount: 1,
      },
      {
        file: ROOT_MD,
        version: "0.1.5",
        blameCommit: "1dd0a49c751c69995d8061c777f67043418d42da",
        lineCount: 1,
      },
      {
        file: ROOT_MD,
        version: "0.1.2",
        blameCommit: "5da6fe01e67952ce23c435b332ae01d8b35a60d0",
        lineCount: 20,
      },
      {
        file: ROOT_MD,
        version: "0.1.2",
        blameCommit: "1dd0a49c751c69995d8061c777f67043418d42da",
        lineCount: 1,
      },
      {
        file: ROOT_MD,
        version: "0.1.0",
        blameCommit: "c5f2b6a705ba174a22310bdc4cf1d67d4945b602",
        lineCount: 6,
      },
      {
        file: ROOT_MD,
        version: "0.1.0",
        blameCommit: "720b49ce0ef049f2e822144009f27998cb3b69ff",
        lineCount: 14,
      },
      {
        file: ROOT_MD,
        version: "0.1.0",
        blameCommit: "b4f51ed7b62d8654601a1ce0902149d0c3e9e7d6",
        lineCount: 2,
      },
    ]);
  });

  it("a new late line in a 0.1.x section fails (the real allowlist knows only the frozen commits)", () => {
    const fx = new Fx();
    fx.write("package.json", pkg("0.1.8"));
    for (const f of [ROOT_MD, MCP_MD])
      fx.write(f, doc(sec("0.1.8", NEW), sec("0.1.7", OLD, "2026-03-01")));
    fx.commit("legacy");
    late(fx, ROOT_MD, "0.1.7", "- new late 0.1.x line");
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("b-late-line");
  });

  it("an allowlisted (file, version, commit) passes up to lineCount and fails above it", () => {
    const { fx } = mk();
    const c3 = late(fx, ROOT_MD, "0.9.0", "- legacy one");
    const allow = [{ file: ROOT_MD, version: "0.9.0", blameCommit: c3, lineCount: 1 }];
    expect(mod.runCoherence({ repo: fx.dir, legacyAllowlist: allow }).exit).toBe(0);
    fx.addLine(ROOT_MD, "0.9.0", "- legacy two");
    const c4 = fx.commit("amend c3-like"); // a different commit, not allowlisted
    expect(c4).not.toBe(c3);
    expect(mod.runCoherence({ repo: fx.dir, legacyAllowlist: allow }).exit).toBe(1);
    expect(
      mod.runCoherence({ repo: fx.dir, legacyAllowlist: [{ ...allow[0], blameCommit: c4 }] }).exit
    ).toBe(1);
    expect(
      mod.runCoherence({
        repo: fx.dir,
        legacyAllowlist: [...allow, { ...allow[0], blameCommit: c4 }],
      }).exit
    ).toBe(0);
  });

  it("an allowlisted commit with more lines than lineCount fails", () => {
    const { fx } = mk();
    fx.addLine(ROOT_MD, "0.9.0", "- one");
    fx.addLine(ROOT_MD, "0.9.0", "- two");
    const c3 = fx.commit("two lines at once");
    const allow = [{ file: ROOT_MD, version: "0.9.0", blameCommit: c3, lineCount: 1 }];
    expect(mod.runCoherence({ repo: fx.dir, legacyAllowlist: allow }).exit).toBe(1);
    expect(
      mod.runCoherence({ repo: fx.dir, legacyAllowlist: [{ ...allow[0], lineCount: 2 }] }).exit
    ).toBe(0);
  });
});

describe("INV-REL-CHANGELOG-COHERENCE-001 (c1)(c2): remainders and dated wording", () => {
  const MATCH: [string, string][] = [
    ["T+N d", "- fix it in T+1d"],
    ["quarter", "- backlog: 2026-Q4"],
    ["tracked paren", "- (tracked, L)"],
    ["deadline", "- Deadline: soon"],
    ["期限", "- 期限は来月"],
    ["日付まで", "- 2026-12-01までに直す"],
    ["日付 まで", "- 2026-12-01 まで保持"],
    ["resolution", "- resolution 2026-12-31"],
    ["due", "- due 2026-11-30"],
    ["until", "- kept until 2027-01-01"],
    ["by date", "- fix by 2026-11-30"],
  ];
  const NO_MATCH: [string, string][] = [
    ["by + past event", "- introduced by the 2026-10-21 security release"],
    ["by PR on date", "- added by #198 on 2026-10-31"],
    ["target word", "- the target directory is created"],
    ["plain date", "- released on 2026-10-31"],
    ["plain by", "- by default the cache is off"],
    ["version number", "- bump to 0.7.0"],
  ];
  it.each(MATCH)("c2 vocabulary matches: %s", (_n, line) => {
    expect(mod.isDatedCommitment(line)).toBe(true);
  });
  it.each(NO_MATCH)("c2 vocabulary does not match: %s", (_n, line) => {
    expect(mod.isDatedCommitment(line)).toBe(false);
  });
  it.each([["Known remainders"], ["### known REMAINDERS / 既知の残り"], ["既知の残り"]])(
    "c1 matches %j",
    (l) => {
      expect(mod.isKnownRemainders(l)).toBe(true);
    }
  );

  const withSections = (...s: [string, string[], string?, string?][]): Fx => {
    const fx = new Fx();
    fx.write("package.json", pkg(s[0]?.[0] ?? "1.0.0"));
    for (const f of [ROOT_MD, MCP_MD])
      fx.write(f, doc(...s.map(([v, b, d, t]) => sec(v, b, d, t))));
    fx.commit("fixture");
    return fx;
  };

  it("c1: Known remainders in a published section fails, including below C_FLOOR; in [Unreleased] it passes", () => {
    const fx = withSections(
      ["1.0.0", NEW],
      ["0.2.0", ["- x", "### Known remainders"], "2025-01-01"]
    );
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("c-known-remainders");
    const ok = withSections(["1.0.0", NEW]);
    ok.write(
      ROOT_MD,
      ok.read(ROOT_MD).replace("[Unreleased]\n", "[Unreleased]\n\n- Known remainders: none\n")
    );
    ok.commit("unreleased remainders");
    expect(ok.run().code).toBe(0);
  });

  it("c2: C_FLOOR boundary: 0.7.0 is checked, 0.6.9 is not, 0.10.0 is (numeric SemVer)", () => {
    expect(mod.C_FLOOR).toBe("0.7.0");
    const bad = ["- fix (tracked, T+1d)"];
    for (const [v, expectCode] of [
      ["0.7.0", 1],
      ["0.10.0", 1],
      ["0.6.9", 0],
    ] as const) {
      const fx = withSections([v, bad]);
      const r = fx.run();
      expect(r.code, `${v}: ${r.out}`).toBe(expectCode);
      if (expectCode === 1) expect(r.out).toContain("c-dated-commitment");
    }
  });

  it("c2: a heading is not a body line; (target) in a heading fails from C_FLOOR on only (heading-provisional)", () => {
    const hot = withSections(["0.7.0", NEW, "2026-01-01", " (target)"]);
    const r = hot.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("heading-provisional");
    expect(r.out).not.toContain("c-dated-commitment");
    expect(withSections(["0.6.9", NEW, "2026-01-01", " (target)"]).run().code).toBe(0);
  });
});

describe("INV-REL-CHANGELOG-COHERENCE-001: heading grammar, ordering, SemVer", () => {
  it("compareSemver is numeric and orders prereleases below the release", () => {
    expect(mod.compareSemver("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(mod.compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(mod.compareSemver("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
    expect(mod.compareSemver("0.7.0", "0.7.0")).toBe(0);
  });

  it.each([
    ["bilingual em dash", "## [0.7.0] — 2026-10-31 / [0.7.0] — 2026-10-31", true],
    ["legacy hyphen", "## [0.4.0] - 2026-04-11", true],
    [
      "(target) both halves",
      "## [0.5.1] — 2026-05-07 (target) / [0.5.1] — 2026-05-07 (target)",
      true,
    ],
    ["no date", "## [1.2.3]", true],
    ["unreleased", "## [Unreleased] / [Unreleased]", true],
    ["unknown heading", "## Plan v3 Wave 1", false],
    ["half mismatch (date)", "## [1.0.0] — 2026-01-01 / [1.0.0] — 2026-01-02", false],
    ["half mismatch (version)", "## [1.0.0] — 2026-01-01 / [1.0.1] — 2026-01-01", false],
  ])("parseHeading %s", (_n, line, ok) => {
    expect(mod.parseHeading(line)["ok"]).toBe(ok);
  });

  it("duplicate, out-of-order and unknown headings are reported", () => {
    const fx = new Fx();
    fx.write("package.json", pkg("1.0.0"));
    const dup = doc(sec("1.0.0", NEW), sec("1.0.0", NEW));
    const order = doc(sec("0.9.0", OLD), sec("1.0.0", NEW));
    const unknown = `${doc(sec("1.0.0", NEW))}## Notes\n\nx\n`;
    const rules: [string, string][] = [
      [dup, "heading-duplicate"],
      [order, "heading-order"],
      [unknown, "heading-unknown"],
    ];
    for (const [text, rule] of rules) {
      for (const f of [ROOT_MD, MCP_MD]) fx.write(f, text);
      fx.commit(rule);
      const r = fx.run();
      expect(r.code, rule).toBe(1);
      expect(r.out).toContain(rule);
    }
  });

  it("the target files and the floor are exported with exact values", () => {
    expect([...mod.TARGET_FILES]).toEqual([ROOT_MD, MCP_MD]);
    expect(mod.C_FLOOR).toBe("0.7.0");
  });

  it("a missing target file fails (exit 1 file-missing), it is never skipped", () => {
    const { fx } = mk();
    rmSync(fx.p(MCP_MD));
    fx.commit("remove one target");
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("file-missing");
  });
});

describe("INV-REL-CHANGELOG-COHERENCE-001 (env): a broken environment is exit 2, never 0", () => {
  it("a shallow clone → exit 2", () => {
    const { fx } = mk();
    const shallow = join(fx.dir, "..", `${fx.dir.split("/").pop()}-shallow`);
    dirs.push(shallow);
    git(fx.dir, "clone", "-q", "--depth", "1", `file://${fx.dir}`, shallow);
    const r = sh(["--repo", shallow]);
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain("shallow");
  });

  it("--repo that is not a git work tree → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "clg-nogit-"));
    dirs.push(d);
    writeFileSync(join(d, "package.json"), pkg("1.0.0"));
    expect(sh(["--repo", d]).code).toBe(2);
  });

  it("an unresolvable --base → exit 2", () => {
    const { fx } = mk();
    expect(fx.run(["--base", "no-such-rev"]).code).toBe(2);
  });

  it.each([
    ["--base=--foo"],
    ["--base=-x"],
    ["--file=-x"],
    ["--repo=-x"],
    ["--file=../x.md"],
    ["--file=/etc/passwd"],
    ["--bogus"],
    ["stray"],
  ])("option-shaped or unknown argument %s → exit 2", (a) => {
    const { fx } = mk();
    expect(fx.run([a]).code).toBe(2);
  });

  it("a target that is a directory (an uncaught fs error) → exit 2, not Node's default 1", () => {
    const { fx } = mk();
    mkdirSync(fx.p("dir.md"));
    const r = fx.run(["--file", "dir.md"]);
    expect(r.code, r.out).toBe(2);
  });

  it("an unreadable root package.json version → exit 2", () => {
    const { fx } = mk();
    fx.write("package.json", "{ not json");
    expect(fx.run().code).toBe(2);
  });

  it("a blame output above 1 MiB still passes (maxBuffer is not the 1 MiB default)", () => {
    const fx = new Fx();
    const body = Array.from(
      { length: 6000 },
      (_, i) => `- entry ${i} with some padding text to make the line longer`
    );
    fx.write("package.json", pkg("1.0.0"));
    for (const f of [ROOT_MD, MCP_MD]) fx.write(f, doc(sec("1.0.0", body)));
    fx.commit("big");
    const r = fx.run();
    expect(r.code, r.out.slice(0, 400)).toBe(0);
  });

  it("createGit: ENOBUFS and a non-allowed rc throw (exit 2 upstream), an allowed rc is returned", () => {
    const { fx } = mk();
    const g = mod.createGit(fx.dir, { maxBuffer: 16 });
    expect(() => g(["blame", "--line-porcelain", "--", ROOT_MD])).toThrow();
    const ok = mod.createGit(fx.dir);
    expect(ok(["merge-base", "--is-ancestor", "HEAD", "HEAD"]).rc).toBe(0);
    expect(() => ok(["rev-parse", "--verify", "--quiet", "nope"])).toThrow();
    expect(ok(["rev-parse", "--verify", "--quiet", "nope"], [0, 1]).rc).toBe(1);
  });

  it("parseBlamePorcelain: entry count, SHA shape and a stray line are checked", () => {
    const sha = "a".repeat(40);
    const one = `${sha} 1 1 1\nauthor x\n\tline one\n`;
    expect(mod.parseBlamePorcelain(one, 1)).toEqual([sha]);
    expect(() => mod.parseBlamePorcelain(one, 2)).toThrow();
    expect(() => mod.parseBlamePorcelain(`${"g".repeat(40)} 1 1 1\n\tx\n`, 1)).toThrow();
    expect(() => mod.parseBlamePorcelain(`stray\n${one}`, 1)).toThrow();
    const zero = `${"0".repeat(40)} 1 1 1\nauthor Not Committed Yet\n\tx\n`;
    expect(mod.parseBlamePorcelain(zero, 1)).toEqual(["0".repeat(40)]);
  });
});

describe("INV-REL-CHANGELOG-COHERENCE-001: git isolation and output hygiene", () => {
  it("a repo-local blame.ignoreRevsFile is refused (exit 2), never honoured", () => {
    const { fx } = mk();
    fx.write(MCP_MD, fx.read(MCP_MD).replace("- new b", "- new b edited"));
    const c3 = fx.commit("edit an existing line");
    fx.write(".git-blame-ignore-revs", `${c3}\n`);
    git(fx.dir, "config", "blame.ignoreRevsFile", ".git-blame-ignore-revs");
    const r = fx.run();
    expect(r.code).toBe(2);
    expect(r.out).toContain("blame.ignoreRevsFile");
  });

  it("a global (HOME) blame.ignoreRevsFile cannot hide a late line", () => {
    const { fx } = mk();
    fx.write(MCP_MD, fx.read(MCP_MD).replace("- new b", "- new b edited"));
    const c3 = fx.commit("edit an existing line");
    const home = mkdtempSync(join(tmpdir(), "clg-home-"));
    dirs.push(home);
    writeFileSync(join(home, "ignore"), `${c3}\n`);
    writeFileSync(
      join(home, ".gitconfig"),
      `[blame]\n\tignoreRevsFile = ${join(home, "ignore")}\n`
    );
    expect(fx.run([], { HOME: home }).code).toBe(1);
  });

  it("hostile line content (::error::, CR, ESC) never reaches the output raw; excerpts are cut at 120", () => {
    const { fx } = mk();
    late(fx, MCP_MD, "1.0.0", `::error::pwn\r\u001b[31mred ${"x".repeat(300)}`);
    const r = fx.run();
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("\u001b");
    expect(r.out).not.toContain("\r");
    for (const l of r.out.split("\n")) expect(l.startsWith("::")).toBe(false);
    expect(r.out).not.toContain("x".repeat(130));
  });
});

describe("INV-REL-CHANGELOG-COHERENCE-001: the script's own static contract", () => {
  it("node --check and a file-limited tsc --checkJs pass", { timeout: 120_000 }, () => {
    expect(spawnSync(process.execPath, ["--check", SCRIPT]).status).toBe(0);
    const tsc = spawnSync(
      join(REPO_ROOT, "node_modules/.bin/tsc"),
      "--noEmit --allowJs --checkJs --strict --target es2022 --module nodenext --moduleResolution nodenext --types node --skipLibCheck"
        .split(" ")
        .concat(SCRIPT),
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(tsc.status, tsc.stdout).toBe(0);
  });

  it("the script: node:* imports only, no shell, no history-widening git flags, JSDoc-checked", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const imports = [...script.matchAll(/^import .* from "([^"]+)";?$/gmu)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i).toMatch(/^node:/);
    expect(script).not.toMatch(/\bshell\s*:/);
    expect(script).not.toMatch(/(?<![.\w])(?:exec|execSync|spawn|fork)\(/);
    const cp = /import \{([^}]*)\} from "node:child_process"/.exec(script)?.[1] ?? "";
    expect(cp.split(",").map((x) => x.trim())).toEqual(["spawnSync"]);
    expect(script).not.toMatch(/--all\b|--branches|--tags\b|--pickaxe-regex/);
    expect(script).toMatch(/^\/\/ @ts-check$/m);
  });
});
