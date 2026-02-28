// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker Memory Monitor Service
 *
 * ワーカープロセスのメモリ自己監視機能を提供する。
 * ジョブ完了後にRSSメモリ使用量をチェックし、閾値超過時にgraceful exitする。
 *
 * WorkerSupervisorと連携して、OOMキラーによる強制終了を防止する:
 * 1. ワーカーがジョブ完了後に shouldExitForMemory() でチェック
 * 2. 閾値超過なら performMemoryCheckAndExit() で process.exit(0)
 * 3. WorkerSupervisor が exit を検知して新プロセスを spawn
 *
 * @module services/worker-memory-monitor
 */

import { logger } from '../utils/logger';
import { resolveMemoryConfig } from './worker-memory-profile';

// ============================================================================
// Constants
// ============================================================================

/**
 * デフォルトのRSSメモリ閾値（MB）
 * OOMキラー前に安全停止するための上限。
 * 環境変数 WORKER_SELF_EXIT_THRESHOLD_MB で上書き可能。
 *
 * computeMemoryProfile() によりシステムメモリに基づき動的計算される。
 * 32GBマシンでは従来の 12288MB と一致する。
 */
const DEFAULT_THRESHOLD_MB = resolveMemoryConfig().selfExitThresholdMb;

// ============================================================================
// Types
// ============================================================================

export interface MemoryCheckResult {
  /** プロセスを終了すべきかどうか */
  shouldExit: boolean;
  /** 現在のRSSメモリ使用量（MB） */
  rssMb: number;
}

// ============================================================================
// GC Helper
// ============================================================================

/**
 * GCが利用可能であれば実行する（--expose-gc フラグ必要）
 */
function tryGarbageCollect(): void {
  if (typeof global.gc === 'function') {
    global.gc();
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 現在のメモリ使用量（RSS）が閾値を超えているかチェックする。
 *
 * GCが利用可能な場合はチェック前にGCを実行して、
 * 実際のメモリ使用量を計測する。
 *
 * @returns MemoryCheckResult - shouldExit と rssMb を含むオブジェクト
 */
export function shouldExitForMemory(): MemoryCheckResult {
  // GCトリガー（--expose-gc時のみ）
  tryGarbageCollect();

  const memUsage = process.memoryUsage();
  const rssMb = Math.round(memUsage.rss / 1024 / 1024);
  const thresholdMb = getThresholdMb();

  return {
    shouldExit: rssMb > thresholdMb,
    rssMb,
  };
}

/**
 * メモリチェックを実行し、閾値超過時にprocess.exit(0)で終了する。
 *
 * 閾値以下の場合は何もしない（プロセス継続）。
 * 閾値超過の場合はexit code 0でgraceful exitし、
 * WorkerSupervisorが新しいプロセスとして再起動する。
 */
export function performMemoryCheckAndExit(): void {
  const result = shouldExitForMemory();

  logger.info('[WorkerMemoryMonitor] Memory check', {
    rssMb: result.rssMb,
    thresholdMb: getThresholdMb(),
    shouldExit: result.shouldExit,
  });

  if (result.shouldExit) {
    logger.warn('[WorkerMemoryMonitor] Memory threshold exceeded, graceful exit', {
      rssMb: result.rssMb,
      thresholdMb: getThresholdMb(),
    });
    process.exit(0);
  }
}

// ============================================================================
// Internal
// ============================================================================

/**
 * 環境変数から閾値を取得する
 */
function getThresholdMb(): number {
  const envValue = process.env.WORKER_SELF_EXIT_THRESHOLD_MB;
  if (envValue !== undefined && envValue !== '') {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_THRESHOLD_MB;
}
