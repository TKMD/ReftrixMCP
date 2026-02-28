// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ThemeAnalyzer Unit Tests
 *
 * TDD GREEN Phase: Vision AIによるテーマ検出サービスのテスト
 *
 * 問題背景:
 * - E&A Financialサイト (#0A1628 ダークブルー) が "Light/Mixed" と誤認識された
 * - 原因: Vision AIプロンプトのテーマ判定基準が曖昧
 *
 * 解決策:
 * - テーマ判定専用のVision AIプロンプトを追加（明確な輝度基準を含む）
 * - Vision AIとピクセルベース検出を比較するフォールバック戦略
 * - 不一致時はピクセルベース（高信頼度）を優先
 */

import { describe, test, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// =============================================================================
// Mock Setup using vi.hoisted (BEFORE imports)
// =============================================================================

// Use vi.hoisted to create mock functions that can be used in vi.mock factories
const { mockGenerateJSON, mockIsAvailable, mockDetectTheme } = vi.hoisted(() => ({
  mockGenerateJSON: vi.fn(),
  mockIsAvailable: vi.fn(),
  mockDetectTheme: vi.fn(),
}));

// Mock the OllamaVisionClient as a class
vi.mock('../../../../src/services/vision/ollama-vision-client.js', () => ({
  OllamaVisionClient: class MockOllamaVisionClient {
    generateJSON = mockGenerateJSON;
    isAvailable = mockIsAvailable;
    constructor(_config?: unknown) {}
  },
}));

// Mock the pixel theme detector service
vi.mock('../../../../src/services/visual-extractor/pixel-theme-detector.service.js', () => ({
  createPixelThemeDetectorService: () => ({
    detectTheme: mockDetectTheme,
  }),
}));

// =============================================================================
// Import after mocks
// =============================================================================

import { ThemeAnalyzer } from '../../../../src/services/vision/theme.analyzer.js';
import { getThemeAnalysisPrompt, VALID_THEMES } from '../../../../src/services/vision/vision.prompts.js';

// =============================================================================
// Types for testing
// =============================================================================

interface PixelThemeResult {
  theme: 'light' | 'dark' | 'mixed';
  confidence: number;
  averageLuminance: number;
  dominantColors: string[];
}

// =============================================================================
// Test Data
// =============================================================================

/**
 * Valid Base64 image placeholder for testing
 * (A small valid PNG in Base64)
 */
const VALID_BASE64_IMAGE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * E&A Financial dark theme test case
 */
const EA_FINANCIAL_DARK_RESPONSE = {
  theme: 'dark',
  themeConfidence: 0.95,
  primaryBackgroundColor: '#0A1628',
  visualFeatures: ['glowing rings', 'dark gradient background', 'neon effects'],
  reasoning:
    'Background luminance is very low (< 10%). The dominant color #0A1628 is dark navy blue.',
};

/**
 * Light theme test case
 */
const LIGHT_THEME_RESPONSE = {
  theme: 'light',
  themeConfidence: 0.92,
  primaryBackgroundColor: '#FFFFFF',
  visualFeatures: ['white background', 'clean layout', 'minimal shadows'],
  reasoning:
    'Background luminance is very high (> 95%). The dominant color #FFFFFF is pure white.',
};

/**
 * Mixed theme test case
 */
const MIXED_THEME_RESPONSE = {
  theme: 'mixed',
  themeConfidence: 0.75,
  primaryBackgroundColor: '#808080',
  visualFeatures: ['dark header', 'light content area', 'gradient transition'],
  reasoning:
    'Page contains both dark sections (hero) and light sections (content). Split at approximately 50% luminance.',
};

// =============================================================================
// Test Suites
// =============================================================================

describe('ThemeAnalyzer', () => {
  let analyzer: ThemeAnalyzer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAvailable.mockResolvedValue(true);
    analyzer = new ThemeAnalyzer();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ===========================================================================
  // Prompt Design Tests
  // ===========================================================================

  describe('Prompt Design (Critical for accuracy)', () => {
    test('prompt should include explicit luminance thresholds for DARK', () => {
      const prompt = getThemeAnalysisPrompt();

      // Verify prompt includes explicit DARK threshold
      expect(prompt).toContain('DARK');
      expect(prompt).toMatch(/luminance\s*[<>]?\s*30%|Background luminance < 30%/i);
    });

    test('prompt should include explicit luminance thresholds for LIGHT', () => {
      const prompt = getThemeAnalysisPrompt();

      // Verify prompt includes explicit LIGHT threshold
      expect(prompt).toContain('LIGHT');
      expect(prompt).toMatch(/luminance\s*[>]?\s*70%|Background luminance > 70%/i);
    });

    test('prompt should request HEX color of primary background', () => {
      const prompt = getThemeAnalysisPrompt();

      // Verify prompt requests HEX color
      expect(prompt).toMatch(/#[A-Fa-f0-9]{6}|HEX|hex|primaryBackgroundColor/);
    });

    test('prompt should request JSON response format', () => {
      const prompt = getThemeAnalysisPrompt();

      // Verify prompt requests JSON format
      expect(prompt).toMatch(/JSON|json/);
      expect(prompt).toContain('"theme"');
    });

    test('prompt should warn about dark navy blue misclassification', () => {
      const prompt = getThemeAnalysisPrompt();

      // Verify prompt includes warning about dark backgrounds
      expect(prompt).toContain('#0A1628');
      expect(prompt.toLowerCase()).toContain('dark');
    });
  });

  // ===========================================================================
  // Theme Detection Tests
  // ===========================================================================

  describe('Theme Detection', () => {
    test('should correctly detect E&A Financial as DARK theme', async () => {
      // Setup mock to return dark theme response
      mockGenerateJSON.mockResolvedValue(EA_FINANCIAL_DARK_RESPONSE);

      const result = await analyzer.analyze(VALID_BASE64_IMAGE);

      expect(result).not.toBeNull();
      expect(result?.theme).toBe('dark');
      expect(result?.primaryBackgroundColor).toBe('#0A1628');
      expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
    });

    test('should correctly detect white background as LIGHT theme', async () => {
      mockGenerateJSON.mockResolvedValue(LIGHT_THEME_RESPONSE);

      const result = await analyzer.analyze(VALID_BASE64_IMAGE);

      expect(result).not.toBeNull();
      expect(result?.theme).toBe('light');
      expect(result?.primaryBackgroundColor).toBe('#FFFFFF');
    });

    test('should detect MIXED theme for pages with both dark and light sections', async () => {
      mockGenerateJSON.mockResolvedValue(MIXED_THEME_RESPONSE);

      const result = await analyzer.analyze(VALID_BASE64_IMAGE);

      expect(result).not.toBeNull();
      expect(result?.theme).toBe('mixed');
    });
  });

  // ===========================================================================
  // Fallback Strategy Tests
  // ===========================================================================

  describe('Fallback Strategy (Vision AI vs Pixel-based)', () => {
    test('should fallback to pixel-based detection when Vision AI fails', async () => {
      // Vision AI fails
      mockGenerateJSON.mockRejectedValue(new Error('Connection refused'));

      // Pixel-based returns dark theme
      mockDetectTheme.mockResolvedValue({
        theme: 'dark',
        confidence: 0.95,
        averageLuminance: 0.08,
        dominantColors: ['#0A1628', '#1A2E4A'],
      } as PixelThemeResult);

      const analyzerWithFallback = new ThemeAnalyzer({ enablePixelFallback: true });
      const result = await analyzerWithFallback.analyzeWithFallback(VALID_BASE64_IMAGE);

      expect(result).not.toBeNull();
      expect(result?.theme).toBe('dark');
      expect(result?.visionAiUsed).toBe(false);
    });

    test('should prefer pixel-based detection when Vision AI result conflicts', async () => {
      // Vision AI returns incorrect "light" for dark page
      mockGenerateJSON.mockResolvedValue({
        theme: 'light',
        themeConfidence: 0.6,
        primaryBackgroundColor: '#0A1628',
        visualFeatures: [],
        reasoning: 'Misclassified as light',
      });

      // Pixel-based correctly returns dark theme
      mockDetectTheme.mockResolvedValue({
        theme: 'dark',
        confidence: 0.95,
        averageLuminance: 0.08,
        dominantColors: ['#0A1628'],
      } as PixelThemeResult);

      const analyzerWithFallback = new ThemeAnalyzer({ enablePixelFallback: true });
      const result = await analyzerWithFallback.analyzeWithFallback(VALID_BASE64_IMAGE);

      // Should use pixel-based result due to conflict
      expect(result?.theme).toBe('dark');
      expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
    });

    test('should use Vision AI result when consistent with pixel-based', async () => {
      // Vision AI returns dark theme
      mockGenerateJSON.mockResolvedValue(EA_FINANCIAL_DARK_RESPONSE);

      // Pixel-based also returns dark theme
      mockDetectTheme.mockResolvedValue({
        theme: 'dark',
        confidence: 0.92,
        averageLuminance: 0.08,
        dominantColors: ['#0A1628'],
      } as PixelThemeResult);

      const analyzerWithFallback = new ThemeAnalyzer({ enablePixelFallback: true });
      const result = await analyzerWithFallback.analyzeWithFallback(VALID_BASE64_IMAGE);

      // Should use Vision AI result since both agree
      expect(result?.theme).toBe('dark');
      expect(result?.visionAiUsed).toBe(true);
      expect(result?.visualFeatures).toBeDefined();
    });
  });

  // ===========================================================================
  // Input Validation Tests
  // ===========================================================================

  describe('Input Validation', () => {
    test('should throw error for empty screenshot', async () => {
      await expect(analyzer.analyze('')).rejects.toThrow();
    });

    test('should throw error for invalid Base64', async () => {
      await expect(analyzer.analyze('not-valid-base64!@#$')).rejects.toThrow();
    });

    test('should throw error for oversized input (> 5MB)', async () => {
      const oversizedBase64 = 'A'.repeat(7 * 1024 * 1024); // ~7MB

      await expect(analyzer.analyze(oversizedBase64)).rejects.toThrow(/5MB/);
    });
  });

  // ===========================================================================
  // Confidence Threshold Tests
  // ===========================================================================

  describe('Confidence Threshold', () => {
    test('should return null when confidence is below threshold (0.6)', async () => {
      mockGenerateJSON.mockResolvedValue({
        theme: 'dark',
        themeConfidence: 0.4, // Below threshold
        primaryBackgroundColor: '#0A1628',
        visualFeatures: [],
        reasoning: 'Low confidence detection',
      });

      const result = await analyzer.analyze(VALID_BASE64_IMAGE);

      expect(result).toBeNull();
    });

    test('should return result when confidence is above threshold', async () => {
      mockGenerateJSON.mockResolvedValue(EA_FINANCIAL_DARK_RESPONSE);

      const result = await analyzer.analyze(VALID_BASE64_IMAGE);

      expect(result).not.toBeNull();
      expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
    });
  });

  // ===========================================================================
  // Cache Tests
  // ===========================================================================

  describe('Caching', () => {
    test('should cache results and return from cache on second call', async () => {
      mockGenerateJSON.mockResolvedValue(EA_FINANCIAL_DARK_RESPONSE);

      // First call
      await analyzer.analyze(VALID_BASE64_IMAGE);
      expect(mockGenerateJSON).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      await analyzer.analyze(VALID_BASE64_IMAGE);
      expect(mockGenerateJSON).toHaveBeenCalledTimes(1); // Still 1, not 2
    });
  });

  // ===========================================================================
  // Graceful Degradation Tests
  // ===========================================================================

  describe('Graceful Degradation', () => {
    test('should return null when Ollama API throws error', async () => {
      mockGenerateJSON.mockRejectedValue(new Error('Connection refused'));

      const result = await analyzer.analyze(VALID_BASE64_IMAGE);

      expect(result).toBeNull();
    });

    test('should return null when API response is malformed', async () => {
      mockGenerateJSON.mockResolvedValue({
        invalidField: 'invalid',
      });

      const result = await analyzer.analyze(VALID_BASE64_IMAGE);

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // VALID_THEMES Constant Tests
  // ===========================================================================

  describe('VALID_THEMES constant', () => {
    test('should include light, dark, and mixed', () => {
      expect(VALID_THEMES).toContain('light');
      expect(VALID_THEMES).toContain('dark');
      expect(VALID_THEMES).toContain('mixed');
      expect(VALID_THEMES).toHaveLength(3);
    });
  });
});
