// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Density Calculator Service
 *
 * Calculates content density, whitespace ratio, and visual balance
 * from web page screenshots using Sharp for image processing.
 *
 * Key calculations:
 * - Whitespace detection: Background-color-similar pixels ratio
 * - Content density: Edge detection (Sobel filter approximation)
 * - Visual balance: Grid-based density variance analysis
 *
 * Security features:
 * - Input size validation (5MB max) - SEC H-1
 * - Processing timeout (30s default) - SEC M-1
 *
 * @module services/visual-extractor/density-calculator.service
 */

import { logger } from '../../utils/logger';
import sharp from 'sharp';
import {
  parseAndValidateImageInput,
  withTimeout,
  DEFAULT_PROCESSING_TIMEOUT,
  logSecurityEvent,
  wrapSharpError,
} from './image-utils';

/**
 * Region analysis result with density and dominant color
 */
export interface RegionAnalysis {
  /** Row index in grid (0-based) */
  row: number;
  /** Column index in grid (0-based) */
  col: number;
  /** Content density in this region (0-1) */
  density: number;
  /** Dominant color in HEX format (#RRGGBB) */
  dominantColor: string;
}

/**
 * Detailed metrics from density analysis
 */
export interface DensityMetrics {
  /** Edge density from edge detection (0-1) */
  edgeDensity: number;
  /** Color variance across the image */
  colorVariance: number;
  /** Symmetry score (0-1, 1 = perfectly symmetric) */
  symmetryScore: number;
}

/**
 * Complete result of density calculation
 */
export interface DensityCalculationResult {
  /** Overall content density (0-1, 1 = most dense) */
  contentDensity: number;
  /** Whitespace ratio (0-1, 1 = all whitespace) */
  whitespaceRatio: number;
  /** Visual balance score (0-100) */
  visualBalance: number;
  /** Per-region density analysis */
  regions: RegionAnalysis[];
  /** Additional metrics */
  metrics: DensityMetrics;
}

/**
 * Density calculator service interface
 */
export interface DensityCalculatorService {
  /**
   * Calculate comprehensive density metrics from an image
   * @param image - Image as Buffer or Base64 string
   * @returns Promise resolving to density calculation result
   */
  calculateDensity(image: Buffer | string): Promise<DensityCalculationResult>;

  /**
   * Calculate whitespace ratio only
   * @param image - Image as Buffer or Base64 string
   * @param backgroundColor - Optional background color in HEX format (default: #FFFFFF)
   * @returns Promise resolving to whitespace ratio (0-1)
   */
  calculateWhitespace(image: Buffer | string, backgroundColor?: string): Promise<number>;

  /**
   * Analyze regions with custom grid size
   * @param image - Image as Buffer or Base64 string
   * @param gridSize - Grid size (default: 3 for 3x3 grid)
   * @returns Promise resolving to array of region analyses
   */
  analyzeRegions(image: Buffer | string, gridSize?: number): Promise<RegionAnalysis[]>;
}

/**
 * Configuration options for the density calculator
 */
interface DensityCalculatorConfig {
  /** Default grid size for region analysis */
  defaultGridSize: number;
  /** Maximum width for image processing (for performance) */
  maxProcessingWidth: number;
  /** Maximum height for image processing (for performance) */
  maxProcessingHeight: number;
  /** Color distance threshold for whitespace detection */
  colorDistanceThreshold: number;
}

/** Default configuration */
const DEFAULT_CONFIG: DensityCalculatorConfig = {
  defaultGridSize: 3,
  maxProcessingWidth: 400,
  maxProcessingHeight: 400,
  colorDistanceThreshold: 30,
};

// Common types and utility functions imported from image-utils.ts
import type { RGB } from './image-utils';
import { hexToRgb, rgbToHex, colorDistance, calculateBrightness } from './image-utils';

// parseImageInput has been moved to image-utils.ts as parseAndValidateImageInput
// with additional security controls (size validation)

/**
 * Extract raw pixel data from image buffer
 */
async function getPixelData(
  imageBuffer: Buffer,
  maxWidth: number,
  maxHeight: number
): Promise<{ data: Buffer; width: number; height: number }> {
  const processedImage = sharp(imageBuffer);
  const metadata = await processedImage.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('Invalid image: unable to read dimensions');
  }

  // Resize for performance while maintaining aspect ratio
  const resizeOptions: sharp.ResizeOptions = {
    width: Math.min(metadata.width, maxWidth),
    height: Math.min(metadata.height, maxHeight),
    fit: 'inside',
    withoutEnlargement: true,
  };

  // Get raw RGB pixel data (flatten handles transparency)
  const { data, info } = await processedImage
    .resize(resizeOptions)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height };
}

