// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dashboard read-only service unit tests (WebUI v1 W1, DRY shared service).
 *
 * 共有 service は内部 read HTTP API から直接呼ばれる (tool 層を経由しない、UB-4 DRY 契約)。
 * The shared service is called directly by the internal read HTTP API (NOT via the tool
 * layer; UB-4 DRY contract). These tests verify the read-only query shapes against a
 * mocked Prisma client.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@reftrixmcp/database", () => ({
  prisma: {
    webPage: {
      count: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
    qualityEvaluation: {
      count: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
    designNarrative: {
      groupBy: vi.fn(),
      aggregate: vi.fn(),
    },
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock("../../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  isDevelopment: () => false,
}));

import { prisma } from "@reftrixmcp/database";
import {
  getDashboardStats,
  getRecentPages,
  getFeaturedComparison,
  buildQualityGradeDistribution,
  buildRealDomainPreferenceSql,
  RESERVED_SHOWCASE_URL_PATTERNS,
} from "../../../src/api/internal/dashboard.service";
import { scoreToGrade } from "../../../src/tools/quality/schemas";

const mockedPrisma = prisma as unknown as {
  webPage: {
    count: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  qualityEvaluation: {
    count: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  designNarrative: { groupBy: ReturnType<typeof vi.fn>; aggregate: ReturnType<typeof vi.fn> };
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
};

describe("getDashboardStats (read-only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aggregates real-shaped page / embedding / quality counts", async () => {
    mockedPrisma.webPage.count.mockResolvedValue(396);
    mockedPrisma.webPage.groupBy.mockResolvedValue([
      { embeddingBackfillStatus: "completed", _count: { _all: 379 } },
      { embeddingBackfillStatus: "not_required", _count: { _all: 13 } },
      { embeddingBackfillStatus: "failed", _count: { _all: 4 } },
    ]);
    mockedPrisma.qualityEvaluation.count.mockResolvedValue(391);
    mockedPrisma.qualityEvaluation.groupBy.mockResolvedValue([
      { grade: "A", _count: { _all: 217 } },
      { grade: "B", _count: { _all: 128 } },
      { grade: "C", _count: { _all: 43 } },
      { grade: "F", _count: { _all: 3 } },
    ]);
    mockedPrisma.designNarrative.groupBy.mockResolvedValue([
      { moodCategory: "professional", _count: { _all: 148 } },
      { moodCategory: "premium", _count: { _all: 176 } },
      { moodCategory: "playful", _count: { _all: 16 } },
    ]);
    mockedPrisma.designNarrative.aggregate.mockResolvedValue({
      _avg: { confidence: 0.7347 },
      _count: { _all: 383 },
    });

    const stats = await getDashboardStats();

    expect(stats.totalPages).toBe(396);
    expect(stats.qualityEvaluatedPages).toBe(391);
    // embedding status は enum 集計を map で返す
    expect(stats.embeddingStatus.completed).toBe(379);
    expect(stats.embeddingStatus.not_required).toBe(13);
    expect(stats.embeddingStatus.failed).toBe(4);
    // qualityEvaluation.count must filter target_type = 'web_page'
    expect(mockedPrisma.qualityEvaluation.count).toHaveBeenCalledWith({
      where: { targetType: "web_page" },
    });
    // W4/W5 M1: quality-grade distribution — all 5 grades A/B/C/D/F always present (D zero-filled).
    expect(stats.qualityGradeDistribution).toEqual({ A: 217, B: 128, C: 43, D: 0, F: 3 });
    // grade groupBy must filter target_type = 'web_page'
    expect(mockedPrisma.qualityEvaluation.groupBy).toHaveBeenCalledWith({
      by: ["grade"],
      where: { targetType: "web_page" },
      _count: { _all: true },
    });
    // W4: mood distribution sorted descending by count, raw enum strings preserved
    expect(stats.moodDistribution).toEqual([
      { mood: "premium", count: 176 },
      { mood: "professional", count: 148 },
      { mood: "playful", count: 16 },
    ]);
    // M3: mood average confidence is the _avg of design_narratives.confidence (a 参考値 caveat).
    expect(stats.moodAvgConfidence).toBeCloseTo(0.7347, 4);
  });

  it("zero-fills missing grades and returns honest empty mood distribution", async () => {
    mockedPrisma.webPage.count.mockResolvedValue(0);
    mockedPrisma.webPage.groupBy.mockResolvedValue([]);
    mockedPrisma.qualityEvaluation.count.mockResolvedValue(0);
    mockedPrisma.qualityEvaluation.groupBy.mockResolvedValue([]);
    mockedPrisma.designNarrative.groupBy.mockResolvedValue([]);
    mockedPrisma.designNarrative.aggregate.mockResolvedValue({
      _avg: { confidence: null },
      _count: { _all: 0 },
    });

    const stats = await getDashboardStats();

    // Fixed shape is always present, zero-filled (stable dashboard contract; M1 = 5 grades incl. D).
    expect(stats.qualityGradeDistribution).toEqual({ A: 0, B: 0, C: 0, D: 0, F: 0 });
    // Honest empty mood distribution (NOT a fabricated entry).
    expect(stats.moodDistribution).toEqual([]);
    // M3: zero narratives → moodAvgConfidence is honest null (NEVER a fabricated 0).
    expect(stats.moodAvgConfidence).toBeNull();
  });

  it("never performs a write (no create/update/delete on prisma)", async () => {
    mockedPrisma.webPage.count.mockResolvedValue(0);
    mockedPrisma.webPage.groupBy.mockResolvedValue([]);
    mockedPrisma.qualityEvaluation.count.mockResolvedValue(0);
    mockedPrisma.qualityEvaluation.groupBy.mockResolvedValue([]);
    mockedPrisma.designNarrative.groupBy.mockResolvedValue([]);
    mockedPrisma.designNarrative.aggregate.mockResolvedValue({
      _avg: { confidence: null },
      _count: { _all: 0 },
    });

    await getDashboardStats();

    // mocked prisma deliberately has no create/update/delete — assert the service
    // never reached for them (read-only contract).
    expect((mockedPrisma.webPage as Record<string, unknown>).create).toBeUndefined();
    expect((mockedPrisma.webPage as Record<string, unknown>).update).toBeUndefined();
    expect((mockedPrisma.webPage as Record<string, unknown>).delete).toBeUndefined();
  });
});

describe("INV-WEBUI-MOOD-CONFIDENCE-001 — moodAvgConfidence honest null (F3, M3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Minimal stubs for the other parallel aggregates so getDashboardStats resolves.
    mockedPrisma.webPage.count.mockResolvedValue(0);
    mockedPrisma.webPage.groupBy.mockResolvedValue([]);
    mockedPrisma.qualityEvaluation.count.mockResolvedValue(0);
    mockedPrisma.qualityEvaluation.groupBy.mockResolvedValue([]);
    mockedPrisma.designNarrative.groupBy.mockResolvedValue([]);
  });

  it("returns the _avg of design_narratives.confidence when narratives exist", async () => {
    mockedPrisma.designNarrative.aggregate.mockResolvedValue({
      _avg: { confidence: 0.6451 },
      _count: { _all: 12 },
    });
    const stats = await getDashboardStats();
    expect(stats.moodAvgConfidence).toBeCloseTo(0.6451, 4);
    // The aggregate is a single _avg query (no N+1).
    expect(mockedPrisma.designNarrative.aggregate).toHaveBeenCalledTimes(1);
    const arg = mockedPrisma.designNarrative.aggregate.mock.calls[0][0];
    expect(arg._avg).toEqual({ confidence: true });
  });

  it("M3 mutation target: zero narratives → null, NEVER a fabricated 0", async () => {
    // _count 0 means no narratives; the honest answer is null (未評価), not 0.0.
    mockedPrisma.designNarrative.aggregate.mockResolvedValue({
      _avg: { confidence: null },
      _count: { _all: 0 },
    });
    const stats = await getDashboardStats();
    expect(stats.moodAvgConfidence).toBeNull();
    expect(stats.moodAvgConfidence).not.toBe(0);
  });

  it("defends a non-finite / out-of-range _avg (NaN/Infinity) → null (vector-data discipline)", async () => {
    mockedPrisma.designNarrative.aggregate.mockResolvedValue({
      _avg: { confidence: Number.NaN },
      _count: { _all: 5 },
    });
    const stats = await getDashboardStats();
    expect(stats.moodAvgConfidence).toBeNull();
  });

  it("clamps a confidence into [0,1] (honest bound; a stale >1 average never leaks)", async () => {
    mockedPrisma.designNarrative.aggregate.mockResolvedValue({
      _avg: { confidence: 1.5 },
      _count: { _all: 5 },
    });
    const stats = await getDashboardStats();
    expect(stats.moodAvgConfidence).toBe(1);
  });
});

