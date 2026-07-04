// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-AGGREGATOR-DEGRADED-001
 * (mandatory standing, large-page domain)
 *
 * ADR-0043 Decision 2 / §Verification (aggregator hybrid + 退行防止 + motion degraded
 * 分類) / plan v4 §4.4 (全滅述語擬似コード, UB-V1-2) / §5.2 (aggregator hybrid +
 * 退行防止 5-service + motion-only success:false + CWE-209). PR-2b — search.unified
 * aggregator が embedding 障害で fail-loud な leaf を **silent drop せず** per-service
 * degraded marker として surface することを pin する。
 *
 * 本 INV は **production aggregator handler** (`searchUnifiedHandler`) を、各 leaf tool
 * handler を MOCK で差し替えて駆動し:
 *   (a) degraded marker surface  — leaf success:false / reject を silent drop せず
 *       `data.degradedServices` に per-service marker (`{service, reason}`) を出す
 *   (b) partial result の正当性  — 1 service が degraded でも他が ok なら success:true +
 *       成功分の結果 + degraded markers
 *   (c) 全 service degraded       — 全 embedding 必須 service が embedding_failed →
 *       overall success:false (空 success:true で誤魔化さない)
 *   (d) 退行防止 (UB-V1-2)        — 4 service が正当な空 (empty) + 1 が embedding_failed →
 *       overall success:true + degradedServices (全滅誤判定しない)
 *   (e) motion-only success:false (TPA-RE2-M-01) — motion のみ呼ばれ embedding 障害 →
 *       overall success:false (motion を empty でなく degraded 分類)
 *   (f) TPA-IMPL-02 forward-coupling — motion error が degradedReason を carry しなくても
 *       error.code から service 層 status 相当の granularity を推論
 *   (g) legitimate empty 非退行  — embedding 成功 + 0 件は degraded でない
 *   (h) CWE-209 / GDPR Art.5(1)(c) — degradedServices / error.message に query 本文・
 *       `.so` / `libonnxruntime` を含まない
 * を CI-failing で assert する。
 *
 * **non-vacuous (no fake success)**: bug injection — 旧 silent-drop 契約
 * (leaf success:false / reject → `return []` で握り潰し → overall 常に success:true) を
 * MOCK で再現する describe を別途置き、修正後の degraded-marker 契約との差分を明示する。
 * production aggregator を旧構造に戻すと (a)/(c)/(e) assert が必ず RED 化する。
 *
 * CI-failing executable invariant. `.skip()` / `.todo()` forbidden; failure is a
 * P0 incident handled by search-engineer.
 *
 * Mock boundary note: MOCK leaf tool handlers drive the degraded/empty/ok paths
 * deterministically; the aggregator (`searchUnifiedHandler`) control-flow exercised
 * here is the PRODUCTION code. No real CUDA / ONNX / DB.
 *
 * @module tests/regression/standing/large-page/inv-aggregator-degraded-001
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// MOCK leaf tool handlers (production aggregator を driving する MOCK leaf)
// ---------------------------------------------------------------------------

vi.mock("../../../../src/tools/layout/search.tool", () => ({
  layoutSearchHandler: vi.fn(),
}));
vi.mock("../../../../src/tools/part/search.tool", () => ({
  partSearchHandler: vi.fn(),
}));
vi.mock("../../../../src/tools/motion/search.tool", () => ({
  motionSearchHandler: vi.fn(),
}));
vi.mock("../../../../src/tools/background/search.tool", () => ({
  backgroundSearchHandler: vi.fn(),
}));
vi.mock("../../../../src/tools/narrative/search.tool", () => ({
  narrativeSearchHandler: vi.fn(),
}));

// query understanding / reranking / cache を deterministic に (no expansion / no rerank)
vi.mock("../../../../src/services/search/query-understanding.service", () => ({
  understandQuery: vi.fn((query: string) => ({
    originalQuery: query,
    expandedQuery: query,
    queryType: "visual" as const,
    extractedFilters: {},
  })),
}));
vi.mock("../../../../src/services/search/cross-encoder-rerank.service", () => ({
  applyCrossEncoderReranking: vi.fn((results: Array<{ id: string; similarity: number }>) =>
    Promise.resolve({ items: results, reranked: false, method: "none" })
  ),
}));

