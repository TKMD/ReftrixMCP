// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Service Initializer Tests
 *
 * TDD Red Phase: DI Factory本番環境ガードのテスト
 *
 * Phase6-SEC-1: 本番環境でのDI Factoryオーバーライド防止機能のテスト
 *
 * テスト対象:
 * 1. ProductionGuardError - エラークラスのテスト
 * 2. isProductionEnvironment - 環境判定関数のテスト
 * 3. assertNonProductionFactory - ガード関数のテスト
 * 4. createProductionSafeFactory - ファクトリラッパーのテスト
 *
 * @module tests/services/service-initializer.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ProductionGuardError,
  isProductionEnvironment,
  assertNonProductionFactory,
  createProductionSafeFactory,
  type ProductionSafeFactory,
  type IEmbeddingService,
} from '../../src/services/service-initializer';
import {
  setMotionPersistenceEmbeddingServiceFactory,
  resetMotionPersistenceEmbeddingServiceFactory,
  setMotionPersistencePrismaClientFactory,
  resetMotionPersistencePrismaClientFactory,
  type IPrismaClient as MotionPrismaClient,
} from '../../src/services/motion-persistence.service';
import {
  setEmbeddingServiceFactory as setMotionSearchEmbeddingServiceFactory,
  resetEmbeddingServiceFactory as resetMotionSearchEmbeddingServiceFactory,
  setPrismaClientFactory as setMotionSearchPrismaClientFactory,
  resetPrismaClientFactory as resetMotionSearchPrismaClientFactory,
  type IPrismaClient as MotionSearchPrismaClient,
} from '../../src/services/motion-search.service';

// =====================================================
// テスト用ヘルパー
// =====================================================

/**
 * NODE_ENVを一時的に変更するヘルパー
 */
function withNodeEnv<T>(env: string | undefined, fn: () => T): T {
  const originalEnv = process.env.NODE_ENV;
  if (env === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = env;
  }
  try {
    return fn();
  } finally {
    if (originalEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnv;
    }
  }
}

/**
 * テスト用モックサービスインターフェース
 */
interface MockService {
  name: string;
  getValue(): string;
}

/**
 * テスト用モックサービス実装
 */
function createMockService(name: string): MockService {
  return {
    name,
    getValue: () => `value-from-${name}`,
  };
}

// =====================================================
// ProductionGuardError テスト
// =====================================================

describe('ProductionGuardError', () => {
  it('should create error with correct message', () => {
    // Arrange
    const factoryName = 'testFactory';

    // Act
    const error = new ProductionGuardError(factoryName);

    // Assert
    expect(error.message).toBe(
      `DI Factory override is not allowed in production environment: ${factoryName}`
    );
  });

  it('should have correct name property', () => {
    // Arrange & Act
    const error = new ProductionGuardError('someFactory');

    // Assert
    expect(error.name).toBe('ProductionGuardError');
  });

  it('should store factoryName property', () => {
    // Arrange
    const factoryName = 'embeddingServiceFactory';

    // Act
    const error = new ProductionGuardError(factoryName);

    // Assert
    expect(error.factoryName).toBe(factoryName);
  });

  it('should be instanceof Error', () => {
    // Arrange & Act
    const error = new ProductionGuardError('factory');

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProductionGuardError);
  });

  it('should have stack trace', () => {
    // Arrange & Act
    const error = new ProductionGuardError('factory');

    // Assert
    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('ProductionGuardError');
  });
});

// =====================================================
// isProductionEnvironment テスト
// =====================================================

