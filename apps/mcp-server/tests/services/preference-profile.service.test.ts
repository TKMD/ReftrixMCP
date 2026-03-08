// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PreferenceProfileService ユニットテスト
 * 812行のビジネスロジック中核に対する包括的テスト
 *
 * テストカテゴリ:
 * 1. getSamples（モードA）: サンプル取得、新規プロファイル作成、excludeIds、confidence計算
 * 2. processFeedback（モードB）: embedding生成、プロファイル更新、シグナル記録
 * 3. getProfile: ID指定/省略、存在しないプロファイル
 * 4. resetProfile: シグナルクリア、プロファイルリセット
 * 5. deleteProfile（GDPR忘れられる権利）: 完全削除、監査ログ
 * 6. getSignals（GDPRデータポータビリティ）: シグナル取得
 * 7. confidence計算: 2因子モデル検証
 * 8. DI/ファクトリー: 未初期化時エラー
 *
 * PreferenceProfileService unit tests
 * Comprehensive tests for the 812-line core business logic
 *
 * @module tests/services/preference-profile.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  PreferenceProfileService,
  setPreferenceEmbeddingServiceFactory,
  resetPreferenceEmbeddingServiceFactory,
  setPreferencePrismaClientFactory,
  resetPreferencePrismaClientFactory,
  resetPreferenceProfileService,
  type IEmbeddingService,
  type IPrismaClient,
} from '../../src/services/preference-profile.service';

// =====================================================
// logger モック / Logger mock
// =====================================================

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// テスト内で logger.warn の呼び出しを検証するためにインポート
// Import to verify logger.warn calls within tests
import { logger } from '../../src/utils/logger';

// =====================================================
// テストデータ / Test data
// =====================================================

const MOCK_PROFILE_ID = '01934567-89ab-7def-0123-456789abcdef';
const MOCK_PROFILE_ID_2 = '01934567-89ab-7def-0123-456789abcde0';
const MOCK_NARRATIVE_ID_1 = '11111111-1111-1111-1111-111111111111';
const MOCK_NARRATIVE_ID_2 = '22222222-2222-2222-2222-222222222222';
const MOCK_NARRATIVE_ID_3 = '33333333-3333-3333-3333-333333333333';

/** 768次元の擬似embeddingベクトル / 768-dimensional pseudo embedding vector */
function createMockEmbedding(): number[] {
  return Array.from({ length: 768 }, (_, i) => Math.sin(i) * 0.01);
}

// =====================================================
// モックファクトリー / Mock factories
// =====================================================

function createMockPrismaClient(overrides?: {
  queryRawUnsafe?: ReturnType<typeof vi.fn>;
  executeRawUnsafe?: ReturnType<typeof vi.fn>;
}): IPrismaClient {
  return {
    $queryRawUnsafe: overrides?.queryRawUnsafe ?? vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: overrides?.executeRawUnsafe ?? vi.fn().mockResolvedValue(0),
  };
}

function createMockEmbeddingService(overrides?: {
  generateEmbedding?: ReturnType<typeof vi.fn>;
}): IEmbeddingService {
  return {
    generateEmbedding: overrides?.generateEmbedding ?? vi.fn().mockResolvedValue(createMockEmbedding()),
  };
}

// =====================================================
// テスト
// =====================================================

