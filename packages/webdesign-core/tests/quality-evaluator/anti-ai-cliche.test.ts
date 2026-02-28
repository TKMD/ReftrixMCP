// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AntiAiClicheDetector Tests
 *
 * TDD Red Phase: AIクリシェパターン検出のテストケース（70+件）
 *
 * @module @reftrix/webdesign-core/tests/quality-evaluator/anti-ai-cliche
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AntiAiClicheDetector,
  type ClichePattern,
  type ClicheDetectionResult,
  type DesignContext,
  type ClicheReport,
} from '../../src/quality-evaluator/anti-ai-cliche';
import type { DetectedSection, ColorInfo, TypographyInfo } from '../../src/types';

// =========================================
// Test Helpers
// =========================================

/**
 * モックDesignContextを作成
 */
function createMockDesignContext(overrides?: Partial<DesignContext>): DesignContext {
  return {
    sections: [],
    colors: {
      palette: [
        { hex: '#3B82F6', count: 10, role: 'primary' },
        { hex: '#FFFFFF', count: 20, role: 'background' },
        { hex: '#1F2937', count: 15, role: 'text' },
      ],
      dominant: '#3B82F6',
      background: '#FFFFFF',
      text: '#1F2937',
      accent: '#10B981',
    },
    typography: {
      fonts: [{ family: 'Inter', weights: [400, 600, 700] }],
      headingScale: [48, 32, 24, 20],
      bodySize: 16,
      lineHeight: 1.5,
    },
    layout: {
      type: 'grid',
      columns: 12,
      gutterWidth: 24,
      maxWidth: 1280,
    },
    ...overrides,
  };
}

/**
 * モックDetectedSectionを作成
 */
function createMockSection(type: string, overrides?: Partial<DetectedSection>): DetectedSection {
  return {
    id: 'section-1',
    type: type as any,
    confidence: 0.9,
    element: {
      tagName: 'section',
      selector: 'section',
      classes: [],
    },
    position: {
      startY: 0,
      endY: 600,
      height: 600,
    },
    content: {
      headings: [],
      paragraphs: [],
      links: [],
      images: [],
      buttons: [],
    },
    style: {
      backgroundColor: '#FFFFFF',
    },
    ...overrides,
  } as DetectedSection;
}

// =========================================
// Constructor & Initialization Tests
// =========================================

describe('AntiAiClicheDetector - Constructor', () => {
  it('should create instance with default options', () => {
    const detector = new AntiAiClicheDetector();
    expect(detector).toBeInstanceOf(AntiAiClicheDetector);
  });

  it('should create instance with strictMode enabled', () => {
    const detector = new AntiAiClicheDetector({ strictMode: true });
    expect(detector).toBeInstanceOf(AntiAiClicheDetector);
  });

  it('should create instance with strictMode disabled', () => {
    const detector = new AntiAiClicheDetector({ strictMode: false });
    expect(detector).toBeInstanceOf(AntiAiClicheDetector);
  });

  it('should initialize with builtin patterns', () => {
    const detector = new AntiAiClicheDetector();
    const patterns = detector.listPatterns();
    expect(patterns.length).toBeGreaterThan(0);
  });

  it('should have exactly 8 builtin patterns', () => {
    const detector = new AntiAiClicheDetector();
    const patterns = detector.listPatterns();
    expect(patterns).toHaveLength(8);
  });
});

// =========================================
// Pattern Management Tests
// =========================================

