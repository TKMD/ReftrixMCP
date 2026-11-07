// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Service Registrar - Search & Auxiliary
 *
 * Narrative, Background, Responsive, DesignSearch,
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
import { sanitizeErrorMessage } from "../utils/sanitize-error";

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

import type { IPrismaClient as IPreferencePrismaClient } from "./preference-rerank.helper";

// Design Search関連インポート（design.search_by_image用）
import {
  setDesignSearchDINOv2ResidentFactory,
  setDesignSearchDINOv2ServiceFactory,
  setDesignSearchEmbeddingServiceFactory,
  setDesignSearchPrismaClientFactory,
  type IDesignSearchDINOv2Service,
  type IDesignSearchPrismaClient,
} from "../tools/design/search-by-image.tool";
import { DINOV2_INPUT_SIZE } from "@reftrixmcp/ml/dinov2";
import {
  preprocessSectionContainForDinov2,
  preprocessSectionForDinov2,
} from "../utils/dinov2-section-preprocess";
import { setDesignVerifyReproductionDepsFactory } from "../tools/design/verify-reproduction.tool";
import {
  createDefaultDeps as createVerifyDefaultDeps,
  type VerifyPrisma,
} from "./design/reproduction-verify.service";
import { createResidentDinov2, type ResidentDinov2 } from "./design/resident-dinov2";

// Similar Site関連インポート（design.similar_site用）
import {
  setSimilarSitePrismaClientFactory,
  setSimilarSiteEmbeddingServiceFactory,
  type SimilarSitePrismaClient,
} from "./similar-site.service";

// Part Search関連インポート（part.search用）
import {
  setPartSearchPrismaClientFactory,
  setPartSearchEmbeddingServiceFactory,
  type PartSearchPrismaClient,
} from "./part/part-search.service";

// Part Inspect関連インポート（part.inspect用）
import { setPartInspectPrismaClientFactory } from "../tools/part/inspect.tool";
import type { PartInspectPrismaClient } from "../tools/part/inspect.tool";

// Design Compare関連インポート（design.compare用）
import {
  setDesignComparePrismaClientFactory,
  type DesignComparePrismaClient,
} from "./design-compare.service";

// Embedding Handler関連インポート（backfill DI用）
import { setMotionLayoutEmbeddingServiceFactory } from "../tools/page/handlers/embedding-handler";

// Design Change Tracker関連インポート（page.analyze auto_snapshot用）
import {
  setDesignChangeTrackerPrismaClientFactory,
  type DesignChangeTrackerPrismaClient,
} from "./design-change-tracker.service";

// Audit Log関連インポート（audit.query用、v0.3.0 T2-AUD）
import {
  setAuditLogPrismaClientFactory,
  type AuditLogPrismaClient,
  getAuditLogService,
} from "./audit-log.service";
import { setAuditQueryServiceFactory } from "../tools/audit/query.tool";

// GDPR Deletion関連インポート（data.delete / data.export用、v0.3.0 T2-GDPR）
import {
  setGdprPrismaClientFactory,
  setGdprScreenshotPersistenceFactory,
  getGdprDeletionService,
  type GdprPrismaClient,
} from "./gdpr-deletion.service";
import {
  setDataDeleteServiceFactory,
  setDataExportServiceFactory,
  setDataDeleteBackfillQueueFactory,
} from "../tools/data/data.tool";
import { createEmbeddingBackfillQueue } from "../queues/embedding-backfill-queue";
import type { Queue } from "bullmq";
import type {
  EmbeddingBackfillJobData,
  EmbeddingBackfillJobResult,
} from "../queues/embedding-backfill-queue";

// Screenshot 永続化サービス（GDPR Art. 17 削除経路用、v0.4.0 PR1）
// Screenshot persistence service (for GDPR Art. 17 deletion path, v0.4.0 PR1)
import {
  createScreenshotPersistenceService,
  type IScreenshotPersistencePrismaClient,
} from "./screenshot-persistence.service";

// Accessibility Audit関連インポート（accessibility.audit用、v0.3.0 T2-WCAG）
import { createAccessibilityAuditService } from "./quality/accessibility-audit.service";
import { createContrastCheckService } from "./quality/contrast-check.service";
import {
  setAccessibilityAuditServiceFactory,
  setContrastCheckServiceFactory,
} from "../tools/accessibility/audit.tool";

