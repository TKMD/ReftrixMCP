// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Result Builder Unit Tests
 *
 * page.analyze 結果ビルダーのユニットテスト
 * Layout/Motion/Quality の分析結果変換と警告抽出のテスト
 *
 * @module tests/unit/tools/page/handlers/result-builder
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  determineErrorCode,
  buildLayoutResult,
  buildMotionResult,
  buildQualityResult,
  extractWarning,
  extractActionableWarning,
  extractAllActionableWarnings,
} from '../../../../../src/tools/page/handlers/result-builder';
import { PAGE_ANALYZE_ERROR_CODES } from '../../../../../src/tools/page/schemas';
import type {
  LayoutServiceResult,
  MotionServiceResult,
  QualityServiceResult,
} from '../../../../../src/tools/page/handlers/types';

// =====================================================
// モックのホイスト
// =====================================================

// actionable-warning モジュールをモック
vi.mock('../../../../../src/utils/actionable-warning', () => ({
  WarningFactory: {
    pageTimeout: vi.fn().mockReturnValue({
      type: 'warning',
      code: 'PAGE_TIMEOUT',
      severity: 'error',
      message: 'Page timeout',
      impact: 'Analysis failed',
      action: 'Increase timeout',
    }),
    networkError: vi.fn().mockReturnValue({
      type: 'warning',
      code: 'NETWORK_ERROR',
      severity: 'error',
      message: 'Network error',
      impact: 'Page could not be loaded',
      action: 'Check connectivity',
    }),
    httpError: vi.fn().mockReturnValue({
      type: 'warning',
      code: 'HTTP_ERROR',
      severity: 'error',
      message: 'HTTP error',
      impact: 'Page returned error',
      action: 'Check URL',
    }),
    browserError: vi.fn().mockReturnValue({
      type: 'warning',
      code: 'BROWSER_ERROR',
      severity: 'error',
      message: 'Browser error',
      impact: 'Browser failed',
      action: 'Check Playwright',
    }),
    visionUnavailableSimple: vi.fn().mockReturnValue({
      type: 'warning',
      code: 'VISION_UNAVAILABLE',
      severity: 'warning',
      message: 'Vision unavailable',
      impact: 'Visual features skipped',
      action: 'Start Ollama',
    }),
    noSectionsDetected: vi.fn().mockReturnValue({
      type: 'warning',
      code: 'NO_SECTIONS_DETECTED',
      severity: 'warning',
      message: 'No sections detected',
      impact: 'Layout analysis empty',
      action: 'Check page structure',
    }),
    noAnimationsDetected: vi.fn().mockReturnValue({
      type: 'warning',
      code: 'NO_ANIMATIONS_DETECTED',
      severity: 'info',
      message: 'No animations detected',
      impact: 'Motion analysis empty',
      action: 'Enable JS detection',
    }),
    lowQualityScore: vi.fn().mockReturnValue({
      type: 'warning',
      code: 'LOW_QUALITY_SCORE',
      severity: 'warning',
      message: 'Low quality score',
      impact: 'Design needs improvement',
      action: 'Review recommendations',
    }),
  },
  legacyWarningToActionable: vi.fn().mockReturnValue({
    type: 'warning',
    code: 'LEGACY_WARNING',
    severity: 'warning',
    message: 'Legacy warning converted',
    impact: 'Unknown impact',
    action: 'Check documentation',
  }),
}));

// =====================================================
// テストデータ
// =====================================================

/**
 * 基本的なLayoutServiceResult
 */
const createBaseLayoutResult = (): LayoutServiceResult => ({
  success: true,
  pageId: 'test-page-id',
  sectionCount: 3,
  sectionTypes: ['hero', 'feature', 'footer'],
  processingTimeMs: 150,
});

/**
 * 完全なLayoutServiceResult（すべてのフィールドを含む）
 */
