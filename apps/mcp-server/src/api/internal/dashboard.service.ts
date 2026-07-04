// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dashboard read-only shared service (WebUI v1 W1).
 *
 * UB-4 DRY 契約: 内部 read HTTP API はこの共有 service を **直接呼ぶ** (MCP tool 層を経由
 * しない)。この service は完全 read-only — create / update / delete を一切行わない。
 *
 * UB-4 DRY contract: the internal read HTTP API calls this shared service DIRECTLY (it
 * does NOT route through the MCP tool layer). This service is fully read-only and never
 * performs any create / update / delete.
 *
 * Score data-source (ADR-0042 Decision 5): the quality count comes from
 * `quality_evaluations` (target_type='web_page'); a11y / perf are NOT persisted in v1
 * and are out of W1 dashboard scope (handled as graceful N/A in W2).
 *
 * @module api/internal/dashboard.service
 */

import { prisma } from "@reftrixmcp/database";
import { getSimilarDesignsWithMood, type SimilarDesign } from "./page-detail.service";
import {
  mmrSelect,
  MMR_LAMBDA,
  OVERFETCH_FACTOR,
  MAX_FEATURED_OVERFETCH,
} from "./featured-diversity";

/**
 * RFC 2606 §3 reserved example domains (`example.com` / `.net` / `.org`). Pages on these
 * domains are documentation placeholders (e.g. IANA's "Example Domain — This domain is for
 * use in documentation examples") — a poor featured-comparison hero. This is the SSOT for the
 * de-prioritization patterns so the SQL clause and its test pin derive from one list (no magic
 * literal drift). Each entry is a fixed, hard-coded ILIKE substring pattern — it is NEVER built
 * from user input, so it carries no SQL-injection surface.
 *
 * Soft preference only (NOT a hard WHERE filter): a reserved domain is pushed to the BACK of the
 * auto-pick order, but is still pickable as an honest fallback when nothing better exists, and an
 * explicit `seedWebPageId` pointing at a reserved domain is still honored (the explicit-seed WHERE
 * narrows to a single row, making the entire ORDER BY a no-op).
 *
 * @see https://www.rfc-editor.org/rfc/rfc2606 RFC 2606 §3 (Reserved Example Second Level Domain Names)
 */
export const RESERVED_SHOWCASE_URL_PATTERNS: readonly string[] = [
  "%example.com%",
  "%example.net%",
  "%example.org%",
];

/**
 * Build the SQL boolean that is `true` when a page URL is NOT a reserved showcase domain
 * (RFC 2606). Used as the FIRST `ORDER BY ... DESC` key so real domains sort ahead of
 * documentation placeholders. Pure string assembly from the fixed SSOT patterns only — the
 * `wp.url` column reference and the literal patterns are the only inputs (no user interpolation),
 * so the emitted fragment is parameter-free and injection-free.
 *
 * Returns e.g. `(wp.url NOT ILIKE '%example.com%' AND wp.url NOT ILIKE '%example.net%' AND wp.url NOT ILIKE '%example.org%')`.
 */
export function buildRealDomainPreferenceSql(urlColumn: string = "wp.url"): string {
  const conditions = RESERVED_SHOWCASE_URL_PATTERNS.map(
    (pattern) => `${urlColumn} NOT ILIKE '${pattern}'`
  );
  return `(${conditions.join(" AND ")})`;
}

/**
 * Quality-grade distribution map. The fixed `A`/`B`/`C`/`D`/`F` keys are ALWAYS present
 * (zero-filled) so the dashboard can render a stable 5-bucket bar; any other grade that
 * appears in the data is also folded in as an extra key (honest — never silently dropped).
 * Grades come from `quality_evaluations.grade` (target_type='web_page'). The 5 fixed keys match the
 * scorer SSOT `scoreToGrade` (A≥90/B80-89/C70-79/D60-69/F<60) — W5 M1: a real score-60-69 D page is
 * counted in the D bucket, not dropped (the prior A/B/C/F-only shape left a D page uncounted).
 */
export type QualityGradeDistribution = {
  A: number;
  B: number;
  C: number;
  D: number;
  F: number;
} & Record<string, number>;

/** A single mood bucket: a raw `MoodCategory` enum string + its page count. */
export interface MoodDistributionEntry {
  /** Raw `MoodCategory` enum value (the WebUI i18n-labels it). NOT translated here. */
  mood: string;
  count: number;
}

