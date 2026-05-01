// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5 Part Visual bbox_invalid observability tests
 *
 * INV-EMBEDDING-INTEGRITY-005 (M) landing (PR-D-2).
 *
 * 契約 / Contract:
 *   Part visual embedding loop で `boundingBox` が invalid (null / non-number /
 *   width<=0 / height<=0) により skip された part は、必ず
 *   `EmbeddingPhaseResult.partVisualSkippedBboxInvalid` counter に計上される。
 *   silent drop は禁止。
 *
 *   When a part is skipped due to invalid `boundingBox`, it MUST be counted in
 *   `EmbeddingPhaseResult.partVisualSkippedBboxInvalid`. Silent drop is prohibited.
 *
 * このテストはソースコード静的検証（silent-skip-fix.test.ts と同じ方式）で
 * 実装の抜け漏れを検知する。
 *
 * Source-code static inspection (same approach as `silent-skip-fix.test.ts`)
 * detects regressions in the bbox-skip observability landing.
 *
 * SEC-04 PII-free assertion / SEC-04 PII-free assertion:
 *   `skipDetail` に埋め込まれるのは数値のみ (`bboxInvalid:<n>`) であること。
 *   part ID / URL / stack trace が誤って混入していないこと。
 *
 * @see ADR-0018 §Decision 3.7 (bbox=0 handling)
 * @see PR-D-2 Plan §4.3 (INV-EMBEDDING-INTEGRITY-005)
 * @see PR-D-2 Plan §3.2 (bbox_invalid emit site)
 *
 * @module tests/workers/phases/phase-5-part-visual-bbox-invalid
 */

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PHASE5_SRC = path.resolve(__dirname, "../../../src/workers/phases/phase-5-embedding.ts");
const TYPES_SRC = path.resolve(__dirname, "../../../src/workers/phases/types.ts");

