// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Path Security Utilities
 *
 * ローカルファイルシステムアクセスのセキュリティガード
 * layout.search の project_context.project_path に対するセキュリティ対策
 *
 * セキュリティ要件:
 * - 許可されたワークスペース配下のみアクセス可能
 * - ディレクトリトラバーサル攻撃の防止
 * - 環境変数による機能無効化オプション
 *
 * @module utils/path-security
 */

import * as path from 'path';
import * as fs from 'fs';
import { isDevelopment, logger } from './logger';

// =====================================================
// 定数
// =====================================================

/**
 * ローカルパスアクセスを無効化する環境変数
 * true に設定すると project_context.project_path 機能が無効化される
 */
export const ENV_DISABLE_LOCAL_PATH_ACCESS = 'REFTRIX_DISABLE_LOCAL_PATH_ACCESS';

/**
 * 許可されたワークスペースパスを指定する環境変数
 * カンマ区切りで複数パスを指定可能
 * 例: /home/user/projects,/var/www/apps
 */
export const ENV_ALLOWED_WORKSPACE_PATHS = 'REFTRIX_ALLOWED_WORKSPACE_PATHS';

/**
 * デフォルトの許可パス（環境変数未設定時）
 * カレントワーキングディレクトリのみ許可
 */
const DEFAULT_ALLOWED_PATHS = [process.cwd()];

/**
 * 禁止されるパスパターン（システムディレクトリ等）
 * これらのパスへのアクセスは常にブロックされる
 */
const BLOCKED_PATH_PATTERNS = [
  // システムディレクトリ
  /^\/etc\b/,
  /^\/var\b/,
  /^\/usr\b/,
  /^\/bin\b/,
  /^\/sbin\b/,
  /^\/lib\b/,
  /^\/opt\b/,
  /^\/boot\b/,
  /^\/root\b/,
  /^\/proc\b/,
  /^\/sys\b/,
  /^\/dev\b/,
  /^\/run\b/,
  /^\/tmp\b/,
  // Windows システムディレクトリ
  /^[A-Za-z]:\\Windows\b/i,
  /^[A-Za-z]:\\Program Files\b/i,
  /^[A-Za-z]:\\ProgramData\b/i,
  // 機密ディレクトリ
  /\.ssh\b/,
  /\.gnupg\b/,
  /\.aws\b/,
  /\.config\b/,
  /credentials?\b/i,
  /secrets?\b/i,
  /\.env\b/,
  /private_?keys?\b/i,
];

/**
 * 禁止されるファイル名パターン
 */
const BLOCKED_FILE_PATTERNS = [
  /^\.env/,
  /^\.htpasswd$/,
  /^id_rsa$/,
  /^id_ed25519$/,
  /^\.pem$/,
  /^\.key$/,
  /credentials\.json$/i,
  /secrets?\.(json|yaml|yml|xml)$/i,
];

// =====================================================
// 型定義
// =====================================================

/**
 * パス検証結果
 */
export interface PathValidationResult {
  /** 検証成功かどうか */
  isValid: boolean;
  /** 正規化されたパス（成功時のみ） */
  normalizedPath?: string;
  /** エラー理由（失敗時のみ） */
  error?: {
    code: PathSecurityErrorCode;
    message: string;
  };
}

/**
 * パスセキュリティエラーコード
 */
export type PathSecurityErrorCode =
  | 'LOCAL_PATH_ACCESS_DISABLED'
  | 'PATH_NOT_ALLOWED'
  | 'DIRECTORY_TRAVERSAL_DETECTED'
  | 'BLOCKED_PATH_PATTERN'
  | 'PATH_NOT_FOUND'
  | 'PATH_NOT_DIRECTORY'
  | 'SYMLINK_ESCAPE_DETECTED';

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * ローカルパスアクセスが無効化されているか確認
 */
export function isLocalPathAccessDisabled(): boolean {
  const envValue = process.env[ENV_DISABLE_LOCAL_PATH_ACCESS];
  return envValue === 'true' || envValue === '1';
}

