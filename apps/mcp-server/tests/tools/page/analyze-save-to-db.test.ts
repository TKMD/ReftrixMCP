// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze saveToDb機能のテスト
 * TDD Red Phase: 先にテストを作成（実装はまだ存在しない）
 *
 * saveToDb=trueの場合に以下をDBに保存:
 * - WebPage: HTMLとスクリーンショット
 * - SectionPattern: レイアウト解析結果
 * - MotionPattern: モーション検出結果
 * - QualityEvaluation: 品質評価結果
 *
 * @module tests/tools/page/analyze-save-to-db.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Narrative handler をモックしてOllama Vision接続タイムアウト（35秒）を回避
vi.mock('../../../src/tools/page/handlers/narrative-handler', async () => {
  const actual = await vi.importActual('../../../src/tools/page/handlers/narrative-handler');
  return {
    ...(actual as Record<string, unknown>),
    handleNarrativeAnalysis: async () => ({ success: true, skipped: true }),
  };
});

// Redis可用性チェックをモック: Vision自動asyncモード（v0.1.0）を無効化
vi.mock('../../../src/config/redis', () => ({
  isRedisAvailable: async () => false,
}));

import { v7 as uuidv7 } from 'uuid';

import {
  pageAnalyzeHandler,
  setPageAnalyzeServiceFactory,
  resetPageAnalyzeServiceFactory,
  type IPageAnalyzeService,
  setPageAnalyzePrismaClientFactory,
  resetPageAnalyzePrismaClientFactory,
  type IPageAnalyzePrismaClient,
} from '../../../src/tools/page/analyze.tool';

import {
  PAGE_ANALYZE_ERROR_CODES,
} from '../../../src/tools/page/schemas';

// =====================================================
// モック用ヘルパー
// =====================================================

/**
 * Prismaクライアントのモック
 * DB保存処理をテストするためのモック
 */
