// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * preference-rerank.helper unit tests (TDD Red Phase)
 *
 * Tests for the preference reranking helper that adjusts search results
 * based on user preference embeddings. The implementation is being
 * developed in parallel by ML/Search Engineer.
 *
 * @module tests/services/preference-rerank.helper.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  cosineSimilarity,
  rerankWithPreference,
  getPreferenceEmbedding,
  DEFAULT_RERANK_ALPHA,
  MIN_INTERACTIONS_FOR_RERANK,
  type RerankableItem,
  type RerankOptions,
  type RerankResult,
  type EmbeddingDomain,
} from '../../src/services/preference-rerank.helper';
import type { IPrismaClient } from '../../src/services/preference-profile.service';

// =====================================================
// Test Helpers
// =====================================================

function createTestVector(seed: number): number[] {
  const vec = new Array(768).fill(0);
  for (let i = 0; i < 768; i++) {
    vec[i] = Math.sin(seed * (i + 1));
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map((v) => v / norm);
}

function createOrthogonalVectors(): { a: number[]; b: number[] } {
  const a = new Array(768).fill(0);
  const b = new Array(768).fill(0);
  for (let i = 0; i < 384; i++) {
    a[i] = 1;
  }
  for (let i = 384; i < 768; i++) {
    b[i] = 1;
  }
  const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return {
    a: a.map((v) => v / normA),
    b: b.map((v) => v / normB),
  };
}

function createMockPrisma(overrides?: {
  profileRows?: Array<{
    id: string;
    preference_embedding: string | null;
    interaction_count: number | bigint;
  }>;
  itemEmbeddingRows?: Array<{
    item_id: string;
    embedding: string;
  }>;
}): IPrismaClient {
  const profileRows = overrides?.profileRows ?? [];
  const itemEmbeddingRows = overrides?.itemEmbeddingRows ?? [];

  return {
    $queryRawUnsafe: vi.fn().mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('preference_profiles')) {
        return Promise.resolve(profileRows);
      }
      // DB fetch for item embeddings (domain-based)
      return Promise.resolve(itemEmbeddingRows);
    }),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  };
}

function createTestItems(count: number): RerankableItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    similarity: 1.0 - i * 0.1,
    embedding: createTestVector(i + 1),
  }));
}

// =====================================================
// Constants
// =====================================================

const TEST_PROFILE_ID = '01234567-89ab-cdef-0123-456789abcdef';

// =====================================================
// cosineSimilarity
// =====================================================

describe('cosineSimilarity', () => {
  it('should return 1.0 for identical vectors', () => {
    // Arrange
    const vec = createTestVector(42);

    // Act
    const result = cosineSimilarity(vec, vec);

    // Assert
    expect(result).toBeCloseTo(1.0, 5);
  });

  it('should return 0.0 for orthogonal vectors', () => {
    // Arrange
    const { a, b } = createOrthogonalVectors();

    // Act
    const result = cosineSimilarity(a, b);

    // Assert
    expect(result).toBeCloseTo(0.0, 5);
  });

  it('should return approximately -1.0 for opposite vectors', () => {
    // Arrange
    const vec = createTestVector(7);
    const opposite = vec.map((v) => -v);

    // Act
    const result = cosineSimilarity(vec, opposite);

    // Assert
    expect(result).toBeCloseTo(-1.0, 5);
  });

  it('should return 0 when vectors have different lengths', () => {
    // Arrange
    const a = [1, 0, 0];
    const b = [1, 0];

    // Act
    const result = cosineSimilarity(a, b);

    // Assert
    expect(result).toBe(0);
  });

  it('should return 0 for a zero vector', () => {
    // Arrange
    const zero = new Array(768).fill(0);
    const other = createTestVector(1);

    // Act
    const result = cosineSimilarity(zero, other);

    // Assert
    expect(result).toBe(0);
  });

  it('should return 0 for empty arrays', () => {
    // Arrange
    const a: number[] = [];
    const b: number[] = [];

    // Act
    const result = cosineSimilarity(a, b);

    // Assert
    expect(result).toBe(0);
  });
});

// =====================================================
// rerankWithPreference
// =====================================================

