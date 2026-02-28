// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.inspect MCPツールのZodスキーマと型定義
 *
 * HTML/Webページのレイアウト解析に使用するスキーマを定義します。
 *
 * 機能:
 * - セクションタイプ定義
 * - 入力/出力スキーマ
 * - セクション情報スキーマ
 * - 色情報スキーマ
 * - タイポグラフィスキーマ
 * - グリッドスキーマ
 *
 * @module tools/layout/inspect/inspect.schemas
 */

import { z } from 'zod';
import { visualDecorationsResultSchema } from './visual-extractors.schemas';
import { visionOptionsSchema } from '../../page/schemas';
// Re-export VisionOptions type for consumers of this module
export type { VisionOptions } from '../../page/schemas';

// =====================================================
// セクションタイプ定義
// =====================================================

/**
 * 検出可能なセクションタイプの値（as const）
 */
export const SECTION_TYPES = [
  'hero',
  'header',
  'navigation',
  'features',
  'testimonial',
  'pricing',
  'cta',
  'footer',
  'content',
  'gallery',
  'about',
  'contact',
  'faq',
  'team',
  'stats',
  'unknown',
] as const;

/**
 * 検出可能なセクションタイプ
 */
export type SectionType = (typeof SECTION_TYPES)[number];

/**
 * セクションタイプのZodスキーマ
 */
export const sectionTypeSchema = z.enum(SECTION_TYPES);

// =====================================================
// Zod スキーマ定義
// =====================================================

/**
 * layout.inspect 入力オプションスキーマ
 */
export const layoutInspectOptionsSchema = z.object({
  /** セクション検出を行うか（デフォルト: true） */
  detectSections: z.boolean().optional().default(true),
  /** 色情報抽出を行うか（デフォルト: true） */
  extractColors: z.boolean().optional().default(true),
  /** タイポグラフィ解析を行うか（デフォルト: true） */
  analyzeTypography: z.boolean().optional().default(true),
  /** グリッド検出を行うか（デフォルト: true） */
  detectGrid: z.boolean().optional().default(true),
  /** Vision APIを使用するか（デフォルト: false） */
  useVision: z.boolean().optional().default(false),
  /**
   * Vision CPU完走保証オプション
   *
   * Vision解析のタイムアウト、CPU強制、フォールバック設定を制御します。
   * useVision=true の場合に有効。
   *
   * @see apps/mcp-server/src/services/vision/hardware-detector.ts
   * @see apps/mcp-server/src/services/vision/timeout-calculator.ts
   * @see apps/mcp-server/src/services/vision/image-optimizer.ts
   */
  visionOptions: visionOptionsSchema,
});

/**
 * スクリーンショット入力スキーマ
 */
export const screenshotInputSchema = z.object({
  /** Base64エンコードされた画像データ */
  base64: z.string().min(100, 'Image data too short'),
  /** 画像のMIMEタイプ */
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).default('image/png'),
  /** 画像の幅（ピクセル、オプション） */
  width: z.number().int().positive().optional(),
  /** 画像の高さ（ピクセル、オプション） */
  height: z.number().int().positive().optional(),
});

/**
 * layout.inspect 入力スキーマ
 *
 * 3つの入力モードをサポート:
 * 1. id: WebPageテーブルからHTML取得
 * 2. html: HTML文字列を直接解析
 * 3. screenshot: スクリーンショット画像をVision APIで解析（Ollama LlamaVision使用）
 */
export const layoutInspectInputSchema = z
  .object({
    /** WebページID（UUID形式） */
    id: z.string().uuid().optional(),
    /** HTML文字列（直接入力） */
    html: z.string().min(1).optional(),
    /** スクリーンショット画像（Vision API解析用） */
    screenshot: screenshotInputSchema.optional(),
    /** 解析オプション */
    options: layoutInspectOptionsSchema.optional(),
  })
  .refine(
    (data) =>
      data.id !== undefined || data.html !== undefined || data.screenshot !== undefined,
    {
      message: 'Either id, html, or screenshot must be provided',
    }
  );

/**
 * ヘッディング情報スキーマ
 */
export const headingInfoSchema = z.object({
  /** 見出しレベル（1-6） */
  level: z.number().min(1).max(6),
  /** 見出しテキスト */
  text: z.string(),
});

/**
 * リンク情報スキーマ
 */
export const linkInfoSchema = z.object({
  /** リンクテキスト */
  text: z.string(),
  /** リンク先URL */
  href: z.string(),
});

/**
 * 画像情報スキーマ
 */
export const imageInfoSchema = z.object({
  /** 画像ソースURL */
  src: z.string(),
  /** 代替テキスト */
  alt: z.string().optional(),
});

/**
 * ボタン情報スキーマ
 */
export const buttonInfoSchema = z.object({
  /** ボタンテキスト */
  text: z.string(),
  /** ボタンタイプ（primary/secondary等） */
  type: z.string(),
});

/**
 * セクションコンテンツスキーマ
 */
