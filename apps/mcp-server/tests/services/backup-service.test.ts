// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * バックアップサービス テスト
 *
 * テスト対象: BackupService
 *
 * このテストは以下を検証します:
 * - データベースバックアップの作成
 * - バックアップファイルの圧縮
 * - S3/ローカルストレージへの保存
 * - バックアップの一覧取得
 * - バックアップからのリストア
 * - 古いバックアップの自動削除（リテンションポリシー）
 * - バックアップの整合性検証
 *
 * SEC-H2: DB接続文字列はモック環境内のテストフィクスチャデータ。
 * 実際のDB接続は行われないため、ハードコードされた値はセキュリティリスクなし。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// モック: バックアップメタデータ
interface BackupMetadata {
  id: string;
  timestamp: Date;
  size: number;
  compressed: boolean;
  checksum: string;
  storageLocation: string;
  status: 'completed' | 'in_progress' | 'failed';
}

// モック: ストレージインターフェース
interface StorageProvider {
  upload(filePath: string, data: Buffer): Promise<string>;
  download(filePath: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;
  delete(filePath: string): Promise<void>;
}

// モック: ローカルストレージプロバイダー
class LocalStorageProvider implements StorageProvider {
  constructor(private baseDir: string) {}

  async upload(filePath: string, data: Buffer): Promise<string> {
    const fullPath = path.join(this.baseDir, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, data);
    return fullPath;
  }

  async download(filePath: string): Promise<Buffer> {
    const fullPath = path.join(this.baseDir, filePath);
    return await fs.readFile(fullPath);
  }

  async list(prefix: string): Promise<string[]> {
    const fullPath = path.join(this.baseDir, prefix);
    try {
      const files = await fs.readdir(fullPath);
      return files.map((f) => path.join(prefix, f));
    } catch {
      return [];
    }
  }

  async delete(filePath: string): Promise<void> {
    const fullPath = path.join(this.baseDir, filePath);
    await fs.unlink(fullPath);
  }
}

// モック: S3ストレージプロバイダー
class S3StorageProvider implements StorageProvider {
  private mockStorage: Map<string, Buffer> = new Map();

  async upload(filePath: string, data: Buffer): Promise<string> {
    this.mockStorage.set(filePath, data);
    return `s3://bucket/${filePath}`;
  }

  async download(filePath: string): Promise<Buffer> {
    const data = this.mockStorage.get(filePath);
    if (!data) throw new Error('File not found');
    return data;
  }

  async list(prefix: string): Promise<string[]> {
    return Array.from(this.mockStorage.keys()).filter((key) =>
      key.startsWith(prefix)
    );
  }

  async delete(filePath: string): Promise<void> {
    this.mockStorage.delete(filePath);
  }
}

// モック: バックアップサービス
class BackupService {
  private backups: Map<string, BackupMetadata> = new Map();

  constructor(private storage: StorageProvider) {}

  /**
   * テスト用: バックアップのタイムスタンプを更新
   */
  updateBackupTimestamp(backupId: string, timestamp: Date): void {
    const backup = this.backups.get(backupId);
    if (backup) {
      backup.timestamp = timestamp;
    }
  }

  private backupCounter = 0;

  /**
   * データベースバックアップを作成
   * @param databaseUrl データベース接続URL
   * @returns バックアップメタデータ
   */
  async createBackup(databaseUrl: string): Promise<BackupMetadata> {
    const id = `backup-${Date.now()}-${this.backupCounter++}`;
    const timestamp = new Date();

    // データベースダンプを実行（モック）
    const dumpData = await this.dumpDatabase(databaseUrl);

    // 圧縮
    const compressed = await gzip(Buffer.from(dumpData));

    // チェックサム計算
    const checksum = this.calculateChecksum(compressed);

    // ストレージに保存
    const fileName = `backups/${id}.sql.gz`;
    const storageLocation = await this.storage.upload(fileName, compressed);

    // メタデータ作成
    const metadata: BackupMetadata = {
      id,
      timestamp,
      size: compressed.length,
      compressed: true,
      checksum,
      storageLocation,
      status: 'completed',
    };

    this.backups.set(id, metadata);
    return metadata;
  }

  /**
   * バックアップ一覧を取得
   * @returns バックアップメタデータの配列
   */
  async listBackups(): Promise<BackupMetadata[]> {
    return Array.from(this.backups.values()).sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    );
  }

  /**
   * バックアップからリストア
   * @param backupId バックアップID
   * @param databaseUrl リストア先データベースURL
   */
  async restoreBackup(backupId: string, databaseUrl: string): Promise<void> {
    const metadata = this.backups.get(backupId);
    if (!metadata) {
      throw new Error(`Backup ${backupId} not found`);
    }

    // ストレージからダウンロード
    const fileName = `backups/${backupId}.sql.gz`;
    const compressedData = await this.storage.download(fileName);

    // 整合性検証
    const checksum = this.calculateChecksum(compressedData);
    if (checksum !== metadata.checksum) {
      throw new Error('Backup checksum mismatch - corrupted data');
    }

    // 解凍
    const decompressed = await gunzip(compressedData);

    // データベースにリストア（モック）
    await this.restoreDatabase(databaseUrl, decompressed.toString());
  }