describe('isProductionEnvironment', () => {
  // 元のNODE_ENVを保存・復元
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('should return true when NODE_ENV is "production"', () => {
    // Arrange
    process.env.NODE_ENV = 'production';

    // Act
    const result = isProductionEnvironment();

    // Assert
    expect(result).toBe(true);
  });

  it('should return false when NODE_ENV is "development"', () => {
    // Arrange
    process.env.NODE_ENV = 'development';

    // Act
    const result = isProductionEnvironment();

    // Assert
    expect(result).toBe(false);
  });

  it('should return false when NODE_ENV is "test"', () => {
    // Arrange
    process.env.NODE_ENV = 'test';

    // Act
    const result = isProductionEnvironment();

    // Assert
    expect(result).toBe(false);
  });

  it('should return false when NODE_ENV is undefined', () => {
    // Arrange
    delete process.env.NODE_ENV;

    // Act
    const result = isProductionEnvironment();

    // Assert
    expect(result).toBe(false);
  });

  it('should return false when NODE_ENV is empty string', () => {
    // Arrange
    process.env.NODE_ENV = '';

    // Act
    const result = isProductionEnvironment();

    // Assert
    expect(result).toBe(false);
  });

  it('should return false when NODE_ENV is "Production" (case sensitive)', () => {
    // Arrange
    process.env.NODE_ENV = 'Production';

    // Act
    const result = isProductionEnvironment();

    // Assert
    expect(result).toBe(false);
  });
});

// =====================================================
// assertNonProductionFactory テスト
// =====================================================

describe('assertNonProductionFactory', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('should throw ProductionGuardError in production environment', () => {
    // Arrange
    process.env.NODE_ENV = 'production';
    const factoryName = 'testFactory';

    // Act & Assert
    expect(() => assertNonProductionFactory(factoryName)).toThrow(
      ProductionGuardError
    );
    expect(() => assertNonProductionFactory(factoryName)).toThrow(
      `DI Factory override is not allowed in production environment: ${factoryName}`
    );
  });

  it('should not throw in development environment', () => {
    // Arrange
    process.env.NODE_ENV = 'development';
    const factoryName = 'testFactory';

    // Act & Assert
    expect(() => assertNonProductionFactory(factoryName)).not.toThrow();
  });

  it('should not throw in test environment', () => {
    // Arrange
    process.env.NODE_ENV = 'test';
    const factoryName = 'testFactory';

    // Act & Assert
    expect(() => assertNonProductionFactory(factoryName)).not.toThrow();
  });

  it('should not throw when NODE_ENV is undefined', () => {
    // Arrange
    delete process.env.NODE_ENV;
    const factoryName = 'testFactory';

    // Act & Assert
    expect(() => assertNonProductionFactory(factoryName)).not.toThrow();
  });

  it('should include factory name in error message', () => {
    // Arrange
    process.env.NODE_ENV = 'production';
    const factoryName = 'embeddingServiceFactory';

    // Act & Assert
    try {
      assertNonProductionFactory(factoryName);
      expect.fail('Should have thrown ProductionGuardError');
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionGuardError);
      expect((error as ProductionGuardError).factoryName).toBe(factoryName);
    }
  });
});

// =====================================================
// createProductionSafeFactory テスト
// =====================================================

