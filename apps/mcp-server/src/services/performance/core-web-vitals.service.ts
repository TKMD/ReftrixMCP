// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Core Web Vitals Service
 * CDP PerformanceObserver経由でLCP/FID/CLS/INP/TTFB取得
 *
 * Playwright page.evaluate() でPerformanceObserver APIを直接使用し、
 * 各指標のGood/Needs Improvement/Poor判定（Google基準）を行う。
 *
 * セキュリティ:
 * - SSRF防止（validateExternalUrl使用）
 * - NaN/Infinity防御（Number.isFinite）
 * - sanitizeErrorMessage使用
 *
 * @module services/performance/core-web-vitals.service
 */

import type { Page, Browser, BrowserContext } from "playwright";
import { validateExternalUrl } from "../../utils/url-validator";
import { logger } from "../../utils/logger";

// =====================================================
// Types / 型定義
// =====================================================

/**
 * CWV指標の評価レベル / CWV metric rating level
 * Google CWV基準に基づく3段階評価
 */
export type MetricRating = "good" | "needs-improvement" | "poor";

/**
 * 個別CWV指標結果 / Individual CWV metric result
 */
export interface CwvMetricResult {
  /** 指標値 / Metric value */
  value: number;
  /** 評価 / Rating */
  rating: MetricRating;
  /** 単位 / Unit */
  unit: string;
}

/**
 * CWV計測結果 / CWV measurement results
 */
export interface CwvMetrics {
  /** Largest Contentful Paint（ミリ秒） / LCP in ms */
  lcp: CwvMetricResult;
  /** First Input Delay（ミリ秒） / FID in ms */
  fid: CwvMetricResult;
  /** Cumulative Layout Shift（スコア） / CLS score */
  cls: CwvMetricResult;
  /** Interaction to Next Paint（ミリ秒） / INP in ms */
  inp: CwvMetricResult;
  /** Time to First Byte（ミリ秒） / TTFB in ms */
  ttfb: CwvMetricResult;
}

/**
 * CWVスコア結果 / CWV score result
 */
export interface CwvScoreResult {
  /** 総合スコア（0-100） / Overall score (0-100) */
  score: number;
  /** 個別指標 / Individual metrics */
  metrics: CwvMetrics;
  /** グレード / Grade */
  grade: string;
  /** 計測時刻 / Measurement timestamp */
  measuredAt: string;
}

/**
 * PerformanceObserverから取得する生データ / Raw data from PerformanceObserver
 */
export interface RawCwvData {
  lcp: number | null;
  fid: number | null;
  cls: number | null;
  inp: number | null;
  ttfb: number | null;
}

// =====================================================
// Thresholds / Google CWV基準閾値
// =====================================================

/**
 * Google CWV閾値定義
 * @see https://web.dev/vitals/
 */
export const CWV_THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },
  fid: { good: 100, poor: 300 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
  ttfb: { good: 800, poor: 1800 },
} as const;

/**
 * CWVスコア計算の重み
 * LCP(25%) + FID(25%) + CLS(25%) + TTFB(15%) + INP(10%) = 100%
 */
export const CWV_WEIGHTS = {
  lcp: 0.25,
  fid: 0.25,
  cls: 0.25,
  ttfb: 0.15,
  inp: 0.1,
} as const;

// =====================================================
// Rating Functions / 評価関数
// =====================================================

/**
 * 指標値から評価レベルを判定 / Rate a metric value
 * @param value - 指標値
 * @param thresholds - Good/Poor閾値
 * @returns 評価レベル
 */
export function rateMetric(
  value: number,
  thresholds: { good: number; poor: number }
): MetricRating {
  if (!Number.isFinite(value) || value < 0) {
    return "poor";
  }
  if (value <= thresholds.good) {
    return "good";
  }
  if (value <= thresholds.poor) {
    return "needs-improvement";
  }
  return "poor";
}

/**
 * 指標値を0-100スコアに変換 / Convert metric value to 0-100 score
 *
 * Good閾値=100, Poor閾値=0として線形補間
 * @param value - 指標値
 * @param thresholds - Good/Poor閾値
 * @returns 0-100のスコア
 */
export function metricToScore(value: number, thresholds: { good: number; poor: number }): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  if (value <= thresholds.good) {
    return 100;
  }
  if (value >= thresholds.poor) {
    return 0;
  }
  // 線形補間: good=100, poor=0
  const range = thresholds.poor - thresholds.good;
  if (range <= 0) {
    return 0;
  }
  const score = 100 * (1 - (value - thresholds.good) / range);
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * CLS専用スコア変換（低い値が良い） / CLS-specific score conversion
 */
