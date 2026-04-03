// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze Phase 7.5 フェーズハンドラー (v0.3.0 Tier 2)
 *
 * Phase 7 (Responsive) 完了後に逐次実行される Post-Analysis Gate。
 * 全サブフェーズ opt-in（デフォルト無効）。
 *
 * - Phase 7.5a: Accessibility Audit (axe-core + コントラストチェック)
 * - Phase 7.5b: Performance Evaluation (Core Web Vitals via Playwright)
 * - Phase 7.5c: Auto Snapshot (Design Change Tracking)
 *
 * page.analyze Phase 7.5 handlers (v0.3.0 Tier 2)
 * Post-Analysis Gate executed sequentially after Phase 7 (Responsive).
 * All sub-phases are opt-in (disabled by default).
 *
 * @module tools/page/handlers/sync-phase-handlers-tier2
 */

import { logger, isDevelopment } from "../../../utils/logger";
import { sanitizeErrorMessage } from "../../../utils/sanitize-error";
import { validateExternalUrl } from "../../../utils/url-validator";

import { createDIFactory } from "../../../utils/di-factory";

import type { AccessibilityAuditService } from "../../../services/quality/accessibility-audit.service";
import { createAccessibilityAuditService } from "../../../services/quality/accessibility-audit.service";
import type { ContrastCheckService } from "../../../services/quality/contrast-check.service";
import { createContrastCheckService } from "../../../services/quality/contrast-check.service";
import {
  CoreWebVitalsService,
  type ICoreWebVitalsService,
  type CwvScoreResult,
} from "../../../services/performance/core-web-vitals.service";
import type {
  IPerformanceEvaluationService,
  PerformanceBudget,
} from "../../../services/performance/performance-evaluation.service";
import { DEFAULT_PERFORMANCE_BUDGET } from "../../../services/performance/performance-evaluation.service";
import {
  createSnapshot,
  type CreateSnapshotResult,
} from "../../../services/design-change-tracker.service";

import type { PageAnalyzeInput, AnalysisWarning } from "../schemas";
import type { PageAnalyzeData } from "../schemas";

// =====================================================
// 共通ヘルパー (TDA-RC2)
// =====================================================

/**
 * Phase タイムアウト付き Promise.race ヘルパー
 *
 * タイムアウト時は { skipped: true, reason } を返し、
 * メインの page.analyze 結果に影響しない（Graceful Degradation）。
 *
 * @param promise - 実行する Promise
 * @param timeoutMs - タイムアウト（ミリ秒）
 * @param phaseName - フェーズ名（ログ用）
 * @returns 結果またはスキップオブジェクト
 */
export async function withPhaseTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phaseName: string
): Promise<T | { skipped: true; reason: string }> {
  // NaN/Infinity 防御
  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<{ skipped: true; reason: string }>((resolve) => {
      timer = setTimeout(() => {
        logger.warn(`[page.analyze] Phase 7.5 ${phaseName} timed out`, {
          timeoutMs: safeTimeoutMs,
        });
        resolve({ skipped: true, reason: `${phaseName} timed out after ${safeTimeoutMs}ms` });
      }, safeTimeoutMs);
    }),
  ]);
}

/** Phase 7.5 結果がスキップされたかどうかを判定するtype guard */
function isSkipped(result: unknown): result is { skipped: true; reason: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "skipped" in result &&
    (result as { skipped: unknown }).skipped === true
  );
}

// =====================================================
// DI Factories for Phase 7.5 services
// =====================================================

const accessibilityAuditServiceDI = createDIFactory<AccessibilityAuditService>(
  "Phase75AccessibilityAuditService"
);
export const setPhase75AccessibilityAuditServiceFactory = accessibilityAuditServiceDI.set;
export const resetPhase75AccessibilityAuditServiceFactory = accessibilityAuditServiceDI.reset;

const contrastCheckServiceDI = createDIFactory<ContrastCheckService>("Phase75ContrastCheckService");
export const setPhase75ContrastCheckServiceFactory = contrastCheckServiceDI.set;
export const resetPhase75ContrastCheckServiceFactory = contrastCheckServiceDI.reset;

const cwvServiceDI = createDIFactory<ICoreWebVitalsService>("Phase75CoreWebVitalsService");
export const setPhase75CoreWebVitalsServiceFactory = cwvServiceDI.set;
export const resetPhase75CoreWebVitalsServiceFactory = cwvServiceDI.reset;