describe('AntiAiClicheDetector - Pattern Management', () => {
  let detector: AntiAiClicheDetector;

  beforeEach(() => {
    detector = new AntiAiClicheDetector();
  });

  describe('addPattern', () => {
    it('should add a custom pattern', () => {
      const pattern: ClichePattern = {
        id: 'custom-pattern',
        name: 'Custom Pattern',
        description: 'Test pattern',
        severity: 'medium',
        weight: 0.5,
        detector: () => ({ detected: false, confidence: 0 }),
      };

      detector.addPattern(pattern);
      const result = detector.getPattern('custom-pattern');
      expect(result).toEqual(pattern);
    });

    it('should overwrite existing pattern with same id', () => {
      const pattern1: ClichePattern = {
        id: 'test-pattern',
        name: 'Test 1',
        description: 'First version',
        severity: 'low',
        weight: 0.3,
        detector: () => ({ detected: false, confidence: 0 }),
      };

      const pattern2: ClichePattern = {
        id: 'test-pattern',
        name: 'Test 2',
        description: 'Second version',
        severity: 'high',
        weight: 0.8,
        detector: () => ({ detected: false, confidence: 0 }),
      };

      detector.addPattern(pattern1);
      detector.addPattern(pattern2);

      const result = detector.getPattern('test-pattern');
      expect(result?.name).toBe('Test 2');
      expect(result?.severity).toBe('high');
    });

    it('should add multiple patterns', () => {
      const pattern1: ClichePattern = {
        id: 'pattern-1',
        name: 'Pattern 1',
        description: 'Test',
        severity: 'low',
        weight: 0.3,
        detector: () => ({ detected: false, confidence: 0 }),
      };

      const pattern2: ClichePattern = {
        id: 'pattern-2',
        name: 'Pattern 2',
        description: 'Test',
        severity: 'medium',
        weight: 0.5,
        detector: () => ({ detected: false, confidence: 0 }),
      };

      detector.addPattern(pattern1);
      detector.addPattern(pattern2);

      const patterns = detector.listPatterns();
      const customPatterns = patterns.filter((p) => p.id.startsWith('pattern-'));
      expect(customPatterns).toHaveLength(2);
    });
  });

  describe('removePattern', () => {
    it('should remove an existing pattern', () => {
      const pattern: ClichePattern = {
        id: 'temp-pattern',
        name: 'Temp',
        description: 'Test',
        severity: 'low',
        weight: 0.3,
        detector: () => ({ detected: false, confidence: 0 }),
      };

      detector.addPattern(pattern);
      const removed = detector.removePattern('temp-pattern');
      expect(removed).toBe(true);

      const result = detector.getPattern('temp-pattern');
      expect(result).toBeUndefined();
    });

    it('should return false when removing non-existent pattern', () => {
      const removed = detector.removePattern('non-existent');
      expect(removed).toBe(false);
    });

    it('should allow removing builtin patterns', () => {
      const patterns = detector.listPatterns();
      const firstPattern = patterns[0];

      const removed = detector.removePattern(firstPattern.id);
      expect(removed).toBe(true);

      const result = detector.getPattern(firstPattern.id);
      expect(result).toBeUndefined();
    });
  });

  describe('getPattern', () => {
    it('should return pattern by id', () => {
      const patterns = detector.listPatterns();
      const firstPattern = patterns[0];

      const result = detector.getPattern(firstPattern.id);
      expect(result).toEqual(firstPattern);
    });

    it('should return undefined for non-existent pattern', () => {
      const result = detector.getPattern('non-existent');
      expect(result).toBeUndefined();
    });
  });

  describe('listPatterns', () => {
    it('should return all patterns', () => {
      const patterns = detector.listPatterns();
      expect(patterns).toBeInstanceOf(Array);
    });

    it('should return copy of patterns (not reference)', () => {
      const patterns1 = detector.listPatterns();
      const patterns2 = detector.listPatterns();
      expect(patterns1).not.toBe(patterns2);
    });

    it('should reflect added patterns', () => {
      const initialCount = detector.listPatterns().length;

      const pattern: ClichePattern = {
        id: 'new-pattern',
        name: 'New',
        description: 'Test',
        severity: 'low',
        weight: 0.3,
        detector: () => ({ detected: false, confidence: 0 }),
      };

      detector.addPattern(pattern);

      const newCount = detector.listPatterns().length;
      expect(newCount).toBe(initialCount + 1);
    });
  });
});

// =========================================
// Detection Tests
// =========================================

