// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-PHASE5-COLDLOAD-DELTA-EXCLUSION-001 (PR-C1 / Layer 1)
 *
 * CPU "true 10/10" integration plan V1.1 §4.1 / ADR-0008 Amendment 1 §Decision 1.
 * Root cause (Layer 1, PRIMARY): on CPU the e5-base ONNX cold-load (~1GB+) is
 * synchronously paid inside the **loop-head chunk**'s encode. Because
 * `processOneChunk` captures `preChunkRssMb` BEFORE that cold-load, the loop-head
 * `deltaMb` always carries the persistent cold-load arena and ALWAYS exceeds
 * `PER_CHUNK_RSS_BUDGET_MB (1536)` — a false-positive `budget_exceeded` break
 * that froze every site at "exactly 30" (= `EMBEDDING_CHUNK_SIZE`).
 *
 * PR-C1 fix (A3): EXCLUDE the loop-head chunk (`chunkIndex === skippedHeadChunks`,
 * NOT a fixed index 0) from the C1 budget enforcement (always proceed); the next
 * chunk onward enforces the budget normally. The process-wide
 * `PHASE5_CHILD_RSS_KILL_DELTA_MB = 4096` fork-kill backstop remains the
 * defence-in-depth for a truly anomalous loop-head arena (CWE-770).
 *
 * a CI-failing executable invariant. `.skip()` / `.todo()` are forbidden; any
 * failure is a P0 incident handled by pipeline-engineer +
 * capture-embedding-engineer.
 *
 * 5 branches (plan §4.1):
 *   (1) loop-head no-break (basic), (2) next chunk break (basic),
 *   (3) retry `skippedHeadChunks > 0` (M-01),
 *   (4) loop-head anomalous arena (3× budget) still proceeds (M-05, CWE-770),
 *   (5) (a) next chunk always caught + (b) 4096 fork-kill margin static assert (M-05).
 *
 * Mock boundary note (FIND-IO-V0-L-08 / TDA L-03): `process.memoryUsage` is
 * stubbed to drive `rssMb()` deterministically for the loop **logic** (branch
 * selection). The RUNTIME guarantee (chunk-1+ per-chunk delta actually fits the
 * 1536 budget on CPU) is NOT claimed by this mock — it is established by the
 * CPU real-machine pass^3 verification (plan §6 / M-02, Phase 2 Impl gate).
 *
 * @see  §4.1
 * @see  Amendment 1 §Decision 1
 * @see apps/mcp-server/src/workers/phases/phase-5-chunked-text-loop.ts (processOneChunk)
 *
 * @module tests/regression/standing/large-page/inv-phase5-coldload-delta-exclusion-001
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  runChunkedTextEmbeddingLoop,
  type ChunkedTextLoopContext,
} from "../../../../src/workers/phases/phase-5-chunked-text-loop";
import { PER_CHUNK_RSS_BUDGET_MB } from "../../../../src/workers/phases/types";
import * as phaseTypes from "../../../../src/workers/phases/types";
import { CHILD_RSS_KILL_DELTA_MB } from "../../../../src/workers/phases/phase-5-child-ipc";

const MB = 1024 * 1024;

