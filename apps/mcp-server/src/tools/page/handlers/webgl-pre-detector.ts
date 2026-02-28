// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGL/Three.js サイト事前推定機能
 *
 * page.analyze実行前にURLからWebGL/Three.jsサイトかどうかを事前推定し、
 * タイムアウト設定を最適化するための機能。
 *
 * 目的:
 * - 既知のWebGL重いサイト（resn.co.nz, activetheory.net等）を事前検出
 * - URLパターン（/webgl/, /3d/, /canvas/等）からWebGL使用を推定
 * - 推定結果に基づきタイムアウト乗数を算出（1.0-3.0倍）
 * - サイト種別（SiteTier）を判定しリトライ戦略を決定
 *
 * Phase4-3: webgl-domains.tsからの統合ドメインリストを使用
 *
 * @module tools/page/handlers/webgl-pre-detector
 */

import { type SiteTier } from './retry-strategy';
import { WEBGL_DOMAIN_MAP, getDomainsByTier } from './webgl-domains';

/**
 * 事前検出結果のインターフェース
 */
export interface PreDetectionResult {
  /** WebGL使用の可能性が高いかどうか */
  isLikelyWebGL: boolean;
  /** 信頼度スコア（0-1） */
  confidence: number;
  /** タイムアウト乗数（1.0-3.0） */
  timeoutMultiplier: number;
  /** マッチした既知ドメイン（オプション） */
  matchedDomain?: string;
  /** マッチしたURLパターン（オプション） */
  matchedPattern?: string;
}

/**
 * 既知のWebGL/Three.js重量サイトドメイン
 * Phase4-3: webgl-domains.tsから統合リストをエクスポート
 *
 * @deprecated Use WEBGL_DOMAIN_MAP from webgl-domains.ts for structured access
 */
export const KNOWN_WEBGL_DOMAINS: readonly string[] = Array.from(
  WEBGL_DOMAIN_MAP.keys()
);

/**
 * WebGL/3D関連のURLパターン
 * パス内に含まれる場合にWebGL使用を推定
 * 注: スラッシュで囲まれたパターンのみ検出（誤検出を避けるため）
 */
export const WEBGL_URL_PATTERNS: readonly string[] = [
  '/webgl/',
  '/3d/',
  '/canvas/',
  '/three/',
  '/experience/',
  '/interactive/',
  '/immersive/',
] as const;

/**
 * URLからドメインを抽出する
 * @param url - 対象URL
 * @returns ドメイン文字列、抽出できない場合はnull
 */
function extractDomain(url: string): string | null {
  if (!url || typeof url !== 'string') {
    return null;
  }

  try {
    // プロトコルがない場合は追加
    let normalizedUrl = url;
    if (!url.includes('://')) {
      normalizedUrl = 'https://' + url;
    }

    const urlObj = new URL(normalizedUrl);
    // www. プレフィックスを除去してドメインを正規化
    let hostname = urlObj.hostname.toLowerCase();
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }
    return hostname;
  } catch {
    // URL解析に失敗した場合
    return null;
  }
}

/**
 * URLのパス部分を抽出する
 * @param url - 対象URL
 * @returns パス文字列、抽出できない場合はnull
 */