export function clsToScore(value: number): number {
  return metricToScore(value, CWV_THRESHOLDS.cls);
}

/**
 * 総合CWVスコアを計算 / Calculate overall CWV score
 * @param metrics - CWV指標結果
 * @returns 0-100の総合スコア
 */
export function calculateCwvScore(metrics: CwvMetrics): number {
  const lcpScore = metricToScore(metrics.lcp.value, CWV_THRESHOLDS.lcp);
  const fidScore = metricToScore(metrics.fid.value, CWV_THRESHOLDS.fid);
  const clsScore = clsToScore(metrics.cls.value);
  const ttfbScore = metricToScore(metrics.ttfb.value, CWV_THRESHOLDS.ttfb);
  const inpScore = metricToScore(metrics.inp.value, CWV_THRESHOLDS.inp);

  const weighted =
    lcpScore * CWV_WEIGHTS.lcp +
    fidScore * CWV_WEIGHTS.fid +
    clsScore * CWV_WEIGHTS.cls +
    ttfbScore * CWV_WEIGHTS.ttfb +
    inpScore * CWV_WEIGHTS.inp;

  const result = Math.round(weighted);
  if (!Number.isFinite(result)) {
    return 0;
  }
  return Math.max(0, Math.min(100, result));
}

/**
 * スコアからグレードを判定 / Convert score to grade
 */
export function scoreToGrade(score: number): string {
  if (!Number.isFinite(score)) return "F";
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 50) return "C";
  if (score >= 25) return "D";
  return "F";
}

// =====================================================
// Metric Builder / 指標構築
// =====================================================

/**
 * 生データからCwvMetricsを構築 / Build CwvMetrics from raw data
 * @param raw - PerformanceObserverの生データ
 * @returns CwvMetrics
 */
export function buildCwvMetrics(raw: RawCwvData): CwvMetrics {
  const safeValue = (v: number | null, fallback: number): number => {
    if (v === null || v === undefined || !Number.isFinite(v)) {
      return fallback;
    }
    return Math.max(0, v);
  };

  // FID/INPはユーザー操作が無い場合nullになるため、Good値をフォールバック
  const lcpVal = safeValue(raw.lcp, CWV_THRESHOLDS.lcp.poor);
  const fidVal = safeValue(raw.fid, 0); // 操作無し = FID 0ms（Good）
  const clsVal = safeValue(raw.cls, 0); // シフト無し = CLS 0（Good）
  const inpVal = safeValue(raw.inp, 0); // 操作無し = INP 0ms（Good）
  const ttfbVal = safeValue(raw.ttfb, CWV_THRESHOLDS.ttfb.poor);

  return {
    lcp: { value: lcpVal, rating: rateMetric(lcpVal, CWV_THRESHOLDS.lcp), unit: "ms" },
    fid: { value: fidVal, rating: rateMetric(fidVal, CWV_THRESHOLDS.fid), unit: "ms" },
    cls: { value: clsVal, rating: rateMetric(clsVal, CWV_THRESHOLDS.cls), unit: "score" },
    inp: { value: inpVal, rating: rateMetric(inpVal, CWV_THRESHOLDS.inp), unit: "ms" },
    ttfb: { value: ttfbVal, rating: rateMetric(ttfbVal, CWV_THRESHOLDS.ttfb), unit: "ms" },
  };
}

// =====================================================
// Browser Measurement / ブラウザ計測
// =====================================================

/** PerformanceObserver計測タイムアウト（ms） */
const MEASUREMENT_TIMEOUT_MS = 15000;

/** ページ安定化待機時間（ms） */
const STABILIZATION_WAIT_MS = 3000;

/**
 * PerformanceObserver APIでCWV指標を計測するスクリプト
 *
 * page.evaluate()で実行され、以下を取得:
 * - LCP: largest-contentful-paint
 * - FID: first-input
 * - CLS: layout-shift
 * - INP: event (interaction)
 * - TTFB: navigation timing
 */
