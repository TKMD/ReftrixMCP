// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * search.unified MCPツール / search.unified MCP Tool
 *
 * Part/Section(Layout)/Motion/Background/Narrativeを横断的に検索する統一エンドポイント。
 * 既存の個別検索サービスをオーケストレーションし、
 * 結果をスコア順にマージして返却します。
 *
 * Cross-component unified search endpoint that orchestrates
 * layout.search, part.search, motion.search, background.search,
 * and narrative.search in parallel, merging results by similarity score.
 *
 * @module tools/search-unified.tool
 */

import { z } from "zod";
import { logger, isDevelopment } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import type { DegradedReason } from "../services/_shared/resolve-query-embedding";
import { layoutSearchHandler } from "./layout/search.tool";
import { partSearchHandler } from "./part/search.tool";
import { motionSearchHandler } from "./motion/search.tool";
import { backgroundSearchHandler } from "./background/search.tool";
import { narrativeSearchHandler } from "./narrative/search.tool";
import {
  generateCacheKey,
  getCachedResult,
  setCachedResult,
} from "../services/search-cache.service";
import { understandQuery, type QueryType } from "../services/search/query-understanding.service";
import { applyCrossEncoderReranking } from "../services/search/cross-encoder-rerank.service";
import {
  computeFacetsFromResults,
  SUPPORTED_FACET_FIELDS,
  type FacetCounts,
  type FacetField,
} from "../services/facet.service";
import { logSearch } from "../services/search-log.service";

// ============================================================================
// Input Schema
// ============================================================================

/**
 * 検索対象タイプ / Search target types
 */
const searchTargetTypeSchema = z.enum(["layout", "part", "motion", "background", "narrative"]);

/**
 * ファセットフィールドスキーマ / Facet field schema
 */
const facetFieldSchema = z.enum(["sectionType", "industry", "audience", "tags"]);

/**
 * search.unified 入力スキーマ / search.unified input schema
 */
export const searchUnifiedInputSchema = z.object({
  /** 検索クエリ（自然言語、1-500文字） / Search query (natural language, 1-500 chars) */
  query: z.string().min(1).max(500),
  /** 検索対象タイプ（デフォルト: 全タイプ） / Target types (default: all types) */
  types: z.array(searchTargetTypeSchema).min(1).optional(),
  /** 取得件数（1-50、デフォルト: 10） / Result limit (1-50, default: 10) */
  limit: z.number().int().min(1).max(50).default(10),
  /** WebページIDでフィルター / Filter by web page ID */
  webPageId: z.string().uuid().optional(),
  /** 業種フィルター / Industry filter */
  industry: z.string().max(100).optional(),
  /** ターゲットオーディエンスフィルター / Target audience filter */
  audience: z.string().max(100).optional(),
  /** タグフィルター / Tags filter */
  tags: z.array(z.string()).max(10).optional(),
  /** 嗜好プロファイルID / Preference profile ID */
  profile_id: z.string().uuid().optional(),
  /** Cross-Encoderリランキング有効化（デフォルト: true） / Enable Cross-Encoder reranking (default: true) */
  enable_reranking: z.boolean().default(true),
  /** クエリタイプ（auto: 自動分類） / Query type (auto: auto-classify) */
  query_type: z.enum(["auto", "visual", "structural", "functional", "stylistic"]).default("auto"),
  /** ファセットカウント付与（デフォルト: false） / Include facet counts (default: false) */
  include_facets: z.boolean().default(false),
  /** ファセットフィールド指定（指定時はinclude_facetsが暗黙的にtrue） / Facet fields (implicitly enables include_facets when specified) */
  facet_fields: z.array(facetFieldSchema).min(1).optional(),
});
export type SearchUnifiedInput = z.infer<typeof searchUnifiedInputSchema>;

// ============================================================================
// Output Types
// ============================================================================

/**
 * 統一検索結果アイテム / Unified search result item
 */
export interface UnifiedSearchResultItem {
  /** 結果タイプ / Result type */
  type: "layout" | "part" | "motion" | "background" | "narrative";
  /** レコードID / Record ID */
  id: string;
  /** 類似度スコア / Similarity score */
  similarity: number;
  /** 追加情報 / Additional info */
  metadata: Record<string, unknown>;
}

