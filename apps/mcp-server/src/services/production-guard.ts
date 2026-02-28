// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Production Guard
 *
 * 本番環境でのセキュリティ強制機能:
 * - DI Factoryオーバーライドを防止
 * - MCP認証強制（NODE_ENV=production時）
 *
 * 循環依存を避けるためservice-initializer.tsから分離。
 *
 * @module services/production-guard
 */

import { logger } from '../utils/logger';

// =====================================================
// 定数
// =====================================================

/**
 * 環境識別子の定数
 * @internal
 */
const NODE_ENV_PRODUCTION = 'production' as const;
const NODE_ENV_DEVELOPMENT = 'development' as const;

// =====================================================
// エラークラス
// =====================================================

/**
 * 本番環境でのDI Factoryオーバーライドを防止するエラー
 *
 * このエラーは本番環境でDI Factoryのオーバーライドを試みた際にスローされます。
 * セキュリティ上の理由から、本番環境では依存性注入のオーバーライドは禁止されています。
 *
 * @example
 * ```typescript
 * try {
 *   factory.setOverride(() => mockService);
 * } catch (e) {
 *   if (e instanceof ProductionGuardError) {
 *     console.error(`Factory ${e.factoryName} cannot be overridden in production`);
 *   }
 * }
 * ```
 */
export class ProductionGuardError extends Error {
  /** オーバーライドしようとしたファクトリ名 */
  public readonly factoryName: string;

  constructor(factoryName: string) {
    super(`DI Factory override is not allowed in production environment: ${factoryName}`);
    this.name = 'ProductionGuardError';
    this.factoryName = factoryName;
    // V8環境でスタックトレースを正しく保持
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ProductionGuardError);
    }
  }
}

// =====================================================
// 環境判定関数
// =====================================================

/**
 * 現在の環境が本番環境かどうかを判定
 *
 * NODE_ENV環境変数を検査し、'production'と完全一致する場合にtrueを返します。
 * 未設定の場合やその他の値の場合はfalseを返します。
 *
 * @returns NODE_ENV === 'production' の場合 true
 */
export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === NODE_ENV_PRODUCTION;
}

/**
 * 開発環境かどうかを判定（ログ出力判定用）
 */
export function isDevelopmentEnvironment(): boolean {
  return process.env.NODE_ENV === NODE_ENV_DEVELOPMENT;
}

// =====================================================
// ガード関数
// =====================================================

/**
 * 本番環境でないことを保証する
 *
 * DI Factoryのオーバーライド操作前に呼び出すガード関数です。
 * 本番環境で呼び出された場合はProductionGuardErrorをスローします。
 *
 * @param factoryName ファクトリ名（エラーメッセージ用）
 * @throws ProductionGuardError 本番環境で呼び出された場合
 */
export function assertNonProductionFactory(factoryName: string): void {
  if (isProductionEnvironment()) {
    throw new ProductionGuardError(factoryName);
  }
}

// =====================================================
// ファクトリラッパー
// =====================================================

/**
 * 本番環境で安全なファクトリラッパー
 *
 * 開発/テスト環境ではオーバーライドを許可し、
 * 本番環境ではデフォルトファクトリのみを使用する。
 *
 * @template T ファクトリが返すサービスの型
 */
export interface ProductionSafeFactory<T> {
  /**
   * 現在のファクトリを取得
   * オーバーライドがあればそれを使用、なければデフォルト
   */
  get: () => T;

  /**
   * カスタムファクトリでオーバーライド
   * 本番環境ではProductionGuardErrorをスロー
   */
  setOverride: (factory: () => T) => void;

  /**
   * オーバーライドをクリアしデフォルトに戻す
   */
  clearOverride: () => void;

  /**
   * オーバーライドが設定されているかどうか
   */
  hasOverride: () => boolean;
}

/**
 * 本番環境で安全なファクトリを作成
 *
 * このファクトリラッパーは以下のセキュリティ特性を持ちます：
 * - 本番環境ではsetOverride()がProductionGuardErrorをスロー
 * - 本番環境ではget()が常にデフォルトファクトリを使用
 * - 開発/テスト環境ではオーバーライドが自由に可能
 *
 * @template T ファクトリが返すサービスの型
 * @param name ファクトリ名（ログ・エラーメッセージ用）
 * @param defaultFactory デフォルトのファクトリ関数
 * @returns 本番環境で安全なファクトリラッパー
 *
 * @example
 * ```typescript
 * const embeddingFactory = createProductionSafeFactory(
 *   'embeddingService',
 *   () => new RealEmbeddingService()
 * );
 *
 * // テスト環境でのモック注入
 * embeddingFactory.setOverride(() => mockEmbeddingService);
 *
 * // ファクトリの取得（オーバーライドがあればそれを使用）
 * const service = embeddingFactory.get();
 * ```
 */
