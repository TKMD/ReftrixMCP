// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Quality Monitor Service
 *
 * DINOv2/e5-base両方のembedding品質を継続的に監視し、
 * サイレント劣化を防止するサービス。
 *
 * Continuously monitors embedding quality for both DINOv2/e5-base,
 * preventing silent degradation.
 *
 * 監視項目:
 * - Distribution Monitoring: mean, std, min, max, L2 norm
 * - Drift Detection: ベースラインからのcentroid cosine distance
 * - Anomaly Detection: NaN/Infinity, ゼロベクトル, 異常L2 norm
 * - Coverage Metrics: vision/text embedding有無率
 *
 * @module services/embedding-quality-monitor.service
 */

import { logger } from "../utils/logger";

// =====================================================
// SQLカラム名ホワイトリスト / SQL Column Name Whitelist
// =====================================================

/** セクションembeddingのカラム名マップ / Section embedding column name map */
const SECTION_EMBEDDING_COLUMNS = {
  text: "text_embedding",
  vision: "vision_embedding",
} as const;

/** パーツembeddingのカラム名マップ / Part embedding column name map */
const PART_EMBEDDING_COLUMNS = {
  text: "text_embedding",
  vision: "visual_embedding",
} as const;

// =====================================================
// 定数 / Constants
// =====================================================

/** L2 normの下限閾値（これ未満は異常） / L2 norm lower threshold */
export const L2_NORM_LOWER_THRESHOLD = 0.5;

/** L2 normの上限閾値（これ超過は異常） / L2 norm upper threshold */
export const L2_NORM_UPPER_THRESHOLD = 2.0;

/** ドリフト検出の警告閾値 / Drift warning threshold */
export const DRIFT_WARNING_THRESHOLD = 0.1;

/** 品質スコア警告閾値 / Quality score alert threshold */
export const QUALITY_SCORE_ALERT_THRESHOLD = 70;

/** ビジョンカバレッジ警告閾値（%） / Vision coverage alert threshold (%) */
export const VISION_COVERAGE_ALERT_THRESHOLD = 80;

/** テキストカバレッジ警告閾値（%） / Text coverage alert threshold (%) */
export const TEXT_COVERAGE_ALERT_THRESHOLD = 90;

/** 期待されるベクトル次元数 / Expected vector dimensions */
export const EXPECTED_DIMENSIONS = 768;

// =====================================================
// 型定義 / Type Definitions
// =====================================================

/**
 * Embeddingの分布統計量
 * Distribution statistics for embeddings
 */
export interface EmbeddingDistribution {
  /** 平均値 / Mean value */
  mean: number;
  /** 標準偏差 / Standard deviation */
  std: number;
  /** 最小値 / Minimum value */
  min: number;
  /** 最大値 / Maximum value */
  max: number;
  /** 平均L2ノルム / Average L2 norm */
  avgL2Norm: number;
  /** サンプル数 / Sample count */
  sampleCount: number;
}

/**
 * ドリフト検出結果
 * Drift detection result
 */
export interface DriftResult {
  /** ドリフト距離（cosine distance of centroids） */
  distance: number;
  /** ドリフト警告が発生しているか */
  isWarning: boolean;
  /** ベースラインのサンプル数 */
  baselineSampleCount: number;
  /** 現在のサンプル数 */
  currentSampleCount: number;
}

/**
 * 異常検出結果
 * Anomaly detection results
 */
export interface AnomalyResult {
  /** NaN/Infinityを含むembedding数 */
  nanInfinityCount: number;
  /** ゼロベクトル数 */
  zeroVectorCount: number;
  /** 異常L2 norm数（<0.5 or >2.0） */
  abnormalL2NormCount: number;
  /** 総検査数 */
  totalInspected: number;
}

/**
 * カバレッジメトリクス
 * Coverage metrics
 */
export interface CoverageMetrics {
  /** テキストembedding有り数 */
  textEmbeddingCount: number;
  /** ビジョンembedding有り数 */
  visionEmbeddingCount: number;
  /** 総セクション数 */
  totalSections: number;
  /** テキストカバレッジ（%） */
  textCoveragePercent: number;
  /** ビジョンカバレッジ（%） */
  visionCoveragePercent: number;
}

