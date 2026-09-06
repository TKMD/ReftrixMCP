// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SHARP-DECLARED-RANGE-001 (M)
 *
 * PR-S3b の sharp bump が作った **decoupling** を塞ぐ宣言レンジ guard。
 * root `pnpm.overrides.sharp` は **この monorepo の install にしか効かない**ため、
 * `apps/mcp-server/package.json` の宣言レンジが `^0.34.5` に戻っても
 * lockfile / install / 既存 INV は GREEN のままで、**publish される tarball だけが
 * 脆弱レンジ (`sharp` 0.34.x) を出荷する**。この silent path を機械 gate にする。
 *
 * Pins the declared `sharp` range against the **decoupling** introduced by the
 * PR-S3b bump: the root `pnpm.overrides.sharp` only affects installs *inside this
 * monorepo*, so if `apps/mcp-server/package.json` regressed to `^0.34.5` the
 * lockfile, the install and every existing INV would stay GREEN while the
 * **published tarball alone** would ship the vulnerable 0.34.x range. This test
 * turns that silent path into a machine gate.
 *
 * ## 3 leg / The three legs
 *
 * | leg | 対象 / target                                | 契約 / contract                                                              |
 * | --- | -------------------------------------------- | ---------------------------------------------------------------------------- |
 * | (a) | `apps/mcp-server/package.json` `dependencies` | 宣言レンジの floor >= 0.35.0 **かつ 0.34.x を 1 つも admit しない**          |
 * | (b) | root `package.json` `pnpm.overrides.sharp`   | 宣言が存在し floor >= 0.35.0                                                 |
 * | (c) | `pnpm-lock.yaml`                             | `^  sharp@` package 行の版が **1 種類だけ** で、その版が >= 0.35.0           |
 *
 * leg (c) は plan §3 Stage 2 の手動 grep (「lockfile に sharp が 1 版だけ」) の機械化であり、
 * TPA-M-01 の代替 landing (lockfile 単一版 assert) を兼ねる。
 * Leg (c) mechanises the plan §3 Stage 2 manual grep ("only one sharp version in the
 * lockfile") and doubles as the alternative landing for TPA-M-01.
 *
 * ## 実行しないこと / What this test deliberately does NOT do
 *
 * - **sharp を import / 実行しない** — 本 INV は宣言 (manifest / lockfile) の静的契約のみを見る。
 *   画像変換出力の parity は sibling の `INV-SHARP-PIPELINE-PARITY-001` が担当する (直交)。
 * - **新規依存を足さない** — `semver` package は本 repo の **どの package.json にも宣言されておらず**
 *   (`node_modules/.pnpm/semver@7.7.4/...` に解決される hoisted transitive = phantom dependency)、
 *   「依存宣言の drift を守る test が未宣言 phantom dep に依存する」のは自己矛盾であり、
 *   Registry F-S3B-M-02 も「手書き parse または既存 declared dep のみ」を要求している。
 *   したがって `^` / `~` / `>=` / 完全一致だけを扱う **最小 range parser を手書き**する
 *   (未対応形は `null` を返し fail-closed = loud RED)。
 *
 * - It never imports or executes `sharp`: this INV only inspects the static manifest /
 *   lockfile contract. Image-transform parity is the orthogonal sibling
 *   `INV-SHARP-PIPELINE-PARITY-001`.
 * - It adds **no dependency**. The `semver` package is declared in **no** package.json of
 *   this repo (it resolves to `node_modules/.pnpm/semver@7.7.4/...`, i.e. a hoisted
 *   transitive = phantom dependency); a test that guards *dependency declaration drift*
 *   depending on an undeclared phantom dep would be self-contradictory, and Registry
 *   F-S3B-M-02 requires "hand-written parse or an already-declared dep only". A minimal
 *   range parser covering `^` / `~` / `>=` / exact is therefore hand-written; unsupported
 *   forms return `null` and fail closed (loud RED).
 *
 * ## 非空虚性 / Non-vacuity
 *
 * 3 leg の判定は **repo root を引数に取る純関数** (`checkDeclaredRange` / `checkRootOverride` /
 * `checkLockfileSingleVersion`) に括り出してある。実 assert は既定 (= 実 repo root) で
 * 「違反 0」を要求し、`mutation controls` describe が **os.tmpdir() 上に書いた fixture tree**
 * に対して同一関数を呼び、宣言 `^0.34.5` / override 欠落 / override floor 不足 / lockfile 多版 /
 * lockfile 低版 がすべて違反として報告されることを CI 上で実証する
 * (実 package.json / lockfile は **一切変更しない**)。
 *
 * The three legs are pure functions taking the repo root, so the real asserts demand
 * "zero violations" at the default (real) root while the `mutation controls` describe
 * calls the *same* functions against a fixture tree written under `os.tmpdir()` and proves,
 * in CI, that a `^0.34.5` declaration / a missing override / a too-low override floor /
 * a multi-version lockfile / a low-version lockfile are all reported as violations —
 * without ever mutating the real package.json or lockfile.
 *
 * Registry: F-S3B-M-02 (= TDA-S3B-M-01) / IO Impl Decision `01a063c0` Unblock #2.
 * Regression domain: large-page.
 */

// INV-SHARP-DECLARED-RANGE-001

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** repo root。large-page → standing → regression → tests → mcp-server → apps → root (6 段) */
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..", "..");

/** patched floor。GHSA-f88m (sharp) 修正版の下限 / patched floor for the sharp advisory */
const PATCHED_FLOOR: SemVer = { major: 0, minor: 35, patch: 0 };

/** 宣言レンジが 1 つも admit してはならない脆弱系列の代表点 / must-not-admit probes */
const VULNERABLE_PROBES = ["0.34.0", "0.34.5", "0.34.9", "0.34.99"] as const;

// ---------------------------------------------------------------------------
// 最小 semver / range parser (手書き、依存 0)
// Minimal hand-written semver / range parser (zero dependencies)
// ---------------------------------------------------------------------------

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** `0.35.4` / `0.35.4-rc.1` → `{0,35,4}`。数値 3 組で始まらなければ `null` */
function parseVersion(raw: string): SemVer | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** a < b → 負 / a === b → 0 / a > b → 正 */
function compareVersion(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function formatVersion(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

interface RangeSpec {
  /** 下限 (inclusive) / inclusive floor */
  floor: SemVer;
  /** 上限 (exclusive)。`>=` は上限なし = `null` / exclusive ceiling; `null` for `>=` */
  ceiling: SemVer | null;
}

/**
 * `^x.y.z` / `~x.y.z` / `>=x.y.z` / `x.y.z` (完全一致) のみを解釈する。
 * それ以外 (`||` / スペース区切り複合 / `*` / `latest` / workspace 記法 等) は
 * **`null` を返して fail-closed** にする — 未知形を「たぶん安全」と黙認しない。
 *
 * Parses only `^x.y.z` / `~x.y.z` / `>=x.y.z` / exact `x.y.z`. Anything else
 * (`||`, space-joined compounds, `*`, `latest`, workspace protocols, …) returns
 * `null` and fails closed — an unknown form is never silently assumed safe.
 */
function parseSimpleRange(raw: string): RangeSpec | null {
  const range = raw.trim();
  const m = /^(\^|~|>=|=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!m) return null;

  const operator = m[1] ?? "=";
  const floor: SemVer = { major: Number(m[2]), minor: Number(m[3]), patch: Number(m[4]) };

  if (operator === ">=") return { floor, ceiling: null };
  if (operator === "=") {
    return { floor, ceiling: { major: floor.major, minor: floor.minor, patch: floor.patch + 1 } };
  }
  if (operator === "~") {
    return { floor, ceiling: { major: floor.major, minor: floor.minor + 1, patch: 0 } };
  }
  // caret: npm semver の 0.x 特例 — ^0.35.3 := >=0.35.3 <0.36.0 / ^0.0.z := その patch のみ
  if (floor.major > 0) return { floor, ceiling: { major: floor.major + 1, minor: 0, patch: 0 } };
  if (floor.minor > 0) return { floor, ceiling: { major: 0, minor: floor.minor + 1, patch: 0 } };
  return { floor, ceiling: { major: 0, minor: 0, patch: floor.patch + 1 } };
}

/** `spec` が `version` を admit するか / whether `spec` admits `version` */
function rangeAdmits(spec: RangeSpec, version: SemVer): boolean {
  if (compareVersion(version, spec.floor) < 0) return false;
  if (spec.ceiling === null) return true;
  return compareVersion(version, spec.ceiling) < 0;
}

// ---------------------------------------------------------------------------
// 3 leg の判定 (repo root 可変 = mutation control から再利用できる純関数)
// The three legs as pure functions over a repo root (reused by the controls)
// ---------------------------------------------------------------------------

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** leg (a): `apps/mcp-server/package.json` の sharp 宣言レンジ */
function checkDeclaredRange(repoRoot: string = REPO_ROOT): string[] {
  const violations: string[] = [];
  const pkg = readJson(join(repoRoot, "apps", "mcp-server", "package.json"));
  const deps = pkg.dependencies as Record<string, string> | undefined;
  const declared = deps?.sharp;

  if (typeof declared !== "string") {
    violations.push("apps/mcp-server/package.json: dependencies.sharp が宣言されていない");
    return violations;
  }

  const spec = parseSimpleRange(declared);
  if (spec === null) {
    violations.push(
      `apps/mcp-server/package.json: sharp レンジ "${declared}" は本 guard の対応形 (^ / ~ / >= / 完全一致) ではない`
    );
    return violations;
  }

  if (compareVersion(spec.floor, PATCHED_FLOOR) < 0) {
    violations.push(
      `apps/mcp-server/package.json: sharp レンジ "${declared}" の floor ${formatVersion(spec.floor)} が patched floor ${formatVersion(PATCHED_FLOOR)} 未満`
    );
  }

  for (const probe of VULNERABLE_PROBES) {
    const version = parseVersion(probe);
    if (version !== null && rangeAdmits(spec, version)) {
      violations.push(
        `apps/mcp-server/package.json: sharp レンジ "${declared}" が脆弱版 ${probe} を admit する`
      );
    }
  }

  return violations;
}

/** leg (b): root `package.json` の `pnpm.overrides.sharp` */
function checkRootOverride(repoRoot: string = REPO_ROOT): string[] {
  const violations: string[] = [];
  const rootPkg = readJson(join(repoRoot, "package.json"));
  const pnpmField = rootPkg.pnpm as { overrides?: Record<string, string> } | undefined;
  const override = pnpmField?.overrides?.sharp;

  if (typeof override !== "string") {
    violations.push("package.json: pnpm.overrides.sharp が宣言されていない");
    return violations;
  }

  const spec = parseSimpleRange(override);
  if (spec === null) {
    violations.push(
      `package.json: pnpm.overrides.sharp "${override}" は本 guard の対応形 (^ / ~ / >= / 完全一致) ではない`
    );
    return violations;
  }

  if (compareVersion(spec.floor, PATCHED_FLOOR) < 0) {
    violations.push(
      `package.json: pnpm.overrides.sharp "${override}" の floor ${formatVersion(spec.floor)} が patched floor ${formatVersion(PATCHED_FLOOR)} 未満`
    );
  }

  return violations;
}

/**
 * lockfile の `^  sharp@…` package 行から peer suffix を剥がして版を集める。
 * `  sharp@0.35.4:` / `  sharp@0.35.4(@types/node@22.19.6):` の双方に一致する。
 * `  @img/sharp-libvips-…@…:` は prefix が異なるため一致しない。
 */
function collectLockfileSharpVersions(repoRoot: string): string[] {
  const lock = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const versions = new Set<string>();

  for (const line of lock.split("\n")) {
    const m = /^ {2}sharp@(.+):$/.exec(line);
    if (m === null) continue;
    const peerIndex = m[1].indexOf("(");
    versions.add((peerIndex === -1 ? m[1] : m[1].slice(0, peerIndex)).trim());
  }

  return [...versions].sort();
}

/** leg (c): lockfile の sharp が単一版 かつ patched floor 以上 */
function checkLockfileSingleVersion(repoRoot: string = REPO_ROOT): string[] {
  const violations: string[] = [];
  const versions = collectLockfileSharpVersions(repoRoot);

  if (versions.length === 0) {
    violations.push("pnpm-lock.yaml: sharp@ の package 行が 1 本も無い (parse 契約の破綻)");
    return violations;
  }

  if (versions.length > 1) {
    violations.push(`pnpm-lock.yaml: sharp が複数版で解決されている: ${versions.join(", ")}`);
  }

  for (const raw of versions) {
    const version = parseVersion(raw);
    if (version === null) {
      violations.push(`pnpm-lock.yaml: sharp@${raw} の版を解釈できない`);
      continue;
    }
    if (compareVersion(version, PATCHED_FLOOR) < 0) {
      violations.push(
        `pnpm-lock.yaml: 解決版 sharp@${raw} が patched floor ${formatVersion(PATCHED_FLOOR)} 未満`
      );
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// mutation control 用の fixture tree (os.tmpdir、実 repo は不変)
// Fixture tree for the mutation controls (os.tmpdir; the real repo is untouched)
// ---------------------------------------------------------------------------

const fixtureRoots: string[] = [];

interface FixtureOptions {
  /** `apps/mcp-server/package.json` の宣言。`null` で dependencies.sharp を落とす */
  declared?: string | null;
  /** root override。`null` で `pnpm.overrides.sharp` を落とす */
  override?: string | null;
  /** lockfile に書く sharp 版 (peer suffix 付き行も 1 本ずつ生成する) */
  lockVersions?: string[];
}

function writeFixtureRoot(options: FixtureOptions = {}): string {
  const { declared = "^0.35.3", override = ">=0.35.0", lockVersions = ["0.35.4"] } = options;

  const root = mkdtempSync(join(tmpdir(), "inv-sharp-declared-range-"));
  fixtureRoots.push(root);

  mkdirSync(join(root, "apps", "mcp-server"), { recursive: true });

  const appDeps: Record<string, string> = { "node-fetch": "^3.3.2" };
  if (declared !== null) appDeps.sharp = declared;
  writeFileSync(
    join(root, "apps", "mcp-server", "package.json"),
    `${JSON.stringify({ name: "@reftrixmcp/mcp-server", dependencies: appDeps }, null, 2)}\n`
  );

  const overrides: Record<string, string> = { express: ">=5.2.0" };
  if (override !== null) overrides.sharp = override;
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "reftrix", pnpm: { overrides } }, null, 2)}\n`
  );

  const lockLines = [
    "packages:",
    "  @img/sharp-libvips-linux-x64@1.3.3:",
    ...lockVersions.map((v) => `  sharp@${v}:`),
    "snapshots:",
    ...lockVersions.map((v) => `  sharp@${v}(@types/node@22.19.6):`),
    "",
  ];
  writeFileSync(join(root, "pnpm-lock.yaml"), lockLines.join("\n"));

  return root;
}

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 実 assert / the real asserts
// ---------------------------------------------------------------------------

describe("INV-SHARP-DECLARED-RANGE-001 (large-page)", () => {
  describe("(a) apps/mcp-server の sharp 宣言レンジ / declared range", () => {
    it("floor が patched floor (>= 0.35.0) 以上で、0.34.x を 1 つも admit しない", () => {
      expect(checkDeclaredRange()).toEqual([]);
    });
  });

  describe("(b) root pnpm.overrides.sharp", () => {
    it("override が宣言され、floor が patched floor (>= 0.35.0) 以上である", () => {
      expect(checkRootOverride()).toEqual([]);
    });
  });

  describe("(c) pnpm-lock.yaml の sharp 解決版 / resolved version", () => {
    it("sharp@ package 行の版が 1 種類だけで、patched floor (>= 0.35.0) 以上である", () => {
      expect(checkLockfileSingleVersion()).toEqual([]);
    });

    it("lockfile から実際に sharp@ 行を検出できている (parse の空虚化 guard)", () => {
      // 0 本なら leg (c) は「違反 0」を空虚に満たしてしまうため、検出そのものを pin する
      expect(collectLockfileSharpVersions(REPO_ROOT).length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 非空虚性: 同一関数を tmp fixture tree に向けて RED を実証する
  // Non-vacuity: the same functions must go RED against a tmp fixture tree
  // -------------------------------------------------------------------------
  describe("mutation controls (非空虚性 / non-vacuity)", () => {
    it("positive control: 健全な fixture では 3 leg とも違反 0 (harness が常時 RED でない)", () => {
      const root = writeFixtureRoot();
      expect(checkDeclaredRange(root)).toEqual([]);
      expect(checkRootOverride(root)).toEqual([]);
      expect(checkLockfileSingleVersion(root)).toEqual([]);
    });

    it("(a) 宣言を ^0.34.5 に戻すと RED (floor 不足 + 0.34.x admit)", () => {
      const root = writeFixtureRoot({ declared: "^0.34.5" });
      const violations = checkDeclaredRange(root);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.join("\n")).toContain("^0.34.5");
      expect(violations.some((v) => v.includes("admit"))).toBe(true);
    });

    it("(a) 宣言 >=0.34.0 は floor を満たしても 0.34.x を admit するので RED", () => {
      const root = writeFixtureRoot({ declared: ">=0.34.0" });
      expect(checkDeclaredRange(root).some((v) => v.includes("admit"))).toBe(true);
    });

    it("(a) dependencies.sharp 自体の欠落も RED", () => {
      const root = writeFixtureRoot({ declared: null });
      expect(checkDeclaredRange(root).length).toBeGreaterThan(0);
    });

    it("(b) override 欠落は RED", () => {
      const root = writeFixtureRoot({ override: null });
      expect(checkRootOverride(root).length).toBeGreaterThan(0);
    });

    it("(b) override floor が 0.35.0 未満なら RED", () => {
      const root = writeFixtureRoot({ override: ">=0.34.0" });
      expect(checkRootOverride(root).length).toBeGreaterThan(0);
    });

    it("(c) lockfile に sharp が 2 版あると RED", () => {
      const root = writeFixtureRoot({ lockVersions: ["0.35.4", "0.36.1"] });
      const violations = checkLockfileSingleVersion(root);
      expect(violations.some((v) => v.includes("複数版"))).toBe(true);
    });

    it("(c) lockfile の解決版が 0.35.0 未満なら RED", () => {
      const root = writeFixtureRoot({ lockVersions: ["0.34.5"] });
      expect(checkLockfileSingleVersion(root).length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 手書き range parser 自体の pin (parser が壊れると 3 leg が静かに空虚化する)
  // Pins for the hand-written parser itself (a broken parser silently voids the legs)
  // -------------------------------------------------------------------------
  describe("hand-written range parser", () => {
    /** 判定を 1 行で書くための薄いヘルパー / thin helper: does `range` admit `version`? */
    function admits(range: string, version: string): boolean {
      const spec = parseSimpleRange(range);
      const parsed = parseVersion(version);
      if (spec === null || parsed === null) {
        throw new Error(`parser 契約の破綻: range="${range}" version="${version}"`);
      }
      return rangeAdmits(spec, parsed);
    }

    it("^0.35.3 は 0.35.4 を admit し 0.34.5 / 0.36.0 を admit しない (0.x caret 特例)", () => {
      expect(admits("^0.35.3", "0.35.4")).toBe(true);
      expect(admits("^0.35.3", "0.34.5")).toBe(false);
      expect(admits("^0.35.3", "0.36.0")).toBe(false);
    });

    it(">=0.35.0 は上限を持たない", () => {
      expect(admits(">=0.35.0", "1.0.0")).toBe(true);
      expect(admits(">=0.35.0", "0.34.9")).toBe(false);
    });

    it("未対応形 (複合 / ワイルドカード / workspace) は null で fail-closed", () => {
      for (const raw of ["*", "latest", ">=0.35.0 <1.0.0", "^0.35.3 || ^1.0.0", "workspace:*"]) {
        expect(parseSimpleRange(raw)).toBeNull();
      }
    });
  });
});
