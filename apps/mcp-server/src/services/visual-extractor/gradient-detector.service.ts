// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gradient Detector Service
 *
 * Detects gradient patterns (linear, radial, conic) from images using
 * pixel analysis and color change patterns.
 *
 * Security features:
 * - Input size validation (5MB max) - SEC H-1
 * - Processing timeout (30s default) - SEC M-1
 *
 * @module services/visual-extractor/gradient-detector.service
 */

import { logger } from '../../utils/logger';
import sharp from 'sharp';
import {
  parseAndValidateImageInput,
  withTimeout,
  DEFAULT_PROCESSING_TIMEOUT,
  logSecurityEvent,
  rgbToHex,
  wrapSharpError,
  colorDistance,
  type RGB,
} from './image-utils';

/**
 * Color stop in a gradient
 */
export interface ColorStop {
  /** Color in HEX format (#RRGGBB) */
  color: string;
  /** Position in gradient (0-1) */
  position: number;
}

/**
 * Region bounds for a detected gradient
 */
export interface GradientRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Animation info for gradient (v0.1.0)
 */
export interface GradientAnimation {
  /** Animation name (keyframes) */
  name: string;
  /** Animation duration (e.g., '3s', '500ms') */
  duration?: string;
  /** Timing function (e.g., 'ease', 'linear', 'ease-in-out') */
  timingFunction?: string;
  /** Iteration count (e.g., 'infinite', '1', '3') */
  iterationCount?: string;
  /** Animation direction (e.g., 'normal', 'alternate', 'reverse') */
  direction?: string;
  /** Animation delay (e.g., '0s', '200ms') */
  delay?: string;
  /** Fill mode (e.g., 'none', 'forwards', 'backwards', 'both') */
  fillMode?: string;
}

/**
 * Transition info for gradient (v0.1.0)
 */
export interface GradientTransition {
  /** Transition property (e.g., 'background', 'all') */
  property: string;
  /** Transition duration (e.g., '0.3s', '300ms') */
  duration?: string;
  /** Timing function (e.g., 'ease', 'linear', 'ease-out') */
  timingFunction?: string;
  /** Transition delay (e.g., '0s', '100ms') */
  delay?: string;
}

/**
 * Single detected gradient information
 */
export interface DetectedGradient {
  /** Type of gradient */
  type: 'linear' | 'radial' | 'conic';
  /** Direction in degrees for linear gradient (0-360) */
  direction?: number;
  /** Center X position for radial/conic gradient (0-1) */
  centerX?: number;
  /** Center Y position for radial/conic gradient (0-1) */
  centerY?: number;
  /** Color stops in the gradient */
  colorStops: ColorStop[];
  /** Region where gradient was detected */
  region: GradientRegion;
  /** Confidence score for this gradient detection (0-1) */
  confidence: number;
  /** Generated CSS gradient string (v0.1.0) */
  cssString?: string;
  /** Animation info (v0.1.0) - populated when CSS context is available */
  animation?: GradientAnimation;
  /** Transition info (v0.1.0) - populated when CSS context is available */
  transition?: GradientTransition;
  /** Parent element CSS selector (v0.1.0) - populated when CSS context is available */
  parentElement?: string;
}

/**
 * Result of gradient detection from an image
 */
export interface GradientDetectionResult {
  /** Whether any gradient was detected */
  hasGradient: boolean;
  /** List of detected gradients */
  gradients: DetectedGradient[];
  /** The most prominent gradient type */
  dominantGradientType?: 'linear' | 'radial' | 'conic';
  /** Overall confidence score (0-1) */
  confidence: number;
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * Gradient detector service interface
 */
export interface GradientDetectorService {
  /**
   * Detect gradients from an image
   * @param image - Image as Buffer or Base64 string
   * @returns Promise resolving to gradient detection result
   * @throws Error if image is invalid or processing fails
   */
  detectGradient(image: Buffer | string): Promise<GradientDetectionResult>;

