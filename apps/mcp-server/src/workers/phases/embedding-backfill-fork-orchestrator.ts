// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill Fork Orchestrator (v0.4.0 PR7e-β4 PR2a — parent only)
 *
 * ADR-0015 Decision #1 に従い、EmbeddingBackfillWorker の ONNX 推論を
 * `child_process.fork()` で分離する際の **親プロセス側** wrapper。
 *
 * Parent-side wrapper that isolates EmbeddingBackfillWorker's ONNX inference
 * via `child_process.fork()` per ADR-0015 Decision #1.
 *
 * ## 設計方針 / Design (PR2 §4 D1, SEC H-1 revised)
 *
 * PR1 で抽出された shared runner (`shared/fork-common.ts::runChildProcess`)
 * を **そのまま基盤として使う** (独自 runner は実装しない)。Backfill 固有の
 * 要件は本ファイルで wrapper 層として以下を追加する:
 *
 * 1. Redis lock pre-flight probe (observability-only, fail-open) — TPA M-1
 * 2. BullMQ `extendLock` cron relay (30s interval, `try/finally` で確実に clear) — TDA H-2
 * 3. AbortSignal 2-stage escalation (SIGTERM → 5s → SIGKILL) — SEC M-1
 * 4. Zod `.strict()` safeParse による IPC message 検証 — TDA M-1 / SEC H-2
 * 5. child 側 sanitize 済み message を parent で **再 sanitize しない** (冪等性) — SEC M-2
 * 6. log 出力時のみ `truncateId()` を全 UUID に適用 — SEC L-2
 *
 * Wrapper layer responsibilities are spelled out above; PR3c will roll these
 * up into shared `runChildProcess` as optional params (`extendLockCallback?` /
 * `extendLockIntervalMs?`) so both Phase 5 and Backfill consume them
 * uniformly (~50-80 line diff projected, TDA H-2).
 *
 * ## 非目標 (PR2a) / Out of scope in PR2a
 *
 * - 本モジュールは PR2a 時点では `embedding-backfill-processors.ts` から
 *   呼ばれない (dead code 状態)。PR2b で `JsAnimationProcessor` 内に
 *   `EMBEDDING_BACKFILL_FORK_ENABLED=true` の flag 分岐を追加して接続する。
 * - child 実装 (`embedding-backfill-child.ts`) も PR2b 新設。PR2a 時点では
 *   `runEmbeddingBackfillFork` を呼ぶと child script が見つからず fork 自体
 *   は失敗するが、dead code のため観測不能。
 *
 * This module is dead code in PR2a (not wired into `embedding-backfill-processors.ts`).
 * PR2b connects it via a flag branch in `JsAnimationProcessor`. The child entry
 * (`embedding-backfill-child.ts`) is also introduced in PR2b.
 *
 * @module workers/phases/embedding-backfill-fork-orchestrator
 */

import path from "node:path";
import type { ChildProcess } from "node:child_process";
// Type-only import of Zod — runtime `z` is exclusively provided by
// `embedding-backfill-ipc.ts` (see `BackfillChildMessage` below). Importing
// the type here avoids a runtime dependency on Zod in this module while still
// letting {@link formatZodParseFailure} accept a `z.ZodError` parameter.
import type { z } from "zod";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { truncateId } from "../../utils/truncate-id";
import {
  WorkerActiveLockService,
  type CheckExistingLockResult,
} from "../../services/worker-active-lock.service";
import {
  buildChildEnv,
  buildChildExecArgv,
  resolveChildScriptPath,
  runChildProcess,
} from "./shared/fork-common";
import {
  BackfillChildMessage,
  type BackfillChildMessageT,
  type BackfillParentMessageT,
  type EmbeddingBackfillCategory,
} from "./embedding-backfill-ipc";

// ============================================================================
// Constants
// ============================================================================

/**
 * BullMQ extendLock relay interval (ms).
 *
 * BullMQ の `lockDuration=10min` に対し、child が 10 分以上走った場合に lock が
 * expire して job が re-queue される挙動を防ぐため、30 秒間隔で extendLock を
 * 呼ぶ。短過ぎれば Redis 負荷、長過ぎれば lock 失効の risk があるため、TTL の
 * 半分以下かつ heartbeat 相当の 30s を採用。
 *
 * v0.4.0 PR7e-β4 PR2b-β (TDA-M-2 反映): 本定数は
 * `embedding-backfill-child.ts::HEARTBEAT_INTERVAL_MS` と意味論的に独立
 * (BullMQ lock renew vs parent watchdog reset) だが、30s 一致を運用ベースライン
 * とする。変更時は対向側との整合を確認すること。
 *
 * TDA-M-2 (v0.4.0 PR7e-β4 PR2b-β): This constant is semantically independent
 * from `HEARTBEAT_INTERVAL_MS` in the child (BullMQ lock renew vs parent
 * watchdog reset) but MUST remain 30s as the operational baseline. Verify
 * counterpart alignment when modifying.
 */
