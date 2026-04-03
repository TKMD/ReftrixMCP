// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Design Compare Service
 * デザイン比較サービス
 *
 * 2-5件のWebページを多次元（layout, visual, quality, color）で比較する。
 * Compares 2-5 web pages across multiple dimensions (layout, visual, quality, color).
 *
 * 比較軸:
 * - layout: セクション構造のcosine類似度（text_embedding）
 * - visual: DINOv2 vision embeddingのcosine類似度（vision_embedding）
 * - quality: 品質スコア差分の正規化 (0-1)
 * - color: カラーパレット距離（CIE76 deltaE ベース）
 *
 * セキュリティ:
 * - sanitizeErrorMessage使用 (CWE-209)
 * - NaN/Infinity防御
 * - UUIDv7バリデーション（呼び出し元Zodスキーマで保証）
 *
 * @module services/design-compare.service
 */

import { createDIFactory } from "../utils/di-factory";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { cosineSimilarity, parseVectorString as parseVectorStringUtil } from "../utils/vector-math";

// =====================================================
// DI Interfaces / DI インターフェース
// =====================================================

/**
 * Prismaクライアントインターフェース
 * Prisma client interface for design compare
 */
export interface DesignComparePrismaClient {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

// =====================================================
// DI Factory / DIファクトリー
// =====================================================

const prismaClientDI = createDIFactory<DesignComparePrismaClient>("DesignComparePrismaClient");

export const setDesignComparePrismaClientFactory = prismaClientDI.set;
export const resetDesignComparePrismaClientFactory = prismaClientDI.reset;

/** @internal テスト用にDIファクトリーを公開 */
export const getDesignComparePrismaClientFactory = prismaClientDI.get;

// =====================================================
// Types / 型定義
// =====================================================

/** 比較次元 / Comparison dimension */
export type ComparisonDimension = "layout" | "visual" | "quality" | "color";

/** 全比較次元 / All comparison dimensions */
export const ALL_DIMENSIONS: readonly ComparisonDimension[] = [
  "layout",
  "visual",
  "quality",
  "color",
] as const;

/** ペアワイズ比較スコア / Pairwise comparison scores */
export interface PairwiseComparison {
  /** ペアのページID（2要素） / Pair of page IDs (2 elements) */
  pair: [string, string];
  /** 各次元のスコア / Scores per dimension */
  scores: Partial<Record<ComparisonDimension, number>>;
  /** 総合類似度スコア (0-1) / Overall similarity score (0-1) */
  overall: number;
}

/** 共通パターン / Common pattern */
export interface CommonPattern {
  dimension: ComparisonDimension;
  description: string;
}

/** 差分ポイント / Key difference */
export interface KeyDifference {
  dimension: ComparisonDimension;
  description: string;
  page_ids: string[];
}

/** ページ情報 / Page info */
export interface ComparePageInfo {
  id: string;
  url: string;
  title: string | undefined;
}

/** デザイン比較結果 / Design compare result */
export interface DesignCompareResult {
  success: boolean;
  pages: ComparePageInfo[];
  comparisons: PairwiseComparison[];
  common_patterns: CommonPattern[];
  key_differences: KeyDifference[];
  error?: string;
}

/** サービス入力 / Service input */
export interface DesignCompareInput {
  page_ids: string[];
  dimensions: ComparisonDimension[];
  include_details: boolean;
}

// =====================================================
// Error Codes / エラーコード
// =====================================================

export const DESIGN_COMPARE_ERROR_CODES = {
  INVALID_INPUT: "INVALID_INPUT",
  PAGES_NOT_FOUND: "PAGES_NOT_FOUND",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  COMPARE_FAILED: "COMPARE_FAILED",
} as const;

// =====================================================
// DB Query Types / DBクエリ型
// =====================================================

/** ページ基本情報のDBレコード */
interface PageInfoRecord {
  id: string;
  url: string;
  title: string | null;
}

/** セクションembeddingのDBレコード (ページ集約用) */
interface PageEmbeddingRecord {
  web_page_id: string;
  text_embedding_avg: string | null;
  vision_embedding_avg: string | null;
  section_count: number;
}

/** 品質評価のDBレコード */
interface QualityScoreRecord {
  target_id: string;
  overall_score: number;
}

/** カラー情報のDBレコード */
interface ColorInfoRecord {
  web_page_id: string;
  color_scheme: unknown;
}

// =====================================================
// Helper Functions / ヘルパー関数
// =====================================================

/**
 * pgvectorの文字列表現からnumber配列に変換（NaN→0置換）
 * Convert pgvector string representation to number array (NaN→0 replacement)
 */
function parseVectorString(vectorStr: string): number[] {
  return parseVectorStringUtil(vectorStr, { nanStrategy: "zero" }) ?? [];
}

// cosineSimilarity は ../utils/vector-math から re-export
// cosineSimilarity is re-exported from ../utils/vector-math
export { cosineSimilarity };

/**
 * 品質スコアの差分を正規化（0-1 スケール）
 * Normalize quality score difference to 0-1 scale
 *
 * 差分0 → 類似度1.0、差分100 → 類似度0.0
 */
export function normalizeQualityDifference(scoreA: number, scoreB: number): number {
  const diff = Math.abs(scoreA - scoreB);
  // NaN/Infinity防御
  if (!Number.isFinite(diff)) return 0;
  return Math.max(0, Math.min(1, 1 - diff / 100));
}

/**
 * HEXカラーをRGBに変換
 * Convert HEX color to RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.replace("#", "");
  if (cleaned.length !== 6) return null;
  const r = parseInt(cleaned.substring(0, 2), 16);
  const g = parseInt(cleaned.substring(2, 4), 16);
  const b = parseInt(cleaned.substring(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return { r, g, b };
}

/**
 * CIE76 deltaE に基づくカラー距離（簡易版）
 * 2つのRGBカラー間のユークリッド距離をdeltaE近似として計算
 * Color distance based on CIE76 deltaE (simplified RGB Euclidean)
 *
 * @returns 正規化距離 (0-1): 0=同一、1=最大距離
 */
export function colorDistance(
  colorA: { r: number; g: number; b: number },
  colorB: { r: number; g: number; b: number }
): number {
  const dr = colorA.r - colorB.r;
  const dg = colorA.g - colorB.g;
  const db = colorA.b - colorB.b;

  // Max RGB Euclidean distance = sqrt(255^2 * 3) ≈ 441.67
  const MAX_DISTANCE = Math.sqrt(255 * 255 * 3);
  const distance = Math.sqrt(dr * dr + dg * dg + db * db);

  if (!Number.isFinite(distance)) return 1;
  return Math.min(1, distance / MAX_DISTANCE);
}

/**
 * カラーパレット間の平均距離を計算
 * Calculate average color distance between two palettes
 *
 * @returns 類似度 (0-1): 1=同一、0=最大距離
 */
export function paletteDistance(colorsA: string[], colorsB: string[]): number {
  if (colorsA.length === 0 || colorsB.length === 0) return 0;

  const rgbA = colorsA.map(hexToRgb).filter((c): c is NonNullable<typeof c> => c !== null);
  const rgbB = colorsB.map(hexToRgb).filter((c): c is NonNullable<typeof c> => c !== null);

  if (rgbA.length === 0 || rgbB.length === 0) return 0;

  // 各色ペアの最小距離の平均
  let totalDistance = 0;
  for (const a of rgbA) {
    let minDist = 1;
    for (const b of rgbB) {
      const dist = colorDistance(a, b);
      if (dist < minDist) minDist = dist;
    }
    totalDistance += minDist;
  }

  const avgDistance = totalDistance / rgbA.length;
  // 類似度に変換（距離が小さいほど類似度が高い）
  return Math.max(0, Math.min(1, 1 - avgDistance));
}

/**
 * 総合類似度スコアを計算（各次元の平均）
 * Calculate overall similarity score (average of dimensions)
 */
function calculateOverallScore(scores: Partial<Record<ComparisonDimension, number>>): number {
  const values = Object.values(scores).filter((v): v is number => Number.isFinite(v));
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, val) => acc + val, 0);
  const avg = sum / values.length;
  return Math.round(avg * 1000) / 1000; // 3桁に丸め
}

