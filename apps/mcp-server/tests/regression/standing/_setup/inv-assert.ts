// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV name assertion helper / INV 名 assertion ヘルパー
 *
 * ADR-0016 § ESLint Rule Strategy (TDA-Plan-11/12) で採用された runtime
 * assertion 方式 (custom ESLint rule `reftrix/require-inv-comment` 不採用)。
 *
 * Runtime assertion (custom ESLint rule `reftrix/require-inv-comment` was
 * rejected per ADR-0016 § ESLint Rule Strategy).
 *
 * 各 INV-\* test の `describe` 冒頭で:
 *
 * ```typescript
 * describe('INV-PAGE-QUEUE-001: backfill terminal state', () => {
 *   beforeEach(() => assertInvName(expect.getState().currentTestName ?? '', 'INV-PAGE-QUEUE-001'));
 *   // ...
 * });
 * ```
 *
 * @module tests/regression/standing/_setup/inv-assert
 */

/**
 * 現在のテスト名に指定 INV ID が含まれることを assert する。
 *
 * Asserts the current test name contains the expected INV ID (word-boundary match).
 *
 * @param currentTestName - `expect.getState().currentTestName` 等から取得した実行中テスト名
 * @param expectedInv - 期待する INV ID (例: `INV-PAGE-QUEUE-001`)
 * @throws Error if the test name does not contain the expected INV ID.
 */
export function assertInvName(currentTestName: string, expectedInv: string): void {
  // \b は ASCII word boundary。INV-\* は ASCII のみで構成されるため安全。
  // \b is the ASCII word boundary; INV-* is ASCII-only so this is safe.
  const escaped = expectedInv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`);
  if (!pattern.test(currentTestName)) {
    throw new Error(
      `[regression-standing] Test name must contain INV ID "${expectedInv}": got "${currentTestName}"`
    );
  }
}