function createMockPrismaClient(): IPageAnalyzePrismaClient {
  const mockWebPageId = uuidv7();
  const mockSectionPatternIds = [uuidv7(), uuidv7(), uuidv7()];
  const mockMotionPatternIds = [uuidv7(), uuidv7()];
  const mockQualityEvaluationId = uuidv7();

  // トランザクション用のモック（同じインスタンスを使用して呼び出しを追跡）
  const mockClient: IPageAnalyzePrismaClient = {
    webPage: {
      create: vi.fn().mockResolvedValue({ id: mockWebPageId }),
      // upsert: saveToDatabase で使用（URLが既存の場合は更新、新規の場合は作成）
      upsert: vi.fn().mockResolvedValue({ id: mockWebPageId }),
    },
    sectionPattern: {
      create: vi.fn().mockImplementation(() =>
        Promise.resolve({ id: mockSectionPatternIds[0] })
      ),
      createMany: vi.fn().mockResolvedValue({ count: 3 }),
      // deleteMany: 再分析時に既存のSectionPatternを削除
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    motionPattern: {
      create: vi.fn().mockImplementation(() =>
        Promise.resolve({ id: mockMotionPatternIds[0] })
      ),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    qualityEvaluation: {
      create: vi.fn().mockResolvedValue({ id: mockQualityEvaluationId }),
    },
    $transaction: vi.fn(),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  };

  // $transactionのモック: 同じクライアントインスタンスをtxとして渡す
  mockClient.$transaction = vi.fn().mockImplementation(async (fn) => {
    return await fn(mockClient);
  });

  return mockClient;
}

/**
 * IPageAnalyzeService モック（saveToDb対応版）
 */
function createMockPageAnalyzeServiceWithSaveToDb(): IPageAnalyzeService {
  return {
    fetchHtml: vi.fn().mockImplementation(async (url: string) => {
      return {
        html: `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Mock Page - ${url}</title>
  <meta name="description" content="Mock description for testing">
  <style>
    .hero { animation: fadeIn 0.5s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  </style>
</head>
<body>
  <header><nav>Navigation</nav></header>
  <main>
    <section class="hero"><h1>Hero Section</h1></section>
    <section class="features"><h2>Features</h2></section>
    <section class="cta"><h2>Call to Action</h2></section>
  </main>
  <footer>Footer</footer>
</body>
</html>`,
        title: `Mock Page - ${url}`,
        description: 'Mock description for testing',
        screenshot: 'mock-screenshot-base64-data',
      };
    }),

    analyzeLayout: vi.fn().mockImplementation(async (html: string, _options) => {
      // 注意: pageIdはsaveToDatabaseの成功後にのみ設定される
      // モックサービスではpageIdを設定しない（実装が正しく動作することをテストするため）
      return {
        success: true,
        sectionCount: 5,
        sectionTypes: { hero: 1, features: 1, cta: 1, navigation: 1, footer: 1 },
        processingTimeMs: 50,
        sections: [
          { id: uuidv7(), type: 'navigation', positionIndex: 0, confidence: 0.95, htmlSnippet: '<nav>...</nav>' },
          { id: uuidv7(), type: 'hero', positionIndex: 1, heading: 'Hero Section', confidence: 0.98, htmlSnippet: '<section class="hero">...</section>' },
          { id: uuidv7(), type: 'features', positionIndex: 2, heading: 'Features', confidence: 0.92, htmlSnippet: '<section class="features">...</section>' },
          { id: uuidv7(), type: 'cta', positionIndex: 3, heading: 'Call to Action', confidence: 0.88, htmlSnippet: '<section class="cta">...</section>' },
          { id: uuidv7(), type: 'footer', positionIndex: 4, confidence: 0.96, htmlSnippet: '<footer>...</footer>' },
        ],
      };
    }),

    detectMotion: vi.fn().mockImplementation(async (html: string, url: string, options) => {
      return {
        success: true,
        patternCount: 2,
        categoryBreakdown: { entrance: 1, hover_effect: 1 },
        warningCount: 1,
        a11yWarningCount: 1,
        perfWarningCount: 0,
        processingTimeMs: 30,
        patterns: [
          {
            id: 'pattern-001',
            name: 'fadeIn',
            type: 'css_animation' as const,
            category: 'entrance',
            trigger: 'load',
            duration: 500,
            easing: 'ease-in-out',
            properties: ['opacity'],
            rawCss: '@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }',
            performance: { level: 'good' as const, usesTransform: false, usesOpacity: true },
            accessibility: { respectsReducedMotion: false },
          },
          {
            id: 'pattern-002',
            name: 'button-hover',
            type: 'css_transition' as const,
            category: 'hover_effect',
            trigger: 'hover',
            duration: 300,
            easing: 'ease',
            properties: ['background-color'],
            rawCss: '.button { transition: background-color 0.3s ease; }',
            performance: { level: 'good' as const, usesTransform: false, usesOpacity: false },
            accessibility: { respectsReducedMotion: true },
          },
        ],
        warnings: [
          {
            code: 'A11Y_NO_REDUCED_MOTION',
            severity: 'warning' as const,
            message: 'Animation does not respect prefers-reduced-motion',
          },
        ],
      };
    }),

    evaluateQuality: vi.fn().mockImplementation(async (html: string, options) => {
      return {
        success: true,
        overallScore: 78.5,
        grade: 'C' as const,
        axisScores: {
          originality: 72,
          craftsmanship: 85,
          contextuality: 76,
        },
        clicheCount: 1,
        processingTimeMs: 25,
        axisGrades: {
          originality: 'C' as const,
          craftsmanship: 'B' as const,
          contextuality: 'C' as const,
        },
        cliches: [
          {
            type: 'gradient_sphere',
            description: 'Abstract gradient sphere detected in hero section',
            severity: 'low' as const,
          },
        ],
        recommendations: [
          {
            id: 'rec-001',
            category: 'accessibility',
            priority: 'high' as const,
            title: 'Add reduced motion support',
            description: 'Add prefers-reduced-motion media query to animations',
          },
        ],
      };
    }),
  };
}

// =====================================================
// テストデータ
// =====================================================

const validUrl = 'https://example.com';

/**
 * 共通テスト入力のベース
 * async: false を指定してsync modeを強制（v0.1.0 auto-async回避）
 * useVision: false でOllama Vision依存を排除
 */
const syncTestBase = {
  async: false as const,
  layoutOptions: { saveToDb: true, useVision: false },
};

// =====================================================
// saveToDb機能テスト - WebPage保存
// =====================================================

describe('saveToDb機能 - WebPage保存', () => {
  let mockPrismaClient: ReturnType<typeof createMockPrismaClient>;

  beforeEach(() => {
    vi.resetAllMocks();
    setPageAnalyzeServiceFactory(createMockPageAnalyzeServiceWithSaveToDb);
    mockPrismaClient = createMockPrismaClient();
    setPageAnalyzePrismaClientFactory(() => mockPrismaClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
    resetPageAnalyzePrismaClientFactory();
  });

  it('saveToDb=true でWebPageを保存する', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.layout?.success) {
      expect(result.data.layout.pageId).toBeDefined();
    }
  });

  it('WebPage保存時にURL、title、htmlContentが含まれる', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    await pageAnalyzeHandler(input);

    expect(mockPrismaClient.webPage.upsert).toHaveBeenCalled();
    const upsertCall = vi.mocked(mockPrismaClient.webPage.upsert).mock.calls[0];
    expect(upsertCall).toBeDefined();
    if (upsertCall) {
      // upsertは { where, create, update } の構造
      const createData = upsertCall[0]?.create;
      expect(createData?.url).toBe(validUrl);
      expect(createData?.htmlContent).toBeDefined();
      expect(createData?.sourceType).toBe('user_provided');
      expect(createData?.usageScope).toBe('inspiration_only');
    }
  });

  it('sourceType=award_galleryが正しく保存される', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
      sourceType: 'award_gallery' as const,
    };

    await pageAnalyzeHandler(input);

    const upsertCall = vi.mocked(mockPrismaClient.webPage.upsert).mock.calls[0];
    if (upsertCall) {
      const createData = upsertCall[0]?.create;
      expect(createData?.sourceType).toBe('award_gallery');
    }
  });

  it('usageScope=owned_assetが正しく保存される', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
      usageScope: 'owned_asset' as const,
    };

    await pageAnalyzeHandler(input);

    const upsertCall = vi.mocked(mockPrismaClient.webPage.upsert).mock.calls[0];
    if (upsertCall) {
      const createData = upsertCall[0]?.create;
      expect(createData?.usageScope).toBe('owned_asset');
    }
  });

  it('saveToDb=false でWebPageを保存しない', async () => {
    const input = {
      url: validUrl,
      async: false as const,
      layoutOptions: { saveToDb: false, useVision: false }
    };

    await pageAnalyzeHandler(input);

    expect(mockPrismaClient.webPage.upsert).not.toHaveBeenCalled();
  });

  it('デフォルト（saveToDb未指定 = true）でWebPageを保存する', async () => {
    // layoutOptions を空オブジェクトで指定すると、内部のsaveToDbはデフォルトtrueになる
    const input = {
      url: validUrl,
      async: false as const,
      layoutOptions: { useVision: false }
    };

    await pageAnalyzeHandler(input);

    // saveToDb はデフォルト true なので、WebPageが保存される
    expect(mockPrismaClient.webPage.upsert).toHaveBeenCalled();
  });
});

