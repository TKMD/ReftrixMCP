// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerSupervisor Service — Facade Module (Module A)
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
 * CO-26 split (Phase 2 Step 5): mechanical 3-module split.
 *   - Module A (this file): facade — class composition + public types + singleton + DI factory + cuda detection + script path resolver + re-export shim
 *   - Module B (`worker-supervisor-lifecycle.service.ts`): spawn / IPC dispatch / exit handling / initiated restart / IPC_SHUTDOWN_GRACE_MS
 *   - Module C (`worker-supervisor-lock-orchestrator.service.ts`): Redis active-worker lock orchestration (acquire / release / heartbeat / instance lifecycle)
 *
 * Module A is the **single owner** of WorkerSupervisor state; Modules B and C
 * receive the WorkerSupervisor reference via constructor and access cross-module
 * callables via `this.supervisor.getLifecycle()` / `this.supervisor.getLockOrchestrator()`
 * indirect path (TPA-01 explicit state-sharing accessor pattern). Modules B and C
 * never directly import each other (INV-WORKER-MODULE-IMPORT-CYCLE-001 AST gate).
 *
 * @see  (CO-26 split design)
 * @see ADR-0011 § Worker Dual-run Prevention
 * @module services/worker-supervisor
 */

import { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { v7 as uuidv7 } from "uuid";
import { logger, isDevelopment } from "../utils/logger";
import { computeMemoryProfile } from "./worker-memory-profile";
import { PER_JOB_LOCK_KEY_NAMESPACE, WorkerActiveLockService } from "./worker-active-lock.service";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { WORKER_TYPES, type WorkerType } from "../types/worker-type";
import type { WorkerIpcMessage } from "../schemas/worker-ipc.schema";
import { buildBootTokens, buildDefaultWorkerTypeConfigs } from "./worker-supervisor-helpers";
import { WorkerSupervisorLifecycle } from "./worker-supervisor-lifecycle.service";
import { WorkerSupervisorLockOrchestrator } from "./worker-supervisor-lock-orchestrator.service";

// Plan v3 Track T4 (PR-V3-T4) UNBLOCK-T4-04 — Module B DI lift.
// PrismaClient is imported at Module A only; Module B / Module C / failure-path
// service consume it via `WorkerSupervisor.getPrismaClient()` accessor (DI
// inversion) instead of a direct `@reftrixmcp/database` import. Test fixtures
// override via {@link WorkerSupervisor.setPrismaClientForTesting}.
//
// UNBLOCK-T4-04 Module B DI lift: Module A owns the Prisma client; Module B
// consumes it through the `getPrismaClient()` accessor.
import { prisma as defaultPrismaClient } from "@reftrixmcp/database";
import type { PrismaClient } from "@prisma/client";

// ============================================================================
// CUDA Library Path Auto-Detection
// ============================================================================

/**
 * CUDA 12 ライブラリの既知パスから LD_LIBRARY_PATH を構築する (pip install
 * nvidia-cudnn-cu12 + Ollama CUDA v12 自動検出)。LD_LIBRARY_PATH 未設定時のみ。
 * SEC: ファイルシステム読み取りのみ、パスは固定リスト。
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
// Public Types
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
  // Plan v4.4 PR-N-A / ADR-0035 Amendment 1 §Decision 5:
  // `restartDelayMs` field removed. Per-type restart cooldown is resolved
  // exclusively via the module-level `getRestartDelayMsForType(workerType)`
  // helper, which reads `WORKER_RESTART_DELAY_MS` (page) or
  // `EMBEDDING_BACKFILL_RESTART_DELAY_MS` (embedding-backfill) env vars.
  // Plan v4.1 CWE-770 41.67h/day DoS boundary preserved via
  // `PAGE_RESTART_DELAY_MS_MIN = 500` (see below).
}

/**
 * WorkerSupervisorの状態
 */
export type WorkerState = "idle" | "running" | "restarting" | "stopped" | "crashed";

/**
 * Legacy IPC message type alias (deprecated, use {@link WorkerIpcMessage}).
 *
 * @deprecated Use {@link WorkerIpcMessage} (schemas/worker-ipc.schema).
 */
export type WorkerMessage = WorkerIpcMessage;

/**
 * Per-{@link WorkerType} supervisor configuration. PR-D-8 §3.2.3.
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
  /** Env var name used to propagate this type's boot token to the child. */
  bootTokenEnv: string;
  /** Env var name the child reads to self-identify its WorkerType. */
  childTypeEnv: string;
  /** Staggered-spawn priority. */
  schedulingPriority: "primary" | "secondary";
}

