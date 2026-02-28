// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageIngestAdapter
 * Playwrightを直接使用してWebページをインジェストするサービス
 *
 * Crawler依存を排除し、MCP Server内で完結するPlaywright統合
 *
 * @module services/page-ingest-adapter
 */

import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import { logger, isDevelopment } from '../utils/logger';
import { GPU_BROWSER_BASE_ARGS } from '../utils/gpu-browser-args';
import { BrowserProcessManager } from './browser-process-manager';
import { isUrlAllowedByRobotsTxt, ROBOTS_TXT } from '@reftrix/core';
import { McpError, ErrorCode } from '../utils/errors';

// =============================================
// 型定義
// =============================================

/**
 * ビューポート設定
 */
export interface IngestViewport {
  width: number;
  height: number;
}

/**
 * WebGL検出結果
 */
export interface WebGLDetectionResult {
  /** WebGLが検出されたか */
  detected: boolean;
  /** 検出されたCanvas要素の数 */
  canvasCount: number;
  /** WebGL 1.0コンテキスト数 */
  webgl1Count: number;
  /** WebGL 2.0コンテキスト数 */
  webgl2Count: number;
  /** Three.js検出 */
  threeJsDetected: boolean;
  /** 検出にかかった時間(ms) */
  detectionTimeMs: number;
}

/**
 * WebGL待機結果
 */
export interface WebGLWaitResult {
  /** 安定化に成功したか */
  stable: boolean;
  /** 待機時間(ms) */
  waitTimeMs: number;
  /** フレームレートが安定したか */
  frameRateStable: boolean;
  /** 最終フレームレート(fps) */
  lastFrameRate?: number;
  /** 理由 */
  reason: 'stable' | 'timeout' | 'no_webgl' | 'error';
}

/**
 * インジェストオプション
 */
export interface IngestAdapterOptions {
  /** フルページキャプチャ */
  fullPage?: boolean;
  /** ビューポート設定 */
  viewport?: IngestViewport;
  /** 待機セレクター */
  waitForSelector?: string;
  /** タイムアウト（ms） */
  timeout?: number;
  /** JavaScript無効化 */
  disableJavaScript?: boolean;
  /** ページ読み込み完了判定（デフォルト: 'load'） */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  /** DOM安定化待機（React/Vue/Next.js対応） */
  waitForDomStable?: boolean;
  /** DOM安定化判定の無変更時間（ms）（デフォルト: 500） */
  domStableTimeout?: number;
  /** ローディング完了後の追加待機時間（ms） */
  waitForTimeout?: number;
  /** 非表示待機セレクター（ローディング要素など） */
  waitForSelectorHidden?: string;
  /** コンテンツ表示待機セレクター（実際のコンテンツが表示されるまで待機） */
  waitForContentVisible?: string;
  /** ユーザーインタラクション模倣（マウス移動でローディング解除するサイト対応） */
  simulateUserInteraction?: boolean;
  /** スクリーンショットをスキップ */
  skipScreenshot?: boolean;
  /** Computed Styles取得（デフォルトfalse、パフォーマンス考慮） */
  includeComputedStyles?: boolean;
  /** ソースタイプ */
  sourceType?: 'award_gallery' | 'user_provided';
  /** 利用範囲 */
  usageScope?: 'inspiration_only' | 'owned_asset';
  /** スクリーンショットオプション */
  screenshotOptions?: {
    format?: 'png' | 'jpeg';
    quality?: number;
  };
  /**
   * WebGL/3Dサイトの自動検出と適応的待機
   * Canvas要素とWebGLコンテキストを検出し、フレームレート安定化を待機
   * @default true
   */
  adaptiveWebGLWait?: boolean;
  /**
   * WebGL検出時の追加待機時間（ms）
   * requestAnimationFrame同期後に追加で待機する時間
   * @default 5000
   */
  webglExtraWaitMs?: number;
  /**
   * WebGLを完全に無効化
   * 重い3Dサイト（Three.js、WebGL等）でタイムアウトが発生する場合に使用
   * true設定時: 専用ブラウザインスタンスを起動し、WebGL関連機能を無効化
   * @default false
   */
  disableWebGL?: boolean;
  /**
   * タイムアウト時にブラウザプロセスを強制終了
   * WebGLサイトでハングした場合の最終手段として使用
   * @default false
   */
  forceKillOnTimeout?: boolean;
  /**
   * GPU有効化モード（WebGL重サイト向け）
   * --use-angle=gl, --enable-gpu-rasterization, --ignore-gpu-blocklist を設定
   * WebGL重サイト（Linear、Vercel、Notion等）のレンダリングパフォーマンス向上に使用
   * disableWebGL: trueと同時指定された場合はdisableWebGLが優先される
   * @default false
   */
  enableGPU?: boolean;
  /**
   * WebGL待機モード（Phase1-2）
   * Canvas要素の出現を待機し、WebGL初期化完了まで追加待機
   * networkidleが永遠に完了しないWebGLサイト向けの最適化
   * enableGPU: trueと組み合わせて使用推奨
   * @default false
   */
  waitForWebGL?: boolean;
  /**
   * WebGL待機時間（ミリ秒）
   * waitForWebGL: true時のCanvas検出後の追加待機時間
   * @default 3000
   */
  webglWaitMs?: number;
  /**
   * robots.txtを尊重するかどうか（RFC 9309）
   * true: クロール前にrobots.txtを確認し、拒否された場合はエラー
   * false: robots.txtを無視してクロール
   * undefined: 環境変数REFTRIX_RESPECT_ROBOTS_TXTの設定に従う（デフォルト有効）
   */
  respectRobotsTxt?: boolean;
}

/**
 * ソース情報
 */
export interface IngestSourceInfo {
  type: 'award_gallery' | 'user_provided';
  usageScope: 'inspiration_only' | 'owned_asset';
  awardSite?: 'cssda' | 'fwa' | 'awwwards';
}

/**
 * ページメタデータ
 */
export interface IngestPageMetadata {
  title: string;
  description?: string | undefined;
  ogImage?: string | undefined;
  favicon?: string | undefined;
  lang?: string | undefined;
  canonical?: string | undefined;
  keywords?: string[] | undefined;
}

/**
 * ビューポート情報
 */
export interface IngestViewportInfo {
  documentWidth: number;
  documentHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollHeight: number;
}

/**
 * スクリーンショット結果
 */
export interface IngestScreenshotResult {
  viewportName: string;
  viewport: IngestViewport;
  data: string;
  format: 'png' | 'jpeg';
  fullPage: boolean;
  size: number;
}

/**
 * 要素のComputed Styles
 * 取得するCSSプロパティのセット
 */
export interface ElementComputedStyles {
  // 背景
  backgroundColor: string;
  backgroundImage: string;
  // テキスト
  color: string;
  fontSize: string;
  fontFamily: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  textAlign: string;
  textDecoration: string;
  textTransform: string;
  // レイアウト
  display: string;
  position: string;
  flexDirection: string;
  justifyContent: string;
  alignItems: string;
  padding: string;
  paddingTop: string;
  paddingRight: string;
  paddingBottom: string;
  paddingLeft: string;
  margin: string;
  marginTop: string;
  marginRight: string;
  marginBottom: string;
  marginLeft: string;
  gap: string;
  width: string;
  height: string;
  maxWidth: string;
  minHeight: string;
  // 視覚効果
  border: string;
  borderRadius: string;
  boxShadow: string;
  backdropFilter: string;
  opacity: string;
  overflow: string;
  // トランジション・アニメーション
  transition: string;
  transform: string;
}

/**
 * 子要素のComputed Styles情報
 */
export interface ChildElementStyleInfo {
  /** CSSセレクタ（ユニーク識別用） */
  selector: string;
  /** HTML要素タグ名 */
  tagName: string;
  /** class属性値 */
  className: string;
  /** 親セクションからの相対パス */
  path: string;
  /** 要素のテキストコンテンツ（ボタンやリンクの場合） */
  textContent?: string;
  /** Computed Styles */
  styles: ElementComputedStyles;
}

/**
 * Computed Styles for a section element
 * ブラウザがレンダリングした実際のスタイル値
 */