export const sectionContentSchema = z.object({
  /** 見出し一覧 */
  headings: z.array(headingInfoSchema),
  /** 段落一覧 */
  paragraphs: z.array(z.string()),
  /** リンク一覧 */
  links: z.array(linkInfoSchema),
  /** 画像一覧 */
  images: z.array(imageInfoSchema),
  /** ボタン一覧 */
  buttons: z.array(buttonInfoSchema),
});

/**
 * セクションスタイルスキーマ
 */
export const sectionStyleSchema = z.object({
  /** 背景色（HEX形式） */
  backgroundColor: z.string().optional(),
  /** テキスト色（HEX形式） */
  textColor: z.string().optional(),
  /** グラデーションを含むか */
  hasGradient: z.boolean().optional(),
  /** 背景画像を含むか */
  hasImage: z.boolean().optional(),
});

/**
 * セクション位置スキーマ
 */
export const sectionPositionSchema = z.object({
  /** 開始Y座標 */
  startY: z.number(),
  /** 終了Y座標 */
  endY: z.number(),
  /** 高さ */
  height: z.number(),
});

/**
 * セクション情報スキーマ
 */
export const sectionInfoSchema = z.object({
  /** セクションID */
  id: z.string(),
  /** セクションタイプ */
  type: sectionTypeSchema,
  /** 検出信頼度（0-1） */
  confidence: z.number().min(0).max(1),
  /** 位置情報 */
  position: sectionPositionSchema,
  /** コンテンツ情報 */
  content: sectionContentSchema,
  /** スタイル情報 */
  style: sectionStyleSchema,
});

/**
 * カラーパレット項目スキーマ
 */
export const colorPaletteItemSchema = z.object({
  /** HEXカラーコード（#RRGGBB形式） */
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** 出現回数 */
  count: z.number(),
  /** 色の役割（primary/secondary/background/text等） */
  role: z.string().optional(),
});

/**
 * カラー情報スキーマ
 */
export const colorPaletteInfoSchema = z.object({
  /** カラーパレット */
  palette: z.array(colorPaletteItemSchema),
  /** ドミナントカラー */
  dominant: z.string(),
  /** 背景色 */
  background: z.string(),
  /** テキスト色 */
  text: z.string(),
  /** アクセントカラー */
  accent: z.string().optional(),
});

/**
 * フォント情報スキーマ
 */
export const fontInfoSchema = z.object({
  /** フォントファミリー名 */
  family: z.string(),
  /** 使用されているウェイト一覧 */
  weights: z.array(z.number()),
});

/**
 * タイポグラフィ情報スキーマ
 */
export const typographyInfoSchema = z.object({
  /** 使用フォント一覧 */
  fonts: z.array(fontInfoSchema),
  /** 見出しサイズスケール（h1-h6） */
  headingScale: z.array(z.number()),
  /** 本文フォントサイズ（px） */
  bodySize: z.number(),
  /** 行間（unitless or px） */
  lineHeight: z.number(),
});

/**
 * ブレイクポイントスキーマ
 */
export const breakpointSchema = z.object({
  /** ブレイクポイント名（xs/sm/md/lg等） */
  name: z.string(),
  /** 最小幅（px） */
  minWidth: z.number(),
});

/**
 * グリッド情報スキーマ
 */
export const gridInfoSchema = z.object({
  /** グリッドタイプ（flex/grid/float/unknown） */
  type: z.enum(['flex', 'grid', 'float', 'unknown']),
  /** カラム数 */
  columns: z.number().optional(),
  /** ガター幅（px） */
  gutterWidth: z.number().optional(),
  /** 最大幅（px） */
  maxWidth: z.number().optional(),
  /** ブレイクポイント一覧 */
  breakpoints: z.array(breakpointSchema).optional(),
});

/**
 * Vision解析結果スキーマ（簡易版）
 */
export const visionFeaturesSchema = z.object({
  /** 解析成功フラグ */
  success: z.boolean(),
  /** 検出された特徴一覧 */
  features: z.array(z.unknown()),
  /** エラーメッセージ */
  error: z.string().optional(),
  /** 処理時間（ms） */
  processingTimeMs: z.number(),
  /** 使用モデル名 */
  modelName: z.string(),
});

// =====================================================
// Video/メディア要素スキーマ
// =====================================================

/**
 * Video再生制御属性スキーマ
 */
export const videoAttributesSchema = z.object({
  /** 自動再生 */
  autoplay: z.boolean().optional(),
  /** ループ再生 */
  loop: z.boolean().optional(),
  /** ミュート */
  muted: z.boolean().optional(),
  /** インライン再生（iOS対応） */
  playsinline: z.boolean().optional(),
  /** コントロール表示 */
  controls: z.boolean().optional(),
});

/**
 * Videoソース情報スキーマ
 */
export const videoSourceSchema = z.object({
  /** ソースURL */
  src: z.string(),
  /** MIMEタイプ（例: video/mp4, video/webm） */
  type: z.string().optional(),
});

/**
 * Video配置タイプ
 * - absolute-background: position: absolute + z-index: -1（セクション背景）
 * - fixed-background: position: fixed + z-index: -1（ページ全体背景）
 * - inline: 通常のインラインvideo
 */
