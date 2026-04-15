// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Launch Semaphore (v0.4.0 PR7e-α)
 *
 * モジュール内部で Chromium standalone launch を排他化するための最小セマフォ。
 * Queue-based Backfill worker が Part Bbox 解決のために独自 Chromium を起動
 * する際、同時並行する Phase 5 child orchestrator の Chromium 起動と競合して
 * Playwright リソース枯渇 / zombie process 発生する恐れがあるため、
 * `max=1` で直列化する。SEC HIGH-3 対応。
 *
 * Minimal in-module semaphore that serialises standalone Chromium launches.
 * The Queue-based Backfill worker launches Chromium on its own for Part Bbox
 * resolution. If a Phase 5 child orchestrator launches Chromium concurrently,
 * Playwright resources exhaust and zombie processes may accumulate. This
 * semaphore restricts concurrency to `max=1` (SEC HIGH-3).
 *
 * 使用例 / Usage:
 *   const release = await launchSemaphore.acquire();
 *   try {
 *     const browser = await chromium.launch(...);
 *     ...
 *   } finally {
 *     release();
 *   }
 *
 * @module utils/launch-semaphore
 */

export interface LaunchSemaphore {
  /**
   * 許可トークンを取得する。max を超えた場合は解放まで待つ。
   * Acquire a permit; waits when `max` is already in flight.
   * @returns Release 関数 (`finally` で必ず呼び出すこと) / Release fn (always call in `finally`).
   */
  acquire(): Promise<() => void>;
  /** 現在の in-flight 数 / Current in-flight count */
  inFlight(): number;
  /** キュー長 (待機中) / Pending queue length */
  pending(): number;
}

/**
 * シンプルな FIFO セマフォ実装。
 * Simple FIFO semaphore implementation.
 */
export function createLaunchSemaphore(max: number): LaunchSemaphore {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`createLaunchSemaphore: max must be a positive integer (got ${max})`);
  }

  let active = 0;
  const waiters: Array<() => void> = [];

  function release(): void {
    active -= 1;
    const next = waiters.shift();
    if (next) {
      // 非同期順位付けを保ちつつ同期カウンタ維持
      // Preserve async ordering while keeping the sync counter accurate.
      active += 1;
      // Do not reduce `active` here; `release` from the next holder will.
      next();
    }
  }

  return {
    async acquire(): Promise<() => void> {
      if (active < max) {
        active += 1;
        return () => release();
      }
      return new Promise<() => void>((resolve) => {
        waiters.push(() => {
          // active は release 内でインクリメント済。
          // active already incremented in release().
          resolve(() => release());
        });
      });
    },
    inFlight(): number {
      return active;
    },
    pending(): number {
      return waiters.length;
    },
  };
}

/**
 * モジュールレベル singleton — Part Bbox 解決で使用する。
 * Module-level singleton used by Part Bbox resolution paths.
 */
export const partBboxLaunchSemaphore: LaunchSemaphore = createLaunchSemaphore(1);
