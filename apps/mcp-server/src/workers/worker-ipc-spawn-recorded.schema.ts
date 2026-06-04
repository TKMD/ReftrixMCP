// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker Spawn-Time SSOT Env Var — Plan v3 Track T4
 * UNBLOCK-T4-02 closure (recordWorkerSpawn / recordWorkerRelease).
 *
 * The supervisor records the child's spawn-time + spawn PID synchronously at
 * `fork()` (Module B `WorkerSupervisorLifecycle.spawnWorker()`) into the per-type
 * `WorkerChildState.startedAt` field. To make the child's view of its own
 * spawn-time consistent with the supervisor's view (so that `worker_job_lifecycle`
 * write-hook rows match the supervisor's `findOrphanWebPageIds` lookup keys —
 * INV-WORKER-PID-IDENTITY-005 Sub-A/Sub-C), the child reads the **supervisor-injected
 * env var** `REFTRIX_WORKER_SPAWN_TIME_MS` populated at `fork()` time and uses
 * that value (not its own `Date.now()`).
 *
 * Plan v3 Track T4 Z-a Wave 3 closure (UNBLOCK-V2-02 / TPA-FIND-02 + TDA-FIND-02):
 * the supervisor backfill / orphan detection contract is satisfied entirely via
 * the `worker_job_lifecycle` DB write-hook path (Sub-A `recordWorkerSpawn` →
 * Sub-B `recordWorkerRelease`); a separate IPC echo channel is functionally
 * redundant. The previously-defined `WorkerIpcSpawnRecordedPayloadSchema` /
 * `WorkerIpcReleaseRecordedPayloadSchema` echo schemas had zero consumers and
 * could not actually flow through the parent-side IPC verifier
 * (`WorkerIpcMessageSchema.type` enum did not include `spawn_recorded` /
 * `release_recorded`), so they were removed as dead-code surface per
 * `feedback_no_fake_success` A-3 (predicted weakness preserved as dead code is
 * an anti-pattern; future activation would require WorkerIpcMessageSchema
 * extension + dispatcher branches + audit_logs sink, none of which are
 * planned). The DB write-hook path remains the SSOT.
 *
 * @see PR-V3-T4 design.md §4.3.1 (Code paths enforcing INV-WORKER-PID-IDENTITY-005)
 * @see PR-V3-T4 design.md §7.1 (recordWorkerSpawn / recordWorkerRelease helpers)
 *
 * @module workers/worker-ipc-spawn-recorded.schema
 */

// ============================================================================
// Env var name SSOT
// ============================================================================

/**
 * Env var name for the supervisor-injected spawn-time (epoch ms). Read by the
 * child at startup to obtain the parent's view of its own spawn-time so that
 * `worker_job_lifecycle.worker_spawn_time` and the supervisor's
 * `findOrphanWebPageIds` join key are byte-identical.
 *
 * SSOT: child reads this env var via {@link readSupervisorInjectedSpawnTimeMs};
 * supervisor writes it via Module B `WorkerSupervisorLifecycle.buildSpawnEnv`
 * at fork time. UNBLOCK-V2-04 (TDA-FIND-01) closed the write-side coupling
 * drift by importing this constant in `worker-supervisor-lifecycle.service.ts`
 * instead of using a string literal.
 *
 * Spawn-time SSOT env var. Supervisor writes; child reads.
 */
export const REFTRIX_WORKER_SPAWN_TIME_MS_ENV = "REFTRIX_WORKER_SPAWN_TIME_MS" as const;

/**
 * Read the supervisor-injected spawn-time from env. Returns `null` when the
 * env var is missing / non-numeric (legacy run or test fixture without
 * supervisor); callers MUST fall back to `Date.now()` to preserve Graceful
 * Degradation.
 *
 * Read SSOT spawn-time env var with safe fallback. Returns `null` on missing.
 *
 * @returns Parsed spawn-time (epoch ms) or `null` when invalid.
 */
export function readSupervisorInjectedSpawnTimeMs(): number | null {
  const raw = process.env[REFTRIX_WORKER_SPAWN_TIME_MS_ENV];
  if (raw === undefined || raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return null;
  return parsed;
}
