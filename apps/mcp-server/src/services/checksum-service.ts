// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SHA-256チェックサムサービス（SEC H-01対応）
 *
 * コンテンツの整合性検証機能を提供します。
 * - SHA-256ハッシュ生成
 * - ファイル整合性検証
 * - タイミング攻撃耐性のあるチェックサム比較
 * - 破損検出
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import { Logger } from '../utils/logger';

const logger = new Logger('ChecksumService');

/**
 * チェックサムサービスインターフェース
 */
export interface ChecksumService {
  /** SHA-256ハッシュ生成 */
  generateHash(data: string | Buffer): string;

  /** ファイルのハッシュ生成（ストリーム処理対応） */
  generateFileHash(filePath: string): Promise<string>;

  /** チェックサム検証（タイミング攻撃耐性） */
  verifyChecksum(data: string | Buffer, expectedHash: string): boolean;

  /** ファイル整合性検証 */
  verifyFileIntegrity(filePath: string, expectedHash: string): Promise<boolean>;
}

/**
 * 破損検出結果
 */
export interface CorruptionDetectionResult {
  isCorrupted: boolean;
  details?: string;
}

/**
 * チェックサム検証エラー
 */
export class ChecksumError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ChecksumError';
  }
}

/**
 * SHA-256ハッシュフォーマットの正規表現
 * 64文字の16進数文字列（小文字）
 */
const SHA256_HASH_REGEX = /^[a-f0-9]{64}$/i;

/**
 * SHA-256チェックサムサービス実装
 *
 * セキュリティ要件:
 * - Node.js crypto モジュール使用
 * - SHA-256アルゴリズム
 * - 小文字16進数出力
 * - 大容量ファイル対応（ストリーム処理）
 * - タイミング攻撃耐性（crypto.timingSafeEqual使用）
 */
export class SHA256ChecksumService implements ChecksumService {
  /**
   * SHA-256ハッシュを生成
   *
   * @param data - ハッシュ化するデータ（文字列またはBuffer）
   * @returns 64文字の小文字16進数ハッシュ文字列
   */
  generateHash(data: string | Buffer): string {
    const dataLength = typeof data === 'string' ? data.length : data.length;
    logger.debug(`Generating SHA-256 hash for ${dataLength} bytes`);

    const hash = crypto.createHash('sha256');

    if (typeof data === 'string') {
      hash.update(data, 'utf-8');
    } else {
      hash.update(data);
    }

    return hash.digest('hex');
  }

  /**
   * テスト互換用: generateSHA256エイリアス
   */
  generateSHA256(content: string | Buffer): string {
    return this.generateHash(content);
  }

  /**
   * ファイルからSHA-256ハッシュを生成（ストリーム処理）
   *
   * 大容量ファイル（100MB+）にも対応するため、ストリーム処理を使用します。
   *
   * @param filePath - ハッシュ化するファイルのパス
   * @returns 64文字の小文字16進数ハッシュ文字列
   * @throws ChecksumError ファイルが存在しない、または読み取り権限がない場合
   */
  async generateFileHash(filePath: string): Promise<string> {
    logger.debug(`Generating file hash for: ${filePath}`);

    // ファイル存在確認
    try {
      await fs.access(filePath, fs.constants.R_OK);
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === 'ENOENT') {
        throw new ChecksumError(`File not found: ${filePath}`, 'FILE_NOT_FOUND');
      }
      if (err.code === 'EACCES') {
        throw new ChecksumError(`Permission denied: ${filePath}`, 'PERMISSION_DENIED');
      }
      throw new ChecksumError(`Failed to access file: ${filePath}`, 'FILE_ACCESS_ERROR');
    }

    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = createReadStream(filePath);

      stream.on('data', (chunk: string | Buffer) => {
        // string | Buffer 両方に対応（型安全性確保）
        if (typeof chunk === 'string') {
          hash.update(chunk, 'utf-8');
        } else {
          hash.update(chunk);
        }
      });

      stream.on('end', () => {
        const digest = hash.digest('hex');
        logger.debug(`File hash generated: ${digest.substring(0, 16)}...`);
        resolve(digest);
      });

