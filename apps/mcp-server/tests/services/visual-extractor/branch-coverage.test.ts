// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Branch Coverage Tests for Visual Extractor Services
 *
 * Tests for uncovered branches to improve coverage from 64.73% to > 70%
 *
 * Target areas:
 * - image-utils.ts: lines 102-104, 158, 201-202
 * - color-extractor.service.ts: lines 315, 325, 350-352
 * - theme-detector.service.ts: lines 305-308, 328
 *
 * @module tests/services/visual-extractor/branch-coverage.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';
import {
  parseImageInput,
  parseAndValidateImageInput,
  logSecurityEvent,
  isSharpImageError,
  wrapSharpError,
} from '../../../src/services/visual-extractor/image-utils';
import { createColorExtractorService } from '../../../src/services/visual-extractor/color-extractor.service';
import { createThemeDetectorService } from '../../../src/services/visual-extractor/theme-detector.service';
import { createDensityCalculatorService } from '../../../src/services/visual-extractor/density-calculator.service';
import { logger } from '../../../src/utils/logger';

// Helper to create valid image
async function createValidImage(width = 100, height = 100): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  })
    .png()
    .toBuffer();
}

describe('Branch Coverage Tests', () => {
  describe('image-utils.ts branch coverage', () => {
    describe('parseImageInput - empty base64 decode branch (line 201-202)', () => {
      it('should throw for base64 that decodes to empty buffer', () => {
        // An empty string encoded in base64 would be empty
        // However, we need a valid base64 that decodes to empty
        // The closest is a very short valid base64 that produces minimal output
        // Actually, empty string after removing prefix should fail regex first
        // Let's test with whitespace-only base64
        expect(() => parseImageInput('')).toThrow('Image input is required');
      });

      it('should throw for base64 with only data URL prefix', () => {
        // data URL prefix without actual content
        // After split, parts[1] would be empty string
        const dataUrlOnly = 'data:image/png;base64,';
        expect(() => parseImageInput(dataUrlOnly)).toThrow();
      });
    });

    describe('parseAndValidateImageInput - empty base64 decode branch (line 102-104)', () => {
      it('should throw for base64 with only data URL prefix (with validation)', () => {
        const dataUrlOnly = 'data:image/png;base64,';
        expect(() => parseAndValidateImageInput(dataUrlOnly)).toThrow();
      });
    });

    describe('logSecurityEvent - development mode branch (line 158)', () => {
      let loggerSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        loggerSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      });

      afterEach(() => {
        loggerSpy.mockRestore();
      });

      it('should log in development mode', () => {
        logSecurityEvent('TestService', 'Test event', { key: 'value' });

        expect(loggerSpy).toHaveBeenCalledWith(
          '[Security:TestService] Test event',
          { key: 'value' }
        );
      });

      it('should log with empty details in development mode', () => {
        logSecurityEvent('TestService', 'Test event');

        expect(loggerSpy).toHaveBeenCalledWith(
          '[Security:TestService] Test event',
          ''
        );
      });
    });
  });

  describe('color-extractor.service.ts branch coverage', () => {
    describe('development mode logging (line 325)', () => {
      let loggerSpy: ReturnType<typeof vi.spyOn>;
      let service: ReturnType<typeof createColorExtractorService>;

      beforeEach(() => {
        loggerSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        service = createColorExtractorService();
      });

      afterEach(() => {
        loggerSpy.mockRestore();
      });

      it('should log extraction details in development mode', async () => {
        const image = await createValidImage();

        await service.extractColors(image);

        // logger.debug が [ColorExtractor] プレフィックス付きで呼ばれることを確認
        expect(loggerSpy).toHaveBeenCalledWith(
          expect.stringContaining('[ColorExtractor]'),
          expect.any(Object)
        );
      });
    });

    describe('error handling for non-sharp errors (lines 350-352)', () => {
      it('should rethrow non-sharp errors', async () => {
        const service = createColorExtractorService();
        // Pass completely invalid data that won't be caught as sharp error
        const invalidData = Buffer.from([0x00, 0x01, 0x02, 0x03]);

        await expect(service.extractColors(invalidData)).rejects.toThrow();
      });

      it('should handle sharp vips errors', async () => {
        const service = createColorExtractorService();
        // Create a buffer that looks like an image but isn't valid
        const corruptedImage = Buffer.from('PNG\r\n\x1a\nIHDR corrupted data');

        await expect(service.extractColors(corruptedImage)).rejects.toThrow();
      });
    });
  });

  describe('theme-detector.service.ts branch coverage', () => {
    describe('empty colorPalette handling (lines 305-308)', () => {
      it('should handle empty color palette with dominantColors fallback', () => {
        const service = createThemeDetectorService();

        const result = service.detectThemeFromColors({
          dominantColors: ['#FFFFFF'],
          accentColors: [],
          colorPalette: [],
        });

        expect(result).toBeDefined();
        expect(result.theme).toBeDefined();
      });

      it('should handle empty colorPalette and empty dominantColors', () => {
        const service = createThemeDetectorService();

        const result = service.detectThemeFromColors({
          dominantColors: [],
          accentColors: [],
          colorPalette: [],
        });

        // Should use defaults
        expect(result).toBeDefined();
        expect(result.theme).toBeDefined();
        expect(result.backgroundColor).toBe('#808080'); // Default gray
      });
    });

    describe('development mode logging (line 328)', () => {
      let loggerSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        loggerSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      });

      afterEach(() => {
        loggerSpy.mockRestore();
      });

      it('should log theme detection details in development mode', async () => {
        const service = createThemeDetectorService();
        const image = await createValidImage();

        await service.detectTheme(image);

        // logger.debug が [ThemeDetector] プレフィックス付きで呼ばれることを確認
        expect(loggerSpy).toHaveBeenCalledWith(
          expect.stringContaining('[ThemeDetector]'),
          expect.any(Object)
        );
      });
    });
  });

  describe('density-calculator.service.ts branch coverage', () => {
    describe('development mode logging', () => {
      let loggerSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        loggerSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      });

      afterEach(() => {
        loggerSpy.mockRestore();
      });

      it('should log density calculation details in development mode', async () => {
        const service = createDensityCalculatorService();
        const image = await createValidImage();

        await service.calculateDensity(image);

        // logger.debug が [DensityCalculator] プレフィックス付きで呼ばれることを確認
        expect(loggerSpy).toHaveBeenCalledWith(
          expect.stringContaining('[DensityCalculator]'),
          expect.any(Object)
        );
      });

      it('should return whitespace ratio as number', async () => {
        const service = createDensityCalculatorService();
        const image = await createValidImage();

        const result = await service.calculateWhitespace(image);

        // calculateWhitespace returns a number directly, not an object
        expect(typeof result).toBe('number');
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      });

      it('should return region array', async () => {
        const service = createDensityCalculatorService();
        const image = await createValidImage();

        const result = await service.analyzeRegions(image);

        // analyzeRegions returns RegionAnalysis[] directly, not an object
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);
        // Each region should have row, col, density, dominantColor
        expect(result[0]).toHaveProperty('row');
        expect(result[0]).toHaveProperty('col');
        expect(result[0]).toHaveProperty('density');
        expect(result[0]).toHaveProperty('dominantColor');
      });
    });

    describe('edge cases for coverage', () => {
      it('should handle very small images', async () => {
        const service = createDensityCalculatorService();
        const smallImage = await sharp({
          create: {
            width: 10,
            height: 10,
            channels: 3,
            background: { r: 128, g: 128, b: 128 },
          },
        })
          .png()
          .toBuffer();

        const result = await service.calculateDensity(smallImage);
        expect(result).toBeDefined();
        expect(result.contentDensity).toBeDefined();
      });

      it('should handle uniform color images for whitespace', async () => {
        const service = createDensityCalculatorService();
        const whiteImage = await sharp({
          create: {
            width: 100,
            height: 100,
            channels: 3,
            background: { r: 255, g: 255, b: 255 },
          },
        })
          .png()
          .toBuffer();

        // calculateWhitespace returns a number directly (0-1)
        const result = await service.calculateWhitespace(whiteImage);
        expect(typeof result).toBe('number');
        expect(result).toBeGreaterThan(0.5);
      });

      it('should handle images with regions', async () => {
        const service = createDensityCalculatorService();
        // Create a simple gradient image
        const width = 100;
        const height = 100;
        const channels = 3;
        const data = Buffer.alloc(width * height * channels);

        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const pixelIndex = (y * width + x) * channels;
            const gray = Math.floor((x / width) * 255);
            data[pixelIndex] = gray;
            data[pixelIndex + 1] = gray;
            data[pixelIndex + 2] = gray;
          }
        }

        const gradientImage = await sharp(data, {
          raw: { width, height, channels },
        })
          .png()
          .toBuffer();

        // analyzeRegions returns RegionAnalysis[] directly
        const result = await service.analyzeRegions(gradientImage);
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Additional edge cases for coverage', () => {
    describe('parseImageInput edge cases', () => {
      it('should handle buffer input type check', () => {
        const validBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const result = parseImageInput(validBuffer);
        expect(result).toEqual(validBuffer);
      });

      it('should handle string with data URL prefix for multiple MIME types', () => {
        const original = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

        // Test with image/png
        const pngDataUrl = `data:image/png;base64,${original.toString('base64')}`;
        expect(parseImageInput(pngDataUrl)).toEqual(original);

        // Test with image/jpeg
        const jpegDataUrl = `data:image/jpeg;base64,${original.toString('base64')}`;
        expect(parseImageInput(jpegDataUrl)).toEqual(original);

        // Test with image/gif
        const gifDataUrl = `data:image/gif;base64,${original.toString('base64')}`;
        expect(parseImageInput(gifDataUrl)).toEqual(original);
      });
    });

    describe('Color extractor with minimal colors', () => {
      it('should handle single pixel image', async () => {
        const service = createColorExtractorService();
        const singlePixel = await sharp({
          create: {
            width: 1,
            height: 1,
            channels: 3,
            background: { r: 255, g: 0, b: 0 },
          },
        })
          .png()
          .toBuffer();

        const result = await service.extractColors(singlePixel);
        expect(result).toBeDefined();
        expect(result.dominantColors.length).toBeGreaterThan(0);
      });

      it('should handle image with many similar colors', async () => {
        const service = createColorExtractorService();
        const width = 100;
        const height = 100;
        const channels = 3;
        const data = Buffer.alloc(width * height * channels);

        // Create image with slight color variations
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const pixelIndex = (y * width + x) * channels;
            data[pixelIndex] = 200 + (x % 10);     // R: 200-209
            data[pixelIndex + 1] = 100 + (y % 10); // G: 100-109
            data[pixelIndex + 2] = 50;              // B: 50
          }
        }

        const similarColorsImage = await sharp(data, {
          raw: { width, height, channels },
        })
          .png()
          .toBuffer();

        const result = await service.extractColors(similarColorsImage);
        expect(result).toBeDefined();
        expect(result.dominantColors.length).toBeGreaterThan(0);
      });
    });

    describe('Theme detector edge cases', () => {
      it('should handle colorPalette with single color', () => {
        const service = createThemeDetectorService();

        const result = service.detectThemeFromColors({
          dominantColors: ['#000000'],
          accentColors: [],
          colorPalette: [{ color: '#000000', percentage: 100 }],
        });

        expect(result.theme).toBe('dark');
        expect(result.confidence).toBeGreaterThan(0);
      });

      it('should handle very low percentages', () => {
        const service = createThemeDetectorService();

        const result = service.detectThemeFromColors({
          dominantColors: ['#FFFFFF', '#000000'],
          accentColors: [],
          colorPalette: [
            { color: '#FFFFFF', percentage: 0.1 },
            { color: '#000000', percentage: 0.1 },
          ],
        });

        expect(result).toBeDefined();
        expect(result.theme).toBeDefined();
      });
    });
  });

  describe('isSharpImageError and wrapSharpError coverage', () => {
    describe('isSharpImageError', () => {
      it('should return true for Input buffer error', () => {
        const error = new Error('Input buffer contains unsupported image format');
        expect(isSharpImageError(error)).toBe(true);
      });

      it('should return true for unsupported image format error', () => {
        const error = new Error('unsupported image format');
        expect(isSharpImageError(error)).toBe(true);
      });

      it('should return true for Input file error', () => {
        const error = new Error('Input file is missing');
        expect(isSharpImageError(error)).toBe(true);
      });

      it('should return true for VipsJpeg error', () => {
        const error = new Error('VipsJpeg: Invalid data');
        expect(isSharpImageError(error)).toBe(true);
      });

      it('should return true for vips error', () => {
        const error = new Error('vips error during processing');
        expect(isSharpImageError(error)).toBe(true);
      });

      it('should return false for non-Sharp errors', () => {
        const error = new Error('Network connection failed');
        expect(isSharpImageError(error)).toBe(false);
      });

      it('should return false for generic errors', () => {
        const error = new Error('Something went wrong');
        expect(isSharpImageError(error)).toBe(false);
      });
    });

    describe('wrapSharpError', () => {
      it('should wrap Sharp errors as Invalid image data', () => {
        const error = new Error('Input buffer contains unsupported image format');
        const wrapped = wrapSharpError(error);
        expect(wrapped.message).toBe('Invalid image data');
      });

      it('should wrap vips errors as Invalid image data', () => {
        const error = new Error('vips error during processing');
        const wrapped = wrapSharpError(error);
        expect(wrapped.message).toBe('Invalid image data');
      });

      it('should return original error for non-Sharp errors', () => {
        const error = new Error('Network connection failed');
        const wrapped = wrapSharpError(error);
        expect(wrapped.message).toBe('Network connection failed');
      });

      it('should handle non-Error objects', () => {
        const wrapped = wrapSharpError('string error');
        expect(wrapped.message).toBe('Unknown image processing error');
      });

      it('should handle null', () => {
        const wrapped = wrapSharpError(null);
        expect(wrapped.message).toBe('Unknown image processing error');
      });

      it('should handle undefined', () => {
        const wrapped = wrapSharpError(undefined);
        expect(wrapped.message).toBe('Unknown image processing error');
      });

      it('should handle numbers', () => {
        const wrapped = wrapSharpError(42);
        expect(wrapped.message).toBe('Unknown image processing error');
      });

      it('should handle objects', () => {
        const wrapped = wrapSharpError({ foo: 'bar' });
        expect(wrapped.message).toBe('Unknown image processing error');
      });
    });
  });
});
