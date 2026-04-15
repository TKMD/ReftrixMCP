// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - Batch Fallback + Duplicate Vector Detection Tests
 *
 * page-analyze-worker.ts のバッチ処理化と重複ベクトル検出のテスト。
 * Section Screenshot Fallback のバッチ処理パターンと、
 * vision_embedding の重複検出（コサイン類似度ベース）を検証する。
 *
 * Tests for batch processing and duplicate vector detection in page-analyze-worker.ts.
 * Validates batch capture pattern for Section Screenshot Fallback and
 * cosine-similarity-based duplicate detection for vision_embedding.
 *
 * テストケース（12件）:
 *   バッチ処理（4件）:
 *     1. フォールバック対象が一括でcaptureSectionScreenshotsに渡される
 *     2. page.goto呼び出し回数が1回（バッチ処理確認）
 *     3. フォールバック対象0件でバッチ呼び出しスキップ
 *     4. バッチ呼び出し失敗でGraceful Degradation
 *   重複検出（4件）:
 *     5. コサイン類似度 > 閾値で保存スキップ
 *     6. コサイン類似度 < 閾値で正常保存
 *     7. DUPLICATE_VECTOR_THRESHOLD環境変数による閾値変更
 *     8. ドット積による重複検出の数学的正確性
 *   rAF待機（2件）:
 *     9. scrollTo後にrAF待ちが実行される
 *    10. rAF待ちが2秒タイムアウトでハングしない
 *   メモリ・安全装置（2件）:
 *    11. バッチ処理中のメモリ圧力チェック
 *    12. 重複検出後のDB格納でNaN/Infinity混入なし
 *
 * @module tests/workers/section-visual-embedding-batch-dedup
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ==========================================================================
// cosineSimilarity ヘルパー関数のインポート
// @reftrixmcp/ml パッケージからエクスポートされている
// ==========================================================================
import { cosineSimilarity } from "@reftrixmcp/ml";

// ==========================================================================
// ソースコード構造テスト用の定数
// ==========================================================================

/** processEmbeddingPhase 全体のスライスサイズ（~73K文字、acquireSectionCropBuffer抽出+動的Fallback追加分を含む） */
const EMBEDDING_PHASE_SLICE = 75000;

/** Section Visual Embedding ブロックのスライスサイズ（processEmbeddingPhase内のセクション+サブ関数collectAndCapture分） */
const SECTION_VISUAL_SLICE = 35000;

/** processSingleSectionVisualEmbedding サブ関数のスライスサイズ（巨大関数分解で移動したセクション単位処理ロジック） */
const SINGLE_SECTION_SLICE = 10000;

// ==========================================================================
// SectionScreenshotFallbackService モックテスト用
// ==========================================================================

// logger モック / Logger mock
vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  isDevelopment: vi.fn().mockReturnValue(false),
}));

// url-validator モック / URL validator mock
vi.mock("../../src/utils/url-validator", () => ({
  validateExternalUrl: vi.fn(),
}));

import { validateExternalUrl } from "../../src/utils/url-validator";
const mockValidateExternalUrl = vi.mocked(validateExternalUrl);

// playwright モック / Playwright mock
vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

import { chromium } from "playwright";
const mockChromiumLaunch = vi.mocked(chromium.launch);

import type { Browser, BrowserContext, Page } from "playwright";

import { captureSectionScreenshots } from "../../src/services/part/section-screenshot-fallback.service";

// ==========================================================================
// テストデータ / Test Data
// ==========================================================================

const MOCK_URL = "https://example.com/batch-test";
const MOCK_SECTION_IDS = [
  "aaaa1111-1111-7111-1111-111111111111",
  "bbbb2222-2222-7222-2222-222222222222",
  "cccc3333-3333-7333-3333-333333333333",
  "dddd4444-4444-7444-4444-444444444444",
  "eeee5555-5555-7555-5555-555555555555",
];

// ==========================================================================
// モックファクトリー / Mock Factories
// ==========================================================================

function createMockScreenshotBuffer(prefix = "mock-screenshot"): Buffer {
  return Buffer.from(`${prefix}-png-data`, "utf-8");
}

