// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.ingest MCPツール
 * URLからWebページのHTML・スクリーンショットを取得し、レイアウト解析用データを準備
 *
 * セキュリティ要件:
 * - SSRF対策: プライベートIP、localhost、メタデータサービスへのアクセスをブロック
 * - HTMLサニタイズ: DOMPurifyでスクリプト・危険タグを除去
 *
 * @see /docs/plans/webdesign/01-page-ingest.md
 */

import { ZodError } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { prisma } from '@reftrix/database';
import { logger, isDevelopment } from '../../utils/logger';
import { validateExternalUrl } from '../../utils/url-validator';
import { normalizeUrlForStorage } from '../../utils/url-normalizer';
import { sanitizeHtml } from '../../utils/html-sanitizer';
import { pageIngestAdapter, type IngestResult } from '../../services/page-ingest-adapter';
import { extractCssUrls } from '../../services/external-css-fetcher';
import {
  formatZodError,
  createValidationErrorWithHints,
  formatMultipleDetailedErrors,
} from '../../utils/error-messages';
import {
  layoutIngestInputSchema,
  LAYOUT_MCP_ERROR_CODES,
  type LayoutIngestInput,
  type LayoutIngestOutput,
  type LayoutIngestData,
  type ScreenshotInfo,
  type PageMetadataOutput,
  type SourceInfoOutput,
} from './schemas';
import { createHash } from 'crypto';
import type { SectionInfo, LayoutInspectData } from './inspect';
import {
  getLayoutAnalyzerService,
  type LayoutAnalysisResult,
  type ExternalCssFetchResult,
} from '../../services/page/layout-analyzer.service';
import {
  responsiveAnalysisService,
  responsivePersistenceService,
  type ResponsiveAnalysisResult,
} from '../../services/responsive';

// =============================================
// 定数定義
// =============================================

/** デフォルトのレスポンスサイズ制限（1MB） */
const DEFAULT_RESPONSE_SIZE_LIMIT = 1000000;

/** 自動最適化時のHTML最大サイズ（20KB） */
const AUTO_OPTIMIZE_HTML_MAX_SIZE = 20000;

/** 自動最適化時のHTMLトリミングマーカー */
const AUTO_OPTIMIZE_TRUNCATION_MARKER = '\n<!-- truncated by auto_optimize -->';

/** デフォルトのingestタイムアウト（30秒） */
const DEFAULT_INGEST_TIMEOUT = 30000;

// =============================================
// ヘルパー関数
// =============================================

/**
 * Promiseにタイムアウトを追加するラッパー関数
 * WebGLサイトでChromiumがハングした場合でもタイムアウトを強制する
 *
 * @param promise - タイムアウトを追加するPromise
 * @param timeoutMs - タイムアウト時間（ミリ秒）
 * @param operationName - タイムアウト時のエラーメッセージに含める操作名
 * @returns タイムアウト付きのPromise
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Operation '${operationName}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

// =============================================
// 型定義
// =============================================

export type { LayoutIngestInput, LayoutIngestOutput };

// =============================================
// サービスインターフェース（DI用）
// =============================================

/**
 * セクション保存オプション
 */
export interface SaveSectionOptions {
  /** 外部CSSを含むCSSスニペット */
  cssSnippet?: string;
  /** 外部CSSコンテンツ（<link rel="stylesheet">の実コンテンツ） */
  externalCssContent?: string;
  /** 外部CSSメタ情報 */
  externalCssMeta?: {
    fetchedCount: number;
    failedCount: number;
    totalSize: number;
    urls: Array<{ url: string; size?: number; success?: boolean }>;
    fetchedAt: string;
  };
  /** Computed styles適用済みHTMLスニペット */
  htmlSnippet?: string;
}

/**
 * layout.ingest サービスインターフェース
 * auto_analyze機能でのHTML解析とEmbedding生成に使用
 */
export interface ILayoutIngestService {
  /** HTMLからセクションを解析 */
  analyzeHtml: (html: string) => Promise<LayoutInspectData>;
  /** セクションをEmbeddingと共にDBに保存 */
  saveSectionWithEmbedding: (
    section: SectionInfo,
    webPageId: string,
    embedding: number[],
    options?: SaveSectionOptions,
    textRepresentation?: string
  ) => Promise<string>;
  /** テキストからEmbeddingを生成 */
  generateEmbedding: (text: string) => Promise<number[]>;
}

/** サービスファクトリ関数 */
let ingestServiceFactory: (() => ILayoutIngestService) | null = null;

/**
 * サービスファクトリを設定（テスト用）
 */
export function setLayoutIngestServiceFactory(factory: () => ILayoutIngestService): void {
  ingestServiceFactory = factory;
}

/**
 * サービスファクトリをリセット（テスト用）
 */
export function resetLayoutIngestServiceFactory(): void {
  ingestServiceFactory = null;
}

// =============================================
// HTML最適化関数
// =============================================

/**
 * HTMLからscript/styleタグを除去し、空白を圧縮する
 * 自動最適化時にHTMLサイズを削減するために使用
 */
function optimizeHtml(html: string): string {
  let optimized = html;

  // scriptタグを除去（インライン含む）
  optimized = optimized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // styleタグを除去
  optimized = optimized.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // noscriptタグを除去
  optimized = optimized.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');

  // HTMLコメントを除去
  optimized = optimized.replace(/<!--[\s\S]*?-->/g, '');

  // 連続する空白を1つに圧縮
  optimized = optimized.replace(/[ \t]+/g, ' ');

  // 連続する改行を2つ以下に圧縮
  optimized = optimized.replace(/\n{3,}/g, '\n\n');

  // 行頭・行末の空白を削除
  optimized = optimized.replace(/^\s+|\s+$/gm, '');

  // 空行を削除
  optimized = optimized.replace(/\n\s*\n/g, '\n');

  return optimized.trim();
}

/**
 * HTMLを指定バイト数でトリミングする（UTF-8対応）
 */
function truncateHtmlToBytes(html: string, maxBytes: number, marker: string): string {
  const htmlBytes = new TextEncoder().encode(html);
  if (htmlBytes.length <= maxBytes) {
    return html;
  }

  const markerBytes = new TextEncoder().encode(marker);
  const targetByteLength = Math.max(0, maxBytes - markerBytes.length);
  const truncatedBytes = htmlBytes.slice(0, targetByteLength);
  return new TextDecoder().decode(truncatedBytes) + marker;
}

/**
 * セクションからテキスト表現を生成（Embedding生成用）
 */
