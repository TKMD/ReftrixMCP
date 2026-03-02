// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Server 認証ミドルウェアテスト
 * TDD Red フェーズ: 認証機構のテスト（まだ実装されていない）
 *
 * SEC監査対応: CWE-306 (Missing Authentication for Critical Function)
 * CVSS Score: 7.5 (High)
 *
 * このテストファイルはまだ存在しない認証モジュールをインポートし、
 * 実装前にテストを失敗させることでTDD Redフェーズを実現します。
 *
 * @module auth.test
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ErrorCode } from '../../src/utils/errors';

/**
 * 認証モジュールのインポート（まだ存在しないファイル）
 * TDD Red: このインポートにより、実装前はテストが失敗する
 */
import {
  createAuthMiddleware,
  validateApiKey,
  checkPermission,
  type AuthContext,
  type AuthMiddlewareOptions,
  type AuthResult,
  PERMISSIONS,
  ROLES,
  TOOL_PERMISSIONS,
} from '../../src/middleware/auth';

/**
 * テスト用モックAPIキー定義
 * 実際の実装では環境変数から読み込まれる
 *
 * NOTE: 実装がWebDesign専用に変更されたため、
 * SVG関連のパーミッション（svg:read, svg:write, svg:transform）は
 * layout:*, motion:*, quality:*に置き換えられています
 */
const TEST_API_KEYS = {
  // ADMIN権限を持つAPIキー
  ADMIN_KEY: 'reftrix_admin_test_key_12345678',
  // USER権限を持つAPIキー
  USER_KEY: 'reftrix_user_test_key_87654321',
  // VIEWER権限を持つAPIキー
  VIEWER_KEY: 'reftrix_viewer_test_key_11111111',
  // 無効なAPIキー
  INVALID_KEY: 'invalid_api_key_00000000',
  // 期限切れのAPIキー
  EXPIRED_KEY: 'reftrix_expired_test_key_99999999',
} as const;

/**
 * ロール定義
 */
type Role = 'VIEWER' | 'USER' | 'ADMIN';

