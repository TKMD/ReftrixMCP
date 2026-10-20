// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — 共有 semver / lockfile helper (test-only、依存 0)
 * Shared semver / lockfile helpers for the standing suite (test-only, zero dependencies)
 *
 * `INV-SEC-OVERRIDE-BOUND-001` (harness) / `INV-SHARP-DECLARED-RANGE-001` (precedent) /
 * `INV-SEC-AUDIT-IGNORE-BOUND-001` (ignore pin) が各 file に複製していた helper をここへ集約する
 * (security-deps R2 CO-R2-36 = impl registry be-a-v0 BEA-11 + be-b-v0 BEB-TDA-05 追記 + addendum
 * registry v1 E-60)。後続の INV (R2-D の宣言 INV など) は helper を copy せず本 module を import する。
 * 別 `.test.ts` から import しない (testing-requirements §9 TPA-02 と同理由) ため、置き場所は
 * `*.test.ts` ではない本 module とする (`_setup/inv-assert.ts` と同じ扱い、vitest の include 外)。
 *
 * Helpers that the harness / precedent / ignore-pin INVs used to duplicate (CO-R2-36). Later INVs
 * import this module instead of copying; it is not a `*.test.ts`, so importing it is not a
 * test-to-test import and vitest never collects it.
 *
 * 振る舞いは抽出元と同一 (refactor のみ)。parser は意図的に最小: `>=` / `<` / `^` / `~` / 完全一致
 * だけを解釈し、未対応形は `null` で fail-closed (`semver` は未宣言 = phantom なので使わない)。
 * Behaviour is identical to the extracted originals; unknown range forms fail closed.
 *
 * lockfile reader (`lockSection` / `readLockDefinition` / `collect*`) は harness の行単位 leg 用。
 * 新規 INV の YAML 構造 parse は `js-yaml` を使う (E-60、ignore pin INV と同じ)。
 * The line-based lockfile readers serve the harness legs; new INVs parse YAML structure with
 * `js-yaml` (E-60).
 *
 * Registry: security-deps-remediation-r2-impl-finding-registry-be-a-v0.md §9 CO-R2-36 /
 * be-b-v0 §9 CO-R2-36 (追記) / addendum-finding-registry-v1 E-60.
 * Regression domain: large-page.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * repo root。_shared → standing → regression → tests → mcp-server → apps → root (6 段、
 * `large-page/` と同じ深さ)。
 * Repo root, six levels up (same depth as `large-page/`).
 */
export const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..", "..");

// ---------------------------------------------------------------------------
// 最小 semver / range parser (手書き、依存 0)
// Minimal hand-written semver / range parser (zero dependencies)
// ---------------------------------------------------------------------------

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export interface RangeSpec {
  /** 下限 (inclusive) / inclusive floor */
  floor: SemVer;
  /** 上限 (exclusive)。上限なし (`>=`) = `null` / exclusive ceiling; `null` when uncapped */
  ceiling: SemVer | null;
}

/**
 * `4.29.1` → `{…}`。数値 3 組ちょうどでなければ `null`。prerelease / build metadata 付き
 * (`8.0.0-rc.5` / `1.0.0+x`) も `null` = fail-closed (prerelease は比較対象に含めない設計)。
 * Exact `X.Y.Z` only; prerelease / build-metadata versions return `null` (fail-closed).
 */
export function parseVersion(raw: string): SemVer | null {
  return matchTriple(/^(\d+)\.(\d+)\.(\d+)$/, raw);
}

/**
 * 先頭の数値 3 組だけを読む (`0.35.4-rc.1` → `{0,35,4}`)。prerelease を落として比較する
 * precedent (`INV-SHARP-DECLARED-RANGE-001`) 専用。数値 3 組で始まらなければ `null`。
 * Reads the leading `X.Y.Z` only (prerelease suffix ignored); used by the sharp precedent.
 * 注意: prerelease は floor 判定で fail-open (`0.35.0-rc.1` を 0.35.0 と読む)。sharp precedent
 * 専用で、新規 INV は strict な `parseVersion` を使う。
 * Fail-open for prerelease (`0.35.0-rc.1` reads as 0.35.0); new INVs use strict `parseVersion`.
 */
export function parseVersionPrefix(raw: string): SemVer | null {
  return matchTriple(/^(\d+)\.(\d+)\.(\d+)/, raw);
}

