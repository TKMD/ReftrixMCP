// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Performance Evaluation Service テスト
 * TDD Red Phase: テスト先行
 *
 * テスト対象:
 * - Budget比較（compareBudget）
 * - 改善提案生成（generateRecommendations）
 * - 評価サービス統合（PerformanceEvaluationService.evaluate）
 * - NaN/Infinity防御
 * - デフォルトBudget値
 *
 * @module tests/services/performance-evaluation.service.test
 */

import { describe, it, expect } from "vitest";
import {
  compareBudget,
  generateRecommendations,
  PerformanceEvaluationService,
  DEFAULT_PERFORMANCE_BUDGET,
  type PerformanceBudget,
  type BudgetComparison,
  type PerformanceRecommendation,
} from "../../src/services/performance/performance-evaluation.service";
import {
  type CwvMetrics,
  type CwvScoreResult,
  buildCwvMetrics,
} from "../../src/services/performance/core-web-vitals.service";

// =====================================================
// テストヘルパー
// =====================================================

function createGoodMetrics(): CwvMetrics {
  return buildCwvMetrics({
    lcp: 1000,
    fid: 50,
    cls: 0.05,
    inp: 100,
    ttfb: 400,
  });
}

function createPoorMetrics(): CwvMetrics {
  return buildCwvMetrics({
    lcp: 5000,
    fid: 500,
    cls: 0.5,
    inp: 600,
    ttfb: 3000,
  });
}

function createMixedMetrics(): CwvMetrics {
  return buildCwvMetrics({
    lcp: 3500,
    fid: 200,
    cls: 0.15,
    inp: 300,
    ttfb: 1500,
  });
}

function createCwvResult(metrics: CwvMetrics, score: number): CwvScoreResult {
  return {
    score,
    metrics,
    grade: score >= 90 ? "A" : score >= 75 ? "B" : score >= 50 ? "C" : score >= 25 ? "D" : "F",
    measuredAt: new Date().toISOString(),
  };
}

// =====================================================
// DEFAULT_PERFORMANCE_BUDGET テスト
// =====================================================

describe("DEFAULT_PERFORMANCE_BUDGET", () => {
  it("Google推奨値と一致", () => {
    expect(DEFAULT_PERFORMANCE_BUDGET.lcpMs).toBe(2500);
    expect(DEFAULT_PERFORMANCE_BUDGET.cls).toBe(0.1);
    expect(DEFAULT_PERFORMANCE_BUDGET.fidMs).toBe(100);
    expect(DEFAULT_PERFORMANCE_BUDGET.ttfbMs).toBe(800);
    expect(DEFAULT_PERFORMANCE_BUDGET.inpMs).toBe(200);
  });
});

// =====================================================
// compareBudget テスト
// =====================================================

describe("compareBudget", () => {
  it("全指標がBudget内 → withinBudget: true", () => {
    const metrics = createGoodMetrics();
    const comparisons = compareBudget(metrics, DEFAULT_PERFORMANCE_BUDGET);

    expect(comparisons).toHaveLength(5);
    for (const comp of comparisons) {
      expect(comp.withinBudget).toBe(true);
      expect(comp.overagePercent).toBe(0);
    }
  });

  it("全指標がBudget超過 → withinBudget: false", () => {
    const metrics = createPoorMetrics();
    const comparisons = compareBudget(metrics, DEFAULT_PERFORMANCE_BUDGET);

    const lcpComp = comparisons.find((c) => c.metric === "LCP");
    expect(lcpComp?.withinBudget).toBe(false);
    expect(lcpComp?.overagePercent).toBeGreaterThan(0);

    const fidComp = comparisons.find((c) => c.metric === "FID");
    expect(fidComp?.withinBudget).toBe(false);

    const clsComp = comparisons.find((c) => c.metric === "CLS");
    expect(clsComp?.withinBudget).toBe(false);
  });

  it("LCP Budget比較の正確性", () => {
    const metrics = createPoorMetrics(); // LCP: 5000ms
    const comparisons = compareBudget(metrics, DEFAULT_PERFORMANCE_BUDGET); // Budget: 2500ms
    const lcpComp = comparisons.find((c) => c.metric === "LCP")!;

    expect(lcpComp.actual).toBe(5000);
    expect(lcpComp.budget).toBe(2500);
    expect(lcpComp.withinBudget).toBe(false);
    // 超過率: (5000 - 2500) / 2500 * 100 = 100%
    expect(lcpComp.overagePercent).toBe(100);
  });

  it("カスタムBudgetを使用", () => {
    const metrics = createMixedMetrics(); // LCP: 3500ms
    const customBudget: PerformanceBudget = {
      lcpMs: 4000,
      cls: 0.2,
      fidMs: 250,
      ttfbMs: 2000,
      inpMs: 400,
    };
    const comparisons = compareBudget(metrics, customBudget);

    // 3500 <= 4000 → within budget
    const lcpComp = comparisons.find((c) => c.metric === "LCP");
    expect(lcpComp?.withinBudget).toBe(true);
  });

  it("NaN/Infinity防御", () => {
    const metrics = buildCwvMetrics({
      lcp: NaN,
      fid: Infinity,
      cls: null,
      inp: null,
      ttfb: null,
    });
    const comparisons = compareBudget(metrics, DEFAULT_PERFORMANCE_BUDGET);

    // comparisonsの値がすべてfinite
    for (const comp of comparisons) {
      expect(Number.isFinite(comp.actual)).toBe(true);
      expect(Number.isFinite(comp.budget)).toBe(true);
      expect(Number.isFinite(comp.overagePercent)).toBe(true);
    }
  });
});

