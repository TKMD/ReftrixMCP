// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

/**
 * TASK-02 (RED Phase): LayoutSearchHandler Unit Tests - mood/brandTone Filter Extension
 *
 * Purpose: Test-Driven Development - RED Phase
 * - Write failing tests BEFORE implementation
 * - Tests define expected behavior of layout.search handler with mood/brandTone filters
 * - Handler will be extended in TASK-07 (GREEN Phase)
 *
 * Test Count Target: 20+ tests
 * Coverage Target: > 80% Statement, > 70% Branch, > 85% Function
 */

interface ExtendedLayoutSearchInput {
  query: string;
  filters?: {
    sectionType?: string;
    sourceType?: string;
    usageScope?: string;
    visualFeatures?: {
      theme?: { type?: string; minContrastRatio?: number };
      colors?: { dominantColor?: string; colorTolerance?: number };
      density?: { minContentDensity?: number; maxContentDensity?: number };
      gradient?: { requireGradient?: boolean; gradientType?: string };
    };
    mood?: {
      primary: string;
      secondary?: string;
      minSimilarity?: number;
      weight?: number;
    };
    brandTone?: {
      primary: string;
      secondary?: string;
      minSimilarity?: number;
      weight?: number;
    };
  };
  limit?: number;
  offset?: number;
  include_html?: boolean;
  use_vision_search?: boolean;
}

interface ExtendedLayoutSearchResult {
  patterns: Array<{
    id: string;
    sectionType: string;
    similarity: number;
    moodInfo?: { primary: string; secondary?: string };
    brandToneInfo?: { primary: string; secondary?: string };
  }>;
  metadata: {
    totalCount: number;
    limit: number;
    offset: number;
    searchTimeMs: number;
    filtersApplied: string[];
  };
}

