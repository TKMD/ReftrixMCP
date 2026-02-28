// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * JSアニメーション検出 E2Eテスト
 *
 * Playwrightを使用した実際のWebページでのJSアニメーション検出テスト
 *
 * テスト対象:
 * - 実際のWebページでのGSAP/Framer Motion検出
 * - CDP Animation ドメインを使用したアニメーション追跡
 * - Web Animations API経由のアニメーション検出
 * - スクロールトリガーアニメーションの検出
 *
 * @module tests/e2e/js-animation-detection
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

// =====================================================
// テストフィクスチャと設定
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
 * テスト用ローカルサーバー
 */
let testServer: http.Server | null = null;
let testServerPort = 0;

/**
 * テストサーバーを起動
 */
async function startTestServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    testServer = http.createServer((req, res) => {
      const url = req.url || '/';
      const filename = url === '/' ? 'mixed-animations-test.html' : url.slice(1);
      const filePath = path.join(FIXTURES_DIR, filename);

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    testServer.listen(0, () => {
      const addr = testServer!.address();
      if (addr && typeof addr === 'object') {
        testServerPort = addr.port;
        resolve(testServerPort);
      } else {
        reject(new Error('Failed to get server address'));
      }
    });

    testServer.on('error', reject);
  });
}

/**
 * テストサーバーを停止
 */
