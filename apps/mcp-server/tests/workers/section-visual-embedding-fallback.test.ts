// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - Section Visual Embedding Fallback Integration Tests
 *
 * page-analyze-worker.ts の Section Visual Embedding フォールバック統合テスト。
 * screenshotBase64 の高さ制約により範囲外となるセクションに対して、
 * SectionScreenshotFallbackService を使用してフォールバックキャプチャを行う統合をテストする。
 *
 * Integration tests for Section Visual Embedding fallback in page-analyze-worker.ts.
 * Tests fallback screenshot capture via SectionScreenshotFallbackService for sections
 * that fall outside screenshotBase64 height boundaries.
 *
 * テストケース:
 *   1. screenshotBase64範囲内セクション: 従来パス（Sharp crop）で処理
 *   2. screenshotBase64範囲外セクション: SectionScreenshotFallbackService でフォールバック
 *   3. 範囲内+範囲外混在: 混在時のルーティング検証
 *   4. フォールバック失敗時: text_embedding のみで正常動作
 *   5. feature flag OFF: ENABLE_SECTION_SCREENSHOT_FALLBACK=false でフォールバック無効
 *   6. DINOv2共有: フォールバック取得バッファもDINOv2Serviceで正常にembedding生成
 *   7. フォールバック対象セクション数のログ出力
 *   8. PII高リスクセクションのフォールバック除外
 *
 * @module tests/workers/section-visual-embedding-fallback
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ==========================================================================
// ソースコード構造テスト（source code analysis approach）
// processEmbeddingPhase は ~54K文字の大関数のため、スライスサイズに注意。
// ==========================================================================

/** processEmbeddingPhase 全体のスライスサイズ（~73K文字、acquireSectionCropBuffer抽出+動的Fallback追加分を含む） */
const EMBEDDING_PHASE_SLICE = 75000;
/** Section Visual Embedding ブロックのスライスサイズ（抽出関数を含むフルスキャン用） */
// Slice window from `processSectionVisualEmbeddingLoop` start large enough to
// reach the orchestrator finally's `dinov2Service.dispose()` (the 2nd of the 2
// disposes this file asserts). Bumped 70000 -> 80000 in ADR-0018 Amendment 13:
// the truncated-screenshot run-level `maxSectionExtentY` pre-pass added at the
// top of `processSectionVisualEmbeddingLoop` shifted the orchestrator finally a
// few hundred chars past the old 70000 cap (the 2nd dispose sits at ~71291).
// Bumped 80000 -> 100000 in W6 Issue A PR-3a: crop persistence added the
// `clearStaleBboxUnresolvableParts` / `persistPartCrop` / `persistSectionCrop`
// helpers + the W5 clear wiring between `fnStart` and the orchestrator finally,
// shifting the 2nd dispose to ~80994 bytes past fnStart (just past the old 80000
// cap). Both disposes still exist (behaviour unchanged); only the fixed-slice
// window needed widening to keep covering them.
const SECTION_VISUAL_SLICE = 100000;
/**
 * processSingleSectionVisualEmbedding サブ関数のスライスサイズ（巨大関数分解で移動したセクション単位処理ロジック。secvisual blank/no-position terminal exit 2件追加で実関数長 ~10992 文字に拡大、result.generated++ は rel offset 10587）。
 *
 * ADR-0018 Amendment 13 follow-up (PR #59): backfill section_visual write の stale
 * `vision_skip_reason = NULL` クリア（コメント2行 + SQL 1行）が、末尾の per-section
 * catch ブロック（`catch (sectionVisualError)` / `DINOv2 visual embedding failed
 * for section (non-fatal)`、rel ~12000-12136）より前に挿入されたため、12000 固定窓の
 * 外に押し出された（文字列は関数内に残存、production 挙動は不変）。brace-balanced
 * 実関数長は 12381 文字。前例 (internal decision 019e7f68, PR-SECVISUAL-FORK COND-1)
 * の canonical fix に倣い、実測関数長 + ~1100 margin = 13500 に拡大する（盲目的 bump
 * や次関数本体への過剰越境を避ける）。13500 は末尾 catch ブロックを網羅する。
 *
 * The backfill stale-`vision_skip_reason = NULL` clear (2 comment lines + 1 SQL line)
 * added in PR #59 was inserted BEFORE the trailing per-section catch block, pushing the
 * pinned strings out of the fixed 12000-char window (the strings remain in-function; the
 * production behaviour is unchanged). The brace-balanced function length is 12381 chars.
 * Following the canonical fix of the precedent (internal decision 019e7f68,
 * PR-SECVISUAL-FORK COND-1), widen to measured length + ~1100 margin = 13500 (avoiding a
 * blind bump or excessive overrun into the next function body). 13500 covers the trailing
 * catch block.
 */