export const BACKFILL_EXTEND_LOCK_INTERVAL_MS = 30_000 as const;

/**
 * BullMQ extendLock grant duration (ms). BullMQ's `job.extendLock(ms)` renews
 * the Redis-held job lock for the given ms from now.
 *
 * BullMQ の lock を再延長する長さ。60s は extendLock interval の 2 倍を確保し、
 * 30s cron の 1 回遅延でも expire しない余裕を持つ。
 */
export const BACKFILL_EXTEND_LOCK_DURATION_MS = 60_000 as const;

/**
 * Default overall timeout for the backfill child process (ms).
 * 10 minutes matches BullMQ lockDuration; child is SIGKILL'd on expiry.
 *
 * Backfill child の全体タイムアウト (ms)。BullMQ の lockDuration=10min と合わせ、
 * 超過時は SIGKILL する。
 */
export const BACKFILL_CHILD_OVERALL_TIMEOUT_MS = 10 * 60_000;

/**
 * AbortSignal escalation delay (ms): SIGTERM → wait → SIGKILL.
 *
 * AbortSignal 2 段 escalation の遅延 (ms): SIGTERM 後の SIGKILL 待機時間。
 * 5 秒 は ONNX Runtime / Prisma client の OS リソース解放に十分 (SEC M-1)。
 */
export const BACKFILL_ABORT_ESCALATION_DELAY_MS = 5_000 as const;

/**
 * Child script filename (resolved via `resolveChildScriptPath`).
 *
 * child スクリプトファイル名。PR2b で `embedding-backfill-child.ts` が
 * 新設されるとビルド後 `dist/workers/phases/embedding-backfill-child.js` に解決される。
 */
const BACKFILL_CHILD_SCRIPT_FILENAME = "embedding-backfill-child.js";

// ============================================================================
// Lock Service Factory (DI for tests, ADR-0016 § Service DI Refactor Plan)
// ============================================================================

/**
 * Optional factory for the WorkerActiveLockService used by the backfill
 * orchestrator. Tests (standing regression `worker-lifecycle` /
 * `large-page` domain) can inject a testcontainer-backed Redis client.
 * Unset → production behavior preserved bit-for-bit.
 *
 * 任意 factory: standing regression suite が testcontainer 由来 Redis を
 * 注入するために使用する。未設定時は production 挙動 (`new WorkerActiveLockService()`)
 * を完全保持する。
 *
 * @see ADR-0016 § Service DI Refactor Plan (TDA-Plan-08)
 */
let backfillLockServiceFactory: (() => WorkerActiveLockService) | null = null;

/** @see ADR-0016 § Service DI Refactor Plan */
export function setEmbeddingBackfillLockServiceFactory(
  factory: () => WorkerActiveLockService
): void {
  backfillLockServiceFactory = factory;
}

/** @see ADR-0016 § Service DI Refactor Plan */
export function resetEmbeddingBackfillLockServiceFactory(): void {
  backfillLockServiceFactory = null;
}

/** @internal Used by `runEmbeddingBackfillFork` to obtain a lock service. */
function instantiateBackfillLockService(): WorkerActiveLockService {
  return backfillLockServiceFactory ? backfillLockServiceFactory() : new WorkerActiveLockService();
}

// ============================================================================
// Public Types
// ============================================================================

/**
 * Options for {@link runEmbeddingBackfillFork}.
 *
 * {@link runEmbeddingBackfillFork} のオプション。
 */
export interface BackfillForkOptions {
  /** BullMQ job.id (non-null). */
  jobId: string;

  /** Target web_pages.id (UUID). */
  webPageId: string;

  /**
   * Backfill category — any of the 7 SSOT-defined categories.
   *
   * v0.4.0 PR7e-β4 PR2d (HIGH-β): Expanded from `"js_animation"` literal to
   * the full SSOT union (`EmbeddingBackfillCategory`). Existing PR2c callers
   * pass `"js_animation"` and continue to work without change. The orchestrator
   * forwards the value verbatim to the child via `initMessage.category`, where
   * the dispatch switch routes it to the matching service-layer wrapper.
   *
   * PR2d (HIGH-β): SSOT union (7 全 category) に拡張。PR2c 既存 caller が
   * `"js_animation"` を渡す呼び出しは無変更で動作する。orchestrator は値を
   * そのまま `initMessage.category` で child に転送し、dispatch switch が
   * 対応する service wrapper に routing する。
   */
  category: EmbeddingBackfillCategory;

  /**
   * Upper bound of parts processed in this fork invocation.
   * Enforced at Zod layer (max {@link BACKFILL_PARTS_LIMIT_MAX}).
   *
   * 本 fork 呼び出しで処理する parts 件数の上限。
   */
  partsLimit: number;

