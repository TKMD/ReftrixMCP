// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP統一レスポンス形式テスト
 *
 * TDD Red Phase: 統一レスポンス形式のテスト
 *
 * テスト対象:
 * 1. 成功レスポンス作成
 * 2. エラーレスポンス作成
 * 3. 型ガード関数
 * 4. メタデータヘルパー
 * 5. Zodスキーマバリデーション
 * 6. セキュリティ（開発環境のみdetails含める）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSuccessResponse,
  createErrorResponse,
  isSuccessResponse,
  isErrorResponse,
  withProcessingTime,
  withPagination,
  withOptimizationMode,
  withTruncation,
  createSuccessResponseSchema,
  mcpErrorResponseSchema,
  createMcpResponseSchema,
  type McpResponse,
  type McpSuccessResponse,
  type McpErrorResponse,
  type McpResponseMetadata,
  type OptimizationMode,
} from '../../src/utils/mcp-response';
import { ErrorCode } from '../../src/utils/errors';
import { z } from 'zod';

// =============================================================================
// 成功レスポンス作成テスト
// =============================================================================

describe('createSuccessResponse', () => {
  it('データのみで成功レスポンスを作成できること', () => {
    // Arrange
    const data = { id: '123', name: 'test' };

    // Act
    const response = createSuccessResponse(data);

    // Assert
    expect(response.success).toBe(true);
    expect(response.data).toEqual(data);
    expect(response.metadata).toBeUndefined();
  });

  it('メタデータ付きで成功レスポンスを作成できること', () => {
    // Arrange
    const data = { results: [1, 2, 3] };
    const metadata: McpResponseMetadata = {
      processing_time_ms: 42,
      optimization_mode: 'full',
    };

    // Act
    const response = createSuccessResponse(data, metadata);

    // Assert
    expect(response.success).toBe(true);
    expect(response.data).toEqual(data);
    expect(response.metadata).toEqual(metadata);
  });

  it('配列データで成功レスポンスを作成できること', () => {
    // Arrange
    const data = [{ id: '1' }, { id: '2' }];

    // Act
    const response = createSuccessResponse(data);

    // Assert
    expect(response.success).toBe(true);
    expect(response.data).toHaveLength(2);
  });

  it('nullデータで成功レスポンスを作成できること', () => {
    // Arrange & Act
    const response = createSuccessResponse(null);

    // Assert
    expect(response.success).toBe(true);
    expect(response.data).toBeNull();
  });
});

// =============================================================================
// エラーレスポンス作成テスト
// =============================================================================

describe('createErrorResponse', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('エラーコードとメッセージでエラーレスポンスを作成できること', async () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const { createErrorResponse: createErr } = await import('../../src/utils/mcp-response');

    // Act
    const response = createErr(ErrorCode.VALIDATION_ERROR, 'Invalid input');

    // Assert
    expect(response.success).toBe(false);
    expect(response.error.code).toBe('VALIDATION_ERROR');
    expect(response.error.message).toBe('Invalid input');
    expect(response.error.details).toBeUndefined();
  });

  it('開発環境では詳細情報が含まれること', async () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'development');
    const { createErrorResponse: createErr } = await import('../../src/utils/mcp-response');
    const details = { field: 'email', reason: 'invalid format' };

    // Act
    const response = createErr(ErrorCode.VALIDATION_ERROR, 'Invalid input', details);

    // Assert
    expect(response.success).toBe(false);
    expect(response.error.details).toEqual(details);
  });

  it('本番環境では詳細情報が含まれないこと（セキュリティ）', async () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const { createErrorResponse: createErr } = await import('../../src/utils/mcp-response');
    const details = { sensitiveData: 'should not leak' };

    // Act
    const response = createErr(ErrorCode.INTERNAL_ERROR, 'Error', details);

    // Assert
    expect(response.success).toBe(false);
    expect(response.error.details).toBeUndefined();
  });

  it('文字列エラーコードでエラーレスポンスを作成できること', async () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const { createErrorResponse: createErr } = await import('../../src/utils/mcp-response');

    // Act
    const response = createErr('CUSTOM_ERROR', 'Custom error message');

    // Assert
    expect(response.success).toBe(false);
    expect(response.error.code).toBe('CUSTOM_ERROR');
  });

  it('メタデータ付きでエラーレスポンスを作成できること', async () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'production');
    const { createErrorResponse: createErr } = await import('../../src/utils/mcp-response');
    const metadata: McpResponseMetadata = { processing_time_ms: 100 };

    // Act
    const response = createErr(ErrorCode.INTERNAL_ERROR, 'Error', undefined, metadata);

    // Assert
    expect(response.success).toBe(false);
    expect(response.metadata).toEqual(metadata);
  });
});

// =============================================================================
// 型ガード関数テスト
// =============================================================================