/**
 * Per-child runtime state held by the supervisor. PR-D-8 §3.2.3.
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
  /** SEC-02 Rule 5 spoofing / TTL fallback suppression deadline (epoch ms). */
  restartSuppressUntil: number | null;
}

// ============================================================================
// Default Configuration
// ============================================================================

// Plan v4.4 PR-N-A / ADR-0035 Amendment 1 §Decision 5:
// `DEFAULT_RESTART_DELAY_MS = 1000` orphan constant removed. Per-type
// canonical defaults (`DEFAULT_PAGE_RESTART_DELAY_MS = 3000` /
// `DEFAULT_BACKFILL_RESTART_DELAY_MS = 8000`) are defined below and routed
// via `getRestartDelayMsForType(workerType)` (ADR-0035 §Decision 3 canonical
// SSOT). INV-WORKER-RESTART-DELAY-SSOT-001 standing test guards the
// forward-compat AST sweep for hardcoded literal regression.

/**
 * Plan v4.3 PR-M-A: per-type cooldown for the embedding-backfill WorkerType.
 *
 * 旧実装は `page` / `embedding-backfill` 双方が `WORKER_RESTART_DELAY_MS`
 * (default 3000ms) を共有していたため、embedding-backfill の OOM 連鎖再起動
 * 抑制目的に 8000ms の独立 cooldown を導入する。`page` worker の cooldown は
 * 不変 (Plan v4.1 CWE-770 41.67h/day DoS closure を維持する境界制約)。
 *
 * Plan v4.3 PR-M-A — independent restart delay for embedding-backfill
 * workers (default 8000ms; `EMBEDDING_BACKFILL_RESTART_DELAY_MS` env override
 * with range 500..86400000ms). `page` worker restart cooldown is unchanged
 * (Plan v4.1 CWE-770 boundary preserved).
 */
const DEFAULT_BACKFILL_RESTART_DELAY_MS = 8000;
const BACKFILL_RESTART_DELAY_MS_MIN = 500;
const BACKFILL_RESTART_DELAY_MS_MAX = 86_400_000;

/**
 * 環境変数を安全にパースする（NaN、最小値未満はデフォルトにフォールバック）
 *
 * Plan v4.3 PR-M-A: optional `max` parameter for range-validated parsing
 * (used by `EMBEDDING_BACKFILL_RESTART_DELAY_MS` to bound the cooldown).
 */
function safeParseInt(
  value: string | undefined,
  defaultValue: number,
  min: number = 1,
  max?: number
): number {
  if (value === undefined || value === "") return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < min) return defaultValue;
  if (max !== undefined && parsed > max) return defaultValue;
  return parsed;
}

// ============================================================================
// Plan v4.3 PR-M-A refinement (PR-M Phase 2 Step 6 Quality Gate fix)
// ----------------------------------------------------------------------------
// ADR-0035 §Decision 3 canonical contract: `getRestartDelayMsForType(workerType)`
// として module-level helper を export し、worker-supervisor-lifecycle.service.ts
// の 4 callsites + INV-EMBEDDING-WORKER-INIT-001 standing test contract に
// 整合させる。
//
// PR-M-A 初版は instance method overload (`getRestartDelayMs(workerType?)`) を
// 採用したが、ADR-0035 §Decision 3 canonical name とは divergence していた
// (anchor `019e3087-59de`)。PR-M-C test (anchor `019e3091-8450`) は
// module-level named export を expect しており、本 helper でその contract を
// 満たす。
//
// Legacy CLI flag `"page-analyze"` は START_WORKERS_CLI_MAPPING (types/worker-type.ts)
// と同じ rationale で `"page"` に正規化する (1-cycle backward compat)。
//
// 環境変数 semantics:
//   - `embedding-backfill` → `EMBEDDING_BACKFILL_RESTART_DELAY_MS`
//     (default 8000ms, range 500..86400000ms)
//   - `page` (+ legacy `page-analyze`) → `WORKER_RESTART_DELAY_MS`
//     (default 3000ms, Plan v4.1 CWE-770 41.67h/day DoS boundary preserved)
//
// ADR-0035 §Decision 3 canonical contract — module-level named export of
// `getRestartDelayMsForType(workerType)`, aligning with the 4 callsites in
// `worker-supervisor-lifecycle.service.ts` and the INV-EMBEDDING-WORKER-INIT-001
// standing test (PR-M-C anchor `019e3091-8450`). Plan v4.3 PR-M-A initial
// landing used an instance-method overload form (`getRestartDelayMs(workerType?)`,
// anchor `019e3087-59de`); this refinement reconciles the contract divergence.
// Legacy CLI flag `"page-analyze"` is normalised to `"page"` per the same
// rationale as `START_WORKERS_CLI_MAPPING` in `types/worker-type.ts`.
// ============================================================================

