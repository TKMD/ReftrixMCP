// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fork Common Helper — Shared child_process.fork() infrastructure (v0.4.0 PR7e-β4 PR1)
 *
 * Phase 5 fork orchestrator (`phase-5-fork-orchestrator.ts`) が child_process.fork()
 * で実装している以下の共通インフラを、将来の backfill fork orchestrator (PR2+) や
 * 他の long-running ONNX 推論プロセスから再利用できるよう抽出した汎用 helper。
 *
 * Shared infrastructure for `child_process.fork()`-based isolation of long-running
 * ONNX inference processes (Phase 5 today, EmbeddingBackfillWorker in PR2+).
 *
 * ## 提供する API / Provided APIs
 *
 * 1. {@link buildChildEnv} — fork 子プロセス用の env 変数を構築。
 *    - `EMBEDDING_WORKER_THREAD=false`
 *    - `DINOV2_WORKER_THREAD=false`
 *    - `ONNX_EXECUTION_PROVIDER=cpu` (β2-P1: NAPI HandleScope FATAL 防御)
 *    - `MALLOC_ARENA_MAX=2` (OOM-1: glibc malloc 断片化防止)
 *    - `DATABASE_URL` に `?connection_limit=N` を append (P0-3)
 *
 * 2. {@link buildChildExecArgv} — fork() の execArgv を構築 (`--max-old-space-size` +
 *    `--expose-gc`)。デフォルト 4096MB (Phase 5 と同じ `CHILD_MAX_OLD_SPACE_MB`)。
 *
 * 3. {@link resolveChildScriptPath} — dist/src 両対応で子プロセススクリプトパスを解決。
 *
 * 4. {@link runChildProcess} — fork ライフサイクル管理 (heartbeat / lock-request relay /
 *    timeout / abnormal exit / RSS delta monitoring) を generic にした runner。
 *    Zod スキーマで IPC を validate するために型パラメータで親→子 / 子→親メッセージ型を受ける。
 *
 * 5. {@link appendConnectionLimit} — DATABASE_URL に `?connection_limit=N` を安全に append。
 *
 * ## Phase 5 との関係 / Relationship with Phase 5
 *
 * 現時点 (PR7e-β4 PR1) では Phase 5 fork orchestrator は本 helper を直接消費せず、
 * 自身のローカル実装を保持する (既存テスト無変更で PASS させるため)。本 helper は
 * 後続 PR (β4 PR2 以降) で導入される backfill fork orchestrator が独立に消費する。
 * 重複削減を伴う Phase 5 の本 helper への完全移行は、テスト構造をリファクタ可能な
 * タイミングで別 PR として実施する。
 *
 * As of PR7e-β4 PR1, the Phase 5 fork orchestrator does NOT consume this helper
 * directly; it retains its local implementation so existing string-pattern tests
 * keep passing unchanged. This helper is consumed by the backfill fork orchestrator
 * introduced in subsequent PRs (β4 PR2+). A full Phase 5 migration to this helper
 * (eliminating the remaining duplication) is deferred to a later PR after the
 * test structure can be refactored.
 *
 * @module workers/phases/shared/fork-common
 */

import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { logger } from "../../../utils/logger";
import { safeParseInt } from "../../../utils/safe-parse-int";
import { computeMemoryProfile } from "../../../services/worker-memory-profile";
// SEC-M1-01 (ADR-0016 § Test-only Env Var Guard, deadline 2026-05-15):
// fork() で子プロセスへ伝搬する env から test-only var (EMBEDDING_MODEL_MOCK 等)
// を必ず除去する。production runtime に万一 leak した場合も子プロセスには流れない。
// SEC-M1-01 (ADR-0016 § Test-only Env Var Guard): always strip test-only env
// vars (e.g. EMBEDDING_MODEL_MOCK) from the env passed to forked children.
import { filterTestOnlyEnvForChild } from "../../../config/test-env-guard";

// ============================================================================
// Constants
// ============================================================================

/**
 * Default heartbeat timeout — if no heartbeat in this interval, kill child (ms).
 *
 * デフォルト heartbeat タイムアウト — 指定間隔内に heartbeat が来なければ kill。
 */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = safeParseInt(process.env.PHASE5_HEARTBEAT_TIMEOUT_MS, 60_000, {
  min: 5_000,
  max: 300_000,
});

