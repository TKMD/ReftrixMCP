// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PreferenceProfileService
 * ユーザー嗜好プロファイル管理サービス
 *
 * 機能:
 * - design_narratives + web_pages から代表サンプルを抽出（MoodCategory 多様性保証）
 * - preference_profiles テーブルの CRUD
 * - preference_signals テーブルへのフィードバック記録
 * - preference_text の e5 embedding 生成・保存
 *
 * PreferenceProfileService
 * User preference profile management service
 *
 * Features:
 * - Extract representative samples from design_narratives + web_pages (MoodCategory diversity)
 * - CRUD for preference_profiles table
 * - Record feedback to preference_signals table
 * - Generate and store e5 embedding for preference_text
 *
 * @module services/preference-profile.service
 */

import { isDevelopment, logger } from "../utils/logger";
import type {
  IPreferenceService,
  PreferenceSample,
  ProfilingNotice,
  SamplesResult,
  FeedbackResult,
  ProfileData,
  ResetResult,
  DeleteResult,
  SignalData,
  GetSamplesOptions,
  HearingProgress,
} from "../tools/preference/hear.tool";
import { truncateId, type FeedbackItem } from "../tools/preference/schemas";

// =====================================================
// インターフェース / Interfaces
// =====================================================

/**
 * EmbeddingServiceインターフェース
 * EmbeddingService interface
 */
export interface IEmbeddingService {
  generateEmbedding(text: string, type: "query" | "passage"): Promise<number[]>;
}

/**
 * PrismaClientインターフェース（部分的）
 * PrismaClient interface (partial)
 */
export interface IPrismaClient {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
}

/**
 * design_narratives + web_pages JOIN 結果の行型
 * Row type for design_narratives + web_pages JOIN result
 */
interface NarrativeSampleRow {
  id: string;
  mood_category: string;
  mood_description: string | null;
  overall_tone: string | null;
  wp_url: string;
  wp_screenshot_desktop_url: string | null;
}

/**
 * preference_signals テーブルの行型
 * Row type for preference_signals table
 */
interface PreferenceSignalRow {
  id: string;
  signal_type: string;
  signal_weight: number;
  target_type: string;
  target_id: string;
  feedback_text: string | null;
  created_at: Date;
}

/**
 * confidence計算用: カテゴリカウント行
 * For confidence calculation: category count row
 */
interface MoodCategoryCoverage {
  /** 有効カテゴリ数（5件以上のデータがある） / Valid categories (with 5+ records) */
  total_categories: string | number | bigint;
  /** 評価済みカテゴリ数 / Covered (evaluated) categories */
  covered_categories: string | number | bigint;
}

/**
 * preference_profiles テーブルの行型
 * Row type for preference_profiles table
 */
interface PreferenceProfileRow {
  id: string;
  name: string;
  preference_text: string | null;
  interaction_count: number | bigint;
  created_at: Date;
  updated_at: Date;
}

// =====================================================
// 定数 / Constants
// =====================================================

/** confidence閾値（これ以上なら十分） / Confidence threshold (sufficient when reached) */
const CONFIDENCE_THRESHOLD = 0.8;
/** MoodCategory網羅率の重み / Weight for MoodCategory coverage ratio */
const CATEGORY_COVERAGE_WEIGHT = 0.6;
/** interaction十分性の重み / Weight for interaction sufficiency */
const INTERACTION_SUFFICIENCY_WEIGHT = 0.4;
/** ヒアリング回数ハードキャップ / Hard cap for hearing count */
const MAX_HEARINGS = 15;
/** interaction十分性の分母 / Denominator for interaction sufficiency */
const MIN_INTERACTIONS_FOR_SUFFICIENCY = 5;
/** 1回あたりの平均confidence上昇幅（推定） / Average confidence gain per interaction (estimate) */
const AVG_GAIN_PER_INTERACTION = 0.12;

/** UUID v4/v7 正規表現 / UUID v4/v7 regex */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// =====================================================
// サービスファクトリ（DI用） / Service Factory (DI)
// =====================================================

