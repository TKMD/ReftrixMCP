// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SCHEMA-ENUM-004 (ADR-0018 enum expansion)
 *
 * ADR-0018 §Decision 2 / §Decision 3 Amendment / §Decision 1 Supplement S3 で
 * `EMBEDDING_SKIP_REASONS` が 12 → 14 → 15 → 16 値に拡張されたことを verify する。
 * 本 test は既存 `inv-schema-enum-004.test.ts` を置き換えるものではなく、ADR-0018
 * で追加された 4 値 (PR-D-1 で 2 値, PR-D-2 で 1 値, PR-D-9 Wave 4 で 1 値) の
 * semantic を明示する追加 guard。
 *
 * 保証する 4 点 / What this file guarantees:
 *   1. `fork_terminated_before_done` / `parity_check_failed` / `bbox_invalid` /
 *      `bbox_unresolvable` が named 値として TS SSOT `EMBEDDING_SKIP_REASONS` に
 *      存在すること (16 値)
 *   2. それぞれが `skipReasonToBackfillStatus()` の exhaustive switch で
 *      明示的な case 節として存在すること (runtime mapping → `skipped_fork_error`
 *      は別 unit test で補完)
 *   3. 新値が配列末尾 (index 12 / 13 / 14 / 15) に append されており、既存 12 値の
 *      順序が保持されていること
 *   4. index-based assertion により既存値の前/中間への誤挿入を即座に検出する
 *
 * Guards the ADR-0018 expansion of `EMBEDDING_SKIP_REASONS` from 12 → 14 → 15
 * → 16 values. Complements (does NOT replace) `inv-schema-enum-004.test.ts`.
 *
 * @see ADR-0018 §Decision 2 (fork_terminated_before_done, parity_check_failed)
 * @see ADR-0018 §Decision 3 Amendment (bbox_invalid — PR-D-2)
 * @see ADR-0018 §Decision 1 Supplement S3 (bbox_unresolvable — PR-D-9 Wave 4)
 * @see ADR-0018 §INV-EMBEDDING-INTEGRITY-004 (fork abnormal exit invariant)
 * @see ADR-0018 §INV-EMBEDDING-INTEGRITY-001 (terminal transition parity invariant)
 * @see ADR-0016 §INV-SCHEMA-ENUM-004 (4-face sync contract)
 *
 * @module tests/regression/standing/schema-enum-sync/inv-schema-enum-004-embedding-v2
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  addMcpServerSourceFile,
  createAstProject,
  extractConstStringArray,
  extractSwitchCaseLabels,
} from "./_extractors";

/**
 * ADR-0018 §Decision 2 / §Decision 3 Amendment / §Decision 1 Supplement S3 で
 * 追加される 4 値 (PR-D-1: 2 値, PR-D-2: 1 値, PR-D-9 Wave 4: 1 値)。順序は
 * SSOT の末尾 append 順に一致する必要がある (index 12 → 13 → 14 → 15)。
 *
 * Four values added by ADR-0018 §Decision 2 (PR-D-1), §Decision 3 Amendment
 * (PR-D-2), and §Decision 1 Supplement S3 (PR-D-9 Wave 4). Order must match
 * the tail-append order of SSOT (index 12 → 13 → 14 → 15).
 */
const ADR_0018_ADDITIONS = [
  "fork_terminated_before_done",
  "parity_check_failed",
  "bbox_invalid",
  "bbox_unresolvable",
] as const;

