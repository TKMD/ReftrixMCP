// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * QualityEvaluatorService テスト
 *
 * page.analyze の品質評価機能を提供するサービスのテスト
 *
 * TDD Red フェーズ: 失敗するテストを先に作成
 *
 * @module tests/services/page/quality-evaluator.service.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  QualityEvaluatorService} from '../../../src/services/page/quality-evaluator.service';
import {
  getQualityEvaluatorService,
  resetQualityEvaluatorService,
  type QualityEvaluatorOptions,
  type QualityEvaluatorResult,
} from '../../../src/services/page/quality-evaluator.service';

// =============================================================================
// テスト用HTML定義
// =============================================================================

/** 基本的なHTML */
const BASIC_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Page</title>
</head>
<body>
  <header role="banner">
    <nav role="navigation" aria-label="Main navigation">
      <a href="/">Home</a>
      <a href="/about">About</a>
    </nav>
  </header>
  <main role="main">
    <h1>Welcome to Our Website</h1>
    <p>This is a sample paragraph with good content.</p>
    <img src="hero.jpg" alt="Hero image showing our product">
  </main>
  <footer role="contentinfo">
    <p>Copyright 2024</p>
  </footer>
</body>
</html>
`;

/** AIクリシェを多く含むHTML */
const AI_CLICHE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Transform Your Business</title>
  <style>
    .hero {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .cta {
      background: linear-gradient(to right, #f857a6, #ff5858);
      border-radius: 9999px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
  </style>
</head>
<body>
  <div class="hero">
    <h1>Transform Your Business with AI-Powered Innovation</h1>
    <p>Unlock the power of cutting-edge solutions for seamless integration.</p>
    <p>Scale effortlessly with our enterprise platform.</p>
    <button class="cta">Get Started Today</button>
  </div>
</body>
</html>
`;

/** セマンティックHTML構造 */
const SEMANTIC_HTML = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Semantic Page</title>
  <style>
    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; }
    }
    @media (max-width: 768px) {
      .container { padding: 1rem; }
    }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); }
    .flex { display: flex; }
    :root {
      --primary-color: #1a73e8;
      --secondary-color: #34a853;
      --accent-color: #fbbc04;
      --text-color: #333;
      --bg-color: #fff;
    }
    .title { font-size: clamp(1.5rem, 4vw, 3rem); color: var(--primary-color); }
    .container { background-color: var(--bg-color); color: var(--text-color); }
    .link { color: var(--secondary-color); }
    .highlight { background-color: var(--accent-color); }
  </style>
</head>
<body>
  <header role="banner" aria-label="Site header">
    <nav role="navigation" aria-labelledby="nav-title">
      <h2 id="nav-title" class="sr-only">Main navigation</h2>
      <a href="/">Home</a>
    </nav>
  </header>
  <main role="main" aria-describedby="main-desc">
    <p id="main-desc" class="sr-only">Main content area</p>
    <section aria-labelledby="section-title">
      <h1 id="section-title" class="title">Welcome</h1>
      <article>
        <h2>Article Title</h2>
        <p>Article content here.</p>
        <img src="image.jpg" alt="Descriptive alt text for the image">
      </article>
    </section>
    <aside aria-label="Sidebar">
      <p>Related content</p>
    </aside>
  </main>
  <footer role="contentinfo">
    <p>Footer content</p>
  </footer>
</body>
</html>
`;

/** アクセシビリティ問題のあるHTML */
const POOR_A11Y_HTML = `
<!DOCTYPE html>
<html>
<head><title>Poor A11y</title></head>
<body>
  <div>
    <div>
      <div onclick="navigate()">Click here</div>
      <img src="hero.jpg">
      <img src="product.jpg">
      <div onclick="submit()">Submit</div>
    </div>
    <div>
      <div>Content 1</div>
      <div>Content 2</div>
      <div>Content 3</div>
      <div onclick="more()">Load more</div>
    </div>
    <div>Extra div 1</div>
    <div>Extra div 2</div>
    <div>Extra div 3</div>
  </div>
</body>
</html>
`;

/** 業界固有コンテンツ（ヘルスケア） */
const HEALTHCARE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Healthcare Platform</title>
</head>
<body>
  <header role="banner">
    <nav role="navigation">
      <a href="/">Home</a>
    </nav>
  </header>
  <main role="main">
    <h1>Trusted Healthcare Solutions</h1>
    <p>HIPAA certified and licensed medical professionals.</p>
    <p>Secure patient data with enterprise-grade encryption.</p>
    <section aria-label="Trust badges">
      <p>Licensed, Certified, Secure</p>
    </section>
  </main>
  <footer role="contentinfo">
    <p>Trust us with your health</p>
  </footer>
</body>
</html>
`;

/** 金融業界向けHTML */
const FINANCE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Financial Services</title>
</head>
<body>
  <header role="banner">
    <nav role="navigation">
      <a href="/">Home</a>
    </nav>
  </header>
  <main role="main">
    <h1>Secure Financial Services</h1>
    <p>Bank-grade security with end-to-end encryption.</p>
    <p>SOC2 compliance and regulatory protection.</p>
    <button>Contact our team</button>
  </main>
  <footer role="contentinfo">
    <p>Protecting your financial future</p>
  </footer>
</body>
</html>
`;

/** テクノロジー業界向けHTML */
const TECH_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Developer Platform</title>
  <style>
    .hero { background: linear-gradient(to right, #000, #333); display: grid; }
    .flex { display: flex; }
  </style>
</head>
<body>
  <header role="banner">
    <nav role="navigation">
      <a href="/">Home</a>
    </nav>
  </header>
  <main role="main">
    <h1>API-First Developer Platform</h1>
    <p>Comprehensive documentation and seamless integration.</p>
    <p>Built for developers, by developers.</p>
    <a href="/docs" class="btn cta">View Documentation</a>
    <button>Request Demo</button>
  </main>
  <footer role="contentinfo">
    <p>Empowering developers worldwide</p>
  </footer>
</body>
</html>
`;

/** 100KB以上のHTML（パフォーマンステスト用） */
function generateLargeHTML(sizeKB: number): string {
  const baseContent = `
    <section class="section-$INDEX">
      <h2>Section $INDEX</h2>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p>
      <div class="content">
        <article>
          <h3>Article $INDEX.1</h3>
          <p>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.</p>
          <img src="image-$INDEX.jpg" alt="Image $INDEX">
        </article>
        <article>
          <h3>Article $INDEX.2</h3>
          <p>Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
        </article>
      </div>
    </section>
  `;

  let html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Large Page</title>
  <style>
    @media (max-width: 768px) { .container { width: 100%; } }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); }
  </style>
</head>
<body>
  <header role="banner">
    <nav role="navigation" aria-label="Main">
      <a href="/">Home</a>
    </nav>
  </header>
  <main role="main">
  `;

  let index = 0;
  while (html.length < sizeKB * 1024) {
    html += baseContent.replace(/\$INDEX/g, String(index++));
  }

  html += `
  </main>
  <footer role="contentinfo">
    <p>Footer</p>
  </footer>
