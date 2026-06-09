// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * INV-SECTION-VISUAL-BLANK-TERMINAL-015 (secvisual blank/no-position terminal,
 * Plan V1 §4 / §5 / IO Plan Decision V1 anchor `019e7f1c-0b66` Registry V1):
 *
 *   Root cause (degraded-coverage permanent pending): two backfill-path
 *   `processSingleSectionVisualEmbedding` exits previously RETURNED without
 *   writing a terminal `vision_skip_reason` marker, leaving the section
 *   permanently pending (`text_embedding IS NOT NULL AND vision_embedding IS NULL
 *   AND vision_skip_reason IS NULL`) so the page never reached `completed`:
 *
 *     - **exit#1 (no-position)**: `!sectionPos || sectionPos.height < 10`. On the
 *       backfill path (`fallbackEnabled === false`) the section's
 *       `layoutInfo.position` geometry is absent/degenerate, so there is no crop
 *       region and the section is structurally un-embeddable = terminal. Marker:
 *       `section_visual_no_position`.
 *     - **exit#2 (blank)**: `cropResult.isBlank === true`. The section was
 *       captured (lazy-rendered) but is a uniform/blank image (no visual content
 *       to embed); on the backfill path the dynamic-fallback re-capture queue is
 *       not drained (`fallbackEnabled === false`), so the blank crop is terminal.
 *       Marker: `section_visual_blank`.
 *
 *   Both new reasons are **degraded-coverage technical terminals, NOT PII
 *   exclusions** (FIND-PLAN-L-07 / LCC-L-01): blank = rendered-but-empty,
 *   no_position = geometry-absent. Neither is GDPR Art.4(1) personal data and
 *   neither is a GDPR Art.5(1)(c) data-minimisation exclusion (that is the
 *   distinct `section_visual_pii_excluded` reason). They are skip reasons, not
 *   failure reasons (`skipReasonToBackfillStatus` ⇒ `not_required`, NOT
 *   `skipped_fork_error`), so the page can reach `completed`.
 *
 *   Contract:
 *     - **4-site lockstep 3 → 5** (additive): the 2 new reasons join the SSOT
 *       `EMBEDDING_SECTION_VISUAL_SKIP_REASONS` (derived via `.filter()` from
 *       `EMBEDDING_SKIP_REASONS`), the Prisma migration CHECK constraint, the
 *       Prisma schema field (value-agnostic), and the SSOT exclusion-predicate
 *       consumer set — pinned by INV-SCHEMA-ENUM-004.
 *     - **backfill-path only** (`fallbackEnabled === false`): the markers are
 *       written ONLY on the backfill path; the main path (Phase 5 proper,
 *       `fallbackEnabled === true`) writes NO marker (INV-007 Block D
 *       orthogonality / negative drift guard). exit#2's dynamic-fallback queue is
 *       still populated on the main path; exit#1's no-position skip writes nothing
 *       on the main path.
 *     - **terminal → completed**: a non-NULL `vision_skip_reason` excludes the
 *       section from the section_visual pending query (the SSOT predicate's
 *       `se.vision_skip_reason IS NULL` conjunct), so pending = 0 ⇒
 *       `verifyCategoryParity` completed-eligible.
 *     - **PII-symmetric (SEC-L-1)**: high-PII sections are filtered out of
 *       `sectionsNeedingVisual` BEFORE the per-section loop
 *       (`highPiiSectionIdSet`) and excluded by the predicate's Path A
 *       `NOT EXISTS`, so a high-PII blank section never reaches the new markers —
 *       its terminal exclusion is owned exclusively by `section_visual_pii_excluded`
 *       / Path A (no double-marking, no PII leak via the new reasons).
 *
 * # Test strategy (mirrors INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011's first
 *   describe block: 3 deterministic surfaces, NO testcontainer / Redis / DB).
 *
 *   The Path B runtime fault-injection block of INV-011 is intentionally NOT
 *   adopted here (Plan §5.1): the 2 new reasons emit NO `audit_logs` row (they are
 *   non-PII technical terminals with no GDPR Art.30 processing-trail obligation),
 *   so there is no runtime emit to prove — the deterministic surfaces fully cover
 *   the contract.
 *
 *     1. SSOT membership (surface 1): the 2 new reasons are members of
 *        `EMBEDDING_SECTION_VISUAL_SKIP_REASONS` (and thus of `EMBEDDING_SKIP_REASONS`,
 *        derived guard); the full terminal subset is now the 5-value set.
 *     2. AST/source-pin (surface 2): exit#1 + exit#2 write their respective
 *        marker under a `fallbackEnabled === false` guard; the main-path
 *        (`fallbackEnabled === true`) branch writes NEITHER marker
 *        (negative drift guard, `not.toMatch`).
 *     3. Algorithmic (surface 3): `skipReasonToBackfillStatus` ⇒ `not_required`
 *        for both reasons; a blank/no_position terminal row is excluded from the
 *        section_visual pending predicate (pending = 0) ⇒ `verifyCategoryParity`
 *        completed-eligible; a residual section_visual pending ⇒ NOT completed
 *        (red path). PII-symmetric red-leak: the new markers are NOT routed for
 *        high-PII sections (high-PII terminal-exclusion stays with
 *        `section_visual_pii_excluded` / Path A NOT EXISTS).
 *
 * CI-failing executable invariant. `.skip()` / `.todo()` / `describe.skip` are
 * FORBIDDEN. Failure is a P0 incident handled by pipeline-engineer +
 * capture-embedding-engineer.
 *
 * @see  §2.4 (5-exit table) / §4 / §5
 * @see  (INV-015, FIND-PLAN-L-07, SEC-L-1)
 * @see apps/mcp-server/src/workers/phases/types.ts (EMBEDDING_SECTION_VISUAL_SKIP_REASONS, sectionVisualPendingExclusionPredicate)
 * @see apps/mcp-server/src/workers/phases/phase-5-embedding.ts (exit#1 / exit#2 marker writes)
 * @see apps/mcp-server/src/workers/page-analyze-worker.ts (skipReasonToBackfillStatus exhaustive switch)
 * @see apps/mcp-server/tests/regression/standing/large-page/inv-section-visual-pii-excluded-terminal-011.test.ts (sibling canonical pattern, first describe)
 *
 * @module tests/regression/standing/large-page/inv-section-visual-blank-terminal-015
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  EMBEDDING_SECTION_VISUAL_SKIP_REASONS,
  EMBEDDING_SKIP_REASONS,
  sectionVisualPendingExclusionPredicate,
} from "../../../../src/workers/phases/types";
import { verifyCategoryParity } from "../../../../src/services/backfill-status.helper";
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  type EmbeddingBackfillCategory,
} from "../../../../src/queues/embedding-backfill-queue";

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");

