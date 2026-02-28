// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visual Extractors Integration Utilities
 *
 * Integrates CSSVariableExtractor, TypographyExtractor, and GradientDetector services
 * into the layout.inspect tool.
 *
 * @module tools/layout/inspect/visual-extractors.utils
 */

import {
  createCSSVariableExtractorService,
  type CSSVariableExtractionResult,
} from '../../../services/visual/css-variable-extractor.service';
import {
  createTypographyExtractorService,
  type TypographyExtractionResult,
} from '../../../services/visual/typography-extractor.service';
import {
  createGradientDetectorService,
  type GradientDetectionResult,
} from '../../../services/visual-extractor/gradient-detector.service';
import { createLogger, isDevelopment } from '../../../utils/logger';

// =====================================================
// Logger
// =====================================================

const logger = createLogger('visual-extractors');

// =====================================================
// Service instances (lazy initialization)
// =====================================================

let cssVariableExtractor: ReturnType<typeof createCSSVariableExtractorService> | null = null;
let typographyExtractor: ReturnType<typeof createTypographyExtractorService> | null = null;
let gradientDetector: ReturnType<typeof createGradientDetectorService> | null = null;

/**
 * Get or create CSS Variable Extractor service instance
 */
function getCSSVariableExtractor(): ReturnType<typeof createCSSVariableExtractorService> {
  if (!cssVariableExtractor) {
    cssVariableExtractor = createCSSVariableExtractorService();
  }
  return cssVariableExtractor;
}

/**
 * Get or create Typography Extractor service instance
 */
function getTypographyExtractor(): ReturnType<typeof createTypographyExtractorService> {
  if (!typographyExtractor) {
    typographyExtractor = createTypographyExtractorService();
  }
  return typographyExtractor;
}

/**
 * Get or create Gradient Detector service instance
 */
function getGradientDetector(): ReturnType<typeof createGradientDetectorService> {
  if (!gradientDetector) {
    gradientDetector = createGradientDetectorService();
  }
  return gradientDetector;
}

// =====================================================
// Combined extraction result
// =====================================================

/**
 * Combined visual extraction result
 */
export interface VisualExtractionResult {
  /** CSS variable extraction results */
  cssVariables?: CSSVariableExtractionResult;
  /** Typography extraction results */
  typography?: TypographyExtractionResult;
  /** Gradient detection results */
  gradients?: GradientDetectionResult;
  /** Overall processing time */
  totalProcessingTimeMs: number;
}

// =====================================================
// Extraction options
// =====================================================

/**
 * Options for visual extraction
 */
export interface VisualExtractionOptions {
  /** Extract CSS variables (default: true) */
  extractCSSVariables?: boolean;
  /** Extract typography (default: true) */
  extractTypography?: boolean;
  /** Detect gradients from CSS (default: true) */
  detectGradients?: boolean;
  /** External CSS content (optional) */
  externalCss?: string;
}

// =====================================================
// Main extraction functions
// =====================================================

/**
 * Extract all visual features from HTML content
 *
 * Runs CSS Variable Extractor, Typography Extractor, and Gradient Detector
 * in parallel for optimal performance.
 *
 * @param html - HTML content to analyze
 * @param options - Extraction options
 * @returns Combined visual extraction result
 */
