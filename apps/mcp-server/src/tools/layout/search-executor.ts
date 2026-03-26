// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.search 検索実行関数
 * Vision検索、マルチモーダル検索（RRF統合）の実行ロジック
 *
 * search.tool.ts から分離。循環依存回避のため、DI サービスインスタンスはパラメータで注入。
 *
 * @module tools/layout/search-executor
 */

import { logger, isDevelopment } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import type { LayoutSearchInput, LayoutSearchOutput } from "./schemas";
import type {
  VisionSearchQuery as VisionSearchQueryService,
  HybridSearchOptions,
} from "../../services/vision-embedding-search.service";
import {
  type ILayoutSearchService,
  type IVisionSearchService,
  type SearchOptions,
  type PreviewOptions,
  preprocessQuery,
  determineSearchMode,
  determineErrorCode,
  getIncludeHtml,
  mapSearchResult,
  mapVisionResultToSearchResult,
} from "./search-helpers";

// =====================================================
// Vision検索実行（Phase 4-2）
// =====================================================

/**
 * Vision検索を実行（Phase 4-2）
 * useVisionSearch=true の場合に呼び出される
 *
 * @param validated - バリデーション済み入力
 * @param startTime - 開始時刻
 * @param visionServiceFactory - VisionSearchServiceファクトリ（undefined = サービス未登録）
 */
