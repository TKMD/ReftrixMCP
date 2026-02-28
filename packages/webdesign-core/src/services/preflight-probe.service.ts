// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pre-flight Probe Service
 *
 * Webサイトの複雑度を事前分析し、動的タイムアウトを計算するサービス。
 * page.analyze や layout.ingest で適切なタイムアウト値を決定するために使用。
 *
 * @module @reftrix/webdesign-core/services/preflight-probe
 */

import { isUrlAllowedByRobotsTxt, ROBOTS_TXT } from '@reftrix/core';

// =============================================================================
// Constants
// =============================================================================

/**
 * 基本タイムアウト値（シンプルなページ向け）
 */
export const BASE_TIMEOUT = 30000; // 30秒

/**
 * 最大タイムアウト値（上限）
 */
export const MAX_TIMEOUT = 300000; // 5分

/**
 * デフォルトタイムアウト値（Probeエラー時のフォールバック）
 */
export const DEFAULT_TIMEOUT = 60000; // 60秒

/**
 * Probeリクエスト自体のタイムアウト
 */
export const PROBE_TIMEOUT = 5000; // 5秒

/**
 * HTML取得時の最大サイズ（バイト）
 */
export const MAX_HTML_FETCH_SIZE = 102400; // 100KB

/**
 * Probeサービスバージョン
 */
export const PROBE_VERSION = '0.1.0';

// =============================================================================
// Types
// =============================================================================

/**
 * 複雑度分析結果
 */
export interface ComplexityAnalysis {
  /** スクリプトタグの数 */
  scriptCount: number;
  /** 外部リソースの数（link, img, script src等） */
  externalResourceCount: number;
  /** WebGL使用の検出（canvas, three.js, babylon等） */
  hasWebGL: boolean;
  /** SPA検出（React, Vue, Angular markers） */
  hasSPA: boolean;
  /** 重いフレームワーク検出（Three.js, GSAP heavy usage等） */
  hasHeavyFramework: boolean;
}

/**
 * Probe結果
 */
export interface ProbeResult {
  // 測定値
  /** HEAD/GETリクエストの応答時間（ミリ秒） */
  responseTimeMs: number;
  /** 取得したHTMLのサイズ（バイト） */
  htmlSizeBytes: number;
  /** スクリプトタグの数 */
  scriptCount: number;
  /** 外部リソースの数 */
  externalResourceCount: number;

  // 検出フラグ
  /** WebGL使用の検出 */
  hasWebGL: boolean;
  /** SPA検出 */
  hasSPA: boolean;
  /** 重いフレームワーク検出 */
  hasHeavyFramework: boolean;

  // 計算結果
  /** 計算されたタイムアウト値（ミリ秒） */
  calculatedTimeoutMs: number;
  /** 複雑度スコア（0-100） */
  complexityScore: number;

  // メタデータ
  /** Probe実行日時（ISO 8601形式） */
  probedAt: string;
  /** Probeサービスバージョン */
  probeVersion: string;
}

/**
 * PreflightProbeServiceインターフェース
 */
/**
 * Probeオプション
 */
export interface ProbeOptions {
  /** robots.txtを尊重するかどうか（RFC 9309） */
  respectRobotsTxt?: boolean;
}

export interface IPreflightProbeService {
  /**
   * URLをProbeし、複雑度分析と動的タイムアウトを計算
   * @param url - 分析対象URL
   * @param options - Probeオプション
   * @returns Probe結果
   */
  probe(url: string, options?: ProbeOptions): Promise<ProbeResult>;

  /**
   * URLに対する動的タイムアウトを計算（簡易版）
   * @param url - 分析対象URL
   * @param options - Probeオプション
   * @returns タイムアウト値（ミリ秒）
   */
  calculateDynamicTimeout(url: string, options?: ProbeOptions): Promise<number>;
}

// =============================================================================
// SSRF Protection (Inline implementation to avoid circular dependencies)
// =============================================================================

/**
 * ブロックするホスト名一覧
 */
const BLOCKED_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  '169.254.169.254',
  'metadata.google.internal',
  'kubernetes.default.svc',
];

/**
 * ブロックするIPレンジ（正規表現）
 */
const BLOCKED_IP_RANGES: readonly RegExp[] = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
];

/**
 * URLのSSRF安全性を検証
 * @param url - 検証するURL
 * @throws URL検証エラー
 */
