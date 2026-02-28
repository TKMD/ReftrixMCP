// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Color Extractor Service
 *
 * Extracts dominant colors, accent colors, and color palettes from images
 * using Sharp for image processing and a custom color quantization algorithm.
 *
 * This implementation uses the Median Cut algorithm for color quantization,
 * which is similar to what ColorThief uses internally.
 *
 * Security features:
 * - Input size validation (5MB max) - SEC H-1
 * - Processing timeout (30s default) - SEC M-1
 *
 * @module services/visual-extractor/color-extractor.service
 */

import { logger } from '../../utils/logger';
import sharp from 'sharp';
import {
  parseAndValidateImageInput,
  withTimeout,
  DEFAULT_PROCESSING_TIMEOUT,
  logSecurityEvent,
  rgbToHex,
  calculateSaturation,
  calculateBrightness,
  wrapSharpError,
  type RGB,
} from './image-utils';

/**
 * Represents a color in the extracted palette with its percentage coverage
 */
export interface ColorPaletteItem {
  /** Color in HEX format (#RRGGBB) */
  color: string;
  /** Percentage of image covered by this color (0-100) */
  percentage: number;
}

/**
 * Result of color extraction from an image
 */
export interface ColorExtractionResult {
  /** Dominant colors in HEX format, maximum 5 colors */
  dominantColors: string[];
  /** Accent colors in HEX format, maximum 3 colors */
  accentColors: string[];
  /** Complete color palette with percentage coverage */
  colorPalette: ColorPaletteItem[];
}

/**
 * Color extractor service interface
 */
export interface ColorExtractorService {
  /**
   * Extract colors from an image
   * @param image - Image as Buffer or Base64 string
   * @returns Promise resolving to color extraction result
   * @throws Error if image is invalid or processing fails
   */
  extractColors(image: Buffer | string): Promise<ColorExtractionResult>;
}

/**
 * Configuration options for the color extractor
 */
interface ColorExtractorConfig {
  /** Maximum number of dominant colors to extract */
  maxDominantColors: number;
  /** Maximum number of accent colors to extract */
  maxAccentColors: number;
  /** Maximum width for image processing (for performance) */
  maxProcessingWidth: number;
  /** Maximum height for image processing (for performance) */
  maxProcessingHeight: number;
  /** Number of color buckets for quantization */
  colorBuckets: number;
}

/** Default configuration */
const DEFAULT_CONFIG: ColorExtractorConfig = {
  maxDominantColors: 5,
  maxAccentColors: 3,
  maxProcessingWidth: 200,
  maxProcessingHeight: 200,
  colorBuckets: 16,
};

/** Color bucket with pixel count */
interface ColorBucket {
  colors: RGB[];
  count: number;
}

/**
 * Calculate the average color of an array of RGB values
 */
function averageColor(colors: RGB[]): RGB {
  if (colors.length === 0) return [0, 0, 0];

  let totalR = 0;
  let totalG = 0;
  let totalB = 0;

  for (const [r, g, b] of colors) {
    totalR += r;
    totalG += g;
    totalB += b;
  }

  return [
    Math.round(totalR / colors.length),
    Math.round(totalG / colors.length),
    Math.round(totalB / colors.length),
  ];
}

/**
 * Find the color channel with the widest range in a set of colors
 */
function findWidestChannel(colors: RGB[]): 0 | 1 | 2 {
  let minR = 255,
    maxR = 0;
  let minG = 255,
    maxG = 0;
  let minB = 255,
    maxB = 0;

  for (const [r, g, b] of colors) {
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
    minG = Math.min(minG, g);
    maxG = Math.max(maxG, g);
    minB = Math.min(minB, b);
    maxB = Math.max(maxB, b);
  }

  const rangeR = maxR - minR;
  const rangeG = maxG - minG;
  const rangeB = maxB - minB;

  if (rangeR >= rangeG && rangeR >= rangeB) return 0;
  if (rangeG >= rangeR && rangeG >= rangeB) return 1;
  return 2;
}

/**
 * Result of finding the largest bucket
 */
interface LargestBucketResult {
  index: number;
  size: number;
}

/**
 * Find the bucket with the most colors
 */
function findLargestBucket(buckets: ColorBucket[]): LargestBucketResult {
  let maxBucketIndex = 0;
  let maxBucketSize = 0;
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    if (bucket && bucket.colors.length > maxBucketSize) {
      maxBucketSize = bucket.colors.length;
      maxBucketIndex = i;
    }
  }
  return { index: maxBucketIndex, size: maxBucketSize };
}

/**
 * Split a bucket at the median of its widest color channel
 */
function splitBucketAtMedian(bucket: ColorBucket): [ColorBucket, ColorBucket] {
  const channel = findWidestChannel(bucket.colors);

  // Sort by the widest channel
  bucket.colors.sort((a, b) => a[channel] - b[channel]);

  // Split at the median
  const midpoint = Math.floor(bucket.colors.length / 2);
  const lowerHalf = bucket.colors.slice(0, midpoint);
  const upperHalf = bucket.colors.slice(midpoint);

  return [
    { colors: lowerHalf, count: lowerHalf.length },
    { colors: upperHalf, count: upperHalf.length },
  ];
}

/**
 * Convert colors array to a deduplicated map when colors are few
 */
function colorsToCountedMap(colors: RGB[]): Array<{ color: RGB; count: number }> {
  const colorMap = new Map<string, { color: RGB; count: number }>();
  for (const color of colors) {
    const key = color.join(',');
    const existing = colorMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      colorMap.set(key, { color, count: 1 });
    }
  }
  return Array.from(colorMap.values()).sort((a, b) => b.count - a.count);
}

/**
 * Median Cut color quantization algorithm
 * Returns an array of quantized colors sorted by pixel count
 */
