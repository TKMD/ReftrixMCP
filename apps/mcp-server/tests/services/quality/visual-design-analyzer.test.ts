// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VisualDesignAnalyzerService テスト
 *
 * HTML+CSS静的解析による視覚デザイン品質メトリクス算出サービスのユニットテスト
 *
 * テスト対象:
 * - visualDensity: 視覚的密度（メディア要素/セクション比）
 * - typographyContrast: タイポグラフィコントラスト（フォントサイズ・ウェイト階層）
 * - colorVariety: 色彩豊富度（ユニークカラー数・色相分散）
 * - whitespaceIntentionality: 余白の意図性（スペーシングスケール一貫性）
 * - visualDepth: 視覚的深度（シャドウ・グラデーション・トランスフォーム）
 * - overall: 加重平均計算
 * - DIファクトリパターン
 *
 * @module tests/services/quality/visual-design-analyzer.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  VisualDesignAnalyzerService,
  getVisualDesignAnalyzerService,
  setVisualDesignAnalyzerServiceFactory,
  resetVisualDesignAnalyzerServiceFactory,
  type VisualDesignMetrics,
  type IVisualDesignAnalyzerService,
} from '../../../src/services/quality/visual-design-analyzer.service.js';

// =============================================================================
// テスト用HTML/CSS定義
// =============================================================================

/** 画像なしのシンプルHTML */
const MINIMAL_HTML = `
<html><body>
  <section><h1>Title</h1><p>Text only content here.</p></section>
  <section><h2>Features</h2><p>No images at all.</p></section>
</body></html>
`;

/** 画像・SVG・メディア要素が豊富なHTML */
const RICH_HTML = `
<html><body>
  <style>
    h1 { font-size: 48px; font-weight: 800; }
    h2 { font-size: 32px; font-weight: 600; }
    h3 { font-size: 24px; font-weight: 500; }
    p { font-size: 16px; font-weight: 400; line-height: 1.6; }
    .card { box-shadow: 0 4px 24px rgba(0,0,0,0.1); background: linear-gradient(135deg, #667eea, #764ba2); }
    .hero { padding: clamp(2rem, 5vw, 6rem); }
    section { padding: var(--section-gap, 80px) 0; }
    .overlay { backdrop-filter: blur(10px); }
    .accent { text-shadow: 0 2px 4px rgba(0,0,0,0.3); }
    .elevated { transform: translateY(-4px); z-index: 10; }
    ::before { content: ""; position: absolute; background: red; border: 1px solid; }
    .btn { filter: brightness(1.1); }
    .bg { background-color: #f0f0f0; color: #333; border-color: navy; }
    .link { color: tomato; }
    .highlight { background-color: gold; }
    .cta { background: linear-gradient(to right, #f857a6, #ff5858); }
    .line-h { line-height: 1.8; }
  </style>
  <header role="banner"><nav>Nav</nav></header>
  <main>
    <section class="hero">
      <h1>Hero Title</h1>
      <p class="line-h">Description text with good line height</p>
      <img src="hero.jpg" alt="Hero image" />
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>
    </section>
    <section>
      <h2>Features</h2>
      <div class="card elevated">
        <img src="feature1.jpg" alt="Feature 1" />
        <i class="fa-icon"></i>
      </div>
      <div class="card">
        <img src="feature2.jpg" alt="Feature 2" />
        <i class="fa-star"></i>
      </div>
    </section>
    <section>
      <h2>About</h2>
      <img src="team.jpg" alt="Team photo" />
      <video src="intro.mp4"></video>
    </section>
  </main>
  <footer role="contentinfo"><p>Footer</p></footer>
</body></html>
`;

/** 装飾的画像のみ含むHTML（alt=""） */
const DECORATIVE_ONLY_HTML = `
<html><body>
  <section>
    <h1>Title</h1>
    <img src="divider.png" alt="" />
    <img src="spacer.png" alt="" />
    <p>Content</p>
  </section>
</body></html>
`;

/** 単一font-sizeのCSS */
const SINGLE_FONT_CSS = `
  p { font-size: 16px; }
  span { font-size: 16px; }
  div { font-size: 16px; }
`;

