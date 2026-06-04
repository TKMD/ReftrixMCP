// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Common Chunked Text-Embedding Loop (M-1-RSS chunk-fork contingency)
 *
 * PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a, "chunk-fork
 * sub-division contingency" — pre-committed in the merge gate, **activated**
 * after the real-machine CPU verification found un-chunked / budget-unbounded
 * text sub-phase forks exceeding the `CHILD_RSS_KILL_DELTA_MB = 4096` kill
 * threshold (`background_text` delta=4711MB at 130 patterns; `motion_text`
 * 4010MB)). The surviving sub-phases (`part_text` 254 parts → 2760MB,
 * `section_text`) share ONE structural property the dead ones lacked: a
 * **chunk-loop with a chunk-boundary `disposeEmbeddingPipeline()` PLUS a
 * per-chunk RSS budget break** that stops the loop *before* the e5-base ONNX
 * CPU arena floor accumulates past the kill threshold.
 *
 * This module extracts that canonical pattern (originally inline in
 * `processSectionTextEmbeddingChunks` / `processPartTextEmbeddingChunks`) into a
 * single generic driver so **all 7 text sub-phases** consume the identical
 * RSS-control contract:
 *
 *   1. **Adaptive chunk-size halving** under memory pressure
 *      (`checkMemoryPressure().shouldDegrade` → `chunkSize / 2`, floor 5).
 *   2. **Critical-abort** (`shouldAbort`) breaks the loop (DB-save what's done).
 *   3. **Per-chunk RSS budget break (C1)** — after each chunk's encode+persist,
 *      compare `process.memoryUsage().rss` delta against `PER_CHUNK_RSS_BUDGET_MB`
 *      (default 1536MB, strictly tighter than the 4096MB fork kill threshold so
 *      it fires FIRST). On overshoot the loop stops; remaining chunks are durable
 *      forward intent surfaced via the post-Phase-5 backfill self-discovery.
 *   4. **Chunk-boundary `disposeEmbeddingPipeline()` + GC + event-loop yield**
 *      (transient intra-fork arena recovery — the `max(1, chunkCount)`
 *      intra-fork reload upper bound documented by
 *      `INV-PHASE5-SUBPHASE-NO-RELOAD-001` (b); RETAINED, never removed).
 *   5. **C3 partial-completion telemetry** surfaced to the parent for
 *      `audit_logs` + backfill enumeration.
 *
 * **fork count is UNCHANGED (still 9)**: this is fork-*internal* chunk encoding,
 * NOT fork sub-division — `INV-PHASE5-SUBPHASE-FORK-EXIT-001`'s `fork ≤ 9` CWE-770
 * cap is untouched, and the SEC per-page fork hard-cap concern is moot.
 *
 * **NO-RELOAD invariant stays GREEN**: this driver adds NO new
 * `disposeEmbeddingPipeline()` reloads beyond the existing chunk-boundary one,
 * and the C1 budget break can only STOP the loop EARLY (fewer reloads). The
 * intra-fork reload count remains the documented `max(1, chunkCount)` upper bound
 * (`INV-PHASE5-SUBPHASE-NO-RELOAD-001` (a) source-pin: 0 `terminateAndRespawn…`
 * calls; (b): chunk-boundary `disposeEmbeddingPipeline()` RETAINED).
 *
 * The C1/C4 telemetry semantics (`budgetExceededChunkIndex`,
 * `partialCompletion`, `idempotencyChunkSkippedCount`) are **category-agnostic**:
 * each text sub-phase already runs in its OWN per-sub-phase fork (ADR-0039
 * Decision 1), so the telemetry on `ctx.chunkedEncoderTelemetry` is naturally
 * per-sub-phase, and the parent's `text_child_memory_budget_exceeded_at_chunk_<n>`
 * / `partial_chunked_<n>_of_<total>` audit + backfill self-discovery
 * (`dispatchBackfillJobsForPage`, which re-queries `embedding IS NULL` rows per
 * category) does not depend on which sub-phase emitted the break.
 *
 * PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a 発動): 実機 CPU 検証で
 * 未 chunk / budget 未適用の text fork が 4096MB kill 閾値を超過 (`background_text`
 * delta=4711MB / 130 patterns、`motion_text` 4010MB) したため、生存していた
 * `part_text` (254 parts→2760MB) / `section_text` が共有する canonical pattern
 * (chunk-loop + chunk間 dispose + **per-chunk RSS budget break**) を本 module に
 * 抽出し、全 7 text sub-phase が同一 RSS 制御契約を消費する。fork 数は 9 のまま
 * 不変 (fork 内 chunk encoding であり fork 分割ではない)。NO-RELOAD INV は GREEN
 * 維持 (新規 reload を追加せず、C1 break は loop を早期停止するのみ)。
 *
 * @module workers/phases/phase-5-chunked-text-loop
 * @see  §Consequences #2a
 * @see phase-5-embedding.ts (processSectionTextEmbeddingChunks canonical origin)
 * @see tests/regression/standing/large-page/inv-phase5-subphase-no-reload-001.test.ts
 */