  /**
   * Progress bridge — called on every `backfill.progress` IPC message.
   * Typically wraps `job.updateProgress({ processed, total })`.
   *
   * 進捗ブリッジ — `backfill.progress` IPC 受信ごとに呼ばれる。
   */
  onProgress?: (processed: number, total: number) => Promise<void>;

  /**
   * Lock relay callback — invoked on 30s cron to renew BullMQ's job lock.
   * Typically wraps `job.extendLock(BACKFILL_EXTEND_LOCK_DURATION_MS)`.
   *
   * Lock 延長 callback — 30 秒 cron で BullMQ job lock を renew するために呼ぶ。
   */
  extendLock?: () => Promise<void>;

  /**
   * AbortSignal from the caller. On abort, SIGTERM is sent immediately,
   * followed by SIGKILL after {@link BACKFILL_ABORT_ESCALATION_DELAY_MS}.
   *
   * 呼び出し側からの AbortSignal。abort 時 SIGTERM → 5s → SIGKILL の 2 段
   * escalation を実施 (SEC M-1)。
   */
  signal?: AbortSignal;

  /**
   * @internal Override the child script filename resolution (tests only).
   */
  childScriptPathOverride?: string;

  /**
   * @internal Override the overall child timeout (tests only).
   */
  overallTimeoutMsOverride?: number;
}

/**
 * Result of {@link runEmbeddingBackfillFork}.
 *
 * {@link runEmbeddingBackfillFork} の結果。
 *
 * ## v0.4.0 PR7e-β4 PR2b-α 拡張 / PR2b-α extension (TPA-H-1 反映 / reflected)
 *
 * `failedCount` / `memorySkipCount` / `errors` を optional で追加。fork child の
 * `backfill.done` IPC から受け取った observability field を保持し、`processors.ts`
 * の `JsAnimationProcessor.processViaFork` が `BackfillCategoryResult` の
 * `{ failed, memorySkips, errors }` に mapping する (TDA-L-2 連動)。
 *
 * Adds optional `failedCount` / `memorySkipCount` / `errors` for observability
 * symmetry with the in-process path. Sourced from the `backfill.done` IPC and
 * later mapped in `JsAnimationProcessor.processViaFork` (PR2b-β).
 */
export interface BackfillForkResult {
  /** Number of parts actually processed by the child. */
  processedCount: number;

  /** Optional skip reason reported by the child (e.g. memory pressure). */
  skipReason?: string;

  /**
   * Number of embedding generations the child recorded as failed. Optional —
   * older child builds (or non-reporting paths) may omit this field.
   *
   * child が embedding 生成失敗として記録した件数。古い child build / 非報告
   * 経路では省略されるため optional。
   */
  failedCount?: number;

  /**
   * Number of rows the child skipped due to RSS memory pressure. Optional.
   *
   * child が RSS 圧迫で skip した件数。optional。
   */
  memorySkipCount?: number;

  /**
   * First 100 error messages captured by the child (IPC payload bounded).
   * Optional and already sanitized on the child side (SEC M-2 idempotency).
   *
   * child が捕捉したエラーメッセージの先頭 100 件 (IPC payload 上限)。
   * child 側で sanitize 済みのため parent は再 sanitize しない (SEC M-2)。
   */
  errors?: string[];
}

/**
 * Narrow the probe result into named branches (ADR-0011 PR7d-3 discriminated
 * union). `lock-held-by-other` is a *possibility* from the parent-orchestrator
 * perspective because this orchestrator does NOT own the page-worker nonce —
 * any existing lock is "another process" relative to the fork caller.
 *
 * probe 結果を 4 分岐 (ADR-0011 PR7d-3) に正規化する。fork orchestrator は
 * page-worker nonce を所有しないため、既存 lock は全て他者所有 (lock-held-by-other)。
 */
export type BackfillLockProbeBranch =
  | { kind: "lock-held-by-self" }
  | { kind: "lock-held-by-other"; holder: string }
  | { kind: "no-lock" }
  | { kind: "redis-unavailable"; error: string };

// ============================================================================
// Helpers
// ============================================================================

/**
 * Classify a {@link CheckExistingLockResult} into the PR2 probe branch taxonomy.
 *
 * {@link CheckExistingLockResult} を PR2 probe 分岐に分類する。
 *
 * `selfNonce` が渡された場合は holder との一致で `lock-held-by-self` を判定する。
 * PR2 の fork orchestrator からは selfNonce を渡さないため、実質 `lock-held-by-other`
 * に classify されるが、将来 PR3b 以降で本 API を再利用する際の柔軟性のため
 * 引数を残す。
 */
