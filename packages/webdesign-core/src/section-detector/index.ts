// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SectionDetector
 *
 * Webページのセクション検出ロジック
 * cheerioを使用してHTMLを解析し、セクションを検出・分類する
 *
 * @module @reftrix/webdesign-core/section-detector
 */

import * as cheerio from 'cheerio';
import type { Element as DomElement } from 'domhandler';
import { v4 as uuidv4 } from 'uuid';
import type {
  SectionDetectorOptions,
  DetectedSection,
  SectionType,
  SectionContent,
  SectionStyle,
  ElementInfo,
  PositionInfo,
  ButtonType,
  SectionClassificationRule,
} from '../types/section.types';
import {
  ARIA_LANDMARK_ROLES,
  SEMANTIC_TAGS,
  SECTION_TYPE_MAPPINGS,
  HTML_SNIPPET_MAX_SIZE,
} from '../types/section.types';

// Type alias for Cheerio elements
type CheerioElement = cheerio.Cheerio<DomElement>;
type CheerioAPI = cheerio.CheerioAPI;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CheerioAnyElement = cheerio.Cheerio<any>;

// =========================================
// Classification Rules
// =========================================

const CLASSIFICATION_RULES: SectionClassificationRule[] = [
  // Hero detection rules
  {
    name: 'hero-class',
    targetType: 'hero',
    classPatterns: [/hero/i, /banner/i, /jumbotron/i, /masthead/i],
    idPatterns: [/hero/i, /banner/i],
    baseConfidence: 0.85,
  },
  {
    name: 'hero-content',
    targetType: 'hero',
    contentConditions: {
      requiresH1: true,
      requiresButton: true,
    },
    positionConditions: {
      isNearTop: true,
    },
    baseConfidence: 0.75,
  },
  // Navigation detection rules
  {
    name: 'navigation-tag',
    targetType: 'navigation',
    tagNames: ['nav'],
    ariaRoles: ['navigation'], // banner は hero/header エリアを示すため除外
    baseConfidence: 0.95,
  },
  {
    name: 'navigation-class',
    targetType: 'navigation',
    classPatterns: [/nav/i, /menu/i, /navigation/i, /navbar/i, /header/i],
    baseConfidence: 0.8,
  },
  // Feature detection rules (P1-1: ID属性強化)
  {
    name: 'feature-id',
    targetType: 'feature',
    // id="features", id="feature", id="features-section", id="mcp-tools" などを検出
    idPatterns: [/^features?$/i, /^features?-/i, /mcp-tools/i, /tools/i],
    baseConfidence: 0.85,
  },
  {
    name: 'feature-class',
    targetType: 'feature',
    classPatterns: [/feature/i, /benefit/i, /service/i, /grid/i, /column/i],
    baseConfidence: 0.8,
  },
  {
    name: 'feature-grid',
    targetType: 'feature',
    // P1-1: Tailwind グリッドクラスパターン検出
    classPatterns: [/grid-cols-[2-4]/i, /md:grid-cols-[2-4]/i, /lg:grid-cols-[2-4]/i, /sm:grid-cols-[2-4]/i],
    baseConfidence: 0.75,
  },
  {
    name: 'feature-content',
    targetType: 'feature',
    contentConditions: {
      minImages: 2,
      minHeadings: 2,
    },
    baseConfidence: 0.7,
  },
  // CTA detection rules (P1-1: 信頼度と検出強化)
  {
    name: 'cta-id',
    targetType: 'cta',
    // id="cta", id="cta-section", id="call-to-action" などを検出
    idPatterns: [/^cta$/i, /^cta-/i, /call-to-action/i],
    baseConfidence: 0.85,
  },
  {
    name: 'cta-class',
    targetType: 'cta',
    classPatterns: [/cta/i, /call-to-action/i, /action/i, /signup/i],
    baseConfidence: 0.85,
  },
  {
    name: 'cta-content',
    targetType: 'cta',
    contentConditions: {
      requiresButton: true,
    },
    // P1-1: CTAの基礎信頼度を引き上げ（0.6 → 0.7）
    baseConfidence: 0.7,
  },
  // Testimonial detection rules
  {
    name: 'testimonial-class',
    targetType: 'testimonial',
    classPatterns: [/testimonial/i, /review/i, /quote/i, /customer/i, /feedback/i],
    baseConfidence: 0.85,
  },
  // Pricing detection rules
  {
    name: 'pricing-class',
    targetType: 'pricing',
    classPatterns: [/pricing/i, /price/i, /plan/i, /package/i, /subscription/i],
    baseConfidence: 0.9,
  },
  // Footer detection rules
  {
    name: 'footer-tag',
    targetType: 'footer',
    tagNames: ['footer'],
    ariaRoles: ['contentinfo'],
    baseConfidence: 0.95,
  },
  {
    name: 'footer-class',
    targetType: 'footer',
    classPatterns: [/footer/i, /bottom/i],
    baseConfidence: 0.8,
  },
  // About detection rules
  {
    name: 'about-class',
    targetType: 'about',
    classPatterns: [/about/i, /company/i, /team/i, /story/i, /who-we-are/i],
    baseConfidence: 0.85,
  },
  // Contact detection rules
  {
    name: 'contact-class',
    targetType: 'contact',
    classPatterns: [/contact/i, /get-in-touch/i, /reach/i],
    baseConfidence: 0.85,
  },
  // Gallery detection rules
  {
    name: 'gallery-class',
    targetType: 'gallery',
    classPatterns: [/gallery/i, /portfolio/i, /showcase/i, /work/i, /project/i],
    idPatterns: [/gallery/i, /portfolio/i, /showcase/i, /stories/i, /works/i, /projects/i],
    baseConfidence: 0.85,
  },
  {
    name: 'gallery-content',
    targetType: 'gallery',
    contentConditions: {
      minImages: 4,
    },
    // Higher than feature-content (0.7) to prioritize gallery when 4+ images
    baseConfidence: 0.75,
  },
  // Extended type detection rules
  // Partners/Clients detection
  {
    name: 'partners-class',
    targetType: 'partners',
    classPatterns: [/partners?/i, /clients?/i, /sponsors?/i, /logos?/i, /brands?/i, /trusted/i],
    idPatterns: [/partners?/i, /clients?/i, /sponsors?/i, /logos?/i],
    baseConfidence: 0.85,
  },
  // Team detection
  {
    name: 'team-class',
    targetType: 'team',
    classPatterns: [/team/i, /members?/i, /people/i, /staff/i, /leadership/i, /board/i],
    idPatterns: [/team/i, /board/i, /members?/i, /leadership/i],
    baseConfidence: 0.85,
  },
  // Stories/Case Studies detection
  {
    name: 'stories-class',
    targetType: 'stories',
    classPatterns: [/stories/i, /case-stud/i, /success/i, /use-case/i],
    idPatterns: [/stories/i, /cases?/i],
    baseConfidence: 0.85,
  },
  // Research detection
  {
    name: 'research-class',
    targetType: 'research',
    classPatterns: [/research/i, /study/i, /data/i, /insights?/i, /report/i, /findings?/i],
    idPatterns: [/research/i, /study/i, /insights?/i],
    baseConfidence: 0.85,
  },
  // Subscribe/Newsletter detection
  {
    name: 'subscribe-class',
    targetType: 'subscribe',
    classPatterns: [/subscribe/i, /newsletter/i, /signup/i, /follow/i, /updates?/i, /notify/i],
    idPatterns: [/subscribe/i, /newsletter/i, /follow/i, /updates?/i],
    baseConfidence: 0.85,
  },
  // Stats/Metrics detection
  {
    name: 'stats-class',
    targetType: 'stats',
    classPatterns: [/stats?/i, /metrics?/i, /numbers?/i, /figures?/i, /counter/i, /achievements?/i],
    idPatterns: [/stats?/i, /metrics?/i, /numbers?/i],
    baseConfidence: 0.85,
  },
  // FAQ detection
  {
    name: 'faq-class',
    targetType: 'faq',
    classPatterns: [/faq/i, /questions?/i, /accordion/i, /support/i, /help/i],
    idPatterns: [/faq/i, /questions?/i],
    baseConfidence: 0.85,
  },
];

