// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search Log Service
 * 検索ログ記録・分析サービス
 *
 * 検索クエリ・パフォーマンス・結果を記録し、
 * 検索統計とMLフィードバックループ基盤を提供する。
 *
 * Records search queries, performance, and results,
 * providing search statistics and ML feedback loop foundation.
 *
 * PII配慮:
 * - query: 200文字にtruncate
 * - profileId: truncateId() で切り詰め
 * - topResultId: truncateId() で切り詰め
 *
 * @module services/search-log.service
 */

import { prisma, Prisma } from "@reftrixmcp/database";
import { logger } from "../utils/logger";
import { AUDIT_LOG_CONSTANTS } from "./audit-log.service";

// =====================================================
// Constants / 定数
// =====================================================

/** クエリの最大長 / Maximum query length */
const MAX_QUERY_LENGTH = 200;

/**
 * PII truncation の長さ
 * AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH SSOT から導出 (CO-5 UC-3 Option α
 * cross-SSOT consistency, LCC-CO5-01 closure)。GDPR Art.17 SQL LIKE prefix-match
 * length と完全に整合する (gdpr-deletion.service.ts の `truncateProfileIdForSqlLike`
 * と同一 SSOT を共有)。
 *
 * PII truncation length, derived from `AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH`
 * SSOT (CO-5 UC-3 Option α cross-SSOT consistency, LCC-CO5-01 closure). Aligned
 * with the GDPR Art.17 SQL LIKE prefix-match length (shares the same SSOT as
 * `truncateProfileIdForSqlLike` in gdpr-deletion.service.ts).
 */
const TRUNCATE_ID_LENGTH = AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH;

// =====================================================
// Types / 型定義
// =====================================================

/**
 * 検索ログエントリ / Search log entry
 */
export interface SearchLogEntry {
  /** 検索クエリ / Search query */
  query: string;
  /** クエリタイプ / Query type */
  queryType?: string | undefined;
  /** 使用された検索サービス / Search services used */
  services: string[];
  /** 結果数 / Result count */
  resultCount: number;
  /** 最上位結果のID / Top result ID */
  topResultId?: string | undefined;
  /** 適用されたフィルタ / Applied filters */
  filters?: Record<string, unknown> | undefined;
  /** 検索レイテンシ（ms） / Search latency (ms) */
  latencyMs: number;
  /** キャッシュヒットか / Cache hit */
  cacheHit: boolean;
  /** 嗜好プロファイルID / Preference profile ID */
  profileId?: string | undefined;
}

/**
 * 検索統計 / Search statistics
 */
export interface SearchStats {
  /** 検索総数 / Total searches */
  totalSearches: number;
  /** 平均レイテンシ（ms） / Average latency (ms) */
  averageLatencyMs: number;
  /** キャッシュヒット率（0-1） / Cache hit rate (0-1) */
  cacheHitRate: number;
  /** 人気クエリ / Top queries */
  topQueries: Array<{ query: string; count: number }>;
  /** クエリタイプ分布 / Query type distribution */
  queryTypeDistribution?: Array<{ queryType: string; count: number }>;
}

/**
 * 検索統計フィルタ / Search stats filter
 */
export interface SearchStatsFilter {
  /** 開始日時 / Since */
  since?: Date;
  /** 終了日時 / Until */
  until?: Date;
  /** クエリタイプ / Query type */
  queryType?: string;
}

// =====================================================
// PII Helper / PII ヘルパー
// =====================================================

/**
 * IDをtruncateする（PII配慮）
 * Truncate ID for PII consideration
 */
function truncateId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id.length > TRUNCATE_ID_LENGTH ? id.slice(0, TRUNCATE_ID_LENGTH) + "..." : id;
}

// =====================================================
// logSearch / 検索ログ記録
// =====================================================

/**
 * 検索ログを記録する / Record search log
 *
 * Graceful Degradation: DB書き込み失敗時はログ出力のみ。
 * 検索のメインフローに影響を与えない。
 *
 * @param entry - 検索ログエントリ / Search log entry
 */
export async function logSearch(entry: SearchLogEntry): Promise<void> {
  try {
    await prisma.searchLog.create({
      data: {
        query: entry.query.slice(0, MAX_QUERY_LENGTH),
        queryType: entry.queryType ?? null,
        services: entry.services,
        resultCount: Number.isFinite(entry.resultCount) ? entry.resultCount : 0,
        topResultId: truncateId(entry.topResultId) ?? null,
        filters: entry.filters ? (entry.filters as Prisma.InputJsonValue) : Prisma.DbNull,
        latencyMs: Number.isFinite(entry.latencyMs) ? entry.latencyMs : null,
        cacheHit: entry.cacheHit,
        profileId: truncateId(entry.profileId) ?? null,
      },
    });
  } catch (error) {
    // Graceful Degradation: DB書き込み失敗はログに記録するのみ
    // 検索のメインフローをブロックしない
    logger.warn("[SearchLog] Failed to record search log", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// =====================================================
// getSearchStats / 検索統計取得
// =====================================================

/**
 * 検索統計を取得する / Get search statistics
 *
 * @param filter - 検索統計フィルタ（期間、クエリタイプ） / Search stats filter
 * @returns 検索統計 / Search statistics
 */
export async function getSearchStats(filter?: SearchStatsFilter): Promise<SearchStats> {
  try {
    // WHERE条件の構築 / Build WHERE conditions
    const where: Record<string, unknown> = {};
    if (filter?.since || filter?.until) {
      const timestamp: Record<string, unknown> = {};
      if (filter.since) timestamp.gte = filter.since;
      if (filter.until) timestamp.lte = filter.until;
      where.timestamp = timestamp;
    }
    if (filter?.queryType) {
      where.queryType = filter.queryType;
    }

    // 並列クエリ実行 / Execute queries in parallel
    const [totalSearches, cacheHitCount, aggregateResult, topQueries] = await Promise.all([
      // 総検索数 / Total searches
      prisma.searchLog.count({ where }),
      // キャッシュヒット数 / Cache hit count
      prisma.searchLog.count({ where: { ...where, cacheHit: true } }),
      // 平均レイテンシ / Average latency
      prisma.searchLog.aggregate({
        where,
        _avg: { latencyMs: true },
      }),
      // 人気クエリ / Top queries
      prisma.searchLog.groupBy({
        by: ["query"],
        where,
        _count: { query: true },
        orderBy: { _count: { query: "desc" } },
        take: 10,
      }),
    ]);

    const averageLatencyMs = aggregateResult._avg.latencyMs ?? 0;
    const cacheHitRate = totalSearches > 0 ? cacheHitCount / totalSearches : 0;

    return {
      totalSearches,
      averageLatencyMs: Math.round(averageLatencyMs),
      cacheHitRate: Math.round(cacheHitRate * 1000) / 1000, // 小数点3桁
      topQueries: topQueries.map((q) => ({
        query: q.query,
        count: q._count.query,
      })),
    };
  } catch (error) {
    logger.warn("[SearchLog] Failed to get search stats", {
      error: error instanceof Error ? error.message : String(error),
    });

    // デフォルト値を返す / Return default values
    return {
      totalSearches: 0,
      averageLatencyMs: 0,
      cacheHitRate: 0,
      topQueries: [],
    };
  }
}
