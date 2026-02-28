// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Server - 認証ミドルウェア
 *
 * SEC監査対応: CWE-306 (Missing Authentication for Critical Function)
 * CVSS Score: 7.5 (High)
 *
 * このモジュールはMCPサーバーの認証・認可機能を提供します。
 * Phase 1: APIキー認証
 * Phase 2: JWT認証（将来実装）
 *
 * @module middleware/auth
 */

import { timingSafeEqual } from 'crypto';
import { logger, isDevelopment } from '../utils/logger';

// ============================================================================
// 型定義
// ============================================================================

/**
 * ユーザーロール
 */
export type Role = 'VIEWER' | 'USER' | 'ADMIN';

/**
 * 認証コンテキスト
 * ツール実行時に渡される認証情報
 */
export interface AuthContext {
  /** ユーザーID */
  userId: string;

  /** ユーザーのロール */
  role: Role;

  /** 付与されたパーミッション */
  permissions: string[];

  /** 認証方式 */
  authMethod: 'api_key' | 'jwt' | 'none';

  /** 認証日時 */
  authenticatedAt: Date;
}

/**
 * 認証ミドルウェアのオプション
 */
export interface AuthMiddlewareOptions {
  /** 認証を有効化するか（デフォルト: false = 後方互換性維持） */
  enabled?: boolean;

  /** 認証なしでアクセス可能なツール */
  publicTools?: string[];
}

/**
 * 認証エラーコード
 */
export type AuthErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INVALID_API_KEY'
  | 'EXPIRED_TOKEN';

/**
 * 認証結果
 */
export interface AuthResult {
  /** 認証成功 */
  success: boolean;

  /** 失敗理由 */
  error?: {
    code: AuthErrorCode;
    message: string;
  };

  /** 認証コンテキスト（成功時） */
  context?: AuthContext;
}

/**
 * 認証ミドルウェアのインスタンス
 */
export interface AuthMiddlewareInstance {
  /** 認証チェック関数 */
  checkAuth: (
    toolName: string,
    apiKey: string | undefined
  ) => Promise<AuthResult>;

  /** オプション設定 */
  options: Required<AuthMiddlewareOptions>;
}

// ============================================================================
// パーミッション定義
// ============================================================================

/**
 * パーミッション定義（WebDesign専用）
 * 全パーミッションの一覧
 */
