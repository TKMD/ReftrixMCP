// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AntiAiClicheDetector
 *
 * AI生成デザインの典型的なクリシェパターンを検出し、
 * より人間らしいデザインを促進するルールエンジン
 *
 * @module @reftrix/webdesign-core/quality-evaluator/anti-ai-cliche
 */

import type { DetectedSection } from '../types/section.types';
import type { ColorInfo, TypographyInfo } from '../text-representation';

// =========================================
// Types - Exported
// =========================================

/**
 * レイアウト情報（拡張）
 */
export interface LayoutInfo {
  type: 'flex' | 'grid' | 'float' | 'unknown';
  columns?: number;
  gutterWidth?: number;
  maxWidth?: number;
  breakpoints?: Array<{ name: string; minWidth: number }>;
}

/**
 * デザインコンテキスト
 */
export interface DesignContext {
  /** 検出されたセクション */
  sections: DetectedSection[];
  /** 色情報 */
  colors?: ColorInfo;
  /** タイポグラフィ情報 */
  typography?: TypographyInfo;
  /** レイアウト情報 */
  layout?: LayoutInfo;
}

/**
 * クリシェ検出結果
 */
export interface ClicheDetectionResult {
  /** 検出されたか */
  detected: boolean;
  /** 信頼度（0-1） */
  confidence: number;
  /** 検出箇所（セレクタやセクションID） */
  locations?: string[];
  /** 詳細説明 */
  details?: string;
}

/**
 * クリシェパターン定義
 */
export interface ClichePattern {
  /** パターンID（一意） */
  id: string;
  /** パターン名 */
  name: string;
  /** 説明 */
  description: string;
  /** 深刻度 */
  severity: 'low' | 'medium' | 'high';
  /** 重み（0-1） */
  weight: number;
  /** 検出関数 */
  detector: (context: DesignContext) => ClicheDetectionResult;
}

/**
 * クリシェレポート
 */
export interface ClicheReport {
  /** 総合スコア（0-100、高いほど良い = クリシェが少ない） */
  totalScore: number;
  /** 検出されたパターン */
  detectedPatterns: Array<{
    pattern: ClichePattern;
    result: ClicheDetectionResult;
  }>;
  /** 推奨事項 */
  recommendations: string[];
}

/**
 * AntiAiClicheDetector オプション
 */
export interface AntiAiClicheDetectorOptions {
  /** 厳格モード（デフォルト: false） */
  strictMode?: boolean;
}

// =========================================
// AntiAiClicheDetector Class
// =========================================

/**
 * AntiAiClicheDetector
 *
 * AIクリシェパターン検出エンジン
 */
export class AntiAiClicheDetector {
  private patterns: Map<string, ClichePattern>;
  private strictMode: boolean;

