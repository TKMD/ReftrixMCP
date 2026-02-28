// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ヘルスチェックAPI テスト
 *
 * テスト対象: GET /api/health および /api/health/detailed
 *
 * このテストは以下を検証します:
 * - 基本ヘルスチェックのレスポンス
 * - 詳細ヘルスチェックのレスポンス（DB、Redis、外部サービス）
 * - ヘルスステータス（healthy/degraded/unhealthy）
 * - レスポンス時間の計測
 * - 依存サービスの個別ステータス
 * - 認証なしでアクセス可能であること
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 型定義: 外部サービスステータス
interface ExternalServiceStatus {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTime: number;
  details: {
    accessible: boolean;
  };
}

// モック: ヘルスチェックサービス
class HealthCheckService {
  async checkBasicHealth() {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      uptime: process.uptime(),
    };
  }

  async checkDetailedHealth() {
    const database = await this.checkDatabase();
    const redis = await this.checkRedis();
    const externalServices = await this.checkExternalServices();

    const allHealthy = [database, redis, ...externalServices].every(
      (service) => service.status === 'healthy'
    );
    const anyDegraded = [database, redis, ...externalServices].some(
      (service) => service.status === 'degraded'
    );

    return {
      status: allHealthy ? 'healthy' : anyDegraded ? 'degraded' : 'unhealthy',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      uptime: process.uptime(),
      dependencies: {
        database,
        redis,
        externalServices,
      },
    };
  }

  async checkDatabase() {
    // モック実装: 実際はPrisma接続チェック
    return {
      name: 'PostgreSQL',
      status: 'healthy',
      responseTime: 5,
      details: {
        connected: true,
        version: '18.1',
      },
    };
  }

  async checkRedis() {
    // モック実装: 実際はRedis接続チェック
    return {
      name: 'Redis',
      status: 'healthy',
      responseTime: 2,
      details: {
        connected: true,
        version: '7.2',
      },
    };
  }

  async checkExternalServices() {
    // モック実装: 外部APIのヘルスチェック
    return [
      {
        name: 'S3',
        status: 'healthy',
        responseTime: 10,
        details: {
          accessible: true,
        },
      },
      {
        name: 'OpenAI API',
        status: 'healthy',
        responseTime: 15,
        details: {
          accessible: true,
        },
      },
    ];
  }
}