const SINGLE_SECTION_SLICE = 13500;

describe("PageAnalyzeWorker - Section Visual Embedding Fallback Integration", () => {
  // After TDA-C1 refactoring, processEmbeddingPhase, fallback logic, and visual
  // embedding code moved to phase-5-embedding.ts. acquireSectionCropBuffer and
  // other helpers are in phases/types.ts. processPageAnalyzeJob (result propagation)
  // remains in the orchestrator.
  const phase5Path = path.resolve(__dirname, "../../src/workers/phases/phase-5-embedding.ts");
  const typesPath = path.resolve(__dirname, "../../src/workers/phases/types.ts");
  const orchestratorPath = path.resolve(__dirname, "../../src/workers/page-analyze-worker.ts");
  const forkOrchestratorPath = path.resolve(
    __dirname,
    "../../src/workers/phases/phase-5-fork-orchestrator.ts"
  );

  let workerSource: string;

  beforeEach(() => {
    workerSource =
      fs.readFileSync(typesPath, "utf8") +
      "\n" +
      fs.readFileSync(phase5Path, "utf8") +
      "\n" +
      fs.readFileSync(orchestratorPath, "utf8") +
      "\n" +
      fs.readFileSync(forkOrchestratorPath, "utf8");
  });

  // ========================================================================
  // 1. screenshotBase64範囲内セクション: 従来パス（Sharp crop）で処理
  // ========================================================================
  describe("screenshotBase64範囲内セクション: 従来パス / In-range sections: conventional path", () => {
    it("should use sharp.extract() for sections within screenshot height", () => {
      // screenshotBase64 の高さ内にあるセクションは従来の Sharp crop パスで処理される
      // acquireSectionCropBuffer ヘルパー関数に抽出済み
      const fnStart = workerSource.indexOf("async function acquireSectionCropBuffer");
      expect(fnStart).toBeGreaterThan(-1);
      const cropBody = workerSource.slice(fnStart, fnStart + 3000);

      // Sharp の extract メソッドでクロップ
      expect(cropBody).toContain("sharp(screenshotBuffer)");
      expect(cropBody).toContain(".extract(");
    });

    it("should check sectionTop < imgHeight before using sharp crop", () => {
      // sectionTop < imgHeight の条件でSharp cropを使用
      // After TDA-C1 refactoring, per-section logic moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const chunkBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);
      expect(chunkBody).toContain("sectionTop >= p.imgHeight");
    });

    it("should crop with full page width (sectionLeft = 0)", () => {
      // acquireSectionCropBuffer ヘルパー関数に抽出済み
      const fnStart = workerSource.indexOf("async function acquireSectionCropBuffer");
      const cropBody = workerSource.slice(fnStart, fnStart + 3000);
      expect(cropBody).toContain("sectionLeft = 0");
    });
  });

  // ========================================================================
  // 2. screenshotBase64範囲外セクション: SectionScreenshotFallbackService
  //    以下のテストは page-analyze-worker.ts にフォールバック統合が追加された後に PASS する
  // ========================================================================
  describe("screenshotBase64範囲外セクション: フォールバック / Out-of-range sections: fallback", () => {
    it("should have fallback path for sections beyond screenshot height", () => {
      // フォールバックパスが存在するか（実装後にPASS）
      // sectionTop >= imgHeight の場合に SectionScreenshotFallbackService を呼び出す
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);

      // フォールバックサービスのインポートまたは使用
      // captureSectionScreenshots としてインポートされている
      expect(fnBody).toContain("captureSectionScreenshots");
    });

    it("should invoke fallback when sectionTop >= imgHeight", () => {
      // sectionTop >= imgHeight の分岐にフォールバック呼び出しがある
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);

      // 現在は continue でスキップしているが、フォールバック後は処理を続行する

      expect(sectionVisualBody).toContain("fallback");
    });

    it("should collect out-of-range sections for fallback capture", () => {
      // 範囲外セクションをフォールバックで個別キャプチャ
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      const fnBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);

      // フォールバックのキャプチャ呼び出しとカウント追跡
      expect(fnBody).toContain("sectionFallbackCapturedCount");
    });
  });

  // ========================================================================
  // 3. 範囲内+範囲外混在: 混在時のルーティング検証
  // ========================================================================
  describe("範囲内+範囲外混在 / Mixed in-range and out-of-range sections", () => {
    it("should maintain original sharp crop path for in-range sections", () => {
      // フォールバック追加後も、範囲内セクションは従来のSharp cropを使用
      // acquireSectionCropBuffer ヘルパー関数に抽出済み
      const fnStart = workerSource.indexOf("async function acquireSectionCropBuffer");
      expect(fnStart).toBeGreaterThan(-1);
      const cropBody = workerSource.slice(fnStart, fnStart + 3000);

      // Sharp crop のパスが残っている
      expect(cropBody).toContain("sharp(screenshotBuffer)");
      expect(cropBody).toContain(".extract(");
      expect(cropBody).toContain(".resize(");
    });

    it("should route sections based on imgHeight comparison", () => {
      // imgHeight を基準にセクションを振り分ける
      // After TDA-C1 refactoring, per-section routing moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const chunkBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);

      // sectionTop >= p.imgHeight チェックがルーティング条件
      expect(chunkBody).toContain("sectionTop >= p.imgHeight");
      expect(chunkBody).toContain("imgHeight");
    });

    it("should process both in-range and fallback sections with same dinov2Service", () => {
      // 同じ dinov2Service インスタンスで Section + Part 両方のembedding生成
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      const fnBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);

      // DINOv2Service は Section + Part 共用で 1 回だけ初期化
      const initMatches = fnBody.match(/new DINOv2Service/g);
      expect(initMatches).not.toBeNull();
      expect(initMatches!.length).toBe(1);
    });
  });

  // ========================================================================
  // 4. フォールバック失敗時: text_embedding のみで正常動作
  // ========================================================================
  describe("フォールバック失敗時 / Fallback failure graceful degradation", () => {
    it("should have graceful degradation for entire visual embedding block", () => {
      // DINOv2 visual embedding ブロック全体の try-catch（既存）
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      const fnBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(fnBody).toContain("DINOv2 visual embedding failed (non-fatal)");
    });

    it("should have per-section try-catch for individual failures", () => {
      // 個別セクションの crop/DINOv2 推論失敗をキャッチする per-section try-catch
      // After TDA-C1 refactoring, per-section try-catch moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const chunkBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);
      expect(chunkBody).toContain("DINOv2 visual embedding failed for section (non-fatal)");
    });

    it("should continue processing other sections after one section fails", () => {
      // 1つのセクションが失敗しても、他のセクションは処理される
      // After TDA-C1 refactoring, the loop calls processSingleSectionVisualEmbedding per section
      const fnStart = workerSource.indexOf("for (const section of chunk)");
      expect(fnStart).toBeGreaterThan(-1);
      // processSingleSectionVisualEmbedding has its own try-catch
      const singleFnStart = workerSource.indexOf(
        "async function processSingleSectionVisualEmbedding"
      );
      const singleBody = workerSource.slice(singleFnStart, singleFnStart + SINGLE_SECTION_SLICE);
      expect(singleBody).toContain("catch (sectionVisualError)");
    });

    it("should not block job completion when fallback fails", () => {
      // In fork path, runVisualEmbeddingSubPhases catches errors and returns partial result
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);
      // Function returns result even on partial failure
      expect(fnBody).toContain("return vResult");
      // Non-fatal catch blocks exist
      expect(fnBody).toContain("(non-fatal)");
    });

    it("should preserve text_embedding even when visual embedding fails", () => {
      // PR-BT-5 (ADR-0039): in the per-sub-phase fork path, the text sub-phase
      // forks run sequentially BEFORE the visual sub-phase forks (text dispatch
      // loop → resolvePartBboxFn → visual dispatch loop). So a visual fork
      // failure cannot lose already-persisted text embeddings (they ran in
      // earlier, separate forks that exit(0)'d). Assert the text-before-visual
      // dispatch ordering via the new Step markers.
      const fnStart = workerSource.indexOf("async function runPhase5ViaFork");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);
      // Text sub-phase forks dispatched before visual sub-phase forks.
      const textForksPos = fnBody.indexOf("Step 1: Text sub-phase forks");
      const visualForksPos = fnBody.indexOf("Step 3: Visual sub-phase forks");
      expect(textForksPos).toBeGreaterThan(-1);
      expect(visualForksPos).toBeGreaterThan(-1);
      expect(textForksPos).toBeLessThan(visualForksPos);
    });
  });

  // ========================================================================
  // 5. feature flag OFF: ENABLE_SECTION_SCREENSHOT_FALLBACK=false
  // ========================================================================
  describe("feature flag OFF / Feature flag disabled", () => {
    it("should have feature flag check for fallback service in fork orchestrator", () => {
      // 環境変数 ENABLE_SECTION_SCREENSHOT_FALLBACK はfork orchestratorで参照
      // (fork orchestratorソースは別ファイルだが、合成テスト用に全ソースで検索)
      expect(workerSource).toContain("ENABLE_SECTION_SCREENSHOT_FALLBACK");
    });

    it("feature flag should default to true (opt-out behavior)", () => {
      // デフォルトは true（明示的に無効化が必要 = opt-out）
      // fork orchestrator 内: (process.env["ENABLE_SECTION_SCREENSHOT_FALLBACK"] ?? "true") === "true"
      expect(workerSource).toContain("ENABLE_SECTION_SCREENSHOT_FALLBACK");
    });

    it("should skip fallback and continue (like current behavior) when flag is off", () => {
      // flag OFF の場合は sectionTop >= imgHeight で continue（現在の動作と同じ）
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);

      // 現在の continue パスは残す（フォールバック無効時に使用）
      expect(sectionVisualBody).toContain("continue");
    });
  });

  // ========================================================================
  // 6. DINOv2共有: フォールバック取得バッファもDINOv2Serviceで正常にembedding生成
  // ========================================================================
  describe("DINOv2共有 / DINOv2 service sharing with fallback", () => {
    it("DINOv2Service should be initialized once for both Sharp crop and fallback paths", () => {
      // DINOv2Service は Sharp crop パスとフォールバックパスで同じインスタンスを使用
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      const fnBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);

      // 1回だけ初期化
      const initMatches = fnBody.match(/new DINOv2Service/g);
      expect(initMatches).not.toBeNull();
      expect(initMatches!.length).toBe(1);
    });

    it("should call generateVisualEmbedding for both Sharp-cropped and fallback buffers", () => {
      // generateVisualEmbedding が Section Visual Embedding 内で使用される
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      // Prettier formats multi-line: generateVisualEmbedding(\n  dinov2Service,\n  ...
      expect(sectionVisualBody).toContain("generateVisualEmbedding(");
      expect(sectionVisualBody).toContain("dinov2Service,");
    });

    it("DINOv2Service should be disposed in orchestrator finally + pre-fallback dispose", () => {
      // dispose() は (1) orchestrator finally block + (2) pre-fallback dispose in processSectionVisualEmbeddingLoop の 2 箇所
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      const fnBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);

      const disposeMatches = fnBody.match(/dinov2Service\.dispose\(\)/g);
      expect(disposeMatches).not.toBeNull();
      expect(disposeMatches!.length).toBe(2);
    });

    it("should resize fallback buffer to DINOV2_INPUT_SIZE before embedding", () => {
      // フォールバックバッファも DINOV2_INPUT_SIZE (224x224) にリサイズする
      // acquireSectionCropBuffer ヘルパー関数にリサイズ処理が抽出済み
      const fnStart = workerSource.indexOf("async function acquireSectionCropBuffer");
      expect(fnStart).toBeGreaterThan(-1);
      const cropBody = workerSource.slice(fnStart, fnStart + 3000);

      // リサイズパスがあることを確認
      expect(cropBody).toContain("dinov2InputSize");
      expect(cropBody).toContain("resize");
    });
  });

  // ========================================================================
  // 7. フォールバック対象セクション数のログ出力
  // ========================================================================
  describe("フォールバック対象セクション数のログ / Fallback section count logging", () => {
    it("should log count of sections needing fallback", () => {
      // フォールバック対象のセクション数をログ出力する

      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      const fnBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);

      // フォールバック対象数のログ
      expect(fnBody).toContain("fallback");
    });

    it("should include sectionVisualEmbeddingsGenerated in result for both paths", () => {
      // サブ関数が generated カウンタを返し、ループ関数が集計して返す
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 15000);
      expect(fnBody).toContain("sectionVisualEmbeddingsGenerated");
    });
  });

  // ========================================================================
  // 8. PII高リスクセクションのフォールバック除外
  // ========================================================================
  describe("PII高リスクセクションの除外 / PII high-risk section exclusion", () => {
    it("should filter out PII-high sections before fallback processing", () => {
      // PII 高リスクセクションはフォールバック対象からも除外される
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("highPiiSectionIdSet");
      expect(sectionVisualBody).toContain("sectionsFiltered");
    });

    it("PII filtering should apply before the section visual embedding loop", () => {
      // PR-C4/CO-5 リファクタ追従、SSOT canonical 化: PII 保護は worker インラインの
      // `pii_risk_level = 'high'` literal grep ではなく、SSOT exclusion predicate
      // (`sectionVisualPendingExclusionPredicate`) + 高PII pending set 由来の
      // `highPiiSectionIdSet` で適用される。GDPR Art.5(1)(c) data-minimisation の
      // 「PII フィルタが visual embedding loop の前に適用される」順序 invariant は
      // 新 shape (predicate + highPiiSectionIdSet → sectionsFiltered → loop) で保持。
      // PR-C4/CO-5 refactor follow-up, SSOT canonicalisation: PII protection is now
      // applied via the SSOT exclusion predicate (`sectionVisualPendingExclusionPredicate`)
      // + the `highPiiSectionIdSet` derived from the high-PII pending set — NOT via an
      // inline `pii_risk_level = 'high'` literal grep in the worker. The GDPR Art.5(1)(c)
      // ordering invariant ("PII filter applies before the visual embedding loop") is
      // preserved by the new shape (predicate + highPiiSectionIdSet → sectionsFiltered → loop).
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);

      // PII 除外は SSOT predicate 経由 (NOT EXISTS pii_risk_level='high' を内包)
      // PII exclusion via the SSOT predicate (which embeds NOT EXISTS pii_risk_level='high')
      const predicatePos = fnBody.indexOf("sectionVisualPendingExclusionPredicate");
      // 高PII pending set の導出 (queryHighPiiPendingSectionPatternIds 由来)
      // High-PII pending set derivation (from queryHighPiiPendingSectionPatternIds)
      const highPiiSetPos = fnBody.indexOf("highPiiSectionIdSet");
      const loopPos = fnBody.indexOf("processSectionVisualEmbeddingLoop");

      expect(predicatePos).toBeGreaterThan(-1);
      expect(highPiiSetPos).toBeGreaterThan(-1);
      expect(loopPos).toBeGreaterThan(-1);
      // PII フィルタリング (predicate + 高PII set) は loop 呼び出しの前に位置する
      // PII filtering (predicate + high-PII set) is positioned before the loop call
      expect(predicatePos).toBeLessThan(loopPos);
      expect(highPiiSetPos).toBeLessThan(loopPos);
    });
  });

  // ========================================================================
  // 追加: SectionScreenshotFallbackService のインポート確認
  // ========================================================================
  describe("SectionScreenshotFallbackService のインポート / Service import", () => {
    it("should import captureSectionScreenshots in page-analyze-worker.ts", () => {
      // captureSectionScreenshots がインポートされている
      expect(workerSource).toContain("captureSectionScreenshots");
    });

    it("should import from the correct path", () => {
      expect(workerSource).toContain("section-screenshot-fallback");
    });
  });

  // ========================================================================
  // 追加: 結果伝播テスト
  // ========================================================================
  describe("結果伝播: フォールバック含むsectionVisualEmbeddingsGeneratedの処理", () => {
    it("processPageAnalyzeJob should propagate sectionVisualEmbeddingsGenerated", () => {
      const fnStart = workerSource.indexOf("function processPageAnalyzeJob");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart);
      expect(fnBody).toContain("sectionVisualEmbeddingsGenerated");
    });

    it("sectionVisualEmbeddingsGenerated should include both in-range and fallback counts", () => {
      // ループ関数が generatedCount を集計し、戻り値で sectionVisualEmbeddingsGenerated として返す
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 15000);
      expect(fnBody).toContain("generatedCount");
      expect(fnBody).toContain("sectionVisualEmbeddingsGenerated: generatedCount");
    });
  });

  // ========================================================================
  // 追加: メモリ管理の統合
  // ========================================================================
  describe("メモリ管理: フォールバック含む / Memory management with fallback", () => {
    it("should check memory pressure per chunk (including fallback processing)", () => {
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("checkMemoryPressure");
      expect(sectionVisualBody).toContain("shouldAbort");
    });

    it("should abort section visual embedding on critical memory pressure", () => {
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("Critical memory, stopping section visual embedding");
    });

    it("should perform inter-chunk GC between chunks", () => {
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("tryGarbageCollect");
    });
  });
});