const createFullLayoutResult = (): LayoutServiceResult => ({
  ...createBaseLayoutResult(),
  html: '<div>Test HTML</div>',
  screenshot: 'base64-screenshot-data',
  sections: [
    { type: 'hero', confidence: 0.95 },
    { type: 'feature', confidence: 0.88 },
    { type: 'footer', confidence: 0.92 },
  ],
  cssFramework: {
    framework: 'tailwind',
    confidence: 0.95,
    evidence: ['class="flex"', 'class="grid"'],
  },
  cssSnippet: '.hero { display: flex; }',
  visionFeatures: [{ type: 'layout_structure', confidence: 0.85 }],
  textRepresentation: 'Hero section with gradient background',
  visualFeatures: {
    colors: { dominant: ['#000000'], accent: ['#FF0000'] },
    theme: { type: 'dark' },
  },
});

/**
 * 基本的なMotionServiceResult
 */
const createBaseMotionResult = (): MotionServiceResult => ({
  success: true,
  patternCount: 5,
  categoryBreakdown: { animation: 3, transition: 2 },
  warningCount: 1,
  a11yWarningCount: 0,
  perfWarningCount: 1,
  processingTimeMs: 200,
});

/**
 * 完全なMotionServiceResult（すべてのフィールドを含む）
 */
const createFullMotionResult = (): MotionServiceResult => ({
  ...createBaseMotionResult(),
  patterns: [
    { type: 'animation', name: 'fadeIn', duration: 300 },
    { type: 'transition', name: 'hover-scale', duration: 200 },
  ],
  warnings: [{ code: 'PERF_WARNING', message: 'Long animation' }],
  frame_capture: { frameCount: 100, outputDir: '/tmp/frames' },
  frame_analysis: { diffZones: [], motionVectors: [] },
  js_animation_summary: { totalDetected: 3, detectedLibraries: ['gsap'] },
  js_animations: { cdpAnimations: [], webAnimations: [], libraries: [] },
  webgl_animation_summary: { totalDetected: 1, categories: ['wave'] },
  webgl_animations: [],
});

/**
 * 基本的なQualityServiceResult
 */
const createBaseQualityResult = (): QualityServiceResult => ({
  success: true,
  overallScore: 85,
  grade: 'A' as const,
  axisScores: { originality: 80, craftsmanship: 90, contextuality: 85 },
  clicheCount: 2,
  processingTimeMs: 100,
});

/**
 * 完全なQualityServiceResult（すべてのフィールドを含む）
 */
const createFullQualityResult = (): QualityServiceResult => ({
  ...createBaseQualityResult(),
  axisGrades: { originality: 'B' as const, craftsmanship: 'A' as const, contextuality: 'A' as const },
  axisDetails: { originality: 'Good uniqueness', craftsmanship: 'Excellent execution' },
  cliches: ['gradient-blob', 'generic-hero'],
  recommendations: ['Add more unique visual elements', 'Improve typography contrast'],
});

// =====================================================
// テストスイート
// =====================================================

