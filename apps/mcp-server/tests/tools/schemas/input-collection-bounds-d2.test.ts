// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 入力配列の上限 (style.get_palette / layout.search / layout.ingest / quality.evaluate /
 * motion.detect / motion.search / page.analyze)
 *
 * Input array bounds for the seven tools above. For every bounded field:
 *   - Zod accepts exactly N items and rejects N + 1
 *   - the hand-written JSON Schema advertises `maxItems: N` (when the property is advertised)
 *   - for enum-element arrays N equals the enum's option count
 */

import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import { allToolDefinitions } from "../../../src/tools/index";
import { styleGetPaletteInputSchema } from "../../../src/tools/schemas/style-schemas";
import {
  layoutSearchInputSchema,
  layoutIngestInputSchema,
} from "../../../src/tools/layout/schemas";
import {
  qualityEvaluateInputSchema,
  improvementCategorySchema,
} from "../../../src/tools/quality/schemas";
import {
  motionDetectInputSchema,
  lighthouseCategorySchema,
} from "../../../src/tools/motion/detect.schemas";
import { motionSearchInputSchema } from "../../../src/tools/motion/search.schemas";
import { pageAnalyzeInputSchema } from "../../../src/tools/page/input.schemas";
import { collectJsonArrays } from "../../regression/standing/schema-enum-sync/_zod-array-paths";

const viewport = (i: number): { name: string; width: number; height: number } => ({
  name: `vp${i}`,
  width: 800,
  height: 600,
});
const cycle = <T>(values: readonly T[], n: number): T[] =>
  Array.from({ length: n }, (_, i) => values[i % values.length] as T);
