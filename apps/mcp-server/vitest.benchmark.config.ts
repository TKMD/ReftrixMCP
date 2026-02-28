// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vitest Benchmark Configuration
 *
 * MCPツールのパフォーマンスベンチマーク専用設定
 * ベンチマーク実行: pnpm bench
 *
 * @see https://vitest.dev/guide/features.html#benchmarking
 */
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // ベンチマークモードを有効化
    benchmark: {
      // 出力レポーター
      reporters: ['default'],
      // 結果を JSON ファイルに保存
      outputFile: {
        json: './benchmark-results/results.json',
      },
      // 各ベンチマークの反復回数
      // 注: ベンチマーク関数の options で個別設定可能
    },
    globals: true,
    environment: 'node',
    // ベンチマーク用のincludeパターン
    include: ['tests/benchmarks/**/*.bench.ts'],
    exclude: ['node_modules', 'dist'],
    // ベンチマークは長時間実行されるためタイムアウトを延長
    testTimeout: 120000,
    hookTimeout: 30000,
    // メモリ枯渇防止: 並列実行を制限
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 2, // ベンチマークは並列度を下げて安定性を確保
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
