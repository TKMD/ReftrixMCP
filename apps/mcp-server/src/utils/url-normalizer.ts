// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * URL Normalization Utility (SSOT)
 *
 * DB保存・queue jobId 双方の URL 正規化を単一の SSOT (`normalizeUrlCore`) に集約する。
 * これにより queue 層 (`buildUrlStableJobId`) と DB 層 (`web_pages.url` upsert) が
 * 「同一 URL」と見なす集合がコードレベルで恒久一致し、coupling drift を構造排除する。
 *
 * Unifies URL normalization for both DB storage and queue jobId into a single
 * SSOT (`normalizeUrlCore`), so the sets the queue layer (`buildUrlStableJobId`)
 * and the DB layer (`web_pages.url` upsert) treat as "the same URL" stay
 * permanently aligned at the code level, structurally eliminating coupling drift.
 *
 * 正規化ルール (success path 7 ステップ):
 * 1. ホスト名を小文字に
 * 2. デフォルトポートを除去 (443 for https / 80 for http)
 * 3. フラグメント（#hash）を除去
 * 4. 連続スラッシュを単一スラッシュに
 * 5. クエリパラメータをアルファベット順にソート
 * 6. ルートパス "/" を空文字列に
 * 7. 末尾スラッシュを除去
 *
 * @module utils/url-normalizer
 */

/**
 * URL 正規化の SSOT (Single Source of Truth)。
 *
 * queue jobId (`buildUrlStableJobId` → uuidv5 namespace key) と DB 保存
 * (`web_pages.url` の `where` / `create.url`) の双方がこの core を経由する。
 * `normalizeUrlForStorage` / `normalizeUrlForValidation` はいずれも本関数への
 * 薄い wrapper であり、7 ステップの正規化ロジックは **本関数 1 箇所にのみ存在** する。
 *
 * **no-throw degraded-return 契約 (CWE-209 surface 非増)**:
 * `new URL(...)` が throw する parse-failure input (例: `"not a url"` / `"http://"` /
 * 制御文字を含む文字列) に対しては **例外を throw せず**、`trimmed.toLowerCase()` を
 * degraded result として返す。これにより parse-failure の生エラーが上位に漏れず、
 * 既存の防御 (error message を通じた情報露出の抑止) を維持する。
 *
 * **catch canonical = `trimmed.toLowerCase()`** (PR-L3 / ADR-0018 Amendment で固定):
 * URL の host は本来 case-insensitive (RFC 3986 §3.2.2) であるため、parse-failure
 * input でも lowercase を適用する方が「同一 URL を同一に解決する」SSOT の趣旨に整合する。
 *
 * This is the Single Source of Truth for URL normalization. Both the queue
 * jobId (`buildUrlStableJobId`) and DB storage (`web_pages.url`) route through
 * this core; the 7-step logic lives in **exactly one place** here. On
 * parse-failure it does **not** throw — it returns `trimmed.toLowerCase()` as a
 * degraded result (preserving the existing CWE-209 defense). The catch canonical
 * is `trimmed.toLowerCase()` (pinned in PR-L3 / ADR-0018 Amendment) because URL
 * hosts are case-insensitive (RFC 3986 §3.2.2).
 *
 * @param url - 正規化するURL / URL to normalize
 * @returns 正規化されたURL文字列 (parse-failure 時は `trimmed.toLowerCase()`) / normalized URL string (or `trimmed.toLowerCase()` on parse-failure)
 *
 * @example
 * ```typescript
 * normalizeUrlCore('https://Example.COM/Path?b=2&a=1#hash')
 * // => 'https://example.com/Path?a=1&b=2'
 *
 * normalizeUrlCore('HTTP://')   // parse-failure
 * // => 'http://'
 * ```
 */
/**
 * Step 5 helper: クエリパラメータをアルファベット順 (key→value) にソートして
 * 正規化済みクエリ文字列を返す (`?` prefix なし、クエリ無しは空文字列)。
 *
 * `normalizeUrlCore` から抽出した純粋関数 (behavior-不変 refactor, TDA-IMPL-L-01
 * CC ≤ 10)。SEVEN_STEP_MARKERS の `let sortedQuery =` literal を本 helper 内に保持し
 * INV-URL-NORMALIZE-SSOT-001 AST sweep の 7-step pin を満たす。
 *
 * Step 5 helper: sorts query params alphabetically (key then value) and returns
 * the normalized query string (no leading `?`; empty string when no query).
 * Extracted from `normalizeUrlCore` as a pure function (behaviour-invariant
 * refactor, TDA-IMPL-L-01 CC ≤ 10), keeping the `let sortedQuery =` marker inside
 * url-normalizer.ts so the INV-URL-NORMALIZE-SSOT-001 7-step AST sweep stays green.
 */
