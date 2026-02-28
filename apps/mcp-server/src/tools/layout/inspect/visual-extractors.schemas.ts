// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visual Extractors Zod Schemas
 *
 * Schemas for CSS Variable Extractor, Typography Extractor, and Gradient Detector services.
 * Used for validating extraction results and API responses.
 *
 * @module tools/layout/inspect/visual-extractors.schemas
 */

import { z } from 'zod';

// =====================================================
// CSS Variable Extractor Schemas
// =====================================================

/**
 * CSS Variable category enumeration
 */
export const cssVariableCategorySchema = z.enum([
  'color',
  'spacing',
  'typography',
  'sizing',
  'animation',
  'other',
]);

/**
 * Single CSS variable schema
 */
export const cssVariableSchema = z.object({
  /** Variable name (e.g., '--color-primary') */
  name: z.string().startsWith('--'),
  /** Raw CSS value */
  value: z.string(),
  /** CSS selector where defined */
  selector: z.string(),
  /** Variable category */
  category: cssVariableCategorySchema,
  /** Referenced variables (if value contains var()) */
  references: z.array(z.string()).optional(),
});

/**
 * clamp() value schema
 */
export const clampValueSchema = z.object({
  /** Minimum value */
  min: z.string(),
  /** Preferred/flexible value */
  preferred: z.string(),
  /** Maximum value */
  max: z.string(),
  /** Raw clamp() expression */
  raw: z.string(),
  /** CSS selector where used */
  selector: z.string(),
  /** Property name (e.g., 'font-size', 'width') */
  property: z.string(),
});

/**
 * calc() expression schema
 */
export const calcExpressionSchema = z.object({
  /** calc() expression (without 'calc()' wrapper) */
  expression: z.string(),
  /** Raw calc() value */
  raw: z.string(),
  /** CSS selector where used */
  selector: z.string(),
  /** Property name */
  property: z.string(),
});

/**
 * Design token system type
 */
export const designTokenSystemSchema = z.enum([
  'tailwind',
  'open-props',
  'css-in-js',
  'custom',
  'unknown',
]);

/**
 * Design tokens detection result
 */
export const designTokensResultSchema = z.object({
  /** Detected design token system */
  system: designTokenSystemSchema,
  /** Detection confidence (0-1) */
  confidence: z.number().min(0).max(1),
  /** Evidence strings for detection */
  evidence: z.array(z.string()),
});

/**
 * CSS Variable extraction result schema
 */
export const cssVariableExtractionResultSchema = z.object({
  /** Extracted CSS variables */
  variables: z.array(cssVariableSchema),
  /** Extracted clamp() values */
  clampValues: z.array(clampValueSchema),
  /** Extracted calc() expressions */
  calcExpressions: z.array(calcExpressionSchema),
  /** Design token detection result */
  designTokens: designTokensResultSchema.optional(),
  /** Processing time in milliseconds */
  processingTimeMs: z.number(),
});

// =====================================================
// Typography Extractor Schemas
// =====================================================

/**
 * Font category enumeration
 */
export const fontCategorySchema = z.enum([
  'serif',
  'sans-serif',
  'monospace',
  'display',
  'cursive',
  'system',
]);

/**
 * Font family schema
 */
export const fontFamilySchema = z.object({
  /** CSS selector */
  selector: z.string(),
  /** Primary font name */
  primary: z.string(),
  /** Fallback fonts */
  fallbacks: z.array(z.string()),
  /** Font category */
  category: fontCategorySchema,
  /** Whether it's a system font stack */
  isSystemFont: z.boolean().optional(),
  /** Whether it's a Google Font */
  isGoogleFont: z.boolean().optional(),
});

/**
 * Font size hierarchy schema
 */
export const fontSizeHierarchySchema = z.object({
  h1: z.string().optional(),
  h2: z.string().optional(),
  h3: z.string().optional(),
  h4: z.string().optional(),
  h5: z.string().optional(),
  h6: z.string().optional(),
  body: z.string().optional(),
  small: z.string().optional(),
});