const DEFAULT_PAGE_RESTART_DELAY_MS = 3000;
// Plan v4.4 PR-N-A / ADR-0035 Amendment 1 §Decision 5:
// `PAGE_RESTART_DELAY_MS_MIN` raised from `1` → `500` per SEC M-01 CWE-770
// boundary preservation (Plan v4.1 41.67h/day DoS upper bound). Values below
// 500ms are rejected and fall back to `DEFAULT_PAGE_RESTART_DELAY_MS`. This
// matches the `BACKFILL_RESTART_DELAY_MS_MIN = 500` lower bound for
// symmetry and INV-PAGE-RESTART-DELAY-MIN-BOUND-CWE770-001 verifies the
// boundary semantic.
const PAGE_RESTART_DELAY_MS_MIN = 500;

/**
 * ADR-0035 §Decision 3 canonical per-type restart cooldown helper.
 *
 * Resolves the planned-restart cooldown for the given WorkerType by reading
 * the per-type env override (with NaN/range guards) and falling back to the
 * default value defined in the ADR.
 *
 * - `embedding-backfill` → `EMBEDDING_BACKFILL_RESTART_DELAY_MS`
 *   (default 8000ms, range 500..86400000ms)
 * - `page` (and legacy CLI flag `"page-analyze"`) → `WORKER_RESTART_DELAY_MS`
 *   (default 3000ms, Plan v4.1 CWE-770 boundary preserved)
 *
 * Plan v4.3 PR-M Phase 2 Step 6 Quality Gate refinement (PR-M-A scope
 * contract divergence closure). See module-level comment block above for
 * historical context (anchors `019e3087-59de` / `019e3091-8450`).
 *
 * @param workerType Canonical WorkerType OR legacy CLI flag `"page-analyze"`
 *                   (normalised to `"page"` for 1-cycle backward compat).
 * @returns Restart delay in ms for the specified WorkerType.
 */
export function getRestartDelayMsForType(workerType: WorkerType | "page-analyze"): number {
  // Legacy CLI flag normalisation (mirrors START_WORKERS_CLI_MAPPING semantics).
  const canonical: WorkerType = workerType === "page-analyze" ? "page" : workerType;

  if (canonical === "embedding-backfill") {
    return safeParseInt(
      process.env.EMBEDDING_BACKFILL_RESTART_DELAY_MS,
      DEFAULT_BACKFILL_RESTART_DELAY_MS,
      BACKFILL_RESTART_DELAY_MS_MIN,
      BACKFILL_RESTART_DELAY_MS_MAX
    );
  }
  return safeParseInt(
    process.env.WORKER_RESTART_DELAY_MS,
    DEFAULT_PAGE_RESTART_DELAY_MS,
    PAGE_RESTART_DELAY_MS_MIN
  );
}

// ============================================================================
// WorkerSupervisor Class — Facade composing Module B (lifecycle) + Module C (lock)
// ============================================================================

/**
 * Per-type WorkerSupervisor (PR-D-8 Phase 2). Facade composing
 * {@link WorkerSupervisorLifecycle} (Module B) and
 * {@link WorkerSupervisorLockOrchestrator} (Module C).
 *
 * State ownership (Module A as single owner):
 *   - `typeConfigs` / `bootTokens` / `bindingTable` (immutable on construction)
 *   - `children` Map / `perTypeState` Map (mutated by Module B via state-mutator accessors)
 *   - `sigabrtCountByWorkerType` / `lastSigabrtAuditByWorkerType` (mutated by Module B)
 *
 * Lock state (Module C as owner per SEC FIND-M-02 + TDA + TPA 4-way unanimous):
 *   - `lockAcquired` / `lockHeartbeatTimers` / `lockAcquireInflight` Maps inside
 *     `WorkerSupervisorLockOrchestrator`
 *
 * Cross-module indirect path (TPA-01): Module B → A → C and C → A → B; never B → C or C → B.
 */