// Responsive Capture関連インポート（responsive.capture用、v0.3.0 T2-10）
import { MultiDeviceCaptureService } from "./responsive/multi-device-capture.service";
import { ResponsiveDiffService } from "./responsive/responsive-diff.service";
import { setResponsiveCaptureServiceFactory } from "../tools/responsive/capture.tool";

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
// 初期化エラー記録ヘルパー / Initialization error recording helper
// =====================================================

/**
 * DI登録失敗時のエラー情報を result に記録するヘルパー
 * Records DI registration failure info into result
 *
 * @param result - 初期化結果オブジェクト / Initialization result object
 * @param category - サービスカテゴリ名 / Service category name
 * @param skippedFactories - スキップされたファクトリ名 / Skipped factory names
 * @param error - 発生したエラー / Error that occurred
 */
function recordInitError(
  result: SearchRegistrarResult,
  category: string,
  skippedFactories: string[],
  error: unknown
): void {
  // PR-D-7 Wave 3 / FIND-PLAN-TPA-01 H binding:
  //   Client-facing `result.errors[]` routes through `sanitizeErrorMessage`
  //   (CWE-209 defense). The string[] shape is preserved (additive-only;
  //   no type rename per PR-D-7 breaking-change prohibition).
  //   `errorsInfo` / `skippedCategoriesInfo` keep the pre-existing raw message
  //   (out of scope for Wave 3; tracked for a future sanitize pass).
  //
  // PR-D-7 Wave 3 / FIND-PLAN-TPA-01 H 対応:
  //   client 向け `result.errors[]` は `sanitizeErrorMessage` 経由 (CWE-209 対策)。
  //   string[] 型は破壊変更禁止のため保持 (additive-only)。
  //   `errorsInfo` / `skippedCategoriesInfo` は Wave 3 scope 外のため従来挙動を維持。
  const rawErrorMessage = error instanceof Error ? error.message : "Unknown error";
  const safeMessage = sanitizeErrorMessage(error);
  result.errors.push(`${category}: ${safeMessage}`);
  result.errorsInfo.push({ category, error: rawErrorMessage });
  result.skipped.push(...skippedFactories);
  result.skippedCategoriesInfo.push({
    category: `${category}.${category.charAt(0).toLowerCase() + category.slice(1)}`,
    reason: rawErrorMessage,
  });
}

// =====================================================
// 検索・補助サービス一括初期化
// =====================================================

/**
 * Page, Narrative, Background, Responsive,
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

  // Design Search サービス初期化
  initializeDesignSearchService(config, result);

  // Similar Site サービス初期化
  initializeSimilarSiteService(config, result);

  // Design Compare サービス初期化
  initializeDesignCompareService(config, result);
  initializeDesignVerifyReproductionService(config, result);

  // Part Search サービス初期化
  initializePartSearchService(config, result);

  // Part Inspect サービス初期化
  initializePartInspectService(config, result);

  // Embedding Backfill DI ファクトリ初期化
  initializeEmbeddingBackfillFactories(config, result);

  // Design Change Tracker サービス初期化
  initializeDesignChangeTrackerService(config, result);

  // Audit Log サービス初期化（v0.3.0 T2-AUD）
  initializeAuditLogService(config, result);

  // GDPR Deletion サービス初期化（v0.3.0 T2-GDPR）
  initializeGdprDeletionService(config, result);

  // Accessibility Audit サービス初期化（v0.3.0 T2-WCAG）
  initializeAccessibilityAuditService(result);

  // Responsive Capture サービス初期化（v0.3.0 T2-10）
  initializeResponsiveCaptureService(result);

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
    recordInitError(result, "Page", ["pageAnalyzePrismaClient"], error);
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
    recordInitError(result, "Narrative", ["narrativeSearch"], error);
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
    recordInitError(result, "Background", ["backgroundSearch"], error);
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
    recordInitError(result, "Responsive", ["responsiveSearch"], error);
  }
}

/**
 * DINOv2 インスタンスを生成する（lazy、呼び出し時にモデルパスを解決）。
 * design.search_by_image / design.verify_reproduction が共有する。
 * Creates a DINOv2 instance lazily (shared by design.search_by_image and design.verify_reproduction).
 */
function createDesignDinov2Instance(): IDesignSearchDINOv2Service {
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
}

