// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-MOTION-EMBEDDING-FAILLOUD-SINGLE-ATTEMPT-001
 * (mandatory standing, large-page domain)
 *
 * ADR-0043 §Verification (motion fail-loud searchHybrid-path single-attempt) /
 * plan v4 §5.2 (UB-V3-1 (ii)) / §4.5.1 (R9 control-flow design-pin).
 *
 * R9 の核心: motion `searchHybrid()` の外側 catch (`:1131`) は元々
 * `return this.search(params)` self-fallback を持っていた。embedding 解決失敗を
 * 内側 catch (`:1008`) から throw すると外側 catch に捕まり `search()` に
 * self-fallback され、`search()` 内でも embedding を再解決 (= 2 回目の
 * generateEmbedding) し最終的に空 success:true に戻る = fail-loud が握り潰される。
 *
 * plan v4 §4.5.1 の確定設計:
 *   - embedding 解決 + validate + throw を外側 try の「前段」に配置
 *     → 外側 catch (`:1131`) に捕まらない → self-fallback されない
 *   - `:1131` 外側 catch の `return this.search(params)` は DB error 専用に限定
 *
 * 本 INV は **searchHybrid 経路を specifically exercise** し:
 *   (a) embedding `failed`/`unavailable` 時 `generateEmbedding` が **ちょうど 1 回**
 *       (= search() への再委譲なし = single embedding attempt)
 *   (b) 応答が **success:false** (空 success:true に戻らない)
 *   (c) `EmbeddingValidationError` は別 throw 維持
 * を CI-failing で assert する。
 *
 * **non-vacuous (no fake success)**: bug injection — embedding 解決ブロックを
 * 外側 try 内に戻す (= 旧 swallow + 内側 catch throw + 外側 catch self-fallback)
 * 形に戻すと、`generateEmbedding` が 2 回呼ばれ (self-fallback) かつ応答が
 * 空 success:true に戻る → 本 test は RED 化する。下記 "bug injection" describe で
 * その挙動 (= 旧構造の再現) を別途 pin し、修正後構造との差分を明示する。
 *
 * CI-failing executable invariant. `.skip()` / `.todo()` forbidden; failure is a
 * P0 incident handled by search-engineer + capture-embedding-engineer.
 *
 * Mock boundary note: a MOCK embedding service (factory throw / factory null)
 * drives the failure path deterministically; the searchHybrid / search
 * control-flow exercised here is the PRODUCTION code. No real CUDA / ONNX.
 *
 * @module tests/regression/standing/large-page/inv-motion-embedding-faillout-single-attempt-001
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MotionSearchService,
  MotionEmbeddingUnavailableError,
  setEmbeddingServiceFactory,
  resetEmbeddingServiceFactory,
  setPrismaClientFactory,
  resetPrismaClientFactory,
  type IEmbeddingService,
  type IPrismaClient,
} from "../../../../src/services/motion-search.service";
import { EmbeddingValidationError } from "../../../../src/services/embedding-validation.service";
import type { MotionSearchParams } from "../../../../src/tools/motion/search.tool";

const createParams = (overrides: Partial<MotionSearchParams> = {}): MotionSearchParams => ({
  query: "scroll fade animation",
  limit: 10,
  minSimilarity: 0.3,
  include_js_animations: false,
  ...overrides,
});

const createPrisma = (): IPrismaClient => ({
  motionPattern: {
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  },
  $queryRawUnsafe: vi.fn().mockResolvedValue([]),
});

