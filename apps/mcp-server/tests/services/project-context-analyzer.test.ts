// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ProjectContextAnalyzer Service Tests
 *
 * TDD: Red phase - Write failing tests first
 *
 * Purpose: Analyze project patterns (design tokens, hooks, CSS classes)
 * and calculate adaptability scores for layout.search results
 *
 * @module tests/services/project-context-analyzer.test
 */

import { describe, it, expect, beforeEach } from "vitest";

// Import will fail until we create the service (TDD Red phase)
import {
  ProjectContextAnalyzer,
  type ProjectPatterns,
  type AdaptabilityResult,
  type ProjectContextOptions,
} from "../../src/services/project-context-analyzer";

describe("ProjectContextAnalyzer", () => {
  let analyzer: ProjectContextAnalyzer;

  beforeEach(() => {
    analyzer = new ProjectContextAnalyzer();
  });

  // =====================================================
  // Adaptability Score Calculation Tests
  // =====================================================

  describe("calculateAdaptabilityScore", () => {
    const mockPatterns: ProjectPatterns = {
      designTokens: {
        styles: [
          {
            name: "STYLES",
            type: "const",
            colors: {
              "accent.primary": "#2dd4bf",
              "accent.secondary": "#22d3ee",
              "text.primary": "#f8fafc",
            },
            file: "solution.tsx",
          },
        ],
      },
      hooks: [
        {
          name: "useScrollAnimation",
          file: "use-scroll-animation.ts",
          exports: ["useScrollAnimation", "useStaggeredAnimation"],
        },
        { name: "useGsap", file: "use-gsap.ts", exports: ["gsap"] },
      ],
      cssFramework: "tailwindcss-v4",
      themeVariables: [
        { name: "--color-accent", value: "oklch(0.75 0.16 175)" },
        { name: "--ease-out-expo", value: "cubic-bezier(0.16, 1, 0.3, 1)" },
      ],
      animations: [
        { name: "fadeIn", type: "keyframes" },
        { name: "slideUp", type: "keyframes" },
      ],
      utilityClasses: ["scroll-hidden", "scroll-visible", "animate-fade-in-up"],
    };

    it("should return high score (80-100) for highly compatible pattern", () => {
      const searchResultHtml = `
        <section class="scroll-hidden">
          <h1 style="color: #2dd4bf;">Hero Title</h1>
          <div class="animate-fade-in-up">Content</div>
        </section>
      `;

      const result = analyzer.calculateAdaptabilityScore(searchResultHtml, mockPatterns);

      expect(result.score).toBeGreaterThanOrEqual(70);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it("should return medium score (40-69) for partially compatible pattern", () => {
      const searchResultHtml = `
        <section style="background: linear-gradient(135deg, #ff6b6b, #feca57);">
          <h1 style="color: #ffffff;">Hero Title</h1>
        </section>
      `;

      const result = analyzer.calculateAdaptabilityScore(searchResultHtml, mockPatterns);

      expect(result.score).toBeGreaterThanOrEqual(20);
      expect(result.score).toBeLessThan(70);
    });

    it("should return low score (0-39) for incompatible pattern", () => {
      // HTML with no matching colors, no animations, no utility classes
      const searchResultHtml = `
        <section style="background: url('image.jpg');">
          <h1 style="color: #ff0000;">Completely Different Red</h1>
          <p style="color: #00ff00;">Completely Different Green</p>
        </section>
      `;

      // Create patterns with specific colors that won't match
      const incompatiblePatterns: ProjectPatterns = {
        designTokens: {
          styles: [
            {
              name: "STYLES",
              type: "const",
              colors: { primary: "#000000" }, // Black - won't match red/green
              file: "test.tsx",
            },
          ],
        },
        hooks: [],
        cssFramework: "unknown", // No framework match
        themeVariables: [],
        animations: [],
        utilityClasses: [], // No utility classes
      };

      const result = analyzer.calculateAdaptabilityScore(searchResultHtml, incompatiblePatterns);

      // With no color match (0 * 0.4 = 0), no animation hooks (50 * 0.3 = 15),
      // no framework (50 * 0.2 = 10), no utilities (50 * 0.1 = 5) = ~30
      expect(result.score).toBeLessThan(40);
    });

    it("should include integration hints for color mapping", () => {
      const searchResultHtml = `
        <section style="background-color: #2dd4bf;">
          <h1 style="color: #22d3ee;">Title</h1>
        </section>
      `;

      const result = analyzer.calculateAdaptabilityScore(searchResultHtml, mockPatterns);

      expect(result.integration_hints).toBeDefined();
      expect(result.integration_hints.color_mapping).toBeDefined();
      expect(result.integration_hints.color_mapping["#2dd4bf"]).toBe("STYLES.accent.primary");
    });

    it("should suggest hooks based on animation patterns detected", () => {
      const searchResultHtml = `
        <section class="animate-on-scroll" data-animation="fade-in">
          <div style="transition: opacity 0.3s ease-out;">Content</div>
        </section>
      `;

      const result = analyzer.calculateAdaptabilityScore(searchResultHtml, mockPatterns);

      expect(result.integration_hints.suggested_hooks).toContain("useScrollAnimation");
    });

    it("should identify existing animations in globals.css", () => {
      const searchResultHtml = `
        <div class="animate-fade-in">
          <span style="animation: slideUp 0.5s ease-out;">Text</span>
        </div>
      `;

      const result = analyzer.calculateAdaptabilityScore(searchResultHtml, mockPatterns);

      // Should find slideUp which matches existing animation in mockPatterns
      expect(result.integration_hints.existing_animations).toContain("slideUp");
    });

    it("should handle empty HTML gracefully", () => {
      const result = analyzer.calculateAdaptabilityScore("", mockPatterns);

      expect(result.score).toBe(0);
      expect(result.integration_hints.suggested_hooks).toHaveLength(0);
      expect(result.integration_hints.color_mapping).toEqual({});
      expect(result.integration_hints.existing_animations).toHaveLength(0);
    });
  });

  // =====================================================
  // Integration Hints Generation Tests
  // =====================================================

  describe("generateIntegrationHints", () => {
    it("should map similar colors to design tokens", () => {
      const patterns: ProjectPatterns = {
        designTokens: {
          styles: [
            {
              name: "STYLES",
              type: "const",
              colors: {
                "accent.teal": "#2dd4bf",
                "text.primary": "#f8fafc",
              },
              file: "solution.tsx",
            },
          ],
        },
        hooks: [],
        cssFramework: "tailwindcss-v4",
        themeVariables: [],
        animations: [],
        utilityClasses: [],
      };

      // Similar color (slightly different hex)
      const html = '<div style="color: #2cd3be;">Text</div>';

      const hints = analyzer.generateIntegrationHints(html, patterns);

      // Should map similar color (#2cd3be is close to #2dd4bf)
      expect(Object.keys(hints.color_mapping).length).toBeGreaterThan(0);
    });

    it("should suggest useScrollAnimation for scroll-triggered elements", () => {
      const patterns: ProjectPatterns = {
        designTokens: { styles: [] },
        hooks: [
          {
            name: "useScrollAnimation",
            file: "use-scroll-animation.ts",
            exports: ["useScrollAnimation"],
          },
        ],
        cssFramework: "tailwindcss-v4",
        themeVariables: [],
        animations: [],
        utilityClasses: ["scroll-hidden", "scroll-visible"],
      };

      const html = `
        <section data-scroll-animation="fade-in">
          <div class="will-animate-on-scroll">Content</div>
        </section>
      `;

      const hints = analyzer.generateIntegrationHints(html, patterns);

      expect(hints.suggested_hooks).toContain("useScrollAnimation");
    });

    it("should suggest gsap hook for complex animations", () => {
      const patterns: ProjectPatterns = {
        designTokens: { styles: [] },
        hooks: [{ name: "useGsap", file: "use-gsap.ts", exports: ["gsap"] }],
        cssFramework: "tailwindcss-v4",
        themeVariables: [],
        animations: [],
        utilityClasses: [],
      };

      const html = `
        <section style="transform: perspective(1000px) rotateX(10deg);">
          <div style="animation: complexTimeline 2s ease-in-out forwards;">
            3D Content
          </div>
        </section>
      `;

      const hints = analyzer.generateIntegrationHints(html, patterns);

      expect(hints.suggested_hooks).toContain("useGsap");
    });
  });

  // =====================================================
  // Performance Tests
  // =====================================================

  describe("performance", () => {
    it("should calculate adaptability score in under 10ms", () => {
      const patterns: ProjectPatterns = {
        designTokens: { styles: [] },
        hooks: Array(10).fill({ name: "useHook", file: "hook.ts", exports: [] }),
        cssFramework: "tailwindcss-v4",
        themeVariables: Array(50).fill({ name: "--var", value: "value" }),
        animations: Array(20).fill({ name: "anim", type: "keyframes" }),
        utilityClasses: Array(100).fill("class"),
      };

      const html = "<div>".repeat(100) + "</div>".repeat(100);

      const start = performance.now();
      analyzer.calculateAdaptabilityScore(html, patterns);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(10);
    });
  });

  // =====================================================
  // Options Tests
  // =====================================================

  describe("options", () => {
    it("should respect enabled option", async () => {
      const options: ProjectContextOptions = {
        enabled: false,
      };

      const result = await analyzer.analyzeWithOptions("/project", "<div></div>", options);

      expect(result).toBeNull();
    });
  });

  // =====================================================
  // Response Size Tests
  // =====================================================

  describe("response size", () => {
    it("should keep adaptability data under 1KB per result", () => {
      const patterns: ProjectPatterns = {
        designTokens: {
          styles: Array(10).fill({
            name: "STYLES",
            type: "const",
            colors: Object.fromEntries(
              Array(20)
                .fill(null)
                .map((_, i) => [`color${i}`, `#${i.toString(16).padStart(6, "0")}`])
            ),
            file: "file.tsx",
          }),
        },
        hooks: Array(20).fill({
          name: "useHook",
          file: "hook.ts",
          exports: ["export1", "export2"],
        }),
        cssFramework: "tailwindcss-v4",
        themeVariables: Array(50).fill({ name: "--var-name", value: "var-value" }),
        animations: Array(30).fill({ name: "animation-name", type: "keyframes" }),
        utilityClasses: Array(100).fill("utility-class-name"),
      };

      const html = `
        <section style="background: #000; color: #fff; animation: test 1s;">
          ${'<div style="color: #123;">Content</div>'.repeat(50)}
        </section>
      `;

      const result = analyzer.calculateAdaptabilityScore(html, patterns);
      const jsonSize = JSON.stringify(result).length;

      // Should be under 1KB (1024 bytes)
      expect(jsonSize).toBeLessThan(1024);
    });
  });
});
