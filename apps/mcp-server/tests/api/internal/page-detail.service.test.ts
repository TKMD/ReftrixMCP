// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Page-detail read service unit tests (WebUI v1 W2 — ADR-0042 Amendment 1 §A1.1/§A1.3).
 *
 * Pins:
 * - `INV-WEBUI-HIGHPII-NEVER-IN-RESPONSE-001` (UB-4(c)): high-PII part `htmlSnippet` /
 *   `attributes` / `cssClasses` are NEVER in the response (negative assert), the
 *   `pii_risk_level` marker IS preserved (positive assert), and section-linked redaction
 *   nulls a high-PII section's `htmlSnippet`.
 * - `hasScreenshot` boolean reduction (raw path never exposed).
 * - 404 = getPageDetail null for a non-existent id.
 * - pure helpers `extractAxisScores` / `extractAxisGrades` (graceful on missing keys / NaN).
 *
 * The Prisma client is mocked so the service is tested in isolation (no real DB).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@reftrixmcp/database", () => ({
  prisma: {
    webPage: { findUnique: vi.fn() },
    sectionPattern: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    componentPart: { count: vi.fn(), findMany: vi.fn() },
    qualityEvaluation: { findFirst: vi.fn() },
    designNarrative: { findUnique: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
}));

import { prisma } from "@reftrixmcp/database";
import {
  getPageDetail,
  getPageQuality,
  getPageSections,
  getPageParts,
  getPageNarrative,
  getSimilarDesigns,
  getSectionDetail,
  extractAxisScores,
  extractAxisGrades,
} from "../../../src/api/internal/page-detail.service";

const WEB_PAGE_ID = "0190b6f0-1234-7abc-89ab-0123456789ab";
const SECTION_A = "0190b6f0-aaaa-7abc-89ab-0123456789ab";
const SECTION_B = "0190b6f0-bbbb-7abc-89ab-0123456789ab";

const mockedFindUnique = prisma.webPage.findUnique as ReturnType<typeof vi.fn>;
const mockedSectionCount = prisma.sectionPattern.count as ReturnType<typeof vi.fn>;
const mockedSectionFindMany = prisma.sectionPattern.findMany as ReturnType<typeof vi.fn>;
const mockedPartCount = prisma.componentPart.count as ReturnType<typeof vi.fn>;
const mockedPartFindMany = prisma.componentPart.findMany as ReturnType<typeof vi.fn>;
const mockedQualityFindFirst = prisma.qualityEvaluation.findFirst as ReturnType<typeof vi.fn>;
const mockedNarrativeFindUnique = prisma.designNarrative.findUnique as ReturnType<typeof vi.fn>;
const mockedQueryRaw = prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>;
const mockedSectionFindUnique = prisma.sectionPattern.findUnique as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractAxisScores / extractAxisGrades (pure helpers, UB-7)", () => {
  it("extracts axis scores from design_quality JSONB", () => {
    const dq = { axisScores: { layout: 80, color: 65 } };
    expect(extractAxisScores(dq)).toEqual({ layout: 80, color: 65 });
  });

  it("extracts axis grades from design_quality JSONB", () => {
    const dq = { axisGrades: { layout: "A", color: "C" } };
    expect(extractAxisGrades(dq)).toEqual({ layout: "A", color: "C" });
  });

  it("is graceful on missing keys / wrong types (returns empty map)", () => {
    expect(extractAxisScores(null)).toEqual({});
    expect(extractAxisScores(undefined)).toEqual({});
    expect(extractAxisScores("not-an-object")).toEqual({});
    expect(extractAxisScores({ other: 1 })).toEqual({});
    expect(extractAxisGrades({ axisGrades: "wrong" })).toEqual({});
  });

  it("defends against NaN / Infinity in axis scores", () => {
    const dq = { axisScores: { ok: 50, bad: NaN, inf: Infinity } };
    expect(extractAxisScores(dq)).toEqual({ ok: 50 });
  });
});

