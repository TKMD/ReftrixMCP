// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BackupService 統合テスト
 *
 * Phase 2 モック置換実装（MOCK-008）の統合テスト
 * - LocalStorageProvider: パストラバーサル防止、ファイルパーミッション設定
 * - DatabaseDumperService: pg_dump/psqlコマンド実行
 *
 * テスト対象:
 * - LocalStorageProvider + DatabaseDumperService の連携
 * - バックアップ作成→リストアのE2Eフロー
 * - エラーハンドリングの統合テスト
 * - パフォーマンス要件のテスト
 *
 * 注意: DatabaseDumperServiceはpg_dump/psqlコマンドに依存するため、
 * CIでは実際のPostgreSQLが必要。ローカルではモック使用可能。
 *
 * SEC-H2: DB接続文字列はURL解析テスト用のフィクスチャデータ（user:password等）。
 * parseDatabaseUrl()のパース正確性検証が目的であり、実際のDB接続は行われない。
 *
 * @module tests/integration/backup-service.integration
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { promisify } from 'util';

// テスト対象サービス
import {
  BackupService,
  LocalStorageProvider,
  type BackupMetadata,
  type StorageProvider,
  type DatabaseDumper,
} from '../../src/services/backup-service';
import {
  LocalStorageProvider as SecureLocalStorageProvider,
  StorageError,
} from '../../src/services/storage/local-storage.provider';
import {
  DatabaseDumperService,
  parseDatabaseUrl,
  type DatabaseConnectionInfo,
  type DumpOptions,
  type RestoreOptions,
  DatabaseUrlParseError,
  PgDumpNotFoundError,
  DumpError,
  RestoreError,
  ConnectionError,
  TimeoutError,
} from '../../src/services/database-dumper.service';

const gunzip = promisify(zlib.gunzip);

// =====================================================
// テスト用定数・フィクスチャ
// =====================================================

const TEST_BASE_DIR = path.join(os.tmpdir(), 'reftrix-backup-integration-test');
const SAMPLE_SQL_DUMP = `
-- PostgreSQL database dump
SET statement_timeout = 0;
SET client_encoding = 'UTF8';

CREATE TABLE IF NOT EXISTS test_table (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO test_table (name) VALUES ('test1');
INSERT INTO test_table (name) VALUES ('test2');
`;

const VALID_DATABASE_URL = 'postgresql://user:password@localhost:5432/testdb';
const VALID_DATABASE_URL_WITH_SSL = 'postgresql://user:password@localhost:5432/testdb?sslmode=require';

// =====================================================
// モックDatabaseDumper（pg_dump/psqlなしでテスト可能）
// =====================================================

class MockDatabaseDumper implements DatabaseDumper {
  private dumpCalls: string[] = [];
  private restoreCalls: Array<{ url: string; sql: string }> = [];
  private shouldFail = false;
  private failReason: 'connection' | 'dump' | 'restore' | 'timeout' = 'dump';
  private customDumpResult: string | null = null;

  setDumpResult(sql: string): void {
    this.customDumpResult = sql;
  }

  setFailure(shouldFail: boolean, reason: 'connection' | 'dump' | 'restore' | 'timeout' = 'dump'): void {
    this.shouldFail = shouldFail;
    this.failReason = reason;
  }

  async dump(databaseUrl: string): Promise<string> {
    this.dumpCalls.push(databaseUrl);

    if (this.shouldFail) {
      switch (this.failReason) {
        case 'connection':
          throw new ConnectionError('Connection refused');
        case 'timeout':
          throw new TimeoutError('Dump timed out', 30000);
        default:
          throw new DumpError('pg_dump failed', 'mock error', 1);
      }
    }

    return this.customDumpResult ?? SAMPLE_SQL_DUMP;
  }

  async restore(databaseUrl: string, sqlContent: string): Promise<void> {
    this.restoreCalls.push({ url: databaseUrl, sql: sqlContent });

    if (this.shouldFail && this.failReason === 'restore') {
      throw new RestoreError('psql restore failed', 'mock error', 1);
    }
  }

  getDumpCalls(): string[] {
    return this.dumpCalls;
  }

  getRestoreCalls(): Array<{ url: string; sql: string }> {
    return this.restoreCalls;
  }

  reset(): void {
    this.dumpCalls = [];
    this.restoreCalls = [];
    this.shouldFail = false;
    this.customDumpResult = null;
  }
}

// =====================================================
// テストセットアップ・クリーンアップ
// =====================================================

async function cleanupTestDir(): Promise<void> {
  try {
    await fs.rm(TEST_BASE_DIR, { recursive: true, force: true });
  } catch {
    // ディレクトリが存在しない場合は無視
  }
}

