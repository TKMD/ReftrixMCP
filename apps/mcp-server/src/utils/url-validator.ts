// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * URL検証ユーティリティ
 * SSRF (Server-Side Request Forgery) 対策のためのURL検証機能
 *
 * セキュリティ要件:
 * - プライベートIP、localhost、メタデータサービスへのアクセスをブロック
 * - http/https プロトコルのみ許可
 *
 * @see SEC監査指摘対応
 */

import { z } from 'zod';
import { logger, isDevelopment } from './logger';

// =============================================
// 型定義
// =============================================

/**
 * URL検証結果
 */
export interface UrlValidationResult {
  /** 検証成功フラグ */
  valid: boolean;
  /** エラーメッセージ（失敗時） */
  error?: string;
  /** 正規化されたURL（成功時） */
  normalizedUrl?: string;
}

// =============================================
// 定数定義
// =============================================

/**
 * ブロックするホスト名一覧
 * localhost、メタデータサービスなど
 */
export const BLOCKED_HOSTS: readonly string[] = [
  // ローカルホスト
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  // IPv6 localhost
  '::1',
  '[::1]',
  // AWS EC2 メタデータサービス
  '169.254.169.254',
  // GCP メタデータサービス
  'metadata.google.internal',
  // Azure メタデータサービス
  '169.254.169.254',
  // Link-local addresses
  '169.254.0.0',
  // Kubernetes
  'kubernetes.default.svc',
] as const;

/**
 * ブロックするIPレンジ（正規表現）
 * プライベートIP、ループバック、リンクローカルなど
 */
export const BLOCKED_IP_RANGES: readonly RegExp[] = [
  // 10.0.0.0/8 (クラスAプライベート)
  /^10\./,
  // 172.16.0.0/12 (クラスBプライベート)
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  // 192.168.0.0/16 (クラスCプライベート)
  /^192\.168\./,
  // 127.0.0.0/8 (ループバック)
  /^127\./,
  // 0.0.0.0/8
  /^0\./,
  // 169.254.0.0/16 (リンクローカル)
  /^169\.254\./,
] as const;

/**
 * ブロックするIPv6パターン
 * プライベート、ループバック、リンクローカル、トンネリングなど
 */
export const BLOCKED_IPV6_PATTERNS = {
  // ループバック ::1 (0:0:0:0:0:0:0:1 または ::1)
  LOOPBACK: /^(0{0,4}:){7}0{0,3}1$|^::1$/i,

  // リンクローカル fe80::/10 (fe80 - febf)
  LINK_LOCAL: /^fe[89ab][0-9a-f]:/i,

  // ユニークローカル fc00::/7 (fc00::/8 + fd00::/8)
  UNIQUE_LOCAL: /^f[cd][0-9a-f]{2}:/i,

  // 未指定アドレス :: (0:0:0:0:0:0:0:0)
  UNSPECIFIED: /^(0{0,4}:){7}0{0,4}$|^::0?$|^0::0?$/i,

  // マルチキャスト ff00::/8
  MULTICAST: /^ff[0-9a-f]{2}:/i,

  // Teredo 2001:0::/32
  TEREDO: /^2001:0{1,4}:/i,

  // 6to4 2002::/16
  SIX_TO_FOUR: /^2002:/i,
} as const;

/**
 * 許可されるプロトコル
 */
const ALLOWED_PROTOCOLS = ['http:', 'https:'] as const;

// =============================================
// ヘルパー関数
// =============================================

/**
 * 文字列がIPv4アドレス形式かどうかを判定
 */
function isIPv4Address(host: string): boolean {
  // IPv4形式: x.x.x.x (各オクテットは0-255)
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = host.match(ipv4Regex);
  if (!match) return false;

  // 各オクテットが0-255の範囲内かチェック
  for (let i = 1; i <= 4; i++) {
    const octetStr = match[i];
    if (!octetStr) return false;
    const octet = parseInt(octetStr, 10);
    if (octet < 0 || octet > 255) return false;
  }
  return true;
}

