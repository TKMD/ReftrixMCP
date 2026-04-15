// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DesignChangeTrackerService
 * デザイン変更時系列追跡サービス (v0.3.0 T2-DCT)
 *
 * 機能:
 * - createSnapshot: 現在のセクション+embeddingをスナップショットとして保存
 * - compareSnapshots: 2つのスナップショットのembedding diff
 * - getHistory: URL別スナップショット履歴
 * - detectChanges: 最新分析結果と直前スナップショットの差分検出
 *
 * Design Change Temporal Tracking Service (v0.3.0 T2-DCT)
 *
 * Features:
 * - createSnapshot: Save current sections + embeddings as a snapshot
 * - compareSnapshots: Embedding diff between two snapshots
 * - getHistory: Snapshot history per URL
 * - detectChanges: Detect changes between latest analysis and previous snapshot
 *
 * @module services/design-change-tracker.service
 */

import { createDIFactory } from "../utils/di-factory";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { truncateId } from "../utils/truncate-id";
import { cosineSimilarityNullable } from "../utils/vector-math";

// =====================================================
// Constants / 定数
// =====================================================

/** UUID v4/v7 正規表現 / UUID v4/v7 regex */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** URL別スナップショット保持上限 / Max snapshots per URL */
export const DEFAULT_MAX_SNAPSHOTS_PER_URL = 50;

/** エラーコード / Error codes */
export const DESIGN_CHANGE_ERROR_CODES = {
  INVALID_INPUT: "INVALID_INPUT",
  PAGE_NOT_FOUND: "PAGE_NOT_FOUND",
  SNAPSHOT_NOT_FOUND: "SNAPSHOT_NOT_FOUND",
  SNAPSHOT_FAILED: "SNAPSHOT_FAILED",
  COMPARE_FAILED: "COMPARE_FAILED",
  DETECT_FAILED: "DETECT_FAILED",
} as const;

// =====================================================
// DI Interfaces / DI インターフェース
// =====================================================

/**
 * Prismaクライアントインターフェース
 * Prisma client interface for design change tracker
 */
export interface DesignChangeTrackerPrismaClient {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $transaction: <T>(fn: (tx: DesignChangeTrackerPrismaClient) => Promise<T>) => Promise<T>;
}

// =====================================================
// DI Factory / DIファクトリー
// =====================================================

const prismaClientDI = createDIFactory<DesignChangeTrackerPrismaClient>(
  "DesignChangeTrackerPrismaClient"
);

export const setDesignChangeTrackerPrismaClientFactory = prismaClientDI.set;
export const resetDesignChangeTrackerPrismaClientFactory = prismaClientDI.reset;

/** @internal テスト用にDIファクトリーを公開 */
export const getDesignChangeTrackerPrismaClientFactory = prismaClientDI.get;

// =====================================================
// Types / 型定義
// =====================================================

/** セクション行データ（DBクエリ結果） / Section row from DB query */
interface SectionRow {
  section_type: string;
  section_name: string | null;
  position_index: number;
  text_embedding: string | null;
  vision_embedding: string | null;
}

/** 変更カテゴリ / Change category */
export type ChangeCategory = "added" | "removed" | "modified" | "unchanged";

/** セクション変更詳細 / Section change detail */
export interface SectionChange {
  section_type: string;
  section_name: string | null;
  position_index: number;
  category: ChangeCategory;
  text_similarity: number | null;
  vision_similarity: number | null;
}

/** 変更サマリー / Change summary */
export interface ChangeSummary {
  /** 変更度スコア (0=同一, 1=完全に異なる) / Change score (0=identical, 1=completely different) */
  change_score: number;
  added_count: number;
  removed_count: number;
  modified_count: number;
  unchanged_count: number;
  total_sections_before: number;
  total_sections_after: number;
}

/** createSnapshot結果 / createSnapshot result */
export interface CreateSnapshotResult {
  success: boolean;
  snapshot_id?: string;
  section_count?: number;
  overall_score?: number | null;
  snapshot_at?: string;
  error?: string;
}

/** compareSnapshots結果 / compareSnapshots result */
export interface CompareSnapshotsResult {
  success: boolean;
  changes?: SectionChange[];
  summary?: ChangeSummary;
  snapshot_before?: { id: string; snapshot_at: string };
  snapshot_after?: { id: string; snapshot_at: string };
  error?: string;
}

/** getHistory結果 / getHistory result */
export interface GetHistoryResult {
  success: boolean;
  url?: string;
  snapshots?: Array<{
    id: string;
    snapshot_at: string;
    section_count: number;
    overall_score: number | null;
  }>;
  error?: string;
}

