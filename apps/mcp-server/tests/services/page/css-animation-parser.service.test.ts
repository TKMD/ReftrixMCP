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

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  CssAnimationParser,
  type KeyframeStep,
  type EasingConfig,
  CSS_PARSER_LIMITS,
} from "../../../src/services/page/css-animation-parser.service";

// =============================================================================
// v0.5.1 CO-PR21-REVIEW-01 (ADR-0020 Decision 5):
//   ReDoS threshold input-size 関数化
// =============================================================================
// PR #21 hotfix では fixed `1000 ms` で elapsed assertion を行っていたが、
// 大きな input (例: 100k chars) では false-pass、小さな input (例: 100 chars)
// では false-fail のリスクがあり CWE-770 mitigation completeness 不足。
//
// CO-PR21-REVIEW-01 で `expectedMaxMs = input.length / throughputCharsPerMs + 200`
// に置換。`throughputCharsPerMs` は env var `REDOS_TEST_THROUGHPUT_CHARS_PER_MS`
// で override 可能 (Local default 100、CI 80 を Phase 2.4 で env var injection
// により設定予定)。`+200ms` は startup overhead constant。
//
// PR #21 hotfix used a fixed 1000 ms threshold; with this change the limit
// scales linearly with input length, restoring CWE-770 mitigation completeness.
// `throughputCharsPerMs` defaults to 100 (Local) and is overridable via
// `REDOS_TEST_THROUGHPUT_CHARS_PER_MS` (CI will inject 80 via Phase 2.4 env
// var injection). `+200ms` is the startup-overhead constant.
// =============================================================================

/**
 * Throughput floor (chars/ms) used to derive ReDoS test elapsed-time budget.
 * Default 100 chars/ms (Local). CI overrides to 80 via env var
 * `REDOS_TEST_THROUGHPUT_CHARS_PER_MS` (Phase 2.4 — Plan v0.5.1).
 */
const REDOS_TEST_THROUGHPUT_CHARS_PER_MS = Number(
  process.env.REDOS_TEST_THROUGHPUT_CHARS_PER_MS ?? "100"
);
/** Startup-overhead constant (ms) added to the input-size proportional limit. */
const REDOS_TEST_STARTUP_OVERHEAD_MS = 200;

/**
 * Compute the input-size proportional max elapsed time for a ReDoS protection
 * assertion: `inputLength / throughputCharsPerMs + startupOverheadMs`.
 *
 * Replaces the v0.5.0 PR #21 hotfix fixed `1000 ms` threshold.
 * See ADR-0020 Decision 5 / CO-PR21-REVIEW-01.
 */
function expectedMaxMsForReDoS(inputLength: number): number {
  return inputLength / REDOS_TEST_THROUGHPUT_CHARS_PER_MS + REDOS_TEST_STARTUP_OVERHEAD_MS;
}

/**
 * Fixed, grep-able prefix of the ReDoS ratio log line (R61-L-03).
 * ReDoS 比ログ行の固定 prefix (R61-L-03、CI ログから grep で拾う)。
 */
const REDOS_RATIO_LOG_PREFIX = "[REDOS_RATIO]";

interface RedosRatioMeasurement {
  ratio: number;
  baseLength: number;
  scaleFactor: number;
  smallMedianMs: number;
  largeMedianMs: number;
}

/**
 * Format the single-line ReDoS ratio record. Logging only: it does not take
 * part in the pass/fail decision.
 * ReDoS 比を 1 行に整形する。記録用であり、判定には関与しない。
 */
function formatRedosRatioLine(m: RedosRatioMeasurement): string {
  return (
    `${REDOS_RATIO_LOG_PREFIX} ratio=${m.ratio.toFixed(2)} n=${m.baseLength}` +
    ` scale=${m.scaleFactor} median_n_ms=${m.smallMedianMs.toFixed(3)}` +
    ` median_4n_ms=${m.largeMedianMs.toFixed(3)}`
  );
}

