// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGL Detector Service
 *
 * Detects WebGL/3D libraries on web pages to optimize loading strategies.
 * Used to prevent timeouts on heavy WebGL sites like lbproject.dev.
 *
 * Features:
 * - Canvas element detection
 * - WebGL 1/2 context detection
 * - Library detection (Three.js, Babylon.js, PixiJS, A-Frame, p5.js, etc.)
 * - Heavy site classification
 * - Wait strategy recommendation
 *
 * @module services/page/webgl-detector.service
 */

import type { Page } from 'playwright';
import { createLogger, isDevelopment } from '../../utils/logger';

// =====================================================
// Types and Interfaces
// =====================================================

/**
 * Detected WebGL library names
 */
export type WebGLLibrary =
  | 'three.js'
  | 'babylon.js'
  | 'pixi.js'
  | 'a-frame'
  | 'p5.js'
  | 'playcanvas'
  | 'gsap'
  | 'lottie'
  | 'phaser'
  | 'unknown';

/**
 * Recommended wait strategy based on WebGL detection
 */
export type WaitStrategy = 'standard' | 'webgl-extended' | 'networkidle';

/**
 * WebGL detection result
 */
export interface WebGLDetectionResult {
  /** Whether WebGL context is available */
  hasWebGL: boolean;
  /** Whether canvas elements exist */
  hasCanvas: boolean;
  /** Number of canvas elements */
  canvasCount: number;
  /** Detected 3D/WebGL libraries */
  detectedLibraries: string[];
  /** WebGL version (1 or 2, null if not detected) */
  webglVersion: 1 | 2 | null;
  /** Whether the site is considered "heavy" (many assets, large canvases) */
  isHeavySite: boolean;
  /** Recommended wait strategy */
  recommendedWaitStrategy: WaitStrategy;
  /** Recommended timeout in milliseconds */
  recommendedTimeout: number;
  /** Time taken for detection in milliseconds */
  detectionTimeMs: number;
}

/**
 * Detection configuration defaults
 */
export const WEBGL_DETECTION_DEFAULTS = {
  /** Standard timeout for non-WebGL pages */
  standardTimeout: 30000,
  /** Extended timeout for WebGL pages */
  webglTimeout: 60000,
  /** Timeout for heavy sites with complex 3D content */
  heavySiteTimeout: 120000,
  /** Number of canvases to consider a site "heavy" */
  heavyCanvasThreshold: 3,
  /** Canvas size (width * height) to consider heavy */
  heavyCanvasSizeThreshold: 1000000, // 1000x1000
  /** Detection timeout */
  detectionTimeout: 5000,
} as const;

// =====================================================
// Logger
// =====================================================

const logger = createLogger('WebGLDetector');

// =====================================================
// Detection Script
// =====================================================

/**
 * Browser-side detection script (runs in page context)
 *
 * This script is evaluated inside the browser to detect WebGL capabilities
 * and libraries without requiring additional network requests.
 */
const DETECTION_SCRIPT = `(() => {
  const startTime = performance.now();
  const result = {
    hasWebGL: false,
    hasCanvas: false,
    canvasCount: 0,
    detectedLibraries: [],
    webglVersion: null,
    isHeavySite: false,
    recommendedWaitStrategy: 'standard',
    recommendedTimeout: ${WEBGL_DETECTION_DEFAULTS.standardTimeout},
    detectionTimeMs: 0,
  };

  try {
    // 1. Detect canvas elements
    const canvases = document.querySelectorAll('canvas');
    result.canvasCount = canvases.length;
    result.hasCanvas = canvases.length > 0;

    // 2. Check for WebGL context
    if (result.hasCanvas) {
      for (const canvas of canvases) {
        try {
          const gl2 = canvas.getContext('webgl2');
          if (gl2) {
            result.hasWebGL = true;
            result.webglVersion = 2;
            break;
          }
          const gl1 = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          if (gl1) {
            result.hasWebGL = true;
            result.webglVersion = 1;
            break;
          }
        } catch {
          // Context acquisition failed, continue checking other canvases
        }
      }
    }

    // 3. Detect WebGL/3D libraries
    const libraries = [];

    // Three.js
    if (typeof window.THREE !== 'undefined') {
      libraries.push('three.js');
    }

    // Babylon.js
    if (typeof window.BABYLON !== 'undefined') {
      libraries.push('babylon.js');
    }

    // PixiJS
    if (typeof window.PIXI !== 'undefined') {
      libraries.push('pixi.js');
    }

    // A-Frame (also uses Three.js internally)
    if (typeof window.AFRAME !== 'undefined' || document.querySelector('a-scene')) {
      libraries.push('a-frame');
    }

    // p5.js
    if (typeof window.p5 !== 'undefined') {
      libraries.push('p5.js');
    }

    // PlayCanvas
    if (typeof window.pc !== 'undefined') {
      libraries.push('playcanvas');
    }

    // GSAP (animation library often used with WebGL)
    if (typeof window.gsap !== 'undefined' || typeof window.TweenMax !== 'undefined') {
      libraries.push('gsap');
    }

    // Lottie (animation library)
    if (typeof window.lottie !== 'undefined' || typeof window.bodymovin !== 'undefined') {
      libraries.push('lottie');
    }

    // Phaser (2D/WebGL game engine)
    if (typeof window.Phaser !== 'undefined') {
      libraries.push('phaser');
    }

    result.detectedLibraries = libraries;

    // 4. Determine if site is "heavy"
    const is3DLibrary = libraries.some(lib =>
      ['three.js', 'babylon.js', 'a-frame', 'playcanvas'].includes(lib)
    );
    const hasLargeCanvas = Array.from(canvases).some(canvas => {
      const width = canvas.width || canvas.clientWidth;
      const height = canvas.height || canvas.clientHeight;
      return width * height >= ${WEBGL_DETECTION_DEFAULTS.heavyCanvasSizeThreshold};
    });
    const hasManyCanvases = result.canvasCount >= ${WEBGL_DETECTION_DEFAULTS.heavyCanvasThreshold};

    result.isHeavySite =
      (result.hasWebGL && is3DLibrary) ||
      hasManyCanvases ||
      (result.hasWebGL && hasLargeCanvas);

    // 5. Recommend wait strategy and timeout
    if (result.isHeavySite) {
      result.recommendedWaitStrategy = 'networkidle';
      result.recommendedTimeout = ${WEBGL_DETECTION_DEFAULTS.heavySiteTimeout};
    } else if (result.hasWebGL) {
      result.recommendedWaitStrategy = 'webgl-extended';
      result.recommendedTimeout = ${WEBGL_DETECTION_DEFAULTS.webglTimeout};
    } else {
      result.recommendedWaitStrategy = 'standard';
      result.recommendedTimeout = ${WEBGL_DETECTION_DEFAULTS.standardTimeout};
    }

  } catch (error) {
    // Detection failed, return safe defaults
    if (typeof console !== 'undefined') {
      console.warn('[WebGLDetector] Detection failed:', error);
    }
  }

  result.detectionTimeMs = performance.now() - startTime;
  return result;
})()`;