async function stopTestServer(): Promise<void> {
  return new Promise((resolve) => {
    if (testServer) {
      testServer.close(() => {
        testServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// =====================================================
// CDP Animation ドメインテスト
// =====================================================

describe('E2E: CDP Animation ドメイン', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdpSession: CDPSession;

  beforeAll(async () => {
    await startTestServer();
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await stopTestServer();
  });

  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    // CDPセッションを作成
    cdpSession = await page.context().newCDPSession(page);
    // Animation ドメインを有効化
    await cdpSession.send('Animation.enable');
  });

  afterEach(async () => {
    await cdpSession?.detach().catch(() => {});
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
  });

  it('Animation.animationCreatedイベントをキャプチャする', async () => {
    const createdAnimations: string[] = [];

    cdpSession.on('Animation.animationCreated', (event) => {
      createdAnimations.push(event.id);
    });

    // Web Animations APIを使用するHTMLを設定
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <body>
        <div id="box" style="width: 100px; height: 100px; background: red;"></div>
        <script>
          document.getElementById('box').animate(
            [{ opacity: 0 }, { opacity: 1 }],
            { duration: 1000 }
          );
        </script>
      </body>
      </html>
    `);

    await page.waitForTimeout(500);

    expect(createdAnimations.length).toBeGreaterThan(0);
  });

  it('Animation.animationStartedイベントでタイミング情報を取得する', async () => {
    interface AnimationStartedData {
      id: string;
      type: string;
      duration: number;
      iterations: number;
    }

    const startedAnimations: AnimationStartedData[] = [];

    cdpSession.on('Animation.animationStarted', (event) => {
      startedAnimations.push({
        id: event.animation.id,
        type: event.animation.type,
        duration: event.animation.source?.duration ?? 0,
        iterations: event.animation.source?.iterations ?? 1,
      });
    });

    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          .animated { animation: fadeIn 0.5s ease-out; }
        </style>
      </head>
      <body>
        <div class="animated">Test</div>
      </body>
      </html>
    `);

    await page.waitForTimeout(500);

    expect(startedAnimations.length).toBeGreaterThan(0);

    const animation = startedAnimations[0];
    expect(animation.type).toBe('CSSAnimation');
    expect(animation.duration).toBe(500);
  });

  it('CSS Transition をキャプチャする', async () => {
    interface AnimationData {
      id: string;
      type: string;
    }

    const animations: AnimationData[] = [];

    cdpSession.on('Animation.animationStarted', (event) => {
      animations.push({
        id: event.animation.id,
        type: event.animation.type,
      });
    });

    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          .box {
            width: 100px;
            height: 100px;
            background: blue;
            transition: transform 0.3s ease;
          }
          .box:hover {
            transform: scale(1.2);
          }
        </style>
      </head>
      <body>
        <div class="box" id="box">Hover me</div>
      </body>
      </html>
    `);

    // ホバーをシミュレート
    await page.hover('#box');
    await page.waitForTimeout(500);

    const transitions = animations.filter((a) => a.type === 'CSSTransition');
    expect(transitions.length).toBeGreaterThan(0);
  });

  it('WebAnimation タイプを識別する', async () => {
    interface AnimationData {
      id: string;
      type: string;
      name: string;
    }

    const animations: AnimationData[] = [];

    cdpSession.on('Animation.animationStarted', (event) => {
      animations.push({
        id: event.animation.id,
        type: event.animation.type,
        name: event.animation.name || '',
      });
    });

    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <body>
        <div id="target" style="width: 50px; height: 50px; background: green;"></div>
        <script>
          document.getElementById('target').animate(
            [
              { transform: 'translateX(0)', opacity: 1 },
              { transform: 'translateX(100px)', opacity: 0.5 }
            ],
            { duration: 1000, iterations: 2 }
          );
        </script>
      </body>
      </html>
    `);

    await page.waitForTimeout(500);

    const webAnimations = animations.filter((a) => a.type === 'WebAnimation');
    expect(webAnimations.length).toBeGreaterThan(0);

    // WebAnimationは通常名前が空
    expect(webAnimations[0].name).toBe('');
  });

  it('複数の同時アニメーションを追跡する', async () => {
    const animationIds = new Set<string>();

    cdpSession.on('Animation.animationStarted', (event) => {
      animationIds.add(event.animation.id);
    });

    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
          @keyframes slideIn { from { transform: translateX(-50px); } to { transform: translateX(0); } }
          .box { width: 50px; height: 50px; margin: 10px; }
          .box1 { background: red; animation: fadeIn 0.5s; }
          .box2 { background: green; animation: slideIn 0.6s; }
          .box3 { background: blue; animation: fadeIn 0.4s, slideIn 0.7s; }
        </style>
      </head>
      <body>
        <div class="box box1"></div>
        <div class="box box2"></div>
        <div class="box box3"></div>
      </body>
      </html>
    `);

    await page.waitForTimeout(1000);

    // 少なくとも4つのアニメーション（box1: 1, box2: 1, box3: 2）
    expect(animationIds.size).toBeGreaterThanOrEqual(4);
  });
});

// =====================================================
// Web Animations API E2Eテスト
// =====================================================

describe('E2E: Web Animations API', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
  });

  it('document.getAnimations()でアクティブなアニメーションを取得する', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <body>
        <div id="box1" style="width: 50px; height: 50px; background: red;"></div>
        <div id="box2" style="width: 50px; height: 50px; background: green;"></div>
        <script>
          document.getElementById('box1').animate(
            [{ opacity: 0 }, { opacity: 1 }],
            { duration: 2000, iterations: Infinity }
          );
          document.getElementById('box2').animate(
            [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
            { duration: 3000, iterations: Infinity }
          );
        </script>
      </body>
      </html>
    `);

    await page.waitForTimeout(200);

    const animations = await page.evaluate(() => {
      return document.getAnimations().map((anim) => ({
        id: anim.id,
        playState: anim.playState,
        currentTime: anim.currentTime,
        duration: anim.effect?.getComputedTiming?.()?.duration,
        iterations: anim.effect?.getComputedTiming?.()?.iterations,
      }));
    });

    expect(animations.length).toBeGreaterThanOrEqual(2);

    for (const anim of animations) {
      expect(anim.playState).toBe('running');
      expect(anim.iterations).toBe(Infinity);
    }
  });

  it('キーフレーム情報を抽出する', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <body>
        <div id="target" style="width: 100px; height: 100px; background: blue;"></div>
        <script>
          document.getElementById('target').animate(
            [
              { transform: 'translateX(0)', opacity: 1, offset: 0 },
              { transform: 'translateX(50px)', opacity: 0.8, offset: 0.5 },
              { transform: 'translateX(100px)', opacity: 0.5, offset: 1 }
            ],
            { duration: 1000 }
          );
        </script>
      </body>
      </html>
    `);

    await page.waitForTimeout(100);

    const keyframes = await page.evaluate(() => {
      const anims = document.getAnimations();
      if (anims.length === 0) return [];

      const anim = anims[0];
      if (anim.effect instanceof KeyframeEffect) {
        return anim.effect.getKeyframes().map((kf) => ({
          offset: kf.offset,
          transform: kf.transform,
          opacity: kf.opacity,
        }));
      }
      return [];
    });

    expect(keyframes.length).toBe(3);
    expect(keyframes[0].offset).toBe(0);
    expect(keyframes[1].offset).toBe(0.5);
    expect(keyframes[2].offset).toBe(1);
  });

  it('アニメーションの一時停止と再開を検出する', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <body>
        <div id="target" style="width: 100px; height: 100px; background: red;"></div>
        <script>
          window.testAnimation = document.getElementById('target').animate(
            [{ opacity: 0 }, { opacity: 1 }],
            { duration: 5000, iterations: Infinity }
          );
        </script>
      </body>
      </html>
    `);

    await page.waitForTimeout(100);

    // 初期状態: running
    let state = await page.evaluate(() => document.getAnimations()[0]?.playState);
    expect(state).toBe('running');

    // 一時停止
    await page.evaluate(() => {
      (window as { testAnimation: Animation }).testAnimation.pause();
    });
    state = await page.evaluate(() => document.getAnimations()[0]?.playState);
    expect(state).toBe('paused');

    // 再開
    await page.evaluate(() => {
      (window as { testAnimation: Animation }).testAnimation.play();
    });
    state = await page.evaluate(() => document.getAnimations()[0]?.playState);
    expect(state).toBe('running');
  });
});

