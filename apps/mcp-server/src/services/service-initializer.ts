// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Service Initializer
 *
 * DI Factory統合モジュール。
 * 複数のサービスファクトリを一括で初期化し、
 * 依存関係を適切に注入する。
 *
 * TDA-HP2: 16個のset*Factory呼び出しを3つの統合関数に集約
 * Phase6-SEC-1: 本番環境ガード機能追加
 *
 * NOTE: 循環依存解消のため、本番環境ガード機能は production-guard.ts に分離。
 * 後方互換性のため、このファイルからも再エクスポートしています。
 *
 * @module services/service-initializer
 */

import { logger } from '../utils/logger';


// =====================================================
// 本番環境ガード (Production Guard) - 再エクスポート
// 循環依存解消のため production-guard.ts に分離
// =====================================================

export {
  ProductionGuardError,
  ProductionCategoryRequiredError,
  isProductionEnvironment,
  isDevelopmentEnvironment,
  assertNonProductionFactory,
  createProductionSafeFactory,
  assertProductionRequiredCategoriesInitialized,
  REQUIRED_CATEGORIES_FOR_PRODUCTION,
  type ProductionSafeFactory,
} from './production-guard';

// ローカルで使用するためインポート
import {
  isDevelopmentEnvironment,
  assertProductionRequiredCategoriesInitialized,
} from './production-guard';

import { createPrismaWrapper } from '../utils/prisma-wrapper-factory';

// Motion関連インポート
// 循環依存解消: tools/motion/index.ts ではなく個別ファイルからインポート
import {
  setMotionDetectServiceFactory,
  setMotionPersistenceServiceFactory,
  setJSAnimationPersistencePrismaClientFactory,
  type IJSAnimationPersistencePrismaClient,
} from '../tools/motion/di-factories';
import { setMotionSearchServiceFactory } from '../tools/motion/search.tool';
import {
  setMotionPersistenceEmbeddingServiceFactory,
  setMotionPersistencePrismaClientFactory,
  MotionPatternPersistenceService,
  type IPrismaClient as IMotionPrismaClient,
} from './motion-persistence.service';
import {
  createMotionSearchServiceFactory,
  setEmbeddingServiceFactory as setMotionSearchEmbeddingServiceFactory,
  setPrismaClientFactory as setMotionSearchPrismaClientFactory,
  setJSAnimationSearchServiceFactory,
  type IPrismaClient as IMotionSearchPrismaClient,
} from './motion-search.service';
import {
  setJSAnimationEmbeddingServiceFactory,
  type IEmbeddingService as IJSAnimationEmbeddingService,
} from './motion/js-animation-embedding.service';
import {
  JSAnimationSearchService,
  type IPrismaClient as IJSAnimationSearchPrismaClient,
} from './motion/js-animation-search.service';
import {
  setMotionDbEmbeddingServiceFactory,
  setMotionDbPrismaClientFactory,
  type IPrismaClient as IMotionDbPrismaClient,
} from './motion/motion-db.service';
import {
  setEmbeddingServiceFactory as setFrameEmbeddingServiceFactory,
  setPrismaClientFactory as setFramePrismaClientFactory,
  type IPrismaClient as IFramePrismaClient,
} from './motion/frame-embedding.service';

// Layout関連インポート
// 循環依存解消: tools/layout/index.ts ではなく個別ファイルからインポート
import { setLayoutSearchServiceFactory } from '../tools/layout/search.tool';
import { setLayoutToCodeServiceFactory } from '../tools/layout/to-code.tool';
import { setLayoutInspectServiceFactory } from '../tools/layout/inspect';
import { setLayoutIngestServiceFactory } from '../tools/layout/ingest.tool';

// Page関連インポート
// 循環依存解消: tools/page/index.ts ではなく個別ファイルからインポート
import {
  setPageAnalyzePrismaClientFactory,
  type IPageAnalyzePrismaClient,
} from '../tools/page/analyze.tool';

// Narrative関連インポート
import { setNarrativeSearchServiceFactory } from '../tools/narrative/search.tool';
import { createNarrativeSearchService } from './narrative-search.service';

