// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerSupervisor Service
 *
 * page.analyzeワーカープロセスのライフサイクルを自動管理するサービス。
 * OOM問題（16GBヒープ上限で2-3サイト後にクラッシュ）をプロセス再起動で解決する。
 *
 * 機能:
 * - child_process.fork でワーカーを子プロセスとして起動
 * - N件のジョブ完了後にワーカーを再起動（メモリリーク蓄積を防止）
 * - クラッシュ時の自動再起動（exit code/signal 両対応）
 * - graceful shutdown（SIGTERM → タイムアウト → SIGKILL エスカレーション）
 * - maxRestartAttempts による連続クラッシュ時の停止
 * - [TDA-V11-02 / FIND-IMPL-TDA-D1b-01 L, deadline 2026-05-25, Registry §13.17.7] ESLint max-lines=1500 file at-cap; extract new logic to `worker-supervisor-helpers.ts` (PR-D-8 helper convention) before adding here. Cross-ref: Registry §13.16.4 + §13.17.5 + INV-EMBEDDING-MOTION-WORKER-SIGABRT-006.
 *
 * @module services/worker-supervisor
 */

import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger, isDevelopment } from "../utils/logger";
import { computeMemoryProfile } from "./worker-memory-profile";
import { LOCK_HEARTBEAT_INTERVAL_MS, WorkerActiveLockService } from "./worker-active-lock.service";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
// PR-D-8 Phase 2 — WorkerType SSOT (§3.2.1 / TDA-01 H) and IPC schema SSOT
// (§3.2.2 / TPA-02 H). `assertNeverWorkerType` powers the exhaustive-switch
// contract that makes future WorkerType additions fail compile in every
// consuming callsite rather than silently ignoring the new type.
// PR-D-8 Phase 2: WorkerType / IPC スキーマ SSOT と exhaustive-switch 契約。
import { WORKER_TYPES, type WorkerType } from "../types/worker-type";
import type { WorkerIpcMessage } from "../schemas/worker-ipc.schema";
// Helpers extracted to worker-supervisor-helpers.ts for max-lines (TDA-V11-02).
// Bottom re-exports keep external importer compat (tests, consumers).
import {
  buildBootTokens,
  buildDefaultWorkerTypeConfigs,
  clearLockHeartbeatTimer,
  emitWorkerRestartAudit,
  executeSelfChainedRespawn,
  processSigabrtSignal,
  runAcquireLockWithRetryOrchestrator,
  scheduleSigabrtAwareRespawn,
  verifyWorkerIpcMessage,
} from "./worker-supervisor-helpers";
import { verifyVisionUnloadPrecondition } from "./vision/vision-unload-handshake";

// ============================================================================
// CUDA Library Path Auto-Detection
// ============================================================================

/**
 * CUDA 12 ライブラリの既知パスから LD_LIBRARY_PATH を構築する (pip install
 * nvidia-cudnn-cu12 + Ollama CUDA v12 自動検出)。LD_LIBRARY_PATH 未設定時のみ。
 * SEC: ファイルシステム読み取りのみ、パスは固定リスト。
 * CC=16 — pre-existing pre-PR-D-8 code; refactor tracked in FIND-TDA-07 Q3-2026.
 */
// eslint-disable-next-line complexity
function detectCudaLibPaths(): string | null {
  const pythonVersions = ["python3.10", "python3.11", "python3.12", "python3.8", "python3.9"];
  const homeDir = process.env.HOME ?? "/tmp";
  const baseDirs = pythonVersions.map((v) => `${homeDir}/.local/lib/${v}/site-packages/nvidia`);
  const cudaSubPackages = [
    "cudnn/lib",
    "cublas/lib",
    "cuda_runtime/lib",
    "cufft/lib",
    "curand/lib",
    "cuda_nvrtc/lib",
  ];
  const ollamaCudaPath = "/usr/local/lib/ollama/cuda_v12";
  const foundPaths: string[] = [];

  // onnxruntime-node CUDA provider — require.resolve で version mismatch を回避。
  try {
    const ortNodePath = require.resolve("onnxruntime-node");
    let packageDir = path.dirname(ortNodePath);
    for (let i = 0; i < 5; i++) {
      if (fs.existsSync(path.join(packageDir, "package.json"))) break;
      packageDir = path.dirname(packageDir);
    }
    const binDir = path.join(packageDir, "bin");
    if (fs.existsSync(binDir)) {
      const napiDirs = fs.readdirSync(binDir).filter((d: string) => d.startsWith("napi-v"));
      for (const napiDir of napiDirs) {
        const cudaProviderDir = path.join(binDir, napiDir, "linux", "x64");
        const hasCudaProvider = fs.existsSync(
          path.join(cudaProviderDir, "libonnxruntime_providers_cuda.so")
        );
        const hasBaseLib = fs.existsSync(path.join(cudaProviderDir, "libonnxruntime.so.1"));
        if (hasCudaProvider && hasBaseLib) {
          foundPaths.push(cudaProviderDir);
          break;
        }
      }
    }
  } catch {
    /* onnxruntime-node not found */
  }

  // pip パッケージから一致 Python バージョンを採用。
  for (const baseDir of baseDirs) {
    let allFound = true;
    const candidatePaths: string[] = [];
    for (const subPkg of cudaSubPackages) {
      const fullPath = path.join(baseDir, subPkg);
      if (fs.existsSync(fullPath)) candidatePaths.push(fullPath);
      else allFound = false;
    }
    if (allFound && candidatePaths.length === cudaSubPackages.length) {
      foundPaths.push(...candidatePaths);
      break;
    }
  }

  if (fs.existsSync(ollamaCudaPath)) foundPaths.push(ollamaCudaPath);
  return foundPaths.length === 0 ? null : foundPaths.join(":");
}

// ============================================================================
// Types
// ============================================================================

/**
 * WorkerSupervisorの設定オプション
 */
