// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze MCPツールの共通スキーマ定義
 * Error Codes, Enum Schemas, Utility Functions
 *
 * @module @reftrix/mcp-server/tools/page/shared.schemas
 */
import { z } from "zod";

// ============================================================================
// Error Codes
// ============================================================================

/** page.analyze エラーコード */
export const PAGE_ANALYZE_ERROR_CODES = {
  // バリデーションエラー
  VALIDATION_ERROR: "VALIDATION_ERROR",

  // SSRF対策
  SSRF_BLOCKED: "SSRF_BLOCKED",

  // robots.txt (RFC 9309) ブロック
  ROBOTS_TXT_BLOCKED: "ROBOTS_TXT_BLOCKED",

  // ネットワーク/ページ取得
  NETWORK_ERROR: "NETWORK_ERROR",
  TIMEOUT_ERROR: "TIMEOUT_ERROR",
  HTTP_ERROR: "HTTP_ERROR",

  // ブラウザ関連
  BROWSER_ERROR: "BROWSER_ERROR",
  BROWSER_UNAVAILABLE: "BROWSER_UNAVAILABLE",

  // 分析関連
  LAYOUT_ANALYSIS_FAILED: "LAYOUT_ANALYSIS_FAILED",
  MOTION_DETECTION_FAILED: "MOTION_DETECTION_FAILED",
  QUALITY_EVALUATION_FAILED: "QUALITY_EVALUATION_FAILED",

  // DB関連
  DB_SAVE_FAILED: "DB_SAVE_FAILED",
  DB_NOT_CONFIGURED: "DB_NOT_CONFIGURED",

  // 内部エラー
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type PageAnalyzeErrorCode =
  (typeof PAGE_ANALYZE_ERROR_CODES)[keyof typeof PAGE_ANALYZE_ERROR_CODES];

// ============================================================================
// Enum Schemas
// ============================================================================

export const sourceTypeSchema = z.enum(["award_gallery", "user_provided"]);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const usageScopeSchema = z.enum(["inspiration_only", "owned_asset"]);
export type UsageScope = z.infer<typeof usageScopeSchema>;

export const waitUntilSchema = z.enum(["load", "domcontentloaded", "networkidle"]);
export type WaitUntil = z.infer<typeof waitUntilSchema>;

export const gradeSchema = z.enum(["A", "B", "C", "D", "F"]);
export type Grade = z.infer<typeof gradeSchema>;

// ============================================================================
// Constants
// ============================================================================

/** 最大ページ高さ制限（px）- フレームキャプチャ用 */
export const PAGE_ANALYZE_MAX_PAGE_HEIGHT = 50000;

// ============================================================================
// Utility Functions
// ============================================================================

/** スコアをグレードに変換（A: 90+, B: 80+, C: 70+, D: 60+, F: <60） */
export function scoreToGrade(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}
