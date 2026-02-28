// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BackgroundDesign DB Service Unit Tests
 *
 * saveBackgroundDesigns のユニットテスト（Mock Prismaクライアント使用）
 *
 * テスト対象:
 * - 正常系: 背景デザインの保存
 * - 空配列の処理
 * - エラーハンドリング
 * - UUIDv7 生成の検証
 * - deleteMany → createMany の順序（クリーンスレート）
 *
 * @module tests/services/background/background-design-db.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveBackgroundDesigns,
  type BackgroundDesignForSave,
  type SaveBackgroundDesignsResult,
} from '../../../src/services/background/background-design-db.service.js';

// UUID v7 の正規表現パターン（概略: 32桁16進数 + ハイフン区切り）
const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Mock Prisma Client を生成
 */
function createMockPrismaClient(): {
  backgroundDesign: {
    deleteMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
} {
  return {
    backgroundDesign: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

/**
 * テスト用の BackgroundDesignForSave を生成
 */
function createTestBackground(
  overrides: Partial<BackgroundDesignForSave> = {}
): BackgroundDesignForSave {
  return {
    name: 'hero linear gradient, 135deg',
    designType: 'linear_gradient',
    cssValue: 'linear-gradient(135deg, #1a1a2e, #16213e)',
    selector: '.hero',
    positionIndex: 0,
    colorInfo: {
      dominantColors: ['#1a1a2e', '#16213e'],
      colorCount: 2,
      hasAlpha: false,
      colorSpace: 'srgb',
    },
    visualProperties: {
      blurRadius: 0,
      opacity: 1,
      blendMode: 'normal',
      hasOverlay: false,
      layers: 1,
    },
    performance: {
      gpuAccelerated: false,
      triggersPaint: true,
      estimatedImpact: 'low',
    },
    confidence: 0.9,
    cssImplementation: '  background: linear-gradient(135deg, #1a1a2e, #16213e);',
    ...overrides,
  };
}

describe('saveBackgroundDesigns', () => {
  let mockPrisma: ReturnType<typeof createMockPrismaClient>;

  beforeEach(() => {
    mockPrisma = createMockPrismaClient();
  });

  // =========================================================================
  // 正常系
  // =========================================================================

  describe('正常系', () => {
    it('背景デザインが正しく保存されること', async () => {
      const backgrounds: BackgroundDesignForSave[] = [
        createTestBackground(),
        createTestBackground({
          name: 'footer solid background',
          designType: 'solid_color',
          cssValue: '#1a1a2e',
          selector: '.footer',
          positionIndex: 1,
        }),
      ];

      mockPrisma.backgroundDesign.createMany.mockResolvedValue({ count: 2 });

      const result: SaveBackgroundDesignsResult = await saveBackgroundDesigns(
        mockPrisma,
        'test-web-page-id',
        backgrounds
      );

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.ids).toHaveLength(2);
      // UUIDv7 形式であることを確認
      for (const id of result.ids) {
        expect(id).toMatch(UUID_V7_REGEX);
      }
      expect(result.error).toBeUndefined();
    });

    it('deleteMany が createMany の前に呼ばれること（クリーンスレート）', async () => {
      const backgrounds: BackgroundDesignForSave[] = [createTestBackground()];
      mockPrisma.backgroundDesign.createMany.mockResolvedValue({ count: 1 });

      const callOrder: string[] = [];
      mockPrisma.backgroundDesign.deleteMany.mockImplementation(async () => {
        callOrder.push('deleteMany');
        return { count: 0 };
      });
      mockPrisma.backgroundDesign.createMany.mockImplementation(async () => {
        callOrder.push('createMany');
        return { count: 1 };
      });

      await saveBackgroundDesigns(mockPrisma, 'test-web-page-id', backgrounds);

      expect(callOrder).toEqual(['deleteMany', 'createMany']);
    });

    it('deleteMany に正しい webPageId が渡されること', async () => {
      const backgrounds: BackgroundDesignForSave[] = [createTestBackground()];
      mockPrisma.backgroundDesign.createMany.mockResolvedValue({ count: 1 });

      await saveBackgroundDesigns(mockPrisma, 'my-page-id-123', backgrounds);

      expect(mockPrisma.backgroundDesign.deleteMany).toHaveBeenCalledWith({
        where: { webPageId: 'my-page-id-123' },
      });
    });

    it('createMany に正しいデータ構造が渡されること', async () => {
      const bg = createTestBackground({
        gradientInfo: {
          type: 'linear',
          angle: 135,
          stops: [
            { color: '#1a1a2e', position: 0 },
            { color: '#16213e', position: 1 },
          ],
          repeating: false,
        },
        animationInfo: {
          isAnimated: false,
        },
        sourceUrl: 'https://example.com',
        usageScope: 'user_provided',
        tags: ['gradient', 'dark'],
      });

      mockPrisma.backgroundDesign.createMany.mockResolvedValue({ count: 1 });

      await saveBackgroundDesigns(mockPrisma, 'web-page-id', [bg]);

      const createManyCall = mockPrisma.backgroundDesign.createMany.mock.calls[0]?.[0];
      expect(createManyCall).toBeDefined();

      const data = createManyCall.data;
      expect(data).toHaveLength(1);

      const saved = data[0];
      // ID はUUIDv7
      expect(saved.id).toMatch(UUID_V7_REGEX);
      // webPageId
      expect(saved.webPageId).toBe('web-page-id');
      // 基本フィールド
      expect(saved.name).toBe(bg.name);
      expect(saved.designType).toBe(bg.designType);
      expect(saved.cssValue).toBe(bg.cssValue);
      expect(saved.selector).toBe(bg.selector);
      expect(saved.positionIndex).toBe(bg.positionIndex);
      // JSON フィールド
      expect(saved.colorInfo).toEqual(bg.colorInfo);
      expect(saved.gradientInfo).toEqual(bg.gradientInfo);
      expect(saved.visualProperties).toEqual(bg.visualProperties);
      expect(saved.animationInfo).toEqual(bg.animationInfo);
      expect(saved.performance).toEqual(bg.performance);
      // メタデータ
      expect(saved.confidence).toBe(0.9);
      expect(saved.sourceUrl).toBe('https://example.com');
      expect(saved.usageScope).toBe('user_provided');
      expect(saved.tags).toEqual(['gradient', 'dark']);
      expect(saved.metadata).toEqual({});
      // cssImplementation
      expect(saved.cssImplementation).toBe(bg.cssImplementation);
    });

    it('オプショナルフィールドが未指定の場合にデフォルト値が設定されること', async () => {
      const bg = createTestBackground({
        gradientInfo: undefined,
        animationInfo: undefined,
        sourceUrl: undefined,
        usageScope: undefined,
        tags: undefined,
      });

      mockPrisma.backgroundDesign.createMany.mockResolvedValue({ count: 1 });

      await saveBackgroundDesigns(mockPrisma, 'web-page-id', [bg]);

      const saved = mockPrisma.backgroundDesign.createMany.mock.calls[0]?.[0].data[0];
      expect(saved.gradientInfo).toBeUndefined();
      expect(saved.animationInfo).toBeUndefined();
      expect(saved.sourceUrl).toBeUndefined();
      expect(saved.usageScope).toBe('inspiration_only');
      expect(saved.tags).toEqual([]);
    });
  });

  // =========================================================================
  // 空配列
  // =========================================================================

  describe('空配列', () => {
    it('空配列の場合は成功を返しDB操作をスキップすること', async () => {
      const result = await saveBackgroundDesigns(
        mockPrisma,
        'test-web-page-id',
        []
      );

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
      expect(result.ids).toEqual([]);
      expect(result.error).toBeUndefined();
      // DB操作はスキップ
      expect(mockPrisma.backgroundDesign.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.backgroundDesign.createMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // エラーハンドリング
  // =========================================================================

  describe('エラーハンドリング', () => {
    it('deleteMany 失敗時にエラーを返すこと', async () => {
      mockPrisma.backgroundDesign.deleteMany.mockRejectedValue(
        new Error('Connection refused')
      );

      const result = await saveBackgroundDesigns(
        mockPrisma,
        'test-web-page-id',
        [createTestBackground()]
      );

      expect(result.success).toBe(false);
      expect(result.count).toBe(0);
      expect(result.ids).toEqual([]);
      expect(result.error).toBe('Connection refused');
    });

    it('createMany 失敗時にエラーを返すこと', async () => {
      mockPrisma.backgroundDesign.createMany.mockRejectedValue(
        new Error('Unique constraint violation')
      );

      const result = await saveBackgroundDesigns(
        mockPrisma,
        'test-web-page-id',
        [createTestBackground()]
      );

      expect(result.success).toBe(false);
      expect(result.count).toBe(0);
      expect(result.ids).toEqual([]);
      expect(result.error).toBe('Unique constraint violation');
    });

    it('非Errorオブジェクトのエラーでも処理できること', async () => {
      mockPrisma.backgroundDesign.createMany.mockRejectedValue('string error');

      const result = await saveBackgroundDesigns(
        mockPrisma,
        'test-web-page-id',
        [createTestBackground()]
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to save background designs');
    });
  });

  // =========================================================================
  // UUIDv7 生成
  // =========================================================================

  describe('UUIDv7 生成', () => {
    it('各背景デザインに一意のUUIDv7が割り当てられること', async () => {
      const backgrounds = [
        createTestBackground({ positionIndex: 0 }),
        createTestBackground({ positionIndex: 1 }),
        createTestBackground({ positionIndex: 2 }),
      ];

      mockPrisma.backgroundDesign.createMany.mockResolvedValue({ count: 3 });

      const result = await saveBackgroundDesigns(
        mockPrisma,
        'test-web-page-id',
        backgrounds
      );

      expect(result.ids).toHaveLength(3);
      // すべて一意であること
      const uniqueIds = new Set(result.ids);
      expect(uniqueIds.size).toBe(3);
      // すべてUUIDv7形式であること
      for (const id of result.ids) {
        expect(id).toMatch(UUID_V7_REGEX);
      }
    });
  });

  // =========================================================================
  // idMapping と name 重複
  // =========================================================================

  describe('idMapping と name 重複', () => {
    it('idMappingのサイズがids配列と一致すること（ユニーク名の場合）', async () => {
      const backgrounds = [
        createTestBackground({ name: 'gradient-bg', positionIndex: 0 }),
        createTestBackground({ name: 'solid-bg', positionIndex: 1 }),
      ];

      mockPrisma.backgroundDesign.createMany.mockResolvedValue({ count: 2 });

      const result = await saveBackgroundDesigns(
        mockPrisma,
        'test-web-page-id',
        backgrounds
      );

      expect(result.ids).toHaveLength(2);
      expect(result.idMapping.size).toBe(2);
      // 各nameに対応するIDが存在
      expect(result.idMapping.get('gradient-bg')).toBe(result.ids[0]);
      expect(result.idMapping.get('solid-bg')).toBe(result.ids[1]);
    });

    it('同名の背景デザインがある場合、idMappingで最後のエントリだけが残ること（既知の制限）', async () => {
      // この テストは現在の idMapping の制限を文書化する
      // name重複時はidMappingの代わりにids配列を使用してEmbedding生成すべき
      const backgrounds = [
        createTestBackground({ name: 'section solid color background', positionIndex: 0 }),
        createTestBackground({ name: 'section solid color background', positionIndex: 1 }),
        createTestBackground({ name: 'section solid color background', positionIndex: 2 }),
      ];

      mockPrisma.backgroundDesign.createMany.mockResolvedValue({ count: 3 });

      const result = await saveBackgroundDesigns(
        mockPrisma,
        'test-web-page-id',
        backgrounds
      );

      // ids配列は全3件分のIDを持つ
      expect(result.ids).toHaveLength(3);
      const uniqueIds = new Set(result.ids);
      expect(uniqueIds.size).toBe(3); // 全て一意

      // idMappingは同名で上書きされるため、最後のエントリのIDだけが残る
      expect(result.idMapping.size).toBe(1);
      expect(result.idMapping.get('section solid color background')).toBe(result.ids[2]);
    });

    it('ids配列の順序がbackgrounds配列と1:1対応すること', async () => {
      const backgrounds = [
        createTestBackground({ name: 'bg-a', positionIndex: 0 }),
        createTestBackground({ name: 'bg-b', positionIndex: 1 }),
        createTestBackground({ name: 'bg-c', positionIndex: 2 }),
      ];

      mockPrisma.backgroundDesign.createMany.mockResolvedValue({ count: 3 });

      const result = await saveBackgroundDesigns(
        mockPrisma,
        'test-web-page-id',
        backgrounds
      );

      // ids[i] は backgrounds[i] に対応するDB ID
      expect(result.ids).toHaveLength(3);

      // createMany呼び出しのデータ順序を確認
      const createManyData = mockPrisma.backgroundDesign.createMany.mock.calls[0]?.[0].data;
      expect(createManyData).toHaveLength(3);
      expect(createManyData[0].id).toBe(result.ids[0]);
      expect(createManyData[1].id).toBe(result.ids[1]);
      expect(createManyData[2].id).toBe(result.ids[2]);
      expect(createManyData[0].name).toBe('bg-a');
      expect(createManyData[1].name).toBe('bg-b');
      expect(createManyData[2].name).toBe('bg-c');
    });
  });
});
