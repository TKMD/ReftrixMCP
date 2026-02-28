// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * JSAnimationEmbeddingService
 * JSアニメーションパターン用のEmbedding生成サービス
 *
 * 機能:
 * - JSAnimationPatternからテキスト表現を生成
 * - multilingual-e5-base (768次元) Embeddingを生成
 * - バッチ処理対応
 * - DB保存連携
 *
 * @module services/motion/js-animation-embedding.service
 */

import { isDevelopment, logger } from '../../utils/logger';
import type {
  JSAnimationLibraryType,
  JSAnimationTypeEnum,
} from '../../tools/page/handlers/types';

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
 * JSAnimationPattern入力型（Embedding生成用）
 * Prismaスキーマ/DBから取得したデータを受け取る
 */
export interface JSAnimationPatternForEmbedding {
  id: string;
  libraryType: JSAnimationLibraryType;
  libraryVersion?: string | null;
  name: string;
  animationType: JSAnimationTypeEnum;
  description?: string | null;
  targetSelector?: string | null;
  targetCount?: number | null;
  targetTagNames?: string[];
  durationMs?: number | null;
  delayMs?: number | null;
  easing?: string | null;
  iterations?: number | null;
  direction?: string | null;
  fillMode?: string | null;
  keyframes?: unknown;
  properties?: unknown;
  triggerType?: string | null;
  triggerConfig?: unknown;
  confidence?: number | null;
}

/**
 * Embedding生成結果
 */
export interface JSAnimationEmbeddingResult {
  /** 768次元ベクトル */
  embedding: number[];
  /** Embedding生成に使用したテキスト */
  textRepresentation: string;
  /** 使用したモデル名 */
  modelVersion: string;
  /** 処理時間（ミリ秒） */
  processingTimeMs?: number;
}

/**
 * EmbeddingServiceインターフェース（DI用）
 */
export interface IEmbeddingService {
  generateEmbedding(text: string, type: 'query' | 'passage'): Promise<number[]>;
  generateBatchEmbeddings(texts: string[], type: 'query' | 'passage'): Promise<number[][]>;
  getCacheStats(): { hits: number; misses: number; size: number; evictions: number };
  clearCache(): void;
}

/**
 * JSAnimationEmbeddingServiceオプション
 */
export interface JSAnimationEmbeddingServiceOptions {
  embeddingService?: IEmbeddingService;
  modelName?: string;
}

// =====================================================
// テキスト表現生成関数
// =====================================================

/**
 * JSAnimationPatternからEmbedding用テキスト表現を生成
 *
 * E5モデル用にpassage:プレフィックスを付与
 * 768次元ベクトル生成に最適化されたテキスト形式
 *
 * @param pattern - JSアニメーションパターン情報
 * @returns Embedding用テキスト表現（passage:プレフィックス付き）
 */
