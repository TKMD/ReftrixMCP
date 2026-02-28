// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS Variable Extractor Service
 *
 * Extracts CSS custom properties, clamp() values, calc() expressions,
 * and detects Design Tokens from HTML/CSS content.
 *
 * Features:
 * - CSS Custom Properties extraction (--var-name pattern)
 * - clamp() function parsing for responsive values
 * - calc() expression extraction
 * - Design Tokens detection (Tailwind, Open Props, CSS-in-JS)
 *
 * @module services/visual/css-variable-extractor.service
 */

import { logger } from '../../utils/logger';

/**
 * CSS Variable with metadata
 */
export interface CSSVariable {
  /** Variable name including -- prefix */
  name: string;
  /** Variable value (may contain var() references) */
  value: string;
  /** Category inferred from naming pattern */
  category: 'color' | 'typography' | 'spacing' | 'border' | 'shadow' | 'layout' | 'animation' | 'other';
  /** CSS selector scope where variable is defined */
  scope: string;
  /** Referenced variable names (from var() in value) */
  references?: string[];
}

/**
 * clamp() value with parsed components
 */
export interface ClampValue {
  /** CSS property containing clamp() */
  property: string;
  /** CSS selector */
  selector: string;
  /** Minimum value */
  min: string;
  /** Preferred/flexible value */
  preferred: string;
  /** Maximum value */
  max: string;
  /** Raw clamp() string */
  raw: string;
}

/**
 * calc() expression with parsed components
 */
export interface CalcExpression {
  /** CSS property containing calc() */
  property: string;
  /** CSS selector */
  selector: string;
  /** Expression inside calc() */
  expression: string;
  /** Raw calc() string */
  raw: string;
}

/**
 * Design Tokens detection result
 */
export interface DesignTokensInfo {
  /** Detected framework/system */
  framework: 'tailwind' | 'open-props' | 'css-in-js' | 'css-variables' | 'unknown';
  /** Detection confidence (0-1) */
  confidence: number;
  /** Evidence/reasons for detection */
  evidence: string[];
}

/**
 * Complete extraction result
 */
export interface CSSVariableExtractionResult {
  /** Extracted CSS variables */
  variables: CSSVariable[];
  /** Extracted clamp() values */
  clampValues: ClampValue[];
  /** Extracted calc() expressions */
  calcExpressions: CalcExpression[];
  /** Design tokens detection */
  designTokens: DesignTokensInfo;
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * CSS Variable Extractor Service interface
 */
export interface CSSVariableExtractorService {
  /**
   * Extract from CSS text
   * @param css - CSS content
   */
  extractFromCSS(css: string): CSSVariableExtractionResult;

  /**
   * Extract from HTML (inline styles and <style> tags)
   * @param html - HTML content
   */
  extractFromHTML(html: string): CSSVariableExtractionResult;

  /**
   * Extract from both HTML and external CSS
   * @param html - HTML content
   * @param externalCss - External CSS content (optional)
   */
  extract(html: string, externalCss?: string): CSSVariableExtractionResult;
}

// Regex patterns for extraction
const CSS_VAR_DECLARATION_PATTERN = /(--[\w-]+)\s*:\s*([^;]+);/g;
const CSS_SELECTOR_BLOCK_PATTERN = /([^{]+)\{([^}]*)\}/g;
const CLAMP_PATTERN = /clamp\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)/g;
const VAR_REFERENCE_PATTERN = /var\(\s*(--[\w-]+)\s*(?:,\s*[^)]+)?\)/g;
const STYLE_TAG_PATTERN = /<style[^>]*>([\s\S]*?)<\/style>/gi;
const INLINE_STYLE_PATTERN = /style\s*=\s*["']([^"']+)["']/gi;

/**
 * Maximum number of CSS variables/clamp values/calc expressions to extract.
 * Prevents excessive memory usage when analyzing large CSS files.
 * @see Code Review Recommendation (v0.1.0)
 */
const MAX_CSS_VARIABLES = 1000;
const MAX_CLAMP_VALUES = 500;
const MAX_CALC_EXPRESSIONS = 500;

