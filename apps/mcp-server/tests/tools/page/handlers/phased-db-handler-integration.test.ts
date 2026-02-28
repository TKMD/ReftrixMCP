// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PhasedDbHandler - PhasedExecutorとの統合テスト
 *
 * Phase2-2: PhasedDbHandlerがPhasedExecutorのonPhaseCompleteコールバック経由で
 * 正しく動作することを確認する統合テスト
 *
 * @module tests/tools/page/handlers/phased-db-handler-integration.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  PhasedDbHandler,
  type PhaseResult,
  type MinimalPrismaClient,
} from '../../../../src/tools/page/handlers/phased-db-handler';
import {
  PhasedExecutor,
  type PhasedExecutorOptions,
  type PhaseType,
} from '../../../../src/tools/page/handlers/phased-executor';
import { ExecutionStatusTracker } from '../../../../src/tools/page/handlers/timeout-utils';

// =====================================================
// モック用型定義
// =====================================================

interface MockPrismaClient extends MinimalPrismaClient {
  webPage: {
    update: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
}

// =====================================================
// モック用ヘルパー
// =====================================================

function createMockPrismaClient(): MockPrismaClient {
  const mockClient: MockPrismaClient = {
    webPage: {
      update: vi.fn().mockResolvedValue({ id: uuidv7() }),
    },
    $transaction: vi.fn(),
  };

  mockClient.$transaction = vi.fn().mockImplementation(async (fn: (tx: MockPrismaClient) => Promise<unknown>) => {
    return await fn(mockClient);
  });

  return mockClient;
}

// =====================================================
// 統合テストスイート
// =====================================================

describe('PhasedDbHandler + PhasedExecutor 統合テスト', () => {
  let mockPrismaClient: MockPrismaClient;
  let webPageId: string;
  let tracker: ExecutionStatusTracker;

  beforeEach(() => {
    vi.resetAllMocks();
    mockPrismaClient = createMockPrismaClient();
    webPageId = uuidv7();
    tracker = new ExecutionStatusTracker({
      originalTimeoutMs: 60000,
      effectiveTimeoutMs: 60000,
      strategy: 'progressive',
      partialResultsEnabled: true,
      webglDetected: false,
      timeoutExtended: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('PhasedExecutorのonPhaseComplete経由での統合', () => {
    it('各フェーズ完了時にPhasedDbHandlerのcommitPhaseResultが呼ばれる', async () => {
      const dbHandler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      // commitPhaseResultをスパイ
      const commitPhaseResultSpy = vi.spyOn(dbHandler, 'commitPhaseResult');

      // PhasedExecutor用のモックサービス
      const mockAnalyzeLayout = vi.fn().mockResolvedValue({
        success: true,
        sections: [{ id: 'section-1', type: 'hero' }],
      });
      const mockDetectMotion = vi.fn().mockResolvedValue({
        success: true,
        patterns: [{ id: 'pattern-1', type: 'css_animation' }],
      });
      const mockEvaluateQuality = vi.fn().mockResolvedValue({
        success: true,
        overallScore: 85,
        grade: 'A',
      });

      const executorOptions: PhasedExecutorOptions = {
        html: '<html><body><h1>Test</h1></body></html>',
        url: 'https://example.com',
        features: { layout: true, motion: true, quality: true },
        phaseTimeouts: { layout: 30000, motion: 20000, quality: 10000 },
        tracker,
        analyzeLayout: mockAnalyzeLayout,
        detectMotion: mockDetectMotion,
        evaluateQuality: mockEvaluateQuality,
        onPhaseComplete: async (phase: PhaseType, result: PhaseResult<unknown>) => {
          // PhasedDbHandler経由でDB更新
          await dbHandler.commitPhaseResult(phase, result);
        },
      };

      const executor = new PhasedExecutor(executorOptions);
      const result = await executor.execute();

      // 全フェーズ成功を確認
      expect(result.overallSuccess).toBe(true);
      expect(result.completedPhases).toEqual(['layout', 'motion', 'quality']);

      // commitPhaseResultが3回（各フェーズで1回）呼ばれた
      expect(commitPhaseResultSpy).toHaveBeenCalledTimes(3);

      // 各フェーズの呼び出し確認
      expect(commitPhaseResultSpy).toHaveBeenNthCalledWith(
        1,
        'layout',
        expect.objectContaining({ success: true, phase: 'layout' })
      );
      expect(commitPhaseResultSpy).toHaveBeenNthCalledWith(
        2,
        'motion',
        expect.objectContaining({ success: true, phase: 'motion' })
      );
      expect(commitPhaseResultSpy).toHaveBeenNthCalledWith(
        3,
        'quality',
        expect.objectContaining({ success: true, phase: 'quality' })
      );
    });

    it('フェーズ失敗時はcommitPhaseResultが呼ばれるがDB更新はスキップ', async () => {
      const dbHandler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      // Layout成功、Motion失敗、Quality成功のシナリオ
      const mockAnalyzeLayout = vi.fn().mockResolvedValue({
        success: true,
        sections: [{ id: 'section-1', type: 'hero' }],
      });
      const mockDetectMotion = vi.fn().mockRejectedValue(new Error('Motion detection timeout'));
      const mockEvaluateQuality = vi.fn().mockResolvedValue({
        success: true,
        overallScore: 85,
        grade: 'A',
      });

      const executorOptions: PhasedExecutorOptions = {
        html: '<html><body><h1>Test</h1></body></html>',
        url: 'https://example.com',
        features: { layout: true, motion: true, quality: true },
        phaseTimeouts: { layout: 30000, motion: 20000, quality: 10000 },
        tracker,
        analyzeLayout: mockAnalyzeLayout,
        detectMotion: mockDetectMotion,
        evaluateQuality: mockEvaluateQuality,
        onPhaseComplete: async (phase: PhaseType, result: PhaseResult<unknown>) => {
          // 成功時のみコールバックは呼ばれる（PhasedExecutorの仕様）
          await dbHandler.commitPhaseResult(phase, result);
        },
      };

      const executor = new PhasedExecutor(executorOptions);
      const result = await executor.execute();

      // 部分成功を確認
      expect(result.overallSuccess).toBe(false);
      expect(result.partialSuccess).toBe(true);
      expect(result.completedPhases).toEqual(['layout', 'quality']);
      expect(result.failedPhases).toEqual(['motion']);

      // Motion失敗時はonPhaseCompleteが呼ばれないため、DB更新は2回のみ
      expect(mockPrismaClient.webPage.update).toHaveBeenCalledTimes(2);

      // layout_done と quality_done のみ更新
      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'layout_done',
        }),
      });
      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'quality_done',
        }),
      });
    });