/**
 * 文字列がIPv6アドレス形式かどうかを判定
 * 角括弧付き（[::1]）も対応
 */
function isIPv6Address(host: string): boolean {
  // 角括弧を除去
  const cleaned = host.replace(/^\[|\]$/g, '');

  // IPv6形式の判定
  // - コロンを含む必要がある
  if (!cleaned.includes(':')) return false;

  // IPv4マップドIPv6 (::ffff:x.x.x.x) または IPv4互換IPv6 (::x.x.x.x)
  if (cleaned.includes('.')) {
    // ::ffff:192.168.1.1 形式
    const ipv4MappedRegex =
      /^(::ffff:|::)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i;
    if (ipv4MappedRegex.test(cleaned)) {
      return true;
    }
    // IPv4部分が含まれるその他の形式も許容
  }

  // 標準的なIPv6形式
  // 完全形式: 2001:0db8:0000:0000:0000:0000:0000:0001
  // 圧縮形式: 2001:db8::1, ::1, fe80::1, ::
  // 16進数形式のIPv4マップド: ::ffff:7f00:1

  // 基本的な構造チェック
  // セグメントは最大8つ（::を使用する場合は少なくなる）
  const segments = cleaned.split(':');

  // :: が含まれているか
  const hasDoubleColon = cleaned.includes('::');

  // :: は1回のみ許可
  const doubleColonCount = (cleaned.match(/::/g) || []).length;
  if (doubleColonCount > 1) return false;

  // セグメント数のチェック
  if (hasDoubleColon) {
    // :: を使用する場合、残りのセグメントは8未満
    const nonEmptySegments = segments.filter((s) => s !== '').length;
    if (nonEmptySegments > 7) return false;
  } else {
    // :: を使用しない場合、セグメントは正確に8つ
    if (segments.length !== 8) return false;
  }

  // 各セグメントが有効な16進数（0-4桁）か、空文字（::の一部）かチェック
  for (const segment of segments) {
    // 空のセグメントは :: の一部として許容
    if (segment === '') continue;

    // IPv4部分のチェック（最後のセグメントの場合）
    if (segment.includes('.')) {
      const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
      if (!ipv4Regex.test(segment)) return false;
      continue;
    }

    // 16進数セグメント（1-4桁）
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) return false;
  }

  return true;
}

/**
 * IPv6アドレスを完全形式に展開
 * 例: ::1 -> 0000:0000:0000:0000:0000:0000:0000:0001
 */
function expandIPv6(ipv6: string): string {
  // IPv4マップド/互換形式は特別処理
  if (ipv6.includes('.')) {
    return ipv6; // そのまま返す
  }

  let parts = ipv6.split(':');

  // :: の展開
  const doubleColonIndex = ipv6.indexOf('::');
  if (doubleColonIndex !== -1) {
    const before = ipv6.slice(0, doubleColonIndex).split(':').filter(Boolean);
    const after = ipv6.slice(doubleColonIndex + 2).split(':').filter(Boolean);
    const zerosNeeded = 8 - before.length - after.length;
    const zeros = Array(Math.max(0, zerosNeeded)).fill('0000');
    parts = [...before, ...zeros, ...after];
  }

  // 各パートを4桁にパディング
  return parts.map((p) => p.padStart(4, '0')).join(':');
}

/**
 * IPv6アドレスがブロックされるレンジに含まれているかチェック
 *
 * @param ipv6 - チェックするIPv6アドレス（角括弧なし）
 * @returns ブロックされている場合 true
 */
