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
 * `embedding_section_visual_pii_excluded` — ADR-0018 Amendment (PR-C4,
 * section_visual PII asymmetry closure). Emitted by the SSOT helper
 * `emitSectionVisualPiiExcludedMarkersForPage` (hoisted out of the pending gate,
 * called on BOTH the work-loop and backfill paths) when one or more sections are
 * intentionally excluded from DINOv2 visual embedding because they contain a
 * `component_parts.pii_risk_level='high'` part (GDPR Art.5(1)(c)
 * data-minimisation). Because the helper DB-self-discovers the high-PII *pending*
 * sections of the page independently of whether any non-PII sections are being
 * processed, the action FIRES even when the high-PII sections are the *sole*
 * pending of the page (the all-high-PII case) — closing the V2 CONDITIONAL
 * "dead marker" (TPA-RV2-01). On the backfill path it fires only when
 * `ctx.prisma` is present; when absent, the marker is deferred to a later run but
 * Path A's PII NOT EXISTS predicate alone still excludes the rows from pending so
 * the page reaches `completed` (TPA targeted +L1, RISKS R2). Surfaces the
 * intentional non-generation as a GDPR Art.30 processing trail (paired with the
 * per-row `section_visual_pii_excluded` `vision_skip_reason` marker, which Path A's
 * PII NOT EXISTS predicate also excludes from pending).
 *
 * `details` schema (PII-free, numeric/enum only — NO raw error messages, NO
 * URLs, NO user identifiers; `targetId` is `truncateAuditTargetId`-truncated
 * internally by `AuditLogService.log()`):
 *   - `skipReason` (enum): always `"section_visual_pii_excluded"`
 *   - `excludedSectionCount` (number): number of high-PII sections marked
 *
 * 365d retention 契約継承 (GDPR Art.30) + `truncateAuditTargetId` SSOT PII
 * minimisation 適用 (SEC-RV1-03 / U1)。actor は
 * {@link AUDIT_ACTOR_PAGE_ANALYZE_WORKER} (work-side fork-child path)。
 *
 * Emitted by the Phase 5 work-side filter site for the GDPR Art.30 trail of
 * intentional high-PII section visual non-generation (data-minimisation). PII-
 * free details; `targetId` truncated via the SSOT helper.
 *
 * @see ADR-0018 Amendment (PR-C4) §Decision 2
 * @see `.claude/rules/security.md` §"Canonical CWE-209 PII Protection Pattern"
 */
export const AUDIT_ACTION_EMBEDDING_SECTION_VISUAL_PII_EXCLUDED =
  "embedding_section_visual_pii_excluded" as const;

/**
 * `backfill_reconcile_in_progress_failed` — ADR-0018 Amendment 7 §7.9 (Plan v2
 * PR-B). Emitted by `reconcileStaleBackfillJobs` (`reconcileInProgressRows`)
 * when a stale `in_progress` page is pinned to `failed` because residual
 * backfill targets remain after the staleness threshold elapses. Surfaces the
 * reconciliation cron's terminal `in_progress → failed` transition for GDPR
 * Art.30 audit trail (the existing skipped_* TTL/retry-cap path already emits
 * `skip_recovery_expired` / `skip_recovery_capped`; this closes the
 * `in_progress`-origin gap that previously had no audit emit).
 *
 * `details` schema (PII-free, numeric/enum only — NO raw error messages, NO
 * URLs, NO user identifiers; `targetId` is `truncateAuditTargetId`-truncated):
 *   - `remainingStatus` (string): the `computeRemainingStatusWithPrisma`
 *     finalStatus that triggered the pin (`"in_progress"`)
 *   - `stalenessMs` (number): elapsed time since `embeddingBackfillStartedAt`
 *
 * 365d retention 契約継承 (GDPR Art.30) + `truncateAuditTargetId` SSOT PII
 * minimisation 適用。
 *
 * @see ADR-0018 Amendment 7 §7.9 (reconciliation in_progress→failed audit emit)
 * @see `.claude/rules/security.md` §"Worker actor naming SSOT"
 */
export const AUDIT_ACTION_BACKFILL_RECONCILE_IN_PROGRESS_FAILED =
  "backfill_reconcile_in_progress_failed" as const;

/**
 * `backfill_rescue_queued` — ADR-0007 Amendment 2 §A2.1 / Plan v1 §2 判断7
 * remedy (a). Emitted by `reconcileQueuedRows` (Section C, the worker-present
 * `queued`-stuck rescue scan) when a `queued`-stuck page whose BullMQ job was
 * lost (worker interruption / Redis flush / job-retention expiry) is re-armed
 * (`queued`→`queued`, `startedAt=now()`, `retryCount`+1) and all 7 backfill
 * categories are re-enqueued toward `completed`. Surfaces the rescue (P2)
 * transition for the GDPR Art.30 audit trail; this is a distinct RoPA entry
 * from the give-up (P3) path (`backfill_rescue_queued_gave_up`).
 *
 * The rescue is a recovery from a stuck-`queued` incident, hence
 * `result: "failure"` (FIND-PLAN-L-02 observability note: the row is being
 * recovered, not failing now).
 *
 * `details` schema (PII-free, numeric/enum only — NO raw error messages, NO
 * URLs, NO user identifiers; `targetId` is `truncateAuditTargetId`-truncated):
 *   - `retryCountAfter`    (number): `embeddingBackfillRetryCount` after +1
 *   - `stalenessMs`        (number): elapsed since `embeddingBackfillStartedAt`
 *   - `enqueuedCategories` (number): categories successfully re-enqueued
 *
 * 365d retention 契約継承 (GDPR Art.30) + `truncateAuditTargetId` SSOT PII
 * minimisation 適用。**INV-AUDIT-EMIT-SSOT-IMPORT-001 対象** — production code は
 * 本 SSOT 定数を import すること (bare literal hardcode 禁止)。
 *
 * @see ADR-0007 Amendment 2 §A2.1 (queued rescue lifecycle transitions)
 * @see  §2 判断7 / §7
 * @see CONTRIBUTING.md §"Worker actor naming SSOT"
 */
export const AUDIT_ACTION_BACKFILL_RESCUE_QUEUED = "backfill_rescue_queued" as const;