function extractPath(url: string): string | null {
  if (!url || typeof url !== 'string') {
    return null;
  }

  try {
    // プロトコルがない場合は追加
    let normalizedUrl = url;
    if (!url.includes('://')) {
      normalizedUrl = 'https://' + url;
    }

    const urlObj = new URL(normalizedUrl);
    // パスのみを返す（クエリパラメータとフラグメントを除外）
    return urlObj.pathname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 既知ドメインとのマッチングを行う
 * @param domain - 検査対象ドメイン
 * @returns マッチしたドメイン、マッチしない場合はnull
 */
function matchKnownDomain(domain: string | null): string | null {
  if (!domain) {
    return null;
  }

  for (const knownDomain of KNOWN_WEBGL_DOMAINS) {
    // 完全一致またはサブドメインマッチ
    if (domain === knownDomain || domain.endsWith('.' + knownDomain)) {
      return knownDomain;
    }
  }

  return null;
}

/**
 * URLパターンとのマッチングを行う
 * @param path - 検査対象パス
 * @returns マッチしたパターン、マッチしない場合はnull
 */
function matchUrlPattern(path: string | null): string | null {
  if (!path) {
    return null;
  }

  for (const pattern of WEBGL_URL_PATTERNS) {
    // パターンを小文字に変換して大文字小文字を区別しない
    const lowerPattern = pattern.toLowerCase();
    if (path.includes(lowerPattern)) {
      return pattern;
    }
  }

  return null;
}

/**
 * URLからWebGL/Three.jsサイトかどうかを事前推定する
 *
 * @param url - 検査対象URL
 * @returns 事前検出結果
 *
 * @example
 * ```typescript
 * // 既知ドメインの場合
 * const result = preDetectWebGL('https://resn.co.nz');
 * // { isLikelyWebGL: true, confidence: 1.0, timeoutMultiplier: 3.0, matchedDomain: 'resn.co.nz' }
 *
 * // URLパターンマッチの場合
 * const result = preDetectWebGL('https://example.com/webgl/demo');
 * // { isLikelyWebGL: true, confidence: 0.7, timeoutMultiplier: 2.0, matchedPattern: '/webgl/' }
 *
 * // 通常サイトの場合
 * const result = preDetectWebGL('https://google.com');
 * // { isLikelyWebGL: false, confidence: 0, timeoutMultiplier: 1.0 }
 * ```
 */
export function preDetectWebGL(url: string): PreDetectionResult {
  // デフォルト結果（非WebGL）
  const defaultResult: PreDetectionResult = {
    isLikelyWebGL: false,
    confidence: 0,
    timeoutMultiplier: 1.0,
  };

  // 空文字列や不正な入力の場合
  if (!url || typeof url !== 'string' || url.trim() === '') {
    return defaultResult;
  }

  // ドメインを抽出
  const domain = extractDomain(url);

  // 既知ドメインとのマッチング（最優先）
  const matchedDomain = matchKnownDomain(domain);
  if (matchedDomain) {
    return {
      isLikelyWebGL: true,
      confidence: 1.0,
      timeoutMultiplier: 3.0,
      matchedDomain,
    };
  }

  // URLパターンマッチング
  const path = extractPath(url);
  const matchedPattern = matchUrlPattern(path);
  if (matchedPattern) {
    return {
      isLikelyWebGL: true,
      confidence: 0.7, // パターンマッチは信頼度がやや低い
      timeoutMultiplier: 2.0,
      matchedPattern,
    };
  }

  // マッチなし
  return defaultResult;
}

/**
 * 既知のultra-heavyドメイン（非常に重いサイト）
 * Phase4-3: webgl-domains.tsから動的に取得
 *
 * @deprecated Use getDomainsByTier('ultra-heavy') from webgl-domains.ts
 */
export const KNOWN_ULTRA_HEAVY_DOMAINS: readonly string[] = getDomainsByTier(
  'ultra-heavy'
).map((e) => e.domain);

/**
 * 既知のheavyドメイン（重いサイト）
 * Phase4-3: webgl-domains.tsから動的に取得
 *
 * @deprecated Use getDomainsByTier('heavy') from webgl-domains.ts
 */
export const KNOWN_HEAVY_DOMAINS: readonly string[] = getDomainsByTier(
  'heavy'
).map((e) => e.domain);

/**
 * URLからサイト種別（SiteTier）を判定する
 *
 * 事前検出結果に基づいてリトライ戦略の決定に使用するサイト種別を返す。
 *
 * @param url - 検査対象URL
 * @param preDetection - 事前検出結果（オプション、省略時は内部で計算）
 * @returns サイト種別（'normal' | 'webgl' | 'heavy' | 'ultra-heavy'）
 *
 * @example
 * ```typescript
 * detectSiteTier('https://resn.co.nz'); // 'ultra-heavy'
 * detectSiteTier('https://bruno-simon.com'); // 'heavy'
 * detectSiteTier('https://example.com/webgl/demo'); // 'webgl'
 * detectSiteTier('https://google.com'); // 'normal'
 * ```
 */
export function detectSiteTier(url: string, preDetection?: PreDetectionResult): SiteTier {
  // 事前検出結果を取得（未提供の場合は内部で計算）
  const detection = preDetection ?? preDetectWebGL(url);

  // 非WebGLサイトは通常処理
  if (!detection.isLikelyWebGL) {
    return 'normal';
  }

  // ドメインを抽出して詳細判定
  let normalizedUrl = url;
  if (!url.includes('://')) {
    normalizedUrl = 'https://' + url;
  }

  let domain: string | null = null;
  try {
    const urlObj = new URL(normalizedUrl);
    domain = urlObj.hostname.toLowerCase();
    if (domain.startsWith('www.')) {
      domain = domain.slice(4);
    }
  } catch {
    // URL解析失敗時はWebGL判定に基づく
    return detection.confidence >= 0.9 ? 'heavy' : 'webgl';
  }

  // ultra-heavyドメインチェック
  for (const ultraHeavyDomain of KNOWN_ULTRA_HEAVY_DOMAINS) {
    if (domain === ultraHeavyDomain || domain.endsWith('.' + ultraHeavyDomain)) {
      return 'ultra-heavy';
    }
  }

  // heavyドメインチェック
  for (const heavyDomain of KNOWN_HEAVY_DOMAINS) {
    if (domain === heavyDomain || domain.endsWith('.' + heavyDomain)) {
      return 'heavy';
    }
  }

  // 高信頼度のWebGL検出（confidence >= 1.0）はheavy扱い
  if (detection.confidence >= 1.0) {
    return 'heavy';
  }

  // その他のWebGLサイト
  return 'webgl';
}
