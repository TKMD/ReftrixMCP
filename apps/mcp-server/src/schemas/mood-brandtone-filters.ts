// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/**
 * TASK-04 (GREEN Phase): Zod Schema Implementation
 *
 * Purpose: Define type-safe validation schemas for mood/brandTone filters
 * - moodFilterSchema: Mood filter constraints (primary, secondary, minSimilarity, weight)
 * - brandToneFilterSchema: BrandTone filter constraints (identical structure)
 * - rrfWeightsSchema: Reciprocal Rank Fusion weight validation
 *
 * Constraints:
 * - primary/secondary: Enum of 8 values (professional, playful, minimal, bold, elegant, friendly, corporate, creative)
 * - minSimilarity: Number [0, 1], default 0.5
 * - weight: Number [0, 1], default 0.2
 * - RRF weights: mood + brandTone <= 1.0
 */

// ========== Enum Definitions ==========

/**
 * Valid mood values for semantic search
 * Used for layout pattern analysis with emotional/contextual semantics
 */
export const MOOD_ENUM = z.enum([
  'professional',
  'playful',
  'minimal',
  'bold',
  'elegant',
  'friendly',
  'corporate',
  'creative'
]);

export type Mood = z.infer<typeof MOOD_ENUM>;

/**
 * Valid brand tone values for semantic search
 * Identical to Mood enum - represents brand positioning semantics
 */
export const BRAND_TONE_ENUM = z.enum([
  'professional',
  'playful',
  'minimal',
  'bold',
  'elegant',
  'friendly',
  'corporate',
  'creative'
]);

export type BrandTone = z.infer<typeof BRAND_TONE_ENUM>;

// ========== Filter Schemas ==========

/**
 * Mood Filter Schema
 *
 * Constraints:
 * - primary: Required, must be valid Mood enum value
 * - secondary: Optional, must be valid Mood enum value
 * - minSimilarity: Number [0, 1], default 0.5
 * - weight: Number [0, 1], default 0.2 (used in RRF for combined searches)
 */
export const moodFilterSchema = z.object({
  primary: MOOD_ENUM,
  secondary: MOOD_ENUM.optional(),
  minSimilarity: z.number().min(0).max(1).default(0.5),
  weight: z.number().min(0).max(1).default(0.2)
});

export type MoodFilter = z.infer<typeof moodFilterSchema>;

/**
 * Brand Tone Filter Schema
 *
 * Constraints: Identical to MoodFilter
 * - primary: Required, must be valid BrandTone enum value
 * - secondary: Optional, must be valid BrandTone enum value
 * - minSimilarity: Number [0, 1], default 0.5
 * - weight: Number [0, 1], default 0.3 (used in RRF for combined searches)
 */
export const brandToneFilterSchema = z.object({
  primary: BRAND_TONE_ENUM,
  secondary: BRAND_TONE_ENUM.optional(),
  minSimilarity: z.number().min(0).max(1).default(0.5),
  weight: z.number().min(0).max(1).default(0.3)
});

export type BrandToneFilter = z.infer<typeof brandToneFilterSchema>;

// ========== RRF (Reciprocal Rank Fusion) Schemas ==========

/**
 * RRF Weights Schema
 *
 * Defines weight distribution between mood and brandTone results in combined search
 *
 * Constraints:
 * - mood: Number [0, 1], default 0.6 (60% weight)
 * - brandTone: Number [0, 1], default 0.4 (40% weight)
 * - Sum validation: mood + brandTone <= 1.0
 *
 * RRF Formula: score = (mood_score * mood_weight) + (brandTone_score * brandTone_weight)
 */
export const rrfWeightsSchema = z.object({
  mood: z.number().min(0).max(1).default(0.6),
  brandTone: z.number().min(0).max(1).default(0.4)
}).refine(
  data => {
    const sum = data.mood + data.brandTone;
    return sum <= 1.0 + 0.001; // Allow small floating point tolerance
  },
  {
    message: 'RRF weights must sum to ≤ 1.0. Recommended: mood + brandTone = 1.0'
  }
);

export type RRFWeights = z.infer<typeof rrfWeightsSchema>;

// ========== Combined Search Schemas ==========

/**
 * Extended Layout Search Filter Schema
 *
 * Includes mood and brandTone filters as optional extensions to existing filters
 */