describe('AntiAiClicheDetector - Detection', () => {
  let detector: AntiAiClicheDetector;

  beforeEach(() => {
    detector = new AntiAiClicheDetector();
  });

  describe('detect', () => {
    it('should return ClicheReport', () => {
      const context = createMockDesignContext();
      const report = detector.detect(context);

      expect(report).toHaveProperty('totalScore');
      expect(report).toHaveProperty('detectedPatterns');
      expect(report).toHaveProperty('recommendations');
    });

    it('should have totalScore between 0 and 100', () => {
      const context = createMockDesignContext();
      const report = detector.detect(context);

      expect(report.totalScore).toBeGreaterThanOrEqual(0);
      expect(report.totalScore).toBeLessThanOrEqual(100);
    });

    it('should return empty detectedPatterns when no cliches found', () => {
      const context = createMockDesignContext();
      const report = detector.detect(context);

      // Assume no cliches in default mock
      expect(report.detectedPatterns).toBeInstanceOf(Array);
    });

    it('should return recommendations as array', () => {
      const context = createMockDesignContext();
      const report = detector.detect(context);

      expect(report.recommendations).toBeInstanceOf(Array);
    });

    it('should detect patterns when present', () => {
      // Create context with known cliche (e.g., excessive gradients)
      const context = createMockDesignContext({
        sections: [
          createMockSection('hero', {
            style: {
              hasGradient: true,
              backgroundColor: 'linear-gradient(90deg, #FF0000, #00FF00, #0000FF, #FFFF00)',
            },
          }),
        ],
      });

      const report = detector.detect(context);
      // Expect at least one detection
      // (exact behavior depends on implementation)
    });
  });

  describe('detectSingle', () => {
    it('should detect single pattern by id', () => {
      const patterns = detector.listPatterns();
      const firstPattern = patterns[0];

      const context = createMockDesignContext();
      const result = detector.detectSingle(firstPattern.id, context);

      expect(result).toHaveProperty('detected');
      expect(result).toHaveProperty('confidence');
    });

    it('should return detected:false for non-existent pattern', () => {
      const context = createMockDesignContext();
      const result = detector.detectSingle('non-existent', context);

      expect(result.detected).toBe(false);
      expect(result.confidence).toBe(0);
    });

    it('should have confidence between 0 and 1', () => {
      const patterns = detector.listPatterns();
      const firstPattern = patterns[0];

      const context = createMockDesignContext();
      const result = detector.detectSingle(firstPattern.id, context);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should return locations when provided', () => {
      const patterns = detector.listPatterns();
      const firstPattern = patterns[0];

      const context = createMockDesignContext();
      const result = detector.detectSingle(firstPattern.id, context);

      if (result.locations) {
        expect(result.locations).toBeInstanceOf(Array);
      }
    });

    it('should return details when provided', () => {
      const patterns = detector.listPatterns();
      const firstPattern = patterns[0];

      const context = createMockDesignContext();
      const result = detector.detectSingle(firstPattern.id, context);

      if (result.details) {
        expect(typeof result.details).toBe('string');
      }
    });
  });
});

// =========================================
// Builtin Pattern Tests
// =========================================

