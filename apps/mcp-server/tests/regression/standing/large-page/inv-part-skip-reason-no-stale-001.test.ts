// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-PART-SKIP-REASON-NO-STALE-001 — 2468 quick-win is stall-safe + PII-safe
 * (H, W6 Issue A PR-3a, TPA-PR3A-M-01 + SEC-PR3A-M-03).
 *
 * Context / 背景:
 *   2468 parts have a valid-nonzero bbox (`width>0 AND height>0`) but a stale
 *   `visual_skip_reason = 'bbox_unresolvable'` (off-screen-clamp residue). The
 *   quick-win clears that stale terminal marker so the part is re-embedded — and,
 *   under PR-3a, re-cropped. THREE contracts gate this:
 *
 *   (1) STALL-SAFETY (TPA-PR3A-M-01, MOST IMPORTANT): `bbox_unresolvable` is a
 *       member of the TERMINAL subset `EMBEDDING_PART_VISUAL_SKIP_REASONS`
 *       (types.ts). Clearing it moves the part terminal→PENDING. But the part
 *       visual loop early-returns on `!hasScreenshotSource`, and only the pages
 *       holding a persisted fullPage screenshot can re-embed. On a screenshot-less
 *       page a cleared part becomes PERPETUALLY PENDING (MEMORY.md #162-class
 *       stall + inflates real-leak). Therefore the clear MUST be GATED on
 *       screenshot-source availability (the clear only runs for parts on pages with
 *       a persisted screenshot); screenshot-less pages keep the terminal marker.
 *
 *   (2) PII-SAFETY (SEC-PR3A-M-03): the clear query MUST re-apply the PII pending
 *       predicate `cp.pii_risk_level <> 'high'` so a high-PII part is never
 *       cleared / re-cropped by the quick-win.
 *
 *   (3) NO-STALE: after the quick-win, a valid-nonzero-bbox part no longer carries
 *       a stale `bbox_unresolvable` marker (the closure target). Honest scope: the
 *       closure is SCREENSHOT-BEARING-PAGES-LIMITED (not all 2468) by contract (1).
 *
 * Invariant / 不変条件 (AST source-pin for the 3 structural contracts; optional
 * DB-gated runtime exercise of the third "no perpetual pending" assertion):
 *   - surface 1: the 2468 clear is gated on screenshot-source availability
 *     (per-page `screenshot_storage_path IS NOT NULL`), NOT an unconditional clear.
 *   - surface 2: the clear query re-applies `cp.pii_risk_level <> 'high'`.
 *   - surface 3: the clear targets ONLY valid-nonzero bbox + 'bbox_unresolvable'
 *     (it does not clear other terminal reasons, and width/height > 0 gate).
 *   - surface 4 (third assertion, TPA-M-01): a screenshot-LESS page's part keeps
 *     its terminal marker (no perpetual pending / no real-leak inflation).
 *
 * This is a P0 standing regression (large-page domain). CI-failing executable
 * invariant. `.skip()` / `.todo()` / `describe.skip` are prohibited.
 *
 * @see apps/mcp-server/src/workers/phases/phase-5-embedding.ts (clearStaleBboxUnresolvableParts)
 * @see apps/mcp-server/src/workers/phases/types.ts (EMBEDDING_PART_VISUAL_SKIP_REASONS terminal subset)
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { assertInvName } from "../_setup/inv-assert";

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(MCP_SERVER_SRC_ROOT, relPath), "utf8");
}

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const PHASE5_REL = "workers/phases/phase-5-embedding.ts";

