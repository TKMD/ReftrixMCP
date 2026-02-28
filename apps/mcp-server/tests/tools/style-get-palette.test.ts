// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * style.get_palette MCPツール テスト
 * TDD Red Phase: ブランドパレット取得MCPツールのハンドラーとツール定義
 *
 * 目的:
 * - MCPツール定義（name, description, inputSchema）の検証
 * - 入力スキーマのZodバリデーション検証
 * - ハンドラー関数の動作検証
 * - MCP Protocol形式のレスポンス検証
 * - エラーハンドリングの検証
 *
 * 参照: docs/plans/mcptools/01/03-api-specification.md Section 5
 *
 * @module tests/tools/style-get-palette.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// TDD Red: 以下のインポートは実装がまだ存在しないため失敗する
// =============================================================================

// MCPツールハンドラーとツール定義
import {
  styleGetPaletteHandler,
  styleGetPaletteToolDefinition,
  setPaletteServiceFactory,
  resetPaletteServiceFactory,
} from '../../src/tools/style-get-palette';

// 入力スキーマ
import {
  styleGetPaletteInputSchema,
  type StyleGetPaletteInput,
} from '../../src/tools/schemas/style-schemas';

// =============================================================================
// テストデータ
// =============================================================================

/**
 * テスト用の有効なパレット詳細レスポンス
 */
const mockPaletteDetailResponse = {
  palette: {
    id: '01939abc-def0-7000-8000-000000000001',
    brand_id: 'tech-startup',
    brand_name: 'TechStartup Inc.',
    description: 'モダンなテックスタートアップ向けパレット',
    mode: 'light' as const,
    tokens: {
      primary: {
        name: 'Primary',
        description: '主要ブランドカラー',
        oklch: { l: 0.62, c: 0.18, h: 264 },
        hex: '#3B82F6',
        usage: ['accent', 'cta', 'link'],
        contrast_with: [{ token: 'bg', min_ratio: 4.5 }],
      },
      bg: {
        name: 'Background',
        oklch: { l: 0.99, c: 0.01, h: 264 },
        hex: '#FAFAFA',
        usage: ['background'],
      },
    },
    gradients: [
      {
        id: 'hero-gradient',
        name: 'Hero Gradient',
        type: 'linear' as const,
        angle: 135,
        stops: [
          { offset: 0, token: 'primary' },
          { offset: 100, token: 'accent' },
        ],
      },
    ],
    created_at: '2025-11-01T00:00:00.000Z',
    updated_at: '2025-12-01T00:00:00.000Z',
  },
};

/**
 * テスト用のパレット一覧レスポンス
 */
const mockPaletteListResponse = {
  palettes: [
    {
      id: '01939abc-def0-7000-8000-000000000001',
      brand_id: 'tech-startup',
      brand_name: 'TechStartup Inc.',
      mode: 'light' as const,
      token_count: 6,
    },
    {
      id: '01939abc-def0-7000-8000-000000000002',
      brand_id: 'tech-startup',
      brand_name: 'TechStartup Inc.',
      mode: 'dark' as const,
      token_count: 2,
    },
    {
      id: '01939abc-def0-7000-8000-000000000003',
      brand_id: 'design-agency',
      brand_name: 'Creative Design Agency',
      mode: 'both' as const,
      token_count: 5,
    },
  ],
};

// =============================================================================
// モック設定
// =============================================================================

// ファクトリー関数を使用してモックを注入（vi.mockの代わり）
// vi.mock は ESモジュールのホイスティング問題があるため、ファクトリーパターンを使用

// =============================================================================
// 入力スキーマテスト
// =============================================================================

