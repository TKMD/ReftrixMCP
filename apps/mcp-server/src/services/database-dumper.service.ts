// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DatabaseDumper サービス
 *
 * PostgreSQL pg_dump / psql を使用したデータベースダンプ・リストアサービス。
 *
 * セキュリティ要件:
 * - パスワードはコマンドライン引数に含めず、PGPASSWORD環境変数を使用
 * - 一時ファイル使用時は0600パーミッション
 * - SQLインジェクション対策
 * - additionalArgsはホワイトリストで検証
 *
 * PostgreSQL 16対応
 */

import { spawn, execSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { Logger } from '../utils/logger';

const logger = new Logger('DatabaseDumper');

// =============================================================================
// 型定義
// =============================================================================

/**
 * データベース接続情報
 */
export interface DatabaseConnectionInfo {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslmode?: string;
}

/**
 * ダンプオプション
 */
export interface DumpOptions {
  /** スキーマのみダンプ（データなし） */
  schemaOnly?: boolean;
  /** データのみダンプ（スキーマなし） */
  dataOnly?: boolean;
  /** 特定テーブルのみダンプ */
  tables?: string[];
  /** 特定テーブルを除外 */
  excludeTables?: string[];
  /** ラージオブジェクト(LOB)を含める */
  includeLargeObjects?: boolean;
  /** タイムアウト（ミリ秒） */
  timeoutMs?: number;
  /** 追加オプション */
  additionalArgs?: string[];
}

/**
 * リストアオプション
 */
export interface RestoreOptions {
  /** 外部キー制約を一時的に無効化 */
  disableForeignKeys?: boolean;
  /** トランザクション内で実行しない */
  noTransaction?: boolean;
  /** タイムアウト（ミリ秒） */
  timeoutMs?: number;
}

/**
 * 可用性チェック結果
 */
export interface AvailabilityResult {
  pgDump: boolean;
  pgDumpVersion?: string;
  psql: boolean;
  psqlVersion?: string;
}

// =============================================================================
// カスタムエラー
// =============================================================================

/**
 * DATABASE_URL パースエラー
 */
export class DatabaseUrlParseError extends Error {
  constructor(message: string, public readonly url?: string) {
    super(message);
    this.name = 'DatabaseUrlParseError';
  }
}

/**
 * pg_dump が見つからないエラー
 */
export class PgDumpNotFoundError extends Error {
  constructor(message = 'pg_dump command not found. Please install PostgreSQL client tools.') {
    super(message);
    this.name = 'PgDumpNotFoundError';
  }
}

/**
 * ダンプエラー
 */
export class DumpError extends Error {
  constructor(
    message: string,
    public readonly stderr?: string,
    public readonly exitCode?: number
  ) {
    super(message);
    this.name = 'DumpError';
  }
}

/**
 * リストアエラー
 */
export class RestoreError extends Error {
  constructor(
    message: string,
    public readonly stderr?: string,
    public readonly exitCode?: number
  ) {
    super(message);
    this.name = 'RestoreError';
  }
}

/**
 * 接続エラー
 */
export class ConnectionError extends Error {
  constructor(message: string, public readonly stderr?: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/**
 * タイムアウトエラー
 */
export class TimeoutError extends Error {
  constructor(
    message: string,
    public readonly timeoutMs: number
  ) {
    super(message);
    this.name = 'TimeoutError';
  }
}

// =============================================================================
// ユーティリティ関数
// =============================================================================

/**
 * DATABASE_URL をパースして接続情報を抽出
 *
 * @param url DATABASE_URL (postgresql:// または postgres://)
 * @returns データベース接続情報
 * @throws DatabaseUrlParseError
 */
export function parseDatabaseUrl(url: string): DatabaseConnectionInfo {
  if (!url || typeof url !== 'string') {
    throw new DatabaseUrlParseError('DATABASE_URL is required');
  }

  // postgresql:// または postgres:// で始まる必要がある
  if (!url.startsWith('postgresql://') && !url.startsWith('postgres://')) {
    throw new DatabaseUrlParseError(
      'DATABASE_URL must start with postgresql:// or postgres://',
      url
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DatabaseUrlParseError('Invalid DATABASE_URL format', url);
  }

  // ユーザー名は必須
  if (!parsed.username) {
    throw new DatabaseUrlParseError('DATABASE_URL must include username', url);
  }

  // データベース名を抽出（先頭の / を除去）
  const database = parsed.pathname.slice(1);
  if (!database) {
    throw new DatabaseUrlParseError('DATABASE_URL must include database name', url);
  }

  // パスワードをデコード（URLエンコードされている場合）
  const password = decodeURIComponent(parsed.password || '');

  // SSLモードを抽出
  const sslmode = parsed.searchParams.get('sslmode');

  const result: DatabaseConnectionInfo = {
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : 5432,
    database,
    user: parsed.username,
    password,
  };

  if (sslmode) {
    result.sslmode = sslmode;
  }

  return result;
}

/**
 * 接続エラーかどうか判定
 */
function isConnectionError(stderr: string): boolean {
  const connectionErrorPatterns = [
    /connection.*refused/i,
    /could not connect/i,
    /connection to server.*failed/i,
    /no route to host/i,
    /host.*not found/i,
    /authentication failed/i,
    /password authentication failed/i,
  ];

  return connectionErrorPatterns.some((pattern) => pattern.test(stderr));
}

// =============================================================================
// DatabaseDumperService クラス
// =============================================================================

/**
 * データベースダンパーサービス
 *
 * pg_dump / psql コマンドを使用してPostgreSQLデータベースの
 * ダンプとリストアを行います。
 *
 * @example
 * ```typescript
 * const service = new DatabaseDumperService();
 *
 * // 可用性チェック
 * const available = await service.isAvailable();
 * if (!available.pgDump) {
 *   throw new Error('pg_dump not installed');
 * }
 *
 * // ダンプ
 * const sql = await service.dump(process.env.DATABASE_URL!);
 *
 * // リストア
 * await service.restore(process.env.DATABASE_URL!, sql);
 * ```
 */
export class DatabaseDumperService {
  /** デフォルトタイムアウト: 5分 */
  private static readonly DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

  /**
   * 許可する追加引数のホワイトリスト
   * セキュリティ対策: 任意の引数を許可するとコマンドインジェクションの可能性
   */
  private static readonly ALLOWED_ADDITIONAL_ARGS = new Set([
    // 出力制御
    '--no-owner',
    '--no-acl',
    '--no-comments',
    '--no-publications',
    '--no-security-labels',
    '--no-subscriptions',
    '--no-tablespaces',
    '--no-privileges',
    // データ形式
    '--inserts',
    '--column-inserts',
    '--rows-per-insert',
    // クリーンアップ
    '--clean',
    '--if-exists',
    '--create',
    // 圧縮
    '--compress',
    // その他安全なオプション
    '--no-synchronized-snapshots',
    '--no-unlogged-table-data',
    '--quote-all-identifiers',
    '--serializable-deferrable',
    '--snapshot',
    '--strict-names',
    '--use-set-session-authorization',
    '--verbose',
  ]);

  /**
   * データベースをダンプしてSQL文字列を返す
   *
   * @param databaseUrl DATABASE_URL
   * @param options ダンプオプション
   * @returns ダンプされたSQL
   * @throws DatabaseUrlParseError, PgDumpNotFoundError, ConnectionError, TimeoutError, DumpError
   */
  async dump(databaseUrl: string, options: DumpOptions = {}): Promise<string> {
    const connInfo = parseDatabaseUrl(databaseUrl);
    const timeoutMs = options.timeoutMs ?? DatabaseDumperService.DEFAULT_TIMEOUT_MS;

    // pg_dump コマンド引数を構築
    const args = this.buildDumpArgs(connInfo, options);

    logger.debug('Executing pg_dump', { host: connInfo.host, database: connInfo.database });

    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      // 環境変数にパスワードを設定（コマンドライン引数には含めない）
      const env: typeof process.env = {
        ...process.env,
        PGPASSWORD: connInfo.password,
      };

      // SSLモード設定
      if (connInfo.sslmode) {
        env.PGSSLMODE = connInfo.sslmode;
      }

      const spawnOptions: SpawnOptions = {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      };

      let child: ChildProcess;
      try {
        child = spawn('pg_dump', args, spawnOptions);
      } catch {
        reject(new PgDumpNotFoundError());
        return;
      }

      // タイムアウト設定
      const timeoutId = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGTERM');
          reject(new TimeoutError(`pg_dump timed out after ${timeoutMs}ms`, timeoutMs));
        }
      }, timeoutMs);

      // stdout 収集
      child.stdout?.on('data', (data: Buffer) => {
        chunks.push(data);
      });

      // stderr 収集
      child.stderr?.on('data', (data: Buffer) => {
        stderrChunks.push(data);
      });

      // エラーハンドリング
      child.on('error', (err: Error & { code?: string }) => {
        clearTimeout(timeoutId);
        if (err.code === 'ENOENT' || err.message.includes('ENOENT')) {
          reject(new PgDumpNotFoundError());
        } else {
          reject(new DumpError(`pg_dump failed: ${err.message}`));
        }
      });

      // 終了ハンドリング
      child.on('close', (code) => {
        clearTimeout(timeoutId);

        const stderr = Buffer.concat(stderrChunks).toString();

        if (code === 0) {
          const stdout = Buffer.concat(chunks).toString();
          logger.debug('pg_dump completed', { bytes: stdout.length });
          resolve(stdout);
        } else {
          // エラー分類
          if (isConnectionError(stderr)) {
            reject(new ConnectionError(`Failed to connect to database: ${stderr}`, stderr));
          } else {
            reject(new DumpError(`pg_dump exited with code ${code}`, stderr, code ?? undefined));
          }
        }
      });
    });
  }

  /**
   * SQLをデータベースにリストア
   *
   * @param databaseUrl DATABASE_URL
   * @param sqlContent リストアするSQL
   * @param options リストアオプション
   * @throws DatabaseUrlParseError, RestoreError, ConnectionError, TimeoutError
   */
  async restore(
    databaseUrl: string,
    sqlContent: string,
    options: RestoreOptions = {}
  ): Promise<void> {
    const connInfo = parseDatabaseUrl(databaseUrl);
    const timeoutMs = options.timeoutMs ?? DatabaseDumperService.DEFAULT_TIMEOUT_MS;

    // psql コマンド引数を構築
    const args = this.buildRestoreArgs(connInfo);

    logger.debug('Executing psql restore', { host: connInfo.host, database: connInfo.database });

    return new Promise<void>((resolve, reject) => {
      const stderrChunks: Buffer[] = [];

      // 環境変数にパスワードを設定
      const env: typeof process.env = {
        ...process.env,
        PGPASSWORD: connInfo.password,
      };

      if (connInfo.sslmode) {
        env.PGSSLMODE = connInfo.sslmode;
      }

      const spawnOptions: SpawnOptions = {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      };

      let child: ChildProcess;
      try {
        child = spawn('psql', args, spawnOptions);
      } catch {
        reject(new RestoreError('psql command not found. Please install PostgreSQL client tools.'));
        return;
      }

      // タイムアウト設定
      const timeoutId = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGTERM');
          reject(new TimeoutError(`psql restore timed out after ${timeoutMs}ms`, timeoutMs));
        }
      }, timeoutMs);

      // stderr 収集
      child.stderr?.on('data', (data: Buffer) => {
        stderrChunks.push(data);
      });

      // エラーハンドリング
      child.on('error', (err: Error & { code?: string }) => {
        clearTimeout(timeoutId);
        if (err.code === 'ENOENT' || err.message.includes('ENOENT')) {
          reject(new RestoreError('psql command not found. Please install PostgreSQL client tools.'));
        } else {
          reject(new RestoreError(`psql failed: ${err.message}`));
        }
      });

      // 終了ハンドリング
      child.on('close', (code) => {
        clearTimeout(timeoutId);

        const stderr = Buffer.concat(stderrChunks).toString();

        if (code === 0) {
          logger.debug('psql restore completed');
          resolve();
        } else {
          // エラー分類
          if (isConnectionError(stderr)) {
            reject(new ConnectionError(`Failed to connect to database: ${stderr}`, stderr));
          } else {
            reject(new RestoreError(`psql exited with code ${code}`, stderr, code ?? undefined));
          }
        }
      });

      // SQLをstdinに書き込む
      const wrappedSql = this.wrapSqlForRestore(sqlContent, options);
      child.stdin?.write(wrappedSql);
      child.stdin?.end();
    });
  }

  /**
   * pg_dump / psql の可用性をチェック
   *
   * @returns 可用性チェック結果
   */
  async isAvailable(): Promise<AvailabilityResult> {
    const result: AvailabilityResult = {
      pgDump: false,
      psql: false,
    };

    // SEC-H3: execSyncのバージョンチェック
    // ハードコードされたコマンド文字列のみ（ユーザー入力なし、インジェクション不可）
    // pg_dump チェック
    try {
      const pgDumpOutput = execSync('pg_dump --version', { encoding: 'utf8' });
      result.pgDump = true;
      result.pgDumpVersion = this.extractVersion(pgDumpOutput);
    } catch {
      result.pgDump = false;
    }

    // psql チェック
    try {
      const psqlOutput = execSync('psql --version', { encoding: 'utf8' });
      result.psql = true;
      result.psqlVersion = this.extractVersion(psqlOutput);
    } catch {
      result.psql = false;
    }

    return result;
  }

  // ===========================================================================
  // プライベートメソッド
  // ===========================================================================

  /**
   * pg_dump コマンド引数を構築
   */
  private buildDumpArgs(connInfo: DatabaseConnectionInfo, options: DumpOptions): string[] {
    const args: string[] = [
      `--host=${connInfo.host}`,
      `--port=${connInfo.port}`,
      `--username=${connInfo.user}`,
      `--dbname=${connInfo.database}`,
      '--format=plain',
      '--no-password', // PGPASSWORD環境変数を使用
    ];

    // オプション処理
    if (options.schemaOnly) {
      args.push('--schema-only');
    }

    if (options.dataOnly) {
      args.push('--data-only');
    }

    if (options.tables && options.tables.length > 0) {
      for (const table of options.tables) {
        // SQLインジェクション対策: テーブル名のバリデーション
        if (this.isValidIdentifier(table)) {
          args.push(`--table=${table}`);
        } else {
          logger.warn('Invalid table name skipped', { table });
        }
      }
    }

    if (options.excludeTables && options.excludeTables.length > 0) {
      for (const table of options.excludeTables) {
        if (this.isValidIdentifier(table)) {
          args.push(`--exclude-table=${table}`);
        } else {
          logger.warn('Invalid exclude table name skipped', { table });
        }
      }
    }

    if (options.includeLargeObjects) {
      args.push('--blobs');
    }

    if (options.additionalArgs) {
      for (const arg of options.additionalArgs) {
        // 引数の基本部分を抽出（--compress=9 → --compress）
        const baseArg = arg.split('=')[0];
        if (baseArg && DatabaseDumperService.ALLOWED_ADDITIONAL_ARGS.has(baseArg)) {
          args.push(arg);
        } else {
          // セキュリティログ: 許可されていない引数はスキップ
          logger.warn('Skipping disallowed additional arg for security', { arg });
        }
      }
    }

    return args;
  }

  /**
   * psql コマンド引数を構築
   */
  private buildRestoreArgs(connInfo: DatabaseConnectionInfo): string[] {
    return [
      `--host=${connInfo.host}`,
      `--port=${connInfo.port}`,
      `--username=${connInfo.user}`,
      `--dbname=${connInfo.database}`,
      '--no-password', // PGPASSWORD環境変数を使用
      '--quiet',
      '-v', 'ON_ERROR_STOP=1', // エラー時に停止
    ];
  }

  /**
   * リストア用にSQLをラップ
   */
  private wrapSqlForRestore(sql: string, options: RestoreOptions): string {
    const parts: string[] = [];

    // トランザクション開始
    if (!options.noTransaction) {
      parts.push('BEGIN;');
    }

    // 外部キー制約の一時無効化
    if (options.disableForeignKeys) {
      parts.push('SET session_replication_role = replica;');
    }

    // メインSQL
    parts.push(sql);

    // 外部キー制約の再有効化
    if (options.disableForeignKeys) {
      parts.push('SET session_replication_role = DEFAULT;');
    }

    // トランザクションコミット
    if (!options.noTransaction) {
      parts.push('COMMIT;');
    }

    return parts.join('\n');
  }

  /**
   * バージョン文字列を抽出
   */
  private extractVersion(output: string): string {
    // "pg_dump (PostgreSQL) 16.0" -> "16.0"
    const match = output.match(/\d+\.\d+(?:\.\d+)?/);
    return match ? match[0] : output.trim();
  }

  /**
   * 識別子（テーブル名など）が有効かチェック
   *
   * SQLインジェクション対策
   */
  private isValidIdentifier(name: string): boolean {
    // PostgreSQL識別子の規則: 英字、数字、アンダースコア、ドル記号
    // スキーマ.テーブル形式も許可
    return /^[a-zA-Z_][a-zA-Z0-9_$]*(\.[a-zA-Z_][a-zA-Z0-9_$]*)?$/.test(name);
  }
}

// =============================================================================
// デフォルトエクスポート
// =============================================================================

export default DatabaseDumperService;
