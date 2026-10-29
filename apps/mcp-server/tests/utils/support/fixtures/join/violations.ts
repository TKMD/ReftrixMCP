// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Violation fixture for scanMessageJoinInSource: every line marked JOIN:<form> is a place that
// reads the default message of an issue list. The scanner must report exactly the marked lines.
import { external } from "./external";

interface Issue {
  message: string;
  path: string[];
}
interface Err {
  issues: Issue[];
  errors: Issue[];
}

function describe(i: Issue): string {
  return i.message;
}
const describeArrow = (i: Issue): string => i["message"];

export function forms(e: Err, out: string[]): string {
  const a = e.issues.map((i) => i.message); // JOIN:inline-callback
  const b = e.errors.map(describe); // JOIN:named-callback
  const c = e.errors.map(describeArrow); // JOIN:named-callback
  const d = e.issues.map(external); // JOIN:unresolved-callback
  const f = e.issues.map(({ message }) => message); // JOIN:inline-callback
  const g = e["issues"].map((i) => i.message); // JOIN:inline-callback
  const h = (e.issues as Issue[]).map((i) => i.message); // JOIN:inline-callback
  const k = e.issues!.map((i) => i.message); // JOIN:inline-callback
  e.issues.forEach((i) => out.push(i.message)); // JOIN:inline-callback
  const m = e.issues.reduce((acc, i) => acc + i.message, ""); // JOIN:inline-callback
  const n = e.issues.flatMap((i) => [i.message]); // JOIN:inline-callback
  const o = [...e.issues].map((i) => i.message); // JOIN:inline-callback
  const p = Array.from(e.errors).map((i) => i.message); // JOIN:inline-callback
  const q = e.issues.map((i) => describe(i)); // JOIN:unresolved-callback
  const same = describe;
  const r = e.issues.map(same); // JOIN:unresolved-callback
  return [a, b, c, d, f, g, h, k, m, n, o, p, q, r].join();
}

export function loops(e: Err): string {
  let text = "";
  for (const i of e.issues) text += i.message; // JOIN:for-of
  for (const { message } of e.errors) text += message; // JOIN:for-of
  for (const i of e.issues) text += describe(i); // JOIN:for-of
  return text;
}

export function aliases(e: Err): string[] {
  const { issues } = e;
  const { errors: list } = e;
  const copy = e.issues;
  return [
    ...issues.map((i) => i.message), // JOIN:inline-callback
    ...list.map((i) => i.message), // JOIN:inline-callback
    ...copy.map((i) => i.message), // JOIN:inline-callback
  ];
}

// the issue handed on inside an argument, by reduce, through a rest element or a local alias
export function handedOn(e: Err): unknown[] {
  return [
    e.issues.reduce((acc, i) => acc + describe(i), ""), // JOIN:unresolved-callback
    e.issues.map((i) => describe([i][0] as Issue)), // JOIN:unresolved-callback
    e.issues.map((i) => external({ issue: i })), // JOIN:unresolved-callback
    e.issues.map((i) => external(...[i])), // JOIN:unresolved-callback
    e.issues.map(({ path, ...rest }) => external(rest, path)), // JOIN:unresolved-callback
    e.issues.map(viaAlias), // JOIN:unresolved-callback
  ];
}

function viaAlias(i: Issue): string {
  const j = i;
  return describe(j);
}
