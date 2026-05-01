// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — vitest globalSetup / globalSetup
 *
 * ADR-0016 § Testcontainer Lifecycle (TDA-Plan-09): container lifecycle は
 * **globalSetup 起動 + globalTeardown 停止** (per-file/per-domain は高コストで不採用)。
 *
 * Per ADR-0016 § Testcontainer Lifecycle: containers are launched in
 * globalSetup and torn down in globalTeardown (per-file/per-domain rejected
 * for cost reasons).
 *
 * 起動 / Boot:
 * 1. Fixture lifecycle guard: REFTRIX_SCREENSHOT_ROOT を test-only path に強制上書き
 * 2. testcontainers 起動 (postgres + redis) → DATABASE_URL / REDIS_URL を env に export
 * 3. fail-closed: いずれか失敗で `process.exit(1)`
 *
 * 停止 / Teardown:
 * 1. testcontainers 停止 (Ryuk fallback layer 1: 明示 stop)
 * 2. test screenshot root 完全削除 + existsSync === false assertion
 *
 * @module tests/regression/standing/_setup/global-setup
 */

import {
  startStandingTestContainers,
  stopStandingTestContainers,
  type StandingTestContainers,
} from "./testcontainers";
import {
  enforceTestScreenshotRoot,
  purgeTestScreenshotRoot,
  assertTestScreenshotRootRemoved,
  countProductionScreenshotArtifacts,
} from "./fixture-lifecycle";
import { applyPrismaSchemaToTestcontainer } from "./database-migrate";
import { sanitizeErrorMessage } from "../../../../src/utils/sanitize-error";

let containers: StandingTestContainers | undefined;
let testScreenshotRoot: string | undefined;
let beforeProductionArtifactsCount: number | undefined;

/**
 * vitest globalSetup hook (default export shape per Vitest 4.x).
 *
 * Returns a teardown function that vitest will invoke at end of run.
 */
export default async function setup(): Promise<() => Promise<void>> {
  // ==========================================================================
  // 1. Fixture lifecycle guard (SEC-Plan-05 Amendment 1, before container boot)
  // ==========================================================================
  testScreenshotRoot = enforceTestScreenshotRoot();

  // SEC-M2-01: baseline production screenshot path count を teardown 比較用に記録
  //            (test 実行中に testcontainer 外の production path への意図せぬ書込を
  //             fail-closed で検出する。ADR-0016 § Fixture Lifecycle SEC-Plan-05
  //             Amendment 契約の code wiring)
  // SEC-M2-01: record baseline production-path artifact count for teardown
  //            comparison. Detects unintended writes to the production
  //            screenshot path during tests (fail-closed; wires ADR-0016 §
  //            Fixture Lifecycle SEC-Plan-05 Amendment contract into code).
  beforeProductionArtifactsCount = countProductionScreenshotArtifacts();

  // ==========================================================================
  // 2. testcontainers boot (postgres + redis)
  // ==========================================================================
  try {
    containers = await startStandingTestContainers();
  } catch (err) {
    // SEC-Plan-08 Amendment: redact before logging
    console.error(
      "[regression-standing] globalSetup failed during container boot:",
      sanitizeErrorMessage(err)
    );
    throw err;
  }

  // ==========================================================================
  // 3. Export env vars for tests (DATABASE_URL / REDIS_URL)
  // ==========================================================================
  process.env.DATABASE_URL = containers.databaseUrl;
  process.env.REDIS_URL = containers.redisUrl;
  // ADR-0016 § Mock Strategy: ONNX Runtime mock を有効化 (test スコープのみ、
  // test-env-guard.ts で production leak は遮断済)。
  // ADR-0016 § Mock Strategy: enable ONNX Runtime mock (test scope only;
  // test-env-guard.ts blocks production leak).
  process.env.EMBEDDING_MODEL_MOCK = "true";

  // ==========================================================================
  // 3.5. Apply @reftrixmcp/database Prisma schema to testcontainer postgres
  //      (M2 shared infra — required by 4-domain standing regression tests
  //      that depend on real DB tables; ADR-0016 § Testcontainer Lifecycle)
  //
  //      `prisma migrate deploy` で migration SQL を全順序再生し、
  //      CREATE EXTENSION (vector / pg_trgm / pgcrypto / uuid-ossp) と
  //      gen_uuidv7() カスタム関数も production 同様に作成される (~10-30s)。
  //      失敗は fail-closed (helper 内で throw、本 catch で sanitize)。
  //
  //      Runs `prisma migrate deploy` so all migration SQL replays in order,
  //      creating the CREATE EXTENSION statements (vector / pg_trgm /
  //      pgcrypto / uuid-ossp) and the gen_uuidv7() custom function just
  //      like production. Fail-closed on failure (helper throws, re-wrapped).
  // ==========================================================================
  try {
    await applyPrismaSchemaToTestcontainer(containers.databaseUrl);
  } catch (err) {
    console.error(
      "[regression-standing] globalSetup failed during prisma migrate deploy:",
      sanitizeErrorMessage(err)
    );
    throw err;
  }

  // ==========================================================================
  // 4. Return teardown function
  // ==========================================================================
  return async (): Promise<void> => {
    // testcontainers 停止 (Ryuk fallback layer 1)
    if (containers) {
      try {
        await stopStandingTestContainers(containers);
      } catch (err) {
        console.warn(
          "[regression-standing] globalTeardown container stop failed:",
          sanitizeErrorMessage(err)
        );
      }
    }
    // fixture lifecycle deletion contract
    if (testScreenshotRoot) {
      try {
        purgeTestScreenshotRoot(testScreenshotRoot);
        assertTestScreenshotRootRemoved(testScreenshotRoot);
      } catch (err) {
        console.error(
          "[regression-standing] fixture lifecycle teardown failed:",
          sanitizeErrorMessage(err)
        );
        // teardown 失敗は CI fail とすべき
        // Teardown failures must fail the CI run.
        throw err;
      }
    }

    // ==========================================================================
    // SEC-M2-01: production screenshot path contamination guard (fail-closed)
    //
    // Setup で記録した beforeProductionArtifactsCount と比較し、test 実行中に
    // production default path (`/tmp/reftrix-screenshots/`) への書込が発生していた
    // 場合は teardown を fail させる。ADR-0016 § Fixture Lifecycle SEC-Plan-05
    // Amendment の contamination-prevention 契約を code level で強制する。
    //
    // SEC-M2-01: compare against the setup-time baseline and fail-close the
    // teardown if any artifact leaked into the production default path
    // (`/tmp/reftrix-screenshots/`) during the run. Enforces the contamination-
    // prevention contract of ADR-0016 § Fixture Lifecycle SEC-Plan-05 Amendment
    // at the code level.
    // ==========================================================================
    if (beforeProductionArtifactsCount !== undefined) {
      const afterProductionArtifactsCount = countProductionScreenshotArtifacts();
      if (afterProductionArtifactsCount !== beforeProductionArtifactsCount) {
        throw new Error(
          "[regression-standing] production screenshot path contamination detected: " +
            `before=${beforeProductionArtifactsCount}, after=${afterProductionArtifactsCount}. ` +
            "Test harness must not write to the production screenshot path " +
            "(REFTRIX_SCREENSHOT_ROOT default)."
        );
      }
    }
  };
}
