// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Backfill Category Processors Tests (v0.4.0 PR7a-2)
 *
 * Strategy Pattern (`PROCESSORS` レジストリ) の exhaustiveness、各 Processor の
 * `category` / `requiresScreenshot()` の契約、および `process()` の配線を検証する。
 *
 * 重い統合（DINOv2 / Prisma / BullMQ）は触らず、vi.mock で per-category wrapper を
 * スタブ化して Processor が正しく委譲するかをチェックする。
 *
 * Verifies the Strategy Pattern (`PROCESSORS` registry) for exhaustiveness and the
 * `category` / `requiresScreenshot()` / `process()` wiring of each processor.
 * Avoids heavy integration (DINOv2 / Prisma / BullMQ) by stubbing per-category
 * wrappers via `vi.mock` and asserting the processor delegates correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Job } from "bullmq";
import {
  EMBEDDING_BACKFILL_CATEGORIES,
  type EmbeddingBackfillCategory,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillJobResult,
} from "../../src/queues/embedding-backfill-queue";

// =====================================================
// Stub the embedding-backfill service
// =====================================================
vi.mock("../../src/services/embedding-backfill.service", () => ({
  backfillPartTextForPage: vi.fn(async () => ({
    generated: 3,
    failed: 1,
    memorySkips: 0,
    errors: [],
  })),
  backfillSectionVisualsForPage: vi.fn(async () => ({
    generated: 2,
    failed: 0,
    memorySkips: 1,
    errors: [],
  })),
  backfillMotionsForPage: vi.fn(async () => ({
    generated: 5,
    failed: 0,
    memorySkips: 0,
    errors: [],
  })),
  backfillBackgroundsForPage: vi.fn(async () => ({
    generated: 1,
    failed: 2,
    memorySkips: 0,
    errors: ["bg-err"],
  })),
  backfillJsAnimationsForPage: vi.fn(async () => ({
    generated: 4,
    failed: 0,
    memorySkips: 0,
    errors: [],
  })),
  backfillResponsiveForPage: vi.fn(async () => ({
    generated: 1,
    failed: 0,
    memorySkips: 0,
    errors: [],
  })),
  countPartVisualBackfillTargets: vi.fn(async () => ({ pendingCount: 0 })),
  countSectionVisualBackfillTargets: vi.fn(async () => ({ pendingCount: 0 })),
  // PR-D-9 Wave 3 (FIND-PLAN-LCC-02 / C-13): expectedCount probe used by
  // ResponsiveProcessor.processInProcess for the silent-stall diagnostic log.
  countMissingResponsiveEmbeddings: vi.fn(async () => 0),
}));

// =====================================================
// Stub runVisualEmbeddingSubPhases (DINOv2 loop) — not triggered in these tests
// =====================================================
vi.mock("../../src/workers/phases/phase-5-embedding", () => ({
  runVisualEmbeddingSubPhases: vi.fn(async () => ({
    sectionVisualEmbeddingsGenerated: 0,
    partVisualEmbeddingsGenerated: 0,
    partVisualSkippedBboxInvalid: 0,
    embeddingFailedChunks: 0,
  })),
}));

// =====================================================
// Stub @reftrixmcp/database Prisma for bbox resolution URL lookup
// v0.4.0 PR7e-α: PartVisualProcessor reads `web_pages.url` when
// `requiresBboxResolution` is true.
// vi.hoisted is required because vi.mock factories are hoisted above imports.
// =====================================================
const { mockWebPageFindUnique, mockResolvePartBoundingBoxesWithFallback } = vi.hoisted(() => ({
  mockWebPageFindUnique: vi.fn<[], Promise<{ url: string } | null>>(async () => ({
    url: "https://stripe.com",
  })),
  mockResolvePartBoundingBoxesWithFallback: vi.fn(
    async (): Promise<{ ssrfBlocked: boolean; resolvedCount: number; skippedCount: number }> => ({
      ssrfBlocked: false,
      resolvedCount: 5,
      skippedCount: 0,
    })
  ),
}));
vi.mock("@reftrixmcp/database", () => ({
  prisma: {
    webPage: {
      findUnique: mockWebPageFindUnique,
    },
  },
}));

// =====================================================
// Stub bbox-resolution helper
// v0.4.0 PR7e-α: PartVisualProcessor delegates bbox resolution to the helper
// when `requiresBboxResolution=true`.
// =====================================================
vi.mock("../../src/workers/phases/shared/bbox-resolution.helper", () => ({
  resolvePartBoundingBoxesWithFallback: mockResolvePartBoundingBoxesWithFallback,
}));

