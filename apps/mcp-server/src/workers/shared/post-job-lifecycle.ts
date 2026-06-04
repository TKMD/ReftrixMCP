// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Post-Job Lifecycle Helper — Memory-Gated Exit + Pre-Return Pause (Plan v2 §1)
 *
 * v0.4.0 PR7e-β2 hotfix: BullMQ Worker の success/failure path で使う
 * メモリ閾値ゲートを一元化する。RSS 閾値超過時のみ `process.exit(0)` し、
 * 未満時は no-op（mainLoop が自然に次ジョブを fetch）。
 *
 * Plan v2 §1 (anchor 019de97f-1dcf) S1.1: success path 限定で `Promise<never>` を
 * 返す `applyPostJobLifecycleGate` を追加。`worker.pause(true)` を success path に
 * のみ復活させ、failure path は本ヘルパーを呼ばないため `Worker.resume()` 経路は
 * 構造的に存在しない (INV-WORKER-NO-RESUME-001)。memory-only gate は
 * `applyPostJobMemoryGate` として併存維持。
 *
 * Memory threshold gate for BullMQ Worker success/failure paths. Calls
 * `process.exit(0)` only when RSS exceeds the threshold; otherwise no-op so
 * the BullMQ mainLoop fetches the next job naturally.
 *
 * Plan v2 §1 S1.1 adds `applyPostJobLifecycleGate` (success-path only,
 * `Promise<never>` return) which restores `worker.pause(true)` solely on the
 * success path. The failure path never invokes this helper, so a
 * `Worker.resume()` callsite cannot exist by construction
 * (INV-WORKER-NO-RESUME-001). The original memory-only gate
 * (`applyPostJobMemoryGate`) is retained for failure-path callers.
 *
 * Plan v4.2 PR-L closure (SEC-V42-L-NEW-4): the legacy
 * `applyPostJobLifecycleGateAlwaysExits` wrapper (formerly the Layer 1
 * type-level `Promise<never>` guarantee preservation helper) has been
 * **formally removed**. SEC-V42-L-NEW-4 audit flagged the wrapper as
 * CWE-705 (Incorrect Control Flow Scoping) primary + CWE-754 (Improper Check
 * for Unusual or Exceptional Conditions) secondary risk because (a)
 * production callers are zero, (b) test-only retention created a dead-code
 * surface in the production worker package, and (c) the `Promise<never>`
 * type-level guarantee is now structurally enforced by the AST gate
 * `scripts/verify-completed-listener-sync.mjs` (synchronous-only listener
 * body) — Layer 1 canonical role transferred from wrapper to AST gate.
 *
 * Plan v4.2 PR-L closure (SEC-V42-L-NEW-4): the legacy
 * `applyPostJobLifecycleGateAlwaysExits` wrapper was **formally removed**.
 * SEC-V42-L-NEW-4 audit identified CWE-705 primary + CWE-754 secondary risk
 * (zero production callers, test-only retention as dead-code surface). The
 * `Promise<never>` Layer 1 type-level guarantee is now structurally enforced
 * by the AST gate `scripts/verify-completed-listener-sync.mjs` instead.
 *
 * ## 設計方針 / Design
 *
 * pause/resume 経路は完全削除済み。本ヘルパーは RSS 閾値ゲートのみを担う:
 *
 *   - `enabled=false`（`WORKER_MAX_JOBS_BEFORE_RESTART=0`）: 完全 no-op
 *   - `enabled=true` + RSS 閾値超過: `process.exit(0)` → WorkerSupervisor 再起動
 *   - `enabled=true` + RSS 閾値未満: no-op — BullMQ mainLoop が自然に次ジョブ fetch
 *
 *   - `enabled=false` (`WORKER_MAX_JOBS_BEFORE_RESTART=0`): full no-op
 *   - `enabled=true` + RSS above threshold: `process.exit(0)` → Supervisor restart
 *   - `enabled=true` + RSS below threshold: no-op — mainLoop fetches next job
 *
 * `fetchNext=false` 保証は BullMQ の `moveToCompleted` Lua スクリプトで完結する
 * ため、`concurrency=1` 構成では Worker 側の pause は不要（Phase 0 IPC pause が
 * 同じ理由で削除されたのと同等の判断）。したがって本ヘルパーは `concurrency`
 * に対して中立で、`pause()` / `resume()` は一切呼び出さない。
 *
 * `fetchNext=false` is guaranteed by BullMQ's `moveToCompleted` Lua script, so
 * Worker-side pause is unnecessary with `concurrency=1` (same reasoning that
 * removed the Phase 0 IPC pause). This helper is therefore concurrency-neutral
 * and never calls `pause()` / `resume()`.
 *
 * ## 歴史的背景 / Historical context
 *
 * v0.4.0 PR7c で導入された「pause → RSS 判定 → exit or resume」方式 (旧名:
 * `applyPreReturnPauseAndMemoryGate`) は、BullMQ 5.66.5 `Worker.resume()` の
 * 設計上の race により silent no-op となり、新規ジョブ取得が恒久停止する
 * バグを引き起こした。PR7e-β2 hotfix で pause/resume を完全削除し、
 * β2 audit carryover で本関数を `applyPostJobMemoryGate` にリネームして
 * 「post-job の memory gate」という実体を関数名に反映させた。
 * 詳細は `
 * を参照。
 *
 * The v0.4.0 PR7c approach ("pause → RSS check → exit or resume", formerly
 * named `applyPreReturnPauseAndMemoryGate`) silently no-opped due to a design
 * race in BullMQ 5.66.5 `Worker.resume()`, permanently halting new-job
 * acquisition. The PR7e-β2 hotfix removed pause/resume entirely, and the β2
 * audit carryover renamed this helper to `applyPostJobMemoryGate` so the
 * name reflects what it actually does (a post-job memory gate). See
 * `
 *
 * ## セキュリティ / Security
 *
 * - **CWE-209**: 旧実装の pause()/resume() 例外ログは削除（呼び出しごと削除）。
 *   exit ログは rssMb 値のみで、内部状態は漏洩しない。
 * - **CWE-770**: RSS 閾値超過時のみ exit することで、無制限のジョブ処理による
 *   メモリ枯渇を防止する既存ガードは維持。
 *
 * - **CWE-209**: legacy pause/resume exception logs removed along with the
 *   calls. The exit log only contains `rssMb`, no internal state leaks.
 * - **CWE-770**: memory-exhaustion protection preserved — exit only when RSS
 *   exceeds threshold, preventing unbounded job processing.
 *
 * @module workers/shared/post-job-lifecycle
 */

