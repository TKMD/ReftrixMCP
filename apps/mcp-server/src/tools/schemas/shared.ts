// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 共通スキーマ
 * 複数ツールで共有される基本Zodスキーマ定義
 *
 * @module tools/schemas/shared
 */

import { z } from 'zod';

// =============================================================================
// Summary Mode Utility
// =============================================================================

/**
 * summaryパラメータのデフォルト値を取得
 *
 * P1-PERF-3: LLM向け最適化
 * - 環境変数未設定/無効な値: true（LLMコンテキスト効率化のため）
 * - MCP_DEFAULT_SUMMARY_MODE='false': false（明示的に詳細レスポンス）
 * - MCP_DEFAULT_SUMMARY_MODE='true': true（明示的に軽量レスポンス）
 *
 * @returns summaryのデフォルト値
 */
export function getSummaryDefault(): boolean {
  const envValue = process.env.MCP_DEFAULT_SUMMARY_MODE;
  // 明示的に 'false' が設定された場合のみ false を返す
  // 未設定・'true'・その他の値は true（LLM最適化デフォルト）
  return envValue !== 'false';
}

// =============================================================================
// 2D座標スキーマ
// =============================================================================

/**
 * 2D座標スキーマ
 * 座標系では負の値も有効
 */
export const point2dSchema = z.object({
  /** X座標 */
  x: z.number().finite('x must be a finite number'),
  /** Y座標 */
  y: z.number().finite('y must be a finite number'),
});

export type Point2D = z.infer<typeof point2dSchema>;

// =============================================================================
// サイズスキーマ
// =============================================================================

/**
 * サイズスキーマ
 * 幅と高さは正の値（0より大きい）が必要
 */
export const sizeSchema = z.object({
  /** 幅（正の値） */
  width: z.number().positive('width must be a positive number'),
  /** 高さ（正の値） */
  height: z.number().positive('height must be a positive number'),
});

export type Size = z.infer<typeof sizeSchema>;

// =============================================================================
// バウンディングボックススキーマ
// =============================================================================

/**
 * バウンディングボックススキーマ
 * 負のx/y座標も有効、width/heightは0以上
 */
export const boundingBoxSchema = z.object({
  /** X座標（負の値も可） */
  x: z.number().finite('x must be a finite number'),
  /** Y座標（負の値も可） */
  y: z.number().finite('y must be a finite number'),
  /** 幅（0以上） */
  width: z.number().min(0, 'width must be non-negative'),
  /** 高さ（0以上） */
  height: z.number().min(0, 'height must be non-negative'),
});

export type BoundingBox = z.infer<typeof boundingBoxSchema>;

// =============================================================================
// HEXカラースキーマ
// =============================================================================

/**
 * HEXカラーの正規表現パターン
 * サポート形式:
 * - #RGB (3桁)
 * - #RRGGBB (6桁)
 * - #RRGGBBAA (8桁)
 */
const HEX_COLOR_REGEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

/**
 * HEXカラースキーマ
 * #RGB, #RRGGBB, #RRGGBBAA 形式をサポート
 */
export const hexColorSchema = z
  .string()
  .regex(HEX_COLOR_REGEX, 'Invalid HEX color format. Use #RGB, #RRGGBB, or #RRGGBBAA');

export type HexColor = z.infer<typeof hexColorSchema>;

// =============================================================================
// CSSカラースキーマ
// =============================================================================

/**
 * CSSカラーの正規表現パターン
 * サポート形式:
 * - HEX: #RGB, #RRGGBB, #RRGGBBAA
 * - rgb(): rgb(r, g, b) / rgb(r,g,b)
 * - rgba(): rgba(r, g, b, a)
 * - hsl(): hsl(h, s%, l%)
 * - hsla(): hsla(h, s%, l%, a)
 * - キーワード: currentColor, transparent, inherit
 * - CSS変数: var(--name)
 */
const CSS_COLOR_PATTERNS = [
  // HEX形式
  /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/,
  // rgb()形式
  /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/,
  // rgba()形式
  /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*([01]?\.?\d*)\s*\)$/,
  // hsl()形式
  /^hsl\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*\)$/,
  // hsla()形式
  /^hsla\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*,\s*([01]?\.?\d*)\s*\)$/,
  // キーワード
  /^(currentColor|transparent|inherit)$/,
  // CSS変数
  /^var\(--[a-zA-Z0-9_-]+\)$/,
];

/**
 * CSSカラースキーマ
 * HEX, rgb, rgba, hsl, hsla, キーワード, CSS変数をサポート
 */
export const cssColorSchema = z
  .string()
  .min(1, 'CSS color must not be empty')
  .refine(
    (value) => CSS_COLOR_PATTERNS.some((pattern) => pattern.test(value)),
    {
      message:
        'Invalid CSS color format. Supported formats: HEX (#RGB, #RRGGBB, #RRGGBBAA), rgb(), rgba(), hsl(), hsla(), currentColor, transparent, inherit, var(--name)',
    }
  );

export type CssColor = z.infer<typeof cssColorSchema>;

// =============================================================================
// 処理メタデータスキーマ
// =============================================================================

/**
 * 処理メタデータスキーマ
 * ツール実行結果に付与するメタ情報
 */
export const processingMetaSchema = z.object({
  /** 処理時間（ミリ秒、0以上の有限数） */
  processingTimeMs: z
    .number()
    .finite('processingTimeMs must be a finite number')
    .min(0, 'processingTimeMs must be non-negative'),
  /** 警告メッセージ配列（オプション） */
  warnings: z.array(z.string()).optional(),
});

export type ProcessingMeta = z.infer<typeof processingMetaSchema>;
