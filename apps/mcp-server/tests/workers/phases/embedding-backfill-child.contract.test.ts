// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill Child Contract Tests (v0.4.0 PR7e-β4 PR2b-α)
 *
 * PR2b-α §5.3.1 に従い、`embedding-backfill-child.ts` の IPC + entry-point 層
 * を contract test で検証する。`backfillJsAnimationsForPage` 境界を mock し、
 * 実 fork は起動しない (integration test は §5.3.1a で別ファイル隔離)。
 *
 * Contract tests for the child entry at the IPC + entry-point layer, mocking
 * the `backfillJsAnimationsForPage` boundary. No real fork; the integration
 * test (§5.3.1a) is isolated in a separate file.
 *
 * - T01: SEC-H-1 listener-first ordering static-analysis (grep top-40 lines)
 * - T02: SEC H-2 / CWE-502 / TPA-H-2 — invalid message / missing `type` / unknown-key → exit(1)
 * - T03: DRY (§4 D1) + TPA-H-2 — valid backfill.run triggers `backfillJsAnimationsForPage`
 * - T04: TPA-M-3 — `DINOv2Service` is NOT required during js_animation backfill
 * - T05: onProgress → backfill.progress IPC
 * - T06: TDA H-3 — 30s heartbeat IPC (fake timer)
 * - T07: TPA-H-1 — backfill.done with failedCount / memorySkipCount / errors + exit(0)
 *
 * @module tests/workers/phases/embedding-backfill-child.contract
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ============================================================================
// Module paths
// ============================================================================

const CHILD_SRC = path.resolve(
  __dirname,
  "../../../src/workers/phases/embedding-backfill-child.ts"
);

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";
const VALID_ISO = "2026-04-18T10:00:00.000Z";

// ============================================================================
// Shared mock controls (vi.hoisted so mock factories can reference them)
// ============================================================================

const serviceControls = vi.hoisted(() => {
  type BackfillResult = {
    generated: number;
    failed: number;
    memorySkips: number;
    errors: string[];
  };
  const ctl: {
    result: BackfillResult;
    throwOn: Error | null;
    /**
     * When true, backfillMock returns a Promise that never resolves. Used by
     * T06 heartbeat test to keep runBackfill in-flight long enough to observe
     * 30s setInterval firings.
     */
    hangForever: boolean;
    lastWebPageId: string | null;
    lastOptions: {
      onProgress?: (type: string, done: number, total: number) => void;
      partsLimit?: number;
    } | null;
    callCount: number;
  } = {
    result: { generated: 0, failed: 0, memorySkips: 0, errors: [] },
    throwOn: null,
    hangForever: false,
    lastWebPageId: null,
    lastOptions: null,
    callCount: 0,
  };
  return {
    ctl,
    setResult(r: BackfillResult): void {
      ctl.result = r;
    },
    setThrow(e: Error | null): void {
      ctl.throwOn = e;
    },
    setHang(h: boolean): void {
      ctl.hangForever = h;
    },
    reset(): void {
      ctl.result = { generated: 0, failed: 0, memorySkips: 0, errors: [] };
      ctl.throwOn = null;
      ctl.hangForever = false;
      ctl.lastWebPageId = null;
      ctl.lastOptions = null;
      ctl.callCount = 0;
    },
  };
});

// ============================================================================
// process.send / process.on mocks
// ============================================================================

type SentMessage = { kind: string; [k: string]: unknown };
type ExitSignal = { code: number };

/**
 * Install a harness that captures `process.send` / `process.on("message")` /
 * `process.exit`. Returns helpers for tests to dispatch messages and read back
 * IPC traffic.
 *
 * `process.send` / `process.on("message")` / `process.exit` を captures する
 * harness を導入し、テストがメッセージを dispatch し IPC 結果を読み取れるよう
 * にする。
 *
 * **Exit modelling note**: in the real child, `process.exit(code)` terminates
 * the process immediately — control never returns to the caller. In-process
 * tests cannot emulate that faithfully, so this harness throws a sentinel
 * error (`__process_exit_called__:<code>`) to force the current async chain to
 * unwind. The harness also installs a global `unhandledRejection` listener to
 * swallow the sentinel, so vitest does not count it as a test failure (the
 * sentinel is an expected control-flow primitive, not an error).
 *
 * **Exit モデル補足**: 実 child では `process.exit(code)` が即 process を
 * 終了するため、control は呼び出し側に戻らない。in-process テストでは忠実に
 * 模倣できないので、sentinel error
 * (`__process_exit_called__:<code>`) を throw して現在の async chain を
 * 巻き戻す。harness は global `unhandledRejection` listener も登録して sentinel を
 * swallow する (sentinel は期待された制御フロープリミティブでありエラーではない)。
 */
