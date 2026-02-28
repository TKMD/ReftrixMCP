// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 非推奨警告ユーティリティ
 *
 * 非推奨となったMCPツールの警告メッセージを生成し、
 * 代替ツールへの移行を促すための機能を提供します。
 */

import { isDevelopment } from './logger';

// =============================================================================
// 型定義
// =============================================================================

/**
 * 非推奨警告の型定義
 */
export interface DeprecationWarning {
  /** 非推奨となったツール名 */
  deprecated_tool: string;
  /** 代替ツール名 */
  replacement: string;
  /** 削除予定バージョン */
  removal_version: string;
  /** 移行ガイドURL */
  migration_guide: string;
  /** 警告メッセージ */
  message: string;
}

/**
 * 非推奨警告を含むレスポンスの型定義
 */
export interface DeprecatedToolResponse<T> {
  /** 実際のレスポンスデータ */
  data: T;
  /** 非推奨警告 */
  deprecation_warning: DeprecationWarning;
}

// =============================================================================
// 定数
// =============================================================================

/**
 * 移行ガイドのベースURL
 */
const MIGRATION_GUIDE_BASE_URL = 'https://docs.reftrix.dev/docs/migration';

/**
 * デフォルトの削除予定バージョン
 */
const DEFAULT_REMOVAL_VERSION = 'v1.0.0';

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * 非推奨警告を作成する
 *
 * @param deprecatedTool - 非推奨となったツール名（例: 'quality.batch_evaluate'）
 * @param replacement - 代替ツール名
 * @param removalVersion - 削除予定バージョン（デフォルト: 'v1.0.0'）
 * @returns 非推奨警告オブジェクト
 */
export function createDeprecationWarning(
  deprecatedTool: string,
  replacement: string,
  removalVersion: string = DEFAULT_REMOVAL_VERSION
): DeprecationWarning {
  const message = `[DEPRECATION] ${deprecatedTool} is deprecated and will be removed in ${removalVersion}. Please use ${replacement} instead.`;

  return {
    deprecated_tool: deprecatedTool,
    replacement,
    removal_version: removalVersion,
    migration_guide: MIGRATION_GUIDE_BASE_URL,
    message,
  };
}

/**
 * 非推奨警告をコンソールにログ出力する
 *
 * 開発環境でのみログを出力し、本番環境では抑制します。
 *
 * @param warning - 非推奨警告オブジェクト
 */
export function logDeprecationWarning(warning: DeprecationWarning): void {
  // 開発環境でのみログ出力
  if (isDevelopment()) {
    console.warn('[MCP] DEPRECATION', {
      tool: warning.deprecated_tool,
      replacement: warning.replacement,
      removal_version: warning.removal_version,
      migration_guide: warning.migration_guide,
    });
  }
}

/**
 * レスポンスデータに非推奨警告をラップする
 *
 * 既存のレスポンスデータを data フィールドに配置し、
 * deprecation_warning フィールドに警告を追加します。
 *
 * @param data - 元のレスポンスデータ
 * @param warning - 非推奨警告オブジェクト
 * @returns 非推奨警告を含むレスポンス
 */
export function wrapResponseWithDeprecation<T>(
  data: T,
  warning: DeprecationWarning
): DeprecatedToolResponse<T> {
  return {
    data,
    deprecation_warning: warning,
  };
}

// =============================================================================
// 低使用率ツール用非推奨警告
// =============================================================================

/**
 * 低使用率ツールの非推奨情報
 * WebDesign専用ツール
 */
const LOW_USAGE_TOOL_DEPRECATIONS: Record<
  string,
  { replacement: string; migrationPath: string }
> = {
  'quality.batch_evaluate': {
    replacement: 'Loop with quality.evaluate',
    migrationPath: 'quality-batch',
  },
};

/**
 * 低使用率ツール用の非推奨警告を作成する
 *
 * ツール名に基づいて、適切な代替手段と移行ガイドを含む警告を作成します。
 *
 * @param toolName - ツール名（例: 'quality.batch_evaluate'）
 * @returns 非推奨警告オブジェクト
 * @throws Error ツール名が未登録の場合
 */
export function createLowUsageToolDeprecationWarning(
  toolName: string
): DeprecationWarning {
  const info = LOW_USAGE_TOOL_DEPRECATIONS[toolName];

  if (!info) {
    throw new Error(`Unknown low-usage tool: ${toolName}`);
  }

  const migrationGuide = `${MIGRATION_GUIDE_BASE_URL}/${info.migrationPath}`;
  const message = `[DEPRECATION] ${toolName} is deprecated and will be removed in ${DEFAULT_REMOVAL_VERSION}. Please use ${info.replacement} instead.`;

  return {
    deprecated_tool: toolName,
    replacement: info.replacement,
    removal_version: DEFAULT_REMOVAL_VERSION,
    migration_guide: migrationGuide,
    message,
  };
}
