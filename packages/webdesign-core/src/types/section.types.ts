// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Section Types for SectionDetector
 *
 * Webページのセクション検出に使用する型定義
 *
 * @module @reftrix/webdesign-core/types/section
 */

import { z } from 'zod';

// =========================================
// Section Type Enum
// =========================================

/**
 * セクションタイプ
 * Webページの主要セクションタイプ
 *
 * 基本タイプ（11種）:
 * - hero: ヒーローセクション（ファーストビュー）
 * - feature: 機能・特徴紹介
 * - cta: コールトゥアクション
 * - testimonial: お客様の声・レビュー
 * - pricing: 料金プラン
 * - footer: フッター
 * - navigation: ナビゲーション
 * - about: 会社・サービス紹介
 * - contact: お問い合わせ
 * - gallery: ギャラリー・作品集
 * - unknown: 分類不明
 *
 * 拡張タイプ（8種）:
 * - partners: パートナー・クライアントロゴ
 * - portfolio: ポートフォリオ・実績
 * - team: チーム・メンバー紹介
 * - stories: ストーリー・事例紹介
 * - research: リサーチ・調査結果
 * - subscribe: 購読・ニュースレター登録
 * - stats: 統計・数値実績
 * - faq: よくある質問
 */
export const SectionTypeSchema = z.enum([
  // 基本タイプ（11種）
  'hero',
  'feature',
  'cta',
  'testimonial',
  'pricing',
  'footer',
  'navigation',
  'about',
  'contact',
  'gallery',
  'unknown',
  // 拡張タイプ（8種）
  'partners',
  'portfolio',
  'team',
  'stories',
  'research',
  'subscribe',
  'stats',
  'faq',
]);
export type SectionType = z.infer<typeof SectionTypeSchema>;

// =========================================
// Button Type
// =========================================

/**
 * ボタンタイプ
 */
export const ButtonTypeSchema = z.enum(['primary', 'secondary', 'link']);
export type ButtonType = z.infer<typeof ButtonTypeSchema>;

// =========================================
// Section Detector Options
// =========================================

/**
 * SectionDetectorオプション
 */
export const SectionDetectorOptionsSchema = z.object({
  /** 最小セクション高さ（px） - Phase 2で100px → 50pxに緩和 */
  minSectionHeight: z.number().int().positive().optional().default(50),
  /** WAI-ARIAランドマーク検出 */
  detectLandmarks: z.boolean().optional().default(true),
  /** HTML5セマンティックタグ検出 */
  detectSemanticTags: z.boolean().optional().default(true),
  /** 視覚的セクション（背景色変化等）検出 */
  detectVisualSections: z.boolean().optional().default(true),
  /** ネストされた子要素を除外してトップレベルセクションのみ保持（デフォルト: true） */
  removeNestedSections: z.boolean().optional().default(true),
  /** 同一タイプのセクション最大数（オプション、未指定で無制限） */
  maxSectionsPerType: z.number().int().positive().optional(),
  /**
   * hero/footerのDOM順序考慮による単一検出を強制（デフォルト: true）
   *
   * trueの場合:
   * - hero: DOM最上部20%内の最高信頼度セクションのみ採用（1ページ最大1つ）
   * - footer: DOM最下部20%内の最高信頼度セクションのみ採用（1ページ最大1つ）
   * - 位置条件外のhero→feature、footer→contentに再分類
   */
  enforceSingleHeroFooter: z.boolean().optional().default(true),
  /**
   * heroセクション検出の上限位置（ページ先頭からの%）（デフォルト: 20）
   * この値以下のestimatedTopを持つセクションのみheroとして検出
   */
  heroTopThreshold: z.number().min(0).max(100).optional().default(20),
  /**
   * footerセクション検出の下限位置（ページ末尾からの%）（デフォルト: 80）
   * この値以上のestimatedTopを持つセクションのみfooterとして検出
   */
  footerBottomThreshold: z.number().min(0).max(100).optional().default(80),
});
export type SectionDetectorOptions = z.infer<typeof SectionDetectorOptionsSchema>;

// =========================================
// Element Info
// =========================================

/**
 * 要素情報
 */