// =============================================================================
// Helper Types and Functions for Edge Detection
// =============================================================================

/**
 * Sobel kernels for edge detection
 */
const SOBEL_KERNEL_X = [
  [-1, 0, 1],
  [-2, 0, 2],
  [-1, 0, 1],
];

const SOBEL_KERNEL_Y = [
  [-1, -2, -1],
  [0, 0, 0],
  [1, 2, 1],
];

/** Number of color channels (RGB) */
const RGB_CHANNELS = 3;

/**
 * Convert image data to grayscale values
 */
function convertToGrayscale(data: Buffer): number[] {
  const grayscale: number[] = [];
  for (let i = 0; i < data.length; i += RGB_CHANNELS) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    grayscale.push(calculateBrightness(r, g, b));
  }
  return grayscale;
}

/**
 * Apply Sobel convolution at a single pixel position
 */
function applySobelAtPixel(
  grayscale: number[],
  x: number,
  y: number,
  width: number
): number {
  let gx = 0;
  let gy = 0;

  for (let ky = -1; ky <= 1; ky++) {
    for (let kx = -1; kx <= 1; kx++) {
      const pixelIndex = (y + ky) * width + (x + kx);
      const pixel = grayscale[pixelIndex] ?? 0;
      gx += pixel * (SOBEL_KERNEL_X[ky + 1]?.[kx + 1] ?? 0);
      gy += pixel * (SOBEL_KERNEL_Y[ky + 1]?.[kx + 1] ?? 0);
    }
  }

  return Math.sqrt(gx * gx + gy * gy);
}

/**
 * Apply Sobel edge detection approximation
 * Returns edge strength for each pixel
 */
function detectEdges(
  data: Buffer,
  width: number,
  height: number
): number[] {
  const grayscale = convertToGrayscale(data);
  const edges: number[] = [];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const magnitude = applySobelAtPixel(grayscale, x, y, width);
      edges.push(magnitude);
    }
  }

  return edges;
}

/**
 * Calculate dominant color in a region
 */
function calculateDominantColor(
  data: Buffer,
  width: number,
  height: number,
  startX: number,
  startY: number,
  regionWidth: number,
  regionHeight: number
): RGB {
  const channels = 3;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let count = 0;

  for (let y = startY; y < Math.min(startY + regionHeight, height); y++) {
    for (let x = startX; x < Math.min(startX + regionWidth, width); x++) {
      const pixelIndex = (y * width + x) * channels;
      totalR += data[pixelIndex] ?? 0;
      totalG += data[pixelIndex + 1] ?? 0;
      totalB += data[pixelIndex + 2] ?? 0;
      count++;
    }
  }

  if (count === 0) {
    return [128, 128, 128];
  }

  return [
    Math.round(totalR / count),
    Math.round(totalG / count),
    Math.round(totalB / count),
  ];
}

/**
 * Calculate region density based on color variance from average
 */
function calculateRegionDensity(
  data: Buffer,
  width: number,
  height: number,
  startX: number,
  startY: number,
  regionWidth: number,
  regionHeight: number,
  backgroundColor: RGB
): number {
  const channels = 3;
  let nonWhitespaceCount = 0;
  let totalCount = 0;
  const threshold = 30; // Color distance threshold

  for (let y = startY; y < Math.min(startY + regionHeight, height); y++) {
    for (let x = startX; x < Math.min(startX + regionWidth, width); x++) {
      const pixelIndex = (y * width + x) * channels;
      const r = data[pixelIndex] ?? 0;
      const g = data[pixelIndex + 1] ?? 0;
      const b = data[pixelIndex + 2] ?? 0;

      const distance = colorDistance([r, g, b], backgroundColor);
      if (distance > threshold) {
        nonWhitespaceCount++;
      }
      totalCount++;
    }
  }

  return totalCount > 0 ? nonWhitespaceCount / totalCount : 0;
}

/**
 * Calculate variance of an array of numbers
 */
function calculateVariance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
  const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
  return squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length;
}

/**
 * Calculate symmetry score by comparing left/right halves
 */
