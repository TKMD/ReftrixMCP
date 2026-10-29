// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: none (zod 4 bump contract; SEC-PRE-05, CWE-770)
 *
 * INV-ZOD-NO-V3-IMPORT-001: zod 4.6.7 still ships `zod/v3`, and that copy walks every array element
 * before it reports (the oversized-array flaw that the bump removed). `pnpm audit` rates the
 * package as 4.6.7 and does not see a `zod/v3` import, so nothing under apps/mcp-server/src or
 * packages/<pkg>/src may import, re-export, require or dynamically import `zod/v3`. Tests may
 * (the default-order golden compares against it on purpose); they are not scanned.
 *
 *  (a) positive controls: static import, side-effect import, re-export, require, dynamic import,
 *      `import x = require()` and a deeper path are detected; `zod` and `zod/v4` are not
 *  (b) the source trees contain none
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";

import { walkTsFiles } from "./support/zod-scan-common";

const SRC_ROOT = path.resolve(__dirname, "../../src");
const PACKAGES_ROOT = path.resolve(__dirname, "../../../../packages");
const SCAN_ROOTS = [
  SRC_ROOT,
  ...fs
    .readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PACKAGES_ROOT, d.name, "src")))
    .map((d) => path.join(PACKAGES_ROOT, d.name, "src")),
];

const isV3 = (spec: string): boolean => spec === "zod/v3" || spec.startsWith("zod/v3/");

/** Positions of every module specifier that names `zod/v3`. */
function v3Imports(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const at = (n: ts.Node): string =>
    `${fileName}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteralLike(n.moduleSpecifier) &&
      isV3(n.moduleSpecifier.text)
    ) {
      found.push(at(n));
    }
    if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      ts.isStringLiteralLike(n.moduleReference.expression) &&
      isV3(n.moduleReference.expression.text)
    ) {
      found.push(at(n));
    }
    if (ts.isCallExpression(n) && n.arguments.length >= 1) {
      const callee = n.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isDynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
      const arg = n.arguments[0];
      if ((isRequire || isDynamic) && arg && ts.isStringLiteralLike(arg) && isV3(arg.text)) {
        found.push(at(n));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("INV-ZOD-NO-V3-IMPORT-001", () => {
  it.each([
    ["static import", 'import { z } from "zod/v3";'],
    ["side-effect import", 'import "zod/v3";'],
    ["re-export", 'export * from "zod/v3";'],
    ["named re-export", 'export { z } from "zod/v3";'],
    ["require", 'const z = require("zod/v3");'],
    ["dynamic import", 'const m = await import("zod/v3");'],
    ["import equals", 'import z = require("zod/v3");'],
    ["deeper path", 'import { x } from "zod/v3/types";'],
  ])("(a) positive control: %s is detected", (_name, code) => {
    expect(v3Imports("fixture.ts", code)).toHaveLength(1);
  });

  it("(a) negative control: zod, zod/v4 and lookalikes are not detected", () => {
    const code = [
      'import { z } from "zod";',
      'import { z as z4 } from "zod/v4";',
      'import { y } from "zod/v3-compat";',
      'const a = require("zod");',
      'const b = await import("zod/v4");',
      'const c = "zod/v3";',
    ].join("\n");
    expect(v3Imports("fixture.ts", code)).toEqual([]);
  });

  it("(b) the source trees import no zod/v3", () => {
    const files = SCAN_ROOTS.flatMap((root) => walkTsFiles(root));
    expect(SCAN_ROOTS.length).toBeGreaterThanOrEqual(5);
    expect(files.length).toBeGreaterThan(500);
    expect(files.flatMap((f) => v3Imports(f, fs.readFileSync(f, "utf8")))).toEqual([]);
  });
});