  constructor(options: AntiAiClicheDetectorOptions = {}) {
    this.patterns = new Map();
    this.strictMode = options.strictMode ?? false;
    this.initBuiltinPatterns();

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[AntiAiClicheDetector] Initialized with strictMode:', this.strictMode);
    }
  }

  // =========================================
  // Pattern Management
  // =========================================

  /**
   * パターンを追加
   */
  addPattern(pattern: ClichePattern): void {
    this.patterns.set(pattern.id, pattern);

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[AntiAiClicheDetector] Pattern added:', pattern.id);
    }
  }

  /**
   * パターンを削除
   */
  removePattern(id: string): boolean {
    const result = this.patterns.delete(id);

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[AntiAiClicheDetector] Pattern removed:', id, 'success:', result);
    }

    return result;
  }

  /**
   * パターンを取得
   */
  getPattern(id: string): ClichePattern | undefined {
    return this.patterns.get(id);
  }

  /**
   * 全パターンをリスト
   */
  listPatterns(): ClichePattern[] {
    return Array.from(this.patterns.values());
  }

  // =========================================
  // Detection
  // =========================================

  /**
   * 全パターンを検出
   */
  detect(context: DesignContext): ClicheReport {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[AntiAiClicheDetector] Starting detection with', this.patterns.size, 'patterns');
    }

    const detectedPatterns: Array<{
      pattern: ClichePattern;
      result: ClicheDetectionResult;
    }> = [];

    // Run all detectors
    for (const pattern of this.patterns.values()) {
      try {
        const result = pattern.detector(context);
        if (result.detected) {
          detectedPatterns.push({ pattern, result });
        }
      } catch (error) {
        if (process.env.NODE_ENV === 'development') {
          console.error('[AntiAiClicheDetector] Pattern detector failed:', pattern.id, error);
        }
      }
    }

    // Calculate score
    const totalScore = this.calculateScore(detectedPatterns);

    // Generate recommendations
    const recommendations = this.generateRecommendations(detectedPatterns);

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[AntiAiClicheDetector] Detection complete. Score:', totalScore, 'Detected:', detectedPatterns.length);
    }

    return {
      totalScore,
      detectedPatterns,
      recommendations,
    };
  }

  /**
   * 単一パターンを検出
   */
  detectSingle(patternId: string, context: DesignContext): ClicheDetectionResult {
    const pattern = this.patterns.get(patternId);

    if (!pattern) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[AntiAiClicheDetector] Pattern not found:', patternId);
      }
      return { detected: false, confidence: 0 };
    }

    try {
      return pattern.detector(context);
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[AntiAiClicheDetector] Detector failed:', patternId, error);
      }
      return { detected: false, confidence: 0 };
    }
  }

  // =========================================
  // Private: Builtin Patterns
  // =========================================

  private initBuiltinPatterns(): void {
    // 1. Excessive Gradients
    this.addPattern({
      id: 'excessive-gradients',
      name: 'Excessive Gradients',
      description: 'Detects overuse of multi-color gradients (3+ colors)',
      severity: 'high',
      weight: 0.8,
      detector: (context) => this.detectExcessiveGradients(context),
    });

    // 2. Unrealistic Colors
    this.addPattern({
      id: 'unrealistic-colors',
      name: 'Unrealistic Colors',
      description: 'Detects highly saturated, neon-like color combinations',
      severity: 'high',
      weight: 0.9,
      detector: (context) => this.detectUnrealisticColors(context),
    });

    // 3. Over Decoration
    this.addPattern({
      id: 'over-decoration',
      name: 'Over Decoration',
      description: 'Detects excessive borders, shadows, and glows',
      severity: 'medium',
      weight: 0.6,
      detector: (context) => this.detectOverDecoration(context),
    });

    // 4. Stock Photo Composition
    this.addPattern({
      id: 'stock-photo-composition',
      name: 'Stock Photo Composition',
      description: 'Detects generic hero + 3-column layout',
      severity: 'medium',
      weight: 0.7,
      detector: (context) => this.detectStockPhotoComposition(context),
    });

    // 5. Perfect Symmetry
    this.addPattern({
      id: 'perfect-symmetry',
      name: 'Perfect Symmetry',
      description: 'Detects unnaturally perfect left-right symmetry',
      severity: 'low',
      weight: 0.4,
      detector: (context) => this.detectPerfectSymmetry(context),
    });

    // 6. Font Mismatch
    this.addPattern({
      id: 'font-mismatch',
      name: 'Font Mismatch',
      description: 'Detects incompatible font pairings',
      severity: 'medium',
      weight: 0.5,
      detector: (context) => this.detectFontMismatch(context),
    });

    // 7. Shadow Overuse
    this.addPattern({
      id: 'shadow-overuse',
      name: 'Shadow Overuse',
      description: 'Detects excessive drop shadows and glows',
      severity: 'low',
      weight: 0.5,
      detector: (context) => this.detectShadowOveruse(context),
    });

    // 8. Artificial Whitespace
    this.addPattern({
      id: 'artificial-whitespace',
      name: 'Artificial Whitespace',
      description: 'Detects unnaturally uniform spacing',
      severity: 'low',
      weight: 0.3,
      detector: (context) => this.detectArtificialWhitespace(context),
    });

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[AntiAiClicheDetector] Builtin patterns initialized:', this.patterns.size);
    }
  }

  // =========================================
  // Private: Pattern Detectors
  // =========================================

  /**
   * 1. Excessive Gradients
   * 3色以上のグラデーションを検出
   */
  private detectExcessiveGradients(context: DesignContext): ClicheDetectionResult {
    const gradientSections = context.sections.filter((s) => s.style.hasGradient);

    if (gradientSections.length === 0) {
      return { detected: false, confidence: 0 };
    }

    const locations: string[] = [];
    let multiColorCount = 0;

    for (const section of gradientSections) {
      const bg = section.style.backgroundColor || '';
      // Count number of color stops in gradient (rough heuristic)
      const colorStops = bg.match(/#[0-9A-Fa-f]{6}/g) || [];

      if (colorStops.length >= 3) {
        multiColorCount++;
        locations.push(section.id);
      }
    }

    if (multiColorCount > 0) {
      const confidence = Math.min(1.0, multiColorCount / 2);
      return {
        detected: true,
        confidence,
        locations,
        details: `${multiColorCount} section(s) with 3+ color gradients`,
      };
    }

    return { detected: false, confidence: 0 };
  }

  /**
   * 2. Unrealistic Colors
   * 非現実的な高彩度カラーを検出
   */
  private detectUnrealisticColors(context: DesignContext): ClicheDetectionResult {
    if (!context.colors || context.colors.palette.length === 0) {
      return { detected: false, confidence: 0 };
    }

    const neonColors: string[] = [];

    for (const color of context.colors.palette) {
      if (this.isNeonColor(color.hex)) {
        neonColors.push(color.hex);
      }
    }

    if (neonColors.length >= 2) {
      const confidence = Math.min(1.0, neonColors.length / 3);
      return {
        detected: true,
        confidence,
        details: `${neonColors.length} highly saturated neon colors: ${neonColors.join(', ')}`,
      };
    }

    return { detected: false, confidence: 0 };
  }

  /**
   * 3. Over Decoration
   * 過剰な装飾を検出（簡易実装）
   */
  private detectOverDecoration(_context: DesignContext): ClicheDetectionResult {
    // Note: Full implementation requires CSS parsing
    // This is a minimal placeholder
    return { detected: false, confidence: 0 };
  }

  /**
   * 4. Stock Photo Composition
   * ジェネリックなヒーロー+3カラム構成を検出
   */
  private detectStockPhotoComposition(context: DesignContext): ClicheDetectionResult {
    const { sections, layout } = context;

    if (sections.length < 2) {
      return { detected: false, confidence: 0 };
    }

    const heroSection = sections.find((s) => s.type === 'hero' && s.position.startY < 100);
    const featureSection = sections.find((s) => s.type === 'feature');

    if (!heroSection || !featureSection) {
      return { detected: false, confidence: 0 };
    }

    // Check for 3-column layout
    const hasThreeColumns = layout?.columns === 3 || featureSection.content.headings.length === 3;

    if (hasThreeColumns) {
      return {
        detected: true,
        confidence: 0.8,
        locations: [heroSection.id, featureSection.id],
        details: 'Generic hero + 3-column feature layout',
      };
    }

    return { detected: false, confidence: 0 };
  }

  /**
   * 5. Perfect Symmetry
   * 完璧すぎる対称性を検出（簡易実装）
   */
  private detectPerfectSymmetry(_context: DesignContext): ClicheDetectionResult {
    // Note: Full implementation requires layout geometry analysis
    return { detected: false, confidence: 0 };
  }

  /**
   * 6. Font Mismatch
   * 不調和なフォントペアリングを検出
   */
  private detectFontMismatch(context: DesignContext): ClicheDetectionResult {
    if (!context.typography || context.typography.fonts.length < 2) {
      return { detected: false, confidence: 0 };
    }

    const fonts = context.typography.fonts.map((f) => f.family.toLowerCase());

    // Known bad combinations
    const badPairs = [
      ['comic sans ms', 'times new roman'],
      ['papyrus', 'arial'],
      ['impact', 'comic sans ms'],
    ];

    for (const pair of badPairs) {
      const font1 = pair[0];
      const font2 = pair[1];
      if (font1 && font2 && fonts.includes(font1) && fonts.includes(font2)) {
        return {
          detected: true,
          confidence: 1.0,
          details: `Incompatible font pairing: ${font1} + ${font2}`,
        };
      }
    }

    return { detected: false, confidence: 0 };
  }

  /**
   * 7. Shadow Overuse
   * ドロップシャドウの過剰使用を検出（簡易実装）
   */
  private detectShadowOveruse(_context: DesignContext): ClicheDetectionResult {
    // Note: Full implementation requires CSS parsing
    return { detected: false, confidence: 0 };
  }

  /**
   * 8. Artificial Whitespace
   * 不自然に均一な余白を検出
   */
  private detectArtificialWhitespace(context: DesignContext): ClicheDetectionResult {
    if (context.sections.length < 3) {
      return { detected: false, confidence: 0 };
    }

    const heights = context.sections.map((s) => s.position.height);
    const uniqueHeights = new Set(heights);

    // If all sections have identical height
    if (uniqueHeights.size === 1) {
      return {
        detected: true,
        confidence: 0.9,
        details: `All ${context.sections.length} sections have identical height (${heights[0]}px)`,
      };
    }

    // If variance is very low
    const avg = heights.reduce((a, b) => a + b, 0) / heights.length;
    const variance = heights.reduce((sum, h) => sum + Math.pow(h - avg, 2), 0) / heights.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev < avg * 0.1) {
      // Less than 10% variation
      return {
        detected: true,
        confidence: 0.6,
        details: `Very low height variation (stdDev: ${stdDev.toFixed(1)}px)`,
      };
    }

    return { detected: false, confidence: 0 };
  }

  // =========================================
  // Private: Helpers
  // =========================================

  /**
   * ネオンカラー判定
   */
  private isNeonColor(hex: string): boolean {
    const rgb = this.hexToRgb(hex);
    if (!rgb) return false;

    const max = Math.max(rgb.r, rgb.g, rgb.b);
    const min = Math.min(rgb.r, rgb.g, rgb.b);
    const saturation = max === 0 ? 0 : (max - min) / max;

    // High saturation + high brightness = neon
    return saturation > 0.8 && max > 200;
  }

  /**
   * HEXをRGBに変換
   */
  private hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (!match) return null;

    const r = match[1];
    const g = match[2];
    const b = match[3];
    if (!r || !g || !b) return null;

    return {
      r: parseInt(r, 16),
      g: parseInt(g, 16),
      b: parseInt(b, 16),
    };
  }

  /**
   * スコア計算
   */
  private calculateScore(
    detectedPatterns: Array<{
      pattern: ClichePattern;
      result: ClicheDetectionResult;
    }>
  ): number {
    if (detectedPatterns.length === 0) {
      return 100;
    }

    let totalPenalty = 0;
    for (const { pattern, result } of detectedPatterns) {
      totalPenalty += pattern.weight * result.confidence;
    }

    // Normalize to 0-100 (assuming max penalty ~ 5)
    const score = Math.max(0, 100 - (totalPenalty / 5) * 100);
    return Math.round(score);
  }

  /**
   * 推奨事項生成
   */
  private generateRecommendations(
    detectedPatterns: Array<{
      pattern: ClichePattern;
      result: ClicheDetectionResult;
    }>
  ): string[] {
    const recommendations: string[] = [];

    for (const { pattern } of detectedPatterns) {
      const rec = this.getRecommendation(pattern.id);
      // getRecommendation always returns string (with fallback)
      recommendations.push(rec);
    }

    return recommendations;
  }

  /**
   * パターンIDに対する推奨事項
   */
  private getRecommendation(patternId: string): string {
    const recommendationMap: Record<string, string> = {
      'excessive-gradients': 'Simplify gradients to 2 colors or use solid backgrounds',
      'unrealistic-colors': 'Use more natural, desaturated color palettes',
      'over-decoration': 'Remove excessive borders, shadows, and decorative elements',
      'stock-photo-composition': 'Experiment with asymmetric or non-standard layouts',
      'perfect-symmetry': 'Add subtle asymmetry to create visual interest',
      'font-mismatch': 'Choose harmonious font pairings (e.g., sans-serif + serif)',
      'shadow-overuse': 'Reduce drop shadows or use subtle, consistent elevation',
      'artificial-whitespace': 'Vary section heights and spacing for natural rhythm',
    };

    // Return specific recommendation or generic fallback
    return (
      recommendationMap[patternId] ||
      `Review and refine the design to reduce AI-like patterns (${patternId})`
    );
  }
}