export const videoPositioningSchema = z.enum([
  'absolute-background',
  'fixed-background',
  'inline',
]);

/**
 * Video要素情報スキーマ
 */
export const videoInfoSchema = z.object({
  /** CSSセレクタ */
  selector: z.string(),
  /** video要素のsrc属性（source要素を使う場合は空文字列） */
  src: z.string().optional(),
  /** source要素一覧 */
  sources: z.array(videoSourceSchema).optional(),
  /** poster画像URL */
  poster: z.string().optional(),
  /** 再生制御属性 */
  attributes: videoAttributesSchema.optional(),
  /** 配置パターン */
  positioning: videoPositioningSchema.optional(),
});

/**
 * メディア要素コレクションスキーマ
 */
export const mediaElementsSchema = z.object({
  /** すべてのvideo要素 */
  videos: z.array(videoInfoSchema),
  /** 背景動画のみ（positioning が *-background のもの） */
  backgroundVideos: z.array(videoInfoSchema),
});

/**
 * 解析データスキーマ
 */
export const layoutInspectDataSchema = z.object({
  /** WebページID（DB取得時） */
  id: z.string().uuid().optional(),
  /** 検出されたセクション一覧 */
  sections: z.array(sectionInfoSchema),
  /** 色情報 */
  colors: colorPaletteInfoSchema,
  /** タイポグラフィ情報 */
  typography: typographyInfoSchema,
  /** グリッド情報 */
  grid: gridInfoSchema,
  /** メディア要素（video等） */
  mediaElements: mediaElementsSchema.optional(),
  /** Vision解析結果 */
  visionFeatures: visionFeaturesSchema.optional(),
  /** 視覚的装飾要素（glow, gradient, animated-border, glass-morphism） */
  visualDecorations: visualDecorationsResultSchema.optional(),
  /** テキスト表現（Embedding用） */
  textRepresentation: z.string(),
});

/**
 * エラースキーマ
 */
export const layoutInspectErrorSchema = z.object({
  /** エラーコード */
  code: z.string(),
  /** エラーメッセージ */
  message: z.string(),
});

/**
 * layout.inspect 出力スキーマ
 */
export const layoutInspectOutputSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    data: layoutInspectDataSchema,
  }),
  z.object({
    success: z.literal(false),
    error: layoutInspectErrorSchema,
  }),
]);

// =====================================================
// 型定義（スキーマからの推論）
// =====================================================

/** layout.inspect 入力型 */
export type LayoutInspectInput = z.infer<typeof layoutInspectInputSchema>;

/** layout.inspect 出力型 */
export type LayoutInspectOutput = z.infer<typeof layoutInspectOutputSchema>;

/** layout.inspect 入力オプション型 */
export type LayoutInspectOptions = z.infer<typeof layoutInspectOptionsSchema>;

/** セクション情報型 */
export type SectionInfo = z.infer<typeof sectionInfoSchema>;

/** セクションコンテンツ型 */
export type SectionContent = z.infer<typeof sectionContentSchema>;

/** セクションスタイル型 */
export type SectionStyle = z.infer<typeof sectionStyleSchema>;

/** セクション位置型 */
export type SectionPosition = z.infer<typeof sectionPositionSchema>;

/** カラーパレット情報型 */
export type ColorPaletteInfo = z.infer<typeof colorPaletteInfoSchema>;

/** カラーパレット項目型 */
export type ColorPaletteItem = z.infer<typeof colorPaletteItemSchema>;

/** タイポグラフィ情報型 */
export type TypographyInfo = z.infer<typeof typographyInfoSchema>;

/** フォント情報型 */
export type FontInfo = z.infer<typeof fontInfoSchema>;

/** グリッド情報型 */
export type GridInfo = z.infer<typeof gridInfoSchema>;

/** ブレイクポイント型 */
export type Breakpoint = z.infer<typeof breakpointSchema>;

/** 解析データ型 */
export type LayoutInspectData = z.infer<typeof layoutInspectDataSchema>;

/** エラー型 */
export type LayoutInspectError = z.infer<typeof layoutInspectErrorSchema>;

/** 見出し情報型 */
export type HeadingInfo = z.infer<typeof headingInfoSchema>;

/** リンク情報型 */
export type LinkInfo = z.infer<typeof linkInfoSchema>;

/** 画像情報型 */
export type ImageInfo = z.infer<typeof imageInfoSchema>;

/** ボタン情報型 */
export type ButtonInfo = z.infer<typeof buttonInfoSchema>;

/** Vision解析結果型 */
export type VisionFeatures = z.infer<typeof visionFeaturesSchema>;

/** Video再生制御属性型 */
export type VideoAttributes = z.infer<typeof videoAttributesSchema>;

/** Videoソース情報型 */
export type VideoSource = z.infer<typeof videoSourceSchema>;

/** Video配置タイプ */
export type VideoPositioning = z.infer<typeof videoPositioningSchema>;

/** Video要素情報型 */
export type VideoInfo = z.infer<typeof videoInfoSchema>;

/** メディア要素コレクション型 */
export type MediaElements = z.infer<typeof mediaElementsSchema>;
