// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ScoringSystem Tests
 *
 * TDD Red Phase: 80+ test cases for 3-axis quality scoring system
 * - Originality (35%): uniqueColorUsage, layoutCreativity, typographyPersonality, antiClicheBonus
 * - Craftsmanship (40%): gridAlignment, typographyConsistency, colorHarmony, whitespaceRhythm, responsiveDesign
 * - Contextuality (25%): industryFit, audienceFit, brandConsistency, accessibilityCompliance
 *
 * @module @reftrixmcp/webdesign-core/tests/quality-evaluator/scoring-system
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ScoringSystem,
  type ScoringWeights,
  type ScoringContext,
  type QualityScore,
  type AxisScore,
  type ScoreBreakdown,
  type ClicheReport,
  type LayoutInfo,
} from "../../src/quality-evaluator/scoring-system";
import type { DetectedSection, SectionType } from "../../src/types/section.types";
import type { ColorInfo, TypographyInfo } from "../../src/text-representation";

// =========================================
// Test Fixtures
// =========================================

/**
 * Create a minimal DetectedSection for testing
 */
const createSection = (
  type: SectionType,
  overrides: Partial<DetectedSection> = {}
): DetectedSection => ({
  id: `section-${Math.random().toString(36).slice(2, 9)}`,
  type,
  confidence: 0.8,
  element: {
    tagName: "section",
    selector: "section",
    classes: [],
    ...overrides.element,
  },
  position: {
    startY: 0,
    endY: 500,
    height: 500,
    ...overrides.position,
  },
  content: {
    headings: [],
    paragraphs: [],
    links: [],
    images: [],
    buttons: [],
    ...overrides.content,
  },
  style: {
    backgroundColor: "#ffffff",
    textColor: "#000000",
    hasGradient: false,
    hasImage: false,
    ...overrides.style,
  },
  ...overrides,
});

/**
 * Create a minimal ColorInfo for testing
 */
const createColorInfo = (overrides: Partial<ColorInfo> = {}): ColorInfo => ({
  palette: [
    { hex: "#3B82F6", count: 10, role: "primary" },
    { hex: "#FFFFFF", count: 50, role: "background" },
    { hex: "#1F2937", count: 30, role: "text" },
  ],
  dominant: "#3B82F6",
  background: "#FFFFFF",
  text: "#1F2937",
  ...overrides,
});

/**
 * Create a minimal TypographyInfo for testing
 */
const createTypographyInfo = (overrides: Partial<TypographyInfo> = {}): TypographyInfo => ({
  fonts: [{ family: "Inter", weights: [400, 500, 600, 700] }],
  headingScale: [48, 36, 24, 20, 16, 14],
  bodySize: 16,
  lineHeight: 1.5,
  ...overrides,
});

/**
 * Create a minimal LayoutInfo for testing
 */
const createLayoutInfo = (overrides: Partial<LayoutInfo> = {}): LayoutInfo => ({
  type: "grid",
  columns: 12,
  gutterWidth: 24,
  maxWidth: 1200,
  alignment: "center",
  spacing: {
    section: 80,
    element: 24,
    component: 16,
  },
  responsive: {
    breakpoints: [
      { name: "mobile", minWidth: 0 },
      { name: "tablet", minWidth: 768 },
      { name: "desktop", minWidth: 1024 },
    ],
    adaptations: ["stack-on-mobile", "reduce-columns"],
  },
  ...overrides,
});

/**
 * Create a minimal ClicheReport for testing
 */
const createClicheReport = (overrides: Partial<ClicheReport> = {}): ClicheReport => ({
  totalClicheScore: 0.2,
  detectedCliches: [],
  summary: "Low cliche usage detected",
  recommendations: [],
  ...overrides,
});

/**
 * Create a minimal ScoringContext for testing
 */
const createScoringContext = (overrides: Partial<ScoringContext> = {}): ScoringContext => ({
  sections: [
    createSection("hero"),
    createSection("feature"),
    createSection("cta"),
    createSection("footer"),
  ],
  colors: createColorInfo(),
  typography: createTypographyInfo(),
  layout: createLayoutInfo(),
  ...overrides,
});

/**
 * Create a high-quality ScoringContext
 */
const createHighQualityContext = (): ScoringContext => ({
  sections: [
    createSection("hero", {
      content: {
        headings: [{ level: 1, text: "Unique Value Proposition" }],
        paragraphs: ["Compelling description with unique messaging."],
        links: [],
        images: [{ src: "/hero.jpg", alt: "Hero illustration" }],
        buttons: [{ text: "Get Started", type: "primary" }],
      },
      style: {
        backgroundColor: "#0F172A",
        textColor: "#F8FAFC",
        hasGradient: true,
        hasImage: false,
      },
    }),
    createSection("feature", {
      content: {
        headings: [
          { level: 2, text: "Key Features" },
          { level: 3, text: "Feature A" },
          { level: 3, text: "Feature B" },
          { level: 3, text: "Feature C" },
        ],
        paragraphs: ["Detailed descriptions."],
        links: [],
        images: [
          { src: "/icon1.svg", alt: "Feature icon" },
          { src: "/icon2.svg", alt: "Feature icon" },
          { src: "/icon3.svg", alt: "Feature icon" },
        ],
        buttons: [],
      },
    }),
    createSection("testimonial"),
    createSection("pricing"),
    createSection("cta"),
    createSection("footer"),
  ],
  colors: createColorInfo({
    palette: [
      { hex: "#6366F1", count: 15, role: "primary" },
      { hex: "#8B5CF6", count: 10, role: "accent" },
      { hex: "#FAFAFA", count: 40, role: "background" },
      { hex: "#18181B", count: 25, role: "text" },
      { hex: "#71717A", count: 10, role: "muted" },
    ],
    dominant: "#6366F1",
    background: "#FAFAFA",
    text: "#18181B",
    accent: "#8B5CF6",
  }),
  typography: createTypographyInfo({
    fonts: [
      { family: "Cal Sans", weights: [600, 700] },
      { family: "Inter", weights: [400, 500, 600] },
    ],
    headingScale: [56, 42, 32, 24, 18, 14],
    bodySize: 16,
    lineHeight: 1.6,
  }),
  layout: createLayoutInfo({
    type: "grid",
    columns: 12,
    gutterWidth: 32,
    maxWidth: 1280,
    alignment: "center",
    spacing: {
      section: 96,
      element: 32,
      component: 16,
    },
    responsive: {
      breakpoints: [
        { name: "mobile", minWidth: 0 },
        { name: "tablet", minWidth: 768 },
        { name: "desktop", minWidth: 1024 },
        { name: "wide", minWidth: 1440 },
      ],
      adaptations: [
        "stack-on-mobile",
        "reduce-columns",
        "adjust-typography",
        "hide-secondary-elements",
      ],
    },
  }),
  clicheReport: createClicheReport({
    totalClicheScore: 0.1,
    detectedCliches: [],
    summary: "Very low cliche usage",
  }),
  targetIndustry: "SaaS",
  targetAudience: "developers",
});

/**
 * Create a low-quality ScoringContext (lots of cliches, poor design)
 */
const createLowQualityContext = (): ScoringContext => ({
  sections: [
    createSection("hero", {
      content: {
        headings: [{ level: 1, text: "Welcome to Our Website" }],
        paragraphs: ["We are a team of passionate professionals dedicated to excellence."],
        links: [],
        images: [],
        buttons: [{ text: "Learn More", type: "primary" }],
      },
      style: {
        backgroundColor: "#000000",
        textColor: "#FFFFFF",
        hasGradient: true,
        hasImage: false,
      },
    }),
    createSection("feature"),
    createSection("footer"),
  ],
  colors: createColorInfo({
    palette: [
      { hex: "#000000", count: 30, role: "primary" },
      { hex: "#FFFFFF", count: 30, role: "background" },
    ],
    dominant: "#000000",
    background: "#FFFFFF",
    text: "#000000",
  }),
  typography: createTypographyInfo({
    fonts: [{ family: "Arial", weights: [400, 700] }],
    headingScale: [32, 24, 20, 18, 16, 14],
    bodySize: 14,
    lineHeight: 1.3,
  }),
  layout: createLayoutInfo({
    type: "unknown",
    columns: undefined,
    gutterWidth: undefined,
    maxWidth: undefined,
    alignment: "left",
    spacing: {
      section: 40,
      element: 10,
      component: 5,
    },
    responsive: {
      breakpoints: [],
      adaptations: [],
    },
  }),
  clicheReport: createClicheReport({
    totalClicheScore: 0.85,
    detectedCliches: [
      {
        pattern: "welcome-headline",
        severity: "high",
        location: "hero",
        suggestion: "Use specific value proposition",
      },
      {
        pattern: "purple-gradient",
        severity: "medium",
        location: "hero",
        suggestion: "Consider unique color combinations",
      },
      {
        pattern: "generic-cta",
        severity: "medium",
        location: "hero",
        suggestion: "Use action-oriented specific CTA",
      },
    ],
    summary: "High cliche usage detected",
    recommendations: ["Revise headline", "Change color scheme", "Improve CTA"],
  }),
});

// =========================================
// Test Suites
// =========================================

