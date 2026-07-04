// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.search MCPツール
 * セクションパターンを自然言語クエリでセマンティック検索します
 *
 * 機能:
 * - 日本語/英語対応の自然言語検索
 * - pgvector HNSW インデックスによるベクトル検索
 * - multilingual-e5-baseによるクエリEmbedding生成
 * - セクションタイプ/ソースタイプ/利用範囲フィルタリング
 * - ページネーション対応
 *
 * @module tools/layout/search.tool
 */

import { ZodError } from "zod";
import { createDIFactory } from "../../utils/di-factory";
import { logger, isDevelopment } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import {
  generateCacheKey,
  getCachedResult,
  setCachedResult,
} from "../../services/search-cache.service";
import {
  layoutSearchInputSchema,
  LAYOUT_MCP_ERROR_CODES,
  type LayoutSearchInput,
  type LayoutSearchOutput,
  type InferredContextOutput,
} from "./schemas";
import {
  getQueryContextAnalyzer,
  calculateContextBoost,
  type InferredContext,
} from "../../services/query-context-analyzer";
import { applyPreferenceReranking } from "../../services/preference-rerank.helper";
import type { IPrismaClient } from "../../services/preference-profile.service";
import { buildEmbeddingFailureError } from "../_shared/embedding-failure-response";
import {
  ProjectContextAnalyzer,
  type ProjectPatterns,
} from "../../services/project-context-analyzer";
import type { MoodBrandToneSearchService } from "../../services/search/mood-brandtone-search.service";
import type { Mood, BrandTone } from "../../schemas/mood-brandtone-filters";

// ヘルパー・型定義（search-helpers.ts から）
import {
  type ILayoutSearchService,
  type IVisionSearchService,
  type SearchOptions,
  type AdaptabilityInfo,
  type PreviewOptions,
  preprocessQuery,
  determineErrorCode,
  getIncludeHtml,
  mapSearchResult,
} from "./search-helpers";

// 検索実行関数（search-executor.ts から）
import { executeVisionSearch, executeMultimodalSearch } from "./search-executor";

// =====================================================
// Re-exports（後方互換性維持）
// =====================================================

export type { LayoutSearchInput, LayoutSearchOutput };

// search-helpers.ts の型・関数を re-export
export type {
  SearchOptions,
  VisionAnalysisResult,
  VisualFeaturesTheme,
  VisualFeaturesColors,
  VisualFeaturesDensity,
  VisualFeatures,
  SearchResult,
  SearchServiceResult,
  ILayoutSearchService,
  IVisionSearchService,
} from "./search-helpers";
export { preprocessQuery, calculateRrfScore, determineSearchMode } from "./search-helpers";

// =====================================================
// サービスファクトリー（DI）
// =====================================================

const serviceFactoryDI = createDIFactory<ILayoutSearchService>("LayoutSearchService");
const visionSearchServiceDI = createDIFactory<IVisionSearchService>("VisionSearchService");

/**
 * ProjectContextAnalyzer シングルトンインスタンス
 */
let projectContextAnalyzer: ProjectContextAnalyzer | null = null;

/**
 * ProjectContextAnalyzer インスタンスを取得
 */
function getProjectContextAnalyzer(): ProjectContextAnalyzer {
  if (!projectContextAnalyzer) {
    projectContextAnalyzer = new ProjectContextAnalyzer();
  }
  return projectContextAnalyzer;
}

export const setLayoutSearchServiceFactory = serviceFactoryDI.set;
export const resetLayoutSearchServiceFactory = serviceFactoryDI.reset;
export const setVisionSearchServiceFactory = visionSearchServiceDI.set;
export const resetVisionSearchServiceFactory = visionSearchServiceDI.reset;

/**
 * ProjectContextAnalyzer をリセット（テスト用）
 */
export function resetProjectContextAnalyzer(): void {
  if (projectContextAnalyzer) {
    projectContextAnalyzer.clearCache();
  }
  projectContextAnalyzer = null;
}

const moodBrandToneSearchServiceDI = createDIFactory<MoodBrandToneSearchService>(
  "MoodBrandToneSearchService"
);
export const setMoodBrandToneSearchServiceFactory = moodBrandToneSearchServiceDI.set;
export const resetMoodBrandToneSearchServiceFactory = moodBrandToneSearchServiceDI.reset;