export interface ComputedStyleInfo {
  /** セクションのインデックス */
  index: number;
  /** HTML要素タグ名 */
  tagName: string;
  /** class属性値 */
  className: string;
  /** id属性値 */
  id: string;
  /** role属性値 */
  role: string;
  /** セクション自体のComputed Styles */
  styles: ElementComputedStyles;
  /** セクション内の子要素のスタイル（重要な要素のみ） */
  children?: ChildElementStyleInfo[];
}

/**
 * インジェスト警告
 */
export interface IngestWarning {
  code: string;
  message: string;
}

/**
 * インジェスト結果
 */
export interface IngestResult {
  success: boolean;
  error?: string;
  url: string;
  finalUrl: string;
  html: string;
  htmlSize: number;
  screenshots?: IngestScreenshotResult[];
  /** セクション要素のComputed Styles（include_computed_styles: true時のみ） */
  computedStyles?: ComputedStyleInfo[];
  viewportInfo: IngestViewportInfo;
  metadata: IngestPageMetadata;
  ingestedAt: Date;
  source: IngestSourceInfo;
  /** WebGL検出結果（adaptiveWebGLWait=true時のみ） */
  webglDetection?: WebGLDetectionResult;
  /** WebGL待機結果（WebGL検出時のみ） */
  webglWait?: WebGLWaitResult;
  /** 警告（Graceful Degradation時など） */
  warnings?: IngestWarning[];
}

// =============================================
// DNS リトライ定数・関数
// =============================================

/**
 * DNS関連エラーのリトライ設定
 *
 * ローカルDNSリゾルバ（systemd-resolved等）が断続的にEAI_AGAINを返す
 * 環境に対応するため、DNS解決エラー時のみリトライを行う。
 */
export const DNS_RETRY_CONFIG = {
  /** 最大リトライ回数 */
  MAX_RETRIES: 3,
  /** 基本遅延（ms） - exponential backoffの基本値 */
  BASE_DELAY_MS: 5000,
  /** 最大遅延（ms） - exponential backoffの上限 */
  MAX_DELAY_MS: 20000,
} as const;

/**
 * リトライ可能なDNS関連エラーパターン
 *
 * NXDOMAINは永続的なエラー（ドメインが存在しない）のためリトライ対象外。
 * 一時的なDNSリゾルバ障害のみリトライする。
 */
const DNS_ERROR_PATTERNS = [
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NAME_RESOLUTION_FAILED',
  'EAI_AGAIN',
  'ENOTFOUND',
] as const;

/**
 * エラーがリトライ可能なDNS関連エラーかどうかを判定する
 *
 * NXDOMAINは永続的エラー（ドメインが存在しない）のため対象外。
 * 一時的なDNSリゾルバ障害（EAI_AGAIN, ERR_NAME_NOT_RESOLVED等）のみリトライ。
 *
 * @param error - 判定するエラー
 * @returns DNS関連の一時的エラーであればtrue
 */
export function isDnsRelatedError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }

  const message = error instanceof Error ? error.message : '';
  if (!message) {
    return false;
  }

  return DNS_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * リトライ遅延を計算する（exponential backoff）
 *
 * @param attempt - リトライ試行番号（0-indexed）
 * @returns 遅延時間（ms）
 */
export function calculateRetryDelay(attempt: number): number {
  const delay = DNS_RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, DNS_RETRY_CONFIG.MAX_DELAY_MS);
}

// =============================================
// 定数
// =============================================

/**
 * デフォルトタイムアウト（ms）
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * デフォルトビューポート
 */
const DEFAULT_VIEWPORT: IngestViewport = {
  width: 1920,
  height: 1080,
};

/**
 * WebGL関連定数
 */
const WEBGL_CONSTANTS = {
  /** デフォルトの追加待機時間（ms） */
  DEFAULT_EXTRA_WAIT_MS: 5000,
  /** フレームレート安定化の最大待機時間（ms） */
  MAX_FRAME_RATE_WAIT_MS: 10000,
  /** 安定判定に必要な連続安定フレーム数 */
  STABLE_FRAME_COUNT: 3,
  /** 最小許容フレームレート（fps） */
  MIN_STABLE_FPS: 20,
  /** 最大許容フレームレート（fps） */
  MAX_STABLE_FPS: 120,
  /** フレーム間隔の許容変動率（±50%） */
  FRAME_INTERVAL_TOLERANCE: 0.5,
  /** waitForWebGLモードのCanvas検出タイムアウト（ms） */
  CANVAS_WAIT_TIMEOUT_MS: 10000,
  /** waitForWebGLモードのデフォルト待機時間（ms） */
  DEFAULT_WEBGL_WAIT_MS: 3000,
} as const;

/**
 * 操作レベルタイムアウト定数（WebGLサイト用）
 */
const OPERATION_TIMEOUTS = {
  /** page.content()のタイムアウト（ms） */
  CONTENT_EXTRACTION: 30000,
  /** metadata抽出のタイムアウト（ms） */
  METADATA_EXTRACTION: 15000,
  /** viewport情報取得のタイムアウト（ms） */
  VIEWPORT_INFO: 10000,
  /** WebGLサイト用のタイムアウト乗数（通常の2倍） */
  WEBGL_MULTIPLIER: 2,
} as const;

// =============================================
// ヘルパー関数
// =============================================

/**
 * Promiseにタイムアウトを追加
 * WebGLサイトなど重い処理がハングする場合の保護
 *
 * @param promise - 実行するPromise
 * @param timeoutMs - タイムアウト時間（ms）
 * @param operationName - 操作名（エラーメッセージ用）
 * @returns Promise結果またはタイムアウトエラー
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
// PageIngestAdapter クラス
// =============================================

/**
 * ページインジェストアダプター
 *
 * Playwrightを使用してWebページをキャプチャする
 *
 * @example
 * ```typescript
 * const result = await pageIngestAdapter.ingest({
 *   url: 'https://example.com',
 *   fullPage: true,
 *   timeout: 30000,
 * });
 * ```
 */
class PageIngestAdapter {
  private browser: Browser | null = null;

  /**
   * ローディング要素の完全非表示を待機（CSS opacity/visibility対応）
   *
   * Playwrightの`state: 'hidden'`はCSSアニメーション（opacity変化）を検知しないため、
   * JavaScript でcomputed styleを直接チェックする
   *
   * @param page - Playwrightページ
   * @param selector - ローディング要素のセレクター（カンマ区切り複数可）
   * @param timeout - 最大待機時間（ms）
   */
  private async waitForLoadingElementHidden(
    page: Page,
    selector: string,
    timeout: number = 30000
  ): Promise<{ hidden: boolean; waitTime: number; reason: string }> {
    const startTime = Date.now();

    // セレクターを分割（カンマ区切り対応）
    const selectors = selector.split(',').map(s => s.trim()).filter(Boolean);

    const result = await page.evaluate(
      `(async function() {
        var startTime = Date.now();
        var timeout = ${timeout};
        var selectors = ${JSON.stringify(selectors)};
        var checkInterval = 100; // 100ms間隔でチェック

        function isElementHidden(el) {
          if (!el) return true;

          var style = window.getComputedStyle(el);

          // display: none
          if (style.display === 'none') return true;

          // visibility: hidden
          if (style.visibility === 'hidden') return true;

          // opacity: 0 (またはほぼ0)
          var opacity = parseFloat(style.opacity);
          if (opacity < 0.01) return true;

          // サイズが0
          var rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return true;

          // pointer-events: none かつ opacity < 0.1 はフェードアウト中とみなす
          if (style.pointerEvents === 'none' && opacity < 0.1) return true;

          return false;
        }

        function checkAllHidden() {
          for (var i = 0; i < selectors.length; i++) {
            var elements = document.querySelectorAll(selectors[i]);
            for (var j = 0; j < elements.length; j++) {
              if (!isElementHidden(elements[j])) {
                return false; // まだ可視の要素がある
              }
            }
          }
          return true; // すべて非表示（または要素なし）
        }

        return new Promise(function(resolve) {
          // 初回チェック
          if (checkAllHidden()) {
            resolve({
              hidden: true,
              waitTime: Date.now() - startTime,
              reason: 'already_hidden'
            });
            return;
          }

          // ポーリングでチェック
          var intervalId = setInterval(function() {
            if (checkAllHidden()) {
              clearInterval(intervalId);
              resolve({
                hidden: true,
                waitTime: Date.now() - startTime,
                reason: 'became_hidden'
              });
              return;
            }

            if (Date.now() - startTime >= timeout) {
              clearInterval(intervalId);
              resolve({
                hidden: false,
                waitTime: Date.now() - startTime,
                reason: 'timeout'
              });
            }
          }, checkInterval);
        });
      })()`
    );

    const typedResult = result as { hidden: boolean; waitTime: number; reason: string };

    if (isDevelopment()) {
      logger.debug('[PageIngestAdapter] Loading element visibility check', {
        hidden: typedResult.hidden,
        waitTime: typedResult.waitTime,
        reason: typedResult.reason,
        elapsedTotal: Date.now() - startTime,
      });
    }

    return typedResult;
  }

