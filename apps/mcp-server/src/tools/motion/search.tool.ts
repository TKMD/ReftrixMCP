// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.search MCPツール
 * モーションパターンを類似検索します
 *
 * 機能:
 * - 自然言語クエリによる検索
 * - サンプルパターンによる類似検索
 * - フィルタリング（タイプ、duration範囲、トリガー）
 * - 類似度しきい値によるフィルタリング
 * - Phase3-3: コード生成機能の統合（action: 'generate'）
 *
 * @module tools/motion/search.tool
 */

import { createDIFactory } from "../../utils/di-factory";
import { logger, isDevelopment } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import {
  generateCacheKey,
  getCachedResult,
  setCachedResult,
} from "../../services/search-cache.service";

import {
  motionSearchInputSchema,
  MOTION_SEARCH_ERROR_CODES,
  MOTION_MCP_ERROR_CODES,
  type MotionSearchInput,
  type MotionSearchOutput,
  type MotionSearchResultItem,
  type MotionSearchQueryInfo,
  type MotionSearchFilters,
  type SamplePattern,
  type MotionPatternInput,
  type ImplementationFormat,
  type ImplementationOptions,
  type JSAnimationFilters,
  type JSAnimationInfo,
  type WebGLAnimationFilters,
  type WebGLAnimationInfo,
  type GenerationOptions,
  type DuplicateCheckResult,
} from "./schemas";

import {
  ExistingAnimationDetectorService,
  type NewAnimationPattern,
} from "../../services/motion/existing-animation-detector.service";
import { applyPreferenceReranking } from "../../services/preference-rerank.helper";
import type { IPrismaClient } from "../../services/preference-profile.service";

// 分割モジュールからのインポート
import { generateImplementation, type GenerationResult } from "./code-generators";
import { applyDiversityFilter, enrichResultsWithImplementation } from "./search-helpers";

// =====================================================
// 型定義
// =====================================================

export type { MotionSearchInput, MotionSearchOutput };
export type { GenerationResult };

/**
 * 検索パラメータ
 */
export interface MotionSearchParams {
  query?: string | undefined;
  samplePattern?: SamplePattern | undefined;
  filters?: MotionSearchFilters | undefined;
  limit: number;
  minSimilarity: number;
  /** JSアニメーションを検索に含めるか（v0.1.0） */
  include_js_animations?: boolean;
  /** JSアニメーション検索フィルター（v0.1.0） */
  js_animation_filters?: JSAnimationFilters | undefined;
  /** WebGLアニメーションを検索に含めるか（v0.1.0） */
  include_webgl_animations?: boolean;
  /** WebGLアニメーション検索フィルター（v0.1.0） */
  webgl_animation_filters?: WebGLAnimationFilters | undefined;
  /** 検索結果に実装コードを含めるか（v0.1.0） */
  include_implementation?: boolean;
  /** 結果の多様性しきい値（v0.1.0、0.0-1.0、デフォルト: 0.3） */
  diversity_threshold?: number;
  /** カテゴリ分散を強制するか（v0.1.0、デフォルト: true） */
  ensure_category_diversity?: boolean;
}

/**
 * JSアニメーション検索結果アイテム
 * MotionSearchResultItemにJSアニメーション情報を追加
 */
export interface JSAnimationSearchResultItem extends Omit<MotionSearchResultItem, "pattern"> {
  /** パターン情報 */
  pattern: MotionSearchResultItem["pattern"];
  /** JSアニメーション固有情報 */
  jsAnimationInfo?: JSAnimationInfo;
}

/**
 * WebGLアニメーション検索結果アイテム
 * MotionSearchResultItemにWebGLアニメーション情報を追加
 * v0.1.0
 */
export interface WebGLAnimationSearchResultItem extends Omit<MotionSearchResultItem, "pattern"> {
  /** パターン情報 */
  pattern: MotionSearchResultItem["pattern"];
  /** WebGLアニメーション固有情報 */
  webglAnimationInfo?: WebGLAnimationInfo;
}

/**
 * 検索結果
 */
