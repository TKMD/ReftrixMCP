// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * part.compare MCPツール
 * 2-5個のUIコンポーネントパーツを並列比較します
 *
 * 比較観点:
 * - styles: computedStyles（backgroundColor, color, fontSize, borderRadius, padding等）
 * - layout: boundingBox（width, height, アスペクト比）
 * - interaction: interactionInfo（hasHover, hasTransition等）
 * - accessibility: attributes（aria-label, role, alt text有無）
 *
 * part.compare MCP tool
 * Compare 2-5 UI component parts side by side
 *
 * Comparison aspects:
 * - styles: computedStyles (backgroundColor, color, fontSize, borderRadius, padding, etc.)
 * - layout: boundingBox (width, height, aspect ratio)
 * - interaction: interactionInfo (hasHover, hasTransition, etc.)
 * - accessibility: attributes (aria-label, role, alt text presence)
 *
 * @module tools/part/compare.tool
 */

import { ZodError } from 'zod';
import { prisma } from '@reftrix/database';
import { logger, isDevelopment } from '../../utils/logger';
import { partCompareInputSchema, truncateId, type PartCompareInput } from '../../services/part/schemas';

// =====================================================
// 型定義 / Type Definitions
// =====================================================

/**
 * 比較対象パーツ情報
 * Part info for comparison
 */
interface ComparedPartInfo {
  id: string;
  partType: string;
  webPageUrl: string;
  sectionType: string;
}

/**
 * 比較プロパティ
 * Comparison property
 */
interface ComparisonProperty {
  property: string;
  values: Array<{ partId: string; value: unknown }>;
  isIdentical: boolean;
}

/**
 * 比較観点の詳細
 * Comparison detail per aspect
 */
interface ComparisonDetail {
  aspect: string;
  properties: ComparisonProperty[];
}

/**
 * part.compare 結果
 * part.compare result
 */
interface PartCompareResult {
  parts: ComparedPartInfo[];
  comparisons: Record<string, ComparisonDetail>;
}

/**
 * part.compare 出力型
 * part.compare output type
 */
export type PartCompareOutput =
  | {
      success: true;
      data: PartCompareResult;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

// =====================================================
// エラーコード / Error Codes
// =====================================================

export const PART_COMPARE_ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PARTS_NOT_FOUND: 'PARTS_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

// =====================================================
// エラーハンドリング / Error Handling
// =====================================================

/**
 * エラーメッセージをサニタイズ（内部構造の漏洩防止）
 * Sanitize error message (prevent internal structure leakage)
 */
function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const prismaError = error as { code?: string };
    if (prismaError.code) {
      switch (prismaError.code) {
        case 'P2002': return 'A record with this value already exists';
        case 'P2025': return 'Record not found';
        default: return 'Database operation failed';
      }
    }
  }
  return 'An internal error occurred';
}

// =====================================================
// 比較ロジック / Comparison Logic
// =====================================================

/**
 * スタイル比較用のキープロパティ
 * Key properties for style comparison
 */
const STYLE_COMPARISON_KEYS = [
  'backgroundColor', 'color', 'fontSize', 'fontFamily', 'fontWeight',
  'borderRadius', 'padding', 'margin', 'border', 'boxShadow',
  'lineHeight', 'letterSpacing', 'textAlign', 'display', 'position',
];

/**
 * レイアウト比較用のキープロパティ
 * Key properties for layout comparison
 */
const LAYOUT_COMPARISON_KEYS = ['width', 'height', 'x', 'y'];

/**
 * インタラクション比較用のキープロパティ
 * Key properties for interaction comparison
 */
const INTERACTION_COMPARISON_KEYS = [
  'hasHover', 'hasFocus', 'hasActive', 'hasTransition', 'transitionDuration',
];

/**
 * アクセシビリティ比較用のキー属性
 * Key attributes for accessibility comparison
 */
const ACCESSIBILITY_ATTRIBUTE_KEYS = ['aria-label', 'role', 'alt', 'aria-describedby', 'tabindex', 'title'];

/**
 * 値が同一かどうか判定
 * Check if all values are identical
 */
function areValuesIdentical(values: unknown[]): boolean {
  if (values.length <= 1) return true;
  const first = JSON.stringify(values[0]);
  return values.every((v) => JSON.stringify(v) === first);
}

/**
 * スタイルの比較を構築
 * Build styles comparison
 */
