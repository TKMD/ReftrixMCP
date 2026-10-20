// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SEC-DOMPURIFY-DECLARED-RANGE-001 (M), public half
 *
 * 公開側 (OSS 同期される) の半分: `apps/mcp-server/package.json` の `dependencies.dompurify` 宣言だけを読む。
 * `apps/cli` / `apps/webui` の宣言は OSS 配布物に含まれないため、private 専用の兄弟 file
 * (`inv-sec-dompurify-declared-range-001-private-manifests.test.ts`、`.ossfilter` で除外) が読む。
 * 2 file に分ける理由: 1 file に cli / webui を入れると OSS tree で ENOENT になり、
 * 「private かどうか」を実行時に判定する分岐が要る (fail-open の面になる)。分けると分岐が無い。
 * Public half (synced to OSS): reads only the `apps/mcp-server` declaration. The `apps/cli` and
 * `apps/webui` declarations are not shipped to OSS, so a private-only sibling file (excluded by
 * `.ossfilter`) reads them. Splitting avoids a run-time "is this private?" branch (a fail-open surface).
 *
 * 命題 / Proposition (each manifest):
 *   (a)  `dependencies.dompurify` が存在し `parseSimpleRange` で non-null
 *   (a') 宣言形は `^` / `~` のみ (上限の無い `>=` 等は RED)
 *   (b)  floor >= 3.4.16
 *   (c)  3.4.15 / 3.4.13 / 3.4.12 を 1 つも admit しない
 * 上限は命題に入れない。override 側の上限は `inv-sec-override-bound-001` が pin する。
 * The declared upper bound is not part of the proposition; the override cap is pinned by the harness.
 *
 * 限界 / Limits (2 points):
 *   1. 公開済の版 (`latest` 0.6.0 / `beta` 0.6.1-beta.1) の宣言 (`^3.4.0`) は次の publish まで変わらない。
 *      The declarations of the already-published versions stay `^3.4.0` until the next publish.
 *   2. root override は npm consumer の install に効かない。consumer に届くのは宣言だけ。
 *      The root override never reaches an npm consumer; only the declaration does.
 *
 * 非空虚性 / Non-vacuity: leg は (repo root) の純関数。mutation control は同一関数を `os.tmpdir()` の
 * fixture に向ける (実 repo は不変)。読んだ manifest 数 = 1 を assert する。
 * The legs are pure functions of the repo root; the controls point them at a tmp fixture, and the
 * number of manifests read must be exactly 1.
 *
 * Regression domain: large-page.
 */

// INV-SEC-DOMPURIFY-DECLARED-RANGE-001

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  compareVersion,
  formatVersion,
  parseSimpleRange,
  parseVersion,
  rangeAdmits,
  REPO_ROOT,
} from "../_shared/semver-lockfile";

/** この file が読む manifest (repo root 相対) / manifests this file reads */
const MANIFEST_DIRS: readonly string[] = ["apps/mcp-server"];
const PATCHED_FLOOR = "3.4.16";
/** 宣言が 1 つも admit してはならない版 (GHSA-6688 / p98j の上端・下端と 3.4.12) */
const VULNERABLE_PROBES: readonly string[] = ["3.4.15", "3.4.13", "3.4.12"];

interface ManifestRead {
  dir: string;
  /** manifest を読めなければ null (ENOENT / 不正 JSON は violation になる、skip しない) */
  declared: string | null | undefined;
  failure?: string;
}

function readManifest(repoRoot: string, dir: string): ManifestRead {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return { dir, declared: pkg.dependencies?.dompurify };
  } catch (error) {
    return { dir, declared: null, failure: (error as NodeJS.ErrnoException).code ?? "unreadable" };
  }
}

