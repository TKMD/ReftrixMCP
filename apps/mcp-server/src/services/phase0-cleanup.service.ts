// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 0 Cleanup Service — Stale failed web_pages row removal
 *
 * PR-B (v0.4.0 PR7e P4/LCC-M3-03): Phase 0 層で失敗した `web_pages` 行
 * (robots.txt fail / SSRF block / DNS fail 等) を TTL ベースで削除するサービス。
 *
 * Phase 0 Early INSERT (`PHASE0_EARLY_INSERT=true`) を有効化すると、Phase 0
 * でフェッチ前に `web_pages` 行が先行 INSERT される。その後 robots.txt や SSRF
 * 検証で早期失敗した場合、`analysisStatus='failed'` + `lastAnalyzedPhase=null`
 * の row が DB に蓄積し続ける。これを定期的に掃除するのが本サービス。
 *
 * PR-B (v0.4.0 PR7e P4/LCC-M3-03): Service that deletes `web_pages` rows which
 * failed during Phase 0 (robots.txt block / SSRF / DNS failure, etc.) based on
 * a TTL policy.
 *
 * With Phase 0 Early INSERT (`PHASE0_EARLY_INSERT=true`), a row is inserted
 * before fetch. If robots.txt or SSRF validation then rejects the URL, the row
 * remains in DB with `analysisStatus='failed'` + `lastAnalyzedPhase=null`.
 * This service performs periodic cleanup of such rows.
 *
 * ## 削除条件 / Deletion criteria
 *
 *   1. `analysisStatus = 'failed'`
 *   2. `analysisCompletedAt < NOW() - olderThanMs` (default 7d)
 *   3. `lastAnalyzedPhase IS NULL` (Phase 0 以降に進んでいない row のみ)
 *
 * Phase 1 以降で失敗した row (`lastAnalyzedPhase IN ('layout','motion',...)`) は
 * **対象外** — ユーザーが `analysisStatus='failed'` として確認する必要があるため。
 *
 * Rows that failed during Phase 1+ (`lastAnalyzedPhase` is non-null) are **NOT**
 * deleted — users need to see them as `analysisStatus='failed'`.
 *
 * ## 監査ログ / Audit log
 *
 * `deletedCount > 0` のとき、`audit_logs` に `action=phase0_stale_cleanup` を
 * 記録する (GDPR Art.30 処理活動記録)。0件削除はノイズ抑制のため記録しない。
 *
 * Records an `audit_logs` entry (`action=phase0_stale_cleanup`) when at least
 * one row is deleted (GDPR Art.30). Zero-delete runs are skipped to avoid
 * log flooding.
 *
 * @module services/phase0-cleanup.service
 */

import { logger, isDevelopment } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { getAuditLogService } from "./audit-log.service";

// =====================================================
// Constants / 定数
// =====================================================

/** デフォルト TTL: 7日 (screenshot TTL と整合) / Default TTL: 7 days (matches screenshot TTL) */
export const DEFAULT_PHASE0_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000;

/** 1実行あたりのデフォルト削除件数上限 / Default batch size cap per invocation */
export const DEFAULT_PHASE0_BATCH_SIZE = 1000;

/** 絶対上限 (DoS 対策) / Absolute cap (DoS defense) */
export const ABSOLUTE_PHASE0_BATCH_SIZE = 100_000;

// =====================================================
// Types / 型
// =====================================================

/**
 * Minimal Prisma client interface used by the Phase 0 cleanup service.
 * DI-friendly: only the methods we actually call are typed.
 *
 * Phase 0 cleanup サービスが使用する最小 Prisma client インターフェース。
 * 使用メソッドのみ型定義する DI friendly 設計。
 */
export interface IPhase0CleanupPrismaClient {
  webPage: {
    findMany: (args: {
      where: Record<string, unknown>;
      select: { id: true };
      take: number;
    }) => Promise<Array<{ id: string }>>;
    deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<{ count: number }>;
  };
}

/**
 * Options for {@link IPhase0CleanupService.cleanupStaleFailedRows}.
 */
export interface CleanupStaleFailedRowsOptions {
  /** 1実行で削除する最大件数 (DoS対策) / Max rows deleted per call (DoS defense) */
  maxBatchSize?: number;
}

/**
 * Public API of the Phase 0 Cleanup Service.
 */
