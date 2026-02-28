// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Motion Handler Unit Tests (DB不要)
 *
 * motion-handler.tsの純粋関数とエラーハンドリングのユニットテスト
 * 外部依存（Playwright, Ollama, DB）はすべてモック化
 *
 * @module tests/unit/tools/page/handlers/motion-handler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =====================================================
// モック設定（ホイスティング対応）
// =====================================================

// Logger/環境判定をモック
vi.mock('../../../../../src/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/utils/logger')>();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    isDevelopment: vi.fn().mockReturnValue(false),
    Logger: class MockLogger {
      constructor(_name: string) {}
      info = vi.fn();
      warn = vi.fn();
      error = vi.fn();
      debug = vi.fn();
    },
  };
});

// MotionDetectorServiceをモック
vi.mock('../../../../../src/services/page/motion-detector.service', () => ({
  getMotionDetectorService: vi.fn(() => ({
    detect: vi.fn().mockReturnValue({
      patterns: [],
      warnings: [],
      processingTimeMs: 10,
    }),
  })),
}));

// 外部CSSフェッチャーをモック
vi.mock('../../../../../src/services/external-css-fetcher', () => ({
  extractCssUrls: vi.fn().mockReturnValue([]),
  fetchAllCss: vi.fn().mockResolvedValue([]),
}));

// video-handlerをモック
vi.mock('../../../../../src/tools/page/handlers/video-handler', () => ({
  executeVideoMode: vi.fn().mockResolvedValue({}),
}));

// js-animation-handlerをモック
vi.mock('../../../../../src/tools/page/handlers/js-animation-handler', () => ({
  executeJSAnimationMode: vi.fn().mockResolvedValue({}),
  checkPlaywrightAvailability: vi.fn().mockResolvedValue(false),
}));

// webgl-animation-handlerをモック
vi.mock('../../../../../src/tools/page/handlers/webgl-animation-handler', () => ({
  executeWebGLAnimationDetection: vi.fn().mockResolvedValue({}),
}));

// detection-modesをモック
vi.mock('../../../../../src/tools/motion/detection-modes', () => ({
  executeVideoDetection: vi.fn().mockResolvedValue({
    patterns: [],
    warnings: [],
    videoInfo: { duration: 0 },
  }),
  executeRuntimeDetection: vi.fn().mockResolvedValue({
    patterns: [],
    warnings: [],
    runtime_info: {},
  }),
}));

// LlamaVisionAdapterをモック
vi.mock('../../../../../src/services/vision-adapter/index.js', () => ({
  LlamaVisionAdapter: class MockLlamaVisionAdapter {
    isAvailable = vi.fn().mockResolvedValue(false);
    detectMotionCandidates = vi.fn().mockResolvedValue({
      success: true,
      data: { likelyAnimations: [], interactiveElements: [], scrollTriggers: [] },
      processingTimeMs: 100,
    });
  },
}));

// テスト対象とモックされたモジュールをインポート
import { defaultDetectMotion } from '../../../../../src/tools/page/handlers/motion-handler';
import type { MotionDetectionExtendedContext } from '../../../../../src/tools/page/handlers/types';
import { getMotionDetectorService } from '../../../../../src/services/page/motion-detector.service';
import { extractCssUrls, fetchAllCss } from '../../../../../src/services/external-css-fetcher';
import { executeVideoMode } from '../../../../../src/tools/page/handlers/video-handler';
import {
  executeJSAnimationMode,
  checkPlaywrightAvailability,
} from '../../../../../src/tools/page/handlers/js-animation-handler';
import { executeWebGLAnimationDetection } from '../../../../../src/tools/page/handlers/webgl-animation-handler';
import {
  executeVideoDetection,
  executeRuntimeDetection,
} from '../../../../../src/tools/motion/detection-modes';