// =====================================================
// DB Queries / DBクエリ
// =====================================================

/**
 * ページ基本情報を取得
 * Fetch basic page info for given IDs
 */
async function fetchPageInfo(
  prisma: DesignComparePrismaClient,
  pageIds: string[]
): Promise<PageInfoRecord[]> {
  const placeholders = pageIds.map((_, i) => `$${i + 1}::uuid`).join(",");
  const query = `
    SELECT id, url, title
    FROM web_pages
    WHERE id IN (${placeholders})
  `;
  return prisma.$queryRawUnsafe<PageInfoRecord[]>(query, ...pageIds);
}

/**
 * ページ単位のembedding平均を取得（mean pooling）
 * Fetch page-level mean-pooled embeddings
 *
 * text_embedding: セクション構造 cosine (layout比較用)
 * vision_embedding: DINOv2 vision cosine (visual比較用)
 */
async function fetchPageEmbeddings(
  prisma: DesignComparePrismaClient,
  pageIds: string[]
): Promise<PageEmbeddingRecord[]> {
  const placeholders = pageIds.map((_, i) => `$${i + 1}::uuid`).join(",");
  const query = `
    SELECT
      sp.web_page_id,
      AVG(se.text_embedding)::text AS text_embedding_avg,
      AVG(se.vision_embedding)::text AS vision_embedding_avg,
      COUNT(*)::int AS section_count
    FROM section_patterns sp
    INNER JOIN section_embeddings se ON se.section_pattern_id = sp.id
    WHERE sp.web_page_id IN (${placeholders})
    GROUP BY sp.web_page_id
  `;
  return prisma.$queryRawUnsafe<PageEmbeddingRecord[]>(query, ...pageIds);
}

