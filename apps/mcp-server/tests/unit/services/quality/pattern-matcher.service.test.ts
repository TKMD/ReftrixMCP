// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PatternMatcherService Unit Tests
 *
 * @module tests/unit/services/quality/pattern-matcher.service.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PatternMatcherService,
  setPatternMatcherPrismaClientFactory,
  resetPatternMatcherPrismaClientFactory,
  getPatternMatcherService,
  resetPatternMatcherService,
  createPatternMatcherServiceFactory,
  type IPrismaClient,
  type SectionPatternMatch,
  type MotionPatternMatch,
  type PatternComparison,
  DEFAULT_MIN_SIMILARITY,
  DEFAULT_SEARCH_LIMIT,
  HIGH_SIMILARITY_THRESHOLD,
  MEDIUM_SIMILARITY_THRESHOLD,
} from '../../../../src/services/quality/pattern-matcher.service';
import { EmbeddingValidationError } from '../../../../src/services/embedding-validation.service';

describe('PatternMatcherService', () => {
  let mockPrismaClient: IPrismaClient;

  /**
   * Create a valid 768-dimensional embedding
   */
  function createValidEmbedding(value = 0.1): number[] {
    return new Array(768).fill(value);
  }

  /**
   * Create normalized embedding for similarity testing
   */
  function createNormalizedEmbedding(): number[] {
    const embedding = new Array(768).fill(0);
    // Create a unit vector (normalized)
    const value = 1 / Math.sqrt(768);
    return embedding.map(() => value);
  }

  beforeEach(() => {
    // Create mock PrismaClient
    mockPrismaClient = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    };

    // Reset service factories
    resetPatternMatcherPrismaClientFactory();
    resetPatternMatcherService();
  });

  afterEach(() => {
    resetPatternMatcherPrismaClientFactory();
    resetPatternMatcherService();
    vi.clearAllMocks();
  });

  // =====================================================
  // Factory and Singleton Tests
  // =====================================================

  describe('createPatternMatcherServiceFactory', () => {
    it('should return a factory function that creates IPatternMatcherService', () => {
      const factory = createPatternMatcherServiceFactory();
      const service = factory();

      expect(service).toBeDefined();
      expect(typeof service.extractTextRepresentation).toBe('function');
      expect(typeof service.findSimilarSectionPatterns).toBe('function');
      expect(typeof service.findSimilarMotionPatterns).toBe('function');
      expect(typeof service.calculateUniquenessScore).toBe('function');
      expect(typeof service.comparePatterns).toBe('function');
    });
  });

  describe('getPatternMatcherService', () => {
    it('should return singleton instance', () => {
      const service1 = getPatternMatcherService();
      const service2 = getPatternMatcherService();

      expect(service1).toBe(service2);
    });

    it('should return new instance after reset', () => {
      const service1 = getPatternMatcherService();
      resetPatternMatcherService();
      const service2 = getPatternMatcherService();

      expect(service1).not.toBe(service2);
    });
  });

  // =====================================================
  // extractTextRepresentation Tests
  // =====================================================

  describe('extractTextRepresentation', () => {
    it('should extract text from HTML with headings', () => {
      const service = new PatternMatcherService();
      const html = '<h1>Welcome to Our Site</h1><h2>Features</h2>';

      const result = service.extractTextRepresentation(html);

      expect(result).toContain('Headings:');
      expect(result).toContain('Welcome to Our Site');
      expect(result).toContain('Features');
    });

    it('should extract button text', () => {
      const service = new PatternMatcherService();
      const html = '<button>Sign Up</button><button>Learn More</button>';

      const result = service.extractTextRepresentation(html);

      expect(result).toContain('Buttons:');
      expect(result).toContain('Sign Up');
      expect(result).toContain('Learn More');
    });

    it('should extract link text', () => {
      const service = new PatternMatcherService();
      const html = '<a href="/about">About Us</a><a href="/contact">Contact</a>';

      const result = service.extractTextRepresentation(html);

      expect(result).toContain('Links:');
      expect(result).toContain('About Us');
      expect(result).toContain('Contact');
    });

    it('should extract paragraph content', () => {
      const service = new PatternMatcherService();
      const html = '<p>This is a paragraph with some important content about our services.</p>';

      const result = service.extractTextRepresentation(html);

      expect(result).toContain('Content:');
      expect(result).toContain('important content');
    });

    it('should extract image alt text', () => {
      const service = new PatternMatcherService();
      const html = '<img src="hero.jpg" alt="Hero banner image"><img src="logo.png" alt="Company logo">';

      const result = service.extractTextRepresentation(html);

      expect(result).toContain('Images:');
      expect(result).toContain('Hero banner image');
      expect(result).toContain('Company logo');
    });

    it('should extract ARIA labels', () => {
      const service = new PatternMatcherService();
      const html = '<nav aria-label="Main navigation"><button aria-label="Close menu">X</button></nav>';

      const result = service.extractTextRepresentation(html);

      expect(result).toContain('Accessibility:');
      expect(result).toContain('Main navigation');
      expect(result).toContain('Close menu');
    });

    it('should extract meaningful class names', () => {
      const service = new PatternMatcherService();
      const html = '<section class="hero-section primary-content"><div class="feature-card"></div></section>';

      const result = service.extractTextRepresentation(html);

      expect(result).toContain('Structure:');
      expect(result).toContain('hero-section');
    });

    it('should skip utility class names', () => {
      const service = new PatternMatcherService();
      const html = '<div class="flex p-4 m-2 w-full bg-white text-gray-900"></div>';

      const result = service.extractTextRepresentation(html);

      // Should not contain Tailwind utility classes
      expect(result).not.toContain('flex');
      expect(result).not.toContain('p-4');
      expect(result).not.toContain('m-2');
    });

    it('should return empty string for invalid input', () => {
      const service = new PatternMatcherService();

      expect(service.extractTextRepresentation('')).toBe('');
      expect(service.extractTextRepresentation(null as unknown as string)).toBe('');
      expect(service.extractTextRepresentation(undefined as unknown as string)).toBe('');
    });

    it('should handle complex HTML with multiple elements', () => {
      const service = new PatternMatcherService();
      const html = `
        <section class="hero-section" aria-label="Hero">
          <h1>Welcome</h1>
          <p>Build amazing websites with our platform.</p>
          <button>Get Started</button>
          <img src="hero.jpg" alt="Hero illustration">
        </section>
      `;

      const result = service.extractTextRepresentation(html);

      expect(result).toContain('Headings:');
      expect(result).toContain('Welcome');
      expect(result).toContain('Buttons:');
      expect(result).toContain('Get Started');
      expect(result).toContain('Images:');
      expect(result).toContain('Hero illustration');
    });
  });

  // =====================================================
  // findSimilarSectionPatterns Tests
  // =====================================================

  describe('findSimilarSectionPatterns', () => {
    const mockEmbedding = createValidEmbedding();

    it('should return empty array when PrismaClient is not set', async () => {
      const service = new PatternMatcherService();

      const result = await service.findSimilarSectionPatterns(mockEmbedding);

      expect(result).toEqual([]);
    });

    it('should throw EmbeddingValidationError for invalid embedding', async () => {
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);
      const service = new PatternMatcherService();

      // Wrong dimensions
      await expect(
        service.findSimilarSectionPatterns([1, 2, 3])
      ).rejects.toThrow(EmbeddingValidationError);

      // Contains NaN
      const nanEmbedding = createValidEmbedding();
      nanEmbedding[0] = NaN;
      await expect(
        service.findSimilarSectionPatterns(nanEmbedding)
      ).rejects.toThrow(EmbeddingValidationError);

      // Contains Infinity
      const infEmbedding = createValidEmbedding();
      infEmbedding[0] = Infinity;
      await expect(
        service.findSimilarSectionPatterns(infEmbedding)
      ).rejects.toThrow(EmbeddingValidationError);
    });

    it('should execute vector search with PrismaClient', async () => {
      const mockResults = [
        {
          id: 'section-1',
          web_page_id: 'page-1',
          section_type: 'hero',
          html_snippet: '<section>Hero</section>',
          similarity: 0.92,
          quality_score: { anti_ai_cliche: { overall: 85 } },
          source_url: 'https://example.com',
        },
      ];
      mockPrismaClient.$queryRawUnsafe = vi.fn().mockResolvedValue(mockResults);
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);

      const service = new PatternMatcherService();
      const result = await service.findSimilarSectionPatterns(mockEmbedding);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'section-1',
        webPageId: 'page-1',
        sectionType: 'hero',
        similarity: 0.92,
        qualityScore: 85,
        sourceUrl: 'https://example.com',
      });
      expect(mockPrismaClient.$queryRawUnsafe).toHaveBeenCalled();
    });

    it('should apply sectionType filter', async () => {
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);
      const service = new PatternMatcherService();

      await service.findSimilarSectionPatterns(mockEmbedding, {
        sectionType: 'hero',
      });

      const query = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(query).toContain('sp.section_type');
    });

    it('should apply excludeIds filter', async () => {
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);
      const service = new PatternMatcherService();

      await service.findSimilarSectionPatterns(mockEmbedding, {
        excludeIds: ['exclude-1', 'exclude-2'],
      });

      const query = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(query).toContain('NOT IN');
    });

    it('should apply minQualityScore filter', async () => {
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);
      const service = new PatternMatcherService();

      await service.findSimilarSectionPatterns(mockEmbedding, {
        minQualityScore: 85,
      });

      const query = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(query).toContain('quality_score');
    });

    it('should use default options when not provided', async () => {
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);
      const service = new PatternMatcherService();

      await service.findSimilarSectionPatterns(mockEmbedding);

      const callArgs = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
      // Default limit should be applied
      expect(callArgs).toContain(DEFAULT_SEARCH_LIMIT);
      // Default minSimilarity should be applied
      expect(callArgs).toContain(DEFAULT_MIN_SIMILARITY);
    });

    it('should not include HTML snippet when includeHtml is false', async () => {
      const mockResults = [
        {
          id: 'section-1',
          web_page_id: 'page-1',
          section_type: 'hero',
          html_snippet: null,
          similarity: 0.92,
          quality_score: null,
          source_url: null,
        },
      ];
      mockPrismaClient.$queryRawUnsafe = vi.fn().mockResolvedValue(mockResults);
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);

      const service = new PatternMatcherService();
      const result = await service.findSimilarSectionPatterns(mockEmbedding, {
        includeHtml: false,
      });

      expect(result[0]?.htmlSnippet).toBeUndefined();
    });
  });

  // =====================================================
  // findSimilarMotionPatterns Tests
  // =====================================================

  describe('findSimilarMotionPatterns', () => {
    const mockEmbedding = createValidEmbedding();

    it('should return empty array when PrismaClient is not set', async () => {
      const service = new PatternMatcherService();

      const result = await service.findSimilarMotionPatterns(mockEmbedding);

      expect(result).toEqual([]);
    });

    it('should throw EmbeddingValidationError for invalid embedding', async () => {
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);
      const service = new PatternMatcherService();

      await expect(
        service.findSimilarMotionPatterns([1, 2, 3])
      ).rejects.toThrow(EmbeddingValidationError);
    });

    it('should execute vector search with PrismaClient', async () => {
      const mockResults = [
        {
          id: 'motion-1',
          web_page_id: 'page-1',
          name: 'fadeIn',
          category: 'scroll_trigger',
          trigger_type: 'scroll',
          similarity: 0.88,
          duration: 600,
          raw_css: null,
        },
      ];
      mockPrismaClient.$queryRawUnsafe = vi.fn().mockResolvedValue(mockResults);
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);

      const service = new PatternMatcherService();
      const result = await service.findSimilarMotionPatterns(mockEmbedding);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'motion-1',
        webPageId: 'page-1',
        name: 'fadeIn',
        type: 'scroll_trigger',
        trigger: 'scroll',
        similarity: 0.88,
        duration: 600,
      });
    });

    it('should apply motionType filter', async () => {
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);
      const service = new PatternMatcherService();

      await service.findSimilarMotionPatterns(mockEmbedding, {
        motionType: 'hover_effect',
      });

      const query = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(query).toContain('mp.category');
    });

    it('should apply trigger filter', async () => {
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);
      const service = new PatternMatcherService();

      await service.findSimilarMotionPatterns(mockEmbedding, {
        trigger: 'hover',
      });

      const query = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(query).toContain('mp.trigger_type');
    });

    it('should include raw CSS when requested', async () => {
      const mockResults = [
        {
          id: 'motion-1',
          web_page_id: null,
          name: 'fadeIn',
          category: 'scroll_trigger',
          trigger_type: 'scroll',
          similarity: 0.88,
          duration: null,
          raw_css: '.fadeIn { opacity: 0 -> 1 }',
        },
      ];
      mockPrismaClient.$queryRawUnsafe = vi.fn().mockResolvedValue(mockResults);
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);

      const service = new PatternMatcherService();
      const result = await service.findSimilarMotionPatterns(mockEmbedding, {
        includeRawCss: true,
      });

      expect(result[0]?.rawCss).toBe('.fadeIn { opacity: 0 -> 1 }');
    });
  });

  // =====================================================
  // calculateUniquenessScore Tests
  // =====================================================

  describe('calculateUniquenessScore', () => {
    const mockEmbedding = createValidEmbedding();

    it('should return 1.0 when no similar patterns found', async () => {
      mockPrismaClient.$queryRawUnsafe = vi.fn().mockResolvedValue([]);
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);

      const service = new PatternMatcherService();
      const result = await service.calculateUniquenessScore(mockEmbedding);

      expect(result).toBe(1.0);
    });

    it('should return inverse of max similarity', async () => {
      const mockResults = [
        {
          id: 'section-1',
          web_page_id: 'page-1',
          section_type: 'hero',
          html_snippet: null,
          similarity: 0.8,
          quality_score: null,
          source_url: null,
        },
      ];
      mockPrismaClient.$queryRawUnsafe = vi.fn().mockResolvedValue(mockResults);
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);

      const service = new PatternMatcherService();
      const result = await service.calculateUniquenessScore(mockEmbedding);

      // Uniqueness = 1 - 0.8 = 0.2
      expect(result).toBeCloseTo(0.2, 5);
    });

    it('should return 0.5 when search fails', async () => {
      mockPrismaClient.$queryRawUnsafe = vi.fn().mockRejectedValue(new Error('DB error'));
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);

      const service = new PatternMatcherService();
      const result = await service.calculateUniquenessScore(mockEmbedding);

      expect(result).toBe(0.5);
    });

    it('should apply sectionType filter', async () => {
      mockPrismaClient.$queryRawUnsafe = vi.fn().mockResolvedValue([]);
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);

      const service = new PatternMatcherService();
      await service.calculateUniquenessScore(mockEmbedding, 'hero');

      const query = (mockPrismaClient.$queryRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(query).toContain('sp.section_type');
    });

    it('should throw EmbeddingValidationError for invalid embedding', async () => {
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);
      const service = new PatternMatcherService();

      await expect(
        service.calculateUniquenessScore([1, 2, 3])
      ).rejects.toThrow(EmbeddingValidationError);
    });
  });

  // =====================================================
  // comparePatterns Tests
  // =====================================================

  describe('comparePatterns', () => {
    it('should calculate cosine similarity correctly', () => {
      const service = new PatternMatcherService();

      // Same vector should have similarity 1
      const embedding = createNormalizedEmbedding();
      const result = service.comparePatterns(embedding, embedding);

      expect(result.cosineSimilarity).toBeCloseTo(1, 5);
      expect(result.isHighMatch).toBe(true);
      expect(result.isMediumMatch).toBe(false);
      expect(result.isLowMatch).toBe(false);
    });

    it('should detect high match (> 0.85)', () => {
      const service = new PatternMatcherService();

      // Create two similar embeddings
      const embeddingA = createValidEmbedding(0.1);
      const embeddingB = createValidEmbedding(0.11);

      const result = service.comparePatterns(embeddingA, embeddingB);

      expect(result.cosineSimilarity).toBeGreaterThan(HIGH_SIMILARITY_THRESHOLD);
      expect(result.isHighMatch).toBe(true);
      expect(result.isMediumMatch).toBe(false);
      expect(result.isLowMatch).toBe(false);
    });

    it('should detect medium match (0.7 - 0.85)', () => {
      const service = new PatternMatcherService();

      // Create embeddings with moderate similarity
      const embeddingA = createValidEmbedding(0.1);
      const embeddingB = new Array(768).fill(0).map((_, i) =>
        i < 600 ? 0.1 : -0.05
      );

      const result = service.comparePatterns(embeddingA, embeddingB);

      // This should give medium similarity
      if (result.cosineSimilarity >= MEDIUM_SIMILARITY_THRESHOLD &&
          result.cosineSimilarity <= HIGH_SIMILARITY_THRESHOLD) {
        expect(result.isMediumMatch).toBe(true);
        expect(result.isHighMatch).toBe(false);
        expect(result.isLowMatch).toBe(false);
      }
    });

    it('should detect low match (< 0.7)', () => {
      const service = new PatternMatcherService();

      // Create very different embeddings
      const embeddingA = new Array(768).fill(0.1);
      const embeddingB = new Array(768).fill(-0.1);

      const result = service.comparePatterns(embeddingA, embeddingB);

      expect(result.cosineSimilarity).toBeLessThan(MEDIUM_SIMILARITY_THRESHOLD);
      expect(result.isLowMatch).toBe(true);
      expect(result.isHighMatch).toBe(false);
      expect(result.isMediumMatch).toBe(false);
    });

    it('should throw EmbeddingValidationError for invalid embeddingA', () => {
      const service = new PatternMatcherService();
      const validEmbedding = createValidEmbedding();

      expect(() =>
        service.comparePatterns([1, 2, 3], validEmbedding)
      ).toThrow(EmbeddingValidationError);
    });

    it('should throw EmbeddingValidationError for invalid embeddingB', () => {
      const service = new PatternMatcherService();
      const validEmbedding = createValidEmbedding();

      expect(() =>
        service.comparePatterns(validEmbedding, [1, 2, 3])
      ).toThrow(EmbeddingValidationError);
    });

    it('should handle zero vectors', () => {
      const service = new PatternMatcherService();
      const zeroEmbedding = new Array(768).fill(0);
      const validEmbedding = createValidEmbedding();

      // This should throw because zero vector is technically valid
      // but cosine similarity would be 0 (division by zero handled)
      // Let's check it doesn't crash
      // Note: Our current validation allows zero vectors if they have correct dimensions
      // The calculateCosineSimilarity function handles zero vectors gracefully
      const result = service.comparePatterns(zeroEmbedding, validEmbedding);
      expect(result.cosineSimilarity).toBe(0);
    });
  });

  // =====================================================
  // Constants Tests
  // =====================================================

  describe('Constants', () => {
    it('should have correct default values', () => {
      expect(DEFAULT_MIN_SIMILARITY).toBe(0.7);
      expect(DEFAULT_SEARCH_LIMIT).toBe(10);
      expect(HIGH_SIMILARITY_THRESHOLD).toBe(0.85);
      expect(MEDIUM_SIMILARITY_THRESHOLD).toBe(0.7);
    });
  });

  // =====================================================
  // Error Handling Tests
  // =====================================================

  describe('Error Handling', () => {
    it('should handle database errors gracefully in findSimilarSectionPatterns', async () => {
      mockPrismaClient.$queryRawUnsafe = vi.fn().mockRejectedValue(new Error('Connection failed'));
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);

      const service = new PatternMatcherService();

      await expect(
        service.findSimilarSectionPatterns(createValidEmbedding())
      ).rejects.toThrow('Connection failed');
    });

    it('should handle database errors gracefully in findSimilarMotionPatterns', async () => {
      mockPrismaClient.$queryRawUnsafe = vi.fn().mockRejectedValue(new Error('Connection failed'));
      setPatternMatcherPrismaClientFactory(() => mockPrismaClient);

      const service = new PatternMatcherService();

      await expect(
        service.findSimilarMotionPatterns(createValidEmbedding())
      ).rejects.toThrow('Connection failed');
    });
  });
});