export function generateJSAnimationTextRepresentation(
  pattern: JSAnimationPatternForEmbedding
): string {
  const parts: string[] = [];

  // ライブラリタイプ（必須）
  parts.push(`Library: ${pattern.libraryType}`);

  // ライブラリバージョン（オプション）
  if (pattern.libraryVersion) {
    parts.push(`Version: ${pattern.libraryVersion}`);
  }

  // アニメーション名（必須）
  parts.push(`Name: ${pattern.name}`);

  // アニメーションタイプ（必須）
  parts.push(`Type: ${pattern.animationType}`);

  // 説明（オプション）
  if (pattern.description) {
    parts.push(`Description: ${pattern.description}`);
  }

  // ターゲットセレクタ（オプション）
  if (pattern.targetSelector) {
    parts.push(`Target: ${pattern.targetSelector}`);
  }

  // ターゲット要素数（オプション）
  if (pattern.targetCount != null && pattern.targetCount > 0) {
    parts.push(`Target count: ${pattern.targetCount}`);
  }

  // Duration（オプション）
  if (pattern.durationMs != null && pattern.durationMs > 0) {
    parts.push(`Duration: ${pattern.durationMs}ms`);
  }

  // Delay（オプション）
  if (pattern.delayMs != null && pattern.delayMs > 0) {
    parts.push(`Delay: ${pattern.delayMs}ms`);
  }

  // Easing（オプション）
  if (pattern.easing) {
    parts.push(`Easing: ${pattern.easing}`);
  }

  // Iterations（オプション）
  if (pattern.iterations != null) {
    const iterStr = pattern.iterations === -1 ? 'infinite' : `${pattern.iterations}`;
    parts.push(`Iterations: ${iterStr}`);
  }

  // Direction（オプション）
  if (pattern.direction) {
    parts.push(`Direction: ${pattern.direction}`);
  }

  // Fill Mode（オプション）
  if (pattern.fillMode) {
    parts.push(`Fill: ${pattern.fillMode}`);
  }

  // プロパティ（オプション）
  const properties = extractProperties(pattern.properties);
  if (properties.length > 0) {
    parts.push(`Properties: ${properties.join(', ')}`);
  }

  // キーフレーム情報（オプション、要約のみ）
  const keyframesSummary = summarizeKeyframes(pattern.keyframes);
  if (keyframesSummary) {
    parts.push(`Keyframes: ${keyframesSummary}`);
  }

  // トリガータイプ（オプション）
  if (pattern.triggerType) {
    parts.push(`Trigger: ${pattern.triggerType}`);
  }

  // E5モデル用プレフィックス付きで返す
  return `passage: ${parts.join('. ')}.`;
}

/**
 * propertiesフィールドからプロパティ名を抽出
 */
function extractProperties(properties: unknown): string[] {
  if (!properties) {
    return [];
  }

  // 配列の場合
  if (Array.isArray(properties)) {
    // string[] の場合
    if (properties.length > 0 && typeof properties[0] === 'string') {
      return properties as string[];
    }
    // { property: string } オブジェクトの配列の場合
    return properties
      .filter((p): p is { property: string } => typeof p === 'object' && p !== null && 'property' in p)
      .map((p) => p.property);
  }

  return [];
}

/**
 * keyframesフィールドを要約
 */
function summarizeKeyframes(keyframes: unknown): string | null {
  if (!keyframes || !Array.isArray(keyframes) || keyframes.length === 0) {
    return null;
  }

  // キーフレーム数
  const count = keyframes.length;

  // 最初と最後のキーフレームからプロパティを抽出
  const firstKf = keyframes[0] as Record<string, unknown> | undefined;
  const lastKf = keyframes[keyframes.length - 1] as Record<string, unknown> | undefined;

  if (!firstKf || !lastKf) {
    return `${count} keyframes`;
  }

  // アニメーション対象プロパティを抽出（offset, easing, compositeを除外）
  const animatedProps = Object.keys(firstKf).filter(
    (k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)
  );

  if (animatedProps.length === 0) {
    return `${count} keyframes`;
  }

  return `${count} keyframes animating ${animatedProps.join(', ')}`;
}

// =====================================================
// JSAnimationEmbeddingService クラス
// =====================================================

/**
 * JSアニメーションパターン用のEmbedding生成サービス
 */
export class JSAnimationEmbeddingService {
  private readonly modelName: string;
  private embeddingService: IEmbeddingService | null = null;

  constructor(options?: JSAnimationEmbeddingServiceOptions) {
    this.modelName = options?.modelName ?? DEFAULT_MODEL_NAME;

    if (options?.embeddingService) {
      this.embeddingService = options.embeddingService;
    }

    if (isDevelopment()) {
      logger.info('[JSAnimationEmbedding] Service created', {
        modelName: this.modelName,
      });
    }
  }

  /**
   * EmbeddingServiceを取得
   */
  private getEmbeddingService(): IEmbeddingService {
    if (this.embeddingService) {
      return this.embeddingService;
    }

    throw new Error(
      'EmbeddingService not initialized. Provide embeddingService in constructor options.'
    );
  }

