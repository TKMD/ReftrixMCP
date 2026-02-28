// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * リトライ戦略
 *
 * page.analyze のリトライ動作を制御するための戦略パターン。
 * サイトの種類（SiteTier）に応じて適切なリトライ設定を提供する。
 *
 * 主な目的:
 * - タイムアウト累積を防止してMCP 600秒上限を遵守
 * - WebGL/重量サイトでのリトライ回数削減
 * - ネットワークエラーとタイムアウトエラーの区別
 *
 * @module tools/page/handlers/retry-strategy
 */

/**
 * リトライ戦略の設定インターフェース
 */
export interface RetryStrategyConfig {
  /** 自動リトライを有効にするか */
  autoRetry: boolean;
  /** 最大リトライ回数（0の場合はリトライなし） */
  maxRetries: number;
  /** リトライ時のタイムアウト乗数（1.0=累積なし, 1.5=従来動作） */
  timeoutMultiplier: number;
  /** リトライ間の待機時間（ミリ秒） */
  waitBetweenRetriesMs: number;
  /** ネットワークエラーのみリトライするか（true=タイムアウトはリトライしない） */
  retryOnlyOnNetworkError: boolean;
}

/**
 * サイトの種類（重さ）を表す型
 *
 * - normal: 通常のWebサイト（60秒以内で取得可能）
 * - webgl: WebGL/Three.jsサイト（120秒程度かかる）
 * - heavy: 重いWebGL/3Dサイト（180秒程度かかる）
 * - ultra-heavy: 非常に重いサイト（resn.co.nz等、180秒+でもタイムアウトする可能性）
 */
export type SiteTier = 'normal' | 'webgl' | 'heavy' | 'ultra-heavy';

/**
 * サイトの種類に応じたリトライ戦略を取得する
 *
 * @param siteTier - サイトの種類
 * @returns リトライ戦略の設定
 *
 * @example
 * ```typescript
 * const config = getRetryStrategy('ultra-heavy');
 * // {
 * //   autoRetry: true,
 * //   maxRetries: 1,
 * //   timeoutMultiplier: 1.0,  // 累積なし
 * //   waitBetweenRetriesMs: 5000,
 * //   retryOnlyOnNetworkError: true,
 * // }
 * ```
 */
export function getRetryStrategy(siteTier: SiteTier): RetryStrategyConfig {
  switch (siteTier) {
    case 'ultra-heavy':
      // 非常に重いサイト: リトライ1回、タイムアウト累積なし、ネットワークエラーのみ
      // 目的: MCP 600秒上限を確実に遵守
      return {
        autoRetry: true,
        maxRetries: 1,
        timeoutMultiplier: 1.0, // 累積なし
        waitBetweenRetriesMs: 5000,
        retryOnlyOnNetworkError: true,
      };

    case 'heavy':
      // 重いサイト: リトライ1回、タイムアウト累積なし、ネットワークエラーのみ
      return {
        autoRetry: true,
        maxRetries: 1,
        timeoutMultiplier: 1.0, // 累積なし
        waitBetweenRetriesMs: 3000,
        retryOnlyOnNetworkError: true,
      };

    case 'webgl':
      // WebGL/Three.jsサイト: リトライ2回、軽い累積、全エラーでリトライ
      return {
        autoRetry: true,
        maxRetries: 2,
        timeoutMultiplier: 1.2, // 軽い累積（1.5より控えめ）
        waitBetweenRetriesMs: 2000,
        retryOnlyOnNetworkError: false,
      };

    case 'normal':
    default:
      // 通常サイト: 従来動作（リトライ2回、1.5倍累積）
      return {
        autoRetry: true,
        maxRetries: 2,
        timeoutMultiplier: 1.5,
        waitBetweenRetriesMs: 1000,
        retryOnlyOnNetworkError: false,
      };
  }
}

/**
 * ネットワークエラーパターン
 * これらのパターンにマッチするエラーメッセージはネットワークエラーと判断される
 */
const NETWORK_ERROR_PATTERNS: readonly string[] = [
  'net::err_',
  'econnrefused',
  'etimedout',
  'enotfound',
  'network',
  'socket',
  'econnreset',
  'econnaborted',
  'dns',
  'ehostunreach',
] as const;

/**
 * エラーがネットワークエラーかどうかを判定する
 *
 * @param error - 検査対象のエラー
 * @returns ネットワークエラーの場合はtrue
 *
 * @example
 * ```typescript
 * isNetworkError(new Error('net::ERR_CONNECTION_REFUSED')); // true
 * isNetworkError(new Error('Timeout waiting for page')); // false
 * isNetworkError('not an error'); // false
 * ```
 */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  return NETWORK_ERROR_PATTERNS.some((pattern) =>
    message.includes(pattern.toLowerCase())
  );
}

/**
 * 最大総所要時間を計算する
 *
 * リトライ戦略に基づいて、最悪ケースの総所要時間を計算する。
 * MCP 600秒上限との比較に使用する。
 *
 * @param baseTimeoutMs - 基本タイムアウト（ミリ秒）
 * @param config - リトライ戦略設定
 * @returns 最大総所要時間（ミリ秒）
 *
 * @example
 * ```typescript
 * const config = getRetryStrategy('ultra-heavy');
 * const maxTime = calculateMaxTotalTime(180000, config);
 * // 180000 + 180000 + 5000 = 365000ms (365秒)
 * ```
 */
export function calculateMaxTotalTime(
  baseTimeoutMs: number,
  config: RetryStrategyConfig
): number {
  let totalTime = 0;
  let currentTimeout = baseTimeoutMs;

  // 初回試行
  totalTime += currentTimeout;

  // リトライ回数分のループ
  for (let retry = 0; retry < config.maxRetries; retry++) {
    // 待機時間を加算
    totalTime += config.waitBetweenRetriesMs;

    // タイムアウトを乗数で増加
    currentTimeout = currentTimeout * config.timeoutMultiplier;
    totalTime += currentTimeout;
  }

  return totalTime;
}

/**
 * リトライすべきかどうかを判定する
 *
 * @param error - 発生したエラー
 * @param currentAttempt - 現在の試行回数（0-indexed）
 * @param config - リトライ戦略設定
 * @returns リトライすべき場合はtrue
 *
 * @example
 * ```typescript
 * const config = getRetryStrategy('ultra-heavy');
 * shouldRetry(new Error('net::ERR_...'), 0, config); // true (ネットワークエラー)
 * shouldRetry(new Error('Timeout'), 0, config); // false (タイムアウトはリトライしない)
 * shouldRetry(new Error('net::ERR_...'), 1, config); // false (maxRetries=1に到達)
 * ```
 */
export function shouldRetry(
  error: unknown,
  currentAttempt: number,
  config: RetryStrategyConfig
): boolean {
  // 自動リトライが無効
  if (!config.autoRetry) {
    return false;
  }

  // 最大リトライ回数に到達
  if (currentAttempt >= config.maxRetries) {
    return false;
  }

  // ネットワークエラーのみリトライする設定の場合
  if (config.retryOnlyOnNetworkError) {
    return isNetworkError(error);
  }

  // 全エラーでリトライ
  return true;
}
