// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SEC-OVERRIDE-BOUND-001 (H)
 *
 * security-deps R2 の override 契約表 (plan v3.1 §3.1) の機械 gate。本ラウンドで新設・変更する
 * override は全エントリに上限 (cap) を付す契約である (上限なしの `@hono/node-server: ">=1.19.14"`
 * が silent に major 2.x へ到達した前例)。契約エントリが manifest に実在し、上限を持ち、floor が
 * 契約 floor 以上で、lockfile の解決版が単一かつ契約 range 内であることを pin する。
 *
 * Machine gate for the R2 override contract table (plan v3.1 §3.1): every entry exists in the
 * manifest, is capped, keeps its floor at or above the contract floor, and resolves in the
 * lockfile to a single version inside the contract range.
 *
 * | leg   | 契約 / contract (plan v3.1 §7.1 が単一正典 / single source)                          |
 * | ----- | ------------------------------------------------------------------------------------ |
 * | (a)   | manifest の range が上限を持ち、契約上限を超えない / capped, cap not raised          |
 * | (a')  | lockfile 側の定義 (`overrides:` 節 / root importer の `specifier`) === manifest      |
 * | (b)   | manifest の floor が契約 floor 以上 / floor >= contract floor                        |
 * | (c)   | lockfile の解決版が単一で契約 range 内 / single resolved version inside the range    |
 * | (c')  | peer suffix `(<name>@X)` の版集合 ⊆ key 行の版集合 / suffix versions ⊆ key versions  |
 * | (d)   | `vitest` / `@vitest/mocker` / `@vitest/coverage-v8` の解決版が同一 / one version     |
 * | (e)   | `@cyclonedx/cdxgen` の解決版 < 12.8.3 (12.8.3+ は node >=22、CO-SECDEPS-10)          |
 * | (f-1) | 契約表の全行が実 manifest に実在する / every contract row exists in the manifest     |
 * | (f-2) | 各パッケージの lockfile 行を 1 本以上検出する / >= 1 lockfile key line per package   |
 * | (g)   | lockfile parser = `^  '?<escaped-name>@([^':(]+)` (plan v3.1 §6.1 手順 3 と同一の式) |
 *
 * 行と leg の着地: R2-BE-a = toolchain 4 行 + leg (a)(b)(c)(f)(g) + 汎用 control (i)〜(vi)。
 * R2-BE-b = vitest 系 3 行 + cdxgen 行 + leg (d)(e) + defense-in-depth leg (a')(c') と prerelease
 * fail-closed (impl registry be-a-v0 BEA-05 / BEA-12)。R2-C = server runtime 4 行 (`hono` /
 * `@hono/node-server` / `qs` / `body-parser`) + control (ii) 固有 instance 2 件 (`@hono/node-server`
 * `1.19.14`、E-46 の `hono` `4.13.5`) + CO-R2-39 非空虚 guard (impl registry c-v0 E-43 / addendum
 * registry E-46)。R2-U = transitive 5 行 (`undici` / `brace-expansion` / `@grpc/grpc-js` /
 * `ip-address` / `fast-uri`、addendum v1 §2.1 / E-50) + control (ii) 固有 instance `undici` `7.29.0`。
 * R2-OF = override floor 3 行 (`proxy-addr` / `compression` / `source-map-js`、E-96) + control (ii)
 * 固有 instance 3 件 (各 package の base 版 `2.0.7` / `1.8.1` / `1.2.1`)。
 * CO-R2-97 = override floor 2 行 (`handlebars` / `@modelcontextprotocol/sdk`) + control (ii) 固有
 * instance 2 件 (advisory range 内の `4.7.9` / `1.30.1`)。
 * R2-SH = override floor 1 行 (`sharp`、GHSA-wq5f-xc86-pv6w の修正版 0.35.5 + minor cap、E-124) +
 * control (ii) 固有 instance `sharp` `0.35.4`。
 * R2-D = override 行 1 (`dompurify`、GHSA-6688 / p98j の修正版 3.4.16 + major cap) + control (ii) 固有
 * instance `dompurify` `3.4.13`。読み出し元は行ごとの `source` (`pnpm.overrides`、cdxgen のみ
 * `devDependencies`、UB2-2)。
 * Rows/legs: R2-BE-a = toolchain rows + legs (a)(b)(c)(f)(g); R2-BE-b = vitest/cdxgen rows +
 * legs (d)(e) + defense-in-depth legs (a')(c') + prerelease fail-closed; R2-C = server runtime
 * rows + control (ii) specific instances (`@hono/node-server` 1.19.14, `hono` 4.13.5 per E-46) +
 * CO-R2-39 non-vacuity guard; R2-U = 5 transitive rows + control (ii) instance `undici` 7.29.0;
 * R2-OF = 3 override-floor rows (`proxy-addr` / `compression` / `source-map-js`, E-96) + control (ii)
 * instances at their base versions 2.0.7 / 1.8.1 / 1.2.1; CO-R2-97 = 2 override-floor rows
 * (`handlebars` / `@modelcontextprotocol/sdk`) + control (ii) instances 4.7.9 / 1.30.1 (inside the
 * advisory ranges); R2-SH = 1 override-floor row (`sharp`,
 * first patched version 0.35.5 for GHSA-wq5f-xc86-pv6w plus a minor cap, E-124) + control (ii)
 * instance `sharp` 0.35.4; R2-D appends rows.
 *
 * leg (a'): cap は lockfile の `overrides:` 節にも写る (pnpm は install 時に manifest から書く)。
 * lockfile 側だけ緩められると (a)(b) は root `package.json` しか読まないため leg (c) まで検知
 * しない → lockfile 側の文字列も manifest と完全一致を要求する (devDependencies 行は root
 * importer `.` の `specifier`)。leg (c'): leg (c) は key 行だけを走査するため、peer suffix が
 * key 行に無い版を指す lockfile (手編集・破損) を別途検知する。
 * Leg (a') pins the lockfile-side copy of each definition; leg (c') checks peer suffixes
 * only point at versions that exist as key lines.
 *
 * leg (g): pnpm は scoped key を single-quote し (`'@babel/core@7.29.7':`)、unscoped は quote
 * しない。依存 0 の package は `name@ver: {}`、peer を持つ instance は `name@ver(peer@x)` になる。
 * 捕捉クラス `[^':(]+` はこれらを 1 規則で吸収する (unscoped 専用の precedent parser では scoped
 * が検出 0 = 空虚 GREEN)。`@babel/core` の auto-peer instance (`next@…(@babel/core@<v>)`) は
 * 既存 snapshot key を指すため、key 行が単一版なら peer instance も単一版である (§6.2 #4)。
 * The capture class absorbs quoted-scoped / `: {}` / peer-suffix forms in one rule; a peer
 * suffix names an existing key, so a single key-line version implies a single peer instance.
 *
 * 非空虚性 / Non-vacuity: 全 leg は (repo root, 契約表) の純関数。mutation control は同一関数を
 * `os.tmpdir()` の fixture に向ける (実 repo は不変)。fixture lockfile は R2-BE-a 着地後の解決版で
 * 構成し、mutation は override 文字列のみ (Registry V4 §8.5 H-1)。極性は §8 ※4:
 * (i) 上限除去 / (ii) `@babel/core` floor を 7.28.0 へ (汎用形) / (iii) lockfile 行 0 本 /
 * (iv) 多版 / (vi) 実在しない行を契約表に追加 = RED、(v) 3 形の正規化 (positive) = GREEN。
 * control (ii) の固有 instance は `it.each` の表 (name / mutated range / floor) で汎用形と並置し、
 * 各 instance で leg (b) だけが violation (他 leg = `[]`) であることを assert する (addendum v1 §5.1
 * (5) / E-65 (c)): `@hono/node-server` `1.19.14` (GHSA-frvp-7c67-39w9 の `< 1.19.15` range 内 = plan
 * v3.1 §3.1「floor `1.19.14` はどの場合も禁止」、R2-C) / `hono` `4.13.5` (GHSA-hxh3-vqpv-xpqv の
 * `< 4.13.7` range 内、R2-C E-46) / `undici` `7.29.0` (GHSA-w293-vg96-wgc3 ほか 10 件の `< 7.29.1`
 * range 内、R2-U E-50) / `proxy-addr` `2.0.7` (GHSA-jqcg-44mw-7w3h の `< 2.0.8` range 内、R2-OF) /
 * `compression` `1.8.1` (GHSA-vc2v-76pw-4v95 の `< 1.8.2` range 内、R2-OF) / `source-map-js` `1.2.1`
 * (GHSA-68fv-2mgg-jv7q の `< 1.2.2` range 内、R2-OF)。
 * CO-R2-97 の固有 instance: `handlebars` `4.7.9` (GHSA-8r5x-fm3f-whwj / GHSA-p8wg-vrv2-v86f の
 * `<= 4.7.9` range 内) / `@modelcontextprotocol/sdk` `1.30.1` (GHSA-6qxp-vccf-f47h の `< 1.31.0`
 * range 内)。
 * R2-SH の固有 instance: `sharp` `0.35.4` (GHSA-wq5f-xc86-pv6w の `< 0.35.5` range 内)。
 *
 * 新規依存なし: `semver` は未宣言 (phantom) ゆえ `>=` / `<` / `^` / `~` / 完全一致だけの最小
 * range parser を手書きし、未対応形は `null` で fail-closed。prerelease / build metadata 付きの版
 * (`8.0.0-rc.5` / `1.0.0+x`) も `null` = fail-closed (leg (c) が「版を解釈できない」で RED)。宣言 range (npm consumer 側) は pin
 * しない (override は monorepo の install にしか効かない。宣言は R2-D の宣言 INV が担う)。
 * No new dependency (hand-written parser, unknown forms fail closed); declared ranges are not
 * pinned here (overrides only affect installs inside this monorepo).
 *
 * helper (semver / range parser、lockfile reader、fixture builder) は非 test module
 * `../_shared/semver-lockfile` に置く (CO-R2-36、挙動は抽出前と同一)。leg (a) / (b) の前段は
 * `readParsedManifestRange` で共通化。
 * Helpers live in the non-test module `../_shared/semver-lockfile` (CO-R2-36, unchanged
 * behaviour); legs (a) / (b) share the `readParsedManifestRange` preamble.
 *
 * Plan: security-deps-remediation-r2-plan-v3-1.md §3.1 / §6.2 #4 / §7.1 / §8 ※4.
 * Registry: r2 finding registry v4 §2 (harness = R2-BE) / impl registry be-v0 §8 (R2-BE-a).
 * Regression domain: large-page.
 */

// INV-SEC-OVERRIDE-BOUND-001

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type Patch,
  type RangeSpec,
  type SemVer,
  applyPatch,
  collectLockVersions,
  collectPeerSuffixVersions,
  compareVersion,
  formatVersion,
  lockKeyLine,
  parseRange,
  parseVersion,
  rangeAdmits,
  readJson,
  readLock,
  readLockDefinition,
  REPO_ROOT,
  yamlKey,
  yamlValue,
} from "../_shared/semver-lockfile";

// ---------------------------------------------------------------------------
// 契約表 / Contract table (plan v3.1 §3.1 の文字列から導出。本表以外で再定義しない)
// ---------------------------------------------------------------------------

type ContractSource = "overrides" | "devDependencies";

interface ContractRow {
  /** package 名 (override key) / package name */
  name: string;
  /** 読み出し元 (UB2-2) / read source */
  source: ContractSource;
  /** plan v3.1 §3.1 の契約文字列 (verbatim) / verbatim contract string */
  contract: string;
}

/**
 * R2-BE-a の行 (toolchain 4) + R2-BE-b の行 (vitest 系 3 + cdxgen 宣言 1) + R2-C の行 (server
 * runtime 4) + R2-U の行 (transitive 5) + R2-OF の行 (override floor 3) + CO-R2-97 の行 (override
 * floor 2) + R2-SH の行 (override floor 1) + R2-D の行 (dompurify 1)。
 * Rows from R2-BE-a (toolchain 4) + R2-BE-b (vitest 3 + cdxgen declaration) + R2-C (server
 * runtime 4) + R2-U (transitive 5) + R2-OF (override floors 3) + CO-R2-97 (override floors 2) +
 * R2-SH (override floor 1) + R2-D (dompurify 1).
 */
const CONTRACT_TABLE: readonly ContractRow[] = [
  { name: "browserslist", source: "overrides", contract: ">=4.28.7 <5" },
  { name: "baseline-browser-mapping", source: "overrides", contract: ">=2.11.0 <3" },
  { name: "@humanfs/node", source: "overrides", contract: ">=0.16.8 <0.17" },
  { name: "@babel/core", source: "overrides", contract: ">=7.29.6 <8" },
  { name: "vitest", source: "overrides", contract: ">=4.1.11 <5" },
  { name: "@vitest/mocker", source: "overrides", contract: ">=4.1.11 <5" },
  { name: "@vitest/coverage-v8", source: "overrides", contract: ">=4.1.11 <5" },
  { name: "@cyclonedx/cdxgen", source: "devDependencies", contract: ">=12.4.3 <12.8.3" },
  // hono floor 4.13.7 (addendum registry E-46, supersedes c-v0 E-43 (1) ">=4.13.5 <5"):
  // GHSA-hxh3-vqpv-xpqv affects hono < 4.13.7.
  { name: "hono", source: "overrides", contract: ">=4.13.7 <5" },
  { name: "@hono/node-server", source: "overrides", contract: ">=2.0.10 <3" },
  { name: "qs", source: "overrides", contract: ">=6.16.0 <7" },
  { name: "body-parser", source: "overrides", contract: ">=2.3.0 <3" },
  // R2-U (addendum v1 §2.1 verbatim / E-50): floors at the first patched version of the 2026-09-28〜30
  // advisories; brace-expansion / @grpc/grpc-js / ip-address gain a cap.
  { name: "undici", source: "overrides", contract: ">=7.29.1 <8" },
  { name: "brace-expansion", source: "overrides", contract: ">=5.0.12 <6" },
  { name: "@grpc/grpc-js", source: "overrides", contract: ">=1.14.5 <2" },
  { name: "ip-address", source: "overrides", contract: ">=10.7.1 <11" },
  { name: "fast-uri", source: "overrides", contract: ">=3.1.8 <4" },
  // R2-OF (E-96): floors at the first patched version.
  // GHSA-jqcg-44mw-7w3h (proxy-addr < 2.0.8) / GHSA-vc2v-76pw-4v95 (compression < 1.8.2) /
  // GHSA-68fv-2mgg-jv7q (source-map-js < 1.2.2).
  { name: "proxy-addr", source: "overrides", contract: ">=2.0.8 <3" },
  { name: "compression", source: "overrides", contract: ">=1.8.2 <2" },
  { name: "source-map-js", source: "overrides", contract: ">=1.2.2 <2" },
  // CO-R2-97: floors at the first patched version.
  // GHSA-8r5x-fm3f-whwj / GHSA-p8wg-vrv2-v86f (handlebars <= 4.7.9) /
  // GHSA-6qxp-vccf-f47h (@modelcontextprotocol/sdk < 1.31.0).
  { name: "handlebars", source: "overrides", contract: ">=4.7.10 <5" },
  { name: "@modelcontextprotocol/sdk", source: "overrides", contract: ">=1.31.0 <1.32" },
  // R2-SH (E-124): floor at the first patched version and a minor cap (0.x).
  // GHSA-wq5f-xc86-pv6w (sharp < 0.35.5, bundled librsvg).
  { name: "sharp", source: "overrides", contract: ">=0.35.5 <0.36" },
  // R2-D (E-47): floor at the first patched version and a major cap.
  // GHSA-6688-9rhm-gjv2 / GHSA-p98j-92pf-mc4p (dompurify <= 3.4.15 range).
  { name: "dompurify", source: "overrides", contract: ">=3.4.16 <4" },
];

/** leg (d): 解決版の一致を要求する組 (`vitest` exact peer との版一致、plan v3.1 §5.5) */
const VITEST_FAMILY: readonly string[] = ["vitest", "@vitest/mocker", "@vitest/coverage-v8"];

/** leg (e): `@cyclonedx/cdxgen` の解決版の上限 (12.8.3+ は Node 20 で install 不可、plan v3.1 §3.2) */
const CDXGEN_NAME = "@cyclonedx/cdxgen";
const CDXGEN_NODE20_CEILING: SemVer = { major: 12, minor: 8, patch: 3 };

function contractSpec(row: ContractRow): RangeSpec {
  const spec = parseRange(row.contract);
  if (spec === null || spec.ceiling === null) {
    // 契約表自体の破綻は harness のバグ = 即 throw (空虚な GREEN を作らない)
    throw new Error(
      `契約表の文字列を解釈できない / cannot parse contract: ${row.name} "${row.contract}"`
    );
  }
  return spec;
}

// ---------------------------------------------------------------------------
// manifest の読み出し / Manifest read
// ---------------------------------------------------------------------------

/** 行の読み出し元から manifest 上の range 文字列を返す。無ければ `undefined` */
function readManifestRange(repoRoot: string, row: ContractRow): string | undefined {
  const rootPkg = readJson(join(repoRoot, "package.json"));
  if (row.source === "overrides") {
    const pnpmField = rootPkg.pnpm as { overrides?: Record<string, unknown> } | undefined;
    const value = pnpmField?.overrides?.[row.name];
    return typeof value === "string" ? value : undefined;
  }
  const devDeps = rootPkg.devDependencies as Record<string, unknown> | undefined;
  const value = devDeps?.[row.name];
  return typeof value === "string" ? value : undefined;
}

type ParsedManifestRange = { declared: string; spec: RangeSpec } | { violation: string };

/**
 * leg (a) / (b) 共通の前段: manifest の range を読み、解釈できなければ当該 leg の violation を返す。
 * Shared preamble of legs (a) / (b): read and parse the manifest range, or return the violation.
 */
function readParsedManifestRange(
  repoRoot: string,
  row: ContractRow,
  leg: "a" | "b"
): ParsedManifestRange {
  const declared = readManifestRange(repoRoot, row);
  if (declared === undefined) {
    return { violation: `(${leg}) ${row.name}: ${row.source} に宣言が無い` };
  }
  const spec = parseRange(declared);
  if (spec === null) {
    return {
      violation: `(${leg}) ${row.name}: "${declared}" は本 guard の対応形ではない (fail-closed)`,
    };
  }
  return { declared, spec };
}

// ---------------------------------------------------------------------------
// lockfile parser — leg (g)
// ---------------------------------------------------------------------------

// helper 本体は `../_shared/semver-lockfile` (CO-R2-36)。`collectLockVersions` = `^  '?<escaped-name>@([^':(]+)`
// Helpers live in `../_shared/semver-lockfile` (CO-R2-36); the leg (g) regex is unchanged.

// ---------------------------------------------------------------------------
// legs (repo root と契約表を引数に取る純関数 = mutation control から再利用)
// Legs as pure functions over (repo root, table), reused by the mutation controls
// ---------------------------------------------------------------------------

/** leg (a): manifest の range が上限を持ち、契約上限を超えない */
function checkLegA(
  repoRoot: string = REPO_ROOT,
  table: readonly ContractRow[] = CONTRACT_TABLE
): string[] {
  const violations: string[] = [];
  for (const row of table) {
    const parsed = readParsedManifestRange(repoRoot, row, "a");
    if ("violation" in parsed) {
      violations.push(parsed.violation);
      continue;
    }
    const { declared, spec } = parsed;
    if (spec.ceiling === null) {
      violations.push(`(a) ${row.name}: "${declared}" は上限を持たない`);
      continue;
    }
    const contractCeiling = contractSpec(row).ceiling as SemVer;
    if (compareVersion(spec.ceiling, contractCeiling) > 0) {
      violations.push(
        `(a) ${row.name}: "${declared}" の上限 ${formatVersion(spec.ceiling)} が契約上限 ${formatVersion(contractCeiling)} を超える`
      );
    }
  }
  return violations;
}

/** leg (b): manifest の floor が契約 floor 以上 */
function checkLegB(
  repoRoot: string = REPO_ROOT,
  table: readonly ContractRow[] = CONTRACT_TABLE
): string[] {
  const violations: string[] = [];
  for (const row of table) {
    const parsed = readParsedManifestRange(repoRoot, row, "b");
    if ("violation" in parsed) {
      violations.push(parsed.violation);
      continue;
    }
    const { declared, spec } = parsed;
    const contractFloor = contractSpec(row).floor;
    if (compareVersion(spec.floor, contractFloor) < 0) {
      violations.push(
        `(b) ${row.name}: "${declared}" の floor ${formatVersion(spec.floor)} が契約 floor ${formatVersion(contractFloor)} 未満`
      );
    }
  }
  return violations;
}

/** leg (c): lockfile の解決版が単一で、契約 floor 以上・契約上限未満 */
function checkLegC(
  repoRoot: string = REPO_ROOT,
  table: readonly ContractRow[] = CONTRACT_TABLE
): string[] {
  const violations: string[] = [];
  const lock = readLock(repoRoot);
  for (const row of table) {
    const distinct = [...new Set(collectLockVersions(lock, row.name))].sort();
    if (distinct.length === 0) continue; // 検出 0 は leg (f-2) が報告する
    if (distinct.length > 1) {
      violations.push(`(c) ${row.name}: lockfile で複数版に解決されている: ${distinct.join(", ")}`);
    }
    const contract = contractSpec(row);
    for (const raw of distinct) {
      const version = parseVersion(raw);
      if (version === null) {
        violations.push(`(c) ${row.name}@${raw}: 版を解釈できない`);
        continue;
      }
      const ceiling = contract.ceiling as SemVer;
      if (compareVersion(version, contract.floor) < 0 || compareVersion(version, ceiling) >= 0) {
        violations.push(`(c) ${row.name}@${raw}: 契約 range "${row.contract}" の外`);
      }
    }
  }
  return violations;
}

/** leg (a'): lockfile 側の定義 (`overrides:` 節 / root importer `specifier`) === manifest の文字列 */
function checkLegA2(
  repoRoot: string = REPO_ROOT,
  table: readonly ContractRow[] = CONTRACT_TABLE
): string[] {
  const violations: string[] = [];
  const lock = readLock(repoRoot);
  for (const row of table) {
    const declared = readManifestRange(repoRoot, row);
    if (declared === undefined) continue; // manifest 不在は leg (f-1) が報告する
    const locked = readLockDefinition(lock, row);
    if (locked !== declared) {
      violations.push(
        `(a') ${row.name}: lockfile 側 "${locked ?? "(なし)"}" が manifest "${declared}" と一致しない`
      );
    }
  }
  return violations;
}

/** leg (c'): peer suffix `(<name>@X` の版集合 ⊆ key 行の版集合 */
function checkLegC2(
  repoRoot: string = REPO_ROOT,
  table: readonly ContractRow[] = CONTRACT_TABLE
): string[] {
  const lock = readLock(repoRoot);
  const violations: string[] = [];
  for (const row of table) {
    const keys = new Set(collectLockVersions(lock, row.name));
    const orphans = [...new Set(collectPeerSuffixVersions(lock, row.name))]
      .filter((version) => !keys.has(version))
      .sort();
    if (orphans.length > 0) {
      violations.push(
        `(c') ${row.name}: peer suffix の版 ${orphans.join(", ")} が key 行に無い (key = ${[...keys].sort().join(", ") || "(なし)"})`
      );
    }
  }
  return violations;
}

/** leg (d): `vitest` / `@vitest/mocker` / `@vitest/coverage-v8` の解決版が同一 */
function checkLegD(repoRoot: string = REPO_ROOT): string[] {
  const lock = readLock(repoRoot);
  const union = new Set<string>();
  const perName = VITEST_FAMILY.map((name) => {
    const versions = [...new Set(collectLockVersions(lock, name))].sort();
    for (const version of versions) union.add(version);
    return `${name}=${versions.join("|") || "(なし)"}`;
  });
  if (union.size === 1) return [];
  return [`(d) vitest 系 3 者の解決版が 1 種類でない: ${perName.join(" / ")}`];
}

/** leg (e): `@cyclonedx/cdxgen` の解決版が全て 12.8.3 未満 (1 本以上存在する) */
function checkLegE(repoRoot: string = REPO_ROOT): string[] {
  const versions = [...new Set(collectLockVersions(readLock(repoRoot), CDXGEN_NAME))].sort();
  if (versions.length === 0) return [`(e) ${CDXGEN_NAME}: lockfile に key 行が無い`];
  return versions
    .filter((raw) => {
      const version = parseVersion(raw);
      return version === null || compareVersion(version, CDXGEN_NODE20_CEILING) >= 0;
    })
    .map((raw) => `(e) ${CDXGEN_NAME}@${raw}: 12.8.3 未満ではない (または解釈不能)`);
}

/** leg (f-1): 契約表の行数 = 実 manifest から検出できたエントリ数 */
function checkLegF1(
  repoRoot: string = REPO_ROOT,
  table: readonly ContractRow[] = CONTRACT_TABLE
): string[] {
  const detected = table.filter((row) => readManifestRange(repoRoot, row) !== undefined);
  if (detected.length === table.length) return [];
  const missing = table
    .filter((row) => !detected.includes(row))
    .map((row) => `${row.name} (${row.source})`);
  return [
    `(f-1) 契約表 ${table.length} 行に対し manifest で検出できたのは ${detected.length} 行: 不在 = ${missing.join(", ")}`,
  ];
}

/** leg (f-2): 各パッケージについて lockfile から 1 本以上の package 行を検出する */
function checkLegF2(
  repoRoot: string = REPO_ROOT,
  table: readonly ContractRow[] = CONTRACT_TABLE
): string[] {
  const lock = readLock(repoRoot);
  return table
    .filter((row) => collectLockVersions(lock, row.name).length === 0)
    .map(
      (row) =>
        `(f-2) ${row.name}: pnpm-lock.yaml から package 行を 1 本も検出できない (parse 契約の破綻)`
    );
}

function checkAllLegs(
  repoRoot: string = REPO_ROOT,
  table: readonly ContractRow[] = CONTRACT_TABLE
): string[] {
  return [
    ...checkLegA(repoRoot, table),
    ...checkLegA2(repoRoot, table),
    ...checkLegB(repoRoot, table),
    ...checkLegC(repoRoot, table),
    ...checkLegC2(repoRoot, table),
    ...checkLegD(repoRoot),
    ...checkLegE(repoRoot),
    ...checkLegF1(repoRoot, table),
    ...checkLegF2(repoRoot, table),
  ];
}

// ---------------------------------------------------------------------------
// mutation control 用 fixture tree (os.tmpdir、実 repo は不変)
// Fixture tree for the mutation controls (os.tmpdir; the real repo is untouched)
// ---------------------------------------------------------------------------

/**
 * R2-BE-a / R2-BE-b 着地後の解決版 (実 lockfile 実測値) で fixture lockfile を構成する (H-1)。
 * Fixture lockfile built from the post-R2-BE-a / -b resolved versions (measured, H-1).
 */
const LANDED_VERSIONS: Readonly<Record<string, string>> = {
  browserslist: "4.29.1",
  "baseline-browser-mapping": "2.11.26",
  "@humanfs/node": "0.16.8",
  "@babel/core": "7.29.7",
  vitest: "4.1.11",
  "@vitest/mocker": "4.1.11",
  "@vitest/coverage-v8": "4.1.11",
  "@cyclonedx/cdxgen": "12.8.2",
  // R2-C 4 行: override commit の `pnpm install` 後の実解決版 (H-1)。hono は registry 追随で動く
  // (c-v0 C-L-02) ため exact 値は本 fixture にのみ置き、実 repo の判定は leg (c) の range で行う。
  // R2-C rows: post-install resolution (H-1); the real-repo check is the leg (c) range.
  hono: "4.13.10",
  "@hono/node-server": "2.1.1",
  qs: "6.16.0",
  "body-parser": "2.3.0",
  // R2-U 5 行: override commit の `pnpm install` 後の実解決版 (H-1)。undici / ip-address は cap 内の
  // 最新に解決した (floor ちょうどではない)。実 repo の判定は leg (c) の range で行う。
  // R2-U rows: post-install resolution (H-1); the real-repo check is the leg (c) range.
  undici: "7.30.0",
  "brace-expansion": "5.0.12",
  "@grpc/grpc-js": "1.14.5",
  "ip-address": "10.7.3",
  "fast-uri": "3.1.8",
  // R2-OF 3 行: override commit の `pnpm install` 後の実解決版 (H-1)。実 repo の判定は leg (c) の range で行う。
  // R2-OF rows: post-install resolution (H-1); the real-repo check is the leg (c) range.
  "proxy-addr": "2.0.8",
  compression: "1.8.2",
  "source-map-js": "1.2.2",
  // CO-R2-97 2 行: override commit の `pnpm install` 後の実解決版 (H-1)。実 repo の判定は leg (c) の range で行う。
  // CO-R2-97 rows: post-install resolution (H-1); the real-repo check is the leg (c) range.
  handlebars: "4.7.10",
  "@modelcontextprotocol/sdk": "1.31.0",
  // R2-SH 1 行: override commit の `pnpm install` 後の実解決版 (H-1、C2 で実測値に合わせる)。
  // R2-SH row: post-install resolution (H-1; aligned to the measured value at C2).
  sharp: "0.35.5",
  // R2-D 1 行: override commit の `pnpm install` 後の実解決版 (H-1)。
  // R2-D row: post-install resolution (H-1).
  dompurify: "3.4.17",
};

const fixtureRoots: string[] = [];

interface FixtureOptions {
  /** manifest override の上書き。`null` でキーを落とす / manifest override patch; `null` drops */
  overrides?: Patch;
  /** manifest devDependencies の上書き / manifest devDependencies patch */
  devDependencies?: Patch;
  /** lockfile `overrides:` 節だけの上書き (manifest は不変) / lockfile-only override patch */
  lockOverrides?: Patch;
  /** lockfile root importer `specifier` だけの上書き / lockfile-only specifier patch */
  lockSpecifiers?: Patch;
  /** lockfile 版の上書き。空配列で当該 package の行を 0 本にする / lock versions; `[]` = no lines */
  lockVersions?: Record<string, string[]>;
  /** snapshots 節に足す任意の行 (peer suffix の fixture) / extra snapshot lines */
  extraSnapshotLines?: string[];
}

function writeFixtureRoot(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "inv-sec-override-bound-"));
  fixtureRoots.push(root);
  mkdirSync(root, { recursive: true });

  const baseOverrides: Record<string, string> = { express: ">=5.2.0" };
  const baseDevDeps: Record<string, string> = { husky: "^9.1.0" };
  for (const row of CONTRACT_TABLE) {
    if (row.source === "overrides") baseOverrides[row.name] = row.contract;
    else baseDevDeps[row.name] = row.contract;
  }
  const overrides = applyPatch(baseOverrides, options.overrides);
  const devDependencies = applyPatch(baseDevDeps, options.devDependencies);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "reftrix", devDependencies, pnpm: { overrides } }, null, 2)}\n`
  );

  // lockfile 側は manifest の写し (pnpm install の出力と同形)。lock* option で lockfile だけを変える
  const lockOverrides = applyPatch(overrides, options.lockOverrides);
  const lockSpecifiers = applyPatch(devDependencies, options.lockSpecifiers);
  const packages: string[] = [];
  const snapshots: string[] = [];
  for (const row of CONTRACT_TABLE) {
    const versions = options.lockVersions?.[row.name] ?? [LANDED_VERSIONS[row.name]];
    for (const version of versions) {
      packages.push(lockKeyLine(row.name, version), "    resolution: {integrity: sha512-x}");
      snapshots.push(`${lockKeyLine(row.name, version)} {}`);
    }
  }
  const lockLines = [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "",
    "overrides:",
    ...Object.entries(lockOverrides).map(([k, v]) => `  ${yamlKey(k)}: ${yamlValue(v)}`),
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    ...Object.entries(lockSpecifiers).flatMap(([k, v]) => [
      `      ${yamlKey(k)}:`,
      `        specifier: ${yamlValue(v)}`,
      `        version: ${LANDED_VERSIONS[k] ?? "9.1.7"}`,
    ]),
    "",
    "  apps/mcp-server:",
    "    devDependencies:",
    "      vitest:",
    "        specifier: ^4.1.0",
    `        version: ${LANDED_VERSIONS.vitest}(@vitest/coverage-v8@${LANDED_VERSIONS["@vitest/coverage-v8"]})`,
    "",
    "packages:",
    "",
    ...packages,
    "",
    "snapshots:",
    "",
    ...snapshots,
    ...(options.extraSnapshotLines ?? []),
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

describe("INV-SEC-OVERRIDE-BOUND-001 (large-page)", () => {
  it("契約表 (R2-BE-a 4 + R2-BE-b 4 + R2-C 4 + R2-U 5 + R2-OF 3 + CO-R2-97 2 + R2-SH 1 + R2-D 1) の文字列はすべて上限付きで解釈できる / the contract table itself parses", () => {
    expect(CONTRACT_TABLE.length).toBe(24);
    for (const row of CONTRACT_TABLE) expect(contractSpec(row).ceiling).not.toBeNull();
    // cdxgen のみ devDependencies (UB2-2)。他は pnpm.overrides / only cdxgen is a declaration
    expect(
      CONTRACT_TABLE.filter((row) => row.source === "devDependencies").map((r) => r.name)
    ).toEqual([CDXGEN_NAME]);
  });

  describe("(a) 全エントリが上限を持つ / every entry is capped", () => {
    it("manifest の range が上限を持ち、契約上限を超えない", () => {
      expect(checkLegA()).toEqual([]);
    });
  });

  describe("(a') lockfile 側の定義 === manifest / lockfile copy equals the manifest", () => {
    it("overrides 行は lockfile `overrides:` 節、cdxgen は root importer の specifier と完全一致", () => {
      expect(checkLegA2()).toEqual([]);
    });
  });

  describe("(b) floor が契約 floor 以上 / floor at or above the contract floor", () => {
    it("manifest の floor が契約 floor 以上", () => {
      expect(checkLegB()).toEqual([]);
    });
  });

  describe("(c) lockfile の解決版が単一かつ契約 range 内 / single resolved version in range", () => {
    it("各エントリの lockfile 解決版が 1 種類で、契約 floor 以上・上限未満", () => {
      expect(checkLegC()).toEqual([]);
    });
  });

  describe("(c') peer suffix の版 ⊆ key 行の版 / peer suffixes point at existing keys", () => {
    it("各エントリの `(<name>@X` の X は全て key 行に存在する", () => {
      expect(checkLegC2()).toEqual([]);
    });
  });

  describe("(d) vitest 系 3 者の解決版が同一 / vitest family resolves to one version", () => {
    it("vitest / @vitest/mocker / @vitest/coverage-v8 の lockfile 版が 1 種類", () => {
      expect(checkLegD()).toEqual([]);
    });
  });

  describe("(e) @cyclonedx/cdxgen < 12.8.3 (Node 20 で install 可能な上限)", () => {
    it("cdxgen の lockfile 解決版が全て 12.8.3 未満", () => {
      expect(checkLegE()).toEqual([]);
    });
  });

  describe("(f) 非空虚性 guard / non-vacuity guard", () => {
    it("(f-1) 契約表の全行が実 manifest に実在する", () => {
      expect(checkLegF1()).toEqual([]);
    });

    it("(f-2) 各パッケージについて lockfile から 1 本以上の package 行を検出する", () => {
      expect(checkLegF2()).toEqual([]);
    });

    // CO-R2-39 (c-v0 E-43 (5)): leg (c') が空虚でない = 実 lockfile に peer suffix の instance が在る。
    // `@hono/node-server@2.x(hono@…)` が自然な instance。(c') の対象拡張は CO-R2-36 / CO-R2-39 のまま。
    // CO-R2-39 non-vacuity: the real lockfile carries >= 1 peer-suffix instance for the table.
    it("(f-3) CO-R2-39: 実 lockfile の peer suffix 検出数 (契約表合計) >= 1、hono instance >= 1", () => {
      const lock = readLock(REPO_ROOT);
      const total = CONTRACT_TABLE.reduce(
        (sum, row) => sum + collectPeerSuffixVersions(lock, row.name).length,
        0
      );
      expect(total).toBeGreaterThanOrEqual(1);
      expect(collectPeerSuffixVersions(lock, "hono").length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // mutation controls — plan v3.1 §7.1 / §8 ※4 の極性: (i)(ii)(iii)(iv)(vi) = RED, (v) = GREEN
  // -------------------------------------------------------------------------
  describe("mutation controls (非空虚性 / non-vacuity)", () => {
    it("baseline fixture (着地後の解決版 + 契約文字列) は全 leg 違反 0 (harness が常時 RED でない)", () => {
      expect(checkAllLegs(writeFixtureRoot())).toEqual([]);
    });

    it("(i) 上限除去 → RED (leg (a))", () => {
      const root = writeFixtureRoot({ overrides: { browserslist: ">=4.28.7" } });
      const violations = checkLegA(root);
      expect(
        violations.some((v) => v.includes("browserslist") && v.includes("上限を持たない"))
      ).toBe(true);
    });

    it("(i') 契約上限を超える上限 (`<6`) → RED (leg (a))", () => {
      const root = writeFixtureRoot({ overrides: { browserslist: ">=4.28.7 <6" } });
      expect(checkLegA(root).some((v) => v.includes("契約上限"))).toBe(true);
    });

    it("(ii) 汎用形: @babel/core floor を 7.28.0 へ引下げ → leg (b) のみ RED (H-1)", () => {
      const root = writeFixtureRoot({ overrides: { "@babel/core": ">=7.28.0 <8" } });
      const legB = checkLegB(root);
      expect(legB.some((v) => v.includes("@babel/core") && v.includes("7.28.0"))).toBe(true);
      // H-1: mutation は manifest の override 文字列のみ → 他 leg は GREEN のまま
      expect(checkLegA(root)).toEqual([]);
      expect(checkLegC(root)).toEqual([]);
      expect(checkLegF1(root)).toEqual([]);
      expect(checkLegF2(root)).toEqual([]);
    });

    // (ii) 固有 instance: 契約 floor を advisory range 内へ引下げ → leg (b) だけが violation (H-1)。
    // R2-C: @hono/node-server 1.19.14 (GHSA-frvp-7c67-39w9 `< 1.19.15`) / hono 4.13.5
    // (GHSA-hxh3-vqpv-xpqv `< 4.13.7`、E-46)。R2-U: undici 7.29.0 (`< 7.29.1` の 10 件、E-50)。
    // R2-OF: proxy-addr 2.0.7 / compression 1.8.1 / source-map-js 1.2.1 (E-96)。
    // CO-R2-97: handlebars 4.7.9 / @modelcontextprotocol/sdk 1.30.1 (GHSA-8r5x / -p8wg / -6qxp)。
    // R2-SH: sharp 0.35.4 (GHSA-wq5f-xc86-pv6w `< 0.35.5`、E-124)。
    // R2-D: dompurify 3.4.13 (GHSA-6688 / -p98j、E-47)。
    it.each([
      { name: "@hono/node-server", mutated: ">=1.19.14 <3", floor: "1.19.14" },
      { name: "hono", mutated: ">=4.13.5 <5", floor: "4.13.5" },
      { name: "undici", mutated: ">=7.29.0 <8", floor: "7.29.0" },
      // R2-OF: floors inside the GHSA-jqcg / -vc2v / -68fv vulnerable ranges.
      { name: "proxy-addr", mutated: ">=2.0.7 <3", floor: "2.0.7" },
      { name: "compression", mutated: ">=1.8.1 <2", floor: "1.8.1" },
      { name: "source-map-js", mutated: ">=1.2.1 <2", floor: "1.2.1" },
      // CO-R2-97: floors inside the GHSA-8r5x / -p8wg / -6qxp vulnerable ranges.
      { name: "handlebars", mutated: ">=4.7.9 <5", floor: "4.7.9" },
      { name: "@modelcontextprotocol/sdk", mutated: ">=1.30.1 <1.32", floor: "1.30.1" },
      // R2-SH: floor inside the GHSA-wq5f vulnerable range.
      { name: "sharp", mutated: ">=0.35.4 <0.36", floor: "0.35.4" },
      // R2-D: floor inside the GHSA-6688 / -p98j vulnerable range.
      { name: "dompurify", mutated: ">=3.4.13 <4", floor: "3.4.13" },
    ])(
      "(ii) 固有 instance: $name floor を $floor へ引下げ → leg (b) のみ violation、他 leg は [] (H-1)",
      ({ name, mutated, floor }) => {
        const root = writeFixtureRoot({ overrides: { [name]: mutated } });
        const legB = checkLegB(root);
        expect(legB).toHaveLength(1);
        expect(legB[0].startsWith(`(b) ${name}:`)).toBe(true);
        expect(legB[0]).toContain(floor);
        // H-1: mutation は manifest の override 文字列のみ → 他の全 leg は GREEN のまま
        expect(checkLegA(root)).toEqual([]);
        expect(checkLegA2(root)).toEqual([]);
        expect(checkLegC(root)).toEqual([]);
        expect(checkLegC2(root)).toEqual([]);
        expect(checkLegD(root)).toEqual([]);
        expect(checkLegE(root)).toEqual([]);
        expect(checkLegF1(root)).toEqual([]);
        expect(checkLegF2(root)).toEqual([]);
      }
    );

    it("(iii) 当該パッケージの lockfile 行が 0 本 → RED (leg (f-2))", () => {
      const root = writeFixtureRoot({ lockVersions: { "@humanfs/node": [] } });
      expect(checkLegF2(root).some((v) => v.includes("@humanfs/node"))).toBe(true);
    });

    it("(iv) 多版 lockfile → RED (leg (c))", () => {
      const root = writeFixtureRoot({ lockVersions: { "@babel/core": ["7.29.7", "7.28.6"] } });
      const violations = checkLegC(root);
      expect(violations.some((v) => v.includes("@babel/core") && v.includes("複数版"))).toBe(true);
      expect(violations.some((v) => v.includes("@babel/core@7.28.6") && v.includes("外"))).toBe(
        true
      );
    });

    it("(v) positive control: quoted scoped / `: {}` / peer suffix の 3 形が同一版に正規化される → GREEN", () => {
      const lock = [
        "packages:",
        "  '@babel/core@7.29.7':",
        "    resolution: {integrity: sha512-x}",
        "  baseline-browser-mapping@2.11.26:",
        "snapshots:",
        "  '@babel/core@7.29.7':",
        "  '@babel/core@7.29.7(supports-color@8.1.1)':",
        "  baseline-browser-mapping@2.11.26: {}",
        "  browserslist@4.29.1:",
        "  next@16.3.5(@babel/core@7.29.7)(react@19.2.3):",
        "",
      ].join("\n");
      expect(collectLockVersions(lock, "@babel/core")).toEqual(["7.29.7", "7.29.7", "7.29.7"]);
      expect(collectLockVersions(lock, "baseline-browser-mapping")).toEqual(["2.11.26", "2.11.26"]);
      expect(collectLockVersions(lock, "browserslist")).toEqual(["4.29.1"]);
      // peer suffix の中の `(@babel/core@…)` は key 行ではないので数えない / not a key line
      expect(collectLockVersions(lock, "next")).toEqual(["16.3.5"]);
      // 同形を含む fixture tree 全体でも GREEN / the whole fixture tree is GREEN too
      expect(checkAllLegs(writeFixtureRoot())).toEqual([]);
    });

    it("(vi) 実在しない package 名の行を契約表に 1 行足す → RED (leg (f-1))", () => {
      const root = writeFixtureRoot();
      const extended: readonly ContractRow[] = [
        ...CONTRACT_TABLE,
        { name: "reftrix-nonexistent-package", source: "overrides", contract: ">=1.0.0 <2" },
      ];
      const violations = checkLegF1(root, extended);
      expect(violations.some((v) => v.includes("reftrix-nonexistent-package"))).toBe(true);
    });

    // --- R2-BE-b: leg (a')(c')(d)(e) + devDependencies 経路 + prerelease の control (BEA-05 / BEA-12)
    it("(a') lockfile `overrides:` 節だけ上限を外す → leg (a') RED、leg (a) は検知しない", () => {
      const root = writeFixtureRoot({ lockOverrides: { vitest: ">=4.1.11" } });
      expect(checkLegA2(root).some((v) => v.includes("vitest") && v.includes(">=4.1.11"))).toBe(
        true
      );
      // manifest は不変 → (a) は GREEN のまま = (a') が無ければ見逃す / (a) alone misses it
      expect(checkLegA(root)).toEqual([]);
    });

    it("(a') lockfile root importer の cdxgen specifier だけ caret に戻す → leg (a') RED", () => {
      const root = writeFixtureRoot({ lockSpecifiers: { [CDXGEN_NAME]: "^12.4.3" } });
      expect(checkLegA2(root).some((v) => v.includes(CDXGEN_NAME) && v.includes("^12.4.3"))).toBe(
        true
      );
      expect(checkLegA(root)).toEqual([]);
    });

    it("(c') key 行に無い版を指す peer suffix → leg (c') RED、leg (c) は検知しない", () => {
      const root = writeFixtureRoot({
        extraSnapshotLines: ["  next@16.3.5(@babel/core@7.28.6)(react@19.2.3):"],
      });
      expect(checkLegC2(root).some((v) => v.includes("@babel/core") && v.includes("7.28.6"))).toBe(
        true
      );
      expect(checkLegC(root)).toEqual([]);
    });

    it("(c') 入れ子 peer suffix の版も捕捉し、key 行にあれば GREEN (positive)", () => {
      const nested = "  '@vitest/coverage-v8@4.1.11(vitest@4.1.11(@types/node@22.19.6))':";
      expect(collectPeerSuffixVersions(nested, "vitest")).toEqual(["4.1.11"]);
      expect(checkLegC2(writeFixtureRoot({ extraSnapshotLines: [nested] }))).toEqual([]);
    });

    it("(d) @vitest/mocker だけ別版 (契約 range 内) → leg (d) RED、leg (c) は検知しない", () => {
      const root = writeFixtureRoot({ lockVersions: { "@vitest/mocker": ["4.1.12"] } });
      expect(checkLegD(root).some((v) => v.includes("@vitest/mocker=4.1.12"))).toBe(true);
      expect(checkLegC(root)).toEqual([]);
    });

    it("(e) cdxgen 12.8.3 に解決 → leg (e) RED / key 行 0 本でも RED", () => {
      const root = writeFixtureRoot({ lockVersions: { [CDXGEN_NAME]: ["12.8.3"] } });
      expect(checkLegE(root).some((v) => v.includes(`${CDXGEN_NAME}@12.8.3`))).toBe(true);
      const empty = writeFixtureRoot({ lockVersions: { [CDXGEN_NAME]: [] } });
      expect(checkLegE(empty).some((v) => v.includes("key 行が無い"))).toBe(true);
    });

    it("(f-1) devDependencies 経路: cdxgen を devDependencies から除く → RED、overrides に置いても検出されない", () => {
      // positive: 既定 fixture では devDependencies 経路で読める
      const cdxgenRow = CONTRACT_TABLE.find((row) => row.name === CDXGEN_NAME) as ContractRow;
      expect(readManifestRange(writeFixtureRoot(), cdxgenRow)).toBe(cdxgenRow.contract);

      const removed = writeFixtureRoot({ devDependencies: { [CDXGEN_NAME]: null } });
      expect(checkLegF1(removed).some((v) => v.includes(CDXGEN_NAME))).toBe(true);

      const movedToOverrides = writeFixtureRoot({
        devDependencies: { [CDXGEN_NAME]: null },
        overrides: { [CDXGEN_NAME]: cdxgenRow.contract },
      });
      expect(readManifestRange(movedToOverrides, cdxgenRow)).toBeUndefined();
      expect(checkLegF1(movedToOverrides).some((v) => v.includes(CDXGEN_NAME))).toBe(true);
    });

    it("prerelease 版に解決 → leg (c) RED (parseVersion が null = fail-closed)", () => {
      const root = writeFixtureRoot({ lockVersions: { "@babel/core": ["8.0.0-rc.5"] } });
      expect(
        checkLegC(root).some(
          (v) => v.includes("@babel/core@8.0.0-rc.5") && v.includes("解釈できない")
        )
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 手書き range parser 自体の pin (parser が壊れると leg が静かに空虚化する)
  // -------------------------------------------------------------------------
  describe("hand-written range parser", () => {
    function admits(range: string, version: string): boolean {
      const spec = parseRange(range);
      const parsed = parseVersion(version);
      if (spec === null || parsed === null) {
        throw new Error(`parser 契約の破綻: range="${range}" version="${version}"`);
      }
      return rangeAdmits(spec, parsed);
    }

    it(">=0.16.8 <0.17 は 0.16.8 を admit し 0.16.7 / 0.17.0 を admit しない (部分版の上限)", () => {
      expect(admits(">=0.16.8 <0.17", "0.16.8")).toBe(true);
      expect(admits(">=0.16.8 <0.17", "0.16.7")).toBe(false);
      expect(admits(">=0.16.8 <0.17", "0.17.0")).toBe(false);
    });

    it(">=7.29.6 <8 は 7.29.7 を admit し 8.0.0 を admit しない", () => {
      expect(admits(">=7.29.6 <8", "7.29.7")).toBe(true);
      expect(admits(">=7.29.6 <8", "8.0.0")).toBe(false);
    });

    it("prerelease / build metadata 付きの版は null (fail-closed)", () => {
      expect(parseVersion("7.29.7-rc.1")).toBeNull();
      expect(parseVersion("1.0.0+build.1")).toBeNull();
      expect(parseVersion("4.1.11")).toEqual({ major: 4, minor: 1, patch: 11 });
    });

    it(">=12.4.3 <12.8.3 は 12.8.2 を admit し 12.8.3 / 12.4.2 を admit しない (3 段の上限)", () => {
      expect(admits(">=12.4.3 <12.8.3", "12.8.2")).toBe(true);
      expect(admits(">=12.4.3 <12.8.3", "12.8.3")).toBe(false);
      expect(admits(">=12.4.3 <12.8.3", "12.4.2")).toBe(false);
    });

    it(">=4.28.7 は上限を持たない", () => {
      expect(parseRange(">=4.28.7")?.ceiling).toBeNull();
    });

    it("未対応形 (|| / * / latest / workspace / 3 項) は null で fail-closed", () => {
      for (const raw of ["*", "latest", "^4.0.0 || ^5.0.0", "workspace:*", ">=1.0.0 <2 <3"]) {
        expect(parseRange(raw)).toBeNull();
      }
    });
  });
});