// Import AFTER mocks so the Processor module picks up stubbed modules.
import {
  PROCESSORS,
  getBackfillProcessor,
  PartTextProcessor,
  PartVisualProcessor,
  SectionVisualProcessor,
  MotionProcessor,
  BackgroundProcessor,
  JsAnimationProcessor,
  ResponsiveProcessor,
  type BackfillProcessContext,
} from "../../src/queues/embedding-backfill-processors";

// Minimal job stub (only methods the processors call)
function makeJobStub(
  data: EmbeddingBackfillJobData
): Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult> {
  const stub: Partial<Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>> = {
    id: "test-job-id",
    data,
    updateProgress: vi.fn(async () => undefined),
  };
  return stub as Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
}

function makeCtx(
  category: EmbeddingBackfillCategory,
  screenshotStoragePath?: string,
  opts?: { requiresBboxResolution?: boolean }
): BackfillProcessContext {
  const data: EmbeddingBackfillJobData = {
    webPageId: "019bc123-4567-7890-abcd-ef1234567890",
    category,
    createdAt: "2026-04-12T00:00:00.000Z",
  };
  if (screenshotStoragePath !== undefined) {
    data.screenshotStoragePath = screenshotStoragePath;
  }
  if (opts?.requiresBboxResolution !== undefined) {
    data.requiresBboxResolution = opts.requiresBboxResolution;
  }
  return {
    webPageId: data.webPageId,
    job: makeJobStub(data),
    ...(screenshotStoragePath !== undefined ? { screenshotStoragePath } : {}),
  };
}

