// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Semantic HTML Converter
 *
 * sectionTypeに基づいてセマンティックHTML要素への変換を行います。
 *
 * 機能:
 * - sectionType → HTML要素マッピング（hero → section, header → header など）
 * - aria-label属性の自動生成
 * - ルートdiv要素のセマンティック要素への変換
 *
 * REFTRIX-CODEGEN-02: セマンティックHTML構造最適化
 *
 * @module services/layout/semantic-html-converter
 */

import { JSDOM } from 'jsdom';

// ==========================================================
// 型定義
// ==========================================================

/**
 * セマンティック変換オプション
 */
export interface SemanticConversionOptions {
  /** セクションタイプ（hero, header, footer など） */
  sectionType: string;
  /** セクション名（aria-label用、オプション） */
  sectionName?: string;
  /** aria-labelを追加するか（デフォルト: true） */
  addAriaLabel?: boolean;
  /** 既存のaria-labelを保持するか（デフォルト: false） */
  preserveExistingAriaLabel?: boolean;
  /** ルート要素のみ変換するか（デフォルト: true） */
  convertRootOnly?: boolean;
}

// ==========================================================
// 定数
// ==========================================================

/**
 * sectionType → HTML要素マッピング
 *
 * 設計方針:
 * - hero, feature, cta, testimonial, pricing, faq, contact → <section>
 * - header → <header>
 * - footer → <footer>
 * - navigation, nav → <nav>
 * - content, main → <main>
 * - article → <article>
 * - sidebar, aside → <aside>
 * - その他/未知 → <section>（デフォルト）
 */
const SECTION_TYPE_TO_ELEMENT: Record<string, string> = {
  // ページ構造要素
  header: 'header',
  footer: 'footer',
  navigation: 'nav',
  nav: 'nav',
  content: 'main',
  main: 'main',
  article: 'article',
  sidebar: 'aside',
  aside: 'aside',

  // セクション要素（すべて <section> にマッピング）
  hero: 'section',
  feature: 'section',
  features: 'section',
  cta: 'section',
  testimonial: 'section',
  testimonials: 'section',
  pricing: 'section',
  faq: 'section',
  contact: 'section',
  about: 'section',
  services: 'section',
  portfolio: 'section',
  gallery: 'section',
  team: 'section',
  blog: 'section',
  news: 'section',
  stats: 'section',
  clients: 'section',
  partners: 'section',
  logos: 'section',
  benefits: 'section',
  process: 'section',
  timeline: 'section',
  comparison: 'section',
  download: 'section',
  subscribe: 'section',
  newsletter: 'section',
};

/**
 * sectionType → aria-labelデフォルト値マッピング
 */
const SECTION_TYPE_TO_DEFAULT_LABEL: Record<string, string> = {
  header: 'Site header',
  footer: 'Site footer',
  navigation: 'Main navigation',
  nav: 'Main navigation',
  content: 'Main content',
  main: 'Main content',
  sidebar: 'Sidebar navigation',
  aside: 'Sidebar navigation',
};

// ==========================================================
// ヘルパー関数
// ==========================================================

/**
 * 文字列の先頭を大文字にする
 */
function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// ==========================================================
// メイン関数
// ==========================================================

/**
 * sectionTypeからHTML要素名を取得
 *
 * @param sectionType - セクションタイプ（例: hero, header, footer）
 * @returns HTML要素名（例: section, header, footer）
 *
 * @example
 * ```typescript
 * mapSectionTypeToElement('hero');     // 'section'
 * mapSectionTypeToElement('header');   // 'header'
 * mapSectionTypeToElement('footer');   // 'footer'
 * mapSectionTypeToElement('navigation'); // 'nav'
 * ```
 */
export function mapSectionTypeToElement(sectionType: string): string {
  const normalizedType = sectionType.toLowerCase().trim();

  // マッピングに存在する場合はそれを返す
  if (SECTION_TYPE_TO_ELEMENT[normalizedType]) {
    return SECTION_TYPE_TO_ELEMENT[normalizedType];
  }

  // デフォルトは section
  return 'section';
}