/**
 * 品質メトリクス（全体）
 * Overall quality metrics
 */
export interface QualityMetrics {
  /** カバレッジ / Coverage */
  coverage: CoverageMetrics;
  /** テキストembeddingの異常検出 */
  textAnomalies: AnomalyResult;
  /** ビジョンembeddingの異常検出 */
  visionAnomalies: AnomalyResult;
  /** テキストembeddingのドリフト（ベースライン比較） */
  textDrift: DriftResult | null;
  /** ビジョンembeddingのドリフト（ベースライン比較） */
  visionDrift: DriftResult | null;
}

/**
 * 品質監視結果
 * Quality monitoring result
 */
export interface QualityMonitorResult {
  /** 品質スコア（0-100） / Quality score (0-100) */
  qualityScore: number;
  /** メトリクス / Metrics */
  metrics: QualityMetrics;
  /** アラート一覧 / Alert list */
  alerts: string[];
  /** 分布統計（オプション） / Distribution statistics (optional) */
  distribution?: {
    text: EmbeddingDistribution | null;
    vision: EmbeddingDistribution | null;
  };
}

/**
 * 監視スコープ
 * Monitoring scope
 */
export type MonitorScope = "all" | "sections" | "parts";

/**
 * 品質監視入力
 * Quality monitoring input
 */
export interface QualityMonitorInput {
  /** 監視スコープ / Monitoring scope */
  scope: MonitorScope;
  /** 特定ページに限定（任意） / Limit to specific page (optional) */
  webPageId?: string | undefined;
  /** 分布統計を含めるか / Include distribution statistics */
  includeDistribution: boolean;
}

/**
 * ベースライン設定（JSON config管理）
 * Baseline configuration (managed via JSON config)
 */
export interface EmbeddingBaseline {
  /** ベースラインcentroid（768D平均ベクトル） */
  centroid: number[];
  /** ベースライン計算時のサンプル数 */
  sampleCount: number;
  /** ベースライン計算日時 */
  computedAt: string;
}

/**
 * Prismaクライアントインターフェース（DI用）
 * Prisma client interface for DI
 */
export interface EmbeddingQualityPrismaClient {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

// =====================================================
// ヘルパー関数 / Helper Functions
// =====================================================

/**
 * ベクトル配列のL2ノルムを計算
 * Calculate L2 norm of a vector array
 */
export function calculateL2Norm(vector: number[]): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const v: number | undefined = vector[i];
    if (v === undefined || !Number.isFinite(v)) return NaN;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  return Number.isFinite(norm) ? norm : NaN;
}

/**
 * 2つのベクトル間のコサイン距離を計算
 * Calculate cosine distance between two vectors
 *
 * @returns 0（同一）〜2（正反対） / 0 (identical) to 2 (opposite)
 */
export function calculateCosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return NaN;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const va: number | undefined = a[i];
    const vb: number | undefined = b[i];
    if (va === undefined || vb === undefined || !Number.isFinite(va) || !Number.isFinite(vb))
      return NaN;
    dotProduct += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return NaN;

  const cosineSimilarity = dotProduct / denominator;
  // Clamp to [-1, 1] to handle floating point errors
  const clamped = Math.max(-1, Math.min(1, cosineSimilarity));
  const distance = 1 - clamped;
  return Number.isFinite(distance) ? distance : NaN;
}

/**
 * ベクトル配列のcentroid（平均ベクトル）を計算
 * Calculate centroid (mean vector) from array of vectors
 */
export function calculateCentroid(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null;

  const firstVec = vectors[0];
  if (!firstVec) return null;
  const dim = firstVec.length;
  const centroid = new Array<number>(dim).fill(0);

  for (const vec of vectors) {
    if (vec.length !== dim) return null;
    for (let i = 0; i < dim; i++) {
      const v: number | undefined = vec[i];
      if (v === undefined || !Number.isFinite(v)) return null;
      const c = centroid[i];
      if (c === undefined) return null;
      centroid[i] = c + v;
    }
  }

  const count = vectors.length;
  for (let i = 0; i < dim; i++) {
    const c = centroid[i];
    if (c === undefined) return null;
    centroid[i] = c / count;
    if (!Number.isFinite(centroid[i])) return null;
  }

  return centroid;
}

