// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Layout Analyzer Service
 *
 * Cheerioを使用したレイアウト解析サービス
 * @reftrix/webdesign-core の SectionDetector を活用
 *
 * 機能:
 * - セクション検出（セマンティック要素、class/id名ベース）
 * - グリッド/フレックスレイアウト検出
 * - タイポグラフィ解析
 * - 色抽出
 *
 * @module services/page/layout-analyzer.service
 */

import {
  SectionDetector,
  type DetectedSection as CoreDetectedSection,
  CssVariableResolver,
  isValidColorValue,
} from "@reftrix/webdesign-core";
import * as cheerio from "cheerio";
import type { Cheerio } from "cheerio";
import type { AnyNode } from "domhandler";
import { v7 as uuidv7 } from "uuid";
import { logger, isDevelopment } from "../../utils/logger";
import {
  ExternalCssFetcher,
  type FetchAllCssOptions,
  type FetchCssResult,
} from "../external-css-fetcher";
import type {
  ComputedStyleInfo,
  ElementComputedStyles,
  ChildElementStyleInfo,
} from "../page-ingest-adapter";

// =====================================================
// 型定義
// =====================================================

/**
 * セクション要素情報
 */
export interface SectionElement {
  /** HTMLタグ名 */
  tagName: string;
  /** CSSセレクタ */
  selector?: string;
  /** CSSクラス */
  classes?: string[];
  /** 要素ID */
  id?: string;
}

/**
 * セクション位置情報
 */
export interface SectionPosition {
  /** 開始Y座標（推定） */
  startY: number;
  /** 終了Y座標（推定） */
  endY: number;
  /** 高さ（推定） */
  height: number;
}

/**
 * セクションコンテンツ情報
 */
export interface SectionContent {
  /** 見出し */
  headings?: Array<{ level: number; text: string }>;
  /** 段落テキスト */
  paragraphs?: string[];
  /** リンク */
  links?: Array<{ text: string; href: string }>;
  /** 画像 */
  images?: Array<{ src: string; alt?: string }>;
  /** ボタン */
  buttons?: Array<{ text: string; type?: string }>;
}

/**
 * セクションスタイル情報
 */
export interface SectionStyle {
  /** 背景色 */
  backgroundColor?: string;
  /** テキスト色 */
  textColor?: string;
  /** グラデーションの有無 */
  hasGradient?: boolean;
  /** 背景画像の有無 */
  hasImage?: boolean;
}

/**
 * 検出されたセクション
 */
export interface DetectedSection {
  /** セクションID */
  id: string;
  /** セクションタイプ */
  type: string;
  /** 信頼度（0-1） */
  confidence: number;
  /** 要素情報 */
  element?: SectionElement;
  /** 位置情報 */
  position: SectionPosition;
  /** コンテンツ情報 */
  content?: SectionContent;
  /** スタイル情報 */
  style?: SectionStyle;
  /** セクションのHTMLスニペット（サニタイズ済み、最大50KB） */
  htmlSnippet?: string;
  /** セクションのCSSスニペット（style/link/inline styles） */
  cssSnippet?: string;
}

/**
 * グリッド情報
 */
export interface GridInfo {
  /** CSS Gridを使用しているか */
  hasGrid: boolean;
  /** Flexboxを使用しているか */
  hasFlex: boolean;
  /** 推定カラム数 */
  columnCount?: number;
  /** 推定ガター幅 */
  gutterWidth?: number;
}

/**
 * タイポグラフィ情報
 */
export interface TypographyInfo {
  /** 見出し情報 */
  headings: Array<{
    level: number;
    fontSize?: string;
    fontWeight?: string;
    count: number;
  }>;
  /** 検出されたフォントサイズ */
  fontSizes?: string[];
  /** 検出されたフォントファミリー */
  fontFamilies?: string[];
}

/**
 * 色情報
 */
export interface ColorInfo {
  /** 背景色 */
  backgroundColors?: string[];
  /** テキスト色 */
  textColors?: string[];
  /** 主要カラーパレット */
  palette?: string[];
  /** グラデーションの有無 */
  hasGradients?: boolean;
}

/**
 * CSSフレームワークの種類
 */
export type CssFramework =
  | "tailwind"
  | "bootstrap"
  | "css_modules"
  | "styled_components"
  | "webflow"
  | "jquery_ui"
  | "squarespace"
  | "framer"
  | "elementor"
  | "wix"
  | "vanilla"
  | "unknown";

/**
 * CSSフレームワーク検出結果
 */
export interface CssFrameworkDetection {
  /** 検出されたフレームワーク（primary） */
  framework: CssFramework;
  /** 信頼度（0-1）- primaryフレームワークの信頼度 */
  confidence: number;
  /** 検出根拠 */
  evidence: string[];
  /** 複合検出結果 - 複数フレームワークが検出された場合 */
  composite?: CssFrameworkCompositeResult;
}

/**
 * CSSフレームワーク複合検出結果
 * 複数のCSSフレームワークが同時に使用されている場合の検出結果
 */
export interface CssFrameworkCompositeResult {
  /** プライマリフレームワーク（最も優勢） */
  primary: CssFramework;
  /** セカンダリフレームワーク（併用されている） */
  secondary: CssFramework[];
  /** 各フレームワークの信頼度 */
  confidenceMap: Partial<Record<CssFramework, number>>;
  /** CSS変数が検出されたか */
  hasCssVariables: boolean;
  /** CSS変数の信頼度（0-1） */
  cssVariablesConfidence?: number;
}

/**
 * 外部CSS取得オプション
 */
export interface ExternalCssFetchOptions {
  /** 外部CSSを取得するか（デフォルト: false） */
  fetchExternalCss?: boolean;
  /** ベースURL（相対URL解決用） */
  baseUrl?: string;
  /** タイムアウト（ミリ秒）（デフォルト: 5000） */
  timeout?: number;
  /** 最大CSSサイズ（バイト）（デフォルト: 5MB） */
  maxSize?: number;
  /** 最大並列取得数（デフォルト: 5） */
  maxConcurrent?: number;
  /** 最大CSS取得数（デフォルト: 20） */
  maxCssFiles?: number;
  /**
   * サニタイズ前のHTMLから抽出した外部CSS URL配列
   * この配列が渡された場合、DOM解析ではなくこれらのURLを使用する
   * （DOMPurifyで<link>タグが除去される問題の回避策）
   */
  preExtractedUrls?: string[];
}

/**
 * 外部CSS取得結果
 */
export interface ExternalCssFetchResult {
  /** 成功した取得数 */
  successCount: number;
  /** 失敗した取得数 */
  failedCount: number;
  /** 合計サイズ（バイト） */
  totalSize: number;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
  /** 個別の結果 */
  results: FetchCssResult[];
}

/**
 * 外部CSSメタ情報（DB保存用）
 */
export interface ExternalCssMeta {
  /** 取得成功数 */
  fetchedCount: number;
  /** 取得失敗数 */
  failedCount: number;
  /** 合計サイズ（バイト） */
  totalSize: number;
  /** 取得URL一覧 */
  urls: Array<{
    url: string;
    size?: number;
    success?: boolean;
  }>;
  /** 取得時刻（ISO） */
  fetchedAt: string;
}

/**
 * レイアウト解析オプション
 */
export interface LayoutAnalysisOptions {
  /** コンテンツ情報を含める */
  includeContent?: boolean;
  /** スタイル情報を含める */
  includeStyles?: boolean;
  /** 最大セクション数 */
  maxSections?: number;
  /** 外部CSS取得オプション */
  externalCss?: ExternalCssFetchOptions;
  /**
   * Computed Styles配列（PageIngestAdapterから取得）
   * 設定すると、セクションのhtmlSnippetにインラインスタイルとして適用される
   */
  computedStyles?: ComputedStyleInfo[];
}

/**
 * レイアウト解析結果
 */
export interface LayoutAnalysisResult {
  /** 成功フラグ */
  success: boolean;
  /** 検出されたセクション */
  sections: DetectedSection[];
  /** セクション数 */
  sectionCount: number;
  /** セクションタイプ別カウント */
  sectionTypes: Record<string, number>;
  /** グリッド情報 */
  grid?: GridInfo;
  /** タイポグラフィ情報 */
  typography?: TypographyInfo;
  /** 色情報 */
  colors?: ColorInfo;
  /** CSSスニペット（ページ全体、<style>タグ + @import参照） */
  cssSnippet?: string;
  /** 外部CSSコンテンツ（<link rel="stylesheet">の実コンテンツ） */
  externalCssContent?: string;
  /** 外部CSSメタ情報 */
  externalCssMeta?: ExternalCssMeta;
  /** CSSフレームワーク検出結果 */
  cssFramework?: CssFrameworkDetection;
  /** 外部CSS取得結果 */
  externalCssFetch?: ExternalCssFetchResult;
  /** Computed Stylesが適用されたセクション数 */
  computedStylesAppliedCount?: number;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
  /** エラー情報 */
  error?: {
    code: string;
    message: string;
  };
}

// =====================================================
// ヘルパー関数
// =====================================================

type CheerioAPI = cheerio.CheerioAPI;

// =====================================================
// Computed Styles インライン適用関数
// =====================================================

/**
 * フィルタリング対象外のスタイルプロパティ値
 * これらの値は意味がないため除外する
 */
const FILTER_OUT_VALUES = [
  "none",
  "normal",
  "auto",
  "initial",
  "inherit",
  "unset",
  "0px",
  "rgba(0, 0, 0, 0)",
  "transparent",
  "matrix(1, 0, 0, 1, 0, 0)",
];

/**
 * camelCase を kebab-case に変換
 *
 * @param str - camelCase文字列
 * @returns kebab-case文字列
 */
