// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * data.delete / data.export MCPツール テスト
 * GDPR Art.17 データ削除 + Art.20 データポータビリティ MCPツールハンドラーテスト
 *
 * テストカテゴリ:
 * 1. data.delete: 正常系（page/profile/all_user_data削除）
 * 2. data.delete: バリデーション（confirm=false、無効UUID、不正target）
 * 3. data.delete: エラーハンドリング（存在しないID、サービス未設定）
 * 4. data.delete: セキュリティ（エラーメッセージサニタイズ）
 * 5. data.export: 正常系（page/profileエクスポート）
 * 6. data.export: バリデーション（無効UUID、不正target）
 *
 * data.delete / data.export MCP tool tests
 * GDPR Art.17 data deletion + Art.20 data portability MCP tool handler tests
 *
 * @module tests/tools/data-delete.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  dataDeleteHandler,
  setDataDeleteServiceFactory,
  resetDataDeleteServiceFactory,
  dataExportHandler,
  setDataExportServiceFactory,
  resetDataExportServiceFactory,
  setDataDeleteBackfillQueueFactory,
  resetDataDeleteBackfillQueueFactory,
  DATA_MCP_ERROR_CODES,
  type GdprDeletionServiceForTool,
  type BackfillQueueForTool,
  type BackfillJobForTool,
} from "../../src/tools/data/data.tool";
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  buildBackfillJobId,
} from "../../src/queues/embedding-backfill-queue";

// =====================================================
// logger モック / Logger mock
// =====================================================

vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// =====================================================
// テストデータ / Test data
// =====================================================

const MOCK_PAGE_ID = "01934567-89ab-7def-0123-456789abcdef";
const MOCK_PROFILE_ID = "02934567-89ab-7def-0123-456789abcdef";

// =====================================================
// モックサービス / Mock service
// =====================================================

function createMockService(
  overrides?: Partial<GdprDeletionServiceForTool>
): GdprDeletionServiceForTool {
  return {
    deletePage: vi.fn().mockResolvedValue({
      deleted: true,
      page_id: MOCK_PAGE_ID,
      reason: "test",
      deleted_records: {
        web_pages: 1,
        section_patterns: 2,
        section_embeddings: 2,
        component_parts: 3,
        component_part_embeddings: 3,
        motion_patterns: 1,
        motion_embeddings: 1,
        js_animation_patterns: 0,
        js_animation_embeddings: 0,
        webgl_animation_patterns: 0,
        webgl_animation_embeddings: 0,
        motion_analysis_results: 0,
        motion_analysis_embeddings: 0,
        design_narratives: 0,
        design_narrative_embeddings: 0,
        background_designs: 0,
        background_design_embeddings: 0,
        responsive_analyses: 0,
        responsive_analysis_embeddings: 0,
        quality_evaluations: 1,
        quality_benchmarks: 0,
      },
      deleted_at: new Date().toISOString(),
    }),
    deleteProfile: vi.fn().mockResolvedValue({
      deleted: true,
      profile_id: MOCK_PROFILE_ID,
      reason: "test",
      deleted_records: {
        preference_profiles: 1,
        preference_signals: 5,
      },
      deleted_at: new Date().toISOString(),
    }),
    deleteAllUserData: vi.fn().mockResolvedValue({
      deleted: true,
      pages_deleted: 1,
      profile_deleted: true,
      reason: "test",
      deleted_at: new Date().toISOString(),
    }),
    exportPageData: vi.fn().mockResolvedValue({
      page_id: MOCK_PAGE_ID,
      export_format: "json",
      data: {
        web_page: { id: MOCK_PAGE_ID, url: "https://example.com" },
        section_patterns: [],
        component_parts: [],
        motion_patterns: [],
        quality_evaluations: [],
        design_narratives: [],
        background_designs: [],
        responsive_analyses: [],
      },
      pii_fields: ["page_id"],
      gdpr_notice: "Data exported under GDPR Art.20",
      exported_at: new Date().toISOString(),
    }),
    exportProfileData: vi.fn().mockResolvedValue({
      profile_id: MOCK_PROFILE_ID,
      export_format: "json",
      data: {
        profile: { id: MOCK_PROFILE_ID, name: "default" },
        signals: [],
      },
      pii_fields: ["profile_id"],
      gdpr_notice: "Data exported under GDPR Art.20",
      exported_at: new Date().toISOString(),
    }),
    ...overrides,
  };
}