// =====================================================
// Service Class
// =====================================================

/**
 * WebGL Detector Service
 *
 * Detects WebGL capabilities and 3D libraries on web pages to optimize
 * loading strategies and prevent timeouts.
 *
 * @example
 * ```typescript
 * const detector = new WebGLDetectorService();
 * const result = await detector.detect(page);
 *
 * if (result.isHeavySite) {
 *   // Use extended timeout and networkidle wait strategy
 *   await page.goto(url, {
 *     timeout: result.recommendedTimeout,
 *     waitUntil: 'networkidle',
 *   });
 * }
 * ```
 */
export class WebGLDetectorService {
  /**
   * Detect WebGL capabilities and libraries on the page
   *
   * @param page - Playwright Page instance (after navigation)
   * @returns Detection result with recommendations
   */
  async detect(page: Page): Promise<WebGLDetectionResult> {
    const startTime = Date.now();

    try {
      if (isDevelopment()) {
        logger.debug('[WebGLDetector] Starting detection');
      }

      // Execute detection script in browser context
      const result = (await Promise.race([
        page.evaluate(DETECTION_SCRIPT) as Promise<WebGLDetectionResult>,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Detection timeout')),
            WEBGL_DETECTION_DEFAULTS.detectionTimeout
          )
        ),
      ])) as WebGLDetectionResult;

      if (isDevelopment()) {
        logger.debug('[WebGLDetector] Detection completed', {
          hasWebGL: result.hasWebGL,
          canvasCount: result.canvasCount,
          libraries: result.detectedLibraries,
          isHeavySite: result.isHeavySite,
          recommendedStrategy: result.recommendedWaitStrategy,
          detectionTimeMs: result.detectionTimeMs,
        });
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (isDevelopment()) {
        logger.warn('[WebGLDetector] Detection failed, using safe defaults', {
          error: errorMessage,
        });
      }

      // Return safe defaults on error
      return {
        hasWebGL: false,
        hasCanvas: false,
        canvasCount: 0,
        detectedLibraries: [],
        webglVersion: null,
        isHeavySite: false,
        recommendedWaitStrategy: 'standard',
        recommendedTimeout: WEBGL_DETECTION_DEFAULTS.standardTimeout,
        detectionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get the detection script for manual execution
   *
   * This is useful when you need to execute the detection script
   * at a specific timing or with custom handling.
   *
   * @returns JavaScript function string for browser evaluation
   */
  getDetectionScript(): string {
    return DETECTION_SCRIPT;
  }
}

// =====================================================
// Singleton Instance
// =====================================================

/**
 * Singleton instance of WebGLDetectorService
 */
let webglDetectorInstance: WebGLDetectorService | null = null;

/**
 * Get the WebGL detector service instance
 *
 * @returns WebGLDetectorService instance
 */
export function getWebGLDetectorService(): WebGLDetectorService {
  if (!webglDetectorInstance) {
    webglDetectorInstance = new WebGLDetectorService();
  }
  return webglDetectorInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetWebGLDetectorService(): void {
  webglDetectorInstance = null;
}