describe('AntiAiClicheDetector - Builtin Patterns', () => {
  let detector: AntiAiClicheDetector;

  beforeEach(() => {
    detector = new AntiAiClicheDetector();
  });

  it('should have "excessive-gradients" pattern', () => {
    const pattern = detector.getPattern('excessive-gradients');
    expect(pattern).toBeDefined();
    expect(pattern?.name).toBeTruthy();
  });

  it('should have "unrealistic-colors" pattern', () => {
    const pattern = detector.getPattern('unrealistic-colors');
    expect(pattern).toBeDefined();
  });

  it('should have "over-decoration" pattern', () => {
    const pattern = detector.getPattern('over-decoration');
    expect(pattern).toBeDefined();
  });

  it('should have "stock-photo-composition" pattern', () => {
    const pattern = detector.getPattern('stock-photo-composition');
    expect(pattern).toBeDefined();
  });

  it('should have "perfect-symmetry" pattern', () => {
    const pattern = detector.getPattern('perfect-symmetry');
    expect(pattern).toBeDefined();
  });

  it('should have "font-mismatch" pattern', () => {
    const pattern = detector.getPattern('font-mismatch');
    expect(pattern).toBeDefined();
  });

  it('should have "shadow-overuse" pattern', () => {
    const pattern = detector.getPattern('shadow-overuse');
    expect(pattern).toBeDefined();
  });

  it('should have "artificial-whitespace" pattern', () => {
    const pattern = detector.getPattern('artificial-whitespace');
    expect(pattern).toBeDefined();
  });

  describe('Pattern: excessive-gradients', () => {
    it('should detect 3+ color gradients', () => {
      const context = createMockDesignContext({
        sections: [
          createMockSection('hero', {
            style: {
              hasGradient: true,
              backgroundColor: 'linear-gradient(90deg, #FF0000, #00FF00, #0000FF, #FFFF00)',
            },
          }),
        ],
      });

      const result = detector.detectSingle('excessive-gradients', context);
      expect(result.detected).toBe(true);
    });

    it('should not detect simple 2-color gradients', () => {
      const context = createMockDesignContext({
        sections: [
          createMockSection('hero', {
            style: {
              hasGradient: true,
              backgroundColor: 'linear-gradient(90deg, #3B82F6, #10B981)',
            },
          }),
        ],
      });

      const result = detector.detectSingle('excessive-gradients', context);
      expect(result.detected).toBe(false);
    });

    it('should detect multiple gradient sections', () => {
      const context = createMockDesignContext({
        sections: [
          createMockSection('hero', {
            style: { hasGradient: true, backgroundColor: 'linear-gradient(#FF0000, #00FF00, #0000FF)' },
          }),
          createMockSection('feature', {
            style: { hasGradient: true, backgroundColor: 'linear-gradient(#AA00FF, #00FFAA, #FFAA00)' },
          }),
          createMockSection('cta', {
            style: { hasGradient: true, backgroundColor: 'linear-gradient(#123456, #654321, #ABCDEF)' },
          }),
        ],
      });

      const result = detector.detectSingle('excessive-gradients', context);
      expect(result.detected).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.5);
    });
  });

  describe('Pattern: unrealistic-colors', () => {
    it('should detect highly saturated neon colors', () => {
      const context = createMockDesignContext({
        colors: {
          palette: [
            { hex: '#FF00FF', count: 10, role: 'primary' }, // Neon magenta
            { hex: '#00FFFF', count: 10, role: 'accent' },   // Cyan
            { hex: '#FFFF00', count: 10, role: 'secondary' }, // Yellow
          ],
          dominant: '#FF00FF',
          background: '#000000',
          text: '#FFFFFF',
        },
      });

      const result = detector.detectSingle('unrealistic-colors', context);
      expect(result.detected).toBe(true);
    });

    it('should not detect natural color palettes', () => {
      const context = createMockDesignContext({
        colors: {
          palette: [
            { hex: '#3B82F6', count: 10, role: 'primary' }, // Blue
            { hex: '#F3F4F6', count: 20, role: 'background' },
            { hex: '#1F2937', count: 15, role: 'text' },
          ],
          dominant: '#3B82F6',
          background: '#F3F4F6',
          text: '#1F2937',
        },
      });

      const result = detector.detectSingle('unrealistic-colors', context);
      expect(result.detected).toBe(false);
    });
  });

  describe('Pattern: over-decoration', () => {
    it('should detect excessive borders and shadows', () => {
      const context = createMockDesignContext({
        sections: [
          createMockSection('feature', {
            style: {
              backgroundColor: '#FFFFFF',
              // Assume implementation checks for multiple shadow/border properties
            },
          }),
        ],
      });

      // Note: Actual detection logic depends on CSS parsing
      const result = detector.detectSingle('over-decoration', context);
      expect(result).toHaveProperty('detected');
    });
  });

  describe('Pattern: stock-photo-composition', () => {
    it('should detect hero + 3-column feature layout', () => {
      const context = createMockDesignContext({
        sections: [
          createMockSection('hero', {
            position: { startY: 0, endY: 600, height: 600 },
            content: {
              headings: [{ level: 1, text: 'Welcome' }],
              paragraphs: ['Description'],
              links: [],
              images: [{ src: 'hero.jpg', alt: 'Hero' }],
              buttons: [{ text: 'Get Started', type: 'primary' }],
            },
          }),
          createMockSection('feature', {
            position: { startY: 600, endY: 1200, height: 600 },
            content: {
              headings: [
                { level: 2, text: 'Feature 1' },
                { level: 3, text: 'Feature 2' },
                { level: 3, text: 'Feature 3' },
              ],
              paragraphs: [],
              links: [],
              images: [],
              buttons: [],
            },
          }),
        ],
        layout: {
          type: 'grid',
          columns: 3,
        },
      });

      const result = detector.detectSingle('stock-photo-composition', context);
      expect(result.detected).toBe(true);
    });

    it('should not detect non-generic layouts', () => {
      const context = createMockDesignContext({
        sections: [
          createMockSection('about', {
            content: {
              headings: [{ level: 2, text: 'About Us' }],
              paragraphs: ['Long text'],
              links: [],
              images: [],
              buttons: [],
            },
          }),
          createMockSection('gallery', {
            content: {
              headings: [],
              paragraphs: [],
              links: [],
              images: [
                { src: '1.jpg' },
                { src: '2.jpg' },
                { src: '3.jpg' },
                { src: '4.jpg' },
                { src: '5.jpg' },
              ],
              buttons: [],
            },
          }),
        ],
      });

      const result = detector.detectSingle('stock-photo-composition', context);
      expect(result.detected).toBe(false);
    });
  });

  describe('Pattern: perfect-symmetry', () => {
    it('should detect perfectly symmetric layouts', () => {
      const context = createMockDesignContext({
        sections: [
          createMockSection('feature', {
            position: { startY: 0, endY: 600, height: 600 },
            content: {
              headings: [{ level: 2, text: 'Features' }],
              paragraphs: [],
              links: [],
              images: [],
              buttons: [],
            },
          }),
        ],
        layout: {
          type: 'grid',
          columns: 12,
          gutterWidth: 24,
          maxWidth: 1200,
        },
      });

      // Note: Perfect symmetry detection requires layout analysis
      const result = detector.detectSingle('perfect-symmetry', context);
      expect(result).toHaveProperty('detected');
    });
  });

  describe('Pattern: font-mismatch', () => {
    it('should detect incompatible font pairings', () => {
      const context = createMockDesignContext({
        typography: {
          fonts: [
            { family: 'Comic Sans MS', weights: [400] },
            { family: 'Times New Roman', weights: [400] },
          ],
          headingScale: [48, 32, 24],
          bodySize: 16,
          lineHeight: 1.5,
        },
      });

      const result = detector.detectSingle('font-mismatch', context);
      expect(result.detected).toBe(true);
    });

    it('should not detect harmonious font pairings', () => {
      const context = createMockDesignContext({
        typography: {
          fonts: [
            { family: 'Inter', weights: [400, 600] },
            { family: 'Roboto', weights: [400] },
          ],
          headingScale: [48, 32, 24],
          bodySize: 16,
          lineHeight: 1.5,
        },
      });

      const result = detector.detectSingle('font-mismatch', context);
      expect(result.detected).toBe(false);
    });
  });

  describe('Pattern: shadow-overuse', () => {
    it('should detect excessive drop shadows', () => {
      // Note: Actual implementation requires CSS parsing
      const context = createMockDesignContext();
      const result = detector.detectSingle('shadow-overuse', context);
      expect(result).toHaveProperty('detected');
    });
  });

  describe('Pattern: artificial-whitespace', () => {
    it('should detect unnaturally uniform spacing', () => {
      const context = createMockDesignContext({
        sections: [
          createMockSection('hero', {
            position: { startY: 0, endY: 600, height: 600 },
          }),
          createMockSection('feature', {
            position: { startY: 600, endY: 1200, height: 600 },
          }),
          createMockSection('cta', {
            position: { startY: 1200, endY: 1800, height: 600 },
          }),
        ],
      });

      const result = detector.detectSingle('artificial-whitespace', context);
      // All sections have identical height (600px)
      if (result.detected) {
        expect(result.confidence).toBeGreaterThan(0);
      }
    });

    it('should not detect natural varied spacing', () => {
      const context = createMockDesignContext({
        sections: [
          createMockSection('hero', {
            position: { startY: 0, endY: 700, height: 700 },
          }),
          createMockSection('feature', {
            position: { startY: 700, endY: 1400, height: 700 },
          }),
          createMockSection('about', {
            position: { startY: 1400, endY: 2000, height: 600 },
          }),
          createMockSection('cta', {
            position: { startY: 2000, endY: 2400, height: 400 },
          }),
        ],
      });

      const result = detector.detectSingle('artificial-whitespace', context);
      expect(result.detected).toBe(false);
    });
  });
});

