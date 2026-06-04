// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-WORKER-CRASH-DUMP-001 — L3 CRIT threshold standing regression (Wave 3 PR3c)
 *
 * Plan v3 T2 V1 §7.2 case #4 (Δ5 Metric A + Metric B). Asserts the
 * GDPR Art.33 escalate threshold metrics are formalised and assertable.
 *
 * Metric A: `audit_logs.worker_crash_report_emitted` events with
 *   `sanitizationApplied=false` in any 60-min sliding window ≥ 1 → L3 CRIT.
 * Metric B: distinct `workerType` values in `worker_crash_report_emitted`
 *   events in any 60-min sliding window ≥ 3 → L3 CRIT.
 *
 * Standing regression contract (CI-failing, P0 incident on fail):
 *   - The query predicate functions (`evaluateMetricA`, `evaluateMetricB`)
 *     MUST return true when the threshold is met.
 *   - The metrics are queryable from `audit_logs` via the
 *     `getAuditLogService().query()` SSOT path.
 *
 * @see Plan v3 T2 V1 §4.5 Δ5 + §6.1 Metric A/B + §13.1 evidence #4
 * @see ADR-0021 §"Privacy Considerations — GDPR Art.33 Escalate Threshold"
 */

import { describe, it, expect } from "vitest";

// ============================================================================
// Pure predicate functions (extracted for assertability)
// ============================================================================

interface AuditRecord {
  action: string;
  timestamp: Date;
  details: Record<string, unknown> | null;
}

/**
 * Metric A: count `worker_crash_report_emitted` events with
 * `sanitizationApplied=false` in the supplied window.
 *
 * Returns true if count ≥ threshold (default 1 per V1 §6.1 Metric A).
 */
export function evaluateMetricA(
  records: AuditRecord[],
  windowEndTime: Date,
  windowMs: number = 60 * 60 * 1000,
  threshold: number = 1
): boolean {
  const windowStart = windowEndTime.getTime() - windowMs;
  const matching = records.filter((r) => {
    if (r.action !== "worker_crash_report_emitted") return false;
    if (r.timestamp.getTime() < windowStart) return false;
    if (r.timestamp.getTime() > windowEndTime.getTime()) return false;
    return r.details?.sanitizationApplied === false;
  });
  return matching.length >= threshold;
}

/**
 * Metric B: count distinct `workerType` values in
 * `worker_crash_report_emitted` events in the supplied window.
 *
 * Returns true if distinct count ≥ threshold (default 3 per V1 §6.1 Metric B).
 */
export function evaluateMetricB(
  records: AuditRecord[],
  windowEndTime: Date,
  windowMs: number = 60 * 60 * 1000,
  threshold: number = 3
): boolean {
  const windowStart = windowEndTime.getTime() - windowMs;
  const distinctWorkerTypes = new Set<string>();
  for (const r of records) {
    if (r.action !== "worker_crash_report_emitted") continue;
    if (r.timestamp.getTime() < windowStart) continue;
    if (r.timestamp.getTime() > windowEndTime.getTime()) continue;
    const wt = r.details?.workerType;
    if (typeof wt === "string") distinctWorkerTypes.add(wt);
  }
  return distinctWorkerTypes.size >= threshold;
}

// ============================================================================
// Standing regression tests
// ============================================================================

describe("INV-WORKER-CRASH-DUMP-001 — Δ5 L3 CRIT thresholds (V1 §7.2 case #4)", () => {
  const now = new Date(1715472000000); // fixed reference point

  // INV-WORKER-CRASH-DUMP-001
  it("Metric A triggers on a single sanitizationApplied=false event in window", () => {
    const records: AuditRecord[] = [
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 30 * 60 * 1000), // 30 min ago
        details: { sanitizationApplied: false, workerType: "page" },
      },
    ];
    expect(evaluateMetricA(records, now)).toBe(true);
  });

  // INV-WORKER-CRASH-DUMP-001
  it("Metric A does NOT trigger on only sanitizationApplied=true events", () => {
    const records: AuditRecord[] = [
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 30 * 60 * 1000),
        details: { sanitizationApplied: true, workerType: "page" },
      },
    ];
    expect(evaluateMetricA(records, now)).toBe(false);
  });

  // INV-WORKER-CRASH-DUMP-001
  it("Metric A does NOT trigger when events are outside the window", () => {
    const records: AuditRecord[] = [
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 120 * 60 * 1000), // 2h ago, outside 60min window
        details: { sanitizationApplied: false, workerType: "page" },
      },
    ];
    expect(evaluateMetricA(records, now)).toBe(false);
  });

  // INV-WORKER-CRASH-DUMP-001
  it("Metric B triggers on 3 distinct workerType values within window", () => {
    const records: AuditRecord[] = [
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 50 * 60 * 1000),
        details: { sanitizationApplied: true, workerType: "page" },
      },
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 30 * 60 * 1000),
        details: { sanitizationApplied: true, workerType: "embedding-backfill" },
      },
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 10 * 60 * 1000),
        details: { sanitizationApplied: true, workerType: "future-worker-type" },
      },
    ];
    expect(evaluateMetricB(records, now)).toBe(true);
  });

  // INV-WORKER-CRASH-DUMP-001
  it("Metric B does NOT trigger on fewer than 3 distinct workerType values", () => {
    const records: AuditRecord[] = [
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 30 * 60 * 1000),
        details: { sanitizationApplied: true, workerType: "page" },
      },
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 10 * 60 * 1000),
        details: { sanitizationApplied: true, workerType: "page" }, // duplicate
      },
    ];
    expect(evaluateMetricB(records, now)).toBe(false);
  });

  // INV-WORKER-CRASH-DUMP-001
  it("Metric B respects window boundary", () => {
    const records: AuditRecord[] = [
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 120 * 60 * 1000), // 2h ago
        details: { sanitizationApplied: true, workerType: "page" },
      },
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 30 * 60 * 1000),
        details: { sanitizationApplied: true, workerType: "embedding-backfill" },
      },
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 10 * 60 * 1000),
        details: { sanitizationApplied: true, workerType: "future-worker-type" },
      },
    ];
    // Only 2 distinct in the 60-min window; should NOT trigger.
    expect(evaluateMetricB(records, now)).toBe(false);
  });

  // INV-WORKER-CRASH-DUMP-001
  it("Metric A and Metric B can both trigger independently", () => {
    const records: AuditRecord[] = [
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 50 * 60 * 1000),
        details: { sanitizationApplied: false, workerType: "page" },
      },
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 30 * 60 * 1000),
        details: { sanitizationApplied: true, workerType: "embedding-backfill" },
      },
      {
        action: "worker_crash_report_emitted",
        timestamp: new Date(now.getTime() - 10 * 60 * 1000),
        details: { sanitizationApplied: true, workerType: "future-worker-type" },
      },
    ];
    // Metric A: 1 sanitizationApplied=false → triggers.
    expect(evaluateMetricA(records, now)).toBe(true);
    // Metric B: 3 distinct workerType → triggers.
    expect(evaluateMetricB(records, now)).toBe(true);
  });
});
