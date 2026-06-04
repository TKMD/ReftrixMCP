// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker stderr secondary capture config — Plan v4.5 PR1 NEW-U-11 L4 Zod refinement
 *
 * Plan v4.5 V3 §P0.5.runtime 4-layer 防御 L4 (Hard upper bound): startup-time
 * Zod schema validation で env var を bounded range enforce、超過時 fail-fast。
 *
 * Plan v4.5 V3 §P0.5.runtime 4-layer defense L4 (Hard upper bound): startup-time
 * Zod schema validation enforces env vars within bounded ranges; fail-fast on
 * out-of-range. Centralised SSOT for the stderr secondary-capture subsystem.
 *
 * ## Decision contract (Plan v4.5 V3 §P0.5)
 *
 * - `REFTRIX_WORKER_STDERR_REDIRECT_ENABLED` (default `true`): master toggle for
 *   Option (b) secondary capture; rollback path per ADR-0036 §D4
 * - `REFTRIX_WORKER_STDERR_RETENTION_DAYS` (default 7、min 1 max 30): GDPR
 *   Art.5(1)(e) storage limitation contract horizon
 * - `REFTRIX_WORKER_STDERR_DIR` (default `/tmp/reftrix-worker-stderr/`):
 *   dedicated 0o700 dir, Δ10 3-stage whitelist root
 * - `REFTRIX_WORKER_STDERR_CRON_INTERVAL_MS` (default 21600000 = 6h、min
 *   3600000 = 1h、max 86400000 = 24h): L1 frequent cleanup cron interval, 24h
 *   hard upper bound (NEW-U-11 L4 Zod enforce)
 *
 * @module config/worker-stderr-config
 * @see Plan v4.5 V3 §P0.5.runtime (4-layer 防御 L4)
 * @see ADR-0036 §D4.1 (stderr file disk full racing 4-layer 防御)
 */

import { logger } from "../utils/logger";

/**
 * Resolved configuration for the worker stderr secondary capture subsystem.
 */
export interface WorkerStderrConfig {
  /** Master enable flag for Option (b) secondary capture (default `true`). */
  redirectEnabled: boolean;
  /** Retention horizon in days (default 7、min 1 max 30, GDPR Art.5(1)(e)). */
  retentionDays: number;
  /** Dedicated 0o700 directory root for stderr files. */
  dir: string;
  /** L1 cleanup cron interval (default 6h、min 1h、max 24h hard upper bound). */
  cronIntervalMs: number;
}

const DEFAULT_REDIRECT_ENABLED = true;
const DEFAULT_RETENTION_DAYS = 7;
const RETENTION_DAYS_MIN = 1;
const RETENTION_DAYS_MAX = 30;
const DEFAULT_DIR = "/tmp/reftrix-worker-stderr/";
const DEFAULT_CRON_INTERVAL_MS = 21_600_000; // 6h
const CRON_INTERVAL_MIN_MS = 3_600_000; // 1h
const CRON_INTERVAL_MAX_MS = 86_400_000; // 24h hard upper bound (NEW-U-11 L4)

/**
 * Validate and resolve `REFTRIX_WORKER_STDERR_*` env vars at startup.
 *
 * Throwing semantics (fail-fast at boot) match the `validateBoundedIntEnv()`
 * SSOT precedent (FIND-PLAN-SEC-CROSS-03 M、Plan v3 T5 §1.1 U-T5-1) since
 * mis-configured budget envs must not silently widen attack surface or
 * degrade disk-pressure defense invariants.
 *
 * @param env - process env (defaults to `process.env`; injected for tests)
 * @returns Resolved {@link WorkerStderrConfig}
 * @throws Error on invalid env (out-of-range / non-canonical bool / NaN)
 */
export function validateWorkerStderrEnv(env: NodeJS.ProcessEnv = process.env): WorkerStderrConfig {
  const redirectEnabled = parseStrictBool(
    env["REFTRIX_WORKER_STDERR_REDIRECT_ENABLED"],
    DEFAULT_REDIRECT_ENABLED,
    "REFTRIX_WORKER_STDERR_REDIRECT_ENABLED"
  );
  const retentionDays = parseBoundedInt(
    env["REFTRIX_WORKER_STDERR_RETENTION_DAYS"],
    DEFAULT_RETENTION_DAYS,
    RETENTION_DAYS_MIN,
    RETENTION_DAYS_MAX,
    "REFTRIX_WORKER_STDERR_RETENTION_DAYS"
  );
  const dirRaw = env["REFTRIX_WORKER_STDERR_DIR"];
  const dir =
    dirRaw === undefined || dirRaw === ""
      ? DEFAULT_DIR
      : dirRaw.endsWith("/")
        ? dirRaw
        : `${dirRaw}/`;
  const cronIntervalMs = parseBoundedInt(
    env["REFTRIX_WORKER_STDERR_CRON_INTERVAL_MS"],
    DEFAULT_CRON_INTERVAL_MS,
    CRON_INTERVAL_MIN_MS,
    CRON_INTERVAL_MAX_MS,
    "REFTRIX_WORKER_STDERR_CRON_INTERVAL_MS"
  );

  return { redirectEnabled, retentionDays, dir, cronIntervalMs };
}

/**
 * Load worker stderr config with graceful fallback. Logs an error and
 * returns defaults on validation failure so the worker process can still
 * start (PR1 atomic merge mandate, observability-only path).
 */
export function loadWorkerStderrConfigOrDefault(): WorkerStderrConfig {
  try {
    return validateWorkerStderrEnv();
  } catch (error) {
    logger.error("[worker-stderr-config] Invalid env, falling back to defaults", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      redirectEnabled: DEFAULT_REDIRECT_ENABLED,
      retentionDays: DEFAULT_RETENTION_DAYS,
      dir: DEFAULT_DIR,
      cronIntervalMs: DEFAULT_CRON_INTERVAL_MS,
    };
  }
}

function parseStrictBool(raw: string | undefined, defaultValue: boolean, varName: string): boolean {
  if (raw === undefined || raw === "") return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Invalid ${varName}: '${raw}' (must be 'true' or 'false', case-sensitive)`);
}

function parseBoundedInt(
  raw: string | undefined,
  defaultValue: number,
  minValue: number,
  maxValue: number,
  varName: string
): number {
  if (raw === undefined || raw === "") return defaultValue;
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

// Test-only exports for INV-WORKER-STDERR-DISK-PRESSURE-001 L4 Zod refinement
// verification (range boundary integration test).
/** @internal */
export const __WORKER_STDERR_CONFIG_DEFAULTS_FOR_TEST = {
  CRON_INTERVAL_MIN_MS,
  CRON_INTERVAL_MAX_MS,
  DEFAULT_CRON_INTERVAL_MS,
  RETENTION_DAYS_MIN,
  RETENTION_DAYS_MAX,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_DIR,
} as const;
