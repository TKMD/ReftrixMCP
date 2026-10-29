// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Removed environment variable warning.
 *
 * `WEBUI_INTERNAL_API_ENABLED` used to start the internal read HTTP API (`/internal/*`).
 * The API was removed, so the variable is ignored. Operators who still set it get exactly one
 * `[DEPRECATION]` warning at startup so a stale setting is not silently dropped. The warning
 * itself is removed in the next minor release.
 *
 * 内部 read HTTP API (`/internal/*`) を起動していた `WEBUI_INTERNAL_API_ENABLED` は、API 撤去により
 * 無視される。設定が残っている運用者には起動時に `[DEPRECATION]` warn を 1 本だけ出す。
 * この warn 自体は次の minor release で撤去する。
 *
 * @module utils/removed-env-warning
 */

import { logger as defaultLogger } from "./logger";

/** Name of the removed variable. */
export const REMOVED_INTERNAL_API_ENV = "WEBUI_INTERNAL_API_ENABLED";

interface WarnLogger {
  warn: (message: string) => void;
}

/**
 * Emit one `[DEPRECATION]` warning when the removed variable is set (any non-empty value).
 *
 * @returns true when a warning was emitted
 */
export function warnIfRemovedInternalApiEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: WarnLogger = defaultLogger
): boolean {
  const value = env[REMOVED_INTERNAL_API_ENV];
  if (value === undefined || value === "") {
    return false;
  }
  log.warn(
    `[DEPRECATION] ${REMOVED_INTERNAL_API_ENV} is no longer used: the internal read HTTP API (/internal/*) was removed. The variable is ignored and will stop being recognized in the next minor release.`
  );
  return true;
}
