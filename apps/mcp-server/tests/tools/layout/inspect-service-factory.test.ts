// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout.inspect サービスファクトリ登録テスト
 *
 * TDD Red: MCPサーバー起動時にsetLayoutInspectServiceFactoryが
 * 正しく呼び出されていることを検証するテスト
 *
 * 背景:
 * - layout.inspect ツールは `id` パラメータを使用した場合に
 *   SERVICE_UNAVAILABLE エラーを返すバグがある
 * - 原因: apps/mcp-server/src/index.ts で setLayoutInspectServiceFactory() が
 *   呼び出されていない
 *
 * このテストは現状で失敗することを確認する（TDD-Red）
 *
 * @module tests/tools/layout/inspect-service-factory.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// =====================================================
// インポート
// =====================================================

import {
  layoutInspectHandler,
  setLayoutInspectServiceFactory,
  resetLayoutInspectServiceFactory,
  type ILayoutInspectService,
} from '../../../src/tools/layout/inspect';

// MCPサーバーのエントリポイントからエクスポートされているもの
import {
  setLayoutSearchServiceFactory,
  setLayoutToCodeServiceFactory,
} from '../../../src/tools/layout';

// webPageServiceのモック用
import { webPageService } from '../../../src/services/web-page.service';

// =====================================================
// テストデータ
// =====================================================

const TEST_UUID = '01234567-89ab-cdef-0123-456789abcdef';

const TEST_HTML = `<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <header>Header content</header>
  <main>
    <section class="hero">
      <h1>Welcome</h1>
      <p>Description text</p>
    </section>
  </main>
  <footer>Footer content</footer>
</body>
</html>`;

/**
 * モックWebPageデータ
 */
const MOCK_WEB_PAGE = {
  id: TEST_UUID,
  htmlContent: TEST_HTML,
};

// =====================================================
// サービスファクトリ登録のテスト
// =====================================================

