// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * v0.4.0 PR7e-α (Revert of PR7b null assignments): disposePhase4Memory tests
 * v0.4.0 PR7e-α (Revert of PR7b null assignments): disposePhase4Memory tests
 *
 * PR7b は state.layoutResultForNarrative 等を null 化していたが、PR7e-α で
 * 「5 種 embedding 0 件」バグの真因と判明し撤回 (ADR-0012)。本テストは撤回後の
 * 期待動作を検証する:
 *   - state.layoutResultForNarrative / motionResultForEmbedding /
 *     jsAnimationsForEmbedding / scrollVisionResultForEmbedding を **保持** する
 *     (Phase 5 入力を破壊しない)
 *   - screenshotPngPath / html / screenshotBase64 も従来通り保持する
 *   - GC + 100ms 待機 + 3 回平均 RSS 測定で beforeRssMb / afterRssMb / reclaimedMb を返す
 *
 * PR7b had nulled out state.* fields but PR7e-α reverted that after
 * identifying it as the root cause of the 5-embedding-zero bug (ADR-0012).
 * These tests assert post-revert behaviour:
 *   - state.layoutResultForNarrative / motionResultForEmbedding /
 *     jsAnimationsForEmbedding / scrollVisionResultForEmbedding must be
 *     **preserved** (Phase 5 inputs intact)
 *   - screenshotPngPath / html / screenshotBase64 preserved as before
 *   - Returns beforeRssMb / afterRssMb / reclaimedMb as 3-sample avg
 *
 * @module tests/workers/page-analyze-worker-phase4-dispose
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// page-analyze-worker は database / ml モジュール / queues に依存するため、
// 軽量にテストするには事前に Prisma / EmbeddingService をモックする必要がある。
// To unit-test page-analyze-worker we must mock its DB / ML / queue deps before import.
vi.mock("@reftrixmcp/database", () => ({
  prisma: {
    webPage: {
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  },
}));

vi.mock("@reftrixmcp/ml", () => ({
  embeddingService: {
    switchProvider: vi.fn(async () => undefined),
    releaseGpu: vi.fn(async () => undefined),
    generateFromText: vi.fn(async () => ({ embedding: new Array(768).fill(0) })),
  },
}));

vi.mock("../../src/queues/embedding-backfill-queue", async () => {
  const actual = await vi.importActual<typeof import("../../src/queues/embedding-backfill-queue")>(
    "../../src/queues/embedding-backfill-queue"
  );
  return {
    ...actual,
    createEmbeddingBackfillQueue: vi.fn(() => ({
      add: vi.fn(),
      close: vi.fn(),
      getWaitingCount: vi.fn(async () => 0),
    })),
  };
});

vi.mock("../../src/queues/page-analyze-queue", async () => ({
  createPageAnalyzeQueue: vi.fn(() => ({
    getJob: vi.fn(),
    getJobs: vi.fn(async () => []),
    close: vi.fn(),
  })),
}));

interface MinimalPipelineState {
  layoutResultForNarrative: unknown;
  motionResultForEmbedding: unknown;
  jsAnimationsForEmbedding: unknown;
  scrollVisionResultForEmbedding: unknown;
  // 物理維持される項目 / fields preserved
  screenshotPngPath?: string | undefined;
  html: unknown;
  screenshotBase64: unknown;
}

describe("PR7e-α: disposePhase4Memory runtime (Revert of PR7b null assignments, ADR-0012)", () => {
  let disposePhase4Memory: (
    state: MinimalPipelineState
  ) => Promise<{ beforeRssMb: number; afterRssMb: number; reclaimedMb: number }>;

  beforeAll(async () => {
    const mod = await import("../../src/workers/page-analyze-worker");
    disposePhase4Memory = mod.disposePhase4Memory as never;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeState(): MinimalPipelineState {
    return {
      layoutResultForNarrative: { large: "object" },
      motionResultForEmbedding: { other: "object" },
      jsAnimationsForEmbedding: { js: "data" },
      scrollVisionResultForEmbedding: { vision: "data" },
      screenshotPngPath: "/tmp/reftrix-screenshots/phase5/abc.png",
      html: "<html>preserved</html>",
      screenshotBase64: "AAAA",
    };
  }

  it("PR7e-α: in-memory reference を Phase 5 入力のため保持する / preserves refs so Phase 5 has inputs", async () => {
    // ADR-0012: null 化の撤回。以前は null を期待していたが、これが5種embedding 0件
    // バグの真因だったため、現在は references を保持することを期待する。
    // ADR-0012: null-out reverted. References must survive disposal because
    // Phase 5 needs them (previous null assignments were the root cause of
    // the 5-embedding-zero bug).
    const state = makeState();
    await disposePhase4Memory(state);
    expect(state.layoutResultForNarrative).toEqual({ large: "object" });
    expect(state.motionResultForEmbedding).toEqual({ other: "object" });
    expect(state.jsAnimationsForEmbedding).toEqual({ js: "data" });
    expect(state.scrollVisionResultForEmbedding).toEqual({ vision: "data" });
  });

  it("screenshotPngPath を物理破棄しない / preserves screenshotPngPath", async () => {
    const state = makeState();
    await disposePhase4Memory(state);
    expect(state.screenshotPngPath).toBe("/tmp/reftrix-screenshots/phase5/abc.png");
  });

  it("html / screenshotBase64 を物理破棄しない / preserves html and screenshotBase64", async () => {
    const state = makeState();
    await disposePhase4Memory(state);
    expect(state.html).toBe("<html>preserved</html>");
    expect(state.screenshotBase64).toBe("AAAA");
  });

  it("beforeRssMb / afterRssMb / reclaimedMb の整数を返す / returns integer Mb metrics", async () => {
    const state = makeState();
    const result = await disposePhase4Memory(state);
    expect(Number.isInteger(result.beforeRssMb)).toBe(true);
    expect(Number.isInteger(result.afterRssMb)).toBe(true);
    expect(Number.isInteger(result.reclaimedMb)).toBe(true);
    expect(result.beforeRssMb).toBeGreaterThan(0);
    expect(result.afterRssMb).toBeGreaterThan(0);
  });

  it("reclaimedMb = beforeRssMb - afterRssMb / reclaimed equals delta", async () => {
    const state = makeState();
    const result = await disposePhase4Memory(state);
    expect(result.reclaimedMb).toBe(result.beforeRssMb - result.afterRssMb);
  });

  it("並行呼び出しでも references を保持し続ける / keeps refs across repeated calls", async () => {
    const state = makeState();
    await disposePhase4Memory(state);
    // 2 回目の呼び出しでも例外なく完了し、references が維持されることを確認。
    // Second call completes without throwing and refs remain intact.
    await expect(disposePhase4Memory(state)).resolves.toBeDefined();
    expect(state.layoutResultForNarrative).toEqual({ large: "object" });
  });
});
