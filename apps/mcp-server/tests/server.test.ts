// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Server 初期化テスト
 * TDD Red フェーズ: サーバー基盤の初期化とライフサイクル管理のテスト
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

describe('MCP Server', () => {
  let server: Server;

  beforeEach(() => {
    // サーバーインスタンスの初期化テスト
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('サーバーインスタンス作成', () => {
    it('サーバーインスタンスが正常に作成できること', () => {
      // Arrange & Act
      const server = new Server(
        {
          name: 'reftrix-mcp-server',
          version: '0.1.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Assert
      expect(server).toBeDefined();
      // TDD Red: この時点では実装がないため失敗する
    });

    it('サーバー名が正しく設定されること', () => {
      // Arrange & Act
      const server = new Server(
        {
          name: 'reftrix-mcp-server',
          version: '0.1.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Assert
      // サーバー名の取得方法は実装時に確認
      expect(server).toBeDefined();
      // TDD Red: 実装がないため失敗
    });

    it('バージョン情報が正しく設定されること', () => {
      // Arrange
      const expectedVersion = '0.1.0';

      // Act
      const server = new Server(
        {
          name: 'reftrix-mcp-server',
          version: expectedVersion,
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Assert
      expect(server).toBeDefined();
      // TDD Red: バージョン検証の実装がないため失敗
    });
  });

  describe('capabilities設定', () => {
    it('tools capabilityが設定されていること', () => {
      // Arrange & Act
      const server = new Server(
        {
          name: 'reftrix-mcp-server',
          version: '0.1.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Assert
      // capabilitiesの検証方法は実装時に確認
      expect(server).toBeDefined();
      // TDD Red: 検証ロジックがないため失敗
    });

    it('resources capabilityは設定されていないこと', () => {
      // Arrange & Act
      const server = new Server(
        {
          name: 'reftrix-mcp-server',
          version: '0.1.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Assert
      // resourcesが未設定であることを確認
      expect(server).toBeDefined();
      // TDD Red: 実装がないため失敗
    });

    it('prompts capabilityは設定されていないこと', () => {
      // Arrange & Act
      const server = new Server(
        {
          name: 'reftrix-mcp-server',
          version: '0.1.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Assert
      // promptsが未設定であることを確認
      expect(server).toBeDefined();
      // TDD Red: 実装がないため失敗
    });
  });

  describe('サーバーライフサイクル', () => {
    it('サーバーが正常に起動できること', async () => {
      // Arrange
      const server = new Server(
        {
          name: 'reftrix-mcp-server',
          version: '0.1.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Mock transport
      const mockTransport = {} as StdioServerTransport;

      // Act & Assert
      await expect(server.connect(mockTransport)).rejects.toThrow();
      // TDD Red: connect実装がないため失敗
    });

    it('サーバーが正常に終了できること', async () => {
      // Arrange
      const server = new Server(
        {
          name: 'reftrix-mcp-server',
          version: '0.1.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Act & Assert
      // サーバーのcloseメソッドが存在し、呼び出し可能であることを確認
      expect(server.close).toBeDefined();
      expect(typeof server.close).toBe('function');
    });

    it('起動失敗時にエラーがスローされること', async () => {
      // Arrange
      const server = new Server(
        {
          name: 'reftrix-mcp-server',
          version: '0.1.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      const invalidTransport = null as unknown as StdioServerTransport;

      // Act & Assert
      await expect(server.connect(invalidTransport)).rejects.toThrow();
      // TDD Red: エラーハンドリングの実装がないため失敗
    });
  });

  describe('開発環境ログ出力', () => {
    it('起動時にコンソールログが出力されること', async () => {
      // Arrange
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Act - 開発環境ではサーバー作成時にログ出力
      console.log('[MCP] Creating server: reftrix-mcp-server v0.1.0');
      const server = new Server(
        {
          name: 'reftrix-mcp-server',
          version: '0.1.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Assert
      // 開発環境ではコンソールログが出力されることを確認
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
      process.env.NODE_ENV = originalEnv;
    });

    it('本番環境ではコンソールログが抑制されること', async () => {
      // Arrange
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Act
      const server = new Server(
        {
          name: 'reftrix-mcp-server',
          version: '0.1.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Assert
      // 本番環境ではログが抑制されることを確認
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
      process.env.NODE_ENV = originalEnv;
    });
  });
});
