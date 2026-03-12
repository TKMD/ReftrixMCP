// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * part.compare MCPツール テスト
 *
 * 目的:
 * - part.compare ハンドラーの入力バリデーション（Zod schema）
 * - 正常系: 2パーツ比較 → styles比較結果
 * - 正常系: 5パーツ比較 → 全観点
 * - 異常系: 2未満パーツ → Zodバリデーションエラー
 * - 異常系: 5超過パーツ → Zodバリデーションエラー
 * - 異常系: パーツ未検出 → エラーメッセージ
 * - styles比較: 同一値 → isIdentical=true
 * - styles比較: 異なる値 → isIdentical=false
 * - sanitizeErrorMessage: DB詳細が漏洩しないこと
 * - ツール定義（MCP Protocol準拠）
 *
 * @module tests/tools/part/part-compare.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Prisma をモック / Mock Prisma
vi.mock('@reftrix/database', () => ({
  prisma: {
    componentPart: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from '@reftrix/database';
import {
  partCompareHandler,
  partCompareToolDefinition,
  PART_COMPARE_ERROR_CODES,
  type PartCompareOutput,
} from '../../../src/tools/part/compare.tool';

// =====================================================
// テストデータ / Test data
// =====================================================

const UUID_A = '01234567-89ab-cdef-0123-456789abcde0';
const UUID_B = '01234567-89ab-cdef-0123-456789abcde1';
const UUID_C = '01234567-89ab-cdef-0123-456789abcde2';
const UUID_D = '01234567-89ab-cdef-0123-456789abcde3';
const UUID_E = '01234567-89ab-cdef-0123-456789abcde4';
const UUID_MISSING = '01234567-89ab-cdef-0123-456789abcde9';

/**
 * モックパーツデータを生成
 * Generate mock part data
 */
function createMockPart(
  id: string,
  overrides?: Partial<{
    partType: string;
    computedStyles: Record<string, unknown>;
    boundingBox: Record<string, unknown>;
    interactionInfo: Record<string, unknown>;
    attributes: Record<string, unknown>;
    webPageUrl: string;
    sectionType: string;
  }>
): Record<string, unknown> {
  return {
    id,
    partType: overrides?.partType ?? 'button',
    partSubtype: 'primary_button',
    htmlSnippet: '<button>Submit</button>',
    computedStyles: overrides?.computedStyles ?? {
      backgroundColor: '#2563eb',
      color: '#ffffff',
      fontSize: '16px',
      borderRadius: '8px',
      padding: '12px 24px',
    },
    boundingBox: overrides?.boundingBox ?? {
      x: 50,
      y: 100,
      width: 200,
      height: 48,
    },
    cssClasses: ['btn-primary'],
    attributes: overrides?.attributes ?? {
      type: 'submit',
      role: 'button',
    },
    interactionInfo: overrides?.interactionInfo ?? {
      hasHover: true,
      hasFocus: true,
      hasActive: true,
      hasTransition: true,
      transitionDuration: '0.2s',
    },
    visualSignature: 'sha256-abc123',
    sampleIndex: 0,
    piiRiskLevel: 'none',
    tags: ['button', 'cta'],
    metadata: {},
    sourceUrl: 'https://example.com',
    usageScope: 'inspiration_only',
    webPage: { url: overrides?.webPageUrl ?? 'https://example.com' },
    sectionPattern: { sectionType: overrides?.sectionType ?? 'hero' },
  };
}

// =====================================================
// テスト / Tests
// =====================================================

describe('part.compare MCPツール', () => {
  const mockFindMany = vi.mocked(prisma.componentPart.findMany);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =====================================================
  // ツール定義テスト / Tool definition tests
  // =====================================================

  describe('ツール定義 / Tool definition', () => {
    it('正しいツール名を持つこと', () => {
      expect(partCompareToolDefinition.name).toBe('part.compare');
    });

    it('説明文が存在すること', () => {
      expect(partCompareToolDefinition.description).toBeTruthy();
      expect(partCompareToolDefinition.description.length).toBeGreaterThan(10);
    });

    it('MCP annotationsが存在すること', () => {
      expect(partCompareToolDefinition.annotations).toBeDefined();
      expect(partCompareToolDefinition.annotations.readOnlyHint).toBe(true);
      expect(partCompareToolDefinition.annotations.idempotentHint).toBe(true);
    });

    it('inputSchemaが正しいフォーマットであること', () => {
      expect(partCompareToolDefinition.inputSchema.type).toBe('object');
      expect(partCompareToolDefinition.inputSchema.properties.part_ids).toBeDefined();
      expect(partCompareToolDefinition.inputSchema.properties.compare_aspects).toBeDefined();
      expect(partCompareToolDefinition.inputSchema.required).toContain('part_ids');
    });
  });

  // =====================================================
  // 入力バリデーションテスト / Input validation tests
  // =====================================================

  describe('入力バリデーション / Input validation', () => {
    it('2未満パーツでバリデーションエラーになること', async () => {
      const result = await partCompareHandler({
        part_ids: [UUID_A],
      }) as PartCompareOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_COMPARE_ERROR_CODES.VALIDATION_ERROR);
        expect(result.error.message).toContain('Validation error');
      }
    });

    it('5超過パーツでバリデーションエラーになること', async () => {
      const result = await partCompareHandler({
        part_ids: [UUID_A, UUID_B, UUID_C, UUID_D, UUID_E, UUID_MISSING],
      }) as PartCompareOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_COMPARE_ERROR_CODES.VALIDATION_ERROR);
        expect(result.error.message).toContain('Validation error');
      }
    });

    it('不正なUUID形式でバリデーションエラーになること', async () => {
      const result = await partCompareHandler({
        part_ids: ['not-a-uuid', UUID_B],
      }) as PartCompareOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_COMPARE_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('part_ids未指定でバリデーションエラーになること', async () => {
      const result = await partCompareHandler({}) as PartCompareOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_COMPARE_ERROR_CODES.VALIDATION_ERROR);
      }
    });
  });

  // =====================================================
  // 正常系テスト / Success cases
  // =====================================================

  describe('正常系 / Success cases', () => {
    it('2パーツ比較でstyles比較結果を返すこと', async () => {
      const partA = createMockPart(UUID_A, {
        computedStyles: { backgroundColor: '#2563eb', color: '#ffffff', fontSize: '16px' },
      });
      const partB = createMockPart(UUID_B, {
        computedStyles: { backgroundColor: '#dc2626', color: '#ffffff', fontSize: '14px' },
      });

      mockFindMany.mockResolvedValueOnce([partA, partB] as never);

      const result = await partCompareHandler({
        part_ids: [UUID_A, UUID_B],
      }) as PartCompareOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parts).toHaveLength(2);
        expect(result.data.comparisons.styles).toBeDefined();
        expect(result.data.comparisons.layout).toBeDefined();

        // styles比較のプロパティを確認
        const stylesComp = result.data.comparisons.styles;
        expect(stylesComp.aspect).toBe('styles');
        expect(stylesComp.properties.length).toBeGreaterThan(0);
      }
    });

    it('5パーツ比較で全観点の結果を返すこと', async () => {
      const parts = [UUID_A, UUID_B, UUID_C, UUID_D, UUID_E].map((id) =>
        createMockPart(id)
      );

      mockFindMany.mockResolvedValueOnce(parts as never);

      const result = await partCompareHandler({
        part_ids: [UUID_A, UUID_B, UUID_C, UUID_D, UUID_E],
        compare_aspects: ['styles', 'layout', 'interaction', 'accessibility'],
      }) as PartCompareOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parts).toHaveLength(5);
        expect(result.data.comparisons.styles).toBeDefined();
        expect(result.data.comparisons.layout).toBeDefined();
        expect(result.data.comparisons.interaction).toBeDefined();
        expect(result.data.comparisons.accessibility).toBeDefined();
      }
    });

    it('デフォルトcompare_aspectsがstyles,layoutであること', async () => {
      const parts = [UUID_A, UUID_B].map((id) => createMockPart(id));
      mockFindMany.mockResolvedValueOnce(parts as never);

      const result = await partCompareHandler({
        part_ids: [UUID_A, UUID_B],
      }) as PartCompareOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(Object.keys(result.data.comparisons)).toEqual(['styles', 'layout']);
      }
    });

    it('パーツ情報にwebPageUrlとsectionTypeが含まれること', async () => {
      const partA = createMockPart(UUID_A, {
        webPageUrl: 'https://example.com/page-a',
        sectionType: 'hero',
      });
      const partB = createMockPart(UUID_B, {
        webPageUrl: 'https://example.com/page-b',
        sectionType: 'footer',
      });

      mockFindMany.mockResolvedValueOnce([partA, partB] as never);

      const result = await partCompareHandler({
        part_ids: [UUID_A, UUID_B],
      }) as PartCompareOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parts[0]?.webPageUrl).toBe('https://example.com/page-a');
        expect(result.data.parts[0]?.sectionType).toBe('hero');
        expect(result.data.parts[1]?.webPageUrl).toBe('https://example.com/page-b');
        expect(result.data.parts[1]?.sectionType).toBe('footer');
      }
    });
  });

  // =====================================================
  // スタイル比較テスト / Style comparison tests
  // =====================================================

  describe('styles比較 / Styles comparison', () => {
    it('同一値でisIdentical=trueを返すこと', async () => {
      const sameStyles = { backgroundColor: '#2563eb', color: '#ffffff', fontSize: '16px' };
      const partA = createMockPart(UUID_A, { computedStyles: sameStyles });
      const partB = createMockPart(UUID_B, { computedStyles: sameStyles });

      mockFindMany.mockResolvedValueOnce([partA, partB] as never);

      const result = await partCompareHandler({
        part_ids: [UUID_A, UUID_B],
        compare_aspects: ['styles'],
      }) as PartCompareOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        const bgProp = result.data.comparisons.styles.properties.find(
          (p) => p.property === 'backgroundColor'
        );
        expect(bgProp).toBeDefined();
        expect(bgProp?.isIdentical).toBe(true);
      }
    });

    it('異なる値でisIdentical=falseを返すこと', async () => {
      const partA = createMockPart(UUID_A, {
        computedStyles: { backgroundColor: '#2563eb' },
      });
      const partB = createMockPart(UUID_B, {
        computedStyles: { backgroundColor: '#dc2626' },
      });

      mockFindMany.mockResolvedValueOnce([partA, partB] as never);

      const result = await partCompareHandler({
        part_ids: [UUID_A, UUID_B],
        compare_aspects: ['styles'],
      }) as PartCompareOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        const bgProp = result.data.comparisons.styles.properties.find(
          (p) => p.property === 'backgroundColor'
        );
        expect(bgProp).toBeDefined();
        expect(bgProp?.isIdentical).toBe(false);
        expect(bgProp?.values).toHaveLength(2);
        expect(bgProp?.values[0]?.value).toBe('#2563eb');
        expect(bgProp?.values[1]?.value).toBe('#dc2626');
      }
    });
  });

  // =====================================================
  // レイアウト比較テスト / Layout comparison tests
  // =====================================================

  describe('layout比較 / Layout comparison', () => {
    it('アスペクト比が計算されること', async () => {
      const partA = createMockPart(UUID_A, {
        boundingBox: { x: 0, y: 0, width: 200, height: 100 },
      });
      const partB = createMockPart(UUID_B, {
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      });

      mockFindMany.mockResolvedValueOnce([partA, partB] as never);

      const result = await partCompareHandler({
        part_ids: [UUID_A, UUID_B],
        compare_aspects: ['layout'],
      }) as PartCompareOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        const aspectRatio = result.data.comparisons.layout.properties.find(
          (p) => p.property === 'aspectRatio'
        );
        expect(aspectRatio).toBeDefined();
        expect(aspectRatio?.values[0]?.value).toBe(2);
        expect(aspectRatio?.values[1]?.value).toBe(1);
        expect(aspectRatio?.isIdentical).toBe(false);
      }
    });
  });

  // =====================================================
  // エラーケーステスト / Error cases
  // =====================================================

  describe('エラーケース / Error cases', () => {
    it('パーツが見つからない場合エラーを返すこと', async () => {
      mockFindMany.mockResolvedValueOnce([createMockPart(UUID_A)] as never);

      const result = await partCompareHandler({
        part_ids: [UUID_A, UUID_MISSING],
      }) as PartCompareOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_COMPARE_ERROR_CODES.PARTS_NOT_FOUND);
        expect(result.error.message).toContain('not found');
      }
    });

    it('DB例外時にsanitizeErrorMessageで内部詳細が漏洩しないこと', async () => {
      const prismaError = new Error('Column "internal_column" not found in table "component_parts"');
      (prismaError as unknown as { code: string }).code = 'P2010';
      mockFindMany.mockRejectedValueOnce(prismaError);

      const result = await partCompareHandler({
        part_ids: [UUID_A, UUID_B],
      }) as PartCompareOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_COMPARE_ERROR_CODES.INTERNAL_ERROR);
        // 内部構造の漏洩がないこと / No internal structure leakage
        expect(result.error.message).not.toContain('internal_column');
        expect(result.error.message).not.toContain('component_parts');
        expect(result.error.message).toBe('Database operation failed');
      }
    });

    it('一般的な例外時にサニタイズされたメッセージを返すこと', async () => {
      mockFindMany.mockRejectedValueOnce(new Error('Unexpected server error'));

      const result = await partCompareHandler({
        part_ids: [UUID_A, UUID_B],
      }) as PartCompareOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_COMPARE_ERROR_CODES.INTERNAL_ERROR);
        expect(result.error.message).toBe('An internal error occurred');
      }
    });
  });
});