/**
 * degraded service marker / degraded サービスマーカー (ADR-0043 Decision 2 / plan v4 §4.4)
 *
 * search.unified が embedding 障害で fail-loud な leaf を silent drop せず surface する
 * per-service marker。`reason` は `DegradedReason` enum union (free-form string 排除、
 * UB-V1-5)。query 本文・error message を bind しない (CWE-209 / GDPR Art.5(1)(c))。
 *
 * The per-service marker that surfaces an embedding-failed fail-loud leaf instead of
 * silently dropping it. `reason` binds to the `DegradedReason` enum union; it never
 * binds the query body or an error message.
 */
export interface DegradedServiceMarker {
  /** degraded した service / the degraded service */
  service: "layout" | "part" | "motion" | "background" | "narrative";
  /** degraded 理由 (embedding_unavailable | embedding_failed) / degraded reason */
  reason: DegradedReason;
}

/**
 * search.unified 出力型 / search.unified output type
 */
export type SearchUnifiedOutput =
  | {
      success: true;
      data: {
        results: UnifiedSearchResultItem[];
        total: number;
        query: string;
        searchTimeMs: number;
        /** 各タイプの検索結果数 / Result count per type */
        breakdown: {
          layout: number;
          part: number;
          motion: number;
          background: number;
          narrative: number;
        };
        /**
         * embedding 障害で degraded した service の per-service marker（ADR-0043 Decision 2 /
         * plan v4 §4.4）。embedding 必須として呼ばれた leaf が `success:false`（embedding
         * unavailable/failed）を返した場合に additive に surface する。silent drop しない。
         * degraded service が無い場合は省略（undefined）。
         * Per-service markers for services degraded by an embedding failure; surfaced
         * additively, never silently dropped. Omitted when there is no degraded service.
         */
        degradedServices?: DegradedServiceMarker[];
        /** セマンティック検索メタデータ / Semantic search metadata */
        semantic?: {
          /** 分類されたクエリタイプ / Classified query type */
          queryType: string;
          /** 拡張クエリが使用されたか / Whether expanded query was used */
          queryExpanded: boolean;
          /** 自動抽出されたフィルタ / Auto-extracted filters */
          extractedFilters: Record<string, unknown>;
          /** リランキングが適用されたか / Whether reranking was applied */
          reranked: boolean;
          /** リランキング手法 / Reranking method */
          rerankMethod: string;
        };
        /** ファセットカウント（include_facets: true時のみ） / Facet counts (only when include_facets: true) */
        facets?: FacetCounts | undefined;
      };
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

// ============================================================================
// Error Codes
// ============================================================================

export const UNIFIED_SEARCH_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  SEARCH_FAILED: "SEARCH_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

// ============================================================================
// ServiceOutcome — per-service degraded classification (ADR-0043 Decision 2)
// ============================================================================

type ServiceName = "layout" | "part" | "motion" | "background" | "narrative";

/**
 * 各 leaf helper の結果を 3 区別する discriminated union（ADR-0043 Decision 2 §4.4）。
 * - ok        : embedding 成功・結果あり（items を merge 対象に算入）
 * - empty     : embedding 成功・正当な 0 件（degraded でない、全滅判定から除外）
 * - degraded  : embedding 障害（unavailable | failed）= silent drop しない
 *
 * The per-service outcome union: `ok` (embedding success with results), `empty`
 * (embedding success with a legitimate 0 results — NOT degraded), and `degraded`
 * (an embedding failure that must not be silently dropped).
 */
type ServiceOutcome =
  | { kind: "ok"; service: ServiceName; items: UnifiedSearchResultItem[] }
  | { kind: "empty"; service: ServiceName }
  | { kind: "degraded"; service: ServiceName; reason: DegradedReason };

/**
 * leaf tool の error から `DegradedReason` を分類する（TPA-IMPL-02 forward-coupling 解消）。
 *
 * 4 service（layout/part/background/responsive）は `error.degradedReason` を carry するため
 * それを使う。motion / narrative は `degradedReason` を破棄するため（motion tool catch の
 * TPA-IMPL-02）、`error.code` を service 層 status の代理 signal として推論する:
 *   - `SERVICE_UNAVAILABLE` → embedding_unavailable（factory 不在）
 *   - `EMBEDDING_ERROR` / `EMBEDDING_FAILED` → embedding_failed（生成 throw）
 *   - その他（`SEARCH_FAILED` 等 DB error）→ embedding_failed（plan §4.4 default）
 *
 * **CWE-209 / GDPR Art.5(1)(c)**: error.message を一切 bind せず、enum 値のみ返す。
 *
 * Classifies the `DegradedReason` from a leaf tool error. Services that carry
 * `error.degradedReason` use it directly; for those that drop it (motion / narrative,
 * the TPA-IMPL-02 forward-coupling), it infers from `error.code` as a proxy for the
 * service-layer status. Binds no error message — returns only an enum value.
 */
function classifyDegradedReason(error: {
  code?: string;
  degradedReason?: DegradedReason;
}): DegradedReason {
  // 4 service が carry する degradedReason を最優先（最も正確な service 層 signal）。
  if (
    error.degradedReason === "embedding_unavailable" ||
    error.degradedReason === "embedding_failed"
  ) {
    return error.degradedReason;
  }
  // motion / narrative は degradedReason を破棄するため code から推論。
  if (error.code === "SERVICE_UNAVAILABLE") {
    return "embedding_unavailable";
  }
  // EMBEDDING_ERROR (motion) / EMBEDDING_FAILED + その他 DB error は embedding_failed default。
  return "embedding_failed";
}

/**
 * leaf tool の応答（success/error）を ServiceOutcome に変換する共通ロジック。
 * - success:true + 結果あり → ok / success:true + 0 件 → empty
 * - success:false          → degraded（error から reason 分類）
 * 旧実装の `if(!result.success || !result.data) return []` silent drop（経路 1）を置換。
 *
 * Converts a leaf tool response into a ServiceOutcome, replacing the old
 * `if(!result.success || !result.data) return []` silent-drop (path 1).
 */
function classifyResponse(
  service: ServiceName,
  result: { success: boolean; error?: { code?: string; degradedReason?: DegradedReason } },
  items: UnifiedSearchResultItem[]
): ServiceOutcome {
  if (!result.success) {
    return { kind: "degraded", service, reason: classifyDegradedReason(result.error ?? {}) };
  }
  if (items.length === 0) {
    return { kind: "empty", service };
  }
  return { kind: "ok", service, items };
}

/**
 * leaf helper の reject（throw）を degraded marker に変換する共通ロジック。
 * 旧実装の `catch { logger.warn(raw error.message); return [] }` silent drop（経路 2）を置換。
 * **CWE-209 (SEC-RE-L-3)**: logger.warn の error を `sanitizeErrorMessage` 経由化。
 *
 * Converts a leaf helper rejection into a degraded marker, replacing the old
 * `catch { return [] }` silent-drop (path 2). The logged error is sanitized (CWE-209).
 */
function classifyRejection(service: ServiceName, error: unknown): ServiceOutcome {
  logger.warn(`[search.unified] ${service} search failed`, {
    error: sanitizeErrorMessage(error),
  });
  return { kind: "degraded", service, reason: "embedding_failed" };
}

/**
 * 全 ServiceOutcome から overall success/fail を判定し degradedServices を集約する
 * （ADR-0043 Decision 2 / plan v4 §4.4 全滅述語、UB-V1-2 退行防止）。
 *
 * - `overallFail` は「ok ゼロ かつ 正当な空ゼロ かつ ≥1 が embedding_failed」のみ true。
 *   `anyEmpty`（embedding 成功・0 件）が 1 つでもあれば全滅でない（退行防止）。
 *   `embedding_unavailable` のみ（factory 未配線、active 障害でない）では overallFail にしない。
 * - degradedServices は kind:"degraded" の per-service marker を additive surface。
 *
 * Determines overall success/fail and aggregates degradedServices. `overallFail` is
 * true only when there are zero `ok`, zero `empty`, and ≥1 `embedding_failed`. A single
 * legitimate empty means it is not all-fail (regression guard, UB-V1-2).
 */
function aggregateOutcomes(outcomes: ServiceOutcome[]): {
  overallFail: boolean;
  degradedServices: DegradedServiceMarker[];
} {
  const anyOk = outcomes.some((o) => o.kind === "ok");
  const anyEmpty = outcomes.some((o) => o.kind === "empty");
  const anyFailed = outcomes.some((o) => o.kind === "degraded" && o.reason === "embedding_failed");
  const overallFail = !anyOk && !anyEmpty && anyFailed;
  const degradedServices = outcomes
    .filter((o): o is Extract<ServiceOutcome, { kind: "degraded" }> => o.kind === "degraded")
    .map((o) => ({ service: o.service, reason: o.reason }));
  return { overallFail, degradedServices };
}

/**
 * ServiceOutcome から merge 対象の items を取り出す（ok のみ items を持つ）。
 * Extracts the merge items from a ServiceOutcome (only `ok` carries items).
 */
function outcomeItems(outcome: ServiceOutcome): UnifiedSearchResultItem[] {
  return outcome.kind === "ok" ? outcome.items : [];
}

// ============================================================================
// Handler
// ============================================================================

/**
 * search.unified ツールハンドラー / search.unified tool handler
 *
 * layout.search, part.search, motion.search を並列実行し、
 * 結果をsimilarityスコア降順でマージして返却。
 *
 * Executes layout.search, part.search, and motion.search in parallel,
 * merging results by descending similarity score.
 */
export async function searchUnifiedHandler(input: unknown): Promise<SearchUnifiedOutput> {
  const startTime = Date.now();

  // 1. 入力バリデーション / Input validation
  let validated: SearchUnifiedInput;
  try {
    validated = searchUnifiedInputSchema.parse(input);
  } catch (error) {
    logger.warn("[search.unified] Validation error", { error: (error as Error).message });
    return {
      success: false,
      error: {
        code: UNIFIED_SEARCH_ERROR_CODES.VALIDATION_ERROR,
        message: "Validation error",
      },
    };
  }

  const types = validated.types ?? ["layout", "part", "motion", "background", "narrative"];

  // 2. クエリ理解 / Query Understanding
  const queryTypeOverride =
    validated.query_type !== "auto" ? (validated.query_type as QueryType) : undefined;
  const queryUnderstanding = understandQuery(validated.query, queryTypeOverride);

  // 自動抽出フィルタをマージ（明示指定が優先） / Merge auto-extracted filters (explicit takes precedence)
  const effectiveInput: SearchUnifiedInput = {
    ...validated,
    // 拡張クエリを使用 / Use expanded query
    query: queryUnderstanding.expandedQuery,
    // 明示指定がない場合は自動抽出フィルタを使用 / Use auto-extracted filters if not explicitly specified
    industry: validated.industry ?? queryUnderstanding.extractedFilters.industry,
    audience: validated.audience ?? queryUnderstanding.extractedFilters.audience,
    tags: validated.tags ?? queryUnderstanding.extractedFilters.tags,
  };

  // キャッシュチェック / Cache check
  const cacheKey = generateCacheKey(
    "search.unified",
    effectiveInput as unknown as Record<string, unknown>
  );
  const cached = getCachedResult<SearchUnifiedOutput>(cacheKey);
  if (cached) {
    // キャッシュヒット時も検索ログ記録（fire-and-forget）
    // Log search on cache hit too (fire-and-forget)
    logSearch({
      query: validated.query,
      queryType: queryUnderstanding.queryType,
      services: types,
      resultCount: cached.success ? cached.data.total : 0,
      latencyMs: Date.now() - startTime,
      cacheHit: true,
      profileId: validated.profile_id,
    }).catch(() => {
      // fire-and-forget
    });
    return cached;
  }

  // 3. 並列検索実行 / Execute searches in parallel
  // 各 helper は ServiceOutcome (ok | empty | degraded) を返す。types に含まれない service は
  // 「呼ばれていない」= 全滅判定の分母から除外するため null を resolve（empty とは区別）。
  // Each helper returns a ServiceOutcome; a service not in `types` resolves null and is
  // excluded from the all-fail denominator (distinct from a legitimate `empty`).
  const layoutPromise = types.includes("layout")
    ? searchLayout(effectiveInput)
    : Promise.resolve(null);

  const partPromise = types.includes("part") ? searchPart(effectiveInput) : Promise.resolve(null);

  const motionPromise = types.includes("motion")
    ? searchMotion(effectiveInput)
    : Promise.resolve(null);

  const backgroundPromise = types.includes("background")
    ? searchBackground(effectiveInput)
    : Promise.resolve(null);

  const narrativePromise = types.includes("narrative")
    ? searchNarrative(effectiveInput)
    : Promise.resolve(null);

  try {
    const [layoutOutcome, partOutcome, motionOutcome, backgroundOutcome, narrativeOutcome] =
      await Promise.all([
        layoutPromise,
        partPromise,
        motionPromise,
        backgroundPromise,
        narrativePromise,
      ]);

    // 呼ばれた service のみ（null 除外）= 全滅判定 + degradedServices の分母。
    // Only the services actually invoked (null excluded) form the all-fail denominator.
    const invokedOutcomes: ServiceOutcome[] = [
      layoutOutcome,
      partOutcome,
      motionOutcome,
      backgroundOutcome,
      narrativeOutcome,
    ].filter((o): o is ServiceOutcome => o !== null);

    // 全滅判定 + degradedServices 集約（ADR-0043 Decision 2 §4.4、UB-V1-2 退行防止）。
    const { overallFail, degradedServices } = aggregateOutcomes(invokedOutcomes);

    // embedding 必須 service が全滅（≥1 embedding_failed かつ ok/empty ゼロ）→ success:false。
    // silent degradation 排除（feedback_no_fake_success）。
    if (overallFail) {
      const searchTimeMs = Date.now() - startTime;
      logger.warn("[search.unified] all embedding-required services degraded (fail-loud)", {
        degradedCount: degradedServices.length,
        degradedServices: degradedServices.map((d) => `${d.service}:${d.reason}`).join(","),
        searchTimeMs,
      });
      logSearch({
        query: validated.query,
        queryType: queryUnderstanding.queryType,
        services: types,
        resultCount: 0,
        latencyMs: searchTimeMs,
        cacheHit: false,
        profileId: validated.profile_id,
      }).catch(() => {
        // fire-and-forget
      });
      return {
        success: false,
        error: {
          code: UNIFIED_SEARCH_ERROR_CODES.SEARCH_FAILED,
          message: "All embedding-required search services are degraded",
        },
      };
    }

    // per-service の結果数（breakdown）。degraded/empty は 0、ok のみ件数を持つ。
    const layoutResults = layoutOutcome ? outcomeItems(layoutOutcome) : [];
    const partResults = partOutcome ? outcomeItems(partOutcome) : [];
    const motionResults = motionOutcome ? outcomeItems(motionOutcome) : [];
    const backgroundResults = backgroundOutcome ? outcomeItems(backgroundOutcome) : [];
    const narrativeResults = narrativeOutcome ? outcomeItems(narrativeOutcome) : [];

    // 4. 結果マージ（similarity降順）/ Merge results by similarity desc
    let allResults = [
      ...layoutResults,
      ...partResults,
      ...motionResults,
      ...backgroundResults,
      ...narrativeResults,
    ].sort((a, b) => b.similarity - a.similarity);

    // 5. Cross-Encoder リランキング / Cross-Encoder Reranking
    let rerankApplied = false;
    let rerankMethod = "none";

    if (validated.enable_reranking && allResults.length > 1) {
      try {
        const rerankResult = await applyCrossEncoderReranking(
          allResults,
          validated.query, // 元のクエリを使用 / Use original query
          undefined, // queryEmbeddingは現在未対応（検索サービス内で生成済み）
          { alpha: 0.5 }
        );
        if (rerankResult.reranked) {
          allResults = rerankResult.items;
          rerankApplied = true;
          rerankMethod = rerankResult.method;
        }
      } catch (rerankError) {
        // Graceful Degradation: リランキング失敗時は元の順序を維持
        // Graceful Degradation: maintain original order on reranking failure
        logger.warn("[search.unified] Cross-encoder reranking failed, using original order", {
          error: rerankError instanceof Error ? rerankError.message : String(rerankError),
        });
      }
    }

    // 6. ファセットカウント算出（limit適用前の全結果対象、オプション）
    // Compute facet counts from all results BEFORE limit (optional)
    const shouldComputeFacets = validated.include_facets || validated.facet_fields != null;
    let facets: FacetCounts | undefined;
    if (shouldComputeFacets) {
      const facetFields: FacetField[] =
        validated.facet_fields ?? ([...SUPPORTED_FACET_FIELDS] as FacetField[]);
      facets = computeFacetsFromResults(allResults, facetFields);
    }

    // limitを適用 / Apply limit
    allResults = allResults.slice(0, validated.limit);

    const searchTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info("[search.unified] Search completed", {
        query: validated.query.substring(0, 50),
        types,
        totalResults: allResults.length,
        breakdown: {
          layout: layoutResults.length,
          part: partResults.length,
          motion: motionResults.length,
          background: backgroundResults.length,
          narrative: narrativeResults.length,
        },
        searchTimeMs,
        queryType: queryUnderstanding.queryType,
        queryExpanded: queryUnderstanding.expandedQuery.length > validated.query.length,
        reranked: rerankApplied,
      });
    }

    const result: SearchUnifiedOutput = {
      success: true,
      data: {
        results: allResults,
        total: allResults.length,
        query: validated.query,
        searchTimeMs,
        breakdown: {
          layout: layoutResults.length,
          part: partResults.length,
          motion: motionResults.length,
          background: backgroundResults.length,
          narrative: narrativeResults.length,
        },
        semantic: {
          queryType: queryUnderstanding.queryType,
          queryExpanded: queryUnderstanding.expandedQuery.length > validated.query.length,
          extractedFilters: queryUnderstanding.extractedFilters as Record<string, unknown>,
          reranked: rerankApplied,
          rerankMethod,
        },
        facets,
        // degraded service があれば additive surface（無ければ undefined）。
        // Surface degraded services additively (undefined when none).
        ...(degradedServices.length > 0 ? { degradedServices } : {}),
      },
    };

    setCachedResult(cacheKey, result);

    // 7. 検索ログ記録（fire-and-forget） / Log search (fire-and-forget)
    logSearch({
      query: validated.query,
      queryType: queryUnderstanding.queryType,
      services: types,
      resultCount: allResults.length,
      topResultId: allResults[0]?.id,
      filters: {
        industry: validated.industry,
        audience: validated.audience,
        tags: validated.tags,
        webPageId: validated.webPageId,
      },
      latencyMs: searchTimeMs,
      cacheHit: false,
      profileId: validated.profile_id,
    }).catch(() => {
      // fire-and-forget: エラーは logSearch 内部で処理済み
    });

    return result;
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));
    logger.warn("[search.unified] Search failed", {
      error: sanitizeErrorMessage(errorInstance),
    });

    return {
      success: false,
      error: {
        code: UNIFIED_SEARCH_ERROR_CODES.SEARCH_FAILED,
        message: sanitizeErrorMessage(errorInstance),
      },
    };
  }
}

