// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * バックアップ暗号化テスト（SEC H-02対応）
 *
 * TDD Green フェーズ:
 * - AES-256-GCM暗号化機能
 * - 暗号化・復号化往復テスト
 * - 鍵管理機能
 * - 暗号化バックアップファイル構造検証
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import {
  BackupEncryptionService,
  EncryptionService,
  EncryptionError,
} from '../../src/services/encryption-service';

describe('Backup Encryption Service (SEC H-02)', () => {
  let encryptionService: BackupEncryptionService;

  beforeEach(() => {
    encryptionService = new BackupEncryptionService();
    if (process.env.NODE_ENV === 'development') {
      console.log('[Test] Starting backup encryption tests');
    }
  });

  describe('AES-256-GCM暗号化', () => {
    it('データをAES-256-GCMで暗号化できること', () => {
      const plainData = Buffer.from('sensitive backup data', 'utf-8');
      const key = crypto.randomBytes(32); // 256-bit key

      const result = encryptionService.encryptLegacy(plainData, key);
      expect(result.encryptedData).toBeDefined();
      expect(result.iv).toBeDefined();
      expect(result.authTag).toBeDefined();
      expect(result.iv).toHaveLength(12); // GCMの推奨IV長
      expect(result.authTag).toHaveLength(16); // GCM認証タグ長
    });

    it('暗号化されたデータが平文と異なること', () => {
      const plainData = Buffer.from('test data', 'utf-8');
      const key = crypto.randomBytes(32);

      const result = encryptionService.encryptLegacy(plainData, key);
      expect(result.encryptedData.equals(plainData)).toBe(false);
    });

    it('同じ平文でもIVが異なれば暗号文も異なること', () => {
      const plainData = Buffer.from('test data', 'utf-8');
      const key = crypto.randomBytes(32);

      const result1 = encryptionService.encryptLegacy(plainData, key);
      const result2 = encryptionService.encryptLegacy(plainData, key);

      // IVはランダムなので異なるべき
      expect(result1.iv.equals(result2.iv)).toBe(false);
      // 暗号文も異なるべき
      expect(result1.encryptedData.equals(result2.encryptedData)).toBe(false);
    });

    it('空データを暗号化できること', () => {
      const emptyData = Buffer.alloc(0);
      const key = crypto.randomBytes(32);

      const result = encryptionService.encryptLegacy(emptyData, key);
      expect(result).toBeDefined();
      expect(result.authTag).toBeDefined(); // 認証タグは空データでも生成される
    });

    it('大きなデータ（10MB）を暗号化できること', () => {
      const largeData = Buffer.alloc(10 * 1024 * 1024, 'A');
      const key = crypto.randomBytes(32);

      const result = encryptionService.encryptLegacy(largeData, key);
      expect(result.encryptedData).toBeDefined();
      expect(result.encryptedData.length).toBe(largeData.length);
    });

    it('無効な鍵長でエラーをスローすること', () => {
      const plainData = Buffer.from('test', 'utf-8');
      const invalidKey = Buffer.alloc(16); // 128-bit (AES-256には不足)

      expect(() => {
        encryptionService.encryptLegacy(plainData, invalidKey);
      }).toThrow(EncryptionError);
    });
  });

  describe('AES-256-GCM復号化', () => {
    it('暗号化されたデータを復号化できること', () => {
      const originalData = Buffer.from('original data', 'utf-8');
      const key = crypto.randomBytes(32);

      // 暗号化
      const encrypted = encryptionService.encryptLegacy(originalData, key);

      // 復号化
      const decrypted = encryptionService.decryptLegacy(
        encrypted.encryptedData,
        key,
        encrypted.iv,
        encrypted.authTag
      );

      expect(decrypted.equals(originalData)).toBe(true);
    });

    it('誤った鍵で復号化が失敗すること', () => {
      const originalData = Buffer.from('secret data', 'utf-8');
      const correctKey = Buffer.alloc(32, 'A');
      const wrongKey = Buffer.alloc(32, 'B');

      const encrypted = encryptionService.encryptLegacy(originalData, correctKey);

      // 誤った鍵で復号化を試みる
      expect(() => {
        encryptionService.decryptLegacy(
          encrypted.encryptedData,
          wrongKey,
          encrypted.iv,
          encrypted.authTag
        );
      }).toThrow();
    });

    it('改ざんされたデータで復号化が失敗すること', () => {
      const originalData = Buffer.from('important data', 'utf-8');
      const key = crypto.randomBytes(32);

      const encrypted = encryptionService.encryptLegacy(originalData, key);

      // データを改ざん
      encrypted.encryptedData[0] ^= 0xff;

      // 復号化は認証エラーで失敗すべき
      expect(() => {
        encryptionService.decryptLegacy(
          encrypted.encryptedData,
          key,
          encrypted.iv,
          encrypted.authTag
        );
      }).toThrow();
    });

    it('改ざんされた認証タグで復号化が失敗すること', () => {
      const originalData = Buffer.from('authenticated data', 'utf-8');
      const key = crypto.randomBytes(32);

      const encrypted = encryptionService.encryptLegacy(originalData, key);

      // 認証タグを改ざん
      encrypted.authTag[0] ^= 0xff;

      // 復号化は失敗すべき
      expect(() => {
        encryptionService.decryptLegacy(
          encrypted.encryptedData,
          key,
          encrypted.iv,
          encrypted.authTag
        );
      }).toThrow();
    });

    it('誤ったIVで復号化が失敗すること', () => {
      const originalData = Buffer.from('data with iv', 'utf-8');
      const key = crypto.randomBytes(32);

      const encrypted = encryptionService.encryptLegacy(originalData, key);

      // 誤ったIVを使用
      const wrongIV = Buffer.alloc(12, 0xff);

      expect(() => {
        encryptionService.decryptLegacy(encrypted.encryptedData, key, wrongIV, encrypted.authTag);
      }).toThrow();
    });
  });

  describe('暗号化・復号化往復テスト', () => {
    it('文字列データの往復変換', () => {
      const testCases = [
        'Simple text',
        'UTF-8日本語テキスト',
        'Special chars: !@#$%^&*()',
        'Multi\nline\ntext',
        JSON.stringify({ key: 'value', nested: { data: 123 } }),
      ];

      testCases.forEach((testData) => {
        const key = crypto.randomBytes(32);
        const plainData = Buffer.from(testData, 'utf-8');

        const encrypted = encryptionService.encryptLegacy(plainData, key);
        const decrypted = encryptionService.decryptLegacy(
          encrypted.encryptedData,
          key,
          encrypted.iv,
          encrypted.authTag
        );

        expect(decrypted.toString('utf-8')).toBe(testData);
      });
    });

    it('バイナリデータの往復変換', () => {
      const binaryData = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80]);
      const key = crypto.randomBytes(32);

      const encrypted = encryptionService.encryptLegacy(binaryData, key);
      const decrypted = encryptionService.decryptLegacy(
        encrypted.encryptedData,
        key,
        encrypted.iv,
        encrypted.authTag
      );

      expect(decrypted.equals(binaryData)).toBe(true);
    });

    it('大きなJSONデータの往復変換', () => {
      const largeObject = {
        users: Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          name: `User ${i}`,
          data: `Some data ${i}`,
        })),
      };

      const jsonData = Buffer.from(JSON.stringify(largeObject), 'utf-8');
      const key = crypto.randomBytes(32);

      const encrypted = encryptionService.encryptLegacy(jsonData, key);
      const decrypted = encryptionService.decryptLegacy(
        encrypted.encryptedData,
        key,
        encrypted.iv,
        encrypted.authTag
      );

      const recoveredObject = JSON.parse(decrypted.toString('utf-8'));
      expect(recoveredObject).toEqual(largeObject);
    });
  });

  describe('鍵生成と管理', () => {
    it('256-bit (32バイト) の鍵を生成できること', () => {
      const key = encryptionService.generateKey();
      expect(key).toBeDefined();
      expect(key.length).toBe(32); // 256-bit
    });

    it('生成される鍵が毎回異なること', () => {
      const key1 = encryptionService.generateKey();
      const key2 = encryptionService.generateKey();
      expect(key1.equals(key2)).toBe(false);
    });

    it('パスワードから鍵を導出できること (PBKDF2)', () => {
      const password = 'strong_password_123';
      const salt = Buffer.alloc(16); // 128-bit salt

      const derivedKey = encryptionService.deriveKeyFromPassword(password, salt);
      expect(derivedKey).toBeDefined();
      expect(derivedKey.length).toBe(32); // 256-bit
    });

    it('同じパスワードとsaltから同じ鍵が導出されること', () => {
      const password = 'test_password';
      const salt = Buffer.alloc(16, 'A');

      const key1 = encryptionService.deriveKeyFromPassword(password, salt);
      const key2 = encryptionService.deriveKeyFromPassword(password, salt);
      expect(key1.equals(key2)).toBe(true);
    });

    it('異なるsaltから異なる鍵が導出されること', () => {
      const password = 'test_password';
      const salt1 = Buffer.alloc(16, 'A');
      const salt2 = Buffer.alloc(16, 'B');

      const key1 = encryptionService.deriveKeyFromPassword(password, salt1);
      const key2 = encryptionService.deriveKeyFromPassword(password, salt2);
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('暗号化バックアップファイル構造', () => {
    it('バックアップファイルを作成できること', () => {
      const backupData = Buffer.from('backup content', 'utf-8');
      const password = 'secure_password';

      const result = encryptionService.createBackupFile(backupData, password);
      expect(result.encrypted).toBeDefined();
      expect(result.metadata).toBeDefined();
      expect(result.metadata.algorithm).toBe('aes-256-gcm');
      expect(result.metadata.version).toBeDefined();
      expect(result.metadata.timestamp).toBeDefined();
    });

    it('バックアップファイルのメタデータが正しいこと', () => {
      const backupData = Buffer.from('test backup', 'utf-8');
      const password = 'password123';

      const result = encryptionService.createBackupFile(backupData, password);

      expect(result.metadata.algorithm).toBe('aes-256-gcm');
      expect(result.metadata.version).toMatch(/^\d+\.\d+\.\d+$/); // semver形式
      expect(new Date(result.metadata.timestamp).getTime()).toBeGreaterThan(0);
    });

    it('バックアップファイルを復元できること', () => {
      const originalData = Buffer.from('original backup data', 'utf-8');
      const password = 'restore_password';

      // バックアップ作成
      const backup = encryptionService.createBackupFile(originalData, password);

      // バックアップ復元
      const restored = encryptionService.restoreBackupFile(backup.encrypted, password);

      expect(restored.equals(originalData)).toBe(true);
    });

    it('誤ったパスワードでバックアップ復元が失敗すること', () => {
      const originalData = Buffer.from('secure backup', 'utf-8');
      const correctPassword = 'correct_password';
      const wrongPassword = 'wrong_password';

      const backup = encryptionService.createBackupFile(originalData, correctPassword);

      expect(() => {
        encryptionService.restoreBackupFile(backup.encrypted, wrongPassword);
      }).toThrow();
    });

    it('バックアップファイル構造にヘッダーが含まれること', () => {
      const backupData = Buffer.from('data with header', 'utf-8');
      const password = 'password';

      const result = encryptionService.createBackupFile(backupData, password);

      // ヘッダー形式:
      // [4 bytes: magic number 'VBAK']
      // [2 bytes: version]
      // [1 byte: algorithm]
      // [16 bytes: salt]
      // [12 bytes: IV]
      // [16 bytes: auth tag]
      // [remaining: encrypted data]

      const header = result.encrypted.subarray(0, 4);
      expect(header.toString('utf-8')).toBe('VBAK'); // Reftrix Backup
    });
  });

  describe('実際の暗号化実装（参照実装）', () => {
    it('crypto.createCipherivを使ったAES-256-GCM暗号化', () => {
      const plaintext = 'secret message';
      const key = crypto.randomBytes(32); // 256-bit key
      const iv = crypto.randomBytes(12); // 96-bit IV for GCM

      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

      let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
      encrypted += cipher.final('hex');

      const authTag = cipher.getAuthTag();

      expect(encrypted).toBeDefined();
      expect(authTag).toHaveLength(16);
    });

    it('crypto.createDecipherivを使ったAES-256-GCM復号化', () => {
      const plaintext = 'secret message';
      const key = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);

      // 暗号化
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
      encrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag();

      // 復号化
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
      decrypted += decipher.final('utf-8');

      expect(decrypted).toBe(plaintext);
    });

    it('PBKDF2を使った鍵導出', () => {
      const password = 'user_password';
      const salt = crypto.randomBytes(16);
      const iterations = 100000;
      const keyLength = 32; // 256-bit
      const digest = 'sha256';

      const derivedKey = crypto.pbkdf2Sync(password, salt, iterations, keyLength, digest);

      expect(derivedKey).toHaveLength(32);
    });
  });

  describe('セキュリティ要件（SEC H-02）', () => {
    it('Authenticated Encryption（認証付き暗号化）', () => {
      // GCMモードは認証付き暗号化を提供
      // 改ざん検出が可能

      const plaintext = Buffer.from('authenticated data', 'utf-8');
      const key = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);

      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();

      // データを改ざん
      encrypted[0] ^= 0xff;

      // 復号化は失敗すべき
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);

      expect(() => {
        Buffer.concat([decipher.update(encrypted), decipher.final()]);
      }).toThrow();
    });

    it('IVの再利用禁止（セキュリティリスク）', () => {
      // 同じ鍵とIVの組み合わせを再利用してはいけない
      const key = crypto.randomBytes(32);
      const reusedIV = crypto.randomBytes(12);

      const plaintext1 = 'message 1';
      const plaintext2 = 'message 2';

      // 1回目の暗号化
      const cipher1 = crypto.createCipheriv('aes-256-gcm', key, reusedIV);
      const encrypted1 = Buffer.concat([cipher1.update(plaintext1, 'utf-8'), cipher1.final()]);

      // 2回目の暗号化（同じIVを再利用 - セキュリティリスク）
      const cipher2 = crypto.createCipheriv('aes-256-gcm', key, reusedIV);
      const encrypted2 = Buffer.concat([cipher2.update(plaintext2, 'utf-8'), cipher2.final()]);

      // 暗号文が異なることを確認（平文が異なるため）
      // しかしセキュリティ的にはIV再利用は禁止
      expect(encrypted1.equals(encrypted2)).toBe(false);

      // 正しい実装では毎回新しいIVを生成すべき
      const newIV = crypto.randomBytes(12);
      expect(newIV.equals(reusedIV)).toBe(false);
    });

    it('鍵の安全な保管（環境変数から取得）', () => {
      // 鍵はハードコードせず、環境変数やキー管理サービスから取得
      process.env.BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

      const keyFromEnv = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY!, 'hex');
      expect(keyFromEnv.length).toBe(32);

      delete process.env.BACKUP_ENCRYPTION_KEY;
    });
  });

  describe('新しいEncryptedDataインターフェース', () => {
    it('新しいインターフェースで暗号化・復号化できること', () => {
      const service = new EncryptionService();
      const plainData = Buffer.from('test data with new interface', 'utf-8');
      const key = service.generateKey();

      const encrypted = service.encrypt(plainData, key);
      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.iv).toHaveLength(12);
      expect(encrypted.authTag).toHaveLength(16);

      const decrypted = service.decrypt(encrypted, key);
      expect(decrypted.equals(plainData)).toBe(true);
    });

    it('文字列を直接暗号化できること', () => {
      const service = new EncryptionService();
      const plainText = 'Hello, World! 日本語テスト';
      const key = service.generateKey();

      const encrypted = service.encrypt(plainText, key);
      const decrypted = service.decrypt(encrypted, key);

      expect(decrypted.toString('utf-8')).toBe(plainText);
    });

    it('generateSaltでソルトを生成できること', () => {
      const service = new EncryptionService();

      const salt1 = service.generateSalt();
      const salt2 = service.generateSalt();

      expect(salt1).toHaveLength(16);
      expect(salt2).toHaveLength(16);
      expect(salt1.equals(salt2)).toBe(false);
    });
  });
});