/** detectChanges結果 / detectChanges result */
export interface DetectChangesResult {
  success: boolean;
  has_changes?: boolean;
  changes?: SectionChange[];
  summary?: ChangeSummary;
  message?: string;
  error?: string;
}

// =====================================================
// Utility Functions / ユーティリティ
// =====================================================

/**
 * embedding文字列をnumber配列にパース
 * Parse embedding string to number array
 */
function parseEmbedding(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const nums = parsed as number[];
    // NaN/Infinity防御
    if (nums.some((v) => !Number.isFinite(v))) return null;
    return nums;
  } catch {
    return null;
  }
}

// cosineSimilarity (nullable版) は ../utils/vector-math から import
// cosineSimilarity (nullable version) imported from ../utils/vector-math

/**
 * セクション間の変更を比較
 * Compare sections between two snapshots
 */
function compareSectionSets(
  beforeSections: SectionRow[],
  afterSections: SectionRow[]
): { changes: SectionChange[]; summary: ChangeSummary } {
  const changes: SectionChange[] = [];

  // section_type + position_index でマッチング
  const beforeMap = new Map<string, SectionRow>();
  for (const s of beforeSections) {
    beforeMap.set(`${s.section_type}:${s.position_index}`, s);
  }

  const afterMap = new Map<string, SectionRow>();
  for (const s of afterSections) {
    afterMap.set(`${s.section_type}:${s.position_index}`, s);
  }

  let addedCount = 0;
  let removedCount = 0;
  let modifiedCount = 0;
  let unchangedCount = 0;
  let totalDistance = 0;
  let comparedCount = 0;

  // after にある各セクションを before と比較
  for (const [key, afterSection] of afterMap) {
    const beforeSection = beforeMap.get(key);

    if (!beforeSection) {
      // added
      changes.push({
        section_type: afterSection.section_type,
        section_name: afterSection.section_name,
        position_index: afterSection.position_index,
        category: "added",
        text_similarity: null,
        vision_similarity: null,
      });
      addedCount++;
      totalDistance += 1;
      comparedCount++;
      continue;
    }

    // 両方存在する場合 — embedding を比較
    const textSim = cosineSimilarityNullable(
      parseEmbedding(beforeSection.text_embedding),
      parseEmbedding(afterSection.text_embedding)
    );
    const visionSim = cosineSimilarityNullable(
      parseEmbedding(beforeSection.vision_embedding),
      parseEmbedding(afterSection.vision_embedding)
    );

    // 変更判定: 類似度 < 0.99 で modified
    const UNCHANGED_THRESHOLD = 0.99;
    let isModified = false;

    if (textSim !== null && textSim < UNCHANGED_THRESHOLD) {
      isModified = true;
    }
    if (visionSim !== null && visionSim < UNCHANGED_THRESHOLD) {
      isModified = true;
    }

    const category: ChangeCategory = isModified ? "modified" : "unchanged";

    changes.push({
      section_type: afterSection.section_type,
      section_name: afterSection.section_name,
      position_index: afterSection.position_index,
      category,
      text_similarity: textSim,
      vision_similarity: visionSim,
    });

    if (isModified) {
      modifiedCount++;
      // distance = 1 - average similarity
      const sims = [textSim, visionSim].filter((s): s is number => s !== null);
      const avgSim = sims.length > 0 ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
      totalDistance += 1 - avgSim;
    } else {
      unchangedCount++;
    }
    comparedCount++;
  }

  // before にあって after にないセクション — removed
  for (const [key, beforeSection] of beforeMap) {
    if (!afterMap.has(key)) {
      changes.push({
        section_type: beforeSection.section_type,
        section_name: beforeSection.section_name,
        position_index: beforeSection.position_index,
        category: "removed",
        text_similarity: null,
        vision_similarity: null,
      });
      removedCount++;
      totalDistance += 1;
      comparedCount++;
    }
  }

  // 変更度スコア: totalDistance / comparedCount (0=同一, 1=完全に異なる)
  const changeScore = comparedCount > 0 ? totalDistance / comparedCount : 0;
  // NaN/Infinity防御
  const safeChangeScore = Number.isFinite(changeScore) ? Math.max(0, Math.min(1, changeScore)) : 0;

  return {
    changes,
    summary: {
      change_score: safeChangeScore,
      added_count: addedCount,
      removed_count: removedCount,
      modified_count: modifiedCount,
      unchanged_count: unchangedCount,
      total_sections_before: beforeSections.length,
      total_sections_after: afterSections.length,
    },
  };
}

