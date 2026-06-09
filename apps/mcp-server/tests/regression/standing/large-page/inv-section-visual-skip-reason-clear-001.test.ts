// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-SECTION-VISUAL-SKIP-REASON-CLEAR-001 — section_visual write clears a stale
 * `vision_skip_reason` (cosmetic metadata-cleanliness L, ADR-0018 Amendment 13
 * follow-up).
 *
 * Context / 背景:
 *   When the backfill section_visual path genuinely regenerates a section's
 *   `vision_embedding` (Playwright per-section re-capture → DINOv2), the success
 *   write previously set only `vision_embedding` and left any prior
 *   `vision_skip_reason` (e.g. `screenshot_truncated`) untouched. The result is a
 *   contradictory row:
 *       vision_embedding IS NOT NULL  AND  vision_skip_reason = 'screenshot_truncated'
 *   This is functionally harmless (search filters on `vision_embedding IS NOT NULL`
 *   only; the pending predicate `sectionVisualPendingExclusionPredicate` gates on
 *   `vision_embedding IS NULL`, so a written row is excluded regardless of the
 *   stale marker), hence an L-severity cosmetic metadata-cleanliness finding.
 *
 * Invariant / 不変条件:
 *   Both section_visual `vision_embedding` write sites in phase-5-embedding.ts —
 *   the standard path (in_range / fallback) AND the dynamic-fallback path — MUST
 *   clear `vision_skip_reason = NULL` in the SAME UPDATE statement that sets the
 *   non-NULL `vision_embedding`. Once visual is genuinely recovered, the prior
 *   skip marker is stale and MUST NOT persist (GDPR Art.5(1)(d) accuracy +
 *   metadata-cleanliness).
 *
 * Verification surfaces (AST source-pin, NO testcontainer / Redis / DB — same
 * deterministic style as the sibling INV-SECTION-VISUAL-BLANK-TERMINAL-015):
 *   - surface 1: the standard write UPDATE sets `vision_skip_reason = NULL`.
 *   - surface 2: the dynamic-fallback write UPDATE sets `vision_skip_reason = NULL`.
 *   - surface 3: no section_visual `vision_embedding` write UPDATE exists that sets
 *     `vision_embedding` WITHOUT also clearing `vision_skip_reason` (drift guard).
 *
 * This is a P0 standing regression (large-page domain). It is a CI-failing
 * executable invariant. `.skip()` / `.todo()` / `describe.skip` are prohibited.
 *
 * @see apps/mcp-server/src/workers/phases/phase-5-embedding.ts (the 2 write sites)
 * @see apps/mcp-server/tests/regression/standing/large-page/inv-section-visual-blank-terminal-015.test.ts (sibling canonical AST-pin pattern)
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(MCP_SERVER_SRC_ROOT, relPath), "utf8");
}

/** Strip single-line `//` comments before source-pin matching. */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

describe("INV-SECTION-VISUAL-SKIP-REASON-CLEAR-001: section_visual write clears stale vision_skip_reason (ADR-0018 Amendment 13 follow-up)", () => {
  beforeEach(() => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-SECTION-VISUAL-SKIP-REASON-CLEAR-001"
    );
  });

  // ==========================================================================
  // Surface 1 — standard section_visual write (in_range / fallback path)
  // ==========================================================================

  it("INV-SECTION-VISUAL-SKIP-REASON-CLEAR-001: surface 1 — the standard section_visual vision_embedding write UPDATE also sets vision_skip_reason = NULL", () => {
    const phase5 = stripLineComments(readSrc("workers/phases/phase-5-embedding.ts"));
    // The standard write (WHERE id = $2 ... single section.id) MUST clear the
    // stale skip marker in the SAME UPDATE that sets vision_embedding.
    // Match the multi-line UPDATE ... SET vision_embedding ... , vision_skip_reason = NULL form.
    const standardWritePattern =
      /UPDATE section_embeddings\s+SET vision_embedding = \$1::vector\(768\),\s*\n?\s*vision_skip_reason = NULL\s+WHERE id = \$2::uuid\b/;
    expect(
      standardWritePattern.test(phase5),
      "phase-5-embedding.ts standard section_visual write MUST set `vision_skip_reason = NULL` in the same UPDATE as `vision_embedding`"
    ).toBe(true);
  });

  // ==========================================================================
  // Surface 2 — dynamic-fallback section_visual write
  // ==========================================================================

  it("INV-SECTION-VISUAL-SKIP-REASON-CLEAR-001: surface 2 — the dynamic-fallback section_visual vision_embedding write UPDATE also sets vision_skip_reason = NULL", () => {
    const phase5 = stripLineComments(readSrc("workers/phases/phase-5-embedding.ts"));
    // The dynamic-fallback write uses matchingSection.sectionEmbeddingId. There
    // are two `UPDATE section_embeddings SET vision_embedding ...` write sites;
    // BOTH must clear the marker. Assert at least two occurrences of the
    // skip-reason-clearing write form exist (one per write site).
    const clearingWrites = phase5.match(
      /UPDATE section_embeddings\s+SET vision_embedding = \$1::vector\(768\),\s*\n?\s*vision_skip_reason = NULL\s+WHERE id = \$2::uuid\b/g
    );
    expect(
      (clearingWrites?.length ?? 0) >= 2,
      "BOTH section_visual vision_embedding write sites (standard + dynamic-fallback) MUST clear `vision_skip_reason = NULL`"
    ).toBe(true);
  });

  // ==========================================================================
  // Surface 3 — drift guard: no bare vision_embedding write without the clear
  // ==========================================================================

  it("INV-SECTION-VISUAL-SKIP-REASON-CLEAR-001: surface 3 — no section_visual vision_embedding write UPDATE sets vision_embedding WITHOUT clearing vision_skip_reason (drift guard)", () => {
    const phase5 = stripLineComments(readSrc("workers/phases/phase-5-embedding.ts"));
    // A `SET vision_embedding = $1::vector(768)` immediately followed by `WHERE`
    // (i.e. NO `, vision_skip_reason = NULL` between SET and WHERE) is the stale
    // form this PR eliminates. Allow only whitespace/newline between the vector
    // cast and WHERE — if that bare form exists, the drift guard fails.
    const bareWritePattern = /SET vision_embedding = \$1::vector\(768\)\s+WHERE id = \$2::uuid\b/;
    expect(
      bareWritePattern.test(phase5),
      "no section_visual write may set `vision_embedding` without also clearing `vision_skip_reason = NULL` (stale-marker drift guard)"
    ).toBe(false);
  });
});
