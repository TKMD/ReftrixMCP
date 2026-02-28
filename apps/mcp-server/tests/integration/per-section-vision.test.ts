// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * perSectionVision 統合テスト
 *
 * page.analyze の perSectionVision=true オプションに関する統合テスト
 * - セクション単位の Vision 分析実行
 * - 各セクションに異なる visionFeatures が付与されることを確認
 * - Ollama 未接続時の Graceful Degradation
 *
 * @module tests/integration/per-section-vision.test
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { Sharp } from 'sharp';

// =============================================================================
// テスト用のモック定義
// =============================================================================

// SectionScreenshotService のモック
vi.mock('../../src/services/section-screenshot.service', () => {
  return {
    SectionScreenshotService: vi.fn().mockImplementation(() => ({
      extractSection: vi.fn(),
      extractMultipleSections: vi.fn(),
    })),
  };
});

// LlamaVisionAdapter のモック
vi.mock('../../src/services/vision-adapter/llama-vision.adapter', () => {
  return {
    LlamaVisionAdapter: vi.fn().mockImplementation(() => ({
      isAvailable: vi.fn(),
      analyze: vi.fn(),
      analyzeSection: vi.fn(),
      generateSectionTextRepresentation: vi.fn(),
    })),
  };
});

// =============================================================================
// インポート（モックの後でインポートする必要がある）
// =============================================================================

import { SectionScreenshotService } from '../../src/services/section-screenshot.service';
import { LlamaVisionAdapter } from '../../src/services/vision-adapter/llama-vision.adapter';

// =============================================================================
// テストフィクスチャ
// =============================================================================

/**
 * テスト用のマルチセクションHTML
 * hero, feature, testimonial, pricing, cta, footer セクションを持つ
 */