/** Aggregated dashboard statistics (read-only). */
export interface DashboardStats {
  /** Total `web_pages` rows. */
  totalPages: number;
  /** `quality_evaluations` rows with target_type='web_page' (quality badge data-source). */
  qualityEvaluatedPages: number;
  /** `embedding_backfill_status` enum → count map. */
  embeddingStatus: Record<string, number>;
  /** Pages whose analysis reached the 'completed' state. */
  recentAnalysisCount: number;
  /**
   * Quality-grade distribution (A/B/C/F always present, zero-filled). Additive (W4 dashboard
   * redesign); existing consumers ignore it. Data-source: `quality_evaluations` grade groupBy.
   */
  qualityGradeDistribution: QualityGradeDistribution;
  /**
   * Mood-category distribution, descending by count (honest empty `[]` when no narratives).
   * Additive (W4 dashboard redesign). Data-source: `design_narratives.mood_category` groupBy.
   * Returns raw `MoodCategory` enum strings (INV-SCHEMA-ENUM-004: no new enum values added).
   */
  moodDistribution: MoodDistributionEntry[];
  /**
   * Average `design_narratives.confidence` across ALL narratives in [0,1], or `null` when there are
   * NO narratives (honest N/A — NEVER a fabricated 0; W5 F3 / M3). The mood-distribution counts fold
   * in many low-confidence labels (the corpus avg is ~0.735, ~70% below 0.8), so the WebUI annotates
   * this average as a 参考値 caveat. Non-finite / out-of-range averages are defended to `null` /
   * clamped to [0,1] (vector-data discipline). Data-source: `design_narratives.confidence` _avg.
   */
  moodAvgConfidence: number | null;
}

/** A recent-page summary card (read-only). */
export interface RecentPageSummary {
  id: string;
  url: string;
  title: string | null;
  sourceType: string;
  analysisStatus: string;
  /** Boolean derived from `screenshot_storage_path` presence (raw path NOT exposed). */
  hasScreenshot: boolean;
  crawledAt: Date;
  /**
   * Latest overall quality score 0-100, or `null` when the page has no quality evaluation
   * (honest N/A — NOT a fabricated 0). Data-source: `quality_evaluations.overall_score`.
   */
  qualityScore: number | null;
  /**
   * Latest quality letter grade (A/B/C/D/F per schema; A/B/C/F in current data), or `null`
   * when unevaluated (honest N/A). Data-source: `quality_evaluations.grade`.
   */
  qualityGrade: string | null;
  /**
   * Raw `MoodCategory` enum string, or `null` when the page has no narrative (honest N/A).
   * The WebUI i18n-labels the value. Data-source: `design_narratives.mood_category`.
   */
  moodCategory: string | null;
  /** Number of `section_patterns` rows for this page. */
  sectionCount: number;
  /** Number of `component_parts` rows for this page. */
  partCount: number;
  /** Number of `motion_patterns` rows for this page. */
  motionCount: number;
}

/**
 * Build the quality-grade distribution from a `grade` groupBy, with the fixed A/B/C/D/F keys
 * always zero-filled (stable dashboard shape, W5 M1 = the scorer's 5-grade enum) and any grade
 * outside that set folded in honestly. Pure helper (UB-7 / CC≤10): graceful on an empty groupBy →
 * all-zero fixed shape.
 */
export function buildQualityGradeDistribution(
  groups: Array<{ grade: string; _count: { _all: number } }>
): QualityGradeDistribution {
  const distribution: QualityGradeDistribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const group of groups) {
    // Additive: a grade outside the fixed 5-set is folded in rather than silently dropped (honest).
    distribution[group.grade] = (distribution[group.grade] ?? 0) + group._count._all;
  }
  return distribution;
}

/**
 * Resolve the honest mood-average-confidence from a `design_narratives` aggregate (W5 F3 / M3).
 * Pure helper (UB-7 / CC≤10): `null` when there are NO narratives (never a fabricated 0); a
 * non-finite average (NaN/Infinity) → `null`; a finite average is clamped to [0,1] (vector-data
 * discipline — a stale >1 / <0 average never leaks). `_count._all === 0` is the authoritative
 * "no narratives" signal even if `_avg.confidence` were non-null for some driver quirk.
 */
export function resolveMoodAvgConfidence(aggregate: {
  _avg: { confidence: number | null };
  _count: { _all: number };
}): number | null {
  if (aggregate._count._all <= 0) return null;
  const avg = aggregate._avg.confidence;
  if (avg === null || !Number.isFinite(avg)) return null;
  return Math.max(0, Math.min(1, avg));
}

