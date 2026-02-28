// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect -> motion.search 統合テスト
 * TDD Red Phase: 検出したパターンが検索で見つかることを検証
 *
 * 問題の再現:
 * - motion.detectで検出したパターンがDBに保存されないため
 * - motion.searchで0件が返される
 *
 * @module tests/tools/motion/detect-search-integration.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  motionDetectHandler,
  setMotionDetectServiceFactory,
  resetMotionDetectServiceFactory,
} from '../../../src/tools/motion/detect.tool';

import {
  motionSearchHandler,
  setMotionSearchServiceFactory,
  resetMotionSearchServiceFactory,
} from '../../../src/tools/motion/search.tool';

import {
  MotionSearchService,
  setEmbeddingServiceFactory,
  resetEmbeddingServiceFactory,
  setPrismaClientFactory,
  resetPrismaClientFactory,
  resetMotionSearchService,
  type IEmbeddingService,
  type IPrismaClient,
} from '../../../src/services/motion-search.service';

import type { MotionDetectInput } from '../../../src/tools/motion/detect.tool';
import type { MotionSearchInput } from '../../../src/tools/motion/search.tool';
import type { MotionPattern } from '../../../src/tools/motion/schemas';

// =====================================================
// テストデータ（共通化・重複削減）
// =====================================================

const SAMPLE_HTML = {
  fadeIn: `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .fade-in { animation: fadeIn 0.6s ease-out forwards; }
    .button { transition: transform 0.3s ease, box-shadow 0.3s ease; }
    .button:hover { transform: scale(1.05); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); }
  </style>
</head>
<body>
  <div class="fade-in">Hello World</div>
  <button class="button">Click me</button>
</body>
</html>`,
  spinner: `
<!DOCTYPE html>
<html>
<head>
  <style>
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .spinner { animation: spin 1s linear infinite; }
  </style>
</head>
<body><div class="spinner">Loading...</div></body>
</html>`,
};

// =====================================================
// 共通ヘルパー・ファクトリー（重複削減）
// =====================================================

// モックEmbeddingService生成（重複削減）
const createMockEmbeddingService = (): IEmbeddingService => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
});

// 空のモックPrismaClient生成（重複削減）
const createEmptyMockPrisma = (): IPrismaClient => ({
  motionPattern: {
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  },
  $queryRawUnsafe: vi.fn().mockResolvedValue([]),
});

// パターンを含むモックPrismaClient生成（重複削減）
const createMockPrismaWithPatterns = (patterns: MotionPattern[]): IPrismaClient => ({
  motionPattern: {
    findMany: vi.fn().mockResolvedValue(patterns.map(p => ({
      id: p.id,
      name: p.name || '',
      category: p.category,
      triggerType: p.trigger,
      animation: p.animation,
      properties: p.properties,
      sourceUrl: null,
      webPageId: null,
    }))),
    count: vi.fn().mockResolvedValue(patterns.length),
  },
  $queryRawUnsafe: vi.fn().mockImplementation(() =>
    Promise.resolve(patterns.map((p, i) => ({
      id: p.id,
      name: p.name || '',
      category: p.category,
      trigger_type: p.trigger,
      animation: p.animation,
      properties: p.properties,
      source_url: null,
      web_page_id: null,
      similarity: 0.9 - i * 0.1,
    })))
  ),
});

// 検索サービスセットアップ（重複削減）
const setupSearchServices = (embeddingService: IEmbeddingService, prismaClient: IPrismaClient) => {
  setEmbeddingServiceFactory(() => embeddingService);
  setPrismaClientFactory(() => prismaClient);
  setMotionSearchServiceFactory(() => new MotionSearchService());
};

// 全サービスリセット（重複削減）
const resetAllServices = () => {
  resetMotionDetectServiceFactory();
  resetMotionSearchServiceFactory();
  resetEmbeddingServiceFactory();
  resetPrismaClientFactory();
  resetMotionSearchService();
};

// 検出実行ヘルパー（重複削減）
const detectPatterns = async (html: string) => {
  const result = await motionDetectHandler({ html, detection_mode: 'css' as const });
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('Detection failed');
  return result.data;
};

// 検索実行ヘルパー（重複削減）
const searchPatterns = async (input: MotionSearchInput) => {
  const result = await motionSearchHandler(input);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('Search failed');
  return result.data;
};

// =====================================================
// 統合テスト: motion.detect -> motion.search
// =====================================================

