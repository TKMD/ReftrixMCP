// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ScoringSystem - 3-Axis Quality Evaluation System
 *
 * Evaluates web designs across three axes:
 * - Originality (35%): uniqueColorUsage, layoutCreativity, typographyPersonality, antiClicheBonus
 * - Craftsmanship (40%): gridAlignment, typographyConsistency, colorHarmony, whitespaceRhythm, responsiveDesign
 * - Contextuality (25%): industryFit, audienceFit, brandConsistency, accessibilityCompliance
 *
 * @module @reftrix/webdesign-core/quality-evaluator/scoring-system
 */

import type { DetectedSection, SectionType } from '../types/section.types';
import type { ColorInfo, TypographyInfo } from '../text-representation';

// =========================================
// Types
// =========================================

/**
 * Scoring weights for the three axes
 */
export interface ScoringWeights {
  /** Weight for originality axis (default: 0.35) */
  originality: number;
  /** Weight for craftsmanship axis (default: 0.40) */
  craftsmanship: number;
  /** Weight for contextuality axis (default: 0.25) */
  contextuality: number;
}

/**
 * Individual criterion score breakdown
 */
export interface ScoreBreakdown {
  /** Criterion name */
  criterion: string;
  /** Score for this criterion (0-100) */
  score: number;
  /** Weight of this criterion within the axis */
  weight: number;
  /** Optional additional details */
  details?: string;
}

/**
 * Score for a single axis
 */
export interface AxisScore {
  /** Overall score for this axis (0-100) */
  score: number;
  /** Breakdown of individual criterion scores */
  breakdown: ScoreBreakdown[];
  /** List of identified strengths */
  strengths: string[];
  /** List of identified weaknesses */
  weaknesses: string[];
}

/**
 * Complete quality score result
 */
export interface QualityScore {
  /** Overall weighted score (0-100) */
  overall: number;
  /** Originality axis score */
  originality: AxisScore;
  /** Craftsmanship axis score */
  craftsmanship: AxisScore;
  /** Contextuality axis score */
  contextuality: AxisScore;
  /** Letter grade (A, B, C, D, F) */
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  /** Summary description */
  summary: string;
  /** Improvement recommendations */
  recommendations: string[];
}

/**
 * Detected cliche information
 */
export interface DetectedCliche {
  /** Pattern identifier */
  pattern: string;
  /** Severity level */
  severity: 'low' | 'medium' | 'high';
  /** Location in design */
  location: string;
  /** Improvement suggestion */
  suggestion: string;
}

/**
 * Cliche detection report
 */
export interface ClicheReport {
  /** Overall cliche score (0-1, higher = more cliches) */
  totalClicheScore: number;
  /** List of detected cliches */
  detectedCliches: DetectedCliche[];
  /** Summary of findings */
  summary: string;
  /** Recommendations to reduce cliches */
  recommendations: string[];
}

/**
 * Layout spacing information
 */
export interface LayoutSpacing {
  /** Spacing between sections */
  section: number;
  /** Spacing between elements */
  element: number;
  /** Spacing within components */
  component: number;
}

/**
 * Responsive design information
 */
export interface ResponsiveInfo {
  /** Defined breakpoints */
  breakpoints: Array<{ name: string; minWidth: number }>;
  /** Responsive adaptations */
  adaptations: string[];
}

/**
 * Layout information
 */
export interface LayoutInfo {
  /** Layout type */
  type: 'flex' | 'grid' | 'float' | 'unknown';
  /** Number of columns */
  columns?: number;
  /** Gutter width */
  gutterWidth?: number;
  /** Maximum width */
  maxWidth?: number;
  /** Alignment */
  alignment?: 'left' | 'center' | 'right';
  /** Spacing configuration */
  spacing?: LayoutSpacing;
  /** Responsive configuration */
  responsive?: ResponsiveInfo;
}

/**
 * Context for scoring evaluation
 */
export interface ScoringContext {
  /** Detected sections */
  sections: DetectedSection[];
  /** Color information */
  colors: ColorInfo;
  /** Typography information */
  typography: TypographyInfo;
  /** Layout information */
  layout: LayoutInfo;
  /** Optional cliche detection report */
  clicheReport?: ClicheReport;
  /** Optional target industry */
  targetIndustry?: string;
  /** Optional target audience */
  targetAudience?: string;
}

// =========================================
// Constants
// =========================================

/** Default scoring weights */
const DEFAULT_WEIGHTS: ScoringWeights = {
  originality: 0.35,
  craftsmanship: 0.4,
  contextuality: 0.25,
};

