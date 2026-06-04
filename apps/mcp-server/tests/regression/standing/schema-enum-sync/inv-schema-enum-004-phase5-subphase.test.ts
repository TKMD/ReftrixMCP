// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SCHEMA-ENUM-004 (Phase 5 sub-phase enum family)
 *
 * PR-BT-5 (M-1-RSS, ADR-0039 Decision 3, Conflict 1): verifies that the IPC
 * `subPhase` enum in `phase-5-child-ipc.ts` is **SSOT-derived** from
 * `PHASE5_TEXT_SUBPHASES` / `PHASE5_VISUAL_SUBPHASES`
 * (`phase-5-subphases.const.ts`) via `z.enum(...)` — NOT re-declared as a
 * hand-written `z.enum([...literal...])`.
 *
 * Same named-import + hand-written-literal red-flag sweep pattern as
 * `inv-schema-enum-004-c.test.ts` (the canonical SSOT-derive AST guard).
 *
 * **Scope = IPC-internal 2-site (TS const ↔ Zod) ONLY (IO V-4 correction)**:
 * `subPhase` is neither Prisma-persisted nor MCP-tool-spec-exposed, so the
 * Prisma↔TS↔Zod↔MCP 4-site exhaustive mapping of the broader INV-SCHEMA-ENUM-004
 * is **N/A** for this enum family. This test asserts only that the IPC Zod
 * schema derives from the TS SSOT const (no hand-written literal drift).
 *
 * The existing `inv-schema-enum-004-c.test.ts` AST sweep is scoped to the
 * `EMBEDDING_SKIP_REASONS` family in `src/tools/page/output.schemas.ts` and does
 * NOT cover the new `subPhase` `z.enum` (a different file / different enum
 * family) — hence this dedicated guard (ADR-0039 Decision 3 / IO V-4).
 *
 * PR-BT-5 (M-1-RSS): `phase-5-child-ipc.ts` の `subPhase` enum が SSOT const
 * (`PHASE5_TEXT_SUBPHASES` / `PHASE5_VISUAL_SUBPHASES`) から `z.enum()` で
 * derive されていること (hand-written literal 禁止) を AST で guard する。
 * scope は IPC-internal 2-site (TS const ↔ Zod) のみ。
 *
 * test is a CI-failing executable invariant. `.skip()` / `.todo()` are
 * forbidden; any failure is a P0 incident.
 *
 * @see  Decision 3
 * @see src/workers/phases/phase-5-subphases.const.ts (SSOT)
 * @see src/workers/phases/phase-5-child-ipc.ts (z.enum derive site)
 * @see inv-schema-enum-004-c.test.ts (canonical pattern)
 * @module tests/regression/standing/schema-enum-sync/inv-schema-enum-004-phase5-subphase
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { assertInvName } from "../_setup/inv-assert";
import {
  addMcpServerSourceFile,
  createAstProject,
  extractConstStringArray,
  extractNamedImports,
} from "./_extractors";
import {
  PHASE5_TEXT_SUBPHASES,
  PHASE5_VISUAL_SUBPHASES,
} from "../../../../src/workers/phases/phase-5-subphases.const";

/**
 * Hand-written sub-phase literals that would indicate a regression to a
 * hand-coded `z.enum([...])` in the IPC schema (instead of deriving from the
 * SSOT const). Used as a red-flag set for the AST string-literal sweep.
 *
 * Built from BOTH SSOT arrays so adding/removing a sub-phase keeps the red-flag
 * set in sync automatically.
 */
const HARDCODED_SUBPHASE_RED_FLAGS: readonly string[] = [
  ...PHASE5_TEXT_SUBPHASES,
  ...PHASE5_VISUAL_SUBPHASES,
];

