// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-MCP-SERVER-DECLARED-RANGE-001 (H)
 *
 * root `pnpm.overrides` は **この monorepo の install にしか効かない**。公開 workspace package の
 * 宣言レンジが脆弱版を admit する形に戻っても、lockfile / install / override harness は GREEN の
 * まま **公開 tarball だけが脆弱レンジを出荷する**。この silent path を package 表で機械 gate にする
 * (`INV-SHARP-DECLARED-RANGE-001` と同じ理由。sharp 版は R2-SH が触るため本 file は別に置く)。
 * 対象は CO-R2-97 の 2 package: handlebars (GHSA-8r5x-fm3f-whwj / GHSA-p8wg-vrv2-v86f) と
 * `@modelcontextprotocol/sdk` (GHSA-6qxp-vccf-f47h)。
 *
 * Root overrides only affect installs inside this monorepo. If a published workspace package's
 * declared range regressed to admit a vulnerable version, the lockfile, the install and the
 * override harness would all stay GREEN while the published tarball alone ships the vulnerable
 * range. This table-driven test turns that path into a machine gate for the two CO-R2-97
 * packages (handlebars and `@modelcontextprotocol/sdk`).
 *
 * | leg  | 対象 / target                                             | 契約 / contract                                                   |
 * | ---- | --------------------------------------------------------- | ----------------------------------------------------------------- |
 * | (a)  | 公開 5 manifest の `dependencies` / `optionalDependencies` | 出現した宣言の floor >= patched floor かつ `vulnerableProbes` を  |
 * |      | / `peerDependencies`                                      | 1 つも admit しない。`apps/mcp-server` `dependencies` に無ければ RED |
 * | (a') | (a) で出現した各宣言                                      | 宣言形は `^` / `~` のみ (上限のない `>=` 等は RED)                |
 * | (b)  | root `package.json` `pnpm.overrides`                      | 宣言が存在し floor >= patched floor (`parseRange`、bounded 形可)  |
 * | (c)  | `pnpm-lock.yaml`                                          | `^  '?<name>@` key 行の版が 1 種類で、patched floor 以上          |
 *
 * 公開 5 manifest = `@reftrixmcp/{mcp-server,core,ml,database,webdesign-core}` に対応する
 * `apps/mcp-server` / `packages/{core,ml,database,webdesign-core}`。他の 4 manifest に 2 package
 * が現れた場合のみ floor 判定する (現状は非出現 = GREEN)。manifest 自体が無ければ fail-closed。
 * The five published manifests are scanned; the other four are judged only if a row appears.
 *
 * leg (a) は公開 manifest の宣言形として `parseSimpleRange`、leg (b) は `parseRange` を使う
 * (sharp precedent と同じ非対称、R2-SH E-135)。版の読みは strict な `parseVersion`
 * (prerelease は null = fail-closed)。新規依存なし (`semver` package を使わない)。
 * Leg (a) uses `parseSimpleRange` for the published declared form and leg (b) `parseRange`
 * (same asymmetry as the sharp precedent); versions use the strict `parseVersion`.
 *
 * 非空虚性 / Non-vacuity: 全 leg は (repo root, 行) の純関数。mutation control は同一関数を
 * `os.tmpdir()` の fixture に向ける (実 repo は不変)。fixture の override には既存 sibling key
 * `@modelcontextprotocol/sdk>ajv` を含め、key 混同が無いことを pin する。実 lockfile から全行の
 * key 行を検出できることも pin する (空虚 GREEN の排除)。
 * The legs are pure functions of (repo root, row); the controls point them at a tmp fixture that
 * keeps the sibling override key, and the real lockfile must yield key lines for every row.
 *
 * Regression domain: large-page.
 */

// INV-MCP-SERVER-DECLARED-RANGE-001

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyPatch,
  collectLockVersions,
  compareVersion,
  formatVersion,
  lockKeyLine,
  parseRange,
  parseSimpleRange,
  parseVersion,
  rangeAdmits,
  readJson,
  readLock,
  REPO_ROOT,
} from "../_shared/semver-lockfile";

