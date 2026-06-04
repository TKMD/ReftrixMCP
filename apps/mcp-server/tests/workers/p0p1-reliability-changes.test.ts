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
 * ===========================================================================
 * TRACKED-ISSUE / TDA-FIND-05 (L) — AST-grep heuristic baseline staleness
 * ===========================================================================
 *
 * **Status**: CLOSED — T4-CO-② direct import + runtime assertion refactor
 *             (Plan v3 T4 carryover closure, 2026-05-05)
 * **Severity**: L (pre-existing baseline, NOT Z-a Wave 1/2/3 induced)
 * **Owner**: test-qa-engineer + pipeline-engineer (paired refactor)
 * **Closed**: 2026-05-05 (T4-CO-② implementation; within T+1d deadline)
 * **IO Plan Decision anchor**: `019df88d-445d` (IO APPROVE, Plan V1 §4)
 * **IO V2.1 Decision anchor**: `019df7ec-ce8d-7189-9a05-1f5c1f00efdf`
 * **Pipeline-engineer Wave 1 anchor**: `019df795-5ae3`
 *
 * **Resolution / 解決**:
 *   All 12 stale tests refactored from Module A source-text scanning to
 *   Module C (`worker-supervisor-lifecycle.service.ts`) direct import +
 *   runtime assertions. AST-grep heuristic helpers (`extractNumericConstant`,
 *   `extractSafeParseIntDefault`) are retained for P0-B/Sprint-1 integration
 *   tests that legitimately scan non-Module-A paths.
 *
 *   - P1-D "Supervisor側 IPC受信" (2 tests): re-targeted to Module C
 *     `WorkerSupervisorLifecycle` prototype method checks and
 *     `verifyWorkerIpcMessage` import from helpers.
 *   - P1-E "ソース構造検証" (6 tests): replaced with Module C direct
 *     imports of `IPC_SHUTDOWN_GRACE_MS`, `__IPC_SHUTDOWN_GRACE_MS_FOR_TEST`,
 *     and `WorkerSupervisorLifecycle.prototype` method existence checks.
 *   - P1-E "shutdown() も同じ3-Phase Protocol" (2 tests): replaced with
 *     Module C source scan of `LIFECYCLE_PATH` (correct module).
 *   - "v0.1.0 Worker Reliability Integration" (2 tests): re-targeted supervisorSource scan
 *     to `LIFECYCLE_PATH` (Module C).
 *
 * **Cross-references / 相互参照**:
 *   - Finding Registry: `pr-v3-t4-finding-registry-v1.md` §6.2 (Wave 3
 *     UNBLOCK-V2-05b + TDA-FIND-05 closure entries).
 *   - CO-26 split origin: `worker-supervisor.service.ts` Module A/B/C
 *     refactor (search internal for `decision.search "CO-26 worker
 *     supervisor split"` for full context).
 *     mandate (no carryover without deadline).
 *
 * @module tests/workers/sprint1-p0p1-changes
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
// TDA-FIND-05 T4-CO-②: Module C direct imports — replace stale Module A source scan
import {
  IPC_SHUTDOWN_GRACE_MS,
  __IPC_SHUTDOWN_GRACE_MS_FOR_TEST,
  WorkerSupervisorLifecycle,
} from "../../src/services/worker-supervisor-lifecycle.service.js";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// ============================================================================
// モック設定（vi.mock はモジュールスコープに巻き上げられるため、ここで定義）
// ============================================================================

const mockFork = vi.fn();
vi.mock("node:child_process", () => ({
  fork: (...args: unknown[]) => mockFork(...args),
}));

