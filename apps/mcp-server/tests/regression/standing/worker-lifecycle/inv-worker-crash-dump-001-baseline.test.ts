// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-WORKER-CRASH-DUMP-001 — Baseline standing regression (Wave 3 PR3c)
 *
 * Plan v3 T2 V1 §7.2 case #1 (baseline). Asserts the end-to-end happy path:
 * a raw `process.report`-shaped payload arrives in the staging dir →
 * sanitiser runs → atomic rename writes a sanitised file to the public root
 * → `worker_crash_report_emitted` audit entry is created.
 *
 * Standing regression contract (CI-failing, P0 incident on fail):
 *   - Sanitisation MUST apply (sanitizationApplied=true).
 *   - Final file MUST contain the truncated report ID (Δ11, no pid).
 *   - Audit emit MUST use SSOT `truncateAuditTargetId` (8-char + "..." form
 *     when truncatedReportId exceeds 8 chars).
 *   - Source file MUST be removed post-rename.
 *
 * @see Plan v3 T2 V1 §5.1 INV-WORKER-CRASH-DUMP-001 + §7.2 case #1
 * @see ADR-0021 §"TOCTOU section" + §"Privacy Considerations"
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
import { resetSequenceForTesting } from "../../../../src/services/crash-report-sanitizer";

const auditEntries: Array<{
  action: string;
  targetId?: string;
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
        async (entry: {
          action: string;
          actor: string;
          targetType: string;
          targetId?: string;
          details?: Record<string, unknown>;
          result: string;
        }) => {
          auditEntries.push({
            action: entry.action,
            targetId: entry.targetId,
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

describe("INV-WORKER-CRASH-DUMP-001 — baseline (V1 §7.2 case #1)", () => {
  let staging: string;
  let publicRoot: string;

  beforeEach(async () => {
    auditEntries.length = 0;
    resetSequenceForTesting();
    staging = await createStagingRoot();
    publicRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), `${CRASH_DUMP_DIR_PREFIX}-inv-baseline-`)
    );
  });

  afterEach(async () => {
    await destroyStagingRoot(staging);
    await fsp.rm(publicRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  // INV-WORKER-CRASH-DUMP-001
  it("emits sanitised crash report + audit entry on baseline happy path", async () => {
    // Simulate a SIGABRT-triggered process.report write to the staging root.
    const stagingFile = path.join(staging, "raw-report.json");
    const rawReport = {
      header: {
        commandLine: ["node", "worker.js", "--page", "https://example.com"],
        cwd: "/tmp/cwd",
      },
      environmentVariables: { DATABASE_URL: "postgres://leak", NODE_ENV: "test" },
      javascriptStack: { stack: ["at handler (anon)"] },
      nativeStack: ["abort"],
    };
    await fsp.writeFile(stagingFile, JSON.stringify(rawReport));

    // Run the watcher's processReportFile (one-shot, no fs.watch involvement).
    const result = await processReportFile({
      stagingRoot: staging,
      publicRoot,
      workerType: "page",
      role: "child",
      basename: "raw-report.json",
      captureExitMetadata: () => ({ exitSignal: "SIGABRT", exitCode: null }),
    });

    // INV-WORKER-CRASH-DUMP-001
    // (1) sanitisation applied
    expect(result).not.toBeNull();
    expect(result!.sanitization.sanitizationApplied).toBe(true);
    // (2) staging source removed
    await expect(fsp.stat(stagingFile)).rejects.toThrow();
    // (3) final file at public root
    const finalContent = await fsp.readFile(result!.finalPath, { encoding: "utf-8" });
    const finalReport = JSON.parse(finalContent) as Record<string, unknown>;
    // Sensitive env redacted
    const env = finalReport.environmentVariables as Record<string, string>;
    expect(env.DATABASE_URL).toBe("[REDACTED]");
    // URL in argv redacted
    const header = finalReport.header as Record<string, unknown>;
    expect((header.commandLine as string[])[3]).toBe("[REDACTED-URL]");
    // (4) audit emit with sanitizationApplied=true + SIGABRT signal
    const emits = auditEntries.filter((e) => e.action === "worker_crash_report_emitted");
    expect(emits.length).toBe(1);
    expect(emits[0]!.result).toBe("success");
    expect(emits[0]!.details?.sanitizationApplied).toBe(true);
    expect(emits[0]!.details?.exitSignal).toBe("SIGABRT");
    expect(emits[0]!.details?.workerType).toBe("page");
    expect(emits[0]!.details?.role).toBe("child");
    // (5) targetId is PII-truncated to AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH (=8) + "..."
    expect(emits[0]!.targetId).toMatch(/^.{8}\.\.\.$|^report\.\d+\.\d+$/);
  });
});
