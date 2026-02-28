// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PaletteService - ブランドパレット取得サービス
 * style.get_palette MCPツールのコアロジック
 *
 * 機能:
 * - パレット一覧取得
 * - ID指定でのパレット詳細取得
 * - ブランド名での部分一致検索
 * - モードフィルタリング（light/dark/both）
 * - グラデーション除外オプション
 *
 * @module services/creative/palette-service
 */

import type { PrismaClient } from '@prisma/client';
import type {
  BrandPalette,
  PaletteMode,
  ColorToken,
  ContrastRequirement,
  GradientDefinition,
} from '../../types/creative/palette';
import { createLogger } from '../../utils/logger';
import { McpError, ErrorCode } from '../../utils/errors';
import { PrismaPaletteRepository } from './prisma-palette-repository';

// =============================================================================
// 型定義
// =============================================================================

/**
 * グラデーション自動生成オプション
 */
export interface GradientAutoGenerateOptions {
  /** グラデーションタイプ（linear/radial） */
  type?: 'linear' | 'radial' | undefined;
  /** リニアグラデーションの角度（0-360） */
  angle?: number | undefined;
  /** 使用するトークンペアの配列 */
  token_pairs?: [string, string][] | undefined;
  /** 補色グラデーションを含めるか */
  include_complementary?: boolean | undefined;
  /** 類似色グラデーションを含めるか */
  include_analogous?: boolean | undefined;
}

/**
 * パレット取得オプション
 */
export interface GetPaletteOptions {
  /** パレットID（UUID形式） */
  id?: string | undefined;
  /** ブランド名で部分一致検索 */
  brand_name?: string | undefined;
  /** パレットモード（デフォルト: both） */
  mode?: PaletteMode | undefined;
  /** グラデーションを含めるか（デフォルト: true） */
  include_gradients?: boolean | undefined;
  /** グラデーション自動生成を有効にするか（デフォルト: false） */
  auto_generate_gradients?: boolean | undefined;
  /** グラデーション自動生成オプション */
  gradient_options?: GradientAutoGenerateOptions | undefined;
}

/**
 * パレット一覧アイテム（簡易形式）
 */
export interface PaletteListItem {
  id: string;
  brand_id: string;
  brand_name: string;
  mode: PaletteMode;
  token_count: number;
  description?: string | undefined;
}

/**
 * コントラスト要件（API形式）
 */
export interface ContrastWithApi {
  token: string;
  min_ratio: number;
}

/**
 * カラートークン（API形式）
 */
export interface ColorTokenApi {
  name: string;
  description?: string;
  oklch: {
    l: number;
    c: number;
    h: number;
  };
  hex: string;
  usage?: string[];
  contrast_with?: ContrastWithApi[];
}

/**
 * グラデーション定義（API形式）
 */
export interface GradientApi {
  id: string;
  name: string;
  description?: string;
  type: 'linear' | 'radial';
  angle?: number;
  centerX?: number;
  centerY?: number;
  stops: Array<{
    offset: number;
    token?: string;
    color?: string;
    opacity?: number;
  }>;
  /** 自動生成されたグラデーションかどうか */
  auto_generated?: boolean;
}

/**
 * パレット詳細（API形式）
 */
export interface PaletteDetail {
  id: string;
  brand_id: string;
  brand_name: string;
  description?: string;
  mode: PaletteMode;
  tokens: Record<string, ColorTokenApi>;
  gradients?: GradientApi[];
  created_at: string;
  updated_at: string;
}

/**
 * パレット取得結果
 */
export interface GetPaletteResult {
  /** パレット一覧（一覧取得時） */
  palettes?: PaletteListItem[];
  /** パレット詳細（ID指定時） */
  palette?: PaletteDetail;
}

/**
 * リポジトリインターフェース
 */
export interface PaletteRepository {
  findAll(): Promise<BrandPalette[]>;
  findById(id: string): Promise<BrandPalette | null>;
  findByBrandName(name: string): Promise<BrandPalette[]>;
  findByMode(mode: PaletteMode): Promise<BrandPalette[]>;
}

// =============================================================================
// デフォルトリポジトリ（インメモリ）
// =============================================================================

/**
 * デフォルトのインメモリパレット
 * シードデータが利用できない場合のフォールバック
 */