export interface WorkerSupervisorOptions {
  /** ワーカースクリプトのパス（fork対象） */
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
export type WorkerState = "idle" | "running" | "restarting" | "stopped" | "crashed";

/**
 * ワーカーからスーパーバイザーへのIPCメッセージ型 (legacy alias for back-compat)
 *
 * P1-D: job-completed — BullMQ Worker.on('completed') で送信。
 *       maxJobsBeforeRestart カウンタの駆動に使用。
 *
 * PR-D-8: the authoritative IPC message type is {@link WorkerIpcMessage}
 * (SSOT: `apps/mcp-server/src/schemas/worker-ipc.schema.ts`). This alias
 * is retained for pre-PR-D-8 consumers and will be removed once internal
 * callers are migrated.
 *
 * PR-D-8 以降、IPC メッセージ型の SSOT は {@link WorkerIpcMessage}。
 * 本 alias は旧 consumer 互換用で、移行完了後に削除される。
 *
 * @deprecated Use {@link WorkerIpcMessage} (schemas/worker-ipc.schema).
 */
export type WorkerMessage = WorkerIpcMessage;

// ============================================================================
// PR-D-8 Phase 2 — Multi-WorkerType config + per-child state (§3.2.3 / §3.2.4)
// ============================================================================

/**
 * Per-{@link WorkerType} supervisor configuration. One entry per supported
 * WorkerType; keys must be exhaustive against the SSOT union.
 *
 * PR-D-8 §3.2.3: WorkerType ごとの supervisor 設定。SSOT union に対して網羅的。
 */
export interface WorkerTypeConfig {
  /** Path to the fork target (`start-workers.js` entry point). */
  workerScript: string;
  /** Additional argv passed to the fork child (e.g. `["--page"]`). */
  workerArgs: string[];
  /** Planned-restart threshold (N jobs → graceful restart). */
  maxJobsBeforeRestart: number;
  /** RSS-delta kill threshold in MB (Phase 5 style). */
  rssKillDeltaMB: number;
  /**
   * Env var name used to propagate this type's boot token to the child.
   * Rule 2 (Plan v1.1 §3.2.4) — distinct env var per type prevents token
   * reuse across types.
   */
  bootTokenEnv: string;
  /**
   * Env var name the child reads to self-identify its WorkerType. Rule 4
   * (§3.2.4) forces the child to exit(1) if argv disagrees with
   * `REFTRIX_WORKER_CHILD_TYPE`.
   */
  childTypeEnv: string;
  /**
   * Staggered-spawn priority. TPA-01 H: `primary` spawns first; `secondary`
   * waits for primary's first heartbeat (or 10s timeout) before spawning.
   */
  schedulingPriority: "primary" | "secondary";
}

/**
 * Per-child runtime state held by the supervisor. One entry per live child
 * in `Map<WorkerType, WorkerChildState>`. TDA-V11-02: extracted as a helper
 * type to keep `WorkerSupervisor` class body focused on lifecycle logic.
 *
 * PR-D-8 §3.2.3: supervisor が保持する per-child 状態。TDA-V11-02 の
 * helper 型抽出。
 */
export interface WorkerChildState {
  child: ChildProcess;
  workerType: WorkerType;
  pid: number;
  /** Nonce published to Redis via WorkerActiveLockService. */
  lockNonce: string;
  /** Independent per-type UUID (Rule 1) — must NOT reuse another type's token. */
  bootToken: string;
  jobsProcessed: number;
  startedAt: number;
  lastHeartbeatAt: number;
  /**
   * SEC-02 Rule 5 spoofing / TTL fallback suppression deadline (epoch ms).
   * When set, supervisor refuses to respawn this type until this timestamp.
   */
  restartSuppressUntil: number | null;
}

/** IPC 'shutdown' メッセージ送信後、SIGTERMまでの猶予（ms） */
const IPC_SHUTDOWN_GRACE_MS = 2000;

// ============================================================================
// Default Configuration
// ============================================================================

/** デフォルトの再起動遅延（ms） */
const DEFAULT_RESTART_DELAY_MS = 1000;

/**
 * 環境変数を安全にパースする（SEC監査 Medium #1 対応）
 * NaN、0以下の値はデフォルトにフォールバックする。
 */
function safeParseInt(value: string | undefined, defaultValue: number, min: number = 1): number {
  if (value === undefined || value === "") return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < min) return defaultValue;
  return parsed;
}

// ============================================================================
// WorkerSupervisor Class
// ============================================================================

/**
 * Per-type WorkerSupervisor (Plan v1.1 §3.2.3 / PR-D-8 Phase 2 re-impl).
 *
 * Manages independent fork-supervised children per WorkerType
 * (`Map<WorkerType, WorkerChildState>`) with: per-type boot tokens (§3.2.4
 * Rule 1, MF-03), Rule 5 IPC binding via `verifyWorkerIpcMessage` (MF-02 /
 * SEC-IMPL-01), self-chained respawn protocol from `handleWorkerExit`
 * (MF-04 / SEC-IMPL-03), `worker_supervisor_restart` audit_logs emit at
 * every restart (MF-08 / LCC-IMPL-01), and `sanitizeErrorMessage` at child
 * error handler (MF-09 / SEC-IMPL-05).
 *
 * Backward-compat: legacy `getWorkerSupervisor()` / `notifyJobCompleted()` /
 * `getWorkerProcess()` API defaults to the `page` WorkerType so existing
 * call sites (analyze.tool, batch-analyze.tool, MCP index) need no churn.
 */
export class WorkerSupervisor {
  // --------------------------------------------------------------------------
  // Per-type child state (PR-D-8 §3.2.3 MF-01)
  // --------------------------------------------------------------------------

  /** Per-type 設定 — コンストラクタで `WORKER_TYPES` 網羅性を確認。 */
  private readonly typeConfigs: Record<WorkerType, WorkerTypeConfig>;
  /** Per-type 子プロセス state。各 WorkerType は最大 1 子を保持。 */
  private readonly children: Map<WorkerType, WorkerChildState> = new Map();
  /**
   * pid → WorkerType binding (§3.2.4 Rule 5)。fork() 直後に同期登録し、子の
   * 初回 IPC が到着する前に entry を確立する。
   */
  private readonly bindingTable: Map<number, WorkerType> = new Map();
  /**
   * Per-type 独立 boot token (§3.2.4 Rule 1)。2 回 `randomUUID()` を独立に
   * 呼ぶことで CWE-290 cross-type impersonation を防ぐ。single reuse 禁止。
   */
  private readonly bootTokens: Record<WorkerType, string>;

  /**
   * Legacy WorkerSupervisorOptions config — `page` の per-type 既定値および
   * `maxRestartAttempts` / `shutdownTimeoutMs` の全 type 共通源。
   */
  private readonly config: Required<Omit<WorkerSupervisorOptions, "workerArgs" | "workerEnv">> &
    Pick<WorkerSupervisorOptions, "workerArgs" | "workerEnv">;

  /** Per-type 独立 restart counter / state。 */
  private readonly perTypeState: Map<
    WorkerType,
    {
      state: WorkerState;
      completedJobCount: number;
      restartCount: number;
      pendingRestart: boolean;
    }
  > = new Map();

  private isShuttingDown = false;

  // Redis active-worker lock (per-type, ADR-0011 Amendment)
  private lockService: WorkerActiveLockService | null = null;
  private readonly lockAcquired: Map<WorkerType, boolean> = new Map();
  private readonly lockHeartbeatTimers: Map<WorkerType, ReturnType<typeof setInterval>> = new Map();
  private readonly lockAcquireInflight: Map<WorkerType, boolean> = new Map();

  // Fix-3 (INFRA-EMBEDDING-MOTION-SIGABRT-001): SIGABRT count + audit rate-limit (helper-driven).
  private readonly sigabrtCountByWorkerType: Map<WorkerType, number> = new Map();
  private readonly lastSigabrtAuditByWorkerType: Map<WorkerType, number> = new Map();