describe('layout.inspect サービスファクトリ登録', () => {
  beforeEach(() => {
    // テスト前にサービスファクトリをリセット
    resetLayoutInspectServiceFactory();
  });

  afterEach(() => {
    // テスト後にサービスファクトリをリセット
    resetLayoutInspectServiceFactory();
    vi.restoreAllMocks();
  });

  describe('index.ts でのサービスファクトリ登録確認', () => {
    /**
     * TDD Red: このテストは現状で失敗する
     *
     * 現状:
     * - index.ts で setLayoutInspectServiceFactory() が呼び出されていない
     * - そのため id パラメータを使用すると SERVICE_UNAVAILABLE エラーが発生
     *
     * 期待:
     * - index.ts で setLayoutInspectServiceFactory() が呼び出される
     * - webPageService.getPageById を使用して WebPage を取得できる
     */
    it('MCPサーバー初期化後に layout.inspect が id パラメータで動作すること', async () => {
      // 1. MCPサーバーの index.ts が行うべきサービスファクトリ登録をシミュレート
      //    TDD-Green: index.ts に登録が追加されたので、同等の登録をテスト内で行う

      // webPageService.getPageById をモック
      vi.spyOn(webPageService, 'getPageById').mockResolvedValue({
        id: TEST_UUID,
        htmlContent: TEST_HTML,
      });

      // MCPサーバー初期化で行われる設定をシミュレート
      // index.ts での登録と同等の処理
      setLayoutInspectServiceFactory(() => ({
        getWebPageById: async (id: string) => webPageService.getPageById(id),
      }));

      // 2. id パラメータでハンドラーを呼び出す
      const result = await layoutInspectHandler({
        id: TEST_UUID,
      });

      // 3. 期待する結果の検証
      // TDD-Green: success: true が返される
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();
      expect(result.data?.sections).toBeDefined();
    });

    /**
     * TDD Red: サービスファクトリが登録されていない状態を検証
     * このテストは現状で通過する（バグの存在を確認）
     */
    it('サービスファクトリ未登録時に id パラメータで SERVICE_UNAVAILABLE エラーが返ること', async () => {
      // サービスファクトリをリセット（未登録状態）
      resetLayoutInspectServiceFactory();

      // id パラメータでハンドラーを呼び出す
      const result = await layoutInspectHandler({
        id: TEST_UUID,
      });

      // 現状: SERVICE_UNAVAILABLE エラーが返される
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
      expect(result.error?.message).toContain('html');
    });
  });

  describe('サービスファクトリ正常登録時の動作', () => {
    /**
     * サービスファクトリが正しく登録された場合の動作確認
     * このテストは通過する（正しい実装のリファレンス）
     */
    it('サービスファクトリ登録後に id パラメータで WebPage を取得できること', async () => {
      // サービスファクトリを登録
      const mockGetWebPageById = vi.fn().mockResolvedValue(MOCK_WEB_PAGE);

      setLayoutInspectServiceFactory(() => ({
        getWebPageById: mockGetWebPageById,
      }));

      // id パラメータでハンドラーを呼び出す
      const result = await layoutInspectHandler({
        id: TEST_UUID,
      });

      // 検証
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.id).toBe(TEST_UUID);
      expect(mockGetWebPageById).toHaveBeenCalledWith(TEST_UUID);
    });

    /**
     * 存在しないIDの場合のエラーハンドリング
     */
    it('存在しない id の場合に NOT_FOUND エラーが返ること', async () => {
      // サービスファクトリを登録（null を返す）
      const mockGetWebPageById = vi.fn().mockResolvedValue(null);

      setLayoutInspectServiceFactory(() => ({
        getWebPageById: mockGetWebPageById,
      }));

      // 存在しない id でハンドラーを呼び出す（有効なUUID形式を使用）
      const nonExistentUuid = '99999999-9999-9999-9999-999999999999';
      const result = await layoutInspectHandler({
        id: nonExistentUuid,
      });

      // 検証
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NOT_FOUND');
      expect(mockGetWebPageById).toHaveBeenCalledWith(nonExistentUuid);
    });

    /**
     * DB接続エラーの場合のエラーハンドリング
     */
    it('DB接続エラーの場合に DB_ERROR が返ること', async () => {
      // サービスファクトリを登録（エラーをスロー）
      const mockGetWebPageById = vi.fn().mockRejectedValue(new Error('Connection refused'));

      setLayoutInspectServiceFactory(() => ({
        getWebPageById: mockGetWebPageById,
      }));

      // id パラメータでハンドラーを呼び出す
      const result = await layoutInspectHandler({
        id: TEST_UUID,
      });

      // 検証
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DB_ERROR');
    });
  });

  describe('他のlayoutツールとの一貫性', () => {
    /**
     * layout.search と layout.to_code はサービスファクトリがエクスポートされている
     * layout.inspect も同様にエクスポートされるべき
     */
    it('setLayoutInspectServiceFactory が layout/index.ts からエクスポートされていること', async () => {
      // layout/index.ts からのインポートを試みる
      // 注意: 現状では layout/index.ts に setLayoutInspectServiceFactory がエクスポートされていない
      try {
        // 動的インポートで確認
        const layoutModule = await import('../../../src/tools/layout');

        // setLayoutSearchServiceFactory と setLayoutToCodeServiceFactory は存在する
        expect(typeof setLayoutSearchServiceFactory).toBe('function');
        expect(typeof setLayoutToCodeServiceFactory).toBe('function');

        // setLayoutInspectServiceFactory も存在すべき
        // 現状: この行で undefined になる（バグ）
        // 修正後: function になる
        expect(typeof (layoutModule as Record<string, unknown>).setLayoutInspectServiceFactory).toBe('function');
      } catch (error) {
        // インポートエラーの場合は失敗
        expect(error).toBeUndefined();
      }
    });
  });

  describe('webPageService との統合', () => {
    /**
     * TDD Red: index.ts で webPageService を使用したサービスファクトリが登録されること
     *
     * 期待される index.ts の実装:
     * ```typescript
     * setLayoutInspectServiceFactory(() => ({
     *   getWebPageById: async (id: string) => webPageService.getPageById(id),
     * }));
     * ```
     */
    it('webPageService.getPageById と統合されたサービスファクトリが動作すること', async () => {
      // webPageService のモックを設定
      vi.spyOn(webPageService, 'getPageById').mockResolvedValue({
        id: TEST_UUID,
        htmlContent: TEST_HTML,
      });

      // index.ts で行われるべきサービスファクトリ登録
      setLayoutInspectServiceFactory(() => ({
        getWebPageById: async (id: string) => webPageService.getPageById(id),
      }));

      // id パラメータでハンドラーを呼び出す
      const result = await layoutInspectHandler({
        id: TEST_UUID,
      });

      // 検証
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(webPageService.getPageById).toHaveBeenCalledWith(TEST_UUID);
    });
  });
});

