// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Palette Service Export Layer
 * styleGetPaletteHandlerを外部モジュールから直接使用可能にするエクスポート層
 *
 * @module @reftrix/mcp-server/services/palette-service-export
 */

import { styleGetPaletteHandler } from '../tools/style-get-palette';
import type { StyleGetPaletteInput } from '../tools/schemas/style-schemas';

/**
 * ブランドパレット取得のレスポンス型
 */
export interface GetPaletteResponse {
  success: boolean;
  data?: {
    palette?: unknown;
    palettes?: unknown[];
  };
  error?: {
    code: string;
    message: string;
    suggestion?: string;
  };
}

/**
 * ブランドパレットを取得
 *
 * @param input - 取得パラメータ
 * @returns 取得結果（success/error構造）
 */
export async function executeGetPalette(input: StyleGetPaletteInput): Promise<GetPaletteResponse> {
  return await styleGetPaletteHandler(input);
}

// 型エクスポート
export type {
  StyleGetPaletteInput as GetPaletteInput,
} from '../tools/schemas/style-schemas';

export type {
  GetPaletteResult,
  GetPaletteOptions,
  PaletteDetail,
  PaletteListItem,
  ColorTokenApi,
  GradientApi,
} from '../services/style/palette-service';