// =========================================
// Helper Functions
// =========================================

/**
 * 子要素に指定されたクラスパターンがマッチするかチェック
 * Tailwind CSSサイトでは親要素ではなく子要素にグリッドクラス等が設定されることが多いため、
 * 再帰的に子要素をチェックする（深さ3まで）
 *
 * @param $el - 親要素
 * @param $ - Cheerio API
 * @param patterns - チェックするクラスパターンの配列
 * @param maxDepth - 検索する最大の深さ（デフォルト: 3）
 * @returns マッチした場合true
 */
function hasChildMatchingClassPattern(
  $el: CheerioElement,
  $: CheerioAPI,
  patterns: RegExp[],
  maxDepth: number = 3
): boolean {
  if (maxDepth <= 0) return false;

  const children = $el.children();
  for (let i = 0; i < children.length; i++) {
    const $child = $(children[i]) as CheerioElement;
    const childClasses = $child.attr('class') || '';

    // 子要素のクラスをチェック
    for (const pattern of patterns) {
      if (pattern.test(childClasses)) {
        return true;
      }
    }

    // 再帰的に孫要素もチェック
    if (hasChildMatchingClassPattern($child, $, patterns, maxDepth - 1)) {
      return true;
    }
  }

  return false;
}

/**
 * Tailwind CSSのグリッドパターン（子要素チェック用）
 * feature/pricingセクション検出に使用
 */
const TAILWIND_GRID_PATTERNS: RegExp[] = [
  /grid-cols-[2-6]/i,
  /md:grid-cols-[2-6]/i,
  /lg:grid-cols-[2-6]/i,
  /sm:grid-cols-[2-6]/i,
  /xl:grid-cols-[2-6]/i,
  /2xl:grid-cols-[2-6]/i,
  /flex.*gap/i,
  /gap-[0-9]/i,
];

// =========================================
// P2 Enhancement: Tailwind Pattern Dictionary
// =========================================

/**
 * Tailwind CSS Flexboxパターン
 * レイアウト構造の検出に使用
 */
const TAILWIND_FLEX_PATTERNS: RegExp[] = [
  // Basic flex
  /\bflex\b/i,
  /\bflex-row\b/i,
  /\bflex-col\b/i,
  // Alignment
  /\bitems-center\b/i,
  /\bitems-start\b/i,
  /\bitems-end\b/i,
  /\bitems-stretch\b/i,
  /\bitems-baseline\b/i,
  // Justification
  /\bjustify-center\b/i,
  /\bjustify-between\b/i,
  /\bjustify-around\b/i,
  /\bjustify-evenly\b/i,
  /\bjustify-start\b/i,
  /\bjustify-end\b/i,
  // Flex wrap
  /\bflex-wrap\b/i,
  /\bflex-nowrap\b/i,
  // Flex grow/shrink
  /\bflex-1\b/i,
  /\bflex-auto\b/i,
  /\bflex-none\b/i,
  // Responsive prefixes
  /\bsm:flex\b/i,
  /\bmd:flex\b/i,
  /\blg:flex\b/i,
  /\bxl:flex\b/i,
  /\b2xl:flex\b/i,
];

/**
 * Tailwind CSS スペーシングパターン
 * コンテンツ間隔の検出に使用
 */
const TAILWIND_SPACING_PATTERNS: RegExp[] = [
  // Space utilities
  /\bspace-y-[0-9]+\b/i,
  /\bspace-x-[0-9]+\b/i,
  /\bspace-y-px\b/i,
  /\bspace-x-px\b/i,
  // Gap utilities
  /\bgap-[0-9]+\b/i,
  /\bgap-x-[0-9]+\b/i,
  /\bgap-y-[0-9]+\b/i,
  /\bgap-px\b/i,
  // Responsive gap
  /\bsm:gap-[0-9]+\b/i,
  /\bmd:gap-[0-9]+\b/i,
  /\blg:gap-[0-9]+\b/i,
  /\bxl:gap-[0-9]+\b/i,
  /\b2xl:gap-[0-9]+\b/i,
  // Responsive space
  /\bsm:space-[xy]-[0-9]+\b/i,
  /\bmd:space-[xy]-[0-9]+\b/i,
  /\blg:space-[xy]-[0-9]+\b/i,
];

/**
 * Tailwind CSS コンテナパターン
 * セクションの構造検出に使用
 */
const TAILWIND_CONTAINER_PATTERNS: RegExp[] = [
  // Container
  /\bcontainer\b/i,
  // Max width utilities
  /\bmax-w-[0-9]xl\b/i,
  /\bmax-w-screen-[a-z]+\b/i,
  /\bmax-w-full\b/i,
  /\bmax-w-prose\b/i,
  // Centering
  /\bmx-auto\b/i,
  // Padding utilities for container
  /\bpx-[0-9]+\b/i,
  /\bpy-[0-9]+\b/i,
  // Responsive container
  /\bsm:container\b/i,
  /\bmd:container\b/i,
  /\blg:container\b/i,
];

/**
 * Tailwind CSS 背景色パターン
 * CTA/Pricing等のセクション検出に使用
 */
const TAILWIND_BG_PATTERNS: RegExp[] = [
  // Solid colors (common accent colors)
  /\bbg-indigo-[0-9]+\b/i,
  /\bbg-blue-[0-9]+\b/i,
  /\bbg-purple-[0-9]+\b/i,
  /\bbg-green-[0-9]+\b/i,
  /\bbg-red-[0-9]+\b/i,
  /\bbg-orange-[0-9]+\b/i,
  /\bbg-pink-[0-9]+\b/i,
  /\bbg-teal-[0-9]+\b/i,
  // Neutral colors
  /\bbg-gray-[0-9]+\b/i,
  /\bbg-slate-[0-9]+\b/i,
  /\bbg-zinc-[0-9]+\b/i,
  /\bbg-neutral-[0-9]+\b/i,
  /\bbg-stone-[0-9]+\b/i,
  // Special
  /\bbg-white\b/i,
  /\bbg-black\b/i,
  /\bbg-transparent\b/i,
  // Gradient
  /\bbg-gradient-to-[trbl]+\b/i,
  /\bfrom-[a-z]+-[0-9]+\b/i,
  /\bto-[a-z]+-[0-9]+\b/i,
  /\bvia-[a-z]+-[0-9]+\b/i,
];

/**
 * Tailwind CSS テキストスタイルパターン
 * ヘッダー/コンテンツエリアの検出補助
 */