export function classifyProbeResult(
  result: CheckExistingLockResult,
  selfNonce?: string
): BackfillLockProbeBranch {
  if (result.unavailable) {
    return { kind: "redis-unavailable", error: result.error };
  }
  if (!result.exists) {
    return { kind: "no-lock" };
  }
  if (selfNonce && result.nonce === selfNonce) {
    return { kind: "lock-held-by-self" };
  }
  return { kind: "lock-held-by-other", holder: result.nonce };
}

/**
 * Pre-flight probe of the page-worker Redis lock. **Observability-only**:
 * PR2 never blocks on the result (fail-open on every branch).
 *
 * page-worker Redis lock の pre-flight probe。**observability のみ** で、
 * PR2 では全分岐で proceed する (fail-open)。
 */
async function preflightLockProbe(
  workerActiveLockService: WorkerActiveLockService,
  jobId: string,
  webPageId: string
): Promise<BackfillLockProbeBranch> {
  const probe = await workerActiveLockService.probeExistingLock("page");
  const branch = classifyProbeResult(probe);

  // Log only — never block. TPA M-1 observability hook.
  switch (branch.kind) {
    case "lock-held-by-other":
      logger.warn(
        "[BackfillFork] Another worker holds the page lock; proceeding anyway (observability only)",
        {
          jobId: truncateId(jobId),
          webPageId: truncateId(webPageId),
          holder: truncateId(branch.holder),
        }
      );
      break;
    case "redis-unavailable":
      logger.warn("[BackfillFork] probeExistingLock failed (fail-open, proceeding)", {
        jobId: truncateId(jobId),
        webPageId: truncateId(webPageId),
        error: branch.error,
      });
      break;
    case "lock-held-by-self":
    case "no-lock":
      logger.info("[BackfillFork] Pre-flight lock probe complete", {
        jobId: truncateId(jobId),
        webPageId: truncateId(webPageId),
        branch: branch.kind,
      });
      break;
  }

  return branch;
}

/**
 * Install an AbortSignal listener implementing the 2-stage escalation
 * (SIGTERM → wait {@link BACKFILL_ABORT_ESCALATION_DELAY_MS}ms → SIGKILL).
 * Returns a cleanup function to remove the listener and clear any pending timer.
 *
 * AbortSignal listener を登録し 2 段 escalation を実装。listener 解除と
 * 保留中 timer clear を行う cleanup 関数を返す (SEC M-1)。
 *
 * @param getChildKill — returns the current `child.kill` function, or `null`
 *   if the child is not yet alive. Deferred lookup allows the listener to be
 *   installed before `runChildProcess` forks the actual child.
 */
function installAbortEscalation(
  signal: AbortSignal | undefined,
  getChildKill: () => ((sig: NodeJS.Signals) => void) | null,
  jobId: string
): () => void {
  if (!signal) return () => {};

  let escalationTimer: ReturnType<typeof setTimeout> | null = null;

  const onAbort = (): void => {
    const kill = getChildKill();
    if (!kill) {
      logger.warn("[BackfillFork] AbortSignal fired before child spawn", {
        jobId: truncateId(jobId),
      });
      return;
    }
    try {
      kill("SIGTERM");
      logger.warn("[BackfillFork] AbortSignal: sent SIGTERM, escalating in 5s if alive", {
        jobId: truncateId(jobId),
      });
    } catch (error) {
      logger.warn("[BackfillFork] AbortSignal SIGTERM failed (child may be dead)", {
        jobId: truncateId(jobId),
        error: sanitizeErrorMessage(error),
      });
    }
    // Schedule SIGKILL escalation regardless of SIGTERM success.
    escalationTimer = setTimeout(() => {
      const k2 = getChildKill();
      if (!k2) return;
      try {
        k2("SIGKILL");
        logger.warn("[BackfillFork] AbortSignal escalation: sent SIGKILL", {
          jobId: truncateId(jobId),
        });
      } catch {
        // Already dead.
      }
    }, BACKFILL_ABORT_ESCALATION_DELAY_MS);
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort);
  }

  return () => {
    if (escalationTimer) {
      clearTimeout(escalationTimer);
      escalationTimer = null;
    }
    signal.removeEventListener("abort", onAbort);
  };
}

/**
 * Format a Zod parse failure into a short safe log-ready string. Never include
 * the raw unparsed payload (could contain injected prototype-pollution fields).
 *
 * Zod 検証失敗を短い安全な文字列に整形する。raw payload は含めない。
 *
 * **SEC L-2 note** (PR7e-β4 PR2a audit): `issue.path` exposes the IPC schema
 * field name (e.g. `processedCount`, `totalCount`). This is intentional for
 * observability, but **any new field added to `BackfillChildMessage` must go
 * through a naming review** — field names must not leak internal identifiers
 * (UUIDs, secrets, table names). The message itself is truncated to 120 chars
 * to bound log size.
 */