describe('isSuccessResponse', () => {
  it('成功レスポンスに対してtrueを返すこと', () => {
    // Arrange
    const response: McpResponse<{ id: string }> = {
      success: true,
      data: { id: '123' },
    };

    // Act & Assert
    expect(isSuccessResponse(response)).toBe(true);
  });

  it('エラーレスポンスに対してfalseを返すこと', () => {
    // Arrange
    const response: McpResponse<{ id: string }> = {
      success: false,
      error: { code: 'ERROR', message: 'test' },
    };

    // Act & Assert
    expect(isSuccessResponse(response)).toBe(false);
  });

  it('型ガードとして機能すること', () => {
    // Arrange
    const response: McpResponse<{ id: string }> = createSuccessResponse({ id: '123' });

    // Act & Assert
    if (isSuccessResponse(response)) {
      // TypeScript型推論でdataにアクセス可能
      expect(response.data.id).toBe('123');
    } else {
      // このブランチには到達しない
      expect.fail('Should be success response');
    }
  });
});

describe('isErrorResponse', () => {
  it('エラーレスポンスに対してtrueを返すこと', () => {
    // Arrange
    const response: McpResponse<unknown> = {
      success: false,
      error: { code: 'ERROR', message: 'test' },
    };

    // Act & Assert
    expect(isErrorResponse(response)).toBe(true);
  });

  it('成功レスポンスに対してfalseを返すこと', () => {
    // Arrange
    const response: McpResponse<unknown> = {
      success: true,
      data: { id: '123' },
    };

    // Act & Assert
    expect(isErrorResponse(response)).toBe(false);
  });
});

// =============================================================================
// メタデータヘルパーテスト
// =============================================================================

describe('withProcessingTime', () => {
  it('処理時間をメタデータに追加できること', () => {
    // Arrange
    const startTime = performance.now() - 50; // 50ms前

    // Act
    const metadata = withProcessingTime(startTime);

    // Assert
    expect(metadata.processing_time_ms).toBeGreaterThanOrEqual(50);
    expect(metadata.processing_time_ms).toBeLessThan(100);
  });

  it('既存のメタデータを保持しつつ処理時間を追加できること', () => {
    // Arrange
    const startTime = performance.now();
    const existing: McpResponseMetadata = { optimization_mode: 'summary' };

    // Act
    const metadata = withProcessingTime(startTime, existing);

    // Assert
    expect(metadata.optimization_mode).toBe('summary');
    expect(metadata.processing_time_ms).toBeDefined();
  });
});

describe('withPagination', () => {
  it('ページネーション情報をメタデータに追加できること', () => {
    // Arrange & Act
    const metadata = withPagination(100, 20, 10);

    // Assert
    expect(metadata.total_count).toBe(100);
    expect(metadata.offset).toBe(20);
    expect(metadata.limit).toBe(10);
  });

  it('既存のメタデータを保持しつつページネーションを追加できること', () => {
    // Arrange
    const existing: McpResponseMetadata = { processing_time_ms: 42 };

    // Act
    const metadata = withPagination(100, 0, 10, existing);

    // Assert
    expect(metadata.processing_time_ms).toBe(42);
    expect(metadata.total_count).toBe(100);
  });
});

describe('withOptimizationMode', () => {
  it.each<OptimizationMode>(['full', 'summary', 'compact', 'truncated'])(
    '最適化モード "%s" をメタデータに追加できること',
    (mode) => {
      // Act
      const metadata = withOptimizationMode(mode);

      // Assert
      expect(metadata.optimization_mode).toBe(mode);
    }
  );
});

describe('withTruncation', () => {
  it('切り詰め情報をメタデータに追加できること', () => {
    // Arrange & Act
    const metadata = withTruncation(10000);

    // Assert
    expect(metadata.truncated).toBe(true);
    expect(metadata.original_size).toBe(10000);
    expect(metadata.optimization_mode).toBe('truncated');
  });

  it('既存のメタデータを保持しつつ切り詰め情報を追加できること', () => {
    // Arrange
    const existing: McpResponseMetadata = { processing_time_ms: 100 };

    // Act
    const metadata = withTruncation(5000, existing);

    // Assert
    expect(metadata.processing_time_ms).toBe(100);
    expect(metadata.truncated).toBe(true);
    expect(metadata.original_size).toBe(5000);
  });
});

// =============================================================================
// Zodスキーマバリデーションテスト
// =============================================================================