const TAILWIND_TEXT_PATTERNS: RegExp[] = [
  // Font size
  /\btext-[0-9]?xl\b/i,
  /\btext-[2-9]xl\b/i,
  /\btext-lg\b/i,
  /\btext-base\b/i,
  /\btext-sm\b/i,
  /\btext-xs\b/i,
  // Font weight
  /\bfont-bold\b/i,
  /\bfont-semibold\b/i,
  /\bfont-medium\b/i,
  /\bfont-light\b/i,
  /\bfont-extrabold\b/i,
  // Text alignment
  /\btext-center\b/i,
  /\btext-left\b/i,
  /\btext-right\b/i,
  // Text color
  /\btext-white\b/i,
  /\btext-black\b/i,
  /\btext-gray-[0-9]+\b/i,
];

/**
 * Tailwind CSS ナビゲーションパターン
 * ナビゲーション/ヘッダー検出に使用
 */
const TAILWIND_NAV_PATTERNS: RegExp[] = [
  // Fixed/Sticky positioning
  /\bfixed\b/i,
  /\bsticky\b/i,
  /\btop-0\b/i,
  /\bleft-0\b/i,
  /\bright-0\b/i,
  // Z-index (common for nav)
  /\bz-[0-9]+\b/i,
  /\bz-50\b/i,
  // Shadow (common for sticky nav)
  /\bshadow-sm\b/i,
  /\bshadow\b/i,
  /\bshadow-md\b/i,
  // Backdrop
  /\bbackdrop-blur\b/i,
  /\bbg-opacity-[0-9]+\b/i,
];

/**
 * Tailwind CSS ヒーローセクションパターン
 * ヒーロー検出の信頼度向上に使用
 */
const TAILWIND_HERO_PATTERNS: RegExp[] = [
  // Large vertical padding (hero sections typically have)
  /\bpt-[12][0-9]\b/i, // pt-10 ~ pt-29
  /\bpb-[12][0-9]\b/i, // pb-10 ~ pb-29
  /\bpy-[12][0-9]\b/i, // py-10 ~ py-29
  // Min height
  /\bmin-h-screen\b/i,
  /\bmin-h-\[.+\]\b/i,
  /\bh-screen\b/i,
  // Hero gradient backgrounds
  /\bbg-gradient-to-[trblxy]+\b/i,
  // Responsive padding
  /\bsm:pt-[0-9]+\b/i,
  /\bmd:pt-[0-9]+\b/i,
  /\blg:pt-[0-9]+\b/i,
];

/**
 * 統合パターン辞書 - セクションタイプごとの関連パターン
 * 検出信頼度の計算に使用
 */
const TAILWIND_SECTION_PATTERNS: Record<string, RegExp[]> = {
  navigation: TAILWIND_NAV_PATTERNS,
  hero: [...TAILWIND_HERO_PATTERNS, ...TAILWIND_TEXT_PATTERNS.slice(0, 6)], // Large text patterns
  feature: [...TAILWIND_GRID_PATTERNS, ...TAILWIND_FLEX_PATTERNS],
  cta: [...TAILWIND_BG_PATTERNS, ...TAILWIND_TEXT_PATTERNS.slice(0, 3)], // Bold text + bg colors
  pricing: [...TAILWIND_GRID_PATTERNS, ...TAILWIND_FLEX_PATTERNS],
  testimonial: [...TAILWIND_FLEX_PATTERNS, ...TAILWIND_SPACING_PATTERNS],
  footer: [...TAILWIND_BG_PATTERNS, ...TAILWIND_FLEX_PATTERNS, ...TAILWIND_TEXT_PATTERNS.slice(10, 14)], // Text color patterns
};

/**
 * 要素のCSSセレクタを生成
 */
function generateSelector(
  _$el: CheerioElement,
  tagName: string,
  id?: string,
  classes: string[] = []
): string {
  if (id) {
    return `${tagName}#${id}`;
  }
  if (classes.length > 0) {
    return `${tagName}.${classes[0]}`;
  }
  return tagName;
}

/**
 * 要素のHTMLスニペットを抽出
 * サイズ制限を超える場合は切り詰める
 *
 * @param $el - Cheerio要素
 * @param $ - Cheerio API
 * @returns サニタイズ済みHTMLスニペット（最大50KB）
 */
function extractHtmlSnippet(
  $el: CheerioElement,
  $: CheerioAPI
): string | undefined {
  try {
    // 要素のouterHTMLを取得
    let html = $.html($el);

    if (!html || html.trim().length === 0) {
      return undefined;
    }

    // サイズチェック（UTF-8バイト数で計算）
    const byteLength = Buffer.byteLength(html, 'utf8');

    if (byteLength <= HTML_SNIPPET_MAX_SIZE) {
      return html;
    }

    // サイズ超過の場合、script/style/svg/noscriptを除去して再試行
    const $clone = $el.clone();
    $clone.find('script, style, svg, noscript, iframe').remove();
    html = $.html($clone);

    const reducedByteLength = Buffer.byteLength(html, 'utf8');
    if (reducedByteLength <= HTML_SNIPPET_MAX_SIZE) {
      return html;
    }

    // それでもサイズを超える場合は、HTMLを切り詰める
    // バイト数ではなく文字数で切り詰め（マルチバイト文字対応）
    // おおよそ1文字 = 3バイトと仮定して安全マージンを取る
    const maxChars = Math.floor(HTML_SNIPPET_MAX_SIZE / 3);
    if (html.length > maxChars) {
      html = html.substring(0, maxChars) + '<!-- truncated -->';
    }

    return html;
  } catch {
    // エラーが発生した場合はundefinedを返す
    return undefined;
  }
}

/**
 * インラインスタイルからスタイル情報を抽出
 */
function extractStyles(styleAttr: string | undefined): SectionStyle {
  const style: SectionStyle = {};

  if (!styleAttr) {
    return style;
  }

  // Background color extraction
  const bgColorMatch = styleAttr.match(/background-color:\s*([^;]+)/i);
  if (bgColorMatch && bgColorMatch[1]) {
    style.backgroundColor = bgColorMatch[1].trim();
  }

  // Text color extraction
  const colorMatch = styleAttr.match(/(?:^|;)\s*color:\s*([^;]+)/i);
  if (colorMatch && colorMatch[1]) {
    style.textColor = colorMatch[1].trim();
  }

  // Gradient detection
  if (styleAttr.match(/gradient/i)) {
    style.hasGradient = true;
  }

  // Background image detection
  if (styleAttr.match(/background-image:\s*url/i) || styleAttr.match(/background:\s*[^;]*url/i)) {
    style.hasImage = true;
  }

  return style;
}

/**
 * ボタンタイプを分類
 */
function classifyButtonType(
  $el: CheerioElement,
  _$: CheerioAPI
): ButtonType {
  const classList = ($el.attr('class') || '').toLowerCase();
  const tagName = $el.prop('tagName')?.toLowerCase() || '';

  if (classList.includes('primary') || classList.includes('btn-primary')) {
    return 'primary';
  }
  if (classList.includes('secondary') || classList.includes('btn-secondary')) {
    return 'secondary';
  }
  if (classList.includes('link') || classList.includes('btn-link') || tagName === 'a') {
    // Only classify as link if it's an anchor tag with button-like class
    if (tagName === 'a' && classList.includes('btn')) {
      return 'link';
    }
  }

  // Default to primary if it has prominent styling
  if (classList.includes('large') || classList.includes('main') || classList.includes('cta')) {
    return 'primary';
  }

  return 'primary';
}

/**
 * コンテンツ抽出
 */
