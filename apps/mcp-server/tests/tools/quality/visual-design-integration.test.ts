// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visual Design Integration Test
 *
 * quality.evaluate ツールの統合テスト。
 *
 * 現状: VisualDesignAnalyzer / ContentGapDetector は handler に未統合のため、
 * visualDesign / contentGaps フィールドはレスポンスに含まれない。
 * enableVisualDesign フラグは handler に影響を与えない。
 *
 * テスト対象:
 * - enableVisualDesign の有無に関わらず従来の3軸スコアが正常に返ること
 * - visualDesign / contentGaps が未実装のためレスポンスに含まれないこと
 * - summary mode の基本動作
 * - DIファクトリ差し替えの基本動作
 * - 回帰テスト（overall / 3軸スコア / grade）
 *
 * @module tests/tools/quality/visual-design-integration.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  qualityEvaluateHandler,
  setQualityEvaluateServiceFactory,
  resetQualityEvaluateServiceFactory,
  resetAxeAccessibilityServiceFactory,
  resetPatternMatcherServiceFactory,
  resetBenchmarkServiceFactory,
  resetPlaywrightAxeServiceFactory,
} from '../../../src/tools/quality/evaluate.tool';

import {
  setVisualDesignAnalyzerServiceFactory,
  resetVisualDesignAnalyzerServiceFactory,
} from '../../../src/services/quality/visual-design-analyzer.service';

import {
  setContentGapDetectorServiceFactory,
  resetContentGapDetectorServiceFactory,
} from '../../../src/services/quality/content-gap-detector.service';

import type { QualityEvaluateData } from '../../../src/tools/quality/schemas';

// =============================================================================
// テスト用HTML定義
// =============================================================================

/** 画像なし・装飾なしの最小HTML */
const MINIMAL_HTML = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Minimal</title></head>
<body>
  <header role="banner"><nav role="navigation">Nav</nav></header>
  <main role="main">
    <section><h1>Title</h1><p>Text only content, no images or visual elements.</p></section>
    <section><h2>Features</h2><p>No visual content at all.</p></section>
  </main>
  <footer role="contentinfo"><p>Footer</p></footer>
</body>
</html>
`;

/** リッチなHTML（画像、SVG、アイコン、多彩なCSS） */
const RICH_HTML = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rich Design</title>
  <style>
    :root {
      --primary: #2C5F2D;
      --secondary: #97BC62;
      --accent: #FFB347;
      --text: #333;
      --bg: #FAF9F6;
    }
    h1 { font-size: 48px; font-weight: 800; line-height: 1.2; }
    h2 { font-size: 32px; font-weight: 600; line-height: 1.3; }
    p { font-size: 16px; font-weight: 400; line-height: 1.6; }
    .hero {
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      padding: clamp(2rem, 5vw, 6rem) var(--side-pad, 40px);
    }
    .card {
      box-shadow: 0 4px 24px rgba(0,0,0,0.1);
      transform: translateY(0);
      backdrop-filter: blur(4px);
    }
    .accent { text-shadow: 0 2px 4px rgba(0,0,0,0.3); }
    section { padding: var(--section-gap, 80px) 0; margin: 32px auto; }
    .cta { background-color: var(--accent); color: var(--text); }
    .bg-image { background-image: url('texture.png'); }
    @media (max-width: 768px) { .hero { padding: 2rem; } }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
    .flex { display: flex; }
    ::before { content: ""; position: absolute; background: var(--accent); }
  </style>
</head>
<body>
  <header role="banner">
    <nav role="navigation" aria-label="Main navigation">
      <a href="/">Home</a>
      <a href="/about">About</a>
    </nav>
  </header>
  <main role="main">
    <section class="hero" aria-labelledby="hero-title">
      <h1 id="hero-title">Premium Design</h1>
      <p>High quality content with rich visual elements.</p>
      <img src="hero.jpg" alt="Hero image showing product" />
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>
      <button type="button">Learn More</button>
    </section>
    <section class="features">
      <h2>Features</h2>
      <div class="grid">
        <div class="card">
          <img src="feature1.jpg" alt="Feature 1" />
          <i class="fa-star"></i>
          <h3>Feature One</h3>
        </div>
        <div class="card">
          <img src="feature2.jpg" alt="Feature 2" />
          <i class="fa-check"></i>
          <h3>Feature Two</h3>
        </div>
      </div>
    </section>
    <section>
      <h2>About</h2>
      <img src="team.jpg" alt="Team photo" />
      <video src="intro.mp4"></video>
    </section>
  </main>
  <footer role="contentinfo"><p>&copy; 2024</p></footer>
</body>
</html>
`;

