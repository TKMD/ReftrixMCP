// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pixel Theme Detector Service
 *
 * Detects light/dark/mixed themes from screenshot images using
 * WCAG-compliant relative luminance calculation on actual pixel data.
 *
 * This service provides more accurate theme detection than class-name based
 * inference by directly analyzing the rendered pixel values.
 *
 * Key Features:
 * - WCAG 2.1 compliant relative luminance calculation
 * - Region-based analysis (top/middle/bottom)
 * - Gamma-corrected sRGB processing
 * - Dominant color extraction
 *
 * Thresholds:
 * - Dark: luminance < 0.3
 * - Light: luminance > 0.7
 * - Mixed: 0.3 <= luminance <= 0.7
 *
 * Security features:
 * - Input size validation (5MB max)
 * - Processing timeout (30s default)
 * - Image downscaling for performance
 *
 * @module services/visual-extractor/pixel-theme-detector.service
 */

import { logger } from '../../utils/logger';
import sharp from 'sharp';
import {
  parseAndValidateImageInput,
  withTimeout,
  DEFAULT_PROCESSING_TIMEOUT,
  logSecurityEvent,
  rgbToHex,
  wrapSharpError,
} from './image-utils';

// ============================================================================
// Constants
// ============================================================================

/**
 * Luminance threshold for dark theme classification
 * Below this value, the image is considered dark
 */
export const DARK_THRESHOLD = 0.3;

/**
 * Luminance threshold for light theme classification
 * Above this value, the image is considered light
 */
export const LIGHT_THRESHOLD = 0.7;

/**
 * Maximum dimension for processing
 * Images larger than this will be downscaled
 */
const MAX_PROCESSING_DIMENSION = 400;

/**
 * Number of top colors to extract
 */
const MAX_DOMINANT_COLORS = 5;

// ============================================================================
// Types
// ============================================================================

/**
 * Region theme classification
 */
type RegionTheme = 'light' | 'dark';

/**
 * Overall theme classification
 */
type ThemeType = 'light' | 'dark' | 'mixed';

/**
 * Result of pixel-based theme detection
 */
export interface PixelThemeDetectionResult {
  /** Detected theme: light, dark, or mixed */
  theme: ThemeType;
  /** Confidence score (0-1) */
  confidence: number;
  /** Average luminance of the entire image (0-1) */
  averageLuminance: number;
  /** Dominant colors in HEX format */
  dominantColors: string[];
  /** Region-based theme analysis */
  analysis: {
    /** Theme of the top third of the image */
    topRegionTheme: RegionTheme;
    /** Theme of the middle third of the image */
    middleRegionTheme: RegionTheme;
    /** Theme of the bottom third of the image */
    bottomRegionTheme: RegionTheme;
  };
}

/**
 * Pixel theme detector service interface
 */
export interface PixelThemeDetectorService {
  /**
   * Detect theme from an image using pixel analysis
   * @param image - Image as Buffer or Base64 string
   * @returns Promise resolving to pixel theme detection result
   */
  detectTheme(image: Buffer | string): Promise<PixelThemeDetectionResult>;
}

// ============================================================================
// WCAG Luminance Calculation
// ============================================================================

/**
 * Convert sRGB color component to linear RGB (gamma correction)
 * WCAG 2.1 specification
 *
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
 * Calculate WCAG 2.1 relative luminance for RGB values
 * L = 0.2126 * R + 0.7152 * G + 0.0722 * B
 *
 * @param r - Red component (0-255)
 * @param g - Green component (0-255)
 * @param b - Blue component (0-255)
 * @returns Relative luminance (0-1)
 */
function calculateRelativeLuminance(r: number, g: number, b: number): number {
  const rLinear = sRGBToLinear(r);
  const gLinear = sRGBToLinear(g);
  const bLinear = sRGBToLinear(b);

  return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear;
}

/**
 * Classify a luminance value as light or dark
 *
 * @param luminance - Relative luminance (0-1)
 * @returns 'light' if above 0.5, 'dark' otherwise
 */
function classifyRegionTheme(luminance: number): RegionTheme {
  // Use 0.5 as the boundary for region classification
  // This is different from the overall thresholds to detect
  // clearly light/dark regions within mixed images
  return luminance > 0.5 ? 'light' : 'dark';
}

/**
 * Classify overall theme based on average luminance
 *
 * @param luminance - Average luminance (0-1)
 * @returns Theme classification
 */
function classifyOverallTheme(luminance: number): ThemeType {
  if (luminance < DARK_THRESHOLD) {
    return 'dark';
  } else if (luminance > LIGHT_THRESHOLD) {
    return 'light';
  } else {
    return 'mixed';
  }
}

