// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * audit.query MCPツール — 監査ログ検索
 *
 * GDPR Art.30 処理活動記録の検索・閲覧ツール。
 * PII配慮 (多層防御 / Defense-in-depth):
 *   1. ingest-time: AuditLogService.log() で targetId truncate / sanitizeDetails() による機密キー除去
 *   2. query-time (本 module, LCC M-02): handler 境界で details.metadata 内 PII (child_pid 等) を
 *      SSOT-derived truncation で redact
 *
 * audit.query MCP tool — Audit log query
 * GDPR Art.30 processing activities records search tool.
 * PII consideration (Defense-in-depth):
 *   1. ingest-time: AuditLogService.log() truncates targetId and sanitizes sensitive keys
 *   2. query-time (this module, LCC M-02): handler-boundary redaction of PII fields
 *      (e.g. child_pid) inside details.metadata via SSOT-derived truncation
 *
 * Cross-ref: `.claude/rules/security.md` "Canonical CWE-209 PII Protection Pattern (LCC-endorsed)"
 *
 * @module tools/audit/query.tool
 */

import { z, ZodError } from "zod";
import { createDIFactory } from "../../utils/di-factory";
import { sanitizeAnalysisErrorForClient, sanitizeErrorMessage } from "../../utils/sanitize-error";
import { logger, isDevelopment } from "../../utils/logger";
import {
  AUDIT_LOG_CONSTANTS,
  type AuditLogService,
  type AuditLogRecord,
} from "../../services/audit-log.service";

// =====================================================
// エラーコード / Error Codes
// =====================================================

/**
 * audit.query MCPエラーコード
 * audit.query MCP error codes
 */