/**
 * One resident DINOv2 instance for the process (idle dispose), shared by design.verify_reproduction
 * and design.search_by_image so only one copy of the model is ever resident (VR-M-02 / VR-M-04).
 */
let sharedResidentDinov2: ResidentDinov2 | null = null;
function getSharedResidentDinov2(): ResidentDinov2 {
  sharedResidentDinov2 ??= createResidentDinov2(createDesignDinov2Instance);
  return sharedResidentDinov2;
}

function initializeDesignVerifyReproductionService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  try {
    const verifyBlankEmbeddingCache = new Map<string, number[]>();
    const residentDinov2 = getSharedResidentDinov2();
    setDesignVerifyReproductionDepsFactory(() =>
      createVerifyDefaultDeps(
        config.prisma as unknown as VerifyPrisma,
        () => residentDinov2.get(),
        // Same preprocessing as the stored section embeddings (Phase 5), not the search-by-image one.
        (png: Buffer) => preprocessSectionForDinov2(png, DINOV2_INPUT_SIZE),
        {
          releaseDinov2: (dino, broken) => residentDinov2.release(dino, broken),
          // Whole-image preprocessing when the screenshot crop is available (both sides fresh).
          preprocessContainForDinov2: (png: Buffer) =>
            preprocessSectionContainForDinov2(png, DINOV2_INPUT_SIZE),
          // The deps object is rebuilt per call: the blank baseline cache lives here.
          blankEmbeddingCache: verifyBlankEmbeddingCache,
        }
      )
    );
    result.registeredFactories.push("designVerifyReproductionDeps");
    result.categories.push("designVerifyReproduction");
    logger.info("[ServiceInitializer] designVerifyReproduction factory registered (deps)");
  } catch (error) {
    recordInitError(result, "DesignVerifyReproduction", ["designVerifyReproductionDeps"], error);
  }
}

function initializeDesignSearchService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  // DINOv2はオンデマンドロード（~800MB）のためファクトリパターンで遅延初期化
  try {
    // 1. DINOv2Service ファクトリ（lazy initialization）
    // フォールバック: 呼び出しごとにインスタンス生成→initialize()→使用（dispose されない。常駐インスタンス未設定時のみ）
    // Fallback only (no resident instance): creates and initializes a new instance per call, never disposed
    setDesignSearchDINOv2ServiceFactory(createDesignDinov2Instance);
    // 常駐インスタンス（verify_reproduction と共有）が優先される / the shared resident instance takes precedence
    setDesignSearchDINOv2ResidentFactory(getSharedResidentDinov2);

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
    recordInitError(
      result,
      "DesignSearch",
      ["designSearchDINOv2", "designSearchEmbedding", "designSearchPrisma"],
      error
    );
  }
}

function initializeSimilarSiteService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  try {
    // PrismaClient ファクトリ（$queryRawUnsafe のみ使用）
    setSimilarSitePrismaClientFactory(
      () =>
        ({
          $queryRawUnsafe: config.prisma.$queryRawUnsafe.bind(config.prisma),
        }) as SimilarSitePrismaClient
    );
    // EmbeddingService ファクトリ（テキストembedding生成用）
    setSimilarSiteEmbeddingServiceFactory(() => config.embeddingService);

    result.registeredFactories.push("similarSitePrisma", "similarSiteEmbedding");
    result.categories.push("similarSite");
    logger.info("[ServiceInitializer] similarSite factories registered (prisma, embedding)");
  } catch (error) {
    recordInitError(result, "SimilarSite", ["similarSitePrisma", "similarSiteEmbedding"], error);
  }
}

function initializeDesignCompareService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  try {
    // PrismaClient ファクトリ（$queryRawUnsafe のみ使用）
    setDesignComparePrismaClientFactory(
      () =>
        ({
          $queryRawUnsafe: config.prisma.$queryRawUnsafe.bind(config.prisma),
        }) as DesignComparePrismaClient
    );

    result.registeredFactories.push("designComparePrisma");
    result.categories.push("designCompare");
    logger.info("[ServiceInitializer] designCompare factory registered (prisma)");
  } catch (error) {
    recordInitError(result, "DesignCompare", ["designComparePrisma"], error);
  }
}