export class WorkerSupervisor {
  // --------------------------------------------------------------------------
  // State (Module A owns)
  // --------------------------------------------------------------------------

  private readonly typeConfigs: Record<WorkerType, WorkerTypeConfig>;
  private readonly children: Map<WorkerType, WorkerChildState> = new Map();
  private readonly bindingTable: Map<number, WorkerType> = new Map();
  private readonly bootTokens: Record<WorkerType, string>;

  /**
   * Plan v4.5 PR3 Track 2 (§4.2.2 OrphanCleanupContract): single UUIDv7 boot
   * epoch issued once at supervisor construction. Per-job sub-child locks store
   * this value alongside the nonce so orphan-cleanup can release ONLY locks
   * originating from THIS supervisor boot (CWE-367 TOCTOU double-verify).
   *
   * Supervisor 起動時に 1 度発行する UUIDv7 boot epoch (§4.2.2)。orphan-cleanup
   * は本 epoch 一致時のみ release する (CWE-367 二重 verify)。
   */
  private readonly bootEpoch: string = uuidv7();

  private readonly config: Required<Omit<WorkerSupervisorOptions, "workerArgs" | "workerEnv">> &
    Pick<WorkerSupervisorOptions, "workerArgs" | "workerEnv">;

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

  // Fix-3 (INFRA-EMBEDDING-MOTION-SIGABRT-001): SIGABRT count + audit rate-limit.
  private readonly sigabrtCountByWorkerType: Map<WorkerType, number> = new Map();
  private readonly lastSigabrtAuditByWorkerType: Map<WorkerType, number> = new Map();

  // --------------------------------------------------------------------------
  // Composition (CO-26 split: Module B + Module C)
  // --------------------------------------------------------------------------

  private readonly lifecycle: WorkerSupervisorLifecycle;
  private readonly lockOrchestrator: WorkerSupervisorLockOrchestrator;

  // --------------------------------------------------------------------------
  // Plan v3 Track T4 (PR-V3-T4) UNBLOCK-T4-04 — Module B DI lift
  // --------------------------------------------------------------------------

  /**
   * Per-instance Prisma client reference. Defaults to the singleton from
   * `@reftrixmcp/database` but is replaceable via
   * {@link setPrismaClientForTesting} for test fixtures (UNBLOCK-T4-04 DI lift).
   *
   * Module A owns the Prisma client; Module B / failure-path service consume
   * it via {@link getPrismaClient} accessor instead of a direct import. This
   * inverts the dependency so test fixtures can inject a mock without module
   * cache surgery.
   *
   * Plan v3 T4 UNBLOCK-T4-04 Prisma client per-instance owner.
   */
  private prismaClient: PrismaClient = defaultPrismaClient;

  constructor(options: WorkerSupervisorOptions) {
    // Plan v4.4 PR-N-A / ADR-0035 Amendment 1 §Decision 5:
    // `restartDelayMs` field removed from options merge. Per-type cooldown
    // is now exclusively resolved via `getRestartDelayMsForType(workerType)`
    // at call site (no constructor-level default merge needed).
    this.config = {
      ...options,
    };

    const defaults = buildDefaultWorkerTypeConfigs(options.workerScript);
    this.typeConfigs = {
      page: {
        ...defaults.page,
        workerArgs: options.workerArgs ?? defaults.page.workerArgs,
        maxJobsBeforeRestart: options.maxJobsBeforeRestart,
      },
      "embedding-backfill": defaults["embedding-backfill"],
    };

    // §3.2.4 Rule 1: independent per-type tokens.
    this.bootTokens = buildBootTokens();

    for (const workerType of WORKER_TYPES) {
      this.perTypeState.set(workerType, {
        state: "idle",
        completedJobCount: 0,
        restartCount: 0,
        pendingRestart: false,
      });
    }

    // SEC L-01: Module C MUST be instantiated before Module B so the lifecycle
    // module can rely on `this.lockOrchestrator` being available during its own
    // construction (current implementation is constructor-light, but order is
    // contract-preserving for future extensions).
    this.lockOrchestrator = new WorkerSupervisorLockOrchestrator(
      this,
      this.bootTokens,
      instantiateLockServiceForSupervisor
    );
    this.lifecycle = new WorkerSupervisorLifecycle(this);
  }

  // --------------------------------------------------------------------------
  // @internal Composition accessors (Module B/C indirect path; TPA-01)
  // --------------------------------------------------------------------------