export interface MotionSearchResult {
  results: MotionSearchResultItem[];
  total: number;
  query?: MotionSearchQueryInfo;
}

// =====================================================
// サービスインターフェース（DI用）
// =====================================================

/**
 * モーション検索サービスインターフェース
 */
export interface IMotionSearchService {
  /**
   * モーションパターンを検索
   */
  search: (params: MotionSearchParams) => Promise<MotionSearchResult>;

  /**
   * ハイブリッド検索（ベクトル + 全文検索、RRFマージ）
   * 利用可能な場合に search() の代わりに使用される
   */
  searchHybrid?: (params: MotionSearchParams) => Promise<MotionSearchResult>;

  /**
   * テキストからEmbeddingを取得（オプショナル）
   */
  getEmbedding?: (text: string) => Promise<number[]>;
}

/**
 * コード生成サービスインターフェース（Phase3-3統合用）
 */
export interface IMotionImplementationService {
  generate: (
    pattern: MotionPatternInput,
    format: ImplementationFormat,
    options: ImplementationOptions
  ) => GenerationResult | null;
}

const serviceFactoryDI = createDIFactory<IMotionSearchService>("MotionSearchService");
export const setMotionSearchServiceFactory = serviceFactoryDI.set;
export const resetMotionSearchServiceFactory = serviceFactoryDI.reset;

const implementationServiceDI = createDIFactory<IMotionImplementationService | null>(
  "MotionImplementationService"
);
export const setMotionImplementationServiceFactory = implementationServiceDI.set;
export const resetMotionImplementationServiceFactory = implementationServiceDI.reset;

const prismaClientDI = createDIFactory<IPrismaClient>("MotionSearchPrismaClient");
export const setMotionSearchPrismaClientFactory = prismaClientDI.set;
export const resetMotionSearchPrismaClientFactory = prismaClientDI.reset;

// =====================================================
// ハンドラー
// =====================================================

/**
 * motion.search ツールハンドラー
 *
 * Phase3-3: action パラメータによる機能統合
 * - action: 'search' (デフォルト) → 検索機能
 * - action: 'generate' → コード生成機能
 */
export async function motionSearchHandler(input: unknown): Promise<MotionSearchOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] motion.search called", {
      hasInput: input !== null && input !== undefined,
    });
  }

  // 入力バリデーション
  let validated: MotionSearchInput;
  try {
    validated = motionSearchInputSchema.parse(input);
  } catch (error) {
    logger.warn("[MCP Tool] motion.search validation error", { error: (error as Error).message });
    return {
      success: false,
      error: {
        code: MOTION_SEARCH_ERROR_CODES.VALIDATION_ERROR,
        message: sanitizeErrorMessage(error),
      },
    };
  }

  // Phase3-3: action分岐
  const action = validated.action ?? "search";

  if (action === "generate") {
    // コード生成処理
    return handleGenerateAction(validated);
  }

  // 検索処理（既存ロジック）
  return handleSearchAction(validated);
}

/**
 * action: 'search' の処理
 */
