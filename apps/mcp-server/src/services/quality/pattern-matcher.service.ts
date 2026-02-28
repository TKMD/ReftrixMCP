// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PatternMatcherService
 * Similarity search service for section and motion patterns
 *
 * Features:
 * - Convert HTML/content to text representation for embedding
 * - Find similar patterns across the database using vector search
 * - Calculate similarity and uniqueness scores
 *
 * @module services/quality/pattern-matcher.service
 */

import { isDevelopment, logger } from '../../utils/logger';
import {
  validateEmbeddingVector,
  EmbeddingValidationError,
} from '../embedding-validation.service';

// =====================================================
// Constants
// =====================================================

/** Default minimum similarity threshold */
export const DEFAULT_MIN_SIMILARITY = 0.7;

/** Default search limit */
export const DEFAULT_SEARCH_LIMIT = 10;

/** High similarity threshold (for isHighMatch) */
export const HIGH_SIMILARITY_THRESHOLD = 0.85;

/** Medium similarity threshold (for isMediumMatch) */
export const MEDIUM_SIMILARITY_THRESHOLD = 0.7;

// =====================================================
// Interfaces
// =====================================================

/**
 * Section pattern match result
 */
export interface SectionPatternMatch {
  /** Section pattern ID */
  id: string;
  /** Associated WebPage ID */
  webPageId: string;
  /** Section type (hero, feature, cta, etc.) */
  sectionType: string;
  /** Cosine similarity score (0-1) */
  similarity: number;
  /** Quality score (if available) */
  qualityScore?: number;
  /** HTML snippet (if requested) */
  htmlSnippet?: string;
  /** Source URL */
  sourceUrl?: string;
}

/**
 * Motion pattern match result
 */
export interface MotionPatternMatch {
  /** Motion pattern ID */
  id: string;
  /** Associated WebPage ID (may be null) */
  webPageId: string | null;
  /** Pattern name */
  name: string;
  /** Motion type (animation, transition, etc.) */
  type: string;
  /** Trigger type (scroll, hover, click, etc.) */
  trigger: string;
  /** Cosine similarity score (0-1) */
  similarity: number;
  /** Animation duration in ms */
  duration?: number;
  /** Raw CSS (if requested) */
  rawCss?: string;
}

/**
 * Pattern comparison result
 */
export interface PatternComparison {
  /** Cosine similarity between patterns (-1 to 1) */
  cosineSimilarity: number;
  /** Whether similarity > 0.85 */
  isHighMatch: boolean;
  /** Whether similarity is between 0.7 and 0.85 */
  isMediumMatch: boolean;
  /** Whether similarity < 0.7 */
  isLowMatch: boolean;
}

/**
 * Section pattern search options
 */
export interface SectionPatternSearchOptions {
  /** Filter by section type */
  sectionType?: string;
  /** Maximum number of results */
  limit?: number;
  /** Minimum similarity threshold (0-1) */
  minSimilarity?: number;
  /** Exclude specific pattern IDs from results */
  excludeIds?: string[];
  /** Include HTML snippet in results */
  includeHtml?: boolean;
  /** Minimum quality score filter */
  minQualityScore?: number;
}

/**
 * Motion pattern search options
 */
export interface MotionPatternSearchOptions {
  /** Filter by motion type */
  motionType?: string;
  /** Filter by trigger type */
  trigger?: string;
  /** Maximum number of results */
  limit?: number;
  /** Minimum similarity threshold (0-1) */
  minSimilarity?: number;
  /** Include raw CSS in results */
  includeRawCss?: boolean;
}

/**
 * IPatternMatcherService interface
 */
export interface IPatternMatcherService {
  /**
   * Generate text representation from HTML for embedding
   * @param html - Input HTML content
   * @returns Text representation suitable for embedding
   */
  extractTextRepresentation(html: string): string;

  /**
   * Find similar section patterns using vector search
   * @param embedding - Query embedding vector (768D)
   * @param options - Search options
   * @returns Array of matching section patterns
   */
  findSimilarSectionPatterns(
    embedding: number[],
    options?: SectionPatternSearchOptions
  ): Promise<SectionPatternMatch[]>;