  constructor(options: WorkerSupervisorOptions) {
    this.config = {
      ...options,
      restartDelayMs: options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
    };

    // PR-D-8 §3.2.3 MF-01: per-type config map. Default per-type values are
    // sourced from `buildDefaultWorkerTypeConfigs(workerScript)`; the `page`
    // entry is then overridden so the legacy `WorkerSupervisorOptions`-based
    // constructor surface continues to drive `page` lifecycle.
    // PR-D-8 §3.2.3 MF-01: per-type config map。`page` は legacy options で
    // 上書きすることで既存呼び出しサイトとの互換を維持する。
    const defaults = buildDefaultWorkerTypeConfigs(options.workerScript);
    this.typeConfigs = {
      page: {
        ...defaults.page,
        workerArgs: options.workerArgs ?? defaults.page.workerArgs,
        maxJobsBeforeRestart: options.maxJobsBeforeRestart,
      },
      "embedding-backfill": defaults["embedding-backfill"],
    };

    // §3.2.4 Rule 1: independent per-type tokens (helper for max-lines compliance).
    this.bootTokens = buildBootTokens();

    for (const workerType of WORKER_TYPES) {
      this.perTypeState.set(workerType, {
        state: "idle",
        completedJobCount: 0,
        restartCount: 0,
        pendingRestart: false,
      });
      this.lockAcquired.set(workerType, false);
      this.lockAcquireInflight.set(workerType, false);
    }
  }

  /**
   * Boot token for the `page` WorkerType. Exposed for test assertions only.
   *
   * @internal exposed for tests (legacy single-token interface; tests asserting
   * on multi-type behaviour should use {@link getBootTokenForType}).
   */
  getBootToken(): string {
    return this.bootTokens.page;
  }

  /**
   * Per-type boot token accessor for tests.
   *
   * @internal Test-only.
   */
  getBootTokenForType(workerType: WorkerType): string {
    return this.bootTokens[workerType];
  }

  /**
   * Per-type config accessor for tests.
   *
   * @internal Test-only.
   */
  getTypeConfig(workerType: WorkerType): WorkerTypeConfig {
    return this.typeConfigs[workerType];
  }

  /**
   * Get the live child state for a WorkerType (or `null` if no live child).
   *
   * @internal Test-only.
   */
  getChildState(workerType: WorkerType): WorkerChildState | null {
    return this.children.get(workerType) ?? null;
  }

  /**
   * pid → WorkerType binding accessor for tests asserting on Rule 5.
   *
   * @internal Test-only.
   */
  getBindingTableSnapshot(): ReadonlyMap<number, WorkerType> {
    return this.bindingTable;
  }

  /**
   * ワーカーが起動していなければ起動する (legacy single-worker API; defaults to
   * `page`). For multi-type spawn use {@link ensureWorkerRunningForType}.
   *
   * 冪等操作。legacy 互換 API として `page` をデフォルト起動する。
   */
  ensureWorkerRunning(): void {
    this.ensureWorkerRunningForType("page");
  }

  /**
   * Per-type ensure-running entry point (PR-D-8 MF-01). Idempotent: if the
   * type's child is already running, no-op.
   *
   * Per-type の起動エントリポイント。既に running 中の type は no-op。
   */
  ensureWorkerRunningForType(workerType: WorkerType): void {
    const state = this.requirePerTypeState(workerType);

    // 既に起動中・shutdown済み・再起動中なら何もしない
    if (state.state === "running" && this.children.has(workerType)) return;
    if (state.state === "stopped") return;
    if (state.state === "restarting") return;

    // PR7d-2: Publish boot token to Redis so manual Worker invocations can
    // detect us. Best-effort; failure does not block fork-supervised spawn.
    this.acquireRedisLockBestEffort(workerType);

    // crashed 状態からの自動復旧 (legacy semantics retained)
    if (state.state === "crashed") {
      logger.info("[WorkerSupervisor] Auto-resetting from crashed state for new job submission", {
        workerType,
        previousRestartCount: state.restartCount,
      });
      state.restartCount = 0;
      state.state = "idle";
    }

    this.spawnWorker(workerType);
  }

  /**
   * PR-D-8 MF-07 (TPA-IMPL-V11-08): staggered multi-type spawn. Spawns `primary`,
   * awaits first IPC heartbeat (or 10s timeout), then spawns `secondary` — prevents
   * allocation spike from concurrent DINOv2 + e5-base ONNX init (Plan v1.1 §3.3).
   *
   * Multi-type 起動 API。primary heartbeat (最大 10s) 受信後に secondary 起動で
   * 両子同時 ML モデル初期化の RSS spike を回避 (Plan v1.1 §3.3)。
   *
   * @param heartbeatTimeoutMs Override default 10s heartbeat wait (test injection)
   */
  async ensureAllWorkersRunningStaggered(heartbeatTimeoutMs: number = 10_000): Promise<void> {
    const primary = this.firstWorkerTypeOfPriority("primary");
    const secondary = this.firstWorkerTypeOfPriority("secondary");
    if (!primary || !secondary) {
      logger.warn("[WorkerSupervisor] ensureAllWorkersRunningStaggered: missing priority", {
        primary,
        secondary,
      });
      return;
    }
    this.ensureWorkerRunningForType(primary);
    await this.waitForFirstHeartbeat(primary, heartbeatTimeoutMs);
    // ADR-0011 Amendment 2 §A2.2.3: fail-closed Vision unload precondition
    if ((await verifyVisionUnloadPrecondition()).status === "vision_unloaded")
      this.ensureWorkerRunningForType(secondary);
  }

  /** Find the first WorkerType whose schedulingPriority matches; null if none. */
  private firstWorkerTypeOfPriority(priority: "primary" | "secondary"): WorkerType | null {
    for (const workerType of WORKER_TYPES) {
      if (this.typeConfigs[workerType].schedulingPriority === priority) return workerType;
    }
    return null;
  }

  /**
   * Wait until the live child for `workerType` reports its first heartbeat,
   * or `timeoutMs` elapses. Resolves silently on timeout (non-fatal).
   * 子の first heartbeat 待機 — timeout 時は静かに resolve。
   */
  private async waitForFirstHeartbeat(workerType: WorkerType, timeoutMs: number): Promise<void> {
    const childState = this.children.get(workerType);
    if (!childState) return;
    const startedAt = childState.startedAt;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const current = this.children.get(workerType);
      // first heartbeat = lastHeartbeatAt が startedAt から進んだ瞬間。
      if (current && current.lastHeartbeatAt > startedAt) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    logger.warn("[WorkerSupervisor] First heartbeat timeout (continuing)", {
      workerType,
      timeoutMs,
    });
  }

  /**
   * 現在のワーカー状態を取得 (legacy alias for `page`).
   */
  getState(): WorkerState {
    return this.getStateForType("page");
  }

  /**
   * Per-type state accessor.
   */
  getStateForType(workerType: WorkerType): WorkerState {
    return this.requirePerTypeState(workerType).state;
  }

  /**
   * 完了ジョブカウントを取得 (legacy alias for `page`).
   */
  getCompletedJobCount(): number {
    return this.getCompletedJobCountForType("page");
  }

  /**
   * Per-type completed-job count accessor.
   */
  getCompletedJobCountForType(workerType: WorkerType): number {
    return this.requirePerTypeState(workerType).completedJobCount;
  }

  /**
   * 再起動回数を取得 (legacy alias for `page`).
   */
  getRestartCount(): number {
    return this.getRestartCountForType("page");
  }

