// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Environment variable validators (SSOT) — bounded integer / range checks.
 *
 * Plan v3 T1ev V1 §6.4 で導入された `validateMallocArenaMaxEnv()` SSOT、
 * Plan v3 T5 V1 §1.1 で追加された `validatePartBboxEnv()` SSOT および
 * 共通 helper `parseBoundedIntEnv()` / `parseBoolEnv()`。
 *
 * SSOT validator for `MALLOC_ARENA_MAX` introduced in Plan v3 T1ev V1 §6.4
 * (bound check: warn > 16 / fail > 32). Centralised so that all sites
 * (Site A parent / Site B WorkerSupervisor child / Site C Phase 5 fork)
 * reference the same contract. Plan v3 T5 V1 §1.1 added `validatePartBboxEnv()`
 * for `PartBboxPlaywrightService` env validation, plus shared helpers
 * `parseBoundedIntEnv()` / `parseBoolEnv()` (cross-cutting U-CC-3 SSOT for
 * T1ev / T3-Vision / T5 / future env-validation cohorts).
 *
 * ## Why "read-only validation, not runtime override"
 *
 * glibc の malloc subsystem は `__libc_init_first` で `MALLOC_ARENA_MAX` を
 * 1 度だけ読み、Node.js プロセス起動後に `process.env.MALLOC_ARENA_MAX = "2"`
 * と書き込んでも **構造的に効果ゼロ** (β fake-success trap)。よって本 module は
 * **読取り + log + abort** のみを行い、process.env への代入は決して行わない。
 *
 * 注入は (γ) shell wrapper (`package.json:scripts.worker:start` の prefix) と
 * Node.js 子プロセス fork 時の env (`worker-supervisor.service.ts` /
 * `fork-common.ts` / `phase-5-fork-orchestrator.ts`) の **fork-time only** で行う。
 *
 * glibc reads `MALLOC_ARENA_MAX` once at `__libc_init_first`; runtime writes
 * to `process.env.MALLOC_ARENA_MAX` after Node.js starts have **zero effect**
 * (the β fake-success trap). This module therefore does read + log + abort
 * only — never assigns to process.env. Injection happens via (γ) shell wrapper
 * prefix in package.json or fork-time env construction.
 *
 * @see Plan v3 T1ev V1 §4.2 (γ winning contract)
 * @see Plan v3 T1ev V1 §6.4 (SSOT bound check)
 * @see FIND-PLAN-SEC-T1EV-02 (M severity, deadline 2026-05-11)
 *
 * @module utils/env-validators
 */

/**
 * `validateMallocArenaMaxEnv()` の戻り値。3-level severity (ok / warn / fail)。
 *
 * Return type for `validateMallocArenaMaxEnv()` — 3-level severity.
 */
export interface MallocArenaMaxValidationResult {
  /** Parsed integer value. 0 when input was undefined/invalid. */
  parsed: number;
  /** Severity classification — see constants below. */
  level: "ok" | "warn" | "fail";
  /** Human-readable message; always populated for log emission. */
  message: string;
}

/**
 * Recommended upper bound. Values above this trigger a warn (not fail) — the
 * caller should log but continue.
 *
 * 推奨上限。これを超えると warn 扱いだが起動は継続。
 */
export const MALLOC_ARENA_MAX_WARN_THRESHOLD = 16 as const;

/**
 * Hard upper bound (CWE-770 budget overflow guard). Values above this trigger
 * fail-fast — the caller MUST `process.exit(1)` (or equivalent abort).
 *
 * 強制上限 (CWE-770 budget overflow ガード)。これを超えると fail-fast。
 */
export const MALLOC_ARENA_MAX_FAIL_THRESHOLD = 32 as const;

/**
 * Validate a `MALLOC_ARENA_MAX` env var raw string against the bounded range
 * contract. Pure function — does not read process.env, does not write logs,
 * does not throw. Caller is responsible for emission + abort.
 *
 * `MALLOC_ARENA_MAX` の生文字列を範囲 contract に対して検証する純関数。
 * process.env 参照・ログ出力・throw のいずれも行わない。
 *
 * @param rawValue - Raw value from `process.env.MALLOC_ARENA_MAX` (or `undefined`)
 * @returns Validation result. `level === "fail"` requires fail-fast abort.
 *
 * @example
 * ```typescript
 * const result = validateMallocArenaMaxEnv(process.env.MALLOC_ARENA_MAX);
 * if (result.level === "fail") {
 *   console.error(`[start-workers] ${result.message}`);
 *   process.exit(1);
 * } else if (result.level === "warn") {
 *   logger.warn(result.message);
 * } else {
 *   logger.info(result.message);
 * }
 * ```
 */
