// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Typography Extractor Service
 *
 * Extracts font families, sizes, line-height, letter-spacing,
 * and detects typographic scale patterns from HTML/CSS content.
 *
 * Features:
 * - Font family extraction with category detection
 * - Font size hierarchy (h1-h6) extraction
 * - Responsive typography with clamp() detection
 * - Line-height and letter-spacing extraction
 * - Scale ratio detection (Minor Second to Golden Ratio)
 * - Google Fonts detection
 *
 * @module services/visual/typography-extractor.service
 */

import { logger } from '../../utils/logger';

/**
 * Font family information
 */
export interface FontFamily {
  /** CSS selector */
  selector: string;
  /** Primary font name */
  primary: string;
  /** Fallback fonts */
  fallbacks: string[];
  /** Font category */
  category: 'serif' | 'sans-serif' | 'monospace' | 'display' | 'cursive' | 'system';
  /** Whether it's a system font stack */
  isSystemFont?: boolean;
  /** Whether it's a Google Font */
  isGoogleFont?: boolean;
}

/**
 * Font size hierarchy
 */
export interface FontSizeHierarchy {
  h1?: string;
  h2?: string;
  h3?: string;
  h4?: string;
  h5?: string;
  h6?: string;
  body?: string;
  small?: string;
}

/**
 * Responsive typography with clamp()
 */
export interface ResponsiveTypography {
  /** CSS selector */
  selector: string;
  /** Minimum font size */
  min: string;
  /** Preferred/flexible font size */
  preferred: string;
  /** Maximum font size */
  max: string;
  /** Whether it's responsive */
  isResponsive: boolean;
}

/**
 * Typography style for a selector
 */
export interface TypographyStyle {
  /** CSS selector */
  selector: string;
  /** Font family (raw value) */
  fontFamily?: string;
  /** Font size */
  fontSize?: string;
  /** Font weight */
  fontWeight?: string;
  /** Line height */
  lineHeight?: string;
  /** Letter spacing */
  letterSpacing?: string;
}

/**
 * Inline style extracted from HTML
 */
export interface InlineTypographyStyle {
  /** Font family */
  fontFamily?: string;
  /** Font size */
  fontSize?: string;
  /** Line height */
  lineHeight?: string;
  /** Letter spacing */
  letterSpacing?: string;
}

/**
 * Font weight range for variable fonts
 */
export interface FontWeightRange {
  min: number;
  max: number;
}

/**
 * Complete extraction result
 */
export interface TypographyExtractionResult {
  /** Extracted font families */
  fontFamilies: FontFamily[];
  /** Font size hierarchy */
  fontSizeHierarchy: FontSizeHierarchy;
  /** Complete typography styles */
  styles: TypographyStyle[];
  /** Responsive typography with clamp() */
  responsiveTypography: ResponsiveTypography[];
  /** Inline styles from HTML */
  inlineStyles: InlineTypographyStyle[];
  /** Detected scale ratio */
  scaleRatio?: number;
  /** Scale name */
  scaleName?: string;
  /** Variable fonts detected */
  variableFonts: string[];
  /** Font weight range (for variable fonts) */
  fontWeightRange?: FontWeightRange;
  /** Google Fonts used */
  googleFontsUsed: string[];
  /** Google Fonts weights by font name */
  googleFontsWeights?: Record<string, string[]>;
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * Typography Extractor Service interface
 */
export interface TypographyExtractorService {
  /**
   * Extract from CSS text
   * @param css - CSS content
   */
  extractFromCSS(css: string): TypographyExtractionResult;

  /**
   * Extract from HTML (inline styles and <style> tags)
   * @param html - HTML content
   */
  extractFromHTML(html: string): TypographyExtractionResult;

