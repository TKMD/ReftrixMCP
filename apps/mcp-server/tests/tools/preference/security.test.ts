// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * preference MCPツール セキュリティテスト
 * SQLインジェクション防御、不正UUID処理、超長文字列処理、エラーメッセージサニタイズの検証
 *
 * preference MCP tools security tests
 * Validates SQL injection defense, invalid UUID handling, long string handling, error message sanitization
 *
 * @module tests/tools/preference/security.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  preferenceHearHandler,
  setPreferenceServiceFactory as setHearServiceFactory,
  resetPreferenceServiceFactory as resetHearServiceFactory,
  type IPreferenceService,
} from '../../../src/tools/preference/hear.tool';

import {
  preferenceGetHandler,
  setPreferenceServiceFactory as setGetServiceFactory,
  resetPreferenceServiceFactory as resetGetServiceFactory,
} from '../../../src/tools/preference/get.tool';

import {
  preferenceResetHandler,
  setPreferenceServiceFactory as setResetServiceFactory,
  resetPreferenceServiceFactory as resetResetServiceFactory,
} from '../../../src/tools/preference/reset.tool';

import {
  PREFERENCE_MCP_ERROR_CODES,
  sanitizeErrorMessage,
} from '../../../src/tools/preference/schemas';

// =====================================================
// テストデータ / Test Data
// =====================================================

const MOCK_PROFILE_ID = '01234567-89ab-cdef-0123-456789abcdef';

// =====================================================
// モックサービス / Mock Service
// =====================================================

