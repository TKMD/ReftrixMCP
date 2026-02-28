// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visual Decoration Detector Service
 *
 * Detects visual decorations from HTML/CSS:
 * - Glow effects (box-shadow with blur)
 * - Gradient backgrounds (linear/radial/conic)
 * - Animated borders (border-image, animated effects)
 * - Glass morphism (backdrop-filter)
 *
 * @module services/visual-extractor/visual-decoration-detector.service
 */

import type {
  VisualDecoration,
  VisualDecorationsResult,
  VisualDecorationProperties,
} from '../../tools/layout/inspect/visual-extractors.schemas';

// =====================================================
// Types
// =====================================================

/**
 * CSS rule representation for parsing
 */
interface CSSRuleInfo {
  selector: string;
  properties: Map<string, string>;
}

/**
 * Parsed box-shadow value
 */
interface ParsedBoxShadow {
  inset: boolean;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: string;
}

/**
 * Parsed gradient value
 */
interface ParsedGradient {
  type: 'linear' | 'radial' | 'conic';
  angle?: number;
  colorStops: Array<{ color: string; position?: string | number }>;
  shape?: string;
  size?: string;
  position?: string;
  rawValue: string;
}

// =====================================================
// Regex Patterns
// =====================================================

/**
 * Regex patterns for CSS property parsing
 */
const PATTERNS = {
  // Box shadow: matches `inset? offsetX offsetY blur? spread? color`
  BOX_SHADOW:
    /(?<inset>inset\s+)?(?<offsetX>-?\d+(?:\.\d+)?(?:px|rem|em)?)\s+(?<offsetY>-?\d+(?:\.\d+)?(?:px|rem|em)?)\s+(?<blur>\d+(?:\.\d+)?(?:px|rem|em)?)?\s*(?<spread>-?\d+(?:\.\d+)?(?:px|rem|em)?)?\s*(?<color>(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-zA-Z]+))?/gi,

  // Gradient functions
  LINEAR_GRADIENT:
    /linear-gradient\s*\(\s*(?:(?<angle>-?\d+(?:\.\d+)?(?:deg|rad|turn|grad)?|to\s+(?:top|bottom|left|right)(?:\s+(?:top|bottom|left|right))?)\s*,\s*)?(?<stops>.+)\s*\)/gi,
  RADIAL_GRADIENT:
    /radial-gradient\s*\(\s*(?:(?<shape>circle|ellipse)?\s*(?<size>closest-side|closest-corner|farthest-side|farthest-corner|\d+(?:\.\d+)?(?:px|%|em|rem)?)?\s*(?:at\s+(?<position>[^,]+))?\s*,\s*)?(?<stops>.+)\s*\)/gi,
  CONIC_GRADIENT:
    /conic-gradient\s*\(\s*(?:from\s+(?<angle>-?\d+(?:\.\d+)?(?:deg|rad|turn|grad)?)\s*)?(?:at\s+(?<position>[^,]+)\s*,\s*)?(?<stops>.+)\s*\)/gi,

  // Backdrop filter
  BACKDROP_FILTER_BLUR: /blur\s*\(\s*(?<value>\d+(?:\.\d+)?(?:px|rem|em)?)\s*\)/i,
  BACKDROP_FILTER_SATURATE: /saturate\s*\(\s*(?<value>\d+(?:\.\d+)?%?)\s*\)/i,
  BACKDROP_FILTER_BRIGHTNESS: /brightness\s*\(\s*(?<value>\d+(?:\.\d+)?%?)\s*\)/i,

  // Border image
  BORDER_IMAGE_SOURCE: /border-image(?:-source)?\s*:\s*(?<value>[^;]+)/gi,

  // Animation
  ANIMATION_NAME: /animation(?:-name)?\s*:\s*(?<value>[^;,\s]+)/gi,
  ANIMATION_DURATION: /animation-duration\s*:\s*(?<value>[\d.]+(?:s|ms)?)/gi,

  // Color extraction
  COLOR:
    /#[0-9a-fA-F]{3,8}|rgba?\s*\([^)]+\)|hsla?\s*\([^)]+\)|(?:transparent|currentColor|inherit)/gi,

  // CSS rule parsing
  CSS_RULE: /([^{]+)\s*\{([^}]*)\}/g,
  CSS_PROPERTY: /([a-z-]+)\s*:\s*([^;]+)/gi,
};