interface DeclaredRow {
  /** package 名 / package name */
  name: string;
  /** 最初の修正版 / first patched version */
  patchedFloor: string;
  /** 宣言が 1 つも admit してはならない版 (advisory range の下端・base 版・上端) */
  vulnerableProbes: readonly [lower: string, middle: string, upper: string];
}

/**
 * CO-R2-97: GHSA-8r5x-fm3f-whwj / GHSA-p8wg-vrv2-v86f (handlebars <= 4.7.9) /
 * GHSA-6qxp-vccf-f47h (@modelcontextprotocol/sdk < 1.31.0)。
 * GHSA-22jm-h49p-29qw / GHSA-46jr-4wx8-v453 (@modelcontextprotocol/sdk < 1.32.0、最初の修正版は 1.32.0。floor 1.32.1 はより厳しい側の選択)。
 * First patched version is 1.32.0; the 1.32.1 floor is the stricter choice.
 */
const HANDLEBARS_ROW: DeclaredRow = {
  name: "handlebars",
  patchedFloor: "4.7.10",
  vulnerableProbes: ["4.0.0", "4.7.8", "4.7.9"],
};
const SDK_ROW: DeclaredRow = {
  name: "@modelcontextprotocol/sdk",
  patchedFloor: "1.32.1",
  vulnerableProbes: ["1.12.0", "1.30.1", "1.31.0"],
};
const DECLARED_TABLE: readonly DeclaredRow[] = [HANDLEBARS_ROW, SDK_ROW];

/** 公開 workspace manifest (repo root 相対) / published workspace manifests */
const PUBLISHED_MANIFESTS: readonly string[] = [
  "apps/mcp-server",
  "packages/core",
  "packages/ml",
  "packages/database",
  "packages/webdesign-core",
];
/** consumer の install に効く依存欄 / dependency fields that reach a consumer install */
const DEPENDENCY_FIELDS: readonly string[] = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
/** 2 package の宣言が必須の場所 / the location that must declare both packages */
const REQUIRED_DECLARATION = "apps/mcp-server dependencies";

interface Declaration {
  /** `<manifest dir> <field>` */
  where: string;
  range: string;
}

function floorOf(row: DeclaredRow) {
  const floor = parseVersion(row.patchedFloor);
  if (floor === null) throw new Error(`table 契約の破綻: ${row.name} ${row.patchedFloor}`);
  return floor;
}

/** 公開 manifest を走査し `row.name` の宣言を集める。manifest が無ければ violation */
function collectDeclarations(
  row: DeclaredRow,
  repoRoot: string
): { declarations: Declaration[]; missingManifests: string[] } {
  const declarations: Declaration[] = [];
  const missingManifests: string[] = [];
  for (const dir of PUBLISHED_MANIFESTS) {
    const path = join(repoRoot, dir, "package.json");
    if (!existsSync(path)) {
      missingManifests.push(`(a) ${row.name}: ${dir}/package.json が無い (fail-closed)`);
      continue;
    }
    const pkg = readJson(path);
    for (const field of DEPENDENCY_FIELDS) {
      const range = (pkg[field] as Record<string, string> | undefined)?.[row.name];
      if (typeof range === "string") declarations.push({ where: `${dir} ${field}`, range });
    }
  }
  return { declarations, missingManifests };
}

/** leg (a): 出現した宣言レンジの floor と probe admit / declared floor and probe admission */
function checkDeclaredRange(row: DeclaredRow, repoRoot: string = REPO_ROOT): string[] {
  const { declarations, missingManifests } = collectDeclarations(row, repoRoot);
  const violations = [...missingManifests];
  if (!declarations.some((d) => d.where === REQUIRED_DECLARATION)) {
    violations.push(`(a) ${row.name}: ${REQUIRED_DECLARATION} に宣言が無い`);
  }
  for (const { where, range } of declarations) {
    const spec = parseSimpleRange(range);
    if (spec === null) {
      violations.push(
        `(a) ${row.name} [${where}]: "${range}" は対応形 (^ / ~ / >= / 完全一致) ではない`
      );
      continue;
    }
    if (compareVersion(spec.floor, floorOf(row)) < 0) {
      violations.push(
        `(a) ${row.name} [${where}]: "${range}" の floor ${formatVersion(spec.floor)} が ${row.patchedFloor} 未満`
      );
    }
    for (const probe of row.vulnerableProbes) {
      const version = parseVersion(probe);
      if (version !== null && rangeAdmits(spec, version)) {
        violations.push(`(a) ${row.name} [${where}]: "${range}" が脆弱版 ${probe} を admit する`);
      }
    }
  }
  return violations;
}