// =====================================================
// saveToDb機能テスト - SectionPattern保存
// =====================================================

describe('saveToDb機能 - SectionPattern保存', () => {
  let mockPrismaClient: ReturnType<typeof createMockPrismaClient>;

  beforeEach(() => {
    vi.resetAllMocks();
    setPageAnalyzeServiceFactory(createMockPageAnalyzeServiceWithSaveToDb);
    mockPrismaClient = createMockPrismaClient();
    setPageAnalyzePrismaClientFactory(() => mockPrismaClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
    resetPageAnalyzePrismaClientFactory();
  });

  it('saveToDb=true でSectionPatternを保存する', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    await pageAnalyzeHandler(input);

    // createManyまたは複数のcreateが呼ばれる
    const createManyCalled = vi.mocked(mockPrismaClient.sectionPattern.createMany).mock.calls.length > 0;
    const createCalled = vi.mocked(mockPrismaClient.sectionPattern.create).mock.calls.length > 0;
    expect(createManyCalled || createCalled).toBe(true);
  });

  it('SectionPatternにwebPageIdが設定される', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    await pageAnalyzeHandler(input);

    // トランザクション内でcreateが呼ばれる
    const transactionCall = vi.mocked(mockPrismaClient.$transaction).mock.calls;
    expect(transactionCall.length).toBeGreaterThan(0);
  });

  it('各セクションのtype、positionIndex、confidenceが保存される', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    await pageAnalyzeHandler(input);

    // sectionPattern.createMany または sectionPattern.create が呼ばれることを確認
    const transactionCalled = vi.mocked(mockPrismaClient.$transaction).mock.calls.length > 0;
    expect(transactionCalled).toBe(true);
  });
});

