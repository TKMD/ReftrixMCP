// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ExternalCssFetcher Service
 * 外部CSSファイルの取得と処理を行うサービス
 *
 * 機能:
 * - HTMLから<link rel="stylesheet">タグのCSS URLを抽出
 * - CSSから@import URLを抽出
 * - 相対URLを絶対URLに変換
 * - SSRF対策（プライベートIPブロック）
 * - タイムアウト処理
 * - 複数CSSファイルの並列取得
 *
 * @module services/external-css-fetcher
 */

import { createLogger } from '../utils/logger';

// =============================================
// ロガー
// =============================================

const logger = createLogger('ExternalCssFetcher');

// =============================================
// 型定義
// =============================================

/**
 * CSS URL抽出結果
 */
export interface ExtractedCssUrl {
  /** 抽出されたURL（絶対URL） */
  url: string;
  /** 元のhref値（相対URLの場合もある） */
  originalHref: string;
  /** link要素のmedia属性 */
  media?: string;
  /** link要素のtype属性（省略時はtext/css） */
  type?: string;
  /** @importからの抽出かどうか */
  fromImport?: boolean;
}

/**
 * CSS取得オプション
 */
export interface FetchCssOptions {
  /** タイムアウト（ミリ秒）デフォルト: 5000 */
  timeout?: number;
  /** 最大CSSサイズ（バイト）デフォルト: 5MB */
  maxSize?: number;
  /** User-Agentヘッダー */
  userAgent?: string;
}

/**
 * 複数CSS取得オプション
 */
export interface FetchAllCssOptions extends FetchCssOptions {
  /** 最大並列取得数 デフォルト: 5 */
  maxConcurrent?: number;
  /** エラーでも継続するか デフォルト: true */
  continueOnError?: boolean;
}

/**
 * 単一CSS取得結果
 */
export interface FetchCssResult {
  /** 取得URL */
  url: string;
  /** CSSコンテンツ（成功時） */
  content: string | null;
  /** エラーメッセージ（失敗時） */
  error?: string;
}

/**
 * 内部用：詳細なCSS取得結果
 */
interface FetchCssDetailedResult {
  /** 取得成功フラグ */
  success: boolean;
  /** CSSコンテンツ（成功時） */
  content?: string;
  /** エラーメッセージ（失敗時） */
  error?: string;
  /** HTTPステータスコード（取得試行時） */
  statusCode?: number;
  /** 最終的なURL（リダイレクト後） */
  finalUrl?: string;
  /** コンテンツサイズ（バイト） */
  contentSize?: number;
}

/**
 * 複数CSS取得結果
 */
interface FetchAllCssDetailedResult {
  /** 結合されたCSSコンテンツ */
  combinedCss: string;
  /** 各URLの取得結果 */
  results: Array<{
    url: string;
    success: boolean;
    error?: string;
    contentSize?: number;
    content?: string;
  }>;
  /** 成功した取得数 */
  successCount: number;
  /** 失敗した取得数 */
  failedCount: number;
  /** 合計コンテンツサイズ（バイト） */
  totalSize: number;
}

// =============================================
// 定数
// =============================================

/** デフォルトタイムアウト（ms） */
const DEFAULT_TIMEOUT = 5000;

/** デフォルト最大CSSサイズ（5MB） */
const DEFAULT_MAX_SIZE = 5 * 1024 * 1024;

/** デフォルト最大並列取得数 */
const DEFAULT_MAX_CONCURRENT = 5;

/** デフォルトUser-Agent */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; ReftrixCssFetcher/1.0; +https://reftrix.app)';

// =============================================
// SSRF対策 - プライベートIPチェック
// =============================================

/**
 * プライベートIPアドレスかどうかをチェック
 */
function isPrivateIp(hostname: string): boolean {
  // localhost
  if (hostname === 'localhost' || hostname === 'localhost.localdomain') {
    return true;
  }

  // IPv4形式のチェック
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = hostname.match(ipv4Regex);

  if (match) {
    const octets = match.slice(1).map(Number);
    const a = octets[0];
    const b = octets[1];
    const c = octets[2];
    const d = octets[3];

    // Validate all octets exist
    if (a === undefined || b === undefined || c === undefined || d === undefined) {
      return false;
    }

    // 10.0.0.0/8
    if (a === 10) return true;

    // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true;

    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;

    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;

    // 169.254.0.0/16 (link-local, AWS metadata)
    if (a === 169 && b === 254) return true;

    // 0.0.0.0/8
    if (a === 0) return true;

    // 255.255.255.255
    if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  }

  // IPv6 loopback
  if (hostname === '::1' || hostname === '[::1]') {
    return true;
  }

  return false;
}

