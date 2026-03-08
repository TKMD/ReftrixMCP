// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * preference.reset MCPツール テスト
 * TDD Red Phase: プロファイルリセットツールの検証
 *
 * 機能:
 * - confirm: true でプロファイルリセット
 * - confirm: false でリセット拒否
 * - preference_signals CASCADE 削除
 *
 * @module tests/tools/preference/reset.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  preferenceResetHandler,
  preferenceResetToolDefinition,
  setPreferenceServiceFactory,
  resetPreferenceServiceFactory,
  type IPreferenceService,
} from '../../../src/tools/preference/reset.tool';

import {
  PREFERENCE_MCP_ERROR_CODES,
} from '../../../src/tools/preference/schemas';

// =====================================================
// テストデータ
// =====================================================

const MOCK_PROFILE_ID = '01234567-89ab-cdef-0123-456789abcdef';

// =====================================================
// モックサービス
// =====================================================

function createMockService(overrides?: Partial<IPreferenceService>): IPreferenceService {
  return {
    getSamples: vi.fn().mockResolvedValue({
      profile_id: MOCK_PROFILE_ID,
      samples: [],
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
// テスト
// =====================================================

describe('preference.reset MCPツール', () => {
  beforeEach(() => {
    resetPreferenceServiceFactory();
  });

  afterEach(() => {
    resetPreferenceServiceFactory();
  });

  // =====================================================
  // ツール定義テスト
  // =====================================================

  describe('ツール定義', () => {
    it('正しいツール名が設定されている', () => {
      expect(preferenceResetToolDefinition.name).toBe('preference.reset');
    });

    it('descriptionが設定されている', () => {
      expect(preferenceResetToolDefinition.description).toBeTruthy();
      expect(typeof preferenceResetToolDefinition.description).toBe('string');
    });

    it('inputSchemaが設定されている', () => {
      expect(preferenceResetToolDefinition.inputSchema).toBeDefined();
      expect(preferenceResetToolDefinition.inputSchema.type).toBe('object');
    });

    it('annotationsが設定されている', () => {
      expect(preferenceResetToolDefinition.annotations).toBeDefined();
    });
  });

  // =====================================================
  // 正常系テスト
  // =====================================================

  describe('正常系', () => {
    it('confirm: true でプロファイルをリセットする', async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceResetHandler({
        profile_id: MOCK_PROFILE_ID,
        confirm: true,
      });

      expect(result).toHaveProperty('success', true);
      const data = (result as { success: true; data: { reset: boolean; profile_id: string } }).data;
      expect(data.reset).toBe(true);
      expect(data.profile_id).toBe(MOCK_PROFILE_ID);
      expect(mockService.resetProfile).toHaveBeenCalledWith(MOCK_PROFILE_ID);
    });

    it('confirm: false でリセットを拒否する', async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceResetHandler({
        profile_id: MOCK_PROFILE_ID,
        confirm: false,
      });

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.RESET_NOT_CONFIRMED);
      expect(mockService.resetProfile).not.toHaveBeenCalled();
    });

    it('hard_delete: true でプロファイルを完全削除する（GDPR忘れられる権利）', async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceResetHandler({
        profile_id: MOCK_PROFILE_ID,
        confirm: true,
        hard_delete: true,
      });

      expect(result).toHaveProperty('success', true);
      const data = (result as { success: true; data: { reset: boolean; profile_id: string } }).data;
      expect(data.reset).toBe(true);
      expect(data.profile_id).toBe(MOCK_PROFILE_ID);
      expect(mockService.deleteProfile).toHaveBeenCalledWith(MOCK_PROFILE_ID);
      expect(mockService.resetProfile).not.toHaveBeenCalled();
    });

    it('hard_delete: false でソフトリセットを実行する', async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceResetHandler({
        profile_id: MOCK_PROFILE_ID,
        confirm: true,
        hard_delete: false,
      });

      expect(result).toHaveProperty('success', true);
      expect(mockService.resetProfile).toHaveBeenCalledWith(MOCK_PROFILE_ID);
      expect(mockService.deleteProfile).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // バリデーションエラーテスト
  // =====================================================

  describe('バリデーションエラー', () => {
    it('profile_idが必須', async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceResetHandler({
        confirm: true,
      });

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR);
    });

    it('confirmが必須', async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceResetHandler({
        profile_id: MOCK_PROFILE_ID,
      });

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR);
    });

    it('無効なprofile_idでエラーを返す', async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceResetHandler({
        profile_id: 'invalid',
        confirm: true,
      });

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.VALIDATION_ERROR);
    });
  });

  // =====================================================
  // サービス未設定テスト
  // =====================================================

  describe('サービス未設定', () => {
    it('サービスファクトリ未設定でエラーを返す', async () => {
      const result = await preferenceResetHandler({
        profile_id: MOCK_PROFILE_ID,
        confirm: true,
      });

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.SERVICE_UNAVAILABLE);
    });
  });

  // =====================================================
  // サービスエラーテスト
  // =====================================================

  describe('サービスエラー', () => {
    it('resetProfileでエラーが発生した場合、エラーレスポンスを返す', async () => {
      const mockService = createMockService({
        resetProfile: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      });
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceResetHandler({
        profile_id: MOCK_PROFILE_ID,
        confirm: true,
      });

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string; message: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.INTERNAL_ERROR);
      expect(error.message).toBe('An internal error occurred');
    });

    it('プロファイルが存在しない場合、PROFILE_NOT_FOUNDエラーを返す', async () => {
      const mockService = createMockService({
        resetProfile: vi.fn().mockRejectedValue(new Error('Profile not found')),
      });
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceResetHandler({
        profile_id: '99999999-9999-9999-9999-999999999999',
        confirm: true,
      });

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.PROFILE_NOT_FOUND);
    });
  });
});