export function createProductionSafeFactory<T>(
  name: string,
  defaultFactory: () => T
): ProductionSafeFactory<T> {
  let overrideFactory: (() => T) | null = null;

  return {
    get(): T {
      // 本番環境またはオーバーライド未設定時はデフォルトを使用
      if (overrideFactory === null || isProductionEnvironment()) {
        return defaultFactory();
      }
      // 非本番環境でオーバーライドがある場合はそれを使用
      return overrideFactory();
    },

    setOverride(factory: () => T): void {
      // 本番環境ではオーバーライドを禁止
      assertNonProductionFactory(name);

      overrideFactory = factory;
      if (isDevelopmentEnvironment()) {
        logger.debug(`[ProductionSafeFactory] Override set for: ${name}`);
      }
    },

    clearOverride(): void {
      overrideFactory = null;
      if (isDevelopmentEnvironment()) {
        logger.debug(`[ProductionSafeFactory] Override cleared for: ${name}`);
      }
    },

    hasOverride(): boolean {
      return overrideFactory !== null;
    },
  };
}

// =====================================================
// 認証強制ガード (MCP-AUTH-01)
// =====================================================

/**
 * 本番環境でのMCP認証無効化エラー
 *
 * このエラーは本番環境で認証が無効化されている場合にスローされます。
 * セキュリティ上の理由から、本番環境ではMCP認証は必須です。
 *
 * @example
 * ```typescript
 * try {
 *   assertProductionAuthEnabled();
 * } catch (e) {
 *   if (e instanceof ProductionAuthRequiredError) {
 *     console.error('Production requires authentication');
 *     process.exit(1);
 *   }
 * }
 * ```
 */
export class ProductionAuthRequiredError extends Error {
  constructor() {
    super('MCP authentication is required in production environment');
    this.name = 'ProductionAuthRequiredError';
    // V8環境でスタックトレースを正しく保持
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ProductionAuthRequiredError);
    }
  }
}

/**
 * 本番環境でMCP認証が有効かどうかをチェック
 *
 * @returns MCP_AUTH_ENABLED=true の場合 true
 */
export function isMcpAuthEnabled(): boolean {
  return process.env.MCP_AUTH_ENABLED === 'true';
}

/**
 * 本番環境での安全でない起動を許可するかどうかをチェック
 *
 * 注意: この環境変数は緊急時の回避策としてのみ使用すべきです。
 * セキュリティリスクが高いため、通常は設定しないでください。
 *
 * @returns MCP_ALLOW_INSECURE_PRODUCTION=true の場合 true
 */
export function isInsecureProductionAllowed(): boolean {
  return process.env.MCP_ALLOW_INSECURE_PRODUCTION === 'true';
}

// =====================================================
// 必須カテゴリ初期化強制 (P1-SEC-INIT-01)
// =====================================================

/**
 * 本番環境で必須カテゴリが未初期化の場合にスローされるエラー
 *
 * このエラーは本番環境で必須カテゴリ（Layout, Motion, Quality等）が
 * 初期化されていない状態でサーバー起動を試みた際にスローされます。
 *
 * @example
 * ```typescript
 * try {
 *   assertProductionRequiredCategoriesInitialized(['Motion', 'Layout'], ['Motion']);
 * } catch (e) {
 *   if (e instanceof ProductionCategoryRequiredError) {
 *     console.error(`Missing categories: ${e.missingCategories.join(', ')}`);
 *     process.exit(1);
 *   }
 * }
 * ```
 */
export class ProductionCategoryRequiredError extends Error {
  /** 初期化されていない必須カテゴリ */
  public readonly missingCategories: string[];

  constructor(missingCategories: string[]) {
    super(
      `Production requires all categories: missing ${missingCategories.join(', ')}`
    );
    this.name = 'ProductionCategoryRequiredError';
    this.missingCategories = missingCategories;
    // V8環境でスタックトレースを正しく保持
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ProductionCategoryRequiredError);
    }
  }
}

/**
 * 本番環境で必須とされるサービスカテゴリ
 *
 * これらのカテゴリは本番環境で必ず初期化されている必要があります。
 * いずれかが欠けている場合、サーバー起動が失敗します。
 */
