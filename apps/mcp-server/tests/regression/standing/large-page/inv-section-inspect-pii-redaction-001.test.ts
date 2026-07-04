// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-SECTION-INSPECT-PII-REDACTION-001 (H) — large-page standing regression.
 *
 * Contract (Registry §1, plan-v1 §6.1 / §7.1):
 *   section.inspect MUST null a high-PII section's `htmlSnippet` (and its sanitized structure
 *   preview) by mirroring the `getHighPiiSectionIds` SSOT used by the internal read API
 *   (`page-detail.service.ts`). The crop/markup high-PII sink class (223 avatars,
 *   part_type=avatar) must never reach the single sanitized-HTML sink — this extends
 *   `INV-WEBUI-HIGHPII-NEVER-IN-RESPONSE-001` to the section.inspect read tool.
 *
 * This is a deterministic, Prisma-mocked standing test (same isolation pattern as
 * `tests/api/internal/page-detail.service.test.ts`). It does NOT gate on DATABASE_URL, so it can
 * never short-circuit into a false PASS (cf. real-DB short-circuit feedback). The mocked
 * `componentPart.findMany` IS the `getHighPiiSectionIds` SSOT call, so the redaction path is
 * genuinely exercised end-to-end through the real `getSectionDetail` → handler.
 *
 * Severity: H (accepted-risk forbidden, CI-failing).
 */

// INV-SECTION-INSPECT-PII-REDACTION-001

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@reftrixmcp/database", () => ({
  prisma: {
    sectionPattern: { findUnique: vi.fn() },
    componentPart: { findMany: vi.fn() },
  },
}));

import { prisma } from "@reftrixmcp/database";
import { sectionInspectHandler } from "../../../../src/tools/section/inspect.tool";

const SECTION_ID = "0190c700-aaaa-7abc-89ab-0123456789ab";
const WEB_PAGE_ID = "0190c700-1234-7abc-89ab-0123456789ab";

const mockedSectionFindUnique = prisma.sectionPattern.findUnique as ReturnType<typeof vi.fn>;
const mockedPartFindMany = prisma.componentPart.findMany as ReturnType<typeof vi.fn>;

const highPiiMarkup = "<section><img alt='user avatar' src='/avatar/jane.png'></section>";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("INV-SECTION-INSPECT-PII-REDACTION-001 (H) — high-PII section html never in response", () => {
  it("nulls htmlSnippet for a section containing a high-PII part (avatar)", async () => {
    mockedSectionFindUnique.mockResolvedValue({
      id: SECTION_ID,
      webPageId: WEB_PAGE_ID,
      sectionType: "team",
      sectionName: "Team",
      positionIndex: 4,
      layoutInfo: { position: { startY: 2400, endY: 3200, height: 800 } },
      htmlSnippet: highPiiMarkup,
    });
    // getHighPiiSectionIds SSOT: section is in the high-PII set.
    mockedPartFindMany.mockResolvedValue([{ sectionPatternId: SECTION_ID }]);

    const result = await sectionInspectHandler({
      section_id: SECTION_ID,
      include_structure_preview: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // Negative assert: high-PII markup is NEVER in the response.
      expect(result.data.htmlSnippet).toBeNull();
      expect(result.data.structurePreview ?? null).toBeNull();
      expect(JSON.stringify(result.data)).not.toContain("avatar");
      // Positive assert: non-PII metadata is preserved.
      expect(result.data.sectionType).toBe("team");
      expect(result.data.positionIndex).toBe(4);
    }
  });

  it("verifies the SSOT call: getHighPiiSectionIds is queried with the inspected section id", async () => {
    mockedSectionFindUnique.mockResolvedValue({
      id: SECTION_ID,
      webPageId: WEB_PAGE_ID,
      sectionType: "team",
      sectionName: null,
      positionIndex: 4,
      layoutInfo: null,
      htmlSnippet: highPiiMarkup,
    });
    mockedPartFindMany.mockResolvedValue([{ sectionPatternId: SECTION_ID }]);

    await sectionInspectHandler({ section_id: SECTION_ID, include_structure_preview: true });

    // The redaction SSOT must be invoked filtering by piiRiskLevel='high' on this section id.
    expect(mockedPartFindMany).toHaveBeenCalled();
    const callArg = mockedPartFindMany.mock.calls[0]?.[0] as {
      where?: { sectionPatternId?: { in?: string[] }; piiRiskLevel?: string };
    };
    expect(callArg?.where?.piiRiskLevel).toBe("high");
    expect(callArg?.where?.sectionPatternId?.in).toContain(SECTION_ID);
  });

  it("does NOT redact when the section has no high-PII part (preview survives)", async () => {
    mockedSectionFindUnique.mockResolvedValue({
      id: SECTION_ID,
      webPageId: WEB_PAGE_ID,
      sectionType: "feature",
      sectionName: "Feature",
      positionIndex: 2,
      layoutInfo: { position: { startY: 1200, endY: 1800, height: 600 } },
      htmlSnippet: "<section><h2>Fast</h2></section>",
    });
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