describe("getPageDetail (hasScreenshot reduction, 404)", () => {
  it("returns null for a non-existent page (→ 404)", async () => {
    mockedFindUnique.mockResolvedValue(null);
    const result = await getPageDetail(WEB_PAGE_ID);
    expect(result).toBeNull();
  });

  it("reduces screenshot_storage_path to a hasScreenshot boolean (raw path never exposed)", async () => {
    mockedFindUnique.mockResolvedValue({
      id: WEB_PAGE_ID,
      url: "https://example.com",
      title: "Example",
      description: null,
      sourceType: "user_provided",
      analysisStatus: "completed",
      embeddingBackfillStatus: "completed",
      screenshotStoragePath: "/tmp/reftrix-screenshots/phase5/secret-abs-path.png",
      crawledAt: new Date("2026-06-14T00:00:00Z"),
    });
    mockedSectionCount.mockResolvedValue(3);
    mockedPartCount.mockResolvedValue(120);

    const result = await getPageDetail(WEB_PAGE_ID);
    expect(result).not.toBeNull();
    expect(result!.hasScreenshot).toBe(true);
    expect(result!.sectionCount).toBe(3);
    expect(result!.partCount).toBe(120);
    // The raw absolute path must never appear anywhere in the response.
    expect(JSON.stringify(result)).not.toContain("secret-abs-path");
    expect(JSON.stringify(result)).not.toContain("/tmp/reftrix-screenshots");
  });

  it("hasScreenshot is false when screenshot_storage_path is null", async () => {
    mockedFindUnique.mockResolvedValue({
      id: WEB_PAGE_ID,
      url: "https://example.com",
      title: null,
      description: null,
      sourceType: "award_gallery",
      analysisStatus: "completed",
      embeddingBackfillStatus: "not_required",
      screenshotStoragePath: null,
      crawledAt: new Date(),
    });
    mockedSectionCount.mockResolvedValue(0);
    mockedPartCount.mockResolvedValue(0);
    const result = await getPageDetail(WEB_PAGE_ID);
    expect(result!.hasScreenshot).toBe(false);
  });
});

describe("getPageQuality (graceful unevaluated + recommendations, L-08)", () => {
  it("returns null when the page is unevaluated (graceful 未評価)", async () => {
    mockedQualityFindFirst.mockResolvedValue(null);
    expect(await getPageQuality(WEB_PAGE_ID)).toBeNull();
  });

  it("extracts score/grade/axisScores/axisGrades/axisDetails/recommendations", async () => {
    mockedQualityFindFirst.mockResolvedValue({
      overallScore: 78,
      grade: "B",
      designQuality: {
        axisScores: { layout: 80 },
        axisGrades: { layout: "A" },
        axisDetails: { layout: "good spacing" },
      },
      recommendations: ["[warning] コントラスト比を改善してください"],
    });
    const result = await getPageQuality(WEB_PAGE_ID);
    expect(result).toEqual({
      overallScore: 78,
      grade: "B",
      axisScores: { layout: 80 },
      axisGrades: { layout: "A" },
      axisDetails: { layout: "good spacing" },
      recommendations: ["[warning] コントラスト比を改善してください"],
    });
  });

  it("recommendations defaults to [] when the column is empty/null (L-08 branch)", async () => {
    mockedQualityFindFirst.mockResolvedValue({
      overallScore: 90,
      grade: "A",
      designQuality: { axisScores: {}, axisGrades: {}, axisDetails: null },
      recommendations: [],
    });
    const empty = await getPageQuality(WEB_PAGE_ID);
    expect(empty!.recommendations).toEqual([]);

    // null/undefined column → graceful [] (not a crash, not a fake value).
    mockedQualityFindFirst.mockResolvedValue({
      overallScore: 90,
      grade: "A",
      designQuality: { axisScores: {}, axisGrades: {}, axisDetails: null },
      recommendations: null,
    });
    const nul = await getPageQuality(WEB_PAGE_ID);
    expect(nul!.recommendations).toEqual([]);
  });
});

