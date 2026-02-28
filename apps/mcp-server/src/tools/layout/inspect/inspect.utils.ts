// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.inspect HTMLパースユーティリティ
 *
 * HTMLから以下の情報を抽出する純粋関数群:
 * - セクション構成（hero, features, cta等）
 * - 色情報（パレット、ドミナント、背景、テキスト色）
 * - タイポグラフィ（フォント、サイズスケール、行間）
 * - グリッド構成（flex, grid, float）
 * - Embedding用テキスト表現
 *
 * @module tools/layout/inspect/inspect.utils
 */

import { JSDOM } from 'jsdom';
import type {
  SectionInfo,
  SectionType,
  ColorPaletteInfo,
  TypographyInfo,
  GridInfo,
  LayoutInspectData,
  MediaElements,
  VideoInfo,
  VideoPositioning,
} from './inspect.schemas';
import type { VisualDecorationsResult } from './visual-extractors.schemas';
import { VisualDecorationDetectorService } from '../../../services/visual-extractor/visual-decoration-detector.service';

// =====================================================
// セクション検出パターン定義
// =====================================================

/**
 * セクション検出パターンの型定義
 */
interface SectionPattern {
  pattern: RegExp;
  type: SectionType;
  confidence: number;
}

/**
 * セクション検出用の正規表現パターン
 * 優先度順に並べられている
 */
const SECTION_PATTERNS: SectionPattern[] = [
  { pattern: /<header[^>]*>/i, type: 'header', confidence: 0.95 },
  { pattern: /<nav[^>]*>/i, type: 'navigation', confidence: 0.9 },
  { pattern: /class="[^"]*hero[^"]*"/i, type: 'hero', confidence: 0.9 },
  { pattern: /<section[^>]*class="[^"]*hero[^"]*"/i, type: 'hero', confidence: 0.95 },
  { pattern: /class="[^"]*features?[^"]*"/i, type: 'features', confidence: 0.85 },
  { pattern: /class="[^"]*testimonial[^"]*"/i, type: 'testimonial', confidence: 0.9 },
  { pattern: /<blockquote/i, type: 'testimonial', confidence: 0.7 },
  { pattern: /class="[^"]*pricing[^"]*"/i, type: 'pricing', confidence: 0.9 },
  { pattern: /class="[^"]*cta[^"]*"/i, type: 'cta', confidence: 0.85 },
  { pattern: /<footer[^>]*>/i, type: 'footer', confidence: 0.95 },
  { pattern: /class="[^"]*gallery[^"]*"/i, type: 'gallery', confidence: 0.85 },
  { pattern: /class="[^"]*about[^"]*"/i, type: 'about', confidence: 0.8 },
  { pattern: /class="[^"]*contact[^"]*"/i, type: 'contact', confidence: 0.85 },
  { pattern: /class="[^"]*faq[^"]*"/i, type: 'faq', confidence: 0.85 },
  { pattern: /class="[^"]*team[^"]*"/i, type: 'team', confidence: 0.8 },
];

/**
 * セクション検出用のCSSセレクター
 * DOMから直接セクション要素を取得するために使用
 */
interface SectionSelector {
  selector: string;
  type: SectionType;
  confidence: number;
  multi?: boolean;
}

const SECTION_SELECTORS: SectionSelector[] = [
  { selector: 'header', type: 'header', confidence: 0.95 },
  { selector: 'nav', type: 'navigation', confidence: 0.9 },
  { selector: 'section[class*="hero"], div[class*="hero"], [class*="hero"]', type: 'hero', confidence: 0.9 },
  { selector: 'section[class*="feature"], div[class*="feature"], [class*="feature"]', type: 'features', confidence: 0.85 },
  { selector: 'section[class*="testimonial"], div[class*="testimonial"], [class*="testimonial"]', type: 'testimonial', confidence: 0.9 },
  { selector: 'section[class*="pricing"], div[class*="pricing"], [class*="pricing"]', type: 'pricing', confidence: 0.9 },
  { selector: 'section[class*="cta"], div[class*="cta"], [class*="cta"]', type: 'cta', confidence: 0.85 },
  { selector: 'footer', type: 'footer', confidence: 0.95 },
  { selector: 'section[class*="gallery"], div[class*="gallery"], [class*="gallery"]', type: 'gallery', confidence: 0.85 },
  { selector: 'section[class*="about"], div[class*="about"], [class*="about"]', type: 'about', confidence: 0.8 },
  { selector: 'section[class*="contact"], div[class*="contact"], [class*="contact"]', type: 'contact', confidence: 0.85 },
  { selector: 'section[class*="faq"], div[class*="faq"], [class*="faq"]', type: 'faq', confidence: 0.85 },
  { selector: 'section[class*="team"], div[class*="team"], [class*="team"]', type: 'team', confidence: 0.8 },
  // WordPress / DigitalSilk block wrappers: treat each wrapper as a distinct content section
  { selector: 'div[class*="dst-wrapper"], div[class*="ds-blocks-dst-wrapper"]', type: 'content', confidence: 0.65, multi: true },
];

/**
 * セクションタイプごとのデフォルト高さ（ピクセル）
 */
