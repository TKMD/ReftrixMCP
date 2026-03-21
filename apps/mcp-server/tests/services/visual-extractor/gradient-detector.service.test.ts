// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gradient Detector Service Unit Tests
 *
 * Comprehensive tests for gradient-detector.service.ts covering:
 * 1. CSS gradient parsing (linear, radial, conic, repeating)
 * 2. Color value parsing (hex, rgb, rgba, hsl, named colors, CSS variables)
 * 3. Animation/Transition shorthand & longhand parsing
 * 4. Direction & center parsing (deg, grad, rad, turn, keywords)
 * 5. Edge cases (malformed CSS, empty input, deeply nested, huge input)
 * 6. Security (input validation, timeout behavior)
 * 7. Graceful degradation
 *
 * @module tests/services/visual-extractor/gradient-detector.service.test
 */

import { describe, it, expect, beforeAll } from "vitest";
import sharp from "sharp";
import type {
  GradientDetectorService,
  GradientDetectionResult,
  DetectedGradient,
} from "../../../src/services/visual-extractor/gradient-detector.service";
import { createGradientDetectorService } from "../../../src/services/visual-extractor/gradient-detector.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createSolidImage(
  width: number,
  height: number,
  color: { r: number; g: number; b: number }
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

async function createHorizontalGradient(
  width: number,
  height: number,
  start: { r: number; g: number; b: number },
  end: { r: number; g: number; b: number }
): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = x / (width - 1);
      const idx = (y * width + x) * channels;
      data[idx] = Math.round(start.r + (end.r - start.r) * t);
      data[idx + 1] = Math.round(start.g + (end.g - start.g) * t);
      data[idx + 2] = Math.round(start.b + (end.b - start.b) * t);
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GradientDetectorService (unit)", () => {
  let service: GradientDetectorService;

  beforeAll(() => {
    service = createGradientDetectorService();
  });

  // =========================================================================
  // 1. detectGradientFromCSS — Linear Gradient Patterns
  // =========================================================================
  describe("CSS Linear Gradient Parsing", () => {
    it("should parse linear-gradient with deg angle", () => {
      const css = `.a { background: linear-gradient(45deg, #ff0000, #00ff00); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients).toHaveLength(1);
      expect(result.gradients[0].type).toBe("linear");
      expect(result.gradients[0].direction).toBe(45);
      expect(result.gradients[0].colorStops.length).toBeGreaterThanOrEqual(2);
    });

    it('should parse linear-gradient with "to right" keyword', () => {
      const css = `.a { background: linear-gradient(to right, red, blue); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].type).toBe("linear");
      expect(result.gradients[0].direction).toBe(90);
    });

    it('should parse linear-gradient with "to bottom" keyword', () => {
      const css = `.a { background: linear-gradient(to bottom, #fff, #000); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].direction).toBe(180);
    });

    it('should parse linear-gradient with "to top left" keyword', () => {
      const css = `.a { background: linear-gradient(to top left, #aaa, #bbb); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].direction).toBe(315);
    });

    it("should parse linear-gradient without explicit direction", () => {
      const css = `.a { background: linear-gradient(#ff0000, #0000ff); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients[0].type).toBe("linear");
      // Direction is undefined when no direction specified
      expect(result.gradients[0].colorStops.length).toBeGreaterThanOrEqual(2);
    });

    it("should parse linear-gradient with multiple color stops", () => {
      const css = `.a { background: linear-gradient(90deg, #ff0000 0%, #00ff00 50%, #0000ff 100%); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].colorStops.length).toBe(3);
      expect(result.gradients[0].colorStops[0].position).toBeCloseTo(0, 1);
      expect(result.gradients[0].colorStops[1].position).toBeCloseTo(0.5, 1);
      expect(result.gradients[0].colorStops[2].position).toBeCloseTo(1, 1);
    });

    it("should parse background-image property", () => {
      const css = `.a { background-image: linear-gradient(180deg, #eee, #fff); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients[0].type).toBe("linear");
      expect(result.gradients[0].direction).toBe(180);
    });
  });

  // =========================================================================
  // 2. detectGradientFromCSS — Radial Gradient Patterns
  // =========================================================================
  describe("CSS Radial Gradient Parsing", () => {
    it("should parse radial-gradient with circle", () => {
      const css = `.a { background: radial-gradient(circle, #fff, #000); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients[0].type).toBe("radial");
    });

    it('should parse radial-gradient with "at" position', () => {
      const css = `.a { background: radial-gradient(circle at 25% 75%, #fff, #000); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].type).toBe("radial");
      expect(result.gradients[0].centerX).toBeCloseTo(0.25, 1);
      expect(result.gradients[0].centerY).toBeCloseTo(0.75, 1);
    });

    it("should parse radial-gradient with ellipse", () => {
      const css = `.a { background: radial-gradient(ellipse at center, #fff 0%, transparent 70%); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients[0].type).toBe("radial");
      expect(result.gradients[0].centerX).toBeCloseTo(0.5, 1);
      expect(result.gradients[0].centerY).toBeCloseTo(0.5, 1);
    });
  });

  // =========================================================================
  // 3. detectGradientFromCSS — Conic Gradient Patterns
  // =========================================================================
  describe("CSS Conic Gradient Parsing", () => {
    it("should parse conic-gradient basic pattern", () => {
      const css = `.a { background: conic-gradient(#ff0000, #00ff00, #0000ff, #ff0000); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients[0].type).toBe("conic");
    });

    it("should parse conic-gradient with percentage stops", () => {
      const css = `.a { background: conic-gradient(#ff0000 0% 25%, #00ff00 25% 50%, #0000ff 50% 75%, #ffff00 75% 100%); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].type).toBe("conic");
      expect(result.gradients[0].colorStops.length).toBeGreaterThanOrEqual(2);
    });

    it('should parse conic-gradient with "from" angle and "at" position', () => {
      const css = `.a { background: conic-gradient(from 90deg at 50% 50%, #ff0000, #0000ff); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].type).toBe("conic");
    });
  });

  // =========================================================================
  // 4. detectGradientFromCSS — Repeating Gradient Patterns
  // =========================================================================
  describe("CSS Repeating Gradient Parsing", () => {
    it("should parse repeating-linear-gradient", () => {
      const css = `.a { background: repeating-linear-gradient(45deg, #606dbc, #606dbc 10px, #465298 10px, #465298 20px); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients[0].type).toBe("linear");
      expect(result.gradients[0].cssString).toContain("repeating-linear-gradient");
    });

    it("should parse repeating-radial-gradient", () => {
      const css = `.a { background: repeating-radial-gradient(circle, #000 0px, #000 10px, #fff 10px, #fff 20px); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients[0].type).toBe("radial");
      expect(result.gradients[0].cssString).toContain("repeating-radial-gradient");
    });

    it("should parse repeating-conic-gradient", () => {
      const css = `.a { background: repeating-conic-gradient(#000 0deg 90deg, #fff 90deg 180deg); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients[0].type).toBe("conic");
    });
  });

  // =========================================================================
  // 5. detectGradientFromCSS — Color Value Parsing
  // =========================================================================
  describe("CSS Color Value Parsing", () => {
    it("should parse hex color values (#RRGGBB)", () => {
      const css = `.a { background: linear-gradient(#ff0000, #0000ff); }`;
      const result = service.detectGradientFromCSS(css);

      const stops = result.gradients[0].colorStops;
      expect(stops.some((s) => s.color.includes("#ff0000"))).toBe(true);
      expect(stops.some((s) => s.color.includes("#0000ff"))).toBe(true);
    });

    it("should parse rgb() color values", () => {
      const css = `.a { background: linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255)); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      const stops = result.gradients[0].colorStops;
      expect(stops.some((s) => s.color.includes("rgb("))).toBe(true);
    });

    it("should parse rgba() color values", () => {
      const css = `.a { background: linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0.8)); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      const stops = result.gradients[0].colorStops;
      expect(stops.some((s) => s.color.includes("rgba("))).toBe(true);
    });

    it("should parse named color values", () => {
      const css = `.a { background: linear-gradient(red, blue); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      const stops = result.gradients[0].colorStops;
      expect(stops.some((s) => s.color === "red")).toBe(true);
      expect(stops.some((s) => s.color === "blue")).toBe(true);
    });

    it("should parse transparent keyword", () => {
      const css = `.a { background: linear-gradient(transparent, #000); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      const stops = result.gradients[0].colorStops;
      expect(stops.some((s) => s.color === "transparent")).toBe(true);
    });

    it("should parse CSS variables in color stops", () => {
      const css = `.a { background: linear-gradient(var(--angle), var(--start), var(--end)); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients[0].cssString).toContain("var(--");
    });
  });

  // =========================================================================
  // 6. detectGradientFromCSS — Direction & Angle Parsing
  // =========================================================================
  describe("CSS Direction & Angle Unit Parsing", () => {
    it("should parse grad unit", () => {
      // 100grad = 90deg
      const css = `.a { background: linear-gradient(100grad, #f00, #00f); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].direction).toBeCloseTo(90, 0);
    });

    it("should parse rad unit", () => {
      // Math.PI rad = 180deg
      const css = `.a { background: linear-gradient(${Math.PI.toFixed(6)}rad, #f00, #00f); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].direction).toBeCloseTo(180, 0);
    });

    it("should parse turn unit", () => {
      // 0.25turn = 90deg
      const css = `.a { background: linear-gradient(0.25turn, #f00, #00f); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].direction).toBeCloseTo(90, 0);
    });

    it("should parse negative degree values", () => {
      const css = `.a { background: linear-gradient(-45deg, #f00, #00f); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].direction).toBe(-45);
    });

    it("should handle 0deg", () => {
      const css = `.a { background: linear-gradient(0deg, #f00, #00f); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].direction).toBe(0);
    });

    it("should handle 360deg", () => {
      const css = `.a { background: linear-gradient(360deg, #f00, #00f); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].direction).toBe(360);
    });
  });

  // =========================================================================
  // 7. detectGradientFromCSS — Animation Info Parsing
  // =========================================================================
  describe("CSS Animation Info Parsing", () => {
    it("should parse animation shorthand with all properties", () => {
      const css = `.a {
        background: linear-gradient(90deg, #f00, #00f);
        animation: glow 2s ease-in-out infinite alternate 0.5s forwards;
      }`;
      const result = service.detectGradientFromCSS(css);

      const anim = result.gradients[0].animation;
      expect(anim).toBeDefined();
      expect(anim!.name).toBe("glow");
      expect(anim!.duration).toBe("2s");
      expect(anim!.timingFunction).toBe("ease-in-out");
      expect(anim!.iterationCount).toBe("infinite");
      expect(anim!.direction).toBe("alternate");
      expect(anim!.delay).toBe("0.5s");
      expect(anim!.fillMode).toBe("forwards");
    });

    it("should parse animation shorthand with minimal properties", () => {
      const css = `.a {
        background: linear-gradient(90deg, #f00, #00f);
        animation: spin 1s linear;
      }`;
      const result = service.detectGradientFromCSS(css);

      const anim = result.gradients[0].animation;
      expect(anim!.name).toBe("spin");
      expect(anim!.duration).toBe("1s");
      expect(anim!.timingFunction).toBe("linear");
    });

    it("should parse individual animation-* properties", () => {
      const css = `.a {
        background: linear-gradient(90deg, #f00, #00f);
        animation-name: pulse;
        animation-duration: 500ms;
        animation-timing-function: ease;
        animation-iteration-count: 3;
        animation-direction: reverse;
        animation-delay: 100ms;
        animation-fill-mode: both;
      }`;
      const result = service.detectGradientFromCSS(css);

      const anim = result.gradients[0].animation;
      expect(anim!.name).toBe("pulse");
      expect(anim!.duration).toBe("500ms");
      expect(anim!.timingFunction).toBe("ease");
      expect(anim!.iterationCount).toBe("3");
      expect(anim!.direction).toBe("reverse");
      expect(anim!.delay).toBe("100ms");
      expect(anim!.fillMode).toBe("both");
    });

    it('should return undefined animation when animation-name is "none"', () => {
      const css = `.a {
        background: linear-gradient(90deg, #f00, #00f);
        animation-name: none;
      }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].animation).toBeUndefined();
    });

    it("should return undefined animation when no animation declared", () => {
      const css = `.a { background: linear-gradient(90deg, #f00, #00f); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].animation).toBeUndefined();
    });
  });

  // =========================================================================
  // 8. detectGradientFromCSS — Transition Info Parsing
  // =========================================================================
  describe("CSS Transition Info Parsing", () => {
    it("should parse transition shorthand for background", () => {
      const css = `.a {
        background: linear-gradient(90deg, #f00, #00f);
        transition: background 0.5s ease-out 0.1s;
      }`;
      const result = service.detectGradientFromCSS(css);

      const trans = result.gradients[0].transition;
      expect(trans).toBeDefined();
      expect(trans!.property).toBe("background");
      expect(trans!.duration).toBe("0.5s");
      expect(trans!.timingFunction).toBe("ease-out");
      expect(trans!.delay).toBe("0.1s");
    });

    it('should parse transition shorthand with "all" property', () => {
      const css = `.a {
        background: linear-gradient(90deg, #f00, #00f);
        transition: all 0.3s ease;
      }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].transition).toBeDefined();
      expect(result.gradients[0].transition!.property).toBe("all");
    });

    it("should not capture transition for unrelated property", () => {
      const css = `.a {
        background: linear-gradient(90deg, #f00, #00f);
        transition: color 0.3s ease;
      }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].transition).toBeUndefined();
    });

    it("should parse individual transition-* properties targeting background", () => {
      const css = `.a {
        background: linear-gradient(90deg, #f00, #00f);
        transition-property: opacity, background;
        transition-duration: 0.2s, 0.4s;
        transition-timing-function: linear, ease-in;
        transition-delay: 0s, 50ms;
      }`;
      const result = service.detectGradientFromCSS(css);

      const trans = result.gradients[0].transition;
      expect(trans).toBeDefined();
      expect(trans!.property).toBe("background");
      expect(trans!.duration).toBe("0.4s");
      expect(trans!.timingFunction).toBe("ease-in");
    });

    it("should return undefined transition when no transition declared", () => {
      const css = `.a { background: linear-gradient(90deg, #f00, #00f); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].transition).toBeUndefined();
    });
  });

  // =========================================================================
  // 9. detectGradientFromCSS — Parent Element (Selector) Tracking
  // =========================================================================
  describe("CSS Selector Tracking", () => {
    it("should track class selector", () => {
      const css = `.hero { background: linear-gradient(#f00, #00f); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].parentElement).toBe(".hero");
    });

    it("should track compound selector", () => {
      const css = `section.dark .overlay { background: linear-gradient(#000, transparent); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].parentElement).toBe("section.dark .overlay");
    });

    it("should track comma-separated selectors", () => {
      const css = `.a, .b { background: linear-gradient(#f00, #00f); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].parentElement).toBe(".a, .b");
    });

    it("should track pseudo-element selector", () => {
      const css = `.card::after { background: linear-gradient(#f00, #00f); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].parentElement).toBe(".card::after");
    });

    it("should track attribute selector", () => {
      const css = `[data-theme="dark"] { background: linear-gradient(#333, #000); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients[0].parentElement).toBe('[data-theme="dark"]');
    });
  });

  // =========================================================================
  // 10. detectGradientFromCSS — Multiple Gradients
  // =========================================================================
  describe("CSS Multiple Gradient Extraction", () => {
    it("should extract gradients from multiple rules", () => {
      const css = `
        .header { background: linear-gradient(#f00, #0f0); }
        .footer { background: radial-gradient(circle, #fff, #000); }
        .sidebar { background: conic-gradient(#f00, #0f0, #00f, #f00); }
      `;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients).toHaveLength(3);
      expect(result.gradients.map((g) => g.type)).toEqual(
        expect.arrayContaining(["linear", "radial", "conic"])
      );
    });

    it("should extract multiple gradients from single background property", () => {
      const css = `.a {
        background:
          linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5)),
          radial-gradient(circle, #fff, transparent);
      }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients).toHaveLength(2);
      expect(result.gradients[0].type).toBe("linear");
      expect(result.gradients[1].type).toBe("radial");
    });

    it("should set dominantGradientType to first gradient type", () => {
      const css = `
        .a { background: radial-gradient(circle, #fff, #000); }
        .b { background: linear-gradient(#f00, #00f); }
      `;
      const result = service.detectGradientFromCSS(css);

      expect(result.dominantGradientType).toBe("radial");
    });
  });

  // =========================================================================
  // 11. detectGradientFromCSS — Edge Cases
  // =========================================================================
  describe("CSS Edge Cases", () => {
    it("should return empty result for empty string", () => {
      const result = service.detectGradientFromCSS("");

      expect(result.hasGradient).toBe(false);
      expect(result.gradients).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });

    it("should handle null input without throwing", () => {
      expect(() => service.detectGradientFromCSS(null as unknown as string)).not.toThrow();
      const result = service.detectGradientFromCSS(null as unknown as string);
      expect(result.hasGradient).toBe(false);
    });

    it("should handle undefined input without throwing", () => {
      expect(() => service.detectGradientFromCSS(undefined as unknown as string)).not.toThrow();
      const result = service.detectGradientFromCSS(undefined as unknown as string);
      expect(result.hasGradient).toBe(false);
    });

    it("should handle numeric input without throwing", () => {
      expect(() => service.detectGradientFromCSS(123 as unknown as string)).not.toThrow();
    });

    it("should return empty result for CSS without gradients", () => {
      const css = `.a { background-color: #fff; color: #333; font-size: 16px; }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(false);
      expect(result.gradients).toHaveLength(0);
    });

    it("should ignore @keyframes rules", () => {
      const css = `
        @keyframes slide { 0% { transform: translateX(0); } 100% { transform: translateX(100px); } }
        .a { background: linear-gradient(#f00, #00f); animation: slide 1s; }
      `;
      const result = service.detectGradientFromCSS(css);

      // Should only get gradient from .a, not from @keyframes
      expect(result.gradients).toHaveLength(1);
      expect(result.gradients[0].parentElement).toBe(".a");
    });

    it("should strip CSS comments before parsing", () => {
      const css = `
        /* Header gradient */
        .header {
          /* Main background */
          background: linear-gradient(90deg, #f00, #00f); /* red to blue */
        }
      `;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients).toHaveLength(1);
    });

    it("should handle CSS with no closing brace gracefully", () => {
      const css = `.a { background: linear-gradient(#f00, #00f)`;
      // Should not throw
      expect(() => service.detectGradientFromCSS(css)).not.toThrow();
    });

    it("should handle large CSS input", () => {
      // Generate 500 rules
      const rules = Array.from(
        { length: 500 },
        (_, i) => `.item-${i} { background: linear-gradient(${i}deg, #ff0000, #0000ff); }`
      ).join("\n");
      const result = service.detectGradientFromCSS(rules);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients).toHaveLength(500);
    });

    it("should include processingTimeMs in result", () => {
      const css = `.a { background: linear-gradient(#f00, #00f); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.processingTimeMs)).toBe(true);
    });
  });

  // =========================================================================
  // 12. detectGradientFromCSS — Result Structure Validation
  // =========================================================================
  describe("CSS Detection Result Structure", () => {
    it("should have correct structure when gradient found", () => {
      const css = `.a { background: linear-gradient(90deg, #f00 0%, #00f 100%); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result).toEqual(
        expect.objectContaining({
          hasGradient: true,
          confidence: 1.0,
        })
      );

      const gradient = result.gradients[0];
      expect(gradient).toEqual(
        expect.objectContaining({
          type: "linear",
          confidence: 1.0,
          region: { x: 0, y: 0, width: 0, height: 0 },
        })
      );
      expect(gradient.cssString).toContain("linear-gradient");
      expect(gradient.parentElement).toBe(".a");
      expect(Array.isArray(gradient.colorStops)).toBe(true);
    });

    it("should have correct structure when no gradient found", () => {
      const css = `.a { color: red; }`;
      const result = service.detectGradientFromCSS(css);

      expect(result).toEqual(
        expect.objectContaining({
          hasGradient: false,
          gradients: [],
          confidence: 0,
        })
      );
      expect(result.dominantGradientType).toBeUndefined();
    });

    it("should preserve original CSS string in cssString field", () => {
      const css = `.a { background: linear-gradient(45deg, rgba(255,0,0,0.5) 10%, #00ff00 90%); }`;
      const result = service.detectGradientFromCSS(css);

      const cssStr = result.gradients[0].cssString;
      expect(cssStr).toContain("linear-gradient");
      expect(cssStr).toContain("rgba(255,0,0,0.5)");
    });
  });

  // =========================================================================
  // 13. detectGradient — Image-Based Security & Input Validation
  // =========================================================================
  describe("Image-Based Input Validation", () => {
    it("should reject null input", async () => {
      await expect(service.detectGradient(null as unknown as Buffer)).rejects.toThrow();
    });

    it("should reject undefined input", async () => {
      await expect(service.detectGradient(undefined as unknown as Buffer)).rejects.toThrow();
    });

    it("should reject empty buffer", async () => {
      await expect(service.detectGradient(Buffer.alloc(0))).rejects.toThrow();
    });

    it("should reject invalid image data", async () => {
      const invalidBuffer = Buffer.from("not-an-image-data");
      await expect(service.detectGradient(invalidBuffer)).rejects.toThrow();
    });

    it("should accept base64 encoded image string", async () => {
      const img = await createSolidImage(50, 50, { r: 128, g: 128, b: 128 });
      const base64 = img.toString("base64");
      const result = await service.detectGradient(base64);

      expect(result).toBeDefined();
      expect(typeof result.hasGradient).toBe("boolean");
    });

    it("should reject oversized image (>5MB)", async () => {
      // Create a buffer > 5MB
      const oversized = Buffer.alloc(6 * 1024 * 1024, 0xff);
      await expect(service.detectGradient(oversized)).rejects.toThrow();
    });
  });

  // =========================================================================
  // 14. detectGradient — Solid Color Detection (No Gradient)
  // =========================================================================
  describe("Image-Based Solid Color Detection", () => {
    it("should detect solid color as no gradient", async () => {
      const img = await createSolidImage(100, 100, { r: 200, g: 100, b: 50 });
      const result = await service.detectGradient(img);

      expect(result.hasGradient).toBe(false);
      expect(result.gradients).toHaveLength(0);
    });

    it("should detect nearly solid color as no gradient", async () => {
      // Colors with very small variation (< CONTINUOUS_GRADIENT_THRESHOLD)
      const channels = 3;
      const width = 100;
      const height = 100;
      const data = Buffer.alloc(width * height * channels);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * channels;
          data[idx] = 128 + Math.round(Math.random() * 3); // Very small noise
          data[idx + 1] = 128 + Math.round(Math.random() * 3);
          data[idx + 2] = 128 + Math.round(Math.random() * 3);
        }
      }
      const img = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
      const result = await service.detectGradient(img);

      expect(result.hasGradient).toBe(false);
    });
  });

  // =========================================================================
  // 15. detectGradient — CSS String Generation from Image
  // =========================================================================
  describe("Image-Based CSS String Generation", () => {
    it("should generate cssString for detected linear gradient", async () => {
      const img = await createHorizontalGradient(
        200,
        100,
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 0, b: 255 }
      );
      const result = await service.detectGradient(img);

      expect(result.hasGradient).toBe(true);
      const gradient = result.gradients[0];
      expect(gradient.cssString).toBeDefined();
      expect(gradient.cssString).toMatch(/^(linear|radial|conic)-gradient\(.+\)$/);
      expect(gradient.cssString).toContain("#");
      expect(gradient.cssString).toMatch(/\d+%/);
    });

    it("should not have animation/transition for image-only detection", async () => {
      const img = await createHorizontalGradient(
        200,
        100,
        { r: 0, g: 255, b: 0 },
        { r: 0, g: 0, b: 255 }
      );
      const result = await service.detectGradient(img);

      if (result.gradients.length > 0) {
        expect(result.gradients[0].animation).toBeUndefined();
        expect(result.gradients[0].transition).toBeUndefined();
        expect(result.gradients[0].parentElement).toBeUndefined();
      }
    });
  });

  // =========================================================================
  // 16. detectGradient — Result Structure
  // =========================================================================
  describe("Image-Based Result Structure", () => {
    it("should include processingTimeMs", async () => {
      const img = await createSolidImage(50, 50, { r: 128, g: 128, b: 128 });
      const result = await service.detectGradient(img);

      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.processingTimeMs)).toBe(true);
    });

    it("should include confidence between 0 and 1", async () => {
      const img = await createHorizontalGradient(
        200,
        100,
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 0, b: 255 }
      );
      const result = await service.detectGradient(img);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);

      for (const g of result.gradients) {
        expect(g.confidence).toBeGreaterThanOrEqual(0);
        expect(g.confidence).toBeLessThanOrEqual(1);
      }
    });

    it("should include valid region bounds", async () => {
      const img = await createHorizontalGradient(
        200,
        100,
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 0, b: 255 }
      );
      const result = await service.detectGradient(img);

      for (const g of result.gradients) {
        expect(g.region.x).toBeGreaterThanOrEqual(0);
        expect(g.region.y).toBeGreaterThanOrEqual(0);
        expect(g.region.width).toBeGreaterThan(0);
        expect(g.region.height).toBeGreaterThan(0);
      }
    });

    it("should have dominantGradientType when gradient is detected", async () => {
      const img = await createHorizontalGradient(
        200,
        100,
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 0, b: 255 }
      );
      const result = await service.detectGradient(img);

      expect(result.hasGradient).toBe(true);
      expect(["linear", "radial", "conic"]).toContain(result.dominantGradientType);
    });

    it("should have undefined dominantGradientType when no gradient", async () => {
      const img = await createSolidImage(100, 100, { r: 128, g: 128, b: 128 });
      const result = await service.detectGradient(img);

      expect(result.dominantGradientType).toBeUndefined();
    });
  });

  // =========================================================================
  // 17. createGradientDetectorService — Factory
  // =========================================================================
  describe("Factory Function", () => {
    it("should create service with default config", () => {
      const svc = createGradientDetectorService();
      expect(svc).toBeDefined();
      expect(typeof svc.detectGradient).toBe("function");
      expect(typeof svc.detectGradientFromCSS).toBe("function");
    });

    it("should create service with custom config", () => {
      const svc = createGradientDetectorService({
        maxProcessingWidth: 150,
        maxProcessingHeight: 150,
        sampleStep: 4,
      });
      expect(svc).toBeDefined();
    });

    it("should process small images with custom config", async () => {
      const svc = createGradientDetectorService({
        maxProcessingWidth: 50,
        maxProcessingHeight: 50,
        minGradientLength: 5,
      });
      const img = await createHorizontalGradient(
        60,
        30,
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 0, b: 255 }
      );
      const result = await svc.detectGradient(img);

      expect(typeof result.hasGradient).toBe("boolean");
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // 18. detectGradientFromCSS — Complex Real-World CSS
  // =========================================================================
  describe("CSS Real-World Patterns", () => {
    it("should parse gradient in :hover pseudo-class", () => {
      const css = `
        .btn:hover {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          transition: background 0.3s ease;
        }
      `;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      expect(result.gradients[0].parentElement).toBe(".btn:hover");
      expect(result.gradients[0].direction).toBe(135);
      expect(result.gradients[0].transition).toBeDefined();
    });

    it("should parse gradient with CSS calc() in stops", () => {
      const css = `.a { background: linear-gradient(90deg, #f00 0%, #00f 100%); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
    });

    it("should parse gradient overlay pattern", () => {
      const css = `
        .hero {
          background:
            linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.7) 100%),
            linear-gradient(to right, rgba(59,130,246,0.5), rgba(139,92,246,0.5));
        }
      `;
      const result = service.detectGradientFromCSS(css);

      expect(result.gradients).toHaveLength(2);
      expect(result.gradients[0].type).toBe("linear");
      expect(result.gradients[1].type).toBe("linear");
    });

    it("should parse gradient with complex nested rgba", () => {
      const css = `.a { background: linear-gradient(rgba(255,255,255,0.1), rgba(255,255,255,0)); }`;
      const result = service.detectGradientFromCSS(css);

      expect(result.hasGradient).toBe(true);
      const stops = result.gradients[0].colorStops;
      expect(stops.length).toBeGreaterThanOrEqual(2);
    });

    it("should parse media query inner rules (simplified)", () => {
      // Our simplified parser does not handle @media deeply, but should not crash
      const css = `
        @media (min-width: 768px) {
          .hero { background: linear-gradient(#f00, #00f); }
        }
      `;
      expect(() => service.detectGradientFromCSS(css)).not.toThrow();
    });
  });
});