function extractContent(
  $el: CheerioElement,
  $: CheerioAPI
): SectionContent {
  const headings: SectionContent['headings'] = [];
  const paragraphs: string[] = [];
  const links: SectionContent['links'] = [];
  const images: SectionContent['images'] = [];
  const buttons: SectionContent['buttons'] = [];

  // Extract headings
  $el.find('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const $heading = $(el);
    const tagName = $heading.prop('tagName')?.toLowerCase() || '';
    const level = parseInt(tagName.charAt(1), 10);
    const text = $heading.text().trim();
    if (text) {
      headings.push({ level, text });
    }
  });

  // Extract paragraphs
  $el.find('p').each((_, el) => {
    const text = $(el).text().trim();
    if (text) {
      paragraphs.push(text);
    }
  });

  // Extract links (P1-1: ボタン風リンクも links に追加してCTA検出を強化)
  $el.find('a').each((_, el) => {
    const $link = $(el);
    const href = $link.attr('href') || '';
    const text = $link.text().trim();
    const classList = ($link.attr('class') || '').toLowerCase();

    // Always add to links array (P1-1: CTAのアクションリンク検出用)
    if (text || href) {
      links.push({ text, href });
    }

    // Additionally add to buttons if it's a button-style link
    if (classList.includes('btn') || classList.includes('button')) {
      buttons.push({
        text,
        type: classifyButtonType($link, $),
      });
    }
  });

  // Extract images
  $el.find('img').each((_, el) => {
    const $img = $(el);
    const src = $img.attr('src') || '';
    const alt = $img.attr('alt');
    if (src) {
      images.push({ src, alt: alt || undefined });
    }
  });

  // Extract buttons (button elements and input[type="submit"])
  $el.find('button, input[type="submit"]').each((_, el) => {
    const $btn = $(el);
    let text = $btn.text().trim();
    if (!text) {
      text = $btn.attr('value') || '';
    }
    if (text) {
      buttons.push({
        text,
        type: classifyButtonType($btn, $),
      });
    }
  });

  return { headings, paragraphs, links, images, buttons };
}

/**
 * セクションタイプを推定
 */