/**
 * ベクトル配列の分布統計量を計算
 * Calculate distribution statistics from vector array
 */
export function calculateDistribution(vectors: number[][]): EmbeddingDistribution | null {
  if (vectors.length === 0) return null;

  let globalMin = Infinity;
  let globalMax = -Infinity;
  let globalSum = 0;
  let globalSumSq = 0;
  let l2NormSum = 0;
  let elementCount = 0;

  for (const vec of vectors) {
    const l2 = calculateL2Norm(vec);
    if (!Number.isFinite(l2)) continue;
    l2NormSum += l2;

    for (const v of vec) {
      if (!Number.isFinite(v)) continue;
      globalSum += v;
      globalSumSq += v * v;
      if (v < globalMin) globalMin = v;
      if (v > globalMax) globalMax = v;
      elementCount++;
    }
  }

  if (elementCount === 0) return null;

  const mean = globalSum / elementCount;
  const variance = globalSumSq / elementCount - mean * mean;
  const std = Math.sqrt(Math.max(0, variance));
  const avgL2Norm = l2NormSum / vectors.length;

  if (!Number.isFinite(mean) || !Number.isFinite(std) || !Number.isFinite(avgL2Norm)) {
    return null;
  }

  return {
    mean,
    std,
    min: globalMin,
    max: globalMax,
    avgL2Norm,
    sampleCount: vectors.length,
  };
}

/**
 * ベクトル配列の異常検出
 * Anomaly detection for vector array
 */
export function detectAnomalies(vectors: number[][]): AnomalyResult {
  let nanInfinityCount = 0;
  let zeroVectorCount = 0;
  let abnormalL2NormCount = 0;

  for (const vec of vectors) {
    // NaN/Infinity check
    const hasNanInf = vec.some((v) => !Number.isFinite(v));
    if (hasNanInf) {
      nanInfinityCount++;
      continue;
    }

    // Zero vector check
    const isZero = vec.every((v) => v === 0);
    if (isZero) {
      zeroVectorCount++;
      continue;
    }

    // Abnormal L2 norm check
    const l2 = calculateL2Norm(vec);
    if (Number.isFinite(l2) && (l2 < L2_NORM_LOWER_THRESHOLD || l2 > L2_NORM_UPPER_THRESHOLD)) {
      abnormalL2NormCount++;
    }
  }

  return {
    nanInfinityCount,
    zeroVectorCount,
    abnormalL2NormCount,
    totalInspected: vectors.length,
  };
}

/**
 * 品質スコアを計算（0-100）
 * Calculate quality score (0-100)
 *
 * 重み付け / Weighting:
 * - Coverage: 40% (text 15% + vision 25%)
 * - Anomaly: 30%
 * - Drift: 30%
 */
export function calculateQualityScore(metrics: QualityMetrics): number {
  // Coverage score (40 points)
  const textCovScore = Math.min(100, metrics.coverage.textCoveragePercent);
  const visionCovScore = Math.min(100, metrics.coverage.visionCoveragePercent);
  const coverageScore = textCovScore * 0.15 + visionCovScore * 0.25;

  // Anomaly score (30 points)
  const totalAnomalies =
    metrics.textAnomalies.nanInfinityCount +
    metrics.textAnomalies.zeroVectorCount +
    metrics.textAnomalies.abnormalL2NormCount +
    metrics.visionAnomalies.nanInfinityCount +
    metrics.visionAnomalies.zeroVectorCount +
    metrics.visionAnomalies.abnormalL2NormCount;

  const totalInspected =
    metrics.textAnomalies.totalInspected + metrics.visionAnomalies.totalInspected;

  const anomalyRate = totalInspected > 0 ? totalAnomalies / totalInspected : 0;
  const anomalyScore = Math.max(0, 1 - anomalyRate * 10) * 30;

  // Drift score (30 points)
  let driftScore = 30;
  if (metrics.textDrift && Number.isFinite(metrics.textDrift.distance)) {
    const textDriftPenalty = Math.min(1, metrics.textDrift.distance / DRIFT_WARNING_THRESHOLD);
    driftScore -= textDriftPenalty * 15;
  }
  if (metrics.visionDrift && Number.isFinite(metrics.visionDrift.distance)) {
    const visionDriftPenalty = Math.min(1, metrics.visionDrift.distance / DRIFT_WARNING_THRESHOLD);
    driftScore -= visionDriftPenalty * 15;
  }
  driftScore = Math.max(0, driftScore);

  const totalScore = Math.round(
    Math.max(0, Math.min(100, coverageScore + anomalyScore + driftScore))
  );
  return Number.isFinite(totalScore) ? totalScore : 0;
}

