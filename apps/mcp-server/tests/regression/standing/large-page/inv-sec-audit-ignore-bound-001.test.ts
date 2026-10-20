// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SEC-AUDIT-IGNORE-BOUND-001 (M landing for R2-AR-08, lane R2-U)
 *
 * `pnpm audit` の ignore 集合を固定する。braces `GHSA-vfj7-8cjw-p6xm` (high、patched 版なし) は
 * accepted-risk R2-AR-08 として root `package.json` の `pnpm.auditConfig.ignoreGhsas` で除外する
 * (security-deps R2 addendum v1 §2.4 / §5.4、User 判断 UD-A2 = (α))。**ignore は修正ではない**。
 * braces 3.0.3 は lockfile に残る。本 INV は ignore が黙って広がる経路と、accepted-risk の前提
 * (braces が production 閉包に入らない) が崩れる経路を CI で RED にする。
 *
 * Pins the `pnpm audit` ignore set. braces GHSA-vfj7-8cjw-p6xm (high, no patched release) is an
 * accepted risk (R2-AR-08) excluded via the root `pnpm.auditConfig.ignoreGhsas`. The ignore is NOT a
 * fix; braces 3.0.3 stays in the lockfile. This test fails when the ignore set silently grows or
 * when the accepted-risk premise (braces outside the production closure) no longer holds.
 *
 * | leg | 契約 / contract                                                                               |
 * | --- | --------------------------------------------------------------------------------------------- |
 * | (1) | root `package.json` `pnpm.auditConfig` のキー集合 ⊆ {`ignoreGhsas`}、`ignoreGhsas` は        |
 * |     | [`GHSA-vfj7-8cjw-p6xm`] ちょうど / keys ⊆ {ignoreGhsas}, ignoreGhsas is exactly that one ID     |
 * | (2) | `ignoreCves` は無い (空配列も不可) / no `ignoreCves`, not even an empty array                   |
 * | (3) | `pnpm-workspace.yaml` に `auditConfig` が無い / no `auditConfig` in the workspace file        |
 * | (4) | `.github/workflows/*.yml` の `pnpm audit` 呼出に `--ignore` / `--ignore-unfixable` が無い     |
 * | (5) | ignore する各 ID に R2-AR-08 参照・解除条件・tracked ID (CO-R2-41) の行がある (集合一致)      |
 * | (6) | lockfile の全 importer の `dependencies` ∪ `optionalDependencies` から辿る snapshot 推移閉包  |
 * |     | に `braces@*` が 0 (addendum registry v1 E-58) / braces absent from the production closure    |
 *
 * leg (6) の閉包: importer の `link:` は対象 importer へ辿り、alias (`name: other@1.2.3`) は
 * `other@1.2.3` の snapshot へ辿る。snapshot が見つからない参照は violation (fail-closed)。
 * devDependencies は辿らない (braces の公開経路は 0。private 経路 = tools/tda-instruments の jscpd と
 * example/reftrix4 の eslint-config-next 16.3.8 は dev のみ)。
 * The closure follows `link:` to the target importer and aliases to their snapshot key; an
 * unresolvable reference is a violation (fail-closed). devDependencies are not followed.
 *
 * 非空虚性 / Non-vacuity: (a) 各 leg は読み出した値を引数に取る純関数で、control fixture (test 内の
 * オブジェクト / 文字列) で ID 追加・`ignoreCves` 追加・workspace の `auditConfig`・workflow の
 * `--ignore-unfixable` / `--ignore`・表の欠落・prod 配下の braces が RED、dev 配下の braces は GREEN
 * になることを assert する。(b) locator: 実 file の読取結果が空なら RED、workflow の `pnpm audit`
 * 呼出 ≥ 1、閉包関数で `apps/mcp-server` から `cheerio` と `undici` に到達する (≥ 1)。
 *
 * 解除 / Release (addendum v1 §2.4.2 / §5.4): braces の patched 版公開、または
 * `@next/eslint-plugin-next` が fast-glob 3.3.3+ / micromatch 非依存へ移行し、かつ jscpd 経路
 * (tools/tda-instruments) も range 外になった時点で、ignore と本 INV の pin を同一 commit で外す。
 * leg (6) が RED になったら ignore を外して再裁定する (M → H 候補)。**ignore を広げて GREEN に
 * することは禁止** (E-58)。ネットワークを使う解除条件の確認 (`npm view` / `gh api`) は本 test に
 * 入れず CO-R2-41 の refresh で手動記録する。
 * When the release condition holds, drop the ignore and this pin in one commit. If leg (6) turns
 * RED, remove the ignore and re-adjudicate; widening the ignore to go GREEN is forbidden.
 *
 * 配置 / Placement: INV-SEC-OVERRIDE-BOUND-001 (harness) と同 directory の別 file (harness を編集しない、
 * helper を copy しない、別 `.test.ts` から import しない = E-60)。共有 helper は非 test module
 * `../_shared/semver-lockfile` からのみ import する (CO-R2-36、現状は `REPO_ROOT` のみ)。YAML / lockfile は root
 * devDependency の `js-yaml` で parse する。4 常設ドメインの不変条件そのものではなく harness 隣接の
 * precedent として large-page に置く。
 *
 * Plan: security-deps-remediation-r2-plan-addendum-v1.md §2.4 / §5.4 / §8.1.
 * Registry: r2 addendum finding registry v1 §2 / E-58 / E-60 (U6-a = inside R2-U).
 * Regression domain: large-page.
 */

