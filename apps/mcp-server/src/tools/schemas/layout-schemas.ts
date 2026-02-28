// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * composer.layout 入力/出力 Zodスキーマ定義
 *
 * 複数要素をテンプレートに基づいて配置するMCPツールのスキーマ
 * 注意: 現在未使用のレガシースキーマです（将来の拡張用に保持）
 *
 * @module tools/schemas/layout-schemas
 */

import { z } from 'zod';

// =============================================================================
// アンカーポイント定義
// =============================================================================

/**
 * アンカーポイントスキーマ
 * スロット内での配置基準点を指定
 */
export const anchorSchema = z.enum([
  'center',
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]);

export type Anchor = z.infer<typeof anchorSchema>;

// =============================================================================
// レイアウトスロット定義
// =============================================================================

/**
 * レイアウトスロットスキーマ
 * テンプレート内の配置位置を定義
 */
export const layoutSlotSchema = z.object({
  /** スロットID */
  id: z.string().min(1),
  /** X位置（パーセント or ピクセル） */
  x: z.string(),
  /** Y位置（パーセント or ピクセル） */
  y: z.string(),
  /** 幅（パーセント or ピクセル） */
  width: z.string(),
  /** 高さ（パーセント or ピクセル） */
  height: z.string(),
  /** アンカーポイント（デフォルト: center） */
  anchor: anchorSchema.optional().default('center'),
});

export type LayoutSlot = z.infer<typeof layoutSlotSchema>;

// =============================================================================
// レイアウト制約定義
// =============================================================================

/**
 * アライメントスキーマ
 */
export const alignmentSchema = z.enum([
  'left',
  'center',
  'right',
  'justify',
]);

export type Alignment = z.infer<typeof alignmentSchema>;

/**
 * レイアウト制約スキーマ
 * テンプレートの制約条件を定義
 */
export const layoutConstraintsSchema = z.object({
  /** アスペクト比（例: '16:9', '4:3'） */
  aspectRatio: z.string().regex(/^\d+:\d+$/).optional(),
  /** 最小幅（ピクセル） */
  minWidth: z.number().int().positive().optional(),
  /** 最大幅（ピクセル） */
  maxWidth: z.number().int().positive().optional(),
  /** カラム数の選択肢（例: [2, 3]） */
  columns: z.array(z.number().int().positive()).optional(),
  /** 行数の選択肢（例: [2]） */
  rows: z.array(z.number().int().positive()).optional(),
  /** アイコン数の選択肢（例: [3, 4, 5]） */
  iconCount: z.array(z.number().int().positive()).optional(),
  /** 配置アライメント */
  alignment: alignmentSchema.optional(),
});

export type LayoutConstraints = z.infer<typeof layoutConstraintsSchema>;

// =============================================================================
// レイアウトテンプレート定義
// =============================================================================

/**
 * レイアウトテンプレートスキーマ
 */
export const layoutTemplateSchema = z.object({
  /** テンプレートID */
  id: z.string().min(1),
  /** テンプレート名 */
  name: z.string().min(1),
  /** テンプレートの説明 */
  description: z.string().optional(),
  /** スロット定義 */
  slots: z.array(layoutSlotSchema).min(1),
  /** 制約条件 */
  constraints: layoutConstraintsSchema.optional(),
});

export type LayoutTemplate = z.infer<typeof layoutTemplateSchema>;

// =============================================================================
// 初期テンプレート定義
// =============================================================================

/**
 * 初期テンプレートID
 */
export const initialTemplateIdSchema = z.enum([
  'hero-illustration',
  'feature-grid',
  'icon-row',
]);

export type InitialTemplateId = z.infer<typeof initialTemplateIdSchema>;

/**
 * 初期テンプレート定義
 */
export const INITIAL_TEMPLATES: LayoutTemplate[] = [
  {
    id: 'hero-illustration',
    name: 'Hero Illustration',
    description: '左テキスト＋右イラスト or 中央イラスト',
    slots: [
      {
        id: 'illustration',
        x: '60%',
        y: '50%',
        width: '40%',
        height: '80%',
        anchor: 'center',
      },
    ],
    constraints: {
      aspectRatio: '16:9',
      minWidth: 1200,
    },
  },
  {
    id: 'feature-grid',
    name: 'Feature Grid',
    description: '2x2 / 3x2 のアイコン＋テキスト配置',
    slots: [
      { id: 'slot-1', x: '16.67%', y: '25%', width: '25%', height: '40%', anchor: 'center' },
      { id: 'slot-2', x: '50%', y: '25%', width: '25%', height: '40%', anchor: 'center' },
      { id: 'slot-3', x: '83.33%', y: '25%', width: '25%', height: '40%', anchor: 'center' },
      { id: 'slot-4', x: '16.67%', y: '75%', width: '25%', height: '40%', anchor: 'center' },
      { id: 'slot-5', x: '50%', y: '75%', width: '25%', height: '40%', anchor: 'center' },
      { id: 'slot-6', x: '83.33%', y: '75%', width: '25%', height: '40%', anchor: 'center' },
    ],
    constraints: {
      columns: [2, 3],
      rows: [2],
    },
  },
  {
    id: 'icon-row',
    name: 'Icon Row',
    description: '横一列に3〜5アイコン整列',
    slots: [
      { id: 'icon-1', x: '10%', y: '50%', width: '15%', height: '80%', anchor: 'center' },
      { id: 'icon-2', x: '30%', y: '50%', width: '15%', height: '80%', anchor: 'center' },
      { id: 'icon-3', x: '50%', y: '50%', width: '15%', height: '80%', anchor: 'center' },
      { id: 'icon-4', x: '70%', y: '50%', width: '15%', height: '80%', anchor: 'center' },
      { id: 'icon-5', x: '90%', y: '50%', width: '15%', height: '80%', anchor: 'center' },
    ],
    constraints: {
      iconCount: [3, 4, 5],
      alignment: 'center',
    },
  },
];

