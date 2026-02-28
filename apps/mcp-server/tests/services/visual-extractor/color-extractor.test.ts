// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Color Extractor Service Tests
 *
 * TDD Phase: Red
 * These tests define the expected behavior of the ColorExtractorService
 *
 * @module tests/services/visual-extractor/color-extractor.test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import type {
  ColorExtractorService} from '../../../src/services/visual-extractor/color-extractor.service';
import {
  ColorExtractionResult,
  createColorExtractorService,
} from '../../../src/services/visual-extractor/color-extractor.service';

// Test fixtures paths
const FIXTURES_DIR = path.join(__dirname, '../../fixtures/images');

// Helper to create test images
async function createTestImage(
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

// Helper to create gradient test image
async function createGradientImage(
  width: number,
  height: number,
  colors: Array<{ r: number; g: number; b: number }>
): Promise<Buffer> {
  // Create raw pixel data with vertical stripes
  const channels = 3;
  const stripeWidth = Math.floor(width / colors.length);
  const data = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colorIndex = Math.min(Math.floor(x / stripeWidth), colors.length - 1);
      const color = colors[colorIndex];
      const pixelIndex = (y * width + x) * channels;
      data[pixelIndex] = color.r;
      data[pixelIndex + 1] = color.g;
      data[pixelIndex + 2] = color.b;
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

// Helper to create transparent image
async function createTransparentImage(
  width: number,
  height: number,
  alpha: number = 0
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha },
    },
  })
    .png()
    .toBuffer();
}