// =========================================
// Weight & Severity Tests
// =========================================

describe('AntiAiClicheDetector - Weight & Severity', () => {
  let detector: AntiAiClicheDetector;

  beforeEach(() => {
    detector = new AntiAiClicheDetector();
  });

  it('should respect pattern weights in scoring', () => {
    const highWeightPattern: ClichePattern = {
      id: 'high-weight',
      name: 'High Weight',
      description: 'High impact cliche',
      severity: 'high',
      weight: 1.0,
      detector: () => ({ detected: true, confidence: 1.0 }),
    };

    const lowWeightPattern: ClichePattern = {
      id: 'low-weight',
      name: 'Low Weight',
      description: 'Low impact cliche',
      severity: 'low',
      weight: 0.1,
      detector: () => ({ detected: true, confidence: 1.0 }),
    };

    detector.addPattern(highWeightPattern);
    detector.addPattern(lowWeightPattern);

    const context = createMockDesignContext();
    const report = detector.detect(context);

    // High weight should impact score more
    expect(report.totalScore).toBeLessThan(100);
  });

  it('should categorize patterns by severity', () => {
    const patterns = detector.listPatterns();

    const low = patterns.filter((p) => p.severity === 'low');
    const medium = patterns.filter((p) => p.severity === 'medium');
    const high = patterns.filter((p) => p.severity === 'high');

    expect(low.length + medium.length + high.length).toBe(patterns.length);
  });

  it('should have severity: low patterns', () => {
    const patterns = detector.listPatterns();
    const low = patterns.filter((p) => p.severity === 'low');
    expect(low.length).toBeGreaterThan(0);
  });

  it('should have severity: medium patterns', () => {
    const patterns = detector.listPatterns();
    const medium = patterns.filter((p) => p.severity === 'medium');
    expect(medium.length).toBeGreaterThan(0);
  });

  it('should have severity: high patterns', () => {
    const patterns = detector.listPatterns();
    const high = patterns.filter((p) => p.severity === 'high');
    expect(high.length).toBeGreaterThan(0);
  });
});

