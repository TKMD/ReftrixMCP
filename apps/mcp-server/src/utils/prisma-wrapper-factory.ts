// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prisma Wrapper Factory
 * IPrismaClient インターフェースに適合するラッパーを生成するユーティリティ
 *
 * 目的:
 * - index.ts での重複コード削減（38行 → 12行）
 * - Layout/Motion 両方で共通化
 * - テスト可能性向上
 *
 * @module utils/prisma-wrapper-factory
 */

// =====================================================
// 型定義
// =====================================================

/**
 * サポートされるテーブル名
 */
export type SupportedTableName =
  | 'sectionPattern'
  | 'sectionEmbedding'
  | 'motionPattern'
  | 'motionEmbedding'
  | 'motionAnalysisResult'
  | 'motionAnalysisEmbedding'
  | 'webPage'
  | 'qualityEvaluation'
  | 'qualityBenchmark'
  | 'jSAnimationPattern'
  | 'jSAnimationEmbedding'
  | 'backgroundDesignEmbedding';

/**
 * テーブルラッパー設定
 */
export interface TableWrapperConfig {
  tableName: SupportedTableName;
}

/**
 * Prismaラッパー設定
 */
export interface PrismaWrapperConfig {
  /** ラップするテーブル名の配列 */
  tables: SupportedTableName[];
  /** トランザクションをサポートするか */
  supportsTransaction: boolean;
}

/**
 * ラップされたテーブル（create/createMany/upsert/deleteMany/findUnique/findManyメソッドをサポート）
 */
export interface WrappedTable {
  create: (args: { data: unknown }) => Promise<{ id: string }>;
  createMany?: (args: { data: unknown[] }) => Promise<{ count: number }>;
  upsert?: (args: { where: unknown; create: unknown; update: unknown }) => Promise<{ id: string }>;
  deleteMany?: (args: { where: unknown }) => Promise<{ count: number }>;
  findUnique?: (args: { where: unknown; include?: unknown }) => Promise<unknown | null>;
  findMany?: (args: { where: unknown; include?: unknown }) => Promise<unknown[]>;
}

/**
 * テーブルの最小インターフェース
 * 注: anyを使用しているのは、実際のPrismaClientのcreate引数が
 * 非常に複雑で、ジェネリクスやSelectSubset等の型を含むため
 */
interface MinimalTable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create: (...args: any[]) => Promise<{ id: string } | any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createMany?: (...args: any[]) => Promise<{ count: number } | any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upsert?: (...args: any[]) => Promise<{ id: string } | any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deleteMany?: (...args: any[]) => Promise<{ count: number } | any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findUnique?: (...args: any[]) => Promise<any | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findMany?: (...args: any[]) => Promise<any[]>;
}

/**
 * Prismaトランザクションオプション
 */
export interface TransactionOptions {
  /** 接続取得の最大待機時間（ミリ秒） */
  maxWait?: number;
  /** トランザクションの最大実行時間（ミリ秒） */
  timeout?: number;
  /** 分離レベル */
  isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
}

/**
 * Prismaクライアントの最小インターフェース
 */
interface MinimalPrismaClient {
  sectionPattern?: MinimalTable;
  sectionEmbedding?: MinimalTable;
  motionPattern?: MinimalTable;
  motionEmbedding?: MinimalTable;
  motionAnalysisResult?: MinimalTable;
  motionAnalysisEmbedding?: MinimalTable;
  webPage?: MinimalTable;
  qualityEvaluation?: MinimalTable;
  qualityBenchmark?: MinimalTable;
  jSAnimationPattern?: MinimalTable;
  jSAnimationEmbedding?: MinimalTable;
  backgroundDesignEmbedding?: MinimalTable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $executeRawUnsafe: (...args: any[]) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRawUnsafe: (...args: any[]) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction?: <T>(fn: (tx: any) => Promise<T>, options?: TransactionOptions) => Promise<T>;
}

// =====================================================
// ファクトリ関数
// =====================================================

/**
 * 単一テーブルのcreateメソッドをラップする
 *
 * @param prisma - PrismaClient
 * @param tableName - テーブル名
 * @returns createメソッドがidのみ返すラッパー
 *
 * @example
 * const wrapper = createTableWrapper(prisma, 'sectionPattern');
 * const { id } = await wrapper.create({ data: {...} });
 */
