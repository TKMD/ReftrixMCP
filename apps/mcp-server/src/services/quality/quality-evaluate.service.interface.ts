// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * IQualityEvaluateService Interface
 * 品質評価サービスのインターフェース定義
 *
 * パターン駆動評価のための拡張メソッドを含む:
 * - Embedding生成
 * - 類似セクション/モーション検索
 * - 高品質ベンチマーク取得
 * - 評価結果保存（パターン参照付き）
 *
 * @module services/quality/quality-evaluate.service.interface
 */

import type { QualityEvaluateData } from '../../tools/quality/schemas';

// =====================================================
// Similar Section/Motion Types
// =====================================================

/**
 * 類似セクション情報
 */
export interface SimilarSection {
  /** セクションパターンID (UUID) */
  id: string;
  /** セクションタイプ (hero, feature, cta, etc.) */
  sectionType: string;
  /** コサイン類似度 (0-1) */
  similarity: number;
  /** 品質スコア (0-100) */
  qualityScore?: number;
  /** ソースURL */
  sourceUrl?: string;
  /** WebページID */
  webPageId?: string;
  /** WebページURL */
  webPageUrl?: string;
  /** WebページTitle */
  webPageTitle?: string;
}

/**
 * 類似モーション情報
 */
export interface SimilarMotion {
  /** モーションパターンID (UUID) */
  id: string;
  /** モーションタイプ (animation, transition, transform, etc.) */
  motionType: string;
  /** コサイン類似度 (0-1) */
  similarity: number;
  /** トリガータイプ (scroll, hover, click, load, etc.) */
  trigger?: string;
  /** アニメーション時間 (ms) */
  duration?: number;
  /** ソースURL */
  sourceUrl?: string;
}

/**
 * パターン参照情報
 * 評価時に参照したパターンのID集合
 */
export interface PatternReferences {
  /** 類似セクションパターンID配列 */
  similarSections: string[];
  /** 類似モーションパターンID配列 */
  similarMotions: string[];
  /** 使用したベンチマークID配列 */
  benchmarksUsed: string[];
}

// =====================================================
// Quality Benchmark Types
// =====================================================

/**
 * 品質ベンチマーク情報
 * 高品質パターン（スコア85以上）の基準データ
 */
export interface QualityBenchmark {
  /** ベンチマークID (UUID) */
  id: string;
  /** セクションパターンID (UUID) */
  sectionPatternId?: string;
  /** セクションタイプ */
  sectionType: string;
  /** 総合スコア (85-100) */
  overallScore: number;
  /** グレード (A or B) */
  grade: 'A' | 'B';
  /** 特徴量リスト */
  characteristics: string[];
  /** 軸別スコア */
  axisScores: {
    originality: number;
    craftsmanship: number;
    contextuality: number;
  };
  /** ソースURL */
  sourceUrl: string;
  /** プレビューURL (スクリーンショット) */
  previewUrl?: string;
  /** 業界 */
  industry?: string;
  /** ターゲットオーディエンス */
  audience?: string;
  /** 抽出日時 */
  extractedAt: Date;
}

// =====================================================
// Find Similar Options
// =====================================================

/**
 * 類似セクション検索オプション
 */
export interface FindSimilarSectionsOptions {
  /** セクションタイプでフィルタリング */
  sectionType?: string;
  /** 最大取得件数 (デフォルト: 10) */
  limit?: number;
  /** 最小類似度しきい値 (デフォルト: 0.7) */
  minSimilarity?: number;
  /** 最小品質スコア (デフォルト: 0) */
  minQualityScore?: number;
}

/**
 * 類似モーション検索オプション
 */
export interface FindSimilarMotionsOptions {
  /** モーションタイプでフィルタリング */
  motionType?: string;
  /** 最大取得件数 (デフォルト: 10) */
  limit?: number;
  /** 最小類似度しきい値 (デフォルト: 0.7) */
  minSimilarity?: number;
  /** トリガータイプでフィルタリング */
  trigger?: string;
}

