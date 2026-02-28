// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - Embedding Phase Extraction Tests
 *
 * TDD Red: processEmbeddingPhase が独立関数として抽出されていることを検証。
 * ソースコード解析による構造テスト + 型・インターフェーステスト。
 *
 * @module tests/workers/page-analyze-worker-embedding-phase
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('PageAnalyzeWorker - Embedding Phase Extraction', () => {
  const workerSourcePath = path.resolve(
    __dirname,
    '../../src/workers/page-analyze-worker.ts'
  );

  let workerSource: string;

  beforeAll(() => {
    workerSource = fs.readFileSync(workerSourcePath, 'utf8');
  });

  // ==========================================================================
  // processEmbeddingPhase 関数の存在確認
  // ==========================================================================

  describe('processEmbeddingPhase function', () => {
    it('should define processEmbeddingPhase as an exported async function', () => {
      expect(workerSource).toContain('export async function processEmbeddingPhase');
    });

    it('should accept EmbeddingPhaseParams as parameter', () => {
      expect(workerSource).toContain('EmbeddingPhaseParams');
    });

    it('should return EmbeddingPhaseResult', () => {
      expect(workerSource).toContain('EmbeddingPhaseResult');
    });
  });

  // ==========================================================================
  // EmbeddingPhaseParams / EmbeddingPhaseResult 型定義
  // ==========================================================================

  describe('type definitions', () => {
    it('should define EmbeddingPhaseParams interface', () => {
      expect(workerSource).toMatch(/(?:interface|type)\s+EmbeddingPhaseParams/);
    });

    it('should define EmbeddingPhaseResult interface', () => {
      expect(workerSource).toMatch(/(?:interface|type)\s+EmbeddingPhaseResult/);
    });

    it('EmbeddingPhaseParams should include webPageId', () => {
      // webPageId は embedding phase に必須
      const paramsSection = workerSource.slice(
        workerSource.indexOf('EmbeddingPhaseParams'),
        workerSource.indexOf('EmbeddingPhaseParams') + 1500
      );
      expect(paramsSection).toContain('webPageId');
    });

    it('EmbeddingPhaseResult should include embedding counts', () => {
      const resultSection = workerSource.slice(
        workerSource.indexOf('EmbeddingPhaseResult'),
        workerSource.indexOf('EmbeddingPhaseResult') + 800
      );
      expect(resultSection).toContain('sectionEmbeddingsGenerated');
      expect(resultSection).toContain('motionEmbeddingsGenerated');
    });
  });

  // ==========================================================================
  // processPageAnalyzeJob からの呼び出し
  // ==========================================================================

  describe('integration with processPageAnalyzeJob', () => {
    it('processPageAnalyzeJob should call processEmbeddingPhase', () => {
      const fnStart = workerSource.indexOf('function processPageAnalyzeJob');
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart);
      expect(fnBody).toContain('processEmbeddingPhase');
    });
  });

  // ==========================================================================
  // Lock extension within embedding phase
  // ==========================================================================

  describe('lock extension in embedding phase', () => {
    it('processEmbeddingPhase should call extendJobLock for sub-phases', () => {
      const fnStart = workerSource.indexOf('async function processEmbeddingPhase');
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 25000);
      expect(fnBody).toContain("extendJobLock");
      expect(fnBody).toContain("'embedding-sections'");
      expect(fnBody).toContain("'embedding-motions'");
      expect(fnBody).toContain("'embedding-backgrounds'");
      expect(fnBody).toContain("'embedding-js-animations'");
    });
  });
});
