// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RateLimiter テスト
 *
 * Token BucketベースのMCPツールレート制限ミドルウェアの検証
 * - Token Bucket: トークン消費・補充の動作
 * - 3ティア分離: analysis(10RPM), search(120RPM), default(60RPM)
 * - レート超過時のretryAfterMs計算
 * - 環境変数 RATE_LIMIT_ENABLED=false で無効化
 * - NaN/Infinity防御（safeParseInt）
 * - バースト上限
 * - Redis未接続時のインメモリフォールバック
 *
 * @module tests/middleware/rate-limiter
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RateLimiter,
  isRateLimitEnabled,
  checkRateLimit,
  getRateLimiter,
  resetRateLimiter,
  DEFAULT_TIER_CONFIGS,
  TOOL_TIER_MAP,
  type RateLimitTierConfig,
  type RateLimitTier,
} from "../../src/middleware/rate-limiter";

// ============================================================================
// Helpers
// ============================================================================

/** 全ティアが満タンの標準設定で RateLimiter を生成（Redis なし = インメモリのみ） */
function createLimiter(
  overrides?: Partial<Record<RateLimitTier, RateLimitTierConfig>>
): RateLimiter {
  const configs: Record<RateLimitTier, RateLimitTierConfig> = {
    ...DEFAULT_TIER_CONFIGS,
    ...overrides,
  };
  return new RateLimiter(configs);
}

