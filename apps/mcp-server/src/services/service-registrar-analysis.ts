// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Service Registrar - Analysis
 *
 * Motion, Layout, Quality ドメインのDIファクトリ登録。
 * service-initializer.ts から分離。
 *
 * Analysis domain (Motion, Layout, Quality) DI factory registration.
 * Extracted from service-initializer.ts.
 *
 * @module services/service-registrar-analysis
 */

import type { PrismaClient } from "@prisma/client";

import { logger } from "../utils/logger";
import { createPrismaWrapper } from "../utils/prisma-wrapper-factory";
import { isDevelopmentEnvironment } from "./production-guard";

import type { ServiceInitializerConfig, ServiceInitializerResult } from "./service-initializer";

// Motion関連インポート
// 循環依存解消: tools/motion/index.ts ではなく個別ファイルからインポート
import {
  setMotionDetectServiceFactory,
  setMotionPersistenceServiceFactory,
  setJSAnimationPersistencePrismaClientFactory,
  type IJSAnimationPersistencePrismaClient,
} from "../tools/motion/di-factories";
import {
  setMotionSearchServiceFactory,
  setMotionSearchPrismaClientFactory as setMotionSearchRerankPrismaClientFactory,
} from "../tools/motion/search.tool";
import {
  setMotionPersistenceEmbeddingServiceFactory,
  setMotionPersistencePrismaClientFactory,
  MotionPatternPersistenceService,
  type IPrismaClient as IMotionPrismaClient,
} from "./motion-persistence.service";
import {
  createMotionSearchServiceFactory,
  setEmbeddingServiceFactory as setMotionSearchEmbeddingServiceFactory,
  setPrismaClientFactory as setMotionSearchPrismaClientFactory,
  setJSAnimationSearchServiceFactory,
  type IPrismaClient as IMotionSearchPrismaClient,
} from "./motion-search.service";
import {
  setJSAnimationEmbeddingServiceFactory,
  type IEmbeddingService as IJSAnimationEmbeddingService,
} from "./motion/js-animation-embedding.service";
import {
  JSAnimationSearchService,
  type IPrismaClient as IJSAnimationSearchPrismaClient,
} from "./motion/js-animation-search.service";
import {
  setMotionDbEmbeddingServiceFactory,
  setMotionDbPrismaClientFactory,
  type IPrismaClient as IMotionDbPrismaClient,
} from "./motion/motion-db.service";
import {
  setEmbeddingServiceFactory as setFrameEmbeddingServiceFactory,
  setPrismaClientFactory as setFramePrismaClientFactory,
  type IPrismaClient as IFramePrismaClient,
} from "./motion/frame-embedding.service";

// Layout関連インポート
// 循環依存解消: tools/layout/index.ts ではなく個別ファイルからインポート
import {
  setLayoutSearchServiceFactory,
  setLayoutSearchPrismaClientFactory as setLayoutSearchRerankPrismaClientFactory,
} from "../tools/layout/search.tool";
import { setLayoutToCodeServiceFactory } from "../tools/layout/to-code.tool";
import { setLayoutInspectServiceFactory } from "../tools/layout/inspect";
import { setLayoutIngestServiceFactory } from "../tools/layout/ingest.tool";
import {
  createLayoutSearchServiceFactory,
  setLayoutEmbeddingServiceFactory as setLayoutSearchEmbeddingServiceFactory,
  setLayoutPrismaClientFactory as setLayoutSearchPrismaClientFactory,
  type IPrismaClient as ILayoutSearchPrismaClient,
} from "./layout-search.service";
import {
  createLayoutToCodeServiceFactory,
  setLayoutToCodePrismaClientFactory,
  type IPrismaClient as ILayoutToCodePrismaClient,
} from "./layout-to-code.service";
import {
  setEmbeddingServiceFactory as setLayoutEmbeddingServiceFactory,
  setPrismaClientFactory as setLayoutPrismaClientFactory,
  saveSectionWithEmbedding,
  type SaveSectionOptions,
  type IPrismaClient as ILayoutPrismaClient,
} from "./layout-embedding.service";
import {
  detectSections,
  analyzeTypography,
  detectGrid,
  extractColors,
  type LayoutInspectData,
  type SectionInfo,
} from "../tools/layout/inspect";
import type { ScreenshotInput } from "../tools/layout/inspect/inspect.tool";

// Vision Adapter インポート
import { LlamaVisionAdapter } from "./vision-adapter/llama-vision.adapter";
import type { IVisionAnalyzer, VisionAnalysisResult } from "./vision-adapter/interface";