import { logger } from "../../utils/logger";
import {
  EMBEDDING_CHUNK_SIZE,
  PER_CHUNK_RSS_BUDGET_MB,
  checkMemoryPressure,
  tryGarbageCollect,
  extendJobLock,
  type EmbeddingPhaseParams,
  type ChunkedEncoderTelemetry,
} from "./types";
import type { LayoutEmbeddingService } from "../../services/layout-embedding.service";

/**
 * Minimal slice of the sub-phase context the chunked loop driver needs. A
 * structural subset of `EmbeddingSubPhaseContext` (declared in
 * `phase-5-embedding.ts`) so the driver does not depend on the full context
 * shape and stays independently importable / testable.
 */
export interface ChunkedTextLoopContext {
  job: EmbeddingPhaseParams["job"];
  effectiveToken: string;
  effectiveLockDuration: number;
  sharedLayoutEmbeddingService: Pick<LayoutEmbeddingService, "disposeEmbeddingPipeline">;
  chunkedEncoderTelemetry: ChunkedEncoderTelemetry;
}

/**
 * Per-chunk encode callback. Receives the slice of items for the current chunk,
 * the global chunk index (C1/C3 telemetry-aligned), and the item offset. The
 * callback owns the sub-phase-specific encode + persist (e.g.
 * `generateSectionEmbeddings`, `generateMotionEmbeddings`, per-item
 * `generateFromText`). It SHOULD record per-item failures as non-fatal
 * `embeddingFailedChunks` itself (mirroring legacy behaviour); a thrown error is
 * treated as a **chunk-level encode failure** (C3 failure-path partial-flush
 * prevention) — the driver invokes {@link ChunkedTextLoopOptions.onEncodeError}
 * (so the processor increments its own failure counter) and then stops the loop
 * when hardening is enabled (legacy: continues).
 */
export type EncodeChunkFn<TItem> = (
  chunkItems: TItem[],
  chunkIndex: number,
  offset: number
) => Promise<void>;

/**
 * Options for {@link runChunkedTextEmbeddingLoop}.
 */