function calculateSymmetry(
  data: Buffer,
  width: number,
  height: number
): number {
  const channels = 3;
  let totalDiff = 0;
  let maxDiff = 0;
  const halfWidth = Math.floor(width / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < halfWidth; x++) {
      const leftIndex = (y * width + x) * channels;
      const rightX = width - 1 - x;
      const rightIndex = (y * width + rightX) * channels;

      const leftR = data[leftIndex] ?? 0;
      const leftG = data[leftIndex + 1] ?? 0;
      const leftB = data[leftIndex + 2] ?? 0;

      const rightR = data[rightIndex] ?? 0;
      const rightG = data[rightIndex + 1] ?? 0;
      const rightB = data[rightIndex + 2] ?? 0;

      const diff = colorDistance([leftR, leftG, leftB], [rightR, rightG, rightB]);
      totalDiff += diff;
      maxDiff += 441.67; // Max distance: sqrt(255^2 * 3)
    }
  }

  return maxDiff > 0 ? 1 - (totalDiff / maxDiff) : 1;
}

/**
 * Internal implementation of DensityCalculatorService
 */
class DensityCalculatorServiceImpl implements DensityCalculatorService {
  private config: DensityCalculatorConfig;

  constructor(config: Partial<DensityCalculatorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async calculateDensity(image: Buffer | string): Promise<DensityCalculationResult> {
    // Parse and validate input with size check (5MB max) - SEC H-1
    const imageBuffer = parseAndValidateImageInput(image);

    logSecurityEvent('DensityCalculator', 'Processing image', {
      size: imageBuffer.length,
      sizeKB: Math.round(imageBuffer.length / 1024),
    });

    // Wrap processing with timeout (30s default) - SEC M-1
    return withTimeout(this.calculateDensityInternal(imageBuffer), DEFAULT_PROCESSING_TIMEOUT);
  }

  private async calculateDensityInternal(imageBuffer: Buffer): Promise<DensityCalculationResult> {
    try {
      const { data, width, height } = await getPixelData(
        imageBuffer,
        this.config.maxProcessingWidth,
        this.config.maxProcessingHeight
      );

      // Default background color (white)
      const backgroundColor: RGB = [255, 255, 255];

      // Calculate whitespace ratio
      const whitespaceRatio = this.calculateWhitespaceFromData(
        data,
        width,
        height,
        backgroundColor
      );

      // Calculate edge density
      const edges = detectEdges(data, width, height);
      const maxEdge = 1442; // Approximate max Sobel magnitude
      const normalizedEdges = edges.map(e => Math.min(e / maxEdge, 1));
      const edgeDensity = normalizedEdges.reduce((sum, e) => sum + e, 0) / normalizedEdges.length;

      // Calculate content density (inverse of whitespace, adjusted by edge density)
      const contentDensity = Math.min(1, (1 - whitespaceRatio) * 0.7 + edgeDensity * 0.3);

      // Analyze regions
      const regions = this.analyzeRegionsFromData(
        data,
        width,
        height,
        this.config.defaultGridSize,
        backgroundColor
      );

      // Calculate visual balance from region density variance
      const regionDensities = regions.map(r => r.density);
      const densityVariance = calculateVariance(regionDensities);
      const visualBalance = Math.max(0, Math.min(100, 100 - (densityVariance * 400)));

      // Calculate color variance
      const colorVariance = this.calculateColorVariance(data, width, height);

      // Calculate symmetry score
      const symmetryScore = calculateSymmetry(data, width, height);

      logger.debug('[DensityCalculator] Analysis complete:', {
        contentDensity: contentDensity.toFixed(3),
        whitespaceRatio: whitespaceRatio.toFixed(3),
        visualBalance: visualBalance.toFixed(1),
        edgeDensity: edgeDensity.toFixed(3),
      });

      return {
        contentDensity,
        whitespaceRatio,
        visualBalance,
        regions,
        metrics: {
          edgeDensity,
          colorVariance,
          symmetryScore,
        },
      };
    } catch (error) {
      throw wrapSharpError(error);
    }
  }

  async calculateWhitespace(
    image: Buffer | string,
    backgroundColor?: string
  ): Promise<number> {
    // Parse and validate input with size check (5MB max) - SEC H-1
    const imageBuffer = parseAndValidateImageInput(image);

    logSecurityEvent('DensityCalculator', 'Calculating whitespace', {
      size: imageBuffer.length,
      sizeKB: Math.round(imageBuffer.length / 1024),
    });

    // Wrap processing with timeout (30s default) - SEC M-1
    return withTimeout(
      this.calculateWhitespaceInternal(imageBuffer, backgroundColor),
      DEFAULT_PROCESSING_TIMEOUT
    );
  }

  private async calculateWhitespaceInternal(
    imageBuffer: Buffer,
    backgroundColor?: string
  ): Promise<number> {
    const { data, width, height } = await getPixelData(
      imageBuffer,
      this.config.maxProcessingWidth,
      this.config.maxProcessingHeight
    );

    const bgColor: RGB = backgroundColor
      ? hexToRgb(backgroundColor)
      : [255, 255, 255];

    return this.calculateWhitespaceFromData(data, width, height, bgColor);
  }

  async analyzeRegions(
    image: Buffer | string,
    gridSize?: number
  ): Promise<RegionAnalysis[]> {
    // Parse and validate input with size check (5MB max) - SEC H-1
    const imageBuffer = parseAndValidateImageInput(image);

    logSecurityEvent('DensityCalculator', 'Analyzing regions', {
      size: imageBuffer.length,
      sizeKB: Math.round(imageBuffer.length / 1024),
      gridSize: gridSize ?? this.config.defaultGridSize,
    });

    // Wrap processing with timeout (30s default) - SEC M-1
    return withTimeout(
      this.analyzeRegionsInternal(imageBuffer, gridSize),
      DEFAULT_PROCESSING_TIMEOUT
    );
  }

  private async analyzeRegionsInternal(
    imageBuffer: Buffer,
    gridSize?: number
  ): Promise<RegionAnalysis[]> {
    const { data, width, height } = await getPixelData(
      imageBuffer,
      this.config.maxProcessingWidth,
      this.config.maxProcessingHeight
    );

    const backgroundColor: RGB = [255, 255, 255];
    const size = gridSize ?? this.config.defaultGridSize;

    return this.analyzeRegionsFromData(data, width, height, size, backgroundColor);
  }

  /**
   * Calculate whitespace ratio from raw pixel data
   */
  private calculateWhitespaceFromData(
    data: Buffer,
    _width: number,
    _height: number,
    backgroundColor: RGB
  ): number {
    const channels = 3;
    let whitespaceCount = 0;
    let totalCount = 0;
    const threshold = this.config.colorDistanceThreshold;

    for (let i = 0; i < data.length; i += channels) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;

      const distance = colorDistance([r, g, b], backgroundColor);
      if (distance <= threshold) {
        whitespaceCount++;
      }
      totalCount++;
    }

    return totalCount > 0 ? whitespaceCount / totalCount : 0;
  }

