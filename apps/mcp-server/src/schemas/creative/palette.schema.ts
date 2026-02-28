// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BrandPalette Zodスキーマ
 * ブランドパレット関連のZodバリデーションスキーマ
 *
 * 参照: docs/plans/mcptools/01/04-data-models.md
 */

import { z } from 'zod';

// =============================================================================
// OKLCH 色空間スキーマ
// =============================================================================

/**
 * OKLCH色空間スキーマ
 * L: 明度 (0-1)
 * C: 彩度 (0-0.4、実用範囲)
 * H: 色相 (0-360)
 */
export const oklchColorSchema = z.object({
  l: z.number().min(0).max(1),
  c: z.number().min(0).max(0.4),
  h: z.number().min(0).max(360),
});

export type OklchColorInput = z.input<typeof oklchColorSchema>;
export type OklchColorOutput = z.output<typeof oklchColorSchema>;

// =============================================================================
// トークン用途スキーマ
// =============================================================================

/**
 * トークン用途スキーマ
 */
export const tokenUsageSchema = z.enum([
  'background',
  'foreground',
  'border',
  'accent',
  'cta',
  'link',
  'error',
  'success',
  'warning',
  'info',
  'highlight',
  'divider',
]);

export type TokenUsageInput = z.input<typeof tokenUsageSchema>;

// =============================================================================
// コントラスト要件スキーマ
// =============================================================================

/**
 * コントラスト要件スキーマ
 * WCAG基準に基づくコントラスト比（1:1 から 21:1）
 */
export const contrastRequirementSchema = z.object({
  token: z.string().min(1),
  minRatio: z.number().min(1).max(21),
});

export type ContrastRequirementInput = z.input<typeof contrastRequirementSchema>;

// =============================================================================
// カラートークンスキーマ
// =============================================================================

/**
 * HEXカラー形式の正規表現
 */
const hexColorRegex = /^#[0-9A-Fa-f]{6}$/;

/**
 * カラートークンスキーマ
 */
export const colorTokenSchema = z.object({
  name: z.string().min(1).max(50),
  description: z.string().max(200).optional(),
  oklch: oklchColorSchema,
  hex: z.string().regex(hexColorRegex, 'HEX color must be in #RRGGBB format'),
  usage: z.array(tokenUsageSchema).optional(),
  contrastWith: z.array(contrastRequirementSchema).optional(),
  overrides: z
    .object({
      light: z
        .object({
          oklch: oklchColorSchema.optional(),
          hex: z.string().regex(hexColorRegex).optional(),
        })
        .optional(),
      dark: z
        .object({
          oklch: oklchColorSchema.optional(),
          hex: z.string().regex(hexColorRegex).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type ColorTokenInput = z.input<typeof colorTokenSchema>;
export type ColorTokenOutput = z.output<typeof colorTokenSchema>;

// =============================================================================
// パレットモードスキーマ
// =============================================================================

/**
 * パレットモードスキーマ
 */
export const paletteModeSchema = z.enum(['light', 'dark', 'both']);

export type PaletteModeInput = z.input<typeof paletteModeSchema>;

// =============================================================================
// グラデーションスキーマ
// =============================================================================

/**
 * グラデーションストップスキーマ
 */
export const gradientStopSchema = z.object({
  offset: z.number().min(0).max(100),
  token: z.string().optional(),
  color: z.string().regex(hexColorRegex).optional(),
  opacity: z.number().min(0).max(1).optional(),
});

export type GradientStopInput = z.input<typeof gradientStopSchema>;

/**
 * グラデーション定義スキーマ
 */
export const gradientDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['linear', 'radial']),
  angle: z.number().min(0).max(360).optional(),
  centerX: z.number().min(0).max(1).optional(),
  centerY: z.number().min(0).max(1).optional(),
  stops: z.array(gradientStopSchema).min(2),
});

export type GradientDefinitionInput = z.input<typeof gradientDefinitionSchema>;

// =============================================================================
// パレットメタデータスキーマ
// =============================================================================

/**
 * パレットメタデータスキーマ
 */
export const paletteMetadataSchema = z.object({
  version: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
});

export type PaletteMetadataInput = z.input<typeof paletteMetadataSchema>;

// =============================================================================
// ブランドパレットスキーマ
// =============================================================================

/**
 * ブランドパレットスキーマ
 */
export const brandPaletteSchema = z.object({
  id: z.string().uuid(),
  brandId: z.string().min(1).max(100),
  brandName: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  mode: paletteModeSchema.default('both'),
  tokens: z.record(colorTokenSchema),
  gradients: z.array(gradientDefinitionSchema).optional(),
  metadata: paletteMetadataSchema.optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type BrandPaletteInput = z.input<typeof brandPaletteSchema>;
export type BrandPaletteOutput = z.output<typeof brandPaletteSchema>;