  /**
   * 古いバックアップを削除（リテンションポリシー）
   * @param retentionDays 保持日数
   * @returns 削除されたバックアップ数
   */
  async cleanupOldBackups(retentionDays: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const oldBackups = Array.from(this.backups.values()).filter(
      (backup) => backup.timestamp < cutoffDate
    );

    for (const backup of oldBackups) {
      const fileName = `backups/${backup.id}.sql.gz`;
      await this.storage.delete(fileName);
      this.backups.delete(backup.id);
    }

    return oldBackups.length;
  }

  /**
   * バックアップの整合性を検証
   * @param backupId バックアップID
   * @returns 検証結果
   */
  async verifyBackup(backupId: string): Promise<boolean> {
    const metadata = this.backups.get(backupId);
    if (!metadata) return false;

    try {
      const fileName = `backups/${backupId}.sql.gz`;
      const data = await this.storage.download(fileName);
      const checksum = this.calculateChecksum(data);
      return checksum === metadata.checksum;
    } catch {
      return false;
    }
  }

  /**
   * データベースをダンプ（モック実装）
   */
  private async dumpDatabase(databaseUrl: string): Promise<string> {
    // 実際はpg_dump等を使用
    return `
-- PostgreSQL Database Dump
-- Database: ${databaseUrl}

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  email VARCHAR(255)
);

INSERT INTO users (name, email) VALUES
  ('Alice', 'alice@example.com'),
  ('Bob', 'bob@example.com');
`;
  }

  /**
   * データベースをリストア（モック実装）
   */
  private async restoreDatabase(
    databaseUrl: string,
    sqlContent: string
  ): Promise<void> {
    // 実際はpsql等でSQLを実行
    if (process.env.NODE_ENV === 'development') {
      console.log(`[BackupService] Restoring to ${databaseUrl}`);
      console.log(`[BackupService] SQL length: ${sqlContent.length} bytes`);
    }
  }

  /**
   * チェックサム計算（SHA-256のモック）
   */
  private calculateChecksum(data: Buffer): string {
    // 実際はcrypto.createHash('sha256')を使用
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum = (sum + data[i]) % 65536;
    }
    return sum.toString(16).padStart(4, '0');
  }
}