/**
 * メトリクスからアラートを生成
 * Generate alerts from metrics
 */
export function generateAlerts(metrics: QualityMetrics): string[] {
  const alerts: string[] = [];

  // Coverage alerts
  if (metrics.coverage.visionCoveragePercent < VISION_COVERAGE_ALERT_THRESHOLD) {
    alerts.push(
      `Vision embedding coverage below ${VISION_COVERAGE_ALERT_THRESHOLD}%: ${metrics.coverage.visionCoveragePercent.toFixed(1)}%`
    );
  }
  if (metrics.coverage.textCoveragePercent < TEXT_COVERAGE_ALERT_THRESHOLD) {
    alerts.push(
      `Text embedding coverage below ${TEXT_COVERAGE_ALERT_THRESHOLD}%: ${metrics.coverage.textCoveragePercent.toFixed(1)}%`
    );
  }

  // Anomaly alerts
  if (metrics.textAnomalies.nanInfinityCount > 0) {
    alerts.push(
      `Text embeddings contain ${metrics.textAnomalies.nanInfinityCount} NaN/Infinity vectors`
    );
  }
  if (metrics.visionAnomalies.nanInfinityCount > 0) {
    alerts.push(
      `Vision embeddings contain ${metrics.visionAnomalies.nanInfinityCount} NaN/Infinity vectors`
    );
  }
  if (metrics.textAnomalies.zeroVectorCount > 0) {
    alerts.push(`Text embeddings contain ${metrics.textAnomalies.zeroVectorCount} zero vectors`);
  }
  if (metrics.visionAnomalies.zeroVectorCount > 0) {
    alerts.push(
      `Vision embeddings contain ${metrics.visionAnomalies.zeroVectorCount} zero vectors`
    );
  }
  if (metrics.textAnomalies.abnormalL2NormCount > 0) {
    alerts.push(
      `Text embeddings: ${metrics.textAnomalies.abnormalL2NormCount} vectors with abnormal L2 norm (<${L2_NORM_LOWER_THRESHOLD} or >${L2_NORM_UPPER_THRESHOLD})`
    );
  }
  if (metrics.visionAnomalies.abnormalL2NormCount > 0) {
    alerts.push(
      `Vision embeddings: ${metrics.visionAnomalies.abnormalL2NormCount} vectors with abnormal L2 norm (<${L2_NORM_LOWER_THRESHOLD} or >${L2_NORM_UPPER_THRESHOLD})`
    );
  }

  // Drift alerts
  if (
    metrics.textDrift &&
    Number.isFinite(metrics.textDrift.distance) &&
    metrics.textDrift.isWarning
  ) {
    alerts.push(
      `Text embedding mean drift > ${DRIFT_WARNING_THRESHOLD}: ${metrics.textDrift.distance.toFixed(4)}`
    );
  }
  if (
    metrics.visionDrift &&
    Number.isFinite(metrics.visionDrift.distance) &&
    metrics.visionDrift.isWarning
  ) {
    alerts.push(
      `Vision embedding mean drift > ${DRIFT_WARNING_THRESHOLD}: ${metrics.visionDrift.distance.toFixed(4)}`
    );
  }

  return alerts;
}

// =====================================================
// EmbeddingQualityMonitorService クラス
// =====================================================

/**
 * Embedding品質監視サービス
 * Embedding quality monitoring service
 */