/**
 * Default Prisma connection pool limit for child process (P0-3).
 *
 * 子プロセス Prisma 接続プール上限のデフォルト値 (P0-3)。
 */
const DEFAULT_CHILD_CONNECTION_LIMIT = safeParseInt(process.env.PHASE5_CHILD_CONNECTION_LIMIT, 3, {
  min: 1,
  max: 10,
});

/**
 * Default max V8 heap (MB) for fork children (OOM-FIX-3).
 * Children are short-lived ONNX inference processes — 4GB is sufficient.
 *
 * fork 子プロセスのデフォルト V8 ヒープ上限 (MB)。子プロセスは短命の ONNX 推論
 * プロセスのため 4GB で十分。
 */
const DEFAULT_CHILD_MAX_OLD_SPACE_MB = 4096;

// ============================================================================
// Public Types
// ============================================================================

/**
 * Options for {@link buildChildEnv}.
 *
 * {@link buildChildEnv} のオプション。
 */
export interface BuildChildEnvOptions {
  /**
   * Phase / worker label for log diagnostics. Not injected into the env itself
   * but used to make caller intent explicit.
   *
   * ログ診断用の phase / worker ラベル。env 自体には注入されないが、呼び出し側の
   * 意図を明示するために受ける。
   */
  phaseLabel: string;

  /**
   * Override the Prisma connection pool limit for the child process.
   * Defaults to {@link DEFAULT_CHILD_CONNECTION_LIMIT}.
   *
   * 子プロセスの Prisma 接続プール上限を上書き。デフォルトは
   * {@link DEFAULT_CHILD_CONNECTION_LIMIT}。
   */
  connectionLimit?: number;
}

/**
 * Options for {@link buildChildExecArgv}.
 *
 * {@link buildChildExecArgv} のオプション。
 */
export interface BuildChildExecArgvOptions {
  /**
   * Override the child V8 heap cap (MB). Defaults to
   * {@link DEFAULT_CHILD_MAX_OLD_SPACE_MB} (4096).
   *
   * 子プロセスの V8 ヒープ上限 (MB) を上書き。デフォルトは 4096。
   */
  maxOldSpaceMb?: number;
}

/**
 * Options for {@link runChildProcess}. Generic over the parent-init and
 * child-result message types.
 *
 * {@link runChildProcess} のオプション。親→子 init message / 子→親 result message
 * の型をジェネリックで受ける。
 */
export interface RunChildProcessOptions<TInitMessage extends { type: string }> {
  /**
   * Absolute path to the child process entry script (.js after build).
   *
   * 子プロセスエントリスクリプトの絶対パス (build 後の .js)。
   */
  childScriptPath: string;

  /**
   * Initial IPC message sent to the child immediately after fork().
   *
   * fork() 直後に子プロセスへ送信する初期 IPC メッセージ。
   */
  initMessage: TInitMessage;

  /**
   * Overall timeout (ms) for the child process. SIGKILL on expiry.
   *
   * 子プロセス全体のタイムアウト (ms)。超過時 SIGKILL。
   */
  timeoutMs: number;

  /**
   * Phase / worker label used in log lines (e.g. `"text"`, `"visual"`,
   * `"backfill-part-text"`).
   *
   * ログ出力で使う phase / worker ラベル (例: `"text"` / `"visual"` /
   * `"backfill-part-text"`)。
   */
  phaseLabel: string;

  /**
   * Optional cwd for the child process. Defaults to `process.cwd()` at parent
   * fork time.
   *
   * 子プロセスの cwd を上書きする optional 値。デフォルトは親 fork 時点の
   * `process.cwd()`。
   */
  cwd?: string;

  /**
   * Optional callback invoked for every validated IPC message from the child.
   * The callback receives the raw message (after Zod validation by the caller)
   * and returns either a `result` (terminating the runner with the result) or
   * `undefined` (continuing). This indirection lets backfill consume the same
   * runner without changing the heartbeat / lock-request relay logic.
   *
   * 子→親 IPC message を受信するたびに呼ばれる callback。Zod validation 済みの
   * raw message を受け、`result` を返せば runner が終了、`undefined` なら継続。
   */
  onChildMessage?: (msg: unknown) => Promise<void> | void;

