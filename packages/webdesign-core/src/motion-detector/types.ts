// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MotionDetector Type Definitions
 *
 * CSS Animation/Transition/Transform検出に使用する型定義
 * 循環依存を避けるため、共通の型定義をこのファイルに分離
 *
 * @module @reftrix/webdesign-core/motion-detector/types
 */

// =========================================
// Type Definitions
// =========================================

/**
 * モーションプロパティの定義
 * 個々のCSSプロパティのアニメーション情報を保持
 */
export interface MotionProperty {
  /** プロパティ名 (e.g., 'transform', 'opacity', 'color') */
  name: string;
  /** 開始値 */
  from: string;
  /** 終了値 */
  to: string;
  /** キーフレームの中間値（ある場合） */
  keyframes?: { offset: number; value: string }[];
}

/**
 * モーションパターンの定義
 * 検出されたアニメーション/トランジションの完全な情報
 */
export interface MotionPattern {
  /** 一意のID */
  id: string;
  /** モーションタイプ */
  type:
    | 'animation'
    | 'transition'
    | 'transform'
    | 'scroll'
    | 'hover'
    | 'keyframe';
  /** アニメーション/トランジション名 */
  name: string;
  /** CSSセレクタ */
  selector: string;
  /** 影響するプロパティ群 */
  properties: MotionProperty[];
  /** 再生時間（ミリ秒） */
  duration: number;
  /** 遅延時間（ミリ秒） */
  delay: number;
  /** イージング関数 */
  easing: string;
  /** 繰り返し回数 */
  iterations: number | 'infinite';
  /** 再生方向 */
  direction: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
  /** フィルモード */
  fillMode: 'none' | 'forwards' | 'backwards' | 'both';
  /** 再生状態 */
  playState: 'running' | 'paused';
  /** トリガー条件 */
  trigger: 'load' | 'hover' | 'scroll' | 'click' | 'focus' | 'custom';
  /** 検出信頼度 (0-1) */
  confidence: number;
}

/**
 * モーション検出結果
 */
export interface MotionDetectionResult {
  /** 検出されたパターン */
  patterns: MotionPattern[];
  /** サマリー統計 */
  summary: {
    /** パターン総数 */
    totalPatterns: number;
    /** タイプ別カウント */
    byType: Record<MotionPattern['type'], number>;
    /** トリガー別カウント */
    byTrigger: Record<MotionPattern['trigger'], number>;
    /** 平均再生時間 */
    averageDuration: number;
    /** 無限アニメーションの有無 */
    hasInfiniteAnimations: boolean;
    /** 複雑度スコア (0-100) */
    complexityScore: number;
  };
  /** 警告 */
  warnings: MotionWarning[];
}

/**
 * モーション警告
 */
export interface MotionWarning {
  /** 警告タイプ */
  type: 'performance' | 'accessibility' | 'compatibility';
  /** 重要度 */
  severity: 'low' | 'medium' | 'high';
  /** メッセージ */
  message: string;
  /** 関連するパターン名 */
  pattern?: string;
  /** 改善提案 */
  suggestion?: string;
}

/**
 * キーフレーム定義
 */
export interface KeyframeDefinition {
  /** キーフレーム名 */
  name: string;
  /** ステップ */
  steps: KeyframeStep[];
}

/**
 * キーフレームステップ
 */
export interface KeyframeStep {
  /** オフセット (0-1) */
  offset: number;
  /** プロパティ群 */
  properties: { name: string; value: string }[];
  /** タイミング関数（ステップ固有） */
  timingFunction?: string;
}

/**
 * MotionDetector オプション
 */
export interface MotionDetectorOptions {
  /** インラインスタイルを含める（デフォルト: true） */
  includeInlineStyles?: boolean;
  /** スタイルシートを含める（デフォルト: true） */
  includeStyleSheets?: boolean;
  /** 最小再生時間フィルタ（デフォルト: 0ms） */
  minDuration?: number;
  /** DOM探索最大深度（デフォルト: 10） */
  maxDepth?: number;
}

/**
 * CSSスタイル宣言の型定義（Node.js環境用）
 * ブラウザのCSSStyleDeclarationを模倣
 */
export interface CSSStyleProperties {
  /** アニメーション名 */
  animationName?: string;
  /** アニメーション */
  animation?: string;
  /** アニメーション再生時間 */
  animationDuration?: string;
  /** アニメーションディレイ */
  animationDelay?: string;
  /** アニメーションタイミング関数 */
  animationTimingFunction?: string;
  /** アニメーション繰り返し回数 */
  animationIterationCount?: string;
  /** アニメーション方向 */
  animationDirection?: string;
  /** アニメーションフィルモード */
  animationFillMode?: string;
  /** アニメーション再生状態 */
  animationPlayState?: string;
  /** トランジション */
  transition?: string;
  /** トランジションプロパティ */
  transitionProperty?: string;
  /** トランジション再生時間 */
  transitionDuration?: string;
  /** トランジションディレイ */
  transitionDelay?: string;
  /** トランジションタイミング関数 */
  transitionTimingFunction?: string;
  /** その他のプロパティ */
  [key: string]: string | undefined;
}
