// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SCHEMA-ENUM-004-C
 *
 * `skipReason` field の Zod schema が `EMBEDDING_SKIP_REASONS` を **named import
 * 経由で参照** していること (hand-written union literal 禁止) を検証する。
 *
 * PR2 silent-skip fix の契約:
 * - `src/tools/page/output.schemas.ts` が `EMBEDDING_SKIP_REASONS` を named
 *   import する (`import { EMBEDDING_SKIP_REASONS } from "../../workers/phases/types"`)
 * - `backfillPendingSkipRecoverySchema.skipReason` は
 *   `z.string().superRefine(...)` + `EMBEDDING_SKIP_REASONS.includes(value)`
 *   で検証する (hand-written `z.enum(["text_fork_failed", ...])` 禁止)
 * - hand-written string-literal union は ESLint / AST 検知対象
 *
 * この contract が崩れると、PR2 以前の silent-skip bug (Zod schema 側に値
 * 追加忘れで MCP response が schema mismatch を起こす) が再発する。
 *
 * PR2 silent-skip fix contract: `output.schemas.ts` must reference
 * `EMBEDDING_SKIP_REASONS` via named import (NOT re-declare the values as a
 * hand-written `z.enum([...])` or `z.union([z.literal(...), ...])`). Violation
 * reintroduces the PR2 silent-skip regression where Zod schema misses new
 * values added to TS SSOT.
 *
 * ADR-0016 Amendment 2-C mapping:
 * - `tests/workers/page-analyze-silent-skip-fix.test.ts` (regex / source static check)
 *
 * @see ADR-0016 § Invariants (INV-SCHEMA-ENUM-004-C)
 * @see src/tools/page/output.schemas.ts (`backfillPendingSkipRecoverySchema`)
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { assertInvName } from "../_setup/inv-assert";
import { addMcpServerSourceFile, createAstProject, extractNamedImports } from "./_extractors";

/**
 * Prisma `EmbeddingBackfillStatus` の値を hand-code した場合に当たる文字列
 * リテラル集合。Zod schema 本体にこれらが hand-coded されていた場合、test は
 * drift を検知する。
 *
 * String literals that would indicate a hand-written hard-coded union for
 * `skipReason` (if they appear in a `z.enum([...])` or similar non-SSOT
 * context). Used as a red-flag set for drift detection.
 */
const HARDCODED_SKIP_REASON_RED_FLAGS: readonly string[] = [
  "text_fork_failed",
  "visual_fork_failed",
  "dispatch_phase_failed",
  "v8_heap_headroom_low",
  "no_embeddable_items",
];

describe("INV-SCHEMA-ENUM-004-C: skipReason named-import invariant", () => {
  let outputSchemasFile: SourceFile;
  let namedImportsFromTypes: Set<string>;

  beforeAll(() => {
    const project = createAstProject();
    outputSchemasFile = addMcpServerSourceFile(project, "src/tools/page/output.schemas.ts");

    // Module specifier suffix must match the path from output.schemas.ts.
    // `src/tools/page/output.schemas.ts` → `../../workers/phases/types`
    namedImportsFromTypes = extractNamedImports(outputSchemasFile, "workers/phases/types");
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004-C");
  });

  it("INV-SCHEMA-ENUM-004-C: output.schemas.ts imports EMBEDDING_SKIP_REASONS by name", () => {
    // named import が存在しない場合、hand-written union literal に回帰している
    // 可能性が高い。PR2 silent-skip fix の SSOT 契約を強制する。
    //
    // If the named import is absent, the schema has likely regressed to a
    // hand-written union literal, reintroducing the PR2 silent-skip bug.
    expect(
      namedImportsFromTypes,
      `output.schemas.ts must import \`EMBEDDING_SKIP_REASONS\` from ` +
        `"../../workers/phases/types" as a named import. Hand-written union ` +
        `literals are forbidden (PR2 silent-skip fix contract).`
    ).toContain("EMBEDDING_SKIP_REASONS");
  });

  it("INV-SCHEMA-ENUM-004-C: hand-coded skip-reason literals do NOT appear in output.schemas.ts", () => {
    // source text の string literal 走査で hand-written union 検出。
    // `EMBEDDING_SKIP_REASONS` 使用時は string literal が source に現れない
    // (import された symbol 経由でのみアクセス) ため、`text_fork_failed` 等
    // の red-flag literal が見つかった時点で contract 違反。
    //
    // Walk all StringLiteral nodes in output.schemas.ts; if any red-flag skip
    // reason value appears as a literal, a hand-written union has regressed.
    const foundLiterals: Array<{ value: string; line: number }> = [];
    outputSchemasFile.forEachDescendant((node) => {
      const strLit = node.asKind(SyntaxKind.StringLiteral);
      if (!strLit) return;
      const v = strLit.getLiteralValue();
      if (HARDCODED_SKIP_REASON_RED_FLAGS.includes(v)) {
        foundLiterals.push({
          value: v,
          line: strLit.getStartLineNumber(),
        });
      }
    });

    expect(
      foundLiterals,
      `output.schemas.ts must NOT hard-code EmbeddingSkipReason values. Found: ` +
        `${JSON.stringify(foundLiterals)}. Use \`EMBEDDING_SKIP_REASONS\` ` +
        `(named import) in \`.superRefine()\` instead of literal values.`
    ).toEqual([]);
  });

  it("INV-SCHEMA-ENUM-004-C: backfillPendingSkipRecoverySchema uses superRefine + EMBEDDING_SKIP_REASONS", () => {
    // `backfillPendingSkipRecoverySchema` の構造を structural に検証する:
    //   1. VariableDeclaration が存在
    //   2. Initializer 内で `EMBEDDING_SKIP_REASONS` identifier が参照されている
    //   3. `superRefine` identifier が参照されている
    //
    // Structural check: the schema declaration exists, references the SSOT
    // identifier, and uses `superRefine` (not `z.enum` / `z.union`).
    const varDecl = outputSchemasFile.getVariableDeclaration("backfillPendingSkipRecoverySchema");
    expect(
      varDecl,
      `Variable \`backfillPendingSkipRecoverySchema\` not found in ` +
        `output.schemas.ts. The PR2 silent-skip-fix SSOT anchor is required.`
    ).toBeDefined();

    const init = varDecl?.getInitializer();
    expect(init, "backfillPendingSkipRecoverySchema has no initializer").toBeDefined();

    const initText = init?.getText() ?? "";

    // SSOT identifier 参照
    expect(
      initText,
      `backfillPendingSkipRecoverySchema must reference the SSOT identifier ` +
        `\`EMBEDDING_SKIP_REASONS\` (either via .includes() or similar).`
    ).toContain("EMBEDDING_SKIP_REASONS");

    // superRefine パターン
    expect(
      initText,
      `backfillPendingSkipRecoverySchema.skipReason must use \`.superRefine()\` ` +
        `(not \`z.enum()\` / \`z.union([z.literal(...)])\`).`
    ).toContain("superRefine");
  });
});