function sortQueryParams(urlObj: URL): string {
  let sortedQuery = "";
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
  return sortedQuery;
}

/**
 * Step 6+7 helper: ルートパス "/" を空文字列にし、末尾スラッシュを除去した
 * 正規化済み pathname を返す。
 *
 * `normalizeUrlCore` から抽出した純粋関数 (behavior-不変 refactor, TDA-IMPL-L-01
 * CC ≤ 10)。SEVEN_STEP_MARKERS の trailing-slash `replace(/\/+$/,...)` literal を
 * 本 helper 内に保持し INV-URL-NORMALIZE-SSOT-001 AST sweep の 7-step pin を満たす。
 *
 * Step 6+7 helper: collapses root path "/" to empty string and strips the
 * trailing slash, returning the normalized pathname. Extracted from
 * `normalizeUrlCore` as a pure function (behaviour-invariant refactor,
 * TDA-IMPL-L-01 CC ≤ 10), keeping the trailing-slash `replace(/\/+$/,...)` marker
 * inside url-normalizer.ts so the 7-step AST sweep stays green.
 */
function normalizePathname(pathname: string): string {
  // 6. ルートパス "/" を空文字列に
  let normalizedPath = pathname;
  if (normalizedPath === "/") {
    normalizedPath = "";
  }
  // 7. 末尾スラッシュを除去（パスがある場合のみ）
  if (normalizedPath.length > 1) {
    normalizedPath = normalizedPath.replace(/\/+$/, "");
  }
  return normalizedPath;
}

export function normalizeUrlCore(url: string): string {
  const trimmed = url.trim();

  try {
    const urlObj = new URL(trimmed);

    // 1. ホスト名を小文字に正規化
    urlObj.hostname = urlObj.hostname.toLowerCase();

    // 2. デフォルトポートを除去 (443 for https, 80 for http)
    if (
      (urlObj.protocol === "https:" && urlObj.port === "443") ||
      (urlObj.protocol === "http:" && urlObj.port === "80")
    ) {
      urlObj.port = "";
    }

    // 3. フラグメント（#hash）を除去
    urlObj.hash = "";

    // 4. パス正規化: 連続スラッシュを単一スラッシュに
    urlObj.pathname = urlObj.pathname.replace(/\/+/g, "/");

    // 5. クエリパラメータをアルファベット順にソート
    const sortedQuery = sortQueryParams(urlObj);

    // 6-7. ルートパス空文字化 + 末尾スラッシュ除去
    const normalizedPath = normalizePathname(urlObj.pathname);

    // 結果を手動で構築（URL objectのhrefを使わない）
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
    // parse-failure: throw せず degraded result を返す (catch canonical = lowercase)
    return trimmed.toLowerCase();
  }
}

/**
 * URLをDB保存用に正規化する (SSOT `normalizeUrlCore` への薄い wrapper)。
 *
 * `web_pages.url` の upsert `where` / `create.url` に用いる正規化済 URL を返す。
 * 実体は {@link normalizeUrlCore} であり、queue jobId と同一の正規化規約を共有する。
 *
 * Thin wrapper over the SSOT {@link normalizeUrlCore}; returns the normalized URL
 * used in the `web_pages.url` upsert `where` / `create.url`, sharing the exact
 * normalization contract with the queue jobId.
 *
 * @param url - 正規化するURL / URL to normalize
 * @returns 正規化されたURL文字列 / normalized URL string
 *
 * @example
 * ```typescript
 * normalizeUrlForStorage('https://example.com/')
 * // => 'https://example.com'
 *
 * normalizeUrlForStorage('https://Example.COM/Path?b=2&a=1#hash')
 * // => 'https://example.com/Path?a=1&b=2'
 * ```
 */
export function normalizeUrlForStorage(url: string): string {
  return normalizeUrlCore(url);
}
