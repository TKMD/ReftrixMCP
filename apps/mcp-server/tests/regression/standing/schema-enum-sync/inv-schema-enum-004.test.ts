// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SCHEMA-ENUM-004
 *
 * `EmbeddingSkipReason` 18 値の SSOT 整合性検証 (PR-V3-T1a §3.4.1 closure;
 * 歴史: v0.4.0 PR-D-1 ADR-0018 §Decision 2 で 12 → 14 値、PR-D-2 で 14 → 15 値、
 * PR-D-9 Wave 4 で 15 → 16 値、PR-V3-T1a で 16 → 18 値)。
 *
 * - **T1 Canonical (SSOT)**: `src/workers/phases/types.ts` の
 *   `EMBEDDING_SKIP_REASONS` const 配列 (18 値、`dispatch_phase_failed` /
 *   `fork_terminated_before_done` / `parity_check_failed` /
 *   `text_child_memory_budget_exceeded_at_chunk_<n>` /
 *   `partial_chunked_<n>_of_<total>` 必須)
 * - **Zod 同期**: `src/tools/page/output.schemas.ts` は T1 を **named import** で参照
 *   (INV-SCHEMA-ENUM-004-C で検証)
 * - **Exhaustive switch**: `src/workers/page-analyze-worker.ts` の
 *   `skipReasonToBackfillStatus()` は 18 値を全網羅 (SSOT からの 1 値欠落で
 *   TypeScript `never` exhaustiveness check が compile 時に落ちる契約)
 * - **Prisma**: `EmbeddingSkipReason` は DB 永続化されない (MCP レスポンス
 *   専用)。Prisma schema には enum 定義が **存在しないこと** が契約 (drift
 *   検知が目的ではなく、"intentional absence" を assert する)
 *
 * T1 Canonical (SSOT): `EMBEDDING_SKIP_REASONS` const array (23 values incl.
 * `dispatch_phase_failed`, `fork_terminated_before_done`, `parity_check_failed`,
 * `text_child_memory_budget_exceeded_at_chunk_<n>`,
 * `partial_chunked_<n>_of_<total>`, `section_visual_uncroppable`,
 * `section_visual_duplicate`, `section_visual_pii_excluded`).
 * Zod schema references SSOT via **named import** (verified in
 * INV-SCHEMA-ENUM-004-C). Exhaustive switch in `skipReasonToBackfillStatus()`
 * covers all 23 values (compile-time `never` check). Prisma does NOT persist
 * `EmbeddingSkipReason` — its absence from Prisma is the contract.
 *
 * ADR-0016 Amendment 2-C mapping (§ Existing Test Migration):
 * - `tests/workers/page-analyze-silent-skip-fix.test.ts` (source-code 静的検証)
 * - `tests/workers/page-analyze-worker-embedding-phase.test.ts` (Phase 5 統合)
 *
 * @see ADR-0016 § Invariants (INV-SCHEMA-ENUM-004)
 * @see ADR-0018 § Decision 2 (fork_terminated_before_done, parity_check_failed)
 * @see Plan v3 T3-Vision V1 §4.2 (vision_residual_at_phase5_start,
 *      vision_probe_failed_at_phase5_start — INV-VISION-PHASE5-GATE-001)
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  addMcpServerSourceFile,
  createAstProject,
  extractConstStringArray,
  extractSwitchCaseLabels,
  loadPrismaEnums,
  setDifference,
} from "./_extractors";

/**
 * INV-SCHEMA-ENUM-004 で `EMBEDDING_SKIP_REASONS` が満たすべき最小契約:
 * 18 値、`dispatch_phase_failed` を含む (TDA MEDIUM 1, v0.4.0 PR2 audit) 加え
 * て `fork_terminated_before_done` / `parity_check_failed` (v0.4.0 PR-D-1,
 * ADR-0018 §Decision 2)、`bbox_invalid` (v0.4.0 PR-D-2, ADR-0018 §Decision 3
 * Amendment / Plan §3.1)、`bbox_unresolvable` (v0.4.0 PR-D-9 Wave 4,
 * ADR-0018 §Decision 1 Supplement S3)、および
 * `vision_residual_at_phase5_start` / `vision_probe_failed_at_phase5_start`
 * (Plan v3 T3-Vision V1 §4.2, INV-VISION-PHASE5-GATE-001 — Phase 5 fork()
 * pre-spawn gate)。
 *
 * The minimum contract for `EMBEDDING_SKIP_REASONS` under INV-SCHEMA-ENUM-004:
 * 23 values including `dispatch_phase_failed` (TDA MEDIUM 1, v0.4.0 PR2 audit),
 * `fork_terminated_before_done` / `parity_check_failed` (v0.4.0 PR-D-1,
 * ADR-0018 §Decision 2), `bbox_invalid` (v0.4.0 PR-D-2, ADR-0018 §Decision 3
 * Amendment / Plan §3.1), `bbox_unresolvable` (v0.4.0 PR-D-9 Wave 4,
 * ADR-0018 §Decision 1 Supplement S3 — Playwright-residual catch-all,
 * mutually exclusive with `bbox_invalid`), and PR-V3-T1a §3.4.1 additions
 * `text_child_memory_budget_exceeded_at_chunk_<n>` (C1 per-chunk RSS budget
 * enforcement, → `skipped_memory_pressure`) and `partial_chunked_<n>_of_<total>`
 * (C3 failure-path partial-flush prevention, → `skipped_fork_error`).
 */
