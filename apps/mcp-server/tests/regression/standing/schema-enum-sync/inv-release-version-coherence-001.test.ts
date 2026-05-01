// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-RELEASE-VERSION-COHERENCE-001
 *
 * git tag-on-HEAD と publishable packages `package.json.version` の equality を
 * CI 時点で保証する不変条件。
 *
 * v0.5.1 release cycle Phase 4 で発見された **T1 drift** (5 publishable
 * packages の `package.json.version` が `0.5.0` のまま残存していた一方、
 * git tag `v0.5.1` は新規 commit に annotated push 済 + Plan / ADR /
 * 3-CHANGELOG (T2/T3) は v0.5.1 を表現済) の構造的盲点を埋める。
 *
 * IO Final Consistency Check (anchor `019de2bf`) では検出漏れ。原因は
 * `git tag --points-at HEAD` と publishable `package.json.version` の equality
 * を CI で fail させる standing regression test が存在しなかったため (severity H、
 * deadline next commit、anchor `019de2f7-f13b-752f-8991-f67802ed98b5` で landing)。
 *
 * Closes the structural blind spot revealed during the v0.5.1 release-cycle
 * Phase 4: 5 publishable packages still pinned to `0.5.0` even though git tag
 * `v0.5.1` was annotated-pushed onto a new commit and Plan / ADR / 3-CHANGELOG
 * (T2/T3) already expressed v0.5.1. The IO Final Consistency Check (anchor
 * `019de2bf`) missed it because no standing regression test asserted equality
 * between `git tag --points-at HEAD` and publishable `package.json.version`.
 *
 * # Behavior / 挙動
 *
 * 1. `git tag --points-at HEAD` を実行 (Node.js child_process)。
 * 2. tag が `v\d+\.\d+\.\d+` pattern にマッチする annotated tag であれば
 *    semantic version `X.Y.Z` を抽出。複数 tag (例: v0.5.1 と latest 両方が
 *    同じ commit に pinned) の場合、最も specific な version-tag (X.Y.Z 形式)
 *    を採用 (alphabetical sort で `latest` より version-tag が後になるため
 *    最後にマッチするものを採用)。
 * 3. tag が存在しないコミット (ブランチ作業中の通常 commit) では本 invariant
 *    は **skip** (HEAD が release commit でない時に強制 fail させない)。
 * 4. tag が抽出できる場合、以下 5 packages の `package.json.version` を読み、
 *    すべて tag version と一致することを assert:
 *    - `apps/mcp-server/package.json`
 *    - `packages/core/package.json`
 *    - `packages/database/package.json`
 *    - `packages/ml/package.json`
 *    - `packages/webdesign-core/package.json`
 * 5. 不一致があれば test failure with diagnostic message:
 *    `[INV-RELEASE-VERSION-COHERENCE-001] tag=vX.Y.Z, packages with mismatched
 *    version: ['<path>:<actual>']`.
 *
 * # Notes / 補足
 *
 * - root `package.json` は publishable list に含めない (monorepo root は
 *   別 semantic で、現在 `0.5.0` のまま意図的に残存)。
 * - `package.json` 読み込みエラー時 (file not found 等) は test fail
 *   (`H` invariant の diagnostic value を保つため)。
 * - 本 test は厳密には schema/enum sync ではないが、**SSOT-driven equality
 *   検証** という共通カテゴリに属するため schema-enum-sync domain に landing
 *
 * @see internal anchor `019de2f7-f13b-752f-8991-f67802ed98b5` (IO Decision
 *      U-7 unblock 条件)
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

/**
 * Publishable packages whose `package.json.version` MUST equal the tag-on-HEAD
 * semantic version. Root `package.json` is intentionally excluded (different
 * semantic — monorepo root is not published).
 *
 * v0.5.1 contract per ADR-0020 / IO Decision U-7.
 */
const PUBLISHABLE_PACKAGE_PATHS: readonly string[] = [
  "apps/mcp-server/package.json",
  "packages/core/package.json",
  "packages/database/package.json",
  "packages/ml/package.json",
  "packages/webdesign-core/package.json",
];