import type { Worker } from "bullmq";

import {
  AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT,
  getWorkerActorName,
} from "../../audit/audit-actions";
import {
  AUDIT_LOG_CONSTANTS,
  getAuditLogService,
  truncateAuditTargetId,
} from "../../services/audit-log.service";
import { shouldExitForMemory } from "../../services/worker-memory-monitor.service";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";

/**
 * Worker type discriminator for `registerCompletedListenerAndExit`.
 *
 * Helper 関数が呼び出された Worker の type を識別し、log prefix と
 * jobId truncate 戦略を切り替える。
 *
 * Worker type discriminator for `registerCompletedListenerAndExit`. Selects
 * log prefix and jobId truncation strategy based on the worker type.
 */
export type WorkerLifecycleType = "page-analyze" | "embedding-backfill";

/**
 * Memory-gated exit for BullMQ Worker post-job paths.
 *
 * BullMQ Worker のジョブ完了 / 失敗時に、RSS 閾値超過時のみ `process.exit(0)` する。
 * pause/resume は BullMQ 5.66.5 の resume() race を回避するため呼び出さない。
 * したがって本ヘルパーは `concurrency` に対して中立。
 *
 * ### Decision Matrix / 判定フロー
 *
 * | `enabled` | RSS > threshold | Outcome                                |
 * | --------- | --------------- | -------------------------------------- |
 * | false     | *               | No-op                                  |
 * | true      | true            | `process.exit(0)` → Supervisor restart |
 * | true      | false           | No-op (mainLoop fetches next job)      |
 *
 * @param enabled      WORKER_MAX_JOBS_BEFORE_RESTART > 0 相当のフラグ。
 * @param loggerPrefix ログ接頭辞（例: `"[PageAnalyzeWorker]"`）。
 *
 * @returns `Promise<void>` — exit 経路では返らない（process.exit）。
 *          no-op 経路では正常に return する。
 *
 * @example
 * ```ts
 * // Success/failure path 共通
 * await applyPostJobMemoryGate(_preReturnPauseEnabled, "[PageAnalyzeWorker]");
 * return result;
 * ```
 */
