// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * pick-known-keys — SSOT whitelist filter for `Record<string, number>` maps.
 *
 * v0.4.0 PR-D-5 (FIND-TPA-PLAN-05 M, IO Binding Q2): audit_logs primary emit
 * payload から未知 category key を除去し、schema-strict downstream consumer
 * (Grafana / audit parser) への contract violation を防止する helper。
 *
 * v0.4.0 PR-D-5 (FIND-TPA-PLAN-05 M, IO Binding Q2): helper that strips unknown
 * category keys from the audit_logs primary-emit payload to prevent contract
 * violations in schema-strict downstream consumers (Grafana / audit parser).
 *
 * @module utils/pick-known-keys
 */

/**
 * Filter `map` to only keys present in `allowedKeys` whitelist, preserving the
 * numeric values. Returns a new object (does not mutate the input).
 *
 * @param map - Source map. Values are `number` (`category pending snapshot`).
 * @param allowedKeys - Whitelist. Only keys in this set survive.
 * @returns Filtered map typed as `Record<T, number>`. Missing allowed keys
 *          are absent from the result (not zero-filled) — callers may wrap
 *          in a zero-fill if a complete snapshot is required.
 */
export function pickKnownKeys<T extends string>(
  map: Record<string, number>,
  allowedKeys: readonly T[]
): Record<T, number> {
  const allowedSet = new Set<string>(allowedKeys);
  const filtered = {} as Record<T, number>;
  for (const [key, value] of Object.entries(map)) {
    if (allowedSet.has(key)) {
      filtered[key as T] = value;
    }
  }
  return filtered;
}

/**
 * Detect category drift between `map` keys and `allowedKeys` whitelist.
 *
 * Returns a diagnostic object on drift (either missing or unexpected keys),
 * or `null` if `map` keys are Set-equal to `allowedKeys`.
 *
 * v0.4.0 PR-D-5 (FIND-IMPL-IO-13): used at audit_logs write-time to detect
 * drift between `category` map keys and `EMBEDDING_BACKFILL_CATEGORIES` SSOT.
 * Drift is theoretically unreachable because `collectCategoryPendingSnapshot`
 * (`backfill-status.helper.ts`) already enforces Set-equality at collection
 * time — this second check at write-time protects against future code paths
 * that might hand-build pendingSnapshot (e.g., repair CLI).
 *
 * @param map - Source map (values ignored; only keys checked).
 * @param allowedKeys - SSOT whitelist.
 * @returns `{ missing, unexpected }` diagnostic on drift, or `null` on equality.
 */
export function detectCategoryDrift<T extends string>(
  map: Record<string, number>,
  allowedKeys: readonly T[]
): { missing: readonly T[]; unexpected: readonly string[] } | null {
  const allowedSet = new Set<string>(allowedKeys);
  const actualKeys = Object.keys(map);
  const actualSet = new Set<string>(actualKeys);
  const missing = allowedKeys.filter((k) => !actualSet.has(k));
  const unexpected = actualKeys.filter((k) => !allowedSet.has(k));
  if (missing.length === 0 && unexpected.length === 0) return null;
  return { missing, unexpected };
}
