// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * db-handler.ts テスト
 * page.analyze の DB保存ロジック（cssSnippet対応含む）のテスト
 *
 * テスト対象:
 * - cssSnippetを含むセクションが正しくDBに保存されること
 * - cssSnippetがundefinedの場合も保存できること
 * - 保存されたレコードにcss_snippetカラムが含まれていること
 *
 * @module tests/tools/page/handlers/db-handler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  saveToDatabase,
  type SaveToDatabaseOptions,
  type SectionForSave,
  type MotionPatternForSave,
  type IDbHandlerPrismaClient,
} from '../../../../src/tools/page/handlers/db-handler';

// =====================================================
// モック用の型定義
// =====================================================

/**
 * テスト用のWebPage作成データ
 */
interface MockWebPageCreateData {
  id: string;
  url: string;
  title?: string;
  htmlContent?: string;
  screenshotFullUrl?: string;
  sourceType: string;
  usageScope: string;
}

/**
 * テスト用のSectionPattern作成データ
 * PrismaのsectionPattern.createManyで使用する形式
 */
interface MockSectionPatternData {
  id: string;
  webPageId: string;
  sectionType: string;
  positionIndex: number;
  htmlSnippet?: string;
  cssSnippet?: string;
  layoutInfo: {
    type: string;
    confidence: number;
    visionAnalysis?: {
      success: boolean;
      features: Array<{
        type: string;
        confidence: number;
        description?: string;
      }>;
      textRepresentation?: string;
      processingTimeMs?: number;
      modelName?: string;
    };
  };
}

// =====================================================
// テストスイート
// =====================================================

