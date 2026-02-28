// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HTMLサニタイザー
 * XSS対策のためのHTML浄化機能
 *
 * DOMPurifyをサーバーサイドで使用するためのラッパー
 *
 * セキュリティ要件:
 * - script タグの除去
 * - on* イベントハンドラの除去
 * - javascript: URL の除去
 * - iframe, object, embed の除去
 *
 * @see SEC監査指摘対応
 */

import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { logger, isDevelopment } from './logger';

// =============================================
// 型定義
// =============================================

/**
 * サニタイズオプション
 */
export interface SanitizeOptions {
  /** 許可するHTMLタグ（デフォルト: 安全なタグのみ） */
  allowedTags?: string[];
  /** 許可する属性（デフォルト: 安全な属性のみ） */
  allowedAttributes?: string[];
  /** style属性を許可するか（デフォルト: true） */
  allowStyles?: boolean;
  /** data-*属性を許可するか（デフォルト: true） */
  allowDataAttributes?: boolean;
  /** SVGを許可するか（デフォルト: true） */
  allowSvg?: boolean;
  /** MathMLを許可するか（デフォルト: false） */
  allowMathMl?: boolean;
  /**
   * ドキュメント構造を保持するか（デフォルト: false）
   *
   * true の場合:
   * - <html>, <head>, <body> 構造を保持
   * - <title> タグを保持
   * - 安全な <meta> タグを保持（name, charset のみ。http-equiv は除去）
   * - <html lang="..."> 属性を保持（WCAG 2.1 AA: html-has-lang）
   *
   * セキュリティ:
   * - <script>, <link>, <base> は引き続き除去
   * - <meta http-equiv="refresh"> は除去（リダイレクト攻撃防止）
   * - イベントハンドラ、javascript: URL は引き続き除去
   *
   * 用途: page.analyze の品質評価パイプライン（aXeアクセシビリティ検証）
   */
  preserveDocumentStructure?: boolean;
}

/**
 * サニタイズ結果
 */
export interface SanitizeResult {
  /** サニタイズ後のHTML */
  html: string;
  /** 除去された要素/属性の数 */
  removedCount: number;
  /** 除去されたタグ名（開発環境のみ） */
  removedTags?: string[];
}

// =============================================
// 定数定義
// =============================================

/**
 * 危険なタグ（常に除去）
 *
 * 注意: button, input, select, textareaはフォーム関連タグですが、
 * - イベントハンドラ（onclick等）はDANGEROUS_ATTRIBUTESで別途禁止
 * - formタグ自体も禁止されているためフォーム送信は不可
 * - layout.inspectでCTAボタン検出に必要なため、buttonのみ許可
 */
const DANGEROUS_TAGS = [
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  // 'button' - レイアウト解析でCTAボタン検出に必要なため許可
  //            イベントハンドラはDANGEROUS_ATTRIBUTESで禁止済み
  'select',
  'textarea',
  'meta',
  'link',
  'base',
  'title',
] as const;

/**
 * WHOLE_DOCUMENTモード用の危険タグ
 *
 * preserveDocumentStructure: true の場合、以下のタグは除去対象から除外:
 * - title: ページタイトル（aXe document-title ルール）
 * - meta: 安全なメタデータ（charset, name属性のみ。http-equivはフックで除去）
 *
 * 除去対象に残すタグ:
 * - link: 外部リソース読み込み（CSSインジェクション防止）
 * - base: 相対URL操作防止
 * - script, iframe, form 等: XSS/フィッシング防止
 */
const DANGEROUS_TAGS_WHOLE_DOCUMENT = [
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'select',
  'textarea',
  'link',
  'base',
] as const;

/**
 * 危険な属性（常に除去）
 */
