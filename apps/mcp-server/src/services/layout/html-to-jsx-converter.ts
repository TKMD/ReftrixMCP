// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/* global Attr */
/**
 * HTML to JSX Converter
 *
 * HTMLスニペットをReact JSXコンポーネントに変換する機能を提供します。
 *
 * 機能:
 * - HTML要素 → React JSX要素（自己閉じタグ対応）
 * - class属性 → className
 * - for属性 → htmlFor
 * - style属性（文字列） → styleオブジェクト
 * - style属性 → TailwindCSSクラス（useTailwindオプション）
 * - イベントハンドラ属性（onclick等）→ 除去（セキュリティ）
 * - scriptタグの除去
 *
 * @module services/layout/html-to-jsx-converter
 */

import { JSDOM } from 'jsdom';
import { mapStyleToTailwind } from './style-to-tailwind-mapper';

// ==========================================================
// 型定義
// ==========================================================

/**
 * HTML to JSX 変換オプション
 */
export interface HtmlToJsxOptions {
  /** コメントを保持するか（デフォルト: false） */
  preserveComments?: boolean;
  /** 空の属性を除去するか（デフォルト: false） */
  removeEmptyAttributes?: boolean;
  /** 整形して出力するか（デフォルト: false） */
  pretty?: boolean;
  /** 複数ルート要素をフラグメントでラップするか（デフォルト: false） */
  wrapInFragment?: boolean;
  /** インラインスタイルをTailwindCSSクラスに変換するか（デフォルト: false） */
  useTailwind?: boolean;
  /** 独自クラス名（dwg-*, webflow-*, etc.）を除去するか（デフォルト: false） */
  removeProprietaryClasses?: boolean;
  /** 除去する独自クラス名のプレフィックスリスト（カスタム指定時） */
  proprietaryClassPrefixes?: string[];
}

// ==========================================================
// 定数
// ==========================================================

/**
 * 自己閉じタグ（void elements）
 * これらの要素は終了タグを持たない
 */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * HTMLからJSXへの属性名マッピング
 */
const ATTRIBUTE_MAP: Record<string, string> = {
  // React DOM属性
  class: 'className',
  for: 'htmlFor',

  // キャメルケース変換が必要な属性
  tabindex: 'tabIndex',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  maxlength: 'maxLength',
  minlength: 'minLength',
  readonly: 'readOnly',
  contenteditable: 'contentEditable',
  autocomplete: 'autoComplete',
  autofocus: 'autoFocus',
  autoplay: 'autoPlay',
  spellcheck: 'spellCheck',
  cellpadding: 'cellPadding',
  cellspacing: 'cellSpacing',
  frameborder: 'frameBorder',
  allowfullscreen: 'allowFullScreen',
  usemap: 'useMap',
  crossorigin: 'crossOrigin',
  datetime: 'dateTime',
  enctype: 'encType',
  formaction: 'formAction',
  formenctype: 'formEncType',
  formmethod: 'formMethod',
  formnovalidate: 'formNoValidate',
  formtarget: 'formTarget',
  hreflang: 'hrefLang',
  inputmode: 'inputMode',
  novalidate: 'noValidate',
  srcset: 'srcSet',
  srcdoc: 'srcDoc',
  srclang: 'srcLang',

  // ハイフン付き属性
  'accept-charset': 'acceptCharset',
  'http-equiv': 'httpEquiv',
};

/**
 * ブール属性（値なしで使用可能）
 */
const BOOLEAN_ATTRIBUTES = new Set([
  'disabled',
  'checked',
  'selected',
  'readonly',
  'required',
  'multiple',
  'autofocus',
  'autoplay',
  'controls',
  'loop',
  'muted',
  'open',
  'hidden',
  'novalidate',
  'async',
  'defer',
]);

/**
 * controlled componentでdefaultValueに変換すべき要素
 */
const DEFAULT_VALUE_ELEMENTS = new Set(['input', 'textarea', 'select']);