describe('styleGetPaletteInputSchema', () => {
  describe('有効な入力', () => {
    it('パラメータなしの入力を受け付けること', () => {
      // パラメータなしはすべてデフォルト値
      const input = {};
      const result = styleGetPaletteInputSchema.parse(input);

      expect(result.mode).toBe('both');
      expect(result.include_gradients).toBe(true);
    });

    it('id のみの入力を受け付けること', () => {
      const input = { id: '01939abc-def0-7000-8000-000000000001' };
      const result = styleGetPaletteInputSchema.parse(input);

      expect(result.id).toBe(input.id);
    });

    it('brand_name のみの入力を受け付けること', () => {
      const input = { brand_name: 'TechStartup' };
      const result = styleGetPaletteInputSchema.parse(input);

      expect(result.brand_name).toBe(input.brand_name);
    });

    it('mode 指定の入力を受け付けること', () => {
      const lightInput = { mode: 'light' as const };
      const darkInput = { mode: 'dark' as const };
      const bothInput = { mode: 'both' as const };

      expect(styleGetPaletteInputSchema.parse(lightInput).mode).toBe('light');
      expect(styleGetPaletteInputSchema.parse(darkInput).mode).toBe('dark');
      expect(styleGetPaletteInputSchema.parse(bothInput).mode).toBe('both');
    });

    it('include_gradients 指定の入力を受け付けること', () => {
      const trueInput = { include_gradients: true };
      const falseInput = { include_gradients: false };

      expect(styleGetPaletteInputSchema.parse(trueInput).include_gradients).toBe(true);
      expect(styleGetPaletteInputSchema.parse(falseInput).include_gradients).toBe(false);
    });

    it('全オプション指定の入力を受け付けること', () => {
      const input: StyleGetPaletteInput = {
        id: '01939abc-def0-7000-8000-000000000001',
        brand_name: 'TechStartup',
        mode: 'light',
        include_gradients: false,
      };

      const result = styleGetPaletteInputSchema.parse(input);

      expect(result.id).toBe(input.id);
      expect(result.brand_name).toBe(input.brand_name);
      expect(result.mode).toBe('light');
      expect(result.include_gradients).toBe(false);
    });
  });

  describe('無効な入力', () => {
    it('無効なUUID形式の id でエラーになること', () => {
      const invalidIds = [
        'invalid-uuid',
        '12345',
        '',
        'not-a-valid-uuid-format',
        '01939abc-def0-7000-8000-00000000000', // 短すぎ
        '01939abc-def0-7000-8000-0000000000001', // 長すぎ
      ];

      invalidIds.forEach((id) => {
        expect(() => styleGetPaletteInputSchema.parse({ id })).toThrow();
      });
    });

    it('無効な mode 値でエラーになること', () => {
      const invalidModes = ['LIGHT', 'DARK', 'auto', 'system', '', 123];

      invalidModes.forEach((mode) => {
        expect(() => styleGetPaletteInputSchema.parse({ mode })).toThrow();
      });
    });

    it('include_gradients が文字列の場合エラーになること', () => {
      const input = { include_gradients: 'true' };

      expect(() => styleGetPaletteInputSchema.parse(input)).toThrow();
    });

    it('id が null の場合エラーになること', () => {
      const input = { id: null };

      expect(() => styleGetPaletteInputSchema.parse(input)).toThrow();
    });

    it('不明なプロパティがある場合は無視されること（strict mode off）', () => {
      const input = {
        id: '01939abc-def0-7000-8000-000000000001',
        unknownField: 'should be ignored',
      };

      // strictモードがoffなら、不明なプロパティは無視される
      const result = styleGetPaletteInputSchema.parse(input);
      expect(result.id).toBe(input.id);
      expect(result).not.toHaveProperty('unknownField');
    });
  });

  describe('デフォルト値', () => {
    it('mode のデフォルト値が both であること', () => {
      const result = styleGetPaletteInputSchema.parse({});
      expect(result.mode).toBe('both');
    });

    it('include_gradients のデフォルト値が true であること', () => {
      const result = styleGetPaletteInputSchema.parse({});
      expect(result.include_gradients).toBe(true);
    });
  });
});

// =============================================================================
// ツール定義テスト
// =============================================================================

