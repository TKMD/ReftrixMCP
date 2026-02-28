// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BrandPalette 型定義
 * Reftrix Creative Tools のカラーパレット関連の型定義
 *
 * 参照: docs/plans/mcptools/01/04-data-models.md
 */

// =============================================================================
// OKLCH 色空間
// =============================================================================

/**
 * OKLCH色空間での色表現
 * L: 明度 (0-1)
 * C: 彩度 (0-0.4、実用範囲)
 * H: 色相 (0-360)
 */
export interface OklchColor {
  l: number;
  c: number;
  h: number;
}

// =============================================================================
// トークン用途
// =============================================================================

/**
 * カラートークンの用途（どこで使用されるか）
 */
export type TokenUsage =
  | 'background'
  | 'foreground'
  | 'border'
  | 'accent'
  | 'cta'
  | 'link'
  | 'error'
  | 'success'
  | 'warning'
  | 'info'
  | 'highlight'
  | 'divider';

// =============================================================================
// コントラスト要件
// =============================================================================

/**
 * 別のトークンとのコントラスト比要件
 * WCAG AA: 4.5:1（通常テキスト）, 3:1（大テキスト）
 * WCAG AAA: 7:1（通常テキスト）, 4.5:1（大テキスト）
 */
export interface ContrastRequirement {
  /** 対象となるトークン名 */
  token: string;
  /** 最小コントラスト比（1:1 から 21:1）*/
  minRatio: number;
}

// =============================================================================
// カラートークン
// =============================================================================

/**
 * カラートークンの定義
 * パレット内の個々の色を定義する
 */
export interface ColorToken {
  /** トークン名（例: "Primary", "Background"）*/
  name: string;
  /** 説明（オプション、最大200文字）*/
  description?: string;
  /** OKLCH色空間での色値 */
  oklch: OklchColor;
  /** HEXカラーコード（#RRGGBB形式）*/
  hex: string;
  /** このトークンの用途（オプション）*/
  usage?: TokenUsage[];
  /** 他トークンとのコントラスト要件（オプション）*/
  contrastWith?: ContrastRequirement[];
  /** ライト/ダークモードでの上書き（オプション）*/
  overrides?: {
    light?: {
      oklch?: OklchColor;
      hex?: string;
    };
    dark?: {
      oklch?: OklchColor;
      hex?: string;
    };
  };
}

// =============================================================================
// パレットモード
// =============================================================================

/**
 * パレットモード
 * - light: ライトモード専用
 * - dark: ダークモード専用
 * - both: 両モード対応
 */
export type PaletteMode = 'light' | 'dark' | 'both';

// =============================================================================
// グラデーション
// =============================================================================

/**
 * グラデーションストップ
 */
export interface GradientStop {
  /** オフセット位置（0-100）*/
  offset: number;
  /** トークン名（tokenまたはcolorのどちらか）*/
  token?: string;
  /** HEXカラー（tokenまたはcolorのどちらか）*/
  color?: string;
  /** 透明度（0-1）*/
  opacity?: number;
}

/**
 * グラデーション定義
 */
export interface GradientDefinition {
  /** グラデーションID */
  id: string;
  /** グラデーション名 */
  name: string;
  /** 説明（オプション）*/
  description?: string;
  /** グラデーションタイプ */
  type: 'linear' | 'radial';
  /** リニアグラデーションの角度（0-360）*/
  angle?: number;
  /** ラジアルグラデーションの中心X（0-1）*/
  centerX?: number;
  /** ラジアルグラデーションの中心Y（0-1）*/
  centerY?: number;
  /** グラデーションストップ（最低2つ）*/
  stops: GradientStop[];
}

// =============================================================================
// パレットメタデータ
// =============================================================================

/**
 * パレットのメタデータ
 */
export interface PaletteMetadata {
  /** バージョン */
  version?: string;
  /** 作成者 */
  author?: string;
  /** タグ */
  tags?: string[];
  /** ソースURL */
  source?: string;
}

// =============================================================================
// ブランドパレット
// =============================================================================

/**
 * ブランドパレット
 * ブランドの完全なカラーパレット定義
 */
export interface BrandPalette {
  /** UUID形式のID */
  id: string;
  /** ブランドID（識別子）*/
  brandId: string;
  /** ブランド名 */
  brandName: string;
  /** 説明（オプション、最大1000文字）*/
  description?: string;
  /** パレットモード */
  mode: PaletteMode;
  /** カラートークンのレコード */
  tokens: Record<string, ColorToken>;
  /** グラデーション定義（オプション）*/
  gradients?: GradientDefinition[];
  /** メタデータ（オプション）*/
  metadata?: PaletteMetadata;
  /** 作成日時 */
  createdAt: Date;
  /** 更新日時 */
  updatedAt: Date;
}
