// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: schema-enum-sync (zod 4 prep contract)
 *
 * INV-ZOD-RECORD-ENUM-KEY-001: `z.record(<enum>, v)` accepts a partial key set on zod 3 and the
 * output carries only the keys that were given. zod 4 makes every enum key required, so the
 * four sites below would reject today's valid inputs after the bump. This file fixes the zod 3
 * behaviour (the golden) and the exact set of sites, so the bump has to change them on purpose.
 *
 *  (a) the set of `z.record` calls whose key is not `z.string()` is exactly the 4 known sites (AST)
 *      - the callee is matched by its syntax (`z` . `record`), so `z\n  .record(...)` is counted
 *      - positive controls: one-line, multi-line and enum-key forms in fixture text are detected
 *      - every `z.record` call in src is counted (26, of which 2 are multi-line), so a scan that
 *        silently skips a form fails here
 *  (b) golden: a partial-key input parses to exactly the given keys at each site (unchanged since zod 3)
 *  (c) probe: zod 4 rejects the same partial input for an enum-keyed record
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";
import { z as z4 } from "zod";
import { z as z3 } from "zod/v3";

import { cssFrameworkCompositeResultSchema } from "../../src/tools/page/output.schemas";
import {
  motionSummarySchema,
  motionTypeSchema,
  triggerTypeSchema,
  motionCategorySchema,
} from "../../src/tools/motion/shared.schemas";

const SRC_ROOT = path.resolve(__dirname, "../../src");

/** The enum-keyed record sites, fixed. `key` is the property name that holds the record. */
const SITES = [
  { file: "tools/motion/shared.schemas.ts", key: "byType", keySchema: "motionTypeSchema" },
  { file: "tools/motion/shared.schemas.ts", key: "byTrigger", keySchema: "triggerTypeSchema" },
  { file: "tools/motion/shared.schemas.ts", key: "byCategory", keySchema: "motionCategorySchema" },
  {
    file: "tools/page/output.schemas.ts",
    key: "confidenceMap",
    keySchema: "cssFrameworkTypeSchema",
  },
] as const;

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") walkTs(p, out);
    } else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

interface RecordCall {
  /** property that holds the record ("" when none) */
  prop: string;
  /** key schema text, whitespace removed */
  keyText: string;
  /** the callee spans more than one line (`z\n  .record(`) */
  multiLine: boolean;
  /** `record` or `partialRecord` */
  callee: string;
}

/** `z.record` by syntax: a property access `record` on the identifier `z`, whatever the spacing. */
function isZRecordCallee(e: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "z" &&
    (e.name.text === "record" || e.name.text === "partialRecord")
  );
}

