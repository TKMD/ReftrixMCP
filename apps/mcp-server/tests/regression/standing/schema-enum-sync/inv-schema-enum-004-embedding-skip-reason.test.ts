// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SCHEMA-ENUM-004 (ADR-0018 + PR-V3-T1a enum expansion)
 *
 * ADR-0018 §Decision 2 / §Decision 3 Amendment / §Decision 1 Supplement S3 +
 * PR-V3-T1a §3.4.1 + PR-BT-2 + PR-C4 + secvisual-blank-terminal + ADR-0018
 * Amendment 13 で `EMBEDDING_SKIP_REASONS` が 12 → ... → 25 値 (本 PR 後 27 値)
 * に拡張されたことを verify する (TDA-RE2-L-01 co-landing: executable
 * `toHaveLength(27)` が T1、本 JSDoc は説明文ゆえ executable に追従)。本 test は
 * 既存 `inv-schema-enum-004.test.ts` を置き換えるものではなく、各 PR で追加された
 * 値の semantic を明示する追加 guard。
 *
 * 保証する 4 点 / What this file guarantees:
 *   1. ADR-0018 4 値 (`fork_terminated_before_done` / `parity_check_failed` /
 *      `bbox_invalid` / `bbox_unresolvable`)、PR-V3-T1a 2 値
 *      (`text_child_memory_budget_exceeded_at_chunk_<n>` /
 *      `partial_chunked_<n>_of_<total>`)、Plan v3 T3-Vision 2 値、PR-BT-2 2 値
 *      (`section_visual_uncroppable` / `section_visual_duplicate`)、PR-C4 1 値
 *      (`section_visual_pii_excluded`)、secvisual-blank-terminal 2 値、ADR-0018
 *      Amendment 13 2 値 (`screenshot_truncated` / `screenshot_truncated_expired`)
 *      が named 値として TS SSOT `EMBEDDING_SKIP_REASONS` に存在すること (27 値)
 *   2. それぞれが `skipReasonToBackfillStatus()` の exhaustive switch で
 *      明示的な case 節として存在すること
 *   3. 新値が配列末尾 (index 12 〜 22) に append されており、
 *      既存 12 値の順序が保持されていること
 *   4. index-based assertion により既存値の前/中間への誤挿入を即座に検出する
 *
 * Guards the ADR-0018 + PR-V3-T1a + PR-BT-2 + PR-C4 + secvisual-blank-terminal +
 * ADR-0018 Amendment 13 expansion of `EMBEDDING_SKIP_REASONS` to 25 (then 27)
 * values (executable `toHaveLength(27)` is T1; this JSDoc is descriptive and
 * follows the executable assertion). Complements (does NOT replace)
 * `inv-schema-enum-004.test.ts`.
 *
 * @see ADR-0018 §Decision 2 (fork_terminated_before_done, parity_check_failed)
 * @see ADR-0018 §Decision 3 Amendment (bbox_invalid — PR-D-2)
 * @see ADR-0018 §Decision 1 Supplement S3 (bbox_unresolvable — PR-D-9 Wave 4)
 * @see PR-V3-T1a §3.4.1 (text_child_memory_budget_exceeded_at_chunk_<n>,
 *      partial_chunked_<n>_of_<total>)
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

/**
 * PR-V3-T1a §3.4.1 で追加される 2 値 (Plan v3 V2 §3.1 T1.2,
 * FIND-V3-IO-H-01 closure target)。順序は SSOT の末尾 append 順に一致する
 * 必要がある (index 16 → 17)。`<n>` / `<total>` slot は runtime interpolation
 * 用 placeholder で SSOT の bare canonical form。
 *
 * Two values added by PR-V3-T1a §3.4.1. Order must match the tail-append
 * order of SSOT (index 16 → 17). The `<n>` / `<total>` slots are runtime
 * interpolation placeholders; the SSOT entry is the bare canonical form.
 */
const PR_V3_T1A_ADDITIONS = [
  "text_child_memory_budget_exceeded_at_chunk_<n>",
  "partial_chunked_<n>_of_<total>",
] as const;

/**
 * Plan v3 T3-Vision V1 §4.2 (INV-VISION-PHASE5-GATE-001) で追加される 2 値。
 * 順序は SSOT の末尾 append 順に一致する必要がある (index 16 → 17)。
 *
 * Two values added by Plan v3 T3-Vision V1 §4.2 (Phase 5 fork() pre-spawn gate).
 * Order must match the tail-append order of SSOT (index 16 → 17).
 */
const PLAN_V3_T3_VISION_ADDITIONS = [
  "vision_residual_at_phase5_start",
  "vision_probe_failed_at_phase5_start",
] as const;