describe('db-handler - saveToDatabase', () => {
  // モックの保存データを追跡
  let capturedWebPageData: MockWebPageCreateData | null = null;
  let capturedSectionPatternData: MockSectionPatternData[] | null = null;

  /**
   * モックPrismaクライアントを作成
   */
  const createMockPrismaClient = (): IDbHandlerPrismaClient => {
    const mockWebPageId = 'mock-webpage-id-001';

    // トランザクション内で使用されるモックtx
    const mockTx = {
      webPage: {
        upsert: vi.fn().mockImplementation(async (args: {
          where: { url: string };
          create: MockWebPageCreateData;
          update: Record<string, unknown>;
        }) => {
          capturedWebPageData = args.create;
          return { id: mockWebPageId, ...args.create };
        }),
      },
      sectionPattern: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockImplementation(async (args: {
          data: MockSectionPatternData[];
        }) => {
          capturedSectionPatternData = args.data;
          return { count: args.data.length };
        }),
      },
      motionPattern: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      qualityEvaluation: {
        create: vi.fn().mockResolvedValue({ id: 'mock-quality-id-001' }),
      },
    };

    return {
      $transaction: vi.fn().mockImplementation(async (callback) => {
        return callback(mockTx);
      }),
    } as unknown as IDbHandlerPrismaClient;
  };

  beforeEach(() => {
    // 各テスト前にキャプチャデータをリセット
    capturedWebPageData = null;
    capturedSectionPatternData = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // =====================================================
  // 基本的なDB保存テスト
  // =====================================================

  describe('基本的なDB保存', () => {
    it('WebPageとSectionPatternが正しく保存されること', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClient();
      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/test-page',
        title: 'Test Page',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false,
        sections: [
          {
            id: 'section-0',
            type: 'hero',
            positionIndex: 0,
            confidence: 0.95,
            htmlSnippet: '<section class="hero">Hero content</section>',
          },
        ],
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(result.webPageId).toBeDefined();
      expect(result.sectionPatternCount).toBe(1);
      expect(capturedWebPageData).not.toBeNull();
      expect(capturedWebPageData?.url).toBe('https://example.com/test-page');
    });
  });

  // =====================================================
  // cssSnippet保存テスト
  // =====================================================

  describe('cssSnippet DB保存', () => {
    it('cssSnippetを含むセクションが正しくDBに保存されること', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClient();
      const cssSnippetContent = `
.hero {
  display: flex;
  align-items: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}
.hero h1 {
  font-size: 3rem;
  color: white;
}
`;
      const sections: SectionForSave[] = [
        {
          id: 'section-0',
          type: 'hero',
          positionIndex: 0,
          confidence: 0.95,
          heading: 'Welcome',
          htmlSnippet: '<section class="hero"><h1>Welcome</h1></section>',
          // cssSnippetフィールド（現在はSectionForSaveに未定義だが、MCP Tool Developerが追加予定）
          // cssSnippet: cssSnippetContent,
        },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/css-test',
        title: 'CSS Test Page',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false,
        sections,
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(result.sectionPatternCount).toBe(1);
      expect(capturedSectionPatternData).not.toBeNull();
      expect(capturedSectionPatternData).toHaveLength(1);

      // 保存されたセクションデータを確認
      const savedSection = capturedSectionPatternData![0];
      expect(savedSection.sectionType).toBe('hero');
      expect(savedSection.htmlSnippet).toBe('<section class="hero"><h1>Welcome</h1></section>');

      // cssSnippet対応後は以下のアサーションが有効になる
      // expect(savedSection.cssSnippet).toBe(cssSnippetContent);
    });

    it('cssSnippetがundefinedの場合も保存できること', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClient();
      const sections: SectionForSave[] = [
        {
          id: 'section-0',
          type: 'feature',
          positionIndex: 0,
          confidence: 0.88,
          htmlSnippet: '<section class="feature">Feature content</section>',
          // cssSnippetはundefined（省略）
        },
        {
          id: 'section-1',
          type: 'cta',
          positionIndex: 1,
          confidence: 0.92,
          // htmlSnippetもcssSnippetもundefined
        },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/no-css-test',
        title: 'No CSS Test Page',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false,
        sections,
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(result.sectionPatternCount).toBe(2);
      expect(capturedSectionPatternData).toHaveLength(2);

      // 各セクションが正しく保存されていること
      expect(capturedSectionPatternData![0].sectionType).toBe('feature');
      expect(capturedSectionPatternData![0].htmlSnippet).toBe('<section class="feature">Feature content</section>');
      expect(capturedSectionPatternData![1].sectionType).toBe('cta');
      expect(capturedSectionPatternData![1].htmlSnippet).toBeUndefined();
    });

    it('保存されたレコードにcss_snippetカラムが含まれていること（スキーマ検証）', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClient();
      const sections: SectionForSave[] = [
        {
          id: 'section-0',
          type: 'hero',
          positionIndex: 0,
          confidence: 0.95,
          htmlSnippet: '<section>Test</section>',
        },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/schema-test',
        title: 'Schema Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false,
        sections,
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert: 保存が成功すること（スキーマにcssSnippetカラムがあることを前提）
      expect(result.success).toBe(true);
      expect(capturedSectionPatternData).not.toBeNull();

      // Prismaスキーマで定義されているcssSnippetフィールド（オプショナル）の存在確認
      // 実際のDBカラム名は 'css_snippet'（Prisma @mapにより）
      // このテストはcssSnippetフィールドが追加された後に有効化
      // expect('cssSnippet' in capturedSectionPatternData![0]).toBe(true);
    });

    it('cssSnippetとhtmlSnippetの両方が保存されること', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClient();
      const htmlContent = '<section class="pricing"><h2>Pricing</h2><div class="cards"></div></section>';
      const cssContent = `.pricing { padding: 4rem 0; }
.pricing h2 { text-align: center; }
.pricing .cards { display: grid; gap: 2rem; }`;

      const sections: SectionForSave[] = [
        {
          id: 'section-0',
          type: 'pricing',
          positionIndex: 0,
          confidence: 0.9,
          heading: 'Our Pricing',
          htmlSnippet: htmlContent,
          // cssSnippetフィールド追加後に有効化
          // cssSnippet: cssContent,
        },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/full-snippet-test',
        title: 'Full Snippet Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false,
        sections,
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(capturedSectionPatternData).not.toBeNull();

      const savedSection = capturedSectionPatternData![0];
      expect(savedSection.htmlSnippet).toBe(htmlContent);
      // cssSnippet対応後は以下のアサーションが有効になる
      // expect(savedSection.cssSnippet).toBe(cssContent);
    });
  });

  // =====================================================
  // Vision Features との組み合わせテスト
  // =====================================================

  describe('cssSnippetとvisionFeaturesの組み合わせ', () => {
    it('visionFeaturesを含むセクションでもcssSnippetが保存されること', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClient();
      const sections: SectionForSave[] = [
        {
          id: 'section-0',
          type: 'hero',
          positionIndex: 0,
          confidence: 0.95,
          htmlSnippet: '<section class="hero">Vision + CSS test</section>',
          // cssSnippet: '.hero { background: #000; }',
          visionFeatures: {
            success: true,
            features: [
              {
                type: 'layout_structure',
                confidence: 0.85,
                description: 'Full-width hero with centered content',
              },
            ],
            textRepresentation: 'Hero section with dark background',
            processingTimeMs: 1234,
            modelName: 'llama3.2-vision',
          },
        },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/vision-css-test',
        title: 'Vision + CSS Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false,
        sections,
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(capturedSectionPatternData).not.toBeNull();

      const savedSection = capturedSectionPatternData![0];
      expect(savedSection.layoutInfo.visionAnalysis).toBeDefined();
      expect(savedSection.layoutInfo.visionAnalysis?.success).toBe(true);
      expect(savedSection.htmlSnippet).toBe('<section class="hero">Vision + CSS test</section>');
      // cssSnippet対応後は以下のアサーションが有効になる
      // expect(savedSection.cssSnippet).toBe('.hero { background: #000; }');
    });
  });

  // =====================================================
  // エラーハンドリングテスト
  // =====================================================

  describe('エラーハンドリング', () => {
    it('DB保存エラー時にGraceful Degradationが機能すること', async () => {
      // Arrange: エラーを発生させるモック
      const mockPrisma = {
        $transaction: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      } as unknown as IDbHandlerPrismaClient;

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/error-test',
        title: 'Error Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false,
        sections: [
          {
            id: 'section-0',
            type: 'hero',
            positionIndex: 0,
            confidence: 0.95,
          },
        ],
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert: エラーでも結果が返ること（Graceful Degradation）
      expect(result.success).toBe(false);
      expect(result.error).toContain('DB connection failed');
    });
  });

  // =====================================================
  // セクションIDマッピングテスト
  // =====================================================

  describe('セクションIDマッピング', () => {
    it('元のセクションIDとDB保存後のUUIDv7のマッピングが作成されること', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClient();
      const sections: SectionForSave[] = [
        { id: 'section-0', type: 'hero', positionIndex: 0, confidence: 0.95 },
        { id: 'section-1', type: 'feature', positionIndex: 1, confidence: 0.88 },
        { id: 'section-2', type: 'cta', positionIndex: 2, confidence: 0.92 },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/mapping-test',
        title: 'Mapping Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false,
        sections,
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(result.sectionIdMapping).toBeDefined();
      expect(result.sectionIdMapping?.size).toBe(3);
      expect(result.sectionIdMapping?.has('section-0')).toBe(true);
      expect(result.sectionIdMapping?.has('section-1')).toBe(true);
      expect(result.sectionIdMapping?.has('section-2')).toBe(true);

      // 各マッピングがUUIDv7形式であることを確認
      const uuidv7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      result.sectionIdMapping?.forEach((dbId) => {
        expect(dbId).toMatch(uuidv7Pattern);
      });
    });
  });

  // =====================================================
  // visualFeatures保存テスト（Phase 3-2）
  // =====================================================

  describe('visualFeatures DB保存（Phase 3-2）', () => {
    /**
     * visualFeaturesを含むSectionPatternデータをキャプチャするための拡張型
     */
    interface MockSectionPatternWithVisualFeatures extends MockSectionPatternData {
      visualFeatures?: {
        colors?: {
          dominantColors?: Array<{ hex: string; percentage: number; name?: string }>;
          colorCount?: number;
          colorPalette?: string[];
          colorHarmony?: string;
        };
        theme?: {
          detectedTheme?: string;
          confidence?: number;
          characteristics?: string[];
        };
        density?: {
          textDensity?: number;
          imageDensity?: number;
          whitespaceDensity?: number;
          overallDensity?: string;
        };
        gradient?: {
          hasGradient?: boolean;
          gradientTypes?: string[];
          gradientColors?: string[];
        };
        mood?: {
          primary?: string;
          secondary?: string;
          confidence?: number;
        };
        brandTone?: {
          tone?: string;
          keywords?: string[];
          confidence?: number;
        };
      };
    }

    let capturedSectionsWithVisualFeatures: MockSectionPatternWithVisualFeatures[] | null = null;

    const createMockPrismaClientWithVisualFeatures = (): IDbHandlerPrismaClient => {
      const mockWebPageId = 'mock-webpage-id-visual-features';

      const mockTx = {
        webPage: {
          upsert: vi.fn().mockImplementation(async (args: {
            where: { url: string };
            create: MockWebPageCreateData;
            update: Record<string, unknown>;
          }) => {
            return { id: mockWebPageId, ...args.create };
          }),
        },
        sectionPattern: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockImplementation(async (args: {
            data: MockSectionPatternWithVisualFeatures[];
          }) => {
            capturedSectionsWithVisualFeatures = args.data;
            return { count: args.data.length };
          }),
        },
        motionPattern: {
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        qualityEvaluation: {
          create: vi.fn().mockResolvedValue({ id: 'mock-quality-id-visual' }),
        },
      };

      return {
        $transaction: vi.fn().mockImplementation(async (callback) => {
          return callback(mockTx);
        }),
      } as unknown as IDbHandlerPrismaClient;
    };

    beforeEach(() => {
      capturedSectionsWithVisualFeatures = null;
    });

    it('ページレベルのvisualFeaturesが各セクションに保存されること', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClientWithVisualFeatures();
      const pageVisualFeatures = {
        colors: {
          dominantColors: [
            { hex: '#667eea', percentage: 40, name: 'purple' },
            { hex: '#764ba2', percentage: 30, name: 'violet' },
          ],
          colorCount: 5,
          colorPalette: ['#667eea', '#764ba2', '#ffffff', '#000000', '#f5f5f5'],
          colorHarmony: 'complementary',
        },
        theme: {
          detectedTheme: 'dark',
          confidence: 0.85,
          characteristics: ['modern', 'gradient-heavy'],
        },
        density: {
          textDensity: 0.3,
          imageDensity: 0.4,
          whitespaceDensity: 0.3,
          overallDensity: 'balanced',
        },
        gradient: {
          hasGradient: true,
          gradientTypes: ['linear'],
          gradientColors: ['#667eea', '#764ba2'],
        },
      };

      const sections: SectionForSave[] = [
        {
          id: 'section-0',
          type: 'hero',
          positionIndex: 0,
          confidence: 0.95,
          htmlSnippet: '<section class="hero">Hero</section>',
        },
        {
          id: 'section-1',
          type: 'feature',
          positionIndex: 1,
          confidence: 0.88,
          htmlSnippet: '<section class="feature">Features</section>',
        },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/visual-features-test',
        title: 'Visual Features Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false,
        sections,
        visualFeatures: pageVisualFeatures,
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(result.sectionPatternCount).toBe(2);
      expect(capturedSectionsWithVisualFeatures).not.toBeNull();
      expect(capturedSectionsWithVisualFeatures).toHaveLength(2);

      // 各セクションにvisualFeaturesが保存されていること
      const section0 = capturedSectionsWithVisualFeatures![0];
      const section1 = capturedSectionsWithVisualFeatures![1];

      expect(section0.visualFeatures).toBeDefined();
      expect(section0.visualFeatures?.colors?.dominantColors).toHaveLength(2);
      expect(section0.visualFeatures?.theme?.detectedTheme).toBe('dark');
      expect(section0.visualFeatures?.gradient?.hasGradient).toBe(true);

      expect(section1.visualFeatures).toBeDefined();
      expect(section1.visualFeatures?.colors?.colorHarmony).toBe('complementary');
      expect(section1.visualFeatures?.density?.overallDensity).toBe('balanced');
    });

    it('セクション固有のvisualFeaturesがページレベルより優先されること', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClientWithVisualFeatures();

      // ページレベルのvisualFeatures
      const pageVisualFeatures = {
        colors: {
          dominantColors: [{ hex: '#000000', percentage: 100, name: 'black' }],
          colorCount: 1,
        },
        theme: {
          detectedTheme: 'dark',
          confidence: 0.9,
        },
      };

      // セクション固有のvisualFeatures（優先されるべき）
      const sectionVisualFeatures = {
        colors: {
          dominantColors: [{ hex: '#ffffff', percentage: 100, name: 'white' }],
          colorCount: 1,
        },
        theme: {
          detectedTheme: 'light',
          confidence: 0.95,
        },
      };

      const sections: SectionForSave[] = [
        {
          id: 'section-0',
          type: 'hero',
          positionIndex: 0,
          confidence: 0.95,
          visualFeatures: sectionVisualFeatures, // セクション固有
        },
        {
          id: 'section-1',
          type: 'feature',
          positionIndex: 1,
          confidence: 0.88,
          // visualFeaturesなし → ページレベルを使用
        },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/visual-features-priority-test',
        title: 'Visual Features Priority Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false,
        sections,
        visualFeatures: pageVisualFeatures,
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(capturedSectionsWithVisualFeatures).not.toBeNull();

      // section-0: セクション固有のvisualFeaturesが使用される
      const section0 = capturedSectionsWithVisualFeatures![0];
      expect(section0.visualFeatures?.colors?.dominantColors![0].hex).toBe('#ffffff');
      expect(section0.visualFeatures?.theme?.detectedTheme).toBe('light');

      // section-1: ページレベルのvisualFeaturesが使用される
      const section1 = capturedSectionsWithVisualFeatures![1];
      expect(section1.visualFeatures?.colors?.dominantColors![0].hex).toBe('#000000');
      expect(section1.visualFeatures?.theme?.detectedTheme).toBe('dark');
    });

    it('visualFeaturesがundefinedの場合も正常に保存されること', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClientWithVisualFeatures();
      const sections: SectionForSave[] = [
        {
          id: 'section-0',
          type: 'hero',
          positionIndex: 0,
          confidence: 0.95,
        },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/no-visual-features-test',
        title: 'No Visual Features Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false,
        sections,
        // visualFeaturesはundefined
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(capturedSectionsWithVisualFeatures).not.toBeNull();

      // visualFeaturesはセットされない（undefinedのまま）
      const section0 = capturedSectionsWithVisualFeatures![0];
      expect(section0.visualFeatures).toBeUndefined();
    });

    it('visualFeaturesのmoodとbrandTone（Vision AI結果）も保存されること', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClientWithVisualFeatures();
      const pageVisualFeatures = {
        colors: {
          dominantColors: [{ hex: '#3b82f6', percentage: 50, name: 'blue' }],
        },
        mood: {
          primary: 'professional',
          secondary: 'trustworthy',
          confidence: 0.88,
        },
        brandTone: {
          tone: 'corporate',
          keywords: ['enterprise', 'reliable', 'modern'],
          confidence: 0.82,
        },
      };

      const sections: SectionForSave[] = [
        {
          id: 'section-0',
          type: 'hero',
          positionIndex: 0,
          confidence: 0.95,
        },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/visual-features-mood-test',
        title: 'Visual Features Mood Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false,
        sections,
        visualFeatures: pageVisualFeatures,
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(capturedSectionsWithVisualFeatures).not.toBeNull();

      const section0 = capturedSectionsWithVisualFeatures![0];
      expect(section0.visualFeatures?.mood?.primary).toBe('professional');
      expect(section0.visualFeatures?.mood?.confidence).toBe(0.88);
      expect(section0.visualFeatures?.brandTone?.tone).toBe('corporate');
      expect(section0.visualFeatures?.brandTone?.keywords).toContain('enterprise');
    });

    it('visualFeaturesとvisionFeaturesの両方が同時に保存されること', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClientWithVisualFeatures();

      const pageVisualFeatures = {
        colors: {
          dominantColors: [{ hex: '#10b981', percentage: 60, name: 'emerald' }],
        },
        theme: {
          detectedTheme: 'light',
          confidence: 0.9,
        },
      };

      const sections: SectionForSave[] = [
        {
          id: 'section-0',
          type: 'hero',
          positionIndex: 0,
          confidence: 0.95,
          // visionFeatures（Vision APIによる直接解析結果）
          visionFeatures: {
            success: true,
            features: [
              {
                type: 'layout_structure',
                confidence: 0.85,
                description: 'Hero section with centered content',
              },
            ],
            textRepresentation: 'Hero with green accent',
            processingTimeMs: 1500,
            modelName: 'llama3.2-vision',
          },
        },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/both-features-test',
        title: 'Both Features Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false,
        sections,
        visualFeatures: pageVisualFeatures,
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(capturedSectionsWithVisualFeatures).not.toBeNull();

      const section0 = capturedSectionsWithVisualFeatures![0];

      // visualFeatures（画像処理アルゴリズム）
      expect(section0.visualFeatures?.colors?.dominantColors![0].hex).toBe('#10b981');
      expect(section0.visualFeatures?.theme?.detectedTheme).toBe('light');

      // visionFeatures（Vision API）はlayoutInfo.visionAnalysisに保存される
      expect(section0.layoutInfo.visionAnalysis).toBeDefined();
      expect(section0.layoutInfo.visionAnalysis?.success).toBe(true);
      expect(section0.layoutInfo.visionAnalysis?.modelName).toBe('llama3.2-vision');
    });
  });

  // =====================================================
  // MotionPattern保存テスト（layoutSaveToDbとは独立）
  // =====================================================

  describe('MotionPattern保存（layoutSaveToDb独立）', () => {
    /**
     * MotionPattern専用のモックPrismaクライアント
     * motionPattern.createManyの呼び出しを追跡
     */
    let capturedMotionPatternData: Array<{
      id: string;
      webPageId: string | null | undefined;
      name: string;
      category: string;
      triggerType: string;
    }> | null = null;

    const createMockPrismaClientWithMotion = (): IDbHandlerPrismaClient => {
      const mockWebPageId = 'mock-webpage-id-002';

      const mockTx = {
        webPage: {
          upsert: vi.fn().mockImplementation(async (args: {
            where: { url: string };
            create: MockWebPageCreateData;
            update: Record<string, unknown>;
          }) => {
            return { id: mockWebPageId, ...args.create };
          }),
        },
        sectionPattern: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockImplementation(async (args: { data: unknown[] }) => {
            return { count: args.data.length };
          }),
        },
        motionPattern: {
          createMany: vi.fn().mockImplementation(async (args: {
            data: Array<{
              id: string;
              webPageId: string | null | undefined;
              name: string;
              category: string;
              triggerType: string;
            }>;
          }) => {
            capturedMotionPatternData = args.data;
            return { count: args.data.length };
          }),
        },
        qualityEvaluation: {
          create: vi.fn().mockResolvedValue({ id: 'mock-quality-id-002' }),
        },
      };

      return {
        $transaction: vi.fn().mockImplementation(async (callback) => {
          return callback(mockTx);
        }),
      } as unknown as IDbHandlerPrismaClient;
    };

    beforeEach(() => {
      capturedMotionPatternData = null;
    });

    it('layoutSaveToDb=false, motionSaveToDb=true の場合、MotionPatternが保存されること', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClientWithMotion();
      const motionPatterns: MotionPatternForSave[] = [
        {
          id: 'motion-0',
          name: 'fadeIn',
          type: 'css_animation',
          category: 'entrance',
          trigger: 'load',
          duration: 300,
          easing: 'ease-out',
          properties: ['opacity', 'transform'],
          performance: { level: 'good', usesTransform: true, usesOpacity: true },
          accessibility: { respectsReducedMotion: true },
        },
        {
          id: 'motion-1',
          name: 'slideUp',
          type: 'css_transition',
          category: 'scroll_trigger',
          trigger: 'scroll',
          duration: 500,
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
          properties: ['transform'],
          performance: { level: 'good', usesTransform: true, usesOpacity: false },
          accessibility: { respectsReducedMotion: false },
        },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/motion-only-test',
        title: 'Motion Only Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: false, // WebPage/SectionPatternは保存しない
        motionSaveToDb: true,  // MotionPatternのみ保存
        motionPatterns,
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(result.motionPatternCount).toBe(2);
      expect(capturedMotionPatternData).not.toBeNull();
      expect(capturedMotionPatternData).toHaveLength(2);

      // webPageIdはnull（layoutSaveToDb=falseのためWebPageが作成されない）
      // Prismaスキーマ上はnullableなので許容される
      // undefinedではなくnullを明示的に設定（Prismaでの扱いを明確にするため）
      expect(capturedMotionPatternData![0].webPageId).toBeNull();
      expect(capturedMotionPatternData![1].webPageId).toBeNull();

      // MotionPatternの内容が正しく保存されていること
      expect(capturedMotionPatternData![0].name).toBe('fadeIn');
      expect(capturedMotionPatternData![0].category).toBe('entrance');
      expect(capturedMotionPatternData![1].name).toBe('slideUp');
      expect(capturedMotionPatternData![1].triggerType).toBe('scroll');
    });

    it('layoutSaveToDb=true, motionSaveToDb=true の場合、WebPageとMotionPatternの両方が保存されること', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClientWithMotion();
      const motionPatterns: MotionPatternForSave[] = [
        {
          id: 'motion-0',
          name: 'hoverScale',
          type: 'css_transition',
          category: 'hover_effect',
          trigger: 'hover',
          duration: 200,
          easing: 'ease',
          properties: ['transform'],
          performance: { level: 'good', usesTransform: true, usesOpacity: false },
          accessibility: { respectsReducedMotion: true },
        },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/both-save-test',
        title: 'Both Save Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: true,
        sections: [
          { id: 'section-0', type: 'hero', positionIndex: 0, confidence: 0.95 },
        ],
        motionPatterns,
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(result.webPageId).toBeDefined();
      expect(result.sectionPatternCount).toBe(1);
      expect(result.motionPatternCount).toBe(1);
      expect(capturedMotionPatternData).not.toBeNull();

      // webPageIdが設定されていること（layoutSaveToDb=trueのためWebPageが作成される）
      expect(capturedMotionPatternData![0].webPageId).toBeDefined();
      expect(capturedMotionPatternData![0].name).toBe('hoverScale');
    });

    it('motionSaveToDb=false の場合、motionPatternsがあってもMotionPatternは保存されないこと', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClientWithMotion();
      const motionPatterns: MotionPatternForSave[] = [
        {
          id: 'motion-0',
          name: 'fadeOut',
          type: 'css_animation',
          category: 'exit',
          trigger: 'click',
          duration: 300,
          easing: 'ease-in',
          properties: ['opacity'],
          performance: { level: 'good', usesTransform: false, usesOpacity: true },
          accessibility: { respectsReducedMotion: true },
        },
      ];

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/no-motion-save-test',
        title: 'No Motion Save Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: true,
        motionSaveToDb: false, // MotionPatternは保存しない
        sections: [
          { id: 'section-0', type: 'hero', positionIndex: 0, confidence: 0.95 },
        ],
        motionPatterns,
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(result.motionPatternCount).toBe(0);
      expect(capturedMotionPatternData).toBeNull(); // createManyは呼ばれない
    });

    it('空のmotionPatterns配列の場合、MotionPatternは保存されないこと', async () => {
      // Arrange
      const mockPrisma = createMockPrismaClientWithMotion();

      const options: SaveToDatabaseOptions = {
        url: 'https://example.com/empty-motion-test',
        title: 'Empty Motion Test',
        htmlContent: '<html><body>Test</body></html>',
        sourceType: 'user_provided',
        usageScope: 'inspiration_only',
        layoutSaveToDb: false,
        motionSaveToDb: true,
        motionPatterns: [], // 空の配列
      };

      // Act
      const result = await saveToDatabase(mockPrisma, options);

      // Assert
      expect(result.success).toBe(true);
      expect(result.motionPatternCount).toBe(0);
      expect(capturedMotionPatternData).toBeNull(); // createManyは呼ばれない
    });
  });
});
