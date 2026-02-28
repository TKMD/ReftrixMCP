// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * style.get_palette MCPツール用Zodスキーマ
 * ブランドパレット取得ツールの入力バリデーション
 *
 * @module tools/schemas/style-schemas
 */

import { z } from 'zod';

// =============================================================================
// パレットモード
// =============================================================================

/**
 * パレットモードスキーマ
 * - light: ライトモード専用
 * - dark: ダークモード専用
 * - both: 両モード対応
 */
export const paletteModeSchema = z.enum(['light', 'dark', 'both']);

// =============================================================================
// style.get_palette 入力スキーマ
// =============================================================================

/**
 * グラデーション自動生成オプションスキーマ
 * パレットのカラートークンに基づいてグラデーションを自動生成する際のオプション
 *
 * @property type - グラデーションタイプ（linear/radial）
 * @property angle - リニアグラデーションの角度（0-360）
 * @property token_pairs - 使用するトークンペアの配列（例: [["primary", "accent"]]）
 * @property include_complementary - 補色グラデーションを含めるか
 * @property include_analogous - 類似色グラデーションを含めるか
 */
export const gradientAutoGenerateOptionsSchema = z.object({
  type: z.enum(['linear', 'radial']).optional().default('linear'),
  angle: z.number().min(0).max(360).optional().default(135),
  token_pairs: z.array(z.tuple([z.string(), z.string()])).optional(),
  include_complementary: z.boolean().optional().default(false),
  include_analogous: z.boolean().optional().default(false),
});

/**
 * グラデーション自動生成オプションの型
 */
export type GradientAutoGenerateOptions = z.infer<typeof gradientAutoGenerateOptionsSchema>;

/**
 * style.get_palette ツールの入力スキーマ
 *
 * @property id - パレットID（UUID形式、オプション）
 * @property brand_name - ブランド名で部分一致検索（オプション）
 * @property mode - パレットモードフィルター（デフォルト: both）
 * @property include_gradients - グラデーションを含めるか（デフォルト: true）
 * @property auto_generate_gradients - グラデーション自動生成を有効にするか（デフォルト: false）
 * @property gradient_options - グラデーション自動生成オプション
 */
export const styleGetPaletteInputSchema = z.object({
  id: z
    .string()
    .uuid({ message: '有効なUUID形式のIDを指定してください' })
    .optional(),
  brand_name: z
    .string()
    .max(200, { message: 'ブランド名は200文字以下にしてください' })
    .optional(),
  mode: paletteModeSchema.optional().default('both'),
  include_gradients: z.boolean().optional().default(true),
  auto_generate_gradients: z.boolean().optional().default(false),
  gradient_options: gradientAutoGenerateOptionsSchema.optional(),
});

/**
 * style.get_palette ツールの入力型
 */
export type StyleGetPaletteInput = z.infer<typeof styleGetPaletteInputSchema>;