// =============================================================================
// 配置オプション定義
// =============================================================================

/**
 * 配置オプションスキーマ
 */
export const layoutOptionsSchema = z.object({
  /** 出力幅（ピクセル） */
  width: z.number().int().positive().optional(),
  /** 出力高さ（ピクセル） */
  height: z.number().int().positive().optional(),
  /** パディング（ピクセル、デフォルト: 0） */
  padding: z.number().int().min(0).optional().default(0),
  /** 背景色（HEX形式） */
  background: z.string().regex(/^#[0-9A-Fa-f]{3,8}$/).optional(),
});

export type LayoutOptions = z.infer<typeof layoutOptionsSchema>;

// =============================================================================
// 入力スキーマ
// =============================================================================

/**
 * composer.layout 入力スキーマ
 */
export const composerLayoutInputSchema = z.object({
  /** アセットID配列（UUID形式、1-20件） */
  asset_ids: z
    .array(z.string().uuid('無効なID形式です'))
    .min(1, 'asset_idsは1つ以上指定してください')
    .max(20, 'asset_idsは20個以下にしてください'),

  /** テンプレートID */
  template_id: z.string().min(1, 'template_idは必須です'),

  /** 配置オプション */
  options: layoutOptionsSchema.optional(),
});

export type ComposerLayoutInput = z.infer<typeof composerLayoutInputSchema>;

// =============================================================================
// 配置結果定義
// =============================================================================

/**
 * 位置スキーマ
 */
export const positionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export type Position = z.infer<typeof positionSchema>;

/**
 * サイズスキーマ
 */
export const sizeSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});

export type Size = z.infer<typeof sizeSchema>;

/**
 * 配置結果スキーマ
 */
export const placementSchema = z.object({
  /** 配置されたスロットID */
  slot_id: z.string(),
  /** 配置されたアセットID */
  asset_id: z.string().uuid(),
  /** 配置位置（ピクセル） */
  position: positionSchema,
  /** 配置サイズ（ピクセル） */
  size: sizeSchema,
});

export type Placement = z.infer<typeof placementSchema>;

// =============================================================================
// 出力スキーマ
// =============================================================================

/**
 * テンプレート情報スキーマ
 */
export const templateInfoSchema = z.object({
  /** テンプレートID */
  id: z.string(),
  /** テンプレート名 */
  name: z.string(),
});

export type TemplateInfo = z.infer<typeof templateInfoSchema>;

/**
 * composer.layout 出力スキーマ
 */
export const composerLayoutOutputSchema = z.object({
  /** 配置済み出力 */
  output: z.string(),
  /** 使用されたテンプレート情報 */
  template: templateInfoSchema,
  /** 各アセットの配置情報 */
  placements: z.array(placementSchema),
  /** 変換時間（ミリ秒） */
  conversionTimeMs: z.number().min(0),
});

export type ComposerLayoutOutput = z.infer<typeof composerLayoutOutputSchema>;

// =============================================================================
// エラーコード定義
// =============================================================================

/**
 * composer.layout エラーコード
 */
export const LAYOUT_ERROR_CODES = {
  /** 無効なテンプレートID */
  INVALID_TEMPLATE: 'LAYOUT_INVALID_TEMPLATE',
  /** アセット取得失敗 */
  ASSET_NOT_FOUND: 'LAYOUT_ASSET_NOT_FOUND',
  /** アセット数がテンプレートのスロット数と合わない */
  ASSET_COUNT_MISMATCH: 'LAYOUT_ASSET_COUNT_MISMATCH',
  /** アセット数が不足 */
  ASSET_COUNT_INSUFFICIENT: 'LAYOUT_ASSET_COUNT_INSUFFICIENT',
  /** 無効なアセットID形式 */
  INVALID_ASSET_ID: 'LAYOUT_INVALID_ASSET_ID',
  /** 制約違反 */
  CONSTRAINT_VIOLATION: 'LAYOUT_CONSTRAINT_VIOLATION',
  /** パースエラー */
  PARSE_ERROR: 'LAYOUT_PARSE_ERROR',
  /** 内部エラー */
  INTERNAL_ERROR: 'LAYOUT_INTERNAL_ERROR',
} as const;

export type LayoutErrorCode = (typeof LAYOUT_ERROR_CODES)[keyof typeof LAYOUT_ERROR_CODES];
