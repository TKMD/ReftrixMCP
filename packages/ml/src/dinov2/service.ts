// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DINOv2 Embedding Service
 *
 * Generates visual embeddings using DINOv2 ViT-B/14 via ONNX Runtime.
 * Inference is offloaded to a Worker Thread by default to keep the main
 * event loop responsive for BullMQ heartbeats and IPC messages.
 *
 * Usage:
 *   const service = new DINOv2Service({ modelPath: '/path/to/model.onnx' });
 *   await service.initialize();
 *   const embedding = await service.generateEmbedding(imageBuffer);
 *   await service.dispose();
 *
 * Set env DINOV2_WORKER_THREAD=false to run inference in-process (for testing).
 *
 * @module dinov2/service
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DINOv2WorkerMessage, DINOv2WorkerResponse } from "./worker-thread-types.js";
import { safeImportOnnx } from "../onnx-availability.js";

// =====================================================
// Constants
// =====================================================

/** DINOv2 ViT-B/14 output dimension */
export const DINOV2_EMBEDDING_DIMENSION = 768;

/** Expected input image size (width and height) */
export const DINOV2_INPUT_SIZE = 224;

/** Maximum number of automatic worker thread restarts after crash. */
const MAX_WORKER_RESTARTS = 5;

/** Timeout for worker thread responses (ms). Covers model loading + inference. */
const WORKER_RESPONSE_TIMEOUT_MS = 30_000;

// =====================================================
// Configuration
// =====================================================

/**
 * Configuration for DINOv2Service
 */
export interface DINOv2ServiceConfig {
  /**
   * Path to the ONNX model file.
   * Can also be set via env var DINOV2_MODEL_PATH.
   */
  modelPath: string;
}

// =====================================================
// Pending request tracking
// =====================================================

interface PendingRequest {
  resolve: (response: DINOv2WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// =====================================================
// Helper: request ID generation
// =====================================================

let requestIdCounter = 0;
function generateRequestId(): string {
  return `dinov2_${Date.now()}_${++requestIdCounter}`;
}

/**
 * Resolve the path to the DINOv2 worker thread script.
 */
function resolveWorkerScriptPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "worker-thread.js");
}

/**
 * Whether to use worker thread for ONNX inference.
 * Disabled by env var DINOV2_WORKER_THREAD=false or in test environments.
 */
function isWorkerThreadEnabled(): boolean {
  const envVal = process.env.DINOV2_WORKER_THREAD;
  if (envVal === "false" || envVal === "0") return false;
  // Disable in Vitest to avoid worker thread complications in test harness
  if (process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined) return false;
  return true;
}

// =====================================================
// DINOv2Service
// =====================================================

/**
 * DINOv2Service - Generates visual embeddings using DINOv2 ViT-B/14
 *
 * ONNX inference is offloaded to a Worker Thread by default.
 * The main thread manages the Worker lifecycle; the worker owns
 * the ONNX InferenceSession lifecycle (init, inference, dispose).
 */
export class DINOv2Service {
  private modelPath: string;
  private useWorkerThread: boolean;

  // --- Worker Thread state ---
  private worker: Worker | null = null;
  private workerInitPromise: Promise<void> | null = null;
  private workerReady = false;
  private workerRestartCount = 0;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private lastCrashTime = 0;

  // --- In-process fallback state ---
  private inProcessSession: unknown | null = null;

  private _isInitialized = false;

  constructor(config: DINOv2ServiceConfig) {
    this.modelPath = config.modelPath;
    this.useWorkerThread = isWorkerThreadEnabled();
  }

  // =====================================================
  // Worker Thread management
  // =====================================================

  /**
   * Initialize the service. Spawns the worker thread and loads the model.
   * Must be called before generateEmbedding().
   */
  async initialize(): Promise<void> {
    if (this._isInitialized) return;

    if (this.useWorkerThread) {
      await this.ensureWorkerReady();
    } else {
      await this.initializeInProcess();
    }

    this._isInitialized = true;
  }

