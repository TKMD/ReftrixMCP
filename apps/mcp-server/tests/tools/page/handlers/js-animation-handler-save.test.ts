// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * saveJSAnimationPatterns テスト
 *
 * $transaction使用、バッチ分割（PRISMA_CREATE_MANY_BATCH_SIZE=1000）、
 * VARCHARトランケーション、アトミック性（deleteMany+createMany）を検証
 *
 * @module tests/tools/page/handlers/js-animation-handler-save
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveJSAnimationPatterns,
  truncatePatternVarcharFields,
  PRISMA_CREATE_MANY_BATCH_SIZE,
} from '../../../../src/tools/page/handlers/js-animation-handler';
import type {
  JSAnimationPatternCreateData,
  IPageAnalyzePrismaClient,
} from '../../../../src/tools/page/handlers/types';

// =============================================================================
// テストヘルパー
// =============================================================================

/** モックパターン生成 */
function createMockPattern(
  overrides?: Partial<JSAnimationPatternCreateData>
): JSAnimationPatternCreateData {
  return {
    webPageId: 'test-web-page-id',
    libraryType: 'web_animations_api',
    name: 'test-animation',
    animationType: 'keyframe',
    keyframes: [],
    properties: [],
    sourceUrl: 'https://example.com',
    usageScope: 'inspiration_only',
    confidence: 0.9,
    ...overrides,
  };
}

/** N個のモックパターンを生成 */
function createMockPatterns(count: number): JSAnimationPatternCreateData[] {
  return Array.from({ length: count }, (_, i) =>
    createMockPattern({ name: `animation-${i}` })
  );
}

