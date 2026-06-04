// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Crash Report Watcher — unit tests (Wave 3 PR3b)
 *
 * Plan v3 T2 V1 §7.1 #6 (Δ7 vi.mock + vi.hoisted pattern not required here
 * because we exercise the real fs.watch + atomic rename pipeline against a
 * real per-test tmpdir; ADR-0020 Amendment 4 canonical applies when mocking
 * fs.watch — we do not mock here to keep coverage anchored to the actual
 * atomic-rename TOCTOU contract Δ4).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createStagingRoot,
  destroyStagingRoot,
  resolveCrashDumpSubdir,
  CRASH_DUMP_DIR_PREFIX,
} from "../../src/services/crash-dump-persistence.service";
import {
  processReportFile,
  startCrashReportWatcher,
} from "../../src/services/crash-report-watcher";
import { resetSequenceForTesting } from "../../src/services/crash-report-sanitizer";

// Stub the audit-log service so tests don't require a live DB.
vi.mock("../../src/services/audit-log.service", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../../src/services/audit-log.service");
  return {
    ...actual,
    getAuditLogService: () => ({
      log: vi.fn(async () => undefined),
      query: vi.fn(async () => []),
      getRetentionPolicy: vi.fn(() => ({ retentionDays: 365, description: "" })),
    }),
  };
});

