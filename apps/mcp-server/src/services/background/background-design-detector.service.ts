// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Background Design Detector Service
 *
 * CSS/HTML コンテンツから背景デザインパターンを検出・分類するサービス。
 * グラデーション、ガラスモーフィズム、画像背景、パターン背景、アニメーション背景など
 * 14種類のデザインカテゴリを判別する。
 *
 * セキュリティ:
 * - 入力サイズバリデーション (5MB max) - SEC H-1
 *
 * @module services/background/background-design-detector.service
 */

import { CssVariableResolver } from '@reftrix/webdesign-core';
import { createLogger } from '../../utils/logger';

const logger = createLogger('BackgroundDesignDetector');

// =============================================================================
// Types
// =============================================================================

/** Background design type categories */
export type BackgroundDesignType =
  | 'solid_color'
  | 'linear_gradient'
  | 'radial_gradient'
  | 'conic_gradient'
  | 'mesh_gradient'
  | 'image_background'
  | 'pattern_background'
  | 'video_background'
  | 'animated_gradient'
  | 'glassmorphism'
  | 'noise_texture'
  | 'svg_background'
  | 'multi_layer'
  | 'unknown';

/** Gradient stop with color and position */
export interface GradientStop {
  /** Color string (raw CSS value) */
  color: string;
  /** Position in gradient (0-1) */
  position: number;
}

/** Color information for a detected background */
export interface ColorInfo {
  /** Dominant colors (HEX or raw CSS color values) */
  dominantColors: string[];
  /** Number of distinct colors */
  colorCount: number;
  /** Whether any color has alpha transparency */
  hasAlpha: boolean;
  /** Detected color space */
  colorSpace: 'srgb' | 'oklch' | 'p3';
}

/** Gradient-specific information */
export interface GradientInfo {
  /** Gradient type */
  type: 'linear' | 'radial' | 'conic';
  /** Angle in degrees for linear gradients */
  angle?: number;
  /** Color stops with positions */
  stops: GradientStop[];
  /** Whether the gradient uses repeating-*-gradient() */
  repeating: boolean;
}

/** Visual rendering properties */
export interface VisualProperties {
  /** Backdrop-filter blur radius in px */
  blurRadius: number;
  /** Element opacity (0-1) */
  opacity: number;
  /** Mix blend mode */
  blendMode: string;
  /** Whether an overlay layer is present */
  hasOverlay: boolean;
  /** Number of background layers */
  layers: number;
}

/** Animation information */
export interface AnimationInfo {
  /** Whether this background is animated */
  isAnimated: boolean;
  /** CSS animation name */
  animationName?: string;
  /** Animation duration */
  duration?: string;
  /** Timing function */
  easing?: string;
}

/** Performance characteristics */
export interface PerformanceInfo {
  /** Whether GPU acceleration is likely */
  gpuAccelerated: boolean;
  /** Whether changes trigger repaint */
  triggersPaint: boolean;
  /** Estimated rendering impact */
  estimatedImpact: 'low' | 'medium' | 'high';
}

/** Single detected background design */
export interface BackgroundDesignDetection {
  /** Descriptive name (e.g., "Hero section linear gradient") */
  name: string;
  /** Design type classification */
  designType: BackgroundDesignType;
  /** CSS selector */
  selector: string;
  /** Raw CSS background value */
  cssValue: string;
  /** Order in page (0-based) */
  positionIndex: number;
  /** Color information */
  colorInfo: ColorInfo;
  /** Gradient-specific information (present for gradient types) */
  gradientInfo?: GradientInfo;
  /** Visual rendering properties */
  visualProperties: VisualProperties;
  /** Animation information (present for animated backgrounds) */
  animationInfo?: AnimationInfo;
  /** Reconstructed CSS implementation */
  cssImplementation: string;
  /** Performance characteristics */
  performance: PerformanceInfo;
  /** Detection confidence (0-1) */
  confidence: number;
}

/** Input for background design detection */
export interface BackgroundDesignDetectorInput {
  /** Full CSS content */
  cssContent: string;
  /** Optional HTML for context (video detection, style tags) */
  htmlContent?: string;
  /** External CSS content */
  externalCssContent?: string;
}

