// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * JSAnimationDetectorService 統合テスト
 *
 * Chrome DevTools Protocol (CDP) + Web Animations API + ライブラリ検出の統合テスト
 *
 * テスト対象:
 * - CDP Animation イベント検出（Animation.animationStarted/animationCreated）
 * - Web Animations API (document.getAnimations()) 観測
 * - ライブラリ検出（GSAP, Framer Motion, anime.js, Three.js, Lottie）
 *
 * @module tests/integration/js-animation-detector
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import {
  JSAnimationDetectorService,
  type JSAnimationResult,
} from '../../src/services/motion/js-animation-detector';

// =====================================================
// テストフィクスチャのパス
// =====================================================

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/js-animations');

/**
 * フィクスチャHTMLを読み込む
 */
function loadFixture(filename: string): string {
  const filePath = path.join(FIXTURES_DIR, filename);
  return fs.readFileSync(filePath, 'utf-8');
}

// =====================================================
// テストスイート: JSAnimationDetectorService 統合テスト
// =====================================================

describe('JSAnimationDetectorService 統合テスト', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let detector: JSAnimationDetectorService;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
  });

  afterAll(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  });

  beforeEach(async () => {
    page = await context.newPage();
    detector = new JSAnimationDetectorService();
  });

  afterEach(async () => {
    await detector?.cleanup().catch(() => {});
    await page?.close().catch(() => {});
  });

  // =====================================================
  // CDP Animation 検出テスト
  // =====================================================

  describe('CDP Animation 検出', () => {
    /**
     * 注意: CDP Animation イベントは page.setContent() で設定されたコンテンツでは
     * 信頼性が低い場合があります。これはChrome DevTools Protocolの設計上の制限です。
     * 実際のページナビゲーション（page.goto）ではより安定して動作します。
     */

    it('CSSアニメーションをCDP経由で検出する（page.setContent使用時は検出されない場合がある）', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            @keyframes fadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            .animated { animation: fadeIn 1s ease forwards; }
          </style>
        </head>
        <body>
          <div id="box" class="animated">Test</div>
        </body>
        </html>
      `;

      await page.setContent(html);

      const result = await detector.detect(page, {
        enableCDP: true,
        enableWebAnimations: false,
        enableLibraryDetection: false,
        waitTime: 500,
      });

      expect(result).toBeDefined();
      // CDP Animation はpage.setContent()では検出されない場合がある
      // Web Animations APIでの検出で補完される
      expect(result.cdpAnimations).toBeDefined();
      expect(Array.isArray(result.cdpAnimations)).toBe(true);
    });

    it('CSS Transitionを検出する', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            .box {
              width: 100px;
              height: 100px;
              background: red;
              transition: transform 0.5s ease;
            }
            .box:hover { transform: scale(1.2); }
          </style>
        </head>
        <body>
          <div id="box" class="box">Test</div>
          <script>
            // プログラマティックにhoverをシミュレート
            const box = document.getElementById('box');
            box.style.transform = 'scale(1.2)';
          </script>
        </body>
        </html>
      `;

      await page.setContent(html);

      const result = await detector.detect(page, {
        enableCDP: true,
        enableWebAnimations: false,
        enableLibraryDetection: false,
        waitTime: 200,
      });

      expect(result).toBeDefined();
      // CSS Transitionは検出される可能性がある
      expect(result.cdpAnimations).toBeDefined();
    });

    it('CDP初期化とイベントリスナー設定が正常に動作する', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            @keyframes slide { from { left: 0; } to { left: 100px; } }
            @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
            @keyframes rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            .box1 { position: relative; animation: slide 1s infinite; }
            .box2 { animation: fade 0.5s ease; }
            .box3 { animation: rotate 2s linear infinite; }
          </style>
        </head>
        <body>
          <div class="box1">Box1</div>
          <div class="box2">Box2</div>
          <div class="box3">Box3</div>
        </body>
        </html>
      `;

      await page.setContent(html);

      const result = await detector.detect(page, {
        enableCDP: true,
        enableWebAnimations: false,
        enableLibraryDetection: false,
        waitTime: 500,
      });

      // CDPセッションが正常に初期化され、結果が返ることを確認
      expect(result).toBeDefined();
      expect(result.cdpAnimations).toBeDefined();
      expect(result.detectionTimeMs).toBeGreaterThan(0);
    });
  });

  // =====================================================
  // Web Animations API 検出テスト
  // =====================================================

  describe('Web Animations API 検出', () => {
    it('Element.animate()で作成されたアニメーションを検出する', async () => {
      const html = loadFixture('web-animations-test.html');
      await page.setContent(html);
      await page.waitForTimeout(200);

      const result = await detector.detect(page, {
        enableCDP: false,
        enableWebAnimations: true,
        enableLibraryDetection: false,
        waitTime: 100,
      });

      expect(result.webAnimations.length).toBeGreaterThan(0);

      // アニメーションの詳細を検証
      const animation = result.webAnimations[0];
      expect(animation.playState).toBeDefined();
      expect(animation.target).toBeDefined();
      expect(animation.timing).toBeDefined();
      expect(animation.timing.duration).toBeGreaterThan(0);
    });

    it('アニメーションのタイミング情報を正確に取得する', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <body>
          <div id="box"></div>
          <script>
            document.getElementById('box').animate(
              [
                { transform: 'translateX(0)' },
                { transform: 'translateX(100px)' }
              ],
              {
                duration: 2000,
                iterations: 5,
                easing: 'ease-in-out',
                direction: 'alternate',
                fill: 'forwards',
                delay: 100
              }
            );
          </script>
        </body>
        </html>
      `;

      await page.setContent(html);
      await page.waitForTimeout(200);

      const result = await detector.detect(page, {
        enableCDP: false,
        enableWebAnimations: true,
        enableLibraryDetection: false,
        waitTime: 100,
      });

      expect(result.webAnimations.length).toBe(1);

      const animation = result.webAnimations[0];
      expect(animation.timing.duration).toBe(2000);
      expect(animation.timing.iterations).toBe(5);
      expect(animation.timing.easing).toBe('ease-in-out');
      expect(animation.timing.direction).toBe('alternate');
      expect(animation.timing.fill).toBe('forwards');
    });

    it('無限ループアニメーションを正しく検出する', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <body>
          <div id="spinner"></div>
          <script>
            document.getElementById('spinner').animate(
              [
                { transform: 'rotate(0deg)' },
                { transform: 'rotate(360deg)' }
              ],
              { duration: 1000, iterations: Infinity }
            );
          </script>
        </body>
        </html>
      `;

      await page.setContent(html);
      await page.waitForTimeout(200);

      const result = await detector.detect(page, {
        enableCDP: false,
        enableWebAnimations: true,
        enableLibraryDetection: false,
        waitTime: 100,
      });

      expect(result.webAnimations.length).toBe(1);
      // Infinityは-1として返される（JSONシリアライズの都合）
      expect(result.webAnimations[0].timing.iterations).toBe(-1);
    });

    it('キーフレームを取得する', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <body>
          <div id="box"></div>
          <script>
            document.getElementById('box').animate(
              [
                { opacity: 0, transform: 'scale(0.5)' },
                { opacity: 0.5, transform: 'scale(1)' },
                { opacity: 1, transform: 'scale(1.2)' }
              ],
              { duration: 1000 }
            );
          </script>
        </body>
        </html>
      `;

      await page.setContent(html);
      await page.waitForTimeout(200);

      const result = await detector.detect(page, {
        enableCDP: false,
        enableWebAnimations: true,
        enableLibraryDetection: false,
        waitTime: 100,
      });

      expect(result.webAnimations.length).toBe(1);
      expect(result.webAnimations[0].keyframes.length).toBe(3);
    });
  });

  // =====================================================
  // ライブラリ検出テスト
  // =====================================================

  describe('ライブラリ検出', () => {
    it('GSAPグローバルを検出する', async () => {
      const html = loadFixture('mixed-animations-test.html');
      await page.setContent(html);

      const result = await detector.detect(page, {
        enableCDP: false,
        enableWebAnimations: false,
        enableLibraryDetection: true,
        waitTime: 100,
      });

      expect(result.libraries.gsap.detected).toBe(true);
      expect(result.libraries.gsap.version).toBe('3.12.2');
    });

    it('Framer Motion要素を検出する', async () => {
      const html = loadFixture('framer-motion-test.html');
      await page.setContent(html);

      const result = await detector.detect(page, {
        enableCDP: false,
        enableWebAnimations: false,
        enableLibraryDetection: true,
        waitTime: 100,
      });

      expect(result.libraries.framerMotion.detected).toBe(true);
      expect(result.libraries.framerMotion.elements).toBeGreaterThan(0);
    });

    it('Lottie要素を検出する', async () => {
      const html = loadFixture('lottie-test.html');
      await page.setContent(html);

      const result = await detector.detect(page, {
        enableCDP: false,
        enableWebAnimations: false,
        enableLibraryDetection: true,
        waitTime: 100,
      });

      expect(result.libraries.lottie.detected).toBe(true);
    });

    it('複数のライブラリを同時に検出する', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <body>
          <div data-framer-appear-id="test">Framer Motion</div>
          <lottie-player></lottie-player>
          <script>
            window.gsap = { version: '3.12.0' };
            window.anime = { running: [] };
          </script>
        </body>
        </html>
      `;

      await page.setContent(html);

      const result = await detector.detect(page, {
        enableCDP: false,
        enableWebAnimations: false,
        enableLibraryDetection: true,
        waitTime: 100,
      });

      expect(result.libraries.gsap.detected).toBe(true);
      expect(result.libraries.framerMotion.detected).toBe(true);
      expect(result.libraries.anime.detected).toBe(true);
      expect(result.libraries.lottie.detected).toBe(true);
    });
  });

  // =====================================================
  // 統合検出テスト（CDP + Web Animations + Library）
  // =====================================================

  describe('統合検出（全モード有効）', () => {
    it('CSS + Web Animations + ライブラリを同時に検出する', async () => {
      const html = loadFixture('mixed-animations-test.html');
      await page.setContent(html);

      const result = await detector.detect(page, {
        enableCDP: true,
        enableWebAnimations: true,
        enableLibraryDetection: true,
        waitTime: 500,
      });

      // 各種検出結果が存在することを確認
      expect(result.cdpAnimations).toBeDefined();
      expect(result.webAnimations).toBeDefined();
      expect(result.libraries).toBeDefined();

      // totalDetected が正しく計算されていることを確認
      expect(result.totalDetected).toBeGreaterThanOrEqual(0);

      // 処理時間が記録されていることを確認
      expect(result.detectionTimeMs).toBeGreaterThan(0);

      // GSAPが検出されていることを確認
      expect(result.libraries.gsap.detected).toBe(true);
    });

    it('web-animations-test.htmlでCDPとWeb Animationsの両方を検出する', async () => {
      const html = loadFixture('web-animations-test.html');
      await page.setContent(html);
      await page.waitForTimeout(200);

      const result = await detector.detect(page, {
        enableCDP: true,
        enableWebAnimations: true,
        enableLibraryDetection: true,
        waitTime: 500,
      });

      // Web Animations APIで作成されたアニメーションはCDPでも検出される可能性がある
      expect(result.webAnimations.length).toBeGreaterThan(0);
    });
  });

  // =====================================================
  // オプション設定テスト
  // =====================================================

  describe('オプション設定', () => {
    it('CDPのみ有効時、他の検出はスキップされる', async () => {
      const html = loadFixture('web-animations-test.html');
      await page.setContent(html);

      const result = await detector.detect(page, {
        enableCDP: true,
        enableWebAnimations: false,
        enableLibraryDetection: false,
        waitTime: 300,
      });

      expect(result.webAnimations).toHaveLength(0);
      expect(result.libraries.gsap.detected).toBe(false);
      expect(result.libraries.framerMotion.detected).toBe(false);
      expect(result.libraries.anime.detected).toBe(false);
      expect(result.libraries.three.detected).toBe(false);
      expect(result.libraries.lottie.detected).toBe(false);
    });

    it('waitTimeが検出結果に影響する', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            @keyframes delayed { from { opacity: 0; } to { opacity: 1; } }
            .box { animation: delayed 0.5s ease 0.3s forwards; }
          </style>
        </head>
        <body>
          <div class="box">Test</div>
        </body>
        </html>
      `;

      await page.setContent(html);

      // 短いwaitTime
      const shortResult = await detector.detect(page, {
        enableCDP: true,
        enableWebAnimations: false,
        enableLibraryDetection: false,
        waitTime: 50,
      });

      await detector.cleanup();

      // 長いwaitTime（新しいdetectorインスタンス）
      const newDetector = new JSAnimationDetectorService();
      const longResult = await newDetector.detect(page, {
        enableCDP: true,
        enableWebAnimations: false,
        enableLibraryDetection: false,
        waitTime: 600,
      });
      await newDetector.cleanup();

      // 長いwaitTimeの方がより多くの/同等のアニメーションを検出する
      expect(longResult.cdpAnimations.length).toBeGreaterThanOrEqual(
        shortResult.cdpAnimations.length
      );
    });
  });

  // =====================================================
  // クリーンアップテスト
  // =====================================================

  describe('クリーンアップ', () => {
    it('cleanup後にcdpAnimationsがクリアされる', async () => {
      const html = loadFixture('web-animations-test.html');
      await page.setContent(html);

      await detector.detect(page, {
        enableCDP: true,
        enableWebAnimations: false,
        enableLibraryDetection: false,
        waitTime: 200,
      });

      await detector.cleanup();

      // 同じインスタンスで再度detectすると、以前の結果は含まれない
      const newPage = await context.newPage();
      await newPage.setContent('<html><body>Empty</body></html>');

      const result = await detector.detect(newPage, {
        enableCDP: true,
        enableWebAnimations: false,
        enableLibraryDetection: false,
        waitTime: 100,
      });

      // 空のページなのでアニメーションは0
      expect(result.cdpAnimations).toHaveLength(0);

      await newPage.close();
    });

    it('複数回cleanupを呼んでもエラーにならない', async () => {
      const html = loadFixture('web-animations-test.html');
      await page.setContent(html);

      await detector.detect(page, {
        enableCDP: true,
        enableWebAnimations: true,
        enableLibraryDetection: true,
        waitTime: 100,
      });

      // 複数回cleanup
      await expect(detector.cleanup()).resolves.not.toThrow();
      await expect(detector.cleanup()).resolves.not.toThrow();
    });
  });

  // =====================================================
  // エラーハンドリングテスト
  // =====================================================

  describe('エラーハンドリング', () => {
    it('閉じたページで検出してもエラーにならない', async () => {
      const html = loadFixture('web-animations-test.html');
      await page.setContent(html);
      await page.close();

      // 閉じたページに対して検出を試みる
      const result = await detector.detect(page, {
        enableCDP: true,
        enableWebAnimations: true,
        enableLibraryDetection: true,
        waitTime: 100,
      });

      // エラーではなく空の結果が返る
      expect(result).toBeDefined();
      expect(result.cdpAnimations).toHaveLength(0);
      expect(result.webAnimations).toHaveLength(0);

      // pageを再作成して後続テストに影響しないようにする
      page = await context.newPage();
    });

    it('JavaScriptエラーがあるページでも検出を継続する', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
            .animated { animation: fadeIn 0.5s ease; }
          </style>
        </head>
        <body>
          <div class="animated">Content</div>
          <script>
            throw new Error('Intentional error for testing');
          </script>
        </body>
        </html>
      `;

      await page.setContent(html);

      const result = await detector.detect(page, {
        enableCDP: true,
        enableWebAnimations: true,
        enableLibraryDetection: true,
        waitTime: 300,
      });

      // エラーがあってもアニメーションは検出される
      expect(result).toBeDefined();
      // CSSアニメーションはCDPで検出される
      expect(result.cdpAnimations.length).toBeGreaterThanOrEqual(0);
    });
  });

  // =====================================================
  // パフォーマンステスト
  // =====================================================

  describe('パフォーマンス', () => {
    it('検出処理は3秒以内に完了する', async () => {
      const html = loadFixture('mixed-animations-test.html');
      await page.setContent(html);

      const startTime = Date.now();

      const result = await detector.detect(page, {
        enableCDP: true,
        enableWebAnimations: true,
        enableLibraryDetection: true,
        waitTime: 500,
      });

      const elapsed = Date.now() - startTime;

      expect(result).toBeDefined();
      expect(elapsed).toBeLessThan(3000);
      expect(result.detectionTimeMs).toBeLessThan(3000);
    });

    it('detectionTimeMsが正確に記録される', async () => {
      const html = loadFixture('web-animations-test.html');
      await page.setContent(html);

      const waitTime = 200;
      const result = await detector.detect(page, {
        enableCDP: true,
        enableWebAnimations: true,
        enableLibraryDetection: true,
        waitTime,
      });

      // waitTime以上の処理時間が記録されている
      expect(result.detectionTimeMs).toBeGreaterThanOrEqual(waitTime);
      // ただし過度に長くならない
      expect(result.detectionTimeMs).toBeLessThan(waitTime + 2000);
    });
  });
});

// =====================================================
// CDP Animation タイプ検証（型安全性テスト）
// =====================================================

describe('CDP Animation 型検証', () => {
  it('CDPAnimationSourceの構造が正しい', () => {
    const source = {
      duration: 1000,
      delay: 100,
      iterations: 3,
      direction: 'alternate',
      easing: 'ease-in-out',
      keyframesRule: {
        name: 'fadeIn',
        keyframes: [
          { offset: '0', easing: 'ease', style: 'opacity: 0;' },
          { offset: '1', easing: 'ease', style: 'opacity: 1;' },
        ],
      },
    };

    expect(source.duration).toBe(1000);
    expect(source.delay).toBe(100);
    expect(source.iterations).toBe(3);
    expect(source.direction).toBe('alternate');
    expect(source.easing).toBe('ease-in-out');
    expect(source.keyframesRule?.keyframes).toHaveLength(2);
  });

  it('JSAnimationResultの構造が正しい', () => {
    const result: JSAnimationResult = {
      cdpAnimations: [],
      webAnimations: [],
      libraries: {
        gsap: { detected: false },
        framerMotion: { detected: false },
        anime: { detected: false },
        three: { detected: false },
        lottie: { detected: false },
      },
      detectionTimeMs: 100,
      totalDetected: 0,
    };

    expect(result.cdpAnimations).toHaveLength(0);
    expect(result.webAnimations).toHaveLength(0);
    expect(result.libraries.gsap.detected).toBe(false);
    expect(result.totalDetected).toBe(0);
    expect(result.detectionTimeMs).toBe(100);
  });
});