export const PERMISSIONS = {
  // システム系
  SYSTEM_READ: 'system:read',
  SYSTEM_HEALTH: 'system:health',
  SYSTEM_ADMIN: 'system:admin',
  // レイアウト系
  LAYOUT_READ: 'layout:read',
  LAYOUT_WRITE: 'layout:write',
  LAYOUT_TRANSFORM: 'layout:transform',
  // モーション系
  MOTION_READ: 'motion:read',
  MOTION_TRANSFORM: 'motion:transform',
  // 品質系
  QUALITY_READ: 'quality:read',
  QUALITY_WRITE: 'quality:write',
  // プロジェクト系
  PROJECT_READ: 'project:read',
  // デザイン系
  DESIGN_REVIEW: 'design:review',
  DESIGN_WRITE: 'design:write',
  // スタイル系
  STYLE_READ: 'style:read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * ロールごとのパーミッション（WebDesign専用）
 */
export const ROLES: Record<Role, string[]> = {
  VIEWER: [
    PERMISSIONS.SYSTEM_READ,
    PERMISSIONS.SYSTEM_HEALTH,
    PERMISSIONS.LAYOUT_READ,
    PERMISSIONS.MOTION_READ,
    PERMISSIONS.QUALITY_READ,
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.STYLE_READ,
  ],
  USER: [
    PERMISSIONS.SYSTEM_READ,
    PERMISSIONS.SYSTEM_HEALTH,
    PERMISSIONS.LAYOUT_READ,
    PERMISSIONS.LAYOUT_TRANSFORM,
    PERMISSIONS.MOTION_READ,
    PERMISSIONS.MOTION_TRANSFORM,
    PERMISSIONS.QUALITY_READ,
    PERMISSIONS.QUALITY_WRITE,
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.DESIGN_REVIEW,
    PERMISSIONS.STYLE_READ,
  ],
  ADMIN: [
    PERMISSIONS.SYSTEM_READ,
    PERMISSIONS.SYSTEM_HEALTH,
    PERMISSIONS.SYSTEM_ADMIN,
    PERMISSIONS.LAYOUT_READ,
    PERMISSIONS.LAYOUT_WRITE,
    PERMISSIONS.LAYOUT_TRANSFORM,
    PERMISSIONS.MOTION_READ,
    PERMISSIONS.MOTION_TRANSFORM,
    PERMISSIONS.QUALITY_READ,
    PERMISSIONS.QUALITY_WRITE,
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.DESIGN_REVIEW,
    PERMISSIONS.DESIGN_WRITE,
    PERMISSIONS.STYLE_READ,
  ],
};

/**
 * ツールごとの必要パーミッション（WebDesign専用）
 */
export const TOOL_PERMISSIONS: Record<string, string[]> = {
  // スタイル系
  'style.get_palette': [PERMISSIONS.STYLE_READ],

  // レイアウト系
  'layout.inspect': [PERMISSIONS.LAYOUT_READ],
  'layout.search': [PERMISSIONS.LAYOUT_READ],
  'layout.ingest': [PERMISSIONS.LAYOUT_WRITE],
  'layout.generate_code': [PERMISSIONS.LAYOUT_TRANSFORM],
  'layout.batch_ingest': [PERMISSIONS.LAYOUT_WRITE],

  // 品質系
  'quality.evaluate': [PERMISSIONS.QUALITY_READ],
  'quality.batch_evaluate': [PERMISSIONS.QUALITY_READ],
  'quality.getJobStatus': [PERMISSIONS.QUALITY_READ],

  // モーション系
  'motion.detect': [PERMISSIONS.MOTION_READ],
  'motion.search': [PERMISSIONS.MOTION_READ],

  // ブリーフ系（デザインレビュー）
  'brief.validate': [PERMISSIONS.DESIGN_REVIEW],

  // プロジェクト系
  'project.get': [PERMISSIONS.PROJECT_READ],
  'project.list': [PERMISSIONS.PROJECT_READ],

  // ページ系（統合Web分析）
  'page.analyze': [PERMISSIONS.LAYOUT_READ, PERMISSIONS.MOTION_READ, PERMISSIONS.QUALITY_READ],
  'page.getJobStatus': [PERMISSIONS.LAYOUT_READ],

  // システム系（公開ツール）
  'system.health': [PERMISSIONS.SYSTEM_HEALTH],
};

/**
 * デフォルトの公開ツール（認証不要）
 * 注意: allToolDefinitions に登録されているツールのみを含めること
 */
export const PUBLIC_TOOLS = ['system.health'];

// ============================================================================
// テスト用APIキー定義（開発環境のみ）
// ============================================================================

/**
 * テスト用APIキーとロールのマッピング
 *
 * セキュリティ: 本番環境（NODE_ENV=production）ではテスト用キーは無効化されます。
 * 本番環境では必ず MCP_API_KEYS 環境変数で認証情報を設定してください。
 */
const TEST_API_KEY_MAPPINGS: Record<
  string,
  { role: Role; userId: string; expired?: boolean }
> = isDevelopment()
  ? {
      reftrix_admin_test_key_12345678: {
        role: 'ADMIN',
        userId: 'admin-user-001',
      },
      reftrix_user_test_key_87654321: {
        role: 'USER',
        userId: 'standard-user-001',
      },
      reftrix_viewer_test_key_11111111: {
        role: 'VIEWER',
        userId: 'viewer-user-001',
      },
      reftrix_expired_test_key_99999999: {
        role: 'USER',
        userId: 'expired-user-001',
        expired: true,
      },
    }
  : {}; // 本番環境ではテスト用キーは空

// ============================================================================
// 認証関数
// ============================================================================

/**
 * 定数時間でAPIキーを比較する（タイミング攻撃対策）
 *
 * @param provided - 提供されたAPIキー
 * @param stored - 保存されているAPIキー
 * @returns 一致する場合はtrue
 */
function safeCompareApiKey(provided: string, stored: string): boolean {
  // 異なる長さの場合でも定数時間で処理
  const providedBuffer = Buffer.from(provided);
  const storedBuffer = Buffer.from(stored);

  // 長さが異なる場合は、同じ長さのダミー比較を行う
  if (providedBuffer.length !== storedBuffer.length) {
    // ダミー比較（タイミング攻撃対策）
    timingSafeEqual(providedBuffer, providedBuffer);
    return false;
  }

  return timingSafeEqual(providedBuffer, storedBuffer);
}

/**
 * APIキーを検証してAuthContextを返す
 *
 * @param apiKey - 検証するAPIキー
 * @returns 認証成功時はAuthContext、失敗時はnull
 */
export async function validateApiKey(
  apiKey: string | undefined
): Promise<AuthContext | null> {
  // APIキーが提供されていない場合
  if (!apiKey) {
    if (isDevelopment()) {
      logger.debug('[Auth] API key not provided');
    }
    return null;
  }

  // APIキー形式の検証（reftrix_ プレフィックスで始まること）
  if (!apiKey.startsWith('reftrix_')) {
    if (isDevelopment()) {
      logger.debug('[Auth] Invalid API key format');
    }
    return null;
  }

  // テスト用APIキーのチェック（定数時間比較）
  // 全てのテスト用キーと比較し、タイミング攻撃を防止
  let matchedMapping: { role: Role; userId: string; expired?: boolean } | null =
    null;
  for (const [storedKey, mapping] of Object.entries(TEST_API_KEY_MAPPINGS)) {
    if (safeCompareApiKey(apiKey, storedKey)) {
      matchedMapping = mapping;
      break;
    }
  }

  if (matchedMapping) {
    // 期限切れチェック
    if (matchedMapping.expired) {
      if (isDevelopment()) {
        logger.debug('[Auth] API key expired');
      }
      return null;
    }

    return {
      userId: matchedMapping.userId,
      role: matchedMapping.role,
      permissions: ROLES[matchedMapping.role],
      authMethod: 'api_key',
      authenticatedAt: new Date(),
    };
  }

  // 環境変数から追加のAPIキーをチェック（本番環境向け、定数時間比較）
  const envApiKeys = process.env.MCP_API_KEYS;
  if (envApiKeys) {
    try {
      const keys = JSON.parse(envApiKeys) as Array<{
        key: string;
        role: Role;
        userId: string;
        expiresAt?: string;
      }>;

      // 定数時間比較で全てのキーをチェック
      const keyConfig = keys.find((k) => safeCompareApiKey(apiKey, k.key));
      if (keyConfig) {
        // 有効期限チェック
        if (keyConfig.expiresAt) {
          const expiresAt = new Date(keyConfig.expiresAt);
          if (expiresAt < new Date()) {
            if (isDevelopment()) {
              logger.debug('[Auth] API key expired (from env)');
            }
            return null;
          }
        }

        return {
          userId: keyConfig.userId,
          role: keyConfig.role,
          permissions: ROLES[keyConfig.role],
          authMethod: 'api_key',
          authenticatedAt: new Date(),
        };
      }
    } catch {
      logger.warn(
        '[Auth] Failed to parse MCP_API_KEYS environment variable. ' +
          'Expected JSON array: [{"key":"reftrix_...","role":"ADMIN","userId":"..."}]'
      );
      if (isDevelopment()) {
        logger.error(
          '[Auth] MCP_API_KEYS parse error. Current value: %s',
          envApiKeys.slice(0, 50) + (envApiKeys.length > 50 ? '...' : '')
        );
      }
    }
  }

  // 有効なキーが見つからない場合
  if (isDevelopment()) {
    logger.debug('[Auth] API key not found in valid keys');
  }
  return null;
}

/**
 * 認証コンテキストがツールに対する権限を持つかチェック
 *
 * deny-by-default ポリシー:
 * - TOOL_PERMISSIONS に定義されていないツールは拒否
 * - これにより未登録ツールへの不正アクセスを防止
 *
 * @param context - 認証コンテキスト
 * @param toolName - ツール名
 * @returns 権限がある場合はtrue
 */
export function checkPermission(context: AuthContext, toolName: string): boolean {
  // deny-by-default: TOOL_PERMISSIONS に未定義のツールは拒否
  if (!(toolName in TOOL_PERMISSIONS)) {
    if (isDevelopment()) {
      logger.warn('[Auth] Unknown tool rejected (deny-by-default)', { toolName });
    }
    return false;
  }

  const requiredPermissions = TOOL_PERMISSIONS[toolName];

  // ツールが定義されていない場合はfalse（deny-by-default）
  if (!requiredPermissions) {
    if (process.env.NODE_ENV === 'development') {
      logger.warn('[Auth] Tool not found in TOOL_PERMISSIONS', { toolName });
    }
    return false;
  }

  // 必要なパーミッションが空の場合（公開ツール相当）は許可
  if (requiredPermissions.length === 0) {
    return true;
  }

  // ADMINは全権限を持つ
  if (context.role === 'ADMIN') {
    return true;
  }

  // 必要なパーミッションのいずれかを持っているか確認
  return requiredPermissions.some((perm) => context.permissions.includes(perm));
}

// ============================================================================
// ミドルウェアファクトリ
// ============================================================================

/**
 * 認証ミドルウェアを作成
 *
 * @param options - オプション設定
 * @returns 認証ミドルウェアインスタンス
 */
export function createAuthMiddleware(
  options?: AuthMiddlewareOptions
): AuthMiddlewareInstance {
  const resolvedOptions: Required<AuthMiddlewareOptions> = {
    enabled: options?.enabled ?? false,
    publicTools: options?.publicTools ?? PUBLIC_TOOLS,
  };

  /**
   * 認証チェック関数
   */
  const checkAuth = async (
    toolName: string,
    apiKey: string | undefined
  ): Promise<AuthResult> => {
    // 認証無効時はスキップ
    if (!resolvedOptions.enabled) {
      if (isDevelopment()) {
        logger.debug('[Auth] Authentication disabled, skipping check');
      }
      return { success: true };
    }

    // 公開ツールは認証不要
    if (resolvedOptions.publicTools.includes(toolName)) {
      if (isDevelopment()) {
        logger.debug(`[Auth] Public tool: ${toolName}, skipping authentication`);
      }
      return { success: true };
    }

    // APIキー検証
    const context = await validateApiKey(apiKey);
    if (!context) {
      if (isDevelopment()) {
        logger.warn('[Auth] Authentication failed', {
          tool: toolName,
          reason: 'INVALID_OR_MISSING_KEY',
        });
      }
      return {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        },
      };
    }

    // 権限チェック
    if (!checkPermission(context, toolName)) {
      if (isDevelopment()) {
        logger.warn('[Auth] Authorization denied', {
          tool: toolName,
          role: context.role,
          requiredPermissions: TOOL_PERMISSIONS[toolName],
          userPermissions: context.permissions,
        });
      }
      return {
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Insufficient permissions',
        },
      };
    }

    // 認証成功
    if (isDevelopment()) {
      logger.info('[Auth] Authentication successful', {
        tool: toolName,
        userId: context.userId,
        role: context.role,
      });
    }

    return {
      success: true,
      context,
    };
  };

  return {
    checkAuth,
    options: resolvedOptions,
  };
}