/** $transaction対応のモックPrismaクライアント生成 */
function createMockPrisma(): {
  prisma: IPageAnalyzePrismaClient;
  mockTx: {
    jSAnimationPattern: {
      deleteMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
    };
  };
} {
  const mockTx = {
    jSAnimationPattern: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 10 }),
    },
  };

  const prisma = {
    webPage: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    sectionPattern: {
      create: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    motionPattern: {
      create: vi.fn(),
      createMany: vi.fn(),
    },
    qualityEvaluation: {
      create: vi.fn(),
    },
    jSAnimationPattern: {
      createMany: vi.fn().mockResolvedValue({ count: 10 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    backgroundDesign: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    jSAnimationEmbedding: {
      upsert: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
    $executeRawUnsafe: vi.fn(),
  } as unknown as IPageAnalyzePrismaClient;

  return { prisma, mockTx };
}

// =============================================================================
// テスト本体
// =============================================================================

describe('saveJSAnimationPatterns', () => {
  let prisma: IPageAnalyzePrismaClient;
  let mockTx: ReturnType<typeof createMockPrisma>['mockTx'];

  beforeEach(() => {
    const mock = createMockPrisma();
    prisma = mock.prisma;
    mockTx = mock.mockTx;
  });

  // ---------------------------------------------------------------------------
  // Test 1: 小規模データセット（10パターン）
  // ---------------------------------------------------------------------------
  describe('小規模データセット（10パターン）', () => {
    it('$transactionが1回呼ばれる', async () => {
      const patterns = createMockPatterns(10);
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 10 });

      await saveJSAnimationPatterns(prisma, patterns);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('createManyがトランザクション内で1回だけ呼ばれる（単一バッチ）', async () => {
      const patterns = createMockPatterns(10);
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 10 });

      const result = await saveJSAnimationPatterns(prisma, patterns);

      expect(mockTx.jSAnimationPattern.createMany).toHaveBeenCalledTimes(1);
      expect(result).toBe(10);
    });

    it('createManyに渡されるデータが10件分である', async () => {
      const patterns = createMockPatterns(10);
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 10 });

      await saveJSAnimationPatterns(prisma, patterns);

      const call = mockTx.jSAnimationPattern.createMany.mock.calls[0];
      const data = (call?.[0] as { data: JSAnimationPatternCreateData[] })?.data;
      expect(data).toHaveLength(10);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2: 大規模データセット（1500パターン）
  // ---------------------------------------------------------------------------
  describe('大規模データセット（1500パターン）', () => {
    it('createManyが2回呼ばれる（バッチ1: 1000, バッチ2: 500）', async () => {
      const patterns = createMockPatterns(1500);
      mockTx.jSAnimationPattern.createMany
        .mockResolvedValueOnce({ count: 1000 })
        .mockResolvedValueOnce({ count: 500 });

      const result = await saveJSAnimationPatterns(prisma, patterns);

      expect(mockTx.jSAnimationPattern.createMany).toHaveBeenCalledTimes(2);

      // バッチ1: 1000件
      const batch1 = (mockTx.jSAnimationPattern.createMany.mock.calls[0]?.[0] as {
        data: JSAnimationPatternCreateData[];
      })?.data;
      expect(batch1).toHaveLength(1000);

      // バッチ2: 500件
      const batch2 = (mockTx.jSAnimationPattern.createMany.mock.calls[1]?.[0] as {
        data: JSAnimationPatternCreateData[];
      })?.data;
      expect(batch2).toHaveLength(500);

      // 合計カウント
      expect(result).toBe(1500);
    });

    it('PRISMA_CREATE_MANY_BATCH_SIZEが1000である', () => {
      expect(PRISMA_CREATE_MANY_BATCH_SIZE).toBe(1000);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 3: VARCHARトランケーション
  // ---------------------------------------------------------------------------
  describe('VARCHARトランケーション', () => {
    it('easingフィールドが100文字に切り詰められる', async () => {
      const longEasing = 'a'.repeat(200);
      const patterns = [createMockPattern({ easing: longEasing })];
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 1 });

      await saveJSAnimationPatterns(prisma, patterns);

      const call = mockTx.jSAnimationPattern.createMany.mock.calls[0];
      const data = (call?.[0] as { data: JSAnimationPatternCreateData[] })?.data;
      expect(data?.[0]?.easing).toHaveLength(100);
    });

    it('nameフィールドが200文字に切り詰められる', async () => {
      const longName = 'b'.repeat(300);
      const patterns = [createMockPattern({ name: longName })];
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 1 });

      await saveJSAnimationPatterns(prisma, patterns);

      const call = mockTx.jSAnimationPattern.createMany.mock.calls[0];
      const data = (call?.[0] as { data: JSAnimationPatternCreateData[] })?.data;
      expect(data?.[0]?.name).toHaveLength(200);
    });

    it('directionフィールドが20文字に切り詰められる', async () => {
      const longDirection = 'c'.repeat(50);
      const patterns = [createMockPattern({ direction: longDirection })];
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 1 });

      await saveJSAnimationPatterns(prisma, patterns);

      const call = mockTx.jSAnimationPattern.createMany.mock.calls[0];
      const data = (call?.[0] as { data: JSAnimationPatternCreateData[] })?.data;
      expect(data?.[0]?.direction).toHaveLength(20);
    });

    it('targetSelectorフィールドが500文字に切り詰められる', async () => {
      const longSelector = 'd'.repeat(600);
      const patterns = [createMockPattern({ targetSelector: longSelector })];
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 1 });

      await saveJSAnimationPatterns(prisma, patterns);

      const call = mockTx.jSAnimationPattern.createMany.mock.calls[0];
      const data = (call?.[0] as { data: JSAnimationPatternCreateData[] })?.data;
      expect(data?.[0]?.targetSelector).toHaveLength(500);
    });

    it('fillModeフィールドが20文字に切り詰められる', async () => {
      const longFillMode = 'e'.repeat(30);
      const patterns = [createMockPattern({ fillMode: longFillMode })];
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 1 });

      await saveJSAnimationPatterns(prisma, patterns);

      const call = mockTx.jSAnimationPattern.createMany.mock.calls[0];
      const data = (call?.[0] as { data: JSAnimationPatternCreateData[] })?.data;
      expect(data?.[0]?.fillMode).toHaveLength(20);
    });

    it('libraryVersionフィールドが50文字に切り詰められる', async () => {
      const longVersion = 'f'.repeat(80);
      const patterns = [createMockPattern({ libraryVersion: longVersion })];
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 1 });

      await saveJSAnimationPatterns(prisma, patterns);

      const call = mockTx.jSAnimationPattern.createMany.mock.calls[0];
      const data = (call?.[0] as { data: JSAnimationPatternCreateData[] })?.data;
      expect(data?.[0]?.libraryVersion).toHaveLength(50);
    });

    it('制限内の値はトランケートされない', async () => {
      const patterns = [createMockPattern({
        easing: 'ease-in-out',
        name: 'fadeIn',
        direction: 'normal',
      })];
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 1 });

      await saveJSAnimationPatterns(prisma, patterns);

      const call = mockTx.jSAnimationPattern.createMany.mock.calls[0];
      const data = (call?.[0] as { data: JSAnimationPatternCreateData[] })?.data;
      expect(data?.[0]?.easing).toBe('ease-in-out');
      expect(data?.[0]?.name).toBe('fadeIn');
      expect(data?.[0]?.direction).toBe('normal');
    });
  });

  // ---------------------------------------------------------------------------
  // Test 4: 空パターン
  // ---------------------------------------------------------------------------
  describe('空パターン', () => {
    it('空配列の場合、$transactionが呼ばれず0を返す', async () => {
      const result = await saveJSAnimationPatterns(prisma, []);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(result).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 5: webPageId指定あり（delete + create）
  // ---------------------------------------------------------------------------
  describe('webPageId指定あり（delete + create）', () => {
    it('deleteManyが正しいwebPageIdで呼ばれる', async () => {
      const webPageId = 'test-page-123';
      const patterns = createMockPatterns(5);
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 5 });

      await saveJSAnimationPatterns(prisma, patterns, webPageId);

      expect(mockTx.jSAnimationPattern.deleteMany).toHaveBeenCalledWith({
        where: { webPageId },
      });
    });

    it('deleteManyとcreateManyが同一トランザクション内で実行される', async () => {
      const webPageId = 'test-page-456';
      const patterns = createMockPatterns(3);
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 3 });

      await saveJSAnimationPatterns(prisma, patterns, webPageId);

      // $transactionが呼ばれていること
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      // トランザクション内でdeleteMany→createManyの順で呼ばれていること
      expect(mockTx.jSAnimationPattern.deleteMany).toHaveBeenCalledTimes(1);
      expect(mockTx.jSAnimationPattern.createMany).toHaveBeenCalledTimes(1);

      // 呼び出し順序の検証
      const deleteManyOrder = mockTx.jSAnimationPattern.deleteMany.mock.invocationCallOrder[0];
      const createManyOrder = mockTx.jSAnimationPattern.createMany.mock.invocationCallOrder[0];
      expect(deleteManyOrder).toBeDefined();
      expect(createManyOrder).toBeDefined();
      expect(deleteManyOrder!).toBeLessThan(createManyOrder!);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 6: webPageId未指定（create only）
  // ---------------------------------------------------------------------------
  describe('webPageId未指定（create only）', () => {
    it('deleteManyが呼ばれない', async () => {
      const patterns = createMockPatterns(5);
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 5 });

      await saveJSAnimationPatterns(prisma, patterns);

      expect(mockTx.jSAnimationPattern.deleteMany).not.toHaveBeenCalled();
    });

    it('createManyは正常に呼ばれる', async () => {
      const patterns = createMockPatterns(5);
      mockTx.jSAnimationPattern.createMany.mockResolvedValue({ count: 5 });

      const result = await saveJSAnimationPatterns(prisma, patterns);

      expect(mockTx.jSAnimationPattern.createMany).toHaveBeenCalledTimes(1);
      expect(result).toBe(5);
    });
  });
});

