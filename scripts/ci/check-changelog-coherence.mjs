#!/usr/bin/env node
// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check

/**
 * CHANGELOG coherence guard (INV-REL-CHANGELOG-COHERENCE-001).
 *
 * Published release sections stay frozen. For each target file:
 *   (a) the topmost version heading equals the root package.json version; only [Unreleased] sits above it
 *   (b) every line of a published section (heading and blank lines included) was written by the
 *       commit that introduced the heading, or by one of its ancestors; that commit put the heading
 *       topmost and bumped the root version; no published line and no published version disappears
 *   (c) no "Known remainders" anywhere; no dated commitment from C_FLOOR on
 *   a published statement is corrected by an erratum under [Unreleased], never by editing the section.
 *   Text after the last section (a link footer) belongs to the lowest section.
 *
 * Usage: node scripts/ci/check-changelog-coherence.mjs [--base <rev>] [--file <path>]... [--repo <dir>]
 * Exit:  0 coherent | 1 a rule failed (all failures are listed) | 2 the environment cannot be trusted
 *        (shallow clone, git error, parse mismatch, bad argument): never 0.
 *
 * Out of scope on purpose: an internal change log that is not published (its released sections are
 * completed after the release); a published section inserted between two older ones in several
 * commits (the blank line at a section boundary can move between neighbours when a diff slides).
 * The heading commit is the oldest commit that changes the count of the literal heading text (what
 * `git log -S` selects), so no line number is read.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Files the guard checks; a missing one is a failure, never a skip. */
export const TARGET_FILES = Object.freeze(["CHANGELOG.md", "apps/mcp-server/CHANGELOG.md"]);

/** Lowest version whose body lines are checked for dated commitments (c2). Raising or lowering it is a reviewed change. */
export const C_FLOOR = "0.7.0";

/**
 * Frozen legacy set: lines of 0.1.x sections that were written after their heading commit.
 * New late lines in these sections fail; a listed commit may own at most `lineCount` lines.
 * @typedef {{ file: string, version: string, blameCommit: string, lineCount: number }} LegacyEntry
 * @type {readonly LegacyEntry[]}
 */
export const LEGACY_ALLOWLIST = Object.freeze(
  [
    ["0.1.7", "78d808150ad7ce18331e284799431cfc5eb3c9d8", 1],
    ["0.1.5", "1dd0a49c751c69995d8061c777f67043418d42da", 1],
    ["0.1.2", "5da6fe01e67952ce23c435b332ae01d8b35a60d0", 20],
    ["0.1.2", "1dd0a49c751c69995d8061c777f67043418d42da", 1],
    ["0.1.0", "c5f2b6a705ba174a22310bdc4cf1d67d4945b602", 6],
    ["0.1.0", "720b49ce0ef049f2e822144009f27998cb3b69ff", 14],
    ["0.1.0", "b4f51ed7b62d8654601a1ce0902149d0c3e9e7d6", 2],
  ].map(([version, blameCommit, lineCount]) =>
    Object.freeze({
      file: "CHANGELOG.md",
      version: String(version),
      blameCommit: String(blameCommit),
      lineCount: Number(lineCount),
    })
  )
);

// blame without an ignore-revs marker or a textconv filter (an ignore-revs list is refused, see checkRuleB)
const BLAME_ARGS = "-c blame.markIgnoredLines=false blame --no-textconv --line-porcelain".split(
  " "
);
/** @param {string} version @param {string} headingCommit @param {("below-top" | "without-bump")[]} violations */
const intro = (version, headingCommit, violations) =>
  Object.freeze({
    file: "CHANGELOG.md",
    version,
    headingCommit,
    violations: Object.freeze(violations),
  });
/** @param {string} version @param {number} missingLineCount @param {string} missingLinesSha256 */
const removal = (version, missingLineCount, missingLinesSha256) =>
  Object.freeze({ file: "CHANGELOG.md", version, missingLineCount, missingLinesSha256 });

/**
 * Frozen legacy set: published sections whose heading commit did not put the heading topmost and/or did not bump
 * the root version. A new such heading fails; the key is (file, version, heading commit, kind).
 * @typedef {{ file: string, version: string, headingCommit: string, violations: readonly ("below-top" | "without-bump")[] }} IntroEntry
 * @type {readonly IntroEntry[]}
 */
export const LEGACY_INTRO_ALLOWLIST = Object.freeze([
  intro("0.4.0", "46a58ce7f6887975ea9ad361e8fe44dbd70f11ae", ["without-bump"]),
  intro("0.1.6", "ca5b83a95fff9683eff4682f3b0ecbd7c25fd754", ["without-bump"]),
  intro("0.1.4", "9925a9f7fff89240a1d6e8363faac0912967bcb1", ["below-top", "without-bump"]),
]);

