// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Tool Schemas Export
 * ツール入力スキーマのエクスポート
 *
 * WebDesign専用スキーマ
 */

// 共通スキーマ
export {
  // ユーティリティ
  getSummaryDefault,
  // 座標・サイズ
  point2dSchema,
  sizeSchema as sharedSizeSchema,
  boundingBoxSchema,
  type Point2D,
  type Size as SharedSize,
  type BoundingBox,
  // カラー
  hexColorSchema,
  cssColorSchema,
  type HexColor,
  type CssColor,
  // メタデータ
  processingMetaSchema,
  type ProcessingMeta,
} from "./shared";

// style系スキーマ（style.get_palette用）
export {
  styleGetPaletteInputSchema,
  paletteModeSchema,
  type StyleGetPaletteInput,
} from "./style-schemas";

// [REMOVED v0.3.0] project系スキーマ・ソースファイルは削除済み（バックエンドAPI未実装のため）
// project schemas and source files deleted in v0.3.0 (backend API not implemented)