function medianCut(colors: RGB[], numColors: number): Array<{ color: RGB; count: number }> {
  if (colors.length === 0) {
    return [{ color: [128, 128, 128] as RGB, count: 1 }];
  }

  if (colors.length <= numColors) {
    return colorsToCountedMap(colors);
  }

  // Start with all colors in one bucket
  const buckets: ColorBucket[] = [{ colors, count: colors.length }];

  // Split buckets until we have enough
  while (buckets.length < numColors) {
    const { index, size } = findLargestBucket(buckets);

    // If the largest bucket has only 1 color, we can't split more
    if (size <= 1) break;

    const bucketToSplit = buckets[index];
    if (!bucketToSplit) break;

    // Split the bucket and replace it with two new buckets
    const [lowerBucket, upperBucket] = splitBucketAtMedian(bucketToSplit);
    buckets.splice(index, 1, lowerBucket, upperBucket);
  }

  // Calculate average color for each bucket and sort by count
  return buckets
    .map((bucket) => ({
      color: averageColor(bucket.colors),
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Determine if a color is an accent color based on saturation and distinctiveness
 */
function isAccentColor(color: RGB, dominantColors: RGB[]): boolean {
  const [r, g, b] = color;
  const saturation = calculateSaturation(r, g, b);
  const brightness = calculateBrightness(r, g, b);

  // Accent colors typically have higher saturation and are not too dark or light
  if (saturation < 0.3) return false;
  if (brightness < 0.1 || brightness > 0.9) return false;

  // Check if it's distinct from dominant colors
  for (const dominant of dominantColors) {
    const distance = Math.sqrt(
      Math.pow(color[0] - dominant[0], 2) + Math.pow(color[1] - dominant[1], 2) + Math.pow(color[2] - dominant[2], 2)
    );
    // If too similar to a dominant color, it's not an accent
    if (distance < 50) return false;
  }

  return true;
}

// parseImageInput has been moved to image-utils.ts as parseAndValidateImageInput
// with additional security controls (size validation)

/**
 * Internal implementation of ColorExtractorService
 */
class ColorExtractorServiceImpl implements ColorExtractorService {
  private config: ColorExtractorConfig;

  constructor(config: Partial<ColorExtractorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async extractColors(image: Buffer | string): Promise<ColorExtractionResult> {
    // Parse and validate input with size check (5MB max) - SEC H-1
    const imageBuffer = parseAndValidateImageInput(image);

    logSecurityEvent('ColorExtractor', 'Processing image', {
      size: imageBuffer.length,
      sizeKB: Math.round(imageBuffer.length / 1024),
    });

    // Wrap processing with timeout (30s default) - SEC M-1
    return withTimeout(this.extractColorsInternal(imageBuffer), DEFAULT_PROCESSING_TIMEOUT);
  }

  private async extractColorsInternal(imageBuffer: Buffer): Promise<ColorExtractionResult> {
    try {
      // Use sharp to resize and get raw pixel data
      const processedImage = sharp(imageBuffer);
      const metadata = await processedImage.metadata();

      if (!metadata.width || !metadata.height) {
        throw new Error('Invalid image: unable to read dimensions');
      }

      // Resize for performance while maintaining aspect ratio
      const resizeOptions: sharp.ResizeOptions = {
        width: Math.min(metadata.width, this.config.maxProcessingWidth),
        height: Math.min(metadata.height, this.config.maxProcessingHeight),
        fit: 'inside',
        withoutEnlargement: true,
      };

      // Get raw RGB pixel data (flatten handles transparency)
      const { data, info } = await processedImage
        .resize(resizeOptions)
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Extract pixel colors
      const pixels: RGB[] = [];
      const channels = info.channels;

      for (let i = 0; i < data.length; i += channels) {
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        pixels.push([r, g, b]);
      }

      // Quantize colors using median cut
      const numBuckets = Math.max(this.config.maxDominantColors + this.config.maxAccentColors + 3, this.config.colorBuckets);
      const quantizedColors = medianCut(pixels, numBuckets);

      // Extract dominant colors (first N colors by count)
      const dominantColors = quantizedColors.slice(0, this.config.maxDominantColors).map((c) => rgbToHex(c.color[0], c.color[1], c.color[2]));

      // Extract accent colors (colors with high saturation that are distinct from dominants)
      const dominantRgb = quantizedColors.slice(0, this.config.maxDominantColors).map((c) => c.color);
      const accentCandidates = quantizedColors.slice(this.config.maxDominantColors);
      const accentColors = accentCandidates
        .filter((c) => isAccentColor(c.color, dominantRgb))
        .slice(0, this.config.maxAccentColors)
        .map((c) => rgbToHex(c.color[0], c.color[1], c.color[2]));

      // Build color palette with percentages
      const totalPixels = pixels.length;
      const colorPalette: ColorPaletteItem[] = quantizedColors.map((c) => ({
        color: rgbToHex(c.color[0], c.color[1], c.color[2]),
        percentage: Math.round((c.count / totalPixels) * 100 * 10) / 10,
      }));

      logger.debug('[ColorExtractor] Extracted colors:', {
        dominantColors: dominantColors.length,
        accentColors: accentColors.length,
        paletteColors: colorPalette.length,
        totalPixels,
      });

      return {
        dominantColors,
        accentColors,
        colorPalette,
      };
    } catch (error) {
      throw wrapSharpError(error);
    }
  }
}

/**
 * Create a new ColorExtractorService instance
 * @param config - Optional configuration options
 * @returns ColorExtractorService instance
 */
export function createColorExtractorService(config?: Partial<ColorExtractorConfig>): ColorExtractorService {
  return new ColorExtractorServiceImpl(config);
}