export class EmbeddingQualityMonitorService {
  private readonly prisma: EmbeddingQualityPrismaClient;
  private textBaseline: EmbeddingBaseline | null = null;
  private visionBaseline: EmbeddingBaseline | null = null;

  constructor(prisma: EmbeddingQualityPrismaClient) {
    this.prisma = prisma;
  }

  /**
   * 品質監視を実行
   * Execute quality monitoring
   */
  async monitor(input: QualityMonitorInput): Promise<QualityMonitorResult> {
    const { scope, webPageId, includeDistribution } = input;

    // 1. カバレッジメトリクスを取得
    const coverage = await this.getCoverageMetrics(scope, webPageId);

    // 2. Embeddingベクトルをサンプリングして取得
    const textVectors = await this.fetchEmbeddingVectors("text", scope, webPageId);
    const visionVectors = await this.fetchEmbeddingVectors("vision", scope, webPageId);

    // 3. 異常検出
    const textAnomalies = detectAnomalies(textVectors);
    const visionAnomalies = detectAnomalies(visionVectors);

    // 4. ドリフト検出
    const textDrift = this.detectDrift(textVectors, "text");
    const visionDrift = this.detectDrift(visionVectors, "vision");

    // 5. メトリクス構築
    const metrics: QualityMetrics = {
      coverage,
      textAnomalies,
      visionAnomalies,
      textDrift,
      visionDrift,
    };

    // 6. 品質スコア計算
    const qualityScore = calculateQualityScore(metrics);

    // 7. アラート生成
    const alerts = generateAlerts(metrics);

    // 8. 品質スコアが閾値以下の場合に警告
    if (qualityScore < QUALITY_SCORE_ALERT_THRESHOLD) {
      logger.warn("[EmbeddingQualityMonitor] Quality score below threshold", {
        qualityScore,
        threshold: QUALITY_SCORE_ALERT_THRESHOLD,
        alertCount: alerts.length,
      });
    }

    // 9. レスポンス構築
    const result: QualityMonitorResult = {
      qualityScore,
      metrics,
      alerts,
    };

    if (includeDistribution) {
      result.distribution = {
        text: calculateDistribution(textVectors),
        vision: calculateDistribution(visionVectors),
      };
    }

    return result;
  }

  /**
   * ベースラインを設定
   * Set baseline for drift detection
   */
  setBaseline(type: "text" | "vision", baseline: EmbeddingBaseline): void {
    if (type === "text") {
      this.textBaseline = baseline;
    } else {
      this.visionBaseline = baseline;
    }
  }

  /**
   * 現在のベースラインを取得
   * Get current baseline
   */
  getBaseline(type: "text" | "vision"): EmbeddingBaseline | null {
    return type === "text" ? this.textBaseline : this.visionBaseline;
  }

  /**
   * ベースラインを自動計算して設定
   * Auto-compute and set baseline from current data
   */
  async computeAndSetBaseline(
    type: "text" | "vision",
    scope: MonitorScope = "all",
    webPageId?: string
  ): Promise<EmbeddingBaseline | null> {
    const vectors = await this.fetchEmbeddingVectors(type, scope, webPageId);
    if (vectors.length === 0) return null;

    const centroid = calculateCentroid(vectors);
    if (!centroid) return null;

    const baseline: EmbeddingBaseline = {
      centroid,
      sampleCount: vectors.length,
      computedAt: new Date().toISOString(),
    };

    this.setBaseline(type, baseline);
    return baseline;
  }

  // =====================================================
  // Private Methods
  // =====================================================

