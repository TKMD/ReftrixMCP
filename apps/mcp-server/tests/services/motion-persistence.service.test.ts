// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion-persistence.service.ts ユニットテスト
 *
 * MotionPatternPersistenceService の動作検証
 * - ファクトリ登録の検証
 * - isAvailable() の動作確認
 * - savePattern() / savePatterns() の動作確認
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MotionPatternPersistenceService,
  setMotionPersistenceEmbeddingServiceFactory,
  setMotionPersistencePrismaClientFactory,
  resetMotionPersistenceEmbeddingServiceFactory,
  resetMotionPersistencePrismaClientFactory,
  getMotionPersistenceService,
  resetMotionPersistenceService,
  patternToTextRepresentation,
  mapCategoryToDb,
  mapTriggerToDb,
  type IEmbeddingService,
  type IPrismaClient,
} from '../../src/services/motion-persistence.service';
import type { MotionPattern } from '../../src/tools/motion/schemas';

// テスト用モックデータ
const createMockPattern = (overrides?: Partial<MotionPattern>): MotionPattern => ({
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
  properties: [
    {
      property: 'opacity',
      from: '0',
      to: '1',
    },
  ],
  keyframes: [],
  ...overrides,
});

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

describe('MotionPatternPersistenceService', () => {
  beforeEach(() => {
    // 各テスト前にファクトリをリセット
    resetMotionPersistenceEmbeddingServiceFactory();
    resetMotionPersistencePrismaClientFactory();
    resetMotionPersistenceService();
  });

  afterEach(() => {
    // 各テスト後にファクトリをリセット
    resetMotionPersistenceEmbeddingServiceFactory();
    resetMotionPersistencePrismaClientFactory();
    resetMotionPersistenceService();
  });

  describe('ファクトリ登録', () => {
    it('ファクトリ未登録時、isAvailable() は false を返す', () => {
      const service = new MotionPatternPersistenceService();
      expect(service.isAvailable()).toBe(false);
    });

    it('EmbeddingServiceファクトリのみ登録時、isAvailable() は false を返す', () => {
      setMotionPersistenceEmbeddingServiceFactory(createMockEmbeddingService);
      const service = new MotionPatternPersistenceService();
      expect(service.isAvailable()).toBe(false);
    });

    it('PrismaClientファクトリのみ登録時、isAvailable() は true を返す', () => {
      // PrismaClientファクトリが登録されていれば isAvailable() は true
      // EmbeddingServiceは savePattern() 時に必要だが isAvailable() には影響しない
      setMotionPersistencePrismaClientFactory(createMockPrismaClient);
      const service = new MotionPatternPersistenceService();
      expect(service.isAvailable()).toBe(true);
    });

    it('両方のファクトリ登録時、isAvailable() は true を返す', () => {
      setMotionPersistenceEmbeddingServiceFactory(createMockEmbeddingService);
      setMotionPersistencePrismaClientFactory(createMockPrismaClient);
      const service = new MotionPatternPersistenceService();
      expect(service.isAvailable()).toBe(true);
    });
  });

  describe('getMotionPersistenceService シングルトン', () => {
    it('同じインスタンスを返す', () => {
      const service1 = getMotionPersistenceService();
      const service2 = getMotionPersistenceService();
      expect(service1).toBe(service2);
    });

    it('resetMotionPersistenceService() 後は新しいインスタンスを返す', () => {
      const service1 = getMotionPersistenceService();
      resetMotionPersistenceService();
      const service2 = getMotionPersistenceService();
      expect(service1).not.toBe(service2);
    });
  });

  describe('savePattern', () => {
    it('ファクトリ未登録時、エラーをスローする', async () => {
      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern();

      await expect(service.savePattern({ pattern })).rejects.toThrow('PrismaClient not initialized');
    });

    it('PrismaClientファクトリのみ登録時、Embedding生成エラーでも保存は成功する', async () => {
      const mockPrisma = createMockPrismaClient();
      setMotionPersistencePrismaClientFactory(() => mockPrisma);
      // EmbeddingServiceファクトリは登録しない（Embedding生成は失敗する）

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern();

      // Embedding生成失敗でも savePattern は成功する（embedding は空で保存）
      const result = await service.savePattern({ pattern });

      expect(result.patternId).toBe('mock-pattern-id');
      expect(result.embeddingId).toBe('mock-embedding-id');
      expect(mockPrisma.motionPattern.create).toHaveBeenCalled();
      expect(mockPrisma.motionEmbedding.create).toHaveBeenCalled();
      // $executeRawUnsafe は embedding が空なので呼ばれない
      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('両方のファクトリ登録時、正常に保存できる', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern();

      const result = await service.savePattern({ pattern });

      expect(result.patternId).toBe('mock-pattern-id');
      expect(result.embeddingId).toBe('mock-embedding-id');
      expect(mockPrisma.motionPattern.create).toHaveBeenCalled();
      expect(mockPrisma.motionEmbedding.create).toHaveBeenCalled();
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled();
    });

    it('webPageId と sourceUrl が正しく保存される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern();

      await service.savePattern({
        pattern,
        webPageId: 'test-webpage-id',
        sourceUrl: 'https://example.com',
      });

      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.webPageId).toBe('test-webpage-id');
      expect(createCall[0].data.sourceUrl).toBe('https://example.com');
    });
  });

  describe('savePatterns（一括保存）', () => {
    it('空配列の場合、savedCount は 0 を返す', async () => {
      const service = new MotionPatternPersistenceService();
      const result = await service.savePatterns([]);

      expect(result.saved).toBe(true); // 空でも saved は true（0件正常処理）
      expect(result.savedCount).toBe(0);
      expect(result.patternIds).toHaveLength(0);
      expect(result.embeddingIds).toHaveLength(0);
    });

    it('複数パターンを保存できる', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const patterns = [
        createMockPattern({ name: 'pattern-1' }),
        createMockPattern({ name: 'pattern-2' }),
        createMockPattern({ name: 'pattern-3' }),
      ];

      const result = await service.savePatterns(patterns);

      expect(result.saved).toBe(true);
      expect(result.savedCount).toBe(3);
      expect(result.patternIds).toHaveLength(3);
      expect(result.embeddingIds).toHaveLength(3);
    });

    it('continueOnError=true の場合、エラーがあっても続行する', async () => {
      let callCount = 0;
      const mockPrisma: IPrismaClient = {
        motionPattern: {
          create: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 2) {
              throw new Error('Mock error on pattern 2');
            }
            return Promise.resolve({ id: `mock-pattern-id-${callCount}` });
          }),
        },
        motionEmbedding: {
          create: vi.fn().mockResolvedValue({ id: 'mock-embedding-id' }),
        },
        $executeRawUnsafe: vi.fn().mockResolvedValue(1),
        $transaction: vi.fn().mockImplementation((fn) => fn(mockPrisma)),
      };
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const patterns = [
        createMockPattern({ name: 'pattern-1' }),
        createMockPattern({ name: 'pattern-2' }), // エラー
        createMockPattern({ name: 'pattern-3' }),
      ];

      const result = await service.savePatterns(patterns, { continueOnError: true });

      // 2つ目でエラーが発生しても、1つ目と3つ目は保存成功
      expect(result.saved).toBe(true);
      expect(result.savedCount).toBe(2);
      expect(result.patternIds).toHaveLength(2);
    });

    it('continueOnError=false の場合、エラー発生時に例外をスローする', async () => {
      let callCount = 0;
      const mockPrisma: IPrismaClient = {
        motionPattern: {
          create: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 2) {
              throw new Error('Mock error on pattern 2');
            }
            return Promise.resolve({ id: `mock-pattern-id-${callCount}` });
          }),
        },
        motionEmbedding: {
          create: vi.fn().mockResolvedValue({ id: 'mock-embedding-id' }),
        },
        $executeRawUnsafe: vi.fn().mockResolvedValue(1),
        $transaction: vi.fn().mockImplementation((fn) => fn(mockPrisma)),
      };
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const patterns = [
        createMockPattern({ name: 'pattern-1' }),
        createMockPattern({ name: 'pattern-2' }), // エラー
        createMockPattern({ name: 'pattern-3' }),
      ];

      await expect(
        service.savePatterns(patterns, { continueOnError: false })
      ).rejects.toThrow('Mock error on pattern 2');
    });

    it('options が undefined の場合、デフォルト値で処理される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const patterns = [createMockPattern({ name: 'pattern-1' })];

      // options を省略して呼び出し
      const result = await service.savePatterns(patterns);

      expect(result.saved).toBe(true);
      expect(result.savedCount).toBe(1);
    });

    it('webPageId と sourceUrl が savePattern に渡される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const patterns = [createMockPattern({ name: 'pattern-1' })];

      await service.savePatterns(patterns, {
        webPageId: 'test-page-id',
        sourceUrl: 'https://example.com/test',
      });

      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.webPageId).toBe('test-page-id');
      expect(createCall[0].data.sourceUrl).toBe('https://example.com/test');
    });

    it('全パターン失敗時は saved=false と reason が設定される', async () => {
      const mockPrisma: IPrismaClient = {
        motionPattern: {
          create: vi.fn().mockRejectedValue(new Error('Database connection failed')),
        },
        motionEmbedding: {
          create: vi.fn().mockResolvedValue({ id: 'mock-embedding-id' }),
        },
        $executeRawUnsafe: vi.fn().mockResolvedValue(1),
        $transaction: vi.fn().mockImplementation((fn) => fn(mockPrisma)),
      };

      setMotionPersistencePrismaClientFactory(() => mockPrisma);
      setMotionPersistenceEmbeddingServiceFactory(createMockEmbeddingService);

      const service = new MotionPatternPersistenceService();
      const patterns = [
        createMockPattern({ name: 'pattern-1' }),
        createMockPattern({ name: 'pattern-2' }),
      ];

      const result = await service.savePatterns(patterns, { continueOnError: true });

      expect(result.saved).toBe(false);
      expect(result.savedCount).toBe(0);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain('Database connection failed');
    });
  });

  // =====================================================
  // patternToTextRepresentation 関数テスト
  // =====================================================
  describe('patternToTextRepresentation', () => {
    it('基本的なパターンでテキスト表現を生成する', () => {
      const pattern = createMockPattern();
      const result = patternToTextRepresentation(pattern);

      expect(result).toContain('css_animation animation');
      expect(result).toContain('name: test-animation');
      expect(result).toContain('category: entrance');
      expect(result).toContain('trigger: load');
      expect(result).toContain('duration: 300ms');
      expect(result).toContain('easing: ease');
      expect(result).toContain('iterations: 1');
      expect(result).toContain('properties: opacity');
      expect(result).toContain('selector: .test');
      expect(result.endsWith('.')).toBe(true);
    });

    it('name が undefined の場合、name 部分は含まれない', () => {
      const pattern = createMockPattern({ name: undefined });
      const result = patternToTextRepresentation(pattern);

      expect(result).not.toContain('name:');
      expect(result).toContain('css_animation animation');
    });

    it('duration が undefined の場合、duration 部分は含まれない', () => {
      const pattern = createMockPattern({
        animation: {
          easing: { type: 'ease' },
          iterations: 1,
          direction: 'normal',
          fillMode: 'none',
        },
      });
      const result = patternToTextRepresentation(pattern);

      expect(result).not.toContain('duration:');
    });

    it('easing が undefined の場合、easing 部分は含まれない', () => {
      const pattern = createMockPattern({
        animation: {
          duration: 300,
          delay: 0,
          iterations: 1,
          direction: 'normal',
          fillMode: 'none',
        },
      });
      const result = patternToTextRepresentation(pattern);

      expect(result).not.toContain('easing:');
    });

    it('easing.type が undefined の場合、easing 部分は含まれない', () => {
      const pattern = createMockPattern({
        animation: {
          duration: 300,
          delay: 0,
          easing: {},
          iterations: 1,
          direction: 'normal',
          fillMode: 'none',
        },
      });
      const result = patternToTextRepresentation(pattern);

      expect(result).not.toContain('easing:');
    });

    it('iterations が undefined の場合、iterations 部分は含まれない', () => {
      const pattern = createMockPattern({
        animation: {
          duration: 300,
          delay: 0,
          easing: { type: 'ease' },
          direction: 'normal',
          fillMode: 'none',
        },
      });
      const result = patternToTextRepresentation(pattern);

      expect(result).not.toContain('iterations:');
    });

    it('空の properties 配列の場合、properties 部分は含まれない', () => {
      const pattern = createMockPattern({ properties: [] });
      const result = patternToTextRepresentation(pattern);

      expect(result).not.toContain('properties:');
    });

    it('複数の properties がカンマ区切りで含まれる', () => {
      const pattern = createMockPattern({
        properties: [
          { property: 'opacity', from: '0', to: '1' },
          { property: 'transform', from: 'scale(0)', to: 'scale(1)' },
          { property: 'visibility', from: 'hidden', to: 'visible' },
        ],
      });
      const result = patternToTextRepresentation(pattern);

      expect(result).toContain('properties: opacity, transform, visibility');
    });

    it('selector が undefined の場合、selector 部分は含まれない', () => {
      const pattern = createMockPattern({ selector: undefined });
      const result = patternToTextRepresentation(pattern);

      expect(result).not.toContain('selector:');
    });

    it('iterations が "infinite" の場合も正しく出力される', () => {
      const pattern = createMockPattern({
        animation: {
          duration: 300,
          delay: 0,
          easing: { type: 'ease' },
          iterations: 'infinite' as unknown as number, // スキーマ上は number | 'infinite'
          direction: 'normal',
          fillMode: 'none',
        },
      });
      const result = patternToTextRepresentation(pattern);

      expect(result).toContain('iterations: infinite');
    });

    it('全プロパティが欠落した最小パターンでも動作する', () => {
      const minimalPattern: MotionPattern = {
        type: 'css_transition',
        category: 'hover_effect',
        trigger: 'hover',
        animation: {},
        properties: [],
      };
      const result = patternToTextRepresentation(minimalPattern);

      expect(result).toContain('css_transition animation');
      expect(result).toContain('category: hover_effect');
      expect(result).toContain('trigger: hover');
      expect(result.endsWith('.')).toBe(true);
    });

    it('複雑なパターン（全プロパティあり）で正しく動作する', () => {
      const complexPattern = createMockPattern({
        type: 'keyframes',
        name: 'complex-animation-with-long-name',
        category: 'scroll_trigger',
        trigger: 'scroll',
        selector: '.complex-selector > .child',
        animation: {
          duration: 1500,
          delay: 100,
          easing: { type: 'cubic-bezier' },
          iterations: 3,
          direction: 'alternate',
          fillMode: 'forwards',
        },
        properties: [
          { property: 'transform', from: 'translateX(0)', to: 'translateX(100px)' },
          { property: 'opacity', from: '0', to: '1' },
          { property: 'color', from: '#000', to: '#fff' },
        ],
      });
      const result = patternToTextRepresentation(complexPattern);

      expect(result).toContain('keyframes animation');
      expect(result).toContain('name: complex-animation-with-long-name');
      expect(result).toContain('category: scroll_trigger');
      expect(result).toContain('trigger: scroll');
      expect(result).toContain('duration: 1500ms');
      expect(result).toContain('easing: cubic-bezier');
      expect(result).toContain('iterations: 3');
      expect(result).toContain('properties: transform, opacity, color');
      expect(result).toContain('selector: .complex-selector > .child');
    });
  });

  // =====================================================
  // mapCategoryToDb / mapTriggerToDb 関数テスト
  // =====================================================
  describe('mapCategoryToDb', () => {
    it('カテゴリをそのまま返す', () => {
      expect(mapCategoryToDb('entrance')).toBe('entrance');
      expect(mapCategoryToDb('exit')).toBe('exit');
      expect(mapCategoryToDb('hover_effect')).toBe('hover_effect');
      expect(mapCategoryToDb('scroll_trigger')).toBe('scroll_trigger');
      expect(mapCategoryToDb('micro_interaction')).toBe('micro_interaction');
      expect(mapCategoryToDb('loading_state')).toBe('loading_state');
      expect(mapCategoryToDb('page_transition')).toBe('page_transition');
    });

    it('空文字列もそのまま返す', () => {
      expect(mapCategoryToDb('')).toBe('');
    });

    it('特殊文字を含むカテゴリもそのまま返す', () => {
      expect(mapCategoryToDb('custom-category_123')).toBe('custom-category_123');
    });
  });

  describe('mapTriggerToDb', () => {
    it('トリガーをそのまま返す', () => {
      expect(mapTriggerToDb('load')).toBe('load');
      expect(mapTriggerToDb('hover')).toBe('hover');
      expect(mapTriggerToDb('click')).toBe('click');
      expect(mapTriggerToDb('scroll')).toBe('scroll');
      expect(mapTriggerToDb('focus')).toBe('focus');
      expect(mapTriggerToDb('custom')).toBe('custom');
    });

    it('空文字列もそのまま返す', () => {
      expect(mapTriggerToDb('')).toBe('');
    });

    it('特殊文字を含むトリガーもそのまま返す', () => {
      expect(mapTriggerToDb('custom-trigger_456')).toBe('custom-trigger_456');
    });
  });

  // =====================================================
  // savePattern 詳細テスト
  // =====================================================
  describe('savePattern 詳細テスト', () => {
    it('webPageId が undefined の場合、data に webPageId プロパティが含まれない', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern();

      await service.savePattern({ pattern, webPageId: undefined });

      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data).not.toHaveProperty('webPageId');
    });

    it('sourceUrl が undefined の場合、data に sourceUrl プロパティが含まれない', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern();

      await service.savePattern({ pattern, sourceUrl: undefined });

      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data).not.toHaveProperty('sourceUrl');
    });

    it('pattern.name が undefined の場合、自動生成名が使用される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern({ name: undefined, type: 'css_animation', category: 'entrance' });

      await service.savePattern({ pattern });

      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.name).toBe('css_animation_entrance');
    });

    it('animation の各プロパティが正しく保存される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const animation = {
        duration: 500,
        delay: 100,
        easing: { type: 'ease-in-out' },
        iterations: 2,
        direction: 'alternate',
        fillMode: 'forwards',
      };
      const pattern = createMockPattern({ animation });

      await service.savePattern({ pattern });

      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.animation).toEqual(animation);
    });

    it('accessibility プロパティが保存される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern({
        accessibility: { respectsReducedMotion: true },
      });

      await service.savePattern({ pattern });

      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.accessibility).toEqual({ respectsReducedMotion: true });
    });

    it('performance プロパティが保存される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern({
        performance: {
          usesTransform: true,
          usesOpacity: true,
          triggersLayout: false,
          triggersPaint: false,
          level: 'good',
        },
      });

      await service.savePattern({ pattern });

      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.performance).toEqual({
        usesTransform: true,
        usesOpacity: true,
        triggersLayout: false,
        triggersPaint: false,
        level: 'good',
      });
    });

    it('accessibility が undefined の場合、空オブジェクトが保存される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern({ accessibility: undefined });

      await service.savePattern({ pattern });

      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.accessibility).toEqual({});
    });

    it('performance が undefined の場合、空オブジェクトが保存される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern({ performance: undefined });

      await service.savePattern({ pattern });

      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.performance).toEqual({});
    });

    it('metadata に selector と keyframes が含まれる', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern({
        selector: '.my-selector',
        keyframes: [{ offset: 0, properties: { opacity: '0' } }],
      });

      await service.savePattern({ pattern });

      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.metadata).toEqual({
        selector: '.my-selector',
        keyframes: [{ offset: 0, properties: { opacity: '0' } }],
      });
    });
  });

  // =====================================================
  // Embedding ベクトル更新テスト
  // =====================================================
  describe('Embedding ベクトル更新', () => {
    it('embedding が生成された場合、$executeRawUnsafe で更新される', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern();

      await service.savePattern({ pattern });

      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(
        'UPDATE motion_embeddings SET embedding = $1::vector WHERE id = $2::uuid',
        expect.stringMatching(/^\[[\d.,]+\]$/),
        'mock-embedding-id'
      );
    });

    it('vectorString が正しい形式で生成される', async () => {
      const mockPrisma = createMockPrismaClient();
      // Phase6-SEC-2: 768次元のベクトルを使用
      const mockVector = new Array(768).fill(0.1);
      const mockEmbeddingService: IEmbeddingService = {
        generateEmbedding: vi.fn().mockResolvedValue(mockVector),
      };

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingService);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern();

      await service.savePattern({ pattern });

      const executeCall = (mockPrisma.$executeRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      // 768次元のベクトルが正しくフォーマットされていることを確認
      expect(executeCall[1]).toMatch(/^\[[\d.,]+\]$/);
      expect(executeCall[1]).toContain('0.1');
    });

    it('embedding が空配列の場合、検証エラーがスローされる（Phase6-SEC-2対応）', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbeddingService: IEmbeddingService = {
        generateEmbedding: vi.fn().mockResolvedValue([]),
      };

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingService);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern();

      // Phase6-SEC-2: 空配列は検証エラーとしてスローされる
      await expect(service.savePattern({ pattern })).rejects.toThrow(/dimension|768|empty/i);

      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('embedding 生成エラー時、$executeRawUnsafe は呼ばれない', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbeddingService: IEmbeddingService = {
        generateEmbedding: vi.fn().mockRejectedValue(new Error('Embedding service unavailable')),
      };

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingService);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern();

      // エラーでも保存は成功する
      const result = await service.savePattern({ pattern });

      expect(result.patternId).toBe('mock-pattern-id');
      expect(result.embeddingId).toBe('mock-embedding-id');
      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // エッジケース
  // =====================================================
  describe('エッジケース', () => {
    it('pattern.selector が null の場合でも動作する', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern({ selector: null as unknown as string });

      const result = await service.savePattern({ pattern });

      expect(result.patternId).toBe('mock-pattern-id');
    });

    it('pattern.keyframes が空配列の場合でも動作する', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern({ keyframes: [] });

      const result = await service.savePattern({ pattern });

      expect(result.patternId).toBe('mock-pattern-id');
      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.metadata).toEqual({
        selector: '.test',
        keyframes: [],
      });
    });

    it('pattern.keyframes が undefined の場合でも動作する', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern({ keyframes: undefined });

      const result = await service.savePattern({ pattern });

      expect(result.patternId).toBe('mock-pattern-id');
    });

    it('極端に長い pattern.name でも動作する', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const longName = 'a'.repeat(1000);
      const pattern = createMockPattern({ name: longName });

      const result = await service.savePattern({ pattern });

      expect(result.patternId).toBe('mock-pattern-id');
      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.name).toBe(longName);
    });

    it('特殊文字を含む pattern.name でも動作する', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const specialName = '<script>alert("xss")</script>';
      const pattern = createMockPattern({ name: specialName });

      const result = await service.savePattern({ pattern });

      expect(result.patternId).toBe('mock-pattern-id');
      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.name).toBe(specialName);
    });

    it('日本語の pattern.name でも動作する', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const japaneseName = 'フェードイン・アニメーション';
      const pattern = createMockPattern({ name: japaneseName });

      const result = await service.savePattern({ pattern });

      expect(result.patternId).toBe('mock-pattern-id');
      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.name).toBe(japaneseName);
    });

    it('空の properties 配列でも保存できる', async () => {
      const mockPrisma = createMockPrismaClient();
      const mockEmbedding = createMockEmbeddingService();

      setMotionPersistenceEmbeddingServiceFactory(() => mockEmbedding);
      setMotionPersistencePrismaClientFactory(() => mockPrisma);

      const service = new MotionPatternPersistenceService();
      const pattern = createMockPattern({ properties: [] });

      const result = await service.savePattern({ pattern });

      expect(result.patternId).toBe('mock-pattern-id');
      const createCall = (mockPrisma.motionPattern.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.properties).toEqual([]);
    });
  });

  // =====================================================
  // Embedding ベクトル検証テスト（Phase6-SEC-2）
  // セキュリティレビューで指摘された問題への対応テスト
  // =====================================================
  describe('Embedding ベクトル検証（セキュリティ対応）', () => {
    describe('NaN値の検出', () => {
      it('EmbeddingServiceがNaN値を返した場合、エラーをスローすること', async () => {
        // Arrange: NaNを含むEmbeddingを返すモックサービス
        const vectorWithNaN = new Array(768).fill(0.1);
        vectorWithNaN[0] = NaN;

        const mockEmbeddingWithNaN: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithNaN),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithNaN);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const pattern = createMockPattern();

        // Act & Assert: EmbeddingValidationError がスローされること
        await expect(service.savePattern({ pattern })).rejects.toThrow();
      });

      it('EmbeddingServiceがNaN値を返した場合、$executeRawUnsafeは呼ばれないこと', async () => {
        // Arrange: NaNを含むEmbeddingを返すモックサービス
        const vectorWithNaN = new Array(768).fill(0.1);
        vectorWithNaN[383] = NaN; // 中間位置

        const mockEmbeddingWithNaN: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithNaN),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithNaN);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const pattern = createMockPattern();

        // Act: savePattern を実行（エラーを無視）
        try {
          await service.savePattern({ pattern });
        } catch {
          // エラーは期待どおり
        }

        // Assert: SQLは実行されないこと
        expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
      });

      it('末尾位置にNaNがある場合も検出すること', async () => {
        // Arrange: 末尾にNaNを含むEmbedding
        const vectorWithNaN = new Array(768).fill(0.1);
        vectorWithNaN[767] = NaN;

        const mockEmbeddingWithNaN: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithNaN),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithNaN);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const pattern = createMockPattern();

        // Act & Assert: エラーがスローされること
        await expect(service.savePattern({ pattern })).rejects.toThrow();
      });
    });

    describe('Infinity値の検出', () => {
      it('EmbeddingServiceが正のInfinity値を返した場合、エラーをスローすること', async () => {
        // Arrange: Infinityを含むEmbeddingを返すモックサービス
        const vectorWithInfinity = new Array(768).fill(0.1);
        vectorWithInfinity[0] = Infinity;

        const mockEmbeddingWithInfinity: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithInfinity),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithInfinity);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const pattern = createMockPattern();

        // Act & Assert: EmbeddingValidationError がスローされること
        await expect(service.savePattern({ pattern })).rejects.toThrow();
      });

      it('EmbeddingServiceが負のInfinity値を返した場合、エラーをスローすること', async () => {
        // Arrange: -Infinityを含むEmbeddingを返すモックサービス
        const vectorWithNegativeInfinity = new Array(768).fill(0.1);
        vectorWithNegativeInfinity[100] = -Infinity;

        const mockEmbeddingWithNegativeInfinity: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithNegativeInfinity),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithNegativeInfinity);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const pattern = createMockPattern();

        // Act & Assert: エラーがスローされること
        await expect(service.savePattern({ pattern })).rejects.toThrow();
      });

      it('Infinity値が検出された場合、$executeRawUnsafeは呼ばれないこと', async () => {
        // Arrange: Infinityを含むEmbedding
        const vectorWithInfinity = new Array(768).fill(0.1);
        vectorWithInfinity[500] = Infinity;

        const mockEmbeddingWithInfinity: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithInfinity),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithInfinity);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const pattern = createMockPattern();

        // Act: savePattern を実行（エラーを無視）
        try {
          await service.savePattern({ pattern });
        } catch {
          // エラーは期待どおり
        }

        // Assert: SQLは実行されないこと
        expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
      });
    });

    describe('次元数の検証', () => {
      it('768次元未満のベクトルを拒否すること', async () => {
        // Arrange: 767次元のベクトルを返すモックサービス
        const shortVector = new Array(767).fill(0.1);

        const mockEmbeddingWithShortVector: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(shortVector),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithShortVector);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const pattern = createMockPattern();

        // Act & Assert: エラーがスローされること
        await expect(service.savePattern({ pattern })).rejects.toThrow();
      });

      it('768次元を超えるベクトルを拒否すること', async () => {
        // Arrange: 769次元のベクトルを返すモックサービス
        const longVector = new Array(769).fill(0.1);

        const mockEmbeddingWithLongVector: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(longVector),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithLongVector);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const pattern = createMockPattern();

        // Act & Assert: エラーがスローされること
        await expect(service.savePattern({ pattern })).rejects.toThrow();
      });
    });

    describe('型の検証', () => {
      it('文字列要素を含むベクトルを拒否すること', async () => {
        // Arrange: 文字列を含むベクトルを返すモックサービス
        const vectorWithString = new Array(768).fill(0.1);
        (vectorWithString as unknown[])[0] = '0.1';

        const mockEmbeddingWithString: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithString),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithString);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const pattern = createMockPattern();

        // Act & Assert: エラーがスローされること
        await expect(service.savePattern({ pattern })).rejects.toThrow();
      });

      it('null要素を含むベクトルを拒否すること', async () => {
        // Arrange: nullを含むベクトルを返すモックサービス
        const vectorWithNull = new Array(768).fill(0.1);
        (vectorWithNull as unknown[])[50] = null;

        const mockEmbeddingWithNull: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithNull),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithNull);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const pattern = createMockPattern();

        // Act & Assert: エラーがスローされること
        await expect(service.savePattern({ pattern })).rejects.toThrow();
      });

      it('undefined要素を含むベクトルを拒否すること', async () => {
        // Arrange: undefinedを含むベクトルを返すモックサービス
        const vectorWithUndefined = new Array(768).fill(0.1);
        (vectorWithUndefined as unknown[])[100] = undefined;

        const mockEmbeddingWithUndefined: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithUndefined),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithUndefined);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const pattern = createMockPattern();

        // Act & Assert: エラーがスローされること
        await expect(service.savePattern({ pattern })).rejects.toThrow();
      });
    });

    describe('savePatterns での検証', () => {
      it('バッチ保存でNaN値が検出された場合、そのパターンをスキップすること', async () => {
        // Arrange: 1つ目は正常、2つ目はNaN、3つ目は正常
        let callCount = 0;
        const mockEmbeddingWithMixedResults: IEmbeddingService = {
          generateEmbedding: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 2) {
              // 2つ目のパターンでNaNを返す
              const vectorWithNaN = new Array(768).fill(0.1);
              vectorWithNaN[0] = NaN;
              return Promise.resolve(vectorWithNaN);
            }
            return Promise.resolve(new Array(768).fill(0.1));
          }),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithMixedResults);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const patterns = [
          createMockPattern({ name: 'pattern-1' }),
          createMockPattern({ name: 'pattern-2' }), // NaNを含む
          createMockPattern({ name: 'pattern-3' }),
        ];

        // Act: continueOnError=true でバッチ保存
        const result = await service.savePatterns(patterns, { continueOnError: true });

        // Assert: 2つのパターンが保存されること（2つ目はスキップ）
        expect(result.savedCount).toBe(2);
      });

      it('バッチ保存でInfinity値が検出された場合、continueOnError=falseでエラーをスローすること', async () => {
        // Arrange: 最初のパターンでInfinityを返す
        const vectorWithInfinity = new Array(768).fill(0.1);
        vectorWithInfinity[0] = Infinity;

        const mockEmbeddingWithInfinity: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithInfinity),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithInfinity);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const patterns = [
          createMockPattern({ name: 'pattern-1' }),
          createMockPattern({ name: 'pattern-2' }),
        ];

        // Act & Assert: continueOnError=false でエラーがスローされること
        await expect(
          service.savePatterns(patterns, { continueOnError: false })
        ).rejects.toThrow();
      });
    });

    describe('エラーメッセージの品質', () => {
      it('NaN検出時に位置情報を含むエラーメッセージを生成すること', async () => {
        // Arrange: インデックス42にNaNを含むベクトル
        const vectorWithNaN = new Array(768).fill(0.1);
        vectorWithNaN[42] = NaN;

        const mockEmbeddingWithNaN: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithNaN),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithNaN);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const pattern = createMockPattern();

        // Act & Assert: エラーメッセージにインデックス情報が含まれること
        await expect(service.savePattern({ pattern })).rejects.toThrow(/42|NaN/);
      });

      it('Infinity検出時に位置情報を含むエラーメッセージを生成すること', async () => {
        // Arrange: インデックス100にInfinityを含むベクトル
        const vectorWithInfinity = new Array(768).fill(0.1);
        vectorWithInfinity[100] = Infinity;

        const mockEmbeddingWithInfinity: IEmbeddingService = {
          generateEmbedding: vi.fn().mockResolvedValue(vectorWithInfinity),
        };
        const mockPrisma = createMockPrismaClient();

        setMotionPersistenceEmbeddingServiceFactory(() => mockEmbeddingWithInfinity);
        setMotionPersistencePrismaClientFactory(() => mockPrisma);

        const service = new MotionPatternPersistenceService();
        const pattern = createMockPattern();

        // Act & Assert: エラーメッセージにインデックス情報が含まれること
        await expect(service.savePattern({ pattern })).rejects.toThrow(/100|Infinity/);
      });
    });
  });
});
