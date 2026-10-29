// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type-checker scanner: finds reads of `errors` on a ZodError. zod 4 removed `ZodError#errors`;
 * `.issues` is the supported property on both zod 3 and 4. Used by INV-ZOD-ERRORS-READ-ZERO-001.
 * Receivers that are not ZodError (e.g. `result.errors` of a batch result) are not reported.
 *
 * Forms: `e.errors`, `e["errors"]`, `e[key]` where `key` has the literal type "errors",
 * `const { errors } = e` / `const { errors: list } = e` (also in parameters and `for-of`), and the
 * assignment form `({ errors } = e)`.
 *
 * The program uses the package's own tsconfig (module resolution, paths) so that the `zod` import
 * of the scanned files resolves; `scanZodErrorsReadsDetailed` reports TS2307 diagnostics and the
 * number of source files so the test can fail a scan that saw nothing.
 */
import * as path from "node:path";
import ts from "typescript";

import { lineOf, walkTsFiles } from "./zod-scan-common";

export interface ZodErrorsReadSite {
  /** path relative to the scanned package root (posix separators) */
  file: string;
  line: number;
}

export interface ZodErrorsScanResult {
  sites: ZodErrorsReadSite[];
  sourceFileCount: number;
  /** TS2307 "Cannot find module" diagnostics in the scanned files */
  unresolvedModules: string[];
  /** `.issues` reads whose receiver type was resolved to ZodError (non-vacuity of the type lookup) */
  zodIssuesReads: number;
}

function isZodErrorType(checker: ts.TypeChecker, type: ts.Type, seen: Set<ts.Type>): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection()) {
    return type.types.some((t) => isZodErrorType(checker, t, seen));
  }
  if (type.symbol?.name === "ZodError") return true;
  if (type.isClassOrInterface()) {
    return checker.getBaseTypes(type).some((t) => isZodErrorType(checker, t, seen));
  }
  // generic instantiation such as ZodError<T>: look at the target
  const target = (type as ts.TypeReference).target;
  return target !== undefined && target !== type && isZodErrorType(checker, target, seen);
}

export function packageCompilerOptions(pkgRoot: string): ts.CompilerOptions {
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(pkgRoot, "tsconfig.json"), {}, host);
  if (!parsed) throw new Error(`cannot read ${pkgRoot}/tsconfig.json`);
  return {
    ...parsed.options,
    noEmit: true,
    skipLibCheck: true,
    rootDir: pkgRoot,
    outDir: undefined,
  };
}

/** The name node of an object-pattern / object-literal element, if it has one. */
function elementName(el: ts.Node): ts.PropertyName | ts.BindingName | undefined {
  if (ts.isBindingElement(el)) return el.propertyName ?? el.name;
  if (ts.isPropertyAssignment(el) || ts.isShorthandPropertyAssignment(el)) return el.name;
  return undefined;
}

/** A literal string that names a key: `x`, `"x"`, `["x"]`, `` [`x`] ``. */
function literalKey(name: ts.Node): string | undefined {
  const inner = ts.isComputedPropertyName(name) ? name.expression : name;
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  return ts.isIdentifier(inner) && !ts.isComputedPropertyName(name) ? inner.text : undefined;
}

/** The property key an object-pattern / object-literal element reads, if it is a plain name. */
function elementKey(el: ts.Node): string | undefined {
  const name = elementName(el);
  return name === undefined ? undefined : literalKey(name);
}

export function scanZodErrorsReadsDetailed(pkgRoot: string, subdir: string): ZodErrorsScanResult {
  const files = walkTsFiles(path.join(pkgRoot, subdir));
  const program = ts.createProgram(files, packageCompilerOptions(pkgRoot));
  const checker = program.getTypeChecker();
  const result: ZodErrorsScanResult = {
    sites: [],
    sourceFileCount: 0,
    unresolvedModules: [],
    zodIssuesReads: 0,
  };
  const isZod = (n: ts.Node): boolean =>
    isZodErrorType(checker, checker.getTypeAtLocation(n), new Set());

  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    result.sourceFileCount += 1;
    const rel = path.relative(pkgRoot, file).split(path.sep).join("/");
    for (const d of program.getSemanticDiagnostics(sf)) {
      if (d.code === 2307) {
        result.unresolvedModules.push(
          `${rel}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`
        );
      }
    }
    const report = (at: ts.Node): void => {
      result.sites.push({ file: rel, line: lineOf(sf, at) });
    };
    const onProperty = (node: ts.PropertyAccessExpression): void => {
      if (node.name.text === "errors" && isZod(node.expression)) report(node.name);
      if (node.name.text === "issues" && isZod(node.expression)) result.zodIssuesReads += 1;
    };
    const onElement = (node: ts.ElementAccessExpression): void => {
      const key = checker.getTypeAtLocation(node.argumentExpression);
      if (key.isStringLiteral() && key.value === "errors" && isZod(node.expression)) report(node);
    };
    const onPattern = (node: ts.ObjectBindingPattern): void => {
      for (const el of node.elements) {
        if (elementKey(el) === "errors" && isZod(node)) report(el);
      }
    };
    const onAssignment = (node: ts.BinaryExpression): void => {
      if (!ts.isObjectLiteralExpression(node.left) || !isZod(node.right)) return;
      for (const el of node.left.properties) {
        if (elementKey(el) === "errors") report(el);
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) onProperty(node);
      else if (ts.isElementAccessExpression(node)) onElement(node);
      else if (ts.isObjectBindingPattern(node)) onPattern(node);
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        onAssignment(node);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return result;
}

export function scanZodErrorsReads(pkgRoot: string, subdir: string): ZodErrorsReadSite[] {
  return scanZodErrorsReadsDetailed(pkgRoot, subdir).sites;
}