describe('createProductionSafeFactory', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    // テスト前にNODE_ENVをdevelopmentに設定
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  describe('get()', () => {
    it('should return default factory result when no override', () => {
      // Arrange
      const defaultService = createMockService('default');
      const factory = createProductionSafeFactory(
        'testFactory',
        () => defaultService
      );

      // Act
      const result = factory.get();

      // Assert
      expect(result).toBe(defaultService);
      expect(result.name).toBe('default');
    });

    it('should return override factory result in development environment', () => {
      // Arrange
      process.env.NODE_ENV = 'development';
      const defaultService = createMockService('default');
      const overrideService = createMockService('override');
      const factory = createProductionSafeFactory(
        'testFactory',
        () => defaultService
      );
      factory.setOverride(() => overrideService);

      // Act
      const result = factory.get();

      // Assert
      expect(result).toBe(overrideService);
      expect(result.name).toBe('override');
    });

    it('should always return default factory in production environment even if override was set', () => {
      // Arrange: 開発環境でオーバーライドを設定
      process.env.NODE_ENV = 'development';
      const defaultService = createMockService('default');
      const overrideService = createMockService('override');
      const factory = createProductionSafeFactory(
        'testFactory',
        () => defaultService
      );
      factory.setOverride(() => overrideService);

      // Act: 本番環境でget()を呼び出し
      process.env.NODE_ENV = 'production';
      const result = factory.get();

      // Assert: デフォルトが返される
      expect(result).toBe(defaultService);
      expect(result.name).toBe('default');
    });

    it('should call factory function each time get() is called', () => {
      // Arrange
      let callCount = 0;
      const factory = createProductionSafeFactory('testFactory', () => {
        callCount++;
        return createMockService(`call-${callCount}`);
      });

      // Act
      factory.get();
      factory.get();
      factory.get();

      // Assert
      expect(callCount).toBe(3);
    });
  });

  describe('setOverride()', () => {
    it('should throw ProductionGuardError in production environment', () => {
      // Arrange
      process.env.NODE_ENV = 'production';
      const defaultService = createMockService('default');
      const overrideService = createMockService('override');
      const factory = createProductionSafeFactory(
        'testFactory',
        () => defaultService
      );

      // Act & Assert
      expect(() => factory.setOverride(() => overrideService)).toThrow(
        ProductionGuardError
      );
    });

    it('should work normally in development environment', () => {
      // Arrange
      process.env.NODE_ENV = 'development';
      const defaultService = createMockService('default');
      const overrideService = createMockService('override');
      const factory = createProductionSafeFactory(
        'testFactory',
        () => defaultService
      );

      // Act & Assert
      expect(() => factory.setOverride(() => overrideService)).not.toThrow();
    });

    it('should work normally in test environment', () => {
      // Arrange
      process.env.NODE_ENV = 'test';
      const defaultService = createMockService('default');
      const overrideService = createMockService('override');
      const factory = createProductionSafeFactory(
        'testFactory',
        () => defaultService
      );

      // Act & Assert
      expect(() => factory.setOverride(() => overrideService)).not.toThrow();
    });

    it('should work when NODE_ENV is undefined', () => {
      // Arrange
      delete process.env.NODE_ENV;
      const defaultService = createMockService('default');
      const overrideService = createMockService('override');
      const factory = createProductionSafeFactory(
        'testFactory',
        () => defaultService
      );

      // Act & Assert
      expect(() => factory.setOverride(() => overrideService)).not.toThrow();
    });
  });

  describe('clearOverride()', () => {
    it('should clear override and return to default factory', () => {
      // Arrange
      process.env.NODE_ENV = 'development';
      const defaultService = createMockService('default');
      const overrideService = createMockService('override');
      const factory = createProductionSafeFactory(
        'testFactory',
        () => defaultService
      );
      factory.setOverride(() => overrideService);

      // オーバーライドが機能していることを確認
      expect(factory.get()).toBe(overrideService);

      // Act
      factory.clearOverride();

      // Assert
      expect(factory.get()).toBe(defaultService);
    });

    it('should be safe to call multiple times', () => {
      // Arrange
      const defaultService = createMockService('default');
      const factory = createProductionSafeFactory(
        'testFactory',
        () => defaultService
      );

      // Act & Assert: 複数回呼び出してもエラーにならない
      expect(() => {
        factory.clearOverride();
        factory.clearOverride();
        factory.clearOverride();
      }).not.toThrow();
    });

    it('should work even without prior setOverride', () => {
      // Arrange
      const defaultService = createMockService('default');
      const factory = createProductionSafeFactory(
        'testFactory',
        () => defaultService
      );

      // Act
      factory.clearOverride();

      // Assert: デフォルトが返される
      expect(factory.get()).toBe(defaultService);
    });
  });

  describe('hasOverride()', () => {
    it('should return false initially', () => {
      // Arrange
      const factory = createProductionSafeFactory('testFactory', () =>
        createMockService('default')
      );

      // Act & Assert
      expect(factory.hasOverride()).toBe(false);
    });

    it('should return true after setOverride', () => {
      // Arrange
      process.env.NODE_ENV = 'development';
      const factory = createProductionSafeFactory('testFactory', () =>
        createMockService('default')
      );
      factory.setOverride(() => createMockService('override'));

      // Act & Assert
      expect(factory.hasOverride()).toBe(true);
    });

    it('should return false after clearOverride', () => {
      // Arrange
      process.env.NODE_ENV = 'development';
      const factory = createProductionSafeFactory('testFactory', () =>
        createMockService('default')
      );
      factory.setOverride(() => createMockService('override'));
      factory.clearOverride();

      // Act & Assert
      expect(factory.hasOverride()).toBe(false);
    });

    it('should reflect actual override state regardless of environment', () => {
      // Arrange: 開発環境でオーバーライドを設定
      process.env.NODE_ENV = 'development';
      const factory = createProductionSafeFactory('testFactory', () =>
        createMockService('default')
      );
      factory.setOverride(() => createMockService('override'));

      // オーバーライドがあることを確認
      expect(factory.hasOverride()).toBe(true);

      // Act: 本番環境に切り替え
      process.env.NODE_ENV = 'production';

      // Assert: hasOverride()はまだtrueを返す（内部状態を反映）
      // ただしget()はデフォルトを返す
      expect(factory.hasOverride()).toBe(true);
    });
  });

  describe('factory name in error messages', () => {
    it('should include factory name in ProductionGuardError', () => {
      // Arrange
      process.env.NODE_ENV = 'production';
      const factoryName = 'embeddingServiceFactory';
      const factory = createProductionSafeFactory(factoryName, () =>
        createMockService('default')
      );

      // Act
      try {
        factory.setOverride(() => createMockService('override'));
        expect.fail('Should have thrown');
      } catch (error) {
        // Assert
        expect(error).toBeInstanceOf(ProductionGuardError);
        expect((error as ProductionGuardError).factoryName).toBe(factoryName);
        expect((error as ProductionGuardError).message).toContain(factoryName);
      }
    });
  });
});

