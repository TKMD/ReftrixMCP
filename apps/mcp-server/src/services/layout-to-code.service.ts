// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LayoutToCodeService
 * layout.to_code ツール用のサービス実装
 *
 * 機能:
 * - セクションパターンをIDで取得
 * - React/Vue/HTMLコードを生成
 * - TypeScript/JavaScript選択
 * - Tailwind CSS/Vanilla CSS選択
 *
 * @module services/layout-to-code.service
 */

import { isDevelopment, logger } from "../utils/logger";
import type {
  ILayoutToCodeService,
  SectionPattern,
  GeneratedCode,
  CodeGeneratorOptions,
  ComponentInfo,
  SubComponentInfo,
} from "../tools/layout/to-code.tool";
import type { Framework } from "../tools/layout/schemas";
import { convertHtmlToJsx } from "./layout/html-to-jsx-converter";
import { splitIntoComponents } from "./layout/component-splitter";
import { convertToSemanticHtml } from "./layout/semantic-html-converter";

// =====================================================
// インターフェース
// =====================================================

/**
 * PrismaClientインターフェース（部分的）
 */
export interface IPrismaClient {
  sectionPattern: {
    findUnique: (args: {
      where: { id: string };
      include?: Record<string, boolean | Record<string, boolean>>;
    }) => Promise<SectionPatternRecord | null>;
  };
}

/**
 * DBから取得するSectionPatternレコード
 */
interface SectionPatternRecord {
  id: string;
  webPageId: string;
  sectionType: string;
  sectionName: string | null;
  positionIndex: number;
  layoutInfo: unknown;
  visualFeatures: unknown;
  components: unknown; // コンポーネント情報（配列）
  htmlSnippet: string | null;
  /** CSSスニペット（style/link/inline styles） */
  cssSnippet: string | null;
  /** 外部CSSコンテンツ（<link rel="stylesheet">の実コンテンツ） */
  externalCssContent: string | null;
  /** CSSフレームワーク（tailwind, bootstrap, css_modules, styled_components, vanilla, unknown） */
  cssFramework: string | null;
  /** CSSフレームワーク検出メタデータ */
  cssFrameworkMeta: unknown | null;
  textRepresentation: string | null;
  webPage: {
    id: string;
    url: string;
    title: string | null;
    sourceType: string;
    usageScope: string;
  };
}

// =====================================================
// サービスファクトリ（DI用）
// =====================================================

let prismaClientFactory: (() => IPrismaClient) | null = null;

/**
 * PrismaClientファクトリを設定
 */
