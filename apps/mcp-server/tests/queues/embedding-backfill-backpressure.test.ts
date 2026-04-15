// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * v0.4.0 PR7b (SEC HIGH-2 / ADR-0008): embedding-backfill-queue back-pressure /
 * exponential backoff / memory-pressure delay テスト
 *
 * v0.4.0 PR7b: Back-pressure cap + memory-pressure delay + exponential backoff.
 *
 * Targets:
 *   - `checkBackfillQueueBackPressure`: waiting > 10000 で allowEnqueue=false
 *   - `resolveMemoryPressureDelayMs`: env var Zod 検証 + デフォルト 60s
 *   - `addEmbeddingBackfillJob`: options.delay の伝搬
 *   - `EMBEDDING_BACKFILL_QUEUE_WAITING_CAP`: 10000 定数
 *   - createEmbeddingBackfillQueue defaults: attempts=3, exponential backoff
 *
 * @module tests/queues/embedding-backfill-backpressure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EMBEDDING_BACKFILL_QUEUE_WAITING_CAP,
  addEmbeddingBackfillJob,
  checkBackfillQueueBackPressure,
  createEmbeddingBackfillQueue,
  resolveMemoryPressureDelayMs,
} from "../../src/queues/embedding-backfill-queue";

describe("PR7b: back-pressure (SEC HIGH-2)", () => {
  it("EMBEDDING_BACKFILL_QUEUE_WAITING_CAP = 10000 (constant)", () => {
    expect(EMBEDDING_BACKFILL_QUEUE_WAITING_CAP).toBe(10_000);
  });

  it("checkBackfillQueueBackPressure allows enqueue when below cap / 上限以下は許可", async () => {
    const queue = {
      getWaitingCount: vi.fn(async () => 9_000),
    } as never;
    const result = await checkBackfillQueueBackPressure(queue);
    expect(result.allowEnqueue).toBe(true);
    expect(result.waitingCount).toBe(9_000);
  });

  it("checkBackfillQueueBackPressure denies enqueue when over cap / 上限超過は拒否", async () => {
    const queue = {
      getWaitingCount: vi.fn(async () => 10_001),
    } as never;
    const result = await checkBackfillQueueBackPressure(queue);
    expect(result.allowEnqueue).toBe(false);
    expect(result.waitingCount).toBe(10_001);
  });

  it("checkBackfillQueueBackPressure fails open on Redis error / Redis 障害時は fail-open", async () => {
    const queue = {
      getWaitingCount: vi.fn(async () => {
        throw new Error("Redis ECONNREFUSED");
      }),
    } as never;
    const result = await checkBackfillQueueBackPressure(queue);
    expect(result.allowEnqueue).toBe(true);
    expect(result.waitingCount).toBe(0);
  });

  it("checkBackfillQueueBackPressure clamps NaN/negative waiting count / NaN/負値を 0 にクランプ", async () => {
    const queue = {
      getWaitingCount: vi.fn(async () => Number.NaN),
    } as never;
    const result = await checkBackfillQueueBackPressure(queue);
    expect(result.allowEnqueue).toBe(true);
    expect(result.waitingCount).toBe(0);
  });
});

