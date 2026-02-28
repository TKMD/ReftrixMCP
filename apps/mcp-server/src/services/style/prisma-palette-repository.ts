// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PrismaPaletteRepository - データベースからパレットを取得するリポジトリ
 * Prismaを使用してBrandPaletteとColorTokenをデータベースから取得
 *
 * @module services/style/prisma-palette-repository
 */

import type { PrismaClient, BrandPalette as PrismaBrandPalette, ColorToken as PrismaColorToken, ColorRole } from '@prisma/client';
import type {
  BrandPalette,
  PaletteMode,
  ColorToken,
  TokenUsage,
} from '../../types/creative/palette';
import type { PaletteRepository } from './palette-service';
import { createLogger } from '../../utils/logger';

const logger = createLogger('PrismaPaletteRepository');

/**
 * Prismaから取得したパレットと関連トークンの型
 */
type PrismaPaletteWithTokens = PrismaBrandPalette & {
  tokens: PrismaColorToken[];
};

/**
 * ColorRoleからTokenUsageへのマッピング
 */
const roleToUsageMap: Record<ColorRole, TokenUsage[]> = {
  primary: ['accent', 'cta'],
  secondary: ['accent'],
  accent: ['highlight'],
  neutral: ['foreground'],
  semantic: ['info'],
};

/**
 * Prisma PaletteModeからドメインPaletteModeへの変換
 * Prismaは 'light' | 'dark' | 'system' を使用
 * ドメインモデルは 'light' | 'dark' | 'both' を使用
 */
function convertPaletteMode(mode: string): PaletteMode {
  if (mode === 'system') {
    return 'both';
  }
  return mode as PaletteMode;
}

/**
 * PrismaColorTokenからドメインColorTokenへの変換
 */
function convertToken(token: PrismaColorToken): ColorToken {
  const colorToken: ColorToken = {
    name: token.name,
    hex: token.hex,
    oklch: {
      l: token.oklchL,
      c: token.oklchC,
      h: token.oklchH,
    },
  };

  // roleからusageを設定
  const usage = roleToUsageMap[token.role];
  if (usage && usage.length > 0) {
    colorToken.usage = usage;
  }

  // semanticMeaningがあればdescriptionに設定
  if (token.semanticMeaning) {
    colorToken.description = token.semanticMeaning;
  }

  return colorToken;
}

/**
 * Prisma BrandPaletteからドメインBrandPaletteへの変換
 */
function convertPalette(palette: PrismaPaletteWithTokens): BrandPalette {
  const tokens: Record<string, ColorToken> = {};

  for (const token of palette.tokens) {
    tokens[token.name] = convertToken(token);
  }

  const result: BrandPalette = {
    id: palette.id,
    brandId: palette.slug, // slug -> brandId
    brandName: palette.name,
    mode: convertPaletteMode(palette.mode),
    tokens,
    createdAt: palette.createdAt,
    updatedAt: palette.updatedAt,
  };

  // descriptionが存在する場合のみ設定（exactOptionalPropertyTypes対応）
  if (palette.description !== null) {
    result.description = palette.description;
  }

  return result;
}

/**
 * PrismaPaletteRepository
 * データベースからパレットを取得するリポジトリ実装
 */
export class PrismaPaletteRepository implements PaletteRepository {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * 全パレットを取得
   */
  async findAll(): Promise<BrandPalette[]> {
    if (process.env.NODE_ENV === 'development') {
      logger.info('findAll: Fetching all palettes from database');
    }

    const palettes = await this.prisma.brandPalette.findMany({
      include: {
        tokens: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    return palettes.map(convertPalette);
  }

  /**
   * IDでパレットを取得
   */
  async findById(id: string): Promise<BrandPalette | null> {
    if (process.env.NODE_ENV === 'development') {
      logger.info('findById: Fetching palette by ID', { id });
    }

    const palette = await this.prisma.brandPalette.findUnique({
      where: { id },
      include: {
        tokens: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!palette) {
      return null;
    }

    return convertPalette(palette);
  }

  /**
   * ブランド名で部分一致検索（大文字小文字を区別しない）
   */
  async findByBrandName(name: string): Promise<BrandPalette[]> {
    if (process.env.NODE_ENV === 'development') {
      logger.info('findByBrandName: Searching palettes by brand name', { name });
    }

    const palettes = await this.prisma.brandPalette.findMany({
      where: {
        name: {
          contains: name,
          mode: 'insensitive',
        },
      },
      include: {
        tokens: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    return palettes.map(convertPalette);
  }

  /**
   * モードでパレットを検索
   * 'both'モードは存在しないため、指定されたモード（light/dark）のみを返す
   */
  async findByMode(mode: PaletteMode): Promise<BrandPalette[]> {
    if (process.env.NODE_ENV === 'development') {
      logger.info('findByMode: Fetching palettes by mode', { mode });
    }

    // 'both'の場合はsystemモードも含める
    const dbMode = mode === 'both' ? 'system' : mode;

    const palettes = await this.prisma.brandPalette.findMany({
      where: { mode: dbMode },
      include: {
        tokens: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    return palettes.map(convertPalette);
  }
}