function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * ElementComputedStyles を CSS文字列に変換
 *
 * 意味のない値（none, normal, auto等）はフィルタリングして除外する
 *
 * @param styles - ElementComputedStyles オブジェクト
 * @returns インラインスタイル用CSS文字列
 */
function stylesToString(styles: ElementComputedStyles): string {
  return Object.entries(styles)
    .filter(([_, value]) => {
      // 値が存在しない場合は除外
      if (!value || value.trim().length === 0) {
        return false;
      }
      // フィルタリング対象の値を除外
      if (FILTER_OUT_VALUES.includes(value)) {
        return false;
      }
      return true;
    })
    .map(([key, value]) => `${camelToKebab(key)}: ${value}`)
    .join("; ");
}

/**
 * セクションHTMLに computed styles をインラインスタイルとして適用
 *
 * セクションのルート要素と子要素に対して、取得した computed styles を
 * style 属性として適用し、外部CSSなしで見た目を再現可能にする
 *
 * @param htmlSnippet - 対象のHTMLスニペット
 * @param computedStyles - 対応する ComputedStyleInfo（ルート要素 + 子要素のスタイル）
 * @returns computed styles が適用されたHTML
 */
export function applyComputedStylesToHtml(
  htmlSnippet: string,
  computedStyles: ComputedStyleInfo
): string {
  if (!htmlSnippet || !computedStyles) {
    return htmlSnippet;
  }

  try {
    const $ = cheerio.load(htmlSnippet, {
      xmlMode: false,
    });

    // 1. ルート要素にスタイルを適用
    const rootElement = $("body > *").first();
    if (rootElement.length > 0 && computedStyles.styles) {
      const rootStyleStr = stylesToString(computedStyles.styles);
      if (rootStyleStr.length > 0) {
        // 既存のstyle属性があれば結合、なければ設定
        const existingStyle = rootElement.attr("style") || "";
        const newStyle = existingStyle ? `${existingStyle}; ${rootStyleStr}` : rootStyleStr;
        rootElement.attr("style", newStyle);
      }
    }

    // 2. 子要素にスタイルを適用
    if (computedStyles.children && computedStyles.children.length > 0) {
      for (const child of computedStyles.children) {
        applyChildStyles($, child);
      }
    }

    // <html><head></head><body>...</body></html> の body 内のみを返す
    const result = $("body").html();
    return result || htmlSnippet;
  } catch (error) {
    if (isDevelopment()) {
      logger.warn("[LayoutAnalyzerService] Failed to apply computed styles to HTML", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
    // エラー時は元のHTMLをそのまま返す
    return htmlSnippet;
  }
}

/**
 * 子要素に computed styles を適用
 *
 * @param $ - CheerioAPI
 * @param child - 子要素のスタイル情報
 */
function applyChildStyles($: CheerioAPI, child: ChildElementStyleInfo): void {
  if (!child.styles) {
    return;
  }

  const styleStr = stylesToString(child.styles);
  if (styleStr.length === 0) {
    return;
  }

  // セレクタまたはパスを使って要素を特定
  let elements: Cheerio<AnyNode>;

  // 1. セレクタがあればそれを使用
  if (child.selector && child.selector.length > 0) {
    try {
      elements = $(child.selector);
    } catch {
      // セレクタが無効な場合はパスにフォールバック
      elements = $();
    }
  } else if (child.path && child.path.length > 0) {
    // 2. パスを使用（例: "div > h1"）
    try {
      elements = $(child.path);
    } catch {
      elements = $();
    }
  } else {
    // 3. タグ名とクラス名で特定
    const tagName = child.tagName.toLowerCase();
    if (child.className && child.className.length > 0) {
      // 最初のクラス名のみ使用（複数クラスの場合）
      const firstClass = child.className.split(/\s+/)[0];
      try {
        elements = $(`${tagName}.${firstClass}`);
      } catch {
        elements = $(tagName);
      }
    } else {
      elements = $(tagName);
    }
  }

  // 見つかった要素にスタイルを適用
  elements.each((_, elem) => {
    const existingStyle = $(elem).attr("style") || "";
    const newStyle = existingStyle ? `${existingStyle}; ${styleStr}` : styleStr;
    $(elem).attr("style", newStyle);
  });
}

/**
 * セクションインデックスに基づいて対応する computed styles を見つける
 *
 * @param sectionIndex - セクションのインデックス
 * @param computedStyles - 全 computed styles 配列
 * @returns 対応する ComputedStyleInfo または undefined
 */
export function findMatchingComputedStyles(
  sectionIndex: number,
  computedStyles: ComputedStyleInfo[]
): ComputedStyleInfo | undefined {
  if (!computedStyles || computedStyles.length === 0) {
    return undefined;
  }

  // インデックスで検索
  return computedStyles.find((cs) => cs.index === sectionIndex);
}

/**
 * CSSからグリッド/フレックスレイアウトを検出
 */
function detectGridLayout(_$: CheerioAPI, html: string): GridInfo {
  const info: GridInfo = {
    hasGrid: false,
    hasFlex: false,
  };

  // インラインスタイルとスタイルタグからグリッド検出
  const hasGridDisplay =
    html.includes("display: grid") ||
    html.includes("display:grid") ||
    html.match(/display\s*:\s*grid/i) !== null;

  const hasFlexDisplay =
    html.includes("display: flex") ||
    html.includes("display:flex") ||
    html.match(/display\s*:\s*flex/i) !== null;

  info.hasGrid = hasGridDisplay;
  info.hasFlex = hasFlexDisplay;

  // グリッドカラム数を推定
  if (hasGridDisplay) {
    // grid-template-columns パターンを検出
    const columnMatch = html.match(/grid-template-columns:\s*repeat\s*\(\s*(\d+)/i);
    if (columnMatch && columnMatch[1]) {
      info.columnCount = parseInt(columnMatch[1], 10);
    } else {
      // fr単位やピクセル値からカラム数を推定
      const frMatch = html.match(/grid-template-columns:\s*([^;]+)/i);
      if (frMatch && frMatch[1]) {
        const frCount = (frMatch[1].match(/\dfr|\d+px|auto/gi) || []).length;
        if (frCount > 0) {
          info.columnCount = frCount;
        }
      }
    }

    // gap/ガター幅を推定
    const gapMatch = html.match(/(?:grid-)?gap:\s*(\d+)px/i);
    if (gapMatch && gapMatch[1]) {
      info.gutterWidth = parseInt(gapMatch[1], 10);
    }
  }

  return info;
}

/**
 * タイポグラフィ情報を抽出
 */
function extractTypography($: CheerioAPI, html: string): TypographyInfo {
  const headings: TypographyInfo["headings"] = [];
  const fontSizes = new Set<string>();
  const fontFamilies = new Set<string>();

  // 見出し要素を抽出
  for (let level = 1; level <= 6; level++) {
    const $headings = $(`h${level}`);
    if ($headings.length > 0) {
      headings.push({
        level,
        count: $headings.length,
      });
    }
  }

  // CSSからフォントサイズを抽出
  const fontSizeMatches = html.match(/font-size:\s*([^;}\s]+)/gi);
  if (fontSizeMatches) {
    for (const match of fontSizeMatches) {
      const size = match.replace(/font-size:\s*/i, "").trim();
      if (size) {
        fontSizes.add(size);
      }
    }
  }

  // CSSからフォントファミリーを抽出
  const fontFamilyMatches = html.match(/font-family:\s*([^;]+)/gi);
  if (fontFamilyMatches) {
    for (const match of fontFamilyMatches) {
      const family = match.replace(/font-family:\s*/i, "").trim();
      // 最初のフォント名を抽出
      const firstFont = family.split(",")[0]?.replace(/['"]/g, "").trim();
      if (firstFont) {
        fontFamilies.add(firstFont);
      }
    }
  }

  // exactOptionalPropertyTypes対応: undefined を代入せずプロパティを省略
  const result: TypographyInfo = {
    headings,
  };
  if (fontSizes.size > 0) {
    result.fontSizes = Array.from(fontSizes);
  }
  if (fontFamilies.size > 0) {
    result.fontFamilies = Array.from(fontFamilies);
  }
  return result;
}

/**
 * 色情報を抽出（CSS変数解決対応）
 *
 * CSS変数（var(--color-bg) 等）を実際の色値に解決してから抽出します。
 * これにより、ax1.vcのようなCSS変数を多用するサイトでも
 * 正確に色情報を取得できます。
 *
 * @param $ - CheerioAPI
 * @param html - HTML文字列
 * @param externalCss - 外部CSSコンテンツ（オプション）
 * @returns ColorInfo
 */
function extractColors($: CheerioAPI, html: string, externalCss?: string): ColorInfo {
  const backgroundColors = new Set<string>();
  const textColors = new Set<string>();
  let hasGradients = false;

  // CSS変数リゾルバを初期化
  const resolver = new CssVariableResolver();

  // HTMLから変数定義を抽出
  resolver.extractVariablesFromHtml(html);

  // 外部CSSからも変数定義を抽出
  if (externalCss) {
    resolver.extractVariablesFromCss(externalCss);
  }

  if (isDevelopment()) {
    logger.info("[LayoutAnalyzerService] CSS variables extracted", {
      variableCount: resolver.size,
    });
  }

  // ヘルパー: 色値を解決して追加
  const resolveAndAddColor = (value: string, colorSet: Set<string>): void => {
    const trimmedValue = value.trim();
    if (!trimmedValue) return;

    // CSS変数を解決
    const result = resolver.resolve(trimmedValue);
    const resolvedValue = result.success && result.resolvedValue ? result.resolvedValue : trimmedValue;

    // 有効な色値かチェック
    if (isValidColorValue(resolvedValue)) {
      colorSet.add(resolvedValue);
    }
  };

  // ヘルパー: CSSテキストから色を抽出
  const extractColorsFromCssText = (cssText: string): void => {
    // 背景色を抽出
    const bgColorPattern = /background(?:-color)?:\s*([^;}\n]+)/gi;
    let match: RegExpExecArray | null;

    while ((match = bgColorPattern.exec(cssText)) !== null) {
      const value = match[1]?.trim();
      if (value) {
        // グラデーションチェック
        if (value.includes("gradient")) {
          hasGradients = true;
        } else if (!value.includes("url(")) {
          resolveAndAddColor(value, backgroundColors);
        }
      }
    }

    // テキスト色を抽出（background-colorではなくcolorのみ）
    const colorPattern = /(?:^|[;\s{])color:\s*([^;}\n]+)/gi;

    while ((match = colorPattern.exec(cssText)) !== null) {
      const value = match[1]?.trim();
      if (value) {
        resolveAndAddColor(value, textColors);
      }
    }
  };

  // 1. 全要素のstyle属性から色を抽出
  $("[style]").each((_, elem) => {
    const styleAttr = $(elem).attr("style");
    if (styleAttr) {
      extractColorsFromCssText(styleAttr);
    }
  });

  // 2. <style>タグ内のCSSからも色を抽出
  $("style").each((_, elem) => {
    const cssContent = $(elem).html();
    if (cssContent) {
      extractColorsFromCssText(cssContent);
    }
  });

  // 3. 外部CSSからも抽出
  if (externalCss) {
    extractColorsFromCssText(externalCss);
  }

  // パレット生成（頻出色上位）
  const allColors = [...backgroundColors, ...textColors];
  const palette = Array.from(new Set(allColors)).slice(0, 10);

  // exactOptionalPropertyTypes対応: undefined を代入せずプロパティを省略
  const result: ColorInfo = {
    hasGradients,
  };
  if (backgroundColors.size > 0) {
    result.backgroundColors = Array.from(backgroundColors);
  }
  if (textColors.size > 0) {
    result.textColors = Array.from(textColors);
  }
  if (palette.length > 0) {
    result.palette = palette;
  }
  return result;
}

/**
 * HTMLからCSSスニペットを抽出
 *
 * 抽出対象:
 * - <style>タグ内のCSS（有効なセレクタ付きルールのみ）
 * - 外部CSSリンク（参照のみ、@import形式）
 *
 * 注意:
 * - インラインスタイル（style属性）は抽出しない
 *   → セレクタなしの宣言は無効なCSSとなるため
 *   → スタイルはhtmlSnippet内のstyle属性として既に適用されている
 *
 * @param $ - CheerioAPI
 * @returns CSSスニペット
 */
function extractCssSnippet($: CheerioAPI): string {
  const cssChunks: string[] = [];

  // 1. <style>タグからCSS抽出
  $("style").each((_, elem) => {
    const css = $(elem).html();
    if (css && css.trim().length > 0) {
      cssChunks.push(`/* <style> tag */\n${css.trim()}`);
    }
  });

  // 2. インラインスタイルは抽出しない
  // 理由: セレクタなしのCSS宣言は無効であり、ブラウザで無視される
  // 実際のスタイルはhtmlSnippet内の各要素のstyle属性に保持されている

  // 3. 外部CSS参照
  const externalCss: string[] = [];
  $('link[rel="stylesheet"]').each((_, elem) => {
    const href = $(elem).attr("href");
    if (href && href.trim().length > 0) {
      externalCss.push(href.trim());
    }
  });
  if (externalCss.length > 0) {
    cssChunks.push(
      `/* External CSS References (${externalCss.length} files) */\n${externalCss.map((href) => `@import url("${href}");`).join("\n")}`
    );
  }

  return cssChunks.length > 0 ? cssChunks.join("\n\n") : "";
}

/**
 * HTMLから外部CSSリンクのURLを抽出
 *
 * @param $ - CheerioAPI
 * @param baseUrl - ベースURL（相対URL解決用）
 * @returns 外部CSSのURL配列
 */
function extractExternalCssUrls($: CheerioAPI, baseUrl: string): string[] {
  const urls: string[] = [];

  $('link[rel="stylesheet"]').each((_, elem) => {
    const href = $(elem).attr("href");
    if (href && href.trim().length > 0) {
      const trimmedHref = href.trim();

      // 相対URLを絶対URLに解決
      try {
        const absoluteUrl = new URL(trimmedHref, baseUrl).href;
        urls.push(absoluteUrl);
      } catch {
        // URLが無効な場合はスキップ
        if (isDevelopment()) {
          logger.warn("[LayoutAnalyzerService] Invalid CSS URL", { href: trimmedHref, baseUrl });
        }
      }
    }
  });

  return urls;
}

/**
 * 外部CSSファイルを取得してCSSスニペットに結合
 *
 * @param $ - CheerioAPI
 * @param options - 外部CSS取得オプション
 * @returns CSSスニペットと取得結果
 */
async function extractCssWithExternalContent(
  $: CheerioAPI,
  options: ExternalCssFetchOptions
): Promise<{ cssSnippet: string; externalCssContent: string; fetchResult: ExternalCssFetchResult }> {
  const startTime = Date.now();
  const cssChunks: string[] = [];
  const externalCssContentChunks: string[] = [];

  // 1. <style>タグからCSS抽出
  $("style").each((_, elem) => {
    const css = $(elem).html();
    if (css && css.trim().length > 0) {
      cssChunks.push(`/* <style> tag */\n${css.trim()}`);
    }
  });

  // 2. インラインスタイルは抽出しない
  // 理由: セレクタなしのCSS宣言は無効であり、ブラウザで無視される
  // 実際のスタイルはhtmlSnippet内の各要素のstyle属性に保持されている

  // 3. 外部CSS参照（@import）
  const baseUrl = options.baseUrl ?? "";
  const maxCssFiles = options.maxCssFiles ?? 20;

  // preExtractedUrlsが渡された場合はそれを使用
  // （DOMPurifyで<link>タグが除去される問題の回避策）
  let externalCssUrls: string[];
  if (options.preExtractedUrls && options.preExtractedUrls.length > 0) {
    externalCssUrls = options.preExtractedUrls;
    if (isDevelopment()) {
      logger.debug("[LayoutAnalyzerService] Using pre-extracted CSS URLs", {
        count: externalCssUrls.length,
      });
    }
  } else {
    externalCssUrls = extractExternalCssUrls($, baseUrl);
  }

  // 最大取得数を制限
  if (externalCssUrls.length > maxCssFiles) {
    if (isDevelopment()) {
      logger.warn("[LayoutAnalyzerService] Limiting external CSS files", {
        total: externalCssUrls.length,
        limit: maxCssFiles,
      });
    }
    externalCssUrls = externalCssUrls.slice(0, maxCssFiles);
  }

  // 参照用の@importを追加（外部CSSはexternalCssContentに分離）
  if (externalCssUrls.length > 0) {
    cssChunks.push(
      `/* External CSS References (${externalCssUrls.length} files) */\n${externalCssUrls.map((href) => `@import url("${href}");`).join("\n")}`
    );
  }

  let fetchResult: ExternalCssFetchResult = {
    successCount: 0,
    failedCount: 0,
    totalSize: 0,
    processingTimeMs: 0,
    results: [],
  };

  if (externalCssUrls.length > 0) {
    const fetcher = new ExternalCssFetcher({
      timeout: options.timeout ?? 5000,
      maxSize: options.maxSize ?? 5 * 1024 * 1024, // 5MB
      maxConcurrent: options.maxConcurrent ?? 5,
    });

    if (isDevelopment()) {
      logger.debug("[LayoutAnalyzerService] Fetching external CSS files", {
        count: externalCssUrls.length,
        urls: externalCssUrls,
      });
    }

    const fetchAllOptions: FetchAllCssOptions = {
      timeout: options.timeout ?? 5000,
      maxSize: options.maxSize ?? 5 * 1024 * 1024,
      maxConcurrent: options.maxConcurrent ?? 5,
      continueOnError: true,
    };

    // v0.1.0: 全体の外部CSS取得に30秒のハードタイムアウトを設定
    // 多数のファイル（Tildaサイト等で43ファイル）のバッチ処理で
    // 合計時間が膨れてページ分析全体がタイムアウトするのを防止
    const EXTERNAL_CSS_OVERALL_TIMEOUT_MS = 30000; // 30秒
    try {
      const fetchAllResult = await Promise.race([
        fetcher.fetchAllCss(externalCssUrls, fetchAllOptions),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`External CSS fetch overall timeout after ${EXTERNAL_CSS_OVERALL_TIMEOUT_MS}ms`));
          }, EXTERNAL_CSS_OVERALL_TIMEOUT_MS);
        }),
      ]);

      // 結果を外部CSSチャンクに追加
      for (const result of fetchAllResult.results) {
        if (result.success && result.content) {
          const contentSize = result.contentSize ?? new TextEncoder().encode(result.content).length;
          externalCssContentChunks.push(
            `/* External CSS: ${result.url} (${contentSize} bytes) */\n${result.content}`
          );
        }
      }

      // FetchAllCssDetailedResultの値を直接使用
      fetchResult = {
        successCount: fetchAllResult.successCount,
        failedCount: fetchAllResult.failedCount,
        totalSize: fetchAllResult.totalSize,
        processingTimeMs: Date.now() - startTime,
        results: fetchAllResult.results.map((r) => {
          const result: FetchCssResult = {
            url: r.url,
            content: r.success && r.content ? r.content : null,
          };
          if (r.error) {
            result.error = r.error;
          }
          return result;
        }),
      };

      if (isDevelopment()) {
        logger.debug("[LayoutAnalyzerService] External CSS fetch completed", {
          successCount: fetchResult.successCount,
          failedCount: fetchResult.failedCount,
          totalSize: fetchResult.totalSize,
          processingTimeMs: fetchResult.processingTimeMs,
        });
      }
    } catch (overallFetchError) {
      // 全体タイムアウト: Graceful Degradation（インラインCSSのみで分析を継続）
      if (isDevelopment()) {
        logger.warn("[LayoutAnalyzerService] External CSS fetch overall timeout (graceful degradation)", {
          error: overallFetchError instanceof Error ? overallFetchError.message : String(overallFetchError),
          urlCount: externalCssUrls.length,
          timeoutMs: EXTERNAL_CSS_OVERALL_TIMEOUT_MS,
        });
      }
      // fetchResult はデフォルト値のまま（successCount: 0）
    }
  }

  return {
    cssSnippet: cssChunks.length > 0 ? cssChunks.join("\n\n") : "",
    externalCssContent:
      externalCssContentChunks.length > 0 ? externalCssContentChunks.join("\n\n") : "",
    fetchResult,
  };
}