function validateUrlForSSRF(url: string): void {
  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    throw new Error(`Invalid URL format: ${url}`);
  }

  // プロトコル検証
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw new Error(
      `Invalid protocol: only http and https are allowed, got ${urlObj.protocol}`
    );
  }

  const hostname = urlObj.hostname.toLowerCase();

  // ブロックホストチェック
  if (BLOCKED_HOSTS.includes(hostname)) {
    throw new Error(`URL is blocked: ${hostname} is not allowed (SSRF protection)`);
  }

  // プライベートIPレンジチェック
  for (const range of BLOCKED_IP_RANGES) {
    if (range.test(hostname)) {
      throw new Error(
        `URL is blocked: private IP range ${hostname} is not allowed (SSRF protection)`
      );
    }
  }
}

// =============================================================================
// Complexity Analysis Functions
// =============================================================================

/**
 * scriptタグの数をカウント
 */
function countScriptTags(html: string): number {
  const matches = html.match(/<script\b[^>]*>/gi);
  return matches ? matches.length : 0;
}

/**
 * 外部リソースの数をカウント
 * link[href], img[src], script[src], video[src], audio[src], iframe[src]
 */
function countExternalResources(html: string): number {
  let count = 0;

  // link tags with href
  const linkMatches = html.match(/<link\b[^>]*href\s*=/gi);
  count += linkMatches ? linkMatches.length : 0;

  // img tags with src
  const imgMatches = html.match(/<img\b[^>]*src\s*=/gi);
  count += imgMatches ? imgMatches.length : 0;

  // script tags with src
  const scriptSrcMatches = html.match(/<script\b[^>]*src\s*=/gi);
  count += scriptSrcMatches ? scriptSrcMatches.length : 0;

  // video tags with src
  const videoMatches = html.match(/<video\b[^>]*src\s*=/gi);
  count += videoMatches ? videoMatches.length : 0;

  // audio tags with src
  const audioMatches = html.match(/<audio\b[^>]*src\s*=/gi);
  count += audioMatches ? audioMatches.length : 0;

  // iframe tags with src
  const iframeMatches = html.match(/<iframe\b[^>]*src\s*=/gi);
  count += iframeMatches ? iframeMatches.length : 0;

  return count;
}

/**
 * WebGL使用を検出
 * - canvas要素の存在
 * - Three.js, Babylon.js, PixiJS等のライブラリ参照
 */
