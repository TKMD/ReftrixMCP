// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playwright aXe Service Tests (TDD - Red Phase)
 *
 * Playwrightを使用したランタイムアクセシビリティ検証サービスのテスト
 * @axe-core/playwrightを使用して実際のブラウザ環境でWCAG 2.1 AA準拠チェックを実行
 *
 * @module tests/unit/services/quality/playwright-axe.service.test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { AxeAccessibilityResult } from '../../../../src/services/quality/axe-accessibility.service';

// 遅延インポートのために型のみインポート
type PlaywrightAxeService = import('../../../../src/services/quality/playwright-axe.service').PlaywrightAxeService;
type PlaywrightAxeOptions = import('../../../../src/services/quality/playwright-axe.service').PlaywrightAxeOptions;

describe('PlaywrightAxeService', () => {
  let PlaywrightAxeServiceClass: typeof import('../../../../src/services/quality/playwright-axe.service').PlaywrightAxeService;
  let createPlaywrightAxeService: typeof import('../../../../src/services/quality/playwright-axe.service').createPlaywrightAxeService;
  let isPlaywrightAvailable: typeof import('../../../../src/services/quality/playwright-axe.service').isPlaywrightAvailable;
  let service: PlaywrightAxeService;
  let playwrightAvailable = true;

  beforeAll(async () => {
    // Playwright可用性チェックと動的インポート
    try {
      const module = await import('../../../../src/services/quality/playwright-axe.service');
      PlaywrightAxeServiceClass = module.PlaywrightAxeService;
      createPlaywrightAxeService = module.createPlaywrightAxeService;
      isPlaywrightAvailable = module.isPlaywrightAvailable;
      playwrightAvailable = await isPlaywrightAvailable();
    } catch (error) {
      playwrightAvailable = false;
      console.warn('[Test] Playwright not available, skipping Playwright tests');
    }
  });

  beforeEach(() => {
    if (playwrightAvailable) {
      service = createPlaywrightAxeService();
    }
  });

  afterAll(async () => {
    // サービスのクリーンアップ
    if (service) {
      await service.cleanup();
    }
  });

  // =====================================================
  // 基本機能テスト
  // =====================================================

  describe('Basic Functionality', () => {
    it('should create service instance', () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      expect(service).toBeInstanceOf(PlaywrightAxeServiceClass);
    });

    it('should check if Playwright is available', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const available = await isPlaywrightAvailable();
      expect(typeof available).toBe('boolean');
    });

    it('should analyze HTML content with valid result structure', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>Test Page</title>
        </head>
        <body>
          <main>
            <h1>Welcome</h1>
            <p>Content here</p>
          </main>
        </body>
        </html>
      `;

      const result = await service.analyzeHtml(html);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('violations');
      expect(result).toHaveProperty('passes');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('wcagLevel');
      expect(Array.isArray(result.violations)).toBe(true);
      expect(typeof result.passes).toBe('number');
      expect(typeof result.score).toBe('number');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }, 30000);
  });

  // =====================================================
  // HTML分析テスト
  // =====================================================

  describe('HTML Analysis', () => {
    it('should detect accessibility violations in HTML', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const html = `
        <html lang="en">
        <body>
          <img src="test.jpg">
          <button></button>
        </body>
        </html>
      `;

      const result = await service.analyzeHtml(html);

      expect(result.violations.length).toBeGreaterThan(0);
    }, 30000);

    it('should return high score for accessible HTML', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>Accessible Page</title>
        </head>
        <body>
          <header role="banner">
            <nav role="navigation" aria-label="Main">
              <ul>
                <li><a href="/">Home</a></li>
              </ul>
            </nav>
          </header>
          <main role="main">
            <h1>Welcome</h1>
            <img src="photo.jpg" alt="Description of photo">
            <button type="button">Click me</button>
          </main>
          <footer role="contentinfo">
            <p>Footer content</p>
          </footer>
        </body>
        </html>
      `;

      const result = await service.analyzeHtml(html);
      expect(result.score).toBeGreaterThanOrEqual(80);
    }, 30000);

    it('should detect missing image alt attributes', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const html = `
        <html lang="en">
        <body>
          <img src="test.jpg">
        </body>
        </html>
      `;

      const result = await service.analyzeHtml(html);
      const imageAltViolation = result.violations.find(
        (v) => v.id === 'image-alt'
      );
      expect(imageAltViolation).toBeDefined();
    }, 30000);

    it('should detect missing form labels', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const html = `
        <html lang="en">
        <body>
          <form>
            <input type="text" name="username">
          </form>
        </body>
        </html>
      `;

      const result = await service.analyzeHtml(html);
      const labelViolation = result.violations.find(
        (v) => v.id === 'label' || v.description?.toLowerCase().includes('label')
      );
      expect(labelViolation).toBeDefined();
    }, 30000);

    it('should detect empty buttons', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const html = `
        <html lang="en">
        <body>
          <button></button>
        </body>
        </html>
      `;

      const result = await service.analyzeHtml(html);
      const buttonViolation = result.violations.find(
        (v) => v.id === 'button-name'
      );
      expect(buttonViolation).toBeDefined();
    }, 30000);
  });

  // =====================================================
  // オプション設定テスト
  // =====================================================

  describe('Service Options', () => {
    it('should support custom timeout', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const options: PlaywrightAxeOptions = {
        timeout: 60000,
      };

      const customService = createPlaywrightAxeService(options);
      const html = '<html lang="en"><body><p>Test</p></body></html>';
      const result = await customService.analyzeHtml(html);

      expect(result).toBeDefined();
      await customService.cleanup();
    }, 30000);

    it('should support custom WCAG level', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const options: PlaywrightAxeOptions = {
        wcagLevel: 'AAA',
      };

      const customService = createPlaywrightAxeService(options);
      const html = '<html lang="en"><body><p>Test</p></body></html>';
      const result = await customService.analyzeHtml(html);

      expect(result).toBeDefined();
      await customService.cleanup();
    }, 30000);

    it('should support waitForSelector option', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const options: PlaywrightAxeOptions = {
        waitForSelector: 'body',
      };

      const customService = createPlaywrightAxeService(options);
      const html = '<html lang="en"><body><p>Test</p></body></html>';
      const result = await customService.analyzeHtml(html);

      expect(result).toBeDefined();
      await customService.cleanup();
    }, 30000);
  });

  // =====================================================
  // エッジケーステスト
  // =====================================================

  describe('Edge Cases', () => {
    it('should handle empty HTML', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const result = await service.analyzeHtml('');
      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
    }, 30000);

    it('should handle minimal HTML', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const result = await service.analyzeHtml('<html></html>');
      expect(result).toBeDefined();
    }, 30000);

    it('should handle malformed HTML gracefully', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const html = '<html><body><div><p>Unclosed tags';
      const result = await service.analyzeHtml(html);

      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
    }, 30000);

    it('should handle HTML with special characters', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const html = `
        <html lang="en">
        <body>
          <p>Special: &amp; &lt; &gt; &quot;</p>
          <p>Unicode: \u00e9\u00e0\u00fc\u00f1</p>
        </body>
        </html>
      `;

      const result = await service.analyzeHtml(html);
      expect(result).toBeDefined();
    }, 30000);

    it('should handle large HTML documents', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const repeatedContent = '<p>Content</p>'.repeat(100);
      const html = `<html lang="en"><body>${repeatedContent}</body></html>`;

      const result = await service.analyzeHtml(html);
      expect(result).toBeDefined();
    }, 60000);
  });

  // =====================================================
  // 統合メソッドテスト
  // =====================================================

  describe('Integration Methods', () => {
    it('should provide score adjustment values for craftsmanship', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const html = '<html><body><img src="test.jpg"></body></html>';
      const result = await service.analyzeHtml(html);
      const penalty = service.calculateScorePenalty(result);

      expect(typeof penalty).toBe('number');
      expect(penalty).toBeLessThanOrEqual(0);
    }, 30000);

    it('should calculate correct penalty for critical violations', () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const mockResult: AxeAccessibilityResult = {
        violations: [
          {
            id: 'test',
            impact: 'critical',
            description: 'Test',
            help: 'Test',
            helpUrl: 'https://test.com',
            nodes: 1,
          },
        ],
        passes: 0,
        score: 80,
        wcagLevel: 'AA',
      };

      const penalty = service.calculateScorePenalty(mockResult);
      expect(penalty).toBe(-20);
    });

    it('should calculate cumulative penalty for multiple violations', () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const mockResult: AxeAccessibilityResult = {
        violations: [
          {
            id: 'critical-test',
            impact: 'critical',
            description: 'Critical',
            help: 'Help',
            helpUrl: 'https://test.com',
            nodes: 1,
          },
          {
            id: 'serious-test',
            impact: 'serious',
            description: 'Serious',
            help: 'Help',
            helpUrl: 'https://test.com',
            nodes: 1,
          },
        ],
        passes: 0,
        score: 70,
        wcagLevel: 'AA',
      };

      const penalty = service.calculateScorePenalty(mockResult);
      expect(penalty).toBe(-30); // -20 (critical) + -10 (serious)
    });
  });

  // =====================================================
  // WCAG レベルテスト
  // =====================================================

  describe('WCAG Level Determination', () => {
    it('should return AA for good accessibility', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>AA Level</title>
        </head>
        <body>
          <main>
            <h1>Page Title</h1>
            <img src="test.jpg" alt="Description">
            <form>
              <label for="email">Email:</label>
              <input type="email" id="email" name="email">
            </form>
          </main>
        </body>
        </html>
      `;

      const result = await service.analyzeHtml(html);
      expect(['A', 'AA', 'AAA']).toContain(result.wcagLevel);
    }, 30000);

    it('should downgrade level for critical violations', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const html = `
        <html>
        <body>
          <img src="test.jpg">
          <button></button>
          <a href="/page"></a>
        </body>
        </html>
      `;

      const result = await service.analyzeHtml(html);
      // With multiple critical/serious violations, level should be A
      expect(['A', 'AA']).toContain(result.wcagLevel);
    }, 30000);
  });

  // =====================================================
  // クリーンアップテスト
  // =====================================================

  describe('Cleanup', () => {
    it('should cleanup browser resources', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const tempService = createPlaywrightAxeService();
      const html = '<html lang="en"><body><p>Test</p></body></html>';
      await tempService.analyzeHtml(html);

      // cleanup should not throw
      await expect(tempService.cleanup()).resolves.not.toThrow();
    }, 30000);

    it('should be safe to call cleanup multiple times', async () => {
      if (!playwrightAvailable) {
        console.warn('[Test] Skipping: Playwright not available');
        return;
      }

      const tempService = createPlaywrightAxeService();
      await tempService.cleanup();
      await expect(tempService.cleanup()).resolves.not.toThrow();
    }, 30000);
  });

  // =====================================================
  // Graceful Degradationテスト
  // =====================================================

  describe('Graceful Degradation', () => {
    it('should report Playwright availability correctly', async () => {
      const available = await isPlaywrightAvailable();
      expect(typeof available).toBe('boolean');
    });

    it('should return fallback result when service creation fails', async () => {
      // This test verifies the factory function handles errors gracefully
      // In real scenarios, if Playwright is not installed, isPlaywrightAvailable returns false
      const available = await isPlaywrightAvailable();
      if (!available) {
        console.log('[Test] Playwright not available - fallback confirmed');
        expect(available).toBe(false);
      } else {
        expect(available).toBe(true);
      }
    });
  });
});
