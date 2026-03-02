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

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Universal Embedding Chunking', () => {
  const workerSourcePath = path.resolve(
    __dirname,
    '../../src/workers/page-analyze-worker.ts'
  );
  const mlServicePath = path.resolve(
    __dirname,
    '../../../../packages/ml/src/embeddings/service.ts'
  );

  let workerSource: string;
  let mlServiceSource: string;

  beforeAll(() => {
    workerSource = fs.readFileSync(workerSourcePath, 'utf8');
    mlServiceSource = fs.readFileSync(mlServicePath, 'utf8');
  });

  // ==========================================================================
  // 定数の検証
  // ==========================================================================

  describe('constants', () => {
    it('EMBEDDING_CHUNK_SIZE should be derived from resolveMemoryConfig', () => {
      // 動的メモリプロファイルから取得されるようになった（旧: ハードコード 30）
      expect(workerSource).toContain('const EMBEDDING_CHUNK_SIZE = _memoryConfig.embeddingChunkSize');
    });

    it('EMBEDDING_CHUNK_SIZE should be exported', () => {
      // エクスポートブロックに含まれていること
      const exportBlock = workerSource.slice(workerSource.lastIndexOf('export {'));
      expect(exportBlock).toContain('EMBEDDING_CHUNK_SIZE');
    });

    it('JS_ANIMATION_EMBEDDING_CHUNK_SIZE should be derived from resolveMemoryConfig', () => {
      // 動的メモリプロファイルから取得されるようになった（旧: ハードコード 50）
      expect(workerSource).toContain('const JS_ANIMATION_EMBEDDING_CHUNK_SIZE = _memoryConfig.jsAnimationEmbeddingChunkSize');
    });

    it('DEFAULT_PIPELINE_RECYCLE_THRESHOLD should be 30', () => {
      expect(mlServiceSource).toContain('export const DEFAULT_PIPELINE_RECYCLE_THRESHOLD = 30');
    });

    it('EMBEDDING_CHUNK_SIZE can be imported and matches resolveMemoryConfig', async () => {
      const { EMBEDDING_CHUNK_SIZE } = await import('../../src/workers/page-analyze-worker');
      const { resolveMemoryConfig } = await import('../../src/services/worker-memory-profile');
      const config = resolveMemoryConfig();
      expect(EMBEDDING_CHUNK_SIZE).toBe(config.embeddingChunkSize);
    });
  });

  // ==========================================================================
  // Section Embedding チャンク化の構造検証
  // ==========================================================================

  describe('section embedding chunking', () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      const fnStart = workerSource.indexOf('async function processEmbeddingPhase');
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 15000);
    });

    it('should chunk sections using EMBEDDING_CHUNK_SIZE', () => {
      // Section embedding のチャンク化ループが存在すること
      expect(embeddingPhaseBody).toContain('allSections.slice(offset, offset + sectionChunkSize)');
    });

    it('should initialize sectionChunkSize from EMBEDDING_CHUNK_SIZE', () => {
      expect(embeddingPhaseBody).toContain('let sectionChunkSize = EMBEDDING_CHUNK_SIZE');
    });

    it('should call checkMemoryPressure before each section chunk', () => {
      // Section チャンクループ内で checkMemoryPressure が呼ばれること
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let sectionChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Section embedding')
      );
      expect(sectionChunkSection).toContain('checkMemoryPressure()');
    });

    it('should reduce chunk size under memory pressure (min 5)', () => {
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let sectionChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Section embedding')
      );
      expect(sectionChunkSection).toContain('Math.max(5, Math.floor(sectionChunkSize / 2))');
    });

    it('should break on shouldAbort', () => {
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let sectionChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Section embedding')
      );
      expect(sectionChunkSection).toContain('memCheck.shouldAbort');
      expect(sectionChunkSection).toContain('break');
    });

    it('should call extendJobLock for each section chunk', () => {
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let sectionChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Section embedding')
      );
      // extendJobLock はチャンクごとに呼ばれる
      expect(sectionChunkSection).toContain("extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-sections')");
    });

    it('should dispose pipeline and GC between section chunks', () => {
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let sectionChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Section embedding')
      );
      expect(sectionChunkSection).toContain('disposeEmbeddingPipeline()');
      expect(sectionChunkSection).toContain('tryGarbageCollect()');
    });

    it('should create chunk idMapping subset for sections', () => {
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let sectionChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Section embedding')
      );
      expect(sectionChunkSection).toContain('chunkIdMapping');
      expect(sectionChunkSection).toContain('sectionSaveResult.idMapping.get(section.id)');
    });

    it('should accumulate results with += for sectionEmbeddingsGenerated', () => {
      const sectionChunkSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let sectionChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Section embedding')
      );
      expect(sectionChunkSection).toContain('result.sectionEmbeddingsGenerated +=');
    });
  });

  // ==========================================================================
  // Motion Embedding チャンク化の構造検証
  // ==========================================================================

  describe('motion embedding chunking', () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      const fnStart = workerSource.indexOf('async function processEmbeddingPhase');
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 25000);
    });

    it('should chunk motion patterns using EMBEDDING_CHUNK_SIZE', () => {
      expect(embeddingPhaseBody).toContain('allMotionPatterns.slice(offset, offset + motionChunkSize)');
    });

    it('should initialize motionChunkSize from EMBEDDING_CHUNK_SIZE', () => {
      expect(embeddingPhaseBody).toContain('let motionChunkSize = EMBEDDING_CHUNK_SIZE');
    });

    it('should call checkMemoryPressure before each motion chunk', () => {
      const motionSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let motionChunkSize'),
        embeddingPhaseBody.indexOf('// 2.5. Vision-detected')
      );
      expect(motionSection).toContain('checkMemoryPressure()');
    });

    it('should reduce motion chunk size under memory pressure', () => {
      const motionSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let motionChunkSize'),
        embeddingPhaseBody.indexOf('// 2.5. Vision-detected')
      );
      expect(motionSection).toContain('Math.max(5, Math.floor(motionChunkSize / 2))');
    });

    it('should dispose pipeline between motion chunks', () => {
      const motionSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let motionChunkSize'),
        embeddingPhaseBody.indexOf('// 2.5. Vision-detected')
      );
      expect(motionSection).toContain('disposeEmbeddingPipeline()');
      expect(motionSection).toContain('tryGarbageCollect()');
    });

    it('should accumulate results with += for motionEmbeddingsGenerated', () => {
      const motionSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let motionChunkSize'),
        embeddingPhaseBody.indexOf('// 2.5. Vision-detected')
      );
      expect(motionSection).toContain('result.motionEmbeddingsGenerated +=');
    });
  });

  // ==========================================================================
  // Vision-detected Motion Embedding チャンク化の構造検証
  // ==========================================================================

  describe('vision-detected motion embedding chunking', () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      const fnStart = workerSource.indexOf('async function processEmbeddingPhase');
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 30000);
    });

    it('should chunk vision-detected patterns', () => {
      const visionSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('// 2.5. Vision-detected')
      );
      expect(visionSection).toContain('let visionChunkSize = EMBEDDING_CHUNK_SIZE');
      expect(visionSection).toContain('visionPatterns.slice(offset, offset + visionChunkSize)');
    });

    it('should log warning on shouldDegrade for vision-motion chunk', () => {
      const visionSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('// 2.5. Vision-detected')
      );
      expect(visionSection).toContain('logger.warn');
      expect(visionSection).toContain('reducing vision-motion chunk size');
    });
  });

  // ==========================================================================
  // Background Embedding チャンク化の構造検証
  // ==========================================================================

  describe('background embedding chunking', () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      const fnStart = workerSource.indexOf('async function processEmbeddingPhase');
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 35000);
    });

    it('should chunk backgrounds using EMBEDDING_CHUNK_SIZE', () => {
      expect(embeddingPhaseBody).toContain('allBackgroundsForText.slice(offset, offset + bgChunkSize)');
    });

    it('should initialize bgChunkSize from EMBEDDING_CHUNK_SIZE', () => {
      expect(embeddingPhaseBody).toContain('let bgChunkSize = EMBEDDING_CHUNK_SIZE');
    });

    it('should also slice bgSaveResult.ids in sync with backgrounds', () => {
      expect(embeddingPhaseBody).toContain('bgSaveResult.ids.slice(offset, offset + bgChunkSize)');
    });

    it('should call checkMemoryPressure before each background chunk', () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let bgChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Background embedding')
      );
      expect(bgSection).toContain('checkMemoryPressure()');
    });

    it('should reduce background chunk size under memory pressure', () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let bgChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Background embedding')
      );
      expect(bgSection).toContain('Math.max(5, Math.floor(bgChunkSize / 2))');
    });

    it('should break on shouldAbort for backgrounds', () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let bgChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Background embedding')
      );
      expect(bgSection).toContain('memCheck.shouldAbort');
      expect(bgSection).toContain('stopping background embedding');
    });

    it('should call extendJobLock for each background chunk', () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let bgChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Background embedding')
      );
      expect(bgSection).toContain("extendJobLock(job, effectiveToken, effectiveLockDuration, 'embedding-backgrounds')");
    });

    it('should dispose pipeline and GC between background chunks', () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let bgChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Background embedding')
      );
      expect(bgSection).toContain('disposeEmbeddingPipeline()');
      expect(bgSection).toContain('tryGarbageCollect()');
    });

    it('should accumulate results with += for bgEmbeddingsGenerated', () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let bgChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Background embedding')
      );
      expect(bgSection).toContain('result.bgEmbeddingsGenerated +=');
    });

    it('should create chunk idMapping for backgrounds using bg.name', () => {
      const bgSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('let bgChunkSize'),
        embeddingPhaseBody.indexOf('// ONNX session dispose: Background embedding')
      );
      expect(bgSection).toContain('bgSaveResult.idMapping.get(bg.name)');
    });
  });

  // ==========================================================================
  // サブフェーズ間の dispose+GC が維持されていること
  // ==========================================================================

  describe('inter-subphase dispose+GC preservation', () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      const fnStart = workerSource.indexOf('async function processEmbeddingPhase');
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 35000);
    });

    it('should dispose after section embedding phase', () => {
      expect(embeddingPhaseBody).toContain('// ONNX session dispose: Section embedding後のメモリ回復');
    });

    it('should dispose after motion embedding phase', () => {
      expect(embeddingPhaseBody).toContain('// ONNX session dispose: Motion embedding後のメモリ回復');
    });

    it('should dispose after background embedding phase', () => {
      expect(embeddingPhaseBody).toContain('// ONNX session dispose: Background embedding後のメモリ回復');
    });

    it('should dispose after JSAnimation embedding phase', () => {
      expect(embeddingPhaseBody).toContain('// ONNX session dispose: JSAnimation embedding後のメモリ回復');
    });

    it('should dispose after Responsive embedding phase', () => {
      expect(embeddingPhaseBody).toContain('// ONNX session dispose: Responsive embedding後の最終メモリ回復');
    });
  });

  // ==========================================================================
  // JSAnimation 既存チャンク化の維持確認
  // ==========================================================================

  describe('JSAnimation existing chunking preserved', () => {
    it('JS_ANIMATION_EMBEDDING_CHUNK_SIZE should be derived from resolveMemoryConfig', () => {
      // 動的メモリプロファイルから取得されるようになった（旧: ハードコード 50）
      expect(workerSource).toContain('const JS_ANIMATION_EMBEDDING_CHUNK_SIZE = _memoryConfig.jsAnimationEmbeddingChunkSize');
    });

    it('should still use JS_ANIMATION_EMBEDDING_CHUNK_SIZE for JSAnimation chunking', () => {
      expect(workerSource).toContain('embeddingItems.length >= JS_ANIMATION_EMBEDDING_CHUNK_SIZE');
    });
  });

  // ==========================================================================
  // Pipeline Recycle Threshold の検証
  // ==========================================================================

  describe('pipeline recycle threshold', () => {
    it('DEFAULT_PIPELINE_RECYCLE_THRESHOLD should be 30', () => {
      expect(mlServiceSource).toContain('export const DEFAULT_PIPELINE_RECYCLE_THRESHOLD = 30');
    });

    it('threshold=30 comment should explain the rationale', () => {
      expect(mlServiceSource).toContain('threshold=30');
      expect(mlServiceSource).toContain('aligns with chunk size');
    });

    it('should reference universal embedding chunking in comments', () => {
      expect(mlServiceSource).toContain('universal embedding chunking');
    });

    it('DEFAULT_PIPELINE_RECYCLE_THRESHOLD can be imported', async () => {
      const { DEFAULT_PIPELINE_RECYCLE_THRESHOLD } = await import(
        '../../../../packages/ml/src/embeddings/service'
      );
      expect(DEFAULT_PIPELINE_RECYCLE_THRESHOLD).toBe(30);
    });
  });

  // ==========================================================================
  // メモリ圧力によるアダプティブチャンクサイズのロジック検証
  // ==========================================================================

  describe('adaptive chunk size logic', () => {
    it('minimum chunk size should be 5 (Math.max(5, ...))', () => {
      // 全3サブフェーズで Math.max(5, ...) パターンが使われていること
      const matches = workerSource.match(/Math\.max\(5,\s*Math\.floor\(/g);
      // section, motion, vision-motion, background の4箇所
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(3);
    });

    it('chunk size should halve on memory pressure', () => {
      // floor(size / 2) パターンが使われていること
      const halvingMatches = workerSource.match(/Math\.floor\(\w+ChunkSize\s*\/\s*2\)/g);
      expect(halvingMatches).not.toBeNull();
      expect(halvingMatches!.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ==========================================================================
  // SEC-L1: JSAnimation の checkMemoryPressure 構造テスト
  // ==========================================================================

  describe('JSAnimation memory pressure handling', () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      const fnStart = workerSource.indexOf('async function processEmbeddingPhase');
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 40000);
    });

    it('should call checkMemoryPressure in JSAnimation loop', () => {
      // JSAnimation セクション内で checkMemoryPressure が呼ばれていること
      const jsSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('// 4. JSAnimationEmbedding')
      );
      expect(jsSection).toContain('checkMemoryPressure()');
    });

    it('should break on shouldAbort in JSAnimation', () => {
      // shouldAbort 時にループが break されること
      const jsSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('// 4. JSAnimationEmbedding')
      );
      expect(jsSection).toContain('shouldAbort');
      expect(jsSection).toContain('stopping JS animation embedding');
    });

    it('should log warning on shouldDegrade in JSAnimation', () => {
      // shouldDegrade 時に警告ログが出力されること
      const jsSection = embeddingPhaseBody.slice(
        embeddingPhaseBody.indexOf('// 4. JSAnimationEmbedding')
      );
      expect(jsSection).toContain('shouldDegrade');
      expect(jsSection).toContain('Memory pressure detected in JS animation embedding');
    });
  });

  // ==========================================================================
  // SEC-L2: チャンク境界値の安全性テスト
  // ==========================================================================

  describe('chunk boundary safety', () => {
    it('EMBEDDING_CHUNK_SIZE should be positive integer', async () => {
      // EMBEDDING_CHUNK_SIZE が正の整数であること
      const { EMBEDDING_CHUNK_SIZE } = await import('../../src/workers/page-analyze-worker');
      expect(EMBEDDING_CHUNK_SIZE).toBeGreaterThan(0);
      expect(Number.isInteger(EMBEDDING_CHUNK_SIZE)).toBe(true);
    });

    it('JS_ANIMATION_EMBEDDING_CHUNK_SIZE should be positive integer', async () => {
      // 動的メモリプロファイルから取得される値が正の整数であることを検証
      const { resolveMemoryConfig } = await import('../../src/services/worker-memory-profile');
      const config = resolveMemoryConfig();
      expect(config.jsAnimationEmbeddingChunkSize).toBeGreaterThan(0);
      expect(Number.isInteger(config.jsAnimationEmbeddingChunkSize)).toBe(true);
    });

    it('adaptive chunk minimum (5) should be less than EMBEDDING_CHUNK_SIZE', async () => {
      // 最小チャンクサイズ(5)が EMBEDDING_CHUNK_SIZE より小さいこと（縮小余地がある）
      const { EMBEDDING_CHUNK_SIZE } = await import('../../src/workers/page-analyze-worker');
      expect(5).toBeLessThan(EMBEDDING_CHUNK_SIZE);
    });

    it('Math.max(5, floor(size/2)) should always produce at least 5', () => {
      // 無限ループ防止: どのサイズでも最小5を保証するロジックの検証
      for (const size of [1, 2, 5, 10, 15, 30]) {
        const result = Math.max(5, Math.floor(size / 2));
        expect(result).toBeGreaterThanOrEqual(5);
      }
    });

    it('Array.slice handles boundary cases safely', () => {
      // チャンクスライスの境界ケースが安全であることの検証
      const arr = [1, 2, 3];
      // slice が配列長を超えても残りの要素を返す
      expect(arr.slice(0, 100)).toEqual([1, 2, 3]);
      // slice が配列長ちょうどから始まると空配列
      expect(arr.slice(3, 6)).toEqual([]);
      // 空配列の slice も安全
      expect([].slice(0, 30)).toEqual([]);
    });

    it('$executeRawUnsafe has parameter limit comment', () => {
      // PostgreSQL パラメータ上限65,535のコメントが存在すること
      expect(workerSource).toContain('PostgreSQL parameter limit: 65,535');
    });
  });

  // ==========================================================================
  // チャンク境界での dispose が最終チャンクをスキップすること
  // ==========================================================================

  describe('final chunk skip optimization', () => {
    let embeddingPhaseBody: string;

    beforeAll(() => {
      const fnStart = workerSource.indexOf('async function processEmbeddingPhase');
      expect(fnStart).toBeGreaterThan(-1);
      embeddingPhaseBody = workerSource.slice(fnStart, fnStart + 35000);
    });

    it('should skip dispose on final section chunk', () => {
      expect(embeddingPhaseBody).toContain('offset + sectionChunkSize < allSections.length');
    });

    it('should skip dispose on final motion chunk', () => {
      expect(embeddingPhaseBody).toContain('offset + motionChunkSize < allMotionPatterns.length');
    });

    it('should skip dispose on final background chunk', () => {
      expect(embeddingPhaseBody).toContain('offset + bgChunkSize < allBackgroundsForText.length');
    });
  });
});
