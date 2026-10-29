// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — AST scan for `z.strictObject` on the worker IPC boundary
 * / worker IPC 境界の `z.strictObject` を AST で数える scan。
 *
 * Shared by INV-WORKER-IPC-STRICT-UNKNOWN-KEY-001 and INV-WORKER-LOCK-003 (Phase 5 IPC strict
 * parity), so the two source gates read the call structure the same way.
 *
 * What it reads: a call whose receiver is the identifier `z` and whose member name is
 * `strictObject` / `object` / `looseObject`, plus the chained `.strict()` / `.passthrough()` /
 * `.strip()` / `.catchall()`. It reads the structure, not the text, so the newline form
 * `z\n  .strictObject` that prettier produces for nested chains is counted like the one-line form.
 *
 * Known limit: a schema wrapped in another call (for example
 * `z.preprocess(fn, z.strictObject({...}))`) still counts as a `z.strictObject`, but the wrapper
 * itself is not inspected, so a wrap that changes what reaches the inner object is not detected.
 * The IPC schemas have no such wrap today; review one if it appears.
 *
 * @module tests/regression/standing/_setup/z-strict-object-scan
 */
import fs from "node:fs";
import ts from "typescript";

export interface Scan {
  strictObject: number;
  /** strictObject sites whose `z` and `.strictObject` sit on different lines (`z\n  .strictObject`). */
  multilineStrictObject: number;
  nonStrictObject: string[];
  strictChain: string[];
  looseForms: string[];
}

/** `z.<member>(...)` as a structure (receiver identifier `z`, property name), not as text. */
function zMember(n: ts.CallExpression): { member: string; sameLine: boolean } | null {
  const callee = n.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "z") return null;
  const sf = n.getSourceFile();
  const line = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line;
  return {
    member: callee.name.text,
    sameLine: line(callee.expression.getEnd()) === line(callee.name.getStart()),
  };
}

/**
 * Scan `text`. With `onlyDeclaration`, scan only the initializer of the top-level variable whose
 * name is exactly `onlyDeclaration` (not a name that merely starts with it); throws when no such
 * declaration exists, so a rename cannot turn the scan into an empty pass.
 */
export function scanText(label: string, text: string, onlyDeclaration?: string): Scan {
  const sf = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true);
  const out: Scan = {
    strictObject: 0,
    multilineStrictObject: 0,
    nonStrictObject: [],
    strictChain: [],
    looseForms: [],
  };
  const at = (n: ts.Node): string =>
    `${label}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const z = zMember(n);
      if (z?.member === "strictObject") {
        out.strictObject += 1;
        if (!z.sameLine) out.multilineStrictObject += 1;
      } else if (z?.member === "object") out.nonStrictObject.push(at(n));
      else if (z?.member === "looseObject") out.looseForms.push(at(n));
      else if (ts.isPropertyAccessExpression(n.expression)) {
        const m = n.expression.name.text;
        if (m === "strict") out.strictChain.push(at(n));
        if (["passthrough", "strip", "catchall"].includes(m)) out.looseForms.push(at(n));
      }
    }
    ts.forEachChild(n, visit);
  };
  if (onlyDeclaration) {
    let found = false;
    ts.forEachChild(sf, (top) => {
      if (!ts.isVariableStatement(top)) return;
      for (const d of top.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === onlyDeclaration && d.initializer) {
          found = true;
          visit(d.initializer);
        }
      }
    });
    if (!found) throw new Error(`${label}: no top-level declaration named ${onlyDeclaration}`);
  } else {
    visit(sf);
  }
  return out;
}

export function scanFile(absPath: string, onlyDeclaration?: string): Scan {
  return scanText(absPath, fs.readFileSync(absPath, "utf8"), onlyDeclaration);
}

/** The scan without the line-layout counter: what a real file is asserted against. */
export function withoutLayout(s: Scan): Omit<Scan, "multilineStrictObject"> {
  const { multilineStrictObject: _layout, ...rest } = s;
  return rest;
}