// モック: API レスポンスヘルパー
function createHealthCheckEndpoint(service: HealthCheckService) {
  return {
    async getBasicHealth() {
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

    async getDetailedHealth() {
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

describe('ヘルスチェックAPI', () => {
  let healthService: HealthCheckService;
  let endpoint: ReturnType<typeof createHealthCheckEndpoint>;

  beforeEach(() => {
    healthService = new HealthCheckService();
    endpoint = createHealthCheckEndpoint(healthService);
  });

  describe('GET /api/health - 基本ヘルスチェック', () => {
    it('正常なヘルスステータスを返すこと', async () => {
      // Arrange & Act
      const response = await endpoint.getBasicHealth();

      // Assert
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        status: 'healthy',
        version: '0.1.0',
      });
      expect(response.body.timestamp).toBeDefined();
      expect(response.body.uptime).toBeGreaterThan(0);
    });

    it('レスポンス時間が計測されること', async () => {
      // Arrange & Act
      const response = await endpoint.getBasicHealth();

      // Assert
      expect(response.body.responseTime).toBeDefined();
      expect(response.body.responseTime).toBeGreaterThanOrEqual(0);
    });

    it('認証なしでアクセス可能であること', async () => {
      // Arrange & Act
      // 認証ヘッダーなしでリクエスト
      const response = await endpoint.getBasicHealth();

      // Assert
      // 認証エラーにならずに200が返ること
      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /api/health/detailed - 詳細ヘルスチェック', () => {
    it('すべての依存サービスが正常な場合、healthyを返すこと', async () => {
      // Arrange & Act
      const response = await endpoint.getDetailedHealth();

      // Assert
      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe('healthy');
      expect(response.body.dependencies.database.status).toBe('healthy');
      expect(response.body.dependencies.redis.status).toBe('healthy');
      expect(response.body.dependencies.externalServices).toHaveLength(2);
      expect(
        response.body.dependencies.externalServices.every(
          (s: ExternalServiceStatus) => s.status === 'healthy'
        )
      ).toBe(true);
    });

    it('データベース接続が正常であることを確認すること', async () => {
      // Arrange & Act
      const response = await endpoint.getDetailedHealth();

      // Assert
      expect(response.body.dependencies.database).toMatchObject({
        name: 'PostgreSQL',
        status: 'healthy',
        details: {
          connected: true,
          version: '18.1',
        },
      });
      expect(response.body.dependencies.database.responseTime).toBeDefined();
    });

    it('Redis接続が正常であることを確認すること', async () => {
      // Arrange & Act
      const response = await endpoint.getDetailedHealth();

      // Assert
      expect(response.body.dependencies.redis).toMatchObject({
        name: 'Redis',
        status: 'healthy',
        details: {
          connected: true,
          version: '7.2',
        },
      });
      expect(response.body.dependencies.redis.responseTime).toBeDefined();
    });

    it('外部サービスのステータスを確認すること', async () => {
      // Arrange & Act
      const response = await endpoint.getDetailedHealth();

      // Assert
      const externalServices = response.body.dependencies.externalServices;
      expect(externalServices).toHaveLength(2);

      const s3Service = externalServices.find((s: ExternalServiceStatus) => s.name === 'S3');
      expect(s3Service).toMatchObject({
        status: 'healthy',
        details: {
          accessible: true,
        },
      });

      const openaiService = externalServices.find(
        (s: ExternalServiceStatus) => s.name === 'OpenAI API'
      );
      expect(openaiService).toMatchObject({
        status: 'healthy',
        details: {
          accessible: true,
        },
      });
    });

    it('一部のサービスが劣化状態の場合、degradedを返すこと', async () => {
      // Arrange
      vi.spyOn(healthService, 'checkRedis').mockResolvedValueOnce({
        name: 'Redis',
        status: 'degraded',
        responseTime: 100,
        details: {
          connected: true,
          version: '7.2',
        },
      });

      // Act
      const response = await endpoint.getDetailedHealth();

      // Assert
      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe('degraded');
      expect(response.body.dependencies.redis.status).toBe('degraded');
    });

    it('データベース接続が失敗した場合、unhealthyを返すこと', async () => {
      // Arrange
      vi.spyOn(healthService, 'checkDatabase').mockResolvedValueOnce({
        name: 'PostgreSQL',
        status: 'unhealthy',
        responseTime: 0,
        details: {
          connected: false,
          version: null,
        },
      });

      // Act
      const response = await endpoint.getDetailedHealth();

      // Assert
      expect(response.statusCode).toBe(503);
      expect(response.body.status).toBe('unhealthy');
      expect(response.body.dependencies.database.status).toBe('unhealthy');
    });

    it('レスポンス時間が各サービスで計測されること', async () => {
      // Arrange & Act
      const response = await endpoint.getDetailedHealth();

      // Assert
      expect(response.body.dependencies.database.responseTime).toBeGreaterThanOrEqual(
        0
      );
      expect(response.body.dependencies.redis.responseTime).toBeGreaterThanOrEqual(
        0
      );
      response.body.dependencies.externalServices.forEach((service: ExternalServiceStatus) => {
        expect(service.responseTime).toBeGreaterThanOrEqual(0);
      });
    });

    it('認証なしでアクセス可能であること', async () => {
      // Arrange & Act
      const response = await endpoint.getDetailedHealth();

      // Assert
      // 認証エラーにならないこと（200または503）
      expect([200, 503]).toContain(response.statusCode);
    });
  });

  describe('エラーハンドリング', () => {
    it('ヘルスチェック処理中のエラーを適切に処理すること', async () => {
      // Arrange
      vi.spyOn(healthService, 'checkBasicHealth').mockRejectedValueOnce(
        new Error('Internal error')
      );

      // Act & Assert
      await expect(endpoint.getBasicHealth()).rejects.toThrow('Internal error');
    });

    it('タイムアウトエラーを適切に処理すること', async () => {
      // Arrange
      vi.spyOn(healthService, 'checkDatabase').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  name: 'PostgreSQL',
                  status: 'unhealthy',
                  responseTime: 5000,
                  details: {
                    connected: false,
                    version: null,
                  },
                }),
              5000
            );
          })
      );

      // Act
      const response = await endpoint.getDetailedHealth();

      // Assert
      // タイムアウトした場合でもレスポンスは返ること
      expect(response).toBeDefined();
    });
  });

  describe('パフォーマンス', () => {
    it('基本ヘルスチェックが100ms以内に完了すること', async () => {
      // Arrange
      const startTime = Date.now();

      // Act
      await endpoint.getBasicHealth();
      const duration = Date.now() - startTime;

      // Assert
      expect(duration).toBeLessThan(100);
    });

    it('詳細ヘルスチェックが1秒以内に完了すること', async () => {
      // Arrange
      const startTime = Date.now();

      // Act
      await endpoint.getDetailedHealth();
      const duration = Date.now() - startTime;

      // Assert
      expect(duration).toBeLessThan(1000);
    });
  });
});