describe("getPageNarrative (graceful unanalyzed)", () => {
  it("returns null when the page has no narrative (graceful 未分析, not 404)", async () => {
    mockedNarrativeFindUnique.mockResolvedValue(null);
    expect(await getPageNarrative(WEB_PAGE_ID)).toBeNull();
  });

  it("maps narrative columns and serializes analyzedAt to an ISO string", async () => {
    mockedNarrativeFindUnique.mockResolvedValue({
      moodCategory: "professional",
      moodDescription: "cool and professional",
      colorImpression: "overall: cool and professional, dominantEmotion: trust",
      typographyPersonality: "style: modern, readability: high",
      motionEmotion: "",
      overallTone: "primary: calm, formality: 0.9",
      confidence: 0.645,
      tags: ["calm", "trust"],
      analyzedAt: new Date("2026-06-14T00:00:00.000Z"),
    });
    const result = await getPageNarrative(WEB_PAGE_ID);
    expect(result).toEqual({
      moodCategory: "professional",
      moodDescription: "cool and professional",
      colorImpression: "overall: cool and professional, dominantEmotion: trust",
      typographyPersonality: "style: modern, readability: high",
      motionEmotion: "",
      overallTone: "primary: calm, formality: 0.9",
      confidence: 0.645,
      tags: ["calm", "trust"],
      analyzedAt: "2026-06-14T00:00:00.000Z",
    });
  });

  it("does NOT select machine-facing JSON columns (data minimization, GDPR Art.5(1)(c))", async () => {
    mockedNarrativeFindUnique.mockResolvedValue({
      moodCategory: "tech",
      moodDescription: null,
      colorImpression: null,
      typographyPersonality: null,
      motionEmotion: null,
      overallTone: null,
      confidence: null,
      tags: [],
      analyzedAt: new Date("2026-06-14T00:00:00.000Z"),
    });
    await getPageNarrative(WEB_PAGE_ID);
    const selectArg = mockedNarrativeFindUnique.mock.calls[0][0].select as Record<string, unknown>;
    // machine-facing JSON columns must NOT be selected (not sent over the wire).
    expect(selectArg.visualHierarchy).toBeUndefined();
    expect(selectArg.spacingRhythm).toBeUndefined();
    expect(selectArg.sectionRelationships).toBeUndefined();
    expect(selectArg.layoutStructure).toBeUndefined();
    expect(selectArg.graphicElements).toBeUndefined();
    expect(selectArg.sourceUrl).toBeUndefined();
  });
});

describe("getSimilarDesigns (read-only pgvector nearest-neighbor, UB-1/UB-5)", () => {
  it("INV-WEBUI-SIMILAR-SELF-EXCLUSION-001: never returns the source id, even if the DB layer were to include it", async () => {
    // Defense-in-depth: the SQL excludes self via `dn.web_page_id != $1`. If the DB layer were
    // to (incorrectly) include the source row, the service-layer filter still removes it.
    mockedQueryRaw.mockResolvedValue([
      {
        id: WEB_PAGE_ID,
        url: "https://self.example",
        title: "Self",
        has_screenshot: true,
        distance: 0,
      },
      {
        id: SECTION_A,
        url: "https://other.example",
        title: "Other",
        has_screenshot: true,
        distance: 0.2,
      },
    ]);
    const result = await getSimilarDesigns(WEB_PAGE_ID, 6);
    expect(result.map((r) => r.id)).not.toContain(WEB_PAGE_ID);
    expect(result.map((r) => r.id)).toContain(SECTION_A);
  });

  it("returns {items} mapped to id/url/title/rank/similarity/hasScreenshot only (minimal info)", async () => {
    mockedQueryRaw.mockResolvedValue([
      {
        id: SECTION_A,
        url: "https://a.example",
        title: "A",
        has_screenshot: true,
        distance: 0.1,
        mood_category: "premium",
      },
      {
        id: SECTION_B,
        url: "https://b.example",
        title: null,
        has_screenshot: false,
        distance: 0.4,
        mood_category: "tech",
      },
    ]);
    const result = await getSimilarDesigns(WEB_PAGE_ID, 6);
    expect(result).toEqual([
      {
        id: SECTION_A,
        url: "https://a.example",
        title: "A",
        rank: 1,
        similarity: 0.9,
        hasScreenshot: true,
      },
      {
        id: SECTION_B,
        url: "https://b.example",
        title: null,
        rank: 2,
        similarity: expect.closeTo(0.6, 5),
        hasScreenshot: false,
      },
    ]);
    // Minimal info: no html_snippet / embedding / attributes / mood_category leak into the response.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("embedding");
    expect(serialized).not.toContain("html_snippet");
    expect(serialized).not.toContain("mood_category");
  });

  it("L-07: clamps similarity to [0,1] and defends NaN/Infinity → 0", async () => {
    mockedQueryRaw.mockResolvedValue([
      { id: SECTION_A, url: "u1", title: null, has_screenshot: false, distance: -0.5 }, // 1-(-0.5)=1.5 → clamp 1
      { id: SECTION_B, url: "u2", title: null, has_screenshot: false, distance: 2.0 }, // 1-2=-1 → clamp 0
      {
        id: "0190b6f0-cccc-7abc-89ab-0123456789ab",
        url: "u3",
        title: null,
        has_screenshot: false,
        distance: NaN,
      }, // → 0
      {
        id: "0190b6f0-dddd-7abc-89ab-0123456789ab",
        url: "u4",
        title: null,
        has_screenshot: false,
        distance: Infinity,
      }, // → 0
    ]);
    const result = await getSimilarDesigns(WEB_PAGE_ID, 12);
    expect(result.map((r) => r.similarity)).toEqual([1, 0, 0, 0]);
  });

  it("L-06(a): source embedding NULL → SQL returns 0 rows → honest empty (not fake success)", async () => {
    mockedQueryRaw.mockResolvedValue([]);
    const result = await getSimilarDesigns(WEB_PAGE_ID, 6);
    expect(result).toEqual([]);
  });

  it("L-06(d): limit > candidate count returns only the available candidates", async () => {
    mockedQueryRaw.mockResolvedValue([
      { id: SECTION_A, url: "u", title: null, has_screenshot: false, distance: 0.1 },
    ]);
    const result = await getSimilarDesigns(WEB_PAGE_ID, 12);
    expect(result.length).toBe(1);
  });

  it("binds the source webPageId and limit as parameters ($1/$2), not interpolated", async () => {
    mockedQueryRaw.mockResolvedValue([]);
    await getSimilarDesigns(WEB_PAGE_ID, 6);
    const [sql, p1, p2] = mockedQueryRaw.mock.calls[0];
    expect(typeof sql).toBe("string");
    expect(sql).not.toContain(WEB_PAGE_ID); // id is NOT interpolated into the SQL string
    expect(p1).toBe(WEB_PAGE_ID);
    expect(p2).toBe(6);
  });
});