describe("buildQualityGradeDistribution (pure helper, UB-7, M1 5-grade)", () => {
  it("M1: zero-fills ALL 5 scorer grades A/B/C/D/F (a score-60-69 D page is counted, not dropped)", () => {
    const dist = buildQualityGradeDistribution([
      { grade: "A", _count: { _all: 5 } },
      { grade: "D", _count: { _all: 2 } },
    ]);
    expect(dist.A).toBe(5);
    expect(dist.B).toBe(0);
    expect(dist.C).toBe(0);
    // M1 mutation target: dropping the D bucket (back to A/B/C/F-only zero-fill) makes a real
    // D-grade page (score 60-69) uncounted. The fixed D key MUST be present and zero-filled.
    expect(dist.D).toBe(2);
    expect(dist.F).toBe(0);
  });

  it("M1: the fixed shape matches the scorer SSOT (scoreToGrade), zero-filled for every grade", () => {
    const dist = buildQualityGradeDistribution([]);
    // Derive the expected grade set from the scorer SSOT so this pin cannot silently drift away
    // from the boundaries in quality/schemas.ts (A≥90/B80-89/C70-79/D60-69/F<60).
    const scorerGrades = new Set([95, 85, 75, 65, 50].map((score) => scoreToGrade(score)));
    expect(scorerGrades).toEqual(new Set(["A", "B", "C", "D", "F"]));
    expect(new Set(Object.keys(dist))).toEqual(scorerGrades);
    expect(dist).toEqual({ A: 0, B: 0, C: 0, D: 0, F: 0 });
  });

  it("folds in an unexpected grade not in the fixed set rather than dropping it (honest)", () => {
    const dist = buildQualityGradeDistribution([{ grade: "Z", _count: { _all: 1 } }]);
    expect((dist as Record<string, number>).Z).toBe(1);
  });
});