  /** @internal Module B/C indirect path (`this.supervisor.getLifecycle().X()`). */
  getLifecycle(): WorkerSupervisorLifecycle {
    return this.lifecycle;
  }

  /** @internal Module B/C indirect path (`this.supervisor.getLockOrchestrator().X()`). */
  getLockOrchestrator(): WorkerSupervisorLockOrchestrator {
    return this.lockOrchestrator;
  }

  /**
   * @internal Module B / failure-path service indirect path for the Prisma
   * client (UNBLOCK-T4-04 DI lift). Module B and the failure-path service
   * consume `WorkerSupervisor.getPrismaClient()` instead of importing
   * `@reftrixmcp/database` directly so test fixtures can inject a mock via
   * {@link setPrismaClientForTesting}.
   *
   * Plan v3 T4 UNBLOCK-T4-04 Prisma client accessor (DI inversion).
   */
  getPrismaClient(): PrismaClient {
    return this.prismaClient;
  }

  /**
   * @internal **Test-only** mutator — overrides the Prisma client used by
   * Module B / failure-path service. Production code MUST NOT call this
   * accessor.
   *
   * Plan v3 T4 UNBLOCK-T4-04 test-only Prisma client setter.
   *
   * @param client - Mocked Prisma client for test fixtures
   */
  setPrismaClientForTesting(client: PrismaClient): void {
    this.prismaClient = client;
  }

  // --------------------------------------------------------------------------
  // Public API — accessors (test / monitoring)
  // --------------------------------------------------------------------------

  /** @internal Test-only legacy single-token interface. */
  getBootToken(): string {
    return this.bootTokens.page;
  }

  /** @internal Test-only per-type boot token accessor. */
  getBootTokenForType(workerType: WorkerType): string {
    return this.bootTokens[workerType];
  }

  /** @internal Test-only per-type config accessor. */
  getTypeConfig(workerType: WorkerType): WorkerTypeConfig {
    return this.typeConfigs[workerType];
  }

  /** @internal Test-only — used by Module B (env injection) for the full type config map. */
  getAllTypeConfigs(): Record<WorkerType, WorkerTypeConfig> {
    return this.typeConfigs;
  }

  /** @internal Test-only — used by Module B (env injection) for the full boot tokens map. */
  getAllBootTokens(): Record<WorkerType, string> {
    return this.bootTokens;
  }

  /**
   * Plan v4.5 PR3 Track 2 (§4.2.2): the supervisor's single UUIDv7 boot epoch.
   * Per-job sub-child locks store this so orphan-cleanup can verify own-origin.
   *
   * Supervisor の UUIDv7 boot epoch (§4.2.2)。per-job lock の own-origin verify 用。
   */
  getBootEpoch(): string {
    return this.bootEpoch;
  }

  /**
   * Plan v4.5 PR3 Track 2 (§4.2.2 OrphanCleanupContract / CWE-367 closure):
   * scan all per-job sub-child locks and release ONLY those whose stored
   * `bootEpoch` matches THIS supervisor's boot epoch (own-origin orphans left
   * by a crashed/restarted sub-child). Locks owned by a different bootEpoch
   * are a "live owner" and are skipped. Fail-open: Redis-unreachable returns 0
   * released (does not block startup).
   *
   * supervisor 起動時に per-job lock を scan し、自 bootEpoch 一致の orphan のみ
   * release する (§4.2.2、CWE-367)。別 bootEpoch は live owner として skip。
   *
   * @returns Number of orphan locks released (0 on Redis-unreachable, fail-open)
   */
  async cleanupOrphanPerJobLocks(): Promise<number> {
    const lockService = instantiateLockServiceForSupervisor();
    let released = 0;
    try {
      const entries = await lockService.scanOrphanPerJobLocks();
      for (const entry of entries) {
        // Own-origin verify (§4.2.2): release ONLY when stored bootEpoch matches
        // this supervisor's boot epoch AND a decodable nonce exists. A null
        // bootEpoch (undecodable / foreign) is conservatively treated as a live
        // owner and skipped (never auto-deleted by mistake).
        if (entry.bootEpoch !== this.bootEpoch || entry.nonce === null) {
          continue;
        }
        const jobId = entry.key.startsWith(PER_JOB_LOCK_KEY_NAMESPACE)
          ? entry.key.slice(PER_JOB_LOCK_KEY_NAMESPACE.length)
          : null;
        if (jobId === null) continue;
        const ok = await lockService.releasePerJobSubChildLock(jobId, entry.nonce, this.bootEpoch);
        if (ok) released++;
      }
    } catch (error) {
      // Fail-open: orphan cleanup must never block supervisor startup.
      logger.warn("[WorkerSupervisor] cleanupOrphanPerJobLocks failed (fail-open)", {
        error: sanitizeErrorMessage(error),
      });
    } finally {
      void lockService.close().catch(() => {
        /* best-effort */
      });
    }
    return released;
  }