describe("PR7b: memory_pressure delay (ADR-0008 #3)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env["EMBEDDING_BACKFILL_MEMORY_PRESSURE_DELAY_MS"];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["EMBEDDING_BACKFILL_MEMORY_PRESSURE_DELAY_MS"] = originalEnv;
    } else {
      delete process.env["EMBEDDING_BACKFILL_MEMORY_PRESSURE_DELAY_MS"];
    }
  });

  // PR7b-convergence (SEC MEDIUM-1): Thundering Herd 対策として ±20% jitter を付与
  // したため、厳密な値ではなく「base × 0.8..1.2」の範囲内であることを検証する。
  //
  // PR7b-convergence (SEC MEDIUM-1): ±20% jitter was added as Thundering Herd
  // defense, so we assert the output lies within `base × 0.8..1.2` instead of a
  // strict equality.
  const assertWithinJitterRange = (actual: number, base: number): void => {
    const lo = Math.floor(base * 0.8);
    const hi = Math.floor(base * 1.2);
    expect(actual).toBeGreaterThanOrEqual(lo);
    expect(actual).toBeLessThanOrEqual(hi);
  };

  it("default 60000ms base when env var unset / 未設定時はデフォルト 60s ± jitter", () => {
    delete process.env["EMBEDDING_BACKFILL_MEMORY_PRESSURE_DELAY_MS"];
    // 複数回サンプリングして jitter 幅を検証（決定的に hi/lo を踏む保証は無いので
    // ここでは幅が 0 でないことのみゆるく確認する）
    const samples = Array.from({ length: 10 }, () => resolveMemoryPressureDelayMs());
    for (const s of samples) {
      assertWithinJitterRange(s, 60_000);
    }
  });

  it("respects valid override as jitter base / 有効な値は base として ± jitter 適用", () => {
    process.env["EMBEDDING_BACKFILL_MEMORY_PRESSURE_DELAY_MS"] = "120000";
    const samples = Array.from({ length: 10 }, () => resolveMemoryPressureDelayMs());
    for (const s of samples) {
      assertWithinJitterRange(s, 120_000);
    }
  });

  it("falls back to default base for NaN / NaN はデフォルト base へフォールバック", () => {
    process.env["EMBEDDING_BACKFILL_MEMORY_PRESSURE_DELAY_MS"] = "not-a-number";
    const samples = Array.from({ length: 10 }, () => resolveMemoryPressureDelayMs());
    for (const s of samples) {
      assertWithinJitterRange(s, 60_000);
    }
  });

  it("falls back to default base for out-of-range (too small) / 範囲外（過小）はデフォルト", () => {
    process.env["EMBEDDING_BACKFILL_MEMORY_PRESSURE_DELAY_MS"] = "100"; // < 1000 min
    const samples = Array.from({ length: 10 }, () => resolveMemoryPressureDelayMs());
    for (const s of samples) {
      assertWithinJitterRange(s, 60_000);
    }
  });

  it("falls back to default base for out-of-range (too large) / 範囲外（過大）はデフォルト", () => {
    process.env["EMBEDDING_BACKFILL_MEMORY_PRESSURE_DELAY_MS"] = "9999999"; // > 600000 max
    const samples = Array.from({ length: 10 }, () => resolveMemoryPressureDelayMs());
    for (const s of samples) {
      assertWithinJitterRange(s, 60_000);
    }
  });

  it("jitter actually varies across samples / jitter が実際にサンプル間で変動する", () => {
    delete process.env["EMBEDDING_BACKFILL_MEMORY_PRESSURE_DELAY_MS"];
    // 30 回サンプリングすれば少なくとも 2 種類以上の値が得られる確率は極めて高い
    // With 30 samples the probability of >=2 distinct values is ~1.
    const samples = new Set(Array.from({ length: 30 }, () => resolveMemoryPressureDelayMs()));
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe("PR7b: addEmbeddingBackfillJob delay propagation (ADR-0008 #3)", () => {
  it("propagates options.delay to BullMQ add() / options.delay を BullMQ add() に伝搬", async () => {
    const addSpy = vi.fn(async () => ({ id: "j1" }));
    const queue = { add: addSpy } as never;
    await addEmbeddingBackfillJob(
      queue,
      {
        webPageId: "019bc111-1111-7777-8888-aaaaaaaaaaaa",
        category: "part_text",
      },
      { priority: 5, delay: 60_000 }
    );
    expect(addSpy).toHaveBeenCalledTimes(1);
    const callArgs = addSpy.mock.calls[0]! as [
      unknown,
      unknown,
      { delay?: number; priority: number },
    ];
    expect(callArgs[2].delay).toBe(60_000);
    expect(callArgs[2].priority).toBe(5);
  });

  it("does not set delay when zero/undefined / 0/undefined では delay を設定しない", async () => {
    const addSpy = vi.fn(async () => ({ id: "j1" }));
    const queue = { add: addSpy } as never;
    await addEmbeddingBackfillJob(
      queue,
      {
        webPageId: "019bc111-1111-7777-8888-aaaaaaaaaaaa",
        category: "part_text",
      },
      { priority: 10 }
    );
    const callArgs = addSpy.mock.calls[0]! as [unknown, unknown, { delay?: number }];
    expect(callArgs[2].delay).toBeUndefined();
  });

  it("backward compatibility: bare number = priority / 旧 number シグネチャは priority のみ", async () => {
    const addSpy = vi.fn(async () => ({ id: "j1" }));
    const queue = { add: addSpy } as never;
    await addEmbeddingBackfillJob(
      queue,
      {
        webPageId: "019bc111-1111-7777-8888-aaaaaaaaaaaa",
        category: "part_text",
      },
      7
    );
    const callArgs = addSpy.mock.calls[0]! as [
      unknown,
      unknown,
      { priority: number; delay?: number },
    ];
    expect(callArgs[2].priority).toBe(7);
    expect(callArgs[2].delay).toBeUndefined();
  });
});

describe("PR7b: createEmbeddingBackfillQueue defaults (exponential backoff)", () => {
  it("queue defaults include attempts=3 and exponential backoff with delay=5000ms", () => {
    // createEmbeddingBackfillQueue は実 Redis 接続を試みるためソース静的検証で代用。
    // tsc 経由でビルドされた関数ソースには defaultJobOptions リテラルが残るため、
    // toString() で BullMQ の attempts / backoff 設定を確認できる。実 Bull Queue
    // のインスタンス化は統合テスト側に委譲する。
    //
    // createEmbeddingBackfillQueue would attempt a real Redis connection — use static
    // source inspection. After tsc, the function source still contains the
    // defaultJobOptions literal, so toString() can verify BullMQ attempts / backoff.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/queues/embedding-backfill-queue.ts"),
      "utf-8"
    );
    expect(src).toContain("attempts: 3");
    expect(src).toMatch(/type:\s*"exponential"/);
    expect(src).toMatch(/delay:\s*5000/);
    // PR7b-convergence (SEC MEDIUM-1): Thundering Herd 対策の jitter を検証
    // PR7b-convergence (SEC MEDIUM-1): verify Thundering Herd jitter is present
    expect(src).toMatch(/jitter:\s*0\.5/);
    // createEmbeddingBackfillQueue 関数自体の存在も確認 / verify export exists
    expect(typeof createEmbeddingBackfillQueue).toBe("function");
  });
});