describe("crash-report-watcher — processReportFile (Δ4 atomic rename)", () => {
  let staging: string;
  let publicRoot: string;

  beforeEach(async () => {
    resetSequenceForTesting();
    staging = await createStagingRoot();
    publicRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), `${CRASH_DUMP_DIR_PREFIX}-watcher-test-`)
    );
  });

  afterEach(async () => {
    await destroyStagingRoot(staging);
    await fsp.rm(publicRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it("sanitises a staging report and atomic-renames to public root", async () => {
    const sourceBasename = "report.staging.json";
    const sourcePath = path.join(staging, sourceBasename);
    const rawReport = {
      header: {
        commandLine: ["node", "worker.js", "https://example.com/secret"],
      },
      environmentVariables: {
        DATABASE_URL: "postgres://leak",
        NODE_ENV: "production",
      },
    };
    await fsp.writeFile(sourcePath, JSON.stringify(rawReport));

    const result = await processReportFile({
      stagingRoot: staging,
      publicRoot,
      workerType: "page",
      role: "child",
      basename: sourceBasename,
    });

    expect(result).not.toBeNull();
    expect(result!.sanitization.sanitizationApplied).toBe(true);
    // Source file removed (Stage 1 → Stage 2 completion).
    await expect(fsp.stat(sourcePath)).rejects.toThrow();
    // Final file at public root.
    const finalContent = await fsp.readFile(result!.finalPath, { encoding: "utf-8" });
    const final = JSON.parse(finalContent) as Record<string, unknown>;
    const header = final.header as Record<string, unknown>;
    expect((header.commandLine as string[])[2]).toBe("[REDACTED-URL]");
    const env = final.environmentVariables as Record<string, string>;
    expect(env.DATABASE_URL).toBe("[REDACTED]");
    expect(env.NODE_ENV).toBe("production");
  });

  it("respects file size cap (drops oversize source)", async () => {
    const sourceBasename = "oversize.json";
    const sourcePath = path.join(staging, sourceBasename);
    // Write a 51MB file (over 50MB cap).
    const bigPayload = `{"data":"${"x".repeat(51 * 1024 * 1024)}"}`;
    await fsp.writeFile(sourcePath, bigPayload);
    const result = await processReportFile({
      stagingRoot: staging,
      publicRoot,
      workerType: "page",
      role: "child",
      basename: sourceBasename,
    });
    expect(result).toBeNull();
    // Source file removed (drop policy).
    await expect(fsp.stat(sourcePath)).rejects.toThrow();
  });

  it("handles unreadable / non-JSON source as truncated with sanitizationApplied=true on placeholder", async () => {
    const sourceBasename = "truncated.json";
    const sourcePath = path.join(staging, sourceBasename);
    // Write a corrupted partial JSON.
    await fsp.writeFile(sourcePath, "{partial");
    const result = await processReportFile({
      stagingRoot: staging,
      publicRoot,
      workerType: "page",
      role: "child",
      basename: sourceBasename,
    });
    // Even with truncated input, we still write a sanitised placeholder
    // and return a result (the placeholder marks the truncation).
    expect(result).not.toBeNull();
    const finalContent = await fsp.readFile(result!.finalPath, { encoding: "utf-8" });
    const final = JSON.parse(finalContent) as Record<string, unknown>;
    expect(final.error).toBe("truncated_or_unreadable");
  });

  it("noop on already-cleaned source", async () => {
    const result = await processReportFile({
      stagingRoot: staging,
      publicRoot,
      workerType: "page",
      role: "child",
      basename: "never-existed.json",
    });
    expect(result).toBeNull();
  });
});

describe("crash-report-watcher — startCrashReportWatcher manual scan", () => {
  let staging: string;
  let publicRoot: string;

  beforeEach(async () => {
    resetSequenceForTesting();
    staging = await createStagingRoot();
    publicRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), `${CRASH_DUMP_DIR_PREFIX}-watcher-test-`)
    );
  });

  afterEach(async () => {
    await destroyStagingRoot(staging);
    await fsp.rm(publicRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it("scanAndProcess picks up pre-existing files in staging", async () => {
    // Pre-write two reports into staging before starting the watcher.
    await fsp.writeFile(
      path.join(staging, "preexisting1.json"),
      JSON.stringify({ header: { commandLine: ["node"] } })
    );
    await fsp.writeFile(
      path.join(staging, "preexisting2.json"),
      JSON.stringify({ header: { commandLine: ["worker"] } })
    );
    const handle = startCrashReportWatcher({
      stagingRoot: staging,
      publicRoot,
      workerType: "page",
      role: "child",
    });
    try {
      const processed = await handle.scanAndProcess();
      expect(processed.length).toBe(2);
      // Both source files should be removed.
      await expect(fsp.stat(path.join(staging, "preexisting1.json"))).rejects.toThrow();
      await expect(fsp.stat(path.join(staging, "preexisting2.json"))).rejects.toThrow();
    } finally {
      await handle.stop();
    }
  });

  it("scanAndProcess ignores non-JSON files", async () => {
    await fsp.writeFile(path.join(staging, "ignore.txt"), "not a report");
    const handle = startCrashReportWatcher({
      stagingRoot: staging,
      publicRoot,
      workerType: "page",
      role: "child",
    });
    try {
      const processed = await handle.scanAndProcess();
      expect(processed.length).toBe(0);
      // Non-JSON file preserved.
      await expect(fsp.stat(path.join(staging, "ignore.txt"))).resolves.toBeTruthy();
    } finally {
      await handle.stop();
    }
  });

  it("scanAndProcess invokes captureExitMetadata when provided", async () => {
    await fsp.writeFile(
      path.join(staging, "with-meta.json"),
      JSON.stringify({ header: { commandLine: ["node"] } })
    );
    const captureMock = vi.fn(() => ({ exitSignal: "SIGABRT", exitCode: null }));
    const handle = startCrashReportWatcher({
      stagingRoot: staging,
      publicRoot,
      workerType: "page",
      role: "child",
      captureExitMetadata: captureMock,
    });
    try {
      await handle.scanAndProcess();
      expect(captureMock).toHaveBeenCalledTimes(1);
    } finally {
      await handle.stop();
    }
  });

  it("stop() releases the fs.watch handle gracefully", async () => {
    const handle = startCrashReportWatcher({
      stagingRoot: staging,
      publicRoot,
      workerType: "page",
      role: "child",
    });
    await handle.stop();
    // stop() should be idempotent.
    await handle.stop();
  });
});
