// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: schema-enum-sync (zod 4 prep contract)
 *
 * INV-ZOD-NESTED-DEFAULT-FULL-OBJECT-001: an omitted option object is filled by a default that
 * carries every nested default, byte for byte (key order included). zod 3 parses a default through
 * the inner schema, so `.optional().default({})` still fills them; zod 4 returns the default as
 * given and would drop them. The golden strings are the zod 3 output.
 *
 *  (a) the four page.analyze option defaults that were partial objects
 *  (b) the other object / array defaults now returned by a function
 *  (c) a default is a new value on every parse
 */
import { describe, it, expect } from "vitest";

import { lighthouseOptionsSchema } from "../../src/tools/motion/detect.schemas";
import { analyzeFramesInputSchema } from "../../src/tools/motion/analyze-frames.schema";
import { designCompareInputSchema } from "../../src/tools/design/compare.tool";
import { batchAnalyzeInputSchema } from "../../src/tools/page/batch-analyze.schemas";
import {
  analysisFeaturesSchema,
  motionOptionsSchema,
  narrativeOptionsSchema,
  pageAnalyzeInputSchema,
} from "../../src/tools/page/input.schemas";
import {
  partCompareInputSchema,
  partExtractionConfigSchema,
} from "../../src/services/part/schemas";

const UUID = "019bc123-4567-7890-abcd-ef1234567890";

/** Golden strings are the zod 3 output; JSON.stringify keeps the key order in the comparison. */
const GOLDEN = {
  motionOptions:
    '{"detection_mode":"css","fetchExternalCss":true,"minDuration":0,"maxPatterns":500,"includeWarnings":true,"saveToDb":true,"enable_frame_capture":false,"analyze_frames":false,"detect_js_animations":true,"detect_webgl_animations":true,"timeout":300000}',
  responsiveOptions:
    '{"enabled":true,"include_screenshots":false,"include_diff_images":false,"diff_threshold":0.1,"save_to_db":true,"detect_navigation":true,"detect_visibility":true,"detect_layout":true,"breakpoint_resolution":"range"}',
  accessibilityOptions: '{"enabled":false,"level":"AA","include_contrast":true,"save_to_db":true}',
  performanceOptions: '{"enabled":false,"include_screenshots":false,"save_to_db":true}',
  analysisFeatures: '{"layout":true,"motion":true,"quality":true}',
  narrativeOptions:
    '{"enabled":true,"saveToDb":true,"includeVision":true,"visionTimeoutMs":300000,"generateEmbedding":true}',
  batchFeatures: '{"layout":true,"motion":true,"quality":true}',
  lighthouseCategories: '["performance"]',
  partCompareAspects: '["styles","layout"]',
  partTypes:
    '["button","link","image","video","form","input","heading","card","navigation","footer","cta","hero_image","icon","badge","tag","avatar"]',
  designCompareDimensions: '["layout","visual","quality","color"]',
  analysisTypes: '["frame_diff","layout_shift"]',
} as const;

const ser = (v: unknown): string => JSON.stringify(v);
const pageDefaults = (): Record<string, unknown> =>
  pageAnalyzeInputSchema.parse({ url: "https://example.com" }) as unknown as Record<
    string,
    unknown
  >;

