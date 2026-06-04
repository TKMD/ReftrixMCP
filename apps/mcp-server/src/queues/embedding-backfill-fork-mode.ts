// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill Fork Mode Resolver (Plan v4.5 PR3 Track 2)
 *
 * SSOT for the per-job fork-only model env var names + resolution precedence.
 *
 * Per-job fork-only model migration の env var 名 + 解決優先順位の SSOT。
 *
 * ## Why a dedicated resolver module / なぜ専用 resolver module か
 *
 * INV-WORKER-CONFIG-LEGACY-ENV-VAR-DETECTION-001 (§5.3) mandates that the env
 * var name string literals (`EMBEDDING_BACKFILL_FORK_ONLY_MODE_ENABLED` /
 * `EMBEDDING_BACKFILL_FORK_ENABLED`) appear in production code ONLY in this
 * resolver module (AST sweep SSOT enforcement). Every other module reads the
 * resolved {@link ForkModeResolution} object, never the raw env vars.
 *
 * INV-WORKER-CONFIG-LEGACY-ENV-VAR-DETECTION-001 (§5.3) は env var 名 literal が
 * 本 resolver module 以外の production code に現れないことを mandate する
 * (AST sweep SSOT enforcement)。
 *
 * ## Resolution precedence (§5.3) / 解決優先順位
 *
 *   - new flag wins on value conflict
 *   - both unset → default true (fork-only enforced)
 *   - new flag `false` + legacy `true` → new flag wins (in-process throw + catch fallback)
 *   - legacy set (any value) + new set → emit `worker_config_legacy_env_var_detected`
 *
 * @module queues/embedding-backfill-fork-mode
 */

/**
 * SSOT env var name constants. These two string literals are the ONLY
 * production-code occurrences permitted by the AST sweep (§5.3 / §5.4).
 *
 * SSOT env var 名定数。本 2 literal のみが AST sweep で許可される。
 */
export const ENV_FORK_ONLY_MODE = "EMBEDDING_BACKFILL_FORK_ONLY_MODE_ENABLED" as const;
export const ENV_LEGACY_FORK = "EMBEDDING_BACKFILL_FORK_ENABLED" as const;

/**
 * Resolved fork-mode configuration.
 *
 * 解決された fork-mode 設定。
 */
export interface ForkModeResolution {
  /** Whether per-job fork-only mode is the active path (default true). */
  forkOnlyMode: boolean;
  /** Whether the legacy `EMBEDDING_BACKFILL_FORK_ENABLED` env var is present. */
  legacyEnvVarPresent: boolean;
  /**
   * Whether to emit `worker_config_legacy_env_var_detected`: true when the
   * legacy env var is present AND the new flag is also set (config drift in a
   * legacy deployment during the 1-cycle backward-compat window).
   */
  shouldEmitLegacyDetected: boolean;
}

/**
 * Resolve the per-job fork-only mode from the process environment, applying the
 * §5.3 precedence rules. Pure function over an injected `env` map (defaults to
 * `process.env`) for deterministic testability.
 *
 * §5.3 の precedence 規則で per-job fork-only mode を解決する。`env` 注入可能な
 * pure function。
 *
 * @param env - Environment map (defaults to `process.env`)
 * @returns Resolved {@link ForkModeResolution}
 */
export function resolveForkMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): ForkModeResolution {
  const newRaw = env[ENV_FORK_ONLY_MODE];
  const legacyRaw = env[ENV_LEGACY_FORK];

  const newFlagSet = newRaw !== undefined && newRaw !== "";
  const legacyEnvVarPresent = legacyRaw !== undefined && legacyRaw !== "";

  // New flag wins on value conflict. When unset, default true (fork-only).
  let forkOnlyMode: boolean;
  if (newFlagSet) {
    forkOnlyMode = newRaw === "true";
  } else {
    // Both unset → default true. Legacy-only deployment still defaults to
    // fork-only mode (the legacy flag value does NOT flip the default; it only
    // triggers the detected-emit so operators migrate).
    forkOnlyMode = true;
  }

  // Emit `worker_config_legacy_env_var_detected` when the legacy var is present
  // alongside the new flag (config drift). Legacy-only (no new flag) also emits
  // so a stale deployment surfaces during the backward-compat window.
  const shouldEmitLegacyDetected = legacyEnvVarPresent;

  return { forkOnlyMode, legacyEnvVarPresent, shouldEmitLegacyDetected };
}
