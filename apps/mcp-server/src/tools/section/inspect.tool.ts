// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * section.inspect MCPツール（WebUI v1 W6 Issue A PR-1 — ADR-0042 / Registry §1）
 *
 * セクションハンドル `reftrix:page/<id>/section/<id>` を Claude が MCP で解決するための
 * 最小 read tool。`part.search` は結果に `section_pattern_id` を返さないため、セクション
 * 単位のハンドル解決ができなかった（TPA-PLAN-01）。本ツールは section_pattern_id 単独で
 * セクションのメタデータ（section_type / position 等）+ サニタイズ済み構造プレビューを返す。
 *
 * Minimal read tool so Claude can resolve a section handle `reftrix:page/<id>/section/<id>` via
 * MCP. `part.search` never returns `section_pattern_id`, so section-level handle resolution was
 * impossible (TPA-PLAN-01). This tool returns section metadata + a sanitized structure preview
 * from a `section_pattern_id` alone.
 *
 * セキュリティ / プライバシー契約 / Security & privacy contract:
 * - PII redaction: high-PII section（high-PII part を含むセクション）の `htmlSnippet` / 構造
 *   プレビューは `getHighPiiSectionIds` SSOT を **mirror** して null 化する（inline 再実装禁止、
 *   `INV-SECTION-INSPECT-PII-REDACTION-001`、`INV-WEBUI-HIGHPII-NEVER-IN-RESPONSE-001` を section
 *   image/markup sink に拡張）。
 * - id resolution / null-row 非開示: 不正な UUID は VALIDATION_ERROR、存在しない
 *   section_pattern_id は NOT_FOUND（`INV-SECTION-INSPECT-HANDLE-RESOLVE-001`、SEC-M-02）。
 *   honesty note: section.inspect は single-tenant（tenant/owner 列を持たない）ゆえ、この reject は
 *   authz/IDOR control ではなく id resolution の null-row 非開示（NOT_FOUND）である（part.inspect の
 *   precedent と同一）。`z.string().uuid()` は version-agnostic（UUID v4 も accept）ゆえ「UUID」と表記。
 *   / Honesty note: section.inspect is single-tenant (no tenant/owner column), so this reject is NOT
 *   an authz/IDOR control — it is null-row non-disclosure (NOT_FOUND) of id resolution (same as the
 *   part.inspect precedent). `z.string().uuid()` is version-agnostic (accepts UUID v4) → "UUID".
 * - `sanitizeErrorMessage`（CWE-209）: 内部構造（テーブル名・カラム名・SQL）を一切露出しない。
 * - read-only: create / update / delete を一切行わない。
 *
 * @module tools/section/inspect.tool
 */

import { ZodError } from "zod";
import { logger, isDevelopment } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { sanitizeHtml } from "../../utils/html-sanitizer";
import { sectionInspectInputSchema, type SectionInspectInput } from "./schemas";
import {
  getSectionDetail,
  getSectionParts,
  type PartSummary,
} from "../../api/internal/page-detail.service";

// =====================================================
// 定数 / Constants
// =====================================================

/**
 * opt-in parts summary の取得上限（セクション単位のため pagination 不要）。
 * un-paginated hard cap: 50 を超えるパーツを持つセクションは `sampleIndex asc` の先頭 50 件に
 * truncate される（bounded preview、完全列挙ではない）。
 * Un-paginated hard cap: a section with >50 parts is truncated to the first 50 by `sampleIndex asc`
 * (a bounded preview, not a complete enumeration).
 */
const SECTION_PARTS_TAKE = 50;

// =====================================================
// 型定義 / Types
// =====================================================

/**
 * section.inspect 結果のセクション詳細
 * Section detail for the section.inspect result
 */
export interface SectionInspectDetail {
  id: string;
  /** 所属ページ id（ハンドルが自己記述的になる）。 */
  webPageId: string;
  sectionType: string;
  sectionName: string | null;
  positionIndex: number;
  /** `layout_info.position`（bbox、不在時 null）。 */
  position: unknown;
  /** high-PII section では null（section-linked redaction）。 */
  htmlSnippet: string | null;
  /** opt-in: サニタイズ済み構造プレビュー（high-PII section では null/省略）。 */
  structurePreview?: string | null;
  /** opt-in: セクション内パーツのサマリ（per-part high-PII redaction 済）。 */
  partsSummary?: PartSummary[];
}

/**
 * section.inspect 出力型
 * section.inspect output type
 */