function initializePartSearchService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  try {
    // PrismaClient ファクトリ（$queryRawUnsafe のみ使用）
    setPartSearchPrismaClientFactory(
      () =>
        ({
          $queryRawUnsafe: config.prisma.$queryRawUnsafe.bind(config.prisma),
        }) as PartSearchPrismaClient
    );
    // EmbeddingService ファクトリ（テキストembedding生成用）
    setPartSearchEmbeddingServiceFactory(() => config.embeddingService);

    result.registeredFactories.push("partSearchPrisma", "partSearchEmbedding");
    result.categories.push("partSearch");
    logger.info("[ServiceInitializer] partSearch factories registered (prisma, embedding)");
  } catch (error) {
    recordInitError(result, "PartSearch", ["partSearchPrisma", "partSearchEmbedding"], error);
  }
}

function initializePartInspectService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  try {
    // PrismaClient ファクトリ（$queryRawUnsafe のみ使用）
    setPartInspectPrismaClientFactory(
      () =>
        ({
          $queryRawUnsafe: config.prisma.$queryRawUnsafe.bind(config.prisma),
        }) as PartInspectPrismaClient
    );

    result.registeredFactories.push("partInspectPrisma");
    result.categories.push("partInspect");
    logger.info("[ServiceInitializer] partInspect factory registered (prisma)");
  } catch (error) {
    recordInitError(result, "PartInspect", ["partInspectPrisma"], error);
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
    logger.warn(
      `[ServiceInitializer] Failed to register embedding backfill DI factories: ${errorMessage}`
    );
    recordInitError(result, "EmbeddingBackfill", [], error);
  }
}

function initializeDesignChangeTrackerService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  try {
    setDesignChangeTrackerPrismaClientFactory(
      () =>
        ({
          $queryRawUnsafe: config.prisma.$queryRawUnsafe.bind(config.prisma),
          $executeRawUnsafe: config.prisma.$executeRawUnsafe.bind(config.prisma),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPrismaClientMinimal.$transaction is optional but DesignChangeTracker requires it
          $transaction: config.prisma.$transaction!.bind(config.prisma) as any,
        }) as unknown as DesignChangeTrackerPrismaClient
    );

    result.registeredFactories.push("designChangeTrackerPrisma");
    result.categories.push("designChangeTracker");
    logger.info("[ServiceInitializer] designChangeTracker factory registered (prisma)");
  } catch (error) {
    recordInitError(result, "DesignChangeTracker", ["designChangeTrackerPrisma"], error);
  }
}

// =====================================================
// v0.3.0 Tier 2 新サービス初期化
// v0.3.0 Tier 2 new service initialization
// =====================================================

function initializeAuditLogService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  try {
    // AuditLogServiceの内部PrismaClient DI登録
    // AuditLogPrismaClient は Prisma model (auditLog) を要求
    // IPrismaClientMinimal に auditLog がないため直接キャスト
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma model access requires any cast from IPrismaClientMinimal
    const prismaWithAuditLog = config.prisma as any;
    setAuditLogPrismaClientFactory(
      () =>
        ({
          auditLog: prismaWithAuditLog.auditLog,
        }) as AuditLogPrismaClient
    );

    // audit.query ツールの DI ファクトリ登録
    setAuditQueryServiceFactory(() => getAuditLogService());

    result.registeredFactories.push("auditLogPrisma", "auditQueryService");
    result.categories.push("auditLog");
    logger.info("[ServiceInitializer] auditLog factories registered (prisma, queryService)");
  } catch (error) {
    recordInitError(result, "AuditLog", ["auditLogPrisma", "auditQueryService"], error);
  }
}