/** `re` の 3 group を `SemVer` にする。不一致は `null` / maps the 3 groups of `re`, else `null` */
function matchTriple(re: RegExp, raw: string): SemVer | null {
  const m = re.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * 契約表の上限表記 (`5` / `0.17` / `12.8.3`) を完全な版にする。
 * Expands a cap written as `5` / `0.17` / `12.8.3` into a full version.
 */
export function parsePartialVersion(raw: string): SemVer | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}

/** a < b → 負 / a === b → 0 / a > b → 正 */
export function compareVersion(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function formatVersion(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** `>=X <Y` (`Y` は `5` / `0.17` のような部分版を許す) / bounded form, partial cap allowed */
const BOUNDED_RANGE_RE = /^>=\s*(\d+\.\d+\.\d+)\s+<\s*(\d+(?:\.\d+){0,2})$/;

/**
 * `>=X <Y` のみを解釈する。一致しなければ `null`。
 * Parses only the bounded form `>=X <Y`; anything else returns `null`.
 */
export function parseBoundedRange(raw: string): RangeSpec | null {
  const bounded = BOUNDED_RANGE_RE.exec(raw.trim());
  if (!bounded) return null;
  // group は regex で必須ゆえ match 後は string / required group: always a string after a match
  const floor = parseVersion(bounded[1]!);
  const ceiling = parsePartialVersion(bounded[2]!);
  if (floor === null || ceiling === null) return null;
  return { floor, ceiling };
}

/**
 * `^x.y.z` / `~x.y.z` / `>=x.y.z` / `x.y.z` (完全一致) のみを解釈する。それ以外 (`||` /
 * スペース区切り複合 / `*` / `latest` / workspace 記法 等) は `null` を返して fail-closed にする。
 * Parses only `^x.y.z` / `~x.y.z` / `>=x.y.z` / exact `x.y.z`; anything else fails closed.
 */
export function parseSimpleRange(raw: string): RangeSpec | null {
  const m = /^(\^|~|>=|=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!m) return null;

  const operator = m[1] ?? "=";
  const floor: SemVer = { major: Number(m[2]), minor: Number(m[3]), patch: Number(m[4]) };

  if (operator === ">=") return { floor, ceiling: null };
  if (operator === "=") return { floor, ceiling: { ...floor, patch: floor.patch + 1 } };
  if (operator === "~") {
    return { floor, ceiling: { major: floor.major, minor: floor.minor + 1, patch: 0 } };
  }
  // caret: npm semver の 0.x 特例 — ^0.35.3 := >=0.35.3 <0.36.0 / ^0.0.z := その patch のみ
  if (floor.major > 0) return { floor, ceiling: { major: floor.major + 1, minor: 0, patch: 0 } };
  if (floor.minor > 0) return { floor, ceiling: { major: 0, minor: floor.minor + 1, patch: 0 } };
  return { floor, ceiling: { major: 0, minor: 0, patch: floor.patch + 1 } };
}

/**
 * 解釈する形: `>=X <Y` / `>=X` / `^X` / `~X` / 完全一致 `X`。それ以外 (`||` / `*` /
 * `latest` / workspace 記法 / 3 項以上の複合) は **`null` で fail-closed**。bounded 形に一致した
 * 文字列は simple 形へ fall back しない。
 * Accepted forms: `>=X <Y` / `>=X` / `^X` / `~X` / exact `X`; anything else fails closed.
 */
export function parseRange(raw: string): RangeSpec | null {
  const range = raw.trim();
  return BOUNDED_RANGE_RE.test(range) ? parseBoundedRange(range) : parseSimpleRange(range);
}

/** `spec` が `version` を admit するか / whether `spec` admits `version` */
export function rangeAdmits(spec: RangeSpec, version: SemVer): boolean {
  if (compareVersion(version, spec.floor) < 0) return false;
  if (spec.ceiling === null) return true;
  return compareVersion(version, spec.ceiling) < 0;
}

// ---------------------------------------------------------------------------
// manifest / lockfile の読み出し / Manifest and lockfile reads
// ---------------------------------------------------------------------------

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function readLock(repoRoot: string): string {
  return readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
}

export function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\/@-]/g, "\\$&");
}

/**
 * `^  '?<escaped-name>@([^':(]+)` で package key 行の版を全て集める (重複あり)。
 * Collects every key-line version for `name` (duplicates kept, for line counting).
 */
export function collectLockVersions(lockText: string, name: string): string[] {
  const re = new RegExp(`^  '?${escapeRegExp(name)}@([^':(]+)`, "gm");
  // group は regex で必須ゆえ match 後は string / required group: always a string after a match
  return [...lockText.matchAll(re)].map((m) => m[1]!.trim());
}

