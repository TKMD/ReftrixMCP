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

import { describe, it, expect, vi, beforeEach } from "vitest";
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
}));

// =====================================================
// Stub runVisualEmbeddingSubPhases (DINOv2 loop) — not triggered in these tests
// =====================================================
vi.mock("../../src/workers/phases/phase-5-embedding", () => ({
  runVisualEmbeddingSubPhases: vi.fn(async () => ({
    sectionVisualEmbeddingsGenerated: 0,
    partVisualEmbeddingsGenerated: 0,
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