// INV-SEC-AUDIT-IGNORE-BOUND-001

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { lockfileClosure } from "../_shared/lockfile-closure";
import { REPO_ROOT } from "../_shared/semver-lockfile";

/** 許可する `pnpm.auditConfig` のキー / the only allowed `pnpm.auditConfig` key */
const ALLOWED_AUDIT_CONFIG_KEYS: readonly string[] = ["ignoreGhsas"];

interface IgnoreRecord {
  /** GHSA ID (`ignoreGhsas` の要素) */
  id: string;
  /** 対象 package / affected package */
  pkg: string;
  /** accepted-risk 記録 / accepted-risk record */
  acceptedRisk: string;
  /** tracked carryover */
  tracked: string;
  /** 解除条件 / release condition */
  release: string;
}

/**
 * ignore する ID の表 (leg (5))。行を足すには accepted-risk 記録と IO 裁定が要る。
 * Table of ignored IDs; adding a row requires an accepted-risk record and an IO ruling.
 */
const IGNORE_TABLE: readonly IgnoreRecord[] = [
  {
    id: "GHSA-vfj7-8cjw-p6xm",
    pkg: "braces",
    acceptedRisk: "R2-AR-08",
    tracked: "CO-R2-41",
    release:
      "braces patched release, or @next/eslint-plugin-next leaves fast-glob 3.3.1 / micromatch and the jscpd path (tools/tda-instruments) is out of range",
  },
];

/** braces の snapshot key 接頭辞 / snapshot key prefix of braces */
const BRACES_PREFIX = "braces@";

// ---------------------------------------------------------------------------
// 読み出し / readers (読取結果が空なら throw = RED)
// ---------------------------------------------------------------------------

function readNonEmpty(path: string): string {
  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) throw new Error(`読取結果が空 / empty read: ${path}`);
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface WorkflowFile {
  path: string;
  text: string;
}

function readWorkflows(repoRoot: string): WorkflowFile[] {
  const dir = join(repoRoot, ".github", "workflows");
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({ path: `.github/workflows/${name}`, text: readNonEmpty(join(dir, name)) }));
}

// ---------------------------------------------------------------------------
// legs (読み出した値を引数に取る純関数 = control fixture から再利用)
// ---------------------------------------------------------------------------