export async function executeVisionSearch(
  validated: LayoutSearchInput,
  startTime: number,
  visionServiceFactory: (() => IVisionSearchService) | undefined
): Promise<LayoutSearchOutput> {
  // VisionSearchサービスチェック
  if (!visionServiceFactory) {
    if (isDevelopment()) {
      logger.warn(
        "[MCP Tool] layout.search vision search service not available, falling back to text search"
      );
    }

    // フォールバック: 通常の検索を実行（サービスがない場合）
    return {
      success: false,
      error: {
        code: "VISION_SEARCH_UNAVAILABLE",
        message:
          "Vision search service is not available. Set use_vision_search=false to use text-only search.",
      },
    };
  }

  const visionService = visionServiceFactory();

  // VisionSearchQueryの構築
  const visionQuery: VisionSearchQueryService = {
    textQuery: validated.vision_search_query?.textQuery ?? validated.query,
  };

  // visualFeaturesが定義されている場合のみ追加
  if (validated.vision_search_query?.visualFeatures) {
    const vf = validated.vision_search_query.visualFeatures;
    const visualFeatures: NonNullable<VisionSearchQueryService["visualFeatures"]> = {};

    if (vf.theme) visualFeatures.theme = vf.theme;
    if (vf.colors) visualFeatures.colors = vf.colors;
    if (vf.density) visualFeatures.density = vf.density;
    if (vf.gradient) visualFeatures.gradient = vf.gradient;
    if (vf.mood) visualFeatures.mood = vf.mood;
    if (vf.brandTone) visualFeatures.brandTone = vf.brandTone;

    visionQuery.visualFeatures = visualFeatures;
  }

  // sectionPatternIdが定義されている場合のみ追加
  if (validated.vision_search_query?.sectionPatternId) {
    visionQuery.sectionPatternId = validated.vision_search_query.sectionPatternId;
  }

  // VisionSearchOptionsの構築
  const visionOptions: HybridSearchOptions = {
    limit: validated.limit,
    offset: validated.offset,
    minSimilarity: validated.vision_search_options?.minSimilarity ?? 0.5,
    visionWeight: validated.vision_search_options?.visionWeight ?? 0.6,
    textWeight: validated.vision_search_options?.textWeight ?? 0.4,
  };

  // フィルターが定義されている場合のみ追加
  if (validated.filters?.sectionType) {
    visionOptions.sectionType = validated.filters.sectionType;
  }
  if (validated.filters?.sourceType) {
    visionOptions.sourceType = validated.filters.sourceType;
  }
  if (validated.filters?.usageScope) {
    visionOptions.usageScope = validated.filters.usageScope;
  }
  // Common search filters (industry/audience/tags)
  if (validated.filters?.industry) {
    visionOptions.industry = validated.filters.industry;
  }
  if (validated.filters?.audience) {
    visionOptions.audience = validated.filters.audience;
  }
  if (validated.filters?.tags && validated.filters.tags.length > 0) {
    visionOptions.tags = validated.filters.tags;
  }

  if (isDevelopment()) {
    logger.debug("[MCP Tool] layout.search executing vision search", {
      visionQuery,
      visionOptions,
    });
  }

  try {
    // ハイブリッド検索を実行（text_embedding + vision_embedding のRRF統合）
    const visionResult = await visionService.hybridSearch(
      validated.query,
      visionQuery,
      visionOptions
    );

    if (!visionResult) {
      return {
        success: true,
        data: {
          results: [],
          total: 0,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
        },
      };
    }

    // Vision結果を標準形式にマップ
    const previewOptions: PreviewOptions = {
      includePreview: validated.include_preview,
      maxLength: validated.preview_max_length,
    };

    const includeHtmlValue = getIncludeHtml(validated);
    const mappedResults = visionResult.results.map((vr) => {
      const searchResult = mapVisionResultToSearchResult(vr);
      return mapSearchResult(
        searchResult,
        includeHtmlValue,
        undefined, // adaptability
        undefined, // semanticInfo
        previewOptions
      );
    });

    const searchTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info("[MCP Tool] layout.search vision search completed", {
        query: validated.query,
        use_vision_search: true,
        resultCount: mappedResults.length,
        total: visionResult.total,
        searchTimeMs,
      });
    }

    return {
      success: true,
      data: {
        results: mappedResults,
        total: visionResult.total,
        query: validated.query,
        filters: validated.filters ?? {},
        searchTimeMs,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = determineErrorCode(error instanceof Error ? error : errorMessage);

    logger.error("[MCP Tool] layout.search vision search error", {
      code: errorCode,
      error: errorMessage,
    });

    return {
      success: false,
      error: {
        code: errorCode,
        message: sanitizeErrorMessage(error),
      },
    };
  }
}

// =====================================================
// Multimodal Search
// =====================================================

/**
 * search_modeに基づくマルチモーダル検索実行
 *
 * @param validated - バリデーション済み入力
 * @param service - LayoutSearchServiceインスタンス
 * @param startTime - 開始時刻
 * @param visionServiceFactory - VisionSearchServiceファクトリ（undefined = サービス未登録）
 */
export async function executeMultimodalSearch(
  validated: LayoutSearchInput,
  service: ILayoutSearchService,
  startTime: number,
  visionServiceFactory: (() => IVisionSearchService) | undefined
): Promise<LayoutSearchOutput> {
  const searchMode = validated.search_mode ?? "text_only";
  const multimodalOptions = validated.multimodal_options;
  const textWeight = multimodalOptions?.textWeight ?? 0.6;
  const visionWeight = multimodalOptions?.visionWeight ?? 0.4;
  const rrfK = multimodalOptions?.rrfK ?? 60;

  // VisionSearchServiceの可用性チェック
  const hasVisionService = !!visionServiceFactory;

  // 検索モードを決定（Graceful Degradation）
  const { actualMode, warnings } = determineSearchMode(searchMode, hasVisionService);

  if (isDevelopment()) {
    logger.debug("[MCP Tool] layout.search multimodal mode", {
      requestedMode: searchMode,
      actualMode,
      warnings,
    });
  }

  // text_only モード
  if (actualMode === "text_only") {
    const processedQuery = preprocessQuery(validated.query);
    const queryEmbedding = await service.generateQueryEmbedding(processedQuery);

    if (queryEmbedding === null) {
      return {
        success: true,
        data: {
          results: [],
          total: 0,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
          searchMode: searchMode,
          actualSearchMode: actualMode,
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      };
    }

    const searchOptions: SearchOptions = {
      filters: validated.filters,
      limit: validated.limit,
      offset: validated.offset,
      include_html: getIncludeHtml(validated),
      project_context: validated.project_context,
    };

    // ハイブリッド検索（vector + fulltext RRF）が利用可能な場合はそちらを使用
    const searchResult = service.searchSectionPatternsHybrid
      ? await service.searchSectionPatternsHybrid(validated.query, queryEmbedding, searchOptions)
      : await service.searchSectionPatterns(queryEmbedding, searchOptions);

    if (!searchResult) {
      return {
        success: true,
        data: {
          results: [],
          total: 0,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
          searchMode: searchMode,
          actualSearchMode: actualMode,
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      };
    }

    // 結果マッピング
    const previewOptions: PreviewOptions = {
      includePreview: validated.include_preview,
      maxLength: validated.preview_max_length,
    };
    const includeHtmlValue = getIncludeHtml(validated);
    const mappedResults = searchResult.results.map((sr) =>
      mapSearchResult(
        sr,
        includeHtmlValue,
        undefined, // adaptability
        undefined, // semanticInfo
        previewOptions
      )
    );

    return {
      success: true,
      data: {
        results: mappedResults,
        total: searchResult.total,
        query: validated.query,
        filters: validated.filters ?? {},
        searchTimeMs: Date.now() - startTime,
        searchMode: searchMode,
        actualSearchMode: actualMode,
        warnings: warnings.length > 0 ? warnings : undefined,
      },
    };
  }

  // vision_only または combined モードではVisionSearchServiceを使用
  if (!visionServiceFactory) {
    // これはdetermineSearchModeで処理されるはずだが、安全のため
    return {
      success: false,
      error: {
        code: "VISION_SEARCH_UNAVAILABLE",
        message: "Vision search service is not available.",
      },
    };
  }

  const visionService = visionServiceFactory();

  // vision_only モード
  if (actualMode === "vision_only") {
    try {
      const visionQuery: VisionSearchQueryService = {
        textQuery: validated.vision_search_query?.textQuery ?? validated.query,
      };

      const visionOptions: HybridSearchOptions = {
        limit: validated.limit,
        offset: validated.offset,
        minSimilarity: 0.5,
        visionWeight: 1.0, // vision_onlyなので100%
        textWeight: 0.0,
      };

      if (validated.filters?.sectionType) {
        visionOptions.sectionType = validated.filters.sectionType;
      }

      // searchByVisionEmbeddingを呼び出し（vision_onlyモード）
      const visionResult = await visionService.searchByVisionEmbedding(visionQuery, visionOptions);

      if (!visionResult) {
        return {
          success: true,
          data: {
            results: [],
            total: 0,
            query: validated.query,
            filters: validated.filters ?? {},
            searchTimeMs: Date.now() - startTime,
            searchMode: searchMode,
            actualSearchMode: actualMode,
            warnings: warnings.length > 0 ? warnings : undefined,
          },
        };
      }

      // Graceful Degradation - fallbackToTextOnly処理
      if (visionResult.fallbackToTextOnly) {
        warnings.push("vision_embedding not available, falling back to text_only");
        // text_onlyで再検索（警告を保持したまま）
        const processedQuery = preprocessQuery(validated.query);
        const queryEmbedding = await service.generateQueryEmbedding(processedQuery);

        if (queryEmbedding === null) {
          return {
            success: true,
            data: {
              results: [],
              total: 0,
              query: validated.query,
              filters: validated.filters ?? {},
              searchTimeMs: Date.now() - startTime,
              searchMode: searchMode,
              actualSearchMode: "text_only", // フォールバック後
              warnings: warnings,
            },
          };
        }

        const searchOptions: SearchOptions = {
          filters: validated.filters,
          limit: validated.limit,
          offset: validated.offset,
          include_html: getIncludeHtml(validated),
          project_context: validated.project_context,
        };

        const searchResult = await service.searchSectionPatterns(queryEmbedding, searchOptions);

        const previewOptionsForFallback: PreviewOptions = {
          includePreview: validated.include_preview,
          maxLength: validated.preview_max_length,
        };
        const includeHtmlValueForFallback = getIncludeHtml(validated);
        const mappedResultsForFallback = (searchResult?.results ?? []).map((sr) =>
          mapSearchResult(
            sr,
            includeHtmlValueForFallback,
            undefined,
            undefined,
            previewOptionsForFallback
          )
        );

        return {
          success: true,
          data: {
            results: mappedResultsForFallback,
            total: searchResult?.total ?? 0,
            query: validated.query,
            filters: validated.filters ?? {},
            searchTimeMs: Date.now() - startTime,
            searchMode: searchMode,
            actualSearchMode: "text_only", // フォールバック後
            warnings: warnings,
          },
        };
      }

      const previewOptions: PreviewOptions = {
        includePreview: validated.include_preview,
        maxLength: validated.preview_max_length,
      };
      const includeHtmlValue = getIncludeHtml(validated);
      const mappedResults = visionResult.results.map((vr) => {
        const searchResult = mapVisionResultToSearchResult(vr);
        return mapSearchResult(
          searchResult,
          includeHtmlValue,
          undefined,
          undefined,
          previewOptions
        );
      });

      return {
        success: true,
        data: {
          results: mappedResults,
          total: visionResult.total,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
          searchMode: searchMode,
          actualSearchMode: actualMode,
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      };
    } catch (error) {
      // エラー時はtext_onlyにフォールバック（警告を保持）
      warnings.push(
        `Vision search error: ${sanitizeErrorMessage(error)}, falling back to text_only`
      );

      const processedQuery = preprocessQuery(validated.query);
      const queryEmbedding = await service.generateQueryEmbedding(processedQuery);

      if (queryEmbedding === null) {
        return {
          success: true,
          data: {
            results: [],
            total: 0,
            query: validated.query,
            filters: validated.filters ?? {},
            searchTimeMs: Date.now() - startTime,
            searchMode: searchMode,
            actualSearchMode: "text_only",
            warnings: warnings,
          },
        };
      }

      const searchOptions: SearchOptions = {
        filters: validated.filters,
        limit: validated.limit,
        offset: validated.offset,
        include_html: getIncludeHtml(validated),
        project_context: validated.project_context,
      };

      const searchResult = await service.searchSectionPatterns(queryEmbedding, searchOptions);

      const previewOptionsForError: PreviewOptions = {
        includePreview: validated.include_preview,
        maxLength: validated.preview_max_length,
      };
      const includeHtmlValueForError = getIncludeHtml(validated);
      const mappedResultsForError = (searchResult?.results ?? []).map((sr) =>
        mapSearchResult(sr, includeHtmlValueForError, undefined, undefined, previewOptionsForError)
      );

      return {
        success: true,
        data: {
          results: mappedResultsForError,
          total: searchResult?.total ?? 0,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
          searchMode: searchMode,
          actualSearchMode: "text_only",
          warnings: warnings,
        },
      };
    }
  }

  // combined モード（RRF統合検索）
  if (actualMode === "combined") {
    const rrfStartTime = Date.now();

    try {
      const visionQuery: VisionSearchQueryService = {
        textQuery: validated.vision_search_query?.textQuery ?? validated.query,
      };

      const hybridOptions: HybridSearchOptions = {
        limit: validated.limit,
        offset: validated.offset,
        minSimilarity: 0.5,
        visionWeight: visionWeight,
        textWeight: textWeight,
        rrfK: rrfK, // RRFのkパラメータ
      };

      if (validated.filters?.sectionType) {
        hybridOptions.sectionType = validated.filters.sectionType;
      }
      // Common search filters (industry/audience/tags)
      if (validated.filters?.industry) {
        hybridOptions.industry = validated.filters.industry;
      }
      if (validated.filters?.audience) {
        hybridOptions.audience = validated.filters.audience;
      }
      if (validated.filters?.tags && validated.filters.tags.length > 0) {
        hybridOptions.tags = validated.filters.tags;
      }

      // hybridSearchを呼び出し
      const hybridResult = await visionService.hybridSearch(
        validated.query,
        visionQuery,
        hybridOptions
      );

      const rrfCalculationTime = Date.now() - rrfStartTime;

      if (!hybridResult) {
        return {
          success: true,
          data: {
            results: [],
            total: 0,
            query: validated.query,
            filters: validated.filters ?? {},
            searchTimeMs: Date.now() - startTime,
            searchMode: searchMode,
            actualSearchMode: actualMode,
            warnings: warnings.length > 0 ? warnings : undefined,
            rrfDetails: {
              k: rrfK,
              textWeight,
              visionWeight,
              textResultCount: 0,
              visionResultCount: 0,
              fusedResultCount: 0,
              calculationTimeMs: rrfCalculationTime,
            },
          },
        };
      }

      // Graceful Degradation - fallbackToTextOnly処理
      if (hybridResult.fallbackToTextOnly) {
        // フォールバック発生時は actualSearchMode を text_only に変更
        const fallbackReason = hybridResult.fallbackReason ?? "No vision embeddings available";
        warnings.push(fallbackReason);

        const previewOptions: PreviewOptions = {
          includePreview: validated.include_preview,
          maxLength: validated.preview_max_length,
        };
        const includeHtmlValue = getIncludeHtml(validated);
        const mappedResults = hybridResult.results.map((vr) => {
          const searchResult = mapVisionResultToSearchResult(vr);
          return mapSearchResult(
            searchResult,
            includeHtmlValue,
            undefined,
            undefined,
            previewOptions
          );
        });

        return {
          success: true,
          data: {
            results: mappedResults,
            total: hybridResult.total,
            query: validated.query,
            filters: validated.filters ?? {},
            searchTimeMs: Date.now() - startTime,
            searchMode: searchMode,
            actualSearchMode: "text_only", // フォールバック後のモード
            warnings: warnings.length > 0 ? warnings : undefined,
            fallbackReason: fallbackReason,
          },
        };
      }

      const previewOptions: PreviewOptions = {
        includePreview: validated.include_preview,
        maxLength: validated.preview_max_length,
      };
      const includeHtmlValue = getIncludeHtml(validated);
      const mappedResults = hybridResult.results.map((vr) => {
        const searchResult = mapVisionResultToSearchResult(vr);
        return mapSearchResult(
          searchResult,
          includeHtmlValue,
          undefined,
          undefined,
          previewOptions
        );
      });

      return {
        success: true,
        data: {
          results: mappedResults,
          total: hybridResult.total,
          query: validated.query,
          filters: validated.filters ?? {},
          searchTimeMs: Date.now() - startTime,
          searchMode: searchMode,
          actualSearchMode: actualMode,
          warnings: warnings.length > 0 ? warnings : undefined,
          rrfDetails: {
            k: rrfK,
            textWeight,
            visionWeight,
            textResultCount: hybridResult.results.length,
            visionResultCount: hybridResult.results.length,
            fusedResultCount: hybridResult.results.length,
            calculationTimeMs: rrfCalculationTime,
          },
        },
      };
    } catch (error) {
      warnings.push(
        `Combined search error: ${sanitizeErrorMessage(error)}, falling back to text_only`
      );
      return executeMultimodalSearch(
        { ...validated, search_mode: "text_only" },
        service,
        startTime,
        visionServiceFactory
      );
    }
  }

  // フォールバック（通常到達しない）
  return {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: `Unexpected search mode: ${actualMode}`,
    },
  };
}