// =====================================================
// Parser Functions
// =====================================================

/**
 * Parse CSS text into rules
 */
function parseCSSRules(cssText: string): CSSRuleInfo[] {
  const rules: CSSRuleInfo[] = [];
  const ruleRegex = new RegExp(PATTERNS.CSS_RULE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = ruleRegex.exec(cssText)) !== null) {
    const selectorPart = match[1];
    const propertiesPart = match[2];
    if (!selectorPart || !propertiesPart) continue;

    const selector = selectorPart.trim();
    const propertiesText = propertiesPart;
    const properties = new Map<string, string>();

    const propRegex = new RegExp(PATTERNS.CSS_PROPERTY.source, 'gi');
    let propMatch: RegExpExecArray | null;
    while ((propMatch = propRegex.exec(propertiesText)) !== null) {
      const propName = propMatch[1];
      const propValue = propMatch[2];
      if (propName && propValue) {
        properties.set(propName.trim().toLowerCase(), propValue.trim());
      }
    }

    if (selector && properties.size > 0) {
      rules.push({ selector, properties });
    }
  }

  return rules;
}

/**
 * Parse box-shadow value
 */
function parseBoxShadow(value: string): ParsedBoxShadow[] {
  const shadows: ParsedBoxShadow[] = [];

  // Split by comma for multiple shadows, but be careful with colors containing commas
  const shadowParts = splitShadowValues(value);

  for (const part of shadowParts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Check for inset
    const inset = trimmed.toLowerCase().startsWith('inset');
    const valueWithoutInset = inset ? trimmed.slice(5).trim() : trimmed;

    // Extract color first (it can be at the beginning or end)
    const colorMatch = valueWithoutInset.match(PATTERNS.COLOR);
    const color = colorMatch ? colorMatch[0] : '';
    const valueWithoutColor = valueWithoutInset.replace(PATTERNS.COLOR, '').trim();

    // Parse numeric values
    const numbers = valueWithoutColor.match(/-?\d+(?:\.\d+)?(?:px|rem|em)?/g) || [];
    const numericValues = numbers.map((n) => parseFloat(n));

    if (numericValues.length >= 2) {
      const offsetX = numericValues[0];
      const offsetY = numericValues[1];
      if (offsetX !== undefined && offsetY !== undefined) {
        shadows.push({
          inset,
          offsetX,
          offsetY,
          blur: numericValues[2] ?? 0,
          spread: numericValues[3] ?? 0,
          color: color || 'currentColor',
        });
      }
    }
  }

  return shadows;
}

/**
 * Split box-shadow values by comma, handling nested parentheses
 */
function splitShadowValues(value: string): string[] {
  const results: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of value) {
    if (char === '(') {
      depth++;
      current += char;
    } else if (char === ')') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      results.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    results.push(current.trim());
  }

  return results;
}

/**
 * Parse gradient value
 */
