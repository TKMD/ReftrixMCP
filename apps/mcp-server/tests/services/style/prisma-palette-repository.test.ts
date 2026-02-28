// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PrismaPaletteRepository Unit Tests
 * TDD: Red phase - Write failing tests first
 *
 * @module tests/services/style/prisma-palette-repository
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { BrandPalette, PaletteMode } from '../../../src/types/creative/palette';

// Prisma mock types
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
    {
      id: 'token-2',
      paletteId: '01939abc-def0-7000-8000-000000000001',
      name: 'secondary',
      hex: '#6366F1',
      oklchL: 0.585,
      oklchC: 0.241,
      oklchH: 279.0,
      role: 'secondary' as const,
      semanticMeaning: null,
      sortOrder: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
};

const mockDbPaletteDark = {
  id: '01939abc-def0-7000-8000-000000000002',
  name: 'Reftrix Dark',
  slug: 'reftrix-dark',
  description: 'Reftrixのダークモードパレット',
  mode: 'dark' as const,
  isDefault: false,
  createdAt: new Date('2025-11-01T00:00:00Z'),
  updatedAt: new Date('2025-12-01T00:00:00Z'),
  tokens: [
    {
      id: 'token-3',
      paletteId: '01939abc-def0-7000-8000-000000000002',
      name: 'primary',
      hex: '#60A5FA',
      oklchL: 0.728,
      oklchC: 0.18,
      oklchH: 254.0,
      role: 'primary' as const,
      semanticMeaning: null,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
};

describe('PrismaPaletteRepository', () => {
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

  describe('findAll', () => {
    it('should return all palettes from database', async () => {
      // Arrange
      mockPrisma.brandPalette.findMany.mockResolvedValue([mockDbPalette, mockDbPaletteDark]);

      // Import and instantiate (dynamic import to allow mocking)
      const { PrismaPaletteRepository } = await import(
        '../../../src/services/style/prisma-palette-repository'
      );
      const repository = new PrismaPaletteRepository(mockPrisma as unknown as PrismaClient);

      // Act
      const result = await repository.findAll();

      // Assert
      expect(result).toHaveLength(2);
      expect(mockPrisma.brandPalette.findMany).toHaveBeenCalledWith({
        include: { tokens: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    it('should convert DB palette to BrandPalette domain model', async () => {
      // Arrange
      mockPrisma.brandPalette.findMany.mockResolvedValue([mockDbPalette]);

      const { PrismaPaletteRepository } = await import(
        '../../../src/services/style/prisma-palette-repository'
      );
      const repository = new PrismaPaletteRepository(mockPrisma as unknown as PrismaClient);

      // Act
      const result = await repository.findAll();

      // Assert
      expect(result).toHaveLength(1);
      const palette = result[0];
      expect(palette.id).toBe('01939abc-def0-7000-8000-000000000001');
      expect(palette.brandId).toBe('reftrix-standard'); // slug -> brandId
      expect(palette.brandName).toBe('Reftrix Standard');
      expect(palette.mode).toBe('light');
      expect(palette.description).toBe('Reftrixのデフォルトブランドパレット');

      // Check tokens converted to Record<string, ColorToken>
      expect(palette.tokens).toBeDefined();
      expect(palette.tokens['primary']).toBeDefined();
      expect(palette.tokens['primary'].hex).toBe('#3B82F6');
      expect(palette.tokens['primary'].oklch).toEqual({ l: 0.623, c: 0.214, h: 259.7 });
    });

    it('should return empty array when no palettes exist', async () => {
      // Arrange
      mockPrisma.brandPalette.findMany.mockResolvedValue([]);

      const { PrismaPaletteRepository } = await import(
        '../../../src/services/style/prisma-palette-repository'
      );
      const repository = new PrismaPaletteRepository(mockPrisma as unknown as PrismaClient);

      // Act
      const result = await repository.findAll();

      // Assert
      expect(result).toEqual([]);
    });
  });

  describe('findById', () => {
    it('should return palette by ID', async () => {
      // Arrange
      mockPrisma.brandPalette.findUnique.mockResolvedValue(mockDbPalette);

      const { PrismaPaletteRepository } = await import(
        '../../../src/services/style/prisma-palette-repository'
      );
      const repository = new PrismaPaletteRepository(mockPrisma as unknown as PrismaClient);

      // Act
      const result = await repository.findById('01939abc-def0-7000-8000-000000000001');

      // Assert
      expect(result).not.toBeNull();
      expect(result?.id).toBe('01939abc-def0-7000-8000-000000000001');
      expect(mockPrisma.brandPalette.findUnique).toHaveBeenCalledWith({
        where: { id: '01939abc-def0-7000-8000-000000000001' },
        include: { tokens: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    it('should return null when palette not found', async () => {
      // Arrange
      mockPrisma.brandPalette.findUnique.mockResolvedValue(null);

      const { PrismaPaletteRepository } = await import(
        '../../../src/services/style/prisma-palette-repository'
      );
      const repository = new PrismaPaletteRepository(mockPrisma as unknown as PrismaClient);

      // Act
      const result = await repository.findById('nonexistent-id');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('findByBrandName', () => {
    it('should find palettes by partial brand name match (case-insensitive)', async () => {
      // Arrange
      mockPrisma.brandPalette.findMany.mockResolvedValue([mockDbPalette, mockDbPaletteDark]);

      const { PrismaPaletteRepository } = await import(
        '../../../src/services/style/prisma-palette-repository'
      );
      const repository = new PrismaPaletteRepository(mockPrisma as unknown as PrismaClient);

      // Act
      const result = await repository.findByBrandName('reftrix');

      // Assert
      expect(result).toHaveLength(2);
      expect(mockPrisma.brandPalette.findMany).toHaveBeenCalledWith({
        where: {
          name: {
            contains: 'reftrix',
            mode: 'insensitive',
          },
        },
        include: { tokens: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    it('should return empty array when no matching palettes', async () => {
      // Arrange
      mockPrisma.brandPalette.findMany.mockResolvedValue([]);

      const { PrismaPaletteRepository } = await import(
        '../../../src/services/style/prisma-palette-repository'
      );
      const repository = new PrismaPaletteRepository(mockPrisma as unknown as PrismaClient);

      // Act
      const result = await repository.findByBrandName('nonexistent');

      // Assert
      expect(result).toEqual([]);
    });
  });

  describe('findByMode', () => {
    it('should find palettes by light mode', async () => {
      // Arrange
      mockPrisma.brandPalette.findMany.mockResolvedValue([mockDbPalette]);

      const { PrismaPaletteRepository } = await import(
        '../../../src/services/style/prisma-palette-repository'
      );
      const repository = new PrismaPaletteRepository(mockPrisma as unknown as PrismaClient);

      // Act
      const result = await repository.findByMode('light');

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].mode).toBe('light');
      expect(mockPrisma.brandPalette.findMany).toHaveBeenCalledWith({
        where: { mode: 'light' },
        include: { tokens: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    it('should find palettes by dark mode', async () => {
      // Arrange
      mockPrisma.brandPalette.findMany.mockResolvedValue([mockDbPaletteDark]);

      const { PrismaPaletteRepository } = await import(
        '../../../src/services/style/prisma-palette-repository'
      );
      const repository = new PrismaPaletteRepository(mockPrisma as unknown as PrismaClient);

      // Act
      const result = await repository.findByMode('dark');

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].mode).toBe('dark');
    });
  });

  describe('Token conversion', () => {
    it('should convert ColorToken role to usage array', async () => {
      // Arrange
      mockPrisma.brandPalette.findMany.mockResolvedValue([mockDbPalette]);

      const { PrismaPaletteRepository } = await import(
        '../../../src/services/style/prisma-palette-repository'
      );
      const repository = new PrismaPaletteRepository(mockPrisma as unknown as PrismaClient);

      // Act
      const result = await repository.findAll();

      // Assert
      const primaryToken = result[0].tokens['primary'];
      expect(primaryToken.usage).toContain('accent'); // primary role maps to accent usage
    });

    it('should set token description from semanticMeaning', async () => {
      // Arrange
      mockPrisma.brandPalette.findMany.mockResolvedValue([mockDbPalette]);

      const { PrismaPaletteRepository } = await import(
        '../../../src/services/style/prisma-palette-repository'
      );
      const repository = new PrismaPaletteRepository(mockPrisma as unknown as PrismaClient);

      // Act
      const result = await repository.findAll();

      // Assert
      const primaryToken = result[0].tokens['primary'];
      expect(primaryToken.description).toBe('主要ブランドカラー');
    });
  });

  describe('Error handling', () => {
    it('should propagate database errors', async () => {
      // Arrange
      const dbError = new Error('Database connection failed');
      mockPrisma.brandPalette.findMany.mockRejectedValue(dbError);

      const { PrismaPaletteRepository } = await import(
        '../../../src/services/style/prisma-palette-repository'
      );
      const repository = new PrismaPaletteRepository(mockPrisma as unknown as PrismaClient);

      // Act & Assert
      await expect(repository.findAll()).rejects.toThrow('Database connection failed');
    });
  });
});
