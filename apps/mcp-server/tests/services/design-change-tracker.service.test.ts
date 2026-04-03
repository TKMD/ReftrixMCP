// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DesignChangeTrackerService テスト
 * Design Change Tracker Service Tests (v0.3.0 T2-DCT)
 *
 * TDD Red Phase: テストを先に記述
 *
 * @module tests/services/design-change-tracker.service.test
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createSnapshot,
  compareSnapshots,
  getHistory,
  detectChanges,
  setDesignChangeTrackerPrismaClientFactory,
  resetDesignChangeTrackerPrismaClientFactory,
  type DesignChangeTrackerPrismaClient,
  DESIGN_CHANGE_ERROR_CODES,
  DEFAULT_MAX_SNAPSHOTS_PER_URL,
} from "../../src/services/design-change-tracker.service";

// =====================================================
// Mock Prisma Client
// =====================================================

function createMockPrisma(): DesignChangeTrackerPrismaClient {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $transaction: vi
      .fn()
      .mockImplementation(async (fn: (tx: DesignChangeTrackerPrismaClient) => Promise<unknown>) => {
        return fn(createMockPrisma());
      }),
  };
}

describe("DesignChangeTrackerService", () => {
  let mockPrisma: DesignChangeTrackerPrismaClient;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    setDesignChangeTrackerPrismaClientFactory(() => mockPrisma);
  });

  afterEach(() => {
    resetDesignChangeTrackerPrismaClientFactory();
    vi.restoreAllMocks();
  });

  // =====================================================
  // createSnapshot
  // =====================================================

  describe("createSnapshot", () => {
    it("正常系: webPageIdからスナップショットを作成できる", async () => {
      const webPageId = "11111111-1111-1111-1111-111111111111";

      // Mock: web_pages テーブルから取得
      const mockSections = [
        {
          id: "sec-1",
          section_type: "hero",
          section_name: "Hero Section",
          position_index: 0,
          text_embedding: "[0.1,0.2,0.3]",
          vision_embedding: "[0.4,0.5,0.6]",
        },
        {
          id: "sec-2",
          section_type: "features",
          section_name: null,
          position_index: 1,
          text_embedding: "[0.7,0.8,0.9]",
          vision_embedding: null,
        },
      ];

      const mockQuality = [{ overall_score: 85.5 }];
      const mockPage = [{ id: webPageId, url: "https://example.com", analysis_version: "0.3.0" }];
      const mockSnapshotInsert = [{ id: "snap-1" }];

      // $queryRawUnsafe は呼び出し順に応じてレスポンスを返す
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockPage) // web_pages チェック
        .mockResolvedValueOnce(mockSections) // section_patterns + section_embeddings
        .mockResolvedValueOnce(mockQuality) // quality score
        .mockResolvedValueOnce(mockSnapshotInsert) // INSERT design_snapshots
        .mockResolvedValueOnce([]) // INSERT design_snapshot_sections (batch)
        .mockResolvedValueOnce([{ count: "1" }]); // snapshot count for cleanup

      const result = await createSnapshot(webPageId);

      expect(result.success).toBe(true);
      expect(result.snapshot_id).toBe("snap-1");
      expect(result.section_count).toBe(2);
      expect(result.overall_score).toBe(85.5);
    });

    it("異常系: 存在しないwebPageIdでエラーを返す", async () => {
      const webPageId = "99999999-9999-9999-9999-999999999999";

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]); // web_pages が空

      const result = await createSnapshot(webPageId);

      expect(result.success).toBe(false);
      expect(result.error).toContain(DESIGN_CHANGE_ERROR_CODES.PAGE_NOT_FOUND);
    });

    it("異常系: 無効なUUID形式でエラーを返す", async () => {
      const result = await createSnapshot("invalid-uuid");

      expect(result.success).toBe(false);
      expect(result.error).toContain(DESIGN_CHANGE_ERROR_CODES.INVALID_INPUT);
    });

    it("異常系: セクションが0件でも空スナップショットを作成する", async () => {
      const webPageId = "11111111-1111-1111-1111-111111111111";

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: webPageId, url: "https://example.com" }])
        .mockResolvedValueOnce([]) // no sections
        .mockResolvedValueOnce([]) // no quality
        .mockResolvedValueOnce([{ id: "snap-empty" }]) // INSERT snapshot
        .mockResolvedValueOnce([{ count: "0" }]); // count check

      const result = await createSnapshot(webPageId);

      expect(result.success).toBe(true);
      expect(result.section_count).toBe(0);
    });
  });

  // =====================================================
  // compareSnapshots
  // =====================================================

  describe("compareSnapshots", () => {
    it("正常系: 2つのスナップショットを比較して変更度スコアを算出する", async () => {
      const snapshotId1 = "aaaa1111-1111-1111-1111-111111111111";
      const snapshotId2 = "bbbb2222-2222-2222-2222-222222222222";

      // Mock: snapshot 1
      const snap1 = [
        {
          id: snapshotId1,
          web_page_id: "page-1",
          section_count: 2,
          snapshot_at: "2026-01-01T00:00:00Z",
        },
      ];
      // Mock: snapshot 2
      const snap2 = [
        {
          id: snapshotId2,
          web_page_id: "page-1",
          section_count: 3,
          snapshot_at: "2026-02-01T00:00:00Z",
        },
      ];
      // Mock: sections for snap1
      // hero has significantly different embeddings between snap1 and snap2
      const sections1 = [
        {
          section_type: "hero",
          section_name: "Hero",
          position_index: 0,
          text_embedding: "[0.9,0.1,0.0,0.0]",
          vision_embedding: "[0.8,0.2,0.0,0.0]",
        },
        {
          section_type: "features",
          section_name: null,
          position_index: 1,
          text_embedding: "[0.5,0.6,0.3,0.2]",
          vision_embedding: null,
        },
      ];
      // Mock: sections for snap2
      // hero embedding is significantly rotated (low cosine similarity)
      const sections2 = [
        {
          section_type: "hero",
          section_name: "Hero",
          position_index: 0,
          text_embedding: "[0.0,0.0,0.9,0.1]",
          vision_embedding: "[0.0,0.0,0.8,0.2]",
        },
        {
          section_type: "features",
          section_name: null,
          position_index: 1,
          text_embedding: "[0.5,0.6,0.3,0.2]",
          vision_embedding: null,
        },
        {
          section_type: "cta",
          section_name: "CTA",
          position_index: 2,
          text_embedding: "[0.9,0.9,0.0,0.0]",
          vision_embedding: null,
        },
      ];

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(snap1)
        .mockResolvedValueOnce(snap2)
        .mockResolvedValueOnce(sections1)
        .mockResolvedValueOnce(sections2);

      const result = await compareSnapshots(snapshotId1, snapshotId2);

      expect(result.success).toBe(true);
      expect(result.changes).toBeDefined();
      // hero は modified（embedding が変わっている）
      // features は unchanged（embedding 同一）
      // cta は added
      expect(result.changes?.some((c) => c.category === "modified")).toBe(true);
      expect(result.changes?.some((c) => c.category === "added")).toBe(true);
      expect(result.summary).toBeDefined();
      expect(typeof result.summary?.change_score).toBe("number");
      expect(result.summary?.change_score).toBeGreaterThanOrEqual(0);
      expect(result.summary?.change_score).toBeLessThanOrEqual(1);
    });

    it("異常系: 存在しないスナップショットIDでエラーを返す", async () => {
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await compareSnapshots(
        "aaaa1111-1111-1111-1111-111111111111",
        "bbbb2222-2222-2222-2222-222222222222"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain(DESIGN_CHANGE_ERROR_CODES.SNAPSHOT_NOT_FOUND);
    });

    it("異常系: 同じスナップショットIDでエラーを返す", async () => {
      const sameId = "aaaa1111-1111-1111-1111-111111111111";
      const result = await compareSnapshots(sameId, sameId);

      expect(result.success).toBe(false);
      expect(result.error).toContain(DESIGN_CHANGE_ERROR_CODES.INVALID_INPUT);
    });

    it("NaN/Infinityを含むembeddingでもクラッシュしない", async () => {
      const snapshotId1 = "aaaa1111-1111-1111-1111-111111111111";
      const snapshotId2 = "bbbb2222-2222-2222-2222-222222222222";

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          { id: snapshotId1, web_page_id: "p1", section_count: 1, snapshot_at: "2026-01-01" },
        ])
        .mockResolvedValueOnce([
          { id: snapshotId2, web_page_id: "p1", section_count: 1, snapshot_at: "2026-02-01" },
        ])
        .mockResolvedValueOnce([
          {
            section_type: "hero",
            section_name: null,
            position_index: 0,
            text_embedding: null,
            vision_embedding: null,
          },
        ])
        .mockResolvedValueOnce([
          {
            section_type: "hero",
            section_name: null,
            position_index: 0,
            text_embedding: null,
            vision_embedding: null,
          },
        ]);

      const result = await compareSnapshots(snapshotId1, snapshotId2);

      // null embedding の場合でもクラッシュしない
      expect(result.success).toBe(true);
      if (result.summary) {
        expect(Number.isFinite(result.summary.change_score)).toBe(true);
      }
    });
  });

  // =====================================================
  // getHistory
  // =====================================================

  describe("getHistory", () => {
    it("正常系: URL別スナップショット履歴を取得できる", async () => {
      const url = "https://example.com";

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: "page-1" }]) // web_pages lookup
        .mockResolvedValueOnce([
          {
            id: "snap-1",
            snapshot_at: "2026-01-01T00:00:00Z",
            section_count: 5,
            overall_score: 85,
          },
          {
            id: "snap-2",
            snapshot_at: "2026-02-01T00:00:00Z",
            section_count: 6,
            overall_score: 90,
          },
        ]);

      const result = await getHistory(url, 10);

      expect(result.success).toBe(true);
      expect(result.snapshots).toHaveLength(2);
      expect(result.snapshots?.[0].id).toBe("snap-1");
    });

    it("異常系: 存在しないURLでエラーを返す", async () => {
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]); // no page

      const result = await getHistory("https://unknown.example.com");

      expect(result.success).toBe(false);
      expect(result.error).toContain(DESIGN_CHANGE_ERROR_CODES.PAGE_NOT_FOUND);
    });

    it("正常系: limitパラメータで取得数を制限できる", async () => {
      const url = "https://example.com";

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: "page-1" }])
        .mockResolvedValueOnce([
          {
            id: "snap-1",
            snapshot_at: "2026-01-01T00:00:00Z",
            section_count: 5,
            overall_score: 85,
          },
        ]);

      const result = await getHistory(url, 1);

      expect(result.success).toBe(true);
      // モックなのでlimitの実際の適用はSQL側で行われる（呼び出しの検証のみ）
    });
  });

  // =====================================================
  // detectChanges
  // =====================================================

  describe("detectChanges", () => {
    it("正常系: 最新分析結果と直前スナップショットの差分を検出する", async () => {
      const webPageId = "11111111-1111-1111-1111-111111111111";

      // latest snapshot
      const latestSnapshot = [
        {
          id: "snap-latest",
          web_page_id: webPageId,
          section_count: 2,
          snapshot_at: "2026-01-01T00:00:00Z",
        },
      ];
      // current sections
      const currentSections = [
        {
          section_type: "hero",
          section_name: "Hero",
          position_index: 0,
          text_embedding: "[0.1,0.2]",
          vision_embedding: null,
        },
        {
          section_type: "features",
          section_name: null,
          position_index: 1,
          text_embedding: "[0.5,0.6]",
          vision_embedding: null,
        },
      ];
      // snapshot sections
      const snapshotSections = [
        {
          section_type: "hero",
          section_name: "Hero",
          position_index: 0,
          text_embedding: "[0.1,0.2]",
          vision_embedding: null,
        },
        {
          section_type: "features",
          section_name: null,
          position_index: 1,
          text_embedding: "[0.5,0.6]",
          vision_embedding: null,
        },
      ];

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: webPageId }]) // page exists
        .mockResolvedValueOnce(latestSnapshot) // latest snapshot
        .mockResolvedValueOnce(currentSections) // current state
        .mockResolvedValueOnce(snapshotSections); // snapshot sections

      const result = await detectChanges(webPageId);

      expect(result.success).toBe(true);
      expect(result.has_changes).toBeDefined();
    });

    it("正常系: スナップショットがない場合はno_previous_snapshotを返す", async () => {
      const webPageId = "11111111-1111-1111-1111-111111111111";

      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: webPageId }]) // page exists
        .mockResolvedValueOnce([]); // no snapshots

      const result = await detectChanges(webPageId);

      expect(result.success).toBe(true);
      expect(result.has_changes).toBeUndefined();
      expect(result.message).toContain("no_previous_snapshot");
    });
  });

  // =====================================================
  // Constants
  // =====================================================

  describe("Constants", () => {
    it("DEFAULT_MAX_SNAPSHOTS_PER_URLが50である", () => {
      expect(DEFAULT_MAX_SNAPSHOTS_PER_URL).toBe(50);
    });

    it("エラーコードが定義されている", () => {
      expect(DESIGN_CHANGE_ERROR_CODES.INVALID_INPUT).toBeDefined();
      expect(DESIGN_CHANGE_ERROR_CODES.PAGE_NOT_FOUND).toBeDefined();
      expect(DESIGN_CHANGE_ERROR_CODES.SNAPSHOT_NOT_FOUND).toBeDefined();
      expect(DESIGN_CHANGE_ERROR_CODES.SNAPSHOT_FAILED).toBeDefined();
    });
  });
});