  /**
   * Find similar motion patterns using vector search
   * @param embedding - Query embedding vector (768D)
   * @param options - Search options
   * @returns Array of matching motion patterns
   */
  findSimilarMotionPatterns(
    embedding: number[],
    options?: MotionPatternSearchOptions
  ): Promise<MotionPatternMatch[]>;

  /**
   * Calculate uniqueness score (inverse of max similarity)
   * @param embedding - Query embedding vector (768D)
   * @param sectionType - Optional section type filter
   * @returns Uniqueness score (0-1, higher = more unique)
   */
  calculateUniquenessScore(
    embedding: number[],
    sectionType?: string
  ): Promise<number>;

  /**
   * Compare two patterns and return similarity metrics
   * @param embeddingA - First embedding vector
   * @param embeddingB - Second embedding vector
   * @returns Pattern comparison result
   */
  comparePatterns(
    embeddingA: number[],
    embeddingB: number[]
  ): PatternComparison;
}

// =====================================================
// Prisma Client Interface (for DI)
// =====================================================

/**
 * Prisma Client interface (partial)
 */
export interface IPrismaClient {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

// =====================================================
// DB Result Types
// =====================================================

/**
 * Section pattern vector search result from DB
 */
interface SectionPatternDbResult {
  id: string;
  web_page_id: string;
  section_type: string;
  html_snippet: string | null;
  similarity: number;
  quality_score: unknown | null;
  source_url: string | null;
}

/**
 * Motion pattern vector search result from DB
 */
interface MotionPatternDbResult {
  id: string;
  web_page_id: string | null;
  name: string;
  category: string;
  trigger_type: string;
  similarity: number;
  duration: number | null;
  raw_css: string | null;
}

// =====================================================
// Service Factory (DI)
// =====================================================

let prismaClientFactory: (() => IPrismaClient) | null = null;

/**
 * Set PrismaClient factory for DI
 */
export function setPatternMatcherPrismaClientFactory(
  factory: () => IPrismaClient
): void {
  prismaClientFactory = factory;
}

/**
 * Reset PrismaClient factory
 */
export function resetPatternMatcherPrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =====================================================
// Helper Functions
// =====================================================

/**
 * Calculate cosine similarity between two vectors
 * @param a - First vector
 * @param b - Second vector
 * @returns Cosine similarity (-1 to 1)
 */
function calculateCosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimensions do not match: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

/**
 * Extract overall quality score from quality_score JSON
 * @param qualityScore - Quality score JSON object
 * @returns Overall score (0-100) or undefined
 */
function extractOverallQualityScore(qualityScore: unknown): number | undefined {
  if (!qualityScore || typeof qualityScore !== 'object') {
    return undefined;
  }

  const qs = qualityScore as Record<string, unknown>;

  // Try anti_ai_cliche.overall first
  if (qs.anti_ai_cliche && typeof qs.anti_ai_cliche === 'object') {
    const antiAi = qs.anti_ai_cliche as Record<string, unknown>;
    if (typeof antiAi.overall === 'number') {
      return antiAi.overall;
    }
  }

  // Try overall directly
  if (typeof qs.overall === 'number') {
    return qs.overall;
  }

  return undefined;
}

/**
 * Parse HTML and extract meaningful text for embedding
 * @param html - Input HTML string
 * @returns Cleaned text representation
 */
function parseHtmlToText(html: string): string {
  const parts: string[] = [];

  // Extract tag structure hints
  const tagMatches = html.match(/<(section|header|footer|nav|main|article|aside|div)[^>]*class="([^"]*)"[^>]*>/gi);
  if (tagMatches) {
    const classNames = new Set<string>();
    for (const match of tagMatches) {
      const classMatch = match.match(/class="([^"]*)"/i);
      if (classMatch?.[1]) {
        // Extract meaningful class names (skip utility classes)
        const classes = classMatch[1].split(/\s+/).filter(c =>
          c.length > 3 &&
          !c.startsWith('flex') &&
          !c.startsWith('grid') &&
          !c.startsWith('p-') &&
          !c.startsWith('m-') &&
          !c.startsWith('w-') &&
          !c.startsWith('h-') &&
          !c.startsWith('text-') &&
          !c.startsWith('bg-')
        );
        classes.forEach(c => classNames.add(c));
      }
    }
    if (classNames.size > 0) {
      parts.push(`Structure: ${Array.from(classNames).slice(0, 10).join(', ')}`);
    }
  }

  // Extract ARIA attributes for accessibility context
  const ariaMatches = html.match(/aria-(?:label|labelledby|describedby)="([^"]*)"/gi);
  if (ariaMatches) {
    const ariaLabels: string[] = [];
    for (const match of ariaMatches) {
      const labelMatch = match.match(/="([^"]*)"/);
      if (labelMatch?.[1]) {
        ariaLabels.push(labelMatch[1]);
      }
    }
    if (ariaLabels.length > 0) {
      parts.push(`Accessibility: ${ariaLabels.slice(0, 5).join(', ')}`);
    }
  }

  // Extract headings
  const headingMatches = html.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi);
  if (headingMatches) {
    const headings: string[] = [];
    for (const match of headingMatches) {
      // Remove tags and trim
      const text = match.replace(/<[^>]*>/g, '').trim();
      if (text.length > 0 && text.length < 200) {
        headings.push(text);
      }
    }
    if (headings.length > 0) {
      parts.push(`Headings: ${headings.slice(0, 5).join(', ')}`);
    }
  }

  // Extract button text
  const buttonMatches = html.match(/<button[^>]*>([\s\S]*?)<\/button>/gi);
  if (buttonMatches) {
    const buttons: string[] = [];
    for (const match of buttonMatches) {
      const text = match.replace(/<[^>]*>/g, '').trim();
      if (text.length > 0 && text.length < 100) {
        buttons.push(text);
      }
    }
    if (buttons.length > 0) {
      parts.push(`Buttons: ${buttons.slice(0, 5).join(', ')}`);
    }
  }

  // Extract anchor text
  const anchorMatches = html.match(/<a[^>]*>([\s\S]*?)<\/a>/gi);
  if (anchorMatches) {
    const links: string[] = [];
    for (const match of anchorMatches) {
      const text = match.replace(/<[^>]*>/g, '').trim();
      if (text.length > 0 && text.length < 100) {
        links.push(text);
      }
    }
    if (links.length > 0) {
      parts.push(`Links: ${links.slice(0, 5).join(', ')}`);
    }
  }

  // Extract paragraph content (first 500 chars)
  const paragraphMatches = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi);
  if (paragraphMatches) {
    const paragraphs: string[] = [];
    for (const match of paragraphMatches) {
      const text = match.replace(/<[^>]*>/g, '').trim();
      if (text.length > 10 && text.length < 500) {
        paragraphs.push(text);
      }
    }
    if (paragraphs.length > 0) {
      const combined = paragraphs.slice(0, 3).join(' ').substring(0, 500);
      parts.push(`Content: ${combined}`);
    }
  }

  // Extract image alt text
  const imgMatches = html.match(/<img[^>]*alt="([^"]*)"/gi);
  if (imgMatches) {
    const altTexts: string[] = [];
    for (const match of imgMatches) {
      const altMatch = match.match(/alt="([^"]*)"/i);
      if (altMatch?.[1] && altMatch[1].length > 0) {
        altTexts.push(altMatch[1]);
      }
    }
    if (altTexts.length > 0) {
      parts.push(`Images: ${altTexts.slice(0, 5).join(', ')}`);
    }
  }

  // Join all parts
  return parts.join('. ') + '.';
}