/** 全 leg を 1 つの純関数に束ねる / all legs as one pure function of the repo root */
function checkDeclared(repoRoot: string = REPO_ROOT): string[] {
  const reads = MANIFEST_DIRS.map((dir) => readManifest(repoRoot, dir));
  const violations: string[] = [];
  if (reads.length !== 1) violations.push(`(guard) 読んだ manifest 数 ${reads.length} (期待 1)`);
  const floor = parseVersion(PATCHED_FLOOR);
  if (floor === null) return [...violations, "table 契約の破綻: PATCHED_FLOOR"];
  for (const { dir, declared, failure } of reads) {
    if (failure !== undefined) {
      violations.push(`(a) ${dir}/package.json を読めない (${failure}, fail-closed)`);
      continue;
    }
    if (typeof declared !== "string") {
      violations.push(`(a) ${dir}: dependencies.dompurify の宣言が無い`);
      continue;
    }
    const spec = parseSimpleRange(declared);
    if (spec === null) {
      violations.push(`(a) ${dir}: "${declared}" は対応形 (^ / ~ / >= / 完全一致) ではない`);
      continue;
    }
    if (!/^[\^~]/.test(declared.trim())) {
      violations.push(`(a') ${dir}: "${declared}" は ^ / ~ の形ではない`);
    }
    if (compareVersion(spec.floor, floor) < 0) {
      violations.push(
        `(b) ${dir}: "${declared}" の floor ${formatVersion(spec.floor)} が ${PATCHED_FLOOR} 未満`
      );
    }
    for (const probe of VULNERABLE_PROBES) {
      const version = parseVersion(probe);
      if (version !== null && rangeAdmits(spec, version)) {
        violations.push(`(c) ${dir}: "${declared}" が脆弱版 ${probe} を admit する`);
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// fixture tree (os.tmpdir、実 repo は不変) / fixture tree (the real repo is untouched)
// ---------------------------------------------------------------------------

const fixtureRoots: string[] = [];

/** `declared`: 宣言 (`null` で欠落)、`dropManifest`: manifest file ごと欠落 (ENOENT) */
function writeFixtureRoot(
  options: { declared?: string | null; dropManifest?: boolean } = {}
): string {
  const root = mkdtempSync(join(tmpdir(), "inv-sec-dompurify-declared-range-"));
  fixtureRoots.push(root);
  if (options.dropManifest === true) return root;
  const declared = options.declared === undefined ? "^3.4.16" : options.declared;
  for (const dir of MANIFEST_DIRS) {
    mkdirSync(join(root, dir), { recursive: true });
    const dependencies = declared === null ? {} : { dompurify: declared };
    writeFileSync(
      join(root, dir, "package.json"),
      `${JSON.stringify({ dependencies }, null, 2)}\n`
    );
  }
  return root;
}

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 実 assert / the real asserts
// ---------------------------------------------------------------------------

describe("INV-SEC-DOMPURIFY-DECLARED-RANGE-001 public half (large-page)", () => {
  it("(a)(a')(b)(c) apps/mcp-server の dompurify 宣言が 3.4.16 以上で脆弱版を admit しない", () => {
    expect(checkDeclared()).toEqual([]);
  });

  it("非空虚 guard: 読む manifest は 1 つ", () => {
    expect(MANIFEST_DIRS).toEqual(["apps/mcp-server"]);
    expect(readManifest(REPO_ROOT, "apps/mcp-server").declared).toEqual(expect.any(String));
  });

  describe("mutation controls (非空虚性 / non-vacuity)", () => {
    it("positive control: 健全な fixture (^3.4.16) では違反 0", () => {
      expect(checkDeclared(writeFixtureRoot())).toEqual([]);
    });

    it.each([
      ["(i) ^3.4.13", "^3.4.13"],
      ["(ii) ^3.4.0", "^3.4.0"],
      ["(iv) ^3.4.15", "^3.4.15"],
    ])("%s は (b)(c) で RED", (_label, declared) => {
      const v = checkDeclared(writeFixtureRoot({ declared }));
      expect(v.some((s) => s.startsWith("(b)"))).toBe(true);
      expect(v.some((s) => s.startsWith("(c)"))).toBe(true);
    });

    it("(iii) 宣言の欠落は RED (skip しない)", () => {
      expect(checkDeclared(writeFixtureRoot({ declared: null }))).toEqual([
        "(a) apps/mcp-server: dependencies.dompurify の宣言が無い",
      ]);
    });

    it("(iii) manifest file の欠落 (ENOENT) は RED (skip しない)", () => {
      expect(checkDeclared(writeFixtureRoot({ dropManifest: true }))).toEqual([
        "(a) apps/mcp-server/package.json を読めない (ENOENT, fail-closed)",
      ]);
    });

    it("(v) >=3.4.16 は (a') のみ RED ((a)(b)(c) は GREEN のまま)", () => {
      expect(checkDeclared(writeFixtureRoot({ declared: ">=3.4.16" }))).toEqual([
        '(a\') apps/mcp-server: ">=3.4.16" は ^ / ~ の形ではない',
      ]);
    });
  });
});
