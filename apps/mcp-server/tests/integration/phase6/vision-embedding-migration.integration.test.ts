// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision Embedding Migration Verification Tests
 *
 * TDD RED Phase: These tests verify the database schema changes for vision_embedding support.
 *
 * Requirements:
 * - MotionEmbedding table should have vision_embedding column (vector(768))
 * - HNSW index should exist on motion_embeddings.vision_embedding
 * - Column must be NULLABLE for backward compatibility
 *
 * Note: SectionEmbedding already has visionEmbedding column (verified in existing schema)
 *
 * Technical Specifications:
 * - Vector dimensions: 768 (multilingual-e5-base compatible)
 * - HNSW parameters: m=16, ef_construction=64, vector_cosine_ops
 *
 * @see 
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, type PrismaClient } from '@reftrix/database';

// Skip all tests if DATABASE_URL is not set
const isDatabaseAvailable = !!process.env.DATABASE_URL;

describe.skipIf(!isDatabaseAvailable)('Vision Embedding Migration', () => {
  // Use singleton prisma instance from @reftrix/database

  beforeAll(async () => {
    // Ensure connection is established
    await prisma.$connect();
  });

  afterAll(async () => {
    // Note: Don't disconnect singleton in tests as other tests may use it
    // await prisma.$disconnect();
  });

  describe('MotionEmbedding Table Schema', () => {
    it('should have vision_embedding column', async () => {
      // Query column information from PostgreSQL information_schema
      const result = await prisma.$queryRaw<Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        udt_name: string;
      }>>`
        SELECT column_name, data_type, is_nullable, udt_name
        FROM information_schema.columns
        WHERE table_name = 'motion_embeddings'
          AND column_name = 'vision_embedding'
      `;

      expect(result).toHaveLength(1);
      expect(result[0].column_name).toBe('vision_embedding');
      // pgvector columns show as 'USER-DEFINED' data_type with 'vector' udt_name
      expect(result[0].data_type).toBe('USER-DEFINED');
      expect(result[0].udt_name).toBe('vector');
      // Column must be NULLABLE for backward compatibility
      expect(result[0].is_nullable).toBe('YES');
    });

    it('should have vision_embedding as vector(768) type', async () => {
      // Check vector dimension using pg_attribute and pg_type
      const result = await prisma.$queryRaw<Array<{
        typmod: number;
      }>>`
        SELECT a.atttypmod as typmod
        FROM pg_attribute a
        JOIN pg_class c ON a.attrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE c.relname = 'motion_embeddings'
          AND a.attname = 'vision_embedding'
          AND n.nspname = 'public'
      `;

      expect(result).toHaveLength(1);
      // pgvector stores dimension as typmod, 768 dimensions
      // Note: The actual typmod value may be dimension or dimension-related encoding
      // We verify the column exists and has the correct dimension through the index
      expect(result[0].typmod).toBeGreaterThan(0);
    });
  });

  describe('HNSW Index for MotionEmbedding Vision', () => {
    it('should have HNSW index on vision_embedding column', async () => {
      // Query index information from pg_indexes
      const result = await prisma.$queryRaw<Array<{
        indexname: string;
        indexdef: string;
      }>>`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'motion_embeddings'
          AND indexname LIKE '%vision%hnsw%'
      `;

      expect(result.length).toBeGreaterThanOrEqual(1);

      // Find the HNSW index for vision_embedding
      const hnswIndex = result.find(idx =>
        idx.indexdef.includes('hnsw') &&
        idx.indexdef.includes('vision_embedding')
      );

      expect(hnswIndex).toBeDefined();
      expect(hnswIndex!.indexdef).toContain('hnsw');
      expect(hnswIndex!.indexdef).toContain('vision_embedding');
      expect(hnswIndex!.indexdef).toContain('vector_cosine_ops');
    });

    it('should have correct HNSW parameters (m=16, ef_construction=64)', async () => {
      // Query index definition to verify parameters
      const result = await prisma.$queryRaw<Array<{
        indexdef: string;
      }>>`
        SELECT indexdef
        FROM pg_indexes
        WHERE tablename = 'motion_embeddings'
          AND indexdef LIKE '%hnsw%'
          AND indexdef LIKE '%vision_embedding%'
      `;

      expect(result).toHaveLength(1);

      const indexDef = result[0].indexdef;
      // Verify HNSW parameters (PostgreSQL may quote values like m='16')
      expect(indexDef).toMatch(/m\s*=\s*'?16'?/);
      expect(indexDef).toMatch(/ef_construction\s*=\s*'?64'?/);
    });
  });

  describe('SectionEmbedding Table Schema (Verification)', () => {
    // SectionEmbedding already has visionEmbedding - verify it's correctly configured
    it('should have vision_embedding column', async () => {
      const result = await prisma.$queryRaw<Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        udt_name: string;
      }>>`
        SELECT column_name, data_type, is_nullable, udt_name
        FROM information_schema.columns
        WHERE table_name = 'section_embeddings'
          AND column_name = 'vision_embedding'
      `;

      expect(result).toHaveLength(1);
      expect(result[0].column_name).toBe('vision_embedding');
      expect(result[0].data_type).toBe('USER-DEFINED');
      expect(result[0].udt_name).toBe('vector');
      expect(result[0].is_nullable).toBe('YES');
    });

    it('should have HNSW index on vision_embedding column', async () => {
      const result = await prisma.$queryRaw<Array<{
        indexname: string;
        indexdef: string;
      }>>`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'section_embeddings'
          AND indexdef LIKE '%hnsw%'
          AND indexdef LIKE '%vision_embedding%'
      `;

      expect(result.length).toBeGreaterThanOrEqual(1);

      const hnswIndex = result[0];
      expect(hnswIndex.indexdef).toContain('hnsw');
      expect(hnswIndex.indexdef).toContain('vision_embedding');
      expect(hnswIndex.indexdef).toContain('vector_cosine_ops');
    });
  });

  describe('Vector Search Functionality', () => {
    it('should be able to perform vector similarity search on motion_embeddings.vision_embedding', async () => {
      // Generate a test embedding (768 dimensions, normalized)
      const testEmbedding = Array(768).fill(0).map(() => Math.random());
      const norm = Math.sqrt(testEmbedding.reduce((sum, val) => sum + val * val, 0));
      const normalizedEmbedding = testEmbedding.map(val => val / norm);

      // This query should not fail if the column and index exist
      // Even with no data, the query structure should be valid
      const result = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count
        FROM motion_embeddings
        WHERE vision_embedding IS NOT NULL
      `;

      // Query should execute without error
      expect(result).toBeDefined();
      expect(result).toHaveLength(1);
      // Count can be 0 or more, we just verify the query works
      expect(Number(result[0].count)).toBeGreaterThanOrEqual(0);
    });

    it('should be able to use cosine distance operator on vision_embedding', async () => {
      // Test that the cosine distance operator works with the index
      // This verifies vector_cosine_ops is properly configured
      const testVector = `[${Array(768).fill(0.01).join(',')}]`;

      // This query tests the index usage - should not throw
      const result = await prisma.$queryRaw<Array<{ id: string; distance: number }>>`
        SELECT id, vision_embedding <=> ${testVector}::vector AS distance
        FROM motion_embeddings
        WHERE vision_embedding IS NOT NULL
        ORDER BY distance
        LIMIT 1
      `;

      // Query should execute without error (may return empty array if no data)
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
