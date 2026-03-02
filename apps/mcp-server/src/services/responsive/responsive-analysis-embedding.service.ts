// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Analysis Embedding Service
 *
 * ResponsiveAnalysis レコードからテキスト表現を生成し、
 * multilingual-e5-base (768D) Embedding を生成・DB保存するサービス。
 * pgvector HNSW cosine similarity を使用したセマンティック検索も提供。
 *
 * パターン:
 * - BackgroundDesignEmbedding と同一の DI パターン
 * - passage: プレフィックスでドキュメント Embedding 生成
 * - query: プレフィックスで検索クエリ Embedding 生成
 * - 2段階DB保存: Prisma create → raw SQL で vector 更新
 * - Graceful Degradation（部分失敗時も継続）
 *
 * @module services/responsive/responsive-analysis-embedding
 */

import { isDevelopment, logger } from '../../utils/logger';

// =====================================================
// 型定義
// =====================================================

/**
 * Embedding 生成用のレスポンシブ分析データ
 */
export interface ResponsiveAnalysisForText {
  /** レスポンシブ分析ID */
  id: string;
  /** 関連WebPageのURL */
  url?: string | undefined;
  /** 分析対象ビューポート */
  viewportsAnalyzed: Array<{
    name: string;
    width: number;
    height: number;
  }>;
  /** ビューポート間の差異 */
  differences: Array<{
    category: string;
    selector?: string;
    description: string;
    viewports?: string[];
  }>;
  /** 検出されたブレークポイント */
  breakpoints?: Array<{
    width: number;
    type?: string;
  }> | undefined;
  /** スクリーンショット差分 */
  screenshotDiffs?: Array<{
    viewport1: string;
    viewport2: string;
    diffPercentage: number;
  }> | undefined;
}

/**
 * Embedding 生成結果
 */
export interface ResponsiveAnalysisEmbeddingResult {
  /** 全体の成功フラグ（部分成功でもtrue） */
  success: boolean;
  /** 生成成功件数 */
  generatedCount: number;
  /** 生成失敗件数 */
  failedCount: number;
  /** エラー詳細配列 */
  errors: Array<{
    id: string;
    error: string;
  }>;
}

// =====================================================
// EmbeddingService インターフェース（DI用）
// =====================================================

interface IResponsiveEmbeddingService {
  generateFromText(text: string): Promise<{
    embedding: number[];
    modelName: string;
    textUsed: string;
    processingTimeMs: number;
  }>;
}

let responsiveEmbeddingServiceFactory: (() => IResponsiveEmbeddingService) | null = null;

export function setResponsiveEmbeddingServiceFactory(
  factory: () => IResponsiveEmbeddingService
): void {
  responsiveEmbeddingServiceFactory = factory;
}

export function resetResponsiveEmbeddingServiceFactory(): void {
  responsiveEmbeddingServiceFactory = null;
}

// =====================================================
// PrismaClient インターフェース（DI用）
// =====================================================

interface IResponsivePrismaClient {
  responsiveAnalysisEmbedding: {
    create: (args: {
      data: {
        responsiveAnalysisId: string;
        textRepresentation: string;
        modelVersion: string;
      };
    }) => Promise<{ id: string }>;
  };
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
}

let responsivePrismaClientFactory: (() => IResponsivePrismaClient) | null = null;

export function setResponsivePrismaClientFactory(
  factory: () => IResponsivePrismaClient
): void {
  responsivePrismaClientFactory = factory;
}

export function resetResponsivePrismaClientFactory(): void {
  responsivePrismaClientFactory = null;
}

// =====================================================
// ヘルパー: サービス取得
// =====================================================

function getEmbeddingService(): IResponsiveEmbeddingService {
  if (responsiveEmbeddingServiceFactory) {
    return responsiveEmbeddingServiceFactory();
  }
  throw new Error(
    'ResponsiveEmbeddingService not initialized. Use setResponsiveEmbeddingServiceFactory.'
  );
}

function getPrismaClient(): IResponsivePrismaClient {
  if (responsivePrismaClientFactory) {
    return responsivePrismaClientFactory();
  }
  throw new Error(
    'ResponsivePrismaClient not initialized. Use setResponsivePrismaClientFactory.'
  );
}

// =====================================================
// テキスト表現生成
// =====================================================

/**
 * ResponsiveAnalysis からセマンティック検索用テキスト表現を生成
 *
 * E5 モデルの passage: プレフィックスを付与し、
 * レスポンシブ分析の特徴を構造化テキストとして表現する。
 *
 * @param analysis - レスポンシブ分析データ
 * @returns passage: プレフィックス付きテキスト表現
 */
