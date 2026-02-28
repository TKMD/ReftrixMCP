// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * v0.1.0 Worker Thread 全変更のテスト
 *
 * テスト対象:
 * - P2-G: ONNX Worker Thread化
 *   - WorkerRequest/WorkerResponse型定義の構造検証
 *   - Worker Threadモード検出（VITEST環境でin-processフォールバック）
 *   - requestIdベース非同期通信
 *   - crash recovery（max 5回自動再起動）
 *   - タイムアウト（WORKER_RESPONSE_TIMEOUT_MS = 120,000ms）
 *   - terminate()の正常終了
 *
 * - P2-H: GPU推論サポート
 *   - detectExecutionProvider()のデフォルトCPU
 *   - ONNX_EXECUTION_PROVIDER=cuda + CUDAプロバイダ未検出 → CPUフォールバック
 *   - ONNX_EXECUTION_PROVIDER=cuda + CUDAプロバイダ利用可能 → CUDA使用
 *   - libonnxruntime_providers_cuda.soファイル存在チェック
 *   - docker-compose.ymlにGPUサービス設定
 *
 * @module tests/sprint2-worker-thread-gpu
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// ヘルパー: ソースコードパス解決
// ============================================================================

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = path.dirname(__filename_local);

/** Worker Thread型定義ソースコード */
const WORKER_THREAD_TYPES_PATH = path.resolve(
  __dirname_local, '../src/embeddings/worker-thread-types.ts'
);

/** Worker Threadスクリプトソースコード */
const WORKER_THREAD_PATH = path.resolve(
  __dirname_local, '../src/embeddings/worker-thread.ts'
);

/** EmbeddingServiceソースコード */
const SERVICE_PATH = path.resolve(
  __dirname_local, '../src/embeddings/service.ts'
);

/** package.json */
const PACKAGE_JSON_PATH = path.resolve(
  __dirname_local, '../package.json'
);

/** docker-compose.yml */
const DOCKER_COMPOSE_PATH = path.resolve(
  __dirname_local, '../../../docker/docker-compose.yml'
);

/** .env.example (root) */
const ROOT_ENV_EXAMPLE_PATH = path.resolve(
  __dirname_local, '../../../.env.example'
);

/** .env.example (mcp-server) */
const MCP_ENV_EXAMPLE_PATH = path.resolve(
  __dirname_local, '../../../apps/mcp-server/.env.example'
);

// ============================================================================
// ヘルパー: ソースコード読み込み
// ============================================================================