/**
 * Fixed 32GB-dev-baseline memory thresholds. The production
 * `MEMORY_DEGRADATION_THRESHOLD_MB` / `MEMORY_CRITICAL_THRESHOLD_MB` exports are
 * `export let` values that `initMemoryConstants()` RESOLVES FROM THE REAL
 * `os.totalmem()` of the host (`resolveMemoryConfig()` → `computeMemoryProfile()`:
 * `min(totalMb*0.6, 12288)` / `min(totalMb*0.7, 14336)`). On the 64GB dev box
 * they saturate at 12288/14336, but on a small CI runner (≤~9.4GB RAM) the
 * critical threshold drops to `totalMb*0.7` (e.g. ~5734MB at 8GB).
 *
 * This test mocks `process.memoryUsage().rss` to drive the C1 per-chunk RSS
 * **budget delta** (`rssMb() - preChunkRssMb` vs `PER_CHUNK_RSS_BUDGET_MB`,
 * a FIXED 1536MB constant). But the same mocked ABSOLUTE rss is also read by
 * `checkMemoryPressure()` (loop-head abort/degrade gate, compared against the
 * RAM-derived thresholds). Branch 4's 3× budget head delta (4608MB) pushes the
 * simulated absolute rss to 6608MB — below the dev box's 14336 critical (PASS)
 * but ABOVE a small CI runner's `totalMb*0.7` critical (`shouldAbort=true`, loop
 * breaks after chunk-0 → `[0]` instead of `[0,1,2]`). That is the exact CI-only
 * failure: the abort gate's threshold is machine-RAM-dependent while the mocked
 * rss is fixed (FIND-IO-V0-L-08 mock-boundary gap).
 *
 * FIX: pin the abort/degrade gate to these fixed dev-baseline thresholds (12288/
 * 14336) inside the test by stubbing `checkMemoryPressure` to evaluate the
 * mocked rss against them deterministically — INDEPENDENT of the host RAM. The
 * C1 per-chunk BUDGET gate (the INV's actual subject, a fixed constant) is left
 * untouched and still reads the mocked `process.memoryUsage()`.
 *
 * (a) SSOT-derive candidate (FIND-IMPL-V0-L-01, tracked, deadline 2026-05-31):
 *     these two literals 12288 / 14336 are the production caps
 *     `min(totalMb*0.6, 12288)` / `min(totalMb*0.7, 14336)` —
 *     `DEGRADATION_CAP_MB` / `CRITICAL_CAP_MB` in
 *     `apps/mcp-server/src/services/worker-memory-profile.ts`. They are
 *     CURRENTLY hardcoded here; a future SSOT import of those production
 *     constants is preferred to detect coupling drift (if the production cap
 *     changes, an imported test literal would surface the divergence at CI;
 *     a hardcoded literal goes stale silently). L severity, docs-tracked only.
 *
 * (b) heap-abort OR-branch NON-reproduction (FIND-IMPL-V0-L-02, tracked,
 *     deadline 2026-05-31): the `checkMemoryPressure` stub reproduces only the
 *     rss-vs-threshold branch of degrade/abort; the heap-limit abort OR-branch
 *     (`heapUsedMb` vs the heap critical) does NOT fire because `heapUsed` is
 *     mocked tiny (32MB). This is intentional: the INV's scope is the C1
 *     per-chunk BUDGET delta exclusion (loop-head proceed vs next-chunk break),
 *     NOT the heap-abort path; with `heapUsed=32MB` the stub is semantically
 *     equivalent for the budget-delta logic under test. The heap-abort path is
 *     covered elsewhere (worker-memory-profile / pressure-gate unit tests).
 */
const FIXED_DEGRADATION_THRESHOLD_MB = 12288;
const FIXED_CRITICAL_THRESHOLD_MB = 14336;

/**
 * Deterministic RSS model. `current` MB is the simulated `process.memoryUsage().rss`
 * (in MB). The encode callback bumps it per chunk to model the arena growth that
 * `rssMb()` observes as the post-encode delta. `heapUsed` is kept tiny so the
 * heap-limit abort never fires. The `checkMemoryPressure` stub re-derives
 * degrade/abort from the simulated rss against the FIXED dev-baseline thresholds
 * (12288/14336 MB) so the gate is host-RAM-independent (CI determinism).
 */