export interface ChunkedTextLoopOptions<TItem> {
  /** All items to embed (already resolved; the loop slices into chunks). */
  items: TItem[];
  /** The per-chunk encode + persist callback (sub-phase-specific). */
  encodeChunk: EncodeChunkFn<TItem>;
  /**
   * Invoked when {@link encodeChunk} throws a chunk-level error (so the
   * processor increments its own `embeddingFailedChunks` counter — the driver's
   * minimal context has no access to the full result). The driver logs the error
   * itself; this hook is for the counter only. Optional (single-item degenerate
   * loops may omit it).
   */
  onEncodeError?: (chunkIndex: number, offset: number, error: unknown) => void;
  /** Lock-extend label (e.g. "embedding-motions"); also used in log lines. */
  lockLabel: string;
  /**
   * Whether the C1-C4 chunked-encoder hardening contracts are active for this
   * loop. Resolved once by the caller (via
   * `isPhase5TextChunkedEncoderHardenedEnabled()`) and threaded in so the driver
   * does not re-read the env per call. When `false`, the legacy loop runs (no C1
   * budget break, no C3 telemetry — chunk-boundary dispose still RETAINED).
   */
  hardeningEnabled: boolean;
  /**
   * C4 idempotency-on-retry: number of fully-covered head chunks to skip
   * (already persisted by a prior partial run). Default 0. Only `section_text`
   * computes this (DB COUNT(*) head-chunk skip); other sub-phases pass 0 (their
   * Prisma uniqueness still prevents duplicates on retry, and they have no
   * head-chunk skip semantics yet).
   */
  skippedHeadChunks?: number;
  /**
   * Initial chunk size. Defaults to `EMBEDDING_CHUNK_SIZE` (the universal e5
   * chunk size). `js_animation_text` overrides this with
   * `JS_ANIMATION_EMBEDDING_CHUNK_SIZE` (its historically separate, larger chunk
   * size). Adaptive halving floors at 5 regardless of the initial value.
   */
  initialChunkSize?: number;
  /**
   * PR-C1 (Layer 1) cold-load delta exclusion observability hook. Invoked once
   * with the loop-head chunk index (`chunkIndex === skippedHeadChunks`) when
   * that chunk is excluded from the C1 per-chunk RSS budget enforcement (the
   * e5-base ONNX cold-load delta is paid inside it). Optional, additive (no IPC
   * enum / telemetry-field change → no INV-SCHEMA-ENUM-004 4-site coupling). The
   * `INV-PHASE5-COLDLOAD-DELTA-EXCLUSION-001` standing test wires this to assert
   * the exclusion path executes deterministically; production callers may omit
   * it (the exclusion logic is internal to {@link processOneChunk}).
   *
   * @see ADR-0008 Amendment 1 §Decision 1 / FIND-IO-V0-M-01 / FIND-IO-V0-L-07
   */
  warmupChunkExcluded?: (chunkIndex: number) => void;
}

/** Loop-break reason (durable forward intent telemetry, C1/C3). */
type ChunkLoopBreakReason =
  | { kind: "budget_exceeded"; chunkIndex: number }
  | { kind: "encoding_failed"; chunkIndex: number };

/** `process.memoryUsage().rss` in whole MB. */
function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

/**
 * C2 chunk-boundary cleanup, run only when more chunks remain. The
 * `disposeEmbeddingPipeline()` is the RETAINED transient intra-fork recovery
 * (`max(1, chunkCount)` reload upper bound, INV-PHASE5-SUBPHASE-NO-RELOAD-001
 * (b)); `tryGarbageCollect()` invokes `global.gc()` under --expose-gc; the
 * `setImmediate` yields to the event loop for BullMQ heartbeats + IPC.
 */