const DANGEROUS_ATTRIBUTES = [
  'onclick',
  'ondblclick',
  'onmousedown',
  'onmouseup',
  'onmouseover',
  'onmousemove',
  'onmouseout',
  'onmouseenter',
  'onmouseleave',
  'onkeydown',
  'onkeypress',
  'onkeyup',
  'onfocus',
  'onblur',
  'onchange',
  'onsubmit',
  'onreset',
  'onload',
  'onunload',
  'onerror',
  'onabort',
  'onresize',
  'onscroll',
  'oncontextmenu',
  'ondrag',
  'ondragend',
  'ondragenter',
  'ondragleave',
  'ondragover',
  'ondragstart',
  'ondrop',
  'onwheel',
  'oncopy',
  'oncut',
  'onpaste',
  'onanimationstart',
  'onanimationend',
  'onanimationiteration',
  'ontransitionend',
  'formaction',
  'xlink:href',
  'xmlns:xlink',
] as const;

/**
 * 危険なURIプロトコル
 */
const DANGEROUS_URI_PROTOCOLS = [
  'javascript:',
  'data:text/html',
  'vbscript:',
  'mhtml:',
] as const;

// =============================================
// パフォーマンス最適化: HTML事前削減
// =============================================

/**
 * HTMLサイズ閾値（文字数）。これ以上のHTMLに対して事前削減を適用する。
 *
 * JSDOM + DOMPurifyは2MB超のHTMLで極端に遅くなるため（15分以上）、
 * DOMPurifyが除去するタグと同じタグをregexで事前に除去してHTMLサイズを削減する。
 *
 * 注意: html.lengthは文字数でありバイト数ではない。
 * UTF-8マルチバイト文字を含む場合、実際のバイト数はこの値より大きくなる。
 *
 * 重要: これはパフォーマンス最適化であり、セキュリティ境界ではない。
 * DOMPurifyは事前削減後も必ず実行される（DOMPURIFY_BYPASS_THRESHOLD_CHARS未満の場合）。
 */
const PRE_STRIP_THRESHOLD_CHARS = 500_000; // 500K文字

/**
 * DOMPurifyバイパス閾値（文字数）。
 *
 * preStripDangerousTags実行後もHTMLがこの閾値以上の場合、
 * DOMPurify（JSDOM）の実行をスキップし、事前削減結果をそのまま返す。
 *
 * 根拠:
 * - JSDOM + DOMPurifyは1.5MB超のHTMLで極端に遅い（O(n)だが定数係数が巨大）
 * - preStripDangerousTagsで script/iframe/noscript/object/embed 等は除去済み
 * - DB保存用途ではHTMLはデータとして格納され、ブラウザレンダリングされない
 * - 属性ベースのXSS（onerror, javascript:URL等）はDB保存文脈では無害
 *
 * セキュリティ注意:
 * - このバイパスはDB保存用途を前提としている
 * - HTMLをブラウザで直接レンダリングする場合は、DOMPurifyのバイパスは不可
 */
const DOMPURIFY_BYPASS_THRESHOLD_CHARS = 1_000_000; // 1M文字（1.28MBのlinear.appでJSDOMが8分以上ハング）

/**
 * DOMPurifyが除去するタグをregexで事前に除去し、HTMLサイズを削減する。
 *
 * セキュリティ注意:
 * - この関数はパフォーマンス最適化のみを目的とする
 * - DOMPurifyの後段実行が必須（regexだけではXSS対策として不十分）
 * - 除去対象はDANGEROUS_TAGS / DANGEROUS_TAGS_WHOLE_DOCUMENTと同一のタグのみ
 * - style, SVG等の分析に必要なタグは保持する
 *
 * @param html - 入力HTML
 * @param dangerousTags - 除去対象のタグリスト
 * @returns 事前削減されたHTML
 */