// Background関連インポート
import {
  setBackgroundSearchServiceFactory,
} from '../tools/background/search.tool';
import { createBackgroundSearchService } from './background-search.service';
import {
  setBackgroundPrismaClientFactory,
  setBackgroundEmbeddingServiceFactory,
} from './background/background-design-embedding.service';

// Embedding Handler関連インポート（backfill DI用）
import {
  setMotionLayoutEmbeddingServiceFactory,
} from '../tools/page/handlers/embedding-handler';

// Quality関連インポート
import {
  setQualityEvaluateServiceFactory,
  setBenchmarkServiceFactory,
  setPatternMatcherServiceFactory,
} from '../tools/quality/evaluate.tool';
import { BenchmarkService } from './quality/benchmark.service';
import {
  setPatternMatcherPrismaClientFactory,
  createPatternMatcherServiceFactory,
  type IPrismaClient as IPatternMatcherPrismaClient,
} from './quality/pattern-matcher.service';
import { createQualitySearchService } from './quality-search.service';
import {
  createLayoutSearchServiceFactory,
  setLayoutEmbeddingServiceFactory as setLayoutSearchEmbeddingServiceFactory,
  setLayoutPrismaClientFactory as setLayoutSearchPrismaClientFactory,
  type IPrismaClient as ILayoutSearchPrismaClient,
} from './layout-search.service';
import {
  createLayoutToCodeServiceFactory,
  setLayoutToCodePrismaClientFactory,
  type IPrismaClient as ILayoutToCodePrismaClient,
} from './layout-to-code.service';
import {
  setEmbeddingServiceFactory as setLayoutEmbeddingServiceFactory,
  setPrismaClientFactory as setLayoutPrismaClientFactory,
  saveSectionWithEmbedding,
  type SaveSectionOptions,
  type IPrismaClient as ILayoutPrismaClient,
} from './layout-embedding.service';
import {
  detectSections,
  analyzeTypography,
  detectGrid,
  extractColors,
  type LayoutInspectData,
  type SectionInfo,
} from '../tools/layout/inspect';
import type { ScreenshotInput } from '../tools/layout/inspect/inspect.tool';

// Vision Adapter インポート
import { LlamaVisionAdapter } from './vision-adapter/llama-vision.adapter';
import type {
  IVisionAnalyzer,
  VisionAnalysisResult,
} from './vision-adapter/interface';

// =====================================================
// 型定義
// =====================================================

/**
 * Embedding サービスインターフェース（最小限）
 * 各サービスはこのインターフェースを拡張している場合がある
 */
export interface IEmbeddingService {
  generateEmbedding(text: string, type?: 'query' | 'passage'): Promise<number[]>;
}

/**
 * Layout用拡張Embeddingサービスインターフェース
 */
interface ILayoutEmbeddingService {
  generateEmbedding(text: string, type: 'query' | 'passage'): Promise<number[]>;
  generateBatchEmbeddings(texts: string[], type: 'query' | 'passage'): Promise<number[][]>;
  getCacheStats(): { hits: number; misses: number; size: number; evictions: number };
  clearCache(): void;
}

/**
 * WebPage サービスインターフェース
 * web-page.service.ts と互換性を保つため、htmlContent形式を使用
 */
export interface IWebPageService {
  getPageById(id: string): Promise<WebPageResult | null>;
}

/**
 * WebPage 結果型（web-page.service.ts と同じ形式）
 * motion.detect互換形式を使用
 */
export interface WebPageResult {
  id: string;
  htmlContent: string;
  cssContent?: string;
}

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
 * Service Client インターフェース
 * 将来の拡張用に保持
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IServiceClient {}

/**
 * Prisma Client インターフェース（最小限）
 * MinimalPrismaClientとの互換性のため、createは関数型として定義
 */