export function generateResponsiveAnalysisTextRepresentation(
  analysis: ResponsiveAnalysisForText
): string {
  const parts: string[] = [];

  // URL
  if (analysis.url) {
    parts.push(`Responsive analysis: ${analysis.url}`);
  } else {
    parts.push('Responsive analysis');
  }

  // ビューポート情報
  if (analysis.viewportsAnalyzed.length > 0) {
    const viewportDescriptions = analysis.viewportsAnalyzed
      .map((v) => `${v.name}(${v.width}x${v.height})`)
      .join(', ');
    parts.push(`Viewports: ${viewportDescriptions}`);
  }

  // 差異情報
  if (analysis.differences.length > 0) {
    const diffLines = analysis.differences
      .slice(0, 20) // 最大20件に制限（テキスト長制御）
      .map((d) => {
        const selector = d.selector ? ` ${d.selector}` : '';
        return `- [${d.category}]${selector}: ${d.description}`;
      });
    parts.push(`Differences:\n${diffLines.join('\n')}`);
  }

  // ブレークポイント
  if (analysis.breakpoints && analysis.breakpoints.length > 0) {
    const bpValues = analysis.breakpoints
      .map((bp) => `${bp.width}px`)
      .join(', ');
    parts.push(`Breakpoints: ${bpValues}`);
  }

  // スクリーンショット差分
  if (analysis.screenshotDiffs && analysis.screenshotDiffs.length > 0) {
    const diffDescriptions = analysis.screenshotDiffs
      .map((sd) => `${sd.viewport1}↔${sd.viewport2} ${sd.diffPercentage.toFixed(1)}%`)
      .join(', ');
    parts.push(`Visual diff: ${diffDescriptions}`);
  }

  return `passage: ${parts.join('\n')}`;
}

// =====================================================
// Embedding 生成 + DB 保存
// =====================================================

/**
 * ResponsiveAnalysis 配列から Embedding を生成し DB に保存
 *
 * 処理フロー:
 * 1. テキスト表現を生成（passage: プレフィックス付き）
 * 2. EmbeddingService で 768D ベクトルを生成
 * 3. ResponsiveAnalysisEmbedding レコードを Prisma で create
 * 4. pgvector 形式で embedding カラムを raw SQL で更新
 *
 * Graceful Degradation: 個別の失敗は全体を止めない
 *
 * @param analyses - レスポンシブ分析データ配列
 * @param onProgress - 進捗コールバック
 * @returns 生成結果
 */
/**
 * Worker向けオーバーロード: responsiveAnalysisId 配列 + 直接サービス注入
 *
 * DBからResponsiveAnalysis データを取得し、Embedding を生成・保存する。
 * WorkerプロセスではDIファクトリが未設定のため、サービスを直接渡す。
 */
export async function generateResponsiveAnalysisEmbeddings(
  analysisIds: string[],
  embeddingServiceDirect: IResponsiveEmbeddingService,
  prismaDirect: IResponsivePrismaClient,
): Promise<ResponsiveAnalysisEmbeddingResult>;
/**
 * 標準オーバーロード: ResponsiveAnalysisForText 配列 + DIファクトリ
 */
