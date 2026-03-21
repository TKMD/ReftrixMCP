// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * preference.hear MCPツール
 * ユーザー嗜好ヒアリングセッション
 *
 * モードA: feedbackなし → DBから代表的なWebデザインサンプルを提示
 * モードB: feedbackあり → フィードバックを受信し、嗜好プロファイルを更新
 *
 * preference.hear MCP tool
 * User preference hearing session
 *
 * Mode A: no feedback → present representative web design samples from DB
 * Mode B: feedback present → receive feedback and update preference profile
 *
 * @module tools/preference/hear.tool
 */

import { ZodError } from "zod";
import { logger, isDevelopment } from "../../utils/logger";
import {
  preferenceHearInputSchema,
  PREFERENCE_MCP_ERROR_CODES,
  sanitizeErrorMessage,
  truncateId,
  type PreferenceHearInput,
  type FeedbackItem,
} from "./schemas";

// =====================================================
// 型定義 / Type Definitions
// =====================================================

/**
 * サンプル項目（モードAレスポンス）
 * Sample item (Mode A response)
 */
export interface PreferenceSample {
  id: string;
  url: string;
  mood_category: string;
  mood_description: string;
  overall_tone: string;
  screenshot_available: boolean;
}

/**
 * ヒアリング進捗情報
 * Hearing progress information
 */
export interface HearingProgress {
  /** 信頼度（0.0-1.0） / Confidence score (0.0-1.0) */
  confidence: number;
  /** 推定残り質問数 / Estimated remaining questions */
  estimated_remaining: number;
  /** 増減理由の説明テキスト / Reason for remaining estimate */
  remaining_reason: string;
  /** ヒアリング継続すべきか / Whether hearing should continue */
  should_continue: boolean;
  /** 評価済みMoodCategory数 / Number of evaluated MoodCategories */
  mood_categories_covered: number;
  /** 有効MoodCategory総数 / Total number of valid MoodCategories */
  mood_categories_total: number;
}

/**
 * サンプル取得オプション（モードA）
 * Options for getting samples (Mode A)
 */
export interface GetSamplesOptions {
  /** プロファイルID / Profile ID */
  profileId?: string | undefined;
  /** 返却サンプル数 / Number of samples to return */
  limit?: number | undefined;
  /** スキップ数 / Number of samples to skip */
  offset?: number | undefined;
  /** 除外するサンプルID配列 / Sample IDs to exclude */
  excludeIds?: string[] | undefined;
}

/**
 * GDPR Art.13/14 準拠プロファイリング通知
 * GDPR Art.13/14 compliant profiling notice
 */
export interface ProfilingNotice {
  /** 通知メッセージ（日英バイリンガル） / Notice message (ja/en bilingual) */
  message: string;
  /** プロファイリング目的 / Profiling purpose */
  purpose: string;
  /** データ削除方法 / Data deletion method */
  deletion_method: string;
  /** データ保持ポリシー / Data retention policy */
  retention_policy: string;
}

/**
 * モードAレスポンスデータ
 * Mode A response data
 */
export interface SamplesResult {
  profile_id: string;
  samples: PreferenceSample[];
  /** ヒアリング進捗情報 / Hearing progress information */
  progress: HearingProgress;
  /** GDPR プロファイリング通知（新規プロファイル作成時のみ） / GDPR profiling notice (only on new profile creation) */
  profiling_notice?: ProfilingNotice;
}

/**
 * モードBレスポンスデータ
 * Mode B response data
 */
export interface FeedbackResult {
  updated: boolean;
  profile_id: string;
  interaction_count: number;
}

/**
 * プロファイルデータ
 * Profile data
 */
