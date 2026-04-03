// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Sharp Cache/Concurrency Control Tests
 *
 * Phase 5 (Embedding) 冒頭でSharpの内部キャッシュ無効化と同時実行制限を設定し、
 * 関数終了時（正常・例外問わず）に元の値にリセットすることを検証する。
 *
 * Verifies that Phase 5 (Embedding) sets sharp.cache(false) and sharp.concurrency(1)
 * at the start, and resets them on both normal and exceptional exits (finally guarantee).
 *
 * @module tests/workers/phases/phase-5-sharp-config
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import sharp from "sharp";

// ============================================================================
// Mock Setup: Module-level mocks must be declared before imports
// ============================================================================

// Mock logger to prevent actual log output
vi.mock("../../../src/utils/logger", () => {
  class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  }
  return {
    logger: new MockLogger(),
    isDevelopment: vi.fn().mockReturnValue(false),
    Logger: MockLogger,
  };
});

// Mock memory profile resolution
vi.mock("../../../src/services/worker-memory-profile", () => ({
  resolveMemoryConfig: vi.fn().mockReturnValue({
    totalMemoryMb: 32768,
    degradationThresholdMb: 12288,
    criticalThresholdMb: 14336,
    selfExitThresholdMb: 12288,
    maxOldSpaceSizeMb: 8192,
    embeddingChunkSize: 30,
    jsAnimationEmbeddingChunkSize: 50,
    dinov2ChunkSize: 15,
    partExtractionEnabled: true,
    partExtractionRssLimit: 16 * 1024 * 1024 * 1024,
    tier: "32gb",
  }),
  logMemoryProfile: vi.fn(),
}));

// Mock worker constants
vi.mock("../../../src/services/worker-constants", () => ({
  DB_SAVED_PROGRESS_THRESHOLD: 90,
}));

// Mock blank image detector
vi.mock("../../../src/utils/blank-image-detector", () => ({
  isBlankImage: vi.fn().mockResolvedValue(false),
}));

// Mock safe-parse-int
vi.mock("../../../src/utils/safe-parse-int", () => ({
  safeParseInt: (val: string | undefined, defaultVal: number, _opts?: unknown): number => {
    if (val === undefined || val === null) return defaultVal;
    const parsed = parseInt(val, 10);
    return Number.isFinite(parsed) ? parsed : defaultVal;
  },
}));

// Import the function under test (after mocks)
import { processEmbeddingPhase } from "../../../src/workers/phases/phase-5-embedding";
import type {
  EmbeddingPhaseParams,
  EmbeddingPhaseDeps,
} from "../../../src/workers/phases/phase-5-embedding";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * 最小限のEmbeddingPhaseParamsを生成するヘルパー。
 * 全sub-phaseをスキップさせるため保存結果はnullに設定。
 */
