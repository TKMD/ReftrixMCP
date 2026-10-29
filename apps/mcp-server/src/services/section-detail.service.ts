// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Section detail read-only service (section.inspect SSOT).
 *
 * Moved verbatim from `api/internal/page-detail.service.ts` (behavior-preserving move) so the
 * `section.inspect` MCP tool no longer depends on the internal read API layer. Fully read-only —
 * no create / update / delete. High-PII redaction (ADR-0042 Amendment 1 §A1.3): parts with
 * `pii_risk_level === 'high'` have `htmlSnippet` / `attributes` / `cssClasses` stripped at this
 * boundary (the marker is preserved), and a section containing a high-PII part has its
 * `htmlSnippet` nulled (`INV-SECTION-INSPECT-PII-REDACTION-001`,
 * `INV-WEBUI-HIGHPII-NEVER-IN-RESPONSE-001`, `INV-CROP-PII-EXCLUDED-001`).
 *
 * section.inspect が依存する section 詳細の read-only service。page-detail.service.ts から
 * 挙動を変えずに移設した。
 *
 * @module services/section-detail.service
 */

import { prisma } from "@reftrixmcp/database";

/**
 * `pii_risk_level` value that triggers high-PII redaction at this read boundary.
 * Module-private: one constant shared by `getHighPiiSectionIds` and `toPartSummary`.
 */
const HIGH_PII = "high";

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
   * Crop generation has ended: new pages are always `false`; `true` only where a legacy crop remains.
   */
  hasCrop: boolean;
}

/**
 * A single-section read result (W6 Issue A PR-1, the section.inspect SSOT). Metadata-only +
 * section-linked-redacted structure preview source: when this section contains a high-PII part,
 * `htmlSnippet` is nulled via the SAME `getHighPiiSectionIds` SSOT used by the section read paths, so
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

/** Read a value-keyed property off an unknown JSONB object, or undefined. */
function readJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** Read `layout_info.position` (bbox) from the section's JSONB, or null (graceful). */
function readSectionPosition(layoutInfo: unknown): unknown {
  const root = readJsonObject(layoutInfo);
  return root?.position ?? null;
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
 * (`toPartSummary`) as the other part-summary reads. Read-only.
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