/** leg (a'): 宣言形は `^` / `~` のみ (上限の無い形を禁止) / caret or tilde only */
function checkDeclaredForm(row: DeclaredRow, repoRoot: string = REPO_ROOT): string[] {
  return collectDeclarations(row, repoRoot)
    .declarations.filter(({ range }) => !/^[\^~]/.test(range.trim()))
    .map(({ where, range }) => `(a') ${row.name} [${where}]: "${range}" は ^ / ~ の形ではない`);
}

/** leg (b): root `pnpm.overrides` / root override */
function checkRootOverride(row: DeclaredRow, repoRoot: string = REPO_ROOT): string[] {
  const rootPkg = readJson(join(repoRoot, "package.json"));
  const override = (rootPkg.pnpm as { overrides?: Record<string, string> } | undefined)
    ?.overrides?.[row.name];
  if (typeof override !== "string") return [`(b) ${row.name}: overrides に宣言が無い`];
  const spec = parseRange(override);
  if (spec === null) return [`(b) ${row.name}: "${override}" は対応形ではない`];
  if (compareVersion(spec.floor, floorOf(row)) < 0) {
    return [
      `(b) ${row.name}: "${override}" の floor ${formatVersion(spec.floor)} が ${row.patchedFloor} 未満`,
    ];
  }
  return [];
}

