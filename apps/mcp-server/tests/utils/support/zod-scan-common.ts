// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared pieces of the zod scanners (TDA-B2A-04 / TDA-B2B-04 / TDA-B2C1-03 / TPA-B2C1-05): one file
 * walk, one parser, and the expression helpers that look through `!` / parentheses / `as`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

/** Sorted `.ts` files (no `.d.ts`) under `dir`. */
export function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

export interface ScannedSource {
  /** path relative to the package root (posix separators) */
  rel: string;
  sf: ts.SourceFile;
}

export function parseFile(pkgRoot: string, file: string): ScannedSource {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  return { rel: path.relative(pkgRoot, file).split(path.sep).join("/"), sf };
}

export function parseDir(pkgRoot: string, subdir: string): ScannedSource[] {
  return walkTsFiles(path.join(pkgRoot, subdir)).map((f) => parseFile(pkgRoot, f));
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

type Wrapper =
  | ts.ParenthesizedExpression
  | ts.NonNullExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.TypeAssertion;

function isWrapper(node: ts.Node): node is Wrapper {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

/** Looks down through `( )`, `!`, `as`, `satisfies`, `<T>x`. */
export function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (isWrapper(cur)) cur = cur.expression;
  return cur;
}

/** Climbs up while the parent only wraps the node; returns the outermost wrapper (or the node). */
export function climbWrappers(node: ts.Node): ts.Node {
  let cur = node;
  while (cur.parent && isWrapper(cur.parent)) cur = cur.parent;
  return cur;
}

/** Name of a `.x` or `["x"]` access, undefined for anything else (non-literal keys included). */
export function accessName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

export const ISSUE_LIST_NAMES: readonly string[] = ["errors", "issues"];

/** `<expr>.errors` / `<expr>.issues` / `<expr>["errors"]`, through wrappers. */
export function isIssueListAccess(expr: ts.Node): boolean {
  const e = ts.isExpression(expr) ? unwrap(expr) : expr;
  const name = accessName(e);
  return name !== undefined && ISSUE_LIST_NAMES.includes(name);
}

/**
 * Local names that stand for an issue list: `const { issues } = e`, `const { issues: list } = e`,
 * `const list = e.issues`. Name based per file (a name used for something else is over-reported,
 * which is the safe direction for these closed-set checks).
 */
export function issueListAliases(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      ts.isIdentifier(node.name)
    ) {
      const source = node.propertyName ?? node.name;
      if (
        (ts.isIdentifier(source) || ts.isStringLiteral(source)) &&
        ISSUE_LIST_NAMES.includes(source.text)
      )
        names.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (isIssueListAccess(node.initializer) ||
        (ts.isIdentifier(unwrap(node.initializer)) &&
          names.has((unwrap(node.initializer) as ts.Identifier).text)))
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** An issue list: the access forms above, or a local alias of one. */
export function isIssueList(expr: ts.Node, aliases: ReadonlySet<string>): boolean {
  if (isIssueListAccess(expr)) return true;
  const e = ts.isExpression(expr) ? unwrap(expr) : expr;
  return ts.isIdentifier(e) && aliases.has(e.text);
}