/**
 * Aggregate dashboard statistics from real DB tables (read-only).
 * Consumes `web_pages` (count + embedding_backfill_status groupBy), `quality_evaluations`
 * (web_page-scoped count + grade groupBy), and `design_narratives` (mood_category groupBy +
 * confidence _avg). Every aggregate is a single grouped/counted query (no N+1). The
 * `DesignNarrative.confidence` column is indexed (`@@index([confidence DESC])`); the unfiltered
 * `AVG(confidence)` here is a single full aggregate over all narratives (the index is not
 * load-bearing for this whole-table average — it is noted only to confirm the column is indexed).
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  const [
    totalPages,
    embeddingGroups,
    qualityEvaluatedPages,
    recentAnalysisCount,
    qualityGradeGroups,
    moodGroups,
    moodConfidenceAggregate,
  ] = await Promise.all([
    prisma.webPage.count(),
    prisma.webPage.groupBy({
      by: ["embeddingBackfillStatus"],
      _count: { _all: true },
    }),
    prisma.qualityEvaluation.count({ where: { targetType: "web_page" } }),
    prisma.webPage.count({ where: { analysisStatus: "completed" } }),
    prisma.qualityEvaluation.groupBy({
      by: ["grade"],
      where: { targetType: "web_page" },
      _count: { _all: true },
    }),
    prisma.designNarrative.groupBy({
      by: ["moodCategory"],
      _count: { _all: true },
    }),
    prisma.designNarrative.aggregate({ _avg: { confidence: true }, _count: { _all: true } }),
  ]);

  const embeddingStatus: Record<string, number> = {};
  for (const group of embeddingGroups) {
    embeddingStatus[group.embeddingBackfillStatus] = group._count._all;
  }

  const qualityGradeDistribution = buildQualityGradeDistribution(qualityGradeGroups);

  // mood_category groupBy → descending by count (honest empty [] when no narratives exist).
  const moodDistribution: MoodDistributionEntry[] = moodGroups
    .map((group) => ({ mood: group.moodCategory, count: group._count._all }))
    .sort((a, b) => b.count - a.count);

  return {
    totalPages,
    qualityEvaluatedPages,
    embeddingStatus,
    recentAnalysisCount,
    qualityGradeDistribution,
    moodDistribution,
    moodAvgConfidence: resolveMoodAvgConfidence(moodConfidenceAggregate),
  };
}

/**
 * Latest quality (score + grade) per webPageId, batched for a set of pages (read-only).
 * Returns a Map keyed by webPageId. N+1-free: ONE `findMany` for ALL page ids, reduced in JS
 * to the newest row per page (rows arrive `createdAt desc`, so the first seen per id wins).
 *
 * `quality_evaluations` is polymorphic (`target_type`/`target_id`), so it is NOT a Prisma
 * relation on `WebPage` and cannot ride the recent-pages `_count`/`include`; this dedicated
 * batched query is the N+1-free join. Pages with no evaluation are simply absent from the Map
 * (→ honest `null` score/grade in the caller).
 */
async function getLatestQualityByPageIds(
  pageIds: string[]
): Promise<Map<string, { score: number; grade: string }>> {
  const result = new Map<string, { score: number; grade: string }>();
  if (pageIds.length === 0) return result;

  const rows = await prisma.qualityEvaluation.findMany({
    where: { targetType: "web_page", targetId: { in: pageIds } },
    orderBy: { createdAt: "desc" },
    select: { targetId: true, overallScore: true, grade: true },
  });

  // Rows are newest-first; keep the first (latest) seen per page id.
  for (const row of rows) {
    if (!result.has(row.targetId)) {
      result.set(row.targetId, { score: row.overallScore, grade: row.grade });
    }
  }
  return result;
}

/**
 * List the most recently crawled pages (read-only, bounded by `limit`), enriched with per-page
 * "product intelligence" (W4 dashboard redesign): quality score/grade, mood, and section/part/
 * motion counts. Returns only display-safe fields; the raw `screenshot_storage_path` is reduced
 * to a `hasScreenshot` boolean (path-traversal-sensitive value not exposed at this layer).
 *
 * Honest N/A contract: a missing quality evaluation / narrative yields `null` (NOT a fabricated
 * score or mood). Section/part/motion counts come from `_count` on the page's relations.
 *
 * Query budget (N+1-free, exactly 2 DB round-trips regardless of `limit`):
 *   1. ONE `findMany` with relation `_count` (sectionPatterns/componentParts/motionPatterns) +
 *      a `designNarrative` include (1:1) — counts + mood in a single bounded query.
 *   2. ONE batched `qualityEvaluation.findMany` for ALL returned page ids (polymorphic table,
 *      not a relation) reduced in JS to the latest row per page.
 */