  /** @internal Used by Module B (env injection). */
  getLegacyWorkerEnv(): Record<string, string> | undefined {
    return this.config.workerEnv;
  }

  /** Get the live child state for a WorkerType (or `null` if no live child). */
  getChildState(workerType: WorkerType): WorkerChildState | null {
    return this.children.get(workerType) ?? null;
  }

  /** @internal Used by Module B to set a freshly forked child's state. */
  setChildState(workerType: WorkerType, state: WorkerChildState): void {
    this.children.set(workerType, state);
  }

  /** @internal Used by Module B to bind pid → workerType synchronously after fork(). */
  bindPidToWorkerType(pid: number, workerType: WorkerType): void {
    this.bindingTable.set(pid, workerType);
  }

  /** @internal Test-only pid → WorkerType binding accessor (Rule 5). */
  getBindingTableSnapshot(): ReadonlyMap<number, WorkerType> {
    return this.bindingTable;
  }

  /** @internal Used by Module B during exit cleanup. */
  removeChild(workerType: WorkerType, exitedPid: number | undefined): void {
    if (exitedPid !== undefined && exitedPid >= 0) {
      this.bindingTable.delete(exitedPid);
    }
    this.children.delete(workerType);
  }

  /** @internal Used by Module B for SIGABRT audit rate-limit Map. */
  getSigabrtCountByWorkerType(): Map<WorkerType, number> {
    return this.sigabrtCountByWorkerType;
  }

  /** @internal Used by Module B for SIGABRT audit rate-limit Map. */
  getLastSigabrtAuditByWorkerType(): Map<WorkerType, number> {
    return this.lastSigabrtAuditByWorkerType;
  }

  /** @internal Used by Module B (config readers). */
  getMaxRestartAttempts(): number {
    return this.config.maxRestartAttempts;
  }

  /** @internal Used by Module B (config readers). */
  getShutdownTimeoutMs(): number {
    return this.config.shutdownTimeoutMs;
  }

  /**
   * @internal Used by Module B (config readers).
   *
   * Plan v4.3 PR-M-A: Per-type restart cooldown accessor. `embedding-backfill`
   * は `EMBEDDING_BACKFILL_RESTART_DELAY_MS` env (default 8000ms、range
   * 500..86400000ms) を採用し、`page` は legacy `WORKER_RESTART_DELAY_MS`
   * (default 3000ms) を維持する (Plan v4.1 CWE-770 boundary preserved)。
   *
   * Per-type restart cooldown accessor. `embedding-backfill` uses
   * `EMBEDDING_BACKFILL_RESTART_DELAY_MS` (default 8000ms, range
   * 500..86400000ms); `page` keeps the legacy default (3000ms / Plan v4.1
   * CWE-770 boundary). Overload: when called without arguments, returns the
   * legacy `page` cooldown (backward-compatible with pre-PR-M-A callers).
   *
   * @param workerType Optional WorkerType discriminator (defaults to `page`).
   * @returns restart delay in ms for the specified WorkerType.
   */
  getRestartDelayMs(workerType?: WorkerType): number {
    // Plan v4.3 PR-M Phase 2 Step 6 refinement: delegate to module-level
    // canonical helper (`getRestartDelayMsForType`) to avoid duplicate logic
    // and guarantee semantic equivalence with the ADR-0035 §Decision 3
    // contract verified by INV-EMBEDDING-WORKER-INIT-001 standing test.
    //
    // Plan v4.4 PR-N-A / ADR-0035 Amendment 1 §Decision 5: the legacy
    // `this.config.restartDelayMs` field has been removed entirely. The
    // module-level `getRestartDelayMsForType(workerType)` helper is now the
    // exclusive SSOT for per-type restart cooldown — reading
    // `WORKER_RESTART_DELAY_MS` (page, default 3000ms, min 500ms per Plan
    // v4.1 CWE-770 boundary) or `EMBEDDING_BACKFILL_RESTART_DELAY_MS`
    // (embedding-backfill, default 8000ms). Backward compat: when
    // `workerType` is omitted, default to `"page"` (legacy callers
    // pre-PR-M-A treated the method as the page cooldown accessor).
    return getRestartDelayMsForType(workerType ?? "page");
  }