export async function applyPostJobMemoryGate(
  enabled: boolean,
  loggerPrefix: string
): Promise<void> {
  // Disabled path: full no-op. WORKER_MAX_JOBS_BEFORE_RESTART=0 相当。
  //
  // Plan v1.1 candidate B + SEC-PLAN-V0-M-01 closure (env=0 fail-closed
  // documented behavior):
  //   - env=0 では memory-gate `process.exit(0)` 経路も listener exit による
  //     planned restart 経路も skip される。
  //   - 唯一の防御層は WorkerSupervisor 側の RSS kill 4GB 閾値 (process.kill
  //     SIGKILL) と Phase 5 child fork side の RSS kill / heartbeat timeout。
  //   - これは documented behavior + fail-closed 契約として ADR-0034 Amendment 5
  //     §Consequences Negative + §Decision 1 footnote に明文化。
  //   - CWE-770 DoS 防御 layer は 3 (pause flag + memory gate + listener exit)
  //     → 2 (memory gate + listener exit) に縮退、env=0 時はさらに 1 (memory
  //     gate のみ) に縮退する (intentional documented behavior、SEC sign-off
  //     anchor `019e6f1a-b580`)。
  //
  // SEC-PLAN-V0-M-01 (env=0 fail-closed):
  // When WORKER_MAX_JOBS_BEFORE_RESTART=0 both the in-process `process.exit(0)`
  // gate and the planned-restart listener-exit are skipped. The only remaining
  // defense layer is the supervisor-side RSS kill 4GB threshold (SIGKILL) and
  // the Phase 5 child fork RSS kill / heartbeat timeout. This documented
  // behavior + fail-closed contract is recorded in ADR-0034 Amendment 5
  // §Consequences Negative + §Decision 1 footnote.
  if (!enabled) {
    return;
  }

  // Memory gate only. pause/resume は BullMQ 5.66.5 resume() race を避けるため削除。
  //   shouldExitForMemory() は内部で tryGarbageCollect() を呼ぶため、
  //   `--expose-gc` ありの環境では実 RSS に近い値で判定できる。
  const memCheck = shouldExitForMemory();

  if (memCheck.shouldExit) {
    logger.warn(`${loggerPrefix} Memory threshold exceeded, graceful exit`, {
      rssMb: memCheck.rssMb,
    });
    process.exit(0);
  }

  // RSS 閾値未満: 何もしない。BullMQ mainLoop が次ジョブを fetch する。
  //   旧実装の pause(true) + resume() は BullMQ 5.66.5 で silent no-op となり、
  //   paused=true のまま mainLoop が exit → 新規ジョブ取得停止の原因だった。
}