export interface ProfileData {
  profile_id: string;
  name: string;
  preference_text: string | null;
  interaction_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * リセット結果
 * Reset result
 */
export interface ResetResult {
  reset: boolean;
  profile_id: string;
}

/**
 * 削除結果（GDPR忘れられる権利）
 * Delete result (GDPR Right to Erasure)
 */
export interface DeleteResult {
  deleted: boolean;
  profile_id: string;
}

/**
 * シグナルデータ（GDPRデータポータビリティ）
 * Signal data (GDPR data portability)
 */
export interface SignalData {
  id: string;
  signal_type: string;
  signal_weight: number;
  target_type: string;
  target_id: string;
  feedback_text: string | null;
  created_at: string;
}

/**
 * preference サービスインターフェース（DI用）
 * preference service interface (for DI)
 */
export interface IPreferenceService {
  /**
   * 代表的なサンプルを取得
   * Get representative samples
   */
  getSamples: (options?: GetSamplesOptions) => Promise<SamplesResult>;

  /**
   * フィードバックを処理してプロファイルを更新
   * Process feedback and update profile
   */
  processFeedback: (
    profileId: string,
    feedback: FeedbackItem[],
    preferenceText: string
  ) => Promise<FeedbackResult>;

  /**
   * プロファイルを取得
   * Get profile
   */
  getProfile: (profileId?: string) => Promise<ProfileData | null>;

  /**
   * プロファイルをリセット
   * Reset profile
   */
  resetProfile: (profileId: string) => Promise<ResetResult>;

  /**
   * プロファイルを完全削除（GDPR忘れられる権利）
   * Delete profile permanently (GDPR Right to Erasure)
   */
  deleteProfile: (profileId: string) => Promise<DeleteResult>;

  /**
   * シグナルを取得（GDPRデータポータビリティ）
   * Get signals (GDPR data portability)
   */
  getSignals: (profileId: string) => Promise<SignalData[]>;
}

/**
 * preference.hear 出力型
 * preference.hear output type
 */
export type PreferenceHearOutput =
  | {
      success: true;
      data: SamplesResult | FeedbackResult;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

// =====================================================
// サービスファクトリー（DI） / Service Factory (DI)
// =====================================================

let preferenceServiceFactory: (() => IPreferenceService) | null = null;

/**
 * サービスファクトリーを設定
 * Set service factory
 */
export function setPreferenceServiceFactory(factory: () => IPreferenceService): void {
  preferenceServiceFactory = factory;
}

/**
 * サービスファクトリーをリセット
 * Reset service factory
 */
export function resetPreferenceServiceFactory(): void {
  preferenceServiceFactory = null;
}

// =====================================================
// エラーコード判定 / Error Code Mapping
// =====================================================

/**
 * エラーからエラーコードを判定
 * Map error to error code
 */
function mapErrorToCode(error: Error): string {
  const message = error.message.toLowerCase();

  if (message.includes("embedding")) {
    return PREFERENCE_MCP_ERROR_CODES.EMBEDDING_FAILED;
  }

  if (message.includes("profile not found") || message.includes("not found")) {
    return PREFERENCE_MCP_ERROR_CODES.PROFILE_NOT_FOUND;
  }

  return PREFERENCE_MCP_ERROR_CODES.INTERNAL_ERROR;
}

// =====================================================
// メインハンドラー / Main Handler
// =====================================================

/**
 * preference.hear ツールハンドラー
 * preference.hear tool handler
 *
 * @param input - 入力パラメータ / Input parameters
 * @returns ヒアリング結果 / Hearing result
 */
export async function preferenceHearHandler(input: unknown): Promise<PreferenceHearOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] preference.hear called", {
      hasFeedback: !!(input as Record<string, unknown>)?.feedback,
    });
  }

  // 入力バリデーション / Input validation
  let validated: PreferenceHearInput;
  try {
    validated = preferenceHearInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");

      logger.warn("[MCP Tool] preference.hear validation error", {
        errors: error.errors,
      });

      return {
        success: false,
        error: {
          code: PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // サービスファクトリーチェック / Service factory check
  if (!preferenceServiceFactory) {
    logger.warn("[MCP Tool] preference.hear service factory not set");

    return {
      success: false,
      error: {
        code: PREFERENCE_MCP_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "Preference service is not available",
      },
    };
  }

  const service = preferenceServiceFactory();

  try {
    // モード判定: feedbackの有無で分岐
    // Mode determination: branch on feedback presence
    if (
      validated.feedback &&
      validated.feedback.length > 0 &&
      validated.preference_text &&
      validated.profile_id
    ) {
      // モードB: フィードバック受信 / Mode B: Receive feedback
      if (isDevelopment()) {
        logger.info("[MCP Tool] preference.hear Mode B: processing feedback", {
          feedbackCount: validated.feedback.length,
          preferenceTextLength: validated.preference_text.length,
        });
      }

      const result = await service.processFeedback(
        validated.profile_id,
        validated.feedback,
        validated.preference_text
      );

      if (isDevelopment()) {
        logger.info("[MCP Tool] preference.hear Mode B completed", {
          profileId: truncateId(result.profile_id),
          interactionCount: result.interaction_count,
        });
      }

      return {
        success: true,
        data: result,
      };
    } else {
      // モードA: サンプル提示 / Mode A: Present samples
      if (isDevelopment()) {
        logger.info("[MCP Tool] preference.hear Mode A: getting samples", {
          profileId: truncateId(validated.profile_id),
          limit: validated.limit,
          offset: validated.offset,
          excludeIds: validated.exclude_ids,
        });
      }

      const result = await service.getSamples({
        profileId: validated.profile_id,
        limit: validated.limit,
        offset: validated.offset,
        excludeIds: validated.exclude_ids,
      });

      if (isDevelopment()) {
        logger.info("[MCP Tool] preference.hear Mode A completed", {
          profileId: truncateId(result.profile_id),
          sampleCount: result.samples.length,
        });
      }

      return {
        success: true,
        data: result,
      };
    }
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));
    const errorCode = mapErrorToCode(errorInstance);

    // 全環境でログ出力（isDevelopmentガードなし）
    // Log in all environments (no isDevelopment guard)
    logger.warn("[MCP Tool] preference.hear error", {
      code: errorCode,
      error: errorInstance.message,
    });

    return {
      success: false,
      error: {
        code: errorCode,
        message: sanitizeErrorMessage(errorCode),
      },
    };
  }
}

