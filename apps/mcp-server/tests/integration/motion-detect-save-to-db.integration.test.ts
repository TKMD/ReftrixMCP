// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect save_to_db 統合テスト
 *
 * ファクトリ登録からハンドラ実行までのエンドツーエンドテスト
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  setMotionPersistenceServiceFactory,
  resetMotionPersistenceServiceFactory,
  motionDetectHandler,
} from '../../src/tools/motion';
import {
  MotionPatternPersistenceService,
  setMotionPersistenceEmbeddingServiceFactory,
  setMotionPersistencePrismaClientFactory,
  resetMotionPersistenceEmbeddingServiceFactory,
  resetMotionPersistencePrismaClientFactory,
  resetMotionPersistenceService,
  type IEmbeddingService,
  type IPrismaClient,
} from '../../src/services/motion-persistence.service';

// モックファクトリ
const createMockEmbeddingService = (): IEmbeddingService => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
});

const createMockPrismaClient = (): IPrismaClient => ({
  motionPattern: {
    create: vi.fn().mockResolvedValue({ id: 'mock-pattern-id' }),
  },
  motionEmbedding: {
    create: vi.fn().mockResolvedValue({ id: 'mock-embedding-id' }),
  },
  $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  $transaction: vi.fn().mockImplementation((fn) => fn(createMockPrismaClient())),
});

describe('motion.detect save_to_db 統合テスト', () => {
  beforeAll(() => {
    // ファクトリをリセット
    resetMotionPersistenceServiceFactory();
    resetMotionPersistenceEmbeddingServiceFactory();
    resetMotionPersistencePrismaClientFactory();
    resetMotionPersistenceService();
  });

  afterAll(() => {
    // ファクトリをリセット
    resetMotionPersistenceServiceFactory();
    resetMotionPersistenceEmbeddingServiceFactory();
    resetMotionPersistencePrismaClientFactory();
    resetMotionPersistenceService();
  });

  describe('ファクトリ未登録時のハンドラ実行', () => {
    it('save_to_db=true でもエラーにならず saved=false を返す', async () => {
      const result = await motionDetectHandler({
        html: `
          <style>
            @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
            .test { animation: fadeIn 0.3s ease-out; }
          </style>
          <div class="test">Test</div>
        `,
        save_to_db: true,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThan(0);
        // ファクトリ未登録なので保存されない
        expect(result.data.saveResult).toBeDefined();
        expect(result.data.saveResult?.saved).toBe(false);
        expect(result.data.saveResult?.savedCount).toBe(0);
      }
    });
  });

  describe('ファクトリ登録後のハンドラ実行', () => {
    beforeAll(() => {
      // index.ts と同じ順序でファクトリを登録
      const mockEmbedding = createMockEmbeddingService();
      const mockPrisma = createMockPrismaClient();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);
      setMotionPersistenceServiceFactory(() => new MotionPatternPersistenceService());
    });

    afterAll(() => {
      resetMotionPersistenceServiceFactory();
      resetMotionPersistenceEmbeddingServiceFactory();
      resetMotionPersistencePrismaClientFactory();
      resetMotionPersistenceService();
    });

    it('save_to_db=true で正しく保存される', async () => {
      const result = await motionDetectHandler({
        html: `
          <style>
            @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
            .test { animation: fadeIn 0.3s ease-out; }
          </style>
          <div class="test">Test</div>
        `,
        save_to_db: true,
        detection_mode: 'css' as const,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThan(0);
        // ファクトリ登録済みなので保存される
        expect(result.data.saveResult).toBeDefined();
        expect(result.data.saveResult?.saved).toBe(true);
        expect(result.data.saveResult?.savedCount).toBeGreaterThan(0);
      }
    });
  });

  describe('MotionPatternPersistenceService インスタンス状態', () => {
    it('ファクトリ登録後、新しいインスタンスで isAvailable() が true を返す', () => {
      // リセット
      resetMotionPersistenceEmbeddingServiceFactory();
      resetMotionPersistencePrismaClientFactory();
      resetMotionPersistenceService();

      // ファクトリを登録
      setMotionPersistenceEmbeddingServiceFactory(createMockEmbeddingService);
      setMotionPersistencePrismaClientFactory(createMockPrismaClient);

      // 新しいインスタンスを作成
      const service = new MotionPatternPersistenceService();

      // isAvailable() は true を返す
      expect(service.isAvailable()).toBe(true);
    });
  });
});