async function handleSearchAction(validated: MotionSearchInput): Promise<MotionSearchOutput> {
  // Search result cache check / 検索キャッシュチェック
  const cacheKey = generateCacheKey(
    "motion.search",
    validated as unknown as Record<string, unknown>
  );
  const cached = getCachedResult<MotionSearchOutput>(cacheKey);
  if (cached) {
    return cached;
  }

  // サービスファクトリのチェック
  if (!serviceFactoryDI.get()) {
    if (isDevelopment()) {
      logger.error("[MCP Tool] motion.search service factory not set");
    }
    return {
      success: false,
      error: {
        code: MOTION_SEARCH_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "Motion search service is not available",
      },
    };
  }

  try {
    const service = serviceFactoryDI.get()!();

    // 検索パラメータを構築（v0.1.0: JSアニメーション検索パラメータ追加、v0.1.0: WebGLアニメーション検索パラメータ追加、v0.1.0: include_implementation追加）
    const searchParams: MotionSearchParams = {
      query: validated.query,
      samplePattern: validated.samplePattern,
      filters: validated.filters,
      limit: validated.limit,
      minSimilarity: validated.minSimilarity,
      include_js_animations: validated.include_js_animations,
      js_animation_filters: validated.js_animation_filters,
      include_webgl_animations: validated.include_webgl_animations,
      webgl_animation_filters: validated.webgl_animation_filters,
      include_implementation: validated.include_implementation,
    };

    if (isDevelopment()) {
      logger.info("[MCP Tool] motion.search executing search", {
        hasQuery: !!searchParams.query,
        hasSamplePattern: !!searchParams.samplePattern,
        hasFilters: !!searchParams.filters,
        limit: searchParams.limit,
        minSimilarity: searchParams.minSimilarity,
        includeJsAnimations: searchParams.include_js_animations,
        hasJsAnimationFilters: !!searchParams.js_animation_filters,
        includeWebglAnimations: searchParams.include_webgl_animations,
        hasWebglAnimationFilters: !!searchParams.webgl_animation_filters,
        includeImplementation: searchParams.include_implementation,
        diversityThreshold: validated.diversity_threshold ?? 0.3,
        ensureCategoryDiversity: validated.ensure_category_diversity ?? true,
      });
    }

    // 検索実行（ハイブリッド検索優先）
    const searchResult = service.searchHybrid
      ? await service.searchHybrid(searchParams)
      : await service.search(searchParams);

    // v0.1.0: 多様性フィルタリングを適用
    const diversityThreshold = validated.diversity_threshold ?? 0.3;
    const ensureCategoryDiversity = validated.ensure_category_diversity ?? true;
    const diverseResults = applyDiversityFilter(
      searchResult.results,
      diversityThreshold,
      ensureCategoryDiversity,
      validated.limit
    );

    // v0.1.0: include_implementation が true の場合、実装コードを付与
    let results = validated.include_implementation
      ? enrichResultsWithImplementation(diverseResults)
      : diverseResults;

    // 嗜好プロファイルによるリランキング / Preference profile reranking
    // motion結果はpattern.idにIDがあるため、top-levelにidをマッピング
    // Motion results have ID in pattern.id, so map id to top-level
    const resultsWithId = results.map((r) => ({ ...r, id: r.pattern.id }));
    results = (await applyPreferenceReranking(
      resultsWithId,
      validated.profile_id,
      prismaClientDI.get(),
      "motion",
      "motion.search"
    )) as typeof results;

    if (isDevelopment()) {
      logger.info("[MCP Tool] motion.search completed", {
        resultsCount: results.length,
        originalCount: searchResult.results.length,
        total: searchResult.total,
        includeImplementation: validated.include_implementation,
        diversityThreshold,
        ensureCategoryDiversity,
      });
    }

    const result: MotionSearchOutput = {
      success: true,
      data: {
        results,
        total: searchResult.total,
        query: searchResult.query,
      },
    };
    // Cache successful results / 成功結果をキャッシュ
    setCachedResult(cacheKey, result);
    return result;
  } catch (error) {
    logger.warn("[MCP Tool] motion.search error", { error: (error as Error).message });

    // エラータイプに基づいてエラーコードを決定
    const errorCode =
      error instanceof Error && error.message.includes("Embedding")
        ? MOTION_SEARCH_ERROR_CODES.EMBEDDING_ERROR
        : MOTION_SEARCH_ERROR_CODES.SEARCH_ERROR;

    return {
      success: false,
      error: {
        code: errorCode,
        message: sanitizeErrorMessage(error),
      },
    };
  }
}

/**
 * action: 'generate' の処理（Phase3-3統合）
 * v0.1.0: 重複検出機能追加
 */