export function preStripDangerousTags(
  html: string,
  dangerousTags: readonly string[] = DANGEROUS_TAGS
): string {
  if (html.length < PRE_STRIP_THRESHOLD_CHARS) {
    return html;
  }

  const startTime = Date.now();
  const originalLength = html.length;
  let result = html;

  // Phase 1: コンテンツを持つ危険タグを除去（開始タグ〜終了タグ）
  // script, noscript, iframe, object, applet, textarea はコンテンツを含む
  const contentTags = ['script', 'noscript', 'iframe', 'object', 'applet', 'textarea'];
  for (const tag of contentTags) {
    if (dangerousTags.includes(tag)) {
      // 非貪欲マッチでネストしない前提（HTML仕様上scriptはネスト不可）
      result = result.replace(
        new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'),
        ''
      );
    }
  }

  // Phase 2: 自己閉じ・空の危険タグを除去
  // input, embed, frame, frameset, base, link, meta 等
  for (const tag of dangerousTags) {
    // 開始タグ（自己閉じ含む）: <tag ...> or <tag ... />
    result = result.replace(
      new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'),
      ''
    );
    // 終了タグ: </tag>
    result = result.replace(
      new RegExp(`</${tag}\\s*>`, 'gi'),
      ''
    );
  }

  // Phase 3: HTMLコメントを除去（条件付きコメント含む）
  result = result.replace(/<!--[\s\S]*?-->/g, '');

  const elapsed = Date.now() - startTime;
  const reduction = originalLength - result.length;
  const reductionPercent = ((reduction / originalLength) * 100).toFixed(1);

  logger.info('[html-sanitizer] Pre-strip completed', {
    originalBytes: originalLength,
    reducedBytes: result.length,
    reduction,
    reductionPercent: `${reductionPercent}%`,
    elapsedMs: elapsed,
  });

  return result;
}

// =============================================
// JSDOMとDOMPurifyのセットアップ
// =============================================

// サーバーサイド用のwindowオブジェクトを作成
const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

// DOMPurifyの設定
const DEFAULT_DOMPURIFY_CONFIG = {
  // 危険なタグを禁止
  FORBID_TAGS: [...DANGEROUS_TAGS],
  // 危険な属性を禁止
  FORBID_ATTR: [...DANGEROUS_ATTRIBUTES],
  // javascript: などの危険なURIを除去
  ALLOW_UNKNOWN_PROTOCOLS: false,
  // data属性を許可
  ALLOW_DATA_ATTR: true,
  // SVGを許可
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  // セーフティオプション
  SAFE_FOR_TEMPLATES: true,
  WHOLE_DOCUMENT: false,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  RETURN_DOM_IMPORT: false,
  RETURN_TRUSTED_TYPE: false,
  FORCE_BODY: false,
  SANITIZE_DOM: true,
  KEEP_CONTENT: true,
  IN_PLACE: false,
};

// =============================================
// メイン関数
// =============================================

/**
 * HTMLをサニタイズする
 *
 * XSS攻撃を防ぐために以下を除去:
 * - script, iframe, form などの危険なタグ
 * - onclick などのイベントハンドラ属性
 * - javascript: プロトコル
 *
 * @param html - サニタイズするHTML
 * @param options - サニタイズオプション
 * @returns サニタイズされたHTML
 *
 * @example
 * ```typescript
 * const dirty = '<script>alert("xss")</script><p>Safe content</p>';
 * const clean = sanitizeHtml(dirty);
 * // => '<p>Safe content</p>'
 * ```
 */
