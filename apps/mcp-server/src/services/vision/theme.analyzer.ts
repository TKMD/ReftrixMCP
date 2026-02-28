// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ThemeAnalyzer - Vision AIによるテーマ検出サービス
 *
 * Phase 5 REFACTOR: E&A Financialサイトの誤認識問題を解決
 *
 * 問題背景:
 * - E&A Financialサイト (#0A1628 ダークブルー) が "Light/Mixed" と誤認識された
 * - 原因: Vision AIプロンプトのテーマ判定基準が曖昧
 *
 * 解決策:
 * - テーマ判定専用のVision AIプロンプトを追加（明確な輝度基準を含む）
 * - Vision AIとピクセルベース検出を比較するフォールバック戦略
 * - 不一致時はピクセルベース（高信頼度）を優先
 *
 * @module services/vision/theme.analyzer
 */

import { logger } from '../../utils/logger';
import { OllamaVisionClient } from './ollama-vision-client.js';
import {
  createPixelThemeDetectorService,
  type PixelThemeDetectionResult,
} from '../visual-extractor/pixel-theme-detector.service.js';
import {
  getThemeAnalysisPrompt,
  getThemeAnalysisWithContextPrompt,
  type ColorContextForPrompt,
  VALID_THEMES,
  type ThemeType,
} from './vision.prompts.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * Default Ollama URL
 */
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/**
 * Default timeout for Vision API calls (30 seconds)
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * Default cache capacity
 */
const DEFAULT_CACHE_CAPACITY = 100;

/**
 * Default cache TTL (5 minutes)
 */
const DEFAULT_CACHE_TTL = 5 * 60 * 1000;

/**
 * Minimum confidence threshold for valid results
 */
const MIN_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Maximum input size (5MB)
 */
const MAX_INPUT_SIZE = 5 * 1024 * 1024;

// =============================================================================
// Types
// =============================================================================

/**
 * ThemeAnalyzer configuration options
 */
export interface ThemeAnalyzerConfig {
  /** Ollama API base URL */
  ollamaUrl?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** LRU cache capacity */
  cacheCapacity?: number;
  /** Cache TTL in milliseconds */
  cacheTTL?: number;
  /** Enable fallback to pixel-based detection */
  enablePixelFallback?: boolean;
}

/**
 * Theme analysis result from Vision AI
 */
export interface ThemeAnalysisResult {
  /** Detected theme: light, dark, or mixed */
  theme: ThemeType;
  /** Confidence score (0-1) */
  confidence: number;
  /** Primary background color in HEX format */
  primaryBackgroundColor: string;
  /** Whether Vision AI was used for detection */
  visionAiUsed: boolean;
  /** Reasoning from Vision AI (if used) */
  reasoning?: string;
  /** Visual features detected by Vision AI */
  visualFeatures?: string[];
}

/**
 * Raw response from Vision AI
 */
interface VisionThemeResponse {
  theme: string;
  themeConfidence: number;
  primaryBackgroundColor: string;
  visualFeatures?: string[];
  reasoning?: string;
}

/**
 * Cache entry with TTL
 */
interface CacheEntry {
  result: ThemeAnalysisResult;
  timestamp: number;
}

// =============================================================================
// ThemeAnalyzer Class
// =============================================================================

/**
 * ThemeAnalyzer - Analyzes web page screenshots to detect visual theme
 *
 * Features:
 * - Vision AI-based theme detection with explicit luminance thresholds
 * - LRU caching with TTL for performance
 * - Fallback to pixel-based detection when Vision AI is unavailable
 * - Conflict resolution: pixel-based takes priority on disagreement
 */
export class ThemeAnalyzer {
  private client: OllamaVisionClient;
  private pixelDetector: ReturnType<typeof createPixelThemeDetectorService>;
  private cache: Map<string, CacheEntry>;
  private config: Required<ThemeAnalyzerConfig>;

  constructor(config: ThemeAnalyzerConfig = {}) {
    this.config = {
      ollamaUrl: config.ollamaUrl ?? DEFAULT_OLLAMA_URL,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      cacheCapacity: config.cacheCapacity ?? DEFAULT_CACHE_CAPACITY,
      cacheTTL: config.cacheTTL ?? DEFAULT_CACHE_TTL,
      enablePixelFallback: config.enablePixelFallback ?? true,
    };

    this.client = new OllamaVisionClient({
      ollamaUrl: this.config.ollamaUrl,
      timeout: this.config.timeout,
    });

    this.pixelDetector = createPixelThemeDetectorService();
    this.cache = new Map();
  }

  /**
   * Analyze theme from screenshot using Vision AI
   *
   * @param screenshotBase64 - Screenshot image as Base64 string
   * @param colorContext - Optional color context for improved accuracy
   * @returns Theme analysis result or null if analysis fails
   */
  async analyze(
    screenshotBase64: string,
    colorContext?: ColorContextForPrompt
  ): Promise<ThemeAnalysisResult | null> {
    // Input validation
    this.validateInput(screenshotBase64);

    // Check cache
    const cacheKey = this.generateCacheKey(screenshotBase64);
    const cachedResult = this.getCachedResult(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }

    try {
      // Generate prompt
      const prompt = colorContext
        ? getThemeAnalysisWithContextPrompt(colorContext)
        : getThemeAnalysisPrompt();

      // Call Vision AI
      const response = await this.client.generateJSON<VisionThemeResponse>(
        prompt,
        screenshotBase64
      );

      // Validate response
      const result = this.parseVisionResponse(response);
      if (!result) {
        return null;
      }

      // Cache result
      this.setCachedResult(cacheKey, result);

      return result;
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[ThemeAnalyzer] Vision AI error:', error);
      }
      return null;
    }
  }

  /**
   * Analyze theme with fallback strategy
   *
   * Strategy:
   * 1. Try Vision AI first
   * 2. Also run pixel-based detection
   * 3. If results conflict, prefer pixel-based (more reliable for luminance)
   * 4. If Vision AI fails, use pixel-based only
   *
   * @param screenshotBase64 - Screenshot image as Base64 string
   * @param colorContext - Optional color context for improved accuracy
   * @returns Theme analysis result (never null with fallback enabled)
   */
  async analyzeWithFallback(
    screenshotBase64: string,
    colorContext?: ColorContextForPrompt
  ): Promise<ThemeAnalysisResult | null> {
    // Input validation
    this.validateInput(screenshotBase64);

    // Check if pixel fallback is enabled
    if (!this.config.enablePixelFallback) {
      return this.analyze(screenshotBase64, colorContext);
    }

    // Run both detections in parallel
    const [visionResult, pixelResult] = await Promise.all([
      this.analyze(screenshotBase64, colorContext).catch(() => null),
      this.runPixelDetection(screenshotBase64).catch(() => null),
    ]);

    // If Vision AI is unavailable, use pixel-based only
    if (!visionResult && pixelResult) {
      return this.convertPixelResult(pixelResult, false);
    }

    // If pixel detection failed, use Vision AI only
    if (visionResult && !pixelResult) {
      return visionResult;
    }

    // Both failed
    if (!visionResult && !pixelResult) {
      return null;
    }

    // Both succeeded - check for conflicts
    if (visionResult && pixelResult) {
      // If themes match, use Vision AI result (has more details)
      if (visionResult.theme === pixelResult.theme) {
        return visionResult;
      }

      // Conflict detected - prefer pixel-based (more reliable for luminance)
      logger.debug('[ThemeAnalyzer] Theme conflict detected:', {
        visionTheme: visionResult.theme,
        visionConfidence: visionResult.confidence,
        pixelTheme: pixelResult.theme,
        pixelConfidence: pixelResult.confidence,
        decision: 'Using pixel-based result',
      });

      // Use pixel-based result but mark that Vision AI was attempted
      return this.convertPixelResult(pixelResult, false);
    }

    return null;
  }

  /**
   * Check if Ollama Vision API is available
   */
  async isAvailable(): Promise<boolean> {
    return this.client.isAvailable();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Validate input screenshot
   */
  private validateInput(screenshotBase64: string): void {
    if (!screenshotBase64 || screenshotBase64.trim() === '') {
      throw new Error('Screenshot is required');
    }

    // Check size (Base64 is ~33% larger than binary)
    const estimatedSize = (screenshotBase64.length * 3) / 4;
    if (estimatedSize > MAX_INPUT_SIZE) {
      throw new Error(
        `Screenshot exceeds maximum size of 5MB (estimated: ${Math.round(estimatedSize / 1024 / 1024)}MB)`
      );
    }

    // Basic Base64 validation
    if (!/^[A-Za-z0-9+/=]+$/.test(screenshotBase64.replace(/\s/g, ''))) {
      throw new Error('Invalid Base64 encoding');
    }
  }

  /**
   * Parse and validate Vision AI response
   */
  private parseVisionResponse(
    response: VisionThemeResponse | null
  ): ThemeAnalysisResult | null {
    if (!response) {
      return null;
    }

    // Validate required fields
    if (!response.theme || typeof response.themeConfidence !== 'number') {
      return null;
    }

    // Validate theme value
    const theme = response.theme.toLowerCase() as ThemeType;
    if (!VALID_THEMES.includes(theme)) {
      return null;
    }

    // Check confidence threshold
    if (response.themeConfidence < MIN_CONFIDENCE_THRESHOLD) {
      return null;
    }

    const result: ThemeAnalysisResult = {
      theme,
      confidence: response.themeConfidence,
      primaryBackgroundColor: response.primaryBackgroundColor || '#000000',
      visionAiUsed: true,
    };

    // Only add optional properties if they have values
    if (response.reasoning) {
      result.reasoning = response.reasoning;
    }
    if (response.visualFeatures) {
      result.visualFeatures = response.visualFeatures;
    }

    return result;
  }

  /**
   * Run pixel-based theme detection
   */
  private async runPixelDetection(
    screenshotBase64: string
  ): Promise<PixelThemeDetectionResult | null> {
    try {
      return await this.pixelDetector.detectTheme(screenshotBase64);
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[ThemeAnalyzer] Pixel detection error:', error);
      }
      return null;
    }
  }

  /**
   * Convert pixel detection result to ThemeAnalysisResult
   */
  private convertPixelResult(
    pixelResult: PixelThemeDetectionResult,
    visionAiUsed: boolean
  ): ThemeAnalysisResult {
    return {
      theme: pixelResult.theme,
      confidence: pixelResult.confidence,
      primaryBackgroundColor: pixelResult.dominantColors[0] || '#000000',
      visionAiUsed,
      reasoning: `Pixel-based detection: average luminance ${(pixelResult.averageLuminance * 100).toFixed(1)}%`,
    };
  }

  /**
   * Generate cache key from screenshot
   */
  private generateCacheKey(screenshotBase64: string): string {
    // Use first 100 chars + length as simple hash
    const prefix = screenshotBase64.substring(0, 100);
    return `${prefix}_${screenshotBase64.length}`;
  }

  /**
   * Get cached result if valid
   */
  private getCachedResult(key: string): ThemeAnalysisResult | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > this.config.cacheTTL) {
      this.cache.delete(key);
      return null;
    }

    return entry.result;
  }

  /**
   * Set cached result with LRU eviction
   */
  private setCachedResult(key: string, result: ThemeAnalysisResult): void {
    // LRU eviction if at capacity
    if (this.cache.size >= this.config.cacheCapacity) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      result,
      timestamp: Date.now(),
    });
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

/**
 * Default ThemeAnalyzer instance
 */
export const themeAnalyzer = new ThemeAnalyzer();