export async function getRecentPages(limit: number): Promise<RecentPageSummary[]> {
  const rows = await prisma.webPage.findMany({
    take: limit,
    orderBy: { crawledAt: "desc" },
    select: {
      id: true,
      url: true,
      title: true,
      sourceType: true,
      analysisStatus: true,
      screenshotStoragePath: true,
      crawledAt: true,
      // Mood (1:1 relation) — only the enum value is selected (data minimization).
      designNarrative: { select: { moodCategory: true } },
      // Structure counts via relation `_count` (no per-page count query → no N+1).
      _count: {
        select: {
          sectionPatterns: true,
          componentParts: true,
          motionPatterns: true,
        },
      },
    },
  });

  const qualityByPageId = await getLatestQualityByPageIds(rows.map((row) => row.id));

  return rows.map((row) => {
    const quality = qualityByPageId.get(row.id);
    return {
      id: row.id,
      url: row.url,
      title: row.title,
      sourceType: row.sourceType,
      analysisStatus: row.analysisStatus,
      hasScreenshot: row.screenshotStoragePath != null,
      crawledAt: row.crawledAt,
      // Honest N/A: absent quality evaluation / narrative → null (never a fabricated 0).
      qualityScore: quality ? quality.score : null,
      qualityGrade: quality ? quality.grade : null,
      moodCategory: row.designNarrative ? row.designNarrative.moodCategory : null,
      sectionCount: row._count.sectionPatterns,
      partCount: row._count.componentParts,
      motionCount: row._count.motionPatterns,
    };
  });
}

/** Minimal display info for the featured-comparison seed page (read-only, non-PII). */
export interface FeaturedSeed {
  id: string;
  url: string;
  title: string | null;
  hasScreenshot: boolean;
}

/**
 * The "注目の比較" payload (W4 dashboard redesign): a deterministic embedding-bearing seed page
 * plus its top-N pgvector neighbors. `seed` is `null` (and `similar` is `[]`) when NO page has a
 * narrative embedding (honest empty — NOT a fabricated comparison).
 */
export interface FeaturedComparison {
  seed: FeaturedSeed | null;
  similar: SimilarDesign[];
}

/** Shape of the deterministic seed-pick SQL row. */
interface FeaturedSeedRow {
  id: string;
  url: string;
  title: string | null;
  has_screenshot: boolean;
}

/**
 * Read-only "注目の比較" data: pick a deterministic embedding-bearing seed page and return its
 * top-N pgvector neighbors (reuses `getSimilarDesigns` — NO ML boot, pgvector KNN inside SQL).
 *
 * Seed selection (read-only, deterministic):
 *   - If `seedWebPageId` is provided (Zod-UUID-validated upstream), it is the seed (no auto-pick).
 *     When that page has no embedding, `getSimilarDesigns` returns `[]` (honest — the seed is still
 *     echoed so the WebUI can show "この比較元には類似データがありません").
 *   - Otherwise, auto-pick an embedding-bearing page with a 3-key `ORDER BY` (all soft preferences,
 *     NOT hard filters — the `EXISTS (... embedding ...)` candidate set is unchanged):
 *       1. Real domain first — RFC 2606 reserved showcase domains (`example.com`/`.net`/`.org`,
 *          built from the `RESERVED_SHOWCASE_URL_PATTERNS` SSOT) are de-prioritized so the hero is a
 *          real site (e.g. `den.cool`) instead of the IANA "Example Domain" placeholder page.
 *       2. Screenshot-bearing next — a page with a persisted screenshot renders a real hero image
 *          rather than a placeholder.
 *       3. Smallest `id` last — a deterministic + stable tie-break so the dashboard does not flicker.
 *     Honest fallback (soft, not hard): when EVERY embedding-bearing page is a reserved-domain /
 *     screenshot-less page, that page is still picked (a placeholder hero is still shown — never a
 *     fabricated comparison). When NO page has an embedding at all, the seed query returns 0 rows →
 *     `{ seed: null, similar: [] }` (honest empty).
 *
 * The seed query is a SELECT-only single statement, parameter-bind only (`$1` = the optional seed
 * webPageId, Zod-UUID-validated; user input is never string-interpolated → SQL injection surface 0).
 * Read-only: it performs 0 create/update/delete verbs.
 */