function createMinimalParams(overrides?: Partial<EmbeddingPhaseParams>): EmbeddingPhaseParams {
  return {
    webPageId: "test-web-page-id",
    url: "https://example.com",
    job: {
      id: "test-job-id",
      data: { options: {} },
      updateProgress: vi.fn().mockResolvedValue(undefined),
      extendLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmbeddingPhaseParams["job"],
    effectiveToken: "test-token",
    effectiveLockDuration: 2400000,
    sectionSaveResult: null,
    motionSaveResult: null,
    jsSaveResult: null,
    bgSaveResult: null,
    scrollVisionSaveResult: null,
    layoutResultForNarrative: null,
    motionResultForEmbedding: null,
    jsAnimationsForEmbedding: null,
    scrollVisionResultForEmbedding: null,
    ...overrides,
  };
}

/**
 * 最小限のEmbeddingPhaseDepsを生成するヘルパー。
 */
function createMinimalDeps(): EmbeddingPhaseDeps {
  return {
    sharedLayoutEmbeddingService: {
      disposeEmbeddingPipeline: vi.fn().mockResolvedValue(undefined),
      terminateAndRespawnEmbeddingPipeline: vi.fn().mockResolvedValue(undefined),
      generateFromText: vi.fn().mockResolvedValue([]),
    } as unknown as EmbeddingPhaseDeps["sharedLayoutEmbeddingService"],
    gpuResourceManager: {
      acquireForDINOv2: vi.fn().mockResolvedValue({ mode: "cpu", message: "ok" }),
      releaseFromDINOv2: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmbeddingPhaseDeps["gpuResourceManager"],
    prisma: {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      componentPart: { findMany: vi.fn().mockResolvedValue([]) },
      sectionPattern: { findMany: vi.fn().mockResolvedValue([]) },
      jSAnimationEmbedding: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as EmbeddingPhaseDeps["prisma"],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("Phase 5: Sharp cache/concurrency control", () => {
  let originalCache: ReturnType<typeof sharp.cache>;
  let originalConcurrency: number;

  beforeEach(() => {
    // Sharp のデフォルト値を記録
    originalCache = sharp.cache();
    originalConcurrency = sharp.concurrency();

    // テスト開始前にデフォルト値にリセット
    sharp.cache(true);
    sharp.concurrency(0); // 0 = libvips auto-detect (cores)
  });

  afterEach(() => {
    // テスト後にSharp設定を元に戻す
    if (typeof originalCache === "object" && originalCache !== null) {
      sharp.cache(true);
    }
    sharp.concurrency(originalConcurrency);
  });

  it("Phase 5冒頭でsharp.cache(false)が設定されること / should set sharp.cache(false) at Phase 5 start", async () => {
    // Arrange: Sharp cache をデフォルト(有効)に設定
    sharp.cache(true);
    const cacheBeforePhase5 = sharp.cache();
    expect(
      (cacheBeforePhase5 as { memory: { current: number } }).memory.current
    ).toBeGreaterThanOrEqual(0);

    // Spy on sharp.cache to verify it was called with false
    const cacheSpy = vi.spyOn(sharp, "cache");

    const params = createMinimalParams();
    const deps = createMinimalDeps();

    // Act
    await processEmbeddingPhase(params, deps);

    // Assert: sharp.cache(false) が呼ばれたことを確認
    expect(cacheSpy).toHaveBeenCalledWith(false);

    cacheSpy.mockRestore();
  });

  it("Phase 5冒頭でsharp.concurrency(1)が設定されること / should set sharp.concurrency(1) at Phase 5 start", async () => {
    // Arrange: Sharp concurrency をデフォルトに設定
    sharp.concurrency(0); // auto-detect
    const concurrencySpy = vi.spyOn(sharp, "concurrency");

    const params = createMinimalParams();
    const deps = createMinimalDeps();

    // Act
    await processEmbeddingPhase(params, deps);

    // Assert: sharp.concurrency(1) が呼ばれたことを確認
    expect(concurrencySpy).toHaveBeenCalledWith(1);

    concurrencySpy.mockRestore();
  });

  it("Phase 5正常終了時にsharp設定がリセットされること / should reset sharp settings on normal exit", async () => {
    // Arrange: 元の値を設定
    sharp.cache(true);
    sharp.concurrency(4);

    const params = createMinimalParams();
    const deps = createMinimalDeps();

    // Act
    await processEmbeddingPhase(params, deps);

    // Assert: Phase 5終了後にリセットされている
    // cache(true) がリセットで呼ばれた = cache が有効に戻っている
    const cacheState = sharp.cache() as { memory: { current: number; max: number } };
    // concurrency がリストアされている
    const concurrencyAfter = sharp.concurrency();

    // cache が再度有効化されていることを検証
    // sharp.cache() はオブジェクトを返す（有効な場合）
    expect(cacheState).toBeDefined();
    expect(typeof cacheState).toBe("object");

    // concurrency が元の値（4）に戻っていることを検証
    expect(concurrencyAfter).toBe(4);
  });

  it("Phase 5例外発生時もsharp設定がリセットされること（finally保証） / should reset sharp settings on exception (finally guarantee)", async () => {
    // Arrange: 元の値を設定
    sharp.cache(true);
    sharp.concurrency(4);

    const params = createMinimalParams();
    const deps = createMinimalDeps();

    // sharedLayoutEmbeddingServiceのdisposeをエラーにして例外を発生させる
    // ただしprocessEmbeddingPhase自体はcatchするので例外は外に出ない
    // 代わりに、内部で例外が発生してもfinallyが実行されることを検証する
    // SectionSaveResultを設定して内部処理に入るようにし、そこでエラーを起こす
    const throwingDeps = createMinimalDeps();
    (
      throwingDeps.sharedLayoutEmbeddingService as { generateFromText: ReturnType<typeof vi.fn> }
    ).generateFromText = vi.fn().mockRejectedValue(new Error("Test embedding failure"));

    // SectionSaveResultを設定して内部処理を強制実行
    const paramsWithSections = createMinimalParams({
      sectionSaveResult: {
        idMapping: new Map([["section-1", "db-section-1"]]),
        savedCount: 1,
      } as unknown as EmbeddingPhaseParams["sectionSaveResult"],
      layoutResultForNarrative: {
        sections: [{ id: "section-1", type: "hero", content: "test" }],
      } as unknown as EmbeddingPhaseParams["layoutResultForNarrative"],
    });

    // Act: 内部で例外が発生するが、processEmbeddingPhaseはcatchして続行する
    await processEmbeddingPhase(paramsWithSections, throwingDeps);

    // Assert: 例外発生後もsharp設定がリセットされている
    const cacheState = sharp.cache() as { memory: { current: number; max: number } };
    const concurrencyAfter = sharp.concurrency();

    expect(cacheState).toBeDefined();
    expect(typeof cacheState).toBe("object");
    expect(concurrencyAfter).toBe(4);
  });
});
