// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LayoutEmbeddingService
 * Webデザイン解析用のEmbedding生成サービス
 *
 * 既存のEmbeddingService（packages/ml）を使用して、
 * レイアウトセクション用のEmbeddingを生成します。
 *
 * 機能:
 * - テキスト表現からEmbedding生成
 * - セクションからEmbedding生成
 * - バッチ処理
 * - 類似度計算
 * - DB保存連携
 * - PersistentCacheによるEmbeddingキャッシュ（MCP-CACHE-01）
 *
 * @module services/layout-embedding.service
 */

import { isDevelopment, logger } from '../utils/logger';
import { createHash } from 'crypto';
import {
  type PersistentCache,
  createPersistentCache,
  type PersistentCacheStats,
} from './persistent-cache';
import type { SectionInfo, LayoutInspectData, VisionFeatures } from '../tools/layout/inspect';

// =====================================================
// 定数
// =====================================================

/** デフォルトのモデル名 */
export const DEFAULT_MODEL_NAME = 'multilingual-e5-base';

/** デフォルトのEmbedding次元数 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

// =====================================================
// 型定義
// =====================================================

/**
 * LayoutEmbeddingServiceのオプション
 */
export interface LayoutEmbeddingOptions {
  /** モデル名（デフォルト: multilingual-e5-base） */
  modelName?: string;
  /** Embeddingの次元数（デフォルト: 768） */
  dimensions?: number;
  /** L2正規化するか（デフォルト: true） */
  normalize?: boolean;
  /** キャッシュを有効にするか（デフォルト: true） */
  cacheEnabled?: boolean;
}

/**
 * Embedding生成結果
 */
export interface LayoutEmbeddingResult {
  /** 768次元ベクトル */
  embedding: number[];
  /** Embedding生成に使用したテキスト */
  textUsed: string;
  /** 使用したモデル名 */
  modelName: string;
  /** 処理時間（ミリ秒） */
  processingTimeMs: number;
}

/**
 * DetectedSection - SectionInfoのエイリアス
 */
export type DetectedSection = SectionInfo;

/**
 * バッチ処理オプション
 */
export interface BatchOptions {
  /** 進捗コールバック */
  onProgress?: (completed: number, total: number) => void;
  /** エラー時に継続するか（デフォルト: true） */
  continueOnError?: boolean;
}

/**
 * キャッシュ統計
 */
export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
}

/**
 * Embeddingキャッシュ設定
 */
export interface EmbeddingCacheConfig {
  /** キャッシュを有効にするか（デフォルト: true） */
  enabled: boolean;
  /** キャッシュ保存ディレクトリ（デフォルト: /tmp/reftrix-embedding-cache） */
  dbPath: string;
  /** 最大エントリ数（デフォルト: 10000） */
  maxSize: number;
  /** TTL（ミリ秒、デフォルト: 24時間） */
  ttlMs: number;
}

/** デフォルトのEmbeddingキャッシュ設定 */
const DEFAULT_EMBEDDING_CACHE_CONFIG: EmbeddingCacheConfig = {
  enabled: true,
  dbPath: '/tmp/reftrix-embedding-cache',
  maxSize: 10000,
  ttlMs: 24 * 60 * 60 * 1000, // 24時間
};

/**
 * Embeddingキャッシュエントリ（ディスク永続化用）
 */
interface EmbeddingCacheEntry {
  embedding: number[];
  modelName: string;
  textHash: string;
  createdAt: number;
}

// =====================================================
// Vision分析統合用の型定義
// =====================================================

/**
 * Vision分析の個別特徴（Embedding用に簡略化）
 */
/**
 * Vision特徴の構造化データ
 * interface.tsのVisionFeatureDataから簡略化した型定義
 */
export interface VisionFeatureDataForEmbedding {
  type: string;
  // WhitespaceData
  amount?: 'minimal' | 'moderate' | 'generous' | 'extreme';
  distribution?: 'even' | 'top-heavy' | 'bottom-heavy' | 'centered';
  // DensityData
  level?: 'sparse' | 'balanced' | 'dense' | 'cluttered';
  // RhythmData
  pattern?: 'regular' | 'irregular' | 'progressive' | 'alternating';
  // VisualHierarchyData
  focalPoints?: string[];
  flowDirection?: 'top-to-bottom' | 'left-to-right' | 'z-pattern' | 'f-pattern';
  emphasisTechniques?: string[];
  // LayoutStructureData
  gridType?: string;
  mainAreas?: string[];
  // 共通
  description?: string;
}

export interface VisionFeatureForEmbedding {
  /** 特徴タイプ（layout_structure, visual_element, text_content等） */
  type: string;
  /** 信頼度（0-1） */
  confidence: number;
  /** 特徴の説明 */
  description?: string | undefined;
  /** 構造化された特徴データ */
  data?: VisionFeatureDataForEmbedding;
}

/**
 * Vision分析結果（Embedding用）
 */
export interface VisionFeaturesForEmbedding {
  /** 解析成功フラグ */
  success: boolean;
  /** Vision Analyzerが生成したテキスト表現 */
  textRepresentation?: string;
  /** 検出された特徴一覧 */
  features?: VisionFeatureForEmbedding[];
}

/**
 * Vision分析付きセクション情報
 */
