// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audit Log Service — 監査ログサービス
 *
 * GDPR Art.30「処理活動記録」+ CWE-778「監査不備」対応。
 * Append-only設計で、通常のUPDATE/DELETE操作を制限（cleanup()のみ例外）。
 * PII配慮: targetIdはtruncateId()で切り詰め、detailsは機密情報除去。
 *
 * Audit Log Service for GDPR Art.30 "Records of processing activities"
 * and CWE-778 "Insufficient Logging" compliance.
 * Append-only design: UPDATE/DELETE restricted (cleanup only exception).
 * PII consideration: targetId truncated, details sanitized.
 *
 * @module services/audit-log.service
 */

import { createDIFactory } from "../utils/di-factory";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { logger } from "../utils/logger";

// =====================================================
// 定数 / Constants
// =====================================================

/**
 * 監査ログ定数
 * Audit log constants
 */
export const AUDIT_LOG_CONSTANTS = {
  /** デフォルトのクエリ上限 / Default query limit */
  DEFAULT_QUERY_LIMIT: 20,
  /** クエリ上限の最大値 / Maximum query limit */
  MAX_QUERY_LIMIT: 100,
  /** デフォルトの保持日数 / Default retention days */
  DEFAULT_RETENTION_DAYS: 365,
  /** targetId切り詰め長 / targetId truncation length */
  TARGET_ID_TRUNCATE_LENGTH: 8,
  /**
   * PR-E-1 LCC-04: zombie worker manual recovery 専用 audit action.
   * Plan v1.1 §8.4 LCC explicit decision で確定:
   *   - retention: 365 days (PR-D-9 audit_logs default 継承、GDPR Art.30)
   *   - actor: `operator:<email>` (manual recovery 経路のみ、autospawn は将来別 action)
   *   - target_id: raw workerType (`page` / `embedding-backfill` 固定 enum、PII 該当性ゼロ、`truncateTargetId` 不要)
   *   - details schema: {recovery_method, original_signal, original_pid, redis_lock_key}
   *   - compliance tags: [EU GDPR Art.30][JP APPI 第23条]
   *
   * PR-E-1 LCC-04: dedicated audit action for manual zombie-worker recovery.
   * Plan v1.1 §8.4 LCC explicit decision: 365d retention / `operator:<email>` actor /
   * raw workerType target_id (no truncation needed, fixed enum) /
   * structured details / GDPR Art.30 + APPI Art.23 compliance.
   */
  WORKER_ZOMBIE_RECOVERED_ACTION: "worker_zombie_recovered",
  /** PR-E-1 LCC-04: actor prefix for manual operator recovery path. */
  WORKER_ZOMBIE_RECOVERED_ACTOR_PREFIX: "operator:",
  /**
   * PR-E-1 LCC-04: detail field — recovery method enum.
   * Currently only `force_release_redis_lock` is in scope (Plan v1.1 §8.3 step 2).
   * Future autospawn paths will use a separate action.
   */
  WORKER_ZOMBIE_RECOVERY_METHODS: ["force_release_redis_lock"] as const,
} as const;

/**
 * details内で除去する機密キー（再帰的に除去）
 * Sensitive keys to remove from details (recursively)
 */
const SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "authorization",
  "cookie",
  "session",
  "credential",
  "credentials",
  "private_key",
  "privateKey",
]);

// =====================================================
// 型定義 / Type Definitions
// =====================================================

/**
 * 監査ログエントリ（入力用）
 * Audit log entry (for input)
 */
export interface AuditLogEntry {
  /** 操作アクション / Action performed */
  action: string;
  /** 操作実行者 / Actor who performed the action */
  actor: string;
  /** 対象エンティティタイプ / Target entity type */
  targetType: string;
  /** 対象エンティティID（PII truncationされる） / Target entity ID (will be PII-truncated) */
  targetId?: string | undefined;
  /** 追加コンテキスト（機密情報除去される） / Additional context (will be sanitized) */
  details?: Record<string, unknown> | undefined;
  /** クライアントIPアドレス / Client IP address */
  ipAddress?: string | undefined;
  /** 結果 / Result */
  result: "success" | "failure" | "denied";
}

/**
 * 監査ログクエリフィルタ
 * Audit log query filters
 */
export interface AuditLogFilters {
  /** アクションフィルタ / Action filter */
  action?: string | undefined;
  /** ターゲットタイプフィルタ / Target type filter */
  targetType?: string | undefined;
  /** 開始日時 / Start date */
  startDate?: Date | undefined;
  /** 終了日時 / End date */
  endDate?: Date | undefined;
  /** 結果上限 / Result limit */
  limit?: number | undefined;
}

