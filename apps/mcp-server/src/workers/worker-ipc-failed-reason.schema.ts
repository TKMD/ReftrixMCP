// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker IPC FailedReason field schema (Plan v3 Track T4 mitigation per
 * design §7.2).
 *
 * The base `WorkerIpcMessageSchema` lacked a `failedReason` field at HEAD
 * `dcc754ee`; per design §7.2 mitigation, the new field is hoisted to a NEW
 * file to keep Module B (`worker-supervisor-lifecycle.service.ts`) within its
 * soft style target envelope. Module B reads `childState.lastJobFailedReason`
 * (a parent-side state mirror, not an IPC field) and forwards to the failure
 * path service via the type defined here.
 *
 * Plan v3 Track T4 mitigation (design §7.2): IPC schema lacks `failedReason`
 * at HEAD `dcc754ee`; field hoisted to NEW file to keep Module B within
 * soft style target envelope. Module B reads `childState.lastJobFailedReason`
 * and forwards via the type defined here.
 *
 * @see PR-V3-T4 design.md §7.2 (Module B IPC handler revision mitigation)
 *
 * @module workers/worker-ipc-failed-reason.schema
 */

import { z } from "zod";

import { FailedKnownReasonSchema } from "../schemas/failed-known-reason.schema";

// ============================================================================
// Schema
// ============================================================================

/**
 * Optional supplementary IPC payload carrying the `failedReason` identifier.
 *
 * The base `WorkerIpcMessageSchema` MAY include this nested object when the
 * child has reached `markFailedAndAuditAtomic` and committed the failure row
 * before exiting (Sub-1 catch-block-incomplete contract path in design §8.2).
 *
 * For true orphan exits (SIGKILL / OOM Kill / segfault per design §1.2), the
 * supervisor reconstructs from `worker_job_lifecycle` table and does NOT
 * receive this IPC message at all (no child IPC delivery is possible).
 */
export const WorkerIpcFailedReasonPayloadSchema = z.object({
  failed_known_reason: FailedKnownReasonSchema,
  phase_n: z.enum(["0", "1", "2_5", "4", "5", "7_5"]),
  web_page_id: z.string().uuid(),
});

/** TypeScript type inferred from {@link WorkerIpcFailedReasonPayloadSchema}. */
export type WorkerIpcFailedReasonPayload = z.infer<typeof WorkerIpcFailedReasonPayloadSchema>;