export interface SectionWithVision {
  /** セクションID */
  id: string;
  /** セクションタイプ */
  type: string;
  /** コンテンツ情報 */
  content?: {
    headings?: Array<{ text: string; level: number }>;
    paragraphs?: string[];
    buttons?: Array<{ text: string; type: string }>;
    images?: Array<{ src: string; alt?: string }>;
    links?: Array<{ href: string; text: string }>;
  };
  /** スタイル情報 */
  style?: {
    backgroundColor?: string;
    textColor?: string;
    hasGradient?: boolean;
    hasImage?: boolean;
  };
  /** Vision分析結果 */
  visionFeatures?: VisionFeaturesForEmbedding;
}

// =====================================================
// EmbeddingService インターフェース（DI用）
// =====================================================

/**
 * EmbeddingServiceインターフェース
 */
export interface IEmbeddingService {
  generateEmbedding(text: string, type: 'query' | 'passage'): Promise<number[]>;
  generateBatchEmbeddings(texts: string[], type: 'query' | 'passage'): Promise<number[][]>;
  getCacheStats(): CacheStats;
  clearCache(): void;
  switchProvider?(provider: 'cpu' | 'cuda'): Promise<boolean>;
  releaseGpu?(): Promise<void>;
  getCurrentProvider?(): 'cpu' | 'cuda';
}

// ファクトリ関数（テスト時のDI用）
let embeddingServiceFactory: (() => IEmbeddingService) | null = null;

/**
 * EmbeddingServiceファクトリを設定（テスト用）
 */
export function setEmbeddingServiceFactory(factory: () => IEmbeddingService): void {
  embeddingServiceFactory = factory;
}

/**
 * EmbeddingServiceファクトリをリセット（テスト用）
 */
export function resetEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

// =====================================================
// Prisma Client インターフェース（DI用）
// =====================================================

/**
 * PrismaClientインターフェース（部分的）
 */
export interface IPrismaClient {
  sectionPattern: {
    create: (args: {
      data: {
        webPageId: string;
        sectionType: string;
        sectionName?: string;
        positionIndex: number;
        layoutInfo: unknown;
        components?: unknown;
        visualFeatures?: unknown;
      };
    }) => Promise<{ id: string }>;
  };
  sectionEmbedding: {
    create: (args: {
      data: {
        sectionPatternId: string;
        textRepresentation?: string;
        modelVersion: string;
      };
    }) => Promise<{ id: string }>;
  };
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
}

// ファクトリ関数（テスト時のDI用）
let prismaClientFactory: (() => IPrismaClient) | null = null;

/**
 * PrismaClientファクトリを設定（テスト用）
 */
export function setPrismaClientFactory(factory: () => IPrismaClient): void {
  prismaClientFactory = factory;
}

/**
 * PrismaClientファクトリをリセット（テスト用）
 */
export function resetPrismaClientFactory(): void {
  prismaClientFactory = null;
}

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * セクションからテキスト表現を生成（HTML解析のみ）
 */
function sectionToTextRepresentation(section: DetectedSection): string {
  const parts: string[] = [];

  // セクションタイプ
  parts.push(`${section.type} section`);

  // 見出し
  if (section.content.headings.length > 0) {
    const headingTexts = section.content.headings.map((h) => h.text).join(', ');
    parts.push(`with headings: ${headingTexts}`);
  }

  // ボタン
  if (section.content.buttons.length > 0) {
    const buttonTexts = section.content.buttons.map((b) => b.text).join(', ');
    parts.push(`buttons: ${buttonTexts}`);
  }

  // 段落（最初の1つのみ）
  if (section.content.paragraphs.length > 0) {
    const firstParagraph = section.content.paragraphs[0];
    if (firstParagraph && firstParagraph.length > 0) {
      const truncated =
        firstParagraph.length > 100
          ? firstParagraph.substring(0, 100) + '...'
          : firstParagraph;
      parts.push(`content: "${truncated}"`);
    }
  }

  // スタイル情報
  const styleInfo: string[] = [];
  if (section.style.backgroundColor) {
    styleInfo.push(`background ${section.style.backgroundColor}`);
  }
  if (section.style.textColor) {
    styleInfo.push(`text color ${section.style.textColor}`);
  }
  if (section.style.hasGradient) {
    styleInfo.push('gradient');
  }
  if (styleInfo.length > 0) {
    parts.push(`style: ${styleInfo.join(', ')}`);
  }

  // 画像
  if (section.content.images.length > 0) {
    parts.push(`${section.content.images.length} image(s)`);
  }

  // リンク
  if (section.content.links.length > 0) {
    parts.push(`${section.content.links.length} link(s)`);
  }

  return parts.join('. ') + '.';
}

/**
 * Vision特徴の構造化データから詳細なテキスト表現を生成
 *
 * whitespace/density/rhythm/visual_hierarchy/layout_structure の
 * 構造化データを抽出してテキスト化します。
 *
 * @param features - Vision特徴配列
 * @returns 構造化データに基づくテキスト配列
 */