  /**
   * DOM安定化を待機（React/Vue/Next.js ハイドレーション対応）
   *
   * MutationObserverを使用してDOMの変更を監視し、
   * 指定時間内に変更がなくなったら安定したと判断
   *
   * @param page - Playwrightページ
   * @param stableTimeout - 安定判定の無変更時間（ms）
   * @param maxWait - 最大待機時間（ms）
   */
  private async waitForDomStable(
    page: Page,
    stableTimeout: number = 500,
    maxWait: number = 10000
  ): Promise<{ stable: boolean; mutations: number; waitTime: number }> {
    if (isDevelopment()) {
      logger.debug('[PageIngestAdapter] Waiting for DOM to stabilize...', {
        stableTimeout,
        maxWait,
      });
    }

    const result = await page.evaluate(
      `(async function() {
        const stableTimeout = ${stableTimeout};
        const maxWait = ${maxWait};
        const startTime = Date.now();
        let mutationCount = 0;
        let lastMutationTime = Date.now();

        return new Promise((resolve) => {
          // 最大待機タイムアウト
          const maxWaitTimer = setTimeout(() => {
            observer.disconnect();
            resolve({
              stable: false,
              mutations: mutationCount,
              waitTime: Date.now() - startTime,
              reason: 'max_wait_exceeded'
            });
          }, maxWait);

          // 安定化チェック用インターバル
          const checkInterval = setInterval(() => {
            const timeSinceLastMutation = Date.now() - lastMutationTime;
            if (timeSinceLastMutation >= stableTimeout) {
              clearInterval(checkInterval);
              clearTimeout(maxWaitTimer);
              observer.disconnect();
              resolve({
                stable: true,
                mutations: mutationCount,
                waitTime: Date.now() - startTime,
                reason: 'dom_stable'
              });
            }
          }, 100);

          // MutationObserver設定
          const observer = new MutationObserver((mutations) => {
            // 重要な変更のみカウント（テキストノードの軽微な変更を除外）
            const significantMutations = mutations.filter(m => {
              // 追加・削除されたノードがある
              if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
                // スクリプトタグやスタイルタグは除外
                for (const node of m.addedNodes) {
                  if (node.nodeType === 1) {
                    const el = node;
                    if (el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE') {
                      return true;
                    }
                  }
                }
                for (const node of m.removedNodes) {
                  if (node.nodeType === 1) {
                    const el = node;
                    if (el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE') {
                      return true;
                    }
                  }
                }
                return false;
              }
              // 属性変更（class, style等）
              if (m.type === 'attributes') {
                return true;
              }
              return false;
            });

            if (significantMutations.length > 0) {
              mutationCount += significantMutations.length;
              lastMutationTime = Date.now();
            }
          });

          observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'data-loaded', 'data-hydrated'],
          });
        });
      })()`
    );

    const typedResult = result as {
      stable: boolean;
      mutations: number;
      waitTime: number;
      reason?: string;
    };

    if (isDevelopment()) {
      logger.info('[PageIngestAdapter] DOM stability check completed', {
        stable: typedResult.stable,
        mutations: typedResult.mutations,
        waitTime: typedResult.waitTime,
        reason: typedResult.reason,
      });
    }

    return typedResult;
  }