function classifySectionType(
  $el: CheerioElement,
  _$: CheerioAPI,
  content: SectionContent,
  position: PositionInfo,
  options: Required<SectionDetectorOptions>
): { type: SectionType; confidence: number } {
  const tagName = ($el.prop('tagName') || '').toLowerCase();
  const id = $el.attr('id') || '';
  const classList = $el.attr('class') || '';
  const role = $el.attr('role') || '';

  let bestType: SectionType = 'unknown';
  let bestConfidence = 0;

  // Special case: role="banner" + hero class patterns → hero (not navigation)
  // WAI-ARIA banner role is often used with hero sections in modern web design
  const heroClassPatterns = [/hero/i, /banner/i, /jumbotron/i, /masthead/i];
  const hasHeroClass = heroClassPatterns.some((p) => p.test(classList));
  const hasHeroId = /hero/i.test(id);

  if (role === 'banner' && (hasHeroClass || hasHeroId)) {
    // Hero class + banner role = hero section with high confidence
    bestType = 'hero';
    bestConfidence = 0.92;
  } else if (options.detectLandmarks && role) {
    // Check ARIA landmarks (standard behavior)
    const mapping = SECTION_TYPE_MAPPINGS[role];
    if (mapping && mapping.confidence > bestConfidence) {
      bestType = mapping.sectionType;
      bestConfidence = mapping.confidence;
    }
  }

  // Check semantic tags
  if (options.detectSemanticTags) {
    const mapping = SECTION_TYPE_MAPPINGS[tagName];
    if (mapping && mapping.confidence > bestConfidence) {
      bestType = mapping.sectionType;
      bestConfidence = mapping.confidence;
    }
  }

  // Apply classification rules
  for (const rule of CLASSIFICATION_RULES) {
    let ruleMatches = false;
    let ruleConfidence = rule.baseConfidence;
    let matchCount = 0; // 複数指標マッチ時のブースト用

    // Check tag names
    if (rule.tagNames && rule.tagNames.includes(tagName)) {
      ruleMatches = true;
      matchCount++;
    }

    // Check ARIA roles
    if (rule.ariaRoles && rule.ariaRoles.includes(role)) {
      ruleMatches = true;
      matchCount++;
    }

    // Check class patterns
    if (rule.classPatterns) {
      for (const pattern of rule.classPatterns) {
        if (pattern.test(classList)) {
          ruleMatches = true;
          matchCount++;
          break;
        }
      }
    }

    // Check ID patterns
    if (rule.idPatterns) {
      for (const pattern of rule.idPatterns) {
        if (pattern.test(id)) {
          ruleMatches = true;
          matchCount++;
          break;
        }
      }
    }

    // 複数の指標がマッチした場合、信頼度をブースト（最大0.97）
    if (matchCount >= 2) {
      ruleConfidence = Math.min(0.97, ruleConfidence + 0.05 * (matchCount - 1));
    }

    // Check content conditions
    if (rule.contentConditions) {
      const cc = rule.contentConditions;
      let contentMatches = true;

      if (cc.requiresH1) {
        const hasH1 = content.headings.some((h) => h.level === 1);
        if (!hasH1) contentMatches = false;
      }

      if (cc.requiresButton) {
        if (content.buttons.length === 0) contentMatches = false;
      }

      if (cc.requiresImage) {
        if (content.images.length === 0) contentMatches = false;
      }

      if (cc.minHeadings !== undefined) {
        if (content.headings.length < cc.minHeadings) contentMatches = false;
      }

      if (cc.minImages !== undefined) {
        if (content.images.length < cc.minImages) contentMatches = false;
      }

      if (cc.minLinks !== undefined) {
        if (content.links.length < cc.minLinks) contentMatches = false;
      }

      if (contentMatches) {
        ruleMatches = true;
      }
    }

    // Check position conditions
    if (rule.positionConditions) {
      const pc = rule.positionConditions;
      let positionMatches = true;

      if (pc.isNearTop && position.startY > 100) {
        positionMatches = false;
      }

      if (pc.isNearBottom) {
        // This would need total page height, handle as best effort
        positionMatches = true;
      }

      if (positionMatches && ruleMatches) {
        ruleConfidence += 0.1;
      }
    }

    // Update best match
    if (ruleMatches && ruleConfidence > bestConfidence) {
      bestType = rule.targetType;
      bestConfidence = Math.min(ruleConfidence, 1);
    }
  }

  // Special case: Copyright text indicates footer (override other detections)
  const fullText = $el.text().toLowerCase();
  if (
    fullText.includes('copyright') || fullText.includes('©') || fullText.includes('all rights reserved')
  ) {
    // Copyright text is a strong indicator of footer, override other types
    if (bestType === 'unknown' || bestConfidence < 0.8) {
      bestType = 'footer';
      bestConfidence = Math.max(bestConfidence, 0.75);
    }
  }

  // Special case: Form elements indicate contact
  if ($el.find('form').length > 0 && bestType === 'unknown') {
    const contactIndicators =
      $el.find('input[type="email"], textarea, input[name*="email"], input[name*="message"]').length;
    if (contactIndicators > 0) {
      bestType = 'contact';
      bestConfidence = Math.max(bestConfidence, 0.75);
    }
  }

  // Special case: Blockquote indicates testimonial
  if ($el.find('blockquote').length > 0 && bestType === 'unknown') {
    bestType = 'testimonial';
    bestConfidence = Math.max(bestConfidence, 0.7);
  }

  // =========================================
  // Tailwind CSS Support: Content-based pricing detection
  // =========================================
  // Check for pricing indicators BEFORE grid detection to prioritize price content
  // This is important because pricing sections often have multiple price cards
  const sectionText = $el.text();

  // Comprehensive price pattern detection (supports $, ¥, 円, /月, /mo, etc.)
  const pricePatterns = [
    /\$[\d,]+/,              // $99, $1,000
    /¥[\d,]+/,               // ¥9,800
    /￥[\d,]+/,              // ￥9,800 (fullwidth)
    /[\d,]+円/,              // 9,800円
    /\/月/,                  // /月 (Japanese monthly)
    /\/mo(nth)?/i,           // /mo, /month
    /\/年/,                  // /年 (Japanese yearly)
    /\/year/i,               // /year
    /per\s*(月|month|年|year)/i, // per month, per 月
    /月額/,                  // 月額 (monthly fee)
    /年額/,                  // 年額 (yearly fee)
  ];

  const hasPriceContent = pricePatterns.some(p => p.test(sectionText));
  const priceMatchCount = pricePatterns.reduce((count, p) => {
    const matches = sectionText.match(new RegExp(p.source, 'gi'));
    return count + (matches ? matches.length : 0);
  }, 0);

  // Pricing detection: Multiple price mentions + grid structure = pricing section
  if (hasPriceContent && priceMatchCount >= 2) {
    const hasChildGrid = hasChildMatchingClassPattern($el, _$, TAILWIND_GRID_PATTERNS, 3);
    const hasPricingClass = /pricing|price|plan|料金/i.test(classList + ' ' + id);

    if (hasChildGrid || hasPricingClass) {
      // Strong pricing indicators: price content + grid layout
      if (bestConfidence < 0.78) {
        bestType = 'pricing';
        bestConfidence = 0.78;
      }
    } else if (priceMatchCount >= 3) {
      // Multiple price mentions without grid = likely pricing
      if (bestConfidence < 0.72) {
        bestType = 'pricing';
        bestConfidence = 0.72;
      }
    }
  }

  // =========================================
  // Tailwind CSS Support: Child element grid pattern detection for feature
  // =========================================
  // When parent element doesn't have explicit section class names (Tailwind utility-first),
  // check child elements for grid patterns to detect feature sections
  if ((bestType === 'unknown' || bestConfidence < 0.65) && bestType !== 'pricing') {
    const hasChildGrid = hasChildMatchingClassPattern($el, _$, TAILWIND_GRID_PATTERNS, 3);

    if (hasChildGrid) {
      // Check for feature section indicators
      // Feature sections typically have multiple cards with heading + paragraph
      const childHeadings = $el.find('h2, h3, h4').length;
      const childParagraphs = $el.find('p').length;
      const hasFeaturePattern =
        /feature/i.test(classList) ||
        /feature/i.test(id) ||
        /service/i.test(classList) ||
        /benefit/i.test(classList);

      // 3+ heading+paragraph combinations suggest a feature section
      if (childHeadings >= 3 && childParagraphs >= 3) {
        if (bestConfidence < 0.7) {
          bestType = 'feature';
          bestConfidence = 0.7;
        }
      } else if (hasFeaturePattern && childHeadings >= 2) {
        if (bestConfidence < 0.7) {
          bestType = 'feature';
          bestConfidence = 0.7;
        }
      }
    }
  }

  // =========================================
  // Content-based detection fallback
  // =========================================
  // Additional content-based detection when type is still unknown
  if (bestType === 'unknown' || bestConfidence < 0.5) {
    // Feature detection based on repeating content structure
    const h3Count = $el.find('h3').length;
    const h4Count = $el.find('h4').length;
    const pCount = $el.find('p').length;

    // Lowered threshold: 2+ h3/h4 with corresponding paragraphs = likely feature cards
    if ((h3Count >= 2 || h4Count >= 2) && pCount >= 2 && bestType === 'unknown') {
      bestType = 'feature';
      bestConfidence = Math.max(bestConfidence, 0.6);
    }
  }

  // =========================================
  // Heading text analysis fallback
  // =========================================
  // When type is still unknown, analyze heading text for section type hints
  if (bestType === 'unknown' || bestConfidence < 0.55) {
    const headingTexts = content.headings.map((h) => h.text.toLowerCase());
    const allHeadingText = headingTexts.join(' ');

    // Map heading text keywords to section types
    const HEADING_TYPE_MAP: Array<{ patterns: RegExp; type: SectionType; confidence: number }> = [
      { patterns: /\b(features?|capabilities|what we offer|our solutions?|services?|why choose|our tools?)\b/i, type: 'feature', confidence: 0.72 },
      { patterns: /\b(about|who we are|our story|our mission|our vision|company|背景|会社概要)\b/i, type: 'about', confidence: 0.72 },
      { patterns: /\b(pricing|plans?|packages?|subscription|料金|プラン)\b/i, type: 'pricing', confidence: 0.72 },
      { patterns: /\b(testimonials?|reviews?|what.*say|customer stories|お客様の声)\b/i, type: 'testimonial', confidence: 0.70 },
      { patterns: /\b(contact|get in touch|reach out|talk to us|お問い合わせ|連絡)\b/i, type: 'contact', confidence: 0.72 },
      { patterns: /\b(faq|frequently asked|questions?|よくある質問)\b/i, type: 'faq', confidence: 0.75 },
      { patterns: /\b(team|our people|leadership|meet the|チーム|メンバー)\b/i, type: 'team', confidence: 0.70 },
      { patterns: /\b(partners?|clients?|trusted by|brands?|パートナー)\b/i, type: 'partners', confidence: 0.70 },
      { patterns: /\b(gallery|portfolio|our work|showcase|projects?|作品|実績)\b/i, type: 'gallery', confidence: 0.70 },
      { patterns: /\b(case stud|success stories|stories|use cases?|事例)\b/i, type: 'stories', confidence: 0.70 },
      { patterns: /\b(stats?|metrics?|by the numbers|achievements?|数字で見る|実績)\b/i, type: 'stats', confidence: 0.70 },
      { patterns: /\b(subscribe|newsletter|stay updated|updates?|通知|ニュースレター)\b/i, type: 'subscribe', confidence: 0.70 },
      { patterns: /\b(get started|try|sign up|start|join|begin|start free|始める|無料で始める)\b/i, type: 'cta', confidence: 0.65 },
      { patterns: /\b(how it works|how to|steps?|process|workflow|使い方|仕組み)\b/i, type: 'feature', confidence: 0.65 },
    ];

    for (const mapping of HEADING_TYPE_MAP) {
      if (mapping.patterns.test(allHeadingText) && mapping.confidence > bestConfidence) {
        bestType = mapping.type;
        bestConfidence = mapping.confidence;
        break;
      }
    }
  }

  // =========================================
  // Semantic keyword extraction from class/id names
  // =========================================
  // Parse hyphenated class names for semantic hints (e.g., "about-section", "team-grid")
  if (bestType === 'unknown' || bestConfidence < 0.6) {
    const allClassesAndId = (classList + ' ' + id).toLowerCase();
    // Tokenize: split by spaces, hyphens, underscores, dots
    const tokens = allClassesAndId.split(/[\s\-_./]+/).filter((t) => t.length > 2);

    const SEMANTIC_TOKEN_MAP: Array<{ tokens: RegExp; type: SectionType; confidence: number }> = [
      { tokens: /^(hero|banner|masthead|jumbotron)$/i, type: 'hero', confidence: 0.70 },
      { tokens: /^(features?|benefits?|services?|capabilities|solutions?)$/i, type: 'feature', confidence: 0.68 },
      { tokens: /^(cta|calltoaction|action|signup)$/i, type: 'cta', confidence: 0.68 },
      { tokens: /^(testimonials?|reviews?|quotes?)$/i, type: 'testimonial', confidence: 0.68 },
      { tokens: /^(pricing|prices?|plans?|packages?)$/i, type: 'pricing', confidence: 0.68 },
      { tokens: /^(footer|colophon)$/i, type: 'footer', confidence: 0.68 },
      { tokens: /^(about|company|mission|vision|story)$/i, type: 'about', confidence: 0.68 },
      { tokens: /^(contact|inquiry|reach)$/i, type: 'contact', confidence: 0.68 },
      { tokens: /^(gallery|portfolio|showcase|works?)$/i, type: 'gallery', confidence: 0.68 },
      { tokens: /^(partners?|clients?|sponsors?|logos?)$/i, type: 'partners', confidence: 0.68 },
      { tokens: /^(team|members?|people|staff|leadership)$/i, type: 'team', confidence: 0.68 },
      { tokens: /^(stories|cases?|studies)$/i, type: 'stories', confidence: 0.68 },
      { tokens: /^(stats?|metrics?|numbers?|counter|achievements?)$/i, type: 'stats', confidence: 0.68 },
      { tokens: /^(subscribe|newsletter|follow|updates?)$/i, type: 'subscribe', confidence: 0.68 },
      { tokens: /^(faq|questions?|accordion|help)$/i, type: 'faq', confidence: 0.68 },
      { tokens: /^(nav|navigation|menu|navbar|header)$/i, type: 'navigation', confidence: 0.65 },
    ];

    for (const token of tokens) {
      for (const mapping of SEMANTIC_TOKEN_MAP) {
        if (mapping.tokens.test(token) && mapping.confidence > bestConfidence) {
          bestType = mapping.type;
          bestConfidence = mapping.confidence;
          break;
        }
      }
      if (bestType !== 'unknown') break;
    }
  }

  // =========================================
  // List/link density heuristic
  // =========================================
  // Sections with many links but no other strong indicators → navigation or footer
  if (bestType === 'unknown' && bestConfidence < 0.5) {
    const linkCount = content.links.length;
    const ulOlCount = $el.find('ul, ol').length;

    // Many links in list structure → likely navigation or footer
    if (linkCount >= 5 && ulOlCount >= 1) {
      bestType = 'navigation';
      bestConfidence = 0.55;
    }
  }

  // =========================================
  // P2 Enhancement: Tailwind Pattern Dictionary Confidence Boost
  // =========================================
  // When a section type is already detected, check for additional Tailwind patterns
  // to boost confidence if patterns match the detected type
  if (bestType !== 'unknown' && bestConfidence < 0.9) {
    const sectionPatterns = TAILWIND_SECTION_PATTERNS[bestType];
    if (sectionPatterns) {
      let patternMatchCount = 0;

      // Check element's own classes
      for (const pattern of sectionPatterns) {
        if (pattern.test(classList)) {
          patternMatchCount++;
        }
      }

      // Check child elements for patterns (max depth 2)
      if (hasChildMatchingClassPattern($el, _$, sectionPatterns, 2)) {
        patternMatchCount += 2; // Child matches count more
      }

      // Boost confidence based on Tailwind pattern matches
      if (patternMatchCount >= 3) {
        bestConfidence = Math.min(0.95, bestConfidence + 0.08);
      } else if (patternMatchCount >= 2) {
        bestConfidence = Math.min(0.92, bestConfidence + 0.05);
      } else if (patternMatchCount >= 1) {
        bestConfidence = Math.min(0.88, bestConfidence + 0.03);
      }
    }
  }

  // =========================================
  // P2 Enhancement: Flex/Spacing Pattern Detection for Unknown Sections
  // =========================================
  // When section type is still unknown, use Tailwind flex/spacing patterns
  // to detect feature-like layouts
  if (bestType === 'unknown' && bestConfidence < 0.6) {
    const hasFlexLayout = hasChildMatchingClassPattern($el, _$, TAILWIND_FLEX_PATTERNS, 3);
    const hasSpacingPattern = hasChildMatchingClassPattern($el, _$, TAILWIND_SPACING_PATTERNS, 3);
    const hasContainerPattern = TAILWIND_CONTAINER_PATTERNS.some(p => p.test(classList));

    if (hasFlexLayout && hasSpacingPattern) {
      // Flex + spacing patterns suggest a structured content section
      const h3Count = $el.find('h3').length;
      const h4Count = $el.find('h4').length;

      if (h3Count >= 2 || h4Count >= 2) {
        bestType = 'feature';
        bestConfidence = 0.65;
      }
    }

    // Container with specific background colors may indicate CTA
    if (hasContainerPattern) {
      const hasCTABackground = TAILWIND_BG_PATTERNS.slice(0, 8).some(p => p.test(classList));
      const hasButton = content.buttons.length > 0;

      if (hasCTABackground && hasButton) {
        bestType = 'cta';
        bestConfidence = 0.68;
      }
    }
  }

  return { type: bestType, confidence: bestConfidence };
}

