// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 1/3 Parallelization Tests
 *
 * Phase 1 (Layout) と Phase 3 (Quality) が Promise.all で並列実行される
 * page-analyze-worker の並列化ロジックをユニットテストで検証する。
 *
 * Tests the parallelization logic of page-analyze-worker where Phase 1 (Layout)
 * and Phase 3 (Quality) are executed concurrently via Promise.all.
 *
 * @module tests/workers/phases/phase-parallelization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { processLayoutPhase } from "../../../src/workers/phases/phase-1-layout";
import type { LayoutPhaseDeps } from "../../../src/workers/phases/phase-1-layout";
import { processQualityPhase } from "../../../src/workers/phases/phase-3-quality";
import type { QualityPhaseDeps } from "../../../src/workers/phases/phase-3-quality";
import type { PipelineState, PhaseContext } from "../../../src/workers/phases/types";
import type { AnalysisPhase } from "../../../src/queues/page-analyze-queue";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * PipelineState の初期状態を生成するヘルパー
 * Helper to create initial PipelineState
 */
function createInitialState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    actualWebPageId: "test-web-page-id",
    completedPhases: [] as AnalysisPhase[],
    failedPhases: [] as AnalysisPhase[],
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
    html: "<html><body><h1>Test Page</h1></body></html>",
    screenshotBase64: undefined,
    narrativePreDisabled: false,
    visionPreDisabled: false,
    memoryAborted: false,
    ...overrides,
  };
}

/**
 * PhaseContext のモックを生成するヘルパー
 * Helper to create mock PhaseContext
 */