// ============================================================================
// Token Bucket: トークン消費・補充 / Token consumption and refill
// ============================================================================

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
    // 環境変数のクリーンアップ
    delete process.env.RATE_LIMIT_ENABLED;
    delete process.env.RATE_LIMIT_RPM;
    resetRateLimiter();
  });

  describe("Token Bucket: トークン消費・補充 / token consumption and refill", () => {
    it("初期状態ではmaxBurst分のトークンが利用可能", async () => {
      const limiter = createLimiter({
        default: { maxRequestsPerMinute: 60, maxBurst: 5 },
      });
      const result = await limiter.checkRateLimit("some.tool");
      expect(result.allowed).toBe(true);
      // 1トークン消費後なのでremaining = 4
      expect(result.remaining).toBe(4);
      expect(result.limit).toBe(5);
    });

    it("トークンを全て消費するとallowed=falseになる", async () => {
      const limiter = createLimiter({
        default: { maxRequestsPerMinute: 60, maxBurst: 3 },
      });

      // 3トークン消費
      expect((await limiter.checkRateLimit("tool.a")).allowed).toBe(true);
      expect((await limiter.checkRateLimit("tool.a")).allowed).toBe(true);
      expect((await limiter.checkRateLimit("tool.a")).allowed).toBe(true);

      // 4回目は拒否
      const result = await limiter.checkRateLimit("tool.a");
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("時間経過でトークンが補充される", async () => {
      const limiter = createLimiter({
        default: { maxRequestsPerMinute: 60, maxBurst: 2 },
      });

      // 2トークン消費
      await limiter.checkRateLimit("tool.a");
      await limiter.checkRateLimit("tool.a");
      expect((await limiter.checkRateLimit("tool.a")).allowed).toBe(false);

      // 60RPM = 1トークン/秒。1秒経過で1トークン補充
      vi.advanceTimersByTime(1000);
      const result = await limiter.checkRateLimit("tool.a");
      expect(result.allowed).toBe(true);
    });

    it("トークン補充はmaxBurstを超えない", async () => {
      const limiter = createLimiter({
        default: { maxRequestsPerMinute: 60, maxBurst: 3 },
      });

      // 1トークンだけ消費
      await limiter.checkRateLimit("tool.a");

      // 大量の時間経過
      vi.advanceTimersByTime(600_000); // 10分

      const state = limiter.getBucketState("default");
      expect(state).toBeDefined();
      // refillTokensの呼び出しはcheckRateLimitで実行されるため、getBucketStateだけだとrefillされない
      // checkRateLimitを呼んでrefillをトリガー
      const result = await limiter.checkRateLimit("tool.a");
      expect(result.allowed).toBe(true);
      // maxBurst=3からの補充、上限は3
      expect(result.remaining).toBeLessThanOrEqual(3);
    });
  });

  // ============================================================================
  // 3ティア分離 / 3-tier separation
  // ============================================================================

  describe("3ティア分離 / 3-tier separation", () => {
    it("analysis ティアは 10 RPM", () => {
      expect(DEFAULT_TIER_CONFIGS.analysis.maxRequestsPerMinute).toBe(10);
      expect(DEFAULT_TIER_CONFIGS.analysis.maxBurst).toBe(10);
    });

    it("search ティアは 120 RPM", () => {
      expect(DEFAULT_TIER_CONFIGS.search.maxRequestsPerMinute).toBe(120);
      expect(DEFAULT_TIER_CONFIGS.search.maxBurst).toBe(120);
    });

    it("default ティアは 60 RPM", () => {
      expect(DEFAULT_TIER_CONFIGS.default.maxRequestsPerMinute).toBe(60);
      expect(DEFAULT_TIER_CONFIGS.default.maxBurst).toBe(60);
    });

    it("page.analyze は analysis ティアにマッピングされる", () => {
      expect(TOOL_TIER_MAP["page.analyze"]).toBe("analysis");
    });

    it("layout.search は search ティアにマッピングされる", () => {
      expect(TOOL_TIER_MAP["layout.search"]).toBe("search");
    });

    it("未登録ツールは default ティアを使用する", async () => {
      expect(TOOL_TIER_MAP["unknown.tool"]).toBeUndefined();
      // checkRateLimitでdefaultティアが使用されることを検証
      const limiter = createLimiter({
        default: { maxRequestsPerMinute: 60, maxBurst: 60 },
      });
      const result = await limiter.checkRateLimit("unknown.tool");
      expect(result.limit).toBe(60);
    });

    it("ティア間のレート制限は独立している", async () => {
      const limiter = createLimiter({
        analysis: { maxRequestsPerMinute: 10, maxBurst: 2 },
        search: { maxRequestsPerMinute: 120, maxBurst: 2 },
        default: { maxRequestsPerMinute: 60, maxBurst: 2 },
      });

      // analysis ティアを使い切る
      await limiter.checkRateLimit("page.analyze");
      await limiter.checkRateLimit("page.analyze");
      expect((await limiter.checkRateLimit("page.analyze")).allowed).toBe(false);

      // search ティアはまだ利用可能
      expect((await limiter.checkRateLimit("layout.search")).allowed).toBe(true);

      // default ティアもまだ利用可能
      expect((await limiter.checkRateLimit("some.tool")).allowed).toBe(true);
    });
  });

  // ============================================================================
  // retryAfterMs 計算 / retryAfterMs calculation
  // ============================================================================

  describe("retryAfterMs 計算 / retryAfterMs calculation", () => {
    it("レート超過時にretryAfterMsが返される", async () => {
      const limiter = createLimiter({
        default: { maxRequestsPerMinute: 60, maxBurst: 1 },
      });

      await limiter.checkRateLimit("tool.a");
      const result = await limiter.checkRateLimit("tool.a");

      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeDefined();
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it("retryAfterMsはトークン補充レートに基づく", async () => {
      // 60 RPM = 1トークン/秒 = 1000ms/トークン
      const limiter = createLimiter({
        default: { maxRequestsPerMinute: 60, maxBurst: 1 },
      });

      await limiter.checkRateLimit("tool.a");
      const result = await limiter.checkRateLimit("tool.a");

      expect(result.retryAfterMs).toBeDefined();
      // 1トークン補充に1000ms。計算に応じた妥当な値
      expect(result.retryAfterMs!).toBeLessThanOrEqual(1100);
      expect(result.retryAfterMs!).toBeGreaterThanOrEqual(900);
    });

    it("許可されたリクエストではretryAfterMsはundefined", async () => {
      const limiter = createLimiter();
      const result = await limiter.checkRateLimit("tool.a");

      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBeUndefined();
    });
  });

  // ============================================================================
  // 環境変数無効化 / RATE_LIMIT_ENABLED=false
  // ============================================================================

  describe("環境変数無効化 / RATE_LIMIT_ENABLED=false", () => {
    it("RATE_LIMIT_ENABLED=false でレート制限が無効化される", () => {
      process.env.RATE_LIMIT_ENABLED = "false";
      expect(isRateLimitEnabled()).toBe(false);
    });

    it("RATE_LIMIT_ENABLED=0 でレート制限が無効化される", () => {
      process.env.RATE_LIMIT_ENABLED = "0";
      expect(isRateLimitEnabled()).toBe(false);
    });

    it("RATE_LIMIT_ENABLED=no でレート制限が無効化される", () => {
      process.env.RATE_LIMIT_ENABLED = "no";
      expect(isRateLimitEnabled()).toBe(false);
    });

    it("RATE_LIMIT_ENABLED=FALSE (大文字) でも無効化される", () => {
      process.env.RATE_LIMIT_ENABLED = "FALSE";
      expect(isRateLimitEnabled()).toBe(false);
    });

    it("RATE_LIMIT_ENABLED未設定はデフォルトで有効", () => {
      delete process.env.RATE_LIMIT_ENABLED;
      expect(isRateLimitEnabled()).toBe(true);
    });

    it("RATE_LIMIT_ENABLED=true は有効", () => {
      process.env.RATE_LIMIT_ENABLED = "true";
      expect(isRateLimitEnabled()).toBe(true);
    });

    it("RATE_LIMIT_ENABLED='' (空文字) はデフォルトで有効", () => {
      process.env.RATE_LIMIT_ENABLED = "";
      expect(isRateLimitEnabled()).toBe(true);
    });

    it("無効化時はcheckRateLimitが常にallowed=trueを返す", async () => {
      process.env.RATE_LIMIT_ENABLED = "false";
      const limiter = createLimiter({
        default: { maxRequestsPerMinute: 1, maxBurst: 1 },
      });

      // 通常なら1回で制限がかかるが、無効化されているので常に許可
      for (let i = 0; i < 10; i++) {
        const result = await limiter.checkRateLimit("tool.a");
        expect(result.allowed).toBe(true);
      }
    });
  });

  // ============================================================================
  // NaN/Infinity 防御 / NaN/Infinity defense
  // ============================================================================

  describe("NaN/Infinity 防御 / NaN/Infinity defense via RATE_LIMIT_RPM", () => {
    it("RATE_LIMIT_RPM=NaN の場合デフォルト値を使用", () => {
      process.env.RATE_LIMIT_RPM = "NaN";
      const limiter = new RateLimiter();
      const state = limiter.getBucketState("default");
      expect(state).toBeDefined();
      expect(state!.maxBurst).toBe(DEFAULT_TIER_CONFIGS.default.maxBurst);
    });

    it("RATE_LIMIT_RPM=Infinity の場合デフォルト値を使用", () => {
      process.env.RATE_LIMIT_RPM = "Infinity";
      const limiter = new RateLimiter();
      const state = limiter.getBucketState("default");
      expect(state).toBeDefined();
      expect(state!.maxBurst).toBe(DEFAULT_TIER_CONFIGS.default.maxBurst);
    });

    it("RATE_LIMIT_RPM=abc (非数値) の場合デフォルト値を使用", () => {
      process.env.RATE_LIMIT_RPM = "abc";
      const limiter = new RateLimiter();
      const state = limiter.getBucketState("default");
      expect(state).toBeDefined();
      expect(state!.maxBurst).toBe(DEFAULT_TIER_CONFIGS.default.maxBurst);
    });

    it("RATE_LIMIT_RPM=0 の場合、最小値1にクランプ", () => {
      process.env.RATE_LIMIT_RPM = "0";
      const limiter = new RateLimiter();
      const state = limiter.getBucketState("default");
      expect(state).toBeDefined();
      expect(state!.maxBurst).toBe(1);
    });

    it("RATE_LIMIT_RPM=-10 の場合、最小値1にクランプ", () => {
      process.env.RATE_LIMIT_RPM = "-10";
      const limiter = new RateLimiter();
      const state = limiter.getBucketState("default");
      expect(state).toBeDefined();
      expect(state!.maxBurst).toBe(1);
    });

    it("RATE_LIMIT_RPM=20000 の場合、最大値10000にクランプ", () => {
      process.env.RATE_LIMIT_RPM = "20000";
      const limiter = new RateLimiter();
      const state = limiter.getBucketState("default");
      expect(state).toBeDefined();
      expect(state!.maxBurst).toBe(10000);
    });

    it("RATE_LIMIT_RPM=100 で default ティアのみ変更され analysis/search は変更なし", () => {
      process.env.RATE_LIMIT_RPM = "100";
      const limiter = new RateLimiter();

      const defaultState = limiter.getBucketState("default");
      const analysisState = limiter.getBucketState("analysis");
      const searchState = limiter.getBucketState("search");

      expect(defaultState!.maxBurst).toBe(100);
      expect(analysisState!.maxBurst).toBe(DEFAULT_TIER_CONFIGS.analysis.maxBurst);
      expect(searchState!.maxBurst).toBe(DEFAULT_TIER_CONFIGS.search.maxBurst);
    });
  });

  // ============================================================================
  // バースト上限 / Burst limit
  // ============================================================================

  describe("バースト上限 / burst limit", () => {
    it("maxBurst分のリクエストを連続で処理できる", async () => {
      const maxBurst = 5;
      const limiter = createLimiter({
        default: { maxRequestsPerMinute: 60, maxBurst },
      });

      for (let i = 0; i < maxBurst; i++) {
        expect((await limiter.checkRateLimit("tool.a")).allowed).toBe(true);
      }
      expect((await limiter.checkRateLimit("tool.a")).allowed).toBe(false);
    });

    it("remainingが正しくデクリメントされる", async () => {
      const limiter = createLimiter({
        default: { maxRequestsPerMinute: 60, maxBurst: 3 },
      });

      expect((await limiter.checkRateLimit("tool.a")).remaining).toBe(2);
      expect((await limiter.checkRateLimit("tool.a")).remaining).toBe(1);
      expect((await limiter.checkRateLimit("tool.a")).remaining).toBe(0);
    });
  });

  // ============================================================================
  // reset / getBucketState / グローバル関数 / Global functions
  // ============================================================================

  describe("ユーティリティ / utility functions", () => {
    it("reset() でバケットが初期状態に戻る", async () => {
      const limiter = createLimiter({
        default: { maxRequestsPerMinute: 60, maxBurst: 2 },
      });

      await limiter.checkRateLimit("tool.a");
      await limiter.checkRateLimit("tool.a");
      expect((await limiter.checkRateLimit("tool.a")).allowed).toBe(false);

      limiter.reset();
      expect((await limiter.checkRateLimit("tool.a")).allowed).toBe(true);
    });

    it("getBucketState() で現在のバケット状態が取得できる", () => {
      const limiter = createLimiter({
        default: { maxRequestsPerMinute: 60, maxBurst: 10 },
      });

      const state = limiter.getBucketState("default");
      expect(state).toBeDefined();
      expect(state!.tokens).toBe(10);
      expect(state!.maxBurst).toBe(10);
    });

    it("getBucketState() で存在しないティアはundefined", () => {
      const limiter = createLimiter();
      const state = limiter.getBucketState("nonexistent" as RateLimitTier);
      expect(state).toBeUndefined();
    });

    it("getRateLimiter() はシングルトンを返す", () => {
      const a = getRateLimiter();
      const b = getRateLimiter();
      expect(a).toBe(b);
    });

    it("resetRateLimiter() 後に新しいインスタンスが生成される", () => {
      const a = getRateLimiter();
      resetRateLimiter();
      const b = getRateLimiter();
      expect(a).not.toBe(b);
    });

    it("checkRateLimit() ショートカット関数が動作する", async () => {
      const result = await checkRateLimit("layout.search");
      expect(result.allowed).toBe(true);
      expect(result.limit).toBeDefined();
    });
  });
});
