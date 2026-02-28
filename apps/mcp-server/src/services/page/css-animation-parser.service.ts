// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CssAnimationParser Service
 *
 * CSS animation/transition のパース専用サービス
 * motion-detector.ts から責務分離（Phase5リファクタリング）
 *
 * 責務:
 * - @keyframes 定義のパース
 * - animation プロパティのパース
 * - transition プロパティのパース
 * - スタイルルールの抽出
 *
 * Security:
 * - ReDoS (Regular Expression Denial of Service) 対策実装済み
 * - 入力サイズ制限、正規表現の長さ制限による保護
 *
 * @module services/page/css-animation-parser.service
 */

// =====================================================
// Security Constants (ReDoS Protection)
// =====================================================

/**
 * CSS Parser security limits to prevent ReDoS attacks
 *
 * These limits are designed to:
 * 1. Prevent exponential backtracking in regex patterns
 * 2. Limit memory consumption from large inputs
 * 3. Ensure consistent performance under adversarial conditions
 */
export const CSS_PARSER_LIMITS = {
  /** Maximum CSS input size (5MB, matches motion.detect schema) */
  MAX_CSS_SIZE: 5 * 1024 * 1024,

  /** Maximum length for a single CSS property value */
  MAX_PROPERTY_VALUE_LENGTH: 10000,

  /** Maximum length for a CSS selector */
  MAX_SELECTOR_LENGTH: 1000,

  /** Maximum length for cubic-bezier/steps function content */
  MAX_CUBIC_BEZIER_LENGTH: 100,

  /** Maximum length for keyframe content (inside @keyframes block) */
  MAX_KEYFRAME_CONTENT_LENGTH: 50000,

  /** Maximum number of keyframes per animation */
  MAX_KEYFRAMES_PER_ANIMATION: 100,

  /** Maximum nesting depth for braces */
  MAX_BRACE_DEPTH: 10,
} as const;

// =====================================================
// Types
// =====================================================

/**
 * Keyframe step
 */
export interface KeyframeStep {
  offset: number;
  styles: Record<string, string>;
}

/**
 * Easing configuration
 */
export interface EasingConfig {
  type:
    | 'linear'
    | 'ease'
    | 'ease-in'
    | 'ease-out'
    | 'ease-in-out'
    | 'cubic-bezier'
    | 'steps';
  cubicBezier?: [number, number, number, number];
  steps?: {
    count: number;
    position: 'start' | 'end';
  };
}

/**
 * Parsed animation property
 */
export interface ParsedAnimation {
  name: string;
  duration: number;
  easing: EasingConfig;
  delay: number;
  iterations: number | 'infinite';
  direction: string;
  fillMode: string;
}

/**
 * Parsed transition property
 */
export interface ParsedTransition {
  property: string;
  duration: number;
  easing: EasingConfig;
  delay: number;
}

// =====================================================
// Constants
// =====================================================

/** Easing keyword list */
const EASING_KEYWORDS = [
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
] as const;

/** Animation direction keywords */
const DIRECTION_KEYWORDS = [
  'normal',
  'reverse',
  'alternate',
  'alternate-reverse',
] as const;

/** Animation fill-mode keywords */
const FILL_MODE_KEYWORDS = ['none', 'forwards', 'backwards', 'both'] as const;

// =====================================================
// CssAnimationParser Service
// =====================================================

/**
 * CSS Animation/Transition parser service
 */
export class CssAnimationParser {
  // =====================================================
  // @keyframes Parsing
  // =====================================================

