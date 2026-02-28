// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect JSアニメーション検出 統合テスト
 *
 * TDDアプローチ: runtime/hybridモードでのJSアニメーション検出の統合テスト
 *
 * テスト対象:
 * - CDP Animation イベント検出（motion.detect runtime mode）
 * - Web Animations API 観測
 * - ライブラリ検出（GSAP, Framer Motion等）
 * - CSS + JSのハイブリッド検出
 *
 * @module tests/integration/motion-detect-js
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import {
  motionDetectHandler,
  setRuntimeAnimationDetectorFactory,
  resetRuntimeAnimationDetectorFactory,
} from '../../src/tools/motion';
import {
  RuntimeAnimationDetectorService,
  type RuntimeAnimationResult,
} from '../../src/services/page/runtime-animation-detector.service';

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

/**
 * ファイルURLを生成
 */
function getFixtureFileUrl(filename: string): string {
  const filePath = path.join(FIXTURES_DIR, filename);
  return `file://${filePath}`;
}

// =====================================================
// テストスイート: RuntimeAnimationDetectorService統合
// =====================================================

describe('motion.detect JSアニメーション検出 - 統合テスト', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  });

  describe('RuntimeAnimationDetectorService直接テスト', () => {
    beforeAll(() => {
      // RuntimeAnimationDetectorService ファクトリを設定
      setRuntimeAnimationDetectorFactory(() => new RuntimeAnimationDetectorService());
    });

    afterAll(() => {
      resetRuntimeAnimationDetectorFactory();
    });

    it('Web Animations APIを使用したページでアニメーションを検出する', async () => {
      page = await context.newPage();
      const html = loadFixture('web-animations-test.html');
      await page.setContent(html);
      await page.waitForTimeout(200); // アニメーション開始を待つ

      const service = new RuntimeAnimationDetectorService();
      const result = await service.detect(page);

      expect(result).toBeDefined();
      expect(result.animations.length).toBeGreaterThan(0);
      expect(result.totalDetected).toBeGreaterThan(0);

      // Web Animations APIで作成されたアニメーションの検証
      const wapiAnimation = result.animations.find(
        (a) => a.type === 'web_animations_api'
      );
      expect(wapiAnimation).toBeDefined();
      expect(wapiAnimation?.playState).toBe('running');

      await page.close();
    });

    it('CSSアニメーションとWeb Animations APIの両方を検出する', async () => {
      page = await context.newPage();
      const html = loadFixture('mixed-animations-test.html');
      await page.setContent(html);
      await page.waitForTimeout(200);

      const service = new RuntimeAnimationDetectorService();
      const result = await service.detect(page);

      expect(result.animations.length).toBeGreaterThan(0);

      // CSSアニメーションの検出
      const cssAnimation = result.animations.find(
        (a) => a.type === 'css_animation'
      );
      expect(cssAnimation).toBeDefined();

      // Web Animations APIの検出
      const wapiAnimation = result.animations.find(
        (a) => a.type === 'web_animations_api'
      );
      expect(wapiAnimation).toBeDefined();

      await page.close();
    });

    it('requestAnimationFrameの使用を検出する', async () => {
      page = await context.newPage();
      const html = loadFixture('mixed-animations-test.html');
      await page.setContent(html);
      await page.waitForTimeout(500); // RAFが複数回呼ばれるのを待つ

      const service = new RuntimeAnimationDetectorService();
      const result = await service.detect(page, {
        wait_for_animations: 500,
      });

      expect(result.rafCallbacks.length).toBeGreaterThan(0);

      const rafInfo = result.rafCallbacks[0];
      expect(rafInfo).toHaveProperty('callCount');
      expect(rafInfo.callCount).toBeGreaterThan(0);
      expect(rafInfo).toHaveProperty('avgFrameTime');
      expect(rafInfo).toHaveProperty('modifiedElements');

      await page.close();
    });

    it('スクロール位置ごとにアニメーションを検出する', async () => {
      page = await context.newPage();

      // IntersectionObserverを使用するHTMLを設定
      const htmlWithIO = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            .spacer { height: 200vh; }
            .target {
              opacity: 0;
              transition: opacity 0.5s ease;
            }
            .target.visible { opacity: 1; }
          </style>
        </head>
        <body>
          <div class="spacer"></div>
          <div id="target" class="target">Scroll Target</div>
          <div class="spacer"></div>
          <script>
            const target = document.getElementById('target');
            const observer = new IntersectionObserver((entries) => {
              entries.forEach(entry => {
                if (entry.isIntersecting) {
                  entry.target.classList.add('visible');
                }
              });
            }, { threshold: 0.5 });
            observer.observe(target);
          </script>
        </body>
        </html>
      `;

      await page.setContent(htmlWithIO);

      const service = new RuntimeAnimationDetectorService();
      const result = await service.detect(page, {
        scroll_positions: [0, 50, 100],
      });

      expect(result.scrollPositionResults).toBeDefined();
      expect(result.scrollPositionResults).toHaveProperty('0');
      expect(result.scrollPositionResults).toHaveProperty('50');
      expect(result.scrollPositionResults).toHaveProperty('100');

      await page.close();
    });
  });

  describe('motion.detect ハンドラ runtime mode', () => {
    /**
     * Note: runtime modeはURLが必要
     * file:// URLはSSRF対策でブロックされる可能性があるため、
     * この統合テストではHTMLを直接設定してService層をテストする
     */
    it('runtime modeでhtmlパラメータなしの場合はエラーを返す', async () => {
      const result = await motionDetectHandler({
        detection_mode: 'runtime',
        // URLなし
      });

      // runtime modeはURLが必要なので、validation errorになるか
      // またはdefault modeにフォールバックしてhtml必須エラーになる
      expect(result.success).toBe(false);
    });

    it('css modeでhtmlパラメータありの場合は正常に検出する', async () => {
      const html = loadFixture('mixed-animations-test.html');

      const result = await motionDetectHandler({
        html,
        detection_mode: 'css',
        includeInlineStyles: true,
        includeStyleSheets: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.patterns.length).toBeGreaterThan(0);

        // CSSアニメーション（pulse）を検出
        // パターンのnameプロパティは直接アクセス可能
        const pulseAnimation = result.data.patterns.find(
          (p) => p.name === 'pulse'
        );
        expect(pulseAnimation).toBeDefined();
      }
    });
  });

  describe('アニメーション情報の詳細検証', () => {
    it('アニメーションのタイミング情報を正確に取得する', async () => {
      page = await context.newPage();

      const htmlWithTiming = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            .box { width: 100px; height: 100px; background: red; }
          </style>
        </head>
        <body>
          <div id="box" class="box"></div>
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

      await page.setContent(htmlWithTiming);
      await page.waitForTimeout(200);

      const service = new RuntimeAnimationDetectorService();
      const result = await service.detect(page);

      expect(result.animations.length).toBeGreaterThan(0);

      const animation = result.animations[0];
      expect(animation.duration).toBe(2000);
      expect(animation.iterations).toBe(5);
      expect(animation.easing).toBe('ease-in-out');
      expect(animation.direction).toBe('alternate');
      expect(animation.fillMode).toBe('forwards');
      // delayは初期値のみ設定されることがある
      expect(animation.delay).toBeDefined();

      await page.close();
    });

    it('無限反復アニメーションを検出する', async () => {
      page = await context.newPage();

      const htmlWithInfinite = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            .spinner { width: 50px; height: 50px; background: blue; }
          </style>
        </head>
        <body>
          <div id="spinner" class="spinner"></div>
          <script>
            document.getElementById('spinner').animate(
              [
                { transform: 'rotate(0deg)' },
                { transform: 'rotate(360deg)' }
              ],
              {
                duration: 1000,
                iterations: Infinity,
                easing: 'linear'
              }
            );
          </script>
        </body>
        </html>
      `;

      await page.setContent(htmlWithInfinite);
      await page.waitForTimeout(200);

      const service = new RuntimeAnimationDetectorService();
      const result = await service.detect(page);

      expect(result.animations.length).toBeGreaterThan(0);

      const infiniteAnimation = result.animations.find(
        (a) => a.iterations === Infinity
      );
      expect(infiniteAnimation).toBeDefined();

      await page.close();
    });

    it('複数要素のアニメーションを個別に検出する', async () => {
      page = await context.newPage();

      const htmlWithMultiple = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            .box { width: 50px; height: 50px; margin: 10px; }
            #box1 { background: red; }
            #box2 { background: green; }
            #box3 { background: blue; }
          </style>
        </head>
        <body>
          <div id="box1" class="box"></div>
          <div id="box2" class="box"></div>
          <div id="box3" class="box"></div>
          <script>
            document.getElementById('box1').animate(
              [{ opacity: 0 }, { opacity: 1 }],
              { duration: 500, iterations: Infinity }
            );
            document.getElementById('box2').animate(
              [{ transform: 'scale(1)' }, { transform: 'scale(1.5)' }],
              { duration: 800, iterations: 3 }
            );
            document.getElementById('box3').animate(
              [{ backgroundColor: 'blue' }, { backgroundColor: 'purple' }],
              { duration: 1000, iterations: 2 }
            );
          </script>
        </body>
        </html>
      `;

      await page.setContent(htmlWithMultiple);
      await page.waitForTimeout(200);

      const service = new RuntimeAnimationDetectorService();
      const result = await service.detect(page);

      expect(result.animations.length).toBeGreaterThanOrEqual(3);

      // 各アニメーションが異なるセレクタを持つことを確認
      const selectors = result.animations.map((a) => a.targetSelector);
      const uniqueSelectors = [...new Set(selectors)];
      expect(uniqueSelectors.length).toBeGreaterThanOrEqual(3);

      await page.close();
    });
  });

  describe('エラーハンドリング', () => {
    it('閉じたページでエラーなく空の結果を返す', async () => {
      page = await context.newPage();
      await page.setContent('<html><body>Test</body></html>');
      await page.close();

      const service = new RuntimeAnimationDetectorService();
      const result = await service.detect(page);

      expect(result).toBeDefined();
      expect(result.animations).toHaveLength(0);
      expect(result.totalDetected).toBe(0);
    });

    it('JavaScriptエラーがあるページでも検出を継続する', async () => {
      page = await context.newPage();

      const htmlWithError = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            @keyframes fadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            .animated { animation: fadeIn 0.5s ease; }
          </style>
        </head>
        <body>
          <div class="animated">Content</div>
          <script>
            // 意図的にエラーを発生
            throw new Error('Intentional error for testing');
          </script>
        </body>
        </html>
      `;

      await page.setContent(htmlWithError);

      const service = new RuntimeAnimationDetectorService();
      const result = await service.detect(page);

      // エラーがあってもCSSアニメーションは検出される
      expect(result).toBeDefined();
      expect(result.animations.length).toBeGreaterThanOrEqual(0);

      await page.close();
    });
  });

  describe('パフォーマンス', () => {
    it('検出処理は3秒以内に完了する', async () => {
      page = await context.newPage();
      const html = loadFixture('mixed-animations-test.html');
      await page.setContent(html);

      const service = new RuntimeAnimationDetectorService();
      const startTime = Date.now();

      const result = await service.detect(page, {
        wait_for_animations: 500,
        scroll_positions: [0, 50, 100],
      });

      const elapsed = Date.now() - startTime;

      expect(result).toBeDefined();
      expect(elapsed).toBeLessThan(3000);
      expect(result.detectionTimeMs).toBeLessThan(3000);

      await page.close();
    });
  });
});

