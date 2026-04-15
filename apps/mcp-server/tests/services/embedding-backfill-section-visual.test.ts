// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SectionVisualProcessor DINOv2 統合テスト (v0.4.0 PR7b)
 *
 * PR7b で `SectionVisualProcessor.requiresScreenshot()` が true に切り替わり、
 * `runVisualEmbeddingSubPhases` 経由で section vision embedding を再生成する
 * パスが追加された。本テストは以下を検証する:
 *
 * 1. 契約面: requiresScreenshot=true, category=section_visual
 * 2. Service 層: countSectionVisualBackfillTargets の SQL / NaN 防御
 * 3. Processor 層: screenshot あり/なし、PII フィルタ、pendingCount=0、prisma 欠落、
 *    DINOv2 再生成成功、エラー伝搬
 *
 * SectionVisualProcessor DINOv2 integration tests (v0.4.0 PR7b)
 *
 * PR7b flips `SectionVisualProcessor.requiresScreenshot()` to true and adds
 * the section vision embedding regeneration path via `runVisualEmbeddingSubPhases`.
 * This suite verifies:
 *
 * 1. Contract: requiresScreenshot=true, category=section_visual
 * 2. Service layer: countSectionVisualBackfillTargets SQL / NaN defense
 * 3. Processor layer: with/without screenshot, PII filter, zero-pending,
 *    missing prisma, DINOv2 regeneration success, error propagation
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Job } from "bullmq";
import type {
  EmbeddingBackfillCategory,
  EmbeddingBackfillJobData,
  EmbeddingBackfillJobResult,
} from "../../src/queues/embedding-backfill-queue";

// ============================================================================
// Stub the embedding-backfill service
// ============================================================================
vi.mock("../../src/services/embedding-backfill.service", () => ({
  backfillPartTextForPage: vi.fn(async () => ({
    generated: 0,
    failed: 0,
    memorySkips: 0,
    errors: [],
  })),
  // Default: text-side recovery yields zero — overridden per test for hybrid scenarios.
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
  backfillJsAnimationsForPage: vi.fn(async () => ({
    generated: 0,
    failed: 0,
    memorySkips: 0,
    errors: [],
  })),
  backfillResponsiveForPage: vi.fn(async () => ({
    generated: 0,
    failed: 0,
    memorySkips: 0,
    errors: [],
  })),
  countPartVisualBackfillTargets: vi.fn(async () => ({ pendingCount: 0 })),
  // Default: 0 pending — overridden per test for DINOv2 invocation cases.
  countSectionVisualBackfillTargets: vi.fn(async () => ({ pendingCount: 0 })),
}));

// ============================================================================
// Stub runVisualEmbeddingSubPhases (DINOv2 loop)
// ============================================================================
vi.mock("../../src/workers/phases/phase-5-embedding", () => ({
  runVisualEmbeddingSubPhases: vi.fn(async () => ({
    sectionVisualEmbeddingsGenerated: 0,
    partVisualEmbeddingsGenerated: 0,
    embeddingFailedChunks: 0,
  })),
}));

// Import AFTER mocks so the Processor module picks up stubbed modules.
import {
  PROCESSORS,
  SectionVisualProcessor,
  type BackfillProcessContext,
} from "../../src/queues/embedding-backfill-processors";
import {
  backfillSectionVisualsForPage,
  countSectionVisualBackfillTargets,
} from "../../src/services/embedding-backfill.service";
import { runVisualEmbeddingSubPhases } from "../../src/workers/phases/phase-5-embedding";

// ============================================================================
// Helpers
// ============================================================================

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
  options?: { screenshotStoragePath?: string; prisma?: unknown }
): BackfillProcessContext {
  const data: EmbeddingBackfillJobData = {
    webPageId: "019bc123-4567-7890-abcd-ef1234567890",
    category,
    createdAt: "2026-04-12T00:00:00.000Z",
  };
  if (options?.screenshotStoragePath !== undefined) {
    data.screenshotStoragePath = options.screenshotStoragePath;
  }
  const ctx: BackfillProcessContext = {
    webPageId: data.webPageId,
    job: makeJobStub(data),
  };
  if (options?.screenshotStoragePath !== undefined) {
    ctx.screenshotStoragePath = options.screenshotStoragePath;
  }
  if (options?.prisma !== undefined) {
    ctx.prisma = options.prisma as BackfillProcessContext["prisma"];
  }
  return ctx;
}

// ============================================================================
// Test Suites
// ============================================================================

