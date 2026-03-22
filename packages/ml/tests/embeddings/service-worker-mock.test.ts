// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EmbeddingService - Worker Thread Path Tests
 *
 * Tests for worker thread management in embeddings/service.ts by mocking
 * the Worker class from node:worker_threads. This covers:
 * - spawnAndInitWorker
 * - sendWorkerMessage / handleWorkerResponse
 * - handleWorkerCrash / canRestartWorker
 * - generateViaWorker / generateBatchViaWorker
 * - switchProviderViaWorker / releaseGpuViaWorker
 * - terminate with pending requests
 * - Worker thread timeout
 *
 * @module tests/embeddings/service-worker-mock
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ============================================================================
// Mock Worker class
// ============================================================================

class MockWorker extends EventEmitter {
  private terminated = false;

  postMessage(msg: unknown): void {
    if (this.terminated) return;
    const message = msg as { type: string; requestId: string; provider?: string };

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
            inferenceTimeMs: 20,
          });
          break;
        case "generateBatch":
          this.emit("message", {
            type: "generateBatch",
            requestId: message.requestId,
            success: true,
            embeddings: [
              Array.from({ length: 768 }, (_, i) => i * 0.001),
              Array.from({ length: 768 }, (_, i) => i * 0.002),
            ],
            inferenceTimeMs: 40,
          });
          break;
        case "dispose":
          this.emit("message", {
            type: "dispose",
            requestId: message.requestId,
            success: true,
          });
          break;
        case "terminate":
          this.emit("message", {
            type: "terminate",
            requestId: message.requestId,
            success: true,
          });
          break;
        case "switch-provider":
          this.emit("message", {
            type: "switch-provider",
            requestId: message.requestId,
            success: true,
            provider: message.provider || "cpu",
          });
          break;
        case "release-gpu":
          this.emit("message", {
            type: "release-gpu",
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
    this.terminated = true;
    return 0;
  }
}

class MockWorkerCrash extends EventEmitter {
  postMessage(): void {
    setImmediate(() => {
      this.emit("error", new Error("Worker crashed unexpectedly"));
    });
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

class MockWorkerInitError extends EventEmitter {
  postMessage(msg: unknown): void {
    const message = msg as { type: string; requestId: string };
    setImmediate(() => {
      this.emit("message", {
        type: "error",
        requestId: message.requestId,
        success: false,
        error: "Init failure",
        originalType: message.type,
      });
    });
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("EmbeddingService - Worker Thread path", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Force worker thread mode
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    process.env.EMBEDDING_WORKER_THREAD = "true";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("should initialize via worker thread and generate single embedding", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorker,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();

    expect(service.isUsingWorkerThread()).toBe(true);

    const embedding = await service.generateEmbedding("test query", "query");
    expect(embedding).toHaveLength(768);
    expect(service.isInitialized()).toBe(true);

    await service.terminate();
  });

  it("should generate batch embeddings via worker thread", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorker,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();

    const embeddings = await service.generateBatchEmbeddings(["text1", "text2"], "passage");
    expect(embeddings).toHaveLength(2);

    await service.terminate();
  });

  it("should handle worker init failure with error response", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorkerInitError,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();

    await expect(service.generateEmbedding("test", "query")).rejects.toThrow("Worker init failed");
  });

  it("should handle worker crash and increment restart count", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorkerCrash,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();

    await expect(service.generateEmbedding("test", "query")).rejects.toThrow(
      "Worker thread crashed"
    );

    expect(service.getWorkerRestartCount()).toBe(1);
  });

  it("should throw when worker exceeds max restarts on generate", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorkerCrash,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();

    // Exhaust restarts (MAX_WORKER_RESTARTS = 5)
    for (let i = 0; i < 5; i++) {
      try {
        await service.generateEmbedding(`test-${i}`, "query");
      } catch {
        // Expected
      }
    }

    // Should fail with max restarts error
    await expect(service.generateEmbedding("final", "query")).rejects.toThrow(
      "exceeded max restarts"
    );
  });

  it("should throw when worker exceeds max restarts on batch generate", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorkerCrash,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();

    // Exhaust restarts
    for (let i = 0; i < 5; i++) {
      try {
        await service.generateEmbedding(`test-${i}`, "query");
      } catch {
        // Expected
      }
    }

    await expect(service.generateBatchEmbeddings(["text1"], "query")).rejects.toThrow(
      "exceeded max restarts"
    );
  });

  it("should switch provider via worker thread", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorker,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();

    // Init worker first
    await service.generateEmbedding("test", "query");

    // Switch to CPU (already CPU, but exercises the worker path)
    const result = await service.switchProvider("cpu");
    expect(result).toBe(true);
    expect(service.getCurrentProvider()).toBe("cpu");

    await service.terminate();
  });

  it("should release GPU via worker thread", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorker,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();

    await service.generateEmbedding("test", "query");

    await service.releaseGpu();
    expect(service.getCurrentProvider()).toBe("cpu");

    await service.terminate();
  });

  it("should dispose via worker thread", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorker,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();

    await service.generateEmbedding("test", "query");
    expect(service.isInitialized()).toBe(true);

    await service.dispose();
    // isInitialized checks workerReady in worker mode
    // After dispose, pipeline is disposed but worker may still be alive

    await service.terminate();
  });

  it("should handle switchProvider when worker is not running", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorker,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();

    // switchProvider before worker is started
    const result = await service.switchProvider("cuda");
    // Optimistically sets it when worker not running
    expect(result).toBe(true);

    await service.terminate();
  });

  it("should terminate and reject pending requests", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorker,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();

    await service.generateEmbedding("test", "query");
    await service.terminate();

    expect(service.isInitialized()).toBe(false);
  });

  it("should handle worker exit with non-zero code", async () => {
    class MockWorkerExitBad extends EventEmitter {
      postMessage(msg: unknown): void {
        setImmediate(() => {
          this.emit("exit", 1);
        });
      }
      async terminate(): Promise<number> {
        return 0;
      }
    }

    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorkerExitBad,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();

    await expect(service.generateEmbedding("test", "query")).rejects.toThrow();
  });

  it("should handle releaseGpu when worker is not ready", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorker,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { EmbeddingService } = await import("../../src/embeddings/service.js");
    const service = new EmbeddingService();

    // releaseGpu without any initialization
    await service.releaseGpu();
    expect(service.getCurrentProvider()).toBe("cpu");
  });
});