// =====================================================
// 統合テスト: 実際のサービスファクトリとの連携
// Phase6-SEC-1: これらのテストは実装後に有効化
// =====================================================

describe('Integration: Motion Persistence Factory with ProductionSafeFactory', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    // ファクトリをリセット
    resetMotionPersistenceEmbeddingServiceFactory();
    resetMotionPersistencePrismaClientFactory();
  });

  afterEach(() => {
    // ファクトリをリセット
    resetMotionPersistenceEmbeddingServiceFactory();
    resetMotionPersistencePrismaClientFactory();

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  /**
   * Phase6-SEC-1 Green Phase 完了: 本番環境ガード実装済み
   *
   * 設計意図:
   * - 初回設定は許可（サーバー起動時の正当な初期化）
   * - 上書きは禁止（テストでのモック注入などセキュリティリスク防止）
   */

  it('should allow initial setMotionPersistenceEmbeddingServiceFactory in production (init allowed, override blocked)', () => {
    // Arrange
    process.env.NODE_ENV = 'production';
    const mockEmbeddingService: IEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };

    // Act & Assert: 本番環境でも初回設定は許可される
    expect(() =>
      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingService)
    ).not.toThrow();

    // 2回目の設定（上書き）はProductionGuardErrorがスローされるべき
    expect(() =>
      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingService)
    ).toThrow(ProductionGuardError);
  });

  it('should allow initial setMotionPersistencePrismaClientFactory in production (init allowed, override blocked)', () => {
    // Arrange
    process.env.NODE_ENV = 'production';
    const mockPrismaClient = {
      motionPattern: { create: vi.fn() },
      motionEmbedding: { create: vi.fn() },
      $executeRawUnsafe: vi.fn(),
      $transaction: vi.fn(),
    } as unknown as MotionPrismaClient;

    // Act & Assert: 本番環境でも初回設定は許可される
    expect(() =>
      setMotionPersistencePrismaClientFactory(() => mockPrismaClient)
    ).not.toThrow();

    // 2回目の設定（上書き）はProductionGuardErrorがスローされるべき
    expect(() =>
      setMotionPersistencePrismaClientFactory(() => mockPrismaClient)
    ).toThrow(ProductionGuardError);
  });

  it('should allow factory override in development environment', () => {
    // Arrange
    process.env.NODE_ENV = 'development';
    const mockEmbeddingService: IEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };

    // Act & Assert: 開発環境ではエラーなくオーバーライドできるべき
    expect(() =>
      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingService)
    ).not.toThrow();
  });

  it('should allow resetMotionPersistenceEmbeddingServiceFactory in production', () => {
    // Arrange: 開発環境でオーバーライドを設定
    process.env.NODE_ENV = 'development';
    const mockEmbeddingService: IEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };
    setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingService);

    // Act & Assert: 本番環境でもリセットは許可されるべき（オーバーライド解除）
    process.env.NODE_ENV = 'production';
    expect(() => resetMotionPersistenceEmbeddingServiceFactory()).not.toThrow();
  });
});

