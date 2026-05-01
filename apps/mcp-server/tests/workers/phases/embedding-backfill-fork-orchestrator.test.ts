// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill Fork Orchestrator Tests (v0.4.0 PR7e-β4 PR2a)
 *
 * `runEmbeddingBackfillFork()` の親プロセス側 wrapper のユニットテスト。
 * shared `runChildProcess` と `WorkerActiveLockService.probeExistingLock` を
 * vi.mock で差し替え、synthetic IPC message を流すことで fork の lifecycle
 * を実機起動なしに検証する。
 *
 * T01: flag 未設定 / =false で fork 経路に入らない (SEC M-3 env-guard)
 * T02: flag=true + category=js_animation で fork 経路呼び出し
 * T03: 他カテゴリは fork 経路に入らない (js_animation only)
 * T04: shared helpers (buildChildEnv / buildChildExecArgv / resolveChildScriptPath) の使用
 * T05: resolveChildScriptPath が baseDir 明示 (TPA L-2)
 * T06: backfill.progress IPC で onProgress bridge 発火
 * T07: backfill.heartbeat IPC で runner の per-message reset に通る
 * T08: backfill.done IPC で resolve、processedCount 返却
 * T09: backfill.error IPC で reject、child-sanitized message を parent が再 sanitize しない (SEC M-2)
 * T10: invalid IPC message を Zod .strict() safeParse で reject (TDA M-1 + SEC H-2)
 * T11: child 非 0 exit で reject
 * T12: fork spawn 失敗 / exitedCleanly=false で throw
 * T13: probeExistingLock の 4 分岐 (self / other / no-lock / redis-unavailable) すべて fail-open で proceed
 * T14: extendLock cron が 30s 間隔で呼ばれ、try/finally で clearInterval される (TDA H-3)
 * T15: SPDX ヘッダ検証 (TDA L-3)
 * T16: AbortSignal SIGTERM → 5s → SIGKILL escalation (SEC M-1)
 * T17: Sanitize 冪等性 — child 側 sanitize 済み message を parent が再変形しない (SEC M-2)
 *
 * @module tests/workers/phases/embedding-backfill-fork-orchestrator
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ============================================================================
// Module Paths (used by T15 SPDX header check)
// ============================================================================

const ORCHESTRATOR_SRC = path.resolve(
  __dirname,
  "../../../src/workers/phases/embedding-backfill-fork-orchestrator.ts"
);
const IPC_SRC = path.resolve(__dirname, "../../../src/workers/phases/embedding-backfill-ipc.ts");
const CHILD_SRC = path.resolve(
  __dirname,
  "../../../src/workers/phases/embedding-backfill-child.ts"
);

// ============================================================================
// Mocks (module-scoped)
// ============================================================================

/**
 * Mocked `runChildProcess` controller — tests configure one "script" per run,
 * which synthesizes a sequence of IPC messages and an exit outcome.
 *
 * vi.mock ファクトリはモジュール 1 回評価されるため、ここでは `vi.hoisted`
 * でコントローラを宣言しテスト個別にスクリプトを差し替える。
 *
 * PR7e-β4 PR2a 監査対応 (SEC H-1): mock が `onSpawn` callback を呼び出す
 * ようになり、テスト側で kill spy を `lastKillSpy` に capture できる。
 */
const sharedControls = vi.hoisted(() => {
  type RunScript = {
    /** IPC messages to be dispatched to the caller's onChildMessage. */
    messages: unknown[];
    /** Delay (ms) between messages. Zero by default to keep tests fast. */
    messageDelayMs?: number;
    /** Final run result. */
    result: { exitedCleanly: boolean; exitCode: number | null };
    /** Optional: throw synchronously instead of resolving (simulates spawn failure). */
    throwOn?: Error;
    /**
     * Optional delay (ms) BEFORE dispatching any IPC messages. Used by tests
     * that need the AbortSignal to fire while the "child" is still alive.
     */
    holdBeforeMessagesMs?: number;
  };
  const ctl: {
    script: RunScript | null;
    lastOptions: unknown;
    lastKillSpy: ((sig: NodeJS.Signals) => void) | null;
    killCalls: Array<{ sig: NodeJS.Signals; at: number }>;
  } = {
    script: null,
    lastOptions: null,
    lastKillSpy: null,
    killCalls: [],
  };
  return {
    ctl,
    setScript(s: RunScript): void {
      ctl.script = s;
    },
    reset(): void {
      ctl.script = null;
      ctl.lastOptions = null;
      ctl.lastKillSpy = null;
      ctl.killCalls = [];
    },
    getLastOptions(): unknown {
      return ctl.lastOptions;
    },
  };
});