// =========================================
// SectionDetector Class
// =========================================

/**
 * SectionDetector クラス
 *
 * HTMLからセクションを検出し、タイプを分類する
 *
 * @security 入力HTMLは事前にサニタイズ済みであることを前提とする。
 *           layout.ingest または page.analyze 経由で使用すること。
 *           直接使用する場合は sanitizeHtml() でサニタイズすること。
 */
export class SectionDetector {
  private options: Required<SectionDetectorOptions>;

  constructor(options: Partial<SectionDetectorOptions> = {}) {
    this.options = {
      // Phase 2: minSectionHeight を 100px → 50px に緩和
      minSectionHeight: options.minSectionHeight ?? 50,
      detectLandmarks: options.detectLandmarks ?? true,
      detectSemanticTags: options.detectSemanticTags ?? true,
      detectVisualSections: options.detectVisualSections ?? true,
      // Phase 4: ネスト除外オプション（デフォルトtrue）
      removeNestedSections: options.removeNestedSections ?? true,
      // Phase 4: 同一タイプの最大セクション数（デフォルトundefined=無制限）
      maxSectionsPerType: options.maxSectionsPerType,
      // Phase 4: hero/footer単一検出強制（デフォルトtrue）
      enforceSingleHeroFooter: options.enforceSingleHeroFooter ?? true,
      // Phase 4: heroセクション検出の上限位置（デフォルト20%）
      heroTopThreshold: options.heroTopThreshold ?? 20,
      // Phase 4: footerセクション検出の下限位置（デフォルト80%）
      footerBottomThreshold: options.footerBottomThreshold ?? 80,
    };
  }

  /**
   * 透過的コンテナ要素（子要素を除去しない親タグ）
   * これらのタグは構造的コンテナであり、意味のあるセクションではないため、
   * 子セクションの除去基準として使用しない
   */
  private static readonly TRANSPARENT_CONTAINER_TAGS = new Set([
    'main',     // メインコンテンツコンテナ
    'article',  // 記事コンテナ（内部にセクションを持つ）
    'div',      // 汎用コンテナ（クラス名で判断）
  ]);