/**
 * Extract calc() expression handling nested parentheses
 */
function extractCalcExpression(value: string): Array<{ expression: string; raw: string }> {
  const results: Array<{ expression: string; raw: string }> = [];

  // Find all calc( occurrences
  let startIndex = 0;
  while (true) {
    const calcStart = value.indexOf('calc(', startIndex);
    if (calcStart === -1) break;

    // Find matching closing parenthesis
    let depth = 1;
    let i = calcStart + 5; // Start after 'calc('
    while (i < value.length && depth > 0) {
      if (value[i] === '(') depth++;
      if (value[i] === ')') depth--;
      i++;
    }

    if (depth === 0) {
      const raw = value.substring(calcStart, i);
      const expression = value.substring(calcStart + 5, i - 1).trim();
      results.push({ expression, raw });
    }

    startIndex = i;
  }

  return results;
}

/**
 * Categorize CSS variable by naming pattern
 */
function categorizeVariable(name: string): CSSVariable['category'] {
  const lowerName = name.toLowerCase();

  if (
    lowerName.includes('color') ||
    lowerName.includes('bg') ||
    lowerName.includes('background') ||
    lowerName.includes('text-') ||
    lowerName.includes('border-color') ||
    lowerName.includes('fill') ||
    lowerName.includes('stroke')
  ) {
    return 'color';
  }

  if (
    lowerName.includes('font') ||
    lowerName.includes('text') ||
    lowerName.includes('line-height') ||
    lowerName.includes('letter') ||
    lowerName.includes('leading') ||
    lowerName.includes('tracking')
  ) {
    return 'typography';
  }

  if (
    lowerName.includes('spacing') ||
    lowerName.includes('gap') ||
    lowerName.includes('padding') ||
    lowerName.includes('margin') ||
    lowerName.includes('space') ||
    lowerName.includes('size') && !lowerName.includes('font-size')
  ) {
    return 'spacing';
  }

  if (
    lowerName.includes('border') ||
    lowerName.includes('radius') ||
    lowerName.includes('rounded')
  ) {
    return 'border';
  }

  if (lowerName.includes('shadow') || lowerName.includes('elevation')) {
    return 'shadow';
  }

  if (
    lowerName.includes('z-index') ||
    lowerName.includes('zindex') ||
    lowerName.includes('layer') ||
    lowerName.includes('width') ||
    lowerName.includes('height') ||
    lowerName.includes('max-') ||
    lowerName.includes('min-')
  ) {
    return 'layout';
  }

  if (
    lowerName.includes('transition') ||
    lowerName.includes('animation') ||
    lowerName.includes('duration') ||
    lowerName.includes('delay') ||
    lowerName.includes('ease') ||
    lowerName.includes('timing')
  ) {
    return 'animation';
  }

  return 'other';
}

/**
 * Extract var() references from a value
 */
function extractVarReferences(value: string): string[] {
  const references: string[] = [];
  const regex = new RegExp(VAR_REFERENCE_PATTERN.source, 'g');
  let match;

  while ((match = regex.exec(value)) !== null) {
    if (match[1]) {
      references.push(match[1]);
    }
  }

  return references;
}

/**
 * Detect design tokens framework from CSS
 */