/**
 * Pattern matching annotated release tags of the form `vX.Y.Z`. Pre-release
 * suffixes (e.g. `v0.5.1-rc.1`) are intentionally NOT matched — only fully
 * baked semantic version tags trigger the equality check. This avoids false
 * positives on intermediate `-rc` / `-beta` tags where package.json drift is
 * acceptable until the final tag.
 *
 * Capture group 1: the bare `X.Y.Z` semver (without leading `v`).
 */
const VERSION_TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/;

/**
 * Resolve the repository root by invoking `git rev-parse --show-toplevel`.
 * Robust against vitest's cwd variation across run modes (root `pnpm test:*`
 * vs. workspace-scoped invocations).
 */
function resolveRepoRoot(): string {
  return execSync("git rev-parse --show-toplevel", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Extract the most specific `vX.Y.Z` tag pointing at HEAD, or `null` if no
 * such tag exists (HEAD is a non-release commit).
 *
 * When multiple tags point at HEAD (e.g. `v0.5.1` + `latest` aliasing the same
 * commit), only `vX.Y.Z`-shaped tags participate; if more than one matches,
 * the lexicographically last is taken (deterministic tiebreak — in practice
 * release tags are unique per commit, so this is a safety net).
 */
function getReleaseTagOnHead(repoRoot: string): string | null {
  const raw = execSync("git tag --points-at HEAD", {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const versionTags = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line): line is string => VERSION_TAG_PATTERN.test(line))
    .sort();

  if (versionTags.length === 0) {
    return null;
  }
  // Pick the last (most specific in lex order). For typical single-tag releases
  // this is the only entry.
  return versionTags[versionTags.length - 1] ?? null;
}

/**
 * Read `package.json` at `repoRoot/relPath` and return its `version` string.
 * Throws if the file is missing or unparseable — by design (H severity demands
 * loud failure, not silent skip).
 */
function readPackageVersion(repoRoot: string, relPath: string): string {
  const absolutePath = join(repoRoot, relPath);
  const raw = readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`[INV-RELEASE-VERSION-COHERENCE-001] ${relPath} has no string "version" field`);
  }
  return parsed.version;
}

describe("INV-RELEASE-VERSION-COHERENCE-001: tag-on-HEAD ↔ publishable package.json version equality", () => {
  beforeEach(() =>
    assertInvName(expect.getState().currentTestName ?? "", "INV-RELEASE-VERSION-COHERENCE-001")
  );

  it("INV-RELEASE-VERSION-COHERENCE-001: all publishable packages match the vX.Y.Z tag pointing at HEAD (skipped when HEAD has no release tag)", () => {
    const repoRoot = resolveRepoRoot();
    const tag = getReleaseTagOnHead(repoRoot);

    if (tag === null) {
      // HEAD is a non-release commit (typical branch state). The invariant
      // does not apply — skip without failing. CI runs that wish to enforce
      // version coherence outside of release commits should ALSO assert that
      // a tag exists, but that is out of scope for this invariant.
      console.info(
        "[INV-RELEASE-VERSION-COHERENCE-001] HEAD has no vX.Y.Z tag; invariant does not apply (skipping equality check)."
      );
      return;
    }

    const expectedVersion = tag.replace(/^v/, "");
    const mismatches: string[] = [];

    for (const relPath of PUBLISHABLE_PACKAGE_PATHS) {
      const actual = readPackageVersion(repoRoot, relPath);
      if (actual !== expectedVersion) {
        mismatches.push(`${relPath}:${actual}`);
      }
    }

    if (mismatches.length > 0) {
      throw new Error(
        `[INV-RELEASE-VERSION-COHERENCE-001] tag=${tag}, packages with mismatched version: ${JSON.stringify(
          mismatches
        )}`
      );
    }

    // Sanity: verify all 5 packages were checked (defends against silent
    // PUBLISHABLE_PACKAGE_PATHS truncation regressions).
    expect(PUBLISHABLE_PACKAGE_PATHS).toHaveLength(5);
  });
});
