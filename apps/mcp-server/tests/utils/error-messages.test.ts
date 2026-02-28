// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * エラーメッセージユーティリティ テスト
 * TDD Red フェーズ: Zodエラーを人間が読みやすいメッセージに変換
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z, ZodError } from 'zod';

import type {
  McpToolError} from '../../src/utils/error-messages';
import {
  formatZodError,
  createValidationError,
  ErrorMessages,
  setErrorMessageLocale,
  getErrorMessageLocale,
  formatDetailedValidationError,
  createValidationErrorWithHints,
  formatSingleError,
  formatMultipleErrors,
  ERROR_CODES,
  type DetailedValidationError,
} from '../../src/utils/error-messages';

// =============================================================================
// 共通テストヘルパー（重複削減）
// =============================================================================

// ロケールリセット用afterEach
const resetLocale = () => setErrorMessageLocale('en');

// 共通スキーマ定義（重複削減）
const SCHEMAS = {
  uuid: z.string().uuid(),
  required: z.object({ name: z.string(), query: z.string() }),
  range: z.object({ limit: z.number().min(1).max(50), offset: z.number().min(0).max(1000) }),
  enum: z.object({
    style: z.enum(['flat', 'line', 'filled', 'gradient']),
    purpose: z.enum(['icon', 'illustration', 'mascot']),
  }),
  stringLength: z.object({ name: z.string().min(1).max(200), description: z.string().max(1000).optional() }),
  type: z.object({ count: z.number(), enabled: z.boolean(), tags: z.array(z.string()) }),
  nested: z.object({
    filters: z.object({ category: z.string().optional(), style: z.enum(['flat', 'line']).optional() }).optional(),
    options: z.object({ viewport: z.object({ width: z.number().min(320).max(4096), height: z.number().min(240).max(16384) }).optional() }).optional(),
  }),
  complex: z.object({
    svg_content: z.string().min(1),
    name: z.string().min(1).max(200),
    license_spdx: z.string(),
    style: z.enum(['flat', 'line', 'filled', 'gradient', 'other']).optional(),
    purpose: z.enum(['icon', 'illustration', 'mascot', 'diagram', 'decoration', 'other']).optional(),
    quality_threshold: z.number().min(0).max(100).optional(),
    design_system_id: z.string().uuid().optional(),
  }),
  ingest: z.object({
    svg_content: z.string().min(1),
    name: z.string().min(1).max(200),
    license_spdx: z.string().min(1),
  }),
};

// Zodパース結果検証ヘルパー（重複削減）
const parseAndExpectError = <T>(schema: z.ZodSchema<T>, input: unknown): ZodError => {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error('Expected parse to fail');
  return result.error;
};

// =============================================================================
// テストケース定義
// =============================================================================

