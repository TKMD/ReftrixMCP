// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Frame Worker Pool Service
 *
 * Worker Threadsを使用したフレーム差分計算の並列処理サービス
 *
 * 機能:
 * - CPUコア数に応じたワーカー数自動調整
 * - タスクキューによる効率的な並列処理
 * - 100フレーム < 30秒のパフォーマンス目標
 *
 * @module @reftrix/mcp-server/services/motion/frame-worker-pool
 */

import * as os from 'node:os';
import { Worker } from 'node:worker_threads';

import type { BoundingBox, DiffOptions } from './types';

// =============================================================================
// 定数
// =============================================================================

const DEFAULTS = {
  /** デフォルトワーカー数（CPUコア数 - 1、最小1） */
  WORKER_COUNT: Math.max(1, os.cpus().length - 1),
  /** タスクタイムアウト（ms） */
  TASK_TIMEOUT_MS: 10000,
  /** 差分閾値 */
  DIFF_THRESHOLD: 0.1,
} as const;

// =============================================================================
// 型定義
// =============================================================================

/**
 * Worker Pool 設定
 */
export interface FrameWorkerPoolConfig {
  /** ワーカー数（デフォルト: CPUコア数 - 1） */
  workerCount?: number;
  /** タスクタイムアウト（ms） */
  taskTimeoutMs?: number;
}

/**
 * ワーカータスク
 */
export interface WorkerTask {
  /** タスクID */
  taskId: string;
  /** フレーム1のバッファ */
  frame1: Buffer;
  /** フレーム2のバッファ */
  frame2: Buffer;
  /** 画像幅 */
  width: number;
  /** 画像高さ */
  height: number;
  /** 差分オプション */
  options: DiffOptions;
}

/**
 * ワーカー差分結果
 */
export interface WorkerDiffResult {
  /** 変化率 (0-1) */
  changeRatio: number;
  /** 変化ピクセル数 */
  changedPixels: number;
  /** 総ピクセル数 */
  totalPixels: number;
  /** 変化領域 */
  regions: BoundingBox[];
  /** 変化があるか */
  hasChange: boolean;
}

/**
 * ワーカータスク結果
 */
export interface WorkerTaskResult {
  /** タスクID */
  taskId: string;
  /** 成功フラグ */
  success: boolean;
  /** 差分結果 */
  result?: WorkerDiffResult;
  /** エラーメッセージ */
  error?: string;
  /** 処理時間（ms） */
  processingTimeMs?: number;
}

/**
 * プール統計
 */
export interface PoolStats {
  /** 総ワーカー数 */
  totalWorkers: number;
  /** 稼働中ワーカー数 */
  busyWorkers: number;
  /** 待機中タスク数 */
  pendingTasks: number;
  /** 完了タスク数 */
  completedTasks: number;
  /** 失敗タスク数 */
  failedTasks: number;
  /** 初期化済みフラグ */
  isInitialized: boolean;
}

/**
 * 内部ワーカーメッセージ
 */
interface WorkerMessage {
  type: 'task' | 'result' | 'error';
  taskId: string;
  data?: WorkerTask | WorkerDiffResult;
  error?: string;
}

// =============================================================================
// Worker スクリプト（インライン）
// =============================================================================

/**
 * ワーカースクリプトのコード
 * Worker Threadsはファイルベースなので、インラインで定義してevalで実行
 */