describe('styleGetPaletteToolDefinition', () => {
  it('正しいツール名を持つこと', () => {
    expect(styleGetPaletteToolDefinition.name).toBe('style.get_palette');
  });

  it('description が設定されていること', () => {
    expect(styleGetPaletteToolDefinition.description).toBeDefined();
    expect(typeof styleGetPaletteToolDefinition.description).toBe('string');
    expect(styleGetPaletteToolDefinition.description.length).toBeGreaterThan(0);
  });

  it('description にツールの用途が含まれること', () => {
    const description = styleGetPaletteToolDefinition.description;

    // 日本語または英語でパレット関連の説明が含まれる
    expect(
      description.includes('パレット') ||
      description.includes('palette') ||
      description.includes('Palette')
    ).toBe(true);
  });

  it('inputSchema が object 型であること', () => {
    expect(styleGetPaletteToolDefinition.inputSchema.type).toBe('object');
  });

  it('inputSchema に必要なプロパティが定義されていること', () => {
    const { properties } = styleGetPaletteToolDefinition.inputSchema;

    expect(properties).toHaveProperty('id');
    expect(properties).toHaveProperty('brand_name');
    expect(properties).toHaveProperty('mode');
    expect(properties).toHaveProperty('include_gradients');
  });

  it('id プロパティが uuid format であること', () => {
    const idProperty = styleGetPaletteToolDefinition.inputSchema.properties.id;

    expect(idProperty.type).toBe('string');
    expect(idProperty.format).toBe('uuid');
  });

  it('mode プロパティが enum であること', () => {
    const modeProperty = styleGetPaletteToolDefinition.inputSchema.properties.mode;

    expect(modeProperty.type).toBe('string');
    expect(modeProperty.enum).toContain('light');
    expect(modeProperty.enum).toContain('dark');
    expect(modeProperty.enum).toContain('both');
    expect(modeProperty.default).toBe('both');
  });

  it('include_gradients プロパティが boolean 型であること', () => {
    const includeGradientsProperty =
      styleGetPaletteToolDefinition.inputSchema.properties.include_gradients;

    expect(includeGradientsProperty.type).toBe('boolean');
    expect(includeGradientsProperty.default).toBe(true);
  });

  it('必須プロパティがないこと（すべてオプション）', () => {
    // すべてのパラメータはオプション
    expect(styleGetPaletteToolDefinition.inputSchema.required).toBeUndefined();
  });

  it('annotations が正しく設定されていること', () => {
    const { annotations } = styleGetPaletteToolDefinition;

    // 破壊的操作ではない
    expect(annotations?.destructive).toBe(false);
    // 冪等性あり
    expect(annotations?.idempotent).toBe(true);
  });
});

// =============================================================================
// ハンドラーテスト
// =============================================================================