// =====================================================
// CSSフレームワーク検出
// =====================================================

/**
 * Tailwind CSS検出パターン
 */
const TAILWIND_CDN_PATTERNS = [
  "cdn.tailwindcss.com",
  "tailwindcss.min.css",
  "tailwindcss/base",
  "tailwindcss/components",
  "tailwindcss/utilities",
];

/**
 * Tailwind CSSユーティリティクラスパターン
 */
const TAILWIND_UTILITY_PATTERNS: (string | RegExp)[] = [
  // Layout
  "flex",
  "grid",
  "block",
  "inline",
  "hidden",
  "absolute",
  "relative",
  "fixed",
  "sticky",
  "items-center",
  "items-start",
  "items-end",
  "items-stretch",
  "justify-center",
  "justify-between",
  "justify-start",
  "justify-end",
  "justify-around",
  "flex-col",
  "flex-row",
  "flex-wrap",
  "flex-1",
  // Spacing - regex patterns
  /^p-\d+$/,
  /^px-\d+$/,
  /^py-\d+$/,
  /^pt-\d+$/,
  /^pb-\d+$/,
  /^pl-\d+$/,
  /^pr-\d+$/,
  /^m-\d+$/,
  /^mx-\d+$/,
  /^my-\d+$/,
  /^mt-\d+$/,
  /^mb-\d+$/,
  /^ml-\d+$/,
  /^mr-\d+$/,
  /^-m\w?-\d+$/, // negative margins
  /^gap-\d+$/,
  /^gap-x-\d+$/,
  /^gap-y-\d+$/,
  /^space-[xy]-\d+$/,
  // Sizing
  /^w-\d+$/,
  /^w-full$/,
  /^w-screen$/,
  /^w-auto$/,
  /^w-\d+\/\d+$/,
  /^h-\d+$/,
  /^h-full$/,
  /^h-screen$/,
  /^h-auto$/,
  /^min-w-/,
  /^max-w-/,
  /^min-h-/,
  /^max-h-/,
  // Colors
  /^bg-\w+-\d+$/,
  /^bg-\w+$/,
  /^bg-gradient-/,
  /^text-\w+-\d+$/,
  /^text-white$/,
  /^text-black$/,
  /^border-\w+-\d+$/,
  /^border-\w+$/,
  // Typography
  /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)$/,
  /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/,
  /^leading-\d+$/,
  /^tracking-\w+$/,
  // Borders & Rounded
  /^rounded(-\w+)?$/,
  /^rounded-(sm|md|lg|xl|2xl|3xl|full|none)$/,
  /^border(-\d+)?$/,
  /^border-(t|b|l|r)-\d+$/,
  // Shadows
  /^shadow(-\w+)?$/,
  // Transforms
  /^scale-\d+$/,
  /^rotate-\d+$/,
  /^translate-[xy]-\d+$/,
  // Containers
  "container",
  "mx-auto",
  // Grid
  /^grid-cols-\d+$/,
  /^col-span-\d+$/,
  /^grid-rows-\d+$/,
  /^row-span-\d+$/,
  // Hover/Focus states
  /^hover:/,
  /^focus:/,
  /^active:/,
  /^disabled:/,
  // Responsive prefixes
  /^(sm|md|lg|xl|2xl):/,
];