function extractStructuredVisionFeatures(
  features: VisionFeatureForEmbedding[]
): string[] {
  const structuredParts: string[] = [];

  for (const feature of features) {
    // confidence >= 0.7 の特徴のみ処理
    if (feature.confidence < 0.7) continue;

    const data = feature.data;
    if (!data) {
      // dataがない場合はdescriptionをフォールバックとして使用
      if (feature.description) {
        structuredParts.push(feature.description);
      }
      continue;
    }

    switch (data.type) {
      case 'whitespace':
        if (data.amount || data.distribution) {
          const wsInfo: string[] = [];
          if (data.amount) wsInfo.push(`${data.amount} whitespace`);
          if (data.distribution) wsInfo.push(`${data.distribution} distribution`);
          structuredParts.push(wsInfo.join(' with '));
        }
        break;

      case 'density':
        if (data.level) {
          const densityInfo = `${data.level} content density`;
          if (data.description) {
            structuredParts.push(`${densityInfo}, ${data.description}`);
          } else {
            structuredParts.push(densityInfo);
          }
        }
        break;

      case 'rhythm':
        if (data.pattern) {
          const rhythmInfo = `${data.pattern} visual rhythm`;
          if (data.description) {
            structuredParts.push(`${rhythmInfo}, ${data.description}`);
          } else {
            structuredParts.push(rhythmInfo);
          }
        }
        break;

      case 'visual_hierarchy': {
        const hierarchyParts: string[] = [];
        if (data.focalPoints && data.focalPoints.length > 0) {
          hierarchyParts.push(`focal points: ${data.focalPoints.join(', ')}`);
        }
        if (data.flowDirection) {
          hierarchyParts.push(`flow: ${data.flowDirection}`);
        }
        if (data.emphasisTechniques && data.emphasisTechniques.length > 0) {
          hierarchyParts.push(`emphasis: ${data.emphasisTechniques.join(', ')}`);
        }
        if (hierarchyParts.length > 0) {
          structuredParts.push(`visual hierarchy with ${hierarchyParts.join(', ')}`);
        }
        break;
      }

      case 'layout_structure': {
        const layoutParts: string[] = [];
        if (data.gridType) {
          layoutParts.push(`${data.gridType} layout`);
        }
        if (data.mainAreas && data.mainAreas.length > 0) {
          layoutParts.push(`areas: ${data.mainAreas.join(', ')}`);
        }
        if (data.description && layoutParts.length === 0) {
          structuredParts.push(data.description);
        } else if (layoutParts.length > 0) {
          structuredParts.push(layoutParts.join(', '));
        }
        break;
      }

      default:
        // その他の特徴はdescriptionを使用
        if (feature.description) {
          structuredParts.push(feature.description);
        }
        break;
    }
  }

  return structuredParts;
}

/**
 * Vision分析結果を統合したテキスト表現を生成
 *
 * Vision分析結果がある場合は、より詳細な視覚特徴を優先して使用し、
 * HTML解析結果で補完します。Vision分析結果がない場合は、
 * HTML解析結果のみを使用します。
 *
 * 構造化データ（whitespace/density/rhythm/visual_hierarchy）を
 * 抽出してテキスト表現に含めるよう強化。
 *
 * @param section - Vision分析付きセクション情報
 * @returns Embedding用テキスト表現
 */
export function sectionToTextRepresentationWithVision(
  section: SectionWithVision
): string {
  const parts: string[] = [];

  // セクションタイプ
  parts.push(`${section.type} section`);

  // Vision分析結果を優先（より詳細な視覚特徴）
  if (
    section.visionFeatures?.success &&
    section.visionFeatures.textRepresentation
  ) {
    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Using Vision-enhanced textRepresentation', {
        sectionType: section.type,
        hasVisionText: true,
        visionTextLength: section.visionFeatures.textRepresentation.length,
      });
    }
    parts.push(`Visual: ${section.visionFeatures.textRepresentation}`);

    // Vision featuresから構造化データを抽出
    if (
      section.visionFeatures.features &&
      section.visionFeatures.features.length > 0
    ) {
      const structuredFeatures = extractStructuredVisionFeatures(
        section.visionFeatures.features
      );

      if (structuredFeatures.length > 0) {
        // 最大5つの構造化特徴を追加
        const limitedFeatures = structuredFeatures.slice(0, 5);
        parts.push(`Features: ${limitedFeatures.join(', ')}`);
      } else {
        // 構造化データがない場合はdescriptionにフォールバック
        const highConfidenceFeatures = section.visionFeatures.features
          .filter((f) => f.confidence >= 0.7 && f.description)
          .slice(0, 3)
          .map((f) => f.description);

        if (highConfidenceFeatures.length > 0) {
          parts.push(`Features: ${highConfidenceFeatures.join(', ')}`);
        }
      }
    }
  } else {
    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Vision features not available, using HTML-only', {
        sectionType: section.type,
        visionSuccess: section.visionFeatures?.success ?? false,
      });
    }
  }

  // HTML解析結果（補完）
  if (section.content?.headings && section.content.headings.length > 0) {
    const headingTexts = section.content.headings.map((h) => h.text).join(', ');
    parts.push(`Headings: ${headingTexts}`);
  }

  // ボタン情報
  if (section.content?.buttons && section.content.buttons.length > 0) {
    const buttonTexts = section.content.buttons.map((b) => b.text).join(', ');
    parts.push(`Buttons: ${buttonTexts}`);
  }

  // 段落コンテンツ（最大200文字）
  if (section.content?.paragraphs && section.content.paragraphs.length > 0) {
    const preview = section.content.paragraphs
      .slice(0, 2)
      .join(' ')
      .substring(0, 200);
    if (preview.length > 0) {
      parts.push(`Content: ${preview}`);
    }
  }

  // スタイル情報
  if (section.style) {
    const styleInfo: string[] = [];
    if (section.style.backgroundColor) {
      styleInfo.push(`background ${section.style.backgroundColor}`);
    }
    if (section.style.textColor) {
      styleInfo.push(`text color ${section.style.textColor}`);
    }
    if (section.style.hasGradient) {
      styleInfo.push('gradient');
    }
    if (styleInfo.length > 0) {
      parts.push(`Style: ${styleInfo.join(', ')}`);
    }
  }

  // 画像
  if (section.content?.images && section.content.images.length > 0) {
    parts.push(`${section.content.images.length} image(s)`);
  }

  // リンク
  if (section.content?.links && section.content.links.length > 0) {
    parts.push(`${section.content.links.length} link(s)`);
  }

  return parts.join('. ') + '.';
}

