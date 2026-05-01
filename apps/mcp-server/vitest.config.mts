// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";
import { baseTestConfig } from "./vitest.base.config.mts";

/**
 * Vitest Configuration
 *
 * テスト実行方法:
 * - pnpm test:smoke       → スモークテスト（tests/smoke/）のみ実行
 *                            vitest.smoke.config.ts を使用
 * - pnpm test:unit        → ユニットテスト（smoke, integration, e2e を除く）
 * - pnpm test:integration → 統合テスト（tests/integration/）のみ実行
 * - pnpm test             → 全テスト実行（デフォルト）
 *
 * スモークテストは CI パイプラインで高速に実行され、
 * MCPツールの登録確認、基本レスポンス確認、型整合性を検証します。
 *
 * v0.4.0 PR7e-β5 ADR-0016 M1: `vitest.base.config.mts` から共通設定を継承する形に
 * refactor。既存挙動は完全保持 (env / coverage / timeout / maxWorkers すべて同値)。
 *
 * v0.4.0 PR7e-β5 ADR-0016 M1: refactored to inherit shared options from
 * `vitest.base.config.mts`. Existing behavior is preserved bit-for-bit
 * (env / coverage / timeout / maxWorkers all unchanged).
 */
export default defineConfig({
  ...baseTestConfig,
  test: {
    ...baseTestConfig.test,
    include: ["tests/**/*.test.ts"],
    exclude: [
      "node_modules",
      "dist",
      // ADR-0016 M1: standing regression は専用 config で実行する
      // ADR-0016 M1: standing regression suite runs via its own config.
      "tests/regression/standing/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["node_modules/", "dist/", "tests/", "**/*.test.ts", "**/*.config.ts"],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 80,
      },
    },
  },
});
