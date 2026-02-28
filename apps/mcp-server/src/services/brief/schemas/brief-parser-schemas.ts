// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BriefParser Zodスキーマ定義
 *
 * DESIGN_BRIEF.mdのパース結果を表す型定義
 *
 * @module services/brief/schemas/brief-parser-schemas
 */
import { z } from 'zod';

// =============================================================================
// NG表現スキーマ
// =============================================================================

/**
 * NG表現スキーマ
 * Anti-AI Expression List や NG Examples から抽出される表現
 */
export const ngExpressionSchema = z.object({
  /** NG表現のキーワード/パターン */
  expression: z.string().min(1),
  /** なぜNGなのか */
  reason: z.string().min(1),
  /** 代替表現（任意） */
  alternative: z.string().optional(),
});

export type NgExpression = z.infer<typeof ngExpressionSchema>;

// =============================================================================
// OK表現スキーマ
// =============================================================================

/**
 * OK表現スキーマ
 * OK Examples から抽出される推奨表現
 */
export const okExpressionSchema = z.object({
  /** OK表現のキーワード/パターン */
  expression: z.string().min(1),
  /** なぜOKなのか */
  reason: z.string().min(1),
});

export type OkExpression = z.infer<typeof okExpressionSchema>;

// =============================================================================
// カラートークンスキーマ
// =============================================================================

/**
 * カラートークンスキーマ
 * Color Palette テーブルから抽出されるトークン
 */
export const colorTokenSchema = z.object({
  /** トークン名（backtick除去済み） */
  name: z.string().min(1),
  /** 役割（Background Primary等） */
  role: z.string().optional(),
  /** HEXカラー値 */
  hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  /** OKLCHカラー値（参照用） */
  oklch: z.string().optional(),
  /** 使用用途 */
  usage: z.string().optional(),
});

export type ColorToken = z.infer<typeof colorTokenSchema>;

// =============================================================================
// 必要アセットスキーマ
// =============================================================================

/**
 * 必要アセットスキーマ
 * Asset Categories テーブルから抽出されるアセット要件
 */
export const requiredAssetSchema = z.object({
  /** カテゴリ（icon, illustration等） */
  category: z.string().min(1),
  /** 説明（Source列の内容） */
  description: z.string().min(1),
  /** 検索クエリの提案（Usage列の内容） */
  suggested_query: z.string().optional(),
});

export type RequiredAsset = z.infer<typeof requiredAssetSchema>;

// =============================================================================
// パース済みブリーフスキーマ
// =============================================================================

/**
 * パース済みブリーフスキーマ
 * BriefParserService.parse() の出力形式
 */
export const parsedBriefSchema = z.object({
  /** プロジェクト名（H1見出しから抽出） */
  project_name: z.string(),
  /** カラーパレット情報 */
  color_palette: z.object({
    /** カラートークン配列 */
    tokens: z.array(colorTokenSchema),
    /** Reftrixに登録済みのパレットID（任意） */
    palette_id: z.string().uuid().optional(),
  }),
  /** NG表現リスト */
  ng_expressions: z.array(ngExpressionSchema),
  /** OK表現リスト */
  ok_expressions: z.array(okExpressionSchema),
  /** 必要アセットリスト */
  required_assets: z.array(requiredAssetSchema),
  /** パース元ファイルパス（任意） */
  source_path: z.string().optional(),
  /** パース時刻（ISO 8601形式） */
  parsed_at: z.string().datetime(),
});

export type ParsedBrief = z.infer<typeof parsedBriefSchema>;

// =============================================================================
// パースオプションスキーマ
// =============================================================================

/**
 * パースオプションスキーマ
 */
export const parseOptionsSchema = z.object({
  /** パース元のファイルパス（メタデータ用） */
  sourcePath: z.string().optional(),
  /** 厳格モード: 必須セクションがない場合にエラー */
  strict: z.boolean().optional(),
});

/** パースオプション型（入力用） */
export type ParseOptions = z.input<typeof parseOptionsSchema>;