/**
 * Calculate confidence score based on luminance and region agreement
 *
 * @param luminance - Average luminance
 * @param theme - Detected theme
 * @param regionAgreement - Number of regions that agree (0-3)
 * @returns Confidence score (0-1)
 */
function calculateConfidence(
  luminance: number,
  theme: ThemeType,
  regionAgreement: number
): number {
  let baseConfidence: number;

  if (theme === 'dark') {
    // Confidence increases as luminance decreases from threshold
    baseConfidence = Math.min(1, (DARK_THRESHOLD - luminance) / DARK_THRESHOLD + 0.5);
  } else if (theme === 'light') {
    // Confidence increases as luminance increases from threshold
    baseConfidence = Math.min(1, (luminance - LIGHT_THRESHOLD) / (1 - LIGHT_THRESHOLD) + 0.5);
  } else {
    // Mixed theme - confidence based on distance from both thresholds
    const midpoint = (DARK_THRESHOLD + LIGHT_THRESHOLD) / 2;
    const distanceFromMid = Math.abs(luminance - midpoint);
    const maxDistance = (LIGHT_THRESHOLD - DARK_THRESHOLD) / 2;
    baseConfidence = 0.5 + (1 - distanceFromMid / maxDistance) * 0.3;
  }

  // Adjust based on region agreement
  const regionBonus = regionAgreement === 3 ? 0.1 : regionAgreement === 2 ? 0.05 : -0.1;

  return Math.min(1, Math.max(0, baseConfidence + regionBonus));
}

// ============================================================================
// Color Extraction
// ============================================================================

/**
 * Simple color bucket for quantization
 */
interface ColorBucket {
  r: number;
  g: number;
  b: number;
  count: number;
}

/**
 * Extract dominant colors from pixel data using simple quantization
 *
 * @param data - Raw RGB pixel data
 * @param width - Image width
 * @param height - Image height
 * @returns Array of dominant colors in HEX format
 */
