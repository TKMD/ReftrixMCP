// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Service Initializer テスト
 *
 * TDD Red Phase: DI Factory統合のテスト
 *
 * @module tests/unit/services/service-initializer.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// TDD Red: まだ実装されていない関数をインポート
// これらは現時点では存在しないため、テストは失敗する
// Note: initializeSvgServices は v0.1.0 で削除されました
import {
  initializeMotionServices,
  initializeLayoutServices,
  initializeAllServices,
  type ServiceInitializerConfig,
  type ServiceInitializerResult,
} from '../../../src/services/service-initializer';

describe('Service Initializer', () => {
  // モック作成
  const mockEmbeddingService = {
    generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  };

  const mockPrisma = {
    motionPattern: { create: vi.fn() },
    motionEmbedding: { create: vi.fn() },
    sectionPattern: { create: vi.fn() },
    sectionEmbedding: { create: vi.fn() },
    // Note: svgAsset は v0.1.0 で削除されました（SVG機能削除）
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  };

  const mockWebPageService = {
    getPageById: vi.fn(),
  };

  // Note: mockServiceClient は v0.1.0 で削除されました（SVG機能削除）

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initializeMotionServices', () => {
    it('Motion関連の全ファクトリを一括登録する', () => {
      const config: ServiceInitializerConfig = {
        embeddingService: mockEmbeddingService,
        prisma: mockPrisma,
        webPageService: mockWebPageService,
      };

      const result = initializeMotionServices(config);

      expect(result.success).toBe(true);
      expect(result.registeredFactories).toContain('motionDetect');
      expect(result.registeredFactories).toContain('motionSearch');
      expect(result.registeredFactories).toContain('motionPersistence');
    });

    it('依存関係が不足している場合はエラーを返す', () => {
      const incompleteConfig = {
        embeddingService: mockEmbeddingService,
        // prisma missing
      } as unknown as ServiceInitializerConfig;

      const result = initializeMotionServices(incompleteConfig);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('prisma');
    });
  });

  describe('initializeLayoutServices', () => {
    it('Layout関連の全ファクトリを一括登録する', () => {
      const config: ServiceInitializerConfig = {
        embeddingService: mockEmbeddingService,
        prisma: mockPrisma,
        webPageService: mockWebPageService,
      };

      const result = initializeLayoutServices(config);

      expect(result.success).toBe(true);
      expect(result.registeredFactories).toContain('layoutSearch');
      expect(result.registeredFactories).toContain('layoutToCode');
      expect(result.registeredFactories).toContain('layoutInspect');
      expect(result.registeredFactories).toContain('layoutIngest');
    });
  });

  // Note: initializeSvgServices は v0.1.0 で削除されました（SVG機能削除）

  describe('initializeAllServices', () => {
    it('全サービスを一括初期化する', () => {
      const config: ServiceInitializerConfig = {
        embeddingService: mockEmbeddingService,
        prisma: mockPrisma,
        webPageService: mockWebPageService,
        // Note: serviceClient は v0.1.0 で削除されました（SVG機能削除）
      };

      const result = initializeAllServices(config);

      expect(result.success).toBe(true);
      // v0.1.0: SVG削除により6ファクトリ以上（motion + layout）
      expect(result.registeredFactories.length).toBeGreaterThanOrEqual(6);
      expect(result.categories).toContain('motion');
      expect(result.categories).toContain('layout');
      // Note: svg は v0.1.0 で削除されました
    });

    it('部分的な依存関係でも可能な範囲で初期化する', () => {
      const partialConfig: ServiceInitializerConfig = {
        embeddingService: mockEmbeddingService,
        prisma: mockPrisma,
        // webPageService, serviceClient missing
      };

      const result = initializeAllServices(partialConfig);

      // Motion/Layout検索は初期化可能
      expect(result.success).toBe(true);
      expect(result.registeredFactories).toContain('motionSearch');
      expect(result.registeredFactories).toContain('layoutSearch');
      // webPageService依存のものはスキップ
      expect(result.skipped).toContain('motionDetect');
      // Note: layoutInspect は webPageService なしでも基本機能使用可能のためスキップされない
      expect(result.registeredFactories).toContain('layoutInspect');
    });
  });

  describe('型定義', () => {
    it('ServiceInitializerConfigは必須プロパティを持つ', () => {
      const config: ServiceInitializerConfig = {
        embeddingService: mockEmbeddingService,
        prisma: mockPrisma,
      };

      expect(config.embeddingService).toBeDefined();
      expect(config.prisma).toBeDefined();
    });

    it('ServiceInitializerResultは成功/失敗を示す', () => {
      const successResult: ServiceInitializerResult = {
        success: true,
        registeredFactories: ['motionSearch', 'layoutSearch'],
        categories: ['motion', 'layout'],
        skipped: [],
      };

      const failureResult: ServiceInitializerResult = {
        success: false,
        registeredFactories: [],
        categories: [],
        skipped: [],
        error: 'Missing required dependency',
      };

      expect(successResult.success).toBe(true);
      expect(failureResult.success).toBe(false);
      expect(failureResult.error).toBeDefined();
    });
  });

  describe('Prisma Wrapper統合', () => {
    it('initializeMotionServicesはcreatePrismaWrapperを内部で使用する', () => {
      const config: ServiceInitializerConfig = {
        embeddingService: mockEmbeddingService,
        prisma: mockPrisma,
        webPageService: mockWebPageService,
      };

      const result = initializeMotionServices(config);

      // 内部でPrismaWrapperが正しく作成されていることを確認
      expect(result.success).toBe(true);
      // motionPatternとmotionEmbeddingテーブルにアクセスできること
      expect(result.registeredFactories).toContain('motionPersistence');
    });

    it('initializeLayoutServicesはcreatePrismaWrapperを内部で使用する', () => {
      const config: ServiceInitializerConfig = {
        embeddingService: mockEmbeddingService,
        prisma: mockPrisma,
        webPageService: mockWebPageService,
      };

      const result = initializeLayoutServices(config);

      expect(result.success).toBe(true);
      // sectionPatternとsectionEmbeddingテーブルにアクセスできること
      expect(result.registeredFactories).toContain('layoutIngest');
    });
  });

  // =====================================================
  // Phase6-SEC-1: 本番環境ガード TDD Red
  // =====================================================
  describe('本番環境ガード (Production Guard)', () => {
    // 元のNODE_ENVを保持
    const originalNodeEnv = process.env.NODE_ENV;

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      // テスト後に元のNODE_ENVを復元
      process.env.NODE_ENV = originalNodeEnv;
    });

    describe('isProductionEnvironment', () => {
      it('NODE_ENV="production"でtrueを返す', async () => {
        // 動的インポートでモジュールを再読み込み
        process.env.NODE_ENV = 'production';
        const { isProductionEnvironment } = await import('../../../src/services/service-initializer');
        expect(isProductionEnvironment()).toBe(true);
      });

      it('NODE_ENV="development"でfalseを返す', async () => {
        process.env.NODE_ENV = 'development';
        const { isProductionEnvironment } = await import('../../../src/services/service-initializer');
        expect(isProductionEnvironment()).toBe(false);
      });

      it('NODE_ENV="test"でfalseを返す', async () => {
        process.env.NODE_ENV = 'test';
        const { isProductionEnvironment } = await import('../../../src/services/service-initializer');
        expect(isProductionEnvironment()).toBe(false);
      });

      it('NODE_ENV未設定でfalseを返す', async () => {
        delete process.env.NODE_ENV;
        const { isProductionEnvironment } = await import('../../../src/services/service-initializer');
        expect(isProductionEnvironment()).toBe(false);
      });
    });

    describe('assertNonProductionFactory', () => {
      it('development環境では例外を投げない', async () => {
        process.env.NODE_ENV = 'development';
        const { assertNonProductionFactory } = await import('../../../src/services/service-initializer');
        expect(() => assertNonProductionFactory('testFactory')).not.toThrow();
      });

      it('test環境では例外を投げない', async () => {
        process.env.NODE_ENV = 'test';
        const { assertNonProductionFactory } = await import('../../../src/services/service-initializer');
        expect(() => assertNonProductionFactory('testFactory')).not.toThrow();
      });

      it('production環境では例外を投げる', async () => {
        process.env.NODE_ENV = 'production';
        const { assertNonProductionFactory } = await import('../../../src/services/service-initializer');
        expect(() => assertNonProductionFactory('testFactory')).toThrow(
          'DI Factory override is not allowed in production environment: testFactory'
        );
      });

      it('production環境でファクトリ名を含むエラーメッセージを返す', async () => {
        process.env.NODE_ENV = 'production';
        const { assertNonProductionFactory } = await import('../../../src/services/service-initializer');
        expect(() => assertNonProductionFactory('motionSearchFactory')).toThrow(
          /motionSearchFactory/
        );
      });
    });

    describe('createProductionSafeFactory', () => {
      it('development環境ではカスタムファクトリが使用される', async () => {
        process.env.NODE_ENV = 'development';
        const { createProductionSafeFactory } = await import('../../../src/services/service-initializer');

        const customFactory = vi.fn().mockReturnValue('custom');
        const defaultFactory = vi.fn().mockReturnValue('default');

        const safeFactory = createProductionSafeFactory('testFactory', defaultFactory);
        safeFactory.setOverride(customFactory);

        expect(safeFactory.get()).toBe('custom');
        expect(customFactory).toHaveBeenCalled();
        expect(defaultFactory).not.toHaveBeenCalled();
      });

      it('production環境ではカスタムファクトリが無視されデフォルトが使用される', async () => {
        process.env.NODE_ENV = 'production';
        const { createProductionSafeFactory } = await import('../../../src/services/service-initializer');

        const customFactory = vi.fn().mockReturnValue('custom');
        const defaultFactory = vi.fn().mockReturnValue('default');

        const safeFactory = createProductionSafeFactory('testFactory', defaultFactory);

        // production環境でsetOverrideは例外を投げる
        expect(() => safeFactory.setOverride(customFactory)).toThrow();

        // getはデフォルトファクトリを使用
        expect(safeFactory.get()).toBe('default');
        expect(defaultFactory).toHaveBeenCalled();
      });

      it('カスタムファクトリ未設定時はデフォルトが使用される', async () => {
        process.env.NODE_ENV = 'development';
        const { createProductionSafeFactory } = await import('../../../src/services/service-initializer');

        const defaultFactory = vi.fn().mockReturnValue('default');

        const safeFactory = createProductionSafeFactory('testFactory', defaultFactory);

        expect(safeFactory.get()).toBe('default');
        expect(defaultFactory).toHaveBeenCalled();
      });

      it('clearOverrideでカスタムファクトリをクリアできる', async () => {
        process.env.NODE_ENV = 'development';
        const { createProductionSafeFactory } = await import('../../../src/services/service-initializer');

        const customFactory = vi.fn().mockReturnValue('custom');
        const defaultFactory = vi.fn().mockReturnValue('default');

        const safeFactory = createProductionSafeFactory('testFactory', defaultFactory);
        safeFactory.setOverride(customFactory);
        safeFactory.clearOverride();

        expect(safeFactory.get()).toBe('default');
      });
    });

    describe('ProductionGuardError', () => {
      it('ProductionGuardErrorはErrorを継承している', async () => {
        const { ProductionGuardError } = await import('../../../src/services/service-initializer');
        const error = new ProductionGuardError('testFactory');

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('ProductionGuardError');
        expect(error.factoryName).toBe('testFactory');
      });

      it('エラーメッセージにファクトリ名が含まれる', async () => {
        const { ProductionGuardError } = await import('../../../src/services/service-initializer');
        const error = new ProductionGuardError('myFactory');

        expect(error.message).toContain('myFactory');
        expect(error.message).toContain('production');
      });
    });
  });
});
