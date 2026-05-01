// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `audit_logs.action` SSOT 固定 string 定数 / `audit_logs.action` SSOT fixed-string constants
 *
 * Per ADR-0018 §Decision 1 Supplement S4 / S5 (line 252-308):
 *
 * 設計原則 / Design principle:
 *   `skipReason` (domain enum) と `audit_logs.action` (schema-level event name) を分離する。
 *   `skipReason` は `audit_logs.details.skipReason` field に格納し、
 *   `audit_logs.action` は **固定 string 定数** を SSOT export する。
 *
 *   Separate `skipReason` (domain-level enum) from `audit_logs.action` (schema-level
 *   event name). `skipReason` lives in `audit_logs.details.skipReason`;
 *   `audit_logs.action` MUST reference SSOT-exported **fixed string constants**.
 *
 * 命名規則 / Naming convention: `<domain>_<event>_<state>`
 *   - `embedding_part_visual_skipped` = domain (`embedding`) + event (`part_visual`) + state (`skipped`)
 *   - `embedding_backfill_autospawn_failed` = domain (`embedding`) + event (`backfill_autospawn`) + state (`failed`)
 *
 * 将来追加される `audit_logs.action` 固定 string も本 file に additive append する。
 * Future additive constants append here additively.
 *
 * @see ADR-0018 §Decision 1 Supplement (` line 187-331)
 * @see Plan v1.1 §5.1.16 (`apps/mcp-server/src/audit/audit-actions.ts` NEW)
 * @see PR-D-9 Finding Registry §4.1 (Conflict-1) / §4.2 (Conflict-2)
 *
 * @module audit/audit-actions
 */

/**
 * `embedding_part_visual_skipped` — `PartVisualProcessor` catch block
 * (skipReason `bbox_unresolvable` 等) で emit する固定 action 名。
 *
 * Emitted by `PartVisualProcessor` catch block when a Playwright bbox resolve
 * fails with no further classification (catch-all `bbox_unresolvable`).
 *
 * @see ADR-0018 §Decision 1 Supplement S5 (line 295)
 * @see ADR-0018 §Decision 1 Supplement S4 example (line 270-283)
 */
export const AUDIT_ACTION_EMBEDDING_PART_VISUAL_SKIPPED = "embedding_part_visual_skipped" as const;

/**
 * `embedding_backfill_autospawn_failed` — `ensureAllWorkersRunningStaggered()`
 * rejection path (`page.analyze` / `page.batch_analyze` 起動時の auto-spawn 失敗) で
 * emit する固定 action 名。
 *
 * Emitted by `bootstrapWorkersForPageAnalyze` when the supervisor's
 * `ensureAllWorkersRunningStaggered()` Promise rejects (silent stall 再発防止
 * per Conflict-2 joint resolution + PR-D-5 5-tier SLO L1.5 SLO_MARKER pattern).
 *
 * @see ADR-0018 §Decision 1 Supplement S5 (line 296)
 * @see PR-D-9 Finding Registry §4.2 Conflict-2 joint resolution
 * @see Plan v1.1 §5.1.17 (worker-bootstrap helper)
 */
export const AUDIT_ACTION_EMBEDDING_BACKFILL_AUTOSPAWN_FAILED =
  "embedding_backfill_autospawn_failed" as const;

/**
 * `vision_residual_detected` — `verifyVisionUnloadPrecondition()` が Ollama
 * `/api/ps` probe で `models[].size_vram > 0` (Vision residual) を検出した際に
 * emit する固定 action 名 (ADR-0011 Amendment 2 §A2.2.3 Precondition Check)。
 *
 * Emitted when `vision-unload-handshake.verifyVisionUnloadPrecondition()`
 * detects a llama3.2-vision model still loaded in VRAM (Apple Silicon Metal
 * Unified Memory inclusive). Marks the supervisor's secondary
 * `embedding-backfill` spawn as deferred to protect the 32GB tier RSS budget.
 *
 * @see ADR-0011 Amendment 2 §A2.2.3 (line 481-496)
 * @see PR-D-9 Finding Registry TPA-IMPL-01
 * @see Plan v1.1 §10 IO Impl Decision UNB-IMPL-1
 */
export const AUDIT_ACTION_VISION_RESIDUAL_DETECTED = "vision_residual_detected" as const;

/**
 * `backfill_secondary_deferred` — Vision unload precondition violation により
 * `ensureAllWorkersRunningStaggered()` が secondary `embedding-backfill` spawn を
 * defer した際に emit する固定 action 名 (ADR-0011 Amendment 2 §A2.2.4
 * Defer-then-retry contract)。
 *
 * Paired emit with `AUDIT_ACTION_VISION_RESIDUAL_DETECTED`. Indicates the
 * supervisor explicitly chose NOT to spawn the embedding-backfill secondary
 * because the precondition (Vision unloaded) was unmet — fail-closed defer
 * per GDPR Art.32(1)(b) "ongoing availability and resilience".
 *
 * @see ADR-0011 Amendment 2 §A2.2.3 / §A2.2.4
 * @see PR-D-9 Finding Registry TPA-IMPL-01
 */
export const AUDIT_ACTION_BACKFILL_SECONDARY_DEFERRED = "backfill_secondary_deferred" as const;

/**
 * `vision_probe_failed` — `verifyVisionUnloadPrecondition()` の Ollama
 * `/api/ps` probe が timeout / network / parse error で失敗した際に emit する
 * 固定 action 名 (ADR-0011 Amendment 2 §A2.2.3 fail-closed branch)。
 *
 * Vision residual を判定不能な状態で secondary spawn すると 32GB tier の RSS
 * budget 上限 (~16.5 GB) を破る可能性があるため fail-closed (defer) を採用。
 * Probe failure 時も `AUDIT_ACTION_BACKFILL_SECONDARY_DEFERRED` と paired emit
 * する。
 *
 * @see ADR-0011 Amendment 2 §A2.2.3 "Rationale for fail-closed on probe failure"
 * @see PR-D-9 Finding Registry TPA-IMPL-01
 */
export const AUDIT_ACTION_VISION_PROBE_FAILED = "vision_probe_failed" as const;
