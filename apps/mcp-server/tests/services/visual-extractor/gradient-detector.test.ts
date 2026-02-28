// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gradient Detector Service Tests
 *
 * TDD Phase: Red
 * These tests define the expected behavior of the GradientDetectorService
 *
 * Test categories:
 * 1. Linear gradient detection (horizontal, vertical, diagonal)
 * 2. Radial gradient detection
 * 3. Conic gradient detection
 * 4. Multiple gradient detection
 * 5. No gradient (solid color) detection
 * 6. Edge cases (small images, large images)
 * 7. Error handling
 * 8. Performance
 *
 * @module tests/services/visual-extractor/gradient-detector.test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import type {
  GradientDetectorService} from '../../../src/services/visual-extractor/gradient-detector.service';
import {
  GradientDetectionResult,
  createGradientDetectorService,
} from '../../../src/services/visual-extractor/gradient-detector.service';

// Helper to create solid color test image
async function createSolidColorImage(
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

// Helper to create horizontal linear gradient image
async function createHorizontalGradientImage(
  width: number,
  height: number,
  startColor: { r: number; g: number; b: number },
  endColor: { r: number; g: number; b: number }
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = x / (width - 1);
      const pixelIndex = (y * width + x) * channels;
      data[pixelIndex] = Math.round(startColor.r + (endColor.r - startColor.r) * t);
      data[pixelIndex + 1] = Math.round(startColor.g + (endColor.g - startColor.g) * t);
      data[pixelIndex + 2] = Math.round(startColor.b + (endColor.b - startColor.b) * t);
    }
  }

  return sharp(data, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

// Helper to create vertical linear gradient image
async function createVerticalGradientImage(
  width: number,
  height: number,
  startColor: { r: number; g: number; b: number },
  endColor: { r: number; g: number; b: number }
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * channels;
      data[pixelIndex] = Math.round(startColor.r + (endColor.r - startColor.r) * t);
      data[pixelIndex + 1] = Math.round(startColor.g + (endColor.g - startColor.g) * t);
      data[pixelIndex + 2] = Math.round(startColor.b + (endColor.b - startColor.b) * t);
    }
  }

  return sharp(data, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

// Helper to create diagonal linear gradient image (any angle)
async function createDiagonalGradientImage(
  width: number,
  height: number,
  startColor: { r: number; g: number; b: number },
  endColor: { r: number; g: number; b: number },
  angle: number = 45
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  const radians = (angle * Math.PI) / 180;
  const cosA = Math.cos(radians);
  const sinA = Math.sin(radians);

  // Calculate distance along the gradient direction for all corners
  // and find the min/max to normalize properly for any angle
  const corners = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: 0, y: height - 1 },
    { x: width - 1, y: height - 1 },
  ];
  const distances = corners.map((c) => c.x * cosA + c.y * sinA);
  const minDist = Math.min(...distances);
  const maxDist = Math.max(...distances);
  const distRange = maxDist - minDist;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dist = x * cosA + y * sinA;
      // Normalize to 0-1 range based on actual min/max distances
      const t = distRange > 0 ? (dist - minDist) / distRange : 0;
      const pixelIndex = (y * width + x) * channels;
      data[pixelIndex] = Math.round(startColor.r + (endColor.r - startColor.r) * t);
      data[pixelIndex + 1] = Math.round(startColor.g + (endColor.g - startColor.g) * t);
      data[pixelIndex + 2] = Math.round(startColor.b + (endColor.b - startColor.b) * t);
    }
  }

  return sharp(data, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

// Helper to create radial gradient image
async function createRadialGradientImage(
  width: number,
  height: number,
  centerColor: { r: number; g: number; b: number },
  edgeColor: { r: number; g: number; b: number },
  centerX: number = 0.5,
  centerY: number = 0.5
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  const cx = width * centerX;
  const cy = height * centerY;
  const maxRadius = Math.sqrt(Math.pow(Math.max(cx, width - cx), 2) + Math.pow(Math.max(cy, height - cy), 2));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dist = Math.sqrt(Math.pow(x - cx, 2) + Math.pow(y - cy, 2));
      const t = Math.min(1, dist / maxRadius);
      const pixelIndex = (y * width + x) * channels;
      data[pixelIndex] = Math.round(centerColor.r + (edgeColor.r - centerColor.r) * t);
      data[pixelIndex + 1] = Math.round(centerColor.g + (edgeColor.g - centerColor.g) * t);
      data[pixelIndex + 2] = Math.round(centerColor.b + (edgeColor.b - centerColor.b) * t);
    }
  }

  return sharp(data, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

// Helper to create conic gradient image
async function createConicGradientImage(
  width: number,
  height: number,
  colors: Array<{ r: number; g: number; b: number }>,
  centerX: number = 0.5,
  centerY: number = 0.5
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  const cx = width * centerX;
  const cy = height * centerY;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let angle = Math.atan2(y - cy, x - cx);
      if (angle < 0) angle += 2 * Math.PI;
      const t = angle / (2 * Math.PI);

      // Interpolate between colors
      const segmentSize = 1 / colors.length;
      const segmentIndex = Math.min(Math.floor(t / segmentSize), colors.length - 1);
      const nextIndex = (segmentIndex + 1) % colors.length;
      const localT = (t - segmentIndex * segmentSize) / segmentSize;

      const color1 = colors[segmentIndex];
      const color2 = colors[nextIndex];

      const pixelIndex = (y * width + x) * channels;
      data[pixelIndex] = Math.round(color1.r + (color2.r - color1.r) * localT);
      data[pixelIndex + 1] = Math.round(color1.g + (color2.g - color1.g) * localT);
      data[pixelIndex + 2] = Math.round(color1.b + (color2.b - color1.b) * localT);
    }
  }

  return sharp(data, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

// Helper to create image with multiple gradient regions
async function createMultiGradientImage(
  width: number,
  height: number
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  const halfWidth = Math.floor(width / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * channels;

      if (x < halfWidth) {
        // Left half: horizontal gradient (red to blue)
        const t = x / halfWidth;
        data[pixelIndex] = Math.round(255 * (1 - t));
        data[pixelIndex + 1] = 0;
        data[pixelIndex + 2] = Math.round(255 * t);
      } else {
        // Right half: vertical gradient (green to yellow)
        const t = y / height;
        data[pixelIndex] = Math.round(255 * t);
        data[pixelIndex + 1] = 255;
        data[pixelIndex + 2] = 0;
      }
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

describe('GradientDetectorService', () => {
  let service: GradientDetectorService;

  beforeAll(() => {
    service = createGradientDetectorService();
  });

  describe('detectGradient', () => {
    // ==========================================
    // 1. Linear Gradient Detection - Horizontal
    // ==========================================
    describe('1. Horizontal Linear Gradient Detection', () => {
      it('should detect horizontal linear gradient from red to blue', async () => {
        const image = await createHorizontalGradientImage(
          200,
          100,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 }
        );

        const result = await service.detectGradient(image);

        expect(result).toBeDefined();
        expect(result.hasGradient).toBe(true);
        expect(result.gradients.length).toBeGreaterThanOrEqual(1);

        const gradient = result.gradients[0];
        expect(gradient.type).toBe('linear');
        // Horizontal gradient should be around 0 or 180 degrees
        expect(gradient.direction).toBeDefined();
        expect(
          Math.abs(gradient.direction!) < 15 ||
          Math.abs(gradient.direction! - 180) < 15
        ).toBe(true);
      });

      it('should detect horizontal linear gradient from white to black', async () => {
        const image = await createHorizontalGradientImage(
          200,
          100,
          { r: 255, g: 255, b: 255 },
          { r: 0, g: 0, b: 0 }
        );

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(true);
        expect(result.gradients.length).toBeGreaterThanOrEqual(1);
        expect(result.gradients[0].type).toBe('linear');
      });

      it('should extract color stops from horizontal gradient', async () => {
        const image = await createHorizontalGradientImage(
          200,
          100,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 255, b: 0 }
        );

        const result = await service.detectGradient(image);

        expect(result.gradients[0].colorStops).toBeDefined();
        expect(result.gradients[0].colorStops.length).toBeGreaterThanOrEqual(2);

        // Validate color stop format
        result.gradients[0].colorStops.forEach((stop) => {
          expect(isValidHexColor(stop.color)).toBe(true);
          expect(stop.position).toBeGreaterThanOrEqual(0);
          expect(stop.position).toBeLessThanOrEqual(1);
        });
      });
    });

    // ==========================================
    // 2. Linear Gradient Detection - Vertical
    // ==========================================
    describe('2. Vertical Linear Gradient Detection', () => {
      it('should detect vertical linear gradient from top to bottom', async () => {
        const image = await createVerticalGradientImage(
          100,
          200,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 }
        );

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(true);
        expect(result.gradients.length).toBeGreaterThanOrEqual(1);

        const gradient = result.gradients[0];
        expect(gradient.type).toBe('linear');
        // Vertical gradient should be around 90 or 270 degrees
        expect(gradient.direction).toBeDefined();
        expect(
          Math.abs(gradient.direction! - 90) < 15 ||
          Math.abs(gradient.direction! - 270) < 15
        ).toBe(true);
      });

      it('should detect vertical gradient with multiple colors', async () => {
        const channels = 3;
        const width = 100;
        const height = 300;
        const data = Buffer.alloc(width * height * channels);

        // Create 3-color gradient: red -> green -> blue
        for (let y = 0; y < height; y++) {
          const t = y / (height - 1);
          let r: number, g: number, b: number;

          if (t < 0.5) {
            const localT = t * 2;
            r = Math.round(255 * (1 - localT));
            g = Math.round(255 * localT);
            b = 0;
          } else {
            const localT = (t - 0.5) * 2;
            r = 0;
            g = Math.round(255 * (1 - localT));
            b = Math.round(255 * localT);
          }

          for (let x = 0; x < width; x++) {
            const pixelIndex = (y * width + x) * channels;
            data[pixelIndex] = r;
            data[pixelIndex + 1] = g;
            data[pixelIndex + 2] = b;
          }
        }

        const image = await sharp(data, {
          raw: { width, height, channels },
        })
          .png()
          .toBuffer();

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(true);
        expect(result.gradients[0].colorStops.length).toBeGreaterThanOrEqual(3);
      });
    });

    // ==========================================
    // 3. Linear Gradient Detection - Diagonal
    // ==========================================
    describe('3. Diagonal Linear Gradient Detection', () => {
      it('should detect 45-degree diagonal gradient', async () => {
        const image = await createDiagonalGradientImage(
          200,
          200,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 },
          45
        );

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(true);
        expect(result.gradients[0].type).toBe('linear');
        // Allow some tolerance for angle detection
        expect(result.gradients[0].direction).toBeDefined();
        expect(Math.abs(result.gradients[0].direction! - 45)).toBeLessThan(30);
      });

      it('should detect 135-degree diagonal gradient', async () => {
        const image = await createDiagonalGradientImage(
          200,
          200,
          { r: 0, g: 255, b: 0 },
          { r: 255, g: 0, b: 255 },
          135
        );

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(true);
        expect(result.gradients[0].type).toBe('linear');
        expect(result.gradients[0].direction).toBeDefined();
        expect(Math.abs(result.gradients[0].direction! - 135)).toBeLessThan(30);
      });

      it('should detect 225-degree diagonal gradient', async () => {
        const image = await createDiagonalGradientImage(
          200,
          200,
          { r: 255, g: 255, b: 0 },
          { r: 0, g: 255, b: 255 },
          225
        );

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(true);
        expect(result.gradients[0].type).toBe('linear');
      });
    });

    // ==========================================
    // 4. Radial Gradient Detection
    // ==========================================
    describe('4. Radial Gradient Detection', () => {
      it('should detect radial gradient centered in image', async () => {
        const image = await createRadialGradientImage(
          200,
          200,
          { r: 255, g: 255, b: 255 },
          { r: 0, g: 0, b: 0 },
          0.5,
          0.5
        );

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(true);
        expect(result.gradients.length).toBeGreaterThanOrEqual(1);

        const gradient = result.gradients[0];
        expect(gradient.type).toBe('radial');
        expect(gradient.centerX).toBeCloseTo(0.5, 1);
        expect(gradient.centerY).toBeCloseTo(0.5, 1);
      });

      it('should detect radial gradient with off-center point', async () => {
        const image = await createRadialGradientImage(
          200,
          200,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 },
          0.25,
          0.75
        );

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(true);
        expect(result.gradients[0].type).toBe('radial');
        expect(result.gradients[0].centerX).toBeDefined();
        expect(result.gradients[0].centerY).toBeDefined();
      });

      it('should extract color stops from radial gradient', async () => {
        const image = await createRadialGradientImage(
          200,
          200,
          { r: 255, g: 255, b: 0 },
          { r: 128, g: 0, b: 128 }
        );

        const result = await service.detectGradient(image);

        expect(result.gradients[0].colorStops.length).toBeGreaterThanOrEqual(2);
        result.gradients[0].colorStops.forEach((stop) => {
          expect(isValidHexColor(stop.color)).toBe(true);
        });
      });
    });

    // ==========================================
    // 5. Conic Gradient Detection
    // ==========================================
    describe('5. Conic Gradient Detection', () => {
      it('should detect conic gradient with 4 colors', async () => {
        const image = await createConicGradientImage(200, 200, [
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 255, b: 0 },
          { r: 0, g: 0, b: 255 },
          { r: 255, g: 255, b: 0 },
        ]);

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(true);
        expect(result.gradients.length).toBeGreaterThanOrEqual(1);
        expect(result.gradients[0].type).toBe('conic');
      });

      it('should detect conic gradient center position', async () => {
        const image = await createConicGradientImage(
          200,
          200,
          [
            { r: 255, g: 0, b: 0 },
            { r: 0, g: 255, b: 0 },
          ],
          0.5,
          0.5
        );

        const result = await service.detectGradient(image);

        expect(result.gradients[0].centerX).toBeDefined();
        expect(result.gradients[0].centerY).toBeDefined();
      });

      it('should detect conic gradient color stops', async () => {
        const image = await createConicGradientImage(200, 200, [
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 255, b: 0 },
          { r: 0, g: 0, b: 255 },
        ]);

        const result = await service.detectGradient(image);

        expect(result.gradients[0].colorStops.length).toBeGreaterThanOrEqual(3);
      });
    });

    // ==========================================
    // 6. Multiple Gradient Detection
    // ==========================================
    describe('6. Multiple Gradient Detection', () => {
      it('should detect multiple gradients in different regions', async () => {
        const image = await createMultiGradientImage(400, 200);

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(true);
        expect(result.gradients.length).toBeGreaterThanOrEqual(1);
      });

      it('should provide region information for each detected gradient', async () => {
        const image = await createMultiGradientImage(400, 200);

        const result = await service.detectGradient(image);

        result.gradients.forEach((gradient) => {
          expect(gradient.region).toBeDefined();
          expect(gradient.region.x).toBeGreaterThanOrEqual(0);
          expect(gradient.region.y).toBeGreaterThanOrEqual(0);
          expect(gradient.region.width).toBeGreaterThan(0);
          expect(gradient.region.height).toBeGreaterThan(0);
        });
      });
    });

    // ==========================================
    // 7. No Gradient (Solid Color) Detection
    // ==========================================
    describe('7. No Gradient (Solid Color) Detection', () => {
      it('should return hasGradient=false for solid red image', async () => {
        const image = await createSolidColorImage(100, 100, { r: 255, g: 0, b: 0 });

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(false);
        expect(result.gradients.length).toBe(0);
      });

      it('should return hasGradient=false for solid white image', async () => {
        const image = await createSolidColorImage(100, 100, { r: 255, g: 255, b: 255 });

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(false);
      });

      it('should return hasGradient=false for solid black image', async () => {
        const image = await createSolidColorImage(100, 100, { r: 0, g: 0, b: 0 });

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(false);
      });

      it('should return hasGradient=false for near-solid image with minimal variation', async () => {
        // Create image with very slight color variation (noise)
        const channels = 3;
        const width = 100;
        const height = 100;
        const data = Buffer.alloc(width * height * channels);

        for (let i = 0; i < data.length; i += channels) {
          data[i] = 128 + Math.floor(Math.random() * 4) - 2; // R: 126-130
          data[i + 1] = 128 + Math.floor(Math.random() * 4) - 2; // G: 126-130
          data[i + 2] = 128 + Math.floor(Math.random() * 4) - 2; // B: 126-130
        }

        const image = await sharp(data, {
          raw: { width, height, channels },
        })
          .png()
          .toBuffer();

        const result = await service.detectGradient(image);

        expect(result.hasGradient).toBe(false);
      });
    });

    // ==========================================
    // 8. Edge Cases - Small Images
    // ==========================================
    describe('8. Edge Cases - Small Images', () => {
      it('should handle 1x1 pixel image', async () => {
        const image = await createSolidColorImage(1, 1, { r: 255, g: 0, b: 0 });

        const result = await service.detectGradient(image);

        expect(result).toBeDefined();
        expect(result.hasGradient).toBe(false);
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      });

      it('should handle 2x2 pixel gradient image', async () => {
        const channels = 3;
        const width = 2;
        const height = 2;
        const data = Buffer.alloc(width * height * channels);

        // Top-left: red, Top-right: blue, Bottom-left: green, Bottom-right: yellow
        data[0] = 255; data[1] = 0; data[2] = 0; // Red
        data[3] = 0; data[4] = 0; data[5] = 255; // Blue
        data[6] = 0; data[7] = 255; data[8] = 0; // Green
        data[9] = 255; data[10] = 255; data[11] = 0; // Yellow

        const image = await sharp(data, {
          raw: { width, height, channels },
        })
          .png()
          .toBuffer();

        const result = await service.detectGradient(image);

        expect(result).toBeDefined();
        expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
      });

      it('should handle 10x10 pixel gradient image', async () => {
        const image = await createHorizontalGradientImage(
          10,
          10,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 }
        );

        const result = await service.detectGradient(image);

        expect(result).toBeDefined();
        expect(result.hasGradient).toBe(true);
      });
    });

    // ==========================================
    // 9. Edge Cases - Large Images
    // ==========================================
    describe('9. Edge Cases - Large Images', () => {
      it('should handle 1920x1080 gradient image', async () => {
        const image = await createHorizontalGradientImage(
          1920,
          1080,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 255, b: 0 }
        );

        const result = await service.detectGradient(image);

        expect(result).toBeDefined();
        expect(result.hasGradient).toBe(true);
      });

      it('should handle very wide image (3000x100)', async () => {
        const image = await createHorizontalGradientImage(
          3000,
          100,
          { r: 0, g: 0, b: 255 },
          { r: 255, g: 255, b: 0 }
        );

        const result = await service.detectGradient(image);

        expect(result).toBeDefined();
        expect(result.hasGradient).toBe(true);
      });

      it('should handle very tall image (100x3000)', async () => {
        const image = await createVerticalGradientImage(
          100,
          3000,
          { r: 255, g: 128, b: 0 },
          { r: 0, g: 128, b: 255 }
        );

        const result = await service.detectGradient(image);

        expect(result).toBeDefined();
        expect(result.hasGradient).toBe(true);
      });
    });

    // ==========================================
    // 10. Error Handling
    // ==========================================
    describe('10. Error Handling', () => {
      it('should throw error for null input', async () => {
        await expect(service.detectGradient(null as unknown as Buffer)).rejects.toThrow();
      });

      it('should throw error for undefined input', async () => {
        await expect(service.detectGradient(undefined as unknown as Buffer)).rejects.toThrow();
      });

      it('should throw error for empty buffer', async () => {
        const emptyBuffer = Buffer.alloc(0);
        await expect(service.detectGradient(emptyBuffer)).rejects.toThrow();
      });

      it('should throw error for invalid image data', async () => {
        const invalidData = Buffer.from('not an image');
        await expect(service.detectGradient(invalidData)).rejects.toThrow();
      });

      it('should throw error for invalid base64 string', async () => {
        const invalidBase64 = 'not-valid-base64!!!';
        await expect(service.detectGradient(invalidBase64)).rejects.toThrow();
      });

      it('should accept valid base64 encoded image', async () => {
        const image = await createHorizontalGradientImage(
          100,
          50,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 255, b: 0 }
        );
        const base64Image = image.toString('base64');

        const result = await service.detectGradient(base64Image);

        expect(result).toBeDefined();
        expect(result.hasGradient).toBe(true);
      });

      it('should accept base64 with data URL prefix', async () => {
        const image = await createHorizontalGradientImage(
          100,
          50,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 255, b: 0 }
        );
        const base64WithPrefix = `data:image/png;base64,${image.toString('base64')}`;

        const result = await service.detectGradient(base64WithPrefix);

        expect(result).toBeDefined();
        expect(result.hasGradient).toBe(true);
      });
    });

    // ==========================================
    // 11. Confidence Score Validation
    // ==========================================
    describe('11. Confidence Score Validation', () => {
      it('should return overall confidence between 0 and 1', async () => {
        const image = await createHorizontalGradientImage(
          200,
          100,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 }
        );

        const result = await service.detectGradient(image);

        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      });

      it('should return per-gradient confidence between 0 and 1', async () => {
        const image = await createRadialGradientImage(
          200,
          200,
          { r: 255, g: 255, b: 255 },
          { r: 0, g: 0, b: 0 }
        );

        const result = await service.detectGradient(image);

        result.gradients.forEach((gradient) => {
          expect(gradient.confidence).toBeGreaterThanOrEqual(0);
          expect(gradient.confidence).toBeLessThanOrEqual(1);
        });
      });

      it('should have higher confidence for clear gradients', async () => {
        const clearGradient = await createHorizontalGradientImage(
          200,
          100,
          { r: 0, g: 0, b: 0 },
          { r: 255, g: 255, b: 255 }
        );

        const result = await service.detectGradient(clearGradient);

        expect(result.confidence).toBeGreaterThan(0.7);
      });
    });

    // ==========================================
    // 12. Dominant Gradient Type
    // ==========================================
    describe('12. Dominant Gradient Type', () => {
      it('should identify linear as dominant type for linear gradient', async () => {
        const image = await createHorizontalGradientImage(
          200,
          100,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 }
        );

        const result = await service.detectGradient(image);

        expect(result.dominantGradientType).toBe('linear');
      });

      it('should identify radial as dominant type for radial gradient', async () => {
        const image = await createRadialGradientImage(
          200,
          200,
          { r: 255, g: 255, b: 255 },
          { r: 0, g: 0, b: 0 }
        );

        const result = await service.detectGradient(image);

        expect(result.dominantGradientType).toBe('radial');
      });

      it('should identify conic as dominant type for conic gradient', async () => {
        const image = await createConicGradientImage(200, 200, [
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 255, b: 0 },
          { r: 0, g: 0, b: 255 },
        ]);

        const result = await service.detectGradient(image);

        expect(result.dominantGradientType).toBe('conic');
      });

      it('should return undefined for no gradient', async () => {
        const image = await createSolidColorImage(100, 100, { r: 128, g: 128, b: 128 });

        const result = await service.detectGradient(image);

        expect(result.dominantGradientType).toBeUndefined();
      });
    });

    // ==========================================
    // 13. Processing Time
    // ==========================================
    describe('13. Processing Time', () => {
      it('should include processing time in result', async () => {
        const image = await createHorizontalGradientImage(
          200,
          100,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 }
        );

        const result = await service.detectGradient(image);

        expect(result.processingTimeMs).toBeDefined();
        expect(typeof result.processingTimeMs).toBe('number');
        expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
      });

      it('should process 200x100 image in less than 500ms', async () => {
        const image = await createHorizontalGradientImage(
          200,
          100,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 }
        );

        const result = await service.detectGradient(image);

        expect(result.processingTimeMs).toBeLessThan(500);
      });

      it('should process 1920x1080 image in less than 2000ms', async () => {
        const image = await createHorizontalGradientImage(
          1920,
          1080,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 255, b: 0 }
        );

        const result = await service.detectGradient(image);

        expect(result.processingTimeMs).toBeLessThan(2000);
      });
    });

    // ==========================================
    // 14. Color Stop Position Accuracy
    // ==========================================
    describe('14. Color Stop Position Accuracy', () => {
      it('should have start color stop at position 0', async () => {
        const image = await createHorizontalGradientImage(
          200,
          100,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 }
        );

        const result = await service.detectGradient(image);

        const firstStop = result.gradients[0].colorStops[0];
        expect(firstStop.position).toBeCloseTo(0, 1);
      });

      it('should have end color stop at position 1', async () => {
        const image = await createHorizontalGradientImage(
          200,
          100,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 }
        );

        const result = await service.detectGradient(image);

        const stops = result.gradients[0].colorStops;
        const lastStop = stops[stops.length - 1];
        expect(lastStop.position).toBeCloseTo(1, 1);
      });

      it('should have sorted color stop positions', async () => {
        const image = await createHorizontalGradientImage(
          200,
          100,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 }
        );

        const result = await service.detectGradient(image);

        const positions = result.gradients[0].colorStops.map((s) => s.position);
        for (let i = 1; i < positions.length; i++) {
          expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
        }
      });
    });

    // ==========================================
    // 15. Gradient Region Bounds
    // ==========================================
    describe('15. Gradient Region Bounds', () => {
      it('should have region bounds within image dimensions', async () => {
        const width = 200;
        const height = 100;
        const image = await createHorizontalGradientImage(
          width,
          height,
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 }
        );

        const result = await service.detectGradient(image);

        result.gradients.forEach((gradient) => {
          expect(gradient.region.x).toBeGreaterThanOrEqual(0);
          expect(gradient.region.y).toBeGreaterThanOrEqual(0);
          expect(gradient.region.x + gradient.region.width).toBeLessThanOrEqual(width);
          expect(gradient.region.y + gradient.region.height).toBeLessThanOrEqual(height);
        });
      });
    });
  });
});