function detectDesignTokens(variables: CSSVariable[], css: string): DesignTokensInfo {
  const evidence: string[] = [];
  let framework: DesignTokensInfo['framework'] = 'unknown';
  let confidence = 0;

  // Tailwind detection
  const hasTwPrefix = variables.some(v => v.name.startsWith('--tw-'));
  const hasTwRing = css.includes('--tw-ring');
  const hasTwShadow = css.includes('--tw-shadow');
  const hasTwTextOpacity = css.includes('--tw-text-opacity');

  if (hasTwPrefix || hasTwRing || hasTwShadow || hasTwTextOpacity) {
    framework = 'tailwind';
    confidence = 0.6; // Higher base confidence for Tailwind
    evidence.push('tw- prefix variables');
    if (hasTwRing) {
      evidence.push('--tw-ring variables');
      confidence += 0.1;
    }
    if (hasTwShadow) {
      evidence.push('--tw-shadow variables');
      confidence += 0.1;
    }
    if (hasTwTextOpacity) {
      evidence.push('--tw-text-opacity variable');
      confidence += 0.1;
    }
  }

  // Open Props detection (check before CSS-in-JS)
  const hasOpenPropsSize = variables.some(v => /^--size-\d+$/.test(v.name));
  const hasOpenPropsGray = variables.some(v => /^--gray-\d+$/.test(v.name));
  const hasOpenPropsFont = variables.some(v => v.name.startsWith('--font-') && v.value.includes('system-ui'));

  const openPropsMatches = [hasOpenPropsSize, hasOpenPropsGray, hasOpenPropsFont].filter(Boolean).length;

  if (openPropsMatches >= 2 || (openPropsMatches >= 1 && framework === 'unknown')) {
    if (framework === 'unknown' || (framework !== 'tailwind' && openPropsMatches >= 2)) {
      framework = 'open-props';
      confidence = 0.5 + (openPropsMatches * 0.15); // Higher confidence with more matches
    }
    if (hasOpenPropsSize) evidence.push('Open Props size scale');
    if (hasOpenPropsGray) evidence.push('Open Props gray scale');
    if (hasOpenPropsFont) evidence.push('Open Props font stack');
  }

  // CSS-in-JS detection (Styled Components, Emotion, Chakra)
  const hasScPrefix = css.includes('.sc-') || css.includes('class="sc-');
  const hasEmotionPrefix = css.includes('.emotion-') || css.includes('.css-');
  const hasChakraVars = variables.some(v => v.name.includes('chakra'));
  const hasTokenPrefix = variables.some(v => v.name.includes('--token-'));

  const cssInJsMatches = [hasScPrefix, hasEmotionPrefix, hasChakraVars, hasTokenPrefix].filter(Boolean).length;

  if (cssInJsMatches > 0) {
    if (framework === 'unknown') {
      framework = 'css-in-js';
      confidence = 0.4 + (cssInJsMatches * 0.15);
    }
    if (hasScPrefix) evidence.push('Styled Components class pattern');
    if (hasEmotionPrefix) evidence.push('Emotion class pattern');
    if (hasChakraVars) evidence.push('Chakra UI variables');
    if (hasTokenPrefix) evidence.push('Token-prefixed variables');
  }

  // CSS Variables design system detection (color scales)
  const colorScalePattern = variables.filter(v =>
    /--[\w-]+-(?:50|100|200|300|400|500|600|700|800|900)$/.test(v.name)
  );

  if (colorScalePattern.length >= 3) {
    if (framework === 'unknown') {
      framework = 'css-variables';
      confidence = 0.5;
    }
    evidence.push('color scale pattern (50-900)');
    confidence += 0.2;
  }

  // General CSS variables system (fallback)
  if (framework === 'unknown' && variables.length > 0) {
    framework = 'css-variables';
    confidence = 0.3;
    evidence.push('Custom CSS properties detected');
  }

  return {
    framework,
    confidence: Math.min(1, confidence),
    evidence,
  };
}

/**
 * Internal implementation
 */
