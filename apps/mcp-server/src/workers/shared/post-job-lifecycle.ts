// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Post-Job Lifecycle Helper — Pre-Return Pause + Memory-Gated Exit/Resume
 *
 * v0.4.0 PR7c: BullMQ Worker の success path で共通的に使う
 * 「pause → RSS 判定 → exit or resume」のライフサイクルを一元化する。
 *
 * v0.4.0 PR7c: Centralizes the "pause → RSS check → exit or resume" lifecycle
 * used by BullMQ Workers on the success path.
 *
 * ## 背景 / Background
 *
 * 従来の実装では success path で `worker.pause(true)` した後、無条件で
 * `setImmediate(() => performMemoryCheckAndExit())` を呼んでいた。
 * `performMemoryCheckAndExit()` は RSS 閾値超過時のみ `process.exit(0)` し、
 * 閾値未満なら何もしない。結果、RSS が軽量な Worker では **pause 状態が永続化** し、
 * 次ジョブを取得できなくなるバグがあった（PR7c バグ1）。
 *
 * Previously, the success path called `worker.pause(true)` followed by an
 * unconditional `setImmediate(() => performMemoryCheckAndExit())`. The latter
 * only exits when RSS exceeds the threshold and no-ops otherwise. For RSS-light
 * workers, this left the worker **permanently paused**, unable to pick up new
 * jobs (PR7c Bug 1).
 *
 * ## 解決 / Resolution
 *
 * このヘルパーでは pause 後に `shouldExitForMemory()` で RSS を判定し:
 *   - RSS 閾値超過: `process.exit(0)` → WorkerSupervisor が再起動（従来動作）
 *   - RSS 閾値未満: `worker.resume()` → 新規ジョブ取得を再開（PR7c で追加）
 *
 * This helper checks RSS via `shouldExitForMemory()` after pausing:
 *   - RSS above threshold: `process.exit(0)` → WorkerSupervisor restart path
 *   - RSS below threshold: `worker.resume()` → resume acquiring new jobs
 *
 * ## セマンティクス / Semantics
 *
 * - `enabled=false`（`WORKER_MAX_JOBS_BEFORE_RESTART=0`）時:
 *   pause / resume / memory-check いずれも実行しない（no-op）。
 *   従来の「exit 依存」挙動も含めて一切の lifecycle 操作をスキップする。
 * - `enabled=true`（default）: 上記の RSS ゲート付き pause/resume を実行。
 *
 * - `enabled=false` (`WORKER_MAX_JOBS_BEFORE_RESTART=0`):
 *   no pause / resume / memory check (full no-op). All legacy "exit-on-threshold"
 *   lifecycle behavior is skipped as well.
 * - `enabled=true` (default): applies the RSS-gated pause/resume described above.
 *
 * ## セキュリティ / Security
 *
 * - **CWE-209 (Error Message Information Leak)**: `pause()` / `resume()` の例外は
 *   `sanitizeErrorMessage()` を通してからログする。BullMQ 内部の Redis コマンドや
 *   jobId がそのまま warn ログに出ないよう保護。
 * - **CWE-770 (Uncontrolled Resource Consumption)**: `resume()` 直後の連続ジョブ
 *   取得は BullMQ の `lockDuration`（page-analyze: `DEFAULT_LOCK_DURATION=2_400_000ms` / 40min、
 *   embedding-backfill: `600_000ms` / 10min）と MCP 側の rate limiter（enqueue 時に作動）でガード。
 *   外部攻撃者が resume を誘発して DoS を狙うことは不可能（lockDuration が長いほど
 *   単一 Worker での連続処理スループットが物理的に制限される）。
 *
 * - **CWE-209**: `pause()` / `resume()` exceptions are routed through
 *   `sanitizeErrorMessage()` before logging, preventing BullMQ-internal Redis
 *   commands or jobIds from leaking into warn logs.
 * - **CWE-770**: Continuous job acquisition after `resume()` is bounded by BullMQ
 *   `lockDuration` (page-analyze: `DEFAULT_LOCK_DURATION=2_400_000ms` / 40min;
 *   embedding-backfill: `600_000ms` / 10min) and the MCP-side rate limiter at enqueue time.
 *   External attackers cannot trigger `resume()` to cause DoS (a longer lockDuration
 *   physically limits continuous processing throughput per worker).
 *
 * @module workers/shared/post-job-lifecycle
 */

import type { Worker } from "bullmq";

