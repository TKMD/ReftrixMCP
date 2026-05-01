// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ML Worker Thread resourceLimits Tests (PR7e-β1)
 *
 * `loadMLWorkerResourceLimits()` と `getMLWorkerThreadOptions()` が正しく
 * `ML_WORKER_MAX_OLD_SPACE_MB` を解釈すること、および EmbeddingService /
 * DINOv2Service が `new Worker(...)` に resourceLimits を渡すことを検証する。
 *
 * Verifies that `loadMLWorkerResourceLimits()` and `getMLWorkerThreadOptions()`
 * correctly parse `ML_WORKER_MAX_OLD_SPACE_MB`, and that EmbeddingService /
 * DINOv2Service pass `resourceLimits` to `new Worker(...)`.
 *
 * @module tests/embeddings/worker-resource-limits
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  loadMLWorkerResourceLimits,
  getMLWorkerThreadOptions,
} from "../../src/config/worker-resource-limits.js";

// ===========================================================================
// Pure config-loader tests
// ===========================================================================

describe("loadMLWorkerResourceLimits", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["ML_WORKER_MAX_OLD_SPACE_MB"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("未設定時にデフォルト 4096 にフォールバックする / falls back to 4096 when unset", () => {
    const result = loadMLWorkerResourceLimits();
    expect(result.maxOldGenerationSizeMb).toBe(4096);
    expect(result.maxYoungGenerationSizeMb).toBe(512);
    expect(result.codeRangeSizeMb).toBe(256);
  });

  it("空文字列時にデフォルトにフォールバックする / falls back on empty string", () => {
    process.env["ML_WORKER_MAX_OLD_SPACE_MB"] = "";
    const result = loadMLWorkerResourceLimits();
    expect(result.maxOldGenerationSizeMb).toBe(4096);
  });

  it("正常値 2048 を受け入れる / accepts valid 2048", () => {
    process.env["ML_WORKER_MAX_OLD_SPACE_MB"] = "2048";
    const result = loadMLWorkerResourceLimits();
    expect(result.maxOldGenerationSizeMb).toBe(2048);
  });

  it("最小値 512 を受け入れる / accepts min 512", () => {
    process.env["ML_WORKER_MAX_OLD_SPACE_MB"] = "512";
    expect(loadMLWorkerResourceLimits().maxOldGenerationSizeMb).toBe(512);
  });

  it("最大値 8192 を受け入れる / accepts max 8192", () => {
    process.env["ML_WORKER_MAX_OLD_SPACE_MB"] = "8192";
    expect(loadMLWorkerResourceLimits().maxOldGenerationSizeMb).toBe(8192);
  });

  it("NaN を拒絶してデフォルトにフォールバック / rejects NaN and falls back", () => {
    process.env["ML_WORKER_MAX_OLD_SPACE_MB"] = "not-a-number";
    expect(loadMLWorkerResourceLimits().maxOldGenerationSizeMb).toBe(4096);
  });

  it("Infinity を拒絶してデフォルトにフォールバック / rejects Infinity and falls back", () => {
    process.env["ML_WORKER_MAX_OLD_SPACE_MB"] = "Infinity";
    expect(loadMLWorkerResourceLimits().maxOldGenerationSizeMb).toBe(4096);
  });

  it("下限未満 (256) を拒絶 / rejects below min (256)", () => {
    process.env["ML_WORKER_MAX_OLD_SPACE_MB"] = "256";
    expect(loadMLWorkerResourceLimits().maxOldGenerationSizeMb).toBe(4096);
  });

  it("上限超過 (16384) を拒絶 / rejects above max (16384)", () => {
    process.env["ML_WORKER_MAX_OLD_SPACE_MB"] = "16384";
    expect(loadMLWorkerResourceLimits().maxOldGenerationSizeMb).toBe(4096);
  });

  it("負値を拒絶 / rejects negative values", () => {
    process.env["ML_WORKER_MAX_OLD_SPACE_MB"] = "-1024";
    expect(loadMLWorkerResourceLimits().maxOldGenerationSizeMb).toBe(4096);
  });

  it("浮動小数 (int 違反) を拒絶 / rejects non-integer", () => {
    process.env["ML_WORKER_MAX_OLD_SPACE_MB"] = "2048.5";
    expect(loadMLWorkerResourceLimits().maxOldGenerationSizeMb).toBe(4096);
  });
});