const defaultPalettes: BrandPalette[] = [
  {
    id: '01939abc-def0-7000-8000-000000000001',
    brandId: 'reftrix-standard',
    brandName: 'Reftrix Standard',
    description: 'Reftrixのデフォルトブランドパレット',
    mode: 'light',
    tokens: {
      primary: {
        name: 'Primary Blue',
        description: '主要ブランドカラー',
        oklch: { l: 0.623, c: 0.214, h: 259.7 },
        hex: '#3B82F6',
        usage: ['accent', 'cta', 'link'],
      },
      secondary: {
        name: 'Secondary Indigo',
        oklch: { l: 0.585, c: 0.241, h: 279.0 },
        hex: '#6366F1',
        usage: ['accent'],
      },
      accent: {
        name: 'Accent Violet',
        oklch: { l: 0.586, c: 0.234, h: 293.0 },
        hex: '#8B5CF6',
        usage: ['highlight'],
      },
      neutral: {
        name: 'Neutral Gray',
        oklch: { l: 0.554, c: 0.022, h: 258.0 },
        hex: '#6B7280',
        usage: ['foreground'],
      },
      success: {
        name: 'Success Green',
        oklch: { l: 0.723, c: 0.213, h: 142.5 },
        hex: '#22C55E',
        usage: ['success'],
      },
      error: {
        name: 'Error Red',
        oklch: { l: 0.628, c: 0.258, h: 27.0 },
        hex: '#EF4444',
        usage: ['error'],
      },
    },
    gradients: [
      {
        id: 'primary-gradient',
        name: 'Primary Gradient',
        type: 'linear',
        angle: 135,
        stops: [
          { offset: 0, token: 'primary' },
          { offset: 100, token: 'accent' },
        ],
      },
    ],
    metadata: {
      version: '0.1.0',
      author: 'Reftrix Team',
      tags: ['modern', 'blue', 'professional'],
    },
    createdAt: new Date('2025-11-01T00:00:00Z'),
    updatedAt: new Date('2025-12-01T00:00:00Z'),
  },
  {
    id: '01939abc-def0-7000-8000-000000000002',
    brandId: 'reftrix-dark',
    brandName: 'Reftrix Dark',
    description: 'Reftrixのダークモードパレット',
    mode: 'dark',
    tokens: {
      primary: {
        name: 'Primary Blue Light',
        oklch: { l: 0.728, c: 0.18, h: 254.0 },
        hex: '#60A5FA',
        usage: ['accent', 'cta'],
      },
      secondary: {
        name: 'Secondary Indigo Light',
        oklch: { l: 0.695, c: 0.196, h: 277.0 },
        hex: '#818CF8',
        usage: ['accent'],
      },
    },
    createdAt: new Date('2025-11-01T00:00:00Z'),
    updatedAt: new Date('2025-12-01T00:00:00Z'),
  },
];

/**
 * デフォルトインメモリリポジトリ
 */
class DefaultPaletteRepository implements PaletteRepository {
  private palettes: BrandPalette[] = defaultPalettes;

  async findAll(): Promise<BrandPalette[]> {
    return this.palettes;
  }

  async findById(id: string): Promise<BrandPalette | null> {
    return this.palettes.find((p) => p.id === id) ?? null;
  }

  async findByBrandName(name: string): Promise<BrandPalette[]> {
    return this.palettes.filter((p) =>
      p.brandName.toLowerCase().includes(name.toLowerCase())
    );
  }

  async findByMode(mode: PaletteMode): Promise<BrandPalette[]> {
    return this.palettes.filter((p) => p.mode === mode || p.mode === 'both');
  }
}

// =============================================================================
// PaletteServiceクラス
// =============================================================================

const logger = createLogger('PaletteService');

/**
 * UUID形式を検証
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PaletteService - ブランドパレット取得サービス
 */
export class PaletteService {
  private repository: PaletteRepository;

  /**
   * コンストラクタ
   * @param repository - パレットリポジトリ（省略時はデフォルトリポジトリ）
   */
  constructor(repository?: PaletteRepository) {
    this.repository = repository ?? new DefaultPaletteRepository();
  }

  /**
   * パレットを取得
   * @param options - 取得オプション
   * @returns パレット取得結果
   */
  async getPalette(options: GetPaletteOptions): Promise<GetPaletteResult> {
    const {
      id,
      brand_name,
      mode = 'both',
      include_gradients = true,
      auto_generate_gradients = false,
      gradient_options,
    } = options;

    if (process.env.NODE_ENV === 'development') {
      logger.info('getPalette called', { id, brand_name, mode, include_gradients, auto_generate_gradients });
    }

    // ID指定の場合は詳細取得
    if (id !== undefined) {
      return this.getById(id, include_gradients, auto_generate_gradients, gradient_options);
    }

    // ブランド名検索または一覧取得
    if (brand_name !== undefined && brand_name !== '') {
      return this.search(brand_name, mode);
    }

    // 全件取得（モードフィルタリング適用）
    return this.list({ mode });
  }

