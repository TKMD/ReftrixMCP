// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ContentGapDetectorService テスト
 *
 * HTMLコンテンツ要素のギャップ検出サービスのユニットテスト
 *
 * テスト対象:
 * - 要素カウント（img, svg, icon, video/canvas, background-image）
 * - 装飾的img(alt="")の除外
 * - ギャップ検出（critical / high / medium / low）
 * - スコア計算（ペナルティ + 密度ボーナス）
 * - DIファクトリパターン
 *
 * @module tests/services/quality/content-gap-detector.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ContentGapDetectorService,
  getContentGapDetectorService,
  setContentGapDetectorServiceFactory,
  resetContentGapDetectorServiceFactory,
  type ContentGapResult,
  type IContentGapDetectorService,
} from '../../../src/services/quality/content-gap-detector.service.js';

// =============================================================================
// テスト用HTML定義
// =============================================================================

/** 画像なしのシンプルHTML */
const NO_IMAGE_HTML = `
<html><body>
  <section><h1>Title</h1><p>Text only content.</p></section>
  <section><h2>Features</h2><p>No visual elements at all.</p></section>
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

/** 実質的画像（alt属性あり）を含むHTML */
const IMAGES_HTML = `
<html><body>
  <section>
    <h1>Products</h1>
    <img src="product1.jpg" alt="Product A" />
    <img src="product2.jpg" alt="Product B" />
    <img src="product3.jpg" alt="Product C" />
  </section>
</body></html>
`;

/** SVG要素を含むHTML */
const SVG_HTML = `
<html><body>
  <section>
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>
    <svg viewBox="0 0 24 24"><rect width="20" height="20"/></svg>
  </section>
</body></html>
`;

/** アイコンフォント要素を含むHTML */
const ICON_HTML = `
<html><body>
  <section>
    <i class="fa-home"></i>
    <i class="fa-user"></i>
    <span class="material-icons">search</span>
    <i class="icon-settings"></i>
  </section>
</body></html>
`;

/** video/canvas要素を含むHTML */
const VIDEO_CANVAS_HTML = `
<html><body>
  <section>
    <video src="intro.mp4" controls></video>
    <canvas id="chart" width="400" height="300"></canvas>
  </section>
</body></html>
`;

/** CSS background-image を含むHTML */
const BG_IMAGE_HTML = `
<html><body>
  <style>
    .hero { background-image: url('hero-bg.jpg'); }
    .banner { background: url('banner.png') no-repeat center; }
  </style>
  <section>
    <div class="hero"><h1>Hero</h1></div>
    <div class="banner"><p>Banner</p></div>
  </section>
</body></html>
`;

/** inline style に background-image を含むHTML */
const INLINE_BG_IMAGE_HTML = `
<html><body>
  <section>
    <div style="background-image: url('hero-bg.jpg');">Hero</div>
    <div style="background: url('pattern.svg') repeat;">Pattern</div>
  </section>
</body></html>
`;

/** 全種類のコンテンツ要素を豊富に含むHTML */
const RICH_CONTENT_HTML = `
<html><body>
  <style>
    .hero { background-image: url('hero-bg.jpg'); }
    .section-bg { background: url('texture.png') repeat; }
  </style>
  <section>
    <h1>Hero</h1>
    <img src="hero.jpg" alt="Hero image" />
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>
    <i class="fa-star"></i>
    <i class="icon-badge"></i>
  </section>
  <article>
    <h2>Features</h2>
    <img src="feature1.jpg" alt="Feature 1" />
    <img src="feature2.jpg" alt="Feature 2" />
    <svg viewBox="0 0 100 100"><rect width="80" height="80"/></svg>
    <i class="fa-check"></i>
  </article>
  <section>
    <h2>Demo</h2>
    <video src="demo.mp4"></video>
    <img src="demo-thumb.jpg" alt="Demo thumbnail" />
  </section>
</body></html>
`;

/** セクションが多くコンテンツが少ないHTML（低密度） */
const LOW_DENSITY_HTML = `
<html><body>
  <section><h1>Section 1</h1><p>Text only.</p></section>
  <section><h2>Section 2</h2><p>Text only.</p></section>
  <article><h2>Article 1</h2><p>Text only.</p></article>
  <section><h2>Section 3</h2><p>Text only.</p></section>
