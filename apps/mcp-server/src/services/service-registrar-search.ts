// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Service Registrar - Search & Auxiliary
 *
 * Narrative, Background, Responsive, Preference, DesignSearch,
 * EmbeddingBackfill, Page ドメインのDIファクトリ登録。
 * service-initializer.ts から分離。
 *
 * Search & auxiliary domain DI factory registration.
 * Extracted from service-initializer.ts.
 *
 * @module services/service-registrar-search
 */

import path from "path";

import { logger } from "../utils/logger";
import { createPrismaWrapper } from "../utils/prisma-wrapper-factory";

import type {
  ServiceInitializerConfig,
  SkippedCategoryInfo,
  InitializationErrorInfo,
} from "./service-initializer";

// Page関連インポート
// 循環依存解消: tools/page/index.ts ではなく個別ファイルからインポート
import {
  setPageAnalyzePrismaClientFactory,
  type IPageAnalyzePrismaClient,
} from "../tools/page/analyze.tool";

// Narrative関連インポート
import {
  setNarrativeSearchServiceFactory,
  setNarrativeSearchPrismaClientFactory as setNarrativeSearchRerankPrismaClientFactory,
} from "../tools/narrative/search.tool";
import {
  createNarrativeSearchService,
  setNarrativePrismaClientFactory,
  setNarrativeEmbeddingServiceFactory,
  type INarrativePrismaClient,
  type INarrativeAnalysisService,
  type NarrativeSearchOptions,
  type NarrativeSearchResult,
} from "./narrative";

// Background関連インポート
import {
  setBackgroundSearchServiceFactory,
  setBackgroundSearchPrismaClientFactory as setBackgroundSearchRerankPrismaClientFactory,
} from "../tools/background/search.tool";
import { createBackgroundSearchService } from "./background-search.service";
import {
  setBackgroundPrismaClientFactory,
  setBackgroundEmbeddingServiceFactory,
  type IBackgroundPrismaClient,
} from "./background/background-design-embedding.service";

// Responsive関連インポート
import {
  setResponsiveSearchServiceFactory,
  setResponsiveSearchPrismaClientFactory as setResponsiveSearchRerankPrismaClientFactory,
} from "../tools/responsive/search.tool";
import { createResponsiveSearchService } from "./responsive-search.service";

// Preference関連インポート
import {
  setPreferenceHearServiceFactory,
  setPreferenceGetServiceFactory,
  setPreferenceResetServiceFactory,
} from "../tools/preference";
import {
  createPreferenceProfileServiceFactory,
  setPreferencePrismaClientFactory,
  setPreferenceEmbeddingServiceFactory,
  type IPrismaClient as IPreferencePrismaClient,
} from "./preference-profile.service";

// Design Search関連インポート（design.search_by_image用）
import {
  setDesignSearchDINOv2ServiceFactory,
  setDesignSearchEmbeddingServiceFactory,
  setDesignSearchPrismaClientFactory,
  type IDesignSearchDINOv2Service,
  type IDesignSearchPrismaClient,
} from "../tools/design/search-by-image.tool";

// Embedding Handler関連インポート（backfill DI用）
import { setMotionLayoutEmbeddingServiceFactory } from "../tools/page/handlers/embedding-handler";

// =====================================================
// 検索・補助サービス初期化結果
// =====================================================

/**
 * 検索・補助サービス初期化の内部結果
 * initializeAllServices() のオーケストレータで使用される
 */
export interface SearchRegistrarResult {
  registeredFactories: string[];
  categories: string[];
  skipped: string[];
  errors: string[];
  skippedCategoriesInfo: SkippedCategoryInfo[];
  errorsInfo: InitializationErrorInfo[];
}

// =====================================================
// 検索・補助サービス一括初期化
// =====================================================

/**
 * Page, Narrative, Background, Responsive, Preference,
 * DesignSearch, EmbeddingBackfill の全サービスを初期化する。
 *
 * initializeAllServices() から呼び出される。
 *
 * @param config サービス初期化設定
 * @returns 登録結果
 */
