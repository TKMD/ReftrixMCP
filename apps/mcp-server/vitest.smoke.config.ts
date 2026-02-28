// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import path from 'path';

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
 */
export default defineConfig({
  test: {
    name: 'smoke',
    globals: true,
    environment: 'node',
    pool: 'forks',
    maxWorkers: 3, // メモリ枯渇防止: 各ワーカー約3.5GB消費
    include: ['tests/smoke/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // スモークテストは高速実行（10秒タイムアウト）
    testTimeout: 10000,
    hookTimeout: 10000,
    env: {
      NODE_ENV: 'test',
      MCP_SKIP_RATE_LIMIT: 'true',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