class CSSVariableExtractorServiceImpl implements CSSVariableExtractorService {
  extractFromCSS(css: string): CSSVariableExtractionResult {
    const startTime = Date.now();

    if (!css || typeof css !== 'string') {
      return this.emptyResult(Date.now() - startTime);
    }

    const variables: CSSVariable[] = [];
    const clampValues: ClampValue[] = [];
    const calcExpressions: CalcExpression[] = [];

    // Extract CSS blocks with selectors
    const selectorBlockRegex = new RegExp(CSS_SELECTOR_BLOCK_PATTERN.source, 'g');
    let blockMatch;

    while ((blockMatch = selectorBlockRegex.exec(css)) !== null) {
      const selector = blockMatch[1]?.trim() ?? '';
      const block = blockMatch[2] ?? '';

      // Extract CSS variables
      const varRegex = new RegExp(CSS_VAR_DECLARATION_PATTERN.source, 'g');
      let varMatch;

      while ((varMatch = varRegex.exec(block)) !== null) {
        const name = varMatch[1];
        const value = varMatch[2]?.trim() ?? '';

        if (name) {
          const references = extractVarReferences(value);
          const variable: CSSVariable = {
            name,
            value,
            category: categorizeVariable(name),
            scope: selector,
          };
          if (references.length > 0) {
            variable.references = references;
          }
          variables.push(variable);

          // Check if variable value contains clamp()
          const clampInVar = this.extractClampFromValue(name, selector, value);
          clampValues.push(...clampInVar);
        }
      }

      // Extract clamp() from regular properties
      const propertyPattern = /([\w-]+)\s*:\s*([^;]+);/g;
      let propMatch;

      while ((propMatch = propertyPattern.exec(block)) !== null) {
        const property = propMatch[1];
        const value = propMatch[2] ?? '';

        if (property && !property.startsWith('--')) {
          // clamp() extraction
          const clampRegex = new RegExp(CLAMP_PATTERN.source, 'g');
          let clampMatch;

          while ((clampMatch = clampRegex.exec(value)) !== null) {
            if (clampMatch[1] && clampMatch[2] && clampMatch[3]) {
              clampValues.push({
                property,
                selector,
                min: clampMatch[1].trim(),
                preferred: clampMatch[2].trim(),
                max: clampMatch[3].trim(),
                raw: clampMatch[0],
              });
            }
          }

          // calc() extraction with nested parentheses support
          const calcMatches = extractCalcExpression(value);
          for (const calcMatch of calcMatches) {
            calcExpressions.push({
              property,
              selector,
              expression: calcMatch.expression,
              raw: calcMatch.raw,
            });
          }
        }
      }
    }

    const designTokens = detectDesignTokens(variables, css);

    // Apply max limits to prevent excessive memory usage (v0.1.0)
    const limitedVariables = variables.slice(0, MAX_CSS_VARIABLES);
    const limitedClampValues = clampValues.slice(0, MAX_CLAMP_VALUES);
    const limitedCalcExpressions = calcExpressions.slice(0, MAX_CALC_EXPRESSIONS);

    logger.debug('[CSSVariableExtractor] extractFromCSS:', {
      variablesCount: limitedVariables.length,
      totalVariablesBeforeLimit: variables.length,
      clampValuesCount: limitedClampValues.length,
      calcExpressionsCount: limitedCalcExpressions.length,
      framework: designTokens.framework,
      truncated: variables.length > MAX_CSS_VARIABLES ||
        clampValues.length > MAX_CLAMP_VALUES ||
        calcExpressions.length > MAX_CALC_EXPRESSIONS,
    });

    return {
      variables: limitedVariables,
      clampValues: limitedClampValues,
      calcExpressions: limitedCalcExpressions,
      designTokens,
      processingTimeMs: Date.now() - startTime,
    };
  }

  extractFromHTML(html: string): CSSVariableExtractionResult {
    const startTime = Date.now();

    if (!html || typeof html !== 'string') {
      return this.emptyResult(Date.now() - startTime);
    }

    let combinedCss = '';

    // Extract CSS from <style> tags
    const styleTagRegex = new RegExp(STYLE_TAG_PATTERN.source, 'gi');
    let styleMatch;

    while ((styleMatch = styleTagRegex.exec(html)) !== null) {
      if (styleMatch[1]) {
        combinedCss += styleMatch[1] + '\n';
      }
    }

    // Extract inline styles
    const inlineRegex = new RegExp(INLINE_STYLE_PATTERN.source, 'gi');
    let inlineMatch;
    let inlineIndex = 0;

    while ((inlineMatch = inlineRegex.exec(html)) !== null) {
      const inlineStyle = inlineMatch[1];
      if (inlineStyle) {
        // Wrap inline style in a pseudo-selector for parsing
        combinedCss += `[inline-${inlineIndex}] { ${inlineStyle} }\n`;
        inlineIndex++;
      }
    }

    const result = this.extractFromCSS(combinedCss);
    result.processingTimeMs = Date.now() - startTime;

    return result;
  }