function installRssModel(baseRssMb: number): { setRss: (mb: number) => void; restore: () => void } {
  let currentRssMb = baseRssMb;
  const muSpy = vi.spyOn(process, "memoryUsage").mockImplementation(
    (() =>
      ({
        rss: currentRssMb * MB,
        heapTotal: 64 * MB,
        heapUsed: 32 * MB,
        external: 0,
        arrayBuffers: 0,
      }) as NodeJS.MemoryUsage) as typeof process.memoryUsage
  );
  // Pin the loop-head abort/degrade gate to the FIXED dev-baseline thresholds so
  // it is independent of the host's real os.totalmem() (CI determinism). Still
  // evaluates the SIMULATED rss (not a constant), preserving the gate's logic.
  //
  // (c) namespace-spy esbuild-transform dependency (FIND-IMPL-V0-L-04, tracked,
  // deadline 2026-05-31): `vi.spyOn(phaseTypes, "checkMemoryPressure")` is a
  // namespace-MEMBER spy on an ESM re-export. It relies on vitest's esbuild
  // module-transform turning the `import * as phaseTypes` namespace member into
  // a spy-able property; there is ZERO precedent for this pattern elsewhere in
  // the codebase. A future build-target / bundler / transform change could make
  // the spy a SILENT no-op (the real `checkMemoryPressure` would run against the
  // host RAM, reintroducing the CI-only flake without a visible failure). L
  // severity, docs-tracked; mitigation candidate is a DI seam or a dedicated
  // pressure-gate injection point so the gate can be overridden without a
  // namespace-member spy.
  const memSpy = vi.spyOn(phaseTypes, "checkMemoryPressure").mockImplementation(() => ({
    shouldDegrade: currentRssMb >= FIXED_DEGRADATION_THRESHOLD_MB,
    shouldAbort: currentRssMb >= FIXED_CRITICAL_THRESHOLD_MB,
    rssMb: currentRssMb,
    heapUsedMb: 32,
  }));
  return {
    setRss: (mb: number): void => {
      currentRssMb = mb;
    },
    restore: (): void => {
      muSpy.mockRestore();
      memSpy.mockRestore();
    },
  };
}