  /**
   * Optional override for heartbeat timeout (ms). Defaults to
   * {@link DEFAULT_HEARTBEAT_TIMEOUT_MS}.
   *
   * heartbeat タイムアウトの override (ms)。デフォルトは
   * {@link DEFAULT_HEARTBEAT_TIMEOUT_MS}。
   */
  heartbeatTimeoutMs?: number;

  /**
   * Optional callback invoked immediately after {@link fork} spawns the child
   * process, before the init message is sent. Receives the {@link ChildProcess}
   * reference so callers can install their own signal-escalation / kill relays
   * without forking themselves.
   *
   * **Backward-compat note** (v0.4.0 PR7e-β4 PR2a audit): This optional was
   * added for the backfill fork orchestrator (SEC H-1: `AbortSignal` → SIGTERM
   * → 5s → SIGKILL escalation requires a real `child.kill` reference in the
   * parent wrapper). Phase 5 callers do **not** pass `onSpawn`, so their
   * behavior is unchanged — the runner's own heartbeat / overall timeout still
   * own the canonical SIGKILL path. ADR-0015 Decision #5 ("external contract
   * unchanged") is maintained because this is a purely additive optional.
   *
   * fork 直後 (init message 送信前) に呼ばれる optional callback。ChildProcess
   * 参照を受け取り、呼び出し側独自の signal-escalation / kill relay を登録する
   * ために使う。後方互換 (PR7e-β4 PR2a 監査 SEC H-1 対応): backfill orchestrator
   * 専用。Phase 5 は未使用で挙動不変 (ADR-0015 Decision #5 維持)。
   */
  onSpawn?: (child: ChildProcess) => void;
}

/**
 * Result of {@link runChildProcess}.
 *
 * {@link runChildProcess} の結果。
 */
export interface RunChildProcessResult {
  /**
   * Whether the child exited with code 0 (no signal, no error).
   *
   * 子プロセスが exit code 0 で終了したか (signal kill / error 無し)。
   */
  exitedCleanly: boolean;

  /**
   * Exit code (null if signal-killed).
   *
   * exit code (signal kill された場合は null)。
   */
  exitCode: number | null;
}

// ============================================================================
// Public Helpers
// ============================================================================

/**
 * Append `?connection_limit=N` to a DATABASE_URL safely (handles existing
 * query string).
 *
 * DATABASE_URL に `?connection_limit=N` を安全に append (既存クエリ対応)。
 *
 * Mirrors the Phase 5 IPC helper of the same name in `phase-5-child-ipc.ts`.
 * Re-exported here so backfill consumers can import without depending on the
 * Phase 5 IPC module.
 */
export function appendConnectionLimit(databaseUrl: string, limit: number): string {
  const separator = databaseUrl.includes("?") ? "&" : "?";
  return `${databaseUrl}${separator}connection_limit=${limit}`;
}

/**
 * Build environment variables for child process fork.
 *
 * Sets the canonical fork-isolation env keys:
 *   - EMBEDDING_WORKER_THREAD=false  (P0-1)
 *   - DINOV2_WORKER_THREAD=false     (P0-1)
 *   - ONNX_EXECUTION_PROVIDER=cpu    (β2-P1: NAPI HandleScope FATAL defense)
 *   - MALLOC_ARENA_MAX=2             (OOM-1: glibc malloc fragmentation)
 *   - DATABASE_URL?connection_limit=N (P0-3)
 *   - WORKER_MAX_OLD_SPACE_MB         (forwarded to child --max-old-space-size)
 *
 * 子プロセス用の env を構築。
 *
 * @param options.phaseLabel — log diagnostics ラベル (env には注入しない)
 * @param options.connectionLimit — Prisma connection pool 上限 override
 */