/** Every `z.record(...)` call in one source text. */
function scanRecordCalls(fileName: string, text: string): RecordCall[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: RecordCall[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && isZRecordCallee(n.expression)) {
      let prop = "";
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if (ts.isPropertyAssignment(p)) {
          prop = p.name.getText();
          break;
        }
      }
      const keyText = n.arguments.length === 2 && n.arguments[0] ? n.arguments[0].getText() : "";
      found.push({
        prop,
        keyText: keyText.replace(/\s+/g, ""),
        multiLine: /\n/.test(n.expression.getText()),
        callee: ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : "",
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** A two-argument record whose key is not a bare `z.string()`. */
function isEnumKeyed(r: RecordCall): boolean {
  return r.keyText !== "" && r.keyText !== "z.string()";
}

/** Every `z.record` call under src, as `file:property:keyText` with a multi-line flag. */
function allRecordCalls(): Array<RecordCall & { file: string }> {
  const out: Array<RecordCall & { file: string }> = [];
  for (const f of walkTs(SRC_ROOT)) {
    for (const r of scanRecordCalls(f, fs.readFileSync(f, "utf8"))) {
      out.push({ ...r, file: path.relative(SRC_ROOT, f) });
    }
  }
  return out;
}

/** Every `z.record(A, B)` whose A is not a bare `z.string()`, as `file:property:keyText`. */
function enumKeyedRecords(): string[] {
  return allRecordCalls()
    .filter(isEnumKeyed)
    .map((r) => `${r.file}:${r.prop}:${r.keyText}`)
    .sort();
}

/** Total `z.record` calls in src, and the multi-line ones (fixed so a skipped form fails). */
const TOTAL_RECORD_CALLS = 26;
const MULTI_LINE_RECORD_CALLS = [
  { file: "tools/motion/shared.schemas.ts", key: "rotationAngles" },
  { file: "tools/narrative/schemas.ts", key: "css_variables" },
] as const;

const BASE_SUMMARY = {
  totalPatterns: 1,
  averageDuration: 1,
  hasInfiniteAnimations: false,
  complexityScore: 1,
};

describe("INV-ZOD-RECORD-ENUM-KEY-001", () => {
  describe("(a) the enum-keyed z.record sites are exactly the 4 fixed ones", () => {
    it("matches the 4 fixed sites", () => {
      expect(enumKeyedRecords()).toEqual(
        SITES.map((s) => `${s.file.replace(/\//g, path.sep)}:${s.key}:${s.keySchema}`).sort()
      );
    });

    it("every enum-keyed site is z.partialRecord (zod 4 z.record requires every enum key)", () => {
      const calls = allRecordCalls().filter(isEnumKeyed);
      expect(calls).toHaveLength(SITES.length);
      expect(calls.map((c) => c.callee)).toEqual(calls.map(() => "partialRecord"));
    });

    it("positive control: one-line, multi-line and enum-key forms are all detected", () => {
      const fixture = [
        'import { z } from "zod";',
        "const s = z.object({",
        '  oneLine: z.record(z.enum(["a", "b"]), z.number()),',
        "  multiLine: z",
        '    .record(z.enum(["a", "b"]), z.number())',
        "    .optional(),",
        "  multiLineArgs: z.record(",
        '    z.enum(["c"]),',
        "    z.number()",
        "  ),",
        "  stringKey: z",
        "    .record(z.string(), z.number()),",
        "});",
      ].join("\n");
      const calls = scanRecordCalls("fixture.ts", fixture);
      expect(calls.map((c) => c.prop)).toEqual([
        "oneLine",
        "multiLine",
        "multiLineArgs",
        "stringKey",
      ]);
      expect(calls.filter(isEnumKeyed).map((c) => `${c.prop}:${c.keyText}`)).toEqual([
        'oneLine:z.enum(["a","b"])',
        'multiLine:z.enum(["a","b"])',
        'multiLineArgs:z.enum(["c"])',
      ]);
      expect(calls.filter((c) => c.multiLine).map((c) => c.prop)).toEqual([
        "multiLine",
        "stringKey",
      ]);
    });

    it("counts every z.record call in src, including the multi-line ones", () => {
      const calls = allRecordCalls();
      expect(calls).toHaveLength(TOTAL_RECORD_CALLS);
      expect(
        calls
          .filter((c) => c.multiLine)
          .map((c) => `${c.file}:${c.prop}`)
          .sort()
      ).toEqual(
        MULTI_LINE_RECORD_CALLS.map((m) => `${m.file.replace(/\//g, path.sep)}:${m.key}`).sort()
      );
    });
  });

  describe("(b) golden: a partial key set parses to exactly the given keys (zod 3)", () => {
    const type = motionTypeSchema.options[0];
    const trigger = triggerTypeSchema.options[0];
    const category = motionCategorySchema.options[0];

    it("motionSummarySchema.byType / byTrigger / byCategory", () => {
      const out = motionSummarySchema.parse({
        ...BASE_SUMMARY,
        byType: { [type]: 2 },
        byTrigger: { [trigger]: 3 },
        byCategory: { [category]: 4 },
      });
      expect(out.byType).toEqual({ [type]: 2 });
      expect(out.byTrigger).toEqual({ [trigger]: 3 });
      expect(out.byCategory).toEqual({ [category]: 4 });
      expect(Object.keys(out.byType)).toHaveLength(1);
      expect(Object.keys(out.byTrigger)).toHaveLength(1);
      expect(Object.keys(out.byCategory ?? {})).toHaveLength(1);
    });

    it("motionSummarySchema accepts empty records (no key is required)", () => {
      const out = motionSummarySchema.parse({ ...BASE_SUMMARY, byType: {}, byTrigger: {} });
      expect(out.byType).toEqual({});
      expect(out.byTrigger).toEqual({});
    });

    it("cssFrameworkCompositeResultSchema.confidenceMap", () => {
      const out = cssFrameworkCompositeResultSchema.parse({
        primary: "tailwind",
        secondary: [],
        confidenceMap: { tailwind: 0.9 },
        hasCssVariables: false,
      });
      expect(out.confidenceMap).toEqual({ tailwind: 0.9 });
    });

    it("an unknown key is still rejected", () => {
      expect(
        motionSummarySchema.safeParse({ ...BASE_SUMMARY, byType: { not_a_type: 1 }, byTrigger: {} })
          .success
      ).toBe(false);
    });
  });

  it("(c) probe: zod 4 z.record requires every enum key, z.partialRecord does not; zod 3 z.record accepted a partial set", () => {
    const rec = z4.record(z4.enum(["a", "b"]), z4.number());
    expect(rec.safeParse({ a: 1 }).success).toBe(false);
    expect(rec.safeParse({ a: 1, b: 2 }).success).toBe(true);
    const partial = z4.partialRecord(z4.enum(["a", "b"]), z4.number());
    expect(partial.safeParse({ a: 1 }).data).toEqual({ a: 1 });
    const v3 = z3.record(z3.enum(["a", "b"]), z3.number());
    expect(v3.safeParse({ a: 1 }).data).toEqual({ a: 1 });
  });
});