  /**
   * Ensure the worker thread is spawned and initialized.
   */
  private async ensureWorkerReady(): Promise<void> {
    if (this.workerReady && this.worker) return;
    if (this.workerInitPromise) return this.workerInitPromise;

    // Cooldown after crashes to prevent rapid spawn-crash cycles
    if (this.lastCrashTime > 0) {
      const CRASH_COOLDOWN_MS = 3_000;
      const elapsed = Date.now() - this.lastCrashTime;
      if (elapsed < CRASH_COOLDOWN_MS) {
        const waitMs = CRASH_COOLDOWN_MS - elapsed;
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
    }

    this.workerInitPromise = this.spawnAndInitWorker();
    return this.workerInitPromise;
  }

  private async spawnAndInitWorker(): Promise<void> {
    try {
      const scriptPath = resolveWorkerScriptPath();

      // Worker threads inherit the parent's execArgv by default.
      // Pass empty array to prevent parent flags from propagating.
      this.worker = new Worker(scriptPath, { execArgv: [] });

      this.worker.on("message", (response: DINOv2WorkerResponse) => {
        this.handleWorkerResponse(response);
      });

      this.worker.on("error", (error: Error) => {
        console.warn("[DINOv2] Worker Thread error:", error.message);
        this.handleWorkerCrash(error);
      });

      this.worker.on("exit", (code: number) => {
        if (code !== 0) {
          console.warn("[DINOv2] Worker Thread exited with code:", code);
          this.handleWorkerCrash(new Error(`Worker thread exited with code ${code}`));
        }
        this.workerReady = false;
        this.worker = null;
      });

      const response = await this.sendWorkerMessage({
        type: "init",
        requestId: generateRequestId(),
        modelPath: this.modelPath,
      });

      if (response.type === "error") {
        throw new Error(`Worker init failed: ${response.error}`);
      }

      this.workerReady = true;

      if (response.type === "init") {
        // eslint-disable-next-line no-console
        console.log("[DINOv2] Worker Thread initialized in %dms", response.loadTimeMs);
      }
    } catch (error) {
      this.workerInitPromise = null;
      this.workerReady = false;
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Failed to initialize DINOv2 Worker Thread: ${message}`);
    }
  }

  /**
   * Send a message to the worker and return a Promise for the response.
   */
  private sendWorkerMessage(message: DINOv2WorkerMessage): Promise<DINOv2WorkerResponse> {
    if (!this.worker) {
      return Promise.reject(new Error("Worker thread not available"));
    }

    return new Promise<DINOv2WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(message.requestId);
        reject(
          new Error(
            `Worker thread response timeout (${WORKER_RESPONSE_TIMEOUT_MS}ms) for ${message.type}`
          )
        );
      }, WORKER_RESPONSE_TIMEOUT_MS);

      this.pendingRequests.set(message.requestId, { resolve, reject, timer });
      this.worker!.postMessage(message);
    });
  }

  /**
   * Route a response from the worker to the pending request's promise.
   */
  private handleWorkerResponse(response: DINOv2WorkerResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.requestId);
    pending.resolve(response);
  }

  /**
   * Handle worker thread crash: reject all pending requests, track restart count.
   */
  private handleWorkerCrash(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Worker thread crashed: ${error.message}`));
      this.pendingRequests.delete(id);
    }

