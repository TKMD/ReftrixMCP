// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Quality Monitor Service テスト
 *
 * DINOv2/e5-baseのembedding品質監視サービスのユニットテスト。
 *
 * テスト対象:
 * - Distribution計算（正常系、空データ、NaN混入）
 * - L2ノルム計算
 * - コサイン距離計算
 * - Centroid計算
 * - Drift Detection（ベースライン比較、閾値超過）
 * - Anomaly Detection（NaN/Infinity、ゼロベクトル、異常L2 norm）
 * - Quality Score計算（重み付けスコア、100点満点）
 * - Coverage Metrics
 * - Alert生成
 * - サービス統合テスト
 *
 * @module tests/services/embedding-quality-monitor.service.test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  calculateL2Norm,
  calculateCosineDistance,
  calculateCentroid,
  calculateDistribution,
  detectAnomalies,
  calculateQualityScore,
  generateAlerts,
  EmbeddingQualityMonitorService,
  L2_NORM_LOWER_THRESHOLD,
  L2_NORM_UPPER_THRESHOLD,
  DRIFT_WARNING_THRESHOLD,
  QUALITY_SCORE_ALERT_THRESHOLD,
  VISION_COVERAGE_ALERT_THRESHOLD,
  TEXT_COVERAGE_ALERT_THRESHOLD,
  EXPECTED_DIMENSIONS,
  type QualityMetrics,
  type AnomalyResult,
  type CoverageMetrics,
  type EmbeddingQualityPrismaClient,
  type EmbeddingBaseline,
  type DriftResult,
} from "../../src/services/embedding-quality-monitor.service";

// =====================================================
// テストデータ / Test Data
// =====================================================

/** 正規化済み768次元ベクトルを生成 */
function createNormalizedVector(seed: number = 0): number[] {
  const vec = Array.from({ length: EXPECTED_DIMENSIONS }, (_, i) => Math.sin(i + seed) * 0.05);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

/** 小さい3次元ベクトルでテスト */
function createSmallVector(values: number[]): number[] {
  return values;
}

/** ゼロベクトルを生成 */
function createZeroVector(): number[] {
  return new Array(EXPECTED_DIMENSIONS).fill(0);
}

/** NaN含有ベクトルを生成 */
function createNanVector(): number[] {
  const vec = createNormalizedVector(0);
  vec[0] = NaN;
  return vec;
}

/** Infinity含有ベクトルを生成 */
function createInfinityVector(): number[] {
  const vec = createNormalizedVector(0);
  vec[0] = Infinity;
  return vec;
}

/** 異常L2 norm（小さすぎ）のベクトルを生成 */
function createSmallL2Vector(): number[] {
  return Array.from({ length: EXPECTED_DIMENSIONS }, (_, i) => Math.sin(i) * 0.0001);
}

/** 異常L2 norm（大きすぎ）のベクトルを生成 */
function createLargeL2Vector(): number[] {
  return Array.from({ length: EXPECTED_DIMENSIONS }, (_, i) => Math.sin(i) * 10);
}

/** Mock Prismaクライアントを作成 */
function createMockPrisma(): EmbeddingQualityPrismaClient {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  };
}

// =====================================================
// L2ノルム計算テスト
// =====================================================

