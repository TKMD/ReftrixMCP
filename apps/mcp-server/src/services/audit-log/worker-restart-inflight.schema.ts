// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker Restart In-Flight audit_logs metadata Zod schema —
 * Plan v3 Track T4 (PR-V3-T4) SEC M-03 contract.
 *
 * Validates the `audit_logs.metadata` payload for the
 * `worker_restart_during_inflight_phase` action emitted by:
 *   1. `markFailedAndAuditAtomic` (child-emitted catch-block path) — Sub-1
 *   2. `WorkerSupervisorFailurePathService.backfillOrphanWebPageRow` (true
 *      orphan path: SIGKILL / OOM / segfault) — Sub-3
 *   3. `secondary worker_orphan_backfill_skipped_due_to_live_lock` action —
 *      INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001 Sub-A
 *
 * SEC M-03: schema-validates payload before audit_logs write. Prevents
 * `metadata` schema drift causing audit trail incoherence.
 *
 * SEC M-03: schema-validates payload before audit_logs write. Prevents
 * `metadata` schema drift causing audit trail incoherence.
 *
 * @see PR-V3-T4 design.md §2.2 Contract 1 + §2.2 Contract 3
 * @see ADR-0009 Amendment 2 §A2.3 metadata Zod schema location
 *
 * @module services/audit-log/worker-restart-inflight.schema
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import { FailedKnownReasonSchema } from "../../schemas/failed-known-reason.schema";

// ============================================================================
// Schema
// ============================================================================

/**
 * Zod schema for `audit_logs.metadata` payload of action
 * `worker_restart_during_inflight_phase`.
 *
 * Fields:
 * - `failed_known_reason`: canonical FailedKnownReason enum value
 * - `phase_n`: phase identifier ("0" | "1" | "2_5" | "4" | "5" | "7_5"). Set
 *   by both child-emitted (catch tail) and supervisor-backfill (true orphan).
 * - `child_pid`: truncated child PID (`pid_<sha256_8chars>` per SEC H-02
 *   audit.query redaction; raw PID forbidden).
 * - `phase_reconstruction`: `'exact'` when child catch-block reaches helper;
 *   `'best_effort'` when supervisor reconstructs from `last_completed_phase
 *   + 1`. TPA-M-01 SLO: best_effort ratio ≤ 10% rolling 30d.
 * - `exit_signal`: optional signal name (SIGKILL / SIGABRT / etc.) — only
 *   populated for supervisor-backfill path.
 * - `reason`: discriminator for primary vs fallback paths. `'self_emit'` =
 *   child-emit, `'backfilled_from_orphan'` = supervisor backfill.
 */
export const WorkerRestartInflightAuditMetadataSchema = z.object({
  failed_known_reason: FailedKnownReasonSchema,
  phase_n: z.enum(["0", "1", "2_5", "4", "5", "7_5"]),
  child_pid: z.string().regex(/^pid_[0-9a-f]{8}$/, {
    message: "child_pid must be sanitised to pid_<sha256_8chars> form",
  }),
  phase_reconstruction: z.enum(["exact", "best_effort"]),
  exit_signal: z.string().max(20).optional(),
  reason: z.enum(["self_emit", "backfilled_from_orphan"]),
});

/** TypeScript type inferred from {@link WorkerRestartInflightAuditMetadataSchema}. */
export type WorkerRestartInflightAuditMetadata = z.infer<
  typeof WorkerRestartInflightAuditMetadataSchema
>;

/**
 * Zod schema for `audit_logs.metadata` payload of action
 * `worker_orphan_backfill_skipped_due_to_live_lock` (SEC H-03 secondary entry).
 *
 * Emitted when supervisor backfill encounters a live lock owned by a fresh
 * Worker — the backfill is skipped fail-closed to avoid trampling an
 * in-flight job. INV-WORKER-SUPERVISOR-BACKFILL-FAIL-CLOSED-001 Sub-A.
 */
export const WorkerOrphanBackfillSkippedAuditMetadataSchema = z.object({
  child_pid: z.string().regex(/^pid_[0-9a-f]{8}$/),
  probe_outcome: z.enum(["existing_live_lock"]),
  reason: z.literal("backfill_skipped_due_to_live_lock"),
});

/** TypeScript type inferred from {@link WorkerOrphanBackfillSkippedAuditMetadataSchema}. */
export type WorkerOrphanBackfillSkippedAuditMetadata = z.infer<
  typeof WorkerOrphanBackfillSkippedAuditMetadataSchema
>;

// ============================================================================
// PID truncation helper (SEC H-02 audit.query redaction)
// ============================================================================

/**
 * Hash a raw process PID to the truncated `pid_<sha256_8chars>` form used by
 * audit_logs.metadata (SEC H-02 / CWE-209 information exposure defense).
 *
 * Synchronous SHA-256 (Node `node:crypto`) is intentionally used here so this
 * helper is callable from non-async paths (audit_logs emit is fire-and-forget).
 *
 * @param rawPid - Raw process PID (number)
 * @returns Truncated form `pid_<sha256_8chars>` (12 chars total)
 */
export function truncateChildPid(rawPid: number): string {
  const hash = createHash("sha256").update(String(rawPid)).digest("hex");
  return `pid_${hash.slice(0, 8)}`;
}