/**
 * デフォルトで除去する独自クラス名のプレフィックス
 *
 * 各Webビルダー/CMSの独自クラス名パターン:
 * - dwg-*: 不明なビルダー
 * - webflow-*: Webflow
 * - w-*: Webflow（短縮形、w-container, w-nav-menu等）
 * - framer-*: Framer
 * - wix-*: Wix
 * - squarespace-*: Squarespace
 * - shopify-*: Shopify
 * - wp-*: WordPress
 * - elementor-*: Elementor (WordPress plugin)
 * - divi-*: Divi (WordPress theme)
 * - beaver-*: Beaver Builder
 * - et-*: Elegant Themes
 * - vc-*: Visual Composer
 * - js-*: 一般的なJS制御用クラス
 * - is-*: 状態クラス（is-active, is-visible等）
 * - has-*: 状態クラス（has-dropdown等）
 */
 
const DEFAULT_PROPRIETARY_CLASS_PREFIXES = [
  'dwg-',
  'webflow-',
  'w-',
  'framer-',
  'wix-',
  'squarespace-',
  'shopify-',
  'wp-',
  'elementor-',
  'divi-',
  'beaver-',
  'et-',
  'vc-',
  'js-',
  'is-',
  'has-',
];

// ==========================================================
// ヘルパー関数
// ==========================================================

/**
 * 独自クラス名を除去する
 *
 * @param classString - スペース区切りのクラス名文字列
 * @param prefixes - 除去するプレフィックスリスト
 * @returns 独自クラス名を除去した後のクラス名配列
 */
function removeProprietaryClasses(
  classString: string,
  prefixes: string[]
): string[] {
  if (!classString || classString.trim() === '') {
    return [];
  }

  const classes = classString.split(/\s+/).filter(Boolean);

  return classes.filter((cls) => {
    // プレフィックスリストに一致するクラスを除去
    return !prefixes.some((prefix) => cls.startsWith(prefix));
  });
}

/**
 * CSSプロパティ名をキャメルケースに変換
 */