// ============================================================================
// Individual Search Adapters
// ============================================================================

/**
 * layout.search を呼び出して ServiceOutcome に変換
 * Call layout.search and classify into a ServiceOutcome
 */
async function searchLayout(input: SearchUnifiedInput): Promise<ServiceOutcome> {
  try {
    const filters: Record<string, unknown> = {};
    if (input.webPageId) filters.webPageId = input.webPageId;
    if (input.industry) filters.industry = input.industry;
    if (input.audience) filters.audience = input.audience;
    if (input.tags) filters.tags = input.tags;
    const result = (await layoutSearchHandler({
      query: input.query,
      limit: input.limit,
      offset: 0,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      profile_id: input.profile_id,
    })) as {
      success: boolean;
      error?: { code?: string; degradedReason?: DegradedReason };
      data?: {
        results: Array<{
          id: string;
          similarity: number;
          sectionType?: string;
          webPageUrl?: string;
        }>;
      };
    };

    const items: UnifiedSearchResultItem[] = (result.data?.results ?? []).map((r) => ({
      type: "layout" as const,
      id: r.id,
      similarity: r.similarity,
      metadata: {
        sectionType: r.sectionType,
        webPageUrl: r.webPageUrl,
      },
    }));
    return classifyResponse("layout", result, items);
  } catch (error) {
    return classifyRejection("layout", error);
  }
}

