// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visual Decoration Detector Service Tests
 *
 * Tests for the VisualDecorationDetectorService that detects:
 * - Glow effects (box-shadow based)
 * - Gradient backgrounds (linear, radial, conic)
 * - Animated borders (border-image, keyframe animations)
 * - Glass morphism (backdrop-filter)
 *
 * @module tests/services/visual-extractor/visual-decoration-detector.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  VisualDecorationDetectorService,
  visualDecorationDetector,
} from '../../../src/services/visual-extractor/visual-decoration-detector.service';
import type {
  VisualDecoration,
  VisualDecorationsResult,
} from '../../../src/tools/layout/inspect/visual-extractors.schemas';

describe('VisualDecorationDetectorService', () => {
  let detector: VisualDecorationDetectorService;

  beforeEach(() => {
    detector = new VisualDecorationDetectorService();
  });

  describe('Singleton instance', () => {
    it('should export a singleton visualDecorationDetector', () => {
      expect(visualDecorationDetector).toBeInstanceOf(VisualDecorationDetectorService);
    });
  });

  describe('detectFromCSS', () => {
    describe('Glow Effects', () => {
      it('should detect basic glow effect from box-shadow', () => {
        const css = `
          .glowing-ring {
            box-shadow: 0 0 20px rgba(255, 100, 50, 0.5);
          }
        `;
        const result = detector.detectFromCSS(css);

        expect(result.decorations.length).toBeGreaterThan(0);
        const glow = result.decorations.find((d) => d.type === 'glow');
        expect(glow).toBeDefined();
        expect(glow?.properties.blur).toBe(20);
        expect(glow?.confidence).toBeGreaterThanOrEqual(0.7);
        expect(result.summary.glowCount).toBe(1);
      });

      it('should detect glow with hex color', () => {
        const css = `
          .element {
            box-shadow: 0 0 30px #ff6432;
          }
        `;
        const result = detector.detectFromCSS(css);

        const glow = result.decorations.find((d) => d.type === 'glow');
        expect(glow).toBeDefined();
        expect(glow?.properties.color).toMatch(/^#[0-9a-fA-F]{6}$/i);
      });

      it('should detect multiple glow effects', () => {
        const css = `
          .glow1 { box-shadow: 0 0 10px red; }
          .glow2 { box-shadow: 0 0 15px blue; }
        `;
        const result = detector.detectFromCSS(css);

        expect(result.summary.glowCount).toBe(2);
      });

      it('should not detect regular drop shadow as glow', () => {
        const css = `
          .shadow {
            box-shadow: 5px 5px 10px rgba(0, 0, 0, 0.3);
          }
        `;
        const result = detector.detectFromCSS(css);

        expect(result.summary.glowCount).toBe(0);
      });

      it('should detect glow with spread radius', () => {
        const css = `
          .glow {
            box-shadow: 0 0 20px 5px rgba(100, 200, 255, 0.6);
          }
        `;
        const result = detector.detectFromCSS(css);

        const glow = result.decorations.find((d) => d.type === 'glow');
        expect(glow).toBeDefined();
        expect(glow?.properties.spread).toBe(5);
      });

      it('should handle inset box-shadow (not glow)', () => {
        const css = `
          .inset {
            box-shadow: inset 0 0 20px rgba(255, 0, 0, 0.5);
          }
        `;
        const result = detector.detectFromCSS(css);

        // Inset shadows typically aren't considered glow effects
        expect(result.summary.glowCount).toBe(0);
      });
    });

    describe('Gradient Backgrounds', () => {
      it('should detect linear-gradient', () => {
        const css = `
          .gradient {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
        `;
        const result = detector.detectFromCSS(css);

        expect(result.summary.gradientCount).toBeGreaterThan(0);
        const gradient = result.decorations.find((d) => d.type === 'gradient');
        expect(gradient).toBeDefined();
        expect(gradient?.properties.gradientType).toBe('linear');
        expect(gradient?.properties.angle).toBe(135);
      });

      it('should detect radial-gradient', () => {
        const css = `
          .radial {
            background: radial-gradient(circle, #fff 0%, #000 100%);
          }
        `;
        const result = detector.detectFromCSS(css);

        const gradient = result.decorations.find((d) => d.type === 'gradient');
        expect(gradient).toBeDefined();
        expect(gradient?.properties.gradientType).toBe('radial');
      });

      it('should detect conic-gradient', () => {
        const css = `
          .conic {
            background: conic-gradient(from 0deg, red, yellow, green, blue, red);
          }
        `;
        const result = detector.detectFromCSS(css);

        const gradient = result.decorations.find((d) => d.type === 'gradient');
        expect(gradient).toBeDefined();
        expect(gradient?.properties.gradientType).toBe('conic');
      });

      it('should extract color stops', () => {
        const css = `
          .gradient {
            background: linear-gradient(90deg, #ff0000 0%, #00ff00 50%, #0000ff 100%);
          }
        `;
        const result = detector.detectFromCSS(css);

        const gradient = result.decorations.find((d) => d.type === 'gradient');
        expect(gradient?.properties.colorStops).toBeDefined();
        expect(gradient?.properties.colorStops?.length).toBe(3);
      });

      it('should handle gradient with direction keywords', () => {
        const css = `
          .gradient {
            background: linear-gradient(to right, #000, #fff);
          }
        `;
        const result = detector.detectFromCSS(css);

        const gradient = result.decorations.find((d) => d.type === 'gradient');
        expect(gradient).toBeDefined();
        expect(gradient?.properties.angle).toBe(90); // "to right" = 90deg
      });
    });

    describe('Animated Borders', () => {
      it('should detect border-image gradient', () => {
        const css = `
          .border-gradient {
            border-image: linear-gradient(90deg, red, blue) 1;
          }
        `;
        const result = detector.detectFromCSS(css);

        const animatedBorder = result.decorations.find((d) => d.type === 'animated-border');
        expect(animatedBorder).toBeDefined();
        expect(result.summary.animatedBorderCount).toBeGreaterThan(0);
      });

      it('should detect animation on border properties', () => {
        const css = `
          @keyframes borderPulse {
            0% { border-color: red; }
            100% { border-color: blue; }
          }
          .animated-border {
            animation: borderPulse 2s infinite;
          }
        `;
        const result = detector.detectFromCSS(css);

        const animatedBorder = result.decorations.find((d) => d.type === 'animated-border');
        expect(animatedBorder).toBeDefined();
        expect(animatedBorder?.properties.animationName).toBe('borderPulse');
      });

      it('should detect glowing border (box-shadow + border-radius)', () => {
        const css = `
          .glowing-border {
            border-radius: 10px;
            box-shadow: 0 0 15px rgba(100, 255, 100, 0.8);
          }
        `;
        const result = detector.detectFromCSS(css);

        // This should detect both glow and potentially animated-border
        expect(result.summary.glowCount).toBeGreaterThan(0);
      });
    });

    describe('Glass Morphism', () => {
      it('should detect backdrop-filter blur', () => {
        const css = `
          .glass {
            backdrop-filter: blur(10px);
          }
        `;
        const result = detector.detectFromCSS(css);

        expect(result.summary.glassMorphismCount).toBeGreaterThan(0);
        const glass = result.decorations.find((d) => d.type === 'glass-morphism');
        expect(glass).toBeDefined();
        expect(glass?.properties.blur).toBe(10);
      });

      it('should detect -webkit-backdrop-filter', () => {
        const css = `
          .glass {
            -webkit-backdrop-filter: blur(20px);
          }
        `;
        const result = detector.detectFromCSS(css);

        expect(result.summary.glassMorphismCount).toBeGreaterThan(0);
      });

      it('should detect backdrop-filter with multiple functions', () => {
        const css = `
          .glass {
            backdrop-filter: blur(10px) saturate(180%);
          }
        `;
        const result = detector.detectFromCSS(css);

        const glass = result.decorations.find((d) => d.type === 'glass-morphism');
        expect(glass).toBeDefined();
      });
    });
  });

  describe('detectFromHTML', () => {
    it('should extract CSS from style tags', () => {
      const html = `
        <html>
        <head>
          <style>
            .glow { box-shadow: 0 0 20px rgba(255, 0, 0, 0.5); }
          </style>
        </head>
        <body>
          <div class="glow">Glowing element</div>
        </body>
        </html>
      `;
      const result = detector.detectFromHTML(html);

      expect(result.summary.glowCount).toBeGreaterThan(0);
    });

    it('should extract inline styles', () => {
      const html = `
        <div style="backdrop-filter: blur(15px); background: rgba(255,255,255,0.1);">
          Glass card
        </div>
      `;
      const result = detector.detectFromHTML(html);

      expect(result.summary.glassMorphismCount).toBeGreaterThan(0);
    });

    it('should combine style tags and inline styles', () => {
      const html = `
        <html>
        <head>
          <style>
            .gradient { background: linear-gradient(45deg, red, blue); }
          </style>
        </head>
        <body>
          <div class="gradient"></div>
          <div style="box-shadow: 0 0 20px green;"></div>
        </body>
        </html>
      `;
      const result = detector.detectFromHTML(html);

      expect(result.summary.gradientCount).toBeGreaterThan(0);
      expect(result.summary.glowCount).toBeGreaterThan(0);
    });

    it('should handle empty HTML', () => {
      const result = detector.detectFromHTML('');

      expect(result.decorations).toEqual([]);
      expect(result.summary.glowCount).toBe(0);
      expect(result.summary.gradientCount).toBe(0);
      expect(result.summary.animatedBorderCount).toBe(0);
      expect(result.summary.glassMorphismCount).toBe(0);
    });

    it('should handle HTML without styles', () => {
      const html = `
        <html>
        <body>
          <div>No styles here</div>
        </body>
        </html>
      `;
      const result = detector.detectFromHTML(html);

      expect(result.decorations).toEqual([]);
    });
  });

  describe('E&A Financial style detection', () => {
    it('should detect glowing ring effect', () => {
      const css = `
        .hero-ring {
          position: absolute;
          width: 400px;
          height: 400px;
          border-radius: 50%;
          border: 2px solid rgba(100, 200, 255, 0.3);
          box-shadow:
            0 0 30px rgba(100, 200, 255, 0.4),
            inset 0 0 20px rgba(100, 200, 255, 0.2);
          animation: pulse 3s ease-in-out infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.8; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.05); }
        }
      `;
      const result = detector.detectFromCSS(css);

      expect(result.summary.glowCount).toBeGreaterThan(0);
      const glow = result.decorations.find((d) => d.type === 'glow');
      expect(glow).toBeDefined();
    });

    it('should detect premium gradient background', () => {
      const css = `
        .hero {
          background: linear-gradient(
            135deg,
            #0a0f1c 0%,
            #1a2a4a 50%,
            #0a1628 100%
          );
        }
      `;
      const result = detector.detectFromCSS(css);

      expect(result.summary.gradientCount).toBeGreaterThan(0);
      const gradient = result.decorations.find((d) => d.type === 'gradient');
      expect(gradient?.properties.gradientType).toBe('linear');
      expect(gradient?.properties.angle).toBe(135);
    });

    it('should detect glass morphism card', () => {
      const css = `
        .glass-card {
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 16px;
        }
      `;
      const result = detector.detectFromCSS(css);

      expect(result.summary.glassMorphismCount).toBeGreaterThan(0);
      const glass = result.decorations.find((d) => d.type === 'glass-morphism');
      expect(glass?.properties.blur).toBe(20);
    });
  });

  describe('Processing time tracking', () => {
    it('should track processing time', () => {
      const css = `
        .element {
          box-shadow: 0 0 20px red;
          background: linear-gradient(45deg, blue, green);
          backdrop-filter: blur(10px);
        }
      `;
      const result = detector.detectFromCSS(css);

      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Confidence scoring', () => {
    it('should have higher confidence for clear glow patterns', () => {
      const css = `
        .clear-glow {
          box-shadow: 0 0 30px rgba(255, 100, 50, 0.8);
        }
      `;
      const result = detector.detectFromCSS(css);

      const glow = result.decorations.find((d) => d.type === 'glow');
      expect(glow?.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('should have lower confidence for ambiguous patterns', () => {
      const css = `
        .ambiguous {
          box-shadow: 0 0 5px rgba(128, 128, 128, 0.3);
        }
      `;
      const result = detector.detectFromCSS(css);

      const glow = result.decorations.find((d) => d.type === 'glow');
      if (glow) {
        expect(glow.confidence).toBeLessThan(0.9);
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle CSS with syntax errors gracefully', () => {
      const css = `
        .broken {
          box-shadow: 0 0 20px
        }
        .valid {
          background: linear-gradient(90deg, red, blue);
        }
      `;
      const result = detector.detectFromCSS(css);

      // Should still detect valid gradients
      expect(result.summary.gradientCount).toBeGreaterThan(0);
    });

    it('should handle very long CSS', () => {
      const css = Array(100)
        .fill('.element { box-shadow: 0 0 10px red; }')
        .join('\n');
      const result = detector.detectFromCSS(css);

      expect(result.summary.glowCount).toBeGreaterThan(0);
    });

    it('should handle CSS with nested functions', () => {
      const css = `
        .complex {
          background: linear-gradient(
            135deg,
            rgba(calc(100 + 50), 50, 100, 0.5),
            var(--color-primary)
          );
        }
      `;
      const result = detector.detectFromCSS(css);

      // Should handle without crashing
      expect(result).toBeDefined();
    });

    it('should handle multiple shadows in one declaration', () => {
      const css = `
        .multi-shadow {
          box-shadow:
            0 0 20px rgba(255, 0, 0, 0.5),
            0 0 40px rgba(0, 255, 0, 0.3),
            5px 5px 10px rgba(0, 0, 0, 0.2);
        }
      `;
      const result = detector.detectFromCSS(css);

      // Should detect the glow shadows (not the regular drop shadow)
      expect(result.summary.glowCount).toBeGreaterThanOrEqual(2);
    });
  });
});