describe('Motion Handler Unit Tests', () => {
  const MINIMAL_HTML = `<!DOCTYPE html><html><head></head><body><div>Test</div></body></html>`;
  const TEST_URL = 'https://example.com';

  // モック関数への参照を取得
  const mockGetMotionDetectorService = vi.mocked(getMotionDetectorService);
  const mockExtractCssUrls = vi.mocked(extractCssUrls);
  const mockFetchAllCss = vi.mocked(fetchAllCss);
  const mockExecuteVideoMode = vi.mocked(executeVideoMode);
  const mockExecuteJSAnimationMode = vi.mocked(executeJSAnimationMode);
  const mockCheckPlaywrightAvailability = vi.mocked(checkPlaywrightAvailability);
  const mockExecuteWebGLAnimationDetection = vi.mocked(executeWebGLAnimationDetection);
  const mockExecuteVideoDetection = vi.mocked(executeVideoDetection);
  const mockExecuteRuntimeDetection = vi.mocked(executeRuntimeDetection);

  beforeEach(() => {
    vi.clearAllMocks();

    // デフォルトのモック戻り値を設定
    const mockDetect = vi.fn().mockReturnValue({
      patterns: [],
      warnings: [],
      processingTimeMs: 10,
    });
    mockGetMotionDetectorService.mockReturnValue({ detect: mockDetect });

    mockExtractCssUrls.mockReturnValue([]);
    mockFetchAllCss.mockResolvedValue([]);
    mockExecuteVideoMode.mockResolvedValue({});
    mockExecuteJSAnimationMode.mockResolvedValue({});
    mockCheckPlaywrightAvailability.mockResolvedValue(false);
    mockExecuteWebGLAnimationDetection.mockResolvedValue({});
    mockExecuteVideoDetection.mockResolvedValue({
      patterns: [],
      warnings: [],
      videoInfo: { duration: 0 },
    });
    mockExecuteRuntimeDetection.mockResolvedValue({
      patterns: [],
      warnings: [],
      runtime_info: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =====================================================
  // CSS Mode Tests (default)
  // =====================================================

  describe('CSS Mode (default detection_mode)', () => {
    it('should detect CSS patterns using MotionDetectorService', async () => {
      // Arrange
      const mockDetect = vi.fn().mockReturnValue({
        patterns: [
          {
            id: 'pattern-1',
            name: 'fadeIn',
            type: 'keyframe',
            category: 'entrance',
            trigger: 'load',
            duration: 300,
            easing: 'ease-in-out',
            properties: ['opacity', 'transform'],
            performance: {
              level: 'high',
              usesTransform: true,
              usesOpacity: true,
            },
            accessibility: {
              respectsReducedMotion: true,
            },
          },
        ],
        warnings: [
          {
            code: 'A11Y_NO_REDUCED_MOTION',
            severity: 'warning',
            message: 'Animation does not respect reduced motion',
          },
        ],
        processingTimeMs: 15,
      });
      mockGetMotionDetectorService.mockReturnValue({ detect: mockDetect });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL);

      // Assert
      expect(result.success).toBe(true);
      expect(result.patternCount).toBe(1);
      expect(result.patterns).toHaveLength(1);
      expect(result.patterns?.[0].name).toBe('fadeIn');
      expect(result.categoryBreakdown).toEqual({ entrance: 1 });
      expect(mockDetect).toHaveBeenCalledWith(
        MINIMAL_HTML,
        expect.objectContaining({
          includeInlineStyles: true,
          includeStyleSheets: true,
        }),
        undefined // externalCss
      );
    });

    it('should count accessibility and performance warnings correctly', async () => {
      // Arrange
      const mockDetect = vi.fn().mockReturnValue({
        patterns: [],
        warnings: [
          { code: 'A11Y_NO_REDUCED_MOTION', severity: 'warning', message: 'a11y warning 1' },
          { code: 'A11Y_RAPID_ANIMATION', severity: 'warning', message: 'a11y warning 2' },
          { code: 'PERF_LAYOUT_THRASHING', severity: 'warning', message: 'perf warning 1' },
          { code: 'OTHER_WARNING', severity: 'info', message: 'other warning' },
        ],
        processingTimeMs: 10,
      });
      mockGetMotionDetectorService.mockReturnValue({ detect: mockDetect });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL);

      // Assert
      expect(result.a11yWarningCount).toBe(2);
      expect(result.perfWarningCount).toBe(1);
      expect(result.warningCount).toBeGreaterThan(0); // 追加の警告も含む
    });

    it('should return error result on exception', async () => {
      // Arrange
      const mockDetect = vi.fn().mockImplementation(() => {
        throw new Error('Detection failed');
      });
      mockGetMotionDetectorService.mockReturnValue({ detect: mockDetect });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('MOTION_DETECTION_FAILED');
      expect(result.error?.message).toBe('Detection failed');
    });

    it('should add CSS_NO_ANIMATIONS_DETECTED warning when no patterns found', async () => {
      // Arrange
      const mockDetect = vi.fn().mockReturnValue({
        patterns: [],
        warnings: [],
        processingTimeMs: 10,
      });
      mockGetMotionDetectorService.mockReturnValue({ detect: mockDetect });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL);

      // Assert
      const cssWarning = result.warnings?.find(
        (w) => w.code === 'CSS_NO_ANIMATIONS_DETECTED'
      );
      expect(cssWarning).toBeDefined();
      expect(cssWarning?.severity).toBe('warning');
    });
  });

  // =====================================================
  // External CSS Fetch Tests
  // =====================================================

  describe('External CSS Fetch', () => {
    it('should fetch external CSS when enabled (default)', async () => {
      // Arrange
      mockExtractCssUrls.mockReturnValue([
        { url: 'https://example.com/style.css', type: 'stylesheet' },
      ]);
      mockFetchAllCss.mockResolvedValue([
        { url: 'https://example.com/style.css', content: '.fadeIn { animation: fade 1s; }' },
      ]);
      const mockDetect = vi.fn().mockReturnValue({
        patterns: [],
        warnings: [],
        processingTimeMs: 10,
      });
      mockGetMotionDetectorService.mockReturnValue({ detect: mockDetect });

      // Act
      await defaultDetectMotion(MINIMAL_HTML, TEST_URL);

      // Assert
      expect(mockFetchAllCss).toHaveBeenCalled();
      expect(mockDetect).toHaveBeenCalledWith(
        MINIMAL_HTML,
        expect.any(Object),
        '.fadeIn { animation: fade 1s; }' // externalCss
      );
    });

    it('should use pre-extracted CSS URLs when provided', async () => {
      // Arrange
      const preExtractedUrls = [
        'https://example.com/pre-extracted.css',
        'https://example.com/another.css',
      ];
      mockFetchAllCss.mockResolvedValue([
        { url: 'https://example.com/pre-extracted.css', content: '.test { color: red; }' },
        { url: 'https://example.com/another.css', content: null }, // 失敗
      ]);

      // Act
      await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {}, undefined, undefined, preExtractedUrls);

      // Assert
      expect(mockFetchAllCss).toHaveBeenCalledWith(preExtractedUrls, expect.any(Object));
      // extractCssUrlsは呼ばれない（pre-extractedを使用）
      expect(mockExtractCssUrls).not.toHaveBeenCalled();
    });

    it('should skip external CSS fetch when disabled', async () => {
      // Arrange
      const mockDetect = vi.fn().mockReturnValue({
        patterns: [],
        warnings: [],
        processingTimeMs: 10,
      });
      mockGetMotionDetectorService.mockReturnValue({ detect: mockDetect });

      // Act
      await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        fetchExternalCss: false,
      });

      // Assert
      expect(mockFetchAllCss).not.toHaveBeenCalled();
      expect(mockDetect).toHaveBeenCalledWith(
        MINIMAL_HTML,
        expect.any(Object),
        undefined // no externalCss
      );
    });

    it('should continue on external CSS fetch failure', async () => {
      // Arrange
      mockExtractCssUrls.mockReturnValue([
        { url: 'https://example.com/style.css', type: 'stylesheet' },
      ]);
      mockFetchAllCss.mockRejectedValue(new Error('Network error'));

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL);

      // Assert
      expect(result.success).toBe(true);
    });
  });

  // =====================================================
  // Video Mode Tests
  // =====================================================

  describe('Video Mode (detection_mode: video)', () => {
    it('should execute video detection when mode is video', async () => {
      // Arrange
      mockExecuteVideoDetection.mockResolvedValue({
        patterns: [
          {
            id: 'video-pattern-1',
            name: 'scrollAnimation',
            type: 'scroll',
            category: 'scroll',
            trigger: 'scroll',
            animation: { duration: 500, easing: { type: 'ease-out' } },
            properties: [{ property: 'transform' }],
          },
        ],
        warnings: [],
        videoInfo: { duration: 3000, frames: 90 },
      });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        detection_mode: 'video',
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.patternCount).toBe(1);
      expect(result.video_info).toBeDefined();
      expect(mockExecuteVideoDetection).toHaveBeenCalledWith(TEST_URL, undefined);
    });

    it('should return error when URL is not provided for video mode', async () => {
      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, '', {
        detection_mode: 'video',
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MOTION_VIDEO_MODE_URL_REQUIRED');
    });

    it('should handle video detection failure gracefully', async () => {
      // Arrange
      mockExecuteVideoDetection.mockRejectedValue(new Error('Video detection failed'));

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        detection_mode: 'video',
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MOTION_VIDEO_MODE_FAILED');
    });

    it('should add LAYOUT_FIRST_MODE_ENABLED warning in video mode', async () => {
      // Arrange
      mockExecuteVideoDetection.mockResolvedValue({
        patterns: [],
        warnings: [],
        videoInfo: { duration: 0 },
      });
      const extendedContext: MotionDetectionExtendedContext = {
        layoutFirstModeEnabled: true,
      };

      // Act
      const result = await defaultDetectMotion(
        MINIMAL_HTML,
        TEST_URL,
        { detection_mode: 'video' },
        undefined,
        extendedContext
      );

      // Assert
      const warning = result.warnings?.find((w) => w.code === 'LAYOUT_FIRST_MODE_ENABLED');
      expect(warning).toBeDefined();
    });
  });

  // =====================================================
  // Runtime Mode Tests
  // =====================================================

  describe('Runtime Mode (detection_mode: runtime)', () => {
    it('should execute runtime detection when mode is runtime', async () => {
      // Arrange
      mockExecuteRuntimeDetection.mockResolvedValue({
        patterns: [
          {
            id: 'runtime-pattern-1',
            type: 'animation',
            category: 'runtime',
            trigger: 'load',
            animation: { duration: 1000 },
            properties: [{ property: 'opacity' }],
          },
        ],
        warnings: [],
        runtime_info: { method: 'web-animations-api' },
      });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        detection_mode: 'runtime',
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.patternCount).toBe(1);
      expect(result.runtime_info).toBeDefined();
      expect(mockExecuteRuntimeDetection).toHaveBeenCalledWith(TEST_URL, undefined);
    });

    it('should return error when URL is not provided for runtime mode', async () => {
      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, '', {
        detection_mode: 'runtime',
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MOTION_RUNTIME_MODE_URL_REQUIRED');
    });
  });

  // =====================================================
  // Hybrid Mode Tests
  // =====================================================

  describe('Hybrid Mode (detection_mode: hybrid)', () => {
    it('should execute both CSS and runtime detection in hybrid mode', async () => {
      // Arrange
      const mockDetect = vi.fn().mockReturnValue({
        patterns: [{ id: 'css-1', name: 'cssAnim', type: 'keyframe', category: 'css', trigger: 'load', duration: 300, easing: 'ease', properties: [], performance: { level: 'high', usesTransform: true, usesOpacity: false }, accessibility: { respectsReducedMotion: true } }],
        warnings: [],
        processingTimeMs: 10,
      });
      mockGetMotionDetectorService.mockReturnValue({ detect: mockDetect });

      mockExecuteRuntimeDetection.mockResolvedValue({
        patterns: [{ id: 'runtime-1', type: 'animation', category: 'runtime', animation: { duration: 500 }, properties: [] }],
        warnings: [],
        runtime_info: {},
      });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        detection_mode: 'hybrid',
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.patternCount).toBe(2); // CSS + Runtime
    });

    it('should continue with CSS only if runtime detection fails in hybrid mode', async () => {
      // Arrange
      const mockDetect = vi.fn().mockReturnValue({
        patterns: [{ id: 'css-1', name: 'cssAnim', type: 'keyframe', category: 'css', trigger: 'load', duration: 300, easing: 'ease', properties: [], performance: { level: 'high', usesTransform: false, usesOpacity: false }, accessibility: { respectsReducedMotion: true } }],
        warnings: [],
        processingTimeMs: 10,
      });
      mockGetMotionDetectorService.mockReturnValue({ detect: mockDetect });
      mockExecuteRuntimeDetection.mockRejectedValue(new Error('Runtime failed'));

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        detection_mode: 'hybrid',
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.patternCount).toBe(1); // CSS only
      const skipWarning = result.warnings?.find(
        (w) => w.code === 'HYBRID_RUNTIME_DETECTION_SKIPPED'
      );
      expect(skipWarning).toBeDefined();
    });

    it('should return error when URL is not provided for hybrid mode', async () => {
      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, '', {
        detection_mode: 'hybrid',
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MOTION_HYBRID_MODE_URL_REQUIRED');
    });
  });

  // =====================================================
  // JS Animation Detection Tests
  // =====================================================

  describe('JS Animation Detection', () => {
    it('should skip JS detection when not requested (default)', async () => {
      // Act
      await defaultDetectMotion(MINIMAL_HTML, TEST_URL);

      // Assert
      expect(mockExecuteJSAnimationMode).not.toHaveBeenCalled();
    });

    it('should add error when JS detection requested but Playwright unavailable', async () => {
      // Arrange
      mockCheckPlaywrightAvailability.mockResolvedValue(false);

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        detect_js_animations: true,
      });

      // Assert
      expect(result.js_animation_error).toBeDefined();
      expect(result.js_animation_error?.code).toBe('PLAYWRIGHT_NOT_AVAILABLE');
    });

    it('should execute JS detection when Playwright is available', async () => {
      // Arrange
      mockCheckPlaywrightAvailability.mockResolvedValue(true);
      mockExecuteJSAnimationMode.mockResolvedValue({
        js_animation_summary: {
          cdpAnimationCount: 5,
          webAnimationCount: 3,
          detectedLibraries: ['gsap', 'framer-motion'],
          totalDetected: 8,
          detectionTimeMs: 150,
        },
      });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        detect_js_animations: true,
      });

      // Assert
      expect(result.js_animation_summary).toBeDefined();
      expect(result.js_animation_summary?.totalDetected).toBe(8);
      expect(mockExecuteJSAnimationMode).toHaveBeenCalled();
    });

    it('should add warning when JS detection succeeds but finds no animations', async () => {
      // Arrange
      mockCheckPlaywrightAvailability.mockResolvedValue(true);
      mockExecuteJSAnimationMode.mockResolvedValue({
        js_animation_summary: {
          cdpAnimationCount: 0,
          webAnimationCount: 0,
          detectedLibraries: [],
          totalDetected: 0,
          detectionTimeMs: 100,
        },
      });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        detect_js_animations: true,
      });

      // Assert
      const noJsWarning = result.warnings?.find(
        (w) => w.code === 'JS_NO_ANIMATIONS_DETECTED'
      );
      expect(noJsWarning).toBeDefined();
      expect(noJsWarning?.severity).toBe('info');
    });

    it('should add JS_ANIMATION_DETECTION_FAILED warning when JS detection errors', async () => {
      // Arrange
      mockCheckPlaywrightAvailability.mockResolvedValue(true);
      mockExecuteJSAnimationMode.mockResolvedValue({
        js_animation_error: {
          code: 'JS_DETECTION_TIMEOUT',
          message: 'Detection timed out',
        },
      });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        detect_js_animations: true,
      });

      // Assert
      const failedWarning = result.warnings?.find(
        (w) => w.code === 'JS_ANIMATION_DETECTION_FAILED'
      );
      expect(failedWarning).toBeDefined();
      expect(failedWarning?.severity).toBe('warning');
    });
  });

  // =====================================================
  // WebGL Animation Detection Tests
  // =====================================================

  describe('WebGL Animation Detection', () => {
    it('should execute WebGL detection when URL provided (default enabled)', async () => {
      // Arrange
      mockCheckPlaywrightAvailability.mockResolvedValue(true);
      mockExecuteWebGLAnimationDetection.mockResolvedValue({
        webgl_animation_summary: {
          totalPatterns: 3,
          categories: { wave: 2, particle: 1 },
        },
      });

      // Act - v0.1.0: detect_webgl_animations defaults to false, must be explicitly enabled
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        detect_webgl_animations: true,
      });

      // Assert
      expect(result.webgl_animation_summary).toBeDefined();
      expect(mockExecuteWebGLAnimationDetection).toHaveBeenCalled();
    });

    it('should skip WebGL detection when disabled', async () => {
      // Act
      await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        detect_webgl_animations: false,
      });

      // Assert
      expect(mockExecuteWebGLAnimationDetection).not.toHaveBeenCalled();
    });

    it('should add error when WebGL detection requested but Playwright unavailable', async () => {
      // Arrange
      mockCheckPlaywrightAvailability.mockResolvedValue(false);

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        detect_webgl_animations: true,
      });

      // Assert
      expect(result.webgl_animation_error).toBeDefined();
      expect(result.webgl_animation_error?.code).toBe('PLAYWRIGHT_NOT_AVAILABLE');
    });
  });

  // =====================================================
  // Category Breakdown Tests
  // =====================================================

  describe('Category Breakdown Calculation', () => {
    it('should calculate category breakdown correctly', async () => {
      // Arrange
      const mockDetect = vi.fn().mockReturnValue({
        patterns: [
          { id: '1', category: 'entrance', type: 'keyframe', name: 'fadeIn', trigger: 'load', duration: 300, easing: 'ease', properties: [], performance: { level: 'high', usesTransform: false, usesOpacity: true }, accessibility: { respectsReducedMotion: true } },
          { id: '2', category: 'entrance', type: 'keyframe', name: 'slideIn', trigger: 'load', duration: 400, easing: 'ease', properties: [], performance: { level: 'high', usesTransform: true, usesOpacity: false }, accessibility: { respectsReducedMotion: true } },
          { id: '3', category: 'hover', type: 'transition', name: 'scale', trigger: 'hover', duration: 200, easing: 'ease', properties: [], performance: { level: 'high', usesTransform: true, usesOpacity: false }, accessibility: { respectsReducedMotion: false } },
          { id: '4', category: 'loading', type: 'keyframe', name: 'spin', trigger: 'load', duration: 1000, easing: 'linear', properties: [], performance: { level: 'medium', usesTransform: true, usesOpacity: false }, accessibility: { respectsReducedMotion: true } },
        ],
        warnings: [],
        processingTimeMs: 20,
      });
      mockGetMotionDetectorService.mockReturnValue({ detect: mockDetect });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL);

      // Assert
      expect(result.categoryBreakdown).toEqual({
        entrance: 2,
        hover: 1,
        loading: 1,
      });
    });
  });

  // =====================================================
  // Options Tests
  // =====================================================

  describe('Options Handling', () => {
    it('should pass minDuration and maxPatterns to detector', async () => {
      // Arrange
      const mockDetect = vi.fn().mockReturnValue({
        patterns: [],
        warnings: [],
        processingTimeMs: 10,
      });
      mockGetMotionDetectorService.mockReturnValue({ detect: mockDetect });

      // Act
      await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        minDuration: 100,
        maxPatterns: 50,
      });

      // Assert
      expect(mockDetect).toHaveBeenCalled();
      const callArgs = mockDetect.mock.calls[0];
      expect(callArgs[0]).toBe(MINIMAL_HTML);
      expect(callArgs[1]).toMatchObject({
        minDuration: 100,
        maxPatterns: 50,
      });
    });

    it('should use default values when options not provided', async () => {
      // Arrange
      const mockDetect = vi.fn().mockReturnValue({
        patterns: [],
        warnings: [],
        processingTimeMs: 10,
      });
      mockGetMotionDetectorService.mockReturnValue({ detect: mockDetect });

      // Act
      await defaultDetectMotion(MINIMAL_HTML, TEST_URL);

      // Assert
      expect(mockDetect).toHaveBeenCalled();
      const callArgs = mockDetect.mock.calls[0];
      expect(callArgs[0]).toBe(MINIMAL_HTML);
      expect(callArgs[1]).toMatchObject({
        minDuration: 0,
        maxPatterns: 100,
      });
    });
  });

  // =====================================================
  // Processing Time Tests
  // =====================================================

  describe('Processing Time', () => {
    it('should track total processing time', async () => {
      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL);

      // Assert
      // processingTimeMs includes time from detector service (10ms from mock) plus additional overhead
      // It should be a number >= 0 (could be 0 if execution is very fast in test environment)
      expect(typeof result.processingTimeMs).toBe('number');
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  // =====================================================
  // Frame Capture Integration Tests
  // =====================================================

  describe('Frame Capture Integration', () => {
    it('should include frame capture results when enabled', async () => {
      // Arrange
      mockExecuteVideoMode.mockResolvedValue({
        frame_capture: {
          totalFrames: 100,
          outputDir: '/tmp/frames',
        },
      });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(result.frame_capture).toBeDefined();
      expect(result.frame_capture?.totalFrames).toBe(100);
    });

    it('should include frame analysis results when enabled', async () => {
      // Arrange
      mockExecuteVideoMode.mockResolvedValue({
        frame_capture: { totalFrames: 50 },
        frame_analysis: {
          layoutShiftDetected: true,
          clsScore: 0.15,
        },
      });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        enable_frame_capture: true,
        analyze_frames: true,
      });

      // Assert
      expect(result.frame_analysis).toBeDefined();
      expect(result.frame_analysis?.layoutShiftDetected).toBe(true);
    });

    it('should include frame capture error when occurs', async () => {
      // Arrange
      mockExecuteVideoMode.mockResolvedValue({
        frame_capture_error: {
          code: 'FRAME_CAPTURE_TIMEOUT',
          message: 'Capture timed out',
        },
      });

      // Act
      const result = await defaultDetectMotion(MINIMAL_HTML, TEST_URL, {
        enable_frame_capture: true,
      });

      // Assert
      expect(result.frame_capture_error).toBeDefined();
      expect(result.frame_capture_error?.code).toBe('FRAME_CAPTURE_TIMEOUT');
    });
  });
});