export function validateMallocArenaMaxEnv(
  rawValue: string | undefined
): MallocArenaMaxValidationResult {
  if (rawValue === undefined) {
    return {
      parsed: 0,
      level: "ok",
      message: "MALLOC_ARENA_MAX unset (glibc default applies)",
    };
  }
  // Note: We do not trim aggressively because glibc treats the env var
  // byte-for-byte; non-numeric content yields glibc's own default behaviour.
  // For our SSOT contract we still treat non-positive-int as "fail" because
  // operator misconfiguration (e.g. "abc") is a clear bug to surface.
  const n = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(n) || n < 1) {
    return {
      parsed: 0,
      level: "fail",
      message: `MALLOC_ARENA_MAX="${rawValue}" is not a positive integer (operator misconfiguration)`,
    };
  }
  if (n > MALLOC_ARENA_MAX_FAIL_THRESHOLD) {
    return {
      parsed: n,
      level: "fail",
      message: `MALLOC_ARENA_MAX=${n} exceeds upper bound ${MALLOC_ARENA_MAX_FAIL_THRESHOLD} (CWE-770 budget overflow guard; see Plan v3 T1ev V1 §6.4)`,
    };
  }
  if (n > MALLOC_ARENA_MAX_WARN_THRESHOLD) {
    return {
      parsed: n,
      level: "warn",
      message: `MALLOC_ARENA_MAX=${n} exceeds recommended bound ${MALLOC_ARENA_MAX_WARN_THRESHOLD} (potential RSS regression; see Plan v3 T1ev V1 §6.4)`,
    };
  }
  return {
    parsed: n,
    level: "ok",
    message: `MALLOC_ARENA_MAX=${n} (within recommended bounds; see Plan v3 T1ev V1 §6.4)`,
  };
}

// ============================================================================
// PartBboxPlaywrightService env config (Plan v3 T5 V1 §1.1 — U-T5-1)
// ============================================================================

/**
 * Resolved configuration for `PartBboxPlaywrightService` after boot-time
 * env validation.
 *
 * Plan v3 T5 V1 §1.1 SSOT bounds:
 *   - `preEmptiveScrollMaxIterations`: 1-50 (Phase 0 LAZY_SCROLL_MAX_ITERATIONS=50 SSOT alignment)
 *   - `staleDetectionTolerancePx`: 1-2000 (CWE-770 attack vector cap;
 *     `=10000` would silently degrade Option C detection to a no-op)
 *   - `layeredTotalTimeoutMs`: 5000-60000 (5s-60s; matches existing C-06
 *     `BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS=60000` SSOT upper bound)
 *
 * Throwing semantics (vs. legacy `safeParseInt()` graceful default) are
 * appropriate here because mis-configured budget envs must not silently
 * widen the attack surface or degrade detection invariants.
 */
export interface PartBboxEnvConfig {
  /** Option A: pre-emptive scroll replay enabled (default `true`). */
  preEmptiveScrollEnabled: boolean;
  /** Option A: max scroll replay iterations (1-50, default 30). */
  preEmptiveScrollMaxIterations: number;
  /** Option B: targeted requery for stale/unresolved parts enabled (default `true`). */
  targetedRequeryEnabled: boolean;
  /** Option C: stale-bbox detection enabled (default `true`). */
  staleDetectionEnabled: boolean;
  /** Option C: tolerance px for `absoluteY ≈ sectionStartY` (1-2000, default 500). */
  staleDetectionTolerancePx: number;
  /** Cumulative pipeline timeout (5000-60000, default 30000). */
  layeredTotalTimeoutMs: number;
}

/**
 * Validate and resolve `PartBboxPlaywrightService` env vars at module-load
 * time. Throws on invalid env so the service fails fast at boot.
 *
 * Per Plan v3 T5 V1 §1.1 (U-T5-1): single call site at module top of
 * `part-bbox-playwright.service.ts`. Throwing semantics align with
 * `validateBoundedIntEnv()` SSOT precedent (FIND-PLAN-SEC-CROSS-03 M).
 *
 * @param env - process env (defaults to `process.env`; injected for tests)
 * @returns Resolved {@link PartBboxEnvConfig}
 * @throws Error on invalid env (NaN / out-of-range / non-canonical bool)
 *
 * @example
 * ```typescript
 * // Module load (fail-fast at boot):
 * const cfg = validatePartBboxEnv();
 *
 * // CWE-770 attack vector — fails fast:
 * process.env.BBOX_STALE_DETECTION_TOLERANCE_PX = "10000";
 * validatePartBboxEnv(); // throws Error
 * ```
 */