export function setLayoutToCodePrismaClientFactory(factory: () => IPrismaClient): void {
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット
 */
export function resetLayoutToCodePrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * DBレコードをSectionPatternに変換
 */
function recordToSectionPattern(record: SectionPatternRecord): SectionPattern {
  const layoutInfo =
    typeof record.layoutInfo === "object" && record.layoutInfo !== null
      ? (record.layoutInfo as Record<string, unknown>)
      : {};

  const visualFeatures =
    typeof record.visualFeatures === "object" && record.visualFeatures !== null
      ? (record.visualFeatures as Record<string, unknown>)
      : {};

  // components を配列として取得（デフォルトは空配列）
  // 型アサーションでComponentInfo[]に変換（DBからの生データは型が不完全な可能性がある）
  const rawComponents = Array.isArray(record.components)
    ? (record.components as Array<{ type?: string; [key: string]: unknown }>)
    : [];

  // 有効なcomponents（type必須）のみをフィルタリングしてComponentInfo型に変換
  const components: ComponentInfo[] = rawComponents
    .filter((c): c is { type: string; [key: string]: unknown } => typeof c.type === "string")
    .map((c) => {
      const result: ComponentInfo = {
        type: c.type,
      };
      if (typeof c.level === "number") {
        result.level = c.level;
      }
      if (typeof c.text === "string") {
        result.text = c.text;
      }
      if (typeof c.variant === "string") {
        result.variant = c.variant;
      }
      if (typeof c.src === "string") {
        result.src = c.src;
      }
      if (typeof c.alt === "string") {
        result.alt = c.alt;
      }
      return result;
    });

  // 開発環境でのデバッグログ
  if (isDevelopment()) {
    logger.debug("[recordToSectionPattern] Converting record", {
      id: record.id,
      sectionType: record.sectionType,
      hasLayoutInfo: Object.keys(layoutInfo).length > 0,
      layoutInfoKeys: Object.keys(layoutInfo),
      componentsCount: components.length,
      hasHtmlSnippet: !!record.htmlSnippet,
    });
  }

  // layoutInfo オブジェクトを構築（undefinedプロパティを除外）
  const layoutInfoResult: SectionPattern["layoutInfo"] = {};
  if (typeof layoutInfo.type === "string") {
    layoutInfoResult.type = layoutInfo.type;
  }
  if (typeof layoutInfo.heading === "string") {
    layoutInfoResult.heading = layoutInfo.heading;
  }
  if (typeof layoutInfo.description === "string") {
    layoutInfoResult.description = layoutInfo.description;
  }
  if (layoutInfo.grid !== undefined) {
    layoutInfoResult.grid = layoutInfo.grid as { columns?: number; gap?: string };
  }
  if (typeof layoutInfo.alignment === "string") {
    layoutInfoResult.alignment = layoutInfo.alignment;
  }

  // visualFeatures オブジェクトを構築（undefinedプロパティを除外）
  const visualFeaturesResult: SectionPattern["visualFeatures"] = {};
  if (visualFeatures.colors !== undefined) {
    visualFeaturesResult.colors = visualFeatures.colors as {
      dominant?: string;
      background?: string;
    };
  }

  // webPage オブジェクトを構築（undefinedプロパティを除外）
  const webPageResult: SectionPattern["webPage"] = {
    id: record.webPage.id,
    url: record.webPage.url,
    sourceType: record.webPage.sourceType,
    usageScope: record.webPage.usageScope,
  };
  if (record.webPage.title) {
    webPageResult.title = record.webPage.title;
  }

  // 結果オブジェクトを構築（undefinedプロパティを除外）
  const result: SectionPattern = {
    id: record.id,
    webPageId: record.webPageId,
    sectionType: record.sectionType,
    positionIndex: record.positionIndex,
    webPage: webPageResult,
  };

  // オプショナルプロパティは値がある場合のみ設定
  if (record.sectionName) {
    result.sectionName = record.sectionName;
  }
  if (Object.keys(layoutInfoResult).length > 0) {
    result.layoutInfo = layoutInfoResult;
  }
  if (Object.keys(visualFeaturesResult).length > 0) {
    result.visualFeatures = visualFeaturesResult;
  }
  // components を設定（空でも設定する - コード生成で使用するため）
  result.components = components;
  if (record.htmlSnippet) {
    result.htmlSnippet = record.htmlSnippet;
  }
  // cssSnippetを設定（コード生成でスタイル適用に使用）
  if (record.cssSnippet) {
    result.cssSnippet = record.cssSnippet;

    if (isDevelopment()) {
      logger.debug("[recordToSectionPattern] CSS snippet found", {
        id: record.id,
        cssSnippetLength: record.cssSnippet.length,
      });
    }
  }
  // externalCssContentを設定（外部CSSファイルの実コンテンツ、CSS Modules等で必要）
  if (record.externalCssContent) {
    result.externalCssContent = record.externalCssContent;

    if (isDevelopment()) {
      logger.debug("[recordToSectionPattern] External CSS content found", {
        id: record.id,
        externalCssContentLength: record.externalCssContent.length,
      });
    }
  }
  // cssFrameworkを設定（コード生成でフレームワーク別処理に使用）
  if (record.cssFramework) {
    result.cssFramework = record.cssFramework;

    if (isDevelopment()) {
      logger.debug("[recordToSectionPattern] CSS framework detected", {
        id: record.id,
        cssFramework: record.cssFramework,
      });
    }
  }
  // cssFrameworkMetaを設定（exactOptionalPropertyTypes対応: undefinedを代入せずプロパティを省略）
  if (record.cssFrameworkMeta && typeof record.cssFrameworkMeta === "object") {
    const meta = record.cssFrameworkMeta as Record<string, unknown>;
    const cssFrameworkMeta: { confidence?: number; evidence?: string[] } = {};
    if (typeof meta.confidence === "number") {
      cssFrameworkMeta.confidence = meta.confidence;
    }
    if (Array.isArray(meta.evidence)) {
      cssFrameworkMeta.evidence = meta.evidence.filter((e): e is string => typeof e === "string");
    }
    // 空オブジェクトでない場合のみ設定
    if (Object.keys(cssFrameworkMeta).length > 0) {
      result.cssFrameworkMeta = cssFrameworkMeta;
    }
  }
  if (record.textRepresentation) {
    result.textRepresentation = record.textRepresentation;
  }

  return result;
}

/**
 * セクションタイプからコンポーネント名を生成
 */
function generateComponentName(sectionType: string, customName?: string): string {
  if (customName) {
    return customName;
  }

  // セクションタイプをPascalCaseに変換
  const pascalCase = sectionType
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");

  return `${pascalCase}Section`;
}

/**
 * フレームワークに応じたファイル名を生成
 */
function generateFilename(
  componentName: string,
  framework: Framework,
  typescript: boolean
): string {
  const extension = framework === "html" ? "html" : typescript ? "tsx" : "jsx";

  // Vue の場合は .vue 拡張子
  if (framework === "vue") {
    return `${componentName}.vue`;
  }

  return `${componentName}.${extension}`;
}

/**
 * フレームワークに応じた依存関係を取得
 */
function getDependencies(framework: Framework, tailwind: boolean): string[] {
  const deps: string[] = [];

  if (framework === "react") {
    deps.push("react");
  } else if (framework === "vue") {
    deps.push("vue");
  }

  if (tailwind) {
    deps.push("tailwindcss");
  }

  return deps;
}

// =====================================================
// コード生成関数
// =====================================================

/**
 * Reactコンポーネントを生成
 *
 * HTML→JSX変換を使用してセキュアなコンポーネントを生成します。
 * dangerouslySetInnerHTMLは使用しません。
 */
function generateReactCode(pattern: SectionPattern, options: CodeGeneratorOptions): string {
  const componentName = generateComponentName(pattern.sectionType, options.componentName);
  const { typescript, tailwind } = options;

  // プロップスの型定義（TypeScript用）
  const propsType = typescript
    ? `
interface ${componentName}Props {
  className?: string;
}
`
    : "";

  // プロップスの引数
  const propsArg = typescript ? `{ className }: ${componentName}Props` : "{ className }";

  // スタイルクラス
  const containerClass = tailwind ? "w-full max-w-7xl mx-auto px-4 py-8" : "";

  // 見出しテキスト
  const heading = pattern.layoutInfo?.heading || `${pattern.sectionType} Section`;
  const description = pattern.layoutInfo?.description || "Section content goes here.";

  // コンテンツの生成
  let content: string;
  if (pattern.htmlSnippet) {
    // REFTRIX-CODEGEN-02: セマンティックHTML変換
    // sectionTypeに基づいてセマンティック要素に変換し、aria-labelを追加
    const sectionName = pattern.sectionName || pattern.layoutInfo?.heading;
    const semanticHtml = convertToSemanticHtml(pattern.htmlSnippet, {
      sectionType: pattern.sectionType,
      ...(sectionName ? { sectionName } : {}),
      addAriaLabel: true,
    });

    // REFTRIX-CODEGEN-01: HTML→JSX変換（Tailwindクラス変換オプション付き）
    // REFTRIX-CODEGEN-03: 独自クラス名の除去（dwg-*, webflow-*, framer-*, wix-*, etc.）
    const jsxContent = convertHtmlToJsx(semanticHtml, {
      removeEmptyAttributes: true,
      useTailwind: tailwind, // Tailwind変換を有効化
      removeProprietaryClasses: true, // 独自クラス名を除去
    });

    if (isDevelopment()) {
      logger.debug("[generateReactCode] HTML to JSX conversion completed", {
        originalLength: pattern.htmlSnippet.length,
        semanticLength: semanticHtml.length,
        jsxLength: jsxContent.length,
        useTailwind: tailwind,
      });
    }

    content = `{/* Converted from original HTML structure */}
      ${jsxContent}`;
  } else {
    content = `<h2 ${tailwind ? 'className="text-3xl font-bold mb-4"' : ""}>${heading}</h2>
      <p ${tailwind ? 'className="text-gray-600"' : ""}>${description}</p>`;
  }

  return `${typescript ? "" : "// @ts-nocheck"}
import React from 'react';
${propsType}
export const ${componentName}${typescript ? `: React.FC<${componentName}Props>` : ""} = (${propsArg}) => {
  return (
    <section className={\`${containerClass} \${className || ''}\`}>
      ${content}
    </section>
  );
};

export default ${componentName};
`.trim();
}

/**
 * Vueコンポーネントを生成
 *
 * HTML→テンプレート変換を使用してセキュアなコンポーネントを生成します。
 * v-htmlは使用しません。
 */
function generateVueCode(pattern: SectionPattern, options: CodeGeneratorOptions): string {
  const componentName = generateComponentName(pattern.sectionType, options.componentName);
  const { typescript, tailwind } = options;

  // スタイルクラス
  const containerClass = tailwind ? "w-full max-w-7xl mx-auto px-4 py-8" : "";

  // 見出しテキスト
  const heading = pattern.layoutInfo?.heading || `${pattern.sectionType} Section`;
  const description = pattern.layoutInfo?.description || "Section content goes here.";

  // スクリプトセクション
  const scriptSection = typescript
    ? `<script setup lang="ts">
defineProps<{
  class?: string;
}>();
</script>`
    : `<script setup>
defineProps({
  class: String,
});
</script>`;

  // コンテンツの生成
  let content: string;
  if (pattern.htmlSnippet) {
    // REFTRIX-CODEGEN-02: セマンティックHTML変換
    const vueSectionName = pattern.sectionName || pattern.layoutInfo?.heading;
    const semanticHtml = convertToSemanticHtml(pattern.htmlSnippet, {
      sectionType: pattern.sectionType,
      ...(vueSectionName ? { sectionName: vueSectionName } : {}),
      addAriaLabel: true,
    });

    // HTML→JSX変換を使用（VueテンプレートもJSX変換結果を活用可能）
    // REFTRIX-CODEGEN-01: Tailwind変換オプション付き
    // REFTRIX-CODEGEN-03: 独自クラス名の除去
    // ただしVueではclassName→class、htmlFor→forに戻す必要がある
    const jsxContent = convertHtmlToJsx(semanticHtml, {
      removeEmptyAttributes: true,
      useTailwind: tailwind, // Tailwind変換を有効化
      removeProprietaryClasses: true, // 独自クラス名を除去
    });

    // JSXからVueテンプレートへの変換（className→class）
    const vueContent = jsxContent
      .replace(/className=/g, 'class=')
      .replace(/htmlFor=/g, 'for=');

    if (isDevelopment()) {
      logger.debug("[generateVueCode] HTML to Vue template conversion completed", {
        originalLength: pattern.htmlSnippet.length,
        semanticLength: semanticHtml.length,
        vueLength: vueContent.length,
        useTailwind: tailwind,
      });
    }

    content = `<!-- Converted from original HTML structure -->
    ${vueContent}`;
  } else {
    content = `<h2 ${tailwind ? 'class="text-3xl font-bold mb-4"' : ""}>${heading}</h2>
    <p ${tailwind ? 'class="text-gray-600"' : ""}>${description}</p>`;
  }

  return `${scriptSection}

<template>
  <section :class="['${containerClass}', $props.class]">
    ${content}
  </section>
</template>

<style scoped>
/* ${componentName} styles */
</style>
`.trim();
}

/**
 * CSSスニペットをサニタイズ
 *
 * 古いフォーマットで保存されたcssSnippetには、セレクタなしのインラインスタイル宣言が
 * 含まれている場合があり、これは無効なCSSとしてブラウザに無視される。
 * この関数は以下のパターンを除去・正規化する:
 * - "Inline Styles (X elements)" コメントの後に続くセレクタなしの宣言ブロック
 * - セレクタなしの単発CSS宣言（例: word-wrap: break-word;）
 * - 無効な@importの後の孤立した宣言
 *
 * @param css - 元のCSSスニペット
 * @returns サニタイズされたCSSスニペット
 */
function sanitizeCssSnippet(css: string): string {
  if (!css) return "";

  let sanitized = css;

  // パターン1: /* Inline Styles (X elements) */ に続くセレクタなしの宣言を除去
  // 例: /* Inline Styles (60 elements) */\nword-wrap: break-word;\nfont-size: 14px;...
  // このパターンは次のコメントブロックまで、または文字列末尾まで続く
  const inlineStylesPattern =
    /\/\*\s*Inline Styles\s*\(\d+\s*elements?\)\s*\*\/[\s\S]*?(?=\/\*|$)/gi;

  sanitized = sanitized.replace(inlineStylesPattern, (match) => {
    // 新形式（Reference付き）はコメント内なので保持
    if (match.includes("Inline Styles Reference")) {
      return match;
    }
    // 古形式は除去（ログ出力）
    if (isDevelopment()) {
      logger.debug("[sanitizeCssSnippet] Removing invalid inline styles block", {
        removedLength: match.length,
      });
    }
    return "";
  });

  // パターン2: セレクタなしの単発CSS宣言を除去
  // 有効なCSS: selector { property: value; }
  // 無効なCSS: property: value; （セレクタなし）
  // 行頭から始まる「property: value;」形式を検出して除去
  // ただし、{} 内の宣言は除外する
  const lines = sanitized.split("\n");
  const validLines: string[] = [];
  let insideBlock = 0; // {} のネスト深度をトラック

  for (const line of lines) {
    const trimmedLine = line.trim();

    // 空行やコメント行は保持
    if (
      trimmedLine === "" ||
      trimmedLine.startsWith("/*") ||
      trimmedLine.startsWith("*") ||
      trimmedLine.endsWith("*/")
    ) {
      validLines.push(line);
      continue;
    }

    // @import, @media, @keyframes などの@ルールは保持
    if (trimmedLine.startsWith("@")) {
      validLines.push(line);
      // @media や @keyframes は { を開く
      if (trimmedLine.includes("{")) {
        insideBlock++;
      }
      continue;
    }

    // ブロック開始/終了のトラッキング
    const openBraces = (trimmedLine.match(/{/g) || []).length;
    const closeBraces = (trimmedLine.match(/}/g) || []).length;

    // ブロック内（{} の中）にいる場合はすべて保持
    if (insideBlock > 0) {
      validLines.push(line);
      insideBlock += openBraces - closeBraces;
      continue;
    }

    // セレクタ行（{ を含む）は保持
    if (trimmedLine.includes("{")) {
      validLines.push(line);
      insideBlock += openBraces - closeBraces;
      continue;
    }

    // ブロック終了行は保持
    if (trimmedLine === "}") {
      validLines.push(line);
      continue;
    }

    // ブロック外でセレクタなしの宣言（property: value; 形式）を検出
    // これらは無効なCSSなので除去
    // パターン1: 単一宣言 (e.g., "word-wrap: break-word;")
    // パターン2: 複数宣言 (e.g., "z-index: 1000; position: absolute; width: 100%;")
    // パターン3: CSS変数宣言 (e.g., "--Spacer-size:114px")

    // 有効なCSSセレクタは { を含むか、:hover などの擬似クラスを持つ
    // ブロック外で { } を含まない行で、: を含む場合は宣言のみの行
    const hasColon = trimmedLine.includes(":");
    const hasBlockMarker = /[{}]/.test(trimmedLine);

    // 擬似クラス/擬似要素を持つセレクタかどうかをチェック
    // 例: a:hover, input:focus, ::before
    // これらは : の後にアルファベットが続く (プロパティ値は通常スペースや数字)
    const isPseudoSelector = /:[a-z-]+(?:\(|{|\s|$)/i.test(trimmedLine);

    // セレクタなしの宣言行の判定:
    // - : を含む (プロパティ: 値 の形式)
    // - { } を含まない (ブロック開始/終了なし)
    // - 擬似セレクタではない
    // - @ ルールでもない (既に上でチェック済み)
    const isDeclarationsOnly = hasColon && !hasBlockMarker && !isPseudoSelector;

    if (isDeclarationsOnly) {
      if (isDevelopment()) {
        logger.debug("[sanitizeCssSnippet] Removing selector-less declaration", {
          line: trimmedLine,
        });
      }
      continue; // この行を除去
    }

    // その他の行は保持（セレクタ行など）
    validLines.push(line);
  }

  sanitized = validLines.join("\n");

  // 連続する空行を1行に圧縮
  sanitized = sanitized.replace(/\n{3,}/g, "\n\n");

  return sanitized.trim();
}

/**
 * CSS内のURLを絶対URL化する
 *
 * 対象:
 * - url(./path) → url(https://base/path)
 * - url(../path) → url(https://base/../path) → 正規化
 * - url(//example.com/path) → url(https://example.com/path)
 * - url(/path) → url(https://base/path)
 *
 * CSPで外部CSSがブロックされる前提のため、@importは除去
 *
 * @param css - 元のCSS
 * @param baseUrl - ベースURL（相対URL解決用）
 * @returns URL正規化されたCSS
 */
function normalizeCssUrls(css: string, baseUrl?: string): string {
  if (!css) return "";

  let result = css;

  // @import文を除去（CSPでブロックされるため）
  // @import url("..."); または @import "..."; の形式
  result = result.replace(
    /@import\s+(?:url\s*\(\s*)?["']?[^"');\s]+["']?\s*\)?[^;]*;/gi,
    (match) => {
      if (isDevelopment()) {
        logger.debug("[normalizeCssUrls] Removing @import (blocked by CSP)", {
          import: match.trim(),
        });
      }
      return "/* @import removed (CSP) */";
    }
  );

  // ベースURLがない場合は相対URLをそのまま返す（変換不可）
  if (!baseUrl) {
    return result;
  }

  // ベースURLをパース
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    if (isDevelopment()) {
      logger.warn("[normalizeCssUrls] Invalid base URL", { baseUrl });
    }
    return result;
  }

  // url() 内のURLを正規化
  // パターン: url("..."), url('...'), url(...)
  result = result.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (match, _quote: string, url: string) => {
      const trimmedUrl = url.trim();

      // data: URL, blob: URL はそのまま
      if (trimmedUrl.startsWith("data:") || trimmedUrl.startsWith("blob:")) {
        return match;
      }

      // 空のURL, # のみ はそのまま
      if (trimmedUrl === "" || trimmedUrl === "#") {
        return match;
      }

      // 既に絶対URLの場合はそのまま
      if (trimmedUrl.startsWith("http://") || trimmedUrl.startsWith("https://")) {
        return match;
      }

      try {
        let absoluteUrl: string;

        // プロトコル相対URL（//example.com/path）
        if (trimmedUrl.startsWith("//")) {
          absoluteUrl = `${parsedBaseUrl.protocol}${trimmedUrl}`;
        }
        // ルート相対URL（/path）
        else if (trimmedUrl.startsWith("/")) {
          absoluteUrl = `${parsedBaseUrl.origin}${trimmedUrl}`;
        }
        // 相対URL（./path, ../path, path）
        else {
          absoluteUrl = new URL(trimmedUrl, baseUrl).href;
        }

        if (isDevelopment()) {
          logger.debug("[normalizeCssUrls] URL normalized", {
            original: trimmedUrl,
            normalized: absoluteUrl,
          });
        }

        return `url("${absoluteUrl}")`;
      } catch {
        // URL解決に失敗した場合はそのまま
        if (isDevelopment()) {
          logger.warn("[normalizeCssUrls] Failed to resolve URL", {
            url: trimmedUrl,
            baseUrl,
          });
        }
        return match;
      }
    }
  );

  return result;
}

/**
 * HTMLコードを生成
 * layoutInfoとcomponentsから適切なTailwind HTMLを生成
 * htmlSnippetがある場合はそれを優先使用
 *
 * CSS適用優先順位:
 * 1. pattern.cssSnippet（DBに保存されたCSS） - 最優先
 * 2. Tailwind CDN（tailwind=trueかつcssSnippetがない場合）
 * 3. 基本スタイルのみ（上記どちらもない場合）
 */
function generateHtmlCode(pattern: SectionPattern, options: CodeGeneratorOptions): string {
  const { tailwind } = options;

  // cssSnippetをサニタイズ（古いフォーマットの無効なインラインスタイルブロックを除去）
  const sanitizedCssSnippet = pattern.cssSnippet ? sanitizeCssSnippet(pattern.cssSnippet) : "";

  // cssSnippetの有無を確認（サニタイズ後）
  const hasCssSnippet = sanitizedCssSnippet.length > 0;
  const externalCssContent = pattern.externalCssContent?.trim() ?? "";
  const hasExternalCssContent = externalCssContent.length > 0;
  // cssFrameworkの取得（null/undefined → 'unknown'として扱う）
  const cssFramework = pattern.cssFramework || "unknown";
  // ベースURL（CSS内URL正規化用）
  const baseUrl = pattern.webPage?.url;

  const externalCssComment = `External CSS${cssFramework ? ` (${cssFramework})` : ""}`;
  const snippetCssComment = `CSS from database${cssFramework ? ` (${cssFramework})` : ""}`;

  // CSS内のURLを絶対URL化し、@importを除去
  const normalizedExternalCss = hasExternalCssContent
    ? normalizeCssUrls(externalCssContent, baseUrl)
    : "";
  const normalizedCssSnippet = hasCssSnippet
    ? normalizeCssUrls(sanitizedCssSnippet, baseUrl)
    : "";

  const combinedCssBlocks = [
    normalizedExternalCss ? `/* ${externalCssComment} */\n    ${normalizedExternalCss}` : "",
    normalizedCssSnippet ? `/* ${snippetCssComment} */\n    ${normalizedCssSnippet}` : "",
  ]
    .filter(Boolean)
    .join("\n\n    ");

  // 開発環境でのデバッグログ
  if (isDevelopment()) {
    logger.debug("[generateHtmlCode] Processing", {
      patternId: pattern.id,
      sectionType: pattern.sectionType,
      hasHtmlSnippet: !!pattern.htmlSnippet,
      htmlSnippetLength: pattern.htmlSnippet?.length || 0,
      hasCssSnippet,
      originalCssSnippetLength: pattern.cssSnippet?.length || 0,
      sanitizedCssSnippetLength: sanitizedCssSnippet.length,
      cssFramework,
      framework: options.framework,
      tailwindRequested: tailwind,
    });
  }

  // スタイル要素の生成
  // 優先順位:
  // 1) cssFrameworkがtailwind → Tailwind CDN + cssSnippet（あれば）
  // 2) cssFrameworkがbootstrap → Bootstrap CDN + cssSnippet（あれば）
  // 3) cssFrameworkがcss_modules/styled_components/vanilla → cssSnippetをインライン
  // 4) cssFrameworkがunknownでcssSnippetあり → cssSnippetをインライン
  // 5) cssFrameworkがunknownでcssSnippetなし → オプションに従いTailwind CDNまたは基本スタイル
  const generateStyleSection = (): string => {
    const baseStyles = `
    body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; margin: 0; padding: 0; }
    img { max-width: 100%; height: auto; }`;

    // cssFrameworkに基づく分岐
    switch (cssFramework) {
      case "tailwind":
        // Tailwind CDNを使用（cssSnippetがあれば追加）
        if (isDevelopment()) {
          logger.info("[generateHtmlCode] Using Tailwind CDN (cssFramework: tailwind)", {
            patternId: pattern.id,
            hasCssSnippet,
            hasExternalCssContent,
          });
        }
        return `<script src="https://cdn.tailwindcss.com"></script>
  <style>
    ${baseStyles}
    ${combinedCssBlocks ? `${combinedCssBlocks}` : ""}
  </style>`;

      case "bootstrap":
        // Bootstrap CDNを使用（cssSnippetがあれば追加）
        if (isDevelopment()) {
          logger.info("[generateHtmlCode] Using Bootstrap CDN (cssFramework: bootstrap)", {
            patternId: pattern.id,
            hasCssSnippet,
            hasExternalCssContent,
          });
        }
        return `<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  <style>
    ${baseStyles}
    ${combinedCssBlocks ? `${combinedCssBlocks}` : ""}
  </style>`;

      case "css_modules":
      case "styled_components":
      case "vanilla": {
        // cssSnippet + externalCssContentをインラインで使用（CDNなし）
        if (isDevelopment()) {
          logger.info(`[generateHtmlCode] Using inline CSS (cssFramework: ${cssFramework})`, {
            patternId: pattern.id,
            hasCssSnippet,
            hasExternalCssContent,
            externalCssLength: hasExternalCssContent ? externalCssContent.length : 0,
          });
        }
        return `<style>
    ${baseStyles}
    ${combinedCssBlocks ? `${combinedCssBlocks}` : ""}
  </style>`;
      }

      case "unknown":
      default: {
        // cssFrameworkがunknownの場合はレガシーロジック
        if (hasExternalCssContent || hasCssSnippet) {
          // DBに保存されたCSSがある場合はそれを使用（Tailwindは追加しない）
          if (isDevelopment()) {
            logger.info("[generateHtmlCode] Using DB CSS (cssFramework: unknown)", {
              patternId: pattern.id,
              hasExternalCss: hasExternalCssContent,
              hasCssSnippet,
            });
          }
          return `<style>
    ${baseStyles}
    ${combinedCssBlocks ? `${combinedCssBlocks}` : ""}
  </style>`;
        } else if (tailwind) {
          // cssSnippetがない場合のみTailwind CDNを使用（フォールバック）
          if (isDevelopment()) {
            logger.debug("[generateHtmlCode] No cssSnippet found, using Tailwind CDN as fallback", {
              patternId: pattern.id,
            });
          }
          return `<script src="https://cdn.tailwindcss.com"></script>
  <style>
    ${baseStyles}
  </style>`;
        } else {
          // Tailwindも不要の場合は基本スタイルのみ
          return `<style>
    ${baseStyles}
  </style>`;
        }
      }
    }
  };

  // htmlSnippetがある場合はそれを使用
  if (pattern.htmlSnippet && pattern.htmlSnippet.trim().length > 0) {
    if (isDevelopment()) {
      logger.debug("[generateHtmlCode] Using htmlSnippet", {
        patternId: pattern.id,
        snippetLength: pattern.htmlSnippet.length,
        hasCssSnippet,
      });
    }

    const heading = (pattern.layoutInfo?.heading as string) || `${pattern.sectionType} Section`;

    // REFTRIX-CODEGEN-02: セマンティックHTML変換
    // sectionTypeに基づいてセマンティック要素に変換し、aria-labelを追加
    const htmlSectionName = pattern.sectionName || heading;
    const semanticHtml = convertToSemanticHtml(pattern.htmlSnippet, {
      sectionType: pattern.sectionType,
      ...(htmlSectionName ? { sectionName: htmlSectionName } : {}),
      addAriaLabel: true,
    });

    // 外部画像URLをプレースホルダーに置き換え（CSP対応）
    const sanitizedHtmlSnippet = replaceExternalImageUrls(semanticHtml);

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${heading}</title>
  ${generateStyleSection()}
</head>
<body>
  ${sanitizedHtmlSnippet}
</body>
</html>`.trim();
  }

  // layoutInfoとcomponentsを取得
  const layoutInfo = pattern.layoutInfo as unknown as Record<string, unknown>;
  // SectionPatternにcomponentsが定義されているので直接アクセス
  const components = (pattern.components || []) as Array<Record<string, unknown>>;

  // 見出しテキスト
  const heading = (layoutInfo?.heading as string) || `${pattern.sectionType} Section`;
  const description = (layoutInfo?.description as string) || "";

  // 開発環境でのデバッグログ
  if (isDevelopment()) {
    logger.debug("[generateHtmlCode] Generating from layoutInfo/components", {
      patternId: pattern.id,
      sectionType: pattern.sectionType,
      hasLayoutInfo: !!layoutInfo && Object.keys(layoutInfo).length > 0,
      layoutInfoKeys: layoutInfo ? Object.keys(layoutInfo) : [],
      componentsCount: components.length,
      heading,
      hasDescription: !!description,
    });
  }

  // セクションタイプに応じたコンテナクラス
  const getContainerClass = (): string => {
    if (!tailwind) return "";

    const baseClass = "w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8";
    const paddingClass = "py-12 sm:py-16 lg:py-20";

    switch (pattern.sectionType) {
      case "hero":
        return `${baseClass} ${paddingClass} min-h-screen flex items-center`;
      case "feature":
      case "cta":
        return `${baseClass} ${paddingClass}`;
      case "footer":
        return `${baseClass} py-8 sm:py-12`;
      default:
        return `${baseClass} ${paddingClass}`;
    }
  };

  // グリッドレイアウトクラス
  const getGridClass = (): string => {
    if (!tailwind) return "";

    const grid = layoutInfo?.grid as Record<string, unknown> | undefined;
    if (!grid) return "";

    const columns = (typeof grid.columns === "number" ? grid.columns : 1) as number;
    const gap = (typeof grid.gap === "string" ? grid.gap : "24px") as string;

    // gapをTailwindクラスに変換（簡易版）
    const gapClass = gap.includes("32")
      ? "gap-8"
      : gap.includes("24")
        ? "gap-6"
        : gap.includes("16")
          ? "gap-4"
          : "gap-6";

    const columnClass =
      columns === 1
        ? ""
        : columns === 2
          ? "md:grid-cols-2"
          : columns === 3
            ? "md:grid-cols-3"
            : columns === 4
              ? "md:grid-cols-4"
              : "md:grid-cols-2";

    return columns > 1 ? `grid ${columnClass} ${gapClass}` : "";
  };

  // コンポーネントからHTMLを生成
  const generateComponentHtml = (comp: Record<string, unknown>): string => {
    if (!tailwind) {
      // Tailwindなしの場合はシンプルなHTML
      if (comp.type === "heading") {
        return `<h${comp.level || 2}>${comp.text || ""}</h${comp.level || 2}>`;
      }
      if (comp.type === "text" || comp.type === "paragraph") {
        return `<p>${comp.text || ""}</p>`;
      }
      if (comp.type === "button") {
        return `<button>${comp.text || "Button"}</button>`;
      }
      return "";
    }

    // Tailwindありの場合
    switch (comp.type) {
      case "heading": {
        const level = comp.level || 2;
        const headingClasses =
          level === 1
            ? "text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight"
            : level === 2
              ? "text-3xl sm:text-4xl lg:text-5xl font-bold"
              : level === 3
                ? "text-2xl sm:text-3xl font-semibold"
                : "text-xl sm:text-2xl font-semibold";
        return `<h${level} class="${headingClasses} text-gray-900 mb-4">${comp.text || ""}</h${level}>`;
      }

      case "text":
      case "paragraph":
        return `<p class="text-base sm:text-lg text-gray-600 leading-relaxed mb-4">${comp.text || ""}</p>`;

      case "button": {
        const variant = comp.variant || "primary";
        const buttonClasses =
          variant === "primary"
            ? "bg-blue-600 hover:bg-blue-700 text-white"
            : "bg-gray-200 hover:bg-gray-300 text-gray-900";
        return `<button class="${buttonClasses} px-6 py-3 rounded-lg font-medium transition-colors duration-200">${comp.text || "Button"}</button>`;
      }

      case "image":
        return `<img src="${comp.src || "/placeholder.jpg"}" alt="${comp.alt || ""}" class="w-full h-auto rounded-lg shadow-lg" />`;

      default:
        return "";
    }
  };

  // コンテンツの生成
  const content =
    components.length > 0
      ? components.map(generateComponentHtml).join("\n    ")
      : tailwind
        ? `<h2 class="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">${heading}</h2>
    ${description ? `<p class="text-lg text-gray-600 leading-relaxed">${description}</p>` : ""}`
        : `<h2>${heading}</h2>
    ${description ? `<p>${description}</p>` : ""}`;

  const containerClass = getContainerClass();
  const gridClass = getGridClass();
  const contentWrapper = gridClass
    ? `<div class="${gridClass}">\n    ${content}\n  </div>`
    : content;

  const rawHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${heading}</title>
  ${generateStyleSection()}
</head>
<body>
  <section class="${containerClass}">
    ${contentWrapper}
  </section>
</body>
</html>
`.trim();

  // 外部画像URLをプレースホルダーに置き換え（CSP対応）
  return replaceExternalImageUrls(rawHtml);
}

// =====================================================
// 画像URL置換（CSP対応）
// =====================================================

/**
 * SVGプレースホルダー画像のdata URI
 * CSP設定 `img-src 'self' data: blob:` に準拠
 */
function createPlaceholderSvg(width = 400, height = 300): string {
  // SVGをURIエンコード（data URIとして使用可能な形式）
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'>` +
    `<rect width='${width}' height='${height}' fill='%23e5e7eb'/>` +
    `<text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' ` +
    `font-family='system-ui, -apple-system, sans-serif' font-size='14' fill='%236b7280'>` +
    `Image Placeholder</text></svg>`;

  return `data:image/svg+xml,${svg}`;
}

/**
 * URLを置き換えるべきかどうかを判定
 * data: URL と blob: URL 以外はすべて置き換え対象（相対パス、外部URLを含む）
 *
 * @param url - 判定対象のURL
 * @returns 置き換えるべき場合はtrue
 */
function isExternalUrl(url: string): boolean {
  const trimmedUrl = url.trim().toLowerCase();

  // data: URLとblob: URLは除外（既にCSP準拠のため置き換え不要）
  if (trimmedUrl.startsWith("data:") || trimmedUrl.startsWith("blob:")) {
    return false;
  }

  // 空のURLやハッシュのみも除外
  if (trimmedUrl === "" || trimmedUrl === "#") {
    return false;
  }

  // それ以外はすべて置き換え対象（外部URL、相対パス、ルート相対パスを含む）
  // 理由: iframeにはベースURLが設定されていないため、相対パスは404エラーになる
  return true;
}

/**
 * HTML内の画像URLをSVGプレースホルダーに置き換える
 * CSP設定 `img-src 'self' data: blob:` に準拠するため
 *
 * 置き換え対象:
 * - 外部URL（http://, https://）
 * - 相対パス（例: type-linear.svg, ./image.png, ../assets/icon.png）
 * - ルート相対パス（例: /images/logo.png）
 *
 * 置き換え対象外:
 * - data: URL（既にCSP準拠）
 * - blob: URL（既にCSP準拠）
 * - 空のURL、ハッシュのみ（#）
 *
 * 理由: iframeにはベースURLが設定されていないため、相対パスは404エラーになる
 *
 * 対応パターン:
 * 1. <img src="..."> タグ（属性順序に依存しない）
 * 2. CSS background-image: url(...)
 * 3. srcset属性内のURL
 * 4. <source src="..."> タグ（picture要素内）
 *
 * @param html - 変換対象のHTML文字列
 * @returns 画像URLが置き換えられたHTML文字列
 */
function replaceExternalImageUrls(html: string): string {
  let result = html;
  let replacedCount = 0;
  const replacedUrls: string[] = [];
  const placeholder = createPlaceholderSvg();

  // 開発環境でのデバッグログ（関数呼び出し確認）
  if (isDevelopment()) {
    logger.debug("[replaceExternalImageUrls] 関数が呼び出されました", {
      入力HTML長: html.length,
      入力HTML先頭500文字: html.substring(0, 500),
    });
  }

  // パターン1: <img> タグのsrc属性を置き換え
  // 属性の順序に依存しない方法: まずimgタグ全体をマッチし、その中のsrc属性を置き換え
  result = result.replace(/<img\s+([^>]*)>/gi, (imgTag, attrs: string) => {
    // src属性を探す（ダブルクォート、シングルクォート、クォートなしに対応）
    const srcPatterns = [
      /src\s*=\s*"([^"]*)"/i, // src="..."
      /src\s*=\s*'([^']*)'/i, // src='...'
      /src\s*=\s*([^\s>'"]+)/i, // src=... (クォートなし)
    ];

    for (const pattern of srcPatterns) {
      const srcMatch = attrs.match(pattern);
      if (srcMatch && srcMatch[1]) {
        const srcUrl = srcMatch[1];
        if (isExternalUrl(srcUrl)) {
          replacedCount++;
          replacedUrls.push(srcUrl);
          // src属性を置き換え
          const newAttrs = attrs.replace(pattern, `src="${placeholder}"`);
          return `<img ${newAttrs}>`;
        }
        break; // src属性は見つかったので終了
      }
    }
    return imgTag;
  });

  // パターン2: CSS内のbackground-image: url(...)を置き換え
  // style属性内とstyleタグ内の両方に対応
  result = result.replace(
    /background(?:-image)?\s*:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (match, _quote: string, url: string) => {
      if (isExternalUrl(url)) {
        replacedCount++;
        replacedUrls.push(url);
        return match.replace(url, placeholder);
      }
      return match;
    }
  );

  // パターン3: srcset属性内の外部URLを置き換え
  result = result.replace(/srcset\s*=\s*["']([^"']+)["']/gi, (match, srcsetValue: string) => {
    let modified = false;
    const newSrcset = srcsetValue.replace(/(https?:\/\/[^\s,]+)/gi, (srcUrl: string) => {
      if (isExternalUrl(srcUrl)) {
        replacedCount++;
        replacedUrls.push(srcUrl);
        modified = true;
        return placeholder;
      }
      return srcUrl;
    });
    return modified ? `srcset="${newSrcset}"` : match;
  });

  // パターン4: <source> タグのsrc属性を置き換え（picture要素内）
  result = result.replace(/<source\s+([^>]*)>/gi, (sourceTag, attrs: string) => {
    const srcPatterns = [/src\s*=\s*"([^"]*)"/i, /src\s*=\s*'([^']*)'/i];

    for (const pattern of srcPatterns) {
      const srcMatch = attrs.match(pattern);
      if (srcMatch && srcMatch[1]) {
        const srcUrl = srcMatch[1];
        if (isExternalUrl(srcUrl)) {
          replacedCount++;
          replacedUrls.push(srcUrl);
          const newAttrs = attrs.replace(pattern, `src="${placeholder}"`);
          return `<source ${newAttrs}>`;
        }
        break;
      }
    }
    return sourceTag;
  });

  // 開発環境でのデバッグログ（結果出力）
  if (isDevelopment()) {
    logger.debug("[replaceExternalImageUrls] 処理完了", {
      入力HTML長: html.length,
      出力HTML長: result.length,
      置き換え数: replacedCount,
      置き換えURLリスト: replacedUrls,
      出力HTML先頭500文字: result.substring(0, 500),
    });
  }

  return result;
}

