// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * aXe Core Shared Module
 *
 * JSDOM版とPlaywright版のaXeアクセシビリティサービス間で共有する
 * 定数、型定義、ユーティリティ関数を提供
 *
 * TDA Review指摘（重複コード18.88%）を解消するために抽出したモジュール
 *
 * @module services/quality/axe-core-shared
 */

import type { Result as AxeResult, AxeResults } from 'axe-core';

// =====================================================
// 型定義
// =====================================================

/**
 * 違反のインパクトレベル
 */
export type ViolationImpact = 'minor' | 'moderate' | 'serious' | 'critical';

/**
 * WCAGレベル
 */
export type WcagLevel = 'A' | 'AA' | 'AAA';

/**
 * aXe違反情報
 */
export interface AxeViolation {
  /** ルールID (e.g., 'image-alt', 'button-name') */
  id: string;
  /** インパクトレベル */
  impact: ViolationImpact;
  /** 違反の説明 */
  description: string;
  /** 修正方法のヘルプテキスト */
  help: string;
  /** 詳細なヘルプURL (deque.com) */
  helpUrl: string;
  /** 影響を受けるノード数 */
  nodes: number;
}

/**
 * aXeアクセシビリティ評価結果
 */
export interface AxeAccessibilityResult {
  /** 検出された違反のリスト */
  violations: AxeViolation[];
  /** 合格したルール数 */
  passes: number;
  /** アクセシビリティスコア (0-100) */
  score: number;
  /** WCAGレベル (A, AA, AAA) */
  wcagLevel: WcagLevel;
}

// =====================================================
// 定数
// =====================================================

/**
 * インパクトレベルごとのペナルティ
 * Craftsmanshipスコア調整に使用
 */
export const IMPACT_PENALTIES: Record<ViolationImpact, number> = {
  critical: -20,
  serious: -10,
  moderate: -5,
  minor: -2,
};

/**
 * WCAGレベルに対応するaXeタグ
 */
export const WCAG_LEVEL_TAGS: Record<WcagLevel, string[]> = {
  A: ['wcag2a', 'wcag21a'],
  AA: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  AAA: ['wcag2a', 'wcag2aa', 'wcag2aaa', 'wcag21a', 'wcag21aa', 'wcag21aaa'],
};

/**
 * スコアしきい値からWCAGレベルを決定
 * 降順でソート（高いしきい値から判定）
 */
export const SCORE_TO_WCAG_LEVEL: { threshold: number; level: WcagLevel }[] = [
  { threshold: 95, level: 'AAA' },
  { threshold: 80, level: 'AA' },
  { threshold: 0, level: 'A' },
];

// =====================================================
// ユーティリティ関数
// =====================================================

/**
 * 違反からCraftsmanshipスコア調整用のペナルティを計算
 *
 * @param result - aXe評価結果
 * @returns ペナルティ値（0以下の数値）
 */
export function calculateScorePenalty(result: AxeAccessibilityResult): number {
  let penalty = 0;

  for (const violation of result.violations) {
    const impactPenalty = IMPACT_PENALTIES[violation.impact] ?? 0;
    penalty += impactPenalty;
  }

  return penalty;
}

/**
 * aXe結果からアクセシビリティスコアを計算
 *
 * スコア計算ロジック:
 * - 基本スコア: 100
 * - 違反ごとにインパクトに応じたペナルティを減算
 * - スコアは0-100に制限
 *
 * @param results - aXe-coreの生の結果
 * @returns アクセシビリティスコア (0-100)
 */
export function calculateAccessibilityScore(results: AxeResults): number {
  let score = 100;

  // 違反によるペナルティ
  for (const violation of results.violations) {
    const impact = (violation.impact as ViolationImpact) ?? 'moderate';
    const penalty = Math.abs(IMPACT_PENALTIES[impact]);
    score -= penalty;
  }

  // スコアを0-100に制限
  return Math.max(0, Math.min(100, score));
}

/**
 * スコアと違反からWCAGレベルを決定
 *
 * @param score - アクセシビリティスコア (0-100)
 * @param violations - 検出された違反リスト
 * @returns WCAGレベル (A, AA, AAA)
 */
export function determineWcagLevel(score: number, violations: AxeViolation[]): WcagLevel {
  // Critical違反がある場合は必ずレベルA
  const hasCritical = violations.some((v) => v.impact === 'critical');
  if (hasCritical) {
    return 'A';
  }

  // Serious違反があり、かつスコアが90未満の場合はレベルA
  const hasSerious = violations.some((v) => v.impact === 'serious');
  if (hasSerious && score < 90) {
    return 'A';
  }

  // スコアベースでレベルを決定
  for (const { threshold, level } of SCORE_TO_WCAG_LEVEL) {
    if (score >= threshold) {
      return level;
    }
  }

  return 'A';
}

/**
 * 空の結果を作成
 *
 * @param wcagLevel - 設定するWCAGレベル（デフォルト: 'AA'）
 * @returns 空のAxeAccessibilityResult
 */
export function createEmptyResult(wcagLevel: WcagLevel = 'AA'): AxeAccessibilityResult {
  return {
    violations: [],
    passes: 0,
    score: 100,
    wcagLevel,
  };
}

/**
 * aXe違反をAxeViolationに変換
 *
 * @param violation - aXe-coreの生の違反オブジェクト
 * @returns 変換されたAxeViolation
 */
export function convertAxeViolation(violation: AxeResult): AxeViolation {
  return {
    id: violation.id,
    impact: (violation.impact as ViolationImpact) ?? 'moderate',
    description: violation.description,
    help: violation.help,
    helpUrl: violation.helpUrl,
    nodes: violation.nodes.length,
  };
}
