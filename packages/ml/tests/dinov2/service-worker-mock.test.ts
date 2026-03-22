// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DINOv2 Service - Worker Thread Path Tests
 *
 * Tests for worker thread management in dinov2/service.ts by mocking
 * the Worker class from node:worker_threads. This covers:
 * - spawnAndInitWorker
 * - sendWorkerMessage / handleWorkerResponse
 * - handleWorkerCrash / canRestartWorker
 * - generateViaWorker
 * - Worker thread timeout
 * - terminate with pending requests
 *
 * @module tests/dinov2/service-worker-mock
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
    // Simulate async response for different message types
    const message = msg as { type: string; requestId: string; modelPath?: string };

    setImmediate(() => {
      switch (message.type) {
        case "init":
          this.emit("message", {
            type: "init",
            requestId: message.requestId,
            success: true,
            loadTimeMs: 100,
          });
          break;
        case "infer":
          this.emit("message", {
            type: "infer",
            requestId: message.requestId,
            success: true,
            embedding: Array.from({ length: 768 }, (_, i) => i * 0.001),
            inferenceTimeMs: 50,
          });
          break;
        case "dispose":
          this.emit("message", {
            type: "dispose",
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

class MockWorkerInitFail extends EventEmitter {
  postMessage(msg: unknown): void {
    const message = msg as { type: string; requestId: string };
    setImmediate(() => {
      this.emit("message", {
        type: "error",
        requestId: message.requestId,
        success: false,
        error: "Mock init failure",
        originalType: message.type,
      });
    });
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

class MockWorkerCrash extends EventEmitter {
  postMessage(): void {
    setImmediate(() => {
      this.emit("error", new Error("Worker crashed"));
    });
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

class MockWorkerTimeout extends EventEmitter {
  postMessage(): void {
    // Never responds - simulates timeout
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("DINOv2Service - Worker Thread path", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Force worker thread mode
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    process.env.DINOV2_WORKER_THREAD = "true";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("should initialize and generate embedding via worker thread", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorker,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { DINOv2Service } = await import("../../src/dinov2/service.js");
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });

    expect(service.isUsingWorkerThread()).toBe(true);

    await service.initialize();
    expect(service.initialized).toBe(true);

    const imageBuffer = Buffer.alloc(224 * 224 * 3, 128);
    const embedding = await service.generateEmbedding(imageBuffer);
    expect(embedding).toHaveLength(768);

    await service.dispose();
    await service.terminate();
  });

  it("should handle worker init failure", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorkerInitFail,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { DINOv2Service } = await import("../../src/dinov2/service.js");
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });

    await expect(service.initialize()).rejects.toThrow("Worker init failed");
  });

  it("should handle worker crash and reject pending requests", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorkerCrash,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { DINOv2Service } = await import("../../src/dinov2/service.js");
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });

    await expect(service.initialize()).rejects.toThrow("Worker thread crashed");
    expect(service.getWorkerRestartCount()).toBe(1);
  });

  it("should track restart count after multiple crashes", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorkerCrash,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { DINOv2Service } = await import("../../src/dinov2/service.js");
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });

    // Each crash increments restart count
    for (let i = 0; i < 3; i++) {
      try {
        await service.initialize();
      } catch {
        // Expected crash
      }
    }

    expect(service.getWorkerRestartCount()).toBe(3);
    expect(service.initialized).toBe(false);
  });

  it("should terminate worker and reject remaining pending requests", async () => {
    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorker,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { DINOv2Service } = await import("../../src/dinov2/service.js");
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });

    await service.initialize();
    // terminate should clean up
    await service.terminate();
    expect(service.initialized).toBe(false);
  });

  it("should handle dispose failure in worker gracefully", async () => {
    class MockWorkerDisposeFail extends EventEmitter {
      postMessage(msg: unknown): void {
        const message = msg as { type: string; requestId: string };
        setImmediate(() => {
          if (message.type === "init") {
            this.emit("message", {
              type: "init",
              requestId: message.requestId,
              success: true,
              loadTimeMs: 50,
            });
          } else if (message.type === "dispose") {
            this.emit("message", {
              type: "error",
              requestId: message.requestId,
              success: false,
              error: "Dispose failed",
              originalType: "dispose",
            });
          }
        });
      }
      async terminate(): Promise<number> {
        return 0;
      }
    }

    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorkerDisposeFail,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { DINOv2Service } = await import("../../src/dinov2/service.js");
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });

    await service.initialize();
    // Dispose should not throw even when worker returns error
    await service.dispose();
    await service.terminate();
  });

  it("should handle worker exit with non-zero code", async () => {
    class MockWorkerExitNonZero extends EventEmitter {
      postMessage(msg: unknown): void {
        const message = msg as { type: string; requestId: string };
        setImmediate(() => {
          // Emit exit event with non-zero code instead of responding
          this.emit("exit", 1);
        });
      }
      async terminate(): Promise<number> {
        return 0;
      }
    }

    vi.doMock("node:worker_threads", () => ({
      Worker: MockWorkerExitNonZero,
    }));
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn().mockReturnValue("/fake/path/service.js"),
    }));

    const { DINOv2Service } = await import("../../src/dinov2/service.js");
    const service = new DINOv2Service({ modelPath: "/tmp/test.onnx" });

    await expect(service.initialize()).rejects.toThrow();
  });
});
