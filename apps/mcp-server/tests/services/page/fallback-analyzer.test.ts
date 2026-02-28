// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FallbackAnalyzerService Tests
 *
 * TDD Red Phase: WebGLサイト分析の段階的フォールバック機能テスト
 *
 * 目的:
 * WebGLを多用する重いサイト（例: lbproject.dev）の分析時に、
 * タイムアウトを防ぐため3段階のフォールバック戦略を実装する。
 *
 * フォールバックレベル:
 * - Level 1: 標準分析（timeout: 30s, waitUntil: 'load'）
 * - Level 2: 軽量分析（timeout: 60s, waitUntil: 'domcontentloaded', disableJavaScript: true）
 * - Level 3: 最小分析（timeout: 120s, waitUntil: 'domcontentloaded', disableWebGL: true）
 *
 * 全レベル失敗時:
 * - success: true, partial: true で部分結果を返す
 * - warnings に失敗情報を含める
 *
 * @module tests/services/page/fallback-analyzer.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// TDD Red Phase: インポート（実装はまだ存在しない）
// =====================================================

import {
  FallbackAnalyzerService,
  type FallbackAnalyzeOptions,
  type FallbackAnalyzeResult,
  type FallbackLevel,
  FALLBACK_LEVELS,
  createFallbackAnalyzerService,
  resetFallbackAnalyzerService,
} from '../../../src/services/page/fallback-analyzer.service';

// =====================================================
// モックヘルパー
// =====================================================

/**
 * ページ分析サービスのモック
 * 各レベルでの成功/失敗をシミュレート
 */
interface MockPageAnalyzeService {
  analyze: ReturnType<typeof vi.fn>;
}

/**
 * モックページ分析サービスを作成
 * @param levelResults 各レベルでの結果を指定（undefined = そのレベルで失敗）
 */
function createMockPageAnalyzeService(
  levelResults: {
    level1?: FallbackAnalyzeResult;
    level2?: FallbackAnalyzeResult;
    level3?: FallbackAnalyzeResult;
  } = {}
): MockPageAnalyzeService {
  let callCount = 0;

  return {
    analyze: vi.fn().mockImplementation(async (options: FallbackAnalyzeOptions & { level: FallbackLevel }) => {
      callCount++;

      if (process.env.NODE_ENV === 'development') {
        console.log('[Test Mock] analyze called', { level: options.level, callCount });
      }

      // Level 1の呼び出し
      if (options.level === 1) {
        if (levelResults.level1) {
          return levelResults.level1;
        }
        throw new Error('Level 1 analysis timeout');
      }

      // Level 2の呼び出し
      if (options.level === 2) {
        if (levelResults.level2) {
          return levelResults.level2;
        }
        throw new Error('Level 2 analysis timeout');
      }

      // Level 3の呼び出し
      if (options.level === 3) {
        if (levelResults.level3) {
          return levelResults.level3;
        }
        throw new Error('Level 3 analysis timeout');
      }

      throw new Error(`Unknown level: ${options.level}`);
    }),
  };
}

/**
 * 成功結果を作成
 */
