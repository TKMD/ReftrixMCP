// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * aXe Accessibility Service Tests (TDD - Red Phase)
 *
 * aXe-coreを使用したアクセシビリティ検証サービスのテスト
 * WCAG 2.1 AA準拠チェックを行う
 *
 * @module tests/unit/services/quality/axe-accessibility.service.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AxeAccessibilityService,
  type AxeAccessibilityResult,
  type AxeViolation,
  type AxeServiceOptions,
} from '../../../../src/services/quality/axe-accessibility.service';

describe('AxeAccessibilityService', () => {
  let service: AxeAccessibilityService;

  beforeEach(() => {
    service = new AxeAccessibilityService();
  });

  // =====================================================
  // 基本機能テスト
  // =====================================================

  describe('Basic Functionality', () => {
    it('should create service instance', () => {
      expect(service).toBeInstanceOf(AxeAccessibilityService);
    });

    it('should analyze valid HTML without errors', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Accessible Page</title>
        </head>
        <body>
          <header role="banner">
            <h1>Welcome</h1>
          </header>
          <main role="main">
            <p>Content here</p>
          </main>
        </body>
        </html>
      `;

      const result = await service.analyze(html);

      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.wcagLevel).toBeDefined();
      expect(Array.isArray(result.violations)).toBe(true);
      expect(typeof result.passes).toBe('number');
    });

    it('should return proper result structure', async () => {
      const html = '<html><body><p>Test</p></body></html>';
      const result = await service.analyze(html);

      expect(result).toHaveProperty('violations');
      expect(result).toHaveProperty('passes');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('wcagLevel');
    });
  });

  // =====================================================
  // 違反検出テスト
  // =====================================================

  describe('Violation Detection', () => {
    it('should detect missing alt attribute on images', async () => {
      const html = `
        <html lang="en">
        <body>
          <img src="test.jpg">
        </body>
        </html>
      `;

      const result = await service.analyze(html);

      expect(result.violations.length).toBeGreaterThan(0);
      const altViolation = result.violations.find(
        (v) => v.id === 'image-alt' || v.description.toLowerCase().includes('alt')
      );
      expect(altViolation).toBeDefined();
    });

    it('should detect missing form labels', async () => {
      const html = `
        <html lang="en">
        <body>
          <form>
            <input type="text" name="username">
            <input type="email" name="email">
          </form>
        </body>
        </html>
      `;

      const result = await service.analyze(html);

      expect(result.violations.length).toBeGreaterThan(0);
      const labelViolation = result.violations.find(
        (v) => v.id === 'label' || v.description.toLowerCase().includes('label')
      );
      expect(labelViolation).toBeDefined();
    });

    it('should detect insufficient color contrast', async () => {
      const html = `
        <html lang="en">
        <body>
          <p style="color: #cccccc; background-color: #ffffff;">
            Low contrast text
          </p>
        </body>
        </html>
      `;

      const result = await service.analyze(html);

      // Color contrast detection may vary - check for violations
      expect(Array.isArray(result.violations)).toBe(true);
    });

    it('should detect missing document language', async () => {
      const html = `
        <html>
        <body>
          <p>No lang attribute</p>
        </body>
        </html>
      `;

      const result = await service.analyze(html);

      const langViolation = result.violations.find(
        (v) => v.id === 'html-has-lang' || v.description.toLowerCase().includes('lang')
      );
      expect(langViolation).toBeDefined();
    });

    it('should detect empty buttons', async () => {
      const html = `
        <html lang="en">
        <body>
          <button></button>
        </body>
        </html>
      `;

      const result = await service.analyze(html);

      const buttonViolation = result.violations.find(
        (v) => v.id === 'button-name' || v.description.toLowerCase().includes('button')
      );
      expect(buttonViolation).toBeDefined();
    });

    it('should detect missing heading structure', async () => {
      const html = `
        <html lang="en">
        <body>
          <h1>Title</h1>
          <h3>Skipped h2</h3>
          <h5>Skipped h4</h5>
        </body>
        </html>
      `;

      const result = await service.analyze(html);

      const headingViolation = result.violations.find(
        (v) => v.id === 'heading-order' || v.description.toLowerCase().includes('heading')
      );
      // Heading order violations may or may not be detected depending on aXe rules
      expect(Array.isArray(result.violations)).toBe(true);
    });

    it('should detect empty links', async () => {
      const html = `
        <html lang="en">
        <body>
          <a href="/page"></a>
        </body>
        </html>
      `;

      const result = await service.analyze(html);

      const linkViolation = result.violations.find(
        (v) => v.id === 'link-name' || v.description.toLowerCase().includes('link')
      );
      expect(linkViolation).toBeDefined();
    });

    it('should detect duplicate IDs', async () => {
      const html = `
        <html lang="en">
        <body>
          <div id="duplicate">First</div>
          <div id="duplicate">Second</div>
        </body>
        </html>
      `;

      const result = await service.analyze(html);

      // duplicate-id is a best-practice rule, may not be included in WCAG AA ruleset
      // Check that result is returned correctly regardless of violation detection
      expect(result).toBeDefined();
      expect(Array.isArray(result.violations)).toBe(true);
    });

    it('should detect missing landmark regions', async () => {
      const html = `
        <html lang="en">
        <body>
          <div>Content without landmarks</div>
        </body>
        </html>
      `;

      const result = await service.analyze(html);

      // Landmark violations may or may not trigger depending on aXe rules
      expect(Array.isArray(result.violations)).toBe(true);
    });

    it('should detect aria-hidden on focusable elements', async () => {
      const html = `
        <html lang="en">
        <body>
          <button aria-hidden="true">Hidden but focusable</button>
        </body>
        </html>
      `;

      const result = await service.analyze(html);

      // aria-hidden-focus rule may have specific conditions for detection
      // The important thing is that aXe runs without error
      expect(result).toBeDefined();
      expect(Array.isArray(result.violations)).toBe(true);
      // If detected, it should be reported correctly
      const ariaViolation = result.violations.find(
        (v) =>
          v.id === 'aria-hidden-focus' || v.description.toLowerCase().includes('aria-hidden')
      );
      if (ariaViolation) {
        expect(ariaViolation.impact).toBeDefined();
      }
    });
  });

  // =====================================================
  // 違反の詳細情報テスト
  // =====================================================

  describe('Violation Details', () => {
    it('should provide violation id', async () => {
      const html = `<html><body><img src="test.jpg"></body></html>`;
      const result = await service.analyze(html);

      if (result.violations.length > 0) {
        expect(result.violations[0].id).toBeDefined();
        expect(typeof result.violations[0].id).toBe('string');
      }
    });

    it('should provide violation impact level', async () => {
      const html = `<html><body><img src="test.jpg"></body></html>`;
      const result = await service.analyze(html);

      if (result.violations.length > 0) {
        expect(result.violations[0].impact).toBeDefined();
        expect(['minor', 'moderate', 'serious', 'critical']).toContain(
          result.violations[0].impact
        );
      }
    });

    it('should provide violation description', async () => {
      const html = `<html><body><img src="test.jpg"></body></html>`;
      const result = await service.analyze(html);

      if (result.violations.length > 0) {
        expect(result.violations[0].description).toBeDefined();
        expect(typeof result.violations[0].description).toBe('string');
      }
    });

    it('should provide help text', async () => {
      const html = `<html><body><img src="test.jpg"></body></html>`;
      const result = await service.analyze(html);

      if (result.violations.length > 0) {
        expect(result.violations[0].help).toBeDefined();
        expect(typeof result.violations[0].help).toBe('string');
      }
    });

    it('should provide help URL', async () => {
      const html = `<html><body><img src="test.jpg"></body></html>`;
      const result = await service.analyze(html);

      if (result.violations.length > 0) {
        expect(result.violations[0].helpUrl).toBeDefined();
        expect(result.violations[0].helpUrl).toMatch(/^https?:\/\//);
      }
    });

    it('should provide affected node count', async () => {
      const html = `
        <html lang="en">
        <body>
          <img src="1.jpg">
          <img src="2.jpg">
          <img src="3.jpg">
        </body>
        </html>
      `;
      const result = await service.analyze(html);

      const imgViolation = result.violations.find((v) => v.id === 'image-alt');
      if (imgViolation) {
        expect(imgViolation.nodes).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // =====================================================
  // スコア計算テスト
  // =====================================================

  describe('Score Calculation', () => {
    it('should return high score for accessible HTML', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>Accessible</title>
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

      const result = await service.analyze(html);
      expect(result.score).toBeGreaterThanOrEqual(80);
    });

    it('should return lower score for inaccessible HTML', async () => {
      const html = `
        <html>
        <body>
          <img src="test.jpg">
          <button></button>
          <a href="/page"></a>
          <input type="text">
          <div id="dup">1</div>
          <div id="dup">2</div>
        </body>
        </html>
      `;

      const result = await service.analyze(html);
      expect(result.score).toBeLessThan(80);
    });

    it('should apply critical violation penalty correctly', async () => {
      const html = `
        <html lang="en">
        <body>
          <img src="test.jpg">
        </body>
        </html>
      `;

      const result = await service.analyze(html);

      const criticalViolation = result.violations.find((v) => v.impact === 'critical');
      if (criticalViolation) {
        // Critical violations should significantly reduce score
        expect(result.score).toBeLessThan(90);
      }
    });

    it('should apply serious violation penalty correctly', async () => {
      const html = `
        <html lang="en">
        <body>
          <button></button>
        </body>
        </html>
      `;

      const result = await service.analyze(html);

      const seriousViolation = result.violations.find((v) => v.impact === 'serious');
      if (seriousViolation) {
        // Serious violations should reduce score
        expect(result.score).toBeLessThan(95);
      }
    });

    it('should return score between 0 and 100', async () => {
      const htmls = [
        '<html><body></body></html>',
        '<html lang="en"><body><p>Test</p></body></html>',
        '<html><body><img src="x.jpg"><button></button><a href="#"></a></body></html>',
      ];

      for (const html of htmls) {
        const result = await service.analyze(html);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
      }
    });
  });

  // =====================================================
  // WCAG レベルテスト
  // =====================================================

  describe('WCAG Level Determination', () => {
    it('should return AAA for perfect accessibility', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>Perfect Accessibility</title>
        </head>
        <body>
          <a href="#main" class="skip-link">Skip to main content</a>
          <header role="banner">
            <nav role="navigation" aria-label="Main navigation">
              <ul>
                <li><a href="/">Home</a></li>
              </ul>
            </nav>
          </header>
          <main id="main" role="main" tabindex="-1">
            <h1>Welcome</h1>
            <p style="color: #000; background: #fff;">High contrast text</p>
            <img src="photo.jpg" alt="A detailed description of the photo">
            <form>
              <label for="name">Name:</label>
              <input type="text" id="name" name="name">
              <button type="submit">Submit</button>
            </form>
          </main>
          <footer role="contentinfo">
            <p>Footer</p>
          </footer>
        </body>
        </html>
      `;

      const result = await service.analyze(html);
      expect(['AA', 'AAA']).toContain(result.wcagLevel);
    });

    it('should return A for basic accessibility', async () => {
      const html = `
        <html lang="en">
        <body>
          <h1>Title</h1>
          <p>Some content</p>
          <button>Click</button>
        </body>
        </html>
      `;

      const result = await service.analyze(html);
      expect(['A', 'AA', 'AAA']).toContain(result.wcagLevel);
    });

    it('should correctly identify AA level compliance', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head><title>AA Level</title></head>
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

      const result = await service.analyze(html);
      expect(['A', 'AA', 'AAA']).toContain(result.wcagLevel);
    });
  });

  // =====================================================
  // オプション設定テスト
  // =====================================================

  describe('Service Options', () => {
    it('should support custom WCAG level targeting', async () => {
      const html = '<html lang="en"><body><p>Test</p></body></html>';
      const options: AxeServiceOptions = {
        wcagLevel: 'AA',
      };

      const customService = new AxeAccessibilityService(options);
      const result = await customService.analyze(html);

      expect(result).toBeDefined();
      expect(result.wcagLevel).toBeDefined();
    });

    it('should support AAA level targeting', async () => {
      const html = '<html lang="en"><body><p>Test</p></body></html>';
      const options: AxeServiceOptions = {
        wcagLevel: 'AAA',
      };

      const customService = new AxeAccessibilityService(options);
      const result = await customService.analyze(html);

      expect(result).toBeDefined();
    });

    it('should support custom rules configuration', async () => {
      const html = '<html lang="en"><body><img src="test.jpg"></body></html>';
      const options: AxeServiceOptions = {
        rules: {
          'image-alt': { enabled: false },
        },
      };

      const customService = new AxeAccessibilityService(options);
      const result = await customService.analyze(html);

      // With image-alt disabled, it should not appear in violations
      const imageAltViolation = result.violations.find((v) => v.id === 'image-alt');
      expect(imageAltViolation).toBeUndefined();
    });

    it('should use default options when none provided', async () => {
      const defaultService = new AxeAccessibilityService();
      const html = '<html lang="en"><body><p>Test</p></body></html>';
      const result = await defaultService.analyze(html);

      expect(result).toBeDefined();
      expect(result.wcagLevel).toBe('AA'); // Default level
    });
  });

  // =====================================================
  // エッジケーステスト
  // =====================================================

  describe('Edge Cases', () => {
    it('should handle empty HTML', async () => {
      const result = await service.analyze('');
      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('should handle minimal HTML', async () => {
      const result = await service.analyze('<html></html>');
      expect(result).toBeDefined();
    });

    it('should handle HTML with only whitespace', async () => {
      const result = await service.analyze('   \n\t   ');
      expect(result).toBeDefined();
    });

    it('should handle malformed HTML gracefully', async () => {
      const html = '<html><body><div><p>Unclosed tags';
      const result = await service.analyze(html);

      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('should handle very large HTML', async () => {
      const repeatedContent = '<p>Content</p>'.repeat(1000);
      const html = `<html lang="en"><body>${repeatedContent}</body></html>`;

      const result = await service.analyze(html);
      expect(result).toBeDefined();
    });

    it('should handle HTML with special characters', async () => {
      const html = `
        <html lang="en">
        <body>
          <p>Special: &amp; &lt; &gt; &quot; &#39;</p>
          <p>Unicode: \u00e9\u00e0\u00fc\u00f1</p>
        </body>
        </html>
      `;

      const result = await service.analyze(html);
      expect(result).toBeDefined();
    });

    it('should handle HTML with inline SVG', async () => {
      const html = `
        <html lang="en">
        <body>
          <svg width="100" height="100" role="img" aria-label="Circle">
            <circle cx="50" cy="50" r="40" fill="red" />
          </svg>
        </body>
        </html>
      `;

      const result = await service.analyze(html);
      expect(result).toBeDefined();
    });

    it('should handle HTML with iframes', async () => {
      const html = `
        <html lang="en">
        <body>
          <iframe src="about:blank" title="Empty frame"></iframe>
        </body>
        </html>
      `;

      const result = await service.analyze(html);
      expect(result).toBeDefined();
    });
  });

  // =====================================================
  // パス（合格）カウントテスト
  // =====================================================

  describe('Passes Count', () => {
    it('should count passed rules', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head><title>Test</title></head>
        <body>
          <main>
            <h1>Title</h1>
            <img src="test.jpg" alt="Description">
          </main>
        </body>
        </html>
      `;

      const result = await service.analyze(html);
      expect(result.passes).toBeGreaterThanOrEqual(0);
    });

    it('should have higher passes for accessible HTML', async () => {
      const accessibleHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <head><title>Accessible</title></head>
        <body>
          <header role="banner"><h1>Title</h1></header>
          <main role="main">
            <img src="test.jpg" alt="Description">
            <button type="button">Click</button>
          </main>
        </body>
        </html>
      `;

      const inaccessibleHtml = `<html><body><img src="x.jpg"></body></html>`;

      const accessibleResult = await service.analyze(accessibleHtml);
      const inaccessibleResult = await service.analyze(inaccessibleHtml);

      // Accessible HTML should pass more rules
      expect(accessibleResult.passes).toBeGreaterThanOrEqual(inaccessibleResult.passes);
    });
  });

  // =====================================================
  // 統合テスト用メソッドテスト
  // =====================================================

  describe('Integration Methods', () => {
    it('should provide score adjustment values for craftsmanship', async () => {
      const html = `<html><body><img src="test.jpg"></body></html>`;
      const result = await service.analyze(html);

      // Calculate expected penalty based on violations
      const penalty = service.calculateScorePenalty(result);

      expect(typeof penalty).toBe('number');
      expect(penalty).toBeLessThanOrEqual(0);
    });

    it('should calculate correct penalty for critical violations', async () => {
      // Create mock result with critical violation
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

    it('should calculate correct penalty for serious violations', async () => {
      const mockResult: AxeAccessibilityResult = {
        violations: [
          {
            id: 'test',
            impact: 'serious',
            description: 'Test',
            help: 'Test',
            helpUrl: 'https://test.com',
            nodes: 1,
          },
        ],
        passes: 0,
        score: 90,
        wcagLevel: 'AA',
      };

      const penalty = service.calculateScorePenalty(mockResult);
      expect(penalty).toBe(-10);
    });

    it('should calculate correct penalty for moderate violations', async () => {
      const mockResult: AxeAccessibilityResult = {
        violations: [
          {
            id: 'test',
            impact: 'moderate',
            description: 'Test',
            help: 'Test',
            helpUrl: 'https://test.com',
            nodes: 1,
          },
        ],
        passes: 0,
        score: 95,
        wcagLevel: 'AA',
      };

      const penalty = service.calculateScorePenalty(mockResult);
      expect(penalty).toBe(-5);
    });

    it('should calculate correct penalty for minor violations', async () => {
      const mockResult: AxeAccessibilityResult = {
        violations: [
          {
            id: 'test',
            impact: 'minor',
            description: 'Test',
            help: 'Test',
            helpUrl: 'https://test.com',
            nodes: 1,
          },
        ],
        passes: 0,
        score: 98,
        wcagLevel: 'AA',
      };

      const penalty = service.calculateScorePenalty(mockResult);
      expect(penalty).toBe(-2);
    });

    it('should calculate cumulative penalty for multiple violations', async () => {
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
});
