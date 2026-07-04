// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * embedding-failure-response — tool層 SSOT for the fail-loud embedding-failure response
 * tool層 検索 embedding 障害の fail-loud 応答の単一の真実の源泉 (SSOT)
 *
 * ADR-0043 (search embedding-failure response contract) / plan v4 §4.2 / §4.3.
 *
 * embedding 必須の検索 leaf consumer (layout / part visual·hybrid / background /
 * responsive + 各 search-executor) が、embedding が `unavailable` / `failed` のとき
 * `success:false` を返すための共通 builder。`degradedReason`
 * (`embedding_unavailable` | `embedding_failed`) と error code を一貫させ、
 * 各 leaf の copy-paste な分岐を 1 source に集約する (drift 防止)。
 *
 * The single source of truth (SSOT) for the tool-layer fail-loud embedding-failure
 * response, used by the embedding-required search leaf consumers. It keeps the
 * `degradedReason` (`embedding_unavailable` | `embedding_failed`) and error code
 * consistent across leaves so that the per-leaf branching is consolidated.
 *
 * **CWE-209 + GDPR Art.5(1)(c)**: `buildEmbeddingFailureError` returns only a generic,
 * non-PII message. The query body and any query-derived string are never bound here.
 * For the `failed` case, the underlying error string was already sanitized via
 * `sanitizeErrorMessage` upstream (in `resolveQueryEmbedding`); this helper never
 * re-introduces raw error text, `libonnxruntime`, `.so`, or a stack trace.
 *
 * @module tools/_shared/embedding-failure-response
 */

import type { DegradedReason } from "../../services/_shared/resolve-query-embedding";
import { toDegradedReason } from "../../services/_shared/resolve-query-embedding";

/**
 * embedding 障害応答の error code (全 leaf tool で共通の `EMBEDDING_FAILED` /
 * `SERVICE_UNAVAILABLE` literal に一致、`*_MCP_ERROR_CODES` と互換)。
 */
export const EMBEDDING_FAILURE_CODE = {
  /** embedding service 未配線 (factory 不在) */
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  /** embedding 生成 throw = インフラ障害 */
  EMBEDDING_FAILED: "EMBEDDING_FAILED",
} as const;

export type EmbeddingFailureCode =
  (typeof EMBEDDING_FAILURE_CODE)[keyof typeof EMBEDDING_FAILURE_CODE];

/**
 * tool 層 fail-loud 応答の error 部 (各 leaf tool の `error: { code, message }` 形に
 * 加えて degradedReason を additive に持つ)。
 */
export interface EmbeddingFailureError {
  code: EmbeddingFailureCode;
  message: string;
  /** DegradedReason enum union (UB-V1-5、free-form string 混入を型レベルで排除) */
  degradedReason: DegradedReason;
}

/**
 * embedding 障害応答 (`success:false`) の generic 安全メッセージ
 * (CWE-209: query 本文・内部構造を一切含まない固定文言)。
 */
const FAILURE_MESSAGE: Record<DegradedReason, string> = {
  embedding_unavailable: "Query embedding service is unavailable",
  embedding_failed: "Query embedding generation failed",
};

/**
 * embedding 解決の非-ok status から fail-loud 応答の error 部を構築する。
 *
 * @param status - `unavailable` (factory 不在) | `failed` (生成 throw)
 * @returns code / message / degradedReason
 */
export function buildEmbeddingFailureError(
  status: "unavailable" | "failed"
): EmbeddingFailureError {
  const degradedReason = toDegradedReason(status);
  const code =
    status === "unavailable"
      ? EMBEDDING_FAILURE_CODE.SERVICE_UNAVAILABLE
      : EMBEDDING_FAILURE_CODE.EMBEDDING_FAILED;
  return {
    code,
    message: FAILURE_MESSAGE[degradedReason],
    degradedReason,
  };
}

/**
 * part の embedding 必須性マトリクス (plan v4 §4.3.3)。
 * - `text`         → embedding optional (fulltext fallback 可、success:true 正当)
 * - `visual`/`hybrid` → embedding required (失敗時 success:false)
 *
 * @param searchMode - part.search の search_mode
 * @returns embedding が必須なら true
 */
export function isPartEmbeddingRequired(searchMode: "visual" | "text" | "hybrid"): boolean {
  return searchMode !== "text";
}