/**
 * Frozen legacy set: published lines removed after publication. The key is the section plus the count and the
 * SHA-256 of the removed lines, so any other removal changes the key and fails.
 * @typedef {{ file: string, version: string, missingLineCount: number, missingLinesSha256: string }} RemovalEntry
 * @type {readonly RemovalEntry[]}
 */
export const LEGACY_REMOVAL_ALLOWLIST = Object.freeze([
  removal("0.2.1", 1, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
  removal("0.1.7", 44, "891a8146bb21dcb35d7a7deb2f5b6aeabe04d2c0aa1eba1ad0753a95786ecdb9"),
  removal("0.1.6", 5, "4d817edc8caf3b924f873519c6479e15701624aaa868a063e01944fff6d5fb0e"),
  removal("0.1.5", 1, "70c5274638df9b5578d195001b4d3de2668928bccb7ffc92d6e66a0321bdd3b6"),
  removal("0.1.3", 2, "70d5f9e2b0dfaffc3d88f3b4657fb13d04444e8ee99923ab112fc3b8c37a60a7"),
  removal("0.1.2", 2, "d773a81eb12c8323fc8dfc123f669f01dac2cd574d1a0cf0efd8787c4f026286"),
  removal("0.1.0", 15, "f7b74d15b50c97f938daf6fa8dabd101e894b1cc36d04a966682e43bfb48da1d"),
]);

const OPTIONS = new Set(["--base", "--file", "--repo"]);
const MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const EXCERPT_MAX = 120;
const ZERO_SHA = /^0{40}$/;
const SHA = /^[0-9a-f]{40}$/;

/** An environment problem: the guard cannot give a trustworthy answer (exit 2). */
export class EnvError extends Error {}

// ---------------------------------------------------------------------------- git adapter

const GIT_ENV = Object.freeze({
  PATH: process.env["PATH"] ?? "",
  HOME: process.env["HOME"] ?? "",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  // history must be the real one: no replace refs, no grafts, no pathspec magic
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_GRAFT_FILE: "/nonexistent/clg-grafts",
  GIT_LITERAL_PATHSPECS: "1",
});

/**
 * One place that runs git: argv array, no shell, a fixed environment, a large buffer and a timeout.
 * An error, a signal or an rc outside `okRcs` throws EnvError.
 * @param {string} repo
 * @param {{ maxBuffer?: number, timeout?: number }} [opts]
 * @returns {(args: string[], okRcs?: number[]) => { rc: number, stdout: string, stderr: string }}
 */
export function createGit(repo, opts = {}) {
  const maxBuffer = opts.maxBuffer ?? MAX_BUFFER;
  const timeout = opts.timeout ?? GIT_TIMEOUT_MS;
  return (args, okRcs = [0]) => {
    const r = spawnSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: GIT_ENV,
      maxBuffer,
      timeout,
    });
    const sub = args.findIndex((a, i) => !a.startsWith("-") && args[i - 1] !== "-c");
    const name = `git ${args[sub] ?? ""}`;
    if (r.error) throw new EnvError(`${name}: ${r.error.message}`);
    if (r.status === null || !okRcs.includes(r.status)) {
      throw new EnvError(
        `${name} failed (rc ${String(r.status)}${r.signal ? `, ${r.signal}` : ""})`
      );
    }
    return { rc: r.status, stdout: r.stdout, stderr: r.stderr };
  };
}

/** @typedef {ReturnType<typeof createGit>} Git */

/**
 * File content at a commit, or null when the file is not in that tree.
 * @param {Git} git @param {string} rev @param {string} file
 * @returns {string | null}
 */