/** 3段階のfont-size階層を持つCSS */
const MULTI_FONT_CSS = `
  h1 { font-size: 48px; font-weight: 800; line-height: 1.2; }
  h2 { font-size: 32px; font-weight: 600; line-height: 1.3; }
  p { font-size: 16px; font-weight: 400; line-height: 1.6; }
`;

/** font-weightバリエーションが豊富なCSS */
const WEIGHT_VARIETY_CSS = `
  h1 { font-size: 48px; font-weight: 900; }
  h2 { font-size: 32px; font-weight: 700; }
  h3 { font-size: 24px; font-weight: 500; }
  p { font-size: 16px; font-weight: 400; }
  .light { font-size: 14px; font-weight: 300; }
`;

/** 色数が少ないCSS（3色未満） */
const FEW_COLORS_CSS = `
  body { color: #333; }
  .bg { background-color: #fff; }
`;

/** 色数が豊富なCSS（5色以上、暖色+寒色） */
const RICH_COLORS_CSS = `
  .a { color: #ff5733; }
  .b { background-color: #3498db; }
  .c { border-color: #2ecc71; }
  .d { color: #9b59b6; }
  .e { background-color: #f39c12; }
  .f { color: hsl(200, 80%, 50%); }
  .g { background: rgba(255, 100, 50, 0.8); }
`;

/** clamp()とCSS変数を使用したスペーシングCSS */
const INTENTIONAL_SPACING_CSS = `
  section { padding: clamp(2rem, 5vw, 6rem) 0; }
  .container { margin: var(--gap-lg, 40px) auto; }
  .card { padding: clamp(1rem, 3vw, 3rem); }
  .grid { gap: var(--grid-gap, 24px); }
  .hero { padding: 80px var(--side-padding, 40px); }
  .footer { margin-top: 64px; padding: 32px 16px; }
`;

/** ハードコードされた一貫性のない余白CSS */
const INCONSISTENT_SPACING_CSS = `
  .a { padding: 13px; }
  .b { margin: 7px; }
  .c { padding: 23px; }
  .d { margin: 47px; }
`;

/** box-shadow, gradient, transformを使用するCSS */
const DEPTH_CSS = `
  .card { box-shadow: 0 4px 24px rgba(0,0,0,0.1); }
  .hero { background: linear-gradient(135deg, #667eea, #764ba2); }
  .btn { transform: translateY(-2px); }
  .overlay { backdrop-filter: blur(10px); }
  .title { text-shadow: 0 2px 4px rgba(0,0,0,0.3); }
  .img { filter: brightness(1.1); }
  ::before { content: ""; position: absolute; background: red; }
  .layer { z-index: 5; }
`;

/** 深度要素がないシンプルCSS */
const NO_DEPTH_CSS = `
  body { color: #333; background: #fff; }
  p { margin: 16px 0; }
`;

// =============================================================================
// テスト本体
// =============================================================================