/**
 * Bootstrap検出パターン
 */
const BOOTSTRAP_CDN_PATTERNS = [
  "bootstrap.min.css",
  "bootstrap.css",
  "bootstrap.bundle",
  "cdn.jsdelivr.net/npm/bootstrap",
  "stackpath.bootstrapcdn.com",
  "maxcdn.bootstrapcdn.com/bootstrap",
];

/**
 * Bootstrapクラスパターン
 */
const BOOTSTRAP_CLASS_PATTERNS: (string | RegExp)[] = [
  // Components
  "navbar",
  "navbar-expand",
  "navbar-dark",
  "navbar-light",
  "navbar-brand",
  "navbar-nav",
  "nav-link",
  "nav-item",
  "btn",
  /^btn-\w+$/,
  "btn-primary",
  "btn-secondary",
  "btn-success",
  "btn-danger",
  "btn-warning",
  "btn-info",
  "btn-light",
  "btn-dark",
  "card",
  "card-body",
  "card-header",
  "card-footer",
  "card-title",
  "card-text",
  "card-img",
  "card-img-top",
  "modal",
  "modal-dialog",
  "modal-content",
  "modal-header",
  "modal-body",
  "modal-footer",
  "alert",
  /^alert-\w+$/,
  "badge",
  /^badge-\w+$/,
  "form-control",
  "form-group",
  "form-label",
  "form-check",
  "form-select",
  "table",
  "table-striped",
  "table-bordered",
  "table-hover",
  "list-group",
  "list-group-item",
  "dropdown",
  "dropdown-menu",
  "dropdown-item",
  "dropdown-toggle",
  "accordion",
  "accordion-item",
  "accordion-header",
  "accordion-body",
  // Layout
  "container",
  "container-fluid",
  "container-sm",
  "container-md",
  "container-lg",
  "container-xl",
  "row",
  "col",
  /^col-\d+$/,
  /^col-md-\d+$/,
  /^col-lg-\d+$/,
  /^col-sm-\d+$/,
  /^col-xl-\d+$/,
  // Utilities
  "d-flex",
  "d-grid",
  "d-block",
  "d-inline",
  "d-none",
  "justify-content-center",
  "justify-content-between",
  "justify-content-start",
  "justify-content-end",
  "align-items-center",
  "align-items-start",
  "align-items-end",
  /^mt-\d+$/,
  /^mb-\d+$/,
  /^ms-\d+$/,
  /^me-\d+$/,
  /^mx-\d+$/,
  /^my-\d+$/,
  /^pt-\d+$/,
  /^pb-\d+$/,
  /^ps-\d+$/,
  /^pe-\d+$/,
  /^px-\d+$/,
  /^py-\d+$/,
  /^text-\w+$/,
  /^bg-\w+$/,
];

/**
 * CSS Modules検出パターン
 * 複数の形式に対応:
 * 1. 従来形式: component_class__hash (e.g., Header_title__abc123)
 * 2. GitHub/Next.js形式: ComponentName-module__className--hash (e.g., MarketingNavigation-module__nav--jA9Zq)
 * 3. Vite形式: _class_hash (e.g., _title_1a2b3)
 * 4. Webpack 5形式: ComponentModule-class-hash (e.g., HeaderModule-title-abc12)
 */
const CSS_MODULES_PATTERNS = [
  // 従来形式: component_class__hash
  /^[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z][a-zA-Z0-9]*__[a-zA-Z0-9]{5,}$/,
  // GitHub/Next.js形式: ComponentName-module__className--hash
  /^[a-zA-Z][a-zA-Z0-9]*-module__[a-zA-Z][a-zA-Z0-9_-]*--[a-zA-Z0-9]{4,}$/,
  // 汎用形式: ComponentName__className--hash (moduleなし)
  /^[a-zA-Z][a-zA-Z0-9-]*__[a-zA-Z][a-zA-Z0-9_-]*--[a-zA-Z0-9]{4,}$/,
  // Vite形式: _class_hash
  /^_[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9]{5,}$/,
];

/**
 * styled-components / Emotion検出パターン
 */
const STYLED_COMPONENTS_PATTERNS = [
  /^sc-[a-zA-Z0-9]+$/, // styled-components: sc-xyz123
  /^css-[a-zA-Z0-9]+$/, // Emotion: css-xyz123
  /^emotion-[a-zA-Z0-9]+$/, // Emotion: emotion-xyz123
  /^e[a-z0-9]{6,}$/, // Emotion hash classes
];

// =====================================================
// No-Code Tools / Additional Framework Patterns
// =====================================================

/**
 * Webflow CDN検出パターン
 */
const WEBFLOW_CDN_PATTERNS = [
  "assets.website-files.com",
  "uploads-ssl.webflow.com",
  "global-uploads.webflow.com",
  "d3e54v103j8qbb.cloudfront.net", // Webflow CDN
];

/**
 * Webflowクラス検出パターン
 * Webflowは .w-* クラスパターンを使用
 * 3つ以上マッチで確定（高信頼度）
 */