</body></html>
`;

// =============================================================================
// テスト本体
// =============================================================================

describe('ContentGapDetectorService', () => {
  let service: ContentGapDetectorService;

  beforeEach(() => {
    service = new ContentGapDetectorService();
  });

  afterEach(() => {
    resetContentGapDetectorServiceFactory();
  });

  // =========================================================================
  // 空入力処理
  // =========================================================================

  describe('空入力処理', () => {
    it('空文字列で空の結果を返すこと', () => {
      // Arrange & Act
      const result = service.detect('');

      // Assert
      expect(result.totalImages).toBe(0);
      expect(result.totalSvgs).toBe(0);
      expect(result.totalIcons).toBe(0);
      expect(result.totalVideos).toBe(0);
      expect(result.totalBackgroundImages).toBe(0);
      expect(result.sectionCount).toBe(0);
      expect(result.score).toBe(0);
      expect(result.gaps).toHaveLength(0);
      expect(result.details).toContain('Empty HTML provided. No content to analyze.');
    });

    it('空白のみの文字列で空の結果を返すこと', () => {
      const result = service.detect('   \n\t  ');
      expect(result.score).toBe(0);
    });
  });

  // =========================================================================
  // 要素カウント
  // =========================================================================

  describe('要素カウント', () => {
    it('img要素を正しくカウントすること', () => {
      // Arrange & Act
      const result = service.detect(IMAGES_HTML);

      // Assert: 3つのimg要素（全てalt属性あり）
      expect(result.totalImages).toBe(3);
    });

    it('装飾的img(alt="")を実質画像カウントから除外すること', () => {
      // Arrange & Act
      const result = service.detect(DECORATIVE_ONLY_HTML);

      // Assert: alt=""の画像は除外
      expect(result.totalImages).toBe(0);
    });

    it('装飾的imgと実質的imgを正しく区別すること', () => {
      // Arrange
      const mixedHtml = `
        <html><body><section>
          <img src="hero.jpg" alt="Hero image" />
          <img src="divider.png" alt="" />
          <img src="product.jpg" alt="Product" />
        </section></body></html>
      `;

      // Act
      const result = service.detect(mixedHtml);

      // Assert: alt=""の1つのみ除外、残り2つがカウントされる
      expect(result.totalImages).toBe(2);
    });

    it('SVG要素を正しくカウントすること', () => {
      // Arrange & Act
      const result = service.detect(SVG_HTML);

      // Assert
      expect(result.totalSvgs).toBe(2);
    });

    it('アイコンフォント要素を検出すること', () => {
      // Arrange & Act
      const result = service.detect(ICON_HTML);

      // Assert: fa-xxx, material-icons, icon-xxx を全て検出
      expect(result.totalIcons).toBe(4);
    });

    it('video/canvas要素をカウントすること', () => {
      // Arrange & Act
      const result = service.detect(VIDEO_CANVAS_HTML);

      // Assert
      expect(result.totalVideos).toBe(2);
    });

    it('CSS <style>タグ内のbackground-image: url()を検出すること', () => {
      // Arrange & Act
      const result = service.detect(BG_IMAGE_HTML);

      // Assert: <style>タグ内に2つのbackground-image
      expect(result.totalBackgroundImages).toBe(2);
    });

    it('inline style属性内のbackground-image: url()を検出すること', () => {
      // Arrange & Act
      const result = service.detect(INLINE_BG_IMAGE_HTML);

      // Assert
      expect(result.totalBackgroundImages).toBe(2);
    });

    it('外部CSSパラメータのbackground-image: url()を検出すること', () => {
      // Arrange
      const html = '<html><body><section><p>Content</p></section></body></html>';
      const css = `.hero { background-image: url('hero.jpg'); }
                   .banner { background: url('banner.png') center; }`;

      // Act
      const result = service.detect(html, css);

      // Assert
      expect(result.totalBackgroundImages).toBe(2);
    });

    it('セクション数を正しくカウントすること', () => {
      // Arrange & Act
      const result = service.detect(RICH_CONTENT_HTML);

      // Assert: 2 section + 1 article = 3
      expect(result.sectionCount).toBe(3);
    });

    it('role属性のセクションも検出すること', () => {
      // Arrange
      const html = `
        <html><body>
          <div role="region"><p>Content</p></div>
          <div role="main"><p>Main content</p></div>
        </body></html>
      `;

      // Act
      const result = service.detect(html);

      // Assert
      expect(result.sectionCount).toBe(2);
    });
  });

  // =========================================================================
  // ギャップ検出
  // =========================================================================

  describe('ギャップ検出', () => {
    it('画像0枚でcriticalギャップを検出すること', () => {
      // Arrange & Act
      const result = service.detect(NO_IMAGE_HTML);

      // Assert
      const criticalGap = result.gaps.find(
        (g) => g.type === 'image' && g.severity === 'critical'
      );
      expect(criticalGap).toBeDefined();
      expect(criticalGap?.count).toBe(0);
    });

    it('SVG/アイコン0個でhighギャップを検出すること', () => {
      // Arrange: 画像はあるがSVG/アイコンがないHTML
      const noIconHtml = `
        <html><body>
          <section>
            <img src="photo.jpg" alt="Photo" />
            <p>Text content</p>
          </section>
        </body></html>
      `;

      // Act
      const result = service.detect(noIconHtml);

      // Assert
      const iconGap = result.gaps.find(
        (g) => g.type === 'icon' && g.severity === 'high'
      );
      expect(iconGap).toBeDefined();
    });

    it('低コンテンツ密度でmediumギャップを検出すること', () => {
      // Arrange & Act: セクション4つに対してコンテンツなし
      const result = service.detect(LOW_DENSITY_HTML);

      // Assert
      const densityGap = result.gaps.find((g) => g.severity === 'medium');
      expect(densityGap).toBeDefined();
      expect(result.contentDensity).toBeLessThan(0.5);
    });

    it('background-image 0個でlowギャップを検出すること', () => {
      // Arrange & Act
      const result = service.detect(IMAGES_HTML);

      // Assert: background-image がない
      const bgGap = result.gaps.find(
        (g) => g.type === 'background' && g.severity === 'low'
      );
      expect(bgGap).toBeDefined();
    });

    it('十分なコンテンツでcritical/highギャップが0件であること', () => {
      // Arrange & Act
      const result = service.detect(RICH_CONTENT_HTML);

      // Assert: 画像あり + SVGあり + アイコンあり → critical/highギャップなし
      const criticalOrHigh = result.gaps.filter(
        (g) => g.severity === 'critical' || g.severity === 'high'
      );
      expect(criticalOrHigh).toHaveLength(0);
    });
  });

  // =========================================================================
  // コンテンツ密度計算
  // =========================================================================

  describe('コンテンツ密度', () => {
    it('密度が正しく計算されること', () => {
      // Arrange & Act
      const result = service.detect(RICH_CONTENT_HTML);

      // Assert: 総コンテンツ要素 / セクション数
      const totalElements =
        result.totalImages +
        result.totalSvgs +
        result.totalIcons +
        result.totalVideos +
        result.totalBackgroundImages;
      const expectedDensity = totalElements / Math.max(1, result.sectionCount);
      expect(result.contentDensity).toBeCloseTo(expectedDensity, 2);
    });

    it('セクション0個でも密度が計算されること（除算ゼロ回避）', () => {
      // Arrange: セクションがないHTML
      const noSectionHtml = `
        <html><body>
          <div>
            <img src="photo.jpg" alt="Photo" />
            <p>Content</p>
          </div>
        </body></html>
      `;

      // Act
      const result = service.detect(noSectionHtml);

      // Assert: sectionCount=0でも密度計算が正常動作（0除算なし）
      expect(result.contentDensity).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.contentDensity)).toBe(true);
    });
  });

  // =========================================================================
  // スコア計算
  // =========================================================================

  describe('スコア計算', () => {
    it('画像0枚でスコアが大幅に低下すること', () => {
      // Arrange & Act
      const result = service.detect(NO_IMAGE_HTML);

      // Assert: critical(-30) + high(-20) + medium(-10) + low(-5) = 35ペナルティ
      expect(result.score).toBeLessThanOrEqual(70);
    });

    it('リッチなコンテンツで高スコアを返すこと', () => {
      // Arrange & Act
      const result = service.detect(RICH_CONTENT_HTML);

      // Assert: ギャップが少ない → 高スコア
      expect(result.score).toBeGreaterThanOrEqual(80);
    });

    it('スコアが0-100の範囲内であること', () => {
      // Arrange & Act
      const noContent = service.detect(NO_IMAGE_HTML);
      const rich = service.detect(RICH_CONTENT_HTML);

      // Assert
      expect(noContent.score).toBeGreaterThanOrEqual(0);
      expect(noContent.score).toBeLessThanOrEqual(100);
      expect(rich.score).toBeGreaterThanOrEqual(0);
      expect(rich.score).toBeLessThanOrEqual(100);
    });

    it('高密度コンテンツで密度ボーナスが加算されること', () => {
      // Arrange: 1セクション内に大量のコンテンツ要素
      const highDensityHtml = `
        <html><body>
          <section>
            <img src="1.jpg" alt="1" />
            <img src="2.jpg" alt="2" />
            <img src="3.jpg" alt="3" />
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>
            <svg viewBox="0 0 24 24"><rect width="20" height="20"/></svg>
            <i class="fa-star"></i>
            <i class="fa-check"></i>
            <video src="demo.mp4"></video>
          </section>
        </body></html>
      `;

      // Act
      const result = service.detect(highDensityHtml);

      // Assert: 密度 >= 2.0 → ボーナス加算
      expect(result.contentDensity).toBeGreaterThanOrEqual(2.0);
      // critical/highギャップなし → 基本スコア高い
      const criticalOrHigh = result.gaps.filter(
        (g) => g.severity === 'critical' || g.severity === 'high'
      );
      expect(criticalOrHigh).toHaveLength(0);
    });
  });

  // =========================================================================
  // 詳細情報
  // =========================================================================

  describe('詳細情報', () => {
    it('detailsにコンテンツ要素数が記載されること', () => {
      // Arrange & Act
      const result = service.detect(RICH_CONTENT_HTML);

      // Assert
      expect(result.details.some((d) => d.startsWith('Content images:'))).toBe(
        true
      );
      expect(result.details.some((d) => d.startsWith('Inline SVGs:'))).toBe(
        true
      );
      expect(result.details.some((d) => d.startsWith('Icon elements:'))).toBe(
        true
      );
      expect(
        result.details.some((d) => d.startsWith('Video/Canvas elements:'))
      ).toBe(true);
      expect(
        result.details.some((d) => d.startsWith('CSS background images:'))
      ).toBe(true);
      expect(
        result.details.some((d) => d.startsWith('Sections detected:'))
      ).toBe(true);
      expect(
        result.details.some((d) => d.startsWith('Content density:'))
      ).toBe(true);
    });

    it('ギャップがある場合にdetailsにギャップ情報が含まれること', () => {
      // Arrange & Act
      const result = service.detect(NO_IMAGE_HTML);

      // Assert
      expect(result.details.some((d) => d.includes('[CRITICAL]'))).toBe(true);
    });

    it('ギャップがない場合に「No content gaps detected」が含まれること', () => {
      // Arrange: ギャップなしの状態を作る
      // RICH_CONTENT_HTMLにbackground-imageを追加してlowギャップも消す
      const noGapHtml = `
        <html><body>
          <style>.hero { background-image: url('hero.jpg'); }</style>
          <section>
            <img src="hero.jpg" alt="Hero" />
            <img src="feature.jpg" alt="Feature" />
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>
            <i class="fa-star"></i>
            <i class="fa-check"></i>
            <video src="demo.mp4"></video>
          </section>
        </body></html>
      `;

      // Act
      const result = service.detect(noGapHtml);

      // Assert: ギャップなし
      expect(result.gaps).toHaveLength(0);
      expect(
        result.details.some((d) => d.includes('No content gaps detected'))
      ).toBe(true);
    });
  });

  // =========================================================================
  // DI ファクトリパターン
  // =========================================================================

  describe('DI ファクトリ', () => {
    it('デフォルトファクトリでインスタンスが取得できること', () => {
      // Arrange & Act
      const instance = getContentGapDetectorService();

      // Assert
      expect(instance).toBeDefined();
      expect(typeof instance.detect).toBe('function');
    });

    it('カスタムファクトリを設定してインスタンスが差し替わること', () => {
      // Arrange
      const mockResult: ContentGapResult = {
        totalImages: 99,
        totalSvgs: 99,
        totalIcons: 99,
        totalVideos: 99,
        totalBackgroundImages: 99,
        sectionCount: 99,
        contentDensity: 99,
        gaps: [],
        score: 99,
        details: ['mock'],
      };
      const mockService: IContentGapDetectorService = {
        detect: (): ContentGapResult => mockResult,
      };

      // Act
      setContentGapDetectorServiceFactory(() => mockService);
      const instance = getContentGapDetectorService();
      const result = instance.detect('<html></html>');

      // Assert
      expect(result.score).toBe(99);
      expect(result.totalImages).toBe(99);
    });

    it('リセットでデフォルトファクトリに戻ること', () => {
      // Arrange
      const mockService: IContentGapDetectorService = {
        detect: (): ContentGapResult => ({
          totalImages: 99,
          totalSvgs: 99,
          totalIcons: 99,
          totalVideos: 99,
          totalBackgroundImages: 99,
          sectionCount: 99,
          contentDensity: 99,
          gaps: [],
          score: 99,
          details: ['mock'],
        }),
      };
      setContentGapDetectorServiceFactory(() => mockService);

      // Act
      resetContentGapDetectorServiceFactory();
      const instance = getContentGapDetectorService();
      const result = instance.detect(NO_IMAGE_HTML);

      // Assert: リセット後はデフォルト実装（モック値99ではない）
      expect(result.score).not.toBe(99);
      expect(result.totalImages).not.toBe(99);
    });
  });
});
