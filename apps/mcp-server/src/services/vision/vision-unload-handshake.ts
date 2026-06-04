// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision unload handshake — `WorkerSupervisor.ensureAllWorkersRunningStaggered()`
 * の secondary (`embedding-backfill`) spawn 直前に Ollama Vision residual を
 * 検証する precondition probe (ADR-0011 Amendment 2 §A2.2.3)。
 *
 * Vision unload handshake — verifies Ollama Vision residual right before the
 * `WorkerSupervisor` spawns the secondary `embedding-backfill` child
 * (ADR-0011 Amendment 2 §A2.2.3 Precondition Check).
 *
 * 設計原則 / Design principles:
 *   - **Fail-closed**: probe failure 時も secondary spawn を defer する
 *     (32GB tier RSS budget 保護、GDPR Art.32(1)(b) ongoing availability)。
 *   - **SSRF-safe**: `validateOllamaLocalhostUrl()` で localhost 限定。
 *   - **Idempotent**: side-effect は audit_logs emit のみ。
 *   - **PII-safe**: model name / size_vram のみ details に格納、boot token /
 *     stack trace は出力禁止 (CWE-209 enforcement via `sanitizeErrorMessage`)。
 *   - **WorkerSupervisor LoC neutral**: probe / fetch / parse / audit emit を
 *     全て本 module 内で完結させ、WorkerSupervisor 側 LoC delta を 0 に保つ
 *     (PR-D-9 CO-PRDD9-01 contract)。
 *
 * @see ADR-0011 Amendment 2 §A2.2.3 (line 481-496)
 * @see PR-D-9 Finding Registry TPA-IMPL-01
 * @see Plan v1.1 §10 IO Impl Decision UNB-IMPL-1
 *
 * @module services/vision/vision-unload-handshake
 */

import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { emitSupervisorAuditLog } from "../worker-supervisor-helpers";
import {
  AUDIT_ACTION_VISION_RESIDUAL_DETECTED,
  AUDIT_ACTION_BACKFILL_SECONDARY_DEFERRED,
  AUDIT_ACTION_VISION_PROBE_FAILED,
} from "../../audit/audit-actions";
import { validateOllamaLocalhostUrl } from "../../workers/phases/types";

// ============================================================================
// Constants
// ============================================================================

/** ADR-0011 Amendment 2 §A2.2.3 step 1: probe timeout 3s. */
const VISION_PROBE_TIMEOUT_MS = 3_000;

/** Default Ollama URL (SSRF-safe localhost). */
const OLLAMA_DEFAULT_URL = "http://localhost:11434";

/**
 * Llama Vision model name prefix (ADR-0011 Amendment 2 §A2.2.3 step 2).
 * Apple Silicon Metal Unified Memory も同 prefix で報告される。
 */
const VISION_MODEL_NAME_PREFIX = "llama3.2-vision";

/**
 * Vision residual backfill enqueue delay (Plan v3 T3-Vision V1 §C-1 SSOT triple).
 *
 * `vision_residual` 検出時、`embedding-backfill` を即座に enqueue するのではなく
 * 30s 遅延させて Ollama Vision の自然な unload を待つ (CPU cycle 節約)。
 * `BackfillRecoveryReconciliationService` がこの delay を BullMQ
 * `delay` option として渡す。
 *
 * Delay before enqueuing `embedding-backfill` retry after detecting
 * `vision_residual` — waits 30s for Ollama Vision to unload naturally
 * (saves CPU cycles vs. immediate retry).
 *
 * Exported as `VISION_RESIDUAL_BACKFILL_ENQUEUE_DELAY_MS`
 * (FIND-WAVE4-TDA-V2-H-01 export contract).
 *
 * @see Plan v3 T3-Vision V1 §C-1 SSOT triple
 * @see ADR-0030 §Dependency Upgrade Gate
 */
export const VISION_RESIDUAL_BACKFILL_ENQUEUE_DELAY_MS = 30_000;