  /** @internal Used by Module B (shutdown gate). */
  isShuttingDownNow(): boolean {
    return this.isShuttingDown;
  }

  // --------------------------------------------------------------------------
  // State-mutator accessors (Module B → Module A perTypeState mutation)
  // --------------------------------------------------------------------------

  /** @internal */
  isPendingRestart(workerType: WorkerType): boolean {
    return this.requirePerTypeState(workerType).pendingRestart;
  }

  /** @internal */
  setPendingRestart(workerType: WorkerType): void {
    this.requirePerTypeState(workerType).pendingRestart = true;
  }

  /** @internal */
  clearPendingRestart(workerType: WorkerType): void {
    this.requirePerTypeState(workerType).pendingRestart = false;
  }

  /** @internal */
  resetRestartCount(workerType: WorkerType): void {
    this.requirePerTypeState(workerType).restartCount = 0;
  }

  /** @internal */
  incrementRestartCount(workerType: WorkerType): void {
    this.requirePerTypeState(workerType).restartCount++;
  }

  /** @internal */
  resetCompletedJobCount(workerType: WorkerType): void {
    this.requirePerTypeState(workerType).completedJobCount = 0;
  }

  /** @internal */
  markWorkerRunning(workerType: WorkerType): void {
    this.requirePerTypeState(workerType).state = "running";
  }

  /** @internal */
  markWorkerRestarting(workerType: WorkerType): void {
    this.requirePerTypeState(workerType).state = "restarting";
  }

  /** @internal */
  markWorkerStopped(workerType: WorkerType): void {
    this.requirePerTypeState(workerType).state = "stopped";
  }

  /** @internal */
  markWorkerCrashed(workerType: WorkerType): void {
    this.requirePerTypeState(workerType).state = "crashed";
  }

  // --------------------------------------------------------------------------
  // Public API — lifecycle entry
  // --------------------------------------------------------------------------

  /**
   * ワーカーが起動していなければ起動する (legacy single-worker API; `page`).
   * 冪等。
   */
  ensureWorkerRunning(): void {
    this.ensureWorkerRunningForType("page");
  }

  /**
   * Per-type ensure-running entry point (PR-D-8 MF-01). Idempotent.
   */
  ensureWorkerRunningForType(workerType: WorkerType): void {
    const state = this.requirePerTypeState(workerType);

    // 既に起動中・shutdown済み・再起動中なら何もしない
    if (state.state === "running" && this.children.has(workerType)) return;
    if (state.state === "stopped") return;
    if (state.state === "restarting") return;

    // PR7d-2: Publish boot token to Redis. Best-effort.
    this.lockOrchestrator.acquireRedisLockBestEffort(workerType);

    // crashed 状態からの自動復旧 (legacy semantics retained)
    if (state.state === "crashed") {
      logger.info("[WorkerSupervisor] Auto-resetting from crashed state for new job submission", {
        workerType,
        previousRestartCount: state.restartCount,
      });
      state.restartCount = 0;
      state.state = "idle";
    }

    this.lifecycle.spawnWorker(workerType);
  }

  /**
   * PR-D-8 MF-07: staggered multi-type spawn. Spawns `primary`, awaits first
   * IPC heartbeat (or 10s timeout), then spawns `secondary`.
   */
  async ensureAllWorkersRunningStaggered(heartbeatTimeoutMs: number = 10_000): Promise<void> {
    return this.lifecycle.ensureAllWorkersRunningStaggered(heartbeatTimeoutMs);
  }

