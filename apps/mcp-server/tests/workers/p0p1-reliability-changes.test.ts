// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * v0.1.0 Worker Reliability 全変更のテスト
 *
 * テスト対象:
 * - P0-A: PIPELINE_RECYCLE_THRESHOLD 10→30（既存テスト確認含む）
 * - P0-B: lockDuration 40分 + STALL_MARGIN_MS 4分 + ORPHAN_THRESHOLD_MS 120分 + 定数整合性
 * - P0-C: Section Embedding バッチ推論（generateBatchFromTexts、フォールバック）
 * - P1-D: Worker→Supervisor IPC通知（process.send, notifyJobCompleted, maxJobs再起動）
 * - P1-E: initiateRestart 3-Phase Shutdown（IPC→SIGTERM→SIGKILL順序）
 * - P1-F: setImmediate yield points（5箇所のイベントループ解放）
 *
 * @module tests/workers/sprint1-p0p1-changes
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// ============================================================================
// モック設定（vi.mock はモジュールスコープに巻き上げられるため、ここで定義）
// ============================================================================

const mockFork = vi.fn();
vi.mock('node:child_process', () => ({
  fork: (...args: unknown[]) => mockFork(...args),
}));

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
// ヘルパー: ソースコードパス
// ============================================================================

const WORKER_SOURCE_PATH = path.resolve(
  __dirname, '../../src/workers/page-analyze-worker.ts'
);
const ML_SERVICE_PATH = path.resolve(
  __dirname, '../../../../packages/ml/src/embeddings/service.ts'
);
const SUPERVISOR_PATH = path.resolve(
  __dirname, '../../src/services/worker-supervisor.service.ts'
);
const EMBEDDING_HANDLER_PATH = path.resolve(
  __dirname, '../../src/tools/page/handlers/embedding-handler.ts'
);
const LAYOUT_EMBEDDING_PATH = path.resolve(
  __dirname, '../../src/services/layout-embedding.service.ts'
);
const WORKER_CONSTANTS_PATH = path.resolve(
  __dirname, '../../src/services/worker-constants.ts'
);
const QUEUE_CLEANUP_PATH = path.resolve(
  __dirname, '../../src/services/queue-cleanup.service.ts'
);

// ============================================================================
// ヘルパー: ソースから定数値を抽出
// ============================================================================

/**
 * ソースファイルから `const NAME = VALUE` 形式の数値定数を抽出
 */
function extractNumericConstant(source: string, name: string): number | null {
  // `const NAME = 2_400_000` or `const NAME = 30` パターンに対応
  const regex = new RegExp(`(?:const|export const)\\s+${name}\\s*=\\s*([\\d_]+)`);
  const match = source.match(regex);
  if (!match || !match[1]) return null;
  // アンダースコアセパレータを除去
  return parseInt(match[1].replace(/_/g, ''), 10);
}

/**
 * ソースファイルから safeParseInt(env, defaultValue) のデフォルト値を抽出
 */
function extractSafeParseIntDefault(source: string, constName: string): number | null {
  // `const NAME = safeParseInt(process.env.XXX, 2400000, ...)` パターン
  const regex = new RegExp(`${constName}\\s*=\\s*safeParseInt\\([^,]+,\\s*([\\d_]+)`);
  const match = source.match(regex);
  if (!match || !match[1]) return null;
  return parseInt(match[1].replace(/_/g, ''), 10);
}

// ============================================================================
// ヘルパー: モック ChildProcess 生成
// ============================================================================

function createMockChildProcess(pid: number = 12345): ChildProcess & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
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
}

// ============================================================================
// P0-A: PIPELINE_RECYCLE_THRESHOLD 定数テスト
// ============================================================================

