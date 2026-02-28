// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerSupervisor Service テスト
 * TDD Red フェーズ: ワーカープロセス監視・再起動サービスのテスト
 *
 * 目的:
 * - ワーカープロセスの起動（ensureWorkerRunning）
 * - ジョブカウントベースの再起動（N件完了後にワーカーを再起動してOOM回避）
 * - クラッシュ時の自動再起動（exit code別の対応）
 * - graceful shutdown（SIGTERM → SIGKILL エスカレーション）
 *
 * WorkerSupervisorはchild_process.forkで子プロセスとしてワーカーを起動し、
 * page.analyzeのOOM問題（16GBヒープ上限で2-3サイト後にクラッシュ）を
 * プロセス再起動で解決するサービス。
 *
 * @module tests/services/worker-supervisor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

// ============================================================================
// モック設定
// ============================================================================

// child_process.fork をモック
const mockFork = vi.fn();
vi.mock('node:child_process', () => ({
  fork: (...args: unknown[]) => mockFork(...args),
}));

// node:path はそのまま使用（__dirname ベースのパス解決テスト用）
// モック不要: path.resolve は実際の動作を検証する

// logger をモック
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// ============================================================================
// ヘルパー: モック ChildProcess 生成
// ============================================================================

/**
 * テスト用のモック ChildProcess を生成する
 * EventEmitter を継承し、pid/kill/connected をモック
 */
function createMockChildProcess(pid: number = 12345): ChildProcess & EventEmitter {
  const emitter = new EventEmitter();
  const mockProcess = Object.assign(emitter, {
    pid,
    kill: vi.fn().mockReturnValue(true),
    connected: true,
    send: vi.fn().mockReturnValue(true),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    spawnargs: [] as string[],
    spawnfile: '',
    stdio: [null, null, null, null, null] as ChildProcess['stdio'],
    stdin: null,
    stdout: null,
    stderr: null,
    channel: undefined,
    [Symbol.dispose]: vi.fn(),
  }) as unknown as ChildProcess & EventEmitter;

  return mockProcess;
}

// ============================================================================
// 型定義（実装はまだ存在しない）
// ============================================================================

/**
 * WorkerSupervisorの設定オプション
 */
interface WorkerSupervisorOptions {
  /** ワーカースクリプトのパス */
  workerScript: string;
  /** fork時のオプション引数 */
  workerArgs?: string[];
  /** fork時の環境変数（process.env にマージ） */
  workerEnv?: Record<string, string>;
  /** N件完了後にワーカーを再起動する（OOM回避） */
  maxJobsBeforeRestart: number;
  /** クラッシュ時の最大再起動試行回数 */
  maxRestartAttempts: number;
  /** graceful shutdown のタイムアウト（ms）。超過でSIGKILL送信 */
  shutdownTimeoutMs: number;
  /** 再起動間の最小間隔（ms）。連続クラッシュのスロットリング */
  restartDelayMs?: number;
}

/**
 * WorkerSupervisorの状態
 */
type WorkerState = 'idle' | 'running' | 'restarting' | 'stopped' | 'crashed';

/**
 * WorkerSupervisorのインターフェース
 */
interface WorkerSupervisor {
  /** ワーカーが起動していなければ起動する */
  ensureWorkerRunning(): void;
  /** 現在のワーカー状態を取得 */
  getState(): WorkerState;
  /** 完了ジョブカウントを取得 */
  getCompletedJobCount(): number;
  /** 再起動回数を取得 */
  getRestartCount(): number;
  /** ジョブ完了を通知（内部カウンタ更新、必要に応じて再起動） */
  notifyJobCompleted(): void;
  /** graceful shutdown（SIGTERM → タイムアウト → SIGKILL） */
  shutdown(): Promise<void>;
  /** ワーカーの ChildProcess を取得（テスト用） */
  getWorkerProcess(): ChildProcess | null;
}

// ============================================================================
// テストスイート
// ============================================================================