function fileAt(git, rev, file) {
  const r = git(["cat-file", "-p", `${rev}:${file}`], [0, 128]);
  if (r.rc === 0) return r.stdout;
  if (/Not a valid object name|does not exist in|exists on disk/.test(r.stderr)) return null;
  throw new EnvError("git cat-file failed");
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** @param {string} version */
const headingRe = (version) => new RegExp(`^## \\[${escapeRe(version)}\\]( |$)`, "m");

/**
 * One sweep of `git log -p` over the file: for each version, the commits (newest first, topological) that
 * changed the number of occurrences of `## [version]` in the file. This is what `git log -S"## [version]"`
 * selects, computed for every version at once.
 * @param {Git} git @param {string} file
 * @returns {Map<string, string[]>}
 */
function needleCommits(git, file) {
  const log = git([
    "log",
    "-p",
    "-U0",
    "--topo-order",
    "--no-textconv",
    "--no-ext-diff",
    "--no-color",
    "--format=%x01%H",
    "--",
    file,
  ]).stdout;
  /** @type {Map<string, string[]>} */
  const byVersion = new Map();
  for (const chunk of log.split("\x01").slice(1)) {
    const [commit = "", ...diff] = chunk.split("\n");
    for (const [v, d] of needleDelta(diff))
      if (d !== 0) byVersion.set(v, [...(byVersion.get(v) ?? []), commit]);
  }
  return byVersion;
}

/** Net change of the `## [version]` occurrences per version in the +/- lines of one diff. @param {string[]} diff */
function needleDelta(diff) {
  /** @type {Map<string, number>} */
  const delta = new Map();
  for (const l of diff.filter((x) => /^[+-](?![+-]{2} )/.test(x))) {
    for (const m of l.matchAll(/## \[([^\]\n]*)\]/g)) {
      delta.set(m[1] ?? "", (delta.get(m[1] ?? "") ?? 0) + (l.startsWith("+") ? 1 : -1));
    }
  }
  return delta;
}

/**
 * The commit that introduced `## [version]`: the oldest candidate whose tree has the heading line and whose
 * first parent has not. `text` is the file at that commit.
 * @param {Git} git @param {string} file @param {string} version @param {string[]} candidates newest first
 * @returns {{ commit: string, text: string } | null}
 */
function findHeadingCommit(git, file, version, candidates) {
  const re = headingRe(version);
  for (const c of [...candidates].reverse().filter((x) => SHA.test(x))) {
    const cur = fileAt(git, c, file);
    if (cur === null || !re.test(cur)) continue;
    const parent = firstParent(git, c);
    const prev = parent ? fileAt(git, parent, file) : null;
    if (prev === null || !re.test(prev)) return { commit: c, text: cur };
  }
  return null;
}

/** @param {Git} git @param {string} commit @returns {string | undefined} */
const firstParent = (git, commit) =>
  git(["rev-list", "--parents", "-n", "1", commit]).stdout.trim().split(" ")[1];

/**
 * Blame commit per line of a `git blame --line-porcelain` output; every entry is checked.
 * @param {string} text @param {number} lineCount
 * @returns {string[]}
 */
export function parseBlamePorcelain(text, lineCount) {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  /** @type {string[]} */
  const shas = [];
  let inEntry = false; // a header was read and its "\t<content>" line has not come yet
  for (const l of lines) {
    if (inEntry) {
      inEntry = !l.startsWith("\t");
      continue;
    }
    const sha = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(l)?.[1];
    if (!sha) throw new EnvError("blame output: unexpected line");
    shas.push(sha);
    inEntry = true;
  }
  if (inEntry) throw new EnvError("blame output: truncated entry");
  if (shas.length !== lineCount) {
    throw new EnvError(`blame output: ${shas.length} entries for ${lineCount} lines`);
  }
  return shas;
}

// ---------------------------------------------------------------------------- pure rules

/**
 * @param {string} a @param {string} b
 * @returns {number} negative, 0 or positive
 */
export function compareSemver(a, b) {
  const [ax = "", ...ap] = a.split("-");
  const [bx = "", ...bp] = b.split("-");
  const an = ax.split(".").map(Number);
  const bn = bx.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (an[i] ?? 0) - (bn[i] ?? 0);
    if (d !== 0) return d;
  }
  if (ap.length === 0 || bp.length === 0) return bp.length - ap.length; // a release sorts above its prereleases
  return ap.join("-").localeCompare(bp.join("-"), "en", { numeric: true });
}

const VER = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?";
const HALF = "(?: (?:—|-) (\\d{4}-\\d{2}-\\d{2}))?( \\(target\\))?";
const VERSION_HEADING = new RegExp(`^## \\[(${VER})\\]${HALF}(?: / \\[(${VER})\\]${HALF})?$`);
const UNRELEASED_HEADING = /^## \[Unreleased\](?: \/ \[Unreleased\])?$/;

/**
 * @param {string} line a line that starts with "## "
 * @returns {{ ok: true, unreleased: true } | { ok: true, unreleased: false, version: string, provisional: boolean } | { ok: false, rule: string }}
 */
export function parseHeading(line) {
  if (UNRELEASED_HEADING.test(line)) return { ok: true, unreleased: true };
  const m = VERSION_HEADING.exec(line);
  if (!m || !m[1]) return { ok: false, rule: "heading-unknown" };
  if (m[4] !== undefined && (m[4] !== m[1] || m[5] !== m[2] || m[6] !== m[3])) {
    return { ok: false, rule: "heading-bilingual-mismatch" };
  }
  return { ok: true, unreleased: false, version: m[1], provisional: m[3] !== undefined };
}

/** @param {string} line */
export const isKnownRemainders = (line) => /known remainders|既知の残り/i.test(line);

const DATED_COMMITMENT = [
  /T\+\d+d/,
  /\d{4}-Q[1-4]/,
  /\(tracked\b/,
  /deadline/i,
  /期限/,
  /\d{4}-\d{2}-\d{2}\s*まで/,
  /\bresolution \d{4}-\d{2}-\d{2}/i,
  /\bdue \d{4}-\d{2}-\d{2}/i,
  /\buntil \d{4}-\d{2}-\d{2}/i,
  /\bby \d{4}-\d{2}-\d{2}/i,
];
/** @param {string} line */
export const isDatedCommitment = (line) => DATED_COMMITMENT.some((re) => re.test(line));

/** One-line excerpt: control characters removed, cut at EXCERPT_MAX. @param {string} s */
const excerpt = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, EXCERPT_MAX);

/**
 * @typedef {{ file: string, line: number, rule: string, msg: string }} Violation
 * @typedef {{ version: string, start: number, end: number, provisional: boolean }} Section
 */

/** @returns {Violation} */
const viol = (
  /** @type {string} */ file,
  /** @type {number} */ line,
  /** @type {string} */ rule,
  /** @type {string} */ msg
) => ({ file, line, rule, msg });

/**
 * Parse headings into version sections (1-based inclusive line ranges) and report grammar problems.
 * @param {string} file @param {string[]} lines
 * @returns {{ sections: Section[], violations: Violation[] }}
 */
function parseSections(file, lines) {
  /** @type {Section[]} */
  const sections = [];
  /** @type {Violation[]} */
  const violations = [];
  /** @type {Section | null} */
  let open = null;
  let first = true;
  lines.forEach((text, idx) => {
    if (!text.startsWith("## ")) return;
    const h = parseHeading(text);
    const line = idx + 1;
    if (open) open.end = line - 1;
    open = null;
    if (!h.ok) violations.push(viol(file, line, h.rule, "unrecognised heading"));
    else if (h.unreleased && !first)
      violations.push(viol(file, line, "heading-order", "[Unreleased] must be the first heading"));
    else if (!h.unreleased) {
      open = { version: h.version, start: line, end: lines.length, provisional: h.provisional };
      sections.push(open);
    }
    first = false;
  });
  return { sections, violations };
}

/** @param {string} file @param {Section[]} sections @returns {Violation[]} */
function checkOrder(file, sections) {
  /** @type {Violation[]} */
  const out = [];
  const seen = new Set();
  sections.forEach((s, i) => {
    if (seen.has(s.version))
      out.push(viol(file, s.start, "heading-duplicate", `[${s.version}] appears twice`));
    seen.add(s.version);
    const prev = sections[i - 1];
    if (prev && prev.version !== s.version && compareSemver(prev.version, s.version) < 0) {
      out.push(
        viol(file, s.start, "heading-order", `[${s.version}] is not below [${prev.version}]`)
      );
    }
  });
  return out;
}

/** Rule (a). @param {string} file @param {Section[]} sections @param {string} root @returns {Violation[]} */
function checkRuleA(file, sections, root) {
  const top = sections[0];
  if (!top) return [viol(file, 0, "a-missing-heading", "no version heading")];
  if (top.version === root) return [];
  return [
    viol(
      file,
      top.start,
      "a-version-mismatch",
      `topmost heading [${top.version}], root version ${root}`
    ),
  ];
}

/** Rule (c). @param {string} file @param {string[]} lines @param {Section[]} sections @returns {Violation[]} */
function checkRuleC(file, lines, sections) {
  /** @type {Violation[]} */
  const out = [];
  for (const s of sections) {
    const dated = compareSemver(s.version, C_FLOOR) >= 0;
    if (dated && s.provisional)
      out.push(viol(file, s.start, "heading-provisional", `[${s.version}] is marked (target)`));
    for (let n = s.start; n <= s.end; n += 1) {
      const text = lines[n - 1] ?? "";
      const why = `[${s.version}] | ${excerpt(text)}`;
      if (isKnownRemainders(text)) out.push(viol(file, n, "c-known-remainders", why));
      if (dated && n > s.start && isDatedCommitment(text))
        out.push(viol(file, n, "c-dated-commitment", why));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- rule (b)

/**
 * The one section a change under test may add: new against `baseText`, topmost, the root version, and not
 * already reachable from main (a heading main has published is never exempt).
 * @param {Section | undefined} top @param {string} root @param {string | null} baseText @param {boolean} hasBase @param {boolean} inMain
 */
function isExempt(top, root, baseText, hasBase, inMain) {
  if (!hasBase || !top || top.version !== root || inMain) return false;
  return !(baseText !== null && headingRe(top.version).test(baseText));
}

const MAIN_REFS = ["refs/heads/main", "refs/remotes/origin/main"];

/**
 * Does the tip of a main ref that exists already carry the `## [version]` heading of `file`? Judged by content,
 * so a squash merge (a different commit with the same text) is recognised too.
 * @param {Git} git @param {string} file @param {string} version
 */
function mainTipHasHeading(git, file, version) {
  return MAIN_REFS.some((ref) => {
    const r = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], [0, 1]);
    const text = r.rc === 0 ? fileAt(git, r.stdout.trim(), file) : null;
    return text !== null && headingRe(version).test(text);
  });
}

/** Is `commit` an ancestor of a main ref that exists? @param {Git} git @param {string} commit */
function reachableFromMain(git, commit) {
  return MAIN_REFS.some((ref) => {
    const r = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], [0, 1]);
    return (
      r.rc === 0 && git(["merge-base", "--is-ancestor", commit, r.stdout.trim()], [0, 1]).rc === 0
    );
  });
}

