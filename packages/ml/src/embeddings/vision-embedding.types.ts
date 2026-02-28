// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vision Embedding Types
 *
 * Vision Embedding生成ロジック
 *
 * 視覚特徴量を表す型定義
 */

/**
 * 視覚的リズムの種類
 * - regular: 規則的なリズム（均等配置）
 * - varied: 変化のあるリズム（意図的な強弱）
 * - asymmetric: 非対称なリズム（アシンメトリック）
 */
export type VisionRhythm = 'regular' | 'varied' | 'asymmetric';

/**
 * コンテンツ密度の種類
 * - sparse: 疎（ホワイトスペースが多い）
 * - moderate: 中程度
 * - dense: 密集（コンテンツが多い）
 */
export type VisionDensity = 'sparse' | 'moderate' | 'dense';

/**
 * 視覚的重心の位置
 * - top: 上部
 * - center: 中央
 * - bottom: 下部
 * - left: 左側
 * - right: 右側
 */
export type VisionGravity = 'top' | 'center' | 'bottom' | 'left' | 'right';

/**
 * カラーテーマの種類
 * - light: ライトテーマ
 * - dark: ダークテーマ
 * - mixed: 混合テーマ
 */
export type VisionTheme = 'light' | 'dark' | 'mixed';

/**
 * 視覚特徴量インターフェース
 *
 * Webページのレイアウト/デザインから抽出された視覚的特徴を表す
 */
export interface VisionFeatures {
  /**
   * 視覚的リズム
   * 要素の配置パターン・繰り返しの規則性
   */
  rhythm: VisionRhythm;

  /**
   * ホワイトスペース比率 (0-1)
   * 0: ホワイトスペースなし（完全にコンテンツで埋まっている）
   * 1: 完全にホワイトスペース（コンテンツなし）
   */
  whitespaceRatio: number;

  /**
   * コンテンツ密度
   * ページ上のコンテンツ要素の密集度
   */
  density: VisionDensity;

  /**
   * 視覚的重心
   * コンテンツの視覚的な重心位置
   */
  gravity: VisionGravity;

  /**
   * カラーテーマ
   * 全体的な色調
   */
  theme: VisionTheme;

  /**
   * ムード (オプション)
   * Vision AIから取得したページの雰囲気/印象
   * 例: 'professional', 'playful', 'elegant', 'minimal'
   */
  mood?: string;

  /**
   * ブランドトーン (オプション)
   * Vision AIから取得したブランドの印象
   * 例: 'corporate', 'startup', 'luxury', 'friendly'
   */
  brandTone?: string;
}

/**
 * VisionEmbeddingServiceの設定オプション
 */
export interface VisionEmbeddingServiceConfig {
  /**
   * キャッシュの最大サイズ
   * @default 5000
   */
  maxCacheSize?: number;
}

/**
 * キャッシュ統計情報
 */
export interface VisionCacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
}
