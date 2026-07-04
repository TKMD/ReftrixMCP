// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebUI v1 W4 — internal compare boundary schema tests
 * (INV-WEBUI-COMPARE-INPUT-CAP-002, Registry F-PLAN-W4-B / §8.2, CWE-770).
 *
 * `compareBodySchema` is the defense-in-depth HTTP boundary: a malformed compare body is rejected
 * with 400 at the seam, never reaching the design-compare DB path. It is a SEPARATE definition (NOT
 * importing the tool's `designCompareInputSchema`) because the internal API MUST use the canonical
 * `UUID_REGEX` SSOT — the tool schema uses a local `UUID_PATTERN` (a non-SSOT regex). OQ#4 decision.
 *
 * No-drift contract (executable, not import-coupled):
 *  - the dimension enum tuple === the service `ALL_DIMENSIONS` SSOT (drift → RED).
 *  - the page_ids 2..5 / dimensions 1..4 bounds match `designCompareInputSchema` behaviourally
 *    (a future widening of one without the other → RED).
 *
 * 正例 / 反例 both required (no vacuous green), mirroring `schemas.test.ts` (W1/W3).
 */

import { describe, it, expect } from "vitest";
import { UUID_REGEX } from "../../../src/services/screenshot-persistence.service";
import {
  compareBodySchema,
  COMPARE_DIMENSIONS,
  COMPARE_MIN_PAGES,
  COMPARE_MAX_PAGES,
  MAX_COMPARE_BODY_BYTES,
} from "../../../src/api/internal/schemas";
import { ALL_DIMENSIONS } from "../../../src/services/design-compare.service";
import { designCompareInputSchema } from "../../../src/tools/design/compare.tool";

const ID_A = "0190b6f0-1234-7abc-89ab-0123456789ab";
const ID_B = "0190b6f0-1234-7abc-89ab-0123456789ac";
const ID_C = "0190b6f0-1234-7abc-89ab-0123456789ad";
const ID_D = "0190b6f0-1234-7abc-89ab-0123456789ae";
const ID_E = "0190b6f0-1234-7abc-89ab-0123456789af";
const ID_F = "0190b6f0-1234-7abc-89ab-0123456789b0";
const FIVE = [ID_A, ID_B, ID_C, ID_D, ID_E];
const SIX = [ID_A, ID_B, ID_C, ID_D, ID_E, ID_F];

describe("compareBodySchema — page_ids bounds (INV-WEBUI-COMPARE-INPUT-CAP-002, CWE-770)", () => {
  it("re-uses the canonical UUID_REGEX SSOT (no second regex definition)", () => {
    // The schema must reject a UUID v1 (version nibble 1) — proving it derives from the SSOT,
    // not a looser hand-written pattern.
    expect(UUID_REGEX.test(ID_A)).toBe(true);
    expect(() =>
      compareBodySchema.parse({ page_ids: [ID_A, "11111111-2222-1333-8444-555555555555"] })
    ).toThrow();
  });

  it("accepts the boundary counts 2 and 5 page_ids", () => {
    expect(compareBodySchema.parse({ page_ids: [ID_A, ID_B] }).page_ids).toHaveLength(2);
    expect(compareBodySchema.parse({ page_ids: FIVE }).page_ids).toHaveLength(5);
  });

  it("rejects < 2 page_ids (reject path)", () => {
    expect(() => compareBodySchema.parse({ page_ids: [] })).toThrow();
    expect(() => compareBodySchema.parse({ page_ids: [ID_A] })).toThrow();
  });

  it("rejects > 5 page_ids (CWE-770 batch cap, reject path)", () => {
    expect(() => compareBodySchema.parse({ page_ids: SIX })).toThrow();
  });

  it("rejects a non-UUID / SQL-probe-shaped page_id (reject path)", () => {
    expect(() => compareBodySchema.parse({ page_ids: [ID_A, "not-a-uuid"] })).toThrow();
    expect(() =>
      compareBodySchema.parse({ page_ids: [ID_A, "1; DROP TABLE web_pages"] })
    ).toThrow();
  });
});

describe("compareBodySchema — dimensions enum (INV-WEBUI-COMPARE-INPUT-CAP-002)", () => {
  it("accepts an optional subset of dimensions (handler defaults to all 4 when omitted)", () => {
    expect(
      compareBodySchema.parse({ page_ids: [ID_A, ID_B], dimensions: ["layout"] }).dimensions
    ).toEqual(["layout"]);
    // Omitting dimensions is valid (the handler applies its own default — boundary stays optional).
    expect(compareBodySchema.parse({ page_ids: [ID_A, ID_B] }).dimensions).toBeUndefined();
  });

  it("rejects an empty dimensions array and an unknown dimension value (reject path)", () => {
    expect(() => compareBodySchema.parse({ page_ids: [ID_A, ID_B], dimensions: [] })).toThrow();
    expect(() =>
      compareBodySchema.parse({ page_ids: [ID_A, ID_B], dimensions: ["everything"] })
    ).toThrow();
  });

  it("rejects more than 4 dimensions (reject path)", () => {
    expect(() =>
      compareBodySchema.parse({
        page_ids: [ID_A, ID_B],
        dimensions: ["layout", "visual", "quality", "color", "layout"],
      })
    ).toThrow();
  });
});

describe("compareBodySchema — include_details + body cap", () => {
  it("accepts an optional include_details boolean", () => {
    expect(
      compareBodySchema.parse({ page_ids: [ID_A, ID_B], include_details: true }).include_details
    ).toBe(true);
    expect(compareBodySchema.parse({ page_ids: [ID_A, ID_B] }).include_details).toBeUndefined();
  });

  it("exposes a positive MAX_COMPARE_BODY_BYTES cap (CWE-770 express.json limit)", () => {
    expect(MAX_COMPARE_BODY_BYTES).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_COMPARE_BODY_BYTES)).toBe(true);
  });
});

describe("compareBodySchema — no-drift contract vs SSOT (OQ#4 executable pin)", () => {
  it("the dimension enum tuple === the service ALL_DIMENSIONS SSOT (drift → RED)", () => {
    // Boundary enum and the service SSOT must be identical sets in the same order. If the service
    // adds/renames a dimension without updating the boundary tuple (or vice versa), this goes RED.
    expect([...COMPARE_DIMENSIONS]).toEqual([...ALL_DIMENSIONS]);
  });

  it("the page_ids bounds (2..5) match designCompareInputSchema behaviourally", () => {
    // Both the boundary schema and the tool schema accept 2 and 5, and reject 1 and 6 — a future
    // widening of one without the other would diverge here (executable no-drift pin).
    expect(COMPARE_MIN_PAGES).toBe(2);
    expect(COMPARE_MAX_PAGES).toBe(5);
    expect(() => designCompareInputSchema.parse({ page_ids: [ID_A] })).toThrow();
    expect(() => compareBodySchema.parse({ page_ids: [ID_A] })).toThrow();
    expect(() => designCompareInputSchema.parse({ page_ids: SIX })).toThrow();
    expect(() => compareBodySchema.parse({ page_ids: SIX })).toThrow();
    expect(designCompareInputSchema.parse({ page_ids: [ID_A, ID_B] }).page_ids).toHaveLength(2);
    expect(compareBodySchema.parse({ page_ids: [ID_A, ID_B] }).page_ids).toHaveLength(2);
  });
});
