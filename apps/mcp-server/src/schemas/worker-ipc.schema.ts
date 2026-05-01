// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker IPC Message Schema SSOT (PR-D-8 Phase 2)
 *
 * Single source of truth for the Zod-validated parent↔child IPC contract.
 * Imported by WorkerSupervisor (parent side dispatch) and start-workers.ts
 * (child side emission).
 *
 * Plan v1.1 §3.2.2 (TPA-02 H + SEC-PLAN-04 M resolution). Resolves:
 *   - TPA-02: IPC boundary missing schema → late-bound spoofing / parse drift
 *   - SEC-PLAN-04: unknown-workerType branch missing fail-closed path
 *
 * Backward compatibility: PR-D-8 is a **breaking IPC change**. Parent and
 * child deploy atomically (same bundle); no rolling-upgrade compat needed
 * (single-host deployment).
 *
 * PR-D-8 Phase 2 — `worker-ipc.schema.ts` (TPA-02 H + SEC-PLAN-04 M 解消)。
 *
 * @module schemas/worker-ipc.schema
 */

import { z } from "zod";
import { BACKFILL_JOB_ID_REGEX } from "../queues/embedding-backfill-queue";
import { WORKER_TYPES, type WorkerType } from "../types/worker-type";

// ============================================================================
// Schema
// ============================================================================

/**
 * Zod schema for a single IPC message from child → parent.
 *
 * 子 → 親 の IPC メッセージ Zod スキーマ。
 *
 * Fields:
 * - `type`: message category
 *   - `"job-completed"`: BullMQ Worker.on("completed") fires; parent
 *     increments `jobsProcessed` counter for `maxJobsBeforeRestart` gating.
 *   - `"heartbeat"`: child liveness check; parent updates `lastHeartbeatAt`.
 *   - `"planned-restart-request"`: child requests graceful restart (e.g. RSS
 *     delta threshold crossed); parent initiates restart.
 *   - `"fatal-error"`: child encountered unrecoverable error; parent logs
 *     + SIGTERM-escalates shutdown.
 * - `workerType`: which WorkerType this child represents; used by parent to
 *   verify against in-memory `Map<pid, WorkerType>` binding table (Rule 5 in
 *   Plan v1.1 §3.2.4). Unknown values → fail-closed path (see
 *   `parseWorkerIpcStrict` below).
 * - `jobId`: UUID of the job the message refers to (optional — heartbeat /
 *   planned-restart-request / fatal-error may omit it).
 * - `timestamp`: epoch ms when the child emitted the message (positive int,
 *   for replay attack defense + RSS trace correlation).
 */
export const WorkerIpcMessageSchema = z.object({
  type: z.enum(["job-completed", "heartbeat", "planned-restart-request", "fatal-error"]),
  workerType: z.enum(WORKER_TYPES as readonly [WorkerType, ...WorkerType[]]),
  /**
   * UUID for page worker jobs (UUIDv7), or composite `<UUID>__<category>` for
   * embedding-backfill worker jobs (per `buildBackfillJobId()` SSOT factory).
   * z.union resolves to `string` type (no narrowing required by consumers).
   *
   * @see PR-D-9-patch Plan v1.2 §3.2 Option B + §4.2 implementation
   * @see PR-D-9-patch Registry v1.1 §6.5 IO Plan Re-Decision APPROVE
   * @see ADR-0011 Amendment 3 §A.2 (Phase 3 docs-sync)
   */
  jobId: z
    .union([
      z.string().uuid(), // page worker (UUIDv7)
      z.string().regex(BACKFILL_JOB_ID_REGEX), // embedding-backfill worker (composite)
    ])
    .optional(),
  timestamp: z.number().int().positive(),
});

/** TypeScript type inferred from `WorkerIpcMessageSchema`. */
export type WorkerIpcMessage = z.infer<typeof WorkerIpcMessageSchema>;

// ============================================================================
// Parse helper
// ============================================================================

/**
 * Discriminated return for `parseWorkerIpcStrict`.
 *
 * Three distinct outcomes:
 *   - `{ ok: true, data }`: schema-valid; supervisor proceeds with dispatch.
 *   - `{ ok: false, reason: "unknown-workerType", raw }`: IPC carried an
 *     unrecognised `workerType` value. Parent MUST:
 *       1. Log `logger.error("IPC workerType unknown")` (no raw payload —
 *          sanitizeErrorMessage to avoid CWE-209+CWE-532).
 *       2. SIGTERM the offending child.
 *       3. Suppress respawn for that workerType for 60s (TTL fallback from
 *          SEC-01 self-chained respawn protocol).
 *       4. Emit `audit_logs` entry (action=`worker_type_spoofing_detected`,
 *          actor=`system:worker-supervisor`, 365d retention per LCC-02).
 *   - `{ ok: false, reason: "schema-invalid", raw }`: parse failed for any
 *     other reason (missing field, wrong type, etc.). Parent logs + ignores
 *     (non-fatal — IPC corruption is not necessarily an attack).
 */
export type ParseWorkerIpcResult =
  | { ok: true; data: WorkerIpcMessage }
  | { ok: false; reason: "unknown-workerType" | "schema-invalid"; raw: unknown };

/**
 * Parent-side strict parsing. Never throws — returns discriminated union so
 * caller can distinguish unknown-workerType (fail-closed) from generic
 * schema-invalid (fail-open).
 *
 * **Cyclomatic complexity delta = 0** (PR-D-9-patch Wave 3 verification per
 * TDA-PATCH-04): z.union for jobId resolves at z.safeParse() time; the parser
 * logic (line 109-111 hasInvalidWorkerType detection) is unchanged. Union
 * failure propagates as `code: "invalid_union"` and falls through to existing
 * `schema-invalid` reason path. No new branches added.
 *
 * 親側の厳格 parse。例外は投げず、unknown-workerType (fail-closed) と
 * schema-invalid (fail-open) を区別する discriminated union を返す。
 *
 * @param raw - Raw IPC payload (untrusted; from `process.on("message", ...)`)
 * @returns `ParseWorkerIpcResult`
 */
export function parseWorkerIpcStrict(raw: unknown): ParseWorkerIpcResult {
  const parsed = WorkerIpcMessageSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  // Distinguish unknown-workerType for dedicated telemetry.
  // Zod emits path=["workerType"] with code="invalid_enum_value" when the
  // value is a string but not in the allowed set.
  const hasInvalidWorkerType = parsed.error.issues.some(
    (issue) => issue.path.length === 1 && issue.path[0] === "workerType"
  );
  return {
    ok: false,
    reason: hasInvalidWorkerType ? "unknown-workerType" : "schema-invalid",
    raw,
  };
}
