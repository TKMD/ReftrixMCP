// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — scoped function-body slicer for AST source-pin INVs
 * / scoped function-body slicer (AST source-pin INV 用)。
 *
 * Slices the **function body** of a named `async function <name>(` via
 * brace-matching, so an AST source-pin only inspects the in-body callsites of
 * the target function (W6 Issue A PR-3b F-05, PR-4a F-M-02/F-M-05 false-GREEN
 * remediation).
 *
 * A **file-wide** regex (or `stripLineComments` + regex) false-GREENs because:
 *   - a surviving `import { foo } from "..."` line matches the call-pin regex,
 *   - a surviving `/** ... *\/` JSDoc **block comment** (NOT stripped by a
 *     `//`-only line stripper) matches a `reason === "disallowed"` branch-pin,
 * so removing the production callsite/branch still leaves the test GREEN. Slicing
 * the function body excludes import lines AND `/* *\/` block comments (both live
 * outside the function body), making the drift-guard actually CI-RED.
 *
 * 指定した `async function <name>(` の **関数本体範囲** を brace-matching で切り
 * 出す。file-wide regex は import 行や `/** *\/` block comment に match して
 * false-GREEN になる (callsite/branch を除去しても GREEN のまま)。関数本体を slice
 * すると import 行と block comment が slice 対象外になり、drift-guard が CI-RED に
 * なる。
 *
 * @module tests/regression/standing/_setup/slice-function-body
 */

/**
 * 指定した `async function <name>(` の関数本体 (開き `{` から対応する閉じ `}` まで)
 * を brace-matching で切り出して返す。
 *
 * Returns the function body (from the opening `{` to its matching closing `}`)
 * of the named `async function <name>(`, via brace-matching.
 *
 * @param src - 走査対象のソース文字列 (line-comment stripped 済みでもよい) / source string to scan
 * @param fnName - 切り出す関数名 / function name to slice
 * @param invId - エラーメッセージ用の INV ID (診断目的) / INV ID for diagnostic error messages
 * @returns 関数本体 (`{ ... }` を含む) / the function body (including the braces)
 * @throws Error if the function, its opening brace, or a balanced closing brace is not found.
 */
export function sliceFunctionBody(src: string, fnName: string, invId: string): string {
  const sig = new RegExp(`async\\s+function\\s+${fnName}\\s*\\(`);
  const sigMatch = sig.exec(src);
  if (!sigMatch) {
    throw new Error(`[${invId}] function ${fnName} not found in source`);
  }
  // (1) パラメータリストの開き `(` を signature の `(` から特定し、対応する閉じ `)`
  //     まで paren-matching で進める。これにより `options?: { limit?: number }` の
  //     ような **param-list 内の型リテラル `{`** を body opener と取り違えない
  //     (naive `indexOf("{")` だと param-list の `{` を掴んで 30 文字で閉じる bug)。
  //
  //     Find the parameter list's opening `(` (the `(` of the signature) and
  //     advance via paren-matching to its closing `)`. This avoids mistaking a
  //     **type-literal `{` inside the param list** (e.g. `options?: { limit?: ... }`)
  //     for the body opener (a naive `indexOf("{")` would grab the param-list `{`
  //     and close after ~30 chars).
  const parenOpenIdx = src.indexOf("(", sigMatch.index);
  if (parenOpenIdx === -1) {
    throw new Error(`[${invId}] parameter-list opening paren for ${fnName} not found`);
  }
  let parenDepth = 0;
  let parenCloseIdx = -1;
  for (let i = parenOpenIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        parenCloseIdx = i;
        break;
      }
    }
  }
  if (parenCloseIdx === -1) {
    throw new Error(`[${invId}] unbalanced parens in parameter list of ${fnName}`);
  }
  // (2) 関数本体の開き `{` を、param-list の閉じ `)` の **後** で探す
  //     (return-type annotation `: Promise<void>` を跨いだ最初の `{` が body opener)。
  //     Find the body's opening `{` AFTER the param-list closing `)` (the first
  //     `{` past the return-type annotation `: Promise<void>` is the body opener).
  const openIdx = src.indexOf("{", parenCloseIdx);
  if (openIdx === -1) {
    throw new Error(`[${invId}] body opening brace for ${fnName} not found`);
  }
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return src.slice(openIdx, i + 1);
      }
    }
  }
  throw new Error(`[${invId}] unbalanced braces while slicing ${fnName}`);
}