export const AUDIT_QUERY_ERROR_CODES = {
  /** 入力バリデーションエラー / Input validation error */
  VALIDATION_ERROR: "VALIDATION_ERROR",
  /** サービス未設定 / Service not available */
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  /** 内部エラー / Internal error */
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type AuditQueryErrorCode =
  (typeof AUDIT_QUERY_ERROR_CODES)[keyof typeof AUDIT_QUERY_ERROR_CODES];

// =====================================================
// 入力スキーマ / Input Schema
// =====================================================

/**
 * ISO 8601日付文字列バリデーション
 * ISO 8601 date string validation
 */
const isoDateStringSchema = z.string().refine(
  (val) => {
    const d = new Date(val);
    return !isNaN(d.getTime());
  },
  { message: "Invalid ISO 8601 date string" }
);

/**
 * audit.query 入力スキーマ
 * audit.query input schema
 */
export const auditQueryInputSchema = z.object({
  /** アクションフィルタ / Action filter */
  action: z.string().max(100).optional(),
  /** ターゲットタイプフィルタ / Target type filter */
  target_type: z.string().max(100).optional(),
  /** 開始日時（ISO 8601） / Start date (ISO 8601) */
  start_date: isoDateStringSchema.optional(),
  /** 終了日時（ISO 8601） / End date (ISO 8601) */
  end_date: isoDateStringSchema.optional(),
  /** 結果上限（最大100、デフォルト20） / Result limit (max 100, default 20) */
  limit: z.number().int().min(1).max(100).optional(),
});

export type AuditQueryInput = z.infer<typeof auditQueryInputSchema>;

// =====================================================
// 出力型 / Output Types
// =====================================================

/**
 * 監査ログクエリ結果のログエントリ
 * Audit log query result entry
 */
interface AuditLogOutputEntry {
  id: string;
  timestamp: string;
  action: string;
  actor: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  result: string;
}

/**
 * audit.query 出力型
 * audit.query output type
 */
export type AuditQueryOutput =
  | {
      success: true;
      data: {
        logs: AuditLogOutputEntry[];
        count: number;
      };
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

// =====================================================
// DI Factory
// =====================================================

const auditLogServiceDI = createDIFactory<AuditLogService>("AuditLogService");

export const setAuditQueryServiceFactory = auditLogServiceDI.set;
export const resetAuditQueryServiceFactory = auditLogServiceDI.reset;

// =====================================================
// ヘルパー / Helpers
// =====================================================

/**
 * details.metadata 内の PII フィールド検出パターン
 * PII field detection regex within details.metadata
 *
 * 対象 / Target: child_pid / workerPid / pid (case-insensitive)
 * SSOT: AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH (canonical CWE-209 PII Protection Pattern)
 *
 * Cross-ref: `.claude/rules/security.md` "Canonical CWE-209 PII Protection Pattern (LCC-endorsed)"
 * — Wave 5 endorsement; SSOT-derived (NOT hardcoded literal).
 */
const METADATA_PII_FIELD_REGEX = /^(child_pid|workerPid|pid)$/i;

/**
 * details.metadata 内の PII (process identifiers) を SSOT-derived truncation で redact する。
 * Defense-in-depth runtime redaction at the audit.query handler boundary
 * (in addition to ingest-time `sanitizeDetails()` in `audit-log.service.ts`).
 *
 * Redacts PII (process identifiers) inside `details.metadata` via SSOT-derived truncation.
 *
 * - 1-level nesting only (intentional: keep contract simple, extend if patterns emerge).
 *   1段階のネストのみ対応 (意図的: 契約をシンプルに保ち、新パターン出現時に拡張)。
 * - SSOT: AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH (no hardcoded literal).
 *   SSOT 由来の truncation length を使用 (ハードコード禁止)。
 * - Idempotent: already-truncated values pass through unchanged when length ≤ SSOT length.
 *   冪等: 既に truncate 済みの値は SSOT 長以下ならそのまま返る。
 *
 * @param details - DB から読み取った details payload / details payload from DB
 * @returns Redacted details payload (deep-cloned at metadata level) / 浅いクローンで redact 済み details
 */
function redactDetailsMetadata(
  details: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (details === null || details === undefined) {
    return null;
  }

  const metadata = details.metadata;
  // metadata が object でない (string / number / array / null / undefined) なら redaction 対象外
  // Skip redaction if metadata is not a plain object
  if (
    metadata === null ||
    metadata === undefined ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    return details;
  }

  const sourceMetadata = metadata as Record<string, unknown>;
  const redactedMetadata: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(sourceMetadata)) {
    if (METADATA_PII_FIELD_REGEX.test(key) && typeof value === "string") {
      // SSOT-derived truncation (canonical CWE-209 PII Protection Pattern)
      // SSOT 由来の truncation (canonical CWE-209 PII 保護パターン)
      if (value.length <= AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) {
        redactedMetadata[key] = value;
      } else {
        redactedMetadata[key] =
          value.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...";
      }
    } else {
      redactedMetadata[key] = value;
    }
  }

  return {
    ...details,
    metadata: redactedMetadata,
  };
}

/**
 * details 内 (top-level + nested metadata) の `failed_known_reason` フィールドを
 * client-safe な generic literal に sanitize する (Plan v3 Track T4 SEC H-01)。
 *
 * Sanitises `failed_known_reason` field in `details` (top-level + nested
 * `details.metadata`) to client-safe generic literal — Plan v3 Track T4 SEC H-01.
 *
 * **Two-tier surface contract** (from `sanitizeAnalysisErrorForClient` JSDoc):
 * - **DB internal canonical** (preserved): `worker_restart_during_inflight_phase_<N>`
 *   stored verbatim in `audit_logs.details.failed_known_reason` for operator
 *   dashboards and supervisor backfill `findOrphanWebPageIds` matching.
 * - **Client-facing generic** (this layer): `analysis_pipeline_interrupted`
 *   surfaced through `audit.query` MCP tool to prevent CWE-209 information
 *   exposure of internal phase taxonomy.
 *
 * Defense-in-depth at the audit.query handler boundary (independent of
 * ingest-time write side). The DB raw audit trail remains for forensics;
 * the client-facing surface is sanitised. This complements
 * `redactDetailsMetadata` (which targets PII process identifiers) — these are
 * orthogonal concerns and run sequentially.
 *
 * @param details - Details payload (potentially redacted by upstream layer)
 * @returns Details payload with `failed_known_reason` 1:1-mapped at top-level
 *   AND nested under `details.metadata` (covers both audit_logs emit shapes:
 *   T4 `WorkerRestartInflightAuditMetadata` puts it at top-level; legacy
 *   shapes may nest it under metadata).
 *
 * @see PR-V3-T4 design.md §6.3 (SEC H-01 sanitisation contract)
 * @see `.claude/rules/security.md` "Canonical CWE-209 PII Protection Pattern (LCC-endorsed)"
 */
function sanitizeFailedKnownReasonInDetails(
  details: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (details === null || details === undefined) {
    return null;
  }

  // Sanitize top-level details.failed_known_reason
  // (T4 WorkerRestartInflightAuditMetadata shape stores it at top-level of details)
  let result: Record<string, unknown> = details;
  const topLevel = details.failed_known_reason;
  if (typeof topLevel === "string") {
    const sanitised = sanitizeAnalysisErrorForClient(topLevel);
    if (sanitised !== topLevel) {
      result = { ...result, failed_known_reason: sanitised };
    }
  }

  // Sanitize nested details.metadata.failed_known_reason
  // (defensive coverage for any legacy / future audit_log emit shape)
  const metadata = result.metadata;
  if (
    metadata !== null &&
    metadata !== undefined &&
    typeof metadata === "object" &&
    !Array.isArray(metadata)
  ) {
    const sourceMetadata = metadata as Record<string, unknown>;
    const nestedReason = sourceMetadata.failed_known_reason;
    if (typeof nestedReason === "string") {
      const sanitised = sanitizeAnalysisErrorForClient(nestedReason);
      if (sanitised !== nestedReason) {
        result = {
          ...result,
          metadata: {
            ...sourceMetadata,
            failed_known_reason: sanitised,
          },
        };
      }
    }
  }

  return result;
}

/**
 * DB AuditLogRecord → MCP出力形式に変換
 * Convert DB AuditLogRecord to MCP output format
 *
 * Defense-in-depth (3-layer): applies the following sanitization layers
 * sequentially at the handler boundary:
 *   1. `redactDetailsMetadata()` — PII process identifiers (LCC M-02, Z-b)
 *   2. `sanitizeFailedKnownReasonInDetails()` — `failed_known_reason` enum
 *      CWE-209 information exposure (Plan v3 T4 SEC H-01, Z-a Wave 2)
 * In addition to ingest-time `sanitizeDetails()` (audit-log.service.ts) — all
 * layers are independent and any future PII / enum leakage path is closed by
 * any of them.
 *
 * 多層防御 (3-layer): handler 境界で
 *   1. `redactDetailsMetadata()` (PII プロセス識別子, LCC M-02)
 *   2. `sanitizeFailedKnownReasonInDetails()` (`failed_known_reason` enum
 *      CWE-209 情報露出, Plan v3 T4 SEC H-01)
 * を順次適用。ingest 時の `sanitizeDetails()` と独立しており、
 * いずれの経路で PII / enum 値が入り込んでも閉じられる。
 */
function toOutputEntry(record: AuditLogRecord): AuditLogOutputEntry {
  // Layer 1: PII process-identifier redaction (LCC M-02)
  const piiRedacted = redactDetailsMetadata(record.details);
  // Layer 2: failed_known_reason CWE-209 sanitisation (SEC H-01)
  const fullySanitised = sanitizeFailedKnownReasonInDetails(piiRedacted);

  return {
    id: record.id,
    timestamp:
      record.timestamp instanceof Date ? record.timestamp.toISOString() : String(record.timestamp),
    action: record.action,
    actor: record.actor,
    target_type: record.targetType,
    target_id: record.targetId,
    details: fullySanitised,
    result: record.result,
  };
}

// =====================================================
// メインハンドラー / Main Handler
// =====================================================

/**
 * audit.query ツールハンドラー
 * audit.query tool handler
 *
 * @param input - 入力パラメータ / Input parameters
 * @returns クエリ結果 / Query result
 */
export async function auditQueryHandler(input: unknown): Promise<AuditQueryOutput> {
  if (isDevelopment()) {
    logger.info("[MCP Tool] audit.query called");
  }

  // 入力バリデーション / Input validation
  let validated: AuditQueryInput;
  try {
    validated = auditQueryInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");

      logger.warn("[MCP Tool] audit.query validation error", {
        errors: error.errors,
      });

      return {
        success: false,
        error: {
          code: AUDIT_QUERY_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  // サービスファクトリーチェック / Service factory check
  if (!auditLogServiceDI.get()) {
    logger.warn("[MCP Tool] audit.query service factory not set");

    return {
      success: false,
      error: {
        code: AUDIT_QUERY_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "Audit log service is not available",
      },
    };
  }

  const service = auditLogServiceDI.get()!();

  try {
    const records = await service.query({
      action: validated.action,
      targetType: validated.target_type,
      startDate: validated.start_date ? new Date(validated.start_date) : undefined,
      endDate: validated.end_date ? new Date(validated.end_date) : undefined,
      limit: validated.limit,
    });

    const logs = records.map(toOutputEntry);

    if (isDevelopment()) {
      logger.info("[MCP Tool] audit.query completed", {
        count: logs.length,
      });
    }

    return {
      success: true,
      data: {
        logs,
        count: logs.length,
      },
    };
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));

    logger.warn("[MCP Tool] audit.query error", {
      error: errorInstance.message,
    });

    return {
      success: false,
      error: {
        code: AUDIT_QUERY_ERROR_CODES.INTERNAL_ERROR,
        message: sanitizeErrorMessage(error),
      },
    };
  }
}

// =====================================================
// ツール定義 / Tool Definition
// =====================================================

/**
 * audit.query MCPツール定義
 * audit.query MCP tool definition
 */
export const auditQueryToolDefinition = {
  name: "audit.query",
  description:
    "監査ログを検索します。GDPR Art.30に基づく処理活動記録の閲覧。" +
    "Query audit logs. View records of processing activities per GDPR Art.30.",
  annotations: {
    title: "Audit Log Query",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        description:
          "アクションフィルタ（例: data.delete, page.analyze） / " +
          "Action filter (e.g., data.delete, page.analyze)",
      },
      target_type: {
        type: "string",
        description:
          "ターゲットタイプフィルタ（例: web_page, preference_profile） / " +
          "Target type filter (e.g., web_page, preference_profile)",
      },
      start_date: {
        type: "string",
        format: "date-time",
        description: "開始日時（ISO 8601形式） / Start date (ISO 8601 format)",
      },
      end_date: {
        type: "string",
        format: "date-time",
        description: "終了日時（ISO 8601形式） / End date (ISO 8601 format)",
      },
      limit: {
        type: "number",
        description: "結果上限（最大100、デフォルト20） / Result limit (max 100, default 20)",
        minimum: 1,
        maximum: 100,
      },
    },
    required: [],
  },
};

// =====================================================
// 開発環境ログ / Development Environment Log
// =====================================================

if (isDevelopment()) {
  logger.debug("[audit.query] Tool module loaded");
}