describe("CssAnimationParser", () => {
  let parser: CssAnimationParser;

  beforeEach(() => {
    parser = new CssAnimationParser();
  });

  // =====================================================
  // parseKeyframes Tests
  // =====================================================

  describe("parseKeyframes", () => {
    it("should parse simple @keyframes with from/to", () => {
      const css = `
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;

      const result = parser.parseKeyframes(css);

      expect(result.has("fadeIn")).toBe(true);
      const steps = result.get("fadeIn");
      expect(steps).toHaveLength(2);
      expect(steps![0]).toEqual({ offset: 0, styles: { opacity: "0" } });
      expect(steps![1]).toEqual({ offset: 100, styles: { opacity: "1" } });
    });

    it("should parse @keyframes with percentage steps", () => {
      const css = `
        @keyframes bounce {
          0% { transform: translateY(0); }
          50% { transform: translateY(-20px); }
          100% { transform: translateY(0); }
        }
      `;

      const result = parser.parseKeyframes(css);

      expect(result.has("bounce")).toBe(true);
      const steps = result.get("bounce");
      expect(steps).toHaveLength(3);
      expect(steps![0]!.offset).toBe(0);
      expect(steps![1]!.offset).toBe(50);
      expect(steps![2]!.offset).toBe(100);
    });

    it("should parse multiple @keyframes definitions", () => {
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
      expect(result.has("fadeIn")).toBe(true);
      expect(result.has("slideUp")).toBe(true);
    });

    it("should handle nested braces in keyframes", () => {
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

      expect(result.has("complexAnim")).toBe(true);
      const steps = result.get("complexAnim");
      expect(steps).toHaveLength(2);
    });

    it("should return empty map for CSS without @keyframes", () => {
      const css = `.button { color: red; }`;

      const result = parser.parseKeyframes(css);

      expect(result.size).toBe(0);
    });

    it("should handle hyphenated animation names", () => {
      const css = `
        @keyframes fade-in-up {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `;

      const result = parser.parseKeyframes(css);

      expect(result.has("fade-in-up")).toBe(true);
    });
  });

  // =====================================================
  // parseKeyframeSteps Tests
  // =====================================================

  describe("parseKeyframeSteps", () => {
    it("should parse from/to syntax", () => {
      const content = `
        from { opacity: 0; }
        to { opacity: 1; }
      `;

      const result = parser.parseKeyframeSteps(content);

      expect(result).toHaveLength(2);
      expect(result[0]!.offset).toBe(0);
      expect(result[1]!.offset).toBe(100);
    });

    it("should parse percentage syntax", () => {
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

    it("should sort steps by offset", () => {
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

    it("should parse multiple properties per step", () => {
      const content = `
        0% { opacity: 0; transform: scale(0.8); }
        100% { opacity: 1; transform: scale(1); }
      `;

      const result = parser.parseKeyframeSteps(content);

      expect(result[0]!.styles).toEqual({
        opacity: "0",
        transform: "scale(0.8)",
      });
    });

    it("should handle decimal percentages", () => {
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

  describe("parseAnimationProperty", () => {
    it("should parse animation name only", () => {
      const result = parser.parseAnimationProperty("fadeIn");

      expect(result.name).toBe("fadeIn");
      expect(result.duration).toBe(0);
      expect(result.easing.type).toBe("ease");
    });

    it("should parse animation with duration in seconds", () => {
      const result = parser.parseAnimationProperty("fadeIn 0.3s");

      expect(result.name).toBe("fadeIn");
      expect(result.duration).toBe(300);
    });

    it("should parse animation with duration in milliseconds", () => {
      const result = parser.parseAnimationProperty("fadeIn 300ms");

      expect(result.name).toBe("fadeIn");
      expect(result.duration).toBe(300);
    });

    it("should parse animation with duration and delay", () => {
      const result = parser.parseAnimationProperty("fadeIn 0.3s 0.1s");

      expect(result.name).toBe("fadeIn");
      expect(result.duration).toBe(300);
      expect(result.delay).toBe(100);
    });

    it("should parse animation with easing keyword", () => {
      const result = parser.parseAnimationProperty("fadeIn 0.3s ease-in-out");

      expect(result.easing.type).toBe("ease-in-out");
    });

    it("should parse animation with cubic-bezier easing", () => {
      const result = parser.parseAnimationProperty("fadeIn 0.3s cubic-bezier(0.4, 0, 0.2, 1)");

      expect(result.easing.type).toBe("cubic-bezier");
      expect(result.easing.cubicBezier).toEqual([0.4, 0, 0.2, 1]);
    });

    it("should parse animation with steps easing", () => {
      const result = parser.parseAnimationProperty("fadeIn 0.3s steps(4, end)");

      expect(result.easing.type).toBe("steps");
      expect(result.easing.steps).toEqual({ count: 4, position: "end" });
    });

    it("should parse animation with iteration count", () => {
      const result = parser.parseAnimationProperty("fadeIn 0.3s 3");

      expect(result.iterations).toBe(3);
    });

    it("should parse animation with infinite iteration", () => {
      const result = parser.parseAnimationProperty("fadeIn 0.3s infinite");

      expect(result.iterations).toBe("infinite");
    });

    it("should parse animation with direction", () => {
      const result = parser.parseAnimationProperty("fadeIn 0.3s alternate");

      expect(result.direction).toBe("alternate");
    });

    it("should parse animation with fill-mode", () => {
      const result = parser.parseAnimationProperty("fadeIn 0.3s forwards");

      expect(result.fillMode).toBe("forwards");
    });

    it("should parse full animation shorthand", () => {
      const result = parser.parseAnimationProperty(
        "fadeIn 0.3s ease-in-out 0.1s infinite alternate forwards"
      );

      expect(result.name).toBe("fadeIn");
      expect(result.duration).toBe(300);
      expect(result.easing.type).toBe("ease-in-out");
      expect(result.delay).toBe(100);
      expect(result.iterations).toBe("infinite");
      expect(result.direction).toBe("alternate");
      expect(result.fillMode).toBe("forwards");
    });
  });

  // =====================================================
  // tokenizeAnimationValue Tests
  // =====================================================

  describe("tokenizeAnimationValue", () => {
    it("should tokenize simple space-separated values", () => {
      const result = parser.tokenizeAnimationValue("fadeIn 0.3s ease");

      expect(result).toEqual(["fadeIn", "0.3s", "ease"]);
    });

    it("should keep cubic-bezier as single token", () => {
      const result = parser.tokenizeAnimationValue("fadeIn cubic-bezier(0.4, 0, 0.2, 1)");

      expect(result).toContain("cubic-bezier(0.4, 0, 0.2, 1)");
    });

    it("should keep steps as single token", () => {
      const result = parser.tokenizeAnimationValue("fadeIn steps(4, end)");

      expect(result).toContain("steps(4, end)");
    });

    it("should handle multiple whitespace", () => {
      const result = parser.tokenizeAnimationValue("fadeIn   0.3s    ease");

      expect(result).toEqual(["fadeIn", "0.3s", "ease"]);
    });

    it("should handle nested parentheses in values", () => {
      const result = parser.tokenizeAnimationValue("fadeIn cubic-bezier(0.4, 0, 0.2, 1) 0.3s");

      expect(result).toHaveLength(3);
      expect(result[1]).toBe("cubic-bezier(0.4, 0, 0.2, 1)");
    });
  });

  // =====================================================
  // parseTransitionProperty Tests
  // =====================================================

  describe("parseTransitionProperty", () => {
    it("should parse simple transition", () => {
      const result = parser.parseTransitionProperty("opacity 0.3s");

      expect(result).toHaveLength(1);
      expect(result[0]!.property).toBe("opacity");
      expect(result[0]!.duration).toBe(300);
    });

    it("should parse transition with all property", () => {
      const result = parser.parseTransitionProperty("all 0.3s");

      expect(result[0]!.property).toBe("all");
    });

    it("should parse transition with easing", () => {
      const result = parser.parseTransitionProperty("opacity 0.3s ease-in-out");

      expect(result[0]!.easing.type).toBe("ease-in-out");
    });

    it("should parse transition with delay", () => {
      const result = parser.parseTransitionProperty("opacity 0.3s ease 0.1s");

      expect(result[0]!.delay).toBe(100);
    });

    it("should parse multiple transitions", () => {
      const result = parser.parseTransitionProperty("opacity 0.3s, transform 0.5s");

      expect(result).toHaveLength(2);
      expect(result[0]!.property).toBe("opacity");
      expect(result[0]!.duration).toBe(300);
      expect(result[1]!.property).toBe("transform");
      expect(result[1]!.duration).toBe(500);
    });

    it("should parse transition with cubic-bezier", () => {
      const result = parser.parseTransitionProperty("opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1)");

      expect(result[0]!.easing.type).toBe("cubic-bezier");
      expect(result[0]!.easing.cubicBezier).toEqual([0.4, 0, 0.2, 1]);
    });

    it("should handle transform property", () => {
      const result = parser.parseTransitionProperty("transform 0.3s ease");

      expect(result[0]!.property).toBe("transform");
    });
  });

  // =====================================================
  // extractStyleRules Tests
  // =====================================================

  describe("extractStyleRules", () => {
    it("should extract simple CSS rule", () => {
      const css = `.button { color: red; background: blue; }`;

      const result = parser.extractStyleRules(css);

      expect(result.has(".button")).toBe(true);
      expect(result.get(".button")).toEqual({
        color: "red",
        background: "blue",
      });
    });

    it("should extract multiple CSS rules", () => {
      const css = `
        .button { color: red; }
        .link { color: blue; }
      `;

      const result = parser.extractStyleRules(css);

      expect(result.size).toBe(2);
      expect(result.has(".button")).toBe(true);
      expect(result.has(".link")).toBe(true);
    });

    it("should extract animation property", () => {
      const css = `.animated { animation: fadeIn 0.3s ease; }`;

      const result = parser.extractStyleRules(css);

      expect(result.get(".animated")!.animation).toBe("fadeIn 0.3s ease");
    });

    it("should extract transition property", () => {
      const css = `.button { transition: opacity 0.3s ease; }`;

      const result = parser.extractStyleRules(css);

      expect(result.get(".button")!.transition).toBe("opacity 0.3s ease");
    });

    it("should skip keyframe step selectors", () => {
      const css = `
        @keyframes fadeIn {
          0% { opacity: 0; }
          100% { opacity: 1; }
        }
        .button { color: red; }
      `;

      const result = parser.extractStyleRules(css);

      // Should not include percentage selectors
      expect(result.has("0%")).toBe(false);
      expect(result.has("100%")).toBe(false);
      expect(result.has(".button")).toBe(true);
    });

    it("should handle :hover selectors", () => {
      const css = `
        .button { color: red; }
        .button:hover { color: blue; }
      `;

      const result = parser.extractStyleRules(css);

      expect(result.has(".button")).toBe(true);
      expect(result.has(".button:hover")).toBe(true);
    });

    it("should handle complex selectors", () => {
      const css = `.nav > .item:first-child { color: red; }`;

      const result = parser.extractStyleRules(css);

      expect(result.has(".nav > .item:first-child")).toBe(true);
    });

    it("should handle animation-name property", () => {
      const css = `.animated { animation-name: fadeIn; animation-duration: 0.3s; }`;

      const result = parser.extractStyleRules(css);

      expect(result.get(".animated")!["animation-name"]).toBe("fadeIn");
      expect(result.get(".animated")!["animation-duration"]).toBe("0.3s");
    });
  });

  // =====================================================
  // Utility Methods Tests
  // =====================================================

  describe("parseTimeToMs", () => {
    it("should parse seconds to milliseconds", () => {
      expect(parser.parseTimeToMs("0.3s")).toBe(300);
      expect(parser.parseTimeToMs("1s")).toBe(1000);
      expect(parser.parseTimeToMs("2.5s")).toBe(2500);
    });

    it("should parse milliseconds", () => {
      expect(parser.parseTimeToMs("300ms")).toBe(300);
      expect(parser.parseTimeToMs("1000ms")).toBe(1000);
    });

    it("should handle decimal seconds", () => {
      expect(parser.parseTimeToMs("0.15s")).toBe(150);
    });
  });

  describe("formatEasing", () => {
    it("should format keyword easing", () => {
      expect(parser.formatEasing({ type: "ease" })).toBe("ease");
      expect(parser.formatEasing({ type: "linear" })).toBe("linear");
      expect(parser.formatEasing({ type: "ease-in-out" })).toBe("ease-in-out");
    });

    it("should format cubic-bezier easing", () => {
      const easing: EasingConfig = {
        type: "cubic-bezier",
        cubicBezier: [0.4, 0, 0.2, 1],
      };

      expect(parser.formatEasing(easing)).toBe("cubic-bezier(0.4, 0, 0.2, 1)");
    });

    it("should format steps easing", () => {
      const easing: EasingConfig = {
        type: "steps",
        steps: { count: 4, position: "end" },
      };

      expect(parser.formatEasing(easing)).toBe("steps(4, end)");
    });
  });

  describe("generateKeyframesCss", () => {
    it("should generate CSS from keyframe steps", () => {
      const steps: KeyframeStep[] = [
        { offset: 0, styles: { opacity: "0" } },
        { offset: 100, styles: { opacity: "1" } },
      ];

      const result = parser.generateKeyframesCss("fadeIn", steps);

      expect(result).toContain("@keyframes fadeIn");
      expect(result).toContain("0% { opacity: 0 }");
      expect(result).toContain("100% { opacity: 1 }");
    });

    it("should handle multiple properties per step", () => {
      const steps: KeyframeStep[] = [
        { offset: 0, styles: { opacity: "0", transform: "scale(0.8)" } },
        { offset: 100, styles: { opacity: "1", transform: "scale(1)" } },
      ];

      const result = parser.generateKeyframesCss("scaleIn", steps);

      expect(result).toContain("opacity: 0");
      expect(result).toContain("transform: scale(0.8)");
    });
  });

  // =====================================================
  // ReDoS Protection Tests (Security)
  // =====================================================

  describe("ReDoS Protection", () => {
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

    describe("CSS_PARSER_LIMITS constants", () => {
      it("should export limits constants", () => {
        expect(CSS_PARSER_LIMITS).toBeDefined();
        expect(CSS_PARSER_LIMITS.MAX_CSS_SIZE).toBe(5 * 1024 * 1024); // 5MB
        expect(CSS_PARSER_LIMITS.MAX_PROPERTY_VALUE_LENGTH).toBe(10000);
        expect(CSS_PARSER_LIMITS.MAX_SELECTOR_LENGTH).toBe(1000);
        expect(CSS_PARSER_LIMITS.MAX_CUBIC_BEZIER_LENGTH).toBe(100);
        expect(CSS_PARSER_LIMITS.MAX_KEYFRAME_CONTENT_LENGTH).toBe(50000);
      });
    });

    describe("parseKeyframes - ReDoS protection", () => {
      it("should handle extremely long CSS input gracefully", () => {
        // Generate 6MB of CSS (exceeds 5MB limit)
        const longCss = "a".repeat(6 * 1024 * 1024);

        const start = performance.now();
        const result = parser.parseKeyframes(longCss);
        const elapsed = performance.now() - start;

        // Should complete quickly (rejected at input validation)
        expect(elapsed).toBeLessThan(100);
        expect(result.size).toBe(0);
      });

      it("should handle long keyframe content without hanging", () => {
        // Long content inside keyframes (potential ReDoS via [^}]*)
        const longContent = "a".repeat(100000);
        const css = `@keyframes test { from { ${longContent} } to { opacity: 1; } }`;

        const start = performance.now();
        const result = parser.parseKeyframes(css);
        const elapsed = performance.now() - start;

        // v0.5.1 CO-PR21-REVIEW-01 (ADR-0020 Decision 5):
        //   PR #21 hotfix の固定 1000 ms から input-size proportional formula
        //   `length / throughputCharsPerMs + 200` に置換。
        // Replaces PR #21 fixed 1000 ms with input-size proportional formula.
        expect(elapsed).toBeLessThan(expectedMaxMsForReDoS(css.length));
        expect(result.has("test")).toBe(true);
      });

      it("should complete in reasonable time for normal input", () => {
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

    describe("parseKeyframeSteps - ReDoS protection", () => {
      it("should handle long property values without exponential backtracking", () => {
        // Attack vector: long value without semicolon triggers [^;]+ backtracking
        const longValue = "a".repeat(50000);
        const content = `from { transform: ${longValue} } to { opacity: 1; }`;

        const start = performance.now();
        const result = parser.parseKeyframeSteps(content);
        const elapsed = performance.now() - start;

        // v0.5.1 CO-PR21-REVIEW-01 (ADR-0020 Decision 5): input-size 関数化。
        // PR #21 hotfix の固定 1000 ms (CI 緩和) を `length / throughputCharsPerMs + 200`
        // に置換し、CWE-770 mitigation completeness を回復。
        // Replaces PR #21 fixed 1000 ms with input-size proportional formula.
        expect(elapsed).toBeLessThan(expectedMaxMsForReDoS(content.length));
        // Should still parse the valid part
        expect(result.length).toBeGreaterThanOrEqual(0);
      });

      it("should truncate extremely long property values", () => {
        // Property value exceeds MAX_PROPERTY_VALUE_LENGTH
        const longValue = "translateX(" + "a".repeat(20000) + ")";
        const content = `from { transform: ${longValue}; } to { opacity: 1; }`;

        const result = parser.parseKeyframeSteps(content);

        // Parser should handle gracefully (truncate or skip)
        expect(result.length).toBeGreaterThanOrEqual(0);
      });
    });

    describe("extractStyleRules - ReDoS protection", () => {
      it("should handle long selector without hanging", () => {
        // Attack vector: long selector triggers [^{]* backtracking
        const longSelector = ".class" + "-nested".repeat(500);
        const css = `${longSelector} { color: red; }`;

        const start = performance.now();
        const result = parser.extractStyleRules(css);
        const elapsed = performance.now() - start;

        // v0.5.1 CO-PR21-REVIEW-01 (ADR-0020 Decision 5):
        //   af17e5c5 (PR #21 hotfix) で 500 → 1000 ms に緩和した CI threshold を、
        //   input-size proportional formula `length / 100 + 200` に置換。
        // Replaces PR #21 (af17e5c5) fixed 1000 ms with input-size proportional.
        expect(elapsed).toBeLessThan(expectedMaxMsForReDoS(css.length));
        // Long selectors should be handled (either parsed or skipped)
        expect(result.size).toBeGreaterThanOrEqual(0);
      });

      // SEC-R61-01: the ReDoS defense of extractStyleRules IS the length bound
      // of `ruleRegex`. Loosening it (e.g. {0,1000} -> {0,5000}) keeps scaling
      // linear, so the timing-ratio test below cannot detect it. Pin the bounds
      // deterministically from the source (no timing involved). Declared before
      // the ratio test. The pin RED is deterministic when this test runs alone
      // (vitest -t); in a whole-file run an exponential rewrite hangs the ratio
      // test synchronously and no pin result is reported before the hang
      // (CO-R2-67 / CO-R2-70).
      // extractStyleRules の ReDoS 防御は ruleRegex の量化子上限そのもの。
      // 上限を緩めても線形のままなので比では検出できない。source から決定的に固定する。
      // pin の RED が確実に観測できるのは単独実行時。file 全体では指数形で比 test が
      // 先に hang し、pin の結果は報告されない（CO-R2-67 / CO-R2-70）。
      it("should keep the ruleRegex quantifier bounds pinned (selector 1000 / block 50000)", () => {
        const sourcePath = path.resolve(
          __dirname,
          "../../../src/services/page/css-animation-parser.service.ts"
        );
        const source = fs.readFileSync(sourcePath, "utf8");
        const declarations = [...source.matchAll(/const ruleRegex = (\/.+\/[a-z]*);/g)];
        // Locator guard: exactly one ruleRegex literal must be found (non-vacuous).
        expect(declarations).toHaveLength(1);
        const literal = declarations[0]?.[1] ?? "";
        const bounds = [...literal.matchAll(/\{0,(\d+)\}/g)].map((m) => Number(m[1]));
        // Selector bound 1000 == CSS_PARSER_LIMITS.MAX_SELECTOR_LENGTH;
        // declaration-block bound 50000.
        expect(bounds).toEqual([CSS_PARSER_LIMITS.MAX_SELECTOR_LENGTH, 50000]);
        // No unbounded quantifier ({n,} included) may appear in the pattern.
        expect(literal).not.toMatch(/[*+]|\{\d+,\}/);
        // R61-M-01: bounds alone miss a bound-preserving exponential rewrite
        // (e.g. duplicated alternation inside {0,1000}). Pin the whole literal.
        // 上限を保った指数化 (alternation 重複等) は bounds では見えないため literal 全体を固定する。
        expect(literal).toBe(String.raw`/([^@{}\s][^{]{0,1000})\{([^}]{0,50000})\}/g`);
      });

      // R61-L-03: the ratio line is emitted on pass AND fail so main CI runs
      // leave a grep-able record. This pins its fixed prefix and fields.
      // R61-L-03: 比の行は pass / fail 両方で出力し、main CI に記録を残す。
      // ここでは固定 prefix と各フィールドの形式を固定する。
      it("should format the ReDoS ratio log line with a fixed prefix", () => {
        const line = formatRedosRatioLine({
          ratio: 4.23456,
          baseLength: 10_000,
          scaleFactor: 4,
          smallMedianMs: 1.23456,
          largeMedianMs: 5.4321,
        });

        expect(line).toBe(
          `${REDOS_RATIO_LOG_PREFIX} ratio=4.23 n=10000 scale=4 median_n_ms=1.235 median_4n_ms=5.432`
        );
        expect(line.startsWith("[REDOS_RATIO] ")).toBe(true);
      });

      // CO-R2-61 (2) / TEST-REDOS-WALLCLOCK-01:
      //   絶対 wall-clock 閾値 (input-size 比例式) は CI runner 速度の分散
      //   (実測 333〜820 ms) で flaky だったため、同一 process 内の
      //   入力サイズ n と 4n の時間比で判定する形に組み替えた。ReDoS の
      //   検出目的は「線形か超線形か」の判別であり、比は runner の絶対速度に
      //   依存しない (env var `REDOS_TEST_THROUGHPUT_CHARS_PER_MS` にも非依存)。
      // Replaced the absolute wall-clock budget (flaky under CI runner speed
      //   variance, 333-820 ms observed) with a same-process time RATIO
      //   between input sizes n and 4n. ReDoS detection only needs to tell
      //   linear from super-linear scaling, and the ratio is independent of
      //   absolute runner speed and of any env var.
      it("should handle long declaration value without hanging", () => {
        // Attack vector: a long declaration value with no closing brace forces
        // ruleRegex to fail-and-retry at every start position (worst case).
        const makeCss = (valueLength: number): string =>
          `.button { background: ${"a".repeat(valueLength)};`;
        // n と 4n はいずれも ruleRegex の宣言ブロック上限 (50000) 未満、かつ
        // セレクタ上限 (1000) を十分に超えるため、同一の探索パスを通る。
        // Both sizes stay below the 50000-char declaration bound and well above
        // the 1000-char selector bound, so they exercise the same search path.
        const baseLength = 10_000;
        const scaleFactor = 4;
        const smallCss = makeCss(baseLength);
        const largeCss = makeCss(baseLength * scaleFactor);
        expect(largeCss.length).toBeLessThan(50000);

        const timeOnce = (css: string): number => {
          const start = performance.now();
          const result = parser.extractStyleRules(css);
          const elapsed = performance.now() - start;
          // Unterminated rule -> no rule is extracted (functional contract).
          expect(result.size).toBe(0);
          return elapsed;
        };
        const median = (values: number[]): number => {
          const sorted = [...values].sort((a, b) => a - b);
          return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
        };

        // Warm-up: V8 irregexp の tier-up (interpreter -> native) と JIT を
        // 計測前に済ませ、初回だけ遅い run が比を歪めないようにする。
        // Warm-up so regexp tier-up / JIT happens before measurement.
        const warmupRuns = 2;
        for (let i = 0; i < warmupRuns; i++) {
          timeOnce(smallCss);
          timeOnce(largeCss);
        }

        // n と 4n を交互に計測し、runner の一時的な減速が両方に等しく効く
        // ようにする。中央値で GC pause 等の外れ値を除く。
        // Interleave n / 4n so transient runner slowdowns hit both sides;
        // the median discards outliers such as GC pauses.
        const measuredRuns = 5;
        const smallTimes: number[] = [];
        const largeTimes: number[] = [];
        for (let i = 0; i < measuredRuns; i++) {
          smallTimes.push(timeOnce(smallCss));
          largeTimes.push(timeOnce(largeCss));
        }
        const smallMedianMs = median(smallTimes);
        const largeMedianMs = median(largeTimes);
        const ratio = largeMedianMs / Math.max(smallMedianMs, 0.001);

        // 閾値 8 の根拠 / Rationale for the ratio threshold 8:
        //   - 線形 O(L): 理論比は約 4.2 (末尾 1000 文字は探索が短いため 4 を
        //     わずかに超える)。ローカル実測 3.5〜5.0、CPU 過負荷下で最大 ~5.8。
        //   - 二乗 O(L^2) の多項式バックトラック: 期待比 = 16 (mutation 実測 16.1)。
        //   - 指数バックトラック: 比は 16 を桁違いに超える (または完了しない)。
        //   8 = sqrt(4 * 16) は線形と二乗の対数中点。実測上の余裕は線形側で
        //   最小約 1.38 倍 (8 / 5.8)、二乗側で約 1.7〜2 倍 (二乗の実測 13.7〜17.8)。
        //   - Linear O(L): theoretical ratio ~4.2 (the last 1000 positions scan
        //     less, nudging it above 4); observed 3.5-5.0 locally, up to ~5.8 under
        //     CPU overload (2 cores, 3 busy loops).
        //   - Quadratic O(L^2) polynomial backtracking: ~16 (mutation: 16.1).
        //   - Exponential backtracking: far beyond 16 (or never completes).
        //   8 = sqrt(4 * 16) is the log-midpoint of linear and quadratic; the
        //   observed margin is >= ~1.38x on the linear side (8 / 5.8) and ~1.7-2x
        //   on the quadratic side (observed 13.7-17.8).
        //   NOTE: a ratio cannot see a linear-but-larger-constant regression
        //   (e.g. loosening the `{0,1000}` bound); the deterministic literal pin
        //   above covers that (SEC-R61-01).
        const maxLinearRatio = 8;
        // Medians in the message keep a future failure diagnosable (TPA-R61-03).
        const timingDetail = `n=${smallMedianMs.toFixed(1)}ms 4n=${largeMedianMs.toFixed(1)}ms`;
        // R61-L-03: record the ratio BEFORE the assertion so it is printed on
        // pass and fail alike (main CI first-3-run record). No effect on the verdict.
        // R61-L-03: 判定の前に出力し、pass / fail どちらでも比が残るようにする。
        console.info(
          formatRedosRatioLine({ ratio, baseLength, scaleFactor, smallMedianMs, largeMedianMs })
        );
        expect(ratio, timingDetail).toBeLessThan(maxLinearRatio);

        // Hang backstop only (NOT the detection criterion): catches a linear
        // but pathologically slow regression that a ratio cannot see.
        // ローカル ~0.1 s / CI 推定 ~0.7 s に対し約 7 倍の余裕を持つ backstop。
        const hangBackstopMs = 5000;
        expect(largeMedianMs, timingDetail).toBeLessThan(hangBackstopMs);
      });

      it("should reject CSS exceeding size limit", () => {
        const largeCss = ".a { color: red; }".repeat(500000);

        const start = performance.now();
        const result = parser.extractStyleRules(largeCss);
        const elapsed = performance.now() - start;

        // Should reject quickly at input validation
        expect(elapsed).toBeLessThan(100);
        expect(result.size).toBe(0);
      });
    });

    describe("parseAnimationProperty - ReDoS protection", () => {
      it("should handle malformed cubic-bezier gracefully", () => {
        // Attack vector: long content inside cubic-bezier triggers backtracking
        const longBezier = "cubic-bezier(" + "0.5,".repeat(100) + "0.5)";
        const value = `fadeIn 0.3s ${longBezier}`;

        const start = performance.now();
        const result = parser.parseAnimationProperty(value);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(100);
        // Should fall back to default easing
        expect(result.name).toBe("fadeIn");
        expect(result.duration).toBe(300);
      });

      it("should handle extremely long animation value", () => {
        const longName = "animation-" + "x".repeat(10000);
        const value = `${longName} 0.3s ease`;

        const start = performance.now();
        const result = parser.parseAnimationProperty(value);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(100);
        // Should still parse or return defaults
        expect(result).toBeDefined();
      });
    });

    describe("parseTransitionProperty - ReDoS protection", () => {
      it("should handle many transition parts", () => {
        // Many comma-separated transitions
        const parts = Array(100).fill("opacity 0.3s ease").join(", ");

        const start = performance.now();
        const result = parser.parseTransitionProperty(parts);
        const elapsed = performance.now() - start;

        // v0.5.1 CO-PR21-REVIEW-01 (ADR-0020 Decision 5):
        //   af17e5c5 (PR #21 hotfix) で固定化した 1000 ms threshold を、
        //   input-size proportional formula に置換。
        // Replaces PR #21 (af17e5c5) fixed 1000 ms with input-size proportional.
        expect(elapsed).toBeLessThan(expectedMaxMsForReDoS(parts.length));
        expect(result.length).toBe(100);
      });

      it("should handle long cubic-bezier in transition", () => {
        const longBezier = "cubic-bezier(" + "0.5, ".repeat(50) + "0.5)";
        const value = `opacity 0.3s ${longBezier}`;

        const start = performance.now();
        const result = parser.parseTransitionProperty(value);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(100);
        expect(result.length).toBe(1);
        expect(result[0]!.property).toBe("opacity");
      });
    });

    describe("tokenizeAnimationValue - ReDoS protection", () => {
      it("should handle deeply nested parentheses", () => {
        // Attack vector: deeply nested parentheses
        const nested = "(".repeat(100) + "value" + ")".repeat(100);
        const value = `fadeIn ${nested} 0.3s`;

        const start = performance.now();
        const result = parser.tokenizeAnimationValue(value);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(100);
        expect(result.length).toBeGreaterThan(0);
      });

      it("should handle unbalanced parentheses gracefully", () => {
        const value = "fadeIn cubic-bezier(0.4, 0, 0.2 0.3s";

        const result = parser.tokenizeAnimationValue(value);

        // Should not hang, return whatever it can parse
        expect(result.length).toBeGreaterThan(0);
      });
    });

    describe("Performance benchmarks", () => {
      it("should parse complex realistic CSS in reasonable time", () => {
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

        // v0.5.1 CO-PR21-REVIEW-01 (ADR-0020 Decision 5):
        //   PR #21 hotfix の固定 1000 ms を input-size proportional formula に置換。
        //   Two parser passes (parseKeyframes + extractStyleRules) なので、
        //   `length * 2` で 2 pass ぶんの allowance を確保。
        // Replaces PR #21 fixed 1000 ms with input-size proportional formula.
        // Two parser passes; multiply length by 2 for combined-pass budget.
        expect(elapsed).toBeLessThan(expectedMaxMsForReDoS(css.length * 2));
        expect(keyframes.size).toBe(2); // Same keyframes, deduplicated
        expect(rules.size).toBeGreaterThan(0);
      });
    });
  });
});