// eslint-disable-next-line no-redeclare -- TypeScript function overloads
export async function generateResponsiveAnalysisEmbeddings(
  analyses: ResponsiveAnalysisForText[],
  onProgress?: (completed: number, total: number) => void,
): Promise<ResponsiveAnalysisEmbeddingResult>;
// eslint-disable-next-line no-redeclare -- TypeScript function overloads
export async function generateResponsiveAnalysisEmbeddings(
  analysesOrIds: ResponsiveAnalysisForText[] | string[],
  embeddingServiceOrProgress?: IResponsiveEmbeddingService | ((completed: number, total: number) => void),
  prismaDirect?: IResponsivePrismaClient,
): Promise<ResponsiveAnalysisEmbeddingResult> {
  const result: ResponsiveAnalysisEmbeddingResult = {
    success: true,
    generatedCount: 0,
    failedCount: 0,
    errors: [],
  };

  if (analysesOrIds.length === 0) {
    return result;
  }

  // Determine if this is the Worker overload (string[] + direct services)
  const isWorkerOverload = typeof analysesOrIds[0] === 'string' && prismaDirect !== undefined;

  let analyses: ResponsiveAnalysisForText[];
  let embeddingService: IResponsiveEmbeddingService;
  let prismaClient: IResponsivePrismaClient;
  let onProgress: ((completed: number, total: number) => void) | undefined;

  if (isWorkerOverload) {
    embeddingService = embeddingServiceOrProgress as IResponsiveEmbeddingService;
    prismaClient = prismaDirect!;
    // Fetch analyses from DB
    const ids = analysesOrIds as string[];
    try {
      const rows = await prismaClient.$queryRawUnsafe<Array<{
        id: string;
        url: string | null;
        viewports_analyzed: unknown;
        differences: unknown;
        breakpoints: unknown;
        screenshot_diffs: unknown;
      }>>(
        `SELECT ra.id, wp.url, ra.viewports_analyzed, ra.differences, ra.breakpoints, ra.screenshot_diffs
         FROM responsive_analyses ra
         JOIN web_pages wp ON ra.web_page_id = wp.id
         WHERE ra.id = ANY($1::uuid[])
           AND NOT EXISTS (SELECT 1 FROM responsive_analysis_embeddings rae WHERE rae.responsive_analysis_id = ra.id)`,
        ids,
      );
      analyses = rows.map((r) => ({
        id: r.id,
        url: r.url ?? undefined,
        viewportsAnalyzed: r.viewports_analyzed as ResponsiveAnalysisForText['viewportsAnalyzed'],
        differences: r.differences as ResponsiveAnalysisForText['differences'],
        breakpoints: r.breakpoints as ResponsiveAnalysisForText['breakpoints'],
        screenshotDiffs: r.screenshot_diffs as ResponsiveAnalysisForText['screenshotDiffs'],
      }));
    } catch (fetchError) {
      if (isDevelopment()) {
        logger.warn('[ResponsiveAnalysisEmbedding] Failed to fetch analyses from DB', {
          error: fetchError instanceof Error ? fetchError.message : String(fetchError),
        });
      }
      return result;
    }
  } else {
    analyses = analysesOrIds as ResponsiveAnalysisForText[];
    embeddingService = getEmbeddingService();
    prismaClient = getPrismaClient();
    onProgress = typeof embeddingServiceOrProgress === 'function' ? embeddingServiceOrProgress : undefined;
  }

  if (analyses.length === 0) {
    return result;
  }

  if (isDevelopment()) {
    logger.info('[ResponsiveAnalysisEmbedding] Starting embedding generation', {
      analysisCount: analyses.length,
    });
  }

  const prisma = prismaClient;

  for (let i = 0; i < analyses.length; i++) {
    if (i > 0 && i % 10 === 0 && typeof global.gc === 'function') {
      global.gc();
    }

    const analysis = analyses[i]!;

    try {
      // 1. テキスト表現を生成
      const textRepresentation = generateResponsiveAnalysisTextRepresentation(analysis);

      // 2. Embedding を生成
      const embeddingResult = await embeddingService.generateFromText(textRepresentation);

      // 3. ResponsiveAnalysisEmbedding レコードを作成
      const createdRecord = await prisma.responsiveAnalysisEmbedding.create({
        data: {
          responsiveAnalysisId: analysis.id,
          textRepresentation,
          modelVersion: embeddingResult.modelName,
        },
      });

      // 4. pgvector 形式で embedding を更新
      const vectorString = `[${embeddingResult.embedding.join(',')}]`;
      await prisma.$executeRawUnsafe(
        `UPDATE responsive_analysis_embeddings SET embedding = $1::vector WHERE id = $2::uuid`,
        vectorString,
        createdRecord.id
      );

      result.generatedCount++;

      if (isDevelopment()) {
        logger.info('[ResponsiveAnalysisEmbedding] Embedding saved', {
          analysisId: analysis.id,
          embeddingId: createdRecord.id,
          dimensions: embeddingResult.embedding.length,
          processingTimeMs: embeddingResult.processingTimeMs,
        });
      }
    } catch (error) {
      result.failedCount++;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push({
        id: analysis.id,
        error: errorMessage,
      });

      if (isDevelopment()) {
        logger.warn('[ResponsiveAnalysisEmbedding] Embedding generation failed', {
          analysisId: analysis.id,
          error: errorMessage,
        });
      }
    }

    try { onProgress?.(result.generatedCount + result.failedCount, analyses.length); } catch { /* fire-and-forget */ }
  }

  if (isDevelopment()) {
    logger.info('[ResponsiveAnalysisEmbedding] Generation completed', {
      generatedCount: result.generatedCount,
      failedCount: result.failedCount,
      errorCount: result.errors.length,
    });
  }

  return result;
}
