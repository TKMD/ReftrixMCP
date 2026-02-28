// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 共通モックファクトリのテスト
 * モックファクトリが正しく動作することを検証
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  // モックファクトリ
  createMockCachedServiceClient,
  createMockServiceClient,
  createMockLogger,
  createMockLoggerClass,
  // テストデータファクトリ
  createMockSvgAsset,
  createMockSearchResultItem,
  createMockSearchResult,
  createEmptySearchResult,
  createMockProject,
  createMockIngestResult,
  // モジュールファクトリ
  getCachedServiceClientMockModule,
  getServiceClientMockModule,
  getLoggerMockModule,
  // ヘルパー
  setupSearchMock,
  setupGetSvgMock,
  setupErrorMock,
  // テストデータ
  TEST_UUIDS,
  VALID_SVG_CONTENT,
} from './service-clients';

describe('共通モックファクトリ', () => {
  describe('createMockCachedServiceClient', () => {
    it('すべてのメソッドがモック化されていること', () => {
      // Act
      const client = createMockCachedServiceClient();

      // Assert
      expect(client.search).toBeDefined();
      expect(client.getSvg).toBeDefined();
      expect(client.getStats).toBeDefined();
      expect(vi.isMockFunction(client.search)).toBe(true);
      expect(vi.isMockFunction(client.getSvg)).toBe(true);
    });

    it('各メソッドが独立したモックであること', () => {
      // Act
      const client = createMockCachedServiceClient();
      client.search.mockResolvedValueOnce({ items: [], total: 0 });
      client.getSvg.mockResolvedValueOnce(null);

      // Assert
      expect(client.search).toHaveBeenCalledTimes(0);
      expect(client.getSvg).toHaveBeenCalledTimes(0);
    });
  });

  describe('createMockServiceClient', () => {
    it('すべてのメソッドがモック化されていること', () => {
      // Act
      const client = createMockServiceClient();

      // Assert
      expect(client.search).toBeDefined();
      expect(client.getSvg).toBeDefined();
      expect(client.ingestSvg).toBeDefined();
      expect(client.transformToReact).toBeDefined();
      expect(client.transformOptimize).toBeDefined();
      expect(client.transformRecolor).toBeDefined();
      expect(client.transformNormalize).toBeDefined();
      expect(client.getProject).toBeDefined();
      expect(vi.isMockFunction(client.ingestSvg)).toBe(true);
    });
  });

  describe('createMockLogger', () => {
    it('すべてのログメソッドがモック化されていること', () => {
      // Act
      const logger = createMockLogger();

      // Assert
      expect(logger.info).toBeDefined();
      expect(logger.warn).toBeDefined();
      expect(logger.error).toBeDefined();
      expect(logger.debug).toBeDefined();
      expect(vi.isMockFunction(logger.info)).toBe(true);
    });
  });

  describe('createMockLoggerClass', () => {
    it('インスタンス化可能なクラスを返すこと', () => {
      // Act
      const LoggerClass = createMockLoggerClass();
      const instance = new LoggerClass();

      // Assert
      expect(instance.info).toBeDefined();
      expect(instance.warn).toBeDefined();
      expect(instance.error).toBeDefined();
      expect(instance.debug).toBeDefined();
    });
  });
});