/**
 * part.search を呼び出して ServiceOutcome に変換
 * Call part.search and classify into a ServiceOutcome
 */
async function searchPart(input: SearchUnifiedInput): Promise<ServiceOutcome> {
  try {
    const result = (await partSearchHandler({
      query: input.query,
      limit: input.limit,
      offset: 0,
      web_page_id: input.webPageId,
      industry: input.industry,
      audience: input.audience,
      tags: input.tags,
    })) as {
      success: boolean;
      error?: { code?: string; degradedReason?: DegradedReason };
      data?: {
        results: Array<{
          id: string;
          similarity: number;
          partType?: string;
          webPageUrl?: string;
        }>;
      };
    };

    const items: UnifiedSearchResultItem[] = (result.data?.results ?? []).map((r) => ({
      type: "part" as const,
      id: r.id,
      similarity: r.similarity,
      metadata: {
        partType: r.partType,
        webPageUrl: r.webPageUrl,
      },
    }));
    return classifyResponse("part", result, items);
  } catch (error) {
    return classifyRejection("part", error);
  }
}

/**
 * motion.search を呼び出して ServiceOutcome に変換
 * Call motion.search and classify into a ServiceOutcome
 *
 * motion tool は error に `degradedReason` を carry しない（TPA-IMPL-02 forward-coupling）。
 * `classifyResponse` → `classifyDegradedReason` が motion の `error.code`
 * (`SERVICE_UNAVAILABLE` / `EMBEDDING_ERROR`) を service 層 status の代理 signal として
 * `embedding_unavailable` / `embedding_failed` に推論する。motion tool/service は非 touch。
 */
