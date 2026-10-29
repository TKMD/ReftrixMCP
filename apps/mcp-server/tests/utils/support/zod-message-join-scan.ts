// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AST scanners for the places that put zod default messages in front of a client.
 * Used by INV-ZOD-ERROR-RAWJOIN-SNAPSHOT-001 to pin the audited sets, and by the fixture test
 * (INV-ZOD-SCANNER-FIXTURES-001) that shows every detected form turns the scan red.
 *
 *  - scanMessageJoinSites:  a callback / loop over an issue list (`e.errors`, `e.issues`,
 *    `e["issues"]`, `const { issues } = e`, `[...e.issues]`, ...) that reads `.message`:
 *    `.map` / `.flatMap` / `.forEach` / `.reduce` with an inline callback, a named callback
 *    (declared in the same file) or one that cannot be resolved (reported: fail-closed), and `for-of`.
 *  - scanFirstIssueSites:   one issue read out of the list (`[N]`, `[i]`, `.at()`, `.find()`,
 *    `.shift()`, `const [first] = list`) and its `.message`, through `!` / parentheses / `as`,
 *    variables, and `const { message } = ...`.
 *  - scanFormatZodErrorCallers: every file that references `formatZodError` (calls, aliases,
 *    namespace access, re-exports) or an exported wrapper of it from the defining file, except the
 *    defining file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

import {
  accessName,
  climbWrappers,
  isIssueList,
  issueListAliases,
  lineOf,
  parseDir,
  unwrap,
  type ScannedSource,
} from "./zod-scan-common";

export type JoinForm = "inline-callback" | "named-callback" | "unresolved-callback" | "for-of";

export interface MessageJoinSite {
  /** path relative to apps/mcp-server (posix separators) */
  file: string;
  line: number;
  form: JoinForm;
}

const ITERATORS: readonly string[] = ["map", "flatMap", "forEach", "reduce"];

/** `.message`, `["message"]`, or a `{ message }` binding anywhere under `node`. */
function readsMessage(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (accessName(n) === "message") found = true;
    if (ts.isBindingElement(n)) {
      const key = n.propertyName ?? n.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === "message") found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
}

/** The function declared in this file under `name`; a variable that is not a function does not count. */
function declaredFunction(sf: ts.SourceFile, name: string): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      isFunctionLike(unwrap(n.initializer))
    ) {
      found = unwrap(n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Local names that hold `names` too (`const j = i`), to a fixpoint. */
function withAliases(root: ts.Node, names: ReadonlySet<string>): Set<string> {
  const out = new Set(names);
  for (let grew = true; grew; ) {
    grew = false;
    const visit = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        !out.has(n.name.text) &&
        n.initializer &&
        ts.isIdentifier(unwrap(n.initializer)) &&
        out.has((unwrap(n.initializer) as ts.Identifier).text)
      ) {
        out.add(n.name.text);
        grew = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(root);
  }
  return out;
}

/** `expr` contains one of `names` as a value, not only as the object of a property read (`i.path`). */
function mentions(expr: ts.Node, names: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(expr) && names.has(expr.text)) {
    const p = expr.parent;
    return !(
      (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) &&
      p.expression === expr
    );
  }
  return ts.forEachChild(expr, (c) => mentions(c, names) || undefined) ?? false;
}

/**
 * `root` hands the issue on inside a call argument (`describe(i)`, `fmt([i])`, `fmt({ issue: i })`,
 * `fmt(...[i])`, through `const j = i`): the message is read elsewhere.
 */
function passesOn(root: ts.Node, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false;
  const all = withAliases(root, names);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.arguments.some((a) => mentions(a, all))) found = true;
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

/**
 * Names the issue is bound to in a callback: the parameter at `index` (1 for `reduce`, whose first
 * parameter is the accumulator) when it is a plain identifier, or the rest element of a pattern.
 */
function issueParam(fn: ts.Node, index: number): Set<string> {
  const p = isFunctionLike(fn) ? fn.parameters[index]?.name : undefined;
  if (p === undefined) return new Set();
  if (ts.isIdentifier(p)) return new Set([p.text]);
  const rest = ts.isObjectBindingPattern(p)
    ? p.elements.find((el) => el.dotDotDotToken !== undefined)
    : undefined;
  return rest !== undefined && ts.isIdentifier(rest.name) ? new Set([rest.name.text]) : new Set();
}

/** `[...list]` and `Array.from(list)` are views of the same list. */
function listView(expr: ts.Expression): ts.Expression {
  const e = unwrap(expr);
  if (ts.isArrayLiteralExpression(e) && e.elements.length === 1) {
    const only = e.elements[0] as ts.Expression;
    if (ts.isSpreadElement(only)) return unwrap(only.expression);
  }
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === "from" &&
    ts.isIdentifier(e.expression.expression) &&
    e.expression.expression.text === "Array" &&
    e.arguments[0]
  ) {
    return unwrap(e.arguments[0]);
  }
  return e;
}