  /**
   * WebGL/Canvas要素を検出
   *
   * Canvas要素とWebGLコンテキストの存在を確認し、
   * Three.js等の3Dライブラリの検出も行う
   *
   * @param page - Playwrightページ
   * @returns WebGL検出結果
   */
  private async detectWebGL(page: Page): Promise<WebGLDetectionResult> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.debug('[PageIngestAdapter] Detecting WebGL/Canvas elements...');
    }

    const result = await page.evaluate(`
      (function() {
        var canvases = document.querySelectorAll('canvas');
        var webgl1Count = 0;
        var webgl2Count = 0;

        // 各Canvasに対してWebGLコンテキストをチェック
        for (var i = 0; i < canvases.length; i++) {
          var canvas = canvases[i];
          try {
            // WebGL2をまず試行
            var gl2 = canvas.getContext('webgl2');
            if (gl2) {
              webgl2Count++;
              continue;
            }
            // WebGL1を試行
            var gl1 = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            if (gl1) {
              webgl1Count++;
            }
          } catch (e) {
            // コンテキスト取得エラーは無視
          }
        }

        // Three.js検出
        var threeJsDetected = !!(
          window.THREE ||
          window.__THREE__ ||
          window.__THREE_DEVTOOLS__ ||
          document.querySelector('[data-three]') ||
          document.querySelector('[data-engine*="three"]')
        );

        // R3F (React Three Fiber) 検出
        if (!threeJsDetected) {
          threeJsDetected = !!(
            document.querySelector('[class*="r3f"]') ||
            document.querySelector('[data-r3f]')
          );
        }

        return {
          detected: canvases.length > 0 && (webgl1Count > 0 || webgl2Count > 0),
          canvasCount: canvases.length,
          webgl1Count: webgl1Count,
          webgl2Count: webgl2Count,
          threeJsDetected: threeJsDetected
        };
      })()
    `);

    const typedResult = result as Omit<WebGLDetectionResult, 'detectionTimeMs'>;
    const detectionTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[PageIngestAdapter] WebGL detection completed', {
        ...typedResult,
        detectionTimeMs,
      });
    }

    return {
      ...typedResult,
      detectionTimeMs,
    };
  }

  /**
   * requestAnimationFrameでフレームレート安定化を待機
   *
   * WebGLサイトの初期化完了を判定するため、
   * 3フレーム連続で安定したフレームレート（20-120fps）になるまで待機
   *
   * @param page - Playwrightページ
   * @param maxWaitMs - 最大待機時間（ms）
   * @returns WebGL待機結果
   */
  private async waitForStableFrameRate(
    page: Page,
    maxWaitMs: number = WEBGL_CONSTANTS.MAX_FRAME_RATE_WAIT_MS
  ): Promise<WebGLWaitResult> {
    const startTime = Date.now();

    if (isDevelopment()) {
      logger.debug('[PageIngestAdapter] Waiting for stable frame rate...', {
        maxWaitMs,
      });
    }

    try {
      const result = await page.evaluate(
        `(async function() {
          var maxWait = ${maxWaitMs};
          var startTime = performance.now();
          var stableFrameCount = ${WEBGL_CONSTANTS.STABLE_FRAME_COUNT};
          var minFps = ${WEBGL_CONSTANTS.MIN_STABLE_FPS};
          var maxFps = ${WEBGL_CONSTANTS.MAX_STABLE_FPS};
          var tolerance = ${WEBGL_CONSTANTS.FRAME_INTERVAL_TOLERANCE};

          // フレーム間隔の期待値（60fps基準: 16.67ms）
          var expectedInterval = 1000 / 60;
          var minInterval = 1000 / maxFps;  // 8.33ms (120fps)
          var maxInterval = 1000 / minFps;  // 50ms (20fps)

          return new Promise(function(resolve) {
            var frameCount = 0;
            var lastTime = performance.now();
            var stableFrames = 0;
            var lastFps = 0;
            var rafId = null;

            function checkFrame(currentTime) {
              var now = currentTime || performance.now();
              var delta = now - lastTime;
              lastTime = now;
              frameCount++;

              // 初回フレームはスキップ
              if (frameCount === 1) {
                rafId = requestAnimationFrame(checkFrame);
                return;
              }

              // フレームレートを計算
              var currentFps = delta > 0 ? 1000 / delta : 0;
              lastFps = currentFps;

              // 安定判定: フレーム間隔が許容範囲内か
              var isStable = delta >= minInterval && delta <= maxInterval;

              // さらに厳密に: 前回との変動率をチェック
              if (frameCount > 2 && isStable) {
                isStable = true;
              }

              if (isStable) {
                stableFrames++;
              } else {
                stableFrames = 0;
              }

              // 安定判定達成
              if (stableFrames >= stableFrameCount) {
                cancelAnimationFrame(rafId);
                resolve({
                  stable: true,
                  waitTimeMs: Math.round(now - startTime),
                  frameRateStable: true,
                  lastFrameRate: Math.round(lastFps),
                  reason: 'stable'
                });
                return;
              }

              // タイムアウトチェック
              if (now - startTime >= maxWait) {
                cancelAnimationFrame(rafId);
                resolve({
                  stable: false,
                  waitTimeMs: Math.round(now - startTime),
                  frameRateStable: false,
                  lastFrameRate: Math.round(lastFps),
                  reason: 'timeout'
                });
                return;
              }

              rafId = requestAnimationFrame(checkFrame);
            }

            rafId = requestAnimationFrame(checkFrame);
          });
        })()`
      );

      const typedResult = result as WebGLWaitResult;

      if (isDevelopment()) {
        logger.info('[PageIngestAdapter] Frame rate stabilization check completed', {
          ...typedResult,
          totalElapsed: Date.now() - startTime,
        });
      }

      return typedResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (isDevelopment()) {
        logger.warn('[PageIngestAdapter] Frame rate check failed', {
          error: errorMessage,
          elapsed: Date.now() - startTime,
        });
      }

      return {
        stable: false,
        waitTimeMs: Date.now() - startTime,
        frameRateStable: false,
        reason: 'error',
      };
    }
  }

  /**
   * WebGL初期化完了を待機（適応的待機戦略）
   *
   * 1. WebGL/Canvas検出
   * 2. 検出時: requestAnimationFrame同期で安定化待機
   * 3. 必要に応じてnetworkidleにフォールバック
   * 4. 追加の固定待機時間
   *
   * @param page - Playwrightページ
   * @param options - インジェストオプション
   * @param warnings - 警告配列（Graceful Degradation時に追加）
   * @returns WebGL検出・待機結果
   */
  private async waitForWebGLReady(
    page: Page,
    options: IngestAdapterOptions,
    warnings: IngestWarning[]
  ): Promise<{
    detection: WebGLDetectionResult;
    wait?: WebGLWaitResult;
  }> {
    // Step 1: WebGL検出
    const detection = await this.detectWebGL(page);

    // WebGL未検出の場合は早期リターン
    if (!detection.detected) {
      if (isDevelopment()) {
        logger.debug('[PageIngestAdapter] No WebGL detected, skipping adaptive wait');
      }
      return { detection };
    }

    // Step 2: フレームレート安定化待機
    const maxWaitMs = Math.min(
      WEBGL_CONSTANTS.MAX_FRAME_RATE_WAIT_MS,
      (options.timeout ?? DEFAULT_TIMEOUT) / 3
    );

    const waitResult = await this.waitForStableFrameRate(page, maxWaitMs);

    // Step 3: Graceful Degradation - 安定化失敗時は警告を追加
    if (!waitResult.stable) {
      warnings.push({
        code: 'WEBGL_FRAME_RATE_UNSTABLE',
        message: `WebGL frame rate not stabilized after ${waitResult.waitTimeMs}ms, continuing with current state`,
      });

      if (isDevelopment()) {
        logger.warn('[PageIngestAdapter] WebGL frame rate not stabilized, continuing with current state', {
          waitResult,
        });
      }
    }

    // Step 4: 追加の固定待機時間
    const extraWaitMs = options.webglExtraWaitMs ?? WEBGL_CONSTANTS.DEFAULT_EXTRA_WAIT_MS;
    if (extraWaitMs > 0) {
      if (isDevelopment()) {
        logger.debug('[PageIngestAdapter] Additional WebGL wait', { extraWaitMs });
      }
      await page.waitForTimeout(extraWaitMs);
    }

    return { detection, wait: waitResult };
  }

  /**
   * 共有ブラウザインスタンスを取得（Worker pipeline用）
   * PageIngestAdapterが管理するシングルトンブラウザを外部サービスと共有し、
   * Chromiumプロセス数を削減する（4→1）
   */
  public async getSharedBrowser(): Promise<Browser> {
    return this.getBrowser();
  }

  /**
   * ブラウザを起動（遅延初期化）
   *
   * v0.1.0改善:
   * - ブラウザが閉じられている場合を検出し、自動的に再起動
   * - isConnected()チェックで陳腐化した参照を検出
   *
   * v0.1.0セキュリティ改善:
   * - --no-sandboxを削除（セキュリティリスク軽減）
   * - --gpu-sandbox-start-earlyを追加（GPUプロセスのサンドボックス強化）
   */
  private async getBrowser(): Promise<Browser> {
    // ブラウザが存在するが閉じられている場合は参照をクリア
    if (this.browser && !this.browser.isConnected()) {
      if (isDevelopment()) {
        logger.warn('[PageIngestAdapter] Browser disconnected, will re-launch...');
      }
      this.browser = null;
    }

    if (!this.browser) {
      if (isDevelopment()) {
        logger.info('[PageIngestAdapter] Launching Chromium browser...');
      }
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--disable-setuid-sandbox',
          // セキュリティ強化: --no-sandboxを削除し、GPUサンドボックスを早期起動
          '--gpu-sandbox-start-early',
        ],
      });
    }
    return this.browser;
  }

  /**
   * GPU有効化ブラウザを起動（専用インスタンス、共有しない）
   * WebGL重サイト（Linear、Vercel、Notion等）のレンダリングパフォーマンス向上のため使用
   * --use-angle=glでOpenGL ESバックエンドを使用し、GPUアクセラレーションを有効化
   * このブラウザは使用後に必ず閉じる必要がある
   *
   * Phase1-1: GPU有効化オプション追加
   */
  private async launchGPUEnabledBrowser(): Promise<Browser> {
    if (isDevelopment()) {
      logger.info('[PageIngestAdapter] Launching GPU-enabled Chromium browser...');
    }
    return chromium.launch({
      headless: true,
      args: [...GPU_BROWSER_BASE_ARGS],
    });
  }

  /**
   * WebGL無効化ブラウザを起動（専用インスタンス、共有しない）
   * 重い3Dサイトでハングを防止するため、WebGL関連機能を完全に無効化
   * このブラウザは使用後に必ず閉じる必要がある
   */
  private async launchWebGLDisabledBrowser(): Promise<Browser> {
    if (isDevelopment()) {
      logger.info('[PageIngestAdapter] Launching WebGL-disabled Chromium browser...');
    }
    return chromium.launch({
      headless: true,
      args: [
        // 標準のセキュリティ/パフォーマンス設定
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        // セキュリティ強化: --no-sandboxを削除し、GPUサンドボックスを早期起動
        '--gpu-sandbox-start-early',
        // WebGL/3D関連を完全に無効化
        '--disable-webgl',
        '--disable-webgl2',
        '--disable-3d-apis',
        '--disable-software-rasterizer',
        '--disable-accelerated-2d-canvas',
        '--disable-accelerated-video-decode',
        // 追加のパフォーマンス最適化
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        // タイムアウト強制用
        '--disable-hang-monitor',
      ],
    });
  }

  /**
   * ページからメタデータを抽出
   */
  private async extractMetadata(page: Page): Promise<IngestPageMetadata> {
    // page.evaluate内でTypeScriptヘルパー関数(__name)が使用されないよう、
    // シンプルな構造で記述
    const result = await page.evaluate(`
      (function() {
        function getMetaContent(name) {
          var el = document.querySelector('meta[name="' + name + '"]') ||
                   document.querySelector('meta[property="' + name + '"]');
          return el ? el.getAttribute('content') : undefined;
        }

        function getFavicon() {
          var link = document.querySelector('link[rel="icon"]') ||
                     document.querySelector('link[rel="shortcut icon"]');
          return link ? link.getAttribute('href') : undefined;
        }

        var canonicalEl = document.querySelector('link[rel="canonical"]');
        var keywordsStr = getMetaContent('keywords');

        return {
          title: document.title || '',
          description: getMetaContent('description') || getMetaContent('og:description'),
          ogImage: getMetaContent('og:image'),
          favicon: getFavicon(),
          lang: document.documentElement.lang || undefined,
          canonical: canonicalEl ? canonicalEl.getAttribute('href') : undefined,
          keywords: keywordsStr ? keywordsStr.split(',').map(function(k) { return k.trim(); }) : undefined,
        };
      })()
    `);
    return result as IngestPageMetadata;
  }

  /**
   * ビューポート情報を取得
   */
  private async getViewportInfo(
    page: Page,
    viewport: IngestViewport
  ): Promise<IngestViewportInfo> {
    // page.evaluate内でTypeScriptヘルパー関数(__name)が使用されないよう、
    // 文字列形式で記述し、パラメータは別途渡す
    const result = await page.evaluate(`
      (function() {
        return {
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          viewportWidth: ${viewport.width},
          viewportHeight: ${viewport.height},
          scrollHeight: document.body ? document.body.scrollHeight : 0,
        };
      })()
    `);
    return result as IngestViewportInfo;
  }

  /**
   * セクション要素とその子要素のComputed Stylesを抽出
   *
   * ブラウザがレンダリングした実際のスタイル値を取得し、
   * デザインの正確な再現を可能にする
   *
   * 取得する子要素:
   * - 見出し: h1-h6
   * - ボタン: button, a.btn, [role="button"]
   * - リンク: a（主要なもの）
   * - 入力: input, select, textarea
   * - コンテナ: div（直接の子のみ、display: flex/gridのもの）
   * - 画像: img
   * - 段落: p（最初の3つのみ）
   *
   * @param page - Playwrightページ
   * @returns Computed Styles配列
   */
  private async extractComputedStyles(page: Page): Promise<ComputedStyleInfo[]> {
    if (isDevelopment()) {
      logger.debug('[PageIngestAdapter] Extracting computed styles...');
    }

    const result = await page.evaluate(`
      (function() {
        // ユニークなセレクタを生成
        function getUniqueSelector(el) {
          if (el.id) {
            return '#' + el.id;
          }
          if (el.className && typeof el.className === 'string') {
            var classes = el.className.trim().split(/\\s+/).filter(function(c) {
              return c.length > 0 && !c.startsWith('_') && c.length < 50;
            }).slice(0, 3);
            if (classes.length > 0) {
              return el.tagName.toLowerCase() + '.' + classes.join('.');
            }
          }
          return el.tagName.toLowerCase();
        }

        // 親セクションからの相対パスを取得
        function getRelativePath(el, sectionEl) {
          var path = [];
          var current = el;
          while (current && current !== sectionEl) {
            var tagName = current.tagName.toLowerCase();
            var siblings = current.parentElement ? Array.from(current.parentElement.children).filter(function(s) {
              return s.tagName === current.tagName;
            }) : [];
            if (siblings.length > 1) {
              var index = siblings.indexOf(current) + 1;
              path.unshift(tagName + '[' + index + ']');
            } else {
              path.unshift(tagName);
            }
            current = current.parentElement;
          }
          return path.join(' > ');
        }

        // 要素のComputed Stylesを取得
        function getElementStyles(el) {
          var style = window.getComputedStyle(el);
          return {
            // 背景
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            // テキスト
            color: style.color,
            fontSize: style.fontSize,
            fontFamily: style.fontFamily,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            textAlign: style.textAlign,
            textDecoration: style.textDecoration,
            textTransform: style.textTransform,
            // レイアウト
            display: style.display,
            position: style.position,
            flexDirection: style.flexDirection,
            justifyContent: style.justifyContent,
            alignItems: style.alignItems,
            padding: style.padding,
            paddingTop: style.paddingTop,
            paddingRight: style.paddingRight,
            paddingBottom: style.paddingBottom,
            paddingLeft: style.paddingLeft,
            margin: style.margin,
            marginTop: style.marginTop,
            marginRight: style.marginRight,
            marginBottom: style.marginBottom,
            marginLeft: style.marginLeft,
            gap: style.gap,
            width: style.width,
            height: style.height,
            maxWidth: style.maxWidth,
            minHeight: style.minHeight,
            // 視覚効果
            border: style.border,
            borderRadius: style.borderRadius,
            boxShadow: style.boxShadow,
            backdropFilter: style.backdropFilter,
            opacity: style.opacity,
            overflow: style.overflow,
            // トランジション・アニメーション
            transition: style.transition,
            transform: style.transform
          };
        }

        // 子要素のスタイルを取得
        function getChildrenStyles(sectionEl, maxChildren) {
          var children = [];
          var childSelectors = 'h1, h2, h3, h4, h5, h6, button, a[href], input, select, textarea, img, p, [role="button"], [class*="btn"], [class*="button"]';
          var childElements = sectionEl.querySelectorAll(childSelectors);

          // 直接の子divでflex/gridレイアウトのものも追加
          var directDivs = Array.from(sectionEl.children).filter(function(el) {
            if (el.tagName !== 'DIV') return false;
            var style = window.getComputedStyle(el);
            return style.display === 'flex' || style.display === 'grid';
          });

          var allElements = Array.from(childElements).concat(directDivs);
          var processed = new Set();

          // 段落は最初の3つのみ
          var pCount = 0;
          var MAX_P = 3;

          for (var i = 0; i < allElements.length && children.length < maxChildren; i++) {
            var el = allElements[i];

            // 重複チェック
            if (processed.has(el)) continue;
            processed.add(el);

            // 非表示要素はスキップ
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            // 段落の制限
            if (el.tagName === 'P') {
              if (pCount >= MAX_P) continue;
              pCount++;
            }

            var textContent = '';
            if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') {
              textContent = (el.textContent || '').trim().substring(0, 100);
            } else if (el.tagName.match(/^H[1-6]$/)) {
              textContent = (el.textContent || '').trim().substring(0, 200);
            }

            children.push({
              selector: getUniqueSelector(el),
              tagName: el.tagName,
              className: el.className || '',
              path: getRelativePath(el, sectionEl),
              textContent: textContent || undefined,
              styles: getElementStyles(el)
            });
          }

          return children;
        }

        var sectionSelectors = 'section, header, footer, main, nav, article, aside, [role="banner"], [role="main"], [role="contentinfo"], [role="navigation"]';
        var sections = document.querySelectorAll(sectionSelectors);
        var MAX_CHILDREN_PER_SECTION = 30;

        return Array.from(sections).map(function(el, index) {
          var children = getChildrenStyles(el, MAX_CHILDREN_PER_SECTION);

          return {
            index: index,
            tagName: el.tagName,
            className: el.className || '',
            id: el.id || '',
            role: el.getAttribute('role') || '',
            styles: getElementStyles(el),
            children: children.length > 0 ? children : undefined
          };
        });
      })()
    `);

    const computedStyles = result as ComputedStyleInfo[];

    if (isDevelopment()) {
      const totalChildren = computedStyles.reduce(
        (sum, s) => sum + (s.children?.length ?? 0),
        0
      );
      logger.debug('[PageIngestAdapter] Computed styles extracted', {
        sectionCount: computedStyles.length,
        totalChildElements: totalChildren,
      });
    }

    return computedStyles;
  }

  /**
   * URLからWebページをインジェストする
   *
   * @param options - インジェストオプション
   * @returns インジェスト結果
   */
  async ingest(options: IngestAdapterOptions & { url: string }): Promise<IngestResult> {
    const { url, ...ingestOptions } = options;
    const viewport = ingestOptions.viewport ?? DEFAULT_VIEWPORT;
    const timeout = ingestOptions.timeout ?? DEFAULT_TIMEOUT;
    // disableWebGLはenableGPUより優先される
    const useWebGLDisabledBrowser = ingestOptions.disableWebGL === true;
    // GPU有効化（disableWebGLがtrueの場合は無効）
    const useGPUEnabledBrowser = !useWebGLDisabledBrowser && ingestOptions.enableGPU === true;
    const forceKillOnTimeout = ingestOptions.forceKillOnTimeout === true;

    if (isDevelopment()) {
      logger.info('[PageIngestAdapter] Starting ingest', {
        url,
        viewport,
        timeout,
        disableWebGL: useWebGLDisabledBrowser,
        enableGPU: useGPUEnabledBrowser,
        forceKillOnTimeout,
      });
    }

    // robots.txt チェック（RFC 9309準拠）
    const robotsResult = await isUrlAllowedByRobotsTxt(url, ingestOptions.respectRobotsTxt);
    if (!robotsResult.allowed) {
      throw new McpError(
        ErrorCode.ROBOTS_TXT_BLOCKED,
        `Blocked by robots.txt: ${url} (domain: ${robotsResult.domain}, reason: ${robotsResult.reason}). ` +
        `Use respect_robots_txt: false to override. ` +
        `Note: Overriding robots.txt may have legal implications depending on jurisdiction (e.g., EU DSM Directive Article 4).`,
        { domain: robotsResult.domain, reason: robotsResult.reason },
      );
    }

    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let globalTimeoutId: ReturnType<typeof setTimeout> | null = null;
    // WebGL無効化またはGPU有効化ブラウザを使用する場合は専用インスタンス
    let dedicatedBrowser: Browser | null = null;
    // プロセス強制終了用のPID
    let browserPid: number | undefined;
    // タイムアウトreject関数（グローバルタイムアウト時にPromiseをrejectするため）
    let timeoutReject: ((error: Error) => void) | null = null;
    // BrowserProcessManager（専用ブラウザ使用時のみ作成）
    let processManager: BrowserProcessManager | null = null;

    try {
      // ブラウザを取得
      // 優先順位: disableWebGL > enableGPU > 通常ブラウザ
      let browser: Browser;
      if (useWebGLDisabledBrowser) {
        dedicatedBrowser = await this.launchWebGLDisabledBrowser();
        browser = dedicatedBrowser;
        // browser.process() はPlaywrightの型定義に含まれていないが、実行時に存在
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        browserPid = (browser as any).process?.()?.pid as number | undefined;
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] Using dedicated WebGL-disabled browser', {
            pid: browserPid,
          });
        }
      } else if (useGPUEnabledBrowser) {
        // GPU有効化ブラウザ（専用インスタンス）
        dedicatedBrowser = await this.launchGPUEnabledBrowser();
        browser = dedicatedBrowser;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        browserPid = (browser as any).process?.()?.pid as number | undefined;
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] Using dedicated GPU-enabled browser', {
            pid: browserPid,
          });
        }
      } else {
        browser = await this.getBrowser();
        // 共有ブラウザのPIDも取得（強制終了時に必要）
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        browserPid = (browser as any).process?.()?.pid as number | undefined;
      }

      // BrowserProcessManagerを作成（専用ブラウザ使用時またはforceKillOnTimeout有効時）
      if (dedicatedBrowser && forceKillOnTimeout) {
        processManager = new BrowserProcessManager({
          browser: dedicatedBrowser,
          forceKillOnTimeout: true,
          killGracePeriodMs: 5000,
        });
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] BrowserProcessManager created for dedicated browser');
        }
      }

      // 新しいコンテキストを作成
      context = await browser.newContext({
        viewport,
        javaScriptEnabled: !ingestOptions.disableJavaScript,
        userAgent: ROBOTS_TXT.USER_AGENT,
      });

      page = await context.newPage();

      // ページレベルのデフォルトタイムアウトを設定
      // page.evaluate()等にはネイティブタイムアウトオプションがないため、
      // ページ全体のタイムアウトを設定することでハング防止
      page.setDefaultTimeout(timeout);

      // グローバルタイムアウトハンドラー: タイムアウト時にページ/ブラウザを強制クローズ
      // これにより、ハングしたpage.evaluate()も中断される
      // Note: page.evaluate()にはネイティブタイムアウトがないため、この方法でハングを防止
      // さらに、timeoutRejectを呼び出してメインのPromiseもrejectする
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutReject = reject;
      });

      const globalTimeoutMs = timeout + 5000;

      globalTimeoutId = setTimeout(async () => {
        const timeoutError = new Error(`Global timeout: ingest operation exceeded ${timeout}ms for ${url}`);

        if (isDevelopment()) {
          logger.error('[PageIngestAdapter] Global timeout triggered, force closing', {
            url,
            timeout,
            forceKillOnTimeout,
            browserPid,
          });
        }

        // Phase 1: ページをクローズ
        try {
          await Promise.race([
            page?.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('page.close timeout')), 5000)),
          ]);
        } catch {
          if (isDevelopment()) {
            logger.warn('[PageIngestAdapter] page.close() failed or timed out');
          }
        }

        // Phase 2: 専用ブラウザを使用している場合はブラウザをクローズ
        // BrowserProcessManagerを使用してタイムアウト付きクローズと強制終了を処理
        if (dedicatedBrowser) {
          if (processManager) {
            // BrowserProcessManagerを使用: タイムアウト付きクローズ（失敗時は自動で強制終了）
            const closed = await processManager.closeWithTimeout(5000);
            if (!closed && isDevelopment()) {
              logger.warn('[PageIngestAdapter] browser.close() timed out, force kill attempted');
            }
          } else {
            // processManagerがない場合は従来の方法でクローズ
            try {
              await Promise.race([
                dedicatedBrowser.close(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('browser.close timeout')), 5000)),
              ]);
            } catch {
              if (isDevelopment()) {
                logger.warn('[PageIngestAdapter] browser.close() failed or timed out');
              }
              // forceKillOnTimeoutが有効な場合は手動でkill
              if (forceKillOnTimeout && browserPid) {
                try {
                  if (isDevelopment()) {
                    logger.warn('[PageIngestAdapter] Force killing browser process', { pid: browserPid });
                  }
                  process.kill(browserPid, 'SIGKILL');
                } catch {
                  // プロセスが既に終了している場合は無視
                }
              }
            }
          }
        }

        // Phase 4: メインのPromiseをrejectしてエラーを伝播
        // これにより、ハングしている操作があっても関数がエラーで返る
        if (timeoutReject) {
          timeoutReject(timeoutError);
        }
      }, globalTimeoutMs);

      // グローバルタイムアウトとレースするためのヘルパー関数
      // 既存のwithTimeout関数とは異なり、グローバルタイムアウトPromiseとレースする
      const withGlobalTimeout = async <T>(operation: Promise<T>, operationName: string): Promise<T> => {
        return Promise.race([
          operation,
          timeoutPromise.then(() => {
            // This branch never executes (timeoutPromise only rejects, never resolves)
            throw new Error(`${operationName} timed out`);
          }),
        ]);
      };

      // ページに移動
      // waitForWebGL: trueの場合は'domcontentloaded'を使用（networkidleは永遠に完了しない問題への対応）
      // adaptiveWebGLWait有効時も'domcontentloaded'を使用（WebGLサイトは'load'が発火しない場合がある）
      // WebGL検出とフレームレート安定化で追加待機を処理するため、早期のDOM準備完了で十分
      let waitUntil = ingestOptions.waitUntil ?? 'load';
      if (ingestOptions.waitForWebGL === true) {
        // waitForWebGL: trueが明示的に指定された場合、常にdomcontentloadedを使用
        waitUntil = 'domcontentloaded';
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] Using domcontentloaded for waitForWebGL mode');
        }
      } else if (ingestOptions.adaptiveWebGLWait !== false && waitUntil === 'load') {
        waitUntil = 'domcontentloaded';
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] Using domcontentloaded for adaptive WebGL wait');
        }
      }
      if (isDevelopment()) {
        logger.debug('[PageIngestAdapter] Navigating with waitUntil', { url, waitUntil, timeout });
      }

      // DNS不安定対策: リトライ機構付きpage.goto
      // ERR_NAME_NOT_RESOLVED, EAI_AGAIN等のDNSエラー時のみリトライする
      let response: Awaited<ReturnType<Page['goto']>> = null;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= DNS_RETRY_CONFIG.MAX_RETRIES; attempt++) {
        try {
          response = await withGlobalTimeout(
            page.goto(url, {
              timeout,
              waitUntil,
            }),
            'page.goto'
          );
          lastError = null;
          break; // 成功したらループを抜ける
        } catch (gotoError) {
          lastError = gotoError instanceof Error ? gotoError : new Error(String(gotoError));

          // DNSエラーでない場合はリトライしない（即座に再throw）
          if (!isDnsRelatedError(gotoError)) {
            throw lastError;
          }

          // 最後のリトライで失敗した場合は再throw
          if (attempt >= DNS_RETRY_CONFIG.MAX_RETRIES) {
            logger.error('[PageIngestAdapter] DNS retry exhausted', {
              url,
              attempts: attempt + 1,
              error: lastError.message,
            });
            throw lastError;
          }

          // リトライ遅延（exponential backoff）
          const retryDelay = calculateRetryDelay(attempt);

          // 残りタイムアウトをチェック: リトライ遅延 + 次の試行がタイムアウトを超えないこと
          // グローバルタイムアウトが管理しているため、ここでは警告ログのみ
          logger.warn('[PageIngestAdapter] DNS error, retrying', {
            url,
            attempt: attempt + 1,
            maxRetries: DNS_RETRY_CONFIG.MAX_RETRIES,
            retryDelayMs: retryDelay,
            error: lastError.message,
          });

          await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
        }
      }

      if (!response) {
        throw lastError ?? new Error('No response received from page');
      }

      const finalUrl = page.url();

      // 特定のセレクターを待機（オプション）
      if (ingestOptions.waitForSelector) {
        await page.waitForSelector(ingestOptions.waitForSelector, {
          timeout: timeout / 2,
        });
      }

      // ステップ0: ユーザーインタラクション模倣（ローディング解除トリガー）
      // マウス移動でローディングアニメーションを解除するサイト対応
      if (ingestOptions.simulateUserInteraction !== false) {
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] Step 0: Simulating user interaction');
        }
        try {
          // ビューポート中央にマウスを移動
          const vp = page.viewportSize() ?? { width: 1440, height: 900 };
          await page.mouse.move(vp.width / 2, vp.height / 2);
          // 少しスクロール
          await page.mouse.wheel(0, 100);
          await page.waitForTimeout(500);
          // 元に戻す
          await page.mouse.wheel(0, -100);
          if (isDevelopment()) {
            logger.debug('[PageIngestAdapter] User interaction simulation completed');
          }
        } catch (e) {
          if (isDevelopment()) {
            logger.warn('[PageIngestAdapter] User interaction simulation failed', { error: String(e) });
          }
        }
      }

      // ステップ0.5: waitForWebGLモードのCanvas待機（Phase1-2）
      // networkidleが永遠に完了しないWebGLサイト向けの最適化
      if (ingestOptions.waitForWebGL === true) {
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] Step 0.5: waitForWebGL mode - waiting for canvas element');
        }

        try {
          // Canvas要素の出現を待機（最大10秒）
          await page.waitForSelector('canvas', { timeout: WEBGL_CONSTANTS.CANVAS_WAIT_TIMEOUT_MS });

          // WebGLコンテキスト取得確認
          const hasWebGL = await page.evaluate(`
            (function() {
              var canvas = document.querySelector('canvas');
              if (!canvas) return false;
              var gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
              return !!gl;
            })()
          `);

          // WebGL初期化待機
          if (hasWebGL) {
            const webglWaitMs = ingestOptions.webglWaitMs ?? WEBGL_CONSTANTS.DEFAULT_WEBGL_WAIT_MS;
            if (webglWaitMs > 0) {
              if (isDevelopment()) {
                logger.debug('[PageIngestAdapter] WebGL context found, waiting for initialization', {
                  webglWaitMs,
                });
              }
              await page.waitForTimeout(webglWaitMs);
            }
          } else {
            if (isDevelopment()) {
              logger.debug('[PageIngestAdapter] Canvas found but no WebGL context, skipping wait');
            }
          }
        } catch (e) {
          // Canvas未検出やエラー時もエラーにしない（Graceful Degradation）
          if (isDevelopment()) {
            logger.debug('[PageIngestAdapter] waitForWebGL canvas/context check failed, continuing', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }

      // ステップ1: ローディング要素の完全非表示を待機（最優先）
      // CSSアニメーション（opacity, transform）で隠れるローディング要素対応
      if (ingestOptions.waitForSelectorHidden) {
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] Step 1: Waiting for loading element to become invisible', {
            selector: ingestOptions.waitForSelectorHidden,
          });
        }
        const loadingHiddenResult = await this.waitForLoadingElementHidden(
          page,
          ingestOptions.waitForSelectorHidden,
          Math.min(timeout / 2, 30000)
        );
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] Loading element check completed', loadingHiddenResult);
        }
      }

      // ステップ1.5: コンテンツ要素の可視性待機
      // 実際のコンテンツが描画されるまで待機（sr-only以外の可視要素）
      if (ingestOptions.waitForContentVisible) {
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] Step 1.5: Waiting for content to become visible', {
            selector: ingestOptions.waitForContentVisible,
          });
        }
        try {
          await page.waitForSelector(ingestOptions.waitForContentVisible, {
            state: 'visible',
            timeout: Math.min(timeout / 2, 30000),
          });
          if (isDevelopment()) {
            logger.debug('[PageIngestAdapter] Content element visible');
          }
        } catch {
          if (isDevelopment()) {
            logger.warn('[PageIngestAdapter] Content element not found or timeout', {
              selector: ingestOptions.waitForContentVisible,
            });
          }
        }
      }

      // ステップ2: DOM安定化待機（React/Vue/Next.js hydration対応）
      // ローディング完了後のコンテンツ描画を待つ
      if (ingestOptions.waitForDomStable !== false) {
        const domStableTimeout = ingestOptions.domStableTimeout ?? 500;
        const maxWait = Math.min(timeout / 2, 10000);
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] Step 2: Waiting for DOM stability', {
            domStableTimeout,
            maxWait,
          });
        }
        const result = await withGlobalTimeout(
          this.waitForDomStable(page, domStableTimeout, maxWait),
          'waitForDomStable'
        );
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] DOM stability check completed', result);
        }
      }

      // ステップ2.5: WebGL/3Dサイト適応的待機（デフォルト有効）
      // Canvas/WebGLを検出し、フレームレート安定化を待機
      // disableWebGL=trueの場合はスキップ（WebGLが無効化されているため検出不要）
      const warnings: IngestWarning[] = [];
      let webglDetection: WebGLDetectionResult | undefined;
      let webglWait: WebGLWaitResult | undefined;

      // disableWebGL使用時は警告を追加
      if (useWebGLDisabledBrowser) {
        warnings.push({
          code: 'WEBGL_DISABLED',
          message: 'WebGL has been disabled for this ingest. 3D/WebGL content will not render correctly.',
        });
        if (isDevelopment()) {
          logger.info('[PageIngestAdapter] Skipping WebGL detection (disableWebGL=true)');
        }
      } else if (ingestOptions.adaptiveWebGLWait !== false) {
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] Step 2.5: Adaptive WebGL wait (enabled by default)');
        }
        try {
          const webglResult = await withGlobalTimeout(
            this.waitForWebGLReady(page, ingestOptions, warnings),
            'waitForWebGLReady'
          );
          webglDetection = webglResult.detection;
          webglWait = webglResult.wait;

          if (webglDetection.detected && isDevelopment()) {
            logger.info('[PageIngestAdapter] WebGL site detected', {
              canvasCount: webglDetection.canvasCount,
              webgl1Count: webglDetection.webgl1Count,
              webgl2Count: webglDetection.webgl2Count,
              threeJsDetected: webglDetection.threeJsDetected,
              frameRateStable: webglWait?.frameRateStable,
              lastFrameRate: webglWait?.lastFrameRate,
            });
          }
        } catch (e) {
          // Graceful Degradation: WebGL待機失敗時も処理を継続
          const errorMessage = e instanceof Error ? e.message : String(e);
          warnings.push({
            code: 'WEBGL_WAIT_ERROR',
            message: `WebGL adaptive wait failed: ${errorMessage}`,
          });
          if (isDevelopment()) {
            logger.warn('[PageIngestAdapter] WebGL adaptive wait failed, continuing', {
              error: errorMessage,
            });
          }
        }
      }

      // ステップ3: 追加の固定待機時間（アニメーション完了用）
      if (ingestOptions.waitForTimeout && ingestOptions.waitForTimeout > 0) {
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] Step 3: Additional wait', {
            waitForTimeout: ingestOptions.waitForTimeout,
          });
        }
        await page.waitForTimeout(ingestOptions.waitForTimeout);
      }

      // WebGLサイトかどうかでタイムアウトを調整
      const isWebGLSiteForTimeout = webglDetection?.detected ?? false;
      const timeoutMultiplier = isWebGLSiteForTimeout ? OPERATION_TIMEOUTS.WEBGL_MULTIPLIER : 1;

      // HTML取得（操作レベルタイムアウト付き）
      const html = await withTimeout(
        page.content(),
        OPERATION_TIMEOUTS.CONTENT_EXTRACTION * timeoutMultiplier,
        'page.content()'
      );

      // メタデータ抽出（操作レベルタイムアウト付き）
      const metadata = await withTimeout(
        this.extractMetadata(page),
        OPERATION_TIMEOUTS.METADATA_EXTRACTION * timeoutMultiplier,
        'extractMetadata'
      );

      // ビューポート情報取得（操作レベルタイムアウト付き）
      const viewportInfo = await withTimeout(
        this.getViewportInfo(page, viewport),
        OPERATION_TIMEOUTS.VIEWPORT_INFO * timeoutMultiplier,
        'getViewportInfo'
      );

      // スクリーンショット取得（skipScreenshot: true の場合はスキップ）
      let screenshots: IngestScreenshotResult[] | undefined;
      if (!ingestOptions.skipScreenshot) {
        // WebGLサイトの場合はスクリーンショットタイムアウトを延長（120秒）
        // 重い3Dサイトはフォント読み込みやレンダリングに時間がかかるため
        const isWebGLSite = webglDetection?.detected ?? false;
        const screenshotTimeout = isWebGLSite ? 120000 : 30000;

        try {
          // WebGLサイトではfullPageを強制無効化（SwiftShaderで極めて遅いため）
          // フルページスクロール＋レンダリングはSwiftShaderで数分〜タイムアウトになる
          const effectiveFullPage = isWebGLSite ? false : (ingestOptions.fullPage ?? true);

          if (isDevelopment()) {
            if (isWebGLSite) {
              logger.debug('[PageIngestAdapter] WebGL site detected: using viewport-only screenshot (fullPage disabled)', {
                timeout: screenshotTimeout,
                originalFullPage: ingestOptions.fullPage ?? true,
                effectiveFullPage,
              });
            } else {
              logger.debug('[PageIngestAdapter] Taking screenshot', {
                timeout: screenshotTimeout,
                fullPage: effectiveFullPage,
              });
            }
          }

          const screenshotBuffer = await withGlobalTimeout(
            page.screenshot({
              fullPage: effectiveFullPage,
              type: 'png',
              timeout: screenshotTimeout,
            }),
            'page.screenshot'
          );
          const screenshotBase64 = screenshotBuffer.toString('base64');
          screenshots = [
            {
              viewportName: 'desktop',
              viewport,
              data: screenshotBase64,
              format: 'png',
              fullPage: effectiveFullPage,
              size: screenshotBuffer.length,
            },
          ];
        } catch (screenshotError) {
          // Graceful Degradation: スクリーンショット失敗時も続行
          const errorMessage = screenshotError instanceof Error ? screenshotError.message : String(screenshotError);
          warnings.push({
            code: 'SCREENSHOT_FAILED',
            message: `Screenshot capture failed: ${errorMessage}. Analysis will continue without screenshot.`,
          });

          if (isDevelopment()) {
            logger.warn('[PageIngestAdapter] Screenshot failed, continuing without screenshot', {
              error: errorMessage,
              isWebGLSite,
              fullPage: ingestOptions.fullPage ?? true,
            });
          }
        }
      }

      // Computed Styles取得（includeComputedStyles: true の場合のみ）
      let computedStyles: ComputedStyleInfo[] | undefined;
      if (ingestOptions.includeComputedStyles) {
        computedStyles = await this.extractComputedStyles(page);
      }

      if (isDevelopment()) {
        logger.info('[PageIngestAdapter] Ingest completed', {
          url,
          finalUrl,
          htmlSize: html.length,
          hasScreenshot: !!screenshots,
          hasComputedStyles: !!computedStyles,
          computedStylesCount: computedStyles?.length ?? 0,
          webglDetected: webglDetection?.detected ?? false,
          warningCount: warnings.length,
        });
      }

      // 結果オブジェクトを構築（undefinedプロパティを除外）
      const result: IngestResult = {
        success: true,
        url,
        finalUrl,
        html,
        htmlSize: html.length,
        viewportInfo,
        metadata,
        ingestedAt: new Date(),
        source: {
          type: ingestOptions.sourceType ?? 'user_provided',
          usageScope: ingestOptions.usageScope ?? 'inspiration_only',
        },
      };

      // screenshotsは値がある場合のみ設定
      if (screenshots) {
        result.screenshots = screenshots;
      }

      // computedStylesは値がある場合のみ設定
      if (computedStyles) {
        result.computedStyles = computedStyles;
      }

      // WebGL検出結果（検出された場合のみ設定）
      if (webglDetection?.detected) {
        result.webglDetection = webglDetection;
        if (webglWait) {
          result.webglWait = webglWait;
        }
      }

      // 警告がある場合のみ設定
      if (warnings.length > 0) {
        result.warnings = warnings;
      }

      // 正常完了時はグローバルタイムアウトをクリア
      if (globalTimeoutId) {
        clearTimeout(globalTimeoutId);
      }

      return result;
    } catch (error) {
      // エラー発生時もグローバルタイムアウトをクリア
      if (globalTimeoutId) {
        clearTimeout(globalTimeoutId);
      }
      // エラー処理
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (isDevelopment()) {
        logger.error('[PageIngestAdapter] Ingest failed', {
          url,
          error: errorMessage,
        });
      }

      // エラー結果を返す
      return {
        success: false,
        error: errorMessage,
        url,
        finalUrl: url,
        html: '',
        htmlSize: 0,
        viewportInfo: {
          documentWidth: 0,
          documentHeight: 0,
          viewportWidth: 0,
          viewportHeight: 0,
          scrollHeight: 0,
        },
        metadata: { title: '' },
        ingestedAt: new Date(),
        source: {
          type: options.sourceType ?? 'user_provided',
          usageScope: options.usageScope ?? 'inspiration_only',
        },
      };
    } finally {
      // リソースクリーンアップ
      if (page) {
        await page.close().catch(() => {});
      }
      if (context) {
        await context.close().catch(() => {});
      }
      // 専用ブラウザを使用した場合はブラウザも閉じる
      // BrowserProcessManagerを使用して安全にクローズ
      if (dedicatedBrowser) {
        if (isDevelopment()) {
          logger.debug('[PageIngestAdapter] Closing dedicated browser');
        }
        if (processManager) {
          // BrowserProcessManagerを使用して安全にクローズ（タイムアウト10秒）
          const closed = await processManager.closeWithTimeout(10000);
          if (!closed && isDevelopment()) {
            logger.warn('[PageIngestAdapter] Dedicated browser close timed out in finally block');
          }
        } else {
          // processManagerがない場合は従来の方法でクローズ
          await dedicatedBrowser.close().catch(() => {});
        }
        dedicatedBrowser = null;
        processManager = null;
      }
    }
  }

  /**
   * ブラウザを終了
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      if (isDevelopment()) {
        logger.info('[PageIngestAdapter] Browser closed');
      }
    }
  }
}

// シングルトンインスタンス
export const pageIngestAdapter = new PageIngestAdapter();

// プロセスイベントリスナー重複登録防止フラグ
let processListenersRegistered = false;

// プロセス終了時にブラウザを閉じる（1回だけ登録）
if (!processListenersRegistered) {
  processListenersRegistered = true;

  process.on('beforeExit', async () => {
    await pageIngestAdapter.close();
  });

  process.on('SIGINT', async () => {
    await pageIngestAdapter.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await pageIngestAdapter.close();
    process.exit(0);
  });
}

// =============================================
// 開発環境ログ
// =============================================

if (isDevelopment()) {
  logger.debug('[PageIngestAdapter] Module loaded (Playwright direct integration)');
}