describe('rerankWithPreference', () => {
  it('should return reranked: false when profile does not exist', async () => {
    // Arrange
    const items = createTestItems(3);
    const prisma = createMockPrisma({ profileRows: [] });

    // Act
    const result = await rerankWithPreference(items, TEST_PROFILE_ID, prisma);

    // Assert
    expect(result.reranked).toBe(false);
    expect(result.items).toEqual(items);
  });

  it('should return reranked: false when preference_embedding is NULL', async () => {
    // Arrange
    const items = createTestItems(3);
    const prisma = createMockPrisma({
      profileRows: [
        {
          id: TEST_PROFILE_ID,
          preference_embedding: null,
          interaction_count: 10,
        },
      ],
    });

    // Act
    const result = await rerankWithPreference(items, TEST_PROFILE_ID, prisma);

    // Assert
    expect(result.reranked).toBe(false);
    expect(result.items).toEqual(items);
  });

  it('should return reranked: false when interaction_count < MIN_INTERACTIONS_FOR_RERANK', async () => {
    // Arrange
    const items = createTestItems(3);
    const prefEmbedding = createTestVector(99);
    const prisma = createMockPrisma({
      profileRows: [
        {
          id: TEST_PROFILE_ID,
          preference_embedding: `[${prefEmbedding.join(',')}]`,
          interaction_count: MIN_INTERACTIONS_FOR_RERANK - 1,
        },
      ],
    });

    // Act
    const result = await rerankWithPreference(items, TEST_PROFILE_ID, prisma);

    // Assert
    expect(result.reranked).toBe(false);
    expect(result.items).toEqual(items);
  });

  it('should rerank when profile has embedding and sufficient interactions', async () => {
    // Arrange
    const items = createTestItems(3);
    const prefEmbedding = createTestVector(99);
    const prisma = createMockPrisma({
      profileRows: [
        {
          id: TEST_PROFILE_ID,
          preference_embedding: `[${prefEmbedding.join(',')}]`,
          interaction_count: MIN_INTERACTIONS_FOR_RERANK,
        },
      ],
    });

    // Act
    const result = await rerankWithPreference(items, TEST_PROFILE_ID, prisma);

    // Assert
    expect(result.reranked).toBe(true);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => typeof item.similarity === 'number')).toBe(true);
  });

  it('should preserve original order when alpha=0.0 (search score only)', async () => {
    // Arrange
    const items = createTestItems(5);
    const originalOrder = items.map((item) => item.id);
    const prefEmbedding = createTestVector(99);
    const prisma = createMockPrisma({
      profileRows: [
        {
          id: TEST_PROFILE_ID,
          preference_embedding: `[${prefEmbedding.join(',')}]`,
          interaction_count: 10,
        },
      ],
    });
    const options: RerankOptions = { alpha: 0.0 };

    // Act
    const result = await rerankWithPreference(items, TEST_PROFILE_ID, prisma, options);

    // Assert
    expect(result.items.map((item) => item.id)).toEqual(originalOrder);
  });

  it('should sort by preference similarity only when alpha=1.0', async () => {
    // Arrange
    const prefEmbedding = createTestVector(99);
    const items: RerankableItem[] = [
      { id: 'low-search-high-pref', similarity: 0.1, embedding: prefEmbedding },
      { id: 'high-search-low-pref', similarity: 0.9, embedding: createTestVector(1) },
      { id: 'mid-search-mid-pref', similarity: 0.5, embedding: createTestVector(50) },
    ];
    const prisma = createMockPrisma({
      profileRows: [
        {
          id: TEST_PROFILE_ID,
          preference_embedding: `[${prefEmbedding.join(',')}]`,
          interaction_count: 10,
        },
      ],
    });
    const options: RerankOptions = { alpha: 1.0 };

    // Act
    const result = await rerankWithPreference(items, TEST_PROFILE_ID, prisma, options);

    // Assert
    expect(result.reranked).toBe(true);
    expect(result.items[0]!.id).toBe('low-search-high-pref');
  });

  it('should blend scores with default alpha=0.3 as (1-0.3)*search + 0.3*pref', async () => {
    // Arrange
    const prefEmbedding = createTestVector(99);
    const itemEmbedding = createTestVector(99);
    const searchScore = 0.5;
    const items: RerankableItem[] = [
      { id: 'test-item', similarity: searchScore, embedding: itemEmbedding },
    ];
    const prisma = createMockPrisma({
      profileRows: [
        {
          id: TEST_PROFILE_ID,
          preference_embedding: `[${prefEmbedding.join(',')}]`,
          interaction_count: 10,
        },
      ],
    });

    // Act
    const result = await rerankWithPreference(items, TEST_PROFILE_ID, prisma);

    // Assert
    expect(result.reranked).toBe(true);
    const prefSim = cosineSimilarity(itemEmbedding, prefEmbedding);
    const expectedScore = (1 - DEFAULT_RERANK_ALPHA) * searchScore + DEFAULT_RERANK_ALPHA * prefSim;
    expect(result.items[0]!.similarity).toBeCloseTo(expectedScore, 5);
  });

  it('should return reranked: false for an empty results array', async () => {
    // Arrange
    const items: RerankableItem[] = [];
    const prefEmbedding = createTestVector(99);
    const prisma = createMockPrisma({
      profileRows: [
        {
          id: TEST_PROFILE_ID,
          preference_embedding: `[${prefEmbedding.join(',')}]`,
          interaction_count: 10,
        },
      ],
    });

    // Act
    const result = await rerankWithPreference(items, TEST_PROFILE_ID, prisma);

    // Assert
    expect(result.reranked).toBe(false);
    expect(result.items).toEqual([]);
  });

  it('should treat items with undefined embedding as pref_similarity=0', async () => {
    // Arrange
    const prefEmbedding = createTestVector(99);
    const items: RerankableItem[] = [
      { id: 'with-embedding', similarity: 0.5, embedding: prefEmbedding },
      { id: 'without-embedding', similarity: 0.8 },
    ];
    const prisma = createMockPrisma({
      profileRows: [
        {
          id: TEST_PROFILE_ID,
          preference_embedding: `[${prefEmbedding.join(',')}]`,
          interaction_count: 10,
        },
      ],
    });
    const options: RerankOptions = { alpha: 1.0 };

    // Act
    const result = await rerankWithPreference(items, TEST_PROFILE_ID, prisma, options);

    // Assert
    expect(result.reranked).toBe(true);
    const withEmbeddingItem = result.items.find((item) => item.id === 'with-embedding');
    const withoutEmbeddingItem = result.items.find((item) => item.id === 'without-embedding');
    expect(withEmbeddingItem).toBeDefined();
    expect(withoutEmbeddingItem).toBeDefined();
    // alpha=1.0 means the item with matching embedding should rank first
    expect(result.items[0]!.id).toBe('with-embedding');
    // The item without embedding keeps its original similarity (no rerank applied)
    expect(withoutEmbeddingItem!.similarity).toBeCloseTo(0.8, 5);
  });

  // =====================================================
  // domain-based DB embedding fetch
  // =====================================================

  it('should fetch embeddings from DB when items lack embeddings and domain is specified', async () => {
    // Arrange: items without inline embeddings
    const prefEmbedding = createTestVector(99);
    const itemEmbedding = createTestVector(99); // same as pref → high cosine sim
    const items: RerankableItem[] = [
      { id: 'item-a', similarity: 0.5 },
      { id: 'item-b', similarity: 0.9 },
    ];
    const prisma = createMockPrisma({
      profileRows: [
        {
          id: TEST_PROFILE_ID,
          preference_embedding: `[${prefEmbedding.join(',')}]`,
          interaction_count: 10,
        },
      ],
      itemEmbeddingRows: [
        { item_id: 'item-a', embedding: `[${itemEmbedding.join(',')}]` },
        { item_id: 'item-b', embedding: `[${createTestVector(1).join(',')}]` },
      ],
    });

    // Act
    const result = await rerankWithPreference(items, TEST_PROFILE_ID, prisma, { domain: 'layout' });

    // Assert
    expect(result.reranked).toBe(true);
    expect(result.items).toHaveLength(2);
    // item-a has high pref similarity so should be boosted
    expect(result.items[0]!.id).toBe('item-a');
  });

  it('should return reranked: false when domain DB returns no embeddings', async () => {
    // Arrange: items without embeddings, DB returns empty
    const prefEmbedding = createTestVector(99);
    const items: RerankableItem[] = [
      { id: 'item-x', similarity: 0.7 },
    ];
    const prisma = createMockPrisma({
      profileRows: [
        {
          id: TEST_PROFILE_ID,
          preference_embedding: `[${prefEmbedding.join(',')}]`,
          interaction_count: 10,
        },
      ],
      itemEmbeddingRows: [], // no embeddings in DB
    });

    // Act
    const result = await rerankWithPreference(items, TEST_PROFILE_ID, prisma, { domain: 'motion' });

    // Assert
    expect(result.reranked).toBe(false);
    expect(result.reason).toContain('DB');
  });

  it('should return reranked: false when items lack embeddings and no domain specified', async () => {
    // Arrange: items without embeddings, no domain
    const prefEmbedding = createTestVector(99);
    const items: RerankableItem[] = [
      { id: 'item-y', similarity: 0.6 },
    ];
    const prisma = createMockPrisma({
      profileRows: [
        {
          id: TEST_PROFILE_ID,
          preference_embedding: `[${prefEmbedding.join(',')}]`,
          interaction_count: 10,
        },
      ],
    });

    // Act
    const result = await rerankWithPreference(items, TEST_PROFILE_ID, prisma);

    // Assert
    expect(result.reranked).toBe(false);
    expect(result.reason).toContain('embedding');
  });

  it('should work with all 5 domain types', async () => {
    // Arrange
    const prefEmbedding = createTestVector(42);
    const itemEmbedding = createTestVector(42);
    const domains: EmbeddingDomain[] = ['layout', 'motion', 'background', 'narrative', 'responsive'];

    for (const domain of domains) {
      const items: RerankableItem[] = [{ id: `${domain}-item`, similarity: 0.5 }];
      const prisma = createMockPrisma({
        profileRows: [
          {
            id: TEST_PROFILE_ID,
            preference_embedding: `[${prefEmbedding.join(',')}]`,
            interaction_count: 10,
          },
        ],
        itemEmbeddingRows: [
          { item_id: `${domain}-item`, embedding: `[${itemEmbedding.join(',')}]` },
        ],
      });

      // Act
      const result = await rerankWithPreference(items, TEST_PROFILE_ID, prisma, { domain });

      // Assert
      expect(result.reranked).toBe(true);
    }
  });
});

