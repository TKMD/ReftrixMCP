// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part-Level Analysis Zod validation schemas
 *
 * パーツ単位分析のZodバリデーションスキーマ。
 * MCP tool入力検証、設定検証、PII truncateユーティリティを提供。
 *
 * Zod validation schemas for Part-Level Analysis.
 * Provides MCP tool input validation, config validation, and PII truncation utility.
 *
 * @module services/part/schemas
 */

import { z } from "zod";
import { ALL_PART_TYPES } from "./types";

// ============================================================================
// PII Truncation Utility / PII切り詰めユーティリティ
// ============================================================================

/**
 * IDをログ出力用にtruncateする（PII配慮）
 * Truncate ID for log output (PII consideration)
 *
 * @param id - 対象ID / Target ID
 * @param length - truncate長（デフォルト8） / Truncation length (default 8)
 * @returns truncate済みID / Truncated ID
 */
export function truncateId(id: string, length: number = 8): string {
  return `${id.slice(0, length)}...`;
}

// ============================================================================
// Base Schemas / 基本スキーマ
// ============================================================================

/**
 * パーツタイプスキーマ（コア16タイプ）
 * Part type schema (core 16 types)
 */
export const partTypeSchema = z.enum(ALL_PART_TYPES);

/**
 * PIIリスクレベルスキーマ
 * PII risk level schema
 */
export const piiRiskLevelSchema = z.enum(["none", "low", "high"]);

/**
 * 利用範囲スキーマ（inspiration_onlyのみ許可）
 * Usage scope schema (restricted to inspiration_only)
 *
 * 著作権法第30条の4に基づき、直接的な複製・再利用を意図しない。
 * Based on Copyright Act Art.30-4; not intended for direct reproduction.
 */
export const usageScopeSchema = z.enum(["inspiration_only"]).default("inspiration_only");

/**
 * バウンディングボックススキーマ
 * Bounding box schema
 */
export const boundingBoxSchema = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().min(0),
  height: z.number().min(0),
});

/**
 * インタラクション情報スキーマ
 * Interaction info schema
 */
export const interactionInfoSchema = z.object({
  hasHover: z.boolean(),
  hasFocus: z.boolean(),
  hasActive: z.boolean(),
  hasTransition: z.boolean(),
  transitionDuration: z.string().optional(),
});

// ============================================================================
// Config Schema / 設定スキーマ
// ============================================================================

/**
 * パーツ抽出設定スキーマ
 * Part extraction config schema
 *
 * Phase 1.1のパーツ抽出パイプライン設定を検証。
 * Validates Phase 1.1 part extraction pipeline configuration.
 */
export const partExtractionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxPartsPerType: z.number().int().min(1).max(20).default(5),
  minPartSize: z.number().int().min(1).default(20),
  cropSize: z.number().int().min(64).max(512).default(224),
  partTypes: z.array(partTypeSchema).default([...ALL_PART_TYPES]),
  rssLimitBytes: z
    .number()
    .int()
    .min(0)
    .default(8 * 1024 * 1024 * 1024),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
});

// ============================================================================
// MCP Tool Input Schemas / MCPツール入力スキーマ
// ============================================================================

/**
 * part.search 入力スキーマ
 * part.search input schema
 *
 * ビジュアル類似度・テキスト検索・ハイブリッド検索を提供。
 * queryまたはimageUrlのいずれかが必須。
 *
 * Provides visual similarity, text search, and hybrid search.
 * Either query or imageUrl is required.
 */
export const partSearchInputSchema = z
  .object({
    /** テキスト検索クエリ / Text search query */
    query: z.string().min(1).max(500).optional(),
    /** 画像URLによるビジュアル検索 / Visual search by image URL */
    image_url: z.string().url().optional(),
    /** パーツタイプフィルタ / Part type filter */
    part_type: partTypeSchema.optional(),
    /** WebページIDフィルタ / Web page ID filter */
    web_page_id: z.string().uuid().optional(),
    /** 返却件数 / Result limit */
    limit: z.number().int().min(1).max(100).default(20),
    /** オフセット / Offset */
    offset: z.number().int().min(0).default(0),
    /** 検索モード / Search mode */
    search_mode: z.enum(["visual", "text", "hybrid"]).default("hybrid"),
    /** 最小類似度閾値 / Minimum similarity threshold */
    min_similarity: z.number().min(0).max(1).default(0.3),
  })
  .refine((data) => data.query !== undefined || data.image_url !== undefined, {
    message: "Either query or image_url must be provided",
  });

/**
 * part.inspect 入力スキーマ
 * part.inspect input schema
 *
 * 個別パーツの詳細情報を取得。
 * Retrieves detailed information for an individual part.
 */
export const partInspectInputSchema = z.object({
  /** パーツID / Part ID */
  part_id: z.string().uuid(),
  /** HTMLスニペットを含める / Include HTML snippet */
  include_html: z.boolean().default(false),
  /** Embeddingベクトルを含める / Include embedding vectors */
  include_embedding: z.boolean().default(false),
});

/**
 * part.compare 入力スキーマ
 * part.compare input schema
 *
 * 2-5個のUIコンポーネントパーツをスタイル・レイアウト・インタラクション・
 * アクセシビリティの観点で並列比較する。
 *
 * Compare 2-5 UI component parts side by side on styles, layout,
 * interaction, and accessibility aspects.
 */
export const partCompareInputSchema = z.object({
  /** 比較対象パーツID（2-5個） / Part IDs to compare (2-5) */
  part_ids: z.array(z.string().uuid()).min(2).max(5),
  /** 比較観点 / Comparison aspects */
  compare_aspects: z
    .array(z.enum(["styles", "layout", "interaction", "accessibility"]))
    .default(["styles", "layout"]),
});

// ============================================================================
// Inferred Types / 推論型
// ============================================================================

/** part.search 入力型 / part.search input type */
export type PartSearchInput = z.infer<typeof partSearchInputSchema>;

/** part.inspect 入力型 / part.inspect input type */
export type PartInspectInput = z.infer<typeof partInspectInputSchema>;

/** part.compare 入力型 / part.compare input type */
export type PartCompareInput = z.infer<typeof partCompareInputSchema>;

/** パーツ抽出設定型（Zodから推論） / Part extraction config type (inferred from Zod) */
export type PartExtractionConfigInput = z.infer<typeof partExtractionConfigSchema>;