export const ElementInfoSchema = z.object({
  /** HTMLタグ名 */
  tagName: z.string(),
  /** CSSセレクタ */
  selector: z.string(),
  /** CSSクラス */
  classes: z.array(z.string()),
  /** 要素ID */
  id: z.string().optional(),
});
export type ElementInfo = z.infer<typeof ElementInfoSchema>;

// =========================================
// Position Info
// =========================================

/**
 * 位置情報
 */
export const PositionInfoSchema = z.object({
  /** 開始Y座標 */
  startY: z.number(),
  /** 終了Y座標 */
  endY: z.number(),
  /** 高さ */
  height: z.number(),
  /** ページ内相対位置（0-100%） - 0が先頭、100が末尾 */
  estimatedTop: z.number().min(0).max(100).optional(),
});
export type PositionInfo = z.infer<typeof PositionInfoSchema>;

// =========================================
// Heading Info
// =========================================

/**
 * 見出し情報
 */
export const HeadingInfoSchema = z.object({
  /** 見出しレベル（1-6） */
  level: z.number().int().min(1).max(6),
  /** テキスト内容 */
  text: z.string(),
});
export type HeadingInfo = z.infer<typeof HeadingInfoSchema>;

// =========================================
// Link Info
// =========================================

/**
 * リンク情報
 */
export const LinkInfoSchema = z.object({
  /** リンクテキスト */
  text: z.string(),
  /** リンク先URL */
  href: z.string(),
});
export type LinkInfo = z.infer<typeof LinkInfoSchema>;

// =========================================
// Image Info
// =========================================

/**
 * 画像情報
 */
export const ImageInfoSchema = z.object({
  /** 画像ソースURL */
  src: z.string(),
  /** 代替テキスト */
  alt: z.string().optional(),
});
export type ImageInfo = z.infer<typeof ImageInfoSchema>;

// =========================================
// Button Info
// =========================================

/**
 * ボタン情報
 */
export const ButtonInfoSchema = z.object({
  /** ボタンテキスト */
  text: z.string(),
  /** ボタンタイプ */
  type: ButtonTypeSchema,
});
export type ButtonInfo = z.infer<typeof ButtonInfoSchema>;

// =========================================
// Section Content
// =========================================

/**
 * セクションコンテンツ
 */
export const SectionContentSchema = z.object({
  /** 見出し */
  headings: z.array(HeadingInfoSchema),
  /** 段落テキスト */
  paragraphs: z.array(z.string()),
  /** リンク */
  links: z.array(LinkInfoSchema),
  /** 画像 */
  images: z.array(ImageInfoSchema),
  /** ボタン */
  buttons: z.array(ButtonInfoSchema),
});
export type SectionContent = z.infer<typeof SectionContentSchema>;

// =========================================
// Section Style
// =========================================

/**
 * セクションスタイル
 */
export const SectionStyleSchema = z.object({
  /** 背景色 */
  backgroundColor: z.string().optional(),
  /** テキスト色 */
  textColor: z.string().optional(),
  /** グラデーションの有無 */
  hasGradient: z.boolean().optional(),
  /** 背景画像の有無 */
  hasImage: z.boolean().optional(),
});
export type SectionStyle = z.infer<typeof SectionStyleSchema>;

// =========================================
// Detected Section
// =========================================

/**
 * HTMLスニペットの最大サイズ（バイト）
 * セクションごとのHTMLスニペットはこのサイズ以下に制限される
 */
export const HTML_SNIPPET_MAX_SIZE = 50 * 1024; // 50KB

/**
 * 検出されたセクション（再帰的定義のためinterfaceを使用）
 */
export interface DetectedSection {
  /** 自動生成ID */
  id: string;
  /** セクションタイプ */
  type: SectionType;
  /** 信頼度（0-1） */
  confidence: number;
  /** 要素情報 */
  element: ElementInfo;
  /** 位置情報 */
  position: PositionInfo;
  /** コンテンツ情報 */
  content: SectionContent;
  /** スタイル情報 */
  style: SectionStyle;
  /** ネストしたセクション */
  children?: DetectedSection[];
  /** セクションのHTMLスニペット（サニタイズ済み、最大50KB） */
  htmlSnippet?: string;
}