describe('Error Messages Utility', () => {
  afterEach(resetLocale);

  describe('McpToolError インターフェース', () => {
    it('McpToolErrorが正しい構造を持つこと', () => {
      const error: McpToolError = { code: 'VALIDATION_ERROR', message: 'Test error message', field: 'testField', details: { value: 'invalid' } };
      expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Test error message', field: 'testField' });
    });

    it('fieldとdetailsはオプショナルであること', () => {
      const error: McpToolError = { code: 'INTERNAL_ERROR', message: 'Internal error occurred' };
      expect(error.field).toBeUndefined();
      expect(error.details).toBeUndefined();
    });
  });

  // UUID形式エラーテスト（パラメータ化・重複削減）
  describe.each([
    { locale: 'en' as const, input: 'invalid-uuid', expectedContains: ['Invalid UUID format', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'] },
    { locale: 'ja' as const, input: 'not-a-uuid', expectedContains: ['UUID形式が無効です'] },
  ])('formatZodError - UUID形式エラー ($locale)', ({ locale, input, expectedContains }) => {
    it(`無効なUUID形式に対して読みやすいエラーメッセージを返すこと`, () => {
      setErrorMessageLocale(locale);
      const error = parseAndExpectError(SCHEMAS.uuid, input);
      const formattedErrors = formatZodError(error);

      expect(formattedErrors).toHaveLength(1);
      expect(formattedErrors[0].code).toBe('INVALID_UUID');
      expectedContains.forEach(expected => expect(formattedErrors[0].message).toContain(expected));
    });
  });

  // 必須フィールドエラーテスト（パラメータ化・重複削減）
  describe.each([
    { locale: 'en' as const, field: 'name', expectedMessage: "Required field 'name' is missing" },
    { locale: 'ja' as const, field: 'query', expectedMessage: "必須フィールド 'query' が指定されていません" },
  ])('formatZodError - 必須フィールド欠落 ($locale, $field)', ({ locale, field, expectedMessage }) => {
    it(`必須フィールド欠落に対して読みやすいエラーメッセージを返すこと`, () => {
      setErrorMessageLocale(locale);
      const error = parseAndExpectError(SCHEMAS.required, {});
      const formattedErrors = formatZodError(error);
      const fieldError = formattedErrors.find(e => e.field === field);

      expect(fieldError).toBeDefined();
      expect(fieldError?.code).toBe('REQUIRED_FIELD');
      expect(fieldError?.message).toBe(expectedMessage);
    });
  });

  // 範囲外エラーテスト（パラメータ化・重複削減）
  describe.each([
    { locale: 'en' as const, input: { limit: 0, offset: 0 }, field: 'limit', expectedContains: 'min: 1', detailKey: 'min', detailValue: 1 },
    { locale: 'ja' as const, input: { limit: 100, offset: 0 }, field: 'limit', expectedContains: '最大: 50', detailKey: 'max', detailValue: 50 },
  ])('formatZodError - 範囲外の値 ($locale)', ({ locale, input, field, expectedContains, detailKey, detailValue }) => {
    it(`範囲外の値に対して読みやすいエラーメッセージを返すこと`, () => {
      setErrorMessageLocale(locale);
      const error = parseAndExpectError(SCHEMAS.range, input);
      const formattedErrors = formatZodError(error);
      const fieldError = formattedErrors.find(e => e.field === field);

      expect(fieldError?.code).toBe('OUT_OF_RANGE');
      expect(fieldError?.message).toContain(expectedContains);
      expect(fieldError?.details?.[detailKey]).toBe(detailValue);
    });
  });

  it('最小値のみのスキーマでも正しく処理すること', () => {
    const error = parseAndExpectError(z.number().min(5), 2);
    const formattedErrors = formatZodError(error);
    expect(formattedErrors[0].code).toBe('OUT_OF_RANGE');
    expect(formattedErrors[0].details?.min).toBe(5);
  });

  // 列挙値エラーテスト（パラメータ化・重複削減）
  describe.each([
    { locale: 'en' as const, input: { style: 'invalid', purpose: 'icon' }, field: 'style', expected: "Invalid value 'invalid'. Expected one of: flat, line, filled, gradient" },
    { locale: 'ja' as const, input: { style: 'flat', purpose: 'wrong' }, field: 'purpose', expected: "値 'wrong' は無効です。次のいずれかを指定してください: icon, illustration, mascot" },
  ])('formatZodError - 不正な列挙値 ($locale)', ({ locale, input, field, expected }) => {
    it(`不正な列挙値に対して読みやすいエラーメッセージを返すこと`, () => {
      setErrorMessageLocale(locale);
      const error = parseAndExpectError(SCHEMAS.enum, input);
      const formattedErrors = formatZodError(error);
      const fieldError = formattedErrors.find(e => e.field === field);

      expect(fieldError?.code).toBe('INVALID_ENUM');
      expect(fieldError?.message).toBe(expected);
    });
  });

  // 文字列長エラーテスト（パラメータ化・重複削減）
  describe.each([
    { locale: 'en' as const, input: { name: '' }, code: 'STRING_TOO_SHORT', expectedContains: 'at least 1 character' },
    { locale: 'ja' as const, input: { name: 'a'.repeat(250) }, code: 'STRING_TOO_LONG', expectedContains: '200文字以下' },
  ])('formatZodError - 文字列長エラー ($locale, $code)', ({ locale, input, code, expectedContains }) => {
    it(`文字列長エラーに対して読みやすいエラーメッセージを返すこと`, () => {
      setErrorMessageLocale(locale);
      const error = parseAndExpectError(SCHEMAS.stringLength, input);
      const formattedErrors = formatZodError(error);
      const nameError = formattedErrors.find(e => e.field === 'name');

      expect(nameError?.code).toBe(code);
      expect(nameError?.message).toContain(expectedContains);
    });
  });

  // 型エラーテスト（パラメータ化・重複削減）
  describe.each([
    { locale: 'en' as const, input: { count: 'not a number', enabled: true, tags: [] }, field: 'count', expectedContains: ['Expected number', 'received string'] },
    { locale: 'ja' as const, input: { count: 5, enabled: true, tags: 'not an array' }, field: 'tags', expectedContains: ['array'] },
  ])('formatZodError - 型エラー ($locale, $field)', ({ locale, input, field, expectedContains }) => {
    it(`型エラーに対して読みやすいエラーメッセージを返すこと`, () => {
      setErrorMessageLocale(locale);
      const error = parseAndExpectError(SCHEMAS.type, input);
      const formattedErrors = formatZodError(error);
      const fieldError = formattedErrors.find(e => e.field === field);

      expect(fieldError?.code).toBe('INVALID_TYPE');
      expectedContains.forEach(expected => expect(fieldError?.message).toContain(expected));
    });
  });

  describe('formatZodError - ネストしたパス', () => {
    it('ネストしたフィールドのパスが正しく表示されること', () => {
      const error = parseAndExpectError(SCHEMAS.nested, { filters: { style: 'invalid' }, options: { viewport: { width: 100, height: 500 } } });
      const formattedErrors = formatZodError(error);

      expect(formattedErrors.find(e => e.field === 'filters.style')).toBeDefined();
      expect(formattedErrors.find(e => e.field === 'options.viewport.width')).toBeDefined();
    });
  });

  describe('createValidationError', () => {
    it('ZodErrorからMcpToolError配列を生成できること', () => {
      const error = parseAndExpectError(z.object({ query: z.string(), limit: z.number().min(1).max(50) }), { limit: 0 });
      const mcpErrors = createValidationError(error);

      expect(mcpErrors).toBeInstanceOf(Array);
      expect(mcpErrors.length).toBeGreaterThanOrEqual(1);
      expect(mcpErrors[0]).toHaveProperty('code');
      expect(mcpErrors[0]).toHaveProperty('message');
    });
  });

  describe('ロケール切り替え', () => {
    it('getErrorMessageLocaleがデフォルトで英語を返すこと', () => {
      setErrorMessageLocale('en');
      expect(getErrorMessageLocale()).toBe('en');
    });

    it('setErrorMessageLocaleでロケールを変更できること', () => {
      setErrorMessageLocale('ja');
      expect(getErrorMessageLocale()).toBe('ja');
    });
  });

  // ErrorMessages定数テスト（パラメータ化・重複削減）
  describe.each(['en', 'ja'] as const)('ErrorMessages 定数 (%s)', (locale) => {
    it('メッセージテンプレートが存在すること', () => {
      expect(ErrorMessages[locale]).toBeDefined();
      ['INVALID_UUID', 'REQUIRED_FIELD', 'OUT_OF_RANGE', 'INVALID_ENUM'].forEach(key => {
        expect(ErrorMessages[locale][key]).toBeDefined();
      });
    });
  });

  describe('複合エラーケース', () => {
    it('複数のエラーを同時に処理できること', () => {
      const error = parseAndExpectError(SCHEMAS.complex, {
        svg_content: '', name: '', license_spdx: 'MIT', style: 'wrong', quality_threshold: 150, design_system_id: 'not-uuid',
      });
      const formattedErrors = formatZodError(error);
      const errorCodes = formattedErrors.map(e => e.code);

      expect(formattedErrors.length).toBeGreaterThanOrEqual(4);
      expect(errorCodes).toContain('STRING_TOO_SHORT');
      expect(errorCodes).toContain('INVALID_ENUM');
      expect(errorCodes).toContain('OUT_OF_RANGE');
      expect(errorCodes).toContain('INVALID_UUID');
    });
  });

  describe('後方互換性', () => {
    it('formatZodErrorはZodErrorインスタンスのみを受け付けること', () => {
      // @ts-expect-error - 意図的に不正な型を渡す
      expect(() => formatZodError(null)).toThrow();
      // @ts-expect-error - 意図的に不正な型を渡す
      expect(() => formatZodError(undefined)).toThrow();
      // @ts-expect-error - 意図的に不正な型を渡す
      expect(() => formatZodError('not an error')).toThrow();
    });

    it('空のZodErrorを処理できること', () => {
      const emptyError = new ZodError([]);
      expect(formatZodError(emptyError)).toEqual([]);
    });
  });
});

// =============================================================================
// 拡張機能テスト（Phase: バリデーションエラーメッセージ改善）
// =============================================================================

describe('Enhanced Error Messages - formatDetailedValidationError', () => {
  afterEach(resetLocale);

  // 詳細エラーテスト（パラメータ化・重複削減）
  describe.each([
    { name: '必須フィールド', schema: SCHEMAS.ingest, input: { name: 'test', license_spdx: 'MIT' }, field: 'svg_content', code: ERROR_CODES.REQUIRED_FIELD, received: 'undefined' },
    { name: '型エラー', schema: z.object({ limit: z.number() }), input: { limit: 'not-a-number' }, field: 'limit', code: ERROR_CODES.INVALID_TYPE, expected: 'number', received: 'string' },
    { name: '範囲エラー', schema: z.object({ quality_threshold: z.number().min(0).max(100) }), input: { quality_threshold: 150 }, field: 'quality_threshold', code: ERROR_CODES.OUT_OF_RANGE, expectedContains: '100' },
  ])('$name', ({ schema, input, field, code, received, expected, expectedContains }) => {
    it('正しいエラー情報を含む', () => {
      const error = parseAndExpectError(schema, input);
      const detailed = formatDetailedValidationError(error);

      expect(detailed.errors[0]).toMatchObject({ field, code });
      if (received) expect(detailed.errors[0].received).toBe(received);
      if (expected) expect(detailed.errors[0].expected).toBe(expected);
      if (expectedContains) expect(detailed.errors[0].expected).toContain(expectedContains);
    });
  });

  describe('配列バリデーションエラー', () => {
    it('フィールドパスを正しく表示する', () => {
      const schema = z.object({ items: z.array(SCHEMAS.ingest).min(1) });
      const error = parseAndExpectError(schema, {
        items: [{ svg_content: '', name: 'test', license_spdx: 'MIT' }, { svg_content: '<svg></svg>', name: '', license_spdx: 'MIT' }],
      });
      const detailed = formatDetailedValidationError(error);

      expect(detailed.errors.some(e => e.field?.includes('items.0'))).toBe(true);
      expect(detailed.errors.some(e => e.field?.includes('items.1'))).toBe(true);
    });
  });

  // URL/UUID/enumバリデーションエラーテスト（パラメータ化・重複削減）
  describe.each([
    { name: 'URL', schema: z.object({ source_url: z.string().url() }), input: { source_url: 'not-a-valid-url' }, field: 'source_url', hintContains: 'https://' },
    { name: 'UUID', schema: z.object({ id: z.string().uuid() }), input: { id: 'not-a-uuid' }, field: 'id', hintContains: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
    { name: 'enum', schema: z.object({ style: z.enum(['flat', 'line', 'filled', 'gradient']) }), input: { style: 'invalid-style' }, field: 'style', expectedContains: ['flat', 'gradient'] },
  ])('$nameバリデーションエラー', ({ schema, input, field, hintContains, expectedContains }) => {
    it('正しい形式例/選択肢を含む', () => {
      const error = parseAndExpectError(schema, input);
      const detailed = formatDetailedValidationError(error);

      expect(detailed.errors[0].field).toBe(field);
      if (hintContains) expect(detailed.errors[0].hint).toContain(hintContains);
      if (expectedContains) expectedContains.forEach(exp => expect(detailed.errors[0].expected).toContain(exp));
    });
  });

  describe('深くネストされたオブジェクト', () => {
    it('エラーパスを正しく処理する', () => {
      const schema = z.object({ options: z.object({ viewport: z.object({ width: z.number().min(320), height: z.number().min(240) }) }) });
      const error = parseAndExpectError(schema, { options: { viewport: { width: 100, height: 100 } } });
      const detailed = formatDetailedValidationError(error);

      expect(detailed.errors.some(e => e.field === 'options.viewport.width')).toBe(true);
      expect(detailed.errors.some(e => e.field === 'options.viewport.height')).toBe(true);
    });
  });
});

describe('Enhanced Error Messages - createValidationErrorWithHints', () => {
  afterEach(resetLocale);

  // ツール固有ヒントテスト（パラメータ化・重複削減）
  describe.each([
    { toolName: 'svg.ingest', schema: SCHEMAS.ingest, input: {}, hintCheck: (hints: string[]) => hints.every(h => h) },
    { toolName: 'layout.ingest', schema: z.object({ url: z.string().url() }), input: { url: 'invalid' }, hintCheck: (hints: string[]) => hints.some(h => h.includes('URL')) },
    {
      toolName: 'motion.detect',
      schema: z.object({ pageId: z.string().uuid().optional(), html: z.string().optional() }).refine((d) => d.pageId || d.html, { message: 'pageIdまたはhtmlのいずれかを指定してください' }),
      input: {},
      hintCheck: (hints: string[]) => hints.some(h => h?.includes('pageId') || h?.includes('html')),
    },
  ])('$toolName 用のヒント生成', ({ toolName, schema, input, hintCheck }) => {
    it('ツール固有のヒントを生成する', () => {
      const error = parseAndExpectError(schema, input);
      const errorWithHints = createValidationErrorWithHints(error, toolName);

      expect(errorWithHints.toolName).toBe(toolName);
      expect(errorWithHints.errors.length).toBeGreaterThan(0);
      expect(hintCheck(errorWithHints.errors.map(e => e.hint || ''))).toBe(true);
    });
  });
});

describe('Enhanced Error Messages - formatSingleError/formatMultipleErrors', () => {
  it('ヒント付きのエラーを整形する', () => {
    const error: McpToolError & { hint?: string } = { code: ERROR_CODES.REQUIRED_FIELD, message: "Required field 'svg_content' is missing", field: 'svg_content' };
    const formatted = formatSingleError(error);

    expect(formatted).toContain('svg_content');
    expect(formatted).toContain('missing');
  });

  it('複数のエラーを構造化された形式で出力する', () => {
    const error = parseAndExpectError(SCHEMAS.ingest, {});
    const errors = formatZodError(error);
    const formatted = formatMultipleErrors(errors, '\n');

    expect(formatted).toContain('svg_content');
    expect(formatted).toContain('name');
    expect(formatted).toContain('license_spdx');
  });
});

describe('DetailedValidationError type', () => {
  it('正しい型構造を持つ', () => {
    const error: DetailedValidationError = {
      field: 'test_field', code: ERROR_CODES.REQUIRED_FIELD, message: 'Test message', expected: 'string', received: 'undefined', hint: 'Test hint',
    };
    expect(error).toMatchObject({ field: 'test_field', code: ERROR_CODES.REQUIRED_FIELD, expected: 'string' });
  });
});

describe('refine によるカスタムバリデーションエラー', () => {
  it('refine エラーを処理する', () => {
    const schema = z.object({ colors: z.record(z.string()).optional(), apply_palette: z.boolean().optional() }).refine(
      (d) => (d.colors && Object.keys(d.colors).length > 0) || d.apply_palette === true,
      { message: 'colorsまたはapply_palette=trueのいずれかが必要です' }
    );
    const error = parseAndExpectError(schema, {});
    const detailed = formatDetailedValidationError(error);

    expect(detailed.errors.length).toBeGreaterThan(0);
    expect(detailed.errors[0].message).toContain('colors');
  });
});