export function initializeSearchAndAuxiliaryServices(
  config: ServiceInitializerConfig
): SearchRegistrarResult {
  const result: SearchRegistrarResult = {
    registeredFactories: [],
    categories: [],
    skipped: [],
    errors: [],
    skippedCategoriesInfo: [],
    errorsInfo: [],
  };

  // Page サービス初期化（page.analyze用のPrismaClient）
  initializePageService(config, result);

  // Narrative サービス初期化
  initializeNarrativeService(config, result);

  // Background サービス初期化
  initializeBackgroundService(config, result);

  // Responsive サービス初期化
  initializeResponsiveService(config, result);

  // Preference サービス初期化
  initializePreferenceService(config, result);

  // Design Search サービス初期化
  initializeDesignSearchService(config, result);

  // Embedding Backfill DI ファクトリ初期化
  initializeEmbeddingBackfillFactories(config, result);

  return result;
}

// =====================================================
// 個別サービス初期化関数
// =====================================================

function initializePageService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  try {
    setPageAnalyzePrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: [
            "webPage",
            "sectionPattern",
            "motionPattern",
            "qualityEvaluation",
            "qualityBenchmark",
            "jSAnimationPattern",
            "jSAnimationEmbedding",
          ],
          supportsTransaction: true,
        }) as unknown as IPageAnalyzePrismaClient
    );
    result.registeredFactories.push("setPageAnalyzePrismaClientFactory");
    result.categories.push("page");
    logger.debug("[ServiceInitializer] page.analyze PrismaClient factory registered");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    result.errors.push(`Page: ${errorMessage}`);
    result.errorsInfo.push({ category: "Page", error: errorMessage });
    result.skipped.push("pageAnalyzePrismaClient");
    result.skippedCategoriesInfo.push({
      category: "Page.pageAnalyzePrismaClient",
      reason: errorMessage,
    });
  }
}

function initializeNarrativeService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  try {
    // 新版 NarrativeSearchService の DI factories を登録
    // New NarrativeSearchService DI factory registration
    setNarrativePrismaClientFactory(() => config.prisma as unknown as INarrativePrismaClient);
    setNarrativeEmbeddingServiceFactory(() => config.embeddingService);
    const narrativeSearchInstance = createNarrativeSearchService();
    setNarrativeSearchServiceFactory(
      (): INarrativeAnalysisService => ({
        analyze: async (): Promise<never> => {
          throw new Error(
            "NarrativeAnalysisService.analyze() is not available via DI search factory. Use narrative.analyze tool directly."
          );
        },
        save: async (): Promise<never> => {
          throw new Error(
            "NarrativeAnalysisService.save() is not available via DI search factory."
          );
        },
        analyzeAndSave: async (): Promise<never> => {
          throw new Error(
            "NarrativeAnalysisService.analyzeAndSave() is not available via DI search factory."
          );
        },
        search: (opts: NarrativeSearchOptions): Promise<NarrativeSearchResult[]> =>
          narrativeSearchInstance.search(opts),
        searchHybrid: (opts: NarrativeSearchOptions): Promise<NarrativeSearchResult[]> =>
          narrativeSearchInstance.searchHybrid(opts),
      })
    );
    // 嗜好リランキング用PrismaClientFactory登録（$queryRawUnsafeのみ使用）
    // Register PrismaClientFactory for preference reranking (uses $queryRawUnsafe only)
    setNarrativeSearchRerankPrismaClientFactory(
      () => config.prisma as unknown as IPreferencePrismaClient
    );
    result.registeredFactories.push("narrativeSearch");
    result.categories.push("narrative");
    logger.info("[ServiceInitializer] narrativeSearch factory registered");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    result.errors.push(`Narrative: ${errorMessage}`);
    result.errorsInfo.push({ category: "Narrative", error: errorMessage });
    result.skipped.push("narrativeSearch");
    result.skippedCategoriesInfo.push({
      category: "Narrative.narrativeSearch",
      reason: errorMessage,
    });
  }
}