export function createTableWrapper<T extends MinimalPrismaClient>(
  prisma: T,
  tableName: SupportedTableName
): WrappedTable {
  const table = prisma[tableName];

  if (!table) {
    throw new Error(`Table '${tableName}' not found in PrismaClient`);
  }

  const wrapper: WrappedTable = {
    create: async (args: { data: unknown }): Promise<{ id: string }> => {
      const result = await table.create(args as Parameters<typeof table.create>[0]);
      return { id: result.id };
    },
  };

  // createMany が利用可能な場合のみラップ
  if (table.createMany) {
    wrapper.createMany = async (args: { data: unknown[] }): Promise<{ count: number }> => {
      const result = await table.createMany!(args as Parameters<NonNullable<typeof table.createMany>>[0]);
      return { count: result.count };
    };
  }

  // upsert が利用可能な場合のみラップ
  if (table.upsert) {
    wrapper.upsert = async (args: { where: unknown; create: unknown; update: unknown }): Promise<{ id: string }> => {
      const result = await table.upsert!(args as Parameters<NonNullable<typeof table.upsert>>[0]);
      return { id: result.id };
    };
  }

  // deleteMany が利用可能な場合のみラップ
  if (table.deleteMany) {
    wrapper.deleteMany = async (args: { where: unknown }): Promise<{ count: number }> => {
      const result = await table.deleteMany!(args as Parameters<NonNullable<typeof table.deleteMany>>[0]);
      return { count: result.count };
    };
  }

  // findUnique が利用可能な場合のみラップ
  if (table.findUnique) {
    wrapper.findUnique = async (args: { where: unknown; include?: unknown }): Promise<unknown | null> => {
      const result = await table.findUnique!(args as Parameters<NonNullable<typeof table.findUnique>>[0]);
      return result;
    };
  }

  // findMany が利用可能な場合のみラップ
  if (table.findMany) {
    wrapper.findMany = async (args: { where: unknown; include?: unknown }): Promise<unknown[]> => {
      const result = await table.findMany!(args as Parameters<NonNullable<typeof table.findMany>>[0]);
      return result;
    };
  }

  return wrapper;
}

/**
 * IPrismaClient互換のラッパーを生成する
 *
 * @param prisma - PrismaClient
 * @param config - ラッパー設定
 * @returns IPrismaClient互換のオブジェクト
 *
 * @example
 * // Layout用（トランザクションなし）
 * const layoutWrapper = createPrismaWrapper(prisma, {
 *   tables: ['sectionPattern', 'sectionEmbedding'],
 *   supportsTransaction: false,
 * });
 *
 * // Motion用（トランザクションあり）
 * const motionWrapper = createPrismaWrapper(prisma, {
 *   tables: ['motionPattern', 'motionEmbedding'],
 *   supportsTransaction: true,
 * });
 */
export function createPrismaWrapper<T extends MinimalPrismaClient>(
  prisma: T,
  config: PrismaWrapperConfig
): Record<string, unknown> {
  const wrapper: Record<string, unknown> = {};

  // 各テーブルのラッパーを生成
  for (const tableName of config.tables) {
    wrapper[tableName] = createTableWrapper(prisma, tableName);
  }

  // $executeRawUnsafe をバインド
  wrapper.$executeRawUnsafe = prisma.$executeRawUnsafe.bind(prisma);

  // $queryRawUnsafe をバインド（ベクトル検索等で使用）
  wrapper.$queryRawUnsafe = prisma.$queryRawUnsafe.bind(prisma);

  // トランザクションサポート
  if (config.supportsTransaction) {
    wrapper.$transaction = async <R>(
      fn: (tx: Record<string, unknown>) => Promise<R>,
      options?: TransactionOptions
    ): Promise<R> => {
      if (!prisma.$transaction) {
        throw new Error('PrismaClient does not support transactions');
      }

      return prisma.$transaction(async (tx) => {
        const txPrisma = tx as MinimalPrismaClient;

        // トランザクション用のラッパーを生成
        const txWrapper: Record<string, unknown> = {};

        for (const tableName of config.tables) {
          txWrapper[tableName] = createTableWrapper(txPrisma, tableName);
        }

        txWrapper.$executeRawUnsafe = txPrisma.$executeRawUnsafe.bind(txPrisma);
        txWrapper.$queryRawUnsafe = txPrisma.$queryRawUnsafe.bind(txPrisma);

        // ネストされたトランザクションを防止
        txWrapper.$transaction = async (): Promise<never> => {
          throw new Error('Nested transactions not supported');
        };

        return fn(txWrapper);
      }, options);
    };
  }

  return wrapper;
}
