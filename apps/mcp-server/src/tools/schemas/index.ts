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
} from './shared';

// style系スキーマ（style.get_palette用）
export {
  styleGetPaletteInputSchema,
  paletteModeSchema,
  type StyleGetPaletteInput,
} from './style-schemas';

// project系スキーマ（project.get, project.list用）
export {
  // project.get スキーマ
  projectGetInputSchema,
  projectGetOutputSchema,
  projectGetSummaryOutputSchema,
  brandSettingInfoSchema,
  type ProjectGetInput,
  type ProjectGetOutput,
  type ProjectGetSummaryOutput,
  type BrandSettingInfo,
  // project.list スキーマ
  projectListInputSchema,
  projectListOutputSchema,
  projectListSummaryOutputSchema,
  projectListItemSchema,
  projectListItemSummarySchema,
  projectStatusSchema,
  projectSortBySchema,
  projectSortOrderSchema,
  type ProjectListInput,
  type ProjectListOutput,
  type ProjectListSummaryOutput,
  type ProjectListItem,
  type ProjectListItemSummary,
  type ProjectStatus,
  type ProjectSortBy,
  type ProjectSortOrder,
} from './project-schemas';
