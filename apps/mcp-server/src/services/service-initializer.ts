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
 * NOTE: ドメイン別のファクトリ登録は以下に分離:
 * - service-registrar-analysis.ts: Motion, Layout, Quality
 * - service-registrar-search.ts: Narrative, Background, Responsive, Preference, DesignSearch, EmbeddingBackfill, Page
 *
 * @module services/service-initializer
 */

import { logger } from "../utils/logger";

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
} from "./production-guard";

// ローカルで使用するためインポート
import { assertProductionRequiredCategoriesInitialized } from "./production-guard";

// =====================================================
// ドメイン別レジストラ - 再エクスポート
// 後方互換性のため、分割前と同じパスでインポート可能
// =====================================================

export {
  initializeMotionServices,
  initializeLayoutServices,
  initializeQualityServices,
} from "./service-registrar-analysis";

import {
  initializeMotionServices,
  initializeLayoutServices,
  initializeQualityServices,
} from "./service-registrar-analysis";

import { initializeSearchAndAuxiliaryServices } from "./service-registrar-search";

// =====================================================
// 型定義
// =====================================================

/**
 * Embedding サービスインターフェース（最小限）
 * 各サービスはこのインターフェースを拡張している場合がある
 */
export interface IEmbeddingService {
  generateEmbedding(text: string, type?: "query" | "passage"): Promise<number[]>;
  /** GPU VRAMアイドルタイムアウト設定 / Set idle timeout for GPU VRAM auto-release */
  setIdleTimeout?(ms: number): void;
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
 * Prisma Client インターフェース（最小限）
 * MinimalPrismaClientとの互換性のため、createは関数型として定義
 */
export interface IPrismaClientMinimal {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma SelectSubset<T> generics require any for assignability from PrismaClient
  motionPattern?: { create: (...args: any[]) => Promise<{ id: string }> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma SelectSubset<T> generics require any for assignability from PrismaClient
  motionEmbedding?: { create: (...args: any[]) => Promise<{ id: string }> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma SelectSubset<T> generics require any for assignability from PrismaClient
  sectionPattern?: { create: (...args: any[]) => Promise<{ id: string }> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma SelectSubset<T> generics require any for assignability from PrismaClient
  sectionEmbedding?: { create: (...args: any[]) => Promise<{ id: string }> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma SelectSubset<T> generics require any for assignability from PrismaClient
  qualityBenchmark?: { create: (...args: any[]) => Promise<{ id: string }> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma $executeRawUnsafe accepts heterogeneous value types
  $executeRawUnsafe: (...args: any[]) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma $queryRawUnsafe accepts heterogeneous value types
  $queryRawUnsafe: (...args: any[]) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma transaction callback receives internal client variant
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
export function initializeAllServices(config: ServiceInitializerConfig): ServiceInitializerResult {
  const allRegistered: string[] = [];
  const allCategories: string[] = [];
  const allSkipped: string[] = [];
  const errors: string[] = [];

  // MCP-INIT-02: 詳細情報を収集
  const skippedCategoriesInfo: SkippedCategoryInfo[] = [];
  const errorsInfo: InitializationErrorInfo[] = [];

  // =====================================================
  // Analysis ドメイン（Motion, Layout, Quality）
  // =====================================================

  // Motion サービス初期化
  const motionResult = initializeMotionServices(config);
  if (motionResult.success) {
    allRegistered.push(...motionResult.registeredFactories);
    allCategories.push(...motionResult.categories);
  } else if (motionResult.error) {
    errors.push(`Motion: ${motionResult.error}`);
    errorsInfo.push({ category: "Motion", error: motionResult.error });
  }
  allSkipped.push(...motionResult.skipped);
  // スキップされたファクトリの理由を記録
  for (const skippedFactory of motionResult.skipped) {
    skippedCategoriesInfo.push({
      category: `Motion.${skippedFactory}`,
      reason: "Missing dependency (webPageService)",
    });
  }

  // Layout サービス初期化
  const layoutResult = initializeLayoutServices(config);
  if (layoutResult.success) {
    allRegistered.push(...layoutResult.registeredFactories);
    allCategories.push(...layoutResult.categories);
  } else if (layoutResult.error) {
    errors.push(`Layout: ${layoutResult.error}`);
    errorsInfo.push({ category: "Layout", error: layoutResult.error });
  }
  allSkipped.push(...layoutResult.skipped);
  for (const skippedFactory of layoutResult.skipped) {
    skippedCategoriesInfo.push({
      category: `Layout.${skippedFactory}`,
      reason: "Missing dependency",
    });
  }

  // Quality サービス初期化
  const qualityResult = initializeQualityServices(config);
  if (qualityResult.success) {
    allRegistered.push(...qualityResult.registeredFactories);
    allCategories.push(...qualityResult.categories);
  } else if (qualityResult.error) {
    errors.push(`Quality: ${qualityResult.error}`);
    errorsInfo.push({ category: "Quality", error: qualityResult.error });
  }
  allSkipped.push(...qualityResult.skipped);
  for (const skippedFactory of qualityResult.skipped) {
    skippedCategoriesInfo.push({
      category: `Quality.${skippedFactory}`,
      reason: "Missing dependency",
    });
  }

  // =====================================================
  // Search & Auxiliary ドメイン
  // (Page, Narrative, Background, Responsive, Preference, DesignSearch, EmbeddingBackfill)
  // =====================================================

  const searchResult = initializeSearchAndAuxiliaryServices(config);
  allRegistered.push(...searchResult.registeredFactories);
  allCategories.push(...searchResult.categories);
  allSkipped.push(...searchResult.skipped);
  errors.push(...searchResult.errors);
  skippedCategoriesInfo.push(...searchResult.skippedCategoriesInfo);
  errorsInfo.push(...searchResult.errorsInfo);

  // =====================================================
  // 少なくとも1つ成功していれば success=true
  // =====================================================
  const success = allRegistered.length > 0;

  // =====================================================
  // 起動ログの可視化（有効化されたカテゴリを表示）
  // =====================================================
  const uniqueCategories = [...new Set(allCategories)];
  const capitalizedCategories = uniqueCategories.map(
    (cat) => cat.charAt(0).toUpperCase() + cat.slice(1)
  );

  logger.info("============================================================");
  logger.info("[ServiceInitializer] Service Initialization Complete");
  logger.info(`  Initialized: ${capitalizedCategories.join(", ") || "None"}`);
  logger.info(`  Factories: ${allRegistered.length} registered`);
  if (allSkipped.length > 0) {
    logger.info(`  Skipped: ${allSkipped.join(", ")}`);
  }
  logger.info("============================================================");

  // =====================================================
  // MCP-INIT-02: 警告ログ強化
  // =====================================================
  // エラーがある場合の警告出力
  if (errorsInfo.length > 0) {
    const errorSummary = errorsInfo.map((e) => `${e.category}: ${e.error}`).join(", ");
    logger.warn(`⚠️ Initialization errors: ${errorSummary}`);
  }

  // スキップされたカテゴリがある場合の警告出力
  if (skippedCategoriesInfo.length > 0) {
    const skippedSummary = skippedCategoriesInfo
      .map((s) => `${s.category} (${s.reason})`)
      .join(", ");
    logger.warn(`⚠️ Skipped categories: ${skippedSummary}`);
  }

  // =====================================================
  // 配線漏れ検出（必須サービスが未初期化の場合に警告）
  // =====================================================
  const requiredCategories = ["motion", "layout", "quality", "page"];
  const missingCategories = requiredCategories.filter((cat) => !uniqueCategories.includes(cat));

  if (missingCategories.length > 0) {
    logger.warn("============================================================");
    logger.warn("[ServiceInitializer] MISSING REQUIRED CATEGORIES:");
    for (const missing of missingCategories) {
      logger.warn(`  - ${missing.toUpperCase()} services not initialized`);
      // MCP-INIT-02: 不足カテゴリも skippedCategoriesInfo に追加
      skippedCategoriesInfo.push({
        category: missing.toUpperCase(),
        reason: "Category not initialized",
      });
    }
    logger.warn("  This may cause runtime errors when using MCP tools.");
    logger.warn("============================================================");
  }

  // 必須ファクトリの検証
  const requiredFactories = [
    // Motion
    "motionSearch",
    "motionPersistence",
    "motionDb",
    "frameEmbedding",
    "jsAnimationEmbedding",
    // Layout
    "layoutSearch",
    "layoutToCode",
    "layoutInspect",
    "layoutIngest",
    // Quality
    "qualityEvaluate",
    "benchmarkService",
    "patternMatcher",
  ];
  const missingFactories = requiredFactories.filter(
    (factory) => !allRegistered.includes(factory) && !allSkipped.includes(factory)
  );

  if (missingFactories.length > 0) {
    logger.warn("[ServiceInitializer] MISSING REQUIRED FACTORIES:");
    for (const missing of missingFactories) {
      logger.warn(`  - ${missing} not registered`);
    }
  }

  if (errors.length > 0) {
    logger.error("[ServiceInitializer] Initialization errors:");
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
  // GPU VRAM自動解放: EmbeddingServiceアイドルタイムアウト設定
  // 検索ツール実行後にCUDA VRAMを自動解放し、
  // 後続のOllama Vision解析がGPUを使用できるようにする
  // =====================================================
  configureEmbeddingIdleTimeout(config.embeddingService);

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
    result.error = errors.join("; ");
  }

  return result;
}

// =====================================================
// EmbeddingService GPU VRAM自動解放
// Embedding idle timeout for automatic GPU VRAM release
// =====================================================

/** デフォルトのアイドルタイムアウト（30秒） / Default idle timeout (30 seconds) */
const DEFAULT_EMBEDDING_IDLE_TIMEOUT_MS = 30_000;

/**
 * EmbeddingServiceにアイドルタイムアウトを設定する。
 * 最後のembedding生成からN秒後に自動的にdispose()を呼び、
 * CUDA VRAMを解放する。これにより後続のOllama Vision解析が
 * GPUを使用できるようになる。
 *
 * Configure idle timeout on EmbeddingService.
 * Automatically calls dispose() N seconds after the last embedding generation
 * to release CUDA VRAM, allowing subsequent Ollama Vision analysis to use GPU.
 *
 * @param embeddingService EmbeddingServiceインスタンス
 */
function configureEmbeddingIdleTimeout(embeddingService: IEmbeddingService): void {
  // setIdleTimeoutメソッドの存在チェック（オプショナルメソッド）
  // Runtime check for setIdleTimeout method (optional on IEmbeddingService)
  if (typeof embeddingService.setIdleTimeout !== "function") {
    logger.debug(
      "[ServiceInitializer] EmbeddingService.setIdleTimeout() not available, skipping GPU VRAM idle timeout configuration"
    );
    return;
  }

  // 環境変数でタイムアウト値を設定可能にする（デフォルト30秒）
  // Allow timeout configuration via environment variable (default 30s)
  const envTimeout = process.env["EMBEDDING_IDLE_TIMEOUT_MS"];
  let timeoutMs = DEFAULT_EMBEDDING_IDLE_TIMEOUT_MS;

  if (envTimeout !== undefined) {
    const parsed = parseInt(envTimeout, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      timeoutMs = parsed;
    } else {
      logger.warn(
        `[ServiceInitializer] Invalid EMBEDDING_IDLE_TIMEOUT_MS value: "${envTimeout}", using default ${DEFAULT_EMBEDDING_IDLE_TIMEOUT_MS}ms`
      );
    }
  }

  // setIdleTimeoutを呼び出す
  // Call setIdleTimeout on the embedding service
  embeddingService.setIdleTimeout(timeoutMs);

  logger.info(
    `[ServiceInitializer] EmbeddingService GPU VRAM idle timeout configured: ${timeoutMs}ms`
  );
}
