// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker DB Save - Quality Evaluation Tests
 *
 * Tests for saveQualityEvaluation function:
 * - Normal save (clean slate: deleteMany → create)
 * - Prisma error graceful degradation
 * - Empty/missing data handling
 * - Correct field mapping (QualityServiceResult → QualityEvaluation DB)
 *
 * @module tests/services/worker-db-save-quality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveQualityEvaluation,
  type QualityEvaluationPrismaClient,
  type QualityEvaluationInput,
} from '../../src/services/worker-db-save.service';

// Mock Prisma client
function createMockPrisma(overrides?: Partial<QualityEvaluationPrismaClient['qualityEvaluation']>): QualityEvaluationPrismaClient {
  return {
    qualityEvaluation: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: 'mock-uuid' }),
      ...overrides,
    },
  };
}

// Sample quality result matching QualityServiceResult shape
function createSampleQualityInput(overrides?: Partial<QualityEvaluationInput>): QualityEvaluationInput {
  return {
    success: true,
    overallScore: 78,
    grade: 'B',
    axisScores: {
      originality: 72,
      craftsmanship: 82,
      contextuality: 76,
    },
    clicheCount: 2,
    processingTimeMs: 1500,
    ...overrides,
  };
}

describe('saveQualityEvaluation', () => {
  const webPageId = 'test-web-page-id-001';

  describe('正常保存', () => {
    it('should save quality evaluation to DB and return SaveResult', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSampleQualityInput();

      const result = await saveQualityEvaluation(mockPrisma, webPageId, input);

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.ids).toHaveLength(1);
      expect(typeof result.ids[0]).toBe('string');
    });

    it('should delete existing evaluations before creating new one (clean slate)', async () => {
      const mockPrisma = createMockPrisma({
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      });
      const input = createSampleQualityInput();

      await saveQualityEvaluation(mockPrisma, webPageId, input);

      expect(mockPrisma.qualityEvaluation.deleteMany).toHaveBeenCalledWith({
        where: { targetType: 'web_page', targetId: webPageId },
      });
    });

    it('should create with correct field mapping', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSampleQualityInput({
        overallScore: 85,
        grade: 'A',
        axisScores: {
          originality: 80,
          craftsmanship: 90,
          contextuality: 82,
        },
        clicheCount: 0,
      });

      await saveQualityEvaluation(mockPrisma, webPageId, input);

      const createCall = (mockPrisma.qualityEvaluation.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.data).toMatchObject({
        targetType: 'web_page',
        targetId: webPageId,
        overallScore: 85,
        grade: 'A',
      });
    });

    it('should use UUIDv7 for the generated id', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSampleQualityInput();

      const result = await saveQualityEvaluation(mockPrisma, webPageId, input);

      // UUIDv7 format: 8-4-4-4-12 hex chars
      expect(result.ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should include antiAiCliche JSON with axisScores and clicheCount', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSampleQualityInput({
        cliches: [
          { type: 'gradient_blob', description: 'Generic gradient blob', severity: 'high' as const },
        ],
      });

      await saveQualityEvaluation(mockPrisma, webPageId, input);

      const createCall = (mockPrisma.qualityEvaluation.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const antiAiCliche = createCall.data.antiAiCliche;
      expect(antiAiCliche).toBeDefined();
      expect(antiAiCliche.axisScores).toBeDefined();
      expect(antiAiCliche.clicheCount).toBeDefined();
    });

    it('should include designQuality JSON with axisDetails', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSampleQualityInput({
        axisDetails: {
          originality: ['Unique layout approach'],
          craftsmanship: ['Clean typography'],
          contextuality: ['Good industry fit'],
        },
      });

      await saveQualityEvaluation(mockPrisma, webPageId, input);

      const createCall = (mockPrisma.qualityEvaluation.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.data.designQuality).toBeDefined();
      expect(createCall.data.designQuality.axisDetails).toBeDefined();
    });

    it('should include recommendations as string array', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSampleQualityInput({
        recommendations: [
          { id: 'rec-1', category: 'design', priority: 'high' as const, title: 'Improve contrast', description: 'Increase text contrast ratio' },
          { id: 'rec-2', category: 'layout', priority: 'medium' as const, title: 'Add whitespace', description: 'More breathing room' },
        ],
      });

      await saveQualityEvaluation(mockPrisma, webPageId, input);

      const createCall = (mockPrisma.qualityEvaluation.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.data.recommendations).toBeInstanceOf(Array);
      expect(createCall.data.recommendations.length).toBe(2);
    });

    it('should set evaluatorVersion and evaluationMode', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSampleQualityInput();

      await saveQualityEvaluation(mockPrisma, webPageId, input, {
        strict: true,
        targetIndustry: 'technology',
        targetAudience: 'enterprise',
      });

      const createCall = (mockPrisma.qualityEvaluation.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.data.evaluatorVersion).toBeDefined();
      expect(typeof createCall.data.evaluatorVersion).toBe('string');
      expect(createCall.data.evaluationMode).toBe('strict');
    });

    it('should set evaluationMode to standard when strict is false', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSampleQualityInput();

      await saveQualityEvaluation(mockPrisma, webPageId, input, { strict: false });

      const createCall = (mockPrisma.qualityEvaluation.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.data.evaluationMode).toBe('standard');
    });

    it('should include evaluationContext with targetIndustry and targetAudience', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSampleQualityInput();

      await saveQualityEvaluation(mockPrisma, webPageId, input, {
        targetIndustry: 'technology',
        targetAudience: 'enterprise',
      });

      const createCall = (mockPrisma.qualityEvaluation.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.data.evaluationContext).toMatchObject({
        target_industry: 'technology',
        target_audience: 'enterprise',
      });
    });
  });

  describe('Graceful Degradation', () => {
    it('should return success:false when Prisma create throws', async () => {
      const mockPrisma = createMockPrisma({
        create: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      });
      const input = createSampleQualityInput();

      const result = await saveQualityEvaluation(mockPrisma, webPageId, input);

      expect(result.success).toBe(false);
      expect(result.count).toBe(0);
      expect(result.ids).toHaveLength(0);
      expect(result.error).toContain('DB connection failed');
    });

    it('should return success:false when Prisma deleteMany throws', async () => {
      const mockPrisma = createMockPrisma({
        deleteMany: vi.fn().mockRejectedValue(new Error('Delete failed')),
      });
      const input = createSampleQualityInput();

      const result = await saveQualityEvaluation(mockPrisma, webPageId, input);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Delete failed');
    });
  });
});
