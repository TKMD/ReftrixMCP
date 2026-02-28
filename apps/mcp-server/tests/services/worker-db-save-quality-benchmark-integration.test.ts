// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker DB Save - Quality Benchmark Integration Tests
 *
 * Tests for buildQualityBenchmarkInputs helper function
 * and the integration point in page-analyze-worker.ts
 * where saveQualityBenchmarks() is called after saveQualityEvaluation().
 *
 * Verifies:
 * - QualityServiceResult → QualityBenchmarkInput[] mapping
 * - Page-level benchmark (sectionType: 'full_page') generation
 * - axisScores mapping from quality result
 * - sourceUrl/sourceType propagation
 * - industry/audience from quality options
 * - Empty/error result handling
 *
 * @module tests/services/worker-db-save-quality-benchmark-integration
 */

import { describe, it, expect } from 'vitest';
import {
  buildQualityBenchmarkInputs,
  type QualityBenchmarkInput,
} from '../../src/services/worker-db-save.service';
import type { QualityServiceResult } from '../../src/tools/page/handlers/types';

// =====================================================
// Test Helpers
// =====================================================

/**
 * テスト用のQualityServiceResultを生成
 */
function createQualityResult(
  overrides?: Partial<QualityServiceResult>
): QualityServiceResult {
  return {
    success: true,
    // DB CHECK制約により overallScore >= 85 が必要
    overallScore: 92,
    grade: 'A',
    axisScores: {
      originality: 88,
      craftsmanship: 95,
      contextuality: 90,
    },
    clicheCount: 0,
    processingTimeMs: 1200,
    ...overrides,
  };
}

// =====================================================
// Tests
// =====================================================

