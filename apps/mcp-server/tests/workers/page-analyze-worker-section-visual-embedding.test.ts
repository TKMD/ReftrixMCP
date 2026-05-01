// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - Section Visual Embedding (DINOv2) Tests
 *
 * Phase 5 Embedding フェーズの Section Visual Embedding 生成をテストする。
 * processEmbeddingPhase() 内の Section DINOv2 ステップを対象とする。
 *
 * テストケース:
 *   1. 正常系: Section visual embedding が生成される
 *   2. スキップ: screenshotBase64 が存在しない場合
 *   3. スキップ: height < 10px のセクション
 *   4. Graceful Degradation: DINOv2 初期化失敗
 *   5. Graceful Degradation: 個別 section の crop 失敗
 *   6. NaN/Infinity チェック
 *   7. DINOv2 共用: Section + Part 両方で使用（1回だけ init / dispose）
 *
 * @module tests/workers/page-analyze-worker-section-visual-embedding
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ==========================================================================
// ソースコード構造テスト（source code analysis approach）
// processEmbeddingPhase は ~54K文字の大関数のため、スライスサイズに注意。
// - processEmbeddingPhase 全体を検索: fnStart + 55000
// - Section Visual Embedding ブロックのみ: fnStart + 9000
// ==========================================================================

/** processEmbeddingPhase 全体のスライスサイズ（~73K文字、acquireSectionCropBuffer抽出+動的Fallback追加分を含む） */
const EMBEDDING_PHASE_SLICE = 75000;
/** Section Visual Embedding ブロックのスライスサイズ（processEmbeddingPhase内、PII+セクション取得まで） */
const SECTION_VISUAL_SLICE = 70000;
/** processSingleSectionVisualEmbedding サブ関数のスライスサイズ（巨大関数分解で移動したセクション単位処理ロジック） */
const SINGLE_SECTION_SLICE = 10000;

