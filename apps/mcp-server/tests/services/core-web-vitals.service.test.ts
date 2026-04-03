// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Core Web Vitals Service テスト
 * TDD Red Phase: テスト先行
 *
 * テスト対象:
 * - CWV指標の評価（rateMetric）
 * - 指標値→スコア変換（metricToScore、clsToScore）
 * - CWVスコア計算（calculateCwvScore）
 * - スコア→グレード変換（scoreToGrade）
 * - 生データ→メトリクス構築（buildCwvMetrics）
 * - NaN/Infinity防御
 * - Google CWV閾値の正確性
 *
 * @module tests/services/core-web-vitals.service.test
 */

import { describe, it, expect } from "vitest";
import {
  rateMetric,
  metricToScore,
  clsToScore,
  calculateCwvScore,
  scoreToGrade,
  buildCwvMetrics,
  CWV_THRESHOLDS,
  CWV_WEIGHTS,
  type CwvMetrics,
  type RawCwvData,
  type MetricRating,
} from "../../src/services/performance/core-web-vitals.service";

// =====================================================
// rateMetric テスト / rateMetric tests
// =====================================================

describe("rateMetric", () => {
  describe("LCP閾値（Good: <=2500ms, Poor: >4000ms）", () => {
    it("LCP 1000ms → good", () => {
      expect(rateMetric(1000, CWV_THRESHOLDS.lcp)).toBe("good");
    });

    it("LCP 2500ms → good（境界値）", () => {
      expect(rateMetric(2500, CWV_THRESHOLDS.lcp)).toBe("good");
    });

    it("LCP 3000ms → needs-improvement", () => {
      expect(rateMetric(3000, CWV_THRESHOLDS.lcp)).toBe("needs-improvement");
    });

    it("LCP 4000ms → needs-improvement（境界値）", () => {
      expect(rateMetric(4000, CWV_THRESHOLDS.lcp)).toBe("needs-improvement");
    });

    it("LCP 5000ms → poor", () => {
      expect(rateMetric(5000, CWV_THRESHOLDS.lcp)).toBe("poor");
    });
  });

  describe("FID閾値（Good: <=100ms, Poor: >300ms）", () => {
    it("FID 50ms → good", () => {
      expect(rateMetric(50, CWV_THRESHOLDS.fid)).toBe("good");
    });

    it("FID 200ms → needs-improvement", () => {
      expect(rateMetric(200, CWV_THRESHOLDS.fid)).toBe("needs-improvement");
    });

    it("FID 500ms → poor", () => {
      expect(rateMetric(500, CWV_THRESHOLDS.fid)).toBe("poor");
    });
  });

  describe("CLS閾値（Good: <=0.1, Poor: >0.25）", () => {
    it("CLS 0.05 → good", () => {
      expect(rateMetric(0.05, CWV_THRESHOLDS.cls)).toBe("good");
    });

    it("CLS 0.1 → good（境界値）", () => {
      expect(rateMetric(0.1, CWV_THRESHOLDS.cls)).toBe("good");
    });

    it("CLS 0.15 → needs-improvement", () => {
      expect(rateMetric(0.15, CWV_THRESHOLDS.cls)).toBe("needs-improvement");
    });

    it("CLS 0.3 → poor", () => {
      expect(rateMetric(0.3, CWV_THRESHOLDS.cls)).toBe("poor");
    });
  });

  describe("NaN/Infinity防御", () => {
    it("NaN → poor", () => {
      expect(rateMetric(NaN, CWV_THRESHOLDS.lcp)).toBe("poor");
    });

    it("Infinity → poor", () => {
      expect(rateMetric(Infinity, CWV_THRESHOLDS.lcp)).toBe("poor");
    });

    it("-Infinity → poor", () => {
      expect(rateMetric(-Infinity, CWV_THRESHOLDS.lcp)).toBe("poor");
    });

    it("負の値 → poor", () => {
      expect(rateMetric(-100, CWV_THRESHOLDS.lcp)).toBe("poor");
    });
  });

  describe("0値", () => {
    it("0 → good（全指標で0はGood）", () => {
      expect(rateMetric(0, CWV_THRESHOLDS.lcp)).toBe("good");
      expect(rateMetric(0, CWV_THRESHOLDS.fid)).toBe("good");
      expect(rateMetric(0, CWV_THRESHOLDS.cls)).toBe("good");
    });
  });
});

// =====================================================
// metricToScore テスト / metricToScore tests
// =====================================================

