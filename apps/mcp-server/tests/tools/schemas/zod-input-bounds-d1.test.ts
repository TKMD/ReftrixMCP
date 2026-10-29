// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 入力コレクションの上限 (search.unified / search.facets / part.compare / brief.validate /
 * design.compare / data.delete / preference.hear)。
 *
 * 1 件ごとに次の 3 点を確かめる / for each limit:
 *   1. Zod: ちょうど上限の件数は受理、+1 件は拒否 / exactly N accepted, N+1 rejected
 *   2. JSON Schema (tool 定義 inputSchema) の maxItems が同じ値 / advertised maxItems equals N
 *   3. enum 要素の配列は `max === <enum>.options.length` / for enum arrays, max === enum size
 *
 * INV-ZOD-INPUT-COLLECTION-BOUNDED-002 (standing/schema-enum-sync) が「全 collection に上限がある」
 * ことを AST で見張り、本ファイルが値そのものと Zod / JSON の一致を見張る。
 */

import { describe, expect, it } from "vitest";
import { toneSchema, briefValidateInputSchema } from "../../../src/tools/brief/schemas";
import { allToolDefinitions } from "../../../src/tools/index";
import { dataDeleteInputSchema } from "../../../src/tools/data/data.tool";
import {
  designCompareDimensionSchema,
  designCompareInputSchema,
} from "../../../src/tools/design/compare.tool";
import { preferenceHearInputSchema } from "../../../src/tools/preference/schemas";
import { facetFieldSchema as facetsFieldSchema } from "../../../src/tools/search/facets.tool";
import { searchFacetsInputSchema } from "../../../src/tools/search/facets.tool";
import {
  facetFieldSchema as unifiedFacetFieldSchema,
  searchTargetTypeSchema,
  searchUnifiedInputSchema,
} from "../../../src/tools/search-unified.tool";
import {
  partCompareAspectSchema,
  partCompareInputSchema,
} from "../../../src/services/part/schemas";
import type { z } from "zod";

const UUID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function jsonArrayLimit(tool: string, pathKeys: string[]): unknown {
  const def = allToolDefinitions.find((d) => d.name === tool);
  if (!def) throw new Error(`tool definition not found: ${tool}`);
  let node = def.inputSchema as unknown as Record<string, unknown>;
  for (const key of pathKeys) {
    const props = node.properties as Record<string, Record<string, unknown>> | undefined;
    const next = props?.[key];
    if (!next) throw new Error(`${tool}: JSON property ${pathKeys.join(".")} not found`);
    node = next;
  }
  expect(node.type, `${tool}.${pathKeys.join(".")} must be an array in JSON`).toBe("array");
  return node.maxItems;
}

interface BoundCase {
  label: string;
  tool: string;
  jsonPath: string[];
  schema: z.ZodType;
  max: number;
  /** enum 要素の配列のとき、その enum の件数 */
  enumSize?: number;
  /** n 件の配列を入れた、他は有効な入力 */
  build: (n: number) => unknown;
}

const repeat = <T>(value: T, n: number): T[] => Array.from({ length: n }, () => value);