import { searchUnifiedHandler } from "../../../../src/tools/search-unified.tool";
import { invalidateCache } from "../../../../src/services/search-cache.service";
import { layoutSearchHandler } from "../../../../src/tools/layout/search.tool";
import { partSearchHandler } from "../../../../src/tools/part/search.tool";
import { motionSearchHandler } from "../../../../src/tools/motion/search.tool";
import { backgroundSearchHandler } from "../../../../src/tools/background/search.tool";
import { narrativeSearchHandler } from "../../../../src/tools/narrative/search.tool";

const SECRET_QUERY = "secret-user-query-xyz";
const DLOPEN_REASON = "libonnxruntime_providers_cuda.so: cannot open shared object file";
const VALID_DEGRADED_REASONS = new Set(["embedding_unavailable", "embedding_failed"]);

// ---------------------------------------------------------------------------
// mock builders (leaf tool 応答を deterministic に仕込む)
// ---------------------------------------------------------------------------

/** leaf を ok (results あり) にする */
function mockOk(
  handler: ReturnType<typeof vi.fn>,
  results: Array<{ id: string; similarity: number }>
): void {
  // layout/part/background/narrative は flat results、motion は nested。
  // ここでは flat shape で十分 (aggregator は id/similarity のみを必須に算入)。
  vi.mocked(handler).mockResolvedValue({
    success: true,
    data: { results, total: results.length, query: "test", searchTimeMs: 1 },
  } as never);
}

/** leaf を legitimate empty (success:true total:0) にする */
function mockEmpty(handler: ReturnType<typeof vi.fn>): void {
  vi.mocked(handler).mockResolvedValue({
    success: true,
    data: { results: [], total: 0, query: "test", searchTimeMs: 1 },
  } as never);
}

/** leaf を success:false (embedding 障害、degradedReason carry あり/なし) にする */
function mockFailLoud(
  handler: ReturnType<typeof vi.fn>,
  error: { code: string; message: string; degradedReason?: string }
): void {
  vi.mocked(handler).mockResolvedValue({ success: false, error } as never);
}

/** leaf を reject (throw) にする */
function mockReject(handler: ReturnType<typeof vi.fn>, message: string): void {
  vi.mocked(handler).mockRejectedValue(new Error(message));
}

type AggResult = {
  success: boolean;
  data?: { degradedServices?: Array<{ service: string; reason: string }>; total: number };
  error?: { code: string; message: string };
};

