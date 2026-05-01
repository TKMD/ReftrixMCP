// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";
import { baseTestConfig } from "./vitest.base.config.mts";

/**
 * Vitest Smoke Test Configuration
 *
 * 目的: CI高速実行用スモークテスト
 * - ツール起動確認（全16ツールがロード可能）
 * - 基本レスポンス確認（system.health が成功を返す）
 * - 型チェック（toolHandlersの型整合性）
 *
 * 使用方法:
 * - pnpm test:smoke → vitest run --config vitest.smoke.config.ts
 *
 * v0.4.0 PR7e-β5 ADR-0016 M1: `vitest.base.config.mts` から共通設定を継承する形に
 * refactor。include / timeout のみ override し既存挙動を完全保持。
 *
 * v0.4.0 PR7e-β5 ADR-0016 M1: refactored to inherit shared options from
 * `vitest.base.config.mts`. Only `include` and `timeout` are overridden;
 * existing behavior is preserved bit-for-bit.
 */
export default defineConfig({
  ...baseTestConfig,
  test: {
    ...baseTestConfig.test,
    name: "smoke",
    include: ["tests/smoke/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    // スモークテストは高速実行（10秒タイムアウト）
    // Fast smoke tests (10s timeout).
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