  /**
   * Detect gradients from CSS text (v0.1.0)
   * Extracts gradient definitions along with animation/transition info and parent selectors.
   * @param css - CSS text to analyze
   * @returns Gradient detection result with CSS-specific info
   */
  detectGradientFromCSS(css: string): GradientDetectionResult;
}

/**
 * Configuration options for gradient detector
 */
interface GradientDetectorConfig {
  /** Max width for processing (for performance) */
  maxProcessingWidth: number;
  /** Max height for processing (for performance) */
  maxProcessingHeight: number;
  /** Minimum color change threshold (deltaE) to consider gradient */
  minColorChangeThreshold: number;
  /** Sample step size for analysis */
  sampleStep: number;
  /** Minimum gradient length (pixels) to consider valid */
  minGradientLength: number;
}

/** Default configuration */
const DEFAULT_CONFIG: GradientDetectorConfig = {
  maxProcessingWidth: 300,
  maxProcessingHeight: 300,
  minColorChangeThreshold: 15,
  sampleStep: 2,
  minGradientLength: 10,
};

/** Threshold for considering colors as similar */
const SIMILAR_COLOR_THRESHOLD = 5;

/** Threshold for continuous gradient detection */
const CONTINUOUS_GRADIENT_THRESHOLD = 20;

/** Minimum score threshold for linear gradient detection */
const LINEAR_MIN_SCORE_THRESHOLD = 5;

/** Minimum radial gradient consistency threshold */
const RADIAL_CONSISTENCY_THRESHOLD = 0.5;

/** Conic gradient angular variation threshold (reserved for future use) */
// const CONIC_ANGULAR_VARIATION_THRESHOLD = 15;

/** Minimum color samples ratio for conic gradient detection */
const CONIC_MIN_SAMPLES_RATIO = 0.8;

/** Minimum transitions for conic gradient detection */
const CONIC_MIN_TRANSITIONS = 4;

// =============================================================================
// CSS Gradient Parsing Types and Functions (v0.1.0)
// =============================================================================

/**
 * Parsed CSS rule with selector and declarations
 */
interface ParsedCSSRule {
  selector: string;
  declarations: Map<string, string>;
}

/**
 * CSS gradient match from regex
 */
interface CSSGradientMatch {
  type: 'linear' | 'radial' | 'conic';
  fullMatch: string;
  isRepeating: boolean;
}

/**
 * Parse CSS text into rules (simplified parser)
 */
function parseCSSRules(css: string): ParsedCSSRule[] {
  if (!css || typeof css !== 'string') {
    return [];
  }

  const rules: ParsedCSSRule[] = [];
  // Remove comments
  const cleanedCss = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // Match CSS rules (simple regex, handles most cases)
  const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
  let match;

  while ((match = ruleRegex.exec(cleanedCss)) !== null) {
    const selector = match[1]?.trim() ?? '';
    const declarationBlock = match[2] ?? '';

    // Skip @keyframes and @media (handle separately if needed)
    if (selector.startsWith('@')) {
      continue;
    }

    const declarations = new Map<string, string>();

    // Parse declarations
    const declPairs = declarationBlock.split(';');
    for (const pair of declPairs) {
      const colonIndex = pair.indexOf(':');
      if (colonIndex > 0) {
        const property = pair.substring(0, colonIndex).trim();
        const value = pair.substring(colonIndex + 1).trim();
        if (property && value) {
          declarations.set(property, value);
        }
      }
    }

    if (selector) {
      rules.push({ selector, declarations });
    }
  }

  return rules;
}

/**
 * Extract gradient matches from a CSS value
 */
function extractGradientMatches(value: string): CSSGradientMatch[] {
  const matches: CSSGradientMatch[] = [];

  // Regex to match gradient functions (handles nested parentheses)
  const gradientRegex = /(repeating-)?(linear|radial|conic)-gradient\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  let match;

  while ((match = gradientRegex.exec(value)) !== null) {
    const isRepeating = !!match[1];
    const type = match[2] as 'linear' | 'radial' | 'conic';
    const fullMatch = match[0];

    matches.push({
      type,
      fullMatch,
      isRepeating,
    });
  }

  return matches;
}

/**
 * Parse animation shorthand or individual properties
 */
function parseAnimationInfo(declarations: Map<string, string>): GradientAnimation | undefined {
  // Check for animation shorthand
  const animationShorthand = declarations.get('animation');
  if (animationShorthand) {
    // Parse: name duration timing-function delay iteration-count direction fill-mode
    // Example: "gradient-shift 3s ease infinite"
    const parts = animationShorthand.split(/\s+/);
    const result: GradientAnimation = { name: '' };

    for (const part of parts) {
      if (/^\d+(\.\d+)?(s|ms)$/.test(part)) {
        // Duration or delay
        if (!result.duration) {
          result.duration = part;
        } else {
          result.delay = part;
        }
      } else if (/^(ease|linear|ease-in|ease-out|ease-in-out|cubic-bezier\([^)]+\)|steps\([^)]+\))$/.test(part)) {
        result.timingFunction = part;
      } else if (/^(infinite|\d+)$/.test(part)) {
        result.iterationCount = part;
      } else if (/^(normal|reverse|alternate|alternate-reverse)$/.test(part)) {
        result.direction = part;
      } else if (/^(none|forwards|backwards|both)$/.test(part)) {
        result.fillMode = part;
      } else if (part && !result.name) {
        result.name = part;
      }
    }

    if (result.name) {
      return result;
    }
  }

  // Check for individual animation properties
  const animationName = declarations.get('animation-name');
  if (animationName && animationName !== 'none') {
    const result: GradientAnimation = {
      name: animationName,
    };

    // Only add properties if they have values (exactOptionalPropertyTypes compliance)
    const duration = declarations.get('animation-duration');
    if (duration) result.duration = duration;

    const timingFunction = declarations.get('animation-timing-function');
    if (timingFunction) result.timingFunction = timingFunction;

    const iterationCount = declarations.get('animation-iteration-count');
    if (iterationCount) result.iterationCount = iterationCount;

    const direction = declarations.get('animation-direction');
    if (direction) result.direction = direction;

    const delay = declarations.get('animation-delay');
    if (delay) result.delay = delay;

    const fillMode = declarations.get('animation-fill-mode');
    if (fillMode) result.fillMode = fillMode;

    return result;
  }

  return undefined;
}

/**
 * Parse transition shorthand or individual properties
 */
function parseTransitionInfo(declarations: Map<string, string>): GradientTransition | undefined {
  // Check for transition shorthand
  const transitionShorthand = declarations.get('transition');
  if (transitionShorthand) {
    // Parse: property duration timing-function delay
    // Example: "background 0.3s ease"
    const parts = transitionShorthand.split(/\s+/);
    const result: GradientTransition = { property: '' };

    for (const part of parts) {
      if (/^\d+(\.\d+)?(s|ms)$/.test(part)) {
        // Duration or delay
        if (!result.duration) {
          result.duration = part;
        } else {
          result.delay = part;
        }
      } else if (/^(ease|linear|ease-in|ease-out|ease-in-out|cubic-bezier\([^)]+\)|steps\([^)]+\))$/.test(part)) {
        result.timingFunction = part;
      } else if (part && !result.property) {
        result.property = part;
      }
    }

    // Check if the transition applies to background
    if (result.property && (result.property === 'all' || result.property.includes('background'))) {
      return result;
    }
  }

  // Check for individual transition properties
  const transitionProperty = declarations.get('transition-property');
  if (transitionProperty) {
    // Check if background is included
    const properties = transitionProperty.split(',').map((p) => p.trim());
    const bgIndex = properties.findIndex((p) => p === 'all' || p.includes('background'));

    if (bgIndex >= 0) {
      const durations = (declarations.get('transition-duration') ?? '').split(',').map((d) => d.trim());
      const timings = (declarations.get('transition-timing-function') ?? '').split(',').map((t) => t.trim());
      const delays = (declarations.get('transition-delay') ?? '').split(',').map((d) => d.trim());

      const result: GradientTransition = {
        property: properties[bgIndex] ?? 'background',
      };

      // Only add properties if they have values (exactOptionalPropertyTypes compliance)
      const duration = durations[bgIndex] ?? durations[0];
      if (duration) result.duration = duration;

      const timingFunction = timings[bgIndex] ?? timings[0];
      if (timingFunction) result.timingFunction = timingFunction;

      const delay = delays[bgIndex] ?? delays[0];
      if (delay) result.delay = delay;

      return result;
    }
  }

  return undefined;
}