/**
 * 許可されたワークスペースパスを取得
 */
export function getAllowedWorkspacePaths(): string[] {
  const envValue = process.env[ENV_ALLOWED_WORKSPACE_PATHS];

  if (envValue) {
    return envValue
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => path.resolve(p));
  }

  return DEFAULT_ALLOWED_PATHS.map((p) => path.resolve(p));
}

/**
 * パスがブロックされるパターンに一致するか確認
 */
function matchesBlockedPattern(normalizedPath: string): boolean {
  for (const pattern of BLOCKED_PATH_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      return true;
    }
  }
  return false;
}

/**
 * ファイル名がブロックされるパターンに一致するか確認
 */
export function matchesBlockedFilePattern(filename: string): boolean {
  for (const pattern of BLOCKED_FILE_PATTERNS) {
    if (pattern.test(filename)) {
      return true;
    }
  }
  return false;
}

/**
 * パスが許可されたワークスペース配下にあるか確認
 */
function isWithinAllowedWorkspace(normalizedPath: string, allowedPaths: string[]): boolean {
  for (const allowedPath of allowedPaths) {
    // 正規化されたパスが許可パス配下にあるか確認
    if (normalizedPath === allowedPath || normalizedPath.startsWith(allowedPath + path.sep)) {
      return true;
    }
  }
  return false;
}

/**
 * シンボリックリンクによるエスケープを検出
 * 実パスが許可されたワークスペース外を指している場合を検出
 */
function detectSymlinkEscape(normalizedPath: string, allowedPaths: string[]): boolean {
  try {
    if (!fs.existsSync(normalizedPath)) {
      return false; // パスが存在しない場合はエスケープなし
    }

    const realPath = fs.realpathSync(normalizedPath);
    return !isWithinAllowedWorkspace(realPath, allowedPaths);
  } catch {
    // realpathSync が失敗した場合は安全側に倒す
    return true;
  }
}

// =====================================================
// メイン検証関数
// =====================================================

/**
 * プロジェクトパスを検証
 *
 * セキュリティチェック:
 * 1. ローカルパスアクセスが無効化されていないか
 * 2. パスが正規化後も許可されたワークスペース配下にあるか
 * 3. ディレクトリトラバーサル攻撃パターンが含まれていないか
 * 4. ブロックされるシステムパスパターンに一致しないか
 * 5. シンボリックリンクによるワークスペース外へのエスケープがないか
 *
 * @param inputPath - 検証するパス
 * @returns 検証結果
 *
 * @example
 * ```typescript
 * const result = validateProjectPath('/home/user/my-project');
 * if (!result.isValid) {
 *   throw new Error(result.error?.message);
 * }
 * // result.normalizedPath を使用
 * ```
 */
