// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test-only env var production-leak guard / テスト専用環境変数の production leak 遮断
 *
 * ADR-0016 § Test-only Env Var Guard (SEC-Plan-01) を実装する。
 *
 * Implements ADR-0016 § Test-only Env Var Guard (SEC-Plan-01).
 *
 * ## 目的 / Purpose
 *
 * `EMBEDDING_MODEL_MOCK=true` (768-dim seeded deterministic random vector mock)
 * は **test 環境のみで使用可** とし、production 環境にリークすると以下の被害が発生する:
 *
 * 1. ベクトル検索結果が **decoy mock vector** で汚染される (silent quality regression)
 * 2. pgvector HNSW index に mock data が混入する
 * 3. Phase 5 fork orchestrator が ONNX Runtime を呼ばずに mock を返す
 *
 * `EMBEDDING_MODEL_MOCK=true` (768-dim seeded deterministic random vector mock)
 * is **test-only**. Leaking it to production would:
 *
 * 1. Pollute vector search results with decoy mock vectors (silent quality regression)
 * 2. Poison pgvector HNSW indexes
 * 3. Cause Phase 5 fork orchestrator to skip ONNX Runtime
 *
 * ## 設計 / Design
 *
 * - `NODE_ENV !== 'test' && EMBEDDING_MODEL_MOCK === 'true'` → 起動時 throw
 * - 既存 `REFTRIX_ALLOW_MANUAL_WORKER` opt-out パターン (v0.4.0 PR7d-2) と同様の fail-closed 設計
 * - Phase 5 fork orchestrator の `spawnOptions.env` whitelist と連動 (この guard は parent 側のみ。child 側は spawn env で別途遮断)
 *
 * - On `NODE_ENV !== 'test' && EMBEDDING_MODEL_MOCK === 'true'` → throw at boot
 * - Same fail-closed pattern as `REFTRIX_ALLOW_MANUAL_WORKER` opt-out (v0.4.0 PR7d-2)
 * - Pairs with the Phase 5 fork orchestrator's `spawnOptions.env` whitelist for child processes
 *
 * @module config/test-env-guard
 */

const TEST_ONLY_ENV_VARS = ["EMBEDDING_MODEL_MOCK"] as const;

/**
 * test-only env var が production leak していないか検査する。
 *
 * Verifies no test-only env var has leaked into a non-test runtime.
 *
 * @throws Error if a test-only env var is set when `NODE_ENV !== 'test'`.
 */
export function assertNoTestOnlyEnvLeak(env: NodeJS.ProcessEnv = process.env): void {
  // NODE_ENV が test の場合は何もしない (mock 利用は想定通り)
  // No-op when NODE_ENV is test (mock usage is expected).
  if (env.NODE_ENV === "test") {
    return;
  }
  for (const key of TEST_ONLY_ENV_VARS) {
    const value = env[key];
    if (value !== undefined && value !== "" && value !== "false" && value !== "0") {
      throw new Error(
        `[test-env-guard] Test-only env var "${key}" is set in non-test environment ` +
          `(NODE_ENV=${env.NODE_ENV ?? "unset"}). This is forbidden per ADR-0016 ` +
          `§ Test-only Env Var Guard to prevent silent embedding mock leakage to production.`
      );
    }
  }
}

/**
 * 子プロセスへ渡す env の whitelist filter。test-only var を strip する。
 *
 * Whitelist filter for child-process env. Strips test-only vars unless we are
 * already inside a test run (`NODE_ENV === 'test'`).
 *
 * 使用例 / Usage:
 *
 * ```typescript
 * // Phase 5 fork orchestrator の spawnOptions.env で
 * // In Phase 5 fork orchestrator's spawnOptions.env:
 * const childEnv = filterTestOnlyEnvForChild(process.env);
 * ```
 */
export function filterTestOnlyEnvForChild(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.NODE_ENV === "test") {
    return { ...env };
  }
  const filtered = { ...env };
  for (const key of TEST_ONLY_ENV_VARS) {
    delete filtered[key];
  }
  return filtered;
}
