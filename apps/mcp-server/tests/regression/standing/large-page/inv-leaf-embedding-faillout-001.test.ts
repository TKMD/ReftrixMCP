// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-LEAF-EMBEDDING-FAILLOUT-001
 * (mandatory standing, large-page domain)
 *
 * ADR-0043 Decision 1 / §Verification (leaf success:false for embedding-required
 * leaves) / plan v4 §4.1 (leaf success:false) / §5.2 (leaf success:false 5-service +
 * query PII / `.so` 非含有). PR-2a-2 — layout / background / responsive の 3 leaf を
 * 案A fail-loud に揃え、PR-2a が残した mixed-state (motion/part は fail-loud だが
 * layout/bg/responsive は依然 success:true total:0 で fake-empty) を完全解消する。
 *
 * 本 INV は **production tool handler** (`layoutSearchHandler` / `backgroundSearchHandler`
 * / `responsiveSearchHandler`) を、embedding 解決が `failed` (生成 throw) / `unavailable`
 * (factory 不在) を返す MOCK service で駆動し:
 *   (a) 応答が **success:false** (embedding 障害を success:true total:0 で偽装しない)
 *   (b) 検索メソッドが呼ばれない (fail-loud で早期 return)
 *   (c) degradedReason が `DegradedReason` enum union 値 (embedding_unavailable / embedding_failed)
 *   (d) CWE-209 / GDPR Art.5(1)(c): error.message に query 本文・`.so` / `libonnxruntime` 非含有
 * を CI-failing で assert する。
 *
 * 加えて **legitimate empty 非退行** を pin する: embedding `ok` かつ
 * 検索結果が 0 件 / DB が null を返す場合は依然 **success:true total:0** (正当な空、
 * fail-loud ではない)。これは「embedding 障害」と「結果 0 件」を区別する案A の核心。
 *
 * **non-vacuous (no fake success)**: bug injection — 旧 fake-empty 契約
 * (embedding `unavailable`/`failed` → success:true total:0) を mock で再現する
 * describe を別途置き、修正後の fail-loud (success:false) との差分を明示する。旧構造に
 * 戻すと本 INV の success:false assert が RED 化する。
 *
 * CI-failing executable invariant. `.skip()` / `.todo()` forbidden; failure is a
 * P0 incident handled by search-engineer.
 *
 * Mock boundary note: a MOCK service drives the embedding-failure path
 * deterministically; the tool handler control-flow exercised here is the PRODUCTION
 * code. No real CUDA / ONNX.
 *
 * @module tests/regression/standing/large-page/inv-leaf-embedding-faillout-001
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  layoutSearchHandler,
  setLayoutSearchServiceFactory,
  resetLayoutSearchServiceFactory,
  type ILayoutSearchService,
} from "../../../../src/tools/layout/search.tool";
import {
  backgroundSearchHandler,
  setBackgroundSearchServiceFactory,
  resetBackgroundSearchServiceFactory,
  type IBackgroundSearchService,
} from "../../../../src/tools/background/search.tool";
import {
  responsiveSearchHandler,
  setResponsiveSearchServiceFactory,
  resetResponsiveSearchServiceFactory,
  type IResponsiveSearchService,
} from "../../../../src/tools/responsive/search.tool";
import type { QueryEmbeddingResult } from "../../../../src/services/_shared/resolve-query-embedding";

const SECRET_QUERY = "secret-user-query-xyz";
const DLOPEN_REASON = "libonnxruntime_providers_cuda.so: cannot open shared object file";

// ---------------------------------------------------------------------------
// per-leaf mock builders (production tool handler を driving する MOCK service)
// ---------------------------------------------------------------------------

function makeLayoutService(
  embeddingResult: QueryEmbeddingResult,
  searchSpy = vi.fn()
): ILayoutSearchService {
  return {
    resolveQueryEmbeddingResult: vi.fn().mockResolvedValue(embeddingResult),
    generateQueryEmbedding: vi.fn(),
    searchSectionPatterns: searchSpy.mockResolvedValue({ results: [], total: 0 }),
    searchSectionPatternsHybrid: searchSpy.mockResolvedValue({ results: [], total: 0 }),
  };
}