export function validateProjectPath(inputPath: string): PathValidationResult {
  // 1. ローカルパスアクセスが無効化されているか確認
  if (isLocalPathAccessDisabled()) {
    if (isDevelopment()) {
      logger.warn('[PathSecurity] Local path access is disabled', {
        reason: 'REFTRIX_DISABLE_LOCAL_PATH_ACCESS is set',
      });
    }
    return {
      isValid: false,
      error: {
        code: 'LOCAL_PATH_ACCESS_DISABLED',
        message: 'Local path access is disabled by environment configuration',
      },
    };
  }

  // 2. 入力パスを正規化（ディレクトリトラバーサル対策）
  const normalizedPath = path.resolve(inputPath);

  // 3. ディレクトリトラバーサルパターンの検出（正規化前の入力をチェック）
  // 正規化で解決されるが、悪意のある入力パターンを検出してログ
  if (inputPath.includes('..') || inputPath.includes('./')) {
    if (isDevelopment()) {
      logger.warn('[PathSecurity] Directory traversal pattern detected in input', {
        inputPath,
        normalizedPath,
      });
    }
  }

  // 4. ブロックされるパスパターンの確認
  if (matchesBlockedPattern(normalizedPath)) {
    if (isDevelopment()) {
      logger.warn('[PathSecurity] Blocked path pattern detected', {
        normalizedPath,
      });
    }
    return {
      isValid: false,
      error: {
        code: 'BLOCKED_PATH_PATTERN',
        message: `Access to path "${normalizedPath}" is blocked for security reasons`,
      },
    };
  }

  // 5. 許可されたワークスペース配下にあるか確認
  const allowedPaths = getAllowedWorkspacePaths();
  if (!isWithinAllowedWorkspace(normalizedPath, allowedPaths)) {
    if (isDevelopment()) {
      logger.warn('[PathSecurity] Path not within allowed workspace', {
        normalizedPath,
        allowedPaths,
      });
    }
    return {
      isValid: false,
      error: {
        code: 'PATH_NOT_ALLOWED',
        message: `Path "${normalizedPath}" is not within allowed workspace. Allowed: ${allowedPaths.join(', ')}`,
      },
    };
  }

  // 6. パスの存在確認
  if (!fs.existsSync(normalizedPath)) {
    return {
      isValid: false,
      error: {
        code: 'PATH_NOT_FOUND',
        message: `Path "${normalizedPath}" does not exist`,
      },
    };
  }

  // 7. ディレクトリであることを確認
  try {
    const stat = fs.statSync(normalizedPath);
    if (!stat.isDirectory()) {
      return {
        isValid: false,
        error: {
          code: 'PATH_NOT_DIRECTORY',
          message: `Path "${normalizedPath}" is not a directory`,
        },
      };
    }
  } catch {
    return {
      isValid: false,
      error: {
        code: 'PATH_NOT_FOUND',
        message: `Cannot access path "${normalizedPath}"`,
      },
    };
  }

  // 8. シンボリックリンクによるエスケープ検出
  if (detectSymlinkEscape(normalizedPath, allowedPaths)) {
    if (isDevelopment()) {
      logger.warn('[PathSecurity] Symlink escape detected', {
        normalizedPath,
      });
    }
    return {
      isValid: false,
      error: {
        code: 'SYMLINK_ESCAPE_DETECTED',
        message: `Path "${normalizedPath}" resolves to a location outside allowed workspace via symlink`,
      },
    };
  }

  // 検証成功
  if (isDevelopment()) {
    logger.debug('[PathSecurity] Path validated successfully', {
      normalizedPath,
    });
  }

  return {
    isValid: true,
    normalizedPath,
  };
}

/**
 * ファイルパスを検証（スキャン対象ファイル用）
 *
 * @param filePath - 検証するファイルパス
 * @param workspacePath - 許可されたワークスペースパス
 * @returns 検証成功かどうか
 */
export function validateFilePath(filePath: string, workspacePath: string): boolean {
  const normalizedFilePath = path.resolve(filePath);
  const normalizedWorkspace = path.resolve(workspacePath);

  // ワークスペース配下であることを確認
  if (!normalizedFilePath.startsWith(normalizedWorkspace + path.sep)) {
    if (isDevelopment()) {
      logger.warn('[PathSecurity] File path outside workspace', {
        filePath: normalizedFilePath,
        workspace: normalizedWorkspace,
      });
    }
    return false;
  }

  // ブロックされるパスパターンの確認
  if (matchesBlockedPattern(normalizedFilePath)) {
    return false;
  }

  // ブロックされるファイル名パターンの確認
  const filename = path.basename(normalizedFilePath);
  if (matchesBlockedFilePattern(filename)) {
    if (isDevelopment()) {
      logger.warn('[PathSecurity] Blocked file pattern detected', {
        filename,
      });
    }
    return false;
  }

  return true;
}

// =====================================================
// 開発環境ログ
// =====================================================

if (isDevelopment()) {
  logger.debug('[PathSecurity] Module loaded', {
    localPathAccessDisabled: isLocalPathAccessDisabled(),
    allowedWorkspacePaths: getAllowedWorkspacePaths(),
  });
}
