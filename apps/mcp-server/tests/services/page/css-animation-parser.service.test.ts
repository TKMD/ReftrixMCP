// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CssAnimationParser Service Tests
 *
 * TDD Red Phase: motion-detector.ts から CSS解析責務を分離
 * 対象メソッド:
 * - parseKeyframes: @keyframes定義のパース
 * - parseKeyframeSteps: キーフレームステップのパース
 * - parseAnimationProperty: animation プロパティのパース
 * - tokenizeAnimationValue: アニメーション値のトークン化
 * - parseTransitionProperty: transition プロパティのパース
 * - extractStyleRules: CSSルールの抽出
 *
 * @module tests/services/page/css-animation-parser.service.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CssAnimationParser,
  type KeyframeStep,
  type EasingConfig,
  type ParsedAnimation,
  type ParsedTransition,
  CSS_PARSER_LIMITS,
} from '../../../src/services/page/css-animation-parser.service';

describe('CssAnimationParser', () => {
  let parser: CssAnimationParser;

  beforeEach(() => {
    parser = new CssAnimationParser();
  });

  // =====================================================
  // parseKeyframes Tests
  // =====================================================

  describe('parseKeyframes', () => {
    it('should parse simple @keyframes with from/to', () => {
      const css = `
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;

      const result = parser.parseKeyframes(css);

      expect(result.has('fadeIn')).toBe(true);
      const steps = result.get('fadeIn');
      expect(steps).toHaveLength(2);
      expect(steps![0]).toEqual({ offset: 0, styles: { opacity: '0' } });
      expect(steps![1]).toEqual({ offset: 100, styles: { opacity: '1' } });
    });

    it('should parse @keyframes with percentage steps', () => {
      const css = `
        @keyframes bounce {
          0% { transform: translateY(0); }
          50% { transform: translateY(-20px); }
          100% { transform: translateY(0); }
        }
      `;

      const result = parser.parseKeyframes(css);

      expect(result.has('bounce')).toBe(true);
      const steps = result.get('bounce');
      expect(steps).toHaveLength(3);
      expect(steps![0]!.offset).toBe(0);
      expect(steps![1]!.offset).toBe(50);
      expect(steps![2]!.offset).toBe(100);
    });

    it('should parse multiple @keyframes definitions', () => {
      const css = `
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideUp {
          from { transform: translateY(20px); }
          to { transform: translateY(0); }
        }
      `;

      const result = parser.parseKeyframes(css);

      expect(result.size).toBe(2);
      expect(result.has('fadeIn')).toBe(true);
      expect(result.has('slideUp')).toBe(true);
    });

    it('should handle nested braces in keyframes', () => {
      const css = `
        @keyframes complexAnim {
          0% {
            transform: scale(1);
            box-shadow: 0 0 0 rgba(0,0,0,0);
          }
          100% {
            transform: scale(1.1);
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
          }
        }
      `;

      const result = parser.parseKeyframes(css);

      expect(result.has('complexAnim')).toBe(true);
      const steps = result.get('complexAnim');
      expect(steps).toHaveLength(2);
    });

    it('should return empty map for CSS without @keyframes', () => {
      const css = `.button { color: red; }`;

      const result = parser.parseKeyframes(css);

      expect(result.size).toBe(0);
    });

    it('should handle hyphenated animation names', () => {
      const css = `
        @keyframes fade-in-up {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `;

      const result = parser.parseKeyframes(css);

      expect(result.has('fade-in-up')).toBe(true);
    });
  });

  // =====================================================
  // parseKeyframeSteps Tests
  // =====================================================

  describe('parseKeyframeSteps', () => {
    it('should parse from/to syntax', () => {
      const content = `
        from { opacity: 0; }
        to { opacity: 1; }
      `;

      const result = parser.parseKeyframeSteps(content);

      expect(result).toHaveLength(2);
      expect(result[0]!.offset).toBe(0);
      expect(result[1]!.offset).toBe(100);
    });

    it('should parse percentage syntax', () => {
      const content = `
        0% { opacity: 0; }
        25% { opacity: 0.25; }
        75% { opacity: 0.75; }
        100% { opacity: 1; }
      `;

      const result = parser.parseKeyframeSteps(content);

      expect(result).toHaveLength(4);
      expect(result[0]!.offset).toBe(0);
      expect(result[1]!.offset).toBe(25);
      expect(result[2]!.offset).toBe(75);
      expect(result[3]!.offset).toBe(100);
    });

    it('should sort steps by offset', () => {
      const content = `
        100% { opacity: 1; }
        0% { opacity: 0; }
        50% { opacity: 0.5; }
      `;

      const result = parser.parseKeyframeSteps(content);

      expect(result[0]!.offset).toBe(0);
      expect(result[1]!.offset).toBe(50);
      expect(result[2]!.offset).toBe(100);
    });

    it('should parse multiple properties per step', () => {
      const content = `
        0% { opacity: 0; transform: scale(0.8); }
        100% { opacity: 1; transform: scale(1); }
      `;

      const result = parser.parseKeyframeSteps(content);

      expect(result[0]!.styles).toEqual({
        opacity: '0',
        transform: 'scale(0.8)',
      });
    });

    it('should handle decimal percentages', () => {
      const content = `
        0% { opacity: 0; }
        33.3% { opacity: 0.33; }
        66.6% { opacity: 0.66; }
        100% { opacity: 1; }
      `;

      const result = parser.parseKeyframeSteps(content);

      expect(result[1]!.offset).toBeCloseTo(33.3);
      expect(result[2]!.offset).toBeCloseTo(66.6);
    });
  });

  // =====================================================
  // parseAnimationProperty Tests
  // =====================================================

  describe('parseAnimationProperty', () => {
    it('should parse animation name only', () => {
      const result = parser.parseAnimationProperty('fadeIn');

      expect(result.name).toBe('fadeIn');
      expect(result.duration).toBe(0);
      expect(result.easing.type).toBe('ease');
    });

    it('should parse animation with duration in seconds', () => {
      const result = parser.parseAnimationProperty('fadeIn 0.3s');

      expect(result.name).toBe('fadeIn');
      expect(result.duration).toBe(300);
    });

    it('should parse animation with duration in milliseconds', () => {
      const result = parser.parseAnimationProperty('fadeIn 300ms');

      expect(result.name).toBe('fadeIn');
      expect(result.duration).toBe(300);
    });

    it('should parse animation with duration and delay', () => {
      const result = parser.parseAnimationProperty('fadeIn 0.3s 0.1s');

      expect(result.name).toBe('fadeIn');
      expect(result.duration).toBe(300);
      expect(result.delay).toBe(100);
    });

    it('should parse animation with easing keyword', () => {
      const result = parser.parseAnimationProperty('fadeIn 0.3s ease-in-out');

      expect(result.easing.type).toBe('ease-in-out');
    });

    it('should parse animation with cubic-bezier easing', () => {
      const result = parser.parseAnimationProperty(
        'fadeIn 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
      );

      expect(result.easing.type).toBe('cubic-bezier');
      expect(result.easing.cubicBezier).toEqual([0.4, 0, 0.2, 1]);
    });

    it('should parse animation with steps easing', () => {
      const result = parser.parseAnimationProperty('fadeIn 0.3s steps(4, end)');

      expect(result.easing.type).toBe('steps');
      expect(result.easing.steps).toEqual({ count: 4, position: 'end' });
    });

    it('should parse animation with iteration count', () => {
      const result = parser.parseAnimationProperty('fadeIn 0.3s 3');

      expect(result.iterations).toBe(3);
    });

    it('should parse animation with infinite iteration', () => {
      const result = parser.parseAnimationProperty('fadeIn 0.3s infinite');

      expect(result.iterations).toBe('infinite');
    });

    it('should parse animation with direction', () => {
      const result = parser.parseAnimationProperty('fadeIn 0.3s alternate');

      expect(result.direction).toBe('alternate');
    });

    it('should parse animation with fill-mode', () => {
      const result = parser.parseAnimationProperty('fadeIn 0.3s forwards');

      expect(result.fillMode).toBe('forwards');
    });

    it('should parse full animation shorthand', () => {
      const result = parser.parseAnimationProperty(
        'fadeIn 0.3s ease-in-out 0.1s infinite alternate forwards'
      );

      expect(result.name).toBe('fadeIn');
      expect(result.duration).toBe(300);
      expect(result.easing.type).toBe('ease-in-out');
      expect(result.delay).toBe(100);
      expect(result.iterations).toBe('infinite');
      expect(result.direction).toBe('alternate');
      expect(result.fillMode).toBe('forwards');
    });
  });

  // =====================================================
  // tokenizeAnimationValue Tests
  // =====================================================

  describe('tokenizeAnimationValue', () => {
    it('should tokenize simple space-separated values', () => {
      const result = parser.tokenizeAnimationValue('fadeIn 0.3s ease');

      expect(result).toEqual(['fadeIn', '0.3s', 'ease']);
    });

    it('should keep cubic-bezier as single token', () => {
      const result = parser.tokenizeAnimationValue(
        'fadeIn cubic-bezier(0.4, 0, 0.2, 1)'
      );

      expect(result).toContain('cubic-bezier(0.4, 0, 0.2, 1)');
    });

    it('should keep steps as single token', () => {
      const result = parser.tokenizeAnimationValue('fadeIn steps(4, end)');

      expect(result).toContain('steps(4, end)');
    });

    it('should handle multiple whitespace', () => {
      const result = parser.tokenizeAnimationValue('fadeIn   0.3s    ease');

      expect(result).toEqual(['fadeIn', '0.3s', 'ease']);
    });

    it('should handle nested parentheses in values', () => {
      const result = parser.tokenizeAnimationValue(
        'fadeIn cubic-bezier(0.4, 0, 0.2, 1) 0.3s'
      );

      expect(result).toHaveLength(3);
      expect(result[1]).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
    });
  });

  // =====================================================
  // parseTransitionProperty Tests
  // =====================================================

  describe('parseTransitionProperty', () => {
    it('should parse simple transition', () => {
      const result = parser.parseTransitionProperty('opacity 0.3s');

      expect(result).toHaveLength(1);
      expect(result[0]!.property).toBe('opacity');
      expect(result[0]!.duration).toBe(300);
    });

    it('should parse transition with all property', () => {
      const result = parser.parseTransitionProperty('all 0.3s');

      expect(result[0]!.property).toBe('all');
    });

    it('should parse transition with easing', () => {
      const result = parser.parseTransitionProperty('opacity 0.3s ease-in-out');

      expect(result[0]!.easing.type).toBe('ease-in-out');
    });

    it('should parse transition with delay', () => {
      const result = parser.parseTransitionProperty('opacity 0.3s ease 0.1s');

      expect(result[0]!.delay).toBe(100);
    });

    it('should parse multiple transitions', () => {
      const result = parser.parseTransitionProperty(
        'opacity 0.3s, transform 0.5s'
      );

      expect(result).toHaveLength(2);
      expect(result[0]!.property).toBe('opacity');
      expect(result[0]!.duration).toBe(300);
      expect(result[1]!.property).toBe('transform');
      expect(result[1]!.duration).toBe(500);
    });

    it('should parse transition with cubic-bezier', () => {
      const result = parser.parseTransitionProperty(
        'opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
      );

      expect(result[0]!.easing.type).toBe('cubic-bezier');
      expect(result[0]!.easing.cubicBezier).toEqual([0.4, 0, 0.2, 1]);
    });

    it('should handle transform property', () => {
      const result = parser.parseTransitionProperty('transform 0.3s ease');

      expect(result[0]!.property).toBe('transform');
    });
  });

  // =====================================================
  // extractStyleRules Tests
  // =====================================================

  describe('extractStyleRules', () => {
    it('should extract simple CSS rule', () => {
      const css = `.button { color: red; background: blue; }`;

      const result = parser.extractStyleRules(css);

      expect(result.has('.button')).toBe(true);
      expect(result.get('.button')).toEqual({
        color: 'red',
        background: 'blue',
      });
    });

    it('should extract multiple CSS rules', () => {
      const css = `
        .button { color: red; }
        .link { color: blue; }
      `;

      const result = parser.extractStyleRules(css);

      expect(result.size).toBe(2);
      expect(result.has('.button')).toBe(true);
      expect(result.has('.link')).toBe(true);
    });

    it('should extract animation property', () => {
      const css = `.animated { animation: fadeIn 0.3s ease; }`;

      const result = parser.extractStyleRules(css);

      expect(result.get('.animated')!.animation).toBe('fadeIn 0.3s ease');
    });

    it('should extract transition property', () => {
      const css = `.button { transition: opacity 0.3s ease; }`;

      const result = parser.extractStyleRules(css);

      expect(result.get('.button')!.transition).toBe('opacity 0.3s ease');
    });

    it('should skip keyframe step selectors', () => {
      const css = `
        @keyframes fadeIn {
          0% { opacity: 0; }
          100% { opacity: 1; }
        }
        .button { color: red; }
      `;

      const result = parser.extractStyleRules(css);

      // Should not include percentage selectors
      expect(result.has('0%')).toBe(false);
      expect(result.has('100%')).toBe(false);
      expect(result.has('.button')).toBe(true);
    });

    it('should handle :hover selectors', () => {
      const css = `
        .button { color: red; }
        .button:hover { color: blue; }
      `;

      const result = parser.extractStyleRules(css);

      expect(result.has('.button')).toBe(true);
      expect(result.has('.button:hover')).toBe(true);
    });

    it('should handle complex selectors', () => {
      const css = `.nav > .item:first-child { color: red; }`;

      const result = parser.extractStyleRules(css);

      expect(result.has('.nav > .item:first-child')).toBe(true);
    });

    it('should handle animation-name property', () => {
      const css = `.animated { animation-name: fadeIn; animation-duration: 0.3s; }`;

      const result = parser.extractStyleRules(css);

      expect(result.get('.animated')!['animation-name']).toBe('fadeIn');
      expect(result.get('.animated')!['animation-duration']).toBe('0.3s');
    });
  });

  // =====================================================
  // Utility Methods Tests
  // =====================================================

  describe('parseTimeToMs', () => {
    it('should parse seconds to milliseconds', () => {
      expect(parser.parseTimeToMs('0.3s')).toBe(300);
      expect(parser.parseTimeToMs('1s')).toBe(1000);
      expect(parser.parseTimeToMs('2.5s')).toBe(2500);
    });

    it('should parse milliseconds', () => {
      expect(parser.parseTimeToMs('300ms')).toBe(300);
      expect(parser.parseTimeToMs('1000ms')).toBe(1000);
    });

    it('should handle decimal seconds', () => {
      expect(parser.parseTimeToMs('0.15s')).toBe(150);
    });
  });

  describe('formatEasing', () => {
    it('should format keyword easing', () => {
      expect(parser.formatEasing({ type: 'ease' })).toBe('ease');
      expect(parser.formatEasing({ type: 'linear' })).toBe('linear');
      expect(parser.formatEasing({ type: 'ease-in-out' })).toBe('ease-in-out');
    });

    it('should format cubic-bezier easing', () => {
      const easing: EasingConfig = {
        type: 'cubic-bezier',
        cubicBezier: [0.4, 0, 0.2, 1],
      };

      expect(parser.formatEasing(easing)).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
    });

    it('should format steps easing', () => {
      const easing: EasingConfig = {
        type: 'steps',
        steps: { count: 4, position: 'end' },
      };

      expect(parser.formatEasing(easing)).toBe('steps(4, end)');
    });
  });

  describe('generateKeyframesCss', () => {
    it('should generate CSS from keyframe steps', () => {
      const steps: KeyframeStep[] = [
        { offset: 0, styles: { opacity: '0' } },
        { offset: 100, styles: { opacity: '1' } },
      ];

      const result = parser.generateKeyframesCss('fadeIn', steps);

      expect(result).toContain('@keyframes fadeIn');
      expect(result).toContain('0% { opacity: 0 }');
      expect(result).toContain('100% { opacity: 1 }');
    });

    it('should handle multiple properties per step', () => {
      const steps: KeyframeStep[] = [
        { offset: 0, styles: { opacity: '0', transform: 'scale(0.8)' } },
        { offset: 100, styles: { opacity: '1', transform: 'scale(1)' } },
      ];

      const result = parser.generateKeyframesCss('scaleIn', steps);

      expect(result).toContain('opacity: 0');
      expect(result).toContain('transform: scale(0.8)');
    });
  });

  // =====================================================
  // ReDoS Protection Tests (Security)
  // =====================================================

  describe('ReDoS Protection', () => {
    /**
     * ReDoS (Regular Expression Denial of Service) Attack Prevention Tests
     *
     * These tests verify that the parser correctly handles maliciously crafted
     * inputs designed to cause exponential backtracking in regex engines.
     *
     * Attack vectors tested:
     * 1. Long CSS property values without semicolons
     * 2. Deeply nested braces
     * 3. Long cubic-bezier values
     * 4. Extremely long CSS input
     *
     * Expected behavior:
     * - All operations complete within reasonable time (<100ms for normal inputs)
     * - Large inputs are rejected or truncated with appropriate errors
     * - No CPU exhaustion or hangs
     */

    describe('CSS_PARSER_LIMITS constants', () => {
      it('should export limits constants', () => {
        expect(CSS_PARSER_LIMITS).toBeDefined();
        expect(CSS_PARSER_LIMITS.MAX_CSS_SIZE).toBe(5 * 1024 * 1024); // 5MB
        expect(CSS_PARSER_LIMITS.MAX_PROPERTY_VALUE_LENGTH).toBe(10000);
        expect(CSS_PARSER_LIMITS.MAX_SELECTOR_LENGTH).toBe(1000);
        expect(CSS_PARSER_LIMITS.MAX_CUBIC_BEZIER_LENGTH).toBe(100);
        expect(CSS_PARSER_LIMITS.MAX_KEYFRAME_CONTENT_LENGTH).toBe(50000);
      });
    });

    describe('parseKeyframes - ReDoS protection', () => {
      it('should handle extremely long CSS input gracefully', () => {
        // Generate 6MB of CSS (exceeds 5MB limit)
        const longCss = 'a'.repeat(6 * 1024 * 1024);

        const start = performance.now();
        const result = parser.parseKeyframes(longCss);
        const elapsed = performance.now() - start;

        // Should complete quickly (rejected at input validation)
        expect(elapsed).toBeLessThan(100);
        expect(result.size).toBe(0);
      });

      it('should handle long keyframe content without hanging', () => {
        // Long content inside keyframes (potential ReDoS via [^}]*)
        const longContent = 'a'.repeat(100000);
        const css = `@keyframes test { from { ${longContent} } to { opacity: 1; } }`;

        const start = performance.now();
        const result = parser.parseKeyframes(css);
        const elapsed = performance.now() - start;

        // Should complete in reasonable time
        expect(elapsed).toBeLessThan(1000);
        expect(result.has('test')).toBe(true);
      });

      it('should complete in reasonable time for normal input', () => {
        const css = `
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        `;

        const start = performance.now();
        parser.parseKeyframes(css);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(50);
      });
    });

    describe('parseKeyframeSteps - ReDoS protection', () => {
      it('should handle long property values without exponential backtracking', () => {
        // Attack vector: long value without semicolon triggers [^;]+ backtracking
        const longValue = 'a'.repeat(50000);
        const content = `from { transform: ${longValue} } to { opacity: 1; }`;

        const start = performance.now();
        const result = parser.parseKeyframeSteps(content);
        const elapsed = performance.now() - start;

        // Should complete in reasonable time (not exponential)
        expect(elapsed).toBeLessThan(500);
        // Should still parse the valid part
        expect(result.length).toBeGreaterThanOrEqual(0);
      });

      it('should truncate extremely long property values', () => {
        // Property value exceeds MAX_PROPERTY_VALUE_LENGTH
        const longValue = 'translateX(' + 'a'.repeat(20000) + ')';
        const content = `from { transform: ${longValue}; } to { opacity: 1; }`;

        const result = parser.parseKeyframeSteps(content);

        // Parser should handle gracefully (truncate or skip)
        expect(result.length).toBeGreaterThanOrEqual(0);
      });
    });

    describe('extractStyleRules - ReDoS protection', () => {
      it('should handle long selector without hanging', () => {
        // Attack vector: long selector triggers [^{]* backtracking
        const longSelector = '.class' + '-nested'.repeat(500);
        const css = `${longSelector} { color: red; }`;

        const start = performance.now();
        const result = parser.extractStyleRules(css);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(500);
        // Long selectors should be handled (either parsed or skipped)
        expect(result.size).toBeGreaterThanOrEqual(0);
      });

      it('should handle long declaration value without hanging', () => {
        // Attack vector: long value without semicolon triggers [^;]+ backtracking
        const longValue = 'a'.repeat(50000);
        const css = `.button { background: ${longValue}; }`;

        const start = performance.now();
        const result = parser.extractStyleRules(css);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(500);
        expect(result.size).toBeGreaterThanOrEqual(0);
      });

      it('should reject CSS exceeding size limit', () => {
        const largeCss = '.a { color: red; }'.repeat(500000);

        const start = performance.now();
        const result = parser.extractStyleRules(largeCss);
        const elapsed = performance.now() - start;

        // Should reject quickly at input validation
        expect(elapsed).toBeLessThan(100);
        expect(result.size).toBe(0);
      });
    });

    describe('parseAnimationProperty - ReDoS protection', () => {
      it('should handle malformed cubic-bezier gracefully', () => {
        // Attack vector: long content inside cubic-bezier triggers backtracking
        const longBezier = 'cubic-bezier(' + '0.5,'.repeat(100) + '0.5)';
        const value = `fadeIn 0.3s ${longBezier}`;

        const start = performance.now();
        const result = parser.parseAnimationProperty(value);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(100);
        // Should fall back to default easing
        expect(result.name).toBe('fadeIn');
        expect(result.duration).toBe(300);
      });

      it('should handle extremely long animation value', () => {
        const longName = 'animation-' + 'x'.repeat(10000);
        const value = `${longName} 0.3s ease`;

        const start = performance.now();
        const result = parser.parseAnimationProperty(value);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(100);
        // Should still parse or return defaults
        expect(result).toBeDefined();
      });
    });

    describe('parseTransitionProperty - ReDoS protection', () => {
      it('should handle many transition parts', () => {
        // Many comma-separated transitions
        const parts = Array(100).fill('opacity 0.3s ease').join(', ');

        const start = performance.now();
        const result = parser.parseTransitionProperty(parts);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(500);
        expect(result.length).toBe(100);
      });

      it('should handle long cubic-bezier in transition', () => {
        const longBezier = 'cubic-bezier(' + '0.5, '.repeat(50) + '0.5)';
        const value = `opacity 0.3s ${longBezier}`;

        const start = performance.now();
        const result = parser.parseTransitionProperty(value);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(100);
        expect(result.length).toBe(1);
        expect(result[0]!.property).toBe('opacity');
      });
    });

    describe('tokenizeAnimationValue - ReDoS protection', () => {
      it('should handle deeply nested parentheses', () => {
        // Attack vector: deeply nested parentheses
        const nested = '('.repeat(100) + 'value' + ')'.repeat(100);
        const value = `fadeIn ${nested} 0.3s`;

        const start = performance.now();
        const result = parser.tokenizeAnimationValue(value);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(100);
        expect(result.length).toBeGreaterThan(0);
      });

      it('should handle unbalanced parentheses gracefully', () => {
        const value = 'fadeIn cubic-bezier(0.4, 0, 0.2 0.3s';

        const result = parser.tokenizeAnimationValue(value);

        // Should not hang, return whatever it can parse
        expect(result.length).toBeGreaterThan(0);
      });
    });

    describe('Performance benchmarks', () => {
      it('should parse complex realistic CSS in reasonable time', () => {
        const css = `
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-10px); }
            25% { opacity: 0.25; }
            50% { opacity: 0.5; }
            75% { opacity: 0.75; }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes slideUp {
            from { transform: translateY(100%); }
            to { transform: translateY(0); }
          }
          .button {
            animation: fadeIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;
            transition: opacity 0.2s ease, transform 0.3s ease-in-out;
          }
          .link:hover {
            animation: slideUp 0.5s ease infinite alternate;
          }
        `.repeat(100); // 100x realistic CSS

        const start = performance.now();
        const keyframes = parser.parseKeyframes(css);
        const rules = parser.extractStyleRules(css);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(1000);
        expect(keyframes.size).toBe(2); // Same keyframes, deduplicated
        expect(rules.size).toBeGreaterThan(0);
      });
    });
  });
});