/**
 * 監査ログレコード（DB出力）
 * Audit log record (from DB)
 */
export interface AuditLogRecord {
  id: string;
  timestamp: Date;
  action: string;
  actor: string;
  targetType: string;
  targetId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  result: string;
}

/**
 * 保持ポリシー
 * Retention policy
 */
export interface RetentionPolicy {
  /** 保持日数 / Retention days */
  retentionDays: number;
  /** ポリシー説明 / Policy description */
  description: string;
}

/**
 * Prisma Client インターフェース（DI用）
 * Prisma Client interface (for DI)
 */
export interface AuditLogPrismaClient {
  auditLog: {
    create: (args: {
      data: {
        action: string;
        actor: string;
        targetType: string;
        targetId: string | null;
        details: Record<string, unknown> | null;
        ipAddress: string | null;
        result: string;
      };
    }) => Promise<{ id: string }>;
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy: Record<string, string>;
      take: number;
    }) => Promise<AuditLogRecord[]>;
    deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
    count: (args?: { where?: Record<string, unknown> }) => Promise<number>;
  };
}

// =====================================================
// ヘルパー関数 / Helper Functions
// =====================================================

/**
 * IDをPII配慮でtruncateする
 * Truncate ID for PII consideration
 */
function truncateTargetId(id: string | undefined | null): string | null {
  if (!id) return null;
  if (id.length <= AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) return id;
  return id.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...";
}

/**
 * details内の機密情報を再帰的に除去
 * Recursively remove sensitive data from details
 */
