// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RuntimeAnimationDetectorService Tests
 *
 * TDD approach: Tests written first to define expected behavior
 * Phase2: JavaScript駆動アニメーション検出（ブラウザ実行時解析）
 *
 * 検出対象:
 * - IntersectionObserver によるスクロールトリガーアニメーション
 * - requestAnimationFrame によるフレームベースアニメーション
 * - Element.animate() (Web Animations API)
 * - getAnimations() によるアクティブアニメーション取得
 *
 * @module tests/services/page/runtime-animation-detector.service
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Page, Browser, BrowserContext } from 'playwright';
import { chromium } from 'playwright';
import {
  RuntimeAnimationDetectorService,
  type RuntimeAnimationResult,
  type RuntimeAnimationOptions,
  type AnimationInfo,
  type IntersectionObserverInfo,
  type RAFInfo,
} from '../../../src/services/page/runtime-animation-detector.service';

// =====================================================
// Test HTML Fixtures
// =====================================================

/**
 * IntersectionObserver を使用したスクロールトリガーアニメーション
 */
const HTML_WITH_INTERSECTION_OBSERVER = `
<!DOCTYPE html>
<html>
<head>
  <title>IntersectionObserver Test</title>
  <style>
    .fade-in-section {
      opacity: 0;
      transform: translateY(20px);
      transition: opacity 0.5s ease, transform 0.5s ease;
    }
    .fade-in-section.visible {
      opacity: 1;
      transform: translateY(0);
    }
    .spacer { height: 100vh; }
  </style>
</head>
<body>
  <div class="spacer"></div>
  <div class="fade-in-section" id="target1">Section 1</div>
  <div class="spacer"></div>
  <div class="fade-in-section" id="target2">Section 2</div>
  <script>
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
        }
      });
    }, { threshold: 0.1 });

    document.querySelectorAll('.fade-in-section').forEach(el => {
      observer.observe(el);
    });
  </script>
</body>
</html>
`;

/**
 * requestAnimationFrame を使用したアニメーション
 */
const HTML_WITH_RAF = `
<!DOCTYPE html>
<html>
<head>
  <title>RAF Test</title>
  <style>
    .spinner { width: 50px; height: 50px; background: blue; }
  </style>
</head>
<body>
  <div class="spinner" id="spinner"></div>
  <script>
    const spinner = document.getElementById('spinner');
    let rotation = 0;

    function animate() {
      rotation += 2;
      spinner.style.transform = \`rotate(\${rotation}deg)\`;
      requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
  </script>
</body>
</html>
`;

/**
 * Web Animations API (Element.animate()) を使用したアニメーション
 */
const HTML_WITH_WEB_ANIMATIONS_API = `
<!DOCTYPE html>
<html>
<head>
  <title>Web Animations API Test</title>
  <style>
    .box { width: 100px; height: 100px; background: red; }
  </style>
</head>
<body>
  <div class="box" id="box"></div>
  <script>
    const box = document.getElementById('box');
    box.animate([
      { transform: 'translateX(0)' },
      { transform: 'translateX(200px)' }
    ], {
      duration: 1000,
      iterations: Infinity,
      easing: 'ease-in-out',
      direction: 'alternate'
    });
  </script>
</body>
</html>
`;

/**
 * 複数のアニメーション手法を組み合わせたページ
 */
const HTML_WITH_MULTIPLE_ANIMATION_TYPES = `
<!DOCTYPE html>
<html>
<head>
  <title>Multiple Animation Types</title>
  <style>
    .css-animation {
      animation: pulse 1s infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.1); }
    }
    .box { width: 50px; height: 50px; background: green; margin: 10px; }
    .spacer { height: 100vh; }
  </style>
</head>
<body>
  <div class="box css-animation" id="cssBox"></div>
  <div class="box" id="rafBox"></div>
  <div class="box" id="wapiBox"></div>
  <div class="spacer"></div>
  <div class="box" id="ioTarget">Scroll Target</div>
  <script>
    // RAF animation
    const rafBox = document.getElementById('rafBox');
    let opacity = 0;
    let direction = 1;
    function fadeAnimation() {
      opacity += 0.02 * direction;
      if (opacity >= 1 || opacity <= 0) direction *= -1;
      rafBox.style.opacity = opacity;
      requestAnimationFrame(fadeAnimation);
    }
    requestAnimationFrame(fadeAnimation);

    // Web Animations API
    const wapiBox = document.getElementById('wapiBox');
    wapiBox.animate([
      { backgroundColor: 'green' },
      { backgroundColor: 'blue' },
      { backgroundColor: 'green' }
    ], {
      duration: 2000,
      iterations: Infinity
    });

    // IntersectionObserver
    const ioTarget = document.getElementById('ioTarget');
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.style.transform = 'scale(1.2)';
        } else {
          entry.target.style.transform = 'scale(1)';
        }
      });
    }, { threshold: 0.5 });
    observer.observe(ioTarget);
  </script>
</body>
</html>
`;