describe("metricToScore", () => {
  describe("LCPスコア変換", () => {
    it("Good値以下 → 100", () => {
      expect(metricToScore(1000, CWV_THRESHOLDS.lcp)).toBe(100);
    });

    it("Good境界値 → 100", () => {
      expect(metricToScore(2500, CWV_THRESHOLDS.lcp)).toBe(100);
    });

    it("Poor境界値以上 → 0", () => {
      expect(metricToScore(4000, CWV_THRESHOLDS.lcp)).toBe(0);
    });

    it("Good-Poor中間値 → 中間スコア", () => {
      // 3250 = (2500 + 4000) / 2 → 50
      expect(metricToScore(3250, CWV_THRESHOLDS.lcp)).toBe(50);
    });
  });

  describe("NaN/Infinity防御", () => {
    it("NaN → 0", () => {
      expect(metricToScore(NaN, CWV_THRESHOLDS.lcp)).toBe(0);
    });

    it("Infinity → 0", () => {
      expect(metricToScore(Infinity, CWV_THRESHOLDS.lcp)).toBe(0);
    });

    it("負の値 → 0", () => {
      expect(metricToScore(-100, CWV_THRESHOLDS.lcp)).toBe(0);
    });
  });

  describe("0値", () => {
    it("0 → 100", () => {
      expect(metricToScore(0, CWV_THRESHOLDS.lcp)).toBe(100);
    });
  });
});

// =====================================================
// clsToScore テスト / clsToScore tests
// =====================================================

describe("clsToScore", () => {
  it("CLS 0 → 100", () => {
    expect(clsToScore(0)).toBe(100);
  });

  it("CLS 0.1（Good境界値）→ 100", () => {
    expect(clsToScore(0.1)).toBe(100);
  });

  it("CLS 0.25（Poor境界値）→ 0", () => {
    expect(clsToScore(0.25)).toBe(0);
  });

  it("CLS 0.175（中間）→ 50", () => {
    expect(clsToScore(0.175)).toBe(50);
  });
});

// =====================================================
// calculateCwvScore テスト / calculateCwvScore tests
// =====================================================

describe("calculateCwvScore", () => {
  it("全指標Good → 100", () => {
    const metrics: CwvMetrics = {
      lcp: { value: 1000, rating: "good", unit: "ms" },
      fid: { value: 50, rating: "good", unit: "ms" },
      cls: { value: 0.05, rating: "good", unit: "score" },
      inp: { value: 100, rating: "good", unit: "ms" },
      ttfb: { value: 400, rating: "good", unit: "ms" },
    };
    expect(calculateCwvScore(metrics)).toBe(100);
  });

  it("全指標Poor → 0", () => {
    const metrics: CwvMetrics = {
      lcp: { value: 5000, rating: "poor", unit: "ms" },
      fid: { value: 500, rating: "poor", unit: "ms" },
      cls: { value: 0.5, rating: "poor", unit: "score" },
      inp: { value: 600, rating: "poor", unit: "ms" },
      ttfb: { value: 3000, rating: "poor", unit: "ms" },
    };
    expect(calculateCwvScore(metrics)).toBe(0);
  });

  it("混合指標 → 中間スコア（0-100範囲内）", () => {
    const metrics: CwvMetrics = {
      lcp: { value: 2000, rating: "good", unit: "ms" },
      fid: { value: 200, rating: "needs-improvement", unit: "ms" },
      cls: { value: 0.15, rating: "needs-improvement", unit: "score" },
      inp: { value: 300, rating: "needs-improvement", unit: "ms" },
      ttfb: { value: 1000, rating: "needs-improvement", unit: "ms" },
    };
    const score = calculateCwvScore(metrics);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(Number.isFinite(score)).toBe(true);
  });

  it("重み配分が正しい（LCP25%+FID25%+CLS25%+TTFB15%+INP10%=100%）", () => {
    const sum =
      CWV_WEIGHTS.lcp + CWV_WEIGHTS.fid + CWV_WEIGHTS.cls + CWV_WEIGHTS.ttfb + CWV_WEIGHTS.inp;
    expect(sum).toBe(1.0);
  });
});

// =====================================================
// scoreToGrade テスト / scoreToGrade tests
// =====================================================

describe("scoreToGrade", () => {
  it("90-100 → A", () => {
    expect(scoreToGrade(90)).toBe("A");
    expect(scoreToGrade(100)).toBe("A");
  });

  it("75-89 → B", () => {
    expect(scoreToGrade(75)).toBe("B");
    expect(scoreToGrade(89)).toBe("B");
  });

  it("50-74 → C", () => {
    expect(scoreToGrade(50)).toBe("C");
    expect(scoreToGrade(74)).toBe("C");
  });

  it("25-49 → D", () => {
    expect(scoreToGrade(25)).toBe("D");
    expect(scoreToGrade(49)).toBe("D");
  });

  it("0-24 → F", () => {
    expect(scoreToGrade(0)).toBe("F");
    expect(scoreToGrade(24)).toBe("F");
  });

  it("NaN → F", () => {
    expect(scoreToGrade(NaN)).toBe("F");
  });
});