  extract(html: string, externalCss?: string): CSSVariableExtractionResult {
    const startTime = Date.now();

    const htmlResult = this.extractFromHTML(html ?? '');
    const cssResult = externalCss ? this.extractFromCSS(externalCss) : this.emptyResult(0);

    // Merge results, with external CSS taking precedence
    const variableMap = new Map<string, CSSVariable>();

    // Add HTML variables first
    for (const variable of htmlResult.variables) {
      variableMap.set(`${variable.scope}:${variable.name}`, variable);
    }

    // External CSS variables override
    for (const variable of cssResult.variables) {
      variableMap.set(`${variable.scope}:${variable.name}`, variable);
    }

    // Deduplicate by name only for :root scope
    const rootVars = new Map<string, CSSVariable>();
    const nonRootVars: CSSVariable[] = [];

    for (const variable of variableMap.values()) {
      if (variable.scope === ':root') {
        rootVars.set(variable.name, variable);
      } else {
        nonRootVars.push(variable);
      }
    }

    const mergedVariables = [...rootVars.values(), ...nonRootVars];

    // Merge clamp and calc (deduplicate by raw value)
    const clampSet = new Set<string>();
    const mergedClamp: ClampValue[] = [];
    for (const clamp of [...htmlResult.clampValues, ...cssResult.clampValues]) {
      const key = `${clamp.selector}:${clamp.property}:${clamp.raw}`;
      if (!clampSet.has(key)) {
        clampSet.add(key);
        mergedClamp.push(clamp);
      }
    }

    const calcSet = new Set<string>();
    const mergedCalc: CalcExpression[] = [];
    for (const calc of [...htmlResult.calcExpressions, ...cssResult.calcExpressions]) {
      const key = `${calc.selector}:${calc.property}:${calc.raw}`;
      if (!calcSet.has(key)) {
        calcSet.add(key);
        mergedCalc.push(calc);
      }
    }

    // Combine evidence from both
    const combinedEvidence = [
      ...new Set([...htmlResult.designTokens.evidence, ...cssResult.designTokens.evidence]),
    ];

    // Use the higher confidence framework
    const designTokens: DesignTokensInfo =
      cssResult.designTokens.confidence >= htmlResult.designTokens.confidence
        ? {
            ...cssResult.designTokens,
            evidence: combinedEvidence,
          }
        : {
            ...htmlResult.designTokens,
            evidence: combinedEvidence,
          };

    // Apply max limits to merged results (v0.1.0)
    return {
      variables: mergedVariables.slice(0, MAX_CSS_VARIABLES),
      clampValues: mergedClamp.slice(0, MAX_CLAMP_VALUES),
      calcExpressions: mergedCalc.slice(0, MAX_CALC_EXPRESSIONS),
      designTokens,
      processingTimeMs: Date.now() - startTime,
    };
  }

  private extractClampFromValue(property: string, selector: string, value: string): ClampValue[] {
    const results: ClampValue[] = [];
    const clampRegex = new RegExp(CLAMP_PATTERN.source, 'g');
    let match;

    while ((match = clampRegex.exec(value)) !== null) {
      if (match[1] && match[2] && match[3]) {
        results.push({
          property,
          selector,
          min: match[1].trim(),
          preferred: match[2].trim(),
          max: match[3].trim(),
          raw: match[0],
        });
      }
    }

    return results;
  }

  private emptyResult(processingTimeMs: number): CSSVariableExtractionResult {
    return {
      variables: [],
      clampValues: [],
      calcExpressions: [],
      designTokens: {
        framework: 'unknown',
        confidence: 0,
        evidence: [],
      },
      processingTimeMs,
    };
  }
}

/**
 * Create a new CSSVariableExtractorService instance
 */
export function createCSSVariableExtractorService(): CSSVariableExtractorService {
  return new CSSVariableExtractorServiceImpl();
}