/**
 * No-op backward-compat helper (Plan v1.1 candidate B — ADR-0034 Amendment 5).
 *
 * Plan v1.1 candidate B (BullMQ `worker.pause(true)` ↔ `emit('completed')` race
 * 構造的解消) で本 helper の Stage 2 `await worker.pause(true)` は **formal
 * removal** され、`Promise<void>` no-op signature に縮退された。これにより
 * success path も failure path と同じく `applyPostJobMemoryGate` のみを使う
 * 構造に統一される (ADR-0034 Amendment 5 §Decision 3-4)。
 *
 * Plan v1.1 candidate B (Stage 2 `worker.pause(true)` formal removal) reduces
 * this helper to a `Promise<void>` **no-op** so both success and failure paths
 * route exclusively through `applyPostJobMemoryGate` (ADR-0034 Amendment 5
 * §Decision 3-4).
 *
 * ## なぜ no-op で削除しないのか / Why no-op (not deletion)
 *
 * IO Plan Decision V1 (anchor `019e6f1a-b580`) §Conflict 2 ruling (a) =
 * **TPA backward compat 優先** — `applyPostJobLifecycleGate` を import している
 * legacy test caller (e.g. `inv-next-job-race-001-sub1a-gate.test.ts` /
 * `inv-worker-no-resume-001.test.ts` の Layer 3 spy 等) の breakage を避ける
 * ため `Promise<void>` no-op signature を維持する。SEC-V42-L-NEW-4 precedent
 * (CWE-705/754 dead-code surface) は production callsite=0 + production-side
 * 動作不変が論点であったのに対し、本 helper は (1) test callers backward
 * compat 用 deprecation stub であり、(2) production callsite 2 件 (両 worker
 * success path) は **同 commit 内で `applyPostJobMemoryGate` に置換** され
 * dead-code ではない (transitional stub)。よって本 helper は SEC-V42-L-NEW-4
 * の dead-code 文脈に該当しない。
 *
 * 完全削除 (helper + 全 caller の `applyPostJobLifecycleGate` import 撤去) は
 * TDA decomposition 観点で別 PR で追跡する (`backfill-pause-completed-race-v1.md`
 * §10.2 TI-3、TDA-PLAN-V1-L-01 tracked-issue、deadline 2026-05-29 T+1d)。
 *
 * IO Plan Decision V1 (anchor `019e6f1a-b580`) §Conflict 2 ruling (a) =
 * TPA backward-compat preference: keep the `Promise<void>` no-op signature so
 * legacy test callers (e.g. `inv-next-job-race-001-sub1a-gate.test.ts`,
 * `inv-worker-no-resume-001.test.ts` Layer 3 spies) do not break. The
 * SEC-V42-L-NEW-4 precedent (CWE-705/754 dead-code surface) does not apply
 * because (1) this helper is a transitional deprecation stub for test
 * callers, and (2) production callsites (both workers' success paths) are
 * migrated to `applyPostJobMemoryGate` in the same commit. Full deletion is
 * tracked as a separate PR (Plan v1.1 §10.2 TI-3 / TDA-PLAN-V1-L-01,
 * deadline 2026-05-29 T+1d).
 *
 * ## H2 + H3 race 構造的消滅 / Structural race elimination
 *
 *   - **H2 (moveToCompleted paused 評価 race)**: pause を呼ばないので Lua の
 *     paused フラグ評価そのものが発生しない (構造的消滅)。
 *   - **H3 (event-loop starvation 下 emit 遅延、BullMQ #359 indirect evidence)**:
 *     pause を呼ばないので #359 由来の latent risk が一切消える (構造的消滅)。
 *   - **H1 (dispose ceiling 5s microtask race、ADR-0035 §Decision 1)**: 本 PR
 *     scope 外、直交維持 (`registerCompletedListenerAndExit` 内で active)。
 *
 * ## INV-WORKER-NO-PAUSE-001 enforcement
 *
 * production code 全体で `worker.pause(...)` callsite は **0 件** であること
 * を AST gate `scripts/verify-no-worker-pause.mjs` が CI で enforce する
 * (exempt scope = `pause:` event handler 内 + test files、3 bypass pattern
 * reject)。本 no-op helper の body 内に `worker.pause` callsite は存在しない。
 *
 * Cross-ref: ADR-0034 Amendment 5 (Stage 2 formal removal, 2026-05-28),
 * ADR-0009 §Status (Bug 1 portion further retracted),
 * Plan v1.1 §3 candidate B,
 * IO Plan Decision V1 anchor `019e6f1a-b580`,
 * INV-WORKER-NO-PAUSE-001.
 *
 * @param _worker       (unused, backward-compat stub) BullMQ Worker instance.
 * @param enabled       WORKER_MAX_JOBS_BEFORE_RESTART > 0 相当のフラグ。
 *                      log emit のためにのみ参照する。
 * @param loggerPrefix  ログ接頭辞（例: `"[PageAnalyzeWorker]"`）。
 *
 * @returns `Promise<void>` — 即時 resolve。pause / memory gate / exit は
 *          いずれも呼ばない。caller は同 commit 内で `applyPostJobMemoryGate`
 *          に置換されているため、本 helper は legacy test caller のみが触れる。
 *
 * @deprecated Use `applyPostJobMemoryGate` directly. Retained as no-op for
 *             legacy test-caller backward compat under ADR-0034 Amendment 5
 *             §Decision 4. Full deletion tracked in TI-3 (deadline 2026-05-29).
 */
export async function applyPostJobLifecycleGate(
  _worker: Worker,
  enabled: boolean,
  loggerPrefix: string
): Promise<void> {
  // Plan v1.1 candidate B no-op stub. The Stage 2 `await worker.pause(true)`
  // is formally removed (ADR-0034 Amendment 5). All real lifecycle gating now
  // routes through `applyPostJobMemoryGate` (see callers in
  // page-analyze-worker.ts and embedding-backfill-worker.ts).
  //
  // 単一 emit を保ち callers が enabled state を観測できるよう log のみ残す。
  // Single log line preserves observability of the `enabled` flag for callers.
  logger.info(
    `${loggerPrefix} Pre-return pause removed (ADR-0034 Amendment 5); no-op stub invoked`,
    { enabled }
  );
}