function joinFormOf(
  sf: ts.SourceFile,
  call: ts.CallExpression
): Exclude<JoinForm, "for-of"> | undefined {
  const cb = call.arguments[0];
  if (!cb) return undefined;
  const fn = unwrap(cb);
  const index = accessName(call.expression) === "reduce" ? 1 : 0;
  // a callback that only hands the issue on (`i => fmt(i)`) cannot be shown not to read the message
  const formOf = (f: ts.Node, read: JoinForm): JoinForm | undefined =>
    readsMessage(f) ? read : passesOn(f, issueParam(f, index)) ? "unresolved-callback" : undefined;
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    return formOf(fn, "inline-callback") as Exclude<JoinForm, "for-of"> | undefined;
  }
  if (ts.isIdentifier(fn)) {
    const decl = declaredFunction(sf, fn.text);
    if (decl === undefined) return "unresolved-callback";
    return formOf(decl, "named-callback") as Exclude<JoinForm, "for-of"> | undefined;
  }
  return "unresolved-callback";
}

/** Name of the `for (const x of ...)` variable, when it is a plain identifier. */
function loopVariable(init: ts.ForInitializer): Set<string> {
  const name = ts.isVariableDeclarationList(init) ? init.declarations[0]?.name : undefined;
  return name !== undefined && ts.isIdentifier(name) ? new Set([name.text]) : new Set();
}

/** `for (x of issues)` whose body reads the message or hands the issue on. */
function isJoinLoop(node: ts.ForOfStatement, aliases: ReadonlySet<string>): boolean {
  return (
    isIssueList(listView(node.expression), aliases) &&
    (readsMessage(node.initializer) ||
      readsMessage(node.statement) ||
      passesOn(node.statement, loopVariable(node.initializer)))
  );
}

export function scanMessageJoinInSource(src: ScannedSource): MessageJoinSite[] {
  const { sf, rel } = src;
  const aliases = issueListAliases(sf);
  const sites: MessageJoinSite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ITERATORS.includes(node.expression.name.text) &&
      isIssueList(listView(node.expression.expression), aliases)
    ) {
      const form = joinFormOf(sf, node);
      if (form) sites.push({ file: rel, line: lineOf(sf, node), form });
    }
    if (ts.isForOfStatement(node) && isJoinLoop(node, aliases)) {
      sites.push({ file: rel, line: lineOf(sf, node), form: "for-of" });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

export function scanMessageJoinSites(pkgRoot: string, subdir: string): MessageJoinSite[] {
  return parseDir(pkgRoot, subdir).flatMap(scanMessageJoinInSource);
}

export type FirstIssueKind =
  /** one issue read out of the list: `[N]`, `[i]`, `.at()`, `.find()`, `.shift()`, `const [first] = list` */
  | "first-issue-read"
  /** `.message` read on a first-issue expression (directly, or through a variable it was assigned to) */
  | "first-issue-message";

export interface FirstIssueSite {
  file: string;
  line: number;
  kind: FirstIssueKind;
}

const FIRST_ISSUE_METHODS: readonly string[] = ["at", "find", "shift"];

/** The expression picks one issue out of the list. */
function isFirstIssueExpression(node: ts.Node, aliases: ReadonlySet<string>): boolean {
  if (ts.isElementAccessExpression(node)) {
    // a string key is a property access (`errors["length"]`), anything else indexes the list
    return (
      isIssueList(listView(node.expression), aliases) &&
      !ts.isStringLiteral(node.argumentExpression)
    );
  }
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    FIRST_ISSUE_METHODS.includes(node.expression.name.text) &&
    isIssueList(listView(node.expression.expression), aliases)
  );
}

/** Message reads on `outer` (a first-issue expression or a holder, wrappers already climbed). */
function messageReadsOn(outer: ts.Node, sf: ts.SourceFile, rel: string): FirstIssueSite[] {
  const parent = outer.parent;
  if (!parent) return [];
  const message = (n: ts.Node, kind: FirstIssueKind = "first-issue-message"): FirstIssueSite => ({
    file: rel,
    line: lineOf(sf, n),
    kind,
  });
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === outer &&
    accessName(parent) === "message"
  ) {
    return [message(ts.isPropertyAccessExpression(parent) ? parent.name : parent)];
  }
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === outer &&
    ts.isObjectBindingPattern(parent.name)
  ) {
    return parent.name.elements
      .filter((el) => {
        const key = el.propertyName ?? el.name;
        return (ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === "message";
      })
      .map((el) => message(el));
  }
  return [];
}

