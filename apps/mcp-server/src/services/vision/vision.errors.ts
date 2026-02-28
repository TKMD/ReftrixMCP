// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision Analysis Error Types
 *
 * Phase 5 REFACTOR: Vision AI分析サービスのエラー型を統一
 *
 * エラーコード:
 * - OLLAMA_UNAVAILABLE: Ollamaサービスに接続できない
 * - TIMEOUT: リクエストがタイムアウト
 * - INVALID_RESPONSE: レスポンスが無効（JSONパースエラー等）
 * - VALIDATION_FAILED: Zodバリデーションエラー
 * - INPUT_VALIDATION: 入力バリデーションエラー（Base64不正、サイズ超過等）
 * - CACHE_ERROR: キャッシュ操作エラー
 *
 * 参照:
 * - apps/mcp-server/src/services/vision/mood.analyzer.ts
 * - apps/mcp-server/src/services/vision/brandtone.analyzer.ts
 * - apps/mcp-server/src/services/vision/ollama-vision-client.ts
 */

// =============================================================================
// 型定義
// =============================================================================

/**
 * Vision分析エラーコード
 */
export type VisionErrorCode =
  | 'OLLAMA_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'VALIDATION_FAILED'
  | 'INPUT_VALIDATION'
  | 'CACHE_ERROR';

// =============================================================================
// VisionAnalysisError クラス
// =============================================================================

/**
 * Vision分析処理の標準エラー
 *
 * @example
 * ```typescript
 * throw new VisionAnalysisError(
 *   'Ollama service is unavailable',
 *   'OLLAMA_UNAVAILABLE',
 *   true // リトライ可能
 * );
 * ```
 */
export class VisionAnalysisError extends Error {
  /**
   * エラーコード
   */
  readonly code: VisionErrorCode;

  /**
   * リトライ可能かどうか
   *
   * true: 一時的なエラー（タイムアウト、接続エラー）
   * false: 永続的なエラー（バリデーションエラー、無効なレスポンス）
   */
  readonly isRetryable: boolean;

  /**
   * 追加のコンテキスト情報
   */
  readonly context: Record<string, unknown> | undefined;

  /**
   * VisionAnalysisErrorのコンストラクタ
   *
   * @param message - エラーメッセージ
   * @param code - エラーコード
   * @param isRetryable - リトライ可能かどうか（デフォルト: false）
   * @param context - 追加のコンテキスト情報
   */
  constructor(
    message: string,
    code: VisionErrorCode,
    isRetryable: boolean = false,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'VisionAnalysisError';
    this.code = code;
    this.isRetryable = isRetryable;
    this.context = context;

    // ES5互換性のためにprototypeを設定
    Object.setPrototypeOf(this, VisionAnalysisError.prototype);
  }

  /**
   * エラーをJSON形式で出力
   */
  toJSON(): {
    name: string;
    message: string;
    code: VisionErrorCode;
    isRetryable: boolean;
    context: Record<string, unknown> | undefined;
    stack: string | undefined;
  } {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      isRetryable: this.isRetryable,
      context: this.context,
      stack: this.stack,
    };
  }
}

// =============================================================================
// CacheError クラス
// =============================================================================

/**
 * キャッシュ操作エラー
 */
export class CacheError extends Error {
  /**
   * エラーコード
   */
  readonly code = 'CACHE_ERROR' as const;

  /**
   * 操作種別
   */
  readonly operation: 'get' | 'set' | 'delete' | 'clear';

  /**
   * CacheErrorのコンストラクタ
   *
   * @param message - エラーメッセージ
   * @param operation - 操作種別
   */
  constructor(message: string, operation: 'get' | 'set' | 'delete' | 'clear') {
    super(message);
    this.name = 'CacheError';
    this.operation = operation;

    Object.setPrototypeOf(this, CacheError.prototype);
  }
}

// =============================================================================
// ユーティリティ関数
// =============================================================================

/**
 * VisionAnalysisError かどうかをチェック
 */
export function isVisionAnalysisError(
  error: unknown
): error is VisionAnalysisError {
  return error instanceof VisionAnalysisError;
}

/**
 * リトライ可能なエラーかどうかをチェック
 */
export function isRetryableError(error: unknown): boolean {
  if (isVisionAnalysisError(error)) {
    return error.isRetryable;
  }
  return false;
}

/**
 * エラーコードからメッセージを生成
 */
export function getErrorMessage(code: VisionErrorCode): string {
  const messages: Record<VisionErrorCode, string> = {
    OLLAMA_UNAVAILABLE: 'Ollama service is not available',
    TIMEOUT: 'Request timed out',
    INVALID_RESPONSE: 'Invalid response from Ollama',
    VALIDATION_FAILED: 'Response validation failed',
    INPUT_VALIDATION: 'Input validation failed',
    CACHE_ERROR: 'Cache operation failed',
  };
  return messages[code];
}