describe("getRecentPages (read-only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("orders by crawledAt desc, respects the bounded limit, and selects intelligence relations", async () => {
    mockedPrisma.webPage.findMany.mockResolvedValue([
      {
        id: "11111111-1111-7111-8111-111111111111",
        url: "https://example.com",
        title: "Example",
        sourceType: "user_provided",
        analysisStatus: "completed",
        screenshotStoragePath: "/x/phase5/abc.png",
        crawledAt: new Date("2026-06-01T00:00:00Z"),
        designNarrative: { moodCategory: "premium" },
        _count: { sectionPatterns: 7, componentParts: 42, motionPatterns: 5 },
      },
    ]);
    mockedPrisma.qualityEvaluation.findMany.mockResolvedValue([
      {
        targetId: "11111111-1111-7111-8111-111111111111",
        overallScore: 88,
        grade: "A",
      },
    ]);

    const pages = await getRecentPages(5);

    expect(pages).toHaveLength(1);
    expect(pages[0].url).toBe("https://example.com");
    // hasScreenshot derived from screenshotStoragePath presence (boolean, not raw path)
    expect(pages[0].hasScreenshot).toBe(true);
    // W4 per-page intelligence
    expect(pages[0].qualityScore).toBe(88);
    expect(pages[0].qualityGrade).toBe("A");
    expect(pages[0].moodCategory).toBe("premium");
    expect(pages[0].sectionCount).toBe(7);
    expect(pages[0].partCount).toBe(42);
    expect(pages[0].motionCount).toBe(5);

    const call = mockedPrisma.webPage.findMany.mock.calls[0][0];
    expect(call.take).toBe(5);
    expect(call.orderBy).toEqual({ crawledAt: "desc" });
    // relation _count for counts (no per-page count query → no N+1)
    expect(call.select._count.select).toEqual({
      sectionPatterns: true,
      componentParts: true,
      motionPatterns: true,
    });
    // mood selected via the 1:1 designNarrative relation (enum value only)
    expect(call.select.designNarrative).toEqual({ select: { moodCategory: true } });
    // quality batched for ALL page ids in ONE query (no N+1)
    expect(mockedPrisma.qualityEvaluation.findMany).toHaveBeenCalledWith({
      where: {
        targetType: "web_page",
        targetId: { in: ["11111111-1111-7111-8111-111111111111"] },
      },
      orderBy: { createdAt: "desc" },
      select: { targetId: true, overallScore: true, grade: true },
    });
  });

  it("returns honest null intelligence when a page has no quality eval / narrative", async () => {
    mockedPrisma.webPage.findMany.mockResolvedValue([
      {
        id: "22222222-2222-7222-8222-222222222222",
        url: "https://no-intel.example",
        title: null,
        sourceType: "user_provided",
        analysisStatus: "pending",
        screenshotStoragePath: null,
        crawledAt: new Date("2026-06-02T00:00:00Z"),
        designNarrative: null, // no narrative
        _count: { sectionPatterns: 0, componentParts: 0, motionPatterns: 0 },
      },
    ]);
    mockedPrisma.qualityEvaluation.findMany.mockResolvedValue([]); // no quality eval

    const pages = await getRecentPages(5);

    expect(pages[0].hasScreenshot).toBe(false);
    // Honest N/A — NOT a fabricated 0 score / mood
    expect(pages[0].qualityScore).toBeNull();
    expect(pages[0].qualityGrade).toBeNull();
    expect(pages[0].moodCategory).toBeNull();
    expect(pages[0].sectionCount).toBe(0);
    expect(pages[0].partCount).toBe(0);
    expect(pages[0].motionCount).toBe(0);
  });

  it("keeps only the latest quality row per page (newest-first reduction, N+1-free)", async () => {
    mockedPrisma.webPage.findMany.mockResolvedValue([
      {
        id: "33333333-3333-7333-8333-333333333333",
        url: "https://multi-eval.example",
        title: "Multi",
        sourceType: "user_provided",
        analysisStatus: "completed",
        screenshotStoragePath: null,
        crawledAt: new Date("2026-06-03T00:00:00Z"),
        designNarrative: { moodCategory: "tech" },
        _count: { sectionPatterns: 3, componentParts: 9, motionPatterns: 1 },
      },
    ]);
    // Two evaluations for the same page; the service must keep the first (newest) one.
    mockedPrisma.qualityEvaluation.findMany.mockResolvedValue([
      { targetId: "33333333-3333-7333-8333-333333333333", overallScore: 90, grade: "A" },
      { targetId: "33333333-3333-7333-8333-333333333333", overallScore: 50, grade: "C" },
    ]);

    const pages = await getRecentPages(5);

    expect(pages[0].qualityScore).toBe(90);
    expect(pages[0].qualityGrade).toBe("A");
  });
});