// =====================================================
// IQualityEvaluateService Interface
// =====================================================

/**
 * 品質評価サービスインターフェース
 *
 * 既存メソッド:
 * - getPageById: ページ情報取得
 * - saveEvaluation: 評価結果保存
 *
 * 新規メソッド（パターン駆動評価用）:
 * - generateEmbedding: テキスト表現からEmbedding生成
 * - findSimilarSections: 類似セクション検索
 * - findSimilarMotions: 類似モーション検索
 * - getHighQualityBenchmarks: 高品質ベンチマーク取得
 * - saveEvaluationWithPatterns: パターン参照付き評価保存
 */
export interface IQualityEvaluateService {
  // =====================================================
  // 既存メソッド
  // =====================================================

  /**
   * ページ情報をIDで取得
   * @param id - WebページID (UUID)
   * @returns ページ情報 (id, htmlContent) またはnull
   */
  getPageById?: (id: string) => Promise<{ id: string; htmlContent: string } | null>;

  /**
   * 評価結果を保存
   * @param evaluation - 評価データ
   * @returns 保存成功/失敗
   */
  saveEvaluation?: (evaluation: QualityEvaluateData) => Promise<boolean>;

  // =====================================================
  // 新規メソッド（パターン駆動評価用）
  // =====================================================

  /**
   * テキスト表現から768次元Embeddingを生成
   *
   * multilingual-e5-baseモデルを使用:
   * - L2正規化済み
   * - 768次元ベクトル
   * - 日本語/英語対応
   *
   * @param textRepresentation - セクション/パターンのテキスト表現
   * @returns 768次元Embeddingベクトル
   */
  generateEmbedding(textRepresentation: string): Promise<number[]>;

  /**
   * 類似セクションパターンを検索
   *
   * HNSWインデックスを使用したコサイン類似度検索:
   * - SectionEmbeddingテーブルを検索
   * - 品質スコアでフィルタリング可能
   *
   * @param embedding - 検索用768次元ベクトル
   * @param options - 検索オプション
   * @returns 類似セクション配列（類似度降順）
   */
  findSimilarSections(
    embedding: number[],
    options?: FindSimilarSectionsOptions
  ): Promise<SimilarSection[]>;

  /**
   * 類似モーションパターンを検索
   *
   * HNSWインデックスを使用したコサイン類似度検索:
   * - MotionEmbeddingテーブルを検索
   * - トリガータイプでフィルタリング可能
   *
   * @param embedding - 検索用768次元ベクトル
   * @param options - 検索オプション
   * @returns 類似モーション配列（類似度降順）
   */
  findSimilarMotions(
    embedding: number[],
    options?: FindSimilarMotionsOptions
  ): Promise<SimilarMotion[]>;

  /**
   * 高品質ベンチマークを取得
   *
   * セクションタイプ別の高スコアパターンを取得:
   * - overallScore >= 85
   * - grade: A または B
   *
   * @param sectionType - セクションタイプ (hero, feature, cta, etc.)
   * @param limit - 最大取得件数 (デフォルト: 5)
   * @returns ベンチマーク配列（スコア降順）
   */
  getHighQualityBenchmarks(
    sectionType: string,
    limit?: number
  ): Promise<QualityBenchmark[]>;

  /**
   * パターン参照付きで評価結果を保存
   *
   * 評価時に参照したパターン情報も一緒に保存:
   * - 類似セクションID
   * - 類似モーションID
   * - 使用したベンチマークID
   *
   * @param evaluation - 評価データ
   * @param patternRefs - パターン参照情報
   * @returns 保存されたQualityEvaluationのID (UUID)
   */
  saveEvaluationWithPatterns(
    evaluation: QualityEvaluateData,
    patternRefs: PatternReferences
  ): Promise<string>;
}