function extractDominantColors(
  data: Buffer,
  width: number,
  height: number
): string[] {
  // Use a simple bucketing approach for fast color extraction
  const bucketSize = 32; // Reduce color space to 8 values per channel
  const buckets = new Map<string, ColorBucket>();

  const channels = 3;
  const totalPixels = width * height;
  const sampleStep = Math.max(1, Math.floor(totalPixels / 10000)); // Sample up to 10000 pixels

  for (let i = 0; i < data.length; i += channels * sampleStep) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;

    // Quantize to buckets
    const qr = Math.floor(r / bucketSize) * bucketSize + Math.floor(bucketSize / 2);
    const qg = Math.floor(g / bucketSize) * bucketSize + Math.floor(bucketSize / 2);
    const qb = Math.floor(b / bucketSize) * bucketSize + Math.floor(bucketSize / 2);

    const key = `${qr},${qg},${qb}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count++;
    } else {
      buckets.set(key, { r: qr, g: qg, b: qb, count: 1 });
    }
  }

  // Sort by count and return top colors
  const sortedBuckets = Array.from(buckets.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_DOMINANT_COLORS);

  return sortedBuckets.map((bucket) => rgbToHex(bucket.r, bucket.g, bucket.b));
}

// ============================================================================
// Region Analysis
// ============================================================================

/**
 * Calculate average luminance for a region of the image
 *
 * @param data - Raw RGB pixel data
 * @param width - Image width
 * @param startY - Start row (inclusive)
 * @param endY - End row (exclusive)
 * @returns Average luminance for the region
 */
function calculateRegionLuminance(
  data: Buffer,
  width: number,
  startY: number,
  endY: number
): number {
  const channels = 3;
  let totalLuminance = 0;
  let pixelCount = 0;

  for (let y = startY; y < endY; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * channels;
      const r = data[pixelIndex] ?? 0;
      const g = data[pixelIndex + 1] ?? 0;
      const b = data[pixelIndex + 2] ?? 0;

      totalLuminance += calculateRelativeLuminance(r, g, b);
      pixelCount++;
    }
  }

  return pixelCount > 0 ? totalLuminance / pixelCount : 0;
}

/**
 * Analyze three regions of the image (top/middle/bottom)
 *
 * @param data - Raw RGB pixel data
 * @param width - Image width
 * @param height - Image height
 * @returns Region themes and luminances
 */
function analyzeRegions(
  data: Buffer,
  width: number,
  height: number
): {
  topLuminance: number;
  middleLuminance: number;
  bottomLuminance: number;
  topTheme: RegionTheme;
  middleTheme: RegionTheme;
  bottomTheme: RegionTheme;
} {
  const regionHeight = Math.floor(height / 3);
  const topEnd = regionHeight;
  const middleEnd = regionHeight * 2;

  const topLuminance = calculateRegionLuminance(data, width, 0, topEnd);
  const middleLuminance = calculateRegionLuminance(data, width, topEnd, middleEnd);
  const bottomLuminance = calculateRegionLuminance(data, width, middleEnd, height);

  return {
    topLuminance,
    middleLuminance,
    bottomLuminance,
    topTheme: classifyRegionTheme(topLuminance),
    middleTheme: classifyRegionTheme(middleLuminance),
    bottomTheme: classifyRegionTheme(bottomLuminance),
  };
}

// ============================================================================
// Service Implementation
// ============================================================================

/**
 * Internal implementation of PixelThemeDetectorService
 */
class PixelThemeDetectorServiceImpl implements PixelThemeDetectorService {
  async detectTheme(image: Buffer | string): Promise<PixelThemeDetectionResult> {
    // Parse and validate input with size check (5MB max)
    const imageBuffer = parseAndValidateImageInput(image);

    logSecurityEvent('PixelThemeDetector', 'Processing image', {
      size: imageBuffer.length,
      sizeKB: Math.round(imageBuffer.length / 1024),
    });

    // Wrap processing with timeout (30s default)
    return withTimeout(this.detectThemeInternal(imageBuffer), DEFAULT_PROCESSING_TIMEOUT);
  }

  private async detectThemeInternal(imageBuffer: Buffer): Promise<PixelThemeDetectionResult> {
    try {
      // Load and process image with Sharp
      const processedImage = sharp(imageBuffer);
      const metadata = await processedImage.metadata();

      if (!metadata.width || !metadata.height) {
        throw new Error('Invalid image: unable to read dimensions');
      }

      // Calculate resize dimensions (preserve aspect ratio)
      const scale = Math.min(
        1,
        MAX_PROCESSING_DIMENSION / Math.max(metadata.width, metadata.height)
      );
      const targetWidth = Math.round(metadata.width * scale);
      const targetHeight = Math.round(metadata.height * scale);

      // Resize and get raw RGB data
      const { data, info } = await processedImage
        .resize(targetWidth, targetHeight, { fit: 'inside' })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const width = info.width;
      const height = info.height;

      // Calculate average luminance for entire image
      const averageLuminance = this.calculateAverageLuminance(data, width, height);

      // Analyze regions
      const regionAnalysis = analyzeRegions(data, width, height);

      // Extract dominant colors
      const dominantColors = extractDominantColors(data, width, height);

      // Classify theme
      const theme = classifyOverallTheme(averageLuminance);

      // Calculate region agreement
      const expectedTheme = theme === 'mixed' ? 'dark' : theme; // For mixed, check against dark
      let regionAgreement = 0;
      if (regionAnalysis.topTheme === expectedTheme) regionAgreement++;
      if (regionAnalysis.middleTheme === expectedTheme) regionAgreement++;
      if (regionAnalysis.bottomTheme === expectedTheme) regionAgreement++;

      // Calculate confidence
      const confidence = calculateConfidence(averageLuminance, theme, regionAgreement);

      const result: PixelThemeDetectionResult = {
        theme,
        confidence,
        averageLuminance,
        dominantColors,
        analysis: {
          topRegionTheme: regionAnalysis.topTheme,
          middleRegionTheme: regionAnalysis.middleTheme,
          bottomRegionTheme: regionAnalysis.bottomTheme,
        },
      };

      logger.debug('[PixelThemeDetector] Theme detection result:', {
        theme: result.theme,
        confidence: result.confidence.toFixed(3),
        averageLuminance: result.averageLuminance.toFixed(4),
        regions: {
          top: `${regionAnalysis.topTheme} (${regionAnalysis.topLuminance.toFixed(4)})`,
          middle: `${regionAnalysis.middleTheme} (${regionAnalysis.middleLuminance.toFixed(4)})`,
          bottom: `${regionAnalysis.bottomTheme} (${regionAnalysis.bottomLuminance.toFixed(4)})`,
        },
        dominantColors: result.dominantColors,
      });

      return result;
    } catch (error) {
      throw wrapSharpError(error);
    }
  }

  /**
   * Calculate average luminance for the entire image
   */
  private calculateAverageLuminance(data: Buffer, width: number, height: number): number {
    const channels = 3;
    let totalLuminance = 0;
    let pixelCount = 0;

    // Sample pixels for performance (every nth pixel for large images)
    const totalPixels = width * height;
    const sampleStep = Math.max(1, Math.floor(totalPixels / 50000)); // Max 50000 samples

    for (let i = 0; i < data.length; i += channels * sampleStep) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;

      totalLuminance += calculateRelativeLuminance(r, g, b);
      pixelCount++;
    }

    return pixelCount > 0 ? totalLuminance / pixelCount : 0;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new PixelThemeDetectorService instance
 * @returns PixelThemeDetectorService instance
 */
export function createPixelThemeDetectorService(): PixelThemeDetectorService {
  return new PixelThemeDetectorServiceImpl();
}
