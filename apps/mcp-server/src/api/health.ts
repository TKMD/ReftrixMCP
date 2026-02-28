// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ヘルスチェックAPI
 *
 * データベース、Redis、外部サービスの接続状態を確認し、
 * システム全体のヘルスステータスを提供します。
 *
 * ステータス:
 * - healthy: 全サービス正常
 * - degraded: 一部サービスに問題
 * - unhealthy: 重要サービスがダウン
 */

import { createLogger } from '../utils/logger';

const healthLogger = createLogger('HealthCheck');

/**
 * サービスヘルスの詳細情報
 */
export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTime: number;
  details: Record<string, unknown>;
}

/**
 * 基本ヘルスチェックレスポンス
 */
export interface BasicHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime: number;
}

/**
 * 詳細ヘルスチェックレスポンス
 */
export interface DetailedHealthResponse extends BasicHealthResponse {
  dependencies: {
    database: ServiceHealth;
    redis: ServiceHealth;
    externalServices: ServiceHealth[];
  };
}

/**
 * データベース接続チェッカーのインターフェース
 */
export interface DatabaseChecker {
  checkConnection(): Promise<{ connected: boolean; version: string | null }>;
}

/**
 * Redisチェッカーのインターフェース
 */
export interface RedisChecker {
  checkConnection(): Promise<{ connected: boolean; version: string | null }>;
}

/**
 * 外部サービスチェッカーのインターフェース
 */
export interface ExternalServiceChecker {
  name: string;
  checkHealth(): Promise<{ accessible: boolean; details?: Record<string, unknown> }>;
}

/**
 * ヘルスチェックサービスの設定
 */
export interface HealthCheckConfig {
  version: string;
  databaseChecker?: DatabaseChecker;
  redisChecker?: RedisChecker;
  externalServiceCheckers?: ExternalServiceChecker[];
}

/**
 * デフォルトのデータベースチェッカー（モック）
 */
class DefaultDatabaseChecker implements DatabaseChecker {
  async checkConnection(): Promise<{ connected: boolean; version: string | null }> {
    // 実際の実装ではPrismaクライアントを使用
    return {
      connected: true,
      version: '18.1',
    };
  }
}

/**
 * デフォルトのRedisチェッカー（モック）
 */
class DefaultRedisChecker implements RedisChecker {
  async checkConnection(): Promise<{ connected: boolean; version: string | null }> {
    // 実際の実装ではRedisクライアントを使用
    return {
      connected: true,
      version: '7.2',
    };
  }
}

/**
 * デフォルトの外部サービスチェッカー
 */
class DefaultExternalServiceChecker implements ExternalServiceChecker {
  constructor(public name: string) {}

  async checkHealth(): Promise<{ accessible: boolean; details?: Record<string, unknown> }> {
    // 実際の実装ではHTTPリクエストを送信
    return {
      accessible: true,
    };
  }
}

/**
 * ヘルスチェックサービス
 *
 * システム全体のヘルス状態を監視し、レポートします。
 */
export class HealthCheckService {
  private version: string;
  private databaseChecker: DatabaseChecker;
  private redisChecker: RedisChecker;
  private externalServiceCheckers: ExternalServiceChecker[];

  constructor(config?: HealthCheckConfig) {
    this.version = config?.version ?? '0.1.0';
    this.databaseChecker = config?.databaseChecker ?? new DefaultDatabaseChecker();
    this.redisChecker = config?.redisChecker ?? new DefaultRedisChecker();
    this.externalServiceCheckers = config?.externalServiceCheckers ?? [
      new DefaultExternalServiceChecker('S3'),
      new DefaultExternalServiceChecker('OpenAI API'),
    ];
  }