async function handleGenerateAction(validated: MotionSearchInput): Promise<MotionSearchOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] motion.search action: generate", {
      hasPattern: !!validated.pattern,
      format: validated.format,
      checkDuplicates: validated.generation_options?.check_duplicates,
    });
  }

  // pattern が必須
  if (!validated.pattern) {
    return {
      success: false,
      error: {
        code: MOTION_MCP_ERROR_CODES.VALIDATION_ERROR,
        message: "action: generate には pattern パラメータが必要です",
      },
    };
  }

  try {
    const pattern = validated.pattern;
    const format = validated.format ?? "css";
    const options: ImplementationOptions = {
      selector: validated.options?.selector ?? ".animated",
      includeVendorPrefixes: validated.options?.includeVendorPrefixes ?? false,
      includeReducedMotion: validated.options?.includeReducedMotion ?? true,
      typescript: validated.options?.typescript ?? true,
      componentName: validated.options?.componentName,
    };
    const generationOptions = validated.generation_options;

    // v0.1.0: 重複チェック実行
    let duplicateCheckResult: DuplicateCheckResult | undefined;

    if (generationOptions?.check_duplicates) {
      try {
        duplicateCheckResult = await performDuplicateCheck(pattern, generationOptions);

        if (isDevelopment()) {
          logger.info("[MCP Tool] motion.search duplicate check completed", {
            hasDuplicates: duplicateCheckResult.has_duplicates,
            matchCount: duplicateCheckResult.existing_matches.length,
          });
        }
      } catch (error) {
        logger.warn("[MCP Tool] motion.search duplicate check failed, continuing generation", {
          error: (error as Error).message,
        });
        // 重複チェック失敗時は警告のみでコード生成は続行
      }
    }

    // サービス経由で生成（DIパターン）
    let result: GenerationResult | null = null;
    const service = implementationServiceDI.get()?.();

    if (service?.generate) {
      try {
        result = service.generate(pattern, format, options);
      } catch (error) {
        logger.warn("[MCP Tool] motion.search generate service error", {
          error: (error as Error).message,
        });
        return {
          success: false,
          error: {
            code: MOTION_MCP_ERROR_CODES.INTERNAL_ERROR,
            message: sanitizeErrorMessage(error),
          },
        };
      }
    } else {
      // デフォルト実装
      result = generateImplementation(pattern, format, options);
    }

    if (!result) {
      return {
        success: false,
        error: {
          code: MOTION_MCP_ERROR_CODES.INTERNAL_ERROR,
          message: "Generation returned null",
        },
      };
    }

    if (isDevelopment()) {
      logger.info("[MCP Tool] motion.search generate completed", {
        format,
        linesOfCode: result.metadata.linesOfCode,
        hasDuplicateCheck: !!duplicateCheckResult,
      });
    }

    return {
      success: true,
      data: {
        code: result.code,
        format,
        metadata: result.metadata,
        duplicate_check: duplicateCheckResult,
      },
    };
  } catch (error) {
    logger.warn("[MCP Tool] motion.search generate error", { error: (error as Error).message });
    return {
      success: false,
      error: {
        code: MOTION_MCP_ERROR_CODES.INTERNAL_ERROR,
        message: sanitizeErrorMessage(error),
      },
    };
  }
}

/**
 * 重複チェックを実行
 * v0.1.0: ExistingAnimationDetectorServiceを使用
 */
async function performDuplicateCheck(
  pattern: MotionPatternInput,
  generationOptions: GenerationOptions
): Promise<DuplicateCheckResult> {
  const detector = new ExistingAnimationDetectorService();

  // MotionPatternInput を NewAnimationPattern に変換
  const newPattern: NewAnimationPattern = {
    name: pattern.name,
    type: pattern.type,
    duration: pattern.duration,
    easing: pattern.easing,
    properties: pattern.properties.map((p) => {
      const prop: NewAnimationPattern["properties"][number] = {
        name: p.name,
        from: p.from,
        to: p.to,
      };
      // keyframesがundefinedでない場合のみ設定
      if (p.keyframes) {
        prop.keyframes = p.keyframes;
      }
      return prop;
    }),
  };

  // オプションを構築（undefinedフィールドを除外）
  const checkOptions: {
    projectCSSPath?: string;
    projectCSSPaths?: string[];
    similarityThreshold?: number;
  } = {
    similarityThreshold: generationOptions.similarity_threshold,
  };

  if (generationOptions.project_css_path) {
    checkOptions.projectCSSPath = generationOptions.project_css_path;
  }
  if (generationOptions.project_css_paths) {
    checkOptions.projectCSSPaths = generationOptions.project_css_paths;
  }

  const result = await detector.checkDuplicates(newPattern, checkOptions);

  // DuplicateCheckResult スキーマ形式に変換
  return {
    has_duplicates: result.hasDuplicates,
    existing_matches: result.existingMatches.map((match) => ({
      animation_name: match.animationName,
      file_path: match.filePath,
      similarity: match.similarity,
      suggestion: match.suggestion,
    })),
    warnings: result.warnings,
  };
}