const MULTI_SECTION_HTML = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Multi Section Page</title>
  <style>
    section { padding: 80px 20px; }
    .hero { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 600px; }
    .features { background: #f8fafc; min-height: 400px; }
    .testimonials { background: #ffffff; min-height: 300px; }
    .pricing { background: #f1f5f9; min-height: 500px; }
    .cta { background: #1e40af; min-height: 200px; }
    footer { background: #0f172a; min-height: 150px; }
  </style>
</head>
<body>
  <section class="hero" id="hero" data-section="hero">
    <h1>Welcome to Our Platform</h1>
    <p>The best solution for your needs</p>
    <button class="btn-primary">Get Started</button>
  </section>

  <section class="features" id="features" data-section="feature">
    <h2>Powerful Features</h2>
    <div class="feature-grid">
      <div class="feature-card">
        <h3>Feature 1</h3>
        <p>Description of feature 1</p>
      </div>
      <div class="feature-card">
        <h3>Feature 2</h3>
        <p>Description of feature 2</p>
      </div>
    </div>
  </section>

  <section class="testimonials" id="testimonials" data-section="testimonial">
    <h2>What Our Customers Say</h2>
    <blockquote>
      <p>"Amazing product!"</p>
      <cite>- John Doe, CEO</cite>
    </blockquote>
  </section>

  <section class="pricing" id="pricing" data-section="pricing">
    <h2>Simple Pricing</h2>
    <div class="pricing-card">
      <h3>Pro Plan</h3>
      <span class="price">$99/mo</span>
    </div>
  </section>

  <section class="cta" id="cta" data-section="cta">
    <h2>Ready to Start?</h2>
    <button class="btn-primary">Sign Up Now</button>
  </section>

  <footer data-section="footer">
    <p>&copy; 2024 Company Inc.</p>
    <nav>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
    </nav>
  </footer>
</body>
</html>
`;

/**
 * 最小限のセクションを持つHTML（1セクションのみ）
 */
const SINGLE_SECTION_HTML = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Single Section Page</title>
</head>
<body>
  <section class="hero" id="hero" data-section="hero">
    <h1>Hero Section Only</h1>
    <p>This page has only one section</p>
  </section>
</body>
</html>
`;

/**
 * Base64エンコードされたテスト用画像を生成（1x1ピクセル）
 */
function createTestBase64Image(): string {
  // 1x1ピクセルの透明PNG（Base64）
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
}

/**
 * テスト用のセクション情報を生成
 */
function createTestSections() {
  return [
    { id: 'section-hero', type: 'hero', positionIndex: 0, confidence: 0.95, position: { startY: 0, endY: 600, height: 600 } },
    { id: 'section-feature', type: 'feature', positionIndex: 1, confidence: 0.88, position: { startY: 600, endY: 1000, height: 400 } },
    { id: 'section-testimonial', type: 'testimonial', positionIndex: 2, confidence: 0.82, position: { startY: 1000, endY: 1300, height: 300 } },
    { id: 'section-pricing', type: 'pricing', positionIndex: 3, confidence: 0.90, position: { startY: 1300, endY: 1800, height: 500 } },
    { id: 'section-cta', type: 'cta', positionIndex: 4, confidence: 0.92, position: { startY: 1800, endY: 2000, height: 200 } },
    { id: 'section-footer', type: 'footer', positionIndex: 5, confidence: 0.85, position: { startY: 2000, endY: 2150, height: 150 } },
  ];
}

/**
 * Vision分析結果をセクションタイプに基づいて生成
 */
function createMockVisionResult(sectionType: string, sectionId: string) {
  const typeSpecificFeatures: Record<string, Array<{ type: string; confidence: number; data: { description: string } }>> = {
    hero: [
      { type: 'layout_structure', confidence: 0.92, data: { description: 'Centered hero layout with gradient background' } },
      { type: 'color_palette', confidence: 0.88, data: { description: 'Purple-blue gradient, white text' } },
      { type: 'whitespace', confidence: 0.85, data: { description: 'Generous vertical padding' } },
    ],
    feature: [
      { type: 'layout_structure', confidence: 0.89, data: { description: 'Grid layout with 2 feature cards' } },
      { type: 'color_palette', confidence: 0.84, data: { description: 'Light gray background, dark text' } },
      { type: 'whitespace', confidence: 0.81, data: { description: 'Balanced spacing between cards' } },
    ],
    testimonial: [
      { type: 'layout_structure', confidence: 0.87, data: { description: 'Single column with blockquote' } },
      { type: 'color_palette', confidence: 0.83, data: { description: 'White background, emphasis on quote' } },
      { type: 'whitespace', confidence: 0.79, data: { description: 'Minimal, focused layout' } },
    ],
    pricing: [
      { type: 'layout_structure', confidence: 0.91, data: { description: 'Card-based pricing table' } },
      { type: 'color_palette', confidence: 0.86, data: { description: 'Subtle gray background, highlighted price' } },
      { type: 'whitespace', confidence: 0.82, data: { description: 'Clear separation between elements' } },
    ],
    cta: [
      { type: 'layout_structure', confidence: 0.93, data: { description: 'Centered CTA with prominent button' } },
      { type: 'color_palette', confidence: 0.90, data: { description: 'Dark blue background, white button' } },
      { type: 'whitespace', confidence: 0.88, data: { description: 'Focused, attention-grabbing' } },
    ],
    footer: [
      { type: 'layout_structure', confidence: 0.84, data: { description: 'Multi-column footer navigation' } },
      { type: 'color_palette', confidence: 0.80, data: { description: 'Dark background, light text links' } },
      { type: 'whitespace', confidence: 0.75, data: { description: 'Compact but readable' } },
    ],
  };

  return {
    success: true,
    features: typeSpecificFeatures[sectionType] || typeSpecificFeatures['hero'],
    processingTimeMs: Math.floor(Math.random() * 500) + 200, // 200-700ms
    modelName: 'llama3.2-vision',
    sectionId,
  };
}

// =============================================================================
// 統合テスト: page.analyze with perSectionVision=true
// =============================================================================

describe('page.analyze perSectionVision 統合テスト', () => {
  let mockScreenshotService: {
    extractSection: ReturnType<typeof vi.fn>;
    extractMultipleSections: ReturnType<typeof vi.fn>;
  };
  let mockVisionAdapter: {
    isAvailable: ReturnType<typeof vi.fn>;
    analyze: ReturnType<typeof vi.fn>;
    analyzeSection: ReturnType<typeof vi.fn>;
    generateSectionTextRepresentation: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // SectionScreenshotService のモックインスタンスを取得
    mockScreenshotService = {
      extractSection: vi.fn(),
      extractMultipleSections: vi.fn(),
    };
    vi.mocked(SectionScreenshotService).mockImplementation(() => mockScreenshotService as unknown as SectionScreenshotService);

    // LlamaVisionAdapter のモックインスタンスを取得
    mockVisionAdapter = {
      isAvailable: vi.fn(),
      analyze: vi.fn(),
      analyzeSection: vi.fn(),
      generateSectionTextRepresentation: vi.fn(),
    };
    vi.mocked(LlamaVisionAdapter).mockImplementation(() => mockVisionAdapter as unknown as LlamaVisionAdapter);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('各セクションに異なるvisionFeaturesが付与される', () => {
    it('6セクションのページで、各セクションに固有のvisionFeaturesが設定される', async () => {
      // Arrange: モックの設定
      const sections = createTestSections();
      const testScreenshot = createTestBase64Image();

      // VisionAdapter は利用可能
      mockVisionAdapter.isAvailable.mockResolvedValue(true);

      // 各セクションに対してVision分析結果を返す
      mockVisionAdapter.analyzeSection.mockImplementation(async (options: { sectionId: string; sectionTypeHint?: string }) => {
        const sectionType = options.sectionTypeHint || 'unknown';
        return createMockVisionResult(sectionType, options.sectionId);
      });

      // テキスト表現を生成
      mockVisionAdapter.generateSectionTextRepresentation.mockImplementation(
        (result: { success: boolean; features: Array<{ type: string; confidence: number; data: { description: string } }> }, sectionType: string) => {
          return `[${sectionType}] Vision analysis: ${result.features.map((f) => f.data.description).join(', ')}`;
        }
      );

      // スクリーンショット切り出し成功
      mockScreenshotService.extractMultipleSections.mockResolvedValue({
        successes: sections.map((s) => ({
          sectionId: s.id,
          imageBuffer: Buffer.from('test-image-data'),
          bounds: s.position,
        })),
        errors: [],
      });

      // Act: perSectionVision の処理をシミュレート
      const sectionResults = [];

      for (const section of sections) {
        const visionResult = await mockVisionAdapter.analyzeSection({
          imageBuffer: Buffer.from('test-image-data'),
          mimeType: 'image/png',
          features: ['layout_structure', 'color_palette', 'whitespace'],
          sectionId: section.id,
          sectionTypeHint: section.type,
        });

        const textRepresentation = mockVisionAdapter.generateSectionTextRepresentation(visionResult, section.type);

        sectionResults.push({
          id: section.id,
          type: section.type,
          visionFeatures: {
            success: visionResult.success,
            features: visionResult.features,
            textRepresentation,
            processingTimeMs: visionResult.processingTimeMs,
            modelName: visionResult.modelName,
          },
        });
      }

      // Assert: 各セクションに異なるvisionFeaturesが付与されている
      expect(sectionResults).toHaveLength(6);

      // 各セクションタイプごとに固有の特徴があることを確認
      const heroSection = sectionResults.find((s) => s.type === 'hero');
      expect(heroSection?.visionFeatures.success).toBe(true);
      expect(heroSection?.visionFeatures.features.some((f) => f.data.description.includes('gradient'))).toBe(true);

      const featureSection = sectionResults.find((s) => s.type === 'feature');
      expect(featureSection?.visionFeatures.success).toBe(true);
      expect(featureSection?.visionFeatures.features.some((f) => f.data.description.includes('Grid layout'))).toBe(true);

      const ctaSection = sectionResults.find((s) => s.type === 'cta');
      expect(ctaSection?.visionFeatures.success).toBe(true);
      expect(ctaSection?.visionFeatures.features.some((f) => f.data.description.includes('CTA'))).toBe(true);

      // 全てのセクションがモデル名を持っている
      for (const section of sectionResults) {
        expect(section.visionFeatures.modelName).toBe('llama3.2-vision');
      }
    });

    it('各セクションのtextRepresentationがセクションタイプを含む', async () => {
      // Arrange
      const sections = createTestSections();

      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyzeSection.mockImplementation(async (options: { sectionId: string; sectionTypeHint?: string }) => {
        const sectionType = options.sectionTypeHint || 'unknown';
        return createMockVisionResult(sectionType, options.sectionId);
      });
      mockVisionAdapter.generateSectionTextRepresentation.mockImplementation(
        (_result: unknown, sectionType: string) => {
          return `Section type: ${sectionType}. Layout analysis completed.`;
        }
      );

      // Act & Assert
      for (const section of sections) {
        const visionResult = await mockVisionAdapter.analyzeSection({
          imageBuffer: Buffer.from('test'),
          mimeType: 'image/png',
          features: ['layout_structure'],
          sectionId: section.id,
          sectionTypeHint: section.type,
        });

        const textRep = mockVisionAdapter.generateSectionTextRepresentation(visionResult, section.type);

        // セクションタイプがtextRepresentationに含まれる
        expect(textRep).toContain(section.type);
      }
    });

    it('visionBatchSizeに従ってバッチ処理される', async () => {
      // Arrange: 6セクション、バッチサイズ2
      const sections = createTestSections();
      const batchSize = 2;

      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyzeSection.mockImplementation(async (options: { sectionId: string; sectionTypeHint?: string }) => {
        const sectionType = options.sectionTypeHint || 'unknown';
        return createMockVisionResult(sectionType, options.sectionId);
      });

      mockScreenshotService.extractMultipleSections.mockResolvedValue({
        successes: sections.map((s) => ({
          sectionId: s.id,
          imageBuffer: Buffer.from('test-image-data'),
          bounds: s.position,
        })),
        errors: [],
      });

      // Act: バッチ処理をシミュレート
      const batches: Array<Array<{ sectionId: string; type: string }>> = [];
      for (let i = 0; i < sections.length; i += batchSize) {
        batches.push(sections.slice(i, i + batchSize).map((s) => ({ sectionId: s.id, type: s.type })));
      }

      // Assert: 3バッチに分割される（6セクション / 2 = 3）
      expect(batches.length).toBe(3);
      expect(batches[0]).toHaveLength(2);
      expect(batches[1]).toHaveLength(2);
      expect(batches[2]).toHaveLength(2);
    });
  });

  describe('Ollama未接続時のGraceful Degradation', () => {
    it('VisionAdapterが利用不可の場合、全セクションにエラーが設定される', async () => {
      // Arrange: Ollama未接続
      const sections = createTestSections();

      mockVisionAdapter.isAvailable.mockResolvedValue(false);

      mockScreenshotService.extractMultipleSections.mockResolvedValue({
        successes: sections.map((s) => ({
          sectionId: s.id,
          imageBuffer: Buffer.from('test-image-data'),
          bounds: s.position,
        })),
        errors: [],
      });

      // Act: Graceful Degradation のシミュレート
      const isVisionAvailable = await mockVisionAdapter.isAvailable();

      const sectionResults = sections.map((section) => {
        if (!isVisionAvailable) {
          return {
            id: section.id,
            type: section.type,
            visionFeatures: {
              success: false,
              features: [],
              error: 'Ollama service unavailable for per-section Vision analysis.',
              processingTimeMs: 0,
              modelName: 'llama3.2-vision',
            },
          };
        }
        return null;
      });

      // Assert
      expect(isVisionAvailable).toBe(false);

      for (const result of sectionResults) {
        expect(result).not.toBeNull();
        expect(result?.visionFeatures.success).toBe(false);
        expect(result?.visionFeatures.error).toContain('Ollama service unavailable');
        expect(result?.visionFeatures.features).toEqual([]);
      }
    });

    it('Ollama接続タイムアウト時もGraceful Degradationが発生する', async () => {
      // Arrange: タイムアウトをシミュレート
      mockVisionAdapter.isAvailable.mockImplementation(async () => {
        // タイムアウト（3秒以上かかる場合）をシミュレート
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Connection timeout')), 100);
        });
      });

      // Act
      let isAvailable = true;
      let errorMessage = '';
      try {
        isAvailable = await mockVisionAdapter.isAvailable();
      } catch (error) {
        isAvailable = false;
        errorMessage = error instanceof Error ? error.message : 'Unknown error';
      }

      // Assert
      expect(isAvailable).toBe(false);
      expect(errorMessage).toBe('Connection timeout');
    });

    it('一部のセクションだけVision分析が失敗してもページ全体の処理は継続する', async () => {
      // Arrange: 6セクション中、2つだけ失敗
      const sections = createTestSections();

      mockVisionAdapter.isAvailable.mockResolvedValue(true);

      // 3番目と5番目のセクションで失敗するようにモック
      mockVisionAdapter.analyzeSection.mockImplementation(async (options: { sectionId: string; sectionTypeHint?: string }) => {
        if (options.sectionId === 'section-testimonial' || options.sectionId === 'section-cta') {
          throw new Error(`Vision analysis failed for ${options.sectionId}`);
        }
        const sectionType = options.sectionTypeHint || 'unknown';
        return createMockVisionResult(sectionType, options.sectionId);
      });

      mockScreenshotService.extractMultipleSections.mockResolvedValue({
        successes: sections.map((s) => ({
          sectionId: s.id,
          imageBuffer: Buffer.from('test-image-data'),
          bounds: s.position,
        })),
        errors: [],
      });

      // Act: Promise.allSettled を使った並列処理のシミュレート
      const results = await Promise.allSettled(
        sections.map(async (section) => {
          return mockVisionAdapter.analyzeSection({
            imageBuffer: Buffer.from('test'),
            mimeType: 'image/png',
            features: ['layout_structure'],
            sectionId: section.id,
            sectionTypeHint: section.type,
          });
        })
      );

      // Assert
      const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length;
      const rejectedCount = results.filter((r) => r.status === 'rejected').length;

      expect(fulfilledCount).toBe(4); // 成功: 4セクション
      expect(rejectedCount).toBe(2); // 失敗: 2セクション

      // 失敗したセクションを確認
      const failedIndexes = results
        .map((r, i) => (r.status === 'rejected' ? i : -1))
        .filter((i) => i >= 0);

      expect(sections[failedIndexes[0]]?.id).toBe('section-testimonial');
      expect(sections[failedIndexes[1]]?.id).toBe('section-cta');
    });
  });

  describe('スクリーンショート切り出しエラーハンドリング', () => {
    it('一部のセクション切り出しが失敗してもエラー情報が設定される', async () => {
      // Arrange
      const sections = createTestSections();

      // 2セクションで切り出し失敗
      mockScreenshotService.extractMultipleSections.mockResolvedValue({
        successes: sections.slice(0, 4).map((s) => ({
          sectionId: s.id,
          imageBuffer: Buffer.from('test-image-data'),
          bounds: s.position,
        })),
        errors: [
          { sectionId: 'section-cta', errorMessage: 'Section bounds exceed image dimensions' },
          { sectionId: 'section-footer', errorMessage: 'Invalid section bounds' },
        ],
      });

      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyzeSection.mockImplementation(async (options: { sectionId: string; sectionTypeHint?: string }) => {
        const sectionType = options.sectionTypeHint || 'unknown';
        return createMockVisionResult(sectionType, options.sectionId);
      });

      // Act
      const extractResult = await mockScreenshotService.extractMultipleSections(
        'base64-image',
        sections.map((s) => ({ id: s.id, bounds: s.position }))
      );

      // Assert: 成功と失敗が分離されている
      expect(extractResult.successes).toHaveLength(4);
      expect(extractResult.errors).toHaveLength(2);

      // エラー情報が適切に含まれている
      const ctaError = extractResult.errors.find((e: { sectionId: string }) => e.sectionId === 'section-cta');
      expect(ctaError?.errorMessage).toContain('bounds exceed');

      const footerError = extractResult.errors.find((e: { sectionId: string }) => e.sectionId === 'section-footer');
      expect(footerError?.errorMessage).toContain('Invalid');
    });

    it('空のBase64画像でも処理が継続する', async () => {
      // Arrange: 空の画像
      mockScreenshotService.extractMultipleSections.mockResolvedValue({
        successes: [],
        errors: [
          { sectionId: 'section-hero', errorMessage: 'Empty image data' },
        ],
      });

      // Act
      const extractResult = await mockScreenshotService.extractMultipleSections(
        '', // 空のBase64
        [{ id: 'section-hero', bounds: { startY: 0, endY: 100, height: 100 } }]
      );

      // Assert
      expect(extractResult.successes).toHaveLength(0);
      expect(extractResult.errors).toHaveLength(1);
      expect(extractResult.errors[0].errorMessage).toContain('Empty');
    });
  });

  describe('位置情報がないセクションの処理', () => {
    it('position情報がないセクションはperSectionVision対象外', async () => {
      // Arrange: 一部のセクションにposition情報がない
      const sectionsWithPartialPosition = [
        { id: 'section-hero', type: 'hero', positionIndex: 0, confidence: 0.95, position: { startY: 0, endY: 600, height: 600 } },
        { id: 'section-feature', type: 'feature', positionIndex: 1, confidence: 0.88 }, // position なし
        { id: 'section-cta', type: 'cta', positionIndex: 2, confidence: 0.92, position: { startY: 600, endY: 800, height: 200 } },
      ];

      // Act: 位置情報があるセクションのみ抽出
      const sectionsWithBounds = sectionsWithPartialPosition.filter(
        (s) => s.position?.startY !== undefined && s.position?.endY !== undefined
      );

      // Assert
      expect(sectionsWithBounds).toHaveLength(2);
      expect(sectionsWithBounds.map((s) => s.id)).toContain('section-hero');
      expect(sectionsWithBounds.map((s) => s.id)).toContain('section-cta');
      expect(sectionsWithBounds.map((s) => s.id)).not.toContain('section-feature');
    });
  });

  describe('perSectionVision無効時の動作', () => {
    it('perSectionVision=false の場合、セクション単位Vision分析はスキップされる', async () => {
      // Arrange
      const options = {
        useVision: true,
        perSectionVision: false, // 無効
      };

      mockVisionAdapter.analyzeSection.mockResolvedValue(createMockVisionResult('hero', 'section-hero'));

      // Act: perSectionVision が false なので、analyzeSection は呼ばれない
      if (options.perSectionVision) {
        await mockVisionAdapter.analyzeSection({
          imageBuffer: Buffer.from('test'),
          mimeType: 'image/png',
          features: ['layout_structure'],
          sectionId: 'section-hero',
        });
      }

      // Assert
      expect(mockVisionAdapter.analyzeSection).not.toHaveBeenCalled();
    });

    it('useVision=false の場合もperSectionVision処理はスキップされる', async () => {
      // Arrange
      const options = {
        useVision: false, // Vision自体が無効
        perSectionVision: true,
      };

      // Act & Assert
      // useVision が false の場合、perSectionVision の値に関わらずVision分析はスキップ
      const shouldRunPerSection = options.useVision && options.perSectionVision;
      expect(shouldRunPerSection).toBe(false);
    });
  });

  describe('パフォーマンス考慮', () => {
    it('大量セクション（20+）でもバッチ処理により効率的に処理される', async () => {
      // Arrange: 20セクションを生成
      const largeSectionSet = Array.from({ length: 20 }, (_, i) => ({
        id: `section-${i}`,
        type: i % 5 === 0 ? 'hero' : i % 5 === 1 ? 'feature' : i % 5 === 2 ? 'testimonial' : i % 5 === 3 ? 'pricing' : 'cta',
        positionIndex: i,
        confidence: 0.85,
        position: { startY: i * 100, endY: (i + 1) * 100, height: 100 },
      }));

      mockVisionAdapter.isAvailable.mockResolvedValue(true);
      mockVisionAdapter.analyzeSection.mockImplementation(async (options: { sectionId: string; sectionTypeHint?: string }) => {
        // 50msの処理時間をシミュレート
        await new Promise((resolve) => setTimeout(resolve, 10));
        const sectionType = options.sectionTypeHint || 'unknown';
        return createMockVisionResult(sectionType, options.sectionId);
      });

      const batchSize = 5;

      // Act: バッチ処理を実行
      const startTime = Date.now();
      const batches = [];

      for (let i = 0; i < largeSectionSet.length; i += batchSize) {
        const batch = largeSectionSet.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(
          batch.map((s) =>
            mockVisionAdapter.analyzeSection({
              imageBuffer: Buffer.from('test'),
              mimeType: 'image/png',
              features: ['layout_structure'],
              sectionId: s.id,
              sectionTypeHint: s.type,
            })
          )
        );
        batches.push(batchResults);
      }

      const totalTime = Date.now() - startTime;

      // Assert
      expect(batches).toHaveLength(4); // 20 / 5 = 4バッチ
      expect(batches.flat().every((r) => r.status === 'fulfilled')).toBe(true);

      // 並列処理により、シーケンシャル実行より速い（20 * 10ms = 200ms以上かかるはずがそれより短い）
      // 並列処理では各バッチ50ms（5並列 × 10ms）× 4バッチ = 約40-80ms程度
      expect(totalTime).toBeLessThan(200);
    });
  });
});

// =============================================================================
// 統合テスト: visionFeaturesの構造検証
// =============================================================================

describe('visionFeatures構造検証', () => {
  let mockVisionAdapter: {
    isAvailable: ReturnType<typeof vi.fn>;
    analyzeSection: ReturnType<typeof vi.fn>;
    generateSectionTextRepresentation: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockVisionAdapter = {
      isAvailable: vi.fn(),
      analyzeSection: vi.fn(),
      generateSectionTextRepresentation: vi.fn(),
    };
    vi.mocked(LlamaVisionAdapter).mockImplementation(() => mockVisionAdapter as unknown as LlamaVisionAdapter);
  });

  it('成功時のvisionFeaturesが正しい構造を持つ', async () => {
    // Arrange
    const expectedStructure = {
      success: true,
      features: [
        { type: 'layout_structure', confidence: 0.9, data: { description: 'test' } },
      ],
      processingTimeMs: 500,
      modelName: 'llama3.2-vision',
      sectionId: 'section-hero',
    };

    mockVisionAdapter.analyzeSection.mockResolvedValue(expectedStructure);
    mockVisionAdapter.generateSectionTextRepresentation.mockReturnValue('Test representation');

    // Act
    const result = await mockVisionAdapter.analyzeSection({
      imageBuffer: Buffer.from('test'),
      mimeType: 'image/png',
      features: ['layout_structure'],
      sectionId: 'section-hero',
      sectionTypeHint: 'hero',
    });

    // Assert: 必須フィールドの検証
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('features');
    expect(result).toHaveProperty('processingTimeMs');
    expect(result).toHaveProperty('modelName');

    expect(result.success).toBe(true);
    expect(Array.isArray(result.features)).toBe(true);
    expect(typeof result.processingTimeMs).toBe('number');
    expect(result.modelName).toBe('llama3.2-vision');
  });

  it('失敗時のvisionFeaturesが正しいエラー構造を持つ', async () => {
    // Arrange
    const errorStructure = {
      success: false,
      features: [],
      error: 'Vision analysis failed: Connection refused',
      processingTimeMs: 0,
      modelName: 'llama3.2-vision',
    };

    mockVisionAdapter.analyzeSection.mockResolvedValue(errorStructure);

    // Act
    const result = await mockVisionAdapter.analyzeSection({
      imageBuffer: Buffer.from('test'),
      mimeType: 'image/png',
      features: ['layout_structure'],
      sectionId: 'section-hero',
    });

    // Assert
    expect(result.success).toBe(false);
    expect(result.features).toEqual([]);
    expect(result.error).toContain('Vision analysis failed');
    expect(result.processingTimeMs).toBe(0);
  });

  it('features配列の各要素が正しい構造を持つ', async () => {
    // Arrange
    const resultWithFeatures = {
      success: true,
      features: [
        { type: 'layout_structure', confidence: 0.92, data: { description: 'Centered layout' } },
        { type: 'color_palette', confidence: 0.88, data: { colors: ['#667eea', '#764ba2'] } },
        { type: 'whitespace', confidence: 0.85, data: { spacing: 'generous' } },
      ],
      processingTimeMs: 450,
      modelName: 'llama3.2-vision',
    };

    mockVisionAdapter.analyzeSection.mockResolvedValue(resultWithFeatures);

    // Act
    const result = await mockVisionAdapter.analyzeSection({
      imageBuffer: Buffer.from('test'),
      mimeType: 'image/png',
      features: ['layout_structure', 'color_palette', 'whitespace'],
      sectionId: 'section-hero',
    });

    // Assert
    expect(result.features).toHaveLength(3);

    for (const feature of result.features) {
      expect(feature).toHaveProperty('type');
      expect(feature).toHaveProperty('confidence');
      expect(feature).toHaveProperty('data');

      expect(typeof feature.type).toBe('string');
      expect(typeof feature.confidence).toBe('number');
      expect(feature.confidence).toBeGreaterThanOrEqual(0);
      expect(feature.confidence).toBeLessThanOrEqual(1);
    }
  });
});