const lockProbeControls = vi.hoisted(() => {
  type ProbeOutcome =
    | { unavailable: false; exists: false }
    | { unavailable: false; exists: true; nonce: string }
    | { unavailable: true; error: string };
  const ctl: { outcome: ProbeOutcome; callCount: number; closeCount: number } = {
    outcome: { unavailable: false, exists: false },
    callCount: 0,
    closeCount: 0,
  };
  return {
    ctl,
    setOutcome(o: ProbeOutcome): void {
      ctl.outcome = o;
    },
    reset(): void {
      ctl.outcome = { unavailable: false, exists: false };
      ctl.callCount = 0;
      ctl.closeCount = 0;
    },
  };
});

vi.mock("../../../src/workers/phases/shared/fork-common", () => ({
  buildChildEnv: vi.fn(() => ({})),
  buildChildExecArgv: vi.fn(() => ["--max-old-space-size=4096", "--expose-gc"]),
  resolveChildScriptPath: vi.fn(
    (filename: string, baseDir?: string) => `${baseDir ?? "<no-basedir>"}/${filename}`
  ),
  appendConnectionLimit: vi.fn((u: string, n: number) => `${u}?connection_limit=${n}`),
  runChildProcess: vi.fn(async (options: unknown) => {
    sharedControls.ctl.lastOptions = options;
    const script = sharedControls.ctl.script;
    if (!script) {
      throw new Error(
        "Test script not configured; call setScript() before runEmbeddingBackfillFork"
      );
    }
    const opts = options as {
      onChildMessage?: (raw: unknown) => Promise<void> | void;
      onSpawn?: (child: unknown) => void;
    };
    // SEC H-1 (PR7e-β4 PR2a audit): invoke onSpawn with a synthetic
    // ChildProcess-shaped spy so the caller's AbortSignal wiring can capture
    // a real kill function. Kill calls are recorded with a timestamp in
    // `killCalls` so T16 can assert SIGTERM → 5s → SIGKILL ordering.
    const syntheticChild = {
      kill: (sig: NodeJS.Signals) => {
        sharedControls.ctl.killCalls.push({ sig, at: Date.now() });
      },
    };
    if (opts.onSpawn) {
      opts.onSpawn(syntheticChild);
      sharedControls.ctl.lastKillSpy = syntheticChild.kill;
    }
    if (script.throwOn) {
      throw script.throwOn;
    }
    if (script.holdBeforeMessagesMs && script.holdBeforeMessagesMs > 0) {
      await new Promise((r) => setTimeout(r, script.holdBeforeMessagesMs));
    }
    // Dispatch each IPC message to the caller's onChildMessage.
    for (const msg of script.messages) {
      if (opts.onChildMessage) {
        const maybePromise = opts.onChildMessage(msg);
        if (maybePromise instanceof Promise) {
          await maybePromise;
        }
      }
      if (script.messageDelayMs && script.messageDelayMs > 0) {
        await new Promise((r) => setTimeout(r, script.messageDelayMs));
      }
    }
    return script.result;
  }),
}));

vi.mock("../../../src/services/worker-active-lock.service", () => {
  class MockLockService {
    async probeExistingLock(): Promise<unknown> {
      lockProbeControls.ctl.callCount += 1;
      return lockProbeControls.ctl.outcome;
    }
    async close(): Promise<void> {
      lockProbeControls.ctl.closeCount += 1;
    }
  }
  return { WorkerActiveLockService: MockLockService };
});

// ============================================================================
// Helpers
// ============================================================================

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

function buildDoneMessage(processed = 3, skipReason?: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    kind: "backfill.done",
    processedCount: processed,
  };
  if (skipReason !== undefined) base.skipReason = skipReason;
  return base;
}

/**
 * PR7e-β4 PR2b-α (TPA-H-1): done message with the new observability fields.
 * Mirrors the PR2b-α `BackfillDoneMessage` extension.
 *
 * PR7e-β4 PR2b-α (TPA-H-1): TPA-H-1 で追加された observability フィールド入り
 * の done message。`BackfillDoneMessage` の拡張を反映。
 */
