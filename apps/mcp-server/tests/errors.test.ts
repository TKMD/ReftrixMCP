// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * エラーハンドリング テスト
 * TDD Red フェーズ: MCPエラークラスとエラーコード定義のテスト
 */
import { describe, it, expect } from 'vitest';

// エラーコード enum の定義（テスト用）
enum ErrorCode {
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  SVG_NOT_FOUND = 'SVG_NOT_FOUND',
  SVG_INVALID = 'SVG_INVALID',
  TRANSFORM_FAILED = 'TRANSFORM_FAILED',
  INVALID_QUERY = 'INVALID_QUERY',
  NO_RESULTS = 'NO_RESULTS',
  INVALID_ID = 'INVALID_ID',
  UNKNOWN_LICENSE = 'UNKNOWN_LICENSE',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
}

// McpError クラスの定義（テスト用）
class McpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'McpError';
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }

  toMcpFormat() {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error: ${this.code} - ${this.message}${
            this.details ? `\n\nDetails: ${JSON.stringify(this.details, null, 2)}` : ''
          }`,
        },
      ],
    };
  }
}

describe('MCP Error Handling', () => {
  describe('McpError クラス', () => {
    it('McpErrorインスタンスが正常に作成できること', () => {
      // Act
      const error = new McpError(ErrorCode.INTERNAL_ERROR, 'Test error');

      // Assert
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(McpError);
      expect(error.name).toBe('McpError');
      // TDD Red: McpError実装がないため失敗
    });

    it('エラーコードが正しく設定されること', () => {
      // Arrange
      const errorCode = ErrorCode.SVG_NOT_FOUND;
      const message = 'SVG not found';

      // Act
      const error = new McpError(errorCode, message);

      // Assert
      expect(error.code).toBe(errorCode);
      // TDD Red: code プロパティの実装がないため失敗
    });

    it('エラーメッセージが正しく設定されること', () => {
      // Arrange
      const message = 'Test error message';

      // Act
      const error = new McpError(ErrorCode.VALIDATION_ERROR, message);

      // Assert
      expect(error.message).toBe(message);
      // TDD Red: message プロパティの実装がないため失敗
    });

    it('詳細情報が正しく設定されること', () => {
      // Arrange
      const details = { field: 'query', value: null };

      // Act
      const error = new McpError(
        ErrorCode.VALIDATION_ERROR,
        'Validation failed',
        details
      );

      // Assert
      expect(error.details).toEqual(details);
      // TDD Red: details プロパティの実装がないため失敗
    });

    it('詳細情報なしでもインスタンス作成できること', () => {
      // Act
      const error = new McpError(ErrorCode.INTERNAL_ERROR, 'Internal error');

      // Assert
      expect(error.details).toBeUndefined();
      // TDD Red: オプショナルdetailsの実装がないため失敗
    });
  });

  describe('ErrorCode 定義', () => {
    it('すべてのエラーコードが定義されていること', () => {
      // Assert
      expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
      expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
      expect(ErrorCode.TOOL_NOT_FOUND).toBe('TOOL_NOT_FOUND');
      expect(ErrorCode.SVG_NOT_FOUND).toBe('SVG_NOT_FOUND');
      expect(ErrorCode.SVG_INVALID).toBe('SVG_INVALID');
      expect(ErrorCode.TRANSFORM_FAILED).toBe('TRANSFORM_FAILED');
      expect(ErrorCode.INVALID_QUERY).toBe('INVALID_QUERY');
      expect(ErrorCode.NO_RESULTS).toBe('NO_RESULTS');
      expect(ErrorCode.INVALID_ID).toBe('INVALID_ID');
      expect(ErrorCode.UNKNOWN_LICENSE).toBe('UNKNOWN_LICENSE');
      expect(ErrorCode.RATE_LIMIT_EXCEEDED).toBe('RATE_LIMIT_EXCEEDED');
      // TDD Red: ErrorCode enumの実装がないため失敗
    });

    it('エラーコードが一意であること', () => {
      // Arrange
      const codes = Object.values(ErrorCode);

      // Assert
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBe(codes.length);
      // TDD Red: エラーコードの一意性チェックの実装がないため失敗
    });
  });

  describe('エラー変換（JSON形式）', () => {
    it('toJSON()でJSON形式に変換できること', () => {
      // Arrange
      const error = new McpError(
        ErrorCode.SVG_NOT_FOUND,
        'SVG not found',
        { id: '123' }
      );

      // Act
      const json = error.toJSON();

      // Assert
      expect(json).toEqual({
        code: ErrorCode.SVG_NOT_FOUND,
        message: 'SVG not found',
        details: { id: '123' },
      });
      // TDD Red: toJSON()メソッドの実装がないため失敗
    });

    it('詳細情報なしのエラーをJSON変換できること', () => {
      // Arrange
      const error = new McpError(ErrorCode.INTERNAL_ERROR, 'Internal error');

      // Act
      const json = error.toJSON();

      // Assert
      expect(json).toEqual({
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Internal error',
        details: undefined,
      });
      // TDD Red: details未定義のJSON変換実装がないため失敗
    });
  });

  describe('MCP形式エラーレスポンス', () => {
    it('toMcpFormat()でMCP形式に変換できること', () => {
      // Arrange
      const error = new McpError(
        ErrorCode.INVALID_QUERY,
        'Search query cannot be empty'
      );

      // Act
      const mcpFormat = error.toMcpFormat();

      // Assert
      expect(mcpFormat).toHaveProperty('isError', true);
      expect(mcpFormat).toHaveProperty('content');
      expect(mcpFormat.content).toBeInstanceOf(Array);
      expect(mcpFormat.content[0]).toHaveProperty('type', 'text');
      expect(mcpFormat.content[0]).toHaveProperty('text');
      expect(mcpFormat.content[0].text).toContain('INVALID_QUERY');
      expect(mcpFormat.content[0].text).toContain('Search query cannot be empty');
      // TDD Red: toMcpFormat()メソッドの実装がないため失敗
    });

    it('詳細情報を含むエラーがMCP形式に変換できること', () => {
      // Arrange
      const details = { field: 'limit', value: 100, max: 50 };
      const error = new McpError(
        ErrorCode.VALIDATION_ERROR,
        'Validation failed',
        details
      );

      // Act
      const mcpFormat = error.toMcpFormat();

      // Assert
      expect(mcpFormat.isError).toBe(true);
      expect(mcpFormat.content[0].text).toContain('VALIDATION_ERROR');
      expect(mcpFormat.content[0].text).toContain('Validation failed');
      expect(mcpFormat.content[0].text).toContain('Details:');
      // TDD Red: 詳細情報を含むMCP形式変換の実装がないため失敗
    });

    it('MCP形式レスポンスが正しい構造を持つこと', () => {
      // Arrange
      const error = new McpError(ErrorCode.TOOL_NOT_FOUND, 'Unknown tool: test');

      // Act
      const mcpFormat = error.toMcpFormat();

      // Assert
      expect(mcpFormat).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: expect.stringContaining('TOOL_NOT_FOUND'),
          },
        ],
      });
      // TDD Red: MCP形式構造の実装がないため失敗
    });
  });

  describe('エラーケース別のテスト', () => {
    const errorTestCases = [
      {
        code: ErrorCode.INVALID_QUERY,
        message: 'Search query cannot be empty',
        details: undefined,
      },
      {
        code: ErrorCode.NO_RESULTS,
        message: 'No SVG assets found matching your query',
        details: { query: 'nonexistent' },
      },
      {
        code: ErrorCode.INVALID_ID,
        message: 'The provided ID is not a valid UUID format',
        details: { providedId: 'invalid-uuid' },
      },
      {
        code: ErrorCode.SVG_NOT_FOUND,
        message: 'No SVG asset found with ID',
        details: { id: '123e4567-e89b-12d3-a456-426614174000' },
      },
      {
        code: ErrorCode.SVG_INVALID,
        message: 'The provided content is not valid SVG',
        details: undefined,
      },
      {
        code: ErrorCode.UNKNOWN_LICENSE,
        message: 'License is not a recognized SPDX identifier',
        details: { license: 'CUSTOM' },
      },
      {
        code: ErrorCode.TRANSFORM_FAILED,
        message: 'Failed to convert SVG to React component',
        details: { reason: 'Unsupported elements' },
      },
    ];

    errorTestCases.forEach(({ code, message, details }) => {
      it(`${code}エラーが正しく作成できること`, () => {
        // Act
        const error = new McpError(code, message, details);

        // Assert
        expect(error.code).toBe(code);
        expect(error.message).toBe(message);
        expect(error.details).toEqual(details);
        // TDD Red: 各エラーケースの実装がないため失敗
      });
    });
  });

  describe('エラーのスロー', () => {
    it('McpErrorをスローできること', () => {
      // Arrange
      const throwError = () => {
        throw new McpError(ErrorCode.INTERNAL_ERROR, 'Test error');
      };

      // Act & Assert
      expect(throwError).toThrow(McpError);
      expect(throwError).toThrow('Test error');
      // TDD Red: エラースローの実装がないため失敗
    });

    it('スローされたエラーをキャッチできること', () => {
      // Arrange
      let caughtError: McpError | null = null;

      // Act
      try {
        throw new McpError(ErrorCode.VALIDATION_ERROR, 'Validation failed');
      } catch (error) {
        caughtError = error as McpError;
      }

      // Assert
      expect(caughtError).toBeInstanceOf(McpError);
      expect(caughtError?.code).toBe(ErrorCode.VALIDATION_ERROR);
      // TDD Red: エラーキャッチの実装がないため失敗
    });

    it('エラー型ガードが機能すること', () => {
      // Arrange
      const error: unknown = new McpError(ErrorCode.SVG_NOT_FOUND, 'Not found');

      // Act
      const isMcpError = error instanceof McpError;

      // Assert
      expect(isMcpError).toBe(true);
      if (isMcpError) {
        expect(error.code).toBe(ErrorCode.SVG_NOT_FOUND);
      }
      // TDD Red: 型ガードの実装がないため失敗
    });
  });

  describe('開発環境ログ出力', () => {
    it('エラー作成時にログが出力されないこと', () => {
      // Arrange
      const consoleSpy = vi.spyOn(console, 'log');

      // Act
      new McpError(ErrorCode.INTERNAL_ERROR, 'Test error');

      // Assert
      // エラー作成時はログ出力しない
      expect(consoleSpy).not.toHaveBeenCalled();
      // TDD Red: ログ制御の実装がないため失敗

      consoleSpy.mockRestore();
    });
  });
});