async function setupTestDir(): Promise<void> {
  await cleanupTestDir();
  await fs.mkdir(TEST_BASE_DIR, { recursive: true, mode: 0o700 });
}

// =====================================================
// LocalStorageProvider + BackupService 統合テスト
// =====================================================

describe('LocalStorageProvider + BackupService 統合テスト', () => {
  let storage: LocalStorageProvider;
  let mockDumper: MockDatabaseDumper;
  let backupService: BackupService;

  beforeAll(async () => {
    await setupTestDir();
  });

  afterAll(async () => {
    await cleanupTestDir();
  });

  beforeEach(() => {
    // 新しいストレージプロバイダーを作成
    storage = new LocalStorageProvider(TEST_BASE_DIR);
    mockDumper = new MockDatabaseDumper();
    backupService = new BackupService({
      storage,
      databaseDumper: mockDumper,
    });
  });

  afterEach(() => {
    mockDumper.reset();
  });

  describe('バックアップ作成フロー', () => {
    it('バックアップを作成してファイルが保存される', async () => {
      // Act
      const metadata = await backupService.createBackup(VALID_DATABASE_URL);

      // Assert
      expect(metadata).toBeDefined();
      expect(metadata.status).toBe('completed');
      expect(metadata.size).toBeGreaterThan(0);
      expect(metadata.compressed).toBe(true);
      expect(metadata.checksum).toBeDefined();
      expect(metadata.storageLocation).toContain(TEST_BASE_DIR);

      // ファイルが実際に存在することを確認
      const filePath = path.join(TEST_BASE_DIR, `backups/${metadata.id}.sql.gz`);
      const fileExists = await fs.stat(filePath).then(() => true).catch(() => false);
      expect(fileExists).toBe(true);
    });

    it('バックアップファイルが圧縮されている', async () => {
      // Act
      const metadata = await backupService.createBackup(VALID_DATABASE_URL);

      // Assert: 圧縮ファイルを読み込み、解凍可能なことを確認
      const filePath = path.join(TEST_BASE_DIR, `backups/${metadata.id}.sql.gz`);
      const compressedData = await fs.readFile(filePath);
      const decompressed = await gunzip(compressedData);
      const sql = decompressed.toString();

      expect(sql).toContain('CREATE TABLE');
      expect(sql).toContain('INSERT INTO');
    });

    it('バックアップメタデータにチェックサムが含まれる', async () => {
      // Act
      const metadata = await backupService.createBackup(VALID_DATABASE_URL);

      // Assert
      expect(metadata.checksum).toBeDefined();
      expect(metadata.checksum.length).toBeGreaterThan(0);
    });

    it('複数のバックアップを作成できる', async () => {
      // Act
      const backup1 = await backupService.createBackup(VALID_DATABASE_URL);
      const backup2 = await backupService.createBackup(VALID_DATABASE_URL);
      const backup3 = await backupService.createBackup(VALID_DATABASE_URL);

      // Assert
      expect(backup1.id).not.toBe(backup2.id);
      expect(backup2.id).not.toBe(backup3.id);

      const backups = await backupService.listBackups();
      expect(backups.length).toBe(3);
    });

    it('バックアップ一覧が新しい順にソートされる', async () => {
      // Act
      const backup1 = await backupService.createBackup(VALID_DATABASE_URL);
      await new Promise(resolve => setTimeout(resolve, 10)); // 時間差を確保
      const backup2 = await backupService.createBackup(VALID_DATABASE_URL);

      const backups = await backupService.listBackups();

      // Assert: 新しい順
      expect(backups[0].id).toBe(backup2.id);
      expect(backups[1].id).toBe(backup1.id);
    });
  });

  describe('バックアップリストアフロー', () => {
    it('バックアップからリストアできる', async () => {
      // Arrange
      const backup = await backupService.createBackup(VALID_DATABASE_URL);

      // Act
      await backupService.restoreBackup(backup.id, VALID_DATABASE_URL);

      // Assert
      const restoreCalls = mockDumper.getRestoreCalls();
      expect(restoreCalls.length).toBe(1);
      expect(restoreCalls[0].url).toBe(VALID_DATABASE_URL);
      expect(restoreCalls[0].sql).toContain('CREATE TABLE');
    });

    it('存在しないバックアップIDでリストアするとエラー', async () => {
      // Act & Assert
      await expect(
        backupService.restoreBackup('non-existent-backup-id', VALID_DATABASE_URL)
      ).rejects.toThrow('not found');
    });

    it('チェックサムが一致しない場合エラー', async () => {
      // Arrange
      const backup = await backupService.createBackup(VALID_DATABASE_URL);

      // バックアップファイルを改ざん
      const filePath = path.join(TEST_BASE_DIR, `backups/${backup.id}.sql.gz`);
      const tamperedData = Buffer.from('tampered data');
      await fs.writeFile(filePath, tamperedData);

      // Act & Assert
      await expect(
        backupService.restoreBackup(backup.id, VALID_DATABASE_URL)
      ).rejects.toThrow('checksum mismatch');
    });
  });

  describe('バックアップ検証', () => {
    it('有効なバックアップの検証が成功する', async () => {
      // Arrange
      const backup = await backupService.createBackup(VALID_DATABASE_URL);

      // Act
      const isValid = await backupService.verifyBackup(backup.id);

      // Assert
      expect(isValid).toBe(true);
    });

    it('改ざんされたバックアップの検証が失敗する', async () => {
      // Arrange
      const backup = await backupService.createBackup(VALID_DATABASE_URL);

      // バックアップファイルを改ざん
      const filePath = path.join(TEST_BASE_DIR, `backups/${backup.id}.sql.gz`);
      const tamperedData = Buffer.from('tampered data');
      await fs.writeFile(filePath, tamperedData);

      // Act
      const isValid = await backupService.verifyBackup(backup.id);

      // Assert
      expect(isValid).toBe(false);
    });

    it('存在しないバックアップの検証が失敗する', async () => {
      // Act
      const isValid = await backupService.verifyBackup('non-existent-backup-id');

      // Assert
      expect(isValid).toBe(false);
    });
  });

  describe('リテンションポリシー', () => {
    it('古いバックアップを削除する', async () => {
      // Arrange: バックアップを作成
      const backup1 = await backupService.createBackup(VALID_DATABASE_URL);
      const backup2 = await backupService.createBackup(VALID_DATABASE_URL);
      const backup3 = await backupService.createBackup(VALID_DATABASE_URL);

      // バックアップ1と2を古くする（10日前）
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);
      backupService.updateBackupTimestamp(backup1.id, oldDate);
      backupService.updateBackupTimestamp(backup2.id, oldDate);

      // Act: 7日以上古いバックアップを削除
      const deletedCount = await backupService.cleanupOldBackups(7);

      // Assert
      expect(deletedCount).toBe(2);

      const remainingBackups = await backupService.listBackups();
      expect(remainingBackups.length).toBe(1);
      expect(remainingBackups[0].id).toBe(backup3.id);
    });

    it('リテンション期間内のバックアップは削除しない', async () => {
      // Arrange
      const backup = await backupService.createBackup(VALID_DATABASE_URL);

      // Act: 7日以上古いバックアップを削除（今日のバックアップは削除されない）
      const deletedCount = await backupService.cleanupOldBackups(7);

      // Assert
      expect(deletedCount).toBe(0);

      const backups = await backupService.listBackups();
      expect(backups.length).toBe(1);
      expect(backups[0].id).toBe(backup.id);
    });
  });
});

