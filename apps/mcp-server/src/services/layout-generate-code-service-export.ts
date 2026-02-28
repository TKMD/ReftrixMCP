// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.generate_code MCPツール用Service層エクスポート
 * Service関数をエクスポート
 *
 * @module services/layout-generate-code-service-export
 */

import {
  layoutGenerateCodeHandler,
  setLayoutToCodeServiceFactory,
} from '../tools/layout/to-code.tool';
import {
  createLayoutToCodeServiceFactory,
  setLayoutToCodePrismaClientFactory,
  type IPrismaClient,
} from './layout-to-code.service';
import type {
  LayoutToCodeInput,
  LayoutToCodeOutput,
  LayoutToCodeData,
  LayoutToCodeOptions,
  LayoutToCodeErrorInfo,
  Framework,
} from '../tools/layout/schemas';

// =====================================================
// Service Initialization
// =====================================================

let isInitialized = false;

/**
 * PrismaClientファクトリを設定
 * 外部モジュールからの呼び出し時に設定可能
 */
export function setPrismaClientFactory(factory: () => IPrismaClient): void {
  setLayoutToCodePrismaClientFactory(factory);
  // ファクトリが設定されたらサービスも初期化
  ensureServiceInitialized();
}

/**
 * サービスの初期化を保証
 * 一度だけ実行される
 */
function ensureServiceInitialized(): void {
  if (isInitialized) {
    return;
  }

  // サービスファクトリを設定
  setLayoutToCodeServiceFactory(createLayoutToCodeServiceFactory());
  isInitialized = true;

  if (process.env.NODE_ENV === 'development') {
    // eslint-disable-next-line no-console -- Development-only initialization log
    console.log('[layout-generate-code-service-export] Service factory initialized');
  }
}

/**
 * layout.generate_codeツールを直接実行するService関数
 * 外部モジュールから直接呼び出し可能
 *
 * @param input - layout.generate_code入力パラメータ
 * @returns layout.generate_codeの実行結果
 * @throws エラーが発生した場合、LayoutToCodeErrorOutputで返却される
 *
 * @example
 * ```typescript
 * const result = await executeLayoutGenerateCode({
 *   patternId: '11111111-1111-1111-1111-111111111111',
 *   options: {
 *     framework: 'react',
 *     typescript: true,
 *     tailwind: true,
 *   },
 * });
 *
 * if (result.success) {
 *   console.log('Generated code:', result.data.code);
 *   console.log('Framework:', result.data.framework);
 *   console.log('Component name:', result.data.componentName);
 * } else {
 *   console.error('Generation failed:', result.error);
 * }
 * ```
 */
export async function executeLayoutGenerateCode(
  input: LayoutToCodeInput
): Promise<LayoutToCodeOutput> {
  // サービスが初期化されていることを保証
  ensureServiceInitialized();

  return await layoutGenerateCodeHandler(input);
}

// 型をre-export
export type {
  LayoutToCodeInput,
  LayoutToCodeOutput,
  LayoutToCodeData,
  LayoutToCodeOptions,
  LayoutToCodeErrorInfo,
  Framework,
};