  /**
   * 要素が透過的コンテナ（子要素を除去しない親）かどうかを判定
   *
   * @param $el - 判定する要素
   * @returns 透過的コンテナの場合true
   */
  private isTransparentContainer($el: CheerioAnyElement): boolean {
    const tagName = ($el.prop('tagName') || '').toLowerCase();

    // 透過的コンテナタグの場合
    if (SectionDetector.TRANSPARENT_CONTAINER_TAGS.has(tagName)) {
      // div の場合はクラス名で判断
      if (tagName === 'div') {
        const classes = ($el.attr('class') || '').toLowerCase();
        // 意味のあるセクションクラスを持つ場合は透過的ではない
        const sectionKeywords = [
          'hero',
          'feature',
          'cta',
          'testimonial',
          'pricing',
          'about',
          'contact',
          'gallery',
          'banner',
          'review',
          'portfolio',
        ];
        for (const keyword of sectionKeywords) {
          if (classes.includes(keyword)) {
            return false; // 意味のあるセクション
          }
        }
        // 汎用的なdivは透過的コンテナ
        return true;
      }
      // main, article は常に透過的コンテナ
      return true;
    }

    return false;
  }

  /**
   * ネストされた子要素を除外し、トップレベル要素のみを返す
   *
   * 透過的コンテナ（main, article, 汎用div）内の要素はネストとみなさず保持する。
   * これにより、<main>内の<section class="hero">などが正しく検出される。
   *
   * @param elements - 検出された全要素
   * @param $ - CheerioAPI
   * @returns トップレベル要素のみ
   */
  private removeNestedElements(
    elements: CheerioAnyElement[],
    $: CheerioAPI
  ): CheerioAnyElement[] {
    const result: CheerioAnyElement[] = [];
    const domElements = elements.map(($el) => $el.get(0));

    for (let i = 0; i < elements.length; i++) {
      const current = domElements[i];
      const currentElement = elements[i];
      if (!current || !currentElement) continue;

      let isNested = false;

      for (let j = 0; j < elements.length; j++) {
        if (i === j) continue;
        const other = domElements[j];
        const otherElement = elements[j];
        if (!other || !otherElement) continue;

        // other が current の祖先かチェック（other に current が含まれている場合、current はネスト）
        if ($.contains(other, current)) {
          // 親要素が透過的コンテナの場合はネストとみなさない
          if (this.isTransparentContainer(otherElement)) {
            continue; // 透過的コンテナはスキップ
          }
          isNested = true;
          break;
        }
      }

      if (!isNested) {
        result.push(currentElement);
      }
    }

    return result;
  }

  /**
   * HTMLからセクションを検出
   */
  async detect(html: string): Promise<DetectedSection[]> {
    const $ = cheerio.load(html);
    const sections: DetectedSection[] = [];
    let positionY = 0;

    // Collect all potential section elements
    const sectionElements: CheerioAnyElement[] = [];

    // 1. WAI-ARIA landmarks
    if (this.options.detectLandmarks) {
      for (const role of ARIA_LANDMARK_ROLES) {
        $(`[role="${role}"]`).each((_, el) => {
          sectionElements.push($(el));
        });
      }
    }

    // 2. HTML5 semantic tags
    if (this.options.detectSemanticTags) {
      for (const tag of SEMANTIC_TAGS) {
        $(tag).each((_, el) => {
          sectionElements.push($(el));
        });
      }
    }

    // 3. Section-like class patterns (visual sections)
    // Phase 2: セレクタパターンを拡張（+10パターン）
    if (this.options.detectVisualSections) {
      const sectionPatterns = [
        // 既存パターン
        '[class*="section"]',
        '[class*="hero"]',
        '[class*="feature"]',
        '[class*="cta"]',
        '[class*="call-to-action"]',
        '[class*="testimonial"]',
        '[class*="pricing"]',
        '[class*="about"]',
        '[class*="contact"]',
        '[class*="gallery"]',
        '[class*="footer"]',
        '[class*="bottom"]',
        '[class*="banner"]',
        '[class*="nav"]',
        '[class*="review"]',
        '[class*="portfolio"]',
        '[id*="hero"]',
        '[id*="feature"]',
        '[id*="pricing"]',
        '[id*="contact"]',
        '[id*="about"]',
        '[id*="gallery"]',
        // Phase 2追加: 汎用コンテナパターン
        '[class*="block"]',
        '[class*="container"]',
        '[class*="wrapper"]',
        '[class*="component"]',
        '[class*="module"]',
        // Phase 2追加: data-*属性パターン
        '[data-section]',
        '[data-component]',
        '[data-block]',
        // Phase 2追加: BEMパターン（xxx-section, xxx_section）
        'div[class*="-section"]',
        'div[class*="_section"]',
      ];

      for (const pattern of sectionPatterns) {
        $(pattern).each((_, el) => {
          sectionElements.push($(el));
        });
      }
    }

    // De-duplicate based on actual DOM elements
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seen = new Set<any>();
    let uniqueElements: CheerioAnyElement[] = [];

    for (const $el of sectionElements) {
      const el = $el.get(0);
      if (el && !seen.has(el)) {
        seen.add(el);
        uniqueElements.push($el);
      }
    }

    // DigitalSilk / dst-* blocks heuristic:
    // If the page contains multiple dst-wrapper/banner blocks, prefer them as section candidates
    const dstCandidates = uniqueElements.filter(($el) => {
      const classes = ($el.attr('class') || '').toLowerCase();
      return (
        classes.includes('dst-wrapper') ||
        classes.includes('dst-banner') ||
        classes.includes('ds-blocks-dst-wrapper')
      );
    });

    if (dstCandidates.length >= 2) {
      const structural = uniqueElements.filter(($el) => {
        const tagName = ($el.prop('tagName') || '').toLowerCase();
        return tagName === 'header' || tagName === 'nav' || tagName === 'footer';
      });

      // Merge and de-duplicate by element reference
      const dstSeen = new Set<DomElement>();
      const merged: CheerioAnyElement[] = [];
      for (const $el of [...dstCandidates, ...structural]) {
        const el = $el.get(0);
        if (el && !dstSeen.has(el)) {
          dstSeen.add(el);
          merged.push($el);
        }
      }
      uniqueElements = merged;
    }

    // Phase 4: ネストされた子要素を除外し、トップレベル要素のみを保持
    const topLevelElements =
      this.options.removeNestedSections !== false
        ? this.removeNestedElements(uniqueElements, $)
        : uniqueElements;

    // Sort by document order (approximate using index)
    topLevelElements.sort((a, b) => {
      const indexA = $('*').index(a);
      const indexB = $('*').index(b);
      return indexA - indexB;
    });

    // Process each section element
    for (const $el of topLevelElements) {
      const tagName = ($el.prop('tagName') || '').toLowerCase();
      const id = $el.attr('id') || undefined;
      const classList = ($el.attr('class') || '').split(/\s+/).filter(Boolean);
      const styleAttr = $el.attr('style');

      // Extract content
      const content = extractContent($el, $);

      // Calculate position (simulated - actual would need browser)
      const estimatedHeight = Math.max(
        50,
        content.headings.length * 40 +
          content.paragraphs.length * 60 +
          content.images.length * 200 +
          content.buttons.length * 40
      );

      const position: PositionInfo = {
        startY: positionY,
        endY: positionY + estimatedHeight,
        height: estimatedHeight,
      };

      positionY += estimatedHeight;

      // Extract styles
      const style = extractStyles(styleAttr);

      // Classify section
      const { type, confidence } = classifySectionType($el, $, content, position, this.options);

      // Phase 2: フィルター条件を緩和
      // ビジュアル要素（画像、背景色、ボタン、リンク）がある場合は保存
      const hasVisualContent =
        content.images.length > 0 ||
        content.buttons.length > 0 ||
        content.links.length > 0 ||
        content.paragraphs.length > 0 ||
        style.backgroundColor !== undefined ||
        style.hasGradient ||
        style.hasImage;

      // Skip only elements that are truly empty/generic
      // unknown + 低信頼度 + 見出しなし + ビジュアル要素なし の場合のみスキップ
      if (type === 'unknown' && confidence < 0.2 && content.headings.length === 0 && !hasVisualContent) {
        continue;
      }

      // Create element info
      const element: ElementInfo = {
        tagName,
        selector: generateSelector($el, tagName, id, classList),
        classes: classList,
        id,
      };

      // Extract HTML snippet
      const htmlSnippet = extractHtmlSnippet($el, $);

      // Create detected section
      const section: DetectedSection = {
        id: uuidv4(),
        type,
        confidence,
        element,
        position,
        content,
        style,
      };

      // htmlSnippetが存在する場合のみ追加（exactOptionalPropertyTypes対応）
      if (htmlSnippet !== undefined) {
        section.htmlSnippet = htmlSnippet;
      }

      sections.push(section);
    }

    // Phase 4: 全セクションのestimatedTopを計算（ページ内相対位置 0-100%）
    const totalHeight = positionY > 0 ? positionY : 1; // ゼロ除算防止
    for (const section of sections) {
      section.position.estimatedTop = Math.min(100, (section.position.startY / totalHeight) * 100);
    }

    // Phase 4: hero/footer単一検出強制
    let result = sections;
    if (this.options.enforceSingleHeroFooter) {
      result = this.enforceSingleHeroFooterRule(result);
    }

    // Phase 4: maxSectionsPerType フィルタリング
    if (this.options.maxSectionsPerType !== undefined) {
      return this.applyMaxSectionsPerType(result, this.options.maxSectionsPerType);
    }

    return result;
  }