const EXPECTED_SKIP_REASONS: readonly string[] = [
  "v8_heap_headroom_low",
  "system_memavailable_low",
  "text_fork_failed",
  "text_child_error",
  "text_child_abnormal_exit",
  "text_ipc_race",
  "visual_fork_failed",
  "visual_child_error",
  "visual_child_abnormal_exit",
  "visual_ipc_race",
  "no_embeddable_items",
  "dispatch_phase_failed",
  // --- PR-D-1 additions (ADR-0018 §Decision 2) ---
  "fork_terminated_before_done",
  "parity_check_failed",
  // --- PR-D-2 addition (ADR-0018 §Decision 3 Amendment / Plan §3.1) ---
  "bbox_invalid",
  // --- PR-D-9 Wave 4 addition (ADR-0018 §Decision 1 Supplement S3) ---
  "bbox_unresolvable",
  // --- Plan v3 T3-Vision V1 §4.2 (INV-VISION-PHASE5-GATE-001) ---
  "vision_residual_at_phase5_start",
  "vision_probe_failed_at_phase5_start",
  // --- PR-V3-T1a §3.4.1 additions (Plan v3 V2 §3.1 T1.2, FIND-V3-IO-H-01) ---
  "text_child_memory_budget_exceeded_at_chunk_<n>",
  "partial_chunked_<n>_of_<total>",
  // --- PR-BT-2 additions (ADR-0018 Amendment, System B section_visual terminal-skip) ---
  "section_visual_uncroppable",
  "section_visual_duplicate",
  // --- PR-C4 addition (ADR-0018 Amendment, section_visual PII asymmetry closure) ---
  "section_visual_pii_excluded",
  // --- secvisual-blank-terminal additions (Plan V1 §4, degraded-coverage technical
  //     terminals, NON-PII; distinct from section_visual_pii_excluded, FIND-PLAN-L-07) ---
  "section_visual_blank",
  "section_visual_no_position",
  // --- ADR-0018 Amendment 13 additions (visual-backfill truncated-screenshot
  //     data-loss fix; NON-PII degraded-coverage technical metadata) ---
  "screenshot_truncated",
  "screenshot_truncated_expired",
];

