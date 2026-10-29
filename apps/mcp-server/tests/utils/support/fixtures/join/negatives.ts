// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Negative fixture for scanMessageJoinInSource and scanFirstIssueInSource: none of these reads the
// default message of an issue list, or picks one issue out of it.
interface Issue {
  message: string;
  path: string[];
}
interface Err {
  issues: Issue[];
}

function pathOf(i: Issue): string[] {
  return i.path;
}

export function negatives(e: Err, errors: Issue[], rows: Issue[]): unknown[] {
  const a = e.issues.map((i) => i.path);
  const b = e.issues.map(pathOf);
  const c = errors.map((i) => i.message); // a parameter that merely has the name `errors`
  const d = rows.map((i) => i.message);
  const n = e.issues.length + e["issues"].length;
  const part = e.issues.slice(0, 5);
  for (const i of e.issues) a.push(i.path);
  const paths = e.issues.map((i) => pathOf({ message: "", path: i.path })); // only a field is handed on
  const total = e.issues.reduce((acc, i) => acc + String(acc) + i.path.length, 0); // accumulator only
  return [a, b, c, d, n, part, paths, total];
}