/**
 * `backfill_rescue_queued_gave_up` — ADR-0007 Amendment 2 §A2.1 / §A2.5 / Plan
 * v1 §2 判断7 remedy (a). Emitted by `reconcileQueuedRows` (Section C) when a
 * `queued`-stuck page has exhausted the shared retry budget
 * (`embeddingBackfillRetryCount >= SKIP_RECOVERY_RETRY_CAP` = 5) and is given up
 * via CAS `queued`→`failed_with_known_reason` (reason `supervisor_restart_orphan`)
 * so the recovery cron drives the final terminal `failed` (poison-page guard).
 *
 * Distinct from `AUDIT_ACTION_BACKFILL_RECONCILE_IN_PROGRESS_FAILED` whose JSDoc
 * explicitly closes the **`in_progress`-origin** gap. This action's name itself
 * fixes the origin (`queued`-origin give-up) so the GDPR Art.30 RoPA entry is
 * unambiguous (remedy (a): clean RoPA separation, IO preference over reusing the
 * `in_progress`-origin action with a `details.originStatus` discriminator).
 *
 * `details` schema (PII-free, numeric/enum only — NO raw error messages, NO
 * URLs, NO user identifiers; `targetId` is `truncateAuditTargetId`-truncated):
 *   - `failureReason`   (string): always `"supervisor_restart_orphan"` (enum)
 *   - `originStatus`    (string): always `"queued"` (origin disambiguation)
 *   - `retryCountAtCap` (number): `embeddingBackfillRetryCount` at give-up (≥ 5)
 *
 * 365d retention 契約継承 (GDPR Art.30) + `truncateAuditTargetId` SSOT PII
 * minimisation 適用。**INV-AUDIT-EMIT-SSOT-IMPORT-001 対象** — production code は
 * 本 SSOT 定数を import すること (bare literal hardcode 禁止)。
 *
 * @see ADR-0007 Amendment 2 §A2.1 / §A2.5 (queued give-up action separation)
 * @see  §2 判断7 / §7
 * @see CONTRIBUTING.md §"Worker actor naming SSOT"
 */
export const AUDIT_ACTION_BACKFILL_RESCUE_QUEUED_GAVE_UP =
  "backfill_rescue_queued_gave_up" as const;

/**
 * `system:backfill-reconciliation-cron` — Canonical `audit_logs.actor` literal
 * for the backfill reconciliation cron emit family (ADR-0018 Amendment 7 §7.9).
 *
 * SSOT-bound `system:` prefixed actor per the Worker actor naming SSOT
 * convention (`.claude/rules/security.md`). The pre-existing
 * `expireSkippedRowOverTTL` / `pinSkippedRowOverRetryCap` emit a bare
 * `"backfill-reconciliation-cron"` actor (legacy, no `system:` prefix);
 * the §7.9 in_progress→failed emit uses this SSOT-bound form. Template-literal
 * construction is forbidden (CWE-209 / GDPR Art.30 consistency).
 *
 * @see ADR-0035 §Decision 4 (actor SSOT)
 * @see `.claude/rules/security.md` §"Worker actor naming SSOT"
 */
export const AUDIT_ACTOR_BACKFILL_RECONCILIATION_CRON =
  "system:backfill-reconciliation-cron" as const;

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

/**
 * `vision_probe_unavailable` — deferred secondary-spawn retry loop の Ollama
 * `/api/ps` probe が `SECONDARY_SPAWN_RETRY_PROBE_FAILED_STRIKE_LIMIT`
 * (3-strike) 連続失敗に達し、retry を block (停止) した際に emit する固定
 * action 名 (ADR-0011 Amendment 7 §A7.6 3-strike block)。
 *
 * `vision_probe_failed` (単発 probe 失敗) とは異なり、本 action は
 * **連続失敗の閾値到達による retry 停止** を表す terminal observability marker。
 * Probe が連続して判定不能 (timeout / network / parse) のため secondary
 * `embedding-backfill` spawn を無限 retry せず構造的に打ち切る。
 *
 * Emitted (fail-loud, terminal) when the deferred secondary-spawn retry loop's
 * Ollama `/api/ps` probe reaches the 3-strike consecutive-failure limit
 * (`SECONDARY_SPAWN_RETRY_PROBE_FAILED_STRIKE_LIMIT`) and the retry is blocked
 * (stopped). Unlike `vision_probe_failed` (a single probe failure), this marks
 * the terminal stop of the retry loop because the probe is persistently
 * undecidable — preventing an unbounded retry.
 *
 * `details` schema (PII-free numeric/enum only — NO raw error messages, NO
 * URLs, NO user identifiers; `targetId` is `truncateAuditTargetId`-truncated):
 *   - `attemptCount`      (number): bounded retry attempts consumed (≤ 20)
 *   - `probeFailedStreak` (number): consecutive probe-failure streak (= 3 at emit)
 *
 * **INV-AUDIT-EMIT-SSOT-IMPORT-001 対象** — production code は本 SSOT 定数を
 * import すること (bare literal hardcode 禁止)。
 *
 * @see ADR-0011 Amendment 7 §A7.6 (3-strike probe-failed block)
 * @see  §3.5
 * @see CONTRIBUTING.md §"Worker actor naming SSOT"
 */
export const AUDIT_ACTION_VISION_PROBE_UNAVAILABLE = "vision_probe_unavailable" as const;