/**
 * Parse color stops from gradient arguments (simplified)
 */
function parseColorStopsFromCSS(gradientArgs: string): ColorStop[] {
  const colorStops: ColorStop[] = [];

  // Remove direction/shape arguments for linear/radial
  // Split by comma but respect parentheses
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const char of gradientArgs) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    parts.push(current.trim());
  }

  // Skip first part if it's a direction/position
  let startIndex = 0;
  if (parts[0]) {
    const firstPart = parts[0].toLowerCase();
    if (
      firstPart.includes('deg') ||
      firstPart.startsWith('to ') ||
      firstPart.includes('at ') ||
      firstPart === 'circle' ||
      firstPart === 'ellipse' ||
      firstPart.startsWith('from ')
    ) {
      startIndex = 1;
    }
  }

  // Parse color stops
  for (let i = startIndex; i < parts.length; i++) {
    const part = parts[i]?.trim() ?? '';

    // Extract position percentage if present
    const posMatch = part.match(/(\d+(\.\d+)?%)/);
    const position = posMatch ? parseFloat(posMatch[1] ?? '0') / 100 : i === startIndex ? 0 : i === parts.length - 1 ? 1 : (i - startIndex) / (parts.length - 1 - startIndex);

    // Extract color (simplified - just take the color part)
    const colorPart = part.replace(/\d+(\.\d+)?%/g, '').trim();

    if (colorPart) {
      colorStops.push({
        color: colorPart,
        position,
      });
    }
  }

  return colorStops;
}

/**
 * Parse direction/angle from linear gradient
 */
function parseLinearDirection(gradientArgs: string): number | undefined {
  const firstPart = gradientArgs.split(',')[0]?.trim() ?? '';

  // Check for angle (e.g., "45deg", "90deg")
  const angleMatch = firstPart.match(/^(-?\d+(\.\d+)?)(deg|grad|rad|turn)/);
  if (angleMatch) {
    let value = parseFloat(angleMatch[1] ?? '0');
    const unit = angleMatch[3];

    // Convert to degrees
    switch (unit) {
      case 'grad':
        value = (value * 360) / 400;
        break;
      case 'rad':
        value = (value * 180) / Math.PI;
        break;
      case 'turn':
        value = value * 360;
        break;
    }

    return value;
  }

  // Check for direction keywords
  const directionMap: Record<string, number> = {
    'to top': 0,
    'to top right': 45,
    'to right': 90,
    'to bottom right': 135,
    'to bottom': 180,
    'to bottom left': 225,
    'to left': 270,
    'to top left': 315,
  };

  const lowerFirst = firstPart.toLowerCase();
  for (const [key, value] of Object.entries(directionMap)) {
    if (lowerFirst === key) {
      return value;
    }
  }

  return undefined;
}

/**
 * Parse center position from radial/conic gradient
 */
function parseGradientCenter(gradientArgs: string): { centerX?: number; centerY?: number } {
  const result: { centerX?: number; centerY?: number } = {};

  // Check for "at X% Y%" or "at X Y"
  const atMatch = gradientArgs.match(/at\s+(\d+%?)\s+(\d+%?)/i);
  if (atMatch) {
    const xStr = atMatch[1] ?? '50%';
    const yStr = atMatch[2] ?? '50%';

    result.centerX = xStr.includes('%') ? parseFloat(xStr) / 100 : parseFloat(xStr) / 100;
    result.centerY = yStr.includes('%') ? parseFloat(yStr) / 100 : parseFloat(yStr) / 100;
  }

  // Check for 'at center' keyword
  if (gradientArgs.toLowerCase().includes('at center')) {
    result.centerX = 0.5;
    result.centerY = 0.5;
  }

  return result;
}

// =============================================================================
// Helper Types for Conic Gradient Detection
// =============================================================================

/**
 * Color sample at a specific angle
 */
interface AngularColorSample {
  color: RGB;
  angle: number;
}

/**
 * Result of angular variation analysis
 */
interface AngularVariationResult {
  totalVariation: number;
  numTransitions: number;
  avgVariation: number;
  isConic: boolean;
}

/**
 * Significant color point for color stop extraction
 */
interface SignificantColorPoint {
  color: RGB;
  position: number;
}

// =============================================================================
// Conic Gradient Helper Functions
// =============================================================================

/**
 * Sample colors around a circle at fixed radius
 */
function sampleColorsAroundCircle(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  cx: number,
  cy: number,
  radius: number,
  numSamples: number
): AngularColorSample[] {
  const colors: AngularColorSample[] = [];

  for (let i = 0; i < numSamples; i++) {
    const angle = (i / numSamples) * 2 * Math.PI;
    const x = Math.floor(cx + Math.cos(angle) * radius);
    const y = Math.floor(cy + Math.sin(angle) * radius);

    if (x >= 0 && x < width && y >= 0 && y < height) {
      const pixelIndex = (y * width + x) * channels;
      const r = data[pixelIndex] ?? 0;
      const g = data[pixelIndex + 1] ?? 0;
      const b = data[pixelIndex + 2] ?? 0;
      colors.push({ color: [r, g, b], angle });
    }
  }

  return colors;
}

/**
 * Analyze angular color variation to determine if conic gradient exists
 */
function analyzeAngularVariation(colors: AngularColorSample[]): AngularVariationResult {
  let totalVariation = 0;
  let numTransitions = 0;

  // Calculate variation between adjacent samples
  for (let i = 1; i < colors.length; i++) {
    const prevColor = colors[i - 1];
    const currColor = colors[i];
    if (prevColor && currColor) {
      const deltaE = colorDistance(prevColor.color, currColor.color);
      totalVariation += deltaE;
      if (deltaE > SIMILAR_COLOR_THRESHOLD) {
        numTransitions++;
      }
    }
  }

  // Check wrap-around
  const lastColorEntry = colors[colors.length - 1];
  const firstColorEntry = colors[0];
  if (lastColorEntry && firstColorEntry) {
    const wrapDeltaE = colorDistance(lastColorEntry.color, firstColorEntry.color);
    totalVariation += wrapDeltaE;
  }

  const avgVariation = colors.length > 0 ? totalVariation / colors.length : 0;

  // Determine if this is a conic gradient
  const hasEnoughTransitions = numTransitions >= CONIC_MIN_TRANSITIONS;
  const hasSignificantVariation = avgVariation > SIMILAR_COLOR_THRESHOLD;
  const hasTotalVariation = totalVariation > CONTINUOUS_GRADIENT_THRESHOLD * 2;
  const isConic = hasEnoughTransitions && hasSignificantVariation && hasTotalVariation;

  return { totalVariation, numTransitions, avgVariation, isConic };
}

