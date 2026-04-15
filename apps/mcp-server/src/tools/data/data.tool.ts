// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * data.delete / data.export MCPツール
 * GDPR Art.17 データ削除 + Art.20 データポータビリティ
 *
 * data.delete: 指定対象のデータを完全削除（忘れられる権利）
 * data.export: 指定対象のデータをJSON形式でエクスポート（データポータビリティ）
 *
 * data.delete / data.export MCP tools
 * GDPR Art.17 data deletion + Art.20 data portability
 *
 * @module tools/data/data.tool
 */

import { z, ZodError } from "zod";
import { createDIFactory } from "../../utils/di-factory";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { truncateId } from "../../utils/truncate-id";
import { logger, isDevelopment } from "../../utils/logger";
import { getAuditLogService } from "../../services/audit-log.service";
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  buildBackfillJobId,
  type EmbeddingBackfillCategory,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
} from "../../queues/embedding-backfill-queue";
import type { Queue } from "bullmq";
import type {
  PageDeletionResult,
  ProfileDeletionResult,
  AllUserDataDeletionResult,
  PageExportResult,
  ProfileExportResult,
} from "../../services/gdpr-deletion.service";

// =====================================================
// エラーコード / Error Codes
// =====================================================

/**
 * data MCPエラーコード / data MCP error codes
 */