function buildStylesComparison(
  parts: Array<{ id: string; computedStyles: Record<string, unknown> }>
): ComparisonDetail {
  const properties: ComparisonProperty[] = [];

  for (const key of STYLE_COMPARISON_KEYS) {
    const values = parts.map((p) => ({
      partId: p.id,
      value: (p.computedStyles as Record<string, unknown>)[key] ?? null,
    }));

    properties.push({
      property: key,
      values,
      isIdentical: areValuesIdentical(values.map((v) => v.value)),
    });
  }

  return { aspect: 'styles', properties };
}

/**
 * レイアウトの比較を構築
 * Build layout comparison
 */
function buildLayoutComparison(
  parts: Array<{ id: string; boundingBox: Record<string, unknown> }>
): ComparisonDetail {
  const properties: ComparisonProperty[] = [];

  for (const key of LAYOUT_COMPARISON_KEYS) {
    const values = parts.map((p) => ({
      partId: p.id,
      value: (p.boundingBox as Record<string, unknown>)[key] ?? null,
    }));

    properties.push({
      property: key,
      values,
      isIdentical: areValuesIdentical(values.map((v) => v.value)),
    });
  }

  // アスペクト比を追加 / Add aspect ratio
  const aspectRatioValues = parts.map((p) => {
    const bb = p.boundingBox as Record<string, number>;
    const width = bb.width ?? 0;
    const height = bb.height ?? 0;
    const ratio = height > 0 ? Math.round((width / height) * 100) / 100 : 0;
    return { partId: p.id, value: ratio };
  });

  properties.push({
    property: 'aspectRatio',
    values: aspectRatioValues,
    isIdentical: areValuesIdentical(aspectRatioValues.map((v) => v.value)),
  });

  return { aspect: 'layout', properties };
}

/**
 * インタラクションの比較を構築
 * Build interaction comparison
 */
function buildInteractionComparison(
  parts: Array<{ id: string; interactionInfo: Record<string, unknown> }>
): ComparisonDetail {
  const properties: ComparisonProperty[] = [];

  for (const key of INTERACTION_COMPARISON_KEYS) {
    const values = parts.map((p) => ({
      partId: p.id,
      value: (p.interactionInfo as Record<string, unknown>)[key] ?? null,
    }));

    properties.push({
      property: key,
      values,
      isIdentical: areValuesIdentical(values.map((v) => v.value)),
    });
  }

  return { aspect: 'interaction', properties };
}

/**
 * アクセシビリティの比較を構築
 * Build accessibility comparison
 */
function buildAccessibilityComparison(
  parts: Array<{ id: string; attributes: Record<string, unknown> }>
): ComparisonDetail {
  const properties: ComparisonProperty[] = [];

  for (const key of ACCESSIBILITY_ATTRIBUTE_KEYS) {
    const values = parts.map((p) => {
      const attrs = p.attributes as Record<string, unknown>;
      return {
        partId: p.id,
        value: attrs[key] ?? null,
      };
    });

    properties.push({
      property: key,
      values,
      isIdentical: areValuesIdentical(values.map((v) => v.value)),
    });
  }

  // alt text の有無を比較 / Compare alt text presence
  const altPresence = parts.map((p) => {
    const attrs = p.attributes as Record<string, string>;
    return {
      partId: p.id,
      value: attrs['alt'] !== undefined && attrs['alt'] !== null,
    };
  });

  properties.push({
    property: 'hasAltText',
    values: altPresence,
    isIdentical: areValuesIdentical(altPresence.map((v) => v.value)),
  });

  // aria-label の有無を比較 / Compare aria-label presence
  const ariaLabelPresence = parts.map((p) => {
    const attrs = p.attributes as Record<string, string>;
    return {
      partId: p.id,
      value: attrs['aria-label'] !== undefined && attrs['aria-label'] !== null,
    };
  });

  properties.push({
    property: 'hasAriaLabel',
    values: ariaLabelPresence,
    isIdentical: areValuesIdentical(ariaLabelPresence.map((v) => v.value)),
  });

  return { aspect: 'accessibility', properties };
}

// =====================================================
// メインハンドラー / Main Handler
// =====================================================

/**
 * part.compare ツールハンドラー
 * part.compare tool handler
 *
 * @param input - 入力パラメータ / Input parameters
 * @returns 比較結果 / Comparison results
 */