function detectWebGL(html: string): boolean {
  const lowerHtml = html.toLowerCase();

  // canvas要素
  if (/<canvas\b/i.test(html)) {
    return true;
  }

  // WebGLライブラリの検出
  const webglLibraries = [
    'three.js',
    'three.min.js',
    'three.module.js',
    'babylon.js',
    'babylon.min.js',
    'pixi.js',
    'pixi.min.js',
    'webgl',
    'gl-matrix',
    'regl',
    'twgl',
  ];

  for (const lib of webglLibraries) {
    if (lowerHtml.includes(lib)) {
      return true;
    }
  }

  // window.THREE や WebGLRenderingContext の参照
  if (
    /window\.THREE\b/i.test(html) ||
    /WebGLRenderingContext/i.test(html) ||
    /getContext\s*\(\s*['"]webgl/i.test(html)
  ) {
    return true;
  }

  return false;
}

/**
 * SPA（Single Page Application）フレームワークを検出
 * - React, Vue, Angular, Svelte等のマーカー
 */
function detectSPA(html: string): boolean {
  // React markers
  if (
    /__REACT_DEVTOOLS_GLOBAL_HOOK__/i.test(html) ||
    /data-reactroot/i.test(html) ||
    /data-react-helmet/i.test(html) ||
    /<div\s+id\s*=\s*["']root["']/i.test(html)
  ) {
    return true;
  }

  // Vue markers
  if (
    /data-v-[a-f0-9]+/i.test(html) ||
    /__VUE__/i.test(html) ||
    /data-v-app/i.test(html) ||
    /v-cloak/i.test(html)
  ) {
    return true;
  }

  // Angular markers
  if (
    /ng-version/i.test(html) ||
    /_ng(host|content|if|for)/i.test(html) ||
    /<app-root/i.test(html)
  ) {
    return true;
  }

  // Svelte markers
  if (/svelte-[a-z0-9]+/i.test(html)) {
    return true;
  }

  // Next.js markers
  if (/__NEXT_DATA__/i.test(html) || /_next\/static/i.test(html)) {
    return true;
  }

  // Nuxt.js markers
  if (/__NUXT__/i.test(html) || /_nuxt\//i.test(html)) {
    return true;
  }

  return false;
}

/**
 * 重いアニメーションフレームワークを検出
 * - GSAP, anime.js, Framer Motion, Lottie等
 */
function detectHeavyFramework(html: string): boolean {
  const lowerHtml = html.toLowerCase();

  const heavyFrameworks = [
    'gsap',
    'greensock',
    'tweenmax',
    'tweenlite',
    'anime.js',
    'anime.min.js',
    'animejs',
    'framer-motion',
    'lottie',
    'bodymovin',
    'scrollmagic',
    'locomotive-scroll',
    'scrolltrigger',
    'motion.div',
  ];

  for (const framework of heavyFrameworks) {
    if (lowerHtml.includes(framework)) {
      return true;
    }
  }

  // window.gsap, window.anime等の参照
  if (/window\.(gsap|anime|ScrollTrigger)/i.test(html)) {
    return true;
  }

  return false;
}

/**
 * HTMLの複雑度を分析
 * @param html - 分析対象のHTML文字列
 * @returns 複雑度分析結果
 */
export function analyzeComplexity(html: string): ComplexityAnalysis {
  return {
    scriptCount: countScriptTags(html),
    externalResourceCount: countExternalResources(html),
    hasWebGL: detectWebGL(html),
    hasSPA: detectSPA(html),
    hasHeavyFramework: detectHeavyFramework(html),
  };
}

// =============================================================================
// Timeout Calculation
// =============================================================================

/**
 * 複雑度メトリクスと応答時間から乗数を計算
 * @param metrics - 複雑度分析結果
 * @param responseTimeMs - 応答時間（ミリ秒）
 * @returns タイムアウト乗数
 */
export function calculateMultiplier(
  metrics: ComplexityAnalysis,
  responseTimeMs: number
): number {
  let multiplier = 1.0;

  // 応答時間による調整
  if (responseTimeMs > 2000) {
    multiplier += 1.0;
  } else if (responseTimeMs > 500) {
    multiplier += 0.5;
  }

  // スクリプト数による調整
  if (metrics.scriptCount > 30) {
    multiplier += 1.5;
  } else if (metrics.scriptCount > 15) {
    multiplier += 0.75;
  } else if (metrics.scriptCount > 5) {
    multiplier += 0.25;
  }

  // 外部リソース数による調整
  if (metrics.externalResourceCount > 50) {
    multiplier += 1.0;
  } else if (metrics.externalResourceCount > 30) {
    multiplier += 0.5;
  }

  // 重いフレームワーク検出による調整
  if (metrics.hasWebGL) {
    multiplier += 2.0;
  }
  if (metrics.hasHeavyFramework) {
    multiplier += 1.5;
  }
  if (metrics.hasSPA) {
    multiplier += 0.5;
  }

  return multiplier;
}

/**
 * 複雑度スコアを計算（0-100）
 */
function calculateComplexityScore(
  metrics: ComplexityAnalysis,
  responseTimeMs: number
): number {
  let score = 0;

  // スクリプト数（最大25点）
  score += Math.min(metrics.scriptCount * 0.5, 25);

  // 外部リソース数（最大20点）
  score += Math.min(metrics.externalResourceCount * 0.2, 20);

  // 応答時間（最大15点）
  score += Math.min(responseTimeMs / 200, 15);

  // WebGL（20点）
  if (metrics.hasWebGL) {
    score += 20;
  }

  // 重いフレームワーク（15点）
  if (metrics.hasHeavyFramework) {
    score += 15;
  }

  // SPA（5点）
  if (metrics.hasSPA) {
    score += 5;
  }

  return Math.min(Math.round(score), 100);
}

// =============================================================================
// PreflightProbeService Implementation
// =============================================================================

/**
 * Pre-flight Probe Service
 *
 * Webサイトの複雑度を事前分析し、動的タイムアウトを計算する。
 */
export class PreflightProbeService implements IPreflightProbeService {
  /**
   * URLをProbeし、複雑度分析と動的タイムアウトを計算
   *
   * @param url - 分析対象URL
   * @returns Probe結果
   * @throws SSRF検証エラー
   */
  async probe(url: string, options?: ProbeOptions): Promise<ProbeResult> {
    // SSRF保護
    validateUrlForSSRF(url);

    // robots.txt チェック（RFC 9309準拠）
    const robotsResult = await isUrlAllowedByRobotsTxt(url, options?.respectRobotsTxt);
    if (!robotsResult.allowed) {
      throw new Error(
        `Blocked by robots.txt: ${url} (domain: ${robotsResult.domain}, reason: ${robotsResult.reason}). ` +
        `Use respect_robots_txt: false to override. ` +
        `Note: Overriding robots.txt may have legal implications depending on jurisdiction (e.g., EU DSM Directive Article 4).`,
      );
    }

    const probedAt = new Date().toISOString();

    try {
      // Phase 1: HEAD/GETリクエストで応答時間を測定
      const { responseTimeMs, html, htmlSizeBytes } = await this.fetchWithTiming(url);

      // Phase 2: 複雑度分析
      const complexity = analyzeComplexity(html);

      // Phase 3: 乗数計算
      const multiplier = calculateMultiplier(complexity, responseTimeMs);

      // Phase 4: タイムアウト計算
      const calculatedTimeoutMs = Math.min(
        Math.round(BASE_TIMEOUT * multiplier),
        MAX_TIMEOUT
      );

      // 複雑度スコア計算
      const complexityScore = calculateComplexityScore(complexity, responseTimeMs);

      return {
        responseTimeMs,
        htmlSizeBytes,
        scriptCount: complexity.scriptCount,
        externalResourceCount: complexity.externalResourceCount,
        hasWebGL: complexity.hasWebGL,
        hasSPA: complexity.hasSPA,
        hasHeavyFramework: complexity.hasHeavyFramework,
        calculatedTimeoutMs,
        complexityScore,
        probedAt,
        probeVersion: PROBE_VERSION,
      };
    } catch (error) {
      // エラー時はデフォルト値を返す
      if (process.env.NODE_ENV === 'development') {
        console.warn('[PreflightProbeService] Probe failed, using default timeout:', error);
      }

      return this.createDefaultResult(probedAt);
    }
  }

  /**
   * URLに対する動的タイムアウトを計算（簡易版）
   *
   * @param url - 分析対象URL
   * @returns タイムアウト値（ミリ秒）
   */
  async calculateDynamicTimeout(url: string, options?: ProbeOptions): Promise<number> {
    try {
      const result = await this.probe(url, options);
      return result.calculatedTimeoutMs;
    } catch {
      return DEFAULT_TIMEOUT;
    }
  }

  /**
   * タイムアウト付きでHTMLを取得
   */
  private async fetchWithTiming(
    url: string
  ): Promise<{ responseTimeMs: number; html: string; htmlSizeBytes: number }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT);

    try {
      const startTime = performance.now();

      // まずHEADリクエストで応答時間を計測
      const headResponse = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: {
          'User-Agent':
            ROBOTS_TXT.USER_AGENT,
        },
      });

      const headTime = performance.now();
      const responseTimeMs = Math.round(headTime - startTime);

      // HTMLを取得（最初の100KB程度）
      const getResponse = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent':
            ROBOTS_TXT.USER_AGENT,
          Range: `bytes=0-${MAX_HTML_FETCH_SIZE - 1}`,
        },
      });

      if (!getResponse.ok && !headResponse.ok) {
        throw new Error(`HTTP error: ${getResponse.status}`);
      }

      const html = await getResponse.text();
      const htmlSizeBytes = new TextEncoder().encode(html).length;

      return { responseTimeMs, html, htmlSizeBytes };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * デフォルトのProbe結果を作成
   */
  private createDefaultResult(probedAt: string): ProbeResult {
    return {
      responseTimeMs: 0,
      htmlSizeBytes: 0,
      scriptCount: 0,
      externalResourceCount: 0,
      hasWebGL: false,
      hasSPA: false,
      hasHeavyFramework: false,
      calculatedTimeoutMs: DEFAULT_TIMEOUT,
      complexityScore: 0,
      probedAt,
      probeVersion: PROBE_VERSION,
    };
  }
}

// =============================================================================
// Exports (Default Instance)
// =============================================================================

/**
 * デフォルトのPreflightProbeServiceインスタンス
 */
export const preflightProbeService = new PreflightProbeService();