/** legs (1)(2): root manifest の `pnpm.auditConfig` */
function checkAuditConfig(manifest: unknown): string[] {
  if (!isRecord(manifest)) return ["(1) root package.json が object でない"];
  const pnpmField = manifest.pnpm;
  const auditConfig = isRecord(pnpmField) ? pnpmField.auditConfig : undefined;
  if (!isRecord(auditConfig)) return ["(1) pnpm.auditConfig が無い (ignore 集合を pin できない)"];
  const violations: string[] = [];
  for (const key of Object.keys(auditConfig)) {
    if (key === "ignoreCves")
      violations.push("(2) pnpm.auditConfig.ignoreCves がある (空配列も不可)");
    else if (!ALLOWED_AUDIT_CONFIG_KEYS.includes(key))
      violations.push(`(1) pnpm.auditConfig に許可外のキー ${key}`);
  }
  const ids = auditConfig.ignoreGhsas;
  const expected = IGNORE_TABLE.map((row) => row.id).sort();
  if (!Array.isArray(ids)) {
    violations.push("(1) pnpm.auditConfig.ignoreGhsas が配列でない");
  } else if (JSON.stringify([...ids].sort()) !== JSON.stringify(expected)) {
    violations.push(
      `(1) ignoreGhsas = [${ids.join(", ")}] が期待集合 [${expected.join(", ")}] と一致しない`
    );
  }
  return violations;
}

/** leg (3): `pnpm-workspace.yaml` に `auditConfig` が無い */
function checkWorkspace(workspace: unknown): string[] {
  if (!isRecord(workspace)) return ["(3) pnpm-workspace.yaml が mapping でない"];
  return "auditConfig" in workspace ? ["(3) pnpm-workspace.yaml に auditConfig がある"] : [];
}

/** leg (4): workflow の `pnpm audit` 呼出に `--ignore*` が無い。呼出 0 件も RED (locator) */
function checkWorkflows(files: readonly WorkflowFile[]): string[] {
  const violations: string[] = [];
  let calls = 0;
  for (const file of files) {
    file.text.split("\n").forEach((line, index) => {
      if (!/\bpnpm\s+audit\b/.test(line)) return;
      calls += 1;
      if (/--ignore/.test(line))
        violations.push(`(4) ${file.path}:${index + 1} の pnpm audit に --ignore 系 flag がある`);
    });
  }
  if (calls === 0) violations.push("(4) workflow に pnpm audit 呼出が 1 件も無い (locator)");
  return violations;
}

/** leg (5): ignore した ID の集合 = 表の ID 集合、各行に記録・解除条件・tracked がある */
function checkIgnoreTable(
  ignored: readonly string[],
  table: readonly IgnoreRecord[] = IGNORE_TABLE
): string[] {
  const violations: string[] = [];
  const tableIds = new Set(table.map((row) => row.id));
  for (const id of ignored) {
    if (!tableIds.has(id)) violations.push(`(5) ${id}: ignore 表に行が無い`);
  }
  for (const row of table) {
    if (!ignored.includes(row.id)) violations.push(`(5) ${row.id}: 表にあるが ignore されていない`);
    if (row.acceptedRisk !== "R2-AR-08" || row.tracked !== "CO-R2-41" || row.release.length === 0)
      violations.push(`(5) ${row.id}: accepted-risk / tracked / 解除条件が欠けている`);
  }
  return violations;
}

function checkProdBraces(lock: unknown): string[] {
  const closure = lockfileClosure(lock, undefined, { includeDev: false });
  const braces = [...closure.keys].filter((key) => key.startsWith(BRACES_PREFIX)).sort();
  return [
    ...closure.unresolved.map((reason) => `(6) 閉包を辿れない (fail-closed): ${reason}`),
    ...braces.map(
      (key) => `(6) ${key} が production 閉包にある (accepted-risk R2-AR-08 の前提が崩れた)`
    ),
  ];
}