export const DATA_MCP_ERROR_CODES = {
  /** 入力バリデーションエラー / Input validation error */
  VALIDATION_ERROR: "VALIDATION_ERROR",
  /** 削除未確認 / Deletion not confirmed */
  DELETE_NOT_CONFIRMED: "DELETE_NOT_CONFIRMED",
  /** リソース未検出 / Resource not found */
  NOT_FOUND: "NOT_FOUND",
  /** サービス未設定 / Service not available */
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  /** 内部エラー / Internal error */
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type DataMcpErrorCode = (typeof DATA_MCP_ERROR_CODES)[keyof typeof DATA_MCP_ERROR_CODES];

// =====================================================
// インターフェース / Interfaces
// =====================================================

/**
 * GdprDeletionServiceのツール向けインターフェース
 * GdprDeletionService interface for tool use
 */
export interface GdprDeletionServiceForTool {
  deletePage(pageId: string, reason: string): Promise<PageDeletionResult>;
  deleteProfile(profileId: string, reason: string): Promise<ProfileDeletionResult>;
  deleteAllUserData(
    pageIds: string[],
    profileId: string | undefined,
    reason: string
  ): Promise<AllUserDataDeletionResult>;
  exportPageData(pageId: string): Promise<PageExportResult>;
  exportProfileData(profileId: string): Promise<ProfileExportResult>;
}

// =====================================================
// Zodスキーマ / Zod Schemas
// =====================================================

/**
 * data.delete 入力スキーマ / data.delete input schema
 */
export const dataDeleteInputSchema = z.object({
  /** 削除対象 / Deletion target */
  target: z.enum(["page", "profile", "all_user_data"]),
  /** 対象ID（UUIDv7） / Target ID (UUIDv7) */
  id: z.string().uuid(),
  /** 削除理由（GDPR監査要件） / Deletion reason (GDPR audit requirement) */
  reason: z.string().min(1).max(500),
  /** 削除確認フラグ（必須: true） / Deletion confirmation flag (required: true) */
  confirm: z.boolean(),
  /** ページID配列（target=all_user_data時のみ） / Page IDs (only for target=all_user_data) */
  page_ids: z.array(z.string().uuid()).max(100).optional(),
});

export type DataDeleteInput = z.infer<typeof dataDeleteInputSchema>;

/**
 * data.export 入力スキーマ / data.export input schema
 */
export const dataExportInputSchema = z.object({
  /** エクスポート対象 / Export target */
  target: z.enum(["page", "profile"]),
  /** 対象ID（UUIDv7） / Target ID (UUIDv7) */
  id: z.string().uuid(),
});

export type DataExportInput = z.infer<typeof dataExportInputSchema>;

// =====================================================
// 出力型 / Output Types
// =====================================================

/**
 * Queue ジョブ削除内訳 / Queue job removal breakdown
 *
 * PR7a-4: `data.delete` が target=page / target=all_user_data を処理したとき
 * に削除した embedding-backfill Queue ジョブの件数内訳。
 *
 * PR7a-4: Breakdown of embedding-backfill queue jobs removed when
 * `data.delete` processes target=page / target=all_user_data.
 */
export interface QueueJobsRemoved {
  embeddingBackfill: {
    /** 実際に削除された件数 / Number of jobs successfully removed */
    removed: number;
    /** 実行中のためスキップした件数 / Number of active jobs skipped (BullMQ cannot remove active jobs) */
    skippedActive: number;
  };
}

export type DataDeleteOutput =
  | {
      success: true;
      data: PageDeletionResult | ProfileDeletionResult | AllUserDataDeletionResult;
      /**
       * PR7a-4: target=page / target=all_user_data でのみ設定される。
       * target=profile では未設定（プロファイル削除は webPage と無関係）。
       *
       * PR7a-4: Only set for target=page / target=all_user_data. Omitted for
       * target=profile (profile deletion is unrelated to webPages).
       */
      queueJobsRemoved?: QueueJobsRemoved;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

export type DataExportOutput =
  | {
      success: true;
      data: PageExportResult | ProfileExportResult;
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

const deleteServiceDI = createDIFactory<GdprDeletionServiceForTool>("GdprDeletionService");
export const setDataDeleteServiceFactory = deleteServiceDI.set;
export const resetDataDeleteServiceFactory = deleteServiceDI.reset;

const exportServiceDI = createDIFactory<GdprDeletionServiceForTool>("GdprDeletionServiceExport");
export const setDataExportServiceFactory = exportServiceDI.set;
export const resetDataExportServiceFactory = exportServiceDI.reset;

// =====================================================
// Embedding Backfill Queue DI (PR7a-4)
// =====================================================

/**
 * Embedding Backfill Queue の最小インターフェース（ツール層ビュー）
 * Minimal interface of the embedding backfill queue (tool-layer view)
 *
 * `data.delete` が必要とするのは `getJob` のみ。BullMQ `Queue` の完全な型を
 * 要求するとテスト mock が煩雑になるため、ツール層では最小限のビューだけを
 * 定義する。実装側（service-registrar）は `Queue` 実体を返せばよい。
 *
 * `data.delete` only needs `getJob`. Avoid demanding the full BullMQ `Queue`
 * type so that test mocks stay small. The production registrar simply returns
 * the real `Queue` instance.
 */
export interface BackfillQueueForTool {
  getJob(jobId: string): Promise<BackfillJobForTool | null | undefined>;
}

/**
 * Embedding Backfill Job の最小インターフェース（ツール層ビュー）
 * Minimal interface of a backfill job (tool-layer view)
 */
export interface BackfillJobForTool {
  getState(): Promise<string>;
  remove(): Promise<void>;
}

// Real BullMQ Queue assignability guard (type-level only): 実 Queue を
// BackfillQueueForTool に代入できることをコンパイル時に保証する。
// Ensures the real BullMQ Queue satisfies the tool-layer view at compile time.
type _BullMQQueueAssignableGuard =
  Queue<EmbeddingBackfillJobData, EmbeddingBackfillJobResult> extends BackfillQueueForTool
    ? true
    : never;
// Reference the type alias to prevent "declared but unused" stripping.
export type __InternalBackfillQueueAssignability = _BullMQQueueAssignableGuard;

const backfillQueueDI = createDIFactory<BackfillQueueForTool>("EmbeddingBackfillQueueForDataTool");
export const setDataDeleteBackfillQueueFactory = backfillQueueDI.set;
export const resetDataDeleteBackfillQueueFactory = backfillQueueDI.reset;

/**
 * 単一 webPageId に紐づく Embedding Backfill Queue ジョブを削除する。
 * Remove all embedding backfill jobs tied to a single webPageId.
 *
 * PR7a-4 (LCC M-1 / GDPR Art.17 / CCPA §1798.105): web_page の削除時に
 * Queue 内の滞留ジョブを削除することで、削除済みページに対する非同期 backfill
 * 再開を防止し、削除権の完全履行を保証する。
 *
 * - `active` (実行中) ジョブは BullMQ 仕様上 `remove()` 不可のため skip する。
 *   Worker が完了した後、cascade delete 済みの `web_pages` 行に対する DB
 *   更新で失敗するが、これは許容動作（sanitizeErrorMessage 経由で warn log
 *   にとどまる）。
 * - SSOT 遵守: `EMBEDDING_BACKFILL_CATEGORIES` を直接参照し、7 カテゴリすべて
 *   を対象とする（`part_text` / `part_visual` / `section_visual` / `motion` /
 *   `background` / `js_animation` / `responsive`）。
 * - Graceful Degradation: 個々の getJob / getState / remove 失敗は warn log
 *   のみ。削除主処理の妨げにはしない。
 *
 * PR7a-4 (LCC M-1 / GDPR Art.17 / CCPA §1798.105): Removes queued backfill
 * jobs tied to a deleted web_page so that async backfill cannot resurrect
 * data that the user requested erased.
 *
 * - `active` (running) jobs cannot be removed per BullMQ contract and are
 *   skipped. When the worker completes, its DB writes against the already
 *   cascade-deleted `web_pages` row will fail, which is acceptable
 *   (captured via sanitizeErrorMessage as a warn log).
 * - SSOT compliance: iterates `EMBEDDING_BACKFILL_CATEGORIES` directly,
 *   covering all 7 categories.
 * - Graceful Degradation: individual getJob / getState / remove failures
 *   log warn only and do not abort the primary deletion.
 *
 * @param queue - BackfillQueueForTool (real BullMQ Queue or test mock)
 * @param webPageId - 対象 webPage ID (UUID)
 * @returns 削除件数 / skip 件数の内訳
 */
export async function removeBackfillJobsForWebPage(
  queue: BackfillQueueForTool,
  webPageId: string
): Promise<{ removed: number; skippedActive: number }> {
  let removed = 0;
  let skippedActive = 0;

  for (const category of EMBEDDING_BACKFILL_CATEGORIES) {
    const jobId = buildBackfillJobId(webPageId, category satisfies EmbeddingBackfillCategory);
    try {
      const job = await queue.getJob(jobId);
      if (!job) {
        continue;
      }

      const state = await job.getState();
      if (state === "active") {
        // BullMQ contract: active jobs cannot be remove()d. Skip and let the
        // worker finish; the post-job DB write will fail against the already
        // cascade-deleted web_pages row (expected, logged by worker).
        skippedActive++;
        logger.info("[data.delete] Active backfill job skipped", {
          webPageId: truncateId(webPageId),
          category,
        });
        continue;
      }

      await job.remove();
      removed++;
    } catch (error) {
      logger.warn("[data.delete] Failed to remove backfill job", {
        webPageId: truncateId(webPageId),
        category,
        error: sanitizeErrorMessage(error),
      });
    }
  }

  return { removed, skippedActive };
}

/**
 * 複数 webPage にまたがる Queue ジョブ削除を集約する。
 * Aggregate queue-job removal across multiple webPageIds.
 */
async function removeBackfillJobsForWebPages(
  queue: BackfillQueueForTool,
  webPageIds: readonly string[]
): Promise<{ removed: number; skippedActive: number }> {
  let removed = 0;
  let skippedActive = 0;

  for (const webPageId of webPageIds) {
    const sub = await removeBackfillJobsForWebPage(queue, webPageId);
    removed += sub.removed;
    skippedActive += sub.skippedActive;
  }

  return { removed, skippedActive };
}

// =====================================================
// エラーコード判定 / Error Code Mapping
// =====================================================

function mapErrorToCode(error: Error): DataMcpErrorCode {
  const message = error.message.toLowerCase();

  if (message.includes("not found")) {
    return DATA_MCP_ERROR_CODES.NOT_FOUND;
  }

  if (message.includes("invalid uuid") || message.includes("validation")) {
    return DATA_MCP_ERROR_CODES.VALIDATION_ERROR;
  }

  return DATA_MCP_ERROR_CODES.INTERNAL_ERROR;
}

// =====================================================
// data.delete ハンドラー / data.delete handler
// =====================================================

/**
 * data.delete ツールハンドラー
 * data.delete tool handler
 */
export async function dataDeleteHandler(input: unknown): Promise<DataDeleteOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] data.delete called", {
      target: (input as Record<string, unknown>)?.target,
      id: truncateId((input as Record<string, unknown>)?.id as string | undefined),
    });
  }

  // 入力バリデーション / Input validation
  let validated: DataDeleteInput;
  try {
    validated = dataDeleteInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");

      logger.warn("[MCP Tool] data.delete validation error", {
        errors: error.errors,
      });

      return {
        success: false,
        error: {
          code: DATA_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // confirm チェック / Confirm check
  if (!validated.confirm) {
    return {
      success: false,
      error: {
        code: DATA_MCP_ERROR_CODES.DELETE_NOT_CONFIRMED,
        message:
          "Deletion not confirmed. Set confirm: true to proceed with data deletion. " +
          "削除が確認されていません。データ削除を実行するには confirm: true を設定してください。",
      },
    };
  }

  // サービスファクトリーチェック / Service factory check
  if (!deleteServiceDI.get()) {
    logger.warn("[MCP Tool] data.delete service factory not set");

    return {
      success: false,
      error: {
        code: DATA_MCP_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "GDPR deletion service is not available",
      },
    };
  }

  const service = deleteServiceDI.get()!();

  try {
    // =============================================================
    // PR7a-4: Pre-delete embedding-backfill Queue cleanup
    // GDPR Art.17 / CCPA §1798.105 / LCC M-1
    // =============================================================
    // DB 削除の**前**に Queue 内の滞留ジョブを削除する。DB 削除後に Worker
    // が active ジョブを消費すると cascade delete 済み行への書き込みが失敗
    // するだけで済むが、waiting / delayed / failed ジョブは削除しないと
    // 将来の再試行で削除済みデータに対する処理が走る可能性がある。
    //
    // Clean the queue **before** DB deletion. Jobs that remain in
    // waiting/delayed/failed states could otherwise be picked up later and
    // process data the user has asked to erase.
    let queueJobsRemoved: QueueJobsRemoved | undefined;
    const backfillQueueFactory = backfillQueueDI.get();

    if (validated.target === "page" && backfillQueueFactory) {
      try {
        const queue = backfillQueueFactory();
        const summary = await removeBackfillJobsForWebPage(queue, validated.id);
        queueJobsRemoved = { embeddingBackfill: summary };
      } catch (error) {
        logger.warn("[MCP Tool] data.delete queue cleanup failed", {
          target: "page",
          id: truncateId(validated.id),
          error: sanitizeErrorMessage(error),
        });
        // Graceful Degradation: DB 削除は続行
      }
    } else if (validated.target === "all_user_data" && backfillQueueFactory) {
      try {
        const queue = backfillQueueFactory();
        const summary = await removeBackfillJobsForWebPages(queue, validated.page_ids ?? []);
        queueJobsRemoved = { embeddingBackfill: summary };
      } catch (error) {
        logger.warn("[MCP Tool] data.delete queue cleanup failed", {
          target: "all_user_data",
          pageCount: (validated.page_ids ?? []).length,
          error: sanitizeErrorMessage(error),
        });
        // Graceful Degradation: DB 削除は続行
      }
    }

    let result: PageDeletionResult | ProfileDeletionResult | AllUserDataDeletionResult;

    switch (validated.target) {
      case "page":
        result = await service.deletePage(validated.id, validated.reason);
        break;

      case "profile":
        result = await service.deleteProfile(validated.id, validated.reason);
        break;

      case "all_user_data":
        result = await service.deleteAllUserData(
          validated.page_ids ?? [],
          validated.id,
          validated.reason
        );
        break;
    }

    if (isDevelopment()) {
      logger.info("[MCP Tool] data.delete completed", {
        target: validated.target,
        id: truncateId(validated.id),
      });
    }

    // 監査ログ記録（GDPR Art.30） / Audit log (GDPR Art.30)
    const auditLogService = getAuditLogService();
    await auditLogService.log({
      action: "data.delete",
      actor: "mcp-client",
      targetType:
        validated.target === "page"
          ? "web_page"
          : validated.target === "profile"
            ? "preference_profile"
            : "all_user_data",
      targetId: validated.id,
      result: "success",
      details: { reason: validated.reason },
    });

    // PR7a-4: Queue ジョブ削除の監査ログ（DB 削除と独立に記録）
    // PR7a-4: Queue job removal audit log (recorded independently of DB deletion)
    if (queueJobsRemoved) {
      await auditLogService.log({
        action: "embedding_backfill_queue_jobs_removed",
        actor: "mcp-client",
        targetType: validated.target === "page" ? "web_page" : "all_user_data",
        targetId: validated.id,
        result: "success",
        details: {
          reason: validated.reason,
          removedCount: queueJobsRemoved.embeddingBackfill.removed,
          skippedActiveCount: queueJobsRemoved.embeddingBackfill.skippedActive,
        },
      });
    }

    if (queueJobsRemoved) {
      return {
        success: true,
        data: result,
        queueJobsRemoved,
      };
    }
    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));
    const errorCode = mapErrorToCode(errorInstance);

    logger.warn("[MCP Tool] data.delete error", {
      code: errorCode,
      error: errorInstance.message,
    });

    // 監査ログ記録（失敗） / Audit log (failure)
    const auditLogService = getAuditLogService();
    await auditLogService.log({
      action: "data.delete",
      actor: "mcp-client",
      targetType:
        validated.target === "page"
          ? "web_page"
          : validated.target === "profile"
            ? "preference_profile"
            : "all_user_data",
      targetId: validated.id,
      result: "failure",
      details: { reason: validated.reason },
    });

    return {
      success: false,
      error: {
        code: errorCode,
        message: sanitizeErrorMessage(error),
      },
    };
  }
}