/**
 * Plan v4.2 PR-L closure (SEC-V42-L-NEW-4 mandate, TDA-V42-L-01):
 * `applyPostJobLifecycleGateAlwaysExits` wrapper was **formally removed** at
 * this location.
 *
 * Historical context: a `Promise<never>` return-type wrapper around
 * `applyPostJobLifecycleGate` was retained under Plan v4.2 PR-A TDA M-1
 * Option (b) ("future crash-path / test-fixture use"). SEC-V42-L-NEW-4 audit
 * subsequently identified:
 *   - **CWE-705 (Incorrect Control Flow Scoping) primary**: zero production
 *     callers + test-only retention exhibited a control-flow scoping mismatch
 *     in production worker package (Layer 1 type-level guarantee declared at
 *     a helper that the production worker never executes).
 *   - **CWE-754 (Improper Check for Unusual or Exceptional Conditions)
 *     secondary**: future-risk scenarios A/B/C where a regression could
 *     accidentally route a production caller through the wrapper without
 *     traversing the AST gate's listener-body inspection scope.
 *
 * The Layer 1 type-level `Promise<never>` guarantee is now provided
 * structurally by `scripts/verify-completed-listener-sync.mjs`: the AST gate
 * enforces that every `worker.once('completed', callback)` listener body is
 * synchronous-only (no `async`, no `await`), which guarantees that the
 * single-shot `process.exit(0)` inside the listener cannot be deferred or
 * interleaved with `moveToCompleted` Lua transaction commit. This is the
 * canonical Layer 1 enforcement going forward.
 *
 * Plan v4.2 PR-L closure (SEC-V42-L-NEW-4 mandate, TDA-V42-L-01):
 * `applyPostJobLifecycleGateAlwaysExits` wrapper was **formally removed**
 * here. Historical wrapper retention under TDA M-1 Option (b) ("future
 * crash-path / test-fixture use") was retired by SEC-V42-L-NEW-4 audit on
 * CWE-705 primary + CWE-754 secondary grounds (zero production callers +
 * test-only retention as production-package dead-code surface). The Layer 1
 * type-level `Promise<never>` guarantee is now structurally provided by
 * `scripts/verify-completed-listener-sync.mjs` (synchronous-only listener
 * body enforcement).
 *
 * Cross-ref: SEC-V42-L-NEW-4 audit anchor `019e2d9b-f7bf-7356-a336-c24f6806b4d8`
 * (CWE-705 + CWE-754), ADR-0034 §Type-Level Guarantee Layers (Layer 1 canonical
 * = AST gate post-supersede), Plan v4.2 §3.2 TDA M-1 closure (Option (b)
 * retracted per feedback_no_fake_success A-4 alignment).
 */

/**
 * Default dispose ceiling for `registerCompletedListenerAndExit` (Plan v4.3
 * PR-M-A): bounded ceiling for `disposeFn` microtask race. SEC M-NEW-1
 * mandate keeps the listener body synchronous; the dispose path is scheduled
 * as a microtask via `Promise.race([disposeFn(), setTimeout(ceiling)])` and
 * `process.exit(0)` is invoked from `.finally()`. The ceiling caps the total
 * deferred-exit window so a stalled dispose cannot indefinitely delay the
 * planned restart (CWE-833 BullMQ deadlock surface SEC H-1 closure preserved).
 *
 * Plan v4.3 PR-M-A default ceiling (ms) for bounded dispose microtask race.
 */
const DEFAULT_DISPOSE_CEILING_MS = 5000;

/**
 * Env override for {@link DEFAULT_DISPOSE_CEILING_MS}. `safeParseInt`-style
 * defensive parse: non-numeric / out-of-range values fall back to the default
 * (5000ms). Range 100..60000ms keeps the ceiling within sensible operational
 * bounds (a smaller window risks aborting normal disposes, a larger window
 * defers BullMQ planned restarts beyond useful observability).
 *
 * Env-override window for the dispose ceiling (Plan v4.3 PR-M-A).
 */
const DISPOSE_CEILING_MS_MIN = 100;
const DISPOSE_CEILING_MS_MAX = 60_000;