/** The 2 new degraded-coverage terminal reasons landed by this PR (Plan V1 §4). */
const NEW_BLANK_TERMINAL_REASON = "section_visual_blank";
const NEW_NO_POSITION_TERMINAL_REASON = "section_visual_no_position";

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(MCP_SERVER_SRC_ROOT, relPath), "utf8");
}

/**
 * Strip single-line `//` comments BEFORE source-pin matching so that
 * doc-comment prose that mentions `fallbackEnabled === true` (e.g. "the main
 * path (`fallbackEnabled === true`) writes NO marker") does not shadow the
 * actual executable guard. Without this the negative drift guard would match the
 * comment text rather than the real `if (...)` code form.
 */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/** Build a 7-category snapshot; `pendingCategories` are left pending (>0). */
function buildSnapshot(
  pendingCategories: EmbeddingBackfillCategory[]
): Record<EmbeddingBackfillCategory, number> {
  const snap = {} as Record<EmbeddingBackfillCategory, number>;
  for (const c of EMBEDDING_BACKFILL_CATEGORIES) snap[c] = 0;
  for (const c of pendingCategories) snap[c] = 1;
  return snap;
}

describe("INV-SECTION-VISUAL-BLANK-TERMINAL-015: section_visual blank/no-position terminal (Plan V1 §4 / §5)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SECTION-VISUAL-BLANK-TERMINAL-015");
  });

  // ==========================================================================
  // Surface 1 — SSOT membership (4-site lockstep 3 → 5, derived not hardcoded)
  // ==========================================================================

  it("INV-SECTION-VISUAL-BLANK-TERMINAL-015: surface 1 — both new reasons are SSOT-derived terminal subset members (present in EMBEDDING_SKIP_REASONS too)", () => {
    // Each new reason must be a member of BOTH the derived terminal subset AND
    // the 25-value SSOT it is filtered from (drift guard: a hardcoded value not
    // present in EMBEDDING_SKIP_REASONS would be dropped by .filter()).
    expect(EMBEDDING_SECTION_VISUAL_SKIP_REASONS as readonly string[]).toContain(
      NEW_BLANK_TERMINAL_REASON
    );
    expect(EMBEDDING_SECTION_VISUAL_SKIP_REASONS as readonly string[]).toContain(
      NEW_NO_POSITION_TERMINAL_REASON
    );
    expect(EMBEDDING_SKIP_REASONS as readonly string[]).toContain(NEW_BLANK_TERMINAL_REASON);
    expect(EMBEDDING_SKIP_REASONS as readonly string[]).toContain(NEW_NO_POSITION_TERMINAL_REASON);
  });

  it("INV-SECTION-VISUAL-BLANK-TERMINAL-015: surface 1 — the SSOT-derived terminal subset is the 6-value set (ADR-0018 Amendment 13 additive 5 → 6)", () => {
    // The full terminal subset after ADR-0018 Amendment 13: the prior 5
    // (uncroppable, duplicate, pii_excluded, blank, no_position) + the new
    // `screenshot_truncated_expired` (terminal). `screenshot_truncated` is writable
    // but NON-terminal, so it is NOT in this subset. Sorted for determinism.
    expect([...EMBEDDING_SECTION_VISUAL_SKIP_REASONS].sort()).toEqual([
      "screenshot_truncated_expired",
      "section_visual_blank",
      "section_visual_duplicate",
      "section_visual_no_position",
      "section_visual_pii_excluded",
      "section_visual_uncroppable",
    ]);
    // Derived (never hardcoded): every value is a member of the SSOT.
    for (const reason of EMBEDDING_SECTION_VISUAL_SKIP_REASONS) {
      expect(EMBEDDING_SKIP_REASONS as readonly string[]).toContain(reason);
    }
  });

  // ==========================================================================
  // Surface 2 — AST/source-pin: exit#1 + exit#2 write the marker under the
  //   backfill-path guard; main path writes NEITHER (negative drift guard).
  // ==========================================================================

  it("INV-SECTION-VISUAL-BLANK-TERMINAL-015: surface 2 — exit#2 (isBlank) writes section_visual_blank on the backfill path", () => {
    const phase5 = readSrc("workers/phases/phase-5-embedding.ts");
    // The isBlank exit MUST write the section_visual_blank terminal marker (via
    // the writeSectionVisionSkipReason SSOT helper) so a blank section on the
    // backfill path is terminalized rather than left permanently pending.
    expect(
      phase5.includes(`writeSectionVisionSkipReason(p, "${NEW_BLANK_TERMINAL_REASON}")`),
      "phase-5-embedding.ts MUST write the section_visual_blank marker at the isBlank exit (degraded-coverage terminal)"
    ).toBe(true);
  });

  it("INV-SECTION-VISUAL-BLANK-TERMINAL-015: surface 2 — exit#1 (no-position) writes section_visual_no_position on the backfill path", () => {
    const phase5 = readSrc("workers/phases/phase-5-embedding.ts");
    expect(
      phase5.includes(`writeSectionVisionSkipReason(p, "${NEW_NO_POSITION_TERMINAL_REASON}")`),
      "phase-5-embedding.ts MUST write the section_visual_no_position marker at the no-position exit (degraded-coverage terminal)"
    ).toBe(true);
  });

  it("INV-SECTION-VISUAL-BLANK-TERMINAL-015: surface 2 — each new marker write is guarded by the backfill-path code form (if (p.fallbackEnabled === false) { writeSectionVisionSkipReason(...) })", () => {
    // Strip comments so doc-comment prose mentioning `fallbackEnabled === true`
    // does not shadow the executable guard.
    const phase5 = stripLineComments(readSrc("workers/phases/phase-5-embedding.ts"));
    // The marker writes must be conditioned on the backfill path via the exact
    // code form `if (p.fallbackEnabled === false) { await writeSectionVisionSkipReason(...) }`
    // (the same-shape precedent of exit#3 uncroppable / exit#4 duplicate). A write
    // not guarded by `=== false` would terminal-mark on the main path too,
    // corrupting Phase 5 proper (INV-007 Block D orthogonality).
    expect(
      /if\s*\(\s*p\.fallbackEnabled === false\s*\)\s*\{\s*await writeSectionVisionSkipReason\(p,\s*"section_visual_blank"\)/.test(
        phase5
      ),
      "section_visual_blank marker MUST be written under `if (p.fallbackEnabled === false) { ... }` (backfill-path guard)"
    ).toBe(true);
    expect(
      /if\s*\(\s*p\.fallbackEnabled === false\s*\)\s*\{\s*await writeSectionVisionSkipReason\(p,\s*"section_visual_no_position"\)/.test(
        phase5
      ),
      "section_visual_no_position marker MUST be written under `if (p.fallbackEnabled === false) { ... }` (backfill-path guard)"
    ).toBe(true);
  });

  it("INV-SECTION-VISUAL-BLANK-TERMINAL-015: surface 2 — main path (fallbackEnabled === true) writes NEITHER new marker (negative drift guard)", () => {
    // Strip comments first (the executable guards use `=== false`; only prose
    // mentions `=== true`). After stripping, there must be NO `=== true` code
    // guard paired with either new marker write (mirrors the INV-011 / INV-007
    // negative drift guard).
    const phase5 = stripLineComments(readSrc("workers/phases/phase-5-embedding.ts"));
    expect(phase5).not.toMatch(
      /fallbackEnabled === true[\s\S]{0,400}?writeSectionVisionSkipReason\(p,\s*"section_visual_blank"\)/
    );
    expect(phase5).not.toMatch(
      /fallbackEnabled === true[\s\S]{0,400}?writeSectionVisionSkipReason\(p,\s*"section_visual_no_position"\)/
    );
  });

  // ==========================================================================
  // Surface 3 — algorithmic: terminal mapping + pending exclusion + parity
  // ==========================================================================

  it("INV-SECTION-VISUAL-BLANK-TERMINAL-015: surface 3 — skipReasonToBackfillStatus maps both new reasons to not_required (page completable, NOT skipped_fork_error)", () => {
    const worker = readSrc("workers/page-analyze-worker.ts");
    // Explicit case arms must exist for both new reasons (a new EmbeddingSkipReason
    // silently falling through the never-narrowing default would be mis-mapped to
    // skipped_fork_error, re-creating the false-failed pin — FIND-PLAN-M-03).
    expect(
      worker.includes(`case "${NEW_BLANK_TERMINAL_REASON}":`),
      "skipReasonToBackfillStatus() MUST have an explicit case for section_visual_blank"
    ).toBe(true);
    expect(
      worker.includes(`case "${NEW_NO_POSITION_TERMINAL_REASON}":`),
      "skipReasonToBackfillStatus() MUST have an explicit case for section_visual_no_position"
    ).toBe(true);
    // Negative drift guard: neither may be routed into the skipped_fork_error
    // retry bucket (that would re-create the false-failed permanent pin).
    expect(worker).not.toMatch(
      /case\s+"section_visual_blank":[\s\S]{0,160}?return\s+"skipped_fork_error"/
    );
    expect(worker).not.toMatch(
      /case\s+"section_visual_no_position":[\s\S]{0,160}?return\s+"skipped_fork_error"/
    );
  });

  it("INV-SECTION-VISUAL-BLANK-TERMINAL-015: surface 3 — pending predicate still encodes vision_skip_reason IS NULL so a non-NULL marker excludes the section (pending = 0)", () => {
    const fragment = sectionVisualPendingExclusionPredicate("se");
    // A section terminal-marked with section_visual_blank / section_visual_no_position
    // (non-NULL vision_skip_reason) is excluded from pending by this conjunct, so
    // the page can reach completed. The base conjuncts must remain intact.
    expect(fragment).toContain("se.text_embedding IS NOT NULL");
    expect(fragment).toContain("se.vision_embedding IS NULL");
    expect(fragment).toContain("se.vision_skip_reason IS NULL");
  });

  it("INV-SECTION-VISUAL-BLANK-TERMINAL-015: surface 3 — green: blank/no_position terminal row excluded from pending (section_visual pending=0) ⇒ verifyCategoryParity completed-eligible", () => {
    // With the terminal marker set, the section_visual category drains to 0; if all
    // other categories are drained, parity ⇒ ok (completed-eligible).
    expect(verifyCategoryParity(buildSnapshot([])).ok).toBe(true);
  });

  it("INV-SECTION-VISUAL-BLANK-TERMINAL-015: surface 3 — red: a residual section_visual pending (PRE-fix, marker not written) ⇒ verifyCategoryParity NOT completed", () => {
    // PRE-fix: the blank/no_position section counted as section_visual pending=1
    // forever (no terminal marker) → parity NOT ok → page stuck in_progress. This
    // is the exact permanent-pending state the fix eliminates.
    const sectionVisualResidual = buildSnapshot(["section_visual"]);
    expect(verifyCategoryParity(sectionVisualResidual).ok).toBe(false);
  });

  it("INV-SECTION-VISUAL-BLANK-TERMINAL-015: surface 3 (SEC-L-1) — PII-symmetric: high-PII terminal exclusion stays with section_visual_pii_excluded / Path A, NOT the new markers", () => {
    // SEC-L-1: high-PII sections are filtered out of sectionsNeedingVisual BEFORE
    // the per-section loop (highPiiSectionIdSet) and excluded by the predicate's
    // Path A NOT EXISTS, so a high-PII (blank) section NEVER reaches the new
    // marker writes. Assert (a) the predicate carries the Path A high-PII NOT
    // EXISTS exclusion, and (b) the per-section loop pre-filters high-PII so the
    // new markers cannot double-mark a high-PII row.
    const fragment = sectionVisualPendingExclusionPredicate("se");
    expect(/NOT EXISTS/i.test(fragment)).toBe(true);
    expect(fragment).toContain("pii_risk_level");
    expect(fragment).toContain("'high'");

    const phase5 = readSrc("workers/phases/phase-5-embedding.ts");
    // The high-PII pre-filter applied before the per-section visual loop.
    expect(
      phase5.includes("highPiiSectionIdSet"),
      "phase-5-embedding.ts MUST pre-filter high-PII sections (highPiiSectionIdSet) so the new blank/no_position markers never reach a high-PII row (SEC-L-1)"
    ).toBe(true);
    // Defensive filter on the per-section loop input (high-PII excluded). The
    // arrow predicate `(s) => !highPiiSectionIdSet.has(...)` contains a `)` before
    // the `!`, so match across it with a bounded `[\s\S]`.
    expect(phase5).toMatch(/\.filter\([\s\S]{0,40}?!\s*highPiiSectionIdSet\.has/);
  });
});