// 基本スキーマ（childrenなし）
const BaseSectionSchema = z.object({
  id: z.string(),
  type: SectionTypeSchema,
  confidence: z.number().min(0).max(1),
  element: ElementInfoSchema,
  position: PositionInfoSchema,
  content: SectionContentSchema,
  style: SectionStyleSchema,
  htmlSnippet: z.string().max(HTML_SNIPPET_MAX_SIZE).optional(),
});

// 再帰的スキーマ
export const DetectedSectionSchema: z.ZodType<DetectedSection> = BaseSectionSchema.extend({
  children: z.lazy(() => z.array(DetectedSectionSchema)).optional(),
}) as z.ZodType<DetectedSection>;

// =========================================
// Section Detection Result
// =========================================

/**
 * セクション検出結果
 */
export const SectionDetectionResultSchema = z.object({
  /** 検出されたセクション */
  sections: z.array(DetectedSectionSchema),
  /** 検出に使用したオプション */
  options: SectionDetectorOptionsSchema,
  /** 処理時間（ms） */
  processingTimeMs: z.number().optional(),
});
export type SectionDetectionResult = z.infer<typeof SectionDetectionResultSchema>;

// =========================================
// Section Classification Rule
// =========================================

/**
 * セクション分類ルール
 */
export interface SectionClassificationRule {
  /** ルール名 */
  name: string;
  /** 対象セクションタイプ */
  targetType: SectionType;
  /** マッチするクラス名パターン */
  classPatterns?: RegExp[];
  /** マッチするIDパターン */
  idPatterns?: RegExp[];
  /** マッチするタグ名 */
  tagNames?: string[];
  /** マッチするARIAロール */
  ariaRoles?: string[];
  /** コンテンツベースの条件 */
  contentConditions?: {
    /** h1が必須か */
    requiresH1?: boolean;
    /** ボタンが必須か */
    requiresButton?: boolean;
    /** 画像が必須か */
    requiresImage?: boolean;
    /** 最小見出し数 */
    minHeadings?: number;
    /** 最小画像数 */
    minImages?: number;
    /** 最小リンク数 */
    minLinks?: number;
  };
  /** 位置条件 */
  positionConditions?: {
    /** ページ先頭付近か */
    isNearTop?: boolean;
    /** ページ末尾付近か */
    isNearBottom?: boolean;
  };
  /** ベース信頼度（0-1） */
  baseConfidence: number;
}

// =========================================
// WAI-ARIA Landmark Roles
// =========================================

/**
 * WAI-ARIAランドマークロール
 */
export const ARIA_LANDMARK_ROLES = [
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'search',
  'form',
  'region',
] as const;

export type AriaLandmarkRole = (typeof ARIA_LANDMARK_ROLES)[number];

// =========================================
// HTML5 Semantic Tags
// =========================================

/**
 * HTML5セマンティックタグ
 */
export const SEMANTIC_TAGS = [
  'header',
  'nav',
  'main',
  'section',
  'article',
  'aside',
  'footer',
] as const;

export type SemanticTag = (typeof SEMANTIC_TAGS)[number];

// =========================================
// Section Type to Landmark Mapping
// =========================================

/**
 * セクションタイプとランドマーク/タグのマッピング
 */
export const SECTION_TYPE_MAPPINGS: Record<
  string,
  {
    sectionType: SectionType;
    confidence: number;
  }
> = {
  // WAI-ARIA Landmarks
  banner: { sectionType: 'navigation', confidence: 0.9 },
  navigation: { sectionType: 'navigation', confidence: 0.95 },
  main: { sectionType: 'unknown', confidence: 0.5 },
  contentinfo: { sectionType: 'footer', confidence: 0.9 },
  complementary: { sectionType: 'unknown', confidence: 0.4 },
  // HTML5 Semantic Tags
  header: { sectionType: 'navigation', confidence: 0.8 },
  nav: { sectionType: 'navigation', confidence: 0.95 },
  footer: { sectionType: 'footer', confidence: 0.95 },
  article: { sectionType: 'unknown', confidence: 0.5 },
  aside: { sectionType: 'unknown', confidence: 0.4 },
  section: { sectionType: 'unknown', confidence: 0.3 },
};