function createMockPage(overrides?: {
  goto?: ReturnType<typeof vi.fn>;
  evaluate?: ReturnType<typeof vi.fn>;
  screenshot?: ReturnType<typeof vi.fn>;
  waitForTimeout?: ReturnType<typeof vi.fn>;
  waitForLoadState?: ReturnType<typeof vi.fn>;
  close?: ReturnType<typeof vi.fn>;
}): Page {
  return {
    goto: overrides?.goto ?? vi.fn().mockResolvedValue({ status: () => 200 }),
    evaluate: overrides?.evaluate ?? vi.fn().mockResolvedValue(undefined),
    screenshot: overrides?.screenshot ?? vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
    waitForTimeout: overrides?.waitForTimeout ?? vi.fn().mockResolvedValue(undefined),
    waitForLoadState: overrides?.waitForLoadState ?? vi.fn().mockResolvedValue(undefined),
    close: overrides?.close ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function createMockContext(
  page: Page,
  overrides?: {
    close?: ReturnType<typeof vi.fn>;
  }
): BrowserContext {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: overrides?.close ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;
}

function createMockBrowser(
  context: BrowserContext,
  overrides?: {
    close?: ReturnType<typeof vi.fn>;
    isConnected?: ReturnType<typeof vi.fn>;
  }
): Browser {
  return {
    newContext: vi.fn().mockResolvedValue(context),
    close: overrides?.close ?? vi.fn().mockResolvedValue(undefined),
    isConnected: overrides?.isConnected ?? vi.fn().mockReturnValue(true),
  } as unknown as Browser;
}

// ==========================================================================
// L2正規化ヘルパー / L2 normalization helper
// ==========================================================================

/**
 * ベクトルをL2正規化する / L2-normalize a vector
 * DINOv2出力をシミュレートするため
 */
function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/**
 * 指定次元のランダムL2正規化ベクトルを生成
 * Generate a random L2-normalized vector of specified dimension
 */
function createRandomL2NormalizedVector(dim: number): number[] {
  const raw = Array.from({ length: dim }, () => Math.random() - 0.5);
  return l2Normalize(raw);
}

// ==========================================================================
// テスト / Tests
// ==========================================================================

describe("PageAnalyzeWorker - Batch Fallback + Duplicate Vector Detection", () => {
  // After TDA-C1 refactoring, processEmbeddingPhase, fallbackSections, and visual
  // embedding logic moved to phase-5-embedding.ts. isDuplicateVisionEmbedding and
  // other helpers are in phases/types.ts.
  const phase5Path = path.resolve(__dirname, "../../src/workers/phases/phase-5-embedding.ts");
  const typesPath = path.resolve(__dirname, "../../src/workers/phases/types.ts");

  let workerSource: string;

  beforeEach(() => {
    vi.clearAllMocks();
    workerSource = fs.readFileSync(typesPath, "utf8") + "\n" + fs.readFileSync(phase5Path, "utf8");
    // デフォルトでURL検証を通過 / Default: pass URL validation
    mockValidateExternalUrl.mockReturnValue({ valid: true, normalizedUrl: MOCK_URL });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ========================================================================
  // バッチ処理テスト（4件）
  // Batch processing tests (4 tests)
  // ========================================================================
  describe("バッチ処理: フォールバック対象の一括キャプチャ / Batch processing: bulk fallback capture", () => {
    it("フォールバック対象セクションが一括でcaptureSectionScreenshotsに渡される（sections配列がN件）", () => {
      // Arrange & Act: ソースコード構造解析
      // フォールバック対象をfor文の前に事前収集し、
      // 1回のcaptureSectionScreenshots呼び出しでN件渡す
      const fnStart = workerSource.indexOf("async function collectFallbackScreenshots");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 5000);

      // Assert: バッチ収集パターンが存在する
      // fallbackSections 配列に事前収集される
      expect(fnBody).toContain("fallbackSections");

      // captureSectionScreenshots に sections: fallbackSections を渡す
      // （1件ずつではなくN件のバッチ）
      expect(fnBody).toContain("sections: fallbackSections");
    });

    it("page.goto呼び出しが1回であること（バッチ処理確認）", async () => {
      // Arrange: 5セクション分のバッチフォールバック
      const mockGoto = vi.fn().mockResolvedValue({ status: () => 200 });
      const mockPage = createMockPage({
        goto: mockGoto,
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext, {
        isConnected: vi.fn().mockReturnValue(true),
      });

      const sections = MOCK_SECTION_IDS.map((id, i) => ({
        id,
        startY: 2000 + i * 500,
        height: 400,
      }));

      // Act
      await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        sharedBrowser: mockBrowser,
      });

      // Assert: page.goto は1回のみ呼ばれる（N回ではなく）
      expect(mockGoto).toHaveBeenCalledTimes(1);
    });

    it("フォールバック対象0件でバッチ呼び出しスキップ", () => {
      // Arrange & Act: ソースコード構造解析
      // After TDA-C1 refactoring, fallback collection moved to collectFallbackScreenshots
      const fnStart = workerSource.indexOf("async function collectFallbackScreenshots");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 5000);

      // Assert: fallbackSections.length > 0 のガード条件が存在する
      expect(fnBody).toContain("fallbackSections.length > 0");
    });

    it("バッチ呼び出し失敗でGraceful Degradation（text_embeddingのみで続行）", () => {
      // Arrange & Act: ソースコード構造解析
      const fnStart = workerSource.indexOf("async function collectFallbackScreenshots");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 5000);

      // Assert: バッチフォールバック失敗時のcatchブロック
      expect(fnBody).toContain("Batch section screenshot fallback failed (non-fatal)");

      // フォールバック失敗後も処理が続行される
      const batchFailPos = fnBody.indexOf("Batch section screenshot fallback failed");
      expect(batchFailPos).toBeGreaterThan(-1);
      // catch後にthrowがない（処理続行）
      const afterCatch = fnBody.slice(batchFailPos, batchFailPos + 500);
      expect(afterCatch).not.toContain("throw");
    });
  });

  // ========================================================================
  // 重複検出テスト（4件）
  // Duplicate vector detection tests (4 tests)
  // ========================================================================
  describe("重複ベクトル検出: コサイン類似度ベース / Duplicate vector detection: cosine similarity", () => {
    it("コサイン類似度 > DUPLICATE_THRESHOLD でvision_embedding保存スキップ", () => {
      // Arrange & Act: ソースコード構造解析
      // After TDA-C1 refactoring, per-section duplicate detection moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const chunkBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);

      // Assert: 重複検出後のスキップパターン
      expect(chunkBody).toContain("isDuplicateVector");
      expect(chunkBody).toContain("Duplicate vision embedding detected");
      // DUPLICATE_THRESHOLD is passed as params.duplicateThreshold
      expect(chunkBody).toContain("duplicateThreshold");

      // isDuplicateVector が true の場合に return でDB保存スキップ（サブ関数のため continue → return）
      const dupCheckPos = chunkBody.indexOf("if (isDuplicateVector)");
      expect(dupCheckPos).toBeGreaterThan(-1);
      const afterDupCheck = chunkBody.slice(dupCheckPos, dupCheckPos + 1000);
      expect(afterDupCheck).toContain("return");
    });

    it("コサイン類似度 < DUPLICATE_THRESHOLD で正常保存", () => {
      // Arrange & Act: ソースコード構造解析
      // After TDA-C1 refactoring, per-section logic moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const chunkBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);

      // Assert: 重複検出を通過後にDB保存が実行される
      const dupCheckPos = chunkBody.indexOf("isDuplicateVector");
      const dbSavePos = chunkBody.indexOf("UPDATE section_embeddings");
      expect(dupCheckPos).toBeGreaterThan(-1);
      expect(dbSavePos).toBeGreaterThan(-1);
      // 重複チェック → DB保存の順序
      expect(dupCheckPos).toBeLessThan(dbSavePos);

      // スライディングウィンドウへの追加
      expect(chunkBody).toContain("recentSectionVisualEmbeddings.push");
    });

    it("DUPLICATE_VECTOR_THRESHOLD環境変数による閾値変更", () => {
      // Arrange & Act: ソースコード構造解析
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);

      // Assert: 環境変数から閾値を読み取る
      expect(fnBody).toContain('process.env["DUPLICATE_VECTOR_THRESHOLD"]');
      // デフォルト値 0.995
      expect(fnBody).toContain('"0.995"');
      // parseFloat で数値変換
      expect(fnBody).toContain("parseFloat");
    });

    it("ドット積による重複検出の数学的正確性（L2正規化済みベクトル）", () => {
      // Arrange: L2正規化済みベクトルのペア
      // L2正規化済みベクトルの場合、コサイン類似度 = ドット積

      // ケース1: 同一ベクトル → 類似度 = 1.0
      const vecA = l2Normalize([1, 2, 3, 4, 5]);
      const similarity1 = cosineSimilarity(vecA, vecA);
      expect(similarity1).toBeCloseTo(1.0, 6);

      // ケース2: 直交ベクトル → 類似度 = 0.0
      const vecB = l2Normalize([1, 0, 0, 0, 0]);
      const vecC = l2Normalize([0, 1, 0, 0, 0]);
      const similarity2 = cosineSimilarity(vecB, vecC);
      expect(similarity2).toBeCloseTo(0.0, 6);

      // ケース3: 類似ベクトル → 0.995 超で重複判定
      const vecD = l2Normalize([1, 2, 3, 4, 5]);
      // わずかに異なるベクトル（高い類似度を持つ）
      const vecE = l2Normalize([1.001, 2.001, 3.001, 4.001, 5.001]);
      const similarity3 = cosineSimilarity(vecD, vecE);
      expect(similarity3).toBeGreaterThan(0.995);

      // ケース4: 明確に異なるベクトル → 0.995 未満
      const vecF = l2Normalize([1, 2, 3, 4, 5]);
      const vecG = l2Normalize([5, 4, 3, 2, 1]);
      const similarity4 = cosineSimilarity(vecF, vecG);
      expect(similarity4).toBeLessThan(0.995);

      // ケース5: ドット積がL2正規化済みベクトルのコサイン類似度と一致することを検証
      const vec768A = createRandomL2NormalizedVector(768);
      const vec768B = createRandomL2NormalizedVector(768);
      const cosSimResult = cosineSimilarity(vec768A, vec768B);
      // ドット積を直接計算
      let dotProduct = 0;
      for (let i = 0; i < 768; i++) {
        dotProduct += vec768A[i]! * vec768B[i]!;
      }
      // L2正規化済みならコサイン類似度 ≈ ドット積
      expect(cosSimResult).toBeCloseTo(dotProduct, 5);
    });
  });

  // ========================================================================
  // rAF待機テスト（2件）
  // requestAnimationFrame wait tests (2 tests)
  // ========================================================================
  describe("rAF待機: scrollTo後のレンダリング完了保証 / rAF wait: rendering completion after scrollTo", () => {
    it("scrollTo後にrequestAnimationFrame待ちが実行される", () => {
      // Arrange & Act: SectionScreenshotFallbackService のソースコード構造解析
      const servicePath = path.resolve(
        __dirname,
        "../../src/services/part/section-screenshot-fallback.service.ts"
      );
      const serviceSource = fs.readFileSync(servicePath, "utf8");

      // Assert: scrollTo → waitForTimeout → rAF待ちの順序
      const scrollToPos = serviceSource.indexOf("window.scrollTo(0, y)");
      expect(scrollToPos).toBeGreaterThan(-1);

      // 実際のrAFコード呼び出し（コメントではなく）を検索
      const rafCodePos = serviceSource.indexOf("requestAnimationFrame(() =>");
      expect(rafCodePos).toBeGreaterThan(-1);

      // scrollTo の後に rAF 待ちがある
      expect(scrollToPos).toBeLessThan(rafCodePos);

      // 2フレーム分のrAF待ち（ダブルrAF パターン）
      // requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      const rafBlock = serviceSource.slice(rafCodePos, rafCodePos + 200);
      expect(rafBlock).toContain("requestAnimationFrame(() => resolve()");
    });

    it("rAF待ちが2秒タイムアウトでハングしない", () => {
      // Arrange & Act: SectionScreenshotFallbackService のソースコード構造解析
      const servicePath = path.resolve(
        __dirname,
        "../../src/services/part/section-screenshot-fallback.service.ts"
      );
      const serviceSource = fs.readFileSync(servicePath, "utf8");

      // Assert: rAF待ちにPromise.raceで2秒タイムアウトが設定されている
      // 実際のrAFコード呼び出しを検索
      const rafCodePos = serviceSource.indexOf("requestAnimationFrame(() =>");
      expect(rafCodePos).toBeGreaterThan(-1);

      // Promise.race で rAF と timeout の競合（rAFコードの前方を検索）
      const promiseRaceBlock = serviceSource.slice(Math.max(0, rafCodePos - 300), rafCodePos + 300);
      expect(promiseRaceBlock).toContain("Promise.race");
      expect(promiseRaceBlock).toContain("waitForTimeout(2000)");

      // rAF失敗は非致命的（catch で吸収）
      const afterRaf = serviceSource.slice(rafCodePos, rafCodePos + 500);
      expect(afterRaf).toContain("非致命的");
    });
  });

  // ========================================================================
  // メモリ・安全装置テスト（2件）
  // Memory and safety tests (2 tests)
  // ========================================================================
  describe("メモリ・安全装置 / Memory and safety mechanisms", () => {
    it("バッチ処理中のメモリ圧力チェックが機能（checkMemoryPressure）", async () => {
      // Arrange: checkMemoryPressure がバッチキャプチャに渡される
      const checkMemoryPressure = vi.fn().mockReturnValue({
        shouldDegrade: true,
        shouldAbort: false,
        rssMb: 4096,
      });

      const mockPage = createMockPage({
        screenshot: vi.fn().mockResolvedValue(createMockScreenshotBuffer()),
      });
      const mockContext = createMockContext(mockPage);
      const mockBrowser = createMockBrowser(mockContext);
      mockChromiumLaunch.mockResolvedValue(mockBrowser);

      const sections = MOCK_SECTION_IDS.slice(0, 3).map((id, i) => ({
        id,
        startY: 2000 + i * 500,
        height: 400,
      }));

      // Act
      const result = await captureSectionScreenshots({
        url: MOCK_URL,
        sections,
        checkMemoryPressure,
      });

      // Assert: メモリ圧力下ではセクションがスキップされる
      expect(result.results.every((r) => r.skipped)).toBe(true);
      expect(result.results.every((r) => r.skipReason?.includes("memory"))).toBe(true);
      expect(checkMemoryPressure).toHaveBeenCalled();
    });

    it("重複検出後のDB格納でNaN/Infinity混入なし（Number.isFiniteチェック）", () => {
      // Arrange & Act: ソースコード構造解析
      // 重複検出のドット積計算でNumber.isFiniteチェックが含まれる
      // isDuplicateVisionEmbedding ヘルパー関数に抽出済み
      const helperStart = workerSource.indexOf("function isDuplicateVisionEmbedding");
      expect(helperStart).toBeGreaterThan(-1);
      const helperBody = workerSource.slice(helperStart, helperStart + 1000);

      // Assert: ドット積の結果に Number.isFinite チェックがある
      expect(helperBody).toContain("Number.isFinite");

      // NaN/Infinityの場合は重複とみなさない（安全にスキップしない）
      const isFinitePos = helperBody.indexOf("Number.isFinite(dot)");
      expect(isFinitePos).toBeGreaterThan(-1);

      // DB格納前のベクトル文字列化でNaN/Infinityが混入しない設計
      // visualVectorString = `[${visualEmbedding.join(',')}]`
      // ← generateVisualEmbedding 内でNaN/Infinity検証済み
      // After TDA-C1 refactoring, per-section DB save moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const chunkBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);
      expect(chunkBody).toContain("visualEmbedding.join");
    });
  });
});