function parseGradient(value: string): ParsedGradient | null {
  // Normalize whitespace (replace newlines and multiple spaces with single space)
  const normalizedValue = value.replace(/\s+/g, ' ').trim();

  // Try linear gradient
  const linearMatch = normalizedValue.match(
    /linear-gradient\s*\(\s*((?:-?\d+(?:\.\d+)?(?:deg|rad|turn|grad)?|to\s+(?:top|bottom|left|right)(?:\s+(?:top|bottom|left|right))?)\s*,\s*)?(.+)\s*\)/i
  );
  if (linearMatch) {
    const angleStr = linearMatch[1]?.trim().replace(/,\s*$/, '');
    const stopsStr = linearMatch[2];
    const result: ParsedGradient = {
      type: 'linear',
      colorStops: parseColorStops(stopsStr ?? ''),
      rawValue: value,
    };
    const angle = parseAngle(angleStr);
    if (angle !== undefined) {
      result.angle = angle;
    }
    return result;
  }

  // Try radial gradient
  const radialMatch = normalizedValue.match(
    /radial-gradient\s*\(\s*(?:(circle|ellipse)?\s*(closest-side|closest-corner|farthest-side|farthest-corner|\d+(?:\.\d+)?(?:px|%|em|rem)?)?\s*(?:at\s+([^,]+))?\s*,\s*)?(.+)\s*\)/i
  );
  if (radialMatch) {
    const result: ParsedGradient = {
      type: 'radial',
      colorStops: parseColorStops(radialMatch[4] ?? ''),
      rawValue: value,
    };
    if (radialMatch[1]) {
      result.shape = radialMatch[1];
    }
    if (radialMatch[2]) {
      result.size = radialMatch[2];
    }
    const pos = radialMatch[3]?.trim();
    if (pos) {
      result.position = pos;
    }
    return result;
  }

  // Try conic gradient
  const conicMatch = normalizedValue.match(
    /conic-gradient\s*\(\s*(?:from\s+(-?\d+(?:\.\d+)?(?:deg|rad|turn|grad)?)\s*)?(?:at\s+([^,]+)\s*,\s*)?(.+)\s*\)/i
  );
  if (conicMatch) {
    const result: ParsedGradient = {
      type: 'conic',
      colorStops: parseColorStops(conicMatch[3] ?? ''),
      rawValue: value,
    };
    const angle = parseAngle(conicMatch[1]);
    if (angle !== undefined) {
      result.angle = angle;
    }
    const pos = conicMatch[2]?.trim();
    if (pos) {
      result.position = pos;
    }
    return result;
  }

  return null;
}

/**
 * Parse angle string to degrees
 */
function parseAngle(angleStr?: string): number | undefined {
  if (!angleStr) return undefined;

  // Handle "to direction" syntax
  if (angleStr.startsWith('to ')) {
    const direction = angleStr.slice(3).toLowerCase();
    const directionAngles: Record<string, number> = {
      top: 0,
      'top right': 45,
      right: 90,
      'bottom right': 135,
      bottom: 180,
      'bottom left': 225,
      left: 270,
      'top left': 315,
    };
    return directionAngles[direction];
  }

  // Parse numeric angle
  const numMatch = angleStr.match(/(-?\d+(?:\.\d+)?)(deg|rad|turn|grad)?/i);
  if (!numMatch || !numMatch[1]) return undefined;

  const value = parseFloat(numMatch[1]);
  const unit = (numMatch[2] ?? 'deg').toLowerCase();

  switch (unit) {
    case 'rad':
      return (value * 180) / Math.PI;
    case 'turn':
      return value * 360;
    case 'grad':
      return value * 0.9;
    default:
      return value;
  }
}

/**
 * Parse color stops from gradient
 */
function parseColorStops(stopsStr: string): Array<{ color: string; position?: string | number }> {
  const stops: Array<{ color: string; position?: string | number }> = [];

  // Split by comma, handling nested parentheses
  const parts = splitShadowValues(stopsStr);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Extract color
    const colorMatch = trimmed.match(PATTERNS.COLOR);
    if (colorMatch) {
      const color = colorMatch[0];
      // Extract position (percentage or length after color)
      const positionMatch = trimmed.slice(color.length).match(/(\d+(?:\.\d+)?%?)/);

      const stop: { color: string; position?: string | number } = { color };
      if (positionMatch?.[1]) {
        stop.position = positionMatch[1];
      }
      stops.push(stop);
    }
  }

  return stops;
}

/**
 * Parse backdrop-filter value
 */
function parseBackdropFilter(value: string): {
  blur?: number;
  saturation?: number;
  brightness?: number;
} {
  const result: { blur?: number; saturation?: number; brightness?: number } = {};

  // Parse blur
  const blurMatch = value.match(PATTERNS.BACKDROP_FILTER_BLUR);
  if (blurMatch?.groups?.value) {
    result.blur = parseFloat(blurMatch.groups.value);
  }

  // Parse saturate
  const saturateMatch = value.match(PATTERNS.BACKDROP_FILTER_SATURATE);
  if (saturateMatch?.groups?.value) {
    const val = parseFloat(saturateMatch.groups.value);
    result.saturation = saturateMatch.groups.value.includes('%') ? val / 100 : val;
  }

  // Parse brightness
  const brightnessMatch = value.match(PATTERNS.BACKDROP_FILTER_BRIGHTNESS);
  if (brightnessMatch?.groups?.value) {
    const val = parseFloat(brightnessMatch.groups.value);
    result.brightness = brightnessMatch.groups.value.includes('%') ? val / 100 : val;
  }

  return result;
}

