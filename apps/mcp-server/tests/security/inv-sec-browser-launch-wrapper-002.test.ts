// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-SEC-BROWSER-LAUNCH-WRAPPER-002 — Playwright の launch は wrapper の 1 箇所だけ
 * INV-SEC-BROWSER-LAUNCH-WRAPPER-002 — Playwright launch happens in exactly one wrapper
 *
 * `playwright` / `playwright-core` から取得した binding (namespace・分割代入・alias・
 * 動的 import を含む) の `.launch(` / `.launchPersistentContext(` を wrapper
 * (src/utils/launch-chromium.ts) 以外で呼ぶと fail する。ブラウザ欠如の生エラー
 * (内部 path を含む) が client に出る経路 (CWE-209) を起点で塞ぐ。
 * Fails if any binding taken from `playwright` / `playwright-core` (namespace,
 * destructured, aliased, dynamic import) calls `.launch(` / `.launchPersistentContext(`
 * outside the wrapper. Non-vacuous: it must scan files and find the wrapper's own call.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";

const SRC_ROOT = path.resolve(__dirname, "../../src");
const WRAPPER_REL = "utils/launch-chromium.ts";
const PLAYWRIGHT_MODULES = new Set(["playwright", "playwright-core"]);
const LAUNCH_METHODS = new Set([
  "launch",
  "launchPersistentContext",
  "launchServer",
  "connect",
  "connectOverCDP",
]);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e)) {
      e = e.expression;
    } else if (ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) {
      e = e.expression;
    } else {
      return e;
    }
  }
}

/** Root identifier of a property/element access chain (a.b["c"] -> a). */
function rootIdentifier(expr: ts.Expression): string | null {
  let e = unwrap(expr);
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    e = unwrap(e.expression);
  }
  return ts.isIdentifier(e) ? e.text : null;
}

function isPlaywrightLoad(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (!ts.isCallExpression(e)) return false;
  const arg = e.arguments[0];
  if (!arg || !ts.isStringLiteralLike(arg) || !PLAYWRIGHT_MODULES.has(arg.text)) return false;
  if (e.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  return ts.isIdentifier(e.expression) && e.expression.text === "require";
}

function collectBindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) collectBindingNames(el.name, into);
  }
}

interface Scan {
  offenders: string[];
  launchCalls: number;
  reexports: string[];
}