describe('PreferenceProfileService', () => {
  let service: PreferenceProfileService;
  let mockPrisma: IPrismaClient;
  let mockEmbedding: IEmbeddingService;

  beforeEach(() => {
    // ファクトリーリセット + 再設定 / Factory reset + reconfigure
    resetPreferenceEmbeddingServiceFactory();
    resetPreferencePrismaClientFactory();
    resetPreferenceProfileService();

    mockPrisma = createMockPrismaClient();
    mockEmbedding = createMockEmbeddingService();

    setPreferencePrismaClientFactory(() => mockPrisma);
    setPreferenceEmbeddingServiceFactory(() => mockEmbedding);

    service = new PreferenceProfileService();

    vi.clearAllMocks();
  });

  afterEach(() => {
    resetPreferenceEmbeddingServiceFactory();
    resetPreferencePrismaClientFactory();
    resetPreferenceProfileService();
  });

  // =====================================================
  // 1. getSamples（モードA）
  // =====================================================

  describe('getSamples（モードA: サンプル提示）', () => {
    it('profileId未指定時に新規プロファイルを作成してサンプルを返す', async () => {
      const queryMock = vi.fn()
        // 1st call: INSERT INTO preference_profiles → 新規プロファイル
        .mockResolvedValueOnce([{
          id: MOCK_PROFILE_ID,
          name: 'default',
          preference_text: null,
          interaction_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
        }])
        // 2nd call: サンプル取得クエリ（design_narratives + web_pages JOIN）
        .mockResolvedValueOnce([
          {
            id: MOCK_NARRATIVE_ID_1,
            mood_category: 'minimalist',
            mood_description: 'クリーンなデザイン',
            overall_tone: 'シンプル',
            wp_url: 'https://example.com/minimal',
            wp_screenshot_desktop_url: 'https://example.com/screenshot.png',
          },
          {
            id: MOCK_NARRATIVE_ID_2,
            mood_category: 'bold',
            mood_description: '大胆なデザイン',
            overall_tone: 'インパクト',
            wp_url: 'https://example.com/bold',
            wp_screenshot_desktop_url: null,
          },
        ])
        // 3rd call: MoodCategoryCoverage（confidence計算）
        .mockResolvedValueOnce([{
          total_categories: 5,
          covered_categories: 0,
        }])
        // 4th call: interaction_count
        .mockResolvedValueOnce([{ interaction_count: 0 }]);

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getSamples();

      expect(result.profile_id).toBe(MOCK_PROFILE_ID);
      expect(result.samples).toHaveLength(2);
      expect(result.samples[0].mood_category).toBe('minimalist');
      expect(result.samples[0].screenshot_available).toBe(true);
      expect(result.samples[1].screenshot_available).toBe(false);
    });

    it('profileId指定時にINSERTを呼ばずサンプルを返す', async () => {
      const queryMock = vi.fn()
        // 1st call: サンプル取得（INSERTは呼ばれない）
        .mockResolvedValueOnce([
          {
            id: MOCK_NARRATIVE_ID_1,
            mood_category: 'elegant',
            mood_description: '上品なデザイン',
            overall_tone: 'エレガント',
            wp_url: 'https://example.com/elegant',
            wp_screenshot_desktop_url: null,
          },
        ])
        // 2nd call: MoodCategoryCoverage
        .mockResolvedValueOnce([{ total_categories: 5, covered_categories: 2 }])
        // 3rd call: interaction_count
        .mockResolvedValueOnce([{ interaction_count: 3 }]);

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getSamples({ profileId: MOCK_PROFILE_ID });

      expect(result.profile_id).toBe(MOCK_PROFILE_ID);
      expect(result.samples).toHaveLength(1);
      // INSERTクエリが呼ばれていないことを確認（最初のcallはSELECTのはず）
      const firstCallQuery = queryMock.mock.calls[0][0] as string;
      expect(firstCallQuery).not.toContain('INSERT INTO preference_profiles');
    });

    it('MoodCategoryの多様性を保証するサンプルが返される', async () => {
      const queryMock = vi.fn()
        .mockResolvedValueOnce([
          {
            id: MOCK_NARRATIVE_ID_1,
            mood_category: 'minimalist',
            mood_description: 'desc1',
            overall_tone: 'tone1',
            wp_url: 'https://example.com/1',
            wp_screenshot_desktop_url: null,
          },
          {
            id: MOCK_NARRATIVE_ID_2,
            mood_category: 'bold',
            mood_description: 'desc2',
            overall_tone: 'tone2',
            wp_url: 'https://example.com/2',
            wp_screenshot_desktop_url: null,
          },
          {
            id: MOCK_NARRATIVE_ID_3,
            mood_category: 'elegant',
            mood_description: 'desc3',
            overall_tone: 'tone3',
            wp_url: 'https://example.com/3',
            wp_screenshot_desktop_url: null,
          },
        ])
        .mockResolvedValueOnce([{ total_categories: 5, covered_categories: 0 }])
        .mockResolvedValueOnce([{ interaction_count: 0 }]);

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getSamples({ profileId: MOCK_PROFILE_ID });

      const categories = result.samples.map((s) => s.mood_category);
      const uniqueCategories = new Set(categories);
      expect(uniqueCategories.size).toBe(3);
    });

    it('excludeIdsが正しくSQLパラメータとして渡される', async () => {
      const queryMock = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total_categories: 5, covered_categories: 0 }])
        .mockResolvedValueOnce([{ interaction_count: 0 }]);

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      await service.getSamples({
        profileId: MOCK_PROFILE_ID,
        excludeIds: [MOCK_NARRATIVE_ID_1, MOCK_NARRATIVE_ID_2],
      });

      // サンプル取得クエリの第1引数（excludeParam）を確認
      const sampleCallArgs = queryMock.mock.calls[0];
      expect(sampleCallArgs[1]).toBe(`{${MOCK_NARRATIVE_ID_1},${MOCK_NARRATIVE_ID_2}}`);
    });

    it('不正なUUIDがexcludeIdsに含まれる場合にエラーを投げる', async () => {
      await expect(
        service.getSamples({
          profileId: MOCK_PROFILE_ID,
          excludeIds: ['not-a-valid-uuid'],
        })
      ).rejects.toThrow('Invalid UUID in exclude_ids');
    });

    it('confidence >= 0.8 の場合 should_continue が false になる', async () => {
      const queryMock = vi.fn()
        .mockResolvedValueOnce([]) // samples
        .mockResolvedValueOnce([{ total_categories: 5, covered_categories: 5 }]) // coverage: 100%
        .mockResolvedValueOnce([{ interaction_count: 8 }]); // sufficiency: min(8/5, 1.0) = 1.0

      // confidence = 1.0 * 0.6 + 1.0 * 0.4 = 1.0 (>= 0.8)
      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getSamples({ profileId: MOCK_PROFILE_ID });

      expect(result.progress.should_continue).toBe(false);
      expect(result.progress.confidence).toBeGreaterThanOrEqual(0.8);
      expect(result.progress.estimated_remaining).toBe(0);
    });

    it('interactionCount >= 15 の場合 should_continue が false になる', async () => {
      const queryMock = vi.fn()
        .mockResolvedValueOnce([]) // samples
        .mockResolvedValueOnce([{ total_categories: 5, covered_categories: 1 }]) // coverage: 20%
        .mockResolvedValueOnce([{ interaction_count: 15 }]); // hit MAX_HEARINGS

      // confidence = 0.2 * 0.6 + 1.0 * 0.4 = 0.52 (< 0.8 but interaction >= 15)
      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getSamples({ profileId: MOCK_PROFILE_ID });

      expect(result.progress.should_continue).toBe(false);
    });

    it('新規プロファイル作成時に profiling_notice を含む（GDPR Art.13/14）', async () => {
      const queryMock = vi.fn()
        // INSERT (new profile)
        .mockResolvedValueOnce([{
          id: MOCK_PROFILE_ID,
          name: 'default',
          preference_text: null,
          interaction_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
        }])
        .mockResolvedValueOnce([]) // samples
        .mockResolvedValueOnce([{ total_categories: 5, covered_categories: 0 }])
        .mockResolvedValueOnce([{ interaction_count: 0 }]);

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getSamples(); // profileId未指定 → 新規

      expect(result.profiling_notice).toBeDefined();
      expect(result.profiling_notice!.message).toContain('preference profile');
      expect(result.profiling_notice!.message).toContain('嗜好プロファイル');
      expect(result.profiling_notice!.purpose).toContain('Personalization');
      expect(result.profiling_notice!.deletion_method).toContain('GDPR');
      expect(result.profiling_notice!.retention_policy).toContain('explicitly deleted');
    });
  });

  // =====================================================
  // 2. processFeedback（モードB）
  // =====================================================

  describe('processFeedback（モードB: フィードバック受信）', () => {
    it('embedding生成・プロファイル更新・シグナル記録を実行する', async () => {
      const executeMock = vi.fn().mockResolvedValue(1);
      const queryMock = vi.fn()
        .mockResolvedValueOnce([{ interaction_count: 1 }]); // 更新後のinteraction_count

      mockPrisma = createMockPrismaClient({
        queryRawUnsafe: queryMock,
        executeRawUnsafe: executeMock,
      });
      mockEmbedding = createMockEmbeddingService();

      setPreferencePrismaClientFactory(() => mockPrisma);
      setPreferenceEmbeddingServiceFactory(() => mockEmbedding);
      service = new PreferenceProfileService();

      const result = await service.processFeedback(
        MOCK_PROFILE_ID,
        [
          { sample_id: MOCK_NARRATIVE_ID_1, rating: 'positive', comment: '素敵なデザイン' },
        ],
        'ミニマルでクリーンなデザインが好みです。シンプルさを重視。'
      );

      expect(result.updated).toBe(true);
      expect(result.profile_id).toBe(MOCK_PROFILE_ID);
      expect(result.interaction_count).toBe(1);

      // embedding生成が呼ばれたことを確認
      expect(mockEmbedding.generateEmbedding).toHaveBeenCalledWith(
        'ミニマルでクリーンなデザインが好みです。シンプルさを重視。',
        'passage'
      );

      // UPDATE preference_profiles が呼ばれたことを確認
      expect(executeMock).toHaveBeenCalledTimes(2); // 1 UPDATE + 1 INSERT signal
      const updateCall = executeMock.mock.calls[0][0] as string;
      expect(updateCall).toContain('UPDATE preference_profiles');
    });

    it('フィードバックシグナルが各アイテムごとに記録される', async () => {
      const executeMock = vi.fn().mockResolvedValue(1);
      const queryMock = vi.fn()
        .mockResolvedValueOnce([{ interaction_count: 2 }]);

      mockPrisma = createMockPrismaClient({
        queryRawUnsafe: queryMock,
        executeRawUnsafe: executeMock,
      });
      setPreferencePrismaClientFactory(() => mockPrisma);
      setPreferenceEmbeddingServiceFactory(() => mockEmbedding);
      service = new PreferenceProfileService();

      await service.processFeedback(
        MOCK_PROFILE_ID,
        [
          { sample_id: MOCK_NARRATIVE_ID_1, rating: 'positive' },
          { sample_id: MOCK_NARRATIVE_ID_2, rating: 'negative', comment: '好みではない' },
          { sample_id: MOCK_NARRATIVE_ID_3, rating: 'neutral' },
        ],
        '好みのテキスト説明。少なくとも10文字。'
      );

      // 1 UPDATE + 3 INSERT signals = 4 calls
      expect(executeMock).toHaveBeenCalledTimes(4);

      // positive signal (weight 1.0)
      const positiveCall = executeMock.mock.calls[1];
      expect(positiveCall[1]).toBe(MOCK_PROFILE_ID); // profile_id
      expect(positiveCall[2]).toBe('hearing_positive'); // signal_type
      expect(positiveCall[3]).toBe(1.0); // signal_weight

      // negative signal (weight -0.5)
      const negativeCall = executeMock.mock.calls[2];
      expect(negativeCall[2]).toBe('hearing_negative');
      expect(negativeCall[3]).toBe(-0.5);
      expect(negativeCall[6]).toBe('好みではない'); // feedback_text

      // neutral signal (weight 0.0)
      const neutralCall = executeMock.mock.calls[3];
      expect(neutralCall[2]).toBe('hearing_neutral');
      expect(neutralCall[3]).toBe(0.0);
    });

    it('embedding生成失敗時にエラーを投げる', async () => {
      mockEmbedding = createMockEmbeddingService({
        generateEmbedding: vi.fn().mockRejectedValue(new Error('ONNX Runtime error')),
      });
      setPreferenceEmbeddingServiceFactory(() => mockEmbedding);
      service = new PreferenceProfileService();

      await expect(
        service.processFeedback(
          MOCK_PROFILE_ID,
          [{ sample_id: MOCK_NARRATIVE_ID_1, rating: 'positive' }],
          'テスト用の嗜好テキストです。少なくとも10文字。'
        )
      ).rejects.toThrow('Embedding generation failed: ONNX Runtime error');
    });

    it('positive/negative/neutral の rating が正しいsignal_weightにマッピングされる', async () => {
      const executeMock = vi.fn().mockResolvedValue(1);
      const queryMock = vi.fn()
        .mockResolvedValueOnce([{ interaction_count: 1 }]);

      mockPrisma = createMockPrismaClient({
        queryRawUnsafe: queryMock,
        executeRawUnsafe: executeMock,
      });
      setPreferencePrismaClientFactory(() => mockPrisma);
      setPreferenceEmbeddingServiceFactory(() => mockEmbedding);
      service = new PreferenceProfileService();

      await service.processFeedback(
        MOCK_PROFILE_ID,
        [
          { sample_id: MOCK_NARRATIVE_ID_1, rating: 'positive' },
          { sample_id: MOCK_NARRATIVE_ID_2, rating: 'negative' },
          { sample_id: MOCK_NARRATIVE_ID_3, rating: 'neutral' },
        ],
        '嗜好テキストのテスト。十分な文字数。'
      );

      // signal_weight検証: index 1-3 が INSERT calls
      expect(executeMock.mock.calls[1][3]).toBe(1.0);  // positive → 1.0
      expect(executeMock.mock.calls[2][3]).toBe(-0.5);  // negative → -0.5
      expect(executeMock.mock.calls[3][3]).toBe(0.0);   // neutral → 0.0
    });

    it('interaction_countがインクリメントされる', async () => {
      const executeMock = vi.fn().mockResolvedValue(1);
      const queryMock = vi.fn()
        .mockResolvedValueOnce([{ interaction_count: 5 }]); // 既存のカウント+1

      mockPrisma = createMockPrismaClient({
        queryRawUnsafe: queryMock,
        executeRawUnsafe: executeMock,
      });
      setPreferencePrismaClientFactory(() => mockPrisma);
      setPreferenceEmbeddingServiceFactory(() => mockEmbedding);
      service = new PreferenceProfileService();

      const result = await service.processFeedback(
        MOCK_PROFILE_ID,
        [{ sample_id: MOCK_NARRATIVE_ID_1, rating: 'positive' }],
        '嗜好テキストのテスト。十分な文字数。'
      );

      expect(result.interaction_count).toBe(5);
      // UPDATEクエリ内に interaction_count = interaction_count + 1 が含まれることを確認
      const updateQuery = executeMock.mock.calls[0][0] as string;
      expect(updateQuery).toContain('interaction_count = interaction_count + 1');
    });
  });

  // =====================================================
  // 3. getProfile
  // =====================================================

  describe('getProfile', () => {
    it('ID指定でプロファイルを取得する', async () => {
      const queryMock = vi.fn().mockResolvedValueOnce([{
        id: MOCK_PROFILE_ID,
        name: 'default',
        preference_text: 'ミニマルデザインが好み',
        interaction_count: 5,
        created_at: new Date('2026-03-07T00:00:00Z'),
        updated_at: new Date('2026-03-07T12:00:00Z'),
      }]);

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getProfile(MOCK_PROFILE_ID);

      expect(result).not.toBeNull();
      expect(result!.profile_id).toBe(MOCK_PROFILE_ID);
      expect(result!.name).toBe('default');
      expect(result!.preference_text).toBe('ミニマルデザインが好み');
      expect(result!.interaction_count).toBe(5);
      expect(result!.created_at).toBeDefined();
      expect(result!.updated_at).toBeDefined();

      // WHERE id = $1::uuid で呼ばれたことを確認
      const queryCall = queryMock.mock.calls[0][0] as string;
      expect(queryCall).toContain('WHERE id = $1::uuid');
      expect(queryMock.mock.calls[0][1]).toBe(MOCK_PROFILE_ID);
    });

    it('ID省略でデフォルトプロファイルを取得する', async () => {
      const queryMock = vi.fn().mockResolvedValueOnce([{
        id: MOCK_PROFILE_ID_2,
        name: 'default',
        preference_text: null,
        interaction_count: 0,
        created_at: new Date('2026-03-07T00:00:00Z'),
        updated_at: new Date('2026-03-07T00:00:00Z'),
      }]);

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getProfile();

      expect(result).not.toBeNull();
      expect(result!.profile_id).toBe(MOCK_PROFILE_ID_2);
      // WHERE name = 'default' で呼ばれたことを確認
      const queryCall = queryMock.mock.calls[0][0] as string;
      expect(queryCall).toContain("WHERE name = 'default'");
    });

    it('存在しないプロファイルの場合 null を返す', async () => {
      const queryMock = vi.fn().mockResolvedValueOnce([]);

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getProfile('99999999-9999-9999-9999-999999999999');

      expect(result).toBeNull();
    });
  });

  // =====================================================
  // 4. resetProfile
  // =====================================================

  describe('resetProfile', () => {
    it('シグナルクリア＋プロファイルフィールドリセットを実行する', async () => {
      const queryMock = vi.fn()
        .mockResolvedValueOnce([{ id: MOCK_PROFILE_ID }]); // 存在確認

      const executeMock = vi.fn().mockResolvedValue(1);

      mockPrisma = createMockPrismaClient({
        queryRawUnsafe: queryMock,
        executeRawUnsafe: executeMock,
      });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.resetProfile(MOCK_PROFILE_ID);

      expect(result.reset).toBe(true);
      expect(result.profile_id).toBe(MOCK_PROFILE_ID);

      // DELETE preference_signals が呼ばれたことを確認
      expect(executeMock).toHaveBeenCalledTimes(2);
      const deleteCall = executeMock.mock.calls[0][0] as string;
      expect(deleteCall).toContain('DELETE FROM preference_signals');

      // UPDATE preference_profiles が呼ばれたことを確認
      const updateCall = executeMock.mock.calls[1][0] as string;
      expect(updateCall).toContain('UPDATE preference_profiles');
      expect(updateCall).toContain('preference_text = NULL');
      expect(updateCall).toContain('preference_embedding = NULL');
      expect(updateCall).toContain('interaction_count = 0');
    });

    it('プロファイル未発見時にエラーを投げる', async () => {
      const queryMock = vi.fn().mockResolvedValueOnce([]); // 存在しない

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      await expect(
        service.resetProfile('99999999-9999-9999-9999-999999999999')
      ).rejects.toThrow('Profile not found');
    });
  });

  // =====================================================
  // 5. deleteProfile（GDPR忘れられる権利）
  // =====================================================

  describe('deleteProfile（GDPR忘れられる権利）', () => {
    it('プロファイル＋シグナルを完全削除する', async () => {
      const queryMock = vi.fn()
        .mockResolvedValueOnce([{ id: MOCK_PROFILE_ID }]); // 存在確認

      const executeMock = vi.fn().mockResolvedValue(1);

      mockPrisma = createMockPrismaClient({
        queryRawUnsafe: queryMock,
        executeRawUnsafe: executeMock,
      });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.deleteProfile(MOCK_PROFILE_ID);

      expect(result.deleted).toBe(true);
      expect(result.profile_id).toBe(MOCK_PROFILE_ID);

      // DELETE signals → DELETE profile の順序を確認
      expect(executeMock).toHaveBeenCalledTimes(2);
      const deleteSignalsCall = executeMock.mock.calls[0][0] as string;
      expect(deleteSignalsCall).toContain('DELETE FROM preference_signals');
      const deleteProfileCall = executeMock.mock.calls[1][0] as string;
      expect(deleteProfileCall).toContain('DELETE FROM preference_profiles');
    });

    it('全環境で監査ログが出力される（isDevelopmentガードなし）', async () => {
      const queryMock = vi.fn()
        .mockResolvedValueOnce([{ id: MOCK_PROFILE_ID }]);

      const executeMock = vi.fn().mockResolvedValue(1);

      mockPrisma = createMockPrismaClient({
        queryRawUnsafe: queryMock,
        executeRawUnsafe: executeMock,
      });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      await service.deleteProfile(MOCK_PROFILE_ID);

      // logger.warn が全環境で呼ばれることを確認（isDevelopmentに依存しない）
      expect(logger.warn).toHaveBeenCalledTimes(2);

      // 開始ログ: hard_delete action
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Deleting profile (hard delete / GDPR erasure)'),
        expect.objectContaining({
          profileId: expect.stringContaining('...'), // PII truncated
          action: 'hard_delete',
        })
      );

      // 完了ログ: hard_delete_completed action
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('hard delete completed'),
        expect.objectContaining({
          profileId: expect.stringContaining('...'),
          action: 'hard_delete_completed',
        })
      );
    });

    it('プロファイル未発見時にエラーを投げる', async () => {
      const queryMock = vi.fn().mockResolvedValueOnce([]); // 存在しない

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      await expect(
        service.deleteProfile('99999999-9999-9999-9999-999999999999')
      ).rejects.toThrow('Profile not found');
    });
  });

  // =====================================================
  // 6. getSignals（GDPRデータポータビリティ）
  // =====================================================

  describe('getSignals（GDPRデータポータビリティ）', () => {
    it('プロファイルの全シグナルを返す', async () => {
      const signalDate = new Date('2026-03-07T01:00:00Z');
      const queryMock = vi.fn().mockResolvedValueOnce([
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          signal_type: 'hearing_positive',
          signal_weight: 1.0,
          target_type: 'web_page',
          target_id: MOCK_NARRATIVE_ID_1,
          feedback_text: 'ミニマルで美しい',
          created_at: signalDate,
        },
        {
          id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          signal_type: 'hearing_negative',
          signal_weight: -0.5,
          target_type: 'web_page',
          target_id: MOCK_NARRATIVE_ID_2,
          feedback_text: null,
          created_at: signalDate,
        },
      ]);

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getSignals(MOCK_PROFILE_ID);

      expect(result).toHaveLength(2);
      expect(result[0].signal_type).toBe('hearing_positive');
      expect(result[0].signal_weight).toBe(1.0);
      expect(result[0].feedback_text).toBe('ミニマルで美しい');
      expect(result[0].created_at).toBe('2026-03-07T01:00:00.000Z');
      expect(result[1].signal_type).toBe('hearing_negative');
      expect(result[1].signal_weight).toBe(-0.5);
      expect(result[1].feedback_text).toBeNull();
    });

    it('シグナルなしの場合は空配列を返す', async () => {
      const queryMock = vi.fn().mockResolvedValueOnce([]);

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getSignals(MOCK_PROFILE_ID);

      expect(result).toEqual([]);
    });
  });

  // =====================================================
  // 7. confidence計算（2因子モデル）
  // =====================================================

  describe('confidence計算（2因子モデル）', () => {
    it('MoodCategory coverage重み0.6 + interaction sufficiency重み0.4 で正しく計算される', async () => {
      // coverage: 3/5 = 0.6, sufficiency: min(4/5, 1.0) = 0.8
      // confidence = 0.6 * 0.6 + 0.8 * 0.4 = 0.36 + 0.32 = 0.68
      const queryMock = vi.fn()
        .mockResolvedValueOnce([]) // samples
        .mockResolvedValueOnce([{ total_categories: 5, covered_categories: 3 }])
        .mockResolvedValueOnce([{ interaction_count: 4 }]);

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getSamples({ profileId: MOCK_PROFILE_ID });

      expect(result.progress.confidence).toBe(0.68);
      expect(result.progress.mood_categories_covered).toBe(3);
      expect(result.progress.mood_categories_total).toBe(5);
    });

    it('confidence上限が1.0を超えない', async () => {
      // coverage: 5/5 = 1.0, sufficiency: min(10/5, 1.0) = 1.0
      // confidence = 1.0 * 0.6 + 1.0 * 0.4 = 1.0 → Math.min(1.0, 1.0) = 1.0
      const queryMock = vi.fn()
        .mockResolvedValueOnce([]) // samples
        .mockResolvedValueOnce([{ total_categories: 5, covered_categories: 5 }])
        .mockResolvedValueOnce([{ interaction_count: 10 }]);

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getSamples({ profileId: MOCK_PROFILE_ID });

      expect(result.progress.confidence).toBeLessThanOrEqual(1.0);
      expect(result.progress.confidence).toBe(1.0);
    });

    it('残りヒアリング数が正しく推定される', async () => {
      // coverage: 2/5 = 0.4, sufficiency: min(3/5, 1.0) = 0.6
      // confidence = 0.4 * 0.6 + 0.6 * 0.4 = 0.24 + 0.24 = 0.48
      // remaining = ceil((0.8 - 0.48) / 0.12) = ceil(0.32/0.12) ≈ ceil(2.666) = 3
      // maxRemaining = max(15 - 3, 0) = 12
      // estimated = min(3, 12) = 3
      const queryMock = vi.fn()
        .mockResolvedValueOnce([]) // samples
        .mockResolvedValueOnce([{ total_categories: 5, covered_categories: 2 }]) // coverage: 2/5=0.4
        .mockResolvedValueOnce([{ interaction_count: 3 }]); // sufficiency: 3/5=0.6

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getSamples({ profileId: MOCK_PROFILE_ID });

      // confidence = 0.4 * 0.6 + 0.6 * 0.4 = 0.24 + 0.24 = 0.48
      expect(result.progress.confidence).toBe(0.48);
      expect(result.progress.estimated_remaining).toBeGreaterThan(0);
      expect(result.progress.estimated_remaining).toBeLessThanOrEqual(12);
      expect(result.progress.should_continue).toBe(true);
    });

    it('totalCategories が 0 の場合 categoryCoverage は 0 になる', async () => {
      const queryMock = vi.fn()
        .mockResolvedValueOnce([]) // samples
        .mockResolvedValueOnce([{ total_categories: 0, covered_categories: 0 }])
        .mockResolvedValueOnce([{ interaction_count: 0 }]);

      mockPrisma = createMockPrismaClient({ queryRawUnsafe: queryMock });
      setPreferencePrismaClientFactory(() => mockPrisma);
      service = new PreferenceProfileService();

      const result = await service.getSamples({ profileId: MOCK_PROFILE_ID });

      // confidence = 0 * 0.6 + 0 * 0.4 = 0
      expect(result.progress.confidence).toBe(0);
      expect(result.progress.mood_categories_total).toBe(0);
    });
  });

  // =====================================================
  // 8. DI/ファクトリー
  // =====================================================

  describe('DI/ファクトリー', () => {
    it('EmbeddingService未初期化時にエラーを投げる', async () => {
      resetPreferenceEmbeddingServiceFactory();

      // processFeedback 内で getEmbeddingService() が呼ばれる
      const executeMock = vi.fn().mockResolvedValue(1);
      const queryMock = vi.fn().mockResolvedValueOnce([{ interaction_count: 1 }]);

      mockPrisma = createMockPrismaClient({
        queryRawUnsafe: queryMock,
        executeRawUnsafe: executeMock,
      });
      setPreferencePrismaClientFactory(() => mockPrisma);
      // EmbeddingServiceファクトリは設定しない
      service = new PreferenceProfileService();

      await expect(
        service.processFeedback(
          MOCK_PROFILE_ID,
          [{ sample_id: MOCK_NARRATIVE_ID_1, rating: 'positive' }],
          '嗜好テキスト。少なくとも10文字。'
        )
      ).rejects.toThrow('EmbeddingService not initialized');
    });

    it('PrismaClient未初期化時にエラーを投げる', async () => {
      resetPreferencePrismaClientFactory();
      service = new PreferenceProfileService();

      await expect(
        service.getSamples({ profileId: MOCK_PROFILE_ID })
      ).rejects.toThrow('PrismaClient not initialized');
    });
  });
});
