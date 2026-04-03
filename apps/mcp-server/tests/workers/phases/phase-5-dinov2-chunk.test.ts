// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: DINOv2 Chunk Size Configuration Tests
 *
 * DINOV2_CHUNK_SIZEがinitMemoryConstants()で正しくprofile.dinov2ChunkSizeから
 * 取得・設定されることを検証する。
 *
 * Verifies that DINOV2_CHUNK_SIZE is correctly set from profile.dinov2ChunkSize
 * via initMemoryConstants().
 *
 * @module tests/workers/phases/phase-5-dinov2-chunk
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Mock Setup
// ============================================================================

// Keep a reference to the mock function so we can change return values per test
const mockResolveMemoryConfig = vi.fn();
const mockLogMemoryProfile = vi.fn();

vi.mock("../../../src/services/worker-memory-profile", () => ({
  resolveMemoryConfig: (...args: unknown[]): unknown => mockResolveMemoryConfig(...args),
  logMemoryProfile: (...args: unknown[]): unknown => mockLogMemoryProfile(...args),
}));

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

vi.mock("../../../src/services/worker-constants", () => ({
  DB_SAVED_PROGRESS_THRESHOLD: 90,
}));

vi.mock("../../../src/utils/blank-image-detector", () => ({
  isBlankImage: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../../src/utils/safe-parse-int", () => ({
  safeParseInt: (val: string | undefined, defaultVal: number, _opts?: unknown): number => {
    if (val === undefined || val === null) return defaultVal;
    const parsed = parseInt(val, 10);
    return Number.isFinite(parsed) ? parsed : defaultVal;
  },
}));

// ============================================================================
// Tests
// ============================================================================

describe("Phase 5: DINOv2 chunk size configuration", () => {
  beforeEach(() => {
    // Reset module state before each test to allow re-initialization
    vi.resetModules();
    mockResolveMemoryConfig.mockReset();
    mockLogMemoryProfile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DINOV2_CHUNK_SIZEがinitMemoryConstants()で正しく設定されること / should set DINOV2_CHUNK_SIZE from profile.dinov2ChunkSize via initMemoryConstants()", async () => {
    // Arrange: 32GB tier の dinov2ChunkSize=15 を返すようにモック
    mockResolveMemoryConfig.mockReturnValue({
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
    });

    // Dynamic import to get fresh module state
    const types = await import("../../../src/workers/phases/types");

    // Act
    types.initMemoryConstants();

    // Assert
    expect(types.DINOV2_CHUNK_SIZE).toBe(15);
  });

  it("16GB tierでdinov2ChunkSize=5が反映されること / should reflect dinov2ChunkSize=5 for 16GB tier", async () => {
    // Arrange: 16GB tier の dinov2ChunkSize=5 を返すようにモック
    mockResolveMemoryConfig.mockReturnValue({
      totalMemoryMb: 16384,
      degradationThresholdMb: 9830,
      criticalThresholdMb: 11468,
      selfExitThresholdMb: 11468,
      maxOldSpaceSizeMb: 8192,
      embeddingChunkSize: 15,
      jsAnimationEmbeddingChunkSize: 25,
      dinov2ChunkSize: 5,
      partExtractionEnabled: true,
      partExtractionRssLimit: 8 * 1024 * 1024 * 1024,
      tier: "16gb",
    });

    // Dynamic import to get fresh module state
    const types = await import("../../../src/workers/phases/types");

    // Act
    types.initMemoryConstants();

    // Assert
    expect(types.DINOV2_CHUNK_SIZE).toBe(5);
  });

  it("DINOV2_CHUNK_SIZEが0の場合のスキップ動作 / should handle DINOV2_CHUNK_SIZE=0 (visual embedding skip)", async () => {
    // Arrange: 8GB tier の dinov2ChunkSize=0 を返すようにモック（visual embeddingスキップ）
    mockResolveMemoryConfig.mockReturnValue({
      totalMemoryMb: 8192,
      degradationThresholdMb: 4915,
      criticalThresholdMb: 5734,
      selfExitThresholdMb: 5734,
      maxOldSpaceSizeMb: 4096,
      embeddingChunkSize: 8,
      jsAnimationEmbeddingChunkSize: 12,
      dinov2ChunkSize: 0,
      partExtractionEnabled: false,
      partExtractionRssLimit: 6 * 1024 * 1024 * 1024,
      tier: "8gb",
    });

    // Dynamic import to get fresh module state
    const types = await import("../../../src/workers/phases/types");

    // Act
    types.initMemoryConstants();

    // Assert: 0 はvisual embeddingをスキップすることを意味する
    expect(types.DINOV2_CHUNK_SIZE).toBe(0);
  });
});