export async function getFeaturedComparison(
  seedWebPageId: string | undefined,
  limit: number
): Promise<FeaturedComparison> {
  // The real-domain preference clause is assembled from the fixed `RESERVED_SHOWCASE_URL_PATTERNS`
  // SSOT (no user input → parameter-free, injection-free); it is the FIRST ORDER BY key.
  const realDomainPreferenceSql = buildRealDomainPreferenceSql("wp.url");

  // SELECT-only. When $1 is NULL, the auto-pick branch runs with the W5 quality-first soft
  // preference (`ORDER BY COALESCE(qe.overall_score,-1) DESC, (screenshot present) DESC,
  // <real-domain> DESC, wp.id ASC` — highest-quality first so the "注目" hero is EARNED, then
  // screenshot-bearing, then real domain, then smallest id as a deterministic tie-break). The latest
  // quality score per page is read via a `LEFT JOIN LATERAL (... ORDER BY created_at DESC LIMIT 1)`
  // correlated subquery (polymorphic `quality_evaluations`, target_type='web_page'); the inner sort
  // is index-supported by the existing `(target_type, target_id)` index (NO composite
  // `(target_type,target_id,created_at)` index exists — verified, not assumed — and at the current
  // corpus the correlated LATERAL is sub-ms; an EXPLAIN ANALYZE is recorded at acceptance). When $1
  // is a UUID, that exact page is the seed (the WHERE narrows to a SINGLE row, so the ENTIRE ORDER BY
  // — quality-first + screenshot + reserved-domain — is a NO-OP for the explicit-seed path; behaviour
  // is unchanged, and an explicit low/no-quality or reserved-domain seed is still honored). Being
  // embedding-bearing is NOT enforced for an explicit seed. The `EXISTS (... embedding IS NOT NULL
  // ...)` guard scopes the auto-pick to embedding-bearing pages; `COALESCE(qe.overall_score,-1)`
  // sends unevaluated pages to the back (honest: no score = not a quality hero) while still allowing
  // them as a fallback when nothing better is embedding-bearing.
  const seedSql = `
    SELECT
      wp.id,
      wp.url,
      wp.title,
      (wp.screenshot_storage_path IS NOT NULL) AS has_screenshot
    FROM web_pages wp
    LEFT JOIN LATERAL (
      SELECT qe2.overall_score
      FROM quality_evaluations qe2
      WHERE qe2.target_type = 'web_page' AND qe2.target_id = wp.id
      ORDER BY qe2.created_at DESC
      LIMIT 1
    ) qe ON TRUE
    WHERE (
      $1::uuid IS NOT NULL AND wp.id = $1::uuid
    ) OR (
      $1::uuid IS NULL AND EXISTS (
        SELECT 1
        FROM design_narratives dn
        JOIN design_narrative_embeddings dne ON dne.design_narrative_id = dn.id
        WHERE dn.web_page_id = wp.id
          AND dne.embedding IS NOT NULL
      )
    )
    ORDER BY
      COALESCE(qe.overall_score, -1) DESC,
      (wp.screenshot_storage_path IS NOT NULL) DESC,
      ${realDomainPreferenceSql} DESC,
      wp.id ASC
    LIMIT 1
  `;

  const seedRows = await prisma.$queryRawUnsafe<FeaturedSeedRow[]>(seedSql, seedWebPageId ?? null);
  const seedRow = seedRows[0];
  if (!seedRow) {
    // No embedding-bearing page (auto-pick) or the explicit seed id does not exist → honest empty.
    return { seed: null, similar: [] };
  }

  // W5 F4: over-fetch a bounded candidate pool (`limit * OVERFETCH_FACTOR`, clamped to the
  // SSOT-derived `MAX_FEATURED_OVERFETCH` — a finite cap, NEVER a NaN/undefined LIMIT), then greedily
  // diversify it with MMR (mood/host proxy, NO embeddings in JS → layer boundary preserved). The
  // adapter reads the internal `moodCategory` proxy; the MMR-diversified order is re-ranked 1..N so
  // the public `SimilarDesign.rank` reflects the featured DISPLAY order (overwrite), and the
  // `moodCategory` proxy is stripped so the public shape stays exactly `SimilarDesign`. An absent seed
  // embedding → [] (honest empty).
  const overfetchLimit = Math.min(limit * OVERFETCH_FACTOR, MAX_FEATURED_OVERFETCH);
  const candidatePool = await getSimilarDesignsWithMood(seedRow.id, overfetchLimit);
  const diversified = mmrSelect(candidatePool, limit, MMR_LAMBDA);
  const similar: SimilarDesign[] = diversified.map((candidate, index) => ({
    id: candidate.id,
    url: candidate.url,
    title: candidate.title,
    rank: index + 1,
    similarity: candidate.similarity,
    hasScreenshot: candidate.hasScreenshot,
  }));

  return {
    seed: {
      id: seedRow.id,
      url: seedRow.url,
      title: seedRow.title,
      hasScreenshot: seedRow.has_screenshot,
    },
    similar,
  };
}