function sectionToTextRepresentation(section: SectionInfo): string {
  const parts: string[] = [];

  // セクションタイプ
  parts.push(`${section.type} section`);

  // 見出し
  if (section.content.headings.length > 0) {
    const headingTexts = section.content.headings.map((h) => h.text).join(', ');
    parts.push(`with headings: ${headingTexts}`);
  }

  // ボタン
  if (section.content.buttons.length > 0) {
    const buttonTexts = section.content.buttons.map((b) => b.text).join(', ');
    parts.push(`buttons: ${buttonTexts}`);
  }

  // 段落（最初の1つのみ）
  if (section.content.paragraphs.length > 0) {
    const firstParagraph = section.content.paragraphs[0];
    if (firstParagraph && firstParagraph.length > 0) {
      const truncated =
        firstParagraph.length > 100
          ? firstParagraph.substring(0, 100) + '...'
          : firstParagraph;
      parts.push(`content: "${truncated}"`);
    }
  }

  // スタイル情報
  const styleInfo: string[] = [];
  if (section.style.backgroundColor) {
    styleInfo.push(`background ${section.style.backgroundColor}`);
  }
  if (section.style.textColor) {
    styleInfo.push(`text color ${section.style.textColor}`);
  }
  if (section.style.hasGradient) {
    styleInfo.push('gradient');
  }
  if (styleInfo.length > 0) {
    parts.push(`style: ${styleInfo.join(', ')}`);
  }

  // 画像
  if (section.content.images.length > 0) {
    parts.push(`${section.content.images.length} image(s)`);
  }

  // リンク
  if (section.content.links.length > 0) {
    parts.push(`${section.content.links.length} link(s)`);
  }

  return parts.join('. ') + '.';
}

// =============================================
// エラー判定ヘルパー
// =============================================

/**
 * エラーメッセージからエラーコードを判定
 */
function determineErrorCode(error: Error | string): string {
  const message = typeof error === 'string' ? error : error.message;
  const lowerMessage = message.toLowerCase();

  // タイムアウトエラー
  if (
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('navigation timeout') ||
    lowerMessage.includes('timed out')
  ) {
    return LAYOUT_MCP_ERROR_CODES.TIMEOUT_ERROR;
  }

  // ネットワークエラー
  if (
    lowerMessage.includes('net::') ||
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('enotfound') ||
    lowerMessage.includes('name_not_resolved') ||
    lowerMessage.includes('network') ||
    lowerMessage.includes('dns')
  ) {
    return LAYOUT_MCP_ERROR_CODES.NETWORK_ERROR;
  }

  // ブラウザエラー
  if (
    lowerMessage.includes('browser') ||
    lowerMessage.includes('browser has been closed') ||
    lowerMessage.includes('context has been closed') ||
    lowerMessage.includes('page has been closed')
  ) {
    return LAYOUT_MCP_ERROR_CODES.BROWSER_ERROR;
  }

  // HTTPエラー
  if (
    lowerMessage.includes('http ') ||
    lowerMessage.includes('status') ||
    lowerMessage.includes('404') ||
    lowerMessage.includes('500')
  ) {
    return LAYOUT_MCP_ERROR_CODES.HTTP_ERROR;
  }

  // その他は内部エラー
  return LAYOUT_MCP_ERROR_CODES.INTERNAL_ERROR;
}

/**
 * エラーメッセージをユーザーフレンドリーに変換
 */
function formatErrorMessage(code: string, originalMessage: string): string {
  switch (code) {
    case LAYOUT_MCP_ERROR_CODES.TIMEOUT_ERROR:
      return `Page load timeout: ${originalMessage}`;
    case LAYOUT_MCP_ERROR_CODES.NETWORK_ERROR:
      return `Network error: Unable to reach the specified URL`;
    case LAYOUT_MCP_ERROR_CODES.BROWSER_ERROR:
      return `Browser error: ${originalMessage}`;
    case LAYOUT_MCP_ERROR_CODES.HTTP_ERROR:
      return `HTTP error: ${originalMessage}`;
    default:
      return `Internal error: ${originalMessage}`;
  }
}

// =============================================
// メインハンドラー
// =============================================

/**
 * layout.ingest ツールハンドラー
 *
 * @param input - 入力パラメータ
 * @returns レイアウトインジェスト結果
 *
 * @example
 * ```typescript
 * const result = await layoutIngestHandler({
 *   url: 'https://awwwards.com/sites/example',
 *   source_type: 'award_gallery',
 *   usage_scope: 'inspiration_only',
 *   options: {
 *     fullPage: true,
 *     viewport: { width: 1920, height: 1080 },
 *   },
 * });
 * ```
 */
