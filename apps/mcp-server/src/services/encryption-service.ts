// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * バックアップ暗号化サービス（SEC H-02対応）
 *
 * AES-256-GCM認証付き暗号化を使用したバックアップデータの保護機能を提供します。
 *
 * セキュリティ要件:
 * - AES-256-GCMアルゴリズム（認証付き暗号化）
 * - 256ビット（32バイト）鍵
 * - 12バイトIV（GCM推奨サイズ）
 * - 16バイト認証タグ（GCM標準）
 * - PBKDF2鍵導出（100,000イテレーション、SHA-512）
 * - IVの再利用禁止（毎回ランダム生成）
 * - タイミング攻撃耐性
 */

import * as crypto from 'crypto';
import { Logger } from '../utils/logger';

const encryptionLogger = new Logger('EncryptionService');
const backupEncryptionLogger = new Logger('BackupEncryptionService');

/**
 * 暗号化結果
 */
export interface EncryptedData {
  /** 暗号文 */
  ciphertext: Buffer;
  /** 初期化ベクトル（12バイト） */
  iv: Buffer;
  /** 認証タグ（16バイト） */
  authTag: Buffer;
}

/**
 * 暗号化結果（レガシーインターフェース互換）
 */
export interface EncryptResult {
  encryptedData: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * バックアップファイルメタデータ
 */
export interface BackupFileMetadata {
  /** 暗号化アルゴリズム */
  algorithm: string;
  /** バージョン（semver形式） */
  version: string;
  /** 作成タイムスタンプ（ISO 8601形式） */
  timestamp: string;
}

/**
 * バックアップファイル作成結果
 */
export interface BackupFileResult {
  /** 暗号化されたバックアップデータ（ヘッダー付き） */
  encrypted: Buffer;
  /** メタデータ */
  metadata: BackupFileMetadata;
}

/**
 * 暗号化サービスインターフェース
 */
export interface IEncryptionService {
  /** AES-256-GCM暗号化 */
  encrypt(data: string | Buffer, key: Buffer): EncryptedData;

  /** 復号化 */
  decrypt(encryptedData: EncryptedData, key: Buffer): Buffer;

  /** 暗号化鍵生成 */
  generateKey(): Buffer;

  /** パスワードからの鍵導出（PBKDF2） */
  deriveKey(password: string, salt: Buffer): Buffer;

  /** ソルト生成 */
  generateSalt(): Buffer;
}

/**
 * 暗号化エラー
 */
export class EncryptionError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/**
 * 定数
 */
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256ビット
const IV_LENGTH = 12; // 96ビット（GCM推奨）
const AUTH_TAG_LENGTH = 16; // 128ビット
const SALT_LENGTH = 16; // 128ビット
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_DIGEST = 'sha512';

/** バックアップファイルマジックナンバー */
const MAGIC_NUMBER = Buffer.from('VBAK', 'utf-8');
/** バックアップファイルバージョン */
const FILE_VERSION = '1.0.0';
/** バージョンバイト数（メジャー.マイナー） */
const VERSION_BYTES = 2;
/** アルゴリズムバイト */
const ALGORITHM_BYTE = 1; // 1 = AES-256-GCM

/**
 * バックアップ暗号化サービス実装
 *
 * Node.js crypto モジュールを使用したAES-256-GCM暗号化を提供します。
 */
export class EncryptionService implements IEncryptionService {
  /**
   * データをAES-256-GCMで暗号化
   *
   * @param data - 暗号化するデータ（文字列またはBuffer）
   * @param key - 256ビット（32バイト）暗号化鍵
   * @returns 暗号化結果（暗号文、IV、認証タグ）
   * @throws EncryptionError 無効な鍵長の場合
   */
  encrypt(data: string | Buffer, key: Buffer): EncryptedData {
    // 鍵長検証
    if (key.length !== KEY_LENGTH) {
      throw new EncryptionError(
        `Invalid key length: expected ${KEY_LENGTH} bytes, got ${key.length} bytes`,
        'INVALID_KEY_LENGTH'
      );
    }

    // データをBufferに変換
    const plaintext = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;

    // IVを毎回ランダム生成（再利用禁止）
    const iv = crypto.randomBytes(IV_LENGTH);

    encryptionLogger.debug(`Encrypting ${plaintext.length} bytes with AES-256-GCM`);

    // 暗号化
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: encrypted,
      iv,
      authTag,
    };
  }