/**
 * Vision residual terminal bound (Plan v3 T3-Vision V1 §C-1 SSOT triple).
 *
 * `vision_residual` 状態の最大滞留時間 (5min)。この閾値を超えると
 * `BackfillRecoveryReconciliationService` が `failureReason` を
 * `vision_unload_timeout` に transition させる (axis A 5min terminal bound)。
 *
 * Maximum dwell time in `vision_residual` state (5min). Beyond this bound,
 * the recovery service transitions `failureReason` →
 * `vision_unload_timeout` (axis A terminal bound).
 *
 * Exported as `VISION_RESIDUAL_TERMINAL_BOUND_MS` (FIND-WAVE4-TDA-V2-H-01
 * export contract).
 *
 * @see Plan v3 T3-Vision V1 §C-1 SSOT triple
 */
export const VISION_RESIDUAL_TERMINAL_BOUND_MS = 5 * 60 * 1_000;

/**
 * Vision unload final timeout (Plan v3 T3-Vision V1 §C-1 SSOT triple).
 *
 * `embedding-backfill` recovery loop の最終タイムアウト (10min)。この閾値を
 * 超えると row を terminal `failed` に escalate して recovery loop を
 * 停止する (axis C 10min final timeout)。
 *
 * Final timeout for the `embedding-backfill` recovery loop (10min). Beyond
 * this bound, the row is escalated to terminal `failed` and the recovery
 * loop stops for this row (axis C final timeout).
 *
 * Exported as `VISION_UNLOAD_FINAL_TIMEOUT_MS` (FIND-WAVE4-TDA-V2-H-01
 * export contract).
 *
 * @see Plan v3 T3-Vision V1 §C-1 SSOT triple
 */
export const VISION_UNLOAD_FINAL_TIMEOUT_MS = 10 * 60 * 1_000;

// ============================================================================
// Types
// ============================================================================

/**
 * Vision unload handshake result (ADR-0011 Amendment 2 §A2.2.3).
 *
 *   - `vision_unloaded`: Vision residual なし (secondary spawn を許可)。
 *   - `vision_residual`: `models[].size_vram > 0` 検出 → defer (fail-closed)。
 *   - `probe_failed`: probe error (timeout / network / parse) → defer
 *     (fail-closed, RSS budget 保護)。
 */
export type VisionPreconditionResult =
  | { status: "vision_unloaded"; sizeVramBytes: 0 }
  | { status: "vision_residual"; sizeVramBytes: number; modelName: string; deferred: true }
  | { status: "probe_failed"; error: string; failClosed: true };

/** Ollama `/api/ps` response shape (subset used by this module). */
interface OllamaPsResponseShape {
  models?: Array<{ name?: string; size_vram?: number }> | null;
}

/**
 * Optional injection hooks (test-only). Production callers use the defaults.
 *
 * テスト注入用フック。production caller は defaults を使う。
 */