/** YAML scalar の single / double quote を外す (`'>=5 <6'` → `>=5 <6`、`''` → `'`) */
export function unquoteYamlScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * top-level の `<section>:` から、indent 2 未満の次行までを返す (無ければ `undefined`)。
 * Returns the body of a top-level lockfile section up to the next line indented < 2.
 */
export function lockSection(lockText: string, header: string): string | undefined {
  const start = lockText.indexOf(`\n${header}:\n`);
  if (start < 0) return undefined;
  const rest = lockText.slice(start + header.length + 3);
  const end = /\n(?! {2}|\n)/.exec(rest);
  return end === null ? rest : rest.slice(0, end.index + 1);
}

/** lockfile 側の定義の読み出し元 / where a definition lives in the lockfile */
export interface LockDefinitionRef {
  name: string;
  source: "overrides" | "devDependencies";
}

/**
 * overrides 行 = lockfile `overrides:` 節の値、devDependencies 行 = root importer (`.`) の
 * `specifier`。無ければ `undefined`。
 * Lockfile-side definition: the `overrides:` value, or the root importer's `specifier`.
 */
export function readLockDefinition(lockText: string, ref: LockDefinitionRef): string | undefined {
  const name = escapeRegExp(ref.name);
  if (ref.source === "overrides") {
    const section = lockSection(lockText, "overrides");
    if (section === undefined) return undefined;
    const m = new RegExp(`^  '?${name}'?: (.+)$`, "m").exec(section);
    // group は regex で必須ゆえ match 後は string / required group: always a string after a match
    return m === null ? undefined : unquoteYamlScalar(m[1]!);
  }
  const importers = lockSection(lockText, "importers");
  if (importers === undefined) return undefined;
  const rootStart = importers.indexOf("\n  .:\n");
  if (rootStart < 0) return undefined;
  const rootRest = importers.slice(rootStart + 6);
  const rootEnd = /\n {0,2}\S/.exec(rootRest);
  const rootBlock = rootEnd === null ? rootRest : rootRest.slice(0, rootEnd.index + 1);
  const m = new RegExp(`^      '?${name}'?:\\n        specifier: (.+)$`, "m").exec(rootBlock);
  // group は regex で必須ゆえ match 後は string / required group: always a string after a match
  return m === null ? undefined : unquoteYamlScalar(m[1]!);
}

/**
 * peer suffix `(<name>@X` の `X` を全て集める。`[^()'\s]+` で止めるため、入れ子の peer
 * (`(vitest@4.1.11(@types/node@…))`) でも版だけを捕捉する。
 * 対象外 (CO-R2-39): importer の `version:` 値と snapshot 依存値の先頭版 (edge 値) は走査しない。
 * Collects every `X` in a `(<name>@X` peer suffix; nested peers stop at `(` / `)`.
 * Out of scope (CO-R2-39): importer `version:` values and snapshot dependency values (edge values).
 */
export function collectPeerSuffixVersions(lockText: string, name: string): string[] {
  const re = new RegExp(`\\('?${escapeRegExp(name)}@([^()'\\s]+)`, "g");
  // group は regex で必須ゆえ match 後は string / required group: always a string after a match
  return [...lockText.matchAll(re)].map((m) => m[1]!);
}

// ---------------------------------------------------------------------------
// fixture builder (pnpm の実形式で書く) / Fixture builders in pnpm's on-disk format
// ---------------------------------------------------------------------------

export type Patch = Record<string, string | null>;

/** `base` に `patch` を重ねる。`null` でキーを落とす / overlay `patch`; `null` drops a key */
export function applyPatch(
  base: Record<string, string>,
  patch: Patch = {}
): Record<string, string> {
  const out = { ...base };
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete out[name];
    else out[name] = value;
  }
  return out;
}

/** pnpm の実形式: scoped key は single-quote、純粋な版以外の値も single-quote */
export function yamlKey(name: string): string {
  return name.startsWith("@") ? `'${name}'` : name;
}

export function yamlValue(value: string): string {
  return /^[\d.]+$/.test(value) ? value : `'${value}'`;
}

/** pnpm の実形式で key 行を書く (scoped は single-quote) */
export function lockKeyLine(name: string, version: string, suffix = ""): string {
  const key = `${name}@${version}${suffix}`;
  return name.startsWith("@") ? `  '${key}':` : `  ${key}:`;
}
