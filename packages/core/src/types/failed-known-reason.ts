// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FailedKnownReason — Plan v3 Track T4 (PR-V3-T4) NEW enum SSOT.
 *
 * Internal canonical surface for terminal failure classification when the
 * Worker is restarted during an in-flight phase (Pre-Return Pause failure-path
 * race closure). Mirrors the Prisma `FailedKnownReason` enum (4-layer sync per
 * INV-SCHEMA-ENUM-004).
 *
 * Plan v3 Track T4 (PR-V3-T4): the canonical internal enum value for the
 * Worker Pre-Return Pause failure-path race closure mechanism. Mirrors the
 * Prisma `FailedKnownReason` (4-layer sync, INV-SCHEMA-ENUM-004).
 *
 * **Naming convention** (TPA L-01 IO Decision): `_2_5` (underscore form),
 * NOT `_2.5` (dot form). Postgres enum literal does not allow dots; Prisma
 * identifier ergonomics prefer underscore.
 *
 * **SEC H-01 sanitisation**: this enum value MUST NOT leak verbatim to client
 * paths (`data.export` GDPR Art.20 / `audit.query`). Client surfaces apply the
 * 1:1 generic mapping `analysis_pipeline_interrupted` via
 * `sanitizeAnalysisErrorForClient()` (CWE-209 information exposure defense).
 *
 * @see PR-V3-T4 design.md §6 (enum specification + 4-layer sync)
 * @see ADR-0009 Amendment 2 §A2.4 (NEW infrastructure)
 * @see INV-SCHEMA-ENUM-004 standing regression (schema-enum-sync domain)
 *
 * @module types/failed-known-reason
 */

/**
 * Canonical FailedKnownReason union (6 values, exhaustive).
 * 正典 FailedKnownReason union (6 値、exhaustive)。
 */
export type FailedKnownReason =
  | "worker_restart_during_inflight_phase_0"
  | "worker_restart_during_inflight_phase_1"
  | "worker_restart_during_inflight_phase_2_5"
  | "worker_restart_during_inflight_phase_4"
  | "worker_restart_during_inflight_phase_5"
  | "worker_restart_during_inflight_phase_7_5";

/**
 * Runtime-iterable list of all known FailedKnownReason values.
 * Runtime 反復可能な全 FailedKnownReason 値の一覧。
 */
export const FAILED_KNOWN_REASONS: readonly FailedKnownReason[] = [
  "worker_restart_during_inflight_phase_0",
  "worker_restart_during_inflight_phase_1",
  "worker_restart_during_inflight_phase_2_5",
  "worker_restart_during_inflight_phase_4",
  "worker_restart_during_inflight_phase_5",
  "worker_restart_during_inflight_phase_7_5",
] as const;

/**
 * Map a phase number (1-indexed canonical) to the matching FailedKnownReason.
 * Phase 番号 (1-indexed canonical) を対応する FailedKnownReason に map。
 *
 * @param phaseN - Phase identifier ("0" | "1" | "2_5" | "4" | "5" | "7_5")
 * @returns FailedKnownReason or null when phase identifier is unknown
 */
export function failedKnownReasonForPhase(phaseN: string): FailedKnownReason | null {
  const candidate = `worker_restart_during_inflight_phase_${phaseN}`;
  return (FAILED_KNOWN_REASONS as readonly string[]).includes(candidate)
    ? (candidate as FailedKnownReason)
    : null;
}

/**
 * Exhaustive switch helper used by Zod schema mirror + standing regression
 * INV-SCHEMA-ENUM-004 fixture verification.
 *
 * Exhaustive switch helper (Zod mirror + INV-SCHEMA-ENUM-004 fixture verify).
 */
export function assertNeverFailedKnownReason(x: never): never {
  throw new Error(`Unhandled FailedKnownReason: ${String(x)}`);
}
