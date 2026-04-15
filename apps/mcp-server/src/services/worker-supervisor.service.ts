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
 *
 * @module services/worker-supervisor
 */

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger, isDevelopment } from "../utils/logger";
import { computeMemoryProfile } from "./worker-memory-profile";
import { LOCK_HEARTBEAT_INTERVAL_MS, WorkerActiveLockService } from "./worker-active-lock.service";
import { sanitizeErrorMessage } from "../utils/sanitize-error";

// ============================================================================
// CUDA Library Path Auto-Detection
// ============================================================================

/**
 * CUDA 12 ライブラリの既知パスから LD_LIBRARY_PATH を構築する。
 *
 * pip install nvidia-cudnn-cu12 等でインストールされたライブラリと
 * Ollama の CUDA v12 ライブラリを自動検出する。
 * LD_LIBRARY_PATH が未設定の場合にのみ使用される。
 *
 * SEC: ファイルシステム読み取りのみ。パスは固定リストからの検証済みディレクトリ。
 */
function detectCudaLibPaths(): string | null {
  // Python site-packages のベースパス候補（pip install 先）
  const pythonVersions = ["python3.10", "python3.11", "python3.12", "python3.8", "python3.9"];
  const homeDir = process.env.HOME ?? "/tmp";
  const baseDirs = pythonVersions.map((v) => `${homeDir}/.local/lib/${v}/site-packages/nvidia`);

  // CUDA 12 サブパッケージ名
  const cudaSubPackages = [
    "cudnn/lib",
    "cublas/lib",
    "cuda_runtime/lib",
    "cufft/lib",
    "curand/lib",
    "cuda_nvrtc/lib",
  ];

  // Ollama CUDA v12
  const ollamaCudaPath = "/usr/local/lib/ollama/cuda_v12";

  const foundPaths: string[] = [];

  // onnxruntime-node の CUDA provider ディレクトリ検出
  // IMPORTANT: onnxruntime-node のバージョンが複数存在する場合（例: 直接依存と
  // @huggingface/transformers 経由の間接依存）、LD_LIBRARY_PATH にバージョン不一致の
  // shared library を含めると ABI エラー（VERS_x.y.z not found）が発生する。
  // require.resolve で解決されたパッケージの bin/ ディレクトリのみを使用する。
  try {
    const ortNodePath = require.resolve("onnxruntime-node");
    let packageDir = path.dirname(ortNodePath);
    for (let i = 0; i < 5; i++) {
      if (fs.existsSync(path.join(packageDir, "package.json"))) break;
      packageDir = path.dirname(packageDir);
    }
    // Verify the resolved package version matches by checking that
    // libonnxruntime.so.1 exists alongside the CUDA provider
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
    // onnxruntime-node not found — skip
  }

  // pip パッケージからの検出
  for (const baseDir of baseDirs) {
    let allFound = true;
    const candidatePaths: string[] = [];

    for (const subPkg of cudaSubPackages) {
      const fullPath = path.join(baseDir, subPkg);
      if (fs.existsSync(fullPath)) {
        candidatePaths.push(fullPath);
      } else {
        allFound = false;
      }
    }

    // すべてのサブパッケージが見つかった場合のみ採用
    if (allFound && candidatePaths.length === cudaSubPackages.length) {
      foundPaths.push(...candidatePaths);
      break; // 最初に見つかった Python バージョンを使用
    }
  }

  // Ollama CUDA
  if (fs.existsSync(ollamaCudaPath)) {
    foundPaths.push(ollamaCudaPath);
  }

  if (foundPaths.length === 0) {
    return null;
  }

  return foundPaths.join(":");
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
 * ワーカーからスーパーバイザーへのIPCメッセージ型
 *
 * P1-D: job-completed — BullMQ Worker.on('completed') で送信。
 *       maxJobsBeforeRestart カウンタの駆動に使用。
 */
export interface WorkerMessage {
  type: "job-completed";
  jobId?: string;
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
 * ワーカープロセスの監視・再起動を行うスーパーバイザー
 *
 * child_process.fork で子プロセスとしてワーカーを起動し、
 * OOMクラッシュや計画的なメモリリフレッシュのためにプロセスを自動再起動する。
 */
export class WorkerSupervisor {
  private readonly config: Required<Omit<WorkerSupervisorOptions, "workerArgs" | "workerEnv">> &
    Pick<WorkerSupervisorOptions, "workerArgs" | "workerEnv">;
  private worker: ChildProcess | null = null;
  private state: WorkerState = "idle";
  private completedJobCount = 0;
  private restartCount = 0;
  private isShuttingDown = false;
  private pendingRestart = false;
  /**
   * v0.4.0 PR7d-2: Per-supervisor boot token. Generated once at construction
   * time and propagated to every fork child via env so that child processes
   * can self-identify as "supervised" and skip the Redis-based dual-run
   * guard in start-workers.ts.
   *
   * v0.4.0 PR7d-2: supervisor 固有の boot token。構築時に 1 回だけ生成され、
   * 全 fork 子プロセスに env 経由で伝播する。子プロセスは自身を "supervised"
   * と識別し、start-workers.ts の Redis ベース二重起動ガードを skip する。
   */
  private readonly bootToken: string = randomUUID();

  /**
   * v0.4.0 PR7d-2: Lock service used to publish our boot token to Redis so
   * that manual `pnpm worker:start:page` invocations can detect us and refuse
   * to start. Lazily created on first `ensureWorkerRunning()` call.
   *
   * v0.4.0 PR7d-2: boot token を Redis へ publish するための lock サービス。
   * 手動 `pnpm worker:start:page` 起動時に検出・拒否させるために使う。
   */
  private lockService: WorkerActiveLockService | null = null;
  private lockAcquired = false;
  private lockHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * v0.4.0 PR7d-3 (TPA LOW-1): guard against re-entrant acquisition attempts.
   * Without this flag, rapid successive `ensureWorkerRunning()` calls could
   * fire multiple concurrent `acquireLock()` invocations against Redis (one
   * would succeed, others would waste round-trips and log warnings).
   *
   * v0.4.0 PR7d-3 (TPA LOW-1): 連続 `ensureWorkerRunning()` 呼び出しで
   * `acquireLock()` が多重実行されることを防止する inflight フラグ。
   */
  private lockAcquireInflight = false;

  constructor(options: WorkerSupervisorOptions) {
    this.config = {
      ...options,
      restartDelayMs: options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
    };
  }

  /**
   * Boot token for this supervisor. Exposed for test assertions only.
   *
   * @internal exposed for tests
   */
  getBootToken(): string {
    return this.bootToken;
  }

  /**
   * ワーカーが起動していなければ起動する
   *
   * 冪等操作: 既にrunning状態なら何もしない。
   * crashed/idle 状態なら新しいワーカーを fork する。
   */
  ensureWorkerRunning(): void {
    // 既に起動中なら何もしない
    if (this.state === "running" && this.worker !== null) {
      return;
    }

    // shutdown済みの場合は再起動しない
    if (this.state === "stopped") {
      return;
    }

    // 再起動中の場合は何もしない（再起動タイマーが処理する）
    if (this.state === "restarting") {
      return;
    }

    // v0.4.0 PR7d-2: Publish our boot token to Redis on first spawn so that
    // manual Worker invocations can detect us. Best-effort: failure to
    // acquire the lock does NOT block supervised worker startup — we still
    // own the fork path, and a manual Worker running concurrently with us
    // will collide on BullMQ itself (which is the bug we're working around,
    // not preventing here). The guard lives in start-workers.ts where it
    // can early-exit cleanly.
    // v0.4.0 PR7d-2: 初回 spawn 時に boot token を Redis に publish し、手動
    // Worker 起動時に検出させる。ベストエフォート: lock 取得失敗は supervisor
    // 起動を妨げない (fork 経路は我々が握っており、手動 Worker との衝突は
    // start-workers.ts の guard が対処する)。
    this.acquireRedisLockBestEffort();

    // crashed状態からの自動復旧: 新しいジョブ投入時にリセット
    // maxRestartAttempts超過でcrashedになった後でも、根本原因（swap枯渇等）が
    // 解消されていれば再起動可能にする
    if (this.state === "crashed") {
      logger.info("[WorkerSupervisor] Auto-resetting from crashed state for new job submission", {
        previousRestartCount: this.restartCount,
      });
      this.restartCount = 0;
      this.state = "idle";
    }

    this.spawnWorker();
  }

  /**
   * 現在のワーカー状態を取得
   */
  getState(): WorkerState {
    return this.state;
  }

  /**
   * 完了ジョブカウントを取得
   */
  getCompletedJobCount(): number {
    return this.completedJobCount;
  }

  /**
   * 再起動回数を取得
   */
  getRestartCount(): number {
    return this.restartCount;
  }

  /**
   * ジョブ完了を通知
   *
   * 内部カウンタをインクリメントし、maxJobsBeforeRestart に達したら
   * ワーカーを graceful restart する。
   */
  notifyJobCompleted(): void {
    this.completedJobCount++;

    if (isDevelopment()) {
      logger.debug("[WorkerSupervisor] Job completed", {
        completedJobCount: this.completedJobCount,
        maxJobsBeforeRestart: this.config.maxJobsBeforeRestart,
      });
    }

    // N件到達で計画的再起動
    if (this.completedJobCount >= this.config.maxJobsBeforeRestart) {
      this.initiateRestart("job_count_threshold");
    }
  }

  /**
   * graceful shutdown
   *
   * 3段階のシャットダウンプロトコル:
   * 1. IPCメッセージ 'shutdown' を送信 → BullMQ Worker.close() を先行実行させる
   * 2. SIGTERM を送信 → プロセスレベルの graceful shutdown
   * 3. shutdownTimeoutMs 超過時 → SIGKILL エスカレーション
   *
   * IPCメッセージ送信により、BullMQ Workerがclose()を完了してからプロセスが
   * 終了する機会を確保する。これにより、処理中のジョブがorphanedになるリスクを軽減する。
   *
   * ワーカー未起動時はエラーなしで即座に完了する。
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // v0.4.0 PR7d-2: Release the Redis active-worker lock so any subsequent
    // manual Worker invocation can start without collision. Fire-and-forget —
    // do NOT await here, otherwise the IPC 'shutdown' / SIGTERM sequence below
    // is delayed by a microtask and breaks tests that assert on synchronous
    // send() call ordering (and adds latency to real shutdowns without benefit
    // since the lock release is best-effort anyway).
    // v0.4.0 PR7d-2: Redis active-worker lock を解放する。fire-and-forget で
    // 実行 — await すると下の IPC shutdown / SIGTERM シーケンスが microtask
    // 分だけ遅延し、同期的な send() 呼び出し順を前提としたテストが壊れる
    // (かつ lock 解放は best-effort なので待つ意義がない)。
    void this.releaseRedisLockBestEffort();

    // ワーカー未起動の場合
    if (this.worker === null) {
      this.state = "stopped";
      return;
    }

    const workerToKill = this.worker;

    return new Promise<void>((resolve) => {
      let killTimerId: ReturnType<typeof setTimeout> | null = null;
      let sigTermTimerId: ReturnType<typeof setTimeout> | null = null;

      const onExit = (): void => {
        if (killTimerId !== null) {
          clearTimeout(killTimerId);
          killTimerId = null;
        }
        if (sigTermTimerId !== null) {
          clearTimeout(sigTermTimerId);
          sigTermTimerId = null;
        }
        this.worker = null;
        this.state = "stopped";
        resolve();
      };

      // exit イベントを一度だけリッスン
      workerToKill.once("exit", onExit);

      // Phase 1: IPC 'shutdown' メッセージを送信
      // BullMQ Worker.close() を先行呼び出しさせ、ロック解放を保証
      try {
        if (workerToKill.connected && workerToKill.send) {
          workerToKill.send({ type: "shutdown" });
          if (isDevelopment()) {
            logger.debug("[WorkerSupervisor] Sent IPC shutdown message", {
              pid: workerToKill.pid,
            });
          }
        }
      } catch {
        // IPC送信失敗は致命的でない（SIGTERMにフォールバック）
        logger.warn("[WorkerSupervisor] IPC shutdown message failed (non-fatal)");
      }

      // Phase 2: 2秒後にSIGTERMを送信（BullMQ close()に時間を与える）
      sigTermTimerId = setTimeout(() => {
        sigTermTimerId = null;
        try {
          workerToKill.kill("SIGTERM");
        } catch {
          // プロセスが既に終了している場合
          onExit();
          return;
        }
      }, 2000);

      // Phase 3: タイムアウト後に SIGKILL エスカレーション
      killTimerId = setTimeout(() => {
        killTimerId = null;
        if (isDevelopment()) {
          logger.warn("[WorkerSupervisor] Shutdown timeout, sending SIGKILL", {
            pid: workerToKill.pid,
            timeoutMs: this.config.shutdownTimeoutMs,
          });
        }

        try {
          workerToKill.kill("SIGKILL");
        } catch {
          // プロセスが既に終了している場合
          onExit();
        }
      }, this.config.shutdownTimeoutMs);
    });
  }

  /**
   * ワーカーの ChildProcess を取得（テスト/モニタリング用）
   */
  getWorkerProcess(): ChildProcess | null {
    return this.worker;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * v0.4.0 PR7d-2: Publish our boot token to Redis so that manual
   * `pnpm worker:start:page` processes can detect us. Best-effort —
   * failures are logged as warnings, never thrown.
   *
   * v0.4.0 PR7d-2: 手動 Worker から検出可能にするため boot token を Redis に
   * 書き込む。ベストエフォート (失敗は warn のみで throw しない)。
   */
  private acquireRedisLockBestEffort(): void {
    if (this.lockAcquired) return;
    // v0.4.0 PR7d-3 (TPA LOW-1): prevent re-entrant acquires. Without this
    // flag, rapid successive `ensureWorkerRunning()` calls would fire
    // concurrent `acquireLock()` invocations; this flag serialises them.
    // v0.4.0 PR7d-3 (TPA LOW-1): 同時多重 acquire を防止する。
    if (this.lockAcquireInflight) return;
    // Skip entirely in test mode — Vitest's maxWorkers parallelism would
    // race on the same Redis key across test processes.
    // テストモード (NODE_ENV=test) では skip。Vitest の並列実行で
    // 同一 Redis key を奪い合うことを避ける。
    if (process.env.NODE_ENV === "test") return;

    try {
      if (!this.lockService) {
        this.lockService = new WorkerActiveLockService();
      }
      this.lockAcquireInflight = true;
      // Fire-and-forget — we don't block spawn on Redis availability.
      // Fire-and-forget: Redis 可用性で spawn をブロックしない。
      void this.lockService
        .acquireLock("page", this.bootToken)
        .then((ok) => {
          if (ok) {
            this.lockAcquired = true;
            this.startLockHeartbeat();
            if (isDevelopment()) {
              logger.info("[WorkerSupervisor] Published active-worker lock to Redis", {
                workerType: "page",
              });
            }
          } else {
            logger.warn(
              "[WorkerSupervisor] Could not acquire active-worker lock (another owner present)"
            );
          }
        })
        .catch((error) => {
          logger.warn("[WorkerSupervisor] acquireLock failed (non-fatal)", {
            error: sanitizeErrorMessage(error),
          });
        })
        .finally(() => {
          this.lockAcquireInflight = false;
        });
    } catch (error) {
      this.lockAcquireInflight = false;
      logger.warn("[WorkerSupervisor] Lock service init failed (non-fatal)", {
        error: sanitizeErrorMessage(error),
      });
    }
  }

  /**
   * Start the lock-heartbeat interval so the TTL is refreshed every
   * LOCK_HEARTBEAT_INTERVAL_MS. No-op if heartbeat already running.
   *
   * lock TTL を延長する heartbeat interval を起動する。既に稼働中なら no-op。
   */
  private startLockHeartbeat(): void {
    if (this.lockHeartbeatTimer !== null || !this.lockService) return;
    this.lockHeartbeatTimer = setInterval(() => {
      if (!this.lockService) return;
      void this.lockService.extendLock("page", this.bootToken).catch(() => {
        /* non-fatal */
      });
    }, LOCK_HEARTBEAT_INTERVAL_MS);
    // Don't block event loop shutdown on this timer.
    this.lockHeartbeatTimer.unref?.();
  }

  /**
   * Release the Redis active-worker lock during shutdown. Best-effort.
   *
   * Shutdown 時に Redis の active-worker lock を解放する (ベストエフォート)。
   */
  private async releaseRedisLockBestEffort(): Promise<void> {
    if (this.lockHeartbeatTimer !== null) {
      clearInterval(this.lockHeartbeatTimer);
      this.lockHeartbeatTimer = null;
    }
    if (!this.lockService) return;
    try {
      if (this.lockAcquired) {
        await this.lockService.releaseLock("page", this.bootToken);
      }
      await this.lockService.close();
    } catch {
      /* best-effort */
    }
    this.lockAcquired = false;
    this.lockService = null;
  }

  /**
   * ワーカーを fork で起動する
   */
  private spawnWorker(): void {
    const { workerScript, workerArgs, workerEnv } = this.config;

    if (isDevelopment()) {
      logger.info("[WorkerSupervisor] Spawning worker", {
        script: workerScript,
        args: workerArgs,
        restartCount: this.restartCount,
      });
    }

    // 環境変数を構築（process.env + workerEnv でマージ）
    const env: Record<string, string | undefined> = { ...process.env };
    if (workerEnv) {
      for (const [key, value] of Object.entries(workerEnv)) {
        env[key] = value;
      }
    }

    // v0.4.0 PR7d-2: Mark fork children so they skip start-workers.ts
    // Redis-based dual-run guard. Without this flag a fork child would
    // detect its own supervisor parent's lock and refuse to start.
    // v0.4.0 PR7d-2: fork 子プロセスに識別フラグを付与。これが無いと
    // 子が親 supervisor の lock を自己検出して起動拒否ループに陥る。
    env.REFTRIX_WORKER_IS_CHILD = "1";
    env.REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN = this.bootToken;

    // OOM-1: glibc malloc arena 断片化を防止
    // デフォルトの 8 * num_cpus ではマルチコアマシンで大量の arena が生成され、
    // Sharp/libvips や Node.js Buffer の確保/解放サイクルで RSS が膨張する。
    // MALLOC_ARENA_MAX=2 で arena 数を制限し、解放メモリの OS 返却を促進。
    // OOM-1: Prevent glibc malloc arena fragmentation.
    // Default 8 * num_cpus creates excessive arenas on multi-core machines,
    // causing RSS bloat from Sharp/libvips and Node.js Buffer alloc/free cycles.
    // MALLOC_ARENA_MAX=2 limits arenas and promotes OS memory return.
    if (!env.MALLOC_ARENA_MAX) {
      env.MALLOC_ARENA_MAX = "2";
    }

    // V8ヒープ上限を動的に設定（workerEnvから取得、未設定時はcomputeMemoryProfile()で算出）
    const maxOldSpace =
      env.WORKER_MAX_OLD_SPACE_MB ?? String(computeMemoryProfile().maxOldSpaceSizeMb);
    const execArgv = [`--max-old-space-size=${maxOldSpace}`, "--expose-gc"];

    const child = fork(workerScript, workerArgs ?? [], {
      execArgv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env,
      // ワーカープロセスのcwdをmcp-serverのdist/ルートに設定
      // __dirnameはビルド後 apps/mcp-server/dist/services/ なので、
      // ../.. で apps/mcp-server/dist/ を指す
      cwd: path.resolve(__dirname, "../.."),
    });

    this.worker = child;
    this.state = "running";

    // stdout/stderr をログに接続
    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        if (isDevelopment()) {
          logger.debug(`[WorkerSupervisor:stdout] ${data.toString().trimEnd()}`);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        const message = data.toString().trimEnd();
        // stderr からのログは warn レベルで出力
        logger.warn(`[WorkerSupervisor:stderr] ${message}`);
      });
    }

    // exit イベントハンドラー
    child.on("exit", (code: number | null, signal: string | null) => {
      this.handleWorkerExit(code, signal);
    });

    // P1-D: IPC message handler for job-completed notifications
    child.on("message", (message: unknown) => {
      if (typeof message === "object" && message !== null && "type" in message) {
        const msg = message as { type: string; jobId?: string };
        if (msg.type === "job-completed") {
          this.notifyJobCompleted();
        }
      }
    });

    // error イベントハンドラー（spawn失敗など）
    child.on("error", (error: Error) => {
      logger.error("[WorkerSupervisor] Worker process error", {
        error: error.message,
        pid: child.pid,
      });
    });

    if (isDevelopment()) {
      logger.info("[WorkerSupervisor] Worker spawned", {
        pid: child.pid,
        state: this.state,
      });
    }
  }

  /**
   * ワーカーの exit イベントを処理する
   *
   * shutdown 中でなければ自動再起動を試みる。
   * maxRestartAttempts を超過した場合は crashed 状態に遷移する。
   */
  private handleWorkerExit(code: number | null, signal: string | null): void {
    if (isDevelopment()) {
      logger.info("[WorkerSupervisor] Worker exited", {
        code,
        signal,
        isShuttingDown: this.isShuttingDown,
        restartCount: this.restartCount,
        pendingRestart: this.pendingRestart,
      });
    }

    this.worker = null;

    // shutdown 中なら再起動しない（shutdown() のPromiseが解決する）
    if (this.isShuttingDown) {
      this.state = "stopped";
      return;
    }

    // 計画的再起動（notifyJobCompletedトリガー）の場合
    if (this.pendingRestart) {
      this.pendingRestart = false;
      // Planned restarts are healthy lifecycle churn, not crash accumulation.
      this.restartCount = 0;
      this.scheduleRestart();
      return;
    }

    // maxRestartAttempts チェック
    if (this.restartCount >= this.config.maxRestartAttempts) {
      logger.error("[WorkerSupervisor] Max restart attempts reached, giving up", {
        restartCount: this.restartCount,
        maxRestartAttempts: this.config.maxRestartAttempts,
        lastExitCode: code,
        lastSignal: signal,
      });
      this.state = "crashed";
      return;
    }

    // 予期しないクラッシュ: 自動再起動をスケジュール
    this.restartCount++;
    this.scheduleRestart();
  }

  /**
   * 計画的再起動を開始する
   *
   * P1-E: shutdown() と同じ3-Phase Shutdown Protocol を適用。
   * 直接SIGTERMを送信するのではなく、IPC shutdown → 猶予 → SIGTERM → タイムアウト → SIGKILL
   * の順序でワーカーを停止し、BullMQ Worker.close() によるロック解放を保証する。
   * exit ハンドラーで pendingRestart フラグを検出して再起動をスケジュールする。
   */
  private initiateRestart(reason: string): void {
    if (isDevelopment()) {
      logger.info("[WorkerSupervisor] Initiating restart", {
        reason,
        completedJobCount: this.completedJobCount,
      });
    }

    if (this.worker === null) {
      return;
    }

    this.state = "restarting";
    this.pendingRestart = true;

    const workerToRestart = this.worker;

    // Note: Phase 0 (IPC pause) は削除済み。
    // Pre-return pause パターンにより、Processor内で worker.pause(true) が呼ばれ
    // BullMQ moveToCompleted の fetchNext=false が保証されている。
    // IPC経由のpauseは moveToCompleted Lua実行後に到着するため効果がなかった。

    // Phase 1: IPC 'shutdown' メッセージを送信
    // BullMQ Worker.close() を先行呼び出しさせ、ロック解放を保証
    try {
      if (workerToRestart.connected && workerToRestart.send) {
        workerToRestart.send({ type: "shutdown" });
        if (isDevelopment()) {
          logger.debug("[WorkerSupervisor] Sent IPC shutdown message for restart", {
            pid: workerToRestart.pid,
          });
        }
      }
    } catch {
      // IPC送信失敗は致命的でない（SIGTERMにフォールバック）
      logger.warn("[WorkerSupervisor] IPC shutdown message failed during restart (non-fatal)");
    }

    // Phase 2: 猶予後にSIGTERMを送信（BullMQ close()に時間を与える）
    const sigTermTimerId = setTimeout(() => {
      try {
        workerToRestart.kill("SIGTERM");
      } catch {
        // プロセスが既に終了している場合 — exit ハンドラーが処理する
      }
    }, IPC_SHUTDOWN_GRACE_MS);

    // Phase 3: タイムアウト後に SIGKILL エスカレーション
    const killTimerId = setTimeout(() => {
      if (isDevelopment()) {
        logger.warn("[WorkerSupervisor] Restart shutdown timeout, sending SIGKILL", {
          pid: workerToRestart.pid,
          timeoutMs: this.config.shutdownTimeoutMs,
        });
      }

      try {
        workerToRestart.kill("SIGKILL");
      } catch {
        // プロセスが既に終了している場合 — exit ハンドラーが処理する
      }
    }, this.config.shutdownTimeoutMs);

    // exit イベントでタイマーをクリア（handleWorkerExit前に実行される）
    workerToRestart.once("exit", () => {
      clearTimeout(sigTermTimerId);
      clearTimeout(killTimerId);
    });
  }

  /**
   * 遅延後にワーカーを再起動する
   */
  private scheduleRestart(): void {
    this.state = "restarting";
    this.completedJobCount = 0;

    setTimeout(() => {
      // shutdown が呼ばれていたら再起動しない
      if (this.isShuttingDown) {
        this.state = "stopped";
        return;
      }

      this.spawnWorker();
    }, this.config.restartDelayMs);
  }
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
        // GPU/ONNX settings: forward env vars, or auto-detect CUDA library paths.
        // LD_LIBRARY_PATH must be set at fork() time so the dynamic linker can find
        // CUDA 12 libraries (cudnn, cublas, etc.) when dlopen() is called by ONNX Runtime.
        ...(process.env.ONNX_EXECUTION_PROVIDER
          ? { ONNX_EXECUTION_PROVIDER: process.env.ONNX_EXECUTION_PROVIDER }
          : {}),
        ...((): Record<string, string> => {
          // Prefer explicit LD_LIBRARY_PATH from environment
          if (process.env.LD_LIBRARY_PATH) {
            return { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH };
          }
          // Auto-detect CUDA library paths from pip packages and Ollama
          const detected = detectCudaLibPaths();
          if (detected) {
            if (isDevelopment()) {
              logger.info(
                "[WorkerSupervisor] Auto-detected CUDA library paths for LD_LIBRARY_PATH"
              );
            }
            return { LD_LIBRARY_PATH: detected };
          }
          return {};
        })(),
      },
      // OOM防止: 1ジョブごとにプロセス再起動でRSSを完全リセット (env varでオーバーライド可)
      maxJobsBeforeRestart: safeParseInt(process.env.WORKER_MAX_JOBS_BEFORE_RESTART, 1),
      maxRestartAttempts: safeParseInt(process.env.WORKER_MAX_RESTART_ATTEMPTS, 10),
      shutdownTimeoutMs: safeParseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS, 10000, 1000),
      restartDelayMs: safeParseInt(process.env.WORKER_RESTART_DELAY_MS, 3000, 500),
    });
  }
  return supervisorInstance;
}

/**
 * シングルトンインスタンスをリセットする（テスト用）
 */
export function resetWorkerSupervisor(): void {
  supervisorInstance = null;
}

/**
 * ワーカースクリプトの絶対パスを取得する
 *
 * 環境変数 WORKER_SCRIPT_PATH が設定されていればそれを使用し、
 * なければ __dirname から相対パスで解決する。
 *
 * __dirname はビルド後 apps/mcp-server/dist/services/ になるため、
 * path.resolve(__dirname, '../scripts/start-workers.js') で
 * apps/mcp-server/dist/scripts/start-workers.js を指す。
 *
 * 重要: fork先は start-workers.js（エントリーポイント）でなければならない。
 * page-analyze-worker.js は BullMQ Worker のファクトリ関数を定義したモジュールであり、
 * fork しても createPageAnalyzeWorker() が呼ばれないため、ワーカーは起動しない。
 * start-workers.js はサービス初期化（Prisma, Embedding, Redis接続確認）を行い、
 * --page 引数で PageAnalyzeWorker のみを起動するエントリーポイントである。
 *
 * これにより、MCPサーバーのcwdがプロジェクトルートであっても
 * 正しいワーカースクリプトパスが解決される。
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
