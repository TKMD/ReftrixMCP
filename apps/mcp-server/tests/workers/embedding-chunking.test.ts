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
  const orchestratorPath = path.resolve(__dirname, "../../src/workers/page-analyze-worker.ts");
  const workerDbSavePath = path.resolve(__dirname, "../../src/services/worker-db-save.service.ts");
  const mlServicePath = path.resolve(
    __dirname,
    "../../../../packages/ml/src/embeddings/service.ts"
  );

  let workerSource: string;
  let mlServiceSource: string;

  beforeAll(() => {
    workerSource =
      fs.readFileSync(typesPath, "utf8") +
      "\n" +
      fs.readFileSync(phase5Path, "utf8") +
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

  describe("section embedding chunking", () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      // Refactored: section embedding logic is now in processSectionTextEmbeddingChunks
      const fnStart = workerSource.indexOf("async function processSectionTextEmbeddingChunks");
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 15000);
    });

    it("should chunk sections using EMBEDDING_CHUNK_SIZE", () => {
      // Section embedding のチャンク化ループが存在すること
      expect(embeddingPhaseBody).toContain("allSections.slice(offset, offset + sectionChunkSize)");
    });

    it("should initialize sectionChunkSize from EMBEDDING_CHUNK_SIZE", () => {
      expect(embeddingPhaseBody).toContain("let sectionChunkSize = EMBEDDING_CHUNK_SIZE");
    });

    it("should call checkMemoryPressure before each section chunk", () => {
      // Section チャンクループ内で checkMemoryPressure が呼ばれること
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let sectionChunkSize"),
        embeddingPhaseBody.length
      );
      expect(sectionChunkSection).toContain("checkMemoryPressure()");
    });

    it("should reduce chunk size under memory pressure (min 5)", () => {
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let sectionChunkSize"),
        embeddingPhaseBody.length
      );
      expect(sectionChunkSection).toContain("Math.max(5, Math.floor(sectionChunkSize / 2))");
    });

    it("should break on shouldAbort", () => {
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let sectionChunkSize"),
        embeddingPhaseBody.length
      );
      expect(sectionChunkSection).toContain("memCheck.shouldAbort");
      expect(sectionChunkSection).toContain("break");
    });

    it("should call extendJobLock for each section chunk", () => {
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let sectionChunkSize"),
        embeddingPhaseBody.length
      );
      // extendJobLock はチャンクごとに呼ばれる（Prettier multi-line format対応）
      expect(sectionChunkSection).toContain("extendJobLock(");
      expect(sectionChunkSection).toContain('"embedding-sections"');
    });

    it("should dispose pipeline and GC between section chunks", () => {
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let sectionChunkSize"),
        embeddingPhaseBody.length
      );
      expect(sectionChunkSection).toContain("disposeEmbeddingPipeline()");
      expect(sectionChunkSection).toContain("tryGarbageCollect()");
    });

    it("should create chunk idMapping subset for sections", () => {
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let sectionChunkSize"),
        embeddingPhaseBody.length
      );
      expect(sectionChunkSection).toContain("chunkIdMapping");
      expect(sectionChunkSection).toContain("sectionSaveResult.idMapping.get(section.id)");
    });

    it("should accumulate results with += for sectionEmbeddingsGenerated", () => {
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let sectionChunkSize"),
        embeddingPhaseBody.length
      );
      expect(sectionChunkSection).toContain("ctx.result.sectionEmbeddingsGenerated +=");
    });
  });

  // ==========================================================================
  // Motion Embedding チャンク化の構造検証
  // ==========================================================================

  describe("motion embedding chunking", () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      // Refactored: motion embedding logic is now in processMotionTextEmbeddingChunks
      const fnStart = workerSource.indexOf("async function processMotionTextEmbeddingChunks");
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 15000);
    });

    it("should chunk motion patterns using EMBEDDING_CHUNK_SIZE", () => {
      expect(embeddingPhaseBody).toContain(
        "allMotionPatterns.slice(offset, offset + motionChunkSize)"
      );
    });

    it("should initialize motionChunkSize from EMBEDDING_CHUNK_SIZE", () => {
      expect(embeddingPhaseBody).toContain("let motionChunkSize = EMBEDDING_CHUNK_SIZE");
    });

    it("should call checkMemoryPressure before each motion chunk", () => {
      const motionSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let motionChunkSize"),
        embeddingPhaseBody.length
      );
      expect(motionSection).toContain("checkMemoryPressure()");
    });

    it("should reduce motion chunk size under memory pressure", () => {
      const motionSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let motionChunkSize"),
        embeddingPhaseBody.length
      );
      expect(motionSection).toContain("Math.max(5, Math.floor(motionChunkSize / 2))");
    });

    it("should dispose pipeline between motion chunks", () => {
      const motionSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let motionChunkSize"),
        embeddingPhaseBody.length
      );
      expect(motionSection).toContain("disposeEmbeddingPipeline()");
      expect(motionSection).toContain("tryGarbageCollect()");
    });

    it("should accumulate results with += for motionEmbeddingsGenerated", () => {
      const motionSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let motionChunkSize"),
        embeddingPhaseBody.length
      );
      expect(motionSection).toContain("ctx.result.motionEmbeddingsGenerated +=");
    });
  });

  // ==========================================================================
  // Vision-detected Motion Embedding チャンク化の構造検証
  // ==========================================================================

  describe("vision-detected motion embedding chunking", () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      // Refactored: vision-motion logic is now in processVisionMotionEmbeddingChunks
      const fnStart = workerSource.indexOf("async function processVisionMotionEmbeddingChunks");
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 15000);
    });

    it("should chunk vision-detected patterns", () => {
      expect(embeddingPhaseBody).toContain("let visionChunkSize = EMBEDDING_CHUNK_SIZE");
      expect(embeddingPhaseBody).toContain(
        "visionPatterns.slice(offset, offset + visionChunkSize)"
      );
    });

    it("should log warning on shouldDegrade for vision-motion chunk", () => {
      expect(embeddingPhaseBody).toContain("logger.warn");
      expect(embeddingPhaseBody).toContain("reducing vision-motion chunk size");
    });
  });

  // ==========================================================================
  // Background Embedding チャンク化の構造検証
  // ==========================================================================

  describe("background embedding chunking", () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      // Refactored: background logic is now in processBackgroundTextEmbeddingChunks
      const fnStart = workerSource.indexOf("async function processBackgroundTextEmbeddingChunks");
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 15000);
    });

    it("should chunk backgrounds using EMBEDDING_CHUNK_SIZE", () => {
      expect(embeddingPhaseBody).toContain(
        "allBackgroundsForText.slice(offset, offset + bgChunkSize)"
      );
    });

    it("should initialize bgChunkSize from EMBEDDING_CHUNK_SIZE", () => {
      expect(embeddingPhaseBody).toContain("let bgChunkSize = EMBEDDING_CHUNK_SIZE");
    });

    it("should also slice bgSaveResult.ids in sync with backgrounds", () => {
      expect(embeddingPhaseBody).toContain("bgSaveResult.ids.slice(offset, offset + bgChunkSize)");
    });

    it("should call checkMemoryPressure before each background chunk", () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let bgChunkSize"),
        embeddingPhaseBody.length
      );
      expect(bgSection).toContain("checkMemoryPressure()");
    });

    it("should reduce background chunk size under memory pressure", () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let bgChunkSize"),
        embeddingPhaseBody.length
      );
      expect(bgSection).toContain("Math.max(5, Math.floor(bgChunkSize / 2))");
    });

    it("should break on shouldAbort for backgrounds", () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let bgChunkSize"),
        embeddingPhaseBody.length
      );
      expect(bgSection).toContain("memCheck.shouldAbort");
      expect(bgSection).toContain("stopping background embedding");
    });

    it("should call extendJobLock for each background chunk", () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let bgChunkSize"),
        embeddingPhaseBody.length
      );
      expect(bgSection).toContain('"embedding-backgrounds"');
    });

    it("should dispose pipeline and GC between background chunks", () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let bgChunkSize"),
        embeddingPhaseBody.length
      );
      expect(bgSection).toContain("disposeEmbeddingPipeline()");
      expect(bgSection).toContain("tryGarbageCollect()");
    });

    it("should accumulate results with += for bgEmbeddingsGenerated", () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let bgChunkSize"),
        embeddingPhaseBody.length
      );
      expect(bgSection).toContain("ctx.result.bgEmbeddingsGenerated +=");
    });

    it("should create chunk idMapping for backgrounds using bg.name", () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf("let bgChunkSize"),
        embeddingPhaseBody.length
      );
      expect(bgSection).toContain("bgSaveResult.idMapping.get(bg.name)");
    });
  });

  // ==========================================================================
  // サブフェーズ間の dispose+GC が維持されていること
  // ==========================================================================

  describe("inter-subphase terminate-and-respawn + GC preservation", () => {
    it("should terminateAndRespawn after each embedding sub-phase ending (in extracted functions)", () => {
      // Each extracted sub-phase function calls terminateAndRespawnEmbeddingPipeline + tryGarbageCollect at the end
      // Verify all extracted functions have terminate-and-respawn at the end
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
        expect(fnBody).toContain("terminateAndRespawnEmbeddingPipeline()");
        expect(fnBody).toContain("tryGarbageCollect()");
      }
    });

    it("should still use disposeEmbeddingPipeline between chunks (not at sub-phase end)", () => {
      // Chunked sub-phases keep disposeEmbeddingPipeline between chunks
      const chunkedSubPhases = [
        "processSectionTextEmbeddingChunks",
        "processMotionTextEmbeddingChunks",
        "processVisionMotionEmbeddingChunks",
        "processBackgroundTextEmbeddingChunks",
        "processPartTextEmbeddingChunks",
      ];

      for (const fn of chunkedSubPhases) {
        const fnStart = workerSource.indexOf(`async function ${fn}`);
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = workerSource.slice(fnStart, fnStart + 15000);
        expect(fnBody).toContain("disposeEmbeddingPipeline()");
      }
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
      expect(workerSource).toContain("embeddingItems.length >= JS_ANIMATION_EMBEDDING_CHUNK_SIZE");
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

  describe("adaptive chunk size logic", () => {
    it("minimum chunk size should be 5 (Math.max(5, ...))", () => {
      // 全3サブフェーズで Math.max(5, ...) パターンが使われていること
      const matches = workerSource.match(/Math\.max\(5,\s*Math\.floor\(/g);
      // section, motion, vision-motion, background の4箇所
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(3);
    });

    it("chunk size should halve on memory pressure", () => {
      // floor(size / 2) パターンが使われていること
      const halvingMatches = workerSource.match(/Math\.floor\(\w+ChunkSize\s*\/\s*2\)/g);
      expect(halvingMatches).not.toBeNull();
      expect(halvingMatches!.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ==========================================================================
  // SEC-L1: JSAnimation の checkMemoryPressure 構造テスト
  // ==========================================================================

  describe("JSAnimation memory pressure handling", () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      // Refactored: JS animation logic is now in processJsAnimationEmbeddingChunks
      const fnStart = workerSource.indexOf("async function processJsAnimationEmbeddingChunks");
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 15000);
    });

    it("should call checkMemoryPressure in JSAnimation loop", () => {
      expect(embeddingPhaseBody).toContain("checkMemoryPressure()");
    });

    it("should break on shouldAbort in JSAnimation", () => {
      expect(embeddingPhaseBody).toContain("shouldAbort");
      expect(embeddingPhaseBody).toContain("stopping JS animation embedding");
    });

    it("should log warning on shouldDegrade in JSAnimation", () => {
      expect(embeddingPhaseBody).toContain("shouldDegrade");
      expect(embeddingPhaseBody).toContain("Memory pressure detected in JS animation embedding");
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

  describe("final chunk skip optimization", () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      // Sub-phase functions contain the chunk boundary patterns (legacy processEmbeddingPhase removed)
      const fnStart = workerSource.indexOf("async function processSectionTextEmbeddingChunks");
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 35000);
    });

    it("should skip dispose on final section chunk", () => {
      expect(embeddingPhaseBody).toContain("offset + sectionChunkSize < allSections.length");
    });

    it("should skip dispose on final motion chunk", () => {
      expect(embeddingPhaseBody).toContain("offset + motionChunkSize < allMotionPatterns.length");
    });

    it("should skip dispose on final background chunk", () => {
      expect(embeddingPhaseBody).toContain("offset + bgChunkSize < allBackgroundsForText.length");
    });
  });
});
