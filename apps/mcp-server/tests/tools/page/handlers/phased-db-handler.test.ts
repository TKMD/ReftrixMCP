// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PhasedDbHandler - 段階的分析のDB即時コミットハンドラーのテスト
 * TDD Green Phase: 実装に対するテスト
 *
 * Phase2-2: 各フェーズ完了時に部分結果を即座にDBにコミットする機能
 *
 * @module tests/tools/page/handlers/phased-db-handler.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { AnalysisPhaseStatus } from '@prisma/client';
import {
  PhasedDbHandler,
  type PhaseResult,
  type MinimalPrismaClient,
} from '../../../../src/tools/page/handlers/phased-db-handler';

// =====================================================
// モック用型定義
// =====================================================

/**
 * Prismaクライアントモック型
 */
interface MockPrismaClient extends MinimalPrismaClient {
  webPage: {
    update: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
}

// =====================================================
// モック用ヘルパー
// =====================================================

/**
 * Prismaクライアントのモック作成
 */
function createMockPrismaClient(): MockPrismaClient {
  const mockClient: MockPrismaClient = {
    webPage: {
      update: vi.fn().mockResolvedValue({ id: uuidv7() }),
    },
    $transaction: vi.fn(),
  };

  // $transactionのモック: コールバック関数を実行
  mockClient.$transaction = vi.fn().mockImplementation(async (fn: (tx: MockPrismaClient) => Promise<unknown>) => {
    return await fn(mockClient);
  });

  return mockClient;
}

/**
 * 成功したフェーズ結果を作成
 */
function createSuccessPhaseResult<T>(
  phase: 'layout' | 'motion' | 'quality',
  data: T
): PhaseResult<T> {
  return {
    phase,
    success: true,
    data,
    durationMs: 100,
    timedOut: false,
  };
}

/**
 * 失敗したフェーズ結果を作成
 */
function createFailedPhaseResult(
  phase: 'layout' | 'motion' | 'quality',
  error: string,
  timedOut: boolean = false
): PhaseResult<unknown> {
  return {
    phase,
    success: false,
    error,
    durationMs: 1000,
    timedOut,
  };
}

// =====================================================
// テストスイート
// =====================================================

describe('PhasedDbHandler', () => {
  let mockPrismaClient: MockPrismaClient;
  let webPageId: string;

  beforeEach(() => {
    vi.resetAllMocks();
    mockPrismaClient = createMockPrismaClient();
    webPageId = uuidv7();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------
  // markAnalysisStarted テスト
  // ---------------------------------------------------
  describe('markAnalysisStarted', () => {
    it('分析開始時にanalysisPhaseStatusをpendingに設定', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await handler.markAnalysisStarted();

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'pending',
        }),
      });
    });

    it('分析開始時にanalysisStartedAtが設定される', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      const beforeCall = new Date();
      await handler.markAnalysisStarted();
      const afterCall = new Date();

      expect(mockPrismaClient.webPage.update).toHaveBeenCalled();
      const updateCall = vi.mocked(mockPrismaClient.webPage.update).mock.calls[0];
      const data = updateCall?.[0]?.data;

      expect(data?.analysisStartedAt).toBeDefined();
      const startedAt = new Date(data?.analysisStartedAt as Date);
      expect(startedAt.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(startedAt.getTime()).toBeLessThanOrEqual(afterCall.getTime());
    });

    it('分析開始時にanalysisErrorをnullにリセット', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await handler.markAnalysisStarted();

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisError: null,
        }),
      });
    });

    it('分析開始時にlastAnalyzedPhaseをnullにリセット', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await handler.markAnalysisStarted();

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          lastAnalyzedPhase: null,
        }),
      });
    });
  });

  // ---------------------------------------------------
  // commitPhaseResult テスト - Layout
  // ---------------------------------------------------
  describe('commitPhaseResult - Layout', () => {
    it('Layout成功時にanalysisPhaseStatusをlayout_doneに設定', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      const result = createSuccessPhaseResult('layout', { sectionCount: 5 });
      await handler.commitPhaseResult('layout', result);

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'layout_done',
        }),
      });
    });

    it('Layout成功時にlastAnalyzedPhaseをlayoutに設定', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      const result = createSuccessPhaseResult('layout', { sectionCount: 5 });
      await handler.commitPhaseResult('layout', result);

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          lastAnalyzedPhase: 'layout',
        }),
      });
    });

    it('Layout失敗時はanalysisPhaseStatusを更新しない', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      const result = createFailedPhaseResult('layout', 'Layout analysis failed');
      await handler.commitPhaseResult('layout', result);

      // 失敗時は更新されないか、明示的にfailedステータスに更新される
      const updateCalls = vi.mocked(mockPrismaClient.webPage.update).mock.calls;
      // 失敗時の動作は実装に依存（ここでは更新しないことを期待）
      expect(updateCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------
  // commitPhaseResult テスト - Motion
  // ---------------------------------------------------
  describe('commitPhaseResult - Motion', () => {
    it('Motion成功時にanalysisPhaseStatusをmotion_doneに設定', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      const result = createSuccessPhaseResult('motion', { patternCount: 3 });
      await handler.commitPhaseResult('motion', result);

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'motion_done',
        }),
      });
    });

    it('Motion成功時にlastAnalyzedPhaseをmotionに設定', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      const result = createSuccessPhaseResult('motion', { patternCount: 3 });
      await handler.commitPhaseResult('motion', result);

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          lastAnalyzedPhase: 'motion',
        }),
      });
    });

    it('Motion失敗時はanalysisPhaseStatusを更新しない', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      const result = createFailedPhaseResult('motion', 'Motion detection failed');
      await handler.commitPhaseResult('motion', result);

      // 失敗時は更新されないことを期待
      const updateCalls = vi.mocked(mockPrismaClient.webPage.update).mock.calls;
      expect(updateCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------
  // commitPhaseResult テスト - Quality
  // ---------------------------------------------------
  describe('commitPhaseResult - Quality', () => {
    it('Quality成功時にanalysisPhaseStatusをquality_doneに設定', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      const result = createSuccessPhaseResult('quality', { overallScore: 85 });
      await handler.commitPhaseResult('quality', result);

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'quality_done',
        }),
      });
    });

    it('Quality成功時にlastAnalyzedPhaseをqualityに設定', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      const result = createSuccessPhaseResult('quality', { overallScore: 85 });
      await handler.commitPhaseResult('quality', result);

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          lastAnalyzedPhase: 'quality',
        }),
      });
    });
  });

  // ---------------------------------------------------
  // markAnalysisCompleted テスト
  // ---------------------------------------------------
  describe('markAnalysisCompleted', () => {
    it('全フェーズ成功時にanalysisPhaseStatusをcompletedに設定', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await handler.markAnalysisCompleted(true);

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'completed',
        }),
      });
    });

    it('完了時にanalysisCompletedAtが設定される', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      const beforeCall = new Date();
      await handler.markAnalysisCompleted(true);
      const afterCall = new Date();

      expect(mockPrismaClient.webPage.update).toHaveBeenCalled();
      const updateCall = vi.mocked(mockPrismaClient.webPage.update).mock.calls[0];
      const data = updateCall?.[0]?.data;

      expect(data?.analysisCompletedAt).toBeDefined();
      const completedAt = new Date(data?.analysisCompletedAt as Date);
      expect(completedAt.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(completedAt.getTime()).toBeLessThanOrEqual(afterCall.getTime());
    });

    it('部分成功時（overallSuccess=false）はcompletedにしない', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await handler.markAnalysisCompleted(false);

      const updateCall = vi.mocked(mockPrismaClient.webPage.update).mock.calls[0];
      const data = updateCall?.[0]?.data;

      // 部分成功時はcompletedではなく、最後に成功したフェーズのステータスを維持
      expect(data?.analysisPhaseStatus).not.toBe('completed');
    });

    it('部分成功時でもanalysisCompletedAtは設定される', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await handler.markAnalysisCompleted(false);

      const updateCall = vi.mocked(mockPrismaClient.webPage.update).mock.calls[0];
      const data = updateCall?.[0]?.data;

      expect(data?.analysisCompletedAt).toBeDefined();
    });
  });

  // ---------------------------------------------------
  // markAnalysisFailed テスト
  // ---------------------------------------------------
  describe('markAnalysisFailed', () => {
    it('失敗時にanalysisPhaseStatusをfailedに設定', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await handler.markAnalysisFailed('Analysis failed due to timeout');

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'failed',
        }),
      });
    });

    it('失敗時にanalysisErrorが設定される', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      const errorMessage = 'Timeout after 30 seconds';
      await handler.markAnalysisFailed(errorMessage);

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisError: errorMessage,
        }),
      });
    });

    it('失敗時にanalysisCompletedAtが設定される', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await handler.markAnalysisFailed('Error occurred');

      const updateCall = vi.mocked(mockPrismaClient.webPage.update).mock.calls[0];
      const data = updateCall?.[0]?.data;

      expect(data?.analysisCompletedAt).toBeDefined();
    });
  });

  // ---------------------------------------------------
  // 部分成功シナリオテスト
  // ---------------------------------------------------
  describe('部分成功シナリオ', () => {
    it('Layoutのみ成功してMotionで失敗した場合の状態確認', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      // 分析開始
      await handler.markAnalysisStarted();
      vi.mocked(mockPrismaClient.webPage.update).mockClear();

      // Layout成功
      const layoutResult = createSuccessPhaseResult('layout', { sectionCount: 5 });
      await handler.commitPhaseResult('layout', layoutResult);

      // layout_done に更新されていることを確認
      expect(mockPrismaClient.webPage.update).toHaveBeenLastCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'layout_done',
          lastAnalyzedPhase: 'layout',
        }),
      });

      vi.mocked(mockPrismaClient.webPage.update).mockClear();

      // Motion失敗（更新しない）
      const motionResult = createFailedPhaseResult('motion', 'Timeout', true);
      await handler.commitPhaseResult('motion', motionResult);

      // 失敗時は更新されない
      expect(mockPrismaClient.webPage.update).not.toHaveBeenCalled();

      vi.mocked(mockPrismaClient.webPage.update).mockClear();

      // 部分成功として完了
      await handler.markAnalysisCompleted(false);

      // completedではなく、部分成功状態で完了
      const updateCall = vi.mocked(mockPrismaClient.webPage.update).mock.calls[0];
      expect(updateCall?.[0]?.data?.analysisPhaseStatus).not.toBe('completed');
      expect(updateCall?.[0]?.data?.analysisCompletedAt).toBeDefined();
    });

    it('Layout成功、Motion成功、Quality失敗の場合', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await handler.markAnalysisStarted();
      vi.mocked(mockPrismaClient.webPage.update).mockClear();

      // Layout成功
      await handler.commitPhaseResult(
        'layout',
        createSuccessPhaseResult('layout', { sectionCount: 5 })
      );
      expect(mockPrismaClient.webPage.update).toHaveBeenLastCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'layout_done',
        }),
      });

      vi.mocked(mockPrismaClient.webPage.update).mockClear();

      // Motion成功
      await handler.commitPhaseResult(
        'motion',
        createSuccessPhaseResult('motion', { patternCount: 3 })
      );
      expect(mockPrismaClient.webPage.update).toHaveBeenLastCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'motion_done',
        }),
      });

      vi.mocked(mockPrismaClient.webPage.update).mockClear();

      // Quality失敗（更新しない）
      await handler.commitPhaseResult(
        'quality',
        createFailedPhaseResult('quality', 'Quality evaluation failed')
      );
      expect(mockPrismaClient.webPage.update).not.toHaveBeenCalled();

      vi.mocked(mockPrismaClient.webPage.update).mockClear();

      // 部分成功として完了
      await handler.markAnalysisCompleted(false);
      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisCompletedAt: expect.any(Date),
        }),
      });
    });

    it('全フェーズ成功の場合', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await handler.markAnalysisStarted();
      vi.mocked(mockPrismaClient.webPage.update).mockClear();

      // Layout成功
      await handler.commitPhaseResult(
        'layout',
        createSuccessPhaseResult('layout', { sectionCount: 5 })
      );

      // Motion成功
      await handler.commitPhaseResult(
        'motion',
        createSuccessPhaseResult('motion', { patternCount: 3 })
      );

      // Quality成功
      await handler.commitPhaseResult(
        'quality',
        createSuccessPhaseResult('quality', { overallScore: 85 })
      );

      vi.mocked(mockPrismaClient.webPage.update).mockClear();

      // 完全成功として完了
      await handler.markAnalysisCompleted(true);

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'completed',
          analysisCompletedAt: expect.any(Date),
        }),
      });
    });
  });

  // ---------------------------------------------------
  // エラーハンドリングテスト
  // ---------------------------------------------------
  describe('エラーハンドリング', () => {
    it('DB更新失敗時にエラーがスローされる', async () => {
      mockPrismaClient.webPage.update = vi.fn().mockRejectedValue(new Error('DB connection failed'));

      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await expect(handler.markAnalysisStarted()).rejects.toThrow('DB connection failed');
    });

    it('無効なwebPageIdでの更新はエラー', async () => {
      mockPrismaClient.webPage.update = vi.fn().mockRejectedValue(new Error('Record not found'));

      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId: 'invalid-uuid',
      });

      await expect(handler.markAnalysisStarted()).rejects.toThrow('Record not found');
    });
  });

  // ---------------------------------------------------
  // analysisStatus との連携テスト（後方互換性）
  // ---------------------------------------------------
  describe('analysisStatus との連携（後方互換性）', () => {
    it('markAnalysisStarted で analysisStatus も processing に更新', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await handler.markAnalysisStarted();

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisStatus: 'processing',
        }),
      });
    });

    it('markAnalysisCompleted(true) で analysisStatus も completed に更新', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await handler.markAnalysisCompleted(true);

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisStatus: 'completed',
        }),
      });
    });

    it('markAnalysisFailed で analysisStatus も failed に更新', async () => {
      const handler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      await handler.markAnalysisFailed('Error');

      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisStatus: 'failed',
        }),
      });
    });
  });
});