export const REQUIRED_CATEGORIES_FOR_PRODUCTION = [
  'motion',
  'layout',
  'quality',
  'page',
] as const;

/**
 * 本番環境で全必須カテゴリが初期化されていることを保証するガード関数
 *
 * 本番環境（NODE_ENV=production）で以下の条件をチェック:
 * 1. REQUIRED_CATEGORIES_FOR_PRODUCTION の全カテゴリが初期化されていなければエラー
 * 2. 開発環境では警告のみで続行
 *
 * @param initializedCategories 初期化済みカテゴリのリスト
 * @throws ProductionCategoryRequiredError 本番環境で必須カテゴリが未初期化の場合
 *
 * @example
 * ```typescript
 * // サービス初期化完了後に呼び出し
 * try {
 *   assertProductionRequiredCategoriesInitialized(['motion', 'layout']);
 *   // 'quality' と 'page' が欠けているのでエラー
 * } catch (e) {
 *   logger.error('FATAL: Missing required service categories');
 *   process.exit(1);
 * }
 * ```
 */
export function assertProductionRequiredCategoriesInitialized(
  initializedCategories: string[]
): void {
  const missingCategories = REQUIRED_CATEGORIES_FOR_PRODUCTION.filter(
    (category) => !initializedCategories.includes(category)
  );

  // 必須カテゴリがすべて初期化されていれば何もしない
  if (missingCategories.length === 0) {
    return;
  }

  // 本番環境では必須カテゴリ未初期化でエラー
  if (isProductionEnvironment()) {
    logger.error('============================================================');
    logger.error('FATAL: Required service categories are not initialized.');
    logger.error(`  Missing: ${missingCategories.join(', ')}`);
    logger.error('  Server cannot start without all required categories.');
    logger.error('');
    logger.error('To fix this issue:');
    logger.error('  1. Ensure all required dependencies are available');
    logger.error('  2. Check embeddingService and prisma client configuration');
    logger.error('  3. Verify webPageService is provided for layout.inspect');
    logger.error('============================================================');

    throw new ProductionCategoryRequiredError(missingCategories);
  }

  // 開発環境では警告のみ（既存の動作と同様）
  if (isDevelopmentEnvironment()) {
    logger.debug(
      `[ProductionGuard] Missing categories in development: ${missingCategories.join(', ')}`
    );
  }
}

/**
 * 本番環境でMCP認証が有効であることを保証するガード関数
 *
 * 本番環境（NODE_ENV=production）で以下の条件をチェック:
 * 1. MCP_AUTH_ENABLED=true でなければエラー
 * 2. MCP_ALLOW_INSECURE_PRODUCTION=true の場合は警告付きで許可
 *
 * @throws ProductionAuthRequiredError 本番環境で認証が無効かつ回避オプションがない場合
 *
 * @example
 * ```typescript
 * // サーバー起動時に呼び出し
 * try {
 *   assertProductionAuthEnabled();
 *   logger.info('Production auth check passed');
 * } catch (e) {
 *   logger.error('FATAL: Server cannot start without authentication');
 *   process.exit(1);
 * }
 * ```
 */
export function assertProductionAuthEnabled(): void {
  // 非本番環境では何もしない
  if (!isProductionEnvironment()) {
    return;
  }

  // 認証が有効な場合はOK
  if (isMcpAuthEnabled()) {
    return;
  }

  // 明示的に安全でない起動を許可している場合は警告付きで続行
  if (isInsecureProductionAllowed()) {
    logger.warn('============================================================');
    logger.warn('SECURITY WARNING: Running production WITHOUT authentication!');
    logger.warn('MCP_ALLOW_INSECURE_PRODUCTION=true is set.');
    logger.warn('This is a CRITICAL security risk. Do NOT use in real production.');
    logger.warn('Anyone can access the MCP server without authentication.');
    logger.warn('============================================================');
    return;
  }

  // 本番環境で認証が無効かつ回避オプションがない場合はエラー
  logger.error('============================================================');
  logger.error('FATAL: MCP_AUTH_ENABLED must be set to "true" in production.');
  logger.error('Server will not start without authentication enabled.');
  logger.error('');
  logger.error('To fix this issue:');
  logger.error('  1. Set MCP_AUTH_ENABLED=true');
  logger.error('  2. Configure MCP_API_KEYS with valid API keys');
  logger.error('');
  logger.error('For emergency bypass (NOT RECOMMENDED):');
  logger.error('  Set MCP_ALLOW_INSECURE_PRODUCTION=true');
  logger.error('============================================================');

  throw new ProductionAuthRequiredError();
}
