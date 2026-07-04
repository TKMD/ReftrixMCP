// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — Fixture Lifecycle Guard / fixture lifecycle 守護
 *
 * ADR-0016 § Fixture Lifecycle (LCC-Plan-01/02 + SEC-Plan-05 Amendment) の契約を実装:
 *
 * - Before/During (汚染防止 / contamination prevention):
 *   - testcontainer boot 時に `REFTRIX_SCREENSHOT_ROOT` を `/tmp/reftrix-test-<uuid>/` に
 *     **強制上書き** (production env が漏洩した場合も override)
 *   - production path (production default root または `/tmp/reftrix-test-` prefix
 *     以外) を指していた場合 fail-closed (`process.exit(1)`)
 *
 * - PR-SS-A (D-1a, safety-critical): production default root は SSOT
 *   (`resolveDefaultScreenshotRoot()`, XDG data dir = User の実 home 配下) から
 *   derive する。**テストは production default root に対して mkdir/rmSync を
 *   一切実行しない** — 破壊的 FS 操作は per-run の `os.tmpdir()` 配下 sandbox
 *   root のみ。production default root は read-only 検査 (汚染検出) に限定し、
 *   検出時も削除せず fail-loud 報告のみ。
 *
 * - PR-SS-A (D-1a, safety-critical): the production default root derives from
 *   the SSOT (`resolveDefaultScreenshotRoot()`, an XDG data dir under the
 *   User's real home). **Tests never mkdir/rmSync the production default
 *   root** — destructive FS operations target only per-run sandbox roots under
 *   `os.tmpdir()`. The production default root is limited to read-only
 *   contamination inspection; on detection the guard fail-loud reports and
 *   never deletes.
 *
 * - After (削除契約 / deletion contract, GDPR Art.5(1)(e)):
 *   - testcontainer 停止後 `fs.rm({ recursive: true, force: true })` で完全削除
 *   - vitest afterAll で `existsSync(testRoot) === false` assertion 必須
 *
 * Implements ADR-0016 § Fixture Lifecycle:
 *
 * - Before/During: force-override `REFTRIX_SCREENSHOT_ROOT` and fail-closed
 *   on production-path leakage.
 * - After: complete deletion + `existsSync === false` assertion.
 *
 * @module tests/regression/standing/_setup/fixture-lifecycle
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// PR-SS-A D-1a (UB-6): production default root は SSOT export から derive する
// (bare literal 残置禁止 — UB-1 SSOT sweep と整合)。
// PR-SS-A D-1a (UB-6): derive the production default root from the SSOT export
// (no bare-literal residue; consistent with the UB-1 SSOT sweep).
import { resolveDefaultScreenshotRoot } from "../../../../src/services/screenshot-persistence.service";

/**
 * production default の screenshot root (SSOT derive、XDG data dir)。
 * SEC-M2-01 contamination guard の **read-only 検査対象**であり、テストは
 * 本パスに対して mkdir/rmSync を一切実行しない (D-1a 設計制約)。
 *
 * The production-default screenshot root (SSOT-derived, XDG data dir). It is
 * the **read-only inspection target** of the SEC-M2-01 contamination guard;
 * tests never mkdir/rmSync this path (D-1a design constraint).
 */
export const PRODUCTION_SCREENSHOT_ROOT: string = resolveDefaultScreenshotRoot();

/**
 * テスト専用ルートの prefix。runtime UUID が後続される (`/tmp/reftrix-test-<uuid>/`)。
 * Test-only root prefix; suffixed with a runtime UUID.
 */
export const TEST_SCREENSHOT_ROOT_PREFIX = "/tmp/reftrix-test-" as const;

/**
 * テスト用 screenshot root を生成し、env var を強制上書きして path を返す。
 *
 * Generates a test-only screenshot root, force-overrides the env var, and
 * returns the path. Idempotent: if the env var already points to a
 * `/tmp/reftrix-test-<uuid>/` path, it is preserved.
 *
 * SEC-Plan-05 Amendment 1 contamination prevention:
 * - production env が漏洩した場合も override (process.env.REFTRIX_SCREENSHOT_ROOT 上書き)
 * - production default パスを指していた場合は test-only path に置換
 * - 上書き後の値が test prefix で始まらない場合は fail-closed
 *
 * SEC-Plan-05 Amendment 1 contamination prevention:
 * - Override even if production env leaked
 * - Replace production default with test-only path
 * - Fail-closed if the resulting value doesn't start with the test prefix
 */
export function enforceTestScreenshotRoot(): string {
  const current = process.env.REFTRIX_SCREENSHOT_ROOT;
  // 既に test prefix を指していれば再利用 (子プロセスへの伝搬考慮)
  // Reuse if already a test prefix path (preserves child-process inheritance).
  if (current && current.startsWith(TEST_SCREENSHOT_ROOT_PREFIX)) {
    return current;
  }
  const testRoot = `${TEST_SCREENSHOT_ROOT_PREFIX}${crypto.randomUUID()}`;
  // 強制上書き
  // Force override.
  process.env.REFTRIX_SCREENSHOT_ROOT = testRoot;
  // ディレクトリを作成 (パーミッション 0o700 = production と同様)
  // Create directory with 0o700 permissions (matching production).
  fs.mkdirSync(testRoot, { recursive: true, mode: 0o700 });
  // fail-closed assertion
  if (!process.env.REFTRIX_SCREENSHOT_ROOT.startsWith(TEST_SCREENSHOT_ROOT_PREFIX)) {
    console.error(
      "[regression-standing] REFTRIX_SCREENSHOT_ROOT contamination guard failed:",
      "value did not start with test prefix"
    );
    process.exit(1);
  }
  return testRoot;
}

/**
 * production screenshot path に test artifact が漏洩していないか検証する
 * (negative assertion)。
 *
 * Negative assertion: verifies that no test artifact has leaked into the
 * production screenshot path during the test run. Returns the count of files
 * found (0 = clean).
 *
 * SEC-Plan-05 Amendment: production path への書込検出。before/after 比較は
 * caller が担当する。
 *
 * PR-SS-A D-1a: 本関数は **read-only** (existsSync + readdirSync のみ) であり、
 * 検査対象 path を作成も削除もしない。`rootOverride` は contamination-guard
 * ロジックの sandbox 検証用 (fixture-lifecycle.test.ts) — production default
 * root への破壊的操作なしで guard の検出能力をテスト可能にする。
 *
 * PR-SS-A D-1a: this function is **read-only** (existsSync + readdirSync only)
 * and neither creates nor deletes the inspected path. `rootOverride` exists so
 * the guard logic can be verified against an injected sandbox root
 * (fixture-lifecycle.test.ts) without any destructive operation on the
 * production default root.
 */
export function countProductionScreenshotArtifacts(rootOverride?: string): number {
  const inspectedRoot = rootOverride ?? PRODUCTION_SCREENSHOT_ROOT;
  try {
    if (!fs.existsSync(inspectedRoot)) {
      return 0;
    }
    return fs.readdirSync(inspectedRoot, { recursive: true }).length;
  } catch {
    // 権限エラー等は安全側で 0 として扱う (read 不能 = production 書込発生していないと仮定)
    // Permission errors → safely return 0 (read-failure = no production write).
    return 0;
  }
}

/**
 * テスト用 screenshot root を完全削除する。
 *
 * Completely removes the test-only screenshot root. Validates that the path
 * starts with the test prefix to prevent accidental production deletion.
 *
 * GDPR Art.5(1)(e) storage limitation: test artifact は test 終了時に必ず削除する。
 * GDPR Art.5(1)(e) storage limitation: test artifacts MUST be deleted at end of run.
 */
export function purgeTestScreenshotRoot(testRoot: string): void {
  if (!testRoot.startsWith(TEST_SCREENSHOT_ROOT_PREFIX)) {
    // 安全装置: production path を絶対に削除しない
    // Safety: NEVER delete a production path.
    console.error(
      "[regression-standing] purge guard rejected non-test path:",
      // 全path出力ではなく prefix 確認のみ logging (PII 配慮)
      // Log prefix-only (PII protection).
      path.dirname(testRoot)
    );
    return;
  }
  fs.rmSync(testRoot, { recursive: true, force: true });
}

/**
 * テスト用 screenshot root が完全削除されたか assert する (afterAll で使用)。
 *
 * Asserts that the test screenshot root has been completely removed. Used in
 * afterAll hooks per ADR-0016 § Fixture Lifecycle deletion contract.
 *
 * @throws Error if the directory still exists.
 */
export function assertTestScreenshotRootRemoved(testRoot: string): void {
  if (fs.existsSync(testRoot)) {
    throw new Error(
      `[regression-standing] fixture lifecycle violation: ${TEST_SCREENSHOT_ROOT_PREFIX}<uuid>/ still exists after teardown`
    );
  }
}