function resolveDisposeCeilingMs(override: number | undefined): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    if (override < DISPOSE_CEILING_MS_MIN || override > DISPOSE_CEILING_MS_MAX) {
      logger.warn(
        `[post-job-lifecycle] Invalid dispose ceiling override=${override}, using default ${DEFAULT_DISPOSE_CEILING_MS}`
      );
      return DEFAULT_DISPOSE_CEILING_MS;
    }
    return override;
  }
  const fromEnv = process.env.EMBEDDING_DISPOSE_CEILING_MS;
  if (fromEnv === undefined || fromEnv === "") return DEFAULT_DISPOSE_CEILING_MS;
  const parsed = Number.parseInt(fromEnv, 10);
  if (Number.isNaN(parsed) || parsed < DISPOSE_CEILING_MS_MIN || parsed > DISPOSE_CEILING_MS_MAX) {
    logger.warn(
      `[post-job-lifecycle] Invalid EMBEDDING_DISPOSE_CEILING_MS=${fromEnv}, using default ${DEFAULT_DISPOSE_CEILING_MS}`
    );
    return DEFAULT_DISPOSE_CEILING_MS;
  }
  return parsed;
}

/**
 * Optional configuration for {@link registerCompletedListenerAndExit}.
 *
 * Plan v4.3 PR-M-A: optional dispose function + bounded ceiling for the
 * canonical listener body pattern (ADR-0035 §Decision 1). When `disposeFn`
 * is provided, the helper schedules a microtask via
 * `Promise.race([disposeFn(), setTimeout(ceiling)])` inside the synchronous
 * listener body and invokes `process.exit(0)` from `.finally()`. The
 * synchronous-only listener body contract (SEC M-NEW-1) is preserved because
 * the Promise machinery is created but not awaited inside the listener
 * (the listener body itself contains no `await` expressions, and the
 * resulting Promise is consumed via `void exitPromise`).
 *
 * Plan v4.3 PR-M-A options for callback-based exit + bounded dispose race.
 */
export interface RegisterCompletedListenerOptions {
  /**
   * Optional dispose function invoked as a microtask before `process.exit(0)`.
   * Errors are caught, logged via `sanitizeErrorMessage`, and recorded as an
   * `audit_logs.embedding_dispose_timeout` entry (CWE-209 PII protection
   * inherited via `truncateAuditTargetId` SSOT). The function must be
   * idempotent and tolerant of partial state (it is invoked exactly once per
   * worker lifetime, immediately before exit).
   *
   * Plan v4.3 PR-M-A optional dispose microtask hook.
   */
  disposeFn?: () => Promise<void>;

  /**
   * Optional bounded ceiling (ms) for the dispose microtask race. Defaults to
   * {@link DEFAULT_DISPOSE_CEILING_MS} (5000ms) or the
   * `EMBEDDING_DISPOSE_CEILING_MS` env override. Range 100..60000ms;
   * out-of-range values fall back to the default with a warn log.
   *
   * Plan v4.3 PR-M-A bounded dispose ceiling (ms).
   */
  ceilingMs?: number;
}

