// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGL Detector Service Tests
 *
 * TDD approach: Tests written first to define expected behavior
 * Detects WebGL/3D libraries to optimize page loading strategy
 *
 * @module tests/services/page/webgl-detector.service
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Page } from 'playwright';
import {
  WebGLDetectorService,
  type WebGLDetectionResult,
  type WebGLLibrary,
  WEBGL_DETECTION_DEFAULTS,
} from '../../../src/services/page/webgl-detector.service';

// =====================================================
// Test Fixtures
// =====================================================

/**
 * Create a mock Playwright Page object
 */
function createMockPage(evaluateResult: Partial<WebGLDetectionResult> = {}): Page {
  const defaultResult: WebGLDetectionResult = {
    hasWebGL: false,
    hasCanvas: false,
    canvasCount: 0,
    detectedLibraries: [],
    webglVersion: null,
    isHeavySite: false,
    recommendedWaitStrategy: 'standard',
    recommendedTimeout: WEBGL_DETECTION_DEFAULTS.standardTimeout,
    detectionTimeMs: 10,
    ...evaluateResult,
  };

  return {
    evaluate: vi.fn().mockResolvedValue(defaultResult),
  } as unknown as Page;
}

// =====================================================
// Test Suites
// =====================================================

describe('WebGLDetectorService', () => {
  let service: WebGLDetectorService;

  beforeEach(() => {
    service = new WebGLDetectorService();
  });

  describe('constructor', () => {
    it('should create service instance', () => {
      expect(service).toBeInstanceOf(WebGLDetectorService);
    });
  });

  describe('detect()', () => {
    describe('Basic Detection', () => {
      it('should detect page without WebGL', async () => {
        const mockPage = createMockPage({
          hasWebGL: false,
          hasCanvas: false,
          canvasCount: 0,
          detectedLibraries: [],
          webglVersion: null,
        });

        const result = await service.detect(mockPage);

        expect(result.hasWebGL).toBe(false);
        expect(result.hasCanvas).toBe(false);
        expect(result.canvasCount).toBe(0);
        expect(result.detectedLibraries).toEqual([]);
        expect(result.webglVersion).toBeNull();
      });

      it('should detect page with Canvas but no WebGL', async () => {
        const mockPage = createMockPage({
          hasWebGL: false,
          hasCanvas: true,
          canvasCount: 2,
          detectedLibraries: [],
          webglVersion: null,
        });

        const result = await service.detect(mockPage);

        expect(result.hasWebGL).toBe(false);
        expect(result.hasCanvas).toBe(true);
        expect(result.canvasCount).toBe(2);
      });

      it('should detect WebGL 1 context', async () => {
        const mockPage = createMockPage({
          hasWebGL: true,
          hasCanvas: true,
          canvasCount: 1,
          webglVersion: 1,
        });

        const result = await service.detect(mockPage);

        expect(result.hasWebGL).toBe(true);
        expect(result.webglVersion).toBe(1);
      });

      it('should detect WebGL 2 context', async () => {
        const mockPage = createMockPage({
          hasWebGL: true,
          hasCanvas: true,
          canvasCount: 1,
          webglVersion: 2,
        });

        const result = await service.detect(mockPage);

        expect(result.hasWebGL).toBe(true);
        expect(result.webglVersion).toBe(2);
      });
    });

    describe('Library Detection', () => {
      it('should detect Three.js', async () => {
        const mockPage = createMockPage({
          hasWebGL: true,
          hasCanvas: true,
          canvasCount: 1,
          detectedLibraries: ['three.js'],
          webglVersion: 2,
        });

        const result = await service.detect(mockPage);

        expect(result.detectedLibraries).toContain('three.js');
      });

      it('should detect Babylon.js', async () => {
        const mockPage = createMockPage({
          hasWebGL: true,
          hasCanvas: true,
          canvasCount: 1,
          detectedLibraries: ['babylon.js'],
          webglVersion: 2,
        });

        const result = await service.detect(mockPage);

        expect(result.detectedLibraries).toContain('babylon.js');
      });

      it('should detect PixiJS', async () => {
        const mockPage = createMockPage({
          hasWebGL: true,
          hasCanvas: true,
          canvasCount: 1,
          detectedLibraries: ['pixi.js'],
          webglVersion: 2,
        });

        const result = await service.detect(mockPage);

        expect(result.detectedLibraries).toContain('pixi.js');
      });

      it('should detect A-Frame', async () => {
        const mockPage = createMockPage({
          hasWebGL: true,
          hasCanvas: true,
          canvasCount: 1,
          detectedLibraries: ['a-frame'],
          webglVersion: 2,
        });

        const result = await service.detect(mockPage);

        expect(result.detectedLibraries).toContain('a-frame');
      });

      it('should detect p5.js', async () => {
        const mockPage = createMockPage({
          hasWebGL: true,
          hasCanvas: true,
          canvasCount: 1,
          detectedLibraries: ['p5.js'],
          webglVersion: 1,
        });

        const result = await service.detect(mockPage);

        expect(result.detectedLibraries).toContain('p5.js');
      });

      it('should detect PlayCanvas', async () => {
        const mockPage = createMockPage({
          hasWebGL: true,
          hasCanvas: true,
          canvasCount: 1,
          detectedLibraries: ['playcanvas'],
          webglVersion: 2,
        });

        const result = await service.detect(mockPage);

        expect(result.detectedLibraries).toContain('playcanvas');
      });

      it('should detect multiple libraries', async () => {
        const mockPage = createMockPage({
          hasWebGL: true,
          hasCanvas: true,
          canvasCount: 2,
          detectedLibraries: ['three.js', 'gsap'],
          webglVersion: 2,
        });

        const result = await service.detect(mockPage);

        expect(result.detectedLibraries).toContain('three.js');
        expect(result.detectedLibraries).toContain('gsap');
        expect(result.detectedLibraries).toHaveLength(2);
      });
    });

    describe('Heavy Site Detection', () => {
      it('should detect heavy site with many canvases', async () => {
        const mockPage = createMockPage({
          hasWebGL: true,
          hasCanvas: true,
          canvasCount: 5,
          detectedLibraries: ['three.js'],
          webglVersion: 2,
          isHeavySite: true,
        });

        const result = await service.detect(mockPage);

        expect(result.isHeavySite).toBe(true);
      });

      it('should detect heavy site with WebGL 2 + 3D library', async () => {
        const mockPage = createMockPage({
          hasWebGL: true,
          hasCanvas: true,
          canvasCount: 1,
          detectedLibraries: ['three.js'],
          webglVersion: 2,
          isHeavySite: true,
        });

        const result = await service.detect(mockPage);

        expect(result.isHeavySite).toBe(true);
      });

      it('should not mark simple 2D canvas as heavy', async () => {
        const mockPage = createMockPage({
          hasWebGL: false,
          hasCanvas: true,
          canvasCount: 1,
          detectedLibraries: [],
          webglVersion: null,
          isHeavySite: false,
        });

        const result = await service.detect(mockPage);

        expect(result.isHeavySite).toBe(false);
      });
    });

    describe('Wait Strategy Recommendation', () => {
      it('should recommend standard strategy for non-WebGL pages', async () => {
        const mockPage = createMockPage({
          hasWebGL: false,
          hasCanvas: false,
          canvasCount: 0,
          recommendedWaitStrategy: 'standard',
          recommendedTimeout: WEBGL_DETECTION_DEFAULTS.standardTimeout,
        });

        const result = await service.detect(mockPage);

        expect(result.recommendedWaitStrategy).toBe('standard');
        expect(result.recommendedTimeout).toBe(WEBGL_DETECTION_DEFAULTS.standardTimeout);
      });

      it('should recommend webgl-extended strategy for WebGL pages', async () => {
        const mockPage = createMockPage({
          hasWebGL: true,
          hasCanvas: true,
          canvasCount: 1,
          detectedLibraries: ['three.js'],
          webglVersion: 2,
          recommendedWaitStrategy: 'webgl-extended',
          recommendedTimeout: WEBGL_DETECTION_DEFAULTS.webglTimeout,
        });

        const result = await service.detect(mockPage);

        expect(result.recommendedWaitStrategy).toBe('webgl-extended');
        expect(result.recommendedTimeout).toBe(WEBGL_DETECTION_DEFAULTS.webglTimeout);
      });

      it('should recommend networkidle for heavy sites', async () => {
        const mockPage = createMockPage({
          hasWebGL: true,
          hasCanvas: true,
          canvasCount: 10,
          detectedLibraries: ['three.js', 'gsap'],
          webglVersion: 2,
          isHeavySite: true,
          recommendedWaitStrategy: 'networkidle',
          recommendedTimeout: WEBGL_DETECTION_DEFAULTS.heavySiteTimeout,
        });

        const result = await service.detect(mockPage);

        expect(result.recommendedWaitStrategy).toBe('networkidle');
        expect(result.recommendedTimeout).toBe(WEBGL_DETECTION_DEFAULTS.heavySiteTimeout);
      });
    });

    describe('Error Handling', () => {
      it('should handle page.evaluate errors gracefully', async () => {
        const mockPage = {
          evaluate: vi.fn().mockRejectedValue(new Error('Evaluation failed')),
        } as unknown as Page;

        const result = await service.detect(mockPage);

        // Should return safe defaults on error
        expect(result.hasWebGL).toBe(false);
        expect(result.hasCanvas).toBe(false);
        expect(result.detectedLibraries).toEqual([]);
        expect(result.recommendedWaitStrategy).toBe('standard');
      });

      it('should handle timeout during detection', async () => {
        const mockPage = {
          evaluate: vi.fn().mockImplementation(
            () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100))
          ),
        } as unknown as Page;

        const result = await service.detect(mockPage);

        expect(result.hasWebGL).toBe(false);
        expect(result.recommendedWaitStrategy).toBe('standard');
      });
    });

    describe('Detection Timing', () => {
      it('should include detection time in result', async () => {
        const mockPage = createMockPage({
          detectionTimeMs: 15,
        });

        const result = await service.detect(mockPage);

        expect(result.detectionTimeMs).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe('getDetectionScript()', () => {
    it('should return a valid JavaScript function string', () => {
      const script = service.getDetectionScript();

      expect(typeof script).toBe('string');
      expect(script.length).toBeGreaterThan(0);
      // Should start with opening parenthesis (IIFE or arrow function)
      expect(script.startsWith('(')).toBe(true);
    });
  });

  describe('WEBGL_DETECTION_DEFAULTS', () => {
    it('should have reasonable timeout values', () => {
      expect(WEBGL_DETECTION_DEFAULTS.standardTimeout).toBeGreaterThan(0);
      expect(WEBGL_DETECTION_DEFAULTS.webglTimeout).toBeGreaterThan(
        WEBGL_DETECTION_DEFAULTS.standardTimeout
      );
      expect(WEBGL_DETECTION_DEFAULTS.heavySiteTimeout).toBeGreaterThan(
        WEBGL_DETECTION_DEFAULTS.webglTimeout
      );
    });

    it('should have valid canvas count thresholds', () => {
      expect(WEBGL_DETECTION_DEFAULTS.heavyCanvasThreshold).toBeGreaterThan(0);
    });
  });
});

describe('WebGLDetectorService Integration Scenarios', () => {
  let service: WebGLDetectorService;

  beforeEach(() => {
    service = new WebGLDetectorService();
  });

  describe('Real-world Site Patterns', () => {
    it('should handle lbproject.dev-like site (Three.js + heavy assets)', async () => {
      const mockPage = createMockPage({
        hasWebGL: true,
        hasCanvas: true,
        canvasCount: 1,
        detectedLibraries: ['three.js', 'gsap'],
        webglVersion: 2,
        isHeavySite: true,
        recommendedWaitStrategy: 'networkidle',
        recommendedTimeout: WEBGL_DETECTION_DEFAULTS.heavySiteTimeout,
      });

      const result = await service.detect(mockPage);

      expect(result.hasWebGL).toBe(true);
      expect(result.detectedLibraries).toContain('three.js');
      expect(result.isHeavySite).toBe(true);
      expect(result.recommendedWaitStrategy).toBe('networkidle');
      expect(result.recommendedTimeout).toBeGreaterThanOrEqual(120000);
    });

    it('should handle simple portfolio site with basic Canvas', async () => {
      const mockPage = createMockPage({
        hasWebGL: false,
        hasCanvas: true,
        canvasCount: 1,
        detectedLibraries: [],
        webglVersion: null,
        isHeavySite: false,
        recommendedWaitStrategy: 'standard',
        recommendedTimeout: WEBGL_DETECTION_DEFAULTS.standardTimeout,
      });

      const result = await service.detect(mockPage);

      expect(result.hasWebGL).toBe(false);
      expect(result.hasCanvas).toBe(true);
      expect(result.isHeavySite).toBe(false);
      expect(result.recommendedWaitStrategy).toBe('standard');
    });

    it('should handle A-Frame VR site', async () => {
      const mockPage = createMockPage({
        hasWebGL: true,
        hasCanvas: true,
        canvasCount: 1,
        detectedLibraries: ['a-frame', 'three.js'],
        webglVersion: 2,
        isHeavySite: true,
        recommendedWaitStrategy: 'networkidle',
        recommendedTimeout: WEBGL_DETECTION_DEFAULTS.heavySiteTimeout,
      });

      const result = await service.detect(mockPage);

      expect(result.detectedLibraries).toContain('a-frame');
      expect(result.detectedLibraries).toContain('three.js');
      expect(result.isHeavySite).toBe(true);
    });

    it('should handle PixiJS game site', async () => {
      const mockPage = createMockPage({
        hasWebGL: true,
        hasCanvas: true,
        canvasCount: 1,
        detectedLibraries: ['pixi.js'],
        webglVersion: 2,
        isHeavySite: false,
        recommendedWaitStrategy: 'webgl-extended',
        recommendedTimeout: WEBGL_DETECTION_DEFAULTS.webglTimeout,
      });

      const result = await service.detect(mockPage);

      expect(result.detectedLibraries).toContain('pixi.js');
      expect(result.recommendedWaitStrategy).toBe('webgl-extended');
    });
  });
});