/** Generic font families (lower originality score) */
const GENERIC_FONTS = [
  'arial',
  'helvetica',
  'times',
  'times new roman',
  'verdana',
  'georgia',
  'courier',
  'courier new',
  'tahoma',
  'trebuchet',
  'system-ui',
  'sans-serif',
  'serif',
  'monospace',
];

/** Industry-specific section expectations */
const INDUSTRY_SECTIONS: Record<string, SectionType[]> = {
  saas: ['hero', 'feature', 'pricing', 'testimonial', 'cta', 'footer'],
  ecommerce: ['hero', 'gallery', 'feature', 'testimonial', 'cta', 'footer'],
  portfolio: ['hero', 'gallery', 'about', 'testimonial', 'contact', 'footer'],
  corporate: ['hero', 'about', 'feature', 'testimonial', 'contact', 'footer'],
  blog: ['hero', 'feature', 'about', 'contact', 'footer'],
};

// =========================================
// ScoringSystem Class
// =========================================

/**
 * ScoringSystem class for evaluating web design quality
 */
export class ScoringSystem {
  private weights: ScoringWeights;

  constructor(weights?: Partial<ScoringWeights>) {
    this.weights = this.normalizeWeights({
      ...DEFAULT_WEIGHTS,
      ...weights,
    });
  }

  // =========================================
  // Public Methods
  // =========================================

  /**
   * Evaluate a design context and return complete quality score
   */
  evaluate(context: ScoringContext): QualityScore {
    const originality = this.evaluateOriginality(context);
    const craftsmanship = this.evaluateCraftsmanship(context);
    const contextuality = this.evaluateContextuality(context);

    const overall = this.roundTo2Decimals(
      originality.score * this.weights.originality +
        craftsmanship.score * this.weights.craftsmanship +
        contextuality.score * this.weights.contextuality
    );

    const grade = this.calculateGrade(overall);

    const score: QualityScore = {
      overall,
      originality,
      craftsmanship,
      contextuality,
      grade,
      summary: '',
      recommendations: [],
    };

    score.summary = this.generateSummary(score);
    score.recommendations = this.generateRecommendations(score);

    return score;
  }

  /**
   * Evaluate originality axis (35%)
   */
  evaluateOriginality(context: ScoringContext): AxisScore {
    const breakdown: ScoreBreakdown[] = [];
    const strengths: string[] = [];
    const weaknesses: string[] = [];

    // 1. Unique Color Usage (20%)
    const colorScore = this.evaluateUniqueColorUsage(context.colors);
    breakdown.push({
      criterion: 'uniqueColorUsage',
      score: colorScore.score,
      weight: 0.2,
      details: colorScore.details,
    });
    if (colorScore.score >= 70) {
      strengths.push('Diverse and unique color palette');
    } else if (colorScore.score < 50) {
      weaknesses.push('Generic color palette');
    }

    // 2. Layout Creativity (25%)
    const layoutScore = this.evaluateLayoutCreativity(context.sections);
    breakdown.push({
      criterion: 'layoutCreativity',
      score: layoutScore.score,
      weight: 0.25,
      details: layoutScore.details,
    });
    if (layoutScore.score >= 70) {
      strengths.push('Creative and varied section layout');
    } else if (layoutScore.score < 50) {
      weaknesses.push('Limited section variety');
    }

    // 3. Typography Personality (20%)
    const typoScore = this.evaluateTypographyPersonality(context.typography);
    breakdown.push({
      criterion: 'typographyPersonality',
      score: typoScore.score,
      weight: 0.2,
      details: typoScore.details,
    });
    if (typoScore.score >= 70) {
      strengths.push('Distinctive typography choices');
    } else if (typoScore.score < 50) {
      weaknesses.push('Generic font selection');
    }

    // 4. Anti-Cliche Bonus (35%)
    const antiClicheScore = this.evaluateAntiClicheBonus(context.clicheReport);
    breakdown.push({
      criterion: 'antiClicheBonus',
      score: antiClicheScore.score,
      weight: 0.35,
      details: antiClicheScore.details,
    });
    if (antiClicheScore.score >= 70) {
      strengths.push('Original design avoiding common cliches');
    } else if (antiClicheScore.score < 50) {
      weaknesses.push('Heavy use of design cliches');
    }

    const score = this.calculateWeightedScore(breakdown);

    return { score, breakdown, strengths, weaknesses };
  }