  /**
   * AES-256-GCMで暗号化されたデータを復号化
   *
   * @param encryptedData - 暗号化データ（暗号文、IV、認証タグ）
   * @param key - 256ビット（32バイト）復号化鍵
   * @returns 復号化されたデータ
   * @throws EncryptionError 復号化失敗（認証エラー、改ざん検出）
   */
  decrypt(encryptedData: EncryptedData, key: Buffer): Buffer {
    // 鍵長検証
    if (key.length !== KEY_LENGTH) {
      throw new EncryptionError(
        `Invalid key length: expected ${KEY_LENGTH} bytes, got ${key.length} bytes`,
        'INVALID_KEY_LENGTH'
      );
    }

    const { ciphertext, iv, authTag } = encryptedData;

    encryptionLogger.debug(`Decrypting ${ciphertext.length} bytes with AES-256-GCM`);

    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      return decrypted;
    } catch (error) {
      encryptionLogger.error('Decryption failed', error);
      throw new EncryptionError('Decryption failed: authentication error or data tampered', 'DECRYPTION_FAILED');
    }
  }

  /**
   * 256ビット（32バイト）のランダム暗号化鍵を生成
   *
   * @returns 安全に生成された暗号化鍵
   */
  generateKey(): Buffer {
    encryptionLogger.debug('Generating 256-bit random key');
    return crypto.randomBytes(KEY_LENGTH);
  }

  /**
   * パスワードからPBKDF2を使用して鍵を導出
   *
   * @param password - ユーザーパスワード
   * @param salt - ランダムソルト（16バイト推奨）
   * @returns 導出された256ビット鍵
   */
  deriveKey(password: string, salt: Buffer): Buffer {
    encryptionLogger.debug(
      `Deriving key with PBKDF2 (${PBKDF2_ITERATIONS} iterations, ${PBKDF2_DIGEST})`
    );

    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
  }

  /**
   * ランダムソルトを生成
   *
   * @returns 16バイトのランダムソルト
   */
  generateSalt(): Buffer {
    return crypto.randomBytes(SALT_LENGTH);
  }
}

/**
 * バックアップ暗号化サービス（拡張版）
 *
 * バックアップファイル形式の作成・復元機能を含むサービスです。
 * テストとの互換性のため、レガシーインターフェースもサポートします。
 */
export class BackupEncryptionService extends EncryptionService {
  /**
   * 暗号化（レガシーインターフェース互換）
   *
   * @param data - 暗号化するデータ
   * @param key - 暗号化鍵
   * @returns レガシー形式の暗号化結果
   */
  encryptLegacy(data: Buffer, key: Buffer): EncryptResult {
    const result = this.encrypt(data, key);
    return {
      encryptedData: result.ciphertext,
      iv: result.iv,
      authTag: result.authTag,
    };
  }

  /**
   * 復号化（レガシーインターフェース互換）
   *
   * @param encryptedData - 暗号文
   * @param key - 復号化鍵
   * @param iv - 初期化ベクトル
   * @param authTag - 認証タグ
   * @returns 復号化されたデータ
   */
  decryptLegacy(encryptedData: Buffer, key: Buffer, iv: Buffer, authTag: Buffer): Buffer {
    return this.decrypt(
      {
        ciphertext: encryptedData,
        iv,
        authTag,
      },
      key
    );
  }

  /**
   * パスワードから鍵を導出（レガシーインターフェース互換）
   *
   * @param password - パスワード
   * @param salt - ソルト
   * @returns 導出された鍵
   */
  deriveKeyFromPassword(password: string, salt: Buffer): Buffer {
    return this.deriveKey(password, salt);
  }