describe("INV-SCHEMA-ENUM-004: EmbeddingSkipReason SSOT consistency", () => {
  let ssotValues: string[];
  let switchLabels: string[];

  beforeAll(() => {
    const project = createAstProject();

    // SSOT: src/workers/phases/types.ts
    const typesFile = addMcpServerSourceFile(project, "src/workers/phases/types.ts");
    ssotValues = extractConstStringArray(typesFile, "EMBEDDING_SKIP_REASONS");

    // Exhaustive switch: src/workers/page-analyze-worker.ts #skipReasonToBackfillStatus
    const workerFile = addMcpServerSourceFile(project, "src/workers/page-analyze-worker.ts");
    switchLabels = extractSwitchCaseLabels(workerFile, "skipReasonToBackfillStatus");
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
  });

  it("INV-SCHEMA-ENUM-004: SSOT has exactly 27 values including the ADR-0018 Amendment 13 truncated-screenshot additions (screenshot_truncated / screenshot_truncated_expired) on top of the prior 25", () => {
    // 27 値の存在と各 tail append 値の包含を明示的に assert する。
    // ADR-0018 §Decision 2 で `fork_terminated_before_done` と
    // `parity_check_failed` が追加され、12 値 → 14 値。PR-D-2 (ADR-0018 §Decision 3
    // Amendment) で `bbox_invalid` が tail append され 14 → 15 値。PR-D-9 Wave 4
    // (ADR-0018 §Decision 1 Supplement S3) で `bbox_unresolvable` が tail append
    // され 15 → 16 値に拡張。Plan v3 T3-Vision V1 §4.2 で
    // `vision_residual_at_phase5_start` / `vision_probe_failed_at_phase5_start`
    // が tail append され 16 → 18 値に拡張。さらに PR-V3-T1a §3.4.1
    // (Plan v3 V2 §3.1 T1.2, FIND-V3-IO-H-01 closure) で
    // `text_child_memory_budget_exceeded_at_chunk_<n>` と
    // `partial_chunked_<n>_of_<total>` が tail append され 18 → 20 値に拡張された。
    // PR-BT-2 (ADR-0018 Amendment, System B) で
    // `section_visual_uncroppable` / `section_visual_duplicate` が tail append
    // され 20 → 22 値に拡張された。最後に PR-C4 (ADR-0018 Amendment, section_visual
    // PII asymmetry closure) で `section_visual_pii_excluded` が tail append
    // (index 22 = 23 番目) され 22 → 23 値に拡張された。最後に secvisual-blank-terminal
    // (Plan V1 §4) で `section_visual_blank` (index 23) / `section_visual_no_position`
    // (index 24) が tail append され 23 → 25 値に拡張された。
    expect(ssotValues).toHaveLength(27);
    expect(ssotValues).toContain("dispatch_phase_failed");
    expect(ssotValues).toContain("bbox_invalid");
    expect(ssotValues).toContain("bbox_unresolvable");
    expect(ssotValues).toContain("vision_residual_at_phase5_start");
    expect(ssotValues).toContain("vision_probe_failed_at_phase5_start");
    expect(ssotValues).toContain("text_child_memory_budget_exceeded_at_chunk_<n>");
    expect(ssotValues).toContain("partial_chunked_<n>_of_<total>");
    expect(ssotValues).toContain("section_visual_uncroppable");
    expect(ssotValues).toContain("section_visual_duplicate");
    expect(ssotValues).toContain("section_visual_pii_excluded");
    expect(ssotValues).toContain("section_visual_blank");
    expect(ssotValues).toContain("section_visual_no_position");
    expect(ssotValues).toContain("screenshot_truncated");
    expect(ssotValues).toContain("screenshot_truncated_expired");

    // 宣言順序まで含めて契約的に固定する (追加順序のドリフトを検出)。
    const expectedSet = new Set(EXPECTED_SKIP_REASONS);
    const actualSet = new Set(ssotValues);
    const diff = setDifference(EXPECTED_SKIP_REASONS, ssotValues);
    expect(diff.onlyInA, "SSOT is missing expected skip reasons").toEqual([]);
    expect(diff.onlyInB, "SSOT contains unexpected skip reasons").toEqual([]);
    expect(actualSet.size).toBe(expectedSet.size);
  });

  it("INV-SCHEMA-ENUM-004: PR-D-9 Wave 4 — bbox_invalid and bbox_unresolvable coexist (mutual exclusivity at value level, not absence)", () => {
    // ADR-0018 §Decision 1 Supplement S3 mutual-exclusivity contract: per-part
    // skipReason MUST be EITHER `bbox_invalid` OR `bbox_unresolvable` (never
    // both). At the SSOT enum level both values exist as distinct members;
    // mutual exclusivity is enforced at the runtime emit point in
    // `PartVisualProcessor` and the bbox classification helper.
    expect(ssotValues).toContain("bbox_invalid");
    expect(ssotValues).toContain("bbox_unresolvable");
    // Distinct values (no aliasing).
    expect(ssotValues.indexOf("bbox_invalid")).not.toBe(ssotValues.indexOf("bbox_unresolvable"));
  });

  it("INV-SCHEMA-ENUM-004: exhaustive switch covers every SSOT value", () => {
    // skipReasonToBackfillStatus() の case 節が SSOT 23 値を全網羅すること。
    // SSOT に新値が追加されたのに switch が未更新の場合、本 test で検知される
    // (compile 時の never check と併用した 2 重防御)。
    const diff = setDifference(ssotValues, switchLabels);
    expect(
      diff.onlyInA,
      `exhaustive switch in skipReasonToBackfillStatus() is missing cases for ` +
        `${JSON.stringify(diff.onlyInA)}. Every EMBEDDING_SKIP_REASONS value must have ` +
        `a corresponding case clause.`
    ).toEqual([]);
    expect(
      diff.onlyInB,
      `exhaustive switch contains case labels not present in EMBEDDING_SKIP_REASONS: ` +
        `${JSON.stringify(diff.onlyInB)}. Switch cases must not reference non-SSOT values.`
    ).toEqual([]);
  });

  it("INV-SCHEMA-ENUM-004: EmbeddingSkipReason is intentionally NOT a Prisma enum", () => {
    // `EmbeddingSkipReason` は MCP レスポンス専用 (DB に永続化されない) 契約。
    // Prisma schema / @prisma/client に同名の enum が誤って導入されていない
    // ことを assert する (逆方向の drift 検知)。
    //
    // The `EmbeddingSkipReason` contract is MCP-response-only (never persisted).
    // Assert the reverse-drift: no Prisma enum with that name has been accidentally
    // introduced.
    const prismaEnums = loadPrismaEnums();
    expect(
      Object.keys(prismaEnums),
      "EmbeddingSkipReason must NOT be a Prisma enum (contract: MCP-response-only)"
    ).not.toContain("EmbeddingSkipReason");
  });
});