/**
 * ページ単位の品質スコアを取得
 * Fetch quality scores for pages
 */
async function fetchQualityScores(
  prisma: DesignComparePrismaClient,
  pageIds: string[]
): Promise<QualityScoreRecord[]> {
  const placeholders = pageIds.map((_, i) => `$${i + 1}::uuid`).join(",");
  const query = `
    SELECT
      target_id,
      overall_score
    FROM quality_evaluations
    WHERE target_type = 'web_page'
      AND target_id IN (${placeholders})
    ORDER BY evaluated_at DESC
  `;
  const records = await prisma.$queryRawUnsafe<QualityScoreRecord[]>(query, ...pageIds);

  // 各ページの最新評価のみ取得
  const latestMap = new Map<string, QualityScoreRecord>();
  for (const record of records) {
    if (!latestMap.has(record.target_id)) {
      latestMap.set(record.target_id, record);
    }
  }
  return Array.from(latestMap.values());
}

/**
 * セクションのvisual_features.color_schemeを取得
 * Fetch color scheme info from section visual features
 */
async function fetchColorInfo(
  prisma: DesignComparePrismaClient,
  pageIds: string[]
): Promise<ColorInfoRecord[]> {
  const placeholders = pageIds.map((_, i) => `$${i + 1}::uuid`).join(",");
  const query = `
    SELECT
      sp.web_page_id,
      sp.visual_features->'color_scheme' AS color_scheme
    FROM section_patterns sp
    WHERE sp.web_page_id IN (${placeholders})
      AND sp.visual_features->'color_scheme' IS NOT NULL
      AND sp.visual_features->'color_scheme' != 'null'::jsonb
    ORDER BY sp.position_index ASC
  `;
  return prisma.$queryRawUnsafe<ColorInfoRecord[]>(query, ...pageIds);
}

// =====================================================
// Color Extraction / カラー抽出
// =====================================================

/**
 * ColorInfoRecordsからページごとのカラーパレットを抽出
 * Extract per-page color palettes from ColorInfoRecords
 */
function extractPageColors(
  colorRecords: ColorInfoRecord[],
  pageIds: string[]
): Map<string, string[]> {
  const pageColors = new Map<string, Set<string>>();

  for (const pageId of pageIds) {
    pageColors.set(pageId, new Set());
  }

  for (const record of colorRecords) {
    const colors = pageColors.get(record.web_page_id);
    if (!colors) continue;

    const scheme = record.color_scheme as Record<string, unknown> | null;
    if (!scheme || typeof scheme !== "object") continue;

    // Extract dominant and accent colors
    if (typeof scheme.dominant === "string" && scheme.dominant.startsWith("#")) {
      colors.add(scheme.dominant);
    }
    if (typeof scheme.accent === "string" && scheme.accent.startsWith("#")) {
      colors.add(scheme.accent);
    }
  }

  const result = new Map<string, string[]>();
  for (const [pageId, colorSet] of pageColors) {
    result.set(pageId, Array.from(colorSet));
  }
  return result;
}