export function buildChildEnv(options: BuildChildEnvOptions): Record<string, string> {
  const { phaseLabel, connectionLimit = DEFAULT_CHILD_CONNECTION_LIMIT } = options;
  void phaseLabel; // accepted for API symmetry / future log injection

  const profile = computeMemoryProfile();
  // SEC-M1-01 (ADR-0016 § Test-only Env Var Guard): strip test-only env vars
  // (EMBEDDING_MODEL_MOCK 等) from the inherited parent env before passing it to
  // the forked child. In NODE_ENV=test this is a no-op (mock vars are required
  // for tests); in any other runtime it removes test-only keys so a production
  // leak cannot propagate down the IPC boundary.
  // SEC-M1-01: NODE_ENV=test で no-op、production では test-only var を削除する
  // ことで IPC 境界経由の leak を遮断する。
  const baseEnv = filterTestOnlyEnvForChild(process.env) as Record<string, string>;

  // P0-1: Disable worker_threads nesting in child processes
  baseEnv.EMBEDDING_WORKER_THREAD = "false";
  baseEnv.DINOV2_WORKER_THREAD = "false";

  // β2-P1: Force CPU execution provider in fork child processes.
  // See phase-5-fork-orchestrator.ts buildChildEnv() for full rationale.
  baseEnv.ONNX_EXECUTION_PROVIDER = "cpu";

  // P0-3: Limit connection pool size for child process
  if (baseEnv.DATABASE_URL) {
    baseEnv.DATABASE_URL = appendConnectionLimit(baseEnv.DATABASE_URL, connectionLimit);
  }

  // Forward memory profile info for child's --max-old-space-size
  baseEnv.WORKER_MAX_OLD_SPACE_MB = String(profile.maxOldSpaceSizeMb);

  // OOM-1: Prevent glibc malloc arena fragmentation in child processes too
  if (!baseEnv.MALLOC_ARENA_MAX) {
    baseEnv.MALLOC_ARENA_MAX = "2";
  }

  return baseEnv;
}

/**
 * Build execArgv for child process fork (`--max-old-space-size=N --expose-gc`).
 *
 * fork 子プロセス用の execArgv を構築。
 *
 * @param options.maxOldSpaceMb — V8 heap cap (MB) override. Defaults to 4096.
 */
export function buildChildExecArgv(options: BuildChildExecArgvOptions = {}): string[] {
  const { maxOldSpaceMb } = options;
  const profile = computeMemoryProfile();
  const cap = maxOldSpaceMb ?? DEFAULT_CHILD_MAX_OLD_SPACE_MB;
  const childHeapMb = Math.min(profile.maxOldSpaceSizeMb, cap);
  return [`--max-old-space-size=${childHeapMb}`, "--expose-gc"];
}

/**
 * Resolve a child process script path. Accepts either an absolute path (returned
 * as-is) or a relative filename (resolved against `dist/workers/phases/` at runtime).
 *
 * 子プロセススクリプトパスを解決。絶対パスはそのまま返し、相対ファイル名は
 * `dist/workers/phases/` (runtime の build 出力ディレクトリ) で解決する。
 *
 * @param relativePath — child script filename or absolute path
 * @param baseDir — optional base directory (defaults to caller's __dirname conventions)
 */
export function resolveChildScriptPath(relativePath: string, baseDir?: string): string {
  if (path.isAbsolute(relativePath)) return relativePath;
  // Default base: dist/workers/phases/shared/ → ../  for shared/fork-common.ts callers,
  // or callers can pass baseDir explicitly.
  const base = baseDir ?? path.resolve(__dirname, "..");
  return path.resolve(base, relativePath);
}

/**
 * Generic IPC sender for parent → child messages.
 *
 * 親 → 子 IPC メッセージの汎用送信。
 */
function sendToChild(child: ChildProcess, msg: unknown): void {
  try {
    if (child.connected) {
      child.send(msg as Parameters<ChildProcess["send"]>[0]);
    }
  } catch {
    // Child may have already exited
  }
}

/**
 * Run a forked child process to completion.
 *
 * Provides the same lifecycle guarantees as Phase 5 `runChildProcess`:
 *   - fork() with execArgv from {@link buildChildExecArgv} and env from
 *     {@link buildChildEnv}
 *   - Pipe child stdout/stderr to parent logger with phase prefix
 *   - Send init message immediately after fork
 *   - Per-message callback (caller validates with Zod)
 *   - Heartbeat timeout enforcement (SIGKILL on expiry)
 *   - Overall timeout enforcement (SIGKILL on expiry)
 *   - setImmediate on `exit` event to drain pending IPC `message` events
 *     (Phase 5 IPC race condition fix)
 *   - Resolves with {@link RunChildProcessResult} regardless of outcome (no throw)
 *
 * 子プロセスの fork ライフサイクルを汎用化した runner。Phase 5 の `runChildProcess`
 * と同じライフサイクル保証を提供する。
 *
 * Note: Caller is responsible for Zod validation of incoming IPC messages
 * inside `onChildMessage`. The runner itself is generic and does not enforce
 * a specific schema, so it can be reused across Phase 5 and backfill.
 *
 * 注: IPC メッセージの Zod validation は `onChildMessage` 内で呼び出し側が行う。
 * runner 自体は generic で特定スキーマを強制しないため、Phase 5 と backfill で
 * 共通利用できる。
 */