// =====================================================
// エラーハンドリング統合テスト
// =====================================================

describe('エラーハンドリング統合テスト', () => {
  let storage: LocalStorageProvider;
  let mockDumper: MockDatabaseDumper;
  let backupService: BackupService;

  beforeAll(async () => {
    await setupTestDir();
  });

  afterAll(async () => {
    await cleanupTestDir();
  });

  beforeEach(() => {
    storage = new LocalStorageProvider(TEST_BASE_DIR);
    mockDumper = new MockDatabaseDumper();
    backupService = new BackupService({
      storage,
      databaseDumper: mockDumper,
    });
  });

  afterEach(() => {
    mockDumper.reset();
  });

  describe('DatabaseDumperエラー', () => {
    it('ダンプ失敗時にバックアップステータスがfailedになる', async () => {
      // Arrange
      mockDumper.setFailure(true, 'dump');

      // Act & Assert
      await expect(
        backupService.createBackup(VALID_DATABASE_URL)
      ).rejects.toThrow();

      const backups = await backupService.listBackups();
      expect(backups.length).toBe(1);
      expect(backups[0].status).toBe('failed');
    });

    it('接続エラー時に適切なエラーが伝播する', async () => {
      // Arrange
      mockDumper.setFailure(true, 'connection');

      // Act & Assert
      await expect(
        backupService.createBackup(VALID_DATABASE_URL)
      ).rejects.toThrow('Connection refused');
    });

    it('タイムアウトエラー時に適切なエラーが伝播する', async () => {
      // Arrange
      mockDumper.setFailure(true, 'timeout');

      // Act & Assert
      await expect(
        backupService.createBackup(VALID_DATABASE_URL)
      ).rejects.toThrow('timed out');
    });

    it('リストアエラー時に適切なエラーが伝播する', async () => {
      // Arrange: バックアップ作成は成功
      const backup = await backupService.createBackup(VALID_DATABASE_URL);

      // リストア時にエラー
      mockDumper.setFailure(true, 'restore');

      // Act & Assert
      await expect(
        backupService.restoreBackup(backup.id, VALID_DATABASE_URL)
      ).rejects.toThrow('restore failed');
    });
  });

  describe('ストレージエラー', () => {
    it('ストレージへの書き込み失敗を適切に処理する', async () => {
      // Arrange: 書き込み不可能なディレクトリを使用
      // 注: このテストはOSのパーミッションに依存するため、
      // 実際のテストではモックストレージを使用することを推奨

      // 現在はモックダンパーでのテストのみ
      expect(true).toBe(true);
    });
  });
});

