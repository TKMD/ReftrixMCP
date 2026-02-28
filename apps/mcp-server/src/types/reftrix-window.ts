// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reftrix Window拡張型定義
 *
 * ブラウザコンテキストで使用するカスタムWindowプロパティの型定義。
 * RuntimeAnimationDetectorServiceがIntersectionObserverとrequestAnimationFrameを
 * フックしてモーションパターンを検出する際に使用する。
 *
 * @module types/reftrix-window
 */

/**
 * IntersectionObserver追跡情報
 *
 * フックされたIntersectionObserverの設定とターゲット要素を保持。
 */
export interface ReftrixIOObserverInfo {
  /** 内部管理用ID */
  id: number;
  /** 監視対象のDOM要素配列 */
  targets: Element[];
  /** IntersectionObserverのthreshold設定 */
  threshold: number[];
  /** IntersectionObserverのrootMargin設定 */
  rootMargin: string;
  /** IntersectionObserverのroot要素（CSSセレクタまたはundefined） */
  root: string | undefined;
  /** ターゲット要素のCSSセレクタ配列 */
  targetSelectors: string[];
}

/**
 * IntersectionObserverトリガー情報
 *
 * IntersectionObserverがトリガーされた際のイベント情報。
 */
export interface ReftrixIOTriggerInfo {
  /** トリガーされた要素のCSSセレクタ */
  selector: string;
  /** トリガー発生時のタイムスタンプ（Date.now()） */
  time: number;
  /** 交差比率（0-1） */
  ratio: number;
}

/**
 * requestAnimationFrameコールバックデータ
 *
 * 各RAFコールバックの実行統計を保持。
 */
export interface ReftrixRAFCallbackData {
  /** コールバック呼び出し回数 */
  callCount: number;
  /** フレーム間隔の履歴（ms） */
  frameTimes: number[];
  /** 最後の実行時刻（performance.now()） */
  lastTime: number;
  /** 変更されたDOM要素のセレクタSet */
  modifiedElements: Set<string>;
  /** コールバックがアクティブかどうか */
  isActive: boolean;
}

/**
 * requestAnimationFrame追跡データ
 *
 * フックされたRAFコールバックの管理データ。
 */
export interface ReftrixRAFData {
  /** コールバックID → コールバックデータのMap */
  callbacks: Map<number, ReftrixRAFCallbackData>;
  /** 次に割り当てるコールバックID */
  nextId: number;
}

/**
 * Reftrix拡張Windowインターフェース
 *
 * RuntimeAnimationDetectorServiceがブラウザコンテキストで使用する
 * カスタムプロパティを定義したWindow拡張。
 */
export interface ReftrixWindow {
  /** フックされたIntersectionObserver情報の配列 */
  __reftrix_io_observers?: ReftrixIOObserverInfo[];
  /** IntersectionObserverがフック済みかどうか */
  __reftrix_io_hooked?: boolean;
  /** IntersectionObserverトリガーイベントの配列 */
  __reftrix_io_triggers?: ReftrixIOTriggerInfo[];
  /** requestAnimationFrameがフック済みかどうか */
  __reftrix_raf_hooked?: boolean;
  /** requestAnimationFrame追跡データ */
  __reftrix_raf_data?: ReftrixRAFData;
}

// ============================================================================
// 型ガード関数
// ============================================================================

/**
 * ReftrixIOObserverInfo型ガード
 *
 * @param value - 検証対象の値
 * @returns ReftrixIOObserverInfo型かどうか
 */
export function isReftrixIOObserverInfo(
  value: unknown
): value is ReftrixIOObserverInfo {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'number' &&
    Array.isArray(obj.targets) &&
    Array.isArray(obj.threshold) &&
    typeof obj.rootMargin === 'string' &&
    Array.isArray(obj.targetSelectors)
  );
}

/**
 * ReftrixRAFData型ガード
 *
 * @param value - 検証対象の値
 * @returns ReftrixRAFData型かどうか
 */
export function isReftrixRAFData(value: unknown): value is ReftrixRAFData {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return obj.callbacks instanceof Map && typeof obj.nextId === 'number';
}

// ============================================================================
// ファクトリ関数
// ============================================================================

/**
 * 空のReftrixRAFDataを生成
 *
 * @returns 初期化されたReftrixRAFData
 */
export function createEmptyRAFData(): ReftrixRAFData {
  return {
    callbacks: new Map(),
    nextId: 1,
  };
}

/**
 * 初期ReftrixRAFCallbackDataを生成
 *
 * @returns 初期化されたReftrixRAFCallbackData
 */
export function createRAFCallbackData(): ReftrixRAFCallbackData {
  return {
    callCount: 0,
    frameTimes: [],
    lastTime: 0,
    modifiedElements: new Set(),
    isActive: true,
  };
}

// ============================================================================
// グローバル型拡張
// ============================================================================

/**
 * グローバルWindow型を拡張
 *
 * これにより、ブラウザコンテキストのコードで@ts-expect-errorなしに
 * カスタムプロパティにアクセス可能になる。
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- グローバル型拡張のためのinterface merging
  interface Window extends ReftrixWindow {}
}
