// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * URL Normalization Utility
 *
 * DB保存前にURLを正規化し、末尾スラッシュ等による重複を防止する。
 *
 * 正規化ルール:
 * 1. 末尾スラッシュを除去（ルートドメインの場合も除去: https://example.com/ → https://example.com）
 * 2. ホスト名を小文字に
 * 3. デフォルトポートを除去
 * 4. フラグメント（#hash）を除去
 * 5. 連続スラッシュを単一スラッシュに
 * 6. クエリパラメータをアルファベット順にソート
 *
 * @module utils/url-normalizer
 */

/**
 * URLをDB保存用に正規化する
 *
 * 既存の normalizeUrlForValidation と同じロジックだが、
 * DB保存専用のエントリポイントとして明確化。
 *
 * @param url - 正規化するURL
 * @returns 正規化されたURL文字列
 *
 * @example
 * ```typescript
 * normalizeUrlForStorage('https://example.com/')
 * // => 'https://example.com'
 *
 * normalizeUrlForStorage('https://example.com/path/')
 * // => 'https://example.com/path'
 *
 * normalizeUrlForStorage('https://Example.COM/Path?b=2&a=1#hash')
 * // => 'https://example.com/Path?a=1&b=2'
 * ```
 */
export function normalizeUrlForStorage(url: string): string {
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

    // 6. 末尾スラッシュを除去（全てのケース）
    let normalizedPath = urlObj.pathname;
    // ルートパス "/" → 空文字列
    if (normalizedPath === '/') {
      normalizedPath = '';
    }
    // パスがある場合は末尾スラッシュを除去
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
    // URL解析に失敗した場合はトリミングして返す
    return trimmed;
  }
}