describe("Backfill Category Processors (v0.4.0 PR7a-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =====================================================
  // Registry exhaustiveness
  // =====================================================
  describe("PROCESSORS registry", () => {
    it("should have a processor for every SSOT category", () => {
      for (const category of EMBEDDING_BACKFILL_CATEGORIES) {
        expect(PROCESSORS[category], `missing processor for ${category}`).toBeDefined();
        expect(PROCESSORS[category].category).toBe(category);
      }
    });

    it("should have exactly 7 processors (matching SSOT length)", () => {
      expect(Object.keys(PROCESSORS)).toHaveLength(EMBEDDING_BACKFILL_CATEGORIES.length);
    });

    it("should return the correct processor via getBackfillProcessor()", () => {
      for (const category of EMBEDDING_BACKFILL_CATEGORIES) {
        const p = getBackfillProcessor(category);
        expect(p).toBe(PROCESSORS[category]);
        expect(p.category).toBe(category);
      }
    });
  });

  // =====================================================
  // requiresScreenshot contract
  // =====================================================
  describe("requiresScreenshot() contract", () => {
    it("should require screenshot for part_visual and section_visual (PR7b scope)", () => {
      // PR7b: section_visual も DINOv2 統合により screenshot 必須に切替。
      // 残りのカテゴリ（part_text / motion / background / js_animation / responsive）
      // は text embedding のみで完結するため screenshot 不要。
      //
      // PR7b: section_visual now requires a screenshot too (DINOv2 integration).
      // The remaining categories (part_text / motion / background / js_animation
      // / responsive) are text-only and need no screenshot.
      expect(PROCESSORS.part_text.requiresScreenshot()).toBe(false);
      expect(PROCESSORS.part_visual.requiresScreenshot()).toBe(true);
      expect(PROCESSORS.section_visual.requiresScreenshot()).toBe(true);
      expect(PROCESSORS.motion.requiresScreenshot()).toBe(false);
      expect(PROCESSORS.background.requiresScreenshot()).toBe(false);
      expect(PROCESSORS.js_animation.requiresScreenshot()).toBe(false);
      expect(PROCESSORS.responsive.requiresScreenshot()).toBe(false);
    });
  });

  // =====================================================
  // Per-processor process() wiring
  // =====================================================
  describe("PartTextProcessor", () => {
    it("should have category='part_text'", () => {
      const p = new PartTextProcessor();
      expect(p.category).toBe("part_text");
    });

    it("should delegate to backfillPartTextForPage and return generated/failed", async () => {
      const ctx = makeCtx("part_text");
      const result = await PROCESSORS.part_text.process(ctx);
      expect(result.category).toBe("part_text");
      expect(result.generated).toBe(3);
      expect(result.failed).toBe(1);
      expect(result.memorySkips).toBe(0);
    });
  });

  describe("PartVisualProcessor", () => {
    it("should have category='part_visual'", () => {
      const p = new PartVisualProcessor();
      expect(p.category).toBe("part_visual");
    });

    it("should graceful-degrade when no screenshot is present", async () => {
      const ctx = makeCtx("part_visual"); // no screenshotStoragePath
      const result = await PROCESSORS.part_visual.process(ctx);
      expect(result.category).toBe("part_visual");
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(0);
    });

    it("should return 0 when pendingCount is 0 even with screenshot", async () => {
      const ctx = makeCtx("part_visual", "/tmp/reftrix-screenshots/phase5/abc.png");
      // countPartVisualBackfillTargets mock returns pendingCount: 0
      const result = await PROCESSORS.part_visual.process(ctx);
      expect(result.generated).toBe(0);
      expect(result.failed).toBe(0);
    });

    // =====================================================
    // v0.4.0 PR7e-α bug② tests: requiresBboxResolution handling
    // =====================================================
    describe("PR7e-α bug②: requiresBboxResolution", () => {
      it("does NOT resolve bboxes when requiresBboxResolution is absent", async () => {
        mockResolvePartBoundingBoxesWithFallback.mockClear();
        const ctx = makeCtx("part_visual", "/tmp/reftrix-screenshots/phase5/abc.png");
        await PROCESSORS.part_visual.process(ctx);
        expect(mockResolvePartBoundingBoxesWithFallback).not.toHaveBeenCalled();
      });

      it("resolves bboxes via helper when requiresBboxResolution=true", async () => {
        mockResolvePartBoundingBoxesWithFallback.mockClear();
        mockResolvePartBoundingBoxesWithFallback.mockResolvedValueOnce({
          ssrfBlocked: false,
          resolvedCount: 7,
          skippedCount: 2,
        });
        const ctx = makeCtx("part_visual", "/tmp/reftrix-screenshots/phase5/abc.png", {
          requiresBboxResolution: true,
        });
        await PROCESSORS.part_visual.process(ctx);
        expect(mockResolvePartBoundingBoxesWithFallback).toHaveBeenCalledTimes(1);
        const args = mockResolvePartBoundingBoxesWithFallback.mock.calls[0]?.[0] as {
          url?: string;
          sharedBrowser?: unknown;
        };
        expect(args?.url).toBe("https://stripe.com");
        // Backfill 経路は sharedBrowser 無し → standalone Chromium を起動
        expect(args?.sharedBrowser).toBeNull();
      });

      it("returns skipReason=ssrf_blocked_on_backfill when helper reports SSRF block", async () => {
        mockResolvePartBoundingBoxesWithFallback.mockClear();
        mockResolvePartBoundingBoxesWithFallback.mockResolvedValueOnce({
          ssrfBlocked: true,
          resolvedCount: 0,
          skippedCount: 0,
        });
        const ctx = makeCtx("part_visual", "/tmp/reftrix-screenshots/phase5/abc.png", {
          requiresBboxResolution: true,
        });
        const result = await PROCESSORS.part_visual.process(ctx);
        expect(result.skipReason).toBe("ssrf_blocked_on_backfill");
        expect(result.generated).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.errors[0]).toMatch(/SSRF/);
      });

      it("falls through gracefully when bbox helper throws (non-fatal)", async () => {
        mockResolvePartBoundingBoxesWithFallback.mockClear();
        mockResolvePartBoundingBoxesWithFallback.mockRejectedValueOnce(
          new Error("Playwright launch failed")
        );
        const ctx = makeCtx("part_visual", "/tmp/reftrix-screenshots/phase5/abc.png", {
          requiresBboxResolution: true,
        });
        // Should NOT throw — proceeds with pendingCount=0 standard path
        const result = await PROCESSORS.part_visual.process(ctx);
        expect(result.generated).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.skipReason).toBeUndefined();
      });

      it("skips bbox resolution when URL lookup returns null", async () => {
        mockResolvePartBoundingBoxesWithFallback.mockClear();
        mockWebPageFindUnique.mockResolvedValueOnce(null as unknown as { url: string });
        const ctx = makeCtx("part_visual", "/tmp/reftrix-screenshots/phase5/abc.png", {
          requiresBboxResolution: true,
        });
        await PROCESSORS.part_visual.process(ctx);
        expect(mockResolvePartBoundingBoxesWithFallback).not.toHaveBeenCalled();
      });
    });
  });

  describe("SectionVisualProcessor", () => {
    it("should have category='section_visual'", () => {
      const p = new SectionVisualProcessor();
      expect(p.category).toBe("section_visual");
    });

    it("should delegate to backfillSectionVisualsForPage", async () => {
      const ctx = makeCtx("section_visual");
      const result = await PROCESSORS.section_visual.process(ctx);
      expect(result.category).toBe("section_visual");
      expect(result.generated).toBe(2);
      expect(result.memorySkips).toBe(1);
    });
  });

  describe("MotionProcessor", () => {
    it("should have category='motion'", () => {
      const p = new MotionProcessor();
      expect(p.category).toBe("motion");
    });

    it("should delegate to backfillMotionsForPage", async () => {
      const ctx = makeCtx("motion");
      const result = await PROCESSORS.motion.process(ctx);
      expect(result.generated).toBe(5);
      expect(result.failed).toBe(0);
    });
  });

  describe("BackgroundProcessor", () => {
    it("should have category='background'", () => {
      const p = new BackgroundProcessor();
      expect(p.category).toBe("background");
    });

    it("should propagate errors from backfillBackgroundsForPage", async () => {
      const ctx = makeCtx("background");
      const result = await PROCESSORS.background.process(ctx);
      expect(result.generated).toBe(1);
      expect(result.failed).toBe(2);
      expect(result.errors).toEqual(["bg-err"]);
    });
  });

  describe("JsAnimationProcessor", () => {
    it("should have category='js_animation'", () => {
      const p = new JsAnimationProcessor();
      expect(p.category).toBe("js_animation");
    });

    it("should delegate to backfillJsAnimationsForPage", async () => {
      const ctx = makeCtx("js_animation");
      const result = await PROCESSORS.js_animation.process(ctx);
      expect(result.generated).toBe(4);
    });
  });

  describe("ResponsiveProcessor", () => {
    it("should have category='responsive'", () => {
      const p = new ResponsiveProcessor();
      expect(p.category).toBe("responsive");
    });

    it("should delegate to backfillResponsiveForPage", async () => {
      const ctx = makeCtx("responsive");
      const result = await PROCESSORS.responsive.process(ctx);
      expect(result.generated).toBe(1);
    });
  });
});