export function isBlockedIPv6Range(ipv6: string): boolean {
  const cleaned = ipv6.toLowerCase().replace(/^\[|\]$/g, '');

  // IPv6形式でない場合はfalse
  if (!isIPv6Address(cleaned)) {
    return false;
  }

  // IPv6アドレスを展開（圧縮形式を完全形式に）
  const expanded = expandIPv6(cleaned);

  // 各パターンをチェック
  for (const pattern of Object.values(BLOCKED_IPV6_PATTERNS)) {
    if (pattern.test(expanded) || pattern.test(cleaned)) {
      return true;
    }
  }

  // IPv4マップドIPv6 (::ffff:x.x.x.x) のチェック
  const ipv4MappedMatch = cleaned.match(
    /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i
  );
  if (ipv4MappedMatch && ipv4MappedMatch[1]) {
    // 埋め込まれたIPv4がブロック対象かチェック
    if (isBlockedHost(ipv4MappedMatch[1]) || isBlockedIPv4Range(ipv4MappedMatch[1])) {
      return true;
    }
  }

  // IPv4互換IPv6 (::x.x.x.x) のチェック
  const ipv4CompatMatch = cleaned.match(
    /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/
  );
  if (ipv4CompatMatch && ipv4CompatMatch[1]) {
    if (isBlockedHost(ipv4CompatMatch[1]) || isBlockedIPv4Range(ipv4CompatMatch[1])) {
      return true;
    }
  }

  // 16進数形式のIPv4マップドIPv6 (::ffff:7f00:1) のチェック
  const hexMappedMatch = cleaned.match(
    /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i
  );
  if (hexMappedMatch && hexMappedMatch[1] && hexMappedMatch[2]) {
    const high = parseInt(hexMappedMatch[1], 16);
    const low = parseInt(hexMappedMatch[2], 16);
    const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    if (isBlockedHost(ipv4) || isBlockedIPv4Range(ipv4)) {
      return true;
    }
  }

  // IPv4互換IPv6の16進数形式 (::c0a8:101 = ::192.168.1.1) のチェック
  // URL APIがIPv4互換IPv6を16進数形式に変換する場合に対応
  const hexCompatMatch = cleaned.match(
    /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i
  );
  if (hexCompatMatch && hexCompatMatch[1] && hexCompatMatch[2]) {
    const high = parseInt(hexCompatMatch[1], 16);
    const low = parseInt(hexCompatMatch[2], 16);
    const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    if (isBlockedHost(ipv4) || isBlockedIPv4Range(ipv4)) {
      return true;
    }
  }

  return false;
}

/**
 * IPv4アドレスがブロックされるレンジに含まれているかチェック（内部関数）
 *
 * @param ip - チェックするIPv4アドレス
 * @returns ブロックされている場合 true
 */
function isBlockedIPv4Range(ip: string): boolean {
  // IPアドレス形式でない場合はfalse
  if (!isIPv4Address(ip)) {
    return false;
  }

  // 各レンジをチェック
  for (const range of BLOCKED_IP_RANGES) {
    if (range.test(ip)) {
      return true;
    }
  }

  return false;
}

/**
 * ホスト名がブロックリストに含まれているかチェック
 *
 * @param host - チェックするホスト名
 * @returns ブロックされている場合 true
 */
export function isBlockedHost(host: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/^\[|\]$/g, '');

  // 直接一致チェック
  if (BLOCKED_HOSTS.includes(normalizedHost)) {
    return true;
  }

  // メタデータサービスの部分一致チェック
  if (normalizedHost.includes('metadata.google.internal')) {
    return true;
  }

  return false;
}

/**
 * IPアドレスがブロックされるレンジに含まれているかチェック
 * IPv4とIPv6の両方に対応
 *
 * @param ip - チェックするIPアドレス
 * @returns ブロックされている場合 true
 */
export function isBlockedIpRange(ip: string): boolean {
  // IPv6チェックを先に行う
  if (isIPv6Address(ip)) {
    return isBlockedIPv6Range(ip);
  }

  // IPv4形式でない場合はfalse
  if (!isIPv4Address(ip)) {
    return false;
  }

  // IPv4レンジチェック
  return isBlockedIPv4Range(ip);
}

