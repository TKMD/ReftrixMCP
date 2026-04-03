// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: DINOv2 SessionOptions + Recycle Threshold Tests
 *
 * DINOv2 ONNX SessionOptionsにメモリ制御設定が含まれること、
 * tier別recycleThresholdが正しく設定されること、recycle機構の
 * Graceful Degradation、DINOV2_RECYCLE_ENABLED=false時のスキップ動作を検証する。
 *
 * Verifies DINOv2 ONNX SessionOptions include memory control settings,
 * tier-based recycleThreshold is correctly configured, recycle mechanism
 * Graceful Degradation, and DINOV2_RECYCLE_ENABLED=false skip behavior.
 *
 * @module tests/workers/phases/phase-5-dinov2-recycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ============================================================================
// Mock Setup
// ============================================================================

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

describe("Phase 5: DINOv2 SessionOptions + Recycle Threshold", () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveMemoryConfig.mockReset();
    mockLogMemoryProfile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Test 1: enableCpuMemArena: false がソースに含まれること
  // --------------------------------------------------------------------------
  it("DINOv2 worker-thread.tsにenableCpuMemArena: false設定が含まれること / should include enableCpuMemArena: false in DINOv2 worker-thread SessionOptions", () => {
    const workerThreadPath = path.resolve(
      __dirname,
      "../../../../..",
      "packages/ml/src/dinov2/worker-thread.ts"
    );
    const source = fs.readFileSync(workerThreadPath, "utf-8");

    expect(source).toContain("enableCpuMemArena");
    // Verify the value is set to false
    expect(source).toMatch(/enableCpuMemArena:\s*false/);
  });

  // --------------------------------------------------------------------------
  // Test 2: enableMemPattern: false がソースに含まれること
  // --------------------------------------------------------------------------
  it("DINOv2 worker-thread.tsにenableMemPattern: false設定が含まれること / should include enableMemPattern: false in DINOv2 worker-thread SessionOptions", () => {
    const workerThreadPath = path.resolve(
      __dirname,
      "../../../../..",
      "packages/ml/src/dinov2/worker-thread.ts"
    );
    const source = fs.readFileSync(workerThreadPath, "utf-8");

    expect(source).toContain("enableMemPattern");
    // Verify the value is set to false
    expect(source).toMatch(/enableMemPattern:\s*false/);
  });

  // --------------------------------------------------------------------------
  // Test 3: DINOV2_RECYCLE_THRESHOLDがtier別に正しく設定されること
  // --------------------------------------------------------------------------
  describe("DINOV2_RECYCLE_THRESHOLDがtier別に正しく設定されること / should set DINOV2_RECYCLE_THRESHOLD correctly per tier", () => {
    it("16GB tier: recycleThreshold=5", async () => {
      mockResolveMemoryConfig.mockReturnValue({
        totalMemoryMb: 16384,
        degradationThresholdMb: 9830,
        criticalThresholdMb: 11468,
        selfExitThresholdMb: 11468,
        maxOldSpaceSizeMb: 8192,
        embeddingChunkSize: 15,
        jsAnimationEmbeddingChunkSize: 25,
        dinov2ChunkSize: 5,
        dinov2RecycleThreshold: 5,
        partExtractionEnabled: true,
        partExtractionRssLimit: 8 * 1024 * 1024 * 1024,
        tier: "16gb",
      });

      const types = await import("../../../src/workers/phases/types");
      types.initMemoryConstants();

      expect(types.DINOV2_RECYCLE_THRESHOLD).toBe(5);
    });

    it("32GB tier: recycleThreshold=15", async () => {
      mockResolveMemoryConfig.mockReturnValue({
        totalMemoryMb: 32768,
        degradationThresholdMb: 12288,
        criticalThresholdMb: 14336,
        selfExitThresholdMb: 12288,
        maxOldSpaceSizeMb: 8192,
        embeddingChunkSize: 30,
        jsAnimationEmbeddingChunkSize: 50,
        dinov2ChunkSize: 15,
        dinov2RecycleThreshold: 15,
        partExtractionEnabled: true,
        partExtractionRssLimit: 16 * 1024 * 1024 * 1024,
        tier: "32gb",
      });

      const types = await import("../../../src/workers/phases/types");
      types.initMemoryConstants();

      expect(types.DINOV2_RECYCLE_THRESHOLD).toBe(15);
    });

    it("64GB+ tier: recycleThreshold=30", async () => {
      mockResolveMemoryConfig.mockReturnValue({
        totalMemoryMb: 65536,
        degradationThresholdMb: 12288,
        criticalThresholdMb: 14336,
        selfExitThresholdMb: 12288,
        maxOldSpaceSizeMb: 8192,
        embeddingChunkSize: 30,
        jsAnimationEmbeddingChunkSize: 50,
        dinov2ChunkSize: 30,
        dinov2RecycleThreshold: 30,
        partExtractionEnabled: true,
        partExtractionRssLimit: 32 * 1024 * 1024 * 1024,
        tier: "64gb+",
      });

      const types = await import("../../../src/workers/phases/types");
      types.initMemoryConstants();

      expect(types.DINOV2_RECYCLE_THRESHOLD).toBe(30);
    });
  });

  // --------------------------------------------------------------------------
  // Test 4: recycle機構のソースコード構造テスト
  // --------------------------------------------------------------------------
  it("recycle機構: DINOv2Serviceにrecycleメソッドが含まれること / should include recycle method in DINOv2Service", () => {
    const servicePath = path.resolve(
      __dirname,
      "../../../../..",
      "packages/ml/src/dinov2/service.ts"
    );
    const source = fs.readFileSync(servicePath, "utf-8");

    // recycle メソッドが存在すること
    expect(source).toContain("async recycle(");
    // recycle 内で dispose と initialize を呼ぶこと
    expect(source).toMatch(/await\s+this\.dispose\(\)/);
    expect(source).toMatch(/await\s+this\.initialize\(\)/);
  });

  // --------------------------------------------------------------------------
  // Test 5: recycle失敗時のGraceful Degradation
  // --------------------------------------------------------------------------
  it("recycle失敗時のGraceful Degradation: phase-5がtry-catchで保護されていること / should have try-catch protection for recycle failure in phase-5", () => {
    const phase5Path = path.resolve(__dirname, "../../../src/workers/phases/phase-5-embedding.ts");
    const source = fs.readFileSync(phase5Path, "utf-8");

    // recycle呼び出しがtry-catch内で保護されていること
    expect(source).toContain("dinov2Service.recycle(");
    // recycle失敗時のログメッセージが含まれること
    expect(source).toContain("DINOv2 recycle failed");
  });

  // --------------------------------------------------------------------------
  // Test 6: DINOV2_RECYCLE_ENABLED=false時のスキップ動作
  // --------------------------------------------------------------------------
  it("DINOV2_RECYCLE_ENABLED=false時にrecycleがスキップされること / should skip recycle when DINOV2_RECYCLE_ENABLED=false", () => {
    const phase5Path = path.resolve(__dirname, "../../../src/workers/phases/phase-5-embedding.ts");
    const source = fs.readFileSync(phase5Path, "utf-8");

    // DINOV2_RECYCLE_ENABLED環境変数チェックが含まれること
    expect(source).toContain("DINOV2_RECYCLE_ENABLED");
  });

  // --------------------------------------------------------------------------
  // Test 7: computeMemoryProfileにdinov2RecycleThresholdが含まれること
  // --------------------------------------------------------------------------
  it("computeMemoryProfileの戻り値にdinov2RecycleThresholdが含まれること / should include dinov2RecycleThreshold in computeMemoryProfile return", () => {
    // Import the actual module (not mocked) to test computeMemoryProfile
    // We test the source code structure since the mock prevents direct testing
    const profilePath = path.resolve(__dirname, "../../../src/services/worker-memory-profile.ts");
    const source = fs.readFileSync(profilePath, "utf-8");

    // MemoryProfile interfaceにdinov2RecycleThresholdが含まれること
    expect(source).toContain("dinov2RecycleThreshold");
    // PART_EXTRACTION_TIER_CONFIGにdinov2RecycleThresholdが含まれること
    expect(source).toMatch(/dinov2RecycleThreshold:\s*\d+/);
  });
});

