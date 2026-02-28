// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image Utils Security Tests
 *
 * Tests for SEC H-1 (Input Size Validation) and SEC M-1 (Processing Timeout)
 *
 * Security requirements tested:
 * - 5MB maximum image size limit
 * - 30s processing timeout
 * - Proper error handling and error types
 *
 * @module tests/services/visual-extractor/image-utils.security.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';
import {
  MAX_IMAGE_SIZE,
  DEFAULT_PROCESSING_TIMEOUT,
  ImageSizeExceededError,
  ProcessingTimeoutError,
  validateImageSize,
  parseAndValidateImageInput,
  withTimeout,
} from '../../../src/services/visual-extractor/image-utils';
import { createColorExtractorService } from '../../../src/services/visual-extractor/color-extractor.service';
import { createThemeDetectorService } from '../../../src/services/visual-extractor/theme-detector.service';
import { createDensityCalculatorService } from '../../../src/services/visual-extractor/density-calculator.service';

// Helper to create test image buffer of specific size
async function createImageOfSize(targetSizeBytes: number): Promise<Buffer> {
  // PNG compression makes exact size difficult, so we'll create a buffer directly for size tests
  const buffer = Buffer.alloc(targetSizeBytes);
  // Fill with some data to make it look like image data
  for (let i = 0; i < targetSizeBytes; i++) {
    buffer[i] = i % 256;
  }
  return buffer;
}

// Helper to create a valid small PNG image
async function createValidSmallImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 100,
      height: 100,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  })
    .png()
    .toBuffer();
}