describe('styleGetPaletteHandler', () => {
  let mockPaletteServiceInstance: {
    getPalette: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // PaletteServiceのモックインスタンスを設定
    mockPaletteServiceInstance = {
      getPalette: vi.fn(),
    };

    // ファクトリー関数を使ってモックを注入
    setPaletteServiceFactory(() => mockPaletteServiceInstance);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // ファクトリーをリセット
    resetPaletteServiceFactory();
  });

  // ===========================================================================
  // 正常系: パレット一覧取得
  // ===========================================================================

  describe('正常系: パレット一覧取得', () => {
    it('パラメータなしでパレット一覧が取得できること', async () => {
      mockPaletteServiceInstance.getPalette.mockResolvedValue(mockPaletteListResponse);

      const result = await styleGetPaletteHandler({});

      // ハンドラーはraw response形式を返す（MCP形式への変換はrouter.tsで行われる）
      expect(result.success).toBe(true);
      if (result.success) {
        const responseData = result.data as typeof mockPaletteListResponse;
        expect(responseData.palettes).toBeDefined();
        expect(Array.isArray(responseData.palettes)).toBe(true);
      }
    });

    it('mode=light でフィルタリングできること', async () => {
      const lightOnlyResponse = {
        palettes: mockPaletteListResponse.palettes.filter(
          (p) => p.mode === 'light' || p.mode === 'both'
        ),
      };
      mockPaletteServiceInstance.getPalette.mockResolvedValue(lightOnlyResponse);

      const result = await styleGetPaletteHandler({ mode: 'light' });

      expect(result.success).toBe(true);
      if (result.success) {
        const responseData = result.data as typeof lightOnlyResponse;
        expect(responseData.palettes.every(
          (p: { mode: string }) => p.mode === 'light' || p.mode === 'both'
        )).toBe(true);
      }
    });

    it('mode=dark でフィルタリングできること', async () => {
      const darkOnlyResponse = {
        palettes: mockPaletteListResponse.palettes.filter(
          (p) => p.mode === 'dark' || p.mode === 'both'
        ),
      };
      mockPaletteServiceInstance.getPalette.mockResolvedValue(darkOnlyResponse);

      const result = await styleGetPaletteHandler({ mode: 'dark' });

      expect(result.success).toBe(true);
      if (result.success) {
        const responseData = result.data as typeof darkOnlyResponse;
        expect(responseData.palettes.every(
          (p: { mode: string }) => p.mode === 'dark' || p.mode === 'both'
        )).toBe(true);
      }
    });
  });

  // ===========================================================================
  // 正常系: ID指定でのパレット詳細取得
  // ===========================================================================

  describe('正常系: ID指定でのパレット詳細取得', () => {
    it('有効なIDでパレット詳細が取得できること', async () => {
      mockPaletteServiceInstance.getPalette.mockResolvedValue(mockPaletteDetailResponse);

      const result = await styleGetPaletteHandler({
        id: '01939abc-def0-7000-8000-000000000001',
      });

      // ハンドラーはraw response形式を返す
      expect(result.success).toBe(true);
      if (result.success) {
        const responseData = result.data as typeof mockPaletteDetailResponse;
        expect(responseData.palette).toBeDefined();
        expect(responseData.palette.id).toBe('01939abc-def0-7000-8000-000000000001');
      }
    });

    it('パレット詳細に tokens が含まれること', async () => {
      mockPaletteServiceInstance.getPalette.mockResolvedValue(mockPaletteDetailResponse);

      const result = await styleGetPaletteHandler({
        id: '01939abc-def0-7000-8000-000000000001',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const responseData = result.data as typeof mockPaletteDetailResponse;
        expect(responseData.palette.tokens).toBeDefined();
        expect(responseData.palette.tokens.primary).toBeDefined();
      }
    });

    it('include_gradients=true でグラデーションが含まれること', async () => {
      mockPaletteServiceInstance.getPalette.mockResolvedValue(mockPaletteDetailResponse);

      const result = await styleGetPaletteHandler({
        id: '01939abc-def0-7000-8000-000000000001',
        include_gradients: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const responseData = result.data as typeof mockPaletteDetailResponse;
        expect(responseData.palette.gradients).toBeDefined();
        expect(Array.isArray(responseData.palette.gradients)).toBe(true);
      }
    });

    it('include_gradients=false でグラデーションが含まれないこと', async () => {
      const responseWithoutGradients = {
        palette: {
          ...mockPaletteDetailResponse.palette,
          gradients: undefined,
        },
      };
      mockPaletteServiceInstance.getPalette.mockResolvedValue(responseWithoutGradients);

      const result = await styleGetPaletteHandler({
        id: '01939abc-def0-7000-8000-000000000001',
        include_gradients: false,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const responseData = result.data as typeof responseWithoutGradients;
        expect(responseData.palette.gradients).toBeUndefined();
      }
    });
  });

  // ===========================================================================
  // 正常系: ブランド名検索
  // ===========================================================================

  describe('正常系: ブランド名検索', () => {
    it('brand_name で検索できること', async () => {
      const techStartupPalettes = {
        palettes: mockPaletteListResponse.palettes.filter((p) =>
          p.brand_name.includes('TechStartup')
        ),
      };
      mockPaletteServiceInstance.getPalette.mockResolvedValue(techStartupPalettes);

      const result = await styleGetPaletteHandler({
        brand_name: 'TechStartup',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const responseData = result.data as typeof techStartupPalettes;
        expect(responseData.palettes).toBeDefined();
        expect(responseData.palettes.every(
          (p: { brand_name: string }) => p.brand_name.includes('TechStartup')
        )).toBe(true);
      }
    });

    it('該当なしの場合、空の配列を返すこと', async () => {
      mockPaletteServiceInstance.getPalette.mockResolvedValue({ palettes: [] });

      const result = await styleGetPaletteHandler({
        brand_name: 'NonExistentBrand',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const responseData = result.data as { palettes: unknown[] };
        expect(responseData.palettes).toEqual([]);
      }
    });
  });

  // ===========================================================================
  // 異常系: 存在しないID
  // ===========================================================================

  describe('異常系: 存在しないID', () => {
    it('存在しないIDでエラーレスポンスを返すこと', async () => {
      mockPaletteServiceInstance.getPalette.mockRejectedValue(
        new Error('CREATIVE_PALETTE_NOT_FOUND')
      );

      const result = await styleGetPaletteHandler({
        id: '01939abc-def0-7000-8000-999999999999',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('CREATIVE_PALETTE_NOT_FOUND');
      }
    });

    it('エラーレスポンスにSuggestionが含まれること', async () => {
      mockPaletteServiceInstance.getPalette.mockRejectedValue(
        new Error('CREATIVE_PALETTE_NOT_FOUND')
      );

      const result = await styleGetPaletteHandler({
        id: '01939abc-def0-7000-8000-999999999999',
      });

      // API仕様に従いSuggestionが含まれる
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.suggestion).toBeDefined();
      }
    });
  });

  // ===========================================================================
  // 異常系: 無効なUUID形式
  // ===========================================================================

  describe('異常系: 無効なUUID形式', () => {
    it('無効なUUID形式でバリデーションエラーを返すこと', async () => {
      const result = await styleGetPaletteHandler({
        id: 'invalid-uuid-format',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('CREATIVE_INVALID_PALETTE_ID');
      }
    });

    it('空文字列のIDでバリデーションエラーを返すこと', async () => {
      const result = await styleGetPaletteHandler({
        id: '',
      });

      expect(result.success).toBe(false);
    });
  });

  // ===========================================================================
  // MCP Protocol形式テスト
  // ===========================================================================

  describe('レスポンス形式', () => {
    // NOTE: ハンドラーはraw response形式を返す（MCP形式への変換はrouter.tsで行われる）
    it('成功レスポンスが正しい形式であること', async () => {
      mockPaletteServiceInstance.getPalette.mockResolvedValue(mockPaletteListResponse);

      const result = await styleGetPaletteHandler({});

      // raw response形式の検証
      expect(result).toHaveProperty('success');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result).toHaveProperty('data');
      }
    });

    it('エラーレスポンスが正しい形式であること', async () => {
      mockPaletteServiceInstance.getPalette.mockRejectedValue(
        new Error('CREATIVE_PALETTE_NOT_FOUND')
      );

      const result = await styleGetPaletteHandler({
        id: '01939abc-def0-7000-8000-999999999999',
      });

      // エラー時のraw response形式
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result).toHaveProperty('error');
        expect(result.error).toHaveProperty('code');
        expect(result.error).toHaveProperty('message');
      }
    });

    it('レスポンスがJSONシリアライズ可能であること', async () => {
      mockPaletteServiceInstance.getPalette.mockResolvedValue(mockPaletteListResponse);

      const result = await styleGetPaletteHandler({});

      // JSON.stringifyが成功すること
      expect(() => JSON.stringify(result)).not.toThrow();
    });
  });

  // ===========================================================================
  // サービス呼び出しテスト
  // ===========================================================================

  describe('サービス呼び出し', () => {
    it('PaletteService.getPalette が正しい引数で呼ばれること', async () => {
      mockPaletteServiceInstance.getPalette.mockResolvedValue(mockPaletteListResponse);

      await styleGetPaletteHandler({
        mode: 'light',
        include_gradients: false,
      });

      expect(mockPaletteServiceInstance.getPalette).toHaveBeenCalledWith({
        mode: 'light',
        include_gradients: false,
        auto_generate_gradients: false,
        gradient_options: undefined,
      });
    });

    it('ID指定時に正しい引数でサービスが呼ばれること', async () => {
      mockPaletteServiceInstance.getPalette.mockResolvedValue(mockPaletteDetailResponse);

      await styleGetPaletteHandler({
        id: '01939abc-def0-7000-8000-000000000001',
        mode: 'dark',
        include_gradients: true,
      });

      expect(mockPaletteServiceInstance.getPalette).toHaveBeenCalledWith({
        id: '01939abc-def0-7000-8000-000000000001',
        mode: 'dark',
        include_gradients: true,
        auto_generate_gradients: false,
        gradient_options: undefined,
      });
    });
  });

  // ===========================================================================
  // ロギングテスト（開発環境）
  // ===========================================================================

  describe('開発環境ログ出力', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // モジュールキャッシュをクリアして環境変数の変更を反映させる
      vi.resetModules();
      // logger.info は内部で console.error を使用する（MCP stdioプロトコルの都合上）
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      consoleErrorSpy.mockRestore();
    });

    it('開発環境でログが出力されること', async () => {
      // Arrange: 環境変数を設定してからモジュールを動的インポート
      vi.stubEnv('NODE_ENV', 'development');

      const { styleGetPaletteHandler: handler, setPaletteServiceFactory: setFactory } =
        await import('../../src/tools/style-get-palette.js');

      // モックサービスファクトリを再設定
      setFactory(() => mockPaletteServiceInstance);
      mockPaletteServiceInstance.getPalette.mockResolvedValue(mockPaletteListResponse);

      // Act
      await handler({});

      // Assert: 開発環境ではログが出力される（logger.info -> console.error）
      // [INFO]を含むログが出力されることを確認
      const infoCalls = consoleErrorSpy.mock.calls.filter((call) =>
        String(call[0]).includes('[INFO]')
      );
      expect(infoCalls.length).toBeGreaterThan(0);
    });

    it('本番環境でログが出力されないこと', async () => {
      // Arrange: 環境変数を設定してからモジュールを動的インポート
      vi.stubEnv('NODE_ENV', 'production');

      const { styleGetPaletteHandler: handler, setPaletteServiceFactory: setFactory } =
        await import('../../src/tools/style-get-palette.js');

      // モックサービスファクトリを再設定
      setFactory(() => mockPaletteServiceInstance);
      mockPaletteServiceInstance.getPalette.mockResolvedValue(mockPaletteListResponse);

      // Act
      await handler({});

      // Assert: 本番環境ではINFOログが出力されない
      const infoCalls = consoleErrorSpy.mock.calls.filter((call) =>
        String(call[0]).includes('[INFO]')
      );
      expect(infoCalls.length).toBe(0);
    });
  });
});

