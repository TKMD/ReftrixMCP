// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.track_changes MCPツール
 * 同一URLのデザイン変更を時系列で追跡し、embedding diffによる変更検出・可視化を行う
 *
 * アクション:
 * - snapshot: 現在のデザイン状態をスナップショットとして保存
 * - compare: 2つのスナップショットを比較してembedding diffを算出
 * - history: URL別のスナップショット履歴を取得
 * - detect: 最新分析結果と直前スナップショットの差分を自動検出
 *
 * セキュリティ:
 * - Zodバリデーション
 * - sanitizeErrorMessage使用 (CWE-209)
 * - UUIDバリデーション
 * - NaN/Infinity防御（サービス層で実装）
 *
 * design.track_changes MCP Tool
 * Tracks design changes of the same URL over time with embedding diff detection
 *
 * @module tools/design/track-changes.tool
 */

import { z } from "zod";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import {
  createSnapshot,
  compareSnapshots,
  getHistory,
  detectChanges,
  getDesignChangeTrackerPrismaClientFactory,
  DESIGN_CHANGE_ERROR_CODES,
} from "../../services/design-change-tracker.service";

// =====================================================
// Constants / 定数
// =====================================================

/** UUID v4/v7 pattern */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// =====================================================
// Input Schema / 入力スキーマ
// =====================================================

export const designTrackChangesInputSchema = z.object({
  url: z
    .string()
    .url({ message: "有効なURL形式を指定してください / Valid URL format required" })
    .describe("対象WebページのURL / Target web page URL"),
  action: z
    .enum(["snapshot", "compare", "history", "detect"])
    .describe(
      "実行するアクション: snapshot（保存）、compare（比較）、history（履歴）、detect（差分検出）" +
        " / Action: snapshot (save), compare (diff), history (list), detect (auto-detect changes)"
    ),
  snapshot_ids: z
    .array(z.string().regex(UUID_PATTERN, "Invalid UUID format"))
    .min(2)
    .max(2)
    .optional()
    .describe(
      "compare アクション時の比較対象スナップショットID（2件、UUID形式）" +
        " / Snapshot IDs for compare action (exactly 2, UUID format)"
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe(
      "history アクション時の取得件数（1-50、デフォルト10）" +
        " / Number of results for history action (1-50, default 10)"
    ),
  auto_snapshot: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "page.analyze完了後に自動スナップショット生成するか（デフォルト: false）" +
        " / Auto-create snapshot after page.analyze completion (default: false)"
    ),
});

export type DesignTrackChangesInput = z.infer<typeof designTrackChangesInputSchema>;

// =====================================================
// Output Type / 出力型
// =====================================================

export interface DesignTrackChangesOutput {
  success: boolean;
  action?: string;
  snapshot?: {
    id: string;
    section_count: number;
    overall_score: number | null;
    snapshot_at: string;
  };
  comparison?: {
    snapshot_before: { id: string; snapshot_at: string };
    snapshot_after: { id: string; snapshot_at: string };
    change_score: number;
    added_count: number;
    removed_count: number;
    modified_count: number;
    unchanged_count: number;
    changes: Array<{
      section_type: string;
      section_name: string | null;
      category: string;
      text_similarity: number | null;
      vision_similarity: number | null;
    }>;
  };
  history?: {
    url: string;
    snapshots: Array<{
      id: string;
      snapshot_at: string;
      section_count: number;
      overall_score: number | null;
    }>;
  };
  detection?: {
    has_changes: boolean;
    change_score: number;
    added_count: number;
    removed_count: number;
    modified_count: number;
    unchanged_count: number;
  };
  message?: string;
  error?: string;
}

// =====================================================
// Handler / ハンドラー
// =====================================================

/**
 * design.track_changes ハンドラー
 * design.track_changes handler
 */