  /**
   * カバレッジメトリクスをDB問い合わせで取得
   * Fetch coverage metrics via DB query
   */
  private async getCoverageMetrics(
    scope: MonitorScope,
    webPageId?: string
  ): Promise<CoverageMetrics> {
    try {
      if (scope === "parts") {
        return await this.getPartsCoverage(webPageId);
      }
      // "sections" or "all"
      const sectionsCoverage = await this.getSectionsCoverage(webPageId);
      if (scope === "all") {
        const partsCoverage = await this.getPartsCoverage(webPageId);
        // Combine: aggregate totals
        return {
          textEmbeddingCount:
            sectionsCoverage.textEmbeddingCount + partsCoverage.textEmbeddingCount,
          visionEmbeddingCount:
            sectionsCoverage.visionEmbeddingCount + partsCoverage.visionEmbeddingCount,
          totalSections: sectionsCoverage.totalSections + partsCoverage.totalSections,
          textCoveragePercent: this.safePercent(
            sectionsCoverage.textEmbeddingCount + partsCoverage.textEmbeddingCount,
            sectionsCoverage.totalSections + partsCoverage.totalSections
          ),
          visionCoveragePercent: this.safePercent(
            sectionsCoverage.visionEmbeddingCount + partsCoverage.visionEmbeddingCount,
            sectionsCoverage.totalSections + partsCoverage.totalSections
          ),
        };
      }
      return sectionsCoverage;
    } catch (error) {
      logger.warn("[EmbeddingQualityMonitor] Failed to fetch coverage metrics", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        textEmbeddingCount: 0,
        visionEmbeddingCount: 0,
        totalSections: 0,
        textCoveragePercent: 0,
        visionCoveragePercent: 0,
      };
    }
  }

  /**
   * セクションembeddingカバレッジを取得
   */
  private async getSectionsCoverage(webPageId?: string): Promise<CoverageMetrics> {
    const whereClause = webPageId ? `WHERE sp.web_page_id = $1` : "";
    const params: unknown[] = webPageId ? [webPageId] : [];

    const query = `
      SELECT
        COUNT(*)::int AS "totalSections",
        COUNT(se.text_embedding)::int AS "textEmbeddingCount",
        COUNT(se.vision_embedding)::int AS "visionEmbeddingCount"
      FROM section_patterns sp
      LEFT JOIN section_embeddings se ON se.section_pattern_id = sp.id
      ${whereClause}
    `;

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ totalSections: number; textEmbeddingCount: number; visionEmbeddingCount: number }>
    >(query, ...params);

    const row = rows[0] ?? { totalSections: 0, textEmbeddingCount: 0, visionEmbeddingCount: 0 };
    const total = Number(row.totalSections) || 0;
    const textCount = Number(row.textEmbeddingCount) || 0;
    const visionCount = Number(row.visionEmbeddingCount) || 0;