/**
 * `backfill_secondary_spawn_timeout` — secondary `embedding-backfill` worker の
 * deferred-spawn bounded retry が `SECONDARY_SPAWN_RETRY_TIMEOUT_MS`
 * (= `VISION_UNLOAD_FINAL_TIMEOUT_MS` 10min) に達し、かつ worker が依然不在
 * (spawn 失敗が継続) のときに emit する固定 action 名
 * (ADR-0011 Amendment 7 §A7.4/§A7.7、Plan v2 §3.5/§4.5)。
 *
 * fail-loud observability + fallback-on-absence scan-based terminal の paired
 * marker。worker-spawn-level retry が webPageId を持たないため、emit 後に
 * `web_pages` を scan して stranded overflow row (`embeddingBackfillStatus IN
 * ('queued','in_progress') AND embeddingBackfillStartedAt < now - 10min`) を
 * terminal (`failed`, reason `vision_unload_timeout`) に CAS-guard `updateMany`
 * する (§A7.4.1)。silent stall (page が completed/failed 未到達) を構造的に排除。
 *
 * Emitted when the secondary `embedding-backfill` worker's deferred-spawn
 * bounded retry reaches `SECONDARY_SPAWN_RETRY_TIMEOUT_MS` (= 10min) while the
 * worker is still absent. Paired with a fallback-on-absence scan-based
 * `updateMany` that CAS-guard-transitions all stranded overflow rows to
 * terminal (`failed`, reusing `vision_unload_timeout`), structurally
 * eliminating the silent-stall window where a page never reaches
 * completed/failed.
 *
 * `details` schema (PII-free numeric/enum only, `sanitizeErrorMessage` applied
 * to any error-derived value, GDPR Art.30 365d retention inherited):
 *   - `attemptCount`     (number): bounded retry attempts consumed (≤ 20)
 *   - `elapsedMs`        (number): ms since the secondary spawn was deferred
 *   - `finalProbeStatus` (`"vision_residual" | "probe_failed"`): last probe outcome
 *   - `terminalizedCount`(number): rows terminalized by the fallback scan
 *
 * actor = `AUDIT_ACTOR_WORKER_SUPERVISOR` (`system:worker-supervisor`),
 * targetType = `web_page`, targetId = `truncateAuditTargetId(webPageId)` or
 * `null` (scan terminalizes multiple rows; not always bound to one webPageId).
 *
 * **INV-SCHEMA-ENUM-004 対象外** — `audit_logs.action` は VarChar(100) で Prisma
 * enum でない (Plan v2 Open Q#2)。**INV-AUDIT-EMIT-SSOT-IMPORT-001 対象** —
 * production code は本 SSOT 定数を import すること (bare literal hardcode 禁止)。
 *
 * @see ADR-0011 Amendment 7 §A7.4 (fallback-on-absence scan) / §A7.7 (audit SSOT)
 * @see  §3.5 / §4.5
 */
export const AUDIT_ACTION_BACKFILL_SECONDARY_SPAWN_TIMEOUT =
  "backfill_secondary_spawn_timeout" as const;

/**
 * `parent_rss_ceiling_scaled` — Phase 5 init で親プロセス RSS ceiling が
 * 7168 MB → 8192 MB に segment 化された際に emit する固定 action 名
 * (PR-V3-T1a §3.4.2 / Plan v3 V2 §3.1 T1.3, FIND-V3-IO-M-07 closure target)。
 *
 * `details` schema (LCC F-M-07 cluster sign-off 対象、GDPR Art.30 retention
 * 365d 継承):
 *   - `before_mb`  (number): scale 前 ceiling (7168)
 *   - `after_mb`   (number): scale 後 ceiling (8192)
 *   - `trigger`    (string): scaling トリガー (`"plan_v3_t1a_landing"` 固定)
 *   - `commit_sha` (string): T1a PR commit SHA (ENV `T1A_COMMIT_SHA` 未設定時は
 *                            `"unknown"` を emit、PII free 数値/固定文字列のみ)
 *
 * Per Phase 5 init で **冪等に 1 回 emit** される (init 時の RSS ceiling が
 * default 7168 から外れている場合のみ — operator override で明示的に 7168 を
 * 維持する deployment は emit しない、これは scaling event ではなく override で
 * あるため)。INV-SCHEMA-ENUM-004 の SSOT BOTH ruling 4-layer alignment 対象
 * (Prisma → TS → Zod → OpenAPI/MCP `audit.query` request 検証)。
 *
 * Emitted by Phase 5 init when the parent-process RSS ceiling is scaled
 * 7168 → 8192 MB (PR-V3-T1a §3.4.2 / Plan v3 V2 §3.1 T1.3, FIND-V3-IO-M-07
 * closure). `details` carries `{before_mb, after_mb, trigger,
 * commit_sha}` (numeric/fixed-string only, PII-free, GDPR Art.30 365d
 * retention inherited). Idempotent per-init emission. Subject to LCC
 * F-M-07 cluster sign-off and INV-SCHEMA-ENUM-004 4-layer SSOT BOTH ruling.
 *
 * @see  §3.4.2
 * @see ADR-0013 Amendment 1 (parent ceiling 7168 → 8192 MB)
 * @see PR-V3-T1a §3.5 (LCC originator authority preserved)
 */
export const AUDIT_ACTION_PARENT_RSS_CEILING_SCALED = "parent_rss_ceiling_scaled" as const;

/**
 * `worker_restart_during_inflight_phase` — `WorkerSupervisorFailurePathService`
 * が in-flight ジョブ実行中の Worker 計画的再起動を検出し audit 記録する際に
 * emit する固定 action 名 (T4 Phase 2 Pre-Return Pause failure-race contract、
 * TPA M-01 SSOT consolidation)。
 *
 * Emitted by `WorkerSupervisorFailurePathService` when a planned Worker restart
 * occurs while a job is still in-flight (failure-race surface introduced by
 * T4 Phase 2 Pre-Return Pause contract). Captures the inflight phase identifier
 * for post-mortem reconciliation with the embedding-backfill orphan recovery
 * path.
 *
 * @see ADR-0018 §Decision 1 Supplement S4/S5
 * @see Plan v3 T4 Phase 2 (Pre-Return Pause failure-race)
 * @see TPA Z-b audit M-01 (SSOT consolidation)
 */
export const AUDIT_ACTION_WORKER_RESTART_DURING_INFLIGHT_PHASE =
  "worker_restart_during_inflight_phase" as const;

/**
 * `worker_orphan_backfill_skipped_due_to_live_lock` — startup orphan recovery が
 * `WorkerActiveLockService` の live lock を検出し backfill 再投入を skip した際に
 * emit する固定 action 名 (T4 Phase 2 dual-run prevention、TPA M-01 SSOT
 * consolidation)。
 *
 * Emitted by `worker-supervisor-helpers.emitOrphanBackfillSkippedAudit()` when
 * the supervisor's startup orphan-backfill recovery path observes an existing
 * live `reftrix:worker:active:embedding-backfill` Redis lock and consequently
 * skips re-enqueuing — fail-closed dual-run prevention per ADR-0011.
 *
 * @see ADR-0011 (Worker dual-run lock)
 * @see ADR-0018 §Decision 1 Supplement S4/S5
 * @see TPA Z-b audit M-01 (SSOT consolidation)
 */
