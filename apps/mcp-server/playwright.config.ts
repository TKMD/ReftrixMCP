// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright Configuration for Reftrix MCP Server E2E Tests
 *
 * E2Eテストの設定ファイル
 * - MCPツールの統合フローをブラウザベースでテスト
 * - CI環境でのヘッドレス実行をサポート
 * - layout.ingest → layout.search、motion.detect、quality.evaluate、page.analyze フロー
 *
 * 使用方法:
 *   pnpm test:e2e:playwright       # E2Eテスト実行
 *   pnpm test:e2e:playwright:ui    # UIモードで実行（デバッグ用）
 */
export default defineConfig({
  // テストファイルの配置場所
  testDir: './tests/e2e/playwright',

  // テスト実行の並列度
  fullyParallel: false, // MCPツールテストは順序依存があるため

  // CI環境での設定
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 1, // MCPサーバーリソース制限のため1ワーカー

  // レポーター設定
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'on-failure' }]],

  // グローバル設定
  use: {
    // E2E test target
    baseURL: 'http://localhost:24001',

    // トレース収集（失敗時のみ）
    trace: 'on-first-retry',

    // スクリーンショット（失敗時のみ）
    screenshot: 'only-on-failure',

    // ヘッドレスモード（CI環境）
    headless: true,

    // タイムアウト設定
    actionTimeout: 30000,
    navigationTimeout: 60000,
  },

  // グローバルタイムアウト（MCPツールは時間がかかる場合がある）
  timeout: 120000,

  // expectのタイムアウト
  expect: {
    timeout: 30000,
  },

  // プロジェクト（ブラウザ）設定
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
    // CI環境では複数ブラウザをテスト
    ...(process.env.CI
      ? [
          {
            name: 'firefox',
            use: {
              ...devices['Desktop Firefox'],
            },
          },
        ]
      : []),
  ],

  // 出力ディレクトリ
  outputDir: './tests/e2e/playwright/test-results',

  // グローバルセットアップ/ティアダウン（必要に応じて）
  // globalSetup: './tests/e2e/playwright/global-setup.ts',
  // globalTeardown: './tests/e2e/playwright/global-teardown.ts',
});
