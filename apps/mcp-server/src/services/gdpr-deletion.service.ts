// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GdprDeletionService
 * GDPR Art.17「忘れられる権利」全テーブル包括的データ削除サービス
 *
 * 機能:
 * - web_pages 起点の全関連テーブル CASCADE DELETE
 * - preference_profiles / preference_signals の完全削除
 * - 全ユーザーデータ一括削除
 * - GDPR Art.20 データポータビリティ（JSON形式エクスポート）
 * - 削除操作の監査ログ記録（PII配慮）
 *
 * GdprDeletionService
 * GDPR Art.17 "Right to Erasure" comprehensive data deletion service
 *
 * Features:
 * - CASCADE DELETE for all tables starting from web_pages
 * - Hard delete for preference_profiles / preference_signals
 * - Bulk delete all user data
 * - GDPR Art.20 data portability (JSON export)
 * - Audit logging for deletion operations (PII-aware)
 *
 * @module services/gdpr-deletion.service
 */

import { logger } from "../utils/logger";
import { truncateId } from "../utils/truncate-id";

// =====================================================
// 定数 / Constants
// =====================================================

/** UUID v4/v7 正規表現 / UUID v4/v7 regex */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 削除対象テーブル一覧（Embedding テーブル → パターンテーブル → コアテーブルの順）
 * Deletion target tables (embedding tables → pattern tables → core tables order)
 *
 * 外部キー制約による依存順序を考慮した削除順序:
 * 1. Embedding テーブル（子テーブル）を先に削除
 * 2. パターンテーブル（中間テーブル）を削除
 * 3. コアテーブル（親テーブル）を最後に削除
 */
const PAGE_RELATED_EMBEDDING_TABLES = [
  "section_embeddings",
  "component_part_embeddings",
  "motion_embeddings",
  "js_animation_embeddings",
  "webgl_animation_embeddings",
  "motion_analysis_embeddings",
  "design_narrative_embeddings",
  "background_design_embeddings",
  "responsive_analysis_embeddings",
  "quality_benchmarks",
] as const;

const PAGE_RELATED_PATTERN_TABLES = [
  "component_parts",
  "section_patterns",
  "motion_patterns",
  "js_animation_patterns",
  "webgl_animation_patterns",
  "motion_analysis_results",
  "design_narratives",
  "background_designs",
  "responsive_analyses",
  "quality_evaluations",
  "design_snapshots", // v0.3.0 T2-DCT: デザインスナップショット（design_snapshot_sections は CASCADE DELETE）
] as const;

// =====================================================
// インターフェース / Interfaces
// =====================================================

/**
 * PrismaClientインターフェース（GDPR削除用）
 * PrismaClient interface (for GDPR deletion)
 */
export interface GdprPrismaClient {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $transaction: <T>(fn: (tx: GdprPrismaClient) => Promise<T>) => Promise<T>;
}

/**
 * ページ削除結果 / Page deletion result
 */
export interface PageDeletionResult {
  deleted: boolean;
  page_id: string;
  reason: string;
  deleted_records: Record<string, number>;
  deleted_at: string;
}

/**
 * プロファイル削除結果 / Profile deletion result
 */
export interface ProfileDeletionResult {
  deleted: boolean;
  profile_id: string;
  reason: string;
  deleted_records: {
    preference_profiles: number;
    preference_signals: number;
    search_logs_anonymized: number;
  };
  deleted_at: string;
}

/**
 * 全ユーザーデータ削除結果 / All user data deletion result
 */
export interface AllUserDataDeletionResult {
  deleted: boolean;
  pages_deleted: number;
  profile_deleted: boolean;
  reason: string;
  deleted_at: string;
}

/**
 * ページデータエクスポート結果 / Page data export result
 */
export interface PageExportResult {
  page_id: string;
  export_format: "json";
  data: {
    web_page: Record<string, unknown>;
    section_patterns: Record<string, unknown>[];
    component_parts: Record<string, unknown>[];
    motion_patterns: Record<string, unknown>[];
    quality_evaluations: Record<string, unknown>[];
    design_narratives: Record<string, unknown>[];
    background_designs: Record<string, unknown>[];
    responsive_analyses: Record<string, unknown>[];
  };
  pii_fields: string[];
  gdpr_notice: string;
  exported_at: string;
}

/**
 * プロファイルデータエクスポート結果 / Profile data export result
 */