/**
 * VisionFeaturesからVisionFeaturesForEmbeddingへ変換
 *
 * @param visionFeatures - 元のVisionFeatures（または unknown）
 * @returns VisionFeaturesForEmbedding形式
 */
export function convertToVisionFeaturesForEmbedding(
  visionFeatures: VisionFeatures | Record<string, unknown> | undefined
): VisionFeaturesForEmbedding | undefined {
  if (!visionFeatures) {
    return undefined;
  }

  // 型ガード: success プロパティがあるか確認
  if (typeof visionFeatures !== 'object' || !('success' in visionFeatures)) {
    return undefined;
  }

  const result: VisionFeaturesForEmbedding = {
    success: Boolean(visionFeatures.success),
  };

  // textRepresentation があれば抽出
  if ('textRepresentation' in visionFeatures && typeof visionFeatures.textRepresentation === 'string') {
    result.textRepresentation = visionFeatures.textRepresentation;
  }

  // features があれば変換
  if ('features' in visionFeatures && Array.isArray(visionFeatures.features)) {
    result.features = visionFeatures.features
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map((f) => ({
        type: typeof f.type === 'string' ? f.type : 'unknown',
        confidence: typeof f.confidence === 'number' ? f.confidence : 0,
        description: typeof f.description === 'string' ? f.description : undefined,
      }));
  }

  return result;
}

/**
 * LayoutInspectDataからテキスト表現を生成
 */
function inspectResultToTextRepresentation(result: LayoutInspectData): string {
  // 既存のtextRepresentationがあればそれを使用
  if (result.textRepresentation && result.textRepresentation.length > 0) {
    return result.textRepresentation;
  }

  // セクションからテキスト表現を生成
  const sectionTexts = result.sections.map((s) => sectionToTextRepresentation(s));
  return sectionTexts.join(' ');
}

/**
 * コサイン類似度を計算
 */
function calculateCosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimensions do not match: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

// =====================================================
// Embeddingキャッシュ（シングルトン）
// =====================================================

/** グローバルEmbeddingキャッシュインスタンス */
let embeddingCache: PersistentCache<EmbeddingCacheEntry> | null = null;

/** Embeddingキャッシュ設定 */
let embeddingCacheConfig: EmbeddingCacheConfig = { ...DEFAULT_EMBEDDING_CACHE_CONFIG };

/**
 * Embeddingキャッシュを初期化
 *
 * @param config - キャッシュ設定
 */
export function initializeEmbeddingCache(config?: Partial<EmbeddingCacheConfig>): void {
  embeddingCacheConfig = { ...DEFAULT_EMBEDDING_CACHE_CONFIG, ...config };

  if (!embeddingCacheConfig.enabled) {
    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Embedding cache disabled');
    }
    return;
  }

  embeddingCache = createPersistentCache<EmbeddingCacheEntry>({
    dbPath: embeddingCacheConfig.dbPath,
    maxSize: embeddingCacheConfig.maxSize,
    defaultTtlMs: embeddingCacheConfig.ttlMs,
    enableLogging: isDevelopment(),
  });

  if (isDevelopment()) {
    logger.info('[LayoutEmbedding] Embedding cache initialized', {
      dbPath: embeddingCacheConfig.dbPath,
      maxSize: embeddingCacheConfig.maxSize,
      ttlMs: embeddingCacheConfig.ttlMs,
    });
  }
}

/**
 * Embeddingキャッシュ統計を取得
 */
export async function getEmbeddingCacheStats(): Promise<PersistentCacheStats | null> {
  if (!embeddingCache) {
    return null;
  }
  return embeddingCache.getStats();
}

/**
 * Embeddingキャッシュをクリア
 */
export async function clearEmbeddingCache(): Promise<void> {
  if (embeddingCache) {
    await embeddingCache.clear();
  }
}

/**
 * Embeddingキャッシュを閉じる
 */
export async function closeEmbeddingCache(): Promise<void> {
  if (embeddingCache) {
    await embeddingCache.close();
    embeddingCache = null;
  }
}

/**
 * テキストからキャッシュキーを生成（SHA-256ハッシュ）
 */
function generateCacheKey(text: string, modelName: string): string {
  const hash = createHash('sha256');
  hash.update(`${modelName}:${text}`);
  return hash.digest('hex');
}

// =====================================================
// LayoutEmbeddingService
// =====================================================

/**
 * Webデザイン解析用のEmbedding生成サービス
 */
export class LayoutEmbeddingService {
  private readonly options: Required<LayoutEmbeddingOptions>;
  private embeddingService: IEmbeddingService | null = null;