  /**
   * Evaluate craftsmanship axis (40%)
   */
  evaluateCraftsmanship(context: ScoringContext): AxisScore {
    const breakdown: ScoreBreakdown[] = [];
    const strengths: string[] = [];
    const weaknesses: string[] = [];

    // 1. Grid Alignment (20%)
    const gridScore = this.evaluateGridAlignment(context.layout);
    breakdown.push({
      criterion: 'gridAlignment',
      score: gridScore.score,
      weight: 0.2,
      details: gridScore.details,
    });
    if (gridScore.score >= 70) {
      strengths.push('Well-structured grid system');
    } else if (gridScore.score < 50) {
      weaknesses.push('Inconsistent or missing grid structure');
    }

    // 2. Typography Consistency (20%)
    const typoConsistencyScore = this.evaluateTypographyConsistency(context.typography);
    breakdown.push({
      criterion: 'typographyConsistency',
      score: typoConsistencyScore.score,
      weight: 0.2,
      details: typoConsistencyScore.details,
    });
    if (typoConsistencyScore.score >= 70) {
      strengths.push('Consistent typography system');
    } else if (typoConsistencyScore.score < 50) {
      weaknesses.push('Inconsistent typography');
    }

    // 3. Color Harmony (20%)
    const harmonyScore = this.evaluateColorHarmony(context.colors);
    breakdown.push({
      criterion: 'colorHarmony',
      score: harmonyScore.score,
      weight: 0.2,
      details: harmonyScore.details,
    });
    if (harmonyScore.score >= 70) {
      strengths.push('Harmonious color combinations');
    } else if (harmonyScore.score < 50) {
      weaknesses.push('Clashing color combinations');
    }

    // 4. Whitespace Rhythm (20%)
    const spacingScore = this.evaluateWhitespaceRhythm(context.layout);
    breakdown.push({
      criterion: 'whitespaceRhythm',
      score: spacingScore.score,
      weight: 0.2,
      details: spacingScore.details,
    });
    if (spacingScore.score >= 70) {
      strengths.push('Good use of whitespace');
    } else if (spacingScore.score < 50) {
      weaknesses.push('Inconsistent spacing');
    }

    // 5. Responsive Design (20%)
    const responsiveScore = this.evaluateResponsiveDesign(context.layout);
    breakdown.push({
      criterion: 'responsiveDesign',
      score: responsiveScore.score,
      weight: 0.2,
      details: responsiveScore.details,
    });
    if (responsiveScore.score >= 70) {
      strengths.push('Well-implemented responsive design');
    } else if (responsiveScore.score < 50) {
      weaknesses.push('Limited responsive adaptations');
    }

    const score = this.calculateWeightedScore(breakdown);

    return { score, breakdown, strengths, weaknesses };
  }

  /**
   * Evaluate contextuality axis (25%)
   */
  evaluateContextuality(context: ScoringContext): AxisScore {
    const breakdown: ScoreBreakdown[] = [];
    const strengths: string[] = [];
    const weaknesses: string[] = [];

    // 1. Industry Fit (30%)
    const industryScore = this.evaluateIndustryFit(context);
    breakdown.push({
      criterion: 'industryFit',
      score: industryScore.score,
      weight: 0.3,
      details: industryScore.details,
    });
    if (industryScore.score >= 70) {
      strengths.push('Design fits industry expectations');
    } else if (industryScore.score < 50) {
      weaknesses.push('Poor industry fit');
    }

    // 2. Audience Fit (25%)
    const audienceScore = this.evaluateAudienceFit(context);
    breakdown.push({
      criterion: 'audienceFit',
      score: audienceScore.score,
      weight: 0.25,
      details: audienceScore.details,
    });
    if (audienceScore.score >= 70) {
      strengths.push('Design appeals to target audience');
    } else if (audienceScore.score < 50) {
      weaknesses.push('May not resonate with target audience');
    }

    // 3. Brand Consistency (25%)
    const brandScore = this.evaluateBrandConsistency(context);
    breakdown.push({
      criterion: 'brandConsistency',
      score: brandScore.score,
      weight: 0.25,
      details: brandScore.details,
    });
    if (brandScore.score >= 70) {
      strengths.push('Strong brand consistency');
    } else if (brandScore.score < 50) {
      weaknesses.push('Inconsistent branding');
    }

    // 4. Accessibility Compliance (20%)
    const a11yScore = this.evaluateAccessibilityCompliance(context);
    breakdown.push({
      criterion: 'accessibilityCompliance',
      score: a11yScore.score,
      weight: 0.2,
      details: a11yScore.details,
    });
    if (a11yScore.score >= 70) {
      strengths.push('Good accessibility practices');
    } else if (a11yScore.score < 50) {
      weaknesses.push('Poor accessibility');
    }

    const score = this.calculateWeightedScore(breakdown);

    return { score, breakdown, strengths, weaknesses };
  }

  /**
   * Set new scoring weights
   */
  setWeights(weights: Partial<ScoringWeights>): void {
    this.weights = this.normalizeWeights({
      ...this.weights,
      ...weights,
    });
  }