export const SECTION_DEFAULT_HEIGHTS: Partial<Record<SectionType, number>> = {
  hero: 600,
  footer: 200,
};

export const DEFAULT_SECTION_HEIGHT = 400;

// =====================================================
// セクション検出関数
// =====================================================

/**
 * HTMLからセクションを検出する
 *
 * JSDOMを使用してHTML内のセクション構成を解析します。
 * 各セクションの実際のHTML範囲を特定し、そのコンテンツのみを抽出します。
 * 検出されたセクションは位置（startY）でソートされ、一意のIDが割り当てられます。
 *
 * @param html - 解析対象のHTML文字列
 * @returns 検出されたセクション情報の配列
 *
 * @example
 * ```typescript
 * const html = '<section class="hero"><h1>Welcome</h1></section>';
 * const sections = detectSections(html);
 * // [{ id: 'section-0', type: 'hero', confidence: 0.9, ... }]
 * ```
 */
export function detectSections(html: string): SectionInfo[] {
  const sections: SectionInfo[] = [];
  let currentY = 0;

  // 検出されたタイプを記録（重複防止）
  const detectedTypes = new Set<SectionType>();
  // 処理済み要素を記録（同じ要素を複数回処理しない）
  const processedElements = new Set<Element>();

  // JSDOMでHTMLをパース
  const dom = new JSDOM(html);
  const document = dom.window.document;

  for (const { selector, type, confidence, multi } of SECTION_SELECTORS) {
    if (!multi && detectedTypes.has(type)) continue;

    // セレクターにマッチする最初の要素を取得
    const elements = document.querySelectorAll(selector);

    for (const element of elements) {
      // 既に処理済みの要素、または処理済み要素の子要素はスキップ
      if (processedElements.has(element)) continue;

      let isChildOfProcessed = false;
      for (const processed of processedElements) {
        if (processed.contains(element)) {
          isChildOfProcessed = true;
          break;
        }
      }
      if (isChildOfProcessed) continue;

      // このタイプが既に検出済みならスキップ
      if (!multi && detectedTypes.has(type)) break;

      if (!multi) {
        detectedTypes.add(type);
      }
      processedElements.add(element);

      const sectionHeight = SECTION_DEFAULT_HEIGHTS[type] ?? DEFAULT_SECTION_HEIGHT;

      // セクション要素のHTMLを取得して、そのコンテンツのみを抽出
      const sectionHtml = element.outerHTML;

      sections.push({
        id: `section-${sections.length}`,
        type,
        confidence,
        position: {
          startY: currentY,
          endY: currentY + sectionHeight,
          height: sectionHeight,
        },
        content: extractSectionContent(sectionHtml, type),
        style: extractSectionStyle(sectionHtml, type),
      });

      currentY += sectionHeight;

      if (!multi) {
        break; // このタイプの最初の要素のみ処理
      }
    }
  }

  // 正規表現パターンでのフォールバック検出
  // （DOMセレクターで検出できなかったセクション用）
  for (const { pattern, type, confidence } of SECTION_PATTERNS) {
    if (pattern.test(html) && !detectedTypes.has(type)) {
      // セクション要素のHTML範囲を正規表現で抽出
      const sectionHtml = extractSectionHtmlByPattern(html, type);

      if (sectionHtml) {
        detectedTypes.add(type);
        const sectionHeight = SECTION_DEFAULT_HEIGHTS[type] ?? DEFAULT_SECTION_HEIGHT;

        sections.push({
          id: `section-${sections.length}`,
          type,
          confidence,
          position: {
            startY: currentY,
            endY: currentY + sectionHeight,
            height: sectionHeight,
          },
          content: extractSectionContent(sectionHtml, type),
          style: extractSectionStyle(sectionHtml, type),
        });

        currentY += sectionHeight;
      }
    }
  }

  // ソート（position.startYで昇順）
  sections.sort((a, b) => a.position.startY - b.position.startY);

  // IDを再割り当て
  sections.forEach((section, index) => {
    section.id = `section-${index}`;
  });

  return sections;
}

/**
 * 正規表現パターンを使用してセクションのHTML範囲を抽出
 *
 * @param html - 解析対象のHTML文字列
 * @param type - セクションタイプ
 * @returns セクションのHTML文字列、見つからない場合はnull
 */
function extractSectionHtmlByPattern(html: string, type: SectionType): string | null {
  // JSDOMでパースして該当セクションを探す
  const dom = new JSDOM(html);
  const document = dom.window.document;

  // タイプに応じたセレクターでセクションを取得
  const selectorMap: Record<SectionType, string> = {
    header: 'header',
    navigation: 'nav',
    hero: '[class*="hero"], section[class*="hero"]',
    features: '[class*="feature"], section[class*="feature"]',
    testimonial: '[class*="testimonial"], section[class*="testimonial"]',
    pricing: '[class*="pricing"], section[class*="pricing"]',
    cta: '[class*="cta"]:not(button), section[class*="cta"]',
    footer: 'footer',
    content: '[class*="content"], section[class*="content"], main',
    gallery: '[class*="gallery"], section[class*="gallery"]',
    about: '[class*="about"], section[class*="about"]',
    contact: '[class*="contact"], section[class*="contact"]',
    faq: '[class*="faq"], section[class*="faq"]',
    team: '[class*="team"], section[class*="team"]',
    stats: '[class*="stats"], section[class*="stats"]',
    unknown: '',
  };

  const selector = selectorMap[type];
  if (!selector) return null;

  const element = document.querySelector(selector);
  return element?.outerHTML ?? null;
}