  constructor(options?: LayoutEmbeddingOptions) {
    this.options = {
      modelName: options?.modelName ?? DEFAULT_MODEL_NAME,
      dimensions: options?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
      normalize: options?.normalize ?? true,
      cacheEnabled: options?.cacheEnabled ?? true,
    };

    // 初回インスタンス作成時にキャッシュを初期化
    if (this.options.cacheEnabled && !embeddingCache) {
      initializeEmbeddingCache();
    }

    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Service created', {
        modelName: this.options.modelName,
        dimensions: this.options.dimensions,
        cacheEnabled: this.options.cacheEnabled,
      });
    }
  }

  /**
   * EmbeddingServiceを取得（遅延初期化）
   */
  private getEmbeddingService(): IEmbeddingService {
    if (this.embeddingService) {
      return this.embeddingService;
    }

    // DIファクトリがあればそれを使用
    if (embeddingServiceFactory) {
      this.embeddingService = embeddingServiceFactory();
      return this.embeddingService;
    }

    // 実際のEmbeddingServiceをインポート（動的）
    throw new Error('EmbeddingService not initialized. Use setEmbeddingServiceFactory in production.');
  }

  /**
   * テキストからEmbeddingを生成（キャッシュ対応）
   *
   * @param text - 入力テキスト
   * @returns Embedding結果
   */
  async generateFromText(text: string): Promise<LayoutEmbeddingResult> {
    if (!text || typeof text !== 'string') {
      throw new Error('Invalid input: text must be a non-empty string');
    }

    if (text.length === 0) {
      throw new Error('Invalid input: text cannot be empty');
    }

    const startTime = Date.now();

    // キャッシュチェック（有効な場合のみ）
    if (this.options.cacheEnabled && embeddingCache) {
      const cacheKey = generateCacheKey(text, this.options.modelName);

      try {
        const cached = await embeddingCache.get(cacheKey);
        if (cached) {
          const processingTimeMs = Date.now() - startTime;

          if (isDevelopment()) {
            logger.info('[LayoutEmbedding] Cache HIT', {
              textLength: text.length,
              cacheKey: cacheKey.substring(0, 16) + '...',
              processingTimeMs,
            });
          }

          return {
            embedding: cached.embedding,
            textUsed: text,
            modelName: cached.modelName,
            processingTimeMs,
          };
        }
      } catch (cacheError) {
        // キャッシュエラーは無視して続行
        if (isDevelopment()) {
          logger.warn('[LayoutEmbedding] Cache read error, proceeding without cache', {
            error: cacheError instanceof Error ? cacheError.message : 'Unknown error',
          });
        }
      }
    }

    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Cache MISS, generating from text', {
        textLength: text.length,
      });
    }

    const service = this.getEmbeddingService();
    const embedding = await service.generateEmbedding(text, 'passage');

    const processingTimeMs = Date.now() - startTime;

    // キャッシュに保存（非同期、エラーは無視）
    if (this.options.cacheEnabled && embeddingCache) {
      const cacheKey = generateCacheKey(text, this.options.modelName);
      const cacheEntry: EmbeddingCacheEntry = {
        embedding,
        modelName: this.options.modelName,
        textHash: cacheKey,
        createdAt: Date.now(),
      };

      embeddingCache.set(cacheKey, cacheEntry).catch((error) => {
        if (isDevelopment()) {
          logger.warn('[LayoutEmbedding] Cache write error', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      });
    }

    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Generated embedding', {
        dimensions: embedding.length,
        processingTimeMs,
      });
    }

    return {
      embedding,
      textUsed: text,
      modelName: this.options.modelName,
      processingTimeMs,
    };
  }

  /**
   * セクションからEmbeddingを生成
   *
   * @param section - 検出されたセクション
   * @returns Embedding結果
   */
  async generateFromSection(section: DetectedSection): Promise<LayoutEmbeddingResult> {
    if (!section || typeof section !== 'object') {
      throw new Error('Invalid input: section must be a valid object');
    }

    const textRepresentation = sectionToTextRepresentation(section);

    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Generating from section', {
        sectionType: section.type,
        textLength: textRepresentation.length,
      });
    }

    return this.generateFromText(textRepresentation);
  }

  /**
   * Vision分析付きセクションからEmbeddingを生成
   *
   * Vision分析結果がある場合は、より詳細な視覚特徴を含むテキスト表現を生成します。
   * Vision分析結果がない場合は、HTML解析結果のみを使用します。
   *
   * @param section - Vision分析付きセクション情報
   * @returns Embedding結果
   */
  async generateFromSectionWithVision(
    section: SectionWithVision
  ): Promise<LayoutEmbeddingResult> {
    if (!section || typeof section !== 'object') {
      throw new Error('Invalid input: section must be a valid object');
    }

    const textRepresentation = sectionToTextRepresentationWithVision(section);

    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Generating from section with Vision', {
        sectionType: section.type,
        hasVisionFeatures: section.visionFeatures?.success ?? false,
        textLength: textRepresentation.length,
      });
    }

    return this.generateFromText(textRepresentation);
  }

  /**
   * 複数セクションからEmbeddingを一括生成（Vision分析対応）
   *
   * @param sections - Vision分析付きセクション配列
   * @param options - バッチオプション
   * @returns Embedding結果配列
   */
  async generateBatchWithVision(
    sections: SectionWithVision[],
    options?: BatchOptions
  ): Promise<LayoutEmbeddingResult[]> {
    if (sections.length === 0) {
      return [];
    }

    const startTime = Date.now();
    const continueOnError = options?.continueOnError ?? true;
    const results: LayoutEmbeddingResult[] = [];
    const errors: Array<{ index: number; error: Error }> = [];

    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Starting batch generation with Vision', {
        count: sections.length,
        sectionsWithVision: sections.filter((s) => s.visionFeatures?.success).length,
      });
    }

    // テキスト表現を生成（Vision対応）
    const texts = sections.map((s) => sectionToTextRepresentationWithVision(s));

    // バッチ処理を試みる
    try {
      const service = this.getEmbeddingService();
      const embeddings = await service.generateBatchEmbeddings(texts, 'passage');

      for (let i = 0; i < sections.length; i++) {
        const embedding = embeddings[i];
        const text = texts[i];

        if (embedding && text) {
          results.push({
            embedding,
            textUsed: text,
            modelName: this.options.modelName,
            processingTimeMs: 0,
          });
        }

        // 進捗コールバック
        if (options?.onProgress) {
          options.onProgress(i + 1, sections.length);
        }
      }
    } catch (batchError) {
      // バッチ処理が失敗した場合、個別に処理
      if (isDevelopment()) {
        logger.warn('[LayoutEmbedding] Batch processing with Vision failed, falling back to individual', {
          error: batchError instanceof Error ? batchError.message : 'Unknown error',
        });
      }

      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        if (!section) continue;

        try {
          const result = await this.generateFromSectionWithVision(section);
          results.push(result);
        } catch (error) {
          if (continueOnError) {
            errors.push({
              index: i,
              error: error instanceof Error ? error : new Error('Unknown error'),
            });
          } else {
            throw error;
          }
        }

        // 進捗コールバック
        if (options?.onProgress) {
          options.onProgress(i + 1, sections.length);
        }
      }
    }

    const totalTime = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Batch generation with Vision completed', {
        total: sections.length,
        successful: results.length,
        errors: errors.length,
        totalTimeMs: totalTime,
      });
    }

    return results;
  }

  /**
   * 複数セクションからEmbeddingを一括生成
   *
   * @param sections - セクション配列
   * @param options - バッチオプション
   * @returns Embedding結果配列
   */
  async generateBatch(
    sections: DetectedSection[],
    options?: BatchOptions
  ): Promise<LayoutEmbeddingResult[]> {
    if (sections.length === 0) {
      return [];
    }

    const startTime = Date.now();
    const continueOnError = options?.continueOnError ?? true;
    const results: LayoutEmbeddingResult[] = [];
    const errors: Array<{ index: number; error: Error }> = [];

    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Starting batch generation', {
        count: sections.length,
      });
    }

    // テキスト表現を生成
    const texts = sections.map((s) => sectionToTextRepresentation(s));

    // バッチ処理を試みる
    try {
      const service = this.getEmbeddingService();
      const embeddings = await service.generateBatchEmbeddings(texts, 'passage');

      for (let i = 0; i < sections.length; i++) {
        const embedding = embeddings[i];
        const text = texts[i];

        if (embedding && text) {
          results.push({
            embedding,
            textUsed: text,
            modelName: this.options.modelName,
            processingTimeMs: 0,
          });
        }

        // 進捗コールバック
        if (options?.onProgress) {
          options.onProgress(i + 1, sections.length);
        }
      }
    } catch (batchError) {
      // バッチ処理が失敗した場合、個別に処理
      if (isDevelopment()) {
        logger.warn('[LayoutEmbedding] Batch processing failed, falling back to individual', {
          error: batchError instanceof Error ? batchError.message : 'Unknown error',
        });
      }

      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        if (!section) continue;

        try {
          const result = await this.generateFromSection(section);
          results.push(result);
        } catch (error) {
          if (continueOnError) {
            errors.push({
              index: i,
              error: error instanceof Error ? error : new Error('Unknown error'),
            });
          } else {
            throw error;
          }
        }

        // 進捗コールバック
        if (options?.onProgress) {
          options.onProgress(i + 1, sections.length);
        }
      }
    }

    const totalTime = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Batch generation completed', {
        total: sections.length,
        successful: results.length,
        errors: errors.length,
        totalTimeMs: totalTime,
      });
    }

    return results;
  }

  /**
   * LayoutInspect結果からEmbeddingを生成
   *
   * @param result - LayoutInspect解析結果
   * @returns Embedding結果
   */
  async generateFromInspectResult(
    result: LayoutInspectData
  ): Promise<LayoutEmbeddingResult> {
    const textRepresentation = inspectResultToTextRepresentation(result);

    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Generating from inspect result', {
        sectionsCount: result.sections.length,
        textLength: textRepresentation.length,
      });
    }

    return this.generateFromText(textRepresentation);
  }

  /**
   * 2つのEmbedding間の類似度を計算
   *
   * @param embedding1 - 1つ目のEmbedding
   * @param embedding2 - 2つ目のEmbedding
   * @returns コサイン類似度（-1から1）
   */
  calculateSimilarity(embedding1: number[], embedding2: number[]): number {
    return calculateCosineSimilarity(embedding1, embedding2);
  }

  /**
   * キャッシュ統計を取得（EmbeddingServiceとPersistentCache両方）
   */
  getCacheStats(): CacheStats {
    try {
      const service = this.getEmbeddingService();
      return service.getCacheStats();
    } catch {
      return { hits: 0, misses: 0, size: 0, evictions: 0 };
    }
  }

  /**
   * PersistentCache統計を取得（非同期）
   */
  async getPersistentCacheStats(): Promise<PersistentCacheStats | null> {
    return getEmbeddingCacheStats();
  }

  /**
   * キャッシュをクリア（EmbeddingServiceとPersistentCache両方）
   */
  async clearAllCaches(): Promise<void> {
    // EmbeddingServiceのキャッシュをクリア
    try {
      const service = this.getEmbeddingService();
      service.clearCache();
    } catch {
      // サービスが初期化されていない場合は何もしない
    }

    // PersistentCacheをクリア
    await clearEmbeddingCache();
  }

  /**
   * キャッシュをクリア（EmbeddingServiceのみ、後方互換性）
   */
  clearCache(): void {
    try {
      const service = this.getEmbeddingService();
      service.clearCache();
    } catch {
      // サービスが初期化されていない場合は何もしない
    }
  }

  /**
   * テキスト配列からEmbeddingをバッチ生成（キャッシュ対応）
   *
   * 内部的に EmbeddingService.generateBatchEmbeddings() を使用して
   * 複数テキストを一度にONNX推論する。1件ずつ generateFromText() を
   * 呼ぶよりもモデル呼び出し回数が削減され、~30-40%高速化される。
   *
   * @param texts - 入力テキスト配列
   * @returns Embedding結果配列（入力順序と1:1対応）
   */
  async generateBatchFromTexts(texts: string[]): Promise<LayoutEmbeddingResult[]> {
    if (texts.length === 0) {
      return [];
    }

    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Batch generating from texts', {
        count: texts.length,
      });
    }

    // キャッシュチェック: hit/missを分離
    const results: (LayoutEmbeddingResult | undefined)[] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    if (this.options.cacheEnabled && embeddingCache) {
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        if (!text) continue;

        const cacheKey = generateCacheKey(text, this.options.modelName);
        try {
          const cached = await embeddingCache.get(cacheKey);
          if (cached) {
            results[i] = {
              embedding: cached.embedding,
              textUsed: text,
              modelName: cached.modelName,
              processingTimeMs: 0,
            };
            continue;
          }
        } catch {
          // キャッシュエラーは無視
        }

        uncachedIndices.push(i);
        uncachedTexts.push(text);
      }
    } else {
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        if (!text) continue;
        uncachedIndices.push(i);
        uncachedTexts.push(text);
      }
    }

    // 未キャッシュ分をバッチ推論
    if (uncachedTexts.length > 0) {
      const service = this.getEmbeddingService();
      const embeddings = await service.generateBatchEmbeddings(uncachedTexts, 'passage');

      for (let j = 0; j < embeddings.length; j++) {
        const idx = uncachedIndices[j];
        const embedding = embeddings[j];
        const text = uncachedTexts[j];

        if (idx === undefined || !embedding || !text) continue;

        const result: LayoutEmbeddingResult = {
          embedding,
          textUsed: text,
          modelName: this.options.modelName,
          processingTimeMs: 0,
        };
        results[idx] = result;

        // キャッシュ保存（非同期、fire-and-forget）
        if (this.options.cacheEnabled && embeddingCache) {
          const cacheKey = generateCacheKey(text, this.options.modelName);
          const cacheEntry: EmbeddingCacheEntry = {
            embedding,
            modelName: this.options.modelName,
            textHash: cacheKey,
            createdAt: Date.now(),
          };
          embeddingCache.set(cacheKey, cacheEntry).catch(() => { /* fire-and-forget */ });
        }
      }
    }

    const processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[LayoutEmbedding] Batch generation from texts completed', {
        total: texts.length,
        cachedHits: texts.length - uncachedTexts.length,
        generated: uncachedTexts.length,
        processingTimeMs,
      });
    }

    return results.filter((r): r is LayoutEmbeddingResult => r !== undefined);
  }

  /**
   * ONNX Embeddingパイプラインを明示的にdispose（メモリ解放）
   *
   * onnxruntime-nodeのC++アリーナアロケータは推論ごとに~65-100MBずつ成長し、
   * 自動的にOSにメモリを返却しない。dispose()によりInferenceSessionを破棄し、
   * アリーナのネイティブメモリをOSに返却する。
   *
   * サブフェーズ間で呼び出すことで、Embedding Phase全体のメモリピークを抑制する。
   * 次回のgenerateFromText()呼び出し時にパイプラインは自動的に再初期化される。
   */
  async disposeEmbeddingPipeline(): Promise<void> {
    if (!this.embeddingService) {
      return;
    }

    // IEmbeddingServiceにdispose()がない場合でも、実体がEmbeddingServiceならdispose可能
    const service = this.embeddingService as { dispose?: () => Promise<void> };
    if (typeof service.dispose === 'function') {
      try {
        await service.dispose();
        if (isDevelopment()) {
          logger.info('[LayoutEmbedding] ONNX pipeline disposed for memory recovery');
        }
      } catch (disposeError) {
        if (isDevelopment()) {
          logger.warn('[LayoutEmbedding] Pipeline dispose warning', {
            error: disposeError instanceof Error ? disposeError.message : 'Unknown error',
          });
        }
      }
    }
  }

  /**
   * ONNX実行プロバイダーを動的に切り替え
   *
   * GpuResourceManagerから呼び出され、Embedding生成時にCPU/CUDA間を切り替える。
   * 内部のEmbeddingServiceがswitchProviderをサポートしていない場合はfalseを返す。
   */
  async switchProvider(provider: 'cpu' | 'cuda'): Promise<boolean> {
    const service = this.getEmbeddingService();
    if (typeof service.switchProvider === 'function') {
      return service.switchProvider(provider);
    }
    return false;
  }

  /**
   * GPU リソースを解放（パイプラインdispose + CPUフォールバック）
   *
   * GpuResourceManagerから呼び出され、Vision分析のためにGPUを解放する。
   */
  async releaseGpu(): Promise<void> {
    const service = this.getEmbeddingService();
    if (typeof service.releaseGpu === 'function') {
      await service.releaseGpu();
    }
  }

  /**
   * 現在のONNX実行プロバイダーを取得
   */
  getCurrentProvider(): 'cpu' | 'cuda' {
    const service = this.getEmbeddingService();
    if (typeof service.getCurrentProvider === 'function') {
      return service.getCurrentProvider();
    }
    return 'cpu';
  }
}

