// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * responsive.capture MCPツール Zodスキーマ定義
 * 3ビューポート同時キャプチャ + レスポンシブ差分分析用バリデーション
 *
 * @module tools/responsive/capture.schemas
 */

import { z } from "zod";

// ============================================================================
// Error Codes / エラーコード
// ============================================================================

export const RESPONSIVE_CAPTURE_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  CAPTURE_FAILED: "CAPTURE_FAILED",
  SSRF_BLOCKED: "SSRF_BLOCKED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  MEMORY_PRESSURE: "MEMORY_PRESSURE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ResponsiveCaptureErrorCode =
  (typeof RESPONSIVE_CAPTURE_ERROR_CODES)[keyof typeof RESPONSIVE_CAPTURE_ERROR_CODES];

// ============================================================================
// Viewport Schema
// ============================================================================

export const viewportDefSchema = z.object({
  name: z.string().min(1).max(50),
  width: z.number().int().min(1).max(4096),
  height: z.number().int().min(1).max(4096),
});

export type ViewportDef = z.infer<typeof viewportDefSchema>;

// ============================================================================
// Input Schema
// ============================================================================

export const responsiveCaptureInputSchema = z.object({
  /** キャプチャ対象URL（SSRF検証済み） */
  url: z.string().url().min(1).max(2083),

  /** カスタムビューポート配列（任意、最大4つ） */
  viewports: z.array(viewportDefSchema).min(1).max(4).optional(),

  /** スクリーンショットを結果に含めるか（デフォルト: false） */
  include_screenshots: z.boolean().default(false),

  /** レスポンシブ差分分析を含めるか（デフォルト: true） */
  include_diff: z.boolean().default(true),
});

export type ResponsiveCaptureInput = z.infer<typeof responsiveCaptureInputSchema>;