/**
 * (b-intro): at its heading commit a section was the topmost version heading and the root version was V.
 * @param {Git} git @param {string} file @param {Section} section @param {{ commit: string, text: string }} heading @param {readonly IntroEntry[]} allow
 * @returns {Violation[]}
 */
function checkIntro(git, file, section, heading, allow) {
  const pkgText = fileAt(git, heading.commit, "package.json");
  if (pkgText === null) throw new EnvError("package.json is missing at a heading commit");
  /** @type {("below-top" | "without-bump")[]} */
  const kinds = [];
  if (parseSections(file, toLines(heading.text)).sections[0]?.version !== section.version)
    kinds.push("below-top");
  if (parseVersion(pkgText) !== section.version) kinds.push("without-bump");
  const listed = (/** @type {"below-top" | "without-bump"} */ k) =>
    allow.some(
      (e) =>
        e.file === file &&
        e.version === section.version &&
        e.headingCommit === heading.commit &&
        e.violations.includes(k)
    );
  return kinds
    .filter((k) => !listed(k))
    .map((k) =>
      viol(
        file,
        section.start,
        `b-heading-introduced-${k}`,
        `[${section.version}] heading commit ${heading.commit.slice(0, 8)}`
      )
    );
}

/**
 * Lines of `before` that a greedy in-order match in `after` does not find (deleted or reordered).
 * @param {string[]} before @param {string[]} after
 */