// Preference型インポート（リランキング用PrismaClientFactory登録で使用）
import type { IPrismaClient as IPreferencePrismaClient } from "./preference-profile.service";

// Quality関連インポート
import {
  setQualityEvaluateServiceFactory,
  setBenchmarkServiceFactory,
  setPatternMatcherServiceFactory,
} from "../tools/quality/evaluate.tool";
import { BenchmarkService } from "./quality/benchmark.service";
import {
  setPatternMatcherPrismaClientFactory,
  createPatternMatcherServiceFactory,
  type IPrismaClient as IPatternMatcherPrismaClient,
} from "./quality/pattern-matcher.service";
import { createQualitySearchService } from "./quality-search.service";

// =====================================================
// 内部型定義
// =====================================================

/**
 * Motion用WebPage結果型
 */
interface MotionWebPageResult {
  id: string;
  htmlContent: string;
  cssContent?: string;
}

/**
 * Layout用WebPage結果型
 */
interface LayoutWebPageResult {
  id: string;
  htmlContent: string;
}

/**
 * Layout用拡張Embeddingサービスインターフェース
 */
interface ILayoutEmbeddingService {
  generateEmbedding(text: string, type: "query" | "passage"): Promise<number[]>;
  generateBatchEmbeddings(texts: string[], type: "query" | "passage"): Promise<number[][]>;
  getCacheStats(): { hits: number; misses: number; size: number; evictions: number };
  clearCache(): void;
}

// =====================================================
// Motion サービス初期化
// =====================================================

/**
 * Motion関連サービスを一括初期化
 *
 * 登録されるファクトリ:
 * - motionDetect (webPageService必要)
 * - motionSearch
 * - motionPersistence
 *
 * @param config サービス初期化設定
 * @returns 初期化結果
 */