// =====================================================
// buildCwvMetrics テスト / buildCwvMetrics tests
// =====================================================

describe("buildCwvMetrics", () => {
  it("正常値でメトリクスを構築", () => {
    const raw: RawCwvData = {
      lcp: 2000,
      fid: 80,
      cls: 0.05,
      inp: 150,
      ttfb: 600,
    };
    const metrics = buildCwvMetrics(raw);

    expect(metrics.lcp.value).toBe(2000);
    expect(metrics.lcp.rating).toBe("good");
    expect(metrics.lcp.unit).toBe("ms");

    expect(metrics.fid.value).toBe(80);
    expect(metrics.fid.rating).toBe("good");

    expect(metrics.cls.value).toBe(0.05);
    expect(metrics.cls.rating).toBe("good");
    expect(metrics.cls.unit).toBe("score");

    expect(metrics.inp.value).toBe(150);
    expect(metrics.inp.rating).toBe("good");

    expect(metrics.ttfb.value).toBe(600);
    expect(metrics.ttfb.rating).toBe("good");
  });

  it("null値にフォールバックを適用", () => {
    const raw: RawCwvData = {
      lcp: null,
      fid: null,
      cls: null,
      inp: null,
      ttfb: null,
    };
    const metrics = buildCwvMetrics(raw);

    // LCPはPoor値にフォールバック
    expect(metrics.lcp.value).toBe(CWV_THRESHOLDS.lcp.poor);
    expect(metrics.lcp.rating).toBe("needs-improvement");

    // FID/CLS/INPは操作無しとして0にフォールバック
    expect(metrics.fid.value).toBe(0);
    expect(metrics.fid.rating).toBe("good");

    expect(metrics.cls.value).toBe(0);
    expect(metrics.cls.rating).toBe("good");

    expect(metrics.inp.value).toBe(0);
    expect(metrics.inp.rating).toBe("good");

    // TTFBはPoor値にフォールバック
    expect(metrics.ttfb.value).toBe(CWV_THRESHOLDS.ttfb.poor);
  });

  it("負の値は0にクランプ", () => {
    const raw: RawCwvData = {
      lcp: -100,
      fid: -50,
      cls: -0.1,
      inp: -200,
      ttfb: -300,
    };
    const metrics = buildCwvMetrics(raw);

    expect(metrics.lcp.value).toBe(0);
    expect(metrics.fid.value).toBe(0);
    expect(metrics.cls.value).toBe(0);
    expect(metrics.inp.value).toBe(0);
    expect(metrics.ttfb.value).toBe(0);
  });

  it("NaN値にフォールバックを適用", () => {
    const raw: RawCwvData = {
      lcp: NaN,
      fid: NaN,
      cls: NaN,
      inp: NaN,
      ttfb: NaN,
    };
    const metrics = buildCwvMetrics(raw);

    // NaN → フォールバック値と同じ
    expect(Number.isFinite(metrics.lcp.value)).toBe(true);
    expect(Number.isFinite(metrics.fid.value)).toBe(true);
    expect(Number.isFinite(metrics.cls.value)).toBe(true);
    expect(Number.isFinite(metrics.inp.value)).toBe(true);
    expect(Number.isFinite(metrics.ttfb.value)).toBe(true);
  });
});

// =====================================================
// CWV_THRESHOLDS テスト / CWV_THRESHOLDS tests
// =====================================================

describe("CWV_THRESHOLDS", () => {
  it("Google公式閾値と一致", () => {
    expect(CWV_THRESHOLDS.lcp.good).toBe(2500);
    expect(CWV_THRESHOLDS.lcp.poor).toBe(4000);
    expect(CWV_THRESHOLDS.fid.good).toBe(100);
    expect(CWV_THRESHOLDS.fid.poor).toBe(300);
    expect(CWV_THRESHOLDS.cls.good).toBe(0.1);
    expect(CWV_THRESHOLDS.cls.poor).toBe(0.25);
    expect(CWV_THRESHOLDS.inp.good).toBe(200);
    expect(CWV_THRESHOLDS.inp.poor).toBe(500);
    expect(CWV_THRESHOLDS.ttfb.good).toBe(800);
    expect(CWV_THRESHOLDS.ttfb.poor).toBe(1800);
  });
});