// =====================================================
// Service Functions / サービス関数
// =====================================================

/**
 * 現在のセクション+embeddingをスナップショットとして保存
 * Save current sections + embeddings as a snapshot
 */
export async function createSnapshot(webPageId: string): Promise<CreateSnapshotResult> {
  // UUID バリデーション
  if (!UUID_REGEX.test(webPageId)) {
    return {
      success: false,
      error: `${DESIGN_CHANGE_ERROR_CODES.INVALID_INPUT}: Invalid webPageId format`,
    };
  }

  const prismaFactory = prismaClientDI.get();
  if (!prismaFactory) {
    return {
      success: false,
      error: `${DESIGN_CHANGE_ERROR_CODES.SNAPSHOT_FAILED}: Service not initialized`,
    };
  }

  const prisma = prismaFactory();

  try {
    // 1. ページ存在確認
    const pages = await prisma.$queryRawUnsafe<
      Array<{
        id: string;
        url: string;
        analysis_version?: string;
        screenshot_full_url?: string | null;
      }>
    >(
      `SELECT id, url, analysis_version, screenshot_full_url FROM web_pages WHERE id = $1::uuid`,
      webPageId
    );

    const pageRecord = pages[0];
    if (!pageRecord) {
      return {
        success: false,
        error: `${DESIGN_CHANGE_ERROR_CODES.PAGE_NOT_FOUND}: WebPage not found: ${truncateId(webPageId)}`,
      };
    }

    // 2. 現在のセクション + embedding を取得
    const sections = await prisma.$queryRawUnsafe<SectionRow[]>(
      `SELECT sp.section_type, sp.section_name, sp.position_index,
              se.text_embedding::text, se.vision_embedding::text
       FROM section_patterns sp
       LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
       WHERE sp.web_page_id = $1::uuid
       ORDER BY sp.position_index`,
      webPageId
    );

    // 3. 品質スコア取得
    const qualityRows = await prisma.$queryRawUnsafe<Array<{ overall_score: number | null }>>(
      `SELECT overall_score
       FROM quality_evaluations
       WHERE target_type = 'web_page' AND target_id = $1::uuid
       ORDER BY created_at DESC LIMIT 1`,
      webPageId
    );
    const firstQualityRow = qualityRows[0];
    const overallScore = firstQualityRow ? firstQualityRow.overall_score : null;

    // 4. スナップショット作成
    const snapshotRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO design_snapshots (web_page_id, section_count, overall_score, metadata)
       VALUES ($1::uuid, $2, $3, $4::jsonb)
       RETURNING id`,
      webPageId,
      sections.length,
      overallScore,
      JSON.stringify({
        analysis_version: pageRecord.analysis_version ?? null,
        screenshot_full_url: pageRecord.screenshot_full_url ?? null,
      })
    );

    const firstSnapshot = snapshotRows[0];
    if (!firstSnapshot) {
      return {
        success: false,
        error: `${DESIGN_CHANGE_ERROR_CODES.SNAPSHOT_FAILED}: Failed to create snapshot`,
      };
    }
    const snapshotId = firstSnapshot.id;

    // 5. セクションデータを保存
    for (const section of sections) {
      const textEmb = section.text_embedding;
      const visionEmb = section.vision_embedding;

      await prisma.$queryRawUnsafe(
        `INSERT INTO design_snapshot_sections
         (snapshot_id, section_type, section_name, position_index, text_embedding, vision_embedding)
         VALUES ($1::uuid, $2, $3, $4,
                 ${textEmb ? `$5::vector` : "NULL"},
                 ${visionEmb ? `$${textEmb ? 6 : 5}::vector` : "NULL"})`,
        snapshotId,
        section.section_type,
        section.section_name,
        section.position_index,
        ...(textEmb ? [textEmb] : []),
        ...(visionEmb ? [visionEmb] : [])
      );
    }

    // 6. 古いスナップショットの自動削除（保持上限超過時）
    const countRows = await prisma.$queryRawUnsafe<Array<{ count: string }>>(
      `SELECT COUNT(*)::text as count FROM design_snapshots WHERE web_page_id = $1::uuid`,
      webPageId
    );
    const snapshotCount = parseInt(countRows[0]?.count ?? "0", 10);

    if (snapshotCount > DEFAULT_MAX_SNAPSHOTS_PER_URL) {
      const deleteCount = snapshotCount - DEFAULT_MAX_SNAPSHOTS_PER_URL;
      await prisma.$executeRawUnsafe(
        `DELETE FROM design_snapshots
         WHERE id IN (
           SELECT id FROM design_snapshots
           WHERE web_page_id = $1::uuid
           ORDER BY snapshot_at ASC
           LIMIT $2
         )`,
        webPageId,
        deleteCount
      );
      logger.info("[DesignChangeTracker] Cleaned up old snapshots", {
        webPageId: truncateId(webPageId),
        deletedCount: deleteCount,
      });
    }

    logger.info("[DesignChangeTracker] Snapshot created", {
      snapshotId: truncateId(snapshotId),
      webPageId: truncateId(webPageId),
      sectionCount: sections.length,
    });

    return {
      success: true,
      snapshot_id: snapshotId,
      section_count: sections.length,
      overall_score: overallScore,
      snapshot_at: new Date().toISOString(),
    };
  } catch (error) {
    logger.warn("[DesignChangeTracker] createSnapshot failed", {
      webPageId: truncateId(webPageId),
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      error: `${DESIGN_CHANGE_ERROR_CODES.SNAPSHOT_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  }
}

/**
 * 2つのスナップショットのembedding diffを比較
 * Compare embedding diff between two snapshots
 */
export async function compareSnapshots(
  snapshotId1: string,
  snapshotId2: string
): Promise<CompareSnapshotsResult> {
  // 同一ID チェック
  if (snapshotId1 === snapshotId2) {
    return {
      success: false,
      error: `${DESIGN_CHANGE_ERROR_CODES.INVALID_INPUT}: Cannot compare a snapshot with itself`,
    };
  }

  // UUID バリデーション
  if (!UUID_REGEX.test(snapshotId1) || !UUID_REGEX.test(snapshotId2)) {
    return {
      success: false,
      error: `${DESIGN_CHANGE_ERROR_CODES.INVALID_INPUT}: Invalid snapshot ID format`,
    };
  }

  const prismaFactory = prismaClientDI.get();
  if (!prismaFactory) {
    return {
      success: false,
      error: `${DESIGN_CHANGE_ERROR_CODES.COMPARE_FAILED}: Service not initialized`,
    };
  }

  const prisma = prismaFactory();

  try {
    // スナップショット存在確認
    const snap1Rows = await prisma.$queryRawUnsafe<
      Array<{ id: string; web_page_id: string; section_count: number; snapshot_at: string }>
    >(
      `SELECT id, web_page_id, section_count, snapshot_at::text FROM design_snapshots WHERE id = $1::uuid`,
      snapshotId1
    );

    const snap2Rows = await prisma.$queryRawUnsafe<
      Array<{ id: string; web_page_id: string; section_count: number; snapshot_at: string }>
    >(
      `SELECT id, web_page_id, section_count, snapshot_at::text FROM design_snapshots WHERE id = $1::uuid`,
      snapshotId2
    );

    const snap1 = snap1Rows[0];
    const snap2 = snap2Rows[0];

    if (!snap1 || !snap2) {
      const missingId = !snap1 ? snapshotId1 : snapshotId2;
      return {
        success: false,
        error: `${DESIGN_CHANGE_ERROR_CODES.SNAPSHOT_NOT_FOUND}: Snapshot not found: ${truncateId(missingId)}`,
      };
    }

    // セクションデータ取得
    const sections1 = await prisma.$queryRawUnsafe<SectionRow[]>(
      `SELECT section_type, section_name, position_index,
              text_embedding::text, vision_embedding::text
       FROM design_snapshot_sections
       WHERE snapshot_id = $1::uuid
       ORDER BY position_index`,
      snapshotId1
    );

    const sections2 = await prisma.$queryRawUnsafe<SectionRow[]>(
      `SELECT section_type, section_name, position_index,
              text_embedding::text, vision_embedding::text
       FROM design_snapshot_sections
       WHERE snapshot_id = $1::uuid
       ORDER BY position_index`,
      snapshotId2
    );

    // 比較実行
    const { changes, summary } = compareSectionSets(sections1, sections2);

    return {
      success: true,
      changes,
      summary,
      snapshot_before: {
        id: snap1.id,
        snapshot_at: snap1.snapshot_at,
      },
      snapshot_after: {
        id: snap2.id,
        snapshot_at: snap2.snapshot_at,
      },
    };
  } catch (error) {
    logger.warn("[DesignChangeTracker] compareSnapshots failed", {
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      error: `${DESIGN_CHANGE_ERROR_CODES.COMPARE_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  }
}

/**
 * URL別スナップショット履歴を取得
 * Get snapshot history for a URL
 */
export async function getHistory(url: string, limit: number = 10): Promise<GetHistoryResult> {
  const prismaFactory = prismaClientDI.get();
  if (!prismaFactory) {
    return {
      success: false,
      error: `${DESIGN_CHANGE_ERROR_CODES.SNAPSHOT_FAILED}: Service not initialized`,
    };
  }

  const prisma = prismaFactory();

  try {
    // URL → webPageId
    const pageRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM web_pages WHERE url = $1 LIMIT 1`,
      url
    );

    const firstPage = pageRows[0];
    if (!firstPage) {
      return {
        success: false,
        error: `${DESIGN_CHANGE_ERROR_CODES.PAGE_NOT_FOUND}: Page not found for URL`,
      };
    }

    const webPageId = firstPage.id;

    // スナップショット履歴取得
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : 10;
    const snapshots = await prisma.$queryRawUnsafe<
      Array<{
        id: string;
        snapshot_at: string;
        section_count: number;
        overall_score: number | null;
      }>
    >(
      `SELECT id, snapshot_at::text, section_count, overall_score
       FROM design_snapshots
       WHERE web_page_id = $1::uuid
       ORDER BY snapshot_at DESC
       LIMIT $2`,
      webPageId,
      safeLimit
    );

    return {
      success: true,
      url,
      snapshots,
    };
  } catch (error) {
    logger.warn("[DesignChangeTracker] getHistory failed", {
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      error: `${DESIGN_CHANGE_ERROR_CODES.SNAPSHOT_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  }
}

/**
 * 最新分析結果と直前スナップショットの差分検出
 * Detect changes between latest analysis and previous snapshot
 */
export async function detectChanges(webPageId: string): Promise<DetectChangesResult> {
  // UUID バリデーション
  if (!UUID_REGEX.test(webPageId)) {
    return {
      success: false,
      error: `${DESIGN_CHANGE_ERROR_CODES.INVALID_INPUT}: Invalid webPageId format`,
    };
  }

  const prismaFactory = prismaClientDI.get();
  if (!prismaFactory) {
    return {
      success: false,
      error: `${DESIGN_CHANGE_ERROR_CODES.DETECT_FAILED}: Service not initialized`,
    };
  }

  const prisma = prismaFactory();

  try {
    // ページ存在確認
    const pageRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM web_pages WHERE id = $1::uuid`,
      webPageId
    );

    if (pageRows.length === 0) {
      return {
        success: false,
        error: `${DESIGN_CHANGE_ERROR_CODES.PAGE_NOT_FOUND}: WebPage not found: ${truncateId(webPageId)}`,
      };
    }

    // 最新スナップショット取得
    const latestSnapshots = await prisma.$queryRawUnsafe<
      Array<{ id: string; web_page_id: string; section_count: number; snapshot_at: string }>
    >(
      `SELECT id, web_page_id, section_count, snapshot_at::text
       FROM design_snapshots
       WHERE web_page_id = $1::uuid
       ORDER BY snapshot_at DESC
       LIMIT 1`,
      webPageId
    );

    if (latestSnapshots.length === 0) {
      return {
        success: true,
        message: "no_previous_snapshot: No previous snapshot exists for comparison",
      };
    }

    const latestSnapshot = latestSnapshots[0]!;

    // 現在のセクション状態を取得
    const currentSections = await prisma.$queryRawUnsafe<SectionRow[]>(
      `SELECT sp.section_type, sp.section_name, sp.position_index,
              se.text_embedding::text, se.vision_embedding::text
       FROM section_patterns sp
       LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
       WHERE sp.web_page_id = $1::uuid
       ORDER BY sp.position_index`,
      webPageId
    );

    // スナップショットのセクションを取得
    const snapshotSections = await prisma.$queryRawUnsafe<SectionRow[]>(
      `SELECT section_type, section_name, position_index,
              text_embedding::text, vision_embedding::text
       FROM design_snapshot_sections
       WHERE snapshot_id = $1::uuid
       ORDER BY position_index`,
      latestSnapshot.id
    );

    // 比較実行
    const { changes, summary } = compareSectionSets(snapshotSections, currentSections);

    const hasChanges =
      summary.added_count > 0 || summary.removed_count > 0 || summary.modified_count > 0;

    return {
      success: true,
      has_changes: hasChanges,
      changes,
      summary,
    };
  } catch (error) {
    logger.warn("[DesignChangeTracker] detectChanges failed", {
      webPageId: truncateId(webPageId),
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      error: `${DESIGN_CHANGE_ERROR_CODES.DETECT_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  }
}