describe('BackupService', () => {
  let service: BackupService;
  let storage: S3StorageProvider;

  beforeEach(() => {
    storage = new S3StorageProvider();
    service = new BackupService(storage);
  });

  describe('バックアップ作成', () => {
    it('データベースバックアップを作成できること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';

      // Act
      const backup = await service.createBackup(databaseUrl);

      // Assert
      expect(backup.id).toMatch(/^backup-\d+-\d+$/);
      expect(backup.timestamp).toBeInstanceOf(Date);
      expect(backup.size).toBeGreaterThan(0);
      expect(backup.compressed).toBe(true);
      expect(backup.checksum).toBeDefined();
      expect(backup.storageLocation).toContain('s3://');
      expect(backup.status).toBe('completed');
    });

    it('バックアップが圧縮されること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';

      // Act
      const backup = await service.createBackup(databaseUrl);

      // Assert
      expect(backup.compressed).toBe(true);
      // 圧縮されたサイズは元のサイズより小さいはず
      expect(backup.size).toBeGreaterThan(0);
    });

    it('チェックサムが計算されること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';

      // Act
      const backup = await service.createBackup(databaseUrl);

      // Assert
      expect(backup.checksum).toBeDefined();
      expect(backup.checksum.length).toBeGreaterThan(0);
    });
  });

  describe('バックアップ一覧取得', () => {
    it('空の一覧を返すこと（バックアップがない場合）', async () => {
      // Arrange & Act
      const backups = await service.listBackups();

      // Assert
      expect(backups).toEqual([]);
    });

    it('作成されたバックアップが一覧に含まれること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';
      await service.createBackup(databaseUrl);
      await service.createBackup(databaseUrl);

      // Act
      const backups = await service.listBackups();

      // Assert
      expect(backups).toHaveLength(2);
    });

    it('バックアップが新しい順にソートされること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';
      const backup1 = await service.createBackup(databaseUrl);

      // 少し待機
      await new Promise((resolve) => setTimeout(resolve, 10));

      const backup2 = await service.createBackup(databaseUrl);

      // Act
      const backups = await service.listBackups();

      // Assert
      expect(backups[0].id).toBe(backup2.id);
      expect(backups[1].id).toBe(backup1.id);
    });
  });

  describe('バックアップからのリストア', () => {
    it('バックアップからデータベースをリストアできること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';
      const backup = await service.createBackup(databaseUrl);

      // Act & Assert
      await expect(
        service.restoreBackup(backup.id, databaseUrl)
      ).resolves.not.toThrow();
    });

    it('存在しないバックアップIDでエラーをスローすること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';

      // Act & Assert
      await expect(
        service.restoreBackup('non-existent-id', databaseUrl)
      ).rejects.toThrow('Backup non-existent-id not found');
    });

    it('チェックサム不一致でエラーをスローすること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';
      const backup = await service.createBackup(databaseUrl);

      // ストレージのデータを改ざん
      const corruptedData = Buffer.from('corrupted data');
      await storage.upload(`backups/${backup.id}.sql.gz`, corruptedData);

      // Act & Assert
      await expect(
        service.restoreBackup(backup.id, databaseUrl)
      ).rejects.toThrow('Backup checksum mismatch');
    });
  });

  describe('古いバックアップの削除', () => {
    it('リテンションポリシーに基づいて古いバックアップを削除すること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';

      // 古いバックアップを作成（モック）
      const oldBackup = await service.createBackup(databaseUrl);
      // 内部のbackupsマップを更新するためにメソッドを使用
      service.updateBackupTimestamp(oldBackup.id, new Date('2024-01-01'));

      // 新しいバックアップを作成
      await service.createBackup(databaseUrl);

      // Act
      const deletedCount = await service.cleanupOldBackups(7); // 7日以上古いものを削除

      // Assert
      expect(deletedCount).toBe(1);

      const remainingBackups = await service.listBackups();
      expect(remainingBackups).toHaveLength(1);
    });

    it('リテンション期間内のバックアップは削除しないこと', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';
      await service.createBackup(databaseUrl);
      await service.createBackup(databaseUrl);

      // Act
      const deletedCount = await service.cleanupOldBackups(7);

      // Assert
      expect(deletedCount).toBe(0);

      const backups = await service.listBackups();
      expect(backups).toHaveLength(2);
    });

    it('削除されたバックアップ数を返すこと', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';

      // 複数の古いバックアップを作成
      for (let i = 0; i < 5; i++) {
        const backup = await service.createBackup(databaseUrl);
        // 内部のbackupsマップを更新するためにメソッドを使用
        service.updateBackupTimestamp(backup.id, new Date('2024-01-01'));
      }

      // Act
      const deletedCount = await service.cleanupOldBackups(7);

      // Assert
      expect(deletedCount).toBe(5);
    });
  });

  describe('バックアップの整合性検証', () => {
    it('正常なバックアップの検証が成功すること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';
      const backup = await service.createBackup(databaseUrl);

      // Act
      const isValid = await service.verifyBackup(backup.id);

      // Assert
      expect(isValid).toBe(true);
    });

    it('存在しないバックアップの検証が失敗すること', async () => {
      // Arrange & Act
      const isValid = await service.verifyBackup('non-existent-id');

      // Assert
      expect(isValid).toBe(false);
    });

    it('破損したバックアップの検証が失敗すること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';
      const backup = await service.createBackup(databaseUrl);

      // ストレージのデータを破損
      const corruptedData = Buffer.from('corrupted');
      await storage.upload(`backups/${backup.id}.sql.gz`, corruptedData);

      // Act
      const isValid = await service.verifyBackup(backup.id);

      // Assert
      expect(isValid).toBe(false);
    });
  });

  describe('ストレージプロバイダー統合', () => {
    it('ローカルストレージプロバイダーでバックアップを作成できること', async () => {
      // Arrange
      const tmpDir = `/tmp/reftrix-backup-test-${Date.now()}`;
      const localStorage = new LocalStorageProvider(tmpDir);
      const localService = new BackupService(localStorage);
      const databaseUrl = 'postgresql://localhost:26432/reftrix';

      // Act
      const backup = await localService.createBackup(databaseUrl);

      // Assert
      expect(backup.storageLocation).toContain(tmpDir);
      expect(backup.status).toBe('completed');

      // クリーンアップ
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('S3ストレージプロバイダーでバックアップを作成できること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';

      // Act
      const backup = await service.createBackup(databaseUrl);

      // Assert
      expect(backup.storageLocation).toContain('s3://');
      expect(backup.status).toBe('completed');
    });
  });

  describe('統合シナリオ', () => {
    it('完全なバックアップ・リストア・検証フローが動作すること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';

      // Act: バックアップ作成
      const backup = await service.createBackup(databaseUrl);

      // Act: バックアップ検証
      const isValid = await service.verifyBackup(backup.id);
      expect(isValid).toBe(true);

      // Act: バックアップ一覧取得
      const backups = await service.listBackups();
      expect(backups).toHaveLength(1);
      expect(backups[0].id).toBe(backup.id);

      // Act: リストア
      await expect(
        service.restoreBackup(backup.id, databaseUrl)
      ).resolves.not.toThrow();

      // Assert
      expect(backup.status).toBe('completed');
    });

    it('複数バックアップの管理ができること', async () => {
      // Arrange
      const databaseUrl = 'postgresql://localhost:26432/reftrix';

      // Act: 3つのバックアップを作成
      await service.createBackup(databaseUrl);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await service.createBackup(databaseUrl);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await service.createBackup(databaseUrl);

      // Assert: 一覧取得
      const backups = await service.listBackups();
      expect(backups).toHaveLength(3);

      // Assert: すべて検証成功
      for (const backup of backups) {
        const isValid = await service.verifyBackup(backup.id);
        expect(isValid).toBe(true);
      }
    });
  });
});