// =====================================================
// Detection Functions
// =====================================================

/**
 * Detect glow effects from box-shadow
 */
function detectGlowEffects(rules: CSSRuleInfo[]): VisualDecoration[] {
  const decorations: VisualDecoration[] = [];

  for (const rule of rules) {
    const boxShadow = rule.properties.get('box-shadow');
    if (!boxShadow || boxShadow === 'none') continue;

    const shadows = parseBoxShadow(boxShadow);

    for (const shadow of shadows) {
      // Skip inset shadows - they are not glow effects
      if (shadow.inset) continue;

      // Glow effect criteria:
      // 1. Has blur (blur > 0)
      // 2. Offsets are near zero (0-2px is typical for glow)
      // Regular drop shadows have larger offsets (5px+)
      const hasBlur = shadow.blur > 0;
      const hasNearZeroOffset = Math.abs(shadow.offsetX) <= 2 && Math.abs(shadow.offsetY) <= 2;
      const isGlow = hasBlur && hasNearZeroOffset;

      if (isGlow) {
        // Calculate intensity from alpha if rgba
        let intensity: number | undefined;
        const rgbaMatch = shadow.color.match(/rgba?\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+))?\s*\)/i);
        if (rgbaMatch?.[1]) {
          intensity = parseFloat(rgbaMatch[1]);
        }

        const properties: VisualDecorationProperties = {
          color: shadow.color,
          blur: shadow.blur,
          spread: shadow.spread || undefined,
          intensity,
          inset: shadow.inset || undefined,
          rawValue: boxShadow,
        };

        // Calculate confidence based on glow characteristics
        let confidence = 0.7;
        if (shadow.blur >= 10) confidence += 0.1;
        if (Math.abs(shadow.offsetX) < 5 && Math.abs(shadow.offsetY) < 5) confidence += 0.1;
        if (shadow.spread > 0) confidence += 0.05;

        decorations.push({
          type: 'glow',
          element: rule.selector,
          properties,
          confidence: Math.min(confidence, 1),
        });
      }
    }
  }

  return decorations;
}

/**
 * Detect gradient backgrounds
 */
function detectGradientBackgrounds(rules: CSSRuleInfo[]): VisualDecoration[] {
  const decorations: VisualDecoration[] = [];

  for (const rule of rules) {
    // Check background and background-image properties
    const background = rule.properties.get('background') || rule.properties.get('background-image');
    if (!background) continue;

    // Check for gradient functions
    if (
      !background.includes('gradient') ||
      (!background.includes('linear-gradient') &&
        !background.includes('radial-gradient') &&
        !background.includes('conic-gradient'))
    ) {
      continue;
    }

    const gradient = parseGradient(background);
    if (!gradient) continue;

    const properties: VisualDecorationProperties = {
      gradientType: gradient.type,
      angle: gradient.angle,
      colorStops: gradient.colorStops,
      shape: gradient.shape,
      size: gradient.size,
      position: gradient.position,
      rawValue: gradient.rawValue,
    };

    // Calculate confidence based on gradient characteristics
    let confidence = 0.8;
    if (gradient.colorStops.length >= 2) confidence += 0.1;
    if (gradient.angle !== undefined) confidence += 0.05;

    decorations.push({
      type: 'gradient',
      element: rule.selector,
      properties,
      confidence: Math.min(confidence, 1),
    });
  }

  return decorations;
}

/**
 * Detect animated borders
 */