  /**
   * Parse @keyframes definitions from CSS
   *
   * Security: Input size validation and content length limits prevent ReDoS attacks.
   *
   * @param css - CSS content
   * @returns Map of keyframe name to steps
   */
  parseKeyframes(css: string): Map<string, KeyframeStep[]> {
    const keyframesMap = new Map<string, KeyframeStep[]>();

    // Security: Validate input size to prevent ReDoS
    if (!css || css.length > CSS_PARSER_LIMITS.MAX_CSS_SIZE) {
      if (process.env.NODE_ENV === 'development' && css && css.length > CSS_PARSER_LIMITS.MAX_CSS_SIZE) {
        console.warn(`[CssAnimationParser] parseKeyframes: Input size ${css.length} exceeds limit ${CSS_PARSER_LIMITS.MAX_CSS_SIZE}`);
      }
      return keyframesMap;
    }

    const keyframesStartRegex = /@keyframes\s+([\w-]+)\s*\{/g;
    let startMatch;

    while ((startMatch = keyframesStartRegex.exec(css)) !== null) {
      const name = startMatch[1];
      if (!name) continue;

      const startIndex = startMatch.index + startMatch[0].length;
      let braceCount = 1;
      let endIndex = startIndex;

      // Find matching closing brace with depth limit
      for (let i = startIndex; i < css.length && braceCount > 0; i++) {
        if (css[i] === '{') {
          braceCount++;
          // Security: Limit brace nesting depth
          if (braceCount > CSS_PARSER_LIMITS.MAX_BRACE_DEPTH) {
            if (process.env.NODE_ENV === 'development') {
              console.warn(`[CssAnimationParser] parseKeyframes: Max brace depth exceeded for keyframe "${name}"`);
            }
            break;
          }
        } else if (css[i] === '}') {
          braceCount--;
        }
        endIndex = i;
      }

      const content = css.substring(startIndex, endIndex);
      if (content) {
        // Security: Limit keyframe content length
        const truncatedContent = content.length > CSS_PARSER_LIMITS.MAX_KEYFRAME_CONTENT_LENGTH
          ? content.substring(0, CSS_PARSER_LIMITS.MAX_KEYFRAME_CONTENT_LENGTH)
          : content;

        const steps = this.parseKeyframeSteps(truncatedContent);
        keyframesMap.set(name, steps);
      }
    }

    return keyframesMap;
  }

  /**
   * Parse keyframe steps from content
   *
   * Security: Length-limited regex patterns prevent ReDoS via backtracking.
   *
   * @param content - Keyframe content (inside @keyframes block)
   * @returns Sorted array of keyframe steps
   */
  parseKeyframeSteps(content: string): KeyframeStep[] {
    const steps: KeyframeStep[] = [];

    // Security: Limit content length to prevent ReDoS
    const safeContent = content.length > CSS_PARSER_LIMITS.MAX_KEYFRAME_CONTENT_LENGTH
      ? content.substring(0, CSS_PARSER_LIMITS.MAX_KEYFRAME_CONTENT_LENGTH)
      : content;

    // Security: Use length-limited pattern for styles block [^}]{0,MAX}
    // This prevents exponential backtracking on malformed input
    const stepRegex = /([\d.]+%|from|to)\s*\{([^}]{0,10000})\}/g;

    let match;
    let matchCount = 0;
    while ((match = stepRegex.exec(safeContent)) !== null) {
      // Security: Limit number of keyframes per animation
      if (++matchCount > CSS_PARSER_LIMITS.MAX_KEYFRAMES_PER_ANIMATION) {
        if (process.env.NODE_ENV === 'development') {
          console.warn(`[CssAnimationParser] parseKeyframeSteps: Max keyframes limit reached (${CSS_PARSER_LIMITS.MAX_KEYFRAMES_PER_ANIMATION})`);
        }
        break;
      }

      const offsetStr = match[1];
      const stylesStr = match[2];
      if (!offsetStr || !stylesStr) continue;

      let offset: number;
      if (offsetStr === 'from') {
        offset = 0;
      } else if (offsetStr === 'to') {
        offset = 100;
      } else {
        offset = parseFloat(offsetStr);
      }

      const styles: Record<string, string> = {};
      // Security: Use length-limited pattern for property values [^;]{1,MAX}
      // This prevents exponential backtracking on long values without semicolons
      const styleRegex = /([\w-]+)\s*:\s*([^;]{1,10000});?/g;
      let styleMatch;
      while ((styleMatch = styleRegex.exec(stylesStr)) !== null) {
        const propName = styleMatch[1];
        const propValue = styleMatch[2];
        if (propName && propValue) {
          // Security: Truncate extremely long property values
          const truncatedValue = propValue.length > CSS_PARSER_LIMITS.MAX_PROPERTY_VALUE_LENGTH
            ? propValue.substring(0, CSS_PARSER_LIMITS.MAX_PROPERTY_VALUE_LENGTH)
            : propValue;
          styles[propName.trim()] = truncatedValue.trim();
        }
      }

      steps.push({ offset, styles });
    }

    return steps.sort((a, b) => a.offset - b.offset);
  }