// =====================================================
// LayoutToCodeService
// =====================================================

/**
 * LayoutToCodeServiceクラス
 */
export class LayoutToCodeService implements ILayoutToCodeService {
  private prismaClient: IPrismaClient | null = null;

  /**
   * PrismaClientを取得
   */
  private getPrismaClient(): IPrismaClient {
    if (this.prismaClient) {
      return this.prismaClient;
    }

    if (prismaClientFactory) {
      this.prismaClient = prismaClientFactory();
      return this.prismaClient;
    }

    throw new Error("PrismaClient not initialized");
  }

  /**
   * セクションパターンをIDで取得
   * PrismaClientが利用できない場合はnullを返す
   */
  async getSectionPatternById(id: string): Promise<SectionPattern | null> {
    if (isDevelopment()) {
      logger.info("[LayoutToCodeService] Getting section pattern", { id });
    }

    // PrismaClientが利用できない場合はnullを返す
    if (!prismaClientFactory) {
      if (isDevelopment()) {
        logger.warn("[LayoutToCodeService] PrismaClient not available, returning null");
      }
      return null;
    }

    try {
      const prisma = this.getPrismaClient();

      const record = await prisma.sectionPattern.findUnique({
        where: { id },
        include: {
          webPage: true,
        },
      });

      if (!record) {
        if (isDevelopment()) {
          logger.warn("[LayoutToCodeService] Section pattern not found", { id });
        }
        return null;
      }

      // 開発環境でのデバッグログ - 取得したレコードの詳細を出力
      if (isDevelopment()) {
        logger.debug("[LayoutToCodeService] Raw record from DB", {
          id: record.id,
          sectionType: record.sectionType,
          hasLayoutInfo: !!record.layoutInfo,
          layoutInfoType: typeof record.layoutInfo,
          layoutInfoSample: record.layoutInfo
            ? JSON.stringify(record.layoutInfo).slice(0, 200)
            : null,
          hasComponents: !!record.components,
          componentsType: typeof record.components,
          componentsIsArray: Array.isArray(record.components),
          componentsLength: Array.isArray(record.components) ? record.components.length : 0,
          componentsSample: record.components
            ? JSON.stringify(record.components).slice(0, 200)
            : null,
          hasHtmlSnippet: !!record.htmlSnippet,
          htmlSnippetLength: record.htmlSnippet?.length || 0,
        });
      }

      return recordToSectionPattern(record);
    } catch (error) {
      if (isDevelopment()) {
        logger.warn("[LayoutToCodeService] Error getting section pattern, returning null", {
          id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
      // エラー時もnullを返す
      return null;
    }
  }

  /**
   * コードを生成
   */
  async generateCode(
    pattern: SectionPattern,
    options: CodeGeneratorOptions
  ): Promise<GeneratedCode> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info("[LayoutToCodeService] Generating code", {
        patternId: pattern.id,
        sectionType: pattern.sectionType,
        framework: options.framework,
        typescript: options.typescript,
        tailwind: options.tailwind,
        splitComponents: options.splitComponents,
      });
    }

    try {
      const componentName = generateComponentName(pattern.sectionType, options.componentName);
      const filename = generateFilename(componentName, options.framework, options.typescript);
      const dependencies = getDependencies(options.framework, options.tailwind);

      // フレームワークに応じてコードを生成
      let code: string;
      let subComponents: SubComponentInfo[] | undefined;

      // splitComponents=trueかつReactフレームワークの場合のみコンポーネント分割を実行
      if (options.splitComponents && options.framework === "react" && pattern.htmlSnippet) {
        // REFTRIX-CODEGEN-02: セマンティックHTML変換（コンポーネント分割前）
        const splitSectionName = pattern.sectionName || pattern.layoutInfo?.heading;
        const semanticHtml = convertToSemanticHtml(pattern.htmlSnippet, {
          sectionType: pattern.sectionType,
          ...(splitSectionName ? { sectionName: splitSectionName } : {}),
          addAriaLabel: true,
        });

        const splitResult = splitIntoComponents(semanticHtml, {
          mainComponentName: componentName,
          minElements: 3,
          maxNestLevel: 2,
        });

        if (isDevelopment()) {
          logger.debug("[LayoutToCodeService] Component split result", {
            patternId: pattern.id,
            mainComponentName: splitResult.mainComponent.name,
            subComponentsCount: splitResult.subComponents.length,
            imports: splitResult.mainComponent.imports.length,
          });
        }

        // サブコンポーネントが存在する場合
        if (splitResult.subComponents.length > 0) {
          // メインコンポーネントのコード生成（import文付き）
          code = generateReactCodeWithSplit(
            componentName,
            splitResult.mainComponent.jsx,
            splitResult.mainComponent.imports,
            options
          );

          // サブコンポーネントの情報を生成
          subComponents = splitResult.subComponents.map((sub) => ({
            name: sub.name,
            code: generateReactSubComponentCode(sub.name, sub.jsx, sub.props, options),
            filename: generateFilename(sub.name, "react", options.typescript),
            props: sub.props,
          }));
        } else {
          // サブコンポーネントがない場合は通常生成
          code = generateReactCode(pattern, options);
        }
      } else {
        // 通常のコード生成
        switch (options.framework) {
          case "react":
            code = generateReactCode(pattern, options);
            break;
          case "vue":
            code = generateVueCode(pattern, options);
            break;
          case "html":
            code = generateHtmlCode(pattern, options);
            break;
          default:
            code = generateReactCode(pattern, options);
        }
      }

      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.info("[LayoutToCodeService] Code generation completed", {
          patternId: pattern.id,
          componentName,
          codeLength: code.length,
          subComponentsCount: subComponents?.length ?? 0,
          processingTimeMs,
        });
      }

      const result: GeneratedCode = {
        code,
        componentName,
        filename,
        dependencies,
      };

      // サブコンポーネントがある場合のみ追加
      if (subComponents && subComponents.length > 0) {
        result.subComponents = subComponents;
      }

      return result;
    } catch (error) {
      if (isDevelopment()) {
        logger.error("[LayoutToCodeService] Code generation error", {
          patternId: pattern.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
      throw error;
    }
  }
}

// =====================================================
// コンポーネント分割用コード生成関数
// =====================================================

/**
 * コンポーネント分割されたメインコンポーネントを生成
 */
function generateReactCodeWithSplit(
  componentName: string,
  mainJsx: string,
  imports: string[],
  options: CodeGeneratorOptions
): string {
  const { typescript, tailwind } = options;

  // プロップスの型定義（TypeScript用）
  const propsType = typescript
    ? `
interface ${componentName}Props {
  className?: string;
}
`
    : "";

  // プロップスの引数
  const propsArg = typescript ? `{ className }: ${componentName}Props` : "{ className }";

  // スタイルクラス
  const containerClass = tailwind ? "w-full max-w-7xl mx-auto px-4 py-8" : "";

  // import文の生成
  const importStatements = imports.length > 0 ? `\n${imports.join("\n")}\n` : "";

  return `${typescript ? "" : "// @ts-nocheck"}
import React from 'react';${importStatements}
${propsType}
export const ${componentName}${typescript ? `: React.FC<${componentName}Props>` : ""} = (${propsArg}) => {
  return (
    <div className={\`${containerClass} \${className || ''}\`}>
      {/* Main component with extracted sub-components */}
      ${mainJsx}
    </div>
  );
};

export default ${componentName};
`.trim();
}

/**
 * サブコンポーネントのReactコードを生成
 */
function generateReactSubComponentCode(
  name: string,
  jsx: string,
  props: Array<{ name: string; type: string }>,
  options: CodeGeneratorOptions
): string {
  const { typescript, tailwind } = options;

  // propsの型定義を生成
  const propsInterface = props.length > 0
    ? props.map((p) => `  ${p.name}?: ${p.type};`).join("\n")
    : "  className?: string;";

  const propsType = typescript
    ? `
interface ${name}Props {
${propsInterface}
}
`
    : "";

  // propsの引数（デストラクチャリング）
  const propsNames = props.length > 0
    ? props.map((p) => p.name).join(", ")
    : "className";
  const propsArg = typescript ? `{ ${propsNames} }: ${name}Props` : `{ ${propsNames} }`;

  // スタイルクラス（tailwind対応）
  const baseClass = tailwind ? "relative" : "";

  return `${typescript ? "" : "// @ts-nocheck"}
import React from 'react';
${propsType}
export const ${name}${typescript ? `: React.FC<${name}Props>` : ""} = (${propsArg}) => {
  return (
    <div${baseClass ? ` className="${baseClass}"` : ""}>
      ${jsx}
    </div>
  );
};

export default ${name};
`.trim();
}

// =====================================================
// シングルトンインスタンス
// =====================================================

let layoutToCodeServiceInstance: LayoutToCodeService | null = null;

/**
 * LayoutToCodeServiceインスタンスを取得
 */
export function getLayoutToCodeService(): LayoutToCodeService {
  if (!layoutToCodeServiceInstance) {
    layoutToCodeServiceInstance = new LayoutToCodeService();
  }
  return layoutToCodeServiceInstance;
}

/**
 * LayoutToCodeServiceインスタンスをリセット
 */
export function resetLayoutToCodeService(): void {
  layoutToCodeServiceInstance = null;
}

/**
 * LayoutToCodeServiceファクトリを作成
 */
export function createLayoutToCodeServiceFactory(): () => ILayoutToCodeService {
  return () => getLayoutToCodeService();
}

export default LayoutToCodeService;