function detectAnimatedBorders(rules: CSSRuleInfo[]): VisualDecoration[] {
  const decorations: VisualDecoration[] = [];

  for (const rule of rules) {
    const properties: VisualDecorationProperties = {};
    let hasAnimatedBorder = false;
    let confidence = 0.5;

    // Check for border-image with gradient
    const borderImage = rule.properties.get('border-image') || rule.properties.get('border-image-source');
    if (borderImage && borderImage.includes('gradient')) {
      properties.borderImageSource = borderImage;
      properties.isGradientBorder = true;
      hasAnimatedBorder = true;
      confidence += 0.3;

      const borderImageSlice = rule.properties.get('border-image-slice');
      if (borderImageSlice) {
        properties.borderImageSlice = borderImageSlice;
      }
    }

    // Check for animation on border-related properties
    const animation = rule.properties.get('animation') || rule.properties.get('animation-name');
    if (animation && animation !== 'none') {
      // Check if the selector or animation name suggests border animation
      const isBorderAnimation =
        rule.selector.toLowerCase().includes('border') ||
        animation.toLowerCase().includes('border') ||
        animation.toLowerCase().includes('glow') ||
        animation.toLowerCase().includes('pulse') ||
        animation.toLowerCase().includes('ring');

      if (isBorderAnimation || hasAnimatedBorder) {
        // Parse animation name
        const animNameMatch = animation.match(/^([a-zA-Z_-][a-zA-Z0-9_-]*)/);
        if (animNameMatch) {
          properties.animationName = animNameMatch[1];
        }

        // Parse duration
        const durationMatch = animation.match(/([\d.]+)(s|ms)/i);
        if (durationMatch?.[1] && durationMatch[2]) {
          const value = parseFloat(durationMatch[1]);
          properties.duration = durationMatch[2].toLowerCase() === 'ms' ? value : value * 1000;
        }

        // Parse timing function
        const timingMatch = animation.match(
          /(ease|ease-in|ease-out|ease-in-out|linear|cubic-bezier\([^)]+\))/i
        );
        if (timingMatch) {
          properties.timingFunction = timingMatch[1];
        }

        // Check for infinite
        if (animation.includes('infinite')) {
          properties.iterationCount = 'infinite';
        }

        hasAnimatedBorder = true;
        confidence += 0.2;
      }
    }

    // Check for glowing border (box-shadow with border-radius)
    const boxShadow = rule.properties.get('box-shadow');
    const borderRadius = rule.properties.get('border-radius');
    if (boxShadow && borderRadius && boxShadow !== 'none') {
      const shadows = parseBoxShadow(boxShadow);
      const hasGlowEffect = shadows.some(
        (s) => s.blur > 0 && Math.abs(s.offsetX) <= 2 && Math.abs(s.offsetY) <= 2
      );

      if (hasGlowEffect) {
        properties.isGlowingBorder = true;
        properties.glowColor = shadows[0]?.color;
        hasAnimatedBorder = true;
        confidence += 0.2;
      }
    }

    // Get border width if present
    const borderWidth = rule.properties.get('border-width') || rule.properties.get('border');
    if (borderWidth && hasAnimatedBorder) {
      const widthMatch = borderWidth.match(/(\d+(?:\.\d+)?(?:px|em|rem)?)/);
      if (widthMatch) {
        properties.borderWidth = widthMatch[1];
      }
    }

    if (hasAnimatedBorder) {
      properties.rawValue =
        borderImage || animation || boxShadow || undefined;

      decorations.push({
        type: 'animated-border',
        element: rule.selector,
        properties,
        confidence: Math.min(confidence, 1),
      });
    }
  }

  return decorations;
}

/**
 * Detect glass morphism effects
 */
function detectGlassMorphism(rules: CSSRuleInfo[]): VisualDecoration[] {
  const decorations: VisualDecoration[] = [];

  for (const rule of rules) {
    const backdropFilter =
      rule.properties.get('backdrop-filter') || rule.properties.get('-webkit-backdrop-filter');

    if (!backdropFilter || backdropFilter === 'none') continue;

    const parsed = parseBackdropFilter(backdropFilter);
    if (!parsed.blur && !parsed.saturation && !parsed.brightness) continue;

    const properties: VisualDecorationProperties = {
      blur: parsed.blur,
      saturation: parsed.saturation,
      brightness: parsed.brightness,
      rawValue: backdropFilter,
    };

    // Check for background with transparency
    const background = rule.properties.get('background') || rule.properties.get('background-color');
    if (background) {
      properties.backgroundColor = background;

      // Extract opacity from rgba
      const rgbaMatch = background.match(/rgba?\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/i);
      if (rgbaMatch?.[1]) {
        properties.backgroundOpacity = parseFloat(rgbaMatch[1]);
      }
    }

    // Check for subtle border (common in glass morphism)
    const border = rule.properties.get('border');
    if (border) {
      properties.border = border;
    }

    // Calculate confidence
    let confidence = 0.7;
    if (parsed.blur && parsed.blur >= 5) confidence += 0.15;
    if (properties.backgroundOpacity && properties.backgroundOpacity < 0.5) confidence += 0.1;
    if (properties.border) confidence += 0.05;

    decorations.push({
      type: 'glass-morphism',
      element: rule.selector,
      properties,
      confidence: Math.min(confidence, 1),
    });
  }

  return decorations;
}