// =====================================================
// DB保存関数
// =====================================================

/**
 * PrismaClientを取得
 */
function getPrismaClient(): IPrismaClient {
  if (prismaClientFactory) {
    return prismaClientFactory();
  }

  throw new Error('PrismaClient not initialized. Use setPrismaClientFactory in production.');
}

/**
 * セクション保存オプション
 */
export interface SaveSectionOptions {
  /** 外部CSSを含むCSSスニペット */
  cssSnippet?: string;
  /** 外部CSSコンテンツ（<link rel="stylesheet">の実コンテンツ） */
  externalCssContent?: string;
  /** 外部CSSメタ情報 */
  externalCssMeta?: {
    fetchedCount: number;
    failedCount: number;
    totalSize: number;
    urls: Array<{ url: string; size?: number; success?: boolean }>;
    fetchedAt: string;
  };
  /** Computed styles適用済みHTMLスニペット */
  htmlSnippet?: string;
}

/**
 * セクションとEmbeddingをDBに保存
 *
 * @param section - 検出されたセクション
 * @param webPageId - WebPage ID
 * @param embedding - 生成されたEmbedding
 * @param options - 保存オプション（htmlSnippet, cssSnippet）
 * @param textRepresentation - Embedding生成元のテキスト表現（Phase 6 P2-4で追加）
 * @returns 作成されたSectionPattern ID
 */