async function searchMotion(input: SearchUnifiedInput): Promise<ServiceOutcome> {
  try {
    const motionFilters: Record<string, unknown> = {};
    if (input.webPageId) motionFilters.webPageId = input.webPageId;
    if (input.industry) motionFilters.industry = input.industry;
    if (input.audience) motionFilters.audience = input.audience;
    if (input.tags) motionFilters.tags = input.tags;
    const result = (await motionSearchHandler({
      action: "search",
      query: input.query,
      limit: input.limit,
      minSimilarity: 0.3,
      filters: Object.keys(motionFilters).length > 0 ? motionFilters : undefined,
      profile_id: input.profile_id,
    })) as {
      success: boolean;
      error?: { code?: string; degradedReason?: DegradedReason };
      data?: {
        results: Array<{
          pattern: { name?: string; type?: string };
          similarity: number;
          source?: { pageId?: string; url?: string };
        }>;
      };
    };

    // motion結果はnested structureのため適応変換
    // Motion results have nested structure, adapt accordingly
    const items: UnifiedSearchResultItem[] = (result.data?.results ?? []).map((r, idx) => ({
      type: "motion" as const,
      id: r.source?.pageId ?? `motion-${idx}`,
      similarity: r.similarity,
      metadata: {
        patternName: r.pattern?.name,
        patternType: r.pattern?.type,
        sourceUrl: r.source?.url,
      },
    }));
    return classifyResponse("motion", result, items);
  } catch (error) {
    return classifyRejection("motion", error);
  }
}