export function missingLines(before, after) {
  const out = [];
  let from = 0;
  for (const l of before) {
    const at = after.indexOf(l, from);
    if (at < 0) out.push(l);
    else from = at + 1;
  }
  return out;
}

/**
 * (b-removed, lines): the section at its heading commit is an in-order subsequence of the section now.
 * @param {string} file @param {string[]} lines @param {Section} section @param {{ text: string }} heading @param {readonly RemovalEntry[]} allow
 * @returns {Violation[]}
 */
function checkRemovedLines(file, lines, section, heading, allow) {
  const then = toLines(heading.text);
  const was = parseSections(file, then).sections.find((x) => x.version === section.version);
  const gone = missingLines(
    was ? then.slice(was.start - 1, was.end) : [],
    lines.slice(section.start - 1, section.end)
  );
  if (gone.length === 0) return [];
  const sha = createHash("sha256").update(gone.join("\n")).digest("hex");
  if (
    allow.some(
      (e) =>
        e.file === file &&
        e.version === section.version &&
        e.missingLineCount === gone.length &&
        e.missingLinesSha256 === sha
    )
  )
    return [];
  return [
    viol(
      file,
      section.start,
      "b-published-line-removed",
      `[${section.version}] ${gone.length} published line(s) missing | ${excerpt(gone[0] ?? "")}`
    ),
  ];
}