function initializeGdprDeletionService(
  config: ServiceInitializerConfig,
  result: SearchRegistrarResult
): void {
  try {
    // GdprDeletionServiceの内部PrismaClient DI登録
    // GdprPrismaClient は $queryRawUnsafe + $executeRawUnsafe + $transaction を要求
    setGdprPrismaClientFactory(
      () =>
        ({
          $queryRawUnsafe: config.prisma.$queryRawUnsafe.bind(config.prisma),
          $executeRawUnsafe: config.prisma.$executeRawUnsafe.bind(config.prisma),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPrismaClientMinimal.$transaction is optional but GDPR deletion requires it
          $transaction: config.prisma.$transaction!.bind(config.prisma) as any,
        }) as unknown as GdprPrismaClient
    );

    // Screenshot 永続化サービスを GDPR 削除経路にも注入（GDPR Art. 17）
    // Wire screenshot persistence service into GDPR deletion path (GDPR Art. 17)
    //
    // GDPR 削除時に DB 行と合わせて `<REFTRIX_SCREENSHOT_ROOT>/phase5/<pageId>.png`
    // のファイル本体も削除する。Prisma の `webPage.update` などを利用するため、
    // ここで最小限の Prisma クライアントアダプタを構築して注入する。
    //
    // Also removes the on-disk PNG (`<REFTRIX_SCREENSHOT_ROOT>/phase5/<pageId>.png`)
    // alongside the DB row on GDPR deletion. Builds a minimal Prisma adapter for
    // the persistence service here.
    setGdprScreenshotPersistenceFactory(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter between PrismaClient and IScreenshotPersistencePrismaClient
      const anyPrisma = config.prisma as any;
      if (!anyPrisma?.webPage) {
        throw new Error(
          "[ServiceRegistrar] PrismaClient does not expose webPage delegate for screenshot persistence"
        );
      }
      return createScreenshotPersistenceService({
        prisma: config.prisma as unknown as IScreenshotPersistencePrismaClient,
      });
    });

    // data.delete / data.export ツールの DI ファクトリ登録
    // GdprDeletionService は delete + export の両方を提供する
    setDataDeleteServiceFactory(() => getGdprDeletionService());
    setDataExportServiceFactory(() => getGdprDeletionService());

    // PR7a-4: Embedding Backfill Queue を data.delete に注入（lazy init）
    // GDPR Art.17 / CCPA §1798.105: page 削除時に Queue の滞留ジョブを削除
    // するため。Redis 接続コストを避けるため初回呼び出しまで遅延初期化する。
    //
    // PR7a-4: Inject embedding backfill queue into data.delete (lazy init).
    // Required for GDPR Art.17 / CCPA §1798.105 erasure: removes queued
    // backfill jobs tied to the page being deleted. Lazy-initialized to
    // avoid Redis connection cost when data.delete is never invoked.
    let cachedBackfillQueue: Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult> | null =
      null;
    setDataDeleteBackfillQueueFactory(() => {
      if (cachedBackfillQueue === null) {
        cachedBackfillQueue = createEmbeddingBackfillQueue();
      }
      return cachedBackfillQueue;
    });

    result.registeredFactories.push(
      "gdprPrisma",
      "gdprScreenshotPersistence",
      "dataDeleteService",
      "dataExportService",
      "dataDeleteBackfillQueue"
    );
    result.categories.push("gdprDeletion");
    logger.info(
      "[ServiceInitializer] gdprDeletion factories registered (prisma, delete, export, backfillQueue)"
    );
  } catch (error) {
    recordInitError(
      result,
      "GdprDeletion",
      ["gdprPrisma", "dataDeleteService", "dataExportService"],
      error
    );
  }
}

function initializeAccessibilityAuditService(result: SearchRegistrarResult): void {
  try {
    // AccessibilityAuditService + ContrastCheckService（DI依存なし、自己完結）
    setAccessibilityAuditServiceFactory(() => createAccessibilityAuditService());
    setContrastCheckServiceFactory(() => createContrastCheckService());

    result.registeredFactories.push("accessibilityAuditService", "contrastCheckService");
    result.categories.push("accessibilityAudit");
    logger.info("[ServiceInitializer] accessibilityAudit factories registered (audit, contrast)");
  } catch (error) {
    recordInitError(
      result,
      "AccessibilityAudit",
      ["accessibilityAuditService", "contrastCheckService"],
      error
    );
  }
}

function initializeResponsiveCaptureService(result: SearchRegistrarResult): void {
  try {
    // MultiDeviceCaptureService + ResponsiveDiffService（DI依存なし、自己完結）
    setResponsiveCaptureServiceFactory(
      () => new MultiDeviceCaptureService(),
      () => new ResponsiveDiffService()
    );

    result.registeredFactories.push("responsiveCaptureService", "responsiveDiffService");
    result.categories.push("responsiveCapture");
    logger.info("[ServiceInitializer] responsiveCapture factories registered (capture, diff)");
  } catch (error) {
    recordInitError(
      result,
      "ResponsiveCapture",
      ["responsiveCaptureService", "responsiveDiffService"],
      error
    );
  }
}