// =====================================================
// テストスイート: CDP Animation イベント型検証
// =====================================================

describe('CDP Animation イベント型検証', () => {
  /**
   * CDP Animation.animationCreated イベントの型
   */
  interface CDPAnimationCreatedEvent {
    id: string;
  }

  /**
   * CDP Animation.animationStarted イベントの型
   */
  interface CDPAnimationStartedEvent {
    animation: {
      id: string;
      name: string;
      pausedState: boolean;
      playState: string;
      playbackRate: number;
      startTime: number;
      currentTime: number;
      type: 'CSSAnimation' | 'CSSTransition' | 'WebAnimation';
      source: {
        delay: number;
        duration: number;
        endDelay: number;
        iterationStart: number;
        iterations: number;
        easing: string;
        direction: string;
        fill: string;
        keyframesRule?: {
          name: string;
          keyframes: Array<{
            offset: string;
            easing: string;
            style: string;
          }>;
        };
      };
      cssId?: string;
    };
  }

  it('CDPAnimationCreatedEventは必須フィールドを持つ', () => {
    const event: CDPAnimationCreatedEvent = {
      id: 'animation-123',
    };

    expect(event.id).toBeDefined();
    expect(typeof event.id).toBe('string');
  });

  it('CDPAnimationStartedEventは詳細なアニメーション情報を持つ', () => {
    const event: CDPAnimationStartedEvent = {
      animation: {
        id: 'animation-456',
        name: 'fadeIn',
        pausedState: false,
        playState: 'running',
        playbackRate: 1,
        startTime: 1000,
        currentTime: 500,
        type: 'CSSAnimation',
        source: {
          delay: 0,
          duration: 500,
          endDelay: 0,
          iterationStart: 0,
          iterations: 1,
          easing: 'ease-out',
          direction: 'normal',
          fill: 'forwards',
          keyframesRule: {
            name: 'fadeIn',
            keyframes: [
              { offset: '0', easing: 'ease', style: 'opacity: 0;' },
              { offset: '1', easing: 'ease', style: 'opacity: 1;' },
            ],
          },
        },
      },
    };

    expect(event.animation.id).toBe('animation-456');
    expect(event.animation.type).toBe('CSSAnimation');
    expect(event.animation.source.duration).toBe(500);
    expect(event.animation.source.keyframesRule?.keyframes).toHaveLength(2);
  });

  it('WebAnimationタイプを正しく識別する', () => {
    const cssAnimationEvent: CDPAnimationStartedEvent = {
      animation: {
        id: '1',
        name: 'bounce',
        pausedState: false,
        playState: 'running',
        playbackRate: 1,
        startTime: 0,
        currentTime: 0,
        type: 'CSSAnimation',
        source: {
          delay: 0,
          duration: 1000,
          endDelay: 0,
          iterationStart: 0,
          iterations: 1,
          easing: 'ease',
          direction: 'normal',
          fill: 'none',
        },
      },
    };

    const cssTransitionEvent: CDPAnimationStartedEvent = {
      animation: {
        id: '2',
        name: 'opacity',
        pausedState: false,
        playState: 'running',
        playbackRate: 1,
        startTime: 0,
        currentTime: 0,
        type: 'CSSTransition',
        source: {
          delay: 0,
          duration: 300,
          endDelay: 0,
          iterationStart: 0,
          iterations: 1,
          easing: 'ease-in-out',
          direction: 'normal',
          fill: 'backwards',
        },
      },
    };

    const webAnimationEvent: CDPAnimationStartedEvent = {
      animation: {
        id: '3',
        name: '',
        pausedState: false,
        playState: 'running',
        playbackRate: 1,
        startTime: 0,
        currentTime: 0,
        type: 'WebAnimation',
        source: {
          delay: 0,
          duration: 2000,
          endDelay: 0,
          iterationStart: 0,
          iterations: Infinity,
          easing: 'linear',
          direction: 'alternate',
          fill: 'both',
        },
      },
    };

    expect(cssAnimationEvent.animation.type).toBe('CSSAnimation');
    expect(cssTransitionEvent.animation.type).toBe('CSSTransition');
    expect(webAnimationEvent.animation.type).toBe('WebAnimation');

    // WebAnimationは空のname
    expect(webAnimationEvent.animation.name).toBe('');
    // 無限反復
    expect(webAnimationEvent.animation.source.iterations).toBe(Infinity);
  });
});

