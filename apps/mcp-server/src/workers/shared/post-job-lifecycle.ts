// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Post-Job Lifecycle Helper — Memory-Gated Exit
 *
 * v0.4.0 PR7e-β2 hotfix: BullMQ Worker の success/failure path で使う
 * メモリ閾値ゲートを一元化する。RSS 閾値超過時のみ `process.exit(0)` し、
 * 未満時は no-op（mainLoop が自然に次ジョブを fetch）。
 *
 * Memory threshold gate for BullMQ Worker success/failure paths. Calls
 * `process.exit(0)` only when RSS exceeds the threshold; otherwise no-op so
 * the BullMQ mainLoop fetches the next job naturally.
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

import { shouldExitForMemory } from "../../services/worker-memory-monitor.service";
import { logger } from "../../utils/logger";

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
