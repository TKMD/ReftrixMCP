// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: none (zod error contract; TDA-B1-05 / TPA-B1-02)
 *
 * INV-ZOD-NO-GLOBAL-ERROR-MAP-001: error-messages.ts reads the received type name from the end of
 * zod's default English message. A locale or a custom error map changes that text, so the source
 * must not install one: no `z.config(...)`, `setErrorMap` or `z.locales` under apps/mcp-server/src
 * or packages/<pkg>/src.
 *
 *  (a) positive controls: every form below is detected (`z.config`, `z.core.config`, `z["config"]`,
 *      `z.setErrorMap`, a bare `setErrorMap`, a named import of `config`, `z.locales`); lookalikes are not
 *  (b) the source trees contain none
 *  (c) the gap is pinned: with a custom error map the missing-field case degrades to INVALID_TYPE
 *      (the reason (b) exists), so a change of the dependency has to change this test on purpose
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";
import { z } from "zod";

import { ERROR_CODES, formatZodError } from "../../src/utils/error-messages";

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

/** Local names bound by an import from "zod" or "zod/..." (`z`, an alias, a namespace import). */
function zodImportNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const mod = st.moduleSpecifier.text;
    if (mod !== "zod" && !mod.startsWith("zod/")) continue;
    const clause = st.importClause;
    if (!clause) continue;
    if (clause.name) names.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) names.add(nb.name.text);
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) names.add(el.name.text);
  }
  return names;
}

const INSTALLER_NAMES = new Set(["config", "setErrorMap"]);

/** Does an access chain (`z`, `z.core`, `z["core"]`, ...) start at a name bound by a zod import? */
function rootsAtZod(expr: ts.Expression, zodNames: ReadonlySet<string>): boolean {
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
    } else break;
  }
  return ts.isIdentifier(cur) && zodNames.has(cur.text);
}

/** Local names an import from zod gives to `config` / `setErrorMap` (`import { config as c } from "zod"`). */
function installerImportNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const mod = st.moduleSpecifier.text;
    if (mod !== "zod" && !mod.startsWith("zod/")) continue;
    const nb = st.importClause?.namedBindings;
    if (!nb || !ts.isNamedImports(nb)) continue;
    for (const el of nb.elements) {
      if (INSTALLER_NAMES.has((el.propertyName ?? el.name).text)) names.add(el.name.text);
    }
  }
  return names;
}

/**
 * Calls that install an error map: `<zod import>.config(...)`, `.core.config(...)`, `["config"](...)`,
 * `<zod import>.setErrorMap(...)`, a bare `setErrorMap(...)`, and a direct call of `config` /
 * `setErrorMap` imported from zod (aliases included); plus `<anything>.locales` accesses.
 */
function errorMapInstallers(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const zodNames = zodImportNames(sf);
  const direct = installerImportNames(sf);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    const at = (): string =>
      `${fileName}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && (callee.text === "setErrorMap" || direct.has(callee.text))) {
        found.push(at());
      } else if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isStringLiteralLike(callee.argumentExpression)
            ? callee.argumentExpression.text
            : "";
        if (INSTALLER_NAMES.has(name) && rootsAtZod(callee.expression, zodNames)) found.push(at());
      }
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === "locales") found.push(at());
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("INV-ZOD-NO-GLOBAL-ERROR-MAP-001", () => {
  it.each([
    ["z.config", 'import { z } from "zod";\nz.config({ localeError: x });'],
    ["aliased z.config", 'import { z as other } from "zod";\nother.config({});'],
    ["namespace import", 'import * as zz from "zod/v4";\nzz.config({});'],
    ["setErrorMap", "setErrorMap(map);"],
    ["z.locales", 'import { z } from "zod";\nz.config(z.locales.ja());'],
    ["named import config", 'import { config } from "zod";\nconfig({ localeError: x });'],
    ["aliased named import", 'import { config as c } from "zod/v4";\nc({});'],
    ["z.setErrorMap", 'import { z } from "zod";\nz.setErrorMap(m);'],
    ["z.core.config", 'import { z } from "zod";\nz.core.config({});'],
    ["element access", 'import { z } from "zod";\nz["config"]({});'],
  ])("(a) positive control: %s is detected", (_name, code) => {
    expect(errorMapInstallers("fixture.ts", code).length).toBeGreaterThan(0);
  });

  it("(a) negative control: a lookalike is not detected", () => {
    expect(
      errorMapInstallers("fixture.ts", "app.config(x); const locales = 1; foo(locales);")
    ).toEqual([]);
    // a config() from somewhere else, and a local called config, are not zod's
    expect(errorMapInstallers("fixture.ts", 'import { config } from "dotenv";\nconfig();')).toEqual(
      []
    );
    expect(errorMapInstallers("fixture.ts", "const config = load();\nconfig();")).toEqual([]);
  });

  it("(b) the source trees install no error map", () => {
    const files = SCAN_ROOTS.flatMap((root) => walkTsFiles(root));
    expect(files.length).toBeGreaterThan(500);
    expect(files.flatMap((f) => errorMapInstallers(f, fs.readFileSync(f, "utf8")))).toEqual([]);
  });

  it("(c) the gap: with a custom error map the missing-field case degrades to INVALID_TYPE", () => {
    const schema = z.object({ a: z.string() });
    const withDefault = schema.safeParse({});
    expect(withDefault.success).toBe(false);
    if (withDefault.success) return;
    expect(formatZodError(withDefault.error)[0]?.code).toBe(ERROR_CODES.REQUIRED_FIELD);

    const custom = z.object({ a: z.string() }).safeParse({}, { error: () => "custom text" });
    expect(custom.success).toBe(false);
    if (custom.success) return;
    expect(formatZodError(custom.error)[0]?.code).toBe(ERROR_CODES.INVALID_TYPE);
  });
});
