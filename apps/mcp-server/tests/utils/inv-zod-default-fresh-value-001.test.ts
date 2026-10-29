// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: schema-enum-sync (zod 4 prep contract)
 *
 * INV-ZOD-DEFAULT-FRESH-VALUE-001: no `.default(...)` in src takes an array or object literal.
 * zod 3 parses a default through the inner schema (a new value per parse); zod 4 hands back the
 * default itself, so a literal becomes one object shared by every request. A function default
 * gives a new value on both versions.
 *
 *  (a) the set of `.default(<array or object literal>)` calls in src is empty (AST)
 *  (b) controls: literal forms are detected, function / scalar forms are not
 */
import * as path from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";

import { accessName, lineOf, parseDir, unwrap } from "./support/zod-scan-common";

function literalDefaults(sf: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      accessName(n.expression) === "default" &&
      n.arguments.length === 1
    ) {
      const arg = unwrap(n.arguments[0]!);
      if (ts.isArrayLiteralExpression(arg) || ts.isObjectLiteralExpression(arg)) {
        lines.push(lineOf(sf, n));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

const fixture = (lines: string[]): ts.SourceFile =>
  ts.createSourceFile("fixture.ts", lines.join("\n"), ts.ScriptTarget.Latest, true);

describe("INV-ZOD-DEFAULT-FRESH-VALUE-001", () => {
  it("(a) src has no array / object literal passed to .default()", () => {
    const pkgRoot = path.resolve(__dirname, "../..");
    const found = parseDir(pkgRoot, "src").flatMap(({ rel, sf }) =>
      literalDefaults(sf).map((line) => `${rel}:${line}`)
    );
    expect(found).toEqual([]);
  });

  it("(b) positive control: literal forms are detected", () => {
    const sf = fixture([
      'const a = z.array(z.string()).default(["x"]);',
      "const b = z.object({}).optional().default({ enabled: true });",
      "const c = z.array(z.string()).default([]);",
      'const d = z.array(z.string()).default(["x"] as const);',
      "const e = z.object({}).default(({}));",
      "const f = z\n  .object({})\n  .optional()\n  .default({});",
    ]);
    expect(literalDefaults(sf)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("(b) negative control: function and scalar defaults are not reported", () => {
    const sf = fixture([
      'const a = z.array(z.string()).default(() => ["x"]);',
      "const b = z.object({}).optional().default(() => ({ enabled: true }));",
      "const c = z.number().default(5);",
      "const d = z.number().default(LIMIT);",
    ]);
    expect(literalDefaults(sf)).toEqual([]);
  });
});