const prismaClientDI = createDIFactory<IPrismaClient>("LayoutSearchPrismaClient");
export const setLayoutSearchPrismaClientFactory = prismaClientDI.set;
export const resetLayoutSearchPrismaClientFactory = prismaClientDI.reset;

// =====================================================
// メインハンドラー
// =====================================================

/**
 * layout.search ツールハンドラー
 *
 * @param input - 入力パラメータ
 * @returns 検索結果
 *
 * @example
 * ```typescript
 * const result = await layoutSearchHandler({
 *   query: 'modern hero section with gradient',
 *   filters: {
 *     sectionType: 'hero',
 *     sourceType: 'award_gallery',
 *   },
 *   limit: 10,
 *   offset: 0,
 * });
 * ```
 */
export async function layoutSearchHandler(input: unknown): Promise<LayoutSearchOutput> {
  const startTime = Date.now();

  // 開発環境でのログ出力
  if (isDevelopment()) {
    logger.info("[MCP Tool] layout.search called", {
      query: (input as Record<string, unknown>)?.query,
    });
  }

  // 入力バリデーション
  let validated: LayoutSearchInput;
  try {
    validated = layoutSearchInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");

      logger.warn("[MCP Tool] layout.search validation error", { error: (error as Error).message });

      return {
        success: false,
        error: {
          code: LAYOUT_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // サービスファクトリーチェック
  if (!serviceFactoryDI.get()) {
    if (isDevelopment()) {
      logger.error("[MCP Tool] layout.search service factory not set");
    }

    return {
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Search service is not available",
      },
    };
  }

  const service = serviceFactoryDI.get()!();

  // Search result cache check / 検索キャッシュチェック
  const cacheKey = generateCacheKey(
    "layout.search",
    validated as unknown as Record<string, unknown>
  );
  const cached = getCachedResult<LayoutSearchOutput>(cacheKey);
  if (cached) {
    return cached;
  }

  // VisionServiceファクトリの解決（executor関数に渡すため）
  const visionFactory = visionSearchServiceDI.get();
  const resolvedVisionFactory = visionFactory ? visionFactory : undefined;

  try {
    // search_mode ベースのルーティング（text_only以外の場合）
    // search_mode が明示的に指定され、text_only以外の場合はマルチモーダル検索を実行
    if (validated.search_mode && validated.search_mode !== "text_only") {
      return executeMultimodalSearch(validated, service, startTime, resolvedVisionFactory);
    }

    // Phase 4-2: Vision検索が有効な場合（レガシー互換性）
    // use_vision_search=true かつ search_mode未指定の場合
    if (validated.use_vision_search && !validated.search_mode) {
      return executeVisionSearch(validated, startTime, resolvedVisionFactory);
    }

    // 通常の検索（text_embedding）
    // クエリ前処理
    const processedQuery = preprocessQuery(validated.query);

    if (isDevelopment()) {
      logger.debug("[MCP Tool] layout.search processed query", {
        original: validated.query,
        processed: processedQuery,
      });
    }

    // Embedding解決 (discriminated union: ok / unavailable / failed)
    // ADR-0043 Decision 1 / plan v4 §4.1: layout は embedding 必須 leaf。
    // embedding 失敗を success:true total:0 で偽装せず fail-loud (success:false)。
    const embeddingResult = await service.resolveQueryEmbeddingResult(processedQuery);

    if (embeddingResult.status !== "ok") {
      // 案A leaf fail-loud: embedding unavailable/failed → success:false
      const failure = buildEmbeddingFailureError(embeddingResult.status);
      logger.warn("[MCP Tool] layout.search: embedding required but unavailable (fail-loud)", {
        code: failure.code,
        degradedReason: failure.degradedReason,
      });
      return {
        success: false,
        error: {
          code: failure.code,
          message: failure.message,
          degradedReason: failure.degradedReason,
        },
      };
    }

    const queryEmbedding = embeddingResult.embedding;

    // 検索オプション構築
    // MCP-RESP-03: include_html (snake_case) を優先使用
    const searchOptions: SearchOptions = {
      filters: validated.filters,
      limit: validated.limit,
      offset: validated.offset,
      include_html: getIncludeHtml(validated),
      project_context: validated.project_context,
    };

    // 検索実行: ハイブリッド検索（vector + fulltext RRF）が利用可能な場合はそちらを使用
    const searchResult = service.searchSectionPatternsHybrid
      ? await service.searchSectionPatternsHybrid(validated.query, queryEmbedding, searchOptions)
      : await service.searchSectionPatterns(queryEmbedding, searchOptions);

    // nullチェック
    if (!searchResult) {
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

    // TASK-06-3 Step 3: セマンティック検索統合
    // mood/brandTone フィルターに基づいてセマンティック検索を実行
    type SemanticMetadataMap = Map<
      string,
      {
        moodInfo?: { primary: Mood; secondary?: Mood | undefined };
        brandToneInfo?: { primary: BrandTone; secondary?: BrandTone | undefined };
      }
    >;
    const semanticMetadata: SemanticMetadataMap = new Map();

    // moodBrandToneSearchService インスタンスを取得
    let moodBrandToneService: MoodBrandToneSearchService | null = null;
    if (moodBrandToneSearchServiceDI.get()) {
      moodBrandToneService = moodBrandToneSearchServiceDI.get()!();
    }

    // mood フィルターが提供されている場合、セマンティック検索を実行
    if (moodBrandToneService && validated.filters?.mood) {
      try {
        const moodResults = await moodBrandToneService.searchByMood(validated.filters.mood);

        if (isDevelopment()) {
          logger.debug("[MCP Tool] layout.search mood search completed", {
            resultCount: moodResults.length,
            mood: validated.filters.mood.primary,
          });
        }

        // 結果をマッピング用に保存
        for (const moodResult of moodResults) {
          const patternId = moodResult.patternId;
          const existing = semanticMetadata.get(patternId) ?? {};
          if (moodResult.moodInfo !== undefined) {
            existing.moodInfo = moodResult.moodInfo;
          }
          semanticMetadata.set(patternId, existing);
        }
      } catch (error) {
        logger.warn("[MCP Tool] layout.search mood search failed", {
          error: (error as Error).message,
        });
        // Graceful degradation: mood 検索失敗時は続行
      }
    }

    // brandTone フィルターが提供されている場合、セマンティック検索を実行
    if (moodBrandToneService && validated.filters?.brandTone) {
      try {
        const brandToneResults = await moodBrandToneService.searchByBrandTone(
          validated.filters.brandTone
        );

        if (isDevelopment()) {
          logger.debug("[MCP Tool] layout.search brandTone search completed", {
            resultCount: brandToneResults.length,
            brandTone: validated.filters.brandTone.primary,
          });
        }

        // 結果をマッピング用に保存
        for (const brandToneResult of brandToneResults) {
          const patternId = brandToneResult.patternId;
          const existing = semanticMetadata.get(patternId) ?? {};
          if (brandToneResult.brandToneInfo !== undefined) {
            existing.brandToneInfo = brandToneResult.brandToneInfo;
          }
          semanticMetadata.set(patternId, existing);
        }
      } catch (error) {
        logger.warn("[MCP Tool] layout.search brandTone search failed", {
          error: (error as Error).message,
        });
        // Graceful degradation: brandTone 検索失敗時は続行
      }
    }

    // ProjectContext解析（オプション）
    let projectPatterns: ProjectPatterns | null = null;
    const projectContextOptions = validated.project_context;
    const isProjectContextEnabled = projectContextOptions?.enabled !== false;

    if (isProjectContextEnabled && projectContextOptions?.project_path) {
      try {
        const analyzer = getProjectContextAnalyzer();
        projectPatterns = await analyzer.detectProjectPatterns(projectContextOptions.project_path);

        if (isDevelopment()) {
          logger.debug("[MCP Tool] layout.search project patterns detected", {
            stylesCount: projectPatterns.designTokens.styles.length,
            hooksCount: projectPatterns.hooks.length,
            cssFramework: projectPatterns.cssFramework,
            animationsCount: projectPatterns.animations.length,
          });
        }
      } catch (error) {
        logger.warn("[MCP Tool] layout.search project context analysis failed", {
          error: (error as Error).message,
        });
        // ProjectContext解析失敗時は続行（Graceful degradation）
      }
    }

    // プレビューオプション
    const previewOptions: PreviewOptions = {
      includePreview: validated.include_preview,
      maxLength: validated.preview_max_length,
    };

    // REFTRIX-LAYOUT-02: auto_detect_context によるコンテキスト推論
    let inferredContext: InferredContext | null = null;
    let contextBoostApplied = false;

    if (validated.auto_detect_context !== false) {
      try {
        const queryAnalyzer = getQueryContextAnalyzer();
        inferredContext = queryAnalyzer.inferContext(validated.query);

        if (isDevelopment()) {
          logger.debug("[MCP Tool] layout.search context inferred", {
            query: validated.query,
            industry: inferredContext.industry,
            style: inferredContext.style,
            confidence: inferredContext.confidence,
            detectedKeywords: inferredContext.detectedKeywords,
          });
        }

        // 信頼度が0.5以上の場合のみブーストを適用
        if (inferredContext.confidence >= 0.5) {
          contextBoostApplied = true;
        }
      } catch (error) {
        logger.warn("[MCP Tool] layout.search context inference failed", {
          error: (error as Error).message,
        });
        // コンテキスト推論失敗時は続行（Graceful degradation）
      }
    }

    // 結果をマップ（ProjectContext解析が成功した場合はadaptabilityを計算、セマンティックメタデータを含める）
    let mappedResults = searchResult.results.map((r) => {
      let adaptabilityInfo: AdaptabilityInfo | undefined;

      if (projectPatterns && r.htmlSnippet) {
        try {
          const analyzer = getProjectContextAnalyzer();
          const adaptabilityResult = analyzer.calculateAdaptabilityScore(
            r.htmlSnippet,
            projectPatterns
          );
          adaptabilityInfo = {
            score: adaptabilityResult.score,
            hints: adaptabilityResult.integration_hints,
          };
        } catch (error) {
          logger.warn("[MCP Tool] layout.search adaptability calculation failed", {
            error: (error as Error).message,
          });
          // 個別の計算失敗は無視して続行
        }
      }

      // TASK-06-3 Step 2: セマンティックメタデータを取得
      const semanticInfo = semanticMetadata.get(r.id);

      // REFTRIX-LAYOUT-02: コンテキストブーストを計算
      let contextBoost: number | undefined;
      if (contextBoostApplied && inferredContext) {
        contextBoost = calculateContextBoost({
          context: inferredContext,
          resultMetadata: {
            heading: r.layoutInfo?.heading,
            description: r.layoutInfo?.description,
            url: r.webPage.url,
            sectionType: r.sectionType,
          },
        });
      }

      return mapSearchResult(
        r,
        getIncludeHtml(validated),
        adaptabilityInfo,
        semanticInfo,
        previewOptions,
        contextBoost
      );
    });

    // REFTRIX-LAYOUT-02: ブースト適用時は再ソート（similarity + boost で降順）
    if (contextBoostApplied) {
      mappedResults.sort((a, b) => {
        const aTotal = a.similarity + (a.context_boost ?? 0);
        const bTotal = b.similarity + (b.context_boost ?? 0);
        return bTotal - aTotal;
      });

      // ブースト後の類似度を更新（1.0上限）
      for (const result of mappedResults) {
        if (result.context_boost !== undefined && result.context_boost > 0) {
          result.similarity = Math.min(1.0, result.similarity + result.context_boost);
        }
      }
    }

    const searchTimeMs = Date.now() - startTime;

    // TASK-06-3 Step 4: filtersApplied の追跡
    const filtersApplied: string[] = [];
    if (validated.filters) {
      if (validated.filters.mood) {
        filtersApplied.push("mood");
      }
      if (validated.filters.brandTone) {
        filtersApplied.push("brandTone");
      }
      if (validated.filters.visualFeatures) {
        filtersApplied.push("visualFeatures");
      }
      if (validated.filters.sectionType) {
        filtersApplied.push("sectionType");
      }
      if (validated.filters.sourceType) {
        filtersApplied.push("sourceType");
      }
      if (validated.filters.usageScope) {
        filtersApplied.push("usageScope");
      }
    }

    if (isDevelopment()) {
      logger.info("[MCP Tool] layout.search completed", {
        query: validated.query,
        resultCount: mappedResults.length,
        total: searchResult.total,
        searchTimeMs,
        filtersApplied,
        contextBoostApplied,
      });
    }

    // 嗜好プロファイルによるリランキング / Preference profile reranking
    mappedResults = await applyPreferenceReranking(
      mappedResults,
      validated.profile_id,
      prismaClientDI.get(),
      "layout",
      "layout.search"
    );

    // REFTRIX-LAYOUT-02: Build inferred_context output
    let inferredContextOutput: InferredContextOutput | undefined;
    if (validated.auto_detect_context !== false && inferredContext) {
      inferredContextOutput = {
        industry: inferredContext.industry,
        style: inferredContext.style,
        confidence: inferredContext.confidence,
        detected_keywords: inferredContext.detectedKeywords,
      };
    }

    const result: LayoutSearchOutput = {
      success: true,
      data: {
        results: mappedResults,
        total: searchResult.total,
        query: validated.query,
        filters: validated.filters ?? {},
        filtersApplied,
        searchTimeMs,
        inferred_context: inferredContextOutput,
        context_boost_applied: contextBoostApplied,
      },
    };
    // Cache successful results / 成功結果をキャッシュ
    setCachedResult(cacheKey, result);
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = determineErrorCode(error instanceof Error ? error : errorMessage);

    logger.error("[MCP Tool] layout.search error", {
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
// ツール定義
// =====================================================

/**
 * layout.search MCPツール定義
 * MCP Protocol用のツール定義オブジェクト
 */
export const layoutSearchToolDefinition = {
  name: "layout.search",
  description:
    "セクションパターンを自然言語クエリでセマンティック検索します。" +
    "日本語・英語の両方に対応しています。" +
    "hero、feature、cta、testimonial、pricing、footer等のセクションタイプでフィルタリングできます。" +
    "use_vision_search=trueでvision_embeddingを使用したハイブリッド検索（RRF: 60% vision + 40% text）が可能です。",
  annotations: {
    title: "Layout Search",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "検索クエリ（日本語または英語、1-500文字）",
        minLength: 1,
        maxLength: 500,
      },
      filters: {
        type: "object",
        description: "検索フィルター",
        properties: {
          sectionType: {
            type: "string",
            enum: [
              "hero",
              "feature",
              "cta",
              "testimonial",
              "pricing",
              "footer",
              "navigation",
              "about",
              "contact",
              "gallery",
            ],
            description: "セクションタイプでフィルター",
          },
          sourceType: {
            type: "string",
            enum: ["award_gallery", "user_provided"],
            description:
              "ソースタイプでフィルター（award_gallery: アワードサイト、user_provided: ユーザー提供）",
          },
          usageScope: {
            type: "string",
            enum: ["inspiration_only", "owned_asset"],
            description:
              "利用範囲でフィルター（inspiration_only: インスピレーションのみ、owned_asset: 所有アセット）",
          },
          webPageId: {
            type: "string",
            format: "uuid",
            description: "WebページIDでフィルター / Filter by web page ID",
          },
          webPageUrl: {
            type: "string",
            format: "uri",
            description: "WebページURLでフィルター / Filter by web page URL",
          },
          industry: {
            type: "string",
            description: "業種フィルター（例: tech, finance, healthcare） / Industry filter",
            maxLength: 100,
          },
          audience: {
            type: "string",
            description:
              "ターゲットオーディエンス（例: b2b, b2c, enterprise） / Target audience filter",
            maxLength: 100,
          },
          tags: {
            type: "array",
            items: { type: "string", maxLength: 50 },
            maxItems: 10,
            description: "タグフィルター / Tag filter",
          },
        },
      },
      limit: {
        type: "number",
        description: "取得件数（1-50、デフォルト: 10）",
        minimum: 1,
        maximum: 50,
        default: 10,
      },
      offset: {
        type: "number",
        description: "オフセット（0以上、デフォルト: 0）",
        minimum: 0,
        default: 0,
      },
      // MCP-RESP-03: snake_case正式形式（新規オプション推奨形式）
      include_html: {
        type: "boolean",
        description: "HTMLスニペットを含めるか（デフォルト: false）- snake_case正式形式",
        default: false,
      },
      // レガシー互換: camelCaseは後方互換として維持
      includeHtml: {
        type: "boolean",
        description:
          "HTMLスニペットを含めるか（デフォルト: false）- レガシー互換、include_html推奨",
        default: false,
      },
      include_preview: {
        type: "boolean",
        description: "サニタイズ済みHTMLプレビューを含めるか（デフォルト: true）",
        default: true,
      },
      preview_max_length: {
        type: "number",
        description: "HTMLプレビューの最大文字数（100-1000、デフォルト: 500）",
        minimum: 100,
        maximum: 1000,
        default: 500,
      },
      project_context: {
        type: "object",
        description:
          "プロジェクトコンテキスト解析オプション。プロジェクトのデザインパターンを検出し、検索結果の適合度を評価します。",
        properties: {
          enabled: {
            type: "boolean",
            description: "プロジェクトコンテキスト解析を有効化（デフォルト: true）",
            default: true,
          },
          project_path: {
            type: "string",
            description: "スキャン対象のプロジェクトパス（例: /home/user/my-project）",
          },
          design_tokens_path: {
            type: "string",
            description: "デザイントークンファイルの特定パス（オプション）",
          },
        },
      },
      // Phase 4-3: Auto Context Detection
      auto_detect_context: {
        type: "boolean",
        description:
          "クエリから業界・スタイルコンテキストを自動推論し、結果をブーストします。推論されたコンテキスト（業界: technology/ecommerce/healthcare等、スタイル: minimal/bold/corporate等）にマッチする結果の類似度スコアが最大0.15ブーストされます（デフォルト: true）",
        default: true,
      },
      // Phase 4-2: Vision Search Parameters
      use_vision_search: {
        type: "boolean",
        description:
          "Vision検索を有効化。vision_embeddingを使用したセマンティック検索を行います（デフォルト: false）",
        default: false,
      },
      vision_search_query: {
        type: "object",
        description: "Vision検索クエリ（use_vision_search=true時に使用）",
        properties: {
          textQuery: {
            type: "string",
            description: "テキストクエリ（視覚的特徴を自然言語で記述）",
          },
          visualFeatures: {
            type: "object",
            description: "構造化された視覚的特徴条件",
            properties: {
              theme: { type: "string", description: "テーマ（light/dark/mixed）" },
              colors: {
                type: "array",
                items: { type: "string" },
                description: "色指定（HEX形式配列）",
              },
              density: { type: "string", description: "密度（sparse/moderate/dense）" },
              gradient: { type: "string", description: "グラデーション（none/subtle/prominent）" },
              mood: { type: "string", description: "雰囲気（professional/playful/minimal等）" },
              brandTone: { type: "string", description: "ブランドトーン" },
            },
          },
          sectionPatternId: {
            type: "string",
            format: "uuid",
            description: "既存セクションIDで類似検索",
          },
        },
      },
      vision_search_options: {
        type: "object",
        description: "Vision検索オプション（use_vision_search=true時に使用）",
        properties: {
          minSimilarity: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.5,
            description: "最小類似度（0-1、デフォルト: 0.5）",
          },
          visionWeight: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.6,
            description: "RRFでのvision_embeddingの重み（0-1、デフォルト: 0.6）",
          },
          textWeight: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.4,
            description: "RRFでのtext_embeddingの重み（0-1、デフォルト: 0.4）",
          },
        },
      },
      // Multimodal Search Parameters
      search_mode: {
        type: "string",
        enum: ["text_only", "vision_only", "combined"],
        default: "text_only",
        description:
          "検索モード。" +
          "text_only: text_embeddingのみを使用（デフォルト）。" +
          "vision_only: vision_embeddingのみを使用。" +
          "combined: 両方を使用してRRF統合検索。",
      },
      multimodal_options: {
        type: "object",
        description: "マルチモーダルオプション。search_mode='combined'時のRRF統合パラメータ。",
        properties: {
          textWeight: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.6,
            description: "text_embeddingの重み（0-1、デフォルト: 0.6）",
          },
          visionWeight: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.4,
            description: "vision_embeddingの重み（0-1、デフォルト: 0.4）",
          },
          rrfK: {
            type: "number",
            minimum: 1,
            maximum: 100,
            default: 60,
            description: "RRFのkパラメータ（1-100、デフォルト: 60）",
          },
        },
      },
      // Preference reranking
      profile_id: {
        type: "string",
        format: "uuid",
        description:
          "嗜好プロファイルID（検索結果のリランキングに使用） / Preference profile ID (used for search result reranking)",
      },
    },
    required: ["query"],
  },
};

// =====================================================
// 開発環境ログ
// =====================================================

if (isDevelopment()) {
  logger.debug("[layout.search] Tool module loaded");
}