    it('フルフロー: 開始 -> 各フェーズ完了 -> 完了マーク', async () => {
      const dbHandler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      // 分析開始をマーク
      await dbHandler.markAnalysisStarted();

      // 開始時のDB更新を確認
      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'pending',
          analysisStatus: 'processing',
          analysisStartedAt: expect.any(Date),
          analysisError: null,
          lastAnalyzedPhase: null,
        }),
      });

      vi.mocked(mockPrismaClient.webPage.update).mockClear();

      // PhasedExecutor用のモックサービス
      const mockAnalyzeLayout = vi.fn().mockResolvedValue({
        success: true,
        sections: [{ id: 'section-1', type: 'hero' }],
      });
      const mockDetectMotion = vi.fn().mockResolvedValue({
        success: true,
        patterns: [{ id: 'pattern-1', type: 'css_animation' }],
      });
      const mockEvaluateQuality = vi.fn().mockResolvedValue({
        success: true,
        overallScore: 85,
        grade: 'A',
      });

      const executorOptions: PhasedExecutorOptions = {
        html: '<html><body><h1>Test</h1></body></html>',
        url: 'https://example.com',
        features: { layout: true, motion: true, quality: true },
        phaseTimeouts: { layout: 30000, motion: 20000, quality: 10000 },
        tracker,
        analyzeLayout: mockAnalyzeLayout,
        detectMotion: mockDetectMotion,
        evaluateQuality: mockEvaluateQuality,
        onPhaseComplete: async (phase: PhaseType, result: PhaseResult<unknown>) => {
          await dbHandler.commitPhaseResult(phase, result);
        },
      };

      const executor = new PhasedExecutor(executorOptions);
      const result = await executor.execute();

      // 全フェーズ成功
      expect(result.overallSuccess).toBe(true);

      // 各フェーズのDB更新（3回）
      expect(mockPrismaClient.webPage.update).toHaveBeenCalledTimes(3);

      vi.mocked(mockPrismaClient.webPage.update).mockClear();

      // 分析完了をマーク
      await dbHandler.markAnalysisCompleted(result.overallSuccess);

      // 完了時のDB更新
      expect(mockPrismaClient.webPage.update).toHaveBeenCalledWith({
        where: { id: webPageId },
        data: expect.objectContaining({
          analysisPhaseStatus: 'completed',
          analysisStatus: 'completed',
          analysisCompletedAt: expect.any(Date),
        }),
      });
    });

    it('部分成功フロー: Layout完了後にMotionで失敗', async () => {
      const dbHandler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      // 分析開始
      await dbHandler.markAnalysisStarted();
      vi.mocked(mockPrismaClient.webPage.update).mockClear();

      // Layout成功、Motionタイムアウト、Qualityスキップのシナリオ
      const mockAnalyzeLayout = vi.fn().mockResolvedValue({
        success: true,
        sections: [{ id: 'section-1', type: 'hero' }],
      });
      const mockDetectMotion = vi.fn().mockImplementation(async () => {
        // タイムアウトをシミュレート
        await new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 100)
        );
      });
      const mockEvaluateQuality = vi.fn().mockResolvedValue({
        success: true,
        overallScore: 75,
        grade: 'B',
      });

      const executorOptions: PhasedExecutorOptions = {
        html: '<html><body><h1>Test</h1></body></html>',
        url: 'https://example.com',
        features: { layout: true, motion: true, quality: true },
        phaseTimeouts: { layout: 30000, motion: 50, quality: 10000 }, // Motionを短いタイムアウトに
        tracker,
        analyzeLayout: mockAnalyzeLayout,
        detectMotion: mockDetectMotion,
        evaluateQuality: mockEvaluateQuality,
        onPhaseComplete: async (phase: PhaseType, result: PhaseResult<unknown>) => {
          await dbHandler.commitPhaseResult(phase, result);
        },
      };

      const executor = new PhasedExecutor(executorOptions);
      const result = await executor.execute();

      // 部分成功
      expect(result.overallSuccess).toBe(false);
      expect(result.partialSuccess).toBe(true);
      expect(result.completedPhases).toEqual(['layout', 'quality']);
      expect(result.failedPhases).toEqual(['motion']);

      // DB更新回数（Layout + Quality = 2回）
      expect(mockPrismaClient.webPage.update).toHaveBeenCalledTimes(2);

      vi.mocked(mockPrismaClient.webPage.update).mockClear();

      // 部分成功として完了マーク
      await dbHandler.markAnalysisCompleted(false);

      // 部分成功時のDB更新（completedではない）
      const updateCall = vi.mocked(mockPrismaClient.webPage.update).mock.calls[0];
      expect(updateCall?.[0]?.data).toMatchObject({
        analysisCompletedAt: expect.any(Date),
        analysisStatus: 'completed',
      });
      expect(updateCall?.[0]?.data?.analysisPhaseStatus).not.toBe('completed');
    });
  });

  describe('エラーハンドリング', () => {
    it('onPhaseCompleteコールバック内のDB更新失敗でも分析は継続', async () => {
      // DB更新を失敗させる
      mockPrismaClient.webPage.update = vi.fn().mockRejectedValue(new Error('DB write failed'));

      const dbHandler = new PhasedDbHandler({
        prisma: mockPrismaClient,
        webPageId,
      });

      const mockAnalyzeLayout = vi.fn().mockResolvedValue({
        success: true,
        sections: [{ id: 'section-1', type: 'hero' }],
      });
      const mockDetectMotion = vi.fn().mockResolvedValue({
        success: true,
        patterns: [{ id: 'pattern-1', type: 'css_animation' }],
      });
      const mockEvaluateQuality = vi.fn().mockResolvedValue({
        success: true,
        overallScore: 85,
        grade: 'A',
      });

      const executorOptions: PhasedExecutorOptions = {
        html: '<html><body><h1>Test</h1></body></html>',
        url: 'https://example.com',
        features: { layout: true, motion: true, quality: true },
        phaseTimeouts: { layout: 30000, motion: 20000, quality: 10000 },
        tracker,
        analyzeLayout: mockAnalyzeLayout,
        detectMotion: mockDetectMotion,
        evaluateQuality: mockEvaluateQuality,
        onPhaseComplete: async (phase: PhaseType, result: PhaseResult<unknown>) => {
          // PhasedExecutorはコールバックエラーを無視して継続する
          await dbHandler.commitPhaseResult(phase, result);
        },
      };

      const executor = new PhasedExecutor(executorOptions);
      const result = await executor.execute();

      // DB更新失敗にもかかわらず、分析自体は成功
      expect(result.overallSuccess).toBe(true);
      expect(result.completedPhases).toEqual(['layout', 'motion', 'quality']);

      // DB更新は3回試みられた
      expect(mockPrismaClient.webPage.update).toHaveBeenCalledTimes(3);
    });
  });
});