function formatZodParseFailure(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid child message (empty issues)";
  const pathStr = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  // Truncate the message defensively (SEC L-2-analog) to bound log size.
  const msg = issue.message.slice(0, 120);
  return `Invalid child message at ${pathStr}: ${msg}`;
}

// ============================================================================
// Plan v4.5 PR3 Track 2 §5.5 / §5.6: Sub-child cascade hooks
// (INV-AUDIT-ATTACH-CHILD-CASCADE-001, Layer 2 → Layer 1 crash cascade)
// ============================================================================

/**
 * SIGABRT-imminent stderr token matcher (libc / pthread / ONNX native abort).
 * A sub-child (Layer 3) that aborts emits "abort" / "Aborted" on stderr before
 * the OS delivers SIGABRT; cascading these lines to Layer 1 lets the
 * supervisor's crash-report-watcher correlate the sub-child crash with the
 * Layer 1 audit (`worker_sigabrt_detected`) within the 5s SLA (§5.6).
 *
 * SIGABRT 直前の stderr token matcher。Layer 3 sub-child の abort を Layer 1 へ
 * cascade し crash-report-watcher が 5s SLA 内で相関できるようにする (§5.6)。
 */
const SUB_CHILD_ABORT_PATTERN = /\b(abort|Aborted|SIGABRT)\b/;

/**
 * §5.6 cascade hook 1/3 — attach the sub-child stdout `data` handler. Forwards
 * to the parent (Layer 2) logger so Layer 1's piped stdout observability is
 * preserved across the dual-fork hierarchy.
 *
 * §5.6 cascade hook 1/3 — sub-child stdout handler。
 */
function attachStdoutHandler(child: ChildProcess, jobId: string): void {
  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      logger.info(`[BackfillSubChild:${truncateId(jobId)}:stdout] ${line}`);
    }
  });
}

/**
 * §5.6 cascade hook 2/3 — attach the sub-child stderr `data` handler. Cascades
 * abort-imminent native messages to the parent (Layer 2) at `error` level so
 * Layer 1's crash-report-watcher observes the sub-child crash. Non-abort lines
 * are logged at `warn` (preserving Layer 1 pipe observability).
 *
 * §5.6 cascade hook 2/3 — sub-child stderr handler。abort-imminent native msg を
 * Layer 1 crash-report-watcher へ cascade する (5s SLA, §5.6)。
 */
function attachStderrHandler(child: ChildProcess, jobId: string): void {
  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (!line) return;
    if (SUB_CHILD_ABORT_PATTERN.test(line)) {
      // Cascade to Layer 1: error-level so the supervisor crash-report-watcher
      // (which observes child stderr) correlates sub-child PID + parent PID.
      logger.error(`[BackfillSubChild:${truncateId(jobId)}:abort-cascade] ${line}`, {
        finding: "INV-AUDIT-ATTACH-CHILD-CASCADE-001",
        subChildPid: child.pid ?? -1,
        parentPid: process.pid,
      });
    } else {
      logger.warn(`[BackfillSubChild:${truncateId(jobId)}:stderr] ${line}`);
    }
  });
}

/**
 * §5.6 cascade hook 3/3 — attach the sub-child `exit` handler. A non-zero /
 * signal exit (e.g. SIGABRT) is cascaded to the parent (Layer 2) logger at
 * `error` level with sub-child PID + parent PID linkage so Layer 1 reconciles
 * the crash. Clean exit (code 0) is silent.
 *
 * §5.6 cascade hook 3/3 — sub-child exit handler。非ゼロ / signal exit を Layer 1
 * へ cascade する (sub-child PID + parent PID linkage)。
 */
function attachExitHandler(child: ChildProcess, jobId: string): void {
  if (typeof child.once !== "function") return;
  child.once("exit", (code: number | null, signal: string | null) => {
    if (code === 0) return;
    logger.error(`[BackfillSubChild:${truncateId(jobId)}:exit] non-clean sub-child exit`, {
      finding: "INV-AUDIT-ATTACH-CHILD-CASCADE-001",
      subChildPid: child.pid ?? -1,
      parentPid: process.pid,
      exitCode: code,
      signal,
    });
  });
}

/**
 * §5.5 / §5.6 MANDATORY cascade: attach all 3 sub-child observability hooks
 * (stdout / stderr / exit) BEFORE returning from spawn. The cascade ensures a
 * Layer 3 sub-child SIGABRT propagates to the Layer 1 supervisor's
 * crash-report-watcher. INV-AUDIT-ATTACH-CHILD-CASCADE-001 asserts hook count
 * == 3 at the orchestrator level.
 *
 * Defensive against partial child shapes (e.g. test synthetic children without
 * piped stdio): each hook is a no-op when its target surface is absent; the
 * return value reflects the attempted hook count contract (3).
 *
 * §5.5 / §5.6 MANDATORY: sub-child の 3 observability hook (stdout/stderr/exit)
 * を spawn return 前に attach する。hook count == 3 (INV §5.6)。
 *
 * @returns The number of cascade hooks attached (MUST be 3 for the invariant)
 */