// =====================================================
// ライブラリ検出 E2Eテスト
// =====================================================

describe('E2E: JSアニメーションライブラリ検出', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    await startTestServer();
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await stopTestServer();
  });

  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
  });

  it('GSAPグローバルオブジェクトを検出する', async () => {
    const html = loadFixture('gsap-test.html');
    await page.setContent(html);

    // CDNからGSAPがロードされるのを待つ
    await page.waitForFunction(
      () => (window as unknown as { gsap?: unknown }).gsap !== undefined,
      { timeout: 10000 }
    ).catch(() => {
      // GSAPがロードされなかった場合はスキップ
    });

    const hasGsap = await page.evaluate(() => {
      return (window as unknown as { gsap?: { version?: string } }).gsap !== undefined;
    });

    // CDN接続が失敗する環境ではスキップ
    if (hasGsap) {
      const gsapVersion = await page.evaluate(() => {
        return (window as unknown as { gsap?: { version?: string } }).gsap?.version;
      });
      expect(gsapVersion).toBeDefined();
    }
  });

  it('Framer Motionマーカーを検出する', async () => {
    const html = loadFixture('framer-motion-test.html');
    await page.setContent(html);

    const hasFramerMotion = await page.evaluate(() => {
      return (
        (window as unknown as { __FRAMER_MOTION__?: unknown }).__FRAMER_MOTION__ !== undefined ||
        document.querySelector('[data-framer-component-type]') !== null ||
        document.querySelector('[data-framer-appear-id]') !== null
      );
    });

    expect(hasFramerMotion).toBe(true);
  });

  it('Lottieグローバルを検出する', async () => {
    const html = loadFixture('lottie-test.html');
    await page.setContent(html);

    const hasLottie = await page.evaluate(() => {
      const win = window as unknown as { lottie?: unknown; bodymovin?: unknown };
      return win.lottie !== undefined || win.bodymovin !== undefined;
    });

    expect(hasLottie).toBe(true);
  });

  it('Three.jsマーカーを検出する', async () => {
    const html = loadFixture('three-js-test.html');
    await page.setContent(html);

    const hasThree = await page.evaluate(() => {
      const win = window as unknown as { THREE?: unknown; __THREE_DEVTOOLS__?: unknown };
      return win.THREE !== undefined || win.__THREE_DEVTOOLS__ !== undefined;
    });

    expect(hasThree).toBe(true);
  });

  it('複数ライブラリを同時に検出する', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <body>
        <script>
          // Simulate multiple libraries
          window.gsap = { version: '3.12.2' };
          window.THREE = { REVISION: '150' };
          window.lottie = { loadAnimation: () => {} };
        </script>
      </body>
      </html>
    `);

    const detectedLibraries = await page.evaluate(() => {
      const libs: string[] = [];
      const win = window as unknown as {
        gsap?: unknown;
        anime?: unknown;
        THREE?: unknown;
        lottie?: unknown;
        __FRAMER_MOTION__?: unknown;
      };

      if (win.gsap) libs.push('gsap');
      if (win.anime) libs.push('anime');
      if (win.THREE) libs.push('three');
      if (win.lottie) libs.push('lottie');
      if (win.__FRAMER_MOTION__) libs.push('framer_motion');

      return libs;
    });

    expect(detectedLibraries).toContain('gsap');
    expect(detectedLibraries).toContain('three');
    expect(detectedLibraries).toContain('lottie');
  });
});

// =====================================================
// スクロールトリガーアニメーション E2Eテスト
// =====================================================

describe('E2E: スクロールトリガーアニメーション', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
  });

  it('IntersectionObserverによるアニメーショントリガーを検出する', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          .spacer { height: 200vh; }
          .target {
            opacity: 0;
            transform: translateY(50px);
            transition: opacity 0.5s, transform 0.5s;
          }
          .target.visible {
            opacity: 1;
            transform: translateY(0);
          }
        </style>
      </head>
      <body>
        <div class="spacer"></div>
        <div id="target" class="target">Scroll to see me</div>
        <div class="spacer"></div>
        <script>
          window.intersectionCallbacks = [];
          const target = document.getElementById('target');
          const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
              window.intersectionCallbacks.push({
                isIntersecting: entry.isIntersecting,
                ratio: entry.intersectionRatio,
                time: Date.now()
              });
              if (entry.isIntersecting) {
                entry.target.classList.add('visible');
              }
            });
          }, { threshold: 0.5 });
          observer.observe(target);
        </script>
      </body>
      </html>
    `);

    // 初期状態を確認
    let isVisible = await page.evaluate(() => {
      return document.getElementById('target')?.classList.contains('visible');
    });
    expect(isVisible).toBe(false);

    // スクロールしてターゲットを表示
    await page.evaluate(() => {
      const target = document.getElementById('target');
      target?.scrollIntoView({ behavior: 'instant' });
    });

    await page.waitForTimeout(100);

    // コールバックが呼ばれたことを確認
    const callbacks = await page.evaluate(() => {
      return (window as unknown as { intersectionCallbacks: unknown[] }).intersectionCallbacks;
    });
    expect(callbacks.length).toBeGreaterThan(0);

    // 要素がvisibleになったことを確認
    isVisible = await page.evaluate(() => {
      return document.getElementById('target')?.classList.contains('visible');
    });
    expect(isVisible).toBe(true);
  });

  it('スクロール位置に応じたアニメーション状態を追跡する', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { margin: 0; padding: 0; }
          .section {
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 2rem;
          }
          .section:nth-child(1) { background: #ff6b6b; }
          .section:nth-child(2) { background: #4ecdc4; }
          .section:nth-child(3) { background: #45b7d1; }
          .animated-element {
            /* 要素を十分な大きさにしてIntersectionObserverが確実にトリガーされるように */
            width: 200px;
            height: 200px;
            opacity: 0;
            transition: opacity 0.5s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(255,255,255,0.3);
          }
          .animated-element.in-view { opacity: 1; }
        </style>
      </head>
      <body>
        <div class="section">Section 1<div class="animated-element" id="el1">Element 1</div></div>
        <div class="section">Section 2<div class="animated-element" id="el2">Element 2</div></div>
        <div class="section">Section 3<div class="animated-element" id="el3">Element 3</div></div>
        <script>
          const elements = document.querySelectorAll('.animated-element');
          const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
              if (entry.isIntersecting) {
                entry.target.classList.add('in-view');
              } else {
                entry.target.classList.remove('in-view');
              }
            });
          }, { threshold: 0.1 }); // より低いしきい値で確実に検出
          elements.forEach(el => observer.observe(el));
        </script>
      </body>
      </html>
    `);

    // IntersectionObserverの初期化を待つ
    await page.waitForTimeout(100);

    // 初期位置（Section 1）
    let visibleElements = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.animated-element.in-view')).map(
        (el) => el.id
      );
    });

    // el1は表示されているはず
    expect(visibleElements).toContain('el1');

    // Section 2にスクロール
    await page.evaluate(() => {
      window.scrollTo(0, window.innerHeight);
    });
    await page.waitForTimeout(200);

    visibleElements = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.animated-element.in-view')).map(
        (el) => el.id
      );
    });

    // el2が表示されているはず
    expect(visibleElements).toContain('el2');

    // Section 3にスクロール
    await page.evaluate(() => {
      window.scrollTo(0, window.innerHeight * 2);
    });
    await page.waitForTimeout(200);

    visibleElements = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.animated-element.in-view')).map(
        (el) => el.id
      );
    });

    // el3が表示されているはず
    expect(visibleElements).toContain('el3');
  });
});

// =====================================================
// パフォーマンステスト
// =====================================================

describe('E2E: パフォーマンス', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
  });

  it('多数のアニメーション（50+）を効率的に検出する', async () => {
    // 50個のアニメーション要素を生成
    const elementsHtml = Array.from({ length: 50 }, (_, i) => `
      <div id="box${i}" style="width: 20px; height: 20px; background: hsl(${i * 7}, 70%, 50%); display: inline-block;"></div>
    `).join('');

    const animationScript = Array.from({ length: 50 }, (_, i) => `
      document.getElementById('box${i}').animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: ${1000 + i * 10}, iterations: Infinity }
      );
    `).join('');

    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <body>
        ${elementsHtml}
        <script>${animationScript}</script>
      </body>
      </html>
    `);

    const startTime = Date.now();

    const animationCount = await page.evaluate(() => {
      return document.getAnimations().length;
    });

    const elapsed = Date.now() - startTime;

    expect(animationCount).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(1000); // 1秒以内に完了
  });

  it('CDP Animation ドメインで多数のイベントを処理する', async () => {
    const cdpSession = await page.context().newCDPSession(page);
    await cdpSession.send('Animation.enable');

    const animationIds = new Set<string>();

    cdpSession.on('Animation.animationStarted', (event) => {
      animationIds.add(event.animation.id);
    });

    // 30個のアニメーションを生成
    const elementsHtml = Array.from({ length: 30 }, (_, i) => `
      <div id="box${i}" style="width: 10px; height: 10px; background: red;"></div>
    `).join('');

    const animationScript = Array.from({ length: 30 }, (_, i) => `
      document.getElementById('box${i}').animate(
        [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
        { duration: 1000 + ${i * 50} }
      );
    `).join('');

    const startTime = Date.now();

    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <body>
        ${elementsHtml}
        <script>${animationScript}</script>
      </body>
      </html>
    `);

    await page.waitForTimeout(500);

    const elapsed = Date.now() - startTime;

    expect(animationIds.size).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(2000); // 2秒以内に完了

    await cdpSession.detach();
  });
});