/** Result of background design detection */
export interface BackgroundDesignDetectorResult {
  /** Detected backgrounds */
  backgrounds: BackgroundDesignDetection[];
  /** Total number of detected backgrounds */
  totalDetected: number;
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/** Service interface */
export interface BackgroundDesignDetectorService {
  /**
   * Detect background designs from CSS/HTML content
   * @param input - CSS content and optional HTML/external CSS
   * @returns Detection results
   * @throws Error if input exceeds 5MB size limit
   */
  detect(input: BackgroundDesignDetectorInput): BackgroundDesignDetectorResult;
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum CSS content size in bytes (5MB) */
const MAX_INPUT_SIZE_BYTES = 5 * 1024 * 1024;

/** Named CSS colors (subset for detection) */
const NAMED_COLORS: ReadonlySet<string> = new Set([
  'transparent', 'currentcolor',
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple',
  'pink', 'cyan', 'magenta', 'lime', 'aqua', 'navy', 'teal', 'maroon',
  'olive', 'silver', 'gray', 'grey', 'fuchsia', 'coral', 'salmon',
  'crimson', 'darkcyan', 'darkblue', 'darkgreen', 'darkred', 'darkgray',
  'lightgray', 'lightblue', 'lightgreen', 'lightyellow', 'beige', 'ivory',
  'gold', 'indigo', 'violet', 'plum', 'khaki', 'lavender', 'linen',
  'wheat', 'tomato', 'turquoise', 'peru', 'orchid', 'sienna', 'tan',
  'thistle', 'snow', 'seashell', 'mintcream', 'aliceblue', 'ghostwhite',
  'whitesmoke', 'honeydew', 'azure', 'floralwhite', 'oldlace', 'cornsilk',
  'papayawhip', 'blanchedalmond', 'bisque', 'moccasin', 'navajowhite',
  'peachpuff', 'mistyrose', 'antiquewhite', 'lemonchiffon',
]);

/** Image file extensions */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.tiff',
]);

/** Direction keywords to angle mapping */
const DIRECTION_ANGLE_MAP: Record<string, number> = {
  'to top': 0,
  'to top right': 45,
  'to right': 90,
  'to bottom right': 135,
  'to bottom': 180,
  'to bottom left': 225,
  'to left': 270,
  'to top left': 315,
};

// =============================================================================
// Parsed CSS Types
// =============================================================================

/** Parsed CSS rule with selector and property map */
interface ParsedRule {
  selector: string;
  properties: Map<string, string>;
}

/** Parsed gradient match */
interface GradientMatch {
  type: 'linear' | 'radial' | 'conic';
  fullMatch: string;
  args: string;
  isRepeating: boolean;
}

// =============================================================================
// CSS Parsing Functions
// =============================================================================

/**
 * Remove CSS comments from content
 * @param css - Raw CSS content
 * @returns CSS without comments
 */
function removeComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Extract CSS from HTML <style> tags
 * @param html - HTML content
 * @returns Extracted CSS content
 */
function extractCSSFromHTML(html: string): string {
  const parts: string[] = [];
  const styleTagRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let match: RegExpExecArray | null;

  while ((match = styleTagRegex.exec(html)) !== null) {
    if (match[1]) {
      parts.push(match[1]);
    }
  }

  return parts.join('\n');
}

/**
 * Extract inline style attributes from HTML that contain background-related properties.
 * Converts inline styles to synthetic CSS rules for the detection pipeline.
 * Deduplicates identical style values to avoid counting repeated patterns.
 * @param html - HTML content
 * @returns CSS-like string with synthetic selectors
 */
function extractInlineStylesFromHTML(html: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  // Match style="..." attributes (double quotes only; single quotes handled separately)
  const inlineStyleRegex = /style\s*=\s*"([^"]*)"/gi;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = inlineStyleRegex.exec(html)) !== null) {
    const styleValue = match[1]?.trim();
    if (!styleValue) continue;

    // Only include if it has background-related properties
    if (!/background(?:-color|-image|-size|-position|-repeat|-attachment|-blend-mode)?|backdrop-filter/i.test(styleValue)) {
      continue;
    }

    // Deduplicate identical style values
    const normalized = styleValue.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    parts.push(`[data-inline-bg-${index}] { ${styleValue} }`);
    index++;
  }

  return parts.join('\n');
}

/**
 * Parse CSS content into rules with selectors and properties.
 * Handles nested @media/@supports blocks by extracting inner rules.
 * @param css - CSS content (comments already removed)
 * @returns Array of parsed rules
 */
function parseCSSRules(css: string): ParsedRule[] {
  const rules: ParsedRule[] = [];
  const cleaned = removeComments(css);

  // First, expand nested at-rules so inner selectors are parsed as rules
  const expanded = expandAtRules(cleaned);

  // Match selector { declarations } blocks (simple, non-nested)
  const ruleRegex = /([^{}@]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = ruleRegex.exec(expanded)) !== null) {
    const selector = match[1]?.trim() ?? '';
    const block = match[2] ?? '';

    // Skip at-rules that aren't selectors (e.g. @keyframes name)
    if (selector.startsWith('@') && !selector.startsWith('@media') && !selector.startsWith('@supports')) {
      continue;
    }

    if (!selector) continue;

    const properties = parseDeclarations(block);
    if (properties.size > 0) {
      rules.push({ selector, properties });
    }
  }

  return rules;
}

/**
 * Expand @media and @supports blocks into flat rule list.
 * Removes the @-rule wrapper, keeping inner content.
 * @param css - CSS with possible at-rules
 * @returns Flattened CSS string
 */