/**
 * Find significant color transition points for color stops
 */
function findSignificantColorPoints(colors: AngularColorSample[]): SignificantColorPoint[] {
  const significantColors: SignificantColorPoint[] = [];

  for (let i = 0; i < colors.length; i++) {
    const prevIndex = (i - 1 + colors.length) % colors.length;
    const nextIndex = (i + 1) % colors.length;

    const prevColorEntry = colors[prevIndex];
    const currColorEntry = colors[i];
    const nextColorEntry = colors[nextIndex];

    if (prevColorEntry && currColorEntry && nextColorEntry) {
      const prevDeltaE = colorDistance(prevColorEntry.color, currColorEntry.color);
      const nextDeltaE = colorDistance(currColorEntry.color, nextColorEntry.color);

      // Detect transition points
      if (prevDeltaE > CONTINUOUS_GRADIENT_THRESHOLD || nextDeltaE > CONTINUOUS_GRADIENT_THRESHOLD) {
        significantColors.push({
          color: currColorEntry.color,
          position: i / colors.length,
        });
      }
    }
  }

  return significantColors;
}

/**
 * Extract color stops from angular color samples
 */
function extractConicColorStops(
  colors: AngularColorSample[],
  significantColors: SignificantColorPoint[]
): ColorStop[] {
  const colorStops: ColorStop[] = [];

  // If few significant points, use evenly distributed samples
  if (significantColors.length < 3) {
    const step = Math.floor(colors.length / 4);
    for (let i = 0; i < 4; i++) {
      const idx = i * step;
      const colorEntry = colors[idx];
      if (colorEntry) {
        colorStops.push({
          color: rgbToHex(colorEntry.color[0], colorEntry.color[1], colorEntry.color[2]),
          position: idx / colors.length,
        });
      }
    }
  } else {
    // Use significant transition points
    for (const sc of significantColors.slice(0, 6)) {
      colorStops.push({
        color: rgbToHex(sc.color[0], sc.color[1], sc.color[2]),
        position: sc.position,
      });
    }
  }

  // Sort color stops by position
  colorStops.sort((a, b) => a.position - b.position);

  return colorStops;
}

// =============================================================================
// Line Gradient Analysis Helper Types and Functions
// =============================================================================

/**
 * Color sample at a specific position along a line
 */
interface LineColorSample {
  color: RGB;
  position: number;
}

/**
 * Result of analyzing line gradient
 */
interface LineGradientResult {
  isGradient: boolean;
  colorStops: ColorStop[];
  avgDeltaE: number;
  totalChange: number;
}

/**
 * Sample colors along a line from start to end
 */
function sampleColorsAlongLine(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  step: number
): LineColorSample[] {
  const colors: LineColorSample[] = [];
  const dx = endX - startX;
  const dy = endY - startY;
  const length = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.ceil(length / step);

  if (steps < 2) {
    return colors;
  }

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(startX + dx * t);
    const y = Math.round(startY + dy * t);

    if (x >= 0 && x < width && y >= 0 && y < height) {
      const pixelIndex = (y * width + x) * channels;
      const r = data[pixelIndex] ?? 0;
      const g = data[pixelIndex + 1] ?? 0;
      const b = data[pixelIndex + 2] ?? 0;
      colors.push({ color: [r, g, b], position: t });
    }
  }

  return colors;
}

/**
 * Calculate color variation metrics along sampled colors
 */
function calculateColorVariation(
  colors: LineColorSample[]
): { avgDeltaE: number; totalChange: number; firstColor: RGB | null; lastColor: RGB | null } {
  if (colors.length < 2) {
    return { avgDeltaE: 0, totalChange: 0, firstColor: null, lastColor: null };
  }

  let totalDeltaE = 0;

  for (let i = 1; i < colors.length; i++) {
    const prevColor = colors[i - 1];
    const currColor = colors[i];
    if (prevColor && currColor) {
      const deltaE = colorDistance(prevColor.color, currColor.color);
      totalDeltaE += deltaE;
    }
  }

  const avgDeltaE = totalDeltaE / (colors.length - 1);

  const firstColorEntry = colors[0];
  const lastColorEntry = colors[colors.length - 1];

  if (!firstColorEntry || !lastColorEntry) {
    return { avgDeltaE, totalChange: 0, firstColor: null, lastColor: null };
  }

  const firstColor = firstColorEntry.color;
  const lastColor = lastColorEntry.color;
  const totalChange = colorDistance(firstColor, lastColor);

  return { avgDeltaE, totalChange, firstColor, lastColor };
}

/**
 * Extract color stops from line gradient
 */
function extractLineColorStops(
  colors: LineColorSample[],
  firstColor: RGB,
  lastColor: RGB
): ColorStop[] {
  const colorStops: ColorStop[] = [];

  // Add start
  colorStops.push({
    color: rgbToHex(firstColor[0], firstColor[1], firstColor[2]),
    position: 0,
  });

  // Find significant intermediate stops
  const middleIndex = Math.floor(colors.length / 2);
  if (colors.length > 4) {
    const midEntry = colors[middleIndex];
    if (midEntry) {
      const midColor = midEntry.color;
      const distFromStart = colorDistance(firstColor, midColor);
      const distFromEnd = colorDistance(midColor, lastColor);

      if (distFromStart > CONTINUOUS_GRADIENT_THRESHOLD && distFromEnd > CONTINUOUS_GRADIENT_THRESHOLD) {
        colorStops.push({
          color: rgbToHex(midColor[0], midColor[1], midColor[2]),
          position: 0.5,
        });
      }
    }
  }

  // Add end - always at position 1.0
  colorStops.push({
    color: rgbToHex(lastColor[0], lastColor[1], lastColor[2]),
    position: 1,
  });

  return colorStops;
}