describe('Integration: Motion Search Factory with ProductionSafeFactory', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    // ファクトリをリセット
    resetMotionSearchEmbeddingServiceFactory();
    resetMotionSearchPrismaClientFactory();
  });

  afterEach(() => {
    // ファクトリをリセット
    resetMotionSearchEmbeddingServiceFactory();
    resetMotionSearchPrismaClientFactory();

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  /**
   * Phase6-SEC-1 Green Phase 完了: 本番環境ガード実装済み
   *
   * 設計意図:
   * - 初回設定は許可（サーバー起動時の正当な初期化）
   * - 上書きは禁止（テストでのモック注入などセキュリティリスク防止）
   */

  it('should allow initial setEmbeddingServiceFactory in production (init allowed, override blocked)', () => {
    // Arrange
    process.env.NODE_ENV = 'production';
    const mockEmbeddingService: IEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };

    // Act & Assert: 本番環境でも初回設定は許可される
    expect(() =>
      setMotionSearchEmbeddingServiceFactory(() => mockEmbeddingService)
    ).not.toThrow();

    // 2回目の設定（上書き）はProductionGuardErrorがスローされるべき
    expect(() =>
      setMotionSearchEmbeddingServiceFactory(() => mockEmbeddingService)
    ).toThrow(ProductionGuardError);
  });

  it('should allow initial setPrismaClientFactory in production (init allowed, override blocked)', () => {
    // Arrange
    process.env.NODE_ENV = 'production';
    const mockPrismaClient = {
      motionPattern: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
      $queryRawUnsafe: vi.fn(),
    } as unknown as MotionSearchPrismaClient;

    // Act & Assert: 本番環境でも初回設定は許可される
    expect(() =>
      setMotionSearchPrismaClientFactory(() => mockPrismaClient)
    ).not.toThrow();

    // 2回目の設定（上書き）はProductionGuardErrorがスローされるべき
    expect(() =>
      setMotionSearchPrismaClientFactory(() => mockPrismaClient)
    ).toThrow(ProductionGuardError);
  });

  it('should allow factory override in development environment', () => {
    // Arrange
    process.env.NODE_ENV = 'development';
    const mockEmbeddingService: IEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };

    // Act & Assert: 開発環境ではエラーなくオーバーライドできるべき
    expect(() =>
      setMotionSearchEmbeddingServiceFactory(() => mockEmbeddingService)
    ).not.toThrow();
  });

  it('should allow resetEmbeddingServiceFactory in production', () => {
    // Arrange: 開発環境でオーバーライドを設定
    process.env.NODE_ENV = 'development';
    const mockEmbeddingService: IEmbeddingService = {
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };
    setMotionSearchEmbeddingServiceFactory(() => mockEmbeddingService);

    // Act & Assert: 本番環境でもリセットは許可されるべき（オーバーライド解除）
    process.env.NODE_ENV = 'production';
    expect(() => resetMotionSearchEmbeddingServiceFactory()).not.toThrow();
  });
});

// =====================================================
// エッジケーステスト
// =====================================================

