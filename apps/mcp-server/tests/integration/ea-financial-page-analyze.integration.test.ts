// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * E&A Financial page.analyze Integration Test
 *
 * TDD: Red Phase - 統合テストを先に作成
 *
 * 問題背景:
 * - E&A Financial サイト (https://ea.madebybuzzworthy.com/) の page.analyze 結果で
 *   テーマが "Light/Mixed" と誤認識された
 *
 * 修正内容:
 * 1. Computed Styles retrieval via Playwright (JavaScript-rendered styles)
 * 2. Pixel-based theme detection with WCAG 2.1 luminance calculation
 * 3. Visual decoration detection (Glow, Gradient, Animated Border, Glass Morphism)
 * 4. Vision AI prompt optimization
 *
 * この統合テストでは:
 * - page.analyze 全体のフロー
 * - visualFeatures.theme の検出
 * - visualFeatures.colors の抽出
 * - Visual decoration の検出
 *
 * @module tests/integration/ea-financial-page-analyze.integration
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';

// サービスのインポート
import { getLayoutAnalyzerService } from '../../src/services/page/layout-analyzer.service';
import type { LayoutAnalyzerService } from '../../src/services/page/layout-analyzer.service';

import {
  createPixelThemeDetectorService,
  DARK_THRESHOLD,
} from '../../src/services/visual-extractor/pixel-theme-detector.service';

import { visualDecorationDetector } from '../../src/services/visual-extractor/visual-decoration-detector.service';
import type { VisualDecorationDetectorService } from '../../src/services/visual-extractor/visual-decoration-detector.service';

// =====================================================
// E&A Financial スタイルのテストフィクスチャ
// =====================================================

/**
 * E&A Financial サイトの期待値
 */
const _EA_FINANCIAL_EXPECTED = {
  url: 'https://ea.madebybuzzworthy.com/',
  backgroundColor: '#0A1628',
  theme: 'dark' as const,
  maxLuminance: 0.3,
};

/**
 * E&A Financial のダークブルー色をRGBに変換
 */
const EA_DARK_BLUE_RGB = { r: 10, g: 22, b: 40 };

/**
 * E&A Financial スタイルのHTML
 * - ダークネイビーブルー背景 (#0A1628)
 * - Glow エフェクト
 * - Gradient 背景
 * - Glass morphism カード
 */
const EA_FINANCIAL_STYLE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>E&A Financial Style Test Page</title>
  <style>
    :root {
      --bg-primary: #0A1628;
      --bg-secondary: #0D1C32;
      --accent-blue: #0066FF;
      --accent-cyan: #00D4FF;
      --text-primary: #FFFFFF;
      --text-secondary: rgba(255, 255, 255, 0.7);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      background-color: var(--bg-primary);
      color: var(--text-primary);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      min-height: 100vh;
    }

    /* Header with subtle gradient */
    header {
      background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-primary) 100%);
      padding: 20px 40px;
      position: fixed;
      width: 100%;
      top: 0;
      z-index: 100;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }

    /* Hero section with glow effects */
    .hero {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      padding: 120px 20px 80px;
      background:
        radial-gradient(ellipse at 20% 50%, rgba(0, 102, 255, 0.15) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 50%, rgba(0, 212, 255, 0.1) 0%, transparent 50%),
        var(--bg-primary);
    }

    .hero h1 {
      font-size: clamp(2.5rem, 5vw, 4rem);
      font-weight: 700;
      margin-bottom: 24px;
      background: linear-gradient(135deg, #FFFFFF 0%, #00D4FF 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .hero p {
      font-size: clamp(1rem, 2vw, 1.25rem);
      color: var(--text-secondary);
      max-width: 600px;
      margin-bottom: 40px;
    }

    /* CTA Button with glow */
    .cta-button {
      background: linear-gradient(135deg, var(--accent-blue) 0%, var(--accent-cyan) 100%);
      color: white;
      padding: 16px 32px;
      border: none;
      border-radius: 12px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      box-shadow:
        0 0 20px rgba(0, 102, 255, 0.4),
        0 0 40px rgba(0, 212, 255, 0.2);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .cta-button:hover {
      transform: translateY(-2px);
      box-shadow:
        0 0 30px rgba(0, 102, 255, 0.6),
        0 0 60px rgba(0, 212, 255, 0.3);
    }

    /* Glass morphism card */
    .glass-card {
      background: rgba(13, 28, 50, 0.6);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 32px;
      margin: 20px;
    }

    /* Features section */
    .features {
      padding: 80px 20px;
      background: var(--bg-primary);
    }

    .features h2 {
      text-align: center;
      font-size: 2rem;
      margin-bottom: 60px;
    }

    .feature-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
      max-width: 1200px;
      margin: 0 auto;
    }

    .feature-card {
      background: rgba(13, 28, 50, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 12px;
      padding: 24px;
      transition: border-color 0.3s ease, box-shadow 0.3s ease;
    }

    .feature-card:hover {
      border-color: rgba(0, 102, 255, 0.3);
      box-shadow: 0 0 20px rgba(0, 102, 255, 0.1);
    }

    /* Animated border effect */
    @keyframes borderGlow {
      0% { border-color: rgba(0, 102, 255, 0.3); }
      50% { border-color: rgba(0, 212, 255, 0.5); }
      100% { border-color: rgba(0, 102, 255, 0.3); }
    }

    .animated-border {
      border: 2px solid rgba(0, 102, 255, 0.3);
      animation: borderGlow 3s ease-in-out infinite;
    }

    /* Footer */
    footer {
      background: var(--bg-secondary);
      padding: 40px 20px;
      text-align: center;
      color: var(--text-secondary);
    }
  </style>
</head>
<body>
  <header>
    <nav>
      <a href="/" class="logo">E&A Financial</a>
    </nav>
  </header>

  <main>
    <section class="hero">
      <h1>Strategic Financial Solutions</h1>
      <p>Empowering your business with data-driven financial strategies and innovative solutions.</p>
      <button class="cta-button">Get Started</button>
    </section>

    <section class="features">
      <h2>Our Services</h2>
      <div class="feature-grid">
        <div class="feature-card glass-card">
          <h3>Financial Analysis</h3>
          <p>Comprehensive analysis of your financial health and growth potential.</p>
        </div>
        <div class="feature-card animated-border">
          <h3>Investment Strategy</h3>
          <p>Custom investment strategies tailored to your risk profile and goals.</p>
        </div>
        <div class="feature-card">
          <h3>Risk Management</h3>
          <p>Proactive risk assessment and mitigation strategies for sustainable growth.</p>
        </div>
      </div>
    </section>
  </main>

  <footer>
    <p>&copy; 2026 E&A Financial. All rights reserved.</p>
  </footer>
</body>
</html>
`;

/**
 * E&A Financial スタイルの Computed Styles
 * (Playwright が返すであろうスタイル情報をシミュレート)
 */
const EA_FINANCIAL_COMPUTED_STYLES = [
  {
    selector: 'body',
    backgroundColor: 'rgb(10, 22, 40)', // #0A1628
    color: 'rgb(255, 255, 255)',
  },
  {
    selector: '.hero',
    backgroundColor: 'rgba(0, 0, 0, 0)', // transparent, gradient で表示
    backgroundImage: 'radial-gradient(ellipse at 20% 50%, rgba(0, 102, 255, 0.15) 0%, transparent 50%)',
  },
  {
    selector: 'header',
    backgroundColor: 'rgba(13, 28, 50, 0.8)',
    backdropFilter: 'blur(10px)',
  },
  {
    selector: '.cta-button',
    backgroundColor: 'rgb(0, 102, 255)',
    boxShadow: '0 0 20px rgba(0, 102, 255, 0.4), 0 0 40px rgba(0, 212, 255, 0.2)',
  },
  {
    selector: '.glass-card',
    backgroundColor: 'rgba(13, 28, 50, 0.6)',
    backdropFilter: 'blur(20px)',
  },
];

// =====================================================
// テストユーティリティ
// =====================================================

/**
 * E&A Financial 風のスクリーンショットを生成
 */
async function createEAFinancialScreenshot(
  width: number = 1920,
  height: number = 1080
): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);

  // 背景色の分布（リアルなページレイアウト）
  const bgPrimary = EA_DARK_BLUE_RGB;
  const bgSecondary = { r: 13, g: 28, b: 50 }; // #0D1C32
  const headerHeight = 80;
  const footerHeight = 100;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;

      let color: { r: number; g: number; b: number };

      if (y < headerHeight) {
        // ヘッダー領域（わずかに明るい）
        color = bgSecondary;
      } else if (y > height - footerHeight) {
        // フッター領域
        color = bgSecondary;
      } else {
        // メインコンテンツ領域
        color = bgPrimary;
      }

      pixels[offset] = color.r;
      pixels[offset + 1] = color.g;
      pixels[offset + 2] = color.b;
    }
  }

  return sharp(pixels, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();
}

// =====================================================
// テストスイート
// =====================================================

describe('E&A Financial page.analyze Integration', () => {
  let layoutAnalyzer: LayoutAnalyzerService;
  let pixelDetector: ReturnType<typeof createPixelThemeDetectorService>;
  let decorationDetector: VisualDecorationDetectorService;

  beforeAll(() => {
    layoutAnalyzer = getLayoutAnalyzerService();
    pixelDetector = createPixelThemeDetectorService();
    // シングルトンインスタンスを使用
    decorationDetector = visualDecorationDetector;
  });

  // -------------------------------------------------
  // 1. HTML解析によるレイアウト検出
  // -------------------------------------------------

  describe('1. LayoutAnalyzerService - HTML Analysis', () => {
    it('should detect sections from E&A Financial style HTML', async () => {
      const result = await layoutAnalyzer.analyze(EA_FINANCIAL_STYLE_HTML);

      // セクションが検出されること
      expect(result.sections.length).toBeGreaterThan(0);
    });

    it('should detect hero section', async () => {
      const result = await layoutAnalyzer.analyze(EA_FINANCIAL_STYLE_HTML);

      // hero セクションが検出されること
      const heroSection = result.sections.find(
        (s) => s.type === 'hero' || s.className?.includes('hero')
      );
      expect(heroSection).toBeDefined();
    });

    it('should detect features section', async () => {
      const result = await layoutAnalyzer.analyze(EA_FINANCIAL_STYLE_HTML);

      // features セクションが検出されること
      const featuresSection = result.sections.find(
        (s) => s.type === 'feature' || s.className?.includes('features')
      );
      expect(featuresSection).toBeDefined();
    });
  });

  // -------------------------------------------------
  // 2. CSS解析によるスタイル検出
  // -------------------------------------------------

  describe('2. CSS Analysis - Style Detection', () => {
    it('should extract CSS from E&A Financial HTML', async () => {
      const result = await layoutAnalyzer.analyze(EA_FINANCIAL_STYLE_HTML);

      // CSS が抽出されること
      expect(result.cssSnippet).toBeDefined();
      expect(result.cssSnippet!.length).toBeGreaterThan(0);
    });

    it('should detect dark background color in CSS variables', async () => {
      const result = await layoutAnalyzer.analyze(EA_FINANCIAL_STYLE_HTML);

      // CSS に #0A1628 が含まれること
      expect(result.cssSnippet).toContain('#0A1628');
    });

    it('should detect gradient backgrounds', async () => {
      const result = await layoutAnalyzer.analyze(EA_FINANCIAL_STYLE_HTML);

      // CSS に gradient が含まれること
      expect(result.cssSnippet).toMatch(/linear-gradient|radial-gradient/);
    });

    it('should detect backdrop-filter (glass morphism)', async () => {
      const result = await layoutAnalyzer.analyze(EA_FINANCIAL_STYLE_HTML);

      // CSS に backdrop-filter が含まれること
      expect(result.cssSnippet).toMatch(/backdrop-filter/);
    });

    it('should detect box-shadow (glow effects)', async () => {
      const result = await layoutAnalyzer.analyze(EA_FINANCIAL_STYLE_HTML);

      // CSS に box-shadow が含まれること
      expect(result.cssSnippet).toMatch(/box-shadow/);
    });
  });

  // -------------------------------------------------
  // 3. ピクセルベーステーマ検出との統合
  // -------------------------------------------------

  describe('3. Pixel Theme Detection Integration', () => {
    it('should detect dark theme from E&A Financial screenshot', async () => {
      const screenshot = await createEAFinancialScreenshot();

      const result = await pixelDetector.detectTheme(screenshot);

      expect(result.theme).toBe('dark');
      expect(result.averageLuminance).toBeLessThan(DARK_THRESHOLD);
    });

    it('should integrate pixel detection with layout analysis', async () => {
      // Layout analysis
      const layoutResult = await layoutAnalyzer.analyze(EA_FINANCIAL_STYLE_HTML);

      // Pixel theme detection
      const screenshot = await createEAFinancialScreenshot();
      const themeResult = await pixelDetector.detectTheme(screenshot);

      // 統合結果の検証
      expect(layoutResult.sections.length).toBeGreaterThan(0);
      expect(themeResult.theme).toBe('dark');

      // 両方の結果が一貫していること
      // (レイアウト解析の CSS にダーク色が含まれ、ピクセル解析もダークと判定)
      expect(layoutResult.cssSnippet).toContain('#0A1628');
    });
  });

  // -------------------------------------------------
  // 4. Visual Decoration Detection との統合
  // -------------------------------------------------

  describe('4. Visual Decoration Detection Integration', () => {
    it('should detect glow effects from E&A Financial CSS', () => {
      const result = decorationDetector.detectFromHTML(EA_FINANCIAL_STYLE_HTML);

      expect(result.summary.glowCount).toBeGreaterThan(0);
    });

    it('should detect gradients from E&A Financial CSS', () => {
      const result = decorationDetector.detectFromHTML(EA_FINANCIAL_STYLE_HTML);

      expect(result.summary.gradientCount).toBeGreaterThan(0);
    });

    it('should detect glass morphism from E&A Financial CSS', () => {
      const result = decorationDetector.detectFromHTML(EA_FINANCIAL_STYLE_HTML);

      expect(result.summary.glassMorphismCount).toBeGreaterThan(0);
    });

    it('should detect animated borders from E&A Financial CSS', () => {
      const result = decorationDetector.detectFromHTML(EA_FINANCIAL_STYLE_HTML);

      expect(result.summary.animatedBorderCount).toBeGreaterThan(0);
    });

    it('should return all decoration patterns', () => {
      const result = decorationDetector.detectFromHTML(EA_FINANCIAL_STYLE_HTML);

      // 複数のパターンが検出されること
      expect(result.decorations.length).toBeGreaterThan(0);

      // 各パターンに type と confidence があること
      result.decorations.forEach((decoration) => {
        expect(decoration).toHaveProperty('type');
        expect(decoration).toHaveProperty('confidence');
      });
    });
  });

  // -------------------------------------------------
  // 5. 統合シナリオ: page.analyze フロー全体
  // -------------------------------------------------

  describe('5. Full Integration Scenario', () => {
    it('should complete full analysis flow for E&A Financial style page', async () => {
      // Step 1: Layout Analysis
      const layoutResult = await layoutAnalyzer.analyze(EA_FINANCIAL_STYLE_HTML);
      expect(layoutResult.sections.length).toBeGreaterThan(0);
      expect(layoutResult.cssSnippet).toBeDefined();

      // Step 2: Pixel Theme Detection
      const screenshot = await createEAFinancialScreenshot();
      const themeResult = await pixelDetector.detectTheme(screenshot);
      expect(themeResult.theme).toBe('dark');

      // Step 3: Visual Decoration Detection
      const decorationResult = decorationDetector.detectFromHTML(EA_FINANCIAL_STYLE_HTML);
      expect(decorationResult.summary.glowCount).toBeGreaterThan(0);
      expect(decorationResult.summary.gradientCount).toBeGreaterThan(0);

      // Step 4: Computed Styles (シミュレート)
      const computedBodyBg = EA_FINANCIAL_COMPUTED_STYLES.find((s) => s.selector === 'body');
      expect(computedBodyBg?.backgroundColor).toBe('rgb(10, 22, 40)');

      // Step 5: 最終結果の検証
      // - テーマは dark
      // - 背景色は #0A1628 相当
      // - Glow/Gradient 効果が検出
      expect(themeResult.theme).toBe('dark');
      expect(themeResult.averageLuminance).toBeLessThan(0.3);
      expect(decorationResult.summary.glowCount).toBeGreaterThan(0);
      expect(decorationResult.summary.gradientCount).toBeGreaterThan(0);
      expect(decorationResult.summary.glassMorphismCount).toBeGreaterThan(0);
    });

    it('should never detect E&A Financial as light or mixed theme', async () => {
      // Layout + Theme 統合
      const _layoutResult = await layoutAnalyzer.analyze(EA_FINANCIAL_STYLE_HTML);
      const screenshot = await createEAFinancialScreenshot();
      const themeResult = await pixelDetector.detectTheme(screenshot);

      // 誤認識の防止
      expect(themeResult.theme).not.toBe('light');
      expect(themeResult.theme).not.toBe('mixed');
      expect(themeResult.theme).toBe('dark');
    });
  });

  // -------------------------------------------------
  // 6. エラーハンドリング
  // -------------------------------------------------

  describe('6. Error Handling', () => {
    it('should handle empty HTML gracefully', async () => {
      const result = await layoutAnalyzer.analyze('');

      // 空の結果が返されること（エラーではない）
      expect(result).toBeDefined();
      expect(result.sections).toEqual([]);
    });

    it('should handle malformed HTML', async () => {
      const malformedHtml = '<div><p>Unclosed tags<div>';

      const result = await layoutAnalyzer.analyze(malformedHtml);

      // パースエラーにならずに結果が返されること
      expect(result).toBeDefined();
    });

    it('should handle CSS-only input', async () => {
      const cssOnlyHtml = `
        <style>
          body { background: #0A1628; }
        </style>
      `;

      const result = await layoutAnalyzer.analyze(cssOnlyHtml);

      expect(result).toBeDefined();
      expect(result.cssSnippet).toContain('#0A1628');
    });
  });

  // -------------------------------------------------
  // 7. パフォーマンス要件
  // -------------------------------------------------

  describe('7. Performance Requirements', () => {
    it('should complete layout analysis within 500ms', async () => {
      const startTime = Date.now();
      await layoutAnalyzer.analyze(EA_FINANCIAL_STYLE_HTML);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(500);
    });

    it('should complete pixel detection within 500ms', async () => {
      const screenshot = await createEAFinancialScreenshot();

      const startTime = Date.now();
      await pixelDetector.detectTheme(screenshot);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(500);
    });

    it('should complete decoration detection within 100ms', () => {
      const startTime = Date.now();
      decorationDetector.detectFromHTML(EA_FINANCIAL_STYLE_HTML);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(100);
    });

    it('should complete full integration flow within 2000ms', async () => {
      const startTime = Date.now();

      // Full flow
      await layoutAnalyzer.analyze(EA_FINANCIAL_STYLE_HTML);
      const screenshot = await createEAFinancialScreenshot();
      await pixelDetector.detectTheme(screenshot);
      decorationDetector.detectFromHTML(EA_FINANCIAL_STYLE_HTML);

      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(2000);
    });
  });

  // -------------------------------------------------
  // 8. 回帰テスト: 特定の誤認識シナリオ
  // -------------------------------------------------

  describe('8. Regression: Specific Misdetection Scenarios', () => {
    it('CRITICAL: Dark navy blue (#0A1628) must be detected as dark, not light', async () => {
      const screenshot = await createEAFinancialScreenshot();
      const result = await pixelDetector.detectTheme(screenshot);

      expect(result.theme).toBe('dark');
      expect(result.theme).not.toBe('light');
    });

    it('CRITICAL: Dark navy blue (#0A1628) must be detected as dark, not mixed', async () => {
      const screenshot = await createEAFinancialScreenshot();
      const result = await pixelDetector.detectTheme(screenshot);

      expect(result.theme).toBe('dark');
      expect(result.theme).not.toBe('mixed');
    });

    it('CRITICAL: Luminance must be below 0.3 for E&A Financial colors', async () => {
      const screenshot = await createEAFinancialScreenshot();
      const result = await pixelDetector.detectTheme(screenshot);

      expect(result.averageLuminance).toBeLessThan(0.3);
    });

    it('CRITICAL: All regions must be dark for uniform dark background', async () => {
      const screenshot = await createEAFinancialScreenshot();
      const result = await pixelDetector.detectTheme(screenshot);

      expect(result.analysis.topRegionTheme).toBe('dark');
      expect(result.analysis.middleRegionTheme).toBe('dark');
      expect(result.analysis.bottomRegionTheme).toBe('dark');
    });

    it('CRITICAL: Glow effects must be detected in E&A Financial CSS', () => {
      const result = decorationDetector.detectFromHTML(EA_FINANCIAL_STYLE_HTML);

      expect(result.summary.glowCount).toBeGreaterThan(0);
    });

    it('CRITICAL: Glass morphism must be detected in E&A Financial CSS', () => {
      const result = decorationDetector.detectFromHTML(EA_FINANCIAL_STYLE_HTML);

      expect(result.summary.glassMorphismCount).toBeGreaterThan(0);
    });
  });
});