// =============================================================================
// ヘルパー関数
// =============================================================================

/**
 * テスト結果からdataを安全に取得
 */
function extractData(result: Awaited<ReturnType<typeof qualityEvaluateHandler>>): QualityEvaluateData {
  expect(result.success).toBe(true);
  expect('data' in result && result.data).toBeTruthy();
  return (result as { success: true; data: QualityEvaluateData }).data;
}

// =============================================================================
// テスト本体
// =============================================================================

describe('quality.evaluate visual design integration', () => {
  beforeEach(() => {
    // 全てのDIファクトリをリセットしてデフォルト動作に戻す
    resetQualityEvaluateServiceFactory();
    resetAxeAccessibilityServiceFactory();
    resetPatternMatcherServiceFactory();
    resetBenchmarkServiceFactory();
    resetPlaywrightAxeServiceFactory();
    resetVisualDesignAnalyzerServiceFactory();
    resetContentGapDetectorServiceFactory();
  });

  afterEach(() => {
    resetQualityEvaluateServiceFactory();
    resetAxeAccessibilityServiceFactory();
    resetPatternMatcherServiceFactory();
    resetBenchmarkServiceFactory();
    resetPlaywrightAxeServiceFactory();
    resetVisualDesignAnalyzerServiceFactory();
    resetContentGapDetectorServiceFactory();
  });

  // =========================================================================
  // visualDesign / contentGaps は handler 未統合のため undefined
  // =========================================================================

  describe('visualDesign / contentGaps 未統合確認', () => {
    it('デフォルト設定でvisualDesignがレスポンスに含まれないこと', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: RICH_HTML,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert: handler未統合のためvisualDesignは含まれない
      const data = extractData(result);
      expect(data.visualDesign).toBeUndefined();
    });

    it('デフォルト設定でcontentGapsがレスポンスに含まれないこと', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: RICH_HTML,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert: handler未統合のためcontentGapsは含まれない
      const data = extractData(result);
      expect(data.contentGaps).toBeUndefined();
    });

    it('enableVisualDesign: trueを指定してもvisualDesignは含まれないこと', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: RICH_HTML,
        enableVisualDesign: true,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert: handler未統合のため enableVisualDesign は無視される
      const data = extractData(result);
      expect(data.visualDesign).toBeUndefined();
      expect(data.contentGaps).toBeUndefined();
    });
  });

  // =========================================================================
  // enableVisualDesign: false（後方互換性）
  // =========================================================================

  describe('enableVisualDesign: false（回帰テスト）', () => {
    it('visualDesign結果がレスポンスに含まれないこと', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: RICH_HTML,
        enableVisualDesign: false,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert
      const data = extractData(result);
      expect(data.visualDesign).toBeUndefined();
      expect(data.contentGaps).toBeUndefined();
    });

    it('従来の3軸スコアが正常に返ること', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: RICH_HTML,
        enableVisualDesign: false,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert
      const data = extractData(result);
      expect(data.overall).toBeGreaterThan(0);
      expect(data.originality).toBeDefined();
      expect(data.craftsmanship).toBeDefined();
      expect(data.contextuality).toBeDefined();
      expect(data.grade).toBeDefined();
    });

    it('enableVisualDesignの有無でcraftsmanshipスコアが同一であること（handler未統合のため）', async () => {
      // Arrange & Act
      const resultWithVD = await qualityEvaluateHandler({
        html: RICH_HTML,
        enableVisualDesign: true,
        summary: false,
        patternComparison: { enabled: false },
      });
      const resultWithoutVD = await qualityEvaluateHandler({
        html: RICH_HTML,
        enableVisualDesign: false,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert: handler未統合のため enableVisualDesign は無視される → スコア同一
      const dataWith = extractData(resultWithVD);
      const dataWithout = extractData(resultWithoutVD);
      expect(dataWith.craftsmanship.score).toBe(dataWithout.craftsmanship.score);
    });
  });

  // =========================================================================
  // 画像0枚ページ → 基本的な評価動作
  // =========================================================================

  describe('画像0枚ページの評価', () => {
    it('画像0枚でもcontentGapsは含まれないこと（handler未統合）', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: MINIMAL_HTML,
        enableVisualDesign: true,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert: handler未統合のため常にundefined
      const data = extractData(result);
      expect(data.contentGaps).toBeUndefined();
    });

    it('画像0枚でもcraftsmanshipスコアが返ること', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: MINIMAL_HTML,
        enableVisualDesign: true,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert
      const data = extractData(result);
      expect(data.craftsmanship.score).toBeGreaterThanOrEqual(0);
      expect(data.craftsmanship.score).toBeLessThanOrEqual(100);
    });

    it('画像0枚でもvisualDesignは含まれないこと（handler未統合）', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: MINIMAL_HTML,
        enableVisualDesign: true,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert: handler未統合のため常にundefined
      const data = extractData(result);
      expect(data.visualDesign).toBeUndefined();
    });
  });

  // =========================================================================
  // リッチHTML → 基本的な評価動作
  // =========================================================================

  describe('リッチHTMLの評価', () => {
    it('リッチHTMLで3軸スコアが返ること', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: RICH_HTML,
        enableVisualDesign: true,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert
      const data = extractData(result);
      expect(data.overall).toBeGreaterThan(0);
      expect(data.originality.score).toBeGreaterThanOrEqual(0);
      expect(data.craftsmanship.score).toBeGreaterThanOrEqual(0);
      expect(data.contextuality.score).toBeGreaterThanOrEqual(0);
    });

    it('リッチHTMLのcraftsmanship detailsが返ること', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: RICH_HTML,
        enableVisualDesign: true,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert
      const data = extractData(result);
      expect(data.craftsmanship.details).toBeDefined();
    });

    it('リッチHTMLでoverallが正の値であること', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: RICH_HTML,
        enableVisualDesign: true,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert
      const data = extractData(result);
      expect(data.overall).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // summary mode
  // =========================================================================

  describe('summary mode', () => {
    it('summary: trueでvisualDesignは含まれないこと（handler未統合）', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: RICH_HTML,
        enableVisualDesign: true,
        summary: true,
        patternComparison: { enabled: false },
      });

      // Assert: handler未統合のためvisualDesign/contentGapsは常にundefined
      const data = extractData(result);
      expect(data.visualDesign).toBeUndefined();
    });

    it('summary: trueでcontentGapsは含まれないこと（handler未統合）', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: RICH_HTML,
        enableVisualDesign: true,
        summary: true,
        patternComparison: { enabled: false },
      });

      // Assert: handler未統合のためcontentGapsは常にundefined
      const data = extractData(result);
      expect(data.contentGaps).toBeUndefined();
    });

    it('summary: trueでも3軸スコアが返ること', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: MINIMAL_HTML,
        enableVisualDesign: true,
        summary: true,
        patternComparison: { enabled: false },
      });

      // Assert
      const data = extractData(result);
      expect(data.overall).toBeGreaterThanOrEqual(0);
      expect(data.overall).toBeLessThanOrEqual(100);
      expect(data.grade).toBeDefined();
    });

    it('summary: falseで3軸スコアとdetailsが返ること', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: RICH_HTML,
        enableVisualDesign: true,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert
      const data = extractData(result);
      expect(data.originality.details).toBeDefined();
      expect(data.craftsmanship.details).toBeDefined();
      expect(data.contextuality.details).toBeDefined();
    });
  });

  // =========================================================================
  // DIファクトリ差し替え
  // =========================================================================

  describe('DIファクトリによるモック差し替え', () => {
    it('VisualDesignAnalyzerをモックに差し替えてもhandler未統合のためvisualDesignはundefined', async () => {
      // Arrange: 高スコアを返すモックに差し替え
      setVisualDesignAnalyzerServiceFactory(() => ({
        analyze: () => ({
          visualDensity: 90,
          typographyContrast: 90,
          colorVariety: 90,
          whitespaceIntentionality: 90,
          visualDepth: 90,
          overall: 90,
          details: ['mock visual design'],
        }),
      }));

      // Act
      const result = await qualityEvaluateHandler({
        html: MINIMAL_HTML,
        enableVisualDesign: true,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert: handler未統合のためvisualDesignは含まれない
      const data = extractData(result);
      expect(data.visualDesign).toBeUndefined();
      // 基本スコアは正常に返る
      expect(data.overall).toBeGreaterThanOrEqual(0);
      expect(data.craftsmanship.score).toBeGreaterThanOrEqual(0);
    });

    it('ContentGapDetectorをモックに差し替えてもhandler未統合のためcontentGapsはundefined', async () => {
      // Arrange: ギャップなしの結果を返すモックに差し替え
      setContentGapDetectorServiceFactory(() => ({
        detect: () => ({
          totalImages: 10,
          totalSvgs: 5,
          totalIcons: 5,
          totalVideos: 2,
          totalBackgroundImages: 3,
          sectionCount: 3,
          contentDensity: 8.33,
          gaps: [],
          score: 100,
          details: ['mock content gap'],
        }),
      }));

      // Act
      const result = await qualityEvaluateHandler({
        html: MINIMAL_HTML,
        enableVisualDesign: true,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert: handler未統合のためcontentGapsは含まれない
      const data = extractData(result);
      expect(data.contentGaps).toBeUndefined();
      // 基本スコアは正常に返る
      expect(data.overall).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // 回帰テスト: 全体のoverallスコアの妥当性
  // =========================================================================

  describe('回帰テスト', () => {
    it('overall スコアが0-100の範囲内であること', async () => {
      // Arrange & Act
      const results = await Promise.all([
        qualityEvaluateHandler({
          html: MINIMAL_HTML,
          patternComparison: { enabled: false },
        }),
        qualityEvaluateHandler({
          html: RICH_HTML,
          patternComparison: { enabled: false },
        }),
        qualityEvaluateHandler({
          html: MINIMAL_HTML,
          enableVisualDesign: false,
          patternComparison: { enabled: false },
        }),
      ]);

      // Assert
      for (const result of results) {
        const data = extractData(result);
        expect(data.overall).toBeGreaterThanOrEqual(0);
        expect(data.overall).toBeLessThanOrEqual(100);
      }
    });

    it('3軸スコアが全て0-100の範囲内であること', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: RICH_HTML,
        enableVisualDesign: true,
        summary: false,
        patternComparison: { enabled: false },
      });

      // Assert
      const data = extractData(result);
      expect(data.originality.score).toBeGreaterThanOrEqual(0);
      expect(data.originality.score).toBeLessThanOrEqual(100);
      expect(data.craftsmanship.score).toBeGreaterThanOrEqual(0);
      expect(data.craftsmanship.score).toBeLessThanOrEqual(100);
      expect(data.contextuality.score).toBeGreaterThanOrEqual(0);
      expect(data.contextuality.score).toBeLessThanOrEqual(100);
    });

    it('gradeが有効な値であること', async () => {
      // Arrange & Act
      const result = await qualityEvaluateHandler({
        html: RICH_HTML,
        patternComparison: { enabled: false },
      });

      // Assert
      const data = extractData(result);
      const validGrades = ['S', 'A', 'B', 'C', 'D', 'F'];
      expect(validGrades).toContain(data.grade);
    });
  });
});
