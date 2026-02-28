// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LocalStorageProvider
 *
 * ローカルファイルシステムを使用したストレージプロバイダー。
 * セキュリティ対策（パストラバーサル防止、ファイルパーミッション設定）を実装。
 *
 * @example
 * ```typescript
 * const storage = new LocalStorageProvider('/home/user/.reftrix/storage');
 * await storage.upload('backups/backup1.sql.gz', Buffer.from('data'));
 * const data = await storage.download('backups/backup1.sql.gz');
 * ```
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Logger } from '../../utils/logger';

const logger = new Logger('LocalStorage');

/**
 * ストレージプロバイダーインターフェース
 *
 * backup-service.tsのStorageProviderと互換性を維持
 */
export interface StorageProvider {
  upload(filePath: string, data: Buffer): Promise<string>;
  download(filePath: string): Promise<Buffer>;
  list(prefix?: string): Promise<string[]>;
  delete(filePath: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
}

/**
 * ストレージエラー
 */
export class StorageError extends Error {
  constructor(
    public readonly code: 'PATH_TRAVERSAL' | 'INVALID_KEY' | 'NOT_FOUND' | 'PERMISSION_DENIED' | 'UNKNOWN',
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * LocalStorageProvider設定
 */
export interface LocalStorageProviderOptions {
  /**
   * ファイルパーミッション (デフォルト: 0o600)
   */
  fileMode?: number;

  /**
   * ディレクトリパーミッション (デフォルト: 0o700)
   */
  dirMode?: number;
}

/**
 * デフォルト設定
 */
const DEFAULT_OPTIONS: Required<LocalStorageProviderOptions> = {
  fileMode: 0o600,
  dirMode: 0o700,
};

/**
 * ローカルファイルシステムストレージプロバイダー
 *
 * セキュリティ機能:
 * - パストラバーサル防止
 * - ファイルパーミッション設定 (0600)
 * - ディレクトリ自動作成
 */
export class LocalStorageProvider implements StorageProvider {
  private readonly baseDir: string;
  private readonly options: Required<LocalStorageProviderOptions>;

  /**
   * コンストラクタ
   *
   * @param baseDir ベースディレクトリ（絶対パス）
   * @param options オプション設定
   */
  constructor(baseDir: string, options?: LocalStorageProviderOptions) {
    this.baseDir = path.resolve(baseDir);
    this.options = { ...DEFAULT_OPTIONS, ...options };

    if (process.env.NODE_ENV === 'development') {
      logger.debug('LocalStorageProvider initialized', { baseDir: this.baseDir });
    }
  }

  /**
   * デフォルト設定でプロバイダーを作成
   *
   * 環境変数 REFTRIX_STORAGE_PATH を使用、未設定の場合は ~/.reftrix/storage
   */
  static createDefault(options?: LocalStorageProviderOptions): LocalStorageProvider {
    const storagePath = process.env.REFTRIX_STORAGE_PATH || path.join(os.homedir(), '.reftrix', 'storage');
    return new LocalStorageProvider(storagePath, options);
  }

  /**
   * ファイルをアップロード（保存）
   *
   * @param key ファイルキー（相対パス）
   * @param data ファイルデータ
   * @returns 保存先の完全パス
   * @throws StorageError パストラバーサル、無効なキー、書き込みエラー時
   */
  async upload(key: string, data: Buffer): Promise<string> {
    this.validateKey(key);
    const fullPath = this.getFullPath(key);

    try {
      // ディレクトリを作成
      await fs.mkdir(path.dirname(fullPath), { recursive: true, mode: this.options.dirMode });

      // ファイルを書き込み
      await fs.writeFile(fullPath, data, { mode: this.options.fileMode });

      // パーミッションを明示的に設定（writeFileのmodeオプションはumaskの影響を受けるため）
      await fs.chmod(fullPath, this.options.fileMode);

      if (process.env.NODE_ENV === 'development') {
        logger.debug('File uploaded', { key, size: data.length, path: fullPath });
      }

      return fullPath;
    } catch (error) {
      if (this.isPermissionError(error)) {
        throw new StorageError('PERMISSION_DENIED', `Permission denied: ${key}`, error);
      }
      throw new StorageError('UNKNOWN', `Failed to upload: ${key}`, error);
    }
  }

  /**
   * ファイルをダウンロード（読み込み）
   *
   * @param key ファイルキー（相対パス）
   * @returns ファイルデータ
   * @throws StorageError パストラバーサル、ファイル未存在時
   */
  async download(key: string): Promise<Buffer> {
    this.validateKey(key);
    const fullPath = this.getFullPath(key);

    try {
      const data = await fs.readFile(fullPath);

      if (process.env.NODE_ENV === 'development') {
        logger.debug('File downloaded', { key, size: data.length });
      }

      return data;
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new StorageError('NOT_FOUND', `File not found: ${key}`, error);
      }
      if (this.isPermissionError(error)) {
        throw new StorageError('PERMISSION_DENIED', `Permission denied: ${key}`, error);
      }
      throw new StorageError('UNKNOWN', `Failed to download: ${key}`, error);
    }
  }

  /**
   * ファイルを削除
   *
   * @param key ファイルキー（相対パス）
   * @throws StorageError パストラバーサル、ファイル未存在時
   */
  async delete(key: string): Promise<void> {
    this.validateKey(key);
    const fullPath = this.getFullPath(key);

    try {
      await fs.unlink(fullPath);

      if (process.env.NODE_ENV === 'development') {
        logger.debug('File deleted', { key });
      }
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new StorageError('NOT_FOUND', `File not found: ${key}`, error);
      }
      if (this.isPermissionError(error)) {
        throw new StorageError('PERMISSION_DENIED', `Permission denied: ${key}`, error);
      }
      throw new StorageError('UNKNOWN', `Failed to delete: ${key}`, error);
    }
  }

