// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 0 Early INSERT — processIngestPhase branch tests (v0.4.0 PR7e PR-B P4)
 *
 * `phase0EarlyInsertEnabled` フラグ経由で `processIngestPhase` が Phase 0.5 の
 * W1 upsert に含める `analysisStatus` の扱いを分岐することを検証する。
 *   - flag=false (既定, レガシー) → W1 upsert が `analysisStatus='pending'` を含む
 *   - flag=true  (opt-in)         → W1 upsert は `analysisStatus` を含めない
 *     (W0 で既に書き込み済みのため重複書込を避ける)
 *
 * オーケストレーター側 (page-analyze-worker) の W0 upsert + W2
 * `markAnalysisStarted` の挙動は integration 側 (standing regression
 * INV-PAGE-QUEUE-001-C/-D) で別途検証する。ここでは Phase 0.5 (W1) が flag を
 * 正しく尊重しているかだけを焦点化する。
 *
 * Tests that `processIngestPhase` branches on `phase0EarlyInsertEnabled` when
 * composing the W1 upsert payload:
 *   - flag=false (default, legacy) → upsert includes `analysisStatus='pending'`
 *   - flag=true  (opt-in)          → upsert MUST omit `analysisStatus`
 *     (already written by W0 in the orchestrator, avoid duplicate write)
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Browser } from "playwright";

import { processIngestPhase } from "../../src/workers/phases/phase-0-ingest";
import type { PipelineState, PhaseContext } from "../../src/workers/phases/types";
import { createScreenshotPersistenceService } from "../../src/services/screenshot-persistence.service";

const WEB_PAGE_ID = "fedcba98-7654-7210-bedc-ba9876543210";
const TARGET_URL = "https://example.com/early-insert";

function createPipelineState(): PipelineState {
  return {
    actualWebPageId: WEB_PAGE_ID,
    completedPhases: [],
    failedPhases: [],
    results: {},
    layoutResultForNarrative: null,
    sectionSaveResult: null,
    motionSaveResult: null,
    jsSaveResult: null,
    bgSaveResult: null,
    motionResultForEmbedding: null,
    jsAnimationsForEmbedding: null,
    scrollVisionSaveResult: null,
    scrollVisionResultForEmbedding: null,
    scrollVisionCapturesForDeferred: null,
    html: null,
    screenshotBase64: undefined,
    narrativePreDisabled: false,
    visionPreDisabled: false,
    memoryAborted: false,
  };
}

function createPhaseContext(): PhaseContext {
  return {
    job: {
      updateProgress: vi.fn().mockResolvedValue(undefined),
      log: vi.fn().mockResolvedValue(undefined),
    } as never,
    options: {},
    url: TARGET_URL,
    webPageId: WEB_PAGE_ID,
    effectiveToken: "test-token",
    effectiveLockDuration: 30_000,
    statusTracker: {
      startPhase: vi.fn(),
      completePhase: vi.fn(),
    } as never,
  };
}

function createAdapter(): {
  ingest: ReturnType<typeof vi.fn>;
  getSharedBrowser: ReturnType<typeof vi.fn>;
} {
  return {
    ingest: vi.fn().mockResolvedValue({
      success: true,
      html: "<html><head><title>T</title></head><body>hello</body></html>",
      screenshots: undefined,
    }),
    getSharedBrowser: vi.fn().mockResolvedValue({ isConnected: (): boolean => true } as Browser),
  };
}

function createPrisma(): {
  webPage: {
    upsert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
} {
  return {
    webPage: {
      upsert: vi.fn().mockResolvedValue({ id: WEB_PAGE_ID }),
      update: vi.fn().mockResolvedValue({ id: WEB_PAGE_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
}

describe("Phase 0 Early INSERT — W1 branch (v0.4.0 PR7e PR-B)", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-early-insert-test-"));
    process.env.REFTRIX_SCREENSHOT_ROOT = sandbox;
  });

  afterEach(async () => {
    delete process.env.REFTRIX_SCREENSHOT_ROOT;
    await fs.rm(sandbox, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("legacy path (flag=undefined) writes analysisStatus='pending' in W1 upsert", async () => {
    const state = createPipelineState();
    const ctx = createPhaseContext();
    const adapter = createAdapter();
    const prisma = createPrisma();
    const persistence = createScreenshotPersistenceService({
      prisma: prisma as unknown as Parameters<
        typeof createScreenshotPersistenceService
      >[0]["prisma"],
    });

    await processIngestPhase(state, ctx, {
      pageIngestAdapter: adapter as never,
      prisma: prisma as never,
      screenshotPersistenceService: persistence,
    });

    expect(prisma.webPage.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.webPage.upsert.mock.calls[0]![0]! as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(call.create.analysisStatus).toBe("pending");
    expect(call.update.analysisStatus).toBe("pending");
  });

  it("legacy path (flag=false) writes analysisStatus='pending' in W1 upsert", async () => {
    const state = createPipelineState();
    const ctx = createPhaseContext();
    const adapter = createAdapter();
    const prisma = createPrisma();
    const persistence = createScreenshotPersistenceService({
      prisma: prisma as unknown as Parameters<
        typeof createScreenshotPersistenceService
      >[0]["prisma"],
    });

    await processIngestPhase(state, ctx, {
      pageIngestAdapter: adapter as never,
      prisma: prisma as never,
      screenshotPersistenceService: persistence,
      phase0EarlyInsertEnabled: false,
    });

    const call = prisma.webPage.upsert.mock.calls[0]![0]! as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(call.create.analysisStatus).toBe("pending");
    expect(call.update.analysisStatus).toBe("pending");
  });

  it("early-insert path (flag=true) OMITS analysisStatus from W1 upsert", async () => {
    const state = createPipelineState();
    const ctx = createPhaseContext();
    const adapter = createAdapter();
    const prisma = createPrisma();
    const persistence = createScreenshotPersistenceService({
      prisma: prisma as unknown as Parameters<
        typeof createScreenshotPersistenceService
      >[0]["prisma"],
    });

    await processIngestPhase(state, ctx, {
      pageIngestAdapter: adapter as never,
      prisma: prisma as never,
      screenshotPersistenceService: persistence,
      phase0EarlyInsertEnabled: true,
    });

    expect(prisma.webPage.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.webPage.upsert.mock.calls[0]![0]! as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    // create and update payloads must NOT contain `analysisStatus`
    expect(call.create.analysisStatus).toBeUndefined();
    expect(call.update.analysisStatus).toBeUndefined();
    // But they MUST still contain htmlContent / htmlHash (Phase 0.5 job)
    expect(call.create.htmlContent).toEqual(expect.any(String));
    expect(call.create.htmlHash).toEqual(expect.any(String));
    expect(call.update.htmlContent).toEqual(expect.any(String));
    expect(call.update.htmlHash).toEqual(expect.any(String));
  });

  it("skips W1 upsert entirely when saveToDb=false (flag has no effect here)", async () => {
    const state = createPipelineState();
    const ctx = createPhaseContext();
    ctx.options = { layoutOptions: { saveToDb: false } };
    const adapter = createAdapter();
    const prisma = createPrisma();
    const persistence = createScreenshotPersistenceService({
      prisma: prisma as unknown as Parameters<
        typeof createScreenshotPersistenceService
      >[0]["prisma"],
    });

    await processIngestPhase(state, ctx, {
      pageIngestAdapter: adapter as never,
      prisma: prisma as never,
      screenshotPersistenceService: persistence,
      phase0EarlyInsertEnabled: true,
    });

    expect(prisma.webPage.upsert).not.toHaveBeenCalled();
  });
});