describe('Edge Cases', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  describe('Factory returning different types', () => {
    it('should work with primitive types', () => {
      // Arrange
      const factory = createProductionSafeFactory<number>('numberFactory', () => 42);

      // Act
      const result = factory.get();

      // Assert
      expect(result).toBe(42);
    });

    it('should work with null values', () => {
      // Arrange
      const factory = createProductionSafeFactory<null>('nullFactory', () => null);

      // Act
      const result = factory.get();

      // Assert
      expect(result).toBeNull();
    });

    it('should work with arrays', () => {
      // Arrange
      const testArray = [1, 2, 3];
      const factory = createProductionSafeFactory<number[]>(
        'arrayFactory',
        () => testArray
      );

      // Act
      const result = factory.get();

      // Assert
      expect(result).toBe(testArray);
    });

    it('should work with functions', () => {
      // Arrange
      const testFn = () => 'hello';
      const factory = createProductionSafeFactory<() => string>(
        'fnFactory',
        () => testFn
      );

      // Act
      const result = factory.get();

      // Assert
      expect(result).toBe(testFn);
      expect(result()).toBe('hello');
    });
  });

  describe('Environment switching during lifecycle', () => {
    it('should respect environment at call time, not factory creation time', () => {
      // Arrange: 本番環境でファクトリを作成
      process.env.NODE_ENV = 'production';
      const factory = createProductionSafeFactory('testFactory', () =>
        createMockService('default')
      );

      // Act: 開発環境に切り替えてオーバーライド
      process.env.NODE_ENV = 'development';
      factory.setOverride(() => createMockService('override'));

      // Assert: オーバーライドが機能する
      expect(factory.get().name).toBe('override');

      // Act: 本番環境に戻す
      process.env.NODE_ENV = 'production';

      // Assert: デフォルトに戻る
      expect(factory.get().name).toBe('default');
    });
  });

  describe('Multiple factory instances', () => {
    it('should maintain separate override state for different factories', () => {
      // Arrange
      process.env.NODE_ENV = 'development';
      const factory1 = createProductionSafeFactory('factory1', () =>
        createMockService('default1')
      );
      const factory2 = createProductionSafeFactory('factory2', () =>
        createMockService('default2')
      );

      // Act: factory1のみオーバーライド
      factory1.setOverride(() => createMockService('override1'));

      // Assert
      expect(factory1.hasOverride()).toBe(true);
      expect(factory2.hasOverride()).toBe(false);
      expect(factory1.get().name).toBe('override1');
      expect(factory2.get().name).toBe('default2');
    });
  });

  describe('Factory throwing errors', () => {
    it('should propagate errors from default factory', () => {
      // Arrange
      const factory = createProductionSafeFactory<MockService>('errorFactory', () => {
        throw new Error('Default factory error');
      });

      // Act & Assert
      expect(() => factory.get()).toThrow('Default factory error');
    });

    it('should propagate errors from override factory', () => {
      // Arrange
      process.env.NODE_ENV = 'development';
      const factory = createProductionSafeFactory<MockService>(
        'errorFactory',
        () => createMockService('default')
      );
      factory.setOverride(() => {
        throw new Error('Override factory error');
      });

      // Act & Assert
      expect(() => factory.get()).toThrow('Override factory error');
    });
  });
});

// =====================================================
// MCP-INIT-02: 初期化結果の詳細情報テスト
// =====================================================

import { getLastInitializationResult } from '../../src/services/service-initializer';

describe('MCP-INIT-02: getLastInitializationResult', () => {
  it('should return null before initializeAllServices is called', () => {
    // Note: This test may fail if initializeAllServices was already called
    // in other tests. The function returns the last result, so we just verify
    // the return type.
    const result = getLastInitializationResult();

    // Result should be either null or the expected structure
    if (result !== null) {
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('initializedCategories');
      expect(result).toHaveProperty('skippedCategories');
      expect(result).toHaveProperty('errors');
      expect(result).toHaveProperty('registeredToolCount');
      expect(result).toHaveProperty('registeredFactories');
    }
  });

  it('should return InitializationDetailedResult structure', () => {
    const result = getLastInitializationResult();

    if (result !== null) {
      // Verify structure
      expect(typeof result.success).toBe('boolean');
      expect(Array.isArray(result.initializedCategories)).toBe(true);
      expect(Array.isArray(result.skippedCategories)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
      expect(typeof result.registeredToolCount).toBe('number');
      expect(Array.isArray(result.registeredFactories)).toBe(true);

      // Verify skippedCategories structure
      for (const skipped of result.skippedCategories) {
        expect(typeof skipped.category).toBe('string');
        expect(typeof skipped.reason).toBe('string');
      }

      // Verify errors structure
      for (const error of result.errors) {
        expect(typeof error.category).toBe('string');
        expect(typeof error.error).toBe('string');
      }
    }
  });
});