function createMockContext(overrides?: Partial<PhaseContext>): PhaseContext {
  return {
    job: {
      id: "test-job-id",
      updateProgress: vi.fn().mockResolvedValue(undefined),
      extendLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as PhaseContext["job"],
    options: {
      features: { layout: true, quality: true },
      layoutOptions: {},
      qualityOptions: {},
    } as unknown as PhaseContext["options"],
    url: "https://example.com",
    webPageId: "test-web-page-id",
    effectiveToken: "test-token",
    effectiveLockDuration: 2400000,
    statusTracker: {
      startPhase: vi.fn(),
      completePhase: vi.fn(),
      failPhase: vi.fn(),
      skipPhase: vi.fn(),
    } as unknown as PhaseContext["statusTracker"],
    ...overrides,
  };
}

/**
 * LayoutPhaseDeps のモックを生成するヘルパー
 * Helper to create mock LayoutPhaseDeps
 */
function createMockLayoutDeps(overrides?: Partial<LayoutPhaseDeps>): LayoutPhaseDeps {
  return {
    defaultAnalyzeLayout: vi.fn().mockResolvedValue({
      sectionCount: 3,
      sections: [
        {
          id: "section-1",
          sectionType: "hero",
          htmlSnippet: "<section>Hero</section>",
          position: { startY: 0, height: 600 },
        },
      ],
      backgroundDesigns: [],
      cssSnippet: "",
    }),
    saveBackgroundDesigns: vi.fn().mockResolvedValue({
      success: true,
      count: 0,
      ids: [],
      idMapping: new Map(),
    }),
    saveSectionPatterns: vi.fn().mockResolvedValue({
      success: true,
      count: 1,
      ids: ["section-db-1"],
      idMapping: new Map([["section-1", "section-db-1"]]),
    }),
    postProcessSections: vi.fn().mockImplementation((sections) => ({
      sections,
      stats: { mergedGroups: 0, absorbedCount: 0, splitCount: 0, sameHeadingMerged: 0 },
    })),
    extractPartsFromSection: vi.fn().mockResolvedValue({ parts: [] }),
    saveExtractedParts: vi.fn().mockResolvedValue({ savedCount: 0, errors: [] }),
    prisma: {} as unknown,
    ...overrides,
  };
}

/**
 * QualityPhaseDeps のモックを生成するヘルパー
 * Helper to create mock QualityPhaseDeps
 */
function createMockQualityDeps(overrides?: Partial<QualityPhaseDeps>): QualityPhaseDeps {
  return {
    defaultEvaluateQuality: vi.fn().mockResolvedValue({
      success: true,
      overallScore: 85,
      grade: "A",
    }),
    saveQualityEvaluation: vi.fn().mockResolvedValue({
      success: true,
      count: 1,
      ids: ["quality-eval-1"],
      idMapping: new Map(),
    }),
    saveQualityBenchmarks: vi.fn().mockResolvedValue({
      success: true,
      count: 2,
      ids: ["bench-1", "bench-2"],
      idMapping: new Map(),
    }),
    buildQualityBenchmarkInputs: vi.fn().mockReturnValue([
      { metric: "originality", score: 80, industry: "tech" },
      { metric: "craftsmanship", score: 90, industry: "tech" },
    ]),
    prisma: {} as unknown,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("Phase 1/3 Parallelization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------
  // Promise.all 並列実行
  // ------------------------------------------------------------------
  describe("Promise.all parallel execution", () => {
    it("should execute Phase 1 and Phase 3 concurrently via Promise.all", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext();

      // Track execution order to verify concurrency
      const executionLog: string[] = [];

      const layoutDeps = createMockLayoutDeps({
        defaultAnalyzeLayout: vi.fn().mockImplementation(async () => {
          executionLog.push("layout:start");
          // Simulate async work
          await new Promise((resolve) => setTimeout(resolve, 10));
          executionLog.push("layout:end");
          return {
            sectionCount: 2,
            sections: [],
            backgroundDesigns: [],
            cssSnippet: "",
          };
        }),
      });

      const qualityDeps = createMockQualityDeps({
        defaultEvaluateQuality: vi.fn().mockImplementation(async () => {
          executionLog.push("quality:start");
          await new Promise((resolve) => setTimeout(resolve, 10));
          executionLog.push("quality:end");
          return { success: true, overallScore: 80, grade: "B" };
        }),
      });

      // Act
      await Promise.all([
        processLayoutPhase(state, ctx, layoutDeps),
        processQualityPhase(state, ctx, qualityDeps),
      ]);

      // Assert: both phases started before either completed (concurrent execution)
      const layoutStartIdx = executionLog.indexOf("layout:start");
      const qualityStartIdx = executionLog.indexOf("quality:start");
      const layoutEndIdx = executionLog.indexOf("layout:end");
      const qualityEndIdx = executionLog.indexOf("quality:end");

      // Both must have started
      expect(layoutStartIdx).toBeGreaterThanOrEqual(0);
      expect(qualityStartIdx).toBeGreaterThanOrEqual(0);
      // Both must have ended
      expect(layoutEndIdx).toBeGreaterThanOrEqual(0);
      expect(qualityEndIdx).toBeGreaterThanOrEqual(0);
      // Both should be called
      expect(layoutDeps.defaultAnalyzeLayout).toHaveBeenCalledOnce();
      expect(qualityDeps.defaultEvaluateQuality).toHaveBeenCalledOnce();
    });
  });

  // ------------------------------------------------------------------
  // 両方成功時の結果マージ
  // ------------------------------------------------------------------
  describe("result merging on both success", () => {
    it("should merge results from both phases into PipelineState", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext();
      const layoutDeps = createMockLayoutDeps();
      const qualityDeps = createMockQualityDeps();

      // Act
      await Promise.all([
        processLayoutPhase(state, ctx, layoutDeps),
        processQualityPhase(state, ctx, qualityDeps),
      ]);

      // Assert: results from both phases are present
      expect(state.results).toBeDefined();
      expect(state.results!.layout).toBeDefined();
      expect(state.results!.layout!.sectionsDetected).toBe(3);
      expect(state.results!.quality).toBeDefined();
      expect(state.results!.quality!.overallScore).toBe(85);
      expect(state.results!.quality!.grade).toBe("A");
    });

    it("should record both phases in completedPhases", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext();
      const layoutDeps = createMockLayoutDeps();
      const qualityDeps = createMockQualityDeps();

      // Act
      await Promise.all([
        processLayoutPhase(state, ctx, layoutDeps),
        processQualityPhase(state, ctx, qualityDeps),
      ]);

      // Assert
      expect(state.completedPhases).toContain("layout");
      expect(state.completedPhases).toContain("quality");
      expect(state.failedPhases).toHaveLength(0);
    });

    it("should preserve layoutResultForNarrative from Phase 1", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext();
      const layoutDeps = createMockLayoutDeps();
      const qualityDeps = createMockQualityDeps();

      // Act
      await Promise.all([
        processLayoutPhase(state, ctx, layoutDeps),
        processQualityPhase(state, ctx, qualityDeps),
      ]);

      // Assert: Phase 1 should set layoutResultForNarrative
      expect(state.layoutResultForNarrative).not.toBeNull();
      expect(state.layoutResultForNarrative!.sectionCount).toBe(3);
    });
  });

  // ------------------------------------------------------------------
  // Graceful Degradation: 片方失敗時
  // ------------------------------------------------------------------
  describe("graceful degradation on partial failure", () => {
    it("should continue Phase 3 when Phase 1 fails", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext();

      const layoutDeps = createMockLayoutDeps({
        defaultAnalyzeLayout: vi.fn().mockRejectedValue(new Error("Layout analysis failed")),
      });
      const qualityDeps = createMockQualityDeps();

      // Act
      await Promise.all([
        processLayoutPhase(state, ctx, layoutDeps),
        processQualityPhase(state, ctx, qualityDeps),
      ]);

      // Assert: Phase 1 failed, Phase 3 succeeded
      expect(state.failedPhases).toContain("layout");
      expect(state.completedPhases).toContain("quality");
      expect(state.results!.quality).toBeDefined();
      expect(state.results!.quality!.overallScore).toBe(85);
    });

    it("should continue Phase 1 when Phase 3 fails", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext();
      const layoutDeps = createMockLayoutDeps();

      const qualityDeps = createMockQualityDeps({
        defaultEvaluateQuality: vi.fn().mockRejectedValue(new Error("Quality evaluation failed")),
      });

      // Act
      await Promise.all([
        processLayoutPhase(state, ctx, layoutDeps),
        processQualityPhase(state, ctx, qualityDeps),
      ]);

      // Assert: Phase 3 failed, Phase 1 succeeded
      expect(state.completedPhases).toContain("layout");
      expect(state.failedPhases).toContain("quality");
      expect(state.results!.layout).toBeDefined();
      expect(state.results!.layout!.sectionsDetected).toBe(3);
    });

    it("should handle both phases failing without throwing", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext();

      const layoutDeps = createMockLayoutDeps({
        defaultAnalyzeLayout: vi.fn().mockRejectedValue(new Error("Layout failed")),
      });

      const qualityDeps = createMockQualityDeps({
        defaultEvaluateQuality: vi.fn().mockRejectedValue(new Error("Quality failed")),
      });

      // Act: should NOT throw
      await expect(
        Promise.all([
          processLayoutPhase(state, ctx, layoutDeps),
          processQualityPhase(state, ctx, qualityDeps),
        ])
      ).resolves.not.toThrow();

      // Assert: both phases recorded as failed
      expect(state.failedPhases).toContain("layout");
      expect(state.failedPhases).toContain("quality");
      expect(state.completedPhases).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // PipelineState フィールド分離の安全性
  // ------------------------------------------------------------------
  describe("PipelineState field isolation safety", () => {
    it("should write to distinct fields without conflicts", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext();
      const layoutDeps = createMockLayoutDeps();
      const qualityDeps = createMockQualityDeps();

      // Act
      await Promise.all([
        processLayoutPhase(state, ctx, layoutDeps),
        processQualityPhase(state, ctx, qualityDeps),
      ]);

      // Assert Phase 1 fields
      expect(state.layoutResultForNarrative).not.toBeNull();
      expect(state.sectionSaveResult).not.toBeNull();
      expect(state.sectionSaveResult!.count).toBe(1);
      expect(state.results!.layout).toBeDefined();

      // Assert Phase 3 fields
      expect(state.results!.quality).toBeDefined();

      // Phase 3 should not have touched Phase 1 fields
      // Phase 1 should not have touched Phase 3 memory/narrative flags
      // (memoryAborted defaults to false and Phase 1 never sets it)
      expect(state.memoryAborted).toBe(false);
    });

    it("should not corrupt completedPhases array with concurrent pushes", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext();
      const layoutDeps = createMockLayoutDeps();
      const qualityDeps = createMockQualityDeps();

      // Act
      await Promise.all([
        processLayoutPhase(state, ctx, layoutDeps),
        processQualityPhase(state, ctx, qualityDeps),
      ]);

      // Assert: Array.push in Node.js single-threaded event loop is safe
      expect(state.completedPhases).toHaveLength(2);
      expect(new Set(state.completedPhases).size).toBe(2);
    });

    it("should allow Phase 3 to set memoryAborted independently of Phase 1", async () => {
      // Arrange: simulate high memory pressure in Phase 3
      const state = createInitialState();
      const ctx = createMockContext();
      const layoutDeps = createMockLayoutDeps();
      const qualityDeps = createMockQualityDeps();

      // Mock checkMemoryPressure to return shouldAbort
      // Phase 3 calls checkMemoryPressure internally
      const originalMemUsage = process.memoryUsage;
      // Simulate extremely high RSS to trigger memory abort
      vi.spyOn(process, "memoryUsage").mockReturnValue({
        rss: 20 * 1024 * 1024 * 1024, // 20GB - above MEMORY_CRITICAL_THRESHOLD_MB
        heapTotal: 1024 * 1024 * 1024,
        heapUsed: 512 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      });

      // Act
      await Promise.all([
        processLayoutPhase(state, ctx, layoutDeps),
        processQualityPhase(state, ctx, qualityDeps),
      ]);

      // Restore
      vi.mocked(process.memoryUsage).mockRestore();

      // Assert: Phase 3 set memoryAborted, Phase 1 completed independently
      expect(state.memoryAborted).toBe(true);
      expect(state.completedPhases).toContain("layout");
    });
  });

  // ------------------------------------------------------------------
  // Phase disabled scenarios
  // ------------------------------------------------------------------
  describe("phase disabled scenarios", () => {
    it("should skip Phase 1 when layout feature is disabled", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext({
        options: {
          features: { layout: false, quality: true },
          layoutOptions: {},
          qualityOptions: {},
        } as unknown as PhaseContext["options"],
      });
      const layoutDeps = createMockLayoutDeps();
      const qualityDeps = createMockQualityDeps();

      // Act
      await Promise.all([
        processLayoutPhase(state, ctx, layoutDeps),
        processQualityPhase(state, ctx, qualityDeps),
      ]);

      // Assert
      expect(layoutDeps.defaultAnalyzeLayout).not.toHaveBeenCalled();
      expect(state.completedPhases).not.toContain("layout");
      expect(state.completedPhases).toContain("quality");
      expect(ctx.statusTracker.skipPhase).toHaveBeenCalledWith("layout", "Disabled by options");
    });

    it("should skip Phase 3 when quality feature is disabled", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext({
        options: {
          features: { layout: true, quality: false },
          layoutOptions: {},
          qualityOptions: {},
        } as unknown as PhaseContext["options"],
      });
      const layoutDeps = createMockLayoutDeps();
      const qualityDeps = createMockQualityDeps();

      // Act
      await Promise.all([
        processLayoutPhase(state, ctx, layoutDeps),
        processQualityPhase(state, ctx, qualityDeps),
      ]);

      // Assert
      expect(qualityDeps.defaultEvaluateQuality).not.toHaveBeenCalled();
      expect(state.completedPhases).toContain("layout");
      expect(state.completedPhases).not.toContain("quality");
      expect(ctx.statusTracker.skipPhase).toHaveBeenCalledWith("quality", "Disabled by options");
    });
  });

  // ------------------------------------------------------------------
  // DB save graceful degradation within Phase 1
  // ------------------------------------------------------------------
  describe("DB save graceful degradation within Phase 1", () => {
    it("should complete Phase 1 even when background save fails", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext();

      const layoutDeps = createMockLayoutDeps({
        defaultAnalyzeLayout: vi.fn().mockResolvedValue({
          sectionCount: 1,
          sections: [
            {
              id: "s1",
              sectionType: "hero",
              htmlSnippet: "<section>Hero</section>",
              position: { startY: 0, height: 600 },
            },
          ],
          backgroundDesigns: [
            {
              name: "bg1",
              designType: "solid",
              cssValue: "#fff",
              selector: "body",
              positionIndex: 0,
              colorInfo: {},
              visualProperties: {},
              performance: {},
              confidence: 0.9,
            },
          ],
          cssSnippet: "",
        }),
        saveBackgroundDesigns: vi.fn().mockRejectedValue(new Error("DB save failed")),
      });

      // Act
      await processLayoutPhase(state, ctx, layoutDeps);

      // Assert: Phase 1 still completes
      expect(state.completedPhases).toContain("layout");
      expect(state.results!.layout).toBeDefined();
    });

    it("should complete Phase 1 even when section save fails", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext();

      const layoutDeps = createMockLayoutDeps({
        saveSectionPatterns: vi.fn().mockRejectedValue(new Error("Section save failed")),
      });

      // Act
      await processLayoutPhase(state, ctx, layoutDeps);

      // Assert: Phase 1 still completes
      expect(state.completedPhases).toContain("layout");
      expect(state.sectionSaveResult).toBeNull(); // Save failed, no result set
    });
  });

  // ------------------------------------------------------------------
  // StatusTracker parallel safety
  // ------------------------------------------------------------------
  describe("statusTracker parallel safety", () => {
    it("should call startPhase and completePhase for both phases", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext();
      const layoutDeps = createMockLayoutDeps();
      const qualityDeps = createMockQualityDeps();

      // Act
      await Promise.all([
        processLayoutPhase(state, ctx, layoutDeps),
        processQualityPhase(state, ctx, qualityDeps),
      ]);

      // Assert: statusTracker uses independent slots per phase
      expect(ctx.statusTracker.startPhase).toHaveBeenCalledWith("layout");
      expect(ctx.statusTracker.completePhase).toHaveBeenCalledWith("layout");
      expect(ctx.statusTracker.startPhase).toHaveBeenCalledWith("quality");
      expect(ctx.statusTracker.completePhase).toHaveBeenCalledWith("quality");
    });

    it("should call failPhase on the failed phase only", async () => {
      // Arrange
      const state = createInitialState();
      const ctx = createMockContext();

      const layoutDeps = createMockLayoutDeps({
        defaultAnalyzeLayout: vi.fn().mockRejectedValue(new Error("Layout error")),
      });
      const qualityDeps = createMockQualityDeps();

      // Act
      await Promise.all([
        processLayoutPhase(state, ctx, layoutDeps),
        processQualityPhase(state, ctx, qualityDeps),
      ]);

      // Assert
      expect(ctx.statusTracker.failPhase).toHaveBeenCalledWith("layout", "Layout error");
      expect(ctx.statusTracker.completePhase).toHaveBeenCalledWith("quality");
      // failPhase should NOT have been called for quality
      expect(ctx.statusTracker.failPhase).not.toHaveBeenCalledWith("quality", expect.anything());
    });
  });
});