/**
 * Analyze color changes along a line to detect gradient
 *
 * Refactored to reduce cyclomatic complexity by extracting helper functions:
 * - sampleColorsAlongLine: Color sampling
 * - calculateColorVariation: Variation metrics calculation
 * - extractLineColorStops: Color stop extraction
 */
function analyzeLineGradient(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  step: number
): LineGradientResult {
  // Step 1: Sample colors along the line
  const colors = sampleColorsAlongLine(data, width, height, channels, startX, startY, endX, endY, step);

  if (colors.length < 2) {
    return { isGradient: false, colorStops: [], avgDeltaE: 0, totalChange: 0 };
  }

  // Step 2: Calculate color variation metrics
  const { avgDeltaE, totalChange, firstColor, lastColor } = calculateColorVariation(colors);

  if (!firstColor || !lastColor) {
    return { isGradient: false, colorStops: [], avgDeltaE: 0, totalChange: 0 };
  }

  // Step 3: Determine if gradient exists
  const isGradient = totalChange > CONTINUOUS_GRADIENT_THRESHOLD;

  // Step 4: Extract color stops if gradient detected
  const colorStops = isGradient ? extractLineColorStops(colors, firstColor, lastColor) : [];

  return { isGradient, colorStops, avgDeltaE, totalChange };
}

// =============================================================================
// Linear Gradient Helper Types and Functions
// =============================================================================

/**
 * Line coordinates for sampling
 */
interface LineCoordinates {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/**
 * Result from analyzing a specific angle
 */
interface AngleAnalysisResult {
  angle: number;
  colorStops: ColorStop[];
  avgDeltaE: number;
  totalChange: number;
  isGradient: boolean;
  consistency: number;
}

/** Standard angles to test for linear gradient detection */
const LINEAR_TEST_ANGLES = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330];

/** Number of parallel lines to sample for each angle */
const LINEAR_NUM_SAMPLES = 7;

/**
 * Calculate sampling line coordinates for a horizontal gradient
 */
function calculateHorizontalLine(width: number, height: number, offset: number): LineCoordinates {
  const y = Math.floor(height * (0.5 + offset * 0.6));
  return { startX: 0, startY: y, endX: width - 1, endY: y };
}

/**
 * Calculate sampling line coordinates for a vertical gradient
 */
function calculateVerticalLine(width: number, height: number, offset: number): LineCoordinates {
  const x = Math.floor(width * (0.5 + offset * 0.6));
  return { startX: x, startY: 0, endX: x, endY: height - 1 };
}

/**
 * Calculate sampling line coordinates for a diagonal gradient
 */
function calculateDiagonalLine(
  width: number,
  height: number,
  cosA: number,
  sinA: number,
  offset: number
): LineCoordinates {
  const centerX = width / 2;
  const centerY = height / 2;
  const diagonalLen = (Math.sqrt(width * width + height * height) / 2) * 0.9;

  let startX = Math.floor(centerX - cosA * diagonalLen);
  let startY = Math.floor(centerY - sinA * diagonalLen);
  let endX = Math.floor(centerX + cosA * diagonalLen);
  let endY = Math.floor(centerY + sinA * diagonalLen);

  // Apply perpendicular offset for parallel sampling lines
  const perpX = -sinA * offset * height * 0.3;
  const perpY = cosA * offset * height * 0.3;
  startX += Math.floor(perpX);
  startY += Math.floor(perpY);
  endX += Math.floor(perpX);
  endY += Math.floor(perpY);

  return { startX, startY, endX, endY };
}

/**
 * Calculate sampling line coordinates for a given angle and offset
 */
function calculateSamplingLine(
  width: number,
  height: number,
  angle: number,
  cosA: number,
  sinA: number,
  offset: number
): LineCoordinates {
  let coords: LineCoordinates;

  if (angle === 0 || angle === 180) {
    coords = calculateHorizontalLine(width, height, offset);
  } else if (angle === 90 || angle === 270) {
    coords = calculateVerticalLine(width, height, offset);
  } else {
    coords = calculateDiagonalLine(width, height, cosA, sinA, offset);
  }

  // Clamp to bounds
  return {
    startX: Math.max(0, Math.min(width - 1, coords.startX)),
    startY: Math.max(0, Math.min(height - 1, coords.startY)),
    endX: Math.max(0, Math.min(width - 1, coords.endX)),
    endY: Math.max(0, Math.min(height - 1, coords.endY)),
  };
}

/**
 * Analyze gradient at a specific angle by sampling multiple parallel lines
 */
function analyzeLinearAngle(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  angle: number,
  step: number
): AngleAnalysisResult | null {
  const radians = (angle * Math.PI) / 180;
  const cosA = Math.cos(radians);
  const sinA = Math.sin(radians);
  const lineResults: LineGradientResult[] = [];

  for (let s = 0; s < LINEAR_NUM_SAMPLES; s++) {
    const offset = s / (LINEAR_NUM_SAMPLES - 1) - 0.5;
    const coords = calculateSamplingLine(width, height, angle, cosA, sinA, offset);
    const result = analyzeLineGradient(
      data,
      width,
      height,
      channels,
      coords.startX,
      coords.startY,
      coords.endX,
      coords.endY,
      step
    );
    lineResults.push(result);
  }

  // Score this angle based on consistency of gradients across samples
  const gradientCount = lineResults.filter((r) => r.isGradient).length;
  const avgDeltaE = lineResults.reduce((sum, r) => sum + r.avgDeltaE, 0) / lineResults.length;
  const avgTotalChange = lineResults.reduce((sum, r) => sum + r.totalChange, 0) / lineResults.length;
  const consistency = gradientCount / LINEAR_NUM_SAMPLES;

  // Require at least half the lines to show gradient
  if (gradientCount < Math.ceil(LINEAR_NUM_SAMPLES * 0.5)) {
    return null;
  }

  const firstGradient = lineResults.find((r) => r.isGradient);

  return {
    angle,
    colorStops: firstGradient?.colorStops ?? [],
    avgDeltaE,
    totalChange: avgTotalChange,
    isGradient: true,
    consistency,
  };
}