/**
 * PR-BT-2 (ADR-0018 Amendment, System B) で追加される 2 値。順序は SSOT の末尾
 * append 順に一致する必要がある (index 20 → 21)。section_visual terminal-skip
 * マーカー (`section_embeddings.vision_skip_reason`) として記録される。
 *
 * Two values added by PR-BT-2 (ADR-0018 Amendment, System B). Order must match
 * the tail-append order of SSOT (index 20 → 21).
 */
const SECTION_VISUAL_ADDITIONS = [
  "section_visual_uncroppable",
  "section_visual_duplicate",
  // PR-C4 (ADR-0018 Amendment PR-C4, System B): the work-side PII-exclusion
  // terminal marker (GDPR Art.30 trail). 22 → 23 values, new tail index 22.
  "section_visual_pii_excluded",
] as const;

/**
 * secvisual-blank-terminal (Plan V1 §4, IO Plan Decision V1 `019e7f1c-0b66`) で
 * 追加される 2 値。順序は SSOT の末尾 append 順に一致する必要がある
 * (index 23 → 24)。section_visual の degraded-coverage technical terminal マーカー
 * (NON-PII; `section_visual_pii_excluded` とは意味が異なる、FIND-PLAN-L-07)。
 *
 * Two values added by secvisual-blank-terminal (Plan V1 §4). Order must match the
 * tail-append order of SSOT (index 23 → 24). Degraded-coverage technical terminal
 * markers (NON-PII; distinct in meaning from `section_visual_pii_excluded`).
 */
const SECVISUAL_BLANK_ADDITIONS = ["section_visual_blank", "section_visual_no_position"] as const;

/**
 * ADR-0018 Amendment 13 (visual-backfill truncated-screenshot data-loss fix) で
 * 追加される 2 値。順序は SSOT の末尾 append 順に一致する必要がある
 * (index 25 → 26)。`screenshot_truncated` = non-terminal bounded-retryable、
 * `screenshot_truncated_expired` = terminal。いずれも NON-PII degraded-coverage
 * technical metadata (GDPR Art.4(1) 非該当)。
 *
 * Two values added by ADR-0018 Amendment 13. Order must match the tail-append
 * order of SSOT (index 25 → 26). `screenshot_truncated` = non-terminal
 * bounded-retryable; `screenshot_truncated_expired` = terminal. Both NON-PII.
 */
const SCREENSHOT_TRUNCATED_ADDITIONS = [
  "screenshot_truncated",
  "screenshot_truncated_expired",
] as const;

const ALL_ENUM_ADDITIONS = [
  ...ADR_0018_ADDITIONS,
  ...PLAN_V3_T3_VISION_ADDITIONS,
  ...PR_V3_T1A_ADDITIONS,
  ...SECTION_VISUAL_ADDITIONS,
  ...SECVISUAL_BLANK_ADDITIONS,
  ...SCREENSHOT_TRUNCATED_ADDITIONS,
] as const;

