// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * section.inspect MCP tool unit tests (WebUI v1 W6 Issue A PR-1 — ADR-0042 / Registry §1).
 *
 * Pins:
 * - `INV-SECTION-INSPECT-HANDLE-RESOLVE-001` (M, SEC-M-02): the tool resolves a section by a
 *   UUID `section_id` (handle `reftrix:page/<id>/section/<id>` resolution path), and rejects
 *   a non-UUID `section_id` (VALIDATION_ERROR) and a non-existent `section_id`
 *   (NOT_FOUND). `sanitizeErrorMessage` (CWE-209) on the catch path.
 *   Honesty note: section.inspect is single-tenant (no tenant/owner column), so the NOT_FOUND
 *   reject is null-row non-disclosure of id resolution, NOT an authz/IDOR control (same as the
 *   part.inspect precedent). `z.string().uuid()` is version-agnostic (accepts UUID v4) → "UUID".
 * - `INV-SECTION-INSPECT-PII-REDACTION-001` (H, SEC-M-02 ≡ plan H): a high-PII section's
 *   `htmlSnippet` (and structure preview) is null in the response, mirroring the
 *   `getHighPiiSectionIds` SSOT used by the internal read API.
 *
 * The page-detail read service is exercised through the real `getSectionDetail` with the Prisma
 * client mocked, so the redaction SSOT (getHighPiiSectionIds) is genuinely traversed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@reftrixmcp/database", () => ({
  prisma: {
    sectionPattern: { findUnique: vi.fn() },
    componentPart: { findMany: vi.fn() },
  },
}));

import { prisma } from "@reftrixmcp/database";
import { sectionInspectHandler } from "../../../src/tools/section/inspect.tool";

const SECTION_ID = "0190b6f0-aaaa-7abc-89ab-0123456789ab";
const WEB_PAGE_ID = "0190b6f0-1234-7abc-89ab-0123456789ab";

const mockedSectionFindUnique = prisma.sectionPattern.findUnique as ReturnType<typeof vi.fn>;
const mockedPartFindMany = prisma.componentPart.findMany as ReturnType<typeof vi.fn>;

function baseSectionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SECTION_ID,
    webPageId: WEB_PAGE_ID,
    sectionType: "hero",
    sectionName: "Hero",
    positionIndex: 0,
    layoutInfo: { position: { startY: 0, endY: 600, height: 600 } },
    htmlSnippet: "<section><h1>Hello</h1></section>",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no high-PII parts in the section (so htmlSnippet survives unless a test overrides).
  mockedPartFindMany.mockResolvedValue([]);
});

describe("INV-SECTION-INSPECT-HANDLE-RESOLVE-001 — UUID handle resolution + null-row non-disclosure reject", () => {
  it("resolves a section by a valid UUID section_id and returns metadata", async () => {
    mockedSectionFindUnique.mockResolvedValue(baseSectionRow());

    const result = await sectionInspectHandler({ section_id: SECTION_ID });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe(SECTION_ID);
      expect(result.data.sectionType).toBe("hero");
      expect(result.data.sectionName).toBe("Hero");
      expect(result.data.positionIndex).toBe(0);
      expect(result.data.webPageId).toBe(WEB_PAGE_ID);
      expect(result.data.position).toEqual({ startY: 0, endY: 600, height: 600 });
    }
  });

  it("rejects a non-UUID section_id with VALIDATION_ERROR (Zod boundary)", async () => {
    const result = await sectionInspectHandler({ section_id: "not-a-uuid" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
    // Must NOT hit the DB on a validation failure.
    expect(mockedSectionFindUnique).not.toHaveBeenCalled();
  });

  it("rejects a missing required section_id with VALIDATION_ERROR", async () => {
    const result = await sectionInspectHandler({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects a non-existent section_id with NOT_FOUND (null-row non-disclosure, single-tenant)", async () => {
    mockedSectionFindUnique.mockResolvedValue(null);

    const result = await sectionInspectHandler({ section_id: SECTION_ID });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("NOT_FOUND");
      // CWE-209: message must not leak internal structure (table/column names).
      expect(result.error.message).not.toMatch(/section_patterns|web_pages|SELECT|column/i);
    }
  });

  it("returns INTERNAL_ERROR with a sanitized message on a DB failure (CWE-209)", async () => {
    mockedSectionFindUnique.mockRejectedValue(
      Object.assign(new Error('relation "section_patterns" does not exist'), { code: "P2021" })
    );

    const result = await sectionInspectHandler({ section_id: SECTION_ID });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.message).not.toContain("section_patterns");
    }
  });

  it("includes structure preview only when include_structure_preview is true", async () => {
    mockedSectionFindUnique.mockResolvedValue(baseSectionRow());

    const without = await sectionInspectHandler({ section_id: SECTION_ID });
    expect(without.success).toBe(true);
    if (without.success) {
      expect(without.data.structurePreview).toBeUndefined();
    }

    const withPreview = await sectionInspectHandler({
      section_id: SECTION_ID,
      include_structure_preview: true,
    });
    expect(withPreview.success).toBe(true);
    if (withPreview.success) {
      expect(typeof withPreview.data.structurePreview).toBe("string");
      // sanitized HTML must not contain a raw <script>
      expect(withPreview.data.structurePreview ?? "").not.toContain("<script");
    }
  });

  it("includes parts summary only when include_parts_summary is true", async () => {
    mockedSectionFindUnique.mockResolvedValue(baseSectionRow());
    mockedPartFindMany.mockResolvedValue([]);

    const without = await sectionInspectHandler({ section_id: SECTION_ID });
    expect(without.success).toBe(true);
    if (without.success) {
      expect(without.data.partsSummary).toBeUndefined();
    }

    const withParts = await sectionInspectHandler({
      section_id: SECTION_ID,
      include_parts_summary: true,
    });
    expect(withParts.success).toBe(true);
    if (withParts.success) {
      expect(Array.isArray(withParts.data.partsSummary)).toBe(true);
    }
  });
});

describe("INV-SECTION-INSPECT-PII-REDACTION-001 — high-PII htmlSnippet/preview null (SSOT mirror)", () => {
  it("nulls htmlSnippet and structure preview when the section contains a high-PII part", async () => {
    mockedSectionFindUnique.mockResolvedValue(
      baseSectionRow({ htmlSnippet: "<section><img alt='avatar'></section>" })
    );
    // getHighPiiSectionIds SSOT: this section has a high-PII part → it is in the redaction set.
    mockedPartFindMany.mockResolvedValue([{ sectionPatternId: SECTION_ID }]);

    const result = await sectionInspectHandler({
      section_id: SECTION_ID,
      include_structure_preview: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.htmlSnippet).toBeNull();
      expect(result.data.structurePreview ?? null).toBeNull();
      // metadata (non-PII) is still present.
      expect(result.data.sectionType).toBe("hero");
    }
  });

  it("preserves htmlSnippet when the section has NO high-PII part", async () => {
    mockedSectionFindUnique.mockResolvedValue(baseSectionRow());
    mockedPartFindMany.mockResolvedValue([]);

    const result = await sectionInspectHandler({
      section_id: SECTION_ID,
      include_structure_preview: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.htmlSnippet).not.toBeNull();
      expect(result.data.structurePreview).toBeTruthy();
    }
  });
});