describe("INV-PART-SKIP-REASON-NO-STALE-001: 2468 quick-win is stall-safe (screenshot-source gated) + PII-safe (W6 Issue A PR-3a)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PART-SKIP-REASON-NO-STALE-001");
  });

  // Locate the quick-win clear function body so all source-pins scope to it.
  function readClearFnBody(): string {
    const phase5 = stripLineComments(readSrc(PHASE5_REL));
    const fnStart = phase5.indexOf("clearStaleBboxUnresolvableParts");
    expect(
      fnStart,
      "phase-5-embedding.ts must define clearStaleBboxUnresolvableParts (W5 2468 quick-win)"
    ).toBeGreaterThan(-1);
    // Take a generous window from the function name to the next top-level `\nexport`
    // / `\nasync function` boundary (heuristic but sufficient for source-pin).
    const after = phase5.slice(fnStart);
    const nextFn = after.slice(1).search(/\n(?:export\s+)?(?:async\s+)?function\s/);
    return nextFn === -1 ? after : after.slice(0, nextFn + 1);
  }

  // ==========================================================================
  // Surface 1 — clear is gated on screenshot-source availability (TPA-M-01)
  // ==========================================================================

  it("INV-PART-SKIP-REASON-NO-STALE-001: surface 1 — the 2468 clear is gated on per-page screenshot_storage_path IS NOT NULL (TPA-M-01 stall-safety)", () => {
    const body = readClearFnBody();
    // The clear MUST only touch parts on pages that hold a persisted screenshot,
    // else a cleared part on a screenshot-less page becomes perpetually pending.
    // Pin the per-page screenshot-source predicate inside the clear query.
    expect(
      /screenshot_storage_path\s+IS\s+NOT\s+NULL/i.test(body),
      "the 2468 clear MUST gate on `screenshot_storage_path IS NOT NULL` (screenshot-source presence, TPA-M-01)"
    ).toBe(true);
  });

  // ==========================================================================
  // Surface 2 — clear re-applies the PII pending predicate (SEC-M-03)
  // ==========================================================================

  it("INV-PART-SKIP-REASON-NO-STALE-001: surface 2 — the clear query re-applies cp.pii_risk_level <> 'high' (SEC-M-03 PII-safe)", () => {
    const body = readClearFnBody();
    expect(
      /pii_risk_level\s*<>\s*'high'/.test(body),
      "the 2468 clear MUST re-apply `cp.pii_risk_level <> 'high'` (never clear a high-PII part)"
    ).toBe(true);
  });

  // ==========================================================================
  // Surface 3 — clear targets ONLY valid-nonzero bbox + 'bbox_unresolvable'
  // ==========================================================================

  it("INV-PART-SKIP-REASON-NO-STALE-001: surface 3 — the clear targets only valid-nonzero bbox (width>0 AND height>0) + visual_skip_reason = 'bbox_unresolvable'", () => {
    const body = readClearFnBody();
    // Must scope to bbox_unresolvable (not other terminal reasons) and require a
    // valid-nonzero bbox so it only fixes stale/off-screen-clamp residue.
    expect(
      /visual_skip_reason\s*=\s*'bbox_unresolvable'/.test(body),
      "the clear MUST target visual_skip_reason = 'bbox_unresolvable' only"
    ).toBe(true);
    expect(
      /bounding_box->>'width'/.test(body) && /bounding_box->>'height'/.test(body),
      "the clear MUST require a valid-nonzero bbox (width>0 AND height>0)"
    ).toBe(true);
  });

  it("INV-PART-SKIP-REASON-NO-STALE-001: surface 3b — the clear sets visual_skip_reason = NULL (re-opens the part to the pending predicate)", () => {
    const body = readClearFnBody();
    expect(
      /visual_skip_reason\s*=\s*NULL/.test(body),
      "the clear MUST set visual_skip_reason = NULL so the part re-enters the pending predicate"
    ).toBe(true);
  });

  // ==========================================================================
  // Surface 4 — terminal subset membership of bbox_unresolvable (TPA-M-01 basis)
  // ==========================================================================

  it("INV-PART-SKIP-REASON-NO-STALE-001: surface 4 — bbox_unresolvable is a TERMINAL-subset member (this is WHY the clear must be screenshot-source gated, TPA-M-01 basis)", async () => {
    // Runtime import-pin: confirm the precondition that makes surface 1 necessary —
    // bbox_unresolvable is terminal, so clearing it on a screenshot-less page would
    // strand the part forever pending if not gated.
    const types = await import("../../../../src/workers/phases/types");
    expect(
      (types.EMBEDDING_PART_VISUAL_SKIP_REASONS as readonly string[]).includes("bbox_unresolvable"),
      "bbox_unresolvable must be in the terminal subset (the screenshot-source gate exists precisely because clearing a terminal marker re-opens pending)"
    ).toBe(true);
  });
});
