// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Responsive Diff Service
 * 3ビューポート間のレイアウト差分検出サービス
 *
 * セクション表示/非表示、フォントサイズ変化、グリッドカラム変化、
 * スペーシング変化を検出し、差分スコア（0-100）を計算する。
 *
 * @module services/responsive/responsive-diff.service
 */

import { logger, isDevelopment } from "../../utils/logger";
import type { ResponsiveViewport } from "./types";

// ============================================================================
// 型定義 / Types
// ============================================================================

/**
 * デバイスキャプチャデータ（差分分析入力）
 * Device capture data used as input for diff analysis
 */
export interface DeviceCaptureData {
  viewport: ResponsiveViewport;
  sections: DeviceSectionData[];
  documentHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * セクションデータ
 * Section data extracted from DOM
 */
export interface DeviceSectionData {
  selector: string;
  tagName: string;
  display: string;
  visibility: string;
  boundingRect: { x: number; y: number; width: number; height: number };
  gridColumns?: number;
  flexDirection?: string;
  fontSize?: number;
}

/**
 * 差分変化タイプ
 * Types of responsive layout changes
 */
export type DiffChangeType = "visibility" | "layout" | "typography" | "spacing";

/**
 * 個別差分変化
 * Individual diff change item
 */
export interface DiffChange {
  element: string;
  type: DiffChangeType;
  description: string;
  details: Record<string, unknown>;
  score?: number;
}

/**
 * 差分結果
 * Diff analysis result
 */
export interface ResponsiveDiffResult {
  /** 差分スコア（0-100、低いほど差分大） */
  score: number;
  /** 検出された変化のリスト */
  changes: DiffChange[];
}

// ============================================================================
// 定数 / Constants
// ============================================================================

/** スコア計算の重み / Score calculation weights */
const SCORE_WEIGHTS = {
  visibility: 25,
  layout: 30,
  typography: 20,
  spacing: 25,
} as const;

/** 差分スコア基準値 / Base score (perfect) */
const PERFECT_SCORE = 100;

// ============================================================================
// Service
// ============================================================================

/**
 * Responsive Diff Service
 * ビューポート間のレイアウト差分を分析する
 */
export class ResponsiveDiffService {
  /**
   * 複数デバイスキャプチャからレスポンシブ差分を計算
   *
   * @param captures - デバイスキャプチャデータ配列
   * @returns 差分結果（スコア + 変化リスト）
   */
  computeDiff(captures: DeviceCaptureData[]): ResponsiveDiffResult {
    if (captures.length <= 1) {
      return { score: PERFECT_SCORE, changes: [] };
    }

    if (isDevelopment()) {
      logger.debug("[ResponsiveDiff] Computing diff", {
        viewports: captures.map((c) => c.viewport.name),
      });
    }

    const changes: DiffChange[] = [];

    // 全ペアで比較
    for (let i = 0; i < captures.length; i++) {
      for (let j = i + 1; j < captures.length; j++) {
        const cap1 = captures[i]!;
        const cap2 = captures[j]!;
        const pairChanges = this.comparePair(cap1, cap2);
        changes.push(...pairChanges);
      }
    }

    // スコア計算
    const score = this.calculateScore(changes, captures.length);

    if (isDevelopment()) {
      logger.debug("[ResponsiveDiff] Diff completed", {
        changeCount: changes.length,
        score,
      });
    }

    return { score, changes };
  }

