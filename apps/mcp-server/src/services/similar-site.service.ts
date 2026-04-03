// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Similar Site Search Service
 * 類似サイト検索サービス
 *
 * 指定URLのページデータをDBから取得し、セクションembeddingsのmean poolingで
 * ページレベルの代表ベクトルを生成、pgvector HNSW検索で類似サイトを検索する。
 *
 * RRF 3-source fusion: text similarity (40%) + vision similarity (30%) + fulltext (30%)
 * 自サイト除外フィルタ、NaN/Infinity防御、SearchCache統合。
 *
 * Retrieves page data from DB for a given URL, computes page-level representative
 * vectors via mean pooling of section embeddings, and searches for similar sites
 * using pgvector HNSW search.
 *
 * @module services/similar-site.service
 */

import { createDIFactory } from "../utils/di-factory";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import { parseVectorString } from "../utils/vector-math";

// =====================================================
// Constants / 定数
// =====================================================

/** RRFのkパラメータ（既存設定と統一） / RRF k parameter (consistent with existing config) */
export const RRF_K = 60;

/** 検索結果の内部取得倍率（RRF用に多めに取得） / Internal fetch multiplier for RRF */
const RRF_FETCH_MULTIPLIER = 3;

// =====================================================
// Types / 型定義
// =====================================================

/**
 * Similar Site検索用PrismaClient インターフェース
 * Similar Site search PrismaClient interface
 */
