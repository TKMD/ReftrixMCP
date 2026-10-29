// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: schema-enum-sync (zod 4 prep contract)
 *
 * INV-ZOD-ISSUE-PATH-JOIN-001: an issue path becomes text through `formatIssuePath`, never through
 * `issue.path.join(".")`. zod 3 puts strings and numbers in a path; zod 4 types it `PropertyKey[]`
 * and a record with a symbol key puts a symbol in it, where `join` throws a TypeError and the tool
 * answers with an internal error instead of a validation error.
 *
 *  (a) the set of `<expr>.path.join(...)` calls in src is empty (AST)
 *  (b) controls: issue path joins are detected, `node:path` joins are not
 *  (c) `formatIssuePath` keeps the text of string / number paths and accepts symbols
 *  (d) a place that formats an issue path next to the raw default message (`issue.message`) is a
 *      raw join and its text echoes the key names of `unrecognized_keys`: every such place goes
 *      through `formatIssueLine` / `formatIssueMessage` (AST, outside issue-path.ts)
 *  (e) `formatIssueLine` / `formatIssueMessage` give the fixed text for `unrecognized_keys` (the
 *      converter's text) and `path: message` for everything else
 */
import * as path from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";

import { z } from "zod";

import { formatIssuePath, formatZodError } from "../../src/utils/error-messages";
import {
  UNRECOGNIZED_KEYS_TEXT,
  formatIssueLine,
  formatIssueMessage,
} from "../../src/utils/issue-path";
import { accessName, lineOf, parseDir } from "./support/zod-scan-common";

function issuePathJoins(sf: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      accessName(n.expression) === "join" &&
      ts.isPropertyAccessExpression(n.expression) &&
      accessName(n.expression.expression) === "path" &&
      ts.isPropertyAccessExpression(n.expression.expression)
    ) {
      lines.push(lineOf(sf, n));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

/** Where the raw default message of an issue is formatted by a function that also formats its path. */
const RAW_JOIN_EXEMPT: Readonly<Record<string, string>> = {
  "src/utils/issue-path.ts": "defines formatIssueLine / formatIssueMessage",
  "src/config/phase5-config.ts": "startup config warning (logger only, never reaches a client)",
};

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
}

/** Lines of `formatIssuePath(...)` calls whose nearest enclosing function also reads `.message`. */
function rawIssueMessageJoins(sf: ts.SourceFile): number[] {
  const lines: number[] = [];
  const readsMessage = (root: ts.Node): boolean => {
    let found = false;
    const visit = (n: ts.Node): void => {
      if (accessName(n) === "message") found = true;
      ts.forEachChild(n, visit);
    };
    visit(root);
    return found;
  };
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ((ts.isIdentifier(n.expression) && n.expression.text === "formatIssuePath") ||
        accessName(n.expression) === "formatIssuePath")
    ) {
      let fn: ts.Node | undefined = n.parent;
      while (fn && !isFunctionLike(fn)) fn = fn.parent;
      if (fn && readsMessage(fn)) lines.push(lineOf(sf, n));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

const fixture = (lines: string[]): ts.SourceFile =>
  ts.createSourceFile("fixture.ts", lines.join("\n"), ts.ScriptTarget.Latest, true);

describe("INV-ZOD-ISSUE-PATH-JOIN-001", () => {
  it("(a) src has no <expr>.path.join(...)", () => {
    const pkgRoot = path.resolve(__dirname, "../..");
    const found = parseDir(pkgRoot, "src").flatMap(({ rel, sf }) =>
      issuePathJoins(sf).map((line) => `${rel}:${line}`)
    );
    expect(found).toEqual([]);
  });

  it("(b) positive control: issue path joins are detected", () => {
    const sf = fixture([
      'const a = error.issues.map((e) => e.path.join("."));',
      'const b = issue.path.join(".");',
      'const c = err.issues[0]?.path.join("/");',
      'const d = result.error.issues.map((i) => ({ path: i.path.join(".") }));',
    ]);
    expect(issuePathJoins(sf)).toEqual([1, 2, 3, 4]);
  });

  it("(b) negative control: node:path joins and other joins are not reported", () => {
    const sf = fixture(['const a = path.join(dir, "x");', 'const b = classes.join(".");']);
    expect(issuePathJoins(sf)).toEqual([]);
  });

  it("(c) formatIssuePath keeps string / number text and accepts symbols", () => {
    expect(formatIssuePath(["a", 0, "b"])).toBe("a.0.b");
    expect(formatIssuePath([])).toBe("");
    expect(formatIssuePath(["a", Symbol("key")])).toBe("a.Symbol(key)");
  });

  it("(d) src has no raw join of an issue path and its default message", () => {
    const pkgRoot = path.resolve(__dirname, "../..");
    const found = parseDir(pkgRoot, "src")
      .filter(({ rel }) => !(rel in RAW_JOIN_EXEMPT))
      .flatMap(({ rel, sf }) => rawIssueMessageJoins(sf).map((line) => `${rel}:${line}`));
    expect(found).toEqual([]);
  });

  it("(d) positive control: template, object and function forms are detected", () => {
    const sf = fixture([
      "const a = e.issues.map((e) => `${formatIssuePath(e.path)}: ${e.message}`);",
      "const b = e.issues.map((e) => ({ path: formatIssuePath(e.path), message: e.message }));",
      "const c = e.issues.map(function (e) { return formatIssuePath(e.path) + e.message; });",
      "const d = e.issues.map((e) => `${utils.formatIssuePath(e.path)}: ${e['message']}`);",
    ]);
    expect(rawIssueMessageJoins(sf)).toEqual([1, 2, 3, 4]);
  });

  it("(d) negative control: the shared formatters and an unrelated error.message are not reported", () => {
    const sf = fixture([
      "const a = e.issues.map((e) => formatIssueLine(e));",
      "const b = e.issues.map((e) => ({ path: formatIssuePath(e.path), message: formatIssueMessage(e) }));",
      "function h(error) { const p = e.issues.map((e) => formatIssuePath(e.path)); log(error.message); }",
    ]);
    expect(rawIssueMessageJoins(sf)).toEqual([]);
  });

  const SENTINEL = "SECRET_KEY_9f3a";
  const strictFailure = (): z.ZodError => {
    const r = z
      .object({ a: z.string() })
      .strict()
      .safeParse({ a: "x", [SENTINEL]: 1 });
    if (r.success) throw new Error("expected a failure");
    return r.error;
  };

  it("(e) unrecognized_keys: fixed text, no key name, same text as the converter", () => {
    const issue = strictFailure().issues[0]!;
    expect(issue.code).toBe("unrecognized_keys");
    expect(formatIssueMessage(issue)).toBe(UNRECOGNIZED_KEYS_TEXT);
    expect(formatIssueLine(issue)).toBe(`: ${UNRECOGNIZED_KEYS_TEXT}`);
    expect(formatIssueLine(issue)).not.toContain(SENTINEL);
    const converted = formatZodError(strictFailure());
    expect(converted.map((c) => c.message).join(" ")).toContain(UNRECOGNIZED_KEYS_TEXT);
  });

  it("(e) other issues: `path: message` with the redacted path", () => {
    const r = z.object({ n: z.number(), styles: z.record(z.string(), z.number()) }).safeParse({
      n: "x",
      styles: { [SENTINEL]: "bad" },
    });
    if (r.success) throw new Error("expected a failure");
    const lines = r.error.issues.map((i) => formatIssueLine(i));
    expect(lines).toEqual(r.error.issues.map((i) => `${formatIssuePath(i.path)}: ${i.message}`));
    expect(lines.join("; ")).not.toContain(SENTINEL);
    expect(lines.some((l) => l.startsWith("styles.[key]: "))).toBe(true);
    expect(formatIssueMessage(r.error.issues[0]!)).toBe(r.error.issues[0]!.message);
  });
});