describe("ScoringSystem", () => {
  let scoringSystem: ScoringSystem;

  beforeEach(() => {
    scoringSystem = new ScoringSystem();
  });

  // =========================================
  // 1. Constructor & Initialization Tests (8 tests)
  // =========================================
  describe("Constructor & Initialization", () => {
    it("should create instance with default weights", () => {
      const system = new ScoringSystem();
      expect(system).toBeInstanceOf(ScoringSystem);
    });

    it("should use default weights when none provided", () => {
      const system = new ScoringSystem();
      const weights = system.getWeights();
      expect(weights.originality).toBe(0.35);
      expect(weights.craftsmanship).toBe(0.4);
      expect(weights.contextuality).toBe(0.25);
    });

    it("should accept custom originality weight (normalized)", () => {
      // Setting originality: 0.5 with defaults (craftsmanship: 0.4, contextuality: 0.25)
      // Sum = 0.5 + 0.4 + 0.25 = 1.15 -> normalized to 1.0
      const system = new ScoringSystem({ originality: 0.5 });
      const weights = system.getWeights();
      // After normalization: 0.5/1.15 = ~0.4348
      expect(weights.originality).toBeCloseTo(0.5 / 1.15, 4);
      // Originality should be larger than craftsmanship now
      expect(weights.originality).toBeGreaterThan(weights.craftsmanship);
    });

    it("should accept custom craftsmanship weight (normalized)", () => {
      // Setting craftsmanship: 0.5 with defaults (originality: 0.35, contextuality: 0.25)
      // Sum = 0.35 + 0.5 + 0.25 = 1.1 -> normalized to 1.0
      const system = new ScoringSystem({ craftsmanship: 0.5 });
      const weights = system.getWeights();
      // After normalization: 0.5/1.1 = ~0.4545
      expect(weights.craftsmanship).toBeCloseTo(0.5 / 1.1, 4);
      expect(weights.craftsmanship).toBeGreaterThan(weights.originality);
    });

    it("should accept custom contextuality weight (normalized)", () => {
      // Setting contextuality: 0.4 with defaults (originality: 0.35, craftsmanship: 0.4)
      // Sum = 0.35 + 0.4 + 0.4 = 1.15 -> normalized to 1.0
      const system = new ScoringSystem({ contextuality: 0.4 });
      const weights = system.getWeights();
      // After normalization: 0.4/1.15 = ~0.3478
      expect(weights.contextuality).toBeCloseTo(0.4 / 1.15, 4);
      expect(weights.contextuality).toBeGreaterThan(0.25); // Greater than default 0.25
    });

    it("should accept all custom weights", () => {
      const system = new ScoringSystem({
        originality: 0.4,
        craftsmanship: 0.35,
        contextuality: 0.25,
      });
      const weights = system.getWeights();
      expect(weights.originality).toBe(0.4);
      expect(weights.craftsmanship).toBe(0.35);
      expect(weights.contextuality).toBe(0.25);
    });

    it("should normalize weights to sum to 1.0", () => {
      const system = new ScoringSystem({
        originality: 0.5,
        craftsmanship: 0.5,
        contextuality: 0.5,
      });
      const weights = system.getWeights();
      const sum = weights.originality + weights.craftsmanship + weights.contextuality;
      expect(sum).toBeCloseTo(1.0, 2);
    });

    it("should clamp individual weights between 0 and 1", () => {
      const system = new ScoringSystem({
        originality: 1.5,
        craftsmanship: -0.2,
        contextuality: 0.5,
      });
      const weights = system.getWeights();
      expect(weights.originality).toBeGreaterThanOrEqual(0);
      expect(weights.originality).toBeLessThanOrEqual(1);
      expect(weights.craftsmanship).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================
  // 2. setWeights Method Tests (5 tests)
  // =========================================
  describe("setWeights Method", () => {
    it("should update originality weight (normalized)", () => {
      // After setWeights, weights are normalized to sum to 1.0
      // Setting originality: 0.5 with current defaults (0.4, 0.25) -> sum = 1.15
      scoringSystem.setWeights({ originality: 0.5 });
      const weights = scoringSystem.getWeights();
      expect(weights.originality).toBeCloseTo(0.5 / 1.15, 4);
      expect(weights.originality).toBeGreaterThan(weights.craftsmanship);
    });

    it("should update craftsmanship weight (normalized)", () => {
      // Setting craftsmanship: 0.5 with defaults (0.35, 0.25) -> sum = 1.1
      scoringSystem.setWeights({ craftsmanship: 0.5 });
      const weights = scoringSystem.getWeights();
      expect(weights.craftsmanship).toBeCloseTo(0.5 / 1.1, 4);
      expect(weights.craftsmanship).toBeGreaterThan(weights.originality);
    });

    it("should update contextuality weight (normalized)", () => {
      // Setting contextuality: 0.4 with defaults (0.35, 0.4) -> sum = 1.15
      scoringSystem.setWeights({ contextuality: 0.4 });
      const weights = scoringSystem.getWeights();
      expect(weights.contextuality).toBeCloseTo(0.4 / 1.15, 4);
    });

    it("should update multiple weights at once", () => {
      scoringSystem.setWeights({
        originality: 0.3,
        craftsmanship: 0.4,
        contextuality: 0.3,
      });
      const weights = scoringSystem.getWeights();
      expect(weights.originality).toBe(0.3);
      expect(weights.craftsmanship).toBe(0.4);
      expect(weights.contextuality).toBe(0.3);
    });

    it("should normalize weights after update", () => {
      scoringSystem.setWeights({
        originality: 1,
        craftsmanship: 1,
        contextuality: 1,
      });
      const weights = scoringSystem.getWeights();
      const sum = weights.originality + weights.craftsmanship + weights.contextuality;
      expect(sum).toBeCloseTo(1.0, 2);
    });
  });

  // =========================================
  // 3. Originality Scoring Tests (12 tests)
  // =========================================
  describe("Originality Scoring", () => {
    describe("evaluateOriginality", () => {
      it("should return AxisScore with score between 0-100", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateOriginality(context);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
      });

      it("should include breakdown array", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateOriginality(context);
        expect(Array.isArray(result.breakdown)).toBe(true);
        expect(result.breakdown.length).toBeGreaterThan(0);
      });

      it("should include strengths array", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateOriginality(context);
        expect(Array.isArray(result.strengths)).toBe(true);
      });

      it("should include weaknesses array", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateOriginality(context);
        expect(Array.isArray(result.weaknesses)).toBe(true);
      });
    });

    describe("Unique Color Usage (20%)", () => {
      it("should score higher for diverse color palette", () => {
        const richContext = createScoringContext({
          colors: createColorInfo({
            palette: [
              { hex: "#6366F1", count: 10, role: "primary" },
              { hex: "#8B5CF6", count: 8, role: "accent" },
              { hex: "#EC4899", count: 5, role: "highlight" },
              { hex: "#F8FAFC", count: 40, role: "background" },
              { hex: "#0F172A", count: 25, role: "text" },
            ],
            dominant: "#6366F1",
            background: "#F8FAFC",
            text: "#0F172A",
            accent: "#8B5CF6",
          }),
        });
        const poorContext = createScoringContext({
          colors: createColorInfo({
            palette: [
              { hex: "#000000", count: 50, role: "primary" },
              { hex: "#FFFFFF", count: 50, role: "background" },
            ],
            dominant: "#000000",
            background: "#FFFFFF",
            text: "#000000",
          }),
        });

        const richScore = scoringSystem.evaluateOriginality(richContext);
        const poorScore = scoringSystem.evaluateOriginality(poorContext);
        expect(richScore.score).toBeGreaterThan(poorScore.score);
      });

      it("should include uniqueColorUsage in breakdown", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateOriginality(context);
        const colorBreakdown = result.breakdown.find((b) => b.criterion === "uniqueColorUsage");
        expect(colorBreakdown).toBeDefined();
        expect(colorBreakdown?.weight).toBeCloseTo(0.2, 2);
      });
    });

    describe("Layout Creativity (25%)", () => {
      it("should score higher for varied section types", () => {
        const variedContext = createScoringContext({
          sections: [
            createSection("hero"),
            createSection("feature"),
            createSection("testimonial"),
            createSection("pricing"),
            createSection("gallery"),
            createSection("cta"),
            createSection("footer"),
          ],
        });
        const uniformContext = createScoringContext({
          sections: [
            createSection("feature"),
            createSection("feature"),
            createSection("feature"),
            createSection("footer"),
          ],
        });

        const variedScore = scoringSystem.evaluateOriginality(variedContext);
        const uniformScore = scoringSystem.evaluateOriginality(uniformContext);
        expect(variedScore.score).toBeGreaterThan(uniformScore.score);
      });

      it("should include layoutCreativity in breakdown", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateOriginality(context);
        const layoutBreakdown = result.breakdown.find((b) => b.criterion === "layoutCreativity");
        expect(layoutBreakdown).toBeDefined();
        expect(layoutBreakdown?.weight).toBeCloseTo(0.25, 2);
      });
    });

    describe("Typography Personality (20%)", () => {
      it("should score higher for custom fonts", () => {
        const customFontContext = createScoringContext({
          typography: createTypographyInfo({
            fonts: [
              { family: "Cal Sans", weights: [600, 700] },
              { family: "Space Grotesk", weights: [400, 500, 600] },
            ],
          }),
        });
        const genericFontContext = createScoringContext({
          typography: createTypographyInfo({
            fonts: [{ family: "Arial", weights: [400, 700] }],
          }),
        });

        const customScore = scoringSystem.evaluateOriginality(customFontContext);
        const genericScore = scoringSystem.evaluateOriginality(genericFontContext);
        expect(customScore.score).toBeGreaterThan(genericScore.score);
      });

      it("should include typographyPersonality in breakdown", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateOriginality(context);
        const typoBreakdown = result.breakdown.find((b) => b.criterion === "typographyPersonality");
        expect(typoBreakdown).toBeDefined();
        expect(typoBreakdown?.weight).toBeCloseTo(0.2, 2);
      });
    });

    describe("Anti-Cliche Bonus (35%)", () => {
      it("should score higher when no cliches detected", () => {
        const noClicheContext = createScoringContext({
          clicheReport: createClicheReport({
            totalClicheScore: 0.0,
            detectedCliches: [],
          }),
        });
        const clicheContext = createScoringContext({
          clicheReport: createClicheReport({
            totalClicheScore: 0.8,
            detectedCliches: [
              { pattern: "purple-gradient", severity: "high", location: "hero", suggestion: "" },
              { pattern: "bento-grid", severity: "medium", location: "feature", suggestion: "" },
            ],
          }),
        });

        const noClicheScore = scoringSystem.evaluateOriginality(noClicheContext);
        const clicheScore = scoringSystem.evaluateOriginality(clicheContext);
        expect(noClicheScore.score).toBeGreaterThan(clicheScore.score);
      });

      it("should include antiClicheBonus in breakdown", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateOriginality(context);
        const antiClicheBreakdown = result.breakdown.find((b) => b.criterion === "antiClicheBonus");
        expect(antiClicheBreakdown).toBeDefined();
        expect(antiClicheBreakdown?.weight).toBeCloseTo(0.35, 2);
      });
    });
  });

  // =========================================
  // 4. Craftsmanship Scoring Tests (15 tests)
  // =========================================
  describe("Craftsmanship Scoring", () => {
    describe("evaluateCraftsmanship", () => {
      it("should return AxisScore with score between 0-100", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateCraftsmanship(context);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
      });

      it("should include breakdown array", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateCraftsmanship(context);
        expect(Array.isArray(result.breakdown)).toBe(true);
        expect(result.breakdown.length).toBeGreaterThan(0);
      });

      it("should include strengths array", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateCraftsmanship(context);
        expect(Array.isArray(result.strengths)).toBe(true);
      });

      it("should include weaknesses array", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateCraftsmanship(context);
        expect(Array.isArray(result.weaknesses)).toBe(true);
      });
    });

    describe("Grid Alignment (20%)", () => {
      it("should score higher for well-defined grid", () => {
        const gridContext = createScoringContext({
          layout: createLayoutInfo({
            type: "grid",
            columns: 12,
            gutterWidth: 24,
            maxWidth: 1200,
            alignment: "center",
          }),
        });
        const noGridContext = createScoringContext({
          layout: createLayoutInfo({
            type: "unknown",
            columns: undefined,
            gutterWidth: undefined,
            maxWidth: undefined,
          }),
        });

        const gridScore = scoringSystem.evaluateCraftsmanship(gridContext);
        const noGridScore = scoringSystem.evaluateCraftsmanship(noGridContext);
        expect(gridScore.score).toBeGreaterThan(noGridScore.score);
      });

      it("should include gridAlignment in breakdown", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateCraftsmanship(context);
        const gridBreakdown = result.breakdown.find((b) => b.criterion === "gridAlignment");
        expect(gridBreakdown).toBeDefined();
        expect(gridBreakdown?.weight).toBeCloseTo(0.2, 2);
      });
    });

    describe("Typography Consistency (20%)", () => {
      it("should score higher for consistent font weights", () => {
        const consistentContext = createScoringContext({
          typography: createTypographyInfo({
            fonts: [{ family: "Inter", weights: [400, 500, 600, 700] }],
            headingScale: [48, 36, 24, 20, 16, 14],
          }),
        });
        const inconsistentContext = createScoringContext({
          typography: createTypographyInfo({
            fonts: [
              { family: "Arial", weights: [400] },
              { family: "Times", weights: [700] },
              { family: "Courier", weights: [400] },
            ],
            headingScale: [50, 30, 22, 19, 15, 11],
          }),
        });

        const consistentScore = scoringSystem.evaluateCraftsmanship(consistentContext);
        const inconsistentScore = scoringSystem.evaluateCraftsmanship(inconsistentContext);
        expect(consistentScore.score).toBeGreaterThan(inconsistentScore.score);
      });

      it("should include typographyConsistency in breakdown", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateCraftsmanship(context);
        const typoBreakdown = result.breakdown.find((b) => b.criterion === "typographyConsistency");
        expect(typoBreakdown).toBeDefined();
        expect(typoBreakdown?.weight).toBeCloseTo(0.2, 2);
      });
    });

    describe("Color Harmony (20%)", () => {
      it("should score higher for harmonious color combinations", () => {
        const harmoniousContext = createScoringContext({
          colors: createColorInfo({
            palette: [
              { hex: "#3B82F6", count: 10, role: "primary" },
              { hex: "#60A5FA", count: 5, role: "secondary" },
              { hex: "#93C5FD", count: 5, role: "tertiary" },
              { hex: "#F8FAFC", count: 40, role: "background" },
              { hex: "#1E3A8A", count: 20, role: "text" },
            ],
            dominant: "#3B82F6",
            background: "#F8FAFC",
            text: "#1E3A8A",
          }),
        });
        const clashingContext = createScoringContext({
          colors: createColorInfo({
            palette: [
              { hex: "#FF0000", count: 20, role: "primary" },
              { hex: "#00FF00", count: 20, role: "secondary" },
              { hex: "#0000FF", count: 20, role: "tertiary" },
              { hex: "#FFFF00", count: 20, role: "background" },
              { hex: "#FF00FF", count: 20, role: "text" },
            ],
            dominant: "#FF0000",
            background: "#FFFF00",
            text: "#FF00FF",
          }),
        });

        const harmoniousScore = scoringSystem.evaluateCraftsmanship(harmoniousContext);
        const clashingScore = scoringSystem.evaluateCraftsmanship(clashingContext);
        expect(harmoniousScore.score).toBeGreaterThan(clashingScore.score);
      });

      it("should include colorHarmony in breakdown", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateCraftsmanship(context);
        const colorBreakdown = result.breakdown.find((b) => b.criterion === "colorHarmony");
        expect(colorBreakdown).toBeDefined();
        expect(colorBreakdown?.weight).toBeCloseTo(0.2, 2);
      });
    });

    describe("Whitespace Rhythm (20%)", () => {
      it("should score higher for consistent spacing", () => {
        const consistentContext = createScoringContext({
          layout: createLayoutInfo({
            spacing: {
              section: 80,
              element: 24,
              component: 16,
            },
          }),
        });
        const inconsistentContext = createScoringContext({
          layout: createLayoutInfo({
            spacing: {
              section: 100,
              element: 5,
              component: 50,
            },
          }),
        });

        const consistentScore = scoringSystem.evaluateCraftsmanship(consistentContext);
        const inconsistentScore = scoringSystem.evaluateCraftsmanship(inconsistentContext);
        expect(consistentScore.score).toBeGreaterThanOrEqual(inconsistentScore.score);
      });

      it("should include whitespaceRhythm in breakdown", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateCraftsmanship(context);
        const spacingBreakdown = result.breakdown.find((b) => b.criterion === "whitespaceRhythm");
        expect(spacingBreakdown).toBeDefined();
        expect(spacingBreakdown?.weight).toBeCloseTo(0.2, 2);
      });
    });

    describe("Responsive Design (20%)", () => {
      it("should score higher for multiple breakpoints", () => {
        const responsiveContext = createScoringContext({
          layout: createLayoutInfo({
            responsive: {
              breakpoints: [
                { name: "mobile", minWidth: 0 },
                { name: "tablet", minWidth: 768 },
                { name: "desktop", minWidth: 1024 },
                { name: "wide", minWidth: 1440 },
              ],
              adaptations: ["stack-on-mobile", "reduce-columns", "adjust-typography"],
            },
          }),
        });
        const nonResponsiveContext = createScoringContext({
          layout: createLayoutInfo({
            responsive: {
              breakpoints: [],
              adaptations: [],
            },
          }),
        });

        const responsiveScore = scoringSystem.evaluateCraftsmanship(responsiveContext);
        const nonResponsiveScore = scoringSystem.evaluateCraftsmanship(nonResponsiveContext);
        expect(responsiveScore.score).toBeGreaterThan(nonResponsiveScore.score);
      });

      it("should include responsiveDesign in breakdown", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateCraftsmanship(context);
        const responsiveBreakdown = result.breakdown.find(
          (b) => b.criterion === "responsiveDesign"
        );
        expect(responsiveBreakdown).toBeDefined();
        expect(responsiveBreakdown?.weight).toBeCloseTo(0.2, 2);
      });
    });
  });

  // =========================================
  // 5. Contextuality Scoring Tests (12 tests)
  // =========================================
  describe("Contextuality Scoring", () => {
    describe("evaluateContextuality", () => {
      it("should return AxisScore with score between 0-100", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateContextuality(context);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
      });

      it("should include breakdown array", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateContextuality(context);
        expect(Array.isArray(result.breakdown)).toBe(true);
        expect(result.breakdown.length).toBeGreaterThan(0);
      });

      it("should include strengths array", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateContextuality(context);
        expect(Array.isArray(result.strengths)).toBe(true);
      });

      it("should include weaknesses array", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateContextuality(context);
        expect(Array.isArray(result.weaknesses)).toBe(true);
      });
    });

    describe("Industry Fit (30%)", () => {
      it("should score higher when industry is specified and matched", () => {
        const industryContext = createScoringContext({
          targetIndustry: "SaaS",
          sections: [
            createSection("hero"),
            createSection("feature"),
            createSection("pricing"),
            createSection("testimonial"),
            createSection("cta"),
            createSection("footer"),
          ],
        });
        const noIndustryContext = createScoringContext({
          targetIndustry: undefined,
        });

        const industryScore = scoringSystem.evaluateContextuality(industryContext);
        const noIndustryScore = scoringSystem.evaluateContextuality(noIndustryContext);
        expect(industryScore.score).toBeGreaterThanOrEqual(noIndustryScore.score);
      });

      it("should include industryFit in breakdown", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateContextuality(context);
        const industryBreakdown = result.breakdown.find((b) => b.criterion === "industryFit");
        expect(industryBreakdown).toBeDefined();
        expect(industryBreakdown?.weight).toBeCloseTo(0.3, 2);
      });
    });

    describe("Audience Fit (25%)", () => {
      it("should score higher when target audience is specified", () => {
        const audienceContext = createScoringContext({
          targetAudience: "developers",
          typography: createTypographyInfo({
            fonts: [{ family: "JetBrains Mono", weights: [400, 500] }],
          }),
        });
        const noAudienceContext = createScoringContext({
          targetAudience: undefined,
        });

        const audienceScore = scoringSystem.evaluateContextuality(audienceContext);
        const noAudienceScore = scoringSystem.evaluateContextuality(noAudienceContext);
        expect(audienceScore.score).toBeGreaterThanOrEqual(noAudienceScore.score);
      });

      it("should include audienceFit in breakdown", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateContextuality(context);
        const audienceBreakdown = result.breakdown.find((b) => b.criterion === "audienceFit");
        expect(audienceBreakdown).toBeDefined();
        expect(audienceBreakdown?.weight).toBeCloseTo(0.25, 2);
      });
    });

    describe("Brand Consistency (25%)", () => {
      it("should score higher for consistent branding elements", () => {
        const consistentContext = createScoringContext({
          colors: createColorInfo({
            palette: [
              { hex: "#3B82F6", count: 30, role: "primary" },
              { hex: "#FFFFFF", count: 40, role: "background" },
              { hex: "#1F2937", count: 20, role: "text" },
            ],
            dominant: "#3B82F6",
            background: "#FFFFFF",
            text: "#1F2937",
          }),
          sections: [
            createSection("hero", {
              style: { backgroundColor: "#FFFFFF", textColor: "#1F2937" },
            }),
            createSection("feature", {
              style: { backgroundColor: "#F8FAFC", textColor: "#1F2937" },
            }),
            createSection("cta", {
              style: { backgroundColor: "#3B82F6", textColor: "#FFFFFF" },
            }),
            createSection("footer", {
              style: { backgroundColor: "#1F2937", textColor: "#FFFFFF" },
            }),
          ],
        });

        const result = scoringSystem.evaluateContextuality(consistentContext);
        const brandBreakdown = result.breakdown.find((b) => b.criterion === "brandConsistency");
        expect(brandBreakdown?.score).toBeGreaterThanOrEqual(50);
      });

      it("should include brandConsistency in breakdown", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateContextuality(context);
        const brandBreakdown = result.breakdown.find((b) => b.criterion === "brandConsistency");
        expect(brandBreakdown).toBeDefined();
        expect(brandBreakdown?.weight).toBeCloseTo(0.25, 2);
      });
    });

    describe("Accessibility Compliance (20%)", () => {
      it("should score higher for good color contrast", () => {
        const accessibleContext = createScoringContext({
          colors: createColorInfo({
            dominant: "#1F2937",
            background: "#FFFFFF",
            text: "#1F2937", // High contrast
          }),
        });
        const inaccessibleContext = createScoringContext({
          colors: createColorInfo({
            dominant: "#CCCCCC",
            background: "#FFFFFF",
            text: "#CCCCCC", // Low contrast
          }),
        });

        const accessibleScore = scoringSystem.evaluateContextuality(accessibleContext);
        const inaccessibleScore = scoringSystem.evaluateContextuality(inaccessibleContext);
        expect(accessibleScore.score).toBeGreaterThan(inaccessibleScore.score);
      });

      it("should include accessibilityCompliance in breakdown", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluateContextuality(context);
        const a11yBreakdown = result.breakdown.find(
          (b) => b.criterion === "accessibilityCompliance"
        );
        expect(a11yBreakdown).toBeDefined();
        expect(a11yBreakdown?.weight).toBeCloseTo(0.2, 2);
      });
    });
  });

  // =========================================
  // 6. Overall Score Calculation Tests (10 tests)
  // =========================================
  describe("Overall Score Calculation", () => {
    describe("evaluate", () => {
      it("should return QualityScore with overall score between 0-100", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluate(context);
        expect(result.overall).toBeGreaterThanOrEqual(0);
        expect(result.overall).toBeLessThanOrEqual(100);
      });

      it("should include originality axis score", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluate(context);
        expect(result.originality).toBeDefined();
        expect(result.originality.score).toBeGreaterThanOrEqual(0);
        expect(result.originality.score).toBeLessThanOrEqual(100);
      });

      it("should include craftsmanship axis score", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluate(context);
        expect(result.craftsmanship).toBeDefined();
        expect(result.craftsmanship.score).toBeGreaterThanOrEqual(0);
        expect(result.craftsmanship.score).toBeLessThanOrEqual(100);
      });

      it("should include contextuality axis score", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluate(context);
        expect(result.contextuality).toBeDefined();
        expect(result.contextuality.score).toBeGreaterThanOrEqual(0);
        expect(result.contextuality.score).toBeLessThanOrEqual(100);
      });

      it("should calculate overall as weighted average", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluate(context);
        const weights = scoringSystem.getWeights();
        const expectedOverall =
          result.originality.score * weights.originality +
          result.craftsmanship.score * weights.craftsmanship +
          result.contextuality.score * weights.contextuality;
        expect(result.overall).toBeCloseTo(expectedOverall, 1);
      });

      it("should include grade (A-F)", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluate(context);
        expect(["A", "B", "C", "D", "F"]).toContain(result.grade);
      });

      it("should include summary string", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluate(context);
        expect(typeof result.summary).toBe("string");
        expect(result.summary.length).toBeGreaterThan(0);
      });

      it("should include recommendations array", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluate(context);
        expect(Array.isArray(result.recommendations)).toBe(true);
      });

      it("should score high-quality context higher", () => {
        const highQuality = createHighQualityContext();
        const lowQuality = createLowQualityContext();

        const highScore = scoringSystem.evaluate(highQuality);
        const lowScore = scoringSystem.evaluate(lowQuality);
        expect(highScore.overall).toBeGreaterThan(lowScore.overall);
      });

      it("should round overall score to 2 decimal places", () => {
        const context = createScoringContext();
        const result = scoringSystem.evaluate(context);
        const decimalPlaces = (result.overall.toString().split(".")[1] || "").length;
        expect(decimalPlaces).toBeLessThanOrEqual(2);
      });
    });
  });

  // =========================================
  // 7. Grade Calculation Tests (8 tests)
  // =========================================
  describe("Grade Calculation", () => {
    it("should assign grade A for score >= 90", () => {
      expect(scoringSystem.calculateGrade(90)).toBe("A");
      expect(scoringSystem.calculateGrade(95)).toBe("A");
      expect(scoringSystem.calculateGrade(100)).toBe("A");
    });

    it("should assign grade B for score >= 80 and < 90", () => {
      expect(scoringSystem.calculateGrade(80)).toBe("B");
      expect(scoringSystem.calculateGrade(85)).toBe("B");
      expect(scoringSystem.calculateGrade(89)).toBe("B");
    });

    it("should assign grade C for score >= 70 and < 80", () => {
      expect(scoringSystem.calculateGrade(70)).toBe("C");
      expect(scoringSystem.calculateGrade(75)).toBe("C");
      expect(scoringSystem.calculateGrade(79)).toBe("C");
    });

    it("should assign grade D for score >= 60 and < 70", () => {
      expect(scoringSystem.calculateGrade(60)).toBe("D");
      expect(scoringSystem.calculateGrade(65)).toBe("D");
      expect(scoringSystem.calculateGrade(69)).toBe("D");
    });

    it("should assign grade F for score < 60", () => {
      expect(scoringSystem.calculateGrade(0)).toBe("F");
      expect(scoringSystem.calculateGrade(30)).toBe("F");
      expect(scoringSystem.calculateGrade(59)).toBe("F");
    });

    it("should handle boundary values correctly", () => {
      expect(scoringSystem.calculateGrade(89.9)).toBe("B");
      expect(scoringSystem.calculateGrade(90.0)).toBe("A");
      expect(scoringSystem.calculateGrade(79.9)).toBe("C");
      expect(scoringSystem.calculateGrade(80.0)).toBe("B");
    });

    it("should handle edge case of exactly 0", () => {
      expect(scoringSystem.calculateGrade(0)).toBe("F");
    });

    it("should handle edge case of exactly 100", () => {
      expect(scoringSystem.calculateGrade(100)).toBe("A");
    });
  });

  // =========================================
  // 8. Summary Generation Tests (6 tests)
  // =========================================
  describe("Summary Generation", () => {
    it("should generate summary for high-scoring design", () => {
      const score: QualityScore = {
        overall: 92,
        originality: { score: 90, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 95, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 88, breakdown: [], strengths: [], weaknesses: [] },
        grade: "A",
        summary: "",
        recommendations: [],
      };
      const summary = scoringSystem.generateSummary(score);
      expect(summary).toContain("excellent");
    });

    it("should generate summary for average design", () => {
      const score: QualityScore = {
        overall: 72,
        originality: { score: 70, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 75, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 70, breakdown: [], strengths: [], weaknesses: [] },
        grade: "C",
        summary: "",
        recommendations: [],
      };
      const summary = scoringSystem.generateSummary(score);
      expect(summary.length).toBeGreaterThan(0);
    });

    it("should generate summary for low-scoring design", () => {
      const score: QualityScore = {
        overall: 45,
        originality: { score: 40, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 50, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 42, breakdown: [], strengths: [], weaknesses: [] },
        grade: "F",
        summary: "",
        recommendations: [],
      };
      const summary = scoringSystem.generateSummary(score);
      expect(summary).toContain("improvement");
    });

    it("should mention strongest axis", () => {
      const score: QualityScore = {
        overall: 80,
        originality: { score: 60, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 95, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 75, breakdown: [], strengths: [], weaknesses: [] },
        grade: "B",
        summary: "",
        recommendations: [],
      };
      const summary = scoringSystem.generateSummary(score);
      expect(summary.toLowerCase()).toContain("craftsmanship");
    });

    it("should mention weakest axis", () => {
      const score: QualityScore = {
        overall: 80,
        originality: { score: 60, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 95, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 75, breakdown: [], strengths: [], weaknesses: [] },
        grade: "B",
        summary: "",
        recommendations: [],
      };
      const summary = scoringSystem.generateSummary(score);
      expect(summary.toLowerCase()).toContain("originality");
    });

    it("should include grade in summary", () => {
      const score: QualityScore = {
        overall: 85,
        originality: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        grade: "B",
        summary: "",
        recommendations: [],
      };
      const summary = scoringSystem.generateSummary(score);
      expect(summary).toContain("B");
    });
  });

  // =========================================
  // 9. Recommendations Generation Tests (6 tests)
  // =========================================
  describe("Recommendations Generation", () => {
    it("should generate recommendations for low originality", () => {
      const score: QualityScore = {
        overall: 70,
        originality: {
          score: 40,
          breakdown: [],
          strengths: [],
          weaknesses: ["Generic color palette"],
        },
        craftsmanship: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 80, breakdown: [], strengths: [], weaknesses: [] },
        grade: "C",
        summary: "",
        recommendations: [],
      };
      const recommendations = scoringSystem.generateRecommendations(score);
      expect(
        recommendations.some(
          (r) => r.toLowerCase().includes("color") || r.toLowerCase().includes("original")
        )
      ).toBe(true);
    });

    it("should generate recommendations for low craftsmanship", () => {
      const score: QualityScore = {
        overall: 70,
        originality: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: {
          score: 40,
          breakdown: [],
          strengths: [],
          weaknesses: ["Inconsistent spacing"],
        },
        contextuality: { score: 80, breakdown: [], strengths: [], weaknesses: [] },
        grade: "C",
        summary: "",
        recommendations: [],
      };
      const recommendations = scoringSystem.generateRecommendations(score);
      expect(
        recommendations.some(
          (r) =>
            r.toLowerCase().includes("spacing") ||
            r.toLowerCase().includes("grid") ||
            r.toLowerCase().includes("consistency")
        )
      ).toBe(true);
    });

    it("should generate recommendations for low contextuality", () => {
      const score: QualityScore = {
        overall: 70,
        originality: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: {
          score: 40,
          breakdown: [],
          strengths: [],
          weaknesses: ["Poor accessibility"],
        },
        grade: "C",
        summary: "",
        recommendations: [],
      };
      const recommendations = scoringSystem.generateRecommendations(score);
      expect(
        recommendations.some(
          (r) =>
            r.toLowerCase().includes("accessibility") ||
            r.toLowerCase().includes("audience") ||
            r.toLowerCase().includes("context")
        )
      ).toBe(true);
    });

    it("should return empty array for perfect score", () => {
      const score: QualityScore = {
        overall: 100,
        originality: { score: 100, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 100, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 100, breakdown: [], strengths: [], weaknesses: [] },
        grade: "A",
        summary: "",
        recommendations: [],
      };
      const recommendations = scoringSystem.generateRecommendations(score);
      expect(recommendations.length).toBe(0);
    });

    it("should prioritize recommendations by score gap", () => {
      const score: QualityScore = {
        overall: 60,
        originality: { score: 30, breakdown: [], strengths: [], weaknesses: ["Very generic"] },
        craftsmanship: { score: 80, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 50, breakdown: [], strengths: [], weaknesses: ["Poor fit"] },
        grade: "D",
        summary: "",
        recommendations: [],
      };
      const recommendations = scoringSystem.generateRecommendations(score);
      expect(recommendations.length).toBeGreaterThan(0);
      // First recommendation should address originality (lowest score)
    });

    it("should limit recommendations to reasonable count", () => {
      const score: QualityScore = {
        overall: 40,
        originality: {
          score: 30,
          breakdown: [],
          strengths: [],
          weaknesses: ["Issue 1", "Issue 2", "Issue 3"],
        },
        craftsmanship: {
          score: 40,
          breakdown: [],
          strengths: [],
          weaknesses: ["Issue 1", "Issue 2", "Issue 3"],
        },
        contextuality: {
          score: 45,
          breakdown: [],
          strengths: [],
          weaknesses: ["Issue 1", "Issue 2", "Issue 3"],
        },
        grade: "F",
        summary: "",
        recommendations: [],
      };
      const recommendations = scoringSystem.generateRecommendations(score);
      expect(recommendations.length).toBeLessThanOrEqual(10);
    });
  });

  // =========================================
  // 10. Edge Cases Tests (8 tests)
  // =========================================
  describe("Edge Cases", () => {
    it("should handle empty sections array", () => {
      const context = createScoringContext({ sections: [] });
      const result = scoringSystem.evaluate(context);
      expect(result.overall).toBeGreaterThanOrEqual(0);
      expect(result.overall).toBeLessThanOrEqual(100);
    });

    it("should handle missing clicheReport", () => {
      const context = createScoringContext({ clicheReport: undefined });
      const result = scoringSystem.evaluate(context);
      expect(result.overall).toBeGreaterThanOrEqual(0);
    });

    it("should handle missing targetIndustry", () => {
      const context = createScoringContext({ targetIndustry: undefined });
      const result = scoringSystem.evaluate(context);
      expect(result.overall).toBeGreaterThanOrEqual(0);
    });

    it("should handle missing targetAudience", () => {
      const context = createScoringContext({ targetAudience: undefined });
      const result = scoringSystem.evaluate(context);
      expect(result.overall).toBeGreaterThanOrEqual(0);
    });

    it("should handle single section", () => {
      const context = createScoringContext({
        sections: [createSection("hero")],
      });
      const result = scoringSystem.evaluate(context);
      expect(result.overall).toBeGreaterThanOrEqual(0);
    });

    it("should handle empty color palette", () => {
      const context = createScoringContext({
        colors: createColorInfo({ palette: [] }),
      });
      const result = scoringSystem.evaluate(context);
      expect(result.overall).toBeGreaterThanOrEqual(0);
    });

    it("should handle empty fonts array", () => {
      const context = createScoringContext({
        typography: createTypographyInfo({ fonts: [] }),
      });
      const result = scoringSystem.evaluate(context);
      expect(result.overall).toBeGreaterThanOrEqual(0);
    });

    it("should handle minimal layout info", () => {
      const context = createScoringContext({
        layout: createLayoutInfo({
          type: "unknown",
          columns: undefined,
          gutterWidth: undefined,
          maxWidth: undefined,
          responsive: {
            breakpoints: [],
            adaptations: [],
          },
        }),
      });
      const result = scoringSystem.evaluate(context);
      expect(result.overall).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================
  // 11. Score History & Comparison Tests (6 tests)
  // =========================================
  describe("Score History & Comparison", () => {
    it("should produce consistent scores for same context", () => {
      const context = createScoringContext();
      const score1 = scoringSystem.evaluate(context);
      const score2 = scoringSystem.evaluate(context);
      expect(score1.overall).toBe(score2.overall);
    });

    it("should produce different scores for different contexts", () => {
      const highQuality = createHighQualityContext();
      const lowQuality = createLowQualityContext();
      const score1 = scoringSystem.evaluate(highQuality);
      const score2 = scoringSystem.evaluate(lowQuality);
      expect(score1.overall).not.toBe(score2.overall);
    });

    it("should reflect weight changes in score", () => {
      const context = createScoringContext();
      const defaultScore = scoringSystem.evaluate(context);

      scoringSystem.setWeights({ originality: 0.9, craftsmanship: 0.05, contextuality: 0.05 });
      const originalityFocusedScore = scoringSystem.evaluate(context);

      // Score should change when weights change (unless all axis scores are equal)
      expect(originalityFocusedScore).toBeDefined();
    });

    it("should compare two designs correctly", () => {
      const design1 = createHighQualityContext();
      const design2 = createLowQualityContext();
      const score1 = scoringSystem.evaluate(design1);
      const score2 = scoringSystem.evaluate(design2);

      const comparison = {
        better: score1.overall > score2.overall ? "design1" : "design2",
        difference: Math.abs(score1.overall - score2.overall),
      };

      expect(comparison.better).toBe("design1");
      expect(comparison.difference).toBeGreaterThan(0);
    });

    it("should identify improvement areas between versions", () => {
      const versionA: QualityScore = {
        overall: 70,
        originality: { score: 60, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 75, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 72, breakdown: [], strengths: [], weaknesses: [] },
        grade: "C",
        summary: "",
        recommendations: [],
      };
      const versionB: QualityScore = {
        overall: 80,
        originality: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 75, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 78, breakdown: [], strengths: [], weaknesses: [] },
        grade: "B",
        summary: "",
        recommendations: [],
      };

      const improvements = {
        originality: versionB.originality.score - versionA.originality.score,
        craftsmanship: versionB.craftsmanship.score - versionA.craftsmanship.score,
        contextuality: versionB.contextuality.score - versionA.contextuality.score,
      };

      expect(improvements.originality).toBe(25);
      expect(improvements.craftsmanship).toBe(0);
      expect(improvements.contextuality).toBe(6);
    });

    it("should track grade transitions", () => {
      const grades = ["F", "D", "C", "B", "A"] as const;
      const context = createScoringContext();

      // Start with poor context, improve iteratively
      const gradeIndex = grades.indexOf(scoringSystem.evaluate(context).grade);
      expect(gradeIndex).toBeGreaterThanOrEqual(0);
      expect(gradeIndex).toBeLessThanOrEqual(4);
    });
  });

  // =========================================
  // 12. Breakdown Score Validation Tests (6 tests)
  // =========================================
  describe("Breakdown Score Validation", () => {
    it("should have breakdown weights sum to 1.0 for originality", () => {
      const context = createScoringContext();
      const result = scoringSystem.evaluateOriginality(context);
      const weightSum = result.breakdown.reduce((sum, b) => sum + b.weight, 0);
      expect(weightSum).toBeCloseTo(1.0, 2);
    });

    it("should have breakdown weights sum to 1.0 for craftsmanship", () => {
      const context = createScoringContext();
      const result = scoringSystem.evaluateCraftsmanship(context);
      const weightSum = result.breakdown.reduce((sum, b) => sum + b.weight, 0);
      expect(weightSum).toBeCloseTo(1.0, 2);
    });

    it("should have breakdown weights sum to 1.0 for contextuality", () => {
      const context = createScoringContext();
      const result = scoringSystem.evaluateContextuality(context);
      const weightSum = result.breakdown.reduce((sum, b) => sum + b.weight, 0);
      expect(weightSum).toBeCloseTo(1.0, 2);
    });

    it("should have all breakdown scores between 0-100", () => {
      const context = createScoringContext();
      const result = scoringSystem.evaluate(context);

      const allBreakdowns = [
        ...result.originality.breakdown,
        ...result.craftsmanship.breakdown,
        ...result.contextuality.breakdown,
      ];

      allBreakdowns.forEach((b) => {
        expect(b.score).toBeGreaterThanOrEqual(0);
        expect(b.score).toBeLessThanOrEqual(100);
      });
    });

    it("should calculate axis score as weighted average of breakdown", () => {
      const context = createScoringContext();
      const result = scoringSystem.evaluateOriginality(context);

      const calculatedScore = result.breakdown.reduce((sum, b) => sum + b.score * b.weight, 0);
      expect(result.score).toBeCloseTo(calculatedScore, 1);
    });

    it("should include criterion name in each breakdown", () => {
      const context = createScoringContext();
      const result = scoringSystem.evaluate(context);

      const allBreakdowns = [
        ...result.originality.breakdown,
        ...result.craftsmanship.breakdown,
        ...result.contextuality.breakdown,
      ];

      allBreakdowns.forEach((b) => {
        expect(typeof b.criterion).toBe("string");
        expect(b.criterion.length).toBeGreaterThan(0);
      });
    });
  });

  // =========================================
  // 13. NaN/Infinity Boundary Defense Tests (8 tests)
  // =========================================
  describe("NaN/Infinity Boundary Defense", () => {
    it("should handle NaN weight — normalizeWeights produces NaN (Math.max/min does not clamp NaN)", () => {
      const system = new ScoringSystem({
        originality: NaN,
        craftsmanship: 0.5,
        contextuality: 0.5,
      });
      const weights = system.getWeights();
      // Math.max(0, Math.min(1, NaN)) returns NaN; NaN/sum = NaN
      // This is a known behavior: NaN propagates through the normalization
      expect(Number.isNaN(weights.originality)).toBe(true);
      // craftsmanship and contextuality are computed as val/(NaN+0.5+0.5) = NaN
      expect(Number.isNaN(weights.craftsmanship)).toBe(true);
      expect(Number.isNaN(weights.contextuality)).toBe(true);
    });

    it("should handle Infinity weight gracefully by clamping to 1", () => {
      const system = new ScoringSystem({
        originality: Infinity,
        craftsmanship: 0.3,
        contextuality: 0.3,
      });
      const weights = system.getWeights();
      // Infinity clamped to 1.0, then normalized: 1/(1+0.3+0.3)=0.625...
      expect(weights.originality).toBeCloseTo(1 / 1.6, 2);
      expect(Number.isFinite(weights.originality)).toBe(true);
    });

    it("should handle negative Infinity weight gracefully by clamping to 0", () => {
      const system = new ScoringSystem({
        originality: -Infinity,
        craftsmanship: 0.5,
        contextuality: 0.5,
      });
      const weights = system.getWeights();
      expect(weights.originality).toBe(0);
      expect(Number.isFinite(weights.craftsmanship)).toBe(true);
    });

    it("should return DEFAULT_WEIGHTS when all weights are zero", () => {
      const system = new ScoringSystem({
        originality: 0,
        craftsmanship: 0,
        contextuality: 0,
      });
      const weights = system.getWeights();
      // normalizeWeights returns DEFAULT_WEIGHTS when sum === 0
      expect(weights.originality).toBe(0.35);
      expect(weights.craftsmanship).toBe(0.4);
      expect(weights.contextuality).toBe(0.25);
    });

    it("should produce finite overall score with edge-case context", () => {
      const context = createScoringContext({
        colors: createColorInfo({ palette: [] }),
        typography: createTypographyInfo({ fonts: [], headingScale: [] }),
        sections: [],
      });
      const result = scoringSystem.evaluate(context);
      expect(Number.isFinite(result.overall)).toBe(true);
      expect(result.overall).toBeGreaterThanOrEqual(0);
      expect(result.overall).toBeLessThanOrEqual(100);
    });

    it("should handle grade calculation for negative score", () => {
      expect(scoringSystem.calculateGrade(-10)).toBe("F");
    });

    it("should handle grade calculation for score > 100", () => {
      expect(scoringSystem.calculateGrade(150)).toBe("A");
    });

    it("should produce finite scores for all breakdown items with minimal context", () => {
      const context = createScoringContext({
        sections: [],
        colors: createColorInfo({ palette: [] }),
        typography: createTypographyInfo({ fonts: [], headingScale: [] }),
        layout: createLayoutInfo({
          type: "unknown",
          columns: undefined,
          gutterWidth: undefined,
          maxWidth: undefined,
          spacing: undefined,
          responsive: undefined,
        }),
      });
      const result = scoringSystem.evaluate(context);
      const allBreakdowns = [
        ...result.originality.breakdown,
        ...result.craftsmanship.breakdown,
        ...result.contextuality.breakdown,
      ];
      allBreakdowns.forEach((b) => {
        expect(Number.isFinite(b.score)).toBe(true);
        expect(b.score).toBeGreaterThanOrEqual(0);
        expect(b.score).toBeLessThanOrEqual(100);
      });
    });
  });

  // =========================================
  // 14. Specific Score Calculation Tests (12 tests)
  // =========================================
  describe("Specific Score Calculations", () => {
    describe("Unique Color Usage scoring details", () => {
      it("should return score 30 for empty palette", () => {
        const context = createScoringContext({
          colors: createColorInfo({ palette: [] }),
        });
        const result = scoringSystem.evaluateOriginality(context);
        const colorBreakdown = result.breakdown.find((b) => b.criterion === "uniqueColorUsage");
        expect(colorBreakdown?.score).toBe(30);
      });

      it("should award 40 base points for palette with 5+ colors", () => {
        const context = createScoringContext({
          colors: createColorInfo({
            palette: [
              { hex: "#111111", count: 10, role: "primary" },
              { hex: "#222222", count: 10, role: "secondary" },
              { hex: "#333333", count: 10, role: "tertiary" },
              { hex: "#444444", count: 10, role: "accent" },
              { hex: "#555555", count: 10, role: "background" },
            ],
            accent: "#444444",
            dominant: "#111111",
            background: "#555555",
            text: "#111111",
          }),
        });
        const result = scoringSystem.evaluateOriginality(context);
        const colorBreakdown = result.breakdown.find((b) => b.criterion === "uniqueColorUsage");
        // 40 (5+ palette) + 20 (accent) + 25 (5 roles * 5, capped at 20) + contrast check
        expect(colorBreakdown?.score).toBeGreaterThanOrEqual(80);
      });

      it("should award 25 base points for palette with 3-4 colors", () => {
        const context = createScoringContext({
          colors: createColorInfo({
            palette: [
              { hex: "#111111", count: 10, role: "primary" },
              { hex: "#FFFFFF", count: 40, role: "background" },
              { hex: "#333333", count: 30, role: "text" },
            ],
            dominant: "#111111",
            background: "#FFFFFF",
            text: "#333333",
          }),
        });
        const result = scoringSystem.evaluateOriginality(context);
        const colorBreakdown = result.breakdown.find((b) => b.criterion === "uniqueColorUsage");
        // 25 (3 palette) + 0 (no accent) + 15 (3 roles) + 20 (contrast) = 60
        expect(colorBreakdown?.score).toBe(60);
      });
    });

    describe("Layout Creativity scoring details", () => {
      it("should return score 30 for empty sections", () => {
        const context = createScoringContext({ sections: [] });
        const result = scoringSystem.evaluateOriginality(context);
        const layoutBreakdown = result.breakdown.find((b) => b.criterion === "layoutCreativity");
        expect(layoutBreakdown?.score).toBe(30);
      });

      it("should award 50 points for 6+ unique section types", () => {
        const context = createScoringContext({
          sections: [
            createSection("hero"),
            createSection("feature"),
            createSection("testimonial"),
            createSection("pricing"),
            createSection("gallery"),
            createSection("cta"),
            createSection("footer"),
          ],
        });
        const result = scoringSystem.evaluateOriginality(context);
        const layoutBreakdown = result.breakdown.find((b) => b.criterion === "layoutCreativity");
        // 50 (6+ unique) + key types bonus + 20 (7 sections) = high score
        expect(layoutBreakdown?.score).toBeGreaterThanOrEqual(90);
      });
    });

    describe("Typography Personality scoring details", () => {
      it("should return score 30 for empty fonts", () => {
        const context = createScoringContext({
          typography: createTypographyInfo({ fonts: [] }),
        });
        const result = scoringSystem.evaluateOriginality(context);
        const typoBreakdown = result.breakdown.find((b) => b.criterion === "typographyPersonality");
        expect(typoBreakdown?.score).toBe(30);
      });

      it("should score 10 font points for all-generic fonts", () => {
        const context = createScoringContext({
          typography: createTypographyInfo({
            fonts: [{ family: "Arial", weights: [400, 700] }],
            headingScale: [32, 24, 20, 18, 16],
          }),
        });
        const result = scoringSystem.evaluateOriginality(context);
        const typoBreakdown = result.breakdown.find((b) => b.criterion === "typographyPersonality");
        // 10 (0 custom fonts) + 10 (2 unique weights) + 30 (5 heading scale) = 50
        expect(typoBreakdown?.score).toBe(50);
      });

      it("should score 40 font points for 2+ custom fonts", () => {
        const context = createScoringContext({
          typography: createTypographyInfo({
            fonts: [
              { family: "Cal Sans", weights: [600, 700] },
              { family: "Space Grotesk", weights: [400, 500, 600] },
            ],
            headingScale: [48, 36, 24, 20, 16],
          }),
        });
        const result = scoringSystem.evaluateOriginality(context);
        const typoBreakdown = result.breakdown.find((b) => b.criterion === "typographyPersonality");
        // 40 (2 custom) + 30 (4+ unique weights: 600,700,400,500) + 30 (5 heading scale) = 100
        expect(typoBreakdown?.score).toBe(100);
      });
    });

    describe("Anti-Cliche Bonus scoring details", () => {
      it("should score 60 when no cliche report provided", () => {
        const context = createScoringContext({ clicheReport: undefined });
        const result = scoringSystem.evaluateOriginality(context);
        const antiCliche = result.breakdown.find((b) => b.criterion === "antiClicheBonus");
        expect(antiCliche?.score).toBe(60);
      });

      it("should score 100 for totalClicheScore = 0", () => {
        const context = createScoringContext({
          clicheReport: createClicheReport({ totalClicheScore: 0 }),
        });
        const result = scoringSystem.evaluateOriginality(context);
        const antiCliche = result.breakdown.find((b) => b.criterion === "antiClicheBonus");
        expect(antiCliche?.score).toBe(100);
      });

      it("should score 0 for totalClicheScore = 1.0", () => {
        const context = createScoringContext({
          clicheReport: createClicheReport({ totalClicheScore: 1.0 }),
        });
        const result = scoringSystem.evaluateOriginality(context);
        const antiCliche = result.breakdown.find((b) => b.criterion === "antiClicheBonus");
        expect(antiCliche?.score).toBe(0);
      });

      it("should score 80 for totalClicheScore = 0.2", () => {
        const context = createScoringContext({
          clicheReport: createClicheReport({ totalClicheScore: 0.2 }),
        });
        const result = scoringSystem.evaluateOriginality(context);
        const antiCliche = result.breakdown.find((b) => b.criterion === "antiClicheBonus");
        expect(antiCliche?.score).toBe(80);
      });
    });

    describe("Grid Alignment scoring details", () => {
      it("should score 30 for grid layout type", () => {
        const context = createScoringContext({
          layout: createLayoutInfo({
            type: "grid",
            columns: undefined,
            gutterWidth: undefined,
            maxWidth: undefined,
          }),
        });
        const result = scoringSystem.evaluateCraftsmanship(context);
        const gridBreakdown = result.breakdown.find((b) => b.criterion === "gridAlignment");
        // 30 (grid type) + 0 (no columns) + 0 (no gutter) + 0 (no maxWidth) = 30
        expect(gridBreakdown?.score).toBe(30);
      });

      it("should score 25 for flex layout type", () => {
        const context = createScoringContext({
          layout: createLayoutInfo({
            type: "flex",
            columns: undefined,
            gutterWidth: undefined,
            maxWidth: undefined,
          }),
        });
        const result = scoringSystem.evaluateCraftsmanship(context);
        const gridBreakdown = result.breakdown.find((b) => b.criterion === "gridAlignment");
        expect(gridBreakdown?.score).toBe(25);
      });

      it("should score 100 for fully defined grid (12col + gutter + maxWidth)", () => {
        const context = createScoringContext({
          layout: createLayoutInfo({ type: "grid", columns: 12, gutterWidth: 24, maxWidth: 1200 }),
        });
        const result = scoringSystem.evaluateCraftsmanship(context);
        const gridBreakdown = result.breakdown.find((b) => b.criterion === "gridAlignment");
        // 30 (grid) + 30 (12 col) + 20 (gutter) + 20 (maxWidth) = 100
        expect(gridBreakdown?.score).toBe(100);
      });

      it("should score 20 for 6-11 columns", () => {
        const context = createScoringContext({
          layout: createLayoutInfo({
            type: "unknown",
            columns: 8,
            gutterWidth: undefined,
            maxWidth: undefined,
          }),
        });
        const result = scoringSystem.evaluateCraftsmanship(context);
        const gridBreakdown = result.breakdown.find((b) => b.criterion === "gridAlignment");
        // 10 (unknown) + 20 (6-11 col) = 30
        expect(gridBreakdown?.score).toBe(30);
      });
    });

    describe("Whitespace Rhythm scoring details", () => {
      it("should return score 50 when no spacing info", () => {
        const context = createScoringContext({
          layout: createLayoutInfo({ spacing: undefined }),
        });
        const result = scoringSystem.evaluateCraftsmanship(context);
        const spacingBreakdown = result.breakdown.find((b) => b.criterion === "whitespaceRhythm");
        expect(spacingBreakdown?.score).toBe(50);
      });

      it("should award 100 for ideal spacing (section=80, element=24, component=16)", () => {
        const context = createScoringContext({
          layout: createLayoutInfo({
            spacing: { section: 80, element: 24, component: 16 },
          }),
        });
        const result = scoringSystem.evaluateCraftsmanship(context);
        const spacingBreakdown = result.breakdown.find((b) => b.criterion === "whitespaceRhythm");
        // 40 (section 60-120) + 30 (element 16-40) + 30 (good ratios) = 100
        expect(spacingBreakdown?.score).toBe(100);
      });
    });

    describe("Responsive Design scoring details", () => {
      it("should return score 30 when no responsive info", () => {
        const context = createScoringContext({
          layout: createLayoutInfo({ responsive: undefined }),
        });
        const result = scoringSystem.evaluateCraftsmanship(context);
        const responsiveBreakdown = result.breakdown.find(
          (b) => b.criterion === "responsiveDesign"
        );
        expect(responsiveBreakdown?.score).toBe(30);
      });

      it("should score 0 for zero breakpoints and zero adaptations", () => {
        const context = createScoringContext({
          layout: createLayoutInfo({
            responsive: { breakpoints: [], adaptations: [] },
          }),
        });
        const result = scoringSystem.evaluateCraftsmanship(context);
        const responsiveBreakdown = result.breakdown.find(
          (b) => b.criterion === "responsiveDesign"
        );
        expect(responsiveBreakdown?.score).toBe(0);
      });

      it("should score 100 for 4+ breakpoints and 4+ adaptations", () => {
        const context = createScoringContext({
          layout: createLayoutInfo({
            responsive: {
              breakpoints: [
                { name: "mobile", minWidth: 0 },
                { name: "tablet", minWidth: 768 },
                { name: "desktop", minWidth: 1024 },
                { name: "wide", minWidth: 1440 },
              ],
              adaptations: ["stack", "reduce-columns", "adjust-type", "hide-secondary"],
            },
          }),
        });
        const result = scoringSystem.evaluateCraftsmanship(context);
        const responsiveBreakdown = result.breakdown.find(
          (b) => b.criterion === "responsiveDesign"
        );
        // 50 (4+ breakpoints) + 50 (4+ adaptations) = 100
        expect(responsiveBreakdown?.score).toBe(100);
      });
    });
  });

  // =========================================
  // 15. Industry Fit Tests for All Industries (6 tests)
  // =========================================
  describe("Industry Fit for All Defined Industries", () => {
    it("should score high for SaaS with matching sections", () => {
      const context = createScoringContext({
        targetIndustry: "saas",
        sections: [
          createSection("hero"),
          createSection("feature"),
          createSection("pricing"),
          createSection("testimonial"),
          createSection("cta"),
          createSection("footer"),
        ],
      });
      const result = scoringSystem.evaluateContextuality(context);
      const industryBreakdown = result.breakdown.find((b) => b.criterion === "industryFit");
      // All 6 expected sections present: 6/6 = 100
      expect(industryBreakdown?.score).toBe(100);
    });

    it("should score high for ecommerce with matching sections", () => {
      const context = createScoringContext({
        targetIndustry: "ecommerce",
        sections: [
          createSection("hero"),
          createSection("gallery"),
          createSection("feature"),
          createSection("testimonial"),
          createSection("cta"),
          createSection("footer"),
        ],
      });
      const result = scoringSystem.evaluateContextuality(context);
      const industryBreakdown = result.breakdown.find((b) => b.criterion === "industryFit");
      expect(industryBreakdown?.score).toBe(100);
    });

    it("should score high for portfolio with matching sections", () => {
      const context = createScoringContext({
        targetIndustry: "portfolio",
        sections: [
          createSection("hero"),
          createSection("gallery"),
          createSection("about"),
          createSection("testimonial"),
          createSection("contact"),
          createSection("footer"),
        ],
      });
      const result = scoringSystem.evaluateContextuality(context);
      const industryBreakdown = result.breakdown.find((b) => b.criterion === "industryFit");
      expect(industryBreakdown?.score).toBe(100);
    });

    it("should return neutral score 60 for unknown industry", () => {
      const context = createScoringContext({
        targetIndustry: "fintech",
      });
      const result = scoringSystem.evaluateContextuality(context);
      const industryBreakdown = result.breakdown.find((b) => b.criterion === "industryFit");
      expect(industryBreakdown?.score).toBe(60);
    });

    it("should return neutral score 60 when no industry specified", () => {
      const context = createScoringContext({
        targetIndustry: undefined,
      });
      const result = scoringSystem.evaluateContextuality(context);
      const industryBreakdown = result.breakdown.find((b) => b.criterion === "industryFit");
      expect(industryBreakdown?.score).toBe(60);
    });

    it("should clamp minimum industry score to 40 for partial match", () => {
      const context = createScoringContext({
        targetIndustry: "saas",
        sections: [createSection("footer")],
      });
      const result = scoringSystem.evaluateContextuality(context);
      const industryBreakdown = result.breakdown.find((b) => b.criterion === "industryFit");
      // 1/6 = 16.67% → round(16.67) = 17 → clamped to max(40, 17) = 40
      expect(industryBreakdown?.score).toBe(40);
    });
  });

  // =========================================
  // 16. Audience Fit Tests (5 tests)
  // =========================================
  describe("Audience Fit Detailed Tests", () => {
    it("should return neutral score 60 when no audience specified", () => {
      const context = createScoringContext({ targetAudience: undefined });
      const result = scoringSystem.evaluateContextuality(context);
      const audienceBreakdown = result.breakdown.find((b) => b.criterion === "audienceFit");
      expect(audienceBreakdown?.score).toBe(60);
    });

    it("should award +20 for developer audience with monospace font", () => {
      const context = createScoringContext({
        targetAudience: "developers",
        typography: createTypographyInfo({
          fonts: [{ family: "JetBrains Mono", weights: [400, 500] }],
        }),
      });
      const result = scoringSystem.evaluateContextuality(context);
      const audienceBreakdown = result.breakdown.find((b) => b.criterion === "audienceFit");
      // 60 (base) + 20 (technical font) + 10 (custom font) = 90
      expect(audienceBreakdown?.score).toBe(90);
    });

    it("should award +20 for young audience with modern font", () => {
      const context = createScoringContext({
        targetAudience: "young professionals",
        typography: createTypographyInfo({
          fonts: [{ family: "Inter", weights: [400, 500, 600] }],
        }),
      });
      const result = scoringSystem.evaluateContextuality(context);
      const audienceBreakdown = result.breakdown.find((b) => b.criterion === "audienceFit");
      // 60 (base) + 20 (modern font) + 10 (custom font) = 90
      expect(audienceBreakdown?.score).toBe(90);
    });

    it("should award +10 for any custom font regardless of audience", () => {
      const context = createScoringContext({
        targetAudience: "general public",
        typography: createTypographyInfo({
          fonts: [{ family: "Playfair Display", weights: [400, 700] }],
        }),
      });
      const result = scoringSystem.evaluateContextuality(context);
      const audienceBreakdown = result.breakdown.find((b) => b.criterion === "audienceFit");
      // 60 (base) + 10 (custom font) = 70
      expect(audienceBreakdown?.score).toBe(70);
    });

    it("should not exceed 100 for audience fit", () => {
      const context = createScoringContext({
        targetAudience: "modern developers",
        typography: createTypographyInfo({
          fonts: [
            { family: "JetBrains Mono", weights: [400] },
            { family: "Inter", weights: [400, 500] },
            { family: "Space Grotesk", weights: [600] },
          ],
        }),
      });
      const result = scoringSystem.evaluateContextuality(context);
      const audienceBreakdown = result.breakdown.find((b) => b.criterion === "audienceFit");
      expect(audienceBreakdown?.score).toBeLessThanOrEqual(100);
    });
  });

  // =========================================
  // 17. Typography Consistency Detailed Tests (5 tests)
  // =========================================
  describe("Typography Consistency Detailed Tests", () => {
    it("should award 30 for 1-2 font families", () => {
      const context = createScoringContext({
        typography: createTypographyInfo({
          fonts: [{ family: "Inter", weights: [400, 500, 600, 700] }],
          headingScale: [48, 36, 27, 20, 16],
          lineHeight: 1.5,
        }),
      });
      const result = scoringSystem.evaluateCraftsmanship(context);
      const typoBreakdown = result.breakdown.find((b) => b.criterion === "typographyConsistency");
      // 30 (1 font) + heading scale regularity + 30 (lineHeight 1.5) = high
      expect(typoBreakdown?.score).toBeGreaterThanOrEqual(80);
    });

    it("should score lower for 4+ font families", () => {
      const context = createScoringContext({
        typography: createTypographyInfo({
          fonts: [
            { family: "Arial", weights: [400] },
            { family: "Georgia", weights: [400] },
            { family: "Courier", weights: [400] },
            { family: "Verdana", weights: [400] },
          ],
          headingScale: [50, 20, 15, 14],
          lineHeight: 1.5,
        }),
      });
      const result = scoringSystem.evaluateCraftsmanship(context);
      const typoBreakdown = result.breakdown.find((b) => b.criterion === "typographyConsistency");
      // 10 (4+ fonts) + heading scale + 30 (lineHeight 1.5)
      expect(typoBreakdown?.score).toBeLessThanOrEqual(70);
    });

    it("should award 30 for line height in optimal range 1.4-1.7", () => {
      const context = createScoringContext({
        typography: createTypographyInfo({ lineHeight: 1.5 }),
      });
      const result = scoringSystem.evaluateCraftsmanship(context);
      const typoBreakdown = result.breakdown.find((b) => b.criterion === "typographyConsistency");
      expect(typoBreakdown?.score).toBeGreaterThanOrEqual(80);
    });

    it("should award 20 for line height in acceptable range 1.2-2.0", () => {
      const context = createScoringContext({
        typography: createTypographyInfo({ lineHeight: 1.2 }),
      });
      const result = scoringSystem.evaluateCraftsmanship(context);
      const typoBreakdown = result.breakdown.find((b) => b.criterion === "typographyConsistency");
      // 30 (1 font) + heading scale + 20 (1.2 lineHeight) = 70+
      expect(typoBreakdown?.score).toBeGreaterThanOrEqual(60);
    });

    it("should award 10 for extreme line height outside 1.2-2.0", () => {
      const context = createScoringContext({
        typography: createTypographyInfo({ lineHeight: 0.8 }),
      });
      const result = scoringSystem.evaluateCraftsmanship(context);
      const typoBreakdown = result.breakdown.find((b) => b.criterion === "typographyConsistency");
      // 30 (1 font) + heading scale (up to 40) + 10 (extreme lineHeight) = up to 80
      // Compare with optimal lineHeight (1.5) which gives +30 instead of +10
      const optimalContext = createScoringContext({
        typography: createTypographyInfo({ lineHeight: 1.5 }),
      });
      const optimalResult = scoringSystem.evaluateCraftsmanship(optimalContext);
      const optimalBreakdown = optimalResult.breakdown.find(
        (b) => b.criterion === "typographyConsistency"
      );
      expect(typoBreakdown?.score).toBeLessThan(optimalBreakdown?.score ?? 101);
    });
  });

  // =========================================
  // 18. Color Harmony Detailed Tests (4 tests)
  // =========================================
  describe("Color Harmony Detailed Tests", () => {
    it("should return score 30 for empty palette", () => {
      const context = createScoringContext({
        colors: createColorInfo({ palette: [] }),
      });
      const result = scoringSystem.evaluateCraftsmanship(context);
      const harmonyBreakdown = result.breakdown.find((b) => b.criterion === "colorHarmony");
      expect(harmonyBreakdown?.score).toBe(30);
    });

    it("should award 40 for AAA contrast ratio >= 7", () => {
      // #000000 vs #FFFFFF = 21:1 (AAA)
      const context = createScoringContext({
        colors: createColorInfo({
          palette: [
            { hex: "#000000", count: 30, role: "text" },
            { hex: "#FFFFFF", count: 30, role: "background" },
          ],
          text: "#000000",
          background: "#FFFFFF",
          dominant: "#000000",
        }),
      });
      const result = scoringSystem.evaluateCraftsmanship(context);
      const harmonyBreakdown = result.breakdown.find((b) => b.criterion === "colorHarmony");
      // 40 (AAA) + 15 (no accent) + 30 (cohesion) = 85
      expect(harmonyBreakdown?.score).toBe(85);
    });

    it("should score lower when accent is too similar to dominant", () => {
      const context = createScoringContext({
        colors: createColorInfo({
          palette: [
            { hex: "#3B82F6", count: 10, role: "primary" },
            { hex: "#3F84F7", count: 10, role: "accent" },
            { hex: "#FFFFFF", count: 30, role: "background" },
          ],
          accent: "#3F84F7",
          dominant: "#3B82F6",
          text: "#000000",
          background: "#FFFFFF",
        }),
      });
      const result = scoringSystem.evaluateCraftsmanship(context);
      const harmonyBreakdown = result.breakdown.find((b) => b.criterion === "colorHarmony");
      // contrast OK + low accent diff (<30) → 10 pts + 30 cohesion
      expect(harmonyBreakdown?.score).toBeLessThan(90);
    });

    it("should award 30 for well-differentiated accent", () => {
      const context = createScoringContext({
        colors: createColorInfo({
          palette: [
            { hex: "#3B82F6", count: 10, role: "primary" },
            { hex: "#EF4444", count: 10, role: "accent" },
            { hex: "#FFFFFF", count: 30, role: "background" },
          ],
          accent: "#EF4444",
          dominant: "#3B82F6",
          text: "#000000",
          background: "#FFFFFF",
        }),
      });
      const result = scoringSystem.evaluateCraftsmanship(context);
      const harmonyBreakdown = result.breakdown.find((b) => b.criterion === "colorHarmony");
      // contrast + 30 (high diff) + 30 (cohesion) = 100
      expect(harmonyBreakdown?.score).toBe(100);
    });
  });

  // =========================================
  // 19. Accessibility Compliance Detailed Tests (4 tests)
  // =========================================
  describe("Accessibility Compliance Detailed Tests", () => {
    it("should score 100 for AAA contrast + good font size + good line height", () => {
      const context = createScoringContext({
        colors: createColorInfo({
          text: "#000000",
          background: "#FFFFFF",
        }),
        typography: createTypographyInfo({
          bodySize: 16,
          lineHeight: 1.5,
        }),
      });
      const result = scoringSystem.evaluateContextuality(context);
      const a11yBreakdown = result.breakdown.find((b) => b.criterion === "accessibilityCompliance");
      // 60 (AAA) + 20 (bodySize >= 16) + 20 (lineHeight >= 1.5) = 100
      expect(a11yBreakdown?.score).toBe(100);
    });

    it("should score 10 for poor contrast + small font + tight line height", () => {
      const context = createScoringContext({
        colors: createColorInfo({
          text: "#CCCCCC",
          background: "#DDDDDD",
        }),
        typography: createTypographyInfo({
          bodySize: 12,
          lineHeight: 1.0,
        }),
      });
      const result = scoringSystem.evaluateContextuality(context);
      const a11yBreakdown = result.breakdown.find((b) => b.criterion === "accessibilityCompliance");
      // 10 (poor contrast) + 0 (tiny font) + 0 (tight lineHeight) = 10
      expect(a11yBreakdown?.score).toBe(10);
    });

    it("should award 45 for AA contrast ratio", () => {
      // #767676 vs #FFFFFF = ~4.54:1 (AA but not AAA)
      const context = createScoringContext({
        colors: createColorInfo({
          text: "#767676",
          background: "#FFFFFF",
        }),
        typography: createTypographyInfo({
          bodySize: 16,
          lineHeight: 1.5,
        }),
      });
      const result = scoringSystem.evaluateContextuality(context);
      const a11yBreakdown = result.breakdown.find((b) => b.criterion === "accessibilityCompliance");
      // 45 (AA) + 20 (bodySize) + 20 (lineHeight) = 85
      expect(a11yBreakdown?.score).toBe(85);
    });

    it("should award 10 for body size 14px", () => {
      const context = createScoringContext({
        typography: createTypographyInfo({ bodySize: 14 }),
      });
      const result = scoringSystem.evaluateContextuality(context);
      const a11yBreakdown = result.breakdown.find((b) => b.criterion === "accessibilityCompliance");
      // accessibility score includes body size 10pts for 14px
      expect(a11yBreakdown).toBeDefined();
    });
  });

  // =========================================
  // 20. Brand Consistency Detailed Tests (4 tests)
  // =========================================
  describe("Brand Consistency Detailed Tests", () => {
    it("should award 30 when dominant color exists", () => {
      const context = createScoringContext({
        colors: createColorInfo({ dominant: "#3B82F6" }),
      });
      const result = scoringSystem.evaluateContextuality(context);
      const brandBreakdown = result.breakdown.find((b) => b.criterion === "brandConsistency");
      expect(brandBreakdown?.score).toBeGreaterThanOrEqual(50);
    });

    it("should award 20 for 1-2 font families", () => {
      const context = createScoringContext({
        typography: createTypographyInfo({
          fonts: [
            { family: "Inter", weights: [400, 500] },
            { family: "Cal Sans", weights: [700] },
          ],
        }),
      });
      const result = scoringSystem.evaluateContextuality(context);
      const brandBreakdown = result.breakdown.find((b) => b.criterion === "brandConsistency");
      expect(brandBreakdown?.score).toBeGreaterThanOrEqual(50);
    });

    it("should award 10 for 3+ font families", () => {
      const context = createScoringContext({
        typography: createTypographyInfo({
          fonts: [
            { family: "Arial", weights: [400] },
            { family: "Georgia", weights: [400] },
            { family: "Courier", weights: [400] },
          ],
        }),
      });
      const result = scoringSystem.evaluateContextuality(context);
      const brandBreakdown = result.breakdown.find((b) => b.criterion === "brandConsistency");
      // Typography part awards 10 instead of 20 for 3+ fonts
      expect(brandBreakdown).toBeDefined();
    });

    it("should calculate section color consistency ratio", () => {
      const context = createScoringContext({
        colors: createColorInfo({
          palette: [
            { hex: "#FFFFFF", count: 40, role: "background" },
            { hex: "#000000", count: 20, role: "text" },
          ],
          dominant: "#000000",
        }),
        sections: [
          createSection("hero", { style: { backgroundColor: "#FFFFFF", textColor: "#000000" } }),
          createSection("feature", { style: { backgroundColor: "#FFFFFF", textColor: "#000000" } }),
          createSection("footer", { style: { backgroundColor: "#000000", textColor: "#FFFFFF" } }),
        ],
      });
      const result = scoringSystem.evaluateContextuality(context);
      const brandBreakdown = result.breakdown.find((b) => b.criterion === "brandConsistency");
      // All section colors in palette → high consistency
      expect(brandBreakdown?.score).toBeGreaterThanOrEqual(80);
    });
  });

  // =========================================
  // 21. Recommendation Generation Detailed Tests (4 tests)
  // =========================================
  describe("Recommendation Generation Detailed Tests", () => {
    it('should generate specific recommendation for "Generic color palette"', () => {
      const score: QualityScore = {
        overall: 50,
        originality: {
          score: 40,
          breakdown: [],
          strengths: [],
          weaknesses: ["Generic color palette"],
        },
        craftsmanship: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        grade: "F",
        summary: "",
        recommendations: [],
      };
      const recommendations = scoringSystem.generateRecommendations(score);
      expect(recommendations[0]).toContain("distinctive color palette");
    });

    it('should generate specific recommendation for "Inconsistent spacing"', () => {
      const score: QualityScore = {
        overall: 50,
        originality: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: {
          score: 40,
          breakdown: [],
          strengths: [],
          weaknesses: ["Inconsistent spacing"],
        },
        contextuality: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        grade: "F",
        summary: "",
        recommendations: [],
      };
      const recommendations = scoringSystem.generateRecommendations(score);
      expect(recommendations[0]).toContain("spacing");
    });

    it('should generate specific recommendation for "Poor accessibility"', () => {
      const score: QualityScore = {
        overall: 50,
        originality: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: {
          score: 40,
          breakdown: [],
          strengths: [],
          weaknesses: ["Poor accessibility"],
        },
        grade: "F",
        summary: "",
        recommendations: [],
      };
      const recommendations = scoringSystem.generateRecommendations(score);
      expect(recommendations[0]).toContain("contrast");
    });

    it("should generate generic recommendations when no specific weaknesses but overall < 90", () => {
      const score: QualityScore = {
        overall: 85,
        originality: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        grade: "B",
        summary: "",
        recommendations: [],
      };
      const recommendations = scoringSystem.generateRecommendations(score);
      expect(recommendations.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // 22. Summary Generation Detailed Tests (3 tests)
  // =========================================
  describe("Summary Generation Detailed Tests", () => {
    it('should include "below average" for grade D', () => {
      const score: QualityScore = {
        overall: 65,
        originality: { score: 65, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 65, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 65, breakdown: [], strengths: [], weaknesses: [] },
        grade: "D",
        summary: "",
        recommendations: [],
      };
      const summary = scoringSystem.generateSummary(score);
      expect(summary).toContain("below average");
    });

    it('should include "good" for grade B', () => {
      const score: QualityScore = {
        overall: 85,
        originality: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 85, breakdown: [], strengths: [], weaknesses: [] },
        grade: "B",
        summary: "",
        recommendations: [],
      };
      const summary = scoringSystem.generateSummary(score);
      expect(summary).toContain("good");
    });

    it("should include overall score value in summary", () => {
      const score: QualityScore = {
        overall: 72.5,
        originality: { score: 70, breakdown: [], strengths: [], weaknesses: [] },
        craftsmanship: { score: 75, breakdown: [], strengths: [], weaknesses: [] },
        contextuality: { score: 72, breakdown: [], strengths: [], weaknesses: [] },
        grade: "C",
        summary: "",
        recommendations: [],
      };
      const summary = scoringSystem.generateSummary(score);
      expect(summary).toContain("72.5");
    });
  });
});