  // =====================================================
  // Animation Property Parsing
  // =====================================================

  /**
   * Parse animation property shorthand
   *
   * @param value - Animation property value
   * @returns Parsed animation object
   */
  parseAnimationProperty(value: string): ParsedAnimation {
    // Tokenize respecting parentheses (for cubic-bezier, steps, etc.)
    const parts = this.tokenizeAnimationValue(value);

    let name = '';
    let duration = 0;
    let easing: EasingConfig = { type: 'ease' };
    let delay = 0;
    let iterations: number | 'infinite' = 1;
    let direction = 'normal';
    let fillMode = 'none';

    let foundDuration = false;

    for (const part of parts) {
      // Duration/delay (time values)
      if (/^[\d.]+m?s$/.test(part)) {
        const timeMs = this.parseTimeToMs(part);
        if (!foundDuration) {
          duration = timeMs;
          foundDuration = true;
        } else {
          delay = timeMs;
        }
      }
      // Iteration count
      else if (part === 'infinite') {
        iterations = 'infinite';
      } else if (/^\d+$/.test(part)) {
        iterations = parseInt(part, 10);
      }
      // Easing - cubic-bezier
      // Security: Length limit prevents ReDoS on malformed/long inputs
      else if (part.startsWith('cubic-bezier')) {
        const bezierMatch = part.match(/cubic-bezier\(([\d.,\s-]{1,100})\)/);
        if (bezierMatch && bezierMatch[1]) {
          const values = bezierMatch[1].split(',').map((v) => parseFloat(v.trim()));
          if (values.length === 4 && values.every((v) => !isNaN(v))) {
            easing = {
              type: 'cubic-bezier',
              cubicBezier: values as [number, number, number, number],
            };
          }
        }
      }
      // Easing - steps
      else if (part.startsWith('steps')) {
        const stepsMatch = part.match(/steps\((\d+)(?:,\s*(start|end))?\)/);
        if (stepsMatch && stepsMatch[1]) {
          easing = {
            type: 'steps',
            steps: {
              count: parseInt(stepsMatch[1], 10),
              position: (stepsMatch[2] as 'start' | 'end') || 'end',
            },
          };
        }
      }
      // Easing - keywords
      else if (EASING_KEYWORDS.includes(part as (typeof EASING_KEYWORDS)[number])) {
        easing = { type: part as EasingConfig['type'] };
      }
      // Direction
      else if (DIRECTION_KEYWORDS.includes(part as (typeof DIRECTION_KEYWORDS)[number])) {
        direction = part;
      }
      // Fill mode
      else if (FILL_MODE_KEYWORDS.includes(part as (typeof FILL_MODE_KEYWORDS)[number])) {
        fillMode = part;
      }
      // Animation name (anything else that looks like an identifier)
      else if (!name && /^[\w-]+$/.test(part)) {
        name = part;
      }
    }

    return { name, duration, easing, delay, iterations, direction, fillMode };
  }

