// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * v0.4.0 PR7d-1: Screenshot persistence regression guard.
 *
 * The Phase 5 processor in `page-analyze-worker.ts` **must not** call
 * `cleanupPhase5TempDir` (or any other rmSync-like helper) on a directory
 * path derived from `state.screenshotPngPath`. Doing so destroys the
 * persisted screenshot (`<REFTRIX_SCREENSHOT_ROOT>/phase5/<webPageId>.png`)
 * before Queue-based Backfill (`part_visual` / `section_visual`) can read it,
 * producing zero visual embeddings — the PR7b/PR7c carry-over bug.
 *
 * Deletion of the persisted screenshot must only flow through:
 *   (a) PR6 TTL cron (`scheduleScreenshotCleanupCron()`, 7d)
 *   (b) GDPR `data.delete` (Art. 17 synchronous,
 *       `ScreenshotPersistenceService.deleteScreenshot()`)
 *
 * See ADR-0010 + DATA_RETENTION.md §9 for the full deletion-path matrix.
 *
 * This file uses static source inspection rather than a live pipeline run
 * because Phase 5 has heavy dependencies (Playwright, ONNX, Ollama) that are
 * unavailable in unit tests. The source-level guard is sufficient to prevent
 * regression of the specific PR7d-1 fix.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const WORKER_SRC = path.resolve(__dirname, "../../src/workers/page-analyze-worker.ts");

describe("PR7d-1: page-analyze-worker screenshot persistence regression guard", () => {
  it("does NOT call cleanupPhase5TempDir anywhere in executable code", () => {
    const source = fs.readFileSync(WORKER_SRC, "utf-8");
    // Strip comments so that historical migration notes in JSDoc do not trip us.
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    // No call site allowed.
    expect(codeOnly).not.toMatch(/cleanupPhase5TempDir\s*\(/);
    // No dynamic import of the module either.
    expect(codeOnly).not.toMatch(/import\s*\(\s*["'].*phase-5-raw-decode/);
  });

  it("does NOT call ScreenshotPersistenceService.deleteScreenshot() from the worker", () => {
    const source = fs.readFileSync(WORKER_SRC, "utf-8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    expect(codeOnly).not.toMatch(/\.deleteScreenshot\s*\(/);
  });

  it("retains `delete state.screenshotPngPath` in both Phase 5 and finally paths (idempotent null-out)", () => {
    const source = fs.readFileSync(WORKER_SRC, "utf-8");
    // The string must appear at least twice: once in Phase 5 post-processing
    // and once in the finally block.
    const matches = source.match(/delete\s+state\.screenshotPngPath/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("contains an ADR-0010 citation near the deletion-guard code (documentation integrity)", () => {
    const source = fs.readFileSync(WORKER_SRC, "utf-8");
    // ADR-0010 is the PR7d-1 ADR; the cleanup-removal comment must cite it so
    // future readers understand why in-memory null-out is the only action.
    expect(source).toMatch(/ADR-0010/);
  });
});

describe("PR7d-1: delete state.screenshotPngPath is idempotent (safety property)", () => {
  it("`delete` on an already-deleted / undefined field does not throw (TypeScript runtime semantics)", () => {
    // Sanity test: we rely on the fact that `delete` on a non-existent property
    // is a no-op in strict mode as well, so the finally path is safe to call
    // even after the Phase 5 post-processing block already null-ed the field.
    const state: { screenshotPngPath?: string } = { screenshotPngPath: "/tmp/foo.png" };
    // Correct usage: remove the property
    delete state.screenshotPngPath;
    expect(state.screenshotPngPath).toBeUndefined();
    // Second delete — must also be a no-op
    expect(() => {
      delete state.screenshotPngPath;
    }).not.toThrow();
    expect(state.screenshotPngPath).toBeUndefined();
  });
});