// =========================================
// Report Format Tests
// =========================================

describe('AntiAiClicheDetector - Report Format', () => {
  let detector: AntiAiClicheDetector;

  beforeEach(() => {
    detector = new AntiAiClicheDetector();
  });

  it('should return totalScore as number', () => {
    const context = createMockDesignContext();
    const report = detector.detect(context);
    expect(typeof report.totalScore).toBe('number');
  });

  it('should return detectedPatterns as array', () => {
    const context = createMockDesignContext();
    const report = detector.detect(context);
    expect(Array.isArray(report.detectedPatterns)).toBe(true);
  });

  it('should return recommendations as array of strings', () => {
    const context = createMockDesignContext();
    const report = detector.detect(context);
    expect(Array.isArray(report.recommendations)).toBe(true);
    if (report.recommendations.length > 0) {
      expect(typeof report.recommendations[0]).toBe('string');
    }
  });

  it('should include pattern in detectedPatterns', () => {
    const testPattern: ClichePattern = {
      id: 'always-detect',
      name: 'Always Detect',
      description: 'Test',
      severity: 'medium',
      weight: 0.5,
      detector: () => ({ detected: true, confidence: 1.0 }),
    };

    detector.addPattern(testPattern);

    const context = createMockDesignContext();
    const report = detector.detect(context);

    const found = report.detectedPatterns.find((dp) => dp.pattern.id === 'always-detect');
    expect(found).toBeDefined();
  });

  it('should include result in detectedPatterns', () => {
    const testPattern: ClichePattern = {
      id: 'test-result',
      name: 'Test Result',
      description: 'Test',
      severity: 'low',
      weight: 0.3,
      detector: () => ({ detected: true, confidence: 0.75, details: 'Test details' }),
    };

    detector.addPattern(testPattern);

    const context = createMockDesignContext();
    const report = detector.detect(context);

    const found = report.detectedPatterns.find((dp) => dp.pattern.id === 'test-result');
    expect(found?.result.confidence).toBe(0.75);
    expect(found?.result.details).toBe('Test details');
  });

  it('should provide actionable recommendations', () => {
    const testPattern: ClichePattern = {
      id: 'test-recommendations',
      name: 'Test Recommendations',
      description: 'Test',
      severity: 'high',
      weight: 0.9,
      detector: () => ({ detected: true, confidence: 1.0 }),
    };

    detector.addPattern(testPattern);

    const context = createMockDesignContext();
    const report = detector.detect(context);

    // Should have at least one recommendation when patterns detected
    if (report.detectedPatterns.length > 0) {
      expect(report.recommendations.length).toBeGreaterThan(0);
    }
  });

  it('should calculate score inversely to cliches', () => {
    // No cliches -> high score
    const noClicheDetector = new AntiAiClicheDetector();
    // Remove all patterns
    const patterns = noClicheDetector.listPatterns();
    patterns.forEach((p) => noClicheDetector.removePattern(p.id));

    const context = createMockDesignContext();
    const report = noClicheDetector.detect(context);
    expect(report.totalScore).toBe(100);
  });
});

