// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `bootstrapWorkersForPageAnalyze` — page.analyze / page.batch_analyze handler
 * 起動時の Worker bootstrap helper / Worker bootstrap helper invoked at
 * page.analyze / page.batch_analyze handler entry.
 *
 * **Wave 1 (C-11 + C-04 + C-01) + Wave 2 (audit emit observability)**:
 *   - C-11 (FIND-PLAN-TDA-04 / FIND-PLAN-SEC-04): inline `if (ENABLE_BACKFILL_AUTOSPAWN ...)`
 *     guard を共有 helper に抽出して両 tool entry point の重複を排除。
 *   - C-04 (ADR-0018 §Decision 1 Supplement): `audit_logs.action` SSOT 固定 string 定数
 *     `AUDIT_ACTION_EMBEDDING_BACKFILL_AUTOSPAWN_FAILED` 経由で emit する。
 *   - C-01 (Conflict-1 cron path safety): `BackfillReconciliationCron` は
 *     embedding-backfill-worker child 内で schedule されるため、本 bootstrap が
 *     auto-spawn 経路の単一 entry point となる。
 *   - Wave 2 (Conflict-2 joint resolution / FIND-PLAN-LCC-01 + TPA-PLAN-05 +
 *     FIND-PLAN-SEC-05): `ensureAllWorkersRunningStaggered()` の silent void
 *     rejection を `[SLO_MARKER] auto_spawn_rejected` log + `audit_logs` emit に
 *     変換 (PR-D-5 5-tier SLO L1.5 SLO_MARKER pattern continuity)。
 *
 * **`ENABLE_BACKFILL_AUTOSPAWN` env var strict semantics**:
 *   - `"false"` → page worker のみ spawn (legacy `ensureWorkerRunning()`).
 *   - `"true"` / unset → page + embedding-backfill 両 worker を staggered spawn.
 *   - その他 (`"1"`, `"yes"`, `"True"`, `""`, `"DISABLED"` 等) → default behaviour
 *     (staggered spawn) に fall back し `logger.warn` で non-canonical value を通知。
 *     FIND-PLAN-SEC-04 寛容パース silent enable risk (CWE-1188) 対策。
 *
 * **Vision unload sequencing precondition** is governed by ADR-0011 Amendment 2
 * §A2.2 Sequencing Contract (line 427-509) — the supervisor's
 * `ensureAllWorkersRunningStaggered()` performs Ollama `/api/ps` precondition
 * probe immediately before secondary `embedding-backfill` spawn. This helper is
 * the production caller of that API surface.
 *
 * **Failure handling (silent stall 再発防止)** per Conflict-2 joint resolution:
 *   - The `.catch()` block converts what would otherwise be a silent
 *     unhandled-rejection into:
 *     1. `[SLO_MARKER] auto_spawn_rejected` log line (Grafana Loki rate metric for
 *        L1.5 SLO compensation per ADR-0018 §Decision 1 Supplement pattern).
 *     2. `audit_logs` entry with `action='embedding_backfill_autospawn_failed'`
 *        (per ADR-0018 §Decision 1 Supplement S4/S5 SSOT).
 *   - `sanitizeErrorMessage(err)` ensures no internal Prisma/SQL/stack-trace
 *     leakage (CWE-209 enforcement per `.claude/rules/security.md`).
 *
 * **Why fire-and-forget (`void`)?** `ensureAllWorkersRunningStaggered()` returns
 * `Promise<void>` because it `await`s primary heartbeat (up to 10s). The tool
 * handler MUST NOT block on worker spawn — page.analyze enqueue itself does not
 * depend on backfill worker presence (BullMQ accepts enqueue regardless). The
 * async spawn proceeds in parallel with page.analyze enqueue; by the time
 * Phase 5 reaches sync_overflow (~5+ minutes for a typical page), the backfill
 * worker is alive.
 *
 * @see Plan v1.1 §4.1.2 / §5.1.17 (helper design + call sites)
 * @see Finding Registry v2 §4.2 (Conflict-2 joint resolution)
 * @see ADR-0011 Amendment 2 §A2.2 (Vision unload precondition)
 * @see ADR-0018 §Decision 1 Supplement S4/S5 (audit_logs.action SSOT)
 *
 * @module tools/page/_shared/worker-bootstrap
 */

import { getWorkerSupervisor } from "../../../services/worker-supervisor.service";
import { emitSupervisorAuditLog } from "../../../services/worker-supervisor-helpers";
import { AUDIT_ACTION_EMBEDDING_BACKFILL_AUTOSPAWN_FAILED } from "../../../audit/audit-actions";
import { logger } from "../../../utils/logger";
import { sanitizeErrorMessage } from "../../../utils/sanitize-error";

/**
 * page.analyze / page.batch_analyze handler 起動時の Worker bootstrap.
 *
 * Idempotent: 複数回呼び出されても `WorkerSupervisor` の per-type state machine
 * が `running` チェックを行うため副作用は発生しない (PR-D-8 §3.2.3 contract)。
 *
 * Idempotent: multiple invocations are safe because `WorkerSupervisor`'s
 * per-type state machine performs `running` checks (PR-D-8 §3.2.3 contract).
 *
 * @see Plan v1.1 §4.1.2 code skeleton (line 225-258)
 */
export function bootstrapWorkersForPageAnalyze(): void {
  const flag = process.env.ENABLE_BACKFILL_AUTOSPAWN;

  // C-11 strict semantics: `"false"` → legacy single-worker path (page only).
  // FIND-PLAN-SEC-04 strict parsing: ONLY `"false"` triggers legacy mode; any
  // other non-canonical value falls through to default (staggered spawn) +
  // `logger.warn` notification (CWE-1188 mitigation).
  if (flag === "false") {
    getWorkerSupervisor().ensureWorkerRunning(); // legacy (page only)
    return;
  }

  // C-11 non-canonical value warning (FIND-PLAN-SEC-04): accept only `"true"` or
  // `"false"` as canonical; treat any other non-undefined value as default
  // (staggered) + warn. Examples of rejected typos: `"1"`, `"yes"`, `"True"`,
  // `""`, `"DISABLED"`, etc.
  if (flag !== undefined && flag !== "true") {
    logger.warn(
      "[backfill-autospawn] non-canonical ENABLE_BACKFILL_AUTOSPAWN value; treating as default (staggered spawn). Accept only 'true'/'false'.",
      { flag }
    );
  }

  // Wave 2 (Conflict-2 joint resolution): convert silent void rejection into
  // observable `[SLO_MARKER] auto_spawn_rejected` log + audit_logs entry.
  void getWorkerSupervisor()
    .ensureAllWorkersRunningStaggered()
    .catch((err: unknown) => {
      const errorMessage = sanitizeErrorMessage(err);

      // L1.5 SLO_MARKER log line (PR-D-5 5-tier SLO continuity).
      logger.warn("[SLO_MARKER] auto_spawn_rejected", { error: errorMessage });

      // Audit emit per ADR-0018 §Decision 1 Supplement S4/S5 SSOT.
      // Existing helper signature: (action, workerType, details, result).
      // workerType `"embedding-backfill"` is the worker that failed to spawn
      // (per Plan v1.1 §5.1.17 + Registry §4.2 Conflict-2 cross-link).
      emitSupervisorAuditLog(
        AUDIT_ACTION_EMBEDDING_BACKFILL_AUTOSPAWN_FAILED,
        "embedding-backfill",
        { error: errorMessage },
        "failure"
      );
    });
}