/**
 * (b-removed, versions): no version of an earlier point is gone from the file now. Earlier points: the parent of the
 * topmost heading commit (HEAD when that heading is uncommitted), --base, and the file at the heading commit of
 * every checked section.
 * @param {Git} git @param {string} file @param {Section[]} sections @param {{ commit: string } | null} top @param {string | null} base @param {Map<string, string>} headTexts heading commit -> file text
 * @returns {Violation[]}
 */
function checkVersionsKept(git, file, sections, top, base, headTexts) {
  const have = new Set(sections.map((s) => s.version));
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim();
  const revs = [top ? firstParent(git, top.commit) : head, base];
  const points = [
    ...revs.map(
      (rev) =>
        /** @type {[string, string | null]} */ ([String(rev), rev ? fileAt(git, rev, file) : null])
    ),
    ...headTexts,
  ];
  const gone = new Map();
  for (const [rev, text] of points) {
    for (const s of text === null ? [] : parseSections(file, toLines(text)).sections) {
      if (!have.has(s.version) && !gone.has(s.version)) gone.set(s.version, rev);
    }
  }
  return [...gone].map(([v, rev]) =>
    viol(
      file,
      0,
      "b-published-section-removed",
      `[${v}] is in ${rev.slice(0, 8)} and gone from the file`
    )
  );
}

/**
 * Lines of a section whose blame commit is neither the heading commit nor its ancestor, by blame commit.
 * The ancestors of a heading commit come from one `git rev-list` per heading (memoised per heading commit);
 * an uncommitted line (all-zero SHA) is in no ancestor set, so it is late.
 * @param {Git} git @param {string[]} blame @param {Section} section @param {string} heading @param {Map<string, Set<string>>} memo
 * @returns {Map<string, number[]>}
 */
function lateLines(git, blame, section, heading, memo) {
  let ancestors = memo.get(heading);
  if (!ancestors) {
    ancestors = new Set(
      git(["rev-list", heading])
        .stdout.split("\n")
        .filter((l) => SHA.test(l))
    );
    memo.set(heading, ancestors);
  }
  /** @type {Map<string, number[]>} */
  const byCommit = new Map();
  for (let n = section.start; n <= section.end; n += 1) {
    const b = blame[n - 1] ?? "";
    if (!ancestors.has(b)) byCommit.set(b, [...(byCommit.get(b) ?? []), n]);
  }
  return byCommit;
}

/**
 * Late lines of one section as violations, with the legacy allowlist applied.
 * @param {{ git: Git, file: string, lines: string[], blame: string[], section: Section, heading: string, memo: Map<string, Set<string>>, allow: readonly LegacyEntry[] }} c
 * @returns {Violation[]}
 */
function checkSectionLines(c) {
  const { file, lines, section, heading } = c;
  /** @type {Violation[]} */
  const out = [];
  for (const [b, nums] of lateLines(c.git, c.blame, section, heading, c.memo)) {
    const legacy = c.allow.find(
      (e) => e.file === file && e.version === section.version && e.blameCommit === b
    );
    if (legacy && nums.length <= legacy.lineCount) continue;
    const who = ZERO_SHA.test(b) ? "uncommitted" : `blame ${b.slice(0, 8)}`;
    const over = legacy ? ", over the legacy count" : "";
    for (const n of nums) {
      const msg = `[${section.version}] ${who}, heading commit ${heading.slice(0, 8)}${over} | ${excerpt(lines[n - 1] ?? "")}`;
      out.push(viol(file, n, n === section.start ? "b-heading-edited" : "b-late-line", msg));
    }
  }
  return out;
}

/** Memoised heading-commit lookup for one file. @param {Git} git @param {string} file */
function headingFinder(git, file) {
  const candidates = needleCommits(git, file);
  /** @type {Map<string, { commit: string, text: string } | null>} */
  const found = new Map();
  return (/** @type {string} */ v) => {
    if (!found.has(v)) found.set(v, findHeadingCommit(git, file, v, candidates.get(v) ?? []));
    return found.get(v) ?? null;
  };
}

/**
 * Is the topmost section already in main: by commit (reachable) or by content (a main tip carries the heading)?
 * @param {Git} git @param {string} file @param {Section | undefined} section @param {{ commit: string } | null} heading
 */
function mainHoldsTop(git, file, section, heading) {
  if (!section) return false;
  return (
    (heading !== null && reachableFromMain(git, heading.commit)) ||
    mainTipHasHeading(git, file, section.version)
  );
}

/** @typedef {{ git: Git, file: string, lines: string[], sections: Section[], root: string, base: string | null, allow: readonly LegacyEntry[], introAllow?: readonly IntroEntry[], removalAllow?: readonly RemovalEntry[] }} FileCtx */