function expandAtRules(css: string): string {
  // Replace @media (...) { ... } with just the inner content
  // Handles one level of nesting (sufficient for background detection)
  let result = css;

  // Match @media / @supports blocks
  const atRuleRegex = /@(?:media|supports)[^{]*\{([\s\S]*?\})\s*\}/g;
  let match: RegExpExecArray | null;
  const replacements: Array<{ start: number; end: number; inner: string }> = [];

  while ((match = atRuleRegex.exec(result)) !== null) {
    replacements.push({
      start: match.index,
      end: match.index + match[0].length,
      inner: match[1] ?? '',
    });
  }

  // Apply replacements in reverse order to preserve indices
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i]!;
    result = result.slice(0, r.start) + r.inner + result.slice(r.end);
  }

  return result;
}

/**
 * Parse CSS declaration block into property-value map
 * @param block - CSS declarations (without braces)
 * @returns Map of property -> value
 */
function parseDeclarations(block: string): Map<string, string> {
  const props = new Map<string, string>();
  const pairs = block.split(';');

  for (const pair of pairs) {
    const colonIndex = pair.indexOf(':');
    if (colonIndex > 0) {
      const property = pair.substring(0, colonIndex).trim().toLowerCase();
      const value = pair.substring(colonIndex + 1).trim();
      if (property && value) {
        props.set(property, value);
      }
    }
  }

  return props;
}

/**
 * Extract gradient function matches from a CSS value.
 * Handles nested parentheses correctly.
 * @param value - CSS property value
 * @returns Array of gradient matches
 */
function extractGradientMatches(value: string): GradientMatch[] {
  const matches: GradientMatch[] = [];
  const gradientRegex = /(repeating-)?(linear|radial|conic)-gradient\(/g;
  let regexMatch: RegExpExecArray | null;

  while ((regexMatch = gradientRegex.exec(value)) !== null) {
    const isRepeating = !!regexMatch[1];
    const type = regexMatch[2] as 'linear' | 'radial' | 'conic';
    const startIndex = regexMatch.index;
    const openParenIndex = startIndex + regexMatch[0].length - 1;

    // Find matching closing parenthesis
    let depth = 1;
    let i = openParenIndex + 1;
    while (i < value.length && depth > 0) {
      if (value[i] === '(') depth++;
      if (value[i] === ')') depth--;
      i++;
    }

    const fullMatch = value.substring(startIndex, i);
    const args = value.substring(openParenIndex + 1, i - 1);

    matches.push({ type, fullMatch, args, isRepeating });
  }

  return matches;
}

// =============================================================================
// Gradient Parsing Functions
// =============================================================================

/**
 * Split gradient arguments by top-level commas (respecting parentheses)
 * @param args - Gradient function arguments
 * @returns Array of argument parts
 */
function splitGradientArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const char of args) {
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

  return parts;
}

/**
 * Parse linear gradient direction/angle from first argument
 * @param firstArg - First argument of linear-gradient()
 * @returns Angle in degrees or undefined
 */
function parseLinearAngle(firstArg: string): number | undefined {
  const lower = firstArg.toLowerCase().trim();

  // Check for angle (e.g., "135deg")
  const angleMatch = lower.match(/^(-?\d+(?:\.\d+)?)(deg|grad|rad|turn)$/);
  if (angleMatch) {
    let val = parseFloat(angleMatch[1]!);
    const unit = angleMatch[2];
    switch (unit) {
      case 'grad': val = (val * 360) / 400; break;
      case 'rad': val = (val * 180) / Math.PI; break;
      case 'turn': val = val * 360; break;
    }
    return val;
  }

  // Check direction keywords
  for (const [keyword, angle] of Object.entries(DIRECTION_ANGLE_MAP)) {
    if (lower === keyword) {
      return angle;
    }
  }

  return undefined;
}

/**
 * Check if a string is a direction/position specifier (not a color stop)
 * @param part - Gradient argument part
 * @returns True if the part is a direction/position
 */
function isDirectionOrPosition(part: string): boolean {
  const lower = part.toLowerCase().trim();
  return (
    /^(-?\d+(?:\.\d+)?)(deg|grad|rad|turn)$/.test(lower) ||
    lower.startsWith('to ') ||
    lower.startsWith('from ') ||
    lower === 'circle' ||
    lower === 'ellipse' ||
    /^(circle|ellipse)\s/.test(lower) ||
    lower.includes(' at ')
  );
}

/**
 * Parse color stops from gradient arguments
 * @param args - Gradient function arguments string
 * @returns Array of gradient stops
 */
function parseColorStops(args: string): GradientStop[] {
  const parts = splitGradientArgs(args);
  const stops: GradientStop[] = [];
  let startIdx = 0;

  // Skip direction/position arguments
  if (parts.length > 0 && isDirectionOrPosition(parts[0]!)) {
    startIdx = 1;
  }

  const colorParts = parts.slice(startIdx);
  for (let i = 0; i < colorParts.length; i++) {
    const part = colorParts[i]!.trim();

    // Extract position percentage if present
    const posMatch = part.match(/(\d+(?:\.\d+)?%)\s*$/);
    let position: number;
    if (posMatch) {
      position = parseFloat(posMatch[1]!) / 100;
    } else if (i === 0) {
      position = 0;
    } else if (i === colorParts.length - 1) {
      position = 1;
    } else {
      position = i / (colorParts.length - 1);
    }

    // Extract color part (remove position)
    const colorPart = part.replace(/\s+\d+(?:\.\d+)?%\s*$/, '').trim();

    if (colorPart) {
      stops.push({ color: colorPart, position });
    }
  }

  return stops;
}

