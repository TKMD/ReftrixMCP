// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-ZOD-ADVERTISED-MAXITEMS-SYNC-001
 *
 * **Zod の配列上限と、AI クライアントに広告する JSON Schema の maxItems の同期**
 * **Zod array bounds ⇔ advertised JSON Schema `maxItems`**
 *
 * 契約 / Contract:
 *   - 登録 tool の入力 Zod スキーマに含まれる全 z.array について、(tool, 位置) ごとに
 *     「Zod に上限あり ⇔ tool 定義の JSON Schema に同じ値の maxItems」が成り立つ。
 *     For every z.array reachable from a registered tool's input Zod schema, per
 *     (tool, position): Zod bounded ⇔ the tool definition's JSON Schema advertises the same maxItems.
 *   - JSON Schema にプロパティ自体が無い (未広告の) 組は JSON_ABSENT_ALLOWLIST に理由付きで
 *     件数固定で列挙する。増えたら fail (無言で増やせない)。
 *     Pairs whose property is not advertised at all live in a count-fixed, reason-annotated allowlist.
 *   - JSON Schema にだけ存在する配列は fail (Zod 側に検証が無い)。
 *     A JSON Schema array with no Zod counterpart fails.
 *   - 固定長タプルは別カウント (件数 assert のみ)。
 *     Fixed-length tuples are counted separately.
 *
 * 件数の注記 / Count note: U2 registry は 44 対としていたが、その内 4 対は registry の AST 走査で
 * 同じ宣言を重ねて数えたもの (推定。motion.search の properties 3 件と narrative.search の (root) 1 件。
 * 宣言数 36 は不変)。実行時スキーマの
 * 実測では (tool, 位置) の異なる配列は 40 対 + タプル 1。JSON 側に無い対は 9 ではなく 5。
 * The U2 registry counted 44 pairs; 4 of them are, by estimate, the same declarations counted more
 * than once by the registry's AST walk (the 36 declarations are unchanged). The runtime walk measures 40 distinct (tool, position) array pairs + 1 tuple, of which
 * 5 are not advertised in the JSON Schema.
 *
 * 完全性 (全 z.array に上限があること) は INV-ZOD-INPUT-COLLECTION-BOUNDED-002 の責務。
 * Completeness (every array bounded) belongs to INV-ZOD-INPUT-COLLECTION-BOUNDED-002.
 *
 * @see apps/mcp-server/tests/tools/schemas/input-collection-bounds-d2.test.ts (per-field N / N+1)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import { allToolDefinitions } from "../../../../src/tools/index";
import { collectJsonArrays, collectZodArrays, type ArrayBound } from "./_zod-array-paths";
import { searchUnifiedInputSchema } from "../../../../src/tools/search-unified.tool";
import { searchFacetsInputSchema } from "../../../../src/tools/search/facets.tool";
import {
  partCompareInputSchema,
  partSearchInputSchema,
} from "../../../../src/services/part/schemas";
import { briefValidateInputSchema } from "../../../../src/tools/brief/schemas";
import { designCompareInputSchema } from "../../../../src/tools/design/compare.tool";
import { dataDeleteInputSchema } from "../../../../src/tools/data/data.tool";
import { designTrackChangesInputSchema } from "../../../../src/tools/design/track-changes.tool";
import {
  layoutSearchInputSchema,
  layoutIngestInputSchema,
  layoutBatchIngestInputSchema,
} from "../../../../src/tools/layout/schemas";
import { motionDetectInputSchema } from "../../../../src/tools/motion/detect.schemas";
import { motionSearchInputSchema } from "../../../../src/tools/motion/search.schemas";
import { narrativeSearchInputSchema } from "../../../../src/tools/narrative/schemas";
import { pageAnalyzeInputSchema } from "../../../../src/tools/page/input.schemas";
import { batchAnalyzeInputSchema } from "../../../../src/tools/page/batch-analyze.schemas";
import { preferenceHearInputSchema } from "../../../../src/tools/preference/schemas";
import { qualityEvaluateInputSchema } from "../../../../src/tools/quality/schemas";
import { responsiveCaptureInputSchema } from "../../../../src/tools/responsive/capture.schemas";
import { responsiveSearchInputSchema } from "../../../../src/tools/responsive/schemas";
import { backgroundSearchInputSchema } from "../../../../src/tools/background/schemas";
import { styleGetPaletteInputSchema } from "../../../../src/tools/schemas/style-schemas";

const INV = "INV-ZOD-ADVERTISED-MAXITEMS-SYNC-001";

/** tool 名 → 入力 Zod スキーマ (handler が .parse するもの) / tool name → input Zod schema */
const TOOL_INPUT_SCHEMAS: Readonly<Record<string, unknown>> = {
  "search.unified": searchUnifiedInputSchema,
  "search.facets": searchFacetsInputSchema,
  "part.search": partSearchInputSchema,
  "part.compare": partCompareInputSchema,
  "brief.validate": briefValidateInputSchema,
  "design.compare": designCompareInputSchema,
  "design.track_changes": designTrackChangesInputSchema,
  "data.delete": dataDeleteInputSchema,
  "layout.search": layoutSearchInputSchema,
  "layout.ingest": layoutIngestInputSchema,
  "layout.batch_ingest": layoutBatchIngestInputSchema,
  "motion.detect": motionDetectInputSchema,
  "motion.search": motionSearchInputSchema,
  "narrative.search": narrativeSearchInputSchema,
  "page.analyze": pageAnalyzeInputSchema,
  "page.batch_analyze": batchAnalyzeInputSchema,
  "preference.hear": preferenceHearInputSchema,
  "quality.evaluate": qualityEvaluateInputSchema,
  "responsive.capture": responsiveCaptureInputSchema,
  "responsive.search": responsiveSearchInputSchema,
  "background.search": backgroundSearchInputSchema,
  "style.get_palette": styleGetPaletteInputSchema,
};