export async function runChildProcess<TInitMessage extends { type: string }>(
  options: RunChildProcessOptions<TInitMessage>
): Promise<RunChildProcessResult> {
  const {
    childScriptPath,
    initMessage,
    timeoutMs,
    phaseLabel,
    cwd,
    onChildMessage,
    heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
    onSpawn,
  } = options;

  const childEnv = buildChildEnv({ phaseLabel });
  const execArgv = buildChildExecArgv();

  const child: ChildProcess = fork(childScriptPath, [], {
    execArgv,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: childEnv,
    cwd: cwd ?? process.cwd(),
  });

  // Invoke onSpawn as soon as the ChildProcess reference is available so
  // callers can install signal-escalation / kill relays before any IPC
  // message is exchanged. Failures here are logged and swallowed to preserve
  // the non-throwing contract of the runner (PR7e-β4 PR2a audit SEC H-1).
  if (onSpawn) {
    try {
      onSpawn(child);
    } catch (err) {
      logger.warn(
        `[ForkCommon-${phaseLabel}] onSpawn handler threw: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // Pipe child stdout/stderr to parent logger
  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) logger.info(`[ForkCommon-${phaseLabel}] ${line}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) logger.warn(`[ForkCommon-${phaseLabel}] ${line}`);
  });

  return new Promise<RunChildProcessResult>((resolve) => {
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let overallTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    function cleanup(): void {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (overallTimer) clearTimeout(overallTimer);
      child.removeAllListeners();
    }

    function finish(exitedCleanly: boolean, exitCode: number | null): void {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ exitedCleanly, exitCode });
    }

    function resetHeartbeat(): void {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        logger.warn(
          `[ForkCommon-${phaseLabel}] Heartbeat timeout (${heartbeatTimeoutMs}ms), killing child`
        );
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, heartbeatTimeoutMs);
    }

    child.on("message", (raw: unknown) => {
      // Caller's onChildMessage handles Zod validation, lock-request relay,
      // and result extraction. Heartbeat reset is performed unconditionally
      // because any IPC traffic indicates the child is alive.
      resetHeartbeat();
      if (onChildMessage) {
        try {
          const maybePromise = onChildMessage(raw);
          if (maybePromise instanceof Promise) {
            maybePromise.catch((err) => {
              logger.warn(
                `[ForkCommon-${phaseLabel}] onChildMessage handler rejected: ${
                  err instanceof Error ? err.message : String(err)
                }`
              );
            });
          }
        } catch (err) {
          logger.warn(
            `[ForkCommon-${phaseLabel}] onChildMessage handler threw: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    });

    child.on("exit", (code, signal) => {
      // Use setImmediate to let pending IPC "message" events drain first.
      // Without this, removeAllListeners() in finish() kills the message listener
      // before the result message is processed, causing silent result loss.
      setImmediate(() => {
        if (signal) {
          logger.warn(`[ForkCommon-${phaseLabel}] Child killed by signal: ${signal}`);
          finish(false, null);
        } else {
          finish(code === 0, code);
        }
      });
    });

    child.on("error", (err) => {
      logger.warn(`[ForkCommon-${phaseLabel}] Child process error: ${err.message}`);
      finish(false, null);
    });

    // Overall timeout
    overallTimer = setTimeout(() => {
      logger.warn(`[ForkCommon-${phaseLabel}] Overall timeout (${timeoutMs}ms), killing child`);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, timeoutMs);

    // Start heartbeat monitoring
    resetHeartbeat();

    // Send init message to child
    sendToChild(child, initMessage);
  });
}