  /**
   * hero/footerのDOM順序考慮による単一検出を強制
   *
   * - hero: DOM最上部20%内の最高信頼度セクションのみ採用（1ページ最大1つ）
   * - footer: DOM最下部20%内の最高信頼度セクションのみ採用（1ページ最大1つ）
   * - 位置条件外のhero→feature、footer→contentに再分類
   *
   * @param sections - 検出されたセクション配列
   * @returns 制限後のセクション配列
   */
  private enforceSingleHeroFooterRule(sections: DetectedSection[]): DetectedSection[] {
    const heroThreshold = this.options.heroTopThreshold;
    const footerThreshold = this.options.footerBottomThreshold;

    // Step 1: heroセクションを処理
    const heroSections = sections.filter(
      (s) => s.type === 'hero' && s.position.estimatedTop !== undefined
    );

    // 位置条件を満たすheroセクション
    const validHeroSections = heroSections.filter(
      (s) => s.position.estimatedTop !== undefined && s.position.estimatedTop <= heroThreshold
    );

    // 最高信頼度のheroを選択
    let selectedHero: DetectedSection | undefined;
    if (validHeroSections.length > 0) {
      selectedHero = validHeroSections.reduce((best, current) =>
        current.confidence > best.confidence ? current : best
      );
    }

    // Step 2: footerセクションを処理
    const footerSections = sections.filter(
      (s) => s.type === 'footer' && s.position.estimatedTop !== undefined
    );

    // 位置条件を満たすfooterセクション
    // <footer>タグを持つものは優先的に採用
    const validFooterSections = footerSections.filter((s) => {
      const estimatedTop = s.position.estimatedTop;
      if (estimatedTop === undefined) return false;
      // 位置条件を満たす、または<footer>タグを持つ
      return estimatedTop >= footerThreshold || s.element.tagName === 'footer';
    });

    // 最高信頼度のfooterを選択（<footer>タグ優先）
    let selectedFooter: DetectedSection | undefined;
    if (validFooterSections.length > 0) {
      // <footer>タグを持つセクションを優先
      const footerTagSections = validFooterSections.filter((s) => s.element.tagName === 'footer');
      if (footerTagSections.length > 0) {
        selectedFooter = footerTagSections.reduce((best, current) =>
          current.confidence > best.confidence ? current : best
        );
      } else {
        selectedFooter = validFooterSections.reduce((best, current) =>
          current.confidence > best.confidence ? current : best
        );
      }
    }

    // Step 3: セクションを再分類
    const result: DetectedSection[] = [];
    for (const section of sections) {
      if (section.type === 'hero') {
        if (section === selectedHero) {
          // 選択されたheroはそのまま
          result.push(section);
        } else {
          // 選択されなかったheroはfeatureに再分類
          result.push({
            ...section,
            type: 'feature',
            // 信頼度を少し下げる（再分類されたことを示す）
            confidence: Math.max(0.1, section.confidence - 0.1),
          });
        }
      } else if (section.type === 'footer') {
        if (section === selectedFooter) {
          // 選択されたfooterはそのまま
          result.push(section);
        } else {
          // 選択されなかったfooterはunknownに再分類
          result.push({
            ...section,
            type: 'unknown',
            // 信頼度を少し下げる（再分類されたことを示す）
            confidence: Math.max(0.1, section.confidence - 0.1),
          });
        }
      } else {
        // hero/footer以外はそのまま
        result.push(section);
      }
    }

    return result;
  }

  /**
   * 同一タイプのセクション数を制限
   * 信頼度順でソートし、上位N件のみを返す
   */
  private applyMaxSectionsPerType(sections: DetectedSection[], maxPerType: number): DetectedSection[] {
    const typeCount = new Map<SectionType, number>();
    const result: DetectedSection[] = [];

    // 信頼度降順でソート（同一タイプ内で信頼度の高いものを優先）
    const sortedSections = [...sections].sort((a, b) => b.confidence - a.confidence);

    for (const section of sortedSections) {
      const count = typeCount.get(section.type) ?? 0;
      if (count < maxPerType) {
        result.push(section);
        typeCount.set(section.type, count + 1);
      }
    }

    // 元の順序（ページ順）に戻す
    return result.sort((a, b) => a.position.startY - b.position.startY);
  }

  /**
   * セクションタイプを推定
   */
  classifySection(section: DetectedSection): SectionType {
    // Re-evaluate based on section content
    const { content, element, position } = section;

    // Check class/ID patterns
    const classList = element.classes.join(' ');
    const id = element.id || '';

    for (const rule of CLASSIFICATION_RULES) {
      let matches = false;

      // Check class patterns
      if (rule.classPatterns) {
        for (const pattern of rule.classPatterns) {
          if (pattern.test(classList) || pattern.test(id)) {
            matches = true;
            break;
          }
        }
      }

      // Check tag names
      if (rule.tagNames && rule.tagNames.includes(element.tagName)) {
        matches = true;
      }

      // Check content conditions
      if (rule.contentConditions && !matches) {
        const cc = rule.contentConditions;
        let contentMatches = true;

        if (cc.requiresH1 && !content.headings.some((h) => h.level === 1)) {
          contentMatches = false;
        }

        if (cc.requiresButton && content.buttons.length === 0) {
          contentMatches = false;
        }

        // Only use content matching if no class/id hints
        if (contentMatches && !classList && !id) {
          matches = true;
        }
      }

      // Position-based classification for hero
      if (
        rule.positionConditions?.isNearTop &&
        position.startY <= 100 &&
        content.headings.some((h) => h.level === 1) &&
        content.buttons.length > 0
      ) {
        return 'hero';
      }

      if (matches) {
        return rule.targetType;
      }
    }

    return section.type;
  }

  /**
   * 特定タイプのセクションを抽出
   */
  findByType(sections: DetectedSection[], type: SectionType): DetectedSection[] {
    return sections.filter((section) => section.type === type);
  }
}