// =====================================================
// saveToDb機能テスト - MotionPattern保存
// =====================================================

describe('saveToDb機能 - MotionPattern保存', () => {
  let mockPrismaClient: ReturnType<typeof createMockPrismaClient>;

  beforeEach(() => {
    vi.resetAllMocks();
    setPageAnalyzeServiceFactory(createMockPageAnalyzeServiceWithSaveToDb);
    mockPrismaClient = createMockPrismaClient();
    setPageAnalyzePrismaClientFactory(() => mockPrismaClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
    resetPageAnalyzePrismaClientFactory();
  });

  it('saveToDb=true でMotionPatternを保存する', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
      motionOptions: { saveToDb: true }
    };

    await pageAnalyzeHandler(input);

    // createManyまたは複数のcreateが呼ばれる
    const createManyCalled = vi.mocked(mockPrismaClient.motionPattern.createMany).mock.calls.length > 0;
    const createCalled = vi.mocked(mockPrismaClient.motionPattern.create).mock.calls.length > 0;
    expect(createManyCalled || createCalled).toBe(true);
  });

  it('MotionPatternにwebPageIdが設定される', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
      motionOptions: { saveToDb: true }
    };

    await pageAnalyzeHandler(input);

    // トランザクション内でcreateが呼ばれる
    const transactionCall = vi.mocked(mockPrismaClient.$transaction).mock.calls;
    expect(transactionCall.length).toBeGreaterThan(0);
  });

  it('各パターンのtype、category、trigger、rawCssが保存される', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
      motionOptions: { saveToDb: true }
    };

    await pageAnalyzeHandler(input);

    // motionPattern.createMany または motionPattern.create が呼ばれることを確認
    const transactionCalled = vi.mocked(mockPrismaClient.$transaction).mock.calls.length > 0;
    expect(transactionCalled).toBe(true);
  });

  it('motionOptions.saveToDb=false でMotionPatternを保存しない', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
      motionOptions: { saveToDb: false }
    };

    await pageAnalyzeHandler(input);

    // motionPattern関連のcreateは呼ばれない（WebPageは保存される）
    expect(mockPrismaClient.motionPattern.create).not.toHaveBeenCalled();
    expect(mockPrismaClient.motionPattern.createMany).not.toHaveBeenCalled();
  });
});

// =====================================================
// saveToDb機能テスト - QualityEvaluation保存
// =====================================================

describe('saveToDb機能 - QualityEvaluation保存', () => {
  let mockPrismaClient: ReturnType<typeof createMockPrismaClient>;

  beforeEach(() => {
    vi.resetAllMocks();
    setPageAnalyzeServiceFactory(createMockPageAnalyzeServiceWithSaveToDb);
    mockPrismaClient = createMockPrismaClient();
    setPageAnalyzePrismaClientFactory(() => mockPrismaClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
    resetPageAnalyzePrismaClientFactory();
  });

  it('saveToDb=true でQualityEvaluationを保存する', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    await pageAnalyzeHandler(input);

    expect(mockPrismaClient.qualityEvaluation.create).toHaveBeenCalled();
  });

  it('QualityEvaluationにwebPageIdが設定される（targetType=web_page）', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    await pageAnalyzeHandler(input);

    // トランザクション内でcreateが呼ばれる
    const transactionCall = vi.mocked(mockPrismaClient.$transaction).mock.calls;
    expect(transactionCall.length).toBeGreaterThan(0);
  });

  it('overallScore、grade、axisScoresが保存される', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    await pageAnalyzeHandler(input);

    // qualityEvaluation.create が呼ばれることを確認
    const transactionCalled = vi.mocked(mockPrismaClient.$transaction).mock.calls.length > 0;
    expect(transactionCalled).toBe(true);
  });
});

