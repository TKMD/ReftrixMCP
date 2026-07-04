// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Featured-comparison neighbor diversification (WebUI v1 W5 F4 — ADR-0042 Amendment 10).
 *
 * Greedy Maximal Marginal Relevance (MMR) over the over-fetched pgvector neighbor pool, so the
 * "注目の比較" featured list is not a mono-mood relevance-only list (the F4 honest-rendering goal:
 * a diversified set of neighbors is a more meaningful "comparison" than the N nearest near-clones).
 *
 * Layer boundary (`INV-WEBUI-READONLY-NEGATIVE-001`): this module loads NO embeddings into JS and
 * imports NO ML / Prisma. The relevance term is the already-computed `similarity` (1 - cosine
 * distance) that `getSimilarDesigns` returns, and the diversity term is a PROXY over the
 * adapter-internal `mood_category` + URL host (a cheap, embedding-free spread signal). The actual
 * pairwise cosine between two neighbors is never recomputed (it would require their embeddings on
 * the JS heap, a layer-boundary violation), so the proxy is an honest approximation, not a claim of
 * exact pairwise distance.
 *
 * Complexity (UB-6 / `complexity:["error",10]` machine-enforced for `src/api/internal/**`): the
 * inner "pick the best diversified candidate" step is extracted into `pickNextDiversified` so the
 * outer `mmrSelect` greedy loop stays CC ≤ 10 (mirrors the url-normalizer `sortQueryParams` /
 * `normalizePathname` extraction precedent).
 *
 * @module api/internal/featured-diversity
 */

import { MAX_SIMILAR_LIMIT } from "./schemas";

/**
 * Over-fetch factor: the candidate pool size is `limit * OVERFETCH_FACTOR` so the greedy MMR has a
 * meaningful diversity surplus to pick from (without it, diversifying a pool of exactly `limit`
 * neighbors cannot spread anything). Fixed small constant (bounded; see `MAX_FEATURED_OVERFETCH`).
 */
export const OVERFETCH_FACTOR = 3;

/**
 * MMR relevance/diversity balance λ ∈ [0,1]. `score = λ * relevance - (1-λ) * maxProxySimToSelected`.
 * λ=0.7 keeps relevance dominant (the most relevant neighbor is always the greedy first pick) while
 * still letting diversity reorder the tail. λ=1.0 disables diversity (pure relevance order).
 */
export const MMR_LAMBDA = 0.7;

/**
 * Hard cap on the over-fetch candidate pool — CWE-770 unbounded-result prevention. Derived from the
 * `MAX_SIMILAR_LIMIT` SSOT (=12) × `OVERFETCH_FACTOR` (=3) = 36. The over-fetch limit passed to
 * `getSimilarDesigns` is `Math.min(limit * OVERFETCH_FACTOR, MAX_FEATURED_OVERFETCH)`, so a finite,
 * SSOT-derived value always reaches the SQL `LIMIT` (NEVER a `NaN`/`undefined` from a non-existent
 * `MAX_SIMILAR_LIMIT_HARD`).
 */
export const MAX_FEATURED_OVERFETCH = MAX_SIMILAR_LIMIT * OVERFETCH_FACTOR;

/**
 * Adapter-internal candidate row: the public `SimilarDesign` shape plus `moodCategory` (the diversity
 * proxy field). `moodCategory` is SELECTed by `getSimilarDesigns` but stripped before the public
 * response, so it stays adapter-internal (it never reaches the wire — `INV-WEBUI-SIMILAR-RANK-001`).
 */
export interface SimilarDesignWithMood {
  id: string;
  url: string;
  title: string | null;
  rank: number;
  similarity: number;
  hasScreenshot: boolean;
  /** Raw `MoodCategory` enum string, or null (the diversity proxy; never exposed publicly). */
  moodCategory: string | null;
}

/** Extract the registrable URL host (lowercased), or "" when the URL is unparseable (graceful). */
function urlHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Embedding-free proxy "similarity" between two candidates in [0,1]: 0.5 for a shared
 * `mood_category` + 0.5 for a shared URL host. Two candidates with the same mood AND host are the
 * most redundant (1.0); fully distinct mood+host pairs are maximally diverse (0.0). A null mood is
 * treated as non-matching (graceful — never a crash, never a fabricated match).
 */
function proxySimilarity(a: SimilarDesignWithMood, b: SimilarDesignWithMood): number {
  const sameMood = a.moodCategory !== null && a.moodCategory === b.moodCategory ? 0.5 : 0;
  const sameHost = urlHost(a.url) !== "" && urlHost(a.url) === urlHost(b.url) ? 0.5 : 0;
  return sameMood + sameHost;
}

/** Maximum proxy similarity of a candidate to any already-selected item (0 when none selected). */
function maxProxyToSelected(
  candidate: SimilarDesignWithMood,
  selected: SimilarDesignWithMood[]
): number {
  let max = 0;
  for (const sel of selected) {
    const sim = proxySimilarity(candidate, sel);
    if (sim > max) max = sim;
  }
  return max;
}

/**
 * Pick the next candidate from `remaining` that maximizes the MMR score against `selected`:
 * `score = λ * relevance - (1-λ) * maxProxySimToSelected`. Greedy single step (the extracted inner
 * loop, kept here so the outer `mmrSelect` stays CC ≤ 10). `remaining` is assumed non-empty (the
 * caller guards). Ties are broken by input order (stable — `remaining` arrives relevance-descending).
 */
export function pickNextDiversified(
  remaining: SimilarDesignWithMood[],
  selected: SimilarDesignWithMood[],
  lambda: number
): SimilarDesignWithMood {
  let best: SimilarDesignWithMood | null = null;
  let bestScore = -Infinity;
  for (const candidate of remaining) {
    const relevance = Number.isFinite(candidate.similarity) ? candidate.similarity : 0;
    const penalty = maxProxyToSelected(candidate, selected);
    const score = lambda * relevance - (1 - lambda) * penalty;
    if (best === null || score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best === null) {
    // The caller guards `remaining.length > 0`; this is unreachable defensively (never a silent
    // `undefined` reaching the MMR selection — fail loud instead of returning a fake candidate).
    throw new Error("pickNextDiversified: empty candidate list");
  }
  return best;
}

/**
 * Greedy MMR selection of up to `limit` candidates from `pool`, diversified by the embedding-free
 * mood/host proxy. The first pick is always the most relevant candidate (relevance is never
 * abandoned); each subsequent pick maximizes `λ * relevance - (1-λ) * maxProxySimToSelected`.
 *
 * Pure function (no I/O, CC ≤ 10): the inner candidate selection is delegated to
 * `pickNextDiversified`. Returns at most `min(limit, pool.length)` items. The caller re-assigns
 * `rank` 1..N on the returned (diversified) order.
 */
export function mmrSelect(
  pool: SimilarDesignWithMood[],
  limit: number,
  lambda: number
): SimilarDesignWithMood[] {
  const target = Math.min(Math.max(0, limit), pool.length);
  if (target === 0) return [];

  // Work on a relevance-descending copy so the greedy first pick is the most relevant candidate and
  // ties fall back to relevance order (stable). `getSimilarDesigns` already returns distance-ASC, but
  // sorting here keeps the helper self-contained and order-independent of the caller.
  const remaining = [...pool].sort((a, b) => b.similarity - a.similarity);
  const selected: SimilarDesignWithMood[] = [];

  while (selected.length < target && remaining.length > 0) {
    const next = pickNextDiversified(remaining, selected, lambda);
    selected.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return selected;
}