export function sanitizeHtml(html: string, options?: SanitizeOptions): string {
  if (!html || html.trim() === '') {
    return '';
  }

  if (isDevelopment()) {
    logger.debug('[html-sanitizer] Sanitizing HTML', {
      inputLength: html.length,
    });
  }

  try {
    // preserveDocumentStructure モードの場合は専用ロジックを使用
    if (options?.preserveDocumentStructure) {
      return sanitizeHtmlWholeDocument(html, options);
    }

    // パフォーマンス最適化: 大きなHTMLに対して事前削減を適用
    const preprocessed = preStripDangerousTags(html, DANGEROUS_TAGS);

    // DOMPurifyバイパス: 事前削減後もHTMLが巨大な場合、DOMPurifyをスキップ
    // (JSDOM + DOMPurifyは1.5MB超で15分以上かかるため)
    if (preprocessed.length >= DOMPURIFY_BYPASS_THRESHOLD_CHARS) {
      logger.warn('[html-sanitizer] DOMPurify bypassed due to large HTML after pre-strip', {
        preprocessedLength: preprocessed.length,
        threshold: DOMPURIFY_BYPASS_THRESHOLD_CHARS,
        originalLength: html.length,
      });
      return preprocessed;
    }

    // DOMPurify設定をマージ
    const config = {
      ...DEFAULT_DOMPURIFY_CONFIG,
    };

    // オプションに応じて設定を調整
    if (options?.allowSvg === false) {
      config.USE_PROFILES = { ...config.USE_PROFILES, svg: false, svgFilters: false };
    }

    if (options?.allowStyles === false) {
      config.FORBID_ATTR = [...config.FORBID_ATTR, 'style'] as typeof config.FORBID_ATTR;
    }

    if (options?.allowDataAttributes === false) {
      config.ALLOW_DATA_ATTR = false;
    }

    // カスタム許可タグ
    if (options?.allowedTags) {
      // @ts-expect-error - DOMPurifyの型定義の問題
      config.ALLOWED_TAGS = options.allowedTags;
    }

    // カスタム許可属性
    if (options?.allowedAttributes) {
      // @ts-expect-error - DOMPurifyの型定義の問題
      config.ALLOWED_ATTR = options.allowedAttributes;
    }

    // サニタイズ実行（事前削減済みHTMLを使用）
    const sanitized = DOMPurify.sanitize(preprocessed, config);

    if (isDevelopment()) {
      logger.debug('[html-sanitizer] Sanitization complete', {
        inputLength: html.length,
        preprocessedLength: preprocessed.length,
        outputLength: sanitized.length,
        reduction: html.length - sanitized.length,
      });
    }

    return sanitized;
  } catch (error) {
    // エラー時は空文字列を返す（安全側に倒す）
    logger.error('[html-sanitizer] Sanitization failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

/**
 * HTMLをサニタイズし、詳細な結果を返す
 *
 * DOMPurifyインスタンス分離:
 * グローバルDOMPurifyインスタンスのhooksを使用すると、
 * 並行リクエストでステートが競合する可能性があるため、
 * 入出力の差分から危険要素のカウントを計算する方式を採用。
 *
 * @param html - サニタイズするHTML
 * @param options - サニタイズオプション
 * @returns サニタイズ結果（詳細情報付き）
 */
export function sanitizeHtmlWithDetails(
  html: string,
  options?: SanitizeOptions
): SanitizeResult {
  if (!html || html.trim() === '') {
    return {
      html: '',
      removedCount: 0,
    };
  }

  // 入力HTMLの危険タグ・属性をカウント
  const inputDangerousTagCount = countDangerousTags(html);
  const inputDangerousAttrCount = countDangerousAttributes(html);
  const inputRemovedTags = isDevelopment() ? extractDangerousTags(html) : [];

  // サニタイズ実行
  const sanitized = sanitizeHtml(html, options);

  // 出力HTMLの危険タグ・属性をカウント（通常は0）
  const outputDangerousTagCount = countDangerousTags(sanitized);
  const outputDangerousAttrCount = countDangerousAttributes(sanitized);

  // 除去された数 = 入力の危険要素数 - 出力の危険要素数
  const removedCount =
    (inputDangerousTagCount - outputDangerousTagCount) +
    (inputDangerousAttrCount - outputDangerousAttrCount);

  if (isDevelopment()) {
    logger.debug('[html-sanitizer] sanitizeHtmlWithDetails', {
      inputDangerousTagCount,
      inputDangerousAttrCount,
      outputDangerousTagCount,
      outputDangerousAttrCount,
      removedCount,
    });
  }

  return {
    html: sanitized,
    removedCount,
    ...(isDevelopment() && inputRemovedTags.length > 0 && { removedTags: inputRemovedTags }),
  };
}

/**
 * HTMLから危険タグの出現回数をカウント
 *
 * @param html - カウント対象のHTML
 * @returns 危険タグの出現回数
 */
function countDangerousTags(html: string): number {
  let count = 0;
  const lowerHtml = html.toLowerCase();

  for (const tag of DANGEROUS_TAGS) {
    // 開始タグをカウント: <script, <script>, <script attr>
    const openTagRegex = new RegExp(`<${tag}(?:\\s|>|/>)`, 'gi');
    const matches = lowerHtml.match(openTagRegex);
    if (matches) {
      count += matches.length;
    }
  }

  return count;
}

/**
 * HTMLから危険属性の出現回数をカウント
 *
 * @param html - カウント対象のHTML
 * @returns 危険属性の出現回数
 */
function countDangerousAttributes(html: string): number {
  let count = 0;
  const lowerHtml = html.toLowerCase();

  for (const attr of DANGEROUS_ATTRIBUTES) {
    // 属性をカウント: onclick=, onclick=", onclick='
    const attrRegex = new RegExp(`\\s${attr}\\s*=`, 'gi');
    const matches = lowerHtml.match(attrRegex);
    if (matches) {
      count += matches.length;
    }
  }

  return count;
}

/**
 * HTMLから危険タグ名を抽出（開発環境用）
 *
 * @param html - 抽出対象のHTML
 * @returns 検出された危険タグ名の配列
 */
function extractDangerousTags(html: string): string[] {
  const tags: string[] = [];
  const lowerHtml = html.toLowerCase();

  for (const tag of DANGEROUS_TAGS) {
    const openTagRegex = new RegExp(`<${tag}(?:\\s|>|/>)`, 'gi');
    if (openTagRegex.test(lowerHtml)) {
      tags.push(tag);
    }
  }

  return tags;
}

/**
 * 特定の属性値が安全かどうかをチェック
 *
 * @param attrName - 属性名
 * @param attrValue - 属性値
 * @returns 安全な場合 true
 */
export function isSafeAttributeValue(attrName: string, attrValue: string): boolean {
  const lowerValue = attrValue.toLowerCase().trim();

  // href, src, action などのURI属性
  if (['href', 'src', 'action', 'formaction', 'data', 'cite', 'poster', 'background'].includes(attrName.toLowerCase())) {
    // 危険なプロトコルをチェック
    for (const protocol of DANGEROUS_URI_PROTOCOLS) {
      if (lowerValue.startsWith(protocol)) {
        return false;
      }
    }
  }

  // style属性内のexpression(), url(javascript:) などをチェック
  if (attrName.toLowerCase() === 'style') {
    if (
      lowerValue.includes('expression(') ||
      lowerValue.includes('javascript:') ||
      lowerValue.includes('behavior:') ||
      lowerValue.includes('-moz-binding:')
    ) {
      return false;
    }
  }

  return true;
}

// =============================================
// WHOLE_DOCUMENT モード（preserveDocumentStructure用）
// =============================================

/**
 * WHOLE_DOCUMENTモード用のDOMPurifyインスタンス
 *
 * グローバルインスタンスとは別にフックを設定するため、
 * 専用のJSDOMとDOMPurifyを作成する。
 *
 * セキュリティ: <meta http-equiv> を除去するフック付き
 * - http-equiv="refresh" はオープンリダイレクト攻撃に使用される
 * - http-equiv="set-cookie" はCookieインジェクションに使用される
 */
const wholeDocWindow = new JSDOM('').window;
const WholeDocDOMPurify = createDOMPurify(wholeDocWindow);

// フック: <meta http-equiv> を持つ要素を除去
// 安全な meta タグ（name=, charset=）のみ許可
// http-equiv="refresh" はオープンリダイレクト攻撃、
// http-equiv="set-cookie" はCookieインジェクションに使用される
WholeDocDOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'meta') {
    // DOMPurify内部ではノードはDOM Elementとして扱われる
    const el = node as Element;
    if (typeof el.getAttribute === 'function' && el.getAttribute('http-equiv')) {
      // http-equiv属性を持つmetaタグはノードごと除去
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }
  }
});