const WORKER_SCRIPT = `
const { parentPort } = require('node:worker_threads');

/**
 * フレーム差分を計算（シンプル実装）
 */
function calculateDiff(task) {
  const { frame1, frame2, width, height, options } = task;
  const threshold = (options?.threshold ?? 0.1) * 255 * 3;
  const totalPixels = width * height;
  const expectedSize = totalPixels * 4;

  // バッファサイズ検証
  if (frame1.length !== expectedSize || frame2.length !== expectedSize) {
    throw new Error(\`Buffer size mismatch: expected \${expectedSize}, got \${frame1.length} and \${frame2.length}\`);
  }

  // 差分計算
  let changedPixels = 0;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let i = 0; i < frame1.length; i += 4) {
    const r1 = frame1[i] ?? 0;
    const g1 = frame1[i + 1] ?? 0;
    const b1 = frame1[i + 2] ?? 0;
    const r2 = frame2[i] ?? 0;
    const g2 = frame2[i + 1] ?? 0;
    const b2 = frame2[i + 2] ?? 0;

    const diff = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
    if (diff > threshold) {
      changedPixels++;
      const pixelIndex = i / 4;
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const changeRatio = changedPixels / totalPixels;
  const regions = changedPixels > 0 ? [{
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  }] : [];

  return {
    changeRatio,
    changedPixels,
    totalPixels,
    regions,
    hasChange: changeRatio > 0.001,
  };
}

// メッセージハンドラ
parentPort.on('message', (message) => {
  const { type, taskId, data } = message;

  if (type === 'task') {
    const startTime = Date.now();
    try {
      const result = calculateDiff(data);
      parentPort.postMessage({
        type: 'result',
        taskId,
        data: result,
        processingTimeMs: Date.now() - startTime,
      });
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
});
`;

// =============================================================================
// FrameWorkerPool クラス
// =============================================================================

/**
 * フレーム差分計算用ワーカープール
 *
 * Worker Threadsを使用してフレーム差分計算を並列化
 */
export class FrameWorkerPool {
  private readonly config: Required<FrameWorkerPoolConfig>;
  private workers: Worker[] = [];
  private availableWorkers: Worker[] = [];
  private taskQueue: { task: WorkerTask; resolve: (result: WorkerTaskResult) => void }[] = [];
  private pendingTasks: Map<string, { resolve: (result: WorkerTaskResult) => void; startTime: number }> = new Map();
  private isInitialized = false;
  private isShuttingDown = false;
  private completedTasks = 0;
  private failedTasks = 0;