  /**
   * 暗号化バックアップファイルを作成
   *
   * ファイル形式:
   * [4 bytes: magic number 'VBAK']
   * [2 bytes: version (major.minor)]
   * [1 byte: algorithm (1 = AES-256-GCM)]
   * [16 bytes: salt]
   * [12 bytes: IV]
   * [16 bytes: auth tag]
   * [remaining: encrypted data]
   *
   * @param data - バックアップデータ
   * @param password - 暗号化パスワード
   * @returns バックアップファイル作成結果
   */
  createBackupFile(data: Buffer, password: string): BackupFileResult {
    backupEncryptionLogger.debug(`Creating backup file (${data.length} bytes)`);

    // ソルト生成
    const salt = this.generateSalt();

    // パスワードから鍵を導出
    const key = this.deriveKey(password, salt);

    // データを暗号化
    const encrypted = this.encrypt(data, key);

    // ヘッダー構築
    const versionBuffer = Buffer.alloc(VERSION_BYTES);
    const [major, minor] = FILE_VERSION.split('.').map(Number);
    versionBuffer.writeUInt8(major ?? 1, 0);
    versionBuffer.writeUInt8(minor ?? 0, 1);

    const algorithmBuffer = Buffer.alloc(1);
    algorithmBuffer.writeUInt8(ALGORITHM_BYTE, 0);

    // ファイル全体を結合
    const backupFile = Buffer.concat([
      MAGIC_NUMBER, // 4 bytes
      versionBuffer, // 2 bytes
      algorithmBuffer, // 1 byte
      salt, // 16 bytes
      encrypted.iv, // 12 bytes
      encrypted.authTag, // 16 bytes
      encrypted.ciphertext, // remaining
    ]);

    const timestamp = new Date().toISOString();

    backupEncryptionLogger.debug(`Backup file created: ${backupFile.length} bytes`);

    return {
      encrypted: backupFile,
      metadata: {
        algorithm: ALGORITHM,
        version: FILE_VERSION,
        timestamp,
      },
    };
  }

  /**
   * 暗号化バックアップファイルを復元
   *
   * @param encryptedBackup - 暗号化されたバックアップファイル
   * @param password - 復号化パスワード
   * @returns 復元されたデータ
   * @throws EncryptionError 無効なファイル形式、パスワード誤り、改ざん検出
   */
  restoreBackupFile(encryptedBackup: Buffer, password: string): Buffer {
    backupEncryptionLogger.debug(`Restoring backup file (${encryptedBackup.length} bytes)`);

    // 最小サイズチェック（ヘッダー + 最小暗号文）
    const headerSize = 4 + VERSION_BYTES + 1 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
    if (encryptedBackup.length < headerSize) {
      throw new EncryptionError('Invalid backup file: too small', 'INVALID_BACKUP_FORMAT');
    }

    // マジックナンバー検証
    const magic = encryptedBackup.subarray(0, 4);
    if (!magic.equals(MAGIC_NUMBER)) {
      throw new EncryptionError('Invalid backup file: wrong magic number', 'INVALID_MAGIC_NUMBER');
    }

    // ヘッダー解析
    let offset = 4;

    // バージョン（2バイト）- 現在は検証のみ
    // const majorVersion = encryptedBackup.readUInt8(offset);
    // const minorVersion = encryptedBackup.readUInt8(offset + 1);
    offset += VERSION_BYTES;

    // アルゴリズム（1バイト）- 現在は検証のみ
    const algorithmByte = encryptedBackup.readUInt8(offset);
    if (algorithmByte !== ALGORITHM_BYTE) {
      throw new EncryptionError('Unsupported encryption algorithm', 'UNSUPPORTED_ALGORITHM');
    }
    offset += 1;

    // ソルト（16バイト）
    const salt = encryptedBackup.subarray(offset, offset + SALT_LENGTH);
    offset += SALT_LENGTH;

    // IV（12バイト）
    const iv = encryptedBackup.subarray(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;

    // 認証タグ（16バイト）
    const authTag = encryptedBackup.subarray(offset, offset + AUTH_TAG_LENGTH);
    offset += AUTH_TAG_LENGTH;

    // 暗号文（残り）
    const ciphertext = encryptedBackup.subarray(offset);

    // パスワードから鍵を導出
    const key = this.deriveKey(password, salt);

    // 復号化
    try {
      return this.decrypt(
        {
          ciphertext,
          iv,
          authTag,
        },
        key
      );
    } catch (error) {
      if (error instanceof EncryptionError) {
        throw error;
      }
      throw new EncryptionError('Failed to restore backup: wrong password or corrupted data', 'RESTORE_FAILED');
    }
  }
}

/**
 * デフォルトの暗号化サービスインスタンス
 */
export const encryptionService = new EncryptionService();

/**
 * デフォルトのバックアップ暗号化サービスインスタンス
 */
export const backupEncryptionService = new BackupEncryptionService();

/**
 * デフォルトエクスポート
 */
export default BackupEncryptionService;