export async function designTrackChangesHandler(input: unknown): Promise<DesignTrackChangesOutput> {
  const startTime = Date.now();

  // 入力バリデーション / Input validation
  let parsed: DesignTrackChangesInput;
  try {
    parsed = designTrackChangesInputSchema.parse(input);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
        : "Invalid input";
    return {
      success: false,
      error: `${DESIGN_CHANGE_ERROR_CODES.INVALID_INPUT}: ${message}`,
    };
  }

  try {
    switch (parsed.action) {
      case "snapshot": {
        // URL → webPageId の解決はサービス内部で行う
        // まず URL から webPageId を取得する
        const webPageId = await resolveWebPageId(parsed.url);
        if (!webPageId) {
          return {
            success: false,
            action: "snapshot",
            error: `${DESIGN_CHANGE_ERROR_CODES.PAGE_NOT_FOUND}: Page not found for URL`,
          };
        }

        const result = await createSnapshot(webPageId);
        if (!result.success) {
          return {
            success: false,
            action: "snapshot",
            error: result.error ?? "Snapshot creation failed",
          };
        }

        return {
          success: true,
          action: "snapshot",
          snapshot: {
            id: result.snapshot_id!,
            section_count: result.section_count!,
            overall_score: result.overall_score ?? null,
            snapshot_at: result.snapshot_at!,
          },
        };
      }

      case "compare": {
        if (!parsed.snapshot_ids || parsed.snapshot_ids.length !== 2) {
          return {
            success: false,
            action: "compare",
            error: `${DESIGN_CHANGE_ERROR_CODES.INVALID_INPUT}: compare action requires exactly 2 snapshot_ids`,
          };
        }

        const id1 = parsed.snapshot_ids[0]!;
        const id2 = parsed.snapshot_ids[1]!;
        const result = await compareSnapshots(id1, id2);
        if (!result.success) {
          return { success: false, action: "compare", error: result.error ?? "Comparison failed" };
        }

        return {
          success: true,
          action: "compare",
          comparison: {
            snapshot_before: result.snapshot_before!,
            snapshot_after: result.snapshot_after!,
            change_score: result.summary!.change_score,
            added_count: result.summary!.added_count,
            removed_count: result.summary!.removed_count,
            modified_count: result.summary!.modified_count,
            unchanged_count: result.summary!.unchanged_count,
            changes: result.changes!.map((c) => ({
              section_type: c.section_type,
              section_name: c.section_name,
              category: c.category,
              text_similarity: c.text_similarity,
              vision_similarity: c.vision_similarity,
            })),
          },
        };
      }

      case "history": {
        const result = await getHistory(parsed.url, parsed.limit);
        if (!result.success) {
          return {
            success: false,
            action: "history",
            error: result.error ?? "History retrieval failed",
          };
        }

        return {
          success: true,
          action: "history",
          history: {
            url: result.url!,
            snapshots: result.snapshots ?? [],
          },
        };
      }

      case "detect": {
        const webPageId = await resolveWebPageId(parsed.url);
        if (!webPageId) {
          return {
            success: false,
            action: "detect",
            error: `${DESIGN_CHANGE_ERROR_CODES.PAGE_NOT_FOUND}: Page not found for URL`,
          };
        }

        const result = await detectChanges(webPageId);
        if (!result.success) {
          return { success: false, action: "detect", error: result.error ?? "Detection failed" };
        }

        if (result.message) {
          return {
            success: true,
            action: "detect",
            message: result.message,
          };
        }

        return {
          success: true,
          action: "detect",
          detection: {
            has_changes: result.has_changes ?? false,
            change_score: result.summary?.change_score ?? 0,
            added_count: result.summary?.added_count ?? 0,
            removed_count: result.summary?.removed_count ?? 0,
            modified_count: result.summary?.modified_count ?? 0,
            unchanged_count: result.summary?.unchanged_count ?? 0,
          },
        };
      }

      default:
        return {
          success: false,
          error: `${DESIGN_CHANGE_ERROR_CODES.INVALID_INPUT}: Unknown action`,
        };
    }
  } catch (error) {
    logger.warn("[design.track_changes] Handler failed", {
      action: parsed.action,
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      action: parsed.action,
      error: `${DESIGN_CHANGE_ERROR_CODES.SNAPSHOT_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  } finally {
    logger.info("[design.track_changes] completed", {
      action: (input as Record<string, unknown>)?.action,
      processingTimeMs: Date.now() - startTime,
    });
  }
}

// =====================================================
// URL → webPageId resolver
// =====================================================

/**
 * URLからwebPageIdを解決するヘルパー
 * Helper to resolve webPageId from URL
 *
 * NOTE: サービス層のDI Prismaクライアントを使用
 */
async function resolveWebPageId(url: string): Promise<string | null> {
  // design-change-tracker.service の DI factory を経由
  const factory = getDesignChangeTrackerPrismaClientFactory();
  if (!factory) return null;

  const prisma = factory();
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM web_pages WHERE url = $1 LIMIT 1`,
    url
  );

  const firstRow = rows[0];
  return firstRow ? firstRow.id : null;
}

// =====================================================
// Tool Definition / ツール定義
// =====================================================

export const designTrackChangesToolDefinition = {
  name: "design.track_changes",
  description:
    "同一URLのデザイン変更を時系列で追跡します。スナップショット保存、embedding diffによる変更検出、" +
    "履歴管理、自動変更検出の4つのアクションを提供します。" +
    "変更度スコア（0=同一、1=完全に異なる）とセクション単位の変更カテゴリ" +
    "（added/removed/modified/unchanged）で変更を可視化します。" +
    " / Tracks design changes of the same URL over time. Provides 4 actions: " +
    "snapshot (save), compare (embedding diff), history (list), detect (auto-detect). " +
    "Visualizes changes with change score (0=identical, 1=completely different) " +
    "and per-section categories (added/removed/modified/unchanged).",
  annotations: {
    title: "Design Change Tracker",
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        format: "uri",
        description: "対象WebページのURL / Target web page URL",
      },
      action: {
        type: "string",
        enum: ["snapshot", "compare", "history", "detect"],
        description: "実行するアクション / Action to execute: snapshot|compare|history|detect",
      },
      snapshot_ids: {
        type: "array",
        items: { type: "string", format: "uuid" },
        minItems: 2,
        maxItems: 2,
        description:
          "compare アクション時のスナップショットID（2件） / Snapshot IDs for compare (exactly 2)",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 10,
        description:
          "history アクション時の取得件数（デフォルト10） / Result limit for history (default 10)",
      },
      auto_snapshot: {
        type: "boolean",
        default: false,
        description: "page.analyze後の自動スナップショット / Auto-snapshot after page.analyze",
      },
    },
    required: ["url", "action"],
  },
};
