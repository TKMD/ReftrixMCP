// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * pick-known-keys unit tests — v0.4.0 PR-D-5 (FIND-TPA-PLAN-05 M).
 *
 * Verifies `pickKnownKeys` whitelist filter + `detectCategoryDrift` Set-equality
 * diagnostic. These helpers protect the audit_logs primary-emit payload from
 * unknown category keys (schema-strict downstream consumer contract).
 *
 * @module tests/utils/pick-known-keys
 */

import { describe, it, expect } from "vitest";
import { pickKnownKeys, detectCategoryDrift } from "../../src/utils/pick-known-keys";
import { EMBEDDING_BACKFILL_CATEGORIES } from "../../src/queues/embedding-backfill-queue";

describe("pickKnownKeys — SSOT whitelist filter", () => {
  it("filters out keys not in whitelist", () => {
    const map = { part_text: 1, part_visual: 2, unknown_cat: 9, rogue: 7 };
    const result = pickKnownKeys(map, EMBEDDING_BACKFILL_CATEGORIES);
    expect(result).toEqual({ part_text: 1, part_visual: 2 });
    expect(Object.keys(result)).not.toContain("unknown_cat");
    expect(Object.keys(result)).not.toContain("rogue");
  });

  it("preserves numeric values exactly (no zero-fill)", () => {
    const map = { part_text: 0, part_visual: 5 };
    const result = pickKnownKeys(map, EMBEDDING_BACKFILL_CATEGORIES);
    expect(result.part_text).toBe(0);
    expect(result.part_visual).toBe(5);
    // Missing allowed keys are ABSENT from result (not zero-filled).
    expect("motion" in result).toBe(false);
  });

  it("returns empty object when map has no whitelist-matching keys", () => {
    const map = { totally_unknown: 42, another_rogue: 1 };
    const result = pickKnownKeys(map, EMBEDDING_BACKFILL_CATEGORIES);
    expect(result).toEqual({});
  });

  it("does not mutate the input map", () => {
    const map = { part_text: 1, unknown_cat: 9 };
    const snapshot = { ...map };
    pickKnownKeys(map, EMBEDDING_BACKFILL_CATEGORIES);
    expect(map).toEqual(snapshot);
  });
});

describe("detectCategoryDrift — Set-equality diagnostic", () => {
  it("returns null when keys are Set-equal to whitelist", () => {
    const map = Object.fromEntries(EMBEDDING_BACKFILL_CATEGORIES.map((c) => [c, 0]));
    const result = detectCategoryDrift(map, EMBEDDING_BACKFILL_CATEGORIES);
    expect(result).toBeNull();
  });

  it("detects missing keys (collect-time regression)", () => {
    const map = {
      part_text: 0,
      part_visual: 0,
      section_visual: 0,
      motion: 0,
      background: 0,
      js_animation: 0,
      // responsive is missing
    };
    const result = detectCategoryDrift(map, EMBEDDING_BACKFILL_CATEGORIES);
    expect(result).not.toBeNull();
    expect(result!.missing).toContain("responsive");
    expect(result!.unexpected).toEqual([]);
  });

  it("detects unexpected keys (unknown category emitted)", () => {
    const map = Object.fromEntries(EMBEDDING_BACKFILL_CATEGORIES.map((c) => [c, 0]));
    map.unexpected_unknown = 3;
    const result = detectCategoryDrift(map, EMBEDDING_BACKFILL_CATEGORIES);
    expect(result).not.toBeNull();
    expect(result!.missing).toEqual([]);
    expect(result!.unexpected).toContain("unexpected_unknown");
  });

  it("detects both missing and unexpected simultaneously", () => {
    // Remove responsive, add rogue.
    const map = {
      part_text: 0,
      part_visual: 0,
      section_visual: 0,
      motion: 0,
      background: 0,
      js_animation: 0,
      rogue_key: 2,
    };
    const result = detectCategoryDrift(map, EMBEDDING_BACKFILL_CATEGORIES);
    expect(result).not.toBeNull();
    expect(result!.missing).toContain("responsive");
    expect(result!.unexpected).toContain("rogue_key");
  });
});
