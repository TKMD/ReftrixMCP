// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * aXe Core Shared Module Tests (TDD - Red Phase)
 *
 * aXeアクセシビリティサービス間の共通コードをテスト
 * JSDOM版とPlaywright版で使用される定数・ユーティリティ関数の単体テスト
 *
 * @module tests/unit/services/quality/axe-core-shared.test
 */

import { describe, it, expect } from 'vitest';
import {
  // 定数
  IMPACT_PENALTIES,
  WCAG_LEVEL_TAGS,
  SCORE_TO_WCAG_LEVEL,
  // 型
  type ViolationImpact,
  type WcagLevel,
  type AxeViolation,
  type AxeAccessibilityResult,
  // ユーティリティ関数
  calculateScorePenalty,
  calculateAccessibilityScore,
  determineWcagLevel,
  createEmptyResult,
  convertAxeViolation,
} from '../../../../src/services/quality/axe-core-shared';
import type { Result as AxeResult, AxeResults } from 'axe-core';

describe('axe-core-shared', () => {
  // =====================================================
  // 定数テスト
  // =====================================================

  describe('Constants', () => {
    describe('IMPACT_PENALTIES', () => {
      it('should define penalty for critical impact', () => {
        expect(IMPACT_PENALTIES.critical).toBe(-20);
      });

      it('should define penalty for serious impact', () => {
        expect(IMPACT_PENALTIES.serious).toBe(-10);
      });

      it('should define penalty for moderate impact', () => {
        expect(IMPACT_PENALTIES.moderate).toBe(-5);
      });

      it('should define penalty for minor impact', () => {
        expect(IMPACT_PENALTIES.minor).toBe(-2);
      });

      it('should have all four impact levels defined', () => {
        const keys = Object.keys(IMPACT_PENALTIES);
        expect(keys).toContain('critical');
        expect(keys).toContain('serious');
        expect(keys).toContain('moderate');
        expect(keys).toContain('minor');
        expect(keys.length).toBe(4);
      });
    });

    describe('WCAG_LEVEL_TAGS', () => {
      it('should define tags for WCAG A level', () => {
        expect(WCAG_LEVEL_TAGS.A).toEqual(['wcag2a', 'wcag21a']);
      });

      it('should define tags for WCAG AA level', () => {
        expect(WCAG_LEVEL_TAGS.AA).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
      });

      it('should define tags for WCAG AAA level', () => {
        expect(WCAG_LEVEL_TAGS.AAA).toEqual([
          'wcag2a',
          'wcag2aa',
          'wcag2aaa',
          'wcag21a',
          'wcag21aa',
          'wcag21aaa',
        ]);
      });

      it('should have all three WCAG levels defined', () => {
        const keys = Object.keys(WCAG_LEVEL_TAGS);
        expect(keys).toContain('A');
        expect(keys).toContain('AA');
        expect(keys).toContain('AAA');
        expect(keys.length).toBe(3);
      });
    });

    describe('SCORE_TO_WCAG_LEVEL', () => {
      it('should define AAA threshold at 95', () => {
        const aaaEntry = SCORE_TO_WCAG_LEVEL.find((e) => e.level === 'AAA');
        expect(aaaEntry).toBeDefined();
        expect(aaaEntry?.threshold).toBe(95);
      });

      it('should define AA threshold at 80', () => {
        const aaEntry = SCORE_TO_WCAG_LEVEL.find((e) => e.level === 'AA');
        expect(aaEntry).toBeDefined();
        expect(aaEntry?.threshold).toBe(80);
      });

      it('should define A threshold at 0', () => {
        const aEntry = SCORE_TO_WCAG_LEVEL.find((e) => e.level === 'A');
        expect(aEntry).toBeDefined();
        expect(aEntry?.threshold).toBe(0);
      });

      it('should be sorted by threshold in descending order', () => {
        for (let i = 0; i < SCORE_TO_WCAG_LEVEL.length - 1; i++) {
          expect(SCORE_TO_WCAG_LEVEL[i].threshold).toBeGreaterThan(
            SCORE_TO_WCAG_LEVEL[i + 1].threshold
          );
        }
      });
    });
  });

  // =====================================================
  // calculateScorePenalty テスト
  // =====================================================

  describe('calculateScorePenalty', () => {
    it('should return 0 for empty violations', () => {
      const result: AxeAccessibilityResult = {
        violations: [],
        passes: 10,
        score: 100,
        wcagLevel: 'AA',
      };

      const penalty = calculateScorePenalty(result);
      expect(penalty).toBe(0);
    });

    it('should calculate penalty for critical violation', () => {
      const result: AxeAccessibilityResult = {
        violations: [
          {
            id: 'test-critical',
            impact: 'critical',
            description: 'Critical issue',
            help: 'Fix it',
            helpUrl: 'https://example.com',
            nodes: 1,
          },
        ],
        passes: 5,
        score: 80,
        wcagLevel: 'A',
      };

      const penalty = calculateScorePenalty(result);
      expect(penalty).toBe(-20);
    });

    it('should calculate penalty for serious violation', () => {
      const result: AxeAccessibilityResult = {
        violations: [
          {
            id: 'test-serious',
            impact: 'serious',
            description: 'Serious issue',
            help: 'Fix it',
            helpUrl: 'https://example.com',
            nodes: 1,
          },
        ],
        passes: 5,
        score: 90,
        wcagLevel: 'AA',
      };

      const penalty = calculateScorePenalty(result);
      expect(penalty).toBe(-10);
    });

    it('should calculate penalty for moderate violation', () => {
      const result: AxeAccessibilityResult = {
        violations: [
          {
            id: 'test-moderate',
            impact: 'moderate',
            description: 'Moderate issue',
            help: 'Fix it',
            helpUrl: 'https://example.com',
            nodes: 1,
          },
        ],
        passes: 5,
        score: 95,
        wcagLevel: 'AA',
      };

      const penalty = calculateScorePenalty(result);
      expect(penalty).toBe(-5);
    });

    it('should calculate penalty for minor violation', () => {
      const result: AxeAccessibilityResult = {
        violations: [
          {
            id: 'test-minor',
            impact: 'minor',
            description: 'Minor issue',
            help: 'Fix it',
            helpUrl: 'https://example.com',
            nodes: 1,
          },
        ],
        passes: 5,
        score: 98,
        wcagLevel: 'AAA',
      };

      const penalty = calculateScorePenalty(result);
      expect(penalty).toBe(-2);
    });

    it('should calculate cumulative penalty for multiple violations', () => {
      const result: AxeAccessibilityResult = {
        violations: [
          {
            id: 'test-critical',
            impact: 'critical',
            description: 'Critical',
            help: 'Help',
            helpUrl: 'https://example.com',
            nodes: 1,
          },
          {
            id: 'test-serious',
            impact: 'serious',
            description: 'Serious',
            help: 'Help',
            helpUrl: 'https://example.com',
            nodes: 1,
          },
          {
            id: 'test-moderate',
            impact: 'moderate',
            description: 'Moderate',
            help: 'Help',
            helpUrl: 'https://example.com',
            nodes: 1,
          },
          {
            id: 'test-minor',
            impact: 'minor',
            description: 'Minor',
            help: 'Help',
            helpUrl: 'https://example.com',
            nodes: 1,
          },
        ],
        passes: 0,
        score: 63,
        wcagLevel: 'A',
      };

      const penalty = calculateScorePenalty(result);
      // -20 + -10 + -5 + -2 = -37
      expect(penalty).toBe(-37);
    });
  });

  // =====================================================
  // calculateAccessibilityScore テスト
  // =====================================================

  describe('calculateAccessibilityScore', () => {
    it('should return 100 for no violations', () => {
      const mockResults = {
        violations: [],
        passes: [],
        incomplete: [],
        inapplicable: [],
      } as unknown as AxeResults;

      const score = calculateAccessibilityScore(mockResults);
      expect(score).toBe(100);
    });

    it('should reduce score for critical violations', () => {
      const mockResults = {
        violations: [{ impact: 'critical' }],
        passes: [],
        incomplete: [],
        inapplicable: [],
      } as unknown as AxeResults;

      const score = calculateAccessibilityScore(mockResults);
      expect(score).toBe(80); // 100 - 20
    });

    it('should reduce score for serious violations', () => {
      const mockResults = {
        violations: [{ impact: 'serious' }],
        passes: [],
        incomplete: [],
        inapplicable: [],
      } as unknown as AxeResults;

      const score = calculateAccessibilityScore(mockResults);
      expect(score).toBe(90); // 100 - 10
    });

    it('should reduce score for moderate violations', () => {
      const mockResults = {
        violations: [{ impact: 'moderate' }],
        passes: [],
        incomplete: [],
        inapplicable: [],
      } as unknown as AxeResults;

      const score = calculateAccessibilityScore(mockResults);
      expect(score).toBe(95); // 100 - 5
    });

    it('should reduce score for minor violations', () => {
      const mockResults = {
        violations: [{ impact: 'minor' }],
        passes: [],
        incomplete: [],
        inapplicable: [],
      } as unknown as AxeResults;

      const score = calculateAccessibilityScore(mockResults);
      expect(score).toBe(98); // 100 - 2
    });

    it('should apply cumulative penalties for multiple violations', () => {
      const mockResults = {
        violations: [{ impact: 'critical' }, { impact: 'serious' }, { impact: 'moderate' }],
        passes: [],
        incomplete: [],
        inapplicable: [],
      } as unknown as AxeResults;

      const score = calculateAccessibilityScore(mockResults);
      expect(score).toBe(65); // 100 - 20 - 10 - 5
    });

    it('should not return score below 0', () => {
      const mockResults = {
        violations: [
          { impact: 'critical' },
          { impact: 'critical' },
          { impact: 'critical' },
          { impact: 'critical' },
          { impact: 'critical' },
          { impact: 'critical' }, // 6 critical = -120
        ],
        passes: [],
        incomplete: [],
        inapplicable: [],
      } as unknown as AxeResults;

      const score = calculateAccessibilityScore(mockResults);
      expect(score).toBe(0);
    });

    it('should not return score above 100', () => {
      const mockResults = {
        violations: [],
        passes: Array(100).fill({}), // Many passes
        incomplete: [],
        inapplicable: [],
      } as unknown as AxeResults;

      const score = calculateAccessibilityScore(mockResults);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('should handle undefined impact as moderate', () => {
      const mockResults = {
        violations: [{ impact: undefined }],
        passes: [],
        incomplete: [],
        inapplicable: [],
      } as unknown as AxeResults;

      const score = calculateAccessibilityScore(mockResults);
      expect(score).toBe(95); // 100 - 5 (moderate default)
    });
  });

  // =====================================================
  // determineWcagLevel テスト
  // =====================================================

  describe('determineWcagLevel', () => {
    it('should return AAA for score >= 95 with no critical/serious violations', () => {
      const violations: AxeViolation[] = [
        {
          id: 'minor-issue',
          impact: 'minor',
          description: 'Minor',
          help: 'Help',
          helpUrl: 'https://example.com',
          nodes: 1,
        },
      ];

      const level = determineWcagLevel(98, violations);
      expect(level).toBe('AAA');
    });

    it('should return AA for score >= 80 and < 95 with no critical violations', () => {
      const violations: AxeViolation[] = [
        {
          id: 'moderate-issue',
          impact: 'moderate',
          description: 'Moderate',
          help: 'Help',
          helpUrl: 'https://example.com',
          nodes: 1,
        },
      ];

      const level = determineWcagLevel(85, violations);
      expect(level).toBe('AA');
    });

    it('should return A for score < 80', () => {
      const violations: AxeViolation[] = [];
      const level = determineWcagLevel(70, violations);
      expect(level).toBe('A');
    });

    it('should return A when critical violation is present regardless of score', () => {
      const violations: AxeViolation[] = [
        {
          id: 'critical-issue',
          impact: 'critical',
          description: 'Critical',
          help: 'Help',
          helpUrl: 'https://example.com',
          nodes: 1,
        },
      ];

      const level = determineWcagLevel(99, violations);
      expect(level).toBe('A');
    });

    it('should return A when serious violation is present and score < 90', () => {
      const violations: AxeViolation[] = [
        {
          id: 'serious-issue',
          impact: 'serious',
          description: 'Serious',
          help: 'Help',
          helpUrl: 'https://example.com',
          nodes: 1,
        },
      ];

      const level = determineWcagLevel(85, violations);
      expect(level).toBe('A');
    });

    it('should return AA when serious violation is present but score >= 90', () => {
      const violations: AxeViolation[] = [
        {
          id: 'serious-issue',
          impact: 'serious',
          description: 'Serious',
          help: 'Help',
          helpUrl: 'https://example.com',
          nodes: 1,
        },
      ];

      const level = determineWcagLevel(90, violations);
      expect(level).toBe('AA');
    });

    it('should return A for score 0', () => {
      const level = determineWcagLevel(0, []);
      expect(level).toBe('A');
    });

    it('should return AAA for perfect score 100 with no violations', () => {
      const level = determineWcagLevel(100, []);
      expect(level).toBe('AAA');
    });
  });

  // =====================================================
  // createEmptyResult テスト
  // =====================================================

  describe('createEmptyResult', () => {
    it('should create result with default AA level', () => {
      const result = createEmptyResult();

      expect(result.violations).toEqual([]);
      expect(result.passes).toBe(0);
      expect(result.score).toBe(100);
      expect(result.wcagLevel).toBe('AA');
    });

    it('should create result with specified WCAG level', () => {
      const result = createEmptyResult('AAA');

      expect(result.violations).toEqual([]);
      expect(result.passes).toBe(0);
      expect(result.score).toBe(100);
      expect(result.wcagLevel).toBe('AAA');
    });

    it('should create result with A level', () => {
      const result = createEmptyResult('A');
      expect(result.wcagLevel).toBe('A');
    });

    it('should return new array instance for violations', () => {
      const result1 = createEmptyResult();
      const result2 = createEmptyResult();

      expect(result1.violations).not.toBe(result2.violations);
    });
  });

  // =====================================================
  // convertAxeViolation テスト
  // =====================================================

  describe('convertAxeViolation', () => {
    it('should convert aXe violation to AxeViolation format', () => {
      const axeViolation = {
        id: 'image-alt',
        impact: 'critical',
        description: 'Images must have alternate text',
        help: 'Ensure that images have alt text',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/image-alt',
        nodes: [{ html: '<img src="test.jpg">' }],
      } as AxeResult;

      const violation = convertAxeViolation(axeViolation);

      expect(violation.id).toBe('image-alt');
      expect(violation.impact).toBe('critical');
      expect(violation.description).toBe('Images must have alternate text');
      expect(violation.help).toBe('Ensure that images have alt text');
      expect(violation.helpUrl).toBe('https://dequeuniversity.com/rules/axe/4.4/image-alt');
      expect(violation.nodes).toBe(1);
    });

    it('should count multiple nodes correctly', () => {
      const axeViolation = {
        id: 'button-name',
        impact: 'serious',
        description: 'Buttons must have discernible text',
        help: 'Ensure buttons have accessible names',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/button-name',
        nodes: [
          { html: '<button></button>' },
          { html: '<button></button>' },
          { html: '<button></button>' },
        ],
      } as AxeResult;

      const violation = convertAxeViolation(axeViolation);
      expect(violation.nodes).toBe(3);
    });

    it('should default impact to moderate when undefined', () => {
      const axeViolation = {
        id: 'test-rule',
        impact: undefined,
        description: 'Test description',
        help: 'Test help',
        helpUrl: 'https://example.com',
        nodes: [],
      } as unknown as AxeResult;

      const violation = convertAxeViolation(axeViolation);
      expect(violation.impact).toBe('moderate');
    });

    it('should handle empty nodes array', () => {
      const axeViolation = {
        id: 'test-rule',
        impact: 'minor',
        description: 'Test',
        help: 'Help',
        helpUrl: 'https://example.com',
        nodes: [],
      } as unknown as AxeResult;

      const violation = convertAxeViolation(axeViolation);
      expect(violation.nodes).toBe(0);
    });
  });

  // =====================================================
  // 型エクスポートテスト
  // =====================================================

  describe('Type Exports', () => {
    it('should export ViolationImpact type with valid values', () => {
      const validImpacts: ViolationImpact[] = ['minor', 'moderate', 'serious', 'critical'];
      expect(validImpacts.length).toBe(4);
    });

    it('should export WcagLevel type with valid values', () => {
      const validLevels: WcagLevel[] = ['A', 'AA', 'AAA'];
      expect(validLevels.length).toBe(3);
    });

    it('should export AxeViolation interface', () => {
      const violation: AxeViolation = {
        id: 'test',
        impact: 'moderate',
        description: 'Test',
        help: 'Help',
        helpUrl: 'https://example.com',
        nodes: 1,
      };
      expect(violation.id).toBe('test');
    });

    it('should export AxeAccessibilityResult interface', () => {
      const result: AxeAccessibilityResult = {
        violations: [],
        passes: 10,
        score: 100,
        wcagLevel: 'AA',
      };
      expect(result.score).toBe(100);
    });
  });
});