  /**
   * Per-type restart-count accessor.
   */
  getRestartCountForType(workerType: WorkerType): number {
    return this.requirePerTypeState(workerType).restartCount;
  }

  /**
   * ジョブ完了を通知 (legacy single-worker API; defaults to `page`).
   *
   * Legacy 互換 API。`page` のジョブ完了として扱う。
   */
  notifyJobCompleted(): void {
    this.notifyJobCompletedForType("page");
  }

  /**
   * Per-type notification (Rule 5 verification dispatches here on valid IPC).
   *
   * 内部カウンタをインクリメントし、maxJobsBeforeRestart に達したら計画的再起動。
   */
  notifyJobCompletedForType(workerType: WorkerType): void {
    const state = this.requirePerTypeState(workerType);
    state.completedJobCount++;

    if (isDevelopment()) {
      logger.debug("[WorkerSupervisor] Job completed", {
        workerType,
        completedJobCount: state.completedJobCount,
        maxJobsBeforeRestart: this.typeConfigs[workerType].maxJobsBeforeRestart,
      });
    }

    if (state.completedJobCount >= this.typeConfigs[workerType].maxJobsBeforeRestart) {
      this.initiateRestart(workerType, "job_count_threshold");
    }
  }

  /**
   * graceful shutdown — terminates every live child and releases every per-type
   * Redis lock. 3-Phase Shutdown Protocol per child.
   *
   * 全 type を順次 graceful shutdown する。各 child に 3-Phase プロトコル適用。
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Per-type Redis lock release (fire-and-forget for each type).
    for (const workerType of WORKER_TYPES) {
      void this.releaseRedisLockBestEffort(workerType);
    }

    const shutdownPromises: Array<Promise<void>> = [];
    for (const workerType of WORKER_TYPES) {
      shutdownPromises.push(this.shutdownChild(workerType));
    }
    await Promise.all(shutdownPromises);
  }

  /**
   * Per-type child shutdown — 3-Phase Protocol: IPC 'shutdown' → SIGTERM
   * (after IPC_SHUTDOWN_GRACE_MS) → SIGKILL escalation (after shutdownTimeoutMs).
   */
  private async shutdownChild(workerType: WorkerType): Promise<void> {
    const childState = this.children.get(workerType);
    const state = this.requirePerTypeState(workerType);
    if (!childState) {
      state.state = "stopped";
      return;
    }
    const workerToKill = childState.child;
    const childPid = childState.pid;

    return new Promise<void>((resolve) => {
      let killTimerId: ReturnType<typeof setTimeout> | null = null;
      let sigTermTimerId: ReturnType<typeof setTimeout> | null = null;
      const onExit = (): void => {
        if (killTimerId !== null) clearTimeout(killTimerId);
        if (sigTermTimerId !== null) clearTimeout(sigTermTimerId);
        killTimerId = null;
        sigTermTimerId = null;
        this.children.delete(workerType);
        this.bindingTable.delete(childPid);
        state.state = "stopped";
        resolve();
      };
      workerToKill.once("exit", onExit);
      try {
        if (workerToKill.connected && workerToKill.send) {
          workerToKill.send({ type: "shutdown" });
        }
      } catch {
        logger.warn("[WorkerSupervisor] IPC shutdown message failed (non-fatal)", { workerType });
      }
      sigTermTimerId = setTimeout(() => {
        try {
          workerToKill.kill("SIGTERM");
        } catch {
          onExit();
        }
      }, IPC_SHUTDOWN_GRACE_MS);
      killTimerId = setTimeout(() => {
        if (isDevelopment()) {
          logger.warn("[WorkerSupervisor] Shutdown timeout, sending SIGKILL", {
            workerType,
            pid: childPid,
          });
        }
        try {
          workerToKill.kill("SIGKILL");
        } catch {
          onExit();
        }
      }, this.config.shutdownTimeoutMs);
    });
  }

  /**
   * ワーカーの ChildProcess を取得 (legacy alias for `page`).
   *
   * Legacy 互換 API。新規コードは {@link getWorkerProcessForType} を使用する。
   */
  getWorkerProcess(): ChildProcess | null {
    return this.getWorkerProcessForType("page");
  }

  /**
   * Per-type child process accessor (test/monitoring use).
   */
  getWorkerProcessForType(workerType: WorkerType): ChildProcess | null {
    return this.children.get(workerType)?.child ?? null;
  }

  // ==========================================================================
  // Private — Spawn lifecycle (PR-D-8 §3.2.3 MF-01)
  // ==========================================================================

  /**
   * Per-type fork. PR-D-8 §3.2.3 MF-01 — replaces legacy single-worker
   * `spawnWorker()`. Establishes:
   *   - per-type env injection (`bootTokenEnv`, `childTypeEnv`) per §3.2.4 MF-03
   *   - `bindingTable` entry **before** the child can possibly send IPC
   *   - `children.set(workerType, ...)` with a fresh `WorkerChildState`
   *
   * Per-type fork。Plan v1.1 §3.2.3 MF-01 に準拠。
   */
  private spawnWorker(workerType: WorkerType): void {
    const config = this.typeConfigs[workerType];
    const state = this.requirePerTypeState(workerType);
    // PR-E-1 Option A (ADR-0011 Amendment 4 §A): lockNonce = bootToken (per-supervisor immutable). INV-007.
    const lockNonce = this.bootTokens[workerType];

    if (isDevelopment()) {
      logger.info("[WorkerSupervisor] Spawning worker", {
        workerType,
        script: config.workerScript,
        args: config.workerArgs,
        restartCount: state.restartCount,
      });
    }

    const env = this.buildSpawnEnv(workerType);
    const maxOldSpace =
      env.WORKER_MAX_OLD_SPACE_MB ?? String(computeMemoryProfile().maxOldSpaceSizeMb);
    const execArgv = [`--max-old-space-size=${maxOldSpace}`, "--expose-gc"];

    const child = fork(config.workerScript, config.workerArgs, {
      execArgv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env,
      cwd: path.resolve(__dirname, "../.."),
    });

    // Establish bindingTable entry SYNCHRONOUSLY so Rule 5 IPC verification
    // never races with first-message arrival. fork() returns synchronously
    // and the child cannot have sent any IPC before we register here.
    // bindingTable を SYNCHRONOUS に確立 — fork() は同期返却し、子は登録前に
    // IPC を送信できないため Rule 5 検証の race を防げる。
    if (child.pid !== undefined) {
      this.bindingTable.set(child.pid, workerType);
    }

    const childState: WorkerChildState = {
      child,
      workerType,
      pid: child.pid ?? -1,
      lockNonce,
      bootToken: this.bootTokens[workerType],
      jobsProcessed: 0,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      restartSuppressUntil: null,
    };
    this.children.set(workerType, childState);
    state.state = "running";

    this.attachChildEventHandlers(workerType, child);

    if (isDevelopment()) {
      logger.info("[WorkerSupervisor] Worker spawned", {
        workerType,
        pid: child.pid,
        state: state.state,
      });
    }
  }

