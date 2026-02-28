// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gradient Detector Service Extended Tests (v0.1.0)
 *
 * TDD Phase: Red
 * These tests define the expected behavior for extended gradient detection features:
 * - cssString generation
 * - animation info detection
 * - transition info detection
 * - parentElement tracking
 *
 * @module tests/services/visual-extractor/gradient-detector-extended.test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import type {
  GradientDetectorService,
  DetectedGradient} from '../../../src/services/visual-extractor/gradient-detector.service';
import {
  createGradientDetectorService
} from '../../../src/services/visual-extractor/gradient-detector.service';

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

// Helper to create radial gradient image
async function createRadialGradientImage(
  width: number,
  height: number,
  centerColor: { r: number; g: number; b: number },
  edgeColor: { r: number; g: number; b: number }
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.sqrt(Math.pow(cx, 2) + Math.pow(cy, 2));

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

describe('GradientDetectorService Extended Features (v0.1.0)', () => {
  let service: GradientDetectorService;

  beforeAll(() => {
    service = createGradientDetectorService();
  });

  describe('1. CSS String Generation', () => {
    it('should generate cssString for linear gradient', async () => {
      const image = await createHorizontalGradientImage(
        200,
        100,
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 0, b: 255 }
      );

      const result = await service.detectGradient(image);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients.length).toBeGreaterThan(0);

      const gradient = result.gradients[0] as DetectedGradient;
      expect(gradient.cssString).toBeDefined();
      expect(gradient.cssString).toMatch(/linear-gradient\(/);
      expect(gradient.cssString).toContain('#');
    });

    it('should generate valid CSS gradient syntax', async () => {
      const image = await createHorizontalGradientImage(
        200,
        100,
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 255, b: 0 }
      );

      const result = await service.detectGradient(image);

      const gradient = result.gradients[0] as DetectedGradient;
      // CSS gradient should follow format: linear-gradient(angle, color1 pos1, color2 pos2, ...)
      expect(gradient.cssString).toMatch(
        /^(linear|radial|conic)-gradient\([^)]+\)$/
      );
    });

    it('should generate cssString for radial gradient', async () => {
      const image = await createRadialGradientImage(
        200,
        200,
        { r: 255, g: 255, b: 255 },
        { r: 0, g: 0, b: 0 }
      );

      const result = await service.detectGradient(image);

      expect(result.gradients[0]?.cssString).toMatch(/radial-gradient\(/);
    });

    it('should include color stops with positions in cssString', async () => {
      const image = await createHorizontalGradientImage(
        200,
        100,
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 0, b: 255 }
      );

      const result = await service.detectGradient(image);

      const cssString = result.gradients[0]?.cssString;
      // Should contain percentage positions like "0%", "100%"
      expect(cssString).toMatch(/\d+%/);
    });

    it('should generate cssString with correct angle for diagonal gradient', async () => {
      const channels = 3;
      const width = 200;
      const height = 200;
      const data = Buffer.alloc(width * height * channels);

      // 45-degree diagonal gradient
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const t = (x + y) / (width + height - 2);
          const pixelIndex = (y * width + x) * channels;
          data[pixelIndex] = Math.round(255 * (1 - t));
          data[pixelIndex + 1] = 0;
          data[pixelIndex + 2] = Math.round(255 * t);
        }
      }

      const image = await sharp(data, {
        raw: { width, height, channels },
      })
        .png()
        .toBuffer();

      const result = await service.detectGradient(image);

      const cssString = result.gradients[0]?.cssString;
      // Should contain angle like "45deg" or "135deg"
      expect(cssString).toMatch(/linear-gradient\(\d+deg/);
    });
  });

  describe('2. Animation Info Detection', () => {
    it('should detect animation info from CSS context', () => {
      const css = `
        .gradient-bg {
          background: linear-gradient(90deg, #ff0000, #0000ff);
          animation: gradient-shift 3s ease infinite;
        }
        @keyframes gradient-shift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0]?.animation).toBeDefined();
      expect(result.gradients[0]?.animation?.name).toBe('gradient-shift');
      expect(result.gradients[0]?.animation?.duration).toBe('3s');
      expect(result.gradients[0]?.animation?.timingFunction).toBe('ease');
      expect(result.gradients[0]?.animation?.iterationCount).toBe('infinite');
    });

    it('should detect animation with multiple properties', () => {
      const css = `
        .animated-gradient {
          background: linear-gradient(to right, #667eea 0%, #764ba2 100%);
          animation-name: pulse;
          animation-duration: 2s;
          animation-timing-function: ease-in-out;
          animation-iteration-count: infinite;
          animation-direction: alternate;
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0]?.animation?.name).toBe('pulse');
      expect(result.gradients[0]?.animation?.duration).toBe('2s');
      expect(result.gradients[0]?.animation?.direction).toBe('alternate');
    });

    it('should return undefined animation for static gradients', () => {
      const css = `
        .static-gradient {
          background: linear-gradient(90deg, #ff0000, #0000ff);
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0]?.animation).toBeUndefined();
    });
  });

  describe('3. Transition Info Detection', () => {
    it('should detect transition info from CSS context', () => {
      const css = `
        .gradient-button {
          background: linear-gradient(90deg, #3b82f6, #8b5cf6);
          transition: background 0.3s ease;
        }
        .gradient-button:hover {
          background: linear-gradient(90deg, #8b5cf6, #3b82f6);
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0]?.transition).toBeDefined();
      expect(result.gradients[0]?.transition?.property).toBe('background');
      expect(result.gradients[0]?.transition?.duration).toBe('0.3s');
      expect(result.gradients[0]?.transition?.timingFunction).toBe('ease');
    });

    it('should detect transition with multiple properties', () => {
      const css = `
        .fancy-gradient {
          background: radial-gradient(circle, #fff, #000);
          transition-property: background, opacity;
          transition-duration: 0.5s, 0.3s;
          transition-timing-function: ease-out;
          transition-delay: 0s, 0.1s;
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0]?.transition?.property).toContain('background');
      expect(result.gradients[0]?.transition?.duration).toBe('0.5s');
    });

    it('should return undefined transition for non-transitioning gradients', () => {
      const css = `
        .no-transition {
          background: linear-gradient(to bottom, #eee, #fff);
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0]?.transition).toBeUndefined();
    });
  });

  describe('4. Parent Element Tracking', () => {
    it('should track parent element selector', () => {
      const css = `
        .hero-section .gradient-overlay {
          background: linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0.8));
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0]?.parentElement).toBe('.hero-section .gradient-overlay');
    });

    it('should track multiple selectors', () => {
      const css = `
        header, footer {
          background: linear-gradient(90deg, #1a1a2e, #16213e);
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0]?.parentElement).toBe('header, footer');
    });

    it('should track pseudo-element selectors', () => {
      const css = `
        .card::before {
          background: linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.1) 50%);
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0]?.parentElement).toBe('.card::before');
    });

    it('should track ID selectors', () => {
      const css = `
        #main-banner {
          background: linear-gradient(to right, #667eea 0%, #764ba2 100%);
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0]?.parentElement).toBe('#main-banner');
    });
  });

  describe('5. detectGradientFromCSS method', () => {
    it('should extract gradients from CSS text', () => {
      const css = `
        .card {
          background: linear-gradient(180deg, #ffffff 0%, #f5f5f5 100%);
        }
        .button {
          background-image: radial-gradient(circle, #3b82f6, #1d4ed8);
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients.length).toBe(2);
    });

    it('should extract multiple gradients from single property', () => {
      const css = `
        .overlay {
          background: linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5)),
                      radial-gradient(ellipse at center, #fff 0%, transparent 70%);
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients.length).toBe(2);
    });

    it('should handle CSS variables in gradients', () => {
      const css = `
        .themed {
          background: linear-gradient(var(--gradient-angle), var(--color-start), var(--color-end));
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0]?.cssString).toContain('var(--');
    });

    it('should handle conic-gradient', () => {
      const css = `
        .pie-chart {
          background: conic-gradient(#ff0000 0% 25%, #00ff00 25% 50%, #0000ff 50% 75%, #ffff00 75% 100%);
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0]?.type).toBe('conic');
    });

    it('should handle repeating gradients', () => {
      const css = `
        .striped {
          background: repeating-linear-gradient(45deg, #606dbc, #606dbc 10px, #465298 10px, #465298 20px);
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0]?.cssString).toContain('repeating-linear-gradient');
    });

    it('should return empty result for CSS without gradients', () => {
      const css = `
        .no-gradient {
          background-color: #ffffff;
          color: #333333;
        }
      `;

      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(false);
      expect(result.gradients).toHaveLength(0);
    });

    it('should handle empty CSS input', () => {
      const result = service.detectGradientFromCSS('');

      expect(result.hasGradient).toBe(false);
      expect(result.gradients).toHaveLength(0);
    });

    it('should handle null/undefined CSS input', () => {
      expect(() => service.detectGradientFromCSS(null as unknown as string)).not.toThrow();
      expect(() => service.detectGradientFromCSS(undefined as unknown as string)).not.toThrow();
    });
  });

  describe('6. Extended Result Structure', () => {
    it('should include all extended fields in DetectedGradient', async () => {
      const image = await createHorizontalGradientImage(
        200,
        100,
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 0, b: 255 }
      );

      const result = await service.detectGradient(image);

      const gradient = result.gradients[0];

      // Required fields (existing)
      expect(gradient.type).toBeDefined();
      expect(gradient.colorStops).toBeDefined();
      expect(gradient.region).toBeDefined();
      expect(gradient.confidence).toBeDefined();

      // New extended field (always present for image detection)
      expect(gradient.cssString).toBeDefined();

      // Optional extended fields (may be undefined for image-only detection)
      // These are populated when CSS context is available
      expect('animation' in gradient || gradient.animation === undefined).toBe(true);
      expect('transition' in gradient || gradient.transition === undefined).toBe(true);
      expect('parentElement' in gradient || gradient.parentElement === undefined).toBe(true);
    });
  });
});