const perfEvalServiceDI = createDIFactory<IPerformanceEvaluationService>(
  "Phase75PerformanceEvaluationService"
);
export const setPhase75PerformanceEvaluationServiceFactory = perfEvalServiceDI.set;
export const resetPhase75PerformanceEvaluationServiceFactory = perfEvalServiceDI.reset;

// =====================================================
// Phase 7.5a: Accessibility Audit
// =====================================================

export interface AccessibilityPhaseParams {
  accessibilityOptions: PageAnalyzeInput["accessibilityOptions"];
  sanitizedHtml: string;
  warnings: AnalysisWarning[];
}

export type AccessibilityPhaseResult = NonNullable<PageAnalyzeData["accessibility"]> | undefined;

/**
 * Phase 7.5a: アクセシビリティ監査フェーズ
 *
 * accessibilityOptions.enabled=true の場合に axe-core WCAG 監査を実行。
 * withPhaseTimeout() で10秒タイムアウト。
 *
 * Phase 7.5a: Accessibility audit phase
 * Runs axe-core WCAG audit when accessibilityOptions.enabled=true.
 * 10-second timeout via withPhaseTimeout().
 */
export async function handleAccessibilityPhase(
  params: AccessibilityPhaseParams
): Promise<AccessibilityPhaseResult> {
  const { accessibilityOptions, sanitizedHtml, warnings } = params;

  if (!accessibilityOptions?.enabled) {
    return undefined;
  }

  const ACCESSIBILITY_TIMEOUT_MS = 10000;

  const result = await withPhaseTimeout(
    executeAccessibilityAudit(accessibilityOptions, sanitizedHtml, warnings),
    ACCESSIBILITY_TIMEOUT_MS,
    "accessibility"
  );

  if (isSkipped(result)) {
    warnings.push({
      feature: "layout",
      code: "ACCESSIBILITY_TIMEOUT",
      message: result.reason,
    });
    return undefined;
  }

  return result;
}