function initializeBackgroundService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  try {
    setBackgroundSearchServiceFactory(() =>
      createBackgroundSearchService({
        prisma: config.prisma,
        embeddingService: config.embeddingService,
      })
    );
    // 嗜好リランキング用PrismaClientFactory登録（$queryRawUnsafeのみ使用）
    // Register PrismaClientFactory for preference reranking (uses $queryRawUnsafe only)
    setBackgroundSearchRerankPrismaClientFactory(
      () => config.prisma as unknown as IPreferencePrismaClient
    );
    result.registeredFactories.push("backgroundSearch");
    result.categories.push("background");
    logger.info("[ServiceInitializer] backgroundSearch factory registered");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    result.errors.push(`Background: ${errorMessage}`);
    result.errorsInfo.push({ category: "Background", error: errorMessage });
    result.skipped.push("backgroundSearch");
    result.skippedCategoriesInfo.push({
      category: "Background.backgroundSearch",
      reason: errorMessage,
    });
  }
}

function initializeResponsiveService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  try {
    setResponsiveSearchServiceFactory(() =>
      createResponsiveSearchService({
        prisma: config.prisma,
        embeddingService: config.embeddingService,
      })
    );
    // 嗜好リランキング用PrismaClientFactory登録（$queryRawUnsafeのみ使用）
    // Register PrismaClientFactory for preference reranking (uses $queryRawUnsafe only)
    setResponsiveSearchRerankPrismaClientFactory(
      () => config.prisma as unknown as IPreferencePrismaClient
    );
    result.registeredFactories.push("responsiveSearch");
    result.categories.push("responsive");
    logger.info("[ServiceInitializer] responsiveSearch factory registered");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    result.errors.push(`Responsive: ${errorMessage}`);
    result.errorsInfo.push({ category: "Responsive", error: errorMessage });
    result.skipped.push("responsiveSearch");
    result.skippedCategoriesInfo.push({
      category: "Responsive.responsiveSearch",
      reason: errorMessage,
    });
  }
}

function initializePreferenceService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  try {
    // PrismaClient と EmbeddingService の DI ファクトリを先に登録
    setPreferencePrismaClientFactory(() => config.prisma as unknown as IPreferencePrismaClient);
    setPreferenceEmbeddingServiceFactory(() => config.embeddingService);

    const preferenceFactory = createPreferenceProfileServiceFactory();
    setPreferenceHearServiceFactory(preferenceFactory);
    setPreferenceGetServiceFactory(preferenceFactory);
    setPreferenceResetServiceFactory(preferenceFactory);
    result.registeredFactories.push("preferenceHear", "preferenceGet", "preferenceReset");
    result.categories.push("preference");
    logger.info("[ServiceInitializer] preference factories registered (hear, get, reset)");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    result.errors.push(`Preference: ${errorMessage}`);
    result.errorsInfo.push({ category: "Preference", error: errorMessage });
    result.skipped.push("preferenceHear", "preferenceGet", "preferenceReset");
    result.skippedCategoriesInfo.push({
      category: "Preference.preference",
      reason: errorMessage,
    });
  }
}