function scanFile(file: string): Scan {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const tainted = new Set<string>();

  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      PLAYWRIGHT_MODULES.has(stmt.moduleSpecifier.text)
    ) {
      const clause = stmt.importClause;
      if (!clause) continue;
      if (clause.name) tainted.add(clause.name.text);
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) tainted.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) tainted.add(el.name.text);
    }
    if (ts.isImportEqualsDeclaration(stmt)) tainted.add(stmt.name.text);
  }

  // Fixed point over `const x = <tainted>[.y]` / `await import("playwright")` / destructuring.
  const decls: ts.VariableDeclaration[] = [];
  const visitDecl = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) decls.push(n);
    ts.forEachChild(n, visitDecl);
  };
  visitDecl(sf);
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of decls) {
      const init = d.initializer as ts.Expression;
      const root = rootIdentifier(init);
      if (isPlaywrightLoad(init) || (root !== null && tainted.has(root))) {
        const names = new Set<string>();
        collectBindingNames(d.name, names);
        for (const n of names) {
          if (!tainted.has(n)) {
            tainted.add(n);
            changed = true;
          }
        }
      }
    }
  }

  // Re-exporting a playwright value would let another module launch without the wrapper.
  const reexports: string[] = [];
  const relPath = path.relative(SRC_ROOT, file);
  const hasExportModifier = (n: ts.Node): boolean =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const stmt of sf.statements) {
    const at = (n: ts.Node): string =>
      `${relPath}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue;
      if (stmt.moduleSpecifier) {
        if (
          ts.isStringLiteral(stmt.moduleSpecifier) &&
          PLAYWRIGHT_MODULES.has(stmt.moduleSpecifier.text)
        ) {
          const clause = stmt.exportClause;
          const allTypes =
            clause !== undefined &&
            ts.isNamedExports(clause) &&
            clause.elements.length > 0 &&
            clause.elements.every((e) => e.isTypeOnly);
          if (!allTypes) reexports.push(at(stmt));
        }
      } else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (!el.isTypeOnly && tainted.has((el.propertyName ?? el.name).text)) {
            reexports.push(at(el));
          }
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      const root = rootIdentifier(stmt.expression);
      if (isPlaywrightLoad(stmt.expression) || (root !== null && tainted.has(root))) {
        reexports.push(at(stmt));
      }
    } else if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        const init = d.initializer;
        if (!init) continue;
        const root = rootIdentifier(init);
        if (isPlaywrightLoad(init) || (root !== null && tainted.has(root))) {
          reexports.push(at(d));
        }
      }
    }
  }

  const offenders: string[] = [];
  let launchCalls = 0;
  const rel = path.relative(SRC_ROOT, file);
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      let method: string | null = null;
      let receiver: ts.Expression | null = null;
      if (ts.isPropertyAccessExpression(callee)) {
        method = callee.name.text;
        receiver = callee.expression;
      } else if (
        ts.isElementAccessExpression(callee) &&
        ts.isStringLiteralLike(callee.argumentExpression)
      ) {
        method = callee.argumentExpression.text;
        receiver = callee.expression;
      }
      if (method && LAUNCH_METHODS.has(method) && receiver) {
        const root = isPlaywrightLoad(receiver) ? "<load>" : rootIdentifier(receiver);
        if (root !== null && (root === "<load>" || tainted.has(root))) {
          launchCalls++;
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
          offenders.push(`${rel}:${line + 1}`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { offenders, launchCalls, reexports };
}

describe("INV-SEC-BROWSER-LAUNCH-WRAPPER-002", () => {
  const files = listTsFiles(SRC_ROOT);
  const results = files.map((f) => ({ file: path.relative(SRC_ROOT, f), ...scanFile(f) }));

  it("scans the source tree (non-vacuous)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds the wrapper's own launch call (non-vacuous)", () => {
    const wrapper = results.find((r) => r.file === WRAPPER_REL);
    expect(wrapper, `${WRAPPER_REL} must exist`).toBeDefined();
    expect(wrapper?.launchCalls).toBeGreaterThanOrEqual(1);
  });

  it("has no Playwright launch / launchPersistentContext call outside the wrapper", () => {
    const offenders = results.filter((r) => r.file !== WRAPPER_REL).flatMap((r) => r.offenders);
    expect(offenders).toEqual([]);
  });

  it("has no re-export of a playwright value from src", () => {
    expect(results.flatMap((r) => r.reexports)).toEqual([]);
  });

  it("no published package other than apps/mcp-server depends on playwright (SEC-L-01)", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const targets = fs.readFileSync(path.join(repoRoot, "scripts/publish-targets.sh"), "utf8");
    const dirs = [...targets.matchAll(/"((?:packages|apps)\/[a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(dirs).toContain("apps/mcp-server");
    expect(dirs.length).toBeGreaterThanOrEqual(5);
    const offenders: string[] = [];
    for (const dir of dirs) {
      if (dir === "apps/mcp-server") continue;
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, dir, "package.json"), "utf8"));
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const name of Object.keys(pkg[field] ?? {})) {
          if (PLAYWRIGHT_MODULES.has(name)) offenders.push(`${dir}:${field}:${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  describe("detector self-check (fixtures)", () => {
    const scanText = (code: string): number => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-launch-"));
      const f = path.join(dir, "x.ts");
      fs.writeFileSync(f, code);
      try {
        return scanFile(f).launchCalls;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const scanReexports = (code: string): number => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-launch-"));
      const f = path.join(dir, "x.ts");
      fs.writeFileSync(f, code);
      try {
        return scanFile(f).reexports.length;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    it.each([
      [`export { chromium } from "playwright";`, 1],
      [`export * from "playwright-core";`, 1],
      [`import { chromium } from "playwright"; export { chromium };`, 1],
      [`import { chromium as c } from "playwright"; export { c as browserType };`, 1],
      [`import { chromium } from "playwright"; export default chromium;`, 1],
      [`import { chromium } from "playwright"; export const bt = chromium;`, 1],
      [`export type { Browser } from "playwright";`, 0],
      [`export { type Browser } from "playwright";`, 0],
      [`import type { Browser } from "playwright"; export type { Browser };`, 0],
    ])("re-export fixture: %s", (code, expected) => {
      expect(scanReexports(code)).toBe(expected);
    });

    it.each([
      [`import { chromium } from "playwright"; chromium.launchServer();`, 1],
      [`import { chromium } from "playwright"; chromium.launch({});`, 1],
      [`import * as pw from "playwright-core"; pw.chromium.launchPersistentContext("/x");`, 1],
      [`import { chromium } from "playwright"; const bt = chromium; bt.launch();`, 1],
      [`const { chromium: c } = await import("playwright"); c.launch();`, 1],
      [`const pw = await import("playwright"); pw.chromium.launch();`, 1],
      [`import { firefox } from "playwright"; firefox["launch"]();`, 1],
      [`const x = { launch() {} }; x.launch();`, 0],
    ])("%s", (code, expected) => {
      expect(scanText(code)).toBe(expected);
    });
  });
});