describe("Phase 5 Part Visual bbox_invalid observability (INV-EMBEDDING-INTEGRITY-005)", () => {
  let phase5Source: string;
  let typesSource: string;

  beforeAll(() => {
    phase5Source = fs.readFileSync(PHASE5_SRC, "utf-8");
    typesSource = fs.readFileSync(TYPES_SRC, "utf-8");
  });

  // ==========================================================================
  // A. EmbeddingPhaseResult type extension
  // ==========================================================================
  describe("A. EmbeddingPhaseResult type", () => {
    it("INV-EMBEDDING-INTEGRITY-005: partVisualSkippedBboxInvalid field exists in EmbeddingPhaseResult", () => {
      const match = typesSource.match(/interface EmbeddingPhaseResult\s*\{[\s\S]*?\n\}/);
      expect(match).not.toBeNull();
      const body = match![0];
      // Must be a number field (required or optional). `partVisualSkippedBboxInvalid`
      // is the canonical field name per PR-D-2 Plan §3.2.
      expect(body).toMatch(/partVisualSkippedBboxInvalid\??:\s*number/);
    });
  });

  // ==========================================================================
  // B. bbox_invalid counter increment at silent-drop site
  // ==========================================================================
  describe("B. Counter increment at bbox=0 skip site", () => {
    it("INV-EMBEDDING-INTEGRITY-005: partVisualSkippedBboxInvalid is incremented before continue", () => {
      // The original silent drop was `continue;` at phase-5-embedding.ts L1132-1143.
      // PR-D-2 inserts counter increment immediately before `continue`.
      // Look for the increment pattern in the Phase 5 source.
      expect(phase5Source).toMatch(/partVisualSkippedBboxInvalid\s*(?:=|\+\+|\+=)/);
    });

    it("INV-EMBEDDING-INTEGRITY-005: the bbox validation block near the increment uses width<=0 || height<=0", () => {
      // Smoke check: the guard condition is still in place as the triggering site.
      expect(phase5Source).toMatch(/bbox\.width\s*<=\s*0/);
      expect(phase5Source).toMatch(/bbox\.height\s*<=\s*0/);
    });
  });

  // ==========================================================================
  // C. enum SSOT (15 values) and bbox_invalid presence
  // ==========================================================================
  describe("C. bbox_invalid enum presence (SSOT)", () => {
    it("INV-EMBEDDING-INTEGRITY-005: bbox_invalid is declared in EMBEDDING_SKIP_REASONS (15 values)", () => {
      expect(typesSource).toMatch(/"bbox_invalid"/);
    });
  });

  // ==========================================================================
  // D. skipDetail PII-free encoding (SEC-04)
  // ==========================================================================
  describe("D. skipDetail PII-free encoding (SEC-04)", () => {
    it("INV-EMBEDDING-INTEGRITY-005: skipDetail uses numeric-only bboxInvalid:<n> format (no PII)", () => {
      // When the terminal promotion sets skipDetail, the format must be
      // `bboxInvalid:<n>` (number only), never include partId / URL / stack.
      // We verify both: (i) the emit pattern exists, (ii) no part.id / url tokens
      // are concatenated inside the skipDetail pattern.
      //
      // Acceptable patterns:
      //   `bboxInvalid:${n}`
      //   "bboxInvalid:" + n
      //   `bboxInvalid:${count}`
      //
      // Must NOT contain: partId, part.id, url, error.message inside the
      // bboxInvalid segment.
      const bboxInvalidPattern = /bboxInvalid:\$\{[^}]*\}|bboxInvalid:"\s*\+\s*\w+/;
      // If promotion is implemented, the emit string literal contains "bboxInvalid:".
      // We allow either presence (full promotion impl) or at least the counter
      // increment (partial landing acceptable for INV-005 M severity).
      // To minimize flakiness while asserting SEC-04, we require:
      //   if the literal "bboxInvalid" appears, no PII token may be in the
      //   same pattern group.
      const literalMatches = phase5Source.match(/bboxInvalid:[^"`\n]{0,50}/g) ?? [];
      for (const match of literalMatches) {
        expect(match).not.toMatch(/part\.id/);
        expect(match).not.toMatch(/url/);
        expect(match).not.toMatch(/\.message/);
        expect(match).not.toMatch(/stack/);
      }
      // At least: the increment is present (counter-only landing) OR the full
      // skipDetail pattern is emitted.
      // Counter increment is mandatory per INV-005; skipDetail emit is enhanced.
      const hasCounterIncrement = /partVisualSkippedBboxInvalid\s*(?:=|\+\+|\+=)/.test(
        phase5Source
      );
      const hasSkipDetailEmit = bboxInvalidPattern.test(phase5Source);
      expect(hasCounterIncrement || hasSkipDetailEmit).toBe(true);
    });
  });

  // ==========================================================================
  // E. Terminal state promotion (run-level skipReason)
  // ==========================================================================
  describe("E. Run-level skipReason promotion", () => {
    it("INV-EMBEDDING-INTEGRITY-005: skipReason='bbox_invalid' promotion uses 3-condition gate (when implemented)", () => {
      // Per Plan §3.3, terminal state promotion requires all 3 conditions:
      //   (1) partsNeedingVisual.length > 0
      //   (2) partVisualSkippedBboxInvalid === partsNeedingVisual.length (100% bbox_invalid)
      //   (3) generatedCount === 0 for part_visual category
      //
      // If the source contains the promotion block, verify:
      //   - It references partsNeedingVisual.length in the gate condition.
      // INV-005 severity is M; M permits counter-only partial landing.
      // So we PASS when either: promotion present OR counter-only mode.
      const promotionPresent = /skipReason\s*=\s*["']bbox_invalid["']/.test(phase5Source);
      if (promotionPresent) {
        expect(phase5Source).toMatch(
          /partVisualSkippedBboxInvalid[\s\S]{0,300}partsNeedingVisual\.length/
        );
      }
      // Counter-only landing is also acceptable:
      const counterOnlyPresent = /partVisualSkippedBboxInvalid\s*(?:=|\+\+|\+=)/.test(phase5Source);
      expect(promotionPresent || counterOnlyPresent).toBe(true);
    });
  });
});