const CASES: BoundCase[] = [
  {
    label: "search.unified types",
    tool: "search.unified",
    jsonPath: ["types"],
    schema: searchUnifiedInputSchema,
    max: 5,
    enumSize: searchTargetTypeSchema.options.length,
    build: (n) => ({ query: "q", types: repeat("layout", n) }),
  },
  {
    label: "search.unified facet_fields",
    tool: "search.unified",
    jsonPath: ["facet_fields"],
    schema: searchUnifiedInputSchema,
    max: 4,
    enumSize: unifiedFacetFieldSchema.options.length,
    build: (n) => ({ query: "q", facet_fields: repeat("tags", n) }),
  },
  {
    label: "search.facets facet_fields",
    tool: "search.facets",
    jsonPath: ["facet_fields"],
    schema: searchFacetsInputSchema,
    max: 4,
    enumSize: facetsFieldSchema.options.length,
    build: (n) => ({ query: "q", facet_fields: repeat("tags", n) }),
  },
  {
    label: "part.compare compare_aspects",
    tool: "part.compare",
    jsonPath: ["compare_aspects"],
    schema: partCompareInputSchema,
    max: 4,
    enumSize: partCompareAspectSchema.options.length,
    build: (n) => ({ part_ids: [UUID, UUID], compare_aspects: repeat("styles", n) }),
  },
  {
    label: "brief.validate brief.constraints.mustHave",
    tool: "brief.validate",
    jsonPath: ["brief", "constraints", "mustHave"],
    schema: briefValidateInputSchema,
    max: 20,
    build: (n) => ({ brief: { projectName: "p", constraints: { mustHave: repeat("x", n) } } }),
  },
  {
    label: "brief.validate brief.constraints.mustAvoid",
    tool: "brief.validate",
    jsonPath: ["brief", "constraints", "mustAvoid"],
    schema: briefValidateInputSchema,
    max: 20,
    build: (n) => ({ brief: { projectName: "p", constraints: { mustAvoid: repeat("x", n) } } }),
  },
  {
    label: "brief.validate brief.tone",
    tool: "brief.validate",
    jsonPath: ["brief", "tone"],
    schema: briefValidateInputSchema,
    max: 8,
    enumSize: toneSchema.options.length,
    build: (n) => ({ brief: { projectName: "p", tone: repeat("bold", n) } }),
  },
  {
    label: "design.compare dimensions",
    tool: "design.compare",
    jsonPath: ["dimensions"],
    schema: designCompareInputSchema,
    max: 4,
    enumSize: designCompareDimensionSchema.options.length,
    build: (n) => ({ page_ids: [UUID, UUID], dimensions: repeat("layout", n) }),
  },
  {
    label: "data.delete page_ids",
    tool: "data.delete",
    jsonPath: ["page_ids"],
    schema: dataDeleteInputSchema,
    max: 100,
    build: (n) => ({
      target: "all_user_data",
      id: UUID,
      reason: "gdpr",
      confirm: true,
      page_ids: repeat(UUID, n),
    }),
  },
  {
    label: "preference.hear feedback",
    tool: "preference.hear",
    jsonPath: ["feedback"],
    schema: preferenceHearInputSchema,
    max: 50,
    build: (n) => ({ feedback: repeat({ sample_id: UUID, rating: "positive" }, n) }),
  },
];

describe("D1 input collection bounds (Zod boundary + advertised maxItems)", () => {
  it("covers the 10 limits of this change", () => {
    expect(CASES).toHaveLength(10);
  });

  for (const c of CASES) {
    describe(c.label, () => {
      it(`Zod accepts exactly ${c.max} items`, () => {
        const r = c.schema.safeParse(c.build(c.max));
        expect(r.success, JSON.stringify(r.success ? null : r.error.issues)).toBe(true);
      });

      it(`Zod rejects ${c.max + 1} items`, () => {
        const r = c.schema.safeParse(c.build(c.max + 1));
        expect(r.success).toBe(false);
      });

      it(`JSON Schema advertises maxItems = ${c.max}`, () => {
        expect(jsonArrayLimit(c.tool, c.jsonPath)).toBe(c.max);
      });

      if (c.enumSize !== undefined) {
        it(`max equals the enum size (${c.enumSize})`, () => {
          expect(c.max).toBe(c.enumSize);
        });
      }
    });
  }

  it("leaves the under-limit inputs of the same shape unchanged (min boundaries intact)", () => {
    expect(searchUnifiedInputSchema.safeParse({ query: "q", types: [] }).success).toBe(false);
    expect(searchFacetsInputSchema.safeParse({ query: "q", facet_fields: [] }).success).toBe(false);
    expect(searchUnifiedInputSchema.safeParse({ query: "q", types: ["layout"] }).success).toBe(
      true
    );
  });
});
