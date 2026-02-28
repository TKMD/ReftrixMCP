// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Density Calculator Service Tests
 *
 * TDD Phase: Red
 * These tests define the expected behavior of the DensityCalculatorService
 * for analyzing content density, whitespace ratio, and visual balance
 * of web page screenshots.
 *
 * @module tests/services/visual-extractor/density-calculator.test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import type {
  DensityCalculatorService} from '../../../src/services/visual-extractor/density-calculator.service';
import {
  DensityCalculationResult,
  createDensityCalculatorService,
} from '../../../src/services/visual-extractor/density-calculator.service';

// Helper to create test images with solid color
async function createSolidImage(
  width: number,
  height: number,
  color: { r: number; g: number; b: number }
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: color,
    },
  })
    .png()
    .toBuffer();
}

// Helper to create test image with content areas (simulated by darker regions)
async function createContentImage(
  width: number,
  height: number,
  contentAreas: Array<{ x: number; y: number; w: number; h: number; color: { r: number; g: number; b: number } }>,
  backgroundColor: { r: number; g: number; b: number } = { r: 255, g: 255, b: 255 }
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);

  // Fill with background color
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * channels;
      data[pixelIndex] = backgroundColor.r;
      data[pixelIndex + 1] = backgroundColor.g;
      data[pixelIndex + 2] = backgroundColor.b;
    }
  }

  // Draw content areas
  for (const area of contentAreas) {
    for (let y = area.y; y < Math.min(area.y + area.h, height); y++) {
      for (let x = area.x; x < Math.min(area.x + area.w, width); x++) {
        const pixelIndex = (y * width + x) * channels;
        data[pixelIndex] = area.color.r;
        data[pixelIndex + 1] = area.color.g;
        data[pixelIndex + 2] = area.color.b;
      }
    }
  }

  return sharp(data, {
    raw: {
      width,
      height,
      channels,
    },
  })
    .png()
    .toBuffer();
}