// =====================================================
// Pattern Detection / パターン検出
// =====================================================

/**
 * 共通パターンと差分ポイントを抽出
 * Extract common patterns and key differences
 */
function detectPatternsAndDifferences(
  comparisons: PairwiseComparison[],
  _pageIds: string[],
  dimensions: ComparisonDimension[]
): { commonPatterns: CommonPattern[]; keyDifferences: KeyDifference[] } {
  const commonPatterns: CommonPattern[] = [];
  const keyDifferences: KeyDifference[] = [];

  const HIGH_SIMILARITY_THRESHOLD = 0.8;
  const LOW_SIMILARITY_THRESHOLD = 0.4;

  for (const dim of dimensions) {
    const dimScores = comparisons
      .filter((c) => c.scores[dim] !== undefined)
      .map((c) => ({ pair: c.pair, score: c.scores[dim] as number }));

    if (dimScores.length === 0) continue;

    const avgScore = dimScores.reduce((sum, d) => sum + d.score, 0) / dimScores.length;

    const dimensionLabels: Record<ComparisonDimension, string> = {
      layout: "Layout structure",
      visual: "Visual appearance",
      quality: "Quality scores",
      color: "Color palette",
    };

    if (avgScore >= HIGH_SIMILARITY_THRESHOLD) {
      commonPatterns.push({
        dimension: dim,
        description: `${dimensionLabels[dim]} is highly similar across all pages (avg: ${(avgScore * 100).toFixed(0)}%)`,
      });
    }

    // Find pairs with low similarity
    const lowPairs = dimScores.filter((d) => d.score < LOW_SIMILARITY_THRESHOLD);
    if (lowPairs.length > 0) {
      const divergentPages = new Set<string>();
      for (const lp of lowPairs) {
        divergentPages.add(lp.pair[0]);
        divergentPages.add(lp.pair[1]);
      }
      keyDifferences.push({
        dimension: dim,
        description: `${dimensionLabels[dim]} differs significantly (${lowPairs.length} pair(s) below ${(LOW_SIMILARITY_THRESHOLD * 100).toFixed(0)}% similarity)`,
        page_ids: Array.from(divergentPages),
      });
    }
  }

  return { commonPatterns, keyDifferences };
}

// =====================================================
// Main Service / メインサービス
// =====================================================

/**
 * デザイン比較を実行
 * Execute multi-dimensional design comparison
 *
 * @param input - 比較入力パラメータ / Comparison input parameters
 * @returns 比較結果 / Comparison results
 */