// =====================================================
// ツール定義 / Tool Definition
// =====================================================

/**
 * preference.hear MCPツール定義
 * preference.hear MCP tool definition
 */
export const preferenceHearToolDefinition = {
  name: "preference.hear",
  description:
    "ユーザー嗜好ヒアリングセッション。feedbackなしでサンプル提示、feedbackありで嗜好プロファイル更新。" +
    "User preference hearing session. Present samples without feedback, update profile with feedback.",
  annotations: {
    title: "Preference Hearing",
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      profile_id: {
        type: "string",
        format: "uuid",
        description: "プロファイルID（省略時は新規作成） / Profile ID (create new if omitted)",
      },
      feedback: {
        type: "array",
        description:
          "フィードバック配列（存在する場合はモードB） / Feedback array (Mode B if present)",
        items: {
          type: "object",
          properties: {
            sample_id: {
              type: "string",
              format: "uuid",
              description: "サンプルID / Sample ID",
            },
            rating: {
              type: "string",
              enum: ["positive", "negative", "neutral"],
              description: "評価 / Rating",
            },
            comment: {
              type: "string",
              maxLength: 500,
              description: "コメント（最大500文字） / Comment (max 500 characters)",
            },
          },
          required: ["sample_id", "rating"],
        },
      },
      preference_text: {
        type: "string",
        minLength: 10,
        maxLength: 1000,
        description:
          "嗜好テキスト（Claudeエージェントが自然言語フィードバックから生成、10-1000文字） / " +
          "Preference text (generated by Claude agent from natural language feedback, 10-1000 chars)",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        default: 1,
        description: "返却サンプル数（デフォルト1件） / Number of samples to return (default 1)",
      },
      offset: {
        type: "integer",
        minimum: 0,
        default: 0,
        description: "スキップ数 / Number of samples to skip",
      },
      exclude_ids: {
        type: "array",
        items: { type: "string", format: "uuid" },
        maxItems: 50,
        description:
          "除外するサンプルID配列（既評価済み） / Sample IDs to exclude (already evaluated)",
      },
    },
  },
};

// =====================================================
// 開発環境ログ / Development Environment Log
// =====================================================

if (isDevelopment()) {
  logger.debug("[preference.hear] Tool module loaded");
}
