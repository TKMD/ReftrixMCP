// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Server - Logger
 * 開発環境でのログ出力と本番環境でのログ抑制
 *
 * 使用方法:
 * 1. createLoggerファクトリを使用（推奨）
 *    const logger = createLogger('ModuleName');
 *    logger.info('message');
 *
 * 2. Loggerクラスを直接使用
 *    const logger = new Logger('ModuleName');
 */

/**
 * ログレベル定義
 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

/**
 * Loggerインターフェース
 */
export interface ILogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/**
 * 有効な環境値
 * NODE_ENVはこれらの値のいずれかである必要がある
 */
const VALID_ENVIRONMENTS = ['development', 'production', 'test'] as const;

/**
 * 有効な環境の型
 */
export type ValidEnvironment = (typeof VALID_ENVIRONMENTS)[number];

/**
 * 内部用環境型（互換性のため維持）
 */
type Environment = ValidEnvironment;

/**
 * 環境判定
 *
 * SEC: NODE_ENVが未設定または無効な値の場合、セキュリティ上の理由から
 * 'production'相当として扱う（isDevelopment() = false）
 * これにより本番環境でテスト用APIキーが有効になるリスクを防止
 *
 * @returns 現在の環境。未設定/無効値の場合は 'production'
 */
export const getEnvironment = (): Environment => {
  const rawEnv = process.env.NODE_ENV;

  // 未設定の場合はproductionとして扱う（安全側倒し）
  if (rawEnv === undefined || rawEnv === null) {
    return 'production';
  }

  // trim()して正規化
  const env = rawEnv.trim();

  // 空文字列の場合はproductionとして扱う（安全側倒し）
  if (!env) {
    return 'production';
  }

  // 厳密な完全一致チェック：有効な値のみ受け入れ
  // タブ、改行、空白などが含まれる場合は無効として扱う
  if (env === 'development') return 'development';
  if (env === 'production') return 'production';
  if (env === 'test') return 'test';

  // 無効な値の場合はproductionとして扱う（安全側倒し）
  return 'production';
};

/**
 * 環境変数を検証する
 *
 * サーバー起動時に呼び出して環境設定の問題を早期検出
 *
 * 動作:
 * - NODE_ENV が undefined/空文字/空白のみの場合: エラーをスロー
 * - NODE_ENV が 'development' | 'production' | 'test' の場合: 正常に通過
 * - NODE_ENV がそれ以外の値の場合: 警告ログを出して 'production' にフォールバック
 *
 * SEC: NODE_ENVが未設定の場合、サーバー起動を阻止して
 * 本番環境で不正な設定のまま動作することを防止
 *
 * @returns 有効な環境値
 * @throws Error NODE_ENV が未設定または空文字の場合
 */
export const validateEnvironment = (): ValidEnvironment => {
  const rawEnv = process.env.NODE_ENV;

  // 未設定の場合はエラー
  if (rawEnv === undefined || rawEnv === null) {
    throw new Error(
      'NODE_ENV is not set. Please set NODE_ENV to one of: development, production, test'
    );
  }

  // trim()して正規化
  const env = rawEnv.trim();

  // 空文字列または空白のみの場合はエラー
  if (!env) {
    throw new Error(
      'NODE_ENV is empty. Please set NODE_ENV to one of: development, production, test'
    );
  }

  // 有効な値かチェック（VALID_ENVIRONMENTS定数を使用）
  if ((VALID_ENVIRONMENTS as readonly string[]).includes(env)) {
    return env as ValidEnvironment;
  }

  // 無効な値の場合は警告を出してproductionにフォールバック
  const timestamp = new Date().toISOString();
  console.error(
    `[ENV] [WARN] [${timestamp}] Invalid NODE_ENV value: "${env}". Valid values are: development, production, test. Falling back to "production".`
  );

  return 'production';
};

/**
 * 開発環境かどうかを判定
 *
 * SEC: NODE_ENVが明示的に'development'に設定されている場合のみtrue
 * 未設定/無効値の場合はfalseを返す（テスト用APIキー無効化）
 */
