// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Template Engine Types
 *
 * テンプレートエンジン用の型定義
 *
 * @module @reftrix/webdesign-core/types/template
 */

import { z } from 'zod';
import type { DetectedSection, SectionType } from './section.types';

// =====================================
// Framework Types
// =====================================

/**
 * サポートするフレームワーク
 */
export const FrameworkSchema = z.enum(['react', 'nextjs', 'html']);
export type Framework = z.infer<typeof FrameworkSchema>;

/**
 * スタイリング方法
 */
export const StylingMethodSchema = z.enum([
  'tailwind',
  'css-modules',
  'styled-components',
  'css-vars',
]);
export type StylingMethod = z.infer<typeof StylingMethodSchema>;

// =====================================
// Code Generator Options
// =====================================

/**
 * コード生成オプション
 */
export const CodeGeneratorOptionsSchema = z.object({
  /** フレームワーク */
  framework: FrameworkSchema,
  /** TypeScript使用 */
  typescript: z.boolean().optional().default(true),
  /** スタイリング方法 */
  styling: StylingMethodSchema.optional().default('tailwind'),
  /** コンポーネント名 */
  componentName: z.string().optional(),
  /** コメント含む */
  includeComments: z.boolean().optional().default(false),
});
export type CodeGeneratorOptions = z.infer<typeof CodeGeneratorOptionsSchema>;

// =====================================
// Color Info
// =====================================

/**
 * 色使用方法
 */
export const ColorUsageSchema = z.enum(['background', 'text', 'border', 'accent']);
export type ColorUsage = z.infer<typeof ColorUsageSchema>;

/**
 * RGB色
 */
export const RgbColorSchema = z.object({
  r: z.number().int().min(0).max(255),
  g: z.number().int().min(0).max(255),
  b: z.number().int().min(0).max(255),
});
export type RgbColor = z.infer<typeof RgbColorSchema>;

/**
 * 色情報
 */
export const ColorInfoSchema = z.object({
  /** HEX色 */
  hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  /** RGB色 */
  rgb: RgbColorSchema,
  /** 使用方法 */
  usage: ColorUsageSchema,
  /** 使用回数 */
  count: z.number().int().nonnegative(),
});
export type ColorInfo = z.infer<typeof ColorInfoSchema>;

// =====================================
// Typography Info
// =====================================

/**
 * タイポグラフィ情報
 */
export const TypographyInfoSchema = z.object({
  /** フォントファミリー */
  fontFamily: z.string(),
  /** フォントサイズ（px） */
  fontSize: z.number().positive(),
  /** フォントウェイト */
  fontWeight: z.number().int().min(100).max(900),
  /** 行の高さ */
  lineHeight: z.number().positive().optional(),
  /** 字間 */
  letterSpacing: z.number().optional(),
});
export type TypographyInfo = z.infer<typeof TypographyInfoSchema>;

// =====================================
// Template Context
// =====================================

/**
 * テンプレートコンテキスト
 * テンプレートレンダリング時に使用する変数コンテキスト
 */
export interface TemplateContext {
  /** 検出されたセクション */
  section: DetectedSection;
  /** コード生成オプション */
  options: CodeGeneratorOptions;
  /** 色情報 */
  colors?: ColorInfo[];
  /** タイポグラフィ情報 */
  typography?: TypographyInfo;
  /** その他カスタム変数 */
  [key: string]: unknown;
}

// =====================================
// Template
// =====================================

/**
 * テンプレート定義
 */
export interface Template {
  /** テンプレートID（一意） */
  id: string;
  /** 対象セクションタイプ */
  sectionType: SectionType;
  /** 対象フレームワーク */
  framework: Framework;
  /** テンプレートコンテンツ */
  content: string;
  /** デフォルトコンテキスト */
  defaultContext?: Partial<TemplateContext>;
}

/**
 * テンプレート登録情報
 */
export const TemplateRegistryInfoSchema = z.object({
  /** テンプレートID */
  id: z.string(),
  /** セクションタイプ */
  sectionType: z.string(),
  /** フレームワーク */
  framework: FrameworkSchema,
});
export type TemplateRegistryInfo = z.infer<typeof TemplateRegistryInfoSchema>;

// =====================================
// Template Rendering Result
// =====================================

/**
 * テンプレートレンダリング結果
 */
export const TemplateRenderResultSchema = z.object({
  /** レンダリングされたコード */
  code: z.string(),
  /** 使用したテンプレートID */
  templateId: z.string(),
  /** レンダリング時間（ms） */
  renderTimeMs: z.number().nonnegative().optional(),
});
export type TemplateRenderResult = z.infer<typeof TemplateRenderResultSchema>;