// =====================================================
// data.export ハンドラー / data.export handler
// =====================================================

/**
 * data.export ツールハンドラー
 * data.export tool handler
 */
export async function dataExportHandler(input: unknown): Promise<DataExportOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] data.export called", {
      target: (input as Record<string, unknown>)?.target,
      id: truncateId((input as Record<string, unknown>)?.id as string | undefined),
    });
  }

  // 入力バリデーション / Input validation
  let validated: DataExportInput;
  try {
    validated = dataExportInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");

      logger.warn("[MCP Tool] data.export validation error", {
        errors: error.errors,
      });

      return {
        success: false,
        error: {
          code: DATA_MCP_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // サービスファクトリーチェック / Service factory check
  if (!exportServiceDI.get()) {
    logger.warn("[MCP Tool] data.export service factory not set");

    return {
      success: false,
      error: {
        code: DATA_MCP_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "GDPR export service is not available",
      },
    };
  }

  const service = exportServiceDI.get()!();

  try {
    let result: PageExportResult | ProfileExportResult;

    switch (validated.target) {
      case "page":
        result = await service.exportPageData(validated.id);
        break;

      case "profile":
        result = await service.exportProfileData(validated.id);
        break;
    }

    if (isDevelopment()) {
      logger.info("[MCP Tool] data.export completed", {
        target: validated.target,
        id: truncateId(validated.id),
      });
    }

    // 監査ログ記録（GDPR Art.30） / Audit log (GDPR Art.30)
    const auditLogService = getAuditLogService();
    await auditLogService.log({
      action: "data.export",
      actor: "mcp-client",
      targetType: validated.target === "page" ? "web_page" : "preference_profile",
      targetId: validated.id,
      result: "success",
    });

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));
    const errorCode = mapErrorToCode(errorInstance);

    logger.warn("[MCP Tool] data.export error", {
      code: errorCode,
      error: errorInstance.message,
    });

    // 監査ログ記録（失敗） / Audit log (failure)
    const auditLogService = getAuditLogService();
    await auditLogService.log({
      action: "data.export",
      actor: "mcp-client",
      targetType: validated.target === "page" ? "web_page" : "preference_profile",
      targetId: validated.id,
      result: "failure",
    });

    return {
      success: false,
      error: {
        code: errorCode,
        message: sanitizeErrorMessage(error),
      },
    };
  }
}