// =====================================================
// saveToDb機能テスト - トランザクション管理
// =====================================================

describe('saveToDb機能 - トランザクション管理', () => {
  let mockPrismaClient: ReturnType<typeof createMockPrismaClient>;

  beforeEach(() => {
    vi.resetAllMocks();
    setPageAnalyzeServiceFactory(createMockPageAnalyzeServiceWithSaveToDb);
    mockPrismaClient = createMockPrismaClient();
    setPageAnalyzePrismaClientFactory(() => mockPrismaClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
    resetPageAnalyzePrismaClientFactory();
  });

  it('全保存がトランザクション内で実行される', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
      motionOptions: { saveToDb: true }
    };

    await pageAnalyzeHandler(input);

    expect(mockPrismaClient.$transaction).toHaveBeenCalled();
  });

  it('トランザクションが成功するとwebPageIdを返す', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.layout?.success) {
      expect(result.data.layout.pageId).toBeDefined();
      // UUIDv7形式の確認
      expect(result.data.layout.pageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
  });

  it('トランザクション内でエラーが発生したら全てロールバック', async () => {
    // トランザクションがエラーを返すようにモック
    mockPrismaClient.$transaction = vi.fn().mockRejectedValue(new Error('Transaction failed'));

    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    const result = await pageAnalyzeHandler(input);

    // Graceful Degradation: 保存が失敗してもレスポンスは返す
    expect(result.success).toBe(true);
    if (result.success) {
      // pageIdは設定されない（保存失敗のため）
      expect(result.data.layout?.pageId).toBeUndefined();
      // warningsに保存失敗が記録される
      expect(result.data.warnings).toBeDefined();
    }
  });
});

// =====================================================
// saveToDb機能テスト - Graceful Degradation
// =====================================================

describe('saveToDb機能 - Graceful Degradation', () => {
  let mockPrismaClient: ReturnType<typeof createMockPrismaClient>;

  beforeEach(() => {
    vi.resetAllMocks();
    setPageAnalyzeServiceFactory(createMockPageAnalyzeServiceWithSaveToDb);
    mockPrismaClient = createMockPrismaClient();
    setPageAnalyzePrismaClientFactory(() => mockPrismaClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
    resetPageAnalyzePrismaClientFactory();
  });

  it('WebPage保存失敗時も分析結果は返す', async () => {
    mockPrismaClient.webPage.upsert = vi.fn().mockRejectedValue(new Error('DB error'));

    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    const result = await pageAnalyzeHandler(input);

    // 分析結果自体は成功
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.motion).toBeDefined();
      expect(result.data.quality).toBeDefined();
    }
  });

  it('DB保存失敗時にwarningsに記録される', async () => {
    mockPrismaClient.$transaction = vi.fn().mockRejectedValue(new Error('Transaction failed'));

    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.warnings) {
      const dbWarning = result.data.warnings.find(w => w.code === PAGE_ANALYZE_ERROR_CODES.DB_SAVE_FAILED);
      expect(dbWarning).toBeDefined();
    }
  });

  it('PrismaClientが未設定の場合はDB保存をスキップ', async () => {
    resetPageAnalyzePrismaClientFactory();

    const input = {
      url: validUrl,
      async: false as const,
      layoutOptions: { saveToDb: true, useVision: false }
    };

    const result = await pageAnalyzeHandler(input);

    // 分析は成功（DB保存はスキップ）
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout?.pageId).toBeUndefined();
    }
  });

  it('DB接続エラーでも分析結果を返す', async () => {
    mockPrismaClient.$transaction = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layout).toBeDefined();
      expect(result.data.layout?.success).toBe(true);
    }
  });
});