function createMockService(overrides?: Partial<IPreferenceService>): IPreferenceService {
  return {
    getSamples: vi.fn().mockResolvedValue({
      profile_id: MOCK_PROFILE_ID,
      samples: [],
      progress: {
        confidence: 0,
        estimated_remaining: 5,
        remaining_reason: 'テスト / test',
        should_continue: true,
        mood_categories_covered: 0,
        mood_categories_total: 5,
      },
    }),
    processFeedback: vi.fn().mockResolvedValue({
      updated: true,
      profile_id: MOCK_PROFILE_ID,
      interaction_count: 1,
    }),
    getProfile: vi.fn().mockResolvedValue({
      profile_id: MOCK_PROFILE_ID,
      name: 'default',
      preference_text: null,
      interaction_count: 0,
      created_at: '2026-03-07T00:00:00Z',
      updated_at: '2026-03-07T00:00:00Z',
    }),
    resetProfile: vi.fn().mockResolvedValue({
      reset: true,
      profile_id: MOCK_PROFILE_ID,
    }),
    deleteProfile: vi.fn().mockResolvedValue({
      deleted: true,
      profile_id: MOCK_PROFILE_ID,
    }),
    getSignals: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// =====================================================
// ヘルパー / Helpers
// =====================================================

function setupAllFactories(service: IPreferenceService): void {
  setHearServiceFactory(() => service);
  setGetServiceFactory(() => service);
  setResetServiceFactory(() => service);
}

function resetAllFactories(): void {
  resetHearServiceFactory();
  resetGetServiceFactory();
  resetResetServiceFactory();
}

// =====================================================
// セキュリティテスト / Security Tests
// =====================================================

describe('preference セキュリティテスト', () => {
  beforeEach(() => {
    resetAllFactories();
  });

  afterEach(() => {
    resetAllFactories();
  });

  // =====================================================
  // 1. SQLインジェクション防御 / SQL Injection Defense
  // =====================================================

  describe('SQLインジェクション防御', () => {
    const SQL_INJECTION_PAYLOADS = [
      "'; DROP TABLE preference_profiles; --",
      "1' OR '1'='1",
      "1; SELECT * FROM preference_profiles --",
      "' UNION SELECT id, preference_text FROM preference_profiles --",
    ];

    it('profile_id に SQL injection 文字列 → Zodバリデーションエラー（UUID形式不一致）', async () => {
      const mockService = createMockService();
      setupAllFactories(mockService);

      for (const payload of SQL_INJECTION_PAYLOADS) {
        const result = await preferenceHearHandler({
          profile_id: payload,
        });

        expect(result).toHaveProperty('success', false);
        const error = (result as { success: false; error: { code: string } }).error;
        expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR);
      }

      // サービスメソッドが一度も呼ばれていないことを検証（バリデーション段階でブロック）
      expect(mockService.getSamples).not.toHaveBeenCalled();
      expect(mockService.processFeedback).not.toHaveBeenCalled();
    });

    it('exclude_ids に SQL injection 文字列 → Zodバリデーションエラー（UUID形式不一致）', async () => {
      const mockService = createMockService();
      setupAllFactories(mockService);

      for (const payload of SQL_INJECTION_PAYLOADS) {
        const result = await preferenceHearHandler({
          profile_id: MOCK_PROFILE_ID,
          exclude_ids: [payload],
        });

        expect(result).toHaveProperty('success', false);
        const error = (result as { success: false; error: { code: string } }).error;
        expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR);
      }

      expect(mockService.getSamples).not.toHaveBeenCalled();
    });

    it('preference_text に SQL injection 文字列 → パラメータ化クエリで安全に処理', async () => {
      const mockService = createMockService();
      setupAllFactories(mockService);

      // preference_text は文字列型であり UUID バリデーションではないため、
      // min(10)を満たすペイロードは Zod を通過する。
      // ただし Prisma パラメータ化クエリにより SQL injection は防御される。
      const longPayload = "'; DROP TABLE preference_profiles; -- padding text to meet minimum";

      const result = await preferenceHearHandler({
        profile_id: MOCK_PROFILE_ID,
        feedback: [
          {
            sample_id: '11111111-1111-1111-1111-111111111111',
            rating: 'positive',
          },
        ],
        preference_text: longPayload,
      });

      // Zod通過後、サービスレイヤーに到達（パラメータ化クエリで安全に処理）
      expect(result).toHaveProperty('success', true);
      expect(mockService.processFeedback).toHaveBeenCalledWith(
        MOCK_PROFILE_ID,
        expect.any(Array),
        longPayload
      );
    });

    it('comment に SQL injection 文字列 → パラメータ化クエリで安全に処理', async () => {
      const mockService = createMockService();
      setupAllFactories(mockService);

      const sqlComment = "'; DELETE FROM preference_signals; --";

      const result = await preferenceHearHandler({
        profile_id: MOCK_PROFILE_ID,
        feedback: [
          {
            sample_id: '11111111-1111-1111-1111-111111111111',
            rating: 'positive',
            comment: sqlComment,
          },
        ],
        preference_text: 'テスト嗜好テキストです。ミニマルなデザインが好み。',
      });

      // comment はパラメータ化クエリで安全に処理される
      expect(result).toHaveProperty('success', true);
      expect(mockService.processFeedback).toHaveBeenCalledWith(
        MOCK_PROFILE_ID,
        expect.arrayContaining([
          expect.objectContaining({ comment: sqlComment }),
        ]),
        expect.any(String)
      );
    });
  });

  // =====================================================
  // 2. 不正UUID処理 / Invalid UUID Handling
  // =====================================================

  describe('不正UUID処理', () => {
    it('非UUID形式の profile_id → バリデーションエラー（hear）', async () => {
      const mockService = createMockService();
      setupAllFactories(mockService);

      const invalidIds = [
        'not-a-uuid',
        '12345',
        'ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ',
        '../../../etc/passwd',
        '<script>alert("xss")</script>',
      ];

      for (const invalidId of invalidIds) {
        const result = await preferenceHearHandler({
          profile_id: invalidId,
        });

        expect(result).toHaveProperty('success', false);
        const error = (result as { success: false; error: { code: string } }).error;
        expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it('空文字列の profile_id → バリデーションエラー（get）', async () => {
      const mockService = createMockService();
      setupAllFactories(mockService);

      const result = await preferenceGetHandler({
        profile_id: '',
      });

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR);
    });

    it('不正形式の exclude_ids 要素 → バリデーションエラー', async () => {
      const mockService = createMockService();
      setupAllFactories(mockService);

      const result = await preferenceHearHandler({
        profile_id: MOCK_PROFILE_ID,
        exclude_ids: [
          '11111111-1111-1111-1111-111111111111', // 有効
          'invalid-uuid-format',                    // 無効
        ],
      });

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR);

      // サービスに到達していないことを確認
      expect(mockService.getSamples).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 3. 超長文字列処理 / Long String Handling
  // =====================================================

  describe('超長文字列処理', () => {
    it('1000文字超の preference_text → Zodバリデーションエラー（max: 1000）', async () => {
      const mockService = createMockService();
      setupAllFactories(mockService);

      // 1001文字の文字列を生成
      const longText = 'あ'.repeat(1001);

      const result = await preferenceHearHandler({
        profile_id: MOCK_PROFILE_ID,
        feedback: [
          {
            sample_id: '11111111-1111-1111-1111-111111111111',
            rating: 'positive',
          },
        ],
        preference_text: longText,
      });

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR);

      // サービスに到達していないことを確認
      expect(mockService.processFeedback).not.toHaveBeenCalled();
    });

    it('500文字超の comment → Zodバリデーションエラー（max: 500）', async () => {
      const mockService = createMockService();
      setupAllFactories(mockService);

      // 501文字のコメントを生成
      const longComment = 'b'.repeat(501);

      const result = await preferenceHearHandler({
        profile_id: MOCK_PROFILE_ID,
        feedback: [
          {
            sample_id: '11111111-1111-1111-1111-111111111111',
            rating: 'positive',
            comment: longComment,
          },
        ],
        preference_text: 'テスト嗜好テキストです。ミニマルなデザインが好み。',
      });

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR);

      // サービスに到達していないことを確認
      expect(mockService.processFeedback).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 4. エラーメッセージサニタイズ / Error Message Sanitization
  // =====================================================

  describe('エラーメッセージサニタイズ', () => {
    it('DBエラー時にテーブル名が漏洩しない（preference_profiles）', async () => {
      const dbError = new Error(
        'insert or update on table "preference_profiles" violates foreign key constraint'
      );
      const mockService = createMockService({
        getSamples: vi.fn().mockRejectedValue(dbError),
      });
      setupAllFactories(mockService);

      const result = await preferenceHearHandler({});

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string; message: string } }).error;

      // テーブル名が含まれていないことを検証
      expect(error.message).not.toContain('preference_profiles');
      expect(error.message).not.toContain('preference_signals');
      expect(error.message).not.toContain('design_narratives');
      expect(error.message).not.toContain('web_pages');

      // サニタイズ済みメッセージであることを検証
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.INTERNAL_ERROR);
      expect(error.message).toBe('An internal error occurred');
    });

    it('DBエラー時にSQL構文が漏洩しない（SELECT/INSERT/DELETE）', async () => {
      const sqlErrors = [
        new Error('SELECT id FROM preference_profiles WHERE id = $1 failed: connection refused'),
        new Error('INSERT INTO preference_signals (profile_id) VALUES ($1) failed'),
        new Error('DELETE FROM preference_signals WHERE profile_id = $1::uuid failed'),
      ];

      for (const sqlError of sqlErrors) {
        resetAllFactories();
        const mockService = createMockService({
          getProfile: vi.fn().mockRejectedValue(sqlError),
        });
        setupAllFactories(mockService);

        const result = await preferenceGetHandler({
          profile_id: MOCK_PROFILE_ID,
        });

        expect(result).toHaveProperty('success', false);
        const error = (result as { success: false; error: { code: string; message: string } }).error;

        // SQL構文が含まれていないことを検証
        expect(error.message).not.toContain('SELECT');
        expect(error.message).not.toContain('INSERT');
        expect(error.message).not.toContain('DELETE');
        expect(error.message).not.toContain('FROM');
        expect(error.message).not.toContain('WHERE');
        expect(error.message).not.toContain('$1');
      }
    });

    it('sanitizeErrorMessage() は全エラーコードに対して固定メッセージのみ返却する', () => {
      // 全定義済みエラーコードを検証
      const allCodes = Object.values(PREFERENCE_MCP_ERROR_CODES);

      for (const code of allCodes) {
        const message = sanitizeErrorMessage(code);
        expect(typeof message).toBe('string');
        expect(message.length).toBeGreaterThan(0);

        // DB構造が含まれていないことを検証
        expect(message).not.toContain('preference_profiles');
        expect(message).not.toContain('preference_signals');
        expect(message).not.toContain('SELECT');
        expect(message).not.toContain('INSERT');
      }

      // 未知のエラーコードに対してもフォールバックメッセージを返す
      const unknownMessage = sanitizeErrorMessage('UNKNOWN_CODE');
      expect(unknownMessage).toBe('An unexpected error occurred');
    });

    it('reset ハンドラーもDBエラー時にサニタイズ済みメッセージを返す', async () => {
      const dbError = new Error(
        'update "preference_profiles" set interaction_count = 0 failed: disk full'
      );
      const mockService = createMockService({
        resetProfile: vi.fn().mockRejectedValue(dbError),
      });
      setupAllFactories(mockService);

      const result = await preferenceResetHandler({
        profile_id: MOCK_PROFILE_ID,
        confirm: true,
      });

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string; message: string } }).error;

      expect(error.message).not.toContain('preference_profiles');
      expect(error.message).not.toContain('interaction_count');
      expect(error.message).not.toContain('disk full');
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.INTERNAL_ERROR);
      expect(error.message).toBe('An internal error occurred');
    });
  });
});