/**
 * セクションコンテンツを抽出
 *
 * 渡されたHTMLからセクションタイプに対応する要素を特定し、
 * その要素内のコンテンツ（見出し、段落、リンク、画像、ボタン）を抽出します。
 *
 * HTML全体が渡された場合は、セクションタイプに対応する要素を自動的に特定します。
 * セクション要素のHTMLのみが渡された場合は、そのHTMLから直接抽出します。
 *
 * @param html - 解析対象のHTML文字列
 * @param sectionType - セクションタイプ（コンテンツ抽出の範囲を特定するために使用）
 * @returns セクションコンテンツ情報
 */
export function extractSectionContent(
  html: string,
  sectionType: SectionType
): SectionInfo['content'] {
  // セクションタイプに対応するセレクター
  const selectorMap: Record<SectionType, string> = {
    header: 'header',
    navigation: 'nav',
    hero: '[class*="hero"], section[class*="hero"]',
    features: '[class*="feature"], section[class*="feature"]',
    testimonial: '[class*="testimonial"], section[class*="testimonial"]',
    pricing: '[class*="pricing"], section[class*="pricing"]',
    cta: 'section[class*="cta"], div[class*="cta"]:not(button)',
    footer: 'footer',
    content: '[class*="content"], section[class*="content"], main',
    gallery: '[class*="gallery"], section[class*="gallery"]',
    about: '[class*="about"], section[class*="about"]',
    contact: '[class*="contact"], section[class*="contact"]',
    faq: '[class*="faq"], section[class*="faq"]',
    team: '[class*="team"], section[class*="team"]',
    stats: '[class*="stats"], section[class*="stats"]',
    unknown: '',
  };

  // JSDOMでHTMLをパース
  const dom = new JSDOM(html);
  const document = dom.window.document;

  // セレクターで該当セクション要素を取得
  const selector = selectorMap[sectionType];
  let sectionElement: Element | null = null;

  if (selector) {
    sectionElement = document.querySelector(selector);
  }

  // セクション要素が見つからない場合は、渡されたHTML全体がセクション要素として扱う
  // （detectSectionsから呼ばれた場合、既にセクション範囲のHTMLが渡されている）
  if (!sectionElement) {
    sectionElement = document.body;
  }

  return extractContentFromElement(sectionElement);
}

/**
 * DOM要素からコンテンツを抽出
 *
 * @param element - 対象のDOM要素
 * @returns セクションコンテンツ情報
 */
function extractContentFromElement(element: Element): SectionInfo['content'] {
  const headings: SectionInfo['content']['headings'] = [];
  const paragraphs: string[] = [];
  const links: SectionInfo['content']['links'] = [];
  const images: SectionInfo['content']['images'] = [];
  const buttons: SectionInfo['content']['buttons'] = [];

  // 見出し抽出（h1-h6）
  const headingElements = element.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const h of headingElements) {
    const level = parseInt(h.tagName.charAt(1), 10);
    const text = h.textContent?.trim() ?? '';
    if (text) {
      headings.push({ level, text });
    }
  }

  // 段落抽出
  const paragraphElements = element.querySelectorAll('p');
  for (const p of paragraphElements) {
    const text = p.textContent?.trim() ?? '';
    if (text) {
      paragraphs.push(text);
    }
  }

  // リンク抽出
  const linkElements = element.querySelectorAll('a[href]');
  for (const a of linkElements) {
    const href = a.getAttribute('href') ?? '';
    const text = a.textContent?.trim() ?? '';
    links.push({ href, text });
  }

  // 画像抽出
  const imageElements = element.querySelectorAll('img[src]');
  for (const img of imageElements) {
    const src = img.getAttribute('src') ?? '';
    const alt = img.getAttribute('alt') ?? undefined;
    images.push({ src, alt });
  }

  // ボタン抽出
  const buttonElements = element.querySelectorAll('button');
  for (const btn of buttonElements) {
    const text = btn.textContent?.trim() ?? '';
    const className = btn.getAttribute('class') ?? '';
    const type =
      className.includes('cta') || className.includes('primary') ? 'primary' : 'secondary';
    buttons.push({ text, type });
  }

  return { headings, paragraphs, links, images, buttons };
}

/**
 * セクションスタイルを抽出
 *
 * HTML/CSS内からスタイル情報（背景色、テキスト色、グラデーション、背景画像）を抽出します。
 * heroセクションは特別な処理で、.heroクラスのスタイルを解析します。
 *
 * @param html - 解析対象のHTML文字列
 * @param sectionType - セクションタイプ（heroの場合は特別処理）
 * @returns セクションスタイル情報
 */
