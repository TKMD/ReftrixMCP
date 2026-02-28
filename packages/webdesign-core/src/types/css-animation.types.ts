// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSSアニメーション解析用型定義
 * @module @reftrix/webdesign-core/types/css-animation
 */

/**
 * @keyframesの1ステップを表す型
 */
export interface KeyframeStep {
  /** オフセット値（0-1の範囲） */
  offset: number;
  /** CSSプロパティと値のマップ */
  properties: Record<string, string>;
}

/**
 * @keyframes定義を表す型
 */
export interface KeyframeDefinition {
  /** アニメーション名 */
  name: string;
  /** キーフレームのステップ配列 */
  keyframes: KeyframeStep[];
  /** 元のCSSテキスト */
  raw: string;
}

/**
 * animation shorthandプロパティの解析結果
 */
export interface AnimationShorthand {
  /** アニメーション名 */
  name: string;
  /** 持続時間（ミリ秒） */
  duration: number;
  /** タイミング関数 */
  timingFunction: string;
  /** 遅延時間（ミリ秒） */
  delay: number;
  /** 繰り返し回数（'infinite'は無限） */
  iterationCount: number | 'infinite';
  /** 再生方向 */
  direction: AnimationDirection;
  /** フィルモード */
  fillMode: AnimationFillMode;
  /** 再生状態 */
  playState: AnimationPlayState;
}

/**
 * animation-direction値
 */
export type AnimationDirection = 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';

/**
 * animation-fill-mode値
 */
export type AnimationFillMode = 'none' | 'forwards' | 'backwards' | 'both';

/**
 * animation-play-state値
 */
export type AnimationPlayState = 'running' | 'paused';

/**
 * transition定義を表す型
 */
export interface TransitionDefinition {
  /** 対象プロパティ */
  property: string;
  /** 持続時間（ミリ秒） */
  duration: number;
  /** タイミング関数 */
  timingFunction: string;
  /** 遅延時間（ミリ秒） */
  delay: number;
}

/**
 * タイミング関数の種類
 */
export type TimingFunctionType = 'keyword' | 'cubic-bezier' | 'steps';

/**
 * タイミング関数の詳細情報
 */
export interface TimingFunctionInfo {
  /** タイミング関数の種類 */
  type: TimingFunctionType;
  /** 元の値文字列 */
  value: string;
  /** cubic-bezierの制御点（type='cubic-bezier'の場合） */
  controlPoints?: [number, number, number, number];
  /** stepsのステップ数（type='steps'の場合） */
  steps?: number;
  /** stepsのジャンプ項（type='steps'の場合） */
  jumpTerm?: StepsJumpTerm;
}

/**
 * steps()のジャンプ項
 */
export type StepsJumpTerm = 'start' | 'end' | 'none' | 'both' | 'jump-start' | 'jump-end' | 'jump-none' | 'jump-both';

/**
 * CSSAnimationParserのデフォルト値
 */
export const CSS_ANIMATION_DEFAULTS: Readonly<AnimationShorthand> = {
  name: 'none',
  duration: 0,
  timingFunction: 'ease',
  delay: 0,
  iterationCount: 1,
  direction: 'normal',
  fillMode: 'none',
  playState: 'running',
};

/**
 * TransitionDefinitionのデフォルト値
 */
export const CSS_TRANSITION_DEFAULTS: Readonly<TransitionDefinition> = {
  property: 'all',
  duration: 0,
  timingFunction: 'ease',
  delay: 0,
};

/**
 * animation-directionの有効値
 */
export const ANIMATION_DIRECTION_VALUES: readonly AnimationDirection[] = [
  'normal',
  'reverse',
  'alternate',
  'alternate-reverse',
];

/**
 * animation-fill-modeの有効値
 */
export const ANIMATION_FILL_MODE_VALUES: readonly AnimationFillMode[] = [
  'none',
  'forwards',
  'backwards',
  'both',
];

/**
 * animation-play-stateの有効値
 */
export const ANIMATION_PLAY_STATE_VALUES: readonly AnimationPlayState[] = [
  'running',
  'paused',
];

/**
 * タイミング関数キーワードとcubic-bezier値のマップ
 */
export const TIMING_FUNCTION_KEYWORDS: Readonly<Record<string, [number, number, number, number]>> = {
  'ease': [0.25, 0.1, 0.25, 1],
  'linear': [0, 0, 1, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

/**
 * ベンダープレフィックス
 */
export const VENDOR_PREFIXES = ['-webkit-', '-moz-', '-ms-', '-o-'] as const;