// =====================================================
// テスト
// =====================================================

// =====================================================
// audit-log.service mock
// =====================================================
// data.delete 内部で getAuditLogService().log() を呼ぶ。Prisma client 未設定
// の場合はサイレント warn で済む挙動に依存しているため、spy だけ差し込む。

import {
  getAuditLogService,
  resetAuditLogService,
  setAuditLogPrismaClientFactory,
  resetAuditLogPrismaClientFactory,
  type AuditLogPrismaClient,
} from "../../src/services/audit-log.service";

function createAuditLogSpy(): {
  prismaMock: AuditLogPrismaClient;
  createSpy: ReturnType<typeof vi.fn>;
} {
  const createSpy = vi.fn().mockResolvedValue({});
  const prismaMock = {
    auditLog: {
      create: createSpy,
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as AuditLogPrismaClient;
  return { prismaMock, createSpy };
}

// =====================================================
// Embedding Backfill Queue mock helpers (PR7a-4)
// =====================================================

interface MockJobOptions {
  state: "waiting" | "active" | "delayed" | "failed" | "completed";
  removeThrows?: Error;
  getStateThrows?: Error;
}

function createMockJob(opts: MockJobOptions): BackfillJobForTool & {
  removeMock: ReturnType<typeof vi.fn>;
} {
  const removeMock = vi.fn(async () => {
    if (opts.removeThrows) throw opts.removeThrows;
  });
  const getState = vi.fn(async () => {
    if (opts.getStateThrows) throw opts.getStateThrows;
    return opts.state;
  });
  return {
    getState,
    remove: removeMock,
    removeMock,
  };
}

/**
 * 全 7 カテゴリについて指定状態のジョブを返す Queue モック
 */
function createMockQueueWithJobs(
  opts: MockJobOptions | ((category: string) => MockJobOptions | null)
): BackfillQueueForTool & {
  getJobMock: ReturnType<typeof vi.fn>;
  jobs: Map<string, ReturnType<typeof createMockJob>>;
} {
  const jobs = new Map<string, ReturnType<typeof createMockJob>>();
  const getJobMock = vi.fn(async (jobId: string) => {
    if (jobs.has(jobId)) return jobs.get(jobId)!;

    // jobId format: `<webPageId>__<category>` (BullMQ `:` 制限のため `__` を使用)
    // jobId format: `<webPageId>__<category>` (uses `__` due to BullMQ `:` restriction)
    const category = jobId.split("__")[1] ?? "";
    const jobOpts = typeof opts === "function" ? opts(category) : opts;
    if (jobOpts === null) return null;

    const job = createMockJob(jobOpts);
    jobs.set(jobId, job);
    return job;
  });
  return { getJob: getJobMock, getJobMock, jobs };
}

describe("data.delete MCP Tool", () => {
  let mockService: GdprDeletionServiceForTool;

  beforeEach(() => {
    mockService = createMockService();
    setDataDeleteServiceFactory(() => mockService);
    setDataExportServiceFactory(() => mockService);
  });

  afterEach(() => {
    resetDataDeleteServiceFactory();
    resetDataExportServiceFactory();
    resetDataDeleteBackfillQueueFactory();
    resetAuditLogPrismaClientFactory();
    resetAuditLogService();
    vi.restoreAllMocks();
  });

  // =====================================================
  // 1. data.delete 正常系 / data.delete normal cases
  // =====================================================

  describe("data.delete - normal cases", () => {
    it("target=page でページ削除を実行する / should delete page when target=page", async () => {
      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "GDPR Art.17 deletion request",
        confirm: true,
      });

      expect(result).toHaveProperty("success", true);
      if ("data" in result) {
        expect(result.data.deleted).toBe(true);
      }
      expect(mockService.deletePage).toHaveBeenCalledWith(
        MOCK_PAGE_ID,
        "GDPR Art.17 deletion request"
      );
    });

    it("target=profile でプロファイル削除を実行する / should delete profile when target=profile", async () => {
      const result = await dataDeleteHandler({
        target: "profile",
        id: MOCK_PROFILE_ID,
        reason: "User requested deletion",
        confirm: true,
      });

      expect(result).toHaveProperty("success", true);
      expect(mockService.deleteProfile).toHaveBeenCalledWith(
        MOCK_PROFILE_ID,
        "User requested deletion"
      );
    });

    it("target=all_user_data で全データ削除を実行する / should delete all data when target=all_user_data", async () => {
      const result = await dataDeleteHandler({
        target: "all_user_data",
        id: MOCK_PROFILE_ID,
        reason: "Account deletion",
        confirm: true,
        page_ids: [MOCK_PAGE_ID],
      });

      expect(result).toHaveProperty("success", true);
      expect(mockService.deleteAllUserData).toHaveBeenCalled();
    });
  });

  // =====================================================
  // 2. data.delete バリデーション / data.delete validation
  // =====================================================

  describe("data.delete - validation", () => {
    it("confirm=false で削除を拒否する / should reject when confirm=false", async () => {
      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "test",
        confirm: false,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        expect(result.error.code).toBe(DATA_MCP_ERROR_CODES.DELETE_NOT_CONFIRMED);
      }
    });

    it("無効なUUIDで入力バリデーションエラーを返す / should return validation error for invalid UUID", async () => {
      const result = await dataDeleteHandler({
        target: "page",
        id: "not-a-uuid",
        reason: "test",
        confirm: true,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        expect(result.error.code).toBe(DATA_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("不正なtarget値でバリデーションエラーを返す / should return validation error for invalid target", async () => {
      const result = await dataDeleteHandler({
        target: "invalid_target",
        id: MOCK_PAGE_ID,
        reason: "test",
        confirm: true,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        expect(result.error.code).toBe(DATA_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("reason未指定でバリデーションエラーを返す / should return validation error when reason is missing", async () => {
      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        confirm: true,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        expect(result.error.code).toBe(DATA_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });

  // =====================================================
  // 3. data.delete エラーハンドリング / error handling
  // =====================================================

  describe("data.delete - error handling", () => {
    it("存在しないページID で NOT_FOUND エラーを返す / should return NOT_FOUND for non-existent page", async () => {
      mockService.deletePage = vi.fn().mockRejectedValue(new Error("Page not found"));

      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "test",
        confirm: true,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        expect(result.error.code).toBe(DATA_MCP_ERROR_CODES.NOT_FOUND);
      }
    });

    it("サービス未設定で SERVICE_UNAVAILABLE エラーを返す / should return error when service not set", async () => {
      resetDataDeleteServiceFactory();

      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "test",
        confirm: true,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        expect(result.error.code).toBe(DATA_MCP_ERROR_CODES.SERVICE_UNAVAILABLE);
      }
    });

    it("DB接続エラーでサニタイズされたメッセージを返す / should return sanitized message on DB error", async () => {
      mockService.deletePage = vi.fn().mockRejectedValue(
        Object.assign(new Error("column web_pages.secret_field does not exist"), {
          code: "P2003",
        })
      );

      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "test",
        confirm: true,
      });

      expect(result).toHaveProperty("success", false);
      if ("error" in result) {
        // DB構造の詳細が漏れていないことを確認
        expect(result.error.message).not.toContain("web_pages");
        expect(result.error.message).not.toContain("secret_field");
      }
    });
  });

  // =====================================================
  // 4. PR7a-4: Embedding Backfill Queue cleanup on data.delete
  // GDPR Art.17 / CCPA §1798.105 / LCC M-1
  // =====================================================

  describe("data.delete - embedding backfill queue cleanup (PR7a-4)", () => {
    it("target=page で 7 カテゴリすべての Queue ジョブを削除する / should remove queue jobs for all 7 categories on page deletion", async () => {
      const mockQueue = createMockQueueWithJobs({ state: "waiting" });
      setDataDeleteBackfillQueueFactory(() => mockQueue);

      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "GDPR Art.17 request",
        confirm: true,
      });

      expect(result).toHaveProperty("success", true);
      // 7 カテゴリすべてで getJob が呼ばれる
      expect(mockQueue.getJobMock).toHaveBeenCalledTimes(EMBEDDING_BACKFILL_CATEGORIES.length);
      // jobId フォーマット検証 (BullMQ `:` 制限のため `__` separator を使用)
      // jobId format check (uses `__` separator due to BullMQ `:` restriction)
      for (const category of EMBEDDING_BACKFILL_CATEGORIES) {
        expect(mockQueue.getJobMock).toHaveBeenCalledWith(
          buildBackfillJobId(MOCK_PAGE_ID, category)
        );
      }
      // 各ジョブの remove() が呼ばれた
      expect(mockQueue.jobs.size).toBe(EMBEDDING_BACKFILL_CATEGORIES.length);
      for (const job of mockQueue.jobs.values()) {
        expect(job.removeMock).toHaveBeenCalledOnce();
      }
      if ("queueJobsRemoved" in result && result.queueJobsRemoved) {
        expect(result.queueJobsRemoved.embeddingBackfill.removed).toBe(
          EMBEDDING_BACKFILL_CATEGORIES.length
        );
        expect(result.queueJobsRemoved.embeddingBackfill.skippedActive).toBe(0);
      } else {
        throw new Error("queueJobsRemoved should be set for target=page");
      }
    });

    it("active ジョブは skip して skippedActive にカウントする / should skip active jobs and count them as skippedActive", async () => {
      // part_text は active、それ以外は waiting
      const mockQueue = createMockQueueWithJobs((category) =>
        category === "part_text" ? { state: "active" } : { state: "waiting" }
      );
      setDataDeleteBackfillQueueFactory(() => mockQueue);

      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "test",
        confirm: true,
      });

      expect(result).toHaveProperty("success", true);
      if ("queueJobsRemoved" in result && result.queueJobsRemoved) {
        expect(result.queueJobsRemoved.embeddingBackfill.skippedActive).toBe(1);
        expect(result.queueJobsRemoved.embeddingBackfill.removed).toBe(
          EMBEDDING_BACKFILL_CATEGORIES.length - 1
        );
      } else {
        throw new Error("queueJobsRemoved should be set");
      }

      // active ジョブの remove は呼ばれない
      const partTextJob = mockQueue.jobs.get(buildBackfillJobId(MOCK_PAGE_ID, "part_text"));
      expect(partTextJob?.removeMock).not.toHaveBeenCalled();
    });

    it("getJob が例外を投げても削除処理を続行する / should continue on getJob errors (graceful degradation)", async () => {
      let callCount = 0;
      const failingQueue: BackfillQueueForTool = {
        getJob: vi.fn(async (jobId: string) => {
          callCount++;
          // 最初の 1 回は throw、残りは null
          if (callCount === 1) {
            throw new Error("Redis connection refused");
          }
          // 残りは sqlite internal path を模した機密風文字列
          if (callCount === 2) {
            throw new Error("internal column secret_field mismatch");
          }
          return null;
        }),
      };
      setDataDeleteBackfillQueueFactory(() => failingQueue);

      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "test",
        confirm: true,
      });

      // DB 削除は続行されている
      expect(result).toHaveProperty("success", true);
      expect(mockService.deletePage).toHaveBeenCalled();
      // 7 カテゴリすべて試行された
      expect(failingQueue.getJob).toHaveBeenCalledTimes(EMBEDDING_BACKFILL_CATEGORIES.length);
    });

    it("target=all_user_data で複数ページの Queue ジョブをすべて削除する / should remove queue jobs for all pages on all_user_data", async () => {
      const PAGE_ID_2 = "03934567-89ab-7def-0123-456789abcdef";
      const mockQueue = createMockQueueWithJobs({ state: "waiting" });
      setDataDeleteBackfillQueueFactory(() => mockQueue);

      const result = await dataDeleteHandler({
        target: "all_user_data",
        id: MOCK_PROFILE_ID,
        reason: "account deletion",
        confirm: true,
        page_ids: [MOCK_PAGE_ID, PAGE_ID_2],
      });

      expect(result).toHaveProperty("success", true);
      // 2 pages × 7 categories = 14 getJob calls
      expect(mockQueue.getJobMock).toHaveBeenCalledTimes(2 * EMBEDDING_BACKFILL_CATEGORIES.length);
      if ("queueJobsRemoved" in result && result.queueJobsRemoved) {
        expect(result.queueJobsRemoved.embeddingBackfill.removed).toBe(
          2 * EMBEDDING_BACKFILL_CATEGORIES.length
        );
      } else {
        throw new Error("queueJobsRemoved should be set for target=all_user_data");
      }
    });

    it("target=profile では Queue ジョブ削除を実行しない / should NOT remove queue jobs on target=profile", async () => {
      const mockQueue = createMockQueueWithJobs({ state: "waiting" });
      setDataDeleteBackfillQueueFactory(() => mockQueue);

      const result = await dataDeleteHandler({
        target: "profile",
        id: MOCK_PROFILE_ID,
        reason: "test",
        confirm: true,
      });

      expect(result).toHaveProperty("success", true);
      expect(mockQueue.getJobMock).not.toHaveBeenCalled();
      if ("queueJobsRemoved" in result) {
        // profile では undefined のはず
        expect(result.queueJobsRemoved).toBeUndefined();
      }
    });

    it("Queue ジョブ削除後に audit_logs へ記録される / should record audit_log entry for queue job removal", async () => {
      const { prismaMock, createSpy } = createAuditLogSpy();
      setAuditLogPrismaClientFactory(() => prismaMock);
      resetAuditLogService();
      // 初期化を発火
      getAuditLogService();

      const mockQueue = createMockQueueWithJobs({ state: "waiting" });
      setDataDeleteBackfillQueueFactory(() => mockQueue);

      await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "GDPR Art.17",
        confirm: true,
      });

      // action=data.delete と action=embedding_backfill_queue_jobs_removed の 2 回
      expect(createSpy).toHaveBeenCalledTimes(2);
      const actions = createSpy.mock.calls.map(
        (call: unknown[]) => (call[0] as { data: { action: string } }).data.action
      );
      expect(actions).toContain("data.delete");
      expect(actions).toContain("embedding_backfill_queue_jobs_removed");

      // 詳細フィールド検証
      const queueAuditCall = createSpy.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as { data: { action: string } }).data.action ===
          "embedding_backfill_queue_jobs_removed"
      );
      expect(queueAuditCall).toBeDefined();
      const details = (queueAuditCall![0] as { data: { details: unknown } }).data.details;
      expect(details).toMatchObject({
        removedCount: EMBEDDING_BACKFILL_CATEGORIES.length,
        skippedActiveCount: 0,
      });
    });

    it("Queue factory 未設定でも DB 削除は続行する / should proceed with DB deletion when queue factory not set", async () => {
      // 意図的に setDataDeleteBackfillQueueFactory を呼ばない
      const result = await dataDeleteHandler({
        target: "page",
        id: MOCK_PAGE_ID,
        reason: "test",
        confirm: true,
      });

      expect(result).toHaveProperty("success", true);
      expect(mockService.deletePage).toHaveBeenCalled();
      if ("queueJobsRemoved" in result) {
        expect(result.queueJobsRemoved).toBeUndefined();
      }
    });
  });

  // =====================================================
  // 5. data.export 正常系 / data.export normal cases
  // =====================================================

  describe("data.export - normal cases", () => {
    it("target=page でページデータをエクスポートする / should export page data", async () => {
      const result = await dataExportHandler({
        target: "page",
        id: MOCK_PAGE_ID,
      });

      expect(result).toHaveProperty("success", true);
      if ("data" in result) {
        expect(result.data.page_id).toBe(MOCK_PAGE_ID);
        expect(result.data.export_format).toBe("json");
      }
      expect(mockService.exportPageData).toHaveBeenCalledWith(MOCK_PAGE_ID);
    });

    it("target=profile でプロファイルデータをエクスポートする / should export profile data", async () => {
      const result = await dataExportHandler({
        target: "profile",
        id: MOCK_PROFILE_ID,
      });

      expect(result).toHaveProperty("success", true);
      if ("data" in result) {
        expect(result.data.profile_id).toBe(MOCK_PROFILE_ID);
      }
      expect(mockService.exportProfileData).toHaveBeenCalledWith(MOCK_PROFILE_ID);
    });
  });

  // =====================================================
  // 6. data.export バリデーション / data.export validation
  // =====================================================

  describe("data.export - validation", () => {
    it("無効なUUIDで入力バリデーションエラーを返す / should return validation error for invalid UUID", async () => {
      const result = await dataExportHandler({
        target: "page",
        id: "not-a-uuid",
      });

      expect(result).toHaveProperty("success", false);
    });

    it("サービス未設定でエラーを返す / should return error when service not set", async () => {
      resetDataExportServiceFactory();

      const result = await dataExportHandler({
        target: "page",
        id: MOCK_PAGE_ID,
      });

      expect(result).toHaveProperty("success", false);
    });
  });
});