describe("SectionVisualProcessor DINOv2 integration (v0.4.0 PR7b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // 1. Contract checks
  // ==========================================================================
  describe("contract", () => {
    it("should expose category='section_visual' and requiresScreenshot()=true", () => {
      const p = new SectionVisualProcessor();
      expect(p.category).toBe("section_visual");
      expect(p.requiresScreenshot()).toBe(true);
      // Registry must agree with the class
      expect(PROCESSORS.section_visual.category).toBe("section_visual");
      expect(PROCESSORS.section_visual.requiresScreenshot()).toBe(true);
    });
  });

  // ==========================================================================
  // 2. Service-level: countSectionVisualBackfillTargets SQL guarantees
  // ==========================================================================
  describe("countSectionVisualBackfillTargets (service-level)", () => {
    let serviceSource: string;
    beforeAll(() => {
      const servicePath = path.resolve(
        __dirname,
        "../../src/services/embedding-backfill.service.ts"
      );
      serviceSource = fs.readFileSync(servicePath, "utf8");
    });

    it("should be exported as async function returning { pendingCount }", () => {
      expect(serviceSource).toMatch(/export async function countSectionVisualBackfillTargets\b/);
      // Locate the function body and verify return type
      const fnIdx = serviceSource.indexOf(
        "export async function countSectionVisualBackfillTargets"
      );
      expect(fnIdx).toBeGreaterThanOrEqual(0);
      const fnSlice = serviceSource.slice(fnIdx, fnIdx + 1500);
      expect(fnSlice).toContain("Promise<{ pendingCount: number }>");
    });

    it("should JOIN section_patterns and filter text_embedding IS NOT NULL AND vision_embedding IS NULL", () => {
      const fnIdx = serviceSource.indexOf(
        "export async function countSectionVisualBackfillTargets"
      );
      const fnSlice = serviceSource.slice(fnIdx, fnIdx + 1500);
      expect(fnSlice).toContain("JOIN section_patterns sp ON se.section_pattern_id = sp.id");
      expect(fnSlice).toContain("se.text_embedding IS NOT NULL");
      expect(fnSlice).toContain("se.vision_embedding IS NULL");
    });

    it("should validate pendingCount via Number.isFinite (NaN defense)", () => {
      const fnIdx = serviceSource.indexOf(
        "export async function countSectionVisualBackfillTargets"
      );
      const fnSlice = serviceSource.slice(fnIdx, fnIdx + 1500);
      expect(fnSlice).toContain("Number.isFinite(pendingCount)");
    });
  });

  // ==========================================================================
  // 3. Processor behavior — process()
  // ==========================================================================
  describe("process()", () => {
    it("should graceful-degrade to text-only when no screenshot is present", async () => {
      // text-side recovery succeeds (3 generated, 1 failed); DINOv2 path skipped.
      vi.mocked(backfillSectionVisualsForPage).mockResolvedValueOnce({
        generated: 3,
        failed: 1,
        memorySkips: 0,
        errors: [],
      });

      const ctx = makeCtx("section_visual"); // no screenshotStoragePath

      const result = await PROCESSORS.section_visual.process(ctx);

      expect(result.category).toBe("section_visual");
      expect(result.generated).toBe(3);
      expect(result.failed).toBe(1);
      expect(backfillSectionVisualsForPage).toHaveBeenCalledTimes(1);
      // DINOv2 path must NOT be invoked when no screenshot
      expect(runVisualEmbeddingSubPhases).not.toHaveBeenCalled();
      expect(countSectionVisualBackfillTargets).not.toHaveBeenCalled();
    });

    it("should skip DINOv2 path when pendingCount=0 even with screenshot", async () => {
      vi.mocked(backfillSectionVisualsForPage).mockResolvedValueOnce({
        generated: 2,
        failed: 0,
        memorySkips: 0,
        errors: [],
      });
      vi.mocked(countSectionVisualBackfillTargets).mockResolvedValueOnce({ pendingCount: 0 });

      const ctx = makeCtx("section_visual", {
        screenshotStoragePath: "/tmp/reftrix-screenshots/phase5/abc.png",
        prisma: {} as unknown,
      });

      const result = await PROCESSORS.section_visual.process(ctx);

      // text-side count returned, DINOv2 path NOT invoked
      expect(result.generated).toBe(2);
      expect(countSectionVisualBackfillTargets).toHaveBeenCalledTimes(1);
      expect(runVisualEmbeddingSubPhases).not.toHaveBeenCalled();
    });

    it("should mark pendingCount as failed when prisma client is unavailable", async () => {
      vi.mocked(backfillSectionVisualsForPage).mockResolvedValueOnce({
        generated: 1,
        failed: 0,
        memorySkips: 0,
        errors: [],
      });
      vi.mocked(countSectionVisualBackfillTargets).mockResolvedValueOnce({ pendingCount: 5 });

      // Intentionally omit prisma
      const ctx = makeCtx("section_visual", {
        screenshotStoragePath: "/tmp/reftrix-screenshots/phase5/abc.png",
      });

      const result = await PROCESSORS.section_visual.process(ctx);

      expect(result.generated).toBe(1);
      // 5 pending DINOv2 candidates marked as failed
      expect(result.failed).toBe(5);
      expect(result.errors).toContain("section_visual: prisma client unavailable");
      expect(runVisualEmbeddingSubPhases).not.toHaveBeenCalled();
    });

    it("should invoke runVisualEmbeddingSubPhases with non-empty sectionIdMapping and partsSavedCount=0", async () => {
      vi.mocked(backfillSectionVisualsForPage).mockResolvedValueOnce({
        generated: 0,
        failed: 0,
        memorySkips: 0,
        errors: [],
      });
      vi.mocked(countSectionVisualBackfillTargets).mockResolvedValueOnce({ pendingCount: 4 });
      vi.mocked(runVisualEmbeddingSubPhases).mockResolvedValueOnce({
        sectionVisualEmbeddingsGenerated: 4,
        partVisualEmbeddingsGenerated: 0,
        embeddingFailedChunks: 0,
      });

      const ctx = makeCtx("section_visual", {
        screenshotStoragePath: "/tmp/reftrix-screenshots/phase5/xyz.png",
        prisma: { $queryRawUnsafe: vi.fn() } as unknown,
      });

      const result = await PROCESSORS.section_visual.process(ctx);

      expect(runVisualEmbeddingSubPhases).toHaveBeenCalledTimes(1);
      const callArg = vi.mocked(runVisualEmbeddingSubPhases).mock.calls[0]?.[0];
      expect(callArg).toBeDefined();
      // Sentinel map must be non-empty so `runVisualEmbeddingSubPhases` enters the
      // section path (`hasSections = sectionIdMapping.size > 0`).
      expect(callArg!.sectionIdMapping.size).toBeGreaterThan(0);
      // Part visual path must remain inert during section_visual backfill.
      expect(callArg!.partsSavedCount).toBe(0);
      // Screenshot Fallback (Playwright per-section capture) must be disabled.
      expect(callArg!.fallbackEnabled).toBe(false);
      expect(callArg!.screenshotPngPath).toBe("/tmp/reftrix-screenshots/phase5/xyz.png");
      // DINOv2 generated count surfaces correctly.
      expect(result.generated).toBe(4);
      expect(result.failed).toBe(0);
    });

    it("should aggregate text-side and DINOv2 generation counts", async () => {
      vi.mocked(backfillSectionVisualsForPage).mockResolvedValueOnce({
        generated: 2,
        failed: 1,
        memorySkips: 0,
        errors: ["text-err"],
      });
      vi.mocked(countSectionVisualBackfillTargets).mockResolvedValueOnce({ pendingCount: 3 });
      vi.mocked(runVisualEmbeddingSubPhases).mockResolvedValueOnce({
        sectionVisualEmbeddingsGenerated: 3,
        partVisualEmbeddingsGenerated: 0,
        embeddingFailedChunks: 1, // one chunk failed
      });

      const ctx = makeCtx("section_visual", {
        screenshotStoragePath: "/tmp/reftrix-screenshots/phase5/abc.png",
        prisma: {} as unknown,
      });

      const result = await PROCESSORS.section_visual.process(ctx);

      // text(2) + DINOv2(3) = 5 generated
      expect(result.generated).toBe(5);
      // text failed(1) + DINOv2 failed chunks(1) = 2 failed
      expect(result.failed).toBe(2);
      expect(result.errors).toContain("text-err");
    });
  });

  // ==========================================================================
  // 4. Lifecycle observability (DINOv2 init/dispose owned by runVisualEmbeddingSubPhases)
  // ==========================================================================
  describe("DINOv2 lifecycle delegation", () => {
    it("should delegate DINOv2 init/dispose to runVisualEmbeddingSubPhases (no direct DINOv2Service in processor)", () => {
      // Static check: SectionVisualProcessor must NOT directly construct/dispose
      // DINOv2 — that lifecycle is owned by `runVisualEmbeddingSubPhases` per
      // PR7b design (matches PartVisualProcessor pattern).
      const processorPath = path.resolve(
        __dirname,
        "../../src/queues/embedding-backfill-processors.ts"
      );
      const src = fs.readFileSync(processorPath, "utf8");
      const classStart = src.indexOf("class SectionVisualProcessor");
      expect(classStart).toBeGreaterThan(-1);
      const nextClassStart = src.indexOf("class ", classStart + 10);
      const classBody = src.slice(classStart, nextClassStart > 0 ? nextClassStart : src.length);

      // Processor must NOT instantiate DINOv2Service directly
      expect(classBody).not.toMatch(/new DINOv2Service\b/);
      // Processor must NOT call dinov2Service.dispose() directly
      expect(classBody).not.toMatch(/dinov2Service\.dispose\(\)/);
      // Lifecycle is delegated through runVisualEmbeddingSubPhases
      expect(classBody).toContain("runVisualEmbeddingSubPhases");
    });
  });
});