describe('テストデータファクトリ', () => {
  describe('createMockSvgAsset', () => {
    it('デフォルト値でSVGアセットを作成すること', () => {
      // Act
      const asset = createMockSvgAsset();

      // Assert
      expect(asset.id).toBe(TEST_UUIDS.svgAsset1);
      expect(asset.name).toBe('Blue Star Icon');
      expect(asset.slug).toBe('blue-star-icon');
      expect(asset.svg_raw).toBe(VALID_SVG_CONTENT);
      expect(asset.style).toBe('flat');
      expect(asset.purpose).toBe('icon');
      expect(asset.colors).toContain('#3B82F6');
    });

    it('プロパティを上書きできること', () => {
      // Act
      const asset = createMockSvgAsset({
        name: 'Custom Icon',
        style: 'line',
      });

      // Assert
      expect(asset.name).toBe('Custom Icon');
      expect(asset.style).toBe('line');
      // 他のプロパティはデフォルト値
      expect(asset.slug).toBe('blue-star-icon');
    });

    it('ライセンス情報が含まれること', () => {
      // Act
      const asset = createMockSvgAsset();

      // Assert
      expect(asset.license).toBeDefined();
      expect(typeof asset.license).toBe('object');
      const license = asset.license as { spdx_id: string; commercial_use: boolean };
      expect(license.spdx_id).toBe('MIT');
      expect(license.commercial_use).toBe(true);
    });
  });

  describe('createMockSearchResultItem', () => {
    it('デフォルト値で検索結果アイテムを作成すること', () => {
      // Act
      const item = createMockSearchResultItem();

      // Assert
      expect(item.id).toBe(TEST_UUIDS.svgAsset1);
      expect(item.name).toBe('Blue Star Icon');
      expect(item.similarity).toBe(0.95);
      expect(item.license.spdx_id).toBe('MIT');
    });

    it('プロパティを上書きできること', () => {
      // Act
      const item = createMockSearchResultItem({
        similarity: 0.85,
        name: 'Custom Result',
      });

      // Assert
      expect(item.similarity).toBe(0.85);
      expect(item.name).toBe('Custom Result');
    });
  });

  describe('createMockSearchResult', () => {
    it('デフォルト値で検索結果を作成すること', () => {
      // Act
      const result = createMockSearchResult();

      // Assert
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(0);
    });

    it('カスタムアイテムで作成できること', () => {
      // Act
      const customItems = [
        createMockSearchResultItem({ name: 'Item 1' }),
        createMockSearchResultItem({ name: 'Item 2' }),
      ];
      const result = createMockSearchResult({
        items: customItems,
        total: 2,
      });

      // Assert
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
    });
  });

  describe('createEmptySearchResult', () => {
    it('空の検索結果を作成すること', () => {
      // Act
      const result = createEmptySearchResult();

      // Assert
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('createMockProject', () => {
    it('デフォルト値でプロジェクトを作成すること', () => {
      // Act
      const project = createMockProject();

      // Assert
      expect(project.id).toBe(TEST_UUIDS.project);
      expect(project.name).toBe('Test Project');
      expect(project.status).toBe('in_progress');
      expect(project.pages).toEqual([]);
    });

    it('プロパティを上書きできること', () => {
      // Act
      const project = createMockProject({
        name: 'Custom Project',
        status: 'completed',
      });

      // Assert
      expect(project.name).toBe('Custom Project');
      expect(project.status).toBe('completed');
    });
  });

  describe('createMockIngestResult', () => {
    it('デフォルト値で登録結果を作成すること', () => {
      // Act
      const result = createMockIngestResult();

      // Assert
      expect(result.id).toBe(TEST_UUIDS.svgAsset1);
      expect(result.name).toBe('Test Icon');
      expect(result.original_size).toBe(256);
      expect(result.optimized_size).toBe(180);
      expect(result.reduction_percent).toBe(29.7);
    });
  });
});

describe('モジュールファクトリ', () => {
  describe('getCachedServiceClientMockModule', () => {
    it('vi.mockに渡せるモジュールオブジェクトを返すこと', () => {
      // Act
      const module = getCachedServiceClientMockModule();

      // Assert
      expect(module.cachedServiceClient).toBeDefined();
      expect(module.cachedServiceClient.search).toBeDefined();
      expect(module.cachedServiceClient.getSvg).toBeDefined();
    });
  });

  describe('getServiceClientMockModule', () => {
    it('vi.mockに渡せるモジュールオブジェクトを返すこと', () => {
      // Act
      const module = getServiceClientMockModule();

      // Assert
      expect(module.serviceClient).toBeDefined();
      expect(module.API_BASE_URL).toBe('http://localhost:24000/api/v1');
      expect(module.ServiceClient).toBeDefined();
    });
  });

  describe('getLoggerMockModule', () => {
    it('vi.mockに渡せるモジュールオブジェクトを返すこと', () => {
      // Act
      const module = getLoggerMockModule();

      // Assert
      expect(module.logger).toBeDefined();
      expect(module.createLogger).toBeDefined();
      expect(module.Logger).toBeDefined();
      expect(module.isDevelopment).toBeDefined();
    });
  });
});

describe('ヘルパー関数', () => {
  describe('setupSearchMock', () => {
    it('検索モックを設定できること', async () => {
      // Arrange
      const client = createMockCachedServiceClient();
      const mockResult = createMockSearchResult();

      // Act
      setupSearchMock(client.search, mockResult);
      const result = await client.search({ q: 'test' });

      // Assert
      expect(result).toEqual(mockResult);
    });
  });

  describe('setupGetSvgMock', () => {
    it('getSvgモックを設定できること', async () => {
      // Arrange
      const client = createMockCachedServiceClient();
      const mockAsset = createMockSvgAsset();

      // Act
      setupGetSvgMock(client.getSvg, mockAsset);
      const result = await client.getSvg(TEST_UUIDS.svgAsset1);

      // Assert
      expect(result).toEqual(mockAsset);
    });

    it('nullを返すモックを設定できること', async () => {
      // Arrange
      const client = createMockCachedServiceClient();

      // Act
      setupGetSvgMock(client.getSvg, null);
      const result = await client.getSvg('non-existent-id');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('setupErrorMock', () => {
    it('エラーをスローするモックを設定できること', async () => {
      // Arrange
      const client = createMockCachedServiceClient();
      const error = new Error('API Error');

      // Act
      setupErrorMock(client.search, error);

      // Assert
      await expect(client.search({ q: 'test' })).rejects.toThrow('API Error');
    });
  });
});