// =============================================================================
// truncatePatternVarcharFields 単体テスト
// =============================================================================

describe('truncatePatternVarcharFields', () => {
  it('各フィールドの制限値が正しい', () => {
    const pattern = createMockPattern({
      name: 'x'.repeat(300),
      libraryVersion: 'v'.repeat(100),
      targetSelector: 's'.repeat(600),
      easing: 'e'.repeat(200),
      direction: 'd'.repeat(50),
      fillMode: 'f'.repeat(50),
      triggerType: 't'.repeat(100),
      cdpAnimationId: 'c'.repeat(200),
      cdpSourceType: 'p'.repeat(100),
      cdpPlayState: 'q'.repeat(50),
    });

    const truncated = truncatePatternVarcharFields(pattern);

    expect(truncated.name).toHaveLength(200);
    expect(truncated.libraryVersion).toHaveLength(50);
    expect(truncated.targetSelector).toHaveLength(500);
    expect(truncated.easing).toHaveLength(100);
    expect(truncated.direction).toHaveLength(20);
    expect(truncated.fillMode).toHaveLength(20);
    expect(truncated.triggerType).toHaveLength(50);
    expect(truncated.cdpAnimationId).toHaveLength(100);
    expect(truncated.cdpSourceType).toHaveLength(50);
    expect(truncated.cdpPlayState).toHaveLength(20);
  });

  it('nullフィールドはnullのまま保持される', () => {
    const pattern = createMockPattern({
      easing: null,
      direction: null,
      fillMode: null,
      targetSelector: null,
      libraryVersion: null,
    });

    const truncated = truncatePatternVarcharFields(pattern);

    expect(truncated.easing).toBeNull();
    expect(truncated.direction).toBeNull();
    expect(truncated.fillMode).toBeNull();
    expect(truncated.targetSelector).toBeNull();
    expect(truncated.libraryVersion).toBeNull();
  });

  it('undefinedフィールドはundefinedのまま保持される', () => {
    const pattern = createMockPattern({
      easing: undefined,
      direction: undefined,
    });

    const truncated = truncatePatternVarcharFields(pattern);

    expect(truncated.easing).toBeUndefined();
    expect(truncated.direction).toBeUndefined();
  });

  it('制限内の値は変更されない', () => {
    const pattern = createMockPattern({
      name: 'fadeIn',
      easing: 'ease-out',
      direction: 'normal',
    });

    const truncated = truncatePatternVarcharFields(pattern);

    expect(truncated.name).toBe('fadeIn');
    expect(truncated.easing).toBe('ease-out');
    expect(truncated.direction).toBe('normal');
  });
});
