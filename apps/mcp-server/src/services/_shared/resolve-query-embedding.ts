// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * resolveQueryEmbedding — service層 SSOT for query embedding resolution
 * service層 検索 query embedding 解決の単一の真実の源泉 (SSOT)
 *
 * ADR-0043 (search embedding-failure response contract) / plan v4 §4.1.
 *
 * 5 個の embedding 必須検索 service (layout / background / responsive / part / motion) が
 * 共通で使う query embedding 解決ヘルパー。embedding が
 *   - service 未配線 (factory 不在) → { status: "unavailable" }
 *   - 生成 throw (インフラ障害)       → { status: "failed", reason }
 *   - 生成成功                         → { status: "ok", embedding }
 * の discriminated union を返し、各 service の copy-paste な
 * `catch → return null` swallow を 1 source に集約する (TDA-Plan-M-1/M-2, drift 防止)。
 *
 * The single source of truth (SSOT) for resolving a query embedding, shared by the
 * 5 embedding-required search services (layout / background / responsive / part / motion).
 * It returns a discriminated union (ok / unavailable / failed) so that each service's
 * copy-paste `catch → return null` swallow is consolidated into a single source.
 *
 * **CWE-209 + GDPR Art.5(1)(c) contract (ADR-0043 Decision 5)**: the `failed.reason`
 * is produced ONLY via `sanitizeErrorMessage(error)`. It binds NO query body / no
 * query-derived string, and contains no `libonnxruntime` / `.so` / stack trace.
 * Validate (`validateEmbeddingVector`) is intentionally performed OUTSIDE this helper
 * by callers that need a distinct `EmbeddingValidationError` (e.g. motion, §4.5.2
 * 選択肢 B); this helper does not validate.
 *
 * @module services/_shared/resolve-query-embedding
 */

import { sanitizeErrorMessage } from "../../utils/sanitize-error";

/**
 * degraded 理由の enum union (machine-enforce、free-form string 混入を型レベルで排除)
 * SEC-RE-L-4 / UB-V1-5. The tool-layer response's `degradedReason` and the
 * aggregator's `degradedServices[].reason` MUST bind to this type.
 */
export type DegradedReason = "embedding_unavailable" | "embedding_failed";

/**
 * query embedding 解決結果 (discriminated union、型による 3 区別)
 * - ok          : embedding 生成成功
 * - unavailable : service 未配線 (factory 不在)
 * - failed      : 生成 throw = インフラ障害 (reason は sanitizeErrorMessage 経由のみ)
 */
export type QueryEmbeddingResult =
  | { status: "ok"; embedding: number[] }
  | { status: "unavailable" }
  | { status: "failed"; reason: string };

/**
 * 最小 embedding service 形 (5 service の各 interface が満たす共通契約)
 */
export interface QueryEmbeddingCapable {
  generateEmbedding(text: string, type: "query" | "passage"): Promise<number[]>;
}

/**
 * query embedding を解決する SSOT helper。
 *
 * @typeParam TService - 各 service 固有の embedding service interface (共通契約を満たす)
 * @param factory  - embedding service factory (未配線時は null = unavailable)
 * @param generate - factory が生成した service から embedding を得るコールバック
 * @returns ok / unavailable / failed の discriminated union
 */
export async function resolveQueryEmbedding<TService extends QueryEmbeddingCapable>(
  factory: (() => TService) | null,
  generate: (svc: TService) => Promise<number[]>
): Promise<QueryEmbeddingResult> {
  if (!factory) {
    return { status: "unavailable" };
  }
  try {
    const embedding = await generate(factory());
    return { status: "ok", embedding };
  } catch (error) {
    // CWE-209 (CWE-209 information exposure) + GDPR Art.5(1)(c) data-minimisation:
    // reason は sanitizeErrorMessage 経由のみ。query 本文・query 由来文字列を一切 bind しない。
    return { status: "failed", reason: sanitizeErrorMessage(error) };
  }
}

/**
 * QueryEmbeddingResult の非-ok status を tool 層 / aggregator 用の DegradedReason へ写像。
 * Maps a non-ok status to the tool-layer / aggregator `DegradedReason`.
 */
export function toDegradedReason(status: "unavailable" | "failed"): DegradedReason {
  return status === "unavailable" ? "embedding_unavailable" : "embedding_failed";
}