// =====================================================
// getPreferenceEmbedding
// =====================================================

describe('getPreferenceEmbedding', () => {
  it('should return null embedding and 0 interaction count when profile does not exist', async () => {
    // Arrange
    const prisma = createMockPrisma({ profileRows: [] });

    // Act
    const result = await getPreferenceEmbedding(TEST_PROFILE_ID, prisma);

    // Assert
    expect(result.embedding).toBeNull();
    expect(result.interactionCount).toBe(0);
  });

  it('should return embedding and interaction count when profile exists with embedding', async () => {
    // Arrange
    const testEmbedding = createTestVector(42);
    const prisma = createMockPrisma({
      profileRows: [
        {
          id: TEST_PROFILE_ID,
          preference_embedding: `[${testEmbedding.join(',')}]`,
          interaction_count: 7,
        },
      ],
    });

    // Act
    const result = await getPreferenceEmbedding(TEST_PROFILE_ID, prisma);

    // Assert
    expect(result.embedding).not.toBeNull();
    expect(result.embedding).toHaveLength(768);
    expect(result.interactionCount).toBe(7);
  });

  it('should return null embedding when profile exists but embedding is NULL', async () => {
    // Arrange
    const prisma = createMockPrisma({
      profileRows: [
        {
          id: TEST_PROFILE_ID,
          preference_embedding: null,
          interaction_count: 3,
        },
      ],
    });

    // Act
    const result = await getPreferenceEmbedding(TEST_PROFILE_ID, prisma);

    // Assert
    expect(result.embedding).toBeNull();
    expect(result.interactionCount).toBe(3);
  });
});

// =====================================================
// Exported Constants
// =====================================================

describe('exported constants', () => {
  it('should export DEFAULT_RERANK_ALPHA as 0.3', () => {
    expect(DEFAULT_RERANK_ALPHA).toBe(0.3);
  });

  it('should export MIN_INTERACTIONS_FOR_RERANK as 5', () => {
    expect(MIN_INTERACTIONS_FOR_RERANK).toBe(5);
  });
});