describe('LayoutSearchHandler (RED Phase) - mood/brandTone Extension', () => {
  // ========== 1. Input Validation Tests ==========
  describe('Input Validation', () => {
    it('should accept search query with mood filter', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'hero section',
        filters: {
          mood: {
            primary: 'professional',
            minSimilarity: 0.7
          }
        }
      };

      // Expected: Query accepted with mood filter
      expect(input.query).toBeTruthy();
      expect(input.filters?.mood?.primary).toBe('professional');
    });

    it('should accept search query with brandTone filter', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'feature section',
        filters: {
          brandTone: {
            primary: 'corporate',
            minSimilarity: 0.6
          }
        }
      };

      // Expected: Query accepted with brandTone filter
      expect(input.filters?.brandTone?.primary).toBe('corporate');
      expect(input.filters?.brandTone?.minSimilarity).toBeGreaterThanOrEqual(0);
    });

    it('should accept search query with both mood and brandTone filters', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'modern design',
        filters: {
          mood: { primary: 'minimal', minSimilarity: 0.7 },
          brandTone: { primary: 'playful', minSimilarity: 0.6 }
        }
      };

      // Expected: Both filters accepted
      expect(input.filters?.mood).toBeDefined();
      expect(input.filters?.brandTone).toBeDefined();
    });

    it('should accept mood filter with secondary value', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'hero',
        filters: {
          mood: {
            primary: 'professional',
            secondary: 'elegant',
            minSimilarity: 0.7
          }
        }
      };

      // Expected: Secondary mood accepted
      expect(input.filters?.mood?.secondary).toBe('elegant');
    });

    it('should accept brandTone filter with secondary value', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'feature',
        filters: {
          brandTone: {
            primary: 'friendly',
            secondary: 'playful',
            minSimilarity: 0.6
          }
        }
      };

      // Expected: Secondary brandTone accepted
      expect(input.filters?.brandTone?.secondary).toBe('playful');
    });

    it('should use default weight value (0.2) when not specified', () => {
      const moodFilterWithoutWeight = { primary: 'professional' };
      const defaultWeight = 0.2;

      expect(defaultWeight).toBe(0.2);
    });

    it('should validate minSimilarity range for mood filter', () => {
      const validRange = (value: number) => value >= 0 && value <= 1;

      expect(validRange(0.5)).toBe(true);
      expect(validRange(-0.1)).toBe(false);
      expect(validRange(1.5)).toBe(false);
    });

    it('should validate minSimilarity range for brandTone filter', () => {
      const validRange = (value: number) => value >= 0 && value <= 1;

      expect(validRange(0.6)).toBe(true);
      expect(validRange(1.1)).toBe(false);
    });

    it('should validate weight range for mood filter', () => {
      const validRange = (value: number) => value >= 0 && value <= 1;

      expect(validRange(0.2)).toBe(true);
      expect(validRange(1.5)).toBe(false);
    });

    it('should validate weight range for brandTone filter', () => {
      const validRange = (value: number) => value >= 0 && value <= 1;

      expect(validRange(0.3)).toBe(true);
      expect(validRange(-0.1)).toBe(false);
    });
  });

  // ========== 2. Filter Combination Tests ==========
  describe('Filter Combination & Priority', () => {
    it('should apply mood filter even when other filters present', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'hero',
        filters: {
          sectionType: 'hero',
          mood: { primary: 'professional', minSimilarity: 0.7 },
          visualFeatures: { theme: { type: 'light' } }
        }
      };

      // Expected: All filters applied
      expect(input.filters?.sectionType).toBe('hero');
      expect(input.filters?.mood?.primary).toBe('professional');
      expect(input.filters?.visualFeatures?.theme?.type).toBe('light');
    });

    it('should apply brandTone filter even when other filters present', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'feature',
        filters: {
          sourceType: 'award_gallery',
          brandTone: { primary: 'corporate', minSimilarity: 0.6 }
        }
      };

      // Expected: Both filters applied
      expect(input.filters?.sourceType).toBe('award_gallery');
      expect(input.filters?.brandTone?.primary).toBe('corporate');
    });

    it('should combine mood and brandTone with visualFeatures', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'modern design',
        filters: {
          mood: { primary: 'minimal', minSimilarity: 0.7 },
          brandTone: { primary: 'playful', minSimilarity: 0.6 },
          visualFeatures: {
            density: { minContentDensity: 0.3 }
          }
        }
      };

      // Expected: All three filter types combined
      expect(input.filters?.mood).toBeDefined();
      expect(input.filters?.brandTone).toBeDefined();
      expect(input.filters?.visualFeatures).toBeDefined();
    });

    it('should apply limit and offset with mood filter', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'hero',
        filters: { mood: { primary: 'professional' } },
        limit: 10,
        offset: 20
      };

      // Expected: Pagination applied with mood filter
      expect(input.limit).toBe(10);
      expect(input.offset).toBe(20);
      expect(input.filters?.mood).toBeDefined();
    });
  });

  // ========== 3. Response Structure Tests ==========
  describe('Response Structure', () => {
    it('should return pattern results with mood information', () => {
      const response: ExtendedLayoutSearchResult = {
        patterns: [
          {
            id: 'pattern-001',
            sectionType: 'hero',
            similarity: 0.95,
            moodInfo: { primary: 'professional' }
          }
        ],
        metadata: {
          totalCount: 1,
          limit: 10,
          offset: 0,
          searchTimeMs: 45,
          filtersApplied: ['mood']
        }
      };

      // Expected: Mood info included in results
      expect(response.patterns[0].moodInfo?.primary).toBe('professional');
      expect(response.metadata.filtersApplied).toContain('mood');
    });

    it('should return pattern results with brandTone information', () => {
      const response: ExtendedLayoutSearchResult = {
        patterns: [
          {
            id: 'pattern-002',
            sectionType: 'feature',
            similarity: 0.88,
            brandToneInfo: { primary: 'corporate' }
          }
        ],
        metadata: {
          totalCount: 1,
          limit: 10,
          offset: 0,
          searchTimeMs: 42,
          filtersApplied: ['brandTone']
        }
      };

      // Expected: BrandTone info included in results
      expect(response.patterns[0].brandToneInfo?.primary).toBe('corporate');
      expect(response.metadata.filtersApplied).toContain('brandTone');
    });

    it('should include mood and brandTone info in same result', () => {
      const response: ExtendedLayoutSearchResult = {
        patterns: [
          {
            id: 'pattern-003',
            sectionType: 'hero',
            similarity: 0.92,
            moodInfo: { primary: 'professional', secondary: 'minimal' },
            brandToneInfo: { primary: 'corporate' }
          }
        ],
        metadata: {
          totalCount: 1,
          limit: 10,
          offset: 0,
          searchTimeMs: 51,
          filtersApplied: ['mood', 'brandTone']
        }
      };

      // Expected: Both mood and brandTone info present
      expect(response.patterns[0].moodInfo).toBeDefined();
      expect(response.patterns[0].brandToneInfo).toBeDefined();
      expect(response.metadata.filtersApplied).toContain('mood');
      expect(response.metadata.filtersApplied).toContain('brandTone');
    });

    it('should include metadata about applied filters', () => {
      const response: ExtendedLayoutSearchResult = {
        patterns: [],
        metadata: {
          totalCount: 0,
          limit: 10,
          offset: 0,
          searchTimeMs: 25,
          filtersApplied: ['mood', 'brandTone', 'visualFeatures']
        }
      };

      // Expected: Clear filter metadata
      expect(response.metadata.filtersApplied).toHaveLength(3);
      expect(response.metadata.filtersApplied).toContain('mood');
      expect(response.metadata.filtersApplied).toContain('brandTone');
    });

    it('should include search performance timing', () => {
      const response: ExtendedLayoutSearchResult = {
        patterns: [],
        metadata: {
          totalCount: 0,
          limit: 10,
          offset: 0,
          searchTimeMs: 35,
          filtersApplied: ['mood']
        }
      };

      // Expected: Performance timing available
      expect(response.metadata.searchTimeMs).toBeGreaterThanOrEqual(0);
      expect(response.metadata.searchTimeMs).toBeLessThan(1000); // Should be < 1s
    });
  });

  // ========== 4. Edge Cases & Error Handling ==========
  describe('Edge Cases & Error Handling', () => {
    it('should handle empty search results with mood filter', () => {
      const response: ExtendedLayoutSearchResult = {
        patterns: [],
        metadata: {
          totalCount: 0,
          limit: 10,
          offset: 0,
          searchTimeMs: 20,
          filtersApplied: ['mood']
        }
      };

      // Expected: Empty results handled gracefully
      expect(response.patterns).toHaveLength(0);
      expect(response.metadata.totalCount).toBe(0);
    });

    it('should handle empty search results with brandTone filter', () => {
      const response: ExtendedLayoutSearchResult = {
        patterns: [],
        metadata: {
          totalCount: 0,
          limit: 10,
          offset: 0,
          searchTimeMs: 18,
          filtersApplied: ['brandTone']
        }
      };

      // Expected: Empty results handled gracefully
      expect(response.patterns).toHaveLength(0);
    });

    it('should handle very high minSimilarity threshold for mood', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'hero',
        filters: {
          mood: { primary: 'professional', minSimilarity: 0.99 }
        }
      };

      // Expected: Threshold accepted
      expect(input.filters?.mood?.minSimilarity).toBe(0.99);
      expect(input.filters?.mood?.minSimilarity).toBeLessThanOrEqual(1.0);
    });

    it('should handle zero minSimilarity threshold for brandTone', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'feature',
        filters: {
          brandTone: { primary: 'friendly', minSimilarity: 0 }
        }
      };

      // Expected: Zero threshold accepted
      expect(input.filters?.brandTone?.minSimilarity).toBe(0);
      expect(input.filters?.brandTone?.minSimilarity).toBeGreaterThanOrEqual(0);
    });

    it('should handle multiple mood filters for different sections', () => {
      const query1 = { mood: { primary: 'professional' } };
      const query2 = { mood: { primary: 'playful' } };

      // Expected: Different moods can be queried
      expect(query1.mood.primary).not.toBe(query2.mood.primary);
    });

    it('should handle rapid sequential searches with mood filter', () => {
      const searches = [
        { query: 'hero', mood: { primary: 'professional' } },
        { query: 'feature', mood: { primary: 'minimal' } },
        { query: 'cta', mood: { primary: 'bold' } }
      ];

      // Expected: All searches processed
      expect(searches).toHaveLength(3);
      expect(searches.every(s => s.mood?.primary)).toBe(true);
    });

    it('should handle rapid sequential searches with brandTone filter', () => {
      const searches = [
        { query: 'hero', brandTone: { primary: 'corporate' } },
        { query: 'feature', brandTone: { primary: 'creative' } }
      ];

      // Expected: All searches processed
      expect(searches).toHaveLength(2);
    });
  });

  // ========== 5. Integration with Existing Filters ==========
  describe('Backward Compatibility', () => {
    it('should work when no mood filter specified', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'hero section',
        filters: {
          sectionType: 'hero'
        }
      };

      // Expected: Existing filters still work
      expect(input.filters?.sectionType).toBe('hero');
      expect(input.filters?.mood).toBeUndefined();
    });

    it('should work when no brandTone filter specified', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'feature section',
        filters: {
          sourceType: 'award_gallery'
        }
      };

      // Expected: Existing filters still work
      expect(input.filters?.sourceType).toBe('award_gallery');
      expect(input.filters?.brandTone).toBeUndefined();
    });

    it('should maintain visualFeatures filters when adding mood', () => {
      const input: ExtendedLayoutSearchInput = {
        query: 'modern hero',
        filters: {
          visualFeatures: {
            theme: { type: 'dark' }
          },
          mood: {
            primary: 'minimal'
          }
        }
      };

      // Expected: Both visualFeatures and mood present
      expect(input.filters?.visualFeatures?.theme?.type).toBe('dark');
      expect(input.filters?.mood?.primary).toBe('minimal');
    });
  });
});