describe('P0-A: PIPELINE_RECYCLE_THRESHOLD = 30', () => {
  let mlServiceSource: string;
  let workerSource: string;

  beforeAll(() => {
    mlServiceSource = fs.readFileSync(ML_SERVICE_PATH, 'utf8');
    workerSource = fs.readFileSync(WORKER_SOURCE_PATH, 'utf8');
  });

  it('DEFAULT_PIPELINE_RECYCLE_THRESHOLD が 30 であること（インポート検証）', async () => {
    const { DEFAULT_PIPELINE_RECYCLE_THRESHOLD } = await import(
      '../../../../packages/ml/src/embeddings/service'
    );
    expect(DEFAULT_PIPELINE_RECYCLE_THRESHOLD).toBe(30);
  });

  it('EMBEDDING_CHUNK_SIZE 以上であること（チャンクあたり最大1回のrecycle）', async () => {
    // EMBEDDING_CHUNK_SIZE は resolveMemoryConfig() から動的に取得される。
    // 32GBマシンではチャンク=30でrecycle=30（一致）。
    // 小メモリマシンではチャンク<30だが、recycle=30のまま（recycle頻度が下がるだけで安全）。
    const { DEFAULT_PIPELINE_RECYCLE_THRESHOLD } = await import(
      '../../../../packages/ml/src/embeddings/service'
    );
    const { resolveMemoryConfig } = await import('../../src/services/worker-memory-profile');
    const memoryConfig = resolveMemoryConfig();
    expect(DEFAULT_PIPELINE_RECYCLE_THRESHOLD).not.toBeNull();
    expect(memoryConfig.embeddingChunkSize).not.toBeNull();
    // recycle threshold >= chunk size → チャンクあたり最大1回のrecycle（過剰なrecycleを防止）
    expect(DEFAULT_PIPELINE_RECYCLE_THRESHOLD).toBeGreaterThanOrEqual(memoryConfig.embeddingChunkSize);
  });
});

// ============================================================================
// P0-B: lockDuration 40分 + 関連定数テスト
// ============================================================================

describe('P0-B: lockDuration 40分 + 関連定数', () => {
  let workerSource: string;
  let constantsSource: string;
  let cleanupSource: string;

  beforeAll(() => {
    workerSource = fs.readFileSync(WORKER_SOURCE_PATH, 'utf8');
    constantsSource = fs.readFileSync(WORKER_CONSTANTS_PATH, 'utf8');
    cleanupSource = fs.readFileSync(QUEUE_CLEANUP_PATH, 'utf8');
  });

  describe('定数値の検証', () => {
    it('DEFAULT_LOCK_DURATION が 2,400,000ms (40分) であること', () => {
      // safeParseInt(process.env.BULLMQ_LOCK_DURATION, 2400000, ...) のデフォルト値
      const lockDuration = extractSafeParseIntDefault(workerSource, 'DEFAULT_LOCK_DURATION');
      expect(lockDuration).toBe(2_400_000);
    });

    it('STALL_MARGIN_MS が 240,000ms (4分) であること', () => {
      const stallMargin = extractNumericConstant(constantsSource, 'STALL_MARGIN_MS');
      expect(stallMargin).toBe(240_000);
    });

    it('ORPHAN_THRESHOLD_MS が 7,200,000ms (120分) であること', () => {
      const orphanThreshold = extractNumericConstant(cleanupSource, 'ORPHAN_THRESHOLD_MS');
      expect(orphanThreshold).toBe(7_200_000);
    });
  });

  describe('定数間の整合性', () => {
    it('ORPHAN_THRESHOLD_MS = lockDuration x 3 であること', () => {
      const lockDuration = extractSafeParseIntDefault(workerSource, 'DEFAULT_LOCK_DURATION');
      const orphanThreshold = extractNumericConstant(cleanupSource, 'ORPHAN_THRESHOLD_MS');
      expect(lockDuration).not.toBeNull();
      expect(orphanThreshold).not.toBeNull();
      // lockDuration(40分=2,400,000) x 3 = 120分=7,200,000 = ORPHAN_THRESHOLD_MS
      expect(orphanThreshold).toBe(lockDuration! * 3);
    });

    it('STALL_MARGIN_MS = lockDuration / 10 であること', () => {
      const lockDuration = extractSafeParseIntDefault(workerSource, 'DEFAULT_LOCK_DURATION');
      const stallMargin = extractNumericConstant(constantsSource, 'STALL_MARGIN_MS');
      expect(lockDuration).not.toBeNull();
      expect(stallMargin).not.toBeNull();
      // lockDuration(2,400,000) / 10 = 240,000 = STALL_MARGIN_MS
      expect(stallMargin).toBe(lockDuration! / 10);
    });

    it('stalledInterval = max(60000, lockDuration/4) であること（ソース構造検証）', () => {
      // BullMQ Worker 初期化時に stalledInterval が設定されていること
      expect(workerSource).toContain('stalledInterval: Math.max(60000, Math.floor(lockDuration / 4))');
    });

    it('maxStalledCount が 3 であること（ソース構造検証）', () => {
      expect(workerSource).toContain('maxStalledCount: 3');
    });

    it('DB_SAVED_PROGRESS_THRESHOLD が 90 であること', () => {
      const threshold = extractNumericConstant(constantsSource, 'DB_SAVED_PROGRESS_THRESHOLD');
      expect(threshold).toBe(90);
    });
  });
});