  /**
   * 基本ヘルスチェックを実行
   */
  async checkBasicHealth(): Promise<BasicHealthResponse> {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: this.version,
      uptime: process.uptime(),
    };
  }

  /**
   * 詳細ヘルスチェックを実行
   */
  async checkDetailedHealth(): Promise<DetailedHealthResponse> {
    const database = await this.checkDatabase();
    const redis = await this.checkRedis();
    const externalServices = await this.checkExternalServices();

    // ステータス判定
    const allServices = [database, redis, ...externalServices];
    const hasUnhealthy = allServices.some((s) => s.status === 'unhealthy');
    const hasDegraded = allServices.some((s) => s.status === 'degraded');

    let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
    if (hasUnhealthy) {
      overallStatus = 'unhealthy';
    } else if (hasDegraded) {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'healthy';
    }

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: this.version,
      uptime: process.uptime(),
      dependencies: {
        database,
        redis,
        externalServices,
      },
    };
  }

  /**
   * データベース接続をチェック
   */
  async checkDatabase(): Promise<ServiceHealth> {
    const startTime = Date.now();

    try {
      const result = await this.databaseChecker.checkConnection();
      const responseTime = Date.now() - startTime;

      return {
        name: 'PostgreSQL',
        status: result.connected ? 'healthy' : 'unhealthy',
        responseTime,
        details: {
          connected: result.connected,
          version: result.version,
        },
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      healthLogger.error('Database check failed', error);

      return {
        name: 'PostgreSQL',
        status: 'unhealthy',
        responseTime,
        details: {
          connected: false,
          version: null,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * Redis接続をチェック
   */
  async checkRedis(): Promise<ServiceHealth> {
    const startTime = Date.now();

    try {
      const result = await this.redisChecker.checkConnection();
      const responseTime = Date.now() - startTime;

      return {
        name: 'Redis',
        status: result.connected ? 'healthy' : 'unhealthy',
        responseTime,
        details: {
          connected: result.connected,
          version: result.version,
        },
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      healthLogger.error('Redis check failed', error);

      return {
        name: 'Redis',
        status: 'unhealthy',
        responseTime,
        details: {
          connected: false,
          version: null,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * 外部サービスをチェック
   */
  async checkExternalServices(): Promise<ServiceHealth[]> {
    const results: ServiceHealth[] = [];

    for (const checker of this.externalServiceCheckers) {
      const startTime = Date.now();

      try {
        const result = await checker.checkHealth();
        const responseTime = Date.now() - startTime;

        results.push({
          name: checker.name,
          status: result.accessible ? 'healthy' : 'unhealthy',
          responseTime,
          details: {
            accessible: result.accessible,
            ...result.details,
          },
        });
      } catch (error) {
        const responseTime = Date.now() - startTime;

        healthLogger.error(`External service ${checker.name} check failed`, error);

        results.push({
          name: checker.name,
          status: 'unhealthy',
          responseTime,
          details: {
            accessible: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }
    }

    return results;
  }
}

/**
 * ヘルスチェックエンドポイントのレスポンス型
 */
export interface HealthCheckEndpoint {
  getBasicHealth(): Promise<{
    statusCode: number;
    body: BasicHealthResponse & { responseTime: number };
  }>;
  getDetailedHealth(): Promise<{
    statusCode: number;
    body: DetailedHealthResponse & { responseTime: number };
  }>;
}

/**
 * ヘルスチェックエンドポイントファクトリ
 *
 * HealthCheckServiceをラップしてHTTPレスポンス形式を提供
 */
export function createHealthCheckEndpoint(service: HealthCheckService): HealthCheckEndpoint {
  return {
    /**
     * 基本ヘルスチェック（GET /api/health）
     */
    async getBasicHealth(): Promise<{
      statusCode: number;
      body: BasicHealthResponse & { responseTime: number };
    }> {
      const startTime = Date.now();
      const health = await service.checkBasicHealth();
      const responseTime = Date.now() - startTime;

      return {
        statusCode: 200,
        body: {
          ...health,
          responseTime,
        },
      };
    },

    /**
     * 詳細ヘルスチェック（GET /api/health/detailed）
     */
    async getDetailedHealth(): Promise<{
      statusCode: number;
      body: DetailedHealthResponse & { responseTime: number };
    }> {
      const startTime = Date.now();
      const health = await service.checkDetailedHealth();
      const responseTime = Date.now() - startTime;

      return {
        statusCode: health.status === 'unhealthy' ? 503 : 200,
        body: {
          ...health,
          responseTime,
        },
      };
    },
  };
}

// デフォルトエクスポート
export default HealthCheckService;