export interface IPrismaClientMinimal {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  motionPattern?: { create: (...args: any[]) => Promise<any> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  motionEmbedding?: { create: (...args: any[]) => Promise<any> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sectionPattern?: { create: (...args: any[]) => Promise<any> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sectionEmbedding?: { create: (...args: any[]) => Promise<any> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  qualityBenchmark?: { create: (...args: any[]) => Promise<any> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $executeRawUnsafe: (...args: any[]) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRawUnsafe: (...args: any[]) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction?: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
}

/**
 * サービス初期化設定
 */
export interface ServiceInitializerConfig {
  /** Embedding生成サービス（必須） */
  embeddingService: IEmbeddingService;
  /** Prismaクライアント（必須） */
  prisma: IPrismaClientMinimal;
  /** WebPageサービス（オプション - motion.detect, layout.inspect用） */
  webPageService?: IWebPageService;
  /** ServiceClient（オプション - 将来の拡張用） */
  serviceClient?: IServiceClient;
}

/**
 * サービス初期化結果
 */
export interface ServiceInitializerResult {
  /** 初期化成功フラグ */
  success: boolean;
  /** 登録されたファクトリ名リスト */
  registeredFactories: string[];
  /** 初期化されたカテゴリリスト */
  categories: string[];
  /** スキップされたファクトリ（依存関係不足） */
  skipped: string[];
  /** エラーメッセージ（失敗時） */
  error?: string;
}

/**
 * スキップされたカテゴリの詳細情報
 */
export interface SkippedCategoryInfo {
  /** カテゴリ名 */
  category: string;
  /** スキップ理由 */
  reason: string;
}

/**
 * エラー情報
 */
export interface InitializationErrorInfo {
  /** カテゴリ名 */
  category: string;
  /** エラーメッセージ */
  error: string;
}

/**
 * 詳細な初期化結果（MCP-INIT-02）
 * initializeAllServices() の戻り値に詳細情報を追加
 */
export interface InitializationDetailedResult {
  /** 初期化成功フラグ（少なくとも1つ成功していれば true） */
  success: boolean;
  /** 初期化されたカテゴリリスト */
  initializedCategories: string[];
  /** スキップされたカテゴリ詳細 */
  skippedCategories: SkippedCategoryInfo[];
  /** エラー情報 */
  errors: InitializationErrorInfo[];
  /** 登録されたツール/ファクトリ数 */
  registeredToolCount: number;
  /** 登録されたファクトリ名リスト */
  registeredFactories: string[];
}

// グローバルに最後の初期化結果を保持（system.health から参照）
let lastInitializationResult: InitializationDetailedResult | null = null;

/**
 * 最後の初期化結果を取得
 * @returns 初期化結果（未初期化の場合は null）
 */
export function getLastInitializationResult(): InitializationDetailedResult | null {
  return lastInitializationResult;
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
      error: 'Missing required dependency: prisma',
    };
  }