async function executeAccessibilityAudit(
  options: NonNullable<PageAnalyzeInput["accessibilityOptions"]>,
  sanitizedHtml: string,
  warnings: AnalysisWarning[]
): Promise<AccessibilityPhaseResult> {
  const auditStartTime = Date.now();

  try {
    const auditFactory = accessibilityAuditServiceDI.get();
    const auditService = auditFactory ? auditFactory() : createAccessibilityAuditService();
    const auditResult = await auditService.audit(sanitizedHtml, {
      includePasses: false,
    });

    // コントラストチェック（オプション）
    if (options.include_contrast !== false) {
      try {
        const contrastFactory = contrastCheckServiceDI.get();
        const contrastService = contrastFactory ? contrastFactory() : createContrastCheckService();
        const contrastResult = await contrastService.checkHtmlContrast(sanitizedHtml);
        if (isDevelopment() && contrastResult) {
          logger.info("[page.analyze] Phase 7.5a: contrast check completed", {
            issues: contrastResult.issues?.length ?? 0,
          });
        }
      } catch (contrastError) {
        logger.warn("[page.analyze] Phase 7.5a: contrast check failed (graceful degradation)", {
          error: contrastError instanceof Error ? contrastError.message : "Unknown error",
        });
      }
    }

    const analysisTimeMs = Date.now() - auditStartTime;

    if (isDevelopment()) {
      logger.info("[page.analyze] Phase 7.5a: Accessibility audit completed", {
        score: auditResult.score,
        level: auditResult.level,
        violationCount: auditResult.violations.length,
        analysisTimeMs,
      });
    }

    return {
      score: auditResult.score,
      level: auditResult.level as "A" | "AA" | "AAA",
      violationCount: auditResult.violations.length,
      analysisTimeMs,
    };
  } catch (error) {
    logger.warn("[page.analyze] Phase 7.5a: Accessibility audit failed (graceful degradation)", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    warnings.push({
      feature: "layout",
      code: "ACCESSIBILITY_ERROR",
      message: `Accessibility audit failed: ${sanitizeErrorMessage(error)}`,
    });
    return undefined;
  }
}

// =====================================================
// Phase 7.5b: Performance Evaluation
// =====================================================

export interface PerformancePhaseParams {
  performanceOptions: PageAnalyzeInput["performanceOptions"];
  url: string;
  warnings: AnalysisWarning[];
}

export type PerformancePhaseResult = NonNullable<PageAnalyzeData["performance"]> | undefined;

/**
 * Phase 7.5b: パフォーマンス評価フェーズ
 *
 * performanceOptions.enabled=true の場合に Core Web Vitals を計測。
 * Playwright 起動失敗時は { skipped: true, reason } を返す（TPA-C1）。
 * withPhaseTimeout() で40秒タイムアウト。
 *
 * Phase 7.5b: Performance evaluation phase
 * Measures Core Web Vitals when performanceOptions.enabled=true.
 * Returns { skipped: true, reason } on Playwright launch failure (TPA-C1).
 * 40-second timeout via withPhaseTimeout().
 */
export async function handlePerformancePhase(
  params: PerformancePhaseParams
): Promise<PerformancePhaseResult> {
  const { performanceOptions, url, warnings } = params;

  if (!performanceOptions?.enabled) {
    return undefined;
  }

  const PERFORMANCE_TIMEOUT_MS = 40000;

  const result = await withPhaseTimeout(
    executePerformanceEvaluation(performanceOptions, url, warnings),
    PERFORMANCE_TIMEOUT_MS,
    "performance"
  );

  if (isSkipped(result)) {
    warnings.push({
      feature: "layout",
      code: "PERFORMANCE_TIMEOUT",
      message: result.reason,
    });
    return { skipped: true, reason: result.reason };
  }

  return result;
}

async function executePerformanceEvaluation(
  options: NonNullable<PageAnalyzeInput["performanceOptions"]>,
  url: string,
  warnings: AnalysisWarning[]
): Promise<PerformancePhaseResult> {
  const perfStartTime = Date.now();

  // SSRF 検証
  const urlValidation = validateExternalUrl(url);
  if (!urlValidation.valid) {
    warnings.push({
      feature: "layout",
      code: "PERFORMANCE_SSRF_BLOCKED",
      message: `Performance evaluation skipped: ${urlValidation.error}`,
    });
    return { skipped: true, reason: `SSRF blocked: ${urlValidation.error}` };
  }

  try {
    const cwvFactory = cwvServiceDI.get();
    const cwvService: ICoreWebVitalsService = cwvFactory
      ? cwvFactory()
      : new CoreWebVitalsService();

    // TPA-C1: Playwright 起動失敗時の Graceful Degradation
    let cwvResult: CwvScoreResult;
    try {
      cwvResult = await cwvService.measure(url);
    } catch (playwrightError) {
      const reason = `Playwright launch failed: ${sanitizeErrorMessage(playwrightError)}`;
      logger.warn("[page.analyze] Phase 7.5b: Playwright launch failed (TPA-C1)", {
        url: url.slice(0, 100),
        error: reason,
      });
      return { skipped: true, reason };
    }

    const perfEvalFactory = perfEvalServiceDI.get();
    if (!perfEvalFactory) {
      // CWV計測成功 but 評価サービスなし → 生メトリクスのみ返す
      const analysisTimeMs = Date.now() - perfStartTime;
      return {
        score: cwvResult.score,
        grade: cwvResult.grade,
        metrics: {
          lcp: cwvResult.metrics.lcp.value,
          fid: cwvResult.metrics.fid.value,
          cls: cwvResult.metrics.cls.value,
          inp: cwvResult.metrics.inp.value,
          ttfb: cwvResult.metrics.ttfb.value,
        },
        analysisTimeMs,
      };
    }

    const perfEvalService = perfEvalFactory();
    const budget: PerformanceBudget | undefined = options.budget
      ? buildBudgetFromRecord(options.budget)
      : undefined;
    const evaluation = perfEvalService.evaluate(cwvResult, budget);

    const analysisTimeMs = Date.now() - perfStartTime;

    if (isDevelopment()) {
      logger.info("[page.analyze] Phase 7.5b: Performance evaluation completed", {
        score: evaluation.score,
        grade: evaluation.grade,
        analysisTimeMs,
      });
    }

    return {
      score: evaluation.score,
      grade: evaluation.grade,
      metrics: {
        lcp: evaluation.metrics.lcp.value,
        fid: evaluation.metrics.fid.value,
        cls: evaluation.metrics.cls.value,
        inp: evaluation.metrics.inp.value,
        ttfb: evaluation.metrics.ttfb.value,
      },
      analysisTimeMs,
    };
  } catch (error) {
    logger.warn("[page.analyze] Phase 7.5b: Performance evaluation failed (graceful degradation)", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    warnings.push({
      feature: "layout",
      code: "PERFORMANCE_ERROR",
      message: `Performance evaluation failed: ${sanitizeErrorMessage(error)}`,
    });
    return {
      skipped: true,
      reason: `Performance evaluation failed: ${sanitizeErrorMessage(error)}`,
    };
  }
}

/**
 * Record<string, number> 形式の budget から PerformanceBudget を構築
 */
function buildBudgetFromRecord(input: Record<string, number>): PerformanceBudget {
  return {
    lcpMs: Number.isFinite(input["lcp_ms"]) ? input["lcp_ms"]! : DEFAULT_PERFORMANCE_BUDGET.lcpMs,
    cls: Number.isFinite(input["cls"]) ? input["cls"]! : DEFAULT_PERFORMANCE_BUDGET.cls,
    fidMs: Number.isFinite(input["fid_ms"]) ? input["fid_ms"]! : DEFAULT_PERFORMANCE_BUDGET.fidMs,
    ttfbMs: Number.isFinite(input["ttfb_ms"])
      ? input["ttfb_ms"]!
      : DEFAULT_PERFORMANCE_BUDGET.ttfbMs,
    inpMs: Number.isFinite(input["inp_ms"]) ? input["inp_ms"]! : DEFAULT_PERFORMANCE_BUDGET.inpMs,
  };
}

// =====================================================
// Phase 7.5c: Auto Snapshot
// =====================================================

export interface SnapshotPhaseParams {
  autoSnapshot: boolean;
  savedWebPageId: string | undefined;
  warnings: AnalysisWarning[];
}

export type SnapshotPhaseResult = NonNullable<PageAnalyzeData["snapshot"]> | undefined;

/**
 * Phase 7.5c: デザインスナップショット自動生成フェーズ
 *
 * auto_snapshot=true の場合にスナップショットを作成。
 * savedWebPageId が undefined の場合は TPA-A1 に準拠したスキップレスポンスを返す。
 * withPhaseTimeout() で5秒タイムアウト。
 *
 * Phase 7.5c: Auto design snapshot phase
 * Creates snapshot when auto_snapshot=true.
 * Returns TPA-A1 compliant skip response when savedWebPageId is undefined.
 * 5-second timeout via withPhaseTimeout().
 */
export async function handleSnapshotPhase(
  params: SnapshotPhaseParams
): Promise<SnapshotPhaseResult> {
  const { autoSnapshot, savedWebPageId, warnings } = params;

  if (!autoSnapshot) {
    return undefined;
  }

  // TPA-A1: DB save が無効またはDB保存に失敗した場合
  if (!savedWebPageId) {
    return { skipped: true, reason: "DB save was disabled or failed" };
  }

  const SNAPSHOT_TIMEOUT_MS = 5000;

  const result = await withPhaseTimeout(
    executeSnapshot(savedWebPageId, warnings),
    SNAPSHOT_TIMEOUT_MS,
    "auto_snapshot"
  );

  if (isSkipped(result)) {
    warnings.push({
      feature: "layout",
      code: "SNAPSHOT_TIMEOUT",
      message: result.reason,
    });
    return { skipped: true, reason: result.reason };
  }

  return result;
}

async function executeSnapshot(
  savedWebPageId: string,
  warnings: AnalysisWarning[]
): Promise<SnapshotPhaseResult> {
  try {
    const snapshotResult: CreateSnapshotResult = await createSnapshot(savedWebPageId);

    if (!snapshotResult.success || !snapshotResult.snapshot_id) {
      const reason = snapshotResult.error ?? "Snapshot creation failed";
      logger.warn("[page.analyze] Phase 7.5c: Snapshot creation failed", {
        webPageId: savedWebPageId.slice(0, 8) + "...",
        error: reason,
      });
      return { skipped: true, reason };
    }

    if (isDevelopment()) {
      logger.info("[page.analyze] Phase 7.5c: Snapshot created", {
        snapshotId: snapshotResult.snapshot_id.slice(0, 8) + "...",
        sectionCount: snapshotResult.section_count,
      });
    }

    return {
      snapshotId: snapshotResult.snapshot_id,
      createdAt: snapshotResult.snapshot_at ?? new Date().toISOString(),
    };
  } catch (error) {
    logger.warn("[page.analyze] Phase 7.5c: Snapshot failed (graceful degradation)", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    warnings.push({
      feature: "layout",
      code: "SNAPSHOT_ERROR",
      message: `Auto snapshot failed: ${sanitizeErrorMessage(error)}`,
    });
    return { skipped: true, reason: `Snapshot failed: ${sanitizeErrorMessage(error)}` };
  }
}