      stream.on('error', (err: Error) => {
        logger.error('File hash error', err);
        reject(new ChecksumError(`Failed to read file: ${filePath}`, 'FILE_READ_ERROR'));
      });
    });
  }

  /**
   * チェックサムを検証（タイミング攻撃耐性）
   *
   * crypto.timingSafeEqual を使用してタイミング攻撃を防ぎます。
   *
   * @param data - 検証するデータ
   * @param expectedHash - 期待されるハッシュ値
   * @returns 一致する場合true
   */
  verifyChecksum(data: string | Buffer, expectedHash: string): boolean {
    // 入力検証: ハッシュフォーマットチェック
    if (!this.isValidHashFormat(expectedHash)) {
      logger.debug('Invalid hash format provided');
      return false;
    }

    const actualHash = this.generateHash(data);
    return this.timingSafeCompare(actualHash, expectedHash.toLowerCase());
  }

  /**
   * ファイル整合性を検証
   *
   * @param filePath - 検証するファイルのパス
   * @param expectedHash - 期待されるハッシュ値
   * @returns 整合性が保たれている場合true
   * @throws ChecksumError ファイルアクセスエラーまたは無効なハッシュフォーマット
   */
  async verifyFileIntegrity(filePath: string, expectedHash: string): Promise<boolean> {
    logger.debug(`Verifying file integrity: ${filePath}`);

    // 入力検証: ハッシュフォーマットチェック
    if (!this.isValidHashFormat(expectedHash)) {
      throw new ChecksumError('Invalid checksum format', 'INVALID_FORMAT');
    }

    const actualHash = await this.generateFileHash(filePath);
    const isValid = this.timingSafeCompare(actualHash, expectedHash.toLowerCase());

    logger.debug(`File integrity: ${isValid ? 'valid' : 'invalid'}`);

    return isValid;
  }

  /**
   * チェックサムを比較（タイミング攻撃耐性、大文字小文字無視）
   *
   * @param checksum1 - 比較するチェックサム1
   * @param checksum2 - 比較するチェックサム2
   * @returns 一致する場合true
   * @throws ChecksumError 無効なフォーマットの場合
   */
  compareChecksums(checksum1: string, checksum2: string): boolean {
    // 空文字列の特別処理
    if (checksum1 === '' && checksum2 === '') {
      return true;
    }

    // 入力検証
    if (!this.isValidHashFormat(checksum1) || !this.isValidHashFormat(checksum2)) {
      throw new ChecksumError('Invalid checksum format', 'INVALID_FORMAT');
    }

    return this.timingSafeCompare(checksum1.toLowerCase(), checksum2.toLowerCase());
  }

  /**
   * 破損検出
   *
   * @param originalChecksum - 元のチェックサム
   * @param currentChecksum - 現在のチェックサム
   * @returns 破損検出結果
   */
  detectCorruption(originalChecksum: string, currentChecksum: string): CorruptionDetectionResult {
    // 入力検証
    if (!this.isValidHashFormat(originalChecksum) || !this.isValidHashFormat(currentChecksum)) {
      throw new ChecksumError('Invalid checksum format', 'INVALID_FORMAT');
    }

    const isMatch = this.timingSafeCompare(
      originalChecksum.toLowerCase(),
      currentChecksum.toLowerCase()
    );

    if (isMatch) {
      return {
        isCorrupted: false,
      };
    }

    return {
      isCorrupted: true,
      details: `Checksum mismatch detected - original: ${originalChecksum.substring(0, 16)}..., current: ${currentChecksum.substring(0, 16)}...`,
    };
  }

  /**
   * ハッシュフォーマットの検証
   *
   * @param hash - 検証するハッシュ文字列
   * @returns 有効なSHA-256フォーマットの場合true
   */
  private isValidHashFormat(hash: string): boolean {
    return SHA256_HASH_REGEX.test(hash);
  }

  /**
   * タイミング攻撃耐性のある文字列比較
   *
   * crypto.timingSafeEqual を使用して、比較時間が入力に依存しないようにします。
   *
   * @param a - 比較する文字列1
   * @param b - 比較する文字列2
   * @returns 一致する場合true
   */
  private timingSafeCompare(a: string, b: string): boolean {
    // 長さが異なる場合は即座にfalseを返す（これはtimingSafeEqualの要件）
    // ただし、ハッシュ比較では常に同じ長さ（64文字）になるはず
    if (a.length !== b.length) {
      return false;
    }

    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');

    return crypto.timingSafeEqual(bufA, bufB);
  }
}

/**
 * デフォルトのチェックサムサービスインスタンス
 */
export const checksumService = new SHA256ChecksumService();

/**
 * デフォルトエクスポート
 */
export default SHA256ChecksumService;