</body>
</html>
  `;

  return html;
}

// =============================================================================
// テストスイート
// =============================================================================

describe('QualityEvaluatorService', () => {
  let service: QualityEvaluatorService;

  beforeEach(() => {
    resetQualityEvaluatorService();
    service = getQualityEvaluatorService();
  });

  afterEach(() => {
    resetQualityEvaluatorService();
  });

  // ===========================================================================
  // Part 1: 基本機能テスト
  // ===========================================================================

  describe('基本機能', () => {
    it('基本的なHTMLを評価できる', async () => {
      const result = await service.evaluate(BASIC_HTML);

      expect(result.success).toBe(true);
      expect(result.overallScore).toBeGreaterThanOrEqual(0);
      expect(result.overallScore).toBeLessThanOrEqual(100);
      expect(['A', 'B', 'C', 'D', 'F']).toContain(result.grade);
      expect(result.axisScores).toBeDefined();
      expect(result.axisScores.originality).toBeGreaterThanOrEqual(0);
      expect(result.axisScores.craftsmanship).toBeGreaterThanOrEqual(0);
      expect(result.axisScores.contextuality).toBeGreaterThanOrEqual(0);
      expect(result.clicheCount).toBeDefined();
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('空のHTMLでも成功する（低スコア）', async () => {
      const result = await service.evaluate('');

      expect(result.success).toBe(true);
      expect(result.overallScore).toBeGreaterThanOrEqual(0);
    });

    it('最小限のHTMLでも評価できる', async () => {
      const result = await service.evaluate('<html><body><h1>Hello</h1></body></html>');

      expect(result.success).toBe(true);
      expect(result.overallScore).toBeGreaterThanOrEqual(0);
    });

    it('処理時間をミリ秒で返す', async () => {
      const result = await service.evaluate(BASIC_HTML);

      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.processingTimeMs).toBe('number');
    });
  });

  // ===========================================================================
  // Part 2: AIクリシェ検出テスト
  // ===========================================================================

  describe('AIクリシェ検出', () => {
    it('パープル-ピンクグラデーションを検出する', async () => {
      const result = await service.evaluate(AI_CLICHE_HTML);

      expect(result.success).toBe(true);
      expect(result.clicheCount).toBeGreaterThan(0);
      expect(result.cliches).toBeDefined();
      expect(result.cliches!.some((c) => c.type === 'gradient')).toBe(true);
    });

    it('オレンジ-ピンクグラデーションを検出する', async () => {
      const html = `
        <style>
          .cta { background: linear-gradient(to right, #f857a6, #ff5858); }
        </style>
      `;
      const result = await service.evaluate(html);

      expect(result.cliches!.some((c) => c.description.includes('ピンク-オレンジ') || c.description.includes('f857a6'))).toBe(true);
    });

    it('AI典型フレーズを検出する', async () => {
      const result = await service.evaluate(AI_CLICHE_HTML);

      expect(result.cliches!.some((c) => c.type === 'text')).toBe(true);
      // 以下のフレーズのいずれかが検出される
      const textPatterns = [
        'Transform Your Business',
        'Unlock the power',
        'cutting-edge',
        'seamless',
        'Get Started Today',
        'Scale effortlessly',
      ];
      expect(
        result.cliches!.some((c) => textPatterns.some((p) => c.description.includes(p)))
      ).toBe(true);
    });

    it('ピル型ボタン（border-radius: 9999px）を検出する', async () => {
      const result = await service.evaluate(AI_CLICHE_HTML);

      expect(result.cliches!.some((c) => c.type === 'button' || c.description.includes('9999px'))).toBe(true);
    });

    it('クリシェが多いほどoriginalityスコアが低い', async () => {
      const cleanResult = await service.evaluate(BASIC_HTML);
      const clicheResult = await service.evaluate(AI_CLICHE_HTML);

      expect(clicheResult.axisScores.originality).toBeLessThan(cleanResult.axisScores.originality);
    });

    it('クリシェがないHTMLではclicheCountが0', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      expect(result.clicheCount).toBe(0);
      expect(result.cliches).toBeDefined();
      expect(result.cliches!.length).toBe(0);
    });
  });

  // ===========================================================================
  // Part 3: セマンティックHTML評価テスト
  // ===========================================================================

  describe('セマンティックHTML評価', () => {
    it('セマンティックなheader/main/footerを検出する', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      expect(result.success).toBe(true);
      expect(result.axisScores.craftsmanship).toBeGreaterThanOrEqual(70);
      expect(result.axisDetails?.craftsmanship.some((d) => d.includes('header') || d.includes('セマンティック'))).toBe(true);
    });

    it('nav, section, article, asideを検出する', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      expect(result.axisDetails?.craftsmanship.some((d) =>
        d.includes('nav') || d.includes('section') || d.includes('article') || d.includes('aside')
      )).toBe(true);
    });

    it('divの過剰使用を検出してペナルティを与える', async () => {
      const result = await service.evaluate(POOR_A11Y_HTML);

      expect(result.axisScores.craftsmanship).toBeLessThan(70);
      // divの過剰使用によるペナルティが適用される
      // "divの過剰使用" または "セマンティック要素が少ない" を検出
      expect(result.axisDetails?.craftsmanship.some((d) =>
        (d.includes('div') && (d.includes('過剰') || d.includes('セマンティック')))
      )).toBe(true);
    });

    it('セマンティックHTMLがないとcraftsmanshipスコアが低い', async () => {
      const poorResult = await service.evaluate(POOR_A11Y_HTML);
      const goodResult = await service.evaluate(SEMANTIC_HTML);

      expect(poorResult.axisScores.craftsmanship).toBeLessThan(goodResult.axisScores.craftsmanship);
    });
  });

  // ===========================================================================
  // Part 4: ARIA属性検出テスト
  // ===========================================================================

  describe('ARIA属性検出', () => {
    it('aria-label属性を検出する', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      expect(result.axisDetails?.craftsmanship.some((d) => d.includes('ARIA') || d.includes('aria-label'))).toBe(true);
    });

    it('aria-labelledby属性を検出する', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      expect(result.axisDetails?.craftsmanship.some((d) => d.includes('labelledby') || d.includes('ARIA'))).toBe(true);
    });

    it('aria-describedby属性を検出する', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      expect(result.axisDetails?.craftsmanship.some((d) => d.includes('describedby') || d.includes('ARIA'))).toBe(true);
    });

    it('role属性を検出する', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      expect(result.axisDetails?.craftsmanship.some((d) =>
        d.includes('role') || d.includes('banner') || d.includes('main') || d.includes('navigation')
      )).toBe(true);
    });

    it('ARIA属性がないとアクセシビリティスコアが低い', async () => {
      const noAriaResult = await service.evaluate(POOR_A11Y_HTML);
      const withAriaResult = await service.evaluate(SEMANTIC_HTML);

      expect(noAriaResult.axisScores.craftsmanship).toBeLessThan(withAriaResult.axisScores.craftsmanship);
    });
  });

  // ===========================================================================
  // Part 5: レスポンシブパターン検出テスト
  // ===========================================================================

  describe('レスポンシブパターン検出', () => {
    it('@media (max-width)を検出する', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      expect(result.axisDetails?.craftsmanship.some((d) =>
        d.includes('レスポンシブ') || d.includes('media')
      )).toBe(true);
    });

    it('viewport metaタグを検出する', async () => {
      const result = await service.evaluate(BASIC_HTML);

      expect(result.axisDetails?.craftsmanship.some((d) =>
        d.includes('viewport') || d.includes('meta')
      )).toBe(true);
    });

    it('prefers-reduced-motionを検出する', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      expect(result.axisDetails?.craftsmanship.some((d) =>
        d.includes('モーション軽減') || d.includes('reduced-motion')
      )).toBe(true);
    });

    it('CSS GridとFlexboxを検出する', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      expect(result.axisDetails?.craftsmanship.some((d) =>
        d.includes('Grid') || d.includes('grid')
      )).toBe(true);
      expect(result.axisDetails?.craftsmanship.some((d) =>
        d.includes('Flex') || d.includes('flex')
      )).toBe(true);
    });

    it('clamp関数を検出する', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      expect(result.axisDetails?.craftsmanship.some((d) =>
        d.includes('clamp')
      )).toBe(true);
    });

    it('CSS変数を検出する', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      // CSS変数はoriginality詳細に記録される
      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('CSS変数') || d.includes('カスタム') || d.includes('var(')
      )).toBe(true);
    });
  });

  // ===========================================================================
  // Part 6: 業界別コンテキスト評価テスト
  // ===========================================================================

  describe('業界別コンテキスト評価', () => {
    it('ヘルスケア業界向けコンテンツを評価する', async () => {
      const result = await service.evaluate(HEALTHCARE_HTML, {
        targetIndustry: 'healthcare',
      });

      expect(result.success).toBe(true);
      expect(result.axisScores.contextuality).toBeGreaterThanOrEqual(70);
      expect(result.axisDetails?.contextuality.some((d) =>
        d.includes('ヘルスケア') || d.includes('healthcare') || d.includes('信頼性')
      )).toBe(true);
    });

    it('金融業界向けコンテンツを評価する', async () => {
      const result = await service.evaluate(FINANCE_HTML, {
        targetIndustry: 'finance',
      });

      expect(result.success).toBe(true);
      expect(result.axisScores.contextuality).toBeGreaterThanOrEqual(70);
      expect(result.axisDetails?.contextuality.some((d) =>
        d.includes('金融') || d.includes('finance') || d.includes('セキュリティ')
      )).toBe(true);
    });

    it('テクノロジー業界向けコンテンツを評価する', async () => {
      const result = await service.evaluate(TECH_HTML, {
        targetIndustry: 'technology',
      });

      expect(result.success).toBe(true);
      expect(result.axisScores.contextuality).toBeGreaterThanOrEqual(70);
      expect(result.axisDetails?.contextuality.some((d) =>
        d.includes('テク') || d.includes('tech') || d.includes('技術')
      )).toBe(true);
    });

    it('業界指定なしでも基本的なコンテキスト評価ができる', async () => {
      const result = await service.evaluate(BASIC_HTML);

      expect(result.success).toBe(true);
      expect(result.axisScores.contextuality).toBeGreaterThanOrEqual(50);
    });

    it('ターゲットオーディエンス（enterprise）を評価する', async () => {
      const result = await service.evaluate(FINANCE_HTML, {
        targetAudience: 'enterprise',
      });

      expect(result.axisDetails?.contextuality.some((d) =>
        d.includes('エンタープライズ') || d.includes('enterprise') || d.includes('ビジネス')
      )).toBe(true);
    });

    it('ターゲットオーディエンス（developers）を評価する', async () => {
      const result = await service.evaluate(TECH_HTML, {
        targetAudience: 'developers',
      });

      expect(result.axisDetails?.contextuality.some((d) =>
        d.includes('開発者') || d.includes('developer') || d.includes('専門家')
      )).toBe(true);
    });
  });

  // ===========================================================================
  // Part 7: スコア計算テスト
  // ===========================================================================

  describe('スコア計算', () => {
    it('デフォルトの重み付け（0.35/0.4/0.25）で計算する', async () => {
      const result = await service.evaluate(BASIC_HTML);

      // デフォルト重み: originality=0.35, craftsmanship=0.4, contextuality=0.25
      const expectedScore = Math.round(
        result.axisScores.originality * 0.35 +
        result.axisScores.craftsmanship * 0.4 +
        result.axisScores.contextuality * 0.25
      );

      expect(Math.abs(result.overallScore - expectedScore)).toBeLessThanOrEqual(1);
    });

    it('カスタム重み付けで計算する', async () => {
      const result = await service.evaluate(BASIC_HTML, {
        weights: {
          originality: 0.5,
          craftsmanship: 0.3,
          contextuality: 0.2,
        },
      });

      const expectedScore = Math.round(
        result.axisScores.originality * 0.5 +
        result.axisScores.craftsmanship * 0.3 +
        result.axisScores.contextuality * 0.2
      );

      expect(Math.abs(result.overallScore - expectedScore)).toBeLessThanOrEqual(1);
    });

    it('スコアは0-100の範囲内', async () => {
      const result = await service.evaluate(AI_CLICHE_HTML, { strict: true });

      expect(result.overallScore).toBeGreaterThanOrEqual(0);
      expect(result.overallScore).toBeLessThanOrEqual(100);
      expect(result.axisScores.originality).toBeGreaterThanOrEqual(0);
      expect(result.axisScores.originality).toBeLessThanOrEqual(100);
      expect(result.axisScores.craftsmanship).toBeGreaterThanOrEqual(0);
      expect(result.axisScores.craftsmanship).toBeLessThanOrEqual(100);
      expect(result.axisScores.contextuality).toBeGreaterThanOrEqual(0);
      expect(result.axisScores.contextuality).toBeLessThanOrEqual(100);
    });
  });

  // ===========================================================================
  // Part 8: グレード判定テスト
  // ===========================================================================

  describe('グレード判定', () => {
    it('A: 90点以上', async () => {
      // 高品質HTMLでAグレードを取得
      const result = await service.evaluate(SEMANTIC_HTML);

      if (result.overallScore >= 90) {
        expect(result.grade).toBe('A');
      }
    });

    it('B: 80-89点', async () => {
      const result = await service.evaluate(BASIC_HTML);

      if (result.overallScore >= 80 && result.overallScore < 90) {
        expect(result.grade).toBe('B');
      }
    });

    it('C: 70-79点', async () => {
      const html = '<html><body><header role="banner"><h1>Test</h1></header><main><p>Content</p></main></body></html>';
      const result = await service.evaluate(html);

      if (result.overallScore >= 70 && result.overallScore < 80) {
        expect(result.grade).toBe('C');
      }
    });

    it('D: 60-69点', async () => {
      const html = '<html><body><div><p>Content</p></div></body></html>';
      const result = await service.evaluate(html);

      if (result.overallScore >= 60 && result.overallScore < 70) {
        expect(result.grade).toBe('D');
      }
    });

    it('F: 60点未満', async () => {
      const result = await service.evaluate(AI_CLICHE_HTML, { strict: true });

      if (result.overallScore < 60) {
        expect(result.grade).toBe('F');
      }
    });

    it('各軸にもグレードが付与される', async () => {
      const result = await service.evaluate(BASIC_HTML);

      expect(result.axisGrades).toBeDefined();
      expect(['A', 'B', 'C', 'D', 'F']).toContain(result.axisGrades!.originality);
      expect(['A', 'B', 'C', 'D', 'F']).toContain(result.axisGrades!.craftsmanship);
      expect(['A', 'B', 'C', 'D', 'F']).toContain(result.axisGrades!.contextuality);
    });
  });

  // ===========================================================================
  // Part 9: 推奨事項生成テスト
  // ===========================================================================

  describe('推奨事項生成', () => {
    it('推奨事項を生成する', async () => {
      const result = await service.evaluate(POOR_A11Y_HTML, {
        includeRecommendations: true,
      });

      expect(result.recommendations).toBeDefined();
      expect(result.recommendations!.length).toBeGreaterThan(0);
    });

    it('推奨事項にはカテゴリ・優先度・タイトル・説明が含まれる', async () => {
      const result = await service.evaluate(POOR_A11Y_HTML, {
        includeRecommendations: true,
      });

      const rec = result.recommendations![0];
      expect(rec).toHaveProperty('id');
      expect(rec).toHaveProperty('category');
      expect(['originality', 'craftsmanship', 'contextuality']).toContain(rec.category);
      expect(rec).toHaveProperty('priority');
      expect(['high', 'medium', 'low']).toContain(rec.priority);
      expect(rec).toHaveProperty('title');
      expect(rec).toHaveProperty('description');
    });

    it('includeRecommendations: falseで推奨事項を除外できる', async () => {
      const result = await service.evaluate(POOR_A11Y_HTML, {
        includeRecommendations: false,
      });

      expect(result.recommendations).toBeUndefined();
    });

    it('クリシェがある場合、originality改善の推奨事項を含む', async () => {
      const result = await service.evaluate(AI_CLICHE_HTML, {
        includeRecommendations: true,
      });

      expect(result.recommendations!.some((r) => r.category === 'originality')).toBe(true);
    });

    it('アクセシビリティ問題がある場合、craftsmanship改善の推奨事項を含む', async () => {
      const result = await service.evaluate(POOR_A11Y_HTML, {
        includeRecommendations: true,
      });

      expect(result.recommendations!.some((r) => r.category === 'craftsmanship')).toBe(true);
    });

    it('推奨事項は優先度順にソートされる', async () => {
      const result = await service.evaluate(POOR_A11Y_HTML, {
        includeRecommendations: true,
      });

      const priorities = result.recommendations!.map((r) => r.priority);
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      for (let i = 1; i < priorities.length; i++) {
        expect(priorityOrder[priorities[i]!]).toBeGreaterThanOrEqual(priorityOrder[priorities[i - 1]!]);
      }
    });
  });

  // ===========================================================================
  // Part 10: strictモードテスト
  // ===========================================================================

  describe('strictモード', () => {
    it('strictモードではクリシェペナルティが増加する', async () => {
      // 少数のクリシェを含むHTMLでテスト（両方0にならないように）
      const mildClicheHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Test</title>
          <style>
            .hero {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
          </style>
        </head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main"><p>Content</p></main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const normalResult = await service.evaluate(mildClicheHtml, { strict: false });
      const strictResult = await service.evaluate(mildClicheHtml, { strict: true });

      // strictモードではペナルティが増加するため、origialityスコアが低い
      expect(strictResult.axisScores.originality).toBeLessThanOrEqual(normalResult.axisScores.originality);
      // 両方とも0でないことを確認（ペナルティの差が見える）
      expect(normalResult.axisScores.originality).toBeGreaterThan(0);
    });

    it('strictモードではlowレベルのクリシェも検出する', async () => {
      const html = `
        <html><body>
          <p>Scale effortlessly with our platform.</p>
          <style>.box { box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); }</style>
        </body></html>
      `;

      const normalResult = await service.evaluate(html, { strict: false });
      const strictResult = await service.evaluate(html, { strict: true });

      // strictモードでは low severity のクリシェも検出される
      expect(strictResult.clicheCount).toBeGreaterThanOrEqual(normalResult.clicheCount);
    });

    it('strictモードでは全体スコアが低くなる', async () => {
      const normalResult = await service.evaluate(AI_CLICHE_HTML, { strict: false });
      const strictResult = await service.evaluate(AI_CLICHE_HTML, { strict: true });

      expect(strictResult.overallScore).toBeLessThanOrEqual(normalResult.overallScore);
    });
  });

  // ===========================================================================
  // Part 11: パフォーマンステスト
  // ===========================================================================

  describe('パフォーマンス', () => {
    it('100KB以上のHTMLでも500ms以内に処理完了', async () => {
      const largeHtml = generateLargeHTML(100);

      expect(largeHtml.length).toBeGreaterThanOrEqual(100 * 1024);

      const startTime = Date.now();
      const result = await service.evaluate(largeHtml);
      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(500);
      expect(result.processingTimeMs).toBeLessThan(500);
    }, 10000);

    it('200KB以上のHTMLでも500ms以内に処理完了', async () => {
      const largeHtml = generateLargeHTML(200);

      expect(largeHtml.length).toBeGreaterThanOrEqual(200 * 1024);

      const startTime = Date.now();
      const result = await service.evaluate(largeHtml);
      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(500);
    }, 10000);

    it('連続10回の評価でも安定したパフォーマンス', async () => {
      const times: number[] = [];

      for (let i = 0; i < 10; i++) {
        const startTime = Date.now();
        await service.evaluate(BASIC_HTML);
        times.push(Date.now() - startTime);
      }

      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      expect(avgTime).toBeLessThan(100); // 平均100ms以内
    });
  });

  // ===========================================================================
  // Part 12: シングルトンインスタンステスト
  // ===========================================================================

  describe('シングルトンインスタンス', () => {
    it('getQualityEvaluatorServiceは同一インスタンスを返す', () => {
      const service1 = getQualityEvaluatorService();
      const service2 = getQualityEvaluatorService();

      expect(service1).toBe(service2);
    });

    it('resetQualityEvaluatorServiceでインスタンスがリセットされる', () => {
      const service1 = getQualityEvaluatorService();
      resetQualityEvaluatorService();
      const service2 = getQualityEvaluatorService();

      expect(service1).not.toBe(service2);
    });
  });

  // ===========================================================================
  // Part 13: 画像alt属性テスト
  // ===========================================================================

  describe('画像alt属性評価', () => {
    it('全ての画像にalt属性がある場合はボーナス', async () => {
      const result = await service.evaluate(BASIC_HTML);

      expect(result.axisDetails?.craftsmanship.some((d) =>
        d.includes('alt') && !d.includes('ない')
      )).toBe(true);
    });

    it('alt属性がない画像があればペナルティ', async () => {
      const result = await service.evaluate(POOR_A11Y_HTML);

      expect(result.axisDetails?.craftsmanship.some((d) =>
        d.includes('alt') && d.includes('ない')
      )).toBe(true);
    });
  });

  // ===========================================================================
  // Part 14: インラインイベントハンドラ検出テスト
  // ===========================================================================

  describe('インラインイベントハンドラ検出', () => {
    it('onclick属性を検出してペナルティを与える', async () => {
      const result = await service.evaluate(POOR_A11Y_HTML);

      expect(result.axisDetails?.craftsmanship.some((d) =>
        d.includes('onclick') || d.includes('インライン')
      )).toBe(true);
    });

    it('onclick属性の数に応じてペナルティが増加', async () => {
      const oneOnclick = '<html><body><div onclick="foo()">Click</div></body></html>';
      const threeOnclick = '<html><body><div onclick="a()">A</div><div onclick="b()">B</div><div onclick="c()">C</div></body></html>';

      const oneResult = await service.evaluate(oneOnclick);
      const threeResult = await service.evaluate(threeOnclick);

      expect(threeResult.axisScores.craftsmanship).toBeLessThan(oneResult.axisScores.craftsmanship);
    });
  });

  // ===========================================================================
  // Part 15: CSS変数・カスタムアニメーション検出テスト
  // ===========================================================================

  describe('カスタムスタイル検出', () => {
    it('CSS変数の使用を検出してボーナス', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      // CSS変数は「活用」「変数」「カスタム」などのキーワードで記録
      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('変数') || d.includes('カスタム') || d.includes('var(') || d.includes('活用')
      )).toBe(true);
    });

    it('カスタムアニメーションを検出してボーナス', async () => {
      const html = `
        <html>
        <head>
          <style>
            @keyframes fadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
          </style>
        </head>
        <body><div>Content</div></body>
        </html>
      `;
      const result = await service.evaluate(html);

      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('アニメーション') || d.includes('keyframes')
      )).toBe(true);
    });

    it('カスタムカラーパレットを検出してボーナス', async () => {
      const result = await service.evaluate(SEMANTIC_HTML);

      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('カラーパレット') || d.includes('カラー') || d.includes('color')
      )).toBe(true);
    });
  });

  // ===========================================================================
  // Part 16: Originality積極的評価テスト（v0.1.0新規）
  // ===========================================================================

  describe('Originality積極的評価（v0.1.0）', () => {
    it('AIクリシェなしで積極的指標もない場合は80点', async () => {
      // 最小限のHTML（積極的指標なし、クリシェなし）
      const minimalHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <head><title>Minimal</title></head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main"><p>Content</p></main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(minimalHtml);

      expect(result.success).toBe(true);
      // ベーススコア80点（積極的指標なし）
      expect(result.axisScores.originality).toBe(80);
    });

    it('カスタムカラースキームを検出してボーナス（+5点）', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Custom Colors</title>
          <style>
            :root {
              color: #2a5f9e;
              background: #f4e8d5;
              border-color: #8b4513;
            }
          </style>
        </head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main"><p>Content</p></main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(html);

      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('カスタムカラースキーム') && d.includes('+5')
      )).toBe(true);
    });

    it('カスタムフォント（Google Fonts）を検出してボーナス（+3点）', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Custom Fonts</title>
          <link href="https://fonts.googleapis.com/css2?family=Roboto" rel="stylesheet">
        </head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main"><p>Content</p></main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(html);

      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('カスタムフォント') && d.includes('+3')
      )).toBe(true);
    });

    it('カスタムフォント（@font-face）を検出してボーナス（+3点）', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Custom Fonts</title>
          <style>
            @font-face {
              font-family: 'MyCustomFont';
              src: url('/fonts/custom.woff2') format('woff2');
            }
          </style>
        </head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main"><p>Content</p></main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(html);

      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('カスタムフォント') && d.includes('+3')
      )).toBe(true);
    });

    it('ユニークなレイアウト（Container Queries）を検出してボーナス（+5点）', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Modern Layout</title>
          <style>
            .card {
              container-type: inline-size;
            }
            @container (min-width: 400px) {
              .card { display: grid; }
            }
          </style>
        </head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main"><p>Content</p></main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(html);

      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('ユニークなレイアウト') && d.includes('+5')
      )).toBe(true);
    });

    it('ユニークなレイアウト（Subgrid）を検出してボーナス（+5点）', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Subgrid Layout</title>
          <style>
            .parent {
              display: grid;
              grid-template-columns: repeat(3, 1fr);
            }
            .child {
              display: grid;
              grid-template-columns: subgrid;
            }
          </style>
        </head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main"><p>Content</p></main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(html);

      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('ユニークなレイアウト') && d.includes('+5')
      )).toBe(true);
    });

    it('カスタムアニメーション（cubic-bezier）を検出してボーナス（+4点）', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Custom Animation</title>
          <style>
            .element {
              transition: transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1.0);
            }
          </style>
        </head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main"><p>Content</p></main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(html);

      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('カスタムアニメーション') && d.includes('+4')
      )).toBe(true);
    });

    it('カスタムアニメーション（複数@keyframes）を検出してボーナス（+4点）', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Multiple Keyframes</title>
          <style>
            @keyframes fadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            @keyframes slideIn {
              from { transform: translateX(-100%); }
              to { transform: translateX(0); }
            }
          </style>
        </head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main"><p>Content</p></main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(html);

      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('カスタムアニメーション') && d.includes('+4')
      )).toBe(true);
    });

    it('オリジナルグラフィック（インラインSVG）を検出してボーナス（+3点）', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head><title>SVG Graphics</title></head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main">
            <svg width="100" height="100">
              <path d="M10 10 L90 90" stroke="black" />
            </svg>
          </main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(html);

      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('オリジナルグラフィック') && d.includes('+3')
      )).toBe(true);
    });

    it('オリジナルグラフィック（Canvas）を検出してボーナス（+3点）', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head><title>Canvas Graphics</title></head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main">
            <canvas id="myCanvas" width="200" height="200"></canvas>
          </main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(html);

      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('オリジナルグラフィック') && d.includes('+3')
      )).toBe(true);
    });

    it('全積極的指標ありで最大100点', async () => {
      // 全ての積極的評価指標を含むHTML
      const fullFeaturedHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Full Featured</title>
          <link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">
          <style>
            :root {
              --primary-color: #2a5f9e;
              --secondary-color: #f4e8d5;
              --accent-color: #8b4513;
              --text-color: #1a1a1a;
              --bg-color: #fefefe;
            }
            .container {
              container-type: inline-size;
              color: var(--text-color);
              background: var(--bg-color);
              border-color: var(--accent-color);
            }
            @container (min-width: 400px) {
              .container { display: grid; }
            }
            @keyframes fadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            @keyframes slideUp {
              from { transform: translateY(20px); }
              to { transform: translateY(0); }
            }
            .animated {
              animation: fadeIn 0.3s cubic-bezier(0.25, 0.1, 0.25, 1.0);
            }
          </style>
        </head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main">
            <svg width="100" height="100">
              <path d="M10 10 L90 90" stroke="black" />
            </svg>
          </main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(fullFeaturedHtml);

      expect(result.success).toBe(true);
      // 80 + 5(カラー) + 3(フォント) + 5(レイアウト) + 4(アニメ) + 3(グラフィック) = 100
      // さらに既存ボーナスも加算される可能性があるが、clampで100に制限
      expect(result.axisScores.originality).toBe(100);
    });

    it('AIクリシェありで積極的指標ありの場合、適切に減点+加点', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Transform Your Business</title>
          <link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">
          <style>
            :root {
              --primary: #2a5f9e;
              --secondary: #f4e8d5;
              --accent: #8b4513;
            }
            .hero {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            @keyframes fadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            @keyframes slideIn {
              from { transform: translateX(-100%); }
              to { transform: translateX(0); }
            }
          </style>
        </head>
        <body>
          <header role="banner"><h1>Transform Your Business</h1></header>
          <main role="main">
            <svg width="100" height="100">
              <path d="M10 10 L90 90" stroke="black" />
            </svg>
          </main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(html);

      expect(result.success).toBe(true);
      // クリシェペナルティがあるためoriginalityは100未満
      expect(result.axisScores.originality).toBeLessThan(100);
      // しかし積極的評価があるため0ではない
      expect(result.axisScores.originality).toBeGreaterThan(50);
      // クリシェと積極的評価の両方がdetailsに記録される
      expect(result.axisDetails?.originality?.some((d) => d.includes('クリシェ'))).toBe(true);
      expect(result.axisDetails?.originality?.some((d) => d.includes('+'))).toBe(true);
    });

    it('Bootstrap標準カラーのみではカスタムカラースキームボーナスなし', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Bootstrap Colors</title>
          <style>
            .primary { color: #0d6efd; }
            .secondary { color: #6c757d; }
            .success { color: #198754; }
          </style>
        </head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main"><p>Content</p></main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(html);

      // Bootstrap標準カラーのみなのでカスタムカラースキームボーナスなし
      expect(result.axisDetails?.originality?.some((d) =>
        d.includes('カスタムカラースキーム')
      )).toBe(false);
    });
  });

  // ===========================================================================
  // Part 17: 推奨事項精緻化テスト（v0.1.0新規）
  // ===========================================================================

  describe('推奨事項精緻化（v0.1.0）', () => {
    it('最低3件の推奨事項を保証する', async () => {
      // 高品質HTMLでも最低3件の推奨事項を返す
      const result = await service.evaluate(SEMANTIC_HTML, {
        includeRecommendations: true,
      });

      expect(result.recommendations).toBeDefined();
      expect(result.recommendations!.length).toBeGreaterThanOrEqual(3);
    });

    it('推奨事項にexpectedImpactフィールドが含まれる', async () => {
      const result = await service.evaluate(BASIC_HTML, {
        includeRecommendations: true,
      });

      expect(result.recommendations).toBeDefined();
      expect(result.recommendations!.length).toBeGreaterThan(0);

      const rec = result.recommendations![0];
      expect(rec).toHaveProperty('expectedImpact');
      expect(typeof rec.expectedImpact).toBe('string');
      // expectedImpactは "+N points" の形式
      expect(rec.expectedImpact).toMatch(/^\+\d+\s+points?$/);
    });

    it('3カテゴリ全てをカバーする推奨事項を生成', async () => {
      // 改善余地のある中程度のHTML
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Medium Quality Page</title>
        </head>
        <body>
          <header role="banner"><h1>Welcome</h1></header>
          <main role="main">
            <p>Some content here.</p>
            <img src="image.jpg" alt="Test image">
          </main>
          <footer role="contentinfo"><p>Footer</p></footer>
        </body>
        </html>
      `;
      const result = await service.evaluate(html, {
        includeRecommendations: true,
      });

      expect(result.recommendations).toBeDefined();

      // 3カテゴリ全てがカバーされている
      const categories = result.recommendations!.map((r) => r.category);
      expect(categories).toContain('originality');
      expect(categories).toContain('craftsmanship');
      expect(categories).toContain('contextuality');
    });

    it('高品質HTMLでも改善提案がある（さらなる向上のため）', async () => {
      const result = await service.evaluate(SEMANTIC_HTML, {
        includeRecommendations: true,
      });

      expect(result.recommendations).toBeDefined();
      expect(result.recommendations!.length).toBeGreaterThanOrEqual(3);

      // 高品質でも最低3件の推奨事項があり、改善の余地を示す
      // 優先度が低いもの、または説明に特定のキーワードを含む
      const hasEnhancementSuggestion = result.recommendations!.some((r) =>
        r.priority === 'low' ||
        r.priority === 'medium' ||
        r.description.includes('検討') ||
        r.description.includes('高め') ||
        r.description.includes('向上') ||
        r.description.includes('強化')
      );
      expect(hasEnhancementSuggestion).toBe(true);
    });

    it('推奨事項の優先度とexpectedImpactが相関する', async () => {
      const result = await service.evaluate(POOR_A11Y_HTML, {
        includeRecommendations: true,
      });

      expect(result.recommendations).toBeDefined();
      expect(result.recommendations!.length).toBeGreaterThan(0);

      // 優先度がhighの推奨事項はimpactが高い
      const highPriorityRecs = result.recommendations!.filter((r) => r.priority === 'high');
      const lowPriorityRecs = result.recommendations!.filter((r) => r.priority === 'low');

      if (highPriorityRecs.length > 0 && lowPriorityRecs.length > 0) {
        const highImpactAvg = highPriorityRecs.reduce((sum, r) => {
          const match = r.expectedImpact?.match(/\+(\d+)/);
          return sum + (match ? parseInt(match[1]!) : 0);
        }, 0) / highPriorityRecs.length;

        const lowImpactAvg = lowPriorityRecs.reduce((sum, r) => {
          const match = r.expectedImpact?.match(/\+(\d+)/);
          return sum + (match ? parseInt(match[1]!) : 0);
        }, 0) / lowPriorityRecs.length;

        expect(highImpactAvg).toBeGreaterThanOrEqual(lowImpactAvg);
      }
    });

    it('各推奨事項に具体的な改善アクションが含まれる', async () => {
      const result = await service.evaluate(BASIC_HTML, {
        includeRecommendations: true,
      });

      expect(result.recommendations).toBeDefined();

      for (const rec of result.recommendations!) {
        // タイトルは空でない
        expect(rec.title.length).toBeGreaterThan(0);
        // 説明は20文字以上（具体的な内容）
        expect(rec.description.length).toBeGreaterThan(20);
        // IDがユニーク形式
        expect(rec.id).toMatch(/^rec-\d+$/);
      }
    });

    it('AIクリシェHTMLでは高優先度の推奨事項が多い', async () => {
      const result = await service.evaluate(AI_CLICHE_HTML, {
        includeRecommendations: true,
      });

      expect(result.recommendations).toBeDefined();

      const highPriorityCount = result.recommendations!.filter((r) => r.priority === 'high').length;
      // AIクリシェHTMLでは高優先度が少なくとも2件以上
      expect(highPriorityCount).toBeGreaterThanOrEqual(2);
    });
  });

  // ===========================================================================
  // Part 18: Craftsmanshipポジティブ評価テスト（v0.1.0新規）
  // ===========================================================================

  describe('Craftsmanshipポジティブ評価（v0.1.0）', () => {
    // -------------------------------------------------------------------------
    // モダンCSS機能ボーナス
    // -------------------------------------------------------------------------

    describe('モダンCSS機能ボーナス', () => {
      it('Container Queriesを検出してボーナス（+4点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Container Queries</title>
            <style>
              .card {
                container-type: inline-size;
              }
              @container (min-width: 400px) {
                .card-content { display: flex; }
              }
            </style>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main"><p>Content</p></main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('Container Queries') || d.includes('container-type')
        )).toBe(true);
      });

      it('gapプロパティを検出してボーナス（+2点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Gap Property</title>
            <style>
              .flex-container { display: flex; gap: 1rem; }
              .grid-container { display: grid; gap: 20px; }
            </style>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main"><p>Content</p></main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('gap') || d.includes('モダンスペーシング')
        )).toBe(true);
      });

      it('aspect-ratioを検出してボーナス（+3点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Aspect Ratio</title>
            <style>
              .video-container { aspect-ratio: 16 / 9; }
              .square { aspect-ratio: 1; }
            </style>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main"><p>Content</p></main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('aspect-ratio')
        )).toBe(true);
      });

      it('scroll-snapを検出してボーナス（+3点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Scroll Snap</title>
            <style>
              .carousel {
                scroll-snap-type: x mandatory;
                overflow-x: scroll;
              }
              .carousel-item {
                scroll-snap-align: start;
              }
            </style>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main"><p>Content</p></main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('scroll-snap') || d.includes('スクロールスナップ')
        )).toBe(true);
      });

      it('object-fitを検出してボーナス（+2点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Object Fit</title>
            <style>
              img { object-fit: cover; }
              .contain { object-fit: contain; }
            </style>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main">
              <img src="hero.jpg" alt="Hero">
            </main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('object-fit')
        )).toBe(true);
      });

      it('scroll-behaviorを検出してボーナス（+2点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Scroll Behavior</title>
            <style>
              html { scroll-behavior: smooth; }
            </style>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main"><p>Content</p></main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('scroll-behavior') || d.includes('スムーススクロール')
        )).toBe(true);
      });

      it('place-items/place-contentを検出してボーナス（+2点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Place Items</title>
            <style>
              .center { display: grid; place-items: center; }
              .content-center { display: grid; place-content: center; }
            </style>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main"><p>Content</p></main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('place-items') || d.includes('place-content') || d.includes('モダンセンタリング')
        )).toBe(true);
      });
    });

    // -------------------------------------------------------------------------
    // アクセシビリティ強化ボーナス
    // -------------------------------------------------------------------------

    describe('アクセシビリティ強化ボーナス', () => {
      it('tabindex属性を検出してボーナス（+2点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Tabindex</title>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main">
              <div tabindex="0" role="button">Custom Button</div>
              <div tabindex="-1" id="modal">Modal Content</div>
            </main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('tabindex') || d.includes('キーボードナビゲーション')
        )).toBe(true);
      });

      it(':focus-visibleを検出してボーナス（+3点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Focus Visible</title>
            <style>
              button:focus-visible {
                outline: 2px solid blue;
                outline-offset: 2px;
              }
              a:focus-visible {
                outline: 2px dashed currentColor;
              }
            </style>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main">
              <button>Click me</button>
            </main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('focus-visible') || d.includes('フォーカス表示')
        )).toBe(true);
      });

      it('スキップリンクを検出してボーナス（+4点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Skip Link</title>
            <style>
              .skip-link {
                position: absolute;
                left: -9999px;
              }
              .skip-link:focus {
                left: 0;
              }
            </style>
          </head>
          <body>
            <a href="#main-content" class="skip-link">Skip to main content</a>
            <header role="banner"><h1>Title</h1></header>
            <main role="main" id="main-content">
              <p>Content</p>
            </main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('skip') || d.includes('スキップリンク')
        )).toBe(true);
      });

      it('prefers-color-schemeを検出してボーナス（+3点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Color Scheme</title>
            <style>
              :root {
                color-scheme: light dark;
              }
              @media (prefers-color-scheme: dark) {
                body {
                  background: #1a1a1a;
                  color: #fff;
                }
              }
            </style>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main"><p>Content</p></main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('prefers-color-scheme') || d.includes('ダークモード') || d.includes('カラースキーム')
        )).toBe(true);
      });

      it('aria-live属性を検出してボーナス（+3点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>ARIA Live</title>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main">
              <div aria-live="polite" id="status">Status updates here</div>
              <div aria-live="assertive" id="alerts">Alert messages</div>
            </main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('aria-live') || d.includes('ライブリージョン')
        )).toBe(true);
      });
    });

    // -------------------------------------------------------------------------
    // パフォーマンス最適化ボーナス
    // -------------------------------------------------------------------------

    describe('パフォーマンス最適化ボーナス', () => {
      it('loading="lazy"を検出してボーナス（+3点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Lazy Loading</title>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main">
              <img src="hero.jpg" alt="Hero" loading="eager">
              <img src="below-fold.jpg" alt="Below fold" loading="lazy">
              <iframe src="video.html" loading="lazy"></iframe>
            </main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('loading="lazy"') || d.includes('遅延読み込み') || d.includes('lazy loading')
        )).toBe(true);
      });

      it('fetchpriorityを検出してボーナス（+3点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Fetch Priority</title>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main">
              <img src="hero.jpg" alt="Hero" fetchpriority="high">
              <img src="secondary.jpg" alt="Secondary" fetchpriority="low">
            </main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('fetchpriority') || d.includes('フェッチ優先度') || d.includes('リソース優先度')
        )).toBe(true);
      });

      it('preload/prefetchを検出してボーナス（+3点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Resource Hints</title>
            <link rel="preload" href="critical.css" as="style">
            <link rel="preload" href="hero.webp" as="image">
            <link rel="prefetch" href="/next-page">
            <link rel="dns-prefetch" href="//api.example.com">
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main"><p>Content</p></main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('preload') || d.includes('prefetch') || d.includes('リソースヒント')
        )).toBe(true);
      });

      it('async/deferスクリプトを検出してボーナス（+2点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Async Defer</title>
            <script src="analytics.js" async></script>
            <script src="app.js" defer></script>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main"><p>Content</p></main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('async') || d.includes('defer') || d.includes('非同期スクリプト')
        )).toBe(true);
      });

      it('WebP/AVIFモダン画像フォーマットを検出してボーナス（+2点）', async () => {
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Modern Images</title>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main">
              <picture>
                <source srcset="hero.avif" type="image/avif">
                <source srcset="hero.webp" type="image/webp">
                <img src="hero.jpg" alt="Hero">
              </picture>
            </main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(html);

        expect(result.axisDetails?.craftsmanship.some((d) =>
          d.includes('webp') || d.includes('avif') || d.includes('モダン画像フォーマット') || d.includes('picture')
        )).toBe(true);
      });
    });

    // -------------------------------------------------------------------------
    // ベーススコア調整テスト
    // -------------------------------------------------------------------------

    describe('ベーススコア調整', () => {
      it('基本的なセマンティックHTMLのCraftsmanshipスコアが65点以上', async () => {
        // 最小限の良いHTML（クリシェなし、問題なし）
        const minimalGoodHtml = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Minimal Good</title>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main"><p>Content</p></main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(minimalGoodHtml);

        // v0.1.0: ベーススコア65点 + セマンティックボーナス
        expect(result.axisScores.craftsmanship).toBeGreaterThanOrEqual(65);
      });

      it('高品質HTMLはCraftsmanshipスコアが85点以上を達成可能', async () => {
        // 全ポジティブ指標を含む高品質HTML
        const highQualityHtml = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>High Quality</title>
            <link rel="preload" href="critical.css" as="style">
            <script src="app.js" defer></script>
            <style>
              :root { color-scheme: light dark; }
              html { scroll-behavior: smooth; }
              .grid { display: grid; gap: 1rem; place-items: center; }
              .card { container-type: inline-size; aspect-ratio: 16 / 9; }
              img { object-fit: cover; }
              .scroll { scroll-snap-type: x mandatory; }
              @media (max-width: 768px) { .container { padding: 1rem; } }
              @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
              @media (prefers-color-scheme: dark) { body { background: #1a1a1a; } }
              button:focus-visible { outline: 2px solid blue; }
            </style>
          </head>
          <body>
            <a href="#main" class="skip-link">Skip to main content</a>
            <header role="banner" aria-label="Site header">
              <nav role="navigation" aria-label="Main navigation">
                <a href="/">Home</a>
              </nav>
            </header>
            <main role="main" id="main" aria-describedby="main-desc">
              <p id="main-desc" class="sr-only">Main content</p>
              <section aria-labelledby="section-title">
                <h1 id="section-title">Welcome</h1>
                <article>
                  <h2>Article</h2>
                  <picture>
                    <source srcset="hero.webp" type="image/webp">
                    <img src="hero.jpg" alt="Hero" loading="lazy" fetchpriority="high">
                  </picture>
                </article>
              </section>
              <aside aria-label="Sidebar">Related content</aside>
              <div aria-live="polite" id="status">Status updates</div>
              <div tabindex="0" role="button">Custom button</div>
            </main>
            <footer role="contentinfo">
              <p>Footer</p>
            </footer>
          </body>
          </html>
        `;
        const result = await service.evaluate(highQualityHtml);

        // 高品質HTMLはCraftsmanshipスコア85点以上
        expect(result.axisScores.craftsmanship).toBeGreaterThanOrEqual(85);
      });

      it('モダンCSS機能が多いほどCraftsmanshipスコアが高い', async () => {
        const basicHtml = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Basic</title>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main"><p>Content</p></main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;

        const modernCssHtml = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Modern CSS</title>
            <style>
              html { scroll-behavior: smooth; }
              .grid { display: grid; gap: 1rem; place-items: center; }
              .card { container-type: inline-size; aspect-ratio: 16 / 9; }
              img { object-fit: cover; }
              .scroll { scroll-snap-type: x mandatory; }
            </style>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main"><p>Content</p></main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;

        const basicResult = await service.evaluate(basicHtml);
        const modernResult = await service.evaluate(modernCssHtml);

        expect(modernResult.axisScores.craftsmanship).toBeGreaterThan(basicResult.axisScores.craftsmanship);
      });

      it('アクセシビリティ対応が多いほどCraftsmanshipスコアが高い', async () => {
        const basicHtml = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Basic</title>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main"><p>Content</p></main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;

        const accessibleHtml = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Accessible</title>
            <style>
              @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
              @media (prefers-color-scheme: dark) { body { background: #1a1a1a; } }
              button:focus-visible { outline: 2px solid blue; }
            </style>
          </head>
          <body>
            <a href="#main" class="skip-link">Skip to main content</a>
            <header role="banner" aria-label="Site header">
              <nav role="navigation" aria-labelledby="nav-title">
                <h2 id="nav-title" class="sr-only">Navigation</h2>
                <a href="/">Home</a>
              </nav>
            </header>
            <main role="main" id="main" aria-describedby="main-desc">
              <p id="main-desc" class="sr-only">Main content</p>
              <div aria-live="polite" id="status">Status</div>
              <div tabindex="0" role="button">Custom button</div>
            </main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;

        const basicResult = await service.evaluate(basicHtml);
        const accessibleResult = await service.evaluate(accessibleHtml);

        expect(accessibleResult.axisScores.craftsmanship).toBeGreaterThan(basicResult.axisScores.craftsmanship);
      });

      it('パフォーマンス最適化が多いほどCraftsmanshipスコアが高い', async () => {
        const basicHtml = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Basic</title>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main">
              <img src="hero.jpg" alt="Hero">
            </main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;

        const optimizedHtml = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Optimized</title>
            <link rel="preload" href="critical.css" as="style">
            <link rel="prefetch" href="/next-page">
            <script src="app.js" defer></script>
            <script src="analytics.js" async></script>
          </head>
          <body>
            <header role="banner"><h1>Title</h1></header>
            <main role="main">
              <picture>
                <source srcset="hero.webp" type="image/webp">
                <img src="hero.jpg" alt="Hero" loading="lazy" fetchpriority="high">
              </picture>
            </main>
            <footer role="contentinfo"><p>Footer</p></footer>
          </body>
          </html>
        `;

        const basicResult = await service.evaluate(basicHtml);
        const optimizedResult = await service.evaluate(optimizedHtml);

        expect(optimizedResult.axisScores.craftsmanship).toBeGreaterThan(basicResult.axisScores.craftsmanship);
      });
    });
  });
});
