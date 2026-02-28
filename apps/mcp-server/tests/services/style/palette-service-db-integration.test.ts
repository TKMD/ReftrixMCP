// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PaletteService Database Integration Tests
 * PaletteServiceがDBリポジトリを使用し、フォールバックが機能することを確認
 *
 * @module tests/services/style/palette-service-db-integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { BrandPalette, PaletteMode } from '../../../src/types/creative/palette';

// Mock PrismaClient
type MockPrismaClient = {
  brandPalette: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
};

// Test data: BrandPalette with ColorTokens from database
const mockDbPalette = {
  id: '01939abc-def0-7000-8000-000000000001',
  name: 'Reftrix Standard',
  slug: 'reftrix-standard',
  description: 'Reftrixのデフォルトブランドパレット',
  mode: 'light' as const,
  isDefault: true,
  createdAt: new Date('2025-11-01T00:00:00Z'),
  updatedAt: new Date('2025-12-01T00:00:00Z'),
  tokens: [
    {
      id: 'token-1',
      paletteId: '01939abc-def0-7000-8000-000000000001',
      name: 'primary',
      hex: '#3B82F6',
      oklchL: 0.623,
      oklchC: 0.214,
      oklchH: 259.7,
      role: 'primary' as const,
      semanticMeaning: '主要ブランドカラー',
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
};

describe('PaletteService Database Integration', () => {
  let mockPrisma: MockPrismaClient;

  beforeEach(() => {
    mockPrisma = {
      brandPalette: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createPaletteServiceWithDb', () => {
    it('should create service with Prisma repository', async () => {
      // Arrange
      mockPrisma.brandPalette.findMany.mockResolvedValue([mockDbPalette]);

      const { createPaletteServiceWithDb } = await import(
        '../../../src/services/style/palette-service'
      );

      // Act
      const service = createPaletteServiceWithDb(mockPrisma as unknown as PrismaClient);
      const result = await service.getPalette({});

      // Assert
      expect(result.palettes).toBeDefined();
      expect(result.palettes).toHaveLength(1);
      expect(result.palettes![0].brand_name).toBe('Reftrix Standard');
    });

    it('should return palettes from database', async () => {
      // Arrange
      mockPrisma.brandPalette.findUnique.mockResolvedValue(mockDbPalette);

      const { createPaletteServiceWithDb } = await import(
        '../../../src/services/style/palette-service'
      );

      // Act
      const service = createPaletteServiceWithDb(mockPrisma as unknown as PrismaClient);
      const result = await service.getPalette({
        id: '01939abc-def0-7000-8000-000000000001',
      });

      // Assert
      expect(result.palette).toBeDefined();
      expect(result.palette!.id).toBe('01939abc-def0-7000-8000-000000000001');
      expect(result.palette!.tokens['primary'].hex).toBe('#3B82F6');
    });
  });

  describe('Fallback to in-memory repository', () => {
    it('should use default repository when no Prisma client provided', async () => {
      // Import PaletteService without Prisma
      const { PaletteService } = await import(
        '../../../src/services/style/palette-service'
      );

      // Act
      const service = new PaletteService();
      const result = await service.getPalette({});

      // Assert - Should return in-memory default palettes
      expect(result.palettes).toBeDefined();
      expect(result.palettes!.length).toBeGreaterThan(0);
    });
  });

  describe('search by brand name', () => {
    it('should search palettes by brand name in database', async () => {
      // Arrange
      mockPrisma.brandPalette.findMany.mockResolvedValue([mockDbPalette]);

      const { createPaletteServiceWithDb } = await import(
        '../../../src/services/style/palette-service'
      );

      // Act
      const service = createPaletteServiceWithDb(mockPrisma as unknown as PrismaClient);
      const result = await service.getPalette({ brand_name: 'Reftrix' });

      // Assert
      expect(result.palettes).toBeDefined();
      expect(mockPrisma.brandPalette.findMany).toHaveBeenCalledWith({
        where: {
          name: {
            contains: 'Reftrix',
            mode: 'insensitive',
          },
        },
        include: { tokens: { orderBy: { sortOrder: 'asc' } } },
      });
    });
  });

  describe('filter by mode', () => {
    it('should filter palettes by mode from database', async () => {
      // Arrange
      mockPrisma.brandPalette.findMany.mockResolvedValue([mockDbPalette]);

      const { createPaletteServiceWithDb } = await import(
        '../../../src/services/style/palette-service'
      );

      // Act
      const service = createPaletteServiceWithDb(mockPrisma as unknown as PrismaClient);
      const result = await service.getPalette({ mode: 'light' });

      // Assert
      expect(result.palettes).toBeDefined();
      expect(mockPrisma.brandPalette.findMany).toHaveBeenCalledWith({
        where: { mode: 'light' },
        include: { tokens: { orderBy: { sortOrder: 'asc' } } },
      });
    });
  });
});