describe("PageAnalyzeWorker - Section Visual Embedding (DINOv2)", () => {
  // After TDA-C1 refactoring, processEmbeddingPhase and visual embedding logic
  // moved to phase-5-embedding.ts. Types/helpers (EmbeddingPhaseParams, EmbeddingPhaseResult,
  // acquireSectionCropBuffer, isDuplicateVisionEmbedding) are in phases/types.ts.
  // processPageAnalyzeJob (result propagation) remains in the orchestrator.
  const phase5Path = path.resolve(__dirname, "../../src/workers/phases/phase-5-embedding.ts");
  const typesPath = path.resolve(__dirname, "../../src/workers/phases/types.ts");
  const orchestratorPath = path.resolve(__dirname, "../../src/workers/page-analyze-worker.ts");

  let workerSource: string;

  beforeEach(() => {
    workerSource =
      fs.readFileSync(typesPath, "utf8") +
      "\n" +
      fs.readFileSync(phase5Path, "utf8") +
      "\n" +
      fs.readFileSync(orchestratorPath, "utf8");
  });

  // ========================================================================
  // 1. 正常系: Section visual embedding が生成される
  // ========================================================================
  describe("正常系: Section visual embedding 生成", () => {
    it("should have Section Visual Embedding step in processEmbeddingPhase", () => {
      // processEmbeddingPhase 関数内に Section Visual Embedding セクションが存在する
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(fnBody).toContain("Section Visual Embedding");
      expect(fnBody).toContain("DINOv2");
    });

    it("should query section_embeddings with null vision_embedding via raw SQL", () => {
      // vision_embedding が NULL のレコードを raw SQL で取得する
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      const fnBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(fnBody).toContain("vision_embedding IS NULL");
      expect(fnBody).toContain("text_embedding IS NOT NULL");
      expect(fnBody).toContain("section_embeddings");
    });

    it("should use $queryRawUnsafe to fetch sections needing visual embedding", () => {
      // Prisma では Unsupported("vector") カラムのフィルタリングができないため
      // $queryRawUnsafe を使用する
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      expect(fnStart).toBeGreaterThan(-1);
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("$queryRawUnsafe");
    });

    it("should increment sectionVisualEmbeddingsGenerated on success", () => {
      // After TDA-C1 refactoring, per-section logic moved to processSingleSectionVisualEmbedding.
      // generatedCount is accumulated per section and aggregated by processSectionVisualEmbeddingLoop.
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const singleBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);
      expect(singleBody).toContain("result.generated++");
    });

    it("should update vision_embedding in DB via $executeRawUnsafe", () => {
      // UPDATE section_embeddings SET vision_embedding = ... を raw SQL で実行
      // After TDA-C1 refactoring, DB update logic moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const singleBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);
      expect(singleBody).toContain("$executeRawUnsafe");
      expect(singleBody).toContain("UPDATE section_embeddings");
      expect(singleBody).toContain("vision_embedding");
      expect(singleBody).toContain("vector(768)");
    });

    it("should use layoutInfo.position (startY, height) for section crop coordinates", () => {
      // section_patterns の layoutInfo.position から startY, height を取得してクロップ
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("startY");
      expect(sectionVisualBody).toContain("height");
      expect(sectionVisualBody).toContain("sectionPositionMap");
    });

    it("should crop section region as full width (x=0, width=imgWidth)", () => {
      // セクションはページ全幅を占めるため、x=0, width=imgWidth で crop する
      // acquireSectionCropBuffer ヘルパー関数に抽出済み
      const fnStart = workerSource.indexOf("acquireSectionCropBuffer");
      const cropBody = workerSource.slice(fnStart, fnStart + 3000);
      expect(cropBody).toContain("sectionLeft = 0");
      expect(cropBody).toContain("imgWidth");
    });

    it("should resize cropped image to DINOV2_INPUT_SIZE for DINOv2 inference", () => {
      // DINOv2 の入力サイズ（224x224）にリサイズする
      // acquireSectionCropBuffer ヘルパー関数に抽出済み
      const fnStart = workerSource.indexOf("acquireSectionCropBuffer");
      const cropBody = workerSource.slice(fnStart, fnStart + 3000);
      expect(cropBody).toContain("dinov2InputSize");
      expect(cropBody).toContain("resize");
      expect(cropBody).toContain("removeAlpha");
    });

    it("should call generateVisualEmbedding with dinov2Service and rawCropBuffer", () => {
      // generateVisualEmbedding を使って DINOv2 で推論する
      // acquireSectionCropBuffer 抽出後は cropResult.rawCropBuffer を渡す
      // After TDA-C1 refactoring, per-section embedding call moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const singleBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);
      expect(singleBody).toContain("generateVisualEmbedding(");
      expect(singleBody).toContain("p.dinov2Service");
      expect(singleBody).toContain("cropResult.rawCropBuffer");
    });

    it("should extend job lock for embedding-sections-visual sub-phase", () => {
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain('"embedding-sections-visual"');
    });
  });

  // ========================================================================
  // 2. スキップ: screenshotBase64 が存在しない場合
  // ========================================================================
  describe("スキップ: screenshotBase64 が存在しない場合", () => {
    it("should guard visual embedding with screenshotBuffer null check in runVisualEmbeddingSubPhases", () => {
      // screenshotBuffer が null の場合、runVisualEmbeddingSubPhases は早期 return
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 5000);
      expect(fnBody).toContain("if (!screenshotBuffer) return vResult");
    });

    it("sectionVisualEmbeddingsGenerated should initialize to 0", () => {
      // screenshotBase64 なしの場合は初期値 0 のまま返却される
      expect(workerSource).toContain("sectionVisualEmbeddingsGenerated: 0,");
    });

    it("EmbeddingPhaseResult should include sectionVisualEmbeddingsGenerated field", () => {
      // PR-D-2: widened slice from 800 → 1600 bytes to accommodate
      // partVisualSkippedBboxInvalid field + extensive JSDoc (ADR-0018 §Decision 3
      // Amendment, INV-EMBEDDING-INTEGRITY-005).
      //
      // PR-D-2: widened slice from 800 → 1600 bytes to accommodate the new
      // partVisualSkippedBboxInvalid field and its extensive JSDoc.
      const resultSection = workerSource.slice(
        workerSource.indexOf("interface EmbeddingPhaseResult"),
        workerSource.indexOf("interface EmbeddingPhaseResult") + 1600
      );
      expect(resultSection).toContain("sectionVisualEmbeddingsGenerated: number");
    });
  });

  // ========================================================================
  // 3. スキップ: height < 10px のセクション
  // ========================================================================
  describe("スキップ: height < 10px のセクション", () => {
    it("should skip sections with height less than 10px", () => {
      // 10px 未満のセクションはスキップされる（意味のあるvisual featureを持たないため）
      // After TDA-C1 refactoring, per-section skip logic moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const singleBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);
      expect(singleBody).toContain("sectionPos.height < 10");
    });

    it("should skip sections with no position data", () => {
      // sectionPositionMap からポジションが取得できない場合もスキップ
      // After TDA-C1 refactoring, per-section skip logic moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const singleBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);
      expect(singleBody).toContain("!sectionPos");
    });

    it("should skip sections where crop region is invalid (out of bounds)", () => {
      // sectionTop >= p.imgHeight の場合はフォールバックパスへ
      // After TDA-C1 refactoring, per-section logic moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const singleBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);
      expect(singleBody).toContain("sectionTop >= p.imgHeight");
    });
  });

  // ========================================================================
  // 4. Graceful Degradation: DINOv2 初期化失敗
  // ========================================================================
  describe("Graceful Degradation: DINOv2 初期化失敗", () => {
    it("should have outer try-catch for entire visual embedding block", () => {
      // DINOv2 初期化（new DINOv2Service + initialize()）が失敗しても
      // processEmbeddingPhase 全体は成功する（Graceful Degradation）
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      const fnBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      // visual embedding 失敗は non-fatal
      expect(fnBody).toContain("DINOv2 visual embedding failed (non-fatal)");
    });

    it("should increment embeddingFailedChunks on visual embedding failure in fork child", () => {
      // DINOv2 初期化失敗時に embeddingFailedChunks をインクリメント
      // In fork path, this happens in runVisualEmbeddingSubPhases
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);
      expect(fnBody).toContain("embeddingFailedChunks++");
    });

    it("should mark embedding phase as completed even when visual embedding fails", () => {
      // Graceful Degradation: Phase 5 overall failure is caught in page-analyze-worker.ts
      // and marked as partialSuccess. The fork orchestrator handles errors per-child.
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);
      // The function returns a result even on partial failure (non-fatal catch blocks)
      expect(fnBody).toContain("return vResult");
    });

    it("should have separate try-catch for section visual embedding vs part visual embedding", () => {
      // section visual embedding 固有の Graceful Degradation
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      const fnBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(fnBody).toContain("Section DINOv2 visual embedding failed (non-fatal)");
    });
  });

  // ========================================================================
  // 5. Graceful Degradation: 個別 section の crop 失敗
  // ========================================================================
  describe("Graceful Degradation: 個別 section の crop 失敗", () => {
    it("should have per-section try-catch for crop and embedding", () => {
      // 個別のセクションで crop/DINOv2 推論が失敗しても、他のセクションは処理される
      // After TDA-C1 refactoring, per-section try-catch moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const singleBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);
      expect(singleBody).toContain("DINOv2 visual embedding failed for section (non-fatal)");
    });

    it("should continue processing other sections after one section fails", () => {
      // per-section の catch 後も、ループ内の try-catch で吸収されて次のセクションに進む
      // After TDA-C1 refactoring, the loop calls processSingleSectionVisualEmbedding per section
      const fnStart = workerSource.indexOf("for (const section of chunk)");
      expect(fnStart).toBeGreaterThan(-1);
      // processSingleSectionVisualEmbedding has its own try-catch
      const singleFnStart = workerSource.indexOf(
        "async function processSingleSectionVisualEmbedding"
      );
      const singleBody = workerSource.slice(singleFnStart, singleFnStart + SINGLE_SECTION_SLICE);
      expect(singleBody).toContain("try");
      expect(singleBody).toContain("catch (sectionVisualError)");
      expect(singleBody).toContain("non-fatal");
    });

    it("should log truncated sectionEmbeddingId for PII safety", () => {
      // PII対策: sectionEmbeddingId を truncate してログ出力（truncateId パターン）
      // After TDA-C1 refactoring, per-section logging moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const singleBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);
      expect(singleBody).toContain('section.id.slice(0, 8) + "..."');
    });
  });

  // ========================================================================
  // 6. NaN/Infinity チェック
  // ========================================================================
  describe("NaN/Infinity チェック", () => {
    it("should call generateVisualEmbedding which validates NaN/Infinity", () => {
      // generateVisualEmbedding 内部で validateEmbeddingFinite が呼ばれる
      // NaN/Infinity が検出された場合 throw され、per-section try-catch でキャッチされる
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("generateVisualEmbedding");
    });

    it("generateVisualEmbedding should validate NaN/Infinity in source", () => {
      // generateVisualEmbedding の実装で validateEmbeddingFinite が呼ばれていることを確認
      const partEmbeddingServicePath = path.resolve(
        __dirname,
        "../../src/services/part/part-embedding.service.ts"
      );
      const partEmbeddingSource = fs.readFileSync(partEmbeddingServicePath, "utf8");

      const fnStart = partEmbeddingSource.indexOf("async function generateVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = partEmbeddingSource.slice(fnStart, fnStart + 500);
      expect(fnBody).toContain("validateEmbeddingFinite");
    });

    it("validateEmbeddingFinite should throw on NaN or Infinity", () => {
      // validateEmbeddingFinite が Number.isFinite でチェックし、NaN/Infinity で throw する
      const partEmbeddingServicePath = path.resolve(
        __dirname,
        "../../src/services/part/part-embedding.service.ts"
      );
      const partEmbeddingSource = fs.readFileSync(partEmbeddingServicePath, "utf8");
      expect(partEmbeddingSource).toContain("Number.isFinite");
      expect(partEmbeddingSource).toContain("contains NaN or Infinity");
    });

    it("NaN/Infinity error in generateVisualEmbedding should be caught by per-section try-catch", () => {
      // NaN を含むベクトルが返された場合、generateVisualEmbedding が throw する
      // これは per-section の try-catch でキャッチされ、そのセクションだけスキップされる
      // After TDA-C1 refactoring, per-section logic moved to processSingleSectionVisualEmbedding
      const fnStart = workerSource.indexOf("async function processSingleSectionVisualEmbedding");
      expect(fnStart).toBeGreaterThan(-1);
      const singleBody = workerSource.slice(fnStart, fnStart + SINGLE_SECTION_SLICE);
      expect(singleBody).toContain("generateVisualEmbedding(");
      expect(singleBody).toContain("cropResult.rawCropBuffer");
      expect(singleBody).toContain("catch (sectionVisualError)");
    });
  });

  // ========================================================================
  // 7. DINOv2 共用: Section + Part 両方で使用（1回だけ init / dispose）
  // ========================================================================
  describe("DINOv2 共用: Section + Part 両方で使用", () => {
    it("DINOv2Service should be initialized once in runVisualEmbeddingSubPhases", () => {
      // DINOv2Service は runVisualEmbeddingSubPhases 内で 1 回だけ初期化される
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);

      expect(fnBody).toContain("new DINOv2Service");
      expect(fnBody).toContain("await dinov2Service.initialize()");
    });

    it("DINOv2Service should be disposed in finally block after visual embedding", () => {
      // DINOv2 dispose は finally ブロックで 1 回だけ実行される
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);

      expect(fnBody).toContain("await dinov2Service.dispose()");
    });

    it("Section Visual Embedding should appear before Part Visual Embedding in source", () => {
      // Section visual -> Part visual の順に実行される
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);
      const sectionVisualPos = fnBody.indexOf("Section Visual Embedding");
      const partVisualPos = fnBody.indexOf("Part Visual Embedding");
      expect(sectionVisualPos).toBeGreaterThan(-1);
      expect(partVisualPos).toBeGreaterThan(-1);
      expect(sectionVisualPos).toBeLessThan(partVisualPos);
    });

    it("should use same dinov2Service instance for both Section and Part", () => {
      // Section と Part で同じ dinov2Service インスタンスを使用する
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);

      const initPos = fnBody.indexOf("const dinov2Service = new DINOv2Service");
      const sectionUsePos = fnBody.indexOf("processSectionVisualEmbeddingLoop");
      const partUsePos = fnBody.indexOf("processPartVisualEmbeddingLoop");

      expect(initPos).toBeGreaterThan(-1);
      expect(sectionUsePos).toBeGreaterThan(initPos);
      expect(partUsePos).toBeGreaterThan(sectionUsePos);
    });

    it("DINOv2Service initialization count should be exactly 1 in runVisualEmbeddingSubPhases", () => {
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);

      const initMatches = fnBody.match(/new DINOv2Service/g);
      expect(initMatches).not.toBeNull();
      expect(initMatches!.length).toBe(1);
    });

    it("dinov2Service.dispose() should be called in runVisualEmbeddingSubPhases", () => {
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);

      const disposeMatches = fnBody.match(/dinov2Service\.dispose\(\)/g);
      expect(disposeMatches).not.toBeNull();
      expect(disposeMatches!.length).toBeGreaterThanOrEqual(1);
    });

    it("should have GC call between section and part visual embedding", () => {
      // fork path: runVisualEmbeddingSubPhases has tryGarbageCollect between section and part
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);
      expect(fnBody).toContain("tryGarbageCollect()");
    });
  });

  // ========================================================================
  // 追加: Section Visual Embedding の構造テスト
  // ========================================================================
  describe("構造テスト: chunk 処理とメモリ管理", () => {
    it("should process sections in chunks with EMBEDDING_CHUNK_SIZE", () => {
      // チャンク単位で処理する（メモリ管理のため）— サブ関数 processSectionVisualEmbeddingLoop 内
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      expect(fnStart).toBeGreaterThan(-1);
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("sectionVisualChunkSize");
    });

    it("should check memory pressure per chunk and reduce chunk size under pressure", () => {
      // メモリ圧迫時にチャンクサイズを縮小する — サブ関数 processSectionVisualEmbeddingLoop 内
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("checkMemoryPressure");
      expect(sectionVisualBody).toContain("shouldDegrade");
      expect(sectionVisualBody).toContain("sectionVisualChunkSize / 2");
    });

    it("should abort section visual embedding on critical memory pressure", () => {
      // shouldAbort が true の場合、section visual embedding を中断する — サブ関数内
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("shouldAbort");
      expect(sectionVisualBody).toContain("Critical memory, stopping section visual embedding");
    });

    it("should perform inter-chunk GC between section visual embedding chunks", () => {
      // チャンク間の GC 回復
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("tryGarbageCollect");
    });

    it("should use sharp to extract and resize section crops", () => {
      // Sharp で crop -> resize -> removeAlpha -> raw 変換
      // acquireSectionCropBuffer ヘルパー関数に抽出済み
      const fnStart = workerSource.indexOf("async function acquireSectionCropBuffer");
      expect(fnStart).toBeGreaterThan(-1);
      const cropBody = workerSource.slice(fnStart, fnStart + 3000);
      expect(cropBody).toContain("sharp(screenshotBuffer)");
      expect(cropBody).toContain(".extract(");
      expect(cropBody).toContain(".resize(");
      expect(cropBody).toContain(".removeAlpha()");
      expect(cropBody).toContain('.toColorspace("srgb")');
      expect(cropBody).toContain(".raw()");
      expect(cropBody).toContain(".toBuffer()");
    });

    it("should query section_patterns by webPageId to get position data", () => {
      // section_patterns から layoutInfo.position を取得するクエリ
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("prisma.sectionPattern.findMany");
      expect(sectionVisualBody).toContain("layoutInfo");
    });

    it("should clamp crop coordinates to image boundaries", () => {
      // crop 座標を画像の境界内にクランプする
      // acquireSectionCropBuffer ヘルパー関数に抽出済み
      const fnStart = workerSource.indexOf("async function acquireSectionCropBuffer");
      expect(fnStart).toBeGreaterThan(-1);
      const cropBody = workerSource.slice(fnStart, fnStart + 3000);
      // Math.max / Math.min でクランプ
      expect(cropBody).toContain("Math.max(0");
      expect(cropBody).toContain("Math.min(");
    });
  });

  // ========================================================================
  // 追加: EmbeddingPhaseParams の screenshotBase64 フィールド
  // ========================================================================
  describe("EmbeddingPhaseParams に screenshotBase64 が含まれる", () => {
    it("should include screenshotBase64 as optional string field", () => {
      const paramsSection = workerSource.slice(
        workerSource.indexOf("interface EmbeddingPhaseParams"),
        workerSource.indexOf("interface EmbeddingPhaseParams") + 2000
      );
      expect(paramsSection).toContain("screenshotBase64");
    });

    it("should include screenshotPngPath for fork-based visual embedding", () => {
      // In fork path, visual embedding child reads screenshot from screenshotPngPath
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 2000);
      expect(fnBody).toContain("screenshotPngPath");
    });
  });

  // ========================================================================
  // 追加: hasSections 条件分岐
  // ========================================================================
  describe("hasSections 条件分岐", () => {
    it("should define hasSections from sectionIdMapping.size in runVisualEmbeddingSubPhases", () => {
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);
      expect(fnBody).toContain("hasSections");
      expect(fnBody).toContain("sectionIdMapping");
    });

    it("should only execute Section Visual Embedding when hasSections is true", () => {
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);
      expect(fnBody).toContain("if (hasSections)");
    });
  });

  // ========================================================================
  // 追加: screenshotMeta（screenshot dimensions）の共有
  // ========================================================================
  describe("screenshotMeta（画像サイズ）の Section + Part 共有", () => {
    it("should retrieve screenshot dimensions via sharp metadata before Section visual embedding", () => {
      // screenshotMeta は Section + Part の両方で使用される
      const fnStart = workerSource.indexOf("async function processSectionVisualEmbeddingLoop");
      const fnBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(fnBody).toContain("screenshotMeta");
      expect(fnBody).toContain("sharp(screenshotBuffer).metadata()");
      expect(fnBody).toContain("imgWidth");
      expect(fnBody).toContain("imgHeight");
    });

    it("should use shared imgWidth and imgHeight for section crop calculations", () => {
      // Section Visual Embedding で imgWidth, imgHeight を使用する
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("imgWidth");
      expect(sectionVisualBody).toContain("imgHeight");
    });

    it("screenshot metadata retrieval should appear before Section Visual Embedding in runVisualEmbeddingSubPhases", () => {
      // In fork path, metadata is retrieved in runVisualEmbeddingSubPhases
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart, fnStart + 20000);
      const metadataPos = fnBody.indexOf("sharp(screenshotBuffer).metadata()");
      const sectionVisualPos = fnBody.indexOf("processSectionVisualEmbeddingLoop");
      expect(metadataPos).toBeGreaterThan(-1);
      expect(sectionVisualPos).toBeGreaterThan(-1);
      expect(metadataPos).toBeLessThan(sectionVisualPos);
    });
  });

  // ========================================================================
  // PII保護: piiRiskLevel='high' セクション除外
  // ========================================================================
  describe("PII保護: piiRiskLevel=high セクションの除外", () => {
    it("should query component_parts for piiRiskLevel=high before section visual embedding", () => {
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("pii_risk_level = 'high'");
    });

    it("should filter out sections containing high PII parts", () => {
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("highPiiSectionIdSet");
      expect(sectionVisualBody).toContain("sectionsFiltered");
    });

    it("should use sectionsFiltered (not sectionsNeedingVisual) in the processing loop", () => {
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      // Processing loop should iterate over filtered sections
      expect(sectionVisualBody).toContain("sectionsFiltered.length");
    });

    it("PII check should appear before the section visual embedding processing loop", () => {
      // PII check は runVisualEmbeddingSubPhases 内、processSectionVisualEmbeddingLoop 呼び出し前に実行される
      const fnStart = workerSource.indexOf("async function runVisualEmbeddingSubPhases");
      expect(fnStart).toBeGreaterThan(-1);
      const embeddingBody = workerSource.slice(fnStart, fnStart + 20000);
      const piiCheckPos = embeddingBody.indexOf("pii_risk_level = 'high'");
      expect(piiCheckPos).toBeGreaterThan(-1);
      // processSectionVisualEmbeddingLoop 呼び出しがPII check より後にある
      const loopCallPos = embeddingBody.indexOf("processSectionVisualEmbeddingLoop");
      expect(loopCallPos).toBeGreaterThan(-1);
      expect(piiCheckPos).toBeLessThan(loopCallPos);
    });

    it("should log PII-skipped section count", () => {
      const fnStart = workerSource.indexOf("Section Visual Embedding");
      const sectionVisualBody = workerSource.slice(fnStart, fnStart + SECTION_VISUAL_SLICE);
      expect(sectionVisualBody).toContain("highPiiSectionIdSet.size");
    });
  });

  // ========================================================================
  // 追加: 結果伝播テスト（processPageAnalyzeJob への結果反映）
  // ========================================================================
  describe("結果伝播: sectionVisualEmbeddingsGenerated の処理", () => {
    it("processPageAnalyzeJob should propagate sectionVisualEmbeddingsGenerated to final result", () => {
      const fnStart = workerSource.indexOf("function processPageAnalyzeJob");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = workerSource.slice(fnStart);
      expect(fnBody).toContain("sectionVisualEmbeddingsGenerated");
    });

    it("should include sectionVisualEmbeddingsGenerated in visual embedding count check", () => {
      // embeddingPhaseResult.sectionVisualEmbeddingsGenerated > 0 のチェック
      const fnStart = workerSource.indexOf("function processPageAnalyzeJob");
      const fnBody = workerSource.slice(fnStart);
      expect(fnBody).toContain("embeddingPhaseResult.sectionVisualEmbeddingsGenerated > 0");
    });
  });
});