/**
 * URLを検証用に正規化
 *
 * @param url - 正規化するURL
 * @returns 正規化されたURL文字列
 */
export function normalizeUrlForValidation(url: string): string {
  const trimmed = url.trim();

  try {
    const urlObj = new URL(trimmed);

    // 1. ホスト名を小文字に正規化
    urlObj.hostname = urlObj.hostname.toLowerCase();

    // 2. デフォルトポートを除去 (443 for https, 80 for http)
    if (
      (urlObj.protocol === 'https:' && urlObj.port === '443') ||
      (urlObj.protocol === 'http:' && urlObj.port === '80')
    ) {
      urlObj.port = '';
    }

    // 3. フラグメント（#hash）を除去
    urlObj.hash = '';

    // 4. パス正規化: 連続スラッシュを単一スラッシュに
    urlObj.pathname = urlObj.pathname.replace(/\/+/g, '/');

    // 5. クエリパラメータをアルファベット順にソート
    let sortedQuery = '';
    if (urlObj.search) {
      const params = urlObj.searchParams;
      const entries = Array.from(params.entries());

      // パラメータ名でソート、同じ名前の場合は値でソート
      entries.sort((a, b) => {
        const keyCompare = a[0].localeCompare(b[0]);
        if (keyCompare !== 0) return keyCompare;
        return a[1].localeCompare(b[1]);
      });

      const sortedParams = new URLSearchParams();
      for (const [key, value] of entries) {
        sortedParams.append(key, value);
      }
      sortedQuery = sortedParams.toString();
    }

    // 6. パスを正規化（ルートパス "/" のみの場合は空に）
    let normalizedPath = urlObj.pathname;
    if (normalizedPath === '/') {
      normalizedPath = '';
    }
    // 末尾スラッシュを除去（パスがある場合のみ）
    if (normalizedPath.length > 1) {
      normalizedPath = normalizedPath.replace(/\/+$/, '');
    }

    // 7. 結果を手動で構築（URL objectのhrefを使わない）
    let result = `${urlObj.protocol}//${urlObj.hostname}`;

    // ポートを追加（非デフォルトポートのみ）
    if (urlObj.port) {
      result += `:${urlObj.port}`;
    }

    // パスを追加
    result += normalizedPath;

    // クエリを追加
    if (sortedQuery) {
      result += `?${sortedQuery}`;
    }

    return result;
  } catch {
    // URL解析に失敗した場合はそのまま返す
    return trimmed.toLowerCase();
  }
}

// =============================================
// メイン検証関数
// =============================================

/**
 * 外部URLの安全性を検証
 *
 * SSRF対策として以下をチェック:
 * - プロトコル (http/https のみ許可)
 * - ブロックされたホスト (localhost, メタデータサービスなど)
 * - プライベートIPレンジ (10.x, 172.16-31.x, 192.168.x など)
 *
 * @param url - 検証するURL
 * @returns 検証結果
 *
 * @example
 * ```typescript
 * const result = validateExternalUrl('https://example.com');
 * if (result.valid) {
 *   console.log('URL is safe:', result.normalizedUrl);
 * } else {
 *   console.error('URL blocked:', result.error);
 * }
 * ```
 */