export async function layoutIngestHandler(
  input: unknown
): Promise<LayoutIngestOutput> {
  // 開発環境でのログ出力 - デバッグ用に詳細な入力情報を出力
  if (isDevelopment()) {
    logger.info('[MCP Tool] layout.ingest called', {
      url: (input as Record<string, unknown>)?.url,
    });
    // DEBUG: 入力値の詳細をログ出力（型情報含む）
    const rawOptions = (input as Record<string, unknown>)?.options;
    logger.debug('[MCP Tool] layout.ingest raw input', {
      rawInput: JSON.stringify(input),
      inputOptions: JSON.stringify(rawOptions),
      optionsType: typeof rawOptions,
      optionsIsString: typeof rawOptions === 'string',
    });
  }

  // MCP経由でoptionsがJSON文字列として渡される場合の前処理
  let processedInput = input;
  if (input && typeof input === 'object') {
    const inputObj = input as Record<string, unknown>;
    if (typeof inputObj.options === 'string') {
      try {
        const parsedOptions = JSON.parse(inputObj.options);
        processedInput = { ...inputObj, options: parsedOptions };
        if (isDevelopment()) {
          logger.debug('[MCP Tool] layout.ingest options parsed from string', {
            originalOptions: inputObj.options,
            parsedOptions: JSON.stringify(parsedOptions),
          });
        }
      } catch {
        // JSON解析に失敗した場合は元の入力をそのまま使用
        if (isDevelopment()) {
          logger.warn('[MCP Tool] layout.ingest options string parse failed', {
            options: inputObj.options,
          });
        }
      }
    }

    // 後方互換性: camelCaseパラメータをsnake_caseに正規化
    // MCP命名規約ではsnake_caseを使用するが、既存クライアントのために両方受け入れる
    const processedObj = processedInput as Record<string, unknown>;
    if (processedObj.options && typeof processedObj.options === 'object') {
      const opts = processedObj.options as Record<string, unknown>;
      const normalizedOpts = { ...opts };

      // camelCase -> snake_case マッピング
      const camelToSnakeMap: Record<string, string> = {
        fullPage: 'full_page',
        waitForSelector: 'wait_for_selector',
        disableJavaScript: 'disable_javascript',
        disableWebGL: 'disable_webgl',
        forceKillOnTimeout: 'force_kill_on_timeout',
        includeHtml: 'include_html',
        includeScreenshot: 'include_screenshot',
      };

      for (const [camelKey, snakeKey] of Object.entries(camelToSnakeMap)) {
        if (camelKey in opts && !(snakeKey in opts)) {
          normalizedOpts[snakeKey] = opts[camelKey];
          delete normalizedOpts[camelKey];
          if (isDevelopment()) {
            logger.debug('[MCP Tool] layout.ingest deprecated param normalized', {
              from: camelKey,
              to: snakeKey,
            });
          }
        }
      }

      processedInput = { ...processedObj, options: normalizedOpts };
    }
  }

  // 入力バリデーション
  let validated: LayoutIngestInput;
  try {
    validated = layoutIngestInputSchema.parse(processedInput);
  } catch (error) {
    if (error instanceof ZodError) {
      // 拡張エラーメッセージユーティリティを使用（ヒント付き）
      const errorWithHints = createValidationErrorWithHints(error, 'layout.ingest');
      const detailedMessage = formatMultipleDetailedErrors(errorWithHints.errors);

      // 後方互換性のため旧形式も保持
      const formattedErrors = formatZodError(error);

      if (isDevelopment()) {
        logger.error('[MCP Tool] layout.ingest validation error', {
          errors: errorWithHints.errors,
        });
      }

      return {
        success: false,
        error: {
          code: LAYOUT_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error:\n${detailedMessage}`,
          details: {
            errors: formattedErrors,
            detailedErrors: errorWithHints.errors,
          },
        },
      };
    }
    throw error;
  }

  // DEBUG: バリデーション後の値をログ出力
  if (isDevelopment()) {
    logger.debug('[MCP Tool] layout.ingest validated input', {
      validatedOptions: JSON.stringify(validated.options),
      include_html: validated.options?.include_html,
      include_screenshot: validated.options?.include_screenshot,
    });
  }

  // SSRF対策: URL検証
  const urlValidation = validateExternalUrl(validated.url);
  if (!urlValidation.valid) {
    if (isDevelopment()) {
      logger.warn('[MCP Tool] layout.ingest SSRF blocked', {
        url: validated.url,
        reason: urlValidation.error,
      });
    }

    return {
      success: false,
      error: {
        code: LAYOUT_MCP_ERROR_CODES.SSRF_BLOCKED,
        message: urlValidation.error ?? 'URL is blocked for security reasons',
      },
    };
  }

  try {
    // レスポンス最適化オプションを取得（DB-first: デフォルトでレスポンスサイズ削減）
    const includeHtml = validated.options?.include_html ?? false;
    const includeScreenshot = validated.options?.include_screenshot ?? false;
    const truncateHtmlBytes = validated.options?.truncate_html_bytes;
    const screenshotFormat = validated.options?.screenshot_format ?? 'png';
    const screenshotQuality = validated.options?.screenshot_quality;
    const screenshotMaxWidth = validated.options?.screenshot_max_width;
    const screenshotMaxHeight = validated.options?.screenshot_max_height;
    const autoOptimize = validated.options?.auto_optimize ?? false;
    const responseSizeLimit = validated.options?.response_size_limit;
    const saveToDb = validated.options?.save_to_db ?? false;

    // PageIngestAdapterを使用してページを取得
    // undefinedプロパティを除外してオプションを構築
    const ingestOptions: Parameters<typeof pageIngestAdapter.ingest>[0] = {
      url: validated.url,
      fullPage: validated.options?.full_page ?? true,
      sourceType: validated.source_type,
      usageScope: validated.usage_scope,
      // WebGL/3Dサイト対応: 適応的待機戦略（デフォルト有効）
      // Canvas/WebGL検出、Three.js等3Dライブラリ検出、フレームレート安定化待機
      // wait_untilがデフォルトの'load'の場合、自動的に'domcontentloaded'に変更される
      adaptiveWebGLWait: true,
    };

    // 明示的に指定されたオプションのみを追加
    if (validated.options?.viewport) {
      ingestOptions.viewport = validated.options.viewport;
    }
    if (validated.options?.wait_for_selector) {
      ingestOptions.waitForSelector = validated.options.wait_for_selector;
    }
    if (validated.options?.timeout !== undefined) {
      ingestOptions.timeout = validated.options.timeout;
    }
    if (validated.options?.disable_javascript !== undefined) {
      ingestOptions.disableJavaScript = validated.options.disable_javascript;
    }
    // wait_untilが'load'以外の場合のみ明示的に設定
    // 'load'の場合はadaptiveWebGLWait機能によりWebGLサイトで自動的に'domcontentloaded'に変更される
    if (validated.options?.wait_until !== undefined && validated.options.wait_until !== 'load') {
      ingestOptions.waitUntil = validated.options.wait_until;
    }
    // DOM安定化待機（デフォルトtrue - React/Vue/Next.js対応）
    if (validated.options?.wait_for_dom_stable !== undefined) {
      ingestOptions.waitForDomStable = validated.options.wait_for_dom_stable;
    }
    if (validated.options?.dom_stable_timeout !== undefined) {
      ingestOptions.domStableTimeout = validated.options.dom_stable_timeout;
    }
    // 追加待機オプション
    if (validated.options?.wait_for_timeout !== undefined) {
      ingestOptions.waitForTimeout = validated.options.wait_for_timeout;
    }
    if (validated.options?.wait_for_selector_hidden !== undefined) {
      ingestOptions.waitForSelectorHidden = validated.options.wait_for_selector_hidden;
    }
    // include_screenshot: false の場合はスクリーンショットをスキップ
    if (includeScreenshot === false) {
      ingestOptions.skipScreenshot = true;
    }
    // include_computed_styles: true の場合はComputed Stylesを取得
    if (validated.options?.include_computed_styles === true) {
      ingestOptions.includeComputedStyles = true;
    }

    // スクリーンショットオプションを追加
    if (screenshotFormat || screenshotQuality !== undefined) {
      ingestOptions.screenshotOptions = {
        format: screenshotFormat,
        // exactOptionalPropertyTypes対応: undefinedの場合はプロパティを含めない
        ...(screenshotQuality !== undefined && { quality: screenshotQuality }),
      };
    }

    // WebGL無効化オプション（重い3Dサイトでタイムアウト発生時に使用）
    if (validated.options?.disable_webgl === true) {
      ingestOptions.disableWebGL = true;
    }

    // タイムアウト時強制終了オプション（WebGLサイトでハング時の最終手段）
    if (validated.options?.force_kill_on_timeout === true) {
      ingestOptions.forceKillOnTimeout = true;
    }

    // robots.txt準拠オプション
    if (validated.respect_robots_txt !== undefined) {
      ingestOptions.respectRobotsTxt = validated.respect_robots_txt;
    }

    // グローバルタイムアウトを計算（ユーザー指定 or デフォルト30秒）
    // 内部操作にはバッファを持たせるため、全体タイムアウトは指定値の1.5倍を使用
    const effectiveTimeout = (ingestOptions.timeout ?? DEFAULT_INGEST_TIMEOUT) * 1.5;

    if (isDevelopment()) {
      logger.debug('[MCP Tool] layout.ingest starting with timeout', {
        url: validated.url,
        userTimeout: ingestOptions.timeout,
        effectiveTimeout,
      });
    }

    // グローバルタイムアウトラッパーで囲む
    // WebGLサイトでChromiumがハングした場合でもタイムアウトを強制する
    const ingestResult: IngestResult = await withTimeout(
      pageIngestAdapter.ingest(ingestOptions),
      effectiveTimeout,
      `layout.ingest for ${validated.url}`
    );

    // インジェスト失敗チェック
    if (!ingestResult.success) {
      if (isDevelopment()) {
        logger.error('[MCP Tool] layout.ingest failed', {
          url: validated.url,
          error: ingestResult.error,
        });
      }

      return {
        success: false,
        error: {
          code: LAYOUT_MCP_ERROR_CODES.INGEST_FAILED,
          message: ingestResult.error ?? 'Page ingest failed',
        },
      };
    }

    // 外部CSS URLをサニタイズ前に抽出（DOMPurifyで<link>タグが除去される問題の回避策）
    // auto_analyze と fetch_external_css のデフォルト値を早期に取得
    const autoAnalyze = validated.options?.auto_analyze ?? false;
    const fetchExternalCss = validated.options?.fetch_external_css ?? true;
    let preExtractedCssUrls: string[] = [];
    if (autoAnalyze && saveToDb && fetchExternalCss) {
      const baseUrl = urlValidation.normalizedUrl ?? validated.url;
      preExtractedCssUrls = extractCssUrls(ingestResult.html, baseUrl)
        .map(u => u.url)
        .filter(url => url.length > 0); // 空のURLを除外
      if (isDevelopment()) {
        logger.debug('[MCP Tool] layout.ingest pre-extracted CSS URLs before sanitization', {
          urlCount: preExtractedCssUrls.length,
          urls: preExtractedCssUrls.slice(0, 5), // Log first 5 URLs
        });
      }
    }

    // HTMLサニタイズとトランケート処理
    // save_to_db=true の場合は、レスポンスにHTMLを含めるかどうかに関係なくサニタイズが必要
    let sanitizedHtml: string | undefined;
    const needsSanitizedHtml = includeHtml || saveToDb;
    if (needsSanitizedHtml) {
      sanitizedHtml = sanitizeHtml(ingestResult.html);

      // トランケート処理
      if (truncateHtmlBytes !== undefined) {
        const htmlBytes = new TextEncoder().encode(sanitizedHtml);
        if (htmlBytes.length > truncateHtmlBytes) {
          // UTF-8バイト境界を考慮してトランケート
          // マーカーのバイト数を考慮して切り詰める
          const TRUNCATION_MARKER = '\n<!-- truncated -->';
          const markerByteLength = new TextEncoder().encode(TRUNCATION_MARKER).length;
          const targetByteLength = Math.max(0, truncateHtmlBytes - markerByteLength);
          const truncatedBytes = htmlBytes.slice(0, targetByteLength);
          sanitizedHtml = new TextDecoder().decode(truncatedBytes) + TRUNCATION_MARKER;
        }
      }
    }

    // スクリーンショット情報を変換（リサイズ対応）
    let screenshot: ScreenshotInfo | undefined;
    if (includeScreenshot && ingestResult.screenshots && ingestResult.screenshots.length > 0) {
      const firstScreenshot = ingestResult.screenshots[0];
      if (firstScreenshot) {
        let width = firstScreenshot.viewport.width;
        let height = firstScreenshot.viewport.height;
        let base64Data = firstScreenshot.data;
        const format = screenshotFormat === 'jpeg' ? 'jpeg' : firstScreenshot.format;

        // リサイズが必要な場合
        if (screenshotMaxWidth !== undefined || screenshotMaxHeight !== undefined) {
          const originalWidth = width;
          const originalHeight = height;

          // アスペクト比を維持しながらリサイズ
          if (screenshotMaxWidth !== undefined && width > screenshotMaxWidth) {
            const ratio = screenshotMaxWidth / width;
            width = screenshotMaxWidth;
            height = Math.round(height * ratio);
          }
          if (screenshotMaxHeight !== undefined && height > screenshotMaxHeight) {
            const ratio = screenshotMaxHeight / height;
            height = screenshotMaxHeight;
            width = Math.round(width * ratio);
          }

          // 実際のリサイズはadapterで行われるため、
          // ここではサイズ情報のみ更新（base64データはそのまま）
          // 本番ではsharpなどでリサイズを実装
          if (isDevelopment()) {
            logger.debug('[MCP Tool] Screenshot resize requested', {
              original: { width: originalWidth, height: originalHeight },
              resized: { width, height },
            });
          }
        }

        screenshot = {
          base64: base64Data,
          format: format as 'png' | 'jpeg',
          width,
          height,
        };
      }
    }

    // メタデータを変換
    const metadata: PageMetadataOutput = {
      title: ingestResult.metadata.title || '',
      description: ingestResult.metadata.description,
      favicon: ingestResult.metadata.favicon,
      ogImage: ingestResult.metadata.ogImage,
    };

    // ソース情報を変換
    const source: SourceInfoOutput = {
      type: ingestResult.source.type,
      usageScope: ingestResult.source.usageScope,
    };

    // DB保存処理（save_to_db: true の場合）
    let persistedId: string | undefined;
    let savedToDb = false;

    if (saveToDb && sanitizedHtml) {
      try {
        // HTMLハッシュを生成（変更検知用）
        const htmlHash = createHash('sha256').update(sanitizedHtml).digest('hex');

        // WebPageテーブルに保存（upsert: URLが重複する場合は更新）
        // URL正規化で末尾スラッシュ等の重複を防止
        const normalizedDbUrl = normalizeUrlForStorage(urlValidation.normalizedUrl ?? validated.url);
        const savedPage = await prisma.webPage.upsert({
          where: { url: normalizedDbUrl },
          create: {
            url: normalizedDbUrl,
            title: metadata.title || null,
            description: metadata.description || null,
            sourceType: ingestResult.source.type,
            usageScope: ingestResult.source.usageScope,
            htmlContent: sanitizedHtml,
            htmlHash,
            metadata: {
              favicon: metadata.favicon,
              ogImage: metadata.ogImage,
            },
            crawledAt: ingestResult.ingestedAt,
            analysisStatus: 'pending',
          },
          update: {
            title: metadata.title || null,
            description: metadata.description || null,
            htmlContent: sanitizedHtml,
            htmlHash,
            metadata: {
              favicon: metadata.favicon,
              ogImage: metadata.ogImage,
            },
            crawledAt: ingestResult.ingestedAt,
            analysisStatus: 'pending',
          },
          select: { id: true },
        });

        persistedId = savedPage.id;
        savedToDb = true;

        if (isDevelopment()) {
          logger.info('[MCP Tool] layout.ingest saved to DB', {
            id: persistedId,
            url: urlValidation.normalizedUrl ?? validated.url,
          });
        }
      } catch (dbError) {
        // DB保存失敗時はエラーを返す
        const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);

        if (isDevelopment()) {
          logger.error('[MCP Tool] layout.ingest DB save failed', {
            url: validated.url,
            error: errorMessage,
          });
        }

        return {
          success: false,
          error: {
            code: LAYOUT_MCP_ERROR_CODES.DB_SAVE_FAILED,
            message: `Failed to save to database: ${errorMessage}`,
            details: isDevelopment() ? { originalError: errorMessage } : undefined,
          },
        };
      }
    }

    // レスポンシブ解析: responsive.enabled: true の場合
    // 複数ビューポートでのキャプチャと差異検出を実行
    let responsiveAnalysisResult: ResponsiveAnalysisResult | undefined;

    if (validated.options?.responsive?.enabled === true) {
      try {
        if (isDevelopment()) {
          logger.info('[MCP Tool] layout.ingest responsive analysis starting', {
            url: validated.url,
            viewports: validated.options.responsive.viewports?.map((v) => v.name) ?? ['desktop', 'tablet', 'mobile'],
            includeScreenshots: validated.options.responsive.include_screenshots ?? true,
          });
        }

        // ResponsiveAnalysisOptionsを構築（undefinedプロパティを除外）
        const responsiveOptions: {
          enabled: boolean;
          viewports?: Array<{ name: string; width: number; height: number }>;
          include_screenshots?: boolean;
          include_diff_images?: boolean;
          diff_threshold?: number;
          detect_navigation?: boolean;
          detect_visibility?: boolean;
          detect_layout?: boolean;
        } = {
          enabled: true,
        };

        // 各プロパティはundefinedでなければ設定
        if (validated.options.responsive.viewports !== undefined) {
          responsiveOptions.viewports = validated.options.responsive.viewports;
        }
        if (validated.options.responsive.include_screenshots !== undefined) {
          responsiveOptions.include_screenshots = validated.options.responsive.include_screenshots;
        }
        if (validated.options.responsive.include_diff_images !== undefined) {
          responsiveOptions.include_diff_images = validated.options.responsive.include_diff_images;
        }
        if (validated.options.responsive.diff_threshold !== undefined) {
          responsiveOptions.diff_threshold = validated.options.responsive.diff_threshold;
        }
        if (validated.options.responsive.detect_navigation !== undefined) {
          responsiveOptions.detect_navigation = validated.options.responsive.detect_navigation;
        }
        if (validated.options.responsive.detect_visibility !== undefined) {
          responsiveOptions.detect_visibility = validated.options.responsive.detect_visibility;
        }
        if (validated.options.responsive.detect_layout !== undefined) {
          responsiveOptions.detect_layout = validated.options.responsive.detect_layout;
        }

        responsiveAnalysisResult = await responsiveAnalysisService.analyze(
          validated.url,
          responsiveOptions
        );

        if (isDevelopment()) {
          logger.info('[MCP Tool] layout.ingest responsive analysis completed', {
            url: validated.url,
            viewportsAnalyzed: responsiveAnalysisResult.viewportsAnalyzed.length,
            differencesFound: responsiveAnalysisResult.differences.length,
            breakpointsDetected: responsiveAnalysisResult.breakpoints.length,
            analysisTimeMs: responsiveAnalysisResult.analysisTimeMs,
          });
        }
      } catch (responsiveError) {
        // レスポンシブ解析の失敗はエラーとして返すのではなく、警告ログを出力して続行
        // インジェスト自体は成功しているため
        if (isDevelopment()) {
          logger.warn('[MCP Tool] layout.ingest responsive analysis failed', {
            url: validated.url,
            error: responsiveError instanceof Error ? responsiveError.message : String(responsiveError),
          });
        }
      }
    }

    // レスポンシブ解析結果のDB保存（save_to_db かつ responsive.save_to_db が true の場合）
    let responsiveAnalysisId: string | undefined;

    if (
      responsiveAnalysisResult &&
      persistedId &&
      saveToDb &&
      (validated.options?.responsive?.save_to_db ?? true)
    ) {
      try {
        responsiveAnalysisId = await responsivePersistenceService.save(
          persistedId,
          responsiveAnalysisResult
        );

        if (isDevelopment()) {
          logger.info('[MCP Tool] layout.ingest responsive analysis saved to DB', {
            responsiveAnalysisId,
            webPageId: persistedId,
          });
        }
      } catch (dbError) {
        // DB保存失敗はエラーとして返さず、警告ログを出力して続行
        if (isDevelopment()) {
          logger.warn('[MCP Tool] layout.ingest responsive DB save failed', {
            webPageId: persistedId,
            error: dbError instanceof Error ? dbError.message : String(dbError),
          });
        }
      }
    }

    // auto_analyze: trueの場合、セクション解析とEmbedding保存を行う
    // autoAnalyze と fetchExternalCss は前方（サニタイズ前）で定義済み
    let sectionsAnalyzed = 0;
    let externalCssFetchResult: ExternalCssFetchResult | undefined;

    if (autoAnalyze && saveToDb && persistedId && sanitizedHtml) {
      const service = ingestServiceFactory?.();
      if (service) {
        try {
          if (isDevelopment()) {
            logger.info('[MCP Tool] layout.ingest auto_analyze starting', {
              webPageId: persistedId,
            });
          }

          // 外部CSSオプションを取得
          const externalCssTimeout = validated.options?.external_css_timeout ?? 5000;
          const externalCssMaxSize = validated.options?.external_css_max_size ?? 5242880;
          const externalCssMaxConcurrent = validated.options?.external_css_max_concurrent ?? 5;
          const externalCssMaxFiles = validated.options?.external_css_max_files ?? 20;

          // LayoutAnalyzerServiceを使用してHTMLを解析（外部CSS取得を含む）
          const layoutAnalyzer = getLayoutAnalyzerService();
          const layoutAnalysisOptions = {
            includeContent: true,
            includeStyles: true,
            // Computed StylesをhtmlSnippetにインラインスタイルとして適用
            ...(ingestResult.computedStyles && ingestResult.computedStyles.length > 0 && {
              computedStyles: ingestResult.computedStyles,
            }),
            ...(fetchExternalCss && {
              externalCss: {
                fetchExternalCss: true as const,
                baseUrl: urlValidation.normalizedUrl ?? validated.url,
                timeout: externalCssTimeout,
                maxSize: externalCssMaxSize,
                maxConcurrent: externalCssMaxConcurrent,
                maxCssFiles: externalCssMaxFiles,
                // DOMPurifyで<link>タグが除去される問題の回避策
                // サニタイズ前のHTMLから抽出したURLを使用
                ...(preExtractedCssUrls.length > 0 && {
                  preExtractedUrls: preExtractedCssUrls,
                }),
              },
            }),
          };
          const layoutAnalysisResult: LayoutAnalysisResult = await layoutAnalyzer.analyze(
            sanitizedHtml,
            layoutAnalysisOptions
          );

          // 外部CSS取得結果を保存
          externalCssFetchResult = layoutAnalysisResult.externalCssFetch;

          if (isDevelopment() && externalCssFetchResult) {
            logger.debug('[MCP Tool] layout.ingest external CSS fetch completed', {
              webPageId: persistedId,
              successCount: externalCssFetchResult.successCount,
              failedCount: externalCssFetchResult.failedCount,
              totalSize: externalCssFetchResult.totalSize,
              processingTimeMs: externalCssFetchResult.processingTimeMs,
            });
          }

          // HTMLを解析してセクションを抽出（従来のサービス経由）
          const inspectResult = await service.analyzeHtml(sanitizedHtml);

          // 各セクションをEmbeddingと共に保存
          for (let sectionIndex = 0; sectionIndex < inspectResult.sections.length; sectionIndex++) {
            const section = inspectResult.sections[sectionIndex];
            if (!section) {
              // 配列境界チェックのためのガード（TypeScriptの厳格な型チェック対応）
              continue;
            }
            try {
              // セクションからテキスト表現を生成してEmbeddingを作成
              const textRepresentation = sectionToTextRepresentation(section);
              const embedding = await service.generateEmbedding(textRepresentation);

              // LayoutAnalyzerServiceから取得したhtmlSnippet（computed styles適用済み）を使用
              // インデックスが一致するlayoutAnalysisResult.sectionsからhtmlSnippetを取得
              const layoutSection = layoutAnalysisResult.sections[sectionIndex];
              const htmlSnippet = layoutSection?.htmlSnippet;

              // SectionPatternとSectionEmbeddingを保存
              // 外部CSSを取得した場合は、その内容をcssSnippetに設定
              // htmlSnippetはcomputed styles適用済み
              const saveOptions: SaveSectionOptions = {};
              if (layoutAnalysisResult.cssSnippet) {
                saveOptions.cssSnippet = layoutAnalysisResult.cssSnippet;
              }
              if (layoutAnalysisResult.externalCssContent) {
                saveOptions.externalCssContent = layoutAnalysisResult.externalCssContent;
              }
              if (layoutAnalysisResult.externalCssMeta) {
                saveOptions.externalCssMeta = layoutAnalysisResult.externalCssMeta;
              }
              if (htmlSnippet) {
                saveOptions.htmlSnippet = htmlSnippet;
              }

              await service.saveSectionWithEmbedding(
                section,
                persistedId,
                embedding,
                Object.keys(saveOptions).length > 0 ? saveOptions : undefined,
                textRepresentation
              );
              sectionsAnalyzed++;

              if (isDevelopment()) {
                logger.debug('[MCP Tool] layout.ingest section saved', {
                  sectionType: section.type,
                  sectionId: section.id,
                  hasCssSnippet: !!layoutAnalysisResult.cssSnippet,
                  cssSnippetLength: layoutAnalysisResult.cssSnippet?.length ?? 0,
                  hasExternalCssContent: !!layoutAnalysisResult.externalCssContent,
                  externalCssContentLength: layoutAnalysisResult.externalCssContent?.length ?? 0,
                  hasHtmlSnippet: !!htmlSnippet,
                  htmlSnippetLength: htmlSnippet?.length ?? 0,
                });
              }
            } catch (sectionError) {
              // 個別セクションの保存失敗は警告ログのみで継続
              if (isDevelopment()) {
                logger.warn('[MCP Tool] layout.ingest section save failed', {
                  sectionType: section.type,
                  error: sectionError instanceof Error ? sectionError.message : String(sectionError),
                });
              }
            }
          }

          if (isDevelopment()) {
            logger.info('[MCP Tool] layout.ingest auto_analyze completed', {
              webPageId: persistedId,
              sectionsAnalyzed,
              totalSections: inspectResult.sections.length,
              externalCssFetched: externalCssFetchResult?.successCount ?? 0,
              cssFramework: layoutAnalysisResult.cssFramework?.framework,
              computedStylesApplied: layoutAnalysisResult.computedStylesAppliedCount ?? 0,
            });
          }
        } catch (analyzeError) {
          // 解析失敗は警告ログのみで、インジェスト自体は成功とする
          if (isDevelopment()) {
            logger.warn('[MCP Tool] layout.ingest auto_analyze failed', {
              webPageId: persistedId,
              error: analyzeError instanceof Error ? analyzeError.message : String(analyzeError),
            });
          }
        }
      } else {
        if (isDevelopment()) {
          logger.warn('[MCP Tool] layout.ingest auto_analyze service not available', {
            webPageId: persistedId,
          });
        }
      }
    }

    // 成功レスポンスを構築
    const data: LayoutIngestData = {
      id: persistedId ?? uuidv7(),
      url: validated.url,
      normalizedUrl: urlValidation.normalizedUrl ?? validated.url,
      html: sanitizedHtml,
      screenshot,
      computedStyles: ingestResult.computedStyles,
      metadata,
      source,
      crawledAt: ingestResult.ingestedAt.toISOString(),
      savedToDb: saveToDb ? savedToDb : undefined,
      // レスポンシブ解析結果（responsive.enabled: true 時のみ）
      responsiveAnalysis: responsiveAnalysisResult
        ? {
            viewportsAnalyzed: responsiveAnalysisResult.viewportsAnalyzed.map((v) => v.name),
            differences: responsiveAnalysisResult.differences,
            breakpoints: responsiveAnalysisResult.breakpoints,
            screenshots: responsiveAnalysisResult.screenshots,
            analysisTimeMs: responsiveAnalysisResult.analysisTimeMs,
            responsiveAnalysisId,
          }
        : undefined,
    };

    // レスポンスサイズチェックと自動最適化
    let response: LayoutIngestOutput & { _responseSizeWarning?: string; _optimizationInfo?: object } = {
      success: true,
      data,
    };

    const initialResponseSize = JSON.stringify(response).length;
    const sizeThreshold = responseSizeLimit ?? DEFAULT_RESPONSE_SIZE_LIMIT;

    // 開発環境で初期サイズをログ出力
    if (isDevelopment()) {
      logger.debug('[MCP Tool] layout.ingest response size check', {
        initialSize: initialResponseSize,
        threshold: sizeThreshold,
        autoOptimize,
      });
    }

    if (initialResponseSize > sizeThreshold) {
      if (autoOptimize) {
        const originalHtmlLength = data.html?.length ?? 0;
        const hadScreenshot = !!data.screenshot;

        // 段階的な自動最適化
        // 段階1: HTMLの最適化（script/style除去、空白圧縮）
        if (data.html) {
          // まずHTMLを最適化（script/style除去、空白圧縮）
          const optimizedHtml = optimizeHtml(data.html);
          data.html = optimizedHtml;

          // 再計算
          let currentSize = JSON.stringify({ success: true, data }).length;

          // 最適化後もサイズが大きい場合、トランケート
          if (currentSize > sizeThreshold) {
            data.html = truncateHtmlToBytes(
              optimizedHtml,
              AUTO_OPTIMIZE_HTML_MAX_SIZE,
              AUTO_OPTIMIZE_TRUNCATION_MARKER
            );
          }
        }

        // 再計算
        let currentSize = JSON.stringify({ success: true, data }).length;

        // 段階2: スクリーンショット削除
        if (currentSize > sizeThreshold && data.screenshot) {
          data.screenshot = undefined;
          currentSize = JSON.stringify({ success: true, data }).length;
        }

        // 段階3: HTML削除（最終手段）
        if (currentSize > sizeThreshold && data.html) {
          data.html = undefined;
        }

        const finalResponseSize = JSON.stringify({ success: true, data }).length;

        // 最適化情報を追加（開発環境のみ）
        if (isDevelopment()) {
          response._optimizationInfo = {
            originalHtmlLength,
            finalHtmlLength: data.html?.length ?? 0,
            htmlRemoved: data.html === undefined,
            screenshotRemoved: hadScreenshot && !data.screenshot,
            originalSize: initialResponseSize,
            finalSize: finalResponseSize,
            reductionPercent: Math.round((1 - finalResponseSize / initialResponseSize) * 100),
          };

          logger.info('[MCP Tool] layout.ingest auto-optimization applied', {
            originalSize: initialResponseSize,
            finalSize: finalResponseSize,
            reductionPercent: Math.round((1 - finalResponseSize / initialResponseSize) * 100),
            htmlOptimized: originalHtmlLength !== (data.html?.length ?? 0),
            screenshotRemoved: hadScreenshot && !data.screenshot,
          });
        }

        response = { success: true, data, ...(isDevelopment() && response._optimizationInfo ? { _optimizationInfo: response._optimizationInfo } : {}) };
      } else {
        // 警告を追加
        response._responseSizeWarning = `Response size (${initialResponseSize} bytes) exceeds threshold (${sizeThreshold} bytes). Consider using include_html: false, include_screenshot: false, or truncate_html_bytes option.`;
      }
    }

    const finalResponseSize = JSON.stringify(response).length;

    if (isDevelopment()) {
      logger.info('[MCP Tool] layout.ingest completed', {
        id: data.id,
        url: data.url,
        htmlLength: data.html?.length ?? 0,
        hasScreenshot: !!data.screenshot,
        initialResponseSize,
        finalResponseSize,
        optimized: autoOptimize && initialResponseSize > sizeThreshold,
        savedToDb: data.savedToDb ?? false,
      });
    }

    return response;
  } catch (error) {
    // エラーハンドリング
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = determineErrorCode(error instanceof Error ? error : errorMessage);
    const formattedMessage = formatErrorMessage(errorCode, errorMessage);

    if (isDevelopment()) {
      logger.error('[MCP Tool] layout.ingest error', {
        url: validated.url,
        code: errorCode,
        error: errorMessage,
      });
    }

    return {
      success: false,
      error: {
        code: errorCode,
        message: formattedMessage,
        details: isDevelopment() ? { originalError: errorMessage } : undefined,
      },
    };
  }
}

// =============================================
// ツール定義
// =============================================

/**
 * layout.ingest MCPツール定義
 * MCP Protocol用のツール定義オブジェクト
 */
export const layoutIngestToolDefinition = {
  name: 'layout.ingest',
  description:
    'Fetch HTML/screenshot from URL for layout analysis. SSRF protection blocks private IPs/metadata services. HTML is sanitized.',
  annotations: {
    title: 'Layout Ingest',
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'Target URL (https:// or http://)',
        format: 'uri',
      },
      source_type: {
        type: 'string',
        enum: ['award_gallery', 'user_provided'],
        description:
          'Source type: award_gallery or user_provided',
        default: 'user_provided',
      },
      usage_scope: {
        type: 'string',
        enum: ['inspiration_only', 'owned_asset'],
        description:
          'Usage scope: inspiration_only or owned_asset',
        default: 'inspiration_only',
      },
      options: {
        type: 'object',
        description: 'Options',
        properties: {
          full_page: {
            type: 'boolean',
            description: 'Full page screenshot (default: true)',
            default: true,
          },
          viewport: {
            type: 'object',
            description: 'Viewport size',
            properties: {
              width: {
                type: 'number',
                description: 'Width (px) 320-4096',
                minimum: 320,
                maximum: 4096,
              },
              height: {
                type: 'number',
                description: 'Height (px) 240-16384',
                minimum: 240,
                maximum: 16384,
              },
            },
            required: ['width', 'height'],
          },
          wait_for_selector: {
            type: 'string',
            description: 'CSS selector to wait for (page load detection)',
          },
          wait_until: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle'],
            description: 'Page load completion strategy: load (default, fastest), domcontentloaded (faster), networkidle (slowest, for heavy JS sites)',
            default: 'load',
          },
          timeout: {
            type: 'number',
            description: 'Timeout (ms) 1000-120000',
            minimum: 1000,
            maximum: 120000,
            default: 30000,
          },
          disable_javascript: {
            type: 'boolean',
            description: 'Disable JavaScript (default: false)',
            default: false,
          },
          // Response optimization options
          include_html: {
            type: 'boolean',
            description: 'Include HTML in response (default: false for DB-first workflow)',
            default: false,
          },
          include_screenshot: {
            type: 'boolean',
            description: 'Include screenshot in response (default: false for DB-first workflow)',
            default: false,
          },
          truncate_html_bytes: {
            type: 'number',
            description: 'Truncate HTML to specified bytes (100-10000000)',
            minimum: 100,
            maximum: 10000000,
          },
          screenshot_format: {
            type: 'string',
            enum: ['png', 'jpeg'],
            description: 'Screenshot format (default: png)',
            default: 'png',
          },
          screenshot_quality: {
            type: 'number',
            description: 'JPEG quality (1-100, only for jpeg format)',
            minimum: 1,
            maximum: 100,
          },
          screenshot_max_width: {
            type: 'number',
            description: 'Max screenshot width (resize with aspect ratio)',
            minimum: 1,
          },
          screenshot_max_height: {
            type: 'number',
            description: 'Max screenshot height (resize with aspect ratio)',
            minimum: 1,
          },
          auto_optimize: {
            type: 'boolean',
            description: 'Auto-optimize response if exceeds size limit: removes script/style tags, compresses whitespace, then removes screenshot/HTML as needed (default: false)',
            default: false,
          },
          response_size_limit: {
            type: 'number',
            description: 'Response size threshold in bytes for auto_optimize (default: 1000000 = 1MB)',
            minimum: 10000,
            maximum: 50000000,
            default: 1000000,
          },
          save_to_db: {
            type: 'boolean',
            description: 'Save to WebPage table for later use with motion.detect pageId mode (default: false)',
            default: false,
          },
          auto_analyze: {
            type: 'boolean',
            description: 'Auto-analyze HTML and save SectionPattern with embeddings when save_to_db is true (default: false)',
            default: false,
          },
          include_computed_styles: {
            type: 'boolean',
            description: 'Include computed styles for section elements (getComputedStyle). Useful for accurate design reproduction. (default: false, for performance)',
            default: false,
          },
          // External CSS fetching options
          fetch_external_css: {
            type: 'boolean',
            description: 'Fetch external CSS files content from <link rel="stylesheet"> tags (default: true)',
            default: true,
          },
          external_css_timeout: {
            type: 'number',
            description: 'Timeout for fetching each external CSS file (ms) 1000-30000 (default: 5000)',
            minimum: 1000,
            maximum: 30000,
            default: 5000,
          },
          external_css_max_size: {
            type: 'number',
            description: 'Maximum size per external CSS file (bytes) 1024-10485760 (default: 5MB)',
            minimum: 1024,
            maximum: 10485760,
            default: 5242880,
          },
          external_css_max_concurrent: {
            type: 'number',
            description: 'Maximum concurrent external CSS fetches 1-10 (default: 5)',
            minimum: 1,
            maximum: 10,
            default: 5,
          },
          external_css_max_files: {
            type: 'number',
            description: 'Maximum number of external CSS files to fetch 1-50 (default: 20)',
            minimum: 1,
            maximum: 50,
            default: 20,
          },
          // WebGL/3D site handling options
          disable_webgl: {
            type: 'boolean',
            description: 'Disable WebGL completely. Use for heavy 3D sites (Three.js, WebGL) that cause timeouts. When true, launches a dedicated browser instance with WebGL disabled.',
            default: false,
          },
          force_kill_on_timeout: {
            type: 'boolean',
            description: 'Force kill browser process on timeout. Use as last resort when WebGL sites hang. Sends SIGKILL to the browser process.',
            default: false,
          },
          // Responsive analysis options
          responsive: {
            type: 'object',
            description: 'Responsive layout analysis options. Captures layouts at multiple viewport sizes and detects differences.',
            properties: {
              enabled: {
                type: 'boolean',
                description: 'Enable responsive analysis (default: false)',
                default: false,
              },
              viewports: {
                type: 'array',
                description: 'Custom viewport configurations. Default: desktop (1920x1080), tablet (768x1024), mobile (375x667)',
                items: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      description: 'Viewport name (e.g., desktop, tablet, mobile)',
                    },
                    width: {
                      type: 'number',
                      description: 'Width in pixels (320-4096)',
                      minimum: 320,
                      maximum: 4096,
                    },
                    height: {
                      type: 'number',
                      description: 'Height in pixels (240-16384)',
                      minimum: 240,
                      maximum: 16384,
                    },
                  },
                  required: ['name', 'width', 'height'],
                },
              },
              include_screenshots: {
                type: 'boolean',
                description: 'Include screenshots for each viewport (default: true)',
                default: true,
              },
              include_diff_images: {
                type: 'boolean',
                description: 'Include diff images in viewport comparison results (default: false)',
                default: false,
              },
              diff_threshold: {
                type: 'number',
                description: 'Pixel diff threshold for viewport comparison (0-1, default: 0.1)',
                minimum: 0,
                maximum: 1,
                default: 0.1,
              },
              save_to_db: {
                type: 'boolean',
                description: 'Save responsive analysis results to DB (default: true, requires save_to_db at top level)',
                default: true,
              },
              detect_navigation: {
                type: 'boolean',
                description: 'Detect navigation pattern changes (horizontal-menu to hamburger-menu, etc.) (default: true)',
                default: true,
              },
              detect_visibility: {
                type: 'boolean',
                description: 'Detect element visibility changes between viewports (default: true)',
                default: true,
              },
              detect_layout: {
                type: 'boolean',
                description: 'Detect layout structure changes (grid columns, flex direction, etc.) (default: true)',
                default: true,
              },
            },
          },
        },
      },
    },
    required: ['url'],
  },
};

// =============================================
// 開発環境ログ
// =============================================

if (isDevelopment()) {
  logger.debug('[layout.ingest] Tool module loaded');
}