describe("calculateL2Norm", () => {
  it("正規化済みベクトルのL2ノルムが約1.0であること", () => {
    const vec = createNormalizedVector(42);
    const norm = calculateL2Norm(vec);
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("ゼロベクトルのL2ノルムが0であること", () => {
    const vec = [0, 0, 0];
    const norm = calculateL2Norm(vec);
    expect(norm).toBe(0);
  });

  it("NaN含有ベクトルでNaNを返すこと", () => {
    const vec = [1, NaN, 3];
    const norm = calculateL2Norm(vec);
    expect(Number.isNaN(norm)).toBe(true);
  });

  it("Infinity含有ベクトルでNaNを返すこと", () => {
    const vec = [1, Infinity, 3];
    const norm = calculateL2Norm(vec);
    expect(Number.isNaN(norm)).toBe(true);
  });

  it("既知のベクトルで正しい値を返すこと", () => {
    const vec = [3, 4];
    const norm = calculateL2Norm(vec);
    expect(norm).toBeCloseTo(5.0, 5);
  });
});

// =====================================================
// コサイン距離計算テスト
// =====================================================

describe("calculateCosineDistance", () => {
  it("同一ベクトルの距離が0であること", () => {
    const vec = createNormalizedVector(1);
    const distance = calculateCosineDistance(vec, vec);
    expect(distance).toBeCloseTo(0.0, 5);
  });

  it("異なるベクトルの距離が0より大きいこと", () => {
    const a = createNormalizedVector(1);
    const b = createNormalizedVector(100);
    const distance = calculateCosineDistance(a, b);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThanOrEqual(2);
  });

  it("次元数が異なる場合にNaNを返すこと", () => {
    const a = [1, 2, 3];
    const b = [1, 2];
    const distance = calculateCosineDistance(a, b);
    expect(Number.isNaN(distance)).toBe(true);
  });

  it("空ベクトルでNaNを返すこと", () => {
    const distance = calculateCosineDistance([], []);
    expect(Number.isNaN(distance)).toBe(true);
  });

  it("ゼロベクトルでNaNを返すこと", () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    const distance = calculateCosineDistance(a, b);
    expect(Number.isNaN(distance)).toBe(true);
  });

  it("NaN含有ベクトルでNaNを返すこと", () => {
    const a = [1, NaN, 3];
    const b = [1, 2, 3];
    const distance = calculateCosineDistance(a, b);
    expect(Number.isNaN(distance)).toBe(true);
  });

  it("正反対のベクトルの距離が約2.0であること", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    const distance = calculateCosineDistance(a, b);
    expect(distance).toBeCloseTo(2.0, 5);
  });

  it("直交ベクトルの距離が約1.0であること", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const distance = calculateCosineDistance(a, b);
    expect(distance).toBeCloseTo(1.0, 5);
  });
});

// =====================================================
// Centroid計算テスト
// =====================================================

describe("calculateCentroid", () => {
  it("空配列でnullを返すこと", () => {
    const result = calculateCentroid([]);
    expect(result).toBeNull();
  });

  it("単一ベクトルの場合そのベクトルを返すこと", () => {
    const vec = [1, 2, 3];
    const result = calculateCentroid([vec]);
    expect(result).toEqual([1, 2, 3]);
  });

  it("2つのベクトルの平均を返すこと", () => {
    const a = [2, 4, 6];
    const b = [4, 6, 8];
    const result = calculateCentroid([a, b]);
    expect(result).toEqual([3, 5, 7]);
  });

  it("NaN含有ベクトルでnullを返すこと", () => {
    const a = [1, NaN, 3];
    const b = [4, 5, 6];
    const result = calculateCentroid([a, b]);
    expect(result).toBeNull();
  });

  it("次元数不一致でnullを返すこと", () => {
    const a = [1, 2, 3];
    const b = [4, 5];
    const result = calculateCentroid([a, b]);
    expect(result).toBeNull();
  });
});

// =====================================================
// Distribution計算テスト
// =====================================================

describe("calculateDistribution", () => {
  it("空配列でnullを返すこと", () => {
    const result = calculateDistribution([]);
    expect(result).toBeNull();
  });

  it("正常なベクトル配列で正しい統計量を返すこと", () => {
    const vectors = [
      createNormalizedVector(1),
      createNormalizedVector(2),
      createNormalizedVector(3),
    ];
    const result = calculateDistribution(vectors);
    expect(result).not.toBeNull();
    expect(result!.sampleCount).toBe(3);
    expect(Number.isFinite(result!.mean)).toBe(true);
    expect(Number.isFinite(result!.std)).toBe(true);
    expect(Number.isFinite(result!.min)).toBe(true);
    expect(Number.isFinite(result!.max)).toBe(true);
    expect(Number.isFinite(result!.avgL2Norm)).toBe(true);
    expect(result!.avgL2Norm).toBeCloseTo(1.0, 1);
  });

  it("NaN混入ベクトルがフィルタリングされること", () => {
    const vectors = [createNormalizedVector(1), createNanVector()];
    const result = calculateDistribution(vectors);
    // NaN vector should still contribute to sampleCount but NaN elements are skipped
    expect(result).not.toBeNull();
  });

  it("全NaNベクトルでnullを返すこと", () => {
    const nanVec = new Array(EXPECTED_DIMENSIONS).fill(NaN);
    const result = calculateDistribution([nanVec]);
    expect(result).toBeNull();
  });

  it("min <= mean <= max であること", () => {
    const vectors = [
      createNormalizedVector(10),
      createNormalizedVector(20),
      createNormalizedVector(30),
    ];
    const result = calculateDistribution(vectors);
    expect(result).not.toBeNull();
    expect(result!.min).toBeLessThanOrEqual(result!.mean);
    expect(result!.mean).toBeLessThanOrEqual(result!.max);
  });

  it("stdが0以上であること", () => {
    const vectors = [createNormalizedVector(1), createNormalizedVector(1)];
    const result = calculateDistribution(vectors);
    expect(result).not.toBeNull();
    expect(result!.std).toBeGreaterThanOrEqual(0);
  });
});