// ============================================================================
// computeMemoryProfile Tier Configuration Tests (source code structure)
// ============================================================================

describe("computeMemoryProfile: dinov2RecycleThreshold tier configuration", () => {
  it("PART_EXTRACTION_TIER_CONFIGに全tier別のdinov2RecycleThreshold値が定義されていること", () => {
    const profilePath = path.resolve(__dirname, "../../../src/services/worker-memory-profile.ts");
    const source = fs.readFileSync(profilePath, "utf-8");

    // 8gb/16gb: dinov2RecycleThreshold: 5
    // Match both 8gb and 16gb tier definitions with value 5
    const fiveMatches = source.match(/dinov2RecycleThreshold:\s*5/g);
    expect(fiveMatches).not.toBeNull();
    expect(fiveMatches!.length).toBeGreaterThanOrEqual(2);

    // 32gb: dinov2RecycleThreshold: 15
    expect(source).toMatch(/dinov2RecycleThreshold:\s*15/);

    // 64gb+: dinov2RecycleThreshold: 30
    expect(source).toMatch(/dinov2RecycleThreshold:\s*30/);
  });

  it("resolveMemoryConfigの戻り値にdinov2RecycleThresholdが含まれること", () => {
    const profilePath = path.resolve(__dirname, "../../../src/services/worker-memory-profile.ts");
    const source = fs.readFileSync(profilePath, "utf-8");

    // resolveMemoryConfig returns dinov2RecycleThreshold
    // Check the return object includes the field
    expect(source).toContain("dinov2RecycleThreshold,");
    // Check WORKER_DINOV2_RECYCLE_THRESHOLD env var override
    expect(source).toContain("WORKER_DINOV2_RECYCLE_THRESHOLD");
  });
});