function initializeDesignSearchService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  // DINOv2はオンデマンドロード（~800MB）のためファクトリパターンで遅延初期化
  try {
    // 1. DINOv2Service ファクトリ（lazy initialization）
    // 呼び出し時に初めてインスタンス生成→initialize()→使用→dispose()
    setDesignSearchDINOv2ServiceFactory(() => {
      // DINOv2 モデルパスを解決（環境変数優先、フォールバック: @reftrixmcp/ml内蔵モデル）
      let dinov2ModelPath: string;
      if (process.env["DINOV2_MODEL_PATH"]) {
        dinov2ModelPath = process.env["DINOV2_MODEL_PATH"];
      } else {
        const mlMainPath = require.resolve("@reftrixmcp/ml");
        const mlRoot = path.resolve(path.dirname(mlMainPath), "..");
        dinov2ModelPath = path.join(mlRoot, "models", "dinov2-base", "model.onnx");
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for DINOv2Service to avoid top-level import of heavy ~800MB model
      const { DINOv2Service } = require("@reftrixmcp/ml") as {
        DINOv2Service: new (config: { modelPath: string }) => IDesignSearchDINOv2Service;
      };
      return new DINOv2Service({ modelPath: dinov2ModelPath });
    });

    // 2. EmbeddingService ファクトリ（e5-base、config.embeddingService を使用）
    setDesignSearchEmbeddingServiceFactory(() => config.embeddingService);

    // 3. PrismaClient ファクトリ（$queryRawUnsafe のみ使用）
    setDesignSearchPrismaClientFactory(() => config.prisma as unknown as IDesignSearchPrismaClient);

    result.registeredFactories.push(
      "designSearchDINOv2",
      "designSearchEmbedding",
      "designSearchPrisma"
    );
    result.categories.push("designSearch");
    logger.info(
      "[ServiceInitializer] designSearch factories registered (DINOv2, embedding, prisma)"
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    result.errors.push(`DesignSearch: ${errorMessage}`);
    result.errorsInfo.push({ category: "DesignSearch", error: errorMessage });
    result.skipped.push("designSearchDINOv2", "designSearchEmbedding", "designSearchPrisma");
    result.skippedCategoriesInfo.push({
      category: "DesignSearch.designSearch",
      reason: errorMessage,
    });
  }
}

function initializeEmbeddingBackfillFactories(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  // Embedding Backfill DI ファクトリ初期化
  // Post-Embedding Backfill（page-analyze-worker）が background/motion embedding を
  // 生成するために必要な DI factory を登録する
  try {
    // 1. BackgroundDesign Embedding 用 PrismaClient
    setBackgroundPrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ["backgroundDesignEmbedding"],
          supportsTransaction: false,
        }) as unknown as IBackgroundPrismaClient
    );
    result.registeredFactories.push("backgroundPrismaClient");

    // 2. BackgroundDesign Embedding 用 EmbeddingService
    // IBackgroundEmbeddingService は generateFromText(text) を要求
    setBackgroundEmbeddingServiceFactory(() => ({
      generateFromText: async (
        text: string
      ): Promise<{
        embedding: number[];
        modelName: string;
        textUsed: string;
        processingTimeMs: number;
      }> => {
        const start = Date.now();
        const embedding = await config.embeddingService.generateEmbedding(text, "passage");
        return {
          embedding,
          modelName: "multilingual-e5-base",
          textUsed: text,
          processingTimeMs: Date.now() - start,
        };
      },
    }));
    result.registeredFactories.push("backgroundEmbeddingService");

    // 3. Motion Embedding 用 LayoutEmbeddingService（embedding-handler DI）
    // ILayoutEmbeddingServiceForMotion は generateFromText(text) を要求
    setMotionLayoutEmbeddingServiceFactory(() => ({
      generateFromText: async (
        text: string
      ): Promise<{
        embedding: number[];
        modelName: string;
      }> => {
        const embedding = await config.embeddingService.generateEmbedding(text, "passage");
        return {
          embedding,
          modelName: "multilingual-e5-base",
        };
      },
    }));
    result.registeredFactories.push("motionLayoutEmbeddingService");

    logger.info(
      "[ServiceInitializer] Embedding backfill DI factories registered (background + motion)"
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    result.errors.push(`EmbeddingBackfill: ${errorMessage}`);
    result.errorsInfo.push({ category: "EmbeddingBackfill", error: errorMessage });
    logger.warn(
      `[ServiceInitializer] Failed to register embedding backfill DI factories: ${errorMessage}`
    );
  }
}