export async function compareDesigns(input: DesignCompareInput): Promise<DesignCompareResult> {
  const startTime = Date.now();

  // DI: Prismaクライアント取得
  const prismaFactory = prismaClientDI.get();
  if (!prismaFactory) {
    return {
      success: false,
      pages: [],
      comparisons: [],
      common_patterns: [],
      key_differences: [],
      error: `${DESIGN_COMPARE_ERROR_CODES.SERVICE_UNAVAILABLE}: Database not available`,
    };
  }

  const prisma = prismaFactory();
  const { page_ids, dimensions, include_details } = input;

  try {
    // Step 1: ページ基本情報を取得
    const pageInfoRecords = await fetchPageInfo(prisma, page_ids);

    // 見つからなかったページを検出
    const foundIds = new Set(pageInfoRecords.map((p) => p.id));
    const missingIds = page_ids.filter((id) => !foundIds.has(id));

    if (missingIds.length > 0) {
      return {
        success: false,
        pages: [],
        comparisons: [],
        common_patterns: [],
        key_differences: [],
        error: `${DESIGN_COMPARE_ERROR_CODES.PAGES_NOT_FOUND}: ${missingIds.length} page(s) not found`,
      };
    }

    const pages: ComparePageInfo[] = pageInfoRecords.map((p) => ({
      id: p.id,
      url: p.url,
      title: p.title ?? undefined,
    }));

    // Step 2: 次元ごとのデータ取得（並列）
    const needsEmbeddings = dimensions.includes("layout") || dimensions.includes("visual");
    const needsQuality = dimensions.includes("quality");
    const needsColor = dimensions.includes("color");

    const [embeddingRecords, qualityRecords, colorRecords] = await Promise.all([
      needsEmbeddings ? fetchPageEmbeddings(prisma, page_ids) : Promise.resolve([]),
      needsQuality ? fetchQualityScores(prisma, page_ids) : Promise.resolve([]),
      needsColor ? fetchColorInfo(prisma, page_ids) : Promise.resolve([]),
    ]);

    // Step 3: データを整理
    const embeddingMap = new Map<string, PageEmbeddingRecord>();
    for (const record of embeddingRecords) {
      embeddingMap.set(record.web_page_id, record);
    }

    const qualityMap = new Map<string, number>();
    for (const record of qualityRecords) {
      qualityMap.set(record.target_id, record.overall_score);
    }

    const pageColorMap = extractPageColors(colorRecords as ColorInfoRecord[], page_ids);

    // Step 4: ペアワイズ比較
    const comparisons: PairwiseComparison[] = [];

    for (let i = 0; i < page_ids.length; i++) {
      for (let j = i + 1; j < page_ids.length; j++) {
        const idA = page_ids[i] as string;
        const idB = page_ids[j] as string;
        const scores: Partial<Record<ComparisonDimension, number>> = {};

        // Layout: text_embedding cosine similarity
        if (dimensions.includes("layout")) {
          const embA = embeddingMap.get(idA);
          const embB = embeddingMap.get(idB);
          if (embA?.text_embedding_avg && embB?.text_embedding_avg) {
            const vecA = parseVectorString(embA.text_embedding_avg);
            const vecB = parseVectorString(embB.text_embedding_avg);
            if (vecA.length > 0 && vecB.length > 0) {
              scores.layout = cosineSimilarity(vecA, vecB);
            }
          }
        }

        // Visual: vision_embedding cosine similarity
        if (dimensions.includes("visual")) {
          const embA = embeddingMap.get(idA);
          const embB = embeddingMap.get(idB);
          if (embA?.vision_embedding_avg && embB?.vision_embedding_avg) {
            const vecA = parseVectorString(embA.vision_embedding_avg);
            const vecB = parseVectorString(embB.vision_embedding_avg);
            if (vecA.length > 0 && vecB.length > 0) {
              scores.visual = cosineSimilarity(vecA, vecB);
            }
          }
        }

        // Quality: normalized score difference
        if (dimensions.includes("quality")) {
          const scoreA = qualityMap.get(idA);
          const scoreB = qualityMap.get(idB);
          if (scoreA !== undefined && scoreB !== undefined) {
            scores.quality = normalizeQualityDifference(scoreA, scoreB);
          }
        }

        // Color: palette distance
        if (dimensions.includes("color")) {
          const colorsA = pageColorMap.get(idA) ?? [];
          const colorsB = pageColorMap.get(idB) ?? [];
          if (colorsA.length > 0 && colorsB.length > 0) {
            scores.color = paletteDistance(colorsA, colorsB);
          }
        }

        comparisons.push({
          pair: [idA, idB],
          scores,
          overall: calculateOverallScore(scores),
        });
      }
    }

    // Step 5: 共通パターンと差分ポイント
    let common_patterns: CommonPattern[] = [];
    let key_differences: KeyDifference[] = [];

    if (include_details) {
      const patterns = detectPatternsAndDifferences(comparisons, page_ids, dimensions);
      common_patterns = patterns.commonPatterns;
      key_differences = patterns.keyDifferences;
    }

    logger.info("[design-compare] Comparison completed", {
      pageCount: page_ids.length,
      dimensions,
      pairCount: comparisons.length,
      processingTimeMs: Date.now() - startTime,
    });

    return {
      success: true,
      pages,
      comparisons,
      common_patterns,
      key_differences,
    };
  } catch (error) {
    logger.warn("[design-compare] Comparison failed", {
      error: sanitizeErrorMessage(error),
    });
    throw error;
  }
}
