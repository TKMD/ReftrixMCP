// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-WORKER-CRASH-DUMP-001 — PII leak fail-closed standing regression (Wave 3 PR3c)
 *
 * Plan v3 T2 V1 §7.2 case #3 (Δ2 #6 fail-open path). Asserts that when the
 * sanitiser throws (poisoned input), the audit emit carries
 * `sanitizationApplied=false` and the SLO_MARKER is logged. This is the
 * GDPR Art.33 escalate gate trigger condition.
 *
 * Standing regression contract (CI-failing, P0 incident on fail):
 *   - SLO_MARKER log line MUST fire.
 *   - Audit emit MUST set details.sanitizationApplied=false.
 *   - Audit emit result MUST be "denied" (not "success").
 *
 * @see Plan v3 T2 V1 §4.3 Δ2 #6 + §4.5 Δ5 + §13.1 evidence #3
 * @see ADR-0021 §"Privacy Considerations — GDPR Art.33 Escalate Threshold"
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createStagingRoot,
  destroyStagingRoot,
  CRASH_DUMP_DIR_PREFIX,
} from "../../../../src/services/crash-dump-persistence.service";
import { processReportFile } from "../../../../src/services/crash-report-watcher";
import {
  resetSequenceForTesting,
  SLO_MARKER_SANITIZE_FAILED,
} from "../../../../src/services/crash-report-sanitizer";
import { logger } from "../../../../src/utils/logger";

const auditEntries: Array<{
  action: string;
  details: Record<string, unknown> | undefined;
  result: string;
}> = [];

vi.mock("../../../../src/services/audit-log.service", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("../../../../src/services/audit-log.service");
  return {
    ...actual,
    getAuditLogService: () => ({
      log: vi.fn(
        async (entry: { action: string; details?: Record<string, unknown>; result: string }) => {
          auditEntries.push({
            action: entry.action,
            details: entry.details,
            result: entry.result,
          });
        }
      ),
      query: vi.fn(async () => []),
      getRetentionPolicy: vi.fn(() => ({ retentionDays: 365, description: "" })),
    }),
  };
});

describe("INV-WORKER-CRASH-DUMP-001 — Δ2 #6 PII leak fail-closed (V1 §7.2 case #3)", () => {
  let staging: string;
  let publicRoot: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    auditEntries.length = 0;
    resetSequenceForTesting();
    staging = await createStagingRoot();
    publicRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `${CRASH_DUMP_DIR_PREFIX}-fail-closed-`));
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await destroyStagingRoot(staging);
    await fsp.rm(publicRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  // INV-WORKER-CRASH-DUMP-001
  it("audit emit carries sanitizationApplied=false when sanitiser throws", async () => {
    // Construct a poisoned payload via direct file write (bypassing JSON.stringify).
    // We craft a serialised report that the sanitiser cannot clone (a Symbol
    // keyed property cannot survive JSON.parse, so we use a different vector:
    // override JSON.stringify via the SanitizerThrow trick. Simpler: write a
    // huge nested object that exceeds JSON.parse recursion would still
    // succeed; instead we inject a non-serialisable sentinel via the
    // sanitiser API directly).
    //
    // Easier path: simulate by writing a circular-shaped report. We cannot
    // write a circular JSON to file (JSON.stringify on the test side would
    // also fail), so instead write a VALID JSON with extreme nesting that
    // triggers the sanitiser recursion guard.
    //
    // The cleanest deterministic trigger: write a report with a circular
    // reference reconstructed via JSON.parse reviver. We use a depth-bomb
    // approach: 200 nested layers, which JSON.parse handles but our heap
    // walker bounds at 64 depth and returns object unchanged at that depth.
    // The sanitiser fail-open is triggered by JSON.stringify throwing on
    // a circular object — for that we use `processReportFile` directly
    // with a Buffer that round-trips through the sanitiser.
    //
    // For the standing regression contract we instead force the throw via
    // monkey-patching the sanitizer's internal JSON.parse. The implementation
    // catches any exception in sanitizeReport() and falls open. To trigger
    // this contractually we POISON JSON.stringify globally for the test.
    //
    // CLEANEST APPROACH: write a string containing replacement-character
    // bytes that make JSON.parse fail after readFile, which forces the
    // watcher's outer catch to substitute `{error: "truncated_or_unreadable"}`.
    // That payload still sanitises cleanly (no PII) and emits with
    // sanitizationApplied=true. NOT what we want here.
    //
    // FINAL APPROACH: directly poison JSON.stringify for the duration of
    // this test. This forces the sanitiser's clone step to throw, exercising
    // the fail-open branch.
    const originalStringify = JSON.stringify;
    let stringifyCallCount = 0;
    (JSON as { stringify: typeof JSON.stringify }).stringify = ((...args: unknown[]): string => {
      stringifyCallCount++;
      // Throw on the FIRST stringify call (which is the sanitiser's clone op).
      // Subsequent calls (writeFile JSON, audit emit) succeed.
      if (stringifyCallCount === 1) {
        throw new Error("Forced sanitiser failure for fail-closed regression test");
      }
      return originalStringify.apply(JSON, args as Parameters<typeof JSON.stringify>);
    }) as typeof JSON.stringify;
    try {
      const stagingFile = path.join(staging, "poisoned.json");
      // Pre-serialise the report using the ORIGINAL stringify so we have a
      // valid file on disk that the sanitiser will fail to clone.
      const rawReport = {
        environmentVariables: { DATABASE_URL: "postgres://secret" },
      };
      await fsp.writeFile(stagingFile, originalStringify(rawReport));

      const result = await processReportFile({
        stagingRoot: staging,
        publicRoot,
        workerType: "page",
        role: "child",
        basename: "poisoned.json",
      });

      // The sanitiser threw → fail-open path:
      expect(result).not.toBeNull();
      expect(result!.sanitization.sanitizationApplied).toBe(false);

      // SLO_MARKER must have been logged.
      const sloCalls = warnSpy.mock.calls.filter((c) => c[0] === SLO_MARKER_SANITIZE_FAILED);
      expect(sloCalls.length).toBeGreaterThanOrEqual(1);

      // Audit emit MUST carry sanitizationApplied=false + result=denied.
      const emits = auditEntries.filter((e) => e.action === "worker_crash_report_emitted");
      expect(emits.length).toBe(1);
      expect(emits[0]!.details?.sanitizationApplied).toBe(false);
      expect(emits[0]!.result).toBe("denied");
    } finally {
      (JSON as { stringify: typeof JSON.stringify }).stringify = originalStringify;
    }
  });
});