/**
 * Detect linear gradient pattern
 *
 * Refactored to reduce cyclomatic complexity by extracting helper functions:
 * - calculateSamplingLine: Line coordinate calculation
 * - analyzeLinearAngle: Per-angle analysis
 */
function detectLinearGradient(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  config: GradientDetectorConfig
): DetectedGradient | null {
  const step = config.sampleStep;
  let bestResult: AngleAnalysisResult | null = null;
  let bestScore = 0;

  // Test each angle
  for (const angle of LINEAR_TEST_ANGLES) {
    const result = analyzeLinearAngle(data, width, height, channels, angle, step);

    if (result) {
      const score = result.consistency * result.totalChange;
      if (score > bestScore) {
        bestScore = score;
        bestResult = result;
      }
    }
  }

  if (!bestResult || bestScore < LINEAR_MIN_SCORE_THRESHOLD) {
    return null;
  }

  // Calculate confidence based on total color change and consistency
  const colorChangeRatio = Math.min(1, bestResult.totalChange / 300);
  const confidence = Math.min(1, colorChangeRatio * 0.7 + bestResult.consistency * 0.3);

  return {
    type: 'linear',
    direction: bestResult.angle,
    colorStops: bestResult.colorStops,
    region: { x: 0, y: 0, width, height },
    confidence,
  };
}

// =============================================================================
// Radial Gradient Helper Types and Functions
// =============================================================================

/**
 * Center candidate for radial gradient detection
 */
interface CenterCandidate {
  x: number;
  y: number;
}

/**
 * Result from analyzing a potential radial center
 */
interface RadialCenterResult {
  centerX: number;
  centerY: number;
  colorStops: ColorStop[];
  score: number;
  consistency: number;
  totalChange: number;
  isRadial: boolean;
}

/** Standard center candidates for radial gradient detection */
const RADIAL_CENTER_CANDIDATES: CenterCandidate[] = [
  { x: 0.5, y: 0.5 },
  { x: 0.25, y: 0.5 },
  { x: 0.75, y: 0.5 },
  { x: 0.5, y: 0.25 },
  { x: 0.5, y: 0.75 },
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.75 },
  { x: 0.25, y: 0.75 },
  { x: 0.75, y: 0.25 },
];

/**
 * Calculate the end point for a radial line from center at given angle
 */
function calculateRadialEndPoint(
  cx: number,
  cy: number,
  width: number,
  height: number,
  angle: number
): { endX: number; endY: number } {
  const maxX = angle > Math.PI / 2 && angle < (3 * Math.PI) / 2 ? cx : width - cx;
  const maxY = angle > 0 && angle < Math.PI ? height - cy : cy;
  const radius =
    Math.min(maxX / Math.abs(Math.cos(angle) || 0.001), maxY / Math.abs(Math.sin(angle) || 0.001)) * 0.85;
  const clampedRadius = Math.min(radius, Math.max(width, height) * 0.7);
  const endX = Math.floor(cx + Math.cos(angle) * clampedRadius);
  const endY = Math.floor(cy + Math.sin(angle) * clampedRadius);
  return { endX, endY };
}

/**
 * Analyze radial gradient from a specific center point
 */
function analyzeRadialCenter(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  center: CenterCandidate,
  step: number,
  numAngles: number
): RadialCenterResult {
  const cx = Math.floor(width * center.x);
  const cy = Math.floor(height * center.y);
  const radialResults: LineGradientResult[] = [];

  // Sample along multiple radial lines from center
  for (let i = 0; i < numAngles; i++) {
    const angle = (i / numAngles) * 2 * Math.PI;
    const { endX, endY } = calculateRadialEndPoint(cx, cy, width, height, angle);
    const result = analyzeLineGradient(data, width, height, channels, cx, cy, endX, endY, step);
    radialResults.push(result);
  }

  // Calculate metrics
  const gradientCount = radialResults.filter((r) => r.isGradient).length;
  const avgTotalChange = radialResults.reduce((sum, r) => sum + r.totalChange, 0) / radialResults.length;
  const consistency = gradientCount / numAngles;

  // For radial gradient, at least half the radial lines should show gradient
  const isRadial = consistency >= RADIAL_CONSISTENCY_THRESHOLD && gradientCount >= 6;
  const score = consistency * avgTotalChange;

  const firstGradient = radialResults.find((r) => r.isGradient);

  return {
    centerX: center.x,
    centerY: center.y,
    colorStops: firstGradient?.colorStops ?? [],
    score,
    consistency,
    totalChange: avgTotalChange,
    isRadial,
  };
}

/**
 * Detect radial gradient pattern
 *
 * Refactored to reduce cyclomatic complexity by extracting helper functions:
 * - calculateRadialEndPoint: End point calculation
 * - analyzeRadialCenter: Center point analysis
 */
function detectRadialGradient(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  config: GradientDetectorConfig
): DetectedGradient | null {
  const step = config.sampleStep;
  const numAngles = 16; // Increased for better detection

  let bestResult: RadialCenterResult | null = null;

  // Test each center candidate
  for (const center of RADIAL_CENTER_CANDIDATES) {
    const result = analyzeRadialCenter(data, width, height, channels, center, step, numAngles);

    if (result.isRadial && (!bestResult || result.score > bestResult.score)) {
      bestResult = result;
    }
  }

  if (!bestResult || !bestResult.isRadial) {
    return null;
  }

  // Calculate confidence based on consistency and color change
  const colorChangeRatio = Math.min(1, bestResult.totalChange / 250);
  const confidence = Math.min(1, colorChangeRatio * 0.5 + bestResult.consistency * 0.5);

  return {
    type: 'radial',
    centerX: bestResult.centerX,
    centerY: bestResult.centerY,
    colorStops: bestResult.colorStops,
    region: { x: 0, y: 0, width, height },
    confidence,
  };
}