// =============================================================================
// Color Analysis Functions
// =============================================================================

/**
 * Check if a CSS color value has alpha transparency
 * @param value - CSS color value
 * @returns True if the color has alpha
 */
function colorHasAlpha(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes('rgba(') ||
    lower.includes('hsla(') ||
    lower.includes('oklch(') ||
    /transparent/i.test(lower) ||
    // Modern CSS color functions with alpha: rgb(r g b / a) or hsl(h s l / a)
    /(?:rgb|hsl)\([^)]*\/\s*[\d.]+/.test(lower)
  );
}

/**
 * Detect color space from a CSS color value
 * @param value - CSS color value
 * @returns Detected color space
 */
function detectColorSpace(value: string): 'srgb' | 'oklch' | 'p3' {
  const lower = value.toLowerCase();
  if (lower.includes('oklch(') || lower.includes('oklch ')) return 'oklch';
  if (lower.includes('color(display-p3') || lower.includes('color(p3')) return 'p3';
  return 'srgb';
}

/**
 * Extract distinct colors from a CSS value
 * @param value - CSS property value
 * @returns Array of color strings
 */
function extractColorsFromValue(value: string): string[] {
  const colors: string[] = [];

  // HEX colors
  const hexMatches = value.match(/#[0-9a-fA-F]{3,8}\b/g);
  if (hexMatches) {
    colors.push(...hexMatches.map((c) => c.toLowerCase()));
  }

  // rgb/rgba
  const rgbMatches = value.match(/rgba?\([^)]+\)/g);
  if (rgbMatches) {
    colors.push(...rgbMatches);
  }

  // hsl/hsla
  const hslMatches = value.match(/hsla?\([^)]+\)/g);
  if (hslMatches) {
    colors.push(...hslMatches);
  }

  // oklch
  const oklchMatches = value.match(/oklch\([^)]+\)/g);
  if (oklchMatches) {
    colors.push(...oklchMatches);
  }

  // Named colors (only at word boundaries, not inside function names)
  const words = value.split(/[\s,()]+/);
  for (const word of words) {
    const lw = word.toLowerCase().replace(/;$/, '');
    if (NAMED_COLORS.has(lw) && lw !== 'transparent' && lw !== 'currentcolor') {
      colors.push(lw);
    }
  }

  return colors;
}

// =============================================================================
// Classification Logic
// =============================================================================

/**
 * Detect if a CSS rule represents a video background (via HTML context)
 * @param htmlContent - HTML content
 * @param selector - CSS selector
 * @param props - CSS properties
 * @returns True if video background detected
 */
function isVideoBackground(
  htmlContent: string | undefined,
  selector: string,
  props: Map<string, string>
): boolean {
  if (!htmlContent) return false;

  // Check if HTML has a <video> element
  const hasVideo = /<video\b[^>]*>/i.test(htmlContent);
  if (!hasVideo) return false;

  // Check if the selector targets a video-related element
  const selectorLower = selector.toLowerCase();
  const hasVideoSelector = (
    selectorLower.includes('video') ||
    selectorLower.includes('bg-video') ||
    selectorLower.includes('background-video')
  );

  // Check for full-coverage positioning
  const hasPositioning = (
    props.get('position') === 'absolute' || props.get('position') === 'fixed'
  );
  const hasFullSize = (
    props.get('width') === '100%' && props.get('height') === '100%'
  );
  const hasObjectFit = props.has('object-fit');

  return hasVideoSelector && (hasPositioning || hasFullSize || hasObjectFit);
}

/**
 * Detect noise texture from SVG data URI
 * @param value - CSS background value
 * @returns True if noise texture detected
 */
function isNoiseTexture(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes('feturbulence') ||
    lower.includes('fractalNoise'.toLowerCase()) ||
    (lower.includes('url(') && lower.includes('noise'))
  );
}

/**
 * Detect SVG background
 * @param value - CSS background value
 * @returns True if SVG background detected
 */
function isSVGBackground(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes('.svg') ||
    lower.includes('data:image/svg+xml') ||
    lower.includes("data:image/svg+xml,")
  );
}

/**
 * Detect image background (non-SVG)
 * @param value - CSS background value
 * @returns True if image background detected
 */
function isImageBackground(value: string): boolean {
  const lower = value.toLowerCase();
  if (!lower.includes('url(')) return false;

  // Check for image file extensions
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.includes(ext)) return true;
  }

  // Check for data URI images (non-SVG)
  if (lower.includes('data:image/') && !lower.includes('data:image/svg')) {
    return true;
  }

  return false;
}