const WEBFLOW_CLASS_PATTERNS: (string | RegExp)[] = [
  // Layout
  /^w-container$/,
  /^w-row$/,
  /^w-col$/,
  /^w-col-\d+$/,
  /^w-layout-grid$/,
  /^w-layout-\w+$/, // w-layout-* variants
  // Display/Inline
  /^w-inline-block$/,
  /^w-inline$/,
  /^w-block$/,
  // Navigation
  /^w-nav$/,
  /^w-nav-brand$/,
  /^w-nav-menu$/,
  /^w-nav-link$/,
  /^w-nav-button$/,
  /^w-nav-overlay$/,
  /^w-icon-nav-menu$/,
  // Form
  /^w-form$/,
  /^w-form-\w+$/, // w-form-done, w-form-fail, etc.
  /^w-input$/,
  /^w-button$/,
  /^w-select$/,
  /^w-checkbox$/,
  /^w-checkbox-input$/,
  /^w-radio$/,
  /^w-radio-input$/,
  /^w-file-upload$/,
  /^w-file-upload-\w+$/,
  // Slider
  /^w-slider$/,
  /^w-slide$/,
  /^w-slider-arrow-left$/,
  /^w-slider-arrow-right$/,
  /^w-slider-nav$/,
  /^w-slider-dot$/,
  /^w-slider-mask$/,
  // Tabs
  /^w-tabs$/,
  /^w-tab-menu$/,
  /^w-tab-link$/,
  /^w-tab-content$/,
  /^w-tab-pane$/,
  // Lightbox
  /^w-lightbox$/,
  /^w-lightbox-thumbnail$/,
  /^w-lightbox-\w+$/,
  // Dropdown
  /^w-dropdown$/,
  /^w-dropdown-toggle$/,
  /^w-dropdown-list$/,
  /^w-dropdown-link$/,
  /^w-dropdown-btn$/,
  // Rich text
  /^w-richtext$/,
  /^w-richtext-\w+$/,
  // Embed
  /^w-embed$/,
  /^w-embed-\w+$/,
  // Video
  /^w-background-video$/,
  /^w-video$/,
  /^w-video-\w+$/,
  // State classes (w--current, w--open, etc.)
  /^w--current$/,
  /^w--open$/,
  /^w--active$/,
  /^w--redirecting-to-tab$/,
  /^w--tab-active$/,
  // Modifier classes (w-mod-*)
  /^w-mod-\w+$/,
  /^w-mod-touch$/,
  /^w-mod-js$/,
  // Responsive hiding
  /^w-hidden-\w+$/,
  /^w-hidden$/,
  // Condition classes
  /^w-condition-invisible$/,
  // Dynamic list
  /^w-dyn-list$/,
  /^w-dyn-item$/,
  /^w-dyn-items$/,
  /^w-dyn-bind-empty$/,
  // Commerce
  /^w-commerce-\w+$/,
];

/**
 * jQuery UI CDN検出パターン
 */
const JQUERY_UI_CDN_PATTERNS = [
  "code.jquery.com/ui",
  "jquery-ui.min.js",
  "jquery-ui.js",
  "jquery-ui.min.css",
  "jquery-ui.css",
  "themes/base/jquery-ui",
];

/**
 * jQuery UIクラス検出パターン
 * jQuery UIは ui-* クラスパターンを使用
 */
const JQUERY_UI_CLASS_PATTERNS: (string | RegExp)[] = [
  // Core
  /^ui-widget$/,
  /^ui-widget-header$/,
  /^ui-widget-content$/,
  /^ui-widget-overlay$/,
  /^ui-helper-\w+$/,
  /^ui-corner-\w+$/,
  // States
  /^ui-state-default$/,
  /^ui-state-hover$/,
  /^ui-state-focus$/,
  /^ui-state-active$/,
  /^ui-state-highlight$/,
  /^ui-state-error$/,
  /^ui-state-disabled$/,
  // Buttons
  /^ui-button$/,
  /^ui-button-\w+$/,
  // Dialog
  /^ui-dialog$/,
  /^ui-dialog-\w+$/,
  // Accordion
  /^ui-accordion$/,
  /^ui-accordion-\w+$/,
  // Tabs
  /^ui-tabs$/,
  /^ui-tabs-\w+$/,
  // Menu
  /^ui-menu$/,
  /^ui-menu-\w+$/,
  // Autocomplete
  /^ui-autocomplete$/,
  /^ui-autocomplete-\w+$/,
  // Datepicker
  /^ui-datepicker$/,
  /^ui-datepicker-\w+$/,
  // Progressbar
  /^ui-progressbar$/,
  /^ui-progressbar-\w+$/,
  // Slider (jQuery UI Slider)
  /^ui-slider$/,
  /^ui-slider-\w+$/,
  // Sortable/Draggable
  /^ui-sortable$/,
  /^ui-draggable$/,
  /^ui-droppable$/,
  /^ui-resizable$/,
  /^ui-selectable$/,
];

/**
 * Squarespace CDN検出パターン
 */
const SQUARESPACE_CDN_PATTERNS = [
  "static1.squarespace.com",
  "static.squarespace.com",
  "squarespace-cdn.com",
  "sqsp.io",
];

/**
 * Squarespaceクラス検出パターン
 * Squarespaceは sqs-* クラスパターンを使用
 */
const SQUARESPACE_CLASS_PATTERNS: (string | RegExp)[] = [
  // Layout
  /^sqs-layout$/,
  /^sqs-row$/,
  /^sqs-col-\d+$/,
  /^sqs-grid-\d+$/,
  // Blocks
  /^sqs-block$/,
  /^sqs-block-\w+$/,
  /^sqs-block-content$/,
  // Gallery
  /^sqs-gallery$/,
  /^sqs-gallery-\w+$/,
  // Slide
  /^sqs-slide$/,
  /^sqs-slide-\w+$/,
  // Other
  /^sqs-image$/,
  /^sqs-title$/,
  /^sqs-button$/,
  /^sqs-video$/,
  /^sqs-audio$/,
  /^sqs-html-content$/,
];

/**
 * Framer検出パターン（クラス + data-framer-* 属性）
 */
const FRAMER_CLASS_PATTERNS: (string | RegExp)[] = [
  // Class patterns
  /^framer-[a-zA-Z0-9]+$/, // framer-1abc23
  /^framer-text$/,
  /^framer-container$/,
  /^framer-button$/,
  /^framer-link$/,
  /^framer-image$/,
  /^framer-video$/,
  /^framer-nav$/,
  /^framer-rich-text-container$/,
];

/**
 * Framer data-* 属性検出パターン
 */
const FRAMER_DATA_ATTRIBUTES = [
  "data-framer-name",
  "data-framer-component-type",
  "data-framer-appear-id",
  "data-framer-generated",
];

/**
 * Elementor CDN検出パターン
 */
const ELEMENTOR_CDN_PATTERNS = [
  "/wp-content/plugins/elementor/",
  "/wp-content/plugins/elementor-pro/",
  "elementor/assets/",
];

/**
 * Elementorクラス検出パターン
 * Elementorは elementor-* クラスパターンを使用
 */
const ELEMENTOR_CLASS_PATTERNS: (string | RegExp)[] = [
  // Core
  /^elementor$/,
  /^elementor-\d+$/, // elementor-123
  /^elementor-page$/,
  /^elementor-kit-\d+$/,
  // Sections
  /^elementor-section$/,
  /^elementor-section-\w+$/,
  /^elementor-top-section$/,
  /^elementor-inner-section$/,
  // Columns
  /^elementor-column$/,
  /^elementor-col-\d+$/,
  /^elementor-column-gap-\w+$/,
  // Widgets
  /^elementor-widget$/,
  /^elementor-widget-\w+$/,
  /^elementor-widget-container$/,
  /^elementor-widget-wrap$/,
  // Container
  /^elementor-container$/,
  // Elements
  /^elementor-heading-title$/,
  /^elementor-button$/,
  /^elementor-button-\w+$/,
  /^elementor-image$/,
  /^elementor-size-\w+$/,
  /^elementor-text-editor$/,
];

/**
 * Wixクラス検出パターン
 * Wixは wixui-* や comp-* などのパターンを使用
 */
const WIX_CLASS_PATTERNS: (string | RegExp)[] = [
  // wixui components
  /^wixui-\w+$/,
  /^wixui-vertical-menu$/,
  /^wixui-vertical-menu__\w+$/,
  /^wixui-button$/,
  /^wixui-button__\w+$/,
  /^wixui-rich-text$/,
  /^wixui-rich-text__\w+$/,
  // comp- patterns
  /^comp-\w+$/,
  // font classes (Wix specific)
  /^font_\d+$/,
  // _3xyz hash classes (common in Wix)
  /^_[0-9a-zA-Z]{4,}$/,
];

/**
 * Wix構造検出パターン（ID）
 */
const WIX_STRUCTURE_IDS = [
  "SITE_CONTAINER",
  "SITE_HEADER",
  "SITE_PAGES",
  "SITE_FOOTER",
  "masterPage",
  "PAGES_CONTAINER",
];

/**
 * フレームワークスコア
 */
interface FrameworkScore {
  framework: CssFramework;
  score: number;
  evidence: string[];
  cdnDetected: boolean;
}

/**
 * クラス名がパターンにマッチするかチェック
 */
function matchesPattern(className: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return className === pattern;
  }
  return pattern.test(className);
}

/**
 * HTMLからCSSフレームワークを検出
 *
 * 検出対象:
 * - Tailwind CSS（CDNスクリプト/リンク、ユーティリティクラス）
 * - Bootstrap（CDNリンク、コンポーネントクラス）
 * - CSS Modules（[component]_[class]__[hash] 形式）
 * - styled-components/Emotion（sc-*, css-* 形式）
 * - Webflow（.w-* クラスパターン）
 * - jQuery UI（.ui-* クラスパターン）
 * - Squarespace（.sqs-* クラスパターン）
 * - Framer（.framer-* クラス、data-framer-* 属性）
 * - Elementor（.elementor-* クラスパターン）
 * - Wix（.wixui-* クラス、SITE_* 構造）
 * - vanilla CSS（上記に該当しない場合）
 *
 * @param $ - CheerioAPI
 * @param html - 元のHTML文字列（CDN検出用）
 * @returns CSSフレームワーク検出結果
 */