/**
 * Finds the places that read one issue out of a ZodError list and then read its default message
 * (`const first = error.errors[0]; ... first.message`, `error.issues[i]?.message`,
 * `(error.issues[0] as ZodIssue).message`, `const [first] = error.issues`, `issues.find(...)!.message`).
 * The join scanner above cannot see these, so they are pinned separately.
 */
export function scanFirstIssueInSource(src: ScannedSource): FirstIssueSite[] {
  const { sf, rel } = src;
  const aliases = issueListAliases(sf);
  const sites: FirstIssueSite[] = [];
  const holders = new Set<string>();
  const read = (n: ts.Node): void => {
    sites.push({ file: rel, line: lineOf(sf, n), kind: "first-issue-read" });
  };
  const holderOf = (outer: ts.Node): void => {
    const parent = outer.parent;
    if (
      parent &&
      ts.isVariableDeclaration(parent) &&
      parent.initializer === outer &&
      ts.isIdentifier(parent.name)
    ) {
      holders.add(parent.name.text);
    }
    if (
      parent &&
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === outer &&
      ts.isIdentifier(parent.left)
    ) {
      holders.add(parent.left.text);
    }
  };

  const collect = (node: ts.Node): void => {
    if (isFirstIssueExpression(node, aliases)) {
      read(node);
      const outer = climbWrappers(node);
      holderOf(outer);
      sites.push(...messageReadsOn(outer, sf, rel));
    }
    // const [first] = list
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      isIssueList(listView(node.initializer), aliases)
    ) {
      read(node);
      for (const el of node.name.elements) {
        if (ts.isBindingElement(el) && !el.dotDotDotToken && ts.isIdentifier(el.name)) {
          holders.add(el.name.text);
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  if (holders.size > 0) {
    const readHolders = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && holders.has(node.text) && !ts.isBindingElement(node.parent)) {
        const outer = climbWrappers(node);
        sites.push(...messageReadsOn(outer, sf, rel));
      }
      ts.forEachChild(node, readHolders);
    };
    readHolders(sf);
  }
  return sites;
}

export function scanFirstIssueSites(pkgRoot: string, subdir: string): FirstIssueSite[] {
  return parseDir(pkgRoot, subdir).flatMap(scanFirstIssueInSource);
}

/** Exported functions of the defining file that call `name` (a wrapper hides its callers). */
function exportedWrappers(file: string, name: string): Set<string> {
  const wrappers = new Set<string>();
  if (!fs.existsSync(file)) return wrappers;
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const calls = (n: ts.Node): boolean =>
    (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) ||
    (ts.forEachChild(n, (c) => calls(c) || undefined) ?? false);
  for (const st of sf.statements) {
    const exported = ts.getCombinedModifierFlags(st as ts.Declaration) & ts.ModifierFlags.Export;
    if (exported && ts.isFunctionDeclaration(st) && st.name && st.name.text !== name && calls(st)) {
      wrappers.add(st.name.text);
    }
  }
  return wrappers;
}

/**
 * Files that reference `formatZodError` or an exported wrapper of it in `definitionFile`, except
 * `definitionFile`: calls, aliased imports, `ns.formatZodError`, and re-exports (a barrel would hide
 * the real callers).
 */
export function scanFormatZodErrorCallers(
  pkgRoot: string,
  subdir: string,
  definitionFile: string = "src/utils/error-messages.ts"
): string[] {
  const targets = new Set([
    "formatZodError",
    ...exportedWrappers(path.join(pkgRoot, definitionFile), "formatZodError"),
  ]);
  const callers: string[] = [];
  for (const { rel, sf } of parseDir(pkgRoot, subdir)) {
    if (rel === definitionFile) continue;
    const names = new Set<string>(targets);
    const visit = (node: ts.Node): void => {
      if (ts.isImportSpecifier(node) && targets.has((node.propertyName ?? node.name).text)) {
        names.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    let referenced = false;
    // re-exports are seen through the identifier (`export { formatZodError }`)
    const find = (node: ts.Node): void => {
      if (ts.isImportSpecifier(node)) return;
      if (ts.isIdentifier(node) && names.has(node.text)) referenced = true;
      const accessed = accessName(node);
      if (accessed !== undefined && targets.has(accessed)) referenced = true;
      ts.forEachChild(node, find);
    };
    find(sf);
    if (referenced) callers.push(rel);
  }
  return callers.sort();
}