    this.workerReady = false;
    this.worker = null;
    this.workerInitPromise = null;
    this._isInitialized = false;
    this.workerRestartCount++;
    this.lastCrashTime = Date.now();
  }

  private canRestartWorker(): boolean {
    return this.workerRestartCount < MAX_WORKER_RESTARTS;
  }

  // =====================================================
  // In-process fallback (for testing / debugging)
  // =====================================================

  private async initializeInProcess(): Promise<void> {
    const ortModule = await safeImportOnnx();
    this.inProcessSession = await ortModule.InferenceSession.create(this.modelPath, {
      executionProviders: ["cpu"],
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
    // eslint-disable-next-line no-console
    console.log("[DINOv2] Session initialized in-process:", this.modelPath);
  }

  private async generateInProcess(imageBuffer: Buffer): Promise<number[]> {
    const ortModule = await safeImportOnnx();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sess = this.inProcessSession as any;
    if (!sess) throw new Error("DINOv2 in-process session not initialized");

    const width = DINOV2_INPUT_SIZE;
    const height = DINOV2_INPUT_SIZE;
    const expectedSize = width * height * 3;
    if (imageBuffer.length !== expectedSize) {
      throw new Error(`Invalid buffer size: expected ${expectedSize}, got ${imageBuffer.length}`);
    }

    // Preprocess: HWC uint8 -> CHW float32 with ImageNet normalization
    const MEAN = [0.485, 0.456, 0.406] as const;
    const STD = [0.229, 0.224, 0.225] as const;
    const float32 = new Float32Array(3 * width * height);
    for (let c = 0; c < 3; c++) {
      for (let h = 0; h < height; h++) {
        for (let w = 0; w < width; w++) {
          const srcIdx = (h * width + w) * 3 + c;
          const dstIdx = c * height * width + h * width + w;
          float32[dstIdx] = (imageBuffer[srcIdx]! / 255.0 - MEAN[c]!) / STD[c]!;
        }
      }
    }

    const inputTensor = new ortModule.Tensor("float32", float32, [1, 3, height, width]);
    const output = await sess.run({ pixel_values: inputTensor });

    const lastHiddenState = output.last_hidden_state;
    if (!lastHiddenState) {
      throw new Error("Model output missing last_hidden_state");
    }

    const data = lastHiddenState.data as Float32Array;

    // Extract CLS token (first token)
    const clsToken = new Float32Array(DINOV2_EMBEDDING_DIMENSION);
    for (let i = 0; i < DINOV2_EMBEDDING_DIMENSION; i++) {
      clsToken[i] = data[i]!;
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < clsToken.length; i++) {
      const v = clsToken[i]!;
      if (!Number.isFinite(v)) {
        throw new Error(`NaN/Infinity detected at index ${i}`);
      }
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    if (norm === 0) {
      throw new Error("Zero vector: L2 norm is 0");
    }
    const normalized = new Float32Array(DINOV2_EMBEDDING_DIMENSION);
    for (let i = 0; i < DINOV2_EMBEDDING_DIMENSION; i++) {
      normalized[i] = clsToken[i]! / norm;
    }

    return Array.from(normalized);
  }

  // =====================================================
  // Public API
  // =====================================================

  /**
   * Generate a visual embedding for a single image.
   *
   * The imageBuffer must contain raw 224x224x3 RGB pixel data (150,528 bytes).
   * The caller is responsible for resizing/cropping to 224x224 via Sharp.
   *
   * @param imageBuffer - Raw 224x224x3 RGB pixel buffer
   * @returns 768-dimensional L2-normalized embedding vector
   */
  async generateEmbedding(imageBuffer: Buffer): Promise<number[]> {
    if (!this._isInitialized) {
      await this.initialize();
    }

    const expectedSize = DINOV2_INPUT_SIZE * DINOV2_INPUT_SIZE * 3;
    if (imageBuffer.length !== expectedSize) {
      throw new Error(
        `Invalid image buffer size: expected ${expectedSize} (224x224x3 RGB), got ${imageBuffer.length}`
      );
    }

    if (this.useWorkerThread) {
      return this.generateViaWorker(imageBuffer);
    }
    return this.generateInProcess(imageBuffer);
  }

  /**
   * Generate embeddings for multiple images sequentially.
   *
   * DINOv2 processes one image at a time (no native batching for ViT),
   * so this runs inference sequentially through the single Worker Thread.
   *
   * @param imageBuffers - Array of raw 224x224x3 RGB pixel buffers
   * @returns Array of 768-dimensional L2-normalized embedding vectors
   */
  async generateBatchEmbeddings(imageBuffers: Buffer[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const buffer of imageBuffers) {
      const embedding = await this.generateEmbedding(buffer);
      results.push(embedding);
    }
    return results;
  }

  /**
   * Generate embedding via Worker Thread with crash recovery.
   */
  private async generateViaWorker(imageBuffer: Buffer): Promise<number[]> {
    if (!this.workerReady || !this.worker) {
      if (!this.canRestartWorker() && this.workerRestartCount > 0) {
        throw new Error(`Worker thread exceeded max restarts (${MAX_WORKER_RESTARTS})`);
      }
      await this.ensureWorkerReady();
    }

    // Copy to a fresh ArrayBuffer for structured clone transfer
    const arrayBuffer = new ArrayBuffer(imageBuffer.byteLength);
    new Uint8Array(arrayBuffer).set(
      new Uint8Array(imageBuffer.buffer, imageBuffer.byteOffset, imageBuffer.byteLength)
    );

    const response = await this.sendWorkerMessage({
      type: "infer",
      requestId: generateRequestId(),
      imageBuffer: arrayBuffer,
      width: DINOV2_INPUT_SIZE,
      height: DINOV2_INPUT_SIZE,
    });

    if (response.type === "error") {
      throw new Error(`DINOv2 inference failed: ${response.error}`);
    }

    if (response.type !== "infer") {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }

    return response.embedding;
  }

  /**
   * Dispose the ONNX session to free native memory.
   * After disposal, the next generateEmbedding() call will re-initialize.
   */
  async dispose(): Promise<void> {
    if (this.useWorkerThread) {
      if (this.worker && this.workerReady) {
        try {
          await this.sendWorkerMessage({
            type: "dispose",
            requestId: generateRequestId(),
          });
        } catch {
          // Disposal failure should not break the workflow
        }
      }
    } else {
      if (this.inProcessSession) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (this.inProcessSession as any).release();
        } catch {
          // Disposal failure should not break the workflow
        }
        this.inProcessSession = null;
      }
    }

    this._isInitialized = false;
  }

  /**
   * Recycle the ONNX session to free accumulated native memory.
   *
   * Performs dispose() followed by initialize() to reset the ONNX Runtime
   * internal memory allocations. The modelPath is reused from the original
   * configuration (DINO-3: no re-read of process.env["DINOV2_MODEL_PATH"]).
   *
   * If re-initialization fails, the service is left in a disposed state.
   * Callers should handle this gracefully (Graceful Degradation).
   *
   * @throws {Error} If re-initialization fails after disposal
   */
  async recycle(): Promise<void> {
    await this.dispose();
    await this.initialize();
  }

  /**
   * Terminate the worker thread completely and clean up.
   * After this, the service cannot be used until a new instance is created.
   */
  async terminate(): Promise<void> {
    if (this.worker) {
      try {
        await this.sendWorkerMessage({
          type: "dispose",
          requestId: generateRequestId(),
        });
      } catch {
        // May fail if worker already exited
      }

      try {
        await this.worker.terminate();
      } catch {
        // Already terminated
      }

      this.worker = null;
      this.workerReady = false;
      this.workerInitPromise = null;
    }

    // Also dispose in-process session if present
    if (this.inProcessSession) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (this.inProcessSession as any).release();
      } catch {
        // Disposal failure should not break the workflow
      }
      this.inProcessSession = null;
    }

    this._isInitialized = false;

    // Reject any remaining pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Service terminated"));
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Whether the service is initialized and ready for inference.
   */
  get initialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Whether this service is using a Worker Thread for inference.
   */
  isUsingWorkerThread(): boolean {
    return this.useWorkerThread;
  }

  /**
   * Get the number of worker thread restarts that have occurred.
   */
  getWorkerRestartCount(): number {
    return this.workerRestartCount;
  }
}