function detectCssFramework($: CheerioAPI, html: string): CssFrameworkDetection {
  const scores: FrameworkScore[] = [
    { framework: "tailwind", score: 0, evidence: [], cdnDetected: false },
    { framework: "bootstrap", score: 0, evidence: [], cdnDetected: false },
    { framework: "css_modules", score: 0, evidence: [], cdnDetected: false },
    { framework: "styled_components", score: 0, evidence: [], cdnDetected: false },
    { framework: "webflow", score: 0, evidence: [], cdnDetected: false },
    { framework: "jquery_ui", score: 0, evidence: [], cdnDetected: false },
    { framework: "squarespace", score: 0, evidence: [], cdnDetected: false },
    { framework: "framer", score: 0, evidence: [], cdnDetected: false },
    { framework: "elementor", score: 0, evidence: [], cdnDetected: false },
    { framework: "wix", score: 0, evidence: [], cdnDetected: false },
  ];

  const getScore = (framework: CssFramework): FrameworkScore =>
    scores.find((s) => s.framework === framework)!;

  // =====================================================
  // 1. CDN/外部参照検出（高信頼度）
  // =====================================================

  // Tailwind CDN検出
  for (const pattern of TAILWIND_CDN_PATTERNS) {
    if (html.includes(pattern)) {
      getScore("tailwind").score += 50;
      getScore("tailwind").evidence.push(`CDN detected: ${pattern}`);
      getScore("tailwind").cdnDetected = true;
    }
  }

  // Bootstrap CDN検出
  for (const pattern of BOOTSTRAP_CDN_PATTERNS) {
    if (html.includes(pattern)) {
      getScore("bootstrap").score += 50;
      getScore("bootstrap").evidence.push(`CDN detected: ${pattern}`);
      getScore("bootstrap").cdnDetected = true;
    }
  }

  // Webflow CDN検出
  for (const pattern of WEBFLOW_CDN_PATTERNS) {
    if (html.includes(pattern)) {
      getScore("webflow").score += 50;
      getScore("webflow").evidence.push(`Webflow CDN detected: ${pattern}`);
      getScore("webflow").cdnDetected = true;
    }
  }

  // jQuery UI CDN検出
  for (const pattern of JQUERY_UI_CDN_PATTERNS) {
    if (html.includes(pattern)) {
      getScore("jquery_ui").score += 50;
      getScore("jquery_ui").evidence.push(`jQuery UI CDN detected: ${pattern}`);
      getScore("jquery_ui").cdnDetected = true;
    }
  }

  // Squarespace CDN検出
  for (const pattern of SQUARESPACE_CDN_PATTERNS) {
    if (html.includes(pattern)) {
      getScore("squarespace").score += 50;
      getScore("squarespace").evidence.push(`Squarespace CDN detected: ${pattern}`);
      getScore("squarespace").cdnDetected = true;
    }
  }

  // Elementor CDN検出
  for (const pattern of ELEMENTOR_CDN_PATTERNS) {
    if (html.includes(pattern)) {
      getScore("elementor").score += 50;
      getScore("elementor").evidence.push(`Elementor plugin detected: ${pattern}`);
      getScore("elementor").cdnDetected = true;
    }
  }

  // =====================================================
  // 2. data-* 属性検出（Framer専用）
  // =====================================================

  let framerDataAttrCount = 0;
  for (const attr of FRAMER_DATA_ATTRIBUTES) {
    const elements = $(`[${attr}]`);
    if (elements.length > 0) {
      framerDataAttrCount += elements.length;
    }
  }
  if (framerDataAttrCount > 0) {
    const attrScore = Math.min(framerDataAttrCount * 10, 60);
    getScore("framer").score += attrScore;
    getScore("framer").evidence.push(`Found ${framerDataAttrCount} Framer data-* attributes`);
  }

  // =====================================================
  // 3. Wix構造検出（ID ベース）
  // =====================================================

  let wixStructureCount = 0;
  for (const id of WIX_STRUCTURE_IDS) {
    if ($(`#${id}`).length > 0) {
      wixStructureCount++;
    }
  }
  if (wixStructureCount >= 2) {
    const structureScore = Math.min(wixStructureCount * 15, 45);
    getScore("wix").score += structureScore;
    getScore("wix").evidence.push(`Found ${wixStructureCount} Wix structure IDs (SITE_*)`);
  }

  // =====================================================
  // 4. クラス名パターン検出
  // =====================================================

  // 全クラス名を収集
  const allClasses = new Set<string>();
  $("[class]").each((_, elem) => {
    const classAttr = $(elem).attr("class");
    if (classAttr) {
      for (const className of classAttr.split(/\s+/)) {
        const trimmed = className.trim();
        if (trimmed.length > 0) {
          allClasses.add(trimmed);
        }
      }
    }
  });

  // クラス名カウンター
  let tailwindClassCount = 0;
  let bootstrapClassCount = 0;
  let cssModulesClassCount = 0;
  let styledComponentsClassCount = 0;
  let webflowClassCount = 0;
  let jqueryUiClassCount = 0;
  let squarespaceClassCount = 0;
  let framerClassCount = 0;
  let elementorClassCount = 0;
  let wixClassCount = 0;

  const cssModulesExamples: string[] = [];
  const styledComponentsExamples: string[] = [];
  const webflowExamples: string[] = [];
  const jqueryUiExamples: string[] = [];
  const squarespaceExamples: string[] = [];
  const framerExamples: string[] = [];
  const elementorExamples: string[] = [];
  const wixExamples: string[] = [];

  for (const className of allClasses) {
    // Tailwind検出
    for (const pattern of TAILWIND_UTILITY_PATTERNS) {
      if (matchesPattern(className, pattern)) {
        tailwindClassCount++;
        break;
      }
    }

    // Bootstrap検出
    for (const pattern of BOOTSTRAP_CLASS_PATTERNS) {
      if (matchesPattern(className, pattern)) {
        bootstrapClassCount++;
        break;
      }
    }

    // CSS Modules検出（複数パターンに対応）
    for (const cssModulesPattern of CSS_MODULES_PATTERNS) {
      if (cssModulesPattern.test(className)) {
        cssModulesClassCount++;
        if (cssModulesExamples.length < 3) {
          cssModulesExamples.push(className);
        }
        break;
      }
    }

    // styled-components / Emotion検出
    for (const pattern of STYLED_COMPONENTS_PATTERNS) {
      if (pattern.test(className)) {
        styledComponentsClassCount++;
        if (styledComponentsExamples.length < 3) {
          styledComponentsExamples.push(className);
        }
        break;
      }
    }

    // Webflow検出
    for (const pattern of WEBFLOW_CLASS_PATTERNS) {
      if (matchesPattern(className, pattern)) {
        webflowClassCount++;
        if (webflowExamples.length < 3) {
          webflowExamples.push(className);
        }
        break;
      }
    }

    // jQuery UI検出
    for (const pattern of JQUERY_UI_CLASS_PATTERNS) {
      if (matchesPattern(className, pattern)) {
        jqueryUiClassCount++;
        if (jqueryUiExamples.length < 3) {
          jqueryUiExamples.push(className);
        }
        break;
      }
    }

    // Squarespace検出
    for (const pattern of SQUARESPACE_CLASS_PATTERNS) {
      if (matchesPattern(className, pattern)) {
        squarespaceClassCount++;
        if (squarespaceExamples.length < 3) {
          squarespaceExamples.push(className);
        }
        break;
      }
    }

    // Framer検出
    for (const pattern of FRAMER_CLASS_PATTERNS) {
      if (matchesPattern(className, pattern)) {
        framerClassCount++;
        if (framerExamples.length < 3) {
          framerExamples.push(className);
        }
        break;
      }
    }

    // Elementor検出
    for (const pattern of ELEMENTOR_CLASS_PATTERNS) {
      if (matchesPattern(className, pattern)) {
        elementorClassCount++;
        if (elementorExamples.length < 3) {
          elementorExamples.push(className);
        }
        break;
      }
    }

    // Wix検出
    for (const pattern of WIX_CLASS_PATTERNS) {
      if (matchesPattern(className, pattern)) {
        wixClassCount++;
        if (wixExamples.length < 3) {
          wixExamples.push(className);
        }
        break;
      }
    }
  }

  // =====================================================
  // 5. スコア計算
  // =====================================================

  // Tailwind: ユーティリティクラス数に基づくスコア
  if (tailwindClassCount > 0) {
    // 10クラス以上で顕著、30クラス以上で確実
    const classScore = Math.min(tailwindClassCount * 2, 50);
    getScore("tailwind").score += classScore;
    getScore("tailwind").evidence.push(`Found ${tailwindClassCount} Tailwind utility classes`);
  }

  // Bootstrap: コンポーネントクラス数に基づくスコア
  if (bootstrapClassCount > 0) {
    const classScore = Math.min(bootstrapClassCount * 3, 50);
    getScore("bootstrap").score += classScore;
    getScore("bootstrap").evidence.push(`Found ${bootstrapClassCount} Bootstrap component classes`);
  }

  // CSS Modules: ハッシュ付きクラス数に基づくスコア
  if (cssModulesClassCount > 0) {
    const classScore = Math.min(cssModulesClassCount * 5, 70);
    getScore("css_modules").score += classScore;
    getScore("css_modules").evidence.push(
      `Found ${cssModulesClassCount} CSS Modules pattern classes (e.g., ${cssModulesExamples.join(", ")})`
    );
  }

  // styled-components: パターンマッチ数に基づくスコア
  if (styledComponentsClassCount > 0) {
    const classScore = Math.min(styledComponentsClassCount * 5, 70);
    getScore("styled_components").score += classScore;
    getScore("styled_components").evidence.push(
      `Found ${styledComponentsClassCount} styled-components/Emotion classes (e.g., ${styledComponentsExamples.join(", ")})`
    );
  }

  // Webflow: w-* クラス数に基づくスコア
  if (webflowClassCount > 0) {
    const classScore = Math.min(webflowClassCount * 5, 70);
    getScore("webflow").score += classScore;
    getScore("webflow").evidence.push(
      `Found ${webflowClassCount} Webflow classes (e.g., ${webflowExamples.join(", ")})`
    );
  }

  // jQuery UI: ui-* クラス数に基づくスコア
  if (jqueryUiClassCount > 0) {
    const classScore = Math.min(jqueryUiClassCount * 5, 70);
    getScore("jquery_ui").score += classScore;
    getScore("jquery_ui").evidence.push(
      `Found ${jqueryUiClassCount} jQuery UI classes (e.g., ${jqueryUiExamples.join(", ")})`
    );
  }

  // Squarespace: sqs-* クラス数に基づくスコア
  if (squarespaceClassCount > 0) {
    const classScore = Math.min(squarespaceClassCount * 5, 70);
    getScore("squarespace").score += classScore;
    getScore("squarespace").evidence.push(
      `Found ${squarespaceClassCount} Squarespace classes (e.g., ${squarespaceExamples.join(", ")})`
    );
  }

  // Framer: framer-* クラス数に基づくスコア
  if (framerClassCount > 0) {
    const classScore = Math.min(framerClassCount * 5, 70);
    getScore("framer").score += classScore;
    getScore("framer").evidence.push(
      `Found ${framerClassCount} Framer classes (e.g., ${framerExamples.join(", ")})`
    );
  }

  // Elementor: elementor-* クラス数に基づくスコア
  if (elementorClassCount > 0) {
    const classScore = Math.min(elementorClassCount * 5, 70);
    getScore("elementor").score += classScore;
    getScore("elementor").evidence.push(
      `Found ${elementorClassCount} Elementor classes (e.g., ${elementorExamples.join(", ")})`
    );
  }

  // Wix: comp-* / style-* クラス数に基づくスコア
  if (wixClassCount > 0) {
    const classScore = Math.min(wixClassCount * 5, 70);
    getScore("wix").score += classScore;
    getScore("wix").evidence.push(
      `Found ${wixClassCount} Wix classes (e.g., ${wixExamples.join(", ")})`
    );
  }

  // =====================================================
  // 4. CSS変数検出
  // =====================================================

  const cssVariablesResult = detectCssVariables(html);

  // =====================================================
  // 5. 結果決定
  // =====================================================

  // 最高スコアのフレームワークを選択
  const sortedScores = [...scores].sort((a, b) => b.score - a.score);
  const topScore = sortedScores[0];

  // スコアが低すぎる場合はvanilla
  if (!topScore || topScore.score < 10) {
    const vanillaResult: CssFrameworkDetection = {
      framework: "vanilla",
      confidence: 0.3,
      evidence: ["No significant CSS framework patterns detected"],
    };

    // CSS変数が検出された場合のみcompositeを追加
    if (cssVariablesResult.detected) {
      vanillaResult.composite = {
        primary: "vanilla",
        secondary: [],
        confidenceMap: { vanilla: 0.3 },
        hasCssVariables: true,
        cssVariablesConfidence: cssVariablesResult.confidence,
      };
      vanillaResult.evidence.push(
        `Detected ${cssVariablesResult.variableCount} CSS custom properties (e.g., ${cssVariablesResult.examples.slice(0, 3).join(", ")})`
      );
    }

    return vanillaResult;
  }

  // 信頼度計算（0-1）
  // CDN検出 → 高信頼度、クラスパターンのみ → 中程度
  let confidence: number;
  if (topScore.cdnDetected) {
    confidence = Math.min(0.9 + (topScore.score - 50) * 0.002, 0.99);
  } else {
    // クラスパターンのみの場合、スコアに基づく信頼度
    confidence = Math.min(0.5 + topScore.score * 0.01, 0.89);
  }

  // =====================================================
  // 6. 複合検出結果の構築
  // =====================================================

  const result: CssFrameworkDetection = {
    framework: topScore.framework,
    confidence: Math.round(confidence * 100) / 100,
    evidence: topScore.evidence,
  };

  // セカンダリフレームワークを検出（プライマリの30%以上のスコアがあるもの）
  const secondaryThreshold = topScore.score * 0.3;
  const secondaryFrameworks: CssFramework[] = [];
  const confidenceMap: Partial<Record<CssFramework, number>> = {
    [topScore.framework]: result.confidence,
  };

  for (let i = 1; i < sortedScores.length; i++) {
    const scoreEntry = sortedScores[i];
    if (scoreEntry === undefined) {
      continue;
    }
    if (scoreEntry.score >= secondaryThreshold && scoreEntry.score >= 10) {
      secondaryFrameworks.push(scoreEntry.framework);
      // セカンダリの信頼度計算
      let secondaryConfidence: number;
      if (scoreEntry.cdnDetected) {
        secondaryConfidence = Math.min(0.9 + (scoreEntry.score - 50) * 0.002, 0.99);
      } else {
        secondaryConfidence = Math.min(0.5 + scoreEntry.score * 0.01, 0.89);
      }
      confidenceMap[scoreEntry.framework] = Math.round(secondaryConfidence * 100) / 100;
      // evidenceにセカンダリ検出を追加
      const evidenceText = scoreEntry.evidence[0] ?? "pattern matches";
      result.evidence.push(
        `Also detected ${scoreEntry.framework}: ${evidenceText}`
      );
    }
  }

  // 複合検出がある場合（セカンダリフレームワークまたはCSS変数がある場合）
  if (secondaryFrameworks.length > 0 || cssVariablesResult.detected) {
    result.composite = {
      primary: topScore.framework,
      secondary: secondaryFrameworks,
      confidenceMap,
      hasCssVariables: cssVariablesResult.detected,
    };

    if (cssVariablesResult.detected) {
      result.composite.cssVariablesConfidence = cssVariablesResult.confidence;
      result.evidence.push(
        `Detected ${cssVariablesResult.variableCount} CSS custom properties (e.g., ${cssVariablesResult.examples.slice(0, 3).join(", ")})`
      );
    }
  }

  return result;
}

