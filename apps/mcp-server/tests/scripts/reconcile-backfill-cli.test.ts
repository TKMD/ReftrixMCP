// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * reconcile-backfill CLI Tests (v0.4.0 PR6)
 *
 * `__parseArgsForTest` export を利用した CLI 引数パーサのユニットテスト。
 * --confirm / --dry-run / --threshold-ms / --batch が正しくパースされることを
 * 確認する。
 *
 * Unit tests for the CLI argument parser exposed via `__parseArgsForTest`.
 * Verifies that --confirm / --dry-run / --threshold-ms / --batch are parsed
 * correctly.
 */

import { describe, it, expect, vi } from "vitest";

// Mock heavy dependencies so the module can be imported without Prisma / Redis
vi.mock("@reftrixmcp/database", () => ({
  prisma: {},
}));
vi.mock("../../src/queues/embedding-backfill-queue", () => ({
  createEmbeddingBackfillQueue: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock("../../src/services/backfill-reconciliation.service", () => ({
  reconcileStaleBackfillJobs: vi.fn(),
}));

import { __parseArgsForTest as parseArgs } from "../../src/scripts/reconcile-backfill";

describe("reconcile-backfill CLI parseArgs (v0.4.0 PR6)", () => {
  it("defaults confirm=false, dryRun=false", () => {
    const args = parseArgs([]);
    expect(args.confirm).toBe(false);
    expect(args.dryRun).toBe(false);
    expect(args.thresholdMs).toBeUndefined();
    expect(args.batchLimit).toBeUndefined();
  });

  it("parses --confirm", () => {
    const args = parseArgs(["--confirm"]);
    expect(args.confirm).toBe(true);
    expect(args.dryRun).toBe(false);
  });

  it("parses --dry-run", () => {
    const args = parseArgs(["--dry-run"]);
    expect(args.dryRun).toBe(true);
    expect(args.confirm).toBe(false);
  });

  it("parses --threshold-ms", () => {
    const args = parseArgs(["--threshold-ms", "30000"]);
    expect(args.thresholdMs).toBe(30000);
  });

  it("parses --batch", () => {
    const args = parseArgs(["--batch", "250"]);
    expect(args.batchLimit).toBe(250);
  });

  it("rejects invalid --threshold-ms (falls through to default)", () => {
    const args = parseArgs(["--threshold-ms", "abc"]);
    expect(args.thresholdMs).toBeUndefined();
  });

  it("rejects zero / negative --batch", () => {
    expect(parseArgs(["--batch", "0"]).batchLimit).toBeUndefined();
    expect(parseArgs(["--batch", "-5"]).batchLimit).toBeUndefined();
  });

  it("combines flags correctly", () => {
    const args = parseArgs(["--dry-run", "--threshold-ms", "60000", "--batch", "100"]);
    expect(args.dryRun).toBe(true);
    expect(args.thresholdMs).toBe(60000);
    expect(args.batchLimit).toBe(100);
  });
});