const SEED_ID = "44444444-4444-7444-8444-444444444444";
const NEIGHBOR_ID = "55555555-5555-7555-8555-555555555555";

describe("getFeaturedComparison (read-only, zero ML)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-picks a deterministic seed and returns its pgvector neighbors", async () => {
    // 1st $queryRawUnsafe call = seed pick; 2nd = getSimilarDesigns KNN (page-detail.service).
    mockedPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([
        { id: SEED_ID, url: "https://seed.example", title: "Seed", has_screenshot: true },
      ])
      .mockResolvedValueOnce([
        {
          id: NEIGHBOR_ID,
          url: "https://neighbor.example",
          title: "Neighbor",
          has_screenshot: false,
          distance: 0.2,
          mood_category: "premium",
        },
      ]);

    const result = await getFeaturedComparison(undefined, 6);

    expect(result.seed).toEqual({
      id: SEED_ID,
      url: "https://seed.example",
      title: "Seed",
      hasScreenshot: true,
    });
    expect(result.similar).toHaveLength(1);
    expect(result.similar[0].id).toBe(NEIGHBOR_ID);
    // similarity = 1 - distance, clamped [0,1]
    expect(result.similar[0].similarity).toBeCloseTo(0.8, 5);
    // F4: the featured neighbor list is re-ranked on the diversified (MMR) display order (1-origin).
    expect(result.similar[0].rank).toBe(1);
    // The public neighbor shape stays SimilarDesign — no mood_category leaks onto the wire.
    expect((result.similar[0] as Record<string, unknown>).mood_category).toBeUndefined();
    // auto-pick passed $1 = null (no explicit seed)
    expect(mockedPrisma.$queryRawUnsafe.mock.calls[0][1]).toBeNull();
    // W5 M6: the auto-pick seed SQL is now quality-first, then screenshot-bearing, then real domain
    // (RFC 2606 reserved de-prioritized), then smallest id (deterministic tie-break).
    const seedSql = String(mockedPrisma.$queryRawUnsafe.mock.calls[0][0]);
    const normalizedSeedSql = seedSql.replace(/\s+/g, " ");
    const orderByIdx = normalizedSeedSql.indexOf("ORDER BY");
    const qualityIdx = normalizedSeedSql.indexOf("COALESCE(qe.overall_score, -1) DESC");
    const realDomainIdx = normalizedSeedSql.indexOf(
      `${buildRealDomainPreferenceSql("wp.url")} DESC`
    );
    const screenshotIdx = normalizedSeedSql.indexOf(
      "(wp.screenshot_storage_path IS NOT NULL) DESC"
    );
    const idTieBreakIdx = normalizedSeedSql.indexOf("wp.id ASC");
    // Pin 1: quality (latest overall_score) is the FIRST ORDER BY key (the "注目" is earned).
    expect(qualityIdx).toBeGreaterThan(orderByIdx);
    expect(qualityIdx).toBeLessThan(screenshotIdx);
    // Pin 2: screenshot preference precedes the real-domain preference.
    expect(screenshotIdx).toBeLessThan(realDomainIdx);
    // Pin 3: real-domain preference precedes the deterministic smallest-id tie-break.
    expect(realDomainIdx).toBeLessThan(idTieBreakIdx);
    // EXISTS embedding filter is unchanged (candidate set is still embedding-bearing pages only)
    expect(normalizedSeedSql).toContain("dne.embedding IS NOT NULL");
    // The reserved patterns are the fixed RFC 2606 SSOT (example.com/.net/.org), no user input.
    expect(RESERVED_SHOWCASE_URL_PATTERNS).toEqual([
      "%example.com%",
      "%example.net%",
      "%example.org%",
    ]);
  });

  it("prefers a screenshot-bearing embedding seed over a screenshot-less one (real hero, not placeholder)", async () => {
    // Real-shape: with the screenshot-preference ORDER BY, the DB returns the screenshot-bearing row
    // first even though a screenshot-less embedding page has a smaller id. This pins the W5 fix:
    // the seed surfaced to the dashboard hero has_screenshot=true. A revert to `ORDER BY wp.id ASC`
    // would surface the screenshot-less row → this test goes RED.
    const SCREENSHOTLESS_SMALLER_ID = "11111111-1111-7111-8111-111111111111";
    const SCREENSHOT_BEARING_ID = "99999999-9999-7999-8999-999999999999";
    mockedPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: SCREENSHOT_BEARING_ID,
          url: "https://has-screenshot.example",
          title: "Has Screenshot",
          has_screenshot: true,
        },
      ])
      .mockResolvedValueOnce([]); // neighbors not relevant to this pin

    const result = await getFeaturedComparison(undefined, 6);

    // The surfaced seed is the screenshot-bearing page (strong hero), not the smaller-id one.
    expect(result.seed?.id).toBe(SCREENSHOT_BEARING_ID);
    expect(result.seed?.hasScreenshot).toBe(true);
    expect(result.seed?.id).not.toBe(SCREENSHOTLESS_SMALLER_ID);
    // The screenshot-preference key must be present in the seed SQL (source-pin), ordered AFTER the
    // reserved-domain de-prioritization and BEFORE the smallest-id tie-break.
    const seedSql = String(mockedPrisma.$queryRawUnsafe.mock.calls[0][0]).replace(/\s+/g, " ");
    const screenshotIdx = seedSql.indexOf("(wp.screenshot_storage_path IS NOT NULL) DESC");
    expect(screenshotIdx).toBeGreaterThan(seedSql.indexOf("ORDER BY"));
    expect(screenshotIdx).toBeLessThan(seedSql.indexOf("wp.id ASC"));
  });

  it("de-prioritizes an RFC 2606 reserved-domain (example.com) seed in favour of a real domain", async () => {
    // Real-shape: the seed SQL ORDER BY pushes example.com (a documentation placeholder, e.g. the
    // IANA "Example Domain" page) to the BACK, so the DB returns the real-domain row first even when
    // both are screenshot-bearing embedding pages. This pins the W5 follow-up: a real site (den.cool-
    // shaped) is surfaced as the hero, not the placeholder. Removing the reserved-domain ORDER BY key
    // (so example.com sorts purely by screenshot/id) would let the placeholder win → this test RED.
    const RESERVED_ID = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
    const REAL_DOMAIN_ID = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
    // The DB applies `ORDER BY <real-domain> DESC, ...`, so den.cool (real) sorts ahead of
    // example.com (reserved); the mock returns the row the real SQL would return first.
    mockedPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: REAL_DOMAIN_ID,
          url: "https://den.cool",
          title: "den.cool",
          has_screenshot: true,
        },
      ])
      .mockResolvedValueOnce([]); // neighbors not relevant to this pin

    const result = await getFeaturedComparison(undefined, 6);

    // The surfaced seed is the real domain, NOT the reserved example.com placeholder.
    expect(result.seed?.url).toBe("https://den.cool");
    expect(result.seed?.id).toBe(REAL_DOMAIN_ID);
    expect(result.seed?.id).not.toBe(RESERVED_ID);
    // Source-pin: the reserved-domain de-prioritization clause (SSOT-derived) is the FIRST ORDER BY
    // key. Each reserved pattern (RFC 2606) appears as a NOT ILIKE literal. Removing the clause → RED.
    const seedSql = String(mockedPrisma.$queryRawUnsafe.mock.calls[0][0]).replace(/\s+/g, " ");
    const realDomainClause = `${buildRealDomainPreferenceSql("wp.url")} DESC`;
    expect(seedSql).toContain(realDomainClause);
    for (const pattern of RESERVED_SHOWCASE_URL_PATTERNS) {
      expect(seedSql).toContain(`wp.url NOT ILIKE '${pattern}'`);
    }
    // W5 M6: the reserved-domain key is still a soft ORDER BY preference, now placed AFTER the
    // quality-first + screenshot keys but BEFORE the smallest-id tie-break (real domain still wins a
    // tie vs a reserved domain at equal quality + screenshot presence).
    const realDomainIdx = seedSql.indexOf(realDomainClause);
    expect(realDomainIdx).toBeGreaterThan(
      seedSql.indexOf("(wp.screenshot_storage_path IS NOT NULL) DESC")
    );
    expect(realDomainIdx).toBeLessThan(seedSql.indexOf("wp.id ASC"));
  });

  it("honest empty when no embedding-bearing page exists (seed query returns 0 rows)", async () => {
    mockedPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // no seed

    const result = await getFeaturedComparison(undefined, 6);

    // Honest empty — NOT a fabricated comparison.
    expect(result.seed).toBeNull();
    expect(result.similar).toEqual([]);
    // getSimilarDesigns must NOT have been reached (only the seed query ran).
    expect(mockedPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it("passes an explicit seed id through as the SQL $1 bind", async () => {
    mockedPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([
        { id: SEED_ID, url: "https://seed.example", title: "Seed", has_screenshot: false },
      ])
      .mockResolvedValueOnce([]); // seed has no neighbors → honest empty similar

    const result = await getFeaturedComparison(SEED_ID, 6);

    expect(result.seed?.id).toBe(SEED_ID);
    expect(result.similar).toEqual([]); // honest empty, seed still echoed
    expect(mockedPrisma.$queryRawUnsafe.mock.calls[0][1]).toBe(SEED_ID);
    // Explicit seed: the WHERE narrows to `wp.id = $1::uuid` (a single row), so the ENTIRE ORDER BY
    // (reserved-domain de-prioritization + screenshot preference) is a no-op — explicit-seed
    // behaviour is unchanged by the W5 fixes.
    const seedSql = String(mockedPrisma.$queryRawUnsafe.mock.calls[0][0]).replace(/\s+/g, " ");
    expect(seedSql).toContain("$1::uuid IS NOT NULL AND wp.id = $1::uuid");
  });

  it("M7: over-fetches the neighbor pool (limit*OVERFETCH_FACTOR) clamped to MAX_FEATURED_OVERFETCH, then MMR re-ranks", async () => {
    // 1st call = seed pick. 2nd call = getSimilarDesigns KNN with the over-fetched LIMIT ($2).
    // A mono-mood top-N with a diverse tail proves MMR reorders + re-ranks the display order.
    mockedPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([
        { id: SEED_ID, url: "https://seed.example", title: "Seed", has_screenshot: true },
      ])
      .mockResolvedValueOnce([
        {
          id: "10000000-0000-7000-8000-000000000001",
          url: "https://p1.example",
          title: "p1",
          has_screenshot: true,
          distance: 0.02,
          mood_category: "premium",
        },
        {
          id: "10000000-0000-7000-8000-000000000002",
          url: "https://p2.example",
          title: "p2",
          has_screenshot: true,
          distance: 0.03,
          mood_category: "premium",
        },
        {
          id: "10000000-0000-7000-8000-000000000003",
          url: "https://t1.example",
          title: "t1",
          has_screenshot: true,
          distance: 0.1,
          mood_category: "tech",
        },
      ]);

    const result = await getFeaturedComparison(undefined, 2);

    // M7: the over-fetch LIMIT bound to getSimilarDesigns ($2) = limit(2) * OVERFETCH_FACTOR(3) = 6,
    // which is ≤ MAX_FEATURED_OVERFETCH (36) — a finite cap, NEVER NaN/undefined.
    const knnLimitArg = mockedPrisma.$queryRawUnsafe.mock.calls[1][2];
    expect(knnLimitArg).toBe(6);
    expect(Number.isFinite(knnLimitArg)).toBe(true);
    // Only `limit` neighbors are returned (MMR trims the over-fetched pool back to N=2).
    expect(result.similar).toHaveLength(2);
    // F4: rank is re-assigned 1..N on the DIVERSIFIED display order (overwrite).
    expect(result.similar.map((s) => s.rank)).toEqual([1, 2]);
    // The first pick is the most relevant; the second is diversified (a non-premium pulled up).
    expect(result.similar[0].id).toBe("10000000-0000-7000-8000-000000000001");
    const moods = result.similar.map((s) => (s as Record<string, unknown>).mood_category);
    expect(moods).toEqual([undefined, undefined]); // mood never leaks to the public shape
  });

  it("honors an explicit reserved-domain (example.com) seed — soft preference is NOT a hard filter", async () => {
    // An explicit seedWebPageId pointing at a reserved example.com page is STILL echoed: the WHERE
    // narrows to that single row, so the reserved-domain de-prioritization (which is only an ORDER BY
    // soft preference, never a WHERE exclusion) cannot drop it. This pins the "soft, not hard" contract.
    const EXAMPLE_SEED_ID = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
    mockedPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: EXAMPLE_SEED_ID,
          url: "https://example.com",
          title: "Example Domain",
          has_screenshot: true,
        },
      ])
      .mockResolvedValueOnce([]);

    const result = await getFeaturedComparison(EXAMPLE_SEED_ID, 6);

    // Reserved domain explicitly requested → honored (echoed), NOT excluded.
    expect(result.seed?.id).toBe(EXAMPLE_SEED_ID);
    expect(result.seed?.url).toBe("https://example.com");
    expect(mockedPrisma.$queryRawUnsafe.mock.calls[0][1]).toBe(EXAMPLE_SEED_ID);
    // The de-prioritization lives ONLY in the ORDER BY (soft), never in the WHERE (no hard exclusion).
    const seedSql = String(mockedPrisma.$queryRawUnsafe.mock.calls[0][0]).replace(/\s+/g, " ");
    const whereClause = seedSql.slice(seedSql.indexOf("WHERE"), seedSql.indexOf("ORDER BY"));
    expect(whereClause).not.toContain("NOT ILIKE");
  });
});