/**
 * Detect conic gradient pattern
 *
 * Refactored to reduce cyclomatic complexity by extracting helper functions:
 * - sampleColorsAroundCircle: Color sampling
 * - analyzeAngularVariation: Variation analysis
 * - findSignificantColorPoints: Transition point detection
 * - extractConicColorStops: Color stop extraction
 */
function detectConicGradient(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  _config: GradientDetectorConfig
): DetectedGradient | null {
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const radius = Math.min(width, height) / 3;
  const numSamples = 36; // Every 10 degrees

  // Step 1: Sample colors around circle
  const colors = sampleColorsAroundCircle(data, width, height, channels, cx, cy, radius, numSamples);

  if (colors.length < numSamples * CONIC_MIN_SAMPLES_RATIO) {
    return null;
  }

  // Step 2: Analyze angular variation
  const variationResult = analyzeAngularVariation(colors);

  if (!variationResult.isConic) {
    return null;
  }

  // Step 3: Find significant color points
  const significantColors = findSignificantColorPoints(colors);

  // Step 4: Extract color stops
  const colorStops = extractConicColorStops(colors, significantColors);

  // Calculate confidence
  const confidence = Math.min(1, variationResult.avgVariation / 30);

  return {
    type: 'conic',
    centerX: 0.5,
    centerY: 0.5,
    colorStops,
    region: { x: 0, y: 0, width, height },
    confidence,
  };
}

/**
 * Check if image is mostly solid color
 */
function isSolidColor(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  sampleStep: number
): boolean {
  const colors: RGB[] = [];

  // Sample a grid of pixels
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const pixelIndex = (y * width + x) * channels;
      const r = data[pixelIndex] ?? 0;
      const g = data[pixelIndex + 1] ?? 0;
      const b = data[pixelIndex + 2] ?? 0;
      colors.push([r, g, b]);
    }
  }

  if (colors.length < 2) {
    return true;
  }

  // Calculate max color distance from first sample
  const firstColor = colors[0];
  if (!firstColor) {
    return true;
  }
  let maxDistance = 0;

  for (let i = 1; i < colors.length; i++) {
    const currentColor = colors[i];
    if (currentColor) {
      const dist = colorDistance(firstColor, currentColor);
      maxDistance = Math.max(maxDistance, dist);
    }
  }

  // If max distance is small, consider it solid
  return maxDistance < CONTINUOUS_GRADIENT_THRESHOLD;
}

// =============================================================================
// Helper Types and Functions for detectGradientInternal
// =============================================================================

/**
 * Type weight mapping for gradient type specificity
 * Higher weight = more specific gradient type
 */
const GRADIENT_TYPE_WEIGHTS: Record<string, number> = {
  conic: 3,
  radial: 2,
  linear: 1,
};

/**
 * Get type weight for sorting
 */
function getGradientTypeWeight(type: string): number {
  return GRADIENT_TYPE_WEIGHTS[type] ?? 0;
}

/**
 * Detect all gradient types and collect results
 */
function detectAllGradientTypes(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  config: GradientDetectorConfig
): DetectedGradient[] {
  const gradients: DetectedGradient[] = [];

  const linearGradient = detectLinearGradient(data, width, height, channels, config);
  const radialGradient = detectRadialGradient(data, width, height, channels, config);
  const conicGradient = detectConicGradient(data, width, height, channels, config);

  if (linearGradient) {
    gradients.push(linearGradient);
  }
  if (radialGradient) {
    gradients.push(radialGradient);
  }
  if (conicGradient) {
    gradients.push(conicGradient);
  }

  return gradients;
}

/**
 * Sort gradients by confidence and type specificity
 */
function sortGradientsByPriority(gradients: DetectedGradient[]): void {
  gradients.sort((a, b) => {
    // If confidence difference is significant, use confidence
    if (Math.abs(a.confidence - b.confidence) > 0.2) {
      return b.confidence - a.confidence;
    }
    // Otherwise prioritize by type specificity
    return getGradientTypeWeight(b.type) - getGradientTypeWeight(a.type);
  });
}

/**
 * Build the final gradient detection result
 */
function buildGradientResult(
  gradients: DetectedGradient[],
  processingTimeMs: number
): GradientDetectionResult {
  // Determine dominant type
  let dominantGradientType: 'linear' | 'radial' | 'conic' | undefined = undefined;
  const firstGradient = gradients[0];
  if (firstGradient) {
    dominantGradientType = firstGradient.type;
  }

  // Calculate overall confidence
  const overallConfidence =
    gradients.length > 0 ? Math.max(...gradients.map((g) => g.confidence)) : 0;

  const result: GradientDetectionResult = {
    hasGradient: gradients.length > 0,
    gradients,
    confidence: overallConfidence,
    processingTimeMs,
  };

  if (dominantGradientType) {
    result.dominantGradientType = dominantGradientType;
  }

  return result;
}

// =============================================================================
// CSS String Generation (v0.1.0)
// =============================================================================

/**
 * Generate CSS gradient string from DetectedGradient
 */
function generateCSSString(gradient: DetectedGradient): string {
  const colorStopsStr = gradient.colorStops
    .map((stop) => `${stop.color} ${Math.round(stop.position * 100)}%`)
    .join(', ');

  switch (gradient.type) {
    case 'linear': {
      const angle = gradient.direction ?? 0;
      return `linear-gradient(${angle}deg, ${colorStopsStr})`;
    }
    case 'radial': {
      const cx = gradient.centerX ?? 0.5;
      const cy = gradient.centerY ?? 0.5;
      return `radial-gradient(circle at ${Math.round(cx * 100)}% ${Math.round(cy * 100)}%, ${colorStopsStr})`;
    }
    case 'conic': {
      const cx = gradient.centerX ?? 0.5;
      const cy = gradient.centerY ?? 0.5;
      return `conic-gradient(from 0deg at ${Math.round(cx * 100)}% ${Math.round(cy * 100)}%, ${colorStopsStr})`;
    }
    default:
      return `linear-gradient(${colorStopsStr})`;
  }
}

/**
 * Internal implementation of GradientDetectorService
 */
class GradientDetectorServiceImpl implements GradientDetectorService {
  private config: GradientDetectorConfig;