export function validateExternalUrl(url: string): UrlValidationResult {
  // 空チェック
  if (!url || url.trim() === '') {
    return {
      valid: false,
      error: 'URL is empty: URL cannot be empty or whitespace only',
    };
  }

  const trimmedUrl = url.trim();

  // プロトコルチェック（プロトコルなしの場合）
  if (!trimmedUrl.includes('://')) {
    return {
      valid: false,
      error: 'Invalid protocol: URL must start with http:// or https://',
    };
  }

  // URL解析
  let urlObj: URL;
  try {
    urlObj = new URL(trimmedUrl);
  } catch {
    if (isDevelopment()) {
      logger.debug('[url-validator] Failed to parse URL', { url: trimmedUrl });
    }
    return {
      valid: false,
      error: 'Invalid URL format: unable to parse URL',
    };
  }

  // プロトコル検証
  if (!ALLOWED_PROTOCOLS.includes(urlObj.protocol as 'http:' | 'https:')) {
    return {
      valid: false,
      error: `Invalid protocol: only http and https are allowed, got ${urlObj.protocol}`,
    };
  }

  // ホスト名取得（ポート除去）
  const hostname = urlObj.hostname.toLowerCase();

  // 空のホスト名チェック
  if (!hostname || hostname === '' || hostname === '.' || hostname === '..') {
    return {
      valid: false,
      error: 'Invalid URL format: hostname is empty or invalid',
    };
  }

  // ホスト名の基本的な妥当性チェック（ドットのみは無効）
  if (/^\.+$/.test(hostname)) {
    return {
      valid: false,
      error: 'Invalid URL format: hostname contains only dots',
    };
  }

  // ブロックホストチェック
  if (isBlockedHost(hostname)) {
    if (isDevelopment()) {
      logger.warn('[url-validator] Blocked host detected', { hostname });
    }
    return {
      valid: false,
      error: `URL is blocked: ${hostname} is not allowed`,
    };
  }

  // IPレンジチェック（IPv4アドレス形式の場合）
  if (isIPv4Address(hostname)) {
    if (isBlockedIpRange(hostname)) {
      if (isDevelopment()) {
        logger.warn('[url-validator] Blocked IP range detected', { hostname });
      }
      return {
        valid: false,
        error: `URL is blocked: private IP range ${hostname} is not allowed`,
      };
    }
  }

  // IPv6レンジチェック
  // URL APIはIPv6ホスト名に角括弧を保持する（例: "[fe80::1]"）
  // isIPv6Address/isBlockedIPv6Rangeは角括弧付きでも正しく処理する
  if (isIPv6Address(hostname)) {
    if (isBlockedIPv6Range(hostname)) {
      if (isDevelopment()) {
        logger.warn('[url-validator] Blocked IPv6 range detected', { hostname });
      }
      return {
        valid: false,
        error: `URL is blocked: IPv6 address ${hostname} is not allowed`,
      };
    }
  }

  // URLエンコードされた危険なパターンのチェック
  const decodedUrl = decodeURIComponent(trimmedUrl).toLowerCase();
  if (
    decodedUrl.includes('localhost') ||
    decodedUrl.includes('127.0.0.1') ||
    decodedUrl.includes('169.254.169.254')
  ) {
    // 実際のホスト名とデコード後で異なる場合は疑わしい
    if (!hostname.includes('localhost') && !hostname.includes('127.0.0.1')) {
      return {
        valid: false,
        error: 'URL is blocked: suspicious URL encoding detected',
      };
    }
  }

  // 正規化されたURLを返す
  const normalizedUrl = normalizeUrlForValidation(trimmedUrl);

  if (isDevelopment()) {
    logger.debug('[url-validator] URL validated successfully', {
      original: trimmedUrl,
      normalized: normalizedUrl,
    });
  }

  return {
    valid: true,
    normalizedUrl,
  };
}

// =============================================
// Zodスキーマ（オプション）
// =============================================

/**
 * 安全なURL検証用Zodスキーマ
 * バリデーション時にSSRFチェックを行う
 */
export const safeUrlSchema = z.string().refine(
  (url) => {
    const result = validateExternalUrl(url);
    return result.valid;
  },
  (url) => {
    const result = validateExternalUrl(url);
    return { message: result.error ?? 'Invalid URL' };
  }
);

// =============================================
// 開発環境ログ
// =============================================

if (isDevelopment()) {
  logger.debug('[url-validator] Module loaded', {
    blockedHostsCount: BLOCKED_HOSTS.length,
    blockedIpRangesCount: BLOCKED_IP_RANGES.length,
  });
}
