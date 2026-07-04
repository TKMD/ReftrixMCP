// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Featured-diversity (greedy MMR) unit tests (WebUI v1 W5 F4 — ADR-0042 Amendment 10).
 *
 * Pins:
 * - `INV-WEBUI-FEATURED-DIVERSITY-001` (M5 + M7 + L9): greedy MMR (λ) re-orders the candidate
 *   pool so the featured neighbor list is not a mono-mood relevance-only list. The fixture is
 *   ENGINEERED (L9) so the top-N-by-relevance is mono-mood while the pool carries other moods,
 *   so a λ=0.7 selection MUST reorder vs a λ=1.0 (relevance-only) selection — otherwise the
 *   mutation is vacuous. The over-fetch pool cap is the SSOT-derived `MAX_FEATURED_OVERFETCH`
 *   (M7 — never a NaN/undefined reaching a LIMIT).
 *
 * The MMR is a PURE function over an adapter-internal `SimilarDesignWithMood` row shape (mood +
 * url for proxy diversity). NO embeddings are loaded into JS (layer boundary).
 */

import { describe, it, expect } from "vitest";
import {
  mmrSelect,
  pickNextDiversified,
  MMR_LAMBDA,
  OVERFETCH_FACTOR,
  MAX_FEATURED_OVERFETCH,
  type SimilarDesignWithMood,
} from "../../../src/api/internal/featured-diversity";
import { MAX_SIMILAR_LIMIT } from "../../../src/api/internal/schemas";

/** Build an adapter-internal candidate row (rank/similarity/mood/host all settable). */
function cand(
  id: string,
  similarity: number,
  moodCategory: string | null,
  url: string
): SimilarDesignWithMood {
  return {
    id,
    url,
    title: id,
    rank: 0, // re-assigned downstream on the diversified order
    similarity,
    hasScreenshot: false,
    moodCategory,
  };
}

describe("featured-diversity constants (M7 SSOT-derived, no NaN)", () => {
  it("MAX_FEATURED_OVERFETCH = MAX_SIMILAR_LIMIT * OVERFETCH_FACTOR (=36), a finite cap", () => {
    // M7 mutation target: a nonexistent `MAX_SIMILAR_LIMIT_HARD` would make this NaN/undefined.
    expect(MAX_FEATURED_OVERFETCH).toBe(MAX_SIMILAR_LIMIT * OVERFETCH_FACTOR);
    expect(MAX_FEATURED_OVERFETCH).toBe(36);
    expect(Number.isFinite(MAX_FEATURED_OVERFETCH)).toBe(true);
    expect(OVERFETCH_FACTOR).toBe(3);
    expect(MMR_LAMBDA).toBe(0.7);
  });
});

describe("INV-WEBUI-FEATURED-DIVERSITY-001 — greedy MMR reorders a mono-mood top-N (L9)", () => {
  // L9-engineered pool: the 3 highest-relevance candidates are ALL "premium" (mono-mood top-N),
  // but the pool contains "tech" / "minimalist" lower-relevance candidates. A relevance-only
  // (λ=1.0) selection of the top 3 is [p1, p2, p3] (all premium). A diversified (λ=0.7) selection
  // MUST pull a non-premium candidate up, so the result is NOT all-premium → reorder is observable.
  const pool: SimilarDesignWithMood[] = [
    cand("p1", 0.98, "premium", "https://a.example"),
    cand("p2", 0.97, "premium", "https://b.example"),
    cand("p3", 0.96, "premium", "https://c.example"),
    cand("t1", 0.9, "tech", "https://d.example"),
    cand("m1", 0.85, "minimalist", "https://e.example"),
  ];

  it("λ=1.0 (relevance only) keeps the mono-mood top-N (all premium) — the baseline", () => {
    const selected = mmrSelect(pool, 3, 1.0);
    expect(selected.map((c) => c.id)).toEqual(["p1", "p2", "p3"]);
    expect(new Set(selected.map((c) => c.moodCategory))).toEqual(new Set(["premium"]));
  });

  it("λ=0.7 reorders: the selection is NOT all-premium (diversity pulled a non-premium up)", () => {
    const selected = mmrSelect(pool, 3, MMR_LAMBDA);
    // The greedy first pick is always the most relevant (p1) — relevance is never abandoned.
    expect(selected[0].id).toBe("p1");
    // Mutation target: λ=1.0 (diversity disabled) makes this all-premium → RED.
    const moods = new Set(selected.map((c) => c.moodCategory));
    expect(moods.size).toBeGreaterThan(1);
    expect(selected.map((c) => c.id)).not.toEqual(["p1", "p2", "p3"]);
  });

  it("greedy first pick is always the single most relevant candidate (relevance preserved)", () => {
    const selected = mmrSelect(pool, 1, MMR_LAMBDA);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("p1");
  });
});

describe("INV-WEBUI-FEATURED-DIVERSITY-001 — MMR fallbacks + bounds", () => {
  it("an all-same-mood, all-same-host pool falls back to relevance order (no spurious reorder)", () => {
    const mono: SimilarDesignWithMood[] = [
      cand("a", 0.9, "premium", "https://x.example"),
      cand("b", 0.8, "premium", "https://x.example"),
      cand("c", 0.7, "premium", "https://x.example"),
    ];
    const selected = mmrSelect(mono, 3, MMR_LAMBDA);
    // With zero diversity available, the order is pure relevance descending.
    expect(selected.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("limit larger than the pool returns the whole pool (no out-of-range pick)", () => {
    const pool: SimilarDesignWithMood[] = [
      cand("a", 0.9, "premium", "https://x.example"),
      cand("b", 0.8, "tech", "https://y.example"),
    ];
    const selected = mmrSelect(pool, 12, MMR_LAMBDA);
    expect(selected).toHaveLength(2);
    expect(selected.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("empty pool → empty selection (honest, no crash)", () => {
    expect(mmrSelect([], 6, MMR_LAMBDA)).toEqual([]);
  });

  it("null mood does not crash diversity scoring (graceful)", () => {
    const pool: SimilarDesignWithMood[] = [
      cand("a", 0.9, null, "https://x.example"),
      cand("b", 0.8, null, "https://y.example"),
    ];
    const selected = mmrSelect(pool, 2, MMR_LAMBDA);
    expect(selected).toHaveLength(2);
    expect(selected[0].id).toBe("a");
  });
});

describe("pickNextDiversified (extracted helper, CC decomposition M5)", () => {
  it("picks the highest MMR-scored candidate given the already-selected set", () => {
    const remaining: SimilarDesignWithMood[] = [
      cand("p2", 0.97, "premium", "https://b.example"),
      cand("t1", 0.9, "tech", "https://d.example"),
    ];
    const selected: SimilarDesignWithMood[] = [cand("p1", 0.98, "premium", "https://a.example")];
    // With p1 (premium) selected, λ=0.7 favours the diverse "tech" candidate over the 2nd premium.
    const next = pickNextDiversified(remaining, selected, MMR_LAMBDA);
    expect(next.id).toBe("t1");
  });

  it("with λ=1.0 (no diversity) picks the most relevant remaining candidate", () => {
    const remaining: SimilarDesignWithMood[] = [
      cand("p2", 0.97, "premium", "https://b.example"),
      cand("t1", 0.9, "tech", "https://d.example"),
    ];
    const selected: SimilarDesignWithMood[] = [cand("p1", 0.98, "premium", "https://a.example")];
    const next = pickNextDiversified(remaining, selected, 1.0);
    expect(next.id).toBe("p2");
  });
});
