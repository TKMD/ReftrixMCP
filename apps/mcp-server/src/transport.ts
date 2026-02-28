// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Server - StdIO Transport
 * StdioServerTransportのラッパー
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger, isDevelopment } from './utils/logger';

/**
 * StdIOトランスポートを作成
 * Claude Desktop等のMCPクライアントとの通信に使用
 */
export function createTransport(): StdioServerTransport {
  if (isDevelopment()) {
    logger.info('Creating StdIO transport');
  }

  const transport = new StdioServerTransport();

  if (isDevelopment()) {
    logger.info('StdIO transport created successfully');
  }

  return transport;
}

/**
 * トランスポートの接続状態を確認
 */
export function isTransportConnected(transport: StdioServerTransport): boolean {
  // StdioServerTransportはstdin/stdoutを使用するため、
  // 接続状態は基本的に常にtrue（プロセスが生きている限り）
  return transport !== null && transport !== undefined;
}

/**
 * トランスポート関連のユーティリティ
 */
export const transportUtils = {
  /**
   * トランスポートを作成して返す
   */
  create: createTransport,

  /**
   * 接続状態を確認
   */
  isConnected: isTransportConnected,
};

export { StdioServerTransport };