// =============================================================================
// 統合テスト
// =============================================================================

describe('style.get_palette 統合テスト', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ツール定義とハンドラーが一致すること', () => {
    // ツール定義のプロパティ名がハンドラーで使用される入力と一致
    const { properties } = styleGetPaletteToolDefinition.inputSchema;
    const propNames = Object.keys(properties);

    // オプションプロパティ
    expect(propNames).toContain('id');
    expect(propNames).toContain('brand_name');
    expect(propNames).toContain('mode');
    expect(propNames).toContain('include_gradients');
    expect(propNames).toContain('auto_generate_gradients');
    expect(propNames).toContain('gradient_options');
  });

  it('入力スキーマとツール定義のスキーマが一致すること', () => {
    // ツール定義のプロパティとZodスキーマのプロパティが一致
    const toolProperties = Object.keys(styleGetPaletteToolDefinition.inputSchema.properties);

    // Zodスキーマで定義されているプロパティ（新機能を含む）
    const schemaShape = ['id', 'brand_name', 'mode', 'include_gradients', 'auto_generate_gradients', 'gradient_options'];

    expect(toolProperties.sort()).toEqual(schemaShape.sort());
  });
});

// =============================================================================
// エラーコードテスト
// =============================================================================

describe('エラーコード', () => {
  let mockPaletteServiceInstance: {
    getPalette: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockPaletteServiceInstance = {
      getPalette: vi.fn(),
    };

    // ファクトリー関数を使ってモックを注入
    setPaletteServiceFactory(() => mockPaletteServiceInstance);
  });

  afterEach(() => {
    resetPaletteServiceFactory();
  });

  it('CREATIVE_PALETTE_NOT_FOUND エラーが正しく返されること', async () => {
    mockPaletteServiceInstance.getPalette.mockRejectedValue(
      new Error('CREATIVE_PALETTE_NOT_FOUND')
    );

    const result = await styleGetPaletteHandler({
      id: '01939abc-def0-7000-8000-999999999999',
    });

    // ハンドラーは { success: false, error: { code, message } } 形式で返す
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('CREATIVE_PALETTE_NOT_FOUND');
    }
  });

  it('CREATIVE_INVALID_PALETTE_ID エラーが正しく返されること', async () => {
    const result = await styleGetPaletteHandler({
      id: 'not-a-uuid',
    });

    // ハンドラーは { success: false, error: { code, message } } 形式で返す
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('CREATIVE_INVALID_PALETTE_ID');
    }
  });

  it('予期しないエラーが適切にハンドリングされること', async () => {
    mockPaletteServiceInstance.getPalette.mockRejectedValue(
      new Error('Unexpected database error')
    );

    const result = await styleGetPaletteHandler({});

    // ハンドラーは { success: false, error: { code, message } } 形式で返す
    expect(result.success).toBe(false);
    if (!result.success) {
      // 内部エラーの詳細は露出しない（messageにdatabaseが含まれないこと）
      expect(result.error.message).not.toContain('database');
    }
  });
});