async function disposeBetweenChunks(
  ctx: ChunkedTextLoopContext,
  offset: number,
  chunkSize: number,
  total: number
): Promise<void> {
  if (offset + chunkSize >= total) return;
  await ctx.sharedLayoutEmbeddingService.disposeEmbeddingPipeline();
  tryGarbageCollect();
  // Yield to event loop: allow BullMQ heartbeats and IPC between chunks.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Run the canonical chunked text-embedding loop with per-chunk RSS budget
 * enforcement (C1), adaptive chunk-size halving, chunk-boundary dispose+GC+yield,
 * and C3 partial-completion telemetry.
 *
 * Mutates `ctx.chunkedEncoderTelemetry` in place (`budgetExceededChunkIndex`,
 * `partialCompletion`) so the existing `runTextEmbeddingSubPhases` surfacing path
 * propagates it to the parent unchanged.
 *
 * Decomposed into the small `processOneChunk` step (encode + C1 budget check)
 * plus `disposeBetweenChunks` / `rssMb` helpers so each function stays CC ≤ 10
 * (machine-enforced — `pnpm lint` exit 0 is a real complexity guarantee).
 *
 * @param ctx     minimal sub-phase context (job/lock/dispose/telemetry)
 * @param options items + per-chunk encode callback + lock label + flags
 */
export async function runChunkedTextEmbeddingLoop<TItem>(
  ctx: ChunkedTextLoopContext,
  options: ChunkedTextLoopOptions<TItem>
): Promise<void> {
  const { items, lockLabel, hardeningEnabled } = options;
  const skippedHeadChunks = options.skippedHeadChunks ?? 0;

  if (items.length === 0) return;

  // C1: clamp chunk size to the configured upper bound (default
  // EMBEDDING_CHUNK_SIZE; js_animation_text overrides with the larger
  // JS_ANIMATION_EMBEDDING_CHUNK_SIZE). Adaptive halving floors at 5.
  let chunkSize = options.initialChunkSize ?? EMBEDDING_CHUNK_SIZE;

  // C2: streaming flush ordering invariant maintained by the single-threaded
  // await chain. Track totalChunks lazily because adaptive halving may change it.
  let totalChunksObserved = Math.ceil(items.length / chunkSize);

  // C4: skip head chunks already persisted by a prior partial run; normalize
  // chunkIndex to match offset so telemetry chunk indexes are global.
  let offset = skippedHeadChunks * chunkSize;
  let chunkIndex = skippedHeadChunks;
  let breakReason: ChunkLoopBreakReason | null = null;

  while (offset < items.length) {
    const memCheck = checkMemoryPressure();
    if (memCheck.shouldAbort) {
      logger.warn(`[PageAnalyzeWorker] Critical memory, stopping ${lockLabel} embedding`, {
        rssMb: memCheck.rssMb,
      });
      break;
    }
    if (memCheck.shouldDegrade) {
      chunkSize = Math.max(5, Math.floor(chunkSize / 2));
      totalChunksObserved = chunkIndex + Math.ceil((items.length - offset) / chunkSize);
      logger.warn(`[PageAnalyzeWorker] Memory pressure, reducing ${lockLabel} chunk size`, {
        rssMb: memCheck.rssMb,
        newChunkSize: chunkSize,
      });
    }

    const chunkItems = items.slice(offset, offset + chunkSize);
    await extendJobLock(ctx.job, ctx.effectiveToken, ctx.effectiveLockDuration, lockLabel);

    breakReason = await processOneChunk(options, chunkItems, chunkIndex, offset, skippedHeadChunks);
    if (breakReason !== null) {
      // C1 vs C3 chunksDone semantics (preserve the original section_text
      // contract): a `budget_exceeded` break occurs AFTER the chunk's persist
      // completed (durable forward intent) → count it (chunkIndex++). An
      // `encoding_failed` break occurs because the chunk's persist did NOT
      // complete → do NOT count it (chunkIndex unchanged).
      if (breakReason.kind === "budget_exceeded") chunkIndex++;
      break;
    }

    await disposeBetweenChunks(ctx, offset, chunkSize, items.length);
    offset += chunkSize;
    chunkIndex++;
  }

  surfaceTelemetry(ctx, hardeningEnabled, breakReason, chunkIndex, totalChunksObserved);

  // PR-BT-5 (M-1-RSS, ADR-0039 Decision 2): the sub-phase-tail
  // `terminateAndRespawnEmbeddingPipeline()` is REMOVED from the fork-child path.
  // In the per-sub-phase fork model each sub-phase runs in its own fork that
  // `exit(0)`s, so the OS reclaims the whole arena at the fork boundary — the
  // inter-sub-phase reload (the M-1-RSS root cause) is rooted out by the fork
  // boundary. The intra-sub-phase chunk-boundary `disposeEmbeddingPipeline()`
  // (transient recovery, max(1, chunkCount) reload upper bound) is RETAINED in
  // `disposeBetweenChunks` above. Source-pinned by
  // INV-PHASE5-SUBPHASE-NO-RELOAD-001 (AST sweep: 0 call sites).
  tryGarbageCollect();
}

/**
 * Encode + persist ONE chunk, then run the C1 per-chunk RSS budget check.
 * Returns a {@link ChunkLoopBreakReason} when the loop must stop (chunk-level
 * encode failure under hardening, or per-chunk RSS budget overshoot), else null.
 *
 * **PR-C1 (Layer 1) cold-load delta exclusion (ADR-0008 Amendment 1 §Decision 1,
 * FIND-IO-V0-M-01)**: the **loop-head chunk** (`chunkIndex === skippedHeadChunks`)
 * is treated as a warm-up chunk and EXCLUDED from the C1 budget enforcement. On
 * CPU the e5-base ONNX cold-load (~1GB+) is synchronously paid inside the
 * loop-head chunk's encode; because `preChunkRssMb` is captured BEFORE that
 * cold-load, the loop-head `deltaMb` always carries the persistent cold-load
 * arena and would ALWAYS exceed `PER_CHUNK_RSS_BUDGET_MB (1536)` — a
 * false-positive that froze every site at "exactly 30". Excluding only the
 * loop-head chunk removes the cold-load false-positive while keeping the budget
 * break's true intent (arena floor accumulation defence) on every subsequent
 * chunk. `chunkIndex === skippedHeadChunks` (NOT a fixed index 0): on a retry
 * path with `skippedHeadChunks > 0`, the e5 ONNX session is re-initialized and
 * the cold-load lands on the post-skip loop-head chunk. `shouldAbort` (critical
 * memory, in the caller) still applies to the loop-head chunk; the process-wide
 * `PHASE5_CHILD_RSS_KILL_DELTA_MB = 4096` fork-kill backstop remains the
 * defence-in-depth for a truly anomalous loop-head arena (CWE-770, M-05).
 *
 * Extracted from the loop body so `runChunkedTextEmbeddingLoop` stays CC ≤ 10.
 */
async function processOneChunk<TItem>(
  options: ChunkedTextLoopOptions<TItem>,
  chunkItems: TItem[],
  chunkIndex: number,
  offset: number,
  skippedHeadChunks: number
): Promise<ChunkLoopBreakReason | null> {
  const { lockLabel, hardeningEnabled } = options;
  // C1: capture pre-chunk RSS before encode; compare delta post-persist.
  const preChunkRssMb = hardeningEnabled ? rssMb() : 0;

  try {
    await options.encodeChunk(chunkItems, chunkIndex, offset);
  } catch (encodeError) {
    // C3: failure-path partial-flush prevention. Chunks [0..chunkIndex-1] are
    // durable forward intent; remaining chunks are surfaced via backfill. The
    // processor increments its own embeddingFailedChunks via onEncodeError (the
    // driver's minimal context has no access to the full result).
    logger.warn(`[PageAnalyzeWorker] ${lockLabel} chunk encode failed (non-fatal)`, {
      chunkOffset: offset,
      chunkIndex,
      error: encodeError instanceof Error ? encodeError.message : String(encodeError),
    });
    options.onEncodeError?.(chunkIndex, offset, encodeError);
    // Legacy path (hardening disabled): continue to next chunk per prior behavior.
    return hardeningEnabled ? { kind: "encoding_failed", chunkIndex } : null;
  }

  // C1: per-chunk RSS budget check (post-persist). Delta-based (not absolute) to
  // avoid false positives from baseline drift. On overshoot, stop the loop
  // BEFORE the e5 arena accumulates past the 4096MB fork kill threshold.
  if (!hardeningEnabled) return null;

  // PR-C1: loop-head chunk (`chunkIndex === skippedHeadChunks`) carries the
  // e5-base ONNX cold-load delta — EXCLUDE it from the budget gate (always
  // proceed). Subsequent chunks enforce the budget normally.
  if (chunkIndex === skippedHeadChunks) {
    options.warmupChunkExcluded?.(chunkIndex);
    return null;
  }

  const deltaMb = rssMb() - preChunkRssMb;
  if (deltaMb <= PER_CHUNK_RSS_BUDGET_MB) return null;
  logger.warn(
    `[PageAnalyzeWorker] PR-V3-T1a C1 per-chunk RSS budget overshoot — stopping ${lockLabel} loop`,
    { chunkIndex, chunkOffset: offset, deltaMb, budgetMb: PER_CHUNK_RSS_BUDGET_MB }
  );
  return { kind: "budget_exceeded", chunkIndex };
}

/**
 * C1/C3: surface telemetry for the parent to emit audit_logs + drive backfill
 * enumeration. `chunksDone` = number of chunks whose persist completed durably.
 * Extracted so the main loop stays CC ≤ 10.
 */
function surfaceTelemetry(
  ctx: ChunkedTextLoopContext,
  hardeningEnabled: boolean,
  breakReason: ChunkLoopBreakReason | null,
  chunkIndex: number,
  totalChunksObserved: number
): void {
  if (!hardeningEnabled || breakReason === null || chunkIndex >= totalChunksObserved) return;
  ctx.chunkedEncoderTelemetry.partialCompletion = {
    chunksDone: chunkIndex,
    totalChunks: totalChunksObserved,
  };
  if (breakReason.kind === "budget_exceeded") {
    ctx.chunkedEncoderTelemetry.budgetExceededChunkIndex = breakReason.chunkIndex;
  }
}
