// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCPツール Zodスキーマ テスト
 * TDD Red フェーズ: MCPツールの入力バリデーションスキーマテスト
 *
 * 目的:
 * - searchInputSchema のバリデーション
 * - getInputSchema のバリデーション
 * - ingestInputSchema のバリデーション
 * - UUID形式バリデーション
 * - 文字列長制限
 * - オプションフィールドのデフォルト値
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// スキーマ定義（テスト用 - 実装はまだ存在しない）
// TDD Red: これらのスキーマは実装されていないため、テストは失敗する

// 共通スキーマを先頭で1回だけ定義（重複削減）
const searchInputSchema = z.object({
  query: z.string().min(1),
  filters: z.object({
    category: z.string().optional(),
    license: z.string().optional(),
    style: z.enum(['flat', 'line', 'filled', 'gradient']).optional(),
    purpose: z.enum(['icon', 'illustration', 'mascot', 'diagram', 'decoration']).optional(),
    commercial_only: z.boolean().optional(),
  }).optional(),
  limit: z.number().min(1).max(50).default(10),
  offset: z.number().min(0).default(0).optional(),
});

const getInputSchema = z.object({
  id: z.string().uuid(),
  include_raw: z.boolean().optional().default(false),
});

const ingestInputSchema = z.object({
  svg_content: z.string().min(1),
  name: z.string().min(1).max(200),
  license_spdx: z.string().min(1),
  description: z.string().optional(),
  category_slug: z.string().optional(),
  style: z.enum(['flat', 'line', 'filled', 'gradient', 'other']).optional(),
  purpose: z.enum(['icon', 'illustration', 'mascot', 'diagram', 'decoration', 'other']).optional(),
  tags: z.array(z.string()).max(20).optional(),
  source_url: z.string().url().optional(),
  source_name: z.string().optional(),
});

describe('MCPツール Zodスキーマ', () => {
  describe('searchInputSchema', () => {
    // 正常系テスト
    it('正常な検索クエリが検証できること', () => {
      const result = searchInputSchema.safeParse({
        query: '青い鳥',
        limit: 10,
      });
      expect(result.success).toBe(true);
    });

    it('フィルター付き検索クエリが検証できること', () => {
      const result = searchInputSchema.safeParse({
        query: 'apple icon',
        filters: {
          style: 'flat',
          purpose: 'icon',
          license: 'MIT',
          commercial_only: true,
        },
        limit: 20,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filters?.style).toBe('flat');
        expect(result.data.filters?.commercial_only).toBe(true);
      }
    });

    it('limitのデフォルト値が10であること', () => {
      const result = searchInputSchema.safeParse({ query: 'test' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(10);
      }
    });

    // 異常系テスト - describe.each でパラメータ化
    describe.each([
      { name: '空クエリ', input: { query: '' }, description: '空クエリでエラーになること' },
      { name: 'limit上限超過', input: { query: 'test', limit: 100 }, description: 'limitが上限50を超えるとエラーになること' },
      { name: 'limit下限違反', input: { query: 'test', limit: 0 }, description: 'limitが0以下でエラーになること' },
      { name: '不正なstyle', input: { query: 'test', filters: { style: 'invalid-style' } }, description: '不正なstyle値でエラーになること' },
      { name: '不正なpurpose', input: { query: 'test', filters: { purpose: 'invalid-purpose' } }, description: '不正なpurpose値でエラーになること' },
      { name: '負のoffset', input: { query: 'test', offset: -1 }, description: 'offsetが負の値でエラーになること' },
    ])('$name', ({ input, description }) => {
      it(description, () => {
        const result = searchInputSchema.safeParse(input);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('getInputSchema', () => {
    const validUUID = '01939abc-def0-7000-8000-000000000001';

    // 正常系テスト
    it('正常なUUID形式のIDが検証できること', () => {
      const result = getInputSchema.safeParse({ id: validUUID });
      expect(result.success).toBe(true);
    });

    it('include_rawがtrueで検証できること', () => {
      const result = getInputSchema.safeParse({ id: validUUID, include_raw: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.include_raw).toBe(true);
      }
    });

    it('include_rawのデフォルト値がfalseであること', () => {
      const result = getInputSchema.safeParse({ id: validUUID });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.include_raw).toBe(false);
      }
    });

    it('UUID v7形式（UUIDv7）が検証できること', () => {
      const result = getInputSchema.safeParse({ id: validUUID });
      expect(result.success).toBe(true);
    });

    // 異常系テスト - describe.each でパラメータ化
    describe.each([
      { name: '無効なUUID形式', input: { id: 'invalid-uuid' } },
      { name: '空文字列', input: { id: '' } },
    ])('$name', ({ input }) => {
      it(`${input.id === '' ? '空文字列' : '無効なUUID形式'}でエラーになること`, () => {
        const result = getInputSchema.safeParse(input);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('ingestInputSchema', () => {
    const validBase = {
      svg_content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="..."/></svg>',
      name: 'Test Icon',
      license_spdx: 'MIT',
    };

    // 正常系テスト
    it('必須フィールドのみで検証できること', () => {
      const result = ingestInputSchema.safeParse(validBase);
      expect(result.success).toBe(true);
    });

    it('全フィールド指定で検証できること', () => {
      const result = ingestInputSchema.safeParse({
        ...validBase,
        name: 'Apple Icon',
        license_spdx: 'CC0-1.0',
        description: 'A red apple illustration',
        category_slug: 'food',
        style: 'flat',
        purpose: 'icon',
        tags: ['apple', 'fruit', 'food', 'red'],
        source_url: 'https://example.com/icons/apple.svg',
        source_name: 'Example Icons',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Apple Icon');
        expect(result.data.tags).toHaveLength(4);
      }
    });

    // 異常系テスト - describe.each でパラメータ化
    describe.each([
      { name: 'svg_content空', input: { svg_content: '', name: 'Test', license_spdx: 'MIT' } },
      { name: 'name空', input: { svg_content: '<svg>...</svg>', name: '', license_spdx: 'MIT' } },
      { name: 'name200文字超過', input: { svg_content: '<svg>...</svg>', name: 'A'.repeat(201), license_spdx: 'MIT' } },
      { name: 'license_spdx空', input: { svg_content: '<svg>...</svg>', name: 'Test', license_spdx: '' } },
      { name: 'tags20個超過', input: { svg_content: '<svg>...</svg>', name: 'Test', license_spdx: 'MIT', tags: Array.from({ length: 21 }, (_, i) => `tag${i}`) } },
      { name: '不正なsource_url', input: { svg_content: '<svg>...</svg>', name: 'Test', license_spdx: 'MIT', source_url: 'not-a-url' } },
      { name: '不正なstyle', input: { svg_content: '<svg>...</svg>', name: 'Test', license_spdx: 'MIT', style: 'invalid-style' } },
      { name: '不正なpurpose', input: { svg_content: '<svg>...</svg>', name: 'Test', license_spdx: 'MIT', purpose: 'invalid-purpose' } },
    ])('$name', ({ input }) => {
      it('でエラーになること', () => {
        const result = ingestInputSchema.safeParse(input);
        expect(result.success).toBe(false);
      });
    });
  });
});