function sanitizeDetails(
  obj: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object") return null;

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // 機密キーはスキップ
    if (SENSITIVE_KEYS.has(key)) {
      continue;
    }

    // ネストされたオブジェクトは再帰処理
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      sanitized[key] = sanitizeDetails(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

// =====================================================
// DI Factory
// =====================================================

const prismaClientDI = createDIFactory<AuditLogPrismaClient>("AuditLogPrismaClient");

export const setAuditLogPrismaClientFactory = prismaClientDI.set;
export const resetAuditLogPrismaClientFactory = prismaClientDI.reset;

// =====================================================
// Service
// =====================================================

let serviceInstance: AuditLogService | null = null;

/**
 * AuditLogService — 監査ログサービス
 *
 * Append-only設計: log()でのみ新規レコード作成。
 * UPDATE操作は提供しない。DELETE操作はcleanup()のみ。
 */
export class AuditLogService {
  private prismaClient: AuditLogPrismaClient | null;

  constructor() {
    const factory = prismaClientDI.get();
    this.prismaClient = factory ? factory() : null;
  }

  /**
   * 監査ログを記録（Append-only）
   * Record an audit log entry (Append-only)
   *
   * @param entry - 監査ログエントリ / Audit log entry
   */
  async log(entry: AuditLogEntry): Promise<void> {
    if (!this.prismaClient) {
      logger.warn("[AuditLog] Prisma client not available, skipping audit log", {
        action: entry.action,
      });
      return;
    }

    try {
      await this.prismaClient.auditLog.create({
        data: {
          action: entry.action,
          actor: entry.actor,
          targetType: entry.targetType,
          targetId: truncateTargetId(entry.targetId),
          details: sanitizeDetails(entry.details),
          ipAddress: entry.ipAddress ?? null,
          result: entry.result,
        },
      });
    } catch (error) {
      // 監査ログ書き込み失敗は主処理をブロックしない（Graceful Degradation）
      // Audit log write failures do not block main processing
      logger.warn("[AuditLog] Failed to write audit log", {
        action: entry.action,
        error: sanitizeErrorMessage(error),
      });
    }
  }

  /**
   * 監査ログを検索
   * Query audit logs
   *
   * @param filters - 検索フィルタ / Query filters
   * @returns 監査ログレコード配列 / Audit log records
   */
  async query(filters: AuditLogFilters): Promise<AuditLogRecord[]> {
    if (!this.prismaClient) {
      logger.warn("[AuditLog] Prisma client not available for query");
      return [];
    }

    const where: Record<string, unknown> = {};

    if (filters.action) {
      where.action = filters.action;
    }

    if (filters.targetType) {
      where.targetType = filters.targetType;
    }

    if (filters.startDate || filters.endDate) {
      const timestampFilter: Record<string, Date> = {};
      if (filters.startDate) {
        timestampFilter.gte = filters.startDate;
      }
      if (filters.endDate) {
        timestampFilter.lte = filters.endDate;
      }
      where.timestamp = timestampFilter;
    }

    const limit = Math.min(
      Math.max(filters.limit ?? AUDIT_LOG_CONSTANTS.DEFAULT_QUERY_LIMIT, 1),
      AUDIT_LOG_CONSTANTS.MAX_QUERY_LIMIT
    );

    return this.prismaClient.auditLog.findMany({
      where,
      orderBy: { timestamp: "desc" },
      take: limit,
    });
  }

  /**
   * 保持ポリシーを取得
   * Get retention policy
   */
  getRetentionPolicy(): RetentionPolicy {
    return {
      retentionDays: AUDIT_LOG_CONSTANTS.DEFAULT_RETENTION_DAYS,
      description: `Audit logs are retained for ${AUDIT_LOG_CONSTANTS.DEFAULT_RETENTION_DAYS} days (GDPR Art.30 compliance)`,
    };
  }

  /**
   * 古いログを削除（保持期間ポリシーに基づくcleanup）
   * Delete old logs (cleanup based on retention policy)
   *
   * @param olderThan - この日時より古いログを削除 / Delete logs older than this date
   * @returns 削除件数 / Number of deleted records
   */
  async cleanup(olderThan: Date): Promise<number> {
    if (!this.prismaClient) {
      logger.warn("[AuditLog] Prisma client not available for cleanup");
      return 0;
    }

    try {
      const result = await this.prismaClient.auditLog.deleteMany({
        where: { timestamp: { lt: olderThan } },
      });
      return result.count;
    } catch (error) {
      logger.warn("[AuditLog] Failed to cleanup audit logs", {
        error: sanitizeErrorMessage(error),
      });
      return 0;
    }
  }
}

/**
 * AuditLogServiceシングルトンを取得
 * Get AuditLogService singleton
 */
export function getAuditLogService(): AuditLogService {
  if (!serviceInstance) {
    serviceInstance = new AuditLogService();
  }
  return serviceInstance;
}

/**
 * AuditLogServiceシングルトンをリセット（テスト用）
 * Reset AuditLogService singleton (for testing)
 */
export function resetAuditLogService(): void {
  serviceInstance = null;
}

/**
 * CLI スクリプトから AuditLogService を初期化する (PR7e-β1)
 * Bootstrap AuditLogService for CLI / batch scripts (PR7e-β1)
 *
 * MCP server 起動時は `apps/mcp-server/src/mcp-server.ts` が
 * `setAuditLogPrismaClientFactory()` を呼んで DI を設定しているが、
 * CLI スクリプト (`repair-page-analyze.ts` / `repair-orphaned-backfill-records.ts` 等)
 * では DI が登録されていないため、`getAuditLogService().log()` 呼び出しが
 * サイレントに warn ログだけ出して DB に書き込まれない問題があった。
 *
 * この helper は、CLI スクリプトが `new PrismaClient()` した直後に呼び出すことで
 * DI factory を登録し、監査ログが正しく永続化されるようにする。
 *
 * In the MCP server, `apps/mcp-server/src/mcp-server.ts` wires up the DI via
 * `setAuditLogPrismaClientFactory()`. However CLI scripts
 * (`repair-page-analyze.ts` / `repair-orphaned-backfill-records.ts`) never
 * registered the factory, so `getAuditLogService().log()` silently degraded
 * to a warn-only no-op and audit records were never written.
 *
 * This helper is intended to be called right after `new PrismaClient()` in a
 * CLI script so that the factory is registered and audit logs are persisted.
 *
 * 冪等性 / Idempotency:
 *   Multiple invocations with the same client are safe: the underlying DI
 *   factory is simply replaced.
 *
 * シングルトンリセット / Singleton reset:
 *   Any previously constructed `AuditLogService` instance (which captured a
 *   null factory in its constructor) is reset so that the next
 *   `getAuditLogService()` call rebuilds with the newly registered factory.
 *
 * @param prismaClient The PrismaClient instance owned by the CLI script
 */
export function bootstrapAuditLogServiceForScript(prismaClient: AuditLogPrismaClient): void {
  setAuditLogPrismaClientFactory(() => prismaClient);
  // Rebuild the singleton so any earlier "Prisma not available" warn path is cleared.
  serviceInstance = null;
}