describe("INV-SCHEMA-ENUM-004: Phase 5 subPhase SSOT-derive invariant", () => {
  let ipcFile: SourceFile;
  let constFile: SourceFile;
  let namedImportsFromConst: Set<string>;

  beforeAll(() => {
    const project = createAstProject();
    ipcFile = addMcpServerSourceFile(project, "src/workers/phases/phase-5-child-ipc.ts");
    constFile = addMcpServerSourceFile(project, "src/workers/phases/phase-5-subphases.const.ts");

    // Module specifier suffix as imported from phase-5-child-ipc.ts:
    //   `src/workers/phases/phase-5-child-ipc.ts` → `./phase-5-subphases.const`
    namedImportsFromConst = extractNamedImports(ipcFile, "phase-5-subphases.const");
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
  });

  it("INV-SCHEMA-ENUM-004: phase-5-child-ipc.ts imports both SSOT sub-phase const arrays by name", () => {
    // named import が存在しない場合、IPC schema が hand-written z.enum literal に
    // 回帰している可能性が高い。ADR-0039 Decision 3 の SSOT-derive 契約を強制する。
    //
    // If the named imports are absent, the IPC schema has likely regressed to a
    // hand-written `z.enum([...])`, reintroducing enum drift (ADR-0039 Decision 3).
    expect(
      namedImportsFromConst,
      `phase-5-child-ipc.ts must import \`PHASE5_TEXT_SUBPHASES\` from ` +
        `"./phase-5-subphases.const" as a named import. Hand-written z.enum literals are ` +
        `forbidden (ADR-0039 Decision 3 SSOT-derive contract).`
    ).toContain("PHASE5_TEXT_SUBPHASES");
    expect(
      namedImportsFromConst,
      `phase-5-child-ipc.ts must import \`PHASE5_VISUAL_SUBPHASES\` from ` +
        `"./phase-5-subphases.const" as a named import.`
    ).toContain("PHASE5_VISUAL_SUBPHASES");
  });

  it("INV-SCHEMA-ENUM-004: hand-coded sub-phase literals do NOT appear in phase-5-child-ipc.ts", () => {
    // source text の string literal 走査で hand-written z.enum を検出。SSOT const
    // 使用時は sub-phase 値が IPC source に string literal として現れない (import
    // された symbol 経由でのみアクセス) ため、`section_text` 等の red-flag literal が
    // 見つかった時点で contract 違反。
    //
    // Walk all StringLiteral nodes in phase-5-child-ipc.ts; if any red-flag
    // sub-phase value appears as a literal, a hand-written z.enum has regressed.
    const foundLiterals: Array<{ value: string; line: number }> = [];
    ipcFile.forEachDescendant((node) => {
      const strLit = node.asKind(SyntaxKind.StringLiteral);
      if (!strLit) return;
      const v = strLit.getLiteralValue();
      if (HARDCODED_SUBPHASE_RED_FLAGS.includes(v)) {
        foundLiterals.push({ value: v, line: strLit.getStartLineNumber() });
      }
    });

    expect(
      foundLiterals,
      `phase-5-child-ipc.ts must NOT hard-code Phase 5 sub-phase values. Found: ` +
        `${JSON.stringify(foundLiterals)}. Use \`z.enum(PHASE5_TEXT_SUBPHASES)\` / ` +
        `\`z.enum(PHASE5_VISUAL_SUBPHASES)\` (named import) instead of literal values.`
    ).toEqual([]);
  });

  it("INV-SCHEMA-ENUM-004: SSOT const arrays are well-formed (7 text + 2 visual = 9, no overlap)", () => {
    // SSOT 自身の健全性: text 7 + visual 2 = 9、重複なし (fork-count cap の前提)。
    // AST 経由でも extract できることを確認 (extractConstStringArray が throw しない)。
    //
    // SSOT health: text 7 + visual 2 = 9, no overlap (fork-count cap precondition).
    const textViaAst = extractConstStringArray(constFile, "PHASE5_TEXT_SUBPHASES");
    const visualViaAst = extractConstStringArray(constFile, "PHASE5_VISUAL_SUBPHASES");

    // AST-extracted values must equal the runtime-imported SSOT (no drift between
    // the declaration and the runtime const).
    expect(textViaAst).toEqual([...PHASE5_TEXT_SUBPHASES]);
    expect(visualViaAst).toEqual([...PHASE5_VISUAL_SUBPHASES]);

    expect(PHASE5_TEXT_SUBPHASES.length).toBe(7);
    expect(PHASE5_VISUAL_SUBPHASES.length).toBe(2);

    const all = [...PHASE5_TEXT_SUBPHASES, ...PHASE5_VISUAL_SUBPHASES];
    const unique = new Set(all);
    expect(
      unique.size,
      `Phase 5 sub-phase identifiers must be unique across text + visual ` +
        `(found duplicate). all=${JSON.stringify(all)}`
    ).toBe(9);
  });
});