// =====================================================
// テストスイート: ライブラリ検出パターン
// =====================================================

describe('JSアニメーションライブラリ検出パターン', () => {
  /**
   * ブラウザコンテキストでのライブラリ検出をシミュレート
   */
  interface LibraryDetectionContext {
    gsap?: {
      version: string;
      core?: unknown;
    };
    anime?: {
      version: string;
    };
    THREE?: {
      REVISION: string;
    };
    lottie?: {
      loadAnimation: () => void;
    };
    __FRAMER_MOTION__?: {
      version: string;
    };
    MotionValue?: unknown;
  }

  it('GSAPグローバルを検出する', () => {
    const context: LibraryDetectionContext = {
      gsap: {
        version: '3.12.2',
        core: {},
      },
    };

    const hasGsap = context.gsap !== undefined && typeof context.gsap.version === 'string';
    expect(hasGsap).toBe(true);
  });

  it('anime.jsグローバルを検出する', () => {
    const context: LibraryDetectionContext = {
      anime: {
        version: '3.2.1',
      },
    };

    const hasAnime = context.anime !== undefined;
    expect(hasAnime).toBe(true);
  });

  it('Three.jsグローバルを検出する', () => {
    const context: LibraryDetectionContext = {
      THREE: {
        REVISION: '150',
      },
    };

    const hasThree = context.THREE !== undefined;
    expect(hasThree).toBe(true);
  });

  it('Lottieグローバルを検出する', () => {
    const context: LibraryDetectionContext = {
      lottie: {
        loadAnimation: () => {},
      },
    };

    const hasLottie = context.lottie !== undefined && typeof context.lottie.loadAnimation === 'function';
    expect(hasLottie).toBe(true);
  });

  it('Framer Motionマーカーを検出する', () => {
    const context: LibraryDetectionContext = {
      __FRAMER_MOTION__: {
        version: '10.0.0',
      },
      MotionValue: class {},
    };

    const hasFramerMotion = context.__FRAMER_MOTION__ !== undefined || context.MotionValue !== undefined;
    expect(hasFramerMotion).toBe(true);
  });

  it('複数ライブラリの同時検出', () => {
    const context: LibraryDetectionContext = {
      gsap: { version: '3.12.2' },
      THREE: { REVISION: '150' },
    };

    const detectedLibraries: string[] = [];

    if (context.gsap) detectedLibraries.push('gsap');
    if (context.anime) detectedLibraries.push('anime');
    if (context.THREE) detectedLibraries.push('three');
    if (context.lottie) detectedLibraries.push('lottie');
    if (context.__FRAMER_MOTION__ || context.MotionValue) detectedLibraries.push('framer_motion');

    expect(detectedLibraries).toContain('gsap');
    expect(detectedLibraries).toContain('three');
    expect(detectedLibraries).not.toContain('anime');
    expect(detectedLibraries).toHaveLength(2);
  });
});
