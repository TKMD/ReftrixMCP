// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";
import { defineConfig } from "vitest/config";
import { baseTestConfig } from "./vitest.base.config.mts";

/**
 * Vitest Regression-Standing Suite Configuration / 常設 regression suite 設定
 *
 * ADR-0016 § Architecture Overview (Standing Regression Suite for 4 Critical Domains)
 * の 4 ドメイン (large-page / gdpr-delete / worker-lifecycle / schema-enum-sync) を
 * 専用 vitest config で実行する。
 *
 * Runs the 4-domain standing regression suite (large-page / gdpr-delete /
 * worker-lifecycle / schema-enum-sync) per ADR-0016 § Architecture Overview.
 *
 * ## 重要 / Critical
 *
 * - testcontainer 起動 (`globalSetup`) には Docker daemon が必須。OSS 利用者は
 *   `docs/OSS_CI_REQUIREMENTS.md` を参照。
 * - 既存 `vitest.config.mts` の `tests/regression/standing/**` は exclude されており
 *   `pnpm test` では実行されない (CI では `pnpm test:regression:standing` を別 job で実行)。
 * - 失敗は P0 incident。merge block。
 *
 * - testcontainer requires Docker daemon. See `docs/OSS_CI_REQUIREMENTS.md`.
 * - The standing suite is excluded from `pnpm test`; CI runs it via the
 *   `regression-standing` job (`pnpm test:regression:standing`).
 * - Failures are P0 incidents and block merge.
 *
 * @module vitest.regression-standing.config
 */
export default defineConfig({
  ...baseTestConfig,
  test: {
    ...baseTestConfig.test,
    name: "regression-standing",
    include: ["tests/regression/standing/**/*.test.ts"],
    // `include` pattern already restricts to `*.test.ts`, so the legacy
    // `tests/regression/standing/_setup/**` blanket exclusion is redundant —
    // non-test helpers in `_setup/` (e.g., fixture-lifecycle.ts) never match
    // the include anyway. Keeping it narrower (node_modules / dist only)
    // allows test-infrastructure regression tests (e.g., SEC-M2-01
    // `fixture-lifecycle.test.ts`) to live alongside the helpers they exercise.
    //
    // The `include` pattern only matches `*.test.ts`; helpers in `_setup/`
    // are imported (not discovered as tests). Narrower exclude lets test-
    // infrastructure regression tests live beside the helpers they exercise.
    exclude: ["node_modules", "dist"],
    // testcontainer の boot + DB migration + Redis seed は重いため逐次実行
    // M1: 単一 worker で安定性を優先し、M3 で並列化を再評価する。
    // testcontainer boot + DB migration + Redis seed are heavy; run sequentially
    // for stability in M1. Parallelization reconsidered in M3.
    maxWorkers: 1,
    // testcontainer boot 含む globalSetup は数十秒かかる可能性
    // testcontainer boot inside globalSetup may take tens of seconds.
    testTimeout: 120000,
    hookTimeout: 180000,
    // global setup / teardown — testcontainer ライフサイクル + fixture lifecycle
    // global setup/teardown — testcontainer lifecycle + fixture lifecycle.
    globalSetup: [path.resolve(__dirname, "./tests/regression/standing/_setup/global-setup.ts")],
    // setupFiles で fail-closed guard を毎テストファイルに inject する
    // setupFiles inject fail-closed guards into every test file.
    setupFiles: [path.resolve(__dirname, "./tests/regression/standing/_setup/per-file-setup.ts")],
    env: {
      ...baseTestConfig.test?.env,
      // ADR-0016 § Mock Strategy: ONNX Runtime mock を有効化
      // ADR-0016 § Mock Strategy: enable ONNX Runtime mock.
      EMBEDDING_MODEL_MOCK: "true",
    },
  },
});