describe("INV-ZOD-NESTED-DEFAULT-FULL-OBJECT-001", () => {
  describe("(a) page.analyze option defaults carry every nested default", () => {
    it("motionOptions (schema parsed on its own and inside page.analyze input)", () => {
      expect(ser(motionOptionsSchema.parse(undefined))).toBe(GOLDEN.motionOptions);
      expect(ser(pageDefaults().motionOptions)).toBe(GOLDEN.motionOptions);
    });
    it("responsiveOptions", () => {
      expect(ser(pageDefaults().responsiveOptions)).toBe(GOLDEN.responsiveOptions);
    });
    it("accessibilityOptions", () => {
      expect(ser(pageDefaults().accessibilityOptions)).toBe(GOLDEN.accessibilityOptions);
    });
    it("performanceOptions", () => {
      expect(ser(pageDefaults().performanceOptions)).toBe(GOLDEN.performanceOptions);
    });
    it("explicit partial input still gets the nested defaults filled", () => {
      const out = pageAnalyzeInputSchema.parse({
        url: "https://example.com",
        responsiveOptions: { enabled: false },
        accessibilityOptions: { enabled: true },
        performanceOptions: { enabled: true },
        motionOptions: {},
      }) as unknown as Record<string, Record<string, unknown>>;
      expect(out.responsiveOptions).toMatchObject({ enabled: false, diff_threshold: 0.1 });
      expect(out.accessibilityOptions).toMatchObject({ enabled: true, level: "AA" });
      expect(out.performanceOptions).toMatchObject({ enabled: true, save_to_db: true });
      expect(ser(out.motionOptions)).toBe(GOLDEN.motionOptions);
    });
  });

  describe("(b) the remaining object / array defaults keep their value", () => {
    it("analysisFeatures", () => {
      expect(ser(analysisFeaturesSchema.parse(undefined))).toBe(GOLDEN.analysisFeatures);
    });
    it("narrativeOptions", () => {
      expect(ser(narrativeOptionsSchema.parse(undefined))).toBe(GOLDEN.narrativeOptions);
    });
    it("batch_analyze features", () => {
      const out = batchAnalyzeInputSchema.parse({ urls: ["https://example.com"] }) as unknown as {
        features: unknown;
      };
      expect(ser(out.features)).toBe(GOLDEN.batchFeatures);
    });
    it("lighthouse categories", () => {
      expect(ser(lighthouseOptionsSchema.parse({ enabled: false }).categories)).toBe(
        GOLDEN.lighthouseCategories
      );
    });
    it("part.compare compare_aspects", () => {
      expect(ser(partCompareInputSchema.parse({ part_ids: [UUID, UUID] }).compare_aspects)).toBe(
        GOLDEN.partCompareAspects
      );
    });
    it("part extraction partTypes", () => {
      expect(ser(partExtractionConfigSchema.parse({}).partTypes)).toBe(GOLDEN.partTypes);
    });
    it("design.compare dimensions", () => {
      expect(ser(designCompareInputSchema.parse({ page_ids: [UUID, UUID] }).dimensions)).toBe(
        GOLDEN.designCompareDimensions
      );
    });
    it("motion.analyze_frames analysis_types", () => {
      expect(ser(analyzeFramesInputSchema.parse({ frame_dir: "frames" }).analysis_types)).toBe(
        GOLDEN.analysisTypes
      );
    });
  });

  describe("(d) IO-C3-01: the default and parsing an empty object give the same output", () => {
    it.each(["motionOptions", "responsiveOptions", "accessibilityOptions", "performanceOptions"])(
      "page.analyze %s: omitted equals {}",
      (key) => {
        const given = pageAnalyzeInputSchema.parse({
          url: "https://example.com",
          [key]: {},
        }) as unknown as Record<string, unknown>;
        expect(ser(pageDefaults()[key])).toBe(ser(given[key]));
      }
    );
    it("analysisFeatures and narrativeOptions: undefined equals {}", () => {
      expect(ser(analysisFeaturesSchema.parse(undefined))).toBe(
        ser(analysisFeaturesSchema.parse({}))
      );
      expect(ser(narrativeOptionsSchema.parse(undefined))).toBe(
        ser(narrativeOptionsSchema.parse({}))
      );
    });
  });

  describe("(c) a default is a new value on every parse", () => {
    it("object defaults: two parses never return the same reference, and a write does not carry over", () => {
      const first = pageDefaults();
      const second = pageDefaults();
      for (const key of ["motionOptions", "responsiveOptions", "accessibilityOptions"]) {
        expect(first[key]).not.toBe(second[key]);
      }
      (first.motionOptions as Record<string, unknown>).maxPatterns = 1;
      expect(ser(pageDefaults().motionOptions)).toBe(GOLDEN.motionOptions);
    });

    it("lighthouse categories (array default): two parses never return the same reference", () => {
      const cats = lighthouseOptionsSchema.parse({ enabled: false }).categories;
      expect(cats).not.toBe(lighthouseOptionsSchema.parse({ enabled: false }).categories);
    });

    it("part.compare compare_aspects (array default): a write does not carry over", () => {
      const aspects = partCompareInputSchema.parse({ part_ids: [UUID, UUID] }).compare_aspects;
      aspects.push("accessibility");
      expect(ser(partCompareInputSchema.parse({ part_ids: [UUID, UUID] }).compare_aspects)).toBe(
        GOLDEN.partCompareAspects
      );
    });
  });
});