  /** @internal Used by Module B's staggered spawn. */
  firstWorkerTypeOfPriority(priority: "primary" | "secondary"): WorkerType | null {
    for (const workerType of WORKER_TYPES) {
      if (this.typeConfigs[workerType].schedulingPriority === priority) return workerType;
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // Public API — state observers
  // --------------------------------------------------------------------------

  /** Legacy alias for `page`. */
  getState(): WorkerState {
    return this.getStateForType("page");
  }

  getStateForType(workerType: WorkerType): WorkerState {
    return this.requirePerTypeState(workerType).state;
  }

  /** Legacy alias for `page`. */
  getCompletedJobCount(): number {
    return this.getCompletedJobCountForType("page");
  }

  getCompletedJobCountForType(workerType: WorkerType): number {
    return this.requirePerTypeState(workerType).completedJobCount;
  }

  /** Legacy alias for `page`. */
  getRestartCount(): number {
    return this.getRestartCountForType("page");
  }

  getRestartCountForType(workerType: WorkerType): number {
    return this.requirePerTypeState(workerType).restartCount;
  }

  /** Legacy alias for `page`. */
  notifyJobCompleted(): void {
    this.notifyJobCompletedForType("page");
  }

  /**
   * Per-type notification (Rule 5 verification dispatches here on valid IPC).
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
      this.lifecycle.initiateRestart(workerType, "job_count_threshold");
    }
  }

  // --------------------------------------------------------------------------
  // Public API — shutdown
  // --------------------------------------------------------------------------

  /**
   * graceful shutdown — terminates every live child and releases every
   * per-type Redis lock. 3-Phase Shutdown Protocol per child.
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // ADR-0011 Amendment 7 §A7.4 (CWE-400 timer-leak defense layer 2): clear the
    // deferred secondary-spawn retry timer. Layer 1 is the callback-head
    // `isShuttingDownNow()` guard inside the retry tick. INV-011 (d).
    this.lifecycle.clearSecondarySpawnRetryTimer();

    // Per-type Redis lock release (fire-and-forget for each type).
    for (const workerType of WORKER_TYPES) {
      void this.lockOrchestrator.releaseRedisLockBestEffort(workerType);
    }

    const shutdownPromises: Array<Promise<void>> = [];
    for (const workerType of WORKER_TYPES) {
      shutdownPromises.push(this.lifecycle.shutdownChild(workerType));
    }
    await Promise.all(shutdownPromises);
  }

  // --------------------------------------------------------------------------
  // Public API — child process accessor (legacy)
  // --------------------------------------------------------------------------

  /** Legacy alias for `page`. */
  getWorkerProcess(): ChildProcess | null {
    return this.getWorkerProcessForType("page");
  }

  getWorkerProcessForType(workerType: WorkerType): ChildProcess | null {
    return this.children.get(workerType)?.child ?? null;
  }

  // --------------------------------------------------------------------------
  // Private — utility
  // --------------------------------------------------------------------------

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
      throw new Error(`WorkerSupervisor: missing per-type state for ${workerType}`);
    }
    return s;
  }
}

// ============================================================================
// Re-exports for backward compat (CO-26 split: callsite churn ZERO)
// ============================================================================

// Module B re-exports — `IPC_SHUTDOWN_GRACE_MS` constant + test export.
export {
  IPC_SHUTDOWN_GRACE_MS,
  __IPC_SHUTDOWN_GRACE_MS_FOR_TEST,
} from "./worker-supervisor-lifecycle.service";

// Helpers re-exports — preserved verbatim from pre-CO-26 surface.
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
 * @see ADR-0016 § Service DI Refactor Plan (TDA-Plan-08)
 */
let lockServiceFactory: (() => WorkerActiveLockService) | null = null;

/**
 * Set the WorkerActiveLockService factory used by the supervisor.
 */
export function setWorkerSupervisorLockServiceFactory(
  factory: () => WorkerActiveLockService
): void {
  lockServiceFactory = factory;
}

/**
 * Reset the WorkerActiveLockService factory (default `new WorkerActiveLockService()`).
 */
export function resetWorkerSupervisorLockServiceFactory(): void {
  lockServiceFactory = null;
}

/**
 * @internal Used by Module C's lock service instantiator closure.
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
        // GPU/ONNX: forward ONNX_EXECUTION_PROVIDER + LD_LIBRARY_PATH.
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
      // Plan v4.4 PR-N-A / ADR-0035 Amendment 1 §Decision 5:
      // `restartDelayMs` factory env reading removed. Per-type cooldown is
      // resolved exclusively via `getRestartDelayMsForType(workerType)`
      // (ADR-0035 §Decision 3 canonical SSOT). `WORKER_RESTART_DELAY_MS`
      // env var is still read by the helper (default 3000ms, min 500ms per
      // Plan v4.1 CWE-770 boundary preserved).
    });
  }
  return supervisorInstance;
}

/** シングルトンインスタンスをリセット (テスト用)。 */
export function resetWorkerSupervisor(): void {
  supervisorInstance = null;
}

/**
 * ワーカースクリプトの絶対パスを取得。env `WORKER_SCRIPT_PATH` 優先。
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