/**
 * CSS変数（カスタムプロパティ）を検出
 */
interface CssVariablesDetection {
  detected: boolean;
  confidence: number;
  variableCount: number;
  examples: string[];
}

function detectCssVariables(html: string): CssVariablesDetection {
  // var(--*) パターンを検出（クラス属性、style属性、<style>タグ内）
  const varPattern = /var\s*\(\s*(--[\w-]+)\s*(?:,\s*[^)]+)?\s*\)/g;
  const definitionPattern = /(--[\w-]+)\s*:/g;

  const usedVariables = new Set<string>();
  const definedVariables = new Set<string>();

  // var(--*) の使用を検出
  let match: RegExpExecArray | null;
  while ((match = varPattern.exec(html)) !== null) {
    const varName = match[1];
    if (varName !== undefined) {
      usedVariables.add(varName);
    }
  }

  // --variable: の定義を検出
  while ((match = definitionPattern.exec(html)) !== null) {
    const varName = match[1];
    if (varName !== undefined) {
      definedVariables.add(varName);
    }
  }

  const allVariables = new Set([...usedVariables, ...definedVariables]);
  const variableCount = allVariables.size;
  const examples = Array.from(allVariables).slice(0, 5);

  if (variableCount === 0) {
    return {
      detected: false,
      confidence: 0,
      variableCount: 0,
      examples: [],
    };
  }

  // 信頼度計算
  // 3個以上で中程度、10個以上で高信頼度
  let confidence: number;
  if (variableCount >= 10) {
    confidence = Math.min(0.8 + variableCount * 0.01, 0.95);
  } else if (variableCount >= 3) {
    confidence = 0.6 + variableCount * 0.03;
  } else {
    confidence = 0.4 + variableCount * 0.1;
  }

  return {
    detected: true,
    confidence: Math.round(confidence * 100) / 100,
    variableCount,
    examples,
  };
}

/**
 * CoreDetectedSection を DetectedSection に変換
 *
 * @param coreSection - コアのセクション
 * @param includeContent - コンテンツを含めるか
 * @param includeStyles - スタイルを含めるか
 * @param sectionIndex - セクションインデックス（computed styles マッチング用）
 * @param computedStyles - Computed Styles配列（オプション）
 * @returns 変換されたDetectedSection（computed styles適用済みの場合はhtmlSnippetにインラインスタイル含む）
 */