// =====================================================
// ツール定義 / Tool Definitions
// =====================================================

/**
 * data.delete MCPツール定義 / data.delete MCP tool definition
 */
export const dataDeleteToolDefinition = {
  name: "data.delete",
  description:
    "GDPR Art.17「忘れられる権利」/ CCPA §1798.105 に基づくデータ完全削除。" +
    "page（全関連テーブルCASCADE DELETE）、profile（嗜好プロファイル完全削除）、" +
    "all_user_data（全ユーザーデータ一括削除）から選択。confirm: true 必須。" +
    "target=page / all_user_data では DB 削除前に embedding-backfill Queue の" +
    "滞留ジョブ（7カテゴリ）も削除し、非同期 backfill による削除済みデータ復活を防止する。" +
    "GDPR Art.17 / CCPA §1798.105 Right to Erasure. Permanently deletes all data for the specified target. " +
    "Supports page (CASCADE DELETE), profile (hard delete), all_user_data (bulk delete). " +
    "confirm: true is required. For target=page / all_user_data, embedding-backfill queue jobs " +
    "(7 categories) are also removed before DB deletion to prevent async backfill from resurrecting erased data.",
  annotations: {
    title: "Data Delete (GDPR Art.17)",
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      target: {
        type: "string",
        enum: ["page", "profile", "all_user_data"],
        description:
          "削除対象 / Deletion target: page (web page + all related data), " +
          "profile (preference profile + signals), all_user_data (all pages + profile)",
      },
      id: {
        type: "string",
        format: "uuid",
        description:
          "対象ID（UUIDv7形式） / Target ID (UUIDv7 format). " +
          "page → web_page.id, profile/all_user_data → preference_profile.id",
      },
      reason: {
        type: "string",
        description:
          "削除理由（GDPR監査要件、1-500文字） / Deletion reason (GDPR audit requirement, 1-500 chars)",
      },
      confirm: {
        type: "boolean",
        description:
          "削除確認フラグ（true必須、誤削除防止） / Deletion confirmation flag (must be true)",
      },
      page_ids: {
        type: "array",
        items: { type: "string", format: "uuid" },
        description:
          "ページID配列（target=all_user_data時のみ、最大100件） / " +
          "Page IDs (only for target=all_user_data, max 100)",
      },
    },
    required: ["target", "id", "reason", "confirm"],
  },
};

/**
 * data.export MCPツール定義 / data.export MCP tool definition
 */
export const dataExportToolDefinition = {
  name: "data.export",
  description:
    "GDPR Art.20「データポータビリティの権利」に基づくデータエクスポート。" +
    "指定されたpage/profileの全関連データをJSON形式でエクスポート。PII情報を明示的にマーキング。" +
    "GDPR Art.20 Right to Data Portability. Exports all related data for the specified target in JSON format. " +
    "PII fields are explicitly marked.",
  annotations: {
    title: "Data Export (GDPR Art.20)",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      target: {
        type: "string",
        enum: ["page", "profile"],
        description:
          "エクスポート対象 / Export target: page (web page + all related data), profile (preference profile + signals)",
      },
      id: {
        type: "string",
        format: "uuid",
        description: "対象ID（UUIDv7形式） / Target ID (UUIDv7 format)",
      },
    },
    required: ["target", "id"],
  },
};

// =====================================================
// 開発環境ログ / Development Environment Log
// =====================================================

if (isDevelopment()) {
  logger.debug("[data.delete] Tool module loaded");
  logger.debug("[data.export] Tool module loaded");
}