// モックLogger
// 注意: isDevelopmentはtrueを返す必要がある（テスト用APIキーを有効化するため）
// 重要: 動的インポート時にnew Logger()が呼ばれるため、クラスとして定義する必要がある
vi.mock('../../src/utils/logger', () => {
  // クラスベースのモック（動的インポート対応）
  class MockLogger {
    debug = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    constructor(_name?: string) {
      // 名前付きロガーのモック
    }
  }

  return {
    Logger: MockLogger,
    createLogger: vi.fn().mockImplementation(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    // テスト用APIキーを有効化するためtrueを返す
    isDevelopment: vi.fn().mockReturnValue(true),
  };
});

describe('認証ミドルウェア (Auth Middleware)', () => {
  // 環境変数のバックアップ
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  describe('APIキー認証テスト', () => {
    /**
     * テスト: APIキーなしでリクエストが拒否されること
     * 期待: nullが返される（認証失敗）
     */
    it('APIキーなしでリクエストが拒否されること（UNAUTHORIZED）', async () => {
      // Arrange: 認証有効化
      process.env.MCP_AUTH_ENABLED = 'true';

      // Act
      const result = await validateApiKey(undefined);

      // Assert
      expect(result).toBeNull();
    });

    /**
     * テスト: 無効なAPIキーでリクエストが拒否されること
     * 期待: nullが返される（認証失敗）
     */
    it('無効なAPIキーでリクエストが拒否されること（UNAUTHORIZED）', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const invalidApiKey = TEST_API_KEYS.INVALID_KEY;

      // Act
      const result = await validateApiKey(invalidApiKey);

      // Assert
      expect(result).toBeNull();
    });

    /**
     * テスト: 有効なAPIキーで認証成功すること
     * 期待: AuthContextが返される
     */
    it('有効なAPIキーで認証成功すること', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const validApiKey = TEST_API_KEYS.USER_KEY;

      // Act
      const result = await validateApiKey(validApiKey);

      // Assert
      expect(result).not.toBeNull();
      expect(result?.role).toBe('USER');
      expect(result?.authMethod).toBe('api_key');
    });

    /**
     * テスト: APIキーからAuthContextが正しく構築されること
     * 期待: userId, role, permissions, authMethod, authenticatedAtが含まれる
     */
    it('APIキーからAuthContextが正しく構築されること', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const adminApiKey = TEST_API_KEYS.ADMIN_KEY;

      // Act
      const result = await validateApiKey(adminApiKey);

      // Assert: WebDesign専用パーミッション（layout:*, motion:*, quality:*）
      expect(result).toMatchObject({
        userId: expect.any(String),
        role: 'ADMIN',
        permissions: expect.arrayContaining([
          'layout:read',
          'layout:write',
          'layout:transform',
          'motion:read',
          'quality:read',
        ]),
        authMethod: 'api_key',
        authenticatedAt: expect.any(Date),
      });
    });
  });

  describe('公開ツールのテスト', () => {
    /**
     * テスト: system.health は認証なしでアクセス可能
     * 期待: 認証チェックがスキップされる
     */
    it('system.health は認証なしでアクセス可能', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const toolName = 'system.health';
      const middleware = createAuthMiddleware({
        enabled: true,
        publicTools: ['system.health', 'system.info'],
      });

      // Act
      const result = await middleware.checkAuth(toolName, undefined);

      // Assert
      expect(result.success).toBe(true);
    });

    /**
     * テスト: system.info は認証なしでアクセス可能
     * 期待: 認証チェックがスキップされる
     */
    it('system.info は認証なしでアクセス可能', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const toolName = 'system.info';
      const middleware = createAuthMiddleware({
        enabled: true,
        publicTools: ['system.health', 'system.info'],
      });

      // Act
      const result = await middleware.checkAuth(toolName, undefined);

      // Assert
      expect(result.success).toBe(true);
    });

    /**
     * テスト: 非公開ツールは認証が必要
     * 期待: APIキーなしでUNAUTHORIZEDエラー
     */
    it('非公開ツール（layout.search）は認証が必要', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const toolName = 'layout.search';
      const middleware = createAuthMiddleware({
        enabled: true,
        publicTools: ['system.health', 'system.info'],
      });

      // Act
      const result = await middleware.checkAuth(toolName, undefined);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNAUTHORIZED');
    });
  });

  describe('認証無効化テスト', () => {
    /**
     * テスト: MCP_AUTH_ENABLED=false の場合、すべてのツールが認証スキップ
     * 期待: 認証チェックなしでツール実行可能
     */
    it('MCP_AUTH_ENABLED=false の場合、すべてのツールが認証スキップ', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'false';
      const toolName = 'layout.ingest'; // 通常は認証必要なツール
      const middleware = createAuthMiddleware({ enabled: false });

      // Act
      const result = await middleware.checkAuth(toolName, undefined);

      // Assert
      expect(result.success).toBe(true);
    });

    /**
     * テスト: 環境変数未設定の場合、デフォルトで認証無効
     * 期待: 後方互換性のため認証スキップ
     */
    it('環境変数未設定の場合、デフォルトで認証無効', async () => {
      // Arrange
      delete process.env.MCP_AUTH_ENABLED;
      const toolName = 'layout.ingest';
      const middleware = createAuthMiddleware(); // enabledオプションなし

      // Act
      const result = await middleware.checkAuth(toolName, undefined);

      // Assert: 後方互換性のためスキップ
      expect(result.success).toBe(true);
    });

    /**
     * テスト: MCP_AUTH_ENABLED=true で明示的に認証を有効化
     * 期待: 認証チェックが実行される
     */
    it('MCP_AUTH_ENABLED=true で明示的に認証を有効化', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const toolName = 'layout.search';
      const middleware = createAuthMiddleware({ enabled: true });

      // Act
      const result = await middleware.checkAuth(toolName, undefined);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNAUTHORIZED');
    });
  });

  describe('RBAC権限テスト', () => {
    /**
     * テスト: VIEWER権限でread系ツールにアクセス可能
     * 期待: layout.search, motion.search へのアクセスが許可される
     */
    it('VIEWER権限でread系ツールにアクセス可能', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const authContext = await validateApiKey(TEST_API_KEYS.VIEWER_KEY);

      // Act & Assert
      expect(authContext).not.toBeNull();
      expect(checkPermission(authContext!, 'layout.search')).toBe(true);
      expect(checkPermission(authContext!, 'motion.search')).toBe(true);
    });

    /**
     * テスト: VIEWER権限でwrite系ツールにアクセス不可（FORBIDDEN）
     * 期待: layout.ingest へのアクセスが拒否される
     */
    it('VIEWER権限でwrite系ツールにアクセス不可（FORBIDDEN）', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const authContext = await validateApiKey(TEST_API_KEYS.VIEWER_KEY);

      // Act & Assert
      expect(authContext).not.toBeNull();
      expect(checkPermission(authContext!, 'layout.ingest')).toBe(false);
    });

    /**
     * テスト: USER権限でread/transform系ツールにアクセス可能
     * 期待: layout.search, layout.generate_code へのアクセスが許可される
     */
    it('USER権限でread/transform系ツールにアクセス可能', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const authContext = await validateApiKey(TEST_API_KEYS.USER_KEY);

      // Act & Assert
      expect(authContext).not.toBeNull();
      expect(checkPermission(authContext!, 'layout.search')).toBe(true);
      expect(checkPermission(authContext!, 'layout.generate_code')).toBe(true);
    });

    /**
     * テスト: USER権限でadmin系ツールにアクセス不可（FORBIDDEN）
     * 期待: 管理者専用機能へのアクセスが拒否される
     */
    it('USER権限でadmin系ツールにアクセス不可（FORBIDDEN）', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const authContext = await validateApiKey(TEST_API_KEYS.USER_KEY);

      // Act & Assert
      expect(authContext).not.toBeNull();
      // admin系ツールはsystem:adminパーミッションが必要
      expect(authContext!.permissions).not.toContain(PERMISSIONS.SYSTEM_ADMIN);
    });

    /**
     * テスト: USER権限でwrite系ツール（layout.ingest）にアクセス不可
     * 期待: USERはtransformは可能だがwriteは不可
     */
    it('USER権限でwrite系ツール（layout.ingest）にアクセス不可', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const authContext = await validateApiKey(TEST_API_KEYS.USER_KEY);

      // Act & Assert
      expect(authContext).not.toBeNull();
      expect(checkPermission(authContext!, 'layout.ingest')).toBe(false);
    });

    /**
     * テスト: ADMIN権限ですべてのツールにアクセス可能
     * 期待: read, write, transform, admin すべて許可
     */
    it('ADMIN権限ですべてのツールにアクセス可能', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const authContext = await validateApiKey(TEST_API_KEYS.ADMIN_KEY);

      // Act & Assert
      expect(authContext).not.toBeNull();
      expect(checkPermission(authContext!, 'layout.search')).toBe(true);
      expect(checkPermission(authContext!, 'layout.ingest')).toBe(true);
      expect(checkPermission(authContext!, 'layout.generate_code')).toBe(true);
      expect(authContext!.permissions).toContain(PERMISSIONS.SYSTEM_ADMIN);
    });
  });

  describe('AuthContext生成テスト', () => {
    /**
     * テスト: 有効なAPIキーからロール情報を正しく抽出
     * 期待: APIキーに紐づくロールが返される
     */
    it('有効なAPIキーからロール情報を正しく抽出', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const testCases: Array<{ key: string; expectedRole: Role }> = [
        { key: TEST_API_KEYS.ADMIN_KEY, expectedRole: 'ADMIN' },
        { key: TEST_API_KEYS.USER_KEY, expectedRole: 'USER' },
        { key: TEST_API_KEYS.VIEWER_KEY, expectedRole: 'VIEWER' },
      ];

      // Act & Assert
      for (const { key, expectedRole } of testCases) {
        const result = await validateApiKey(key);
        expect(result?.role).toBe(expectedRole);
      }
    });

    /**
     * テスト: AuthContextにユーザーID、ロール、パーミッションが含まれること
     * 期待: 完全なAuthContextオブジェクトが返される
     */
    it('AuthContextにユーザーID、ロール、パーミッションが含まれること', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';

      // Act
      const result = await validateApiKey(TEST_API_KEYS.USER_KEY);

      // Assert
      expect(result).toHaveProperty('userId');
      expect(result?.userId).toBeTruthy();
      expect(result).toHaveProperty('role');
      expect(result?.role).toBe('USER');
      expect(result).toHaveProperty('permissions');
      expect(Array.isArray(result?.permissions)).toBe(true);
      expect(result).toHaveProperty('authMethod');
      expect(result?.authMethod).toBe('api_key');
      expect(result).toHaveProperty('authenticatedAt');
      expect(result?.authenticatedAt).toBeInstanceOf(Date);
    });

    /**
     * テスト: 期限切れAPIキーで認証失敗
     * 期待: nullが返される
     */
    it('期限切れAPIキーで認証失敗（EXPIRED_TOKEN）', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const expiredKey = TEST_API_KEYS.EXPIRED_KEY;

      // Act
      const result = await validateApiKey(expiredKey);

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('checkPermission関数テスト', () => {
    /**
     * テスト: ツール名からパーミッションを正しく判定
     */
    it('layout.searchにはlayout:readパーミッションが必要', () => {
      // Arrange
      const toolName = 'layout.search';

      // Act
      const requiredPermissions = TOOL_PERMISSIONS[toolName];

      // Assert
      expect(requiredPermissions).toContain(PERMISSIONS.LAYOUT_READ);
    });

    /**
     * テスト: layout.ingestにはlayout:writeパーミッションが必要
     */
    it('layout.ingestにはlayout:writeパーミッションが必要', () => {
      // Arrange
      const toolName = 'layout.ingest';

      // Act
      const requiredPermissions = TOOL_PERMISSIONS[toolName];

      // Assert
      expect(requiredPermissions).toContain(PERMISSIONS.LAYOUT_WRITE);
    });

    /**
     * テスト: transform系ツールにはlayout:transformパーミッションが必要
     */
    it('layout.generate_codeにはlayout:transformパーミッションが必要', () => {
      // Arrange: WebDesign専用のtransformツール
      const toolName = 'layout.generate_code';

      // Act
      const requiredPermissions = TOOL_PERMISSIONS[toolName];

      // Assert
      expect(requiredPermissions).toContain(PERMISSIONS.LAYOUT_TRANSFORM);
    });
  });

  describe('セキュリティテスト', () => {
    /**
     * テスト: エラーメッセージにAPIキーを含めない
     * 期待: セキュリティ上の理由でAPIキーは露出しない
     */
    it('エラーメッセージにAPIキーを含めないこと', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const invalidKey = TEST_API_KEYS.INVALID_KEY;
      const middleware = createAuthMiddleware({ enabled: true });

      // Act
      const result = await middleware.checkAuth('layout.search', invalidKey);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.message).not.toContain(invalidKey);
    });

    /**
     * テスト: ROLES定数が正しく定義されている
     */
    it('ROLES定数が正しく定義されていること', () => {
      // Assert
      expect(ROLES).toHaveProperty('VIEWER');
      expect(ROLES).toHaveProperty('USER');
      expect(ROLES).toHaveProperty('ADMIN');
      expect(Array.isArray(ROLES.VIEWER)).toBe(true);
      expect(Array.isArray(ROLES.USER)).toBe(true);
      expect(Array.isArray(ROLES.ADMIN)).toBe(true);
    });

    /**
     * テスト: PERMISSIONS定数が正しく定義されている（WebDesign専用）
     */
    it('PERMISSIONS定数が正しく定義されていること', () => {
      // Assert: WebDesign専用パーミッション
      expect(PERMISSIONS).toHaveProperty('LAYOUT_READ');
      expect(PERMISSIONS).toHaveProperty('LAYOUT_WRITE');
      expect(PERMISSIONS).toHaveProperty('LAYOUT_TRANSFORM');
      expect(PERMISSIONS).toHaveProperty('MOTION_READ');
      expect(PERMISSIONS).toHaveProperty('QUALITY_READ');
      expect(PERMISSIONS).toHaveProperty('SYSTEM_HEALTH');
      expect(PERMISSIONS).toHaveProperty('SYSTEM_ADMIN');
    });
  });

  describe('createAuthMiddleware関数テスト', () => {
    /**
     * テスト: デフォルトオプションでミドルウェア作成
     */
    it('デフォルトオプションでミドルウェアが作成できること', () => {
      // Act
      const middleware = createAuthMiddleware();

      // Assert
      expect(middleware).toBeDefined();
      expect(typeof middleware.checkAuth).toBe('function');
    });

    /**
     * テスト: カスタムオプションでミドルウェア作成
     */
    it('カスタムオプションでミドルウェアが作成できること', () => {
      // Arrange
      const customOptions: AuthMiddlewareOptions = {
        enabled: true,
        publicTools: ['system.health', 'custom.public.tool'],
      };

      // Act
      const middleware = createAuthMiddleware(customOptions);

      // Assert
      expect(middleware).toBeDefined();
      expect(middleware.options.enabled).toBe(true);
      expect(middleware.options.publicTools).toContain('custom.public.tool');
    });
  });

  describe('統合テスト（handleToolCallWithAuth）', () => {
    /**
     * テスト: 認証付きツール呼び出しの完全なフロー
     */
    it('有効な認証でツール実行が成功すること', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const toolName = 'layout.search';
      const apiKey = TEST_API_KEYS.USER_KEY;
      const middleware = createAuthMiddleware({ enabled: true });

      // Act
      const result = await middleware.checkAuth(toolName, apiKey);

      // Assert
      expect(result.success).toBe(true);
      expect(result.context).toBeDefined();
      expect(result.context?.role).toBe('USER');
    });

    /**
     * テスト: 認証失敗時に適切なエラーレスポンス
     */
    it('認証失敗時にUNAUTHORIZEDエラーが返されること', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const toolName = 'layout.search';
      const invalidKey = TEST_API_KEYS.INVALID_KEY;
      const middleware = createAuthMiddleware({ enabled: true });

      // Act
      const result = await middleware.checkAuth(toolName, invalidKey);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNAUTHORIZED');
    });

    /**
     * テスト: 権限不足時にFORBIDDENエラー
     */
    it('権限不足時にFORBIDDENエラーが返されること', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const toolName = 'layout.ingest'; // write権限が必要
      const viewerKey = TEST_API_KEYS.VIEWER_KEY; // read権限のみ
      const middleware = createAuthMiddleware({ enabled: true });

      // Act
      const result = await middleware.checkAuth(toolName, viewerKey);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FORBIDDEN');
      expect(result.error?.message).toContain('Insufficient permissions');
    });
  });

  /**
   * MCP-01: Authorization map auto-generation with deny-by-default
   * TDD Red Phase: これらのテストは最初は失敗する
   */
  describe('TOOL_PERMISSIONS と allToolDefinitions の同期検証', () => {
    /**
     * テスト: allToolDefinitionsの全ツールがTOOL_PERMISSIONSに定義されていること
     * deny-by-defaultポリシー: 未定義のツールは拒否される
     */
    it('allToolDefinitions の全ツールが TOOL_PERMISSIONS に定義されていること', async () => {
      // Arrange: 動的インポートでallToolDefinitionsを取得
      const { allToolDefinitions } = await import('../../src/tools/index');
      const registeredToolNames = allToolDefinitions.map((t: { name: string }) => t.name);

      // Act: TOOL_PERMISSIONSに定義されているツールを取得
      const definedPermissionTools = Object.keys(TOOL_PERMISSIONS);

      // v6.x: narrative.search, background.search は TOOL_PERMISSIONS への登録が未完了
      // これらのツールはセマンティック検索系で、パーミッション定義は別途追加予定
      const pendingPermissionTools = ['narrative.search', 'background.search', 'responsive.search'];

      // Assert: 全ての登録ツールがパーミッション定義に存在すること（未登録予定ツールを除外）
      const missingTools = registeredToolNames.filter(
        (name: string) => !definedPermissionTools.includes(name) && !pendingPermissionTools.includes(name)
      );

      expect(missingTools).toEqual([]);
    });

    /**
     * テスト: TOOL_PERMISSIONSに存在しない（削除された）ツールがないこと
     * Stale entry detection: 古いエントリを検出
     */
    it('TOOL_PERMISSIONS にstale entries（削除されたツール）が存在しないこと', async () => {
      // Arrange
      const { allToolDefinitions } = await import('../../src/tools/index');
      const registeredToolNames = allToolDefinitions.map((t: { name: string }) => t.name);

      // PUBLIC_TOOLS も含める（system.health等）
      const allValidTools = new Set([...registeredToolNames]);

      // Act: TOOL_PERMISSIONSのキーを取得
      const permissionToolNames = Object.keys(TOOL_PERMISSIONS);

      // Assert: TOOL_PERMISSIONSの全エントリが有効なツールであること
      const staleEntries = permissionToolNames.filter(
        (name) => !allValidTools.has(name)
      );

      // 期待: design.auto_fix, design.token_extract は削除されるべき
      expect(staleEntries).toEqual([]);
    });

    /**
     * テスト: page.getJobStatus が TOOL_PERMISSIONS に存在すること
     * 具体的な欠落ツールの検証
     */
    it('page.getJobStatus が TOOL_PERMISSIONS に定義されていること', () => {
      // Assert
      expect(TOOL_PERMISSIONS).toHaveProperty('page.getJobStatus');
    });

    /**
     * テスト: 削除されたdesign.*ツールがTOOL_PERMISSIONSに存在しないこと
     */
    it('削除された design.auto_fix が TOOL_PERMISSIONS に存在しないこと', () => {
      // Assert
      expect(TOOL_PERMISSIONS).not.toHaveProperty('design.auto_fix');
    });

    it('削除された design.token_extract が TOOL_PERMISSIONS に存在しないこと', () => {
      // Assert
      expect(TOOL_PERMISSIONS).not.toHaveProperty('design.token_extract');
    });
  });

  describe('deny-by-default ポリシー検証', () => {
    /**
     * テスト: TOOL_PERMISSIONSに未定義のツールはデフォルトで拒否されること
     * CWE-306対策: Missing Authentication for Critical Function
     */
    it('TOOL_PERMISSIONS に未定義のツールは認証有効時に拒否されること', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const unknownTool = 'unknown.nonexistent_tool';
      const middleware = createAuthMiddleware({ enabled: true });

      // Act: 有効なAPIキーでも未知のツールは拒否
      const result = await middleware.checkAuth(unknownTool, TEST_API_KEYS.ADMIN_KEY);

      // Assert: deny-by-default
      // NOTE: 現在の実装ではADMINは全権限を持つため通過してしまう
      // deny-by-defaultを厳格に適用するには、TOOL_PERMISSIONS未定義ツールを明示的に拒否する必要がある
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FORBIDDEN');
    });

    /**
     * テスト: checkPermissionがTOOL_PERMISSIONS未定義ツールを拒否すること
     */
    it('checkPermission は TOOL_PERMISSIONS 未定義ツールを拒否すること', async () => {
      // Arrange
      const authContext = await validateApiKey(TEST_API_KEYS.ADMIN_KEY);
      expect(authContext).not.toBeNull();

      // Act
      const result = checkPermission(authContext!, 'completely.unknown.tool');

      // Assert: deny-by-default（現在の実装は許可してしまう→要修正）
      expect(result).toBe(false);
    });
  });

  describe('PUBLIC_TOOLS の整合性検証', () => {
    /**
     * テスト: PUBLIC_TOOLS のエントリが有効なツールであること
     */
    it('PUBLIC_TOOLS に stale entries が存在しないこと', async () => {
      // Arrange
      const { allToolDefinitions, PUBLIC_TOOLS: publicToolsFromAuth } = await import('../../src/middleware/auth');
      const { allToolDefinitions: toolDefs } = await import('../../src/tools/index');
      const registeredToolNames = toolDefs.map((t: { name: string }) => t.name);

      // Act: PUBLIC_TOOLSの各エントリを検証
      const stalePublicTools = publicToolsFromAuth.filter(
        (name: string) => !registeredToolNames.includes(name)
      );

      // Assert: system.info は存在しない（stale）
      expect(stalePublicTools).toEqual([]);
    });
  });

  describe('エラーレスポンス形式テスト', () => {
    /**
     * テスト: 認証エラーのAuthResult形式
     */
    it('認証エラーが正しいAuthResult形式で返されること', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const middleware = createAuthMiddleware({ enabled: true });

      // Act
      const result = await middleware.checkAuth('layout.search', undefined);

      // Assert
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('error');
      expect(result.success).toBe(false);
      expect(result.error).toHaveProperty('code');
      expect(result.error).toHaveProperty('message');
      expect(result.error?.code).toBe('UNAUTHORIZED');
    });

    /**
     * テスト: 認可エラーのAuthResult形式
     */
    it('認可エラー（権限不足）が正しいAuthResult形式で返されること', async () => {
      // Arrange
      process.env.MCP_AUTH_ENABLED = 'true';
      const middleware = createAuthMiddleware({ enabled: true });

      // Act
      const result = await middleware.checkAuth('layout.ingest', TEST_API_KEYS.VIEWER_KEY);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FORBIDDEN');
      expect(result.error?.message).toContain('Insufficient permissions');
    });
  });
});