// =====================================================
// generateRecommendations テスト
// =====================================================

describe("generateRecommendations", () => {
  it("全指標Good → 空の推奨事項", () => {
    const metrics = createGoodMetrics();
    const comparisons = compareBudget(metrics, DEFAULT_PERFORMANCE_BUDGET);
    const recommendations = generateRecommendations(metrics, comparisons);

    expect(recommendations).toHaveLength(0);
  });

  it("Poor指標に対してhigh優先度の推奨事項を生成", () => {
    const metrics = createPoorMetrics();
    const comparisons = compareBudget(metrics, DEFAULT_PERFORMANCE_BUDGET);
    const recommendations = generateRecommendations(metrics, comparisons);

    expect(recommendations.length).toBeGreaterThan(0);

    // LCPがPoor → 推奨事項にLCPが含まれる
    const lcpRec = recommendations.find((r) => r.metric === "LCP");
    expect(lcpRec).toBeDefined();
    expect(lcpRec?.priority).toBe("high");
    expect(lcpRec?.suggestion.length).toBeGreaterThan(0);
    expect(lcpRec?.estimatedImpact.length).toBeGreaterThan(0);
  });

  it("Needs-improvement指標に対してmedium優先度の推奨事項を生成", () => {
    const metrics = createMixedMetrics();
    const comparisons = compareBudget(metrics, DEFAULT_PERFORMANCE_BUDGET);
    const recommendations = generateRecommendations(metrics, comparisons);

    // 何らかの推奨事項が生成される
    expect(recommendations.length).toBeGreaterThan(0);
  });

  it("3つ以上のBudget超過 → Overall推奨事項を含む", () => {
    const metrics = createPoorMetrics();
    const comparisons = compareBudget(metrics, DEFAULT_PERFORMANCE_BUDGET);
    const recommendations = generateRecommendations(metrics, comparisons);

    const overallRec = recommendations.find((r) => r.metric === "Overall");
    expect(overallRec).toBeDefined();
    expect(overallRec?.priority).toBe("high");
  });

  it("推奨事項は優先度順にソートされる", () => {
    const metrics = createPoorMetrics();
    const comparisons = compareBudget(metrics, DEFAULT_PERFORMANCE_BUDGET);
    const recommendations = generateRecommendations(metrics, comparisons);

    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < recommendations.length; i++) {
      const prev = priorityOrder[recommendations[i - 1].priority] ?? 2;
      const curr = priorityOrder[recommendations[i].priority] ?? 2;
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });

  it("各推奨事項にmetric, priority, suggestion, estimatedImpactが含まれる", () => {
    const metrics = createPoorMetrics();
    const comparisons = compareBudget(metrics, DEFAULT_PERFORMANCE_BUDGET);
    const recommendations = generateRecommendations(metrics, comparisons);

    for (const rec of recommendations) {
      expect(rec.metric).toBeDefined();
      expect(rec.metric.length).toBeGreaterThan(0);
      expect(["high", "medium", "low"]).toContain(rec.priority);
      expect(rec.suggestion.length).toBeGreaterThan(0);
      expect(rec.estimatedImpact.length).toBeGreaterThan(0);
    }
  });
});

// =====================================================
// PerformanceEvaluationService テスト
// =====================================================

describe("PerformanceEvaluationService", () => {
  const service = new PerformanceEvaluationService();

  describe("evaluate", () => {
    it("Good結果を正しく評価", () => {
      const metrics = createGoodMetrics();
      const cwvResult = createCwvResult(metrics, 100);
      const result = service.evaluate(cwvResult);

      expect(result.score).toBe(100);
      expect(result.grade).toBe("A");
      expect(result.metrics).toEqual(metrics);
      expect(result.budgetComparisons).toHaveLength(5);
      expect(result.recommendations).toHaveLength(0);
      expect(result.measuredAt).toBeDefined();
    });

    it("Poor結果を正しく評価", () => {
      const metrics = createPoorMetrics();
      const cwvResult = createCwvResult(metrics, 0);
      const result = service.evaluate(cwvResult);

      expect(result.score).toBe(0);
      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.budgetComparisons.some((c) => !c.withinBudget)).toBe(true);
    });

    it("カスタムBudgetを使用できる", () => {
      const metrics = createMixedMetrics();
      const cwvResult = createCwvResult(metrics, 50);
      const customBudget: PerformanceBudget = {
        lcpMs: 5000,
        cls: 1,
        fidMs: 1000,
        ttfbMs: 5000,
        inpMs: 1000,
      };
      const result = service.evaluate(cwvResult, customBudget);

      // 緩いBudgetなので全てwithinBudget
      for (const comp of result.budgetComparisons) {
        expect(comp.withinBudget).toBe(true);
      }
    });

    it("デフォルトBudgetが使用される", () => {
      const metrics = createGoodMetrics();
      const cwvResult = createCwvResult(metrics, 100);
      const result = service.evaluate(cwvResult);

      const lcpComp = result.budgetComparisons.find((c) => c.metric === "LCP");
      expect(lcpComp?.budget).toBe(DEFAULT_PERFORMANCE_BUDGET.lcpMs);
    });
  });
});