/**
 * Responsive typography schema (clamp-based)
 */
export const responsiveTypographySchema = z.object({
  /** CSS selector */
  selector: z.string(),
  /** Minimum font size */
  min: z.string(),
  /** Preferred/flexible font size */
  preferred: z.string(),
  /** Maximum font size */
  max: z.string(),
  /** Whether it's responsive */
  isResponsive: z.boolean(),
});

/**
 * Typography style schema
 */
export const typographyStyleSchema = z.object({
  /** CSS selector */
  selector: z.string(),
  /** Font family (raw value) */
  fontFamily: z.string().optional(),
  /** Font size */
  fontSize: z.string().optional(),
  /** Font weight */
  fontWeight: z.string().optional(),
  /** Line height */
  lineHeight: z.string().optional(),
  /** Letter spacing */
  letterSpacing: z.string().optional(),
});

/**
 * Inline typography style schema (from HTML style attribute)
 */
export const inlineTypographyStyleSchema = z.object({
  /** Font family */
  fontFamily: z.string().optional(),
  /** Font size */
  fontSize: z.string().optional(),
  /** Line height */
  lineHeight: z.string().optional(),
  /** Letter spacing */
  letterSpacing: z.string().optional(),
});

/**
 * Font weight range schema (for variable fonts)
 */
export const fontWeightRangeSchema = z.object({
  min: z.number().min(1).max(1000),
  max: z.number().min(1).max(1000),
});

/**
 * Type scale name enumeration
 */
export const typeScaleNameSchema = z.enum([
  'Minor Second',
  'Major Second',
  'Minor Third',
  'Major Third',
  'Perfect Fourth',
  'Augmented Fourth',
  'Perfect Fifth',
  'Golden Ratio',
  'Custom',
]);

/**
 * Typography extraction result schema
 */
export const typographyExtractionResultSchema = z.object({
  /** Extracted font families */
  fontFamilies: z.array(fontFamilySchema),
  /** Font size hierarchy */
  fontSizeHierarchy: fontSizeHierarchySchema,
  /** Complete typography styles */
  styles: z.array(typographyStyleSchema),
  /** Responsive typography with clamp() */
  responsiveTypography: z.array(responsiveTypographySchema),
  /** Inline styles from HTML */
  inlineStyles: z.array(inlineTypographyStyleSchema),
  /** Detected scale ratio */
  scaleRatio: z.number().optional(),
  /** Scale name */
  scaleName: typeScaleNameSchema.optional(),
  /** Variable fonts detected */
  variableFonts: z.array(z.string()),
  /** Font weight range (for variable fonts) */
  fontWeightRange: fontWeightRangeSchema.optional(),
  /** Google Fonts used */
  googleFontsUsed: z.array(z.string()),
  /** Google Fonts weights by font name */
  googleFontsWeights: z.record(z.string(), z.array(z.string())).optional(),
  /** Processing time in milliseconds */
  processingTimeMs: z.number(),
});

// =====================================================
// Gradient Detector Schemas
// =====================================================

/**
 * Gradient type enumeration
 */
export const gradientTypeSchema = z.enum([
  'linear',
  'radial',
  'conic',
  'repeating-linear',
  'repeating-radial',
  'repeating-conic',
]);

/**
 * Gradient color stop schema
 */
export const gradientColorStopSchema = z.object({
  /** Color value (hex, rgb, rgba, etc.) */
  color: z.string(),
  /** Position in gradient (0-100 as percentage, or raw value like '50%') */
  position: z.union([z.number(), z.string()]).optional(),
});

/**
 * Gradient region (bounding box) schema
 */
export const gradientRegionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/**
 * Gradient animation info schema
 */
export const gradientAnimationSchema = z.object({
  /** Animation name */
  name: z.string(),
  /** Duration (e.g., '3s', '300ms') */
  duration: z.string().optional(),
  /** Timing function (e.g., 'ease', 'linear') */
  timingFunction: z.string().optional(),
  /** Iteration count (e.g., 'infinite', '3') */
  iterationCount: z.string().optional(),
  /** Animation direction (e.g., 'normal', 'alternate') */
  direction: z.string().optional(),
  /** Delay (e.g., '0s', '500ms') */
  delay: z.string().optional(),
  /** Fill mode (e.g., 'forwards', 'backwards') */
  fillMode: z.string().optional(),
});