describe("INV-AGGREGATOR-DEGRADED-001 (large-page standing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache();
  });
  afterEach(() => {
    invalidateCache();
  });

  // -------------------------------------------------------------------------
  // (a)/(b) partial result + degraded marker surface (silent drop でない)
  // -------------------------------------------------------------------------
  describe("(a)/(b) partial result: 1 leaf degraded → success:true + degradedServices surface", () => {
    it("layout success:false (degradedReason carry) → degraded marker、part ok 維持", async () => {
      mockFailLoud(layoutSearchHandler as never, {
        code: "EMBEDDING_FAILED",
        message: "Query embedding generation failed",
        degradedReason: "embedding_failed",
      });
      mockOk(partSearchHandler as never, [{ id: "p-1", similarity: 0.9 }]);
      mockEmpty(motionSearchHandler as never);
      mockEmpty(backgroundSearchHandler as never);
      mockEmpty(narrativeSearchHandler as never);

      const res = (await searchUnifiedHandler({ query: "x" })) as AggResult;

      expect(res.success).toBe(true);
      // silent drop されず degraded marker で surface
      expect(res.data?.degradedServices).toEqual([
        { service: "layout", reason: "embedding_failed" },
      ]);
      // 成功分の結果は維持 (part 1 件)
      expect(res.data?.total).toBe(1);
    });

    it("layout reject (throw) → degraded marker (embedding_failed)、他 ok 維持", async () => {
      mockReject(layoutSearchHandler as never, "Layout DB timeout");
      mockOk(partSearchHandler as never, [{ id: "p-1", similarity: 0.8 }]);
      mockEmpty(motionSearchHandler as never);
      mockEmpty(backgroundSearchHandler as never);
      mockEmpty(narrativeSearchHandler as never);

      const res = (await searchUnifiedHandler({ query: "x" })) as AggResult;

      expect(res.success).toBe(true);
      expect(res.data?.degradedServices).toEqual([
        { service: "layout", reason: "embedding_failed" },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // (c) 全 service degraded → overall success:false
  // -------------------------------------------------------------------------
  describe("(c) 全 embedding 必須 service が embedding_failed → overall success:false", () => {
    it("5 service すべて degraded (failed) → success:false (空 success:true で誤魔化さない)", async () => {
      mockFailLoud(layoutSearchHandler as never, {
        code: "EMBEDDING_FAILED",
        message: "fail",
        degradedReason: "embedding_failed",
      });
      mockFailLoud(partSearchHandler as never, {
        code: "EMBEDDING_FAILED",
        message: "fail",
        degradedReason: "embedding_failed",
      });
      mockFailLoud(motionSearchHandler as never, { code: "EMBEDDING_ERROR", message: "fail" });
      mockFailLoud(backgroundSearchHandler as never, {
        code: "EMBEDDING_FAILED",
        message: "fail",
        degradedReason: "embedding_failed",
      });
      mockFailLoud(narrativeSearchHandler as never, { code: "EMBEDDING_FAILED", message: "fail" });

      const res = (await searchUnifiedHandler({ query: "x" })) as AggResult;

      expect(res.success).toBe(false);
    });

    it("5 service すべて reject → success:false", async () => {
      mockReject(layoutSearchHandler as never, "l");
      mockReject(partSearchHandler as never, "p");
      mockReject(motionSearchHandler as never, "m");
      mockReject(backgroundSearchHandler as never, "b");
      mockReject(narrativeSearchHandler as never, "n");

      const res = (await searchUnifiedHandler({ query: "x" })) as AggResult;
      expect(res.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // (d) 退行防止 (UB-V1-2): 4 empty + 1 failed → success:true (全滅誤判定しない)
  // -------------------------------------------------------------------------
  describe("(d) 退行防止 (UB-V1-2): 4 legitimate empty + 1 embedding_failed → success:true + degradedServices", () => {
    it("4 service が正当な空 + motion が embedding_failed → overall success:true (anyEmpty ガード)", async () => {
      mockEmpty(layoutSearchHandler as never);
      mockEmpty(partSearchHandler as never);
      mockFailLoud(motionSearchHandler as never, { code: "EMBEDDING_ERROR", message: "fail" });
      mockEmpty(backgroundSearchHandler as never);
      mockEmpty(narrativeSearchHandler as never);

      const res = (await searchUnifiedHandler({ query: "x" })) as AggResult;

      // 正当な空が 1 つでもあれば全滅でない → success:true
      expect(res.success).toBe(true);
      // degraded した motion は surface
      expect(res.data?.degradedServices).toEqual([
        { service: "motion", reason: "embedding_failed" },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // (e)/(f) motion-only success:false (TPA-RE2-M-01) + TPA-IMPL-02 forward-coupling
  // -------------------------------------------------------------------------
  describe("(e)/(f) motion-only embedding 全障害 → overall success:false (motion を degraded 分類)", () => {
    it("types=[motion] のみ + embedding_failed → success:false (empty でなく degraded)", async () => {
      mockFailLoud(motionSearchHandler as never, { code: "EMBEDDING_ERROR", message: "fail" });

      const res = (await searchUnifiedHandler({ query: "x", types: ["motion"] })) as AggResult;

      // motion のみ呼ばれ degraded (failed) → required=[motion], anyEmpty=false → overallFail
      expect(res.success).toBe(false);
    });

    it("TPA-IMPL-02: motion error が degradedReason を carry しなくても code から推論 (SERVICE_UNAVAILABLE → embedding_unavailable)", async () => {
      mockFailLoud(motionSearchHandler as never, {
        code: "SERVICE_UNAVAILABLE",
        message: "Motion search service is not available",
      });
      // 他 service が ok だと success 維持 + degraded marker の reason 推論を確認できる
      mockOk(layoutSearchHandler as never, [{ id: "l-1", similarity: 0.7 }]);
      mockEmpty(partSearchHandler as never);
      mockEmpty(backgroundSearchHandler as never);
      mockEmpty(narrativeSearchHandler as never);

      const res = (await searchUnifiedHandler({ query: "x" })) as AggResult;

      expect(res.success).toBe(true);
      expect(res.data?.degradedServices).toEqual([
        { service: "motion", reason: "embedding_unavailable" },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // (g) legitimate empty 非退行
  // -------------------------------------------------------------------------
  describe("(g) legitimate empty 非退行: embedding 成功 + 0 件は degraded でない", () => {
    it("全 service legitimate empty → success:true + degradedServices 省略 (undefined)", async () => {
      mockEmpty(layoutSearchHandler as never);
      mockEmpty(partSearchHandler as never);
      mockEmpty(motionSearchHandler as never);
      mockEmpty(backgroundSearchHandler as never);
      mockEmpty(narrativeSearchHandler as never);

      const res = (await searchUnifiedHandler({ query: "x" })) as AggResult;

      expect(res.success).toBe(true);
      expect(res.data?.degradedServices).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // (h) CWE-209 / GDPR Art.5(1)(c): degradedServices / error に query / .so 非含有
  // -------------------------------------------------------------------------
  describe("(h) CWE-209 / GDPR Art.5(1)(c): degradedServices / error.message に query・.so 非含有", () => {
    it("degradedServices は reason enum のみ (query 本文・.so / libonnxruntime を bind しない)", async () => {
      mockFailLoud(motionSearchHandler as never, {
        code: "EMBEDDING_ERROR",
        message: DLOPEN_REASON,
      });
      mockOk(layoutSearchHandler as never, [{ id: "l-1", similarity: 0.7 }]);
      mockEmpty(partSearchHandler as never);
      mockEmpty(backgroundSearchHandler as never);
      mockEmpty(narrativeSearchHandler as never);

      const res = (await searchUnifiedHandler({ query: SECRET_QUERY })) as AggResult;

      expect(res.success).toBe(true);
      const serialized = JSON.stringify(res.data?.degradedServices ?? []);
      expect(serialized).not.toContain(SECRET_QUERY);
      expect(serialized).not.toContain(".so");
      expect(serialized).not.toContain("libonnxruntime");
      // reason は enum union 値のみ
      for (const d of res.data?.degradedServices ?? []) {
        expect(VALID_DEGRADED_REASONS.has(d.reason)).toBe(true);
      }
    });

    it("全滅 success:false の error.message に query 本文・.so 非含有", async () => {
      mockFailLoud(motionSearchHandler as never, {
        code: "EMBEDDING_ERROR",
        message: DLOPEN_REASON,
      });

      const res = (await searchUnifiedHandler({
        query: SECRET_QUERY,
        types: ["motion"],
      })) as AggResult;

      expect(res.success).toBe(false);
      const msg = res.error?.message ?? "";
      expect(msg).not.toContain(SECRET_QUERY);
      expect(msg).not.toContain(".so");
      expect(msg).not.toContain("libonnxruntime");
    });
  });

  // -------------------------------------------------------------------------
  // non-vacuous (no fake success): 旧 silent-drop 契約の再現と差分
  // -------------------------------------------------------------------------
  describe("non-vacuous (bug injection note): 旧 silent-drop 契約は本 INV を RED 化する", () => {
    it("旧 silent-drop (全 reject → return [] → success:true total:0) を模した期待は現挙動と矛盾する", async () => {
      // 旧契約 (silent drop): 全 leaf が reject しても aggregator が return [] で握り潰し
      // overall success:true total:0 を返していた。現契約はこれを overall success:false に
      // する。よって「全 reject で success:true」を期待する旧 assert は現挙動と矛盾し RED 化する。
      mockReject(layoutSearchHandler as never, "l");
      mockReject(partSearchHandler as never, "p");
      mockReject(motionSearchHandler as never, "m");
      mockReject(backgroundSearchHandler as never, "b");
      mockReject(narrativeSearchHandler as never, "n");

      const res = (await searchUnifiedHandler({ query: "x" })) as AggResult;

      // 旧 silent-drop の期待 (success:true) は **現挙動では成立しない** ことを pin する:
      // production を旧 return-[] silent-drop に戻すと res.success===true に戻り、本 assert
      // (success:false) が RED 化する = 本 INV は vacuous でない。
      expect(res.success).toBe(false);
    });
  });
});