/**
 * Everything (b) says about one non-exempt section whose heading commit is known.
 * @param {FileCtx & { blame: string[], memo: Map<string, Set<string>> }} c @param {Section} section @param {{ commit: string, text: string }} heading
 * @returns {Violation[]}
 */
function checkSection(c, section, heading) {
  const { git, file, lines, blame, memo, allow } = c;
  return [
    ...checkSectionLines({
      git,
      file,
      lines,
      blame,
      section,
      heading: heading.commit,
      memo,
      allow,
    }),
    ...checkIntro(git, file, section, heading, c.introAllow ?? LEGACY_INTRO_ALLOWLIST),
    ...checkRemovedLines(file, lines, section, heading, c.removalAllow ?? LEGACY_REMOVAL_ALLOWLIST),
  ];
}

/**
 * Rule (b) for every section of a file.
 * @param {FileCtx} c
 * @returns {{ violations: Violation[], checked: number, exempt: number }}
 */
function checkRuleB(c) {
  const { git, file, lines, sections, root, base } = c;
  // an empty value cannot reset a multi-valued setting on older git, so a configured list is refused
  if (git(["config", "--get-all", "blame.ignoreRevsFile"], [0, 1]).rc === 0) {
    throw new EnvError("blame.ignoreRevsFile is configured: it could hide late lines");
  }
  const blame = parseBlamePorcelain(git([...BLAME_ARGS, "--", file]).stdout, lines.length);
  const headingOf = headingFinder(git, file);
  const top = sections[0] ? headingOf(sections[0].version) : null;
  const inMain = mainHoldsTop(git, file, sections[0], top);
  const exemptTop = isExempt(
    sections[0],
    root,
    base ? fileAt(git, base, file) : null,
    base !== null,
    inMain
  );
  /** @type {Violation[]} */
  const violations = [];
  const memo = new Map();
  /** @type {Map<string, string>} */
  const headTexts = new Map();
  let checked = 0;
  for (const section of sections.filter((s) => !(exemptTop && s === sections[0]))) {
    const heading = headingOf(section.version);
    if (heading) checked += 1;
    if (heading) headTexts.set(heading.commit, heading.text);
    violations.push(
      ...(heading
        ? checkSection({ ...c, blame, memo }, section, heading)
        : [
            viol(
              file,
              section.start,
              "b-heading-commit-missing",
              `[${section.version}] heading is in no commit of this history`
            ),
          ])
    );
  }
  violations.push(...checkVersionsKept(git, file, sections, top, base, headTexts));
  return { violations, checked, exempt: exemptTop ? 1 : 0 };
}

// ---------------------------------------------------------------------------- driver

/** @param {string} file */
function assertSafePath(file) {
  if (file.startsWith("-") || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
    throw new EnvError("target path must be relative to the repository");
  }
}

/**
 * @param {Git} git @param {string | null} base @param {string} head
 * @returns {string | null} a commit SHA
 */