  /**
   * 単一パターンからEmbeddingを生成
   *
   * @param pattern - JSアニメーションパターン
   * @returns Embedding結果
   */
  async generateEmbedding(
    pattern: JSAnimationPatternForEmbedding
  ): Promise<JSAnimationEmbeddingResult> {
    // バリデーション
    if (!pattern || typeof pattern !== 'object') {
      throw new Error('Invalid pattern: must be a valid object');
    }

    if (!pattern.libraryType || !pattern.name || !pattern.animationType) {
      throw new Error('Invalid pattern: libraryType, name, and animationType are required');
    }

    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[JSAnimationEmbedding] Generating embedding', {
        patternId: pattern.id,
        libraryType: pattern.libraryType,
        animationType: pattern.animationType,
      });
    }

    // テキスト表現を生成
    const textRepresentation = generateJSAnimationTextRepresentation(pattern);

    // Embedding生成
    const service = this.getEmbeddingService();
    const embedding = await service.generateEmbedding(textRepresentation, 'passage');

    const processingTimeMs = Date.now() - startTime;

    if (isDevelopment()) {
      logger.info('[JSAnimationEmbedding] Generated embedding', {
        patternId: pattern.id,
        dimensions: embedding.length,
        processingTimeMs,
      });
    }

    return {
      embedding,
      textRepresentation,
      modelVersion: this.modelName,
      processingTimeMs,
    };
  }

  /**
   * 複数パターンからEmbeddingを一括生成
   *
   * @param patterns - JSアニメーションパターン配列
   * @returns Embedding結果配列
   */
  async generateBatchEmbeddings(
    patterns: JSAnimationPatternForEmbedding[]
  ): Promise<JSAnimationEmbeddingResult[]> {
    if (patterns.length === 0) {
      return [];
    }

    const startTime = Date.now();

    if (isDevelopment()) {
      logger.info('[JSAnimationEmbedding] Starting batch generation', {
        count: patterns.length,
      });
    }

    // テキスト表現を生成
    const textRepresentations = patterns.map((p) =>
      generateJSAnimationTextRepresentation(p)
    );

    // バッチEmbedding生成
    const service = this.getEmbeddingService();
    const embeddings = await service.generateBatchEmbeddings(textRepresentations, 'passage');

    const processingTimeMs = Date.now() - startTime;

    // 結果を組み立て
    const results: JSAnimationEmbeddingResult[] = patterns.map((_pattern, index) => ({
      embedding: embeddings[index] ?? [],
      textRepresentation: textRepresentations[index] ?? '',
      modelVersion: this.modelName,
    }));

    if (isDevelopment()) {
      logger.info('[JSAnimationEmbedding] Batch generation completed', {
        count: patterns.length,
        totalProcessingTimeMs: processingTimeMs,
        avgTimeMs: processingTimeMs / patterns.length,
      });
    }

    return results;
  }
}

// =====================================================
// ファクトリ関数（DI用）
// =====================================================

let embeddingServiceFactory: (() => IEmbeddingService) | null = null;

/**
 * EmbeddingServiceファクトリを設定
 */
export function setJSAnimationEmbeddingServiceFactory(
  factory: () => IEmbeddingService
): void {
  embeddingServiceFactory = factory;
}

/**
 * EmbeddingServiceファクトリをリセット
 */
export function resetJSAnimationEmbeddingServiceFactory(): void {
  embeddingServiceFactory = null;
}

/**
 * JSAnimationEmbeddingServiceインスタンスを作成
 */
export function createJSAnimationEmbeddingService(
  options?: JSAnimationEmbeddingServiceOptions
): JSAnimationEmbeddingService {
  // DIファクトリがあればそれを使用
  if (!options?.embeddingService && embeddingServiceFactory) {
    return new JSAnimationEmbeddingService({
      ...options,
      embeddingService: embeddingServiceFactory(),
    });
  }

  return new JSAnimationEmbeddingService(options);
}
