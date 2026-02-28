// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Theme Detector Service
 *
 * Detects light/dark/mixed themes from images and color palettes
 * using WCAG 2.1 compliant luminance and contrast calculations.
 *
 * Security features:
 * - Input size validation (5MB max) - SEC H-1
 * - Processing timeout (30s default) - SEC M-1
 *
 * @module services/visual-extractor/theme-detector.service
 */

import { logger } from '../../utils/logger';
import type { ColorExtractionResult } from './color-extractor.service';
import { createColorExtractorService } from './color-extractor.service';
import {
  parseAndValidateImageInput,
  withTimeout,
  DEFAULT_PROCESSING_TIMEOUT,
  logSecurityEvent,
  parseHexColor,
} from './image-utils';
import type { ComputedStyleInfo } from '../page-ingest-adapter';
import {
  createPixelThemeDetectorService,
  type PixelThemeDetectionResult,
} from './pixel-theme-detector.service';

/**
 * Result of theme detection from an image or color palette
 */
export interface ThemeDetectionResult {
  /** Detected theme: light, dark, or mixed */
  theme: 'light' | 'dark' | 'mixed';
  /** Confidence score (0-1) */
  confidence: number;
  /** Estimated background color in HEX format */
  backgroundColor: string;
  /** Estimated text color in HEX format */
  textColor: string;
  /** WCAG contrast ratio between background and text */
  contrastRatio: number;
  /** Luminance values */
  luminance: {
    /** Background relative luminance (0-1) */
    background: number;
    /** Foreground/text relative luminance (0-1) */
    foreground: number;
  };
}

/**
 * Extended theme detection result with computed styles usage flag
 */
export interface ThemeDetectionResultWithComputedStyles extends ThemeDetectionResult {
  /** Whether computed styles were used for detection (true if used, false if fallback to screenshot) */
  computedStylesUsed: boolean;
}

/**
 * Theme detector service interface
 */
export interface ThemeDetectorService {
  /**
   * Detect theme from an image
   * @param image - Image as Buffer or Base64 string
   * @returns Promise resolving to theme detection result
   */
  detectTheme(image: Buffer | string): Promise<ThemeDetectionResult>;

  /**
   * Detect theme from color extraction result
   * @param colors - Color extraction result from ColorExtractorService
   * @returns Theme detection result
   */
  detectThemeFromColors(colors: ColorExtractionResult): ThemeDetectionResult;

  /**
   * Detect theme using direct pixel analysis (WCAG-compliant luminance)
   *
   * This method provides more accurate theme detection than color palette
   * extraction by directly analyzing pixel luminance values using WCAG 2.1
   * gamma-corrected relative luminance calculation.
   *
   * Thresholds:
   * - Dark: luminance < 0.3
   * - Light: luminance > 0.7
   * - Mixed: 0.3 <= luminance <= 0.7
   *
   * @param screenshot - Screenshot image as Buffer
   * @returns Promise resolving to pixel-based theme detection result
   */
  detectThemeFromPixels(screenshot: Buffer): Promise<PixelThemeDetectionResult>;

  /**
   * Detect theme using computed styles from Playwright, with pixel-based fallback
   *
   * Detection priority:
   * 1. Computed backgroundColor from Playwright (if available and non-transparent)
   * 2. Pixel-based analysis (WCAG-compliant luminance from actual pixels)
   *
   * This method prioritizes computed backgroundColor values from actual rendered CSS,
   * which is more accurate than screenshot-based detection for sites using CSS-in-JS
   * or Tailwind CSS that apply styles at runtime.
   *
   * @param screenshot - Screenshot image as Buffer
   * @param computedStyles - Computed styles from Playwright (optional)
   * @returns Promise resolving to theme detection result with computedStylesUsed flag
   */
  detectThemeWithComputedStyles(
    screenshot: Buffer,
    computedStyles?: ComputedStyleInfo[]
  ): Promise<ThemeDetectionResultWithComputedStyles>;

  /**
   * Calculate WCAG 2.1 relative luminance for a color
   * @param hexColor - Color in HEX format (#RRGGBB or RRGGBB)
   * @returns Relative luminance (0-1)
   */
  calculateLuminance(hexColor: string): number;

  /**
   * Calculate WCAG contrast ratio between two colors
   * @param color1 - First color in HEX format
   * @param color2 - Second color in HEX format
   * @returns Contrast ratio (1-21)
   */
  calculateContrastRatio(color1: string, color2: string): number;
}