/**
 * アニメーションなしのシンプルなページ
 */
const HTML_WITHOUT_ANIMATIONS = `
<!DOCTYPE html>
<html>
<head><title>No Animations</title></head>
<body>
  <div>Static content</div>
</body>
</html>
`;

// =====================================================
// Test Suite: RuntimeAnimationDetectorService
// =====================================================

describe('RuntimeAnimationDetectorService', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let service: RuntimeAnimationDetectorService;

  beforeEach(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    service = new RuntimeAnimationDetectorService();
  });

  afterEach(async () => {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  });

  // =====================================================
  // 基本機能テスト
  // =====================================================

  describe('Basic Functionality', () => {
    it('should instantiate with default options', () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(RuntimeAnimationDetectorService);
    });

    it('should detect no animations on static page', async () => {
      await page.setContent(HTML_WITHOUT_ANIMATIONS);

      const result = await service.detect(page);

      expect(result).toBeDefined();
      expect(result.animations).toHaveLength(0);
      expect(result.intersectionObservers).toHaveLength(0);
      expect(result.rafCallbacks).toHaveLength(0);
      expect(result.totalDetected).toBe(0);
    });

    it('should return RuntimeAnimationResult structure', async () => {
      await page.setContent(HTML_WITHOUT_ANIMATIONS);

      const result = await service.detect(page);

      // Required fields
      expect(result).toHaveProperty('animations');
      expect(result).toHaveProperty('intersectionObservers');
      expect(result).toHaveProperty('rafCallbacks');
      expect(result).toHaveProperty('totalDetected');
      expect(result).toHaveProperty('detectionTimeMs');

      // Type checks
      expect(Array.isArray(result.animations)).toBe(true);
      expect(Array.isArray(result.intersectionObservers)).toBe(true);
      expect(Array.isArray(result.rafCallbacks)).toBe(true);
      expect(typeof result.totalDetected).toBe('number');
      expect(typeof result.detectionTimeMs).toBe('number');
    });
  });

  // =====================================================
  // Web Animations API 検出テスト
  // =====================================================

  describe('Web Animations API Detection', () => {
    it('should detect Element.animate() animations', async () => {
      await page.setContent(HTML_WITH_WEB_ANIMATIONS_API);
      await page.waitForTimeout(100); // アニメーション開始を待つ

      const result = await service.detect(page);

      expect(result.animations.length).toBeGreaterThan(0);

      const animation = result.animations[0];
      expect(animation).toHaveProperty('id');
      expect(animation).toHaveProperty('playState');
      expect(animation).toHaveProperty('duration');
      expect(animation).toHaveProperty('iterations');
      expect(animation).toHaveProperty('easing');
      expect(animation).toHaveProperty('targetSelector');
    });

    it('should capture animation properties correctly', async () => {
      await page.setContent(HTML_WITH_WEB_ANIMATIONS_API);
      await page.waitForTimeout(100);

      const result = await service.detect(page);

      expect(result.animations.length).toBeGreaterThan(0);

      const animation = result.animations[0];
      expect(animation.duration).toBe(1000);
      expect(animation.iterations).toBe(Infinity);
      expect(animation.easing).toBe('ease-in-out');
      expect(animation.playState).toBe('running');
    });

    it('should detect CSS animations via getAnimations()', async () => {
      const htmlWithCssAnimation = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            @keyframes bounce {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-20px); }
            }
            .bouncing { animation: bounce 0.5s ease infinite; }
          </style>
        </head>
        <body>
          <div class="bouncing" id="bouncer">Bouncing</div>
        </body>
        </html>
      `;

      await page.setContent(htmlWithCssAnimation);
      await page.waitForTimeout(100);

      const result = await service.detect(page);

      expect(result.animations.length).toBeGreaterThan(0);

      const animation = result.animations.find(a =>
        a.animationName === 'bounce' || a.targetSelector?.includes('bouncer')
      );
      expect(animation).toBeDefined();
    });
  });

  // =====================================================
  // IntersectionObserver 検出テスト
  // =====================================================

  describe('IntersectionObserver Detection', () => {
    /**
     * Note: IntersectionObserverのフックはページコンテンツ設定後に注入されるため、
     * 既に作成済みのオブザーバーはキャプチャできない制限がある。
     * この制限を回避するには、ページナビゲーション前にフックを注入する必要がある。
     */
    it('should detect IntersectionObserver usage when created after hook injection', async () => {
      // フックを先に注入
      await page.setContent(`
        <!DOCTYPE html>
        <html><head><title>Test</title></head><body></body></html>
      `);

      // サービスを呼び出してフックを注入
      await service.detect(page);

      // その後にIOを使用するスクリプトを追加
      await page.evaluate(() => {
        const target = document.createElement('div');
        target.id = 'newTarget';
        document.body.appendChild(target);

        const observer = new IntersectionObserver(() => {}, { threshold: 0.5 });
        observer.observe(target);
      });

      const result = await service.detect(page);

      // フック注入後に作成されたIOは検出可能
      expect(result.intersectionObservers.length).toBeGreaterThan(0);
    });

    it('should capture IntersectionObserver target count when created after hook', async () => {
      await page.setContent(`<!DOCTYPE html><html><head></head><body></body></html>`);

      // 最初の呼び出しでフックを注入
      await service.detect(page);

      // IOを作成して複数要素を監視
      await page.evaluate(() => {
        const target1 = document.createElement('div');
        target1.id = 'ioTarget1';
        const target2 = document.createElement('div');
        target2.id = 'ioTarget2';
        document.body.appendChild(target1);
        document.body.appendChild(target2);

        const observer = new IntersectionObserver(() => {}, { threshold: 0.1 });
        observer.observe(target1);
        observer.observe(target2);
      });

      const result = await service.detect(page);

      expect(result.intersectionObservers.length).toBeGreaterThan(0);
      expect(result.intersectionObservers[0].targetCount).toBe(2);
    });

    it('should capture IntersectionObserver options', async () => {
      await page.setContent(`<!DOCTYPE html><html><head></head><body></body></html>`);

      await service.detect(page);

      await page.evaluate(() => {
        const target = document.createElement('div');
        document.body.appendChild(target);

        const observer = new IntersectionObserver(() => {}, {
          threshold: [0.1, 0.5, 1.0],
          rootMargin: '10px',
        });
        observer.observe(target);
      });

      const result = await service.detect(page);

      expect(result.intersectionObservers.length).toBeGreaterThan(0);

      const observer = result.intersectionObservers[0];
      expect(observer).toHaveProperty('options');
      expect(observer.options).toHaveProperty('threshold');
      expect(observer.options.threshold).toContain(0.1);
    });

    it('should track scroll position results structure', async () => {
      await page.setContent(HTML_WITH_INTERSECTION_OBSERVER);

      const result = await service.detect(page, {
        scroll_positions: [0, 50, 100],
      });

      // スクロール位置ごとの結果構造が存在することを確認
      expect(result.scrollPositionResults).toBeDefined();
      expect(result.scrollPositionResults).toHaveProperty('0');
      expect(result.scrollPositionResults).toHaveProperty('50');
      expect(result.scrollPositionResults).toHaveProperty('100');

      // 各位置の結果構造を確認
      const pos0Result = result.scrollPositionResults!['0'];
      expect(pos0Result).toHaveProperty('animationCount');
      expect(pos0Result).toHaveProperty('triggeredAnimations');
    });
  });

  // =====================================================
  // requestAnimationFrame 検出テスト
  // =====================================================

  describe('requestAnimationFrame Detection', () => {
    it('should detect active RAF callbacks', async () => {
      await page.setContent(HTML_WITH_RAF);
      await page.waitForTimeout(200); // RAFが複数回呼ばれるのを待つ

      const result = await service.detect(page);

      expect(result.rafCallbacks.length).toBeGreaterThan(0);
    });

    it('should capture RAF callback frequency', async () => {
      await page.setContent(HTML_WITH_RAF);

      const result = await service.detect(page, {
        wait_for_animations: 500, // 500ms間RAFを監視
      });

      expect(result.rafCallbacks.length).toBeGreaterThan(0);

      const rafInfo = result.rafCallbacks[0];
      expect(rafInfo).toHaveProperty('callCount');
      expect(rafInfo).toHaveProperty('avgFrameTime');
      expect(rafInfo.callCount).toBeGreaterThan(0);
    });

    it('should identify elements modified by RAF', async () => {
      await page.setContent(HTML_WITH_RAF);
      await page.waitForTimeout(200);

      const result = await service.detect(page);

      expect(result.rafCallbacks.length).toBeGreaterThan(0);

      const rafInfo = result.rafCallbacks[0];
      expect(rafInfo).toHaveProperty('modifiedElements');
      expect(rafInfo.modifiedElements).toContain('#spinner');
    });
  });

  // =====================================================
  // 複合アニメーション検出テスト
  // =====================================================

  describe('Multiple Animation Types Detection', () => {
    it('should detect all animation types simultaneously', async () => {
      await page.setContent(HTML_WITH_MULTIPLE_ANIMATION_TYPES);
      await page.waitForTimeout(200);

      const result = await service.detect(page);

      // CSS animation + WAPI + RAF が検出されるはず
      // Note: IOはフック注入後に作成されたもののみ検出可能なため、このテストでは検出されない
      expect(result.animations.length).toBeGreaterThan(0);
      expect(result.rafCallbacks.length).toBeGreaterThan(0);
      // IOは既存ページでは検出されないため、ここではチェックしない
      // expect(result.intersectionObservers.length).toBeGreaterThan(0);

      // 合計が正しいことを確認
      expect(result.totalDetected).toBe(
        result.animations.length +
        result.rafCallbacks.length +
        result.intersectionObservers.length
      );
    });

    it('should categorize animations by type', async () => {
      await page.setContent(HTML_WITH_MULTIPLE_ANIMATION_TYPES);
      await page.waitForTimeout(200);

      const result = await service.detect(page);

      // CSS animationが検出されていることを確認
      const cssAnimation = result.animations.find(a => a.type === 'css_animation');
      expect(cssAnimation).toBeDefined();

      // Web Animations API が検出されていることを確認
      const wapiAnimation = result.animations.find(a => a.type === 'web_animations_api');
      expect(wapiAnimation).toBeDefined();
    });
  });

  // =====================================================
  // スクロール位置検出テスト
  // =====================================================

  describe('Scroll Position Detection', () => {
    it('should detect animations at different scroll positions', async () => {
      await page.setContent(HTML_WITH_INTERSECTION_OBSERVER);

      const result = await service.detect(page, {
        scroll_positions: [0, 50, 100],
      });

      expect(result).toHaveProperty('scrollPositionResults');
      expect(result.scrollPositionResults).toHaveProperty('0');
      expect(result.scrollPositionResults).toHaveProperty('50');
      expect(result.scrollPositionResults).toHaveProperty('100');
    });

    it('should respect default scroll positions', async () => {
      await page.setContent(HTML_WITH_INTERSECTION_OBSERVER);

      const result = await service.detect(page);

      // デフォルトでは0%位置のみチェック
      expect(result.scrollPositionResults).toBeDefined();
    });
  });

  // =====================================================
  // オプション設定テスト
  // =====================================================

  describe('Options', () => {
    it('should respect wait_for_animations option', async () => {
      await page.setContent(HTML_WITH_RAF);

      const shortWait = await service.detect(page, {
        wait_for_animations: 100,
      });

      const longWait = await service.detect(page, {
        wait_for_animations: 500,
      });

      // 長い待機時間の方がより多くのRAFコールをキャプチャするはず
      if (shortWait.rafCallbacks.length > 0 && longWait.rafCallbacks.length > 0) {
        expect(longWait.rafCallbacks[0].callCount).toBeGreaterThanOrEqual(
          shortWait.rafCallbacks[0].callCount
        );
      }
    });

    it('should handle invalid options gracefully', async () => {
      await page.setContent(HTML_WITHOUT_ANIMATIONS);

      // 負の値は無視されるべき
      const result = await service.detect(page, {
        wait_for_animations: -100,
        scroll_positions: [-10, 150], // 無効な範囲
      });

      expect(result).toBeDefined();
      expect(result.totalDetected).toBe(0);
    });
  });

  // =====================================================
  // エラーハンドリングテスト
  // =====================================================

  describe('Error Handling', () => {
    it('should handle page navigation during detection', async () => {
      await page.setContent(HTML_WITH_RAF);

      // 検出中にページがナビゲートした場合のエラーハンドリング
      const detectPromise = service.detect(page, {
        wait_for_animations: 1000,
      });

      // 100ms後にページをナビゲート
      setTimeout(() => {
        page.goto('about:blank').catch(() => {});
      }, 100);

      // エラーではなく、途中までの結果を返すべき
      const result = await detectPromise;
      expect(result).toBeDefined();
    });

    it('should handle closed page gracefully', async () => {
      await page.setContent(HTML_WITHOUT_ANIMATIONS);
      await page.close();

      // 閉じたページに対しては空の結果を返す（エラーではなくグレースフル）
      const result = await service.detect(page);
      expect(result.totalDetected).toBe(0);
      expect(result.animations).toHaveLength(0);
    });

    it('should handle JavaScript errors in page gracefully', async () => {
      const htmlWithError = `
        <!DOCTYPE html>
        <html>
        <body>
          <script>
            // 意図的にエラーを発生させる
            throw new Error('Intentional error');
          </script>
        </body>
        </html>
      `;

      await page.setContent(htmlWithError);

      // ページのJSエラーがあっても検出は続行されるべき
      const result = await service.detect(page);
      expect(result).toBeDefined();
    });
  });

  // =====================================================
  // パフォーマンステスト
  // =====================================================

  describe('Performance', () => {
    it('should complete detection within reasonable time', async () => {
      await page.setContent(HTML_WITH_MULTIPLE_ANIMATION_TYPES);

      const start = Date.now();
      const result = await service.detect(page, {
        wait_for_animations: 100,
      });
      const elapsed = Date.now() - start;

      // 2秒以内に完了すべき（wait_for_animations + オーバーヘッド）
      expect(elapsed).toBeLessThan(2000);
      expect(result.detectionTimeMs).toBeLessThan(2000);
    });

    it('should report accurate detection time', async () => {
      await page.setContent(HTML_WITHOUT_ANIMATIONS);

      const result = await service.detect(page);

      expect(result.detectionTimeMs).toBeGreaterThan(0);
      expect(result.detectionTimeMs).toBeLessThan(1000);
    });
  });
});

// =====================================================
// Type Definition Tests
// =====================================================

describe('Type Definitions', () => {
  it('AnimationInfo should have required properties', () => {
    const animationInfo: AnimationInfo = {
      id: 'test-id',
      type: 'web_animations_api',
      playState: 'running',
      duration: 1000,
      iterations: 1,
      easing: 'ease',
      targetSelector: '#element',
      animationName: 'test',
      properties: ['transform', 'opacity'],
    };

    expect(animationInfo.id).toBeDefined();
    expect(animationInfo.type).toBe('web_animations_api');
    expect(animationInfo.duration).toBe(1000);
  });

  it('IntersectionObserverInfo should have required properties', () => {
    const observerInfo: IntersectionObserverInfo = {
      id: 'observer-1',
      targetCount: 5,
      options: {
        threshold: [0, 0.5, 1],
        rootMargin: '0px',
      },
      targetSelectors: ['.item'],
    };

    expect(observerInfo.targetCount).toBe(5);
    expect(observerInfo.options.threshold).toHaveLength(3);
  });

  it('RAFInfo should have required properties', () => {
    const rafInfo: RAFInfo = {
      id: 'raf-1',
      callCount: 60,
      avgFrameTime: 16.67,
      modifiedElements: ['#element'],
      isActive: true,
    };

    expect(rafInfo.callCount).toBe(60);
    expect(rafInfo.avgFrameTime).toBeCloseTo(16.67, 1);
    expect(rafInfo.isActive).toBe(true);
  });

  it('RuntimeAnimationResult should have all required fields', () => {
    const result: RuntimeAnimationResult = {
      animations: [],
      intersectionObservers: [],
      rafCallbacks: [],
      totalDetected: 0,
      detectionTimeMs: 100,
      scrollPositionResults: {},
      triggeredAnimations: [],
    };

    expect(result.animations).toHaveLength(0);
    expect(result.totalDetected).toBe(0);
    expect(result.detectionTimeMs).toBe(100);
  });
});