// =====================================================
// PatternMatcherService Class
// =====================================================

/**
 * PatternMatcherService - Similarity search for section and motion patterns
 */
export class PatternMatcherService implements IPatternMatcherService {
  private prismaClient: IPrismaClient | null = null;

  /**
   * Get PrismaClient (lazy initialization)
   */
  private getPrismaClient(): IPrismaClient {
    if (this.prismaClient) {
      return this.prismaClient;
    }

    if (prismaClientFactory) {
      this.prismaClient = prismaClientFactory();
      return this.prismaClient;
    }

    throw new Error('PrismaClient not initialized. Use setPatternMatcherPrismaClientFactory.');
  }

  /**
   * Validate embedding vector
   * @throws EmbeddingValidationError if validation fails
   */
  private validateEmbedding(embedding: number[], context: string): void {
    const validation = validateEmbeddingVector(embedding);
    if (!validation.isValid) {
      const error = validation.error;
      const errorMessage = error?.index !== undefined
        ? `${error.message} at index ${error.index}`
        : error?.message ?? 'Unknown validation error';

      if (isDevelopment()) {
        logger.error(`[PatternMatcher] Embedding validation failed: ${context}`, {
          code: error?.code,
          message: errorMessage,
        });
      }

      throw new EmbeddingValidationError(
        error?.code ?? 'INVALID_VECTOR',
        errorMessage,
        error?.index
      );
    }
  }