export function initializeMotionServices(
  config: ServiceInitializerConfig
): ServiceInitializerResult {
  const registeredFactories: string[] = [];
  const skipped: string[] = [];

  // 必須依存関係チェック
  if (!config.prisma) {
    return {
      success: false,
      registeredFactories: [],
      categories: [],
      skipped: [],
      error: "Missing required dependency: prisma",
    };
  }

  if (!config.embeddingService) {
    return {
      success: false,
      registeredFactories: [],
      categories: [],
      skipped: [],
      error: "Missing required dependency: embeddingService",
    };
  }

  try {
    // 1. motion.detect ファクトリ（webPageService必要）
    if (config.webPageService) {
      setMotionDetectServiceFactory(() => ({
        getPageById: async (id: string): Promise<MotionWebPageResult | null> => {
          const result = await config.webPageService!.getPageById(id);
          if (!result) return null;
          // exactOptionalPropertyTypes対応: undefinedを明示的に設定しない
          const motionResult: MotionWebPageResult = {
            id: result.id,
            htmlContent: result.htmlContent ?? "",
          };
          return motionResult;
        },
      }));
      registeredFactories.push("motionDetect");
      logger.info("[ServiceInitializer] motionDetect factory registered");
    } else {
      skipped.push("motionDetect");
    }

    // 2. motion.search ファクトリ
    setMotionSearchEmbeddingServiceFactory(() => config.embeddingService);
    setMotionSearchPrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ["motionPattern", "motionEmbedding"],
          supportsTransaction: false,
        }) as unknown as IMotionSearchPrismaClient
    );
    setMotionSearchServiceFactory(createMotionSearchServiceFactory());
    // 嗜好リランキング用PrismaClientFactory登録（$queryRawUnsafeのみ使用）
    // Register PrismaClientFactory for preference reranking (uses $queryRawUnsafe only)
    setMotionSearchRerankPrismaClientFactory(
      () => config.prisma as unknown as IPreferencePrismaClient
    );
    registeredFactories.push("motionSearch");
    logger.info("[ServiceInitializer] motionSearch factory registered");

    // 3. motion.detect persistence ファクトリ
    setMotionPersistenceEmbeddingServiceFactory(() => config.embeddingService);
    setMotionPersistencePrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ["motionPattern", "motionEmbedding"],
          supportsTransaction: true,
        }) as unknown as IMotionPrismaClient
    );
    setMotionPersistenceServiceFactory(() => new MotionPatternPersistenceService());
    registeredFactories.push("motionPersistence");
    logger.info("[ServiceInitializer] motionPersistence factory registered");

    // 4. JS Animation Embedding ファクトリ
    // NOTE: config.embeddingService (@reftrixmcp/ml) は必要なメソッド全て持っているが、
    // 最小インターフェースで型定義されているため、キャストが必要
    setJSAnimationEmbeddingServiceFactory(
      () => config.embeddingService as unknown as IJSAnimationEmbeddingService
    );
    registeredFactories.push("jsAnimationEmbedding");
    logger.info("[ServiceInitializer] jsAnimationEmbedding factory registered");

    // 4.5. JS Animation Search ファクトリ（motion.search JS統合用）
    // PrismaClientのラッパーを使ってJSAnimationSearchServiceを初期化
    setJSAnimationSearchServiceFactory(() => {
      const jsSearchPrisma = createPrismaWrapper(config.prisma, {
        tables: ["jSAnimationPattern", "jSAnimationEmbedding"],
        supportsTransaction: false,
      });
      return new JSAnimationSearchService({
        prisma: jsSearchPrisma as unknown as IJSAnimationSearchPrismaClient,
      });
    });
    registeredFactories.push("jsAnimationSearch");
    logger.info("[ServiceInitializer] jsAnimationSearch factory registered");

    // 4.6. JS Animation Persistence Prisma ファクトリ（motion.detect JS保存用）
    setJSAnimationPersistencePrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ["jSAnimationPattern", "jSAnimationEmbedding"],
          supportsTransaction: true,
        }) as unknown as IJSAnimationPersistencePrismaClient
    );
    registeredFactories.push("jsAnimationPersistence");
    logger.info("[ServiceInitializer] jsAnimationPersistence factory registered");

    // 5. MotionDbService ファクトリ（Frame Image Analysis結果のDB保存用）
    setMotionDbEmbeddingServiceFactory(() => config.embeddingService);
    setMotionDbPrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ["motionAnalysisResult", "motionAnalysisEmbedding"],
          supportsTransaction: true,
        }) as unknown as IMotionDbPrismaClient
    );
    registeredFactories.push("motionDb");
    logger.info("[ServiceInitializer] motionDb factory registered");

    // 6. FrameEmbeddingService ファクトリ（フレーム解析結果のEmbedding保存用）
    // NOTE: frame-embedding.service は拡張インターフェースを要求するため、
    // Layout Embedding と同様にアダプタを作成
    const frameEmbeddingAdapter = {
      generateEmbedding: (text: string, type: "query" | "passage"): Promise<number[]> =>
        config.embeddingService.generateEmbedding(text, type),
      generateBatchEmbeddings: async (
        texts: string[],
        type: "query" | "passage"
      ): Promise<number[][]> => {
        const results: number[][] = [];
        for (const text of texts) {
          results.push(await config.embeddingService.generateEmbedding(text, type));
        }
        return results;
      },
      getCacheStats: (): { hits: number; misses: number; size: number; evictions: number } => ({
        hits: 0,
        misses: 0,
        size: 0,
        evictions: 0,
      }),
      clearCache: (): void => {},
    };
    setFrameEmbeddingServiceFactory(() => frameEmbeddingAdapter);
    setFramePrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ["motionPattern", "motionEmbedding"],
          supportsTransaction: true,
        }) as unknown as IFramePrismaClient
    );
    registeredFactories.push("frameEmbedding");
    logger.info("[ServiceInitializer] frameEmbedding factory registered");

    return {
      success: true,
      registeredFactories,
      categories: ["motion"],
      skipped,
    };
  } catch (error) {
    return {
      success: false,
      registeredFactories,
      categories: [],
      skipped,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// =====================================================
// Layout サービス初期化
// =====================================================

/**
 * Layout関連サービスを一括初期化
 *
 * 登録されるファクトリ:
 * - layoutSearch
 * - layoutToCode
 * - layoutInspect (webPageService必要)
 * - layoutIngest
 *
 * @param config サービス初期化設定
 * @returns 初期化結果
 */
export function initializeLayoutServices(
  config: ServiceInitializerConfig
): ServiceInitializerResult {
  const registeredFactories: string[] = [];
  const skipped: string[] = [];

  // 必須依存関係チェック
  if (!config.prisma) {
    return {
      success: false,
      registeredFactories: [],
      categories: [],
      skipped: [],
      error: "Missing required dependency: prisma",
    };
  }

  if (!config.embeddingService) {
    return {
      success: false,
      registeredFactories: [],
      categories: [],
      skipped: [],
      error: "Missing required dependency: embeddingService",
    };
  }

  try {
    // 1. layout.search ファクトリ（EmbeddingService + PrismaClient + Service）
    setLayoutSearchEmbeddingServiceFactory(() => config.embeddingService);
    setLayoutSearchPrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ["sectionPattern", "sectionEmbedding"],
          supportsTransaction: false,
        }) as unknown as ILayoutSearchPrismaClient
    );
    setLayoutSearchServiceFactory(createLayoutSearchServiceFactory());
    // 嗜好リランキング用PrismaClientFactory登録（$queryRawUnsafeのみ使用）
    // Register PrismaClientFactory for preference reranking (uses $queryRawUnsafe only)
    setLayoutSearchRerankPrismaClientFactory(
      () => config.prisma as unknown as IPreferencePrismaClient
    );
    registeredFactories.push("layoutSearch");
    logger.info(
      "[ServiceInitializer] layoutSearch factory registered (with EmbeddingService + PrismaClient)"
    );

    // 2. layout.to_code ファクトリ（PrismaClient + Service）
    setLayoutToCodePrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ["sectionPattern", "webPage"],
          supportsTransaction: false,
        }) as unknown as ILayoutToCodePrismaClient
    );
    setLayoutToCodeServiceFactory(createLayoutToCodeServiceFactory());
    registeredFactories.push("layoutToCode");
    logger.info("[ServiceInitializer] layoutToCode factory registered (with PrismaClient)");

    // 3. layout.inspect ファクトリ（webPageServiceなしでも基本機能は使用可能）
    // LlamaVisionAdapter をインスタンス化（遅延初期化）
    let visionAdapterInstance: IVisionAnalyzer | null = null;
    const getOrCreateVisionAdapter = (): IVisionAnalyzer => {
      if (!visionAdapterInstance) {
        visionAdapterInstance = new LlamaVisionAdapter();
        if (isDevelopmentEnvironment()) {
          logger.debug("[ServiceInitializer] LlamaVisionAdapter created lazily");
        }
      }
      return visionAdapterInstance;
    };

    // exactOptionalPropertyTypes対応: サービスオブジェクトを条件付きで構築
    setLayoutInspectServiceFactory(() => {
      // 基本サービスオブジェクト
      const service: {
        getWebPageById?: (id: string) => Promise<LayoutWebPageResult | null>;
        analyzeScreenshot: (screenshot: ScreenshotInput) => Promise<VisionAnalysisResult>;
        getVisionAnalyzer: () => IVisionAnalyzer | null;
      } = {
        // スクリーンショット解析（LlamaVision使用）
        analyzeScreenshot: async (screenshot: ScreenshotInput): Promise<VisionAnalysisResult> => {
          const adapter = getOrCreateVisionAdapter();

          // 利用可能性チェック
          const isAvailable = await adapter.isAvailable();
          if (!isAvailable) {
            return {
              success: false,
              features: [],
              error:
                "LlamaVision (Ollama) is not available. Please ensure Ollama is running with llama3.2-vision model.",
              processingTimeMs: 0,
              modelName: adapter.modelName,
            };
          }

          // base64をBufferに変換
          const imageBuffer = Buffer.from(screenshot.base64, "base64");

          // Vision解析実行
          const result = await adapter.analyze({
            imageBuffer,
            mimeType: screenshot.mimeType,
            features: [
              "layout_structure",
              "color_palette",
              "typography",
              "visual_hierarchy",
              "whitespace",
              "section_boundaries",
            ],
          });

          return result;
        },

        // VisionAnalyzerインスタンス取得
        getVisionAnalyzer: (): IVisionAnalyzer | null => {
          return getOrCreateVisionAdapter();
        },
      };

      // WebPage取得（webPageService依存）- 利用可能な場合のみプロパティを追加
      if (config.webPageService) {
        service.getWebPageById = async (id: string): Promise<LayoutWebPageResult | null> => {
          const result = await config.webPageService!.getPageById(id);
          if (!result) return null;
          return {
            id: result.id,
            htmlContent: result.htmlContent ?? "",
          };
        };
      }

      return service;
    });
    registeredFactories.push("layoutInspect");
    logger.info("[ServiceInitializer] layoutInspect factory registered (with LlamaVision support)");

    // 4. layout.ingest ファクトリ
    // Layout Embedding Serviceは拡張インターフェースを要求するため、アダプタを作成
    const layoutEmbeddingAdapter: ILayoutEmbeddingService = {
      generateEmbedding: (text: string, type: "query" | "passage") =>
        config.embeddingService.generateEmbedding(text, type),
      generateBatchEmbeddings: async (texts: string[], type: "query" | "passage") => {
        // 順次処理でバッチをエミュレート
        const results: number[][] = [];
        for (const text of texts) {
          results.push(await config.embeddingService.generateEmbedding(text, type));
        }
        return results;
      },
      getCacheStats: () => ({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: () => {},
    };
    setLayoutEmbeddingServiceFactory(() => layoutEmbeddingAdapter);
    setLayoutPrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ["sectionPattern", "sectionEmbedding"],
          supportsTransaction: false,
        }) as unknown as ILayoutPrismaClient
    );
    setLayoutIngestServiceFactory(() => ({
      analyzeHtml: async (html: string): Promise<LayoutInspectData> => {
        const sections = detectSections(html);
        const typography = analyzeTypography(html);
        const grid = detectGrid(html);
        const colors = extractColors(html);
        return {
          sections,
          typography,
          grid,
          colors,
          textRepresentation: sections
            .map((s) => `${s.type}: ${s.content.headings.map((h) => h.text).join(", ")}`)
            .join("; "),
        };
      },
      saveSectionWithEmbedding: async (
        section: SectionInfo,
        webPageId: string,
        embedding: number[],
        options?: SaveSectionOptions,
        textRepresentation?: string
      ): Promise<string> => {
        return saveSectionWithEmbedding(section, webPageId, embedding, options, textRepresentation);
      },
      generateEmbedding: async (text: string): Promise<number[]> => {
        const result = await config.embeddingService.generateEmbedding(text, "passage");
        return result;
      },
    }));
    registeredFactories.push("layoutIngest");
    logger.info("[ServiceInitializer] layoutIngest factory registered");

    return {
      success: true,
      registeredFactories,
      categories: ["layout"],
      skipped,
    };
  } catch (error) {
    return {
      success: false,
      registeredFactories,
      categories: [],
      skipped,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// =====================================================
// Quality サービス初期化
// =====================================================

/**
 * Quality関連サービスを一括初期化
 *
 * 登録されるファクトリ:
 * - qualityEvaluate
 * - benchmarkService
 *
 * @param config サービス初期化設定
 * @returns 初期化結果
 */
export function initializeQualityServices(
  config: ServiceInitializerConfig
): ServiceInitializerResult {
  const registeredFactories: string[] = [];
  const skipped: string[] = [];

  // 必須依存関係チェック
  if (!config.prisma) {
    return {
      success: false,
      registeredFactories: [],
      categories: [],
      skipped: [],
      error: "Missing required dependency: prisma",
    };
  }

  if (!config.embeddingService) {
    return {
      success: false,
      registeredFactories: [],
      categories: [],
      skipped: [],
      error: "Missing required dependency: embeddingService",
    };
  }

  try {
    // 1. BenchmarkService ファクトリ
    // PrismaClientをそのまま渡す（BenchmarkServiceは$queryRawUnsafeを使用）
    setBenchmarkServiceFactory(() => {
      // IPrismaClientMinimal は BenchmarkService が要求する PrismaClient のスーパーセット。
      // 構造的互換性があるため unknown 経由でキャストする。
      return new BenchmarkService(config.prisma as unknown as PrismaClient);
    });
    registeredFactories.push("benchmarkService");
    logger.info("[ServiceInitializer] benchmarkService factory registered");

    // 2. QualityEvaluateService ファクトリ
    // TDA-HS-R1 / M-2: QualitySearchService を独立ファイルに抽出
    setQualityEvaluateServiceFactory(() =>
      createQualitySearchService({
        prisma: config.prisma,
        embeddingService: config.embeddingService,
        webPageService: config.webPageService,
      })
    );
    registeredFactories.push("qualityEvaluate");
    logger.info("[ServiceInitializer] qualityEvaluate factory registered");

    // 3. PatternMatcherService ファクトリ（パターン駆動評価用）
    // PrismaClientファクトリを先に設定
    setPatternMatcherPrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: [
            "sectionPattern",
            "sectionEmbedding",
            "motionPattern",
            "motionEmbedding",
            "webPage",
          ],
          supportsTransaction: false,
        }) as unknown as IPatternMatcherPrismaClient
    );
    // PatternMatcherServiceファクトリを設定
    setPatternMatcherServiceFactory(createPatternMatcherServiceFactory());
    registeredFactories.push("patternMatcher");
    logger.info("[ServiceInitializer] patternMatcher factory registered");

    return {
      success: true,
      registeredFactories,
      categories: ["quality"],
      skipped,
    };
  } catch (error) {
    return {
      success: false,
      registeredFactories,
      categories: [],
      skipped,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