export const isDevelopment = (): boolean => getEnvironment() === 'development';

/**
 * テスト環境かどうかを判定
 */
export const isTest = (): boolean => getEnvironment() === 'test';

/**
 * 本番環境かどうかを判定
 *
 * SEC: NODE_ENVが未設定または無効な値の場合もtrueを返す（安全側倒し）
 */
export const isProductionEnvironment = (): boolean => getEnvironment() === 'production';

/**
 * タイムスタンプを取得
 */
const getTimestamp = (): string => new Date().toISOString();

/**
 * エラーオブジェクトを構造化形式に変換
 */
const formatErrorData = (data: unknown): unknown => {
  if (data instanceof Error) {
    return {
      message: data.message,
      stack: data.stack,
    };
  }
  return data;
};

/**
 * データを安全にフォーマットする
 * undefinedの場合は空文字列を返す
 */
const formatData = (data: unknown): string => {
  if (data === undefined) {
    return '';
  }
  try {
    return ' ' + JSON.stringify(data);
  } catch {
    return ' [Unserializable data]';
  }
};

/**
 * MCPサーバー用Logger
 * - 開発環境: 全レベルのログを[MODULE]プレフィックス付きで出力
 * - テスト環境: ENABLE_TEST_LOGS=true の場合のみ出力
 * - 本番環境: warn/errorのみ出力
 */
export class Logger implements ILogger {
  private readonly prefix: string;

  constructor(prefix: string = 'MCP') {
    this.prefix = prefix;
  }

  /**
   * ログ出力すべきかどうかを判定
   * @param level - ログレベル
   * @returns ログ出力すべきならtrue
   */
  private shouldLog(level: LogLevel): boolean {
    // テスト環境では明示的に有効化されていない限り出力しない
    if (isTest() && process.env.ENABLE_TEST_LOGS !== 'true') {
      return false;
    }

    // 開発環境では全て出力
    if (isDevelopment()) {
      return true;
    }

    // 本番環境ではwarn/errorのみ
    return level === LogLevel.WARN || level === LogLevel.ERROR;
  }

  /**
   * デバッグレベルログ
   * 開発環境のみ出力
   */
  debug(message: string, data?: unknown): void {
    if (!this.shouldLog(LogLevel.DEBUG)) {
      return;
    }
    const timestamp = getTimestamp();
    console.error(`[${this.prefix}] [DEBUG] [${timestamp}] ${message}${formatData(data)}`);
  }

  /**
   * 情報レベルログ
   * 開発環境のみ出力
   */
  info(message: string, data?: unknown): void {
    if (!this.shouldLog(LogLevel.INFO)) {
      return;
    }
    const timestamp = getTimestamp();
    console.error(`[${this.prefix}] [INFO] [${timestamp}] ${message}${formatData(data)}`);
  }

  /**
   * 警告レベルログ
   * 全環境で出力
   */
  warn(message: string, data?: unknown): void {
    if (!this.shouldLog(LogLevel.WARN)) {
      return;
    }
    const timestamp = getTimestamp();
    console.error(`[${this.prefix}] [WARN] [${timestamp}] ${message}${formatData(data)}`);
  }

  /**
   * エラーレベルログ
   * 全環境で出力、Errorオブジェクトはスタックトレースを含む形式に変換
   */
  error(message: string, data?: unknown): void {
    if (!this.shouldLog(LogLevel.ERROR)) {
      return;
    }
    const timestamp = getTimestamp();
    const formattedData = formatErrorData(data);
    console.error(`[${this.prefix}] [ERROR] [${timestamp}] ${message}${formatData(formattedData)}`);
  }
}

/**
 * ロガーファクトリ関数
 * モジュール名を指定してロガーインスタンスを作成
 *
 * @param module - モジュール名
 * @returns Loggerインスタンス
 *
 * @example
 * const logger = createLogger('HealthCheck');
 * logger.info('Health check completed');
 */
export function createLogger(module: string): ILogger {
  return new Logger(module);
}

/**
 * デフォルトのLoggerインスタンス
 */
export const logger = new Logger('MCP');