  constructor(config: FrameWorkerPoolConfig = {}) {
    const cpuCount = os.cpus().length;
    const requestedWorkers = config.workerCount ?? DEFAULTS.WORKER_COUNT;

    this.config = {
      workerCount: Math.min(Math.max(1, requestedWorkers), cpuCount),
      taskTimeoutMs: config.taskTimeoutMs ?? DEFAULTS.TASK_TIMEOUT_MS,
    };

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameWorkerPool] Created:', {
        workerCount: this.config.workerCount,
        cpuCount,
      });
    }
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * ワーカープールを初期化
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    for (let i = 0; i < this.config.workerCount; i++) {
      const worker = this.createWorker();
      this.workers.push(worker);
      this.availableWorkers.push(worker);
    }

    this.isInitialized = true;

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameWorkerPool] Initialized with', this.workers.length, 'workers');
    }
  }

  /**
   * 単一タスクを処理
   */
  async processTask(task: WorkerTask): Promise<WorkerTaskResult> {
    if (!this.isInitialized) {
      throw new Error('Worker pool is not initialized');
    }

    if (this.isShuttingDown) {
      throw new Error('Worker pool is shutting down');
    }

    return new Promise<WorkerTaskResult>((resolve) => {
      this.queueTask(task, resolve);
      this.processQueue();
    });
  }

  /**
   * バッチタスクを並列処理
   */
  async processBatch(tasks: WorkerTask[]): Promise<WorkerTaskResult[]> {
    if (tasks.length === 0) {
      return [];
    }

    const promises = tasks.map((task) => this.processTask(task));
    return Promise.all(promises);
  }

  /**
   * プール統計を取得
   */
  getStats(): PoolStats {
    return {
      totalWorkers: this.config.workerCount,
      busyWorkers: this.workers.length - this.availableWorkers.length,
      pendingTasks: this.taskQueue.length + this.pendingTasks.size,
      completedTasks: this.completedTasks,
      failedTasks: this.failedTasks,
      isInitialized: this.isInitialized,
    };
  }

  /**
   * ワーカープールをシャットダウン
   */
  async shutdown(): Promise<void> {
    if (!this.isInitialized || this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;

    // 待機中タスクをキャンセル
    for (const { resolve } of this.taskQueue) {
      resolve({
        taskId: 'cancelled',
        success: false,
        error: 'Pool shutdown',
      });
    }
    this.taskQueue = [];

    // ペンディングタスクをキャンセル
    for (const [taskId, { resolve }] of this.pendingTasks) {
      resolve({
        taskId,
        success: false,
        error: 'Pool shutdown',
      });
    }
    this.pendingTasks.clear();

    // ワーカーを終了
    const terminationPromises = this.workers.map((worker) => worker.terminate());
    await Promise.all(terminationPromises);

    this.workers = [];
    this.availableWorkers = [];
    this.isInitialized = false;
    this.isShuttingDown = false;

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[FrameWorkerPool] Shutdown complete');
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * ワーカーを作成
   */
  private createWorker(): Worker {
    // evalを使用してインラインワーカーを作成
    const worker = new Worker(WORKER_SCRIPT, {
      eval: true,
    });

    worker.on('message', (message: WorkerMessage & { processingTimeMs?: number }) => {
      this.handleWorkerMessage(worker, message);
    });

    worker.on('error', (error) => {
      if (process.env.NODE_ENV === 'development') {
        console.error('[FrameWorkerPool] Worker error:', error);
      }
    });

    worker.on('exit', (code) => {
      if (code !== 0 && !this.isShuttingDown) {
        if (process.env.NODE_ENV === 'development') {
          console.warn('[FrameWorkerPool] Worker exited with code:', code);
        }
        // ワーカーを再作成
        const index = this.workers.indexOf(worker);
        if (index !== -1) {
          const newWorker = this.createWorker();
          this.workers[index] = newWorker;
          this.availableWorkers.push(newWorker);
        }
      }
    });

    return worker;
  }

  /**
   * ワーカーメッセージを処理
   */
  private handleWorkerMessage(
    worker: Worker,
    message: WorkerMessage & { processingTimeMs?: number }
  ): void {
    const pending = this.pendingTasks.get(message.taskId);
    if (!pending) {
      return;
    }

    this.pendingTasks.delete(message.taskId);

    // ワーカーを利用可能に戻す
    this.availableWorkers.push(worker);

    // 結果を返す
    if (message.type === 'result') {
      this.completedTasks++;
      const resultObj: WorkerTaskResult = {
        taskId: message.taskId,
        success: true,
        result: message.data as WorkerDiffResult,
      };
      if (message.processingTimeMs !== undefined) {
        resultObj.processingTimeMs = message.processingTimeMs;
      }
      pending.resolve(resultObj);
    } else {
      this.failedTasks++;
      const errorObj: WorkerTaskResult = {
        taskId: message.taskId,
        success: false,
      };
      if (message.error !== undefined) {
        errorObj.error = message.error;
      }
      pending.resolve(errorObj);
    }

    // 次のタスクを処理
    this.processQueue();
  }

  /**
   * タスクをキューに追加
   */
  private queueTask(task: WorkerTask, resolve: (result: WorkerTaskResult) => void): void {
    this.taskQueue.push({ task, resolve });
  }

  /**
   * キューからタスクを処理
   */
  private processQueue(): void {
    while (this.availableWorkers.length > 0 && this.taskQueue.length > 0) {
      const worker = this.availableWorkers.pop();
      const queued = this.taskQueue.shift();

      if (!worker || !queued) {
        break;
      }

      const { task, resolve } = queued;

      // ペンディングに追加
      this.pendingTasks.set(task.taskId, {
        resolve,
        startTime: Date.now(),
      });

      // ワーカーにタスクを送信
      worker.postMessage({
        type: 'task',
        taskId: task.taskId,
        data: {
          frame1: task.frame1,
          frame2: task.frame2,
          width: task.width,
          height: task.height,
          options: task.options,
        },
      });
    }
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * FrameWorkerPoolインスタンスを作成
 */
export function createFrameWorkerPool(config?: FrameWorkerPoolConfig): FrameWorkerPool {
  return new FrameWorkerPool(config);
}

export default FrameWorkerPool;