export async function saveSectionWithEmbedding(
  section: DetectedSection,
  webPageId: string,
  embedding: number[],
  options?: SaveSectionOptions,
  textRepresentation: string = ''
): Promise<string> {
  const prisma = getPrismaClient();

  if (isDevelopment()) {
    logger.info('[LayoutEmbedding] Saving section with embedding', {
      sectionType: section.type,
      webPageId,
      embeddingDimensions: embedding.length,
      hasHtmlSnippet: !!options?.htmlSnippet,
      hasCssSnippet: !!options?.cssSnippet,
      hasExternalCssContent: !!options?.externalCssContent,
    });
  }

  // SectionPatternを作成（htmlSnippet, cssSnippetを含める）
  const sectionName = section.content.headings[0]?.text;
  const sectionPattern = await prisma.sectionPattern.create({
    data: {
      webPageId,
      sectionType: section.type,
      ...(sectionName !== undefined && { sectionName }),
      positionIndex: parseInt(section.id.replace('section-', ''), 10) || 0,
      layoutInfo: {
        position: section.position,
        style: section.style,
      },
      components: section.content,
      visualFeatures: section.style,
      // Computed styles適用済みHTMLスニペット
      ...(options?.htmlSnippet !== undefined && { htmlSnippet: options.htmlSnippet }),
      // 外部CSSを含むCSSスニペット
      ...(options?.cssSnippet !== undefined && { cssSnippet: options.cssSnippet }),
      // 外部CSSコンテンツ
      ...(options?.externalCssContent !== undefined && {
        externalCssContent: options.externalCssContent,
      }),
      ...(options?.externalCssMeta !== undefined && { externalCssMeta: options.externalCssMeta }),
    },
  });

  // SectionEmbeddingを作成（Embeddingはraw SQLで更新）
  await saveSectionEmbedding(sectionPattern.id, embedding, DEFAULT_MODEL_NAME, textRepresentation);

  return sectionPattern.id;
}