export interface ProfileExportResult {
  profile_id: string;
  export_format: "json";
  data: {
    profile: Record<string, unknown>;
    signals: Record<string, unknown>[];
  };
  pii_fields: string[];
  gdpr_notice: string;
  exported_at: string;
}

// =====================================================
// バリデーション / Validation
// =====================================================

/**
 * UUID形式を検証する / Validate UUID format
 */
function validateUuid(id: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new Error("Invalid UUID format");
  }
}

/**
 * 削除理由を検証する / Validate deletion reason
 */
function validateReason(reason: string): void {
  if (!reason || reason.trim().length === 0) {
    throw new Error("Deletion reason is required");
  }
}

// =====================================================
// サービスファクトリ（DI用） / Service Factory (DI)
// =====================================================

let prismaClientFactory: (() => GdprPrismaClient) | null = null;

/**
 * PrismaClientファクトリを設定 / Set PrismaClient factory
 */
export function setGdprPrismaClientFactory(factory: () => GdprPrismaClient): void {
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット / Reset PrismaClient factory
 */
export function resetGdprPrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =====================================================
// GdprDeletionService
// =====================================================

/**
 * GDPR Art.17 データ削除サービス
 * GDPR Art.17 data deletion service
 */
export class GdprDeletionService {
  private prismaClient: GdprPrismaClient | null = null;

  /**
   * PrismaClientを取得 / Get PrismaClient
   */
  private getPrismaClient(): GdprPrismaClient {
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
   * ページと全関連データを削除（GDPR Art.17）
   * Delete page and all related data (GDPR Art.17)
   *
   * @param pageId - 削除対象のページID / Page ID to delete
   * @param reason - 削除理由（監査ログ用） / Deletion reason (for audit log)
   * @returns 削除結果 / Deletion result
   */
  async deletePage(pageId: string, reason: string): Promise<PageDeletionResult> {
    validateUuid(pageId);
    validateReason(reason);

    // 全環境で監査ログ出力（不可逆操作の証跡、isDevelopmentガードなし）
    logger.warn("[GdprDeletionService] Page deletion initiated (GDPR Art.17)", {
      pageId: truncateId(pageId),
      action: "page_delete",
      reason,
    });

    const prisma = this.getPrismaClient();

    const deletedRecords: Record<string, number> = {};

    await prisma.$transaction(async (tx) => {
      // 存在確認 / Check existence
      const existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM web_pages WHERE id = $1::uuid`,
        pageId
      );

      if (existing.length === 0) {
        throw new Error("Page not found");
      }

      // Embedding テーブル削除（子テーブルから先に削除）
      // Delete embedding tables (child tables first)
      for (const table of PAGE_RELATED_EMBEDDING_TABLES) {
        const count = await this.deleteRelatedByWebPageId(tx, table, pageId);
        deletedRecords[table] = count;
      }

      // パターンテーブル削除
      // Delete pattern tables
      for (const table of PAGE_RELATED_PATTERN_TABLES) {
        const count = await this.deleteRelatedByWebPageId(tx, table, pageId);
        deletedRecords[table] = count;
      }

      // web_pages テーブル削除
      // Delete web_pages table
      const pageCount = await tx.$executeRawUnsafe(
        `DELETE FROM web_pages WHERE id = $1::uuid`,
        pageId
      );
      deletedRecords["web_pages"] = pageCount;
    });

    const deletedAt = new Date().toISOString();

    // 監査ログ（完了）
    logger.warn("[GdprDeletionService] Page deletion completed (GDPR Art.17)", {
      pageId: truncateId(pageId),
      action: "page_delete_completed",
      deletedRecords,
      deletedAt,
    });

    return {
      deleted: true,
      page_id: pageId,
      reason,
      deleted_records: deletedRecords,
      deleted_at: deletedAt,
    };
  }

  /**
   * web_page_id をキーに関連テーブルのレコードを削除する
   * Delete related table records by web_page_id
   *
   * テーブル名は定数配列から取得されるため SQLインジェクションリスクなし
   * Table names come from const arrays so no SQL injection risk
   */
  private async deleteRelatedByWebPageId(
    tx: GdprPrismaClient,
    table: string,
    pageId: string
  ): Promise<number> {
    // Embedding テーブルは直接 web_page_id を持たないものがある
    // Some embedding tables don't directly have web_page_id
    // パターンテーブル経由で削除する
    const embeddingParentMap: Record<string, string> = {
      section_embeddings: "section_patterns",
      component_part_embeddings: "component_parts",
      motion_embeddings: "motion_patterns",
      js_animation_embeddings: "js_animation_patterns",
      webgl_animation_embeddings: "webgl_animation_patterns",
      motion_analysis_embeddings: "motion_analysis_results",
      design_narrative_embeddings: "design_narratives",
      background_design_embeddings: "background_designs",
      responsive_analysis_embeddings: "responsive_analyses",
    };

    const embeddingFkMap: Record<string, string> = {
      section_embeddings: "section_pattern_id",
      component_part_embeddings: "component_part_id",
      motion_embeddings: "motion_pattern_id",
      js_animation_embeddings: "js_animation_pattern_id",
      webgl_animation_embeddings: "webgl_animation_pattern_id",
      motion_analysis_embeddings: "motion_analysis_result_id",
      design_narrative_embeddings: "design_narrative_id",
      background_design_embeddings: "background_design_id",
      responsive_analysis_embeddings: "responsive_analysis_id",
    };

    const parentTable = embeddingParentMap[table];
    const fkColumn = embeddingFkMap[table];

    if (parentTable && fkColumn) {
      // Embedding テーブル: 親テーブル経由の副問い合わせで削除
      // Embedding table: delete via subquery through parent table
      return tx.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE ${fkColumn} IN (SELECT id FROM ${parentTable} WHERE web_page_id = $1::uuid)`,
        pageId
      );
    }

    // quality_benchmarks は section_pattern_id + web_page_id で紐づく
    // quality_benchmarks: linked via section_pattern_id + web_page_id
    if (table === "quality_benchmarks") {
      return tx.$executeRawUnsafe(
        `DELETE FROM quality_benchmarks WHERE section_pattern_id IN (SELECT id FROM section_patterns WHERE web_page_id = $1::uuid) OR web_page_id = $1::uuid`,
        pageId
      );
    }

    // quality_evaluations は target_type + target_id で紐づく（web_page_id カラムなし）
    // quality_evaluations: linked via target_type + target_id (no web_page_id column)
    if (table === "quality_evaluations") {
      return tx.$executeRawUnsafe(
        `DELETE FROM quality_evaluations WHERE target_type = 'web_page' AND target_id = $1::uuid`,
        pageId
      );
    }

    // パターンテーブル / コアテーブル: 直接 web_page_id で削除
    // Pattern / core tables: delete directly by web_page_id
    return tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE web_page_id = $1::uuid`, pageId);
  }

  /**
   * 嗜好プロファイルを完全削除（GDPR Art.17）
   * Delete preference profile permanently (GDPR Art.17)
   *
   * @param profileId - 削除対象のプロファイルID / Profile ID to delete
   * @param reason - 削除理由（監査ログ用） / Deletion reason (for audit log)
   * @returns 削除結果 / Deletion result
   */
  async deleteProfile(profileId: string, reason: string): Promise<ProfileDeletionResult> {
    validateUuid(profileId);
    validateReason(reason);

    logger.warn("[GdprDeletionService] Profile deletion initiated (GDPR Art.17)", {
      profileId: truncateId(profileId),
      action: "profile_delete",
      reason,
    });

    const prisma = this.getPrismaClient();
    let signalCount = 0;
    let profileCount = 0;
    let searchLogsAnonymized = 0;

    await prisma.$transaction(async (tx) => {
      // 存在確認 / Check existence
      const existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM preference_profiles WHERE id = $1::uuid`,
        profileId
      );

      if (existing.length === 0) {
        throw new Error("Profile not found");
      }

      // シグナルを先に削除（FK制約） / Delete signals first (FK constraint)
      signalCount = await tx.$executeRawUnsafe(
        `DELETE FROM preference_signals WHERE profile_id = $1::uuid`,
        profileId
      );

      // search_logs の profileId を NULL化（GDPR Art.17 包括的削除）
      // Anonymize search_logs profileId (GDPR Art.17 comprehensive erasure)
      // profileId はtruncateId()済み（8文字+...）のため前方一致で検索
      // profileId is truncated (8 chars + ...) so use prefix match
      const truncatedProfileId = profileId.slice(0, 8) + "%";
      searchLogsAnonymized = await tx.$executeRawUnsafe(
        `UPDATE search_logs SET "profile_id" = NULL WHERE "profile_id" LIKE $1`,
        truncatedProfileId
      );

      // プロファイル削除 / Delete profile
      profileCount = await tx.$executeRawUnsafe(
        `DELETE FROM preference_profiles WHERE id = $1::uuid`,
        profileId
      );
    });

    const deletedAt = new Date().toISOString();

    logger.warn("[GdprDeletionService] Profile deletion completed (GDPR Art.17)", {
      profileId: truncateId(profileId),
      action: "profile_delete_completed",
      deletedRecords: {
        preference_profiles: profileCount,
        preference_signals: signalCount,
        search_logs_anonymized: searchLogsAnonymized,
      },
      deletedAt,
    });

    return {
      deleted: true,
      profile_id: profileId,
      reason,
      deleted_records: {
        preference_profiles: profileCount,
        preference_signals: signalCount,
        search_logs_anonymized: searchLogsAnonymized,
      },
      deleted_at: deletedAt,
    };
  }

  /**
   * 全ユーザーデータを削除（GDPR Art.17 包括的削除）
   * Delete all user data (GDPR Art.17 comprehensive deletion)
   *
   * @param pageIds - 削除対象のページID配列 / Page IDs to delete
   * @param profileId - 削除対象のプロファイルID（省略可） / Profile ID to delete (optional)
   * @param reason - 削除理由 / Deletion reason
   * @returns 削除結果 / Deletion result
   */
  async deleteAllUserData(
    pageIds: string[],
    profileId: string | undefined,
    reason: string
  ): Promise<AllUserDataDeletionResult> {
    validateReason(reason);

    // 全IDのバリデーション / Validate all IDs
    for (const id of pageIds) {
      validateUuid(id);
    }
    if (profileId) {
      validateUuid(profileId);
    }

    logger.warn("[GdprDeletionService] All user data deletion initiated (GDPR Art.17)", {
      pageCount: pageIds.length,
      hasProfile: !!profileId,
      action: "all_user_data_delete",
      reason,
    });

    const prisma = this.getPrismaClient();
    let pagesDeleted = 0;
    let profileDeleted = false;

    await prisma.$transaction(async (tx) => {
      // ページの削除 / Delete pages
      for (const pageId of pageIds) {
        const existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM web_pages WHERE id = $1::uuid`,
          pageId
        );

        if (existing.length > 0) {
          // Embedding テーブル削除
          for (const table of PAGE_RELATED_EMBEDDING_TABLES) {
            await this.deleteRelatedByWebPageId(tx, table, pageId);
          }

          // パターンテーブル削除
          for (const table of PAGE_RELATED_PATTERN_TABLES) {
            await this.deleteRelatedByWebPageId(tx, table, pageId);
          }

          await tx.$executeRawUnsafe(`DELETE FROM web_pages WHERE id = $1::uuid`, pageId);
          pagesDeleted++;
        }
      }

      // プロファイル削除 / Delete profile
      if (profileId) {
        const profileExisting = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM preference_profiles WHERE id = $1::uuid`,
          profileId
        );

        if (profileExisting.length > 0) {
          await tx.$executeRawUnsafe(
            `DELETE FROM preference_signals WHERE profile_id = $1::uuid`,
            profileId
          );

          // search_logs の profileId を NULL化（GDPR Art.17 包括的削除）
          // Anonymize search_logs profileId (GDPR Art.17 comprehensive erasure)
          const truncatedProfileId = profileId.slice(0, 8) + "%";
          await tx.$executeRawUnsafe(
            `UPDATE search_logs SET "profile_id" = NULL WHERE "profile_id" LIKE $1`,
            truncatedProfileId
          );

          await tx.$executeRawUnsafe(
            `DELETE FROM preference_profiles WHERE id = $1::uuid`,
            profileId
          );
          profileDeleted = true;
        }
      }
    });

    const deletedAt = new Date().toISOString();

    logger.warn("[GdprDeletionService] All user data deletion completed (GDPR Art.17)", {
      action: "all_user_data_delete_completed",
      pagesDeleted,
      profileDeleted,
      deletedAt,
    });

    return {
      deleted: true,
      pages_deleted: pagesDeleted,
      profile_deleted: profileDeleted,
      reason,
      deleted_at: deletedAt,
    };
  }

  /**
   * ページ関連データをJSON形式でエクスポート（GDPR Art.20）
   * Export page-related data as JSON (GDPR Art.20)
   *
   * @param pageId - エクスポート対象のページID / Page ID to export
   * @returns エクスポート結果 / Export result
   */
  async exportPageData(pageId: string): Promise<PageExportResult> {
    validateUuid(pageId);

    const prisma = this.getPrismaClient();

    // web_page 取得 / Get web_page
    const pages = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, url, title, source_type, source_platform, usage_scope,
              analysis_status, analysis_phase_status, crawled_at, created_at, updated_at
       FROM web_pages WHERE id = $1::uuid`,
      pageId
    );

    if (pages.length === 0) {
      throw new Error("Page not found");
    }

    // 関連テーブル取得 / Get related tables
    const sectionPatterns = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, section_type, section_name, position_index, layout_info, tags, created_at
       FROM section_patterns WHERE web_page_id = $1::uuid ORDER BY position_index`,
      pageId
    );

    const componentParts = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, part_type, part_subtype, computed_styles, bounding_box, css_classes,
              pii_risk_level, tags, created_at
       FROM component_parts WHERE web_page_id = $1::uuid`,
      pageId
    );

    const motionPatterns = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, name, type, category, trigger_type, animation, tags, created_at
       FROM motion_patterns WHERE web_page_id = $1::uuid`,
      pageId
    );

    const qualityEvaluations = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, target_type, target_id, overall_score, grade, created_at
       FROM quality_evaluations WHERE target_type = 'web_page' AND target_id = $1::uuid`,
      pageId
    );

    const designNarratives = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, mood_category, mood_description, overall_tone, layout_structure, tags, created_at
       FROM design_narratives WHERE web_page_id = $1::uuid`,
      pageId
    );

    const backgroundDesigns = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, design_type, css_value, color_info, created_at
       FROM background_designs WHERE web_page_id = $1::uuid`,
      pageId
    );

    const responsiveAnalyses = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, viewports_analyzed, differences, quality_metrics, created_at
       FROM responsive_analyses WHERE web_page_id = $1::uuid`,
      pageId
    );

    return {
      page_id: pageId,
      export_format: "json",
      data: {
        web_page: pages[0]!,
        section_patterns: sectionPatterns,
        component_parts: componentParts,
        motion_patterns: motionPatterns,
        quality_evaluations: qualityEvaluations,
        design_narratives: designNarratives,
        background_designs: backgroundDesigns,
        responsive_analyses: responsiveAnalyses,
      },
      pii_fields: ["page_id", "url"],
      gdpr_notice:
        "This data is exported under GDPR Art.20 (Right to Data Portability). " +
        "It contains all personal data associated with the specified page. " +
        "このデータはGDPR Art.20（データポータビリティの権利）に基づきエクスポートされました。",
      exported_at: new Date().toISOString(),
    };
  }

  /**
   * プロファイルデータをJSON形式でエクスポート（GDPR Art.20）
   * Export profile data as JSON (GDPR Art.20)
   *
   * @param profileId - エクスポート対象のプロファイルID / Profile ID to export
   * @returns エクスポート結果 / Export result
   */
  async exportProfileData(profileId: string): Promise<ProfileExportResult> {
    validateUuid(profileId);

    const prisma = this.getPrismaClient();

    // プロファイル取得 / Get profile
    const profiles = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, name, preference_text, interaction_count, created_at, updated_at
       FROM preference_profiles WHERE id = $1::uuid`,
      profileId
    );

    if (profiles.length === 0) {
      throw new Error("Profile not found");
    }

    // シグナル取得 / Get signals
    const signals = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, signal_type, signal_weight, target_type, target_id, feedback_text, created_at
       FROM preference_signals WHERE profile_id = $1::uuid ORDER BY created_at DESC`,
      profileId
    );

    return {
      profile_id: profileId,
      export_format: "json",
      data: {
        profile: profiles[0]!,
        signals,
      },
      pii_fields: ["profile_id", "preference_text", "feedback_text"],
      gdpr_notice:
        "This data is exported under GDPR Art.20 (Right to Data Portability). " +
        "It contains all preference profile data and signals. " +
        "このデータはGDPR Art.20（データポータビリティの権利）に基づきエクスポートされました。",
      exported_at: new Date().toISOString(),
    };
  }
}

// =====================================================
// シングルトンインスタンス / Singleton Instance
// =====================================================

let gdprDeletionServiceInstance: GdprDeletionService | null = null;

/**
 * GdprDeletionServiceインスタンスを取得 / Get GdprDeletionService instance
 */
export function getGdprDeletionService(): GdprDeletionService {
  if (!gdprDeletionServiceInstance) {
    gdprDeletionServiceInstance = new GdprDeletionService();
  }
  return gdprDeletionServiceInstance;
}

/**
 * GdprDeletionServiceインスタンスをリセット / Reset GdprDeletionService instance
 */
export function resetGdprDeletionService(): void {
  gdprDeletionServiceInstance = null;
}