export const AUDIT_ACTION_WORKER_ORPHAN_BACKFILL_SKIPPED_DUE_TO_LIVE_LOCK =
  "worker_orphan_backfill_skipped_due_to_live_lock" as const;

/**
 * `worker_orphan_backfill_redis_degraded` — startup orphan recovery が Redis
 * 接続不能 / probe 失敗 の degraded state を検出した際に emit する固定 action 名
 * (T4 Phase 2 fail-open observability、TPA M-01 SSOT consolidation)。
 *
 * Emitted by `WorkerSupervisorFailurePathService` when the orphan-backfill
 * recovery path cannot reach Redis to probe the active-worker lock. Marks the
 * recovery decision as fail-open (proceed without lock guarantee) versus
 * fail-closed (skip on confirmed live lock). Provides observability blind-spot
 * coverage for primary emit failure modes.
 *
 * @see ADR-0011 (fail-open vs fail-closed discriminated union)
 * @see ADR-0018 §Decision 1 Supplement S4/S5
 * @see TPA Z-b audit M-01 (SSOT consolidation)
 */
export const AUDIT_ACTION_WORKER_ORPHAN_BACKFILL_REDIS_DEGRADED =
  "worker_orphan_backfill_redis_degraded" as const;

// ============================================================================
// Worker crash report + cleanup actions (ADR-0021)
// ============================================================================

/**
 * `worker_crash_report_emitted` — `CrashReportWatcher` が worker fatal exit
 * (SIGABRT / SIGSEGV / uncaughtException / unhandledRejection) 検出時に
 * crash dump を sanitize して emit する固定 action 名 (ADR-0021 §"Self-Healing
 * Audit Trail")。
 *
 * Emitted by `CrashReportWatcher` when a worker fatal exit is detected and
 * the crash dump is sanitized + persisted. Drives the Self-Healing Audit
 * Trail (GDPR Art.30 + CWE-778 compliance) without leaking PII (CWE-209
 * via `crash-report-sanitizer`).
 *
 * @see ADR-0021 §"Storage Strategy" + §"Self-Healing Audit Trail"
 */
export const AUDIT_ACTION_WORKER_CRASH_REPORT_EMITTED = "worker_crash_report_emitted" as const;

/**
 * `worker_crash_report_orphaned` — `CrashDumpCleanupCron` が cleanup 経路で
 * "orphaned" crash dump (worker child は exit 済みなのに watcher が emit
 * していない遺残 dump) を検出した際に emit する固定 action 名 (ADR-0021
 * §"Orphan Recovery")。
 *
 * @see ADR-0021 §"Orphan Recovery"
 * @see DATA_RETENTION.md §11.11 (7d TTL rationale)
 */
export const AUDIT_ACTION_WORKER_CRASH_REPORT_ORPHANED = "worker_crash_report_orphaned" as const;

/**
 * `worker_crash_dump_cleanup` — `CrashDumpCleanupCron` が 7d TTL に基づき
 * crash dump を物理削除した際に emit する固定 action 名 (ADR-0021 §"TTL
 * Cleanup")。
 *
 * @see ADR-0021 §"TTL Cleanup"
 * @see DATA_RETENTION.md §11.11
 */
export const AUDIT_ACTION_WORKER_CRASH_DUMP_CLEANUP = "worker_crash_dump_cleanup" as const;

// ============================================================================
// Embedding backfill recovery actions (Plan v3 T3-Backfill V1 §3.1 axis C)
// ============================================================================

/**
 * `embedding_backfill_recovery_attempt` — `BackfillRecoveryReconciliationService`
 * が `failed_with_known_reason` row に対し recovery handler を起動した際に
 * emit する固定 action 名 (Plan v3 T3-Backfill V1 §3.1 axis C)。
 *
 * @see Plan v3 T3-Backfill V1 §3.1 axis C
 * @see ADR-0030 §Dependency Upgrade Gate
 */
export const AUDIT_ACTION_EMBEDDING_BACKFILL_RECOVERY_ATTEMPT =
  "embedding_backfill_recovery_attempt" as const;

/**
 * `embedding_backfill_recovery_resolved` — recovery handler が row を
 * `queued` に re-enqueue した際 (outcome `re_enqueued`) に emit する固定
 * action 名 (Plan v3 T3-Backfill V1 §3.1 axis C)。
 *
 * @see Plan v3 T3-Backfill V1 §3.1 axis C
 */
export const AUDIT_ACTION_EMBEDDING_BACKFILL_RECOVERY_RESOLVED =
  "embedding_backfill_recovery_resolved" as const;

/**
 * `embedding_backfill_terminal_known_reason` — recovery loop が row を
 * terminal `failed` に escalate した際 (10min final timeout / 5 retry cap
 * 到達 / `terminal_unrecoverable` reason) に emit する固定 action 名
 * (Plan v3 T3-Backfill V1 §3.1 axis C, ADR-0030)。
 *
 * @see Plan v3 T3-Backfill V1 §3.1 axis C
 * @see ADR-0030 §Dependency Upgrade Gate
 */
export const AUDIT_ACTION_EMBEDDING_BACKFILL_TERMINAL_KNOWN_REASON =
  "embedding_backfill_terminal_known_reason" as const;

// ============================================================================
// Worker bounded-dispose action (Plan v4.3 PR-M-A, ADR-0035 §Decision 1)
// ============================================================================