export function extractSectionStyle(html: string, sectionType: SectionType): SectionInfo['style'] {
  const style: SectionInfo['style'] = {};

  // 背景色の検出
  const bgColorMatch = html.match(/background(?:-color)?:\s*([#\w]+)/i);
  if (bgColorMatch) {
    const color = bgColorMatch[1];
    if (color?.startsWith('#')) {
      style.backgroundColor = color;
    }
  }

  // テキスト色の検出
  const textColorMatch = html.match(/(?:^|\s)color:\s*([#\w]+)/i);
  if (textColorMatch) {
    const color = textColorMatch[1];
    if (color?.startsWith('#')) {
      style.textColor = color;
    }
  }

  // グラデーションの検出
  style.hasGradient = /linear-gradient|radial-gradient/i.test(html);

  // 背景画像の検出
  style.hasImage = /background(?:-image)?:\s*url/i.test(html);

  // heroセクションは特別な処理
  if (sectionType === 'hero') {
    const heroStyleMatch = html.match(/\.hero\s*\{([^}]*)\}/i);
    if (heroStyleMatch) {
      const heroStyle = heroStyleMatch[1] ?? '';
      const heroBgMatch = heroStyle.match(/background(?:-color)?:\s*([^;]+)/i);
      if (heroBgMatch) {
        const bgValue = heroBgMatch[1]?.trim() ?? '';
        if (bgValue.includes('gradient')) {
          style.hasGradient = true;
          // グラデーションから最初の色を抽出
          const colorMatch = bgValue.match(/#[0-9a-fA-F]{6}/);
          if (colorMatch) {
            style.backgroundColor = colorMatch[0];
          }
        } else if (bgValue.startsWith('#')) {
          style.backgroundColor = bgValue;
        }
      }
      // heroセクションのテキスト色
      const heroColorMatch = heroStyle.match(/(?:^|;)\s*color:\s*([^;]+)/i);
      if (heroColorMatch) {
        style.textColor = heroColorMatch[1]?.trim();
      }
    }
  }

  return style;
}

// =====================================================
// 色情報抽出関数
// =====================================================

/**
 * 色情報を抽出
 *
 * HTML/CSS内からHEXカラーとRGBカラーを抽出し、出現回数でソートしたパレットを作成します。
 * 色の役割（primary, secondary, background, text）も推定します。
 *
 * @param html - 解析対象のHTML文字列
 * @returns カラーパレット情報
 *
 * @example
 * ```typescript
 * const html = '<div style="color: #333; background: #ffffff;">';
 * const colors = extractColors(html);
 * // { palette: [...], dominant: '#333333', background: '#FFFFFF', text: '#333333' }
 * ```
 */
export function extractColors(html: string): ColorPaletteInfo {
  const colorCounts = new Map<string, number>();

  // HEXカラーを抽出
  const hexMatches = html.matchAll(/#([0-9a-fA-F]{6})\b/g);
  for (const match of hexMatches) {
    const hex = `#${(match[1] ?? '').toUpperCase()}`;
    colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 1);
  }

  // rgb/rgbaカラーを抽出しHEXに変換
  const rgbMatches = html.matchAll(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/gi);
  for (const match of rgbMatches) {
    const r = parseInt(match[1] ?? '0', 10);
    const g = parseInt(match[2] ?? '0', 10);
    const b = parseInt(match[3] ?? '0', 10);
    const hex = rgbToHex(r, g, b);
    colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 1);
  }

  // ソートしてパレット作成
  const sortedColors = Array.from(colorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([hex, count]) => ({ hex, count }));

  // 色の役割を推定
  const palette = sortedColors.map((color, index) => {
    const role = inferColorRole(color.hex, index, sortedColors);
    return { ...color, role };
  });

  // ドミナント、背景、テキスト色の決定
  const dominant = palette.find((c) => c.role === 'primary')?.hex ??
    palette.find((c) => c.role !== 'background' && c.role !== 'text')?.hex ??
    '#000000';

  const background = palette.find((c) => c.role === 'background')?.hex ?? '#FFFFFF';
  const text = palette.find((c) => c.role === 'text')?.hex ?? '#000000';
  const accent = palette.find((c) => c.role === 'secondary')?.hex;

  return {
    palette,
    dominant,
    background,
    text,
    accent,
  };
}

/**
 * RGBをHEX形式に変換
 *
 * @param r - 赤成分（0-255）
 * @param g - 緑成分（0-255）
 * @param b - 青成分（0-255）
 * @returns HEX形式の色コード（大文字）
 */
function rgbToHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
}

/**
 * 色の役割を推定
 *
 * @param hex - HEX形式の色コード
 * @param index - パレット内のインデックス
 * @param sortedColors - ソート済み色配列
 * @returns 推定された色の役割
 */
export function inferColorRole(
  hex: string,
  index: number,
  sortedColors: Array<{ hex: string; count: number }>
): string | undefined {
  const hexLower = hex.toLowerCase();

  // 白系
  if (hexLower === '#ffffff' || hexLower === '#fff') {
    return 'background';
  }
  // 黒系（ダークモードのテキストやボディカラー）
  if (
    hexLower === '#000000' ||
    hexLower === '#1a1a1a' ||
    hexLower === '#1f2937' ||
    hexLower === '#111827'
  ) {
    return 'text';
  }

  // 白・黒以外の色で役割を決定
  // 白・黒を除いたインデックスを計算
  const colorIndex = sortedColors.slice(0, index + 1).filter((c) => {
    const h = c.hex.toLowerCase();
    return (
      h !== '#ffffff' &&
      h !== '#fff' &&
      h !== '#000000' &&
      h !== '#1a1a1a' &&
      h !== '#1f2937' &&
      h !== '#111827'
    );
  }).length - 1;

  // 最も使われている色（白・黒以外で最初）
  if (colorIndex === 0) {
    return 'primary';
  }
  // 2番目に使われている色
  if (colorIndex === 1) {
    return 'secondary';
  }

  return undefined;
}

// =====================================================
// タイポグラフィ解析関数
// =====================================================

/**
 * タイポグラフィ情報を解析
 *
 * HTML/CSS内からフォント情報、見出しサイズスケール、本文サイズ、行間を抽出します。
 *
 * @param html - 解析対象のHTML文字列
 * @returns タイポグラフィ情報
 *
 * @example
 * ```typescript
 * const html = '<style>body { font-family: "Inter", sans-serif; }</style>';
 * const typography = analyzeTypography(html);
 * // { fonts: [{ family: 'Inter', weights: [400] }], ... }
 * ```
 */
export function analyzeTypography(html: string): TypographyInfo {
  const fonts: TypographyInfo['fonts'] = [];
  const fontFamilies = new Map<string, Set<number>>();

  // font-familyを抽出
  const fontFamilyMatches = html.matchAll(/font-family:\s*([^;]+)/gi);
  for (const match of fontFamilyMatches) {
    const familyString = match[1] ?? '';
    // 最初のフォントを取得
    const firstFont = familyString.split(',')[0]?.trim().replace(/['"]/g, '');
    if (firstFont && !firstFont.startsWith('-apple-system')) {
      if (!fontFamilies.has(firstFont)) {
        fontFamilies.set(firstFont, new Set());
      }
    }
  }

  // font-weightを抽出
  const fontWeightMatches = html.matchAll(/font-weight:\s*(\d+|bold|normal)/gi);
  for (const match of fontWeightMatches) {
    const weightStr = match[1] ?? '400';
    const weight = parseWeight(weightStr);

    // すべてのフォントに適用
    for (const [, weights] of fontFamilies) {
      weights.add(weight);
    }
  }

  // フォント情報を配列に変換
  for (const [family, weights] of fontFamilies) {
    fonts.push({
      family,
      weights: Array.from(weights).sort((a, b) => a - b),
    });
  }

  // デフォルトフォントがない場合
  if (fonts.length === 0) {
    fonts.push({ family: 'sans-serif', weights: [400] });
  }

  // 見出しスケールを抽出
  const headingScale = extractHeadingScale(html);

  // 本文サイズ
  const bodySize = extractBodySize(html);

  // 行間
  const lineHeight = extractLineHeight(html);

  return {
    fonts,
    headingScale,
    bodySize,
    lineHeight,
  };
}

/**
 * font-weight文字列を数値に変換
 */
function parseWeight(weightStr: string): number {
  if (weightStr === 'bold') return 700;
  if (weightStr === 'normal') return 400;
  return parseInt(weightStr, 10);
}

/**
 * 見出しサイズスケールを抽出
 * - <style>タグ内のCSS: h1 { font-size: 64px; }
 * - インラインスタイル: <h1 style="font-size: 64px;">
 */
function extractHeadingScale(html: string): number[] {
  const headingScale: number[] = [];
  for (let i = 1; i <= 6; i++) {
    // <style>タグ内のCSSブロック形式
    let sizeMatch = html.match(new RegExp(`h${i}[^{]*\\{[^}]*font-size:\\s*(\\d+)`, 'i'));

    // インラインスタイル形式: <h1 style="font-size: 64px;">
    if (!sizeMatch) {
      sizeMatch = html.match(new RegExp(`<h${i}[^>]*style="[^"]*font-size:\\s*(\\d+)`, 'i'));
    }
    // シングルクォート版
    if (!sizeMatch) {
      sizeMatch = html.match(new RegExp(`<h${i}[^>]*style='[^']*font-size:\\s*(\\d+)`, 'i'));
    }

    if (sizeMatch) {
      headingScale.push(parseInt(sizeMatch[1] ?? '16', 10));
    }
  }

  // デフォルトスケール
  if (headingScale.length === 0) {
    headingScale.push(48, 36, 24, 20, 18, 16);
  }

  return headingScale;
}

/**
 * 本文サイズを抽出
 * - <style>タグ内のCSS: body { font-size: 16px; } または p { font-size: 18px; }
 * - インラインスタイル: <p style="font-size: 18px;">
 */
function extractBodySize(html: string): number {
  // <style>タグ内のCSSブロック形式
  let bodySizeMatch = html.match(/(?:body|p)[^{]*\{[^}]*font-size:\s*(\d+)/i);
  if (bodySizeMatch) {
    return parseInt(bodySizeMatch[1] ?? '16', 10);
  }

  // インラインスタイル: <p style="font-size: 18px;">
  bodySizeMatch = html.match(/<p[^>]*style="[^"]*font-size:\s*(\d+)/i);
  if (bodySizeMatch) {
    return parseInt(bodySizeMatch[1] ?? '16', 10);
  }
  // シングルクォート版
  bodySizeMatch = html.match(/<p[^>]*style='[^']*font-size:\s*(\d+)/i);
  if (bodySizeMatch) {
    return parseInt(bodySizeMatch[1] ?? '16', 10);
  }

  return 16;
}

/**
 * 行間を抽出
 */
function extractLineHeight(html: string): number {
  const lineHeightMatch = html.match(/line-height:\s*([\d.]+)/i);
  if (lineHeightMatch) {
    return parseFloat(lineHeightMatch[1] ?? '1.5');
  }
  return 1.5;
}

// =====================================================
// グリッド検出関数
// =====================================================

/**
 * グリッド情報を検出
 *
 * HTML/CSS内からグリッドシステム（CSS Grid, Flexbox, Float）を検出します。
 * 検出優先度: CSS Grid > Flexbox > Float
 *
 * @param html - 解析対象のHTML文字列
 * @returns グリッド情報
 *
 * @example
 * ```typescript
 * const html = '<style>.container { display: grid; grid-template-columns: repeat(3, 1fr); }</style>';
 * const grid = detectGrid(html);
 * // { type: 'grid', columns: 3 }
 * ```
 */
export function detectGrid(html: string): GridInfo {
  // CSS Gridの検出
  const gridMatch = html.match(/display:\s*grid/i);
  if (gridMatch) {
    return parseGridStyles(html);
  }

  // Flexboxの検出
  const flexMatch = html.match(/display:\s*flex/i);
  if (flexMatch) {
    return parseFlexStyles(html);
  }

  // Floatの検出
  const floatMatch = html.match(/float:\s*(left|right)/i);
  if (floatMatch) {
    return { type: 'float' };
  }

  return { type: 'unknown' };
}

/**
 * CSS Gridスタイルを解析
 */
function parseGridStyles(html: string): GridInfo {
  const grid: GridInfo = { type: 'grid' };

  // カラム数
  const columnsMatch = html.match(/grid-template-columns:\s*repeat\(\s*(\d+)/i);
  if (columnsMatch) {
    grid.columns = parseInt(columnsMatch[1] ?? '1', 10);
  }

  // ガター幅
  const gapMatch = html.match(/gap:\s*(\d+)/i);
  if (gapMatch) {
    grid.gutterWidth = parseInt(gapMatch[1] ?? '0', 10);
  }

  // max-width
  const maxWidthMatch = html.match(/max-width:\s*(\d+)/i);
  if (maxWidthMatch) {
    grid.maxWidth = parseInt(maxWidthMatch[1] ?? '0', 10);
  }

  // ブレイクポイント
  const breakpoints = parseBreakpoints(html);
  if (breakpoints.length > 0) {
    grid.breakpoints = breakpoints;
  }

  return grid;
}

/**
 * Flexboxスタイルを解析
 */
function parseFlexStyles(html: string): GridInfo {
  const grid: GridInfo = { type: 'flex' };

  // ガター幅
  const gapMatch = html.match(/gap:\s*(\d+)/i);
  if (gapMatch) {
    grid.gutterWidth = parseInt(gapMatch[1] ?? '0', 10);
  }

  return grid;
}

/**
 * ブレイクポイントを解析
 */
function parseBreakpoints(html: string): NonNullable<GridInfo['breakpoints']> {
  const breakpoints: NonNullable<GridInfo['breakpoints']> = [];
  const mediaMatches = html.matchAll(/@media[^{]*\((?:max|min)-width:\s*(\d+)px\)/gi);

  for (const match of mediaMatches) {
    const width = parseInt(match[1] ?? '0', 10);
    let name = 'sm';
    if (width >= 1024) name = 'lg';
    else if (width >= 768) name = 'md';
    else if (width >= 480) name = 'sm';
    else name = 'xs';

    breakpoints.push({ name, minWidth: width });
  }

  return breakpoints.sort((a, b) => a.minWidth - b.minWidth);
}

// =====================================================
// テキスト表現生成関数
// =====================================================

/**
 * テキスト表現を生成（Embedding用）
 *
 * 解析データからベクトル検索用のテキスト表現を生成します。
 * セクション構成、色、タイポグラフィ、グリッド情報、メディア要素を自然言語で表現します。
 *
 * @param data - 解析済みレイアウトデータ
 * @returns Embedding用テキスト表現
 *
 * @example
 * ```typescript
 * const data: LayoutInspectData = { ... };
 * const text = generateTextRepresentation(data);
 * // "Layout with 3 sections: hero, features, footer. Color palette: #3B82F6 dominant, #FFFFFF background."
 * ```
 */
export function generateTextRepresentation(data: LayoutInspectData): string {
  const parts: string[] = [];

  // セクション情報
  if (data.sections.length > 0) {
    const sectionTypes = data.sections.map((s) => s.type).join(', ');
    parts.push(`Layout with ${data.sections.length} sections: ${sectionTypes}.`);

    // heroセクションの詳細
    const hero = data.sections.find((s) => s.type === 'hero');
    if (hero) {
      const heading = hero.content.headings[0];
      if (heading) {
        parts.push(`Hero section with heading '${heading.text}'.`);
      }
      if (hero.content.buttons.length > 0) {
        const buttonTexts = hero.content.buttons.map((b) => b.text).join(', ');
        parts.push(`CTA buttons: ${buttonTexts}.`);
      }
    }

    // featuresセクション
    const features = data.sections.find((s) => s.type === 'features');
    if (features) {
      const imageCount = features.content.images.length;
      if (imageCount > 0) {
        parts.push(`${imageCount} feature items with icons.`);
      }
    }
  }

  // 色情報
  parts.push(`Color palette: ${data.colors.dominant} dominant, ${data.colors.background} background.`);

  // タイポグラフィ情報
  if (data.typography.fonts.length > 0) {
    const fontNames = data.typography.fonts.map((f) => f.family).join(', ');
    parts.push(`Typography: ${fontNames} font.`);
  }

  // グリッド情報
  if (data.grid.type !== 'unknown') {
    let gridDesc = `${data.grid.type} layout`;
    if (data.grid.columns) {
      gridDesc += ` with ${data.grid.columns} columns`;
    }
    parts.push(`${gridDesc}.`);
  }

  // メディア要素情報（video）
  if (data.mediaElements) {
    const { videos, backgroundVideos } = data.mediaElements;
    if (backgroundVideos.length > 0) {
      parts.push(`Background video: ${backgroundVideos.length} video(s) used as background.`);
    }
    if (videos.length > backgroundVideos.length) {
      const inlineCount = videos.length - backgroundVideos.length;
      parts.push(`Media: ${inlineCount} inline video(s).`);
    }
  }

  return parts.join(' ');
}

// =====================================================
// デフォルト値ヘルパー
// =====================================================

/**
 * デフォルトのカラーパレット情報を取得
 *
 * @returns デフォルトのColorPaletteInfo
 */
export function getDefaultColorPalette(): ColorPaletteInfo {
  return {
    palette: [],
    dominant: '#000000',
    background: '#FFFFFF',
    text: '#000000',
  };
}

/**
 * デフォルトのタイポグラフィ情報を取得
 *
 * @returns デフォルトのTypographyInfo
 */
export function getDefaultTypography(): TypographyInfo {
  return {
    fonts: [],
    headingScale: [],
    bodySize: 16,
    lineHeight: 1.5,
  };
}

/**
 * デフォルトのグリッド情報を取得
 *
 * @returns デフォルトのGridInfo
 */
export function getDefaultGrid(): GridInfo {
  return { type: 'unknown' };
}

// =====================================================
// Video要素検出関数
// =====================================================

/**
 * デフォルトのメディア要素情報を取得
 *
 * @returns デフォルトのMediaElements
 */
export function getDefaultMediaElements(): MediaElements {
  return {
    videos: [],
    backgroundVideos: [],
  };
}

/**
 * Video要素の配置パターンを解析
 *
 * @param element - video要素または親コンテナ
 * @param style - インラインスタイル文字列
 * @returns 配置パターン
 */
function analyzeVideoPositioning(element: Element, style: string): VideoPositioning {
  const styleLower = style.toLowerCase();

  // 親要素のスタイルもチェック
  const parentStyle = element.parentElement?.getAttribute('style')?.toLowerCase() ?? '';

  // position: fixed + z-index: -1 パターン（ページ全体背景）
  if (
    (styleLower.includes('position: fixed') || styleLower.includes('position:fixed') ||
     parentStyle.includes('position: fixed') || parentStyle.includes('position:fixed')) &&
    (styleLower.includes('z-index: -1') || styleLower.includes('z-index:-1') ||
     parentStyle.includes('z-index: -1') || parentStyle.includes('z-index:-1'))
  ) {
    return 'fixed-background';
  }

  // position: absolute + z-index: -1 パターン（セクション背景）
  if (
    (styleLower.includes('position: absolute') || styleLower.includes('position:absolute') ||
     parentStyle.includes('position: absolute') || parentStyle.includes('position:absolute')) &&
    (styleLower.includes('z-index: -1') || styleLower.includes('z-index:-1') ||
     parentStyle.includes('z-index: -1') || parentStyle.includes('z-index:-1'))
  ) {
    return 'absolute-background';
  }

  return 'inline';
}

/**
 * Video要素のCSSセレクタを生成
 *
 * @param element - video要素
 * @param index - 同一タグ内でのインデックス
 * @returns CSSセレクタ文字列
 */
function generateVideoSelector(element: Element, index: number): string {
  // 親要素のクラスやIDを取得して、より具体的なセレクタを生成
  const parentClasses: string[] = [];
  let parent = element.parentElement;
  let depth = 0;
  const maxDepth = 3;

  while (parent && depth < maxDepth) {
    const parentClass = parent.getAttribute('class');
    const parentId = parent.getAttribute('id');
    const parentTag = parent.tagName.toLowerCase();

    if (parentId) {
      parentClasses.unshift(`#${parentId}`);
      break;
    } else if (parentClass) {
      const firstClass = parentClass.split(' ').filter(c => c.trim())[0];
      if (firstClass) {
        parentClasses.unshift(`.${firstClass}`);
      }
    } else if (parentTag === 'section' || parentTag === 'header' || parentTag === 'footer') {
      parentClasses.unshift(parentTag);
    }

    parent = parent.parentElement;
    depth++;
  }

  // セレクタを構築
  if (parentClasses.length > 0) {
    return `${parentClasses.join(' ')} video`;
  }

  // フォールバック: インデックスベース
  return index === 0 ? 'video' : `video:nth-of-type(${index + 1})`;
}

/**
 * HTMLからVideo要素を検出する
 *
 * JSDOMを使用してHTML内のvideo要素を解析します。
 * - src属性とsource子要素からURL抽出
 * - poster属性の抽出
 * - 再生制御属性（autoplay, loop, muted, playsinline, controls）の検出
 * - 背景動画パターン（position: absolute/fixed + z-index: -1）の判定
 *
 * @param html - 解析対象のHTML文字列
 * @returns メディア要素情報
 *
 * @example
 * ```typescript
 * const html = '<video autoplay muted loop src="/bg.mp4" style="position: absolute; z-index: -1;"></video>';
 * const media = detectVideos(html);
 * // { videos: [{ src: '/bg.mp4', positioning: 'absolute-background', ... }], backgroundVideos: [...] }
 * ```
 */
export function detectVideos(html: string): MediaElements {
  const videos: VideoInfo[] = [];

  // JSDOMでHTMLをパース
  const dom = new JSDOM(html);
  const document = dom.window.document;

  // video要素を検出
  const videoElements = document.querySelectorAll('video');

  videoElements.forEach((videoElement, index) => {
    const videoInfo: VideoInfo = {
      selector: generateVideoSelector(videoElement, index),
    };

    // src属性
    const src = videoElement.getAttribute('src');
    if (src) {
      videoInfo.src = src;
    }

    // source子要素
    const sourceElements = videoElement.querySelectorAll('source');
    if (sourceElements.length > 0) {
      videoInfo.sources = [];
      sourceElements.forEach((sourceElement) => {
        const sourceSrc = sourceElement.getAttribute('src');
        const sourceType = sourceElement.getAttribute('type');
        if (sourceSrc) {
          const sourceInfo: { src: string; type?: string } = { src: sourceSrc };
          if (sourceType) {
            sourceInfo.type = sourceType;
          }
          videoInfo.sources!.push(sourceInfo);
        }
      });
    }

    // poster属性
    const poster = videoElement.getAttribute('poster');
    if (poster) {
      videoInfo.poster = poster;
    }

    // 再生制御属性
    videoInfo.attributes = {
      autoplay: videoElement.hasAttribute('autoplay'),
      loop: videoElement.hasAttribute('loop'),
      muted: videoElement.hasAttribute('muted'),
      playsinline: videoElement.hasAttribute('playsinline'),
      controls: videoElement.hasAttribute('controls'),
    };

    // 配置パターン解析
    const style = videoElement.getAttribute('style') ?? '';
    videoInfo.positioning = analyzeVideoPositioning(videoElement, style);

    videos.push(videoInfo);
  });

  // 背景動画のフィルタ
  const backgroundVideos = videos.filter(
    (v) => v.positioning === 'absolute-background' || v.positioning === 'fixed-background'
  );

  return {
    videos,
    backgroundVideos,
  };
}

// =====================================================
// VisualDecoration検出関数
// =====================================================

/**
 * VisualDecorationDetectorサービスのシングルトンインスタンス
 */
const visualDecorationDetector = new VisualDecorationDetectorService();

/**
 * HTMLから視覚的装飾要素を検出する
 *
 * 以下の視覚効果を検出します:
 * - glow: box-shadowベースの発光効果
 * - gradient: linear-gradient, radial-gradient, conic-gradient背景
 * - animated-border: アニメーション付きボーダー、グラデーションボーダー
 * - glass-morphism: backdrop-filterベースのガラス効果
 *
 * @param html - 解析対象のHTML文字列
 * @returns 検出された視覚装飾の結果
 *
 * @example
 * ```typescript
 * const html = '<div style="box-shadow: 0 0 20px rgba(255, 100, 50, 0.5);"></div>';
 * const result = detectVisualDecorations(html);
 * // { decorations: [{ type: 'glow', element: 'div', properties: { color: '#ff6432', blur: 20 }, confidence: 0.9 }], ... }
 * ```
 */
export function detectVisualDecorations(html: string): VisualDecorationsResult {
  return visualDecorationDetector.detectFromHTML(html);
}

/**
 * デフォルトのVisualDecorationsResult を取得
 *
 * @returns デフォルトのVisualDecorationsResult
 */
export function getDefaultVisualDecorations(): VisualDecorationsResult {
  return {
    decorations: [],
    summary: {
      glowCount: 0,
      gradientCount: 0,
      animatedBorderCount: 0,
      glassMorphismCount: 0,
    },
    processingTimeMs: 0,
  };
}