/**
 * Plan v4.2 PR-L closure (TDA-V42-L-02): unified callback-based exit
 * listener registration helper for BullMQ Worker.
 *
 * Plan v4.2 PR-A で page-analyze-worker.ts と embedding-backfill-worker.ts
 * の両方が `worker.once('completed', ...)` listener を pre-register する
 * boilerplate を持っていた (~32 LoC 重複)。本 helper で集約し、両 worker
 * から呼び出すことで重複を解消する (TDA-V42-L-02 closure)。
 *
 * ## Plan v4.3 PR-M-A: bounded dispose microtask race (ADR-0035 §Decision 1)
 *
 * `options.disposeFn` を渡すと、listener body 内で
 * `Promise.race([disposeFn(), setTimeout(ceiling)])` を起動し、
 * `.finally(() => process.exit(0))` で exit を発火する。SEC M-NEW-1
 * synchronous-only listener body 契約は **維持** される (listener body 内に
 * `await` keyword は存在せず、Promise は `void exitPromise` で consumed)。
 *
 * Dispose 失敗時は `sanitizeErrorMessage` 経由で warn log を残し、
 * `AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT` を `audit_logs` に emit する
 * (CWE-209 PII protection inherited via `truncateAuditTargetId` SSOT;
 * GDPR Art.30 365d retention 継承)。`disposeFn` 未指定時は legacy
 * synchronous-only `process.exit(0)` 経路 (Plan v4.2 PR-A unchanged) を辿る。
 *
 * The optional `disposeFn` triggers a microtask race
 * (`Promise.race([disposeFn(), setTimeout(ceiling)])`) inside the synchronous
 * listener body. `.finally()` fires `process.exit(0)` once either the
 * dispose resolves/rejects or the ceiling elapses. SEC M-NEW-1
 * synchronous-only listener body contract is preserved (no `await` keyword
 * appears in the listener body; the Promise is consumed via
 * `void exitPromise`). Dispose errors are sanitised via
 * `sanitizeErrorMessage` and recorded as
 * `audit_logs.embedding_dispose_timeout` (CWE-209 PII protection inherited
 * via `truncateAuditTargetId` SSOT; GDPR Art.30 365d retention).
 *
 * ## SEC M-NEW-1 AST gate co-existence
 *
 * `scripts/verify-completed-listener-sync.mjs` (SEC M-NEW-1 / TPA-V42-M-03
 * closure) は本 helper 内の `worker.once('completed', callback)` callsite
 * も synchronous-only inspection の scope に含む。Helper TARGETS 拡張で
 * `apps/mcp-server/src/workers/shared/post-job-lifecycle.ts` を追加し、
 * helper body 内の `AwaitExpression` を 0 件 enforce する (helper 経由でも
 * Plan v4 PR-C race を構造的に排除する)。Plan v4.3 PR-M-A は本 enforcement
 * を破らない: dispose は microtask として scheduled され、listener body 内に
 * `await` は存在しない。
 *
 * The AST gate enforces zero `AwaitExpression` in the listener body. Plan
 * v4.3 PR-M-A preserves this: dispose is scheduled as a microtask, no
 * `await` keyword appears in the listener body itself.
 *
 * ## PII protection
 *
 * jobId は canonical CWE-209 pattern (`.claude/rules/security.md` §Canonical
 * CWE-209 PII Protection Pattern) に従い truncate する。`job.id` は BullMQ で
 * `string | undefined` 型であり、`truncateAuditTargetId` SSOT が 8-char + "..."
 * truncation length contract を担う。`AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH`
 * 経由で coupling drift を構造的に排除。
 *
 * Cross-ref: ADR-0034 §Decision 1 Step C (callback-based exit pattern),
 * ADR-0035 §Decision 1 (canonical listener body pattern for bounded dispose),
 * SEC M-NEW-1 (synchronous-only listener body), Plan v4.3 PR-M-A,
 * `.claude/rules/security.md` §Canonical CWE-209 PII Protection Pattern.
 *
 * @param worker      BullMQ Worker instance
 * @param workerType  "page-analyze" | "embedding-backfill"
 * @param options     Plan v4.3 PR-M-A optional dispose hook + ceiling
 */