// =============================================================================
// v0.4.0 PR7e-β4 PR2b-β: EMBEDDING_BACKFILL_FORK_ENABLED flag gate + fork path
// =============================================================================
//
// These 4 cases verify the canary wiring:
//   - T-new-01: flag unset / "false" → in-process
//   - T-new-02: flag = "true" → runEmbeddingBackfillFork is invoked
//               (incl. TPA-H-1 observability mapping)
//   - T-new-03: non-js_animation categories are unaffected by the flag
//   - T-new-04: SEC-M-3 — orchestrator module-load failure → in-process fallback
//
// NOTE (TDA-M-4): vitest 4.x `vi.mock` only hoists static ES imports. The fork
// orchestrator is dynamically imported inside `processViaFork`, so we use
// `vi.doMock` + `vi.resetModules()` + dynamic re-import to swap it per-test.
//
// T-new-01/T-new-02/T-new-03/T-new-04 (v0.4.0 PR7e-β4 PR2b-β) — see PR2b plan
// §5.3.3 for the spec.
describe("JsAnimationProcessor × EMBEDDING_BACKFILL_FORK_ENABLED (PR7e-β4 PR2b-β)", () => {
  const ORIGINAL_FLAG = process.env["EMBEDDING_BACKFILL_FORK_ENABLED"];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env["EMBEDDING_BACKFILL_FORK_ENABLED"];
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env["EMBEDDING_BACKFILL_FORK_ENABLED"];
    } else {
      process.env["EMBEDDING_BACKFILL_FORK_ENABLED"] = ORIGINAL_FLAG;
    }
  });

  /**
   * Load the processors module fresh with per-test mocks applied. Returns the
   * `JsAnimationProcessor` instance so callers can exercise `process()`.
   */
  async function loadProcessorsWithMocks(opts: {
    serviceResult?: {
      generated: number;
      failed: number;
      memorySkips: number;
      errors: string[];
    };
    forkImpl?: typeof import("../../src/workers/phases/embedding-backfill-fork-orchestrator").runEmbeddingBackfillFork;
    throwOnForkImport?: boolean;
  }): Promise<{
    processor: import("../../src/queues/embedding-backfill-processors").JsAnimationProcessor;
    backfillSpy: ReturnType<typeof vi.fn>;
    forkSpy?: ReturnType<typeof vi.fn>;
  }> {
    // Always stub the service wrappers.
    const backfillSpy = vi.fn(async () => ({
      generated: 0,
      failed: 0,
      memorySkips: 0,
      errors: [],
      ...(opts.serviceResult ?? {}),
    }));
    vi.doMock("../../src/services/embedding-backfill.service", () => ({
      backfillPartTextForPage: vi.fn(async () => ({
        generated: 0,
        failed: 0,
        memorySkips: 0,
        errors: [],
      })),
      backfillSectionVisualsForPage: vi.fn(async () => ({
        generated: 0,
        failed: 0,
        memorySkips: 0,
        errors: [],
      })),
      backfillMotionsForPage: vi.fn(async () => ({
        generated: 0,
        failed: 0,
        memorySkips: 0,
        errors: [],
      })),
      backfillBackgroundsForPage: vi.fn(async () => ({
        generated: 0,
        failed: 0,
        memorySkips: 0,
        errors: [],
      })),
      backfillJsAnimationsForPage: backfillSpy,
      backfillResponsiveForPage: vi.fn(async () => ({
        generated: 0,
        failed: 0,
        memorySkips: 0,
        errors: [],
      })),
      countPartVisualBackfillTargets: vi.fn(async () => ({ pendingCount: 0 })),
      countSectionVisualBackfillTargets: vi.fn(async () => ({ pendingCount: 0 })),
    }));
    vi.doMock("../../src/workers/phases/phase-5-embedding", () => ({
      runVisualEmbeddingSubPhases: vi.fn(async () => ({
        sectionVisualEmbeddingsGenerated: 0,
        partVisualEmbeddingsGenerated: 0,
        partVisualSkippedBboxInvalid: 0,
        embeddingFailedChunks: 0,
      })),
    }));
    vi.doMock("@reftrixmcp/database", () => ({
      prisma: { webPage: { findUnique: vi.fn(async () => null) } },
    }));
    vi.doMock("../../src/workers/phases/shared/bbox-resolution.helper", () => ({
      resolvePartBoundingBoxesWithFallback: vi.fn(async () => ({
        ssrfBlocked: false,
        resolvedCount: 0,
        skippedCount: 0,
      })),
    }));

    // Optionally mock the fork orchestrator.
    let forkSpy: ReturnType<typeof vi.fn> | undefined;
    if (opts.throwOnForkImport) {
      vi.doMock("../../src/workers/phases/embedding-backfill-fork-orchestrator.js", () => {
        throw new Error("module-load simulated failure (SEC-M-3)");
      });
    } else if (opts.forkImpl) {
      forkSpy = vi.fn(opts.forkImpl);
      vi.doMock("../../src/workers/phases/embedding-backfill-fork-orchestrator.js", () => ({
        runEmbeddingBackfillFork: forkSpy,
        BACKFILL_EXTEND_LOCK_DURATION_MS: 60_000,
      }));
    }

    const mod = await import("../../src/queues/embedding-backfill-processors");
    const processor = new mod.JsAnimationProcessor();
    const result: {
      processor: import("../../src/queues/embedding-backfill-processors").JsAnimationProcessor;
      backfillSpy: ReturnType<typeof vi.fn>;
      forkSpy?: ReturnType<typeof vi.fn>;
    } = { processor, backfillSpy };
    if (forkSpy) {
      result.forkSpy = forkSpy;
    }
    return result;
  }

  function makeJobStub(): Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult> {
    const stub: Partial<Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>> = {
      id: "job-flag-test",
      data: {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        category: "js_animation",
        createdAt: "2026-04-18T00:00:00.000Z",
      },
      updateProgress: vi.fn(async () => undefined),
      extendLock: vi.fn(async () => undefined),
    };
    return stub as Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>;
  }

  // ---------------------------------------------------------------------------
  // T-new-01: flag unset / "false" → in-process path
  // ---------------------------------------------------------------------------
  it("T-new-01: calls in-process path when flag is unset", async () => {
    const { processor, backfillSpy } = await loadProcessorsWithMocks({
      serviceResult: { generated: 5, failed: 1, memorySkips: 0, errors: ["x"] },
    });
    const job = makeJobStub();
    const result = await processor.process({
      webPageId: job.data.webPageId,
      job,
    });
    expect(backfillSpy).toHaveBeenCalledTimes(1);
    expect(result.generated).toBe(5);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual(["x"]);
  });

  it('T-new-01: calls in-process path when flag is "false"', async () => {
    process.env["EMBEDDING_BACKFILL_FORK_ENABLED"] = "false";
    const { processor, backfillSpy } = await loadProcessorsWithMocks({
      serviceResult: { generated: 2, failed: 0, memorySkips: 0, errors: [] },
    });
    const job = makeJobStub();
    const result = await processor.process({
      webPageId: job.data.webPageId,
      job,
    });
    expect(backfillSpy).toHaveBeenCalledTimes(1);
    expect(result.generated).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // T-new-02: flag "true" → fork orchestrator is invoked + TPA-H-1 mapping
  // ---------------------------------------------------------------------------
  it("T-new-02: invokes runEmbeddingBackfillFork and maps TPA-H-1 observability", async () => {
    process.env["EMBEDDING_BACKFILL_FORK_ENABLED"] = "true";
    const { processor, backfillSpy, forkSpy } = await loadProcessorsWithMocks({
      forkImpl: async () => ({
        processedCount: 7,
        failedCount: 2,
        memorySkipCount: 1,
        errors: ["first", "second"],
      }),
    });
    const job = makeJobStub();
    const result = await processor.process({
      webPageId: job.data.webPageId,
      job,
    });
    // Fork path used, in-process wrapper NOT called.
    expect(forkSpy).toHaveBeenCalledTimes(1);
    expect(backfillSpy).not.toHaveBeenCalled();

    // TPA-H-1: observability fields are propagated.
    expect(result.category).toBe("js_animation");
    expect(result.generated).toBe(7);
    expect(result.failed).toBe(2);
    expect(result.memorySkips).toBe(1);
    expect(result.errors).toEqual(["first", "second"]);

    // Fork was called with the head-100 contract + correct job id + webPageId.
    const callArgs = forkSpy!.mock.calls[0]?.[0] as {
      jobId: string;
      webPageId: string;
      category: string;
      partsLimit: number;
    };
    expect(callArgs.jobId).toBe("job-flag-test");
    expect(callArgs.webPageId).toBe(job.data.webPageId);
    expect(callArgs.category).toBe("js_animation");
    expect(callArgs.partsLimit).toBe(100);
  });

  it("T-new-02: missing observability fields default to 0 / []", async () => {
    process.env["EMBEDDING_BACKFILL_FORK_ENABLED"] = "true";
    const { processor } = await loadProcessorsWithMocks({
      forkImpl: async () => ({ processedCount: 3 }), // no failed/memory/errors
    });
    const job = makeJobStub();
    const result = await processor.process({
      webPageId: job.data.webPageId,
      job,
    });
    expect(result.generated).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.memorySkips).toBe(0);
    expect(result.errors).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // T-new-03: Non-js_animation categories are unaffected by the flag
  // ---------------------------------------------------------------------------
  // TPA-M-3 (PR2b-β audit): `part_visual` added to the parametrized list so a
  // future bug accidentally loading the fork orchestrator under
  // `EMBEDDING_BACKFILL_FORK_ENABLED=true` is caught for every non-js category.
  // TPA-M-3 (PR2b-β 監査): `part_visual` を parametrized 対象に追加し、
  // 将来 `EMBEDDING_BACKFILL_FORK_ENABLED=true` 下で fork orchestrator を
  // 誤って load するバグを js 以外の全カテゴリで検出可能にする。
  it.each([
    "part_text",
    "part_visual",
    "section_visual",
    "motion",
    "background",
    "responsive",
  ] as const)(
    "T-new-03: %s category ignores EMBEDDING_BACKFILL_FORK_ENABLED=true (in-process)",
    async (category) => {
      process.env["EMBEDDING_BACKFILL_FORK_ENABLED"] = "true";
      // Sanity-only: we do NOT provide a forkImpl; if any non-js category tried
      // to import the orchestrator we'd see a load failure below. Instead we
      // just assert the public PROCESSORS registry still executes in-process.
      vi.resetModules();
      vi.doMock("../../src/services/embedding-backfill.service", () => ({
        backfillPartTextForPage: vi.fn(async () => ({
          generated: 11,
          failed: 0,
          memorySkips: 0,
          errors: [],
        })),
        backfillSectionVisualsForPage: vi.fn(async () => ({
          generated: 12,
          failed: 0,
          memorySkips: 0,
          errors: [],
        })),
        backfillMotionsForPage: vi.fn(async () => ({
          generated: 13,
          failed: 0,
          memorySkips: 0,
          errors: [],
        })),
        backfillBackgroundsForPage: vi.fn(async () => ({
          generated: 14,
          failed: 0,
          memorySkips: 0,
          errors: [],
        })),
        backfillJsAnimationsForPage: vi.fn(async () => ({
          generated: 99,
          failed: 0,
          memorySkips: 0,
          errors: [],
        })),
        backfillResponsiveForPage: vi.fn(async () => ({
          generated: 16,
          failed: 0,
          memorySkips: 0,
          errors: [],
        })),
        countPartVisualBackfillTargets: vi.fn(async () => ({ pendingCount: 0 })),
        countSectionVisualBackfillTargets: vi.fn(async () => ({ pendingCount: 0 })),
      }));
      vi.doMock("../../src/workers/phases/phase-5-embedding", () => ({
        runVisualEmbeddingSubPhases: vi.fn(async () => ({
          sectionVisualEmbeddingsGenerated: 0,
          partVisualEmbeddingsGenerated: 0,
          partVisualSkippedBboxInvalid: 0,
          embeddingFailedChunks: 0,
        })),
      }));
      vi.doMock("@reftrixmcp/database", () => ({
        prisma: { webPage: { findUnique: vi.fn(async () => null) } },
      }));
      vi.doMock("../../src/workers/phases/shared/bbox-resolution.helper", () => ({
        resolvePartBoundingBoxesWithFallback: vi.fn(async () => ({
          ssrfBlocked: false,
          resolvedCount: 0,
          skippedCount: 0,
        })),
      }));
      // Fail loudly if orchestrator is imported for non-js categories.
      vi.doMock("../../src/workers/phases/embedding-backfill-fork-orchestrator.js", () => {
        throw new Error("non-js_animation category must NOT load fork orchestrator under the flag");
      });

      const mod = await import("../../src/queues/embedding-backfill-processors");
      const ctx: import("../../src/queues/embedding-backfill-processors").BackfillProcessContext = {
        webPageId: "019bc123-4567-7890-abcd-ef1234567890",
        job: {
          id: "job-non-js",
          data: {
            webPageId: "019bc123-4567-7890-abcd-ef1234567890",
            category,
            createdAt: "2026-04-18T00:00:00.000Z",
          },
          updateProgress: vi.fn(async () => undefined),
        } as unknown as Job<EmbeddingBackfillJobData, EmbeddingBackfillJobResult>,
      };
      // Just ensure process() runs without the "must NOT load" throw.
      // Some processors (part_visual / section_visual) require a screenshot and
      // gracefully return 0, so we don't assert on `generated`.
      const result = await mod.PROCESSORS[category].process(ctx);
      expect(result.category).toBe(category);
    }
  );

  // ---------------------------------------------------------------------------
  // T-new-04 (SEC-M-3): fork module-load failure → in-process fallback
  // ---------------------------------------------------------------------------
  it("T-new-04 (SEC-M-3): falls back to in-process when fork orchestrator import fails", async () => {
    process.env["EMBEDDING_BACKFILL_FORK_ENABLED"] = "true";
    const { processor, backfillSpy } = await loadProcessorsWithMocks({
      throwOnForkImport: true,
      serviceResult: {
        generated: 42,
        failed: 3,
        memorySkips: 2,
        errors: ["fallback-ok"],
      },
    });
    const job = makeJobStub();
    const result = await processor.process({
      webPageId: job.data.webPageId,
      job,
    });
    // Fallback path: in-process wrapper was invoked, Job completed (no throw).
    expect(backfillSpy).toHaveBeenCalledTimes(1);
    expect(result.category).toBe("js_animation");
    expect(result.generated).toBe(42);
    expect(result.failed).toBe(3);
    expect(result.memorySkips).toBe(2);
    expect(result.errors).toEqual(["fallback-ok"]);
  });
});

// =============================================================================
// PR-D-9 Wave 3 (FIND-PLAN-LCC-02 / C-13): ResponsiveProcessor diagnostic log
// =============================================================================
//
// Plan v1.1 §6.4: assert that when `expectedCount > 0` but `result.generated
// === 0`, ResponsiveProcessor.processInProcess emits a structured warn log
// containing `webPageId` (truncated per CWE-532), `expectedCount`, and
// `generatedCount`. PII compliance per .claude/rules/security.md.
//
// @see Plan v1.1 §6.4 (`tests/queues/embedding-backfill-processors-responsive.test.ts`)
// @see Finding Registry FIND-PLAN-LCC-02 (TOCTOU diagnostic) / FIND-PLAN-SEC-03 (PII)

describe("ResponsiveProcessor diagnostic log (PR-D-9 Wave 3 / FIND-PLAN-LCC-02)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset module cache so per-test mocks reapply cleanly.
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits diagnostic warn log when expectedCount > 0 but generatedCount === 0 (silent stall)", async () => {
    // Arrange: countMissingResponsiveEmbeddings returns 5 (missing rows
    // exist), but backfillResponsiveForPage returns generated=0 → silent
    // stall signature (PR-D-7 §32.2).
    vi.doMock("../../src/services/embedding-backfill.service", () => ({
      backfillPartTextForPage: vi.fn(async () => ({
        generated: 0,
        failed: 0,
        memorySkips: 0,
        errors: [],
      })),
      backfillSectionVisualsForPage: vi.fn(),
      backfillMotionsForPage: vi.fn(),
      backfillBackgroundsForPage: vi.fn(),
      backfillJsAnimationsForPage: vi.fn(),
      backfillResponsiveForPage: vi.fn(async () => ({
        generated: 0,
        failed: 0,
        memorySkips: 0,
        errors: [],
      })),
      countMissingResponsiveEmbeddings: vi.fn(async () => 5),
      countPartVisualBackfillTargets: vi.fn(async () => ({ pendingCount: 0 })),
      countSectionVisualBackfillTargets: vi.fn(async () => ({ pendingCount: 0 })),
    }));
    vi.doMock("../../src/workers/phases/phase-5-embedding", () => ({
      runVisualEmbeddingSubPhases: vi.fn(),
    }));
    vi.doMock("../../src/workers/phases/shared/bbox-resolution.helper", () => ({
      resolvePartBoundingBoxesWithFallback: vi.fn(),
    }));
    vi.doMock("@reftrixmcp/database", () => ({
      prisma: { webPage: { findUnique: vi.fn() } },
    }));

    const loggerModule = await import("../../src/utils/logger");
    const warnSpy = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);

    const { ResponsiveProcessor } = await import("../../src/queues/embedding-backfill-processors");
    const processor = new ResponsiveProcessor();
    const ctx = {
      webPageId: "01234567-aaaa-bbbb-cccc-ddddeeeeffff",
      job: {
        id: "test-job-id",
        data: {
          webPageId: "01234567-aaaa-bbbb-cccc-ddddeeeeffff",
          category: "responsive" as const,
          createdAt: "2026-04-26T00:00:00.000Z",
        },
        updateProgress: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof processor.process>[0]["job"],
    };

    // Act
    await processor.process(ctx);

    // Assert: warn log emitted with expected shape (PII truncated to "01234567...")
    const stallWarnCall = warnSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("generatedCount mismatch")
    );
    expect(stallWarnCall, "diagnostic warn log not emitted").toBeDefined();
    if (stallWarnCall) {
      const logFields = stallWarnCall[1] as Record<string, unknown>;
      // C-13 PII: webPageId must be truncated (not full UUID).
      expect(logFields["webPageId"]).toBe("01234567...");
      expect(logFields["expectedCount"]).toBe(5);
      expect(logFields["generatedCount"]).toBe(0);
    }
  });

  it("does NOT emit diagnostic warn log when expectedCount === 0 (no stall)", async () => {
    vi.doMock("../../src/services/embedding-backfill.service", () => ({
      backfillPartTextForPage: vi.fn(),
      backfillSectionVisualsForPage: vi.fn(),
      backfillMotionsForPage: vi.fn(),
      backfillBackgroundsForPage: vi.fn(),
      backfillJsAnimationsForPage: vi.fn(),
      backfillResponsiveForPage: vi.fn(async () => ({
        generated: 0,
        failed: 0,
        memorySkips: 0,
        errors: [],
      })),
      countMissingResponsiveEmbeddings: vi.fn(async () => 0),
      countPartVisualBackfillTargets: vi.fn(async () => ({ pendingCount: 0 })),
      countSectionVisualBackfillTargets: vi.fn(async () => ({ pendingCount: 0 })),
    }));
    vi.doMock("../../src/workers/phases/phase-5-embedding", () => ({
      runVisualEmbeddingSubPhases: vi.fn(),
    }));
    vi.doMock("../../src/workers/phases/shared/bbox-resolution.helper", () => ({
      resolvePartBoundingBoxesWithFallback: vi.fn(),
    }));
    vi.doMock("@reftrixmcp/database", () => ({
      prisma: { webPage: { findUnique: vi.fn() } },
    }));

    const loggerModule = await import("../../src/utils/logger");
    const warnSpy = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);

    const { ResponsiveProcessor } = await import("../../src/queues/embedding-backfill-processors");
    const processor = new ResponsiveProcessor();
    await processor.process({
      webPageId: "01234567-aaaa-bbbb-cccc-ddddeeeeffff",
      job: {
        id: "test-job-id",
        data: {
          webPageId: "01234567-aaaa-bbbb-cccc-ddddeeeeffff",
          category: "responsive" as const,
          createdAt: "2026-04-26T00:00:00.000Z",
        },
        updateProgress: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof processor.process>[0]["job"],
    });

    // Assert: NO "generatedCount mismatch" warn was emitted.
    const stallWarn = warnSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("generatedCount mismatch")
    );
    expect(stallWarn).toBeUndefined();
  });
});