  /**
   * Extract text representation from HTML for embedding
   */
  extractTextRepresentation(html: string): string {
    if (!html || typeof html !== 'string') {
      return '';
    }

    if (isDevelopment()) {
      logger.info('[PatternMatcher] Extracting text representation', {
        htmlLength: html.length,
      });
    }

    const textRepresentation = parseHtmlToText(html);

    if (isDevelopment()) {
      logger.info('[PatternMatcher] Text representation extracted', {
        textLength: textRepresentation.length,
      });
    }

    return textRepresentation;
  }

  /**
   * Find similar section patterns using vector search
   */
  async findSimilarSectionPatterns(
    embedding: number[],
    options?: SectionPatternSearchOptions
  ): Promise<SectionPatternMatch[]> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[PatternMatcher] Finding similar section patterns', {
        embeddingDimensions: embedding.length,
        options,
      });
    }

    // Validate embedding
    this.validateEmbedding(embedding, 'findSimilarSectionPatterns');

    const {
      sectionType,
      limit = DEFAULT_SEARCH_LIMIT,
      minSimilarity = DEFAULT_MIN_SIMILARITY,
      excludeIds = [],
      includeHtml = false,
      minQualityScore,
    } = options ?? {};

    let prisma: IPrismaClient;
    try {
      prisma = this.getPrismaClient();
    } catch {
      if (isDevelopment()) {
        logger.warn('[PatternMatcher] PrismaClient not available, returning empty results');
      }
      return [];
    }

    try {
      // Build WHERE conditions
      const conditions: string[] = ['se.text_embedding IS NOT NULL'];
      const params: unknown[] = [];
      let paramIndex = 1;

      // Minimum similarity filter (vector distance)
      const vectorString = `[${embedding.join(',')}]`;
      conditions.push(`1 - (se.text_embedding <=> $${paramIndex}::vector) >= $${paramIndex + 1}`);
      params.push(vectorString, minSimilarity);
      paramIndex += 2;

      // Section type filter
      if (sectionType) {
        conditions.push(`sp.section_type = $${paramIndex}`);
        params.push(sectionType);
        paramIndex++;
      }

      // Exclude IDs filter
      if (excludeIds.length > 0) {
        conditions.push(`sp.id NOT IN (${excludeIds.map(() => `$${paramIndex++}`).join(', ')})`);
        params.push(...excludeIds);
      }

      // Quality score filter
      if (minQualityScore !== undefined) {
        conditions.push(`(sp.quality_score->>'anti_ai_cliche'->>'overall')::int >= $${paramIndex}`);
        params.push(minQualityScore);
        paramIndex++;
      }

      const whereClause = conditions.join(' AND ');

      // Build SELECT columns
      const selectColumns = [
        'sp.id',
        'sp.web_page_id',
        'sp.section_type',
        `1 - (se.text_embedding <=> $1::vector) as similarity`,
        'sp.quality_score',
        'wp.url as source_url',
      ];

      if (includeHtml) {
        selectColumns.push('sp.html_snippet');
      } else {
        selectColumns.push('NULL as html_snippet');
      }

      // Vector search query with JOIN
      const query = `
        SELECT
          ${selectColumns.join(',\n          ')}
        FROM section_patterns sp
        LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
        LEFT JOIN web_pages wp ON wp.id = sp.web_page_id
        WHERE ${whereClause}
        ORDER BY similarity DESC
        LIMIT $${paramIndex}
      `;

      params.push(limit);

      const results = await prisma.$queryRawUnsafe<SectionPatternDbResult[]>(
        query,
        ...params
      );

      // Map results
      const matches: SectionPatternMatch[] = results.map((r) => {
        const match: SectionPatternMatch = {
          id: r.id,
          webPageId: r.web_page_id,
          sectionType: r.section_type,
          similarity: r.similarity,
        };

        const overallScore = extractOverallQualityScore(r.quality_score);
        if (overallScore !== undefined) {
          match.qualityScore = overallScore;
        }

        if (r.html_snippet) {
          match.htmlSnippet = r.html_snippet;
        }

        if (r.source_url) {
          match.sourceUrl = r.source_url;
        }

        return match;
      });

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info('[PatternMatcher] Section pattern search completed', {
          resultsCount: matches.length,
          processingTimeMs,
        });
      }

      return matches;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[PatternMatcher] Section pattern search failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      throw error;
    }
  }

  /**
   * Find similar motion patterns using vector search
   */
  async findSimilarMotionPatterns(
    embedding: number[],
    options?: MotionPatternSearchOptions
  ): Promise<MotionPatternMatch[]> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[PatternMatcher] Finding similar motion patterns', {
        embeddingDimensions: embedding.length,
        options,
      });
    }

    // Validate embedding
    this.validateEmbedding(embedding, 'findSimilarMotionPatterns');

    const {
      motionType,
      trigger,
      limit = DEFAULT_SEARCH_LIMIT,
      minSimilarity = DEFAULT_MIN_SIMILARITY,
      includeRawCss = false,
    } = options ?? {};

    let prisma: IPrismaClient;
    try {
      prisma = this.getPrismaClient();
    } catch {
      if (isDevelopment()) {
        logger.warn('[PatternMatcher] PrismaClient not available, returning empty results');
      }
      return [];
    }

    try {
      // Build WHERE conditions
      const conditions: string[] = ['me.embedding IS NOT NULL'];
      const params: unknown[] = [];
      let paramIndex = 1;

      // Minimum similarity filter (vector distance)
      const vectorString = `[${embedding.join(',')}]`;
      conditions.push(`1 - (me.embedding <=> $${paramIndex}::vector) >= $${paramIndex + 1}`);
      params.push(vectorString, minSimilarity);
      paramIndex += 2;

      // Motion type (category) filter
      if (motionType) {
        conditions.push(`mp.category = $${paramIndex}`);
        params.push(motionType);
        paramIndex++;
      }

      // Trigger filter
      if (trigger) {
        conditions.push(`mp.trigger_type = $${paramIndex}`);
        params.push(trigger);
        paramIndex++;
      }

      const whereClause = conditions.join(' AND ');

      // Build SELECT columns
      const selectColumns = [
        'mp.id',
        'mp.web_page_id',
        'mp.name',
        'mp.category',
        'mp.trigger_type',
        `1 - (me.embedding <=> $1::vector) as similarity`,
        `(mp.animation->>'duration')::float as duration`,
      ];

      if (includeRawCss) {
        selectColumns.push(`mp.implementation->>'css' as raw_css`);
      } else {
        selectColumns.push('NULL as raw_css');
      }

      // Vector search query
      const query = `
        SELECT
          ${selectColumns.join(',\n          ')}
        FROM motion_patterns mp
        LEFT JOIN motion_embeddings me ON me.motion_pattern_id = mp.id
        WHERE ${whereClause}
        ORDER BY similarity DESC
        LIMIT $${paramIndex}
      `;

      params.push(limit);

      const results = await prisma.$queryRawUnsafe<MotionPatternDbResult[]>(
        query,
        ...params
      );

      // Map results
      const matches: MotionPatternMatch[] = results.map((r) => {
        const match: MotionPatternMatch = {
          id: r.id,
          webPageId: r.web_page_id,
          name: r.name,
          type: r.category,
          trigger: r.trigger_type,
          similarity: r.similarity,
        };

        if (r.duration !== null) {
          match.duration = r.duration;
        }

        if (r.raw_css) {
          match.rawCss = r.raw_css;
        }

        return match;
      });

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info('[PatternMatcher] Motion pattern search completed', {
          resultsCount: matches.length,
          processingTimeMs,
        });
      }

      return matches;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[PatternMatcher] Motion pattern search failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      throw error;
    }
  }

  /**
   * Calculate uniqueness score (inverse of max similarity)
   */
  async calculateUniquenessScore(
    embedding: number[],
    sectionType?: string
  ): Promise<number> {
    if (isDevelopment()) {
      logger.info('[PatternMatcher] Calculating uniqueness score', {
        embeddingDimensions: embedding.length,
        sectionType,
      });
    }

    // Validate embedding
    this.validateEmbedding(embedding, 'calculateUniquenessScore');

    try {
      // Find the most similar pattern (limit = 1)
      const searchOptions: SectionPatternSearchOptions = {
        limit: 1,
        minSimilarity: 0, // No minimum to find the closest match
      };

      // Only add sectionType if it's defined
      if (sectionType !== undefined) {
        searchOptions.sectionType = sectionType;
      }

      const matches = await this.findSimilarSectionPatterns(embedding, searchOptions);

      // If no matches found, the pattern is completely unique
      if (matches.length === 0) {
        if (isDevelopment()) {
          logger.info('[PatternMatcher] No similar patterns found, uniqueness = 1.0');
        }
        return 1.0;
      }

      // Uniqueness = 1 - max_similarity
      const maxSimilarity = matches[0]?.similarity ?? 0;
      const uniquenessScore = 1 - maxSimilarity;

      if (isDevelopment()) {
        logger.info('[PatternMatcher] Uniqueness score calculated', {
          maxSimilarity,
          uniquenessScore,
        });
      }

      return uniquenessScore;
    } catch (error) {
      // If search fails, return moderate uniqueness
      if (isDevelopment()) {
        logger.warn('[PatternMatcher] Uniqueness calculation failed, returning default', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      return 0.5;
    }
  }

  /**
   * Compare two patterns and return similarity metrics
   */
  comparePatterns(embeddingA: number[], embeddingB: number[]): PatternComparison {
    if (isDevelopment()) {
      logger.info('[PatternMatcher] Comparing patterns', {
        embeddingADimensions: embeddingA.length,
        embeddingBDimensions: embeddingB.length,
      });
    }

    // Validate both embeddings
    this.validateEmbedding(embeddingA, 'comparePatterns:embeddingA');
    this.validateEmbedding(embeddingB, 'comparePatterns:embeddingB');

    // Calculate cosine similarity
    const cosineSimilarity = calculateCosineSimilarity(embeddingA, embeddingB);

    // Categorize match level
    const isHighMatch = cosineSimilarity > HIGH_SIMILARITY_THRESHOLD;
    const isMediumMatch =
      cosineSimilarity >= MEDIUM_SIMILARITY_THRESHOLD &&
      cosineSimilarity <= HIGH_SIMILARITY_THRESHOLD;
    const isLowMatch = cosineSimilarity < MEDIUM_SIMILARITY_THRESHOLD;

    if (isDevelopment()) {
      logger.info('[PatternMatcher] Pattern comparison completed', {
        cosineSimilarity,
        isHighMatch,
        isMediumMatch,
        isLowMatch,
      });
    }

    return {
      cosineSimilarity,
      isHighMatch,
      isMediumMatch,
      isLowMatch,
    };
  }
}

// =====================================================
// Singleton Instance
// =====================================================

let patternMatcherServiceInstance: PatternMatcherService | null = null;

/**
 * Get PatternMatcherService instance (singleton)
 */
export function getPatternMatcherService(): PatternMatcherService {
  if (!patternMatcherServiceInstance) {
    patternMatcherServiceInstance = new PatternMatcherService();
  }
  return patternMatcherServiceInstance;
}

/**
 * Reset PatternMatcherService instance
 */
export function resetPatternMatcherService(): void {
  patternMatcherServiceInstance = null;
}

/**
 * Create PatternMatcherService factory
 */
export function createPatternMatcherServiceFactory(): () => IPatternMatcherService {
  return () => getPatternMatcherService();
}

export default PatternMatcherService;