/**
 * aria-labelを生成
 *
 * @param sectionType - セクションタイプ
 * @param sectionName - セクション名（オプション）
 * @returns aria-label文字列
 *
 * @example
 * ```typescript
 * generateAriaLabel('hero', 'Modern Hero Section'); // 'Modern Hero Section'
 * generateAriaLabel('hero', undefined);             // 'Hero section'
 * generateAriaLabel('header', undefined);           // 'Site header'
 * ```
 */
export function generateAriaLabel(
  sectionType: string,
  sectionName: string | undefined
): string {
  // sectionNameが指定されている場合はそれを使用
  if (sectionName && sectionName.trim().length > 0) {
    return sectionName.trim();
  }

  const normalizedType = sectionType.toLowerCase().trim();

  // デフォルトラベルマッピングに存在する場合はそれを使用
  if (SECTION_TYPE_TO_DEFAULT_LABEL[normalizedType]) {
    return SECTION_TYPE_TO_DEFAULT_LABEL[normalizedType];
  }

  // それ以外の場合は「{Type} section」形式で生成
  return `${capitalize(normalizedType)} section`;
}

/**
 * HTMLをセマンティックHTML要素に変換
 *
 * ルートの<div>要素をsectionTypeに応じたセマンティック要素に変換し、
 * aria-label属性を追加します。
 *
 * @param html - 変換対象のHTML文字列
 * @param options - 変換オプション
 * @returns 変換されたHTML文字列
 *
 * @example
 * ```typescript
 * const html = '<div class="hero"><h1>Welcome</h1></div>';
 * const result = convertToSemanticHtml(html, {
 *   sectionType: 'hero',
 *   sectionName: 'Hero Section',
 * });
 * // '<section class="hero" aria-label="Hero Section"><h1>Welcome</h1></section>'
 * ```
 */
export function convertToSemanticHtml(
  html: string,
  options: SemanticConversionOptions
): string {
  // 空のHTMLの処理
  if (!html || html.trim().length === 0) {
    return '';
  }

  // デフォルトオプション
  const opts = {
    addAriaLabel: true,
    preserveExistingAriaLabel: false,
    convertRootOnly: true,
    ...options,
  };

  // 変換先のHTML要素を取得
  const targetElement = mapSectionTypeToElement(opts.sectionType);

  // aria-labelを生成
  const ariaLabel = generateAriaLabel(opts.sectionType, opts.sectionName);

  // JSDOMでパース
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const body = document.body;

  // ルート要素を取得（bodyの最初の子要素）
  const children = Array.from(body.children);
  if (children.length === 0) {
    return '';
  }

  // 最初の要素をルート要素として処理
  const rootElement = children[0];
  if (!rootElement) {
    return '';
  }

  // 現在の要素名を取得
  const currentTagName = rootElement.tagName.toLowerCase();

  // セマンティック要素のリスト
  const semanticElements = ['section', 'header', 'footer', 'nav', 'main', 'article', 'aside'];

  // 既にセマンティック要素の場合
  if (semanticElements.includes(currentTagName)) {
    // aria-labelの処理
    if (opts.addAriaLabel) {
      const existingAriaLabel = rootElement.getAttribute('aria-label');
      if (!existingAriaLabel || !opts.preserveExistingAriaLabel) {
        if (!existingAriaLabel) {
          rootElement.setAttribute('aria-label', ariaLabel);
        }
      }
    }
    return rootElement.outerHTML;
  }

  // div要素の場合、セマンティック要素に変換
  if (currentTagName === 'div') {
    // 新しいセマンティック要素を作成
    const newElement = document.createElement(targetElement);

    // 属性をコピー
    for (const attr of Array.from(rootElement.attributes)) {
      newElement.setAttribute(attr.name, attr.value);
    }

    // aria-labelを追加
    if (opts.addAriaLabel) {
      newElement.setAttribute('aria-label', ariaLabel);
    }

    // 子要素をコピー
    newElement.innerHTML = rootElement.innerHTML;

    return newElement.outerHTML;
  }

  // その他の要素の場合はセマンティック要素でラップ
  const wrapperElement = document.createElement(targetElement);
  if (opts.addAriaLabel) {
    wrapperElement.setAttribute('aria-label', ariaLabel);
  }
  wrapperElement.appendChild(rootElement.cloneNode(true));

  return wrapperElement.outerHTML;
}
