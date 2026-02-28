// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LocalStorageProvider テスト
 *
 * テスト対象: LocalStorageProvider
 *
 * このテストは以下を検証します:
 * - ファイルの保存（upload）
 * - ファイルの読み込み（download）
 * - ファイルの削除（delete）
 * - ファイルの存在確認（exists）
 * - ファイル一覧取得（list）
 * - セキュリティ（パストラバーサル防止）
 * - ファイルパーミッション設定
 * - ディレクトリ自動作成
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// テスト対象
import { LocalStorageProvider, StorageError } from '@/services/storage/local-storage.provider';

describe('LocalStorageProvider', () => {
  let provider: LocalStorageProvider;
  let testDir: string;

  beforeEach(async () => {
    // テスト用の一時ディレクトリを作成
    testDir = path.join(os.tmpdir(), `reftrix-test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`);
    await fs.mkdir(testDir, { recursive: true });
    provider = new LocalStorageProvider(testDir);
  });

  afterEach(async () => {
    // テスト用ディレクトリをクリーンアップ
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // クリーンアップ失敗は無視
    }
  });

  describe('constructor', () => {
    it('ベースディレクトリを設定できること', () => {
      const provider = new LocalStorageProvider('/tmp/test-storage');
      expect(provider).toBeInstanceOf(LocalStorageProvider);
    });

    it('環境変数からデフォルトパスを使用できること', async () => {
      // 環境変数が設定されていない場合、デフォルトパスを使用
      const defaultProvider = LocalStorageProvider.createDefault();
      expect(defaultProvider).toBeInstanceOf(LocalStorageProvider);
    });
  });

  describe('upload', () => {
    it('ファイルを保存できること', async () => {
      // Arrange
      const key = 'test-file.txt';
      const data = Buffer.from('Hello, World!');

      // Act
      const result = await provider.upload(key, data);

      // Assert
      expect(result).toContain(testDir);
      expect(result).toContain(key);

      // ファイルが実際に存在することを確認
      const filePath = path.join(testDir, key);
      const fileContent = await fs.readFile(filePath);
      expect(fileContent.toString()).toBe('Hello, World!');
    });

    it('サブディレクトリを自動作成すること', async () => {
      // Arrange
      const key = 'subdir/nested/file.txt';
      const data = Buffer.from('Nested content');

      // Act
      await provider.upload(key, data);

      // Assert
      const filePath = path.join(testDir, key);
      const fileContent = await fs.readFile(filePath);
      expect(fileContent.toString()).toBe('Nested content');
    });

    it('バイナリデータを保存できること', async () => {
      // Arrange
      const key = 'binary-file.bin';
      const data = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);

      // Act
      await provider.upload(key, data);

      // Assert
      const filePath = path.join(testDir, key);
      const fileContent = await fs.readFile(filePath);
      expect(fileContent).toEqual(data);
    });

    it('大きなファイルを保存できること', async () => {
      // Arrange
      const key = 'large-file.bin';
      const data = Buffer.alloc(1024 * 1024, 'x'); // 1MB

      // Act
      await provider.upload(key, data);

      // Assert
      const filePath = path.join(testDir, key);
      const stats = await fs.stat(filePath);
      expect(stats.size).toBe(1024 * 1024);
    });
  });

  describe('download', () => {
    it('保存したファイルを読み込めること', async () => {
      // Arrange
      const key = 'download-test.txt';
      const originalData = Buffer.from('Test content for download');
      await provider.upload(key, originalData);

      // Act
      const result = await provider.download(key);

      // Assert
      expect(result.toString()).toBe('Test content for download');
    });

    it('存在しないファイルでエラーをスローすること', async () => {
      // Arrange
      const key = 'non-existent.txt';

      // Act & Assert
      await expect(provider.download(key)).rejects.toThrow();
    });

    it('バイナリデータを正確に読み込めること', async () => {
      // Arrange
      const key = 'binary-download.bin';
      const originalData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      await provider.upload(key, originalData);

      // Act
      const result = await provider.download(key);

      // Assert
      expect(result).toEqual(originalData);
    });
  });

  describe('delete', () => {
    it('ファイルを削除できること', async () => {
      // Arrange
      const key = 'delete-test.txt';
      await provider.upload(key, Buffer.from('To be deleted'));

      // Act
      await provider.delete(key);

      // Assert
      const filePath = path.join(testDir, key);
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('存在しないファイルの削除でエラーをスローすること', async () => {
      // Arrange
      const key = 'non-existent-delete.txt';

      // Act & Assert
      await expect(provider.delete(key)).rejects.toThrow();
    });
  });

  describe('exists', () => {
    it('存在するファイルでtrueを返すこと', async () => {
      // Arrange
      const key = 'exists-test.txt';
      await provider.upload(key, Buffer.from('Exists'));

      // Act
      const result = await provider.exists(key);

      // Assert
      expect(result).toBe(true);
    });

    it('存在しないファイルでfalseを返すこと', async () => {
      // Arrange
      const key = 'not-exists.txt';

      // Act
      const result = await provider.exists(key);

      // Assert
      expect(result).toBe(false);
    });

    it('ディレクトリに対してfalseを返すこと', async () => {
      // Arrange
      const dirPath = path.join(testDir, 'test-dir');
      await fs.mkdir(dirPath, { recursive: true });

      // Act
      const result = await provider.exists('test-dir');

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('list', () => {
    it('ファイル一覧を取得できること', async () => {
      // Arrange
      await provider.upload('file1.txt', Buffer.from('1'));
      await provider.upload('file2.txt', Buffer.from('2'));
      await provider.upload('file3.txt', Buffer.from('3'));

      // Act
      const result = await provider.list();

      // Assert
      expect(result).toHaveLength(3);
      expect(result).toContain('file1.txt');
      expect(result).toContain('file2.txt');
      expect(result).toContain('file3.txt');
    });

    it('プレフィックスでフィルタできること', async () => {
      // Arrange
      await provider.upload('backup/file1.txt', Buffer.from('1'));
      await provider.upload('backup/file2.txt', Buffer.from('2'));
      await provider.upload('other/file3.txt', Buffer.from('3'));

      // Act
      const result = await provider.list('backup');

      // Assert
      expect(result).toHaveLength(2);
      expect(result).toContain('backup/file1.txt');
      expect(result).toContain('backup/file2.txt');
      expect(result).not.toContain('other/file3.txt');
    });

    it('空のディレクトリで空配列を返すこと', async () => {
      // Act
      const result = await provider.list();

      // Assert
      expect(result).toEqual([]);
    });

    it('存在しないプレフィックスで空配列を返すこと', async () => {
      // Arrange
      await provider.upload('file1.txt', Buffer.from('1'));

      // Act
      const result = await provider.list('nonexistent');

      // Assert
      expect(result).toEqual([]);
    });

    it('ネストしたファイルも一覧に含むこと', async () => {
      // Arrange
      await provider.upload('level1/level2/file.txt', Buffer.from('nested'));

      // Act
      const result = await provider.list('level1');

      // Assert
      expect(result).toContain('level1/level2/file.txt');
    });
  });

  describe('セキュリティ: パストラバーサル防止', () => {
    it('../を含むキーを拒否すること', async () => {
      // Arrange
      const maliciousKey = '../etc/passwd';
      const data = Buffer.from('malicious');

      // Act & Assert
      try {
        await provider.upload(maliciousKey, data);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe('PATH_TRAVERSAL');
      }
    });

    it('./を含むキーを拒否すること', async () => {
      // Arrange
      const maliciousKey = './hidden';
      const data = Buffer.from('malicious');

      // Act & Assert
      try {
        await provider.upload(maliciousKey, data);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe('PATH_TRAVERSAL');
      }
    });

    it('絶対パスを拒否すること', async () => {
      // Arrange
      const maliciousKey = '/etc/passwd';
      const data = Buffer.from('malicious');

      // Act & Assert
      try {
        await provider.upload(maliciousKey, data);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe('PATH_TRAVERSAL');
      }
    });

    it('エンコードされたパストラバーサルを拒否すること', async () => {
      // Arrange
      const maliciousKey = '..%2F..%2Fetc%2Fpasswd';
      const data = Buffer.from('malicious');

      // Act & Assert
      try {
        await provider.upload(maliciousKey, data);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe('PATH_TRAVERSAL');
      }
    });

    it('download時もパストラバーサルを拒否すること', async () => {
      // Arrange
      const maliciousKey = '../etc/passwd';

      // Act & Assert
      try {
        await provider.download(maliciousKey);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe('PATH_TRAVERSAL');
      }
    });

    it('delete時もパストラバーサルを拒否すること', async () => {
      // Arrange
      const maliciousKey = '../etc/passwd';

      // Act & Assert
      try {
        await provider.delete(maliciousKey);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe('PATH_TRAVERSAL');
      }
    });

    it('exists時もパストラバーサルを拒否すること', async () => {
      // Arrange
      const maliciousKey = '../etc/passwd';

      // Act & Assert
      try {
        await provider.exists(maliciousKey);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe('PATH_TRAVERSAL');
      }
    });

    it('list時もパストラバーサルを拒否すること', async () => {
      // Arrange
      const maliciousPrefix = '../etc';

      // Act & Assert
      try {
        await provider.list(maliciousPrefix);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe('PATH_TRAVERSAL');
      }
    });
  });

  describe('ファイルパーミッション', () => {
    it('作成されたファイルが適切なパーミッションを持つこと', async () => {
      // Arrange
      const key = 'permission-test.txt';
      const data = Buffer.from('Permission test');

      // Act
      await provider.upload(key, data);

      // Assert
      const filePath = path.join(testDir, key);
      const stats = await fs.stat(filePath);

      // 0600 (owner read/write only) を期待
      // Linuxでは mode & 0o777 でパーミッションビットを取得
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('エラーハンドリング', () => {
    it('書き込み権限がない場合にエラーをスローすること', async () => {
      // Arrange: 読み取り専用ディレクトリを作成
      const readOnlyDir = path.join(testDir, 'readonly');
      await fs.mkdir(readOnlyDir);
      await fs.chmod(readOnlyDir, 0o444);

      const readOnlyProvider = new LocalStorageProvider(readOnlyDir);
      const key = 'test.txt';
      const data = Buffer.from('test');

      // Act & Assert
      await expect(readOnlyProvider.upload(key, data)).rejects.toThrow();

      // Cleanup: 権限を戻してから削除
      await fs.chmod(readOnlyDir, 0o755);
    });

    it('空のキーを拒否すること', async () => {
      // Arrange
      const emptyKey = '';
      const data = Buffer.from('test');

      // Act & Assert
      try {
        await provider.upload(emptyKey, data);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe('INVALID_KEY');
      }
    });

    it('空白のみのキーを拒否すること', async () => {
      // Arrange
      const whitespaceKey = '   ';
      const data = Buffer.from('test');

      // Act & Assert
      try {
        await provider.upload(whitespaceKey, data);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe('INVALID_KEY');
      }
    });
  });

  describe('統合シナリオ', () => {
    it('完全なCRUDフローが動作すること', async () => {
      const key = 'crud-test.txt';
      const data = Buffer.from('CRUD test data');

      // Create
      await provider.upload(key, data);
      expect(await provider.exists(key)).toBe(true);

      // Read
      const readData = await provider.download(key);
      expect(readData.toString()).toBe('CRUD test data');

      // Update (overwrite)
      const updatedData = Buffer.from('Updated data');
      await provider.upload(key, updatedData);
      const readUpdated = await provider.download(key);
      expect(readUpdated.toString()).toBe('Updated data');

      // Delete
      await provider.delete(key);
      expect(await provider.exists(key)).toBe(false);
    });

    it('複数ファイルの管理ができること', async () => {
      // 複数ファイルを作成
      const files = [
        { key: 'backups/2024/01/backup1.sql.gz', data: Buffer.from('backup1') },
        { key: 'backups/2024/01/backup2.sql.gz', data: Buffer.from('backup2') },
        { key: 'backups/2024/02/backup3.sql.gz', data: Buffer.from('backup3') },
        { key: 'exports/data.json', data: Buffer.from('export') },
      ];

      for (const file of files) {
        await provider.upload(file.key, file.data);
      }

      // 一覧取得
      const allFiles = await provider.list();
      expect(allFiles).toHaveLength(4);

      // プレフィックスでフィルタ
      const jan2024 = await provider.list('backups/2024/01');
      expect(jan2024).toHaveLength(2);

      const backups = await provider.list('backups');
      expect(backups).toHaveLength(3);

      // 個別ファイルを読み込み
      for (const file of files) {
        const content = await provider.download(file.key);
        expect(content.toString()).toBe(file.data.toString());
      }
    });
  });
});