/**
 * Convert sRGB color component to linear RGB (gamma correction)
 * WCAG 2.1 specification
 * @param component - sRGB component (0-255)
 * @returns Linear RGB value (0-1)
 */
function sRGBToLinear(component: number): number {
  const srgb = component / 255;

  if (srgb <= 0.04045) {
    return srgb / 12.92;
  } else {
    return Math.pow((srgb + 0.055) / 1.055, 2.4);
  }
}

/**
 * Calculate WCAG 2.1 relative luminance
 * L = 0.2126 * R + 0.7152 * G + 0.0722 * B
 * where R, G, B are linear RGB values (gamma corrected)
 */
function calculateRelativeLuminance(hexColor: string): number {
  const { r, g, b } = parseHexColor(hexColor);

  const rLinear = sRGBToLinear(r);
  const gLinear = sRGBToLinear(g);
  const bLinear = sRGBToLinear(b);

  return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear;
}

/**
 * Calculate WCAG contrast ratio
 * Ratio = (L1 + 0.05) / (L2 + 0.05)
 * where L1 is the lighter luminance and L2 is the darker
 */
function calculateWCAGContrastRatio(color1: string, color2: string): number {
  const l1 = calculateRelativeLuminance(color1);
  const l2 = calculateRelativeLuminance(color2);

  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Determine ideal text color for a given background
 * @param backgroundLuminance - Background relative luminance
 * @returns Text color hex (#FFFFFF or #000000 or variant)
 */
function getIdealTextColor(backgroundLuminance: number): string {
  // Use white text on dark backgrounds, black text on light backgrounds
  // Threshold is around 0.179 for optimal readability
  if (backgroundLuminance > 0.179) {
    return '#212121'; // Near black for light backgrounds
  } else {
    return '#FAFAFA'; // Near white for dark backgrounds
  }
}

/**
 * Determine theme from luminance and calculate confidence
 *
 * Mixed theme detection is only triggered when:
 * 1. There's very high variance in luminance (> 0.45 std dev)
 * 2. AND the background luminance is close to 0.5 (ambiguous zone)
 *
 * Normal webpages (light bg + dark text, or dark bg + light text)
 * should NOT be detected as mixed, as they have a clear dominant theme.
 */
function determineTheme(
  backgroundLuminance: number,
  colorVariance: number,
  dominantPercentage: number
): { theme: 'light' | 'dark' | 'mixed'; confidence: number } {
  // Light theme threshold: luminance > 0.5
  // Dark theme threshold: luminance < 0.5
  const lightThreshold = 0.5;

  // Mixed detection thresholds - more restrictive
  // Only consider mixed if:
  // - Variance is very high (> 0.45)
  // - AND luminance is in ambiguous zone (0.3 - 0.7)
  // - AND dominant color covers less than 50% of the image
  const mixedVarianceThreshold = 0.45;
  const ambiguousZoneLow = 0.3;
  const ambiguousZoneHigh = 0.7;
  const dominantCoverageThreshold = 50;

  // Calculate distance from threshold for confidence
  const distanceFromThreshold = Math.abs(backgroundLuminance - lightThreshold);

  let theme: 'light' | 'dark' | 'mixed';
  let confidence: number;

  // Check for mixed theme - very restrictive conditions
  const isInAmbiguousZone = backgroundLuminance > ambiguousZoneLow && backgroundLuminance < ambiguousZoneHigh;
  const hasHighVariance = colorVariance > mixedVarianceThreshold;
  const hasLowDominance = dominantPercentage < dominantCoverageThreshold;

  if (hasHighVariance && isInAmbiguousZone && hasLowDominance) {
    theme = 'mixed';
    confidence = Math.min(0.8, colorVariance);
  } else if (backgroundLuminance > lightThreshold) {
    theme = 'light';
    // Confidence increases with distance from threshold
    // Also boost confidence when dominant color is clearly dominant
    const dominanceBoost = Math.min(0.2, dominantPercentage / 200);
    confidence = Math.min(1.0, 0.5 + distanceFromThreshold + dominanceBoost);
  } else {
    theme = 'dark';
    const dominanceBoost = Math.min(0.2, dominantPercentage / 200);
    confidence = Math.min(1.0, 0.5 + distanceFromThreshold + dominanceBoost);
  }

  return { theme, confidence };
}

/**
 * Calculate luminance variance in a color palette
 */
function calculateLuminanceVariance(colorPalette: Array<{ color: string; percentage: number }>): number {
  if (colorPalette.length < 2) {
    return 0;
  }

  const luminances = colorPalette.map((item) => ({
    luminance: calculateRelativeLuminance(item.color),
    weight: item.percentage,
  }));

  // Calculate weighted mean
  let totalWeight = 0;
  let weightedSum = 0;
  for (const item of luminances) {
    weightedSum += item.luminance * item.weight;
    totalWeight += item.weight;
  }
  const mean = totalWeight > 0 ? weightedSum / totalWeight : 0.5;

  // Calculate weighted variance
  let varianceSum = 0;
  for (const item of luminances) {
    varianceSum += item.weight * Math.pow(item.luminance - mean, 2);
  }
  const variance = totalWeight > 0 ? varianceSum / totalWeight : 0;

  return Math.sqrt(variance); // Return standard deviation
}

// =============================================================================
// Helper Types and Functions for Theme Detection from Colors
// =============================================================================

/**
 * Result of weighted luminance calculation
 */
interface WeightedLuminanceResult {
  weightedLuminance: number;
  totalWeight: number;
}

/**
 * Result of background color detection
 */
interface BackgroundColorResult {
  backgroundColor: string;
  backgroundPercentage: number;
}

/**
 * Calculate weighted average luminance from color palette
 */
function calculateWeightedLuminance(
  colorPalette: Array<{ color: string; percentage: number }>
): WeightedLuminanceResult {
  let weightedLuminance = 0;
  let totalWeight = 0;

  for (const item of colorPalette) {
    const lum = calculateRelativeLuminance(item.color);
    weightedLuminance += lum * item.percentage;
    totalWeight += item.percentage;
  }

  if (totalWeight > 0) {
    weightedLuminance = weightedLuminance / totalWeight;
  } else {
    weightedLuminance = 0.5;
  }

  return { weightedLuminance, totalWeight };
}

/**
 * Find the most representative background color
 */
function findBestBackgroundColor(
  colorPalette: Array<{ color: string; percentage: number }>,
  weightedLuminance: number
): string {
  let bestMatch = { color: '#808080', score: -1 };

  for (const item of colorPalette) {
    const lum = calculateRelativeLuminance(item.color);
    const proximityScore = 1 - Math.abs(lum - weightedLuminance);
    const score = item.percentage * proximityScore;
    if (score > bestMatch.score) {
      bestMatch = { color: item.color, score };
    }
  }

  return bestMatch.color;
}

/**
 * Calculate percentage of colors with similar luminance to background
 */
function calculateBackgroundPercentage(
  colorPalette: Array<{ color: string; percentage: number }>,
  backgroundColor: string
): number {
  const bgLum = calculateRelativeLuminance(backgroundColor);
  let backgroundPercentage = 0;

  for (const item of colorPalette) {
    const lum = calculateRelativeLuminance(item.color);
    if (Math.abs(lum - bgLum) < 0.2) {
      backgroundPercentage += item.percentage;
    }
  }

  return backgroundPercentage;
}

/**
 * Detect background from color palette
 */
function detectBackgroundFromPalette(
  colorPalette: Array<{ color: string; percentage: number }>
): BackgroundColorResult & { weightedLuminance: number } {
  const { weightedLuminance } = calculateWeightedLuminance(colorPalette);
  const backgroundColor = findBestBackgroundColor(colorPalette, weightedLuminance);
  const backgroundPercentage = calculateBackgroundPercentage(colorPalette, backgroundColor);

  return {
    backgroundColor,
    backgroundPercentage,
    weightedLuminance,
  };
}

// parseImageInput has been moved to image-utils.ts as parseAndValidateImageInput
// with additional security controls (size validation)

/**
 * Internal implementation of ThemeDetectorService
 */
class ThemeDetectorServiceImpl implements ThemeDetectorService {
  private colorExtractor = createColorExtractorService();
  private pixelThemeDetector = createPixelThemeDetectorService();

  async detectTheme(image: Buffer | string): Promise<ThemeDetectionResult> {
    // Parse and validate input with size check (5MB max) - SEC H-1
    const imageBuffer = parseAndValidateImageInput(image);

    logSecurityEvent('ThemeDetector', 'Processing image', {
      size: imageBuffer.length,
      sizeKB: Math.round(imageBuffer.length / 1024),
    });

    // Wrap processing with timeout (30s default) - SEC M-1
    return withTimeout(this.detectThemeInternal(imageBuffer), DEFAULT_PROCESSING_TIMEOUT);
  }

  private async detectThemeInternal(imageBuffer: Buffer): Promise<ThemeDetectionResult> {
    // Extract colors from image (color extractor has its own timeout)
    const colorResult = await this.colorExtractor.extractColors(imageBuffer);

    // Use the color-based detection
    return this.detectThemeFromColors(colorResult);
  }

  detectThemeFromColors(colors: ColorExtractionResult): ThemeDetectionResult {
    // Detect background from color palette or dominant colors
    const bgResult = this.detectBackground(colors);
    const { backgroundColor, backgroundPercentage, weightedLuminance } = bgResult;

    // Calculate text color based on background luminance
    const textColor = getIdealTextColor(weightedLuminance);
    const foregroundLuminance = this.calculateLuminance(textColor);

    // Calculate contrast ratio and variance
    const contrastRatio = this.calculateContrastRatio(backgroundColor, textColor);
    const variance = calculateLuminanceVariance(colors.colorPalette);

    // Determine theme and confidence
    const { theme, confidence } = determineTheme(weightedLuminance, variance, backgroundPercentage);

    logger.debug('[ThemeDetector] Theme detection result:', {
      theme,
      confidence: confidence.toFixed(3),
      backgroundColor,
      textColor,
      backgroundLuminance: weightedLuminance.toFixed(4),
      foregroundLuminance: foregroundLuminance.toFixed(4),
      contrastRatio: contrastRatio.toFixed(2),
      variance: variance.toFixed(4),
    });

    return {
      theme,
      confidence,
      backgroundColor,
      textColor,
      contrastRatio,
      luminance: {
        background: weightedLuminance,
        foreground: foregroundLuminance,
      },
    };
  }

  async detectThemeFromPixels(screenshot: Buffer): Promise<PixelThemeDetectionResult> {
    return this.pixelThemeDetector.detectTheme(screenshot);
  }

  /**
   * Detect background color from color extraction result
   */
  private detectBackground(colors: ColorExtractionResult): BackgroundColorResult & { weightedLuminance: number } {
    if (colors.colorPalette.length > 0) {
      return detectBackgroundFromPalette(colors.colorPalette);
    }

    if (colors.dominantColors.length > 0) {
      const backgroundColor = colors.dominantColors[0] ?? '#808080';
      return {
        backgroundColor,
        backgroundPercentage: 50,
        weightedLuminance: this.calculateLuminance(backgroundColor),
      };
    }

    return {
      backgroundColor: '#808080',
      backgroundPercentage: 50,
      weightedLuminance: 0.5,
    };
  }

  calculateLuminance(hexColor: string): number {
    return calculateRelativeLuminance(hexColor);
  }

  calculateContrastRatio(color1: string, color2: string): number {
    return calculateWCAGContrastRatio(color1, color2);
  }

  /**
   * Detect theme using computed styles with screenshot fallback
   *
   * Problem: Sites like E&A Financial (https://ea.madebybuzzworthy.com/)
   * use dark backgrounds (#0A1628) via CSS-in-JS/Tailwind that are not
   * captured by static HTML analysis or screenshot color extraction alone.
   *
   * Solution: Prioritize computed backgroundColor values from Playwright's
   * getComputedStyle() results for accurate theme detection.
   */
  async detectThemeWithComputedStyles(
    screenshot: Buffer,
    computedStyles?: ComputedStyleInfo[]
  ): Promise<ThemeDetectionResultWithComputedStyles> {
    // Try to extract valid background colors from computed styles
    const computedBgResult = this.extractBackgroundFromComputedStyles(computedStyles);

    if (computedBgResult.valid) {
      // Use computed styles for theme detection
      const { backgroundColor, textColor } = computedBgResult;
      const bgLuminance = this.calculateLuminance(backgroundColor);
      const fgLuminance = this.calculateLuminance(textColor);
      const contrastRatio = this.calculateContrastRatio(backgroundColor, textColor);

      // Determine theme from background luminance
      const theme = bgLuminance > 0.5 ? 'light' : 'dark';
      // High confidence when using computed styles
      const confidence = 0.95;

      logger.debug('[ThemeDetector] Using computed styles for theme detection:', {
        backgroundColor,
        textColor,
        bgLuminance: bgLuminance.toFixed(4),
        theme,
      });

      return {
        theme,
        confidence,
        backgroundColor,
        textColor,
        contrastRatio,
        luminance: {
          background: bgLuminance,
          foreground: fgLuminance,
        },
        computedStylesUsed: true,
      };
    }

    // Fallback to pixel-based detection (more accurate than color palette extraction)
    // This fixes the E&A Financial bug where dark blue (#0A1628) was incorrectly detected as light/mixed
    const pixelResult = await this.detectThemeFromPixels(screenshot);

    // Determine text color based on pixel luminance
    const textColor = getIdealTextColor(pixelResult.averageLuminance);
    const fgLuminance = this.calculateLuminance(textColor);

    // Get background color from dominant colors if available
    const backgroundColor = pixelResult.dominantColors[0] ?? '#808080';
    const contrastRatio = this.calculateContrastRatio(backgroundColor, textColor);

    logger.debug('[ThemeDetector] Using pixel-based detection (computed styles unavailable):', {
      theme: pixelResult.theme,
      confidence: pixelResult.confidence.toFixed(3),
      averageLuminance: pixelResult.averageLuminance.toFixed(4),
      dominantColors: pixelResult.dominantColors,
      regionAnalysis: pixelResult.analysis,
    });

    return {
      theme: pixelResult.theme,
      confidence: pixelResult.confidence,
      backgroundColor,
      textColor,
      contrastRatio,
      luminance: {
        background: pixelResult.averageLuminance,
        foreground: fgLuminance,
      },
      computedStylesUsed: false,
    };
  }

  /**
   * Extract background color from computed styles
   * Returns valid=true if a non-transparent background color was found
   */
  private extractBackgroundFromComputedStyles(
    computedStyles?: ComputedStyleInfo[]
  ): { valid: boolean; backgroundColor: string; textColor: string } {
    const fallback = { valid: false, backgroundColor: '#808080', textColor: '#FFFFFF' };

    if (!computedStyles || computedStyles.length === 0) {
      return fallback;
    }

    // Find the first section with a non-transparent background
    for (const section of computedStyles) {
      const bgColor = section.styles.backgroundColor;
      const textColor = section.styles.color;

      if (!bgColor || this.isTransparentColor(bgColor)) {
        continue;
      }

      // Parse the color to hex format
      const hexBg = this.parseColorToHex(bgColor);
      const hexText = textColor ? this.parseColorToHex(textColor) : '#FFFFFF';

      if (hexBg) {
        return {
          valid: true,
          backgroundColor: hexBg,
          textColor: hexText || '#FFFFFF',
        };
      }
    }

    return fallback;
  }

  /**
   * Check if a color value represents a transparent color
   */
  private isTransparentColor(color: string): boolean {
    if (!color) return true;

    const normalized = color.toLowerCase().trim();

    // Check for 'transparent' keyword
    if (normalized === 'transparent') return true;

    // Check for rgba with 0 alpha
    const rgbaMatch = normalized.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/);
    if (rgbaMatch) {
      const alpha = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
      return alpha === 0;
    }

    return false;
  }

  /**
   * Parse various color formats (rgb, rgba, hex) to hex format
   */
  private parseColorToHex(color: string): string | null {
    if (!color) return null;

    const normalized = color.trim();

    // Already hex format
    if (normalized.startsWith('#')) {
      // Validate hex format
      if (/^#[0-9A-Fa-f]{6}$/.test(normalized)) {
        return normalized.toUpperCase();
      }
      if (/^#[0-9A-Fa-f]{3}$/.test(normalized)) {
        // Expand 3-digit hex to 6-digit
        const r = normalized[1];
        const g = normalized[2];
        const b = normalized[3];
        return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
      }
      return null;
    }

    // Parse rgb/rgba format
    const rgbMatch = normalized.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\s*\)/);
    if (rgbMatch) {
      const r = parseInt(rgbMatch[1] ?? '0', 10);
      const g = parseInt(rgbMatch[2] ?? '0', 10);
      const b = parseInt(rgbMatch[3] ?? '0', 10);

      // Clamp values to 0-255
      const clampedR = Math.max(0, Math.min(255, r));
      const clampedG = Math.max(0, Math.min(255, g));
      const clampedB = Math.max(0, Math.min(255, b));

      return `#${clampedR.toString(16).padStart(2, '0').toUpperCase()}${clampedG.toString(16).padStart(2, '0').toUpperCase()}${clampedB.toString(16).padStart(2, '0').toUpperCase()}`;
    }

    return null;
  }
}

/**
 * Create a new ThemeDetectorService instance
 * @returns ThemeDetectorService instance
 */
export function createThemeDetectorService(): ThemeDetectorService {
  return new ThemeDetectorServiceImpl();
}

// Re-export pixel theme detection types for external use
export type { PixelThemeDetectionResult };