/**
 * `embedding_dispose_timeout` — `registerCompletedListenerAndExit` helper の
 * bounded dispose microtask race において `disposeFn` が reject (error) した
 * 際に emit する固定 action 名 (Plan v4.3 PR-M-A、ADR-0035 §Decision 1
 * canonical listener body pattern)。
 *
 * Emitted by the shared `registerCompletedListenerAndExit` helper when the
 * optional `disposeFn` (e.g. ONNX session disposeEmbeddingPipeline) rejects
 * during the bounded dispose microtask race. Indicates that the worker exit
 * proceeded without a clean dispose; downstream observability MUST treat the
 * worker as restart-due (BullMQ planned restart proceeds regardless). The
 * `details` payload carries `{reason: "dispose_error", workerType,
 * ceilingMs, message}` (message is `sanitizeErrorMessage`-cleaned; CWE-209
 * PII protection inherited via `truncateAuditTargetId` SSOT for targetId).
 * GDPR Art.30 365d retention inherited.
 *
 * Plan v4.3 PR-M-A refinement Item 2 (closure): ceiling-elapsed branch
 * also emits this action with `details.reason: "ceiling_elapsed"`,
 * semantically distinct from `dispose_error` via the `details.reason`
 * field. A race-winner flag (`disposeSettled` in the helper) prevents
 * double-emit when dispose settles concurrently with ceiling fire
 * (late-runner setTimeout becomes a no-op). Both paths share the same
 * `result: "failure"` AuditLogService enum value; downstream consumers
 * MUST inspect `details.reason` to distinguish the two cases.
 *
 * @see ADR-0035 §Decision 1 (canonical listener body pattern)
 * @see Plan v4.3 PR-M-A (helper extension)
 * @see Plan v4.3 PR-M-A refinement Item 2 (ceiling-elapsed emit closure)
 * @see SEC M-NEW-1 (synchronous-only listener body contract preserved)
 */
export const AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT = "embedding_dispose_timeout" as const;

// ============================================================================
// audit_logs.actor SSOT (PR-D-5 SSOT convention, ADR-0035 §Decision 1 + §Decision 4,
// FIND-IMPL-LCC-V43-PRM-M-01 closure)
// ============================================================================

/**
 * `system:embedding-backfill-worker` — Canonical `audit_logs.actor` literal for
 * the EmbeddingBackfillWorker emit family (PR-D-5 SSOT convention; `-worker`
 * suffix mandatory).
 *
 * EmbeddingBackfillWorker が emit する `audit_logs` 行の canonical actor 値。
 * PR-D-5 SSOT convention により末尾 `-worker` suffix が必須。
 *
 * ## Why a constant (not template literal) / なぜ template literal ではなく const か
 *
 * `audit_logs.actor` を `\`system:${workerType}\`` で構築すると、
 * workerType が `"embedding-backfill"` の場合に bare `system:embedding-backfill`
 * (suffix 欠落) が emit され、PR-D-5 SSOT convention と downstream observability
 * filter (`actor LIKE 'system:%-worker'` 等) の semantic を破る。
 * FIND-IMPL-LCC-V43-PRM-M-01 (Plan v4.3 PR-M Phase 2 LCC Impl Audit anchor
 * `019e30ad-9c3f`, M severity, T+1d 2026-05-17) で identify された構造的
 * リスクを、SSOT-export 化 + AST gate で根本対策する。
 *
 * Replacing template literal construction with SSOT const eliminates the
 * suffix-omission risk by construction and aligns with the PR-D-5 SSOT
 * convention `-worker` suffix mandate.
 *
 * @see ADR-0035 §Decision 1 (canonical listener body pattern), §Decision 4
 *      (actor SSOT)
 * @see Plan v4.3 PR-M markdown §198 Decision 4
 * @see LCC Impl Audit anchor `019e30ad-9c3f`
 * @see Wave 5 LCC canonical CWE-209 PII protection pattern (anchor
 *      `019df7ab-2f5a`)
 * @see `.claude/rules/security.md` §"Canonical CWE-209 PII Protection Pattern"
 */
export const AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER = "system:embedding-backfill-worker" as const;

// ============================================================================
// Plan v4.5 PR1 NEW-U-11: Worker stderr disk pressure detection
// (TPA re-audit anchor 019e381a-d0e3-73db-a9d0-7bd56211ec7b, NEW H severity)
// ============================================================================

/**
 * `worker_stderr_disk_pressure_detected` — Plan v4.5 PR1 NEW-U-11 L3 disk
 * monitoring が `/tmp/reftrix-worker-stderr/` の available disk space を
 * `fs.statfs()` で 30s 周期 polling し、`available < 1GB` を検出した際に
 * emit する固定 action 名 (4-layer 防御 L3、Plan v4.5 V3 §P0.5.runtime)。
 *
 * Emitted by the worker stderr disk monitor (30s interval polling) when
 * `fs.statfs('/tmp/reftrix-worker-stderr/')` reports `available < 1GB`.
 * Triggers (a) this audit_logs entry, (b) `REFTRIX_WORKER_STDERR_REDIRECT_ENABLED`
 * runtime auto-failover, and (c) immediate cleanup of existing stderr files.
 * 365d retention 契約継承 (GDPR Art.30 records of processing activities) +
 * `truncateAuditTargetId` SSOT PII minimisation 適用。
 *
 * @see Plan v4.5 V3 §P0.5.runtime (NEW-U-11 4-layer 防御 L3)
 * @see ADR-0036 §D4.1 (stderr file disk full racing 4-layer 防御)
 * @see TPA re-audit anchor `019e381a-d0e3-73db-a9d0-7bd56211ec7b`
 * @see `.claude/rules/security.md` §"Worker actor naming SSOT (Plan v4.3 PR-M / ADR-0035)"
 */
export const AUDIT_ACTION_WORKER_STDERR_DISK_PRESSURE_DETECTED =
  "worker_stderr_disk_pressure_detected" as const;

/**
 * `worker_cpu_provider_override` — Plan v4.5 PR1 Track 1 H1 isolation test の
 * `--force-cpu-provider` CLI flag activation 時に emit する固定 action 名
 * (U-V45-PR1-08 closure、M severity、defense-in-depth observability)。
 *
 * Emitted by `start-workers.ts` when the operator activates the
 * `--force-cpu-provider` CLI flag (forcing `ONNX_EXECUTION_PROVIDER=cpu`
 * runtime override). The pre-existing `console.warn` route is PRESERVED;
 * this audit emit is ADDITIVE for production privilege-escalation tracking
 * (CWE-778 sufficient logging) and INV-WORKER-CLI-FLAG-LIFECYCLE-001 deadline
 * enforcement (T+10d 2026-05-28 hard CI gate).
 *
 * `details` schema (`truncateAuditTargetId` SSOT PII minimisation applied to
 * `targetId`; GDPR Art.30 365d retention inherited):
 *   - `reason` (string): trigger context (`"h1_isolation_test_cli_flag"` 固定)
 *   - `removalDeadline` (string): inline hard-deadline ISO date (`"2026-05-28"`)
 *   - `planRef` (string): originating plan revision (`"v4.5-track-1"`)
 *
 * @see Plan v4.5 V3 §2 Track 1 + §10 closure (T+10d hard CI gate)
 * @see ADR-0036 §D3.1 (H1 refuted decision tree + Track 1 lifecycle)
 * @see U-V45-PR1-08 (IO Impl Decision V0 BLOCK unblock condition)
 * @see INV-WORKER-CLI-FLAG-LIFECYCLE-001 (standing test deadline mandate)
 */