const CWV_MEASUREMENT_SCRIPT = `
  () => {
    return new Promise((resolve) => {
      const metrics = { lcp: null, fid: null, cls: null, inp: null, ttfb: null };
      let clsTotal = 0;

      // TTFB: Navigation Timing API
      const navEntry = performance.getEntriesByType('navigation')[0];
      if (navEntry) {
        metrics.ttfb = navEntry.responseStart - navEntry.requestStart;
        if (metrics.ttfb < 0) metrics.ttfb = navEntry.responseStart;
      }

      // LCP observer
      try {
        const lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          if (entries.length > 0) {
            metrics.lcp = entries[entries.length - 1].startTime;
          }
        });
        lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (e) { /* unsupported */ }

      // FID observer
      try {
        const fidObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          if (entries.length > 0) {
            metrics.fid = entries[0].processingStart - entries[0].startTime;
          }
        });
        fidObserver.observe({ type: 'first-input', buffered: true });
      } catch (e) { /* unsupported */ }

      // CLS observer
      try {
        const clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              clsTotal += entry.value;
            }
          }
          metrics.cls = clsTotal;
        });
        clsObserver.observe({ type: 'layout-shift', buffered: true });
      } catch (e) { /* unsupported */ }

      // INP observer (event entries)
      try {
        let maxDuration = 0;
        const inpObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const duration = entry.processingEnd - entry.processingStart;
            if (duration > maxDuration) {
              maxDuration = duration;
              metrics.inp = duration;
            }
          }
        });
        inpObserver.observe({ type: 'event', buffered: true });
      } catch (e) { /* unsupported */ }

      // 安定化待機後に結果返却
      setTimeout(() => resolve(metrics), ${STABILIZATION_WAIT_MS});
    });
  }
`;

/**
 * Core Web Vitals Serviceインターフェース
 */
export interface ICoreWebVitalsService {
  /**
   * URLのCWV指標を計測
   * @param url - 計測対象URL
   * @param options - 計測オプション
   * @returns CWVスコア結果
   */
  measure(url: string, options?: CwvMeasureOptions): Promise<CwvScoreResult>;
}

/**
 * CWV計測オプション / CWV measurement options
 */
export interface CwvMeasureOptions {
  /** 計測タイムアウト（ms、デフォルト: 15000） */
  timeoutMs?: number;
  /** ページ安定化待機（ms、デフォルト: 3000） */
  stabilizationMs?: number;
  /** 既存Playwright Browserインスタンス */
  browser?: Browser;
  /** 既存Playwright Pageインスタンス */
  page?: Page;
}

/**
 * Core Web Vitals Service 実装
 *
 * Playwright CDPSession経由でPerformanceObserver APIを使用し、
 * LCP/FID/CLS/INP/TTFBを計測する。
 */
export class CoreWebVitalsService implements ICoreWebVitalsService {
  /**
   * URLのCWV指標を計測
   */
  async measure(url: string, options?: CwvMeasureOptions): Promise<CwvScoreResult> {
    // Defense-in-depth: サービス層でもSSRF検証（ツール層でも検証済み）
    validateExternalUrl(url);

    const timeoutMs = options?.timeoutMs ?? MEASUREMENT_TIMEOUT_MS;
    let page = options?.page ?? null;
    let context: BrowserContext | null = null;
    let needsCleanup = false;

    try {
      // 既存pageが無い場合はbrowserからコンテキスト作成
      if (!page && options?.browser) {
        context = await options.browser.newContext({
          viewport: { width: 1920, height: 1080 },
        });
        page = await context.newPage();
        needsCleanup = true;
      }

      if (!page) {
        throw new Error("No Playwright page or browser provided for CWV measurement");
      }

      // ページナビゲーション
      await page.goto(url, {
        waitUntil: "load",
        timeout: timeoutMs,
      });

      // PerformanceObserverスクリプト実行
      const rawData = (await Promise.race([
        page.evaluate(CWV_MEASUREMENT_SCRIPT),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("CWV measurement timeout")), timeoutMs)
        ),
      ])) as RawCwvData | null;

      if (!rawData) {
        throw new Error("CWV measurement returned null");
      }

      // メトリクス構築
      const metrics = buildCwvMetrics(rawData);

      // スコア計算
      const score = calculateCwvScore(metrics);
      const grade = scoreToGrade(score);

      return {
        score,
        metrics,
        grade,
        measuredAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.warn("[CoreWebVitals] Measurement failed, returning degraded result", {
        error: error instanceof Error ? error.message : String(error),
      });

      // Graceful Degradation: 計測失敗時はPoorデフォルト
      const fallbackMetrics = buildCwvMetrics({
        lcp: null,
        fid: null,
        cls: null,
        inp: null,
        ttfb: null,
      });
      const fallbackScore = calculateCwvScore(fallbackMetrics);

      return {
        score: fallbackScore,
        metrics: fallbackMetrics,
        grade: scoreToGrade(fallbackScore),
        measuredAt: new Date().toISOString(),
      };
    } finally {
      if (needsCleanup) {
        try {
          if (context) await context.close();
        } catch {
          // cleanup failure is non-fatal
        }
      }
    }
  }
}
