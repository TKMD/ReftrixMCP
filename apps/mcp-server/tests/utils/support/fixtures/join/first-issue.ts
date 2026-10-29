// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Violation fixture for scanFirstIssueInSource: READ marks a line that picks one issue out of the
// list, MSG a line that reads the default message of one. The scanner must report exactly these.
interface Issue {
  message: string;
  path: string[];
}
interface Err {
  issues: Issue[];
  errors: Issue[];
}

export function forms(e: Err, i: number): unknown[] {
  const a = e.issues[0]?.message; // READ MSG
  const b = e.issues[i]?.message; // READ MSG
  const c = e.errors.at(-1)!.message; // READ MSG
  const d = (e.issues[0] as Issue).message; // READ MSG
  const f = e.issues.find((x) => x.path.length === 0)!.message; // READ MSG
  const g = e.issues.shift()?.message; // READ MSG
  const h = e["issues"][0]["message"]; // READ MSG
  const { message } = e.issues[0]; // READ MSG
  const p = e.issues[0].path; // READ
  return [a, b, c, d, f, g, h, message, p];
}

export function holders(e: Err): unknown[] {
  const first = e.errors[0]!; // READ
  const [head] = e.issues; // READ
  let later: Issue | undefined;
  later = e.issues.at(0); // READ
  const { issues } = e;
  const viaAlias = issues[0]; // READ
  return [
    first.message, // MSG
    head?.message, // MSG
    later?.message, // MSG
    viaAlias.message, // MSG
    (first as Issue).message, // MSG
    first["message"], // MSG
  ];
}