function cssPropertyToCamelCase(prop: string): string {
  // ベンダープレフィックス（-webkit-, -moz- など）の処理
  if (prop.startsWith('-')) {
    // -webkit-transform → WebkitTransform
    const withoutLeadingDash = prop.slice(1);
    const parts = withoutLeadingDash.split('-');
    return parts
      .map((part, index) =>
        index === 0
          ? part.charAt(0).toUpperCase() + part.slice(1)
          : part.charAt(0).toUpperCase() + part.slice(1)
      )
      .join('');
  }

  // 通常のハイフン付きプロパティ
  return prop.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * style文字列をパースしてスタイルオブジェクトに変換
 */
function parseStyleString(styleString: string): Record<string, string> {
  if (!styleString || styleString.trim() === '') {
    return {};
  }

  const styles: Record<string, string> = {};
  const declarations = styleString.split(';').filter((s) => s.trim());

  for (const declaration of declarations) {
    const colonIndex = declaration.indexOf(':');
    if (colonIndex === -1) continue;

    const property = declaration.slice(0, colonIndex).trim();
    const value = declaration.slice(colonIndex + 1).trim();

    if (!property || !value) continue;

    const camelCaseProperty = cssPropertyToCamelCase(property);
    styles[camelCaseProperty] = value;
  }

  return styles;
}

/**
 * スタイルオブジェクトをJSX形式の文字列に変換
 */
function stylesToJsxString(styles: Record<string, string>): string {
  if (Object.keys(styles).length === 0) {
    return '';
  }

  const styleEntries = Object.entries(styles)
    .map(([key, val]) => `${key}: '${val.replace(/'/g, "\\'")}'`)
    .join(', ');

  return `style={{${styleEntries}}}`;
}

/**
 * style文字列をJSXスタイルオブジェクト表現に変換
 */
function convertStyleToJsx(styleString: string): string {
  const styles = parseStyleString(styleString);
  return stylesToJsxString(styles);
}

/**
 * スタイル変換結果（TailwindCSS統合用）
 */
interface StyleConversionResult {
  /** 生成されたTailwindクラス */
  tailwindClasses: string[];
  /** 変換できなかったスタイルのJSX文字列（空の場合は''） */
  remainingStyleJsx: string;
}

/**
 * style文字列をTailwindクラスとremainingスタイルに変換
 */
function convertStyleToTailwind(styleString: string): StyleConversionResult {
  const styles = parseStyleString(styleString);

  if (Object.keys(styles).length === 0) {
    return { tailwindClasses: [], remainingStyleJsx: '' };
  }

  const result = mapStyleToTailwind(styles);

  return {
    tailwindClasses: result.tailwindClasses,
    remainingStyleJsx: stylesToJsxString(result.remainingStyles),
  };
}

/**
 * 属性名をJSX形式に変換
 */
function convertAttributeName(name: string, tagName: string): string | null {
  const lowerName = name.toLowerCase();

  // イベントハンドラは除去（セキュリティ）
  if (lowerName.startsWith('on')) {
    return null;
  }

  // マッピングがある場合はそれを使用
  if (ATTRIBUTE_MAP[lowerName]) {
    return ATTRIBUTE_MAP[lowerName];
  }

  // data-*, aria-*, role はそのまま
  if (
    lowerName.startsWith('data-') ||
    lowerName.startsWith('aria-') ||
    lowerName === 'role'
  ) {
    return lowerName;
  }

  // value属性はcontrolled component要素ではdefaultValueに変換
  if (lowerName === 'value' && DEFAULT_VALUE_ELEMENTS.has(tagName.toLowerCase())) {
    return 'defaultValue';
  }

  // checked属性はdefaultCheckedに変換
  if (lowerName === 'checked' && tagName.toLowerCase() === 'input') {
    return 'defaultChecked';
  }

  // selected属性はdefaultSelectedに変換
  if (lowerName === 'selected' && tagName.toLowerCase() === 'option') {
    return 'defaultSelected';
  }

  return name;
}

/**
 * 属性をJSX形式に変換（style, class属性は除外）
 */
function convertAttributeToJsx(
  attr: Attr,
  tagName: string,
  options: HtmlToJsxOptions
): string {
  const name = attr.name.toLowerCase();
  const value = attr.value;

  // style属性は別処理（useTailwind対応のため）
  if (name === 'style') {
    // useTailwindの場合は後で処理するので空を返す
    if (options.useTailwind) {
      return '';
    }
    const styleJsx = convertStyleToJsx(value);
    return styleJsx;
  }

  // class属性も別処理（useTailwind対応またはremoveProprietaryClasses対応のため）
  if (name === 'class') {
    // useTailwindの場合は後で処理するので空を返す
    if (options.useTailwind) {
      return '';
    }
    // 空の属性を除去するオプション
    if (options.removeEmptyAttributes && value === '') {
      return '';
    }
    // 独自クラス名の除去（removeProprietaryClasses オプションが有効な場合）
    // useTailwind=falseでも独自クラスを除去できるようにする
    if (options.removeProprietaryClasses) {
      const prefixes =
        options.proprietaryClassPrefixes ?? DEFAULT_PROPRIETARY_CLASS_PREFIXES;
      const filteredClasses = removeProprietaryClasses(value, prefixes);
      if (filteredClasses.length === 0) {
        // すべてのクラスが除去された場合、className属性自体を削除
        return '';
      }
      return `className="${filteredClasses.join(' ')}"`;
    }
    return `className="${value}"`;
  }

  // 属性名を変換
  const jsxName = convertAttributeName(name, tagName);
  if (jsxName === null) {
    // イベントハンドラなど、除去すべき属性
    return '';
  }

  // 空の属性を除去するオプション
  if (options.removeEmptyAttributes && value === '') {
    return '';
  }

  // ブール属性の処理
  if (BOOLEAN_ATTRIBUTES.has(name)) {
    // 値がない場合、またはtrue相当の場合
    if (value === '' || value === name || value === 'true') {
      return jsxName;
    }
    // falseの場合は属性自体を除去
    if (value === 'false') {
      return '';
    }
  }

  // 通常の属性
  return `${jsxName}="${value}"`;
}

/**
 * ノードをJSXに変換
 */
function nodeToJsx(
  node: Node,
  options: HtmlToJsxOptions,
  indent: string = ''
): string {
  const newLine = options.pretty ? '\n' : '';
  const childIndent = options.pretty ? indent + '  ' : '';

  // テキストノード
  if (node.nodeType === 3) {
    // Node.TEXT_NODE
    const text = node.textContent || '';
    // 空白のみのテキストノードは除去（prettyモードでない場合）
    if (!options.pretty && text.trim() === '') {
      return '';
    }
    return text;
  }

  // コメントノード
  if (node.nodeType === 8) {
    // Node.COMMENT_NODE
    if (options.preserveComments) {
      return `{/* ${node.textContent || ''} */}`;
    }
    return '';
  }

  // 要素ノード
  if (node.nodeType === 1) {
    // Node.ELEMENT_NODE
    const element = node as Element;
    const tagName = element.tagName.toLowerCase();

    // scriptタグは除去
    if (tagName === 'script') {
      return '';
    }

    // 属性を変換
    const attrs: string[] = [];

    // useTailwindの場合、classとstyleを特別処理
    if (options.useTailwind) {
      const existingClass = element.getAttribute('class') || '';
      const styleAttr = element.getAttribute('style') || '';

      // Tailwind変換
      const { tailwindClasses, remainingStyleJsx } = convertStyleToTailwind(styleAttr);

      // 既存クラスを取得
      let existingClasses = existingClass.split(/\s+/).filter(Boolean);

      // 独自クラス名の除去（removeProprietaryClasses オプションが有効な場合）
      if (options.removeProprietaryClasses) {
        const prefixes =
          options.proprietaryClassPrefixes ?? DEFAULT_PROPRIETARY_CLASS_PREFIXES;
        existingClasses = removeProprietaryClasses(existingClass, prefixes);
      }

      // classNameをマージ
      const allClasses = [...existingClasses, ...tailwindClasses];

      if (allClasses.length > 0) {
        attrs.push(`className="${allClasses.join(' ')}"`);
      }

      // 残りのstyleがある場合のみ追加
      if (remainingStyleJsx) {
        attrs.push(remainingStyleJsx);
      }
    }

    // その他の属性を変換
    for (const attr of Array.from(element.attributes)) {
      const jsxAttr = convertAttributeToJsx(attr, tagName, options);
      if (jsxAttr) {
        attrs.push(jsxAttr);
      }
    }

    const attrString = attrs.length > 0 ? ' ' + attrs.join(' ') : '';

    // 自己閉じタグ
    if (VOID_ELEMENTS.has(tagName)) {
      return `${indent}<${tagName}${attrString} />`;
    }

    // 子要素を変換
    const children = Array.from(element.childNodes)
      .map((child) => nodeToJsx(child, options, childIndent))
      .filter((s) => s !== '');

    if (children.length === 0) {
      return `${indent}<${tagName}${attrString}></${tagName}>`;
    }

    const childContent = options.pretty
      ? newLine + children.join(newLine) + newLine + indent
      : children.join('');

    return `${indent}<${tagName}${attrString}>${childContent}</${tagName}>`;
  }

  return '';
}

// ==========================================================
// メイン関数
// ==========================================================

/**
 * HTMLをJSXに変換する
 *
 * @param html - 変換するHTML文字列
 * @param options - 変換オプション
 * @returns 変換されたJSX文字列
 *
 * @example
 * ```typescript
 * const jsx = convertHtmlToJsx('<div class="container"><p>Hello</p></div>');
 * // '<div className="container"><p>Hello</p></div>'
 *
 * const jsx = convertHtmlToJsx('<img src="image.jpg" alt="Test">');
 * // '<img src="image.jpg" alt="Test" />'
 *
 * const jsx = convertHtmlToJsx('<div style="color: red; font-size: 16px;">Text</div>');
 * // '<div style={{color: 'red', fontSize: '16px'}}>Text</div>'
 * ```
 */
export function convertHtmlToJsx(html: string, options?: HtmlToJsxOptions): string {
  const opts: HtmlToJsxOptions = {
    preserveComments: false,
    removeEmptyAttributes: false,
    pretty: false,
    wrapInFragment: false,
    useTailwind: false,
    removeProprietaryClasses: false,
    ...options,
  };

  // 空の入力は空文字を返す
  if (!html || html.trim() === '') {
    return '';
  }

  // JSDOMでパース
  const dom = new JSDOM(html);
  const body = dom.window.document.body;

  // 子ノードを変換
  const children = Array.from(body.childNodes)
    .map((node) => nodeToJsx(node, opts, opts.pretty ? '' : ''))
    .filter((s) => s !== '');

  // 結果が空の場合
  if (children.length === 0) {
    return '';
  }

  // 単一のルート要素
  if (children.length === 1 && !opts.wrapInFragment) {
    // children[0]は必ず存在する（length === 1 のため）
    return children[0] as string;
  }

  // 複数のルート要素
  if (opts.wrapInFragment) {
    const content = opts.pretty
      ? '\n' + children.join('\n') + '\n'
      : children.join('');
    return `<>${content}</>`;
  }

  // フラグメントなしの場合は連結して返す
  return children.join(opts.pretty ? '\n' : '');
}