const strings = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i}`);

interface BoundCase {
  readonly label: string;
  readonly tool: string;
  readonly schema: ZodType;
  readonly max: number;
  /** n 件のときの入力 / input carrying n items in the field under test */
  readonly build: (n: number) => unknown;
  /** エラー path の先頭 / leading issue path of the field */
  readonly issuePath: readonly string[];
  /** tool 定義 inputSchema 内の位置。広告されていなければ null / JSON path, or null if not advertised */
  readonly jsonPath: string | null;
  /** enum 要素の場合の件数根拠 / option count when the elements are an enum */
  readonly enumCount?: number;
}

const generatePattern = (properties: unknown): unknown => ({
  action: "generate",
  pattern: { type: "animation", name: "fade", properties },
});

const CASES: readonly BoundCase[] = [
  {
    label: "style.get_palette gradient_options.token_pairs",
    tool: "style.get_palette",
    schema: styleGetPaletteInputSchema,
    max: 20,
    build: (n) => ({
      gradient_options: { token_pairs: Array.from({ length: n }, () => ["a", "b"]) },
    }),
    issuePath: ["gradient_options", "token_pairs"],
    jsonPath: "gradient_options.token_pairs",
  },
  {
    label: "layout.search vision_search_query.visualFeatures.colors",
    tool: "layout.search",
    schema: layoutSearchInputSchema,
    max: 10,
    build: (n) => ({
      query: "hero",
      vision_search_query: { visualFeatures: { colors: strings(n) } },
    }),
    issuePath: ["vision_search_query", "visualFeatures", "colors"],
    jsonPath: "vision_search_query.visualFeatures.colors",
  },
  {
    label: "layout.ingest options.responsive.viewports",
    tool: "layout.ingest",
    schema: layoutIngestInputSchema,
    max: 10,
    build: (n) => ({
      url: "https://example.com",
      options: {
        responsive: { enabled: true, viewports: Array.from({ length: n }, (_, i) => viewport(i)) },
      },
    }),
    issuePath: ["options", "responsive", "viewports"],
    jsonPath: "options.responsive.viewports",
  },
  {
    label: "quality.evaluate responsive_evaluation.viewports",
    tool: "quality.evaluate",
    schema: qualityEvaluateInputSchema,
    max: 10,
    build: (n) => ({
      html: "<p>x</p>",
      responsive_evaluation: {
        enabled: true,
        viewports: Array.from({ length: n }, (_, i) => viewport(i)),
      },
    }),
    issuePath: ["responsive_evaluation", "viewports"],
    jsonPath: "responsive_evaluation.viewports",
  },
  {
    label: "quality.evaluate categories",
    tool: "quality.evaluate",
    schema: qualityEvaluateInputSchema,
    max: 6,
    build: (n) => ({ html: "<p>x</p>", categories: cycle(improvementCategorySchema.options, n) }),
    issuePath: ["categories"],
    jsonPath: null,
    enumCount: improvementCategorySchema.options.length,
  },
  {
    label: "motion.detect lighthouse_options.categories",
    tool: "motion.detect",
    schema: motionDetectInputSchema,
    max: 4,
    build: (n) => ({
      url: "https://example.com",
      lighthouse_options: { enabled: true, categories: cycle(lighthouseCategorySchema.options, n) },
    }),
    issuePath: ["lighthouse_options", "categories"],
    jsonPath: null,
    enumCount: lighthouseCategorySchema.options.length,
  },
  {
    label: "motion.search samplePattern.properties",
    tool: "motion.search",
    schema: motionSearchInputSchema,
    max: 50,
    build: (n) => ({ samplePattern: { properties: strings(n) } }),
    issuePath: ["samplePattern", "properties"],
    jsonPath: "samplePattern.properties",
  },
  {
    label: "motion.search pattern.properties",
    tool: "motion.search",
    schema: motionSearchInputSchema,
    max: 50,
    build: (n) =>
      generatePattern(Array.from({ length: n }, (_, i) => ({ name: `p${i}`, from: "0", to: "1" }))),
    issuePath: ["pattern", "properties"],
    jsonPath: "pattern.properties",
  },
  {
    label: "motion.search pattern.properties[].keyframes",
    tool: "motion.search",
    schema: motionSearchInputSchema,
    max: 100,
    build: (n) =>
      generatePattern([
        {
          name: "opacity",
          from: "0",
          to: "1",
          keyframes: Array.from({ length: n }, () => ({ offset: 0.5, value: "0.5" })),
        },
      ]),
    issuePath: ["pattern", "properties", "0", "keyframes"],
    jsonPath: "pattern.properties[].keyframes",
  },
  {
    label: "motion.search generation_options.project_css_paths",
    tool: "motion.search",
    schema: motionSearchInputSchema,
    max: 20,
    build: (n) => ({
      ...(generatePattern([{ name: "opacity", from: "0", to: "1" }]) as object),
      generation_options: { project_css_paths: strings(n) },
    }),
    issuePath: ["generation_options", "project_css_paths"],
    jsonPath: null,
  },
  {
    label: "page.analyze responsiveOptions.viewports",
    tool: "page.analyze",
    schema: pageAnalyzeInputSchema,
    max: 10,
    build: (n) => ({
      url: "https://example.com",
      responsiveOptions: {
        enabled: true,
        viewports: Array.from({ length: n }, (_, i) => viewport(i)),
      },
    }),
    issuePath: ["responsiveOptions", "viewports"],
    jsonPath: "responsiveOptions.viewports",
  },
];

describe("input collection bounds (style/layout/quality/motion/page)", () => {
  for (const c of CASES) {
    describe(c.label, () => {
      it(`Zod accepts exactly ${c.max} items`, () => {
        const result = c.schema.safeParse(c.build(c.max));
        expect(result.success, result.success ? "" : JSON.stringify(result.error.issues)).toBe(
          true
        );
      });

      it(`Zod rejects ${c.max + 1} items at the field`, () => {
        const result = c.schema.safeParse(c.build(c.max + 1));
        expect(result.success).toBe(false);
        if (!result.success) {
          const hit = result.error.issues.some((i) =>
            c.issuePath.every((seg, idx) => String(i.path[idx]) === seg)
          );
          expect(hit, JSON.stringify(result.error.issues)).toBe(true);
        }
      });

      if (c.jsonPath !== null) {
        const jsonPath = c.jsonPath;
        it(`JSON Schema advertises maxItems ${c.max}`, () => {
          const def = allToolDefinitions.find((d) => d.name === c.tool);
          expect(def).toBeDefined();
          const found = collectJsonArrays(def?.inputSchema).find((a) => a.path === jsonPath);
          expect(found, `JSON array not found: ${jsonPath}`).toBeDefined();
          expect(found?.max).toBe(c.max);
        });
      } else {
        it("property is not advertised in the JSON Schema (tracked, see IO-D-05)", () => {
          expect(c.jsonPath).toBeNull();
        });
      }

      if (c.enumCount !== undefined) {
        it("max equals the enum option count", () => {
          expect(c.max).toBe(c.enumCount);
        });
      }
    });
  }
});