// =====================================================
// Main Service
// =====================================================

/**
 * Visual Decoration Detector Service
 *
 * Detects visual decorations from HTML/CSS content
 */
export class VisualDecorationDetectorService {
  /**
   * Detect visual decorations from CSS text
   *
   * @param cssText - CSS content to analyze
   * @returns Visual decorations detection result
   */
  detectFromCSS(cssText: string): VisualDecorationsResult {
    const startTime = performance.now();

    // Parse CSS rules
    const rules = parseCSSRules(cssText);

    // Detect each type of decoration
    const glowDecorations = detectGlowEffects(rules);
    const gradientDecorations = detectGradientBackgrounds(rules);
    const animatedBorderDecorations = detectAnimatedBorders(rules);
    const glassMorphismDecorations = detectGlassMorphism(rules);

    // Combine all decorations
    const allDecorations: VisualDecoration[] = [
      ...glowDecorations,
      ...gradientDecorations,
      ...animatedBorderDecorations,
      ...glassMorphismDecorations,
    ];

    const processingTimeMs = performance.now() - startTime;

    return {
      decorations: allDecorations,
      summary: {
        glowCount: glowDecorations.length,
        gradientCount: gradientDecorations.length,
        animatedBorderCount: animatedBorderDecorations.length,
        glassMorphismCount: glassMorphismDecorations.length,
      },
      processingTimeMs,
    };
  }

  /**
   * Detect visual decorations from HTML with embedded styles
   *
   * @param html - HTML content to analyze
   * @returns Visual decorations detection result
   */
  detectFromHTML(html: string): VisualDecorationsResult {
    const startTime = performance.now();

    // Extract CSS from style tags and inline styles
    const cssFromStyles = this.extractStyleTagContent(html);
    const cssFromInline = this.extractInlineStyles(html);

    const combinedCSS = cssFromStyles + '\n' + cssFromInline;

    // Detect from combined CSS
    const result = this.detectFromCSS(combinedCSS);

    // Update processing time to include extraction
    return {
      ...result,
      processingTimeMs: performance.now() - startTime,
    };
  }

  /**
   * Extract CSS content from style tags
   */
  private extractStyleTagContent(html: string): string {
    const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    const styles: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = styleRegex.exec(html)) !== null) {
      const content = match[1];
      if (content) {
        styles.push(content);
      }
    }

    return styles.join('\n');
  }

  /**
   * Extract inline styles as pseudo CSS rules
   */
  private extractInlineStyles(html: string): string {
    const inlineRegex =
      /<([a-z][a-z0-9-]*)[^>]*\s+style\s*=\s*["']([^"']+)["'][^>]*(?:\s+(?:id|class)\s*=\s*["']([^"']+)["'])?/gi;
    const rules: string[] = [];
    let match: RegExpExecArray | null;
    let counter = 0;

    while ((match = inlineRegex.exec(html)) !== null) {
      const tagName = match[1];
      const style = match[2];
      const idOrClass = match[3];

      // Create a pseudo selector for the inline style
      const selector = idOrClass
        ? idOrClass.startsWith('#')
          ? idOrClass
          : `.${idOrClass.split(/\s+/)[0]}`
        : `${tagName}[inline-${counter++}]`;

      rules.push(`${selector} { ${style} }`);
    }

    return rules.join('\n');
  }
}

// Export singleton instance
export const visualDecorationDetector = new VisualDecorationDetectorService();
