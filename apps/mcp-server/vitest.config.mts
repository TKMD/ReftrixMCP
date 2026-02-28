// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import path from 'path';

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
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // フォークプールを使用（スレッドより安定）
    pool: 'forks',
    maxWorkers: 3, // メモリ枯渇防止: 各ワーカー約3.5GB消費
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // テスト環境変数設定
    env: {
      NODE_ENV: 'test',
      MCP_SKIP_RATE_LIMIT: 'true',
      // robots.txt チェックを無効化（テスト環境では外部ネットワークアクセス不可）
      // robots.txt コンプライアンスは packages/core/tests/services/robots-txt.service.test.ts で個別テスト済み
      REFTRIX_RESPECT_ROBOTS_TXT: 'false',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.test.ts',
        '**/*.config.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 80,
      },
    },
    // タイムアウト設定
    // Video Mode / Lighthouse 統合テストは60秒必要
    // 注: 一部のテストはモックなしで実際のサービスを呼び出す
    testTimeout: 60000,
    hookTimeout: 60000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