  /**
   * Tokenize animation value respecting parentheses
   * Handles cubic-bezier(...) and steps(...) as single tokens
   *
   * @param value - Animation property value
   * @returns Array of tokens
   */
  tokenizeAnimationValue(value: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let parenDepth = 0;

    for (let i = 0; i < value.length; i++) {
      const char = value[i];

      if (char === '(') {
        parenDepth++;
        current += char;
      } else if (char === ')') {
        parenDepth--;
        current += char;
      } else if (/\s/.test(char!) && parenDepth === 0) {
        // Whitespace outside parentheses = token separator
        if (current.trim()) {
          tokens.push(current.trim());
        }
        current = '';
      } else {
        current += char;
      }
    }

    // Push final token
    if (current.trim()) {
      tokens.push(current.trim());
    }

    return tokens;
  }

  // =====================================================
  // Transition Property Parsing
  // =====================================================

  /**
   * Parse transition property
   *
   * @param value - Transition property value
   * @returns Array of parsed transitions
   */
  parseTransitionProperty(value: string): ParsedTransition[] {
    const transitions: ParsedTransition[] = [];

    // Split by comma, but respect parentheses (for cubic-bezier)
    const parts = this.splitTransitionParts(value);

    for (const part of parts) {
      // Use tokenizeAnimationValue to handle parentheses properly
      const tokens = this.tokenizeAnimationValue(part);
      let property = 'all';
      let duration = 0;
      let easing: EasingConfig = { type: 'ease' };
      let delay = 0;
      let foundDuration = false;

      for (const token of tokens) {
        if (/^[\d.]+m?s$/.test(token)) {
          const timeMs = this.parseTimeToMs(token);
          if (!foundDuration) {
            duration = timeMs;
            foundDuration = true;
          } else {
            delay = timeMs;
          }
        } else if (EASING_KEYWORDS.includes(token as (typeof EASING_KEYWORDS)[number])) {
          easing = { type: token as EasingConfig['type'] };
        // Security: Length limit prevents ReDoS on malformed/long inputs
        } else if (token.startsWith('cubic-bezier')) {
          const bezierMatch = token.match(/cubic-bezier\(([\d.,\s-]{1,100})\)/);
          if (bezierMatch && bezierMatch[1]) {
            const values = bezierMatch[1].split(',').map((v) => parseFloat(v.trim()));
            if (values.length === 4 && values.every((v) => !isNaN(v))) {
              easing = {
                type: 'cubic-bezier',
                cubicBezier: values as [number, number, number, number],
              };
            }
          }
        } else if (/^[\w-]+$/.test(token) && property === 'all') {
          property = token;
        }
      }

      transitions.push({ property, duration, easing, delay });
    }

    return transitions;
  }