/**
 * Gradient transition info schema
 */
export const gradientTransitionSchema = z.object({
  /** Transition property (e.g., 'background', 'all') */
  property: z.string(),
  /** Duration (e.g., '0.3s') */
  duration: z.string().optional(),
  /** Timing function (e.g., 'ease', 'ease-in-out') */
  timingFunction: z.string().optional(),
  /** Delay (e.g., '0s') */
  delay: z.string().optional(),
});

/**
 * Detected gradient schema
 */
export const detectedGradientSchema = z.object({
  /** Gradient type */
  type: gradientTypeSchema,
  /** Color stops in the gradient */
  colorStops: z.array(gradientColorStopSchema),
  /** Angle for linear gradients (degrees) */
  angle: z.number().optional(),
  /** Center position for radial gradients */
  center: z.object({ x: z.number(), y: z.number() }).optional(),
  /** Region where gradient was detected */
  region: gradientRegionSchema,
  /** Detection confidence (0-1) */
  confidence: z.number().min(0).max(1),
  /** Generated CSS string */
  cssString: z.string().optional(),
  /** Animation info (if animated) */
  animation: gradientAnimationSchema.optional(),
  /** Transition info (if transitioning) */
  transition: gradientTransitionSchema.optional(),
  /** Parent element selector (from CSS context) */
  parentElement: z.string().optional(),
});

/**
 * Gradient detection result schema
 */
export const gradientDetectionResultSchema = z.object({
  /** Whether any gradient was detected */
  hasGradient: z.boolean(),
  /** Detected gradients */
  gradients: z.array(detectedGradientSchema),
  /** Dominant gradient type (if multiple) */
  dominantType: gradientTypeSchema.optional(),
  /** Processing time in milliseconds */
  processingTimeMs: z.number().optional(),
});

// =====================================================
// Visual Decoration Schemas
// =====================================================

/**
 * Visual decoration type enumeration
 *
 * - glow: Glow effect from box-shadow (e.g., `box-shadow: 0 0 20px rgba(...)`)
 * - gradient: Gradient background from linear/radial/conic-gradient
 * - animated-border: Animated or gradient border effects
 * - glass-morphism: Glass effect from backdrop-filter
 */
export const visualDecorationTypeSchema = z.enum([
  'glow',
  'gradient',
  'animated-border',
  'glass-morphism',
]);

/**
 * Glow effect properties schema
 *
 * Detected from box-shadow property with pattern: `0 0 Xpx rgba(R,G,B,A)`
 */
export const glowPropertiesSchema = z.object({
  /** Glow color (hex, rgb, rgba, hsl, etc.) */
  color: z.string(),
  /** Blur radius in pixels */
  blur: z.number().min(0),
  /** Spread radius in pixels */
  spread: z.number().optional(),
  /** Glow intensity (0-1, calculated from alpha if rgba) */
  intensity: z.number().min(0).max(1).optional(),
  /** Whether the glow is inset */
  inset: z.boolean().optional(),
  /** Raw box-shadow value */
  rawValue: z.string().optional(),
});

/**
 * Gradient background properties schema
 *
 * Detected from background/background-image with gradient functions
 */
export const gradientBackgroundPropertiesSchema = z.object({
  /** Gradient type */
  gradientType: z.enum(['linear', 'radial', 'conic']),
  /** Angle in degrees (for linear gradients) */
  angle: z.number().optional(),
  /** Color stops with position */
  colorStops: z.array(
    z.object({
      /** Color value */
      color: z.string(),
      /** Position (0-100 percentage or raw value) */
      position: z.union([z.number(), z.string()]).optional(),
    })
  ),
  /** Shape for radial gradients (circle, ellipse) */
  shape: z.string().optional(),
  /** Size for radial gradients */
  size: z.string().optional(),
  /** Position for radial/conic gradients */
  position: z.string().optional(),
  /** Raw gradient CSS value */
  rawValue: z.string().optional(),
});