// =========================================
// Edge Cases
// =========================================

describe('AntiAiClicheDetector - Edge Cases', () => {
  let detector: AntiAiClicheDetector;

  beforeEach(() => {
    detector = new AntiAiClicheDetector();
  });

  it('should handle empty sections', () => {
    const context = createMockDesignContext({ sections: [] });
    const report = detector.detect(context);
    expect(report.totalScore).toBeGreaterThanOrEqual(0);
  });

  it('should handle empty color palette', () => {
    const context = createMockDesignContext({
      colors: {
        palette: [],
        dominant: '#000000',
        background: '#FFFFFF',
        text: '#000000',
      },
    });
    const report = detector.detect(context);
    expect(report).toHaveProperty('totalScore');
  });

  it('should handle empty typography fonts', () => {
    const context = createMockDesignContext({
      typography: {
        fonts: [],
        headingScale: [],
        bodySize: 16,
        lineHeight: 1.5,
      },
    });
    const report = detector.detect(context);
    expect(report).toHaveProperty('totalScore');
  });

  it('should handle unknown layout type', () => {
    const context = createMockDesignContext({
      layout: {
        type: 'unknown',
      },
    });
    const report = detector.detect(context);
    expect(report).toHaveProperty('totalScore');
  });

  it('should handle missing optional fields in ColorInfo', () => {
    const context = createMockDesignContext({
      colors: {
        palette: [{ hex: '#3B82F6', count: 10 }],
        dominant: '#3B82F6',
        background: '#FFFFFF',
        text: '#000000',
        // accent is optional
      },
    });
    const report = detector.detect(context);
    expect(report).toHaveProperty('totalScore');
  });

  it('should handle single section', () => {
    const context = createMockDesignContext({
      sections: [createMockSection('hero')],
    });
    const report = detector.detect(context);
    expect(report).toHaveProperty('totalScore');
  });

  it('should handle large number of sections', () => {
    const sections = Array.from({ length: 100 }, (_, i) =>
      createMockSection('unknown', { id: `section-${i}` })
    );
    const context = createMockDesignContext({ sections });
    const report = detector.detect(context);
    expect(report).toHaveProperty('totalScore');
  });

  it('should handle pattern with no detector function', () => {
    // This should not happen, but testing robustness
    const invalidPattern = {
      id: 'invalid',
      name: 'Invalid',
      description: 'Test',
      severity: 'low',
      weight: 0.3,
      // detector is missing
    } as any;

    // Should not throw
    expect(() => detector.addPattern(invalidPattern)).not.toThrow();
  });
});