/** 実測値 (件数固定) / measured counts (fixed) */
const EXPECTED_ARRAY_PAIRS = 40;
const EXPECTED_TUPLES = 1;

/**
 * Zod には上限があるが、JSON Schema (tool 定義) にプロパティ自体が無い組。
 * JSON には追加しない (隠れた引数を公開するのは API 面の新しい判断で、別途 tracked)。
 * Pairs bounded in Zod whose property is not advertised in the tool definition at all.
 * Not added to the JSON (publishing hidden arguments is a separate API-surface decision; tracked
 * in
 */
const JSON_ABSENT_ALLOWLIST: Readonly<Record<string, string>> = {
  "motion.detect:runtime_options.scroll_positions":
    "runtime_options は tool 定義に未広告 / runtime_options is not advertised",
  "motion.detect:lighthouse_options.categories":
    "lighthouse_options.categories は tool 定義に未広告 / not advertised",
  "motion.search:generation_options.project_css_paths":
    "generation_options.project_css_paths は tool 定義に未広告 / not advertised",
  "page.analyze:motionOptions.runtime_options.scroll_positions":
    "motionOptions.runtime_options は tool 定義に未広告 / not advertised",
  "quality.evaluate:categories": "categories は tool 定義に未広告 / not advertised",
};
const EXPECTED_JSON_ABSENT = 5;

interface Pair {
  readonly key: string;
  readonly tool: string;
  readonly path: string;
  readonly zod: ArrayBound;
  readonly json: ArrayBound | undefined;
}

function buildPairs(): { pairs: Pair[]; jsonOnly: string[] } {
  const pairs: Pair[] = [];
  const jsonOnly: string[] = [];
  for (const [tool, schema] of Object.entries(TOOL_INPUT_SCHEMAS)) {
    const def = allToolDefinitions.find((d) => d.name === tool);
    if (!def) throw new Error(`tool definition not found: ${tool}`);
    const zodArrays = collectZodArrays(schema);
    const jsonArrays = collectJsonArrays(def.inputSchema);
    for (const zod of zodArrays) {
      pairs.push({
        key: `${tool}:${zod.path}`,
        tool,
        path: zod.path,
        zod,
        json: jsonArrays.find((j) => j.path === zod.path),
      });
    }
    for (const json of jsonArrays) {
      if (!zodArrays.some((z) => z.path === json.path)) jsonOnly.push(`${tool}:${json.path}`);
    }
  }
  return { pairs, jsonOnly };
}

describe(`${INV}: Zod array bounds match advertised JSON Schema maxItems`, () => {
  beforeEach(() => assertInvName(expect.getState().currentTestName ?? "", INV));

  const { pairs, jsonOnly } = buildPairs();
  const arrays = pairs.filter((p) => p.zod.kind === "array");
  const tuples = pairs.filter((p) => p.zod.kind === "tuple");

  it(`${INV}: measured pair counts are fixed (${EXPECTED_ARRAY_PAIRS} arrays / ${EXPECTED_TUPLES} tuple)`, () => {
    expect(arrays.length).toBe(EXPECTED_ARRAY_PAIRS);
    expect(tuples.length).toBe(EXPECTED_TUPLES);
  });

  it(`${INV}: where the JSON Schema advertises the property, Zod bound and maxItems are equal`, () => {
    const mismatches = arrays
      .filter((p) => p.json !== undefined && p.json.max !== p.zod.max)
      .map((p) => `${p.key} zod=${String(p.zod.max)} json=${String(p.json?.max)}`);
    expect(mismatches).toEqual([]);
  });

  it(`${INV}: tuples agree with the advertised fixed length`, () => {
    for (const t of tuples) {
      expect(t.json?.max, t.key).toBe(t.zod.max);
    }
  });

  it(`${INV}: not-advertised pairs are exactly the reason-annotated allowlist (count fixed at ${EXPECTED_JSON_ABSENT})`, () => {
    const absent = arrays.filter((p) => p.json === undefined).map((p) => p.key);
    expect([...absent].sort()).toEqual(Object.keys(JSON_ABSENT_ALLOWLIST).sort());
    expect(Object.keys(JSON_ABSENT_ALLOWLIST).length).toBe(EXPECTED_JSON_ABSENT);
    for (const reason of Object.values(JSON_ABSENT_ALLOWLIST))
      expect(reason.length).toBeGreaterThan(0);
  });

  it(`${INV}: every not-advertised pair is bounded in Zod (a hidden unbounded array fails)`, () => {
    const unbounded = arrays
      .filter((p) => p.json === undefined && p.zod.max === null)
      .map((p) => p.key);
    expect(unbounded).toEqual([]);
  });

  it(`${INV}: no JSON Schema array exists without a Zod counterpart`, () => {
    expect(jsonOnly).toEqual([]);
  });
});