  /**
   * ファイルの存在確認
   *
   * @param key ファイルキー（相対パス）
   * @returns ファイルが存在し、通常ファイルの場合true
   * @throws StorageError パストラバーサル時
   */
  async exists(key: string): Promise<boolean> {
    this.validateKey(key);
    const fullPath = this.getFullPath(key);

    try {
      const stats = await fs.stat(fullPath);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  /**
   * ファイル一覧を取得
   *
   * @param prefix プレフィックス（ディレクトリパス）
   * @returns ファイルキーの配列
   * @throws StorageError パストラバーサル時
   */
  async list(prefix?: string): Promise<string[]> {
    if (prefix) {
      this.validateKey(prefix);
    }

    const searchDir = prefix ? path.join(this.baseDir, prefix) : this.baseDir;

    try {
      const files = await this.listFilesRecursively(searchDir, this.baseDir);

      if (process.env.NODE_ENV === 'development') {
        logger.debug('Files listed', { prefix, count: files.length });
      }

      return files;
    } catch {
      // ディレクトリが存在しない場合は空配列を返す
      return [];
    }
  }

  /**
   * キーのバリデーション
   *
   * @param key ファイルキー
   * @throws StorageError 無効なキー、パストラバーサル時
   */
  private validateKey(key: string): void {
    // 空のキーをチェック
    if (!key || key.trim() === '') {
      throw new StorageError('INVALID_KEY', 'Key cannot be empty');
    }

    // パストラバーサルをチェック
    if (this.isPathTraversal(key)) {
      throw new StorageError('PATH_TRAVERSAL', `Path traversal detected: ${key}`);
    }
  }

  /**
   * パストラバーサルの検出
   *
   * @param key ファイルキー
   * @returns パストラバーサルの場合true
   */
  private isPathTraversal(key: string): boolean {
    // URLデコード（エンコードされた攻撃を検出）
    const decoded = decodeURIComponent(key);

    // 危険なパターンをチェック
    const dangerousPatterns = [
      /\.\./,           // ..
      /^\.\//,          // ./で始まる
      /^\//,            // 絶対パス
      /^[a-zA-Z]:\\/,   // Windowsドライブレター
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(decoded) || pattern.test(key)) {
        return true;
      }
    }

    // 正規化後のパスがベースディレクトリ外を指すかチェック
    const fullPath = path.resolve(this.baseDir, decoded);
    if (!fullPath.startsWith(this.baseDir + path.sep) && fullPath !== this.baseDir) {
      return true;
    }

    return false;
  }

  /**
   * 完全パスを取得
   *
   * @param key ファイルキー
   * @returns 完全パス
   */
  private getFullPath(key: string): string {
    return path.join(this.baseDir, key);
  }

  /**
   * 再帰的にファイル一覧を取得
   *
   * @param dir 検索ディレクトリ
   * @param baseDir ベースディレクトリ
   * @returns ファイルパスの配列（相対パス）
   */
  private async listFilesRecursively(dir: string, baseDir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isFile()) {
        // ベースディレクトリからの相対パスを計算
        const relativePath = path.relative(baseDir, fullPath);
        files.push(relativePath);
      } else if (entry.isDirectory()) {
        // サブディレクトリを再帰的に探索
        const subFiles = await this.listFilesRecursively(fullPath, baseDir);
        files.push(...subFiles);
      }
    }

    return files;
  }

  /**
   * ファイル未存在エラーかどうかを判定
   */
  private isNotFoundError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT';
  }

  /**
   * パーミッションエラーかどうかを判定
   */
  private isPermissionError(error: unknown): boolean {
    return (
      error instanceof Error &&
      'code' in error &&
      ['EACCES', 'EPERM'].includes((error as { code?: string }).code ?? '')
    );
  }
}

/**
 * デフォルトエクスポート
 */
export default LocalStorageProvider;