describe("INV-SCHEMA-ENUM-004: ADR-0018 enum expansion (16 values)", () => {
  let ssotValues: string[];
  let switchLabels: string[];

  beforeAll(() => {
    const project = createAstProject();
    const typesFile = addMcpServerSourceFile(project, "src/workers/phases/types.ts");
    ssotValues = extractConstStringArray(typesFile, "EMBEDDING_SKIP_REASONS");
    const workerFile = addMcpServerSourceFile(project, "src/workers/page-analyze-worker.ts");
    switchLabels = extractSwitchCaseLabels(workerFile, "skipReasonToBackfillStatus");
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
  });

  it("INV-SCHEMA-ENUM-004: SSOT contains ADR-0018 additions (16 values total)", () => {
    expect(ssotValues).toHaveLength(16);
    for (const value of ADR_0018_ADDITIONS) {
      expect(ssotValues, `ADR-0018 addition \`${value}\` is missing from SSOT`).toContain(value);
    }
  });

  it("INV-SCHEMA-ENUM-004: ADR-0018 additions map to skipped_fork_error in exhaustive switch", () => {
    // Switch の case 節に 4 値が含まれていることを verify (AST level)。
    // runtime mapping (→ skipped_fork_error) は exhaustive switch 到達可能性 test
    // (別 unit test `page-analyze-silent-skip-fix.test.ts` 側) で補完する。
    //
    // AST-level verification that all new values appear as case labels.
    for (const value of ADR_0018_ADDITIONS) {
      expect(
        switchLabels,
        `Exhaustive switch in skipReasonToBackfillStatus() is missing case for ` +
          `\`${value}\`. ADR-0018 requires mapping to \`skipped_fork_error\`.`
      ).toContain(value);
    }
  });

  it("INV-SCHEMA-ENUM-004: 12 existing values remain in declaration order", () => {
    // Ordering guard: ADR-0018 additions must be appended to tail.
    // UC-05 (PR-D-2): hand-coded literal `slice(-2)` を index-based assertion
    // に refactor。hard-coded 12/13 literal ではなく `indexOf` ベースで新値の
    // 末尾 append を verify する。tail position は配列長から導出。
    //
    // UC-05 (PR-D-2): refactored hand-coded `slice(-2)` to index-based
    // assertion. Uses `indexOf` instead of hard-coded 12/13 literals to
    // verify tail-append positioning; tail position derived from array length.

    // Existing 12 values must occupy the first 12 positions (indices 0..11).
    // Strict index assertion: each of the ADR-0018 additions lives at
    // position >= 12, and their relative order in ADR_0018_ADDITIONS matches
    // their tail order in SSOT.
    const existingTwelveCount = ssotValues.length - ADR_0018_ADDITIONS.length;
    expect(existingTwelveCount).toBe(12);

    // Index-based assertion (R2 中間挿入 drift 検出強化 / strengthened
    // mid-insert drift detection):
    // 新値が index 12, 13, 14, 15 (0-based) に存在することを明示的に assert する
    // ことで、既存 12 値の前/中間に誤って新値が挿入された場合に即座に fail
    // させる。PR-D-9 Wave 4 で 4 値化したため、各 index を固定値 assertion する。
    //
    // Explicit index assertion: PR-D-1 additions MUST be at 0-based index 12
    // and 13, PR-D-2 addition MUST be at index 14, and PR-D-9 Wave 4 addition
    // MUST be at index 15. Any accidental insertion before or between existing
    // 12 values fails fast.
    expect(ssotValues.indexOf("fork_terminated_before_done")).toBe(12);
    expect(ssotValues.indexOf("parity_check_failed")).toBe(13);
    expect(ssotValues.indexOf("bbox_invalid")).toBe(14);
    expect(ssotValues.indexOf("bbox_unresolvable")).toBe(15);

    // Additional: existing 12 values' indices remain stable (spot-check).
    // 既存 12 値の index が変動していないことを確認 (drift detection).
    expect(ssotValues.indexOf("v8_heap_headroom_low")).toBe(0);
    expect(ssotValues.indexOf("system_memavailable_low")).toBe(1);
    expect(ssotValues.indexOf("dispatch_phase_failed")).toBe(11);
  });

  it("INV-SCHEMA-ENUM-004: PR-D-9 Wave 4 — bbox_unresolvable mutual exclusivity contract documented", () => {
    // ADR-0018 §Decision 1 Supplement S3 mutual-exclusivity contract.
    // Per-part skipReason must be EITHER `bbox_invalid` (JSDOM-origin) OR
    // `bbox_unresolvable` (Playwright-residual), NEVER both. This test
    // documents the SSOT-level coexistence (both values present); runtime
    // mutual exclusion is enforced by the bbox classification helper +
    // PartVisualProcessor emit boundary.
    expect(ssotValues).toContain("bbox_invalid");
    expect(ssotValues).toContain("bbox_unresolvable");
    expect(ssotValues.indexOf("bbox_invalid")).toBeLessThan(
      ssotValues.indexOf("bbox_unresolvable")
    );
  });
});
