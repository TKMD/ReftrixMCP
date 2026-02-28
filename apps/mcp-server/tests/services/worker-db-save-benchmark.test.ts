// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker DB Save - Quality Benchmark Tests
 *
 * Tests for saveQualityBenchmarks function:
 * - ページ全体の品質評価結果をquality_benchmarksに保存（web_page_id設定）
 * - セクション単位の品質評価結果をquality_benchmarksに保存（section_pattern_id設定）
 * - axis_scoresのJSON保存
 * - クリーンスレート（deleteMany → createMany）
 * - Graceful Degradation（保存失敗時もジョブは継続）
 * - UUIDv7生成
 * - 空配列/データなしの場合のハンドリング
 *
 * @module tests/services/worker-db-save-benchmark
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveQualityBenchmarks,
  type QualityBenchmarkPrismaClient,
  type QualityBenchmarkInput,
} from '../../src/services/worker-db-save.service';

// =====================================================
// Mock Helpers
// =====================================================

/**
 * テスト用のMock Prismaクライアントを生成
 */
function createMockPrisma(
  overrides?: Partial<QualityBenchmarkPrismaClient['qualityBenchmark']>
): QualityBenchmarkPrismaClient {
  return {
    qualityBenchmark: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      ...overrides,
    },
  };
}

/**
 * ページ全体の品質ベンチマーク入力データを生成
 */
function createPageBenchmarkInput(
  overrides?: Partial<QualityBenchmarkInput>
): QualityBenchmarkInput {
  return {
    sectionType: 'full_page',
    overallScore: 88,
    grade: 'A',
    axisScores: {
      originality: 85,
      craftsmanship: 90,
      contextuality: 87,
    },
    sourceUrl: 'https://example.com',
    sourceType: 'page_analyze',
    ...overrides,
  };
}

/**
 * セクション単位の品質ベンチマーク入力データを生成
 */
function createSectionBenchmarkInput(
  overrides?: Partial<QualityBenchmarkInput>
): QualityBenchmarkInput {
  return {
    sectionType: 'hero',
    overallScore: 92,
    grade: 'A',
    axisScores: {
      originality: 90,
      craftsmanship: 94,
      contextuality: 91,
    },
    sourceUrl: 'https://example.com',
    sourceType: 'page_analyze',
    sectionPatternId: 'section-pattern-uuid-001',
    characteristics: ['gradient-background', 'bold-typography', 'asymmetric-layout'],
    htmlSnippet: '<section class="hero"><h1>Hello</h1></section>',
    ...overrides,
  };
}

// =====================================================
// Tests
// =====================================================