/**
 * Detect pattern background (repeating small image)
 * @param value - CSS background-image value
 * @param props - All CSS properties
 * @returns True if pattern background detected
 */
function isPatternBackground(value: string, props: Map<string, string>): boolean {
  if (!value.toLowerCase().includes('url(')) return false;

  const repeat = props.get('background-repeat')?.toLowerCase() ?? '';
  const size = props.get('background-size')?.toLowerCase() ?? '';

  // Check for explicit repeat + small size
  const hasRepeat = repeat === 'repeat' || repeat === 'repeat-x' || repeat === 'repeat-y';
  const hasSmallSize = /\d+px\s+\d+px/.test(size) && !size.includes('cover') && !size.includes('contain');

  return hasRepeat && hasSmallSize;
}

/**
 * Detect glassmorphism (backdrop-filter blur + semi-transparent background)
 * @param props - CSS properties
 * @returns Blur radius if glassmorphism detected, 0 otherwise
 */
function detectGlassmorphismBlur(props: Map<string, string>): number {
  const backdrop = props.get('backdrop-filter') ?? props.get('-webkit-backdrop-filter') ?? '';
  const blurMatch = backdrop.match(/blur\((\d+(?:\.\d+)?)(px)?\)/);

  if (blurMatch) {
    return parseFloat(blurMatch[1]!);
  }

  return 0;
}

/**
 * Check if a background value contains multiple layers (comma-separated backgrounds)
 * @param value - CSS background value
 * @returns Number of layers
 */
function countBackgroundLayers(value: string): number {
  // Split by top-level commas (respecting parentheses)
  const layers = splitGradientArgs(value);
  return layers.length;
}

/**
 * Check if the background looks like a mesh gradient
 * (multiple overlapping radial gradients with transparent edges)
 * @param value - CSS background value
 * @returns True if mesh gradient pattern detected
 */
function isMeshGradient(value: string): boolean {
  const gradients = extractGradientMatches(value);
  const radialGradients = gradients.filter((g) => g.type === 'radial');

  if (radialGradients.length < 3) return false;

  // Check if most radial gradients fade to transparent
  let transparentCount = 0;
  for (const g of radialGradients) {
    if (g.args.toLowerCase().includes('transparent')) {
      transparentCount++;
    }
  }

  return transparentCount >= 2;
}

/**
 * Detect animation info from CSS properties
 * @param props - CSS properties
 * @returns Animation info or undefined
 */
function detectAnimationInfo(props: Map<string, string>): AnimationInfo | undefined {
  // Check for animation shorthand
  const animationShorthand = props.get('animation');
  if (animationShorthand) {
    const parts = animationShorthand.split(/\s+/);
    const info: AnimationInfo = { isAnimated: true };

    for (const part of parts) {
      if (/^\d+(\.\d+)?(s|ms)$/.test(part)) {
        if (!info.duration) {
          info.duration = part;
        }
      } else if (/^(ease|linear|ease-in|ease-out|ease-in-out|cubic-bezier\([^)]+\)|steps\([^)]+\))$/.test(part)) {
        info.easing = part;
      } else if (!/^(infinite|\d+)$/.test(part) && !/^(normal|reverse|alternate|alternate-reverse)$/.test(part) && !/^(none|forwards|backwards|both)$/.test(part) && !/^\d+(\.\d+)?(s|ms)$/.test(part)) {
        if (!info.animationName) {
          info.animationName = part;
        }
      }
    }

    return info;
  }

  // Check for individual animation properties
  const animName = props.get('animation-name');
  if (animName && animName !== 'none') {
    const info: AnimationInfo = {
      isAnimated: true,
      animationName: animName,
    };
    const dur = props.get('animation-duration');
    if (dur) info.duration = dur;
    const timing = props.get('animation-timing-function');
    if (timing) info.easing = timing;
    return info;
  }

  // Check for transition on background
  const transition = props.get('transition');
  if (transition) {
    const lower = transition.toLowerCase();
    if (lower.includes('background') || lower.includes('all')) {
      return { isAnimated: true };
    }
  }

  const transitionProp = props.get('transition-property');
  if (transitionProp) {
    const lower = transitionProp.toLowerCase();
    if (lower.includes('background') || lower.includes('all')) {
      return { isAnimated: true };
    }
  }

  return undefined;
}

/**
 * Assess performance impact of a background
 * @param detection - Partial detection (enough to assess)
 * @param props - CSS properties
 * @returns Performance info
 */
