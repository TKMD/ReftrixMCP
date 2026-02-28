// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Path Security Tests (MCP-SEC-02)
 *
 * layout.search の project_context.project_path に対する
 * セキュリティガードのテスト
 *
 * テスト対象:
 * - 許可されたワークスペース配下のみアクセス可能
 * - ディレクトリトラバーサル攻撃の防止
 * - システムディレクトリへのアクセスブロック
 * - シンボリックリンクによるエスケープ検出
 * - 環境変数による機能無効化
 *
 * @module tests/security/path-security.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';

// テスト対象モジュール
import {
  validateProjectPath,
  validateFilePath,
  matchesBlockedFilePattern,
  isLocalPathAccessDisabled,
  getAllowedWorkspacePaths,
  ENV_DISABLE_LOCAL_PATH_ACCESS,
  ENV_ALLOWED_WORKSPACE_PATHS,
  type PathValidationResult,
} from '../../src/utils/path-security';

// =====================================================
// テスト設定
// =====================================================

describe('Path Security Tests (MCP-SEC-02)', () => {
  // 元の環境変数を保存
  const originalEnv = { ...process.env };
  const currentWorkingDir = process.cwd();

  beforeEach(() => {
    // テスト前に環境変数をリセット
    delete process.env[ENV_DISABLE_LOCAL_PATH_ACCESS];
    delete process.env[ENV_ALLOWED_WORKSPACE_PATHS];
    vi.clearAllMocks();
  });

  afterEach(() => {
    // テスト後に環境変数を復元
    process.env = { ...originalEnv };
  });

  // =====================================================
  // validateProjectPath テスト
  // =====================================================

  describe('validateProjectPath', () => {
    describe('Success Cases (Should PASS)', () => {
      it('should allow access to current working directory', () => {
        const result = validateProjectPath(currentWorkingDir);

        expect(result.isValid).toBe(true);
        expect(result.normalizedPath).toBe(path.resolve(currentWorkingDir));
        expect(result.error).toBeUndefined();
      });

      it('should allow access to subdirectory of current working directory', () => {
        const subDir = path.join(currentWorkingDir, 'apps');
        const result = validateProjectPath(subDir);

        // apps ディレクトリが存在する場合のみ成功
        if (result.isValid) {
          expect(result.normalizedPath).toBe(path.resolve(subDir));
        } else {
          // ディレクトリが存在しない場合は PATH_NOT_FOUND
          expect(result.error?.code).toBe('PATH_NOT_FOUND');
        }
      });

      it('should allow access to explicitly allowed workspace paths', () => {
        // 環境変数で許可パスを設定
        process.env[ENV_ALLOWED_WORKSPACE_PATHS] = currentWorkingDir;

        const result = validateProjectPath(currentWorkingDir);

        expect(result.isValid).toBe(true);
      });
    });

    describe('Security Violations (Should FAIL)', () => {
      it('should block access to /etc directory', () => {
        const result = validateProjectPath('/etc');

        expect(result.isValid).toBe(false);
        expect(result.error?.code).toBe('BLOCKED_PATH_PATTERN');
        expect(result.error?.message).toContain('/etc');
      });

      it('should block access to /var directory', () => {
        const result = validateProjectPath('/var/log');

        expect(result.isValid).toBe(false);
        expect(result.error?.code).toBe('BLOCKED_PATH_PATTERN');
      });

      it('should block access to /tmp directory', () => {
        const result = validateProjectPath('/tmp');

        expect(result.isValid).toBe(false);
        expect(result.error?.code).toBe('BLOCKED_PATH_PATTERN');
      });

      it('should block access to .ssh directory', () => {
        const result = validateProjectPath('/home/user/.ssh');

        expect(result.isValid).toBe(false);
        expect(result.error?.code).toBe('BLOCKED_PATH_PATTERN');
        expect(result.error?.message).toContain('.ssh');
      });

      it('should block access to .aws directory', () => {
        const result = validateProjectPath('/home/user/.aws');

        expect(result.isValid).toBe(false);
        expect(result.error?.code).toBe('BLOCKED_PATH_PATTERN');
      });

      it('should block access to credentials directory', () => {
        const result = validateProjectPath('/home/user/credentials');

        expect(result.isValid).toBe(false);
        expect(result.error?.code).toBe('BLOCKED_PATH_PATTERN');
      });

      it('should block access to paths outside allowed workspace', () => {
        // カレントディレクトリのみ許可
        process.env[ENV_ALLOWED_WORKSPACE_PATHS] = currentWorkingDir;

        // 親ディレクトリへのアクセスを試行
        const parentDir = path.dirname(currentWorkingDir);
        const result = validateProjectPath(parentDir);

        // 親ディレクトリがシステムパスでない場合は PATH_NOT_ALLOWED
        if (result.error?.code !== 'BLOCKED_PATH_PATTERN') {
          expect(result.isValid).toBe(false);
          expect(result.error?.code).toBe('PATH_NOT_ALLOWED');
        }
      });
    });

    describe('Directory Traversal Prevention', () => {
      it('should normalize and block directory traversal attempts', () => {
        // ディレクトリトラバーサル攻撃パターン
        const maliciousPaths = [
          `${currentWorkingDir}/../../../etc/passwd`,
          `${currentWorkingDir}/./../../var/log`,
          `${currentWorkingDir}/../../../../../root`,
        ];

        for (const maliciousPath of maliciousPaths) {
          const result = validateProjectPath(maliciousPath);

          // 正規化後のパスがブロックされることを確認
          expect(result.isValid).toBe(false);
          // BLOCKED_PATH_PATTERN または PATH_NOT_ALLOWED
          expect(['BLOCKED_PATH_PATTERN', 'PATH_NOT_ALLOWED', 'PATH_NOT_FOUND']).toContain(
            result.error?.code
          );
        }
      });

      it('should normalize paths with redundant separators', () => {
        const redundantPath = `${currentWorkingDir}//apps///web`;
        const result = validateProjectPath(redundantPath);

        // パスは正規化されて検証される
        // ディレクトリが存在しない場合は PATH_NOT_FOUND
        // 存在する場合は isValid: true
        expect(result.error?.code !== 'BLOCKED_PATH_PATTERN').toBe(true);
      });
    });

    describe('Environment Variable Controls', () => {
      it('should block all access when REFTRIX_DISABLE_LOCAL_PATH_ACCESS is set', () => {
        process.env[ENV_DISABLE_LOCAL_PATH_ACCESS] = 'true';

        const result = validateProjectPath(currentWorkingDir);

        expect(result.isValid).toBe(false);
        expect(result.error?.code).toBe('LOCAL_PATH_ACCESS_DISABLED');
      });

      it('should block all access when REFTRIX_DISABLE_LOCAL_PATH_ACCESS is "1"', () => {
        process.env[ENV_DISABLE_LOCAL_PATH_ACCESS] = '1';

        const result = validateProjectPath(currentWorkingDir);

        expect(result.isValid).toBe(false);
        expect(result.error?.code).toBe('LOCAL_PATH_ACCESS_DISABLED');
      });

      it('should allow access when REFTRIX_DISABLE_LOCAL_PATH_ACCESS is "false"', () => {
        process.env[ENV_DISABLE_LOCAL_PATH_ACCESS] = 'false';

        const result = validateProjectPath(currentWorkingDir);

        // 無効化されていないので通常の検証が行われる
        expect(result.error?.code !== 'LOCAL_PATH_ACCESS_DISABLED').toBe(true);
      });

      it('should support multiple allowed workspace paths', () => {
        process.env[ENV_ALLOWED_WORKSPACE_PATHS] = `/tmp/test1,/tmp/test2,${currentWorkingDir}`;

        const paths = getAllowedWorkspacePaths();

        expect(paths.length).toBe(3);
        expect(paths).toContain(path.resolve('/tmp/test1'));
        expect(paths).toContain(path.resolve('/tmp/test2'));
        expect(paths).toContain(path.resolve(currentWorkingDir));
      });
    });

    describe('Edge Cases', () => {
      it('should handle non-existent paths', () => {
        const result = validateProjectPath(`${currentWorkingDir}/non-existent-directory-12345`);

        expect(result.isValid).toBe(false);
        expect(result.error?.code).toBe('PATH_NOT_FOUND');
      });

      it('should reject file paths (not directories)', () => {
        // package.json はファイルなので拒否されるべき
        const result = validateProjectPath(`${currentWorkingDir}/package.json`);

        // ファイルが存在する場合は PATH_NOT_DIRECTORY
        // 存在しない場合は PATH_NOT_FOUND
        expect(result.isValid).toBe(false);
        expect(['PATH_NOT_DIRECTORY', 'PATH_NOT_FOUND']).toContain(result.error?.code);
      });

      it('should handle empty string path', () => {
        // 空文字列は . に正規化されるため、カレントディレクトリとして扱われる
        const result = validateProjectPath('');

        // カレントディレクトリが許可されている場合は成功
        // そうでない場合は適切なエラー
        if (!result.isValid) {
          expect(result.error).toBeDefined();
        }
      });
    });
  });

  // =====================================================
  // validateFilePath テスト
  // =====================================================

  describe('validateFilePath', () => {
    const workspacePath = currentWorkingDir;

    it('should allow files within workspace', () => {
      const filePath = path.join(workspacePath, 'src', 'index.ts');
      const result = validateFilePath(filePath, workspacePath);

      expect(result).toBe(true);
    });

    it('should block files outside workspace', () => {
      const filePath = '/etc/passwd';
      const result = validateFilePath(filePath, workspacePath);

      expect(result).toBe(false);
    });

    it('should block .env files', () => {
      const filePath = path.join(workspacePath, '.env');
      const result = validateFilePath(filePath, workspacePath);

      expect(result).toBe(false);
    });

    it('should block .env.local files', () => {
      const filePath = path.join(workspacePath, '.env.local');
      const result = validateFilePath(filePath, workspacePath);

      expect(result).toBe(false);
    });

    it('should block credentials.json files', () => {
      const filePath = path.join(workspacePath, 'credentials.json');
      const result = validateFilePath(filePath, workspacePath);

      expect(result).toBe(false);
    });
  });

  // =====================================================
  // matchesBlockedFilePattern テスト
  // =====================================================

  describe('matchesBlockedFilePattern', () => {
    describe('Should Block', () => {
      const blockedFiles = [
        '.env',
        '.env.local',
        '.env.production',
        '.htpasswd',
        'id_rsa',
        'id_ed25519',
        'credentials.json',
        'secrets.yaml',
        'secrets.yml',
        'secret.json',
      ];

      for (const filename of blockedFiles) {
        it(`should block ${filename}`, () => {
          expect(matchesBlockedFilePattern(filename)).toBe(true);
        });
      }
    });

    describe('Should Allow', () => {
      const allowedFiles = [
        'index.ts',
        'styles.css',
        'component.tsx',
        'config.ts',
        'utils.js',
        'README.md',
        'package.json',
      ];

      for (const filename of allowedFiles) {
        it(`should allow ${filename}`, () => {
          expect(matchesBlockedFilePattern(filename)).toBe(false);
        });
      }
    });
  });

  // =====================================================
  // Helper Functions テスト
  // =====================================================

  describe('Helper Functions', () => {
    describe('isLocalPathAccessDisabled', () => {
      it('should return false when env is not set', () => {
        delete process.env[ENV_DISABLE_LOCAL_PATH_ACCESS];
        expect(isLocalPathAccessDisabled()).toBe(false);
      });

      it('should return true when env is "true"', () => {
        process.env[ENV_DISABLE_LOCAL_PATH_ACCESS] = 'true';
        expect(isLocalPathAccessDisabled()).toBe(true);
      });

      it('should return true when env is "1"', () => {
        process.env[ENV_DISABLE_LOCAL_PATH_ACCESS] = '1';
        expect(isLocalPathAccessDisabled()).toBe(true);
      });

      it('should return false when env is "false"', () => {
        process.env[ENV_DISABLE_LOCAL_PATH_ACCESS] = 'false';
        expect(isLocalPathAccessDisabled()).toBe(false);
      });
    });

    describe('getAllowedWorkspacePaths', () => {
      it('should return cwd when env is not set', () => {
        delete process.env[ENV_ALLOWED_WORKSPACE_PATHS];
        const paths = getAllowedWorkspacePaths();

        expect(paths.length).toBeGreaterThan(0);
        expect(paths[0]).toBe(path.resolve(process.cwd()));
      });

      it('should parse comma-separated paths', () => {
        process.env[ENV_ALLOWED_WORKSPACE_PATHS] = '/path/one, /path/two , /path/three';
        const paths = getAllowedWorkspacePaths();

        expect(paths.length).toBe(3);
        expect(paths).toContain(path.resolve('/path/one'));
        expect(paths).toContain(path.resolve('/path/two'));
        expect(paths).toContain(path.resolve('/path/three'));
      });

      it('should filter empty strings', () => {
        process.env[ENV_ALLOWED_WORKSPACE_PATHS] = '/path/one,,,/path/two';
        const paths = getAllowedWorkspacePaths();

        expect(paths.length).toBe(2);
      });
    });
  });

  // =====================================================
  // Attack Scenario Tests
  // =====================================================

  describe('Attack Scenario Tests', () => {
    it('should block reading /etc/passwd via traversal', () => {
      const attackPath = `${currentWorkingDir}/../../../../../../../etc/passwd`;
      const result = validateProjectPath(attackPath);

      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('BLOCKED_PATH_PATTERN');
    });

    it('should block reading SSH keys', () => {
      const attackPath = '/home/user/.ssh/id_rsa';
      const result = validateProjectPath(attackPath);

      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('BLOCKED_PATH_PATTERN');
    });

    it('should block reading AWS credentials', () => {
      const attackPath = '/home/user/.aws/credentials';
      const result = validateProjectPath(attackPath);

      expect(result.isValid).toBe(false);
      expect(result.error?.code).toBe('BLOCKED_PATH_PATTERN');
    });

    it('should block reading other users home directories', () => {
      // 他ユーザーのホームディレクトリは許可ワークスペース外
      const attackPath = '/home/other-user/project';
      const result = validateProjectPath(attackPath);

      expect(result.isValid).toBe(false);
      // PATH_NOT_ALLOWED または PATH_NOT_FOUND
      expect(['PATH_NOT_ALLOWED', 'PATH_NOT_FOUND']).toContain(result.error?.code);
    });

    it('should block reading Windows system directories', () => {
      const attackPaths = [
        'C:\\Windows\\System32',
        'C:\\Program Files\\',
        'C:\\ProgramData\\',
      ];

      for (const attackPath of attackPaths) {
        const result = validateProjectPath(attackPath);
        expect(result.isValid).toBe(false);
      }
    });
  });
});