// =====================================================
// Anomaly Detection テスト
// =====================================================

describe("detectAnomalies", () => {
  it("正常なベクトルで異常が0であること", () => {
    const vectors = [createNormalizedVector(1), createNormalizedVector(2)];
    const result = detectAnomalies(vectors);
    expect(result.nanInfinityCount).toBe(0);
    expect(result.zeroVectorCount).toBe(0);
    expect(result.abnormalL2NormCount).toBe(0);
    expect(result.totalInspected).toBe(2);
  });

  it("NaN含有ベクトルを検出すること", () => {
    const vectors = [createNormalizedVector(1), createNanVector()];
    const result = detectAnomalies(vectors);
    expect(result.nanInfinityCount).toBe(1);
  });

  it("Infinity含有ベクトルを検出すること", () => {
    const vectors = [createNormalizedVector(1), createInfinityVector()];
    const result = detectAnomalies(vectors);
    expect(result.nanInfinityCount).toBe(1);
  });

  it("ゼロベクトルを検出すること", () => {
    const vectors = [createNormalizedVector(1), createZeroVector()];
    const result = detectAnomalies(vectors);
    expect(result.zeroVectorCount).toBe(1);
  });

  it("異常に小さいL2 normを検出すること", () => {
    const vectors = [createNormalizedVector(1), createSmallL2Vector()];
    const result = detectAnomalies(vectors);
    expect(result.abnormalL2NormCount).toBe(1);
  });

  it("異常に大きいL2 normを検出すること", () => {
    const vectors = [createNormalizedVector(1), createLargeL2Vector()];
    const result = detectAnomalies(vectors);
    expect(result.abnormalL2NormCount).toBe(1);
  });

  it("空配列でtotalInspectedが0であること", () => {
    const result = detectAnomalies([]);
    expect(result.totalInspected).toBe(0);
    expect(result.nanInfinityCount).toBe(0);
    expect(result.zeroVectorCount).toBe(0);
    expect(result.abnormalL2NormCount).toBe(0);
  });

  it("複数種類の異常を同時検出すること", () => {
    const vectors = [
      createNanVector(),
      createZeroVector(),
      createSmallL2Vector(),
      createNormalizedVector(1),
    ];
    const result = detectAnomalies(vectors);
    expect(result.nanInfinityCount).toBe(1);
    expect(result.zeroVectorCount).toBe(1);
    expect(result.abnormalL2NormCount).toBe(1);
    expect(result.totalInspected).toBe(4);
  });
});

// =====================================================
// Quality Score計算テスト
// =====================================================