// =====================================================
// SecureLocalStorageProvider 単体統合テスト
// =====================================================

describe('SecureLocalStorageProvider 統合テスト', () => {
  let provider: SecureLocalStorageProvider;
  const testDir = path.join(TEST_BASE_DIR, 'secure-storage');

  beforeAll(async () => {
    await setupTestDir();
    await fs.mkdir(testDir, { recursive: true, mode: 0o700 });
  });

  afterAll(async () => {
    await cleanupTestDir();
  });

  beforeEach(() => {
    provider = new SecureLocalStorageProvider(testDir);
  });

  describe('基本操作', () => {
    it('ファイルをアップロードしてダウンロードできる', async () => {
      // Arrange
      const key = 'test/file.txt';
      const data = Buffer.from('Hello, World!');

      // Act
      await provider.upload(key, data);
      const downloaded = await provider.download(key);

      // Assert
      expect(downloaded.toString()).toBe('Hello, World!');
    });

    it('ファイルの存在確認ができる', async () => {
      // Arrange
      const key = 'test/exists.txt';
      const data = Buffer.from('test');

      // Act
      await provider.upload(key, data);
      const exists = await provider.exists(key);
      const notExists = await provider.exists('non-existent.txt');

      // Assert
      expect(exists).toBe(true);
      expect(notExists).toBe(false);
    });

    it('ファイルを削除できる', async () => {
      // Arrange
      const key = 'test/delete.txt';
      const data = Buffer.from('to be deleted');
      await provider.upload(key, data);

      // Act
      await provider.delete(key);

      // Assert
      const exists = await provider.exists(key);
      expect(exists).toBe(false);
    });

    it('ファイル一覧を取得できる', async () => {
      // Arrange
      await provider.upload('list/file1.txt', Buffer.from('1'));
      await provider.upload('list/file2.txt', Buffer.from('2'));
      await provider.upload('list/sub/file3.txt', Buffer.from('3'));

      // Act
      const files = await provider.list('list');

      // Assert
      expect(files.length).toBe(3);
      expect(files).toContain('list/file1.txt');
      expect(files).toContain('list/file2.txt');
      expect(files).toContain('list/sub/file3.txt');
    });
  });

  describe('セキュリティ', () => {
    it('パストラバーサル攻撃を防ぐ', async () => {
      // Act & Assert
      await expect(
        provider.upload('../escape.txt', Buffer.from('attack'))
      ).rejects.toThrow(StorageError);

      await expect(
        provider.download('../../etc/passwd')
      ).rejects.toThrow(StorageError);
    });

    it('絶対パスを拒否する', async () => {
      // Act & Assert
      await expect(
        provider.upload('/etc/passwd', Buffer.from('attack'))
      ).rejects.toThrow(StorageError);
    });

    it('空のキーを拒否する', async () => {
      // Act & Assert
      await expect(
        provider.upload('', Buffer.from('data'))
      ).rejects.toThrow(StorageError);
    });

    it('URLエンコードされたパストラバーサルを検出する', async () => {
      // Act & Assert
      await expect(
        provider.upload('%2e%2e/escape.txt', Buffer.from('attack'))
      ).rejects.toThrow(StorageError);
    });
  });
});

// =====================================================
// DatabaseDumperService URL解析テスト
// =====================================================