/**
 * SectionEmbeddingをDBに保存
 *
 * @param sectionPatternId - SectionPattern ID
 * @param embedding - Embeddingベクトル
 * @param modelName - モデル名
 * @param textRepresentation - Embedding生成元のテキスト表現（Phase 6 P2-4で追加）
 * @returns 作成されたSectionEmbedding ID
 */
export async function saveSectionEmbedding(
  sectionPatternId: string,
  embedding: number[],
  modelName: string,
  textRepresentation: string = ''
): Promise<string> {
  const prisma = getPrismaClient();

  if (isDevelopment()) {
    logger.info('[LayoutEmbedding] Saving section embedding', {
      sectionPatternId,
      modelName,
      embeddingDimensions: embedding.length,
      textRepresentationLength: textRepresentation.length,
    });
  }

  // まずSectionEmbeddingレコードを作成
  const createData = {
    sectionPatternId,
    modelVersion: modelName,
    textRepresentation,
  };
  const sectionEmbedding = await prisma.sectionEmbedding.create({
    data: createData,
  });

  // pgvector形式でEmbeddingを更新
  const vectorString = `[${embedding.join(',')}]`;
  await prisma.$executeRawUnsafe(
    `UPDATE section_embeddings SET text_embedding = $1::vector WHERE id = $2::uuid`,
    vectorString,
    sectionEmbedding.id
  );

  return sectionEmbedding.id;
}

// =====================================================
// 型の再エクスポート
// =====================================================

// PersistentCacheStats型を再エクスポート（MCP-CACHE-01）
export type { PersistentCacheStats } from './persistent-cache';

// =====================================================
// デフォルトエクスポート
// =====================================================

export default LayoutEmbeddingService;