export function registerCompletedListenerAndExit(
  worker: Worker,
  workerType: WorkerLifecycleType,
  options?: RegisterCompletedListenerOptions
): void {
  const loggerPrefix =
    workerType === "page-analyze" ? "[PageAnalyzeWorker]" : "[EmbeddingBackfillWorker]";

  // SEC M-NEW-1 mandate: listener body MUST be synchronous-only (no async, no await).
  // AST gate `scripts/verify-completed-listener-sync.mjs` enforces this in CI.
  worker.once("completed", (job) => {
    // PII-safe: truncateAuditTargetId SSOT (8-char + "...") for jobId.
    // BullMQ job.id is `string | undefined`; SSOT accepts string | undefined | null
    // and emits `AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` constant length.
    const truncatedJobId = truncateAuditTargetId(job?.id ?? null);
    logger.info(`${loggerPrefix} Job completed listener firing, exit(0) for planned restart`, {
      jobId: truncatedJobId,
    });

    // Plan v4.3 PR-M-A: bounded dispose microtask race (ADR-0035 §Decision 1).
    // `disposeFn` 未指定時は legacy synchronous exit (Plan v4.2 PR-A unchanged)。
    // 指定時は Promise.race + setTimeout ceiling で bounded ceiling 内に
    // exit を発火する。SEC M-NEW-1 synchronous-only listener body 契約は
    // 維持される: listener body 内に `await` keyword は存在せず、Promise は
    // `void exitPromise` で consumed (微 task scheduled but not awaited).
    const disposeFn = options?.disposeFn;
    if (disposeFn === undefined) {
      process.exit(0); // legacy synchronous path (Plan v4.2 PR-A unchanged)
      return;
    }

    const ceiling = resolveDisposeCeilingMs(options?.ceilingMs);
    // ADR-0035 §Decision 1 canonical listener body pattern:
    //   Promise.race([disposeFn().catch(emitAudit), setTimeout(ceiling)])
    //     .finally(() => process.exit(0))
    // Dispose error / ceiling-elapsed の両 branch で audit_logs emit。
    // `disposeSettled` race-winner flag で double-emit を構造的に排除
    // (Plan v4.3 PR-M-A refinement Item 2 closure):
    //   - dispose resolved → `disposeSettled = true` → ceiling-fire は no-op
    //   - dispose rejected → emit `reason: "dispose_error"` + `disposeSettled = true`
    //                        → ceiling-fire は no-op
    //   - ceiling elapsed before dispose settles → emit `reason: "ceiling_elapsed"`
    // `void exitPromise` で SEC M-NEW-1 synchronous-only listener body 維持。
    //
    // ADR-0035 §Decision 1 canonical pattern with race-winner flag
    // (`disposeSettled`) preventing double-emit: dispose resolution (success
    // or rejection) marks the flag, so the ceiling branch becomes a no-op.
    // If the ceiling elapses first, it emits `reason: "ceiling_elapsed"`.
    let disposeSettled = false;
    const exitPromise = Promise.race([
      disposeFn().then(
        () => {
          disposeSettled = true;
        },
        (err: unknown) => {
          disposeSettled = true;
          logger.warn(`${loggerPrefix} Dispose error during exit`, {
            jobId: truncatedJobId,
            error: sanitizeErrorMessage(err),
          });
          // emitAuditLog via getAuditLogService(): fire-and-forget, errors logged
          // internally by AuditLogService.log() (CWE-209 sanitised). 365d retention
          // + truncateAuditTargetId PII minimisation inherited.
          void getAuditLogService()
            .log({
              action: AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT,
              // FIND-IMPL-LCC-V43-PRM-M-01 closure: SSOT-derived actor literal
              // (`system:<worker>-worker`) via `getWorkerActorName(workerType)`
              // structurally eliminates the bare-suffix risk (e.g. emitting
              // `system:embedding-backfill` instead of the canonical
              // `system:embedding-backfill-worker`) that the prior template
              // literal `system:${workerType}` allowed.
              actor: getWorkerActorName(workerType),
              targetType: "worker",
              targetId: truncatedJobId ?? undefined,
              result: "failure",
              details: {
                reason: "dispose_error",
                workerType,
                ceilingMs: ceiling,
                message: sanitizeErrorMessage(err),
              },
            })
            .catch(() => {
              /* audit failure already logged inside AuditLogService.log */
            });
        }
      ),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          // Race winner flag check: only emit when ceiling truly elapsed
          // before disposeFn settled (success / rejection). This is the
          // structural double-emit guard (Plan v4.3 PR-M-A refinement
          // Item 2): if dispose has already settled, this setTimeout is a
          // late-runner and MUST NOT emit (dispose path owns the audit).
          if (!disposeSettled) {
            logger.warn(`${loggerPrefix} Dispose ceiling elapsed before settling`, {
              jobId: truncatedJobId,
              ceilingMs: ceiling,
            });
            void getAuditLogService()
              .log({
                action: AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT,
                // FIND-IMPL-LCC-V43-PRM-M-01 closure: SSOT-derived actor
                // literal via `getWorkerActorName(workerType)` (see paired
                // dispose-error branch above for full rationale).
                actor: getWorkerActorName(workerType),
                targetType: "worker",
                targetId: truncatedJobId ?? undefined,
                result: "failure",
                details: {
                  reason: "ceiling_elapsed",
                  workerType,
                  ceilingMs: ceiling,
                },
              })
              .catch(() => {
                /* audit failure already logged inside AuditLogService.log */
              });
          }
          resolve();
        }, ceiling)
      ),
    ]).finally(() => {
      process.exit(0); // single exit point (ADR-0035 §Decision 1)
    });
    // SEC M-NEW-1: synchronous-only listener body. `exitPromise` is created
    // here but **not awaited**; the listener function returns synchronously
    // and the Promise machinery runs on the microtask queue, firing
    // `process.exit(0)` from `.finally()` once the race settles.
    void exitPromise;
  });

  // Touch AUDIT_LOG_CONSTANTS so unused-import lint does not complain in some
  // toolchains; the value is the SSOT length contract used by truncateAuditTargetId.
  void AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH;
}