    return {
      textEmbeddingCount: textCount,
      visionEmbeddingCount: visionCount,
      totalSections: total,
      textCoveragePercent: this.safePercent(textCount, total),
      visionCoveragePercent: this.safePercent(visionCount, total),
    };
  }

  /**
   * パーツembeddingカバレッジを取得
   */
  private async getPartsCoverage(webPageId?: string): Promise<CoverageMetrics> {
    const whereClause = webPageId ? `WHERE cp.web_page_id = $1` : "";
    const params: unknown[] = webPageId ? [webPageId] : [];

    const query = `
      SELECT
        COUNT(*)::int AS "totalSections",
        COUNT(cpe.text_embedding)::int AS "textEmbeddingCount",
        COUNT(cpe.visual_embedding)::int AS "visionEmbeddingCount"
      FROM component_parts cp
      LEFT JOIN component_part_embeddings cpe ON cpe.component_part_id = cp.id
      ${whereClause}
    `;

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ totalSections: number; textEmbeddingCount: number; visionEmbeddingCount: number }>
    >(query, ...params);

    const row = rows[0] ?? { totalSections: 0, textEmbeddingCount: 0, visionEmbeddingCount: 0 };
    const total = Number(row.totalSections) || 0;
    const textCount = Number(row.textEmbeddingCount) || 0;
    const visionCount = Number(row.visionEmbeddingCount) || 0;

    return {
      textEmbeddingCount: textCount,
      visionEmbeddingCount: visionCount,
      totalSections: total,
      textCoveragePercent: this.safePercent(textCount, total),
      visionCoveragePercent: this.safePercent(visionCount, total),
    };
  }

  /**
   * Embeddingベクトルをサンプリングして取得（最大200件）
   * Fetch embedding vectors (max 200 samples)
   */
  private async fetchEmbeddingVectors(
    type: "text" | "vision",
    scope: MonitorScope,
    webPageId?: string
  ): Promise<number[][]> {
    try {
      const vectors: number[][] = [];

      if (scope !== "parts") {
        const sectionVectors = await this.fetchSectionVectors(type, webPageId);
        vectors.push(...sectionVectors);
      }

      if (scope !== "sections") {
        const partVectors = await this.fetchPartVectors(type, webPageId);
        vectors.push(...partVectors);
      }

      return vectors;
    } catch (error) {
      logger.warn("[EmbeddingQualityMonitor] Failed to fetch embedding vectors", {
        type,
        scope,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * セクションembeddingベクトルを取得
   */
  private async fetchSectionVectors(
    type: "text" | "vision",
    webPageId?: string
  ): Promise<number[][]> {
    const column = SECTION_EMBEDDING_COLUMNS[type];
    const whereClause = webPageId
      ? `WHERE se.${column} IS NOT NULL AND sp.web_page_id = $1`
      : `WHERE se.${column} IS NOT NULL`;
    const params: unknown[] = webPageId ? [webPageId] : [];

    const query = `
      SELECT se.${column}::text AS embedding
      FROM section_embeddings se
      JOIN section_patterns sp ON sp.id = se.section_pattern_id
      ${whereClause}
      ORDER BY se.created_at DESC
      LIMIT 200
    `;

    const rows = await this.prisma.$queryRawUnsafe<Array<{ embedding: string }>>(query, ...params);

    return this.parseVectorRows(rows);
  }

  /**
   * パーツembeddingベクトルを取得
   */
  private async fetchPartVectors(type: "text" | "vision", webPageId?: string): Promise<number[][]> {
    const column = PART_EMBEDDING_COLUMNS[type];
    const whereClause = webPageId
      ? `WHERE cpe.${column} IS NOT NULL AND cp.web_page_id = $1`
      : `WHERE cpe.${column} IS NOT NULL`;
    const params: unknown[] = webPageId ? [webPageId] : [];

    const query = `
      SELECT cpe.${column}::text AS embedding
      FROM component_part_embeddings cpe
      JOIN component_parts cp ON cp.id = cpe.component_part_id
      ${whereClause}
      ORDER BY cpe.created_at DESC
      LIMIT 200
    `;

    const rows = await this.prisma.$queryRawUnsafe<Array<{ embedding: string }>>(query, ...params);

    return this.parseVectorRows(rows);
  }

  /**
   * pgvectorのテキスト表現をパースしてnumber[][]に変換
   * Parse pgvector text representation to number[][]
   */
  private parseVectorRows(rows: Array<{ embedding: string }>): number[][] {
    const vectors: number[][] = [];

    for (const row of rows) {
      try {
        // pgvector format: "[0.1,0.2,0.3,...]"
        const cleaned = row.embedding.replace(/^\[/, "").replace(/]$/, "");
        const values = cleaned.split(",").map(Number);

        // Validate dimension
        if (values.length !== EXPECTED_DIMENSIONS) continue;

        vectors.push(values);
      } catch {
        // Skip malformed rows
        continue;
      }
    }

    return vectors;
  }

  /**
   * ドリフト検出
   * Detect drift from baseline
   */
  private detectDrift(vectors: number[][], type: "text" | "vision"): DriftResult | null {
    const baseline = type === "text" ? this.textBaseline : this.visionBaseline;
    if (!baseline || vectors.length === 0) return null;

    const currentCentroid = calculateCentroid(vectors);
    if (!currentCentroid) return null;

    const distance = calculateCosineDistance(baseline.centroid, currentCentroid);
    if (!Number.isFinite(distance)) return null;

    return {
      distance,
      isWarning: distance > DRIFT_WARNING_THRESHOLD,
      baselineSampleCount: baseline.sampleCount,
      currentSampleCount: vectors.length,
    };
  }

  /**
   * 安全なパーセント計算
   * Safe percentage calculation
   */
  private safePercent(numerator: number, denominator: number): number {
    if (denominator <= 0) return 0;
    const pct = (numerator / denominator) * 100;
    return Number.isFinite(pct) ? Math.round(pct * 10) / 10 : 0;
  }
}