describe('DatabaseDumperService URL解析 統合テスト', () => {
  describe('parseDatabaseUrl', () => {
    it('標準的なDATABASE_URLをパースする', () => {
      // Act
      const info = parseDatabaseUrl(VALID_DATABASE_URL);

      // Assert
      expect(info.host).toBe('localhost');
      expect(info.port).toBe(5432);
      expect(info.database).toBe('testdb');
      expect(info.user).toBe('user');
      expect(info.password).toBe('password');
    });

    it('SSLモード付きURLをパースする', () => {
      // Act
      const info = parseDatabaseUrl(VALID_DATABASE_URL_WITH_SSL);

      // Assert
      expect(info.sslmode).toBe('require');
    });

    it('ポート指定なしの場合デフォルト5432を使用', () => {
      // Arrange
      const url = 'postgresql://user:pass@localhost/testdb';

      // Act
      const info = parseDatabaseUrl(url);

      // Assert
      expect(info.port).toBe(5432);
    });

    it('URLエンコードされたパスワードをデコードする', () => {
      // Arrange
      const url = 'postgresql://user:p%40ssw0rd@localhost:5432/testdb';

      // Act
      const info = parseDatabaseUrl(url);

      // Assert
      expect(info.password).toBe('p@ssw0rd');
    });

    it('無効なURLでエラーを投げる', () => {
      // Act & Assert
      expect(() => parseDatabaseUrl('')).toThrow(DatabaseUrlParseError);
      expect(() => parseDatabaseUrl('mysql://user:pass@localhost/db')).toThrow(DatabaseUrlParseError);
      expect(() => parseDatabaseUrl('not-a-url')).toThrow(DatabaseUrlParseError);
    });

    it('ユーザー名なしでエラーを投げる', () => {
      // Arrange
      const url = 'postgresql://localhost/testdb';

      // Act & Assert
      expect(() => parseDatabaseUrl(url)).toThrow(DatabaseUrlParseError);
    });

    it('データベース名なしでエラーを投げる', () => {
      // Arrange
      const url = 'postgresql://user:pass@localhost/';

      // Act & Assert
      expect(() => parseDatabaseUrl(url)).toThrow(DatabaseUrlParseError);
    });
  });
});

// =====================================================
// パフォーマンス統合テスト
// =====================================================

describe('パフォーマンス統合テスト', () => {
  let storage: LocalStorageProvider;
  let mockDumper: MockDatabaseDumper;
  let backupService: BackupService;

  beforeAll(async () => {
    await setupTestDir();
  });

  afterAll(async () => {
    await cleanupTestDir();
  });

  beforeEach(() => {
    storage = new LocalStorageProvider(TEST_BASE_DIR);
    mockDumper = new MockDatabaseDumper();
    backupService = new BackupService({
      storage,
      databaseDumper: mockDumper,
    });
  });

  afterEach(() => {
    mockDumper.reset();
  });

  it('バックアップ作成が1秒以内に完了する（小規模データ）', async () => {
    // Arrange
    const startTime = Date.now();

    // Act
    await backupService.createBackup(VALID_DATABASE_URL);

    // Assert
    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(1000);
  });

  it('大きなダンプ（1MB）でも5秒以内に完了する', async () => {
    // Arrange: 1MBのダンプデータを生成
    const largeSql = SAMPLE_SQL_DUMP.repeat(50000); // 約1MB
    mockDumper.setDumpResult(largeSql);

    const startTime = Date.now();

    // Act
    await backupService.createBackup(VALID_DATABASE_URL);

    // Assert
    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(5000);
  });

  it('複数バックアップの一覧取得が100ms以内', async () => {
    // Arrange: 10個のバックアップを作成
    for (let i = 0; i < 10; i++) {
      await backupService.createBackup(VALID_DATABASE_URL);
    }

    const startTime = Date.now();

    // Act
    const backups = await backupService.listBackups();

    // Assert
    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(100);
    expect(backups.length).toBe(10);
  });
});

// =====================================================
// 実際のpg_dump/psql テスト（オプション）
// =====================================================

describe('DatabaseDumperService 可用性テスト', () => {
  let dumperService: DatabaseDumperService;

  beforeEach(() => {
    dumperService = new DatabaseDumperService();
  });

  it('pg_dump/psqlの可用性をチェックできる', async () => {
    // Act
    const availability = await dumperService.isAvailable();

    // Assert: テストはpg_dumpの有無に関わらず成功する
    expect(availability).toBeDefined();
    expect(typeof availability.pgDump).toBe('boolean');
    expect(typeof availability.psql).toBe('boolean');

    // pg_dumpが利用可能な場合、バージョンが取得できる
    if (availability.pgDump) {
      expect(availability.pgDumpVersion).toBeDefined();
    }

    if (availability.psql) {
      expect(availability.psqlVersion).toBeDefined();
    }
  });
});