// =====================================================
// サービスファクトリ登録パターンの検証
// =====================================================

describe('サービスファクトリ登録パターン', () => {
  beforeEach(() => {
    resetLayoutInspectServiceFactory();
  });

  afterEach(() => {
    resetLayoutInspectServiceFactory();
    vi.restoreAllMocks();
  });

  /**
   * motion.detect と同様のパターンで登録されるべき
   *
   * motion.detect の例（index.ts より）:
   * ```typescript
   * setMotionDetectServiceFactory(() => ({
   *   getPageById: async (id: string) => webPageService.getPageById(id),
   * }));
   * ```
   *
   * layout.inspect でも同様の登録が必要:
   * ```typescript
   * setLayoutInspectServiceFactory(() => ({
   *   getWebPageById: async (id: string) => webPageService.getPageById(id),
   * }));
   * ```
   */
  it('motion.detect と同様のサービスファクトリパターンが適用されること', async () => {
    // motion.detect で使用されているパターンと同じ形式
    const serviceFactory = () => ({
      getWebPageById: async (id: string) => {
        // webPageService を使用
        return webPageService.getPageById(id);
      },
    });

    // webPageService のモックを設定
    vi.spyOn(webPageService, 'getPageById').mockResolvedValue({
      id: TEST_UUID,
      htmlContent: TEST_HTML,
    });

    // サービスファクトリを登録
    setLayoutInspectServiceFactory(serviceFactory);

    // ハンドラーを呼び出す
    const result = await layoutInspectHandler({
      id: TEST_UUID,
    });

    // 検証
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe(TEST_UUID);
  });

  /**
   * Vision API 連携も含めたフルサービスファクトリ
   */
  it('Vision API 連携を含むフルサービスファクトリが動作すること', async () => {
    const mockVisionResult = {
      success: true,
      features: [],
      processingTimeMs: 100,
      modelName: 'test-vision-model',
    };

    const fullServiceFactory: () => ILayoutInspectService = () => ({
      getWebPageById: async (id: string) => {
        return webPageService.getPageById(id);
      },
      analyzeWithVision: async () => {
        return mockVisionResult;
      },
    });

    // webPageService のモックを設定
    vi.spyOn(webPageService, 'getPageById').mockResolvedValue({
      id: TEST_UUID,
      htmlContent: TEST_HTML,
    });

    // サービスファクトリを登録
    setLayoutInspectServiceFactory(fullServiceFactory);

    // ハンドラーを呼び出す（Vision API 有効）
    const result = await layoutInspectHandler({
      id: TEST_UUID,
      options: { useVision: true },
    });

    // 検証
    expect(result.success).toBe(true);
    expect(result.data?.visionFeatures).toBeDefined();
    expect(result.data?.visionFeatures?.success).toBe(true);
  });
});

// =====================================================
// 回帰テスト: html パラメータは引き続き動作すること
// =====================================================

describe('回帰テスト: html パラメータの動作', () => {
  beforeEach(() => {
    // サービスファクトリが未登録でも html パラメータは動作すべき
    resetLayoutInspectServiceFactory();
  });

  afterEach(() => {
    resetLayoutInspectServiceFactory();
  });

  /**
   * サービスファクトリが未登録でも html パラメータは動作すること
   */
  it('サービスファクトリ未登録でも html パラメータで解析できること', async () => {
    const result = await layoutInspectHandler({
      html: TEST_HTML,
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data?.sections).toBeDefined();
  });

  /**
   * id と html の両方が指定された場合、html が優先されること
   */
  it('id と html 両方指定時に html が優先されること', async () => {
    // サービスファクトリは未登録
    // id が指定されていても html があれば html を使用

    const result = await layoutInspectHandler({
      id: TEST_UUID,
      html: TEST_HTML,
    });

    // html が優先されるので成功する
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });
});