/**
 * Animated border properties schema
 *
 * Detected from border-image, animated border effects, or glowing borders
 */
export const animatedBorderPropertiesSchema = z.object({
  /** Animation name (from @keyframes) */
  animationName: z.string().optional(),
  /** Animation duration in milliseconds */
  duration: z.number().optional(),
  /** Animation timing function */
  timingFunction: z.string().optional(),
  /** Animation iteration count */
  iterationCount: z.union([z.number(), z.literal('infinite')]).optional(),
  /** Border width */
  borderWidth: z.string().optional(),
  /** Border image source (gradient, URL, etc.) */
  borderImageSource: z.string().optional(),
  /** Border image slice */
  borderImageSlice: z.string().optional(),
  /** Whether it's a gradient border */
  isGradientBorder: z.boolean().optional(),
  /** Whether it uses box-shadow for glowing effect */
  isGlowingBorder: z.boolean().optional(),
  /** Glow color for glowing borders */
  glowColor: z.string().optional(),
  /** Raw border/animation CSS values */
  rawValue: z.string().optional(),
});

/**
 * Glass morphism properties schema
 *
 * Detected from backdrop-filter property
 */
export const glassMorphismPropertiesSchema = z.object({
  /** Blur amount in pixels */
  blur: z.number().optional(),
  /** Saturation multiplier (1 = normal) */
  saturation: z.number().optional(),
  /** Brightness multiplier (1 = normal) */
  brightness: z.number().optional(),
  /** Background color/gradient with transparency */
  backgroundColor: z.string().optional(),
  /** Background opacity (0-1) */
  backgroundOpacity: z.number().min(0).max(1).optional(),
  /** Border (often subtle white/light border) */
  border: z.string().optional(),
  /** Raw backdrop-filter value */
  rawValue: z.string().optional(),
});

/**
 * Visual decoration properties (union of all property types)
 */
export const visualDecorationPropertiesSchema = z.object({
  // Glow properties
  color: z.string().optional(),
  blur: z.number().optional(),
  spread: z.number().optional(),
  intensity: z.number().min(0).max(1).optional(),
  inset: z.boolean().optional(),

  // Gradient properties
  gradientType: z.enum(['linear', 'radial', 'conic']).optional(),
  angle: z.number().optional(),
  colorStops: z
    .array(
      z.object({
        color: z.string(),
        position: z.union([z.number(), z.string()]).optional(),
      })
    )
    .optional(),
  shape: z.string().optional(),
  size: z.string().optional(),
  position: z.string().optional(),

  // Animated border properties
  animationName: z.string().optional(),
  duration: z.number().optional(),
  timingFunction: z.string().optional(),
  iterationCount: z.union([z.number(), z.literal('infinite')]).optional(),
  borderWidth: z.string().optional(),
  borderImageSource: z.string().optional(),
  borderImageSlice: z.string().optional(),
  isGradientBorder: z.boolean().optional(),
  isGlowingBorder: z.boolean().optional(),
  glowColor: z.string().optional(),

  // Glass morphism properties
  saturation: z.number().optional(),
  brightness: z.number().optional(),
  backgroundColor: z.string().optional(),
  backgroundOpacity: z.number().min(0).max(1).optional(),
  border: z.string().optional(),

  // Raw CSS value (common to all)
  rawValue: z.string().optional(),
});

/**
 * Visual decoration schema
 *
 * Represents a detected visual effect (glow, gradient, animated border, glass morphism)
 */
export const visualDecorationSchema = z.object({
  /** Type of visual decoration */
  type: visualDecorationTypeSchema,
  /** CSS selector where the decoration was found */
  element: z.string(),
  /** Decoration-specific properties */
  properties: visualDecorationPropertiesSchema,
  /** Detection confidence (0-1) */
  confidence: z.number().min(0).max(1),
});