function convertSection(
  coreSection: CoreDetectedSection,
  includeContent: boolean,
  includeStyles: boolean,
  sectionIndex?: number,
  computedStyles?: ComputedStyleInfo[]
): DetectedSection {
  const section: DetectedSection = {
    id: uuidv7(),
    type: coreSection.type,
    confidence: coreSection.confidence,
    position: {
      startY: coreSection.position.startY,
      endY: coreSection.position.endY,
      height: coreSection.position.height,
    },
  };

  // 要素情報 - exactOptionalPropertyTypes対応
  const element: SectionElement = {
    tagName: coreSection.element.tagName,
  };
  if (coreSection.element.selector !== undefined) {
    element.selector = coreSection.element.selector;
  }
  if (coreSection.element.classes !== undefined) {
    element.classes = coreSection.element.classes;
  }
  if (coreSection.element.id !== undefined) {
    element.id = coreSection.element.id;
  }
  section.element = element;

  // コンテンツ情報（オプション）- exactOptionalPropertyTypes対応
  if (includeContent && coreSection.content) {
    const content: SectionContent = {};
    if (coreSection.content.headings !== undefined) {
      content.headings = coreSection.content.headings;
    }
    if (coreSection.content.paragraphs !== undefined) {
      content.paragraphs = coreSection.content.paragraphs;
    }
    if (coreSection.content.links !== undefined) {
      content.links = coreSection.content.links;
    }
    if (coreSection.content.images !== undefined) {
      // images の alt プロパティも exactOptionalPropertyTypes 対応
      content.images = coreSection.content.images.map((img) => {
        const result: { src: string; alt?: string } = { src: img.src };
        if (img.alt !== undefined) {
          result.alt = img.alt;
        }
        return result;
      });
    }
    if (coreSection.content.buttons !== undefined) {
      content.buttons = coreSection.content.buttons.map((b) => {
        const result: { text: string; type?: string } = { text: b.text };
        if (b.type !== undefined) {
          result.type = b.type;
        }
        return result;
      });
    }
    section.content = content;
  }

  // スタイル情報（オプション）- exactOptionalPropertyTypes対応
  if (includeStyles && coreSection.style) {
    const style: SectionStyle = {};
    if (coreSection.style.backgroundColor !== undefined) {
      style.backgroundColor = coreSection.style.backgroundColor;
    }
    if (coreSection.style.textColor !== undefined) {
      style.textColor = coreSection.style.textColor;
    }
    if (coreSection.style.hasGradient !== undefined) {
      style.hasGradient = coreSection.style.hasGradient;
    }
    if (coreSection.style.hasImage !== undefined) {
      style.hasImage = coreSection.style.hasImage;
    }
    section.style = style;
  }

  // HTMLスニペット（存在する場合のみ）- exactOptionalPropertyTypes対応
  if (coreSection.htmlSnippet !== undefined) {
    let htmlSnippet = coreSection.htmlSnippet;

    // Computed Styles をインラインスタイルとして適用
    if (computedStyles && computedStyles.length > 0 && sectionIndex !== undefined) {
      const matchingStyles = findMatchingComputedStyles(sectionIndex, computedStyles);
      if (matchingStyles) {
        htmlSnippet = applyComputedStylesToHtml(htmlSnippet, matchingStyles);

        if (isDevelopment()) {
          logger.debug("[convertSection] Applied computed styles to section", {
            sectionIndex,
            sectionType: coreSection.type,
            childCount: matchingStyles.children?.length ?? 0,
          });
        }
      }
    }

    section.htmlSnippet = htmlSnippet;
  }

  return section;
}

// =====================================================
// LayoutAnalyzerService クラス
// =====================================================

/**
 * レイアウト解析サービス
 *
 * Cheerioと@reftrix/webdesign-coreを使用してHTMLを解析し、
 * セクション、グリッド、タイポグラフィ、色情報を抽出する
 */
export class LayoutAnalyzerService {
  private sectionDetector: SectionDetector;

  constructor() {
    this.sectionDetector = new SectionDetector({
      detectLandmarks: true,
      detectSemanticTags: true,
      detectVisualSections: true,
      maxSectionsPerType: 30,
    });
  }

  /**
   * HTMLを解析してレイアウト情報を抽出
   *
   * @param html - 解析対象のHTML
   * @param options - 解析オプション
   * @returns レイアウト解析結果
   */
  async analyze(html: string, options: LayoutAnalysisOptions = {}): Promise<LayoutAnalysisResult> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.debug("[LayoutAnalyzerService] analyze called", {
        htmlLength: html.length,
        options,
      });
    }

    try {
      // 空のHTMLをチェック
      if (!html || html.trim().length === 0) {
        return {
          success: true,
          sections: [],
          sectionCount: 0,
          sectionTypes: {},
          cssFramework: {
            framework: "vanilla",
            confidence: 0.3,
            evidence: ["Empty or minimal HTML content"],
          },
          processingTimeMs: Date.now() - startTime,
        };
      }

      // Cheerioでパース
      const $ = cheerio.load(html);

      // セクション検出（@reftrix/webdesign-core使用）
      let coreSections: CoreDetectedSection[];
      try {
        coreSections = await this.sectionDetector.detect(html);
      } catch (detectionError) {
        // 検出エラーでも続行（空の配列で続ける）
        if (isDevelopment()) {
          logger.warn("[LayoutAnalyzerService] Section detection error", {
            error: detectionError,
          });
        }
        coreSections = [];
      }

      // セクションを変換
      const includeContent = options.includeContent ?? false;
      const includeStyles = options.includeStyles ?? false;

      let sections = coreSections.map((cs, index) =>
        convertSection(cs, includeContent, includeStyles, index, options.computedStyles)
      );

      // Computed styles 適用数のカウント
      let computedStylesAppliedCount = 0;
      if (options.computedStyles && options.computedStyles.length > 0) {
        for (let i = 0; i < sections.length; i++) {
          if (findMatchingComputedStyles(i, options.computedStyles)) {
            computedStylesAppliedCount++;
          }
        }
      }

      // maxSections制限
      if (options.maxSections !== undefined && sections.length > options.maxSections) {
        sections = sections.slice(0, options.maxSections);
      }

      // セクションタイプ別カウント
      const sectionTypes: Record<string, number> = {};
      for (const section of sections) {
        sectionTypes[section.type] = (sectionTypes[section.type] || 0) + 1;
      }

      // グリッド情報
      const grid = detectGridLayout($, html);

      // タイポグラフィ情報
      const typography = extractTypography($, html);

      // CSS抽出（外部CSS取得オプション対応）
      let cssSnippet: string;
      let externalCssFetch: ExternalCssFetchResult | undefined;
      let externalCssContent: string | undefined;

      if (options.externalCss?.fetchExternalCss && options.externalCss.baseUrl) {
        // 外部CSSファイルの内容を取得
        const cssResult = await extractCssWithExternalContent($, options.externalCss);
        cssSnippet = cssResult.cssSnippet;
        externalCssContent =
          cssResult.externalCssContent && cssResult.externalCssContent.trim().length > 0
            ? cssResult.externalCssContent
            : undefined;
        externalCssFetch = cssResult.fetchResult;
      } else {
        // 従来通り参照のみ
        cssSnippet = extractCssSnippet($);
      }

      // 色情報（外部CSSを含めてCSS変数を解決）
      const combinedExternalCss = externalCssContent
        ? [cssSnippet, externalCssContent].filter(Boolean).join("\n\n")
        : undefined;
      const colors = extractColors($, html, combinedExternalCss);

      // CSSフレームワーク検出（外部CSSを含めた場合は再度検出）
      // 外部CSSを取得した場合は、その内容も含めてフレームワーク検出を行う
      let cssFramework: CssFrameworkDetection;
      if (externalCssFetch && externalCssFetch.successCount > 0 && (cssSnippet || externalCssContent)) {
        // 外部CSSの内容を含めたHTMLを構築して検出
        const combinedCss = [cssSnippet, externalCssContent].filter(Boolean).join("\n\n");
        const htmlWithCss = html + `<style>${combinedCss}</style>`;
        cssFramework = detectCssFramework($, htmlWithCss);
      } else {
        cssFramework = detectCssFramework($, html);
      }

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.debug("[LayoutAnalyzerService] analyze completed", {
          sectionCount: sections.length,
          sectionTypes,
          cssFramework: cssFramework.framework,
          cssFrameworkConfidence: cssFramework.confidence,
          externalCssFetch: externalCssFetch
            ? {
                successCount: externalCssFetch.successCount,
                failedCount: externalCssFetch.failedCount,
                totalSize: externalCssFetch.totalSize,
              }
            : undefined,
          computedStylesAppliedCount,
          processingTimeMs,
        });
      }

      // exactOptionalPropertyTypes対応: undefined を代入せずプロパティを省略
      const result: LayoutAnalysisResult = {
        success: true,
        sections,
        sectionCount: sections.length,
        sectionTypes,
        grid,
        typography,
        colors,
        cssSnippet,
        cssFramework,
        processingTimeMs,
      };

      if (externalCssContent) {
        result.externalCssContent = externalCssContent;
      }

      if (externalCssFetch) {
        result.externalCssFetch = externalCssFetch;

        const urls = externalCssFetch.results.map((r) => {
          const size = r.content ? new TextEncoder().encode(r.content).length : undefined;
          const entry: { url: string; size?: number; success?: boolean } = {
            url: r.url,
            success: !!r.content,
          };
          if (size !== undefined) {
            entry.size = size;
          }
          return entry;
        });

        result.externalCssMeta = {
          fetchedCount: externalCssFetch.successCount,
          failedCount: externalCssFetch.failedCount,
          totalSize: externalCssFetch.totalSize,
          urls,
          fetchedAt: new Date().toISOString(),
        };
      }

      // Computed styles が適用された場合のみカウントを追加
      if (computedStylesAppliedCount > 0) {
        result.computedStylesAppliedCount = computedStylesAppliedCount;
      }

      return result;
    } catch (error) {
      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.error("[LayoutAnalyzerService] analyze error", { error });
      }

      return {
        success: true, // エラーでもグレースフルに成功として返す
        sections: [],
        sectionCount: 0,
        sectionTypes: {},
        processingTimeMs,
        error: {
          code: "LAYOUT_ANALYSIS_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }
}

// =====================================================
// デフォルトエクスポート
// =====================================================

/**
 * シングルトンインスタンス
 */
let sharedInstance: LayoutAnalyzerService | null = null;

/**
 * 共有インスタンスを取得
 */
export function getLayoutAnalyzerService(): LayoutAnalyzerService {
  if (!sharedInstance) {
    sharedInstance = new LayoutAnalyzerService();
  }
  return sharedInstance;
}

/**
 * 共有インスタンスをリセット（テスト用）
 */
export function resetLayoutAnalyzerService(): void {
  sharedInstance = null;
}