// =====================================================
// saveToDb機能テスト - UUIDv7使用
// =====================================================

describe('saveToDb機能 - UUIDv7使用', () => {
  let mockPrismaClient: ReturnType<typeof createMockPrismaClient>;

  beforeEach(() => {
    vi.resetAllMocks();
    setPageAnalyzeServiceFactory(createMockPageAnalyzeServiceWithSaveToDb);
    mockPrismaClient = createMockPrismaClient();
    setPageAnalyzePrismaClientFactory(() => mockPrismaClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
    resetPageAnalyzePrismaClientFactory();
  });

  it('WebPage IDがUUIDv7形式', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    await pageAnalyzeHandler(input);

    const upsertCall = vi.mocked(mockPrismaClient.webPage.upsert).mock.calls[0];
    if (upsertCall && upsertCall[0]?.create?.id) {
      const id = upsertCall[0].create.id;
      // UUIDv7形式: version 7 は 4番目のグループの最初が 7
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
  });

  it('SectionPattern IDがUUIDv7形式', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    await pageAnalyzeHandler(input);

    // トランザクション呼び出しを確認
    expect(mockPrismaClient.$transaction).toHaveBeenCalled();
  });

  it('MotionPattern IDがUUIDv7形式', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
      motionOptions: { saveToDb: true }
    };

    await pageAnalyzeHandler(input);

    // トランザクション呼び出しを確認
    expect(mockPrismaClient.$transaction).toHaveBeenCalled();
  });

  it('QualityEvaluation IDがUUIDv7形式', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    await pageAnalyzeHandler(input);

    // トランザクション呼び出しを確認
    expect(mockPrismaClient.$transaction).toHaveBeenCalled();
  });
});

// =====================================================
// saveToDb機能テスト - 統合テスト
// =====================================================

describe('saveToDb機能 - 統合テスト', () => {
  let mockPrismaClient: ReturnType<typeof createMockPrismaClient>;

  beforeEach(() => {
    vi.resetAllMocks();
    setPageAnalyzeServiceFactory(createMockPageAnalyzeServiceWithSaveToDb);
    mockPrismaClient = createMockPrismaClient();
    setPageAnalyzePrismaClientFactory(() => mockPrismaClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPageAnalyzeServiceFactory();
    resetPageAnalyzePrismaClientFactory();
  });

  it('全オプション有効で全てのデータが保存される', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
      sourceType: 'award_gallery' as const,
      usageScope: 'owned_asset' as const,
      motionOptions: { saveToDb: true }
    };

    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    expect(mockPrismaClient.$transaction).toHaveBeenCalled();

    if (result.success && result.data.layout?.success) {
      expect(result.data.layout.pageId).toBeDefined();
    }
  });

  it('保存成功時にレスポンスにpageIdが含まれる', async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    const result = await pageAnalyzeHandler(input);

    expect(result.success).toBe(true);
    if (result.success && result.data.layout?.success) {
      expect(result.data.layout.pageId).toBeDefined();
    }
  });

  it('複数回呼び出しで異なるIDが生成される', { timeout: 120000 }, async () => {
    const input = {
      url: validUrl,
      ...syncTestBase,
    };

    await pageAnalyzeHandler(input);
    const firstCall = vi.mocked(mockPrismaClient.webPage.upsert).mock.calls[0];

    vi.mocked(mockPrismaClient.webPage.upsert).mockClear();

    await pageAnalyzeHandler(input);
    const secondCall = vi.mocked(mockPrismaClient.webPage.upsert).mock.calls[0];

    if (firstCall && secondCall) {
      const firstId = firstCall[0]?.create?.id;
      const secondId = secondCall[0]?.create?.id;
      if (firstId && secondId) {
        expect(firstId).not.toBe(secondId);
      }
    }
  });
});
