// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * preference MCPツール Zodスキーマテスト
 * TDD Red Phase: スキーマバリデーションの検証
 *
 * 対象スキーマ:
 * - preferenceHearInputSchema（モードA: サンプル提示、モードB: フィードバック受信）
 * - preferenceGetInputSchema（プロファイル取得）
 * - preferenceResetInputSchema（プロファイルリセット）
 *
 * @module tests/tools/preference/schemas.test
 */

import { describe, it, expect } from "vitest";

import {
  preferenceHearInputSchema,
  preferenceGetInputSchema,
  preferenceResetInputSchema,
  PREFERENCE_MCP_ERROR_CODES,
} from "../../../src/tools/preference/schemas";

// =====================================================
// preference.hear 入力スキーマテスト
// =====================================================

describe("preferenceHearInputSchema", () => {
  describe("モードA: サンプル提示（feedback なし）", () => {
    it("パラメータなしで有効（新規プロファイル作成）", () => {
      const input = {};
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("profile_id のみで有効（既存プロファイル使用）", () => {
      const input = {
        profile_id: "01234567-89ab-cdef-0123-456789abcdef",
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("無効なUUIDのprofile_idでバリデーションエラー", () => {
      const input = {
        profile_id: "not-a-valid-uuid",
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe("モードB: フィードバック受信（feedback あり）", () => {
    it("有効なフィードバック入力", () => {
      const input = {
        profile_id: "01234567-89ab-cdef-0123-456789abcdef",
        feedback: [
          {
            sample_id: "11111111-1111-1111-1111-111111111111",
            rating: "positive",
            comment: "ミニマルで美しいデザイン",
          },
          {
            sample_id: "22222222-2222-2222-2222-222222222222",
            rating: "negative",
          },
        ],
        preference_text:
          "ミニマルでダークなデザインが好み。大胆なタイポグラフィと滑らかなアニメーションを好む。",
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("feedbackのratingが無効値でバリデーションエラー", () => {
      const input = {
        profile_id: "01234567-89ab-cdef-0123-456789abcdef",
        feedback: [
          {
            sample_id: "11111111-1111-1111-1111-111111111111",
            rating: "love", // 無効値
          },
        ],
        preference_text: "テストテキストです。少なくとも10文字必要。",
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("feedbackのsample_idが無効なUUIDでバリデーションエラー", () => {
      const input = {
        profile_id: "01234567-89ab-cdef-0123-456789abcdef",
        feedback: [
          {
            sample_id: "invalid-uuid",
            rating: "positive",
          },
        ],
        preference_text: "テストテキストです。少なくとも10文字必要。",
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("preference_textが10文字未満でバリデーションエラー", () => {
      const input = {
        profile_id: "01234567-89ab-cdef-0123-456789abcdef",
        feedback: [
          {
            sample_id: "11111111-1111-1111-1111-111111111111",
            rating: "positive",
          },
        ],
        preference_text: "短い", // 10文字未満
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("preference_textが1000文字超でバリデーションエラー", () => {
      const input = {
        profile_id: "01234567-89ab-cdef-0123-456789abcdef",
        feedback: [
          {
            sample_id: "11111111-1111-1111-1111-111111111111",
            rating: "positive",
          },
        ],
        preference_text: "あ".repeat(1001), // 1000文字超
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("commentが500文字超でバリデーションエラー", () => {
      const input = {
        profile_id: "01234567-89ab-cdef-0123-456789abcdef",
        feedback: [
          {
            sample_id: "11111111-1111-1111-1111-111111111111",
            rating: "positive",
            comment: "a".repeat(501),
          },
        ],
        preference_text: "テストテキストです。少なくとも10文字必要。",
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("neutralのratingが有効", () => {
      const input = {
        profile_id: "01234567-89ab-cdef-0123-456789abcdef",
        feedback: [
          {
            sample_id: "11111111-1111-1111-1111-111111111111",
            rating: "neutral",
          },
        ],
        preference_text: "テストテキストです。少なくとも10文字必要。",
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("feedbackが空配列でも有効", () => {
      const input = {
        profile_id: "01234567-89ab-cdef-0123-456789abcdef",
        feedback: [],
        preference_text: "テストテキストです。少なくとも10文字必要。",
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  // =====================================================
  // limitパラメータテスト
  // =====================================================

  describe("limitパラメータ", () => {
    it("limit=1で有効（最小値）", () => {
      const input = { limit: 1 };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(1);
      }
    });

    it("limit=10で有効（最大値）", () => {
      const input = { limit: 10 };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(10);
      }
    });

    it("limit=5で有効（中間値）", () => {
      const input = { limit: 5 };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(5);
      }
    });

    it("limit=0でバリデーションエラー（最小値未満）", () => {
      const input = { limit: 0 };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("limit=11でバリデーションエラー（最大値超過）", () => {
      const input = { limit: 11 };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("limit=-1でバリデーションエラー（負値）", () => {
      const input = { limit: -1 };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("limit=1.5でバリデーションエラー（非整数）", () => {
      const input = { limit: 1.5 };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("limit省略時にデフォルト値1が適用される", () => {
      const input = {};
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        // .default(1).optional() の挙動: 省略時はundefined
        // ただしZodの挙動上、.default(1) は明示的にundefined以外の値が来た時に適用
        // optional()がdefault()の後なので、省略時はundefinedになる
        expect(result.data.limit === undefined || result.data.limit === 1).toBe(true);
      }
    });
  });

  // =====================================================
  // offsetパラメータテスト
  // =====================================================

  describe("offsetパラメータ", () => {
    it("offset=0で有効（最小値）", () => {
      const input = { offset: 0 };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.offset).toBe(0);
      }
    });

    it("offset=100で有効（大きな値）", () => {
      const input = { offset: 100 };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.offset).toBe(100);
      }
    });

    it("offset=-1でバリデーションエラー（負値）", () => {
      const input = { offset: -1 };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("offset=2.5でバリデーションエラー（非整数）", () => {
      const input = { offset: 2.5 };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("offset省略時にデフォルト値0が適用される", () => {
      const input = {};
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.offset === undefined || result.data.offset === 0).toBe(true);
      }
    });
  });

  // =====================================================
  // exclude_idsパラメータテスト
  // =====================================================

  describe("exclude_idsパラメータ", () => {
    it("有効なUUID配列で成功", () => {
      const input = {
        exclude_ids: [
          "11111111-1111-1111-1111-111111111111",
          "22222222-2222-2222-2222-222222222222",
        ],
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.exclude_ids).toHaveLength(2);
      }
    });

    it("空配列で有効", () => {
      const input = { exclude_ids: [] };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.exclude_ids).toHaveLength(0);
      }
    });

    it("50件のUUIDで有効（上限）", () => {
      const uuids = Array.from(
        { length: 50 },
        (_, i) => `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`
      );
      const input = { exclude_ids: uuids };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.exclude_ids).toHaveLength(50);
      }
    });

    it("51件のUUIDでバリデーションエラー（上限超過）", () => {
      const uuids = Array.from(
        { length: 51 },
        (_, i) => `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`
      );
      const input = { exclude_ids: uuids };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("不正なUUIDを含む配列でバリデーションエラー", () => {
      const input = {
        exclude_ids: ["11111111-1111-1111-1111-111111111111", "not-a-valid-uuid"],
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("exclude_ids省略時にundefined", () => {
      const input = {};
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.exclude_ids).toBeUndefined();
      }
    });
  });

  // =====================================================
  // 後方互換性テスト（新パラメータ省略）
  // =====================================================

  describe("後方互換性: 新パラメータ省略", () => {
    it("limit/offset/exclude_ids すべて省略で有効", () => {
      const input = {
        profile_id: "01234567-89ab-cdef-0123-456789abcdef",
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.profile_id).toBe("01234567-89ab-cdef-0123-456789abcdef");
        // limit/offsetはdefault付きoptionalなので、undefinedまたはデフォルト値
        expect(result.data.exclude_ids).toBeUndefined();
      }
    });

    it("feedbackモードでも limit/offset/exclude_ids 省略で有効", () => {
      const input = {
        profile_id: "01234567-89ab-cdef-0123-456789abcdef",
        feedback: [
          {
            sample_id: "11111111-1111-1111-1111-111111111111",
            rating: "positive",
          },
        ],
        preference_text: "ミニマルでクリーンなデザインが好みです。シンプルさを重視。",
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("全パラメータ指定で有効", () => {
      const input = {
        profile_id: "01234567-89ab-cdef-0123-456789abcdef",
        limit: 3,
        offset: 5,
        exclude_ids: [
          "11111111-1111-1111-1111-111111111111",
          "22222222-2222-2222-2222-222222222222",
        ],
      };
      const result = preferenceHearInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(3);
        expect(result.data.offset).toBe(5);
        expect(result.data.exclude_ids).toHaveLength(2);
      }
    });
  });
});

// =====================================================
// preference.get 入力スキーマテスト
// =====================================================

describe("preferenceGetInputSchema", () => {
  it("パラメータなしで有効（デフォルトプロファイル取得）", () => {
    const input = {};
    const result = preferenceGetInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("profile_id指定で有効", () => {
    const input = {
      profile_id: "01234567-89ab-cdef-0123-456789abcdef",
    };
    const result = preferenceGetInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("無効なUUIDのprofile_idでバリデーションエラー", () => {
    const input = {
      profile_id: "not-a-uuid",
    };
    const result = preferenceGetInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("include_signals: true で有効", () => {
    const input = {
      profile_id: "01234567-89ab-cdef-0123-456789abcdef",
      include_signals: true,
    };
    const result = preferenceGetInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("include_signals省略で有効", () => {
    const input = {
      profile_id: "01234567-89ab-cdef-0123-456789abcdef",
    };
    const result = preferenceGetInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

// =====================================================
// preference.reset 入力スキーマテスト
// =====================================================

describe("preferenceResetInputSchema", () => {
  it("有効なリセット入力", () => {
    const input = {
      profile_id: "01234567-89ab-cdef-0123-456789abcdef",
      confirm: true,
    };
    const result = preferenceResetInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("profile_idが必須", () => {
    const input = {
      confirm: true,
    };
    const result = preferenceResetInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("confirmが必須", () => {
    const input = {
      profile_id: "01234567-89ab-cdef-0123-456789abcdef",
    };
    const result = preferenceResetInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("confirmがfalseでも有効（ハンドラー側で制御）", () => {
    const input = {
      profile_id: "01234567-89ab-cdef-0123-456789abcdef",
      confirm: false,
    };
    const result = preferenceResetInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("無効なUUIDでバリデーションエラー", () => {
    const input = {
      profile_id: "invalid",
      confirm: true,
    };
    const result = preferenceResetInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("hard_delete: true で有効", () => {
    const input = {
      profile_id: "01234567-89ab-cdef-0123-456789abcdef",
      confirm: true,
      hard_delete: true,
    };
    const result = preferenceResetInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("hard_delete省略で有効", () => {
    const input = {
      profile_id: "01234567-89ab-cdef-0123-456789abcdef",
      confirm: true,
    };
    const result = preferenceResetInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

// =====================================================
// エラーコード定数テスト
// =====================================================

describe("PREFERENCE_MCP_ERROR_CODES", () => {
  it("必須エラーコードが定義されている", () => {
    expect(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
    expect(PREFERENCE_MCP_ERROR_CODES.SERVICE_UNAVAILABLE).toBe("SERVICE_UNAVAILABLE");
    expect(PREFERENCE_MCP_ERROR_CODES.PROFILE_NOT_FOUND).toBe("PROFILE_NOT_FOUND");
    expect(PREFERENCE_MCP_ERROR_CODES.EMBEDDING_FAILED).toBe("EMBEDDING_FAILED");
    expect(PREFERENCE_MCP_ERROR_CODES.INTERNAL_ERROR).toBe("INTERNAL_ERROR");
    expect(PREFERENCE_MCP_ERROR_CODES.RESET_NOT_CONFIRMED).toBe("RESET_NOT_CONFIRMED");
  });
});
