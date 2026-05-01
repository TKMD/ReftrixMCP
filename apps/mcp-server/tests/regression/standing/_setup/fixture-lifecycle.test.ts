// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SEC-M2-01 regression test / SEC-M2-01 回帰 test
 *
 * `countProductionScreenshotArtifacts()` が teardown guard として機能することを
 * 検証する回帰 test。ADR-0016 § Fixture Lifecycle SEC-Plan-05 Amendment の
 * contamination-prevention 契約を test-infrastructure-level で担保する。
 *
 * Regression test proving `countProductionScreenshotArtifacts()` works as a
 * teardown guard, enforcing the contamination-prevention contract of
 * ADR-0016 § Fixture Lifecycle SEC-Plan-05 Amendment at the test-infra level.
 *
 * ## 検証観点 / Coverage
 *
 * - **Negative case**: production path に書込が無ければ before/after count は一致
 *   する → teardown guard は false-positive を発生させない
 * - **Positive case**: production path に sentinel を書込むと after > before と
 *   なる → teardown guard が contamination を検出可能
 *
 * - Negative: with no write to production path, before/after counts match →
 *   no false positive.
 * - Positive: with a sentinel written to production path, after > before →
 *   contamination is detectable.
 *
 * ## 安全装置 / Safety
 *
 * - sentinel path prefix (`__sec_m2_01_test_sentinel_`) + UUID で test 専用識別
 * - try/finally で sentinel の cleanup を保証 (test 失敗時も production path
 *   を汚さない)
 * - cleanup 後の count === before を追加 assert し global teardown guard との
 *   整合性を維持
 *
 * @module tests/regression/standing/_setup/fixture-lifecycle.test
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PRODUCTION_SCREENSHOT_ROOT,
  countProductionScreenshotArtifacts,
} from "./fixture-lifecycle";

/**
 * test sentinel file 名の prefix。UUID で一意化する。
 * Sentinel file-name prefix; suffixed with a UUID for uniqueness.
 */
const SENTINEL_PREFIX = "__sec_m2_01_test_sentinel_" as const;

/**
 * sentinel cleanup helper. 削除失敗でも throw しない (swallow) が、存在すれば
 * 必ず削除を試みる。
 *
 * Attempts to delete a sentinel file. Swallows errors so teardown is never
 * masked; best-effort delete when the file exists.
 */
function tryUnlinkSentinel(sentinelPath: string): void {
  try {
    if (fs.existsSync(sentinelPath)) {
      fs.unlinkSync(sentinelPath);
    }
  } catch {
    // swallow: cleanup failure は test 失敗をマスクしない
    // swallow: cleanup failure must not mask test failures
  }
}

describe("countProductionScreenshotArtifacts() teardown guard (SEC-M2-01)", () => {
  let productionRootPreexisted = false;

  beforeAll(() => {
    // production path が無ければ作成する (0o700 production-parity)。test 終了時に
    // 状態を復元するため preexistence を記録する。
    //
    // Create the production path if missing (0o700 production-parity) and
    // record whether it pre-existed so teardown can restore state.
    productionRootPreexisted = fs.existsSync(PRODUCTION_SCREENSHOT_ROOT);
    if (!productionRootPreexisted) {
      fs.mkdirSync(PRODUCTION_SCREENSHOT_ROOT, { recursive: true, mode: 0o700 });
    }
  });

  afterAll(() => {
    // この test が作成したディレクトリは復元する (既存なら触らない)。
    // Remove the production root only if we created it here.
    if (!productionRootPreexisted) {
      try {
        fs.rmSync(PRODUCTION_SCREENSHOT_ROOT, { recursive: true, force: true });
      } catch {
        // swallow: cleanup failure must not mask test failures
      }
    }
  });

  it("returns the same count when no production write occurs (negative case)", () => {
    const before = countProductionScreenshotArtifacts();
    const after = countProductionScreenshotArtifacts();
    expect(after).toBe(before);
  });

  it("detects production-path contamination when a sentinel is written (positive case)", () => {
    const before = countProductionScreenshotArtifacts();
    const sentinelPath = path.join(
      PRODUCTION_SCREENSHOT_ROOT,
      `${SENTINEL_PREFIX}${crypto.randomUUID()}.png`
    );
    try {
      fs.writeFileSync(sentinelPath, Buffer.from("sec-m2-01-test-sentinel"));
      const after = countProductionScreenshotArtifacts();
      expect(after).toBeGreaterThan(before);
    } finally {
      // 必ず削除: test 失敗時も global teardown の contamination guard が
      // 巻き添えで fail しないよう baseline へ戻す
      // Always delete: restore baseline so the global teardown contamination
      // guard does not fail collaterally if this assertion itself fails.
      tryUnlinkSentinel(sentinelPath);
    }
    // sentinel 削除後は必ず before 値に戻る (global teardown との整合性検証)
    // After deletion the count must equal the baseline (integrity with the
    // global teardown contamination guard).
    const afterCleanup = countProductionScreenshotArtifacts();
    expect(afterCleanup).toBe(before);
  });
});
