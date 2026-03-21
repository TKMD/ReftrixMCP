// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * preference.hear MCPツール テスト
 * TDD Red Phase: ヒアリングセッションツールの検証
 *
 * モードA: サンプル提示（feedback なし）
 * - DBから代表的なWebデザインを5~8件抽出
 * - MoodCategoryの多様性を保証
 * - design_narratives + web_pages JOIN
 *
 * モードB: フィードバック受信（feedback あり）
 * - preference_text を e5 embedding 化
 * - preference_profiles + preference_signals 更新
 *
 * @module tests/tools/preference/hear.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  preferenceHearHandler,
  preferenceHearToolDefinition,
  setPreferenceServiceFactory,
  resetPreferenceServiceFactory,
  type IPreferenceService,
  type SamplesResult,
  type ProfilingNotice,
} from "../../../src/tools/preference/hear.tool";

import { PREFERENCE_MCP_ERROR_CODES } from "../../../src/tools/preference/schemas";

// =====================================================
// テストデータ
// =====================================================

const MOCK_PROFILE_ID = "01234567-89ab-cdef-0123-456789abcdef";

const MOCK_SAMPLES = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    url: "https://example.com/minimal",
    mood_category: "minimalist",
    mood_description: "クリーンでミニマルなデザイン",
    overall_tone: "シンプルで洗練された印象",
    screenshot_available: true,
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    url: "https://example.com/bold",
    mood_category: "bold",
    mood_description: "大胆なカラーとタイポグラフィ",
    overall_tone: "インパクトのある力強い印象",
    screenshot_available: false,
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    url: "https://example.com/elegant",
    mood_category: "elegant",
    mood_description: "上品で洗練されたデザイン",
    overall_tone: "エレガントで高級感のある印象",
    screenshot_available: true,
  },
  {
    id: "44444444-4444-4444-4444-444444444444",
    url: "https://example.com/tech",
    mood_category: "tech",
    mood_description: "テクノロジー感のあるデザイン",
    overall_tone: "先進的で革新的な印象",
    screenshot_available: true,
  },
  {
    id: "55555555-5555-5555-5555-555555555555",
    url: "https://example.com/warm",
    mood_category: "warm",
    mood_description: "温かみのあるデザイン",
    overall_tone: "親しみやすくアットホームな印象",
    screenshot_available: false,
  },
];

// =====================================================
// モックサービス
// =====================================================

const MOCK_PROGRESS = {
  confidence: 0,
  estimated_remaining: 5,
  remaining_reason:
    "ヒアリング未開始。5カテゴリの評価が必要です / Hearing not started. 5 categories need evaluation",
  should_continue: true,
  mood_categories_covered: 0,
  mood_categories_total: 5,
};

