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
 * ## PR-SS-A (D-1a, safety-critical) — sandbox 構造 / sandbox structure
 *
 * production default root は XDG data dir (User の実 home 配下) に移動したため
 * (PR-SS-A D-1)、本 test は **production default root に対して mkdir/rmSync を
 * 一切実行しない**。guard ロジック (count 検出能力) の検証は per-run の
 * `os.tmpdir()` 配下 sandbox root を `rootOverride` 注入して行い、production
 * default root は read-only の存在確認のみ (作成も削除もしないことを assert)。
 *
 * Because the production default root moved into an XDG data dir under the
 * User's real home (PR-SS-A D-1), this test **never performs mkdir/rmSync on
 * the production default root**. Guard logic (count-based detection) is
 * verified against an injected per-run sandbox root under `os.tmpdir()`; the
 * production default root receives read-only existence inspection only (and
 * the test asserts it is neither created nor deleted).
 *
 * ## 検証観点 / Coverage
 *
 * - **Negative case**: sandbox に書込が無ければ before/after count は一致する
 *   → teardown guard は false-positive を発生させない
 * - **Positive case**: sandbox に sentinel を書込むと after > before となる
 *   → teardown guard が contamination を検出可能
 * - **Read-only case (D-1a)**: production default root への検査は read-only で
 *   あり、検査によって root が作成されない
 *
 * @module tests/regression/standing/_setup/fixture-lifecycle.test
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
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
 * per-run sandbox root (os.tmpdir() 配下)。破壊的 FS 操作 (mkdirSync /
 * writeFileSync / rmSync) は本 sandbox に対して**のみ**実行する (D-1a)。
 *
 * Per-run sandbox root under os.tmpdir(). Destructive FS operations
 * (mkdirSync / writeFileSync / rmSync) target this sandbox **only** (D-1a).
 */
const SANDBOX_ROOT = path.join(os.tmpdir(), `reftrix-sec-m2-01-sandbox-${crypto.randomUUID()}`);

describe("countProductionScreenshotArtifacts() teardown guard (SEC-M2-01 / PR-SS-A D-1a)", () => {
  beforeAll(() => {
    // sandbox のみ作成 (0o700 production-parity)。production default root には触れない。
    // Create the sandbox only (0o700 production-parity); never touch the
    // production default root.
    fs.mkdirSync(SANDBOX_ROOT, { recursive: true, mode: 0o700 });
  });

  afterAll(() => {
    // 削除するのは sandbox のみ / delete the sandbox only.
    try {
      fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });
    } catch {
      // swallow: cleanup failure must not mask test failures
    }
  });

  it("returns the same count when no write occurs (negative case, sandbox-injected)", () => {
    const before = countProductionScreenshotArtifacts(SANDBOX_ROOT);
    const after = countProductionScreenshotArtifacts(SANDBOX_ROOT);
    expect(after).toBe(before);
  });

  it("detects contamination when a sentinel is written (positive case, sandbox-injected)", () => {
    const before = countProductionScreenshotArtifacts(SANDBOX_ROOT);
    const sentinelPath = path.join(SANDBOX_ROOT, `${SENTINEL_PREFIX}${crypto.randomUUID()}.png`);
    try {
      fs.writeFileSync(sentinelPath, Buffer.from("sec-m2-01-test-sentinel"));
      const after = countProductionScreenshotArtifacts(SANDBOX_ROOT);
      expect(after).toBeGreaterThan(before);
    } finally {
      // sandbox 内 sentinel の cleanup (失敗しても afterAll の sandbox 全削除で回収)
      // Sentinel cleanup inside the sandbox (the afterAll sandbox purge is the backstop).
      try {
        fs.unlinkSync(sentinelPath);
      } catch {
        // swallow: cleanup failure must not mask test failures
      }
    }
    const afterCleanup = countProductionScreenshotArtifacts(SANDBOX_ROOT);
    expect(afterCleanup).toBe(before);
  });

  it("production default root の検査は read-only — 検査で root を作成しない (D-1a)", () => {
    // PR-SS-A D-1a design constraint: the production default root (under the
    // User's real home) is inspected read-only — counting must neither create
    // nor delete it.
    const existedBefore = fs.existsSync(PRODUCTION_SCREENSHOT_ROOT);
    const count = countProductionScreenshotArtifacts();
    expect(count).toBeGreaterThanOrEqual(0);
    const existsAfter = fs.existsSync(PRODUCTION_SCREENSHOT_ROOT);
    // 存在状態が検査の前後で不変 (作成も削除もされていない)
    // Existence state unchanged across the inspection (neither created nor deleted).
    expect(existsAfter).toBe(existedBefore);
  });

  it("PRODUCTION_SCREENSHOT_ROOT は SSOT derive (XDG data dir) であり /tmp を指さない (D-1a)", () => {
    // SSOT (resolveDefaultScreenshotRoot) から derive されていることの構造確認:
    // 旧 /tmp default を指していない + reftrix screenshots パスで終端する。
    // Structural check of SSOT derivation: no longer the old /tmp default and
    // ends with the reftrix screenshots path segments.
    expect(PRODUCTION_SCREENSHOT_ROOT.startsWith(os.tmpdir() + path.sep)).toBe(false);
    expect(PRODUCTION_SCREENSHOT_ROOT.endsWith(path.join("reftrix", "screenshots"))).toBe(true);
  });
});