// ============================================================================
// P0-C: Section Embedding バッチ推論テスト
// ============================================================================

describe('P0-C: Section Embedding バッチ推論', () => {
  let layoutEmbeddingSource: string;
  let handlerSource: string;

  beforeAll(() => {
    layoutEmbeddingSource = fs.readFileSync(LAYOUT_EMBEDDING_PATH, 'utf8');
    handlerSource = fs.readFileSync(EMBEDDING_HANDLER_PATH, 'utf8');
  });

  describe('generateBatchFromTexts メソッドの構造検証', () => {
    it('LayoutEmbeddingService に generateBatchFromTexts メソッドが存在すること', () => {
      expect(layoutEmbeddingSource).toContain('async generateBatchFromTexts(texts: string[]): Promise<LayoutEmbeddingResult[]>');
    });

    it('generateBatchFromTexts が EmbeddingService.generateBatchEmbeddings を呼ぶこと', () => {
      // バッチ推論で内部的にgenerateBatchEmbeddingsを使用していること
      const batchMethod = layoutEmbeddingSource.slice(
        layoutEmbeddingSource.indexOf('async generateBatchFromTexts')
      );
      expect(batchMethod).toContain('service.generateBatchEmbeddings(uncachedTexts');
    });

    it('空配列に対して空配列を返すこと', () => {
      const batchMethod = layoutEmbeddingSource.slice(
        layoutEmbeddingSource.indexOf('async generateBatchFromTexts')
      );
      // 空配列の早期リターンが存在すること
      expect(batchMethod).toContain('if (texts.length === 0)');
      expect(batchMethod).toContain('return []');
    });
  });

  describe('embedding-handler バッチ推論統合', () => {
    it('generateSectionEmbeddings がバッチ推論を使用すること', () => {
      // Phase 2: バッチ推論の呼び出しが存在すること
      expect(handlerSource).toContain('embeddingService.generateBatchFromTexts(allTexts)');
    });

    it('バッチ推論失敗時に個別フォールバックが動作すること', () => {
      // バッチ失敗 → batchEmbeddings = [] → 後続ループで individualResult に切り替え
      expect(handlerSource).toContain('Batch embedding failed, falling back to individual');
      expect(handlerSource).toContain('batchEmbeddings = []');
    });

    it('フォールバック時は generateFromText で個別生成すること', () => {
      // 個別フォールバック: batchResult が無い場合に generateFromText を呼ぶ
      expect(handlerSource).toContain('embeddingService.generateFromText(textRepresentation)');
    });

    it('DI用 layoutEmbeddingService オプションが GenerateSectionEmbeddingsOptions に存在すること', () => {
      expect(handlerSource).toContain('layoutEmbeddingService?: LayoutEmbeddingService | undefined');
    });
  });

  describe('generateBatchFromTexts キャッシュ統合', () => {
    it('キャッシュhit分をスキップして未キャッシュ分のみバッチ推論すること', () => {
      const batchMethod = layoutEmbeddingSource.slice(
        layoutEmbeddingSource.indexOf('async generateBatchFromTexts')
      );
      // uncachedIndices / uncachedTexts でキャッシュミス分を収集
      expect(batchMethod).toContain('uncachedIndices');
      expect(batchMethod).toContain('uncachedTexts');
    });

    it('バッチ推論結果をキャッシュに保存すること', () => {
      const batchMethod = layoutEmbeddingSource.slice(
        layoutEmbeddingSource.indexOf('async generateBatchFromTexts')
      );
      // キャッシュ保存（fire-and-forget）
      expect(batchMethod).toContain('embeddingCache.set(cacheKey, cacheEntry)');
    });

    it('結果がフィルタリングされて undefined を除外すること', () => {
      const batchMethod = layoutEmbeddingSource.slice(
        layoutEmbeddingSource.indexOf('async generateBatchFromTexts')
      );
      // undefined フィルタリング
      expect(batchMethod).toContain('filter((r): r is LayoutEmbeddingResult => r !== undefined)');
    });
  });
});

