// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — schema-enum-sync domain
 *
 * INV-BACKFILL-FAILURE-REASON-EXHAUSTIVE-006 (Plan v3 T3-Backfill V1 Wave 2):
 *   `EMBEDDING_BACKFILL_FAILURE_REASONS` 12-element SSOT array (NEW V1) と
 *   `classifyFailureReasonPolicy()` Strategy dispatcher の exhaustive switch
 *   が完全一致することを保証する (cross-cutting AST 検証)。
 *
 *   - **T1 Canonical (SSOT)**: `src/queues/embedding-backfill-queue.ts` の
 *     `EMBEDDING_BACKFILL_FAILURE_REASONS` const 配列 (12 値)
 *   - **Exhaustive switch**: `src/utils/embedding-backfill-failure-reason-helpers.ts`
 *     の `classifyFailureReasonPolicy()` は 12 値を全網羅 (compile-time `never`
 *     check と併用した 2 重防御)
 *   - **Zod 同期**: `EmbeddingBackfillFailureReasonSchema` は SSOT 配列を
 *     `z.enum()` factory に渡すことで派生 (runtime drift 防止)
 *
 * INV-BACKFILL-FAILURE-REASON-EXHAUSTIVE-006 (Plan v3 T3-Backfill V1 Wave 2):
 *   Asserts the 12-element `EMBEDDING_BACKFILL_FAILURE_REASONS` SSOT array
 *   (NEW in V1) and the `classifyFailureReasonPolicy()` Strategy dispatcher
 *   exhaustive switch are in perfect sync (cross-cutting AST verification).
 *
 * @see Plan v3 T3-Backfill V1 §3.1 axis B / §4.1 INV-006
 * @see ADR-0007 Amendment 1 §A1.2.3 (12-element enum SSOT)
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  addMcpServerSourceFile,
  createAstProject,
  extractConstStringArray,
  extractSwitchCaseLabels,
  setDifference,
} from "./_extractors";

/**
 * V1 §3.1 axis B SSOT: 12-element failure reason enum.
 *
 * Plan v3 T3-Backfill V1 §3.1 axis B authoritative ordering. Append-only;
 * removal requires a Prisma schema migration + sibling track coordination.
 */
const EXPECTED_FAILURE_REASONS: readonly string[] = [
  "vision_residual",
  "vision_unload_timeout",
  "ssrf_blocked",
  "parity_check_failed",
  "bbox_unresolvable",
  "screenshot_missing",
  "memory_pressure",
  "fork_error",
  "stall_timeout",
  "lock_lost",
  "supervisor_restart_orphan",
  "dual_run_race",
];

describe("INV-BACKFILL-FAILURE-REASON-EXHAUSTIVE-006: 12-element failure reason SSOT consistency", () => {
  let ssotValues: string[];
  let switchLabels: string[];

  beforeAll(() => {
    const project = createAstProject();

    // SSOT: src/queues/embedding-backfill-queue.ts
    const queueFile = addMcpServerSourceFile(project, "src/queues/embedding-backfill-queue.ts");
    ssotValues = extractConstStringArray(queueFile, "EMBEDDING_BACKFILL_FAILURE_REASONS");

    // Exhaustive switch: src/utils/embedding-backfill-failure-reason-helpers.ts
    // #classifyFailureReasonPolicy
    const helpersFile = addMcpServerSourceFile(
      project,
      "src/utils/embedding-backfill-failure-reason-helpers.ts"
    );
    switchLabels = extractSwitchCaseLabels(helpersFile, "classifyFailureReasonPolicy");
  });

  beforeEach(() => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-BACKFILL-FAILURE-REASON-EXHAUSTIVE-006"
    );
  });

  it("INV-BACKFILL-FAILURE-REASON-EXHAUSTIVE-006: SSOT has exactly 12 values per Plan v3 T3-Backfill V1 §3.1 axis B", () => {
    // 12 値は IO Plan Decision §13.5 U-T3B-5 + ADR-0007 Amendment 1 §A1.2.3
    // で確定した SSOT array contract。追加 / 削除は Prisma migration を伴う。
    expect(ssotValues).toHaveLength(12);

    // Each expected value must be present and distinct.
    for (const expectedValue of EXPECTED_FAILURE_REASONS) {
      expect(ssotValues).toContain(expectedValue);
    }

    // 宣言順序まで含めて契約的に固定する (追加順序のドリフトを検出)。
    const diff = setDifference(EXPECTED_FAILURE_REASONS, ssotValues);
    expect(diff.onlyInA, "SSOT is missing expected failure reasons").toEqual([]);
    expect(diff.onlyInB, "SSOT contains unexpected failure reasons").toEqual([]);
  });

  it("INV-BACKFILL-FAILURE-REASON-EXHAUSTIVE-006: Strategy dispatcher classifyFailureReasonPolicy() exhaustive switch covers every SSOT value", () => {
    // classifyFailureReasonPolicy() が 12 値を全網羅すること。SSOT に新値が
    // 追加された場合、本 test で検知される (compile 時の never check と併用した
    // 2 重防御)。
    const diff = setDifference(ssotValues, switchLabels);
    expect(
      diff.onlyInA,
      `exhaustive switch in classifyFailureReasonPolicy() is missing cases for ` +
        `${JSON.stringify(diff.onlyInA)}. Every EMBEDDING_BACKFILL_FAILURE_REASONS ` +
        `value must have a corresponding case clause.`
    ).toEqual([]);
    expect(
      diff.onlyInB,
      `exhaustive switch contains case labels not present in ` +
        `EMBEDDING_BACKFILL_FAILURE_REASONS: ${JSON.stringify(diff.onlyInB)}. Switch ` +
        `cases must not reference non-SSOT values.`
    ).toEqual([]);
  });

  it("INV-BACKFILL-FAILURE-REASON-EXHAUSTIVE-006: SSOT contains the joint contract C-1 entries (vision_residual + vision_unload_timeout)", () => {
    // ADR-0007 Amendment 1 §A1.2.1 C-1 winning contract: T3-Vision V1 と T3-Backfill V1
    // の joint contract で必ず含まれる 2 値。これらが欠けると Wave 1 / Wave 2 の
    // SSOT alignment が崩れる。
    expect(ssotValues).toContain("vision_residual");
    expect(ssotValues).toContain("vision_unload_timeout");
    // 2 値は distinct (alias 化禁止 — それぞれ異なる recovery semantic を持つ)。
    expect(ssotValues.indexOf("vision_residual")).not.toBe(
      ssotValues.indexOf("vision_unload_timeout")
    );
  });
});