/**
 * background.search を呼び出して ServiceOutcome に変換
 * Call background.search and classify into a ServiceOutcome
 */
async function searchBackground(input: SearchUnifiedInput): Promise<ServiceOutcome> {
  try {
    const bgFilters: Record<string, unknown> = {};
    if (input.webPageId) bgFilters.webPageId = input.webPageId;
    if (input.industry) bgFilters.industry = input.industry;
    if (input.audience) bgFilters.audience = input.audience;
    if (input.tags) bgFilters.tags = input.tags;
    const result = (await backgroundSearchHandler({
      query: input.query,
      limit: input.limit,
      offset: 0,
      filters: Object.keys(bgFilters).length > 0 ? bgFilters : undefined,
      profile_id: input.profile_id,
    })) as {
      success: boolean;
      error?: { code?: string; degradedReason?: DegradedReason };
      data?: {
        results: Array<{
          id: string;
          similarity: number;
          designType?: string;
          source?: { webPageId?: string };
          name?: string;
        }>;
      };
    };

    const items: UnifiedSearchResultItem[] = (result.data?.results ?? []).map((r) => ({
      type: "background" as const,
      id: r.id,
      similarity: r.similarity,
      metadata: {
        designType: r.designType,
        webPageId: r.source?.webPageId,
        name: r.name,
      },
    }));
    return classifyResponse("background", result, items);
  } catch (error) {
    return classifyRejection("background", error);
  }
}