import { shouldExitForMemory } from "../../services/worker-memory-monitor.service";
import { logger, isDevelopment } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";

/**
 * Pre-Return Pause + memory-gated exit/resume for BullMQ Worker success paths.
 *
 * BullMQ Worker の success path で pause/memory-check/resume をアトミックに適用する。
 *
 * ### Decision Matrix / 判定フロー
 *
 * | `enabled` | RSS > threshold | Outcome                                   |
 * | --------- | --------------- | ----------------------------------------- |
 * | false     | *               | No-op (pause/resume/exit すべてスキップ)   |
 * | true      | true            | `process.exit(0)` → Supervisor restart    |
 * | true      | false           | `worker.resume()` → 新規ジョブ取得を再開  |
 *
 * @param workerRef    BullMQ Worker インスタンス。null の場合は no-op。
 * @param enabled      WORKER_MAX_JOBS_BEFORE_RESTART > 0 相当のフラグ。
 * @param loggerPrefix ログ接頭辞（例: `"[PageAnalyzeWorker]"`）。
 *
 * @returns `Promise<void>` — exit 経路では返らない（process.exit）。
 *          resume / no-op 経路では正常に return する。
 *
 * @example
 * ```ts
 * // Success path only (failure path は従来通り pause しない)
 * await applyPreReturnPauseAndMemoryGate(
 *   _workerInstanceRef,
 *   _preReturnPauseEnabled,
 *   "[PageAnalyzeWorker]"
 * );
 * return result;
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Worker generics vary per worker; any here is scoped to the helper signature.
export async function applyPreReturnPauseAndMemoryGate<TData = any, TResult = any>(
  workerRef: Worker<TData, TResult> | null,
  enabled: boolean,
  loggerPrefix: string
): Promise<void> {
  // Disabled path: no pause, no resume, no memory check.
  //   WORKER_MAX_JOBS_BEFORE_RESTART=0 相当。従来の「exit 依存」挙動も
  //   解除する（本ヘルパー経由では lifecycle 一切を触らない）。
  if (!enabled || !workerRef) {
    return;
  }

  // Step 1: Pre-Return Pause — guarantee fetchNext=false during BullMQ moveToCompleted.
  //   CWE-209: sanitizeErrorMessage でラップしてからログ。
  try {
    await workerRef.pause(true);
    if (isDevelopment()) {
      logger.info(`${loggerPrefix} Pre-return pause applied (fetchNext=false guaranteed)`);
    }
  } catch (pauseError) {
    logger.warn(`${loggerPrefix} Pre-return pause failed (non-fatal)`, {
      error: sanitizeErrorMessage(pauseError),
    });
    // pause 失敗は致命的ではない（WorkerSupervisor の shutdown でフォールバック）。
    // 後続の memory check は続行する。
    // Non-fatal: WorkerSupervisor shutdown provides a fallback. Continue to memory check.
  }

  // Step 2: Memory gate — RSS 閾値超過なら exit、未満なら resume。
  //   shouldExitForMemory() は内部で tryGarbageCollect() を呼ぶため、
  //   `--expose-gc` ありの環境では実 RSS に近い値で判定できる。
  const memCheck = shouldExitForMemory();

  if (memCheck.shouldExit) {
    logger.warn(`${loggerPrefix} Memory threshold exceeded, graceful exit`, {
      rssMb: memCheck.rssMb,
    });
    process.exit(0);
  }

  // Step 3: Resume path — RSS が閾値未満なので Worker を再開して次ジョブを取得可能にする。
  //   PR7c で追加: 従来は exit 経路のみだったため、RSS 軽量 Worker で pause が永続化していた。
  //   CWE-209: sanitizeErrorMessage でラップしてからログ。
  //   PR7c addition: the legacy code only had the exit branch, so RSS-light workers
  //   ended up permanently paused. Resume restores job acquisition.
  try {
    await workerRef.resume();
    if (isDevelopment()) {
      logger.info(`${loggerPrefix} Worker resumed after memory gate (RSS below threshold)`, {
        rssMb: memCheck.rssMb,
      });
    }
  } catch (resumeError) {
    logger.warn(`${loggerPrefix} Worker resume failed (non-fatal)`, {
      error: sanitizeErrorMessage(resumeError),
    });
    // resume 失敗も致命的ではない（WorkerSupervisor の健全性チェックで検出可能）。
    // Non-fatal: WorkerSupervisor health checks will eventually notice.
  }
}