// =============================================================================
// 型定義テスト
// =============================================================================

describe('型定義', () => {
  it('StyleGetPaletteInput 型が正しく機能すること', () => {
    // コンパイル時の型チェック用
    const validInput: StyleGetPaletteInput = {
      id: '01939abc-def0-7000-8000-000000000001',
      brand_name: 'Test',
      mode: 'light',
      include_gradients: true,
    };

    expect(validInput).toBeDefined();
  });

  it('最小限の StyleGetPaletteInput が有効であること', () => {
    // すべてのフィールドがオプション
    const minimalInput: StyleGetPaletteInput = {};

    expect(minimalInput).toBeDefined();
  });
});

// =============================================================================
// グラデーション自動生成テスト（REFTRIX-STYLE-01）
// =============================================================================

describe('グラデーション自動生成（auto_generate_gradients）', () => {
  let mockPaletteServiceInstance: {
    getPalette: ReturnType<typeof vi.fn>;
  };

  /**
   * 自動生成されたグラデーションを含むモックレスポンス
   */
  const mockPaletteWithGeneratedGradients = {
    palette: {
      id: '01939abc-def0-7000-8000-000000000001',
      brand_id: 'tech-startup',
      brand_name: 'TechStartup Inc.',
      mode: 'light' as const,
      tokens: {
        primary: {
          name: 'Primary',
          oklch: { l: 0.62, c: 0.18, h: 264 },
          hex: '#3B82F6',
        },
        secondary: {
          name: 'Secondary',
          oklch: { l: 0.58, c: 0.20, h: 279 },
          hex: '#6366F1',
        },
        accent: {
          name: 'Accent',
          oklch: { l: 0.59, c: 0.23, h: 293 },
          hex: '#8B5CF6',
        },
      },
      gradients: [
        {
          id: 'auto-primary-secondary',
          name: 'Primary to Secondary',
          type: 'linear' as const,
          angle: 135,
          stops: [
            { offset: 0, token: 'primary' },
            { offset: 100, token: 'secondary' },
          ],
          auto_generated: true,
        },
      ],
      created_at: '2025-11-01T00:00:00.000Z',
      updated_at: '2025-12-01T00:00:00.000Z',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockPaletteServiceInstance = {
      getPalette: vi.fn(),
    };

    setPaletteServiceFactory(() => mockPaletteServiceInstance);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPaletteServiceFactory();
  });

  describe('入力スキーマ', () => {
    it('auto_generate_gradients のデフォルト値がfalseであること', () => {
      const result = styleGetPaletteInputSchema.parse({});
      expect(result.auto_generate_gradients).toBe(false);
    });

    it('auto_generate_gradients=true が受け付けられること', () => {
      const result = styleGetPaletteInputSchema.parse({
        auto_generate_gradients: true,
      });
      expect(result.auto_generate_gradients).toBe(true);
    });

    it('gradient_options が受け付けられること', () => {
      const result = styleGetPaletteInputSchema.parse({
        auto_generate_gradients: true,
        gradient_options: {
          type: 'linear',
          angle: 90,
        },
      });
      expect(result.gradient_options).toBeDefined();
      expect(result.gradient_options?.type).toBe('linear');
      expect(result.gradient_options?.angle).toBe(90);
    });

    it('gradient_options.token_pairs が受け付けられること', () => {
      const result = styleGetPaletteInputSchema.parse({
        auto_generate_gradients: true,
        gradient_options: {
          token_pairs: [['primary', 'secondary'], ['accent', 'neutral']],
        },
      });
      expect(result.gradient_options?.token_pairs).toHaveLength(2);
      expect(result.gradient_options?.token_pairs?.[0]).toEqual(['primary', 'secondary']);
    });

    it('gradient_options.type=radial が受け付けられること', () => {
      const result = styleGetPaletteInputSchema.parse({
        auto_generate_gradients: true,
        gradient_options: {
          type: 'radial',
        },
      });
      expect(result.gradient_options?.type).toBe('radial');
    });

    it('gradient_options.angle の範囲外の値でエラーになること', () => {
      expect(() => styleGetPaletteInputSchema.parse({
        gradient_options: { angle: -1 },
      })).toThrow();

      expect(() => styleGetPaletteInputSchema.parse({
        gradient_options: { angle: 361 },
      })).toThrow();
    });

    it('gradient_options.include_complementary が受け付けられること', () => {
      const result = styleGetPaletteInputSchema.parse({
        auto_generate_gradients: true,
        gradient_options: {
          include_complementary: true,
        },
      });
      expect(result.gradient_options?.include_complementary).toBe(true);
    });

    it('gradient_options.include_analogous が受け付けられること', () => {
      const result = styleGetPaletteInputSchema.parse({
        auto_generate_gradients: true,
        gradient_options: {
          include_analogous: true,
        },
      });
      expect(result.gradient_options?.include_analogous).toBe(true);
    });
  });

  describe('ハンドラー動作', () => {
    it('auto_generate_gradients=false の場合、既存グラデーションのみ返すこと', async () => {
      mockPaletteServiceInstance.getPalette.mockResolvedValue(mockPaletteDetailResponse);

      const result = await styleGetPaletteHandler({
        id: '01939abc-def0-7000-8000-000000000001',
        auto_generate_gradients: false,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // auto_generated フラグがないグラデーションのみ
        const responseData = result.data as typeof mockPaletteDetailResponse;
        expect(responseData.palette.gradients?.every(
          (g: { auto_generated?: boolean }) => g.auto_generated !== true
        )).toBe(true);
      }
    });

    it('auto_generate_gradients=true の場合、自動生成グラデーションが追加されること', async () => {
      mockPaletteServiceInstance.getPalette.mockResolvedValue(mockPaletteWithGeneratedGradients);

      const result = await styleGetPaletteHandler({
        id: '01939abc-def0-7000-8000-000000000001',
        auto_generate_gradients: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const responseData = result.data as typeof mockPaletteWithGeneratedGradients;
        expect(responseData.palette.gradients).toBeDefined();
        expect(responseData.palette.gradients?.some(
          (g: { auto_generated?: boolean }) => g.auto_generated === true
        )).toBe(true);
      }
    });

    it('gradient_options.token_pairs が正しくサービスに渡されること', async () => {
      mockPaletteServiceInstance.getPalette.mockResolvedValue(mockPaletteWithGeneratedGradients);

      await styleGetPaletteHandler({
        id: '01939abc-def0-7000-8000-000000000001',
        auto_generate_gradients: true,
        gradient_options: {
          token_pairs: [['primary', 'accent']],
        },
      });

      expect(mockPaletteServiceInstance.getPalette).toHaveBeenCalledWith(
        expect.objectContaining({
          auto_generate_gradients: true,
          gradient_options: expect.objectContaining({
            token_pairs: [['primary', 'accent']],
          }),
        })
      );
    });

    it('gradient_options.type=radial でラジアルグラデーションが生成されること', async () => {
      const radialGradientResponse = {
        palette: {
          ...mockPaletteWithGeneratedGradients.palette,
          gradients: [
            {
              id: 'auto-primary-secondary-radial',
              name: 'Primary to Secondary (Radial)',
              type: 'radial' as const,
              centerX: 0.5,
              centerY: 0.5,
              stops: [
                { offset: 0, token: 'primary' },
                { offset: 100, token: 'secondary' },
              ],
              auto_generated: true,
            },
          ],
        },
      };
      mockPaletteServiceInstance.getPalette.mockResolvedValue(radialGradientResponse);

      const result = await styleGetPaletteHandler({
        id: '01939abc-def0-7000-8000-000000000001',
        auto_generate_gradients: true,
        gradient_options: {
          type: 'radial',
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const responseData = result.data as typeof radialGradientResponse;
        expect(responseData.palette.gradients?.[0].type).toBe('radial');
        expect(responseData.palette.gradients?.[0].centerX).toBeDefined();
        expect(responseData.palette.gradients?.[0].centerY).toBeDefined();
      }
    });
  });

  describe('ツール定義', () => {
    it('inputSchema に auto_generate_gradients が定義されていること', () => {
      expect(styleGetPaletteToolDefinition.inputSchema.properties).toHaveProperty('auto_generate_gradients');
    });

    it('auto_generate_gradients のデフォルト値が false であること', () => {
      const prop = styleGetPaletteToolDefinition.inputSchema.properties.auto_generate_gradients;
      expect(prop.default).toBe(false);
    });

    it('inputSchema に gradient_options が定義されていること', () => {
      expect(styleGetPaletteToolDefinition.inputSchema.properties).toHaveProperty('gradient_options');
    });

    it('gradient_options の type が object であること', () => {
      const prop = styleGetPaletteToolDefinition.inputSchema.properties.gradient_options;
      expect(prop.type).toBe('object');
    });
  });
});