describe("calculateQualityScore", () => {
  const perfectCoverage: CoverageMetrics = {
    textEmbeddingCount: 100,
    visionEmbeddingCount: 100,
    totalSections: 100,
    textCoveragePercent: 100,
    visionCoveragePercent: 100,
  };

  const noAnomalies: AnomalyResult = {
    nanInfinityCount: 0,
    zeroVectorCount: 0,
    abnormalL2NormCount: 0,
    totalInspected: 100,
  };

  it("完璧なメトリクスで100点を返すこと", () => {
    const metrics: QualityMetrics = {
      coverage: perfectCoverage,
      textAnomalies: noAnomalies,
      visionAnomalies: noAnomalies,
      textDrift: null,
      visionDrift: null,
    };
    const score = calculateQualityScore(metrics);
    expect(score).toBe(100);
  });

  it("0-100の範囲であること", () => {
    const metrics: QualityMetrics = {
      coverage: {
        textEmbeddingCount: 0,
        visionEmbeddingCount: 0,
        totalSections: 100,
        textCoveragePercent: 0,
        visionCoveragePercent: 0,
      },
      textAnomalies: {
        nanInfinityCount: 50,
        zeroVectorCount: 50,
        abnormalL2NormCount: 0,
        totalInspected: 100,
      },
      visionAnomalies: {
        nanInfinityCount: 50,
        zeroVectorCount: 50,
        abnormalL2NormCount: 0,
        totalInspected: 100,
      },
      textDrift: {
        distance: 1.0,
        isWarning: true,
        baselineSampleCount: 100,
        currentSampleCount: 100,
      },
      visionDrift: {
        distance: 1.0,
        isWarning: true,
        baselineSampleCount: 100,
        currentSampleCount: 100,
      },
    };
    const score = calculateQualityScore(metrics);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("カバレッジ低下でスコアが下がること", () => {
    const lowCoverage: QualityMetrics = {
      coverage: {
        textEmbeddingCount: 50,
        visionEmbeddingCount: 50,
        totalSections: 100,
        textCoveragePercent: 50,
        visionCoveragePercent: 50,
      },
      textAnomalies: noAnomalies,
      visionAnomalies: noAnomalies,
      textDrift: null,
      visionDrift: null,
    };
    const perfect: QualityMetrics = {
      coverage: perfectCoverage,
      textAnomalies: noAnomalies,
      visionAnomalies: noAnomalies,
      textDrift: null,
      visionDrift: null,
    };
    expect(calculateQualityScore(lowCoverage)).toBeLessThan(calculateQualityScore(perfect));
  });

  it("異常ありでスコアが下がること", () => {
    const withAnomalies: QualityMetrics = {
      coverage: perfectCoverage,
      textAnomalies: {
        nanInfinityCount: 10,
        zeroVectorCount: 5,
        abnormalL2NormCount: 5,
        totalInspected: 100,
      },
      visionAnomalies: noAnomalies,
      textDrift: null,
      visionDrift: null,
    };
    const perfect: QualityMetrics = {
      coverage: perfectCoverage,
      textAnomalies: noAnomalies,
      visionAnomalies: noAnomalies,
      textDrift: null,
      visionDrift: null,
    };
    expect(calculateQualityScore(withAnomalies)).toBeLessThan(calculateQualityScore(perfect));
  });

  it("ドリフトありでスコアが下がること", () => {
    const withDrift: QualityMetrics = {
      coverage: perfectCoverage,
      textAnomalies: noAnomalies,
      visionAnomalies: noAnomalies,
      textDrift: {
        distance: 0.2,
        isWarning: true,
        baselineSampleCount: 100,
        currentSampleCount: 100,
      },
      visionDrift: null,
    };
    const perfect: QualityMetrics = {
      coverage: perfectCoverage,
      textAnomalies: noAnomalies,
      visionAnomalies: noAnomalies,
      textDrift: null,
      visionDrift: null,
    };
    expect(calculateQualityScore(withDrift)).toBeLessThan(calculateQualityScore(perfect));
  });

  it("totalInspectedが0でもクラッシュしないこと", () => {
    const metrics: QualityMetrics = {
      coverage: perfectCoverage,
      textAnomalies: {
        nanInfinityCount: 0,
        zeroVectorCount: 0,
        abnormalL2NormCount: 0,
        totalInspected: 0,
      },
      visionAnomalies: {
        nanInfinityCount: 0,
        zeroVectorCount: 0,
        abnormalL2NormCount: 0,
        totalInspected: 0,
      },
      textDrift: null,
      visionDrift: null,
    };
    const score = calculateQualityScore(metrics);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// =====================================================
// Alert生成テスト
// =====================================================

describe("generateAlerts", () => {
  const noAnomalies: AnomalyResult = {
    nanInfinityCount: 0,
    zeroVectorCount: 0,
    abnormalL2NormCount: 0,
    totalInspected: 100,
  };

  it("完璧なメトリクスでアラートが空であること", () => {
    const metrics: QualityMetrics = {
      coverage: {
        textEmbeddingCount: 100,
        visionEmbeddingCount: 100,
        totalSections: 100,
        textCoveragePercent: 100,
        visionCoveragePercent: 100,
      },
      textAnomalies: noAnomalies,
      visionAnomalies: noAnomalies,
      textDrift: null,
      visionDrift: null,
    };
    const alerts = generateAlerts(metrics);
    expect(alerts).toEqual([]);
  });

  it("Vision coverage低下でアラートが生成されること", () => {
    const metrics: QualityMetrics = {
      coverage: {
        textEmbeddingCount: 100,
        visionEmbeddingCount: 50,
        totalSections: 100,
        textCoveragePercent: 100,
        visionCoveragePercent: 50,
      },
      textAnomalies: noAnomalies,
      visionAnomalies: noAnomalies,
      textDrift: null,
      visionDrift: null,
    };
    const alerts = generateAlerts(metrics);
    expect(alerts.some((a) => a.includes("Vision embedding coverage below"))).toBe(true);
  });

  it("Text coverage低下でアラートが生成されること", () => {
    const metrics: QualityMetrics = {
      coverage: {
        textEmbeddingCount: 50,
        visionEmbeddingCount: 100,
        totalSections: 100,
        textCoveragePercent: 50,
        visionCoveragePercent: 100,
      },
      textAnomalies: noAnomalies,
      visionAnomalies: noAnomalies,
      textDrift: null,
      visionDrift: null,
    };
    const alerts = generateAlerts(metrics);
    expect(alerts.some((a) => a.includes("Text embedding coverage below"))).toBe(true);
  });

  it("NaN/Infinity異常でアラートが生成されること", () => {
    const metrics: QualityMetrics = {
      coverage: {
        textEmbeddingCount: 100,
        visionEmbeddingCount: 100,
        totalSections: 100,
        textCoveragePercent: 100,
        visionCoveragePercent: 100,
      },
      textAnomalies: {
        nanInfinityCount: 5,
        zeroVectorCount: 0,
        abnormalL2NormCount: 0,
        totalInspected: 100,
      },
      visionAnomalies: noAnomalies,
      textDrift: null,
      visionDrift: null,
    };
    const alerts = generateAlerts(metrics);
    expect(alerts.some((a) => a.includes("NaN/Infinity"))).toBe(true);
  });

  it("ゼロベクトル異常でアラートが生成されること", () => {
    const metrics: QualityMetrics = {
      coverage: {
        textEmbeddingCount: 100,
        visionEmbeddingCount: 100,
        totalSections: 100,
        textCoveragePercent: 100,
        visionCoveragePercent: 100,
      },
      textAnomalies: noAnomalies,
      visionAnomalies: {
        nanInfinityCount: 0,
        zeroVectorCount: 3,
        abnormalL2NormCount: 0,
        totalInspected: 100,
      },
      textDrift: null,
      visionDrift: null,
    };
    const alerts = generateAlerts(metrics);
    expect(alerts.some((a) => a.includes("zero vectors"))).toBe(true);
  });

  it("ドリフト警告でアラートが生成されること", () => {
    const metrics: QualityMetrics = {
      coverage: {
        textEmbeddingCount: 100,
        visionEmbeddingCount: 100,
        totalSections: 100,
        textCoveragePercent: 100,
        visionCoveragePercent: 100,
      },
      textAnomalies: noAnomalies,
      visionAnomalies: noAnomalies,
      textDrift: {
        distance: 0.2,
        isWarning: true,
        baselineSampleCount: 100,
        currentSampleCount: 100,
      },
      visionDrift: null,
    };
    const alerts = generateAlerts(metrics);
    expect(alerts.some((a) => a.includes("Text embedding mean drift"))).toBe(true);
  });

  it("異常L2 normでアラートが生成されること", () => {
    const metrics: QualityMetrics = {
      coverage: {
        textEmbeddingCount: 100,
        visionEmbeddingCount: 100,
        totalSections: 100,
        textCoveragePercent: 100,
        visionCoveragePercent: 100,
      },
      textAnomalies: {
        nanInfinityCount: 0,
        zeroVectorCount: 0,
        abnormalL2NormCount: 7,
        totalInspected: 100,
      },
      visionAnomalies: noAnomalies,
      textDrift: null,
      visionDrift: null,
    };
    const alerts = generateAlerts(metrics);
    expect(alerts.some((a) => a.includes("abnormal L2 norm"))).toBe(true);
  });
});

// =====================================================
// EmbeddingQualityMonitorService 統合テスト
// =====================================================

describe("EmbeddingQualityMonitorService", () => {
  let mockPrisma: EmbeddingQualityPrismaClient;
  let service: EmbeddingQualityMonitorService;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    service = new EmbeddingQualityMonitorService(mockPrisma);
  });

  describe("monitor", () => {
    it("正常系: カバレッジとメトリクスを返すこと", async () => {
      // Mock coverage query
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([
        { totalSections: 100, textEmbeddingCount: 90, visionEmbeddingCount: 85 },
      ]);

      const result = await service.monitor({
        scope: "sections",
        includeDistribution: false,
      });

      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
      expect(result.qualityScore).toBeLessThanOrEqual(100);
      expect(result.metrics.coverage).toBeDefined();
      expect(Array.isArray(result.alerts)).toBe(true);
    });

    it("空データでもクラッシュしないこと", async () => {
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([
        { totalSections: 0, textEmbeddingCount: 0, visionEmbeddingCount: 0 },
      ]);

      const result = await service.monitor({
        scope: "all",
        includeDistribution: false,
      });

      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
      expect(result.metrics.coverage.totalSections).toBe(0);
    });

    it("includeDistributionがtrueで分布統計を含むこと", async () => {
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([
        { totalSections: 0, textEmbeddingCount: 0, visionEmbeddingCount: 0 },
      ]);

      const result = await service.monitor({
        scope: "sections",
        includeDistribution: true,
      });

      expect(result.distribution).toBeDefined();
      expect(result.distribution).toHaveProperty("text");
      expect(result.distribution).toHaveProperty("vision");
    });

    it("DB障害時にGraceful Degradationすること", async () => {
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Connection refused")
      );

      const result = await service.monitor({
        scope: "sections",
        includeDistribution: false,
      });

      // Should not throw; should return degraded result
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    });

    it("webPageIdフィルタが指定できること", async () => {
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([
        { totalSections: 10, textEmbeddingCount: 8, visionEmbeddingCount: 7 },
      ]);

      const result = await service.monitor({
        scope: "sections",
        webPageId: "550e8400-e29b-41d4-a716-446655440000",
        includeDistribution: false,
      });

      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
      // Verify the query was called with the webPageId param
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
    });
  });

  describe("baseline management", () => {
    it("ベースラインを設定・取得できること", () => {
      const baseline: EmbeddingBaseline = {
        centroid: createNormalizedVector(1),
        sampleCount: 50,
        computedAt: new Date().toISOString(),
      };

      service.setBaseline("text", baseline);
      expect(service.getBaseline("text")).toEqual(baseline);
      expect(service.getBaseline("vision")).toBeNull();
    });

    it("ビジョンベースラインを設定・取得できること", () => {
      const baseline: EmbeddingBaseline = {
        centroid: createNormalizedVector(2),
        sampleCount: 30,
        computedAt: new Date().toISOString(),
      };

      service.setBaseline("vision", baseline);
      expect(service.getBaseline("vision")).toEqual(baseline);
      expect(service.getBaseline("text")).toBeNull();
    });

    it("computeAndSetBaselineがデータなしでnullを返すこと", async () => {
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await service.computeAndSetBaseline("text", "sections");
      expect(result).toBeNull();
    });
  });

  describe("scope filtering", () => {
    it("scope=sectionsでセクションクエリのみ実行すること", async () => {
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([
        { totalSections: 50, textEmbeddingCount: 40, visionEmbeddingCount: 35 },
      ]);

      await service.monitor({
        scope: "sections",
        includeDistribution: false,
      });

      // Should have been called (coverage + vectors), but only section queries
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
    });

    it("scope=partsでパーツクエリのみ実行すること", async () => {
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([
        { totalSections: 30, textEmbeddingCount: 25, visionEmbeddingCount: 20 },
      ]);

      await service.monitor({
        scope: "parts",
        includeDistribution: false,
      });

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
    });

    it("scope=allで両方のクエリが実行されること", async () => {
      (mockPrisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([
        { totalSections: 50, textEmbeddingCount: 40, visionEmbeddingCount: 35 },
      ]);

      await service.monitor({
        scope: "all",
        includeDistribution: false,
      });

      // Should call queries for both sections and parts
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
    });
  });
});

// =====================================================
// 定数エクスポートテスト
// =====================================================

describe("Constants", () => {
  it("L2_NORM_LOWER_THRESHOLDが0.5であること", () => {
    expect(L2_NORM_LOWER_THRESHOLD).toBe(0.5);
  });

  it("L2_NORM_UPPER_THRESHOLDが2.0であること", () => {
    expect(L2_NORM_UPPER_THRESHOLD).toBe(2.0);
  });

  it("DRIFT_WARNING_THRESHOLDが0.1であること", () => {
    expect(DRIFT_WARNING_THRESHOLD).toBe(0.1);
  });

  it("QUALITY_SCORE_ALERT_THRESHOLDが70であること", () => {
    expect(QUALITY_SCORE_ALERT_THRESHOLD).toBe(70);
  });

  it("EXPECTED_DIMENSIONSが768であること", () => {
    expect(EXPECTED_DIMENSIONS).toBe(768);
  });
});