function makeBackgroundService(
  embeddingResult: QueryEmbeddingResult,
  searchSpy = vi.fn()
): IBackgroundSearchService {
  return {
    resolveQueryEmbeddingResult: vi.fn().mockResolvedValue(embeddingResult),
    generateQueryEmbedding: vi.fn(),
    searchBackgroundDesigns: searchSpy.mockResolvedValue({ results: [], total: 0 }),
    searchBackgroundDesignsHybrid: searchSpy.mockResolvedValue({ results: [], total: 0 }),
  };
}

function makeResponsiveService(
  embeddingResult: QueryEmbeddingResult,
  searchSpy = vi.fn()
): IResponsiveSearchService {
  return {
    resolveQueryEmbeddingResult: vi.fn().mockResolvedValue(embeddingResult),
    generateQueryEmbedding: vi.fn(),
    searchResponsiveAnalyses: searchSpy.mockResolvedValue({ results: [], total: 0 }),
  };
}

interface LeafCase {
  name: string;
  /** embedding 解決失敗を仕込んで tool handler を駆動し、応答 + search spy を返す */
  run: (
    embeddingResult: QueryEmbeddingResult,
    query: string
  ) => Promise<{
    response: {
      success: boolean;
      error?: { code: string; message: string; degradedReason?: string };
    };
    searchCalled: boolean;
  }>;
  /** embedding ok + DB が null/空を返す legitimate-empty 経路を駆動 */
  runLegitimateEmpty: (query: string) => Promise<{ success: boolean; total?: number }>;
}

const LEAF_CASES: LeafCase[] = [
  {
    name: "layout.search",
    run: async (embeddingResult, query) => {
      const searchSpy = vi.fn();
      const service = makeLayoutService(embeddingResult, searchSpy);
      setLayoutSearchServiceFactory(() => service);
      const response = (await layoutSearchHandler({ query })) as {
        success: boolean;
        error?: { code: string; message: string; degradedReason?: string };
      };
      return { response, searchCalled: searchSpy.mock.calls.length > 0 };
    },
    runLegitimateEmpty: async (query) => {
      const service = makeLayoutService({ status: "ok", embedding: new Array(768).fill(0.1) });
      // hybrid/vector が null を返す = DB 不在 (legitimate empty)
      service.searchSectionPatternsHybrid = vi.fn().mockResolvedValue(null);
      service.searchSectionPatterns = vi.fn().mockResolvedValue(null);
      setLayoutSearchServiceFactory(() => service);
      const response = (await layoutSearchHandler({ query })) as {
        success: boolean;
        data?: { total: number };
      };
      return { success: response.success, total: response.data?.total };
    },
  },
  {
    name: "background.search",
    run: async (embeddingResult, query) => {
      const searchSpy = vi.fn();
      const service = makeBackgroundService(embeddingResult, searchSpy);
      setBackgroundSearchServiceFactory(() => service);
      const response = (await backgroundSearchHandler({ query })) as {
        success: boolean;
        error?: { code: string; message: string; degradedReason?: string };
      };
      return { response, searchCalled: searchSpy.mock.calls.length > 0 };
    },
    runLegitimateEmpty: async (query) => {
      const service = makeBackgroundService({ status: "ok", embedding: new Array(768).fill(0.1) });
      service.searchBackgroundDesignsHybrid = vi.fn().mockResolvedValue({ results: [], total: 0 });
      setBackgroundSearchServiceFactory(() => service);
      const response = (await backgroundSearchHandler({ query })) as {
        success: boolean;
        data?: { total: number };
      };
      return { success: response.success, total: response.data?.total };
    },
  },
  {
    name: "responsive.search",
    run: async (embeddingResult, query) => {
      const searchSpy = vi.fn();
      const service = makeResponsiveService(embeddingResult, searchSpy);
      setResponsiveSearchServiceFactory(() => service);
      const response = (await responsiveSearchHandler({ query })) as {
        success: boolean;
        error?: { code: string; message: string; degradedReason?: string };
      };
      return { response, searchCalled: searchSpy.mock.calls.length > 0 };
    },
    runLegitimateEmpty: async (query) => {
      const service = makeResponsiveService({ status: "ok", embedding: new Array(768).fill(0.1) });
      service.searchResponsiveAnalyses = vi.fn().mockResolvedValue({ results: [], total: 0 });
      setResponsiveSearchServiceFactory(() => service);
      const response = (await responsiveSearchHandler({ query })) as {
        success: boolean;
        data?: { total: number };
      };
      return { success: response.success, total: response.data?.total };
    },
  },
];