describe('saveQualityBenchmarks', () => {
  const webPageId = 'test-web-page-id-001';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------
  // 正常保存: ページ全体
  // -------------------------------------------------
  describe('ページ全体の品質ベンチマーク保存', () => {
    it('should save page-level benchmark with web_page_id and return SaveResult', async () => {
      const mockPrisma = createMockPrisma();
      const input = createPageBenchmarkInput();

      const result = await saveQualityBenchmarks(
        mockPrisma,
        webPageId,
        [input]
      );

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.ids).toHaveLength(1);
      expect(typeof result.ids[0]).toBe('string');
    });

    it('should set web_page_id on page-level benchmark data', async () => {
      const mockPrisma = createMockPrisma();
      const input = createPageBenchmarkInput();

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.webPageId).toBe(webPageId);
      // page-levelではsectionPatternIdはnullまたはundefined
      expect(data.sectionPatternId).toBeUndefined();
    });

    it('should use UUIDv7 for the generated id', async () => {
      const mockPrisma = createMockPrisma();
      const input = createPageBenchmarkInput();

      const result = await saveQualityBenchmarks(
        mockPrisma,
        webPageId,
        [input]
      );

      // UUIDv7 format: 8-4-7xxx-4-12 hex chars
      expect(result.ids[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('should store axis_scores as JSON object', async () => {
      const mockPrisma = createMockPrisma();
      const input = createPageBenchmarkInput({
        axisScores: {
          originality: 80,
          craftsmanship: 95,
          contextuality: 70,
        },
      });

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.axisScores).toEqual({
        originality: 80,
        craftsmanship: 95,
        contextuality: 70,
      });
    });

    it('should store overallScore and grade correctly', async () => {
      const mockPrisma = createMockPrisma();
      const input = createPageBenchmarkInput({
        overallScore: 91,
        grade: 'A',
      });

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.overallScore).toBe(91);
      expect(data.grade).toBe('A');
    });

    it('should store sourceUrl and sourceType correctly', async () => {
      const mockPrisma = createMockPrisma();
      const input = createPageBenchmarkInput({
        sourceUrl: 'https://awwwards.com/site/example',
        sourceType: 'award_gallery',
      });

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.sourceUrl).toBe('https://awwwards.com/site/example');
      expect(data.sourceType).toBe('award_gallery');
    });
  });

  // -------------------------------------------------
  // 正常保存: セクション単位
  // -------------------------------------------------
  describe('セクション単位の品質ベンチマーク保存', () => {
    it('should save section-level benchmark with section_pattern_id', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSectionBenchmarkInput();

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.sectionPatternId).toBe('section-pattern-uuid-001');
      expect(data.webPageId).toBe(webPageId);
    });

    it('should store characteristics array', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSectionBenchmarkInput({
        characteristics: ['dark-theme', 'hero-video', 'full-width'],
      });

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.characteristics).toEqual(['dark-theme', 'hero-video', 'full-width']);
    });

    it('should store htmlSnippet when provided', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSectionBenchmarkInput({
        htmlSnippet: '<section><h1>Quality Hero</h1></section>',
      });

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.htmlSnippet).toBe('<section><h1>Quality Hero</h1></section>');
    });

    it('should store industry and audience when provided', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSectionBenchmarkInput({
        industry: 'technology',
        audience: 'enterprise',
      });

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.industry).toBe('technology');
      expect(data.audience).toBe('enterprise');
    });

    it('should store sectionType for section-level benchmarks', async () => {
      const mockPrisma = createMockPrisma();
      const input = createSectionBenchmarkInput({
        sectionType: 'cta',
      });

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.sectionType).toBe('cta');
    });
  });

  // -------------------------------------------------
  // 複数ベンチマーク保存
  // -------------------------------------------------
  describe('複数ベンチマーク一括保存', () => {
    it('should save multiple benchmarks in a single createMany call', async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 3 }),
      });
      const inputs = [
        createPageBenchmarkInput({ overallScore: 88 }),
        createSectionBenchmarkInput({ sectionType: 'hero', overallScore: 92 }),
        createSectionBenchmarkInput({ sectionType: 'cta', overallScore: 86, sectionPatternId: 'section-pattern-uuid-002' }),
      ];

      const result = await saveQualityBenchmarks(
        mockPrisma,
        webPageId,
        inputs
      );

      expect(result.success).toBe(true);
      expect(result.count).toBe(3);
      expect(result.ids).toHaveLength(3);
      // 各IDがユニークであること
      const uniqueIds = new Set(result.ids);
      expect(uniqueIds.size).toBe(3);
    });

    it('should generate unique UUIDv7 for each benchmark', async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      });
      const inputs = [
        createPageBenchmarkInput(),
        createSectionBenchmarkInput(),
      ];

      const result = await saveQualityBenchmarks(
        mockPrisma,
        webPageId,
        inputs
      );

      expect(result.ids[0]).not.toBe(result.ids[1]);
      // 両方ともUUIDv7形式
      for (const id of result.ids) {
        expect(id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
      }
    });
  });

  // -------------------------------------------------
  // クリーンスレート
  // -------------------------------------------------
  describe('クリーンスレート（deleteMany → createMany）', () => {
    it('should delete existing benchmarks for the web_page_id before creating', async () => {
      const mockPrisma = createMockPrisma({
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      });
      const input = createPageBenchmarkInput();

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      expect(mockPrisma.qualityBenchmark.deleteMany).toHaveBeenCalledWith({
        where: { webPageId },
      });
      // deleteManyがcreateMany前に呼ばれていること
      const deleteManyOrder = (
        mockPrisma.qualityBenchmark.deleteMany as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0];
      const createManyOrder = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0];
      expect(deleteManyOrder).toBeLessThan(createManyOrder!);
    });
  });

  // -------------------------------------------------
  // 空配列/データなし
  // -------------------------------------------------
  describe('空配列/データなしのハンドリング', () => {
    it('should return success with count 0 when benchmarks array is empty', async () => {
      const mockPrisma = createMockPrisma();

      const result = await saveQualityBenchmarks(
        mockPrisma,
        webPageId,
        []
      );

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
      expect(result.ids).toHaveLength(0);
      // createManyは呼ばれない
      expect(mockPrisma.qualityBenchmark.createMany).not.toHaveBeenCalled();
      // deleteManyも呼ばれない（空の場合は何もしない）
      expect(mockPrisma.qualityBenchmark.deleteMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------
  // オプショナルフィールドのハンドリング
  // -------------------------------------------------
  describe('オプショナルフィールドのハンドリング', () => {
    it('should handle missing characteristics (defaults to empty array)', async () => {
      const mockPrisma = createMockPrisma();
      const input = createPageBenchmarkInput();
      // characteristicsを明示的に設定しない

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.characteristics).toEqual([]);
    });

    it('should handle missing industry and audience (null)', async () => {
      const mockPrisma = createMockPrisma();
      const input = createPageBenchmarkInput();
      // industry/audience未設定

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.industry).toBeNull();
      expect(data.audience).toBeNull();
    });

    it('should handle missing htmlSnippet (null)', async () => {
      const mockPrisma = createMockPrisma();
      const input = createPageBenchmarkInput();

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.htmlSnippet).toBeNull();
    });

    it('should handle missing previewUrl (null)', async () => {
      const mockPrisma = createMockPrisma();
      const input = createPageBenchmarkInput();

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.previewUrl).toBeNull();
    });

    it('should store previewUrl when provided', async () => {
      const mockPrisma = createMockPrisma();
      const input = createPageBenchmarkInput({
        previewUrl: 'https://screenshots.example.com/page1.png',
      });

      await saveQualityBenchmarks(mockPrisma, webPageId, [input]);

      const createCall = (
        mockPrisma.qualityBenchmark.createMany as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      const data = createCall.data[0];
      expect(data.previewUrl).toBe('https://screenshots.example.com/page1.png');
    });
  });

  // -------------------------------------------------
  // Graceful Degradation
  // -------------------------------------------------
  describe('Graceful Degradation', () => {
    it('should return success:false when Prisma createMany throws', async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      });
      const input = createPageBenchmarkInput();

      const result = await saveQualityBenchmarks(
        mockPrisma,
        webPageId,
        [input]
      );

      expect(result.success).toBe(false);
      expect(result.count).toBe(0);
      expect(result.ids).toHaveLength(0);
      expect(result.error).toContain('DB connection failed');
    });

    it('should return success:false when Prisma deleteMany throws', async () => {
      const mockPrisma = createMockPrisma({
        deleteMany: vi.fn().mockRejectedValue(new Error('Delete failed')),
      });
      const input = createPageBenchmarkInput();

      const result = await saveQualityBenchmarks(
        mockPrisma,
        webPageId,
        [input]
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Delete failed');
    });

    it('should return generic error message for non-Error throws', async () => {
      const mockPrisma = createMockPrisma({
        createMany: vi.fn().mockRejectedValue('string error'),
      });
      const input = createPageBenchmarkInput();

      const result = await saveQualityBenchmarks(
        mockPrisma,
        webPageId,
        [input]
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to save quality benchmarks');
    });
  });

  // -------------------------------------------------
  // idMappingの検証
  // -------------------------------------------------
  describe('idMapping', () => {
    it('should return empty idMapping (benchmarks do not have original IDs to map)', async () => {
      const mockPrisma = createMockPrisma();
      const input = createPageBenchmarkInput();

      const result = await saveQualityBenchmarks(
        mockPrisma,
        webPageId,
        [input]
      );

      expect(result.idMapping).toBeInstanceOf(Map);
      expect(result.idMapping.size).toBe(0);
    });
  });
});