  /**
   * Build the env block for `fork()` per WorkerType. Centralises the per-type
   * env injection (PR-D-8 §3.2.4 MF-03) so {@link spawnWorker} stays small.
   *
   * Per-type env 構築。`spawnWorker` から分離して complexity を抑える。
   */
  private buildSpawnEnv(workerType: WorkerType): Record<string, string | undefined> {
    const config = this.typeConfigs[workerType];
    const env: Record<string, string | undefined> = { ...process.env };

    if (this.config.workerEnv && workerType === "page") {
      // Legacy `workerEnv` only applies to the `page` WorkerType to preserve
      // pre-PR-D-8 behaviour.
      // Legacy `workerEnv` は `page` のみに適用 (PR-D-8 以前の挙動を保持)。
      for (const [key, value] of Object.entries(this.config.workerEnv)) {
        env[key] = value;
      }
    }

    // PR7d-2: identify fork children. PR-D-8 §3.2.4 Rule 3: legacy env var
    // continues to be set for 1-cycle backward compatibility.
    // PR7d-2 + Rule 3: legacy env var を 1 cycle 互換目的で継続注入。
    env.REFTRIX_WORKER_IS_CHILD = "1";
    env.REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN = this.bootTokens[workerType];

    // PR-D-8 §3.2.4 Rule 2 (MF-03): per-type env vars.
    // Both vars are written so `start-workers.ts` can read either depending
    // on the resolved WorkerType — harmless because each child only USES the
    // var matching its own type.
    // Rule 2 (MF-03): per-type env var を全 type 分注入。
    env[this.typeConfigs.page.bootTokenEnv] = this.bootTokens.page;
    env[this.typeConfigs["embedding-backfill"].bootTokenEnv] =
      this.bootTokens["embedding-backfill"];

    // Rule 4 (MF-03): CHILD_TYPE で自己識別。
    env[config.childTypeEnv] = workerType;

    // OOM-1: glibc malloc arena 断片化を防止。
    if (!env.MALLOC_ARENA_MAX) {
      env.MALLOC_ARENA_MAX = "2";
    }
    return env;
  }