describe('Image Utils Security Tests', () => {
  describe('SEC H-1: Input Size Validation', () => {
    describe('Constants', () => {
      it('should have MAX_IMAGE_SIZE set to 5MB', () => {
        expect(MAX_IMAGE_SIZE).toBe(5 * 1024 * 1024);
      });
    });

    describe('validateImageSize', () => {
      it('should not throw for buffer under 5MB', () => {
        const buffer = Buffer.alloc(4 * 1024 * 1024); // 4MB
        expect(() => validateImageSize(buffer)).not.toThrow();
      });

      it('should not throw for buffer exactly at 5MB', () => {
        const buffer = Buffer.alloc(5 * 1024 * 1024); // 5MB
        expect(() => validateImageSize(buffer)).not.toThrow();
      });

      it('should throw ImageSizeExceededError for buffer over 5MB', () => {
        const buffer = Buffer.alloc(5 * 1024 * 1024 + 1); // 5MB + 1 byte
        expect(() => validateImageSize(buffer)).toThrow(ImageSizeExceededError);
      });

      it('should throw ImageSizeExceededError for 10MB buffer', () => {
        const buffer = Buffer.alloc(10 * 1024 * 1024); // 10MB
        expect(() => validateImageSize(buffer)).toThrow(ImageSizeExceededError);
      });

      it('should include size information in error message', () => {
        const buffer = Buffer.alloc(6 * 1024 * 1024); // 6MB
        try {
          validateImageSize(buffer);
          expect.fail('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(ImageSizeExceededError);
          expect((error as Error).message).toContain('6');
          expect((error as Error).message).toContain('5MB');
        }
      });

      it('should support custom max size parameter', () => {
        const buffer = Buffer.alloc(2 * 1024 * 1024); // 2MB
        const customMax = 1 * 1024 * 1024; // 1MB

        expect(() => validateImageSize(buffer, customMax)).toThrow(ImageSizeExceededError);
      });
    });

    describe('parseAndValidateImageInput', () => {
      it('should reject buffer over 5MB', async () => {
        const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB
        expect(() => parseAndValidateImageInput(largeBuffer)).toThrow(ImageSizeExceededError);
      });

      it('should reject base64 string that decodes to over 5MB', () => {
        // Base64 encoding increases size by ~33%, so 4MB raw = ~5.3MB base64
        // We need base64 that decodes to > 5MB
        const largeBuffer = Buffer.alloc(6 * 1024 * 1024);
        const base64 = largeBuffer.toString('base64');

        expect(() => parseAndValidateImageInput(base64)).toThrow(ImageSizeExceededError);
      });

      it('should reject base64 with data URL prefix that decodes to over 5MB', () => {
        const largeBuffer = Buffer.alloc(6 * 1024 * 1024);
        const base64WithPrefix = `data:image/png;base64,${largeBuffer.toString('base64')}`;

        expect(() => parseAndValidateImageInput(base64WithPrefix)).toThrow(ImageSizeExceededError);
      });

      it('should accept buffer under 5MB', async () => {
        const validImage = await createValidSmallImage();
        expect(() => parseAndValidateImageInput(validImage)).not.toThrow();
      });

      it('should accept valid base64 under 5MB', async () => {
        const validImage = await createValidSmallImage();
        const base64 = validImage.toString('base64');
        expect(() => parseAndValidateImageInput(base64)).not.toThrow();
      });
    });
  });

  describe('SEC M-1: Processing Timeout', () => {
    describe('Constants', () => {
      it('should have DEFAULT_PROCESSING_TIMEOUT set to 30 seconds', () => {
        expect(DEFAULT_PROCESSING_TIMEOUT).toBe(30_000);
      });
    });

    describe('withTimeout', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('should resolve successfully for fast operations', async () => {
        const fastOperation = Promise.resolve('success');

        const resultPromise = withTimeout(fastOperation, 1000);
        vi.advanceTimersByTime(100);

        await expect(resultPromise).resolves.toBe('success');
      });

      it('should throw ProcessingTimeoutError when timeout is exceeded', async () => {
        const slowOperation = new Promise<string>((resolve) => {
          setTimeout(() => resolve('too late'), 5000);
        });

        const resultPromise = withTimeout(slowOperation, 1000);
        vi.advanceTimersByTime(1100);

        await expect(resultPromise).rejects.toThrow(ProcessingTimeoutError);
      });

      it('should include timeout value in error message', async () => {
        const slowOperation = new Promise<string>((resolve) => {
          setTimeout(() => resolve('too late'), 5000);
        });

        const resultPromise = withTimeout(slowOperation, 2500);
        vi.advanceTimersByTime(3000);

        try {
          await resultPromise;
          expect.fail('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(ProcessingTimeoutError);
          expect((error as Error).message).toContain('2500');
        }
      });

      it('should clear timeout when operation completes', async () => {
        const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

        const fastOperation = Promise.resolve('success');
        await withTimeout(fastOperation, 10000);

        expect(clearTimeoutSpy).toHaveBeenCalled();
        clearTimeoutSpy.mockRestore();
      });

      it('should use default timeout when not specified', async () => {
        const slowOperation = new Promise<string>((resolve) => {
          setTimeout(() => resolve('too late'), 35000);
        });

        const resultPromise = withTimeout(slowOperation);
        vi.advanceTimersByTime(30001); // Just over 30 seconds

        await expect(resultPromise).rejects.toThrow(ProcessingTimeoutError);
      });
    });
  });

  describe('Service Integration: ColorExtractorService', () => {
    it('should reject oversized images', async () => {
      const service = createColorExtractorService();
      const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB

      await expect(service.extractColors(largeBuffer)).rejects.toThrow(ImageSizeExceededError);
    });

    it('should accept properly sized images', async () => {
      const service = createColorExtractorService();
      const validImage = await createValidSmallImage();

      const result = await service.extractColors(validImage);
      expect(result).toBeDefined();
      expect(result.dominantColors).toBeDefined();
    });
  });

  describe('Service Integration: ThemeDetectorService', () => {
    it('should reject oversized images', async () => {
      const service = createThemeDetectorService();
      const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB

      await expect(service.detectTheme(largeBuffer)).rejects.toThrow(ImageSizeExceededError);
    });

    it('should accept properly sized images', async () => {
      const service = createThemeDetectorService();
      const validImage = await createValidSmallImage();

      const result = await service.detectTheme(validImage);
      expect(result).toBeDefined();
      expect(result.theme).toBeDefined();
    });
  });

  describe('Service Integration: DensityCalculatorService', () => {
    describe('calculateDensity', () => {
      it('should reject oversized images', async () => {
        const service = createDensityCalculatorService();
        const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB

        await expect(service.calculateDensity(largeBuffer)).rejects.toThrow(ImageSizeExceededError);
      });

      it('should accept properly sized images', async () => {
        const service = createDensityCalculatorService();
        const validImage = await createValidSmallImage();

        const result = await service.calculateDensity(validImage);
        expect(result).toBeDefined();
        expect(result.contentDensity).toBeDefined();
      });
    });

    describe('calculateWhitespace', () => {
      it('should reject oversized images', async () => {
        const service = createDensityCalculatorService();
        const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB

        await expect(service.calculateWhitespace(largeBuffer)).rejects.toThrow(ImageSizeExceededError);
      });
    });

    describe('analyzeRegions', () => {
      it('should reject oversized images', async () => {
        const service = createDensityCalculatorService();
        const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB

        await expect(service.analyzeRegions(largeBuffer)).rejects.toThrow(ImageSizeExceededError);
      });
    });
  });

  describe('Error Type Verification', () => {
    it('ImageSizeExceededError should have correct name', () => {
      const error = new ImageSizeExceededError(10 * 1024 * 1024);
      expect(error.name).toBe('ImageSizeExceededError');
    });

    it('ProcessingTimeoutError should have correct name', () => {
      const error = new ProcessingTimeoutError(30000);
      expect(error.name).toBe('ProcessingTimeoutError');
    });

    it('ImageSizeExceededError should be instanceof Error', () => {
      const error = new ImageSizeExceededError(10 * 1024 * 1024);
      expect(error).toBeInstanceOf(Error);
    });

    it('ProcessingTimeoutError should be instanceof Error', () => {
      const error = new ProcessingTimeoutError(30000);
      expect(error).toBeInstanceOf(Error);
    });
  });
});