export const AUDIT_ACTION_WORKER_CPU_PROVIDER_OVERRIDE = "worker_cpu_provider_override" as const;

/**
 * `system:worker-supervisor` — Canonical `audit_logs.actor` literal for the
 * WorkerSupervisor + stderr disk monitor emit family (Plan v4.5 PR1 NEW-U-11).
 *
 * WorkerSupervisor および stderr disk monitor の emit に共有される actor 値。
 * `system:worker-config-validator` 系の SSOT pattern (Plan v4.4 PR-N CO-21)
 * と同 rigor で SSOT-bound、template literal 構築禁止。
 *
 * @see ADR-0035 §Decision 4 (actor SSOT)
 * @see `.claude/rules/security.md` §"Worker actor naming SSOT"
 */
export const AUDIT_ACTOR_WORKER_SUPERVISOR = "system:worker-supervisor" as const;

/**
 * `worker_lock_ttl_fallback` — self-chained respawn protocol Layer 3 が
 * `WorkerActiveLockService` の自己 stale lock を検出し、`releaseLock` retry +
 * `probeExistingLock` 後も lock が残存するため 60s TTL の自然失効を待つ際に
 * emit する固定 action 名 (ADR-0011 self-chained respawn Layer 3)。
 *
 * Emitted by `executeSelfChainedRespawn` when the exiting child's own stale
 * lock survives the `releaseLock` retry budget and the `probeExistingLock`
 * nonce-match confirms self-ownership, so the supervisor falls back to waiting
 * for the 60s TTL natural expiry before respawning. The raw nonce is NEVER
 * logged (SEC-V11-01 Rule 6); this audit emit is the structured sentinel.
 *
 * `details` schema (PII-free enum only — NO raw error messages, NO nonce, NO
 * URLs; `targetId` is `truncateAuditTargetId`-truncated):
 *   - `reason` (string): always `"stale_self_lock"`
 *
 * **INV-AUDIT-EMIT-SSOT-IMPORT-001 対象** — production code は本 SSOT 定数を
 * import すること (bare literal hardcode 禁止)。Co-migrated from a bare literal
 * alongside `AUDIT_ACTION_VISION_PROBE_UNAVAILABLE` (Impl Decision V0 SEC-IMPL-01).
 *
 * @see ADR-0011 (self-chained respawn protocol, Layer 3 TTL fallback)
 * @see CONTRIBUTING.md §"Worker actor naming SSOT"
 */
export const AUDIT_ACTION_WORKER_LOCK_TTL_FALLBACK = "worker_lock_ttl_fallback" as const;

/**
 * `system:page-analyze-worker` — Canonical `audit_logs.actor` literal for the
 * PageAnalyzeWorker emit family (PR-D-5 SSOT convention; `-worker` suffix
 * mandatory).
 *
 * PageAnalyzeWorker が emit する `audit_logs` 行の canonical actor 値。
 * PR-D-5 SSOT convention により末尾 `-worker` suffix が必須。
 *
 * Co-located with `AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER` for the two
 * `WorkerLifecycleType` cases (`"page-analyze" | "embedding-backfill"`) so the
 * SSOT module covers both worker actor naming conventions exhaustively.
 *
 * @see `AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER` for the rationale
 * @see ADR-0035 §Decision 1, §Decision 4
 */
export const AUDIT_ACTOR_PAGE_ANALYZE_WORKER = "system:page-analyze-worker" as const;

/**
 * `WorkerLifecycleType` is defined in `workers/shared/post-job-lifecycle.ts`.
 * We replicate the union here as a local literal type rather than importing
 * from `workers/` to avoid a cyclic import (audit/audit-actions.ts is a leaf
 * module imported by many call paths including workers/shared/*).
 *
 * `workers/shared/post-job-lifecycle.ts` の `WorkerLifecycleType` と同一 union。
 * cyclic import 回避のため audit/audit-actions.ts ではローカル定義する。
 */
type WorkerActorLifecycleType = "page-analyze" | "embedding-backfill";

/**
 * Resolve the canonical `system:<worker>-worker` actor literal for the given
 * `WorkerLifecycleType`. **Structurally eliminates** the bare-suffix risk
 * (`system:embedding-backfill` without `-worker`) that arose from prior
 * template-literal construction (`\`system:${workerType}\``).
 *
 * `WorkerLifecycleType` に対して canonical `system:<worker>-worker` actor
 * literal を返す。Template literal 由来の bare-suffix risk (例: `system:embedding-backfill`)
 * を構造的に排除する (FIND-IMPL-LCC-V43-PRM-M-01 closure)。
 *
 * Exhaustive `switch` ensures the union is fully covered; adding a new
 * `WorkerLifecycleType` member without updating this helper triggers a
 * TypeScript compile error (`never`-narrowing on default branch).
 *
 * @param workerType BullMQ worker lifecycle type
 * @returns Canonical `system:<worker>-worker` actor literal (SSOT-bound)
 *
 * @see `AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER`
 * @see `AUDIT_ACTOR_PAGE_ANALYZE_WORKER`
 * @see ADR-0035 §Decision 1 (canonical listener body pattern)
 * @see FIND-IMPL-LCC-V43-PRM-M-01 (Plan v4.3 PR-M Phase 2 LCC Impl Audit)
 */