  /**
   * ID指定でパレット詳細を取得
   * @param id - パレットID
   * @param includeGradients - グラデーションを含めるか
   * @param autoGenerateGradients - グラデーション自動生成を有効にするか
   * @param gradientOptions - グラデーション自動生成オプション
   * @returns パレット詳細
   */
  async getById(
    id: string,
    includeGradients: boolean = true,
    autoGenerateGradients: boolean = false,
    gradientOptions?: GradientAutoGenerateOptions
  ): Promise<GetPaletteResult> {
    // UUID形式の検証
    if (!UUID_REGEX.test(id)) {
      throw new McpError(
        ErrorCode.VALIDATION_ERROR,
        `CREATIVE_INVALID_PALETTE_ID: 無効なパレットID形式です: ${id}`
      );
    }

    const palette = await this.repository.findById(id);

    if (palette === null) {
      throw new McpError(
        ErrorCode.PALETTE_NOT_FOUND,
        `CREATIVE_PALETTE_NOT_FOUND: パレットが見つかりません: ${id}`
      );
    }

    const detail = this.toPaletteDetail(palette, includeGradients);

    // グラデーション自動生成
    if (autoGenerateGradients && includeGradients) {
      const generatedGradients = this.generateGradients(palette, gradientOptions);
      detail.gradients = [...(detail.gradients ?? []), ...generatedGradients];
    }

    return {
      palette: detail,
    };
  }

  /**
   * パレットのトークンからグラデーションを自動生成
   * @param palette - パレット
   * @param options - グラデーション生成オプション
   * @returns 生成されたグラデーション配列
   */
  private generateGradients(
    palette: BrandPalette,
    options?: GradientAutoGenerateOptions
  ): GradientApi[] {
    const gradients: GradientApi[] = [];
    const tokenNames = Object.keys(palette.tokens);
    const type = options?.type ?? 'linear';
    const angle = options?.angle ?? 135;

    // token_pairs が指定されている場合はそれを使用
    if (options?.token_pairs && options.token_pairs.length > 0) {
      for (const [fromToken, toToken] of options.token_pairs) {
        if (tokenNames.includes(fromToken) && tokenNames.includes(toToken)) {
          gradients.push(this.createGradient(fromToken, toToken, type, angle));
        }
      }
      return gradients;
    }

    // デフォルト: primary, secondary, accent から自動生成
    const primaryTokens = ['primary', 'secondary', 'accent'].filter(t => tokenNames.includes(t));

    if (primaryTokens.length >= 2) {
      // primary -> secondary
      if (tokenNames.includes('primary') && tokenNames.includes('secondary')) {
        gradients.push(this.createGradient('primary', 'secondary', type, angle));
      }
      // primary -> accent
      if (tokenNames.includes('primary') && tokenNames.includes('accent')) {
        gradients.push(this.createGradient('primary', 'accent', type, angle));
      }
      // secondary -> accent
      if (tokenNames.includes('secondary') && tokenNames.includes('accent')) {
        gradients.push(this.createGradient('secondary', 'accent', type, angle));
      }
    }

    return gradients;
  }

  /**
   * グラデーションを生成
   */
  private createGradient(
    fromToken: string,
    toToken: string,
    type: 'linear' | 'radial',
    angle: number
  ): GradientApi {
    const gradient: GradientApi = {
      id: `auto-${fromToken}-${toToken}`,
      name: `${this.capitalize(fromToken)} to ${this.capitalize(toToken)}`,
      type,
      stops: [
        { offset: 0, token: fromToken },
        { offset: 100, token: toToken },
      ],
      auto_generated: true,
    };

    if (type === 'linear') {
      gradient.angle = angle;
    } else {
      gradient.centerX = 0.5;
      gradient.centerY = 0.5;
    }

    return gradient;
  }

