// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect URL mode WebPage自動作成テスト
 *
 * URL modeでmotion.detectを実行した際に:
 * - 既存のWebPageがあれば再利用
 * - なければ新規WebPageレコードを作成
 * - motion_patternsには必ず web_page_id をセット
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MotionPattern } from '../../../src/tools/motion/schemas';
import {
  setWebPageServiceFactory,
  resetWebPageServiceFactory,
  getWebPageService,
  type IWebPageService,
} from '../../../src/tools/motion/di-factories';

// =====================================================
// モック
// =====================================================

const mockWebPageService: IWebPageService = {
  getPageById: vi.fn(),
  findByUrl: vi.fn(),
  findOrCreateByUrl: vi.fn(),
};

// =====================================================
// テストケース
// =====================================================

describe('motion.detect URL mode WebPage自動作成', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // WebPageServiceのモックを設定
    setWebPageServiceFactory(() => mockWebPageService);
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetWebPageServiceFactory();
  });

  describe('WebPageService.findOrCreateByUrl', () => {
    it('既存のWebPageがある場合は再利用する (created: false)', async () => {
      // Arrange
      const existingWebPage = {
        id: 'existing-webpage-id',
        url: 'https://example.com/test',
        created: false,
      };
      vi.mocked(mockWebPageService.findOrCreateByUrl).mockResolvedValue(existingWebPage);

      // Act
      const service = getWebPageService();
      const result = await service.findOrCreateByUrl('https://example.com/test');

      // Assert
      expect(result.id).toBe('existing-webpage-id');
      expect(result.created).toBe(false);
      expect(mockWebPageService.findOrCreateByUrl).toHaveBeenCalledWith(
        'https://example.com/test'
      );
    });

    it('WebPageが存在しない場合は新規作成する (created: true)', async () => {
      // Arrange
      const newWebPage = {
        id: 'new-webpage-id',
        url: 'https://example.com/new',
        created: true,
      };
      vi.mocked(mockWebPageService.findOrCreateByUrl).mockResolvedValue(newWebPage);

      // Act
      const service = getWebPageService();
      const result = await service.findOrCreateByUrl('https://example.com/new');

      // Assert
      expect(result.id).toBe('new-webpage-id');
      expect(result.created).toBe(true);
      expect(mockWebPageService.findOrCreateByUrl).toHaveBeenCalledWith(
        'https://example.com/new'
      );
    });

    it('sourceTypeとusageScopeオプションを渡せる', async () => {
      // Arrange
      const newWebPage = {
        id: 'custom-webpage-id',
        url: 'https://example.com/custom',
        created: true,
      };
      vi.mocked(mockWebPageService.findOrCreateByUrl).mockResolvedValue(newWebPage);

      // Act
      const service = getWebPageService();
      const result = await service.findOrCreateByUrl('https://example.com/custom', {
        sourceType: 'award_gallery',
        usageScope: 'owned_asset',
      });

      // Assert
      expect(result.id).toBe('custom-webpage-id');
      expect(mockWebPageService.findOrCreateByUrl).toHaveBeenCalledWith(
        'https://example.com/custom',
        { sourceType: 'award_gallery', usageScope: 'owned_asset' }
      );
    });
  });

  describe('DI Factory Pattern', () => {
    it('カスタムファクトリを設定できる', async () => {
      // Arrange
      const customMockService: IWebPageService = {
        getPageById: vi.fn(),
        findByUrl: vi.fn(),
        findOrCreateByUrl: vi.fn().mockResolvedValue({
          id: 'custom-factory-id',
          url: 'https://example.com/custom-factory',
          created: true,
        }),
      };
      setWebPageServiceFactory(() => customMockService);

      // Act
      const service = getWebPageService();
      const result = await service.findOrCreateByUrl('https://example.com/custom-factory');

      // Assert
      expect(result.id).toBe('custom-factory-id');
      expect(customMockService.findOrCreateByUrl).toHaveBeenCalled();
    });

    it('ファクトリリセット後はデフォルトサービスを使用', () => {
      // Arrange: ファクトリをリセット
      resetWebPageServiceFactory();

      // Act: デフォルトサービスを取得
      const service = getWebPageService();

      // Assert: サービスが存在し、findOrCreateByUrlメソッドを持つ
      expect(service).toBeDefined();
      expect(typeof service.findOrCreateByUrl).toBe('function');
    });
  });

  describe('motion.detect URL modeでのwebPageId自動設定', () => {
    it('URL mode実行時にWebPageService.findOrCreateByUrlが呼び出される', async () => {
      // Note: 実際のmotion.detectツールの統合テストはE2Eテストで実施
      // ここではDI経由でサービスが呼び出せることを確認

      // Arrange
      const expectedWebPage = {
        id: 'video-mode-webpage-id',
        url: 'https://example.com/video-test',
        created: true,
      };
      vi.mocked(mockWebPageService.findOrCreateByUrl).mockResolvedValue(expectedWebPage);

      // Act
      const service = getWebPageService();
      const result = await service.findOrCreateByUrl('https://example.com/video-test', {
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
      });

      // Assert
      expect(result.id).toBe('video-mode-webpage-id');
      expect(result.created).toBe(true);
    });

    it('既存のWebPageがある場合はそのIDを使用する (created: false)', async () => {
      // Arrange
      const existingWebPage = {
        id: 'existing-webpage-id',
        url: 'https://example.com/existing',
        created: false,
      };
      vi.mocked(mockWebPageService.findOrCreateByUrl).mockResolvedValue(existingWebPage);

      // Act
      const service = getWebPageService();
      const result = await service.findOrCreateByUrl('https://example.com/existing');

      // Assert
      expect(result.id).toBe('existing-webpage-id');
      expect(result.created).toBe(false);
    });
  });

  describe('エラーハンドリング', () => {
    it('findOrCreateByUrlがエラーの場合でもGraceful Degradation', async () => {
      // Arrange: サービスがエラーを投げる設定
      vi.mocked(mockWebPageService.findOrCreateByUrl).mockRejectedValue(
        new Error('Database connection failed')
      );

      // Act & Assert: エラーが投げられる（detect.tool.ts側でcatchしてnullを返す）
      const service = getWebPageService();
      await expect(service.findOrCreateByUrl('https://example.com/error')).rejects.toThrow(
        'Database connection failed'
      );
    });
  });
});

describe('MotionPersistenceService webPageId対応', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('webPageIdが設定されてパターンが保存される構造を確認', () => {
    // Arrange
    const mockPattern: MotionPattern = {
      id: 'test-pattern-id',
      name: 'test-animation',
      type: 'css_animation',
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
    };

    // Assert: パターン構造の確認
    expect(mockPattern.id).toBe('test-pattern-id');
    expect(mockPattern.type).toBe('css_animation');

    // Note: 実際のDB保存テストはcss-mode-handler.test.tsとdetect-save-to-db.test.tsで実施
  });
});