export function getWorkerActorName(
  workerType: WorkerActorLifecycleType
): typeof AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER | typeof AUDIT_ACTOR_PAGE_ANALYZE_WORKER {
  switch (workerType) {
    case "embedding-backfill":
      return AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER;
    case "page-analyze":
      return AUDIT_ACTOR_PAGE_ANALYZE_WORKER;
    default: {
      // Exhaustive-check via `never`: TypeScript compile error if a new
      // WorkerLifecycleType member is added without extending this switch.
      const _exhaustive: never = workerType;
      throw new Error(
        `[audit-actions] getWorkerActorName: unhandled workerType: ${String(_exhaustive)}`
      );
    }
  }
}

// ============================================================================
// Plan v4.5 PR3 Track 2: Per-job fork-only model migration SSOT actions
// (U-2 / U-3 / U-8-a / U-8-b / LCC-03 / LCC-V1-01 closure, ADR-0037 governance)
// ============================================================================

/**
 * `worker_config_legacy_env_var_detected` — Plan v4.5 PR3 Track 2 が新 flag
 * `EMBEDDING_BACKFILL_FORK_ONLY_MODE_ENABLED` と legacy flag
 * `EMBEDDING_BACKFILL_FORK_ENABLED` を同時 set した legacy deployment を検出
 * した際に emit する固定 action 名 (INV-WORKER-CONFIG-LEGACY-ENV-VAR-DETECTION-001
 * §5.3 contract)。
 *
 * Emitted on first job dispatch when the legacy `EMBEDDING_BACKFILL_FORK_ENABLED`
 * env var is still set during a per-job fork-only deployment. The new flag wins
 * on value conflict; this emit provides Art.30 observability of stale-config
 * deployments throughout the 1-cycle backward-compat window (T+30d 2026-06-17,
 * Plan v4.6 final removal). 365d retention + `truncateAuditTargetId` (CWE-209
 * PII protection) inherited; actor `system:worker-config-validator`.
 *
 * @see Plan v4.5 PR3 V1 §5.3 (INV-WORKER-CONFIG-LEGACY-ENV-VAR-DETECTION-001)
 * @see DATA_RETENTION.md §11.10 (365d retention contract)
 * @see Wave 5 LCC canonical CWE-209 PII protection pattern (anchor `019df7ab-2f5a`)
 */
export const AUDIT_ACTION_WORKER_CONFIG_LEGACY_ENV_VAR_DETECTED =
  "worker_config_legacy_env_var_detected" as const;

/**
 * `worker_sub_child_spawn_rate_limit_violated` — per-job sub-child spawn が
 * `acquirePerJobSubChildLock` の Redis server-side `TIME` monotonic ≥500ms
 * rate-limit boundary (SEC M-01 / CWE-770) で reject された際に emit する
 * 固定 action 名 (§4.2.1 discriminated union `rate_limited` branch)。
 *
 * Emitted (fail-closed) when two sub-child spawn attempts occur within the
 * 500ms minimum interval. The rate-limit clock is pinned via Redis
 * `redis.call('TIME')` server-side (NOT `Date.now()` / `process.hrtime`) per
 * ADR-0011 Amendment 3. 365d retention + `truncateAuditTargetId` inherited;
 * actor `getWorkerActorName("embedding-backfill")`.
 *
 * @see Plan v4.5 PR3 V1 §4.2.1 (discriminated union mapping table)
 * @see Plan v4.5 PR3 V1 §4.5 (Redis server-side monotonic time, CWE-770)
 * @see ADR-0011 Amendment 3 (Redis TIME server-side monotonic pin)
 */
export const AUDIT_ACTION_WORKER_SUB_CHILD_SPAWN_RATE_LIMIT_VIOLATED =
  "worker_sub_child_spawn_rate_limit_violated" as const;

/**
 * `worker_per_job_fork_lock_acquired` — per-job sub-child lock を
 * `acquirePerJobSubChildLock` が atomic に取得した際に emit する固定 action 名
 * (§5.1 INV-WORKER-PER-JOB-FORK-LOCK-CONTRACT-001 contract)。
 *
 * Emitted on each successful per-job lock acquire under the
 * `reftrix:worker:active:embedding-backfill:job:<jobId>` namespace. Provides the
 * cross-reference anchor for orphan-cleanup `bootEpoch` + `nonce` double-verify
 * (§4.2.2 OrphanCleanupContract) so a deleted orphan lock can be reconciled
 * against its original acquire event. 365d retention + `truncateAuditTargetId`
 * inherited; actor `getWorkerActorName("embedding-backfill")`.
 *
 * @see Plan v4.5 PR3 V1 §5.1 (INV-WORKER-PER-JOB-FORK-LOCK-CONTRACT-001)
 * @see Plan v4.5 PR3 V1 §4.2.2 (orphan cleanup contract, CWE-367)
 */
export const AUDIT_ACTION_WORKER_PER_JOB_FORK_LOCK_ACQUIRED =
  "worker_per_job_fork_lock_acquired" as const;

/**
 * `worker_per_job_fork_lock_race_lost` — per-job sub-child lock acquire が
 * `SET NX` race で別 supervisor に先取得された際に emit する固定 action 名
 * (§4.2.1 discriminated union `race_lost` branch, SEC-M-1 fail-closed)。
 *
 * Emitted (fail-closed) when the Lua `SET NX` returns nil because another
 * supervisor already holds the per-job lock. The caller MUST NOT spawn the
 * sub-child (BullMQ retry). 365d retention inherited; actor
 * `getWorkerActorName("embedding-backfill")`.
 *
 * @see Plan v4.5 PR3 V1 §4.2.1 (discriminated union mapping table)
 * @see DATA_RETENTION.md §11.10 (365d retention contract)
 */
export const AUDIT_ACTION_WORKER_PER_JOB_FORK_LOCK_RACE_LOST =
  "worker_per_job_fork_lock_race_lost" as const;

/**
 * `worker_lock_service_unreachable` — per-job sub-child lock acquire が Redis
 * 到達不能 (connection refused / timeout / network error) で失敗した際に emit
 * する固定 action 名 (§4.2.1 discriminated union `redis_unreachable` branch,
 * SEC-M-3 fail-open, PR7d-3 pattern)。
 *
 * Emitted (fail-open) when Redis is unreachable during a per-job lock acquire.
 * The caller MAY proceed without the lock (SEC-M-3 fail-open contract
 * preserved). 365d retention inherited; actor
 * `getWorkerActorName("embedding-backfill")`.
 *
 * @see Plan v4.5 PR3 V1 §4.2.1 (discriminated union mapping table)
 * @see ADR-0011 (fail-open vs fail-closed discriminated union, PR7d-3)
 */
