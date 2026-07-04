// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Page-detail read-only shared service (WebUI v1 W2 — ADR-0042 Amendment 1 §A1.1/§A1.3).
 *
 * UB-4 DRY 契約: 内部 read HTTP API はこの共有 service を **直接呼ぶ** (MCP tool 層を経由
 * しない)。この service は完全 read-only — create / update / delete を一切行わない
 * (`INV-WEBUI-READONLY-NEGATIVE-001`)。dashboard.service の肥大化を避けるため、page-detail
 * 系 4 method を専用ファイルに分離する。
 *
 * UB-4 DRY contract: the internal read HTTP API calls this shared service DIRECTLY (it does
 * NOT route through the MCP tool layer). This service is fully read-only and never performs
 * any create / update / delete (`INV-WEBUI-READONLY-NEGATIVE-001`). The 4 page-detail
 * methods live in their own file to avoid bloating dashboard.service.
 *
 * Security / privacy contract:
 * - `screenshotStoragePath` is reduced to a `hasScreenshot` boolean (raw path NOT exposed,
 *   ADR-0041 H-2 / ADR-0042 Decision 7).
 * - High-PII redaction (ADR-0042 Amendment 1 §A1.3 / UB-4): rows with
 *   `pii_risk_level === 'high'` strip `htmlSnippet` / `attributes` / `cssClasses` from the
 *   response (`pii_risk_level` marker is preserved). Section-linked redaction: a section
 *   containing a high-PII part also has its `htmlSnippet` nulled, so the single sanitized-HTML
 *   sink (W2's structure preview) can never carry high-PII markup
 *   (`INV-WEBUI-HIGHPII-NEVER-IN-RESPONSE-001`).
 *
 * @module api/internal/page-detail.service
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { prisma } from "@reftrixmcp/database";
import {
  createScreenshotPersistenceService,
  validateScreenshotPath,
} from "../../services/screenshot-persistence.service";
import { validateCropPath, type CropKind } from "../../services/part/crop-persistence.helper";

/** `pii_risk_level` value that triggers high-PII redaction at the API boundary. */
const HIGH_PII = "high";

/** Per-axis design-quality score map (0-100), extracted from `design_quality` JSONB. */
export type AxisScores = Record<string, number>;

/** Per-axis design-quality grade map (e.g. "A".."F"), extracted from `design_quality` JSONB. */
export type AxisGrades = Record<string, string>;

/** Page metadata + section/part counts + screenshot presence (read-only). */
export interface PageDetail {
  id: string;
  url: string;
  title: string | null;
  description: string | null;
  sourceType: string;
  analysisStatus: string;
  embeddingBackfillStatus: string;
  /** Boolean derived from `screenshot_storage_path` presence (raw path NOT exposed). */
  hasScreenshot: boolean;
  crawledAt: Date;
  sectionCount: number;
  partCount: number;
}

/** Quality evaluation for a page, or null when unevaluated (graceful). */
export interface PageQuality {
  overallScore: number;
  grade: string;
  axisScores: AxisScores;
  axisGrades: AxisGrades;
  /** Raw `design_quality.axisDetails` JSONB, passed through unmodified (display-only). */
  axisDetails: unknown;
  /**
   * Human-readable improvement suggestions (`quality_evaluations.recommendations`, already JP
   * with a `[severity]` prefix). Defaults to `[]` when the column is empty/null (graceful).
   */
  recommendations: string[];
}

/**
 * Human-meaningful design narrative for a page (W2 human-value rework), or null when the page
 * has no narrative (graceful "未分析" — NOT a 404). Machine-facing JSON columns
 * (`layoutStructure` / `visualHierarchy` / `spacingRhythm` / `sectionRelationships` /
 * `graphicElements` / `sourceUrl`) are intentionally NOT selected (data minimization,
 * GDPR Art.5(1)(c)).
 */
export interface PageNarrative {
  /** Raw `MoodCategory` enum value (the viewer i18n-labels it). */
  moodCategory: string;
  moodDescription: string | null;
  /** key:value comma string (the viewer parses + i18n-labels the keys). */
  colorImpression: string | null;
  typographyPersonality: string | null;
  motionEmotion: string | null;
  overallTone: string | null;
  /** Analysis confidence 0-1. */
  confidence: number | null;
  tags: string[];
  /** ISO-8601 timestamp string. */
  analyzedAt: string;
}

/**
 * A single similar-design result (W2 human-value rework, UB-1; W5 F2 adds `rank`). Minimal-info
 * contract: only id / url / title / rank / similarity / hasScreenshot are exposed (no html_snippet /
 * embedding / attributes / mood_category). `similarity` is `1 - cosine_distance`, clamped to [0,1]
 * with NaN/Infinity → 0.
 */
export interface SimilarDesign {
  id: string;
  url: string;
  title: string | null;
  /**
   * 1-origin position WITHIN THIS returned list (W5 F2 — ADR-0042 Amendment 10, path-relative dual
   * semantics). On the page-detail `/similar` path it is the **distance rank** (the returned rows
   * are distance-ASC and rank is assigned on the POST-filter array, so it is the honest
   * nearest-neighbor ordinal). On the dashboard **featured** path it is the **display rank** of the
   * MMR-diversified order (`getFeaturedComparison` overwrites it), so it is NOT a global nearest
   * ordinal there. It is always relative to this list, never a global rank.
   */
  rank: number;
  /**
   * `1 - cosine_distance`, clamped to [0,1]. RETAINED on the wire for backwards-compat (and read by
   * the F4 MMR diversity adapter) but it is NOT load-bearing for the UI — the UI shows `rank`/band,
   * not a raw cosine %. The compressed cosine metric is why the % was dropped (W5 F2).
   */
  similarity: number;
  hasScreenshot: boolean;
}

/**
 * Adapter-internal similar-design row: the public `SimilarDesign` shape PLUS the `moodCategory`
 * diversity proxy field (W5 F4). `moodCategory` is SELECTed by the SQL but stripped from the public
 * `SimilarDesign` response (`INV-WEBUI-SIMILAR-RANK-001` negative pin) — it only reaches the F4 MMR
 * (`featured-diversity.ts`) inside `getFeaturedComparison`, never the wire.
 */
export interface SimilarDesignWithMood extends SimilarDesign {
  /** Raw `MoodCategory` enum string, or null. Diversity proxy only — never exposed publicly. */
  moodCategory: string | null;
}

/** A single section summary (read-only, plain-text + sanitized-HTML structure preview). */
export interface SectionSummary {
  id: string;
  sectionType: string;
  sectionName: string | null;
  positionIndex: number;
  /** Bounding box from `layout_info.position` (may be absent → null, graceful). */
  position: unknown;
  /** Nulled when this section contains a high-PII part (section-linked redaction). */
  htmlSnippet: string | null;
  /**
   * Whether a persisted crop exists for this section (W6 Issue A PR-4a, F-L-04). Additive
   * boolean derived from `crop_storage_path IS NOT NULL` — the raw path is NEVER exposed
   * (CWE-209 path-leak avoidance, same pattern as `hasScreenshot`). high-PII sections never
   * carry a crop_storage_path (fail-closed), so `hasCrop:false` discloses no existence.
   */
  hasCrop: boolean;
}

/** A single part summary (read-only). high-PII rows are redacted at this boundary. */
export interface PartSummary {
  id: string;
  partType: string;
  /**
   * Owning section pattern id (W6 Issue A PR-1, additive grouping field). Lets the viewer group
   * parts under their section for the section→part drill. Non-PII (a UUID FK), so never redacted.
   */
  sectionPatternId: string;
  /** `bounding_box` JSONB (all-zero in practice → "no coordinates" graceful in viewer). */
  boundingBox: unknown;
  piiRiskLevel: string;
  /** Nulled for high-PII rows (redaction); plain-text snippet otherwise. */
  htmlSnippet: string | null;
  /** Empty for high-PII rows (redaction). */
  cssClasses: string[];
  /** Null for high-PII rows (redaction). */
  attributes: unknown;
  /**
   * Whether a persisted crop exists for this part (W6 Issue A PR-4a, F-L-04). Additive
   * boolean derived from `crop_storage_path IS NOT NULL` — the raw path is NEVER exposed
   * (CWE-209, same pattern as `hasScreenshot`). high-PII parts never carry a crop_storage_path
   * (fail-closed), so `hasCrop:false` discloses no existence.
   */
  hasCrop: boolean;
}

/**
 * A single-section read result (W6 Issue A PR-1, the section.inspect SSOT). Metadata-only +
 * section-linked-redacted structure preview source: when this section contains a high-PII part,
 * `htmlSnippet` is nulled via the SAME `getHighPiiSectionIds` SSOT used by `getPageSections`, so
 * the section.inspect tool's sanitized structure-preview sink can never carry high-PII markup
 * (`INV-SECTION-INSPECT-PII-REDACTION-001`, extends `INV-WEBUI-HIGHPII-NEVER-IN-RESPONSE-001`).
 */
export interface SectionDetail {
  id: string;
  /** Owning page id (so the section handle is self-describing; used for cross-page context). */
  webPageId: string;
  sectionType: string;
  sectionName: string | null;
  positionIndex: number;
  /** Bounding box from `layout_info.position` (may be absent → null, graceful). */
  position: unknown;
  /** Nulled when this section contains a high-PII part (section-linked redaction). */
  htmlSnippet: string | null;
}

/**
 * A streamable screenshot read result: the file stream plus its byte length for
 * `Content-Length`. `null` from `getScreenshotStream` means 404 (missing / escaped / symlink).
 *
 * 配信用スクリーンショットの読み取り結果: ファイルストリームと `Content-Length` 用バイト長。
 * `getScreenshotStream` が `null` を返すのは 404 (不在 / 逸脱 / symlink) を意味する。
 */
export interface ScreenshotStream {
  stream: Readable;
  bytes: number;
}

/** A paginated listing envelope. */
export interface Paginated<T> {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
}

/** Read a value-keyed property off an unknown JSONB object, or undefined. */
function readJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Extract `design_quality.axisScores` into a finite-number map (NaN/Infinity defended).
 * Pure function (UB-7 / CC≤10): graceful on missing keys / wrong types → empty map.
 */
export function extractAxisScores(designQuality: unknown): AxisScores {
  const root = readJsonObject(designQuality);
  const axes = readJsonObject(root?.axisScores);
  if (!axes) return {};
  const out: AxisScores = {};
  for (const [key, raw] of Object.entries(axes)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * Extract `design_quality.axisGrades` into a string map.
 * Pure function (UB-7 / CC≤10): graceful on missing keys / wrong types → empty map.
 */
export function extractAxisGrades(designQuality: unknown): AxisGrades {
  const root = readJsonObject(designQuality);
  const axes = readJsonObject(root?.axisGrades);
  if (!axes) return {};
  const out: AxisGrades = {};
  for (const [key, raw] of Object.entries(axes)) {
    if (typeof raw === "string") {
      out[key] = raw;
    }
  }
  return out;
}

/** Read `layout_info.position` (bbox) from the section's JSONB, or null (graceful). */
function readSectionPosition(layoutInfo: unknown): unknown {
  const root = readJsonObject(layoutInfo);
  return root?.position ?? null;
}

/**
 * Convert a raw cosine `distance` to a `similarity` in [0,1] (L-07 / vector-data NaN defense).
 * `similarity = 1 - distance`, clamped to [0,1]; a non-finite input (NaN/Infinity) → 0.
 */
function distanceToSimilarity(distance: number): number {
  const similarity = 1 - distance;
  if (!Number.isFinite(similarity)) return 0;
  return Math.max(0, Math.min(1, similarity));
}

/**
 * Page detail (meta + counts + hasScreenshot). Returns null for a non-existent webPageId
 * (→ route 404). Read-only `findUnique` + two `count` queries.
 */
export async function getPageDetail(webPageId: string): Promise<PageDetail | null> {
  const page = await prisma.webPage.findUnique({
    where: { id: webPageId },
    select: {
      id: true,
      url: true,
      title: true,
      description: true,
      sourceType: true,
      analysisStatus: true,
      embeddingBackfillStatus: true,
      screenshotStoragePath: true,
      crawledAt: true,
    },
  });
  if (!page) return null;

  const [sectionCount, partCount] = await Promise.all([
    prisma.sectionPattern.count({ where: { webPageId } }),
    prisma.componentPart.count({ where: { webPageId } }),
  ]);

  return {
    id: page.id,
    url: page.url,
    title: page.title,
    description: page.description,
    sourceType: page.sourceType,
    analysisStatus: page.analysisStatus,
    embeddingBackfillStatus: page.embeddingBackfillStatus,
    hasScreenshot: page.screenshotStoragePath != null,
    crawledAt: page.crawledAt,
    sectionCount,
    partCount,
  };
}

/**
 * Latest quality evaluation for a page, or null when unevaluated (graceful "未評価").
 * Reads `quality_evaluations` (target_type='web_page'), newest first.
 */
export async function getPageQuality(webPageId: string): Promise<PageQuality | null> {
  const row = await prisma.qualityEvaluation.findFirst({
    where: { targetType: "web_page", targetId: webPageId },
    orderBy: { createdAt: "desc" },
    select: { overallScore: true, grade: true, designQuality: true, recommendations: true },
  });
  if (!row) return null;

  const details = readJsonObject(row.designQuality)?.axisDetails ?? null;
  return {
    overallScore: row.overallScore,
    grade: row.grade,
    axisScores: extractAxisScores(row.designQuality),
    axisGrades: extractAxisGrades(row.designQuality),
    axisDetails: details,
    // Graceful: an empty/null column → [] (string[] default in the schema, but defend at the
    // boundary too so a null from a stale row never crashes the viewer).
    recommendations: Array.isArray(row.recommendations) ? row.recommendations : [],
  };
}

/**
 * Human-meaningful design narrative for a page (W2 human-value rework), or null when the page
 * has no narrative (graceful "未分析", NOT a 404). `web_page_id @unique` → `findUnique`.
 *
 * Data minimization (GDPR Art.5(1)(c)): only the human-readable columns are selected. The
 * machine-facing JSON columns (`layoutStructure` / `visualHierarchy` / `spacingRhythm` /
 * `sectionRelationships` / `graphicElements`) and the redundant `sourceUrl` are intentionally
 * NOT selected, so they never reach the response.
 */
export async function getPageNarrative(webPageId: string): Promise<PageNarrative | null> {
  const row = await prisma.designNarrative.findUnique({
    where: { webPageId },
    select: {
      moodCategory: true,
      moodDescription: true,
      colorImpression: true,
      typographyPersonality: true,
      motionEmotion: true,
      overallTone: true,
      confidence: true,
      tags: true,
      analyzedAt: true,
    },
  });
  if (!row) return null;

  return {
    moodCategory: row.moodCategory,
    moodDescription: row.moodDescription,
    colorImpression: row.colorImpression,
    typographyPersonality: row.typographyPersonality,
    motionEmotion: row.motionEmotion,
    overallTone: row.overallTone,
    confidence: row.confidence,
    tags: row.tags,
    analyzedAt: row.analyzedAt.toISOString(),
  };
}

/** Shape of a raw `getSimilarDesigns` SQL row (snake_case from the DB). */
interface SimilarDesignRow {
  id: string;
  url: string;
  title: string | null;
  has_screenshot: boolean;
  distance: number;
  /** Raw `MoodCategory` enum string (W5 F4 diversity proxy), or null when the neighbor narrative is absent. */
  mood_category: string | null;
}

/**
 * Read-only pgvector nearest-neighbor "similar designs" for a page (W2 human-value rework,
 * UB-1 / UB-5). NO ML is booted, NO embedding is generated: the source page's already-persisted
 * `design_narrative_embeddings.embedding` is read **inside the SQL** via a self-referential
 * subquery (a NEW pattern — there is no existing codebase precedent for the
 * `<=> (SELECT ... WHERE web_page_id = $1)` form; the existing pgvector neighbors build the query
 * vector in JS and bind it as `$1::vector`). This keeps the embedding entirely in PostgreSQL
 * (zero JS round-trip → no `::text`/`parseVectorString`/vectorString reconstruction, smaller
 * NaN/Infinity parse surface, no embedding on the JS heap).
 *
 * Contract:
 * - SELECT-only single statement, parameter-bind only (`$1` = source webPageId Zod-UUID-validated,
 *   `$2` = limit Zod-int-bounded). User input is never string-interpolated → SQL injection
 *   surface 0 (`INV-WEBUI-SIMILAR-READONLY-SELECT-001`, mcp-server source-pin).
 * - Self-exclusion: `dn.web_page_id != $1::uuid` removes the source page from the population
 *   (`INV-WEBUI-SIMILAR-SELF-EXCLUSION-001`); a service-layer filter is kept as defense-in-depth.
 * - Source-NULL graceful: when the source embedding is NULL/absent (the 14 pages where
 *   narrative exists but embedding is NULL), the `(subquery) IS NOT NULL` guard yields 0 rows →
 *   honest empty `[]` (NOT a fake success).
 * - `similarity = 1 - distance` clamped to [0,1] with NaN/Infinity → 0 (vector-data defense).
 * - `rank` = 1-origin distance rank on the POST-filter array (W5 F2).
 * - Minimal info: id/url/title/rank/similarity/hasScreenshot + the adapter-internal `moodCategory`
 *   (W5 F4 diversity proxy); the public `getSimilarDesigns` strips `moodCategory` before the wire.
 *
 * NOTE: small population (~369 rows) — PostgreSQL's planner may choose a seq scan over the HNSW
 * index; latency is acceptable at this size (an `EXPLAIN ANALYZE` note is recorded at acceptance).
 */
export async function getSimilarDesignsWithMood(
  webPageId: string,
  limit: number
): Promise<SimilarDesignWithMood[]> {
  // Single SELECT statement (no trailing `;`, no stacked query). The source embedding is resolved
  // by the self-referential subquery; the `(subquery) IS NOT NULL` guard makes a source-NULL page
  // return 0 rows (honest empty). $1 = source webPageId (Zod UUID), $2 = limit (Zod int). `dn` is
  // the neighbor's narrative (already joined), so `dn.mood_category` is the W5 F4 diversity proxy
  // (SELECTed here, stripped from the public `SimilarDesign` in `getSimilarDesigns`).
  const sql = `
    SELECT
      wp.id,
      wp.url,
      wp.title,
      (wp.screenshot_storage_path IS NOT NULL) AS has_screenshot,
      dn.mood_category AS mood_category,
      (
        dne.embedding <=> (
          SELECT dne2.embedding
          FROM design_narrative_embeddings dne2
          JOIN design_narratives dn2 ON dn2.id = dne2.design_narrative_id
          WHERE dn2.web_page_id = $1::uuid
            AND dne2.embedding IS NOT NULL
        )
      ) AS distance
    FROM design_narrative_embeddings dne
    JOIN design_narratives dn ON dn.id = dne.design_narrative_id
    JOIN web_pages wp ON wp.id = dn.web_page_id
    WHERE dne.embedding IS NOT NULL
      AND dn.web_page_id != $1::uuid
      AND (
        SELECT dne2.embedding
        FROM design_narrative_embeddings dne2
        JOIN design_narratives dn2 ON dn2.id = dne2.design_narrative_id
        WHERE dn2.web_page_id = $1::uuid
          AND dne2.embedding IS NOT NULL
      ) IS NOT NULL
    ORDER BY
      dne.embedding <=> (
        SELECT dne2.embedding
        FROM design_narrative_embeddings dne2
        JOIN design_narratives dn2 ON dn2.id = dne2.design_narrative_id
        WHERE dn2.web_page_id = $1::uuid
          AND dne2.embedding IS NOT NULL
      ) ASC
    LIMIT $2
  `;

  const rows = await prisma.$queryRawUnsafe<SimilarDesignRow[]>(sql, webPageId, limit);

  // Defense-in-depth self-exclusion (the SQL already excludes self via `!= $1`). Rank is assigned on
  // the POST-filter array (1-origin), so a self row dropped by the JS filter leaves NO rank gap
  // (`INV-WEBUI-SIMILAR-RANK-001`); the rows are distance-ASC, so `index + 1` is the distance rank.
  return rows
    .filter((row) => row.id !== webPageId)
    .map((row, index) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      rank: index + 1,
      similarity: distanceToSimilarity(row.distance),
      hasScreenshot: row.has_screenshot,
      moodCategory: row.mood_category,
    }));
}

/**
 * Public read-only pgvector nearest-neighbor "similar designs" for a page (W2/W5). Delegates to
 * `getSimilarDesignsWithMood` and strips the adapter-internal `moodCategory` so the public
 * `SimilarDesign` shape never carries the diversity proxy on the wire (`INV-WEBUI-SIMILAR-RANK-001`
 * negative pin). `rank` is the 1-origin distance rank (post-filter). See `getSimilarDesignsWithMood`
 * for the SQL contract.
 */
export async function getSimilarDesigns(
  webPageId: string,
  limit: number
): Promise<SimilarDesign[]> {
  const withMood = await getSimilarDesignsWithMood(webPageId, limit);
  // Strip the adapter-internal diversity proxy — the public shape is exactly SimilarDesign.
  return withMood.map(({ moodCategory: _moodCategory, ...rest }) => rest);
}

/**
 * Compute the set of section ids that contain at least one high-PII part, so the section's
 * `htmlSnippet` can be section-linked-redacted (ADR-0042 Amendment 1 §A1.3(b)). Read-only.
 *
 * SEC-M-01 (W6 Issue A PR-3a): EXPORTED so the crop-sink redaction (section.inspect crop
 * path, wired at the PR-4 serve route) imports the SAME high-PII SSOT instead of
 * re-implementing the predicate inline. PR-3a use is forward-compat import-pin only — the
 * crop read path does not exist until PR-4 (TPA-PR3A-L-02). `INV-CROP-PII-EXCLUDED-001`.
 */
export async function getHighPiiSectionIds(sectionIds: string[]): Promise<Set<string>> {
  if (sectionIds.length === 0) return new Set();
  const rows = await prisma.componentPart.findMany({
    where: { sectionPatternId: { in: sectionIds }, piiRiskLevel: HIGH_PII },
    select: { sectionPatternId: true },
    distinct: ["sectionPatternId"],
  });
  return new Set(rows.map((r) => r.sectionPatternId));
}

/**
 * Paginated sections for a page (read-only). The structure-preview `htmlSnippet` is nulled
 * for any section containing a high-PII part (section-linked redaction) so the single
 * sanitized-HTML sink never carries high-PII markup.
 */
export async function getPageSections(
  webPageId: string,
  page: number,
  pageSize: number
): Promise<Paginated<SectionSummary>> {
  const [total, rows] = await Promise.all([
    prisma.sectionPattern.count({ where: { webPageId } }),
    prisma.sectionPattern.findMany({
      where: { webPageId },
      orderBy: { positionIndex: "asc" },
      skip: page * pageSize,
      take: pageSize,
      select: {
        id: true,
        sectionType: true,
        sectionName: true,
        positionIndex: true,
        layoutInfo: true,
        htmlSnippet: true,
        // hasCrop (F-L-04): crop_storage_path presence only (raw path NEVER exposed).
        embedding: { select: { cropStoragePath: true } },
      },
    }),
  ]);

  const highPiiSections = await getHighPiiSectionIds(rows.map((r) => r.id));
  const items: SectionSummary[] = rows.map((row) => ({
    id: row.id,
    sectionType: row.sectionType,
    sectionName: row.sectionName,
    positionIndex: row.positionIndex,
    position: readSectionPosition(row.layoutInfo),
    htmlSnippet: highPiiSections.has(row.id) ? null : row.htmlSnippet,
    hasCrop: row.embedding?.cropStoragePath != null,
  }));

  return { page, pageSize, total, items };
}

/** Map a raw part row to a display-safe summary, redacting high-PII rows at this boundary. */
function toPartSummary(row: {
  id: string;
  partType: string;
  sectionPatternId: string;
  boundingBox: unknown;
  piiRiskLevel: string;
  htmlSnippet: string | null;
  cssClasses: string[];
  attributes: unknown;
  // hasCrop (F-L-04): crop_storage_path presence only (raw path NEVER exposed).
  embedding?: { cropStoragePath: string | null } | null;
}): PartSummary {
  const isHighPii = row.piiRiskLevel === HIGH_PII;
  return {
    id: row.id,
    partType: row.partType,
    sectionPatternId: row.sectionPatternId,
    boundingBox: row.boundingBox,
    piiRiskLevel: row.piiRiskLevel,
    htmlSnippet: isHighPii ? null : row.htmlSnippet,
    cssClasses: isHighPii ? [] : row.cssClasses,
    attributes: isHighPii ? null : row.attributes,
    hasCrop: row.embedding?.cropStoragePath != null,
  };
}

/**
 * Paginated parts for a page (read-only), with an optional `partType` filter. high-PII rows
 * have `htmlSnippet` / `attributes` / `cssClasses` redacted at this boundary (the
 * `pii_risk_level` marker is preserved so the viewer can show "PII リスクのため非表示").
 */
export async function getPageParts(
  webPageId: string,
  page: number,
  pageSize: number,
  partType?: string
): Promise<Paginated<PartSummary>> {
  const where = partType ? { webPageId, partType } : { webPageId };
  const [total, rows] = await Promise.all([
    prisma.componentPart.count({ where }),
    prisma.componentPart.findMany({
      where,
      orderBy: [{ sectionPatternId: "asc" }, { sampleIndex: "asc" }],
      skip: page * pageSize,
      take: pageSize,
      select: {
        id: true,
        partType: true,
        sectionPatternId: true,
        boundingBox: true,
        piiRiskLevel: true,
        htmlSnippet: true,
        cssClasses: true,
        attributes: true,
        // hasCrop (F-L-04): crop_storage_path presence only (raw path NEVER exposed).
        embedding: { select: { cropStoragePath: true } },
      },
    }),
  ]);

  return { page, pageSize, total, items: rows.map(toPartSummary) };
}

/**
 * Single-section read for the section.inspect MCP tool (W6 Issue A PR-1). Read-only `findUnique`
 * + the `getHighPiiSectionIds` SSOT for section-linked redaction. Returns null for a non-existent
 * `sectionId` (→ the tool maps that to an IDOR-shaped NOT_FOUND). A section pattern belongs to
 * exactly one page (`web_page_id`), so resolving by id alone is sufficient and the returned
 * `webPageId` makes the handle self-describing.
 */
export async function getSectionDetail(sectionId: string): Promise<SectionDetail | null> {
  const row = await prisma.sectionPattern.findUnique({
    where: { id: sectionId },
    select: {
      id: true,
      webPageId: true,
      sectionType: true,
      sectionName: true,
      positionIndex: true,
      layoutInfo: true,
      htmlSnippet: true,
    },
  });
  if (!row) return null;

  // SSOT mirror: a section containing a high-PII part has its structure-preview source nulled.
  const highPiiSections = await getHighPiiSectionIds([row.id]);
  return {
    id: row.id,
    webPageId: row.webPageId,
    sectionType: row.sectionType,
    sectionName: row.sectionName,
    positionIndex: row.positionIndex,
    position: readSectionPosition(row.layoutInfo),
    htmlSnippet: highPiiSections.has(row.id) ? null : row.htmlSnippet,
  };
}

/**
 * Section-scoped parts summary for the section.inspect MCP tool (W6 Issue A PR-1, opt-in). Reads
 * the parts owned by a single `sectionPatternId`, applying the SAME per-part high-PII redaction
 * (`toPartSummary`) as `getPageParts`. Read-only.
 *
 * `take` is an **un-paginated hard cap**: this is the only fetch for the section (no pagination at
 * the section level), so a section with more than `take` parts is **truncated** to the first `take`
 * by `sampleIndex asc` (caller passes `SECTION_PARTS_TAKE = 50` from inspect.tool.ts). Truncation is
 * silent (no `total` / `nextPage` is returned), so the summary is a bounded preview, not a complete
 * enumeration.
 */
export async function getSectionParts(
  sectionPatternId: string,
  take: number
): Promise<PartSummary[]> {
  const rows = await prisma.componentPart.findMany({
    where: { sectionPatternId },
    orderBy: { sampleIndex: "asc" },
    take,
    select: {
      id: true,
      partType: true,
      sectionPatternId: true,
      boundingBox: true,
      piiRiskLevel: true,
      htmlSnippet: true,
      cssClasses: true,
      attributes: true,
      // hasCrop (F-L-04): crop_storage_path presence only (raw path NEVER exposed).
      embedding: { select: { cropStoragePath: true } },
    },
  });
  return rows.map(toPartSummary);
}

/**
 * Resolve the persisted full-page screenshot for a webPageId as a readable file stream
 * (WebUI v1 W2 rework — ADR-0042 Amendment 3, full-screenshot serve; per-section crops descoped).
 *
 * Resolver chain (SSOT only — NO second resolver, NO Sharp/crop):
 *   1. `getScreenshotPath(webPageId)` (SSOT) = DB-first + `phase5Dir` startsWith allowlist +
 *      `fs.access`. Returns `null` for a missing row / stale path / outside-allowlist DB value.
 *   2. UB-1 (SEC-PLAN-W2RV1-H-01, CWE-22): the candidate path is then passed through
 *      `validateScreenshotPath` (the existing symlink-hardener SSOT = null-byte + startsWith +
 *      `fs.realpath` + `isFile`). A symlink at `<phase5Dir>/<uuid>.png` pointing outside the
 *      allowlist resolves to `null` → 404, so `createReadStream` never follows it out of root.
 * Any `null` in the chain returns `null` (the route maps this to a status-only 404).
 *
 * This method is READ-ONLY (`INV-WEBUI-READONLY-NEGATIVE-001` / INV-WEBUI-SCREENSHOT-005): it
 * performs 0 create/update/delete/Prisma-write verbs of its own (the SSOT's own stale-path
 * housekeeping lives inside `screenshot-persistence.service.ts`, not here).
 *
 * webPageId の永続フルページスクリーンショットを読み取りストリームとして解決する
 * (WebUI v1 W2 リワーク — ADR-0042 Amendment 3、フルスクリーンショット配信、section crop は descope)。
 * パス解決と path-traversal 防御は SSOT のみを使用 (第2 resolver 禁止、Sharp/crop 不使用)。
 * UB-1: `getScreenshotPath` の結果を `validateScreenshotPath` (realpath+isFile SSOT) に通してから
 * `createReadStream` するため、symlink による allowlist 逸脱は null → 404 となる。本メソッドは
 * 完全 read-only (自身の Prisma write verb は 0)。
 *
 * @param webPageId UUID v4/v7 (route-validated upstream via `webPageIdParamSchema`).
 * @returns `{ stream, bytes }` on success, or `null` for missing / escaped / symlink → 404.
 */
export async function getScreenshotStream(webPageId: string): Promise<ScreenshotStream | null> {
  const candidatePath = await createScreenshotPersistenceService({ prisma }).getScreenshotPath(
    webPageId
  );
  if (candidatePath === null) return null;

  // UB-1 (CWE-22): re-harden the candidate path through the realpath+isFile SSOT before reading,
  // so a symlink escaping the allowlist resolves to null → 404 (never followed by createReadStream).
  const safePath = await validateScreenshotPath(candidatePath);
  if (safePath === null) return null;

  const fileStat = await stat(safePath);
  const bytes = fileStat.size;
  const stream = createReadStream(safePath);
  return { stream, bytes };
}

/**
 * DB-first lookup of the persisted crop_storage_path for a (webPageId, kind, entityId).
 * The `entityId` is the `section_pattern_id` (section) or `component_part_id` (part).
 * `kind` is an enum (validated upstream by `cropParamsSchema`), so the kind-routed
 * table/column names are NOT user input. The id values are bound as `$N::uuid`
 * parameters (parameterized — no injection surface). Returns null for a missing row
 * OR a NULL `crop_storage_path` (serve-time PII redaction: high-PII rows never carry
 * a crop_storage_path, so the DB-first lookup returns null → 404).
 *
 * DB-first で crop_storage_path を解決 (kind-routed)。high-PII 行は crop_storage_path
 * を持たない (Phase 5 fail-closed) ため null → 404 が serve-time PII redaction となる。
 *
 * Serve-time PII redaction scope (F-L-01, NO over-claim): the part serve-time defense is
 * exactly two layers — (i) structural non-generation (the Phase 5 / backfill PII-filtered
 * loop never persists a high-PII part crop) + (ii) this DB-first NULL → 404. That is
 * SUFFICIENT for parts (A11.1): a part has its own `pii_risk_level`, so a high-PII part has
 * no crop_storage_path and (ii) returns null. The optional belt-and-braces READ-sink
 * (`getHighPiiSectionIds`) is a SECTION-only third layer (a section is high-PII iff it
 * *contains* a high-PII part — a relational predicate the section row itself does not carry).
 * This function does NOT consult `getHighPiiSectionIds` for the part path (it would be
 * redundant); the section path MAY add it as defense-in-depth in a future PR.
 */
async function lookupCropStoragePath(
  webPageId: string,
  kind: CropKind,
  entityId: string
): Promise<string | null> {
  // kind-routed query: section keyed by section_pattern_id, part by component_part_id.
  // Both ids are bound as $::uuid params; web_page_id is asserted to scope the row to
  // the page (defense-in-depth so a foreign entityId cannot serve another page's crop).
  const rows =
    kind === "section"
      ? await prisma.$queryRawUnsafe<Array<{ crop_storage_path: string | null }>>(
          `SELECT se.crop_storage_path
             FROM section_embeddings se
             JOIN section_patterns sp ON sp.id = se.section_pattern_id
            WHERE se.section_pattern_id = $1::uuid
              AND sp.web_page_id = $2::uuid
            LIMIT 1`,
          entityId,
          webPageId
        )
      : await prisma.$queryRawUnsafe<Array<{ crop_storage_path: string | null }>>(
          `SELECT cpe.crop_storage_path
             FROM component_part_embeddings cpe
             JOIN component_parts cp ON cp.id = cpe.component_part_id
            WHERE cpe.component_part_id = $1::uuid
              AND cp.web_page_id = $2::uuid
            LIMIT 1`,
          entityId,
          webPageId
        );
  const value = rows.length > 0 ? rows[0]!.crop_storage_path : null;
  return value ?? null;
}

/**
 * Resolve the persisted per-section / per-part crop for a (webPageId, kind, entityId)
 * as a readable file stream (WebUI v1 W6 Issue A PR-4a — ADR-0042 Amendment 12, crop
 * serve route). A structural clone of `getScreenshotStream`, with the crop validator.
 *
 * Resolver chain (SSOT only — NO 2nd resolver, NO Sharp/crop at serve time):
 *   1. DB-first: `lookupCropStoragePath` returns the stored `crop_storage_path` (or
 *      null for a missing row / NULL value). **This is the serve-time PII redaction**:
 *      high-PII section/part have NO crop_storage_path (never persisted in Phase 5 /
 *      backfill's PII-filtered loop), so the DB-first lookup returns null → 404
 *      (double absence: no crop on disk + no DB pointer).
 *   2. `validateCropPath` (crop-persistence.helper SSOT, delegates to the screenshot
 *      `validatePathWithinRoot` 5-stage realpath core): null-byte → startsWith →
 *      realpath → realpath-re-startsWith → isFile. A symlink at
 *      `<cropRoot>/<webPageId>/<kind>-<entityId>.png` escaping the allowlist resolves
 *      to null → 404, so `createReadStream` never follows it out of root (F-H-01).
 * Any null in the chain returns null (the route maps this to a status-only 404).
 *
 * This method is READ-ONLY (`INV-WEBUI-READONLY-NEGATIVE-001`): 0 create/update/delete
 * verbs of its own. It NEVER calls Sharp to cut a crop at serve time — it serves ONLY
 * crops persisted by Phase 5 / backfill (the `019eeb68` serve-time-crop BLOCK is honored).
 *
 * @param webPageId UUID v4/v7 (route-validated upstream via `cropParamsSchema`).
 * @param kind      "section" | "part" (route-validated enum).
 * @param entityId  UUID v4/v7 (section_pattern_id / component_part_id, route-validated).
 * @returns `{ stream, bytes }` on success, or null for missing / NULL / escaped / symlink → 404.
 */
export async function getCropStream(
  webPageId: string,
  kind: CropKind,
  entityId: string
): Promise<ScreenshotStream | null> {
  const candidatePath = await lookupCropStoragePath(webPageId, kind, entityId);
  if (candidatePath === null) return null;

  // F-H-01 (CWE-22): re-harden the candidate path through the realpath+isFile crop SSOT
  // before reading, so a symlink escaping the crop allowlist resolves to null → 404.
  const safePath = await validateCropPath(candidatePath);
  if (safePath === null) return null;

  const fileStat = await stat(safePath);
  const bytes = fileStat.size;
  const stream = createReadStream(safePath);
  return { stream, bytes };
}