// Helper to validate HEX color format
function isValidHexColor(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

describe('ColorExtractorService', () => {
  let service: ColorExtractorService;

  beforeAll(() => {
    service = createColorExtractorService();
  });

  describe('extractColors', () => {
    describe('1. Extract dominant colors from image', () => {
      it('should extract dominant colors from a solid color image', async () => {
        // Create a solid red image
        const redImage = await createTestImage(100, 100, { r: 255, g: 0, b: 0 });

        const result = await service.extractColors(redImage);

        expect(result).toBeDefined();
        expect(result.dominantColors).toBeDefined();
        expect(Array.isArray(result.dominantColors)).toBe(true);
        expect(result.dominantColors.length).toBeGreaterThan(0);
        expect(result.dominantColors.length).toBeLessThanOrEqual(5);
      });

      it('should extract up to 5 dominant colors from multi-color image', async () => {
        // Create image with multiple colors
        const multiColorImage = await createGradientImage(500, 100, [
          { r: 255, g: 0, b: 0 },   // Red
          { r: 0, g: 255, b: 0 },   // Green
          { r: 0, g: 0, b: 255 },   // Blue
          { r: 255, g: 255, b: 0 }, // Yellow
          { r: 255, g: 0, b: 255 }, // Magenta
          { r: 0, g: 255, b: 255 }, // Cyan
        ]);

        const result = await service.extractColors(multiColorImage);

        expect(result.dominantColors.length).toBeLessThanOrEqual(5);
        expect(result.dominantColors.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('2. Extract accent colors from image', () => {
      it('should extract accent colors from multi-color image', async () => {
        const multiColorImage = await createGradientImage(300, 100, [
          { r: 50, g: 50, b: 50 },   // Dark gray (dominant)
          { r: 50, g: 50, b: 50 },   // Dark gray (dominant)
          { r: 255, g: 100, b: 0 },  // Orange (accent)
        ]);

        const result = await service.extractColors(multiColorImage);

        expect(result).toBeDefined();
        expect(result.accentColors).toBeDefined();
        expect(Array.isArray(result.accentColors)).toBe(true);
        expect(result.accentColors.length).toBeLessThanOrEqual(3);
      });

      it('should return empty accent colors for monochrome image', async () => {
        const grayImage = await createTestImage(100, 100, { r: 128, g: 128, b: 128 });

        const result = await service.extractColors(grayImage);

        // For monochrome images, accent colors may be empty or minimal
        expect(result.accentColors).toBeDefined();
        expect(Array.isArray(result.accentColors)).toBe(true);
      });
    });

    describe('3. Colors are returned in HEX format (#RRGGBB)', () => {
      it('should return dominant colors in HEX format', async () => {
        const image = await createTestImage(100, 100, { r: 255, g: 128, b: 64 });

        const result = await service.extractColors(image);

        result.dominantColors.forEach((color) => {
          expect(isValidHexColor(color)).toBe(true);
        });
      });

      it('should return accent colors in HEX format', async () => {
        const multiColorImage = await createGradientImage(200, 100, [
          { r: 100, g: 100, b: 100 },
          { r: 255, g: 0, b: 128 },
        ]);

        const result = await service.extractColors(multiColorImage);

        result.accentColors.forEach((color) => {
          expect(isValidHexColor(color)).toBe(true);
        });
      });

      it('should return color palette colors in HEX format', async () => {
        const image = await createGradientImage(300, 100, [
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 255, b: 0 },
          { r: 0, g: 0, b: 255 },
        ]);

        const result = await service.extractColors(image);

        expect(result.colorPalette).toBeDefined();
        expect(Array.isArray(result.colorPalette)).toBe(true);
        result.colorPalette.forEach((item) => {
          expect(isValidHexColor(item.color)).toBe(true);
          expect(typeof item.percentage).toBe('number');
          expect(item.percentage).toBeGreaterThanOrEqual(0);
          expect(item.percentage).toBeLessThanOrEqual(100);
        });
      });
    });

    describe('4. Handle transparent images properly', () => {
      it('should handle fully transparent images gracefully', async () => {
        const transparentImage = await createTransparentImage(100, 100, 0);

        const result = await service.extractColors(transparentImage);

        expect(result).toBeDefined();
        expect(result.dominantColors).toBeDefined();
        expect(result.accentColors).toBeDefined();
        expect(result.colorPalette).toBeDefined();
      });

      it('should handle semi-transparent images', async () => {
        const semiTransparentImage = await createTransparentImage(100, 100, 0.5);

        const result = await service.extractColors(semiTransparentImage);

        expect(result).toBeDefined();
        expect(result.dominantColors.length).toBeGreaterThanOrEqual(0);
      });

      it('should handle images with transparent regions', async () => {
        // Create an image with mixed transparency
        const channels = 4;
        const width = 100;
        const height = 100;
        const data = Buffer.alloc(width * height * channels);

        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const pixelIndex = (y * width + x) * channels;
            if (x < width / 2) {
              // Left half: solid red
              data[pixelIndex] = 255;
              data[pixelIndex + 1] = 0;
              data[pixelIndex + 2] = 0;
              data[pixelIndex + 3] = 255;
            } else {
              // Right half: transparent
              data[pixelIndex] = 0;
              data[pixelIndex + 1] = 0;
              data[pixelIndex + 2] = 0;
              data[pixelIndex + 3] = 0;
            }
          }
        }

        const mixedImage = await sharp(data, {
          raw: { width, height, channels },
        })
          .png()
          .toBuffer();

        const result = await service.extractColors(mixedImage);

        expect(result).toBeDefined();
        expect(result.dominantColors.length).toBeGreaterThanOrEqual(0);
      });
    });

    describe('5. Handle monochrome images properly', () => {
      it('should handle pure black image', async () => {
        const blackImage = await createTestImage(100, 100, { r: 0, g: 0, b: 0 });

        const result = await service.extractColors(blackImage);

        expect(result).toBeDefined();
        expect(result.dominantColors.length).toBeGreaterThanOrEqual(1);
        // Black should be close to #000000
        expect(result.dominantColors[0]).toMatch(/^#[0-3][0-3][0-3][0-3][0-3][0-3]$/);
      });

      it('should handle pure white image', async () => {
        const whiteImage = await createTestImage(100, 100, { r: 255, g: 255, b: 255 });

        const result = await service.extractColors(whiteImage);

        expect(result).toBeDefined();
        expect(result.dominantColors.length).toBeGreaterThanOrEqual(1);
        // White should be close to #FFFFFF
        expect(result.dominantColors[0]).toMatch(/^#[Ff][0-9A-Fa-f][Ff][0-9A-Fa-f][Ff][0-9A-Fa-f]$/);
      });

      it('should handle grayscale image', async () => {
        const grayscaleImage = await createGradientImage(100, 100, [
          { r: 50, g: 50, b: 50 },
          { r: 100, g: 100, b: 100 },
          { r: 150, g: 150, b: 150 },
          { r: 200, g: 200, b: 200 },
        ]);

        const result = await service.extractColors(grayscaleImage);

        expect(result).toBeDefined();
        expect(result.dominantColors.length).toBeGreaterThanOrEqual(1);
        // All colors should have equal R, G, B values (grayscale)
        result.dominantColors.forEach((color) => {
          const r = parseInt(color.slice(1, 3), 16);
          const g = parseInt(color.slice(3, 5), 16);
          const b = parseInt(color.slice(5, 7), 16);
          // Allow some tolerance for color quantization
          expect(Math.abs(r - g)).toBeLessThanOrEqual(20);
          expect(Math.abs(g - b)).toBeLessThanOrEqual(20);
          expect(Math.abs(r - b)).toBeLessThanOrEqual(20);
        });
      });
    });

    describe('6. Throw error for invalid image input', () => {
      it('should throw error for null input', async () => {
        await expect(service.extractColors(null as unknown as Buffer)).rejects.toThrow();
      });

      it('should throw error for undefined input', async () => {
        await expect(service.extractColors(undefined as unknown as Buffer)).rejects.toThrow();
      });

      it('should throw error for empty buffer', async () => {
        const emptyBuffer = Buffer.alloc(0);
        await expect(service.extractColors(emptyBuffer)).rejects.toThrow();
      });

      it('should throw error for invalid image data', async () => {
        const invalidData = Buffer.from('not an image');
        await expect(service.extractColors(invalidData)).rejects.toThrow();
      });

      it('should throw error for invalid base64 string', async () => {
        const invalidBase64 = 'not-valid-base64!!!';
        await expect(service.extractColors(invalidBase64)).rejects.toThrow();
      });

      it('should accept valid base64 encoded image', async () => {
        const image = await createTestImage(100, 100, { r: 100, g: 150, b: 200 });
        const base64Image = image.toString('base64');

        const result = await service.extractColors(base64Image);

        expect(result).toBeDefined();
        expect(result.dominantColors.length).toBeGreaterThanOrEqual(1);
      });

      it('should accept base64 with data URL prefix', async () => {
        const image = await createTestImage(100, 100, { r: 100, g: 150, b: 200 });
        const base64WithPrefix = `data:image/png;base64,${image.toString('base64')}`;

        const result = await service.extractColors(base64WithPrefix);

        expect(result).toBeDefined();
        expect(result.dominantColors.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('Performance', () => {
      it('should process a 1920x1080 image in less than 500ms', async () => {
        // Create a large image
        const largeImage = await createGradientImage(1920, 1080, [
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 255, b: 0 },
          { r: 0, g: 0, b: 255 },
          { r: 255, g: 255, b: 0 },
        ]);

        const startTime = performance.now();
        const result = await service.extractColors(largeImage);
        const endTime = performance.now();

        const processingTime = endTime - startTime;

        expect(result).toBeDefined();
        expect(processingTime).toBeLessThan(500);

        if (process.env.NODE_ENV === 'development') {
          console.log(`[ColorExtractor] Processing time: ${processingTime.toFixed(2)}ms`);
        }
      });
    });

    describe('Color accuracy', () => {
      it('should correctly identify red as dominant color', async () => {
        const redImage = await createTestImage(100, 100, { r: 255, g: 0, b: 0 });

        const result = await service.extractColors(redImage);

        // The dominant color should be close to #FF0000
        const dominantColor = result.dominantColors[0];
        const r = parseInt(dominantColor.slice(1, 3), 16);
        const g = parseInt(dominantColor.slice(3, 5), 16);
        const b = parseInt(dominantColor.slice(5, 7), 16);

        expect(r).toBeGreaterThan(200);
        expect(g).toBeLessThan(50);
        expect(b).toBeLessThan(50);
      });

      it('should correctly identify blue as dominant color', async () => {
        const blueImage = await createTestImage(100, 100, { r: 0, g: 0, b: 255 });

        const result = await service.extractColors(blueImage);

        const dominantColor = result.dominantColors[0];
        const r = parseInt(dominantColor.slice(1, 3), 16);
        const g = parseInt(dominantColor.slice(3, 5), 16);
        const b = parseInt(dominantColor.slice(5, 7), 16);

        expect(r).toBeLessThan(50);
        expect(g).toBeLessThan(50);
        expect(b).toBeGreaterThan(200);
      });
    });
  });
});