export const AUDIT_ACTION_WORKER_LOCK_SERVICE_UNREACHABLE =
  "worker_lock_service_unreachable" as const;

/**
 * `worker_lua_script_reload` — `EVALSHA` が `NOSCRIPT` (SHA cache evicted) を
 * 返した際に SCRIPT LOAD → EVALSHA retry を実行した transparency emit の固定
 * action 名 (§4.4 Lua SHA boot-time pin NOSCRIPT-recovery)。
 *
 * Emitted (transparent / observability-only) when the Lua SHA cache is evicted
 * and a one-time re-pin (SCRIPT LOAD + EVALSHA) occurs. Persistent NOSCRIPT
 * surfaces as `worker_lock_service_unreachable`. 365d retention inherited.
 *
 * @see Plan v4.5 PR3 V1 §4.4 (Lua SCRIPT LOAD boot-time pinning, CWE-829/CWE-94)
 * @see INV-WORKER-LUA-SHA-PIN-001 §5.5
 */
export const AUDIT_ACTION_WORKER_LUA_SCRIPT_RELOAD = "worker_lua_script_reload" as const;

/**
 * `system:worker-config-validator` — Canonical `audit_logs.actor` literal for
 * the per-job fork-only env-var resolver / config validator emit family
 * (Plan v4.5 PR3 Track 2, FIND-PLAN-LCC-03 / LCC-V1-01 closure).
 *
 * Per-job fork-only config validator が emit する `audit_logs` 行の canonical
 * actor 値。`AUDIT_ACTOR_WORKER_SUPERVISOR` 系の SSOT pattern と同 rigor で
 * SSOT-bound、template literal 構築禁止 (INV-AUDIT-EMIT-SSOT-IMPORT-001 §5.4
 * AST sweep 対象)。
 *
 * @see Plan v4.5 PR3 V1 §5.3 (INV-WORKER-CONFIG-LEGACY-ENV-VAR-DETECTION-001)
 * @see `.claude/rules/security.md` §"Worker actor naming SSOT"
 */
export const AUDIT_ACTOR_WORKER_CONFIG_VALIDATOR = "system:worker-config-validator" as const;

// ============================================================================
// PR-1 GPU-COORD: Phase 5 fork-child CPU-fallback degraded-mode audit
// (ADR-0038 Decision 2, FIND-PLAN-M-03 / LCC-M-02)
// ============================================================================

/**
 * `embedding_cpu_fallback_degraded` — Phase 5 fork-child の VRAM probe
 * (ADR-0038 Decision 1) が free VRAM 不足 / contention により CUDA を選べず
 * CPU fallback (degraded mode) になった際に **parent 側** で emit する固定
 * action 名 (ADR-0038 Decision 2, FIND-PLAN-M-03)。
 *
 * Emitted (parent-side DB write, NOT via IPC — FIND-PLAN-M-01 zero new IPC types)
 * when the Phase 5 fork-child VRAM probe falls back to CPU because free VRAM is
 * below the workload threshold (`fork_child_below_threshold`), nvidia-smi /
 * the VRAM query is unavailable (`vram_contention`), or free VRAM is sufficient
 * but the CUDA EP shared library (`libonnxruntime_providers_cuda.so`) is absent
 * so CUDA cannot actually run (`cuda_ep_unavailable`, FIND-IMPL-PR1-H-NEW-01).
 * Surfaces degraded GPU-path runs so operators can see "why CPU" (directive ⑤
 * no-fake-success — a CPU fallback completion is NOT silently treated as a
 * healthy GPU run).
 *
 * The explicit operator rollback (`PHASE5_FORK_GPU_PROBE_ENABLED=false`) and the
 * healthy CUDA-selected path are NOT emitted (they are not degradations).
 *
 * `details` schema (PII-free — numeric VRAM values + reason enum ONLY; NO URLs,
 * NO user identifiers; `targetId` is `truncateAuditTargetId`-truncated per the
 * canonical CWE-209 PII protection pattern):
 *   - `reason` (string): `fork_child_below_threshold` | `vram_contention` | `cuda_ep_unavailable`
 *   - `workload` (string): `visual` | `text`
 *   - `freeVramMb` (number | null): observed free VRAM (null when probe failed)
 *   - `thresholdMb` (number): the VRAM threshold the probe compared against
 *
 * GDPR Art.30 365d retention 継承。VRAM 数値 + reason enum のみで GDPR Art.4(1)
 * personal data に該当しない (CWE-209 リスクなし)。
 *
 * @see ADR-0038 Decision 1 / Decision 2 (FIND-PLAN-M-03 / LCC-M-02)
 * @see CONTRIBUTING.md §"Canonical CWE-209 PII Protection Pattern"
 * @see INV-AUDIT-EMIT-SSOT-IMPORT-001 (SSOT import / AST sweep)
 */
export const AUDIT_ACTION_EMBEDDING_CPU_FALLBACK_DEGRADED =
  "embedding_cpu_fallback_degraded" as const;

/**
 * `system:phase5-init` — Canonical `audit_logs.actor` literal for the Phase 5
 * fork-child init / GPU-COORD probe degraded-mode emit family (ADR-0038
 * Decision 2, FIND-PLAN-M-03).
 *
 * Phase 5 init (GPU-COORD probe) が emit する `audit_logs` 行の canonical actor
 * 値。`AUDIT_ACTOR_WORKER_SUPERVISOR` 系の SSOT pattern と同 rigor で SSOT-bound、
 * template literal 構築禁止 (INV-AUDIT-EMIT-SSOT-IMPORT-001 AST sweep 対象、
 * coding-standards SSOT-derive ruling)。
 *
 * @see ADR-0038 Decision 2
 * @see CONTRIBUTING.md §"Worker actor naming SSOT"
 */
export const AUDIT_ACTOR_PHASE5_INIT = "system:phase5-init" as const;