// ===========================================================================
// getMLWorkerThreadOptions shape
// ===========================================================================

describe("getMLWorkerThreadOptions", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["ML_WORKER_MAX_OLD_SPACE_MB"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("Worker options shape を返す / returns Worker options shape", () => {
    const options = getMLWorkerThreadOptions();
    expect(options).toHaveProperty("resourceLimits");
    expect(options.resourceLimits).toHaveProperty("maxOldGenerationSizeMb", 4096);
    expect(options.resourceLimits).toHaveProperty("maxYoungGenerationSizeMb", 512);
    expect(options.resourceLimits).toHaveProperty("codeRangeSizeMb", 256);
  });

  it("env var を反映する / reflects env var override", () => {
    process.env["ML_WORKER_MAX_OLD_SPACE_MB"] = "2048";
    const options = getMLWorkerThreadOptions();
    expect(options.resourceLimits.maxOldGenerationSizeMb).toBe(2048);
  });
});

// ===========================================================================
// EmbeddingService Worker spawn integration (mocked)
// ===========================================================================

class MockEmbeddingWorker extends EventEmitter {
  public static lastOptions: unknown = null;
  public static lastScriptPath: string | undefined;

  constructor(scriptPath: string, options: unknown) {
    super();
    MockEmbeddingWorker.lastScriptPath = scriptPath;
    MockEmbeddingWorker.lastOptions = options;
  }

  postMessage(msg: unknown): void {
    const message = msg as { type: string; requestId: string };
    setImmediate(() => {
      switch (message.type) {
        case "init":
          this.emit("message", {
            type: "init",
            requestId: message.requestId,
            success: true,
            loadTimeMs: 100,
            executionProvider: "cpu",
          });
          break;
        case "generate":
          this.emit("message", {
            type: "generate",
            requestId: message.requestId,
            success: true,
            embedding: Array.from({ length: 768 }, (_, i) => i * 0.001),
            inferenceTimeMs: 10,
          });
          break;
        case "terminate":
          this.emit("message", {
            type: "terminate",
            requestId: message.requestId,
            success: true,
          });
          break;
        default:
          break;
      }
    });
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

describe("EmbeddingService — resourceLimits wiring", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    process.env.EMBEDDING_WORKER_THREAD = "true";
    MockEmbeddingWorker.lastOptions = null;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("new Worker(...) に resourceLimits が渡る / passes resourceLimits to new Worker(...)", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockEmbeddingWorker,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();
    // Trigger worker spawn by generating an embedding
    await service.generateEmbedding("test query", "query");

    const opts = MockEmbeddingWorker.lastOptions as {
      execArgv?: string[];
      resourceLimits?: {
        maxOldGenerationSizeMb?: number;
        maxYoungGenerationSizeMb?: number;
        codeRangeSizeMb?: number;
      };
    } | null;

    expect(opts).not.toBeNull();
    expect(opts?.execArgv).toEqual([]);
    expect(opts?.resourceLimits).toBeDefined();
    expect(opts?.resourceLimits?.maxOldGenerationSizeMb).toBe(4096);
    expect(opts?.resourceLimits?.maxYoungGenerationSizeMb).toBe(512);
    expect(opts?.resourceLimits?.codeRangeSizeMb).toBe(256);

    await service.terminate();
  });

  it("env override が new Worker(...) に反映される / env override reflected in Worker options", async () => {
    process.env["ML_WORKER_MAX_OLD_SPACE_MB"] = "2048";

    vi.doMock("node:worker_threads", () => ({
      Worker: MockEmbeddingWorker,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();
    await service.generateEmbedding("test query", "query");

    const opts = MockEmbeddingWorker.lastOptions as {
      resourceLimits?: { maxOldGenerationSizeMb?: number };
    } | null;
    expect(opts?.resourceLimits?.maxOldGenerationSizeMb).toBe(2048);

    await service.terminate();
  });
});
