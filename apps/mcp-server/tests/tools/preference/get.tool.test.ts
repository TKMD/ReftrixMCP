// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * preference.get MCPツール テスト
 * TDD Red Phase: プロファイル取得ツールの検証
 *
 * 機能:
 * - profile_id 指定でプロファイル取得
 * - profile_id 省略でデフォルトプロファイル取得
 * - プロファイル未存在時の { exists: false } レスポンス
 *
 * @module tests/tools/preference/get.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  preferenceGetHandler,
  preferenceGetToolDefinition,
  setPreferenceServiceFactory,
  resetPreferenceServiceFactory,
  type IPreferenceService,
} from '../../../src/tools/preference/get.tool';

import {
  PREFERENCE_MCP_ERROR_CODES,
} from '../../../src/tools/preference/schemas';

// =====================================================
// テストデータ
// =====================================================

const MOCK_PROFILE_ID = '01234567-89ab-cdef-0123-456789abcdef';

const MOCK_PROFILE = {
  profile_id: MOCK_PROFILE_ID,
  name: 'default',
  preference_text: 'ミニマルでダークなデザインが好み',
  interaction_count: 5,
  created_at: '2026-03-07T00:00:00Z',
  updated_at: '2026-03-07T12:00:00Z',
};

// =====================================================
// モックサービス
// =====================================================

const MOCK_SIGNALS = [
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    signal_type: 'hearing_positive',
    signal_weight: 1.0,
    target_type: 'web_page',
    target_id: '11111111-1111-1111-1111-111111111111',
    feedback_text: 'ミニマルで美しい',
    created_at: '2026-03-07T01:00:00Z',
  },
];

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
    getProfile: vi.fn().mockResolvedValue(MOCK_PROFILE),
    resetProfile: vi.fn().mockResolvedValue({
      reset: true,
      profile_id: MOCK_PROFILE_ID,
    }),
    deleteProfile: vi.fn().mockResolvedValue({
      deleted: true,
      profile_id: MOCK_PROFILE_ID,
    }),
    getSignals: vi.fn().mockResolvedValue(MOCK_SIGNALS),
    ...overrides,
  };
}

// =====================================================
// テスト
// =====================================================

describe('preference.get MCPツール', () => {
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
      expect(preferenceGetToolDefinition.name).toBe('preference.get');
    });

    it('descriptionが設定されている', () => {
      expect(preferenceGetToolDefinition.description).toBeTruthy();
      expect(typeof preferenceGetToolDefinition.description).toBe('string');
    });

    it('inputSchemaが設定されている', () => {
      expect(preferenceGetToolDefinition.inputSchema).toBeDefined();
      expect(preferenceGetToolDefinition.inputSchema.type).toBe('object');
    });

    it('annotationsが設定されている（readOnlyHint: true）', () => {
      expect(preferenceGetToolDefinition.annotations).toBeDefined();
      expect(preferenceGetToolDefinition.annotations?.readOnlyHint).toBe(true);
    });
  });

  // =====================================================
  // 正常系テスト
  // =====================================================

  describe('正常系', () => {
    it('profile_id指定でプロファイルを取得する', async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceGetHandler({
        profile_id: MOCK_PROFILE_ID,
      });

      expect(result).toHaveProperty('success', true);
      const data = (result as { success: true; data: typeof MOCK_PROFILE }).data;
      expect(data.profile_id).toBe(MOCK_PROFILE_ID);
      expect(data.name).toBe('default');
      expect(data.preference_text).toBe('ミニマルでダークなデザインが好み');
      expect(data.interaction_count).toBe(5);
      expect(data.created_at).toBeDefined();
      expect(data.updated_at).toBeDefined();
    });

    it('profile_id省略でデフォルトプロファイルを取得する', async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceGetHandler({});

      expect(result).toHaveProperty('success', true);
      expect(mockService.getProfile).toHaveBeenCalledWith(undefined);
    });

    it('プロファイルが存在しない場合 exists: false を返す', async () => {
      const mockService = createMockService({
        getProfile: vi.fn().mockResolvedValue(null),
      });
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceGetHandler({
        profile_id: '99999999-9999-9999-9999-999999999999',
      });

      expect(result).toHaveProperty('success', true);
      const data = (result as { success: true; data: { exists: boolean } }).data;
      expect(data.exists).toBe(false);
    });

    it('include_signals: true でシグナルを含める（GDPRデータポータビリティ）', async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceGetHandler({
        profile_id: MOCK_PROFILE_ID,
        include_signals: true,
      });

      expect(result).toHaveProperty('success', true);
      const data = (result as { success: true; data: typeof MOCK_PROFILE & { signals: typeof MOCK_SIGNALS } }).data;
      expect(data.profile_id).toBe(MOCK_PROFILE_ID);
      expect(data.signals).toBeDefined();
      expect(data.signals).toHaveLength(1);
      expect(data.signals[0].signal_type).toBe('hearing_positive');
      expect(data.signals[0].signal_weight).toBe(1.0);
      expect(mockService.getSignals).toHaveBeenCalledWith(MOCK_PROFILE_ID);
    });

    it('include_signals: false ではシグナルを含めない', async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceGetHandler({
        profile_id: MOCK_PROFILE_ID,
        include_signals: false,
      });

      expect(result).toHaveProperty('success', true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.signals).toBeUndefined();
      expect(mockService.getSignals).not.toHaveBeenCalled();
    });

    it('include_signals 省略時はシグナルを含めない', async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceGetHandler({
        profile_id: MOCK_PROFILE_ID,
      });

      expect(result).toHaveProperty('success', true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.signals).toBeUndefined();
      expect(mockService.getSignals).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // バリデーションエラーテスト
  // =====================================================

  describe('バリデーションエラー', () => {
    it('無効なprofile_idでエラーを返す', async () => {
      const mockService = createMockService();
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceGetHandler({
        profile_id: 'invalid-uuid',
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
      const result = await preferenceGetHandler({});

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.SERVICE_UNAVAILABLE);
    });
  });

  // =====================================================
  // サービスエラーテスト
  // =====================================================

  describe('サービスエラー', () => {
    it('getProfileでエラーが発生した場合、エラーレスポンスを返す', async () => {
      const mockService = createMockService({
        getProfile: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      });
      setPreferenceServiceFactory(() => mockService);

      const result = await preferenceGetHandler({
        profile_id: MOCK_PROFILE_ID,
      });

      expect(result).toHaveProperty('success', false);
      const error = (result as { success: false; error: { code: string; message: string } }).error;
      expect(error.code).toBe(PREFERENCE_MCP_ERROR_CODES.INTERNAL_ERROR);
      expect(error.message).toBe('An internal error occurred');
    });
  });
});