export type SectionInspectOutput =
  | {
      success: true;
      data: SectionInspectDetail;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

// =====================================================
// エラーコード / Error codes
// =====================================================

export const SECTION_INSPECT_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

/** PII ログ用 id truncation（CWE-209 / PII-aware logging）。 */
function truncateId(id: string): string {
  return `${id.slice(0, 8)}...`;
}

// =====================================================
// メインハンドラー / Main handler
// =====================================================

/**
 * section.inspect ツールハンドラー
 * section.inspect tool handler
 *
 * @param input - 入力パラメータ / Input parameters
 * @returns セクション詳細情報 / Section detail info
 */
export async function sectionInspectHandler(input: unknown): Promise<SectionInspectOutput> {
  // 入力バリデーション / Input validation
  let validated: SectionInspectInput;
  try {
    validated = sectionInspectInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
      logger.warn("[MCP Tool] section.inspect validation error", {
        errors: error.errors,
      });
      return {
        success: false,
        error: {
          code: SECTION_INSPECT_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  if (isDevelopment()) {
    logger.info("[MCP Tool] section.inspect called", {
      sectionId: truncateId(validated.section_id),
    });
  }

  try {
    // セクション metadata + section-linked redaction（getHighPiiSectionIds SSOT mirror）/
    // Section metadata + section-linked redaction (getHighPiiSectionIds SSOT mirror)
    const section = await getSectionDetail(validated.section_id);

    // 存在しない section_pattern_id は NOT_FOUND（id resolution の null-row 非開示。single-tenant
    // ゆえ authz/IDOR control ではない、part.inspect precedent と同一）/
    // Non-existent section_pattern_id → NOT_FOUND (null-row non-disclosure of id resolution;
    // single-tenant, so NOT an authz/IDOR control — same as the part.inspect precedent)
    if (!section) {
      return {
        success: false,
        error: {
          code: SECTION_INSPECT_ERROR_CODES.NOT_FOUND,
          message: `Section not found: ${truncateId(validated.section_id)}`,
        },
      };
    }

    const detail: SectionInspectDetail = {
      id: section.id,
      webPageId: section.webPageId,
      sectionType: section.sectionType,
      sectionName: section.sectionName,
      positionIndex: section.positionIndex,
      position: section.position,
      htmlSnippet: section.htmlSnippet,
    };

    // opt-in 構造プレビュー: PII redaction 済 htmlSnippet をサニタイズ。high-PII section では
    // section.htmlSnippet が既に null ゆえ preview も null（PII sink 拡張防止）/
    // opt-in structure preview: sanitize the already-PII-redacted htmlSnippet. For a high-PII
    // section, section.htmlSnippet is already null, so the preview stays null (no new PII sink).
    if (validated.include_structure_preview) {
      detail.structurePreview = section.htmlSnippet ? sanitizeHtml(section.htmlSnippet) : null;
    }

    // opt-in パーツサマリ: per-part high-PII redaction 済（getSectionParts SSOT）/
    // opt-in parts summary: per-part high-PII redaction applied (getSectionParts SSOT)
    if (validated.include_parts_summary) {
      detail.partsSummary = await getSectionParts(section.id, SECTION_PARTS_TAKE);
    }

    if (isDevelopment()) {
      logger.info("[MCP Tool] section.inspect completed", {
        sectionId: truncateId(section.id),
        sectionType: detail.sectionType,
      });
    }

    return { success: true, data: detail };
  } catch (error) {
    logger.warn("[MCP Tool] section.inspect error", {
      error: sanitizeErrorMessage(error),
      sectionId: truncateId(validated.section_id),
    });
    return {
      success: false,
      error: {
        code: SECTION_INSPECT_ERROR_CODES.INTERNAL_ERROR,
        message: sanitizeErrorMessage(error),
      },
    };
  }
}

// =====================================================
// ツール定義 / Tool definition
// =====================================================

/**
 * section.inspect MCPツール定義
 * section.inspect MCP tool definition
 */
export const sectionInspectToolDefinition = {
  name: "section.inspect",
  description:
    "セクションパターンIDからセクションのメタデータ（section_type / position 等）と" +
    "サニタイズ済み構造プレビューを取得します。セクションハンドル " +
    "reftrix:page/<id>/section/<id> の解決に使用します。high-PII セクションの構造は秘匿されます。" +
    " / Inspect a section by section_pattern_id. Returns section metadata (section_type, position, " +
    "etc.) and a sanitized structure preview, for resolving a section handle " +
    "reftrix:page/<id>/section/<id>. High-PII section structure is redacted.",
  annotations: {
    title: "Section Inspect",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      section_id: {
        type: "string",
        format: "uuid",
        description: "セクションパターンID（UUID） / Section pattern ID (UUID)",
      },
      include_structure_preview: {
        type: "boolean",
        default: false,
        description:
          "サニタイズ済み構造プレビューを含める（high-PII は秘匿） / Include sanitized structure preview (redacted for high-PII)",
      },
      include_parts_summary: {
        type: "boolean",
        default: false,
        description:
          "セクション内パーツのサマリを含める（high-PII は redaction） / Include section parts summary (high-PII redacted)",
      },
    },
    required: ["section_id"],
  },
};

// =====================================================
// 開発環境ログ / Dev log
// =====================================================

if (isDevelopment()) {
  logger.debug("[section.inspect] Tool module loaded");
}