describe("INV-WEBUI-SIMILAR-RANK-001 — post-filter 1-origin distance rank (F2, M2)", () => {
  it("assigns a 1-origin rank in distance-ASC order over the returned list", async () => {
    mockedQueryRaw.mockResolvedValue([
      {
        id: SECTION_A,
        url: "https://a.example",
        title: "A",
        has_screenshot: true,
        distance: 0.1,
        mood_category: "premium",
      },
      {
        id: SECTION_B,
        url: "https://b.example",
        title: "B",
        has_screenshot: false,
        distance: 0.2,
        mood_category: "tech",
      },
      {
        id: "0190b6f0-cccc-7abc-89ab-0123456789ab",
        url: "https://c.example",
        title: "C",
        has_screenshot: false,
        distance: 0.3,
        mood_category: "minimalist",
      },
    ]);
    const result = await getSimilarDesigns(WEB_PAGE_ID, 6);
    // rank is 1-origin over the distance-ASC list (NOT 0-origin).
    expect(result.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(result[0].id).toBe(SECTION_A);
  });

  it("ranks the POST-filter array: a self row dropped by the JS self-filter does NOT leave a rank gap", async () => {
    // The DB self-exclusion is defense-in-depth-doubled by the JS .filter(row.id !== webPageId).
    // If the source row leaked into the rows, ranking must happen AFTER the filter so the survivors
    // are 1,2 (not 2,3 from a pre-filter ROW_NUMBER / 0-origin). This is the M2 mutation target.
    mockedQueryRaw.mockResolvedValue([
      {
        id: WEB_PAGE_ID, // self — dropped by the JS filter
        url: "https://self.example",
        title: "Self",
        has_screenshot: true,
        distance: 0,
        mood_category: "premium",
      },
      {
        id: SECTION_A,
        url: "https://a.example",
        title: "A",
        has_screenshot: true,
        distance: 0.1,
        mood_category: "tech",
      },
      {
        id: SECTION_B,
        url: "https://b.example",
        title: "B",
        has_screenshot: false,
        distance: 0.2,
        mood_category: "minimalist",
      },
    ]);
    const result = await getSimilarDesigns(WEB_PAGE_ID, 6);
    // Self is removed; the survivors are ranked 1,2 with NO gap (post-filter rank, 1-origin).
    expect(result.map((r) => r.id)).toEqual([SECTION_A, SECTION_B]);
    expect(result.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("public SimilarDesign shape does NOT expose mood_category (adapter-internal only)", async () => {
    mockedQueryRaw.mockResolvedValue([
      {
        id: SECTION_A,
        url: "https://a.example",
        title: "A",
        has_screenshot: true,
        distance: 0.1,
        mood_category: "premium",
      },
    ]);
    const result = await getSimilarDesigns(WEB_PAGE_ID, 6);
    // The public result keys must be exactly the SimilarDesign shape — mood_category/mood stays
    // adapter-internal (it is only SELECTed for the F4 MMR diversity proxy, never on the wire).
    expect(Object.keys(result[0]).sort()).toEqual(
      ["hasScreenshot", "id", "rank", "similarity", "title", "url"].sort()
    );
    expect((result[0] as Record<string, unknown>).mood_category).toBeUndefined();
    expect((result[0] as Record<string, unknown>).moodCategory).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("mood_category");
    expect(JSON.stringify(result)).not.toContain("premium");
  });

  it("SELECTs mood_category additively in the SQL (for the F4 MMR diversity proxy)", async () => {
    mockedQueryRaw.mockResolvedValue([]);
    await getSimilarDesigns(WEB_PAGE_ID, 6);
    const sql = String(mockedQueryRaw.mock.calls[0][0]);
    // mood_category is joined+selected so the adapter (getFeaturedComparison) can read it via the
    // internal SimilarDesignWithMood row, but it never reaches the public SimilarDesign.
    expect(sql).toContain("mood_category");
  });
});

describe("INV-WEBUI-HIGHPII-NEVER-IN-RESPONSE-001 — parts (UB-4)", () => {
  it("redacts high-PII part htmlSnippet/attributes/cssClasses, preserves the marker", async () => {
    mockedPartCount.mockResolvedValue(2);
    mockedPartFindMany.mockResolvedValue([
      {
        id: "part-high",
        partType: "form",
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
        piiRiskLevel: "high",
        htmlSnippet: '<input value="user@secret.example.com">',
        cssClasses: ["secret-field"],
        attributes: { value: "user@secret.example.com" },
      },
      {
        id: "part-none",
        partType: "button",
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
        piiRiskLevel: "none",
        htmlSnippet: "<button>Submit</button>",
        cssClasses: ["btn"],
        attributes: { type: "submit" },
      },
    ]);

    const result = await getPageParts(WEB_PAGE_ID, 0, 20);
    const high = result.items.find((p) => p.id === "part-high")!;
    const none = result.items.find((p) => p.id === "part-none")!;

    // NEGATIVE: high-PII content must never appear in the response.
    expect(high.htmlSnippet).toBeNull();
    expect(high.attributes).toBeNull();
    expect(high.cssClasses).toEqual([]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("user@secret.example.com");
    expect(serialized).not.toContain("secret-field");

    // POSITIVE: the pii_risk_level marker + non-PII content are preserved.
    expect(high.piiRiskLevel).toBe("high");
    expect(none.htmlSnippet).toBe("<button>Submit</button>");
    expect(none.cssClasses).toEqual(["btn"]);
  });

  it("passes a validated partType filter into the Prisma where clause", async () => {
    mockedPartCount.mockResolvedValue(0);
    mockedPartFindMany.mockResolvedValue([]);
    await getPageParts(WEB_PAGE_ID, 0, 20, "button");
    expect(mockedPartFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { webPageId: WEB_PAGE_ID, partType: "button" } })
    );
  });
});

describe("PartSummary.sectionPatternId — additive grouping field (W6 Issue A PR-1, L-TPA-02)", () => {
  it("exposes sectionPatternId on each part summary (selected + mapped, for section grouping)", async () => {
    mockedPartCount.mockResolvedValue(1);
    mockedPartFindMany.mockResolvedValue([
      {
        id: "part-1",
        partType: "button",
        sectionPatternId: SECTION_A,
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
        piiRiskLevel: "none",
        htmlSnippet: "<button>Go</button>",
        cssClasses: ["btn"],
        attributes: { type: "button" },
      },
    ]);

    const result = await getPageParts(WEB_PAGE_ID, 0, 20);
    expect(result.items[0].sectionPatternId).toBe(SECTION_A);

    // The grouping field must be SELECTed from the DB (Prisma select projects only listed cols).
    const findManyArg = mockedPartFindMany.mock.calls[0]?.[0] as {
      select?: Record<string, boolean>;
    };
    expect(findManyArg?.select?.sectionPatternId).toBe(true);
  });
});

describe("getSectionDetail — single-section read (W6 Issue A PR-1, section.inspect SSOT)", () => {
  it("returns null for a non-existent section_id (IDOR-shaped reject upstream)", async () => {
    mockedSectionFindUnique.mockResolvedValue(null);
    const result = await getSectionDetail(SECTION_A);
    expect(result).toBeNull();
  });

  it("returns metadata + htmlSnippet for a clean (non-high-PII) section", async () => {
    mockedSectionFindUnique.mockResolvedValue({
      id: SECTION_A,
      webPageId: WEB_PAGE_ID,
      sectionType: "hero",
      sectionName: "Hero",
      positionIndex: 0,
      layoutInfo: { position: { startY: 0, endY: 600, height: 600 } },
      htmlSnippet: "<section>clean</section>",
    });
    mockedPartFindMany.mockResolvedValue([]);

    const result = await getSectionDetail(SECTION_A);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(SECTION_A);
    expect(result!.webPageId).toBe(WEB_PAGE_ID);
    expect(result!.sectionType).toBe("hero");
    expect(result!.position).toEqual({ startY: 0, endY: 600, height: 600 });
    expect(result!.htmlSnippet).toBe("<section>clean</section>");
  });

  it("nulls htmlSnippet via the getHighPiiSectionIds SSOT when the section has a high-PII part", async () => {
    mockedSectionFindUnique.mockResolvedValue({
      id: SECTION_A,
      webPageId: WEB_PAGE_ID,
      sectionType: "team",
      sectionName: null,
      positionIndex: 4,
      layoutInfo: null,
      htmlSnippet: "<section><img alt='avatar'></section>",
    });
    mockedPartFindMany.mockResolvedValue([{ sectionPatternId: SECTION_A }]);

    const result = await getSectionDetail(SECTION_A);
    expect(result).not.toBeNull();
    expect(result!.htmlSnippet).toBeNull();
    // SSOT call shape: filter by piiRiskLevel='high' on this section id.
    const callArg = mockedPartFindMany.mock.calls[0]?.[0] as {
      where?: { sectionPatternId?: { in?: string[] }; piiRiskLevel?: string };
    };
    expect(callArg?.where?.piiRiskLevel).toBe("high");
    expect(callArg?.where?.sectionPatternId?.in).toContain(SECTION_A);
  });
});

describe("INV-WEBUI-HIGHPII-NEVER-IN-RESPONSE-001 — section-linked redaction (UB-4(b))", () => {
  it("nulls htmlSnippet of a section that contains a high-PII part, keeps a clean section", async () => {
    mockedSectionCount.mockResolvedValue(2);
    mockedSectionFindMany.mockResolvedValue([
      {
        id: SECTION_A,
        sectionType: "hero",
        sectionName: "Hero",
        positionIndex: 0,
        layoutInfo: { position: { top: 0 } },
        htmlSnippet: "<section>clean hero markup</section>",
      },
      {
        id: SECTION_B,
        sectionType: "contact",
        sectionName: "Contact",
        positionIndex: 1,
        layoutInfo: { position: { top: 800 } },
        htmlSnippet: '<section><input value="leak@secret.example.com"></section>',
      },
    ]);
    // SECTION_B contains a high-PII part → its snippet must be section-linked-redacted.
    mockedPartFindMany.mockResolvedValue([{ sectionPatternId: SECTION_B }]);

    const result = await getPageSections(WEB_PAGE_ID, 0, 20);
    const a = result.items.find((s) => s.id === SECTION_A)!;
    const b = result.items.find((s) => s.id === SECTION_B)!;

    expect(a.htmlSnippet).toBe("<section>clean hero markup</section>");
    expect(a.position).toEqual({ top: 0 });
    // NEGATIVE: the high-PII-containing section's snippet must be nulled.
    expect(b.htmlSnippet).toBeNull();
    expect(JSON.stringify(result)).not.toContain("leak@secret.example.com");
  });

  it("does not redact when no part is high-PII", async () => {
    mockedSectionCount.mockResolvedValue(1);
    mockedSectionFindMany.mockResolvedValue([
      {
        id: SECTION_A,
        sectionType: "feature",
        sectionName: null,
        positionIndex: 0,
        layoutInfo: {},
        htmlSnippet: "<section>visible</section>",
      },
    ]);
    mockedPartFindMany.mockResolvedValue([]); // no high-PII parts

    const result = await getPageSections(WEB_PAGE_ID, 0, 20);
    expect(result.items[0].htmlSnippet).toBe("<section>visible</section>");
    expect(result.items[0].position).toBeNull(); // missing layout_info.position → graceful null
  });
});

describe("INV-WEBUI-READONLY-NEGATIVE-001 — service is read-only (UB-6)", () => {
  it("page-detail.service.ts contains no Prisma write verbs (create/update/delete/upsert)", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "src", "api", "internal", "page-detail.service.ts"),
      "utf8"
    );
    const writeVerbRe =
      /prisma\.\w+\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/;
    expect(writeVerbRe.test(src)).toBe(false);
    // Only read verbs are used.
    expect(src).toMatch(/prisma\.\w+\.(findUnique|findFirst|findMany|count)\b/);
  });
});