/** Minimal loop context with a no-op job lock + dispose + fresh telemetry. */
function makeContext(): ChunkedTextLoopContext {
  return {
    // The loop only calls `job.extendLock(...)`, whose errors are swallowed by
    // `extendJobLock`. A typed stub is sufficient.
    job: {
      id: "test-job",
      extendLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChunkedTextLoopContext["job"],
    effectiveToken: "test-token",
    effectiveLockDuration: 30000,
    sharedLayoutEmbeddingService: {
      disposeEmbeddingPipeline: vi.fn().mockResolvedValue(undefined),
    },
    chunkedEncoderTelemetry: {},
  };
}

describe("INV-PHASE5-COLDLOAD-DELTA-EXCLUSION-001: PR-C1 loop-head cold-load delta exclusion", () => {
  let rssModel: ReturnType<typeof installRssModel>;

  beforeEach(() => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-PHASE5-COLDLOAD-DELTA-EXCLUSION-001"
    );
  });

  afterEach(() => {
    rssModel?.restore();
    vi.restoreAllMocks();
  });

  /**
   * Build a 4-chunk item set (chunkSize=1 via initialChunkSize so each item is
   * its own chunk → chunkIndex == item index). The encode callback bumps the
   * simulated RSS by `deltaForChunk(index)` MB so the post-encode `rssMb()` sees
   * that delta. `coldLoadAtHead` simulates the e5 cold-load on the loop-head
   * chunk (large delta that would false-positive without the exclusion).
   */
  async function driveLoop(opts: {
    chunkCount: number;
    skippedHeadChunks: number;
    deltaForChunk: (chunkIndex: number) => number;
  }): Promise<{
    ctx: ChunkedTextLoopContext;
    encodedChunkIndexes: number[];
    warmupExcludedIndexes: number[];
  }> {
    const baseRssMb = 2000; // well below the 12288 degradation threshold
    rssModel = installRssModel(baseRssMb);
    let runningRssMb = baseRssMb;

    const ctx = makeContext();
    const encodedChunkIndexes: number[] = [];
    const warmupExcludedIndexes: number[] = [];
    const items = Array.from({ length: opts.chunkCount }, (_, i) => i);

    await runChunkedTextEmbeddingLoop(ctx, {
      items,
      initialChunkSize: 1, // one item per chunk → chunkIndex == item value
      lockLabel: "embedding-test",
      hardeningEnabled: true,
      skippedHeadChunks: opts.skippedHeadChunks,
      encodeChunk: async (_chunkItems, chunkIndex): Promise<void> => {
        encodedChunkIndexes.push(chunkIndex);
        // Model the per-chunk arena growth observed by the post-encode rssMb().
        runningRssMb += opts.deltaForChunk(chunkIndex);
        rssModel.setRss(runningRssMb);
      },
      warmupChunkExcluded: (chunkIndex): void => {
        warmupExcludedIndexes.push(chunkIndex);
      },
    });

    return { ctx, encodedChunkIndexes, warmupExcludedIndexes };
  }

  it("INV-PHASE5-COLDLOAD-DELTA-EXCLUSION-001 branch 1: loop-head chunk with cold-load delta does NOT break (proceeds)", async () => {
    // Branch 1 (basic): chunk-0 (loop-head) carries the e5 cold-load delta
    // (budget+1), all later chunks are well within budget. The loop must NOT
    // break at the head → all chunks encode, no partial completion telemetry.
    const { ctx, encodedChunkIndexes } = await driveLoop({
      chunkCount: 4,
      skippedHeadChunks: 0,
      deltaForChunk: (i) => (i === 0 ? PER_CHUNK_RSS_BUDGET_MB + 1 : 10),
    });

    // CI-failing evidence: PRE-FIX the loop-head break froze at chunksDone=1
    // (only chunk-0 encoded) and set partialCompletion. POST-FIX all 4 encode.
    expect(encodedChunkIndexes).toEqual([0, 1, 2, 3]);
    expect(ctx.chunkedEncoderTelemetry.partialCompletion).toBeUndefined();
    expect(ctx.chunkedEncoderTelemetry.budgetExceededChunkIndex).toBeUndefined();
  });

  it("INV-PHASE5-COLDLOAD-DELTA-EXCLUSION-001 branch 2: a NON-head chunk exceeding budget DOES break (defence preserved)", async () => {
    // Branch 2 (basic): chunk-0 head excluded (cold-load), chunk-1 within budget,
    // chunk-2 exceeds budget → loop breaks AT chunk-2 (the true OOM defence is
    // alive for every chunk after the head).
    const { ctx, encodedChunkIndexes } = await driveLoop({
      chunkCount: 4,
      skippedHeadChunks: 0,
      deltaForChunk: (i) => {
        if (i === 0) return PER_CHUNK_RSS_BUDGET_MB + 1; // cold-load (excluded)
        if (i === 2) return PER_CHUNK_RSS_BUDGET_MB + 1; // budget overshoot
        return 10;
      },
    });

    // chunk-2 persisted then triggered budget_exceeded → counted (chunkIndex++),
    // chunk-3 never reached.
    expect(encodedChunkIndexes).toEqual([0, 1, 2]);
    expect(ctx.chunkedEncoderTelemetry.budgetExceededChunkIndex).toBe(2);
    expect(ctx.chunkedEncoderTelemetry.partialCompletion).toEqual({
      chunksDone: 3,
      totalChunks: 4,
    });
  });

  it("INV-PHASE5-COLDLOAD-DELTA-EXCLUSION-001 branch 3 (M-01): exclusion targets chunkIndex===skippedHeadChunks on a retry path (NOT fixed index 0)", async () => {
    // Branch 3 (M-01): retry path with skippedHeadChunks=2. The e5 ONNX session
    // is re-initialized, so the cold-load lands on the POST-SKIP loop-head chunk
    // (chunkIndex=2). chunk-2 must be EXCLUDED (warmup hook fires for index 2,
    // not 0), and the loop-head cold-load delta must NOT break.
    const { ctx, encodedChunkIndexes, warmupExcludedIndexes } = await driveLoop({
      chunkCount: 5, // chunks 0,1 skipped (head), loop starts at chunkIndex=2
      skippedHeadChunks: 2,
      deltaForChunk: (i) => (i === 2 ? PER_CHUNK_RSS_BUDGET_MB + 1 : 10),
    });

    // Only chunks 2,3,4 encode (0,1 are skipped head chunks). The exclusion is at
    // chunkIndex=2 (= skippedHeadChunks), NOT a fixed 0.
    expect(encodedChunkIndexes).toEqual([2, 3, 4]);
    expect(warmupExcludedIndexes).toEqual([2]);
    expect(ctx.chunkedEncoderTelemetry.partialCompletion).toBeUndefined();
    expect(ctx.chunkedEncoderTelemetry.budgetExceededChunkIndex).toBeUndefined();
  });

  it("INV-PHASE5-COLDLOAD-DELTA-EXCLUSION-001 branch 4 (M-05 / CWE-770): loop-head chunk with 3× budget anomalous arena still PROCEEDS", async () => {
    // Branch 4 (M-05): the cold-load and a truly anomalous loop-head arena are
    // indistinguishable at the head (the pre-chunk RSS is captured before encode).
    // By design we intentionally EXCLUDE the head even for a 3× budget delta; the
    // fork-kill 4096 backstop is the defence-in-depth (branch 5b static assert).
    const { ctx, encodedChunkIndexes, warmupExcludedIndexes } = await driveLoop({
      chunkCount: 3,
      skippedHeadChunks: 0,
      deltaForChunk: (i) => (i === 0 ? PER_CHUNK_RSS_BUDGET_MB * 3 : 10),
    });

    expect(encodedChunkIndexes).toEqual([0, 1, 2]);
    expect(warmupExcludedIndexes).toEqual([0]);
    expect(ctx.chunkedEncoderTelemetry.partialCompletion).toBeUndefined();
    expect(ctx.chunkedEncoderTelemetry.budgetExceededChunkIndex).toBeUndefined();
  });

  it("INV-PHASE5-COLDLOAD-DELTA-EXCLUSION-001 branch 5a (M-05): the chunk right after the head is ALWAYS caught on budget overshoot", async () => {
    // Branch 5a (M-05): the very next chunk after the excluded head is the first
    // budget-enforced chunk. A budget overshoot there must ALWAYS break (no
    // off-by-one that would extend the exclusion past the head).
    const { ctx, encodedChunkIndexes } = await driveLoop({
      chunkCount: 4,
      skippedHeadChunks: 0,
      deltaForChunk: (i) => {
        if (i === 0) return PER_CHUNK_RSS_BUDGET_MB + 1; // head (excluded)
        if (i === 1) return PER_CHUNK_RSS_BUDGET_MB + 1; // first enforced chunk
        return 10;
      },
    });

    expect(encodedChunkIndexes).toEqual([0, 1]); // breaks at chunk-1
    expect(ctx.chunkedEncoderTelemetry.budgetExceededChunkIndex).toBe(1);
  });

  it("INV-PHASE5-COLDLOAD-DELTA-EXCLUSION-001 branch 5b (M-05 / CWE-770): fork-kill backstop has margin above the per-chunk budget (static assert)", () => {
    // Branch 5b (M-05, static constant assert): after the loop-head budget
    // exclusion, the ONLY remaining defence for a runaway loop-head arena is the
    // process-wide fork-kill backstop. It MUST sit strictly above the per-chunk
    // budget so the budget gate (every non-head chunk) fires first and the
    // fork-kill remains the last-resort backstop. 4096 (PHASE5_CHILD_RSS_KILL_
    // DELTA_MB default) > 1536 (PER_CHUNK_RSS_BUDGET_MB default) with margin for
    // cold-load (~1GB) + a single chunk's max encode delta.
    expect(CHILD_RSS_KILL_DELTA_MB).toBe(4096);
    expect(CHILD_RSS_KILL_DELTA_MB).toBeGreaterThan(PER_CHUNK_RSS_BUDGET_MB);
    // Margin must cover the cold-load (~1GB) + a single chunk's max budgeted
    // encode (one PER_CHUNK_RSS_BUDGET_MB worth) above the budget itself.
    const COLD_LOAD_MAX_MB = 1024;
    const SINGLE_CHUNK_ENCODE_MAX_MB = PER_CHUNK_RSS_BUDGET_MB;
    expect(CHILD_RSS_KILL_DELTA_MB).toBeGreaterThanOrEqual(
      COLD_LOAD_MAX_MB + SINGLE_CHUNK_ENCODE_MAX_MB
    );
  });
});