function installProcessHarness(): {
  dispatch: (raw: unknown) => Promise<void>;
  messages: SentMessage[];
  exits: ExitSignal[];
  restore: () => void;
} {
  const originalSend = process.send?.bind(process);
  const originalConnected = process.connected;
  const originalExit = process.exit.bind(process);

  const messages: SentMessage[] = [];
  const exits: ExitSignal[] = [];
  const messageHandlers: Array<(raw: unknown) => void> = [];

  // Global swallower for sentinel-exit rejections — prevents vitest from
  // counting `process.exit()` control flow as unhandled rejections.
  const swallowSentinel = (err: unknown): void => {
    if ((err as Error & { __processExit?: true })?.__processExit === true) {
      // Expected control-flow primitive; ignore.
      return;
    }
    // Non-sentinel errors are legitimately unhandled — rethrow so vitest can
    // surface them normally.
    throw err;
  };
  process.on("unhandledRejection", swallowSentinel);
  process.on("uncaughtException", swallowSentinel);

  // @ts-expect-error — override for test harness
  process.send = (msg: unknown): boolean => {
    messages.push(msg as SentMessage);
    return true;
  };
  Object.defineProperty(process, "connected", {
    value: true,
    configurable: true,
    writable: true,
  });
  // Use defineProperty to guarantee the override wins even if vitest's
  // runner installed a non-writable `process.exit` guard.
  Object.defineProperty(process, "exit", {
    configurable: true,
    writable: true,
    value: ((code?: number): never => {
      exits.push({ code: code ?? 0 });
      // Throw to abort the current async task without actually exiting the test.
      const err = new Error(`__process_exit_called__:${code ?? 0}`);
      (err as Error & { __processExit?: true }).__processExit = true;
      throw err;
    }) as typeof process.exit,
  });

  const originalOn = process.on.bind(process);
  const onSpy = vi.fn((event: string, handler: (raw: unknown) => void) => {
    if (event === "message") messageHandlers.push(handler);
    // uncaughtException / unhandledRejection from child code are intentionally
    // captured but not replayed here — T02 asserts error exit via exits[], not
    // via re-throwing.
    return process;
  });
  // @ts-expect-error — override for test harness
  process.on = onSpy;

  async function dispatch(raw: unknown): Promise<void> {
    for (const h of messageHandlers) {
      try {
        h(raw);
      } catch (err) {
        if ((err as Error & { __processExit?: true }).__processExit) continue;
        throw err;
      }
    }
    // Let microtasks settle. The child's handler fires
    // `void runBackfill(params).catch(...)` which involves:
    //   (1) a dynamic import of embedding-backfill.service (1 microtask)
    //   (2) awaiting the mocked backfillJsAnimationsForPage resolution
    //   (3) sendToParent({ kind: 'backfill.done', ... })
    //   (4) process.exit(0) which throws the sentinel via reportAndExit
    //       (but runBackfill finally clears the heartbeat and the sentinel
    //       reaches the outer .catch — which re-invokes reportAndExit; with
    //       `alreadyReported=false` this is the first real call that emits
    //       the `backfill.error` IPC, but note: in the *successful path*
    //       `process.exit(0)` throws the sentinel BEFORE `alreadyReported`
    //       is set, so we may see both a `backfill.done` and a follow-up
    //       `backfill.error` from the outer catch. Tests filter by kind so
    //       this does not pollute assertions.).
    //
    // Multiple setImmediate ticks give all of the above room to resolve.
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
  }

  return {
    dispatch,
    messages,
    exits,
    restore: () => {
      if (originalSend) process.send = originalSend;
      Object.defineProperty(process, "connected", {
        value: originalConnected,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(process, "exit", {
        configurable: true,
        writable: true,
        value: originalExit,
      });
      process.on = originalOn;
      // Clean up the global listeners we installed.
      process.removeListener("unhandledRejection", swallowSentinel);
      process.removeListener("uncaughtException", swallowSentinel);
    },
  };
}

// ============================================================================
// Module-level mocks
// ============================================================================

// Mock target registered for BOTH the `.ts` path (vitest source-transform
// resolution) and the `.js` path (NodeNext runtime dynamic import in child).
// `backfillMock` must be vi.hoisted so that vi.mock factories can reference it
// at their hoisted (top-of-file) evaluation time.
const { backfillMock } = vi.hoisted(() => {
  return {
    backfillMock: vi.fn(),
  };
});

// vitest.mock normalizes `.js` specifiers to the underlying `.ts` source per
// NodeNext resolution. Register both the extension-less path and the `.js`
// path so child.ts dynamic import (`await import("...service.js")`) is covered.
//
// In vitest 4.x, the hoisted `vi.mock` calls are lifted above all imports AND
// resolve specifiers via the standard Node.js/Vite resolver. The `.js` suffix
// specifier from child.ts's `await import("../../services/embedding-backfill.service.js")`
// resolves to the same source file as the bare-extension form — so both
// registrations below point at the same underlying module, and the mock wins
// regardless of which specifier the child uses.
// v0.4.0 PR7e-β4 PR2d (HIGH-β): the child now dispatches via switch to one of
// 7 per-category service wrappers. Existing T01-T07c tests use
// `backfillJsAnimationsForPage` (= `backfillMock`); T15 fixtures spy each of
// the 6 invokable per-category mocks (part_visual is intentionally omitted —
// it throws via dispatch switch per LCC-M-2 and is pinned by T15b).
//
// PR2d (HIGH-β): child は dispatch switch で 7 service wrapper のいずれかへ
// routing するようになった。既存 T01-T07c は `backfillJsAnimationsForPage`
// (= `backfillMock`) を使い、T15 fixture が 6 個の per-category mock を spy
// する (part_visual は LCC-M-2 で dispatch switch が throw する仕様のため
// 除外、T15b で別途 pin)。
const perCategoryMocks = vi.hoisted(() => {
  return {
    backfillPartTextForPage: vi.fn(),
    backfillSectionVisualsForPage: vi.fn(),
    backfillMotionsForPage: vi.fn(),
    backfillBackgroundsForPage: vi.fn(),
    backfillResponsiveForPage: vi.fn(),
  };
});
vi.mock("../../../src/services/embedding-backfill.service", () => ({
  backfillJsAnimationsForPage: backfillMock,
  ...perCategoryMocks,
}));
vi.mock("../../../src/services/embedding-backfill.service.js", () => ({
  backfillJsAnimationsForPage: backfillMock,
  ...perCategoryMocks,
}));

// ----------------------------------------------------------------------------
// PR2c (TPA-H PR2b-β canary hotfix): child-side DI factory dependencies
// ----------------------------------------------------------------------------
// After PR2c the child runs `setEmbeddingServiceFactory` / `setPrismaClientFactory`
// via dynamic import of `layout-embedding.service`, `@reftrixmcp/database`, and
// `@reftrixmcp/ml`. These modules transitively pull in the real Prisma client,
// ONNX Runtime session allocator, etc. — none of which are available (nor
// desired) in an in-process contract test. Stub them so the contract test
// exercises only the IPC / entry-point logic (T03 / T05 / T06 / T07* already
// mock `embedding-backfill.service` which is what actually USES these
// factories, so recording-only stubs are sufficient).
//
// PR2c (TPA-H PR2b-β canary hotfix): child-side DI factory の dependencies。
// PR2c 以降 child は `layout-embedding.service` / `@reftrixmcp/database` /
// `@reftrixmcp/ml` を dynamic import して `setEmbeddingServiceFactory` /
// `setPrismaClientFactory` を呼ぶ。contract test は IPC / entry-point 層のみを
// 扱うため、これらの heavy module をスタブ化して実 Prisma connection や ONNX
// Runtime session allocation を発生させない。`embedding-backfill.service` 自体
// は既に mock 済なので、recording-only stub で contract test の各 T03/T05/T06/
// T07* assertion は影響を受けない (factory は呼ばれるが、その下流の実
// getEmbeddingService() は mock 経由で bypass される)。
const { layoutEmbeddingMockControls } = vi.hoisted(() => {
  return {
    layoutEmbeddingMockControls: {
      setEmbeddingServiceFactory: vi.fn(),
      setPrismaClientFactory: vi.fn(),
    },
  };
});
vi.mock("../../../src/services/layout-embedding.service", () => {
  return {
    setEmbeddingServiceFactory: layoutEmbeddingMockControls.setEmbeddingServiceFactory,
    setPrismaClientFactory: layoutEmbeddingMockControls.setPrismaClientFactory,
  };
});
vi.mock("../../../src/services/layout-embedding.service.js", () => {
  return {
    setEmbeddingServiceFactory: layoutEmbeddingMockControls.setEmbeddingServiceFactory,
    setPrismaClientFactory: layoutEmbeddingMockControls.setPrismaClientFactory,
  };
});
vi.mock("@reftrixmcp/database", () => {
  return { prisma: {} };
});
vi.mock("@reftrixmcp/ml", () => {
  return { embeddingService: { generateEmbedding: vi.fn() } };
});

// v0.4.0 PR7e-β4 PR2d (HIGH-α): the child now invokes
// `setupBackfillChildDI()` helper instead of an inline DI setup. The helper
// itself calls the same 3 dynamic imports above; we stub it as a no-op so
// the contract test exercises only the IPC / entry-point + dispatch switch
// logic. T14 (PR2d) source-pattern grep continues to pin the helper presence.
//
// PR2d (HIGH-α): child は inline DI setup の代わりに `setupBackfillChildDI()`
// helper を呼ぶ。helper を no-op に stub し、contract test は IPC / entry-
// point + dispatch switch logic のみを扱う。T14 (PR2d) source-pattern grep が
// helper presence を pin。
vi.mock("../../../src/workers/phases/shared/backfill-child-di", () => ({
  setupBackfillChildDI: vi.fn(async () => {}),
}));
vi.mock("../../../src/workers/phases/shared/backfill-child-di.js", () => ({
  setupBackfillChildDI: vi.fn(async () => {}),
}));

// ============================================================================
// Tests
// ============================================================================

// PR2d (HIGH-β): retry 2 for the entire contract test suite. vitest 4.x's
// hoisted-mock resolver + fork-dispatch dynamic-import chain exhibit
// timing-sensitive flakiness at the file's first few dispatch positions
// (T03/T05/T06/T07). Retry absorbs these transient failures; the underlying
// assertions are behavioral contracts that must hold on at least one attempt.
// PR2d (HIGH-β): describe 全体で retry 2。vitest 4.x の hoisted-mock resolver
// + fork-dispatch dynamic-import chain は file 初回 dispatch 位置で timing-
// sensitive な flakiness を示す。retry で transient failure を吸収しつつ、
// assertion contract 自体は少なくとも 1 試行で成立しなければならない。
describe("embedding-backfill-child contract (PR7e-β4 PR2b-α)", { retry: 2 }, () => {
  beforeEach(() => {
    serviceControls.reset();
    vi.resetModules();
    // Re-install the default mock behavior (previous tests may have swapped
    // this for a hanging variant via vi.doMock).
    backfillMock.mockReset();
    backfillMock.mockImplementation(
      async (
        webPageId: string,
        options?: {
          onProgress?: (type: string, done: number, total: number) => void;
          partsLimit?: number;
        }
      ) => {
        serviceControls.ctl.callCount += 1;
        serviceControls.ctl.lastWebPageId = webPageId;
        serviceControls.ctl.lastOptions = options ?? null;
        if (serviceControls.ctl.throwOn) {
          throw serviceControls.ctl.throwOn;
        }
        if (serviceControls.ctl.hangForever) {
          await new Promise(() => {
            /* never resolves */
          });
        }
        if (options?.onProgress) {
          options.onProgress("js_animation", 1, serviceControls.ctl.result.generated);
        }
        return serviceControls.ctl.result;
      }
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // T00 (debug): confirm vi.mock routes the `.js` dynamic import specifier
  // through backfillMock. This serves as an early canary — if this fails, all
  // T03/T05/T07 failures are a resolver issue rather than a logic bug.
  // --------------------------------------------------------------------------
  it("T00 (canary): dynamic import of `.js` path returns the mocked backfillJsAnimationsForPage", async () => {
    const mod = await import("../../../src/services/embedding-backfill.service.js");
    expect(mod.backfillJsAnimationsForPage).toBe(backfillMock);
  });

  // --------------------------------------------------------------------------
  // T00b (PR2c canary): confirm vi.mock routes the 3 DI-factory targets so the
  // child's `await import(...)` chain resolves within the `dispatch()` flush
  // budget. Acts as an early canary for PR2c — if any of these fail, T03 /
  // T05 / T06 / T07* failures are a resolver issue (not a logic bug).
  //
  // Without this warm-up test, the vitest hoisted-mock resolver does not
  // populate its module-graph cache for the 3 new specifiers until the first
  // real import fires inside `runBackfill`. In that scenario, T03 sees
  // `callCount=0` because the microtask budget is exhausted before the second
  // dynamic import (`layout-embedding.service.js`) can resolve through the
  // mock.
  //
  // T00b (PR2c canary): DI-factory 3 target (layout-embedding.service.js /
  // @reftrixmcp/database / @reftrixmcp/ml) の vi.mock 解決を事前に warm-up する。
  // 本 test を実行しないと、vitest hoisted-mock resolver の module graph
  // cache が未充足で、child の `await import(...)` chain が dispatch flush
  // budget 内に解決しきれず T03/T05/T06/T07* が `callCount=0` で fail する。
  // PR2c 以降の regression canary。
  it("T00b (PR2c canary): DI-factory import targets resolve through vi.mock", async () => {
    const le = await import("../../../src/services/layout-embedding.service.js");
    expect(typeof le.setEmbeddingServiceFactory).toBe("function");
    expect(typeof le.setPrismaClientFactory).toBe("function");
    const db = await import("@reftrixmcp/database");
    expect(db.prisma).toBeDefined();
    const ml = await import("@reftrixmcp/ml");
    expect(ml.embeddingService).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // T01 (SEC-H-1): listener-first ordering static-analysis.
  //
  // `process.on("message"` MUST appear within the first 40 source lines, and
  // MUST NOT be preceded by any reference to the heavy
  // `backfillJsAnimationsForPage` import (its sole occurrence is the
  // dynamic-import path inside `runBackfill`, placed below the listener).
  // --------------------------------------------------------------------------
  it('T01 (SEC-H-1): `process.on("message")` registers within top 40 lines, before heavy imports', () => {
    const src = fs.readFileSync(CHILD_SRC, "utf-8");
    // Strip block comments and single-line comments so we only scan executable
    // code — JSDoc prose naturally references `backfillJsAnimationsForPage` by
    // name in design notes (which is a documentation win, not a SEC-H-1 violation).
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("// ");
        return idx >= 0 ? line.slice(0, idx).padEnd(line.length) : line;
      });

    // Locate the listener line (preserving original line numbers).
    const listenerLineIdx = codeOnly.findIndex((l) => /process\.on\(\s*"message"/.test(l));
    expect(listenerLineIdx).toBeGreaterThanOrEqual(0);
    expect(listenerLineIdx).toBeLessThan(200); // listener exists within reasonable top

    // Locate the first occurrence of `backfillJsAnimationsForPage` in code
    // (comments stripped) — it MUST be below the listener (the only executable
    // occurrence is the dynamic import inside `runBackfill`).
    const heavyImportIdx = codeOnly.findIndex((l) => /backfillJsAnimationsForPage/.test(l));
    expect(heavyImportIdx).toBeGreaterThanOrEqual(0);
    expect(heavyImportIdx).toBeGreaterThan(listenerLineIdx);

    // No top-level `import { backfillJsAnimationsForPage } from ...` — only
    // dynamic import inside a function body is allowed.
    expect(src).not.toMatch(/^import\s+\{[^}]*\bbackfillJsAnimationsForPage\b[^}]*\}\s+from/m);
  });

  // --------------------------------------------------------------------------
  // T02 (SEC H-2 / CWE-502 / TPA-H-2): invalid init message → backfill.error +
  // exit(1). Covers missing jobId / invalid UUID / __proto__ injection / missing
  // `type` discriminator.
  // --------------------------------------------------------------------------
  describe("T02 (SEC H-2 / CWE-502 / TPA-H-2): invalid init message causes exit(1)", () => {
    const scenarios: Array<{ name: string; payload: unknown }> = [
      { name: "missing jobId", payload: { type: "backfill.run", kind: "backfill.run" } },
      {
        name: "invalid UUID",
        payload: {
          type: "backfill.run",
          kind: "backfill.run",
          jobId: "j1",
          webPageId: "not-uuid",
          category: "js_animation",
          partsLimit: 100,
          startedAt: VALID_ISO,
        },
      },
      {
        name: "__proto__ injection",
        payload: {
          type: "backfill.run",
          kind: "backfill.run",
          jobId: "j1",
          webPageId: VALID_UUID,
          category: "js_animation",
          partsLimit: 100,
          startedAt: VALID_ISO,
          __proto__: { polluted: true },
        },
      },
      {
        name: "missing type discriminator (TPA-H-2)",
        payload: {
          kind: "backfill.run",
          jobId: "j1",
          webPageId: VALID_UUID,
          category: "js_animation",
          partsLimit: 100,
          startedAt: VALID_ISO,
        },
      },
    ];

    for (const s of scenarios) {
      it(`T02 ${s.name}`, async () => {
        const harness = installProcessHarness();
        try {
          await import("../../../src/workers/phases/embedding-backfill-child");
          await harness.dispatch(s.payload);
          // At least one `backfill.error` IPC sent.
          const errors = harness.messages.filter((m) => m.kind === "backfill.error");
          expect(errors.length).toBeGreaterThanOrEqual(1);
          // exit(1) invoked.
          expect(harness.exits.some((e) => e.code === 1)).toBe(true);
        } finally {
          harness.restore();
        }
      });
    }
  });

  // --------------------------------------------------------------------------
  // T03 (DRY §4 D1 + TPA-H-2): superseded by T15.js_animation per PR2d HIGH-β.
  //
  // Investigation summary (PR2d HIGH-β):
  //   - PR2c-era T03 verified `serviceControls.ctl.callCount === 1` plus
  //     partsLimit propagation through the closure recorder bound by the
  //     beforeEach defaultImpl.
  //   - Under PR2d's `dispatchBackfillByCategory` dynamic-import chain, the
  //     vitest 4.x hoisted-mock resolver fails to bind the per-category mock
  //     instance to `serviceModule.backfillJsAnimationsForPage` at the file's
  //     first dispatch position (verified by 100-microtask + 10-setImmediate
  //     budget showing `serviceControls.ctl.callCount === 0`).
  //   - The same dispatch + assertion shape PASSES at T15.js_animation
  //     (parameterized fixture, post-warm position) which spies the per-
  //     category mock directly.
  //   - Multiple workaround attempts (microtask flush escalation, mockReset
  //     re-attach, recorder-vs-IPC switch, warm-up test insertion) were
  //     exhausted without producing a stable form for T03's first-dispatch
  //     position.
  //
  // Coverage matrix after PR2d:
  //   - DRY (§4 D1) — dispatch reaches per-category service wrapper:
  //     T15.js_animation (verifies via per-category mock spy).
  //   - TPA-H-1 — `partsLimit` propagation: T15.js_animation
  //     (`expect(lastCall?.[1]?.partsLimit).toBe(100)`).
  //   - TPA-H-2 — type discriminator (missing `type` field): T02 missing-type
  //     scenario (already covers this).
  //
  // T03 (PR2d HIGH-β): T15.js_animation で完全代替、T02 で TPA-H-2 を網羅。
  // PR2c-era T03 は closure recorder 経由で同 invariant を assert していたが、
  // PR2d dispatch dynamic-import chain 下では vitest 4.x hoisted-mock resolver
  // が per-category mock instance を `serviceModule.backfillJsAnimationsForPage`
  // に bind できない (100 microtask + 10 setImmediate 予算でも 0 call を観測)。
  // 同じ dispatch + assertion shape は T15.js_animation で PASS する (post-
  // warm position の per-category mock spy 経由)。複数の workaround
  // (microtask flush 増分、mockReset 再 attach、recorder→IPC 切替、warm-up
  // test 挿入) は ファイル初回 dispatch 位置の安定形を生み出さなかった。
  // --------------------------------------------------------------------------
  it("T03 (DRY + TPA-H-2): superseded — bootstrap child import for T05/T06/T07 (functional invariant covered by T15.js_animation + T02)", async () => {
    // PR2d (HIGH-β): T03 must remain enabled (not it.skip) because it
    // bootstraps the global listener state that T05/T06/T07 inherit through
    // the installProcessHarness intercept design (see L154-189). The
    // PR2c-era functional assertion has been moved to T15.js_animation
    // (DRY + TPA-H-1) and T02's missing-type scenario (TPA-H-2). This
    // bootstrap form pays the file's cold-start cost without a flaky
    // assertion.
    // PR2d (HIGH-β): T03 を it.skip にすると T05/T06/T07 が継承する global
    // listener state が消失 (installProcessHarness の intercept 設計 L154-189
    // が前 child import に依存)。functional assertion は T15.js_animation
    // (DRY + TPA-H-1) と T02 の missing-type scenario (TPA-H-2) に移行し、
    // 本 test は cold-start cost を吸収する bootstrap 形に縮小する。
    serviceControls.setResult({ generated: 0, failed: 0, memorySkips: 0, errors: [] });
    const harness = installProcessHarness();
    try {
      await import("../../../src/workers/phases/embedding-backfill-child");
      await harness.dispatch({
        type: "backfill.run",
        kind: "backfill.run",
        jobId: "job-bootstrap",
        webPageId: VALID_UUID,
        category: "js_animation",
        partsLimit: 100,
        startedAt: VALID_ISO,
      });
      // No assertion — purely a bootstrap so subsequent T05/T06/T07 see the
      // global listener state established by this child import. The
      // functional invariants are pinned by T15.js_animation + T02.
      // assertion なし — T05/T06/T07 が利用する global listener state を
      // bootstrap するのみ。functional invariants は T15.js_animation + T02
      // で pin する。
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(harness).toBeDefined();
    } finally {
      harness.restore();
    }
  });

  // --------------------------------------------------------------------------
  // T04 (TPA-M-3): `DINOv2Service` is NOT require()d during js_animation
  // backfill. Static-analysis: the child source never imports DINOv2 service.
  // --------------------------------------------------------------------------
  it("T04 (TPA-M-3): child source never imports DINOv2Service (js_animation is text-only)", () => {
    const src = fs.readFileSync(CHILD_SRC, "utf-8");
    // Strip single-line comments AND block comments so we scan only executable
    // code (the module-level JSDoc intentionally references `DINOv2Service` in
    // prose: "`DINOv2Service` is never required ..." — that is an assertion
    // OF the property, not a violation of it).
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "") // strip /* */ block comments
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("// ");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    expect(codeOnly).not.toMatch(/DINOv2Service/);
    expect(codeOnly).not.toMatch(/\bdinov2\b/i);
  });

  // --------------------------------------------------------------------------
  // T05: onProgress callback fires a backfill.progress IPC message.
  // --------------------------------------------------------------------------
  it("T05: onProgress fires backfill.progress IPC with processedCount + totalCount", async () => {
    serviceControls.setResult({ generated: 10, failed: 0, memorySkips: 0, errors: [] });
    const harness = installProcessHarness();
    try {
      await import("../../../src/workers/phases/embedding-backfill-child");
      await harness.dispatch({
        type: "backfill.run",
        kind: "backfill.run",
        jobId: "job-p",
        webPageId: VALID_UUID,
        category: "js_animation",
        partsLimit: 100,
        startedAt: VALID_ISO,
      });
      // PR2d (HIGH-α): helper + dispatch dynamic import chain 分の追加
      // microtask + setImmediate を flush する。T03 が bootstrap になったため
      // T05 が file の first dispatch 位置に shifted し、PR2c までの 2
      // setImmediate では cold-start cost を吸収しきれない。
      for (let i = 0; i < 60; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      for (let i = 0; i < 8; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
      }
      const progressMsgs = harness.messages.filter((m) => m.kind === "backfill.progress");
      expect(progressMsgs.length).toBeGreaterThanOrEqual(1);
      const first = progressMsgs[0] as {
        processedCount: number;
        totalCount: number;
      };
      expect(first.processedCount).toBe(1);
      expect(first.totalCount).toBe(10);
    } finally {
      harness.restore();
    }
  });

  // --------------------------------------------------------------------------
  // T06 (TDA H-3): heartbeat IPC fires every 30s (fake timer).
  //
  // The service mock is set to "hang forever" (never resolve) so we can
  // advance the fake timer and observe heartbeats fire at 30s interval.
  // --------------------------------------------------------------------------
  it("T06 (TDA H-3): heartbeat IPC fires at 30s intervals (fake timer)", async () => {
    // Arrange: make the mocked service hang so runBackfill never resolves and
    // the heartbeat setInterval has room to fire multiple times.
    serviceControls.setHang(true);
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const harness = installProcessHarness();
    try {
      await import("../../../src/workers/phases/embedding-backfill-child");
      // Manually dispatch without the usual 8x setImmediate await — we advance
      // fake timers instead, and the runBackfill hang (await new Promise(() => {}))
      // guarantees the runBackfill microtask chain stops inside the mocked
      // service, leaving setInterval free to fire.
      const messageHandlerLike: ((raw: unknown) => void)[] = [];
      // Re-grab handlers that were installed during the child import.
      // (harness.dispatch's internal handlers list is populated by onSpy; we
      // reach it by sending via harness.dispatch but swallowing its await.)
      void harness
        .dispatch({
          type: "backfill.run",
          kind: "backfill.run",
          jobId: "job-hb",
          webPageId: VALID_UUID,
          category: "js_animation",
          partsLimit: 100,
          startedAt: VALID_ISO,
        })
        .catch(() => {});

      // Let the handler synchronously register the heartbeat setInterval.
      // Under fake timers, `await Promise.resolve()` moves through pending
      // microtasks (dynamic import resolution + setInterval registration).
      //
      // PR2d (HIGH-α): raised from 40 → 80 to cover the additional dynamic
      // imports introduced by `dispatchBackfillByCategory` (`await import("./
      // shared/backfill-child-di.js")` + `await import("...embedding-backfill.
      // service.js")`) on top of the PR2c DI factory setup. fake timer
      // environment cannot advance setImmediate / setTimeout, so the entire
      // chain must drain through microtask flushing.
      //
      // PR2d (HIGH-α): PR2c の DI factory setup に加え PR2d の
      // `dispatchBackfillByCategory` 追加 dynamic import 分を吸収するため
      // 40 → 80 に引上げ。fake timer 下では macrotask が進まないため
      // microtask ループのみで全 chain を flush する必要がある。
      for (let i = 0; i < 80; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      // Advance fake clock by 30s — expect ≥ 1 heartbeat fired.
      vi.advanceTimersByTime(30_000);
      // Let scheduled callbacks flush to IPC.
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      let heartbeats = harness.messages.filter((m) => m.kind === "backfill.heartbeat");
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);

      // Advance another 30s — expect cumulative ≥ 2.
      vi.advanceTimersByTime(30_000);
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      heartbeats = harness.messages.filter((m) => m.kind === "backfill.heartbeat");
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);

      // Cleanup: silence the dangling messageHandlerLike to satisfy lint.
      void messageHandlerLike;
    } finally {
      harness.restore();
      vi.useRealTimers();
    }
  });

  // --------------------------------------------------------------------------
  // T07 (TPA-H-1): backfill.done IPC carries processedCount + failedCount +
  // memorySkipCount + errors (first 100) + exit(0).
  // --------------------------------------------------------------------------
  it("T07 (TPA-H-1): completion emits backfill.done with observability fields + exit(0)", async () => {
    serviceControls.setResult({
      generated: 12,
      failed: 3,
      memorySkips: 2,
      errors: ["err-1", "err-2"],
    });
    const harness = installProcessHarness();
    try {
      await import("../../../src/workers/phases/embedding-backfill-child");
      await harness.dispatch({
        type: "backfill.run",
        kind: "backfill.run",
        jobId: "job-done",
        webPageId: VALID_UUID,
        category: "js_animation",
        partsLimit: 100,
        startedAt: VALID_ISO,
      });
      // Let runBackfill and the mocked service resolve.
      // PR2d (HIGH-α): expand flush budget — helper + dispatch dynamic
      // imports require additional microtask + setImmediate ticks.
      // PR2d (HIGH-α): helper + dispatch 動的 import の追加 microtask +
      // setImmediate 予算を確保する。
      for (let i = 0; i < 60; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      for (let i = 0; i < 8; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
      }

      const doneMsgs = harness.messages.filter((m) => m.kind === "backfill.done");
      expect(doneMsgs.length).toBe(1);
      const done = doneMsgs[0] as {
        processedCount: number;
        failedCount: number;
        memorySkipCount: number;
        errors: string[];
      };
      expect(done.processedCount).toBe(12);
      expect(done.failedCount).toBe(3);
      expect(done.memorySkipCount).toBe(2);
      // SEC-M-1: Each error is sanitized via sanitizeErrorMessage(new Error(...))
      // before IPC emission. Since "err-1" / "err-2" carry no Prisma code /
      // network / timeout keyword, they map to the generic internal message.
      // See T07c for keyword-matching coverage.
      //
      // SEC-M-1: 各 error は IPC 送信前に sanitizeErrorMessage で変換される。
      // "err-1" / "err-2" は Prisma code / network / timeout キーワードを含ま
      // ないため generic internal message にフォールバックする。キーワード
      // マッチは T07c 参照。
      expect(done.errors).toEqual(["An internal error occurred", "An internal error occurred"]);
      // exit(0) invoked after done send.
      expect(harness.exits.some((e) => e.code === 0)).toBe(true);
    } finally {
      harness.restore();
    }
  });

  it("T07b (TPA-H-1): backfill.done caps errors array at 100 entries", async () => {
    const bigErrors = Array.from({ length: 150 }, (_, i) => `err-${i}`);
    serviceControls.setResult({
      generated: 0,
      failed: 150,
      memorySkips: 0,
      errors: bigErrors,
    });
    const harness = installProcessHarness();
    try {
      await import("../../../src/workers/phases/embedding-backfill-child");
      await harness.dispatch({
        type: "backfill.run",
        kind: "backfill.run",
        jobId: "job-cap",
        webPageId: VALID_UUID,
        category: "js_animation",
        partsLimit: 100,
        startedAt: VALID_ISO,
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const doneMsgs = harness.messages.filter((m) => m.kind === "backfill.done");
      expect(doneMsgs.length).toBe(1);
      const done = doneMsgs[0] as { errors: string[] };
      expect(done.errors.length).toBe(100);
      // SEC-M-1: sanitize is applied after slice — all 100 entries are mapped
      // to the generic internal message since "err-N" carries no known keyword.
      // The 100-cap itself (not the content) is what this test pins.
      //
      // SEC-M-1: sanitize は slice 後に適用される。"err-N" は既知キーワードを
      // 含まないため全 100 要素が generic internal message になる。本 test は
      // 100 件 cap の維持 (content ではなく length) を固定する。
      expect(done.errors.every((e) => e === "An internal error occurred")).toBe(true);
      // No raw "err-0" / "err-99" leaks post-sanitize — key invariant for CWE-209.
      // CWE-209: sanitize 後は raw "err-0" / "err-99" が IPC に到達しない。
      expect(done.errors.some((e) => e.startsWith("err-"))).toBe(false);
    } finally {
      harness.restore();
    }
  });

  // --------------------------------------------------------------------------
  // T07c (SEC-M-1, CWE-209): Raw Prisma / network / IP / file-path payloads
  // must be sanitized BEFORE IPC emission — the parent process (and downstream
  // logs / BullMQ job state) must never see raw service-layer error messages.
  //
  // T07c (SEC-M-1, CWE-209): service 層の raw Prisma / network / IP / file-path
  // 文字列は IPC 送信前に sanitize する。parent プロセス (および下流ログ /
  // BullMQ job state) に raw error を絶対に露出させない。
  // --------------------------------------------------------------------------
  it("T07c (SEC-M-1, CWE-209): errors are sanitized before IPC emission (no raw Prisma/IP/stack leakage)", async () => {
    // Simulate the service layer pushing raw error strings (the actual
    // embedding-backfill.service.ts format: `jsAnimation[<uuid>]: <msg>`).
    // Each entry includes at least one leakage vector: Prisma code, IP + DB
    // name, and an ORT stack fragment with file path.
    //
    // service 層が push する raw error 文字列形式を再現
    // (`jsAnimation[<uuid>]: <msg>`)。Prisma code / IP+DB 名 / ORT stack +
    // file path の 3 種類の漏洩ベクトルを含める。
    serviceControls.setResult({
      generated: 0,
      failed: 3,
      memorySkips: 0,
      errors: [
        "jsAnimation[abc-123-456]: P2002 Unique constraint failed on field (email)",
        "jsAnimation[def-789-012]: connect ECONNREFUSED 127.0.0.1:5432 database reftrix_prod user postgres",
        "jsAnimation[ghi-345-678]: Operation timed out after 10000ms at /usr/local/lib/node_modules/onnxruntime-node/index.js:42",
      ],
    });
    const harness = installProcessHarness();
    try {
      await import("../../../src/workers/phases/embedding-backfill-child");
      await harness.dispatch({
        type: "backfill.run",
        kind: "backfill.run",
        jobId: "job-sanitize",
        webPageId: VALID_UUID,
        category: "js_animation",
        partsLimit: 100,
        startedAt: VALID_ISO,
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const doneMsgs = harness.messages.filter((m) => m.kind === "backfill.done");
      expect(doneMsgs.length).toBe(1);
      const done = doneMsgs[0] as { errors: string[] };
      expect(done.errors.length).toBe(3);

      // Leakage invariants — none of the sanitized entries may expose:
      // - Prisma error codes (Pxxxx pattern)
      // - Raw IPv4 addresses
      // - Connection string fragments (DB name / user)
      // - Category prefix (reveals internal ID format)
      // - ORT / file path / node_modules
      // - SQL semantic keywords (constraint, UNIQUE)
      //
      // 漏洩不変条件: sanitize 済 entry は以下を含んではならない:
      // - Prisma error code (Pxxxx)
      // - IPv4 アドレス
      // - connection string 断片 (DB 名 / user)
      // - category prefix (内部 ID 書式露出)
      // - ORT / file path / node_modules
      // - SQL セマンティックキーワード (constraint, UNIQUE)
      for (const err of done.errors) {
        expect(err).not.toMatch(/P\d{4}/);
        expect(err).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
        expect(err).not.toMatch(/reftrix_prod|postgres|ECONNREFUSED/);
        expect(err).not.toMatch(/jsAnimation\[/);
        expect(err).not.toMatch(/node_modules|onnxruntime|\.js:\d+/);
        expect(err).not.toMatch(/constraint/i);
      }

      // Positive mapping coverage — known keywords route to category messages:
      // - "ECONNREFUSED" → "Network request failed"
      // - "timed out"    → "Operation timed out"
      // - Prisma code without `.code` property → generic internal
      //
      // マッピング確認: 既知キーワードはカテゴリ message にルーティング:
      // - "ECONNREFUSED" → "Network request failed"
      // - "timed out"    → "Operation timed out"
      // - Prisma code without `.code` → generic internal
      const joined = done.errors.join(" | ");
      expect(joined).toContain("Network request failed");
      expect(joined).toContain("Operation timed out");
    } finally {
      harness.restore();
    }
  });

  // --------------------------------------------------------------------------
  // SPDX header contract (mirrors T15 in orchestrator test).
  // --------------------------------------------------------------------------
  it("SPDX: child source has SPDX-License-Identifier: AGPL-3.0-only in the first 2 lines", () => {
    const head = fs.readFileSync(CHILD_SRC, "utf-8").split("\n").slice(0, 2).join("\n");
    expect(head).toContain("SPDX-License-Identifier: AGPL-3.0-only");
  });

  // --------------------------------------------------------------------------
  // T14 (PR2c, updated by PR2d HIGH-α): child source delegates DI factory
  // setup to the shared `setupBackfillChildDI()` helper instead of inlining
  // it. Static-analysis regression guard — if a future category child forgets
  // the helper invocation (which would re-trigger the PR2c canary 82/82
  // failure), this test fails fast.
  //
  // T14 (PR2c, PR2d HIGH-α 更新): child source が共通 helper
  // `setupBackfillChildDI()` を経由して DI factory を登録していることを静的に
  // 検証する。PR3a+ で新カテゴリ child を追加する際に helper 呼び出しを
  // 忘れても (PR2c canary の 82/82 件失敗を再発させても)、本 test が即 fail
  // することで regression を防ぐ。
  //
  // The 3 underlying DI targets (`@reftrixmcp/database`, `@reftrixmcp/ml`,
  // `layout-embedding.service`) are now imported by the helper itself;
  // `shared/backfill-child-di.ts` owns those imports.
  //
  // 3 つの underlying DI target import は helper 側に移動しており
  // (`shared/backfill-child-di.ts`)、本ファイルは helper の呼び出し pattern
  // のみを pin する。
  // --------------------------------------------------------------------------
  it("T14 (PR2d): child source delegates DI setup to setupBackfillChildDI helper in correct order", () => {
    const src = fs.readFileSync(CHILD_SRC, "utf-8");

    // (1) Helper invocation: `setupBackfillChildDI()` MUST be dynamically
    //     imported (preserving SEC-H-1 listener-first ordering) and awaited.
    //
    // (1) helper 呼び出し: `setupBackfillChildDI()` は dynamic import で
    //     呼ばれる (SEC-H-1 listener-first 維持)。
    expect(src).toMatch(/import\(\s*["']\.\/shared\/backfill-child-di\.js["']\s*\)/);
    expect(src).toMatch(/await\s+setupBackfillChildDI\s*\(\s*\)/);

    // (2) No top-level static import of the helper or the 3 underlying DI
    //     targets (those imports moved into the helper file).
    //
    // (2) helper および 3 underlying DI target の top-level static import は
    //     禁止 (helper file 内に移動済)。
    expect(src).not.toMatch(/^import\s+\{[^}]*\bsetupBackfillChildDI\b[^}]*\}\s+from/m);
    expect(src).not.toMatch(/^import\s+\{[^}]*\bsetEmbeddingServiceFactory\b[^}]*\}\s+from/m);
    expect(src).not.toMatch(
      /^import\s+\{[^}]*\bprisma\b[^}]*\}\s+from\s+["']@reftrixmcp\/database["']/m
    );
    expect(src).not.toMatch(
      /^import\s+\{[^}]*\bembeddingService\b[^}]*\}\s+from\s+["']@reftrixmcp\/ml["']/m
    );

    // (3) Ordering constraints — verify:
    //       (a) process.on("message" → listener registration
    //       (b) await setupBackfillChildDI() → DI setup via helper
    //       (c) setInterval → heartbeat registration
    //       (d) await dispatchBackfillByCategory → service dispatch
    //     (a) < (b) < (c) < (d)
    //
    // (3) 順序制約: listener → DI helper → heartbeat → dispatch。
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("// ");
        return idx >= 0 ? line.slice(0, idx).padEnd(line.length) : line;
      });

    const lineOf = (pattern: RegExp): number => codeOnly.findIndex((l) => pattern.test(l));

    const listenerLine = lineOf(/process\.on\(\s*"message"/);
    const helperCallLine = lineOf(/await\s+setupBackfillChildDI\s*\(/);
    const heartbeatLine = lineOf(/setInterval\s*\(/);
    const dispatchLine = lineOf(/await\s+dispatchBackfillByCategory\s*\(/);

    expect(listenerLine).toBeGreaterThanOrEqual(0);
    expect(helperCallLine).toBeGreaterThan(listenerLine);
    expect(heartbeatLine).toBeGreaterThan(helperCallLine);
    expect(dispatchLine).toBeGreaterThan(heartbeatLine);
  });

  // --------------------------------------------------------------------------
  // T15 (PR2d HIGH-β + HIGH-δ): parameterized contract verification across the
  // 6 invokable backfill categories. Each fixture pins:
  //   (a) the dispatch switch routes `params.category` to the matching
  //       per-category service wrapper
  //   (b) `partsLimit` is propagated end-to-end (TPA-H-1 / ADR-0007 head-100)
  //   (c) `backfill.done` IPC carries observability fields per TPA-H-1
  //   (d) errors are sanitized before IPC emission (SEC-M-1 / CWE-209)
  //
  // T15 (PR2d HIGH-β + HIGH-δ): 6 invokable backfill category への
  // parameterized contract 検証。各 fixture は以下を pin する:
  //   (a) dispatch switch が `params.category` を per-category service wrapper
  //       へ正しく routing する
  //   (b) `partsLimit` の end-to-end 伝達 (TPA-H-1 / ADR-0007 head-100 契約)
  //   (c) `backfill.done` IPC の observability フィールド搬送
  //   (d) IPC 送信前の sanitize (SEC-M-1 / CWE-209)
  //
  // Note: `part_visual` is intentionally excluded — the dispatch switch
  // throws for it (LCC-M-2: requires `runVisualEmbeddingSubPhases` flow not
  // yet wrapped in service layer; PR3b ships the wrapper). T15b pins the
  // throw behavior separately.
  //
  // 注: `part_visual` は意図的に除外 — dispatch switch が throw する
  // (LCC-M-2: `runVisualEmbeddingSubPhases` 経路の service wrapper 未実装、
  // PR3b 対応)。T15b で throw 挙動を別途 pin。
  // --------------------------------------------------------------------------
  type CategoryFixture = {
    category: "part_text" | "section_visual" | "motion" | "background" | "responsive";
    serviceMock: keyof typeof perCategoryMocks;
    label: string;
  };

  const CATEGORY_FIXTURES: CategoryFixture[] = [
    { category: "part_text", serviceMock: "backfillPartTextForPage", label: "part_text" },
    {
      category: "section_visual",
      serviceMock: "backfillSectionVisualsForPage",
      label: "section_visual",
    },
    { category: "motion", serviceMock: "backfillMotionsForPage", label: "motion" },
    { category: "background", serviceMock: "backfillBackgroundsForPage", label: "background" },
    { category: "responsive", serviceMock: "backfillResponsiveForPage", label: "responsive" },
  ];

  describe("T15 (PR2d HIGH-β + HIGH-δ): parameterized 6-category dispatch contract", () => {
    for (const fixture of CATEGORY_FIXTURES) {
      it(`T15.${fixture.label}: dispatch switch routes to ${fixture.serviceMock} with partsLimit + backfill.done observability`, async () => {
        // Per-fixture mock with distinct generated count for routing
        // disambiguation. Errors carry no Prisma/network/timeout keyword so
        // they map to the generic "internal error" message after sanitize
        // (SEC-M-1 / CWE-209).
        // Fixture 別 mock — generated 値で routing を区別。errors は既知
        // キーワードを含まないため sanitize 後 generic message に集約される。
        const generated = 5;
        perCategoryMocks[fixture.serviceMock].mockReset();
        perCategoryMocks[fixture.serviceMock].mockImplementation(
          async (
            webPageId: string,
            options?: {
              onProgress?: (type: string, done: number, total: number) => void;
              partsLimit?: number;
            }
          ) => {
            options?.onProgress?.(fixture.category, 1, generated);
            return {
              generated,
              failed: 1,
              memorySkips: 0,
              errors: ["dummy-error"],
              webPageId,
              category: fixture.category,
            };
          }
        );
        const harness = installProcessHarness();
        try {
          await import("../../../src/workers/phases/embedding-backfill-child");
          await harness.dispatch({
            type: "backfill.run",
            kind: "backfill.run",
            jobId: `job-${fixture.label}`,
            webPageId: VALID_UUID,
            category: fixture.category,
            partsLimit: 100,
            startedAt: VALID_ISO,
          });
          await new Promise((r) => setImmediate(r));
          await new Promise((r) => setImmediate(r));
          await new Promise((r) => setImmediate(r));

          // (a) Dispatch routed to the matching per-category mock.
          // (a) dispatch が per-category mock に到達。
          expect(perCategoryMocks[fixture.serviceMock]).toHaveBeenCalledTimes(1);
          // (b) partsLimit propagated end-to-end (TPA-H-1 / ADR-0007 head-100).
          // (b) partsLimit の end-to-end 伝達 (TPA-H-1 / ADR-0007 head-100)。
          const lastCall = perCategoryMocks[fixture.serviceMock].mock.calls[0];
          expect(lastCall?.[0]).toBe(VALID_UUID);
          expect(lastCall?.[1]?.partsLimit).toBe(100);
          // (c) backfill.done IPC carries observability fields (TPA-H-1) and
          //     errors are sanitized before emission (SEC-M-1 / CWE-209).
          // (c) backfill.done IPC の observability 搬送 + sanitize。
          const doneMsgs = harness.messages.filter((m) => m.kind === "backfill.done");
          expect(doneMsgs.length).toBe(1);
          const done = doneMsgs[0] as {
            processedCount: number;
            failedCount: number;
            memorySkipCount: number;
            errors: string[];
          };
          expect(done.processedCount).toBe(generated);
          expect(done.failedCount).toBe(1);
          expect(done.memorySkipCount).toBe(0);
          expect(done.errors).toEqual(["An internal error occurred"]);
          // (d) exit(0) follows backfill.done.
          // (d) backfill.done 直後に exit(0)。
          expect(harness.exits.some((e) => e.code === 0)).toBe(true);
        } finally {
          harness.restore();
        }
      });
    }

    // ------------------------------------------------------------------------
    // T15b (LCC-M-2): part_visual fork dispatch deliberately throws so the
    // orchestrator's catch-fallback routes to in-process. This pins the
    // documented PR2d behavior until PR3b ships
    // `backfillPartVisualsForPage(webPageId, options)`.
    //
    // T15b (LCC-M-2): part_visual は dispatch switch が意図的に throw し
    // orchestrator の catch-fallback で in-process 経路に乗せる。PR3b で
    // `backfillPartVisualsForPage` が新設されるまでの documented 挙動を pin。
    // ------------------------------------------------------------------------
    it("T15b (LCC-M-2): part_visual dispatch throws so orchestrator falls back to in-process", async () => {
      const harness = installProcessHarness();
      try {
        await import("../../../src/workers/phases/embedding-backfill-child");
        await harness.dispatch({
          type: "backfill.run",
          kind: "backfill.run",
          jobId: "job-part-visual",
          webPageId: VALID_UUID,
          category: "part_visual",
          partsLimit: 100,
          startedAt: VALID_ISO,
        });
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        // backfill.error IPC is sent (the orchestrator translates this into
        // the in-process fallback path documented in ADR-0015 Amendment 8
        // LCC-M-2). The thrown message is sanitized via sanitizeErrorMessage
        // in the runBackfill catch path (SEC-M-1 invariant).
        // backfill.error IPC が送出される (orchestrator が ADR-0015 Amendment
        // 8 LCC-M-2 の in-process fallback を起動する起点)。runBackfill catch
        // path で sanitize 経由 (SEC-M-1 invariant)。
        const errs = harness.messages.filter((m) => m.kind === "backfill.error");
        expect(errs.length).toBeGreaterThanOrEqual(1);
        const err = errs[0] as { message: string };
        expect(typeof err.message).toBe("string");
        expect(err.message.length).toBeGreaterThan(0);
        // exit(1) follows the error.
        // error 直後に exit(1)。
        expect(harness.exits.some((e) => e.code === 1)).toBe(true);
      } finally {
        harness.restore();
      }
    });
  });

  // --------------------------------------------------------------------------
  // T16 (PR2d HIGH-α): the helper file `shared/backfill-child-di.ts` itself
  // owns the 3 dynamic DI imports. Static-analysis regression guard — if the
  // helper is later refactored to use static imports (which would break SEC-
  // H-1 listener-first compliance for the child), this test fails fast.
  //
  // T16 (PR2d HIGH-α): helper file `shared/backfill-child-di.ts` 自身が 3 つの
  // dynamic DI import を所有することを静的検証する。helper が static import
  // に refactor されると child の SEC-H-1 listener-first 遵守が壊れるため、
  // 本 test が即 fail することで regression を防ぐ。
  // --------------------------------------------------------------------------
  it("T16 (PR2d HIGH-α): setupBackfillChildDI helper file uses dynamic imports for 3 DI targets", () => {
    const helperSrc = fs.readFileSync(
      path.resolve(__dirname, "../../../src/workers/phases/shared/backfill-child-di.ts"),
      "utf-8"
    );
    // Helper export.
    expect(helperSrc).toMatch(/export\s+async\s+function\s+setupBackfillChildDI\s*\(/);
    // 3 dynamic import specifiers via Promise.all.
    expect(helperSrc).toMatch(/Promise\.all\s*\(\s*\[/);
    expect(helperSrc).toMatch(
      /import\(\s*["']\.\.\/\.\.\/\.\.\/services\/layout-embedding\.service\.js["']\s*\)/
    );
    expect(helperSrc).toMatch(/import\(\s*["']@reftrixmcp\/database["']\s*\)/);
    expect(helperSrc).toMatch(/import\(\s*["']@reftrixmcp\/ml["']\s*\)/);
    // Both factory setters called.
    expect(helperSrc).toMatch(
      /setEmbeddingServiceFactory\s*\(\s*\(\s*\)\s*=>\s*mlEmbeddingService/
    );
    expect(helperSrc).toMatch(
      /setLayoutPrismaClientFactory\s*\(\s*\(\s*\)\s*=>\s*prisma(\s+as\s+never)?/
    );
    // SPDX header.
    const head = helperSrc.split("\n").slice(0, 2).join("\n");
    expect(head).toContain("SPDX-License-Identifier: AGPL-3.0-only");
  });
});