/**
 * 危険なホスト名かどうかをチェック
 */
function isDangerousHostname(hostname: string): boolean {
  const lowerHostname = hostname.toLowerCase();

  // Cloud metadata service endpoints
  const dangerousHosts = [
    'metadata.google.internal',
    'metadata.google',
    'metadata',
    'instance-data',
    'fd00:ec2::254',
  ];

  return dangerousHosts.some(
    (dangerous) => lowerHostname === dangerous || lowerHostname.endsWith('.' + dangerous)
  );
}

/**
 * URLがSSRFの観点から安全かチェック
 *
 * @param url - チェック対象のURL
 * @returns 安全な場合true、危険な場合false
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);

    // プロトコルチェック（http/httpsのみ許可）
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      if (process.env.NODE_ENV === 'development') {
        logger.debug('Unsafe protocol blocked', { url, protocol: parsedUrl.protocol });
      }
      return false;
    }

    const hostname = parsedUrl.hostname;

    // プライベートIPチェック
    if (isPrivateIp(hostname)) {
      if (process.env.NODE_ENV === 'development') {
        logger.debug('Private IP blocked', { url, hostname });
      }
      return false;
    }

    // 危険なホスト名チェック
    if (isDangerousHostname(hostname)) {
      if (process.env.NODE_ENV === 'development') {
        logger.debug('Dangerous hostname blocked', { url, hostname });
      }
      return false;
    }

    return true;
  } catch {
    // 無効なURL
    if (process.env.NODE_ENV === 'development') {
      logger.debug('Invalid URL format', { url });
    }
    return false;
  }
}

// =============================================
// URL解決
// =============================================

/**
 * 相対URLを絶対URLに変換
 *
 * 対応する入力形式:
 * - 絶対URL: https://example.com/styles.css
 * - プロトコル相対URL: //cdn.example.com/styles.css
 * - ルート相対パス: /styles/main.css
 * - 相対パス: ./components/button.css, ../shared/reset.css
 * - ファイル名のみ: styles.css
 *
 * 特殊URLスキーム（そのまま返却）:
 * - data: URL: data:text/css;base64,...
 * - blob: URL: blob:https://...
 * - javascript: スキーム（セキュリティ上ブロック）
 *
 * @param href - 変換対象のURL（相対または絶対）
 * @param baseUrl - ベースURL
 * @returns 絶対URL、または特殊スキームの場合はそのまま
 */