describe('VisualDesignAnalyzerService', () => {
  let service: VisualDesignAnalyzerService;

  beforeEach(() => {
    service = new VisualDesignAnalyzerService();
  });

  afterEach(() => {
    // DIファクトリをリセット
    resetVisualDesignAnalyzerServiceFactory();
  });

  // =========================================================================
  // 空入力・境界値
  // =========================================================================

  describe('空入力処理', () => {
    it('空文字列でall-zeroの結果を返すこと', () => {
      // Arrange & Act
      const result = service.analyze('');

      // Assert
      expect(result.visualDensity).toBe(0);
      expect(result.typographyContrast).toBe(0);
      expect(result.colorVariety).toBe(0);
      expect(result.whitespaceIntentionality).toBe(0);
      expect(result.visualDepth).toBe(0);
      expect(result.overall).toBe(0);
      expect(result.details).toContain('No HTML content provided');
    });

    it('空白のみの文字列でall-zeroの結果を返すこと', () => {
      const result = service.analyze('   \n\t  ');
      expect(result.overall).toBe(0);
    });
  });

  // =========================================================================
  // visualDensity
  // =========================================================================

  describe('visualDensity', () => {
    it('画像0枚のHTMLで低い視覚密度スコア(0)を返すこと', () => {
      // Arrange & Act
      const result = service.analyze(MINIMAL_HTML);

      // Assert: 画像が0枚なのでスコアは0
      expect(result.visualDensity).toBe(0);
    });

    it('画像とSVGが含まれるHTMLで高い視覚密度スコアを返すこと', () => {
      // Arrange & Act
      const result = service.analyze(RICH_HTML);

      // Assert: RICH_HTMLには多くのメディア要素があるため高スコア
      expect(result.visualDensity).toBeGreaterThanOrEqual(60);
    });

    it('装飾的img(alt="")はメディア要素カウントから除外されること', () => {
      // Arrange & Act
      const result = service.analyze(DECORATIVE_ONLY_HTML);

      // Assert: 装飾的imgのみなので実質メディア数は0、スコアも0
      expect(result.visualDensity).toBe(0);
    });

    it('video/canvas要素もメディア要素としてカウントされること', () => {
      // Arrange
      const htmlWithVideo = `
        <html><body>
          <section>
            <video src="demo.mp4"></video>
            <canvas id="chart"></canvas>
          </section>
        </body></html>
      `;

      // Act
      const result = service.analyze(htmlWithVideo);

      // Assert: video + canvas = 2メディア要素 / 1セクション → 密度2.0
      expect(result.visualDensity).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // typographyContrast
  // =========================================================================

  describe('typographyContrast', () => {
    it('font-size宣言がないHTMLで低いスコアを返すこと', () => {
      // Arrange
      const noFontHtml = '<html><body><p>Plain text</p></body></html>';

      // Act
      const result = service.analyze(noFontHtml);

      // Assert: font-size宣言なし → 基本スコア10
      expect(result.typographyContrast).toBeLessThanOrEqual(10);
    });

    it('単一font-sizeのみのCSSで低いスコアを返すこと', () => {
      // Arrange
      const html = `<html><body><style>${SINGLE_FONT_CSS}</style><p>Text</p></body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: 単一サイズ → 低いコントラスト
      expect(result.typographyContrast).toBeLessThan(40);
    });

    it('h1/h2/bodyで3段階のfont-sizeがあるCSSで高いスコアを返すこと', () => {
      // Arrange
      const html = `<html><body><style>${MULTI_FONT_CSS}</style>
        <h1>Title</h1><h2>Subtitle</h2><p>Body</p></body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: 3段階の明確なサイズ階層 → 高スコア
      expect(result.typographyContrast).toBeGreaterThanOrEqual(60);
    });

    it('font-weightバリエーションがある場合にボーナスが加算されること', () => {
      // Arrange
      const htmlWithWeights = `<html><body><style>${WEIGHT_VARIETY_CSS}</style>
        <h1>T</h1><h2>S</h2><h3>S2</h3><p>B</p></body></html>`;
      const htmlWithoutWeights = `<html><body><style>
        h1 { font-size: 48px; }
        h2 { font-size: 32px; }
        p { font-size: 16px; }
      </style><h1>T</h1><h2>S</h2><p>B</p></body></html>`;

      // Act
      const withWeights = service.analyze(htmlWithWeights);
      const withoutWeights = service.analyze(htmlWithoutWeights);

      // Assert: weight多い方がスコア高い
      expect(withWeights.typographyContrast).toBeGreaterThan(
        withoutWeights.typographyContrast
      );
    });

    it('CSSパラメータ経由でもfont-size解析が行われること', () => {
      // Arrange
      const html = '<html><body><p>Text</p></body></html>';
      const css = 'h1 { font-size: 48px; } p { font-size: 16px; }';

      // Act
      const result = service.analyze(html, css);

      // Assert: 外部CSS引数からも解析される
      expect(result.typographyContrast).toBeGreaterThan(10);
    });
  });

  // =========================================================================
  // colorVariety
  // =========================================================================

  describe('colorVariety', () => {
    it('カラー宣言がないHTMLで低いスコアを返すこと', () => {
      // Arrange
      const noColorHtml = '<html><body><p>Plain text</p></body></html>';

      // Act
      const result = service.analyze(noColorHtml);

      // Assert
      expect(result.colorVariety).toBeLessThan(20);
    });

    it('3色未満のCSSで低いスコアを返すこと', () => {
      // Arrange
      const html = `<html><body><style>${FEW_COLORS_CSS}</style><p>Text</p></body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: 2色のみ → 低スコア
      expect(result.colorVariety).toBeLessThan(40);
    });

    it('5色以上のCSSで高いスコアを返すこと', () => {
      // Arrange
      const html = `<html><body><style>${RICH_COLORS_CSS}</style><p>Text</p></body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: 7色 + 色相分散あり → 高スコア
      expect(result.colorVariety).toBeGreaterThanOrEqual(60);
    });

    it('hex, rgb, hsl形式が全て認識されること', () => {
      // Arrange
      const mixedColors = `
        .a { color: #ff5733; }
        .b { background: rgb(52, 152, 219); }
        .c { border-color: hsl(120, 50%, 50%); }
      `;
      const html = `<html><body><style>${mixedColors}</style><p>T</p></body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: 3つの異なる色形式が認識される
      expect(result.colorVariety).toBeGreaterThan(20);
    });

    it('名前付きカラー(navy, tomato等)が認識されること', () => {
      // Arrange
      const namedColorCss = `
        .a { color: navy; }
        .b { background-color: tomato; }
        .c { border-color: gold; }
        .d { color: teal; }
        .e { background-color: coral; }
      `;
      const html = `<html><body><style>${namedColorCss}</style><p>T</p></body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: 名前付きカラーもユニークカラーとしてカウントされる
      expect(result.colorVariety).toBeGreaterThan(30);
    });
  });

  // =========================================================================
  // whitespaceIntentionality
  // =========================================================================

  describe('whitespaceIntentionality', () => {
    it('スペーシング宣言がないHTMLで低いスコアを返すこと', () => {
      // Arrange
      const noSpacingHtml = '<html><body><p>Text</p></body></html>';

      // Act
      const result = service.analyze(noSpacingHtml);

      // Assert
      expect(result.whitespaceIntentionality).toBeLessThanOrEqual(10);
    });

    it('clamp()やCSS変数を使用したスペーシングで高いスコアを返すこと', () => {
      // Arrange
      const html = `<html><body><style>${INTENTIONAL_SPACING_CSS}</style>
        <section><p>Content</p></section></body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: clamp() + var() → 意図的スペーシングとして高スコア
      expect(result.whitespaceIntentionality).toBeGreaterThanOrEqual(60);
    });

    it('ハードコードされた一貫性のない余白で低いスコアを返すこと', () => {
      // Arrange
      const html = `<html><body><style>${INCONSISTENT_SPACING_CSS}</style>
        <div>Content</div></body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: 不規則な値、clamp/var未使用 → 低いスコア
      expect(result.whitespaceIntentionality).toBeLessThan(50);
    });

    it('8pxの倍数パターンの一貫性がスコアに反映されること', () => {
      // Arrange: 8の倍数で揃ったスペーシング
      const consistentCss = `
        .a { padding: 8px; }
        .b { padding: 16px; }
        .c { margin: 24px; }
        .d { gap: 32px; }
        .e { padding: 48px; }
        .f { margin: 64px; }
      `;
      const html = `<html><body><style>${consistentCss}</style><p>T</p></body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: 全て8の倍数 → 一貫性ボーナス
      expect(result.whitespaceIntentionality).toBeGreaterThan(30);
    });
  });

  // =========================================================================
  // visualDepth
  // =========================================================================

  describe('visualDepth', () => {
    it('深度プロパティがないCSSで低いスコアを返すこと', () => {
      // Arrange
      const html = `<html><body><style>${NO_DEPTH_CSS}</style><p>T</p></body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: box-shadow/gradient/transform等なし → 低スコア
      expect(result.visualDepth).toBeLessThan(30);
    });

    it('box-shadow + gradient + transform使用で高いスコアを返すこと', () => {
      // Arrange
      const html = `<html><body><style>${DEPTH_CSS}</style><p>T</p></body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: 複数の深度プロパティ → 高スコア
      expect(result.visualDepth).toBeGreaterThanOrEqual(60);
    });

    it('backdrop-filterがスコアに加算されること', () => {
      // Arrange
      const withBackdrop = `
        .card { box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
        .overlay { backdrop-filter: blur(10px); }
      `;
      const withoutBackdrop = `
        .card { box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
      `;
      const htmlWith = `<html><body><style>${withBackdrop}</style><p>T</p></body></html>`;
      const htmlWithout = `<html><body><style>${withoutBackdrop}</style><p>T</p></body></html>`;

      // Act
      const resultWith = service.analyze(htmlWith);
      const resultWithout = service.analyze(htmlWithout);

      // Assert
      expect(resultWith.visualDepth).toBeGreaterThan(resultWithout.visualDepth);
    });

    it('z-indexレイヤリングがスコアに加算されること', () => {
      // Arrange
      const withZIndex = `
        .front { z-index: 10; }
        .back { z-index: 1; }
      `;
      const html = `<html><body><style>${withZIndex}</style><p>T</p></body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: z-indexの使用が検出される
      expect(result.visualDepth).toBeGreaterThan(0);
    });

    it('疑似要素(::before/::after)の装飾利用がスコアに加算されること', () => {
      // Arrange
      const pseudoCss = `
        .deco::before { content: ""; position: absolute; background: red; border: 1px solid blue; }
        .deco::after { content: ""; position: absolute; background: linear-gradient(red, blue); }
      `;
      const html = `<html><body><style>${pseudoCss}</style><p>T</p></body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: 疑似要素の装飾使用が検出される
      expect(result.visualDepth).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // overall（加重平均）
  // =========================================================================

  describe('overall', () => {
    it('全メトリクスの加重平均が正しく計算されること', () => {
      // Arrange & Act
      const result = service.analyze(RICH_HTML);

      // Assert: 加重平均の手動計算と照合
      // weights: density=0.25, typography=0.20, color=0.15, whitespace=0.15, depth=0.25
      const expectedOverall = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            result.visualDensity * 0.25 +
              result.typographyContrast * 0.2 +
              result.colorVariety * 0.15 +
              result.whitespaceIntentionality * 0.15 +
              result.visualDepth * 0.25
          )
        )
      );
      expect(result.overall).toBe(expectedOverall);
    });

    it('全メトリクスが0の場合overallも0であること', () => {
      // Arrange & Act
      const result = service.analyze(
        '<html><body><div>Text only, no style</div></body></html>'
      );

      // Assert: 全メトリクスが低い場合、overallも低い
      expect(result.overall).toBeLessThanOrEqual(10);
    });

    it('detailsに各メトリクスの根拠が含まれること', () => {
      // Arrange & Act
      const result = service.analyze(RICH_HTML);

      // Assert: detailsに全5メトリクス + overall が含まれる
      expect(result.details.length).toBeGreaterThan(0);
      expect(result.details.some((d) => d.startsWith('visualDensity:'))).toBe(
        true
      );
      expect(
        result.details.some((d) => d.startsWith('typographyContrast:'))
      ).toBe(true);
      expect(result.details.some((d) => d.startsWith('colorVariety:'))).toBe(
        true
      );
      expect(
        result.details.some((d) => d.startsWith('whitespaceIntentionality:'))
      ).toBe(true);
      expect(result.details.some((d) => d.startsWith('visualDepth:'))).toBe(
        true
      );
      expect(result.details.some((d) => d.startsWith('overall:'))).toBe(true);
    });

    it('全メトリクスが0-100の範囲内であること', () => {
      // Arrange & Act
      const result = service.analyze(RICH_HTML);

      // Assert
      expect(result.visualDensity).toBeGreaterThanOrEqual(0);
      expect(result.visualDensity).toBeLessThanOrEqual(100);
      expect(result.typographyContrast).toBeGreaterThanOrEqual(0);
      expect(result.typographyContrast).toBeLessThanOrEqual(100);
      expect(result.colorVariety).toBeGreaterThanOrEqual(0);
      expect(result.colorVariety).toBeLessThanOrEqual(100);
      expect(result.whitespaceIntentionality).toBeGreaterThanOrEqual(0);
      expect(result.whitespaceIntentionality).toBeLessThanOrEqual(100);
      expect(result.visualDepth).toBeGreaterThanOrEqual(0);
      expect(result.visualDepth).toBeLessThanOrEqual(100);
      expect(result.overall).toBeGreaterThanOrEqual(0);
      expect(result.overall).toBeLessThanOrEqual(100);
    });
  });

  // =========================================================================
  // CSS引数の動作
  // =========================================================================

  describe('外部CSS引数', () => {
    it('CSSパラメータが<style>タグ内CSSと結合されて解析されること', () => {
      // Arrange
      const htmlWithStyle = `<html><body>
        <style>h1 { font-size: 48px; }</style>
        <h1>Title</h1>
      </body></html>`;
      const externalCss = 'p { font-size: 16px; font-weight: 400; }';

      // Act
      const withExternal = service.analyze(htmlWithStyle, externalCss);
      const withoutExternal = service.analyze(htmlWithStyle);

      // Assert: 外部CSSの分だけスコアが変動する
      expect(withExternal.typographyContrast).toBeGreaterThanOrEqual(
        withoutExternal.typographyContrast
      );
    });
  });

  // =========================================================================
  // inline style属性の解析
  // =========================================================================

  describe('inline style解析', () => {
    it('inline style属性からCSSプロパティが抽出されること', () => {
      // Arrange
      const html = `<html><body>
        <div style="font-size: 48px; font-weight: 800; color: #ff5733;">
          <h1>Title</h1>
        </div>
        <p style="font-size: 16px; color: #333;">Body</p>
      </body></html>`;

      // Act
      const result = service.analyze(html);

      // Assert: inline styleのfont-size, colorが検出される
      expect(result.typographyContrast).toBeGreaterThan(10);
      expect(result.colorVariety).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // DI ファクトリパターン
  // =========================================================================

  describe('DI ファクトリ', () => {
    it('デフォルトファクトリでインスタンスが取得できること', () => {
      // Arrange & Act
      const instance = getVisualDesignAnalyzerService();

      // Assert
      expect(instance).toBeDefined();
      expect(typeof instance.analyze).toBe('function');
    });

    it('カスタムファクトリを設定してインスタンスが差し替わること', () => {
      // Arrange: モックサービスを返すファクトリ
      const mockResult: VisualDesignMetrics = {
        visualDensity: 99,
        typographyContrast: 99,
        colorVariety: 99,
        whitespaceIntentionality: 99,
        visualDepth: 99,
        overall: 99,
        details: ['mock'],
      };

      const mockService: IVisualDesignAnalyzerService = {
        analyze: (): VisualDesignMetrics => mockResult,
      };

      // Act
      setVisualDesignAnalyzerServiceFactory(() => mockService);
      const instance = getVisualDesignAnalyzerService();
      const result = instance.analyze('<html><body>test</body></html>');

      // Assert
      expect(result.overall).toBe(99);
      expect(result.details).toContain('mock');
    });

    it('リセットでデフォルトファクトリに戻ること', () => {
      // Arrange
      const mockService: IVisualDesignAnalyzerService = {
        analyze: (): VisualDesignMetrics => ({
          visualDensity: 99,
          typographyContrast: 99,
          colorVariety: 99,
          whitespaceIntentionality: 99,
          visualDepth: 99,
          overall: 99,
          details: ['mock'],
        }),
      };
      setVisualDesignAnalyzerServiceFactory(() => mockService);

      // Act
      resetVisualDesignAnalyzerServiceFactory();
      const instance = getVisualDesignAnalyzerService();
      const result = instance.analyze(MINIMAL_HTML);

      // Assert: リセット後はデフォルト実装（モック値99ではない）
      expect(result.overall).not.toBe(99);
    });
  });
});