let embeddingServiceFactory: (() => IEmbeddingService) | null = null;
let prismaClientFactory: (() => IPrismaClient) | null = null;

/**
 * EmbeddingServiceファクトリを設定
 * Set EmbeddingService factory
 */
export function setPreferenceEmbeddingServiceFactory(factory: () => IEmbeddingService): void {
  embeddingServiceFactory = factory;
}

/**
 * EmbeddingServiceファクトリをリセット
 * Reset EmbeddingService factory
 */
export function resetPreferenceEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

/**
 * PrismaClientファクトリを設定
 * Set PrismaClient factory
 */
export function setPreferencePrismaClientFactory(factory: () => IPrismaClient): void {
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット
 * Reset PrismaClient factory
 */
export function resetPreferencePrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =====================================================
// PreferenceProfileService
// =====================================================

/**
 * PreferenceProfileService クラス
 * PreferenceProfileService class
 */
export class PreferenceProfileService implements IPreferenceService {
  private embeddingService: IEmbeddingService | null = null;
  private prismaClient: IPrismaClient | null = null;

  /**
   * EmbeddingServiceを取得
   * Get EmbeddingService
   */
  private getEmbeddingService(): IEmbeddingService {
    if (this.embeddingService) {
      return this.embeddingService;
    }

    if (embeddingServiceFactory) {
      this.embeddingService = embeddingServiceFactory();
      return this.embeddingService;
    }

    throw new Error("EmbeddingService not initialized");
  }

  /**
   * PrismaClientを取得
   * Get PrismaClient
   */
  private getPrismaClient(): IPrismaClient {
    if (this.prismaClient) {
      return this.prismaClient;
    }

    if (prismaClientFactory) {
      this.prismaClient = prismaClientFactory();
      return this.prismaClient;
    }

    throw new Error("PrismaClient not initialized");
  }

  /**
   * 代表的なサンプルを取得（MoodCategory 多様性を保証）
   * Get representative samples (ensure MoodCategory diversity)
   *
   * @param options - サンプル取得オプション / Options for getting samples
   * @returns サンプル結果 / Samples result
   */
  async getSamples(options?: GetSamplesOptions): Promise<SamplesResult> {
    const prisma = this.getPrismaClient();

    // パラメータ取り出し / Extract parameters
    const profileId = options?.profileId;
    const limit = options?.limit ?? 1;
    const offset = options?.offset ?? 0;
    const excludeIds = options?.excludeIds ?? [];

    if (isDevelopment()) {
      logger.info("[PreferenceProfileService] Getting samples", {
        profileId: truncateId(profileId),
        limit,
        offset,
        excludeIdsCount: excludeIds.length,
      });
    }

    // プロファイルIDの取得または作成
    // Get or create profile ID
    let resolvedProfileId = profileId;
    let isNewProfile = false;
    if (!resolvedProfileId) {
      // 新規プロファイル作成 / Create new profile
      const newProfiles = await prisma.$queryRawUnsafe<PreferenceProfileRow[]>(
        `INSERT INTO preference_profiles (name, interaction_count, updated_at)
         VALUES ('default', 0, NOW())
         RETURNING id, name, preference_text, interaction_count, created_at, updated_at`
      );

      const newProfile = newProfiles[0];
      if (!newProfile) {
        throw new Error("Failed to create new preference profile");
      }

      resolvedProfileId = newProfile.id;
      isNewProfile = true;
    }

    // Defense in Depth: サービス層でもUUID形式を再検証
    // Defense in Depth: Re-validate UUID format at service layer
    for (const id of excludeIds) {
      if (!UUID_REGEX.test(id)) {
        throw new Error(`Invalid UUID in exclude_ids: ${id}`);
      }
    }

    // exclude_ids パラメータの構築
    // Build exclude_ids parameter
    // 空配列の場合は null を渡す（SQL側で IS NULL チェック）
    // Pass null for empty array (SQL side checks IS NULL)
    const excludeParam = excludeIds.length > 0 ? `{${excludeIds.join(",")}}` : null;

    // design_narratives から MoodCategory 多様性を保証してサンプル取得
    // 未評価カテゴリを優先し、各カテゴリから1件ずつランダムに選択
    // Get samples from design_narratives with MoodCategory diversity
    // Prioritize uncovered categories, select 1 random sample per category
    const sampleRows = await prisma.$queryRawUnsafe<NarrativeSampleRow[]>(
      `WITH
        covered_categories AS (
          SELECT DISTINCT dn.mood_category
          FROM preference_signals ps
          INNER JOIN design_narratives dn ON dn.id = ps.target_id::uuid
          WHERE ps.profile_id = $2::uuid
          AND ps.signal_type LIKE 'hearing_%'
        ),
        ranked_narratives AS (
          SELECT
            dn.id,
            dn.mood_category,
            dn.mood_description,
            dn.overall_tone,
            wp.url AS wp_url,
            wp.screenshot_desktop_url AS wp_screenshot_desktop_url,
            CASE WHEN cc.mood_category IS NULL THEN 0 ELSE 1 END AS category_priority,
            ROW_NUMBER() OVER (PARTITION BY dn.mood_category ORDER BY RANDOM()) AS rn
          FROM design_narratives dn
          INNER JOIN web_pages wp ON wp.id = dn.web_page_id
          LEFT JOIN covered_categories cc ON cc.mood_category = dn.mood_category
          WHERE dn.mood_category IS NOT NULL
            AND ($1::uuid[] IS NULL OR dn.id != ALL($1::uuid[]))
        )
      SELECT id, mood_category, mood_description, overall_tone, wp_url, wp_screenshot_desktop_url
      FROM ranked_narratives
      WHERE rn = 1
      ORDER BY category_priority, RANDOM()
      LIMIT $3 OFFSET $4`,
      excludeParam,
      resolvedProfileId,
      limit,
      offset
    );

    // サンプルデータに変換 / Convert to sample data
    const samples: PreferenceSample[] = sampleRows.map((row) => ({
      id: row.id,
      url: row.wp_url,
      mood_category: row.mood_category,
      mood_description: row.mood_description ?? "",
      overall_tone: row.overall_tone ?? "",
      screenshot_available: row.wp_screenshot_desktop_url !== null,
    }));

    // confidence計算・progress情報の構築（2因子モデル）
    // Calculate confidence and build progress info (2-factor model)
    const { confidence, coveredCategories, totalCategories, interactionCount } =
      await this.calculateConfidence(resolvedProfileId);
    const estimatedRemaining = this.estimateRemaining(confidence, interactionCount);
    const remainingReason = this.getRemainingReason(
      confidence,
      coveredCategories,
      totalCategories,
      interactionCount
    );
    const shouldContinue = confidence < CONFIDENCE_THRESHOLD && interactionCount < MAX_HEARINGS;

    const progress: HearingProgress = {
      confidence,
      estimated_remaining: estimatedRemaining,
      remaining_reason: remainingReason,
      should_continue: shouldContinue,
      mood_categories_covered: coveredCategories,
      mood_categories_total: totalCategories,
    };

    // GDPR Art.13/14 プロファイリング通知（新規プロファイル作成時のみ）
    // GDPR Art.13/14 profiling notice (only on new profile creation)
    const profilingNotice: ProfilingNotice | undefined = isNewProfile
      ? {
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
        }
      : undefined;

    if (isDevelopment()) {
      logger.info("[PreferenceProfileService] Samples retrieved", {
        profileId: truncateId(resolvedProfileId),
        sampleCount: samples.length,
        moodCategories: [...new Set(samples.map((s) => s.mood_category))],
        progress,
        isNewProfile,
      });
    }

    return {
      profile_id: resolvedProfileId,
      samples,
      progress,
      ...(profilingNotice && { profiling_notice: profilingNotice }),
    };
  }

  // =====================================================
  // Confidence / Progress 計算メソッド
  // Confidence / Progress calculation methods
  // =====================================================

  /**
   * 嗜好プロファイルの信頼度を計算（2因子モデル）
   * Calculate preference profile confidence (2-factor model)
   *
   * 因子1 (重み0.6): MoodCategory網羅率
   * 因子2 (重み0.4): interaction十分性 (min(count/5, 1.0))
   *
   * Factor 1 (weight 0.6): MoodCategory coverage ratio
   * Factor 2 (weight 0.4): interaction sufficiency (min(count/5, 1.0))
   */
  private async calculateConfidence(profileId: string): Promise<{
    confidence: number;
    coveredCategories: number;
    totalCategories: number;
    interactionCount: number;
  }> {
    const prisma = this.getPrismaClient();

    // 有効カテゴリ数（5件以上）+ 評価済みカテゴリ数を一括取得
    // Get valid category count (5+ records) + covered category count in one query
    const coverage = await prisma.$queryRawUnsafe<MoodCategoryCoverage[]>(
      `SELECT
        (SELECT COUNT(DISTINCT mood_category)
         FROM design_narratives
         WHERE mood_category IS NOT NULL
         AND mood_category IN (
           SELECT mood_category FROM design_narratives
           WHERE mood_category IS NOT NULL
           GROUP BY mood_category HAVING COUNT(*) >= 5
         )
        ) AS total_categories,
        (SELECT COUNT(DISTINCT dn.mood_category)
         FROM preference_signals ps
         INNER JOIN design_narratives dn ON dn.id = ps.target_id::uuid
         WHERE ps.profile_id = $1::uuid
         AND ps.signal_type LIKE 'hearing_%'
        ) AS covered_categories`,
      profileId
    );

    const row = coverage[0];
    const totalCategories = Number(row?.total_categories ?? 0);
    const coveredCategories = Number(row?.covered_categories ?? 0);

    // interaction_count取得 / Get interaction_count
    const profiles = await prisma.$queryRawUnsafe<Array<{ interaction_count: number | bigint }>>(
      `SELECT interaction_count FROM preference_profiles WHERE id = $1::uuid`,
      profileId
    );
    const interactionCount = Number(profiles[0]?.interaction_count ?? 0);

    // 2因子confidence計算 / 2-factor confidence calculation
    const categoryCoverage = totalCategories > 0 ? coveredCategories / totalCategories : 0;
    const interactionSufficiency = Math.min(
      interactionCount / MIN_INTERACTIONS_FOR_SUFFICIENCY,
      1.0
    );
    const confidence = Math.min(
      categoryCoverage * CATEGORY_COVERAGE_WEIGHT +
        interactionSufficiency * INTERACTION_SUFFICIENCY_WEIGHT,
      1.0
    );

    return {
      confidence: Math.round(confidence * 100) / 100,
      coveredCategories,
      totalCategories,
      interactionCount,
    };
  }

  /**
   * 推定残りヒアリング回数を計算
   * Estimate remaining hearing count
   */
  private estimateRemaining(confidence: number, interactionCount: number): number {
    if (confidence >= CONFIDENCE_THRESHOLD) return 0;

    const remaining = Math.ceil((CONFIDENCE_THRESHOLD - confidence) / AVG_GAIN_PER_INTERACTION);

    // ハードキャップ: MAX_HEARINGS - 既実行回数
    // Hard cap: MAX_HEARINGS - already executed count
    const maxRemaining = Math.max(MAX_HEARINGS - interactionCount, 0);
    return Math.min(remaining, maxRemaining);
  }

  /**
   * 残りヒアリングの理由を生成（日英バイリンガル）
   * Generate remaining hearing reason (ja/en bilingual)
   */
  private getRemainingReason(
    confidence: number,
    coveredCategories: number,
    totalCategories: number,
    interactionCount: number
  ): string {
    if (confidence >= CONFIDENCE_THRESHOLD) {
      return "嗜好プロファイルの信頼度が十分に高いため、ヒアリングを終了できます。 / Preference profile confidence is sufficient to end the hearing.";
    }

    if (interactionCount >= MAX_HEARINGS) {
      return `ヒアリング上限（${MAX_HEARINGS}回）に達しました。現在の情報で嗜好プロファイルを確定します。 / Hearing limit (${MAX_HEARINGS}) reached. Finalizing preference profile with current data.`;
    }

    const reasons: string[] = [];

    if (totalCategories > 0 && coveredCategories < totalCategories) {
      const uncovered = totalCategories - coveredCategories;
      reasons.push(
        `未評価のデザインカテゴリが${uncovered}/${totalCategories}件あります / ${uncovered}/${totalCategories} design categories not yet evaluated`
      );
    }

    if (interactionCount < 3) {
      reasons.push(
        `フィードバック数が少なく（${interactionCount}/3）、傾向の把握に追加データが必要です / Feedback count is low (${interactionCount}/3), more data needed to identify trends`
      );
    }

    if (reasons.length === 0) {
      reasons.push(
        `嗜好の精度向上のため、追加のフィードバックが有効です（信頼度: ${Math.round(confidence * 100)}%） / Additional feedback would improve accuracy (confidence: ${Math.round(confidence * 100)}%)`
      );
    }

    return reasons.join(" / ");
  }

  /**
   * フィードバックを処理してプロファイルを更新
   * Process feedback and update profile
   *
   * @param profileId - プロファイルID / Profile ID
   * @param feedback - フィードバック配列 / Feedback array
   * @param preferenceText - 嗜好テキスト / Preference text
   * @returns フィードバック結果 / Feedback result
   */
  async processFeedback(
    profileId: string,
    feedback: FeedbackItem[],
    preferenceText: string
  ): Promise<FeedbackResult> {
    const prisma = this.getPrismaClient();

    if (isDevelopment()) {
      logger.info("[PreferenceProfileService] Processing feedback", {
        profileId: truncateId(profileId),
        feedbackCount: feedback.length,
        preferenceTextLength: preferenceText.length,
      });
    }

    // 1. preference_text を e5 embedding 化
    //    Generate e5 embedding for preference_text
    let embeddingVector: number[];
    try {
      const embeddingService = this.getEmbeddingService();
      embeddingVector = await embeddingService.generateEmbedding(preferenceText, "passage");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Embedding generation failed: ${message}`);
    }

    // NaN/Infinity防御（embeddingVector検証） / NaN/Infinity defense (embeddingVector validation)
    for (const val of embeddingVector) {
      if (!Number.isFinite(val)) {
        throw new Error("Embedding contains non-finite values (NaN or Infinity)");
      }
    }

    // 2. preference_profiles テーブルの更新
    //    Update preference_profiles table
    const vectorString = `[${embeddingVector.join(",")}]`;
    await prisma.$executeRawUnsafe(
      `UPDATE preference_profiles
       SET preference_text = $1,
           preference_embedding = $2::vector,
           interaction_count = interaction_count + 1,
           updated_at = NOW()
       WHERE id = $3::uuid`,
      preferenceText,
      vectorString,
      profileId
    );

    // 3. preference_signals テーブルに各フィードバックを記録
    //    Record each feedback to preference_signals table
    for (const item of feedback) {
      const signalType = `hearing_${item.rating}`;
      const signalWeight =
        item.rating === "positive" ? 1.0 : item.rating === "negative" ? -0.5 : 0.0;

      await prisma.$executeRawUnsafe(
        `INSERT INTO preference_signals (profile_id, signal_type, signal_weight, target_type, target_id, feedback_text)
         VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6)`,
        profileId,
        signalType,
        signalWeight,
        "web_page",
        item.sample_id,
        item.comment ?? null
      );
    }

    // 4. 更新後の interaction_count を取得
    //    Get updated interaction_count
    const updatedProfiles = await prisma.$queryRawUnsafe<
      Array<{ interaction_count: number | bigint }>
    >(`SELECT interaction_count FROM preference_profiles WHERE id = $1::uuid`, profileId);

    const updatedProfile = updatedProfiles[0];
    const interactionCount = updatedProfile ? Number(updatedProfile.interaction_count) : 1;

    if (isDevelopment()) {
      logger.info("[PreferenceProfileService] Feedback processed", {
        profileId: truncateId(profileId),
        interactionCount,
        feedbackRecorded: feedback.length,
      });
    }

    return {
      updated: true,
      profile_id: profileId,
      interaction_count: interactionCount,
    };
  }

  /**
   * プロファイルを取得
   * Get profile
   *
   * @param profileId - プロファイルID（省略時はデフォルト） / Profile ID (default if omitted)
   * @returns プロファイルデータまたはnull / Profile data or null
   */
  async getProfile(profileId?: string): Promise<ProfileData | null> {
    const prisma = this.getPrismaClient();

    if (isDevelopment()) {
      logger.info("[PreferenceProfileService] Getting profile", {
        profileId: truncateId(profileId),
      });
    }

    let profiles: PreferenceProfileRow[];
    if (profileId) {
      profiles = await prisma.$queryRawUnsafe<PreferenceProfileRow[]>(
        `SELECT id, name, preference_text, interaction_count, created_at, updated_at
         FROM preference_profiles
         WHERE id = $1::uuid`,
        profileId
      );
    } else {
      // デフォルトプロファイル取得（name = 'default'、最新のもの）
      // Get default profile (name = 'default', latest)
      profiles = await prisma.$queryRawUnsafe<PreferenceProfileRow[]>(
        `SELECT id, name, preference_text, interaction_count, created_at, updated_at
         FROM preference_profiles
         WHERE name = 'default'
         ORDER BY created_at DESC
         LIMIT 1`
      );
    }

    const profile = profiles[0];
    if (!profile) {
      return null;
    }

    return {
      profile_id: profile.id,
      name: profile.name,
      preference_text: profile.preference_text,
      interaction_count: Number(profile.interaction_count),
      created_at:
        profile.created_at instanceof Date
          ? profile.created_at.toISOString()
          : String(profile.created_at),
      updated_at:
        profile.updated_at instanceof Date
          ? profile.updated_at.toISOString()
          : String(profile.updated_at),
    };
  }

  /**
   * プロファイルをリセット
   * Reset profile
   *
   * @param profileId - プロファイルID / Profile ID
   * @returns リセット結果 / Reset result
   */
  async resetProfile(profileId: string): Promise<ResetResult> {
    const prisma = this.getPrismaClient();

    if (isDevelopment()) {
      logger.info("[PreferenceProfileService] Resetting profile", {
        profileId: truncateId(profileId),
      });
    }

    // プロファイル存在確認 / Check profile existence
    const existing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM preference_profiles WHERE id = $1::uuid`,
      profileId
    );

    if (existing.length === 0) {
      throw new Error("Profile not found");
    }

    // preference_signals は CASCADE で削除される想定
    // preference_signals are expected to be CASCADE deleted
    // ただし明示的に削除も実行（CASCADEが設定されていない場合の安全策）
    // But also delete explicitly (safety measure in case CASCADE is not configured)
    await prisma.$executeRawUnsafe(
      `DELETE FROM preference_signals WHERE profile_id = $1::uuid`,
      profileId
    );

    // プロファイルをリセット（embedding と text をクリア、interaction_count を 0 に）
    // Reset profile (clear embedding and text, set interaction_count to 0)
    await prisma.$executeRawUnsafe(
      `UPDATE preference_profiles
       SET preference_text = NULL,
           preference_embedding = NULL,
           interaction_count = 0,
           updated_at = NOW()
       WHERE id = $1::uuid`,
      profileId
    );

    if (isDevelopment()) {
      logger.info("[PreferenceProfileService] Profile reset completed", {
        profileId: truncateId(profileId),
      });
    }

    return {
      reset: true,
      profile_id: profileId,
    };
  }

  /**
   * プロファイルを完全削除（GDPR忘れられる権利）
   * Delete profile permanently (GDPR Right to Erasure)
   *
   * @param profileId - プロファイルID / Profile ID
   * @returns 削除結果 / Delete result
   */
  async deleteProfile(profileId: string): Promise<DeleteResult> {
    const prisma = this.getPrismaClient();

    // 全環境で監査ログ出力（不可逆操作の証跡、isDevelopmentガードなし）
    // Audit log in all environments (irreversible operation trail, no isDevelopment guard)
    logger.warn("[PreferenceProfileService] Deleting profile (hard delete / GDPR erasure)", {
      profileId: truncateId(profileId),
      action: "hard_delete",
    });

    // プロファイル存在確認 / Check profile existence
    const existing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM preference_profiles WHERE id = $1::uuid`,
      profileId
    );

    if (existing.length === 0) {
      throw new Error("Profile not found");
    }

    // シグナルを先に削除（CASCADEが設定されていない場合の安全策）
    // Delete signals first (safety measure in case CASCADE is not configured)
    await prisma.$executeRawUnsafe(
      `DELETE FROM preference_signals WHERE profile_id = $1::uuid`,
      profileId
    );

    // プロファイルを完全削除 / Permanently delete profile
    await prisma.$executeRawUnsafe(
      `DELETE FROM preference_profiles WHERE id = $1::uuid`,
      profileId
    );

    // 全環境で監査ログ出力（不可逆操作完了の証跡）
    // Audit log in all environments (irreversible operation completion trail)
    logger.warn("[PreferenceProfileService] Profile hard delete completed (GDPR erasure)", {
      profileId: truncateId(profileId),
      action: "hard_delete_completed",
    });

    return {
      deleted: true,
      profile_id: profileId,
    };
  }

  /**
   * シグナルを取得（GDPRデータポータビリティ）
   * Get signals (GDPR data portability)
   *
   * @param profileId - プロファイルID / Profile ID
   * @returns シグナルデータ配列 / Signal data array
   */
  async getSignals(profileId: string): Promise<SignalData[]> {
    const prisma = this.getPrismaClient();

    if (isDevelopment()) {
      logger.info("[PreferenceProfileService] Getting signals", {
        profileId: truncateId(profileId),
      });
    }

    const rows = await prisma.$queryRawUnsafe<PreferenceSignalRow[]>(
      `SELECT id, signal_type, signal_weight, target_type, target_id, feedback_text, created_at
       FROM preference_signals
       WHERE profile_id = $1::uuid
       ORDER BY created_at DESC`,
      profileId
    );

    return rows.map((row) => ({
      id: row.id,
      signal_type: row.signal_type,
      signal_weight: Number(row.signal_weight),
      target_type: row.target_type,
      target_id: row.target_id,
      feedback_text: row.feedback_text,
      created_at:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
  }
}

// =====================================================
// シングルトンインスタンス / Singleton Instance
// =====================================================

let preferenceProfileServiceInstance: PreferenceProfileService | null = null;

/**
 * PreferenceProfileServiceインスタンスを取得
 * Get PreferenceProfileService instance
 */
export function getPreferenceProfileService(): PreferenceProfileService {
  if (!preferenceProfileServiceInstance) {
    preferenceProfileServiceInstance = new PreferenceProfileService();
  }
  return preferenceProfileServiceInstance;
}

/**
 * PreferenceProfileServiceインスタンスをリセット
 * Reset PreferenceProfileService instance
 */
export function resetPreferenceProfileService(): void {
  preferenceProfileServiceInstance = null;
}

/**
 * PreferenceProfileServiceファクトリを作成
 * Create PreferenceProfileService factory
 */
export function createPreferenceProfileServiceFactory(): () => IPreferenceService {
  return () => getPreferenceProfileService();
}

export default PreferenceProfileService;