describe('Zod Schemas', () => {
  describe('createSuccessResponseSchema', () => {
    it('有効な成功レスポンスを検証できること', () => {
      // Arrange
      const dataSchema = z.object({ id: z.string(), name: z.string() });
      const schema = createSuccessResponseSchema(dataSchema);
      const response = {
        success: true,
        data: { id: '123', name: 'test' },
      };

      // Act
      const result = schema.safeParse(response);

      // Assert
      expect(result.success).toBe(true);
    });

    it('メタデータ付きの成功レスポンスを検証できること', () => {
      // Arrange
      const dataSchema = z.object({ value: z.number() });
      const schema = createSuccessResponseSchema(dataSchema);
      const response = {
        success: true,
        data: { value: 42 },
        metadata: {
          processing_time_ms: 100,
          optimization_mode: 'summary',
        },
      };

      // Act
      const result = schema.safeParse(response);

      // Assert
      expect(result.success).toBe(true);
    });

    it('不正なデータ形式を検出できること', () => {
      // Arrange
      const dataSchema = z.object({ id: z.string() });
      const schema = createSuccessResponseSchema(dataSchema);
      const response = {
        success: true,
        data: { id: 123 }, // 数値ではなく文字列であるべき
      };

      // Act
      const result = schema.safeParse(response);

      // Assert
      expect(result.success).toBe(false);
    });
  });

  describe('mcpErrorResponseSchema', () => {
    it('有効なエラーレスポンスを検証できること', () => {
      // Arrange
      const response = {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
        },
      };

      // Act
      const result = mcpErrorResponseSchema.safeParse(response);

      // Assert
      expect(result.success).toBe(true);
    });

    it('詳細情報付きのエラーレスポンスを検証できること', () => {
      // Arrange
      const response = {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
          details: { field: 'email' },
        },
      };

      // Act
      const result = mcpErrorResponseSchema.safeParse(response);

      // Assert
      expect(result.success).toBe(true);
    });

    it('エラーコード欠落を検出できること', () => {
      // Arrange
      const response = {
        success: false,
        error: {
          message: 'Invalid input',
        },
      };

      // Act
      const result = mcpErrorResponseSchema.safeParse(response);

      // Assert
      expect(result.success).toBe(false);
    });
  });

  describe('createMcpResponseSchema', () => {
    it('成功レスポンスを検証できること', () => {
      // Arrange
      const dataSchema = z.object({ items: z.array(z.string()) });
      const schema = createMcpResponseSchema(dataSchema);
      const response = {
        success: true,
        data: { items: ['a', 'b', 'c'] },
      };

      // Act
      const result = schema.safeParse(response);

      // Assert
      expect(result.success).toBe(true);
    });

    it('エラーレスポンスを検証できること', () => {
      // Arrange
      const dataSchema = z.object({ items: z.array(z.string()) });
      const schema = createMcpResponseSchema(dataSchema);
      const response = {
        success: false,
        error: { code: 'ERROR', message: 'Failed' },
      };

      // Act
      const result = schema.safeParse(response);

      // Assert
      expect(result.success).toBe(true);
    });

    it('無効なレスポンス形式を検出できること', () => {
      // Arrange
      const dataSchema = z.object({ items: z.array(z.string()) });
      const schema = createMcpResponseSchema(dataSchema);
      const response = {
        // success フィールドがない
        data: { items: ['a'] },
      };

      // Act
      const result = schema.safeParse(response);

      // Assert
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// 統合テスト
// =============================================================================

describe('Integration', () => {
  it('成功レスポンスのフルフローが機能すること', () => {
    // Arrange
    const startTime = performance.now();
    const data = { results: [1, 2, 3], total: 100 };

    // Act
    let metadata = withProcessingTime(startTime);
    metadata = withPagination(100, 0, 10, metadata);
    metadata = withOptimizationMode('summary', metadata);
    const response = createSuccessResponse(data, metadata);

    // Assert
    expect(response.success).toBe(true);
    expect(response.data.results).toHaveLength(3);
    expect(response.metadata?.processing_time_ms).toBeDefined();
    expect(response.metadata?.total_count).toBe(100);
    expect(response.metadata?.optimization_mode).toBe('summary');
  });

  it('エラーレスポンスのフルフローが機能すること', async () => {
    // Arrange
    vi.stubEnv('NODE_ENV', 'development');
    const { createErrorResponse: createErr, withProcessingTime: withTime } =
      await import('../../src/utils/mcp-response');
    const startTime = performance.now();

    // Act
    const metadata = withTime(startTime);
    const response = createErr(
      ErrorCode.VALIDATION_ERROR,
      'Email is invalid',
      { field: 'email', value: 'invalid' },
      metadata
    );

    // Assert
    expect(response.success).toBe(false);
    expect(response.error.code).toBe('VALIDATION_ERROR');
    expect(response.error.details).toEqual({ field: 'email', value: 'invalid' });
    expect(response.metadata?.processing_time_ms).toBeDefined();
  });

  it('型ガードとスキーマ検証の整合性があること', () => {
    // Arrange
    const dataSchema = z.object({ id: z.string() });
    const schema = createMcpResponseSchema(dataSchema);
    const successResponse = createSuccessResponse({ id: '123' });

    // Act
    const parseResult = schema.safeParse(successResponse);
    const isSuccess = isSuccessResponse(successResponse);

    // Assert
    expect(parseResult.success).toBe(true);
    expect(isSuccess).toBe(true);
  });
});