describe('WorkerSupervisor', () => {
  let mockChild: ChildProcess & EventEmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // デフォルトのモック ChildProcess
    mockChild = createMockChildProcess(12345);
    mockFork.mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // ensureWorkerRunning
  // ==========================================================================

  describe('ensureWorkerRunning', () => {
    it('ワーカー未起動時に子プロセスをforkする', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 3,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      // Act
      supervisor.ensureWorkerRunning();

      // Assert
      expect(mockFork).toHaveBeenCalledTimes(1);
      expect(mockFork).toHaveBeenCalledWith(
        './dist/scripts/start-workers.js',
        expect.any(Array),
        expect.objectContaining({
          stdio: expect.any(Array),
          cwd: expect.any(String),
        })
      );
      expect(supervisor.getState()).toBe('running');
    });

    it('既に起動中なら何もしない', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 3,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      // Act: 2回呼び出す
      supervisor.ensureWorkerRunning();
      supervisor.ensureWorkerRunning();

      // Assert: forkは1回のみ
      expect(mockFork).toHaveBeenCalledTimes(1);
      expect(supervisor.getState()).toBe('running');
    });

    it('ワーカーがクラッシュ済みの場合は再起動する', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 3,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      // 最初の起動
      supervisor.ensureWorkerRunning();
      expect(mockFork).toHaveBeenCalledTimes(1);

      // 2回目のforkで新しい ChildProcess を返す
      const newMockChild = createMockChildProcess(12346);
      mockFork.mockReturnValue(newMockChild);

      // ワーカーがクラッシュをシミュレート（exit code 134 = SIGABRT/OOM）
      mockChild.emit('exit', 134, null);

      // 再起動の遅延を消化
      await vi.advanceTimersByTimeAsync(1000);

      // Act: ensureWorkerRunning呼び出し
      supervisor.ensureWorkerRunning();

      // Assert: 自動再起動 or ensureWorkerRunning で再起動される
      // forkが2回以上呼ばれていること（初回 + クラッシュ後の再起動）
      expect(mockFork.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('workerArgsとworkerEnvがforkに渡される', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        workerArgs: ['--page'],
        workerEnv: { NODE_ENV: 'production', WORKER_MEMORY_CRITICAL_MB: '14336' },
        maxJobsBeforeRestart: 3,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      // Act
      supervisor.ensureWorkerRunning();

      // Assert
      expect(mockFork).toHaveBeenCalledWith(
        './dist/scripts/start-workers.js',
        ['--page'],
        expect.objectContaining({
          env: expect.objectContaining({
            NODE_ENV: 'production',
            WORKER_MEMORY_CRITICAL_MB: '14336',
          }),
        })
      );
    });
  });

  // ==========================================================================
  // ジョブカウントベース再起動
  // ==========================================================================

  describe('ジョブカウントベース再起動', () => {
    it('N件完了後にワーカーをrestartする', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 3,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning();
      expect(mockFork).toHaveBeenCalledTimes(1);

      // 再起動後のモック ChildProcess を準備
      const newMockChild = createMockChildProcess(12346);
      mockFork.mockReturnValue(newMockChild);

      // Act: N件のジョブ完了を通知
      supervisor.notifyJobCompleted(); // 1件目
      supervisor.notifyJobCompleted(); // 2件目
      supervisor.notifyJobCompleted(); // 3件目 → 再起動トリガー

      // P1-E: initiateRestart now uses 3-Phase Shutdown Protocol
      // Phase 1: IPC 'shutdown' メッセージが送信される
      expect(mockChild.send).toHaveBeenCalledWith({ type: 'shutdown' });

      // Phase 2: 2秒後にSIGTERMが送信される
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

      // 子プロセスが正常終了をシミュレート
      mockChild.emit('exit', 0, null);

      // 再起動の遅延を消化
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: 新しいワーカーがforkされる
      expect(mockFork.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('N件未満なら再起動しない', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 3,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning();

      // Act: N-1件のジョブ完了を通知
      supervisor.notifyJobCompleted(); // 1件目
      supervisor.notifyJobCompleted(); // 2件目

      // Assert: forkは初回の1回のみ
      expect(mockFork).toHaveBeenCalledTimes(1);
      expect(mockChild.kill).not.toHaveBeenCalled();
      expect(supervisor.getCompletedJobCount()).toBe(2);
    });

    it('restart後にジョブカウントがリセットされる', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 2,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning();

      // 最初の2件でrestart
      const newMockChild = createMockChildProcess(12346);
      mockFork.mockReturnValue(newMockChild);

      supervisor.notifyJobCompleted();
      supervisor.notifyJobCompleted(); // → restart トリガー

      // P1-E: Phase 2のSIGTERMタイマーを消化
      await vi.advanceTimersByTimeAsync(2000);

      // 旧ワーカー終了
      mockChild.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: ジョブカウントがリセットされている
      expect(supervisor.getCompletedJobCount()).toBe(0);
    });
  });

  // ==========================================================================
  // クラッシュ時の自動再起動
  // ==========================================================================

  describe('クラッシュ時の自動再起動', () => {
    it('exit code 134 (OOM/SIGABRT) で自動再起動する', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 10,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning();

      // 新しいモック ChildProcess を準備
      const newMockChild = createMockChildProcess(12346);
      mockFork.mockReturnValue(newMockChild);

      // Act: OOMクラッシュをシミュレート
      mockChild.emit('exit', 134, null);

      // 再起動遅延を消化
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: 自動再起動された
      expect(mockFork.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(supervisor.getRestartCount()).toBe(1);
    });

    it('exit code 0 (graceful) でも再起動する', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 10,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning();

      // 新しいモック ChildProcess を準備
      const newMockChild = createMockChildProcess(12346);
      mockFork.mockReturnValue(newMockChild);

      // Act: graceful exitをシミュレート（ワーカーが自発的にメモリ閾値で終了）
      mockChild.emit('exit', 0, null);

      // 再起動遅延を消化
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: 再起動された（ワーカーは常に復帰すべき）
      expect(mockFork.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('maxRestartAttempts超過で再起動を停止する', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 10,
        maxRestartAttempts: 2, // 最大2回まで再起動
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning(); // 初回起動

      // 1回目のクラッシュ → 再起動
      const child2 = createMockChildProcess(12346);
      mockFork.mockReturnValue(child2);
      mockChild.emit('exit', 134, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(supervisor.getRestartCount()).toBe(1);

      // 2回目のクラッシュ → 再起動
      const child3 = createMockChildProcess(12347);
      mockFork.mockReturnValue(child3);
      child2.emit('exit', 134, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(supervisor.getRestartCount()).toBe(2);

      // 3回目のクラッシュ → 再起動停止
      child3.emit('exit', 134, null);
      await vi.advanceTimersByTimeAsync(1000);

      // Assert: maxRestartAttempts(2)で停止、forkは3回まで（初回 + 2回再起動）
      expect(mockFork).toHaveBeenCalledTimes(3);
      expect(supervisor.getState()).toBe('crashed');
    });

    it('crashed状態からensureWorkerRunningで自動リセットされる', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 10,
        maxRestartAttempts: 2, // 最大2回まで再起動
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning(); // 初回起動

      // 1回目のクラッシュ → 再起動
      const child2 = createMockChildProcess(12346);
      mockFork.mockReturnValue(child2);
      mockChild.emit('exit', 134, null);
      await vi.advanceTimersByTimeAsync(1000);

      // 2回目のクラッシュ → 再起動
      const child3 = createMockChildProcess(12347);
      mockFork.mockReturnValue(child3);
      child2.emit('exit', 134, null);
      await vi.advanceTimersByTimeAsync(1000);

      // 3回目のクラッシュ → crashed状態
      child3.emit('exit', 134, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(supervisor.getState()).toBe('crashed');
      expect(mockFork).toHaveBeenCalledTimes(3);

      // Act: crashed状態で新しいジョブ投入（ensureWorkerRunning呼び出し）
      const child4 = createMockChildProcess(12348);
      mockFork.mockReturnValue(child4);
      supervisor.ensureWorkerRunning();

      // Assert: crashed状態からリセットされ、新しいワーカーが起動
      expect(supervisor.getState()).toBe('running');
      expect(supervisor.getRestartCount()).toBe(0);
      expect(mockFork).toHaveBeenCalledTimes(4);
    });

    it('crashed状態からのリセット後、再びmaxRestartAttemptsまで再起動できる', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 10,
        maxRestartAttempts: 1, // 最大1回まで再起動
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning(); // 初回起動

      // 1回目のクラッシュ → 再起動
      const child2 = createMockChildProcess(12346);
      mockFork.mockReturnValue(child2);
      mockChild.emit('exit', 134, null);
      await vi.advanceTimersByTimeAsync(1000);

      // 2回目のクラッシュ → crashed状態
      child2.emit('exit', 134, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(supervisor.getState()).toBe('crashed');

      // Act: crashed状態からリセット
      const child3 = createMockChildProcess(12347);
      mockFork.mockReturnValue(child3);
      supervisor.ensureWorkerRunning();
      expect(supervisor.getState()).toBe('running');
      expect(supervisor.getRestartCount()).toBe(0);

      // リセット後、再び1回再起動できる
      const child4 = createMockChildProcess(12348);
      mockFork.mockReturnValue(child4);
      child3.emit('exit', 134, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(supervisor.getRestartCount()).toBe(1);

      // もう1回クラッシュ → 再びcrashed
      child4.emit('exit', 134, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(supervisor.getState()).toBe('crashed');
    });

    it('SIGNALによるクラッシュ(SIGKILL)でも自動再起動する', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 10,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning();

      const newMockChild = createMockChildProcess(12346);
      mockFork.mockReturnValue(newMockChild);

      // Act: SIGKILLでクラッシュ（OOMキラーなど）
      mockChild.emit('exit', null, 'SIGKILL');

      await vi.advanceTimersByTimeAsync(1000);

      // Assert: 自動再起動された
      expect(mockFork.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ==========================================================================
  // shutdown
  // ==========================================================================

  describe('shutdown', () => {
    it('graceful shutdownでSIGTERMを送信する', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 10,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 5000,
      });

      supervisor.ensureWorkerRunning();

      // ワーカーがSIGTERM後に正常終了するようにシミュレート
      // Note: setTimeout(0) を使用（setImmediate は fake timer の advanceTimersByTimeAsync で発火しない）
      mockChild.kill = vi.fn().mockImplementation((signal?: string) => {
        if (signal === 'SIGTERM') {
          setTimeout(() => mockChild.emit('exit', 0, null), 0);
        }
        return true;
      });

      // Act
      const shutdownPromise = supervisor.shutdown();
      // Phase 1: IPC 'shutdown' メッセージ送信（即時）
      // Phase 2: 2秒後にSIGTERMを送信（BullMQ close()に時間を与える）
      // → 2500ms進めてSIGTERMタイマーを発火させる
      await vi.advanceTimersByTimeAsync(2500);
      await shutdownPromise;

      // Assert
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(supervisor.getState()).toBe('stopped');
    });

    it('タイムアウト後にSIGKILLを送信する', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 10,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 3000, // 3秒タイムアウト
      });

      supervisor.ensureWorkerRunning();

      // ワーカーがSIGTERMに応答しない（プロセスがハングした状態）
      // SIGKILLで強制終了後にexitイベントが発火するようにモック
      // Note: setTimeout(0) を使用（setImmediate は fake timer の advanceTimersByTimeAsync で発火しない）
      mockChild.kill = vi.fn().mockImplementation((signal?: string) => {
        if (signal === 'SIGKILL') {
          setTimeout(() => mockChild.emit('exit', null, 'SIGKILL'), 0);
        }
        return true;
      });

      // Act
      const shutdownPromise = supervisor.shutdown();

      // タイムアウトまで時間を進める
      await vi.advanceTimersByTimeAsync(3500);
      await shutdownPromise;

      // Assert: SIGTERMの後にSIGKILLが送信される
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('ワーカー未起動時のshutdownはエラーなしで完了する', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 10,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 5000,
      });

      // Act & Assert: エラーなしで完了
      await expect(supervisor.shutdown()).resolves.toBeUndefined();
      expect(supervisor.getState()).toBe('stopped');
    });

    it('shutdown後はクラッシュによる自動再起動が抑制される', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 10,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 5000,
      });

      supervisor.ensureWorkerRunning();

      // SIGTERMでgraceful exit
      // Note: setTimeout(0) を使用（setImmediate は fake timer の advanceTimersByTimeAsync で発火しない）
      mockChild.kill = vi.fn().mockImplementation((signal?: string) => {
        if (signal === 'SIGTERM') {
          setTimeout(() => mockChild.emit('exit', 0, null), 0);
        }
        return true;
      });

      // Act: shutdownを実行
      const shutdownPromise = supervisor.shutdown();
      // Phase 2: 2秒後にSIGTERMを送信するため、2500ms進める
      await vi.advanceTimersByTimeAsync(2500);
      await shutdownPromise;

      // Assert: shutdown後はexitイベントで再起動されない
      expect(mockFork).toHaveBeenCalledTimes(1); // 初回起動のみ
      expect(supervisor.getState()).toBe('stopped');
    });
  });

  // ==========================================================================
  // 状態管理
  // ==========================================================================

  describe('状態管理', () => {
    it('初期状態はidleである', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 3,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      // Assert
      expect(supervisor.getState()).toBe('idle');
      expect(supervisor.getCompletedJobCount()).toBe(0);
      expect(supervisor.getRestartCount()).toBe(0);
      expect(supervisor.getWorkerProcess()).toBeNull();
    });

    it('ensureWorkerRunning後はrunning状態になる', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 3,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      // Act
      supervisor.ensureWorkerRunning();

      // Assert
      expect(supervisor.getState()).toBe('running');
      expect(supervisor.getWorkerProcess()).not.toBeNull();
    });
  });

  // ==========================================================================
  // getWorkerSupervisor シングルトン
  // ==========================================================================

  describe('getWorkerSupervisor', () => {
    it('シングルトンインスタンスを返す', async () => {
      // Arrange
      const { getWorkerSupervisor, resetWorkerSupervisor } = await import('../../src/services/worker-supervisor.service');
      resetWorkerSupervisor();

      // Act
      const supervisor1 = getWorkerSupervisor();
      const supervisor2 = getWorkerSupervisor();

      // Assert: 同一インスタンスが返される
      expect(supervisor1).toBe(supervisor2);

      // Cleanup
      resetWorkerSupervisor();
    });

    it('デフォルトのワーカースクリプトパスがstart-workers.jsを指す', async () => {
      // Arrange
      const { getWorkerSupervisor, resetWorkerSupervisor } = await import('../../src/services/worker-supervisor.service');
      resetWorkerSupervisor();

      // WORKER_SCRIPT_PATHが未設定の状態でシングルトンを取得
      const originalWorkerScriptPath = process.env.WORKER_SCRIPT_PATH;
      delete process.env.WORKER_SCRIPT_PATH;

      // Act
      const supervisor = getWorkerSupervisor();
      supervisor.ensureWorkerRunning();

      // Assert: forkされたスクリプトパスが start-workers.js を含む
      expect(mockFork).toHaveBeenCalledTimes(1);
      const calledScript = mockFork.mock.calls[0][0] as string;
      expect(calledScript).toContain('start-workers.js');
      expect(calledScript).not.toContain('page-analyze-worker.js');

      // Assert: --page 引数が渡される
      const calledArgs = mockFork.mock.calls[0][1] as string[];
      expect(calledArgs).toContain('--page');

      // Cleanup
      if (originalWorkerScriptPath !== undefined) {
        process.env.WORKER_SCRIPT_PATH = originalWorkerScriptPath;
      }
      resetWorkerSupervisor();
    });

    it('resetWorkerSupervisor後は新しいインスタンスが作成される', async () => {
      // Arrange
      const { getWorkerSupervisor, resetWorkerSupervisor } = await import('../../src/services/worker-supervisor.service');
      resetWorkerSupervisor();

      // Act
      const supervisor1 = getWorkerSupervisor();
      resetWorkerSupervisor();
      const supervisor2 = getWorkerSupervisor();

      // Assert: 異なるインスタンス
      expect(supervisor1).not.toBe(supervisor2);

      // Cleanup
      resetWorkerSupervisor();
    });
  });

  // ==========================================================================
  // stopped状態からの再起動防止
  // ==========================================================================

  describe('stopped状態', () => {
    it('stopped状態ではensureWorkerRunningが何もしない', async () => {
      // Arrange
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 3,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      // shutdown で stopped 状態にする
      await supervisor.shutdown();
      expect(supervisor.getState()).toBe('stopped');

      // Act: stopped 状態で ensureWorkerRunning を呼ぶ
      supervisor.ensureWorkerRunning();

      // Assert: fork は呼ばれない
      expect(mockFork).not.toHaveBeenCalled();
      expect(supervisor.getState()).toBe('stopped');
    });
  });
});