  /**
   * Attach exit / message / error / stdio handlers for a freshly forked child.
   * Centralised so {@link spawnWorker} stays under cyclomatic complexity 10.
   *
   * fork 直後の子に各種 event handler を付ける helper。
   */
  private attachChildEventHandlers(workerType: WorkerType, child: ChildProcess): void {
    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        if (isDevelopment()) {
          logger.debug(`[WorkerSupervisor:${workerType}:stdout] ${data.toString().trimEnd()}`);
        }
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        const message = data.toString().trimEnd();
        logger.warn(`[WorkerSupervisor:${workerType}:stderr] ${message}`);
      });
    }

    child.on("exit", (code: number | null, signal: string | null) => {
      this.handleWorkerExit(workerType, code, signal);
    });

    // PR-D-8 §3.2.4 Rule 5 (MF-02 / SEC-IMPL-01 / SEC-IMPL-04): IPC dispatch
    // via {@link verifyWorkerIpcMessage}. Rejects schema-invalid messages,
    // workerType mismatches, and unknown senderPid; on spoofing emits
    // `worker_type_spoofing_detected` audit_logs and SIGTERMs the child.
    // PR-D-8 §3.2.4 Rule 5 (MF-02): verifyWorkerIpcMessage 経由で IPC dispatch。
    child.on("message", (raw: unknown) => {
      this.dispatchVerifiedIpc(raw, child.pid);
    });

    // MF-09 SEC-IMPL-05: sanitizeErrorMessage SSOT used to prevent CWE-209
    // leakage of internal stacks / token-adjacent context.
    // MF-09 SEC-IMPL-05: sanitizeErrorMessage で CWE-209 漏洩を防止。
    child.on("error", (error: Error) => {
      logger.error("[WorkerSupervisor] Worker process error", {
        workerType,
        error: sanitizeErrorMessage(error),
        pid: child.pid,
      });
    });
  }

  /**
   * IPC dispatch entry — verifies the message via {@link verifyWorkerIpcMessage}
   * (Rule 5 / MF-02), then routes to the appropriate per-message handler.
   *
   * Verifier failure paths (per Plan §3.2.4 Rule 5 + §3.2.2 line 187):
   *   - schema-invalid / unknown-workerType (parse failure) → SIGTERM offending
   *     child + 60s suppress + audit_logs `worker_ipc_spoofing_detected`
   *   - pid binding mismatch → SIGTERM offending child + 60s suppress +
   *     audit_logs `worker_type_spoofing_detected`
   *
   * Verifier 失敗時の挙動: parse 失敗 (schema-invalid / unknown-workerType) は
   * `worker_ipc_spoofing_detected`、binding mismatch は `worker_type_spoofing_detected`
   * を audit emit。両者とも sender pid が bindingTable に存在する場合は
   * SIGTERM + 60s respawn suppress に escalate される。
   */
  private dispatchVerifiedIpc(raw: unknown, senderPid: number | undefined): void {
    const verified = verifyWorkerIpcMessage(raw, senderPid, this.bindingTable);
    if (verified === null) {
      // Verifier already logged + emitted audit_logs (either
      // `worker_ipc_spoofing_detected` for parse failure or
      // `worker_type_spoofing_detected` for binding mismatch). If sender pid
      // is known, escalate SIGTERM + 60s respawn suppress per Plan §3.2.2/§3.2.4.
      // Verifier が null 返却 + 既知 pid → SIGTERM + 60s suppress に escalate。
      if (senderPid !== undefined && this.bindingTable.has(senderPid)) {
        this.escalateSpoofing(senderPid);
      }
      return;
    }
    // Schema-valid + binding-consistent. Dispatch by message type.
    if (verified.type === "job-completed") {
      this.notifyJobCompletedForType(verified.workerType);
    } else if (verified.type === "heartbeat") {
      const childState = this.children.get(verified.workerType);
      if (childState) childState.lastHeartbeatAt = Date.now();
    } else if (verified.type === "planned-restart-request") {
      this.initiateRestart(verified.workerType, "child_request");
    } else if (verified.type === "fatal-error") {
      logger.error("[WorkerSupervisor] Child reported fatal error", {
        workerType: verified.workerType,
        jobId: verified.jobId,
      });
      this.initiateRestart(verified.workerType, "fatal_error");
    }
  }

  /**
   * SEC-02 spoofing escalation: SIGTERM offending child + 60s respawn suppress.
   * audit_logs emit happens inside `verifyWorkerIpcMessage`.
   *
   * SEC-02: 当該 child を SIGTERM、60s 再起動抑制 (audit_logs は verifier 側)。
   */
  private escalateSpoofing(senderPid: number): void {
    const workerType = this.bindingTable.get(senderPid);
    if (!workerType) return;
    const childState = this.children.get(workerType);
    if (!childState) return;
    try {
      childState.child.kill("SIGTERM");
    } catch {
      /* child already gone */
    }
    childState.restartSuppressUntil = Date.now() + 60_000;
    logger.error("[WorkerSupervisor] Spoofing detected — SIGTERM + 60s suppress", {
      workerType,
      pid: senderPid,
    });
  }

  /**
   * Per-type exit handler. PR-D-8 MF-04: invokes
   * {@link executeSelfChainedRespawn} before re-spawning, ensuring the
   * exiting child's lock has been released (or detected as foreign / stale).
   *
   * Per-type exit handler。`executeSelfChainedRespawn` を必ず call し、
   * lock の release 完了を確認してから respawn する。
   */
  private handleWorkerExit(
    workerType: WorkerType,
    code: number | null,
    signal: string | null
  ): void {
    const state = this.requirePerTypeState(workerType);
    const childState = this.children.get(workerType);
    this.logExitEvent(workerType, code, signal, state);
    this.cleanupExitedChild(workerType, childState?.pid);

    if (this.isShuttingDown) {
      state.state = "stopped";
      return;
    }

    // §3.2.4 Rule 5: spoofing suppression window — refuse to respawn until
    // restartSuppressUntil has elapsed.
    // Spoofing 検出時の suppress window — 期限内は respawn 拒否。
    if (this.shouldSuppressRespawn(workerType, childState)) {
      state.state = "crashed";
      return;
    }

    const exitedPid = childState?.pid;
    const exitedNonce = childState?.lockNonce;
    const jobsProcessed = childState?.jobsProcessed ?? 0;

    if (state.pendingRestart) {
      this.handlePlannedRestart(workerType, code, signal, exitedPid, jobsProcessed, exitedNonce);
      return;
    }
    this.handleUnexpectedExit(workerType, code, signal, exitedPid, jobsProcessed, exitedNonce);
  }

  /**
   * Emit dev-only structured log of the exit event.
   */
  private logExitEvent(
    workerType: WorkerType,
    code: number | null,
    signal: string | null,
    state: { restartCount: number; pendingRestart: boolean }
  ): void {
    if (!isDevelopment()) return;
    logger.info("[WorkerSupervisor] Worker exited", {
      workerType,
      code,
      signal,
      isShuttingDown: this.isShuttingDown,
      restartCount: state.restartCount,
      pendingRestart: state.pendingRestart,
    });
  }

  /**
   * Drop the exited child from `children` and `bindingTable`.
   */
  private cleanupExitedChild(workerType: WorkerType, exitedPid: number | undefined): void {
    if (exitedPid !== undefined && exitedPid >= 0) {
      this.bindingTable.delete(exitedPid);
    }
    this.children.delete(workerType);
  }

  /**
   * Spoofing suppression window check — extracted from {@link handleWorkerExit}
   * to keep complexity ≤ 10.
   */
  private shouldSuppressRespawn(
    workerType: WorkerType,
    childState: WorkerChildState | undefined
  ): boolean {
    const suppressUntil = childState?.restartSuppressUntil ?? null;
    if (suppressUntil === null) return false;
    const now = Date.now();
    if (now >= suppressUntil) return false;
    logger.warn("[WorkerSupervisor] Restart suppressed due to spoofing window", {
      workerType,
      suppressRemainingMs: suppressUntil - now,
    });
    return true;
  }

  /**
   * Planned-restart path — emits audit_logs and chains into the self-chained
   * respawn protocol.
   */
  private handlePlannedRestart(
    workerType: WorkerType,
    code: number | null,
    signal: string | null,
    exitedPid: number | undefined,
    jobsProcessed: number,
    exitedNonce: string | undefined
  ): void {
    const state = this.requirePerTypeState(workerType);
    state.pendingRestart = false;
    state.restartCount = 0;
    // MF-08 LCC-IMPL-01: audit_logs emit for planned restart.
    emitWorkerRestartAudit(
      workerType,
      "planned",
      jobsProcessed,
      code,
      signal,
      exitedPid,
      state.restartCount,
      "success"
    );
    void this.runSelfChainedRespawnAndSchedule(workerType, exitedNonce);
  }

  /**
   * Unexpected-exit path — applies maxRestartAttempts gate and emits the
   * matching audit_logs entry (success vs failure).
   */
  private handleUnexpectedExit(
    workerType: WorkerType,
    code: number | null,
    signal: string | null,
    exitedPid: number | undefined,
    jobsProcessed: number,
    exitedNonce: string | undefined
  ): void {
    // Fix-3 (INFRA-EMBEDDING-MOTION-SIGABRT-001): SIGABRT detection + suppress.
    const sigabrtSuppress = processSigabrtSignal(
      workerType,
      signal,
      exitedPid,
      this.sigabrtCountByWorkerType,
      this.lastSigabrtAuditByWorkerType
    );
    const state = this.requirePerTypeState(workerType);
    if (state.restartCount >= this.config.maxRestartAttempts) {
      logger.error("[WorkerSupervisor] Max restart attempts reached, giving up", {
        workerType,
        restartCount: state.restartCount,
        maxRestartAttempts: this.config.maxRestartAttempts,
        lastExitCode: code,
        lastSignal: signal,
      });
      state.state = "crashed";
      clearLockHeartbeatTimer(workerType, this.lockHeartbeatTimers); // PR-E-1 NF-6 (CWE-770)
      emitWorkerRestartAudit(
        workerType,
        "crash_max_attempts",
        jobsProcessed,
        code,
        signal,
        exitedPid,
        state.restartCount,
        "failure"
      );
      return;
    }
    state.restartCount++;
    emitWorkerRestartAudit(
      workerType,
      "unexpected_exit",
      jobsProcessed,
      code,
      signal,
      exitedPid,
      state.restartCount,
      "success"
    );
    // Fix-3: gate respawn behind a 60s suppress timer on N consecutive SIGABRTs.
    scheduleSigabrtAwareRespawn(
      sigabrtSuppress,
      () => this.isShuttingDown,
      () => void this.runSelfChainedRespawnAndSchedule(workerType, exitedNonce)
    );
  }

  /**
   * Run the self-chained respawn protocol (MF-04 / SEC-IMPL-03) and schedule
   * the actual respawn based on its outcome.
   *
   * `executeSelfChainedRespawn` の戻り値により respawn 戦略を切り替える:
   *   - `released` / `probe_failed` → 通常 delay で respawn
   *   - `ttl_fallback` → 60s 後に respawn (TTL 自然失効待ち)
   *   - `foreign_lock` → respawn 中止 (他 host の lock を尊重)
   */
  private async runSelfChainedRespawnAndSchedule(
    workerType: WorkerType,
    exitedNonce: string | undefined
  ): Promise<void> {
    const state = this.requirePerTypeState(workerType);
    state.state = "restarting";
    state.completedJobCount = 0;

    // If we never had a valid nonce (child died before WorkerChildState was
    // populated) we cannot run release; just delegate to the legacy delay.
    // 子が生成途中で exit した場合 (nonce なし) は通常 delay で respawn。
    if (!exitedNonce) {
      this.scheduleRespawn(workerType, this.config.restartDelayMs);
      return;
    }

    const lockService = this.ensureLockServiceInstance();
    if (!lockService) {
      this.scheduleRespawn(workerType, this.config.restartDelayMs);
      return;
    }

    let outcome: Awaited<ReturnType<typeof executeSelfChainedRespawn>>;
    try {
      outcome = await executeSelfChainedRespawn(lockService, workerType, exitedNonce);
    } catch (error) {
      logger.warn("[WorkerSupervisor] executeSelfChainedRespawn threw (non-fatal)", {
        workerType,
        error: sanitizeErrorMessage(error),
      });
      outcome = "probe_failed";
    }

    switch (outcome) {
      case "released":
      case "probe_failed":
        this.scheduleRespawn(workerType, this.config.restartDelayMs);
        break;
      case "ttl_fallback":
        // 60s natural expiry wait (TTL_FALLBACK_MS in plan §3.2.5).
        this.scheduleRespawn(workerType, 60_000);
        break;
      case "foreign_lock":
        // Foreign owner — fail-closed; do not respawn this type.
        logger.error("[WorkerSupervisor] Foreign lock detected — refusing respawn", {
          workerType,
        });
        state.state = "crashed";
        clearLockHeartbeatTimer(workerType, this.lockHeartbeatTimers); // PR-E-1 NF-6 (CWE-770)
        break;
      default:
        // Unreachable; fall back to default delay.
        this.scheduleRespawn(workerType, this.config.restartDelayMs);
    }
  }

  /**
   * Calculate restart delay deterministically per-type and re-spawn after the
   * timeout. shutdown 中なら respawn しない。
   */
  private scheduleRespawn(workerType: WorkerType, delayMs: number): void {
    const state = this.requirePerTypeState(workerType);
    state.state = "restarting";
    setTimeout(() => {
      if (this.isShuttingDown) {
        state.state = "stopped";
        return;
      }
      this.spawnWorker(workerType);
    }, delayMs);
  }

  /**
   * Per-type initiateRestart. PR-D-8 MF-08: emits `worker_supervisor_restart`
   * audit_log indirectly via {@link handleWorkerExit} after the actual exit
   * arrives; here we only set `pendingRestart` + send IPC shutdown.
   *
   * Per-type の initiateRestart。`pendingRestart` フラグをセットし IPC
   * shutdown を送信する。実際の audit_logs emit は exit handler 側で行う。
   */
  private initiateRestart(workerType: WorkerType, reason: string): void {
    const state = this.requirePerTypeState(workerType);
    const childState = this.children.get(workerType);
    if (isDevelopment()) {
      logger.info("[WorkerSupervisor] Initiating restart", {
        workerType,
        reason,
        completedJobCount: state.completedJobCount,
      });
    }
    if (!childState) return;

    state.state = "restarting";
    state.pendingRestart = true;
    const workerToRestart = childState.child;
    const childPid = childState.pid;

    try {
      if (workerToRestart.connected && workerToRestart.send) {
        workerToRestart.send({ type: "shutdown" });
      }
    } catch {
      logger.warn("[WorkerSupervisor] IPC shutdown message failed during restart (non-fatal)", {
        workerType,
      });
    }

    const sigTermTimerId = setTimeout(() => {
      try {
        workerToRestart.kill("SIGTERM");
      } catch {
        /* exit handler will handle */
      }
    }, IPC_SHUTDOWN_GRACE_MS);

    const killTimerId = setTimeout(() => {
      if (isDevelopment()) {
        logger.warn("[WorkerSupervisor] Restart shutdown timeout, sending SIGKILL", {
          workerType,
          pid: childPid,
        });
      }
      try {
        workerToRestart.kill("SIGKILL");
      } catch {
        /* exit handler will handle */
      }
    }, this.config.shutdownTimeoutMs);

    workerToRestart.once("exit", () => {
      clearTimeout(sigTermTimerId);
      clearTimeout(killTimerId);
    });
  }

  // ==========================================================================
  // Private — Redis active-worker lock (per-type, ADR-0011 Amendment)
  // ==========================================================================

  private ensureLockServiceInstance(): WorkerActiveLockService | null {
    if (this.lockService) return this.lockService;
    if (process.env.NODE_ENV === "test") return null;
    try {
      this.lockService = instantiateLockServiceForSupervisor();
      return this.lockService;
    } catch (error) {
      logger.warn("[WorkerSupervisor] Lock service init failed (non-fatal)", {
        error: sanitizeErrorMessage(error),
      });
      return null;
    }
  }

  /**
   * Per-type Redis lock acquisition. Best-effort. Item 3 (CO-31) / ADR-0011
   * Amendment 5 §A5.1: retry orchestration is delegated to the helper which
   * consumes `tryAcquireLock` discriminated union and retries
   * `redis_unavailable` on 100/200/400ms backoff (max 3, 700ms total).
   */
  private acquireRedisLockBestEffort(workerType: WorkerType): void {
    if (this.lockAcquired.get(workerType)) return;
    if (this.lockAcquireInflight.get(workerType)) return;
    if (process.env.NODE_ENV === "test") return;
    const lockService = this.ensureLockServiceInstance();
    if (!lockService) return;
    this.lockAcquireInflight.set(workerType, true);
    runAcquireLockWithRetryOrchestrator(lockService, workerType, this.bootTokens[workerType], {
      onAcquired: () => {
        this.lockAcquired.set(workerType, true);
        this.startLockHeartbeat(workerType);
        if (isDevelopment()) {
          logger.info("[WorkerSupervisor] Published active-worker lock to Redis", { workerType });
        }
      },
      onHeldByOther: () => {
        logger.warn("[WorkerSupervisor] active-worker lock held by another owner", { workerType });
      },
      onExhausted: () => {
        logger.warn("[WorkerSupervisor] acquireLock exhausted (fail-open final)", { workerType });
      },
      onError: (error) => {
        logger.warn("[WorkerSupervisor] acquireLock failed (non-fatal)", {
          workerType,
          error: sanitizeErrorMessage(error),
        });
      },
      onSettled: () => this.lockAcquireInflight.set(workerType, false),
    });
  }

  /**
   * Per-type heartbeat to refresh the Redis TTL.
   */
  private startLockHeartbeat(workerType: WorkerType): void {
    if (this.lockHeartbeatTimers.has(workerType) || !this.lockService) return;
    const timer = setInterval(() => {
      if (!this.lockService) return;
      void this.lockService.extendLock(workerType, this.bootTokens[workerType]).catch(() => {
        /* non-fatal */
      });
    }, LOCK_HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    this.lockHeartbeatTimers.set(workerType, timer);
  }

  /**
   * Per-type Redis lock release on shutdown.
   */
  private async releaseRedisLockBestEffort(workerType: WorkerType): Promise<void> {
    const heartbeatTimer = this.lockHeartbeatTimers.get(workerType);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      this.lockHeartbeatTimers.delete(workerType);
    }
    if (!this.lockService) return;
    try {
      if (this.lockAcquired.get(workerType)) {
        await this.lockService.releaseLock(workerType, this.bootTokens[workerType]);
      }
    } catch {
      /* best-effort */
    }
    this.lockAcquired.set(workerType, false);

    // Close service only when no other type still owns a heartbeat.
    // 他 type が heartbeat 継続中なら service close しない。
    if (this.lockHeartbeatTimers.size === 0) {
      try {
        await this.lockService.close();
      } catch {
        /* best-effort */
      }
      this.lockService = null;
    }
  }

  // ==========================================================================
  // Private — utility
  // ==========================================================================

  private requirePerTypeState(workerType: WorkerType): {
    state: WorkerState;
    completedJobCount: number;
    restartCount: number;
    pendingRestart: boolean;
  } {
    const s = this.perTypeState.get(workerType);
    if (!s) {
      // Defensive: should never happen because constructor seeds entries for
      // every WORKER_TYPES value.
      // 防御的: コンストラクタで必ず seed されているため到達不能。
      throw new Error(`WorkerSupervisor: missing per-type state for ${workerType}`);
    }
    return s;
  }
}