export async function partCompareHandler(
  input: unknown
): Promise<PartCompareOutput> {
  if (isDevelopment()) {
    logger.info('[MCP Tool] part.compare called', {
      partCount: Array.isArray((input as Record<string, unknown>)?.part_ids)
        ? ((input as Record<string, unknown>).part_ids as unknown[]).length
        : 0,
    });
  }

  // 入力バリデーション / Input validation
  let validated: PartCompareInput;
  try {
    validated = partCompareInputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessage = error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');

      logger.warn('[MCP Tool] part.compare validation error', {
        errors: error.errors,
      });

      return {
        success: false,
        error: {
          code: PART_COMPARE_ERROR_CODES.VALIDATION_ERROR,
          message: `Validation error: ${errorMessage}`,
        },
      };
    }
    throw error;
  }

  try {
    // DB からパーツを取得（リレーション含む）
    // Fetch parts from DB (with relations)
    const dbParts = await prisma.componentPart.findMany({
      where: { id: { in: validated.part_ids } },
      include: {
        webPage: { select: { url: true } },
        sectionPattern: { select: { sectionType: true } },
      },
    });

    // 見つからなかったパーツを検出 / Detect missing parts
    const foundIds = new Set(dbParts.map((p) => p.id));
    const missingIds = validated.part_ids.filter((id) => !foundIds.has(id));

    if (missingIds.length > 0) {
      logger.warn('[MCP Tool] part.compare parts not found', {
        missingCount: missingIds.length,
        missingIds: missingIds.map((id) => truncateId(id)),
      });

      return {
        success: false,
        error: {
          code: PART_COMPARE_ERROR_CODES.PARTS_NOT_FOUND,
          message: `${missingIds.length} part(s) not found`,
        },
      };
    }

    // パーツ情報を構築 / Build part info
    const partsInfo: ComparedPartInfo[] = dbParts.map((p) => ({
      id: p.id,
      partType: p.partType,
      webPageUrl: p.webPage.url,
      sectionType: p.sectionPattern.sectionType,
    }));

    // 比較ロジック用の中間表現
    // Intermediate representation for comparison logic
    const partsForComparison = dbParts.map((p) => ({
      id: p.id,
      computedStyles: (p.computedStyles ?? {}) as Record<string, unknown>,
      boundingBox: (p.boundingBox ?? {}) as Record<string, unknown>,
      interactionInfo: (p.interactionInfo ?? {}) as Record<string, unknown>,
      attributes: (p.attributes ?? {}) as Record<string, unknown>,
    }));

    // 比較観点ごとに結果を構築 / Build comparisons per aspect
    const comparisons: Record<string, ComparisonDetail> = {};

    for (const aspect of validated.compare_aspects) {
      switch (aspect) {
        case 'styles':
          comparisons.styles = buildStylesComparison(partsForComparison);
          break;
        case 'layout':
          comparisons.layout = buildLayoutComparison(partsForComparison);
          break;
        case 'interaction':
          comparisons.interaction = buildInteractionComparison(partsForComparison);
          break;
        case 'accessibility':
          comparisons.accessibility = buildAccessibilityComparison(partsForComparison);
          break;
      }
    }

    if (isDevelopment()) {
      logger.info('[MCP Tool] part.compare completed', {
        partCount: partsInfo.length,
        aspects: validated.compare_aspects,
      });
    }

    return {
      success: true,
      data: {
        parts: partsInfo,
        comparisons,
      },
    };
  } catch (error) {
    const errorInstance = error instanceof Error ? error : new Error(String(error));

    // 全環境でログ出力（isDevelopmentガードなし）
    // Log in all environments (no isDevelopment guard)
    logger.warn('[MCP Tool] part.compare error', {
      code: PART_COMPARE_ERROR_CODES.INTERNAL_ERROR,
      error: errorInstance.message,
    });

    return {
      success: false,
      error: {
        code: PART_COMPARE_ERROR_CODES.INTERNAL_ERROR,
        message: sanitizeErrorMessage(error),
      },
    };
  }
}

// =====================================================
// ツール定義 / Tool Definition
// =====================================================

/**
 * part.compare MCPツール定義
 * part.compare MCP tool definition
 */
export const partCompareToolDefinition = {
  name: 'part.compare' as const,
  description:
    '2-5個のUIコンポーネントパーツをスタイル・レイアウト・インタラクション・' +
    'アクセシビリティの観点で並列比較します。' +
    ' / Compare 2-5 UI component parts side by side on styles, layout, ' +
    'interaction, and accessibility aspects.',
  annotations: {
    title: 'Part Compare',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object' as const,
    properties: {
      part_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 2,
        maxItems: 5,
        description: '比較対象パーツID（2-5個） / 2-5 part IDs to compare',
      },
      compare_aspects: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['styles', 'layout', 'interaction', 'accessibility'],
        },
        default: ['styles', 'layout'],
        description: '比較観点（デフォルト: styles, layout） / Aspects to compare (default: styles, layout)',
      },
    },
    required: ['part_ids'],
  },
};

// =====================================================
// 開発環境ログ / Development Environment Log
// =====================================================

if (isDevelopment()) {
  logger.debug('[part.compare] Tool module loaded');
}