export interface IPhase0CleanupService {
  /**
   * TTL 超過した Phase 0 失敗 `web_pages` 行を削除する。
   * Delete stale Phase 0-failed `web_pages` rows (exceeded TTL).
   *
   * @param olderThanMs - Cutoff age in milliseconds (rows older than this are deleted).
   *   **負値/NaN/Infinity 挙動 / Negative/NaN/Infinity behavior (FIND-PR-B-010)**:
   *   Service layer は契約違反として **throw** する (fail-fast セマンティクス)。
   *   これは意図的に cron layer (`phase0-cleanup-cron.ts`) の
   *   `validatePositive` silent-fallback セマンティクスと異なる:
   *     - Service layer: programmatic caller 前提、不正値は bug なので throw
   *     - Cron layer: env var 由来の設定ミスを許容し warn+fallback (operational resilience)
   *   Cron 経由の呼び出しでは `validatePositive` が既に正規化済みの値を渡すため、
   *   本 service に負値が到達することは通常ない。
   *   Service layer throws on contract violation (fail-fast). This intentionally
   *   differs from the cron layer's silent-fallback semantics because:
   *     - Service layer assumes programmatic callers; invalid values indicate bugs.
   *     - Cron layer tolerates env-var misconfiguration via warn+fallback for
   *       operational resilience.
   *   In practice, values reaching this service via cron are pre-normalized by
   *   `validatePositive`.
   * @param options - Options (batch size cap etc.)
   * @returns Number of rows deleted
   * @throws {Error} If `olderThanMs` is NaN, Infinity, or negative.
   */
  cleanupStaleFailedRows(
    olderThanMs: number,
    options?: CleanupStaleFailedRowsOptions
  ): Promise<number>;
}

// =====================================================
// Implementation / 実装
// =====================================================

class Phase0CleanupService implements IPhase0CleanupService {
  constructor(private readonly prisma: IPhase0CleanupPrismaClient) {}

  async cleanupStaleFailedRows(
    olderThanMs: number,
    options?: CleanupStaleFailedRowsOptions
  ): Promise<number> {
    // Defensive guard: service layer throws on NaN/Infinity/negative (fail-fast).
    // Cron layer (phase0-cleanup-cron.ts::validatePositive) is silent-fallback.
    // See IPhase0CleanupService.cleanupStaleFailedRows JSDoc (FIND-PR-B-010).
    // Service 層は契約違反として throw (fail-fast)。Cron 層は validatePositive で
    // silent-fallback するため、通常本 service に負値は到達しない。
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new Error("[Phase0CleanupService] olderThanMs must be a non-negative finite number");
    }

    // バッチサイズ上限の解決
    // Resolve batch size cap
    const rawBatch = options?.maxBatchSize;
    let maxBatchSize = DEFAULT_PHASE0_BATCH_SIZE;
    if (typeof rawBatch === "number" && Number.isFinite(rawBatch) && rawBatch > 0) {
      maxBatchSize = Math.min(Math.floor(rawBatch), ABSOLUTE_PHASE0_BATCH_SIZE);
    }

    const startedAtMs = Date.now();
    const cutoff = new Date(Date.now() - olderThanMs);

    // 削除対象を ID ベースで絞り込む (2段階: findMany → deleteMany)
    // select ID first then delete-many to keep the operation bounded by maxBatchSize.
    // Narrow deletion targets by ID (2 stages: findMany → deleteMany) so the
    // operation is bounded by maxBatchSize.
    let rows: Array<{ id: string }>;
    try {
      rows = await this.prisma.webPage.findMany({
        where: {
          analysisStatus: "failed",
          analysisCompletedAt: { lt: cutoff },
          lastAnalyzedPhase: null,
        },
        select: { id: true },
        take: maxBatchSize,
      });
    } catch (findError) {
      logger.warn("[Phase0CleanupService] Failed to query stale rows (non-fatal)", {
        error: sanitizeErrorMessage(findError),
      });
      return 0;
    }

    if (rows.length === 0) {
      return 0;
    }

    let deletedCount = 0;
    try {
      const result = await this.prisma.webPage.deleteMany({
        where: { id: { in: rows.map((r) => r.id) } },
      });
      deletedCount = result.count;
    } catch (deleteError) {
      logger.warn("[Phase0CleanupService] Failed to delete stale rows (non-fatal)", {
        error: sanitizeErrorMessage(deleteError),
        targetCount: rows.length,
      });
      return 0;
    }

    if (isDevelopment() && deletedCount > 0) {
      logger.debug("[Phase0CleanupService] Cleanup completed", {
        deletedCount,
        olderThanMs,
        maxBatchSize,
      });
    }

    // audit_logs 記録 (GDPR Art.30): deletedCount > 0 のときのみ
    // Record audit_logs entry (GDPR Art.30): only when deletedCount > 0
    if (deletedCount > 0) {
      try {
        await getAuditLogService().log({
          action: "phase0_stale_cleanup",
          actor: "system:phase0-cleanup-cron",
          // バッチ処理 (単一 targetId なし) / Batch operation (no single targetId)
          targetType: "web_page",
          details: {
            deletedCount,
            batchSize: maxBatchSize,
            olderThanMs,
            durationMs: Date.now() - startedAtMs,
          },
          result: "success",
        });
      } catch {
        // Audit log 失敗は cleanup 結果返却を妨げない
        // Audit log failure must never block the cleanup result
      }
    }

    return deletedCount;
  }
}

// =====================================================
// Factory / ファクトリ
// =====================================================

/**
 * Factory function for {@link IPhase0CleanupService}.
 *
 * DI: Prisma client は外部から注入可能にする (テスト時モック差し替え用)。
 * DI: Prisma client is injectable for test-time mocking.
 */
export function createPhase0CleanupService(deps: {
  prisma: IPhase0CleanupPrismaClient;
}): IPhase0CleanupService {
  return new Phase0CleanupService(deps.prisma);
}