// Helper to create gradient image for edge detection tests
async function createGradientImage(
  width: number,
  height: number,
  direction: 'horizontal' | 'vertical' = 'horizontal'
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * channels;
      const intensity = direction === 'horizontal'
        ? Math.floor((x / width) * 255)
        : Math.floor((y / height) * 255);
      data[pixelIndex] = intensity;
      data[pixelIndex + 1] = intensity;
      data[pixelIndex + 2] = intensity;
    }
  }

  return sharp(data, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

// Helper to create image with sharp edges (high contrast borders)
async function createEdgyImage(
  width: number,
  height: number,
  blockSize: number = 50
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * channels;
      const blockX = Math.floor(x / blockSize);
      const blockY = Math.floor(y / blockSize);
      const isWhite = (blockX + blockY) % 2 === 0;
      const intensity = isWhite ? 255 : 0;
      data[pixelIndex] = intensity;
      data[pixelIndex + 1] = intensity;
      data[pixelIndex + 2] = intensity;
    }
  }

  return sharp(data, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

// Helper to validate HEX color format
function isValidHexColor(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

describe('DensityCalculatorService', () => {
  let service: DensityCalculatorService;

  beforeAll(() => {
    service = createDensityCalculatorService();
  });

  describe('calculateDensity', () => {
    describe('1. Minimal design pages should have high whitespace ratio', () => {
      it('should return high whitespace ratio for mostly white image', async () => {
        // Create a mostly white image with small content area
        const minimalImage = await createContentImage(
          400, 400,
          [{ x: 180, y: 180, w: 40, h: 40, color: { r: 0, g: 0, b: 0 } }],
          { r: 255, g: 255, b: 255 }
        );

        const result = await service.calculateDensity(minimalImage);

        expect(result).toBeDefined();
        expect(result.whitespaceRatio).toBeGreaterThan(0.8);
        expect(result.contentDensity).toBeLessThan(0.2);
      });

      it('should return whitespace ratio close to 1.0 for pure white image', async () => {
        const whiteImage = await createSolidImage(100, 100, { r: 255, g: 255, b: 255 });

        const result = await service.calculateDensity(whiteImage);

        expect(result.whitespaceRatio).toBeGreaterThan(0.95);
        expect(result.contentDensity).toBeLessThan(0.05);
      });
    });

    describe('2. Content-dense pages should have high density', () => {
      it('should return high density for image with many content areas', async () => {
        // Create an image filled with content (dark areas)
        const denseImage = await createContentImage(
          400, 400,
          [
            { x: 0, y: 0, w: 200, h: 200, color: { r: 50, g: 50, b: 50 } },
            { x: 200, y: 0, w: 200, h: 200, color: { r: 100, g: 100, b: 100 } },
            { x: 0, y: 200, w: 200, h: 200, color: { r: 150, g: 0, b: 0 } },
            { x: 200, y: 200, w: 200, h: 200, color: { r: 0, g: 150, b: 0 } },
          ],
          { r: 255, g: 255, b: 255 }
        );

        const result = await service.calculateDensity(denseImage);

        expect(result.contentDensity).toBeGreaterThan(0.5);
        expect(result.whitespaceRatio).toBeLessThan(0.5);
      });

      it('should return density close to 1.0 for pure black image', async () => {
        const blackImage = await createSolidImage(100, 100, { r: 0, g: 0, b: 0 });

        const result = await service.calculateDensity(blackImage);

        // Black image has high content density (non-white)
        expect(result.whitespaceRatio).toBeLessThan(0.1);
      });
    });

    describe('3. Grid division should be accurate', () => {
      it('should return correct number of regions for 3x3 grid', async () => {
        const image = await createSolidImage(300, 300, { r: 128, g: 128, b: 128 });

        const result = await service.calculateDensity(image);

        expect(result.regions).toBeDefined();
        expect(Array.isArray(result.regions)).toBe(true);
        expect(result.regions.length).toBe(9); // 3x3 grid
      });

      it('should return regions with correct row and col indices', async () => {
        const image = await createSolidImage(300, 300, { r: 128, g: 128, b: 128 });

        const result = await service.calculateDensity(image);

        // Check all expected indices are present
        const indices = result.regions.map(r => `${r.row},${r.col}`);
        for (let row = 0; row < 3; row++) {
          for (let col = 0; col < 3; col++) {
            expect(indices).toContain(`${row},${col}`);
          }
        }
      });

      it('should detect different densities in different regions', async () => {
        // Create image with high density in top-left, low density elsewhere
        const image = await createContentImage(
          300, 300,
          [{ x: 0, y: 0, w: 100, h: 100, color: { r: 0, g: 0, b: 0 } }],
          { r: 255, g: 255, b: 255 }
        );

        const result = await service.calculateDensity(image);

        // Find top-left region (0,0) and bottom-right region (2,2)
        const topLeft = result.regions.find(r => r.row === 0 && r.col === 0);
        const bottomRight = result.regions.find(r => r.row === 2 && r.col === 2);

        expect(topLeft).toBeDefined();
        expect(bottomRight).toBeDefined();
        expect(topLeft!.density).toBeGreaterThan(bottomRight!.density);
      });
    });

    describe('4. Visual balance score should be in 0-100 range', () => {
      it('should return visualBalance between 0 and 100', async () => {
        const image = await createSolidImage(200, 200, { r: 100, g: 100, b: 100 });

        const result = await service.calculateDensity(image);

        expect(result.visualBalance).toBeGreaterThanOrEqual(0);
        expect(result.visualBalance).toBeLessThanOrEqual(100);
      });

      it('should return high balance score for uniform image', async () => {
        const uniformImage = await createSolidImage(300, 300, { r: 128, g: 128, b: 128 });

        const result = await service.calculateDensity(uniformImage);

        // Uniform image should have high visual balance (low variance)
        expect(result.visualBalance).toBeGreaterThan(80);
      });

      it('should return lower balance score for asymmetric image', async () => {
        // Create highly asymmetric image (content only on left side)
        const asymmetricImage = await createContentImage(
          400, 400,
          [{ x: 0, y: 0, w: 100, h: 400, color: { r: 0, g: 0, b: 0 } }],
          { r: 255, g: 255, b: 255 }
        );

        const result = await service.calculateDensity(asymmetricImage);

        // Asymmetric image should have lower visual balance
        expect(result.visualBalance).toBeLessThan(80);
      });
    });

    describe('5. Edge case: completely white image', () => {
      it('should handle pure white image without errors', async () => {
        const whiteImage = await createSolidImage(100, 100, { r: 255, g: 255, b: 255 });

        const result = await service.calculateDensity(whiteImage);

        expect(result).toBeDefined();
        expect(result.contentDensity).toBeGreaterThanOrEqual(0);
        expect(result.contentDensity).toBeLessThanOrEqual(1);
        expect(result.whitespaceRatio).toBeGreaterThanOrEqual(0);
        expect(result.whitespaceRatio).toBeLessThanOrEqual(1);
        expect(result.visualBalance).toBeGreaterThanOrEqual(0);
        expect(result.visualBalance).toBeLessThanOrEqual(100);
      });

      it('should return high whitespace ratio for white image', async () => {
        const whiteImage = await createSolidImage(200, 200, { r: 255, g: 255, b: 255 });

        const result = await service.calculateDensity(whiteImage);

        expect(result.whitespaceRatio).toBeGreaterThan(0.9);
      });
    });

    describe('6. Edge case: completely black image', () => {
      it('should handle pure black image without errors', async () => {
        const blackImage = await createSolidImage(100, 100, { r: 0, g: 0, b: 0 });

        const result = await service.calculateDensity(blackImage);

        expect(result).toBeDefined();
        expect(result.contentDensity).toBeGreaterThanOrEqual(0);
        expect(result.contentDensity).toBeLessThanOrEqual(1);
        expect(result.whitespaceRatio).toBeGreaterThanOrEqual(0);
        expect(result.whitespaceRatio).toBeLessThanOrEqual(1);
        expect(result.visualBalance).toBeGreaterThanOrEqual(0);
        expect(result.visualBalance).toBeLessThanOrEqual(100);
      });

      it('should return low whitespace ratio for black image', async () => {
        const blackImage = await createSolidImage(200, 200, { r: 0, g: 0, b: 0 });

        const result = await service.calculateDensity(blackImage);

        expect(result.whitespaceRatio).toBeLessThan(0.1);
      });
    });

    describe('Metrics calculation', () => {
      it('should include edgeDensity metric', async () => {
        const image = await createEdgyImage(200, 200, 50);

        const result = await service.calculateDensity(image);

        expect(result.metrics).toBeDefined();
        expect(result.metrics.edgeDensity).toBeDefined();
        expect(result.metrics.edgeDensity).toBeGreaterThanOrEqual(0);
        expect(result.metrics.edgeDensity).toBeLessThanOrEqual(1);
      });

      it('should have higher edgeDensity for checkerboard pattern', async () => {
        const edgyImage = await createEdgyImage(200, 200, 20);
        const smoothImage = await createSolidImage(200, 200, { r: 128, g: 128, b: 128 });

        const edgyResult = await service.calculateDensity(edgyImage);
        const smoothResult = await service.calculateDensity(smoothImage);

        expect(edgyResult.metrics.edgeDensity).toBeGreaterThan(smoothResult.metrics.edgeDensity);
      });

      it('should include colorVariance metric', async () => {
        const image = await createGradientImage(200, 200);

        const result = await service.calculateDensity(image);

        expect(result.metrics.colorVariance).toBeDefined();
        expect(result.metrics.colorVariance).toBeGreaterThanOrEqual(0);
      });

      it('should include symmetryScore metric', async () => {
        const image = await createSolidImage(200, 200, { r: 128, g: 128, b: 128 });

        const result = await service.calculateDensity(image);

        expect(result.metrics.symmetryScore).toBeDefined();
        expect(result.metrics.symmetryScore).toBeGreaterThanOrEqual(0);
        expect(result.metrics.symmetryScore).toBeLessThanOrEqual(1);
      });
    });

    describe('Region dominant color', () => {
      it('should return dominantColor in HEX format for each region', async () => {
        const image = await createSolidImage(300, 300, { r: 255, g: 0, b: 0 });

        const result = await service.calculateDensity(image);

        result.regions.forEach(region => {
          expect(isValidHexColor(region.dominantColor)).toBe(true);
        });
      });

      it('should correctly identify region dominant colors', async () => {
        // Create image with red top-left, blue bottom-right
        const image = await createContentImage(
          300, 300,
          [
            { x: 0, y: 0, w: 100, h: 100, color: { r: 255, g: 0, b: 0 } },
            { x: 200, y: 200, w: 100, h: 100, color: { r: 0, g: 0, b: 255 } },
          ],
          { r: 255, g: 255, b: 255 }
        );

        const result = await service.calculateDensity(image);

        const topLeft = result.regions.find(r => r.row === 0 && r.col === 0);
        const bottomRight = result.regions.find(r => r.row === 2 && r.col === 2);

        expect(topLeft).toBeDefined();
        expect(bottomRight).toBeDefined();

        // Top-left should be reddish
        const topLeftR = parseInt(topLeft!.dominantColor.slice(1, 3), 16);
        expect(topLeftR).toBeGreaterThan(150);

        // Bottom-right should be bluish
        const bottomRightB = parseInt(bottomRight!.dominantColor.slice(5, 7), 16);
        expect(bottomRightB).toBeGreaterThan(150);
      });
    });
  });

  describe('calculateWhitespace', () => {
    it('should calculate whitespace ratio for white background', async () => {
      const whiteImage = await createSolidImage(100, 100, { r: 255, g: 255, b: 255 });

      const ratio = await service.calculateWhitespace(whiteImage);

      expect(ratio).toBeGreaterThan(0.95);
    });

    it('should accept custom background color', async () => {
      // Create dark gray image
      const darkGrayImage = await createSolidImage(100, 100, { r: 50, g: 50, b: 50 });

      // With white as background, this should be low whitespace
      const ratioWhiteBg = await service.calculateWhitespace(darkGrayImage);
      expect(ratioWhiteBg).toBeLessThan(0.1);

      // With dark gray as background, this should be high whitespace
      const ratioDarkBg = await service.calculateWhitespace(darkGrayImage, '#323232');
      expect(ratioDarkBg).toBeGreaterThan(0.9);
    });

    it('should return 0-1 range', async () => {
      const image = await createGradientImage(200, 200);

      const ratio = await service.calculateWhitespace(image);

      expect(ratio).toBeGreaterThanOrEqual(0);
      expect(ratio).toBeLessThanOrEqual(1);
    });
  });

  describe('analyzeRegions', () => {
    it('should return regions array with default 3x3 grid', async () => {
      const image = await createSolidImage(300, 300, { r: 128, g: 128, b: 128 });

      const regions = await service.analyzeRegions(image);

      expect(regions.length).toBe(9);
    });

    it('should return regions array with custom 4x4 grid', async () => {
      const image = await createSolidImage(400, 400, { r: 128, g: 128, b: 128 });

      const regions = await service.analyzeRegions(image, 4);

      expect(regions.length).toBe(16);
    });

    it('should return regions with correct structure', async () => {
      const image = await createSolidImage(200, 200, { r: 100, g: 150, b: 200 });

      const regions = await service.analyzeRegions(image);

      regions.forEach(region => {
        expect(region).toHaveProperty('row');
        expect(region).toHaveProperty('col');
        expect(region).toHaveProperty('density');
        expect(region).toHaveProperty('dominantColor');
        expect(typeof region.row).toBe('number');
        expect(typeof region.col).toBe('number');
        expect(typeof region.density).toBe('number');
        expect(typeof region.dominantColor).toBe('string');
      });
    });
  });

  describe('Input validation', () => {
    it('should throw error for null input', async () => {
      await expect(service.calculateDensity(null as unknown as Buffer)).rejects.toThrow();
    });

    it('should throw error for undefined input', async () => {
      await expect(service.calculateDensity(undefined as unknown as Buffer)).rejects.toThrow();
    });

    it('should throw error for empty buffer', async () => {
      const emptyBuffer = Buffer.alloc(0);
      await expect(service.calculateDensity(emptyBuffer)).rejects.toThrow();
    });

    it('should throw error for invalid image data', async () => {
      const invalidData = Buffer.from('not an image');
      await expect(service.calculateDensity(invalidData)).rejects.toThrow();
    });

    it('should accept valid base64 encoded image', async () => {
      const image = await createSolidImage(100, 100, { r: 100, g: 150, b: 200 });
      const base64Image = image.toString('base64');

      const result = await service.calculateDensity(base64Image);

      expect(result).toBeDefined();
      expect(result.contentDensity).toBeGreaterThanOrEqual(0);
    });

    it('should accept base64 with data URL prefix', async () => {
      const image = await createSolidImage(100, 100, { r: 100, g: 150, b: 200 });
      const base64WithPrefix = `data:image/png;base64,${image.toString('base64')}`;

      const result = await service.calculateDensity(base64WithPrefix);

      expect(result).toBeDefined();
    });
  });

  describe('Performance', () => {
    it('should process a 1920x1080 image in less than 1000ms', async () => {
      // Create a large image
      const largeImage = await createEdgyImage(1920, 1080, 100);

      const startTime = performance.now();
      const result = await service.calculateDensity(largeImage);
      const endTime = performance.now();

      const processingTime = endTime - startTime;

      expect(result).toBeDefined();
      expect(processingTime).toBeLessThan(1000);

      if (process.env.NODE_ENV === 'development') {
        console.log(`[DensityCalculator] Processing time: ${processingTime.toFixed(2)}ms`);
      }
    });
  });
});