export const extendedLayoutSearchFilterSchema = z.object({
  sectionType: z.string().optional(),
  sourceType: z.string().optional(),
  usageScope: z.string().optional(),
  visualFeatures: z.object({
    theme: z.object({
      type: z.string().optional(),
      minContrastRatio: z.number().optional()
    }).optional(),
    colors: z.object({
      dominantColor: z.string().optional(),
      colorTolerance: z.number().optional()
    }).optional(),
    density: z.object({
      minContentDensity: z.number().optional(),
      maxContentDensity: z.number().optional()
    }).optional(),
    gradient: z.object({
      requireGradient: z.boolean().optional(),
      gradientType: z.string().optional()
    }).optional()
  }).optional(),
  mood: moodFilterSchema.optional(),
  brandTone: brandToneFilterSchema.optional()
});

export type ExtendedLayoutSearchFilter = z.infer<typeof extendedLayoutSearchFilterSchema>;

// ========== Search Request Schemas ==========

/**
 * Mood Search Request Schema
 *
 * Used by MoodBrandToneSearchService.searchByMood()
 */
export const moodSearchRequestSchema = z.object({
  filter: moodFilterSchema,
  limit: z.number().min(1).max(100).default(10),
  offset: z.number().min(0).default(0)
});

export type MoodSearchRequest = z.infer<typeof moodSearchRequestSchema>;

/**
 * Brand Tone Search Request Schema
 *
 * Used by MoodBrandToneSearchService.searchByBrandTone()
 */
export const brandToneSearchRequestSchema = z.object({
  filter: brandToneFilterSchema,
  limit: z.number().min(1).max(100).default(10),
  offset: z.number().min(0).default(0)
});

export type BrandToneSearchRequest = z.infer<typeof brandToneSearchRequestSchema>;

/**
 * Combined Search Request Schema
 *
 * Used when both mood and brandTone filters are applied with RRF combination
 */
export const combinedSearchRequestSchema = z.object({
  moodFilter: moodFilterSchema.optional(),
  brandToneFilter: brandToneFilterSchema.optional(),
  rrfWeights: rrfWeightsSchema.optional(),
  limit: z.number().min(1).max(100).default(10),
  offset: z.number().min(0).default(0)
}).refine(
  data => data.moodFilter || data.brandToneFilter,
  {
    message: 'At least one of moodFilter or brandToneFilter must be provided'
  }
);

export type CombinedSearchRequest = z.infer<typeof combinedSearchRequestSchema>;

// ========== Search Result Schemas ==========

/**
 * Search Result Schema
 *
 * Result item from searchByMood() or searchByBrandTone()
 */
export const searchResultSchema = z.object({
  patternId: z.string().uuid(),
  similarity: z.number().min(0).max(1),
  moodInfo: z.object({
    primary: MOOD_ENUM,
    secondary: MOOD_ENUM.optional()
  }).optional(),
  brandToneInfo: z.object({
    primary: BRAND_TONE_ENUM,
    secondary: BRAND_TONE_ENUM.optional()
  }).optional()
});

export type SearchResult = z.infer<typeof searchResultSchema>;

/**
 * Combined Search Result Schema
 *
 * Result from combineResultsWithRRF() with metadata
 */
export const combinedSearchResultSchema = z.object({
  results: z.array(searchResultSchema),
  averageSimilarity: z.number().min(0).max(1),
  metadata: z.object({
    moodCount: z.number().min(0),
    brandToneCount: z.number().min(0),
    totalCount: z.number().min(0),
    rrfWeights: rrfWeightsSchema
  })
});

export type CombinedSearchResult = z.infer<typeof combinedSearchResultSchema>;

// ========== Validation Helper Functions ==========

/**
 * Validate and parse mood filter input
 *
 * @param input - Raw input to validate
 * @returns Parsed and validated MoodFilter
 * @throws ZodError if validation fails
 */
export function parseMoodFilter(input: unknown): MoodFilter {
  return moodFilterSchema.parse(input);
}

/**
 * Validate and parse brand tone filter input
 *
 * @param input - Raw input to validate
 * @returns Parsed and validated BrandToneFilter
 * @throws ZodError if validation fails
 */
export function parseBrandToneFilter(input: unknown): BrandToneFilter {
  return brandToneFilterSchema.parse(input);
}

/**
 * Validate and parse RRF weights
 *
 * @param input - Raw input to validate
 * @returns Parsed and validated RRFWeights
 * @throws ZodError if validation fails
 */
export function parseRRFWeights(input: unknown): RRFWeights {
  return rrfWeightsSchema.parse(input);
}

/**
 * Validate search result against schema
 *
 * @param input - Raw result to validate
 * @returns Parsed and validated SearchResult
 * @throws ZodError if validation fails
 */
export function parseSearchResult(input: unknown): SearchResult {
  return searchResultSchema.parse(input);
}