function buildDoneMessageWithObservability(
  processed: number,
  failed: number,
  memorySkips: number,
  errors: string[]
): Record<string, unknown> {
  return {
    kind: "backfill.done",
    processedCount: processed,
    failedCount: failed,
    memorySkipCount: memorySkips,
    errors,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("runEmbeddingBackfillFork — parent orchestrator", () => {
  beforeEach(() => {
    sharedControls.reset();
    lockProbeControls.reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // T01: flag unset / =false does not enter fork path at the processor layer.
  // PR2a 時点では processor に flag 分岐がまだ接続されていない (PR2b で接続)
  // ため、本テストは CI-pinning として flag evaluation が必ず Job start 時に
  // 行われるよう、関数を直接呼んだ時に flag は参照されないこと (orchestrator
  // 内部で flag 読み取りしない) を保証する。
  // --------------------------------------------------------------------------
  it("T01: PR2a orchestrator does not read EMBEDDING_BACKFILL_FORK_ENABLED at runtime (flag is processor-layer only)", async () => {
    const src = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
    // The flag name may appear in comments/docstrings referring to PR2b,
    // but must never be read from `process.env` inside the orchestrator
    // itself. The flag is evaluated at the processor layer only.
    expect(src).not.toMatch(/process\.env\.EMBEDDING_BACKFILL_FORK_ENABLED/);
    expect(src).not.toMatch(/process\.env\[['"]EMBEDDING_BACKFILL_FORK_ENABLED['"]\]/);
  });

  // --------------------------------------------------------------------------
  // T02: flag=true + category=js_animation → fork path invoked.
  // orchestrator 層では category="js_animation" が強制されることを確認。
  // --------------------------------------------------------------------------
  it("T02: accepts category='js_animation' and returns done result", async () => {
    sharedControls.setScript({
      messages: [buildDoneMessage(5)],
      result: { exitedCleanly: true, exitCode: 0 },
    });
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    const result = await runEmbeddingBackfillFork({
      jobId: "job-1",
      webPageId: VALID_UUID,
      category: "js_animation",
      partsLimit: 100,
    });
    expect(result.processedCount).toBe(5);
  });

  // --------------------------------------------------------------------------
  // T03 (PR2d HIGH-β): type system accepts the full SSOT-backed
  // `EmbeddingBackfillCategory` union (7 values). Previously (PR2a canary)
  // narrowed to literal `"js_animation"`; PR2d expands to the SSOT union so
  // the dispatch switch in the child entry covers all 7 categories.
  //
  // T03 (PR2d HIGH-β): type system は SSOT-backed `EmbeddingBackfillCategory`
  // union (7 値) を受け入れる。PR2a canary 時点では literal `"js_animation"`
  // に制限していたが、PR2d で child entry の dispatch switch が 7 全 category
  // をカバーするため SSOT union に拡張。
  // --------------------------------------------------------------------------
  it("T03 (PR2d): type signature uses SSOT EmbeddingBackfillCategory union (7 categories)", async () => {
    const src = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
    // Orchestrator interface uses the SSOT union type imported from the IPC
    // schema (which re-exports from queues/embedding-backfill-queue.ts).
    // 7 全 category をカバーするため SSOT union を使う。
    expect(src).toMatch(/category:\s*EmbeddingBackfillCategory/);
    // Import the type from the IPC schema (re-exported from the queue SSOT).
    expect(src).toMatch(/import\s+\{[^}]*\bEmbeddingBackfillCategory\b[^}]*\}\s+from/);
    // Must NOT have the old literal-string narrowing.
    expect(src).not.toMatch(/category:\s*"js_animation";/);
  });

  // --------------------------------------------------------------------------
  // T04: buildChildEnv / buildChildExecArgv / resolveChildScriptPath are
  // sourced from shared/fork-common (TDA M-2: no independent appendConnectionLimit).
  // --------------------------------------------------------------------------
  it("T04: imports shared helpers from fork-common (TDA M-2 no-independent-import)", async () => {
    const src = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
    // Single canonical import line for shared helpers.
    expect(src).toMatch(/from\s+["']\.\/shared\/fork-common["']/);
    expect(src).toMatch(/buildChildEnv/);
    expect(src).toMatch(/buildChildExecArgv/);
    expect(src).toMatch(/resolveChildScriptPath/);
    expect(src).toMatch(/runChildProcess/);
    // No independent `appendConnectionLimit` import outside shared.
    const forbidden = src.match(
      /import[^;]*\bappendConnectionLimit\b[^;]*from\s+["'](?!\.\/shared\/fork-common)[^"']+["']/
    );
    expect(forbidden).toBeNull();
  });

  // --------------------------------------------------------------------------
  // T05: resolveChildScriptPath is called with explicit baseDir (TPA L-2).
  // --------------------------------------------------------------------------
  it("T05: resolveChildScriptPath is called with an explicit baseDir (TPA L-2)", async () => {
    sharedControls.setScript({
      messages: [buildDoneMessage(1)],
      result: { exitedCleanly: true, exitCode: 0 },
    });
    const fc = await import("../../../src/workers/phases/shared/fork-common");
    const spy = vi.mocked(fc.resolveChildScriptPath);
    spy.mockClear();
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    await runEmbeddingBackfillFork({
      jobId: "job-1",
      webPageId: VALID_UUID,
      category: "js_animation",
      partsLimit: 100,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0];
    expect(args).toBeDefined();
    expect(args![0]).toBe("embedding-backfill-child.js");
    expect(typeof args![1]).toBe("string");
    expect((args![1] as string).length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // T06: backfill.progress IPC fires onProgress bridge.
  // --------------------------------------------------------------------------
  it("T06: backfill.progress IPC invokes onProgress callback", async () => {
    sharedControls.setScript({
      messages: [
        { kind: "backfill.progress", processedCount: 10, totalCount: 100 },
        buildDoneMessage(10),
      ],
      result: { exitedCleanly: true, exitCode: 0 },
    });
    const onProgress = vi.fn(async (_p: number, _t: number) => {});
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    await runEmbeddingBackfillFork({
      jobId: "job-1",
      webPageId: VALID_UUID,
      category: "js_animation",
      partsLimit: 100,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(10, 100);
  });

  // --------------------------------------------------------------------------
  // T07: heartbeat IPC is accepted without error (reset is handled in runner).
  // --------------------------------------------------------------------------
  it("T07: backfill.heartbeat IPC is accepted and run proceeds", async () => {
    sharedControls.setScript({
      messages: [{ kind: "backfill.heartbeat", at: new Date().toISOString() }, buildDoneMessage(2)],
      result: { exitedCleanly: true, exitCode: 0 },
    });
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    const result = await runEmbeddingBackfillFork({
      jobId: "job-1",
      webPageId: VALID_UUID,
      category: "js_animation",
      partsLimit: 100,
    });
    expect(result.processedCount).toBe(2);
  });

  // --------------------------------------------------------------------------
  // T08: backfill.done IPC resolves promise with processedCount.
  // --------------------------------------------------------------------------
  it("T08: backfill.done IPC resolves with processedCount + skipReason", async () => {
    sharedControls.setScript({
      messages: [buildDoneMessage(7, "no_parts_remaining")],
      result: { exitedCleanly: true, exitCode: 0 },
    });
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    const result = await runEmbeddingBackfillFork({
      jobId: "job-1",
      webPageId: VALID_UUID,
      category: "js_animation",
      partsLimit: 100,
    });
    expect(result.processedCount).toBe(7);
    expect(result.skipReason).toBe("no_parts_remaining");
  });

  // --------------------------------------------------------------------------
  // T09: backfill.error IPC rejects with child-sanitized message (parent does
  // NOT re-sanitize — SEC M-2 idempotency).
  // --------------------------------------------------------------------------
  it("T09: backfill.error IPC rejects with child-sanitized message preserved verbatim", async () => {
    const childSanitizedMessage = "Database operation failed";
    sharedControls.setScript({
      messages: [{ kind: "backfill.error", message: childSanitizedMessage, code: "P2025" }],
      result: { exitedCleanly: false, exitCode: 1 },
    });
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    await expect(
      runEmbeddingBackfillFork({
        jobId: "job-err",
        webPageId: VALID_UUID,
        category: "js_animation",
        partsLimit: 100,
      })
    ).rejects.toThrow(childSanitizedMessage);
  });

  // --------------------------------------------------------------------------
  // T10: invalid IPC (e.g. unknown kind or unknown extra key) fails Zod
  // .strict() safeParse inside onChildMessage. The parent marks childError
  // and rejects on exit.
  // --------------------------------------------------------------------------
  it("T10: invalid IPC (unknown kind) is rejected by Zod .strict() safeParse and rejects the promise", async () => {
    sharedControls.setScript({
      messages: [{ kind: "backfill.bogus", processedCount: 1 }],
      result: { exitedCleanly: false, exitCode: 1 },
    });
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    await expect(
      runEmbeddingBackfillFork({
        jobId: "job-bad",
        webPageId: VALID_UUID,
        category: "js_animation",
        partsLimit: 100,
      })
    ).rejects.toThrow(/Invalid child message/);
  });

  // --------------------------------------------------------------------------
  // T11: non-zero exit code rejects.
  // --------------------------------------------------------------------------
  it("T11: child non-zero exit rejects with descriptive error", async () => {
    sharedControls.setScript({
      messages: [], // no messages, just dirty exit
      result: { exitedCleanly: false, exitCode: 42 },
    });
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    await expect(
      runEmbeddingBackfillFork({
        jobId: "job-exit",
        webPageId: VALID_UUID,
        category: "js_animation",
        partsLimit: 100,
      })
    ).rejects.toThrow(/exited with code 42/);
  });

  // --------------------------------------------------------------------------
  // T12: fork spawn failure (runChildProcess throws) bubbles up.
  // --------------------------------------------------------------------------
  it("T12: spawn failure (runChildProcess throws) bubbles up as rejection", async () => {
    sharedControls.setScript({
      messages: [],
      result: { exitedCleanly: false, exitCode: null },
      throwOn: new Error("spawn ENOENT"),
    });
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    await expect(
      runEmbeddingBackfillFork({
        jobId: "job-spawn",
        webPageId: VALID_UUID,
        category: "js_animation",
        partsLimit: 100,
      })
    ).rejects.toThrow();
  });

  // --------------------------------------------------------------------------
  // T13: probeExistingLock 4-branch coverage (ADR-0011 PR7d-3 discriminated union).
  // All branches must fail-open (proceed without blocking).
  // --------------------------------------------------------------------------
  describe("T13: probeExistingLock 4-branch fail-open (TPA M-1, ADR-0011 PR7d-3)", () => {
    const scenarios: Array<{
      name: string;
      outcome:
        | { unavailable: false; exists: false }
        | { unavailable: false; exists: true; nonce: string }
        | { unavailable: true; error: string };
    }> = [
      { name: "no-lock", outcome: { unavailable: false, exists: false } },
      {
        name: "lock-held-by-other",
        outcome: { unavailable: false, exists: true, nonce: "other-nonce-xyz" },
      },
      {
        name: "lock-held-by-self-shaped (still treated as other without selfNonce)",
        outcome: { unavailable: false, exists: true, nonce: "self-nonce" },
      },
      {
        name: "redis-unavailable",
        outcome: { unavailable: true, error: "ECONNREFUSED" },
      },
    ];

    for (const s of scenarios) {
      it(`T13/${s.name}: proceeds without blocking (fail-open)`, async () => {
        lockProbeControls.setOutcome(s.outcome);
        sharedControls.setScript({
          messages: [buildDoneMessage(1)],
          result: { exitedCleanly: true, exitCode: 0 },
        });
        const { runEmbeddingBackfillFork } =
          await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
        const result = await runEmbeddingBackfillFork({
          jobId: "job-lock",
          webPageId: VALID_UUID,
          category: "js_animation",
          partsLimit: 100,
        });
        expect(result.processedCount).toBe(1);
        expect(lockProbeControls.ctl.callCount).toBe(1);
      });
    }

    it("T13/classifyProbeResult maps all 4 branches correctly", async () => {
      const { classifyProbeResult } =
        await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
      expect(classifyProbeResult({ unavailable: false, exists: false }).kind).toBe("no-lock");
      expect(classifyProbeResult({ unavailable: false, exists: true, nonce: "n" }).kind).toBe(
        "lock-held-by-other"
      );
      expect(
        classifyProbeResult({ unavailable: false, exists: true, nonce: "me" }, "me").kind
      ).toBe("lock-held-by-self");
      expect(classifyProbeResult({ unavailable: true, error: "err" }).kind).toBe(
        "redis-unavailable"
      );
    });
  });

  // --------------------------------------------------------------------------
  // T14: extendLock cron — verified via BOTH fake timer (unit) and integration
  // (try/finally cleanup via source-level assertion). TDA H-3 two-way check.
  // --------------------------------------------------------------------------
  it("T14 (fake timer): extendLock cron fires every 30s and cleanup runs in finally", async () => {
    vi.useFakeTimers();
    try {
      const extendLock = vi.fn(async () => {});
      // Script with a holdBeforeMessagesMs gate: mocked runChildProcess waits
      // for a fake-timer-driven setTimeout between each message, giving the
      // orchestrator's setInterval(30s) enough real opportunities to fire.
      sharedControls.setScript({
        messages: [
          { kind: "backfill.heartbeat", at: "2026-01-01T00:00:00.000Z" },
          { kind: "backfill.heartbeat", at: "2026-01-01T00:00:30.000Z" },
          buildDoneMessage(1),
        ],
        // Each message gates on a 30_000ms fake timer tick inside the mock,
        // so two ticks elapse between "start" and "done" — guaranteeing at
        // least two setInterval(30s) firings of the cron relay.
        messageDelayMs: 30_000,
        result: { exitedCleanly: true, exitCode: 0 },
      });
      const { runEmbeddingBackfillFork } =
        await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
      const runPromise = runEmbeddingBackfillFork({
        jobId: "job-cron",
        webPageId: VALID_UUID,
        category: "js_animation",
        partsLimit: 100,
        extendLock,
      });
      // Drain fake timers: this advances both the mock's per-message delay
      // AND the orchestrator's setInterval(30s) cron relay interleaved.
      await vi.runAllTimersAsync();
      const result = await runPromise;
      expect(result.processedCount).toBe(1);
      expect(extendLock.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("T14 (source guarantee): try/finally clearInterval is present in source (TDA H-3)", () => {
    const src = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
    // Must contain a finally clause that clears the interval.
    expect(src).toMatch(/finally\s*\{[\s\S]*?clearInterval\s*\(/);
    // Must declare the 30s interval constant explicitly.
    expect(src).toMatch(/BACKFILL_EXTEND_LOCK_INTERVAL_MS\s*=\s*30_?000/);
  });

  // --------------------------------------------------------------------------
  // T15: SPDX header presence (TDA L-3).
  // embedding-backfill-child.ts is introduced in PR2b. PR2a verifies the 2
  // existing files strictly, and skips the child check with a clear comment
  // when the file does not yet exist (forward-compatible with PR2b).
  // --------------------------------------------------------------------------
  describe("T15: SPDX header presence (TDA L-3)", () => {
    const expectedTag = "SPDX-License-Identifier: AGPL-3.0-only";

    it.each([
      ["embedding-backfill-fork-orchestrator.ts", ORCHESTRATOR_SRC],
      ["embedding-backfill-ipc.ts", IPC_SRC],
    ])("%s has SPDX AGPL-3.0-only header", (_label, file) => {
      const head = fs.readFileSync(file, "utf-8").split("\n").slice(0, 2).join("\n");
      expect(head).toContain(expectedTag);
    });

    it("embedding-backfill-child.ts has SPDX AGPL-3.0-only header (PR2b-α: now required)", () => {
      // PR7e-β4 PR2b-α: child.ts is now a real file, so the SPDX check is a
      // hard requirement rather than a file-exists short-circuit.
      //
      // PR7e-β4 PR2b-α: child.ts は実ファイルとして存在するため、SPDX 検証は
      // file-exists short-circuit ではなく hard requirement に昇格。
      expect(fs.existsSync(CHILD_SRC)).toBe(true);
      const head = fs.readFileSync(CHILD_SRC, "utf-8").split("\n").slice(0, 2).join("\n");
      expect(head).toContain(expectedTag);
    });
  });

  // --------------------------------------------------------------------------
  // T16: AbortSignal 2-stage escalation (SEC M-1 / PR7e-β4 PR2a audit SEC H-1).
  // --------------------------------------------------------------------------
  describe("T16: AbortSignal 2-stage escalation (SEC M-1 / audit SEC H-1)", () => {
    // Source-level contract: the constants and the SIGTERM → setTimeout →
    // SIGKILL ordering MUST be present. This is a cheap pinning check that
    // also protects against reorganizing refactors.
    //
    // **TDA L-1 note** (PR7e-β4 PR2a audit): This is a source-regex test.
    // A future PR3c custom-AST / eslint-plugin-reftrix rule should replace
    // these string-pattern greps with structural checks (AST walk over the
    // orchestrator module confirming `kill("SIGTERM")` dominates a
    // `setTimeout(..., BACKFILL_ABORT_ESCALATION_DELAY_MS)` which contains
    // `kill("SIGKILL")`).
    it("T16a (source): BACKFILL_ABORT_ESCALATION_DELAY_MS=5_000 + SIGTERM→setTimeout→SIGKILL ordering", () => {
      const src = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
      expect(src).toMatch(/BACKFILL_ABORT_ESCALATION_DELAY_MS\s*=\s*5[_ ]?000/);
      expect(src).toMatch(/SIGTERM[\s\S]*?setTimeout[\s\S]*?SIGKILL/);
    });

    // Runtime verification: with a real AbortController triggered during a
    // fake-timer run, assert SIGTERM fires immediately and SIGKILL is
    // scheduled exactly {@link BACKFILL_ABORT_ESCALATION_DELAY_MS}=5_000 ms
    // later. Uses the onSpawn spy installed by the mocked runChildProcess.
    //
    // This fix (SEC H-1): before the audit, `childKillRef = null` was set
    // unconditionally, making SIGTERM / SIGKILL both no-ops. The test
    // `killCalls.length >= 2` assertion pins down the runtime behavior.
    it("T16b (runtime): AbortController triggers SIGTERM immediately + SIGKILL after 5_000 ms", async () => {
      vi.useFakeTimers();
      try {
        const ac = new AbortController();
        sharedControls.setScript({
          // `holdBeforeMessagesMs` keeps the mocked child "alive" long enough
          // for the abort + escalation to fire before `done` IPC is emitted.
          holdBeforeMessagesMs: 10_000,
          messages: [buildDoneMessage(0)],
          result: { exitedCleanly: false, exitCode: 143 }, // SIGTERM exit code
        });
        const { runEmbeddingBackfillFork } =
          await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
        const runPromise = runEmbeddingBackfillFork({
          jobId: "job-abort",
          webPageId: VALID_UUID,
          category: "js_animation",
          partsLimit: 100,
          signal: ac.signal,
        });
        // Pre-attach catch to prevent unhandled rejection during fake-timer
        // advance (runPromise rejects with exitedCleanly=false after abort,
        // before the test awaits the promise at the end).
        const runResult = runPromise.catch(() => {
          // Expected: exitedCleanly=false surfaces as a rejection.
        });

        // Let the orchestrator install onSpawn listener.
        await vi.advanceTimersByTimeAsync(1);
        // Trigger abort — expect SIGTERM immediately.
        ac.abort();
        // Drain microtasks so the abort handler runs.
        await Promise.resolve();
        await Promise.resolve();

        expect(sharedControls.ctl.killCalls.length).toBeGreaterThanOrEqual(1);
        expect(sharedControls.ctl.killCalls[0]?.sig).toBe("SIGTERM");

        // Advance by escalation delay (5_000 ms).
        await vi.advanceTimersByTimeAsync(5_000);

        // SIGKILL should now have been issued.
        const sigs = sharedControls.ctl.killCalls.map((c) => c.sig);
        expect(sigs).toContain("SIGKILL");
        expect(sigs.indexOf("SIGTERM")).toBeLessThan(sigs.indexOf("SIGKILL"));

        // Drain the script's remaining delay so the run promise resolves.
        await vi.runAllTimersAsync();
        await runResult;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --------------------------------------------------------------------------
  // T18 (audit TDA H-1): extendLock callback reject path is swallowed.
  // Covers line 458 catch-branch of `extendLock().catch(...)`.
  // --------------------------------------------------------------------------
  it("T18 (audit TDA H-1): extendLock reject path is logged and run continues", async () => {
    vi.useFakeTimers();
    try {
      const extendLock = vi.fn(async () => {
        throw new Error("Simulated BullMQ extendLock failure");
      });
      sharedControls.setScript({
        messages: [
          { kind: "backfill.heartbeat", at: "2026-01-01T00:00:00.000Z" },
          { kind: "backfill.heartbeat", at: "2026-01-01T00:00:30.000Z" },
          buildDoneMessage(4),
        ],
        messageDelayMs: 30_000,
        result: { exitedCleanly: true, exitCode: 0 },
      });
      const { runEmbeddingBackfillFork } =
        await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
      const runPromise = runEmbeddingBackfillFork({
        jobId: "job-extendLock-reject",
        webPageId: VALID_UUID,
        category: "js_animation",
        partsLimit: 100,
        extendLock,
      });
      await vi.runAllTimersAsync();
      const result = await runPromise;
      // extendLock was attempted but rejected — run still succeeds.
      expect(extendLock.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(result.processedCount).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  // --------------------------------------------------------------------------
  // T19 (audit TDA H-1): onProgress callback throw is swallowed.
  // Covers line 504 catch-branch of `await onProgress(...)`.
  // --------------------------------------------------------------------------
  it("T19 (audit TDA H-1): onProgress throw is logged and run continues", async () => {
    const onProgress = vi.fn(async () => {
      throw new Error("Simulated onProgress failure");
    });
    sharedControls.setScript({
      messages: [
        { kind: "backfill.progress", processedCount: 2, totalCount: 10 },
        { kind: "backfill.progress", processedCount: 5, totalCount: 10 },
        buildDoneMessage(10),
      ],
      result: { exitedCleanly: true, exitCode: 0 },
    });
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    const result = await runEmbeddingBackfillFork({
      jobId: "job-onProgress-throw",
      webPageId: VALID_UUID,
      category: "js_animation",
      partsLimit: 100,
      onProgress,
    });
    // onProgress was invoked multiple times and threw each time, but the run
    // still converged to done.
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.processedCount).toBe(10);
  });

  // --------------------------------------------------------------------------
  // T20 (PR7e-β4 PR2b-α TPA-H-1): observability-field mapping — backfill.done
  // with `failedCount` / `memorySkipCount` / `errors` MUST flow into
  // BackfillForkResult.{failedCount, memorySkipCount, errors}.
  // --------------------------------------------------------------------------
  it("T20 (TPA-H-1): backfill.done observability fields are propagated to BackfillForkResult", async () => {
    sharedControls.setScript({
      messages: [buildDoneMessageWithObservability(8, 2, 1, ["err-one", "err-two"])],
      result: { exitedCleanly: true, exitCode: 0 },
    });
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    const result = await runEmbeddingBackfillFork({
      jobId: "job-obs",
      webPageId: VALID_UUID,
      category: "js_animation",
      partsLimit: 100,
    });
    expect(result.processedCount).toBe(8);
    expect(result.failedCount).toBe(2);
    expect(result.memorySkipCount).toBe(1);
    expect(result.errors).toEqual(["err-one", "err-two"]);
  });

  it("T20b (TPA-H-1): done WITHOUT observability fields yields undefined on BackfillForkResult", async () => {
    sharedControls.setScript({
      messages: [buildDoneMessage(3)],
      result: { exitedCleanly: true, exitCode: 0 },
    });
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    const result = await runEmbeddingBackfillFork({
      jobId: "job-obs-absent",
      webPageId: VALID_UUID,
      category: "js_animation",
      partsLimit: 100,
    });
    expect(result.processedCount).toBe(3);
    expect(result.failedCount).toBeUndefined();
    expect(result.memorySkipCount).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // T21 (PR7e-β4 PR2b-α TPA-H-2): init message type discriminator — the
  // orchestrator MUST send `type: "backfill.run"` (schema-required) and MUST
  // NOT use the prior `& { type: string }` hack.
  // --------------------------------------------------------------------------
  it("T21 (TPA-H-2): initMessage includes `type: backfill.run` matching BackfillParentMessage schema", async () => {
    sharedControls.setScript({
      messages: [buildDoneMessage(1)],
      result: { exitedCleanly: true, exitCode: 0 },
    });
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    await runEmbeddingBackfillFork({
      jobId: "job-type-disc",
      webPageId: VALID_UUID,
      category: "js_animation",
      partsLimit: 100,
    });
    // The mocked runChildProcess captures its last options including initMessage.
    const opts = sharedControls.getLastOptions() as {
      initMessage: { type?: string; kind?: string };
    };
    expect(opts.initMessage.type).toBe("backfill.run");
    expect(opts.initMessage.kind).toBe("backfill.run");
  });

  it("T21b (TPA-H-2): orchestrator source no longer uses `& { type: string }` hack in type annotations", () => {
    const src = fs.readFileSync(ORCHESTRATOR_SRC, "utf-8");
    // Strip single-line `// ...` comments so prose describing the old hack
    // (which we deliberately kept for archival context) doesn't trip the
    // regex. We still scan block comments, but the relevant lines are only
    // inside inline JSDoc above the code; those reference `BackfillParentMessageT`
    // naturally but not as a type intersection.
    const srcNoLineComments = src
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("// ");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    expect(srcNoLineComments).not.toMatch(/BackfillParentMessageT\s*&\s*\{\s*type:\s*string\s*\}/);
  });

  // --------------------------------------------------------------------------
  // T17: Sanitize idempotency — parent does NOT re-sanitize child-sanitized
  // error message. The only log-time transformation is truncateId() on UUIDs.
  // --------------------------------------------------------------------------
  it("T17: parent preserves child-sanitized error verbatim (SEC M-2)", async () => {
    const childMessage = "Record not found"; // Already a sanitize-friendly output.
    sharedControls.setScript({
      messages: [{ kind: "backfill.error", message: childMessage }],
      result: { exitedCleanly: false, exitCode: 1 },
    });
    const { runEmbeddingBackfillFork } =
      await import("../../../src/workers/phases/embedding-backfill-fork-orchestrator");
    let caught: unknown;
    try {
      await runEmbeddingBackfillFork({
        jobId: "job-sanitize",
        webPageId: VALID_UUID,
        category: "js_animation",
        partsLimit: 100,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    // The child's sanitized message must flow through unchanged — not mapped
    // into "An internal error occurred" (which would be the sanitize-error's
    // default for non-Error inputs).
    expect((caught as Error).message).toBe(childMessage);
  });
});