function readSource(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * ソースコードから数値定数を抽出する
 * 例: `const MAX_WORKER_RESTARTS = 5;` → 5
 */
function extractNumericConstant(source: string, name: string): number | null {
  // アンダースコア区切りの数値リテラルにも対応 (例: 120_000)
  const pattern = new RegExp(
    `(?:const|let|var)\\s+${name}\\s*=\\s*([\\d_]+)`,
  );
  const match = source.match(pattern);
  if (match?.[1]) {
    return parseInt(match[1].replace(/_/g, ''), 10);
  }
  return null;
}

/**
 * ソースコードから文字列定数を抽出する
 * 例: `const FOO = 'bar';` → 'bar'
 */
function extractStringConstant(source: string, name: string): string | null {
  const pattern = new RegExp(
    `(?:const|let|var)\\s+${name}\\s*=\\s*['"\`]([^'"\`]*)['"\`]`,
  );
  const match = source.match(pattern);
  return match?.[1] ?? null;
}

// ============================================================================
// P2-G: ONNX Worker Thread化
// ============================================================================

describe('P2-G: ONNX Worker Thread化', () => {

  // --------------------------------------------------------------------------
  // 1. Worker Thread型定義テスト
  // --------------------------------------------------------------------------
  describe('WorkerRequest/WorkerResponse型定義の構造検証', () => {
    let typesSource: string;

    beforeEach(() => {
      typesSource = readSource(WORKER_THREAD_TYPES_PATH);
    });

    it('WorkerMessage union型に5つのメッセージタイプが含まれること', () => {
      // init, generate, generateBatch, dispose, terminate
      expect(typesSource).toContain('WorkerInitMessage');
      expect(typesSource).toContain('WorkerGenerateMessage');
      expect(typesSource).toContain('WorkerGenerateBatchMessage');
      expect(typesSource).toContain('WorkerDisposeMessage');
      expect(typesSource).toContain('WorkerTerminateMessage');

      // Union型の定義
      expect(typesSource).toContain('export type WorkerMessage');
    });

    it('WorkerResponse union型に6つのレスポンスタイプが含まれること', () => {
      // init, generate, generateBatch, dispose, terminate, error
      expect(typesSource).toContain('WorkerInitResponse');
      expect(typesSource).toContain('WorkerGenerateResponse');
      expect(typesSource).toContain('WorkerGenerateBatchResponse');
      expect(typesSource).toContain('WorkerDisposeResponse');
      expect(typesSource).toContain('WorkerTerminateResponse');
      expect(typesSource).toContain('WorkerErrorResponse');

      // Union型の定義
      expect(typesSource).toContain('export type WorkerResponse');
    });

    it('全メッセージにrequestIdフィールドが必須であること', () => {
      // requestIdはMain→Worker, Worker→Main両方に存在
      // interface宣言内のrequestId出現回数を検証
      const requestIdMatches = typesSource.match(/requestId:\s*string/g);
      // 5 request types + 6 response types = 11 occurrences minimum
      expect(requestIdMatches).not.toBeNull();
      expect(requestIdMatches!.length).toBeGreaterThanOrEqual(11);
    });

    it('WorkerInitResponseにexecutionProviderフィールドが含まれること（P2-H連携）', () => {
      // GPU検出結果をMainスレッドに通知するためのフィールド
      expect(typesSource).toContain('executionProvider: string');
    });

    it('WorkerErrorResponseにoriginalTypeフィールドが含まれること', () => {
      // エラー発生元のメッセージタイプを特定するため
      expect(typesSource).toContain("originalType: WorkerMessage['type']");
    });

    it('WorkerGenerateResponseにembeddingフィールド（number[]）が含まれること', () => {
      expect(typesSource).toContain('embedding: number[]');
    });

    it('WorkerGenerateBatchResponseにembeddingsフィールド（number[][]）が含まれること', () => {
      expect(typesSource).toContain('embeddings: number[][]');
    });

    it('すべてのレスポンスにsuccessフィールドが含まれること', () => {
      // success: true（成功系7つ: init, generate, generateBatch, dispose, terminate, switch-provider, release-gpu）
      // + success: false（エラー1つ）
      const successTrueMatches = typesSource.match(/success:\s*true/g);
      const successFalseMatches = typesSource.match(/success:\s*false/g);
      expect(successTrueMatches).not.toBeNull();
      expect(successTrueMatches!.length).toBe(7);
      expect(successFalseMatches).not.toBeNull();
      expect(successFalseMatches!.length).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Worker Threadモード検出テスト
  // --------------------------------------------------------------------------
  describe('Worker Threadモード検出', () => {
    let serviceSource: string;

    beforeEach(() => {
      serviceSource = readSource(SERVICE_PATH);
    });

    it('isWorkerThreadEnabled()関数が定義されていること', () => {
      expect(serviceSource).toContain('function isWorkerThreadEnabled()');
    });

    it('VITEST環境変数でWorker Threadが無効化されること', () => {
      // process.env.VITEST === 'true' のチェック
      expect(serviceSource).toContain("process.env.VITEST === 'true'");
    });

    it('VITEST_WORKER_ID環境変数でWorker Threadが無効化されること', () => {
      // Vitestワーカー内でも無効化
      expect(serviceSource).toContain('process.env.VITEST_WORKER_ID !== undefined');
    });

    it('EMBEDDING_WORKER_THREAD=false で明示的に無効化できること', () => {
      expect(serviceSource).toContain("envVal === 'false'");
      expect(serviceSource).toContain("envVal === '0'");
    });

    it('テスト環境でisUsingWorkerThread()がfalseを返すこと', async () => {
      // Vitest環境で実行しているため、in-processフォールバックが使われるはず
      const { EmbeddingService } = await import('../src/embeddings/service.js');
      const service = new EmbeddingService();
      expect(service.isUsingWorkerThread()).toBe(false);
    });

    it('EmbeddingServiceコンストラクタでuseWorkerThread判定が実行されること', () => {
      expect(serviceSource).toContain('this.useWorkerThread = isWorkerThreadEnabled()');
    });
  });

  // --------------------------------------------------------------------------
  // 3. requestIdベース非同期通信テスト
  // --------------------------------------------------------------------------
  describe('requestIdベース非同期通信', () => {
    let serviceSource: string;

    beforeEach(() => {
      serviceSource = readSource(SERVICE_PATH);
    });

    it('generateRequestId()関数が定義されていること', () => {
      expect(serviceSource).toContain('function generateRequestId()');
    });

    it('requestIdが一意であること（カウンタ + タイムスタンプベース）', () => {
      // req_ + Date.now() + counter のフォーマット
      expect(serviceSource).toContain('`req_${Date.now()}_${++requestIdCounter}`');
    });

    it('PendingRequest型にresolve/reject/timerが含まれること', () => {
      expect(serviceSource).toContain('resolve: (response: WorkerResponse) => void');
      expect(serviceSource).toContain('reject: (error: Error) => void');
      expect(serviceSource).toContain('timer: ReturnType<typeof setTimeout>');
    });

    it('pendingRequestsマップでリクエストが追跡されること', () => {
      // sendWorkerMessageでpendingRequestsにセット
      expect(serviceSource).toContain('this.pendingRequests.set(message.requestId');
      // handleWorkerResponseでpendingRequestsから取得・削除
      expect(serviceSource).toContain('this.pendingRequests.get(response.requestId)');
      expect(serviceSource).toContain('this.pendingRequests.delete(response.requestId)');
    });

    it('レスポンス受信時にタイマーがクリアされること', () => {
      expect(serviceSource).toContain('clearTimeout(pending.timer)');
    });

    it('sendWorkerMessageがWorkerがない場合にリジェクトすること', () => {
      expect(serviceSource).toContain("'Worker thread not available'");
    });
  });

  // --------------------------------------------------------------------------
  // 4. crash recoveryテスト（max 5回）
  // --------------------------------------------------------------------------
  describe('crash recovery（最大5回自動再起動）', () => {
    let serviceSource: string;

    beforeEach(() => {
      serviceSource = readSource(SERVICE_PATH);
    });

    it('MAX_WORKER_RESTARTS = 5 が定義されていること', () => {
      const maxRestarts = extractNumericConstant(serviceSource, 'MAX_WORKER_RESTARTS');
      expect(maxRestarts).toBe(5);
    });

    it('handleWorkerCrash()でworkerRestartCountがインクリメントされること', () => {
      expect(serviceSource).toContain('this.workerRestartCount++');
    });

    it('handleWorkerCrash()で全pending requestsがリジェクトされること', () => {
      // handleWorkerCrash内のpending request処理
      expect(serviceSource).toContain('Worker thread crashed:');
      expect(serviceSource).toContain('pending.reject(');
    });

    it('handleWorkerCrash()でworkerReady/worker/workerInitPromiseがリセットされること', () => {
      // クラッシュ後の状態リセット
      expect(serviceSource).toContain('this.workerReady = false');
      expect(serviceSource).toContain('this.worker = null');
      expect(serviceSource).toContain('this.workerInitPromise = null');
    });

    it('canRestartWorker()がMAX_WORKER_RESTARTS未満で再起動を許可すること', () => {
      expect(serviceSource).toContain('this.workerRestartCount < MAX_WORKER_RESTARTS');
    });

    it('max restarts超過時にエラーをスローすること', () => {
      expect(serviceSource).toContain(
        'Worker thread exceeded max restarts'
      );
    });

    it('getWorkerRestartCount() APIが公開されていること', () => {
      expect(serviceSource).toContain('getWorkerRestartCount(): number');
      expect(serviceSource).toContain('return this.workerRestartCount');
    });

    it('Worker exitコード非0でhandleWorkerCrashが呼ばれること', () => {
      // worker.on('exit') ハンドラで code !== 0 の場合 handleWorkerCrash
      expect(serviceSource).toContain("this.worker.on('exit'");
      expect(serviceSource).toContain('if (code !== 0)');
      expect(serviceSource).toContain('this.handleWorkerCrash(');
    });

    it('Worker errorイベントでhandleWorkerCrashが呼ばれること', () => {
      expect(serviceSource).toContain("this.worker.on('error'");
    });
  });

  // --------------------------------------------------------------------------
  // 5. タイムアウトテスト
  // --------------------------------------------------------------------------
  describe('WORKER_RESPONSE_TIMEOUT_MS タイムアウト', () => {
    let serviceSource: string;

    beforeEach(() => {
      serviceSource = readSource(SERVICE_PATH);
    });

    it('WORKER_RESPONSE_TIMEOUT_MS = 120,000ms (2分) が定義されていること', () => {
      const timeout = extractNumericConstant(serviceSource, 'WORKER_RESPONSE_TIMEOUT_MS');
      expect(timeout).toBe(120_000);
    });

    it('sendWorkerMessageでsetTimeoutによるタイムアウトが設定されること', () => {
      // setTimeout + WORKER_RESPONSE_TIMEOUT_MS
      expect(serviceSource).toContain('setTimeout(');
      expect(serviceSource).toContain('WORKER_RESPONSE_TIMEOUT_MS');
    });

    it('タイムアウト時にpendingRequestが削除されること', () => {
      // タイムアウトコールバック内でpendingRequests.delete
      expect(serviceSource).toContain('this.pendingRequests.delete(message.requestId)');
    });

    it('タイムアウトエラーメッセージにタイムアウト値とメッセージタイプが含まれること', () => {
      expect(serviceSource).toContain('Worker thread response timeout');
      expect(serviceSource).toContain('message.type');
    });
  });

  // --------------------------------------------------------------------------
  // 6. terminate()テスト
  // --------------------------------------------------------------------------
  describe('terminate()の正常終了', () => {
    let serviceSource: string;

    beforeEach(() => {
      serviceSource = readSource(SERVICE_PATH);
    });

    it('terminate()メソッドが定義されていること', () => {
      expect(serviceSource).toContain('async terminate(): Promise<void>');
    });

    it('terminate()がWorkerにterminateメッセージを送信すること', () => {
      // type: 'terminate' メッセージを送信
      expect(serviceSource).toContain("type: 'terminate'");
    });

    it('terminate()がworker.terminate()で強制終了すること', () => {
      // グレースピリオド後にWorker.terminate()
      expect(serviceSource).toContain('await this.worker.terminate()');
    });

    it('terminate()後にworker/workerReady/workerInitPromiseがリセットされること', () => {
      // terminate内のクリーンアップ
      // 複数箇所でリセットされるが、terminate内にも存在する
      const terminateMethod = serviceSource.slice(
        serviceSource.indexOf('async terminate()'),
        serviceSource.indexOf('async terminate()') + 800
      );
      expect(terminateMethod).toContain('this.worker = null');
      expect(terminateMethod).toContain('this.workerReady = false');
      expect(terminateMethod).toContain('this.workerInitPromise = null');
    });

    it('terminate()がin-process pipelineも破棄すること', () => {
      // disposeInProcess() もcall
      const terminateMethod = serviceSource.slice(
        serviceSource.indexOf('async terminate()'),
        serviceSource.indexOf('async terminate()') + 800
      );
      expect(terminateMethod).toContain('this.disposeInProcess()');
    });

    it('terminate()が残存pending requestsをリジェクトすること', () => {
      const terminateMethod = serviceSource.slice(
        serviceSource.indexOf('async terminate()'),
        serviceSource.indexOf('async terminate()') + 800
      );
      expect(terminateMethod).toContain("'Service terminated'");
      expect(terminateMethod).toContain('pending.reject(');
    });
  });

  // --------------------------------------------------------------------------
  // 7. Worker Threadスクリプトの構造検証
  // --------------------------------------------------------------------------
  describe('Worker Threadスクリプト (worker-thread.ts)', () => {
    let workerSource: string;

    beforeEach(() => {
      workerSource = readSource(WORKER_THREAD_PATH);
    });

    it('parentPortからのメッセージリスナーが設定されていること', () => {
      expect(workerSource).toContain("parentPort.on('message'");
    });

    it('handleMessage()が5つのメッセージタイプを処理すること', () => {
      expect(workerSource).toContain("case 'init':");
      expect(workerSource).toContain("case 'generate':");
      expect(workerSource).toContain("case 'generateBatch':");
      expect(workerSource).toContain("case 'dispose':");
      expect(workerSource).toContain("case 'terminate':");
    });

    it('terminateハンドラがprocess.exit(0)で終了すること', () => {
      expect(workerSource).toContain('process.exit(0)');
    });

    it('terminateハンドラがレスポンス送信後にsetTimeoutで終了すること', () => {
      // レスポンスフラッシュのためのsetTimeout
      expect(workerSource).toContain('setTimeout(() => process.exit(0)');
    });

    it('parentPortがない場合にエラーをスローすること', () => {
      expect(workerSource).toContain(
        'worker-thread.ts must be run as a Worker Thread (no parentPort)'
      );
    });

    it('handleMessageのエラーがsendErrorで送信されること', () => {
      expect(workerSource).toContain('sendError(message.requestId, message.type, error)');
    });

    it('EMBEDDING_DIMENSION = 768 が定義されていること', () => {
      const dim = extractNumericConstant(workerSource, 'EMBEDDING_DIMENSION');
      expect(dim).toBe(768);
    });

    it('pipelineリサイクル機構が含まれていること', () => {
      expect(workerSource).toContain('recyclePipelineIfNeeded');
      expect(workerSource).toContain('inferencesSinceRecycle');
      expect(workerSource).toContain('totalRecycles');
    });

    it('L2正規化関数が含まれていること', () => {
      expect(workerSource).toContain('function normalizeVector');
    });
  });

  // --------------------------------------------------------------------------
  // 8. EmbeddingService デュアルモードアーキテクチャ
  // --------------------------------------------------------------------------
  describe('EmbeddingService デュアルモード', () => {
    let serviceSource: string;

    beforeEach(() => {
      serviceSource = readSource(SERVICE_PATH);
    });

    it('Worker Thread経由の単一推論メソッドが存在すること', () => {
      expect(serviceSource).toContain('generateViaWorker');
    });

    it('Worker Thread経由のバッチ推論メソッドが存在すること', () => {
      expect(serviceSource).toContain('generateBatchViaWorker');
    });

    it('in-processフォールバックの単一推論メソッドが存在すること', () => {
      expect(serviceSource).toContain('generateInProcess');
    });

    it('in-processフォールバックのバッチ推論メソッドが存在すること', () => {
      expect(serviceSource).toContain('generateBatchInProcess');
    });

    it('generateEmbedding()がuseWorkerThreadで分岐すること', () => {
      // generateEmbedding内のif文
      expect(serviceSource).toContain('if (this.useWorkerThread)');
      expect(serviceSource).toContain('this.generateViaWorker(');
      expect(serviceSource).toContain('this.generateInProcess(');
    });

    it('generateBatchEmbeddings()がuseWorkerThreadで分岐すること', () => {
      expect(serviceSource).toContain('this.generateBatchViaWorker(');
      expect(serviceSource).toContain('this.generateBatchInProcess(');
    });

    it('Worker Thread初期化でinitメッセージが送信されること', () => {
      expect(serviceSource).toContain("type: 'init'");
      expect(serviceSource).toContain('requestId: generateRequestId()');
    });

    it('Worker Threadスクリプトパスがimport.meta.urlで解決されること（ESM対応）', () => {
      expect(serviceSource).toContain('import.meta.url');
      expect(serviceSource).toContain('worker-thread.js');
    });

    it('dispose()がWorker Threadモードとin-processモードの両方に対応すること', () => {
      const disposeStart = serviceSource.indexOf('async dispose(): Promise<void>');
      const disposeEnd = serviceSource.indexOf('this.inferencesSinceRecycle = 0', disposeStart);
      const disposeMethod = serviceSource.slice(disposeStart, disposeEnd + 50);
      expect(disposeMethod).toContain('if (this.useWorkerThread)');
      expect(disposeMethod).toContain("type: 'dispose'");
      expect(disposeMethod).toContain('this.disposeInProcess()');
    });

    it('isUsingWorkerThread() APIが公開されていること', () => {
      expect(serviceSource).toContain('isUsingWorkerThread(): boolean');
    });
  });
});

// ============================================================================
// P2-H: GPU推論サポート
// ============================================================================

describe('P2-H: GPU推論サポート (CUDA/ROCm)', () => {

  // --------------------------------------------------------------------------
  // 1. GPU実行プロバイダー検出テスト
  // --------------------------------------------------------------------------
  describe('detectExecutionProvider()', () => {
    let workerSource: string;

    beforeEach(() => {
      workerSource = readSource(WORKER_THREAD_PATH);
    });

    it('detectExecutionProvider()関数がworker-thread.tsに定義されていること', () => {
      expect(workerSource).toContain('function detectExecutionProvider()');
    });

    it('デフォルトでCPUを返すこと', () => {
      // 環境変数未設定時はcpuを返す
      expect(workerSource).toContain("return 'cpu'");
      // 関数の末尾で 'cpu' がデフォルト返却値であることを確認
      // detectExecutionProvider関数の閉じ括弧を探す
      const funcStart = workerSource.indexOf('function detectExecutionProvider()');
      // 関数末尾の独立した return 'cpu' （if文の外）がデフォルト
      // return 'cpu' が2箇所以上存在する（catch内 + デフォルト）
      const cpuReturns = workerSource.slice(funcStart).match(/return 'cpu'/g);
      expect(cpuReturns).not.toBeNull();
      expect(cpuReturns!.length).toBeGreaterThanOrEqual(2);
    });

    it('ONNX_EXECUTION_PROVIDER環境変数を読み取ること', () => {
      expect(workerSource).toContain('process.env.ONNX_EXECUTION_PROVIDER');
    });

    it('cuda/rocm設定時にCUDA provider可用性を検証すること', () => {
      expect(workerSource).toContain("envProvider === 'cuda' || envProvider === 'rocm'");
      expect(workerSource).toContain('verifyCudaAvailability()');
    });

    it('CUDAプロバイダが利用可能な場合にcudaを返すこと', () => {
      const funcBody = workerSource.slice(
        workerSource.indexOf('function detectExecutionProvider()'),
        workerSource.indexOf('function detectExecutionProvider()') + 500
      );
      // verifyCudaAvailability() success → return 'cuda'
      expect(funcBody).toContain("return 'cuda'");
    });

    it('CUDAプロバイダ未インストール時にCPUフォールバックすること', () => {
      // verifyCudaAvailability() false → 警告を出してcpuを返す
      expect(workerSource).toContain(
        'CUDA provider not available, falling back to CPU'
      );
    });

    it('ExecutionProvider型がcpuとcudaの2値であること', () => {
      expect(workerSource).toContain("type ExecutionProvider = 'cpu' | 'cuda'");
    });
  });

  // --------------------------------------------------------------------------
  // 2. EmbeddingService GPU設定テスト
  // --------------------------------------------------------------------------
  describe('EmbeddingService GPU設定', () => {
    let serviceSource: string;

    beforeEach(() => {
      serviceSource = readSource(SERVICE_PATH);
    });

    it('コンストラクタでONNX_EXECUTION_PROVIDER環境変数を読み取ること', () => {
      expect(serviceSource).toContain('process.env.ONNX_EXECUTION_PROVIDER');
    });

    it('cuda/rocm設定時にdeviceをcudaに設定すること', () => {
      // コンストラクタ内のGPU設定
      expect(serviceSource).toContain("this.config.device = 'cuda'");
    });

    it('deviceが明示的に設定された場合は環境変数を上書きしないこと', () => {
      // if (!config.device) の条件チェック
      expect(serviceSource).toContain('if (!config.device)');
    });

    it('テスト環境でデフォルトdevice=cpuが使用されること', async () => {
      const { EmbeddingService } = await import('../src/embeddings/service.js');
      const service = new EmbeddingService();
      // テスト環境ではGPU設定なし → cpu
      // isUsingWorkerThread()がfalse → in-processモードでcpu
      expect(service.isUsingWorkerThread()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Worker Threadの初期化レスポンスでexecutionProviderを通知
  // --------------------------------------------------------------------------
  describe('GPU検出結果のMain Thread通知', () => {
    let workerSource: string;

    beforeEach(() => {
      workerSource = readSource(WORKER_THREAD_PATH);
    });

    it('initレスポンスにexecutionProviderが含まれること', () => {
      // case 'init' の sendResponse
      const initCase = workerSource.slice(
        workerSource.indexOf("case 'init':"),
        workerSource.indexOf("case 'generate':"),
      );
      expect(initCase).toContain('executionProvider: resolvedProvider');
    });

    it('initializePipeline()でdetectExecutionProvider()が呼ばれること', () => {
      expect(workerSource).toContain('resolvedProvider = detectExecutionProvider()');
    });

    it('GPU検出結果がeffectiveDeviceに反映されること', () => {
      expect(workerSource).toContain(
        "resolvedProvider === 'cuda' ? 'cuda' : config.device"
      );
    });
  });

  // --------------------------------------------------------------------------
  // 4. CUDA Provider検出テスト（onnxruntime-gpu削除後）
  // --------------------------------------------------------------------------
  describe('CUDA Provider検出 (libonnxruntime_providers_cuda.so)', () => {
    let packageJson: Record<string, unknown>;
    let workerSource: string;

    beforeEach(() => {
      packageJson = JSON.parse(readSource(PACKAGE_JSON_PATH));
      workerSource = readSource(WORKER_THREAD_PATH);
    });

    it('onnxruntime-gpuがoptionalDependenciesから削除されていること', () => {
      const optDeps = packageJson.optionalDependencies as Record<string, string> | undefined;
      if (optDeps) {
        expect(optDeps['onnxruntime-gpu']).toBeUndefined();
      }
    });

    it('onnxruntime-nodeがdependenciesに含まれること（CPU必須）', () => {
      const deps = packageJson.dependencies as Record<string, string>;
      expect(deps['onnxruntime-node']).toBeDefined();
    });

    it('verifyCudaAvailability()がlibonnxruntime_providers_cuda.soを検出すること', () => {
      expect(workerSource).toContain('function verifyCudaAvailability()');
      expect(workerSource).toContain('libonnxruntime_providers_cuda.so');
    });

    it('verifyCudaAvailability()がonnxruntime-nodeパスを基準にプロバイダを探すこと', () => {
      expect(workerSource).toContain("esmRequire.resolve('onnxruntime-node')");
      // Dynamic napi version detection (v3, v6, etc.)
      expect(workerSource).toContain("d.startsWith('napi-v')");
    });

    it('verifyCudaAvailability()がfs.existsSyncでファイル存在を確認すること', () => {
      expect(workerSource).toContain('fs.existsSync(cudaProviderPath)');
    });

    it('CUDAプロバイダ未検出時に警告メッセージにパスが含まれること', () => {
      expect(workerSource).toContain('CUDA provider not found in:');
    });
  });

  // --------------------------------------------------------------------------
  // 5. 環境設定ファイル テスト
  // --------------------------------------------------------------------------
  describe('環境設定ファイル', () => {
    it('.env.example (root) にONNX_EXECUTION_PROVIDERが記載されていること', () => {
      const envExample = readSource(ROOT_ENV_EXAMPLE_PATH);
      expect(envExample).toContain('ONNX_EXECUTION_PROVIDER');
    });

    it('.env.example (mcp-server) にONNX_EXECUTION_PROVIDERが記載されていること', () => {
      const envExample = readSource(MCP_ENV_EXAMPLE_PATH);
      expect(envExample).toContain('ONNX_EXECUTION_PROVIDER');
    });

    it('docker-compose.ymlにGPU設定がコメント付きで含まれること', () => {
      if (fs.existsSync(DOCKER_COMPOSE_PATH)) {
        const dockerCompose = readSource(DOCKER_COMPOSE_PATH);
        expect(dockerCompose).toContain('ONNX_EXECUTION_PROVIDER');
      }
    });
  });
});

// ============================================================================
// 統合テスト: P2-G + P2-H のアーキテクチャ整合性
// ============================================================================

describe('v0.1.0 Worker Thread Architecture', () => {
  let serviceSource: string;
  let workerSource: string;
  let typesSource: string;

  beforeEach(() => {
    serviceSource = readSource(SERVICE_PATH);
    workerSource = readSource(WORKER_THREAD_PATH);
    typesSource = readSource(WORKER_THREAD_TYPES_PATH);
  });

  it('Worker ThreadとServiceのEMBEDDING_DIMENSIONが一致すること', () => {
    const workerDim = extractNumericConstant(workerSource, 'EMBEDDING_DIMENSION');
    const serviceDim = extractNumericConstant(serviceSource, 'EMBEDDING_DIMENSION');
    expect(workerDim).toBe(768);
    expect(serviceDim).toBe(768);
    expect(workerDim).toBe(serviceDim);
  });

  it('Worker Threadのconfig.pipelineRecycleThresholdがServiceのDEFAULT値と一致すること', () => {
    // Worker側のデフォルト: オブジェクトプロパティとして定義 (pipelineRecycleThreshold: 30)
    const workerMatch = workerSource.match(/pipelineRecycleThreshold:\s*([\d_]+)/);
    expect(workerMatch).not.toBeNull();
    const workerDefault = parseInt(workerMatch![1].replace(/_/g, ''), 10);
    // Service側のDEFAULT_PIPELINE_RECYCLE_THRESHOLD
    const serviceDefault = extractNumericConstant(serviceSource, 'DEFAULT_PIPELINE_RECYCLE_THRESHOLD');
    expect(workerDefault).toBe(30);
    expect(serviceDefault).toBe(30);
    expect(workerDefault).toBe(serviceDefault);
  });

  it('型定義がServiceとWorker Threadの両方からimportされること', () => {
    // Service側のimport
    expect(serviceSource).toContain("from './worker-thread-types.js'");
    // Worker側のimport
    expect(workerSource).toContain("from './worker-thread-types.js'");
  });

  it('normalizeVector関数がServiceとWorker Threadの両方に存在すること', () => {
    // 両方で独立して実装（スレッド間でオブジェクトが共有されないため）
    expect(serviceSource).toContain('function normalizeVector');
    expect(workerSource).toContain('function normalizeVector');
  });

  it('Worker ThreadモードとGPU設定が連携すること', () => {
    // Service: GPU環境変数 → config.device設定
    expect(serviceSource).toContain("this.config.device = 'cuda'");
    // Service: initメッセージにdevice含む
    expect(serviceSource).toContain('device: this.config.device');
    // Worker: config.deviceを使ってパイプライン初期化
    expect(workerSource).toContain('effectiveDevice');
  });

  it('BATCH_SIZE = 32 がWorker Threadに定義されていること', () => {
    const batchSize = extractNumericConstant(workerSource, 'BATCH_SIZE');
    expect(batchSize).toBe(32);
  });

  it('disposePipeline()がWorker Thread内でglobal.gc()を呼び出すこと', () => {
    // pipeline recycleでGC実行
    expect(workerSource).toContain('global.gc()');
  });

  it('in-processバッチ推論にsetImmediateのyield pointがあること', () => {
    // generateBatchInProcess内のsetImmediate
    const methodStart = serviceSource.indexOf('private async generateBatchInProcess');
    // メソッドの終端を見つける（次のpublicメソッドまで）
    const methodEnd = serviceSource.indexOf('// ===', methodStart + 100);
    const batchMethod = serviceSource.slice(methodStart, methodEnd > 0 ? methodEnd : methodStart + 2000);
    expect(batchMethod).toContain('setImmediate');
  });

  it('switchProviderInProcess()がCUDAプロバイダ.soファイル存在チェックを使用すること', () => {
    // service.ts の switchProviderInProcess が libonnxruntime_providers_cuda.so を検出
    const methodStart = serviceSource.indexOf('private async switchProviderInProcess');
    const methodEnd = serviceSource.indexOf('private async releaseGpu', methodStart);
    const method = serviceSource.slice(methodStart, methodEnd > 0 ? methodEnd : methodStart + 1500);
    expect(method).toContain('libonnxruntime_providers_cuda.so');
    // Dynamic napi version iteration with variable name 'p' for path
    expect(method).toContain('fs.existsSync(p)');
    // require.resolve('onnxruntime-gpu') が使われていないこと
    expect(method).not.toContain("require.resolve('onnxruntime-gpu')");
  });

  it('Worker Thread/Service両方でrequire.resolve(onnxruntime-gpu)が使われていないこと', () => {
    // onnxruntime-gpu は npm に存在しないパッケージのため削除済み
    expect(workerSource).not.toContain("require.resolve('onnxruntime-gpu')");
    expect(serviceSource).not.toContain("require.resolve('onnxruntime-gpu')");
  });
});