describe("INV-WEBUI-FEATURED-SEED-QUALITY-FIRST-001 — quality-first seed ORDER BY (F4, M6 + L5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("quality (latest overall_score) is the FIRST ORDER BY key, before screenshot/real-domain/id", async () => {
    mockedPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([
        { id: SEED_ID, url: "https://seed.example", title: "Seed", has_screenshot: true },
      ])
      .mockResolvedValueOnce([]);

    await getFeaturedComparison(undefined, 6);

    const seedSql = String(mockedPrisma.$queryRawUnsafe.mock.calls[0][0]).replace(/\s+/g, " ");
    const orderByIdx = seedSql.indexOf("ORDER BY");
    const qualityIdx = seedSql.indexOf("COALESCE(qe.overall_score, -1) DESC");
    const screenshotIdx = seedSql.indexOf("(wp.screenshot_storage_path IS NOT NULL) DESC");
    const realDomainIdx = seedSql.indexOf(`${buildRealDomainPreferenceSql("wp.url")} DESC`);
    const idTieBreakIdx = seedSql.indexOf("wp.id ASC");
    // M6 mutation target: removing overall_score from the ORDER BY makes qualityIdx = -1 → RED.
    expect(qualityIdx).toBeGreaterThan(orderByIdx);
    // Quality leads every other key (the "注目" is earned by quality, not by id/screenshot/domain).
    expect(qualityIdx).toBeLessThan(screenshotIdx);
    expect(qualityIdx).toBeLessThan(realDomainIdx);
    expect(qualityIdx).toBeLessThan(idTieBreakIdx);
    // The latest-quality LATERAL join is present (correlated to wp.id, newest first, LIMIT 1).
    expect(seedSql).toContain("LEFT JOIN LATERAL");
    expect(seedSql).toContain("quality_evaluations qe2");
    expect(seedSql).toContain("qe2.target_type = 'web_page'");
    expect(seedSql).toContain("qe2.target_id = wp.id");
    expect(seedSql).toContain("ORDER BY qe2.created_at DESC");
  });

  it("L5 (hard): the seed SQL has NO ${} interpolation other than realDomainPreferenceSql, and $queryRawUnsafe gets exactly ONE bound arg", async () => {
    mockedPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([
        { id: SEED_ID, url: "https://seed.example", title: "Seed", has_screenshot: true },
      ])
      .mockResolvedValueOnce([]);

    await getFeaturedComparison(undefined, 6);

    const [rawSql, ...boundArgs] = mockedPrisma.$queryRawUnsafe.mock.calls[0];
    const seedSql = String(rawSql);
    // L5: exactly one bound arg (the seed UUID-or-null) reaches $queryRawUnsafe (no user-string SQL).
    expect(boundArgs).toHaveLength(1);
    // L5: the ONLY interpolated fragment is the fixed SSOT realDomainPreferenceSql; everything else
    // is a static literal. We assert the assembled clause is present, and that no raw user value
    // (a UUID-shaped or quote-bearing token from input) is interpolated. The seed binds via $1.
    expect(seedSql).toContain(buildRealDomainPreferenceSql("wp.url"));
    // No literal template marker survives into the emitted SQL (all `${...}` are resolved at build).
    expect(seedSql).not.toContain("${");
    // The seed value is bound, never interpolated: $1 placeholder present, raw UUID absent from SQL.
    expect(seedSql).toContain("$1::uuid");
    expect(seedSql).not.toContain(SEED_ID);
  });
});