// PR-D-8 Phase 2 helper re-exports (TDA-V11-02 max-lines: helpers extracted).
export {
  buildDefaultWorkerTypeConfigs,
  cliFlagForWorkerType,
  emitSupervisorAuditLog,
  executeSelfChainedRespawn,
  verifyWorkerIpcMessage,
} from "./worker-supervisor-helpers";

// ============================================================================
// Lock Service Factory (DI for tests, ADR-0016 § Service DI Refactor Plan)
// ============================================================================

/**
 * Optional factory for the WorkerActiveLockService used by the supervisor.
 *
 * Tests (e.g., standing regression `worker-lifecycle` domain) can inject a
 * factory that returns a `WorkerActiveLockService` constructed with a
 * testcontainer-backed `Redis` client. When unset, the supervisor instantiates
 * `new WorkerActiveLockService()` lazily — preserving v0.4.0 production
 * behavior bit-for-bit.
 *
 * テスト (standing regression `worker-lifecycle` domain) が testcontainer
 * 由来 Redis を注入できるようにするための任意 factory。未設定時は production
 * 挙動 (lazy `new WorkerActiveLockService()`) を完全保持する。
 *
 * @see ADR-0016 § Service DI Refactor Plan (TDA-Plan-08)
 */
let lockServiceFactory: (() => WorkerActiveLockService) | null = null;