  /**
   * Analyze regions from raw pixel data
   */
  private analyzeRegionsFromData(
    data: Buffer,
    width: number,
    height: number,
    gridSize: number,
    backgroundColor: RGB
  ): RegionAnalysis[] {
    const regions: RegionAnalysis[] = [];
    const regionWidth = Math.ceil(width / gridSize);
    const regionHeight = Math.ceil(height / gridSize);

    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const startX = col * regionWidth;
        const startY = row * regionHeight;

        const density = calculateRegionDensity(
          data,
          width,
          height,
          startX,
          startY,
          regionWidth,
          regionHeight,
          backgroundColor
        );

        const dominantColorRgb = calculateDominantColor(
          data,
          width,
          height,
          startX,
          startY,
          regionWidth,
          regionHeight
        );

        regions.push({
          row,
          col,
          density,
          dominantColor: rgbToHex(
            dominantColorRgb[0],
            dominantColorRgb[1],
            dominantColorRgb[2]
          ),
        });
      }
    }

    return regions;
  }

  /**
   * Calculate color variance across the image
   */
  private calculateColorVariance(
    data: Buffer,
    _width: number,
    _height: number
  ): number {
    const channels = 3;
    const brightnesses: number[] = [];

    for (let i = 0; i < data.length; i += channels) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      brightnesses.push(calculateBrightness(r, g, b));
    }

    return calculateVariance(brightnesses) / (255 * 255); // Normalize to 0-1 range
  }
}

/**
 * Create a new DensityCalculatorService instance
 * @param config - Optional configuration options
 * @returns DensityCalculatorService instance
 */
export function createDensityCalculatorService(
  config?: Partial<DensityCalculatorConfig>
): DensityCalculatorService {
  return new DensityCalculatorServiceImpl(config);
}