export function validatePartBboxEnv(env: NodeJS.ProcessEnv = process.env): PartBboxEnvConfig {
  return {
    preEmptiveScrollEnabled: parseBoolEnv(env["BBOX_PREEMPTIVE_SCROLL_ENABLED"], true),
    preEmptiveScrollMaxIterations: parseBoundedIntEnv(
      env["BBOX_PREEMPTIVE_SCROLL_MAX_ITERATIONS"],
      30,
      1,
      50,
      "BBOX_PREEMPTIVE_SCROLL_MAX_ITERATIONS"
    ),
    targetedRequeryEnabled: parseBoolEnv(env["BBOX_TARGETED_REQUERY_ENABLED"], true),
    staleDetectionEnabled: parseBoolEnv(env["BBOX_STALE_DETECTION_ENABLED"], true),
    staleDetectionTolerancePx: parseBoundedIntEnv(
      env["BBOX_STALE_DETECTION_TOLERANCE_PX"],
      500,
      1,
      2000,
      "BBOX_STALE_DETECTION_TOLERANCE_PX"
    ),
    layeredTotalTimeoutMs: parseBoundedIntEnv(
      env["BBOX_LAYERED_TOTAL_TIMEOUT_MS"],
      30_000,
      5_000,
      60_000,
      "BBOX_LAYERED_TOTAL_TIMEOUT_MS"
    ),
  };
}

// ============================================================================
// Shared helpers (cross-cutting SSOT per Plan v3 T5 V1 §1.7 U-CC-3)
// ============================================================================

/**
 * Strict bool env parser: accepts only `"true"` / `"false"` (case-sensitive)
 * — non-canonical values (`"1"` / `"True"` / `"yes"`) THROW per CWE-1188
 * "Insecure Default Initialization" mitigation. Mirrors C-06
 * `BBOX_RESOLVE_RELOAD_ENABLED` silent-enable risk policy in
 * `part-bbox-playwright.service.ts:127-133` (FIND-PLAN-SEC-04).
 *
 * `undefined` / `""` returns `defaultValue` (treats unset as default — a
 * deliberate choice for opt-in/opt-out env vars).
 *
 * @param raw - env var raw value
 * @param defaultValue - default when undefined / empty
 * @returns Parsed boolean
 * @throws Error on non-canonical value
 */
export function parseBoolEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === "") return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Invalid boolean env: '${raw}' (must be 'true' or 'false', case-sensitive)`);
}

/**
 * Strict bounded integer env parser: accepts only canonical decimal integers
 * in `[minValue, maxValue]` — out-of-range / NaN / non-integer / leading-plus
 * / hex / float ALL throw.
 *
 * Plan v3 T5 V1 §1.1 / §1.7 U-CC-3 cross-cutting SSOT helper. Used by
 * {@link validatePartBboxEnv} and (future) T1ev / T3-Vision env validators.
 *
 * **Distinct from `safeParseInt()`** (which returns default on out-of-range):
 * this throws to fail-fast at boot for budget-defining env vars where
 * mis-configuration must not silently widen attack surface.
 *
 * @param raw - env var raw value (undefined returns defaultValue)
 * @param defaultValue - default when undefined / empty
 * @param minValue - inclusive lower bound
 * @param maxValue - inclusive upper bound
 * @param varName - env var name (PII-safe identifier for error message)
 * @returns Parsed integer
 * @throws Error on NaN / non-integer / out-of-range
 */
export function parseBoundedIntEnv(
  raw: string | undefined,
  defaultValue: number,
  minValue: number,
  maxValue: number,
  varName: string
): number {
  if (raw === undefined || raw === "") return defaultValue;
  // Canonical decimal integer only: optional leading minus + digits. Rejects
  // floats, hex, leading-plus, whitespace-padded, NaN strings.
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(
      `Invalid ${varName}: '${raw}' (must be a decimal integer in ${minValue}..${maxValue})`
    );
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < minValue || parsed > maxValue) {
    throw new Error(`Invalid ${varName}: '${raw}' (must be integer in ${minValue}..${maxValue})`);
  }
  return parsed;
}