/**
 * WHOLE_DOCUMENTモードでHTMLをサニタイズ
 *
 * <html>, <head>, <body> 構造を保持しつつ、
 * 危険な要素は除去する。
 *
 * 保持する要素:
 * - <html lang="...">: アクセシビリティ（WCAG 2.1 AA html-has-lang）
 * - <title>: ページタイトル（aXe document-title）
 * - <meta name="...">: 安全なメタデータ
 * - <meta charset="...">: 文字エンコーディング
 *
 * 除去する要素:
 * - <script>, <iframe>, <form> 等の危険タグ
 * - <meta http-equiv="...">: リダイレクト攻撃防止
 * - <link>, <base>: 外部リソース操作防止
 * - on* イベントハンドラ
 * - javascript:, data:text/html 等の危険URIスキーム
 *
 * @param html - サニタイズするHTML
 * @param options - サニタイズオプション
 * @returns サニタイズされたHTML（ドキュメント構造保持）
 */
function sanitizeHtmlWholeDocument(html: string, options?: SanitizeOptions): string {
  // パフォーマンス最適化: 大きなHTMLに対して事前削減を適用
  const preprocessed = preStripDangerousTags(html, DANGEROUS_TAGS_WHOLE_DOCUMENT);

  // DOMPurifyバイパス: 事前削減後もHTMLが巨大な場合、DOMPurifyをスキップ
  if (preprocessed.length >= DOMPURIFY_BYPASS_THRESHOLD_CHARS) {
    logger.warn('[html-sanitizer] DOMPurify bypassed (WholeDocument) due to large HTML', {
      preprocessedLength: preprocessed.length,
      threshold: DOMPURIFY_BYPASS_THRESHOLD_CHARS,
    });
    return preprocessed;
  }

  const config = {
    // 危険なタグを禁止（title, metaは除外）
    FORBID_TAGS: [...DANGEROUS_TAGS_WHOLE_DOCUMENT],
    // 危険な属性を禁止
    FORBID_ATTR: [...DANGEROUS_ATTRIBUTES],
    // javascript: などの危険なURIを除去
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // data属性を許可
    ALLOW_DATA_ATTR: true,
    // SVGを許可
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    // セーフティオプション
    SAFE_FOR_TEMPLATES: true,
    // WHOLE_DOCUMENT: html/head/body構造を保持
    WHOLE_DOCUMENT: true,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    RETURN_DOM_IMPORT: false,
    RETURN_TRUSTED_TYPE: false,
    FORCE_BODY: false,
    SANITIZE_DOM: true,
    KEEP_CONTENT: true,
    IN_PLACE: false,
    // ドキュメント構造のための追加タグ・属性
    // meta はDOMPurifyのデフォルト許可リストに含まれないため明示的に追加
    ADD_TAGS: ['meta'],
    ADD_ATTR: ['lang', 'charset', 'name', 'content'],
  };

  // オプションに応じて設定を調整
  if (options?.allowSvg === false) {
    config.USE_PROFILES = { ...config.USE_PROFILES, svg: false, svgFilters: false };
  }

  if (options?.allowStyles === false) {
    config.FORBID_ATTR = [...config.FORBID_ATTR, 'style'] as typeof config.FORBID_ATTR;
  }

  if (options?.allowDataAttributes === false) {
    config.ALLOW_DATA_ATTR = false;
  }

  const sanitized = WholeDocDOMPurify.sanitize(preprocessed, config);

  if (isDevelopment()) {
    logger.debug('[html-sanitizer] WHOLE_DOCUMENT sanitization complete', {
      inputLength: html.length,
      preprocessedLength: preprocessed.length,
      outputLength: sanitized.length,
      reduction: html.length - sanitized.length,
    });
  }

  return sanitized;
}

// =============================================
// 開発環境ログ
// =============================================

if (isDevelopment()) {
  logger.debug('[html-sanitizer] Module loaded', {
    dangerousTagsCount: DANGEROUS_TAGS.length,
    dangerousAttributesCount: DANGEROUS_ATTRIBUTES.length,
  });
}