/**
 * narrative.search を呼び出して ServiceOutcome に変換
 * Call narrative.search and classify into a ServiceOutcome
 *
 * narrative tool も error に `degradedReason` を carry しないため、`classifyDegradedReason`
 * が `error.code` (`EMBEDDING_FAILED` 等) から推論する（motion と同様、tool/service 非 touch）。
 */
async function searchNarrative(input: SearchUnifiedInput): Promise<ServiceOutcome> {
  try {
    const narrativeFilters: Record<string, unknown> = {};
    if (input.webPageId) narrativeFilters.webPageId = input.webPageId;
    if (input.industry) narrativeFilters.industry = input.industry;
    if (input.audience) narrativeFilters.audience = input.audience;
    if (input.tags) narrativeFilters.tags = input.tags;
    const result = (await narrativeSearchHandler({
      query: input.query,
      options: { limit: input.limit },
      filters: Object.keys(narrativeFilters).length > 0 ? narrativeFilters : undefined,
      profile_id: input.profile_id,
    })) as {
      success: boolean;
      error?: { code?: string; degradedReason?: DegradedReason };
      data?: {
        results: Array<{
          id: string;
          similarity: number;
          webPageId?: string;
          sourceUrl?: string;
          worldView?: { moodCategory?: string; moodDescription?: string };
        }>;
      };
    };

    const items: UnifiedSearchResultItem[] = (result.data?.results ?? []).map((r) => ({
      type: "narrative" as const,
      id: r.id,
      similarity: r.similarity,
      metadata: {
        webPageId: r.webPageId,
        sourceUrl: r.sourceUrl,
        moodCategory: r.worldView?.moodCategory,
        moodDescription: r.worldView?.moodDescription,
      },
    }));
    return classifyResponse("narrative", result, items);
  } catch (error) {
    return classifyRejection("narrative", error);
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

/**
 * search.unified MCPツール定義 / search.unified MCP tool definition
 */
export const searchUnifiedToolDefinition = {
  name: "search.unified",
  description:
    "Layout（セクション）・Part（UIコンポーネント）・Motion（アニメーション）・Background（背景デザイン）・Narrative（世界観）を横断的にセマンティック検索します。" +
    "個別検索ツールを並列実行し、結果をsimilarityスコア順にマージして返却します。" +
    " / Cross-component semantic search across Layout sections, UI Parts, Motion patterns, Background designs, and Narratives. " +
    "Executes individual search tools in parallel and merges results by similarity score.",
  annotations: {
    title: "Unified Search",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "検索クエリ（自然言語、1-500文字） / Search query (natural language, 1-500 chars)",
        minLength: 1,
        maxLength: 500,
      },
      types: {
        type: "array",
        items: {
          type: "string",
          enum: ["layout", "part", "motion", "background", "narrative"],
        },
        description: "検索対象タイプ（デフォルト: 全タイプ） / Target types (default: all types)",
      },
      limit: {
        type: "number",
        description: "取得件数（1-50、デフォルト: 10） / Result limit (1-50, default: 10)",
        minimum: 1,
        maximum: 50,
        default: 10,
      },
      webPageId: {
        type: "string",
        format: "uuid",
        description: "WebページIDでフィルター / Filter by web page ID",
      },
      industry: {
        type: "string",
        maxLength: 100,
        description: "業種フィルター / Industry filter (e.g., 'SaaS', 'E-commerce')",
      },
      audience: {
        type: "string",
        maxLength: 100,
        description:
          "ターゲットオーディエンスフィルター / Target audience filter (e.g., 'Developer', 'Enterprise')",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "タグフィルター / Tags filter",
      },
      profile_id: {
        type: "string",
        format: "uuid",
        description: "嗜好プロファイルID（検索結果のリランキングに使用） / Preference profile ID",
      },
      enable_reranking: {
        type: "boolean",
        description:
          "Cross-Encoderリランキング有効化（デフォルト: true） / Enable Cross-Encoder reranking (default: true)",
        default: true,
      },
      query_type: {
        type: "string",
        enum: ["auto", "visual", "structural", "functional", "stylistic"],
        description:
          "クエリタイプ（auto: 自動分類、visual: 見た目、structural: レイアウト構造、functional: 機能、stylistic: スタイル） / Query type (auto: auto-classify)",
        default: "auto",
      },
      include_facets: {
        type: "boolean",
        description:
          "ファセットカウント付与（デフォルト: false）。trueにすると sectionType/industry/audience/tags のカウントを返却 / Include facet counts (default: false). Returns counts for sectionType/industry/audience/tags when true",
        default: false,
      },
      facet_fields: {
        type: "array",
        items: {
          type: "string",
          enum: ["sectionType", "industry", "audience", "tags"],
        },
        minItems: 1,
        description:
          "ファセットフィールド指定（指定時はinclude_facetsが暗黙的にtrue）。未指定時は全4フィールド / " +
          "Facet fields to compute (implicitly enables include_facets). Defaults to all 4 fields when omitted. " +
          "sectionType: セクション/パーツタイプ, industry: 業種, audience: ターゲット, tags: タグ",
      },
    },
    required: ["query"],
  },
};