describe('result-builder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =====================================================
  // determineErrorCode テスト
  // =====================================================

  describe('determineErrorCode', () => {
    it('タイムアウトエラーメッセージを正しく判定すること', () => {
      expect(determineErrorCode('Connection timeout after 30s')).toBe(
        PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR
      );
      expect(determineErrorCode('Request Timeout')).toBe(
        PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR
      );
    });

    it('HTTPエラーメッセージを正しく判定すること', () => {
      expect(determineErrorCode('HTTP 404 Not Found')).toBe(
        PAGE_ANALYZE_ERROR_CODES.HTTP_ERROR
      );
      expect(determineErrorCode('Page Not Found')).toBe(
        PAGE_ANALYZE_ERROR_CODES.HTTP_ERROR
      );
    });

    it('ブラウザエラーメッセージを正しく判定すること', () => {
      expect(determineErrorCode('Browser crashed unexpectedly')).toBe(
        PAGE_ANALYZE_ERROR_CODES.BROWSER_ERROR
      );
      expect(determineErrorCode('browser context closed')).toBe(
        PAGE_ANALYZE_ERROR_CODES.BROWSER_ERROR
      );
    });

    it('その他のエラーメッセージをネットワークエラーとして判定すること', () => {
      expect(determineErrorCode('Unknown error occurred')).toBe(
        PAGE_ANALYZE_ERROR_CODES.NETWORK_ERROR
      );
      expect(determineErrorCode('Connection refused')).toBe(
        PAGE_ANALYZE_ERROR_CODES.NETWORK_ERROR
      );
    });
  });

  // =====================================================
  // buildLayoutResult テスト
  // =====================================================

  describe('buildLayoutResult', () => {
    describe('Summary モード', () => {
      it('基本フィールドのみを返すこと', () => {
        const result = buildLayoutResult(createBaseLayoutResult(), true);

        expect(result.success).toBe(true);
        expect(result.pageId).toBe('test-page-id');
        expect(result.sectionCount).toBe(3);
        expect(result.sectionTypes).toEqual(['hero', 'feature', 'footer']);
        expect(result.processingTimeMs).toBe(150);

        // 詳細フィールドは含まれない
        expect((result as LayoutServiceResult).html).toBeUndefined();
        expect((result as LayoutServiceResult).screenshot).toBeUndefined();
        expect((result as LayoutServiceResult).sections).toBeUndefined();
      });

      it('CSSフレームワーク情報を含むこと', () => {
        const result = buildLayoutResult(createFullLayoutResult(), true);

        expect(result.cssFramework).toBeDefined();
        expect(result.cssFramework?.framework).toBe('tailwind');
        expect(result.cssFramework?.confidence).toBe(0.95);
      });

      it('cssSnippetを含むこと', () => {
        const result = buildLayoutResult(createFullLayoutResult(), true);

        expect(result.cssSnippet).toBe('.hero { display: flex; }');
      });

      it('include_html=true の場合にHTMLを含むこと', () => {
        const result = buildLayoutResult(createFullLayoutResult(), true, {
          include_html: true,
        });

        expect((result as LayoutServiceResult).html).toBe('<div>Test HTML</div>');
      });

      it('includeHtml=true (レガシー形式) の場合にHTMLを含むこと', () => {
        const result = buildLayoutResult(createFullLayoutResult(), true, {
          includeHtml: true,
        });

        expect((result as LayoutServiceResult).html).toBe('<div>Test HTML</div>');
      });

      it('include_screenshot=true の場合にスクリーンショットを含むこと', () => {
        const result = buildLayoutResult(createFullLayoutResult(), true, {
          include_screenshot: true,
        });

        expect((result as LayoutServiceResult).screenshot).toBe('base64-screenshot-data');
      });

      it('useVision=true の場合にvisionFeaturesとtextRepresentationを含むこと', () => {
        const result = buildLayoutResult(createFullLayoutResult(), true, {
          useVision: true,
        });

        expect((result as LayoutServiceResult).visionFeatures).toBeDefined();
        expect((result as LayoutServiceResult).textRepresentation).toBe(
          'Hero section with gradient background'
        );
      });

      it('visualFeaturesを常に含むこと', () => {
        const result = buildLayoutResult(createFullLayoutResult(), true);

        expect((result as LayoutServiceResult).visualFeatures).toBeDefined();
        expect((result as LayoutServiceResult).visualFeatures?.colors).toBeDefined();
      });
    });

    describe('Full モード', () => {
      it('すべてのフィールドを含むこと', () => {
        const result = buildLayoutResult(createFullLayoutResult(), false);

        expect(result.success).toBe(true);
        expect((result as LayoutServiceResult).html).toBe('<div>Test HTML</div>');
        expect((result as LayoutServiceResult).screenshot).toBe('base64-screenshot-data');
        expect((result as LayoutServiceResult).sections).toHaveLength(3);
        expect((result as LayoutServiceResult).visionFeatures).toBeDefined();
        expect((result as LayoutServiceResult).textRepresentation).toBeDefined();
        expect((result as LayoutServiceResult).visualFeatures).toBeDefined();
      });

      it('存在しないフィールドは含まないこと', () => {
        const result = buildLayoutResult(createBaseLayoutResult(), false);

        // 基本フィールドは存在
        expect(result.success).toBe(true);
        expect(result.pageId).toBe('test-page-id');

        // 詳細フィールドは undefined（baseには含まれない）
        expect((result as LayoutServiceResult).html).toBeUndefined();
        expect((result as LayoutServiceResult).screenshot).toBeUndefined();
      });
    });

    describe('エラーケース', () => {
      it('error フィールドを正しく含むこと', () => {
        const errorResult: LayoutServiceResult = {
          ...createBaseLayoutResult(),
          success: false,
          error: { code: 'LAYOUT_FAILED', message: 'Analysis failed' },
        };

        const result = buildLayoutResult(errorResult, true);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('LAYOUT_FAILED');
        expect(result.error?.message).toBe('Analysis failed');
      });
    });
  });

  // =====================================================
  // buildMotionResult テスト
  // =====================================================

  describe('buildMotionResult', () => {
    describe('Summary モード', () => {
      it('基本フィールドのみを返すこと', () => {
        const result = buildMotionResult(createBaseMotionResult(), true);

        expect(result.success).toBe(true);
        expect(result.patternCount).toBe(5);
        expect(result.categoryBreakdown).toEqual({ animation: 3, transition: 2 });
        expect(result.warningCount).toBe(1);
        expect(result.a11yWarningCount).toBe(0);
        expect(result.perfWarningCount).toBe(1);
        expect(result.processingTimeMs).toBe(200);

        // 詳細フィールドは含まれない
        expect((result as MotionServiceResult).patterns).toBeUndefined();
        expect((result as MotionServiceResult).warnings).toBeUndefined();
      });

      it('Video Mode結果をSummaryでも含むこと', () => {
        const result = buildMotionResult(createFullMotionResult(), true);

        expect((result as MotionServiceResult).frame_capture).toBeDefined();
        expect((result as MotionServiceResult).frame_capture?.frameCount).toBe(100);
        expect((result as MotionServiceResult).frame_analysis).toBeDefined();
      });

      it('JS Animation結果をSummaryでも含むこと', () => {
        const result = buildMotionResult(createFullMotionResult(), true);

        expect((result as MotionServiceResult).js_animation_summary).toBeDefined();
        expect((result as MotionServiceResult).js_animation_summary?.totalDetected).toBe(3);
        expect((result as MotionServiceResult).js_animations).toBeDefined();
      });

      it('WebGL Animation結果をSummaryでも含むこと', () => {
        const result = buildMotionResult(createFullMotionResult(), true);

        expect((result as MotionServiceResult).webgl_animation_summary).toBeDefined();
        expect((result as MotionServiceResult).webgl_animation_summary?.totalDetected).toBe(1);
        expect((result as MotionServiceResult).webgl_animations).toBeDefined();
      });
    });

    describe('Full モード', () => {
      it('すべてのフィールドを含むこと', () => {
        const result = buildMotionResult(createFullMotionResult(), false);

        expect(result.success).toBe(true);
        expect((result as MotionServiceResult).patterns).toBeDefined();
        expect((result as MotionServiceResult).patterns).toHaveLength(2);
        expect((result as MotionServiceResult).warnings).toBeDefined();
        expect((result as MotionServiceResult).frame_capture).toBeDefined();
        expect((result as MotionServiceResult).js_animation_summary).toBeDefined();
      });
    });

    describe('エラーケース', () => {
      it('frame_capture_error フィールドを含むこと', () => {
        const errorResult: MotionServiceResult = {
          ...createBaseMotionResult(),
          frame_capture_error: 'Frame capture failed',
        };

        const result = buildMotionResult(errorResult, true);

        expect((result as MotionServiceResult).frame_capture_error).toBe('Frame capture failed');
      });

      it('frame_analysis_error フィールドを含むこと', () => {
        const errorResult: MotionServiceResult = {
          ...createBaseMotionResult(),
          frame_analysis_error: 'Analysis failed',
        };

        const result = buildMotionResult(errorResult, true);

        expect((result as MotionServiceResult).frame_analysis_error).toBe('Analysis failed');
      });

      it('js_animation_error フィールドを含むこと', () => {
        const errorResult: MotionServiceResult = {
          ...createBaseMotionResult(),
          js_animation_error: 'JS detection failed',
        };

        const result = buildMotionResult(errorResult, true);

        expect((result as MotionServiceResult).js_animation_error).toBe('JS detection failed');
      });

      it('webgl_animation_error フィールドを含むこと', () => {
        const errorResult: MotionServiceResult = {
          ...createBaseMotionResult(),
          webgl_animation_error: 'WebGL detection failed',
        };

        const result = buildMotionResult(errorResult, true);

        expect((result as MotionServiceResult).webgl_animation_error).toBe('WebGL detection failed');
      });
    });
  });

  // =====================================================
  // buildQualityResult テスト
  // =====================================================

  describe('buildQualityResult', () => {
    describe('Summary モード', () => {
      it('基本フィールドのみを返すこと', () => {
        const result = buildQualityResult(createBaseQualityResult(), true);

        expect(result.success).toBe(true);
        expect(result.overallScore).toBe(85);
        expect(result.grade).toBe('A');
        expect(result.axisScores).toEqual({ originality: 80, craftsmanship: 90, contextuality: 85 });
        expect(result.clicheCount).toBe(2);
        expect(result.processingTimeMs).toBe(100);

        // 詳細フィールドは含まれない
        expect((result as QualityServiceResult).axisGrades).toBeUndefined();
        expect((result as QualityServiceResult).axisDetails).toBeUndefined();
        expect((result as QualityServiceResult).cliches).toBeUndefined();
      });

      it('includeRecommendations未指定（デフォルト）でrecommendationsを含むこと', () => {
        const result = buildQualityResult(createFullQualityResult(), true);

        expect((result as QualityServiceResult).recommendations).toBeDefined();
        expect((result as QualityServiceResult).recommendations).toHaveLength(2);
      });

      it('includeRecommendations=false でrecommendationsを含まないこと', () => {
        const result = buildQualityResult(createFullQualityResult(), true, {
          includeRecommendations: false,
        });

        expect((result as QualityServiceResult).recommendations).toBeUndefined();
      });
    });

    describe('Full モード', () => {
      it('すべてのフィールドを含むこと', () => {
        const result = buildQualityResult(createFullQualityResult(), false);

        expect(result.success).toBe(true);
        expect((result as QualityServiceResult).axisGrades).toBeDefined();
        expect((result as QualityServiceResult).axisDetails).toBeDefined();
        expect((result as QualityServiceResult).cliches).toBeDefined();
        expect((result as QualityServiceResult).cliches).toHaveLength(2);
        expect((result as QualityServiceResult).recommendations).toBeDefined();
      });
    });

    describe('エラーケース', () => {
      it('error フィールドを正しく含むこと', () => {
        const errorResult: QualityServiceResult = {
          ...createBaseQualityResult(),
          success: false,
          error: { code: 'QUALITY_FAILED', message: 'Evaluation failed' },
        };

        const result = buildQualityResult(errorResult, true);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('QUALITY_FAILED');
      });
    });
  });

  // =====================================================
  // extractWarning テスト
  // =====================================================

  describe('extractWarning', () => {
    it('失敗結果からwarningを抽出すること', () => {
      const result = extractWarning('layout', {
        success: false,
        error: { code: 'LAYOUT_FAILED', message: 'Analysis failed' },
      });

      expect(result).not.toBeNull();
      expect(result?.feature).toBe('layout');
      expect(result?.code).toBe('LAYOUT_FAILED');
      expect(result?.message).toBe('Analysis failed');
    });

    it('成功結果からはnullを返すこと', () => {
      const result = extractWarning('layout', { success: true });

      expect(result).toBeNull();
    });

    it('errorがない失敗結果からはnullを返すこと', () => {
      const result = extractWarning('motion', { success: false });

      expect(result).toBeNull();
    });

    it('各featureタイプで正しく動作すること', () => {
      const layoutWarning = extractWarning('layout', {
        success: false,
        error: { code: 'L_ERROR', message: 'Layout error' },
      });
      const motionWarning = extractWarning('motion', {
        success: false,
        error: { code: 'M_ERROR', message: 'Motion error' },
      });
      const qualityWarning = extractWarning('quality', {
        success: false,
        error: { code: 'Q_ERROR', message: 'Quality error' },
      });

      expect(layoutWarning?.feature).toBe('layout');
      expect(motionWarning?.feature).toBe('motion');
      expect(qualityWarning?.feature).toBe('quality');
    });
  });

  // =====================================================
  // extractActionableWarning テスト
  // =====================================================

  describe('extractActionableWarning', () => {
    it('成功結果からはnullを返すこと', () => {
      const result = extractActionableWarning('layout', { success: true });

      expect(result).toBeNull();
    });

    it('タイムアウトエラーを検出すること', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      extractActionableWarning(
        'layout',
        {
          success: false,
          error: { code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR, message: 'Timeout' },
        },
        { url: 'https://example.com', timeoutMs: 60000 }
      );

      expect(WarningFactory.pageTimeout).toHaveBeenCalledWith('https://example.com', 60000);
    });

    it('タイムアウトメッセージを検出すること', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      extractActionableWarning('layout', {
        success: false,
        error: { code: 'UNKNOWN', message: 'Request timed out after 30s' },
      });

      expect(WarningFactory.pageTimeout).toHaveBeenCalled();
    });

    it('ネットワークエラーを検出すること', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      extractActionableWarning(
        'layout',
        {
          success: false,
          error: { code: PAGE_ANALYZE_ERROR_CODES.NETWORK_ERROR, message: 'Connection failed' },
        },
        { url: 'https://example.com' }
      );

      expect(WarningFactory.networkError).toHaveBeenCalledWith(
        'https://example.com',
        'Connection failed'
      );
    });

    it('ECONNREFUSEDエラーを検出すること', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      extractActionableWarning('layout', {
        success: false,
        error: { code: 'UNKNOWN', message: 'ECONNREFUSED' },
      });

      expect(WarningFactory.networkError).toHaveBeenCalled();
    });

    it('HTTPエラーを検出すること', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      extractActionableWarning(
        'layout',
        {
          success: false,
          error: { code: PAGE_ANALYZE_ERROR_CODES.HTTP_ERROR, message: 'HTTP 404' },
        },
        { url: 'https://example.com' }
      );

      expect(WarningFactory.httpError).toHaveBeenCalledWith('https://example.com', 404);
    });

    it('ステータスコード403を検出すること', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      extractActionableWarning('layout', {
        success: false,
        error: { code: 'UNKNOWN', message: 'Forbidden 403' },
      });

      expect(WarningFactory.httpError).toHaveBeenCalled();
    });

    it('ブラウザエラーを検出すること', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      extractActionableWarning('layout', {
        success: false,
        error: { code: PAGE_ANALYZE_ERROR_CODES.BROWSER_ERROR, message: 'Browser crashed' },
      });

      expect(WarningFactory.browserError).toHaveBeenCalledWith('Browser crashed');
    });

    it('Playwrightエラーを検出すること', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      extractActionableWarning('layout', {
        success: false,
        error: { code: 'UNKNOWN', message: 'Playwright context closed' },
      });

      expect(WarningFactory.browserError).toHaveBeenCalled();
    });

    it('Vision利用不可エラーを検出すること', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      extractActionableWarning('layout', {
        success: false,
        error: { code: 'UNKNOWN', message: 'Vision AI unavailable' },
      });

      expect(WarningFactory.visionUnavailableSimple).toHaveBeenCalled();
    });

    it('レイアウトのセクション未検出を検出すること', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      extractActionableWarning(
        'layout',
        {
          success: false,
          error: { code: 'UNKNOWN', message: 'No sections detected' },
        },
        { url: 'https://example.com' }
      );

      expect(WarningFactory.noSectionsDetected).toHaveBeenCalledWith('https://example.com');
    });

    it('モーションのアニメーション未検出を検出すること', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      extractActionableWarning(
        'motion',
        {
          success: false,
          error: { code: 'UNKNOWN', message: 'No animation found' },
        },
        { url: 'https://example.com' }
      );

      expect(WarningFactory.noAnimationsDetected).toHaveBeenCalledWith('https://example.com');
    });

    it('品質の低スコアを検出すること', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      extractActionableWarning('quality', {
        success: false,
        error: { code: 'UNKNOWN', message: 'Low score detected' },
      });

      expect(WarningFactory.lowQualityScore).toHaveBeenCalledWith(50, 'overall');
    });

    it('未知のエラーをレガシー形式に変換すること', async () => {
      const { legacyWarningToActionable } = await import(
        '../../../../../src/utils/actionable-warning'
      );

      extractActionableWarning('layout', {
        success: false,
        error: { code: 'UNKNOWN_CODE', message: 'Some unknown error' },
      });

      expect(legacyWarningToActionable).toHaveBeenCalledWith({
        feature: 'layout',
        code: 'UNKNOWN_CODE',
        message: 'Some unknown error',
      });
    });

    it('contextが未指定の場合にデフォルト値を使用すること', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      extractActionableWarning('layout', {
        success: false,
        error: { code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR, message: 'Timeout' },
      });

      expect(WarningFactory.pageTimeout).toHaveBeenCalledWith('unknown', 60000);
    });
  });

  // =====================================================
  // extractAllActionableWarnings テスト
  // =====================================================

  describe('extractAllActionableWarnings', () => {
    it('すべての失敗結果から警告を抽出すること', () => {
      const results = {
        layout: {
          success: false,
          error: { code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR, message: 'Layout timeout' },
        },
        motion: {
          success: false,
          error: { code: PAGE_ANALYZE_ERROR_CODES.NETWORK_ERROR, message: 'Motion network error' },
        },
        quality: {
          success: false,
          error: { code: PAGE_ANALYZE_ERROR_CODES.BROWSER_ERROR, message: 'Quality browser error' },
        },
      };

      const warnings = extractAllActionableWarnings(results, { url: 'https://example.com' });

      expect(warnings).toHaveLength(3);
    });

    it('成功結果をスキップすること', () => {
      const results = {
        layout: { success: true },
        motion: {
          success: false,
          error: { code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR, message: 'Motion timeout' },
        },
        quality: { success: true },
      };

      const warnings = extractAllActionableWarnings(results);

      expect(warnings).toHaveLength(1);
    });

    it('すべて成功の場合は空配列を返すこと', () => {
      const results = {
        layout: { success: true },
        motion: { success: true },
        quality: { success: true },
      };

      const warnings = extractAllActionableWarnings(results);

      expect(warnings).toHaveLength(0);
    });

    it('部分的な結果でも動作すること', () => {
      const results = {
        layout: {
          success: false,
          error: { code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR, message: 'Timeout' },
        },
        // motion と quality は未定義
      };

      const warnings = extractAllActionableWarnings(results);

      expect(warnings).toHaveLength(1);
    });

    it('contextを各警告に渡すこと', async () => {
      const { WarningFactory } = await import('../../../../../src/utils/actionable-warning');

      const results = {
        layout: {
          success: false,
          error: { code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR, message: 'Timeout' },
        },
      };

      extractAllActionableWarnings(results, {
        url: 'https://test.com',
        timeoutMs: 120000,
      });

      expect(WarningFactory.pageTimeout).toHaveBeenCalledWith('https://test.com', 120000);
    });
  });
});