  /**
   * Split transition value by comma, respecting parentheses
   *
   * @param value - Transition value string
   * @returns Array of individual transition parts
   */
  private splitTransitionParts(value: string): string[] {
    const parts: string[] = [];
    let current = '';
    let parenDepth = 0;

    for (let i = 0; i < value.length; i++) {
      const char = value[i];

      if (char === '(') {
        parenDepth++;
        current += char;
      } else if (char === ')') {
        parenDepth--;
        current += char;
      } else if (char === ',' && parenDepth === 0) {
        if (current.trim()) {
          parts.push(current.trim());
        }
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

  // =====================================================
  // Style Rules Extraction
  // =====================================================

  /**
   * Extract style rules from CSS
   *
   * Security: Input size validation and length-limited patterns prevent ReDoS attacks.
   *
   * @param css - CSS content
   * @returns Map of selector to styles
   */
  extractStyleRules(css: string): Map<string, Record<string, string>> {
    const rules = new Map<string, Record<string, string>>();

    // Security: Validate input size to prevent ReDoS
    if (!css || css.length > CSS_PARSER_LIMITS.MAX_CSS_SIZE) {
      if (process.env.NODE_ENV === 'development' && css && css.length > CSS_PARSER_LIMITS.MAX_CSS_SIZE) {
        console.warn(`[CssAnimationParser] extractStyleRules: Input size ${css.length} exceeds limit ${CSS_PARSER_LIMITS.MAX_CSS_SIZE}`);
      }
      return rules;
    }

    // Security: Use length-limited patterns to prevent ReDoS
    // [^{]{1,MAX} limits selector length, [^}]{0,MAX} limits declaration block
    const ruleRegex = /([^@{}\s][^{]{0,1000})\{([^}]{0,50000})\}/g;

    let match;
    while ((match = ruleRegex.exec(css)) !== null) {
      const selector = match[1];
      const declarations = match[2];
      if (!selector || !declarations) continue;

      const selectorTrimmed = selector.trim();

      // Security: Skip overly long selectors
      if (selectorTrimmed.length > CSS_PARSER_LIMITS.MAX_SELECTOR_LENGTH) {
        if (process.env.NODE_ENV === 'development') {
          console.warn(`[CssAnimationParser] extractStyleRules: Selector too long (${selectorTrimmed.length} chars), skipping`);
        }
        continue;
      }

      // Skip keyframe rules
      if (/^\d+%|^from|^to/.test(selectorTrimmed)) continue;

      const styles: Record<string, string> = {};
      // Security: Use length-limited pattern for property values
      const declRegex = /([\w-]+)\s*:\s*([^;]{1,10000});?/g;
      let declMatch;
      while ((declMatch = declRegex.exec(declarations)) !== null) {
        const propName = declMatch[1];
        const propValue = declMatch[2];
        if (propName && propValue) {
          // Security: Truncate extremely long property values
          const truncatedValue = propValue.length > CSS_PARSER_LIMITS.MAX_PROPERTY_VALUE_LENGTH
            ? propValue.substring(0, CSS_PARSER_LIMITS.MAX_PROPERTY_VALUE_LENGTH)
            : propValue;
          styles[propName.trim()] = truncatedValue.trim();
        }
      }

      rules.set(selectorTrimmed, styles);
    }

    return rules;
  }

  // =====================================================
  // Utility Methods
  // =====================================================

  /**
   * Parse time string to milliseconds
   *
   * @param time - Time string (e.g., "0.3s", "300ms")
   * @returns Time in milliseconds
   */
  parseTimeToMs(time: string): number {
    if (time.endsWith('ms')) {
      return parseFloat(time);
    } else if (time.endsWith('s')) {
      return parseFloat(time) * 1000;
    }
    return parseFloat(time);
  }

  /**
   * Format easing config to string
   *
   * @param easing - Easing configuration
   * @returns CSS easing string
   */
  formatEasing(easing: EasingConfig): string {
    if (easing.type === 'cubic-bezier' && easing.cubicBezier) {
      return `cubic-bezier(${easing.cubicBezier.join(', ')})`;
    }
    if (easing.type === 'steps' && easing.steps) {
      return `steps(${easing.steps.count}, ${easing.steps.position})`;
    }
    return easing.type;
  }

  /**
   * Generate CSS for keyframes
   *
   * @param name - Keyframe name
   * @param steps - Keyframe steps
   * @returns CSS string
   */
  generateKeyframesCss(name: string, steps: KeyframeStep[]): string {
    const stepsStr = steps
      .map((s) => {
        const styleStr = Object.entries(s.styles)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ');
        return `  ${s.offset}% { ${styleStr} }`;
      })
      .join('\n');
    return `@keyframes ${name} {\n${stepsStr}\n}`;
  }
}

// =====================================================
// Singleton Instance
// =====================================================

let cssAnimationParserInstance: CssAnimationParser | null = null;

/**
 * Get singleton instance of CssAnimationParser
 */
export function getCssAnimationParser(): CssAnimationParser {
  if (!cssAnimationParserInstance) {
    cssAnimationParserInstance = new CssAnimationParser();
  }
  return cssAnimationParserInstance;
}

/**
 * Reset singleton instance (for testing)
 */
export function resetCssAnimationParser(): void {
  cssAnimationParserInstance = null;
}