// =====================================================
// ツール定義
// =====================================================

export const motionSearchToolDefinition = {
  name: "motion.search",
  description:
    "モーションパターンを類似検索、または実装コードを生成します。action: search（デフォルト）で検索、action: generateでCSS/JS実装コードを生成します。",
  annotations: {
    title: "Motion Search",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      // Phase3-3: action parameter for consolidation
      action: {
        type: "string",
        enum: ["search", "generate"],
        default: "search",
        description: "アクション: search（デフォルト）= モーション検索、generate = 実装コード生成",
      },
      // === Search parameters (action: search) ===
      query: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "検索クエリ（自然言語、1-500文字）。action: searchで使用。",
      },
      samplePattern: {
        type: "object",
        description: "サンプルパターンで類似検索。action: searchで使用。",
        properties: {
          type: {
            type: "string",
            enum: ["animation", "transition", "transform", "scroll", "hover", "keyframe"],
            description: "モーションタイプ",
          },
          duration: {
            type: "number",
            minimum: 0,
            description: "アニメーション時間（ms）",
          },
          easing: {
            type: "string",
            description: "イージング関数",
          },
          properties: {
            type: "array",
            items: { type: "string" },
            description: "アニメーション対象プロパティ",
          },
        },
      },
      filters: {
        type: "object",
        description: "検索フィルター。action: searchで使用。",
        properties: {
          type: {
            type: "string",
            enum: ["animation", "transition", "transform", "scroll", "hover", "keyframe"],
            description: "タイプでフィルタリング",
          },
          minDuration: {
            type: "number",
            minimum: 0,
            description: "最小duration（ms）",
          },
          maxDuration: {
            type: "number",
            minimum: 0,
            description: "最大duration（ms）",
          },
          trigger: {
            type: "string",
            enum: ["load", "hover", "scroll", "click", "focus", "custom"],
            description: "トリガーでフィルタリング",
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
        minimum: 1,
        maximum: 50,
        default: 10,
        description: "結果制限（1-50、デフォルト: 10）。action: searchで使用。",
      },
      minSimilarity: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 0.5,
        description: "最小類似度しきい値（0-1、デフォルト: 0.5）。action: searchで使用。",
      },
      // === JSAnimation search parameters (v0.1.0) ===
      include_js_animations: {
        type: "boolean",
        default: true,
        description:
          "JSアニメーションパターンを検索結果に含める（デフォルト: true）。action: searchで使用。",
      },
      js_animation_filters: {
        type: "object",
        description: "JSアニメーション検索フィルター。action: searchで使用。",
        properties: {
          libraryType: {
            type: "string",
            enum: [
              "gsap",
              "framer_motion",
              "anime_js",
              "three_js",
              "lottie",
              "web_animations_api",
              "unknown",
            ],
            description:
              "ライブラリタイプでフィルタリング（gsap, framer_motion, anime_js, three_js, lottie, web_animations_api, unknown）",
          },
          animationType: {
            type: "string",
            enum: [
              "tween",
              "timeline",
              "spring",
              "physics",
              "keyframe",
              "morphing",
              "path",
              "scroll_driven",
              "gesture",
            ],
            description:
              "アニメーションタイプでフィルタリング（tween, timeline, spring, physics, keyframe, morphing, path, scroll_driven, gesture）",
          },
        },
      },
      // === WebGLAnimation search parameters (v0.1.0) ===
      include_webgl_animations: {
        type: "boolean",
        default: true,
        description:
          "WebGLアニメーションパターンを検索結果に含める（デフォルト: true）。action: searchで使用。",
      },
      webgl_animation_filters: {
        type: "object",
        description: "WebGLアニメーション検索フィルター。action: searchで使用。",
        properties: {
          category: {
            type: "string",
            enum: [
              "fade",
              "pulse",
              "wave",
              "particle",
              "morph",
              "rotation",
              "parallax",
              "noise",
              "complex",
            ],
            description:
              "カテゴリでフィルタリング（fade, pulse, wave, particle, morph, rotation, parallax, noise, complex）",
          },
          detectedLibrary: {
            type: "string",
            description: "検出されたライブラリでフィルタリング（例: three.js, babylon.js）",
          },
          minConfidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "最小信頼度しきい値（0-1）",
          },
        },
      },
      // === Implementation code parameter (v0.1.0) ===
      include_implementation: {
        type: "boolean",
        default: false,
        description:
          "検索結果に実装コード（@keyframes, animation, tailwindクラス）を含める（デフォルト: false）。action: searchで使用。",
      },
      // === Generate parameters (action: generate) ===
      pattern: {
        type: "object",
        description: "モーションパターン定義。action: generateで必須。",
        properties: {
          type: {
            type: "string",
            enum: ["animation", "transition", "transform", "scroll", "hover", "keyframe"],
            description: "パターンタイプ",
          },
          name: {
            type: "string",
            minLength: 1,
            maxLength: 100,
            description: "アニメーション名（1-100文字）",
          },
          properties: {
            type: "array",
            minItems: 1,
            description: "アニメーション対象プロパティ",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "CSSプロパティ名" },
                from: { type: "string", description: "開始値" },
                to: { type: "string", description: "終了値" },
                keyframes: {
                  type: "array",
                  description: "中間キーフレーム（オプション）",
                  items: {
                    type: "object",
                    properties: {
                      offset: { type: "number", minimum: 0, maximum: 1 },
                      value: { type: "string" },
                    },
                  },
                },
              },
              required: ["name", "from", "to"],
            },
          },
          duration: {
            type: "number",
            minimum: 0,
            maximum: 60000,
            default: 300,
            description: "アニメーション時間（ms、デフォルト: 300）",
          },
          delay: {
            type: "number",
            minimum: 0,
            maximum: 60000,
            default: 0,
            description: "遅延時間（ms、デフォルト: 0）",
          },
          easing: {
            type: "string",
            default: "ease",
            description: "イージング関数（デフォルト: ease）",
          },
          iterations: {
            oneOf: [
              { type: "number", minimum: 1 },
              { type: "string", enum: ["infinite"] },
            ],
            default: 1,
            description: "繰り返し回数（デフォルト: 1、またはinfinite）",
          },
          direction: {
            type: "string",
            enum: ["normal", "reverse", "alternate", "alternate-reverse"],
            default: "normal",
            description: "アニメーション方向（デフォルト: normal）",
          },
          fillMode: {
            type: "string",
            enum: ["none", "forwards", "backwards", "both"],
            default: "none",
            description: "フィルモード（デフォルト: none）",
          },
        },
        required: ["type", "name", "properties"],
      },
      format: {
        type: "string",
        enum: [
          "css",
          "css-module",
          "tailwind",
          "styled-components",
          "emotion",
          "framer-motion",
          "gsap",
        ],
        default: "css",
        description: "出力フォーマット（デフォルト: css）。action: generateで使用。",
      },
      options: {
        type: "object",
        description: "生成オプション。action: generateで使用。",
        properties: {
          selector: {
            type: "string",
            default: ".animated",
            description: "CSSセレクタ（デフォルト: .animated）",
          },
          componentName: {
            type: "string",
            description: "コンポーネント名（JSライブラリ用、省略時は自動生成）",
          },
          typescript: {
            type: "boolean",
            default: true,
            description: "TypeScriptコードを生成（デフォルト: true）",
          },
          includeReducedMotion: {
            type: "boolean",
            default: true,
            description: "prefers-reduced-motion対応を含める（デフォルト: true）",
          },
          includeVendorPrefixes: {
            type: "boolean",
            default: false,
            description: "ベンダープレフィックスを含める（デフォルト: false）",
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
  },
};