/**
 * Set the WorkerActiveLockService factory used by the supervisor.
 * @see ADR-0016 § Service DI Refactor Plan
 */
export function setWorkerSupervisorLockServiceFactory(
  factory: () => WorkerActiveLockService
): void {
  lockServiceFactory = factory;
}

/**
 * Reset the WorkerActiveLockService factory (default `new WorkerActiveLockService()`).
 * @see ADR-0016 § Service DI Refactor Plan
 */
export function resetWorkerSupervisorLockServiceFactory(): void {
  lockServiceFactory = null;
}

/**
 * @internal Used by `WorkerSupervisor.ensureWorkerRunning()` to obtain a lock
 * service via the factory if set, otherwise via direct construction.
 */
export function instantiateLockServiceForSupervisor(): WorkerActiveLockService {
  return lockServiceFactory ? lockServiceFactory() : new WorkerActiveLockService();
}

// ============================================================================
// Singleton
// ============================================================================

let supervisorInstance: WorkerSupervisor | null = null;

/**
 * デフォルト設定で WorkerSupervisor シングルトンを取得する
 *
 * page.analyze ハンドラーから呼び出される。
 * 設定は環境変数から読み取る。
 */
export function getWorkerSupervisor(): WorkerSupervisor {
  if (supervisorInstance === null) {
    const profile = computeMemoryProfile();
    supervisorInstance = new WorkerSupervisor({
      workerScript: getWorkerScriptPath(),
      workerArgs: ["--page"],
      workerEnv: {
        NODE_ENV: process.env.NODE_ENV ?? "development",
        WORKER_MEMORY_CRITICAL_MB:
          process.env.WORKER_MEMORY_CRITICAL_MB ?? String(profile.criticalThresholdMb),
        WORKER_MEMORY_DEGRADATION_MB:
          process.env.WORKER_MEMORY_DEGRADATION_MB ?? String(profile.degradationThresholdMb),
        WORKER_SELF_EXIT_THRESHOLD_MB:
          process.env.WORKER_SELF_EXIT_THRESHOLD_MB ?? String(profile.selfExitThresholdMb),
        WORKER_EMBEDDING_CHUNK_SIZE:
          process.env.WORKER_EMBEDDING_CHUNK_SIZE ?? String(profile.embeddingChunkSize),
        WORKER_JS_ANIMATION_CHUNK_SIZE:
          process.env.WORKER_JS_ANIMATION_CHUNK_SIZE ??
          String(profile.jsAnimationEmbeddingChunkSize),
        WORKER_MAX_OLD_SPACE_MB:
          process.env.WORKER_MAX_OLD_SPACE_MB ?? String(profile.maxOldSpaceSizeMb),
        // GPU/ONNX: forward ONNX_EXECUTION_PROVIDER + LD_LIBRARY_PATH (explicit
        // env or auto-detected CUDA paths) so dlopen() can find CUDA 12 libs.
        ...(process.env.ONNX_EXECUTION_PROVIDER
          ? { ONNX_EXECUTION_PROVIDER: process.env.ONNX_EXECUTION_PROVIDER }
          : {}),
        ...((): Record<string, string> => {
          if (process.env.LD_LIBRARY_PATH) {
            return { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH };
          }
          const detected = detectCudaLibPaths();
          if (detected) {
            if (isDevelopment()) {
              logger.info("[WorkerSupervisor] Auto-detected CUDA library paths");
            }
            return { LD_LIBRARY_PATH: detected };
          }
          return {};
        })(),
      },
      // OOM防止: 1ジョブごとにプロセス再起動 (env varでオーバーライド可)
      maxJobsBeforeRestart: safeParseInt(process.env.WORKER_MAX_JOBS_BEFORE_RESTART, 1),
      maxRestartAttempts: safeParseInt(process.env.WORKER_MAX_RESTART_ATTEMPTS, 10),
      shutdownTimeoutMs: safeParseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS, 10000, 1000),
      restartDelayMs: safeParseInt(process.env.WORKER_RESTART_DELAY_MS, 3000, 500),
    });
  }
  return supervisorInstance;
}

/** シングルトンインスタンスをリセット (テスト用)。 */
export function resetWorkerSupervisor(): void {
  supervisorInstance = null;
}

/**
 * ワーカースクリプトの絶対パスを取得。env `WORKER_SCRIPT_PATH` 優先、未設定時
 * は `__dirname/../scripts/start-workers.js` (dist/services/ 起点)。fork先は
 * `start-workers.js` (entrypoint) のみ — `page-analyze-worker.js` は factory
 * 関数 module で fork しても worker が起動しない。
 */
function getWorkerScriptPath(): string {
  const envPath = process.env.WORKER_SCRIPT_PATH;
  if (envPath !== undefined) {
    const resolved = path.resolve(envPath);
    const distRoot = path.resolve(__dirname, "../..");
    if (!resolved.startsWith(distRoot)) {
      logger.error("[WorkerSupervisor] WORKER_SCRIPT_PATH is outside allowed directory", {
        envPath,
        resolved,
        allowedRoot: distRoot,
      });
      throw new Error("WORKER_SCRIPT_PATH must be within the mcp-server dist directory");
    }
    return resolved;
  }
  return path.resolve(__dirname, "../scripts/start-workers.js");
}