function createMockService(overrides?: Partial<IPreferenceService>): IPreferenceService {
  return {
    getSamples: vi.fn().mockResolvedValue({
      profile_id: MOCK_PROFILE_ID,
      samples: MOCK_SAMPLES,
      progress: MOCK_PROGRESS,
    }),
    processFeedback: vi.fn().mockResolvedValue({
      updated: true,
      profile_id: MOCK_PROFILE_ID,
      interaction_count: 1,
    }),
    getProfile: vi.fn().mockResolvedValue({
      profile_id: MOCK_PROFILE_ID,
      name: "default",
      preference_text: null,
      interaction_count: 0,
      created_at: "2026-03-07T00:00:00Z",
      updated_at: "2026-03-07T00:00:00Z",
    }),
    resetProfile: vi.fn().mockResolvedValue({
      reset: true,
      profile_id: MOCK_PROFILE_ID,
    }),
    deleteProfile: vi.fn().mockResolvedValue({
      deleted: true,
      profile_id: MOCK_PROFILE_ID,
    }),
    getSignals: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// =====================================================
// テスト
// =====================================================

describe("preference.hear MCPツール", () => {
  beforeEach(() => {
    resetPreferenceServiceFactory();
  });

  afterEach(() => {
    resetPreferenceServiceFactory();
  });

  // =====================================================
  // ツール定義テスト
  // =====================================================

  describe("ツール定義", () => {
    it("正しいツール名が設定されている", () => {
      expect(preferenceHearToolDefinition.name).toBe("preference.hear");
    });

    it("descriptionが設定されている", () => {
      expect(preferenceHearToolDefinition.description).toBeTruthy();
      expect(typeof preferenceHearToolDefinition.description).toBe("string");
    });

    it("inputSchemaが設定されている", () => {
      expect(preferenceHearToolDefinition.inputSchema).toBeDefined();
      expect(preferenceHearToolDefinition.inputSchema.type).toBe("object");
    });

    it("annotationsが設定されている", () => {
      expect(preferenceHearToolDefinition.annotations).toBeDefined();
    });
  });

  // =====================================================
  // モードA: サンプル提示テスト
  // =====================================================

  describe("モードA: サンプル提示", () => {
    it("feedbackなしの場合、サンプルを返す", async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({});

      expect(result).toHaveProperty("success", true);
      const data = (result as { success: true; data: unknown }).data as {
        profile_id: string;
        samples: unknown[];
      };
      expect(data.profile_id).toBe(MOCK_PROFILE_ID);
      expect(data.samples).toHaveLength(5);
    });

    it("profile_id指定でサンプルを返す", async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({
        profile_id: MOCK_PROFILE_ID,
      });

      expect(result).toHaveProperty("success", true);
      expect(mockService.getSamples).toHaveBeenCalledWith({
        profileId: MOCK_PROFILE_ID,
        limit: undefined,
        offset: undefined,
        excludeIds: undefined,
      });
    });

    it("profile_id未指定でサンプルを返す（新規プロファイル）", async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({});

      expect(result).toHaveProperty("success", true);
      expect(mockService.getSamples).toHaveBeenCalledWith({
        profileId: undefined,
        limit: undefined,
        offset: undefined,
        excludeIds: undefined,
      });
    });

    it("limit/offset/exclude_ids が GetSamplesOptions オブジェクトとして渡される", async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const excludeIds = [
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ];

      await preferenceHearHandler({
        profile_id: MOCK_PROFILE_ID,
        limit: 5,
        offset: 10,
        exclude_ids: excludeIds,
      });

      expect(mockService.getSamples).toHaveBeenCalledWith({
        profileId: MOCK_PROFILE_ID,
        limit: 5,
        offset: 10,
        excludeIds: excludeIds,
      });
    });

    it("exclude_ids が excludeIds に正しく変換される（snake_case → camelCase）", async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const excludeIds = ["33333333-3333-3333-3333-333333333333"];

      await preferenceHearHandler({
        exclude_ids: excludeIds,
      });

      expect(mockService.getSamples).toHaveBeenCalledWith(
        expect.objectContaining({
          excludeIds: excludeIds,
        })
      );
    });

    it("limit のみ指定時に正しく渡される", async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      await preferenceHearHandler({
        limit: 3,
      });

      expect(mockService.getSamples).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 3,
        })
      );
    });

    it("レスポンスに progress フィールドが含まれる", async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({});

      expect(result).toHaveProperty("success", true);
      const data = (result as { success: true; data: SamplesResult }).data;
      expect(data).toHaveProperty("progress");
      expect(data.progress).toEqual(
        expect.objectContaining({
          confidence: expect.any(Number),
          estimated_remaining: expect.any(Number),
          remaining_reason: expect.any(String),
          should_continue: expect.any(Boolean),
          mood_categories_covered: expect.any(Number),
          mood_categories_total: expect.any(Number),
        })
      );
    });

    it("progress の HearingProgress 全フィールドが正しい型で返される", async () => {
      const customProgress = {
        confidence: 0.45,
        estimated_remaining: 3,
        remaining_reason:
          "未評価のデザインカテゴリが3/5件あります / 3/5 design categories not yet evaluated",
        should_continue: true,
        mood_categories_covered: 2,
        mood_categories_total: 5,
      };

      const mockService = createMockService({
        getSamples: vi.fn().mockResolvedValue({
          profile_id: MOCK_PROFILE_ID,
          samples: MOCK_SAMPLES,
          progress: customProgress,
        }),
      });
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({});

      expect(result).toHaveProperty("success", true);
      const data = (result as { success: true; data: SamplesResult }).data;
      expect(data.progress.confidence).toBe(0.45);
      expect(data.progress.estimated_remaining).toBe(3);
      expect(data.progress.remaining_reason).toContain("3/5");
      expect(data.progress.should_continue).toBe(true);
      expect(data.progress.mood_categories_covered).toBe(2);
      expect(data.progress.mood_categories_total).toBe(5);
    });

    it("confidence が 0.8 以上の場合 should_continue が false", async () => {
      const highConfidenceProgress = {
        confidence: 0.85,
        estimated_remaining: 0,
        remaining_reason:
          "嗜好プロファイルの信頼度が十分に高いため、ヒアリングを終了できます。 / Preference profile confidence is sufficient to end the hearing.",
        should_continue: false,
        mood_categories_covered: 5,
        mood_categories_total: 5,
      };

      const mockService = createMockService({
        getSamples: vi.fn().mockResolvedValue({
          profile_id: MOCK_PROFILE_ID,
          samples: MOCK_SAMPLES,
          progress: highConfidenceProgress,
        }),
      });
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({});

      expect(result).toHaveProperty("success", true);
      const data = (result as { success: true; data: SamplesResult }).data;
      expect(data.progress.should_continue).toBe(false);
      expect(data.progress.confidence).toBeGreaterThanOrEqual(0.8);
      expect(data.progress.estimated_remaining).toBe(0);
    });

    it("新規プロファイル作成時に profiling_notice が含まれる", async () => {
      const mockProfilingNotice: ProfilingNotice = {
        message:
          "This tool creates a preference profile to personalize search results. " +
          "Your design preferences are stored locally. " +
          "このツールは検索結果をパーソナライズするための嗜好プロファイルを作成します。" +
          "デザイン嗜好はローカルに保存されます。",
        purpose:
          "Personalization of design search results via preference embedding / " +
          "嗜好embeddingによるデザイン検索結果のパーソナライズ",
        deletion_method:
          "Use preference.reset with hard_delete: true to permanently delete all data (GDPR Right to Erasure) / " +
          "preference.reset で hard_delete: true を指定すると全データを完全削除できます（GDPR忘れられる権利）",
        retention_policy:
          "Data is retained until explicitly deleted via preference.reset. No automatic expiration. / " +
          "preference.reset で明示的に削除するまで保持されます。自動期限切れはありません。",
      };

      const mockService = createMockService({
        getSamples: vi.fn().mockResolvedValue({
          profile_id: MOCK_PROFILE_ID,
          samples: MOCK_SAMPLES,
          progress: MOCK_PROGRESS,
          profiling_notice: mockProfilingNotice,
        }),
      });
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({});

      expect(result).toHaveProperty("success", true);
      const data = (result as { success: true; data: SamplesResult }).data;
      expect(data.profiling_notice).toBeDefined();
      expect(data.profiling_notice!.message).toContain("preference profile");
      expect(data.profiling_notice!.message).toContain("嗜好プロファイル");
      expect(data.profiling_notice!.purpose).toContain("Personalization");
      expect(data.profiling_notice!.deletion_method).toContain("preference.reset");
      expect(data.profiling_notice!.deletion_method).toContain("GDPR");
      expect(data.profiling_notice!.retention_policy).toContain("explicitly deleted");
    });

    it("既存プロファイル使用時に profiling_notice が含まれない", async () => {
      const mockService = createMockService({
        getSamples: vi.fn().mockResolvedValue({
          profile_id: MOCK_PROFILE_ID,
          samples: MOCK_SAMPLES,
          progress: MOCK_PROGRESS,
          // profiling_notice は含まれない（既存プロファイル）
        }),
      });
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({
        profile_id: MOCK_PROFILE_ID,
      });

      expect(result).toHaveProperty("success", true);
      const data = (result as { success: true; data: SamplesResult }).data;
      expect(data.profiling_notice).toBeUndefined();
    });

    it("各サンプルに必須フィールドが含まれている", async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({});

      expect(result).toHaveProperty("success", true);
      const data = (result as { success: true; data: unknown }).data as {
        samples: Array<{
          id: string;
          url: string;
          mood_category: string;
          mood_description: string;
          overall_tone: string;
          screenshot_available: boolean;
        }>;
      };
      for (const sample of data.samples) {
        expect(sample).toHaveProperty("id");
        expect(sample).toHaveProperty("url");
        expect(sample).toHaveProperty("mood_category");
        expect(sample).toHaveProperty("mood_description");
        expect(sample).toHaveProperty("overall_tone");
        expect(sample).toHaveProperty("screenshot_available");
      }
    });
  });

  // =====================================================
  // モードB: フィードバック受信テスト
  // =====================================================

  describe("モードB: フィードバック受信", () => {
    it("有効なフィードバックを処理する", async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({
        profile_id: MOCK_PROFILE_ID,
        feedback: [
          {
            sample_id: "11111111-1111-1111-1111-111111111111",
            rating: "positive",
            comment: "とても気に入りました",
          },
        ],
        preference_text: "ミニマルでクリーンなデザインが好みです。シンプルさを重視。",
      });

      expect(result).toHaveProperty("success", true);
      const data = (result as { success: true; data: unknown }).data as {
        updated: boolean;
        profile_id: string;
        interaction_count: number;
      };
      expect(data.updated).toBe(true);
      expect(data.profile_id).toBe(MOCK_PROFILE_ID);
      expect(data.interaction_count).toBe(1);
    });

    it("processFeedbackが正しいパラメータで呼ばれる", async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const feedback = [
        {
          sample_id: "11111111-1111-1111-1111-111111111111",
          rating: "positive" as const,
          comment: "テストコメント",
        },
      ];
      const preferenceText = "ミニマルでクリーンなデザインが好みです。シンプルさを重視。";

      await preferenceHearHandler({
        profile_id: MOCK_PROFILE_ID,
        feedback,
        preference_text: preferenceText,
      });

      expect(mockService.processFeedback).toHaveBeenCalledWith(
        MOCK_PROFILE_ID,
        feedback,
        preferenceText
      );
    });
  });

  // =====================================================
  // バリデーションエラーテスト
  // =====================================================

  describe("バリデーションエラー", () => {
    it("無効なprofile_idでエラーを返す", async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({
        profile_id: "invalid-uuid",
      });

      expect(result).toHaveProperty("success", false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR);
    });

    it("無効なratingでエラーを返す", async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({
        profile_id: MOCK_PROFILE_ID,
        feedback: [
          {
            sample_id: "11111111-1111-1111-1111-111111111111",
            rating: "love", // 無効
          },
        ],
        preference_text: "テストテキストです。少なくとも10文字必要。",
      });

      expect(result).toHaveProperty("success", false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR);
    });
  });

  // =====================================================
  // サービス未設定テスト
  // =====================================================

  describe("サービス未設定", () => {
    it("サービスファクトリ未設定でエラーを返す", async () => {
      // resetPreferenceServiceFactory() は beforeEach で実行済み

      const result = await preferenceHearHandler({});

      expect(result).toHaveProperty("success", false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.SERVICE_UNAVAILABLE);
    });
  });

  // =====================================================
  // サービスエラーテスト
  // =====================================================

  describe("サービスエラー", () => {
    it("getSamplesでエラーが発生した場合、エラーレスポンスを返す", async () => {
      const mockService = createMockService({
        getSamples: vi.fn().mockRejectedValue(new Error("Database connection failed")),
      });
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({});

      expect(result).toHaveProperty("success", false);
      const error = (result as { success: false; error: { code: string; message: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.INTERNAL_ERROR);
      expect(error.message).toBe("An internal error occurred");
    });

    it("processFeedbackでエラーが発生した場合、エラーレスポンスを返す", async () => {
      const mockService = createMockService({
        processFeedback: vi.fn().mockRejectedValue(new Error("Embedding generation failed")),
      });
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceHearHandler({
        profile_id: MOCK_PROFILE_ID,
        feedback: [
          {
            sample_id: "11111111-1111-1111-1111-111111111111",
            rating: "positive",
          },
        ],
        preference_text: "テストテキストです。少なくとも10文字必要。",
      });

      expect(result).toHaveProperty("success", false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.EMBEDDING_FAILED);
    });
  });
});
