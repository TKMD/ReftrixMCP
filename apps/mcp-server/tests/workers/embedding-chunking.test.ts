// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Universal Embedding Chunking Tests
 *
 * チャンク化ロジックのユニットテスト:
 * - EMBEDDING_CHUNK_SIZE 定数が30であること
 * - DEFAULT_PIPELINE_RECYCLE_THRESHOLD が30であること
 * - Section/Motion/Background の各サブフェーズにチャンク化ループが存在すること
 * - チャンク間で disposeEmbeddingPipeline + tryGarbageCollect が呼ばれること
 * - メモリ圧力時にチャンクサイズが縮小されること（shouldDegrade → Math.max(5, floor(size/2))）
 * - shouldAbort 時にループが break されること
 * - チャンクごとに extendJobLock が呼ばれること
 * - 既存の JSAnimation チャンク化が維持されていること
 *
 * @module tests/workers/embedding-chunking
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Universal Embedding Chunking", () => {
  const typesPath = path.resolve(__dirname, "../../src/workers/phases/types.ts");
  const phase5Path = path.resolve(__dirname, "../../src/workers/phases/phase-5-embedding.ts");
  // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): the canonical
  // chunk loop was extracted into this shared driver — the chunk mechanics
  // (adaptive halving, chunk-boundary dispose+GC, C1 per-chunk RSS budget break)
  // now live here, not inline in each processor.
  const chunkLoopPath = path.resolve(
    __dirname,
    "../../src/workers/phases/phase-5-chunked-text-loop.ts"
  );
  const orchestratorPath = path.resolve(__dirname, "../../src/workers/page-analyze-worker.ts");
  const workerDbSavePath = path.resolve(__dirname, "../../src/services/worker-db-save.service.ts");
  const mlServicePath = path.resolve(
    __dirname,
    "../../../../packages/ml/src/embeddings/service.ts"
  );

  let workerSource: string;
  let chunkLoopSource: string;
  let mlServiceSource: string;

  beforeAll(() => {
    chunkLoopSource = fs.readFileSync(chunkLoopPath, "utf8");
    workerSource =
      fs.readFileSync(typesPath, "utf8") +
      "\n" +
      fs.readFileSync(phase5Path, "utf8") +
      "\n" +
      chunkLoopSource +
      "\n" +
      fs.readFileSync(orchestratorPath, "utf8") +
      "\n" +
      fs.readFileSync(workerDbSavePath, "utf8");
    mlServiceSource = fs.readFileSync(mlServicePath, "utf8");
  });

  // ==========================================================================
  // 定数の検証
  // ==========================================================================

  describe("constants", () => {
    it("EMBEDDING_CHUNK_SIZE should be derived from resolveMemoryConfig", () => {
      // 動的メモリプロファイルから取得されるようになった（旧: ハードコード 30）
      // types.ts: `export let EMBEDDING_CHUNK_SIZE = 30;` (初期値) + initMemoryConstants()内で再代入
      expect(workerSource).toContain("EMBEDDING_CHUNK_SIZE = config.embeddingChunkSize");
    });

    it("EMBEDDING_CHUNK_SIZE should be exported", () => {
      // エクスポートブロックに含まれていること
      const exportBlock = workerSource.slice(workerSource.lastIndexOf("export {"));
      expect(exportBlock).toContain("EMBEDDING_CHUNK_SIZE");
    });

    it("JS_ANIMATION_EMBEDDING_CHUNK_SIZE should be derived from resolveMemoryConfig", () => {
      // 動的メモリプロファイルから取得されるようになった（旧: ハードコード 50）
      // types.ts: `export let JS_ANIMATION_EMBEDDING_CHUNK_SIZE = 50;` (初期値) + initMemoryConstants()内で再代入
      expect(workerSource).toContain(
        "JS_ANIMATION_EMBEDDING_CHUNK_SIZE = config.jsAnimationEmbeddingChunkSize"
      );
    });

    it("DEFAULT_PIPELINE_RECYCLE_THRESHOLD should be 30", () => {
      expect(mlServiceSource).toContain("export const DEFAULT_PIPELINE_RECYCLE_THRESHOLD = 30");
    });

    it("EMBEDDING_CHUNK_SIZE can be imported and matches resolveMemoryConfig", async () => {
      const { EMBEDDING_CHUNK_SIZE } = await import("../../src/workers/page-analyze-worker");
      const { resolveMemoryConfig } = await import("../../src/services/worker-memory-profile");
      const config = resolveMemoryConfig();
      expect(EMBEDDING_CHUNK_SIZE).toBe(config.embeddingChunkSize);
    });
  });

  // ==========================================================================
  // Section Embedding チャンク化の構造検証
  // ==========================================================================

  // ==========================================================================
  // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): the canonical
  // chunk-loop mechanics were extracted into the shared
  // `runChunkedTextEmbeddingLoop` driver. The per-processor describe blocks below
  // now assert DELEGATION to the driver + the sub-phase-specific encode payload;
  // the chunk mechanics (adaptive halving, chunk-boundary dispose+GC, C1 budget
  // break) are asserted ONCE in the "shared chunked text-embedding loop driver"
  // block. The behavioral contract is preserved — it merely relocated.
  // ==========================================================================

  describe("shared chunked text-embedding loop driver (runChunkedTextEmbeddingLoop)", () => {
    it("should be defined as an exported driver function", () => {
      expect(chunkLoopSource).toContain("export async function runChunkedTextEmbeddingLoop");
    });

    it("should initialize chunk size from EMBEDDING_CHUNK_SIZE (default) with override support", () => {
      expect(chunkLoopSource).toContain("options.initialChunkSize ?? EMBEDDING_CHUNK_SIZE");
    });

    it("should call checkMemoryPressure before each chunk", () => {
      expect(chunkLoopSource).toContain("checkMemoryPressure()");
    });

    it("should reduce chunk size under memory pressure (min 5)", () => {
      expect(chunkLoopSource).toContain("Math.max(5, Math.floor(chunkSize / 2))");
    });

    it("should break on shouldAbort", () => {
      expect(chunkLoopSource).toContain("memCheck.shouldAbort");
      expect(chunkLoopSource).toContain("break");
    });

    it("should call extendJobLock per chunk with the sub-phase lock label", () => {
      expect(chunkLoopSource).toContain("extendJobLock(ctx.job");
      expect(chunkLoopSource).toContain("lockLabel");
    });

    it("should dispose pipeline and GC between chunks (retained intra-fork recovery)", () => {
      expect(chunkLoopSource).toContain("disposeEmbeddingPipeline()");
      expect(chunkLoopSource).toContain("tryGarbageCollect()");
    });

    it("should enforce the C1 per-chunk RSS budget break (PER_CHUNK_RSS_BUDGET_MB)", () => {
      // The decisive M-1-RSS chunk-fork contingency mechanism: stop the loop
      // BEFORE the e5 arena accumulates past the 4096MB fork kill threshold. The
      // budget comparison is expressed as an early-return guard
      // (`deltaMb <= PER_CHUNK_RSS_BUDGET_MB`) in the extracted processOneChunk
      // helper, then a budget_exceeded break reason on overshoot.
      expect(chunkLoopSource).toContain("PER_CHUNK_RSS_BUDGET_MB");
      expect(chunkLoopSource).toContain("deltaMb <= PER_CHUNK_RSS_BUDGET_MB");
      expect(chunkLoopSource).toContain('kind: "budget_exceeded"');
    });

    it("should surface C3 partial-completion telemetry on break", () => {
      expect(chunkLoopSource).toContain("ctx.chunkedEncoderTelemetry.partialCompletion");
      expect(chunkLoopSource).toContain("ctx.chunkedEncoderTelemetry.budgetExceededChunkIndex");
    });

    it("should yield to the event loop between chunks (setImmediate)", () => {
      expect(chunkLoopSource).toContain("setImmediate");
    });
  });

  describe("section embedding chunking (delegates to shared driver)", () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      // Refactored: section embedding logic is now in processSectionTextEmbeddingChunks
      const fnStart = workerSource.indexOf("async function processSectionTextEmbeddingChunks");
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 15000);
    });

    it("should delegate to runChunkedTextEmbeddingLoop with allSections", () => {
      expect(embeddingPhaseBody).toContain("runChunkedTextEmbeddingLoop(ctx, {");
      expect(embeddingPhaseBody).toContain("items: allSections");
      expect(embeddingPhaseBody).toContain('lockLabel: "embedding-sections"');
    });

    it("should thread the C4 head-chunk skip (skippedHeadChunks) into the driver", () => {
      expect(embeddingPhaseBody).toContain("skippedHeadChunks");
    });

    it("should create chunk idMapping subset for sections in the encode callback", () => {
      expect(embeddingPhaseBody).toContain("sectionSaveResult.idMapping.get(section.id)");
    });

    it("should accumulate results with += for sectionEmbeddingsGenerated", () => {
      expect(embeddingPhaseBody).toContain("ctx.result.sectionEmbeddingsGenerated +=");
    });
  });

  // ==========================================================================
  // Motion Embedding チャンク化の構造検証
  // ==========================================================================

  describe("motion embedding chunking (delegates to shared driver)", () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      // Refactored: motion embedding logic is now in processMotionTextEmbeddingChunks
      const fnStart = workerSource.indexOf("async function processMotionTextEmbeddingChunks");
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 15000);
    });

    it("should delegate to runChunkedTextEmbeddingLoop with allMotionPatterns", () => {
      expect(embeddingPhaseBody).toContain("runChunkedTextEmbeddingLoop(ctx, {");
      expect(embeddingPhaseBody).toContain("items: allMotionPatterns");
      expect(embeddingPhaseBody).toContain('lockLabel: "embedding-motions"');
    });

    it("should create chunk idMapping for motion patterns in the encode callback", () => {
      expect(embeddingPhaseBody).toContain("motionSaveResult.idMapping.get(pattern.id)");
    });

    it("should accumulate results with += for motionEmbeddingsGenerated", () => {
      expect(embeddingPhaseBody).toContain("ctx.result.motionEmbeddingsGenerated +=");
    });
  });

  // ==========================================================================
  // Vision-detected Motion Embedding チャンク化の構造検証
  // ==========================================================================

  describe("vision-detected motion embedding chunking (delegates to shared driver)", () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      // Refactored: vision-motion logic is now in processVisionMotionEmbeddingChunks
      const fnStart = workerSource.indexOf("async function processVisionMotionEmbeddingChunks");
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 15000);
    });

    it("should delegate to runChunkedTextEmbeddingLoop with visionPatterns", () => {
      expect(embeddingPhaseBody).toContain("runChunkedTextEmbeddingLoop(ctx, {");
      expect(embeddingPhaseBody).toContain("items: visionPatterns");
      expect(embeddingPhaseBody).toContain('lockLabel: "embedding-motions"');
    });

    it("should create chunk idMapping for vision-detected patterns in the encode callback", () => {
      expect(embeddingPhaseBody).toContain("scrollVisionSaveResult.idMapping.get(pattern.id)");
    });
  });

  // ==========================================================================
  // Background Embedding チャンク化の構造検証
  // ==========================================================================

  describe("background embedding chunking (delegates to shared driver)", () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      // Refactored: background logic is now in processBackgroundTextEmbeddingChunks
      const fnStart = workerSource.indexOf("async function processBackgroundTextEmbeddingChunks");
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 15000);
    });

    it("should delegate to runChunkedTextEmbeddingLoop with allBackgroundsForText", () => {
      expect(embeddingPhaseBody).toContain("runChunkedTextEmbeddingLoop(ctx, {");
      expect(embeddingPhaseBody).toContain("items: allBackgroundsForText");
      expect(embeddingPhaseBody).toContain('lockLabel: "embedding-backgrounds"');
    });

    it("should slice bgSaveResult.ids in sync with the chunk (offset + chunk length)", () => {
      // Adaptive chunk-size halving means the ids slice must realign by the
      // actual chunk length, not a fixed chunk size.
      expect(embeddingPhaseBody).toContain(
        "bgSaveResult.ids.slice(offset, offset + chunkBgs.length)"
      );
    });

    it("should accumulate results with += for bgEmbeddingsGenerated", () => {
      expect(embeddingPhaseBody).toContain("ctx.result.bgEmbeddingsGenerated +=");
    });

    it("should create chunk idMapping for backgrounds using bg.name in the encode callback", () => {
      expect(embeddingPhaseBody).toContain("bgSaveResult.idMapping.get(bg.name)");
    });
  });

  // ==========================================================================
  // サブフェーズ間の dispose+GC が維持されていること
  // ==========================================================================

  describe("inter-subphase terminate-and-respawn + GC preservation", () => {
    // PR-BT-5 (M-1-RSS, ADR-0039 Decision 2): the sub-phase-tail
    // `terminateAndRespawnEmbeddingPipeline()` was REMOVED from the fork-child
    // path (per-sub-phase fork → fork-boundary OS reclamation replaces it). The
    // OLD assertion ("each sub-phase ends with terminateAndRespawn") is now
    // INVALID and is replaced with the new contract: the call is ABSENT and the
    // GC retained. Source-pinned by INV-PHASE5-SUBPHASE-NO-RELOAD-001.
    it("should NOT terminateAndRespawn at any sub-phase ending (ADR-0039 Decision 2, removed from fork-child path)", () => {
      const subPhases = [
        "processSectionTextEmbeddingChunks",
        "processMotionTextEmbeddingChunks",
        "processVisionMotionEmbeddingChunks",
        "processBackgroundTextEmbeddingChunks",
        "processJsAnimationEmbeddingChunks",
        "processResponsiveEmbeddingChunks",
        "processPartTextEmbeddingChunks",
      ];

      for (const fn of subPhases) {
        const fnStart = workerSource.indexOf(`async function ${fn}`);
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = workerSource.slice(fnStart, fnStart + 15000);
        // The actual invocation `await ...terminateAndRespawnEmbeddingPipeline();`
        // must NOT appear (comment references like "...is REMOVED..." are not
        // invocations — match the call form, not the bare identifier).
        expect(fnBody).not.toMatch(
          /await\s+ctx\.sharedLayoutEmbeddingService\.terminateAndRespawnEmbeddingPipeline\(\)/
        );
        // Transient GC recovery is retained EITHER directly in the body
        // (responsive_text / part_text) OR via delegation to the shared driver
        // (which calls tryGarbageCollect — section/motion/vision/background/js).
        const retainsGc =
          fnBody.includes("tryGarbageCollect()") ||
          fnBody.includes("runChunkedTextEmbeddingLoop(ctx, {");
        expect(retainsGc, `${fn} must retain GC (direct or via shared driver)`).toBe(true);
      }
      // The shared driver retains the transient GC recovery (post-loop + between
      // chunks via disposeBetweenChunks).
      expect(chunkLoopSource).toContain("tryGarbageCollect()");
    });

    it("should delegate chunking to runChunkedTextEmbeddingLoop (dispose now lives in the shared driver)", () => {
      // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): the
      // chunk-boundary disposeEmbeddingPipeline() moved into the shared driver.
      // Each chunked sub-phase delegates to it; the dispose is asserted ONCE in
      // the shared-driver describe block above.
      const chunkedSubPhases = [
        "processSectionTextEmbeddingChunks",
        "processMotionTextEmbeddingChunks",
        "processVisionMotionEmbeddingChunks",
        "processBackgroundTextEmbeddingChunks",
        "processJsAnimationEmbeddingChunks",
        "processPartTextEmbeddingChunks",
      ];

      for (const fn of chunkedSubPhases) {
        const fnStart = workerSource.indexOf(`async function ${fn}`);
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = workerSource.slice(fnStart, fnStart + 15000);
        expect(fnBody).toContain("runChunkedTextEmbeddingLoop(ctx, {");
      }
      // The chunk-boundary dispose is retained in the shared driver.
      expect(chunkLoopSource).toContain("disposeEmbeddingPipeline()");
    });
  });

  // ==========================================================================
  // JSAnimation 既存チャンク化の維持確認
  // ==========================================================================

  describe("JSAnimation existing chunking preserved", () => {
    it("JS_ANIMATION_EMBEDDING_CHUNK_SIZE should be derived from resolveMemoryConfig", () => {
      // 動的メモリプロファイルから取得されるようになった（旧: ハードコード 50）
      // types.ts: `export let JS_ANIMATION_EMBEDDING_CHUNK_SIZE = 50;` (初期値) + initMemoryConstants()内で再代入
      expect(workerSource).toContain(
        "JS_ANIMATION_EMBEDDING_CHUNK_SIZE = config.jsAnimationEmbeddingChunkSize"
      );
    });

    it("should still use JS_ANIMATION_EMBEDDING_CHUNK_SIZE for JSAnimation chunking", () => {
      // PR-BT-5 chunk-fork contingency: js_animation_text now slices the
      // idMapping entries into chunks via runChunkedTextEmbeddingLoop, passing
      // JS_ANIMATION_EMBEDDING_CHUNK_SIZE as the initialChunkSize override (its
      // historically separate, larger chunk size is preserved).
      expect(workerSource).toContain("initialChunkSize: JS_ANIMATION_EMBEDDING_CHUNK_SIZE");
    });
  });

  // ==========================================================================
  // Pipeline Recycle Threshold の検証
  // ==========================================================================

  describe("pipeline recycle threshold", () => {
    it("DEFAULT_PIPELINE_RECYCLE_THRESHOLD should be 30", () => {
      expect(mlServiceSource).toContain("export const DEFAULT_PIPELINE_RECYCLE_THRESHOLD = 30");
    });

    it("threshold=30 comment should explain the rationale", () => {
      expect(mlServiceSource).toContain("threshold=30");
      expect(mlServiceSource).toContain("aligns with chunk size");
    });

    it("should reference universal embedding chunking in comments", () => {
      expect(mlServiceSource).toContain("universal embedding chunking");
    });

    it("DEFAULT_PIPELINE_RECYCLE_THRESHOLD can be imported", async () => {
      const { DEFAULT_PIPELINE_RECYCLE_THRESHOLD } =
        await import("../../../../packages/ml/src/embeddings/service");
      expect(DEFAULT_PIPELINE_RECYCLE_THRESHOLD).toBe(30);
    });
  });

  // ==========================================================================
  // メモリ圧力によるアダプティブチャンクサイズのロジック検証
  // ==========================================================================

  describe("adaptive chunk size logic (centralized in the shared driver)", () => {
    // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): the adaptive
    // halving logic, previously duplicated per sub-phase, is now centralized in
    // the shared `runChunkedTextEmbeddingLoop` driver (single source). All text
    // sub-phases inherit it by delegation, so the pattern appears exactly once.
    it("minimum chunk size should be 5 (Math.max(5, ...)) in the shared driver", () => {
      const matches = chunkLoopSource.match(/Math\.max\(5,\s*Math\.floor\(/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(1);
    });

    it("chunk size should halve on memory pressure in the shared driver", () => {
      expect(chunkLoopSource).toContain("Math.floor(chunkSize / 2)");
    });
  });

  // ==========================================================================
  // SEC-L1: JSAnimation の checkMemoryPressure 構造テスト
  // ==========================================================================

  describe("JSAnimation memory pressure handling (via shared driver)", () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      // Refactored: JS animation logic is now in processJsAnimationEmbeddingChunks
      const fnStart = workerSource.indexOf("async function processJsAnimationEmbeddingChunks");
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 15000);
    });

    it("should delegate to runChunkedTextEmbeddingLoop (memory pressure handled by driver)", () => {
      // PR-BT-5 chunk-fork contingency: js_animation_text now delegates its
      // chunking + memory-pressure handling to the shared driver. The
      // checkMemoryPressure / shouldAbort / shouldDegrade logic lives in the
      // driver (asserted in the shared-driver describe block).
      expect(embeddingPhaseBody).toContain("runChunkedTextEmbeddingLoop(ctx, {");
      expect(embeddingPhaseBody).toContain("items: jsEntries");
    });

    it("driver should call checkMemoryPressure and break on shouldAbort", () => {
      expect(chunkLoopSource).toContain("checkMemoryPressure()");
      expect(chunkLoopSource).toContain("memCheck.shouldAbort");
    });

    it("driver should handle shouldDegrade (adaptive chunk-size reduction)", () => {
      expect(chunkLoopSource).toContain("memCheck.shouldDegrade");
    });
  });

  // ==========================================================================
  // SEC-L2: チャンク境界値の安全性テスト
  // ==========================================================================

  describe("chunk boundary safety", () => {
    it("EMBEDDING_CHUNK_SIZE should be positive integer", async () => {
      // EMBEDDING_CHUNK_SIZE が正の整数であること
      const { EMBEDDING_CHUNK_SIZE } = await import("../../src/workers/page-analyze-worker");
      expect(EMBEDDING_CHUNK_SIZE).toBeGreaterThan(0);
      expect(Number.isInteger(EMBEDDING_CHUNK_SIZE)).toBe(true);
    });

    it("JS_ANIMATION_EMBEDDING_CHUNK_SIZE should be positive integer", async () => {
      // 動的メモリプロファイルから取得される値が正の整数であることを検証
      const { resolveMemoryConfig } = await import("../../src/services/worker-memory-profile");
      const config = resolveMemoryConfig();
      expect(config.jsAnimationEmbeddingChunkSize).toBeGreaterThan(0);
      expect(Number.isInteger(config.jsAnimationEmbeddingChunkSize)).toBe(true);
    });

    it("adaptive chunk minimum (5) should be less than EMBEDDING_CHUNK_SIZE", async () => {
      // 最小チャンクサイズ(5)が EMBEDDING_CHUNK_SIZE より小さいこと（縮小余地がある）
      const { EMBEDDING_CHUNK_SIZE } = await import("../../src/workers/page-analyze-worker");
      expect(5).toBeLessThan(EMBEDDING_CHUNK_SIZE);
    });

    it("Math.max(5, floor(size/2)) should always produce at least 5", () => {
      // 無限ループ防止: どのサイズでも最小5を保証するロジックの検証
      for (const size of [1, 2, 5, 10, 15, 30]) {
        const result = Math.max(5, Math.floor(size / 2));
        expect(result).toBeGreaterThanOrEqual(5);
      }
    });

    it("Array.slice handles boundary cases safely", () => {
      // チャンクスライスの境界ケースが安全であることの検証
      const arr = [1, 2, 3];
      // slice が配列長を超えても残りの要素を返す
      expect(arr.slice(0, 100)).toEqual([1, 2, 3]);
      // slice が配列長ちょうどから始まると空配列
      expect(arr.slice(3, 6)).toEqual([]);
      // 空配列の slice も安全
      expect([].slice(0, 30)).toEqual([]);
    });

    it("$executeRawUnsafe has parameter limit comment", () => {
      // PostgreSQL パラメータ上限65,535のコメントが存在すること
      // After TDA-C1 refactoring, parameter limit comment is in worker-db-save.service.ts
      expect(workerSource).toContain("PostgreSQL 65,535 bind parameter limit");
    });
  });

  // ==========================================================================
  // チャンク境界での dispose が最終チャンクをスキップすること
  // ==========================================================================

  describe("final chunk skip optimization (centralized in shared driver)", () => {
    // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): the
    // "skip dispose on the final chunk" optimization is centralized in the
    // shared driver (`offset + chunkSize < items.length`), so all delegating
    // sub-phases inherit it uniformly. Previously each processor had its own
    // `offset + <name>ChunkSize < all<Name>.length` guard.
    it("should skip dispose on the final chunk in the shared driver", () => {
      // disposeBetweenChunks early-returns when no more chunks remain
      // (`offset + chunkSize >= total`), so the final chunk skips the dispose.
      expect(chunkLoopSource).toContain("offset + chunkSize >= total");
    });
  });
});
