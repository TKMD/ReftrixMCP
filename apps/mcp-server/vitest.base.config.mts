// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vitest Base Config / Vitest 共通基底設定
 *
 * ADR-0016 § Architecture Overview の "vitest.base.config.mts を抽出" 契約。
 * 既存 3 config (`vitest.config.mts` / `vitest.smoke.config.ts` /
 * `vitest.regression-standing.config.ts`) が本基底を継承する。
 *
 * Per ADR-0016 § Architecture Overview, this base is the single source of truth
 * for Vitest options shared across the standard, smoke, and regression-standing
 * test suites. Each suite spreads this base and overrides only what it needs.
 *
 * 重要 / Critical:
 * - 本ファイル単体では実行されない (defineConfig export なし)。
 * - 既存 config の挙動を一切変えないため、各 config は本基底から spread し
 *   差分のみ override する形に refactor する。
 *
 * - Standalone execution NOT supported (no `defineConfig` export here).
 * - Each derived config spreads this base and overrides only what is needed,
 *   preserving existing behavior bit-for-bit.
 *
 * @module vitest.base.config
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UserConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 共通環境変数 / Shared env vars (NODE_ENV=test + rate-limit skip + robots.txt
 * disable).
 *
 * - `NODE_ENV=test` … 必須 (`test-env-guard.ts` の opt-out 判定に使用)
 * - `MCP_SKIP_RATE_LIMIT=true` … 既存 config と同値、CI flaky 防止
 * - `REFTRIX_RESPECT_ROBOTS_TXT=false` … 既存 config と同値、外部 ネット禁止
 */
export const SHARED_TEST_ENV = {
  NODE_ENV: "test",
  MCP_SKIP_RATE_LIMIT: "true",
  REFTRIX_RESPECT_ROBOTS_TXT: "false",
} as const;

/**
 * 共通 resolve.alias / Shared `@/` alias to `src/`.
 */
export const SHARED_RESOLVE_ALIAS = {
  "@": path.resolve(__dirname, "./src"),
} as const;

/**
 * Vitest 共通設定 (`test` / `resolve` のキーのみ).
 * Vitest options shared across all suites (`test` / `resolve` only).
 *
 * coverage / include / exclude / pool / maxWorkers は各 config で override する。
 *
 * Each suite overrides coverage / include / exclude / pool / maxWorkers as needed.
 */
export const baseTestConfig: UserConfig = {
  test: {
    globals: true,
    environment: "node",
    // フォークプールを使用（スレッドより安定）
    // Forks pool (more stable than threads for ONNX Runtime / Sharp).
    pool: "forks",
    // メモリ枯渇防止 + CI flaky 抑制 (v0.5.1 F1, ADR-0020 Decision 1):
    //   各ワーカー約3.5GB消費。3 → 2 に縮退して swap shortage (RCA layer A2) を緩和。
    // Memory cap + CI flaky suppression (v0.5.1 F1, ADR-0020 Decision 1):
    //   ~3.5GB per worker. Reduced 3 → 2 to mitigate swap shortage (RCA layer A2).
    maxWorkers: 2,
    // NOTE: `fileParallelism: false` was removed (v0.5.1 F2 partial revert,
    //   IO Decision anchor 019de2f7-f13b-752f-8991-f67802ed98b5):
    //   CI run #1 wall-time 33:22 violated TPA-IMPL-H-01 hard gate (≤30:00).
    //   Vitest 4.x default `fileParallelism: true` is restored to recover
    //   file-level parallelism. F1 (`maxWorkers: 2`) is preserved for the
    //   CI 7GB memory budget. See ADR-0020 Amendment.
    // F2 (`fileParallelism: false`) removed in v0.5.1 partial revert; defaults
    //   to `true` (Vitest 4.x) to restore file-level parallelism after the
    //   CI wall-time violation. F1 (`maxWorkers: 2`) is preserved for the
    //   7GB CI memory budget. See ADR-0020 Amendment.
    env: { ...SHARED_TEST_ENV },
    // タイムアウトのデフォルト (各 config で override 可)
    // Default timeouts (overridable per suite).
    testTimeout: 60000,
    hookTimeout: 60000,
  },
  resolve: {
    alias: { ...SHARED_RESOLVE_ALIAS },
  },
};