describe('buildQualityBenchmarkInputs', () => {
  const sourceUrl = 'https://example.com';

  // -------------------------------------------------
  // 基本: ページ全体ベンチマーク生成
  // -------------------------------------------------
  describe('ページ全体ベンチマーク生成', () => {
    it('should create a single full_page benchmark from QualityServiceResult', () => {
      const qualityResult = createQualityResult();

      const benchmarks = buildQualityBenchmarkInputs(qualityResult, sourceUrl);

      expect(benchmarks).toHaveLength(1);
      expect(benchmarks[0].sectionType).toBe('full_page');
    });

    it('should map overallScore and grade correctly', () => {
      const qualityResult = createQualityResult({
        overallScore: 91,
        grade: 'A',
      });

      const benchmarks = buildQualityBenchmarkInputs(qualityResult, sourceUrl);

      expect(benchmarks[0].overallScore).toBe(91);
      expect(benchmarks[0].grade).toBe('A');
    });

    it('should map axisScores correctly', () => {
      const qualityResult = createQualityResult({
        axisScores: {
          originality: 90,
          craftsmanship: 95,
          contextuality: 88,
        },
      });

      const benchmarks = buildQualityBenchmarkInputs(qualityResult, sourceUrl);

      expect(benchmarks[0].axisScores).toEqual({
        originality: 90,
        craftsmanship: 95,
        contextuality: 88,
      });
    });

    it('should set sourceUrl from parameter', () => {
      const qualityResult = createQualityResult();

      const benchmarks = buildQualityBenchmarkInputs(
        qualityResult,
        'https://awwwards.com/site/test'
      );

      expect(benchmarks[0].sourceUrl).toBe('https://awwwards.com/site/test');
    });

    it('should set sourceType to page_analyze by default', () => {
      const qualityResult = createQualityResult();

      const benchmarks = buildQualityBenchmarkInputs(qualityResult, sourceUrl);

      expect(benchmarks[0].sourceType).toBe('page_analyze');
    });
  });

  // -------------------------------------------------
  // industry/audience オプション
  // -------------------------------------------------
  describe('industry/audience オプション', () => {
    it('should set industry when provided in options', () => {
      const qualityResult = createQualityResult();

      const benchmarks = buildQualityBenchmarkInputs(
        qualityResult,
        sourceUrl,
        { targetIndustry: 'technology' }
      );

      expect(benchmarks[0].industry).toBe('technology');
    });

    it('should set audience when provided in options', () => {
      const qualityResult = createQualityResult();

      const benchmarks = buildQualityBenchmarkInputs(
        qualityResult,
        sourceUrl,
        { targetAudience: 'enterprise' }
      );

      expect(benchmarks[0].audience).toBe('enterprise');
    });

    it('should leave industry undefined when not provided', () => {
      const qualityResult = createQualityResult();

      const benchmarks = buildQualityBenchmarkInputs(qualityResult, sourceUrl);

      expect(benchmarks[0].industry).toBeUndefined();
    });

    it('should leave audience undefined when not provided', () => {
      const qualityResult = createQualityResult();

      const benchmarks = buildQualityBenchmarkInputs(qualityResult, sourceUrl);

      expect(benchmarks[0].audience).toBeUndefined();
    });
  });

  // -------------------------------------------------
  // characteristics 生成
  // -------------------------------------------------
  describe('characteristics 生成', () => {
    it('should generate characteristics from axisDetails when available', () => {
      const qualityResult = createQualityResult({
        axisDetails: {
          originality: ['unique-layout', 'custom-typography'],
          craftsmanship: ['clean-code', 'responsive'],
          contextuality: ['industry-appropriate'],
        },
      });

      const benchmarks = buildQualityBenchmarkInputs(qualityResult, sourceUrl);

      // axisDetails の全値をフラットにしたもの
      expect(benchmarks[0].characteristics).toEqual(
        expect.arrayContaining([
          'unique-layout',
          'custom-typography',
          'clean-code',
          'responsive',
          'industry-appropriate',
        ])
      );
    });

    it('should return empty characteristics when axisDetails is undefined', () => {
      const qualityResult = createQualityResult();
      // axisDetails未設定

      const benchmarks = buildQualityBenchmarkInputs(qualityResult, sourceUrl);

      expect(benchmarks[0].characteristics).toEqual([]);
    });
  });

  // -------------------------------------------------
  // エラー/失敗結果のハンドリング
  // -------------------------------------------------
  describe('エラー/失敗結果のハンドリング', () => {
    it('should return empty array when qualityResult.success is false', () => {
      const qualityResult = createQualityResult({
        success: false,
        error: { code: 'ANALYSIS_FAILED', message: 'Quality analysis failed' },
      });

      const benchmarks = buildQualityBenchmarkInputs(qualityResult, sourceUrl);

      expect(benchmarks).toHaveLength(0);
    });

    it('should return empty array when overallScore is 0', () => {
      const qualityResult = createQualityResult({
        overallScore: 0,
        grade: 'F',
      });

      const benchmarks = buildQualityBenchmarkInputs(qualityResult, sourceUrl);

      expect(benchmarks).toHaveLength(0);
    });
  });

  // -------------------------------------------------
  // 型安全性の検証
  // -------------------------------------------------
  describe('型安全性', () => {
    it('should return QualityBenchmarkInput[] compatible type', () => {
      const qualityResult = createQualityResult();

      const benchmarks: QualityBenchmarkInput[] = buildQualityBenchmarkInputs(
        qualityResult,
        sourceUrl
      );

      // 型チェック: QualityBenchmarkInputの必須フィールドが全て存在
      const benchmark = benchmarks[0];
      expect(typeof benchmark.sectionType).toBe('string');
      expect(typeof benchmark.overallScore).toBe('number');
      expect(typeof benchmark.grade).toBe('string');
      expect(typeof benchmark.axisScores.originality).toBe('number');
      expect(typeof benchmark.axisScores.craftsmanship).toBe('number');
      expect(typeof benchmark.axisScores.contextuality).toBe('number');
      expect(typeof benchmark.sourceUrl).toBe('string');
      expect(typeof benchmark.sourceType).toBe('string');
    });
  });
});