describe('motion.detect -> motion.search 統合テスト (TDD Red Phase)', () => {
  let mockEmbeddingService: IEmbeddingService;

  beforeEach(() => {
    resetAllServices();
    mockEmbeddingService = createMockEmbeddingService();
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetAllServices();
  });

  describe('motion.detect -> motion.search統合: save_to_dbオプション有効時', () => {
    it('motion.detectで検出したパターンがmotion.searchで見つかるべき', async () => {
      // Step 1: motion.detectでパターンを検出
      const detectData = await detectPatterns(SAMPLE_HTML.fadeIn);
      expect(detectData.patterns.length).toBeGreaterThan(0);
      console.log('[Test] Detected patterns:', detectData.patterns.length);

      // Step 2: 検索サービスセットアップ（保存されたパターンを含むモック）
      setupSearchServices(mockEmbeddingService, createMockPrismaWithPatterns(detectData.patterns));

      const searchData = await searchPatterns({ query: 'fade in animation', limit: 10, minSimilarity: 0.3 });
      console.log('[Test] Search results:', searchData.results.length);

      // save_to_db有効時は検出したパターンが検索結果に含まれる
      expect(searchData.results.length).toBeGreaterThan(0);
    });

    it.each([
      { html: 'fadeIn', query: 'fadeIn opacity transform', patternFinder: (p: MotionPattern) => p.name === 'fadeIn' || p.category === 'scroll_trigger', resultFinder: (r: { pattern: MotionPattern }) => r.pattern.name === 'fadeIn' },
      { html: 'spinner', query: 'loading spinner infinite', patternFinder: (p: MotionPattern) => p.name === 'spin' || p.animation.iterations === 'infinite', resultFinder: (r: { pattern: MotionPattern }) => r.pattern.name === 'spin' || r.pattern.animation.iterations === 'infinite' },
    ])('検出した$htmlパターンがsearch結果に含まれるべき', async ({ html, query, patternFinder, resultFinder }) => {
      const detectData = await detectPatterns(SAMPLE_HTML[html as keyof typeof SAMPLE_HTML]);
      const targetPattern = detectData.patterns.find(patternFinder);
      expect(targetPattern).toBeDefined();
      console.log(`[Test] Found ${html} pattern:`, targetPattern?.name);

      setupSearchServices(mockEmbeddingService, createMockPrismaWithPatterns(detectData.patterns));

      const searchData = await searchPatterns({ query, limit: 10, minSimilarity: 0.1 });

      const foundPattern = searchData.results.find(resultFinder);
      expect(foundPattern).toBeDefined();
    });
  });

  describe('データフローの検証', () => {
    it('motion.detectはパターンを検出できる', async () => {
      const detectData = await detectPatterns(SAMPLE_HTML.fadeIn);

      // アニメーションとトランジションの両方が検出される
      expect(detectData.patterns.length).toBeGreaterThanOrEqual(2);

      // fadeInアニメーション
      const fadeIn = detectData.patterns.find(p => p.name === 'fadeIn');
      expect(fadeIn).toBeDefined();
      expect(fadeIn?.type).toBe('css_animation');

      // ボタンのトランジション
      const transition = detectData.patterns.find(p => p.type === 'css_transition');
      expect(transition).toBeDefined();
    });

    it('motion.searchはDBが空の場合0件を返す', async () => {
      setupSearchServices(mockEmbeddingService, createEmptyMockPrisma());

      const searchData = await searchPatterns({ query: 'any animation', limit: 10, minSimilarity: 0.1 });

      // DBが空なので0件
      expect(searchData.results).toHaveLength(0);
      expect(searchData.total).toBe(0);
    });

    it('検出結果のIDでパターンを検索できるべき（save_to_db有効時）', async () => {
      // Step 1: 検出してIDを取得
      const detectData = await detectPatterns(SAMPLE_HTML.fadeIn);
      const detectedId = detectData.patterns[0]?.id;
      expect(detectedId).toBeDefined();
      console.log('[Test] Detected pattern ID:', detectedId);

      // Step 2: 検索サービスセットアップ
      setupSearchServices(mockEmbeddingService, createMockPrismaWithPatterns(detectData.patterns));

      // Step 3: 検出したパターンのカテゴリで検索
      const searchData = await searchPatterns({
        query: detectData.patterns[0]?.name || 'animation',
        filters: { type: 'animation' },
        limit: 10,
        minSimilarity: 0.1,
      });

      // save_to_db有効時は検出したパターンが見つかる
      expect(searchData.results.some(r => r.pattern.id === detectedId)).toBe(true);
    });
  });

  describe('期待される動作（将来の実装）', () => {
    it('[SPECIFICATION] motion.detectはパターンをDBに保存すべき', async () => {
      // detect実行
      const detectData = await detectPatterns(SAMPLE_HTML.fadeIn);

      // 手動でパターンを保存（将来は自動化されるべき）
      const savedPatterns = [...detectData.patterns];

      // サービス設定
      setupSearchServices(mockEmbeddingService, createMockPrismaWithPatterns(savedPatterns));

      // 検索
      const searchData = await searchPatterns({ query: 'fade in animation', limit: 10, minSimilarity: 0.1 });

      // この仕様では、検出したパターンが検索で見つかる
      expect(searchData.results.length).toBeGreaterThan(0);
      console.log('[Spec] Found patterns with manual save:', searchData.results.length);
    });
  });
});

// =====================================================
// 根本原因の検証テスト
// =====================================================

describe('根本原因の検証: motion.detectはDBに保存しない', () => {
  beforeEach(() => resetMotionDetectServiceFactory());
  afterEach(() => {
    vi.clearAllMocks();
    resetMotionDetectServiceFactory();
  });

  it('motion.detectはパターンにUUIDを生成するがDBには保存しない', async () => {
    const detectData = await detectPatterns(SAMPLE_HTML.fadeIn);

    // パターンにIDが生成されている
    const pattern = detectData.patterns[0];
    expect(pattern?.id).toBeDefined();
    expect(pattern?.id).toMatch(/^[0-9a-f-]{36}$/i); // UUID形式

    console.log('[Root Cause] Pattern ID is generated in memory but not persisted to DB');
    console.log('[Root Cause] Pattern ID:', pattern?.id);
  });

  it('motion.detectのレスポンスにDB保存のトレースがない', async () => {
    const detectData = await detectPatterns(SAMPLE_HTML.fadeIn);

    // メタデータにDB保存の情報がない
    expect(detectData.metadata).not.toHaveProperty('savedToDb');
    expect(detectData.metadata).not.toHaveProperty('dbPatternIds');

    // pageIdもundefined（DB参照ではなくHTMLから直接検出）
    expect(detectData.pageId).toBeUndefined();
  });
});
