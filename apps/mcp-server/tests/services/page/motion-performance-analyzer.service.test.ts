// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MotionPerformanceAnalyzer Service Tests
 *
 * TDD Red Phase - Tests for CSS animation/transition performance analysis
 * Extracted from motion-detector.ts (Phase5 refactoring)
 *
 * @module tests/services/page/motion-performance-analyzer.service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  MotionPerformanceAnalyzer} from '../../../src/services/page/motion-performance-analyzer.service';
import {
  getMotionPerformanceAnalyzer,
  resetMotionPerformanceAnalyzer,
  LAYOUT_TRIGGER_PROPERTIES,
  PAINT_TRIGGER_PROPERTIES,
  type PerformanceLevel,
  type PerformanceInfo,
  type AccessibilityInfo,
} from '../../../src/services/page/motion-performance-analyzer.service';

describe('MotionPerformanceAnalyzer', () => {
  let analyzer: MotionPerformanceAnalyzer;

  beforeEach(() => {
    resetMotionPerformanceAnalyzer();
    analyzer = getMotionPerformanceAnalyzer();
  });

  // =====================================================
  // Constants Export Tests
  // =====================================================

  describe('Constants', () => {
    it('should export LAYOUT_TRIGGER_PROPERTIES set', () => {
      expect(LAYOUT_TRIGGER_PROPERTIES).toBeInstanceOf(Set);
      expect(LAYOUT_TRIGGER_PROPERTIES.has('width')).toBe(true);
      expect(LAYOUT_TRIGGER_PROPERTIES.has('height')).toBe(true);
      expect(LAYOUT_TRIGGER_PROPERTIES.has('padding')).toBe(true);
      expect(LAYOUT_TRIGGER_PROPERTIES.has('margin')).toBe(true);
      expect(LAYOUT_TRIGGER_PROPERTIES.has('font-size')).toBe(true);
    });

    it('should export PAINT_TRIGGER_PROPERTIES set', () => {
      expect(PAINT_TRIGGER_PROPERTIES).toBeInstanceOf(Set);
      expect(PAINT_TRIGGER_PROPERTIES.has('background')).toBe(true);
      expect(PAINT_TRIGGER_PROPERTIES.has('background-color')).toBe(true);
      expect(PAINT_TRIGGER_PROPERTIES.has('color')).toBe(true);
      expect(PAINT_TRIGGER_PROPERTIES.has('box-shadow')).toBe(true);
    });

    it('should not include transform/opacity in trigger properties', () => {
      expect(LAYOUT_TRIGGER_PROPERTIES.has('transform')).toBe(false);
      expect(LAYOUT_TRIGGER_PROPERTIES.has('opacity')).toBe(false);
      expect(PAINT_TRIGGER_PROPERTIES.has('transform')).toBe(false);
      expect(PAINT_TRIGGER_PROPERTIES.has('opacity')).toBe(false);
    });
  });

  // =====================================================
  // analyzePerformance Tests
  // =====================================================

  describe('analyzePerformance', () => {
    describe('GPU-accelerated properties (good)', () => {
      it('should return good level for transform only', () => {
        const result = analyzer.analyzePerformance(['transform']);

        expect(result.level).toBe('good');
        expect(result.usesTransform).toBe(true);
        expect(result.usesOpacity).toBe(false);
        expect(result.triggersLayout).toBe(false);
        expect(result.triggersPaint).toBe(false);
      });

      it('should return good level for opacity only', () => {
        const result = analyzer.analyzePerformance(['opacity']);

        expect(result.level).toBe('good');
        expect(result.usesTransform).toBe(false);
        expect(result.usesOpacity).toBe(true);
        expect(result.triggersLayout).toBe(false);
        expect(result.triggersPaint).toBe(false);
      });

      it('should return good level for transform + opacity', () => {
        const result = analyzer.analyzePerformance(['transform', 'opacity']);

        expect(result.level).toBe('good');
        expect(result.usesTransform).toBe(true);
        expect(result.usesOpacity).toBe(true);
      });

      it('should detect translate* as transform', () => {
        const result = analyzer.analyzePerformance(['translateX', 'translateY']);

        expect(result.usesTransform).toBe(true);
        expect(result.level).toBe('good');
      });

      it('should detect rotate* as transform', () => {
        const result = analyzer.analyzePerformance(['rotate', 'rotateZ']);

        expect(result.usesTransform).toBe(true);
        expect(result.level).toBe('good');
      });

      it('should detect scale* as transform', () => {
        const result = analyzer.analyzePerformance(['scale', 'scaleX']);

        expect(result.usesTransform).toBe(true);
        expect(result.level).toBe('good');
      });
    });

    describe('Layout-triggering properties (poor)', () => {
      it('should return poor level for width', () => {
        const result = analyzer.analyzePerformance(['width']);

        expect(result.level).toBe('poor');
        expect(result.triggersLayout).toBe(true);
      });

      it('should return poor level for height', () => {
        const result = analyzer.analyzePerformance(['height']);

        expect(result.level).toBe('poor');
        expect(result.triggersLayout).toBe(true);
      });

      it('should return poor level for margin', () => {
        const result = analyzer.analyzePerformance(['margin']);

        expect(result.level).toBe('poor');
        expect(result.triggersLayout).toBe(true);
      });

      it('should return poor level for padding', () => {
        const result = analyzer.analyzePerformance(['padding']);

        expect(result.level).toBe('poor');
        expect(result.triggersLayout).toBe(true);
      });

      it('should return poor even when mixed with transform', () => {
        const result = analyzer.analyzePerformance(['transform', 'width']);

        expect(result.level).toBe('poor');
        expect(result.usesTransform).toBe(true);
        expect(result.triggersLayout).toBe(true);
      });

      it('should detect all layout-triggering properties', () => {
        const layoutProps = [
          'width', 'height',
          'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
          'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
          'top', 'right', 'bottom', 'left',
          'border', 'border-width',
          'font-size', 'line-height',
        ];

        for (const prop of layoutProps) {
          const result = analyzer.analyzePerformance([prop]);
          expect(result.triggersLayout).toBe(true);
          expect(result.level).toBe('poor');
        }
      });
    });

    describe('Paint-triggering properties (acceptable)', () => {
      it('should return acceptable level for background-color only', () => {
        const result = analyzer.analyzePerformance(['background-color']);

        expect(result.level).toBe('acceptable');
        expect(result.triggersPaint).toBe(true);
        expect(result.triggersLayout).toBe(false);
      });

      it('should return acceptable level for color only', () => {
        const result = analyzer.analyzePerformance(['color']);

        expect(result.level).toBe('acceptable');
        expect(result.triggersPaint).toBe(true);
      });

      it('should return acceptable level for box-shadow only', () => {
        const result = analyzer.analyzePerformance(['box-shadow']);

        expect(result.level).toBe('acceptable');
        expect(result.triggersPaint).toBe(true);
      });

      it('should return good when paint properties mixed with transform', () => {
        const result = analyzer.analyzePerformance(['background-color', 'transform']);

        expect(result.level).toBe('good');
        expect(result.triggersPaint).toBe(true);
        expect(result.usesTransform).toBe(true);
      });

      it('should return good when paint properties mixed with opacity', () => {
        const result = analyzer.analyzePerformance(['background-color', 'opacity']);

        expect(result.level).toBe('good');
        expect(result.triggersPaint).toBe(true);
        expect(result.usesOpacity).toBe(true);
      });

      it('should detect all paint-triggering properties', () => {
        const paintProps = [
          'background', 'background-color', 'background-image',
          'color', 'border-color', 'border-style',
          'box-shadow', 'text-shadow', 'outline',
        ];

        for (const prop of paintProps) {
          const result = analyzer.analyzePerformance([prop]);
          expect(result.triggersPaint).toBe(true);
        }
      });
    });

    describe('Unknown/other properties', () => {
      it('should return acceptable for unknown properties', () => {
        const result = analyzer.analyzePerformance(['filter']);

        expect(result.level).toBe('acceptable');
        expect(result.usesTransform).toBe(false);
        expect(result.usesOpacity).toBe(false);
        expect(result.triggersLayout).toBe(false);
        expect(result.triggersPaint).toBe(false);
      });

      it('should return acceptable for empty properties', () => {
        const result = analyzer.analyzePerformance([]);

        expect(result.level).toBe('acceptable');
      });
    });

    describe('Case insensitivity', () => {
      it('should handle uppercase property names', () => {
        const result = analyzer.analyzePerformance(['TRANSFORM', 'OPACITY']);

        expect(result.usesTransform).toBe(true);
        expect(result.usesOpacity).toBe(true);
        expect(result.level).toBe('good');
      });

      it('should handle mixed case property names', () => {
        const result = analyzer.analyzePerformance(['Transform', 'BackgroundColor']);

        expect(result.usesTransform).toBe(true);
      });
    });
  });

  // =====================================================
  // analyzeAccessibility Tests
  // =====================================================

  describe('analyzeAccessibility', () => {
    describe('prefers-reduced-motion detection', () => {
      it('should detect @media (prefers-reduced-motion)', () => {
        const css = `
          @media (prefers-reduced-motion: reduce) {
            .animated { animation: none; }
          }
        `;

        const result = analyzer.analyzeAccessibility(css);

        expect(result.respectsReducedMotion).toBe(true);
      });

      it('should detect prefers-reduced-motion: no-preference', () => {
        const css = `
          @media (prefers-reduced-motion: no-preference) {
            .animated { animation: spin 1s infinite; }
          }
        `;

        const result = analyzer.analyzeAccessibility(css);

        expect(result.respectsReducedMotion).toBe(true);
      });

      it('should not detect when no reduced motion query', () => {
        const css = `
          @keyframes spin { to { transform: rotate(360deg); } }
          .spinner { animation: spin 1s infinite; }
        `;

        const result = analyzer.analyzeAccessibility(css);

        expect(result.respectsReducedMotion).toBe(false);
      });

      it('should handle empty CSS', () => {
        const result = analyzer.analyzeAccessibility('');

        expect(result.respectsReducedMotion).toBe(false);
      });
    });
  });

  // =====================================================
  // extractPropertiesFromKeyframes Tests
  // =====================================================

  describe('extractPropertiesFromKeyframes', () => {
    it('should extract property names from keyframe steps', () => {
      const steps = [
        { offset: 0, styles: { opacity: '0', transform: 'translateY(20px)' } },
        { offset: 100, styles: { opacity: '1', transform: 'translateY(0)' } },
      ];

      const result = analyzer.extractPropertiesFromKeyframes(steps);

      expect(result).toContain('opacity');
      expect(result).toContain('transform');
      expect(result.length).toBe(2);
    });

    it('should deduplicate properties across steps', () => {
      const steps = [
        { offset: 0, styles: { opacity: '0' } },
        { offset: 50, styles: { opacity: '0.5' } },
        { offset: 100, styles: { opacity: '1' } },
      ];

      const result = analyzer.extractPropertiesFromKeyframes(steps);

      expect(result).toEqual(['opacity']);
    });

    it('should handle steps with multiple unique properties', () => {
      const steps = [
        { offset: 0, styles: { opacity: '0', transform: 'scale(0.5)' } },
        { offset: 50, styles: { 'background-color': 'red' } },
        { offset: 100, styles: { opacity: '1', filter: 'blur(0)' } },
      ];

      const result = analyzer.extractPropertiesFromKeyframes(steps);

      expect(result).toContain('opacity');
      expect(result).toContain('transform');
      expect(result).toContain('background-color');
      expect(result).toContain('filter');
      expect(result.length).toBe(4);
    });

    it('should handle empty steps array', () => {
      const result = analyzer.extractPropertiesFromKeyframes([]);

      expect(result).toEqual([]);
    });

    it('should handle steps with empty styles', () => {
      const steps = [
        { offset: 0, styles: {} },
        { offset: 100, styles: {} },
      ];

      const result = analyzer.extractPropertiesFromKeyframes(steps);

      expect(result).toEqual([]);
    });
  });

  // =====================================================
  // getPerformanceScore Tests
  // =====================================================

  describe('getPerformanceScore', () => {
    it('should return 100 for good level', () => {
      expect(analyzer.getPerformanceScore('good')).toBe(100);
    });

    it('should return 60 for acceptable level', () => {
      expect(analyzer.getPerformanceScore('acceptable')).toBe(60);
    });

    it('should return 20 for poor level', () => {
      expect(analyzer.getPerformanceScore('poor')).toBe(20);
    });
  });

  // =====================================================
  // getPerformanceRecommendations Tests
  // =====================================================

  describe('getPerformanceRecommendations', () => {
    it('should recommend transform/opacity for layout-triggering properties', () => {
      const info: PerformanceInfo = {
        level: 'poor',
        usesTransform: false,
        usesOpacity: false,
        triggersLayout: true,
        triggersPaint: false,
      };

      const recommendations = analyzer.getPerformanceRecommendations(info);

      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations.some((r) => r.includes('transform') || r.includes('opacity'))).toBe(
        true
      );
    });

    it('should recommend GPU acceleration for paint-only properties', () => {
      const info: PerformanceInfo = {
        level: 'acceptable',
        usesTransform: false,
        usesOpacity: false,
        triggersLayout: false,
        triggersPaint: true,
      };

      const recommendations = analyzer.getPerformanceRecommendations(info);

      expect(recommendations.length).toBeGreaterThan(0);
    });

    it('should return empty array for already optimized animations', () => {
      const info: PerformanceInfo = {
        level: 'good',
        usesTransform: true,
        usesOpacity: true,
        triggersLayout: false,
        triggersPaint: false,
      };

      const recommendations = analyzer.getPerformanceRecommendations(info);

      expect(recommendations.length).toBe(0);
    });
  });

  // =====================================================
  // Singleton Pattern Tests
  // =====================================================

  // =====================================================
  // extractDetailedPropertiesFromKeyframes Tests
  // =====================================================

  describe('extractDetailedPropertiesFromKeyframes', () => {
    it('should extract property names with from/to values from keyframe steps', () => {
      const steps = [
        { offset: 0, styles: { opacity: '0', transform: 'translateY(20px)' } },
        { offset: 100, styles: { opacity: '1', transform: 'translateY(0)' } },
      ];

      const result = analyzer.extractDetailedPropertiesFromKeyframes(steps);

      expect(result).toHaveLength(2);

      const opacityProp = result.find((p) => p.property === 'opacity');
      expect(opacityProp).toBeDefined();
      expect(opacityProp?.from).toBe('0');
      expect(opacityProp?.to).toBe('1');

      const transformProp = result.find((p) => p.property === 'transform');
      expect(transformProp).toBeDefined();
      expect(transformProp?.from).toBe('translateY(20px)');
      expect(transformProp?.to).toBe('translateY(0)');
    });

    it('should handle single-step keyframes (from only, no to)', () => {
      const steps = [
        { offset: 0, styles: { opacity: '0' } },
      ];

      const result = analyzer.extractDetailedPropertiesFromKeyframes(steps);

      expect(result).toHaveLength(1);
      expect(result[0]?.property).toBe('opacity');
      expect(result[0]?.from).toBe('0');
      expect(result[0]?.to).toBeUndefined();
    });

    it('should use first step as from and last step as to for multi-step keyframes', () => {
      const steps = [
        { offset: 0, styles: { opacity: '0' } },
        { offset: 50, styles: { opacity: '0.5' } },
        { offset: 100, styles: { opacity: '1' } },
      ];

      const result = analyzer.extractDetailedPropertiesFromKeyframes(steps);

      expect(result).toHaveLength(1);
      expect(result[0]?.property).toBe('opacity');
      expect(result[0]?.from).toBe('0');
      expect(result[0]?.to).toBe('1');
    });

    it('should handle properties that appear only in intermediate steps', () => {
      const steps = [
        { offset: 0, styles: { opacity: '0', transform: 'scale(0.5)' } },
        { offset: 50, styles: { 'background-color': 'red' } },
        { offset: 100, styles: { opacity: '1', filter: 'blur(0)' } },
      ];

      const result = analyzer.extractDetailedPropertiesFromKeyframes(steps);

      expect(result.length).toBe(4);

      const bgProp = result.find((p) => p.property === 'background-color');
      expect(bgProp).toBeDefined();
      // background-color only exists at offset:50, not at first(0%) or last(100%) step
      expect(bgProp?.from).toBeUndefined();
      expect(bgProp?.to).toBeUndefined();

      const filterProp = result.find((p) => p.property === 'filter');
      expect(filterProp).toBeDefined();
      expect(filterProp?.from).toBeUndefined();
      expect(filterProp?.to).toBe('blur(0)');
    });

    it('should handle empty steps array', () => {
      const result = analyzer.extractDetailedPropertiesFromKeyframes([]);

      expect(result).toEqual([]);
    });

    it('should handle steps with empty styles', () => {
      const steps = [
        { offset: 0, styles: {} },
        { offset: 100, styles: {} },
      ];

      const result = analyzer.extractDetailedPropertiesFromKeyframes(steps);

      expect(result).toEqual([]);
    });

    it('should deduplicate properties and pick earliest from / latest to', () => {
      const steps = [
        { offset: 0, styles: { transform: 'translateX(0)' } },
        { offset: 25, styles: { transform: 'translateX(50px)' } },
        { offset: 75, styles: { transform: 'translateX(150px)' } },
        { offset: 100, styles: { transform: 'translateX(200px)' } },
      ];

      const result = analyzer.extractDetailedPropertiesFromKeyframes(steps);

      expect(result).toHaveLength(1);
      expect(result[0]?.property).toBe('transform');
      expect(result[0]?.from).toBe('translateX(0)');
      expect(result[0]?.to).toBe('translateX(200px)');
    });
  });

  describe('Singleton Pattern', () => {
    it('should return same instance', () => {
      const instance1 = getMotionPerformanceAnalyzer();
      const instance2 = getMotionPerformanceAnalyzer();

      expect(instance1).toBe(instance2);
    });

    it('should return new instance after reset', () => {
      const instance1 = getMotionPerformanceAnalyzer();
      resetMotionPerformanceAnalyzer();
      const instance2 = getMotionPerformanceAnalyzer();

      expect(instance1).not.toBe(instance2);
    });
  });
});