/** leg (c): lockfile の解決版が単一かつ patched floor 以上 / single version at or above floor */
function checkLockfile(row: DeclaredRow, repoRoot: string = REPO_ROOT): string[] {
  const versions = [...new Set(collectLockVersions(readLock(repoRoot), row.name))].sort();
  if (versions.length === 0) return [`(c) ${row.name}: lockfile に key 行が無い`];
  const violations: string[] = [];
  if (versions.length > 1) violations.push(`(c) ${row.name}: 複数版 ${versions.join(", ")}`);
  for (const raw of versions) {
    const version = parseVersion(raw);
    if (version === null) violations.push(`(c) ${row.name}@${raw}: 版を解釈できない`);
    else if (compareVersion(version, floorOf(row)) < 0) {
      violations.push(`(c) ${row.name}@${raw}: patched floor ${row.patchedFloor} 未満`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// fixture tree (os.tmpdir、実 repo は不変) / fixture tree (the real repo is untouched)
// ---------------------------------------------------------------------------

const fixtureRoots: string[] = [];

interface FixtureOptions {
  /** name → `apps/mcp-server` の宣言 (`null` で欠落) / declared range (`null` drops it) */
  declared?: Record<string, string | null>;
  /** 他の公開 manifest の `dependencies` / extra dependencies of another published manifest */
  otherManifest?: { dir: string; dependencies: Record<string, string> };
  /** name → override (`null` で欠落) / override (`null` drops it) */
  overrides?: Record<string, string | null>;
  /** name → lockfile の版 / lockfile versions */
  lockVersions?: Record<string, string[]>;
}

const HEALTHY_DECLARED: Record<string, string> = {
  handlebars: "^4.7.10",
  "@modelcontextprotocol/sdk": "^1.32.1",
};
const SIBLING_OVERRIDE_KEY = "@modelcontextprotocol/sdk>ajv";
const HEALTHY_OVERRIDES: Record<string, string> = {
  handlebars: ">=4.7.10 <5",
  "@modelcontextprotocol/sdk": ">=1.32.1 <1.33",
  [SIBLING_OVERRIDE_KEY]: ">=8.18.0",
};
const HEALTHY_LOCK: Record<string, string[]> = {
  handlebars: ["4.7.10"],
  "@modelcontextprotocol/sdk": ["1.32.1"],
};

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFixtureRoot(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "inv-mcp-server-declared-range-"));
  fixtureRoots.push(root);
  for (const dir of PUBLISHED_MANIFESTS) {
    mkdirSync(join(root, dir), { recursive: true });
    let dependencies: Record<string, string> = {};
    if (dir === "apps/mcp-server") dependencies = applyPatch(HEALTHY_DECLARED, options.declared);
    else if (options.otherManifest?.dir === dir) dependencies = options.otherManifest.dependencies;
    writeJson(join(root, dir, "package.json"), { name: `@reftrixmcp/${dir}`, dependencies });
  }
  writeJson(join(root, "package.json"), {
    name: "reftrix",
    pnpm: { overrides: applyPatch(HEALTHY_OVERRIDES, options.overrides) },
  });
  const lock = { ...HEALTHY_LOCK, ...options.lockVersions };
  const lines = ["packages:"];
  for (const [name, versions] of Object.entries(lock)) {
    for (const v of versions) lines.push(lockKeyLine(name, v));
  }
  lines.push("snapshots:", "");
  writeFileSync(join(root, "pnpm-lock.yaml"), lines.join("\n"));
  return root;
}

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

const allLegs = (row: DeclaredRow, root: string): string[] => [
  ...checkDeclaredRange(row, root),
  ...checkDeclaredForm(row, root),
  ...checkRootOverride(row, root),
  ...checkLockfile(row, root),
];

// ---------------------------------------------------------------------------
// 実 assert / the real asserts
// ---------------------------------------------------------------------------

describe("INV-MCP-SERVER-DECLARED-RANGE-001 (large-page)", () => {
  it("(a) 公開 manifest の宣言レンジが patched floor 以上で脆弱版を admit しない", () => {
    expect(DECLARED_TABLE.flatMap((row) => checkDeclaredRange(row))).toEqual([]);
  });

  it("(a') 公開 manifest の宣言形が ^ / ~ のみ", () => {
    expect(DECLARED_TABLE.flatMap((row) => checkDeclaredForm(row))).toEqual([]);
  });

  it("(b) root pnpm.overrides が宣言され floor が patched floor 以上", () => {
    expect(DECLARED_TABLE.flatMap((row) => checkRootOverride(row))).toEqual([]);
  });

  it("(c) lockfile の解決版が単一かつ patched floor 以上", () => {
    expect(DECLARED_TABLE.flatMap((row) => checkLockfile(row))).toEqual([]);
  });

  it("(c) 空虚化 guard: 実 lockfile から全行の key 行を検出できる", () => {
    for (const row of DECLARED_TABLE) {
      expect(collectLockVersions(readLock(REPO_ROOT), row.name).length).toBeGreaterThan(0);
    }
  });

  describe("mutation controls (非空虚性 / non-vacuity)", () => {
    it("positive control: 健全な fixture では全行・全 leg 違反 0", () => {
      const root = writeFixtureRoot();
      expect(DECLARED_TABLE.flatMap((row) => allLegs(row, root))).toEqual([]);
    });

    describe.each(DECLARED_TABLE)("$name", (row) => {
      const base = row.vulnerableProbes[2];
      it("(a) 宣言を脆弱版の caret に戻すと RED", () => {
        const root = writeFixtureRoot({ declared: { [row.name]: `^${base}` } });
        expect(checkDeclaredRange(row, root).some((v) => v.includes("admit"))).toBe(true);
      });
      it("(a) >=<probe> は floor 判定に関わらず probe を admit するので RED", () => {
        const root = writeFixtureRoot({ declared: { [row.name]: `>=${row.vulnerableProbes[0]}` } });
        expect(checkDeclaredRange(row, root).some((v) => v.includes("admit"))).toBe(true);
      });
      it("(a) 宣言の欠落は RED", () => {
        const root = writeFixtureRoot({ declared: { [row.name]: null } });
        expect(checkDeclaredRange(row, root)).toEqual([
          `(a) ${row.name}: ${REQUIRED_DECLARATION} に宣言が無い`,
        ]);
      });
      it("(b) override の欠落は RED", () => {
        const root = writeFixtureRoot({ overrides: { [row.name]: null } });
        expect(checkRootOverride(row, root)).toEqual([`(b) ${row.name}: overrides に宣言が無い`]);
      });
      it("(b) bounded override の floor 不足は floor 判定で RED (対応形として解釈される)", () => {
        const root = writeFixtureRoot({ overrides: { [row.name]: `>=${base} <99` } });
        const v = checkRootOverride(row, root);
        expect(v.some((s) => s.includes(`floor ${base}`))).toBe(true);
        expect(v.some((s) => s.includes("対応形"))).toBe(false);
      });
      it("(c) lockfile 2 版は RED", () => {
        const root = writeFixtureRoot({ lockVersions: { [row.name]: [base, row.patchedFloor] } });
        expect(checkLockfile(row, root).some((v) => v.includes("複数版"))).toBe(true);
      });
      it("(c) 解決版が floor 未満なら RED", () => {
        const root = writeFixtureRoot({ lockVersions: { [row.name]: [base] } });
        expect(checkLockfile(row, root).some((v) => v.includes("未満"))).toBe(true);
      });
    });

    it("(a) 走査拡張: 他の公開 package (packages/core) に ^4.7.9 を足すと RED", () => {
      const root = writeFixtureRoot({
        otherManifest: { dir: "packages/core", dependencies: { handlebars: "^4.7.9" } },
      });
      const v = checkDeclaredRange(HANDLEBARS_ROW, root);
      expect(v.some((s) => s.includes("[packages/core dependencies]") && s.includes("admit"))).toBe(
        true
      );
    });

    it("(a') 宣言を上限のない >=4.7.10 にすると RED (leg (a) は GREEN のまま)", () => {
      const root = writeFixtureRoot({ declared: { handlebars: ">=4.7.10" } });
      expect(checkDeclaredRange(HANDLEBARS_ROW, root)).toEqual([]);
      expect(checkDeclaredForm(HANDLEBARS_ROW, root)).toEqual([
        `(a') handlebars [${REQUIRED_DECLARATION}]: ">=4.7.10" は ^ / ~ の形ではない`,
      ]);
    });

    it("(b) sibling key 存在下で @modelcontextprotocol/sdk の override 欠落は RED", () => {
      const root = writeFixtureRoot({ overrides: { [SDK_ROW.name]: null } });
      const overrides = (
        readJson(join(root, "package.json")).pnpm as {
          overrides: Record<string, string>;
        }
      ).overrides;
      expect(overrides[SIBLING_OVERRIDE_KEY]).toBe(">=8.18.0");
      expect(checkRootOverride(SDK_ROW, root)).toEqual([
        `(b) ${SDK_ROW.name}: overrides に宣言が無い`,
      ]);
    });
  });

  describe("parser pin", () => {
    it("parseSimpleRange: ^4.7.10 / ^1.32.1 は 4.7.9 / 1.32.0 を admit せず次 major を admit しない", () => {
      const hb = parseSimpleRange("^4.7.10");
      const sdk = parseSimpleRange("^1.32.1");
      expect(hb && rangeAdmits(hb, { major: 4, minor: 7, patch: 9 })).toBe(false);
      expect(hb && rangeAdmits(hb, { major: 5, minor: 0, patch: 0 })).toBe(false);
      expect(sdk && rangeAdmits(sdk, { major: 1, minor: 32, patch: 0 })).toBe(false);
      expect(sdk && rangeAdmits(sdk, { major: 2, minor: 0, patch: 0 })).toBe(false);
    });
    it("parseRange: >=1.32.1 <1.33 は floor 1.32.1 / ceiling 1.33.0", () => {
      expect(parseRange(">=1.32.1 <1.33")).toEqual({
        floor: { major: 1, minor: 32, patch: 1 },
        ceiling: { major: 1, minor: 33, patch: 0 },
      });
    });
  });
});