export async function extractVisualFeatures(
  html: string,
  options: VisualExtractionOptions = {}
): Promise<VisualExtractionResult> {
  const startTime = Date.now();

  const {
    extractCSSVariables = true,
    extractTypography = true,
    detectGradients = true,
    externalCss,
  } = options;

  const result: VisualExtractionResult = {
    totalProcessingTimeMs: 0,
  };

  const promises: Promise<void>[] = [];

  // CSS Variable extraction
  if (extractCSSVariables) {
    promises.push(
      (async (): Promise<void> => {
        try {
          const extractor = getCSSVariableExtractor();
          result.cssVariables = externalCss
            ? extractor.extract(html, externalCss)
            : extractor.extractFromHTML(html);

          if (isDevelopment()) {
            logger.debug('CSS Variables extracted', {
              count: result.cssVariables.variables.length,
              timeMs: result.cssVariables.processingTimeMs,
            });
          }
        } catch (error) {
          if (isDevelopment()) {
            logger.error('CSS Variable extraction failed', { error });
          }
        }
      })()
    );
  }

  // Typography extraction
  if (extractTypography) {
    promises.push(
      (async (): Promise<void> => {
        try {
          const extractor = getTypographyExtractor();
          result.typography = externalCss
            ? extractor.extract(html, externalCss)
            : extractor.extractFromHTML(html);

          if (isDevelopment()) {
            logger.debug('Typography extracted', {
              fontFamilies: result.typography.fontFamilies.length,
              styles: result.typography.styles.length,
              timeMs: result.typography.processingTimeMs,
            });
          }
        } catch (error) {
          if (isDevelopment()) {
            logger.error('Typography extraction failed', { error });
          }
        }
      })()
    );
  }

  // Gradient detection from CSS
  if (detectGradients) {
    promises.push(
      (async (): Promise<void> => {
        try {
          const detector = getGradientDetector();
          // Extract CSS from HTML for gradient detection
          const css = extractCSSFromHTML(html) + (externalCss ?? '');
          result.gradients = detector.detectGradientFromCSS(css);

          if (isDevelopment()) {
            logger.debug('Gradients detected', {
              hasGradient: result.gradients.hasGradient,
              count: result.gradients.gradients.length,
            });
          }
        } catch (error) {
          if (isDevelopment()) {
            logger.error('Gradient detection failed', { error });
          }
        }
      })()
    );
  }

  // Wait for all extractions to complete
  await Promise.all(promises);

  result.totalProcessingTimeMs = Date.now() - startTime;

  if (isDevelopment()) {
    logger.info('Visual extraction completed', {
      totalTimeMs: result.totalProcessingTimeMs,
      cssVariables: result.cssVariables?.variables.length ?? 0,
      typography: result.typography?.fontFamilies.length ?? 0,
      gradients: result.gradients?.gradients.length ?? 0,
    });
  }

  return result;
}

/**
 * Extract CSS Variables from HTML
 *
 * @param html - HTML content
 * @param externalCss - Optional external CSS
 * @returns CSS Variable extraction result
 */
export function extractCSSVariables(
  html: string,
  externalCss?: string
): CSSVariableExtractionResult {
  const extractor = getCSSVariableExtractor();
  return externalCss
    ? extractor.extract(html, externalCss)
    : extractor.extractFromHTML(html);
}

/**
 * Extract Typography from HTML
 *
 * @param html - HTML content
 * @param externalCss - Optional external CSS
 * @returns Typography extraction result
 */
export function extractTypographyFeatures(
  html: string,
  externalCss?: string
): TypographyExtractionResult {
  const extractor = getTypographyExtractor();
  return externalCss
    ? extractor.extract(html, externalCss)
    : extractor.extractFromHTML(html);
}

/**
 * Detect Gradients from CSS content
 *
 * @param css - CSS content
 * @returns Gradient detection result
 */
export function detectGradients(css: string): GradientDetectionResult {
  const detector = getGradientDetector();
  return detector.detectGradientFromCSS(css);
}

/**
 * Detect Gradients from image buffer
 *
 * @param imageBuffer - Image buffer (PNG/JPEG)
 * @returns Gradient detection result
 */
export async function detectGradientsFromImage(
  imageBuffer: Buffer
): Promise<GradientDetectionResult> {
  const detector = getGradientDetector();
  return detector.detectGradient(imageBuffer);
}

// =====================================================
// Helper functions
// =====================================================

/**
 * Extract CSS content from HTML <style> tags
 *
 * @param html - HTML content
 * @returns Combined CSS from all style tags
 */
function extractCSSFromHTML(html: string): string {
  const styleTagPattern = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let css = '';
  let match;

  while ((match = styleTagPattern.exec(html)) !== null) {
    css += match[1] + '\n';
  }

  return css;
}

// =====================================================
// Service reset (for testing)
// =====================================================

/**
 * Reset all service instances (for testing)
 */
export function resetVisualExtractorServices(): void {
  cssVariableExtractor = null;
  typographyExtractor = null;
  gradientDetector = null;
}

// =====================================================
// Re-exports
// =====================================================

export type { CSSVariableExtractionResult } from '../../../services/visual/css-variable-extractor.service';
export type { TypographyExtractionResult } from '../../../services/visual/typography-extractor.service';
export type { GradientDetectionResult } from '../../../services/visual-extractor/gradient-detector.service';