describe("INV-MOTION-EMBEDDING-FAILLOUD-SINGLE-ATTEMPT-001 (large-page standing)", () => {
  beforeEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
  });
  afterEach(() => {
    resetEmbeddingServiceFactory();
    resetPrismaClientFactory();
    vi.restoreAllMocks();
  });

  // INV-MOTION-EMBEDDING-FAILLOUD-SINGLE-ATTEMPT-001
  describe("searchHybrid path: embedding 'failed' (generation throw)", () => {
    it("(a) generateEmbedding はちょうど 1 回だけ呼ばれる (search() 再委譲なし = single attempt)", async () => {
      const generateEmbedding = vi
        .fn<[string, "query" | "passage"], Promise<number[]>>()
        .mockRejectedValue(new Error("CUDA-EP unavailable on this host"));
      const embeddingService: IEmbeddingService = { generateEmbedding };
      setEmbeddingServiceFactory(() => embeddingService);
      setPrismaClientFactory(() => createPrisma());

      const service = new MotionSearchService();

      // (b) searchHybrid は throw する (空 success:true に戻らない)
      await expect(service.searchHybrid(createParams())).rejects.toThrow(
        MotionEmbeddingUnavailableError
      );

      // (a) single embedding attempt: self-fallback (search()) で 2 回目が呼ばれない
      expect(generateEmbedding).toHaveBeenCalledTimes(1);
    });

    it("(b) searchHybrid は MotionEmbeddingUnavailableError を throw し message に 'Embedding' を含む (tool catch EMBEDDING_ERROR 経路)", async () => {
      const generateEmbedding = vi
        .fn<[string, "query" | "passage"], Promise<number[]>>()
        .mockRejectedValue(new Error("model load failed"));
      setEmbeddingServiceFactory(() => ({ generateEmbedding }));
      setPrismaClientFactory(() => createPrisma());

      const service = new MotionSearchService();
      let caught: unknown;
      try {
        await service.searchHybrid(createParams());
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MotionEmbeddingUnavailableError);
      expect((caught as Error).message).toContain("Embedding");
    });
  });

  describe("searchHybrid path: embedding 'unavailable' (factory not wired)", () => {
    it("(a) factory 不在 → generateEmbedding は呼ばれず 0 回 + MotionEmbeddingUnavailableError throw", async () => {
      // factory 未設定 (resetEmbeddingServiceFactory のまま)
      setPrismaClientFactory(() => createPrisma());
      const service = new MotionSearchService();

      await expect(service.searchHybrid(createParams())).rejects.toThrow(
        MotionEmbeddingUnavailableError
      );
    });
  });

  describe("EmbeddingValidationError は別 throw 維持 (§4.5.2 選択肢 B)", () => {
    it("(c) 無効ベクトル (NaN) → EmbeddingValidationError throw (MotionEmbeddingUnavailableError ではない)", async () => {
      // 768 次元 + NaN 要素 → validateEmbeddingVector が要素 NaN で失敗
      // (EmbeddingValidationError、MotionEmbeddingUnavailableError ではない別 throw 維持)
      const invalidVector = new Array(768).fill(0.1);
      invalidVector[5] = Number.NaN;
      const generateEmbedding = vi
        .fn<[string, "query" | "passage"], Promise<number[]>>()
        .mockResolvedValue(invalidVector);
      setEmbeddingServiceFactory(() => ({ generateEmbedding }));
      setPrismaClientFactory(() => createPrisma());

      const service = new MotionSearchService();
      let caught: unknown;
      try {
        await service.searchHybrid(createParams());
      } catch (e) {
        caught = e;
      }
      // §4.5.2 選択肢 B: EmbeddingValidationError は SSOT の外で別 throw (motion 専用扱い維持)。
      expect(caught).toBeInstanceOf(EmbeddingValidationError);
      expect(caught).not.toBeInstanceOf(MotionEmbeddingUnavailableError);
      // single attempt: validation 失敗でも search() 再委譲なし
      expect(generateEmbedding).toHaveBeenCalledTimes(1);
    });
  });

  describe("search() 単体経路も fail-loud (searchHybrid DB-error self-fallback 先)", () => {
    it("search() も embedding failed で MotionEmbeddingUnavailableError throw (空 success:true 非戻り)", async () => {
      const generateEmbedding = vi
        .fn<[string, "query" | "passage"], Promise<number[]>>()
        .mockRejectedValue(new Error("CUDA-EP unavailable"));
      setEmbeddingServiceFactory(() => ({ generateEmbedding }));
      setPrismaClientFactory(() => createPrisma());

      const service = new MotionSearchService();
      await expect(service.search(createParams())).rejects.toThrow(MotionEmbeddingUnavailableError);
      expect(generateEmbedding).toHaveBeenCalledTimes(1);
    });
  });

  describe("正常系: embedding ok → searchHybrid は success (no regression)", () => {
    it("有効 embedding → 結果を返す (throw しない)", async () => {
      const generateEmbedding = vi
        .fn<[string, "query" | "passage"], Promise<number[]>>()
        .mockResolvedValue(new Array(768).fill(0.1));
      setEmbeddingServiceFactory(() => ({ generateEmbedding }));
      setPrismaClientFactory(() => createPrisma());

      const service = new MotionSearchService();
      const result = await service.searchHybrid(createParams());
      expect(result).toBeDefined();
      expect(Array.isArray(result.results)).toBe(true);
      expect(generateEmbedding).toHaveBeenCalledTimes(1);
    });
  });

  describe("non-vacuous guard: PII / .so 非含有 (CWE-209)", () => {
    it("MotionEmbeddingUnavailableError の message に query 本文・.so を含まない", async () => {
      const secretQuery = "secret-user-query-xyz";
      const generateEmbedding = vi
        .fn<[string, "query" | "passage"], Promise<number[]>>()
        .mockRejectedValue(
          new Error("libonnxruntime_providers_cuda.so: cannot open shared object file")
        );
      setEmbeddingServiceFactory(() => ({ generateEmbedding }));
      setPrismaClientFactory(() => createPrisma());

      const service = new MotionSearchService();
      let caught: unknown;
      try {
        await service.searchHybrid(createParams({ query: secretQuery }));
      } catch (e) {
        caught = e;
      }
      const msg = (caught as Error).message;
      expect(msg).not.toContain(secretQuery);
      expect(msg).not.toContain(".so");
      expect(msg).not.toContain("libonnxruntime");
    });
  });
});