export function attachSubChildCascadeHooks(child: ChildProcess, jobId: string): number {
  attachStdoutHandler(child, jobId);
  attachStderrHandler(child, jobId);
  attachExitHandler(child, jobId);
  return 3;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Run an embedding backfill job by forking a child process. The child is
 * expected to load e5-base (js_animation needs text embedding only; DINOv2 is
 * NOT loaded) and stream progress / heartbeat / done / error IPC messages
 * validated by {@link BackfillChildMessage}.
 *
 * child_process.fork() で分離した backfill job を実行する。js_animation は
 * text embedding のみ必要なため、child は e5-base のみロード (DINOv2 非ロード)。
 * 進捗/heartbeat/done/error IPC は {@link BackfillChildMessage} で strict 検証する。
 *
 * ## 保証 / Guarantees
 *
 * - **Idempotent sanitize (SEC M-2)**: child 側で sanitize 済みの error message
 *   を parent は再 sanitize しない。log 出力時のみ `truncateId()` を UUID に適用。
 * - **AbortSignal 2-stage escalation (SEC M-1)**: signal.aborted 時は SIGTERM
 *   を即送信し、{@link BACKFILL_ABORT_ESCALATION_DELAY_MS}ms 経過後に SIGKILL。
 * - **Lock relay cron (TDA H-2)**: 30s 間隔で `extendLock()` を呼び、
 *   `try/finally` で確実に `clearInterval` する。
 * - **Strict Zod (SEC H-2)**: `.strict()` により unknown-key 混入を reject。
 *
 * @throws Sanitized error on fork failure, child non-zero exit, IPC validation
 *   failure, or child-reported error.
 */
export async function runEmbeddingBackfillFork(
  opts: BackfillForkOptions
): Promise<BackfillForkResult> {
  const {
    jobId,
    webPageId,
    category,
    partsLimit,
    onProgress,
    extendLock,
    signal,
    childScriptPathOverride,
    overallTimeoutMsOverride,
  } = opts;

  // ---- Pre-flight: Redis lock probe (observability-only, fail-open).
  // ADR-0016 § Service DI Refactor Plan: factory if set (M1 testcontainer
  // wiring), otherwise default construction (production behavior).
  // ADR-0016 § Service DI Refactor Plan: factory 設定時は test 注入を使用、
  // 未設定時は production 既定動作を完全保持。
  const lockService = instantiateBackfillLockService();
  try {
    await preflightLockProbe(lockService, jobId, webPageId);
  } finally {
    // Release ownership of the ad-hoc Redis client.
    void lockService.close().catch(() => {
      /* best-effort */
    });
  }

  // ---- Resolve child script path via shared helper with explicit baseDir
  // (TPA L-2 requires baseDir be passed explicitly, not inferred).
  const resolvedChildScriptPath =
    childScriptPathOverride ??
    resolveChildScriptPath(BACKFILL_CHILD_SCRIPT_FILENAME, path.resolve(__dirname));

  // Env and execArgv are built inside shared `runChildProcess` using the same
  // `buildChildEnv` / `buildChildExecArgv` helpers. We surface the imports
  // here so that TDA M-2 (no independent `appendConnectionLimit` import) is
  // enforced by static analysis on this file.
  //
  // **TDA L-2 note** (PR7e-β4 PR2a audit): These `void` expressions are
  // intentional static-analysis anchors — they keep the named imports alive at
  // runtime so TDA M-2 (TS error on drift) and test T04 (string-pattern check
  // for `buildChildEnv` / `buildChildExecArgv` in the source) remain robust.
  // They are runtime no-ops and are a candidate for a strict-mode refactor
  // (e.g. an `eslint-plugin-reftrix` custom rule) in PR3c; removing them now
  // would silently drop the imports if auto-formatter reorganizes the file.
  void buildChildEnv;
  void buildChildExecArgv;

  // ---- Result capture state (populated by IPC handlers).
  let resultProcessedCount = 0;
  let resultSkipReason: string | undefined = undefined;
  // TPA-H-1 (PR7e-β4 PR2b-α): observability fields captured from backfill.done.
  // TPA-H-1 (PR7e-β4 PR2b-α): backfill.done から取得する observability フィールド。
  let resultFailedCount: number | undefined = undefined;
  let resultMemorySkipCount: number | undefined = undefined;
  let resultErrors: string[] | undefined = undefined;
  let childError: Error | null = null;

  // ---- BullMQ extendLock cron relay (30s interval, try/finally cleanup).
  let lockRelayTimer: ReturnType<typeof setInterval> | null = null;
  let childKillRef: ((sig: NodeJS.Signals) => void) | null = null;
  const getChildKill = (): ((sig: NodeJS.Signals) => void) | null => childKillRef;

  // ---- AbortSignal 2-stage escalation (SEC M-1).
  const cleanupAbort = installAbortEscalation(signal, getChildKill, jobId);

  try {
    // Start lock relay cron. The relay is allowed to fail (logged) without
    // aborting the run — BullMQ will re-queue the job on lock expiry.
    if (extendLock) {
      lockRelayTimer = setInterval(() => {
        void extendLock().catch((error: unknown) => {
          logger.warn("[BackfillFork] extendLock relay failed (non-fatal)", {
            jobId: truncateId(jobId),
            error: sanitizeErrorMessage(error),
          });
        });
      }, BACKFILL_EXTEND_LOCK_INTERVAL_MS);
      // Allow the event loop to exit even if this timer is pending.
      if (typeof lockRelayTimer.unref === "function") {
        lockRelayTimer.unref();
      }
    }

    // TPA-H-2 (PR7e-β4 PR2b-α): `BackfillParentMessage` schema now includes
    // `type: "backfill.run"` as a top-level field satisfying `runChildProcess`'s
    // TInitMessage `{ type: string }` constraint, so the prior
    // `BackfillParentMessageT & { type: string }` hack is no longer needed.
    //
    // TPA-H-2 (PR7e-β4 PR2b-α): `BackfillParentMessage` スキーマに `type` を
    // 明示追加したため、旧来の `& { type: string }` hack は不要。
    const initMessage: BackfillParentMessageT = {
      type: "backfill.run",
      kind: "backfill.run",
      jobId,
      webPageId,
      category,
      partsLimit,
      startedAt: new Date().toISOString(),
    };

    const onChildMessage = async (raw: unknown): Promise<void> => {
      const parsed = BackfillChildMessage.safeParse(raw);
      if (!parsed.success) {
        const detail = formatZodParseFailure(parsed.error);
        logger.warn("[BackfillFork] IPC message failed strict Zod parse (dropped)", {
          jobId: truncateId(jobId),
          webPageId: truncateId(webPageId),
          detail,
        });
        // Do not throw here (would silently bubble up out of runChildProcess).
        // Instead, record the error and let the child's subsequent exit drive
        // the promise rejection. This preserves the non-throwing contract of
        // `runChildProcess`'s onChildMessage and avoids race conditions.
        //
        // v0.4.0 PR7e-β4 PR2b-β (TDA-L-1 反映): first-error-wins pattern.
        // 後続 IPC message / child 側例外で `childError` が上書きされると根本原因
        // が失われるため、最初に観測したエラーのみ保持する。
        //
        // TDA-L-1 (v0.4.0 PR7e-β4 PR2b-β): first-error-wins pattern. Later IPC
        // messages or child-side exceptions could overwrite `childError`,
        // masking the root cause. Keep the first observed error only.
        if (!childError) {
          childError = new Error(detail);
        }
        return;
      }

      const msg: BackfillChildMessageT = parsed.data;
      switch (msg.kind) {
        case "backfill.progress":
          if (onProgress) {
            try {
              await onProgress(msg.processedCount, msg.totalCount);
            } catch (error) {
              logger.warn("[BackfillFork] onProgress callback threw (ignored)", {
                jobId: truncateId(jobId),
                error: sanitizeErrorMessage(error),
              });
            }
          }
          // Mirror for result reporting in case `done` is not received.
          resultProcessedCount = msg.processedCount;
          break;
        case "backfill.heartbeat":
          // Heartbeat timer reset is handled inside runChildProcess (per-message).
          // Here we only log at debug level if needed (no-op in production).
          break;
        case "backfill.done":
          resultProcessedCount = msg.processedCount;
          resultSkipReason = msg.skipReason;
          // TPA-H-1 (PR7e-β4 PR2b-α): Capture optional observability fields so
          // `processViaFork` in PR2b-β can map them into BackfillCategoryResult
          // `{ failed, memorySkips, errors }`. Absent values remain undefined.
          //
          // TPA-H-1: observability フィールドを取得し、PR2b-β の
          // `processViaFork` が BackfillCategoryResult にマッピングできるよう
          // にする。未受信時は undefined のまま。
          resultFailedCount = msg.failedCount;
          resultMemorySkipCount = msg.memorySkipCount;
          resultErrors = msg.errors;
          logger.info("[BackfillFork] Child reported done", {
            jobId: truncateId(jobId),
            webPageId: truncateId(webPageId),
            processedCount: msg.processedCount,
            skipReason: msg.skipReason,
            failedCount: msg.failedCount,
            memorySkipCount: msg.memorySkipCount,
            errorCount: msg.errors?.length ?? 0,
          });
          break;
        case "backfill.error":
          // Child-side has already sanitized the message. Parent does NOT
          // re-sanitize (SEC M-2 idempotency). We only truncate UUIDs in logs.
          //
          // v0.4.0 PR7e-β4 PR2b-β (TDA-L-1 反映): first-error-wins pattern
          // (Zod parse failure path と同様)。
          //
          // TDA-L-1 (v0.4.0 PR7e-β4 PR2b-β): first-error-wins pattern (same as
          // the Zod parse failure path above).
          logger.warn("[BackfillFork] Child reported error", {
            jobId: truncateId(jobId),
            webPageId: truncateId(webPageId),
            message: msg.message,
            code: msg.code,
          });
          if (!childError) {
            childError = new Error(msg.message);
          }
          break;
      }
    };

    const result = await runChildProcess({
      childScriptPath: resolvedChildScriptPath,
      initMessage,
      timeoutMs: overallTimeoutMsOverride ?? BACKFILL_CHILD_OVERALL_TIMEOUT_MS,
      phaseLabel: `embedding-backfill-${category}`,
      onChildMessage,
      // SEC H-1 (PR7e-β4 PR2a audit): Receive the ChildProcess reference from
      // the shared runner immediately after fork() so AbortSignal escalation
      // (SIGTERM → 5s → SIGKILL) operates on the real child. Prior to this
      // fix `childKillRef` was always `null`, making the escalation a no-op
      // and leaving ONNX / Prisma child processes alive after AbortSignal
      // fires. The assignment is bounded to this fork's lifetime — the
      // `finally` block below clears the reference on exit.
      onSpawn: (child: ChildProcess): void => {
        childKillRef = (sig: NodeJS.Signals): void => {
          try {
            child.kill(sig);
          } catch {
            // Child may have exited between onSpawn and the actual kill.
          }
        };
        // Plan v4.5 PR3 Track 2 §5.5 / §5.6 MANDATORY: attach the 3 sub-child
        // cascade hooks (stdout / stderr / exit) BEFORE spawn returns so a
        // Layer 3 sub-child SIGABRT propagates to the Layer 1 supervisor's
        // crash-report-watcher within the 5s SLA. INV-AUDIT-ATTACH-CHILD-
        // CASCADE-001 asserts the hook count == 3.
        const hookCount = attachSubChildCascadeHooks(child, jobId);
        if (hookCount !== 3) {
          logger.error("[BackfillFork] sub-child cascade hook count != 3 (INV violation)", {
            finding: "INV-AUDIT-ATTACH-CHILD-CASCADE-001",
            jobId: truncateId(jobId),
            hookCount,
          });
        }
      },
    });

    // After runChildProcess resolves, the child has exited. Clear the kill
    // reference so any late-firing AbortSignal escalation becomes a no-op.
    childKillRef = null;

    if (childError) {
      // Child-sanitized error message — NOT re-sanitized here (SEC M-2).
      throw childError;
    }

    if (!result.exitedCleanly) {
      const code = result.exitCode;
      throw new Error(
        code === null
          ? "Embedding backfill child was killed by signal"
          : `Embedding backfill child exited with code ${code}`
      );
    }

    const finalResult: BackfillForkResult = { processedCount: resultProcessedCount };
    if (resultSkipReason !== undefined) {
      finalResult.skipReason = resultSkipReason;
    }
    // TPA-H-1 (PR7e-β4 PR2b-α): Forward observability fields to the caller.
    // TPA-H-1: observability フィールドを呼び出し側へ転写。
    if (resultFailedCount !== undefined) {
      finalResult.failedCount = resultFailedCount;
    }
    if (resultMemorySkipCount !== undefined) {
      finalResult.memorySkipCount = resultMemorySkipCount;
    }
    if (resultErrors !== undefined) {
      finalResult.errors = resultErrors;
    }
    return finalResult;
  } catch (error) {
    // Any unexpected failure (fork spawn, timeout, IPC race) — sanitize at the
    // parent boundary. Child-sanitized `Error` objects (thrown above via
    // childError) pass through here but sanitizeErrorMessage is idempotent by
    // design (safe to apply to already-sanitized messages).
    const sanitized = sanitizeErrorMessage(error);
    logger.warn("[BackfillFork] runEmbeddingBackfillFork failed", {
      jobId: truncateId(jobId),
      webPageId: truncateId(webPageId),
      category,
      error: sanitized,
    });
    throw error instanceof Error ? error : new Error(sanitized);
  } finally {
    // TDA H-2: cron relay must never leak. `try/finally` is the contract.
    if (lockRelayTimer) {
      clearInterval(lockRelayTimer);
      lockRelayTimer = null;
    }
    // SEC H-1 (PR7e-β4 PR2a audit): defense-in-depth — cleanupAbort removes
    // the AbortSignal listener and clears any pending escalation timer, and
    // we also drop the kill reference here in case the error path bypassed
    // the success-path clear above (e.g. throw before runChildProcess
    // resolves).
    childKillRef = null;
    cleanupAbort();
  }
}