describe("INV-SCHEMA-ENUM-004: ADR-0018 + Plan v3 T3-Vision V1 + PR-V3-T1a + PR-BT-2 + PR-C4 + secvisual-blank-terminal + Amendment 13 truncated enum expansion (27 values)", () => {
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

  it("INV-SCHEMA-ENUM-004: SSOT contains ADR-0018 + Plan v3 T3-Vision V1 + PR-V3-T1a + PR-BT-2 + PR-C4 + secvisual-blank-terminal + Amendment 13 additions (27 values total)", () => {
    expect(ssotValues).toHaveLength(27);
    for (const value of ALL_ENUM_ADDITIONS) {
      expect(ssotValues, `Enum addition \`${value}\` is missing from SSOT`).toContain(value);
    }
  });

  it("INV-SCHEMA-ENUM-004: ADR-0018 + PR-V3-T1a + PR-BT-2 + PR-C4 + secvisual-blank-terminal additions appear in exhaustive switch", () => {
    // Switch の case 節に全 13 値 (ADR-0018 4 + Plan v3 T3-Vision 2 + PR-V3-T1a 2
    // + PR-BT-2 2 + PR-C4 1 + secvisual-blank-terminal 2) が含まれていることを
    // verify (AST level)。runtime mapping は別 unit test で補完する。
    // ADR-0018 4 値 + Plan v3 T3-Vision 2 値 → skipped_fork_error。
    // PR-V3-T1a `text_child_memory_budget_exceeded_at_chunk_<n>` →
    //   skipped_memory_pressure (per-chunk RSS overshoot is a memory-pressure
    //   signal, NOT a fork/IPC failure).
    // PR-V3-T1a `partial_chunked_<n>_of_<total>` → skipped_fork_error。
    // PR-BT-2 `section_visual_uncroppable` / `section_visual_duplicate` →
    //   not_required (terminal-skip = page completable; MUST NOT be the
    //   skipped_fork_error retry bucket, IO Plan Decision V2 BT-V2-CORR-01).
    // PR-C4 `section_visual_pii_excluded` → not_required (work-side PII-exclusion
    //   terminal marker; same not_required arm as the other section_visual reasons,
    //   PR-C4 V1.1 §3 Path B).
    // secvisual-blank-terminal `section_visual_blank` / `section_visual_no_position`
    //   → not_required (degraded-coverage technical terminal; same not_required arm
    //   as the other section_visual reasons, Plan V1 §4 / FIND-PLAN-M-03 explicit
    //   case arms).
    //
    // AST-level verification that all new values appear as case labels.
    for (const value of ALL_ENUM_ADDITIONS) {
      expect(
        switchLabels,
        `Exhaustive switch in skipReasonToBackfillStatus() is missing case for ` + `\`${value}\`.`
      ).toContain(value);
    }
  });

  it("INV-SCHEMA-ENUM-004: 12 existing values remain in declaration order", () => {
    // Ordering guard: ADR-0018 + PR-V3-T1a additions must be appended to tail.
    // Existing 12 values must occupy the first 12 positions (indices 0..11);
    // each addition lives at position >= 12; relative order in
    // ALL_ENUM_ADDITIONS matches its tail order in SSOT.
    const existingTwelveCount = ssotValues.length - ALL_ENUM_ADDITIONS.length;
    expect(existingTwelveCount).toBe(12);

    // Index-based assertion (R2 中間挿入 drift 検出強化 / strengthened
    // mid-insert drift detection):
    // 新値が index 12-22 (0-based) に存在することを明示的に assert することで、
    // 既存 12 値の前/中間に誤って新値が挿入された場合に即座に fail させる。
    // PR-V3-T1a で 6 値化、PR-BT-2 で 8 値化、PR-C4 で 9 値化、
    // secvisual-blank-terminal で 11 値化したため、各 index を固定値 assertion する。
    //
    // Explicit index assertion: each tail addition is at the expected
    // 0-based index. Any accidental insertion before or between existing
    // values fails fast.
    expect(ssotValues.indexOf("fork_terminated_before_done")).toBe(12);
    expect(ssotValues.indexOf("parity_check_failed")).toBe(13);
    expect(ssotValues.indexOf("bbox_invalid")).toBe(14);
    expect(ssotValues.indexOf("bbox_unresolvable")).toBe(15);
    expect(ssotValues.indexOf("vision_residual_at_phase5_start")).toBe(16);
    expect(ssotValues.indexOf("vision_probe_failed_at_phase5_start")).toBe(17);
    expect(ssotValues.indexOf("text_child_memory_budget_exceeded_at_chunk_<n>")).toBe(18);
    expect(ssotValues.indexOf("partial_chunked_<n>_of_<total>")).toBe(19);
    // PR-BT-2 (ADR-0018 Amendment, System B) tail additions at index 20 / 21.
    expect(ssotValues.indexOf("section_visual_uncroppable")).toBe(20);
    expect(ssotValues.indexOf("section_visual_duplicate")).toBe(21);
    // PR-C4 (ADR-0018 Amendment PR-C4, System B) tail addition at index 22.
    expect(ssotValues.indexOf("section_visual_pii_excluded")).toBe(22);
    // secvisual-blank-terminal (Plan V1 §4) tail additions at index 23 / 24.
    expect(ssotValues.indexOf("section_visual_blank")).toBe(23);
    expect(ssotValues.indexOf("section_visual_no_position")).toBe(24);
    // ADR-0018 Amendment 13 (truncated-screenshot data-loss fix) tail additions
    // at index 25 / 26.
    expect(ssotValues.indexOf("screenshot_truncated")).toBe(25);
    expect(ssotValues.indexOf("screenshot_truncated_expired")).toBe(26);

    // Additional: existing 12 values' indices remain stable (spot-check).
    // 既存 12 値の index が変動していないことを確認 (drift detection).
    expect(ssotValues.indexOf("v8_heap_headroom_low")).toBe(0);
    expect(ssotValues.indexOf("system_memavailable_low")).toBe(1);
    expect(ssotValues.indexOf("dispatch_phase_failed")).toBe(11);
  });

  it("INV-SCHEMA-ENUM-004: PR-V3-T1a additions retain bare canonical form (no runtime <n> interpolation in SSOT)", () => {
    // Design §3.4.1: SSOT entry is the bare canonical form
    // (`text_child_memory_budget_exceeded_at_chunk_<n>` /
    // `partial_chunked_<n>_of_<total>`); runtime emission interpolates
    // `<n>` / `<total>` into details, NOT into the SSOT enum value.
    expect(ssotValues).toContain("text_child_memory_budget_exceeded_at_chunk_<n>");
    expect(ssotValues).toContain("partial_chunked_<n>_of_<total>");
    // Negative: no chunk-index-substituted variant lives in SSOT.
    expect(ssotValues).not.toContain("text_child_memory_budget_exceeded_at_chunk_3");
    expect(ssotValues).not.toContain("partial_chunked_5_of_7");
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
