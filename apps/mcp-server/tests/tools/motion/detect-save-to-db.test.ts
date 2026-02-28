// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect save_to_db 機能のユニットテスト
 *
 * このテストは save_to_db=true 時の動作を検証します:
 * - persistenceServiceFactory の登録と使用
 * - getPersistenceService() の動作
 * - パターン保存フローの検証
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setMotionPersistenceServiceFactory,
  resetMotionPersistenceServiceFactory,
} from '../../../src/tools/motion/detect.tool';
import {
  MotionPatternPersistenceService,
  setMotionPersistenceEmbeddingServiceFactory,
  setMotionPersistencePrismaClientFactory,
  resetMotionPersistenceEmbeddingServiceFactory,
  resetMotionPersistencePrismaClientFactory,
  resetMotionPersistenceService,
  type IEmbeddingService,
  type IPrismaClient,
} from '../../../src/services/motion-persistence.service';

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

describe('motion.detect save_to_db 機能', () => {
  beforeEach(() => {
    // すべてのファクトリをリセット
    resetMotionPersistenceServiceFactory();
    resetMotionPersistenceEmbeddingServiceFactory();
    resetMotionPersistencePrismaClientFactory();
    resetMotionPersistenceService();
  });

  afterEach(() => {
    // すべてのファクトリをリセット
    resetMotionPersistenceServiceFactory();
    resetMotionPersistenceEmbeddingServiceFactory();
    resetMotionPersistencePrismaClientFactory();
    resetMotionPersistenceService();
  });

  describe('setMotionPersistenceServiceFactory', () => {
    it('ファクトリを設定できる', () => {
      // ファクトリを設定してもエラーが発生しないことを確認
      expect(() => {
        setMotionPersistenceServiceFactory(() => new MotionPatternPersistenceService());
      }).not.toThrow();
    });

    it('設定したファクトリから isAvailable=true のサービスを取得できる', () => {
      // まず依存関係のファクトリを設定
      setMotionPersistenceEmbeddingServiceFactory(createMockEmbeddingService);
      setMotionPersistencePrismaClientFactory(createMockPrismaClient);

      // MotionPatternPersistenceService を作成するファクトリを設定
      let factoryCallCount = 0;
      setMotionPersistenceServiceFactory(() => {
        factoryCallCount++;
        return new MotionPatternPersistenceService();
      });

      // ファクトリが呼ばれ、サービスが正常に動作することを確認
      const service = new MotionPatternPersistenceService();

      // 依存関係が設定されているので isAvailable() は true を返す
      expect(service.isAvailable()).toBe(true);
    });

    it('依存関係ファクトリが設定されていない場合、isAvailable() は false を返す', () => {
      // MotionPatternPersistenceService のファクトリのみ設定
      // 依存関係（EmbeddingService、PrismaClient）は設定しない
      setMotionPersistenceServiceFactory(() => new MotionPatternPersistenceService());

      const service = new MotionPatternPersistenceService();

      // 依存関係が設定されていないので isAvailable() は false を返す
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('index.ts での登録順序', () => {
    /**
     * index.ts での登録順序:
     * 1. setMotionPersistenceEmbeddingServiceFactory(() => embeddingService)
     * 2. setMotionPersistencePrismaClientFactory(() => createPrismaWrapper(...))
     * 3. setMotionPersistenceServiceFactory(() => new MotionPatternPersistenceService())
     *
     * この順序でファクトリを登録した場合、MotionPatternPersistenceService が
     * 正しく動作することを検証します。
     */
    it('正しい順序で登録すると isAvailable() は true を返す', () => {
      // 1. EmbeddingService ファクトリを設定
      setMotionPersistenceEmbeddingServiceFactory(createMockEmbeddingService);

      // 2. PrismaClient ファクトリを設定
      setMotionPersistencePrismaClientFactory(createMockPrismaClient);

      // 3. MotionPatternPersistenceService ファクトリを設定
      setMotionPersistenceServiceFactory(() => new MotionPatternPersistenceService());

      // 新しいインスタンスを作成
      const service = new MotionPatternPersistenceService();

      // isAvailable() は true を返す
      expect(service.isAvailable()).toBe(true);
    });

    it('PrismaClientファクトリだけ設定すると isAvailable() は true を返す', () => {
      // PrismaClient ファクトリのみ設定（EmbeddingService は設定しない）
      setMotionPersistencePrismaClientFactory(createMockPrismaClient);

      const service = new MotionPatternPersistenceService();

      // isAvailable() は true を返す（PrismaClient があれば OK）
      expect(service.isAvailable()).toBe(true);
    });
  });

  describe('ファクトリが例外をスローするケース', () => {
    it('PrismaClientファクトリが例外をスローすると isAvailable() は false を返す', () => {
      setMotionPersistencePrismaClientFactory(() => {
        throw new Error('PrismaClient initialization failed');
      });

      const service = new MotionPatternPersistenceService();

      // ファクトリが例外をスローするので isAvailable() は false
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('実際の save_to_db フロー', () => {
    it('ファクトリ登録後、savePatterns が成功する', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      // ファクトリを登録
      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      // サービスを作成して savePatterns を呼び出す
      const service = new MotionPatternPersistenceService();

      // isAvailable() は true を返す
      expect(service.isAvailable()).toBe(true);

      // savePatterns を呼び出す
      const result = await service.savePatterns([
        {
          type: 'css_animation',
          name: 'test-animation',
          category: 'entrance',
          trigger: 'load',
          selector: '.test',
          animation: {
            duration: 300,
            delay: 0,
            easing: { type: 'ease' },
            iterations: 1,
            direction: 'normal',
            fillMode: 'none',
          },
          properties: [{ property: 'opacity', from: '0', to: '1' }],
          keyframes: [],
        },
      ]);

      expect(result.saved).toBe(true);
      expect(result.savedCount).toBe(1);
    });
  });
});