  /**
   * Extract from both HTML and external CSS
   * @param html - HTML content
   * @param externalCss - External CSS content (optional)
   */
  extract(html: string, externalCss?: string): TypographyExtractionResult;
}

// Common Google Fonts list for detection
const GOOGLE_FONTS = new Set([
  'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Oswald', 'Source Sans Pro',
  'Raleway', 'PT Sans', 'Merriweather', 'Ubuntu', 'Playfair Display', 'Poppins',
  'Noto Sans', 'Nunito', 'Rubik', 'Work Sans', 'Fira Sans', 'Inter', 'Mukta',
  'Quicksand', 'Libre Franklin', 'Karla', 'Josefin Sans', 'Cabin', 'Barlow',
  'DM Sans', 'Manrope', 'Space Grotesk', 'Plus Jakarta Sans', 'Outfit',
  'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'IBM Plex Mono',
]);

// System font stacks
const SYSTEM_FONTS = new Set([
  'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI',
  'Helvetica Neue', 'Arial', 'Noto Sans', 'sans-serif', 'serif', 'monospace',
]);

// Type scale names and ratios
const TYPE_SCALES: Array<{ name: string; ratio: number }> = [
  { name: 'Minor Second', ratio: 1.067 },
  { name: 'Major Second', ratio: 1.125 },
  { name: 'Minor Third', ratio: 1.2 },
  { name: 'Major Third', ratio: 1.25 },
  { name: 'Perfect Fourth', ratio: 1.333 },
  { name: 'Augmented Fourth', ratio: 1.414 },
  { name: 'Perfect Fifth', ratio: 1.5 },
  { name: 'Golden Ratio', ratio: 1.618 },
];

// Regex patterns
const CSS_SELECTOR_BLOCK_PATTERN = /([^{]+)\{([^}]*)\}/g;
const CLAMP_PATTERN = /clamp\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)/;
const FONT_FACE_PATTERN = /@font-face\s*\{([^}]+)\}/gi;
const FONT_WEIGHT_RANGE_PATTERN = /font-weight\s*:\s*(\d+)\s+(\d+)/;
const STYLE_TAG_PATTERN = /<style[^>]*>([\s\S]*?)<\/style>/gi;
const INLINE_STYLE_PATTERN = /style\s*=\s*["']([^"']+)["']/gi;
const GOOGLE_FONTS_LINK_PATTERN = /fonts\.googleapis\.com\/css2?\?family=([^"&]+)/gi;
// CSS variable pattern for font definitions (--font-*: 'FontName', fallbacks)
const CSS_FONT_VARIABLE_PATTERN = /--(font-[a-zA-Z0-9-]+)\s*:\s*([^;]+)/gi;

/**
 * Parse font family string to extract primary and fallbacks
 */
function parseFontFamily(fontFamilyValue: string): { primary: string; fallbacks: string[]; category: FontFamily['category'] } {
  const fonts = fontFamilyValue
    .split(',')
    .map(f => f.trim().replace(/^['"]|['"]$/g, ''));

  const primary = fonts[0] ?? '';
  const fallbacks = fonts.slice(1);

  // Determine category from last fallback (generic family) or primary
  const lastFont = fonts[fonts.length - 1]?.toLowerCase() ?? '';
  let category: FontFamily['category'] = 'sans-serif';

  if (lastFont === 'serif') {
    category = 'serif';
  } else if (lastFont === 'monospace') {
    category = 'monospace';
  } else if (lastFont === 'cursive') {
    category = 'cursive';
  } else if (lastFont === 'fantasy' || lastFont === 'display') {
    category = 'display';
  } else if (lastFont === 'system-ui' || primary.toLowerCase() === 'system-ui') {
    category = 'system';
  }

  return { primary, fallbacks, category };
}

/**
 * Check if font is a system font
 */
function isSystemFont(fontName: string): boolean {
  return SYSTEM_FONTS.has(fontName);
}

/**
 * Check if font is a Google Font
 */
function isGoogleFont(fontName: string): boolean {
  return GOOGLE_FONTS.has(fontName);
}

/**
 * Parse size value to numeric rem/px
 */
function parseSizeToRem(size: string): number | null {
  const remMatch = size.match(/([\d.]+)\s*rem/);
  if (remMatch?.[1]) {
    return parseFloat(remMatch[1]);
  }

  const pxMatch = size.match(/([\d.]+)\s*px/);
  if (pxMatch?.[1]) {
    return parseFloat(pxMatch[1]) / 16; // Assume 16px base
  }

  return null;
}

/**
 * Detect type scale from font sizes
 */
function detectTypeScale(hierarchy: FontSizeHierarchy): { ratio: number; name: string } | undefined {
  const sizes: number[] = [];

  // Extract sizes in order from h6 to h1
  const sizeOrder = ['h6', 'h5', 'h4', 'h3', 'h2', 'h1'] as const;

  for (const key of sizeOrder) {
    const size = hierarchy[key];
    if (size) {
      const parsed = parseSizeToRem(size);
      if (parsed !== null) {
        sizes.push(parsed);
      }
    }
  }

  if (sizes.length < 2) {
    return undefined;
  }

  // Calculate average ratio between consecutive sizes
  const ratios: number[] = [];
  for (let i = 1; i < sizes.length; i++) {
    const prev = sizes[i - 1];
    const curr = sizes[i];
    if (prev && curr && prev > 0) {
      ratios.push(curr / prev);
    }
  }

  if (ratios.length === 0) {
    return undefined;
  }

  const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;

  // Find closest type scale
  let closest = TYPE_SCALES[0];
  let minDiff = Math.abs(avgRatio - (closest?.ratio ?? 1));

  for (const scale of TYPE_SCALES) {
    const diff = Math.abs(avgRatio - scale.ratio);
    if (diff < minDiff) {
      minDiff = diff;
      closest = scale;
    }
  }

  if (closest && minDiff < 0.05) {
    return { ratio: closest.ratio, name: closest.name };
  }

  return { ratio: avgRatio, name: 'Custom' };
}

/**
 * Internal implementation
 */
class TypographyExtractorServiceImpl implements TypographyExtractorService {
  extractFromCSS(css: string): TypographyExtractionResult {
    const startTime = Date.now();

    if (!css || typeof css !== 'string') {
      return this.emptyResult(Date.now() - startTime);
    }

    const fontFamilies: FontFamily[] = [];
    const styles: TypographyStyle[] = [];
    const responsiveTypography: ResponsiveTypography[] = [];
    const fontSizeHierarchy: FontSizeHierarchy = {};
    const variableFonts: string[] = [];
    let fontWeightRange: FontWeightRange | undefined;

    // Extract @font-face for variable fonts
    const fontFaceRegex = new RegExp(FONT_FACE_PATTERN.source, 'gi');
    let fontFaceMatch;

    while ((fontFaceMatch = fontFaceRegex.exec(css)) !== null) {
      const block = fontFaceMatch[1] ?? '';

      // Get font family name
      const familyMatch = block.match(/font-family\s*:\s*['"]?([^'";]+)/i);
      const fontName = familyMatch?.[1]?.trim();

      // Check for variable font weight range
      const weightRangeMatch = block.match(FONT_WEIGHT_RANGE_PATTERN);
      if (weightRangeMatch?.[1] && weightRangeMatch?.[2]) {
        fontWeightRange = {
          min: parseInt(weightRangeMatch[1], 10),
          max: parseInt(weightRangeMatch[2], 10),
        };
        if (fontName) {
          variableFonts.push(fontName);
        }
      }
    }

    // Extract CSS blocks
    const selectorBlockRegex = new RegExp(CSS_SELECTOR_BLOCK_PATTERN.source, 'g');
    let blockMatch;

    while ((blockMatch = selectorBlockRegex.exec(css)) !== null) {
      const selector = blockMatch[1]?.trim() ?? '';
      const block = blockMatch[2] ?? '';

      const style: TypographyStyle = { selector };

      // Extract font-family from CSS custom properties (e.g., --font-sans: 'Inter', sans-serif)
      // This handles :root { --font-sans: 'Inter', system-ui, sans-serif; }
      const fontVariableRegex = new RegExp(CSS_FONT_VARIABLE_PATTERN.source, 'gi');
      let fontVarMatch;
      while ((fontVarMatch = fontVariableRegex.exec(block)) !== null) {
        const varValue = fontVarMatch[2]?.trim();
        if (varValue) {
          const parsed = parseFontFamily(varValue);
          const fontFamily: FontFamily = {
            selector,
            primary: parsed.primary,
            fallbacks: parsed.fallbacks,
            category: parsed.category,
          };

          if (isSystemFont(parsed.primary)) {
            fontFamily.isSystemFont = true;
          }
          if (isGoogleFont(parsed.primary)) {
            fontFamily.isGoogleFont = true;
          }

          fontFamilies.push(fontFamily);
        }
      }

      // Extract font-family
      const fontFamilyMatch = block.match(/font-family\s*:\s*([^;]+)/i);
      if (fontFamilyMatch?.[1]) {
        const value = fontFamilyMatch[1].trim();
        style.fontFamily = value;

        const parsed = parseFontFamily(value);
        const fontFamily: FontFamily = {
          selector,
          primary: parsed.primary,
          fallbacks: parsed.fallbacks,
          category: parsed.category,
        };

        if (isSystemFont(parsed.primary)) {
          fontFamily.isSystemFont = true;
        }
        if (isGoogleFont(parsed.primary)) {
          fontFamily.isGoogleFont = true;
        }

        fontFamilies.push(fontFamily);
      }

      // Extract font-size
      const fontSizeMatch = block.match(/font-size\s*:\s*([^;]+)/i);
      if (fontSizeMatch?.[1]) {
        const value = fontSizeMatch[1].trim();
        style.fontSize = value;

        // Check for clamp()
        const clampMatch = value.match(CLAMP_PATTERN);
        if (clampMatch) {
          responsiveTypography.push({
            selector,
            min: clampMatch[1]?.trim() ?? '',
            preferred: clampMatch[2]?.trim() ?? '',
            max: clampMatch[3]?.trim() ?? '',
            isResponsive: true,
          });
        }

        // Update hierarchy for heading/body selectors
        const selectorLower = selector.toLowerCase();
        if (selectorLower === 'h1' || selectorLower.startsWith('h1,') || selectorLower.includes(' h1')) {
          fontSizeHierarchy.h1 = value;
        } else if (selectorLower === 'h2' || selectorLower.startsWith('h2,')) {
          fontSizeHierarchy.h2 = value;
        } else if (selectorLower === 'h3' || selectorLower.startsWith('h3,')) {
          fontSizeHierarchy.h3 = value;
        } else if (selectorLower === 'h4' || selectorLower.startsWith('h4,')) {
          fontSizeHierarchy.h4 = value;
        } else if (selectorLower === 'h5' || selectorLower.startsWith('h5,')) {
          fontSizeHierarchy.h5 = value;
        } else if (selectorLower === 'h6' || selectorLower.startsWith('h6,')) {
          fontSizeHierarchy.h6 = value;
        } else if (selectorLower === 'body' || selectorLower === 'p' || selectorLower === 'html') {
          fontSizeHierarchy.body = value;
        }
      }

      // Extract font-weight
      const fontWeightMatch = block.match(/font-weight\s*:\s*([^;]+)/i);
      if (fontWeightMatch?.[1]) {
        style.fontWeight = fontWeightMatch[1].trim();
      }

      // Extract line-height
      const lineHeightMatch = block.match(/line-height\s*:\s*([^;]+)/i);
      if (lineHeightMatch?.[1]) {
        style.lineHeight = lineHeightMatch[1].trim();
      }

      // Extract letter-spacing
      const letterSpacingMatch = block.match(/letter-spacing\s*:\s*([^;]+)/i);
      if (letterSpacingMatch?.[1]) {
        style.letterSpacing = letterSpacingMatch[1].trim();
      }

      // Only add to styles if we found any typography properties
      if (style.fontFamily || style.fontSize || style.fontWeight ||
          style.lineHeight || style.letterSpacing) {
        styles.push(style);
      }
    }

    // Detect type scale
    const scaleInfo = detectTypeScale(fontSizeHierarchy);

    logger.debug('[TypographyExtractor] extractFromCSS:', {
      fontFamiliesCount: fontFamilies.length,
      stylesCount: styles.length,
      responsiveCount: responsiveTypography.length,
      scaleRatio: scaleInfo?.ratio,
    });

    // Build result with exactOptionalPropertyTypes compliance
    const result: TypographyExtractionResult = {
      fontFamilies,
      fontSizeHierarchy,
      styles,
      responsiveTypography,
      inlineStyles: [],
      variableFonts,
      googleFontsUsed: [],
      processingTimeMs: Date.now() - startTime,
    };

    // Only add optional properties if they have values
    if (scaleInfo?.ratio !== undefined) {
      result.scaleRatio = scaleInfo.ratio;
    }
    if (scaleInfo?.name) {
      result.scaleName = scaleInfo.name;
    }
    if (fontWeightRange) {
      result.fontWeightRange = fontWeightRange;
    }

    return result;
  }

  extractFromHTML(html: string): TypographyExtractionResult {
    const startTime = Date.now();

    if (!html || typeof html !== 'string') {
      return this.emptyResult(Date.now() - startTime);
    }

    let combinedCss = '';
    const inlineStyles: InlineTypographyStyle[] = [];
    const googleFontsUsed: string[] = [];
    const googleFontsWeights: Record<string, string[]> = {};

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

    while ((inlineMatch = inlineRegex.exec(html)) !== null) {
      const styleValue = inlineMatch[1] ?? '';

      const inlineStyle: InlineTypographyStyle = {};

      const fontFamilyMatch = styleValue.match(/font-family\s*:\s*([^;]+)/i);
      if (fontFamilyMatch?.[1]) {
        inlineStyle.fontFamily = fontFamilyMatch[1].trim();
      }

      const fontSizeMatch = styleValue.match(/font-size\s*:\s*([^;]+)/i);
      if (fontSizeMatch?.[1]) {
        inlineStyle.fontSize = fontSizeMatch[1].trim();
      }

      const lineHeightMatch = styleValue.match(/line-height\s*:\s*([^;]+)/i);
      if (lineHeightMatch?.[1]) {
        inlineStyle.lineHeight = lineHeightMatch[1].trim();
      }

      const letterSpacingMatch = styleValue.match(/letter-spacing\s*:\s*([^;]+)/i);
      if (letterSpacingMatch?.[1]) {
        inlineStyle.letterSpacing = letterSpacingMatch[1].trim();
      }

      if (Object.keys(inlineStyle).length > 0) {
        inlineStyles.push(inlineStyle);
      }
    }

    // Detect Google Fonts from <link> tags
    const googleFontsRegex = new RegExp(GOOGLE_FONTS_LINK_PATTERN.source, 'gi');
    let googleMatch;

    while ((googleMatch = googleFontsRegex.exec(html)) !== null) {
      const fontSpec = googleMatch[1];
      if (fontSpec) {
        // Parse font family and weights from URL
        // Format: family=Inter:wght@400;500;600;700
        const families = decodeURIComponent(fontSpec).split('&family=');

        for (const family of families) {
          const [name, weightSpec] = family.split(':');
          if (name) {
            const fontName = name.replace(/\+/g, ' ');
            googleFontsUsed.push(fontName);

            // Extract weights
            if (weightSpec) {
              const weightsMatch = weightSpec.match(/wght@([\d;]+)/);
              if (weightsMatch?.[1]) {
                googleFontsWeights[fontName] = weightsMatch[1].split(';');
              }
            }
          }
        }
      }
    }

    const result = this.extractFromCSS(combinedCss);

    // Build result with exactOptionalPropertyTypes compliance
    const finalResult: TypographyExtractionResult = {
      ...result,
      inlineStyles,
      googleFontsUsed: [...new Set(googleFontsUsed)],
      processingTimeMs: Date.now() - startTime,
    };

    // Only add googleFontsWeights if it has entries
    if (Object.keys(googleFontsWeights).length > 0) {
      finalResult.googleFontsWeights = googleFontsWeights;
    }

    return finalResult;
  }

  extract(html: string, externalCss?: string): TypographyExtractionResult {
    const startTime = Date.now();

    const htmlResult = this.extractFromHTML(html ?? '');
    const cssResult = externalCss ? this.extractFromCSS(externalCss) : this.emptyResult(0);

    // Merge font families
    const fontFamilyMap = new Map<string, FontFamily>();
    for (const ff of htmlResult.fontFamilies) {
      fontFamilyMap.set(`${ff.selector}:${ff.primary}`, ff);
    }
    for (const ff of cssResult.fontFamilies) {
      fontFamilyMap.set(`${ff.selector}:${ff.primary}`, ff);
    }

    // Merge styles
    const styleMap = new Map<string, TypographyStyle>();
    for (const s of htmlResult.styles) {
      styleMap.set(s.selector, s);
    }
    for (const s of cssResult.styles) {
      const existing = styleMap.get(s.selector);
      if (existing) {
        styleMap.set(s.selector, { ...existing, ...s });
      } else {
        styleMap.set(s.selector, s);
      }
    }

    // Merge font size hierarchy
    const mergedHierarchy: FontSizeHierarchy = {
      ...htmlResult.fontSizeHierarchy,
      ...cssResult.fontSizeHierarchy,
    };

    // Detect scale from merged hierarchy
    const scaleInfo = detectTypeScale(mergedHierarchy);

    // Build result with exactOptionalPropertyTypes compliance
    const extractResult: TypographyExtractionResult = {
      fontFamilies: [...fontFamilyMap.values()],
      fontSizeHierarchy: mergedHierarchy,
      styles: [...styleMap.values()],
      responsiveTypography: [
        ...htmlResult.responsiveTypography,
        ...cssResult.responsiveTypography,
      ],
      inlineStyles: htmlResult.inlineStyles,
      variableFonts: [...new Set([...htmlResult.variableFonts, ...cssResult.variableFonts])],
      googleFontsUsed: htmlResult.googleFontsUsed,
      processingTimeMs: Date.now() - startTime,
    };

    // Only add optional properties if they have values
    const finalScaleRatio = scaleInfo?.ratio ?? htmlResult.scaleRatio;
    if (finalScaleRatio !== undefined) {
      extractResult.scaleRatio = finalScaleRatio;
    }

    const finalScaleName = scaleInfo?.name ?? htmlResult.scaleName;
    if (finalScaleName) {
      extractResult.scaleName = finalScaleName;
    }

    const finalFontWeightRange = htmlResult.fontWeightRange ?? cssResult.fontWeightRange;
    if (finalFontWeightRange) {
      extractResult.fontWeightRange = finalFontWeightRange;
    }

    if (htmlResult.googleFontsWeights) {
      extractResult.googleFontsWeights = htmlResult.googleFontsWeights;
    }

    return extractResult;
  }

  private emptyResult(processingTimeMs: number): TypographyExtractionResult {
    return {
      fontFamilies: [],
      fontSizeHierarchy: {},
      styles: [],
      responsiveTypography: [],
      inlineStyles: [],
      variableFonts: [],
      googleFontsUsed: [],
      processingTimeMs,
    };
  }
}

/**
 * Create a new TypographyExtractorService instance
 */
export function createTypographyExtractorService(): TypographyExtractorService {
  return new TypographyExtractorServiceImpl();
}