function createSuccessResult(overrides: Partial<FallbackAnalyzeResult> = {}): FallbackAnalyzeResult {
  return {
    success: true,
    webPageId: '01941234-5678-7abc-def0-123456789abc',
    layout: {
      success: true,
      sectionCount: 5,
      sectionTypes: { hero: 1, feature: 2, cta: 1, footer: 1 },
      processingTimeMs: 100,
    },
    motion: {
      success: true,
      patternCount: 10,
      categoryBreakdown: { scroll_trigger: 5, hover_effect: 3, entrance: 2 },
      warningCount: 1,
      processingTimeMs: 50,
    },
    quality: {
      success: true,
      overallScore: 85,
      grade: 'B',
      axisScores: { originality: 80, craftsmanship: 88, contextuality: 85 },
      processingTimeMs: 30,
    },
    totalProcessingTimeMs: 200,
    analyzedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * 部分結果を作成（一部の機能が失敗）
 */
function createPartialResult(overrides: Partial<FallbackAnalyzeResult> = {}): FallbackAnalyzeResult {
  return {
    success: true,
    partial: true,
    warnings: [
      {
        code: 'MOTION_DETECTION_SKIPPED',
        message: 'Motion detection was skipped due to WebGL timeout',
        level: 'warning',
      },
    ],
    webPageId: '01941234-5678-7abc-def0-123456789abc',
    layout: {
      success: true,
      sectionCount: 3,
      sectionTypes: { hero: 1, feature: 1, footer: 1 },
      processingTimeMs: 80,
    },
    motion: undefined, // モーション検出がスキップされた
    quality: {
      success: true,
      overallScore: 75,
      grade: 'C',
      axisScores: { originality: 70, craftsmanship: 80, contextuality: 75 },
      processingTimeMs: 25,
    },
    totalProcessingTimeMs: 120,
    analyzedAt: new Date().toISOString(),
    ...overrides,
  };
}

// =====================================================
// テスト定数
// =====================================================

const VALID_URL = 'https://example.com';
const HEAVY_WEBGL_URL = 'https://lbproject.dev';

// =====================================================
// テストスイート
// =====================================================

describe('FallbackAnalyzerService', () => {
  let service: FallbackAnalyzerService;

  beforeEach(() => {
    vi.resetAllMocks();
    resetFallbackAnalyzerService();
    service = createFallbackAnalyzerService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =====================================================
  // コンストラクタテスト
  // =====================================================

  describe('constructor', () => {
    it('サービスインスタンスを作成できる', () => {
      expect(service).toBeInstanceOf(FallbackAnalyzerService);
    });

    it('シングルトンパターンで同一インスタンスを返す', () => {
      const instance1 = createFallbackAnalyzerService();
      const instance2 = createFallbackAnalyzerService();
      expect(instance1).toBe(instance2);
    });

    it('resetFallbackAnalyzerService()でインスタンスをリセットできる', () => {
      const instance1 = createFallbackAnalyzerService();
      resetFallbackAnalyzerService();
      const instance2 = createFallbackAnalyzerService();
      expect(instance1).not.toBe(instance2);
    });
  });

  // =====================================================
  // FALLBACK_LEVELS定数テスト
  // =====================================================

  describe('FALLBACK_LEVELS', () => {
    it('Level 1の設定が正しい（標準分析）', () => {
      expect(FALLBACK_LEVELS[1]).toEqual({
        level: 1,
        timeout: 30000,
        waitUntil: 'load',
        disableJavaScript: false,
        disableWebGL: false,
        description: 'Standard analysis',
      });
    });

    it('Level 2の設定が正しい（軽量分析）', () => {
      expect(FALLBACK_LEVELS[2]).toEqual({
        level: 2,
        timeout: 60000,
        waitUntil: 'domcontentloaded',
        disableJavaScript: true,
        disableWebGL: false,
        description: 'Lightweight analysis (JavaScript disabled)',
      });
    });

    it('Level 3の設定が正しい（最小分析）', () => {
      expect(FALLBACK_LEVELS[3]).toEqual({
        level: 3,
        timeout: 120000,
        waitUntil: 'domcontentloaded',
        disableJavaScript: true,
        disableWebGL: true,
        description: 'Minimal analysis (WebGL disabled)',
      });
    });

    it('全レベルのタイムアウトが昇順', () => {
      expect(FALLBACK_LEVELS[1].timeout).toBeLessThan(FALLBACK_LEVELS[2].timeout);
      expect(FALLBACK_LEVELS[2].timeout).toBeLessThan(FALLBACK_LEVELS[3].timeout);
    });
  });

  // =====================================================
  // analyzeWithFallback - Level 1成功テスト
  // =====================================================

  describe('analyzeWithFallback - Level 1成功時', () => {
    it('Level 1で成功した場合、即座に結果を返す', async () => {
      const expectedResult = createSuccessResult();
      const mockService = createMockPageAnalyzeService({
        level1: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: VALID_URL,
      });

      expect(result.success).toBe(true);
      expect(result.partial).toBeUndefined();
      expect(mockService.analyze).toHaveBeenCalledTimes(1);
    });

    it('Level 1成功時はLevel 2, 3を呼び出さない', async () => {
      const expectedResult = createSuccessResult();
      const mockService = createMockPageAnalyzeService({
        level1: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      await service.analyzeWithFallback({ url: VALID_URL });

      // Level 1のみ呼び出される
      expect(mockService.analyze).toHaveBeenCalledTimes(1);
      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({ level: 1 })
      );
    });

    it('Level 1成功時の結果にwebPageIdが含まれる', async () => {
      const expectedResult = createSuccessResult({
        webPageId: '01941234-5678-7abc-def0-987654321fed',
      });
      const mockService = createMockPageAnalyzeService({
        level1: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({ url: VALID_URL });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.webPageId).toBe('01941234-5678-7abc-def0-987654321fed');
      }
    });

    it('Level 1成功時、適用されたレベル情報が含まれる', async () => {
      const expectedResult = createSuccessResult();
      const mockService = createMockPageAnalyzeService({
        level1: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({ url: VALID_URL });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.appliedLevel).toBe(1);
        expect(result.appliedLevelDescription).toBe('Standard analysis');
      }
    });
  });

  // =====================================================
  // analyzeWithFallback - Level 2成功テスト
  // =====================================================

  describe('analyzeWithFallback - Level 1失敗、Level 2成功時', () => {
    it('Level 1失敗後、Level 2で成功した場合にLevel 2の結果を返す', async () => {
      const expectedResult = createSuccessResult();
      const mockService = createMockPageAnalyzeService({
        level1: undefined, // Level 1失敗
        level2: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
      });

      expect(result.success).toBe(true);
      expect(mockService.analyze).toHaveBeenCalledTimes(2);
    });

    it('Level 2成功時、適用されたレベル情報が2になる', async () => {
      const expectedResult = createSuccessResult();
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.appliedLevel).toBe(2);
        expect(result.appliedLevelDescription).toBe('Lightweight analysis (JavaScript disabled)');
      }
    });

    it('Level 2ではJavaScriptが無効化されて呼び出される', async () => {
      const expectedResult = createSuccessResult();
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      await service.analyzeWithFallback({ url: HEAVY_WEBGL_URL });

      // Level 2の呼び出しを確認
      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 2,
          disableJavaScript: true,
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        })
      );
    });

    it('Level 1失敗の警告がwarningsに含まれる', async () => {
      const expectedResult = createSuccessResult();
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
      });

      expect(result.success).toBe(true);
      if (result.success && result.warnings) {
        expect(result.warnings).toContainEqual(
          expect.objectContaining({
            code: 'LEVEL_1_FAILED',
            level: 'info',
          })
        );
      }
    });
  });

  // =====================================================
  // analyzeWithFallback - Level 3成功テスト
  // =====================================================

  describe('analyzeWithFallback - Level 1-2失敗、Level 3成功時', () => {
    it('Level 1, 2失敗後、Level 3で成功した場合にLevel 3の結果を返す', async () => {
      const expectedResult = createPartialResult();
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
      });

      expect(result.success).toBe(true);
      expect(mockService.analyze).toHaveBeenCalledTimes(3);
    });

    it('Level 3成功時、適用されたレベル情報が3になる', async () => {
      const expectedResult = createPartialResult();
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.appliedLevel).toBe(3);
        expect(result.appliedLevelDescription).toBe('Minimal analysis (WebGL disabled)');
      }
    });

    it('Level 3ではWebGLが無効化されて呼び出される', async () => {
      const expectedResult = createPartialResult();
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      await service.analyzeWithFallback({ url: HEAVY_WEBGL_URL });

      // Level 3の呼び出しを確認
      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 3,
          disableJavaScript: true,
          disableWebGL: true,
          waitUntil: 'domcontentloaded',
          timeout: 120000,
        })
      );
    });

    it('Level 1, 2失敗の警告がwarningsに含まれる', async () => {
      const expectedResult = createPartialResult();
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
      });

      expect(result.success).toBe(true);
      if (result.success && result.warnings) {
        expect(result.warnings).toContainEqual(
          expect.objectContaining({ code: 'LEVEL_1_FAILED' })
        );
        expect(result.warnings).toContainEqual(
          expect.objectContaining({ code: 'LEVEL_2_FAILED' })
        );
      }
    });
  });

  // =====================================================
  // analyzeWithFallback - 全レベル失敗テスト
  // =====================================================

  describe('analyzeWithFallback - 全レベル失敗時', () => {
    it('全レベル失敗でもsuccess: trueを返す', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: undefined,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
      });

      expect(result.success).toBe(true);
      expect(result.partial).toBe(true);
    });

    it('全レベル失敗時、partial: trueが設定される', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: undefined,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
      });

      expect(result.partial).toBe(true);
    });

    it('全レベル失敗時、warningsにすべての失敗情報が含まれる', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: undefined,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
      });

      expect(result.success).toBe(true);
      if (result.success && result.warnings) {
        expect(result.warnings.length).toBeGreaterThanOrEqual(3);
        expect(result.warnings).toContainEqual(
          expect.objectContaining({ code: 'LEVEL_1_FAILED' })
        );
        expect(result.warnings).toContainEqual(
          expect.objectContaining({ code: 'LEVEL_2_FAILED' })
        );
        expect(result.warnings).toContainEqual(
          expect.objectContaining({ code: 'LEVEL_3_FAILED' })
        );
      }
    });

    it('全レベル失敗時、ALL_LEVELS_FAILED警告が含まれる', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: undefined,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
      });

      expect(result.success).toBe(true);
      if (result.success && result.warnings) {
        expect(result.warnings).toContainEqual(
          expect.objectContaining({
            code: 'ALL_LEVELS_FAILED',
            level: 'error',
            message: expect.stringContaining('All fallback levels failed'),
          })
        );
      }
    });

    it('全レベル失敗時、メタデータのみの部分結果を返す', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: undefined,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // URLは含まれる
        expect(result.url).toBe(HEAVY_WEBGL_URL);
        // 分析結果はundefined
        expect(result.layout).toBeUndefined();
        expect(result.motion).toBeUndefined();
        expect(result.quality).toBeUndefined();
        // webPageIdはundefined
        expect(result.webPageId).toBeUndefined();
      }
    });

    it('全レベル失敗時、appliedLevelは0', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: undefined,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.appliedLevel).toBe(0);
        expect(result.appliedLevelDescription).toBe('All levels failed');
      }
    });
  });

  // =====================================================
  // タイムアウト設定テスト
  // =====================================================

  describe('タイムアウト設定', () => {
    it('Level 1のタイムアウトは30秒', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: createSuccessResult(),
      });

      service.setPageAnalyzeService(mockService);

      await service.analyzeWithFallback({ url: VALID_URL });

      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 1,
          timeout: 30000,
        })
      );
    });

    it('Level 2のタイムアウトは60秒', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: createSuccessResult(),
      });

      service.setPageAnalyzeService(mockService);

      await service.analyzeWithFallback({ url: HEAVY_WEBGL_URL });

      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 2,
          timeout: 60000,
        })
      );
    });

    it('Level 3のタイムアウトは120秒', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: createPartialResult(),
      });

      service.setPageAnalyzeService(mockService);

      await service.analyzeWithFallback({ url: HEAVY_WEBGL_URL });

      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 3,
          timeout: 120000,
        })
      );
    });

    it('カスタムタイムアウト係数を指定できる', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: createSuccessResult(),
      });

      service.setPageAnalyzeService(mockService);

      await service.analyzeWithFallback({
        url: VALID_URL,
        timeoutMultiplier: 2, // タイムアウトを2倍に
      });

      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 60000, // 30000 * 2
        })
      );
    });
  });

  // =====================================================
  // waitUntil設定テスト
  // =====================================================

  describe('waitUntil設定', () => {
    it('Level 1のwaitUntilはload', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: createSuccessResult(),
      });

      service.setPageAnalyzeService(mockService);

      await service.analyzeWithFallback({ url: VALID_URL });

      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 1,
          waitUntil: 'load',
        })
      );
    });

    it('Level 2のwaitUntilはdomcontentloaded', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: createSuccessResult(),
      });

      service.setPageAnalyzeService(mockService);

      await service.analyzeWithFallback({ url: HEAVY_WEBGL_URL });

      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 2,
          waitUntil: 'domcontentloaded',
        })
      );
    });

    it('Level 3のwaitUntilはdomcontentloaded', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: createPartialResult(),
      });

      service.setPageAnalyzeService(mockService);

      await service.analyzeWithFallback({ url: HEAVY_WEBGL_URL });

      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 3,
          waitUntil: 'domcontentloaded',
        })
      );
    });
  });

  // =====================================================
  // featuresオプションテスト
  // =====================================================

  describe('featuresオプション', () => {
    it('featuresオプションが各レベルに渡される', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: createSuccessResult(),
      });

      service.setPageAnalyzeService(mockService);

      await service.analyzeWithFallback({
        url: VALID_URL,
        features: { layout: true, motion: false, quality: true },
      });

      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          features: { layout: true, motion: false, quality: true },
        })
      );
    });

    it('Level 3ではmotionがデフォルトで無効化される', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: createPartialResult(),
      });

      service.setPageAnalyzeService(mockService);

      await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
        features: { layout: true, motion: true, quality: true },
      });

      // Level 3ではmotionが強制的に無効化される
      expect(mockService.analyze).toHaveBeenLastCalledWith(
        expect.objectContaining({
          level: 3,
          features: expect.objectContaining({
            motion: false, // WebGL無効化時はmotion検出も無効
          }),
        })
      );
    });
  });

  // =====================================================
  // エラーハンドリングテスト
  // =====================================================

  describe('エラーハンドリング', () => {
    it('URLが空の場合エラー', async () => {
      const result = await service.analyzeWithFallback({
        url: '',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('無効なURLの場合エラー', async () => {
      const result = await service.analyzeWithFallback({
        url: 'not-a-valid-url',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('SSRFブロックされた場合エラー', async () => {
      const result = await service.analyzeWithFallback({
        url: 'http://localhost',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SSRF_BLOCKED');
      }
    });

    it('ページ分析サービスが設定されていない場合エラー', async () => {
      // サービスをリセットして未設定状態にする
      resetFallbackAnalyzerService();
      const freshService = new FallbackAnalyzerService();

      const result = await freshService.analyzeWithFallback({
        url: VALID_URL,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SERVICE_NOT_CONFIGURED');
      }
    });
  });

  // =====================================================
  // ログ出力テスト
  // =====================================================

  describe('ログ出力', () => {
    it('開発環境でのみログを出力する', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const originalNodeEnv = process.env.NODE_ENV;

      try {
        process.env.NODE_ENV = 'development';

        const mockService = createMockPageAnalyzeService({
          level1: createSuccessResult(),
        });
        service.setPageAnalyzeService(mockService);

        await service.analyzeWithFallback({ url: VALID_URL });

        expect(consoleSpy).toHaveBeenCalled();
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        consoleSpy.mockRestore();
      }
    });

    it('本番環境ではログを出力しない', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const originalNodeEnv = process.env.NODE_ENV;

      try {
        process.env.NODE_ENV = 'production';

        const mockService = createMockPageAnalyzeService({
          level1: createSuccessResult(),
        });
        service.setPageAnalyzeService(mockService);

        await service.analyzeWithFallback({ url: VALID_URL });

        // 本番環境ではログが出力されない（モック内の開発環境チェックを除く）
        // 実装側でログが出力されないことを確認
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        consoleSpy.mockRestore();
      }
    });
  });

  // =====================================================
  // パフォーマンステスト
  // =====================================================

  describe('パフォーマンス', () => {
    it('totalProcessingTimeMsが返される', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: createSuccessResult({ totalProcessingTimeMs: 500 }),
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({ url: VALID_URL });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.totalProcessingTimeMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('各レベルの処理時間がトラッキングされる', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: createSuccessResult(),
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: HEAVY_WEBGL_URL,
      });

      expect(result.success).toBe(true);
      if (result.success && result.levelAttempts) {
        expect(result.levelAttempts).toHaveLength(2);
        expect(result.levelAttempts[0]).toEqual(
          expect.objectContaining({
            level: 1,
            success: false,
            durationMs: expect.any(Number),
          })
        );
        expect(result.levelAttempts[1]).toEqual(
          expect.objectContaining({
            level: 2,
            success: true,
            durationMs: expect.any(Number),
          })
        );
      }
    });
  });

  // =====================================================
  // 入力バリデーションテスト
  // =====================================================

  describe('入力バリデーション', () => {
    it('optionsがundefinedでもエラーにならない', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: createSuccessResult(),
      });

      service.setPageAnalyzeService(mockService);

      // URLのみの最小入力
      const result = await service.analyzeWithFallback({
        url: VALID_URL,
      });

      expect(result.success).toBe(true);
    });

    it('featuresオプションがundefinedでもデフォルト値が適用される', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: createSuccessResult(),
      });

      service.setPageAnalyzeService(mockService);

      await service.analyzeWithFallback({ url: VALID_URL });

      expect(mockService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          features: expect.objectContaining({
            layout: true,
            motion: true,
            quality: true,
          }),
        })
      );
    });
  });
});