  /**
   * Get current scoring weights
   */
  getWeights(): ScoringWeights {
    return { ...this.weights };
  }

  /**
   * Calculate letter grade from score
   */
  calculateGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }

  /**
   * Generate summary text for a quality score
   */
  generateSummary(score: QualityScore): string {
    const gradeDescriptions: Record<string, string> = {
      A: 'excellent',
      B: 'good',
      C: 'average',
      D: 'below average',
      F: 'needs significant improvement',
    };

    const qualityWord = gradeDescriptions[score.grade];

    // Find strongest and weakest axis
    const axes = [
      { name: 'originality', score: score.originality.score },
      { name: 'craftsmanship', score: score.craftsmanship.score },
      { name: 'contextuality', score: score.contextuality.score },
    ];

    axes.sort((a, b) => b.score - a.score);
    const strongest = axes[0] ?? { name: 'unknown', score: 0 };
    const weakest = axes[2] ?? axes[axes.length - 1] ?? { name: 'unknown', score: 0 };

    let summary = `This design is rated ${score.grade} (${qualityWord}) `;
    summary += `with an overall score of ${score.overall.toFixed(1)}. `;
    summary += `Strongest area: ${strongest.name} (${strongest.score.toFixed(1)}). `;
    summary += `Area for improvement: ${weakest.name} (${weakest.score.toFixed(1)}).`;

    return summary;
  }

  /**
   * Generate improvement recommendations
   */
  generateRecommendations(score: QualityScore): string[] {
    const recommendations: string[] = [];

    // Perfect score - no recommendations needed
    if (
      score.originality.score >= 100 &&
      score.craftsmanship.score >= 100 &&
      score.contextuality.score >= 100
    ) {
      return [];
    }

    // Sort axes by score (lowest first)
    const axes = [
      { name: 'originality', axisScore: score.originality },
      { name: 'craftsmanship', axisScore: score.craftsmanship },
      { name: 'contextuality', axisScore: score.contextuality },
    ].sort((a, b) => a.axisScore.score - b.axisScore.score);

    // Generate recommendations based on weaknesses
    for (const axis of axes) {
      if (axis.axisScore.score < 80) {
        for (const weakness of axis.axisScore.weaknesses) {
          recommendations.push(this.generateRecommendationFor(axis.name, weakness));
          if (recommendations.length >= 10) break;
        }
      }
      if (recommendations.length >= 10) break;
    }

    // Add generic recommendations if needed
    if (recommendations.length === 0 && score.overall < 90) {
      if (score.originality.score < 90) {
        recommendations.push('Consider adding more unique design elements to improve originality.');
      }
      if (score.craftsmanship.score < 90) {
        recommendations.push('Fine-tune spacing and alignment for better craftsmanship.');
      }
      if (score.contextuality.score < 90) {
        recommendations.push('Ensure design aligns well with target audience and industry.');
      }
    }

    return recommendations.slice(0, 10);
  }

  // =========================================
  // Private Evaluation Methods
  // =========================================

  private evaluateUniqueColorUsage(colors: ColorInfo): { score: number; details: string } {
    if (!colors.palette || colors.palette.length === 0) {
      return { score: 30, details: 'No color palette detected' };
    }

    const paletteSize = colors.palette.length;
    let score = 0;

    // Base score from palette diversity (up to 40 points)
    if (paletteSize >= 5) {
      score += 40;
    } else if (paletteSize >= 3) {
      score += 25;
    } else {
      score += 10;
    }

    // Check for accent color (up to 20 points)
    if (colors.accent) {
      score += 20;
    }

    // Check for color role diversity (up to 20 points)
    const roles = new Set(colors.palette.map((c) => c.role).filter(Boolean));
    score += Math.min(roles.size * 5, 20);

    // Check contrast between colors (up to 20 points)
    const hasGoodContrast = this.checkColorContrast(colors.text, colors.background);
    if (hasGoodContrast) {
      score += 20;
    }

    return {
      score: Math.min(score, 100),
      details: `${paletteSize} colors in palette, ${roles.size} distinct roles`,
    };
  }

  private evaluateLayoutCreativity(sections: DetectedSection[]): { score: number; details: string } {
    if (!sections || sections.length === 0) {
      return { score: 30, details: 'No sections detected' };
    }

    let score = 0;

    // Get unique section types
    const sectionTypes = new Set(sections.map((s) => s.type));
    const uniqueCount = sectionTypes.size;

    // Base score from section variety (up to 50 points)
    if (uniqueCount >= 6) {
      score += 50;
    } else if (uniqueCount >= 4) {
      score += 35;
    } else if (uniqueCount >= 3) {
      score += 25;
    } else {
      score += 15;
    }

    // Bonus for having key section types (up to 30 points)
    const keyTypes: SectionType[] = ['hero', 'feature', 'testimonial', 'pricing', 'cta'];
    const hasKeyTypes = keyTypes.filter((t) => sectionTypes.has(t));
    score += hasKeyTypes.length * 6;

    // Bonus for section count (up to 20 points)
    if (sections.length >= 6) {
      score += 20;
    } else if (sections.length >= 4) {
      score += 15;
    } else {
      score += 10;
    }

    return {
      score: Math.min(score, 100),
      details: `${uniqueCount} unique section types, ${sections.length} total sections`,
    };
  }

  private evaluateTypographyPersonality(typography: TypographyInfo): { score: number; details: string } {
    if (!typography.fonts || typography.fonts.length === 0) {
      return { score: 30, details: 'No typography detected' };
    }

    let score = 0;

    // Check if using custom fonts vs generic (up to 40 points)
    const fontFamilies = typography.fonts.map((f) => f.family.toLowerCase());
    const genericCount = fontFamilies.filter((f) => GENERIC_FONTS.includes(f)).length;
    const customCount = fontFamilies.length - genericCount;

    if (customCount >= 2) {
      score += 40;
    } else if (customCount >= 1) {
      score += 25;
    } else {
      score += 10;
    }

    // Check font weight variety (up to 30 points)
    const allWeights = typography.fonts.flatMap((f) => f.weights);
    const uniqueWeights = new Set(allWeights).size;
    if (uniqueWeights >= 4) {
      score += 30;
    } else if (uniqueWeights >= 3) {
      score += 20;
    } else {
      score += 10;
    }

    // Check heading scale (up to 30 points)
    const headingScale = typography.headingScale || [];
    if (headingScale.length >= 5) {
      score += 30;
    } else if (headingScale.length >= 3) {
      score += 20;
    } else {
      score += 10;
    }

    return {
      score: Math.min(score, 100),
      details: `${customCount} custom fonts, ${uniqueWeights} weight variations`,
    };
  }

  private evaluateAntiClicheBonus(clicheReport?: ClicheReport): { score: number; details: string } {
    if (!clicheReport) {
      // No cliche report means we assume moderate originality
      return { score: 60, details: 'No cliche analysis available' };
    }

    // Invert cliche score (0 cliches = 100, 1 cliche = 0)
    const score = Math.round((1 - clicheReport.totalClicheScore) * 100);
    const clicheCount = clicheReport.detectedCliches.length;

    return {
      score: Math.max(0, Math.min(100, score)),
      details: `${clicheCount} cliches detected, score ${clicheReport.totalClicheScore.toFixed(2)}`,
    };
  }

  private evaluateGridAlignment(layout: LayoutInfo): { score: number; details: string } {
    let score = 0;

    // Check layout type (up to 30 points)
    if (layout.type === 'grid') {
      score += 30;
    } else if (layout.type === 'flex') {
      score += 25;
    } else {
      score += 10;
    }

    // Check column system (up to 30 points)
    if (layout.columns && layout.columns >= 12) {
      score += 30;
    } else if (layout.columns && layout.columns >= 6) {
      score += 20;
    } else if (layout.columns) {
      score += 10;
    }

    // Check gutter definition (up to 20 points)
    if (layout.gutterWidth && layout.gutterWidth > 0) {
      score += 20;
    }

    // Check max-width constraint (up to 20 points)
    if (layout.maxWidth && layout.maxWidth > 0) {
      score += 20;
    }

    return {
      score: Math.min(score, 100),
      details: `${layout.type} layout, ${layout.columns || 0} columns`,
    };
  }

  private evaluateTypographyConsistency(typography: TypographyInfo): { score: number; details: string } {
    let score = 0;

    // Check font family count - fewer is more consistent (up to 30 points)
    const fontCount = typography.fonts.length;
    if (fontCount === 1 || fontCount === 2) {
      score += 30;
    } else if (fontCount === 3) {
      score += 20;
    } else {
      score += 10;
    }

    // Check heading scale regularity (up to 40 points)
    const scale = typography.headingScale || [];
    if (scale.length >= 4) {
      // Check if scale is roughly consistent (modular scale)
      const ratios: number[] = [];
      for (let i = 0; i < scale.length - 1; i++) {
        const current = scale[i];
        const next = scale[i + 1];
        if (current !== undefined && next !== undefined && next !== 0) {
          ratios.push(current / next);
        }
      }
      const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      const variance = ratios.reduce((sum, r) => sum + Math.pow(r - avgRatio, 2), 0) / ratios.length;

      if (variance < 0.1) {
        score += 40;
      } else if (variance < 0.3) {
        score += 30;
      } else {
        score += 20;
      }
    } else {
      score += 15;
    }

    // Check line height consistency (up to 30 points)
    if (typography.lineHeight >= 1.4 && typography.lineHeight <= 1.7) {
      score += 30;
    } else if (typography.lineHeight >= 1.2 && typography.lineHeight <= 2) {
      score += 20;
    } else {
      score += 10;
    }

    return {
      score: Math.min(score, 100),
      details: `${fontCount} font families, ${typography.lineHeight} line-height`,
    };
  }

  private evaluateColorHarmony(colors: ColorInfo): { score: number; details: string } {
    if (!colors.palette || colors.palette.length === 0) {
      return { score: 30, details: 'No color palette detected' };
    }

    let score = 0;

    // Check contrast between text and background (up to 40 points)
    const contrast = this.calculateContrastRatio(colors.text, colors.background);
    if (contrast >= 7) {
      score += 40; // AAA compliant
    } else if (contrast >= 4.5) {
      score += 30; // AA compliant
    } else if (contrast >= 3) {
      score += 20;
    } else {
      score += 10;
    }

    // Check if accent complements dominant (up to 30 points)
    // Simple heuristic: colors should be distinguishable
    if (colors.accent && colors.dominant) {
      const accentDifference = this.colorDifference(colors.accent, colors.dominant);
      if (accentDifference > 50) {
        score += 30;
      } else if (accentDifference > 30) {
        score += 20;
      } else {
        score += 10;
      }
    } else {
      score += 15;
    }

    // Check palette cohesion (up to 30 points)
    // Simple check: not too many high-saturation colors
    score += 30; // Default to good cohesion

    return {
      score: Math.min(score, 100),
      details: `Contrast ratio: ${contrast.toFixed(2)}`,
    };
  }

  private evaluateWhitespaceRhythm(layout: LayoutInfo): { score: number; details: string } {
    if (!layout.spacing) {
      return { score: 50, details: 'No spacing information available' };
    }

    let score = 0;

    // Check section spacing (up to 40 points)
    if (layout.spacing.section >= 60 && layout.spacing.section <= 120) {
      score += 40;
    } else if (layout.spacing.section >= 40 && layout.spacing.section <= 150) {
      score += 25;
    } else {
      score += 15;
    }

    // Check element spacing (up to 30 points)
    if (layout.spacing.element >= 16 && layout.spacing.element <= 40) {
      score += 30;
    } else if (layout.spacing.element >= 8) {
      score += 20;
    } else {
      score += 10;
    }

    // Check spacing ratio consistency (up to 30 points)
    const sectionToElement = layout.spacing.section / layout.spacing.element;
    const elementToComponent = layout.spacing.element / layout.spacing.component;

    // Good ratio is around 2-4x
    if (sectionToElement >= 2 && sectionToElement <= 5 && elementToComponent >= 1 && elementToComponent <= 3) {
      score += 30;
    } else {
      score += 15;
    }

    return {
      score: Math.min(score, 100),
      details: `Section: ${layout.spacing.section}px, Element: ${layout.spacing.element}px`,
    };
  }

  private evaluateResponsiveDesign(layout: LayoutInfo): { score: number; details: string } {
    if (!layout.responsive) {
      return { score: 30, details: 'No responsive information available' };
    }

    let score = 0;

    // Check breakpoint count (up to 50 points)
    const breakpointCount = layout.responsive.breakpoints.length;
    if (breakpointCount >= 4) {
      score += 50;
    } else if (breakpointCount >= 3) {
      score += 40;
    } else if (breakpointCount >= 2) {
      score += 25;
    } else if (breakpointCount >= 1) {
      score += 15;
    } else {
      score += 0;
    }

    // Check adaptations (up to 50 points)
    const adaptationCount = layout.responsive.adaptations.length;
    if (adaptationCount >= 4) {
      score += 50;
    } else if (adaptationCount >= 3) {
      score += 40;
    } else if (adaptationCount >= 2) {
      score += 30;
    } else if (adaptationCount >= 1) {
      score += 20;
    } else {
      score += 0;
    }

    return {
      score: Math.min(score, 100),
      details: `${breakpointCount} breakpoints, ${adaptationCount} adaptations`,
    };
  }

  private evaluateIndustryFit(context: ScoringContext): { score: number; details: string } {
    if (!context.targetIndustry) {
      // Without industry info, give a neutral score
      return { score: 60, details: 'No target industry specified' };
    }

    const industry = context.targetIndustry.toLowerCase();
    const expectedSections = INDUSTRY_SECTIONS[industry];

    if (!expectedSections) {
      // Unknown industry, give neutral score
      return { score: 60, details: `Unknown industry: ${context.targetIndustry}` };
    }

    // Check how many expected sections are present
    const sectionTypes = new Set(context.sections.map((s) => s.type));
    const matchCount = expectedSections.filter((t) => sectionTypes.has(t)).length;
    const matchRatio = matchCount / expectedSections.length;

    const score = Math.round(matchRatio * 100);

    return {
      score: Math.max(40, Math.min(100, score)),
      details: `${matchCount}/${expectedSections.length} expected sections present`,
    };
  }

  private evaluateAudienceFit(context: ScoringContext): { score: number; details: string } {
    if (!context.targetAudience) {
      return { score: 60, details: 'No target audience specified' };
    }

    let score = 60; // Base score

    const audience = context.targetAudience.toLowerCase();

    // Check typography fit for audience
    const fontFamilies = context.typography.fonts.map((f) => f.family.toLowerCase());

    // Developers prefer monospace/technical fonts
    if (audience.includes('developer') || audience.includes('technical')) {
      const hasTechnicalFont = fontFamilies.some(
        (f) => f.includes('mono') || f.includes('code') || f.includes('jetbrains')
      );
      if (hasTechnicalFont) {
        score += 20;
      }
    }

    // Modern/young audience prefers contemporary typography
    if (audience.includes('young') || audience.includes('modern')) {
      const hasModernFont = fontFamilies.some(
        (f) =>
          f.includes('inter') ||
          f.includes('poppins') ||
          f.includes('montserrat') ||
          f.includes('space')
      );
      if (hasModernFont) {
        score += 20;
      }
    }

    // General bonus for having custom fonts
    if (fontFamilies.some((f) => !GENERIC_FONTS.includes(f))) {
      score += 10;
    }

    return {
      score: Math.min(100, score),
      details: `Target audience: ${context.targetAudience}`,
    };
  }

  private evaluateBrandConsistency(context: ScoringContext): { score: number; details: string } {
    let score = 0;

    // Check color consistency across sections (up to 50 points)
    const sectionColors = context.sections
      .map((s) => s.style.backgroundColor || s.style.textColor)
      .filter((c): c is string => Boolean(c));
    const paletteColors = new Set(context.colors.palette.map((c) => c.hex.toLowerCase()));

    if (sectionColors.length > 0) {
      const matchingColors = sectionColors.filter((c) => paletteColors.has(c.toLowerCase()));
      const consistency = matchingColors.length / sectionColors.length;
      score += Math.round(consistency * 50);
    } else {
      score += 25;
    }

    // Check if primary color is used prominently (up to 30 points)
    if (context.colors.dominant) {
      score += 30;
    }

    // Check typography consistency (up to 20 points)
    if (context.typography.fonts.length <= 2) {
      score += 20;
    } else {
      score += 10;
    }

    return {
      score: Math.min(100, score),
      details: 'Brand consistency evaluation',
    };
  }

  private evaluateAccessibilityCompliance(context: ScoringContext): { score: number; details: string } {
    let score = 0;

    // Check text/background contrast (up to 60 points)
    const contrast = this.calculateContrastRatio(context.colors.text, context.colors.background);
    if (contrast >= 7) {
      score += 60; // AAA
    } else if (contrast >= 4.5) {
      score += 45; // AA
    } else if (contrast >= 3) {
      score += 25;
    } else {
      score += 10;
    }

    // Check for sufficient font size (up to 20 points)
    if (context.typography.bodySize >= 16) {
      score += 20;
    } else if (context.typography.bodySize >= 14) {
      score += 10;
    }

    // Check for good line height (up to 20 points)
    if (context.typography.lineHeight >= 1.5) {
      score += 20;
    } else if (context.typography.lineHeight >= 1.3) {
      score += 10;
    }

    return {
      score: Math.min(100, score),
      details: `Contrast ratio: ${contrast.toFixed(2)}, body size: ${context.typography.bodySize}px`,
    };
  }

  // =========================================
  // Private Helper Methods
  // =========================================

  private normalizeWeights(weights: ScoringWeights): ScoringWeights {
    // Clamp individual weights
    const clamped = {
      originality: Math.max(0, Math.min(1, weights.originality)),
      craftsmanship: Math.max(0, Math.min(1, weights.craftsmanship)),
      contextuality: Math.max(0, Math.min(1, weights.contextuality)),
    };

    // Normalize to sum to 1.0
    const sum = clamped.originality + clamped.craftsmanship + clamped.contextuality;
    if (sum === 0) {
      return DEFAULT_WEIGHTS;
    }

    return {
      originality: clamped.originality / sum,
      craftsmanship: clamped.craftsmanship / sum,
      contextuality: clamped.contextuality / sum,
    };
  }

  private calculateWeightedScore(breakdown: ScoreBreakdown[]): number {
    return this.roundTo2Decimals(
      breakdown.reduce((sum, b) => sum + b.score * b.weight, 0)
    );
  }

  private roundTo2Decimals(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private checkColorContrast(color1: string, color2: string): boolean {
    const ratio = this.calculateContrastRatio(color1, color2);
    return ratio >= 4.5;
  }

  private calculateContrastRatio(foreground: string, background: string): number {
    try {
      const fgLum = this.getLuminance(foreground);
      const bgLum = this.getLuminance(background);

      const lighter = Math.max(fgLum, bgLum);
      const darker = Math.min(fgLum, bgLum);

      return (lighter + 0.05) / (darker + 0.05);
    } catch {
      return 4.5; // Default to passing contrast if calculation fails
    }
  }

  private getLuminance(hex: string): number {
    // Remove # if present
    const color = hex.replace('#', '');

    // Parse RGB values
    let r: number, g: number, b: number;

    if (color.length === 3) {
      const c0 = color[0] ?? '0';
      const c1 = color[1] ?? '0';
      const c2 = color[2] ?? '0';
      r = parseInt(c0 + c0, 16) / 255;
      g = parseInt(c1 + c1, 16) / 255;
      b = parseInt(c2 + c2, 16) / 255;
    } else if (color.length === 6) {
      r = parseInt(color.substring(0, 2), 16) / 255;
      g = parseInt(color.substring(2, 4), 16) / 255;
      b = parseInt(color.substring(4, 6), 16) / 255;
    } else if (color === 'white') {
      return 1;
    } else if (color === 'black') {
      return 0;
    } else {
      return 0.5; // Default for unknown colors
    }

    // Apply gamma correction
    const adjustChannel = (channel: number): number => {
      return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    };

    r = adjustChannel(r);
    g = adjustChannel(g);
    b = adjustChannel(b);

    // Calculate relative luminance
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  private colorDifference(color1: string, color2: string): number {
    try {
      const c1 = this.hexToRgb(color1);
      const c2 = this.hexToRgb(color2);

      return Math.sqrt(
        Math.pow(c1.r - c2.r, 2) + Math.pow(c1.g - c2.g, 2) + Math.pow(c1.b - c2.b, 2)
      );
    } catch {
      return 50; // Default moderate difference
    }
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } {
    const color = hex.replace('#', '');
    if (color.length === 3) {
      const c0 = color[0] ?? '0';
      const c1 = color[1] ?? '0';
      const c2 = color[2] ?? '0';
      return {
        r: parseInt(c0 + c0, 16),
        g: parseInt(c1 + c1, 16),
        b: parseInt(c2 + c2, 16),
      };
    }
    return {
      r: parseInt(color.substring(0, 2), 16),
      g: parseInt(color.substring(2, 4), 16),
      b: parseInt(color.substring(4, 6), 16),
    };
  }

  private generateRecommendationFor(axis: string, weakness: string): string {
    const recommendations: Record<string, Record<string, string>> = {
      originality: {
        'Generic color palette': 'Consider using a more distinctive color palette with unique accent colors.',
        'Limited section variety': 'Add more varied section types to create visual interest.',
        'Generic font selection': 'Consider using custom web fonts to establish a unique typographic identity.',
        'Heavy use of design cliches': 'Review and replace common design patterns with more original alternatives.',
        default: 'Explore more unique design elements to improve originality.',
      },
      craftsmanship: {
        'Inconsistent or missing grid structure': 'Implement a consistent grid system (e.g., 12-column) for better alignment.',
        'Inconsistent typography': 'Establish a clear typography hierarchy with consistent sizing and spacing.',
        'Clashing color combinations': 'Review color harmony and ensure colors work well together.',
        'Inconsistent spacing': 'Apply consistent spacing values using a spacing scale (e.g., 8px base).',
        'Limited responsive adaptations': 'Add more breakpoints and responsive adaptations for different devices.',
        default: 'Fine-tune spacing, alignment, and consistency for better craftsmanship.',
      },
      contextuality: {
        'Poor industry fit': 'Review industry best practices and ensure design meets user expectations.',
        'May not resonate with target audience': 'Research target audience preferences and adjust design accordingly.',
        'Inconsistent branding': 'Ensure consistent use of brand colors and typography throughout.',
        'Poor accessibility': 'Improve color contrast and ensure minimum font sizes for better accessibility.',
        default: 'Ensure design aligns with target audience and industry context.',
      },
    };

    const axisRecs = recommendations[axis] || {};
    return axisRecs[weakness] || axisRecs.default || `Improve ${axis} to address: ${weakness}`;
  }
}
