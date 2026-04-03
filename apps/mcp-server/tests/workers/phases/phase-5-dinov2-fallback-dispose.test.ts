// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: DINOv2 Fallback Dispose/Re-init Tests
 *
 * 動的Fallback時のDINOv2一時dispose→Playwright→DINOv2再initサイクルの
 * ソースコード構造とGraceful Degradationを検証する。
 *
 * Verifies the DINOv2 temporary dispose → Playwright → DINOv2 re-init cycle
 * for dynamic fallback, including Graceful Degradation and feature flag control.
 *
 * @module tests/workers/phases/phase-5-dinov2-fallback-dispose
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

describe("Phase 5: DINOv2 Fallback Dispose/Re-init Cycle", () => {
  const phase5Path = path.resolve(__dirname, "../../../src/workers/phases/phase-5-embedding.ts");

  let source: string;

  beforeEach(() => {
    vi.resetModules();
    mockResolveMemoryConfig.mockReset();
    mockLogMemoryProfile.mockReset();
    source = fs.readFileSync(phase5Path, "utf-8");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Test 1: 動的Fallbackセクション存在時にDINOv2 dispose→re-initパターンが含まれること
  // --------------------------------------------------------------------------
  it("動的Fallback前にdinov2Service.dispose()が呼ばれ、後にdinov2Service.initialize()が呼ばれること / should include dinov2Service.dispose() before and dinov2Service.initialize() after dynamic fallback", () => {
    // dispose() 呼び出しがprocessDynamicFallbackBatch前に存在すること
    expect(source).toContain("dinov2Service.dispose()");

    // initialize() 呼び出しがprocessDynamicFallbackBatch後に存在すること
    expect(source).toContain("dinov2Service.initialize()");

    // processDynamicFallbackBatch呼び出しの前後に dispose/initialize がある構造確認
    // dispose → processDynamicFallbackBatch → initialize の順序
    const disposeIdx = source.indexOf("pre-fallback dispose");
    const fallbackBatchIdx = source.indexOf("processDynamicFallbackBatch");
    const reinitIdx = source.indexOf("post-fallback re-init");

    expect(disposeIdx).toBeGreaterThan(-1);
    expect(fallbackBatchIdx).toBeGreaterThan(-1);
    expect(reinitIdx).toBeGreaterThan(-1);

    // 順序: dispose < fallbackBatch < reinit
    expect(disposeIdx).toBeLessThan(fallbackBatchIdx);
    expect(fallbackBatchIdx).toBeLessThan(reinitIdx);
  });

  // --------------------------------------------------------------------------
  // Test 2: re-init失敗時のGraceful Degradation保護（try-catch構造）
  // --------------------------------------------------------------------------
  it("re-init失敗時のGraceful Degradation: try-catchで保護されていること / should have try-catch protection for re-init failure (Graceful Degradation)", () => {
    // re-init失敗時のログメッセージが含まれること
    expect(source).toContain("DINOv2 post-fallback re-init failed");

    // Graceful Degradation: 残りのvisual embeddingスキップの記述
    expect(source).toContain("skipping remaining visual embeddings");

    // dispose失敗も非致命的であること
    expect(source).toContain("DINOv2 pre-fallback dispose failed");
  });

  // --------------------------------------------------------------------------
  // Test 3: DINOV2_FALLBACK_DISPOSE_ENABLED=false時のスキップ動作
  // --------------------------------------------------------------------------
  it("DINOV2_FALLBACK_DISPOSE_ENABLED環境変数によるdispose/re-initスキップ制御が含まれること / should include DINOV2_FALLBACK_DISPOSE_ENABLED feature flag for skip control", () => {
    // 環境変数チェックが含まれること
    expect(source).toContain("DINOV2_FALLBACK_DISPOSE_ENABLED");

    // fallbackDisposeEnabled 変数名が使用されていること
    expect(source).toContain("fallbackDisposeEnabled");
  });

  // --------------------------------------------------------------------------
  // Test 4: dispose/re-initの順序が正しいこと（dispose → Playwright → re-init）
  // --------------------------------------------------------------------------
  it("dispose → processDynamicFallbackBatch → re-initの順序が正しいこと / should have correct order: dispose → processDynamicFallbackBatch → re-init", () => {
    // processDynamicFallbackBatch呼び出し箇所を特定
    const dynamicFallbackCallIdx = source.indexOf("processDynamicFallbackBatch({");
    expect(dynamicFallbackCallIdx).toBeGreaterThan(-1);

    // dispose呼び出しがprocessDynamicFallbackBatch呼び出しより前にあること
    // (processDynamicFallbackBatch関数定義ではなく、呼び出し箇所の前)
    const disposeBeforeFallback = source.lastIndexOf(
      "dinov2Service.dispose()",
      dynamicFallbackCallIdx
    );
    expect(disposeBeforeFallback).toBeGreaterThan(-1);

    // initialize呼び出しがprocessDynamicFallbackBatch呼び出しより後にあること
    const reinitAfterFallback = source.indexOf(
      "dinov2Service.initialize()",
      dynamicFallbackCallIdx
    );
    expect(reinitAfterFallback).toBeGreaterThan(-1);

    // disposeの位置 < processDynamicFallbackBatch < initialize の順序
    expect(disposeBeforeFallback).toBeLessThan(dynamicFallbackCallIdx);
    expect(dynamicFallbackCallIdx).toBeLessThan(reinitAfterFallback);
  });
});

// ==========================================================================
// TPA監査条件: 回帰防止テスト — screenshotBuffer=null後のpart visual embedding継続
// ==========================================================================
describe("Part visual embedding after dynamic fallback (screenshotBuffer=null)", () => {
  const phase5Path = path.resolve(__dirname, "../../../src/workers/phases/phase-5-embedding.ts");
  let source: string;

  beforeEach(() => {
    source = fs.readFileSync(phase5Path, "utf8");
  });

  it("should use hasScreenshotSource (3-source OR) instead of screenshotBuffer alone for part guard", () => {
    // 動的fallback後にscreenshotBuffer=nullでもRAWパスまたはscreenshotBase64があれば
    // part visual embeddingが実行されることを保証するガード条件
    // NOTE: リファクタリング後、Part visual embedding は processPartVisualEmbeddingLoop に抽出済み
    const fnStart = source.indexOf("async function processPartVisualEmbeddingLoop");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, fnStart + 80000);

    // hasScreenshotSource が定義されていること（3ソースOR条件）
    expect(fnBody).toContain("hasScreenshotSource");
    expect(fnBody).toContain("rawScreenshotMeta != null");
    // パラメータ名が screenshotBase64ForParts に変更されている
    expect(fnBody).toContain("screenshotBase64ForParts != null");

    // 旧ガード "partsNeedingVisual.length > 0 && screenshotBuffer)" が存在しないこと
    // （hasScreenshotSourceに置き換え済み）
    const partGuardMatch = fnBody.match(
      /partsNeedingVisual\.length\s*>\s*0\s*&&\s*screenshotBuffer\s*\)/
    );
    expect(partGuardMatch).toBeNull();
  });

  it("should have partFallbackBuffer decoded outside the loop (CWE-770 prevention)", () => {
    // ループ外で1回だけbase64デコードし、ループ内では再デコードしないこと
    // NOTE: リファクタリング後、processPartVisualEmbeddingLoop に抽出済み
    const fnStart = source.indexOf("async function processPartVisualEmbeddingLoop");
    const fnBody = source.slice(fnStart, fnStart + 80000);

    // partFallbackBuffer がループ外で定義されていること
    expect(fnBody).toContain("partFallbackBuffer");
    expect(fnBody).toContain('Buffer.from(screenshotBase64ForParts, "base64")');

    // partFallbackBuffer定義がforループ開始より前にあること
    const fallbackDef = fnBody.indexOf("let partFallbackBuffer");
    const forLoop = fnBody.indexOf("for (", fallbackDef);
    expect(fallbackDef).toBeGreaterThan(-1);
    expect(forLoop).toBeGreaterThan(fallbackDef);
  });

  it("should safely skip part visual embedding when all screenshot sources are null", () => {
    // screenshotBuffer=null, rawScreenshotMeta=null, screenshotBase64=null の場合
    // hasScreenshotSource=false でpart visual embeddingブロックに入らないこと
    // NOTE: リファクタリング後、processPartVisualEmbeddingLoop に抽出済み
    const fnStart = source.indexOf("async function processPartVisualEmbeddingLoop");
    const fnBody = source.slice(fnStart, fnStart + 80000);

    // hasScreenshotSource が false の場合、part embedding の for ループに到達しない構造
    // 最終fallback（全ソースなし）で continue スキップがあること
    expect(fnBody).toContain("hasScreenshotSource");

    // 4段fallbackチェーンの最終段: continue でスキップ
    const fallbackChain = fnBody.indexOf("partFallbackBuffer");
    expect(fallbackChain).toBeGreaterThan(-1);
    const continueAfterFallback = fnBody.indexOf("continue;", fallbackChain);
    expect(continueAfterFallback).toBeGreaterThan(fallbackChain);
  });
});