// ---------------------------------------------------------------------------
// 実 assert / the real asserts
// ---------------------------------------------------------------------------

describe("INV-SEC-AUDIT-IGNORE-BOUND-001 (large-page)", () => {
  const manifest: unknown = JSON.parse(readNonEmpty(join(REPO_ROOT, "package.json")));
  const workspace: unknown = load(readNonEmpty(join(REPO_ROOT, "pnpm-workspace.yaml")));
  const lock: unknown = load(readNonEmpty(join(REPO_ROOT, "pnpm-lock.yaml")));
  const workflows = readWorkflows(REPO_ROOT);

  it("(1)(2) pnpm.auditConfig = { ignoreGhsas: [GHSA-vfj7-8cjw-p6xm] } ちょうど、ignoreCves なし", () => {
    expect(checkAuditConfig(manifest)).toEqual([]);
  });

  it("(3) pnpm-workspace.yaml に auditConfig が無い", () => {
    expect(checkWorkspace(workspace)).toEqual([]);
  });

  it("(4) workflow の pnpm audit 呼出 (>= 1) に --ignore / --ignore-unfixable が無い", () => {
    expect(workflows.length).toBeGreaterThanOrEqual(1);
    expect(checkWorkflows(workflows)).toEqual([]);
  });

  it("(5) ignore した ID ごとに R2-AR-08 / 解除条件 / CO-R2-41 の行がある (集合一致)", () => {
    const pnpmField = (manifest as { pnpm?: { auditConfig?: { ignoreGhsas?: string[] } } }).pnpm;
    expect(checkIgnoreTable(pnpmField?.auditConfig?.ignoreGhsas ?? [])).toEqual([]);
  });

  it("(6) 全 importer の production 閉包に braces@* が 0 (E-58)", () => {
    expect(checkProdBraces(lock)).toEqual([]);
  });

  it("(6) locator: 閉包関数で apps/mcp-server から cheerio と undici に到達する (>= 1)", () => {
    const closure = lockfileClosure(lock, ["apps/mcp-server"], { includeDev: false });
    expect(closure.unresolved).toEqual([]);
    const keys = [...closure.keys];
    expect(keys.filter((key) => key.startsWith("cheerio@")).length).toBeGreaterThanOrEqual(1);
    expect(keys.filter((key) => key.startsWith("undici@")).length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // control fixtures (非空虚性 / non-vacuity): 各 leg が実際に RED を返せることを固定する
  // -------------------------------------------------------------------------
  describe("control fixtures", () => {
    const baseManifest = { pnpm: { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } } };

    it("(1)(2) baseline fixture は GREEN、ID 追加 / ignoreCves / 空 ignoreCves / 許可外キー / 欠落は RED", () => {
      expect(checkAuditConfig(baseManifest)).toEqual([]);
      const cases: unknown[] = [
        { pnpm: { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm", "GHSA-vcvr-r3jv-pc5j"] } } },
        {
          pnpm: {
            auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"], ignoreCves: ["CVE-2026-93687"] },
          },
        },
        { pnpm: { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"], ignoreCves: [] } } },
        { pnpm: { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"], ignoreUnfixable: true } } },
        { pnpm: { auditConfig: { ignoreGhsas: [] } } },
        { pnpm: {} },
      ];
      for (const fixture of cases)
        expect(checkAuditConfig(fixture).length).toBeGreaterThanOrEqual(1);
    });

    it("(3) workspace に auditConfig を置く → RED", () => {
      expect(checkWorkspace({ packages: ["apps/*"] })).toEqual([]);
      expect(
        checkWorkspace({ packages: ["apps/*"], auditConfig: { ignoreGhsas: ["GHSA-x"] } })
      ).toHaveLength(1);
    });

    it("(4) --ignore-unfixable / --ignore <CVE> / 呼出 0 件 → RED", () => {
      const ok = [{ path: "ci.yml", text: "      - run: pnpm audit --audit-level=high\n" }];
      expect(checkWorkflows(ok)).toEqual([]);
      for (const line of [
        "      - run: pnpm audit --audit-level=high --ignore-unfixable",
        "      - run: pnpm audit --ignore CVE-2026-93687",
      ]) {
        expect(checkWorkflows([{ path: "ci.yml", text: `${line}\n` }])).toHaveLength(1);
      }
      expect(checkWorkflows([{ path: "ci.yml", text: "      - run: pnpm lint\n" }])).toHaveLength(
        1
      );
    });

    it("(5) 表に無い ID / ignore されていない表の行 → RED", () => {
      expect(checkIgnoreTable(["GHSA-vfj7-8cjw-p6xm", "GHSA-x4vx-rjvf-j5p4"]).length).toBe(1);
      expect(checkIgnoreTable([]).length).toBe(1);
    });

    it("(6) braces を prod (dependencies / optionalDependencies / link: 経由) に置く → RED、dev のみは GREEN", () => {
      const snapshots = {
        "fast-glob@3.3.3": { dependencies: { micromatch: "4.0.8" } },
        "micromatch@4.0.8": { dependencies: { braces: "3.0.3" } },
        "braces@3.0.3": {},
        "cheerio@1.2.0": { dependencies: { undici: "7.30.0" } },
        "undici@7.30.0": {},
      };
      const devOnly = {
        importers: {
          "apps/x": { devDependencies: { "fast-glob": { specifier: "^3", version: "3.3.3" } } },
        },
        snapshots,
      };
      expect(checkProdBraces(devOnly)).toEqual([]);
      const prodDep = {
        importers: {
          "apps/x": { dependencies: { "fast-glob": { specifier: "^3", version: "3.3.3" } } },
        },
        snapshots,
      };
      expect(checkProdBraces(prodDep).some((v) => v.includes("braces@3.0.3"))).toBe(true);
      const optionalDep = {
        importers: {
          "apps/x": { optionalDependencies: { micromatch: { specifier: "^4", version: "4.0.8" } } },
        },
        snapshots,
      };
      expect(checkProdBraces(optionalDep).some((v) => v.includes("braces@3.0.3"))).toBe(true);
      const viaLink = {
        importers: {
          "apps/x": {
            dependencies: {
              "@r/lib": { specifier: "workspace:*", version: "link:../../packages/lib" },
            },
          },
          "packages/lib": { dependencies: { micromatch: { specifier: "^4", version: "4.0.8" } } },
        },
        snapshots,
      };
      expect(checkProdBraces(viaLink).some((v) => v.includes("braces@3.0.3"))).toBe(true);
      const viaAlias = {
        importers: {
          "apps/x": {
            dependencies: { mm: { specifier: "npm:micromatch@4", version: "micromatch@4.0.8" } },
          },
        },
        snapshots,
      };
      expect(checkProdBraces(viaAlias).some((v) => v.includes("braces@3.0.3"))).toBe(true);
      const located = lockfileClosure(
        {
          importers: {
            "apps/x": { dependencies: { cheerio: { specifier: "^1", version: "1.2.0" } } },
          },
          snapshots,
        },
        ["apps/x"],
        { includeDev: false }
      );
      expect([...located.keys].sort()).toEqual(["cheerio@1.2.0", "undici@7.30.0"]);
    });

    it("(6) snapshot が見つからない参照 / importers 欠落 → RED (fail-closed)", () => {
      const missing = {
        importers: { "apps/x": { dependencies: { ghost: { specifier: "^1", version: "1.0.0" } } } },
        snapshots: {},
      };
      expect(checkProdBraces(missing).some((v) => v.includes("ghost@1.0.0"))).toBe(true);
      expect(checkProdBraces({})).toHaveLength(1);
    });
  });
});