export function resolveUrl(href: string, baseUrl: string): string {
  // 入力バリデーション
  if (!href || typeof href !== 'string' || href.trim() === '') {
    if (process.env.NODE_ENV === 'development') {
      logger.warn('resolveUrl: empty or invalid href', { href, baseUrl });
    }
    return '';
  }

  if (!baseUrl || typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    if (process.env.NODE_ENV === 'development') {
      logger.warn('resolveUrl: empty or invalid baseUrl', { href, baseUrl });
    }
    // baseUrlが無効な場合、hrefが絶対URLならそのまま返す
    try {
      new URL(href);
      return href; // 既に絶対URL
    } catch {
      return ''; // 相対URLだが解決不可
    }
  }

  const trimmedHref = href.trim();

  // 特殊URLスキームの処理
  // data: URL - そのまま返す（base64エンコードされたCSSなど）
  if (trimmedHref.startsWith('data:')) {
    return trimmedHref;
  }

  // blob: URL - そのまま返す（Blob URLとして有効）
  if (trimmedHref.startsWith('blob:')) {
    return trimmedHref;
  }

  // javascript: スキーム - セキュリティ上ブロック（空文字列を返す）
  if (trimmedHref.toLowerCase().startsWith('javascript:')) {
    if (process.env.NODE_ENV === 'development') {
      logger.warn('resolveUrl: blocked javascript: scheme', { href });
    }
    return '';
  }

  try {
    // プロトコル相対URL (//) の処理
    if (trimmedHref.startsWith('//')) {
      const base = new URL(baseUrl);
      return base.protocol + trimmedHref;
    }

    // URL コンストラクタで解決
    const resolved = new URL(trimmedHref, baseUrl);
    return resolved.href;
  } catch (error) {
    // 解決できない場合は空文字列を返す（無効なURLを返さない）
    if (process.env.NODE_ENV === 'development') {
      logger.warn('Failed to resolve URL', {
        href,
        baseUrl,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return '';
  }
}

// =============================================
// CSS URL抽出
// =============================================

/**
 * HTMLから<link rel="stylesheet">のURLを抽出
 *
 * @param html - HTML文字列
 * @param baseUrl - ベースURL（相対URL解決用）
 * @returns 抽出されたCSS URL配列
 */
export function extractCssUrls(html: string, baseUrl: string): ExtractedCssUrl[] {
  const results: ExtractedCssUrl[] = [];
  const seenUrls = new Set<string>();

  // <link rel="stylesheet" ...> を抽出（様々なバリエーションに対応）
  // rel="stylesheet" または rel='stylesheet' のパターン
  const linkRegex =
    /<link\s+[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi;
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/i;
  const mediaRegex = /media\s*=\s*["']([^"']+)["']/i;
  const typeRegex = /type\s*=\s*["']([^"']+)["']/i;

  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const linkTag = linkMatch[0];
    const hrefMatch = hrefRegex.exec(linkTag);

    if (hrefMatch && hrefMatch[1]) {
      const originalHref = hrefMatch[1];
      const resolvedUrl = resolveUrl(originalHref, baseUrl);

      // 重複チェック
      if (seenUrls.has(resolvedUrl)) {
        continue;
      }
      seenUrls.add(resolvedUrl);

      const result: ExtractedCssUrl = {
        url: resolvedUrl,
        originalHref,
      };

      // media属性
      const mediaMatch = mediaRegex.exec(linkTag);
      if (mediaMatch && mediaMatch[1]) {
        result.media = mediaMatch[1];
      }

      // type属性
      const typeMatch = typeRegex.exec(linkTag);
      if (typeMatch && typeMatch[1]) {
        result.type = typeMatch[1];
      }

      results.push(result);
    }
  }

  // <style>タグ内の@importも抽出
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch;
  while ((styleMatch = styleRegex.exec(html)) !== null) {
    const styleContent = styleMatch[1];
    if (!styleContent) continue;
    const imports = extractImportUrls(styleContent, baseUrl);
    for (const imp of imports) {
      if (!seenUrls.has(imp.url)) {
        seenUrls.add(imp.url);
        results.push(imp);
      }
    }
  }

  if (process.env.NODE_ENV === 'development') {
    logger.debug('Extracted CSS URLs from HTML', { count: results.length, baseUrl });
  }

  return results;
}

/**
 * CSSコンテンツ内の@import URLを抽出
 *
 * @param css - CSSコンテンツ
 * @param baseUrl - ベースURL（相対URL解決用）
 * @returns 抽出されたCSS URL配列
 */
export function extractImportUrls(css: string, baseUrl: string): ExtractedCssUrl[] {
  const results: ExtractedCssUrl[] = [];
  const seenUrls = new Set<string>();

  // @import url("...") または @import url('...') または @import url(...)
  const importUrlRegex = /@import\s+url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi;

  // @import "..." または @import '...'
  const importQuoteRegex = /@import\s+["']([^"']+)["']/gi;

  // url()形式
  let match;
  while ((match = importUrlRegex.exec(css)) !== null) {
    const matchedHref = match[1];
    if (!matchedHref) continue;
    const originalHref = matchedHref.trim();
    const resolvedUrl = resolveUrl(originalHref, baseUrl);

    if (!seenUrls.has(resolvedUrl)) {
      seenUrls.add(resolvedUrl);
      results.push({
        url: resolvedUrl,
        originalHref,
        fromImport: true,
      });
    }
  }

  // クォート形式
  while ((match = importQuoteRegex.exec(css)) !== null) {
    const matchedHref = match[1];
    if (!matchedHref) continue;
    const originalHref = matchedHref.trim();
    const resolvedUrl = resolveUrl(originalHref, baseUrl);

    if (!seenUrls.has(resolvedUrl)) {
      seenUrls.add(resolvedUrl);
      results.push({
        url: resolvedUrl,
        originalHref,
        fromImport: true,
      });
    }
  }

  if (process.env.NODE_ENV === 'development') {
    logger.debug('Extracted @import URLs from CSS', { count: results.length, baseUrl });
  }

  return results;
}

// =============================================
// CSS取得
// =============================================

/**
 * 単一URLからCSSを取得
 *
 * @param url - CSS取得先URL
 * @param options - 取得オプション
 * @returns CSS取得結果（成功時はコンテンツ文字列、失敗時はnull）
 */
export async function fetchCss(
  url: string,
  options: FetchCssOptions = {}
): Promise<string | null> {
  const result = await fetchCssDetailed(url, options);
  return result.success ? (result.content ?? null) : null;
}

/**
 * 単一URLからCSSを取得（詳細結果）
 *
 * @param url - CSS取得先URL
 * @param options - 取得オプション
 * @returns 詳細なCSS取得結果
 */
async function fetchCssDetailed(
  url: string,
  options: FetchCssOptions = {}
): Promise<FetchCssDetailedResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  // URL検証
  if (!isSafeUrl(url)) {
    return {
      success: false,
      error: 'SSRF protection: URL blocked',
    };
  }

  // AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    if (process.env.NODE_ENV === 'development') {
      logger.debug('Fetching CSS', { url, timeout, maxSize });
    }

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/css, */*;q=0.1',
      },
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    // 最終URLのSSRFチェック（リダイレクト対策）
    const finalUrl = response.url;
    if (finalUrl !== url && !isSafeUrl(finalUrl)) {
      return {
        success: false,
        error: 'SSRF protection: redirect to blocked URL',
        statusCode: response.status,
        finalUrl,
      };
    }

    // ステータスコードチェック
    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        statusCode: response.status,
        finalUrl,
      };
    }

    // Content-Typeチェック（柔軟に）
    const contentType = response.headers.get('content-type') ?? '';
    const isCssContentType =
      contentType.includes('text/css') ||
      contentType.includes('text/plain') ||
      contentType.includes('application/octet-stream') ||
      contentType === '';

    if (!isCssContentType && contentType.includes('text/html')) {
      return {
        success: false,
        error: `Invalid Content-Type: expected text/css, got ${contentType}`,
        statusCode: response.status,
        finalUrl,
      };
    }

    // Content-Lengthチェック（事前にサイズが分かる場合）
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (contentLength > maxSize) {
        return {
          success: false,
          error: `CSS content exceeds maximum size of ${maxSize} bytes`,
          statusCode: response.status,
          finalUrl,
          contentSize: contentLength,
        };
      }
    }

    // コンテンツ取得
    const content = await response.text();

    // 実際のサイズチェック
    const contentSize = new TextEncoder().encode(content).length;
    if (contentSize > maxSize) {
      return {
        success: false,
        error: `CSS content exceeds maximum size of ${maxSize} bytes`,
        statusCode: response.status,
        finalUrl,
        contentSize,
      };
    }

    if (process.env.NODE_ENV === 'development') {
      logger.debug('CSS fetched successfully', { url, contentSize, finalUrl });
    }

    return {
      success: true,
      content,
      statusCode: response.status,
      finalUrl,
      contentSize,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          error: `Request timed out after ${timeout}ms`,
        };
      }

      // ネットワークエラー
      return {
        success: false,
        error: `Network error: ${error.message}`,
      };
    }

    return {
      success: false,
      error: 'Unknown error occurred',
    };
  }
}

/**
 * 複数URLからCSSを取得（API向けシンプル版）
 *
 * @param urls - CSS取得先URL配列
 * @param options - 取得オプション
 * @returns CSS取得結果配列
 */
export async function fetchAllCss(
  urls: string[],
  options: FetchAllCssOptions = {}
): Promise<FetchCssResult[]> {
  const result = await fetchAllCssDetailed(urls, options);
  return result.results.map((r): FetchCssResult => {
    const item: FetchCssResult = {
      url: r.url,
      content: r.success && r.content ? r.content : null,
    };
    if (r.error) {
      item.error = r.error;
    }
    return item;
  });
}

/**
 * 複数URLからCSSを取得（詳細結果）
 *
 * @param urls - CSS取得先URL配列
 * @param options - 取得オプション
 * @returns 詳細なCSS取得結果
 */
async function fetchAllCssDetailed(
  urls: string[],
  options: FetchAllCssOptions = {}
): Promise<FetchAllCssDetailedResult> {
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const continueOnError = options.continueOnError ?? true;

  if (urls.length === 0) {
    return {
      combinedCss: '',
      results: [],
      successCount: 0,
      failedCount: 0,
      totalSize: 0,
    };
  }

  if (process.env.NODE_ENV === 'development') {
    logger.debug('Fetching multiple CSS files', {
      count: urls.length,
      maxConcurrent,
      continueOnError,
    });
  }

  const results: Array<{
    url: string;
    success: boolean;
    error?: string;
    contentSize?: number;
    content?: string;
  }> = [];

  // 並列実行数を制限して取得
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += maxConcurrent) {
    chunks.push(urls.slice(i, i + maxConcurrent));
  }

  for (const chunk of chunks) {
    const chunkResults = await Promise.all(
      chunk.map(async (url) => {
        const result = await fetchCssDetailed(url, options);
        const item: {
          url: string;
          success: boolean;
          error?: string;
          contentSize?: number;
          content?: string;
        } = {
          url,
          success: result.success,
        };
        if (result.error) {
          item.error = result.error;
        }
        if (result.contentSize !== undefined) {
          item.contentSize = result.contentSize;
        }
        if (result.content !== undefined) {
          item.content = result.content;
        }
        return item;
      })
    );

    results.push(...chunkResults);

    // エラー時に中断
    if (!continueOnError) {
      const hasError = chunkResults.some((r) => !r.success);
      if (hasError) {
        break;
      }
    }
  }

  // 結果を集計
  let successCount = 0;
  let failedCount = 0;
  let totalSize = 0;
  const cssContents: string[] = [];

  for (const result of results) {
    if (result.success && result.content) {
      successCount++;
      totalSize += result.contentSize ?? 0;
      cssContents.push(`/* ${result.url} */\n${result.content}`);
    } else {
      failedCount++;
    }
  }

  const combinedCss = cssContents.join('\n\n');

  if (process.env.NODE_ENV === 'development') {
    logger.debug('Multiple CSS fetch completed', {
      successCount,
      failedCount,
      totalSize,
      combinedCssLength: combinedCss.length,
    });
  }

  return {
    combinedCss,
    results,
    successCount,
    failedCount,
    totalSize,
  };
}

// =============================================
// ExternalCssFetcher クラス
// =============================================

/**
 * ExternalCssFetcher クラス
 *
 * 外部CSSファイルの取得と処理を行うユーティリティクラス
 *
 * @example
 * ```typescript
 * const fetcher = new ExternalCssFetcher();
 * const urls = fetcher.extractCssUrls(html, baseUrl);
 * const result = await fetcher.fetchAllCss(urls.map(u => u.url));
 * ```
 */
export class ExternalCssFetcher {
  private options: FetchAllCssOptions;

  constructor(options: FetchAllCssOptions = {}) {
    this.options = options;
  }

  /**
   * HTMLから<link rel="stylesheet">のURLを抽出
   */
  extractCssUrls(html: string, baseUrl: string): ExtractedCssUrl[] {
    return extractCssUrls(html, baseUrl);
  }

  /**
   * CSSコンテンツ内の@import URLを抽出
   */
  extractImportUrls(css: string, baseUrl: string): ExtractedCssUrl[] {
    return extractImportUrls(css, baseUrl);
  }

  /**
   * 単一URLからCSSを取得
   */
  async fetchCss(
    url: string,
    options?: FetchCssOptions
  ): Promise<FetchCssDetailedResult> {
    return fetchCssDetailed(url, { ...this.options, ...options });
  }

  /**
   * 複数URLからCSSを取得して結合
   */
  async fetchAllCss(
    urls: string[],
    options?: FetchAllCssOptions
  ): Promise<FetchAllCssDetailedResult> {
    return fetchAllCssDetailed(urls, { ...this.options, ...options });
  }

  /**
   * URLがSSRFの観点から安全かチェック
   */
  isSafeUrl(url: string): boolean {
    return isSafeUrl(url);
  }

  /**
   * 相対URLを絶対URLに変換
   */
  resolveUrl(href: string, baseUrl: string): string {
    return resolveUrl(href, baseUrl);
  }
}

// =============================================
// 開発環境ログ
// =============================================

if (process.env.NODE_ENV === 'development') {
  logger.debug('ExternalCssFetcher module loaded');
}