describe("INV-WEBUI-FEATURED-SEED-EXPLICIT-NOOP-001 — explicit ?seed= narrows WHERE to one row (F4, M6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("explicit seed → WHERE narrows to wp.id = $1, making the quality-first ORDER BY inert (no-op preserved)", async () => {
    mockedPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([
        { id: SEED_ID, url: "https://seed.example", title: "Seed", has_screenshot: false },
      ])
      .mockResolvedValueOnce([]);

    const result = await getFeaturedComparison(SEED_ID, 6);

    expect(result.seed?.id).toBe(SEED_ID);
    expect(mockedPrisma.$queryRawUnsafe.mock.calls[0][1]).toBe(SEED_ID);
    const seedSql = String(mockedPrisma.$queryRawUnsafe.mock.calls[0][0]).replace(/\s+/g, " ");
    // The explicit-seed WHERE branch narrows to a single row; the quality-first ORDER BY (and all
    // other soft keys) become a no-op for that single row. Removing this branch → RED.
    expect(seedSql).toContain("$1::uuid IS NOT NULL AND wp.id = $1::uuid");
    // No hard quality filter leaks into the WHERE (quality is ORDER-BY-only; explicit seed is honored
    // even with no/low quality — soft preference, not a hard exclusion).
    const whereClause = seedSql.slice(seedSql.indexOf("WHERE"), seedSql.indexOf("ORDER BY"));
    expect(whereClause).not.toContain("overall_score");
  });
});

describe("buildRealDomainPreferenceSql (pure helper, SSOT-derived)", () => {
  it("assembles a NOT ILIKE conjunction over every RFC 2606 reserved pattern (injection-free)", () => {
    const clause = buildRealDomainPreferenceSql("wp.url");
    // One AND-joined NOT ILIKE per SSOT pattern, parenthesized as a single boolean.
    expect(clause).toBe(
      "(wp.url NOT ILIKE '%example.com%' AND wp.url NOT ILIKE '%example.net%' AND wp.url NOT ILIKE '%example.org%')"
    );
    // Derives from the SSOT — drift in either side goes RED (no magic literal duplication).
    for (const pattern of RESERVED_SHOWCASE_URL_PATTERNS) {
      expect(clause).toContain(`wp.url NOT ILIKE '${pattern}'`);
    }
  });

  it("respects a custom column reference (no hard-coded table alias)", () => {
    expect(buildRealDomainPreferenceSql("p.url")).toContain("p.url NOT ILIKE '%example.com%'");
  });
});