vi.mock("../../src/utils/logger", () => ({
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

const WORKER_SOURCE_PATH = path.resolve(__dirname, "../../src/workers/page-analyze-worker.ts");
const ML_SERVICE_PATH = path.resolve(
  __dirname,
  "../../../../packages/ml/src/embeddings/service.ts"
);
const SUPERVISOR_PATH = path.resolve(__dirname, "../../src/services/worker-supervisor.service.ts");
// TDA-FIND-05 T4-CO-②: Module C path — lifecycle constants/methods live here after CO-26 split
const LIFECYCLE_PATH = path.resolve(
  __dirname,
  "../../src/services/worker-supervisor-lifecycle.service.ts"
);
const EMBEDDING_HANDLER_PATH = path.resolve(
  __dirname,
  "../../src/tools/page/handlers/embedding-handler.ts"
);
const LAYOUT_EMBEDDING_PATH = path.resolve(
  __dirname,
  "../../src/services/layout-embedding.service.ts"
);
const WORKER_CONSTANTS_PATH = path.resolve(__dirname, "../../src/services/worker-constants.ts");
const QUEUE_CLEANUP_PATH = path.resolve(__dirname, "../../src/services/queue-cleanup.service.ts");

// ============================================================================
// PR-M-A respawn delay constant (Plan v4.3 PR-M / ADR-0035 §Decision 3 +
// Plan v4.4 PR-N-A / ADR-0035 Amendment 1 §Decision 5)
// ----------------------------------------------------------------------------
// The 3-Phase Shutdown mock tests below exercise the `page` workerType
// (default). After PR-M-A landed, `getRestartDelayMsForType("page")`
// resolves to `DEFAULT_PAGE_RESTART_DELAY_MS = 3000ms`. PR-N-A subsequently
// removed the per-instance config field (env var `WORKER_RESTART_DELAY_MS`
// is the only remaining override surface for the `page` workerType).
// Match the production default in worker-supervisor.service.ts.
// ============================================================================
const PAGE_RESPAWN_DELAY_MS = 3000;

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
  return parseInt(match[1].replace(/_/g, ""), 10);
}

/**
 * ソースファイルから safeParseInt(env, defaultValue) のデフォルト値を抽出
 */
function extractSafeParseIntDefault(source: string, constName: string): number | null {
  // `const NAME = safeParseInt(process.env.XXX, 2400000, ...)` パターン
  const regex = new RegExp(`${constName}\\s*=\\s*safeParseInt\\([^,]+,\\s*([\\d_]+)`);
  const match = source.match(regex);
  if (!match || !match[1]) return null;
  return parseInt(match[1].replace(/_/g, ""), 10);
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
    spawnfile: "",
    stdio: [null, null, null, null, null] as ChildProcess["stdio"],
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

describe("P0-A: PIPELINE_RECYCLE_THRESHOLD = 30", () => {
  let mlServiceSource: string;
  let workerSource: string;

  beforeAll(() => {
    mlServiceSource = fs.readFileSync(ML_SERVICE_PATH, "utf8");
    workerSource = fs.readFileSync(WORKER_SOURCE_PATH, "utf8");
  });

  it("DEFAULT_PIPELINE_RECYCLE_THRESHOLD が 30 であること（インポート検証）", async () => {
    const { DEFAULT_PIPELINE_RECYCLE_THRESHOLD } =
      await import("../../../../packages/ml/src/embeddings/service");
    expect(DEFAULT_PIPELINE_RECYCLE_THRESHOLD).toBe(30);
  });

  it("EMBEDDING_CHUNK_SIZE 以上であること（チャンクあたり最大1回のrecycle）", async () => {
    // EMBEDDING_CHUNK_SIZE は resolveMemoryConfig() から動的に取得される。
    // 32GBマシンではチャンク=30でrecycle=30（一致）。
    // 小メモリマシンではチャンク<30だが、recycle=30のまま（recycle頻度が下がるだけで安全）。
    const { DEFAULT_PIPELINE_RECYCLE_THRESHOLD } =
      await import("../../../../packages/ml/src/embeddings/service");
    const { resolveMemoryConfig } = await import("../../src/services/worker-memory-profile");
    const memoryConfig = resolveMemoryConfig();
    expect(DEFAULT_PIPELINE_RECYCLE_THRESHOLD).not.toBeNull();
    expect(memoryConfig.embeddingChunkSize).not.toBeNull();
    // recycle threshold >= chunk size → チャンクあたり最大1回のrecycle（過剰なrecycleを防止）
    expect(DEFAULT_PIPELINE_RECYCLE_THRESHOLD).toBeGreaterThanOrEqual(
      memoryConfig.embeddingChunkSize
    );
  });
});

// ============================================================================
// P0-B: lockDuration 40分 + 関連定数テスト
// ============================================================================

describe("P0-B: lockDuration 40分 + 関連定数", () => {
  let workerSource: string;
  let constantsSource: string;
  let cleanupSource: string;

  beforeAll(() => {
    // After TDA-C1 refactoring, DEFAULT_LOCK_DURATION is in phases/types.ts.
    // stalledInterval/maxStalledCount remain in the orchestrator.
    // Concatenate both for pattern matching.
    const typesPath = path.resolve(__dirname, "../../src/workers/phases/types.ts");
    workerSource =
      fs.readFileSync(typesPath, "utf8") + "\n" + fs.readFileSync(WORKER_SOURCE_PATH, "utf8");
    constantsSource = fs.readFileSync(WORKER_CONSTANTS_PATH, "utf8");
    cleanupSource = fs.readFileSync(QUEUE_CLEANUP_PATH, "utf8");
  });

  describe("定数値の検証", () => {
    it("DEFAULT_LOCK_DURATION が 2,400,000ms (40分) であること", () => {
      // safeParseInt(process.env.BULLMQ_LOCK_DURATION, 2400000, ...) のデフォルト値
      const lockDuration = extractSafeParseIntDefault(workerSource, "DEFAULT_LOCK_DURATION");
      expect(lockDuration).toBe(2_400_000);
    });

    it("STALL_MARGIN_MS が 240,000ms (4分) であること", () => {
      const stallMargin = extractNumericConstant(constantsSource, "STALL_MARGIN_MS");
      expect(stallMargin).toBe(240_000);
    });

    it("ORPHAN_THRESHOLD_MS が 7,200,000ms (120分) であること", () => {
      const orphanThreshold = extractNumericConstant(cleanupSource, "ORPHAN_THRESHOLD_MS");
      expect(orphanThreshold).toBe(7_200_000);
    });
  });

  describe("定数間の整合性", () => {
    it("ORPHAN_THRESHOLD_MS = lockDuration x 3 であること", () => {
      const lockDuration = extractSafeParseIntDefault(workerSource, "DEFAULT_LOCK_DURATION");
      const orphanThreshold = extractNumericConstant(cleanupSource, "ORPHAN_THRESHOLD_MS");
      expect(lockDuration).not.toBeNull();
      expect(orphanThreshold).not.toBeNull();
      // lockDuration(40分=2,400,000) x 3 = 120分=7,200,000 = ORPHAN_THRESHOLD_MS
      expect(orphanThreshold).toBe(lockDuration! * 3);
    });

    it("STALL_MARGIN_MS = lockDuration / 10 であること", () => {
      const lockDuration = extractSafeParseIntDefault(workerSource, "DEFAULT_LOCK_DURATION");
      const stallMargin = extractNumericConstant(constantsSource, "STALL_MARGIN_MS");
      expect(lockDuration).not.toBeNull();
      expect(stallMargin).not.toBeNull();
      // lockDuration(2,400,000) / 10 = 240,000 = STALL_MARGIN_MS
      expect(stallMargin).toBe(lockDuration! / 10);
    });

    it("stalledInterval = max(60000, lockDuration/4) であること（ソース構造検証）", () => {
      // BullMQ Worker 初期化時に stalledInterval が設定されていること
      expect(workerSource).toContain(
        "stalledInterval: Math.max(60000, Math.floor(lockDuration / 4))"
      );
    });

    it("maxStalledCount が 3 であること（ソース構造検証）", () => {
      expect(workerSource).toContain("maxStalledCount: 3");
    });

    it("DB_SAVED_PROGRESS_THRESHOLD が 90 であること", () => {
      const threshold = extractNumericConstant(constantsSource, "DB_SAVED_PROGRESS_THRESHOLD");
      expect(threshold).toBe(90);
    });
  });
});

// ============================================================================
// P0-C: Section Embedding バッチ推論テスト
// ============================================================================

describe("P0-C: Section Embedding バッチ推論", () => {
  let layoutEmbeddingSource: string;
  let handlerSource: string;

  beforeAll(() => {
    layoutEmbeddingSource = fs.readFileSync(LAYOUT_EMBEDDING_PATH, "utf8");
    handlerSource = fs.readFileSync(EMBEDDING_HANDLER_PATH, "utf8");
  });

  describe("generateBatchFromTexts メソッドの構造検証", () => {
    it("LayoutEmbeddingService に generateBatchFromTexts メソッドが存在すること", () => {
      expect(layoutEmbeddingSource).toContain(
        "async generateBatchFromTexts(texts: string[]): Promise<LayoutEmbeddingResult[]>"
      );
    });

    it("generateBatchFromTexts が EmbeddingService.generateBatchEmbeddings を呼ぶこと", () => {
      // バッチ推論で内部的にgenerateBatchEmbeddingsを使用していること
      const batchMethod = layoutEmbeddingSource.slice(
        layoutEmbeddingSource.indexOf("async generateBatchFromTexts")
      );
      expect(batchMethod).toContain("service.generateBatchEmbeddings(uncachedTexts");
    });

    it("空配列に対して空配列を返すこと", () => {
      const batchMethod = layoutEmbeddingSource.slice(
        layoutEmbeddingSource.indexOf("async generateBatchFromTexts")
      );
      // 空配列の早期リターンが存在すること
      expect(batchMethod).toContain("if (texts.length === 0)");
      expect(batchMethod).toContain("return []");
    });
  });

  describe("embedding-handler バッチ推論統合", () => {
    it("generateSectionEmbeddings がバッチ推論を使用すること", () => {
      // Phase 2: バッチ推論の呼び出しが存在すること
      expect(handlerSource).toContain("embeddingService.generateBatchFromTexts(allTexts)");
    });

    it("バッチ推論失敗時に個別フォールバックが動作すること", () => {
      // バッチ失敗 → batchEmbeddings = [] → 後続ループで individualResult に切り替え
      expect(handlerSource).toContain("Batch embedding failed, falling back to individual");
      expect(handlerSource).toContain("batchEmbeddings = []");
    });

    it("フォールバック時は generateFromText で個別生成すること", () => {
      // 個別フォールバック: batchResult が無い場合に generateFromText を呼ぶ
      expect(handlerSource).toContain("embeddingService.generateFromText(textRepresentation)");
    });

    it("DI用 layoutEmbeddingService オプションが GenerateSectionEmbeddingsOptions に存在すること", () => {
      expect(handlerSource).toContain(
        "layoutEmbeddingService?: LayoutEmbeddingService | undefined"
      );
    });
  });

  describe("generateBatchFromTexts キャッシュ統合", () => {
    it("キャッシュhit分をスキップして未キャッシュ分のみバッチ推論すること", () => {
      const batchMethod = layoutEmbeddingSource.slice(
        layoutEmbeddingSource.indexOf("async generateBatchFromTexts")
      );
      // uncachedIndices / uncachedTexts でキャッシュミス分を収集
      expect(batchMethod).toContain("uncachedIndices");
      expect(batchMethod).toContain("uncachedTexts");
    });

    it("バッチ推論結果をキャッシュに保存すること", () => {
      const batchMethod = layoutEmbeddingSource.slice(
        layoutEmbeddingSource.indexOf("async generateBatchFromTexts")
      );
      // キャッシュ保存（fire-and-forget）
      expect(batchMethod).toContain("embeddingCache.set(cacheKey, cacheEntry)");
    });

    it("結果がフィルタリングされて undefined を除外すること", () => {
      const batchMethod = layoutEmbeddingSource.slice(
        layoutEmbeddingSource.indexOf("async generateBatchFromTexts")
      );
      // undefined フィルタリング
      expect(batchMethod).toContain("filter((r): r is LayoutEmbeddingResult => r !== undefined)");
    });
  });
});

// ============================================================================
// P1-D: Worker→Supervisor IPC通知テスト
// ============================================================================

describe("P1-D: notifyJobCompleted IPC通知", () => {
  describe("Worker側 process.send 呼び出し（ソース構造検証）", () => {
    let workerSource: string;

    beforeAll(() => {
      workerSource = fs.readFileSync(WORKER_SOURCE_PATH, "utf8");
    });

    it('Worker completed イベントで process.send({ type: "job-completed", workerType, jobId, timestamp }) を送信すること', () => {
      // BullMQ Worker.on('completed') ハンドラー内で IPC メッセージを送信。
      //
      // PR-D-8 Phase 2 (MF-02 + MF-05): IPC payload は WorkerIpcMessageSchema
      // SSOT に準拠する必要がある — `workerType` と `timestamp` 必須。supervisor
      // の `verifyWorkerIpcMessage` が両 field 欠落 payload を fail-closed で
      // 破棄するため、page-analyze-worker は per-type payload を emit する。
      // PR-D-8 Phase 2 (MF-02 + MF-05): IPC payload は新形式 (workerType + timestamp 必須)。
      expect(workerSource).toContain('type: "job-completed"');
      expect(workerSource).toContain('workerType: "page"');
      expect(workerSource).toContain("jobId: job.id");
      expect(workerSource).toContain("timestamp: Date.now()");
    });

    it("IPC送信が try-catch で保護されていること", () => {
      // P1-D: IPC channel closed 時の非致命的エラーハンドリング
      const completedHandler = workerSource.slice(
        workerSource.indexOf('worker.on("completed"'),
        workerSource.indexOf('worker.on("failed"')
      );
      expect(completedHandler).toContain("try");
      expect(completedHandler).toContain("catch");
      expect(completedHandler).toContain("IPC channel may be closed");
    });

    it("P1-D コメントが存在すること", () => {
      expect(workerSource).toContain(
        "P1-D: Notify parent process (WorkerSupervisor) of job completion via IPC"
      );
    });
  });

  describe("Supervisor側 IPC受信とnotifyJobCompleted（Module C 直接検証）", () => {
    // TDA-FIND-05 T4-CO-②: refactored from Module A source scan to Module C
    // direct import + runtime assertions. WorkerSupervisorLifecycle owns the
    // IPC dispatch pipeline after CO-26 split.
    let lifecycleSource: string;

    beforeAll(() => {
      lifecycleSource = fs.readFileSync(LIFECYCLE_PATH, "utf8");
    });

    it('WorkerSupervisorLifecycle が child.on("message") で job-completed を受信し notifyJobCompletedForType を呼ぶこと (Module C)', () => {
      // P1-D + PR-D-8 Phase 2 (MF-02): IPC message handler は
      // `verifyWorkerIpcMessage` 経由で SSOT schema 検証 + bindingTable cross-check
      // 後に `notifyJobCompletedForType(workerType)` へ dispatch する。
      // T4-CO-②: Module C (worker-supervisor-lifecycle.service.ts) に移動済。
      // Runtime check: WorkerSupervisorLifecycle has the IPC-related methods.
      expect(typeof WorkerSupervisorLifecycle).toBe("function");
      // shutdownChild is public — accessible via prototype without TS error
      expect(typeof WorkerSupervisorLifecycle.prototype.shutdownChild).toBe("function");
      // Source scan of correct module (Module C) for IPC dispatch surface.
      expect(lifecycleSource).toContain('child.on("message"');
      expect(lifecycleSource).toContain("dispatchVerifiedIpc");
      expect(lifecycleSource).toContain("verifyWorkerIpcMessage");
      expect(lifecycleSource).toMatch(
        /this\.supervisor\.notifyJobCompletedForType\(verified\.workerType\)/
      );
    });

    it("WorkerIpcMessage 型が SSOT schema からインポートされていること (MF-02, Module C)", () => {
      // PR-D-8 Phase 2: WorkerMessage 型は `worker-ipc.schema.ts` SSOT に
      // 移管され、Module C (lifecycle) が verifyWorkerIpcMessage 経由で参照する。
      // T4-CO-②: correct source is Module C (LIFECYCLE_PATH).
      expect(lifecycleSource).toContain("worker-ipc");
      expect(lifecycleSource).toMatch(/"job-completed"/);
    });
  });

  describe("Supervisor側 IPC動作検証（モック）", () => {
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

    it("IPC経由でmaxJobsBeforeRestart到達時に再起動がトリガーされること", async () => {
      const { WorkerSupervisor } = await import("../../src/services/worker-supervisor.service");

      const supervisor = new WorkerSupervisor({
        workerScript: "./dist/scripts/start-workers.js",
        maxJobsBeforeRestart: 2, // 2件で再起動
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning();
      expect(supervisor.getState()).toBe("running");

      // PR-D-8 Phase 2 (MF-02 + MF-05): IPC payload は SSOT schema 準拠
      // (`workerType` + `timestamp` 必須)。`mockChild` は pid=12345 で fork
      // されたため supervisor の bindingTable に `(12345, "page")` が登録済。
      // PR-D-8 Phase 2 (MF-02 + MF-05): per-type IPC payload で送信。
      mockChild.emit("message", {
        type: "job-completed",
        workerType: "page",
        jobId: "00000000-0000-4000-8000-000000000001",
        timestamp: Date.now(),
      });
      expect(supervisor.getCompletedJobCount()).toBe(1);

      mockChild.emit("message", {
        type: "job-completed",
        workerType: "page",
        jobId: "00000000-0000-4000-8000-000000000002",
        timestamp: Date.now(),
      });
      expect(supervisor.getCompletedJobCount()).toBe(2);

      // 2件到達 → initiateRestart がトリガーされ、state が restarting に遷移
      expect(supervisor.getState()).toBe("restarting");
    });

    it("不正なIPCメッセージは無視されること", async () => {
      const { WorkerSupervisor } = await import("../../src/services/worker-supervisor.service");

      const supervisor = new WorkerSupervisor({
        workerScript: "./dist/scripts/start-workers.js",
        maxJobsBeforeRestart: 10,
        maxRestartAttempts: 5,
        shutdownTimeoutMs: 10000,
      });

      supervisor.ensureWorkerRunning();

      // PR-D-8 Phase 2 (MF-02): schema-invalid な payload は
      // `verifyWorkerIpcMessage` で fail-closed 破棄される。
      // PR-D-8 Phase 2 (MF-02): schema-invalid payload は破棄。
      mockChild.emit("message", { type: "unknown-type" });
      mockChild.emit("message", "string-message");
      mockChild.emit("message", null);
      mockChild.emit("message", { noType: true });
      // 旧形式 (workerType/timestamp 欠落) も fail-closed 破棄される
      mockChild.emit("message", { type: "job-completed", jobId: "legacy-shape" });

      // いずれもカウンタに影響しない
      expect(supervisor.getCompletedJobCount()).toBe(0);
    });

    it("notifyJobCompleted が正しくカウンタをインクリメントすること", async () => {
      const { WorkerSupervisor } = await import("../../src/services/worker-supervisor.service");

      const supervisor = new WorkerSupervisor({
        workerScript: "./dist/scripts/start-workers.js",
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
      expect(supervisor.getState()).toBe("running");
    });
  });
});

// ============================================================================
// P1-E: initiateRestart 3-Phase Shutdown テスト
// ============================================================================

describe("P1-E: initiateRestart 3-Phase Shutdown", () => {
  describe("Module C 構造検証 (TDA-FIND-05 T4-CO-②: direct import + runtime)", () => {
    // TDA-FIND-05 T4-CO-②: refactored from Module A (SUPERVISOR_PATH) source
    // scan to Module C (LIFECYCLE_PATH) direct import + runtime assertions.
    // initiateRestart, IPC_SHUTDOWN_GRACE_MS, and the 3-Phase Protocol all
    // live in worker-supervisor-lifecycle.service.ts after CO-26 split.
    let lifecycleSource: string;

    beforeAll(() => {
      lifecycleSource = fs.readFileSync(LIFECYCLE_PATH, "utf8");
    });

    it("WorkerSupervisorLifecycle.initiateRestart が public メソッドとして存在すること (Module C, per-type signature)", () => {
      // PR-D-8 Phase 2 (MF-04): initiateRestart は per-type 化され workerType を
      // 第一引数に取る。Module C (WorkerSupervisorLifecycle class) に移動済。
      // T4-CO-②: direct import + runtime assertion — structurally impossible
      // to false-pass if initiateRestart is renamed or removed.
      expect(typeof WorkerSupervisorLifecycle.prototype.initiateRestart).toBe("function");
      // Source verify on correct module (Module C).
      expect(lifecycleSource).toMatch(
        /initiateRestart\(workerType:\s*WorkerType,\s*reason:\s*string\):\s*void/
      );
    });

    it("IPC_SHUTDOWN_GRACE_MS が env override + range-validated constant として宣言される (Module C, Plan v2 §1 S1.2)", () => {
      // Plan v2 §1 S1.2 (anchor 019de97f-1dcf): legacy hardcoded `const
      // IPC_SHUTDOWN_GRACE_MS = 2000` は env-overridable IIFE
      // (`const IPC_SHUTDOWN_GRACE_MS: number = ((): number => { ... })();`) に
      // 置換され、default 値は 30,000ms に変更。Module C (LIFECYCLE_PATH) に移動済。
      // T4-CO-②: direct import assertions replace source-scan heuristic.
      expect(typeof IPC_SHUTDOWN_GRACE_MS).toBe("number");
      // Default must be 30,000ms (Plan v2 §1 S1.2 — legacy 2000 replaced).
      expect(__IPC_SHUTDOWN_GRACE_MS_FOR_TEST.default).toBe(30_000);
      // Current value must be ≥ 1000ms (range-validated lower bound).
      expect(IPC_SHUTDOWN_GRACE_MS).toBeGreaterThanOrEqual(1_000);
      // Source verify on correct module (Module C) for IIFE form.
      expect(lifecycleSource).toMatch(/const\s+IPC_SHUTDOWN_GRACE_MS:\s*number\s*=\s*\(\(\)/);
    });

    it("Phase 1: initiateRestart が IPC shutdown メッセージを送信すること (Module C)", () => {
      // initiateRestart 内で workerToRestart.send({ type: 'shutdown' }) を呼ぶ。
      // T4-CO-②: scan correct module (Module C / LIFECYCLE_PATH).
      const initiateStart = lifecycleSource.indexOf("initiateRestart(workerType: WorkerType");
      const sectionEnd = lifecycleSource.indexOf("// Plan v3 Track T4", initiateStart);
      const restartMethod = lifecycleSource.slice(
        initiateStart,
        sectionEnd > initiateStart ? sectionEnd : initiateStart + 3000
      );
      expect(restartMethod).toContain('workerToRestart.send({ type: "shutdown" })');
    });

    it("Phase 2: initiateRestart が IPC_SHUTDOWN_GRACE_MS 後に SIGTERM を送信すること (Module C)", () => {
      // T4-CO-②: scan correct module (Module C / LIFECYCLE_PATH).
      const initiateStart = lifecycleSource.indexOf("initiateRestart(workerType: WorkerType");
      const sectionEnd = lifecycleSource.indexOf("// Plan v3 Track T4", initiateStart);
      const restartMethod = lifecycleSource.slice(
        initiateStart,
        sectionEnd > initiateStart ? sectionEnd : initiateStart + 3000
      );
      expect(restartMethod).toContain('workerToRestart.kill("SIGTERM")');
      expect(restartMethod).toContain("IPC_SHUTDOWN_GRACE_MS");
    });

    it("Phase 3: initiateRestart がタイムアウト後に SIGKILL エスカレーションすること (Module C)", () => {
      // T4-CO-②: scan correct module (Module C / LIFECYCLE_PATH).
      const initiateStart = lifecycleSource.indexOf("initiateRestart(workerType: WorkerType");
      const sectionEnd = lifecycleSource.indexOf("// Plan v3 Track T4", initiateStart);
      const restartMethod = lifecycleSource.slice(
        initiateStart,
        sectionEnd > initiateStart ? sectionEnd : initiateStart + 3000
      );
      expect(restartMethod).toContain('workerToRestart.kill("SIGKILL")');
      expect(restartMethod).toContain("shutdownTimeoutMs");
    });

    it("exit イベントでタイマーがクリアされること (Module C)", () => {
      // T4-CO-②: scan correct module (Module C / LIFECYCLE_PATH).
      const initiateStart = lifecycleSource.indexOf("initiateRestart(workerType: WorkerType");
      const sectionEnd = lifecycleSource.indexOf("// Plan v3 Track T4", initiateStart);
      const restartMethod = lifecycleSource.slice(
        initiateStart,
        sectionEnd > initiateStart ? sectionEnd : initiateStart + 3000
      );
      expect(restartMethod).toContain("clearTimeout(sigTermTimerId)");
      expect(restartMethod).toContain("clearTimeout(killTimerId)");
    });
  });

  describe("shutdown() も同じ3-Phase Protocolを使用すること (Module C 直接検証)", () => {
    // TDA-FIND-05 T4-CO-②: refactored from Module A (SUPERVISOR_PATH) scan to
    // Module C (LIFECYCLE_PATH) scan + runtime assertions.
    // `shutdownChild()` in Module C carries the actual 3-phase IPC/SIGTERM/SIGKILL logic.
    let lifecycleSource: string;

    beforeAll(() => {
      lifecycleSource = fs.readFileSync(LIFECYCLE_PATH, "utf8");
    });

    it("shutdownChild() で IPC shutdown メッセージを送信すること (Module C)", () => {
      // PR-D-8 Phase 2: shutdown() は per-type 化され、shutdownChild() に委譲。
      // shutdownChild 内で `workerToKill.send({ type: "shutdown" })` を実行。
      // T4-CO-②: shutdownChild is in Module C; runtime check + source scan.
      expect(typeof WorkerSupervisorLifecycle.prototype.shutdownChild).toBe("function");
      // shutdownChild anchor in Module C
      const shutdownStart = lifecycleSource.indexOf(
        "async shutdownChild(workerType: WorkerType): Promise<void>"
      );
      const shutdownMethod = lifecycleSource.slice(shutdownStart, shutdownStart + 2000);
      expect(shutdownMethod).toContain('workerToKill.send({ type: "shutdown" })');
    });

    it("shutdownChild() で Phase 2 SIGTERM を IPC_SHUTDOWN_GRACE_MS 後に送信すること (Plan v2 §1 S1.2, Module C)", () => {
      // Plan v2 §1 S1.2 (anchor 019de97f-1dcf): legacy hardcoded `2000` →
      // env-overridable constant (default 30,000ms)。shutdownChild +
      // initiateRestart 両 callsite で同じ constant を参照する DRY 構造を
      // 維持しつつ、env override (`WORKER_IPC_SHUTDOWN_GRACE_MS`) で test/dev
      // 環境では値を短縮可能。
      // T4-CO-②: runtime assertion replaces Module A IIFE regex scan.
      expect(typeof IPC_SHUTDOWN_GRACE_MS).toBe("number");
      expect(__IPC_SHUTDOWN_GRACE_MS_FOR_TEST.default).toBe(30_000);
      // shutdownChild anchor in Module C
      const shutdownStart = lifecycleSource.indexOf(
        "async shutdownChild(workerType: WorkerType): Promise<void>"
      );
      const shutdownMethod = lifecycleSource.slice(shutdownStart, shutdownStart + 2000);
      expect(shutdownMethod).toContain('workerToKill.kill("SIGTERM")');
      expect(shutdownMethod).toContain("IPC_SHUTDOWN_GRACE_MS");
      // env override IIFE form in Module C (Plan v2 §1 S1.2)
      expect(lifecycleSource).toMatch(/const\s+IPC_SHUTDOWN_GRACE_MS:\s*number\s*=\s*\(\(\)/);
    });
  });

  describe("3-Phase Shutdown 動作検証（モック）", () => {
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

    it("notifyJobCompleted N件到達で IPC→SIGTERM 順序でシャットダウンすること", async () => {
      const { WorkerSupervisor } = await import("../../src/services/worker-supervisor.service");

      const supervisor = new WorkerSupervisor({
        workerScript: "./dist/scripts/start-workers.js",
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
      expect(mockChild.send).toHaveBeenCalledWith({ type: "shutdown" });

      // Phase 2: IPC_SHUTDOWN_GRACE_MS (Plan v2 §1 S1.2 default 30,000ms) 後にSIGTERM
      // Plan v2 §1 S1.2 raised default from 2,000ms to 30,000ms (env override
      // via WORKER_IPC_SHUTDOWN_GRACE_MS supports test/dev shorten).
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");

      // 子プロセス終了をシミュレート
      mockChild.emit("exit", 0, null);

      // 再起動遅延を消化 (PR-M-A: page workerType respawn cooldown 3000ms)
      await vi.advanceTimersByTimeAsync(PAGE_RESPAWN_DELAY_MS);

      // 新しいワーカーがforkされる
      expect(mockFork.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ============================================================================
// P1-F: setImmediate yield points テスト
// ============================================================================

describe("P1-F: setImmediate yield points", () => {
  describe("page-analyze-worker.ts のyield points", () => {
    let workerSource: string;
    let chunkLoopSource: string;

    beforeAll(() => {
      // After TDA-C1 refactoring, processEmbeddingPhase and all setImmediate
      // yield points moved to phase-5-embedding.ts. PR-BT-5 chunk-fork
      // contingency (ADR-0039 §Consequences #2a) then centralized the
      // chunk-boundary yield into the shared `runChunkedTextEmbeddingLoop` driver
      // (phase-5-chunked-text-loop.ts), so the per-chunk yield now lives there and
      // the text sub-phases inherit it by delegation.
      const phase5Path = path.resolve(__dirname, "../../src/workers/phases/phase-5-embedding.ts");
      const chunkLoopPath = path.resolve(
        __dirname,
        "../../src/workers/phases/phase-5-chunked-text-loop.ts"
      );
      workerSource = fs.readFileSync(phase5Path, "utf8");
      chunkLoopSource = fs.readFileSync(chunkLoopPath, "utf8");
    });

    it("チャンク間 setImmediate yield point が共有ドライバに存在すること", () => {
      // The chunk-boundary yield is centralized in the shared driver's
      // disposeBetweenChunks (one setImmediate, consumed by all delegating text
      // sub-phases) — so it appears exactly once but covers all 6 text sub-phases.
      const yieldPattern = /await new Promise<void>\(\(resolve\) => setImmediate\(resolve\)\)/g;
      const matches = chunkLoopSource.match(yieldPattern);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(1);
    });

    it("Section が共有ドライバに委譲して yield point を継承すること", () => {
      const fnStart = workerSource.indexOf("async function processSectionTextEmbeddingChunks");
      const body = workerSource.slice(fnStart, fnStart + 10000);
      expect(body).toContain("runChunkedTextEmbeddingLoop(ctx, {");
    });

    it("Motion が共有ドライバに委譲して yield point を継承すること", () => {
      const fnStart = workerSource.indexOf("async function processMotionTextEmbeddingChunks");
      const body = workerSource.slice(fnStart, fnStart + 10000);
      expect(body).toContain("runChunkedTextEmbeddingLoop(ctx, {");
    });

    it("Vision-Motion が共有ドライバに委譲して yield point を継承すること", () => {
      const fnStart = workerSource.indexOf("async function processVisionMotionEmbeddingChunks");
      const body = workerSource.slice(fnStart, fnStart + 10000);
      expect(body).toContain("runChunkedTextEmbeddingLoop(ctx, {");
    });

    it("Background が共有ドライバに委譲して yield point を継承すること", () => {
      const fnStart = workerSource.indexOf("async function processBackgroundTextEmbeddingChunks");
      const body = workerSource.slice(fnStart, fnStart + 10000);
      expect(body).toContain("runChunkedTextEmbeddingLoop(ctx, {");
    });

    it("JSAnimation が共有ドライバに委譲して yield point を継承すること", () => {
      const fnStart = workerSource.indexOf("async function processJsAnimationEmbeddingChunks");
      const body = workerSource.slice(fnStart, fnStart + 10000);
      expect(body).toContain("runChunkedTextEmbeddingLoop(ctx, {");
    });

    it("yield point にコメント説明があること", () => {
      // BullMQ heartbeats と IPC のためのyieldであることが共有ドライバに記述されていること
      expect(chunkLoopSource).toContain("Yield to event loop");
    });
  });

  describe("EmbeddingService.generateBatchInProcess のyield point", () => {
    let mlServiceSource: string;

    beforeAll(() => {
      mlServiceSource = fs.readFileSync(ML_SERVICE_PATH, "utf8");
    });

    it("バッチ間に setImmediate yield point があること", () => {
      const batchMethod = mlServiceSource.slice(mlServiceSource.indexOf("generateBatchInProcess"));
      expect(batchMethod).toContain("setImmediate(resolve)");
    });

    it("yield point が最終バッチ以外にのみ実行されること", () => {
      const batchMethod = mlServiceSource.slice(mlServiceSource.indexOf("generateBatchInProcess"));
      // 最終バッチをスキップする条件
      expect(batchMethod).toContain("batchEnd < prefixedTexts.length");
    });
  });
});

// ============================================================================
// 統合整合性テスト: 全定数のクロスチェック
// ============================================================================

describe("v0.1.0 Worker Reliability Integration", () => {
  let workerSource: string;
  let supervisorSource: string;
  let lifecycleSource: string;

  beforeAll(() => {
    // After TDA-C1 refactoring, DEFAULT_LOCK_DURATION is in phases/types.ts.
    // IPC patterns and sharedLayoutEmbeddingService remain in the orchestrator.
    // Concatenate both for pattern matching.
    const typesPath = path.resolve(__dirname, "../../src/workers/phases/types.ts");
    workerSource =
      fs.readFileSync(typesPath, "utf8") + "\n" + fs.readFileSync(WORKER_SOURCE_PATH, "utf8");
    supervisorSource = fs.readFileSync(SUPERVISOR_PATH, "utf8");
    // TDA-FIND-05 T4-CO-②: Module C source for IPC dispatch and lifecycle patterns.
    lifecycleSource = fs.readFileSync(LIFECYCLE_PATH, "utf8");
  });

  it("lockDuration(40分) は Embedding Phase のタイムアウトに十分であること", () => {
    const lockDuration = extractSafeParseIntDefault(workerSource, "DEFAULT_LOCK_DURATION");
    expect(lockDuration).not.toBeNull();
    // 40分 = 2,400,000ms > Embedding Phase 想定最大時間(~20分)
    expect(lockDuration!).toBeGreaterThanOrEqual(2_400_000);
  });

  it("Worker側 process.send の type と Supervisor側の dispatch が一致すること (Module C)", () => {
    // PR-D-8 Phase 2 (MF-02): Worker は SSOT schema 準拠の payload を emit
    // (`type: "job-completed", workerType: "page", jobId, timestamp`).
    // Module C (lifecycle) は dispatchVerifiedIpc 内で "job-completed" を dispatch。
    // TDA-FIND-05 T4-CO-②: scan Module C (lifecycleSource) instead of Module A.
    expect(workerSource).toContain('type: "job-completed"');
    // Module C側: dispatchVerifiedIpc 内で "job-completed" string literal を比較
    expect(lifecycleSource).toContain('"job-completed"');
  });

  it("initiateRestart と shutdownChild が同じ IPC→SIGTERM→SIGKILL パターンを使用すること (Module C)", () => {
    // TDA-FIND-05 T4-CO-②: refactored from Module A scan (stale: private initiateRestart)
    // to Module C scan. initiateRestart is PUBLIC in Module C post CO-26 split.
    // PR-D-8 Phase 2: per-type 化により both methods are in WorkerSupervisorLifecycle.
    const initiateStart = lifecycleSource.indexOf(
      "initiateRestart(workerType: WorkerType, reason: string): void"
    );
    const initiateMethod = lifecycleSource.slice(initiateStart, initiateStart + 3000);

    // shutdownChild anchor in Module C
    const shutdownStart = lifecycleSource.indexOf(
      "async shutdownChild(workerType: WorkerType): Promise<void>"
    );
    const shutdownMethod = lifecycleSource.slice(shutdownStart, shutdownStart + 2000);

    // 両方とも3つのフェーズを含む
    for (const method of [initiateMethod, shutdownMethod]) {
      expect(method).toContain('send({ type: "shutdown" })');
      expect(method).toContain('kill("SIGTERM")');
      expect(method).toContain('kill("SIGKILL")');
    }
    // Runtime assertion: both methods exist on WorkerSupervisorLifecycle
    expect(typeof WorkerSupervisorLifecycle.prototype.initiateRestart).toBe("function");
    expect(typeof WorkerSupervisorLifecycle.prototype.shutdownChild).toBe("function");
  });

  it("sharedLayoutEmbeddingService がワーカー起動時にシングルトンとして初期化されること", () => {
    // P0-1: 全 Embedding サブフェーズでシングルトンを共有
    expect(workerSource).toContain(
      "const sharedLayoutEmbeddingService = new LayoutEmbeddingService()"
    );
    expect(workerSource).toContain(
      "setBackgroundEmbeddingServiceFactory(() => sharedLayoutEmbeddingService)"
    );
    expect(workerSource).toContain(
      "setMotionLayoutEmbeddingServiceFactory(() => sharedLayoutEmbeddingService)"
    );
  });
});