export interface VisionUnloadHandshakeDeps {
  /**
   * `fetch` override for Ollama `/api/ps` request. Tests can supply a stub
   * returning a controlled `OllamaPsResponseShape`.
   */
  fetchFn?: typeof fetch;
  /**
   * `audit emit` override (defaults to `emitSupervisorAuditLog`).
   * Tests can supply a spy to assert emit invocations.
   */
  auditEmit?: typeof emitSupervisorAuditLog;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Verify Ollama Vision unload precondition before spawning the secondary
 * `embedding-backfill` worker (ADR-0011 Amendment 2 §A2.2.3).
 *
 * Behavior:
 *   1. Probe Ollama `/api/ps` with 3s timeout (SSRF-safe via
 *      `validateOllamaLocalhostUrl()`).
 *   2. Scan `models[]` for entries where `name.startsWith("llama3.2-vision")`
 *      AND `size_vram > 0` (Apple Silicon Metal `Unified Memory` も
 *      `size_vram > 0` で報告される — Amendment 1 §C 不変)。
 *   3. (a) Vision unloaded (no entry / `size_vram === 0`) → return
 *          `{ status: "vision_unloaded" }` (proceed).
 *      (b) Vision loaded → emit `vision_residual_detected` +
 *          `backfill_secondary_deferred` audit_logs (paired emit), return
 *          `{ status: "vision_residual", deferred: true }` (defer).
 *   4. probe failure (timeout / network / parse) → emit
 *      `vision_probe_failed` + `backfill_secondary_deferred` audit_logs
 *      (paired emit), return `{ status: "probe_failed", failClosed: true }`
 *      (defer for RSS budget protection per GDPR Art.32(1)(b)).
 *
 * @param deps - Optional test injection hooks (production: defaults).
 * @returns Discriminated `VisionPreconditionResult` describing the outcome.
 */
export async function verifyVisionUnloadPrecondition(
  deps?: VisionUnloadHandshakeDeps
): Promise<VisionPreconditionResult> {
  const fetchFn = deps?.fetchFn ?? fetch;
  const auditEmit = deps?.auditEmit ?? emitSupervisorAuditLog;
  const ollamaUrl = validateOllamaLocalhostUrl(process.env.OLLAMA_HOST ?? OLLAMA_DEFAULT_URL);

  // ADR-0011 Amendment 2 §A2.2.3 step 1: probe /api/ps with 3s timeout.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VISION_PROBE_TIMEOUT_MS);
  let response: Response;
  try {
    try {
      response = await fetchFn(`${ollamaUrl}/api/ps`, {
        method: "GET",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      return reportProbeFailure(auditEmit, `Ollama /api/ps returned HTTP ${response.status}`);
    }
  } catch (err) {
    return reportProbeFailure(auditEmit, sanitizeErrorMessage(err));
  }

  // ADR-0011 Amendment 2 §A2.2.3 step 2: parse + locate Vision residual.
  let data: OllamaPsResponseShape;
  try {
    data = (await response.json()) as OllamaPsResponseShape;
  } catch (err) {
    return reportProbeFailure(auditEmit, sanitizeErrorMessage(err));
  }

  const models = Array.isArray(data.models) ? data.models : [];
  const visionResidual = models.find((m) => {
    const name = typeof m?.name === "string" ? m.name : "";
    const sizeVram = typeof m?.size_vram === "number" ? m.size_vram : 0;
    return name.startsWith(VISION_MODEL_NAME_PREFIX) && sizeVram > 0;
  });

  // ADR-0011 Amendment 2 §A2.2.3 step 3a: Vision unloaded → proceed.
  if (!visionResidual) {
    return { status: "vision_unloaded", sizeVramBytes: 0 };
  }

  // ADR-0011 Amendment 2 §A2.2.3 step 3b: Vision residual → fail-closed defer.
  const sizeVramBytes = typeof visionResidual.size_vram === "number" ? visionResidual.size_vram : 0;
  const modelName = typeof visionResidual.name === "string" ? visionResidual.name : "unknown";

  // Paired emit: residual diagnostic + spawn defer rationale.
  // SSOT action constants imported from `../../audit/audit-actions` (PR-D-9).
  // `result: "failure"` per `emitSupervisorAuditLog` enum (success/failure/denied);
  // `failure` represents "precondition unmet" (Vision residual blocks spawn).
  // `denied` represents "spawn explicitly refused due to precondition".
  auditEmit(
    AUDIT_ACTION_VISION_RESIDUAL_DETECTED,
    "embedding-backfill",
    { sizeVramBytes, modelName },
    "failure"
  );
  auditEmit(
    AUDIT_ACTION_BACKFILL_SECONDARY_DEFERRED,
    "embedding-backfill",
    { reason: "vision_residual", sizeVramBytes },
    "denied"
  );
  logger.warn("[VisionUnloadHandshake] Vision residual detected — secondary spawn deferred", {
    sizeVramBytes,
    modelName,
  });
  return { status: "vision_residual", sizeVramBytes, modelName, deferred: true };
}

// ============================================================================
// Private helpers
// ============================================================================

/**
 * Emit paired `vision_probe_failed` + `backfill_secondary_deferred` audit
 * entries and return the discriminated `probe_failed` outcome.
 * `result: "failure"` for both entries per `emitSupervisorAuditLog` enum
 * (probe failure is fail-closed defer per GDPR Art.32(1)(b)).
 */
function reportProbeFailure(
  auditEmit: typeof emitSupervisorAuditLog,
  errorMessage: string
): VisionPreconditionResult {
  auditEmit(
    AUDIT_ACTION_VISION_PROBE_FAILED,
    "embedding-backfill",
    { error: errorMessage },
    "failure"
  );
  auditEmit(
    AUDIT_ACTION_BACKFILL_SECONDARY_DEFERRED,
    "embedding-backfill",
    { reason: "probe_failed", error: errorMessage },
    "failure"
  );
  logger.warn("[VisionUnloadHandshake] probe_failed — secondary spawn deferred (fail-closed)", {
    error: errorMessage,
  });
  return { status: "probe_failed", error: errorMessage, failClosed: true };
}