/**
 * Visual decorations extraction result schema
 */
export const visualDecorationsResultSchema = z.object({
  /** Detected visual decorations */
  decorations: z.array(visualDecorationSchema),
  /** Summary by type */
  summary: z.object({
    /** Total glow effects */
    glowCount: z.number(),
    /** Total gradient backgrounds */
    gradientCount: z.number(),
    /** Total animated borders */
    animatedBorderCount: z.number(),
    /** Total glass morphism effects */
    glassMorphismCount: z.number(),
  }),
  /** Processing time in milliseconds */
  processingTimeMs: z.number(),
});

// =====================================================
// Combined Visual Features Schema
// =====================================================

/**
 * Combined visual extraction result schema
 */
export const visualExtractionResultSchema = z.object({
  /** CSS variable extraction results */
  cssVariables: cssVariableExtractionResultSchema.optional(),
  /** Typography extraction results */
  typography: typographyExtractionResultSchema.optional(),
  /** Gradient detection results */
  gradients: gradientDetectionResultSchema.optional(),
  /** Visual decorations (glow, animated border, glass morphism, etc.) */
  visualDecorations: visualDecorationsResultSchema.optional(),
  /** Overall processing time */
  totalProcessingTimeMs: z.number(),
});

// =====================================================
// Type Exports
// =====================================================

export type CSSVariableCategory = z.infer<typeof cssVariableCategorySchema>;
export type CSSVariable = z.infer<typeof cssVariableSchema>;
export type ClampValue = z.infer<typeof clampValueSchema>;
export type CalcExpression = z.infer<typeof calcExpressionSchema>;
export type DesignTokenSystem = z.infer<typeof designTokenSystemSchema>;
export type DesignTokensResult = z.infer<typeof designTokensResultSchema>;
export type CSSVariableExtractionResult = z.infer<typeof cssVariableExtractionResultSchema>;

export type FontCategory = z.infer<typeof fontCategorySchema>;
export type FontFamilyInfo = z.infer<typeof fontFamilySchema>;
export type FontSizeHierarchy = z.infer<typeof fontSizeHierarchySchema>;
export type ResponsiveTypographyInfo = z.infer<typeof responsiveTypographySchema>;
export type TypographyStyleInfo = z.infer<typeof typographyStyleSchema>;
export type InlineTypographyStyleInfo = z.infer<typeof inlineTypographyStyleSchema>;
export type FontWeightRange = z.infer<typeof fontWeightRangeSchema>;
export type TypeScaleName = z.infer<typeof typeScaleNameSchema>;
export type TypographyExtractionResult = z.infer<typeof typographyExtractionResultSchema>;

export type GradientType = z.infer<typeof gradientTypeSchema>;
export type GradientColorStop = z.infer<typeof gradientColorStopSchema>;
export type GradientRegion = z.infer<typeof gradientRegionSchema>;
export type GradientAnimation = z.infer<typeof gradientAnimationSchema>;
export type GradientTransition = z.infer<typeof gradientTransitionSchema>;
export type DetectedGradient = z.infer<typeof detectedGradientSchema>;
export type GradientDetectionResult = z.infer<typeof gradientDetectionResultSchema>;

export type VisualDecorationType = z.infer<typeof visualDecorationTypeSchema>;
export type GlowProperties = z.infer<typeof glowPropertiesSchema>;
export type GradientBackgroundProperties = z.infer<typeof gradientBackgroundPropertiesSchema>;
export type AnimatedBorderProperties = z.infer<typeof animatedBorderPropertiesSchema>;
export type GlassMorphismProperties = z.infer<typeof glassMorphismPropertiesSchema>;
export type VisualDecorationProperties = z.infer<typeof visualDecorationPropertiesSchema>;
export type VisualDecoration = z.infer<typeof visualDecorationSchema>;
export type VisualDecorationsResult = z.infer<typeof visualDecorationsResultSchema>;

export type VisualExtractionResult = z.infer<typeof visualExtractionResultSchema>;