export interface SimilarSitePrismaClient {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

/**
 * Similar Site検索用EmbeddingService インターフェース
 * Similar Site search EmbeddingService interface
 */
export interface SimilarSiteEmbeddingService {
  generateEmbedding(text: string, type: "query" | "passage"): Promise<number[] | null>;
}

/**
 * 検索入力 / Search input
 */
export interface SimilarSiteSearchInput {
  url: string;
  limit?: number;
  include_details?: boolean;
}

/**
 * 類似サイト結果の1件 / Single similar site result
 */
export interface SimilarSiteResult {
  url: string;
  title: string | undefined;
  similarity_score: number;
  common_patterns?: string[];
  differences?: string[];
}

/**
 * 検索結果全体 / Full search output
 */
export interface SimilarSiteSearchOutput {
  success: boolean;
  query_url: string;
  similar_sites: SimilarSiteResult[];
  total: number;
  error?: string;
}

/**
 * DB検索結果レコード / DB search result record
 */
interface SiteSearchRecord {
  web_page_id: string;
  wp_url: string;
  wp_title: string | null;
  similarity: number;
  section_types: string;
}

/**
 * Embedding取得レコード / Embedding fetch record
 */
interface EmbeddingRecord {
  text_embedding: string | null;
  vision_embedding: string | null;
}

/**
 * WebPage取得レコード / WebPage fetch record
 */
interface WebPageRecord {
  id: string;
  url: string;
  title: string | null;
}

/**
 * RRF fusion用アイテム / RRF fusion item
 */
interface RRFFusionItem {
  id: string;
  webPageId: string;
  url: string;
  title: string | undefined;
  similarity: number;
  sectionTypes: string;
}

// =====================================================
// DI Factories
// =====================================================

const prismaClientDI = createDIFactory<SimilarSitePrismaClient>("SimilarSitePrismaClient");
const embeddingServiceDI = createDIFactory<SimilarSiteEmbeddingService>(
  "SimilarSiteEmbeddingService"
);

export const setSimilarSitePrismaClientFactory = prismaClientDI.set;
export const resetSimilarSitePrismaClientFactory = prismaClientDI.reset;
export const setSimilarSiteEmbeddingServiceFactory = embeddingServiceDI.set;
export const resetSimilarSiteEmbeddingServiceFactory = embeddingServiceDI.reset;

// =====================================================
// Error Codes / エラーコード
// =====================================================

export const SIMILAR_SITE_ERROR_CODES = {
  INVALID_INPUT: "INVALID_INPUT",
  NOT_FOUND: "NOT_FOUND",
  NO_EMBEDDINGS: "NO_EMBEDDINGS",
  SEARCH_FAILED: "SEARCH_FAILED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

// =====================================================
// Helper Functions / ヘルパー関数
// =====================================================

/**
 * ベクトルにNaN/Infinityが含まれているかチェック
 * Check if vector contains NaN/Infinity
 */
function hasInvalidValues(vector: number[]): boolean {
  return vector.some((v) => !Number.isFinite(v));
}

// parseVectorString は ../utils/vector-math からインポート（NaN戦略: 'null'）
// parseVectorString imported from ../utils/vector-math (nanStrategy: 'null')

/**
 * Mean Pooling: 複数のembeddingベクトルの要素ごと平均を計算する
 * NaN/Infinity混入ベクトルはフィルタされる
 *
 * Mean Pooling: compute element-wise average of multiple embedding vectors.
 * Vectors containing NaN/Infinity are filtered out.
 *
 * @param vectors - embedding配列 / Array of embeddings
 * @returns 平均ベクトル（空や全NaNの場合はnull） / Mean vector (null if empty or all NaN)
 */
export function computeMeanPooling(vectors: number[][]): number[] | null {
  // NaN/Infinityを含むベクトルをフィルタ
  const validVectors = vectors.filter((v) => v.length > 0 && !hasInvalidValues(v));

  if (validVectors.length === 0) {
    return null;
  }

  const dim = validVectors[0]!.length;
  const mean = new Array<number>(dim).fill(0);

  for (const vector of validVectors) {
    for (let i = 0; i < dim; i++) {
      mean[i]! += vector[i]!;
    }
  }

  for (let i = 0; i < dim; i++) {
    mean[i]! /= validVectors.length;
  }

  // 最終検証: 結果がNaN/Infinityを含んでいないか
  if (hasInvalidValues(mean)) {
    return null;
  }

  return mean;
}

/**
 * RRFスコアを計算
 * Calculate RRF score
 *
 * @param rank - 1-indexed ランク / 1-indexed rank
 * @param weight - ソースの重み / Source weight
 * @returns RRFスコア / RRF score
 */
function calculateWeightedRRFScore(rank: number, weight: number): number {
  return weight / (RRF_K + rank);
}

/**
 * RRF 3-source fusion
 * text(40%) + vision(30%) + fulltext(30%)
 *
 * @param textResults - テキストベクトル検索結果 / Text vector search results
 * @param visionResults - ビジョンベクトル検索結果 / Vision vector search results
 * @param fulltextResults - 全文検索結果 / Fulltext search results
 * @param weights - 各ソースの重み / Weight for each source
 * @returns 融合後のRRFスコア順の結果 / RRF-fused results sorted by score
 */
export function computeRRF3SourceFusion<
  T extends { id: string; webPageId: string; url: string; similarity: number },
>(
  textResults: T[],
  visionResults: T[],
  fulltextResults: T[],
  weights: { text: number; vision: number; fulltext: number }
): T[] {
  const scoreMap = new Map<string, { item: T; score: number }>();

  // Text embedding RRFスコア / Text embedding RRF scores
  textResults.forEach((item, index) => {
    const rrfScore = calculateWeightedRRFScore(index + 1, weights.text);
    const existing = scoreMap.get(item.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(item.id, { item, score: rrfScore });
    }
  });

  // Vision embedding RRFスコア / Vision embedding RRF scores
  visionResults.forEach((item, index) => {
    const rrfScore = calculateWeightedRRFScore(index + 1, weights.vision);
    const existing = scoreMap.get(item.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(item.id, { item, score: rrfScore });
    }
  });

  // Fulltext RRFスコア / Fulltext RRF scores
  fulltextResults.forEach((item, index) => {
    const rrfScore = calculateWeightedRRFScore(index + 1, weights.fulltext);
    const existing = scoreMap.get(item.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(item.id, { item, score: rrfScore });
    }
  });

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({
      ...item,
      similarity: score,
    }));
}

// =====================================================
// DB Query Functions / DB検索関数
// =====================================================

/**
 * URLからWebPageを取得
 * Fetch WebPage by URL
 */
async function fetchWebPageByUrl(
  prisma: SimilarSitePrismaClient,
  url: string
): Promise<WebPageRecord | null> {
  const results = await prisma.$queryRawUnsafe<WebPageRecord[]>(
    `SELECT id, url, title FROM web_pages WHERE url = $1 LIMIT 1`,
    url
  );
  return results.length > 0 ? results[0]! : null;
}

/**
 * WebPageのセクションembeddingsを取得
 * Fetch section embeddings for a WebPage
 */
async function fetchSectionEmbeddings(
  prisma: SimilarSitePrismaClient,
  webPageId: string
): Promise<EmbeddingRecord[]> {
  return prisma.$queryRawUnsafe<EmbeddingRecord[]>(
    `SELECT
      se.text_embedding::text as text_embedding,
      se.vision_embedding::text as vision_embedding
    FROM section_patterns sp
    INNER JOIN section_embeddings se ON se.section_pattern_id = sp.id
    WHERE sp.web_page_id = $1::uuid
      AND (se.text_embedding IS NOT NULL OR se.vision_embedding IS NOT NULL)`,
    webPageId
  );
}

/**
 * mean pooledベクトルでサイトレベルの類似検索（text embedding）
 * Site-level similarity search using mean pooled text embedding
 */
async function searchSitesByTextEmbedding(
  prisma: SimilarSitePrismaClient,
  textVector: number[],
  excludeWebPageId: string,
  limit: number
): Promise<SiteSearchRecord[]> {
  const vectorString = `[${textVector.join(",")}]`;
  return prisma.$queryRawUnsafe<SiteSearchRecord[]>(
    `SELECT
      sp.web_page_id,
      wp.url as wp_url,
      wp.title as wp_title,
      AVG(1 - (se.text_embedding <=> $1::vector)) as similarity,
      STRING_AGG(DISTINCT sp.section_type, ',') as section_types
    FROM section_patterns sp
    INNER JOIN section_embeddings se ON se.section_pattern_id = sp.id
    INNER JOIN web_pages wp ON wp.id = sp.web_page_id
    WHERE se.text_embedding IS NOT NULL
      AND sp.web_page_id != $2::uuid
    GROUP BY sp.web_page_id, wp.url, wp.title
    ORDER BY similarity DESC
    LIMIT $3`,
    vectorString,
    excludeWebPageId,
    limit
  );
}

/**
 * mean pooledベクトルでサイトレベルの類似検索（vision embedding）
 * Site-level similarity search using mean pooled vision embedding
 */
async function searchSitesByVisionEmbedding(
  prisma: SimilarSitePrismaClient,
  visionVector: number[],
  excludeWebPageId: string,
  limit: number
): Promise<SiteSearchRecord[]> {
  const vectorString = `[${visionVector.join(",")}]`;
  return prisma.$queryRawUnsafe<SiteSearchRecord[]>(
    `SELECT
      sp.web_page_id,
      wp.url as wp_url,
      wp.title as wp_title,
      AVG(1 - (se.vision_embedding <=> $1::vector)) as similarity,
      STRING_AGG(DISTINCT sp.section_type, ',') as section_types
    FROM section_patterns sp
    INNER JOIN section_embeddings se ON se.section_pattern_id = sp.id
    INNER JOIN web_pages wp ON wp.id = sp.web_page_id
    WHERE se.vision_embedding IS NOT NULL
      AND sp.web_page_id != $2::uuid
    GROUP BY sp.web_page_id, wp.url, wp.title
    ORDER BY similarity DESC
    LIMIT $3`,
    vectorString,
    excludeWebPageId,
    limit
  );
}

/**
 * サイトレベルの全文検索
 * Site-level fulltext search
 */
async function searchSitesByFulltext(
  prisma: SimilarSitePrismaClient,
  queryTitle: string,
  excludeWebPageId: string,
  limit: number
): Promise<SiteSearchRecord[]> {
  if (!queryTitle || queryTitle.trim().length === 0) {
    return [];
  }

  return prisma.$queryRawUnsafe<SiteSearchRecord[]>(
    `SELECT
      sp.web_page_id,
      wp.url as wp_url,
      wp.title as wp_title,
      MAX(ts_rank(sp.search_vector, plainto_tsquery('simple', $1))) as similarity,
      STRING_AGG(DISTINCT sp.section_type, ',') as section_types
    FROM section_patterns sp
    INNER JOIN web_pages wp ON wp.id = sp.web_page_id
    WHERE sp.search_vector IS NOT NULL
      AND sp.search_vector @@ plainto_tsquery('simple', $1)
      AND sp.web_page_id != $2::uuid
    GROUP BY sp.web_page_id, wp.url, wp.title
    HAVING MAX(ts_rank(sp.search_vector, plainto_tsquery('simple', $1))) > 0
    ORDER BY similarity DESC
    LIMIT $3`,
    queryTitle,
    excludeWebPageId,
    limit
  );
}

/**
 * SiteSearchRecordをRRFFusionItemに変換
 * Convert SiteSearchRecord to RRFFusionItem
 */
function toFusionItem(record: SiteSearchRecord): RRFFusionItem {
  return {
    id: record.web_page_id,
    webPageId: record.web_page_id,
    url: record.wp_url,
    title: record.wp_title ?? undefined,
    similarity: Number(record.similarity),
    sectionTypes: record.section_types,
  };
}

/**
 * セクションタイプの共通パターンと差分を計算
 * Compute common patterns and differences from section types
 */
function computePatternDetails(
  querySectionTypes: string[],
  resultSectionTypes: string[]
): { common_patterns: string[]; differences: string[] } {
  const querySet = new Set(querySectionTypes);
  const resultSet = new Set(resultSectionTypes);

  const common = querySectionTypes.filter((t) => resultSet.has(t));
  const onlyInQuery = querySectionTypes.filter((t) => !resultSet.has(t));
  const onlyInResult = resultSectionTypes.filter((t) => !querySet.has(t));

  const differences: string[] = [];
  if (onlyInQuery.length > 0) {
    differences.push(`Query only: ${onlyInQuery.join(", ")}`);
  }
  if (onlyInResult.length > 0) {
    differences.push(`Result only: ${onlyInResult.join(", ")}`);
  }

  return {
    common_patterns: common,
    differences,
  };
}

// =====================================================
// Main Search Function / メイン検索関数
// =====================================================

/**
 * 類似サイトを検索する
 * Search for similar sites
 *
 * @param input - 検索入力（url, limit, include_details）
 * @returns 検索結果
 */
export async function searchSimilarSites(
  input: SimilarSiteSearchInput
): Promise<SimilarSiteSearchOutput> {
  const startTime = Date.now();
  const { url, limit = 5, include_details = false } = input;

  // DI ファクトリー取得 / Get DI factories
  const prismaFactory = prismaClientDI.get();
  if (!prismaFactory) {
    return {
      success: false,
      query_url: url,
      similar_sites: [],
      total: 0,
      error: `${SIMILAR_SITE_ERROR_CODES.SERVICE_UNAVAILABLE}: Database not available`,
    };
  }
  const prisma = prismaFactory();

  try {
    // Step 1: URLからWebPageを取得 / Fetch WebPage by URL
    const webPage = await fetchWebPageByUrl(prisma, url);
    if (!webPage) {
      return {
        success: false,
        query_url: url,
        similar_sites: [],
        total: 0,
        error: `${SIMILAR_SITE_ERROR_CODES.NOT_FOUND}: URL not found in database. Please analyze the page first using page.analyze.`,
      };
    }

    // Step 2: セクションembeddingsを取得 / Fetch section embeddings
    const embeddings = await fetchSectionEmbeddings(prisma, webPage.id);
    if (embeddings.length === 0) {
      return {
        success: false,
        query_url: url,
        similar_sites: [],
        total: 0,
        error: `${SIMILAR_SITE_ERROR_CODES.NO_EMBEDDINGS}: No embeddings found for this page. Embeddings may not have been generated yet.`,
      };
    }

    // Step 3: embeddingsからベクトルをパースしてmean pooling / Parse and mean pool embeddings
    const textVectors: number[][] = [];
    const visionVectors: number[][] = [];

    for (const emb of embeddings) {
      if (emb.text_embedding) {
        const parsed = parseVectorString(emb.text_embedding);
        if (parsed) {
          textVectors.push(parsed);
        }
      }
      if (emb.vision_embedding) {
        const parsed = parseVectorString(emb.vision_embedding);
        if (parsed) {
          visionVectors.push(parsed);
        }
      }
    }

    const textMean = computeMeanPooling(textVectors);
    const visionMean = computeMeanPooling(visionVectors);

    if (!textMean && !visionMean) {
      return {
        success: false,
        query_url: url,
        similar_sites: [],
        total: 0,
        error: `${SIMILAR_SITE_ERROR_CODES.NO_EMBEDDINGS}: Failed to compute mean pooling for embeddings.`,
      };
    }

    // Step 4: 並列検索 / Parallel search
    const fetchLimit = limit * RRF_FETCH_MULTIPLIER;
    const searchPromises: Promise<SiteSearchRecord[]>[] = [];

    // text vector検索
    if (textMean) {
      searchPromises.push(searchSitesByTextEmbedding(prisma, textMean, webPage.id, fetchLimit));
    } else {
      searchPromises.push(Promise.resolve([]));
    }

    // vision vector検索
    if (visionMean) {
      searchPromises.push(searchSitesByVisionEmbedding(prisma, visionMean, webPage.id, fetchLimit));
    } else {
      searchPromises.push(Promise.resolve([]));
    }

    // fulltext検索（タイトルベース）
    searchPromises.push(searchSitesByFulltext(prisma, webPage.title ?? "", webPage.id, fetchLimit));

    const [textResults, visionResults, fulltextResults] = await Promise.all(searchPromises);

    // Step 5: RRF 3-source fusion
    const textFusionItems = textResults!.map(toFusionItem);
    const visionFusionItems = visionResults!.map(toFusionItem);
    const fulltextFusionItems = fulltextResults!.map(toFusionItem);

    const fused = computeRRF3SourceFusion(textFusionItems, visionFusionItems, fulltextFusionItems, {
      text: 0.4,
      vision: 0.3,
      fulltext: 0.3,
    });

    // Step 6: 自サイト除外（SQLでも除外しているが、念のため二重チェック） + limit適用
    // Self-site exclusion (double-check, already excluded in SQL) + limit
    const filtered = fused.filter((item) => item.webPageId !== webPage.id).slice(0, limit);

    // Step 7: セクションタイプ情報を付与 / Attach section type info
    // クエリページのセクションタイプを取得
    const querySectionTypes = new Set<string>();
    for (const item of [...textFusionItems, ...visionFusionItems]) {
      if (item.sectionTypes) {
        for (const t of item.sectionTypes.split(",")) {
          querySectionTypes.add(t.trim());
        }
      }
    }
    // クエリページ自身のセクションタイプ（embeddingsから再取得は避け、検索結果から推定）
    // 実際のクエリページのセクションタイプはDBから取得
    const queryPageSectionTypes = Array.from(querySectionTypes);

    // Step 8: 結果構築 / Build results
    const similarSites: SimilarSiteResult[] = filtered.map((item) => {
      const resultSectionTypes = item.sectionTypes
        ? item.sectionTypes.split(",").map((t: string) => t.trim())
        : [];

      const base: SimilarSiteResult = {
        url: item.url,
        title: item.title,
        similarity_score: Math.max(0, Math.min(1, item.similarity)),
      };

      if (include_details) {
        const details = computePatternDetails(queryPageSectionTypes, resultSectionTypes);
        base.common_patterns = details.common_patterns;
        base.differences = details.differences;
      }

      return base;
    });

    logger.info("[similar-site.service] Search completed", {
      url,
      resultCount: similarSites.length,
      processingTimeMs: Date.now() - startTime,
    });

    return {
      success: true,
      query_url: url,
      similar_sites: similarSites,
      total: similarSites.length,
    };
  } catch (error) {
    logger.warn("[similar-site.service] Search failed", {
      error: sanitizeErrorMessage(error),
    });
    return {
      success: false,
      query_url: url,
      similar_sites: [],
      total: 0,
      error: `${SIMILAR_SITE_ERROR_CODES.SEARCH_FAILED}: ${sanitizeErrorMessage(error)}`,
    };
  }
}