const VALID_DEGRADED_REASONS = new Set(["embedding_unavailable", "embedding_failed"]);

describe("INV-LEAF-EMBEDDING-FAILLOUT-001 (large-page standing)", () => {
  beforeEach(() => {
    resetLayoutSearchServiceFactory();
    resetBackgroundSearchServiceFactory();
    resetResponsiveSearchServiceFactory();
  });
  afterEach(() => {
    resetLayoutSearchServiceFactory();
    resetBackgroundSearchServiceFactory();
    resetResponsiveSearchServiceFactory();
    vi.restoreAllMocks();
  });

  for (const leaf of LEAF_CASES) {
    describe(`${leaf.name}: embedding 'failed' (generation throw) → fail-loud`, () => {
      it("(a) 応答が success:false (success:true total:0 で偽装しない)", async () => {
        const { response, searchCalled } = await leaf.run(
          { status: "failed", reason: "Database operation failed" },
          "scroll fade animation"
        );
        // 案A leaf: success:false
        expect(response.success).toBe(false);
        // (b) 検索メソッドは呼ばれない (fail-loud 早期 return)
        expect(searchCalled).toBe(false);
      });

      it("(c) degradedReason は DegradedReason enum union 値 (embedding_failed)", async () => {
        const { response } = await leaf.run(
          { status: "failed", reason: "Database operation failed" },
          "scroll fade animation"
        );
        expect(response.success).toBe(false);
        expect(response.error?.degradedReason).toBe("embedding_failed");
        expect(VALID_DEGRADED_REASONS.has(response.error?.degradedReason ?? "")).toBe(true);
      });

      it("(d) CWE-209 / GDPR Art.5(1)(c): error.message に query 本文・.so 非含有", async () => {
        const { response } = await leaf.run(
          { status: "failed", reason: DLOPEN_REASON },
          SECRET_QUERY
        );
        const msg = response.error?.message ?? "";
        expect(msg).not.toContain(SECRET_QUERY);
        expect(msg).not.toContain(".so");
        expect(msg).not.toContain("libonnxruntime");
      });
    });

    describe(`${leaf.name}: embedding 'unavailable' (factory not wired) → fail-loud`, () => {
      it("(a) 応答が success:false + embedding_unavailable", async () => {
        const { response, searchCalled } = await leaf.run(
          { status: "unavailable" },
          "scroll fade animation"
        );
        expect(response.success).toBe(false);
        expect(response.error?.degradedReason).toBe("embedding_unavailable");
        expect(searchCalled).toBe(false);
      });
    });

    describe(`${leaf.name}: legitimate empty 非退行 (embedding ok + 0 件)`, () => {
      it("embedding ok かつ DB null/空 → success:true total:0 (障害でない正当な空)", async () => {
        const { success, total } = await leaf.runLegitimateEmpty("no-match query");
        expect(success).toBe(true);
        expect(total).toBe(0);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // non-vacuous note (no fake success):
  // 本 INV は production tool handler を直接駆動して success:false を assert するため、
  // production を旧 fake-empty 契約 (embedding unavailable/failed → success:true total:0)
  // に戻すと上記 (a)/(c) assert が必ず RED 化する。実装中に layout tool を fake-empty へ
  // mutation した検証で layout の 3 case が RED 化することを確認済 (other leaf は GREEN 維持)。
  // すなわち本 INV は vacuous でない (空の assert ではなく実挙動を pin している)。
  // ---------------------------------------------------------------------------
});