function resolveBase(git, base, head) {
  if (base !== null) {
    if (base.startsWith("-")) throw new EnvError("--base must be a revision");
    const r = git(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`],
      [0, 1]
    );
    if (r.rc !== 0) throw new EnvError("--base does not resolve to a commit");
    return r.stdout.trim();
  }
  const origin = git(
    ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"],
    [0, 1]
  );
  if (origin.rc !== 0) return head;
  const mb = git(["merge-base", "HEAD", origin.stdout.trim()], [0, 1]);
  return mb.rc === 0 ? mb.stdout.trim() : head;
}

/** @param {string} text @returns {string[]} */
function toLines(text) {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The "version" of a package.json text. @param {string} text */
function parseVersion(text) {
  try {
    const v = JSON.parse(text).version;
    if (typeof v !== "string" || !new RegExp(`^${VER}$`).test(v)) throw new Error("not a version");
    return v;
  } catch (e) {
    throw new EnvError(
      `package.json version unreadable: ${e instanceof Error ? e.message : "error"}`
    );
  }
}

/**
 * Text of a target file as lines, or null when it does not exist. Any other read error is an EnvError.
 * @param {string} top @param {string} file
 * @returns {string[] | null}
 */
function readTarget(top, file) {
  assertSafePath(file);
  let text;
  try {
    text = readFileSync(path.join(top, file), "utf8");
  } catch (e) {
    if (/** @type {{ code?: string }} */ (e).code === "ENOENT") return null;
    throw new EnvError(`cannot read ${file}`);
  }
  return toLines(text);
}

/**
 * Every rule over one file.
 * @param {Omit<FileCtx, "sections">} c
 * @returns {{ summary: string, violations: Violation[] }}
 */
function checkFile(c) {
  const { file, lines, root } = c;
  const parsed = parseSections(file, lines);
  const b = checkRuleB({ ...c, sections: parsed.sections });
  return {
    summary: `${file}: ${parsed.sections.length} published sections, ${b.checked} checked, ${b.exempt} exempt, base ${c.base?.slice(0, 8) ?? "none"}`,
    violations: [
      ...parsed.violations,
      ...checkOrder(file, parsed.sections),
      ...checkRuleA(file, parsed.sections, root),
      ...checkRuleC(file, lines, parsed.sections),
      ...b.violations,
    ],
  };
}

/**
 * Run every rule over the target files.
 * @param {{ repo: string, files?: readonly string[], base?: string | null, legacyAllowlist?: readonly LegacyEntry[], introAllowlist?: readonly IntroEntry[], removalAllowlist?: readonly RemovalEntry[] }} o
 * @returns {{ exit: 0 | 1, lines: string[] }} throws EnvError when the environment cannot be trusted
 */
export function runCoherence(o) {
  const top = createGit(o.repo)(["rev-parse", "--show-toplevel"]).stdout.trim();
  const git = createGit(top);
  if (git(["rev-parse", "--is-shallow-repository"]).stdout.trim() !== "false") {
    throw new EnvError("shallow clone: fetch full history (fetch-depth: 0)");
  }
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim();
  const base = resolveBase(git, o.base ?? null, head);
  const root = parseVersion(readFileSync(path.join(top, "package.json"), "utf8"));
  const allow = o.legacyAllowlist ?? LEGACY_ALLOWLIST;
  /** @type {Violation[]} */
  const violations = [];
  /** @type {string[]} */
  const summary = [];
  for (const file of o.files ?? TARGET_FILES) {
    const lines = readTarget(top, file);
    if (lines === null) {
      violations.push(viol(file, 0, "file-missing", "target file does not exist"));
      continue;
    }
    const r = checkFile({
      git,
      file,
      lines,
      root,
      base,
      allow,
      introAllow: o.introAllowlist,
      removalAllow: o.removalAllowlist,
    });
    summary.push(r.summary);
    violations.push(...r.violations);
  }
  const verdict = violations.length === 0 ? "PASS" : `FAIL (${violations.length} violations)`;
  const out = [...summary, ...violations.map((v) => `${v.file}:${v.line} ${v.rule} ${v.msg}`)];
  return {
    exit: violations.length === 0 ? 0 : 1,
    lines: [...out, `changelog coherence: ${verdict}`],
  };
}

/**
 * Split `--name value` / `--name=value`; the value must not look like an option.
 * @param {string[]} argv @param {number} i
 * @returns {{ name: string, value: string, next: number }}
 */
function readOption(argv, i) {
  const arg = argv[i] ?? "";
  const eq = arg.indexOf("=");
  const name = eq > 0 ? arg.slice(0, eq) : arg;
  if (!OPTIONS.has(name)) {
    throw new EnvError(`unknown argument ${excerpt(arg)}`);
  }
  const value = eq > 0 ? arg.slice(eq + 1) : (argv[i + 1] ?? "");
  if (value === "" || value.startsWith("-")) {
    throw new EnvError(`${name} needs a value that is not option-shaped`);
  }
  return { name, value, next: eq > 0 ? i + 1 : i + 2 };
}

/**
 * @param {string[]} argv
 * @returns {{ repo: string, base: string | null, files: string[] }}
 */
function parseArgs(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const opts = {
    repo: path.resolve(here, "../.."),
    base: /** @type {string | null} */ (null),
    files: /** @type {string[]} */ ([]),
  };
  for (let i = 0; i < argv.length; ) {
    const { name, value, next } = readOption(argv, i);
    if (name === "--base") opts.base = value;
    else if (name === "--repo") opts.repo = path.resolve(value);
    else opts.files.push(value);
    i = next;
  }
  return opts;
}

/**
 * @param {string[]} argv
 * @returns {number} the exit code
 */
export function main(argv) {
  try {
    const opts = parseArgs(argv);
    const { exit, lines } = runCoherence({
      repo: opts.repo,
      base: opts.base,
      files: opts.files.length > 0 ? opts.files : TARGET_FILES,
    });
    for (const l of lines) (exit === 0 ? console.log : console.error)(l);
    return exit;
  } catch (e) {
    console.error(
      `changelog coherence: environment error: ${excerpt(e instanceof Error ? e.message : "unknown error")}`
    );
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