  if (!config.embeddingService) {
    return {
      success: false,
      registeredFactories: [],
      categories: [],
      skipped: [],
      error: 'Missing required dependency: embeddingService',
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
            htmlContent: result.htmlContent ?? '',
          };
          return motionResult;
        },
      }));
      registeredFactories.push('motionDetect');
      logger.info('[ServiceInitializer] motionDetect factory registered');
    } else {
      skipped.push('motionDetect');
    }

    // 2. motion.search ファクトリ
    setMotionSearchEmbeddingServiceFactory(() => config.embeddingService);
    setMotionSearchPrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ['motionPattern', 'motionEmbedding'],
          supportsTransaction: false,
        }) as unknown as IMotionSearchPrismaClient
    );
    setMotionSearchServiceFactory(createMotionSearchServiceFactory());
    registeredFactories.push('motionSearch');
    logger.info('[ServiceInitializer] motionSearch factory registered');

    // 3. motion.detect persistence ファクトリ
    setMotionPersistenceEmbeddingServiceFactory(() => config.embeddingService);
    setMotionPersistencePrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ['motionPattern', 'motionEmbedding'],
          supportsTransaction: true,
        }) as unknown as IMotionPrismaClient
    );
    setMotionPersistenceServiceFactory(() => new MotionPatternPersistenceService());
    registeredFactories.push('motionPersistence');
    logger.info('[ServiceInitializer] motionPersistence factory registered');

    // 4. JS Animation Embedding ファクトリ
    // NOTE: config.embeddingService (@reftrix/ml) は必要なメソッド全て持っているが、
    // 最小インターフェースで型定義されているため、キャストが必要
    setJSAnimationEmbeddingServiceFactory(
      () => config.embeddingService as unknown as IJSAnimationEmbeddingService
    );
    registeredFactories.push('jsAnimationEmbedding');
    logger.info('[ServiceInitializer] jsAnimationEmbedding factory registered');

    // 4.5. JS Animation Search ファクトリ（motion.search JS統合用）
    // PrismaClientのラッパーを使ってJSAnimationSearchServiceを初期化
    setJSAnimationSearchServiceFactory(() => {
      const jsSearchPrisma = createPrismaWrapper(config.prisma, {
        tables: ['jSAnimationPattern', 'jSAnimationEmbedding'],
        supportsTransaction: false,
      });
      return new JSAnimationSearchService({
        prisma: jsSearchPrisma as unknown as IJSAnimationSearchPrismaClient,
      });
    });
    registeredFactories.push('jsAnimationSearch');
    logger.info('[ServiceInitializer] jsAnimationSearch factory registered');

    // 4.6. JS Animation Persistence Prisma ファクトリ（motion.detect JS保存用）
    setJSAnimationPersistencePrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ['jSAnimationPattern', 'jSAnimationEmbedding'],
          supportsTransaction: true,
        }) as unknown as IJSAnimationPersistencePrismaClient
    );
    registeredFactories.push('jsAnimationPersistence');
    logger.info('[ServiceInitializer] jsAnimationPersistence factory registered');

    // 5. MotionDbService ファクトリ（Frame Image Analysis結果のDB保存用）
    setMotionDbEmbeddingServiceFactory(() => config.embeddingService);
    setMotionDbPrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ['motionAnalysisResult', 'motionAnalysisEmbedding'],
          supportsTransaction: true,
        }) as unknown as IMotionDbPrismaClient
    );
    registeredFactories.push('motionDb');
    logger.info('[ServiceInitializer] motionDb factory registered');

    // 6. FrameEmbeddingService ファクトリ（フレーム解析結果のEmbedding保存用）
    // NOTE: frame-embedding.service は拡張インターフェースを要求するため、
    // Layout Embedding と同様にアダプタを作成
    const frameEmbeddingAdapter = {
      generateEmbedding: (text: string, type: 'query' | 'passage'): Promise<number[]> =>
        config.embeddingService.generateEmbedding(text, type),
      generateBatchEmbeddings: async (texts: string[], type: 'query' | 'passage'): Promise<number[][]> => {
        const results: number[][] = [];
        for (const text of texts) {
          results.push(await config.embeddingService.generateEmbedding(text, type));
        }
        return results;
      },
      getCacheStats: (): { hits: number; misses: number; size: number; evictions: number } => ({ hits: 0, misses: 0, size: 0, evictions: 0 }),
      clearCache: (): void => {},
    };
    setFrameEmbeddingServiceFactory(() => frameEmbeddingAdapter);
    setFramePrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ['motionPattern', 'motionEmbedding'],
          supportsTransaction: true,
        }) as unknown as IFramePrismaClient
    );
    registeredFactories.push('frameEmbedding');
    logger.info('[ServiceInitializer] frameEmbedding factory registered');

    return {
      success: true,
      registeredFactories,
      categories: ['motion'],
      skipped,
    };
  } catch (error) {
    return {
      success: false,
      registeredFactories,
      categories: [],
      skipped,
      error: error instanceof Error ? error.message : 'Unknown error',
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
      error: 'Missing required dependency: prisma',
    };
  }

  if (!config.embeddingService) {
    return {
      success: false,
      registeredFactories: [],
      categories: [],
      skipped: [],
      error: 'Missing required dependency: embeddingService',
    };
  }

  try {
    // 1. layout.search ファクトリ（EmbeddingService + PrismaClient + Service）
    setLayoutSearchEmbeddingServiceFactory(() => config.embeddingService);
    setLayoutSearchPrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ['sectionPattern', 'sectionEmbedding'],
          supportsTransaction: false,
        }) as unknown as ILayoutSearchPrismaClient
    );
    setLayoutSearchServiceFactory(createLayoutSearchServiceFactory());
    registeredFactories.push('layoutSearch');
    logger.info('[ServiceInitializer] layoutSearch factory registered (with EmbeddingService + PrismaClient)');

    // 2. layout.to_code ファクトリ（PrismaClient + Service）
    setLayoutToCodePrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ['sectionPattern', 'webPage'],
          supportsTransaction: false,
        }) as unknown as ILayoutToCodePrismaClient
    );
    setLayoutToCodeServiceFactory(createLayoutToCodeServiceFactory());
    registeredFactories.push('layoutToCode');
    logger.info('[ServiceInitializer] layoutToCode factory registered (with PrismaClient)');

    // 3. layout.inspect ファクトリ（webPageServiceなしでも基本機能は使用可能）
    // LlamaVisionAdapter をインスタンス化（遅延初期化）
    let visionAdapterInstance: IVisionAnalyzer | null = null;
    const getOrCreateVisionAdapter = (): IVisionAnalyzer => {
      if (!visionAdapterInstance) {
        visionAdapterInstance = new LlamaVisionAdapter();
        if (isDevelopmentEnvironment()) {
          logger.debug('[ServiceInitializer] LlamaVisionAdapter created lazily');
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
              error: 'LlamaVision (Ollama) is not available. Please ensure Ollama is running with llama3.2-vision model.',
              processingTimeMs: 0,
              modelName: adapter.modelName,
            };
          }

          // base64をBufferに変換
          const imageBuffer = Buffer.from(screenshot.base64, 'base64');

          // Vision解析実行
          const result = await adapter.analyze({
            imageBuffer,
            mimeType: screenshot.mimeType,
            features: [
              'layout_structure',
              'color_palette',
              'typography',
              'visual_hierarchy',
              'whitespace',
              'section_boundaries',
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
            htmlContent: result.htmlContent ?? '',
          };
        };
      }

      return service;
    });
    registeredFactories.push('layoutInspect');
    logger.info('[ServiceInitializer] layoutInspect factory registered (with LlamaVision support)');

    // 4. layout.ingest ファクトリ
    // Layout Embedding Serviceは拡張インターフェースを要求するため、アダプタを作成
    const layoutEmbeddingAdapter: ILayoutEmbeddingService = {
      generateEmbedding: (text: string, type: 'query' | 'passage') =>
        config.embeddingService.generateEmbedding(text, type),
      generateBatchEmbeddings: async (texts: string[], type: 'query' | 'passage') => {
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
          tables: ['sectionPattern', 'sectionEmbedding'],
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
            .map((s) => `${s.type}: ${s.content.headings.map((h) => h.text).join(', ')}`)
            .join('; '),
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
        const result = await config.embeddingService.generateEmbedding(text, 'passage');
        return result;
      },
    }));
    registeredFactories.push('layoutIngest');
    logger.info('[ServiceInitializer] layoutIngest factory registered');

    return {
      success: true,
      registeredFactories,
      categories: ['layout'],
      skipped,
    };
  } catch (error) {
    return {
      success: false,
      registeredFactories,
      categories: [],
      skipped,
      error: error instanceof Error ? error.message : 'Unknown error',
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
      error: 'Missing required dependency: prisma',
    };
  }

  if (!config.embeddingService) {
    return {
      success: false,
      registeredFactories: [],
      categories: [],
      skipped: [],
      error: 'Missing required dependency: embeddingService',
    };
  }

  try {
    // 1. BenchmarkService ファクトリ
    // PrismaClientをそのまま渡す（BenchmarkServiceは$queryRawUnsafeを使用）
    setBenchmarkServiceFactory(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new BenchmarkService(config.prisma as any);
    });
    registeredFactories.push('benchmarkService');
    logger.info('[ServiceInitializer] benchmarkService factory registered');

    // 2. QualityEvaluateService ファクトリ
    // TDA-HS-R1 / M-2: QualitySearchService を独立ファイルに抽出
    setQualityEvaluateServiceFactory(() =>
      createQualitySearchService({
        prisma: config.prisma,
        embeddingService: config.embeddingService,
        webPageService: config.webPageService,
      })
    );
    registeredFactories.push('qualityEvaluate');
    logger.info('[ServiceInitializer] qualityEvaluate factory registered');

    // 3. PatternMatcherService ファクトリ（パターン駆動評価用）
    // PrismaClientファクトリを先に設定
    setPatternMatcherPrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ['sectionPattern', 'sectionEmbedding', 'motionPattern', 'motionEmbedding', 'webPage'],
          supportsTransaction: false,
        }) as unknown as IPatternMatcherPrismaClient
    );
    // PatternMatcherServiceファクトリを設定
    setPatternMatcherServiceFactory(createPatternMatcherServiceFactory());
    registeredFactories.push('patternMatcher');
    logger.info('[ServiceInitializer] patternMatcher factory registered');

    return {
      success: true,
      registeredFactories,
      categories: ['quality'],
      skipped,
    };
  } catch (error) {
    return {
      success: false,
      registeredFactories,
      categories: [],
      skipped,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// =====================================================
// 統合初期化
// =====================================================

/**
 * 全サービスを一括初期化
 *
 * Motion, Layout, Quality の全カテゴリを初期化。
 * 依存関係が不足している場合は可能な範囲で初期化を続行。
 *
 * MCP-INIT-02: 詳細な初期化結果を返却し、警告ログを強化
 *
 * @param config サービス初期化設定
 * @returns 初期化結果
 */
export function initializeAllServices(
  config: ServiceInitializerConfig
): ServiceInitializerResult {
  const allRegistered: string[] = [];
  const allCategories: string[] = [];
  const allSkipped: string[] = [];
  const errors: string[] = [];

  // MCP-INIT-02: 詳細情報を収集
  const skippedCategoriesInfo: SkippedCategoryInfo[] = [];
  const errorsInfo: InitializationErrorInfo[] = [];

  // Motion サービス初期化
  const motionResult = initializeMotionServices(config);
  if (motionResult.success) {
    allRegistered.push(...motionResult.registeredFactories);
    allCategories.push(...motionResult.categories);
  } else if (motionResult.error) {
    errors.push(`Motion: ${motionResult.error}`);
    errorsInfo.push({ category: 'Motion', error: motionResult.error });
  }
  allSkipped.push(...motionResult.skipped);
  // スキップされたファクトリの理由を記録
  for (const skippedFactory of motionResult.skipped) {
    skippedCategoriesInfo.push({
      category: `Motion.${skippedFactory}`,
      reason: 'Missing dependency (webPageService)',
    });
  }

  // Layout サービス初期化
  const layoutResult = initializeLayoutServices(config);
  if (layoutResult.success) {
    allRegistered.push(...layoutResult.registeredFactories);
    allCategories.push(...layoutResult.categories);
  } else if (layoutResult.error) {
    errors.push(`Layout: ${layoutResult.error}`);
    errorsInfo.push({ category: 'Layout', error: layoutResult.error });
  }
  allSkipped.push(...layoutResult.skipped);
  for (const skippedFactory of layoutResult.skipped) {
    skippedCategoriesInfo.push({
      category: `Layout.${skippedFactory}`,
      reason: 'Missing dependency',
    });
  }

  // Quality サービス初期化
  const qualityResult = initializeQualityServices(config);
  if (qualityResult.success) {
    allRegistered.push(...qualityResult.registeredFactories);
    allCategories.push(...qualityResult.categories);
  } else if (qualityResult.error) {
    errors.push(`Quality: ${qualityResult.error}`);
    errorsInfo.push({ category: 'Quality', error: qualityResult.error });
  }
  allSkipped.push(...qualityResult.skipped);
  for (const skippedFactory of qualityResult.skipped) {
    skippedCategoriesInfo.push({
      category: `Quality.${skippedFactory}`,
      reason: 'Missing dependency',
    });
  }

  // Page サービス初期化（page.analyze用のPrismaClient）
  try {
    setPageAnalyzePrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: [
            'webPage',
            'sectionPattern',
            'motionPattern',
            'qualityEvaluation',
            'qualityBenchmark',
            'jSAnimationPattern',
            'jSAnimationEmbedding',
          ],
          supportsTransaction: true,
        }) as unknown as IPageAnalyzePrismaClient
    );
    allRegistered.push('setPageAnalyzePrismaClientFactory');
    allCategories.push('page');
    logger.debug('[ServiceInitializer] page.analyze PrismaClient factory registered');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errors.push(`Page: ${errorMessage}`);
    errorsInfo.push({ category: 'Page', error: errorMessage });
    allSkipped.push('pageAnalyzePrismaClient');
    skippedCategoriesInfo.push({
      category: 'Page.pageAnalyzePrismaClient',
      reason: errorMessage,
    });
  }

  // Narrative サービス初期化（narrative.search用）
  // TDA-HS-R1 / M-1: NarrativeSearchService を独立ファイルに抽出
  try {
    setNarrativeSearchServiceFactory(() =>
      createNarrativeSearchService({
        prisma: config.prisma,
        embeddingService: config.embeddingService,
      })
    );
    allRegistered.push('narrativeSearch');
    allCategories.push('narrative');
    logger.info('[ServiceInitializer] narrativeSearch factory registered');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errors.push(`Narrative: ${errorMessage}`);
    errorsInfo.push({ category: 'Narrative', error: errorMessage });
    allSkipped.push('narrativeSearch');
    skippedCategoriesInfo.push({
      category: 'Narrative.narrativeSearch',
      reason: errorMessage,
    });
  }

  // Background サービス初期化（background.search用）
  // TDA-HS-R1 / H-3: BackgroundSearchService を独立ファイルに抽出
  try {
    setBackgroundSearchServiceFactory(() =>
      createBackgroundSearchService({
        prisma: config.prisma,
        embeddingService: config.embeddingService,
      })
    );
    allRegistered.push('backgroundSearch');
    allCategories.push('background');
    logger.info('[ServiceInitializer] backgroundSearch factory registered');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errors.push(`Background: ${errorMessage}`);
    errorsInfo.push({ category: 'Background', error: errorMessage });
    allSkipped.push('backgroundSearch');
    skippedCategoriesInfo.push({
      category: 'Background.backgroundSearch',
      reason: errorMessage,
    });
  }

  // Embedding Backfill DI ファクトリ初期化
  // Post-Embedding Backfill（page-analyze-worker）が background/motion embedding を
  // 生成するために必要な DI factory を登録する
  try {
    // 1. BackgroundDesign Embedding 用 PrismaClient
    setBackgroundPrismaClientFactory(
      () =>
        createPrismaWrapper(config.prisma, {
          tables: ['backgroundDesignEmbedding'],
          supportsTransaction: false,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
    );
    allRegistered.push('backgroundPrismaClient');

    // 2. BackgroundDesign Embedding 用 EmbeddingService
    // IBackgroundEmbeddingService は generateFromText(text) を要求
    setBackgroundEmbeddingServiceFactory(() => ({
      generateFromText: async (text: string): Promise<{
        embedding: number[];
        modelName: string;
        textUsed: string;
        processingTimeMs: number;
      }> => {
        const start = Date.now();
        const embedding = await config.embeddingService.generateEmbedding(text, 'passage');
        return {
          embedding,
          modelName: 'multilingual-e5-base',
          textUsed: text,
          processingTimeMs: Date.now() - start,
        };
      },
    }));
    allRegistered.push('backgroundEmbeddingService');

    // 3. Motion Embedding 用 LayoutEmbeddingService（embedding-handler DI）
    // ILayoutEmbeddingServiceForMotion は generateFromText(text) を要求
    setMotionLayoutEmbeddingServiceFactory(() => ({
      generateFromText: async (text: string): Promise<{
        embedding: number[];
        modelName: string;
      }> => {
        const embedding = await config.embeddingService.generateEmbedding(text, 'passage');
        return {
          embedding,
          modelName: 'multilingual-e5-base',
        };
      },
    }));
    allRegistered.push('motionLayoutEmbeddingService');

    logger.info('[ServiceInitializer] Embedding backfill DI factories registered (background + motion)');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    errors.push(`EmbeddingBackfill: ${errorMessage}`);
    errorsInfo.push({ category: 'EmbeddingBackfill', error: errorMessage });
    logger.warn(`[ServiceInitializer] Failed to register embedding backfill DI factories: ${errorMessage}`);
  }

  // 少なくとも1つ成功していれば success=true
  const success = allRegistered.length > 0;

  // =====================================================
  // 起動ログの可視化（有効化されたカテゴリを表示）
  // =====================================================
  const uniqueCategories = [...new Set(allCategories)];
  const capitalizedCategories = uniqueCategories.map(
    (cat) => cat.charAt(0).toUpperCase() + cat.slice(1)
  );

  logger.info('============================================================');
  logger.info('[ServiceInitializer] Service Initialization Complete');
  logger.info(`  Initialized: ${capitalizedCategories.join(', ') || 'None'}`);
  logger.info(`  Factories: ${allRegistered.length} registered`);
  if (allSkipped.length > 0) {
    logger.info(`  Skipped: ${allSkipped.join(', ')}`);
  }
  logger.info('============================================================');

  // =====================================================
  // MCP-INIT-02: 警告ログ強化
  // =====================================================
  // エラーがある場合の警告出力
  if (errorsInfo.length > 0) {
    const errorSummary = errorsInfo.map((e) => `${e.category}: ${e.error}`).join(', ');
    logger.warn(`⚠️ Initialization errors: ${errorSummary}`);
  }

  // スキップされたカテゴリがある場合の警告出力
  if (skippedCategoriesInfo.length > 0) {
    const skippedSummary = skippedCategoriesInfo
      .map((s) => `${s.category} (${s.reason})`)
      .join(', ');
    logger.warn(`⚠️ Skipped categories: ${skippedSummary}`);
  }

  // =====================================================
  // 配線漏れ検出（必須サービスが未初期化の場合に警告）
  // =====================================================
  const requiredCategories = ['motion', 'layout', 'quality', 'page'];
  const missingCategories = requiredCategories.filter(
    (cat) => !uniqueCategories.includes(cat)
  );

  if (missingCategories.length > 0) {
    logger.warn('============================================================');
    logger.warn('[ServiceInitializer] MISSING REQUIRED CATEGORIES:');
    for (const missing of missingCategories) {
      logger.warn(`  - ${missing.toUpperCase()} services not initialized`);
      // MCP-INIT-02: 不足カテゴリも skippedCategoriesInfo に追加
      skippedCategoriesInfo.push({
        category: missing.toUpperCase(),
        reason: 'Category not initialized',
      });
    }
    logger.warn('  This may cause runtime errors when using MCP tools.');
    logger.warn('============================================================');
  }

  // 必須ファクトリの検証
  const requiredFactories = [
    // Motion
    'motionSearch',
    'motionPersistence',
    'motionDb',
    'frameEmbedding',
    'jsAnimationEmbedding',
    // Layout
    'layoutSearch',
    'layoutToCode',
    'layoutInspect',
    'layoutIngest',
    // Quality
    'qualityEvaluate',
    'benchmarkService',
    'patternMatcher',
  ];
  const missingFactories = requiredFactories.filter(
    (factory) => !allRegistered.includes(factory) && !allSkipped.includes(factory)
  );

  if (missingFactories.length > 0) {
    logger.warn('[ServiceInitializer] MISSING REQUIRED FACTORIES:');
    for (const missing of missingFactories) {
      logger.warn(`  - ${missing} not registered`);
    }
  }

  if (errors.length > 0) {
    logger.error('[ServiceInitializer] Initialization errors:');
    for (const err of errors) {
      logger.error(`  - ${err}`);
    }
  }

  // =====================================================
  // P1-SEC-INIT-01: 本番環境での全必須カテゴリ初期化強制
  // =====================================================
  // 本番環境では全必須カテゴリが初期化されていなければエラー
  // 開発環境では警告のみで続行（上記の既存警告ログと連携）
  assertProductionRequiredCategoriesInitialized(uniqueCategories);

  // =====================================================
  // MCP-INIT-02: 詳細結果をグローバルに保存（system.healthで参照）
  // =====================================================
  lastInitializationResult = {
    success,
    initializedCategories: uniqueCategories,
    skippedCategories: skippedCategoriesInfo,
    errors: errorsInfo,
    registeredToolCount: allRegistered.length,
    registeredFactories: allRegistered,
  };

  const result: ServiceInitializerResult = {
    success,
    registeredFactories: allRegistered,
    categories: uniqueCategories,
    skipped: allSkipped,
  };

  if (errors.length > 0) {
    result.error = errors.join('; ');
  }

  return result;
}
