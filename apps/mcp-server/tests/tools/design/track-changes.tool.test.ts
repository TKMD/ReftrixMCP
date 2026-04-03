// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.track_changes MCPツールのテスト
 * Design Change Tracker Tool Tests (v0.3.0 T2-DCT)
 *
 * テスト対象:
 * - Zodスキーマバリデーション (6テスト)
 * - ハンドラー統合テスト (5テスト)
 * - ツール定義の検証 (4テスト)
 * - セキュリティ (3テスト)
 *
 * @module tests/tools/design/track-changes.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  designTrackChangesInputSchema,
  designTrackChangesHandler,
  designTrackChangesToolDefinition,
  type DesignTrackChangesOutput,
} from "../../../src/tools/design/track-changes.tool";

import {
  setDesignChangeTrackerPrismaClientFactory,
  resetDesignChangeTrackerPrismaClientFactory,
  DESIGN_CHANGE_ERROR_CODES,
  type DesignChangeTrackerPrismaClient,
} from "../../../src/services/design-change-tracker.service";

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

// =====================================================
// Test Data
// =====================================================

const UUID_A = "00000000-0000-4000-8000-000000000001";
const UUID_B = "00000000-0000-4000-8000-000000000002";

describe("design.track_changes Tool", () => {
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
  // Schema Validation / スキーマバリデーション
  // =====================================================

  describe("Zodスキーマバリデーション", () => {
    it("snapshot アクション: 有効なURLで受け入れる", () => {
      const input = { url: "https://example.com", action: "snapshot" };
      const result = designTrackChangesInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("compare アクション: snapshot_ids が必須", () => {
      const input = { url: "https://example.com", action: "compare" };
      const result = designTrackChangesInputSchema.safeParse(input);
      // compare アクションは snapshot_ids なしでもスキーマ自体はパスする（ハンドラーで検証）
      expect(result.success).toBe(true);
    });

    it("history アクション: limitデフォルト値が10", () => {
      const input = { url: "https://example.com", action: "history" };
      const result = designTrackChangesInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(10);
      }
    });

    it("無効なaction値でバリデーションエラー", () => {
      const input = { url: "https://example.com", action: "invalid" };
      const result = designTrackChangesInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("limit範囲外でバリデーションエラー", () => {
      const input = { url: "https://example.com", action: "history", limit: 100 };
      const result = designTrackChangesInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("snapshot_ids の最大2件を受け入れる", () => {
      const input = {
        url: "https://example.com",
        action: "compare",
        snapshot_ids: [UUID_A, UUID_B],
      };
      const result = designTrackChangesInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  // =====================================================
  // Handler / ハンドラー
  // =====================================================

  describe("ハンドラー統合テスト", () => {
    it("snapshot アクション: スナップショットを作成する", async () => {
      // Mock setup for createSnapshot flow
      // 1. resolveWebPageId (handler) -> SELECT id FROM web_pages WHERE url = $1
      // 2. createSnapshot -> SELECT id, url, analysis_version FROM web_pages WHERE id = $1
      // 3. sections
      // 4. quality
      // 5. INSERT design_snapshots
      // 6. SELECT COUNT(*) FROM design_snapshots
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: UUID_A }]) // resolveWebPageId
        .mockResolvedValueOnce([
          { id: UUID_A, url: "https://example.com", analysis_version: "0.3.0" },
        ]) // page check in createSnapshot
        .mockResolvedValueOnce([]) // sections (empty)
        .mockResolvedValueOnce([]) // quality
        .mockResolvedValueOnce([{ id: UUID_B }]) // INSERT snapshot
        .mockResolvedValueOnce([{ count: "1" }]); // count

      const result = (await designTrackChangesHandler({
        url: "https://example.com",
        action: "snapshot",
      })) as DesignTrackChangesOutput;

      expect(result.success).toBe(true);
      expect(result.action).toBe("snapshot");
    });

    it("history アクション: 履歴を取得する", async () => {
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: UUID_A }]) // page lookup
        .mockResolvedValueOnce([]); // empty history

      const result = (await designTrackChangesHandler({
        url: "https://example.com",
        action: "history",
      })) as DesignTrackChangesOutput;

      expect(result.success).toBe(true);
      expect(result.action).toBe("history");
    });

    it("compare アクション: snapshot_idsなしでエラー", async () => {
      const result = (await designTrackChangesHandler({
        url: "https://example.com",
        action: "compare",
      })) as DesignTrackChangesOutput;

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("detect アクション: 変更検出を実行する", async () => {
      // 1. resolveWebPageId (handler) -> SELECT id FROM web_pages WHERE url = $1
      // 2. detectChanges -> SELECT id FROM web_pages WHERE id = $1
      // 3. detectChanges -> SELECT ... FROM design_snapshots (latest)
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: UUID_A }]) // resolveWebPageId
        .mockResolvedValueOnce([{ id: UUID_A }]) // page exists check
        .mockResolvedValueOnce([]); // no snapshots

      const result = (await designTrackChangesHandler({
        url: "https://example.com",
        action: "detect",
      })) as DesignTrackChangesOutput;

      expect(result.success).toBe(true);
      expect(result.action).toBe("detect");
    });

    it("バリデーション失敗時にエラーを返す", async () => {
      const result = (await designTrackChangesHandler({
        url: "not-a-url",
        action: "snapshot",
      })) as DesignTrackChangesOutput;

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // =====================================================
  // Tool Definition / ツール定義
  // =====================================================

  describe("ツール定義", () => {
    it("ツール名が design.track_changes である", () => {
      expect(designTrackChangesToolDefinition.name).toBe("design.track_changes");
    });

    it("descriptionが日英バイリンガルである", () => {
      expect(designTrackChangesToolDefinition.description).toContain("デザイン変更");
      expect(designTrackChangesToolDefinition.description).toContain("design change");
    });

    it("inputSchemaにrequiredフィールドが定義されている", () => {
      expect(designTrackChangesToolDefinition.inputSchema.required).toContain("url");
      expect(designTrackChangesToolDefinition.inputSchema.required).toContain("action");
    });

    it("annotationsが設定されている", () => {
      expect(designTrackChangesToolDefinition.annotations).toBeDefined();
    });
  });

  // =====================================================
  // Security / セキュリティ
  // =====================================================

  describe("セキュリティ", () => {
    it("sanitizeErrorMessageが使用される（内部エラーが漏洩しない）", async () => {
      // Force an internal error by making Prisma throw
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("INTERNAL: connection to server at localhost:26432 failed")
      );

      const result = (await designTrackChangesHandler({
        url: "https://example.com",
        action: "snapshot",
      })) as DesignTrackChangesOutput;

      expect(result.success).toBe(false);
      // エラーメッセージに内部情報（ポート番号等）が含まれない
      expect(result.error).not.toContain("26432");
    });

    it("UUIDバリデーション: snapshot_idsに無効UUIDを含むとエラー", async () => {
      const result = (await designTrackChangesHandler({
        url: "https://example.com",
        action: "compare",
        snapshot_ids: ["not-a-uuid", UUID_A],
      })) as DesignTrackChangesOutput;

      expect(result.success).toBe(false);
    });

    it("limitが範囲外の場合にバリデーションエラー", async () => {
      const result = (await designTrackChangesHandler({
        url: "https://example.com",
        action: "history",
        limit: 0,
      })) as DesignTrackChangesOutput;

      expect(result.success).toBe(false);
    });
  });
});