// ============================================================================
// P1-D: Worker→Supervisor IPC通知テスト
// ============================================================================

describe('P1-D: notifyJobCompleted IPC通知', () => {
  describe('Worker側 process.send 呼び出し（ソース構造検証）', () => {
    let workerSource: string;

    beforeAll(() => {
      workerSource = fs.readFileSync(WORKER_SOURCE_PATH, 'utf8');
    });

    it('Worker completed イベントで process.send({ type: "job-completed" }) を送信すること', () => {
      // BullMQ Worker.on('completed') ハンドラー内で IPC メッセージを送信
      expect(workerSource).toContain("process.send?.({ type: 'job-completed', jobId: job.id })");
    });

    it('IPC送信が try-catch で保護されていること', () => {
      // P1-D: IPC channel closed 時の非致命的エラーハンドリング
      const completedHandler = workerSource.slice(
        workerSource.indexOf("worker.on('completed'"),
        workerSource.indexOf("worker.on('failed'")
      );
      expect(completedHandler).toContain('try');
      expect(completedHandler).toContain('catch');
      expect(completedHandler).toContain('IPC channel may be closed');
    });

    it('P1-D コメントが存在すること', () => {
      expect(workerSource).toContain('P1-D: Notify parent process (WorkerSupervisor) of job completion via IPC');
    });
  });

  describe('Supervisor側 IPC受信とnotifyJobCompleted（ソース構造検証）', () => {
    let supervisorSource: string;

    beforeAll(() => {
      supervisorSource = fs.readFileSync(SUPERVISOR_PATH, 'utf8');
    });

    it('WorkerSupervisor が child.on("message") で job-completed を受信し notifyJobCompleted を呼ぶこと', () => {
      // P1-D: IPC message handler
      expect(supervisorSource).toContain("child.on('message'");
      expect(supervisorSource).toContain("msg.type === 'job-completed'");
      expect(supervisorSource).toContain('this.notifyJobCompleted()');
    });

    it('WorkerMessage 型が定義されていること', () => {
      expect(supervisorSource).toContain('export interface WorkerMessage');
      expect(supervisorSource).toContain("type: 'job-completed'");
    });
  });

  describe('Supervisor側 IPC動作検証（モック）', () => {
    let mockChild: ChildProcess & EventEmitter;

    beforeEach(() => {
      vi.clearAllMocks();
      vi.useFakeTimers();
      mockChild = createMockChildProcess(12345);
      mockFork.mockReturnValue(mockChild);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('IPC経由でmaxJobsBeforeRestart到達時に再起動がトリガーされること', async () => {
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 2, // 2件で再起動
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning();
      expect(supervisor.getState()).toBe('running');

      // IPC経由でjob-completedを2回送信
      // spawnWorkerのchild.on('message')ハンドラーが呼ばれる
      mockChild.emit('message', { type: 'job-completed', jobId: 'job-1' });
      expect(supervisor.getCompletedJobCount()).toBe(1);

      mockChild.emit('message', { type: 'job-completed', jobId: 'job-2' });
      expect(supervisor.getCompletedJobCount()).toBe(2);

      // 2件到達 → initiateRestart がトリガーされ、state が restarting に遷移
      expect(supervisor.getState()).toBe('restarting');
    });

    it('不正なIPCメッセージは無視されること', async () => {
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 10,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning();

      // 不正なメッセージ型
      mockChild.emit('message', { type: 'unknown-type' });
      mockChild.emit('message', 'string-message');
      mockChild.emit('message', null);
      mockChild.emit('message', { noType: true });

      // いずれもカウンタに影響しない
      expect(supervisor.getCompletedJobCount()).toBe(0);
    });

    it('notifyJobCompleted が正しくカウンタをインクリメントすること', async () => {
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 5,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning();

      // 3件通知
      supervisor.notifyJobCompleted();
      supervisor.notifyJobCompleted();
      supervisor.notifyJobCompleted();

      expect(supervisor.getCompletedJobCount()).toBe(3);
      // まだ5件に達していないのでrunningのまま
      expect(supervisor.getState()).toBe('running');
    });
  });
});

// ============================================================================
// P1-E: initiateRestart 3-Phase Shutdown テスト
// ============================================================================

describe('P1-E: initiateRestart 3-Phase Shutdown', () => {
  describe('ソース構造検証', () => {
    let supervisorSource: string;

    beforeAll(() => {
      supervisorSource = fs.readFileSync(SUPERVISOR_PATH, 'utf8');
    });

    it('initiateRestart が private メソッドとして存在すること', () => {
      expect(supervisorSource).toContain('private initiateRestart(reason: string): void');
    });

    it('IPC_SHUTDOWN_GRACE_MS が 2000ms であること', () => {
      expect(supervisorSource).toContain('const IPC_SHUTDOWN_GRACE_MS = 2000');
    });

    it('Phase 1: IPC shutdown メッセージを送信すること', () => {
      // initiateRestart 内で workerToRestart.send({ type: 'shutdown' }) を呼ぶ
      const restartMethod = supervisorSource.slice(
        supervisorSource.indexOf('private initiateRestart'),
        supervisorSource.indexOf('private scheduleRestart')
      );
      expect(restartMethod).toContain("workerToRestart.send({ type: 'shutdown' })");
    });

    it('Phase 2: IPC_SHUTDOWN_GRACE_MS 後に SIGTERM を送信すること', () => {
      const restartMethod = supervisorSource.slice(
        supervisorSource.indexOf('private initiateRestart'),
        supervisorSource.indexOf('private scheduleRestart')
      );
      expect(restartMethod).toContain("workerToRestart.kill('SIGTERM')");
      expect(restartMethod).toContain('IPC_SHUTDOWN_GRACE_MS');
    });

    it('Phase 3: タイムアウト後に SIGKILL エスカレーションすること', () => {
      const restartMethod = supervisorSource.slice(
        supervisorSource.indexOf('private initiateRestart'),
        supervisorSource.indexOf('private scheduleRestart')
      );
      expect(restartMethod).toContain("workerToRestart.kill('SIGKILL')");
      expect(restartMethod).toContain('this.config.shutdownTimeoutMs');
    });

    it('exit イベントでタイマーがクリアされること', () => {
      const restartMethod = supervisorSource.slice(
        supervisorSource.indexOf('private initiateRestart'),
        supervisorSource.indexOf('private scheduleRestart')
      );
      expect(restartMethod).toContain('clearTimeout(sigTermTimerId)');
      expect(restartMethod).toContain('clearTimeout(killTimerId)');
    });
  });

  describe('shutdown() も同じ3-Phase Protocolを使用すること', () => {
    let supervisorSource: string;

    beforeAll(() => {
      supervisorSource = fs.readFileSync(SUPERVISOR_PATH, 'utf8');
    });

    it('shutdown() で IPC shutdown メッセージを送信すること', () => {
      const shutdownMethod = supervisorSource.slice(
        supervisorSource.indexOf('async shutdown(): Promise<void>'),
        supervisorSource.indexOf('getWorkerProcess')
      );
      expect(shutdownMethod).toContain("workerToKill.send({ type: 'shutdown' })");
    });

    it('shutdown() で Phase 2 SIGTERM を 2秒後に送信すること', () => {
      const shutdownMethod = supervisorSource.slice(
        supervisorSource.indexOf('async shutdown(): Promise<void>'),
        supervisorSource.indexOf('getWorkerProcess')
      );
      expect(shutdownMethod).toContain("workerToKill.kill('SIGTERM')");
      expect(shutdownMethod).toContain('2000');
    });
  });

  describe('3-Phase Shutdown 動作検証（モック）', () => {
    let mockChild: ChildProcess & EventEmitter;

    beforeEach(() => {
      vi.clearAllMocks();
      vi.useFakeTimers();
      mockChild = createMockChildProcess(12345);
      mockFork.mockReturnValue(mockChild);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('notifyJobCompleted N件到達で IPC→SIGTERM 順序でシャットダウンすること', async () => {
      const { WorkerSupervisor } = await import('../../src/services/worker-supervisor.service');

      const supervisor = new WorkerSupervisor({
        workerScript: './dist/scripts/start-workers.js',
        maxJobsBeforeRestart: 3,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning();

      // 新しいワーカーを準備
      const newMockChild = createMockChildProcess(12346);
      mockFork.mockReturnValue(newMockChild);

      // 3件完了 → initiateRestart
      supervisor.notifyJobCompleted();
      supervisor.notifyJobCompleted();
      supervisor.notifyJobCompleted();

      // Phase 1: IPC shutdown メッセージが即座に送信
      expect(mockChild.send).toHaveBeenCalledWith({ type: 'shutdown' });

      // Phase 2: 2秒後にSIGTERM
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

      // 子プロセス終了をシミュレート
      mockChild.emit('exit', 0, null);

      // 再起動遅延を消化
      await vi.advanceTimersByTimeAsync(1000);

      // 新しいワーカーがforkされる
      expect(mockFork.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ============================================================================
// P1-F: setImmediate yield points テスト
// ============================================================================

describe('P1-F: setImmediate yield points', () => {
  describe('page-analyze-worker.ts のyield points', () => {
    let workerSource: string;

    beforeAll(() => {
      workerSource = fs.readFileSync(WORKER_SOURCE_PATH, 'utf8');
    });

    it('Embedding Phase 内に setImmediate yield point が5箇所以上存在すること', () => {
      const embeddingPhaseStart = workerSource.indexOf('async function processEmbeddingPhase');
      expect(embeddingPhaseStart).toBeGreaterThan(-1);

      const embeddingPhaseBody = workerSource.slice(embeddingPhaseStart);
      // setImmediate yield の標準パターン
      const yieldPattern = /await new Promise<void>\(resolve => setImmediate\(resolve\)\)/g;
      const matches = embeddingPhaseBody.match(yieldPattern);

      // Section, Motion, Vision-Motion, Background, JSAnimation の各チャンク間 = 5箇所
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(5);
    });

    it('Section チャンク間に setImmediate yield point があること', () => {
      const embeddingPhaseStart = workerSource.indexOf('async function processEmbeddingPhase');
      const body = workerSource.slice(embeddingPhaseStart, embeddingPhaseStart + 10000);

      const sectionChunkSection = body.slice(
        body.indexOf('let sectionChunkSize'),
        body.indexOf('// ONNX session dispose: Section embedding')
      );
      expect(sectionChunkSection).toContain('setImmediate(resolve)');
    });

    it('Motion チャンク間に setImmediate yield point があること', () => {
      const embeddingPhaseStart = workerSource.indexOf('async function processEmbeddingPhase');
      const body = workerSource.slice(embeddingPhaseStart, embeddingPhaseStart + 20000);

      const motionSection = body.slice(
        body.indexOf('let motionChunkSize'),
        body.indexOf('// 2.5. Vision-detected')
      );
      expect(motionSection).toContain('setImmediate(resolve)');
    });

    it('Vision-Motion チャンク間に setImmediate yield point があること', () => {
      const embeddingPhaseStart = workerSource.indexOf('async function processEmbeddingPhase');
      const body = workerSource.slice(embeddingPhaseStart, embeddingPhaseStart + 25000);

      const visionSection = body.slice(
        body.indexOf('let visionChunkSize')
      );
      expect(visionSection).toContain('setImmediate(resolve)');
    });

    it('Background チャンク間に setImmediate yield point があること', () => {
      const embeddingPhaseStart = workerSource.indexOf('async function processEmbeddingPhase');
      const body = workerSource.slice(embeddingPhaseStart, embeddingPhaseStart + 30000);

      const bgSection = body.slice(
        body.indexOf('let bgChunkSize'),
        body.indexOf('// ONNX session dispose: Background embedding')
      );
      expect(bgSection).toContain('setImmediate(resolve)');
    });

    it('JSAnimation チャンク間に setImmediate yield point があること', () => {
      const embeddingPhaseStart = workerSource.indexOf('async function processEmbeddingPhase');
      const body = workerSource.slice(embeddingPhaseStart);

      const jsSection = body.slice(
        body.indexOf('// 4. JSAnimationEmbedding')
      );
      expect(jsSection).toContain('setImmediate(resolve)');
    });

    it('yield point にコメント説明があること', () => {
      // 各yield pointに目的を説明するコメントが付いていること
      const embeddingPhaseStart = workerSource.indexOf('async function processEmbeddingPhase');
      const body = workerSource.slice(embeddingPhaseStart);

      // BullMQ heartbeats と IPC のためのyieldであることが記述されていること
      expect(body).toContain('Yield to event loop');
    });
  });

  describe('EmbeddingService.generateBatchInProcess のyield point', () => {
    let mlServiceSource: string;

    beforeAll(() => {
      mlServiceSource = fs.readFileSync(ML_SERVICE_PATH, 'utf8');
    });

    it('バッチ間に setImmediate yield point があること', () => {
      const batchMethod = mlServiceSource.slice(
        mlServiceSource.indexOf('generateBatchInProcess')
      );
      expect(batchMethod).toContain('setImmediate(resolve)');
    });

    it('yield point が最終バッチ以外にのみ実行されること', () => {
      const batchMethod = mlServiceSource.slice(
        mlServiceSource.indexOf('generateBatchInProcess')
      );
      // 最終バッチをスキップする条件
      expect(batchMethod).toContain('batchEnd < prefixedTexts.length');
    });
  });
});

// ============================================================================
// 統合整合性テスト: 全定数のクロスチェック
// ============================================================================

describe('v0.1.0 Worker Reliability Integration', () => {
  let workerSource: string;
  let supervisorSource: string;

  beforeAll(() => {
    workerSource = fs.readFileSync(WORKER_SOURCE_PATH, 'utf8');
    supervisorSource = fs.readFileSync(SUPERVISOR_PATH, 'utf8');
  });

  it('lockDuration(40分) は Embedding Phase のタイムアウトに十分であること', () => {
    const lockDuration = extractSafeParseIntDefault(workerSource, 'DEFAULT_LOCK_DURATION');
    expect(lockDuration).not.toBeNull();
    // 40分 = 2,400,000ms > Embedding Phase 想定最大時間(~20分)
    expect(lockDuration!).toBeGreaterThanOrEqual(2_400_000);
  });

  it('Worker側 process.send の type と Supervisor側の型定義が一致すること', () => {
    // Worker側: 'job-completed'
    expect(workerSource).toContain("type: 'job-completed'");
    // Supervisor側: WorkerMessage.type = 'job-completed'
    expect(supervisorSource).toContain("type: 'job-completed'");
  });

  it('initiateRestart と shutdown が同じ IPC→SIGTERM→SIGKILL パターンを使用すること', () => {
    // initiateRestart
    const restartMethod = supervisorSource.slice(
      supervisorSource.indexOf('private initiateRestart'),
      supervisorSource.indexOf('private scheduleRestart')
    );

    // shutdown
    const shutdownMethod = supervisorSource.slice(
      supervisorSource.indexOf('async shutdown(): Promise<void>'),
      supervisorSource.indexOf('getWorkerProcess')
    );

    // 両方とも3つのフェーズを含む
    for (const method of [restartMethod, shutdownMethod]) {
      expect(method).toContain("send({ type: 'shutdown' })");
      expect(method).toContain("kill('SIGTERM')");
      expect(method).toContain("kill('SIGKILL')");
    }
  });

  it('sharedLayoutEmbeddingService がワーカー起動時にシングルトンとして初期化されること', () => {
    // P0-1: 全 Embedding サブフェーズでシングルトンを共有
    expect(workerSource).toContain('const sharedLayoutEmbeddingService = new LayoutEmbeddingService()');
    expect(workerSource).toContain('setBackgroundEmbeddingServiceFactory(() => sharedLayoutEmbeddingService)');
    expect(workerSource).toContain('setMotionLayoutEmbeddingServiceFactory(() => sharedLayoutEmbeddingService)');
  });
});