  /**
   * 2つのキャプチャを比較
   */
  private comparePair(cap1: DeviceCaptureData, cap2: DeviceCaptureData): DiffChange[] {
    const changes: DiffChange[] = [];
    const name1 = cap1.viewport.name;
    const name2 = cap2.viewport.name;

    // セレクタでマッチング
    const map2 = new Map(cap2.sections.map((s) => [s.selector, s]));

    for (const sec1 of cap1.sections) {
      const sec2 = map2.get(sec1.selector);
      if (!sec2) continue;

      // 表示/非表示の差分検出 / Visibility diff
      const visible1 = this.isVisible(sec1);
      const visible2 = this.isVisible(sec2);
      if (visible1 !== visible2) {
        changes.push({
          element: sec1.selector,
          type: "visibility",
          description: `${sec1.selector} is ${visible1 ? "visible" : "hidden"} on ${name1}, ${visible2 ? "visible" : "hidden"} on ${name2}`,
          details: {
            [name1]: visible1 ? "visible" : "hidden",
            [name2]: visible2 ? "visible" : "hidden",
          },
        });
      }

      // グリッドカラム変化 / Grid columns diff
      if (
        sec1.gridColumns !== undefined &&
        sec2.gridColumns !== undefined &&
        sec1.gridColumns !== sec2.gridColumns
      ) {
        changes.push({
          element: sec1.selector,
          type: "layout",
          description: `Grid columns changed: ${sec1.gridColumns} (${name1}) -> ${sec2.gridColumns} (${name2})`,
          details: {
            [name1]: { gridColumns: sec1.gridColumns },
            [name2]: { gridColumns: sec2.gridColumns },
          },
        });
      }

      // display値の変化 / Display property diff
      if (sec1.display !== sec2.display && visible1 && visible2) {
        changes.push({
          element: sec1.selector,
          type: "layout",
          description: `Display changed: ${sec1.display} (${name1}) -> ${sec2.display} (${name2})`,
          details: {
            [name1]: { display: sec1.display },
            [name2]: { display: sec2.display },
          },
        });
      }

      // フレックス方向の変化 / Flex direction diff
      if (
        sec1.flexDirection !== undefined &&
        sec2.flexDirection !== undefined &&
        sec1.flexDirection !== sec2.flexDirection
      ) {
        changes.push({
          element: sec1.selector,
          type: "layout",
          description: `Flex direction changed: ${sec1.flexDirection} (${name1}) -> ${sec2.flexDirection} (${name2})`,
          details: {
            [name1]: { flexDirection: sec1.flexDirection },
            [name2]: { flexDirection: sec2.flexDirection },
          },
        });
      }

      // フォントサイズ変化 / Font size diff
      if (
        sec1.fontSize !== undefined &&
        sec2.fontSize !== undefined &&
        sec1.fontSize > 0 &&
        sec2.fontSize > 0 &&
        Math.abs(sec1.fontSize - sec2.fontSize) > 1
      ) {
        changes.push({
          element: sec1.selector,
          type: "typography",
          description: `Font size changed: ${sec1.fontSize}px (${name1}) -> ${sec2.fontSize}px (${name2})`,
          details: {
            [name1]: { fontSize: sec1.fontSize },
            [name2]: { fontSize: sec2.fontSize },
          },
        });
      }

      // スペーシング変化（水平位置/パディング推定） / Spacing diff
      if (visible1 && visible2) {
        const padding1 = sec1.boundingRect.x;
        const padding2 = sec2.boundingRect.x;
        // 有意な差分のみ検出（相対的に10%以上の差）
        const maxPadding = Math.max(padding1, padding2);
        if (maxPadding > 0 && Math.abs(padding1 - padding2) / maxPadding > 0.3) {
          changes.push({
            element: sec1.selector,
            type: "spacing",
            description: `Horizontal padding changed: ${padding1}px (${name1}) -> ${padding2}px (${name2})`,
            details: {
              [name1]: { paddingLeft: padding1 },
              [name2]: { paddingLeft: padding2 },
            },
          });
        }
      }
    }

    return changes;
  }

  /**
   * 要素が表示されているかどうか判定
   */
  private isVisible(section: DeviceSectionData): boolean {
    if (section.display === "none") return false;
    if (section.visibility === "hidden") return false;
    if (section.boundingRect.width === 0 && section.boundingRect.height === 0) {
      return false;
    }
    return true;
  }

  /**
   * 差分スコアを計算（0-100、高いほど差分少ない）
   */
  private calculateScore(changes: DiffChange[], viewportCount: number): number {
    if (changes.length === 0) return PERFECT_SCORE;

    // カテゴリ別の変化数をカウント
    const categoryCounts: Record<DiffChangeType, number> = {
      visibility: 0,
      layout: 0,
      typography: 0,
      spacing: 0,
    };

    for (const change of changes) {
      categoryCounts[change.type]++;
    }

    // ペア数で正規化（ビューポート数が多いほど多くのペアがある）
    const pairCount = Math.max(1, (viewportCount * (viewportCount - 1)) / 2);

    // カテゴリ別の減点を計算
    let totalDeduction = 0;
    for (const [category, weight] of Object.entries(SCORE_WEIGHTS)) {
      const count = categoryCounts[category as DiffChangeType];
      // 1変化あたりのペナルティ（ペア数で正規化）
      const categoryDeduction = Math.min(weight, (count / pairCount) * weight);
      totalDeduction += categoryDeduction;
    }

    const score = Math.max(0, Math.min(PERFECT_SCORE, PERFECT_SCORE - totalDeduction));

    // NaN/Infinity防御 / NaN/Infinity defense
    if (!Number.isFinite(score)) {
      logger.warn("[ResponsiveDiff] Score calculation produced non-finite value, defaulting to 50");
      return 50;
    }

    return Math.round(score);
  }
}