  constructor(config: Partial<GradientDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async detectGradient(image: Buffer | string): Promise<GradientDetectionResult> {
    const startTime = performance.now();

    // Parse and validate input with size check (5MB max) - SEC H-1
    const imageBuffer = parseAndValidateImageInput(image);

    logSecurityEvent('GradientDetector', 'Processing image', {
      size: imageBuffer.length,
      sizeKB: Math.round(imageBuffer.length / 1024),
    });

    // Wrap processing with timeout (30s default) - SEC M-1
    const result = await withTimeout(
      this.detectGradientInternal(imageBuffer, startTime),
      DEFAULT_PROCESSING_TIMEOUT
    );

    return result;
  }

  /**
   * Detect gradients from CSS text (v0.1.0)
   */
  detectGradientFromCSS(css: string): GradientDetectionResult {
    const startTime = performance.now();

    // Handle null/undefined
    if (!css || typeof css !== 'string') {
      return {
        hasGradient: false,
        gradients: [],
        confidence: 0,
        processingTimeMs: performance.now() - startTime,
      };
    }

    logger.debug('[GradientDetector] Parsing CSS for gradients:', {
      cssLength: css.length,
    });

    const gradients: DetectedGradient[] = [];

    try {
      const rules = parseCSSRules(css);

      for (const rule of rules) {
        // Check background and background-image properties
        const bgProps = ['background', 'background-image'];

        for (const prop of bgProps) {
          const value = rule.declarations.get(prop);
          if (!value) continue;

          // Extract gradient matches from the value
          const gradientMatches = extractGradientMatches(value);

          for (const match of gradientMatches) {
            // Extract gradient arguments (inside parentheses)
            const argsMatch = match.fullMatch.match(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/);
            const gradientArgs = argsMatch?.[1] ?? '';

            // Parse color stops
            const colorStops = parseColorStopsFromCSS(gradientArgs);

            // Create detected gradient
            const detectedGradient: DetectedGradient = {
              type: match.type,
              colorStops,
              region: { x: 0, y: 0, width: 0, height: 0 }, // Region not applicable for CSS
              confidence: 1.0, // High confidence for CSS parsing
              cssString: match.isRepeating
                ? match.fullMatch
                : match.fullMatch,
              parentElement: rule.selector,
            };

            // Parse type-specific properties
            if (match.type === 'linear') {
              const direction = parseLinearDirection(gradientArgs);
              if (direction !== undefined) {
                detectedGradient.direction = direction;
              }
            } else if (match.type === 'radial' || match.type === 'conic') {
              const center = parseGradientCenter(gradientArgs);
              if (center.centerX !== undefined) {
                detectedGradient.centerX = center.centerX;
              }
              if (center.centerY !== undefined) {
                detectedGradient.centerY = center.centerY;
              }
            }

            // Parse animation info
            const animation = parseAnimationInfo(rule.declarations);
            if (animation) {
              detectedGradient.animation = animation;
            }

            // Parse transition info
            const transition = parseTransitionInfo(rule.declarations);
            if (transition) {
              detectedGradient.transition = transition;
            }

            gradients.push(detectedGradient);
          }
        }
      }
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[GradientDetector] Error parsing CSS:', error);
      }
    }

    const processingTimeMs = performance.now() - startTime;

    // Determine dominant gradient type
    let dominantGradientType: 'linear' | 'radial' | 'conic' | undefined;
    if (gradients.length > 0) {
      dominantGradientType = gradients[0]?.type;
    }

    const result: GradientDetectionResult = {
      hasGradient: gradients.length > 0,
      gradients,
      confidence: gradients.length > 0 ? 1.0 : 0,
      processingTimeMs,
    };

    if (dominantGradientType) {
      result.dominantGradientType = dominantGradientType;
    }

    logger.debug('[GradientDetector] CSS detection result:', {
      hasGradient: result.hasGradient,
      gradientCount: result.gradients.length,
      dominantType: result.dominantGradientType,
      processingTimeMs: processingTimeMs.toFixed(0),
    });

    return result;
  }

  private async detectGradientInternal(
    imageBuffer: Buffer,
    startTime: number
  ): Promise<GradientDetectionResult> {
    try {
      const processedImage = sharp(imageBuffer);
      const metadata = await processedImage.metadata();

      if (!metadata.width || !metadata.height) {
        throw new Error('Invalid image: unable to read dimensions');
      }

      // Resize for performance while maintaining aspect ratio
      const resizeOptions: sharp.ResizeOptions = {
        width: Math.min(metadata.width, this.config.maxProcessingWidth),
        height: Math.min(metadata.height, this.config.maxProcessingHeight),
        fit: 'inside',
        withoutEnlargement: true,
      };

      // Get raw RGB pixel data (flatten handles transparency)
      const { data, info } = await processedImage
        .resize(resizeOptions)
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const { width, height, channels } = info;

      // First check if image is solid color
      if (isSolidColor(data, width, height, channels, this.config.sampleStep)) {
        return {
          hasGradient: false,
          gradients: [],
          confidence: 1,
          processingTimeMs: performance.now() - startTime,
        };
      }

      // Detect all gradient types
      const gradients = detectAllGradientTypes(data, width, height, channels, this.config);

      // Add cssString to each gradient (v0.1.0)
      for (const gradient of gradients) {
        gradient.cssString = generateCSSString(gradient);
      }

      // Sort by type specificity and confidence
      sortGradientsByPriority(gradients);

      // Build and return the result
      const processingTimeMs = performance.now() - startTime;
      const result = buildGradientResult(gradients, processingTimeMs);

      logger.debug('[GradientDetector] Detection result:', {
        hasGradient: result.hasGradient,
        gradientCount: result.gradients.length,
        dominantType: result.dominantGradientType,
        confidence: result.confidence.toFixed(2),
        processingTimeMs: processingTimeMs.toFixed(0),
      });

      return result;
    } catch (error) {
      throw wrapSharpError(error);
    }
  }
}

/**
 * Create a new GradientDetectorService instance
 * @param config - Optional configuration options
 * @returns GradientDetectorService instance
 */
export function createGradientDetectorService(
  config?: Partial<GradientDetectorConfig>
): GradientDetectorService {
  return new GradientDetectorServiceImpl(config);
}