  /**
   * 文字列の最初の文字を大文字に
   */
  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * ブランド名で検索
   * @param brandName - 検索するブランド名
   * @param mode - モードフィルター
   * @returns パレット一覧
   */
  async search(brandName: string, mode: PaletteMode = 'both'): Promise<GetPaletteResult> {
    let palettes = await this.repository.findByBrandName(brandName);

    // モードでフィルタリング
    if (mode !== 'both') {
      palettes = palettes.filter((p) => p.mode === mode || p.mode === 'both');
    }

    return {
      palettes: palettes.map((p) => this.toPaletteListItem(p)),
    };
  }

  /**
   * パレット一覧を取得
   * @param options - 一覧取得オプション
   * @returns パレット一覧
   */
  async list(options?: { mode?: PaletteMode }): Promise<GetPaletteResult> {
    const mode = options?.mode ?? 'both';

    let palettes: BrandPalette[];

    if (mode === 'both') {
      palettes = await this.repository.findAll();
    } else {
      palettes = await this.repository.findByMode(mode);
    }

    return {
      palettes: palettes.map((p) => this.toPaletteListItem(p)),
    };
  }

  /**
   * BrandPaletteをPaletteListItemに変換
   */
  private toPaletteListItem(palette: BrandPalette): PaletteListItem {
    return {
      id: palette.id,
      brand_id: palette.brandId,
      brand_name: palette.brandName,
      mode: palette.mode,
      token_count: Object.keys(palette.tokens).length,
      description: palette.description,
    };
  }

  /**
   * BrandPaletteをPaletteDetailに変換
   */
  private toPaletteDetail(palette: BrandPalette, includeGradients: boolean): PaletteDetail {
    const detail: PaletteDetail = {
      id: palette.id,
      brand_id: palette.brandId,
      brand_name: palette.brandName,
      mode: palette.mode,
      tokens: this.convertTokens(palette.tokens),
      created_at: palette.createdAt.toISOString(),
      updated_at: palette.updatedAt.toISOString(),
    };

    if (palette.description !== undefined) {
      detail.description = palette.description;
    }

    if (includeGradients) {
      detail.gradients = this.convertGradients(palette.gradients);
    }

    return detail;
  }

  /**
   * トークンをAPI形式に変換
   */
  private convertTokens(
    tokens: Record<string, ColorToken>
  ): Record<string, ColorTokenApi> {
    const result: Record<string, ColorTokenApi> = {};

    for (const [key, token] of Object.entries(tokens)) {
      const apiToken: ColorTokenApi = {
        name: token.name,
        oklch: {
          l: token.oklch.l,
          c: token.oklch.c,
          h: token.oklch.h,
        },
        hex: token.hex,
      };

      if (token.description !== undefined) {
        apiToken.description = token.description;
      }

      if (token.usage !== undefined && token.usage.length > 0) {
        apiToken.usage = token.usage;
      }

      if (token.contrastWith !== undefined && token.contrastWith.length > 0) {
        apiToken.contrast_with = token.contrastWith.map(
          (c: ContrastRequirement) => ({
            token: c.token,
            min_ratio: c.minRatio,
          })
        );
      }

      result[key] = apiToken;
    }

    return result;
  }

  /**
   * グラデーションをAPI形式に変換
   */
  private convertGradients(
    gradients?: GradientDefinition[]
  ): GradientApi[] {
    if (gradients === undefined || gradients.length === 0) {
      return [];
    }

    return gradients.map((g) => {
      const apiGradient: GradientApi = {
        id: g.id,
        name: g.name,
        type: g.type,
        stops: g.stops.map((s) => {
          const stop: GradientApi['stops'][number] = {
            offset: s.offset,
          };
          if (s.token !== undefined) {
            stop.token = s.token;
          }
          if (s.color !== undefined) {
            stop.color = s.color;
          }
          if (s.opacity !== undefined) {
            stop.opacity = s.opacity;
          }
          return stop;
        }),
      };

      if (g.description !== undefined) {
        apiGradient.description = g.description;
      }

      if (g.angle !== undefined) {
        apiGradient.angle = g.angle;
      }

      if (g.centerX !== undefined) {
        apiGradient.centerX = g.centerX;
      }

      if (g.centerY !== undefined) {
        apiGradient.centerY = g.centerY;
      }

      return apiGradient;
    });
  }
}

export default PaletteService;

// =============================================================================
// ファクトリ関数
// =============================================================================

/**
 * データベースリポジトリを使用するPaletteServiceを作成
 * @param prisma - Prismaクライアント
 * @returns PaletteService
 */
export function createPaletteServiceWithDb(prisma: PrismaClient): PaletteService {
  const repository = new PrismaPaletteRepository(prisma);
  return new PaletteService(repository);
}