function assessPerformance(
  designType: BackgroundDesignType,
  gradientStopCount: number,
  blurRadius: number,
  layerCount: number,
  props: Map<string, string>
): PerformanceInfo {
  const hasWillChange = props.has('will-change');
  const hasTransform = props.has('transform');
  const hasContain = props.get('contain')?.includes('paint') ?? false;
  const gpuAccelerated = hasWillChange || hasTransform || hasContain;

  // Most background changes trigger paint
  const triggersPaint = designType !== 'solid_color';

  // Estimate impact
  let impact: 'low' | 'medium' | 'high' = 'low';

  if (blurRadius > 0 || layerCount > 3 || gradientStopCount > 10) {
    impact = 'high';
  } else if (
    designType === 'animated_gradient' ||
    designType === 'video_background' ||
    layerCount > 1 ||
    gradientStopCount > 5
  ) {
    impact = 'medium';
  }

  return { gpuAccelerated, triggersPaint, estimatedImpact: impact };
}

/**
 * Generate a descriptive name for a background detection
 * @param designType - Detected design type
 * @param selector - CSS selector
 * @param gradientInfo - Optional gradient info
 * @param colorInfo - Color info
 * @returns Descriptive name
 */
function generateName(
  designType: BackgroundDesignType,
  selector: string,
  gradientInfo: GradientInfo | undefined,
  colorInfo: ColorInfo
): string {
  // Clean selector for name (take first class or element)
  const selectorPart = selector.replace(/[.#[\]:>+~ ]/g, ' ').trim().split(/\s+/)[0] ?? 'element';

  switch (designType) {
    case 'solid_color':
      return `${selectorPart} solid color background`;
    case 'linear_gradient': {
      const angle = gradientInfo?.angle !== undefined ? `, ${gradientInfo.angle}deg` : '';
      return `${selectorPart} linear gradient${angle}`;
    }
    case 'radial_gradient':
      return `${selectorPart} radial gradient`;
    case 'conic_gradient':
      return `${selectorPart} conic gradient`;
    case 'mesh_gradient':
      return `${selectorPart} mesh gradient (${colorInfo.colorCount} colors)`;
    case 'image_background':
      return `${selectorPart} image background`;
    case 'pattern_background':
      return `${selectorPart} pattern background`;
    case 'svg_background':
      return `${selectorPart} SVG background`;
    case 'noise_texture':
      return `${selectorPart} noise texture`;
    case 'video_background':
      return `${selectorPart} video background`;
    case 'animated_gradient':
      return `${selectorPart} animated gradient`;
    case 'glassmorphism':
      return `${selectorPart} glassmorphism`;
    case 'multi_layer':
      return `${selectorPart} multi-layer background`;
    default:
      return `${selectorPart} background`;
  }
}

/**
 * Reconstruct CSS implementation from detection
 * @param props - CSS properties
 * @returns Reconstructed CSS string
 */
function reconstructCSS(props: Map<string, string>): string {
  const bgProps = [
    'background', 'background-color', 'background-image', 'background-size',
    'background-repeat', 'background-position', 'background-blend-mode',
    'backdrop-filter', '-webkit-backdrop-filter', 'opacity',
    'mix-blend-mode', 'will-change',
  ];

  const lines: string[] = [];
  for (const prop of bgProps) {
    const val = props.get(prop);
    if (val) {
      lines.push(`  ${prop}: ${val};`);
    }
  }

  return lines.join('\n');
}

// =============================================================================
// Main Classification
// =============================================================================

/**
 * Classify a CSS rule into a background design detection
 * @param rule - Parsed CSS rule
 * @param positionIndex - Position in CSS
 * @param htmlContent - Optional HTML content for context
 * @param keyframesNames - Set of detected @keyframes names
 * @returns Detection or null if no background found
 */
function classifyRule(
  rule: ParsedRule,
  positionIndex: number,
  htmlContent: string | undefined,
  keyframesNames: Set<string>
): BackgroundDesignDetection | null {
  const props = rule.properties;

  // Get all background-related values
  const bgValue = props.get('background') ?? '';
  const bgColor = props.get('background-color') ?? '';
  const bgImage = props.get('background-image') ?? '';
  const combinedValue = [bgValue, bgColor, bgImage].filter(Boolean).join(' ');

  // Check for video background first (doesn't need background CSS properties)
  const hasBackdropFilter = props.has('backdrop-filter') || props.has('-webkit-backdrop-filter');
  const isVideo = isVideoBackground(htmlContent, rule.selector, props);

  if (!combinedValue && !hasBackdropFilter && !isVideo) {
    return null;
  }

  // Extract visual properties
  const blurRadius = detectGlassmorphismBlur(props);
  const opacityStr = props.get('opacity');
  const opacity = opacityStr ? parseFloat(opacityStr) : 1;
  const blendMode = props.get('mix-blend-mode') ?? props.get('background-blend-mode') ?? 'normal';
  const primaryBgValue = bgValue || bgImage || bgColor;
  const layerCount = primaryBgValue ? countBackgroundLayers(primaryBgValue) : 1;

  // Extract colors from all background values
  const allColors = extractColorsFromValue(combinedValue);
  const hasAlpha = colorHasAlpha(combinedValue);
  const colorSpace = detectColorSpace(combinedValue);

  // Extract gradient matches
  const gradientMatches = extractGradientMatches(combinedValue);

  // Detect animation info
  const animationInfo = detectAnimationInfo(props);

  // Check if animation involves background (by matching @keyframes)
  let hasBackgroundAnimation = false;
  if (animationInfo?.isAnimated && animationInfo.animationName) {
    hasBackgroundAnimation = keyframesNames.has(animationInfo.animationName);
  }
  // Also consider transitions on background as animation
  if (animationInfo?.isAnimated && !animationInfo.animationName) {
    hasBackgroundAnimation = true;
  }

  // Classify design type
  let designType: BackgroundDesignType = 'unknown';
  let gradientInfo: GradientInfo | undefined;
  let hasOverlay = false;
  let confidence = 0.5;

  // Priority classification
  if (isVideo) {
    designType = 'video_background';
    confidence = 0.9;
  } else if (isNoiseTexture(combinedValue)) {
    designType = 'noise_texture';
    confidence = 0.85;
  } else if (blurRadius > 0 && hasAlpha) {
    designType = 'glassmorphism';
    confidence = 0.9;
  } else if (isMeshGradient(primaryBgValue)) {
    designType = 'mesh_gradient';
    confidence = 0.85;

    // For mesh gradient, use the first radial gradient info
    const firstRadial = gradientMatches.find((g) => g.type === 'radial');
    if (firstRadial) {
      gradientInfo = {
        type: 'radial',
        stops: parseColorStops(firstRadial.args),
        repeating: firstRadial.isRepeating,
      };
    }
  } else if (gradientMatches.length > 0 && layerCount >= 2 && !isMeshGradient(primaryBgValue)) {
    // Multi-layer: gradient + something else (or multiple backgrounds)
    const hasUrl = combinedValue.toLowerCase().includes('url(');
    if (hasUrl || (gradientMatches.length >= 1 && layerCount >= 2)) {
      designType = 'multi_layer';
      confidence = 0.85;
      hasOverlay = gradientMatches.some((g) => {
        const lower = g.args.toLowerCase();
        return lower.includes('rgba(') || lower.includes('transparent');
      });
    }
  } else if (gradientMatches.length > 0) {
    // Single gradient
    const gm = gradientMatches[0]!;

    // Check if animated
    if (hasBackgroundAnimation) {
      designType = 'animated_gradient';
      confidence = 0.9;
    } else {
      switch (gm.type) {
        case 'linear':
          designType = 'linear_gradient';
          break;
        case 'radial':
          designType = 'radial_gradient';
          break;
        case 'conic':
          designType = 'conic_gradient';
          break;
      }
      confidence = 0.9;
    }

    // Parse gradient info
    const stops = parseColorStops(gm.args);
    gradientInfo = {
      type: gm.type,
      stops,
      repeating: gm.isRepeating,
    };

    if (gm.type === 'linear') {
      const parts = splitGradientArgs(gm.args);
      if (parts.length > 0) {
        const angle = parseLinearAngle(parts[0]!);
        if (angle !== undefined) {
          gradientInfo.angle = angle;
        }
      }
    }
  } else if (isPatternBackground(bgValue || bgImage, props)) {
    designType = 'pattern_background';
    confidence = 0.8;
  } else if (isSVGBackground(combinedValue)) {
    designType = 'svg_background';
    confidence = 0.85;
  } else if (isImageBackground(combinedValue)) {
    designType = 'image_background';
    confidence = 0.85;
  } else if (bgColor || bgValue) {
    // Solid color: no gradients, no images
    const hasUrl = combinedValue.toLowerCase().includes('url(');
    const hasGradient = gradientMatches.length > 0;
    if (!hasUrl && !hasGradient) {
      designType = 'solid_color';
      confidence = 0.95;
    }
  }

  if (designType === 'unknown') {
    return null;
  }

  const colorInfo: ColorInfo = {
    dominantColors: [...new Set(allColors)],
    colorCount: new Set(allColors).size,
    hasAlpha,
    colorSpace,
  };

  const visualProperties: VisualProperties = {
    blurRadius,
    opacity,
    blendMode,
    hasOverlay,
    layers: layerCount,
  };

  const gradientStopCount = gradientInfo?.stops.length ?? 0;
  const perfInfo = assessPerformance(designType, gradientStopCount, blurRadius, layerCount, props);
  const name = generateName(designType, rule.selector, gradientInfo, colorInfo);
  const cssImplementation = reconstructCSS(props);

  const detection: BackgroundDesignDetection = {
    name,
    designType,
    selector: rule.selector,
    cssValue: primaryBgValue,
    positionIndex,
    colorInfo,
    visualProperties,
    cssImplementation,
    performance: perfInfo,
    confidence,
  };

  if (gradientInfo) {
    detection.gradientInfo = gradientInfo;
  }

  if (animationInfo) {
    detection.animationInfo = animationInfo;
  }

  return detection;
}

/**
 * Extract @keyframes names that animate background-related properties
 * @param css - Full CSS content
 * @returns Set of keyframe animation names that affect backgrounds
 */
function extractBackgroundKeyframes(css: string): Set<string> {
  const names = new Set<string>();
  const cleaned = removeComments(css);

  // Match @keyframes blocks
  const keyframeRegex = /@keyframes\s+([\w-]+)\s*\{([\s\S]*?\})\s*\}/g;
  let match: RegExpExecArray | null;

  while ((match = keyframeRegex.exec(cleaned)) !== null) {
    const name = match[1];
    const body = match[2] ?? '';
    // Check if the keyframe affects background properties
    if (
      body.includes('background') ||
      body.includes('gradient') ||
      body.includes('background-position') ||
      body.includes('background-color') ||
      body.includes('background-size')
    ) {
      if (name) {
        names.add(name);
      }
    }
  }

  return names;
}

// =============================================================================
// Service Implementation
// =============================================================================

/**
 * Internal implementation of BackgroundDesignDetectorService
 */
class BackgroundDesignDetectorServiceImpl implements BackgroundDesignDetectorService {
  /**
   * Detect background designs from CSS/HTML content
   * @param input - CSS content and optional HTML/external CSS
   * @returns Detection results
   * @throws Error if input exceeds 5MB size limit
   */
  detect(input: BackgroundDesignDetectorInput): BackgroundDesignDetectorResult {
    const startTime = performance.now();

    // Validate input size (SEC H-1)
    const totalSize = (input.cssContent?.length ?? 0)
      + (input.htmlContent?.length ?? 0)
      + (input.externalCssContent?.length ?? 0);

    if (totalSize > MAX_INPUT_SIZE_BYTES) {
      throw new Error(`Input size ${totalSize} bytes exceeds maximum of ${MAX_INPUT_SIZE_BYTES} bytes (5MB)`);
    }

    // Handle empty input
    if (!input.cssContent && !input.htmlContent && !input.externalCssContent) {
      return { backgrounds: [], totalDetected: 0, processingTimeMs: performance.now() - startTime };
    }

    try {
      // Combine all CSS sources
      let combinedCSS = input.cssContent ?? '';

      // Extract CSS from HTML (<style> tags + inline style attributes)
      if (input.htmlContent) {
        const htmlCSS = extractCSSFromHTML(input.htmlContent);
        combinedCSS += '\n' + htmlCSS;

        const inlineCSS = extractInlineStylesFromHTML(input.htmlContent);
        combinedCSS += '\n' + inlineCSS;
      }

      // Append external CSS
      if (input.externalCssContent) {
        combinedCSS += '\n' + input.externalCssContent;
      }

      // Resolve CSS variables (var(--name) → actual values)
      const cssVarResolver = new CssVariableResolver({ maxDepth: 10 });
      if (input.htmlContent) {
        cssVarResolver.extractVariablesFromHtml(input.htmlContent);
      }
      cssVarResolver.extractVariablesFromCss(combinedCSS);

      // Extract @keyframes that affect backgrounds
      const keyframesNames = extractBackgroundKeyframes(combinedCSS);

      // Parse CSS rules
      const rules = parseCSSRules(combinedCSS);

      // Resolve CSS variables in background-related property values
      for (const rule of rules) {
        for (const [prop, value] of rule.properties) {
          if (/var\s*\(\s*--/.test(value)) {
            const result = cssVarResolver.resolve(value);
            if (result.success && result.resolvedValue) {
              rule.properties.set(prop, result.resolvedValue);
            }
          }
        }
      }

      // Classify each rule
      const rawBackgrounds: BackgroundDesignDetection[] = [];
      let positionIndex = 0;

      for (const rule of rules) {
        const detection = classifyRule(rule, positionIndex, input.htmlContent, keyframesNames);
        if (detection) {
          rawBackgrounds.push(detection);
          positionIndex++;
        }
      }

      // Deduplicate: same designType + cssValue → keep first occurrence
      const seen = new Set<string>();
      const backgrounds: BackgroundDesignDetection[] = [];
      for (const bg of rawBackgrounds) {
        const key = `${bg.designType}::${bg.cssValue.replace(/\s+/g, ' ').toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          backgrounds.push(bg);
        }
      }

      const processingTimeMs = performance.now() - startTime;

      logger.debug('Detection complete', {
        totalDetected: backgrounds.length,
        processingTimeMs: processingTimeMs.toFixed(1),
        types: backgrounds.map((b) => b.designType),
      });

      return {
        backgrounds,
        totalDetected: backgrounds.length,
        processingTimeMs,
      };
    } catch (error) {
      // Re-throw size validation errors
      if (error instanceof Error && error.message.includes('exceeds maximum')) {
        throw error;
      }

      logger.error('Detection failed', error);

      return {
        backgrounds: [],
        totalDetected: 0,
        processingTimeMs: performance.now() - startTime,
      };
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new BackgroundDesignDetectorService instance
 * @returns BackgroundDesignDetectorService instance
 */
export function createBackgroundDesignDetectorService(): BackgroundDesignDetectorService {
  return new BackgroundDesignDetectorServiceImpl();
}
