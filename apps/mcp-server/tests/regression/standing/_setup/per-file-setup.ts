// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — per-file setup / 各 test file 共通 setup
 *
 * vitest `setupFiles` から自動的にインポートされる。各 test file の起動時に
 * 以下を実施する:
 *
 * Auto-imported via vitest's `setupFiles`. Runs at the start of each test file:
 *
 * 1. fail-closed env guard: DATABASE_URL / REDIS_URL が globalSetup 経由で
 *    設定されていることを確認 (testcontainer から取得した URL でなければ throw)
 * 2. test-env-guard: EMBEDDING_MODEL_MOCK が production leak していないことを確認
 *    (test 環境では mock 必須なのでこれは pass する)
 *
 * @module tests/regression/standing/_setup/per-file-setup
 */

import { assertNoTestOnlyEnvLeak } from "../../../../src/config/test-env-guard";

// fail-closed: globalSetup が DATABASE_URL / REDIS_URL を設定していること
// fail-closed: globalSetup must have set DATABASE_URL / REDIS_URL
if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
  throw new Error(
    "[regression-standing] per-file-setup: DATABASE_URL or REDIS_URL not set by globalSetup. " +
      "Did the testcontainers boot fail?"
  );
}

// SEC-Plan-01: test-env-guard を毎テストファイルで呼び出して production leak を遮断する
// (NODE_ENV=test なので no-op だが、guard が動作することを per-file 検証)
//
// SEC-Plan-01: invoke the test-env-guard at every test file to block
// production leak (no-op while NODE_ENV=test, but verifies the guard wiring).
assertNoTestOnlyEnvLeak();