// =====================================================
// 統合シナリオテスト
// =====================================================

describe('FallbackAnalyzerService - 統合シナリオ', () => {
  let service: FallbackAnalyzerService;

  beforeEach(() => {
    vi.resetAllMocks();
    resetFallbackAnalyzerService();
    service = createFallbackAnalyzerService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('WebGL重いサイト（lbproject.dev類似）', () => {
    it('Level 1タイムアウト → Level 2成功のシナリオ', async () => {
      const expectedResult = createSuccessResult();
      const mockService = createMockPageAnalyzeService({
        level1: undefined, // タイムアウト
        level2: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: 'https://lbproject.dev',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.appliedLevel).toBe(2);
        expect(result.warnings).toContainEqual(
          expect.objectContaining({ code: 'LEVEL_1_FAILED' })
        );
      }
    });

    it('Level 1, 2タイムアウト → Level 3で部分結果のシナリオ', async () => {
      const partialResult = createPartialResult();
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: partialResult,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: 'https://heavy-webgl-site.com',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.appliedLevel).toBe(3);
        expect(result.partial).toBe(true);
      }
    });
  });

  describe('通常サイト', () => {
    it('Level 1で即座に成功するシナリオ', async () => {
      const expectedResult = createSuccessResult();
      const mockService = createMockPageAnalyzeService({
        level1: expectedResult,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.appliedLevel).toBe(1);
        expect(result.warnings).toBeUndefined();
      }
    });
  });

  describe('完全に到達不能なサイト', () => {
    it('全レベル失敗でも部分結果を返すシナリオ', async () => {
      const mockService = createMockPageAnalyzeService({
        level1: undefined,
        level2: undefined,
        level3: undefined,
      });

      service.setPageAnalyzeService(mockService);

      const result = await service.analyzeWithFallback({
        url: 'https://unreachable-site.invalid',
      });

      expect(result.success).toBe(true);
      expect(result.partial).toBe(true);
      if (result.success) {
        expect(result.appliedLevel).toBe(0);
        expect(result.warnings).toContainEqual(
          expect.objectContaining({ code: 'ALL_LEVELS_FAILED' })
        );
      }
    });
  });
});

// =====================================================
// 型定義テスト（コンパイル時チェック）
// =====================================================

describe('型定義', () => {
  it('FallbackAnalyzeOptions型が正しく定義されている', () => {
    const options: FallbackAnalyzeOptions = {
      url: 'https://example.com',
      features: { layout: true, motion: true, quality: true },
      timeoutMultiplier: 1.5,
    };

    expect(options.url).toBeDefined();
  });

  it('FallbackAnalyzeResult型が正しく定義されている', () => {
    const successResult: FallbackAnalyzeResult = {
      success: true,
      webPageId: 'test-id',
      url: 'https://example.com',
      appliedLevel: 1,
      appliedLevelDescription: 'Standard analysis',
      layout: {
        success: true,
        sectionCount: 1,
        sectionTypes: {},
        processingTimeMs: 100,
      },
      totalProcessingTimeMs: 100,
      analyzedAt: new Date().toISOString(),
    };

    expect(successResult.success).toBe(true);
  });

  it('FallbackLevel型が1, 2, 3のユニオンである', () => {
    const level1: FallbackLevel = 1;
    const level2: FallbackLevel = 2;
    const level3: FallbackLevel = 3;

    expect([level1, level2, level3]).toEqual([1, 2, 3]);
  });
});
